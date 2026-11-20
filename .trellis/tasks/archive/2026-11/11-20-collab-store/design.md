# 设计：消息历史 + SQLite 投影（0.9.0）

## 1. 边界

本版**只做存储与索引**，不改变任何协作语义。三件事：

1. 把每条收发消息写成一行 `Envelope`（append-only）；
2. 建一份可随时删除重建的 `collab.db`；
3. 读路径（看板/快照）优先读索引，缺索引时逐字节回落现有实现。

## 2. 模块划分

| 文件 | 职责 |
|---|---|
| `src/core/envelope.ts`（新） | `Envelope` 类型、序列化、分片（>1MB）、`sha256` |
| `src/core/store.ts`（新） | `appendMessage()` / `readMessages()`；损坏行跳过并计数 |
| `src/core/db-runtime.ts`（新） | 运行时探测 + 懒加载 + 单写者队列 + 重试 |
| `src/core/index-db.ts`（新） | DDL 装载、消息写入、`rebuild()` / `backfill()` / `indexSync()` / 锁、stats |
| `src/core/index-sync.ts`（新） | 投影的**同步部分**：DDL + 迁移、`syncRows()`、写穿镜像（`mirrorHandoff/Locks/Queue`）、新鲜度、`preferred*` 读路径 |
| `src/tools/index.ts` | 注册 `collab_index`（22 → 23） |
| `src/rpc.ts` / `src/core/snapshot.ts` | 读索引，失败回落 |

## 3. 数据结构

```ts
interface Envelope {
  v: 1;
  id: string; threadId?: string;
  from: string; to: string;
  sentAt: number; kind: 'request'|'reply'|'note'|'notify'|'ack';
  body: string;                       // 全文
  basedOn?: { repo?: Record<string,string>; env?: Record<string,string>; facts: number };
  grade: 'measured'|'inferred'|'relayed'|'unknown';
  factIds?: string[]; deltaOnly?: boolean;
  sha256?: string;                    // 仅超长时
  part?: { i: number; n: number };    // 分片
}
```

- 行分隔：`\n`；单行 ≤1MB，超出按 1MB 切片、同 `id` + `part` 连续写；
- 读：按 `id` 合并分片再解析；解析失败 → 跳过 + `warnCount++`（不抛）；
- 文件切换：`collab-messages.jsonl` 超过 256MB 轮转为 `…-1.jsonl`（读取时按序拼接）。

## 4. 数据库

DDL 见父 design §2.2（0.9.0 review 后已更新为实际落地版）。实现约束：

- `messages.body` 存**全文**；`messages_fts` 的索引体 = `body.slice(0, 8192)`（**字符**，CJK ≈ 24KB）；
- `messages.resend_of`：`_r<n>` 重发行记原 id，指标查询用 `WHERE resend_of IS NULL` 排除；
- FTS 用外部内容表（`content='messages'`），写入后 `INSERT INTO messages_fts(rowid, body) …`；
- `busy_timeout=5000`；每次写入 3 次指数退避（50/200/800ms）；
- 旧库升级：`ensureSchema()` 用 `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` 补增量列；
- 投影行同时保存 typed 列与原始 JSON（`handoffs.record_json` / `locks.record_json` / `queue.item_json`），
  读路径据此重建与 JSON 完全相同的对象。

## 5. 写入路径

```
投递成功（宿主已 admitted）
  ├─ appendMessage(jsonl)          // 真源先写；失败 → 记录日志并**跳过索引**（S2）
  ├─ indexInsert(row)              // 失败只记日志，不影响投递结果
  └─ 返回工具结果（逐字不变）
```

**顺序不可颠倒**：jsonl 是唯一真源；索引失败可以让看板暂时陈旧，不能让消息丢。
**偏差（review 后确认）**：写在 admitted 之后而不是之前 —— 宿主已经收下消息，此时报错会让调用方重发，
产生重复投递；写前落盘则会为被拒绝的投递留下幽灵行。

六个补充投递点（0.9.0 review）：`collab_escalate`（notify）、`collab_freeze` 通知（notify）、
`chain.notifyRequester`（note）、`chain.ackSeen`（ack，同 cid 只写一次）、`chain.resendIfDue`（request，`_r<n>`）、
`report.deliver`（note）。

## 6. rebuild

```
1. 读 jsonl（含轮转分片）+ collab-*.json
2. 建 collab.db.tmp，DDL + 全量 INSERT（单事务）
3. fsync(tmp)
4. rename(tmp → collab.db)
5. 输出 {messages, threads, handoffs, facts, todos, decisions, progress, ms}
```

幂等判据：同一输入两次 rebuild，`messages.count` 与每表 `checksum` 相同。
`--since <days>` 只重建最近 N 天（默认 180，永久库的缓解项）。

## 7. 降级

```ts
openDb() → { db } | null
```

- `null` 时：`indexInsert` 静默跳过、查询返回 `undefined`、看板 `[索引不可用]`；
- **读路径不建库**：库文件不存在时 `preferred*` 直接 `undefined`（一次只读不会再留下 `collab.db` / `-shm`）；
  mirror 在库没有 schema 时静默跳过，不刷日志；
