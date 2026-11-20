# 设计：会话契约与协作根治（0.9.x）

## 1. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│ 人类层   决策清单 / 看板 / 主线交接（不再当路由器）              │
├─────────────────────────────────────────────────────────────┤
│ 任务层   contract: mission · plan(里程碑) · todos(含挂起)      │
├─────────────────────────────────────────────────────────────┤
│ 语义层   facts(证据等级) · settle / invalidate · glossary      │
├─────────────────────────────────────────────────────────────┤
│ 传输层   envelope(sentAt/basedOn/grade) · 批量 · 无增量不发     │
└─────────────────────────────────────────────────────────────┘
     三个强制点：每轮注入 · 协作闸门 · 进度派生（只认证据）
```

**核心原则**：消息只是事件，事实只存账本；每条消息必须带版本，接收方按版本决定「回不回、回多少」。

## 2. 存储：JSON 真源 + SQLite 可重建投影（D13/D18）

### 2.1 真源（append/原子替换，沿用现有单写者模型）

```
~/.config/opencode/
  collab-messages.jsonl        # 新增：append-only，一行一个信封
  collab-contract/<sid>.json   # 新增：会话契约（五面）
  collab-facts.json            # 新增：事实账本（工作区级，D4）
  collab-todos/<sid>.json      # 新增：待办（含挂起）
  collab-decisions/<thread>.json # 新增或并入 contract
  collab-broadcast/*.json      # 现状不变
  collab-threads.json          # 现状不变
  collab.db                    # 投影（可删可重建）
```

### 2.2 SQLite schema（0.9.0 实际落地）

0.9.0 的 `collab.db` 是**可删除重建的投影**：typed 列供查询，`*_json` 列保存原始对象，
读路径据此重建出与 JSON 完全相同的对象（与 `messages.envelope` 同一做法）。

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
--  meta: schema / rebuilt_at / rebuilt_ms / source_messages / backfilled /
--        backfilled_at / full_sync_at / synced_broadcasts / synced_locks /
--        synced_queue / synced_threads
--  full_sync_at       = 最近一次**全量** sync（rebuild / backfill / indexSync）；
--                       只有它存在才允许读索引（镜像只证明单表新鲜，不证明完整）
--  synced_<source>    = 该源自己的水位；读者只跟自己那一源比。一个源的写入
--                       不会让另一个源的陈旧行看起来新鲜（0.9.0 review P1-3）

CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, directory TEXT, agent TEXT,
                       first_at INTEGER, last_at INTEGER, archived_at INTEGER);

CREATE TABLE threads (id TEXT PRIMARY KEY, from_sid TEXT, target_sid TEXT, kind TEXT,
                      opened_at INTEGER,
                      state TEXT CHECK (state IN ('open','answered','closed')),
                      close_reason TEXT, preview TEXT, last_at INTEGER, bid TEXT);

CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT, from_sid TEXT, to_sid TEXT,
                       sent_at INTEGER, delivered_at INTEGER, kind TEXT,
                       body TEXT, body_len INTEGER,            -- body=全文；FTS 仅索引前 8KB
                       based_on TEXT,                          -- JSON {repo,env,facts}
                       grade TEXT CHECK (grade IN ('measured','inferred','relayed','unknown')),
                       fact_ids TEXT,
                       resend_of TEXT,                         -- _r<n> 重发行的原 id（指标可排除）
                       envelope TEXT);
CREATE INDEX idx_msg_thread ON messages(thread_id, sent_at);
CREATE INDEX idx_msg_to     ON messages(to_sid, delivered_at);
CREATE INDEX idx_msg_from   ON messages(from_sid, sent_at);
CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='rowid');

CREATE TABLE facts (id TEXT PRIMARY KEY, claim TEXT, grade TEXT, evidence TEXT,
                    state TEXT CHECK (state IN ('active','superseded','retracted')),
                    based_on TEXT, by_sid TEXT, at INTEGER, superseded_by TEXT, scope TEXT);

CREATE TABLE todos (id TEXT PRIMARY KEY, sid TEXT, kind TEXT, subject TEXT,
                    status TEXT CHECK (status IN ('open','doing','blocked','suspended','closed','dropped')),
                    blocking_on TEXT, parked_by TEXT, parked_at INTEGER, wake_when TEXT,
                    since INTEGER, closed_at INTEGER, evidence TEXT);

CREATE TABLE decisions (id TEXT PRIMARY KEY, thread_id TEXT, bid TEXT, question TEXT,
                        options TEXT, owner TEXT,
                        status TEXT CHECK (status IN ('open','answered','superseded')),
                        answer TEXT, by_sid TEXT, at INTEGER);

CREATE TABLE handoffs (bid TEXT PRIMARY KEY, from_sid TEXT, claim_by TEXT,
                       state TEXT CHECK (state IN ('open','claimed','acked','done','blocked','expired')),
                       title TEXT, created_at INTEGER, updated_at INTEGER, thread_id TEXT,
                       origin_sid TEXT, workspace TEXT, priority TEXT, frozen INTEGER,
                       claim_kind TEXT, preview TEXT, archived_at INTEGER,
                       claim_json TEXT, expired_claim_json TEXT, record_json TEXT);

CREATE TABLE locks (id TEXT PRIMARY KEY, scope TEXT, sid TEXT, mode TEXT,
                    at INTEGER, expires_at INTEGER, reason TEXT, record_json TEXT);

CREATE TABLE queue (id TEXT PRIMARY KEY, target_sid TEXT, from_sid TEXT, at INTEGER,
                    priority TEXT, summary TEXT, seen INTEGER, issue_path TEXT,
                    bid TEXT, revoked_at INTEGER, item_json TEXT);

CREATE TABLE progress (sid TEXT, milestone TEXT, title TEXT, done INTEGER, evidence TEXT,
                       at INTEGER, PRIMARY KEY(sid, milestone));

CREATE TABLE metrics (day TEXT PRIMARY KEY, msg_count INTEGER, fact_count INTEGER,
                      retract_count INTEGER, idle_count INTEGER, drift_ms INTEGER,
                      median_gap_ms INTEGER);
```

- **CHECK 已落地**：`messages.grade`、`handoffs.state`、`threads.state`、`facts.state`、
  `todos.status`、`decisions.status`。`todos.wake_when` 的「suspended 必填」仍是应用层校验（0.9.1 写这张表时补）。
- **增量列迁移**：`CREATE TABLE IF NOT EXISTS` 不会给旧库加列，`ensureSchema()` 按
  `PRAGMA table_info` 逐列 `ALTER TABLE … ADD COLUMN`（`sessions.archived_at` / `threads.preview,last_at,bid` /
  `handoffs.*` / `locks.reason,record_json` / `queue.seen,issue_path,bid,revoked_at,item_json`）。
- **0.9.0 不写的表**：`facts` / `todos` / `decisions` / `progress` / `metrics`（0.9.1+），
  `collab_index stats` 明确标注「本版不写入」而不是只打印 0。
- `sessions` 由 `rebuild` / `indexSync({sessions})` 填充，**不参与看板**：看板的会话块来自宿主的
  实时 `session.list`（索引只会更旧）；它供后续查询/指标使用。

### 2.3 重建

`collab_index rebuild`：全量读 `collab-messages.jsonl` + `collab-*.json` → 写入 `collab.db.tmp` → `fsync` → 原子重命名。

- 幂等：同一输入两次重建结果逐字节一致（测试断言：行数 + 每表 checksum）；
- 失败：保留旧 `collab.db`，返回可读错误；
- 增量：正常写路径边写 jsonl 边 `INSERT`，失败只记日志不阻断协作。

### 2.4 并发与降级

- 写入串行化：单进程内一个 Promise 队列；跨进程靠 WAL + busy_timeout + 3 次指数退避；
- **mirror 异步**：写穿只排队（0ms 合并），由写路径之外应用 —— 写广播/租约/队列不等 SQLite；
- **只读不建库**：`preferred*` 在 `collab.db` 不存在时返回 `undefined`，`openDb` 不会被读路径触发建库；
- **rebuild 互斥**：`<dbPath>.lock`（`open("wx")`，含 pid/时间，60s 判陈旧）；写方在锁存在时短暂等待
  （≤3s）再写，避免 rename 与写入交错；
- **换库检测**：`openDb` 的缓存记住 `stat(path).ino`，rename 后 inode 变化即关闭重开——
  否则写入会落到已被 unlink 的旧 inode（实测 40 条丢 16 条）；rebuild 结束后再做一次 jsonl 增量回放；
- 运行时探测：`typeof Bun !== 'undefined' ? bun:sqlite : node:sqlite`（动态 import）；
- **任何 DB 异常 → 降级纯 JSON**：工具仍可用，看板显示 `[索引不可用]`；
- GUI 入口不 import 存储模块（`--conditions=browser` 下不得触发）。

**spike 结论（2026-11-20，/tmp/opencode/sqlite-spike）**：

| 检查 | 结果 |
|---|---|
| `vp pack` 打包 | ✅ 成功，`import("bun:sqlite")` / `import("node:sqlite")` **原样保留**，无 external 报错 |
| node 运行时 | ✅ 建库 / 写入 / 查询 / FTS5 MATCH 命中 |
| bun 运行时 | ✅ 同上 |
| JSON 模式 | ✅ `sqliteImported:false`，懒加载，从不 import |

→ 走推荐路径（双后端）；`bun-only+Node 降级` 作为失败退路保留未启用。`engines.node >= 22.18` 下 `node:sqlite` 无需 `--experimental-sqlite`（22.13+ 已解除 flag）。

### 2.5 回填（D 轮决策：状态级）

- 24 条 handoff → `handoffs`；thread 索引 → `threads`（宿主实测 **50**，fixture 49）；locks / queue 当前状态一并入表；
- 正文不可得（插件历史上未存）：**不写 `messages` 行**（不伪造），`meta.backfilled=1` +
  `meta.backfilled_at` 标记「历史不完整」；
- 指标从回填日重新起算基线（不伪造历史）。

## 3. 消息信封（传输层）

```ts
interface Envelope {
  id: string;                 // msg_…
  threadId?: string;
  from: string; to: string;
  sentAt: number;
  kind: 'request' | 'reply' | 'note' | 'notify' | 'ack';
  body: string;
  basedOn: { repo?: Record<string,string>; env?: Record<string,string>; facts: number };
  grade: 'measured' | 'inferred' | 'relayed' | 'unknown';
  factIds?: string[];
  deltaOnly?: boolean;
}
```

### 3.1 接收侧三态（0.9.4 实现）

| 判定 | 条件 | 动作 |
|---|---|---|
| `fresh` | `basedOn` ≥ 本地，或缺失（D2） | 正常处理 |
| `stale` | 本地更新 | 只回增量 + 新基线，**禁止重述事实** |
| `conflict` | 双方分叉 | 升决策（0.9.5），不进对话循环 |

`unknown`（无 `basedOn`）→ 按 `fresh` 处理 + 注入 `[基线未知]`。

## 4. 会话契约（任务层）

```ts
interface Contract {
  sid: string;
  mission: {
    taskPath?: string; oneLine: string;
    inScope: string[]; outOfScope: string[];
    handoffTo: Record<string, string>;
    state: 'active' | 'idle' | 'suspended' | 'done';
    confirmedBy?: string;      // 人类确认一次后固定（D7）
  };
  plan: {
    milestones: { id: string; title: string; done: boolean;
                  evidence?: string; at?: number }[];
    lastAdvancedAt: number;    // 只被 evidence 推进（D20）
  };
  todos: Todo[];
  peers: { sid: string; role: 'requester'|'implementer'|'decider'|'verifier';
           threadId?: string; since: number }[];
}
```

- 真源 `collab-contract/<sid>.json`（D18）；
- `mission.taskPath` 来自 `task.py current`；无任务时用会话首条人类指令生成，**必须人类确认一次**（`collab_mission confirm`），之后不可被注入覆盖；
- `plan.lastAdvancedAt` 只接受 `collab_progress M# --evidence <commit|test|decision>`；evidence 需 `task.json` 或 `git log` 可校验（D21）。
- **0.9.5 合并点**：0.9.1 的 `decision:<id>` 读 hand-off 的 `decisions[]`；独立决策账本（0.9.5）上线后必须合并为
  **单一 resolver**（账本优先、hand-off 兼容输入），不要留两套判定。


## 5. 注入格式（每轮，硬上限 12 行，四段）

```
[mission] 排钟 B4 接线 · .trellis/tasks/11-19-b4-wiring
  边界: 做 排钟 / 不做 ws集群实施 → 转 ses_edc3…  · 状态 active · 推进于 3.1h 前
[progress] M2/5 · 下一里程碑 M3「双写验证」需要 evidence
[todo] 3 open · 2 需要你 · 1 等 ses_e176… · 最老 T2 6.2h
  T2 decide dev/prod 键空间 → 等 owner
  T3 reply  t_mwnmtb97 D1 记入 PRD → 可执行
[drift] 连续 6 轮无主线动作（11.2h）→ 三选一：继续 / 记阻塞 / 建 next-up
```

规则：
- 每段 ≤3 行，todo 只列 top3 + 计数；四段上限之和 11，预留 1 行给后续版本；
- **没有 `[scope]` 段**：0.9.2 起插件不做任何文本匹配，边界判断发生在 `collab_accept`（见 §6）；
- `[drift]` 仅在触发时出现；
- 所有段**每轮重新计算**，不写 `injected[]`、不注销（与 0.5.x 的一次性注入不同）。

## 6. 闸门（0.9.2，模型表态制）

**插件零文本匹配、零语义推断**——不给别名、不做子串、不调模型。判断由会话自己的模型在接单那一刻作出，插件负责逼它表态并留痕。

| 动作 | 规则 |
|---|---|
| `accept`（`outOfScope` 非空） | 必须带 `scopeCheck:{inScope:boolean, reason?}`；缺失 → 拒绝并回两种可复制调用；`inScope:false` → 拒绝 + `handoffTo` + audit；`inScope:true` → 接单 + audit |
| `accept`（无契约 / `outOfScope` 为空） | 不需要表态，行为与 0.9.1 逐字节一致 |
| `broadcast/handoff` | **永不要求表态、永不拒绝**（派活是清账手段） |
| `reply/send` | 不校验（回复不扩大边界） |
| 溢出 | `open collab ≥ 8` **只加一行提醒，不拦任何动作** |
| `override` | `{reason, approvedBy}`，`approvedBy` 不得以 `ses_` 开头；通过 → audit（`verifiedBy:'override'`） |
| `gate` 三档 | `enforce`（默认）/ `warn`（只提示）/ `off`（不校验、不写 audit） |
| 拒绝副作用 | 记录**逐字节不变**、无 claim、无 lock、`asked/attempts` 不变 |

诚实边界：插件拦不住 bash 层跨仓写，只能拦协作动作；实测漂移 90% 经协作层进入，故优先级正确。

## 7. 漂移判定（0.9.3）

```
drift 触发 = (连续 N 轮无 mainline evidence) OR (主线挂起 > 2h)
N = 5（D8）
```

- 「mainline evidence」= 该轮内 `progress` 点亮 / mainline todo 关闭 / 提交触及 `mission.taskPath`；
- 触发后强制三选一并落 `contract.mission.state`：`继续`（需给下一步）/ `blocked`（需给阻塞方）/ `done`（必须建 next-up 占位）；
- `suspended` 且 `wake_when` 到期未醒 → 转 `drifted`（D17：24h）。

## 8. 两处偏离推荐的代价（D9 / D15）

| 决策 | 选择 | 代价 | 缓解 |
|---|---|---|---|
| D9 决策上限 | 3 条（推荐 2） | 注入头多 1 行；同时开 3 个议题时对齐成本略高 | 超过 3 条仍硬拒；看板显示"最早 open"提醒 |
| D15 保留 | 全局单库永久 | 体积无上限，rebuild 变慢 | ① jsonl 存全文（超长按 1MB 分片），`messages.body` 存全文但 **FTS 索引体截 8KB**；② 每月 `VACUUM`；③ 提供 `collab_index export --before <date>` 归档导出；④ `rebuild` 只重建最近 180 天，更早走冷表 |

## 9. 兼容与迁移

| 场景 | 处理 |
|---|---|
| 旧版无 envelope 的消息 | 包一层 `grade:'unknown'`、`basedOn` 缺失，按 fresh 处理（D2） |
| 未升级对端 | 收：降级为原文；发：正文不变，附 `collab-envelope:v1` 尾注（对端忽略即可） |
| 现有 JSON | 不动；新增文件与旧文件并存 |
| 删库 | 所有工具可用，仅看板退化为现有快照路径 |
| 工具数 | 22 → 28（新增 `collab_index`、`collab_mission`、`collab_progress`、`collab_todo`、`collab_fact`、`collab_decide`；0.9.2/0.9.3/0.9.6 只改既有工具行为，不增工具） |

## 10. 测试策略

| 层 | 用例 |
|---|---|
| 存储 | 重建幂等（两次 checksum 相同）；坏 jsonl 行跳过；DB 不可用降级；并发 3 进程写不丢行 |
| 信封 | 三态判定各 1 例；`unknown` 按 fresh；stale 回复长度 ≤30% 原文 |
| 契约 | task.py 优先；确认一次后不被覆盖；progress 无 evidence 不点亮 |
| 注入 | 五行段配额 ≤12；top3 + 计数；无 drift 时不出现 `[drift]` |
| 闸门 | outOfScope 拒绝 + 给 handoffTo；override 通过且 audit；overflow 拒单 |
| 漂移 | 5 轮触发；2h 挂起触发；三选一必须落账 |
| 决策 | 同问去重；owner 独占关闭；第 4 条被拒 |

变异验证（每组至少 1 个「改坏 → 断言必须失败」）：
- 注入去重改回 `injected[]` → 重放测试必须红；
- `lastAdvancedAt` 改成接受任意轮 → drift 测试必须红；
- scope 校验取反 → 越界用例必须红；
- rebuild 不写 `sent_at` → 幂等 checksum 必须变。

## 11. 回滚（逐版）

| 版本 | 回滚 |
|---|---|
| 0.9.0 | 删 `collab.db` + `collab-messages.jsonl`；`git restore -- src/core/{store,index-db}.ts src/rpc.ts` |
| 0.9.1 | 删 `collab-contract/`；restore `src/hooks/context.ts` |
| 0.9.2 | restore `src/tools/{accept,broadcast}.ts src/core/gate.ts` |
| 0.9.3 | restore `src/core/drift.ts src/tools/todo.ts` |
| 0.9.4 | 删 `collab-facts.json`；restore `src/core/facts.ts` |
| 0.9.5 | 删 `collab-decisions/`；restore `src/tools/decisions.ts` |
| 0.9.6 | restore `src/core/dispatch.ts`（批量窗口） |

回滚一律**按显式文件清单**，禁止 `git restore .`。
