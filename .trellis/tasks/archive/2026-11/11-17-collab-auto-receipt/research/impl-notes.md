# 实施记录：强制回执动作 + 租约到期自动提取（11-17-collab-auto-receipt）

> 基线：`HEAD=c7b84f465`（`11-17-collab-hardening` 已归档），harness 155/155 绿。
> 首轮结果：harness 186/186 绿（+31 条）—— 见 §1–§6。
> 复核修复轮（H1/H2/L1/L2/L5，见 §7）：harness **204/204** 绿（+18 条），`pnpm test:collab` exit 0，
> `node --check` 通过；独立探针 `research/impl-probes-h1-h2.mjs` 全绿。
> 新行为仍需插件重载才在运行时生效（本任务按约束未重启）。

## 1. R1 强制动作顺序（文案）

新增一个共享生成器，三处调用点共用同一段文本，保证口径一致：

| 位置 | 说明 |
| --- | --- |
| `.opencode/plugins/collab.js:1133` `handoffActions({ bid, requester, spawn, leaseMin })` | 生成 ① 领取 / ② 回执（DONE + BLOCKED，两行命令）/ ③ 「只分析、不调用工具 = 未完成」；非 spawn 追加 `DECLINE <bid>`（含「N 分钟不答自动顺延」） |
| `.opencode/plugins/collab.js:2055` `deliverAsk()` | 接管请求（`queue` prompt，也是 busy>30min 的叫醒消息）：`发起方：<完整 sid>` + `按顺序完成（三步都不要省略）：` + `handoffActions(...)`；spawn 版不出现 `DECLINE`（没人可顺延，做不了发 BLOCKED） |
| `.opencode/plugins/collab.js:1705` `injectionFor()` | `context` 注入的 `- 接管请求 <bid>：…` 行：`发起方=ses_…` 后接 `handoffActions(...).join(" ")`（保留原「5 分钟不答」措辞，S33/S40 断言不变） |
| `.opencode/plugins/collab.js` `collab_broadcast` 结果（spawn 分支 / 串行 ask 分支） | 两处都改为 `...handoffActions({ bid, requester: me, spawn })`；spawn 分支额外说明「对端不动作时，租约到期会只读提取它的结论并自动闭环」 |
| `.opencode/plugins/collab.js` `collab_accept` 输出 | 回执改为可直接复制：`collab_send {target:"<发起方 sid>", text:"[handoff] DONE <bid> <commit sha 或摘要>", confirm:true}`（保持 S31「含 `[handoff] DONE <bid>`、不含 BLOCKED」） |
| 工具描述 | `collab_accept` / `collab_broadcast` 的 description 补「回执必须真正 `collab_send`，在自己会话里写结论不算回执」「spawn 租约到期会只读提取并自动闭环」 |

命令中的 `bid` 与发起方 `ses_…` 都是完整字面量（R1-2 既有能力），可直接复制。

## 2. R2 租约到期自动提取

纯函数（模块级，易测）：

| 位置 | 作用 |
| --- | --- |
| `.opencode/plugins/collab.js:171` `VERDICT_MESSAGE_LIMIT=10` / `VERDICT_NOTE_LIMIT=200` | 一次最多看尾部 10 条消息；摘要上限 200 字 |
| `:1039` `HANDOFF_VERDICT_RE` / `VERDICT_BID_RE` | 显式 `[handoff] DONE|BLOCKED <bid> <摘要>` 优先；摘要里去掉裸 `bid` |
| `:1046` `BLOCKED_VERDICT_RE` / `DONE_VERDICT_RE` / `:1054` `ANALYSIS_DONE_RE` | 强关键词 → `blocked`；通用完成词 → `done`；「分析/核对…完成」先剔除再判 `done` |
| `:1067` `assistantText()` / `:1087` `assistantTexts(messages, {since})` | 只取 `type/role === "assistant"` 的 text 段（`content[]` / `parts[]` / 裸 `text` 三种形状），按 `time.created >= claim.at` 过滤，取尾部 10 条 |
| `:1108` `verdictFromTexts(texts)` | 判定顺序：最近一条含 `[handoff] …` → 采用；否则只对**最后一条**做关键词判定（blocked 先于 done）；都不中 → `undefined` |

刷新路径（`createHandoffChain` 内，读路径统一入口）：

