# 设计：协作结束后自动归档 spawn 会话

## 1. 判定

```ts
type ArchiveDecision =
  | { archive: true; sessionID: string }
  | { archive: false; reason: string }

function shouldArchive(record, now): ArchiveDecision
```

顺序（任一不满足即不归档）：

1. 目标会话必须是**我方拉起的**：
   - 常规：`record.claim.kind === 'spawn'` → 目标 `claim.by`；
   - 补充（复核 R-1）：spawn 会话租约过期后才被领取时，`refreshBroadcast` 会把 `claim.kind` 改写成
     `accept`（`claim.ts:222-241`），spawn 痕迹只剩在 `expiredClaim`；此时同样认定为「我方拉起」，
     目标取 `expiredClaim.by`（那个孤儿会话仍是我们拉的，接手的交接已归别人）；
   - `claim.spawner` 永不作为目标（它是发起方，即人自己的会话）；
2. `record.state ∈ {done, blocked, expired}`；
3. `now - record.updatedAt >= archiveGraceMs`（默认 **10min**，范围 1min–1h）；
4. 目标 `session.get` 存在且 **idle**；
5. 目标不是 `[protected]`/`[protected-child]`；
6. 该 sid 不被任何**非终态**记录引用（既非 `from.sid` 也非 `claim.by`）；
7. 该 sid 没有未读 owner-queue 项（`ownerQueue.unseenFor(sid)` 为空）；
8. `record.archivedAt` 为空。

## 2. 执行

```ts
await ctx.session.update?.({ sessionID, archived: true })
// 宿主无 update → COLLAB_SERVER_URL 的 PATCH /api/session/{id} { archived:true }
```

- 成功：`record.archivedAt = now`（读-合并-写，沿用 `mergeDelivery` 思路另加 `mergeArchive`）；
- 失败：只 `log`，不改变记录状态、不影响工具返回；
- 幂等：`archivedAt` 存在即跳过。

## 3. 触发点

- `refresh()`：发起方 `context` 刷新时顺带判定（与租约/回执同一处，无 cron）；
- `collab_list`：只读展示 `[archived]`，**不触发**归档（避免读命令写盘）。

## 4. 手动工具

```text
collab_archive { bid?, session?, restore?, confirm }
```

- `bid` → 解析该单**本插件拉起的**会话（`spawnedSessionID`：`claim.by`，或 `expiredClaim.by`）；非 spawn 单
  直接报错并提示改用 `session`（不猜「接手的人」）；
- `session` → 直接指定**任意**会话（不要求 spawn 痕迹，`confirm:true` 即人已确认）；
- `restore:true` → `archived:false`，并清 `archivedAt`；
- `confirm:false` 只预览（目标/title/当前 archived 状态）；
- 不允许归档 `[protected*]`；
- 边界（复核 R-14）：同一条记录若再次租约过期、`expiredClaim` 被改写成 `accept`，该孤儿不再被自动认领
  （只能 `session` 直指）——无数据风险，不处理。

## 5. 配置与可见性

```jsonc
{ "archiveSpawned": true, "archiveGraceMs": 600000 }
```

- `collab_list`：记录行尾标 `[archived]`；
- TUI/GUI 快照：`handoffs[]` 增 `archived?: boolean`（只读展示，不影响布局）。

## 6. 测试

| 用例 | 期望 |
| --- | --- |
| 终态+10min+idle+无引用+无队列 | 归档一次，`archivedAt` 落库 |
| 非 spawn / 非终态 / 未到 10min / busy / protected / 有未决引用 / 有未读队列 | 均不归档（各一条） |
| 重复刷新 | 不重复调用 update（幂等） |
| update 抛错 | 不抛、不改状态 |
| `collab_archive {restore:true}` | `archived:false` + 清 `archivedAt` |
| `archiveSpawned:false` | 自动归档关闭，手动工具仍可用 |

## 7. 回滚

配置关闭 + `git restore -- src/`；已归档会话用 `collab_archive {restore:true}` 批量恢复。
