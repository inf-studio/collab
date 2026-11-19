# 独立复核报告：`collab_status`（11-19-collab-status）

- 复核人：trellis-check（冷上下文，只审不改）
- 复核时间：2026-11-19
- 被复核对象：工作区未提交改动（`src/tools/status.ts` 新增、`src/tools/index.ts`、`test/handoff-harness.mjs`（S96）、
  `test/readonly-default.mjs`、`docs/collab.md`、`README.md`、`skills/collab/SKILL.md`、`CHANGELOG.md`）
- 结论：**可提交（无阻断项）**。9 项检查全部通过；4 条 P3 + 4 条 P4 建议，均非本任务引入的缺陷，
  其中 3 条建议由父任务统一处理。
- 说明：按要求**未修改任何实现文件**。变异测试期间临时改过 `src/tools/status.ts`，已按备份还原，
  还原后 `sha256 = a57706ac6cda1823652876da9eea2af08eb0d66af7c745a7d37b40a82d3091a8`（与改动前一致），
  并重跑全量回归确认全绿。不采信 `research/impl-notes.md` 的结论，下列证据全部为本次自行复现。

---

## 一、逐项结论

| # | 检查项 | 结论 |
| --- | --- | --- |
| 1 | 零写入（严格假 ctx + 目录/存储快照，5 种输入） | **通过** |
| 2 | 不改写租约（过租约 `claimed` 只描述） | **通过** |
| 3 | 字段正确（state/priority/剩余租约/投递/队列位置/回复摘要/receipt/下一步） | **通过** |
| 4 | `canPush`（protected 含血缘 / 非 protected / 已闭环） | **通过** |
| 5 | 选择器（三选一互斥、session 口径、无参 ≤5 倒序、空提示） | **通过**（1 处存疑，见 §2.5） |
| 6 | 健壮性（篡改队列项 / 缺字段 / 未知 bid / 会话 404） | **通过** |
| 7 | 回归与范围（676+12+42+32+47+7、18 工具、版本 0.5.3、无新依赖） | **通过** |
| 8 | 测试真实性（2 组变异、既有断言未弱化） | **通过** |
| 9 | 文档一致性（§11.2 / §11.14 / README / skill） | **通过**（P3 建议） |

所有复现脚本都在工作区外，未入库：

- `/tmp/opencode/probe-status.mjs`：自写严格假 ctx + `名:大小:mtime:sha256` 目录快照，48 条断言
- `/tmp/opencode/probe-edge.mjs`：已闭环仍有队列项 / `failedAt` / 会话 404 / 别名表不可读

---

## 二、证据（逐条）

### 1. 零写入 — 通过

做法（**不用仓库断言自证**）：另建假 host，`ctx.session.prompt|update|create|remove|switchAgent` 与
`ctx.storage.set|remove` 整体替换为「记录调用并 `throw`」；同时对比广播目录、owner-queue 目录（递归）、
`COLLAB_LOCK_DIR`、`COLLAB_GRANT_DIR` 的 `name:size:mtimeMs:sha256(前16)` 与 `ctx.storage` 全量条目。

在严格窗口内跑了 **10 次**查询：`bid`（claimed）、`threadID`、`session`、无参、未知 bid（报错）、
protected / lapsed / 篡改队列项 / `ackUnavailable` / 别名。

```
PASS READONLY zero ctx write calls across 10 queries — 0 writes
PASS READONLY no uncaught error — none
PASS READONLY dirs (broadcast/owner-queue/locks/grants) byte-identical (size:mtime:sha256) — 17 bcast files identical
PASS READONLY ctx.storage entries unchanged — identical
   shapes: bid=381(3ms) threadID=318(0ms) session=1198(1ms) no-input=1265(1ms) unknown-bid=throw: 没有交接单 …
```

调用栈自查（`src/tools/status.ts`）：导入仅 `deliveryOf`/`unackedDue`（`core/ack.ts` 纯函数）、
`allBroadcasts`/`isValidBid`/`leaseVerdict`/`readBroadcast`（`src/core/claim.ts` 只读）、
`listFor`/`mineFor`（`src/core/owner-queue.ts` 只读）、`createLineage`（`session.get|list`）、`fmtTtl`；
全文**没有** `writeBroadcast` / `persistRefresh` / `refreshBroadcast` / `releaseLock` / `markSeen` /
`session.prompt|update|remove` 的调用（只在注释里出现，`status.ts:17-21`）。异常路径（未知 bid、
未知 threadID、会话 404、别名表抛错）同样 0 写（`probe-edge` 末行 `read-only (edge shapes): unchanged / writes=0`）。