| 位置 | 作用 |
| --- | --- |
| `:1599` `assistantAnswer(sessionID, {since})` | `ctx.session.context({ sessionID })`（= `GET /api/session/{sid}/context`，`Session.Message.Info[]`），try/catch → `[]` |
| `:1625` `extractVerdict(sessionID, {since})` | 只读、绝不抛错；失败/无结论 → `undefined` |
| `:1644` `refresh(record, now)` | 仅当 `state=claimed` && `claim.kind=spawn` && `from.sid` 存在 && 租约过期 → 先做 `[protected*]` 血缘检查（命中则不读、走原逻辑）→ `extractVerdict`。命中：`releaseLock` + 返回 `{ state: done|blocked, receipt:{ from, by, at, note(≤200), auto:true }, replies+1, autoVerdictAt }`（**不 `attempts++`、不 reopen、不 spawn**）；未命中：原样返回 `refreshBroadcast()` 结果 |

接入点（全部是既有刷新点，不新增轮询/后台任务）：

| 位置 | 说明 |
| --- | --- |
| `:1705` `injectionFor` | `persistRefresh(raw, await refresh(raw, now))`（每记录 1 次读） |
| `:1545` `applyReceipt` / `:1582` `applyDecline` | 改为 `async`，逐条 `await refresh`，避免「先被 reopen 再回执」的竞态；事件处理器 `await chain.applyReceipt/applyDecline` |
| `collab_accept` | `persistRefresh(existing, await chain.refresh(existing, now))` → 自动闭环时直接返回「已闭环（state=…）」 |
| `collab_broadcast`（同一 bid 幂等）/ `collab_handoff`（同一 bid 幂等） | 同样改为 `await chain.refresh(...)`，重复广播不再把已到期 spawn 重新投递 |

提醒逻辑：`injectionFor` 的「交接未闭环」分支跳过 `done` / `blocked`（`expired` 仍提醒，需人接手）。
`collab_list` 保持只读（S41 不变）。

## 3. 新增 harness 用例（`scripts/collab/handoff-harness.mjs` S44–S50，+31 条，155 → 186；复核后 S51–S52 再 +18 → 204，见 §7；第二轮复核后 S53 再 +8 → 212，见 §8）

| 用例 | 覆盖 |
| --- | --- |
| S44（8 条） | 接管请求文案含 ①②③ / 完整 `bid` + `发起方=ses_req` / 可复制 `collab_accept` / DONE+BLOCKED `collab_send` / 「只分析、不调用工具 = 未完成」/ DECLINE + 5 分钟；spawn prompt 同样三要素；广播结果同样三要素 |
| S45（7 条） | 伪造 `claim.at = now-301s` + 对端 `[handoff] BLOCKED`：自动 `blocked`、`receipt.auto`、`from/by`=对端 sid、摘要含「已实施」、`attempts` 仍 0、不 spawn、不投递、spawn lock 释放、再 accept 只报「已闭环」 |
| S46（4 条） | 关键词：`已实施/无需` → `blocked`，`完成` → `done`；已闭环不再给发起方「交接未闭环」提醒；不 spawn |
| S47（4 条） | 无结论 → 原顺延（`attempts=1`、`skipped`、可被成员接手、无 receipt）；「核对完成」不判 done |
| S48（3 条） | `ctx.session.context` 抛 404 → 不抛错、走原逻辑；只有 user 消息（无 assistant 文本）→ 走原逻辑 |
| S49（2 条） | 超长回答：`note.length <= 200`、去掉 `bid`、`TAIL-MARKER`（正文尾部）不出现在记录文件里 |
| S50（3 条） | 未到期的 spawn claim 不提取；`kind=accept` 的过期 claim 不提取；`[protected]` 承接方不读不闭环 |

测试全部用假 ctx + 直接写 broadcast 文件 + 伪造 `claim.at`，**没有**创建/删除任何真实会话，也没有对
`/data/project/muke-interface` 做任何操作。

## 4. 文档

