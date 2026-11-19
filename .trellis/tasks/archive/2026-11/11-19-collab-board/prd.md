# PRD：协作看板三层展开（GUI/TUI 共享派生）

## 问题

看板现在是「工作区 → 会话」平铺 + 三份全局列表（锁/交接/队列），关系被拍平：

- 会话行不知道自己持有/排队/发起了什么；
- 「谁拉起了谁」只存在于记录的 `claim.kind='spawn'`，快照没暴露；
- 会话的 `archived` 没进快照，已归档与活跃长得一样；
- 0.6.0 新增的 `priority:"urgent"` 与冻结标记没有展示位。

## 需求

- **R1 共享派生**：新增 `src/core/board.ts`（纯函数、无 IO）`buildBoard(snapshot, freezes)`：
  `Workspace[] → Session[]`，每个会话带 `badges{held,waiting,handoffs,queue}`、`spawned[]`、`archived`、`frozen`、`urgent`。
- **R2 三层展开**：
  - 工作区头：`N 会话 · M 锁 · K 交接 · A 已归档`；
  - 会话行：`🔒n`（持有）/`‹交接 m›`/`[archived]`/`[frozen]`/`[urgent]`；点击展开；
  - 展开内容：该会话的锁、交接、owner 队列、以及 `↳ 它拉起的会话（state + [archived]）`。
- **R3 归档默认隐藏**：活跃列表不含已归档会话；底部 `已归档 N` 折叠段可展开；交接行的 `[archived]` 仍显示。
- **R4 TUI 同等**：`/collab` 面板渲染同一棵树（缩进 2 空格、默认折叠、点击与键盘都能展开/收起）；
  侧栏仍是四数一行（`锁/排/待/宿`）。
- **R5 只读**：看板不提供任何写操作（不释放锁、不归档、不解冻）。
- **R6 数据 additive**：快照只新增**可选**字段（`session.archived`、`handoff.kind/spawned/priority`），
  老 server 回包照常渲染；不改 RPC 方法签名。

## 约束

- 面板窄（`width:"narrow"`）：徽标必须短、默认收起；展开只在用户点击后发生；
- GUI 与 TUI 的数字必须同源（同一 `buildBoard`），不允许各自计算；
- 依赖 0.6.0 前三个子任务（`priority` 来自 escalate，`frozen` 来自 freeze）——**必须最后实现**。

## 验收

- [ ] 构造快照（2 workspace / 1 已归档 / 1 spawn / 1 urgent / 1 frozen）→ `buildBoard` 输出与期望结构一致（单测）；
- [ ] GUI 面板：默认只见活跃会话 + `已归档 1`；展开会话见锁/交接/队列/`↳` 子会话；
- [ ] TUI 面板：同一快照渲染出同样的行（字符帧断言），键盘/点击可展开；
- [ ] 已归档默认不可见（切到「已归档」段才出现）；
- [ ] 老快照（无新字段）不崩、不显示空徽标；
- [ ] 变异：把 spawn 关系画错 / 归档默认显示 → 对应断言失败；
- [ ] 回归 `659 + 12 + 42 + 32 + 47 + 7` 全绿。

## 非目标

- 不做递归树（spawn 只一层）；
- 不做看板内的写操作；
- 不改 `/collab` 的命令入口与侧栏展开交互。
