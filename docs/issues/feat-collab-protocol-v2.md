# 协作协议 v2（0.9.x）：设计取舍与教训

- 状态: done（0.9.0–0.9.6 全部发布并归档）
- 范围: 本仓（`@inf-studio/collab` 插件、工具、注入、看板）
- 关联: 父任务 `11-20-collab-session-contract`（已归档）；发布 tag `v0.9.0` / `v0.9.3` / `v0.9.6`
- 结论先行: 0.9.x 把「协作靠对话传状态」改成「状态存账本、消息带版本、判断留痕」。**收益不在功能数量，而在把四类反复出现的事故变成了可检测对象**。

## 0) 起点：一次盘点给出的基线

2026-11-19 07:34 → 11-20 01:04，两个会话 624 条跨会话消息、17.5 小时：

| 指标 | 实测 |
|---|---|
| 人类真实输入 | 排钟 6/323 轮；issues 13/395 轮 |
| 空转消息（无新推送/同上） | 101 条（16%） |
| 撤回/更正 | 117 条（19%） |
| 「你读的是旧快照」 | 275 条 |
| 同事实重复确认 | 一个事实 67 条 / 85 KB / 21 分钟 |
| 消息间隔 | p50 20s；最长连续 151 条 |
| compaction | 两会话各 2 次，均落在峰值 |
| 决策留痕 | 0（`collab_decisions` 从未使用） |
| 主线漂移 | 排钟 10.8 小时零推进、零提醒 |

**结论**：问题不在「人不够勤」，在于会话没有自我模型、协作没有版本、判断没有留痕。

## 1) 七个版本各自解决什么

### 0.9.0 存储地基（`collab-store`）

- **解决**：协作消息历史此前根本没存（inbox 只存未读、threads 只有 80 字 preview），复盘只能去 API 分页拉。
- **取舍**：JSON 是唯一真源，SQLite 只做**可重建投影**（删库不影响协作）；`messages.jsonl` 存全文，仅 FTS 索引体截 8KB。
- **复核打回**：测试曾把 616 条假消息写进真实 `~/.config`；`rebuild` 不写 `meta.schema` 导致看板永远回落 JSON；全局 `synced_at` 让陈旧 lease 被当新鲜；并发 rebuild 静默丢行（测试注释记 20/40；PRD 早期稿记 16，以测试为准）。
- **遗留**：`rebuild` 会清空 `metrics`（见 `bugs-rebuild-drops-metrics.md`）。

### 0.9.1 会话契约（`collab-contract`）

- **解决**：每轮注入 `[mission]/[todo]/[drift]/[progress]`，**不写 `injected[]`**、不注销——这是与 0.5.x 一次性注入的根本区别。
- **取舍**：主线锚只从 Trellis 活动任务或「首条人类指令 + 人工确认」来，**不猜标题**；进度里程碑必须带 `commit:/file:/test:/decision:` 证据才点亮。
- **复核打回**：并发 `todo add` 撞 id（`[T1,T1,T1]`）；`turn.count` 只在有 todo 时递增（会让 0.9.3 的 5 轮判定永远数不出来）；读侧按总数截断导致新行不可见 + id 复用。
- **遗留**：无。

### 0.9.2 协作闸门（`collab-gate`）

- **解决**：接单前必须显式表态 `scopeCheck:{inScope,reason}`，插件只记录不推断。
- **取舍（被用户推翻两次）**：
  1. 最初用「内置别名 + 子串匹配」，实测把 `排钟 Redis 缓存键设计` 判成越界 —— **通用插件不该内置领域词**；
  2. 改为「模型表态 + 审计」，并删除 `[scope]` 注入段；溢出从「拒收」改为**只提醒**（派活是清账手段）。
- **复核打回**：`derive` 拒绝时仍会推进 `asked/attempts`；闸门位置在只读分支之前导致「已被领取」被误报越界。
- **遗留**：闸门只覆盖协作层，拦不住 bash 跨仓写。

### 0.9.3 漂移与挂起（`collab-drift`）

- **解决**：连续 5 轮无主线推进 / 挂起 >2h / suspended 超 24h → `[drift]` 三选一（resume/block/done），必须落账。
- **取舍**：`stampTurn` 在**请求开始**就把本轮计入，`evaluate` 原样读——两处各 +1 会让「有推进过」的会话晚一轮（生产必然走这条路）。
- **复核打回**：`block → resume` 留僵尸挂起行，`[drift]` 永远消不掉；`manual` 挂起也会 24h 转 drifted（文档起初写成「仅人工唤醒」）。
- **遗留**：`[未处置]` 只由三选一清除，只推进不表态的会话会长期标红（设计如此）。

### 0.9.4 事实账本（`collab-facts`）

- **解决**：`settle / retract / invalidate` + 证据等级（measured/inferred/relayed/unknown）+ 三态 `fresh/stale/conflict`；`invalidate` 工作区级传播，在途 todo 标 `⚠失效`。
- **取舍**：派生作废走 `factIds` 显式引用闭包，`since:<epoch>` 才用 `basedOn.facts <= epoch` —— 混用会误伤同 epoch 的无关事实。
- **复核打回**：`collab-facts.json` 是全机单文件整本读改写，**两个进程并发会互相抹掉对方整个工作区**（历史记录丢 20–25/50，两边 exit 0；仓内无复现脚本，修复后有双进程回归 `lost=0`）；`metrics.retracted` 不计 settle 覆盖；跨工作区 `staleWork` 误标。
- **遗留**：「stale 回复 ≤30% 原文」是行为约定，插件无法机器判定。