补充事实：变异 ① 时仓库 S96h 的输出是 `0 write(s) / dirs CHANGED` —— 说明 `ctx` 层桩**抓不到**核心层
直接落盘的写，真正兜底的是目录快照；两者互补，设计成立。

### 2. 不改写租约 — 通过

`leaseVerdict` 是纯判定（`src/core/claim.ts:268-281`）；`status.ts:168` 只读调用，`status.ts:175-180`
只据判定渲染 `剩 X` / `租约已过期`，`status.ts:190-192` 追加「本命令不改写状态」说明。

```
PASS LEASE lapsed claim described as 租约已过期 + names the next refresh — …（handoff，租约已过期）…
PASS LEASE record hash unchanged by the read (no persistRefresh) — 39d55826bccd → 39d55826bccd
PASS LEASE record still state=claimed, claim.by intact — claimed/ses_peer
PASS LEASE no remaining-time label on an expired claim
```

变异 ①（在 `status.ts:333` 的 `readBroadcast` 之后插入 `persistRefresh(record, refreshBroadcast(record))`）
时该记录被改写为 `state=open` 且 mtime 变化，被仓库断言与本人探针同时拦下（见 §3）。

### 3. 字段正确 — 通过

样本（本人 host 实跑）：

```
b_9c000000000001  state=claimed  priority=urgent  承接=ses_peer…peer（handoff，剩 4m）  canPush=true  "probe 01"
  投递: admitted=09:37:28  seen=09:37:42
  队列: 0 项
  最近回复: 09:37:28 "已接管，先读交接包；这是一段很长的正文用来验证摘要截断…"（ses_peer…peer）
  下一步: 等回执 → collab_wait {threadID:"t_probe_claimed"}；超时用 collab_escalate
```

- `state`（`status.ts:170`）、`priority`（`status.ts:52-53`，只认 `'urgent'`，缺失/旧记录 → `normal`）✓
- 承接 + `kind` + 剩余租约（`status.ts:171-184`，`fmtTtl`）✓
- 投递 `admitted=` / `seen=` 绝对时间、`ack=n/a`、`unacked=`（`status.ts:90-103`）✓
  - 实测 `ackUnavailable` → `PASS FIELD ackUnavailable renders ack=n/a`
  - 实测 `failedAt` → `admitted=failed  seen=-  unacked=yes（重发预算已用尽，可人工补投）`
- 队列项 + 队列位置（`status.ts:196-214`、`76-87`）：`队列: 2 项（目标 …，未读 3 条）` +
  `- q_… @ HH:MM:SS 第 2/3 位（未读）` / 已读项 `已读 HH:MM:SS（不在队列）` ✓
- 最近 reply 摘要：`truncate(text, 60)`，实测 60 字（含省略号）、是正文前缀、**不输出正文尾部**；
  记录本身没有新增任何正文字段（本任务只读）✓
- 已闭环 `receipt.note`（`status.ts:226-236`），`receipt.from` / `receipt.by` 两种写法都支持：
  `PASS FIELD closed: receipt.by accepted (no receipt.from)` ✓
- 每条 block 都有 `下一步`：`PASS FIELD every block has 下一步` ✓

存疑（不阻断）：`priority` 只把字面量 `'urgent'` 视为加急，其他取值（如 `'high'`）静默为 `normal`。
与 sibling `11-19-collab-escalate` 的 R2 字段一致，可接受；若将来加第二档优先级需同步此处。

### 4. `canPush` — 通过

`addresseeOf`（`status.ts:65-73`）取 `claim.by → asked.sid → delivery.to → 队列项 target`；
`describe`（`status.ts:318-326`）用 `createLineage().protectedAncestor`（`src/core/lineage.ts:76-90`，含
`MAX_LINEAGE_DEPTH` 有界 + 环保护）判定；`canPush=false` 时 `nextStep` **先于 state** 返回
「只能队列（该目标受保护）」并优先于「等回执」（`status.ts:111-128`）；已闭环则 `无需动作`。

```
PASS CANPUSH protected target → false + 只能队列
PASS CANPUSH protected status also mentions 受保护
PASS CANPUSH lineage descendant (grandchild of protected) → false — … ses_gran…rand（handoff，剩 4m30s）…
PASS CANPUSH non-protected claimant → true
PASS CANPUSH queue item of this bid + unread position — 队列: 2 项（目标 ses_e1eb…Kebk，未读 3 条）:
PASS CANPUSH closed hand-off ends in 无需动作 (not a queue advice)
```

真机样本（protected 目标 + 队列）：

