# 第二轮独立复核报告：强制回执 + 到期自动提取（11-17-collab-auto-receipt）

> 角色：**冷上下文独立复核（trellis-check）**，**只审不改**：未改任何实现文件、未 `git add/commit/push`、未重启/重载服务。
> 基线：`HEAD=c7b84f465` + 工作区未提交改动；复核时间 2026-11-17 14:2x。
> 上一轮报告：`research/check-report.md`（结论「AC 全绿、H1 必须修」）；实现方修复记录：`research/impl-notes.md` §7。
> 本轮自有复现脚本（**不复用** harness / `impl-probes-h1-h2.mjs`）：
> `research/check-round2-probes.mjs` → **34 项，25 PASS / 9 FAIL**（同一根因）。

---

## 0. 结论（先说结果）

| 项 | 结论 |
| --- | --- |
| H2（actor 闸门 + 旁观不读不闭环） | **已修复，通过**（含「其它工作区旁观会话」） |
| H1（否定语 / 计划语 / 只看最后一条 / 目标必须是当前 bid） | **大部分通过**：`<bid>` 占位、其它 bid、`[handoff] DONE` 无目标、否定语、计划语、「第 1 条回显 + 第 2 条没开始」都已挡住 |
| **H1 残留（阻塞）** | **「回显真实模板」仍会误闭环**：当占位符 `<摘要>`/`<原因>` 后面还有任何字符（例如 R1 命令行的 `", confirm:true}`、反引号、`（以上是示例）`），摘要占位检查 `VERDICT_PLACEHOLDER_RE = /^<[^>]*>$/`（`collab.js:1047`，判定处 `:1159`）**精确匹配失败** → 被判 `done`/`blocked`，bid 被自动闭环、锁被释放、不重投 |
| R1 / R3 / R4 其余 | 通过 |
| 是否可提交 | **否（建议先补 1 条正则，我已用 /tmp 副本验证：harness 204/204 + 我的 34/34 全绿）**；若坚持不修，必须把该形态写进 guide 已知限制（但 R1 文案里「复述/回显它……不会被自动闭环」这句话目前是**错的**） |

为什么这条是阻塞项：R1 的新文案本身就在对端会话里写着
`collab_send {target:"ses_req", text:"[handoff] DONE b_… <摘要>", confirm:true}`（`collab.js:1184`）。
对端**逐字复述/回显这一行**（哪怕只是「收到。执行：…」这种没有任何计划语/否定语的确认）→ 租约到期即被判 `done`，
而它其实一步都没做。这正是上一轮 H1 点名的失败模式，修复只覆盖了「`<摘要>` 恰好是整条摘要」的那一种写法。

---

## 1. 必查 10 项（逐条，含自证）

### 1. H1 目标匹配 —— **不通过**（部分正确）

**正确的部分**（我的复现，见 §3）：

| 输入（对端最后一条有文本的 assistant） | 结果 |
| --- | --- |
| `[handoff] DONE <bid> <摘要>`（A11） | `open`，不闭环 ✓ |
| `[handoff] DONE 已完成，测试通过`（无目标，A5） | `open` ✓（且**没有**回落关键词，`collab.js:1163-1165` 直接 `return undefined`） |
| `回执格式 [handoff] DONE b_ffffffffffffffff 已修复 已完成`（其它 bid + 强关键词，A4） | `open` ✓（同上，不回落） |
| 真 `[handoff] DONE <当前 bid> 已修复并提交 79eac02d`（B1） | `done`，note 正确 ✓ |
| 真 `[handoff] BLOCKED <当前 bid> 该提案已实施，无需 implement`（B2） | `blocked` ✓ |

**失败的部分 —— 回显真实模板**（目标 = 当前 bid，摘要位是占位符但带尾巴）：

