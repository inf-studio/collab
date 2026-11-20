# 事实账本 + settle/invalidate（0.9.4）

## 问题

- 撤回/更正 **117 条（19%）**：环境干扰 39、工具误用 33（如 `rg -rn` 把匹配替换成 `n` 导致"签名头改名"的假结论）、探针假象 26、口径不同 25。
- 决策撤销无传播：00:45 owner 裁定「不做前缀隔离」，对方在途工作到 **00:59** 才停（14 分钟），期间 67 条消息 / 85 KB 都在同步一个已作废的事实。
- 275 条消息带「你读的是旧快照 / 落后」，但接收方无法判断哪些结论仍然有效。

## 需求

- **R1 事实账本**：工作区级（D4）`collab-facts.json` + `facts` 表；字段 `{id, claim, grade, evidence, state, basedOn, by, at, supersededBy}`。
- **R2 证据等级强制**（D5）：`measured | inferred | relayed`；未标注 → 注入 `[未标注]`，对方可要求补；`relayed` 不得被当作事实引用。
- **R3 `collab_fact`**（单工具，action）：
  - `settle {claim, evidence, grade}` → `state='active'`，注入 `[settled:F2]`；
  - `invalidate {since: factId | epoch}` → 该事实及其派生标 `superseded/retracted`，**工作区级传播**（D6），注入 `[retracted:F3→F9]`；
  - `retract {id, reason}` → 记撤回原因（可度量）；
  - `list` → 只读。
- **R4 三态判定**（父 design §3.1）：`fresh / stale / conflict`；`stale` 时**只回增量 + 新基线**，禁止重述事实；`unknown` 按 `fresh` + `[基线未知]`（D2）。「≤30%」是给模型的**行为约定**（插件不生成回复，无法机器判定），可审计的一半是 `metrics.staleDeliveries`。
- **R5 在途工作失效**：`invalidate` 到达时，引用被作废事实的 open todo 自动标 `stale-work` 并进 `[todo]`。
- **R6 glossary**：每对会话 3–10 条术语定义（`状态` / `已发版` / `回退` …），注入一行摘要；同一术语第 2 次冲突强制要求定义。

## 验收

- [ ] 撤回可度量：`retract F3` 后 `metrics.retract_count` 当日 +1（`settle` 覆盖同 claim 也计入 supersede），且原因分类可查。
- [ ] stale 回复（**行为约定，不是自动闸门**）：插件不生成回复，无法机器判定长度。可验证的两条：
      (a) 注入逐字包含「只回增量（≤30% 原文），不要重述已作废事实」；
      (b) 每次 `stale` 投递记入 `metrics.staleDeliveries`（当日计数，供人工抽检比值）。
      「≤30%」是给模型的约定，不是插件执行的拒绝条件。
- [ ] invalidate 生效：`invalidate {since:F3}` 后一个投递窗口内，对端注入出现 `[retracted]`，在途 todo 标 `stale-work`
      （todo 的 `ref` 带 workspace，另一个工作区的同名 `F#` 不会被误标）。
- [ ] 未标注消息 → 注入 `[未标注]`，`collab_fact list` 显示 `grade=unknown`。
- [ ] 同一术语第 2 次冲突 → 拒绝继续，要求先定义。
- [ ] `relayed` 事实被引用为证据 → 拒绝并提示补 `measured`。
- [ ] 跨进程并发写不丢账：两个进程各 settle 25 条到不同 workspace，`wsA=25/25, wsB=25/25, lost=0`；
      去掉文件锁必须复现丢失。
- [ ] 回归全绿；工具数 26 → 27。

## 依赖

- 依赖 `0.9.0`（messages/facts 表）与 `0.9.1`（todos 才能标 `stale-work`）。
- 被 `0.9.5`（conflict → 决策）依赖。

## 影响文件（预估）

`src/core/facts.ts`（新）、`src/core/glossary.ts`（新）、`src/tools/fact.ts`（新）、`src/core/messages.ts`、`src/hooks/context.ts`、`test/facts.mjs`（新）。
