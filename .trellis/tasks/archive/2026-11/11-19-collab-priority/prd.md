# PRD：高优先级协作（0.6.0）

## 背景

「冻结会话 / 立即停手」这类高优先级协作，目前只能靠普通 `collab_send` + 人工盯：
没有加急通道、没有非阻塞状态查询、没有协作层的冻结语义。实例：`ses_e4c03493…` 冻结 3 个会话时，
只能一轮轮等 ACK，protected 会话（`ses_e1eb91ce`）只能走队列，无法立刻确认状态。

owner 决策（2026-11-19）：新增三个工具，发 **0.6.0**（minor，新增工具不破坏现有语义）。

## 目标（三个子任务，各自独立验收）

| 子任务 | 交付 | 一句话 |
| --- | --- | --- |
| `11-19-collab-status` | `collab_status` | 只读、非阻塞地看「这一单现在到哪一步」 |
| `11-19-collab-escalate` | `collab_escalate` | 加急投递，复用 OpenCode 的 `delivery=steer`（= UI 的「引导」），并回报实际投递方式 |
| `11-19-collab-freeze` | `collab_freeze` | 协作层冻结标记（可逆、可过期），工具与展示联动 |

建议顺序：**status → escalate → freeze**（三者都改 `types.ts` / `tools/index.ts` / 文档，并行会冲突）。

## 共享语义（父任务拥有）

- `BroadcastRecord` 增 `priority?: "urgent"`、`urgentAt`、`urgentReason`、`urgentBy`；
- 快照 `handoffs[]` 增 `priority?: "urgent"`，`collab_list` / TUI / GUI 标 `[urgent]`；
- 冻结标记文件：`~/.config/opencode/collab-freeze.json`（读-合并-写，`entries[] = { scope, target, reason, by, at, until }`）；
- `BUILTIN_PROTECT` 与「不打断」硬边界**不变**：protected 永不 push、只读 agent 永不 steer；
- 工具总数 **17 → 20**；`docs/collab.md` 工具表、skill 速查表、README 同步；
- 版本 `0.6.0`。

## 验收（父任务）

- [x] 五个子任务均通过各自验收 + 独立复核（consistency / status / escalate / freeze / board）；
- [x] 回归：`735 + 12 + 13 + 50 + 44 + 47 + 17` 全绿，工具数断言 17 → 20；
- [x] 四个新工具互相引用正确（`escalate` 的 protected 路径写 urgent 队列，`status` 能读出 `priority` 与队列位置，`freeze` 拒绝新建交接）；
- [x] 文档：§11.2（20 个工具）、§11.14（status/escalate/freeze）、§11.11.6（三层看板）、skill、CHANGELOG 0.6.0；
- [x] 一次发布 `0.6.0`（tag + CI + 安装 + 运行时版本验证）。

## 非目标

- 不做跨机器推送、不改桌面端、不做「自动升级优先级」；
- 不改 `collab_wait` 的阻塞语义（非阻塞查询走新工具）；
- 不做冻结自动解冻以外的策略（到期即解除，不提醒）。


## 完成记录（2026-11-19）

| 子任务 | 交付 | 关键修复 |
| --- | --- | --- |
| `collab-consistency` | waiter 心跳/回收、四数、60s 幂等 | 解掉「free 却锁不上」死锁 |
| `collab-status` | `collab_status` | 只读、protected 可查 |
| `collab-escalate` | `collab_escalate` | 复用 `delivery=steer`，protected 转 urgent 队列 |
| `collab-freeze` | `collab_freeze` | 可逆可过期，4 个强制点，血缘生效 |
| `collab-board` | 三层看板 | GUI/TUI 共享 `board.ts`，孤儿行不再丢弃 |

版本 `0.6.0`；工具 17 → 20；快照仅追加可选字段。
