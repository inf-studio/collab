# 设计：0.9.x 复盘、看板契约与收尾

## 1. 总体

三步各自独立可回滚：

```
③ retro   → 纯文档（docs/issues/，零代码）
② board   → 快照加可选字段 + GUI/TUI 呈现（只读）
① close   → metrics 重算 + 机验/对账（不改既有工具语义）
```

## 2. retro：三份文档的结构

| 文件 | 必含 |
|---|---|
| `docs/issues/feat-collab-protocol-v2.md` | 0.9.x 七个版本各自「解决什么 / 关键取舍 / 被复核打回的点 / 遗留」；附证据数字（1752 测试、28 工具、实机 rebuild checksum 等） |
| `docs/issues/bugs-rebuild-drops-metrics.md` | 现象（rebuild 后 `metrics=0`）/ 复现命令 / 根因 / 修法（本批 ① 实现）/ 回滚 |
| `docs/issues/upstream-opencode-64788.md` | 上游 issue 链接、现象、我们的绕过（本机安装 + 按会话取 server client）、等待条件 |

统一约束：每节「现象 / 证据 / 影响 / 结论或修法」，**无占位空段**；数字必须能在本仓命令复现。

## 3. board：数据源与呈现

### 3.1 快照扩展（可选字段）

```ts
interface SessionRow {
  // …既有字段不变
  contract?: {
    mission?: { oneLine: string; state: string; confirmed: boolean };
    progress?: { lit: number; total: number; next?: string };
    todos?: { open: number; blocked: number; suspended: number; drifted: number };
    drift?: { drifted: boolean; reason?: string; since?: number };
  };
}
```

- 来源：`snapshot.ts` 读 `collab-contract/<sid>.json`（只读，缺失即省略）；
- **字段可选**：无契约的会话不产生该键，旧快照/远端缺字段时 UI 与 0.9.6 输出一致；
- 不新增 RPC、不改既有字段语义。

### 3.2 徽标规则（列表行，1 字符 + ≤3 位数字）

| 条件（优先级从上到下） | 徽标 | 颜色 |
|---|---|---|
| `drift.drifted` | `◇` | 红 |
| `todos.suspended + todos.drifted > 0` | `◐` | 琥珀 |
| `todos.open + todos.blocked > 0` | `◑` + 数量 | 蓝 |
| 有契约但都正常 | `●` | 灰 |
| 无契约 | 不显示 | — |

- 徽标插在**第二行末尾**，不新增行；
- 数量 >99 显示 `99+`；总宽度预算 ≤4 字符，断点测试保证 `≤640px` 单栏不换行。

### 3.3 详情区（右侧 / TUI 详情）

固定顺序，每项一行，缺省隐藏：

```
主线  排钟 B4 接线（已确认）
边界  做 排钟 / 不做 ws集群实施 → ses_edc3…
进度  M2/5 · 下一里程碑 M3「双写验证」需要 evidence
待办  3 open · 1 blocked · 1 suspended · 1 drifted
漂移  连续 6 轮无主线动作（11.2h）· 未处置
```

- GUI：放在会话头与图槽之间（`data-collab-slot="contract"`），无契约时整块不渲染；
- TUI：详情行追加一行 `主线 … · M2/5 · todo 3 · drift 11h`，超宽截断，不换行。

## 4. close：metrics 重算

### 4.1 数据源

| 指标 | 来源 | 口径 |
|---|---|---|
| `msg_count` | `collab-messages.jsonl` | 排除 `id` 匹配 `_r\d+$` 的重发行 |
| `median_gap_ms` | 同上 | 当日全部消息相邻间隔中位数（全机，与写入侧同一函数） |
| `noop_count` | `collab-pacing.json` 的 `counters[day].noop` | 当日累计 |
| `late_count` | 同上 `counters[day].late` | 当日累计 |

**复用写入侧同一聚合实现**（`metrics` 模块单一函数），避免两套口径。

### 4.2 行为

- `rebuild` 结束时按 `--sinceDays`（默认 180）范围内重算并 `UPSERT`；
- 幂等：同一输入两次 rebuild，`metrics` 表 checksum 相同；
- **覆盖范围澄清**：只重算消息日志里存在的日期；安装前的历史**不存在**，不伪造；`stats` 输出加一句「metrics 覆盖 <首日>–<末日>」。

### 4.3 机验与对账

- mac：重启 Desktop → `collab:active:v0.9.6` → `collab_index stats` 可用；
- 24h：拉 `metrics` 当日行，与 11-20 基线（16% 空转 / p50 20s / 67:1 / 漂移 10.8h）并排成表；不足 24h 标「不足」。

## 5. 兼容与回滚

| 场景 | 行为 |
|---|---|
| 无契约会话 | 快照不含 `contract`，UI 与 0.9.6 逐字节一致 |
| 旧快照/远端 | 缺字段 → 同「无契约」 |
| 契约文件损坏 | 读失败 → 省略字段 + 一条日志，不抛 |
| 回滚 board | `git restore -- src/core/snapshot.ts src/gui.tsx src/tui.tsx src/rpc.ts src/types.ts` |
| 回滚 close | `git restore -- src/core/index-db.ts src/core/index-sync.ts src/tools/store.ts` |

## 6. 测试

| 层 | 用例 |
|---|---|
| 快照 | 有/无契约、契约损坏、字段完整性；旧快照夹具逐字节一致 |
| GUI | 徽标优先级（drift > suspended > open）；`≤640px` 单栏不换行；详情顺序；无契约不渲染块 |
| TUI | 详情行包含主线/进度/todo/drift；超宽截断 |
| metrics | 重算 == 写入侧同函数结果；两次 rebuild checksum 相同；重发行不计入 |

变异（各至少 1 组）：
1. 徽标改成新增一行 → 布局断言必红；
2. 快照无条件写 `contract: {}` → 「无契约逐字节一致」必红；
3. 重算不排除 `_r\d+` → `msg_count` 断言必红。