- `.trellis/spec/guides/cross-workspace-collab-guide.md`
  - §4-3：接管请求行写明三步动作（accept / 回执 / DECLINE 均可复制）
  - §5.2：接管请求改为 ①②③ 文本块 + 为什么写成三步（引用 pilot G1）
  - §5.3：新增「租约到期自动提取」表（显式前缀 / 关键词 / 无法判定）+ 边界（只 spawn、只最后一条、`since=claim.at`、protected 不参与、200 字摘要）
  - §6：记录结构补 `receipt.auto` / `autoVerdictAt`；状态语义补「自动闭环」与提醒差异
  - §8：回执解析失败分支补自动提取
  - §9 隐私行：只读路径与「只存 ≤200 字摘要 + 来源 sid」
  - §10 新增 #11：G1 现象 + 三条处置 + 误判控制
  - §11 验收清单 +5 条（S44–S50），回归门计数 186
- `docs/collab.md` §12.2 / §12.3 / §12.5：`receipt.auto`、三步文案、⑥ 闭环的自动提取分支、限制 #10

## 5. 原始输出

```text
$ node --check .opencode/plugins/collab.js
(no output, exit 0)

$ node scripts/collab/handoff-harness.mjs | tail -3
  ✓ S50 a live spawn lease is never extracted — {"state":"claimed","attempts":0}
  ✓ S50 a lapsed accept-kind claim is not extracted either — {"state":"open","attempts":1}
  ✓ S50 a protected claimant is never read and never auto-closed — {"state":"open","attempts":1}

=== 186/186 checks passed
exit=0        # 0 条 ✗ 断言

$ pnpm test:collab >/tmp/tc2.log 2>&1; echo $?
0
=== 186/186 checks passed

$ node_modules/.bin/vp fmt --check scripts/collab/handoff-harness.mjs
All matched files use the correct format.

$ node_modules/.bin/vp lint scripts/collab/handoff-harness.mjs
(no findings)

$ opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD" | jq '.data[] | select(.id|startswith("collab"))'
{"id":"collab-global","source":{"type":"local","path":"/root/.config/opencode/plugins/collab-global.js"},"features":{"server":true},"state":{"status":"active"}}
{"id":"collab","source":{"type":"local","path":"/data/project/muke-pos-app/.opencode/plugins/collab.js"},"features":{"server":true},"state":{"status":"active"}}
```

S45 自动闭环后的记录（harness 打印）：

```json
{"state":"blocked","attempts":0,
 "receipt":{"from":"ses_spawn_auto","by":"ses_spawn_auto","at":1794894871169,
            "note":"该提案已实施（f2f8ef52/79eac02d），无需 implement","auto":true}}
```

## 6. 未验证 / 需要注意

1. **真实宿主上 `ctx.session.context` 的历史消息范围**：harness 里是 fake ctx；线上语义来自
   `GET /api/session/{sessionID}/context`（openapi 实测返回 `{data: Session.Message.Info[]}`），
   与「最后一次 compaction 之后的消息」等价（guide 已知偏差 #5）。若线上 context 不含最后一条 assistant，
   自动提取会退化为「判定不出 → 原顺延」，不会报错、不会误闭环。**未做真实会话端到端验证**。
2. **新行为需要插件重载才生效**：本任务按约束没有重启服务 / 没有 `opencode service restart`；
   `/api/plugin` 显示 `active` 只是「已加载」，运行时跑的还是旧代码。重启后的第一次 `context` 注入/`collab_accept`
   才会走新逻辑。
3. **关键词误判**：`已完成` 归 `blocked`（design 口径），因此对端若写「已完成核对」会被判为 `blocked`；
   `ANALYSIS_DONE_RE` 只挡「核对完成」这种语序。真实语料有限，后续若发现误判可在
   `BLOCKED_VERDICT_RE` / `ANALYSIS_DONE_RE` 上收紧。复核轮已补否定语/计划语护栏与 `[handoff]` 目标校验（§7），
   但**关键词兜底**本身仍是启发式（例如「已完成核对」仍判 `blocked`），保守取舍见 guide §5.3。
4. **每记录 1 次读取**：仅在 `claimed + spawn + 租约过期` 时才读；但一次 `context` 注入/回执解析会遍历目录下
   所有记录，长期不清的目录（>7 天未写入）会让单次刷新变慢（设计上限「1 次/记录/刷新」）。
5. `applyReceipt` / `applyDecline` 由同步改异步：只影响 inbox 事件处理器（已 `await`），未发现其它调用方；
   harness 的 S28/S30c/S33/S36/S40 全绿。
6. 未对 `docs/issues/**`、`packages/**`、`apps/**`、`bench/**`、`/data/project/muke-interface` 做任何写操作；
   未做任何 git 写操作（工作区里其它文件的修改来自其它会话）。

