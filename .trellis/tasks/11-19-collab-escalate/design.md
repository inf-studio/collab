# 设计：collab_escalate（复用 delivery=steer）

## 1. 为什么是 steer

OpenCode 的 `POST /api/session/{id}/prompt` 接受 `delivery`（`queue` | `steer`）。桌面端「引导」按钮
就是 `delivery=steer`；我们 `tools/shared.ts` 的 `deliverPrompt` 已经能透传，且 `SessionPromptResult.delivery`
会带回宿主实际采用的方式。**不造新机制。**

## 2. 流程

```
解析目标（复用 resolveTarget / readBroadcast）
  ├─ protected（含血缘） → 写 urgent 队列项（owner-queue）+ 回执 canPush:false
  └─ 非 protected
       mode = resolveMode(input.mode ?? 'steer', agent)   // 只读 agent → queue
       prompt({ sessionID, delivery: mode, text: '[URGENT] …reason…\n(bid …)' })
       delivery = result.delivery ?? mode
  ↓
记录：priority='urgent', urgentAt=now, urgentReason, urgentBy=me（read-merge-write，不碰 state/receipt）
↓
回执：目标 / mode / 实际 delivery / messageID / 下一步（collab_status 查 admitted/seen）
```

## 3. 幂等

- 同 `bid` + 相同 `reason` + `now - urgentAt < 5min` → 只更新 `urgentAt`，跳过投递，回执写明「已加急过」；
- 不同 `reason` 视为新加急（允许在同一单上升级措辞）。

## 4. 数据

```ts
interface BroadcastRecord {
  priority?: 'urgent';
  urgentAt?: number;
  urgentReason?: string;
  urgentBy?: string;
}

interface OwnerQueueItem {
  priority?: 'urgent';   // 新增，展示排序用
}
```

- `collab_list` / `snapshot.handoffs[]` 增 `priority`；TUI/GUI 只读展示 `[urgent]`（不改布局）。

## 5. 硬边界

- protected 的判定复用 `createLineage(ctx).protectedAncestor`（与 grant/promote/archive 同一条）；
- **不**因为「加急」而放宽：不 push、不 steer、不改 permissions、不改 state。

## 6. 测试

| 用例 | 期望 |
| --- | --- |
| 普通目标 + steer | 记录四个字段；`session.prompt` 收到 `delivery:'steer'`；回执 `delivery=steer` |
| 宿主返回 queue | 回执如实 `queue`（模拟空闲目标） |
| 只读 agent 目标 | `delivery:'queue'`，回执 `forced=true` |
| protected 目标 | 0 次 prompt；队列文件出现 `priority:'urgent'`；回执 `canPush:false` + 位置 |
| 幂等 | 5 分钟内二次调用 0 次 prompt |
| 状态不变 | `state` / `claim` / `receipt` 前后一致 |

- 变异：把 `resolveMode` 的只读降级去掉 → 只读断言必失败；把 protected 分支改成直接 prompt → protected 断言必失败。

## 7. 回滚

`git restore -- src/tools/escalate.ts src/tools/index.ts src/types.ts`；已标记的 `priority` 字段对旧版本是未知字段（容忍读取），无需迁移。