| # | 对端回答（末尾） | 实测 | 应有 |
| --- | --- | --- | --- |
| A2 | `回执命令是 collab_send {target:"ses_req", text:"[handoff] DONE b_… <摘要>", confirm:true}` | **`done`**，note=`<摘要>", confirm:true}` | 不闭环 |
| A14 | `收到交接。执行：collab_send {target:"ses_req", text:"[handoff] DONE b_… <摘要>", confirm:true}` | **`done`** | 不闭环 |
| A15 | `② 回执（必发，二选一）: collab_send {… text:"[handoff] DONE b_… <摘要>", confirm:true}`（整行照抄 R1） | **`done`** | 不闭环 |
| A16 | `回执：text:"[handoff] DONE b_… <摘要>"` | **`done`** | 不闭环 |
| A17 | `[handoff] DONE b_… <摘要>（以上是示例）` | **`done`** | 不闭环 |
| A18 | `格式：text:"[handoff] BLOCKED b_… <原因>", confirm:true` | **`blocked`** | 不闭环 |
| A3 | 反引号包裹：``格式：`[handoff] DONE b_… <摘要>` `` | **`done`** | 不闭环 |
| A20 | `[handoff] DONE b_… \`<摘要>\`` | **`done`** | 不闭环 |
| A21 | `[handoff] BLOCKED b_… 【<原因>】等确认后发` | **`blocked`** | 不闭环 |

**根因（`file:line` 级）**

- `collab.js:1047` `const VERDICT_PLACEHOLDER_RE = /^<[^>]*>$/` —— 要求摘要**整条恰好**是 `<…>`。
- `collab.js:1153-1159`：`summary` 由 `rest`（bid 之后直到文本末尾，因 `assistantText()` 已折叠换行，`mention[2]` 吃满整段）
  去掉前导引号与裸 bid 得到，只会再剥一次尾部引号；因此模板回显留下的 `", confirm:true}` / 反引号 / 中文尾注都会留下。
- `collab.js:1159` `if (VERDICT_PLACEHOLDER_RE.test(summary)) continue` → 精确匹配失败 → 落到 `:1160` 返回 `{state, summary}`。
- 目标校验（`:1147-1151`）本身是对的；问题**只在摘要位**。

**建议补丁（2 行，已在 /tmp 副本验证；未写入仓库）**

```js
// collab.js:1047 后新增
/** Any `<…>` token in the summary slot = template placeholder, never a receipt (H1). */
const VERDICT_ECHO_RE = /<[^>]{0,32}>/

// collab.js:1159 替换
- if (VERDICT_PLACEHOLDER_RE.test(summary)) continue
+ if (VERDICT_ECHO_RE.test(summary)) continue
```

验证方式（**不碰仓库实现**）：

```bash
cp .opencode/plugins/collab.js /tmp/opencode/collab-fix.js && # 打上上面两行
COLLAB_PLUGIN_PATH=/tmp/opencode/collab-fix.js \
  node .trellis/tasks/11-17-collab-auto-receipt/research/check-round2-probes.mjs   # 34/34 PASS
COLLAB_PLUGIN_PATH=/tmp/opencode/collab-fix.js PROBE_REPO=$PWD \
  node /tmp/opencode/harness-fix.mjs                                              # 204/204，exit 0
```

即：该补丁**不放宽**任何既有行为（204 项不变），只把「摘要位含 `<…>` 占位」一律视为回显。
（`A21` 的全角括号 `【<原因>】` 也覆盖，因为正则匹配摘要中**任意位置**的 `<…>`。）

> 备选（更保守、但会漏 A16/A21）：同时要求 `^[`"'“「]?<`。不建议——A16/A21 正是自然写法。

### 2. H1 否定 / 计划语 —— **通过**

`collab.js:1054` `VERDICT_NEGATION_RE`、`:1061` `VERDICT_PENDING_RE`，判定入口 `:1140`（命中即 `undefined`，不闭环）。

我的复现全部 `open + attempts=1 + 无 receipt`：

- A6 `我不会发 [handoff] DONE，因为环境起不来。`（含真实模板 → 仍被 `不会` 挡住）
- A7 `任务未完成，卡在权限问题上`
- A8 `无法完成，需要人接手`
- A9 `not done yet, blocked by permissions`
- A10 `完成后我会发 [handoff] DONE <当前bid> 摘要见下`
- A1 `完成后我会发：`[handoff] DONE <bid> <摘要>`，先确认一下环境。`