### 0.9.5 决策载具（`collab-decide`）

- **解决**：`collab_decide`（thread 与 bid 双路径）、同问去重（NFKC/空白/标点/大小写）、手工 open ≤3、owner 独占关闭；`conflict` 自动开决策且 thread 只读。
- **取舍**：提问方 `askedBy` 与回答者 `by` 分离（提问方可见、可撤回，但不能 answer）；conflict 决策单独配额，不占手工 cap。
- **复核打回**：提问方没被记录（`by:null` → 看不见也作废不了）；conflict 只读**没有逃生口**（owner 缺席时永久锁死，**已修**：对端可 supersede + 24h TTL 自动解除）；注入预算 13>12 把 `[progress]` 生产丢弃；`roleAdvice` 又用正则做文本匹配（三句常见话全误伤）。
- **遗留**：同问已 answered 后再开，会得到新 `D#` 而不返回既有结论。

### 0.9.6 投递节奏（`collab-pacing`）

- **解决**：非紧急消息 2min 窗口合并为一条 `items[]`；`escalate/blocked/protected/bid/force` 直通；无增量不发只写 `collab_status`。
- **取舍**：增量基线按 `(from,target)` 对端维度——按发送方存会导致「同一事实永远发不到第二个对端」；记账失败逐条 best-effort，不再整窗回退。
- **复核打回**：上述基线 bug；记账失败导致重复投递；回放 9.18× 是单 target 伪影（真两会话 5.11×）；一条恒真测试。
- **遗留**：直通消息可能越过同 target 的在窗消息（到达序 ≠ sentAt 序，已写文档）。

## 2) 六项指标：基线与当前口径

| 指标 | 11-20 基线 | 0.9.6 后 |
|---|---|---|
| 消息 : 事实 | 67 : 1 | 由 `metrics` 逐日统计（线上数据待积累） |

> **metrics 只覆盖安装之后**：安装前的历史不存在，`rebuild` 不伪造（详见 `bugs-rebuild-drops-metrics.md`）。
| 撤回率 | 19% | `metrics.retract_count` + 原因分类可查 |
| 同事实重复确认 | 5 轮 | 决策去重 + 对端维度基线 |
| 空转率 | 16% | `noop_count` 可查 |
| 消息间隔 p50 | 20s | 回放合成序列：23.5s → 410s（5.11×，**合成估计**） |
| 主线漂移 | 10.8h 无提醒 | 5 轮 / 2h 触发，两条路径均测 |

## 3) 被复核抓到的关键缺陷（按后果排序）

| 缺陷 | 若不修的后果 |
|---|---|
| 测试写真实配置（616 条假消息） | 之后所有复盘数据被污染 |
| `rebuild` 不写 `meta.schema` | 按文档建索引后看板永远回落 |
| 全局 `synced_at` | 陈旧 lease 被当新鲜，看板显示「没人用」 |
| facts 文件无跨进程锁 | 并发写静默丢对方整本账 |
| 增量基线只按发送方 | 同一事实永远发不到第二个对端 |
| 记账失败当投递失败 | 整窗回退 → 重复投递 |
| `roleAdvice` 正则 | 违反「零文本匹配」，三句常见话全误伤 |
| 回放 9.18× 单 target 伪影 | 验收数字虚高，真值 5.11× |

## 4) 工程数据

- 工具：22 → **28**（`collab_index / mission / progress / todo / fact / decide`）。
- 测试：899 → **1752**（`103+79+89+900+13+20+53+54+30+83+68+62+9+60+47+82`，16 套件）。
- 发布：`v0.9.0`（CI 44678664953）、`v0.9.3`（44716758398）、`v0.9.6`（44749474730），均 success。
- 实机：`rebuild` 两次 **checksum 逐字节相同**（94ms / 60ms；`messages=5 threads=53 handoffs=25 locks=4 queue=10 sessions=100`）。
  出处：`.trellis/tasks/archive/2026-11/11-20-collab-session-contract/integration.md`；复现：`node test/store-rebuild.mjs`（30/30，含幂等断言）。

## 5) 下一步建议（未立项）

| 建议 | 理由 | 代价 |
|---|---|---|
| 看板显示契约（徽标 + 详情） | 数据已在 contract，人却看不到「哪条要漂」 | 小（只读 UI） |
| 人类决策清单（跨会话汇总 open 决策） | 现在只能逐会话看 `[decide]` | 中 |
| `rebuild` 重算 metrics | 「永久保留」与「重建清零」自相矛盾 | 小 |
| 跨机同步（DB/账本） | mac 与 linux 目前不互通 | 大（架构） |
| 上游 `anomalyco/opencode#63990`（64788 已作为重复关闭） | 桌面端只加载 app 自带 sidecar 的 GUI；上游已否决「从远端加载 bundle」 | 等 #63990 |

> 前三项已拆成本批任务（`11-21-collab-0p9-retro` / `-board-contract` / `-close`）；后两项未立项。