## 7. 复核修复轮（H1 / H2 + L1 / L2 / L5）

> 输入：`research/check-report.md`（H1 误判 done、H2 越权闭环、L1–L5），复现脚本 `research/check-independent-r2.mjs`。
> 只改 `.opencode/plugins/collab.js` / `scripts/collab/handoff-harness.mjs` / guide / `docs/collab.md` /
> `docs/development.md` / 本任务目录；无 git 写操作、未重启服务、未触碰真实会话与 `/data/project/muke-interface`。

### 7.1 H1：模板回显 / 否定语不再被判成 done

| 位置 | 改动 |
| --- | --- |
| `collab.js:1039` `HANDOFF_VERDICT_RE` | 注释改为「同一行也是 R1 模板」，说明必须做目标校验；匹配本身保持 `[handoff]\s*(DONE\|BLOCKED)` |
| `collab.js:1047` `VERDICT_PLACEHOLDER_RE` | `<bid>` / `<摘要>` / `<原因>` 这类占位符 ≠ 目标 |
| `collab.js:1054` `VERDICT_NEGATION_RE` | 否定护栏：`不会\|未完成\|没有完成\|没完成\|尚未\|无法完成\|不能完成\|做不到\|还没\|未开始\|not (yet )?done\|not yet\|haven't\|did not\|didn't\|unfinished\|incomplete` → 直接 `undefined` |
| `collab.js:1061` `VERDICT_PENDING_RE` | 计划/承诺语护栏：`完成后\|完之后\|之后我会\|稍后\|接下来\|待(我\|确认\|环境)\|先(确认\|看\|核对)\|打算\|计划\|将会\|将要\|我会(按\|先\|发\|在\|照)` → `undefined` |
| `collab.js:1136` `verdictFromTexts(texts, { bid })` | ① **只判最后一条有文本的回答**（不拼接、不回看更早的回答）；② 先过否定/计划护栏；③ 有 `[handoff]` 提及时，目标必须**等于当前 bid**，占位符/其它 bid/无目标/摘要位是 `<摘要>` → 整条判 `undefined`（**不再**回落到关键词）；④ 无 `[handoff]` 时才走关键词兜底（blocked 先于 done，`ANALYSIS_DONE_RE` 保留） |
| `collab.js:1182` `handoffActions` ③ | 文案补一句「② 里的文字只是格式示例——复述/回显它不算回执，也不会被自动闭环」，从源头降低回显概率 |
| `collab.js:1678` `extractVerdict(sessionID, { since, bid })` | 传入当前 `bid` |
| `collab.js:1739` `refresh` | `extractVerdict(..., { bid: current.bid })` |

自查覆盖面（双向都测）：回显 `<bid>` 模板 / 回显「我会按提示发 `[handoff] DONE <当前bid>`」/ 回显其它 bid / `我不会发…` /
`任务未完成` / `无法完成` / `not done yet` / 「第 1 条模板 + 第 2 条还没开始」→ 全部 `open + attempts=1 + 无 receipt`；
真 `[handoff] DONE <当前bid>` → `done`，真 `[handoff] BLOCKED <当前bid>` → `blocked`。

### 7.2 H2：只有发起方触发的那次刷新能闭环

| 位置 | 改动 |
| --- | --- |
| `collab.js:1705` `refresh(record, now, { actor })` | 租约/`kind`/`from.sid` 门槛之后新增：`if (!actor \|\| String(actor) !== String(current.from.sid)) return refreshBroadcast(record, now)` —— 旁观会话只走原顺延/租约逻辑，**不读对端正文、不写 receipt** |
| `collab.js:1778` `injectionFor` | `refresh(raw, now, { actor: sessionID })` |
| `collab.js:1595` `applyReceipt` / `collab.js:1631` `applyDecline` | `{ actor: from }`（回执/拒绝消息的发送者） |
| `collab.js:2759` `collab_accept` / `collab.js:2341` `collab_broadcast`（幂等）/ `collab.js:2633` `collab_handoff`（幂等） | `{ actor: me }`（工具调用者 = `context.sessionID`） |
| `collab.js:1652` `assistantAnswer` | L1：先请求 `ctx.session.context({ sessionID, limit: VERDICT_MESSAGE_LIMIT })`（design §2 的 `?limit=10`），宿主不支持/报错时回退到无 `limit` 的旧读法，仍失败才 `[]` |