- 探测结果缓存到进程生命周期；`storage: 'json'` 配置直接返回 `null`（永不 import）；
- 任何 `db.exec`/`prepare` 抛错 → 记一次日志，后续调用直接走降级（熔断）。

## 8. 读路径切换（0.9.0 review 后实现）

`index-sync.ts` 提供 `preferredHandoffs/Broadcasts/Locks/Queue/Queue(from)`，`snapshot.ts` / `index.ts` /
`tools/status.ts` / `tools/threads.ts` 先问投影、拿不到再读 JSON（`?? allBroadcasts()` 等）。

- **可用判据（按源）**：`meta.full_sync_at` 存在，且该源的
  `synced_broadcasts / synced_locks / synced_queue / synced_threads ≥ 该源文件 mtime`。
  一个源被改过 → 只回落该源；另一个源的水位不受影响（P1-3）。
- **写穿（异步合并）**：`writeBroadcast` / `writeLock` / owner-queue 只入队，`flushMirrors()` 在 0ms tick 应用；
  写路径不等 `busy_timeout`（S11）。
- **等价性**：投影保存原始 JSON，读出的对象与 JSON 路径逐字段相同；测试断言 locks/handoffs/queue
  三条列表深度相等，并用「reader 丢掉 priority」的变异证明断言可失败。
- **边界**：`sessions` 表不参与看板（宿主实时会话列表更准）；`collab_status` 的 `replies/receipt/decisions/blocked`
  仍来自记录本身（`record_json` 原样）。

## 9. 回填

`collab_index backfill`（独立子命令，`rebuild` 不自动跑）：

- `collab-broadcast/*.json` → `handoffs`（含 origin / workspace / priority / claim / archived 等）；
- `collab-threads.json` → `threads`（`kind` / `lastAt` / `preview` / `bid`）；
- `collab-locks/` → `locks`、`collab-owner-queue/` → `queue`（当前状态）；
- 宿主实测 thread 数会增长（**50**），fixture 固定 49；
- 正文不可得 → **`messages` 不写入**（不伪造）；`meta.backfilled=1` + `backfilled_at` 记「历史不完整」。

## 10. 测试

`test/store-rebuild.mjs`（30 项）覆盖：

| 用例 | 断言 |
|---|---|
| 工具面 | `collab_index` 注册一次；工具数 23；版本一致 |
| 降级开关 | `storage:"json"` 时 stats/rebuild 都拒绝且**未 import** sqlite |
| 分片 / 编码 | 1.5MB → 2 行；引号 / CJK / 换行三种 1MB 边界，**编码后**每行 ≤1MB |
| 重建幂等 | 两次 rebuild 每表 checksum 与行数相同；`sent_at` 与信封一致 |
| 坏行 | 非法 JSON 行 → 成功且计数 = 正常行数 |
| 真源失败（S2） | jsonl 写失败 → 不写索引（甚至不建库） |
| 新装可用（B2） | 全新目录写一条 → `stats.available === true` |
| 降级 / 熔断 | 坏库 → 不可用不抛；注入驱动抛错 → 第二次直接降级 |
| 只跑 rebuild（P1-1） | 不调 `indexSync` / 不投递 → `meta.schema=1`，`preferredBroadcasts` 命中 |
| 只读不建库（P1-2） | 冷启动只读 + 3 次写广播 → 无 `collab.db*`、0 条 mirror 日志 |
| 按源水位（P1-3） | 他人写 locks + 本进程 mirror handoff → locks 读者仍回落 |
| 读路径（R5） | 索引路径真的命中；与 JSON 路径 locks/handoffs/queue 逐字段相等；源文件 mtime 超过水位 → 回落 JSON |
| 并发 | 单 rebuild 锁；子进程写 40 条 + 6 次并发 rebuild → 40 行零丢失 |
| 回填 | handoffs=24、threads=49；`meta.backfilled=1`；不伪造 messages 行 |

`test/delivery-history.mjs`（9 项）：六个补充投递点各 1 行、kind 正确、ack 同 cid 不重复；
重发行 `resend_of=原 id`，`resend_of IS NULL` 的指标口径可排除它（S10）。

变异（必须红，实测见任务报告）：
1. `rebuild` 把 `sent_at` 写成 `Date.now()` → 幂等 checksum + `sent_at` 断言红；
2. 索引 reader 丢 `priority` → R5 等价断言红；
3. 去掉 rebuild 锁等待 / inode 校验 → 并发用例 40 行掉到 24 行；
4. rebuild 不写 `meta.schema` → P1-1 红（schema=undefined）；
5. mirror 顺手推进 locks 水位（旧全局水位）→ P1-3 红（locks 被当新鲜供出）。

## 11. 回滚

```bash
rm -f ~/.config/opencode/collab.db* ~/.config/opencode/collab-messages*.jsonl
git restore -- src/core/envelope.ts src/core/store.ts src/core/db-runtime.ts \
  src/core/index-db.ts src/core/backfill.ts src/tools/index.ts src/rpc.ts src/core/snapshot.ts
rm -f src/core/envelope.ts src/core/store.ts src/core/db-runtime.ts src/core/index-db.ts src/core/backfill.ts
```