harness S51 另有 5 条同向断言（`任务未完成`/`无法完成`/`not done yet`/`我不会发`/计划语）。**无遗漏**（就本轮的清单而言；
`确认后发`（A21）这种「非承诺式」尾注不在否定语范围，属第 1 项缺陷）。

### 3. H1「只看最后一条」 —— **通过**

`verdictFromTexts` 只取 `list[list.length - 1]`（`collab.js:1137-1139`），不拼接、不回看；`assistantTexts` 先过滤
`assistant` + `since >= claim.at`，再在末尾 10 条里取**最后一条有文本**的（`collab.js:1077-1099`）。

- A12 两条：第 1 条 `我会按提示发 [handoff] DONE <当前bid> <摘要>。`、第 2 条 `环境起不来，我还没开始，需要人接手。`
  → `open`，attempts=1（**不是** done）✓
- A13 末条 tool-only（`content:[{type:'tool'}]`）→ 回落最后一条有文本的回答 → `done` ✓
- harness S51 同向 2 条（`echo in an older answer` / `verdict superseded by a later answer`）✓

### 4. H2 actor 闸门 —— **通过**

`collab.js:1709-1724`：`lapsed && claim.kind==="spawn" && from.sid` 之后，**`:1719` 先判 `actor`**：
`if (!actor || String(actor) !== String(current.from.sid)) return refreshBroadcast(record, now)` —— 连 `cp.session.context` 都不会碰；
`:1721` 再做 `[protected*]` 血缘检查；`:1724` 才 `extractVerdict`。所有刷新入口都传了 actor
（`:1600`/`:1636` applyReceipt/applyDecline、`:1783` injectionFor、`:2346`/`:2638`/`:2764` broadcast/handoff 幂等、collab_accept）。

我的复现（自建 `ctx.session.context` 打点，记录每次读的 sid）：

| 场景 | 是否读对端 | 结果 |
| --- | --- | --- |
| C1 同工作区旁观会话（`ses_bystander`，WS_A）触发 `context` | **否**（`read:false`） | `open` + attempts=1，无 receipt ✓ |
| C2 **其它工作区**（`ses_other_ws`，WS_B）触发 `context` | **否** | `open`，无 receipt ✓ |
| C3 发起方 `ses_req` 触发 | **是**（读 1 次） | `blocked` + `receipt.auto:true` ✓ |

harness S52 另覆盖同一组三情形（含读打点）。

### 5. H2 副作用「旁观刷新仍 claimed → open」 —— **通过（与文档一致，且不产生重复拉新）**

- 文档明确：guide §5.3「注意原顺延会让 `claimed` 回到 `open`（一次性窗口），所以自动提取只在发起方那次刷新里发生。」✓
- 代码：`refreshBroadcast`（`collab.js:680-712`）在 lapsed `claim.kind==="spawn"` 上只做
  `state=open / attempts+1 / skipped+=claim.by / expiredClaim / delete claim / releaseLock / delete asked`，**不含 spawn**。
- 重复拉新：拉新只发生在 `collab_broadcast` 的「无 existing」分支（`:2421+`）；existing 分支（`:2334-2371`）只可能补发 1 条叫醒，
  **永不 create**。我的 34 项探针全程 `created=0 / prompts=0`（D1/D2）。
- C5：被旁观者 reopen 后再由发起方刷新 → 不再读、不再提取（`reads=[]`），符合「一次性窗口」。
  代价：旁观者的这一次刷新会**吃掉**该 bid 的自动提取机会（要等真回执或人工）——属设计取舍，已在 guide 写明，记为 L-2。

### 6. R1 文案 —— **通过（但第 ③ 句的承诺目前不成立）**