副作用（一致、已写进 guide）：旁观会话触发的刷新仍按原逻辑顺延，会让 `claimed` 回到 `open`（一次性窗口），
因此自动提取实际只发生在**发起方自己**触发的那次刷新里。

### 7.3 新增回归（`scripts/collab/handoff-harness.mjs` S51–S52，+18 条，186 → 204）

| 用例 | 覆盖 |
| --- | --- |
| S51（14 条，`:2349`） | 8 条单条回答的「不该闭环」：`<bid>`/`<摘要>` 模板回显、其它 bid 回显、`我不会发 [handoff] DONE`、`任务未完成`、`无法完成`、`not done yet`、`[handoff] DONE <其它bid>`、`[handoff] DONE` 无目标；1 条「第 1 条回显 + 第 2 条还没开始」；1 条「较早结论被较新无结论回答覆盖 → 不采纳」；2 条真 `DONE`/`BLOCKED <当前 bid>` 正向闭环（含 `receipt.auto` 与摘要内容）；1 条 tool-only 末条 → 回落到最后一条有文本的回答；1 条「全程 0 spawn / 0 prompt」 |
| S52（4 条，`:2447`） | 同工作区旁观会话刷新：**不读**对端（`ctx.session.context` 调用打点）、不闭环（走原顺延 `open + attempts=1`）；其它工作区会话同样不读不闭环；发起方（`ses_req`）刷新：读到对端并闭环为 `blocked` |

既有用例的调整（H2 的直接后果）：
- S45 / S49 原来用「旁观者 `collab_accept`」触发刷新；现在改为**发起方 `ses_req` 的 `context` 注入**触发（与生产一致），
  随后再断言 `collab_accept` 报「已闭环」。
- S47 / S48 / S50 的「走原逻辑」断言语义不变（H2 下旁观者本来就只走原逻辑）。

### 7.4 文档

- guide §5.2 ③：补「回显模板不算回执」；§5.3 自动提取表新增「模板回显/其它 bid/无目标」「否定语/计划语」两行，
  改为「只判最后一条有文本的回答」「只有发起方触发时才提取（旁观者不读不闭环）」「预览也可能落 `receipt.auto`」（L3），
  并修正「显式 `[handoff]` 在最近几条里回溯」的旧措辞（L5）。
- guide §6：`receipt` 示例去掉手动回执不存在的 `auto:false` 字段（L5）；「自动闭环」改为「发起方自己触发的那次刷新」。
- guide §10 #11 / §11：补 S51/S52 与新的误判控制；回归门计数 186 → 204。
- `docs/collab.md` §12.2（`auto?`）、§12.3 ⑥（目标校验/否定语/旁观者）、§12.5 #10 同步。
- `docs/development.md:119`（L2）：`155 checks` → 「以脚本实际输出为准，当前 204 checks」。

### 7.5 原始输出

