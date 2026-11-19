# 设计：collab_freeze

## 1. 存储与读取

```ts
// ~/.config/opencode/collab-freeze.json
interface FreezeEntry {
  scope: 'session' | 'workspace' | 'bid';
  target: string;          // sid / 目录绝对路径 / bid
  reason: string;          // ≤200
  by: string;              // 发起会话
  at: number;
  until: number;           // epoch ms
  notifiedAt?: number;     // context 只提示一次
}
interface FreezeFile { version: 1; entries: FreezeEntry[] }
```

- `readFreezes(now)` 过滤 `until > now`（过期即忽略，不删文件；写入时顺手清理过期项）；
- `mergeFreezes(mutate)`：读-合并-写（与 `mergeArchive` 同思路），避免并发覆盖；
- 文件不存在 = 没冻结；解析失败按空处理并记一次日志（不让坏文件拖垮工具）。

## 2. 冻结判定（`frozenBy(record | {sessionID, workspace, bid})`）

优先级：`session` > `bid` > `workspace`；命中返回 entry（含 reason/until），否则 `undefined`。
血缘：对 session 判定时同时检查其**祖先**是否被冻结（复用 `createLineage`），避免子会话绕过。

## 3. 强制点

| 工具 | 行为 |
| --- | --- |
| `collab_handoff` | 目标（或目标祖先 / 其工作区）冻结 → 可读拒绝，0 写入 |
| `collab_broadcast` | `workspace` 冻结 → 拒绝；`spawn` 前再判一次 |
| `collab_accept` | 单（bid）冻结或本会话冻结 → 拒绝领取 |
| `collab_escalate` | 冻结优先：拒绝，提示「先 collab_freeze {freeze:false}」 |
| `collab_list` / `collab_status` | 只读展示 `[frozen]`，不拒绝 |

错误文案统一：`目标被冻结（scope=session, 到 HH:MM，原因：…）；用 collab_freeze {scope,target,freeze:false,confirm:true} 解冻`。

## 4. 送达与注入

- 非 protected：投一条 `[frozen] …` 通知（`delivery:'queue'`，**不用 steer**——冻结不是加急打断），保留 `delivery.cid` 供回执；
- protected：写 `OwnerQueueItem { priority:'urgent', summary:'[frozen] …' }`（复用 escalate 的队列写入函数）；
- context 注入：被冻会话每次 context 只提示一次（写 `notifiedAt`），内容含原因/到期/解冻命令。

## 5. 并发与清理

- 写入时：`entries = entries.filter(until > now).filter(不重复 scope+target)` + 新条目；
- 解冻：按 `scope+target` 删除；不存在则 no-op（幂等）。

## 6. 测试

| 用例 | 期望 |
| --- | --- |
| freeze session → handoff | 可读拒绝、0 写入、文件未变（除冻结文件） |
| freeze workspace → broadcast | 拒绝；其它工作区不受影响 |
| freeze bid → accept / escalate | 拒绝 |
| 祖先冻结 → 子会话 handoff | 拒绝（血缘） |
| until 到期 | 假时钟跨过后自动可协作 |
| freeze:false | 解冻后立即可 handoff；再解冻 no-op |
| protected 目标 | 0 prompt + urgent 队列项 |
| 并发写 | 两个 merge 后条目都在 |
| list/snapshot | `[frozen]` + 到期时间 |
| context 注入 | 只提示一次 |

## 7. 回滚

`git restore -- src/tools/freeze.ts src/core/freeze.ts src/tools/index.ts src/types.ts`；已写冻结文件可手工删除（无副作用）。