`handoffActions()`（`collab.js:1180-1197`）→ ① `collab_accept {bid:"b_…", confirm:true}`；
② DONE + BLOCKED 两条 `collab_send {target:"ses_…", …}`；③「只分析、不调用工具 = 未完成」+ 新增
「（② 里的文字只是格式示例——复述/回显它不算回执，也不会被自动闭环。）」（`:1186-1187`）；非 spawn 追加 DECLINE。
bid 与发起方 sid 都是字面量（harness S44 原始输出见 §2）。

- 我的 R1 探针（接管请求注入）断言 5 个片段全部命中：`collab_accept {bid:"<当前bid>", confirm:true}`、
  `collab_send {target:"ses_req", text:"[handoff] DONE <当前bid>`、`[handoff] BLOCKED <当前bid>`、`复述/回显`、`只分析` ✓
- 四处调用点仍在：`deliverAsk`（spawn 与 busy 叫醒共用）、`injectionFor`、`collab_broadcast`（spawn/串行）、`collab_accept` 输出。
- ⚠️ **文案与实现不一致**：`:1187` 说「回显它……不会被自动闭环」，但按第 1 项，A2/A14/A15/A16/A17/A18/A20/A21 恰恰会被闭环。
  修第 1 项后这句话才成立（否则应改文案，属欺骗性承诺）。

### 7. L1「尾部读取是 `?limit=10`」 —— **通过**

`collab.js:1663` `ctx.session.context({ sessionID, limit: VERDICT_MESSAGE_LIMIT })`（`VERDICT_MESSAGE_LIMIT=10`，`:171`），
宿主不支持/报错才回退无 `limit` 全量读（`:1664-1670`）。我的探针记录到 `{"sessionID":"…","limit":10,"keys":["sessionID","limit"]}` ✓，
且每次刷新**只读 1 次**（所有 A/B 用例 `read:1`）。

### 8. L2「`docs/development.md` 计数」 —— **通过**

`docs/development.md:119` → 「（以脚本实际输出为准，当前 **204** checks）」；guide §11 两处也是 204
（`cross-workspace-collab-guide.md:302` / `:307`）；全仓已无 `155 checks` 残留。

### 9. 回归 —— **通过**

| 命令 | 结果 |
| --- | --- |
| `node --check .opencode/plugins/collab.js` | exit 0（无输出） |
| `node scripts/collab/handoff-harness.mjs` | `=== 204/204 checks passed`，`✗` 0 条，exit 0 |
| `pnpm test:collab` | `=== 204/204 checks passed`，exit 0 |
| 旧用例语义 | harness 的 `git diff -U0` **只有 2 个 hunk**：文件头注释（+24）与文末追加（+547），**删除行 0**；按标题计数 **S1–S43 = 155（与 HEAD 完全一致），S44–S52 = 49** |
| `impl-probes-h1-h2.mjs`（实现方脚本，仅作交叉参考） | 14/14 与预期一致 |

**S45 / S49 触发方式调整是否合理**：合理且必要。H2 之后旁观者 `collab_accept` 不再触发提取，二者改为
「发起方 `ses_req` 的 `context` 注入」触发（`handoff-harness.mjs:2103-2106`、`:2285-2286`），断言集合未变：
S45 仍断言 `state=blocked` / `receipt.auto` / `from=by=对端 sid` / 摘要含「已实施」/ `attempts=0` / 不 spawn / 不投递 / 释放锁 / 再 accept 报「已闭环」；
S49 仍断言 ≤200 字、去 bid、`TAIL-MARKER` 不落盘。**没有弱化**。

### 10. 范围 / 护栏 —— **通过**

- 本任务改动文件 = `.opencode/plugins/collab.js`、`scripts/collab/handoff-harness.mjs`、`docs/collab.md`、
  `docs/development.md`、`.trellis/spec/guides/cross-workspace-collab-guide.md`、任务目录（research/），
  与 `implement.md` 的回滚清单一致。
