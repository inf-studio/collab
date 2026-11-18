# followUps 硬化：stamp 时机 / 无效路径 / 相对路径（F1–F3）

> 来源：std-ui 承接方对 0.2.0 的 H1–H5 只读复核（5/5 落实）+ 3 条新发现。
> 当前状态：0.3.0 已发布；本任务为后续补丁（0.3.1）。

## 问题

- **F1 提示先标记、后投递**：`followUpHints` 在返回提示行之前就 `markFollowUpSeen`。
  若本轮注入因宿主异常或会话归档未真正进入模型上下文，提示**永久丢失**（at-most-once 无投递确认）。
- **F2 无效路径静默丢弃**：路径校验失败的 entry 直接 `skipped.push(key)` 并被标记，
  提案被归档/移动、或 `docs/issues` 本身是软链时，提示静默消失且不重试。
- **F3 相对路径 `./` 被拒**：`validateIssuePath` 连 `.` 段一起拒，`./docs/issues/x.md` 判非法（与直觉冲突）。

## Requirements

- **R1（F1）**：将「标记已提示」推迟到注入成功之后：`followUpHints` 只返回 `{line, keys}`；
  由 `context` hook 在 `event.system.push(...)` 之后才 `markFollowUpSeen`。
  注入抛错时**不标记**，下一轮可重试（自然重试，无需额外计数）。
- **R2（F2）**：路径校验失败的 entry **不标记**；改为在 `collab_list`（以及 `collab_followup` 的返回）
  汇总「N 条 followUp 因路径无效未渲染」；同一无效 entry 每会话最多提示一次统计（避免每轮噪声）。
- **R3（F3）**：先做路径规范化（合并 `./`、重复 `/`），**只拒绝 `..`** 与绝对路径；软链仍拒（realpath 后校验）。
- **R4**：回归覆盖——注入失败不标记（下轮仍提示）、无效路径汇总一次、`./docs/issues/x.md` 可渲染、
  `../x` 仍拒；既有 506+12+18 全绿。
- **R5**：文档同步（`docs/collab.md` §11.9/§12.5），`0.3.1` 发布。

## Acceptance Criteria

- [ ] 模拟 hook 抛错 → 该 followUp 下一轮仍被提示（未被 stamp）
- [ ] 无效路径 entry 不被 stamp，`collab_list` 显示「N 条无法渲染」且只提示一次
- [ ] `./docs/issues/x.md` 正常渲染；`../docs/issues/x.md`、绝对路径、软链仍拒
- [ ] 既有回归全绿；`0.3.1` 发布

## 边界

- 不改变 followUps 结构化字段与权限模型；不放宽 H3 的越界/软链拒绝。
- 不新增依赖；不改 handoff / lease 语义。