```
b_9c000000000005  state=claimed  priority=normal  承接=ses_e1eb…Kebk（handoff，剩 4m30s）  canPush=false
  队列: 2 项（目标 ses_e1eb…Kebk，未读 3 条）:
    - q_… @ 09:38:09 第 2/3 位（未读）
    - q_… @ 09:38:09 第 3/3 位（未读）
  下一步: 只能队列（该目标受保护）：collab_request_owner 或等其下一轮
```

定位不到目标时字段省略（`canPush === undefined`）：`b_…0009  state=open … 承接=-`（无 `canPush`）✓

### 5. 选择器 — 通过（1 处存疑）

`status.ts:289-298` 三选一互斥 + 格式校验：

```
PASS SELECTOR bid+threadID refused — … 三选一（本次收到 bid + threadID）
PASS SELECTOR threadID+session refused — … 三选一（本次收到 threadID + session）
PASS SELECTOR three inputs refused (names all) — … 三选一（本次收到 bid + threadID + session）
PASS SELECTOR malformed bid / malformed threadID / unknown bid / unknown threadID is a readable error
PASS SELECTOR session: from.sid + claim.by, unresolved first then the latest closed — [ackna, claimed, lapsed, done]
PASS SELECTOR session: newest closed is the only closed one
PASS SELECTOR session: asked.sid alone is NOT "involved" (design §2)
PASS SELECTOR session alias resolves (collab/aliases)
PASS SELECTOR unknown alias answers "no hand-offs" instead of throwing
PASS SELECTOR no-input ≤5 — 5 listed
PASS SELECTOR no-input ordered by updatedAt desc (bid tie-break) — [010, 008, 011, 012, 013]
PASS SELECTOR no-input excludes closed records
PASS SELECTOR no-input with nothing pending gives one line — 当前没有未闭环交接。
PASS SELECTOR no-input without a session context does not crash
```

排序口径核实：`newestFirst`（`status.ts:47-49`）`updatedAt` 倒序 + `bid` 同毫秒 tie-break；探针里
`b_…0008`（-10s）与 `b_…0011`（-10s）同毫秒，实际输出 `008` 在前，符合 tie-break，非缺陷（首次探针
按「只算 many 组」的错误预期判 FAIL，已修正预期后 PASS）。

**存疑（P4，需父任务确认口径）**：无参模式与 `session` 模式只认 `from.sid` / `claim.by`，**不含**
`asked.sid`。这与 `design.md §2` 一致，但 `prd.md` R1 写的是「本会话相关的未闭环单」，字面上更宽。
影响：被问询但尚未领取的会话在**无参**模式下看不到该单（其 context 注入仍会收到接管请求）。
建议：保持现状（与 design 一致），由父任务在 PRD 里把这句改成「作为 `from.sid` 或 `claim.by`」即可闭环口径；
若确要扩，是 `involved()`（`status.ts:56-57`）一行 + 一条断言，但会与现有文档文案冲突。

### 6. 健壮性 — 通过

```
--- tampered queue item ---
b_9c00000000000a  state=open  priority=normal  承接=-  canPush=true  "probe 0a"
  队列: 1 项（目标 ../../../../etc）:
    - q_tampered_zz @ 09:38:03 未读（位置未知）
PASS ROBUST tampered queue item (target "../../etc") does not crash — ok
PASS ROBUST tampered item still reported with an unknown position
PASS ROBUST record without claim / delivery / replies / receipt is readable
PASS ROBUST open+asked shows the ask + a next step
--- claimant session missing (session.get 404) ---
b_ed000000000003  state=claimed … 承接=ses_ghos…host（handoff，剩 5m）  canPush=true
  下一步: 等回执 → collab_wait {target}（该单没有 threadID）；超时用 collab_escalate
--- unreadable alias table + alias input ---
somealias 没有作为发起方（from.sid）或承接方（claim.by）的交接单。
```

代码对应：`queuePosition`（`status.ts:78-86`）与未读计数（`status.ts:199-203`）各自 `try/catch`，
坏 `target` 降级为「未读（位置未知）」而不是整条失败；`mineOf`（`status.ts:306-317`）吞队列读错误；
`resolveSession`（`status.ts:152-157`）吞别名表错误。未知 bid / threadID 走 `invalid(...)` 可读错误。

### 7. 回归与范围 — 通过