- 工作区里其它未提交项**不属于本任务**（另一并发会话的 schema/bench 线）：`bench/spec/97-schema-live-probe.spec.ts`(14:16)、
  `packages/{contracts,schemas}/**/worker*.ts`(14:12–14:13)、`docs/issues/feat-worker-onboarding-approval-delivered.md`(11-16)、
  `.trellis/tasks/11-17-parity-wait-chip/task.json`(13:50)、`mcp` 子模块 dirty；`git diff packages/ bench/ …` 里
  `collab|handoff|extractVerdict` 命中数 = **0**。
- 护栏：diff 中**没有**新增 `session.remove` / `interrupt` / `delivery:"steer"` / `unlinkSync` / 新 `ctx.session.prompt`；
  新增的唯一对外交互是**只读** `ctx.session.context`，且在 `protectedAncestor` 之后（`collab.js:1721`）。
  未向 `ses_e1eb91cebffeTv1467ubJLKebk`、`ses_e23a4a23fffe4c4m7UQFR8dUL3` 或其子会话投递；未删任何会话。
- 未重启服务：`opencode.exe serve --service`（pid 346860）启动于 **11-15 12:06:18**，远早于 `collab.js` mtime **11-17 14:15:40**
  → 运行时仍是旧码（新逻辑需重载后生效，本任务按约束未重启）；`/api/plugin` 中 `collab` / `collab-global` 均 `active`（仅代表已加载）。
- 未写 `/data/project/muke-interface`：该仓 `git status` 只有它自己的历史改动（task.json + 2 个 issues），
  与本任务无关；真实广播目录 `~/.config/opencode/collab-broadcast/` 最新文件仍是 **13:56**，14:00 之后**无新文件**（无真实投递）。

---

## 2. 必跑命令原始输出

```text
$ node --check .opencode/plugins/collab.js
(no output)                                              exit=0

$ node scripts/collab/handoff-harness.mjs | tail -3
  ✓ S52 a session of another workspace never reads or closes either — {"read":false,"state":"open"}
  ✓ S52 the requester's own refresh reads the answer and closes the bid — {"read":true,"state":"blocked"}

=== 204/204 checks passed                              exit=0   （✗ 计数 = 0）

$ pnpm test:collab | tail -2
=== 204/204 checks passed                              exit=0

$ node .trellis/tasks/11-17-collab-auto-receipt/research/impl-probes-h1-h2.mjs | tail -4
H2 bystander                             → read=false state=open attempts=1
H2 requester                             → read=true state=done note="已修复"

=== H1/H2 probes: all as expected                      exit=0

$ opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD" | 过滤 collab
{ "id": "collab-global", "source": {"path":"/root/.config/opencode/plugins/collab-global.js"}, "state": {"status":"active"} }
{ "id": "collab",        "source": {"path":"/data/project/muke-pos-app/.opencode/plugins/collab.js"}, "state": {"status":"active"} }

# 旧/新用例切分（按标题，来自 harness 输出）
old(S1-43)=155   new(S44+)=49   total=204   failed=0

# 服务启动 vs 插件 mtime
346860 日 11月 15 12:06:18 2026  opencode.exe serve --service
2026-11-17 14:15:40.0800  .opencode/plugins/collab.js

# 真实广播目录（无新投递）
-rw-r--r-- 11-17 13:56  b_e7da5991792df8f9.json
-rw-r--r-- 11-17 11:04  b_a4f161ed783e6686.json
```

---

## 3. 我自建假 ctx 的独立复现（34 项，25 PASS / 9 FAIL）

脚本：`research/check-round2-probes.mjs`（本轮新建，**只读审阅产物**）
做法：`copyFileSync` 到临时目录改 `.mjs` + `COLLAB_BROADCAST_DIR` 指向临时目录 + **自写** `ctx.session.{get,list,context,create,prompt}`
与 `ctx.tool.transform` / `ctx.session.hook`，直接写 `<bid>.json` + `<bid>.lock` 并伪造 `claim.at = now-301000`，
用**真实 `context` hook** 驱动 refresh；不打桩被测函数。