```text
$ node --check .opencode/plugins/collab.js
(no output)                                   node-check exit=0

$ node scripts/collab/handoff-harness.mjs
  ✓ S51 a template echo with <bid>/<摘要> placeholders is not auto-closed — {"state":"open","attempts":1}
  ✓ S51 a template echo carrying a foreign bid is not auto-closed — {"state":"open","attempts":1}
  ✓ S51 a negated receipt is not auto-closed — {"state":"open","attempts":1}
  ✓ S51 「任务未完成」 is not auto-closed — {"state":"open","attempts":1}
  ✓ S51 「无法完成」 is not auto-closed — {"state":"open","attempts":1}
  ✓ S51 「not done yet」 is not auto-closed — {"state":"open","attempts":1}
  ✓ S51 a `[handoff] DONE` line for another bid is not auto-closed — {"state":"open","attempts":1}
  ✓ S51 a `[handoff] DONE` line with no target is not auto-closed — {"state":"open","attempts":1}
  ✓ S51 an echo in an older answer never outvotes the last answer — {"state":"open","attempts":1}
  ✓ S51 a verdict superseded by a later (undecided) answer is not adopted — {"state":"open","attempts":1}
  ✓ S51 a real `[handoff] DONE <current bid>` closes as done — {"state":"done","note":"已修复并提交 79eac02d"}
  ✓ S51 a real `[handoff] BLOCKED <current bid>` closes as blocked — {"state":"blocked","note":"该提案已实施，无需改动"}
  ✓ S51 a tool-only last message falls back to the last answer with text — {"state":"done","note":"实现完成，测试通过。"}
  ✓ S51 no H1 case spawns a session or prompts anyone — created+0 prompts+0
  ✓ S52 a bystander never reads the counterpart's answer — (no reads)
  ✓ S52 a bystander never closes the bid (old lease path only) — {"state":"open","attempts":1}
  ✓ S52 a session of another workspace never reads or closes either — {"read":false,"state":"open"}
  ✓ S52 the requester's own refresh reads the answer and closes the bid — {"read":true,"state":"blocked"}

=== 204/204 checks passed                        harness exit=0  (✗ 计数 = 0)

$ pnpm test:collab
=== 204/204 checks passed                        test:collab exit=0

$ node .trellis/tasks/11-17-collab-auto-receipt/research/impl-probes-h1-h2.mjs
template echo <bid>/<摘要>               → state=open     attempts=1 note=null
template echo, real bid, in a promise  → state=open     attempts=1 note=null
template echo, foreign bid             → state=open     attempts=1 note=null
negated receipt                        → state=open     attempts=1 note=null
任务未完成                                  → state=open     attempts=1 note=null
无法完成                                   → state=open     attempts=1 note=null
not done yet                           → state=open     attempts=1 note=null
echo in #1 + not started in #2         → state=open     attempts=1 note=null
genuine DONE (current bid)             → state=done     attempts=0 note="已修复并提交 79eac02d"
genuine BLOCKED (current bid)          → state=blocked  attempts=0 note="该提案已实施，无需 implement"
keyword done                           → state=done     attempts=0 note="实现完成，测试通过。"
keyword blocked                        → state=blocked  attempts=0 note="核对了 37 处调用点，该提案已实施，无需再改。"
H2 bystander                             → read=false state=open attempts=1
H2 requester                             → read=true state=done note="已修复"

=== H1/H2 probes: all as expected                exit=0

$ vp fmt --check <3 files>
All matched files use the correct format.
$ vp lint <3 files>
(no findings)                                    lint exit=0
```

### 7.6 与复核脚本的关系（`research/check-independent-r2.mjs`）

该脚本是**复核当时的版本**，未随本轮改动更新，两处预期已按新语义变化，跑它出现 FAIL 属预期：

1. 它全部用「旁观者 `ses_other` 调 `collab_accept`」触发刷新 → H2 下不再提取，所以其 R2 段（PASS 1–11）不再成立；
   本轮用 `research/impl-probes-h1-h2.mjs`（同一套假 ctx 思路，但以**发起方 `ses_req`** 触发）复现同组行为，全绿。
2. 它的 PASS 12 / PASS 20 断言「更早回答里的 `[handoff]` 在窗口内仍被采纳」→ H1.5 改为**只判最后一条有文本的回答**，
   该行为被有意取消（正是「模板在第 1 条、真结论在第 2 条」的误判来源），harness S51 反向覆盖。

### 7.7 未做 / 仍需注意

- 未重启/重载服务：新逻辑在运行时仍要等插件重载（与 §6 #2 一致）。
- 未做真实会话端到端验证（含 `limit` 参数是否被宿主接受；不支持时自动回退全量读，行为等价）。
- 关键词兜底仍是启发式（如「已完成核对」→ `blocked`），取舍是「宁可人工兜底」。

## 8. 第二轮复核修复（H1 残留：整行回显 R1 命令被误闭环）

复核报告：`research/check-report-round2.md`（结论「不通过，只剩 1 处阻塞」），复现脚本
`research/check-round2-probes.mjs`（34 项，修复前 25 PASS / 9 FAIL）。

### 8.1 根因

R1 文案本身在**对端会话的 prompt 里**印着
`collab_send {target:"ses_…", text:"[handoff] DONE b_… <摘要>", confirm:true}`。
对端逐字复述这一行时，摘要位留下的是 `", confirm:true}`、反引号或 `（以上是示例）` / `【<原因>】`，
而旧检查 `VERDICT_PLACEHOLDER_RE = /^<[^>]*>$/` 要求摘要**整串恰好**是占位符 → 精确匹配失败 → 被判
`done`/`blocked` → bid 自动闭环、锁释放、不重投。比 pilot 的 G1 更糟（G1 至少停在 `claimed` 可被人工发现）。

