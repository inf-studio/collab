# 协作闸门：越界默认拒绝（0.9.2）

## 问题

- 排钟专题在 13:00–00:52 期间把主要精力投入 ws 集群（14:00 起「排钟」关键词归零、ws 98 次），最终要人类 766 字手工拉回主线。
- 现状所有规则都是**可选建议**：22 个工具没有任何一个会拒绝越界动作。

## 需求

- **R1 scope 校验（accept）**：`bid.scope ∩ mission.outOfScope ≠ ∅` → **拒绝**，返回可读理由 + `handoffTo` 建议 + override 用法。
- **R2 override**：`{reason, approvedBy}` 必填（`approvedBy` 必须是人类标识）；通过后写 `audit.jsonl`（bid / sid / scope / reason / at）。
- **R3 broadcast / handoff 方向不拦**：发起方有权向任何人提问；但注入要提示接收方"这可能是你边界外的"。
- **R4 reply / send 不校验 scope**：回复不扩大边界，避免正常回执被误伤。
- **R5 溢出闸门**：`open todos ≥ 8` → 新 `accept` / `broadcast` 返回 `TODO_OVERFLOW`，要求先关 2 条。
- **R6 开关**：配置 `gate: 'enforce' | 'warn' | 'off'`，默认 `enforce`；误伤时可即时降级。

## 验收

- [ ] 向 outOfScope 发 accept → 拒绝，输出含 `handoffTo` 与 override 示例。
- [ ] 带合法 override → 通过；`audit.jsonl` 新增一行且字段完整。
- [ ] override 缺 `approvedBy` → 拒绝。
- [ ] `scope` 为空（未设置越界）→ 不拦任何动作（误伤 0）。
- [ ] `open todos = 8` 时接新单 → `TODO_OVERFLOW`；关 2 条后恢复。
- [ ] `gate='warn'` 时越界只提示不拒（回滚开关可用）。
- [ ] 回归全绿；工具数不变（26，闸门是既有工具的前置校验）。

## 依赖

- 依赖 `0.9.1 collab-contract`（`mission.outOfScope` / `todos`）。

## 影响文件（预估）

`src/core/gate.ts`（新）、`src/tools/accept.ts`、`src/tools/broadcast.ts`、`src/tools/handoff.ts`、`src/config.ts`、`test/gate.mjs`（新）。
