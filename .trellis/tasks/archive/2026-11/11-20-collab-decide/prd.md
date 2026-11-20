# 决策载具 + 角色四元组（0.9.5）

## 问题

- 24 条 handoff 的 `decisions[]` **全空**，`collab_decisions` 从未使用；两条最大 thread（418 / 140 条）**根本没有 handoff 记录**，决策无处可落。
- 同一个决策反复重开：11:09 起「决策」类措辞 19 次，00:52 出现「第四次/第五次同步同一事实」。
- 角色边界靠自然语言重申：B(排钟) 54 次决策类措辞 / 31 次边界声明，A(issues) 38 / 36 —— 双方都在声明边界 = 边界没被写下来。

## 需求

- **R1 决策载具**：`collab_decide`（单工具，action）`open / answer / supersede / list`；thread 路径与 handoff 路径**都可用**。
- **R2 owner 独占关闭**：只有 `owner` 能 `answer`；提问方不得代答（返回可读拒绝）。
- **R3 同问去重**：规范化 `question` hash 已存在 open → 拒绝新建，直接返回 `D3 open, wait <owner>`。
- **R4 上限 3 条**（D9）：同一 `thread` / 同一会话同时 open ≤3；第 4 条拒绝并提示先关。
- **R5 角色四元组**：`requester / implementer / decider / verifier`；注入头显示 `[role:…]`；`decider` 缺省 = 发单方 owner。
  - implementer 不得把实现选择抛回 requester；
  - requester 不得替 implementer 做实现决策。
- **R6 conflict 升级**：`facts` 判 `conflict` 时自动创建 open 决策（而不是继续对话）。

## 验收

- [ ] thread（无 handoff）路径开决策 → 成功，且 `collab_decide list {threadID}` 可见。
- [ ] 非 owner `answer` → 拒绝。
- [ ] 同 question 二次 `open` → 拒绝并返回既有 `D#` 与 owner。
- [ ] 已有 3 条 open 时开第 4 条 → 拒绝（上限 3）。
- [ ] 角色注入：requester 收到含实现决策的请求 → 注入提示"应转给 decider/implementer"。
- [ ] `conflict` 自动升级 → 生成 open 决策且不进消息循环。
- [ ] 回归全绿；工具数 27 → 28。

## 依赖

- 依赖 `0.9.4`（conflict 判定）与 `0.9.1`（绑定会话契约的 peers）。

## 影响文件（预估）

`src/tools/decide.ts`（新）、`src/core/decisions.ts`（新）、`src/core/contract.ts`、`src/hooks/context.ts`、`test/decide.mjs`（新）。
