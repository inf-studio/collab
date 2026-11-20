# 设计：收尾（metrics 重算 + 机验 + 24h 对比）

## 1. 边界

- 只改 `rebuild` 的**派生表重算**与测试健壮性；不改投递语义、不改指标口径。
- 24h 对比是**操作步骤**，不是代码；数据不足时如实标注。

## 2. metrics 重算

### 2.1 单一聚合入口

现状：投递侧通过 `upsertMetrics` 增量写单日行。重算必须复用**同一个聚合函数**，避免两套口径：

```
aggregateDay(messagesOfDay, pacingCountersOfDay) -> { day, msg_count, median_gap_ms, noop_count, late_count }
```

- `msg_count`：排除 `id` 匹配 `_r\d+$` 的重发行；
- `median_gap_ms`：当日相邻消息间隔中位数（与写入侧同一实现）；
- `noop_count` / `late_count`：从 `collab-pacing.json` 的 `counters[day]` 读取（投递侧唯一写点）。

### 2.2 触发

`rebuild` 完成业务表后：

```
for day in aggregateDayRange(messages, sinceDays):
  upsertMetrics(aggregateDay(...))
```

- `sinceDays` 默认 180（`0` = 不限）；
- 幂等：同一输入两次 rebuild，`metrics` 表 checksum 相同；
- 重算**只覆盖日志中存在的日期**；安装前不存在，不伪造。

### 2.3 覆盖范围可见

`collab_index stats` 增加一行：

```
metrics 覆盖 2026-11-20–2026-11-21（2 天）
```

无数据 → `metrics 覆盖 无`。

## 3. 测试健壮性（R5）

`test/pacing.mjs` 的「不创建真实 `collab-pacing.json`」改为**前后快照**：

```
before = stat(real pacing file)   // 可能不存在，也可能存在（插件在跑）
... run suite ...
after  = stat(real pacing file)
assert same(before, after)        // size + mtimeMs
```

与 0.9.0 B1 的隔离断言同一写法；这样在任何机器上都可绿。

## 4. 机验与对账（操作）

| 步骤 | 命令/判据 |
|---|---|
| mac 重启 | Desktop 重启后 `collab:active:v0.9.6` |
| 索引可用 | `collab_index { action:"stats" }` → `索引可用` |
| rebuild 幂等 | 连续两次 `rebuild`，`messagesChecksum` 相同 |
| metrics 覆盖 | `stats` 出现覆盖范围 |
| 24h 对比 | 拉 `metrics` 当日行，与 11-20 基线并排；不足 24h 标「不足」 |

## 5. 兼容与回滚

- 旧库无 `metrics` 行 → 重算补上；无 `collab-pacing.json` → `noop/late = 0`；
- 坏 jsonl 行 → 跳过（沿用 0.9.0 行为）；
- 回滚：`git restore -- src/core/index-db.ts src/core/index-sync.ts src/tools/store.ts test/pacing.mjs`。

## 6. 变异

1. 重算不排除 `_r\d+$` → `msg_count` 断言必红；
2. 重算不读 pacing 计数 → `noop_count` 断言必红；
3. `stats` 不输出覆盖范围 → 断言必红。
