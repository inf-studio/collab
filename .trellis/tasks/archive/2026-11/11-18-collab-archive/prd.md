# 协作结束后自动归档 spawn 会话（`collab_archive`，0.5.0）

> 目标：bootstrap（`claim.kind === 'spawn'`）会话在**不再需要参与协作**后自动归档——不是删除。
> 接口：`PATCH /api/session/{id} { archived: true }`（可逆，`false` 恢复）。

## Requirements

- **R1 只归档我方 spawn 的会话**：`claim.kind === 'spawn'` 且 `claim.by` 存在；用户自己的会话、
  `collab_handoff` 的对象、requester 一律不碰。
- **R2 触发条件（全部满足）**
  1. 该 bid 已终态：`done` / `blocked` / `expired`；
  2. 终态已过 ≥ **10min**（防抖，不是等待窗口；默认 `archiveGraceMs=600000`，可配 1min–1h）；
  3. 目标 **idle**；
  4. 它不再被任何未决交接引用（既非 `from.sid` 也非 `claim.by` 的非终态记录）；
  5. 没有指向它的未读 owner-queue 项；
  6. 非 `[protected*]`；
  7. 尚未归档（幂等，看 `archivedAt`）。
- **R3 动作**：`ctx.session.update({ sessionID, archived: true })`（宿主不支持时走 `COLLAB_SERVER_URL` HTTP）；
  成功写 `archivedAt`；失败只记录，不影响主流程。
- **R4 手动工具**：`collab_archive { bid? | session?, restore?, confirm }` ——
  手动归档 / 恢复（`restore:true` → `archived:false`）；`confirm:false` 只预览。
- **R5 配置**：`archiveSpawned`（默认 `true`）、`archiveGraceMs`（默认 10min，范围 1min–1h）。
- **R6 可见性**：`collab_list` 对已归档显示 `[archived]`；归档不改变记录状态。
- **R7 回归**：六类不归档（非 spawn / 非终态 / 仍有未决引用 / 有未读队列 / busy / protected）+
  正常归档一次 + restore + update 抛错不抛 + 幂等。
- **R8 发布**：`0.5.0`（新增工具，minor）。

## Acceptance Criteria

- [ ] 终态+11min+idle+无未决引用 → 归档一次，`archivedAt` 落库
- [ ] 六类场景均不归档（构造断言）
- [ ] `collab_archive {restore:true}` 恢复成功（`archived:false`）
- [ ] update 抛错不改变工具返回、不抛出
- [ ] 既有回归全绿；`0.5.0` 发布

## 边界

- **归档 ≠ 删除**：会话与消息保留，可恢复；不调用 DELETE。
- 不动 `BUILTIN_PROTECT`；不改 handoff/lease 语义。
- 依赖 `0.4.2`（TUI/GUI 可见性）先归档；本任务只动 server 逻辑与工具。
