# 设计：collab_status（0.5.3 → 0.6.0）

## 1. 数据来源（全部现有结构，零新契约）

| 字段 | 来源 |
| --- | --- |
| `state` / `claim` / `receipt` / `replies` / `delivery` | `BroadcastRecord` |
| `priority` | 0.6.0 新增字段（本任务先按可选读取，缺省即普通） |
| 队列项 | `owner-queue.ts` 的 `unseenCandidates` / 队列文件（`target` 维度） |
| protected | `createLineage(ctx).protectedAncestor` |

## 2. 解析顺序

```
input.bid        → readBroadcast(bid)（不存在 → 可读错误）
input.threadID   → allBroadcasts().find(threadID)
input.session    → 该会话作为 from.sid 或 claim.by 的全部未闭环 + 最近一条已闭环
（无输入）        → 本会话（context.sessionID）相关的未闭环，最多 5 条
```

## 3. 输出（文本）

```
b_14528d828f9df27b  state=claimed  priority=urgent  承接=ses_e1055d85…（handoff，剩 4m12s）
  投递: admitted=03:57:59  seen=03:58:10
  队列: 0 项
  最近回复: 03:58:12 "已接管，先读交接包"
  下一步: 等回执 → collab_wait {threadID:"t_…"}；超时用 collab_escalate
```

- `canPush:false` 时把「下一步」改成 `只能队列（该目标受保护）：collab_request_owner 或等其下一轮`；
- 已闭环：`state=done` + `receipt.note`，下一步 `无需动作`。

## 4. 只读保证

- 只用 `readBroadcast` / `allBroadcasts` / `unseenCandidates` / `session.get`；
- **禁止**：`writeBroadcast`、`persistRefresh`（会写状态）、`session.prompt`、`session.update`、`remove`；
- 测试用严格假 ctx（写方法一旦被调用即抛）+ 文件目录只读快照对比（前后 mtime 一致）。

## 5. 边界

- 不排序候选、不触发 `refreshBroadcast`（避免把 `claimed` 的租约过期改写）；
- 如果记录处于 `claimed` 且已过租约：显示「租约已过期（下次 refresh 会释放）」而不是自行改写。

## 6. 测试

| 用例 | 期望 |
| --- | --- |
| pending（open/claimed/acked） | 字段齐全 + 建议下一步 |
| done/blocked/expired | 显示 receipt + 无需动作 |
| protected 目标 | `canPush:false` + 队列项 + 位置 |
| 无参数 + 无相关单 | 一句「当前没有未闭环交接」 |
| 无参数 + 多条 | ≤5 条，按 updatedAt 倒序 |
| 只读 | 0 次写调用、目录前后一致 |

## 7. 回滚

`git restore -- src/tools/status.ts src/tools/index.ts src/types.ts`；无运行时配置。
