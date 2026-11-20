# 会话契约骨架 + 五段式注入（0.9.1）

## 问题

- 主线/边界/进度/待办只存在于对话内容；排钟会话 323 轮里人类只说 6 句，主线 13:00→00:52 **10.8h 零推进、零提醒**。
- 现有注入是**一次性**（展示后进 `injected[]` 注销），消息一多或 compaction 之后什么都不剩。

## 需求

- **R1 契约存储**：`collab-contract/<sid>.json`，五面 `mission / plan / todos / peers`（见父 design §4）；写路径 `tmp+rename`。
- **R2 `collab_mission`**：`get / set / confirm`。
  - `task.py current` 有活动任务 → 直接读；
  - 无任务 → 用会话首条人类指令生成 `oneLine`，标 `[未确认]`；
  - `confirm` 一次后**固定**，后续注入/自动推断不得覆盖。
- **R3 `collab_progress`**：`M# --evidence <commit|test|decision>`；**无 evidence 不点亮**；evidence 需 `git log` 或 `task.json` 可校验（D20/D21）。
- **R4 `collab_todo`**：`add / close / defer / suspend`；`close` 必填 evidence；`suspend` 必填 `wake_when`。
- **R5 五段式注入**：`[mission] / [progress] / [todo] / [scope] / [drift]`，**每轮重新计算、不注销**；合计 ≤12 行；todo 只列 top3 + 计数。
- **R6 空闲留痕**：`idle` 前未收尾的 todo 保持不变；下一轮注入标 `[未收尾]`。

## 验收

- [ ] 回放测试：连续两轮请求，**第二轮仍含 `[mission]` 与 `[todo]`**（一次性注入实现必红）。
- [ ] `collab_progress M3` 不带 evidence → 拒绝；带合法 commit → 点亮且 `lastAdvancedAt` 更新。
- [ ] `confirm` 后尝试 `set` 覆盖 → 不生效（返回可读拒绝）。
- [ ] 配额：构造 10 条 open todo → 注入 ≤12 行且只列 3 条 + `还有 7 条`。
- [ ] 无任务且未确认 → 注入显示 `[mission] … [未确认]`。
- [ ] `suspend` 无 `wake_when` → 拒绝。
- [ ] 回归全绿；工具数 23 → 26。

## 依赖

- 依赖 `0.9.0 collab-store`（读索引取 thread/最近消息）。
- 被 `0.9.2`（scope）与 `0.9.3`（plan/todos）依赖。

## 影响文件（预估）

`src/core/contract.ts`（新）、`src/tools/mission.ts`（新）、`src/tools/progress.ts`（新）、`src/tools/todo.ts`（新）、`src/hooks/context.ts`、`src/tools/index.ts`、`test/contract-inject.mjs`（新）。
