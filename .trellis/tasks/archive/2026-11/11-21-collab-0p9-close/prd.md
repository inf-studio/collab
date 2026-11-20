# 收尾：metrics 重算 + 机验 + 24h 对比

## 问题

1. `collab_index rebuild` 会清空 `metrics` 日计数（实测：重建前 `metrics=1` → 重建后 `metrics=0`）。在「全局单库永久保留」的策略下，历史指标不可追溯。
2. mac 已切 0.9.6 配置但未重启 Desktop，未做安装确认。
3. 0.9.6 刚装，六项指标还没有真实数据；基线是 11-20 的盘点值（16% 空转 / p50 20s / 67:1 / 漂移 10.8h）。

## 需求

- **R1 `rebuild` 重算 metrics**：
  - `msg_count` 从 `collab-messages.jsonl` 聚合，**排除重发行**（`id` 匹配 `_r\d+$`）；
  - `median_gap_ms` 用与写入侧**同一聚合函数**；
  - `noop_count` / `late_count` 从 `collab-pacing.json` 的 `counters[day]` 读取；
  - `--sinceDays`（默认 180）范围内 UPSERT；**幂等**（两次 rebuild，`metrics` checksum 相同）。
- **R2 覆盖范围可见**：`collab_index stats` 输出「metrics 覆盖 <首日>–<末日>」；无数据时写 `无`，不伪造。
- **R3 mac 机验清单**：重启 Desktop → `collab:active:v0.9.6` → `collab_index stats` 可用 → 看板出现契约徽标（有契约的会话）。
- **R4 24h 对比表**：拉 `metrics` 当日数据，与 11-20 基线并排，≥3 项指标；不足 24h 必须标「不足」。
- **R5 测试健壮性（本批顺带）**：`test/pacing.mjs` 的「不创建真实 `collab-pacing.json`」断言在**插件运行中**会误红
  （文件本来就存在）。改为**前后快照比较**（size+mtime 不变），与 0.9.0 的 B1 隔离断言同一写法。

## 验收

- [ ] 造 3 天消息 + pacing 计数 → `rebuild` 前写入侧 metrics 与 `rebuild` 后重算逐日一致；
- [ ] 两次 `rebuild` 的 `metrics` checksum 相同；
- [ ] 重发行（`_r1`）不计入 `msg_count`；
- [ ] `stats` 显示覆盖范围；无数据时显示「无」；
- [ ] mac 清单执行结果（截图或命令输出）；
- [ ] 24h 对比表（不足则标注），不改任何配置；
- [ ] 回归全绿；工具数仍 **28**。

## 依赖

- 依赖 ②（看板）以便人眼验证；但 R1 本身可独立实现。
- 24h 对比需要等时间，允许先归档代码部分、把对比表作为父任务收尾项。
