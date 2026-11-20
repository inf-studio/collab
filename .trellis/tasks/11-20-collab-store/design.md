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
| `src/core/index-db.ts`（新） | DDL、写入、查询、`rebuild()` |
| `src/core/backfill.ts`（新） | 24 handoff + 49 thread 状态级回填 |
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

DDL 见父 design §2.2，逐字一致。补充实现约束：

- `messages.body` 存**全文**；`messages_fts` 的索引体 = `body.slice(0, 8192)`；
- FTS 用外部内容表（`content='messages'`），写入后 `INSERT INTO messages_fts(rowid, body) …`；
- `busy_timeout=5000`；每次写入 3 次指数退避（50/200/800ms）。

## 5. 写入路径

```
dispatch 成功
  ├─ appendMessage(jsonl)          // 先写真源，失败即返回错误（不投递）
  ├─ indexInsert(row)              // 失败只记日志，不影响投递结果
  └─ 返回 messageID
```

**顺序不可颠倒**：jsonl 是唯一真源；索引失败可以让看板暂时陈旧，不能让消息丢。

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
- 探测结果缓存到进程生命周期；`storage: 'json'` 配置直接返回 `null`（永不 import）；
- 任何 `db.exec`/`prepare` 抛错 → 记一次日志，后续调用直接走降级（熔断）。

## 8. 读路径切换

`snapshot.ts` / `board.ts` 新增 `readFromIndex()`：

1. 索引可用 → 查最近 N 条 + thread 聚合；
2. 否则 → 走现有 JSON 路径（逐字节等价，测试用快照对比）；
3. 两条路径输出必须**完全一致**（同一组输入下 diff 为空）。

## 9. 回填

`collab_index backfill`（独立子命令，`rebuild` 不自动跑）：

- `collab-broadcast/*.json` → `handoffs`（bid/from/claim/state/title/时间/threadID）；
- `collab-threads.json` → `threads`（含 `kind`、`lastAt`、`preview`）；
- 正文不可得 → `messages` 不写入；`meta.backfilled_at` 记时间。

## 10. 测试

| 用例 | 断言 |
|---|---|
| 重建幂等 | 两次 rebuild 每表 checksum 相同 |
| 坏行 | jsonl 插一行非法 JSON → 成功且计数 = 正常行 |
| 分片 | 1.5MB body → 2 行，读回全文一致，FTS 只索引前 8KB |
| 降级 | `storage:'json'` → 不 import sqlite（断言模块未加载） |
| 熔断 | 第 1 次 exec 抛错 → 第 2 次直接降级，不重复抛 |
| 并发 | 3 进程 × 100 条 → 300 条无丢失无重复 |
| 读路径等价 | 索引开/关两次快照 diff 为空 |
| 回填 | handoffs=24、threads=49 |

变异（必须红）：
1. rebuild 不写 `sent_at` → 幂等 checksum 变化；
2. FTS 索引体改成全文 → 分片用例的索引体积断言失败；
3. 降级路径仍 import sqlite → "未加载"断言失败。

## 11. 回滚

```bash
rm -f ~/.config/opencode/collab.db* ~/.config/opencode/collab-messages*.jsonl
git restore -- src/core/envelope.ts src/core/store.ts src/core/db-runtime.ts \
  src/core/index-db.ts src/core/backfill.ts src/tools/index.ts src/rpc.ts src/core/snapshot.ts
rm -f src/core/envelope.ts src/core/store.ts src/core/db-runtime.ts src/core/index-db.ts src/core/backfill.ts
```
