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

### 2.2 SQLite schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE meta        (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE sessions    (id TEXT PRIMARY KEY, title TEXT, directory TEXT,
                          agent TEXT, first_at INTEGER, last_at INTEGER);

CREATE TABLE threads     (id TEXT PRIMARY KEY, from_sid TEXT, target_sid TEXT,
                          kind TEXT, opened_at INTEGER, state TEXT, close_reason TEXT);

CREATE TABLE messages    (id TEXT PRIMARY KEY, thread_id TEXT,
                          from_sid TEXT, to_sid TEXT,
                          sent_at INTEGER, delivered_at INTEGER,
                          kind TEXT, body TEXT, body_len INTEGER,  -- body=全文；FTS 仅索引前 8KB
                          based_on TEXT,            -- JSON {repo,env,facts}
                          grade TEXT,               -- measured|inferred|relayed|unknown
                          fact_ids TEXT,            -- JSON array of F#
                          envelope TEXT);           -- 原始信封（截断前的 hash + 头）
CREATE INDEX idx_msg_thread ON messages(thread_id, sent_at);
CREATE INDEX idx_msg_to     ON messages(to_sid, delivered_at);
CREATE INDEX idx_msg_from   ON messages(from_sid, sent_at);

CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='rowid');

CREATE TABLE facts       (id TEXT PRIMARY KEY, claim TEXT, grade TEXT, evidence TEXT,
                          state TEXT,                -- active|superseded|retracted
                          based_on TEXT, by_sid TEXT, at INTEGER, superseded_by TEXT,
                          scope TEXT);               -- workspace（D4）

CREATE TABLE todos       (id TEXT PRIMARY KEY, sid TEXT, kind TEXT,  -- mainline|collab
                          subject TEXT, status TEXT,               -- open|doing|blocked|suspended|closed|dropped
                          blocking_on TEXT, parked_by TEXT, parked_at INTEGER,
                          wake_when TEXT,           -- JSON {kind,ref,at}（D16 必填于 suspended）
                          since INTEGER, closed_at INTEGER, evidence TEXT);

CREATE TABLE decisions   (id TEXT PRIMARY KEY, thread_id TEXT, bid TEXT,
                          question TEXT, options TEXT, owner TEXT,
                          status TEXT,              -- open|answered|superseded
                          answer TEXT, by_sid TEXT, at INTEGER);

CREATE TABLE handoffs    (bid TEXT PRIMARY KEY, from_sid TEXT, claim_by TEXT,
                          state TEXT, title TEXT, created_at INTEGER,
                          updated_at INTEGER, thread_id TEXT);

CREATE TABLE progress    (sid TEXT, milestone TEXT, title TEXT, done INTEGER,
                          evidence TEXT, at INTEGER, PRIMARY KEY(sid, milestone));

CREATE TABLE metrics     (day TEXT PRIMARY KEY, msg_count INTEGER, fact_count INTEGER,
                          retract_count INTEGER, idle_count INTEGER,
                          drift_ms INTEGER, median_gap_ms INTEGER);
```

`grade` 与 `state` 用 CHECK 约束；`todos.wake_when` 对 `status='suspended'` 非空（应用层校验）。

### 2.3 重建

`collab_index rebuild`：全量读 `collab-messages.jsonl` + `collab-*.json` → 写入 `collab.db.tmp` → `fsync` → 原子重命名。

- 幂等：同一输入两次重建结果逐字节一致（测试断言：行数 + 每表 checksum）；
- 失败：保留旧 `collab.db`，返回可读错误；
- 增量：正常写路径边写 jsonl 边 `INSERT`，失败只记日志不阻断协作。

### 2.4 并发与降级

- 写入串行化：单进程内一个 Promise 队列；跨进程靠 WAL + busy_timeout + 3 次指数退避；
- 运行时探测：`typeof Bun !== 'undefined' ? bun:sqlite : node:sqlite`（动态 import）；
- **任何 DB 异常 → 降级纯 JSON**：工具仍可用，看板显示 `[索引不可用]`；
- GUI 入口不 import 存储模块（`--conditions=browser` 下不得触发）。

### 2.5 回填（D 轮决策：状态级）

- 24 条 handoff → `handoffs`；49 条 thread 索引 → `threads`；
- 正文不可得（插件历史上未存），`messages.body` 留空并标 `backfilled=1`；
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

## 5. 注入格式（每轮，硬上限 12 行）

```
[mission] 排钟 B4 接线 · .trellis/tasks/11-19-b4-wiring
  边界: 做 排钟 / 不做 ws集群实施 → 转 ses_edc3…  · 状态 active · 推进于 3.1h 前
[progress] M2/5 · 下一里程碑 M3「双写验证」需要 evidence
[todo] 3 open · 2 需要你 · 1 等 ses_e176… · 最老 T2 6.2h
  T2 decide dev/prod 键空间 → 等 owner
  T3 reply  t_mwnmtb97 D1 记入 PRD → 可执行
[scope] 本条属「ws集群实施」→ outOfScope；正确动作：转交 ses_edc3… / 拒绝 / 问 owner
[drift] 连续 6 轮无主线动作（11.2h）→ 三选一：继续 / 记阻塞 / 建 next-up
```

规则：
- 每段 ≤3 行，todo 只列 top3 + 计数；
- `[scope]` 仅在该条消息命中 outOfScope 时出现；
- `[drift]` 仅在触发时出现；
- 所有段**每轮重新计算**，不写 `injected[]`、不注销（与 0.5.x 的一次性注入不同）。

## 6. 闸门（0.9.2）

| 动作 | 规则 |
|---|---|
| `accept` | `bid.scope ∩ mission.outOfScope ≠ ∅` → 拒绝，返回 `handoffTo` + override 用法 |
| `broadcast/handoff` 指向他人 outOfScope | 允许（发起方有权提问），但提示接收方边界 |
| `reply/send` | 不校验 scope（回复不扩大边界） |
| 新单 | `open todos ≥ 8` → `TODO_OVERFLOW`，要求先关 2 条 |
| `override` | 必填 `reason` + `approvedBy`（人类），写 `audit.jsonl` |

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
