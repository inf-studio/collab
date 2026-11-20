# 集成验收记录：0.9.x 复盘、看板契约与收尾

## 1. 子任务

| 序 | 子任务 | 状态 |
|---|---|---|
| ③ | `collab-0p9-retro` | 已归档（文档复核 1 次：上游 #64788 事实错误已修） |
| ② | `collab-board-contract` | 已归档（复核 1 次：3 条显示层修正已修） |
| ① | `collab-0p9-close` | 已归档（复核 1 次：F1 `sinceDays:0`、F2 窗口口径已修） |

## 2. 自动化验收

- 回归：**1801** 项（`103+79+89+900+13+20+53+67+43+83+68+62+9+66+47+99` 的对应套件），16 套件全绿。
- 工具数：**28**（本批未新增）。
- 版本：仍 **0.9.6**（本批未 bump；发布属父任务/主会话决策）。
- 隔离：干净 HOME 与真实 HOME 下均绿（`pacing` 那条环境性红已改为前后快照）。

## 3. 子任务关键结果

### ③ 复盘文档（`docs/issues/`）

- `feat-collab-protocol-v2.md`：七版取舍 + 六项指标口径 + 8 个关键缺陷 + 下一步建议。
- `bugs-rebuild-drops-metrics.md`：现象 / 最小复现脚本 / 根因 / 修法 / 回滚。
- `upstream-opencode-64788.md`：**64788 已作为 #63990 重复关闭**；解除条件按 #63990（「从远端加载 bundle」已被上游否决）。

### ② 看板契约

- 快照可选 `contract`（mission/progress/todos/drift），mtime 缓存；**无契约逐字节同 0.9.6**（独立 HEAD 构建证实）。
- 列表徽标 `◇ > ◐ > ◑n > ●`，不新增行；详情固定顺序；TUI 摘要行按终端格数截断。
- 徽标数量统一 `todos.open`（blocked 是分解）；`suspended-expired` 的 drift 年龄取自身。

### ① 收尾

- `rebuild` 重算 `metrics`：单点聚合（`core/metrics.ts`），与投递侧同函数；排除 `_r\d+$` 重发行；`noop/late` 来自 `collab-pacing.json`。
- 窗口统一：`sinceDays` 只裁剪**投影**，JSONL 永久保留；`0` = 不按时间过滤；`stats` 覆盖范围与 `messages` 跨度一致。
- 幂等：两次 rebuild `metrics` checksum 相同。

## 4. 机验状态

| 项 | 结果 |
|---|---|
| Linux | `collab:active:v0.9.6`；`indexStats` `available:true backend:node`；`metrics 覆盖 2026-11-20–2026-11-21（2 天）` |
| **mac** | 配置已写 0.9.6，但 `~/.config/opencode/node_modules` **无该包**、`plugins/` 空、无 `collab.db`/`collab-messages.jsonl` → **实际未安装**；`.npmrc` 缺 `@inf-studio:registry` 行 |
| 24h 对比 | **未满 24h**（0.9.6 于 2026-11-20 22:03 安装）→ 移交主会话，满 24h 后执行 |

## 5. 已知遗留（本批未修，已记录）

| # | 项 | 影响 |
|---|---|---|
| F3 | `pacing` 计数只保留 30 天，超期后 rebuild 把 `noop/late` 写成 0 | 历史「0」可能表示「无数据」 |
| F4 | 「只有重发行」的那一天：写入侧有行、rebuild 无行 | 概率低 |
| F5 | 幂等断言在 `checksums.metrics` 全 `undefined` 时仍绿 | 测试 nit |
| F6 | `refreshMetrics({file})` 把同一个 `file` 喂给两个不同用途 | 仅 harness 坑 |
| — | 24h 对比表 | 需时间 |

## 6. 结论

③②① 全部归档；自动化与代码层验收通过。**未完成的两项均为操作项**：mac 实际安装（需补 registry 行后 `plugin add`）、满 24h 的指标对比。
