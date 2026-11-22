# metrics 三计数：raw / kept / delivered

## 问题

`metrics.msg_count` 只记**交付**条数（批处理 + 抑制之后），而 11-19 基线 624 条是**原始发送量**——口径不同，不能直接比较。昨天 24h 只有 25 条交付，看起来「消息量掉了 96%」，其实是口径差 + 负载不同。

## 需求

| 字段 | 定义 | 来源 |
|---|---|---|
| `raw_count` | 进入 dispatch 的每一条（含将被抑制/合并） | `collab-pacing.json` → `counters[day].raw` |
| `kept_count` | 未被抑制的条数（合并前） | `counters[day].kept` |
| `msg_count` | 实际交付（现有字段，语义不变） | 现有聚合 |

- 三者按日聚合；`noop_count` / `late_count` / `median_gap_ms` 语义不变。
- 投递侧在 `counters[day]` 新增 `raw` / `kept`（与 `noop` / `late` 同处）。
- `rebuild` 从 counters 重算；老数据缺字段 → **NULL**（不回填、不猜）。
- `collab_index { action:"metrics" }` 新增两列；NULL 显示 `-`。
- 口径写进文档：`raw ≥ kept ≥ msg_count`。

## 非目标

- 不改抑制/批处理行为；不回填历史；不改 `noop/late/median` 定义。

## 验收

- [ ] 10 条入 dispatch、2 条被抑制、8 条进窗口、合并成 3 条交付 → `raw=10, kept=8, msg_count=3`；
- [ ] `raw ≥ kept ≥ msg_count` 在同一日、且该日 counters 由 **0.10.x 全量计数**产生时成立（dispatch + 六个直投点：escalate / 冻结通知 / notifyRequester / ack / 重发 / 缺陷上报）；升级当天是部分计数，允许不成立并在文档中说明；
- [ ] `rebuild` 重算与写入侧逐日一致；两次 rebuild checksum 相同；
- [ ] 老数据（无 `raw/kept`）→ NULL，`metrics` 显示 `-`；
- [ ] 回归全绿；工具数仍 **29**（不新增工具）；
- [ ] 文档：`docs/collab.md` 指标口径、README、CHANGELOG。

## 变异

1. `raw_count` 只在「未抑制」时 +1 → `raw === kept`，用例必红；
2. 重算不回读 counters → `raw/kept` 为 0/NULL，用例必红。
