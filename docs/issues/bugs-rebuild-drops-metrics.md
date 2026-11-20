# `collab_index rebuild` 会清空 `metrics` 日计数

- 状态: open（本批任务 `11-21-collab-0p9-close` 修复）
- 范围: 后端（`src/core/index-db.ts` / `index-sync.ts` / `src/tools/store.ts`）
- 关联: 0.9.0 `collab-store`；0.9.6 `collab-pacing`（`metrics` 写入方）
- 影响版本: **0.9.6 起**（`metrics` 表随 0.9.6 引入；`rebuild` 本身自 0.9.0 存在）

## 现象

`collab_index rebuild` 之后，`metrics` 表从有行变成 0 行。实机（2026-11-20，0.9.6）：

```
$ collab_index { action:"stats" }          → … metrics=1
$ collab_index { action:"rebuild", confirm:true }  → 已重建（94ms）
$ collab_index { action:"stats" }          → … metrics=0
```

## 复现

```bash
# 1) 先制造一些投递，让写入侧落一行 metrics
# 2) 读 stats：应有 metrics=1
# 3) 跑 rebuild（confirm:true）
# 4) 再读 stats：metrics=0
```

（`test/store-rebuild.mjs` 的幂等用例只比对 `rebuild` 两次之间的一致性，因此这条不会变红。）

最小复现脚本（临时目录，不碰真实配置）：

```js
import { upsertMetrics, indexStats, rebuildIndex } from "dist/index.js";
upsertMetrics({ day: "2026-11-21", msg_count: 3 });
const before = indexStats();          // metrics = 1
rebuildIndex({ confirm: true });
const after = indexStats();           // metrics = 0  ← 缺陷
```

## 根因

`rebuild` 只从 `collab-messages.jsonl` 与 `collab-*.json` 重建**业务表**，`metrics` 是投递侧增量写入的派生表，不在重建源里；`rebuild` 用临时库整体替换，于是旧 `metrics` 行随之消失。

## 影响

- 在 D15「全局单库 + 永久保留」的策略下，**历史指标不可追溯**：每次 rebuild 都会丢掉日聚合。
- 不影响协作功能（消息、契约、决策、事实都在 JSON 真源里）。

## 修法（本批 ① 实现）

在 `rebuild` 结束时按参数 `sinceDays`（默认 180）重算并 `UPSERT`：

| 字段 | 来源 | 口径 |
|---|---|---|
| `msg_count` | `collab-messages.jsonl` | 排除 `id` 匹配 `_r\d+$` 的重发行 |
| `median_gap_ms` | 同上 | 当日相邻消息间隔中位数（复用写入侧同一函数） |
| `noop_count` | `collab-pacing.json` 的 `counters[day].noop` | 当日累计 |
| `late_count` | 同上 `counters[day].late` | 当日累计 |

约束：
- **幂等**：同一输入两次 rebuild，`metrics` 表 checksum 相同；
- **不伪造**：只重算消息日志里存在的日期，安装前的历史不存在；`stats` 输出「metrics 覆盖 <首日>–<末日>」或「无」；
- 重算与写入必须调用**同一个聚合函数**，避免两套口径。

## 回滚

```bash
git restore -- src/core/index-db.ts src/core/index-sync.ts src/tools/store.ts
```
