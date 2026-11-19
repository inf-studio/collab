# PRD：collab_escalate（加急催办）

## 背景

冻结/停手这类事需要「现在就进对方当前轮」；现有 `collab_send` 的 `mode:"steer"` 已经能这样做，
但它没有优先级语义、没有审计字段、也不回报实际投递方式。owner 决策：复用 OpenCode 的
`delivery=steer`（桌面端 UI 的「引导」按钮同一机制），把它包装成一等工具。

## 需求

- **R1 输入**：`{ bid? | threadID? | session?, reason, mode?: "steer"|"queue", confirm }`
  - 目标三选一；`reason` 必填（≤200 字，剥控制字符）；
  - `mode` 默认 **`"steer"`**（加急就该并入当前轮），显式 `"queue"` 才排队。
- **R2 语义**：把目标单标为 `priority:"urgent"` + `urgentAt` / `urgentReason` / `urgentBy`，
  投递一条带 `[URGENT]` 前缀的说明；**不改变**记录的 `state` / `claim` / `receipt`。
- **R3 实际投递回执**：返回宿主给的真实 `delivery`（`steer` / `queue`）与 `messageID`；
  `steer` 未生效（目标空闲/被降级）必须如实显示 `queue`。
- **R4 硬边界**：`BUILTIN_PROTECT` / 血缘 protected → **不投递**，改写 **urgent 队列项**
  （`OwnerQueueItem.priority:"urgent"`），回执 `canPush:false` + 队列位置；
  只读 agent（`explore`/`plan`）目标 → 强制 `queue`（沿用 `resolveMode`）。
- **R5 幂等**：同 `bid + reason` 在 5 分钟内重复调用只刷新 `urgentAt`，不重复投递。

## 约束

- 不新增投递机制（不加新 RPC、不直连 API）；
- 不改 `collab_send` 的默认 `queue`；
- 不自动撤销「urgent」标记（由单的终态自然收起；展示层只按 `state` 未闭环时标 `[urgent]`）。

## 验收

- [ ] 普通目标：记录带四个 urgent 字段，实际 `delivery` 如实返回（`steer` 与 `queue` 各一例）；
- [ ] 只读 agent：传 `steer` 被降级为 `queue`，回执里体现 `forced`；
- [ ] protected 目标：0 次 `session.prompt`，写出 urgent 队列项，回执含位置；
- [ ] 幂等：5 分钟内二次调用不产生第二次投递；
- [ ] `collab_list` / 快照显示 `[urgent]`；`collab_status` 能读出 `priority`；
- [ ] 回归 `638 + …` 全绿，工具数 18 → 19。

## 非目标

- 不做「按分数自动加急」；
- 不做定时催办（重复由人决定，幂等窗口只防手抖）。