必跑命令（变异还原后，`dist/` 由还原源码重建）：

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
=== 676/676 checks passed
=== 12/12 checks passed
=== 42/42 checks passed
=== 32/32 checks passed
=== 47/47 checks passed
=== 7/7 panel checks passed
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
EXIT=0
```

- 目标计数 `676 + 12 + 42 + 32 + 47 + 7` **完全一致**（S96 提供 17 条：`grep -c "✓ S96" = 17`）
- 工具数：`src/tools/index.ts:45` 注册，探针 `tools.length === 18`，`test/readonly-default.mjs:146-159`
  注册表 17 → 18 且顺序在 `collab_wait` 之后（`collab_status` 只注册一次）
- 版本：`package.json` / `PLUGIN_VERSION` 仍 **0.5.3**（GUI 探针输出 `插件 v0.5.3`、`pkgVersion=0.5.3`）
- 无新依赖：`package.json` 未改；改动面 `git diff --numstat` = 7 个文件 + 1 个新文件，`src/types.ts`、
  `src/core/*`、`src/rpc.ts`、`src/hooks/*`、GUI/TUI 均未动

### 8. 测试真实性 — 通过

`test/handoff-harness.mjs` 为 **341 行纯新增（0 删除）**；`test/readonly-default.mjs` 仅 1 行改名 + 1 行新增
（`git diff --numstat`：`341 0` / `2 1`）→ **既有断言没有被弱化**。

变异 ①（`readBroadcast` 之后插入 `persistRefresh(record, refreshBroadcast(record))`）：

```
✗ S96 a lapsed claim says 租约已过期 and names the next refresh — the read rewrites nothing — 1795052336049.19 → …073.19 / open
✗ S96 read-only: seven queries, zero write calls, broadcast / owner-queue dirs and storage unchanged — 0 write(s) / dirs CHANGED
=== 674/676 checks passed
```

本人探针同时失败 4 条（目录快照 CHANGED、lapsed 记录被改为 open、承接丢失、session 列表少一条）。

变异 ②（`status.ts:325` `canPush: addressee ? !guard : undefined` → `canPush: addressee ? true : undefined`）：

```
✗ S96 a protected target is canPush:false and the next step is the queue, not a push —   下一步: 等候选领取；…
=== 675/676 checks passed
```

本人探针失败 3 条（protected 目标 + lineage 孙会话 `canPush=true`）。两次变异均**已还原**，
还原后源码哈希与改动前一致并重跑全绿（见 §7）。

S96 非自证：所有 17 条都是对工具输出的内容断言 + 目录/存储快照 + mtime 对比，两组变异各能击穿，
不是「调用即可通过」的空断言。

### 9. 文档 — 通过（含 P3 建议）

- `docs/collab.md:260` §11.2 标题「十八个工具」、`:270` 工具表新行、`:1114-1151` §11.14 —— 与实现一致
  （三选一、别名、≤5/倒序、`canPush`、队列位置、过期租约只描述、只读契约、非目标）
- `README.md:3-4`「十八个」、`:24` 工具表、`:321` 源码结构「十八个工具」—— 一致
- `skills/collab/SKILL.md:3` 描述、`:27` 速查表、`:138-155`「一点八」、`:218` 排障表 —— 一致；
  `node scripts/check-skill.mjs` 通过
- `CHANGELOG.md` `[0.6.0] ### Added`（collab_status 全文）+ `### Tests`（S96 17 条 + 变异记录 +
  readonly-default 17→18）—— 与实测一致（含「广播 / 队列目录（名/大小/mtime）」的措辞）

**关于文案里的 `collab_escalate`（任务点名要判断）**：出现在 `src/tools/status.ts:118`（`claimed` 的下一步）、
`docs/collab.md:1134`（示例输出）、`:1139`（canPush 说明）、`:1151`（非目标）。该工具属 sibling
`11-19-collab-escalate`（`task.json` = `planning`，尚未实现）。

判断：**会产生「指向不存在工具」的窗口，但本任务不是新引入方** —— `docs/collab.md:653`（HEAD 已存在，
本 diff 未触碰）在 0.6.0 去重一节里已经引用了 `collab_escalate`，说明父任务本来就按「0.6.0 一批」写文档；
且 `PLUGIN_VERSION` 仍是 0.5.3，本任务单独不构成可发布版本。`design.md §3` 也明确要求这句文案。
所以：**不建议为此改实现**。最小处置二选一：
1. **（推荐）父任务把 status + escalate + freeze 一次性合并后再 bump 0.6.0** —— 窗口期为零，无需改动；
2. 若必须让 status 单独落地，则把 `status.ts:118` 的子句改成不带工具名的「超时手动催办」，
   `docs/collab.md:1134/1139/1151` 同步三处（`ToolKit` 没有工具注册表，做不了「有则显示」的条件渲染，
   见 `src/tools/shared.ts:168-230`，所以「按存在性显示」不是最小改法）。

---

## 三、原始输出（关键片段）

基线（改动还原后、变异前）：

```
=== 676/676 checks passed
=== 12/12 checks passed
=== 42/42 checks passed
=== 32/32 checks passed
=== 47/47 checks passed
=== 7/7 panel checks passed
skills ok
```

S96 条数：

```
$ grep -c "✓ S96" /tmp/opencode/restored.log
17
```

本人探针（未变异 dist）：

```
=== PROBE 48/48 passed
```

变异 ①（`/tmp/opencode/mut1.log`）：`674/676`，2 条失败（内容见 §2.8）。
变异 ① 下本人探针：`=== PROBE 44/48 passed`（READONLY dirs CHANGED / LEASE ×2 / SELECTOR session）。
变异 ②（`/tmp/opencode/mut2.log`）：`675/676`，1 条失败；本人探针 `=== PROBE 45/48 passed`（CANPUSH ×3）。
还原后：`676/676 … skills ok`，`status.ts` 哈希 `a57706ac…3091a8` 与改动前相同，`grep -c MUTATION = 0`。

---

## 四、风险清单（均非阻断）

| ID | 级别 | 说明 | 最小改法 / 归属 |
| --- | --- | --- | --- |
| R1 | P3 | `collab_escalate` 出现在工具输出（`src/tools/status.ts:118`）与 3 处文档，但该工具还是 `planning` | 父任务同批合并（推荐）；单独落地时改成不带工具名的「超时手动催办」 |
| R2 | P3 | `src/index.ts:35` 仍写「the seventeen native `collab_*` tools」，17→18 后过期（注释，不影响行为） | `seventeen` → `eighteen`（父任务最终统一到 20 时一并改） |
| R3 | P3（**既有**，非本任务引入） | `README.md:261` 测试计数仍是 `638 项 harness + 12 + 35 快照 + 29 TUI + 47 GUI + 5 面板`，实际 `676/12/42/32/47/7` | 父任务收尾时一次性刷新（本任务 +17 使其偏差更大，但差异在 HEAD 已存在） |
| R4 | P4 | S96h 只读块未覆盖**错误路径**（未知 bid / 未知 threadID） | 本人探针已覆盖（严格窗口内 0 写）；如需固化，S96h 里加一行 `await call('collab_status', { bid: '<不存在>' }).catch(()=>{})` |
| R5 | P4（UX） | 已闭环单若仍有**未读**队列项，输出会是「队列: 1 项（未读 1 条）」+「下一步: 无需动作」，两句略冲突（实测 `b_ed000000000001`） | 符合 PRD 验收「已闭环 → 无需动作」，不建议本任务改；将来可写成「无需动作（该目标仍有 N 条未读队列项）」 |
| R6 | P4（展示） | 被篡改的队列文件里 `target` 原样渲染进「队列: …（目标 xxx）」（`shortID` 对非 `ses_` 字符串不做清洗）；位置已正确降级为「位置未知」 | 需要硬化时用 `truncate(target, 40)` 或对 `target` 做控制字符折叠；仅在攻击者已能写本机队列目录时可达，收益低 |
| R7 | P4（fail-open，仅展示） | 承接方会话读不到（404）时 `canPush=true`（`lineage` 吞错 → `undefined` → `!undefined`） | 只影响展示，不是护栏；`collab_send` 仍会拒绝不存在的会话，可不动 |
| R8 | P4（ni[1]） | `allBroadcasts()`（`src/tools/status.ts:303`）在 `bid` 分支也会全量读一遍目录 | 把 `records` 下沉到 `threadID` / `session` / 无参分支即可；只读 I/O，无正确性影响 |

[1] `status.ts:303` 的 `const records = allBroadcasts();` 位于分支之前。

---

## 五、复核方法（可复现）

```bash
cd /data/project/collab
# 1) 基线
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
# 2) 独立探针（工作区外，自建假 host；不依赖 test/）
node /tmp/opencode/probe-status.mjs      # 48/48
node /tmp/opencode/probe-edge.mjs        # 边界样本
# 3) 变异（各改一处 → pnpm build → node test/handoff-harness.mjs → 还原）
#    ① status.ts:333 readBroadcast 后插 persistRefresh(record, refreshBroadcast(record))
#    ② status.ts:325 canPush: addressee ? !guard : undefined  →  ? true :
```

本次复核未执行任何 git 写操作（无 `add`/`commit`/`push`），未启动/重启真实会话，未触碰真实
`~/.config/opencode/*` 目录（全部用 `mkdtempSync` 临时目录 + 假 ctx）。