```text
plugin under test: /data/project/muke-pos-app/.opencode/plugins/collab.js
PASS  A1 echo <bid>/<摘要> in a promise  {"state":"open","attempts":1,"read":1}
FAIL  A2 echo the real R1 command, real bid, no qualifier  {"state":"done","attempts":0,"note":"<摘要>\", confirm:true}"}
FAIL  A3 bare echo of the format with the real bid in code ticks  {"state":"done","note":"<摘要>`"}
PASS  A4 echo a foreign bid + a blocked keyword  {"state":"open","attempts":1,"read":1}
PASS  A5 [handoff] DONE with no target  {"state":"open","attempts":1,"read":1}
PASS  A6 negation quoting the receipt line  {"state":"open","attempts":1,"read":1}
PASS  A7 任务未完成  {"state":"open","attempts":1,"read":1}
PASS  A8 无法完成  {"state":"open","attempts":1,"read":1}
PASS  A9 not done yet  {"state":"open","attempts":1,"read":1}
PASS  A10 plan wording + real bid  {"state":"open","attempts":1,"read":1}
PASS  A11 placeholder target <bid>  {"state":"open","attempts":1,"read":1}
PASS  A12 echo in #1 + not-started in #2  {"state":"open","attempts":1,"read":1}
PASS  A13 tool-only tail falls back to last text answer  {"state":"done"}
PASS  B1 real [handoff] DONE <current bid>  {"state":"done","note":"已修复并提交 79eac02d","attempts":0,"lock":false}
PASS  B2 real [handoff] BLOCKED <current bid>  {"state":"blocked","note":"该提案已实施，无需 implement","attempts":0,"lock":false}
PASS  C1 same-workspace bystander: no read, no receipt, old lease path  {"read":false,"state":"open","attempts":1}
PASS  C2 session of another workspace: no read, no receipt, old lease path  {"read":false,"state":"open"}
PASS  C3 requester's own refresh reads (limit=10) and closes  {"read":true,"state":"blocked","note":"已实施，无需改动","limit":10}
PASS  L1 the tail read asks for ?limit=10  {"sessionID":"ses_h2_owner_18","limit":10,"keys":["sessionID","limit"]}
PASS  C5 a reopened (open) record is never re-extracted  []
PASS  R1 collab_broadcast tool is registered  collab_list,collab_broadcast,collab_handoff,collab_accept,collab_send,collab_reply,collab_inbox,collab_wait
PASS  R1 takeover text has accept / receipt / "echo is not a receipt" and full ids  [collab-handoff] … 接管请求 b_…：…
FAIL  A14 acknowledgment + the real R1 command (no plan words)  {"state":"done","note":"<摘要>\", confirm:true}"}
FAIL  A15 the R1 ② line copied verbatim  {"state":"done","note":"<摘要>\", confirm:true}"}
FAIL  A16 template with the closing quote only  {"state":"done","note":"<摘要>\""}
FAIL  A17 template + trailing prose  {"state":"done","note":"<摘要>（以上是示例）"}
FAIL  A18 BLOCKED template echo  {"state":"blocked","note":"<原因>\", confirm:true"}
PASS  A19 bare placeholder line (control: already guarded)  {"state":"open","attempts":1}
FAIL  A20 backtick-wrapped placeholder summary  {"state":"done","note":"<摘要>`"}
FAIL  A21 placeholder in full-width brackets + prose  {"state":"blocked","note":"【<原因>】等确认后发"}
PASS  E1 summary ≤200 chars, bid dropped, body tail not on disk  {"len":200,"tail":false}
PASS  E2 an answer older than claim.at is ignored  {"state":"open"}
PASS  D1 no session was ever spawned  created=0
PASS  D2 no prompt was ever delivered  prompts=0

=== 25/34 probes passed
```

**同一脚本 + 建议补丁（/tmp 副本）**：

```text
plugin under test: /tmp/opencode/collab-fix.js
=== 34/34 probes passed                     exit=0
$ COLLAB_PLUGIN_PATH=/tmp/opencode/collab-fix.js PROBE_REPO=$PWD \
    node /tmp/opencode/harness-fix.mjs | tail -2
