# 集成验收记录（父任务收尾）

## 1. 子任务完成情况

| 版本 | 子任务 | 状态 |
|---|---|---|
| 0.9.0 | `collab-store` | 已归档（3 轮复核：打回 1 次） |
| 0.9.1 | `collab-contract` | 已归档（复核 1 次 + 修复 2 次） |
| 0.9.2 | `collab-gate` | 已归档（口径重做 1 次 + 复核 1 次） |
| 0.9.3 | `collab-drift` | 已归档（复核打回 1 次） |
| 0.9.4 | `collab-facts` | 已归档（复核打回 1 次） |
| 0.9.5 | `collab-decide` | 已归档（复核打回 1 次） |
| 0.9.6 | `collab-pacing` | 已归档（复核有条件通过 1 次） |

发布节点：**0.9.0 → 0.9.3 → 0.9.6**（CI 均 success：`44678664953` / `44716758398` / `44749474730`）。
安装：Linux 全局 `collab:active:v0.9.6`；mac 配置已切 0.9.6（需重启 Desktop 生效）。

## 2. 自动化验收

- 全量回归：**1752** 项（`103+79+89+900+13+20+53+54+30+83+68+62+9+60+47+82`），16 个套件全绿。
- 工具数：**28**（`collab_index / mission / progress / todo / fact / decide` 六个新增）。
- 版本三处一致：`package.json` / `src/constants.ts` / `src/gui.tsx`。
- 测试隔离：所有套件在临时目录运行；真实 `~/.config/opencode/` 的 `collab-facts.json` / `collab-contract/` / `collab-decisions/` / `collab-audit.jsonl` 在门禁前后均不存在。

## 3. 实机验收（0.9.6 安装后）

| 项 | 结果 |
|---|---|
| `collab_index stats`（重建前） | 可用，`messages=5 threads=3 handoffs=1 locks=1` |
| `collab_index rebuild`（1） | 94ms，`messages=5 threads=53 handoffs=25 locks=4 queue=10 sessions=100` |
| `collab_index rebuild`（2） | 60ms，**每表 checksum 与第 1 次逐字节相同**（幂等） |
| `collab_status` | 正常（无未闭环交接时输出不变；无 pending window 时不显示 pacing 行） |
| `collab_mission get` | 返回 `[未设置][未确认]` + 首条人类指令作为建议主线（D7 回退路径） |
| `collab_todo list` / `collab_fact list` / `collab_decide list` | 空账本、可读、零写入 |

## 4. 6 项指标口径（如实记录）

| 指标 | 结论 |
|---|---|
| 消息 : 事实 | 由 0.9.4/0.9.6 的 `metrics` 逐日统计；**尚无线上数据**（0.9.6 刚装） |
| 撤回率 | `metrics.retract_count` + 原因分类可查；同上 |
| 同事实重复确认 | 决策去重 + 对端维度增量基线已落；同上 |
| 空转率 | `noop_count` 可查；同上 |
| 消息间隔 p50 | 回放合成序列：输入 23.5s → 投递 410s（5.11×）；**标注为合成估计，非线上实测** |
| 主线漂移 | 5 轮 / 2h 触发，两条路径（有/无 advance）均测；线上待观察 |

## 5. 已知限制

1. **回放是合成数据**：624 条按 PRD 的 gap 分位与 151 连发结构重建，增量率建模 25%；不是线上序列。
2. **`rebuild` 会清空 `metrics` 日计数**（派生值，下次投递重算）——永久保留的策略下，这会让历史指标在重建后丢失。
3. **`stale` 回复 ≤30% 原文是行为约定**，插件不生成回复、无法机器判定；只注入指令 + 记 `staleDeliveries`。
4. **闸门拦不住 bash 层跨仓写**：边界强制只覆盖协作层（accept/broadcast/reply/handoff）。
5. **Desktop GUI 只加载本机 sidecar 的插件**（上游 issue anomalyco/opencode#64788），远端数据经 `session.server.client`。
6. **mac 需重启 Desktop** 才会切到 0.9.6。

## 6. 与规划的偏差（汇总）

| 偏差 | 原因 |
|---|---|
| 0.9.2 从「关键词/别名匹配」改为「模型表态 + 审计」 | 用户拍板：通用插件不该内置领域词；关键词必然误伤主线单 |
| 0.9.2 溢出从「拒收」改为「只提醒」 | 用户拍板：派活是清账手段，拦截与目标相反 |
| 0.9.5 删除 `roleAdvice` 文本匹配 | 与「零文本匹配」原则冲突，实测三句常见话均误伤 |
| 0.9.6 `directKinds` 默认 `[]` | `escalate` 根本不走 dispatch，配置项不可达 |
| 注入从五段改四段（0.9.2）、`[role]` 并入 mission（0.9.5） | 删 `[scope]` 后重算预算；保证六段全满仍 ≤12 |

## 7. 结论

7 个子任务全部归档，父任务跨子任务验收的执行部分（自动化 + 实机）通过；
指标类验收（消息量/撤回率/空转率）需要 **线上运行 1–2 天**后从 `metrics` 拉数，不在本任务范围内。