### 8.2 修法（`collab.js`）

```js
// 新增（紧随 VERDICT_PLACEHOLDER_RE）
/** H1 (round 2): any `<…>` token anywhere in the summary slot is a leftover
 *  template placeholder, not a receipt. */
const VERDICT_ECHO_RE = /<[^>]{0,32}>/

// verdictFromTexts 摘要位检查
- if (VERDICT_PLACEHOLDER_RE.test(summary)) continue
+ if (VERDICT_ECHO_RE.test(summary)) continue
```

- 只放宽「摘要位含占位符」这**一种**拒绝条件，其它闸门不变：目标必须等于当前 bid、
  否定语 / 计划语护栏、只看最后一条有文本的 assistant、`[protected*]` 与旁观者不参与。
- `verdictFromTexts` 的文档注释与 `VERDICT_ECHO_RE` 注释同步说明「整行照抄 R1 不算回执」。
- 该规则天然覆盖 `BLOCKED` 分支（`state` 由 `mention[1]` 决定，摘要检查在同一处）。
- 目标位仍用 `VERDICT_PLACEHOLDER_RE`（token 是**恰好** `<bid>` 才算占位），不受影响。

### 8.3 新增回归（`scripts/collab/handoff-harness.mjs` S53，+8 条，204 → 212）

| 断言 | 覆盖 |
| --- | --- |
| 整行回显 `text:"[handoff] DONE <bid> <摘要>", confirm:true}` | 复核 A2 / A14 / A15 |
| 「收到交接。执行：② 回执（必发，二选一）: …<摘要>", confirm:true}` | 复核 A15（含计划外的确认语） |
| `[handoff] DONE <bid> <摘要>（以上是示例）` | 复核 A17 |
| `[handoff] BLOCKED <bid> 【<原因>】等确认后发` | 复核 A21 |
| 反引号包裹 `` `[handoff] DONE <bid> `<摘要>` ` `` | 复核 A3 / A20 |
| `text:"[handoff] BLOCKED <bid> <原因>", confirm:true` | 复核 A18 |
| **正向对照**：`[handoff] DONE <bid> 修好了` → `done` + `note === "修好了"` | 防过度拒绝 |
| S53 全部回显用例 `created+0 prompts+0` | 不拉新 / 不投递 |

文件头注释同步补 S53 说明。

### 8.4 文档同步

- `guide §5.3`：判定表新增一行「摘要位仍残留任意 `<…>`（整行照抄 R1 / 反引号 / `（以上是示例）` / `【<原因>】`）→ 不判定」。
- `guide §11`：验收清单新增 S53 一条；计数 204 → **212**（含 §11 回归门命令注释）。
- `docs/collab.md §12.3 / §12.5`：自动闭环说明补「摘要位残留任意 `<…>` 不算回执」及具体形态。
- `docs/development.md`：harness 计数 204 → **212**。
- R1 文案里「复述/回显它不算回执，也不会被自动闭环」这句**现在成立**，无需改文案。

### 8.5 原始输出

```text
$ node --check .opencode/plugins/collab.js
(no output)                                    exit=0

$ node scripts/collab/handoff-harness.mjs | tail -6
--- S53 a genuine receipt next to the echoes
{"state":"done","note":"修好了"}
  ✓ S53 a real `[handoff] DONE <current bid> 修好了` still closes — {"state":"done","note":"修好了"}
  ✓ S53 the echoes spawn nothing and prompt nobody — created+0 prompts+0

=== 212/212 checks passed                  exit=0

$ pnpm test:collab >/dev/null; echo $?
0                                          （212/212）

$ node .trellis/tasks/11-17-collab-auto-receipt/research/check-round2-probes.mjs | tail -3
PASS  D2 no prompt was ever delivered  prompts=0

=== 34/34 probes passed                    exit=0
```

修复前同一复核脚本为 25/34（9 条 FAIL 全是同一根因），现 34/34。

### 8.6 未做 / 仍需注意

- 未重载/重启服务：新行为仍需插件重载后生效。
- 未做真实会话回归（复核报告 §6 同限制）；`limit` 参数的真实宿主兼容性仍未验证（回退路径存在）。
- 本轮未改 `packages/**` / `apps/**` / `bench/**` / `docs/issues/**`，无 git 写操作。