=== 204/204 checks passed                   exit=0
```

---

## 4. 风险清单（除第 1 项阻塞外）

| 级别 | 项 | 说明 |
| --- | --- | --- |
| **H（阻塞）** | 摘要占位符只做精确匹配 | §1.1。修复=2 行（`VERDICT_ECHO_RE = /<[^>]{0,32}>/`），已验证 204/204 + 34/34。修完务必也给 harness 加 1–2 条（`text:"[handoff] DONE <bid> <摘要>", confirm:true}` 整行回显）防回归 |
| M | R1 文案对「回显」的承诺与实现不符 | `collab.js:1187` 说不会被闭环；修完 H 项后成立。若选择不修，则必须改这句文案（否则对端会更倾向信任它） |
| M | 关键词兜底仍会「意见相左」 | `BLOCKED_VERDICT_RE` 把 `已修复/已完成` 判 `blocked`（design 如此）。真做完的 spawn 会话会被记成 blocked；note 保留原文，可人工分辨 |
| L | 一次性窗口被旁观者消耗 | 旁观者刷新把 `claimed` 拍回 `open` 后，发起方再也无法自动提取（C5）。已写入 guide §5.3；建议后续让 `refreshBroadcast` 对 lapsed spawn 保留 `claim`（视为「待提取」）而不是立刻 reopen |
| L | S47/S48/S50 的「无结论 → 原顺延」现在走**旁观者** accept | 它们仍然绿，但不再真正穿过 `extractVerdict → undefined` 这条分支（H2 让旁观者连读都不读）。该分支由 S51 的 8 条无结论用例（发起方触发）与本报告的 A 组覆盖，**覆盖度足够**，只是 S47 的标题容易误读 |
| L | `[handoff] DONE <bid>`（无摘要）会被判 done，note=「DONE」 | 属显式回执形态（目标正确），可接受；仅提示 note 质量 |
| L | 压缩（compaction）后结论可能被裁掉 | `ctx.session.context` 是压缩后视图（guide 已知偏差 #5）→ 退化为顺延，安全但功能失效；需真实会话回归一次 |
| L | 真宿主是否接受 `limit` 未验证 | 回退路径存在（`:1664-1670`），行为等价；重载后建议看一次 `/tmp/trellis-plugin-debug.log` 是否有回退告警 |

---

## 5. 是否可提交

- **不建议现在提交**：10 项里只有第 1 项不通过，但它是 R1 自己制造的最高频形态（逐字回显 R1 命令行），
  会把「什么都没做」的对端会话静默闭环为 `done`，比 pilot 的 G1 更糟（G1 至少停在 `claimed` 能被人工发现）。
- 修法极小且我已验证（2 行 + 2 条 harness 断言）：`VERDICT_ECHO_RE` 替换 `:1159` 的精确匹配。
  修完重跑 `node --check` / `node scripts/collab/handoff-harness.mjs` / `pnpm test:collab` 即回到可提交状态。
- 若业务方选择「先上、后修」：最低限度要 ① 把 guide §5.3 / §10 #11 与 `collab.js:1187` 的「不会被自动闭环」
  改成「回显通常不会被判为回执，但摘要位带尾巴的回显可能误判」；② 重载插件后用一次真实 spawn 回归，确认没有误闭环。
- 本轮其余结论：H2 已实质修复（含跨工作区旁观）、L1/L2 已修、回归 204/204、范围与护栏干净、未重启/未投递/未越界。

---

## 6. 本轮未做 / 限制

- 未做真实会话端到端验证（会读真实会话正文；按硬约束只用自建假 ctx + 伪造 `claim.at`）。
- 未重载/重启服务（约束）；`/api/plugin` 的 `active` 仅代表已加载旧码。
- 未修改任何实现文件；建议补丁只在 `/tmp/opencode/collab-fix.js` 与 `/tmp/opencode/harness-fix.mjs` 上验证。
- 未运行全量 `pnpm typecheck`（本任务只改 `.js`/`.mjs`/`.md`，不参与 TS 工程）。
