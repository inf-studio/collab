# 增量复核报告（fix round）：collab 交接协议的 F1–F6

> 复核人：冷上下文增量复核（`trellis-check`，**只审不改**，未改任何实现文件）
> 复核对象：工作区**未提交改动**（fix round），基线提交 `86dd69ff5`
> 输入：`research/check-report.md`（上一轮「有条件通过」）+ `research/fix-notes.md`
> 复核时间：2026-11-17 07:25–07:31（本机 opencode v2.3.0，插件热重载后为修复版代码）
> 范围：只审这一轮对复核缺陷的改动（F1/F2/F3/F4/F6 + 用例 + 文档），**不重复**上一轮已通过的主链路 / 去重 / 权限结论

## 0. 结论

**通过（可提交），附 1 条应修（P2，文档口径）+ 2 条建议（P3）。**

F1（阻断）与 F2/F3/F4/F6（应修）在确定性复现下均成立，且比上一轮多做了三件事：
血缘护栏覆盖**两条**受保护线的子/孙会话、`collab_list` 标注、`collab_wait` 快速失败。
唯一与实现不符的是**血缘深度口径差了 1 级**（实测覆盖 7 跳祖先，文档写「最多上溯 8 级 / 任意层级」），
以及两条同类的残留（血缘链路断裂时 fail-open、`kind:"note"` 未纳入参与者校验）。

| # | 项 | 结论 |
| --- | --- | --- |
| F1 | 血缘护栏（子/孙会话、深度、防环、list 标注） | **通过**（深度口径差 1 级 → 见 §10.1） |
| F2 | reply 参与者 + 路由 + 无 session 降级 | **通过**（`note` 未纳入 → §10.3） |
| F3 | thread 复用（重开 / 不吃旧回执 / 重新提醒 / 旧数据退化） | **通过** |
| F4 | legacy 无 thread 消息的注入文案 | **通过** |
| F6 | `collab_wait` 格式校验 + 未知 thread 快速失败 | **通过**（0–1ms） |
| 回归 | harness 24/24 exit 0、`node --check` 0、插件 active | **通过** |
| 范围 | 仅 6 个在册文件；无 `packages/**`、`apps/**`、`bench/**`、`docs/issues/**` 改动 | **通过** |

**是否可提交：可以**（见 §0.1 的提交前建议）。

### 0.1 提交前建议（非阻断）

1. （P2）把深度口径改准：`docs/collab.md:294`「最多上溯 `MAX_LINEAGE_DEPTH=8` 级」、`:329` 与 `collab.js:712`
   的「任意层级子会话」→ 实测是 **目标 + 7 跳祖先**。要么把 `collab.js:404` 改成 `depth <= MAX_LINEAGE_DEPTH`，
   要么把文案改成「最多 7 级祖先」。**不需要**为本条重跑回归。
2. （P3，可选）`docs/collab.md:299` 的「护栏是 **fail-closed**」建议明确限定为「回执同样受限」，
   并补一句「血缘读取失败时按未受保护处理（fail-open）」——实测 §2.5 的断裂链路路径会放行。
3. （P3，可选）`kind:"note"` 也可写进别人 thread（§10.3），可按需把参与者校验扩到「非 request」，或文档注明。

## 1. 复核方法

- **没有**只靠任务自带 harness：另写了 3 个独立探针（`/tmp/collab-fix-review{,2,3}.mjs`），
  用不同的假 ctx fixture（不同的会话集、链深、别名表、无 session 上下文调用）驱动**同一份插件文件**，
  逐项断言 F1–F6，并**故意构造**文档没写的边界（8 跳、断裂链路、自环、`note` 越权）。
- 真实服务侧只做 `GET`（插件状态、`Session.Info.parentID`、插件重载时间），未创建会话、未投递。
- `docs/collab.md` 的 fmt 结论用「HEAD 版本 vs 工作区版本」对照，避免把历史欠账算在这一轮。

## 2. F1 血缘护栏（阻断项）— 通过

**实现位置**：`createLineage` / `protectedAncestor`（`.opencode/plugins/collab.js:350-415`，主循环 `:404`），
`dispatch` 先查血缘再投递（`:702-715`），`collab_list` 标注（`:860-913`，标记 `:878-891`）。

复现（假 ctx，`parentID` 链；无任何真实投递）：

```
=== A. F1 lineage guard ===
PASS  A1 direct child of protected session refused  -- 1ms | 拒绝投递：目标 ses_child 的祖先（第 1 级）ses_e1eb91cebffeTv1467ubJLKebk 在 protect 名单内（…）。未发送任何内容。
PASS  A1 names ancestor + depth 1
PASS  A2 grandchild refused (multi-hop)          -- 0ms | …的祖先（第 2 级）ses_e1eb91cebffeTv1467ubJLKebk…
PASS  A3 child of the other protected line refused -- 0ms | 目标 ses_mainchild 的祖先（第 1 级）ses_e23a4a23fffe4c4m7UQFR8dUL3…
PASS  A3 nothing delivered by any refused attempt (depth<=7)  -- prompts 0->0
PASS  A4 ordinary session still deliverable      -- 已投递 → ses_bbb agent=explore …
PASS  A5 self-parent cycle does not hang (delivery allowed, <1500ms)  -- 0ms
PASS  A6 list marks child [protected-child]      -- ses_child trellis-implement idle --:--:-- "child" [protected-child] parent=ses_e1eb…Kebk
PASS  A6 list prints parent=<short> for child
PASS  A7 list marks grandchild [protected-child] -- ses_grand … [protected-child] parent=ses_chil…hild
PASS  A8 list keeps plain self mark only for current session -- ses_aaa build idle --:--:-- "A" [self]
PASS  A9 protected line itself marked [protected] -- ses_e1eb91cebffeTv1467ubJLKebk … alias=schema [protected]
PASS  A10 fallback to session.list still refuses the child -- 0ms  （ctx.session.get 隐藏 parentID 时的回退路径）
```

要点逐条对账：

- **祖先逐级生效**：直系子（1 级）、孙级（2 级）、另一条受保护线（`ses_e23a…dUL3`）的子会话均被拒绝，
  错误文案点名**命中的祖先 id 与层级**；普通会话仍可正常投递（A4），没有把护栏扩大化。
- **深度上限 / 防环**：`parentID` 自环（`ses_cycle.parentID = self`）在 0ms 内返回、不死循环（`seen` 兜底，`:401-407`）。
- **回退路径**：`ctx.session.get` 不返回 `parentID` 时走 `ctx.session.list()`（`:379-383`），A10 证明护栏仍生效
  —— 这条路径 fix-notes 自述「只在假 ctx 覆盖过」，本次**独立复现成立**。
- **`collab_list`**：`[protected]` / `[protected-child]` / `[self]` 三种标记互不串味，
  且 `parent=<short>` 对子会话可见；文案末行明示两类均不可投递。
- **真实宿主**：`ctx.session.get` 对应的 `GET /api/session/{id}` 在 v2.3.0 确实带 `parentID`
  （见 §7 原始输出），即主路径在本机可用，回退只是保险。

**唯一偏差（应修，文档口径）**：深度覆盖是「目标 + 7 跳祖先」，不是 8 跳。实测边界：

```
info depth boundary: ses_d6: REFUSED (6 hops) | ses_d7: REFUSED (7 hops) | ses_d8: DELIVERED | ses_d9: DELIVERED | ses_d10: DELIVERED
info: unreadable 中间链路（受保护祖父） -> DELIVERED
```

`for (let depth = 0; current && depth < MAX_LINEAGE_DEPTH; depth++)` 的 8 次迭代里第 0 次查的是目标本身，
因此只上溯 7 级。**实际影响可忽略**（子代理派生只有 1–2 级），但 `docs/collab.md:294`、`:329`、
`collab.js:712` 的「任意层级」是绝对表述，与实测不符 —— 属「文档一致性」问题，不是护栏失效（F1 的阻断目标达成）。

**残留（P3）**：血缘链**中间一环读不到**时（`nodeOf` catch → `node=undefined` → `current=""` → 返回 undefined），
护栏 fail-open（实测该会话被投递成功）。只有「受保护祖先本身被删除/不可读」这种非常规状态才会触发。

## 3. F2 reply 参与者 / 路由 — 通过

**实现位置**：`collab_send` 的 reply 分支（`collab.js:971-998`）、`collab_reply`（`:1024-1060`）、
`waitForReply`（`:790-808`）。三项检查都在 **`dispatch` 之前**，因此拒绝时既不投递也不写 thread。

```
=== B. F2 reply participants + routing ===
PASS  B1 non-participant collab_reply refused  -- 0ms | 拒绝回执：当前会话 ses_ccc 不是 thread t_… 的参与方（发起方 ses_aaa，对端 ses_bbb）。未发送任何内容。
PASS  B2 non-participant collab_wait refused   -- 1ms | 拒绝等待：当前会话 ses_ccc 不是 thread t_… 的参与方（…）
PASS  B3 reply misrouted to unrelated target refused -- 0ms | 拒绝回执：thread t_… 的对端是 ses_aaa，与 target ses_ddd 不一致。回执请用 collab_reply {threadID}（自动路由）。未发送任何内容。
PASS  B4 non-participant kinds:reply refused  -- 0ms | 拒绝回执：当前会话 ses_ccc 不是 thread … 的参与方（…）
PASS  B5 thread untouched by refusals         -- msgs 1->1 status open->open
PASS  B6 no prompt delivered by refusals      -- prompts 3->3
PASS  B6 nothing ever delivered to ses_ddd
PASS  B7 participant reply accepted + routed to requester -- kind=reply thread=t_… status=answered（prompt 落回 ses_aaa）
PASS  B8 requester can wait its own thread
PASS  B9 session-less call is annotated (no silent pass)  -- 注: 无会话上下文（无 sessionID）：未校验 reply 的参与者与对端。
PASS  B10 session-less wait is annotated       -- 注: 无会话上下文（无 sessionID）：未校验参与者身份。
```

- 上一轮的 T1（第三方伪造回执）/ T2（误路由污染他人 thread）/ T3（任意读）三条均**复现失败**（即被拒绝）。
- **thread 未被写入**：`msgs` 数量、`toSession`、`status` 三重比对无变化；无关目标 `ses_ddd` 从未收到 prompt。
- **无 session 上下文的降级被明确注明**（B9/B10 实测有 `注:` 行），不是静默放行；
  `docs/collab.md:371-372`、§11.6 第 5 条也写了同一件事。
- 别名路径不会误判：参与者用别名指向**真对端**时正常通过（`alias=bee → ses_aaa`，probe2）。
- 合法链路未被误伤：`collab_reply` 从只读 agent 调用仍 `mode=queue(forced)`，回执可达发起方。

## 4. F3 thread 复用 — 通过

**实现位置**：`appendThreadMessage` 的 status 计算（`collab.js:532-537`，request → `open`）、
`waitForReply` 用**追加顺序**定位最后一次 request（`:813-820`）。

```
=== C. F3 thread reuse ===
PASS  C1 round1 status answered
PASS  C2 second request reopens (open) -- open
PASS  C3 wait does not return the stale round1 reply -- 1000ms | 等待回执超时：… 只看最后一次 request 之后的回执…
PASS  C4 receiver hook reminds again on reuse (thread reopened) -- [{"type":"text","text":"[collab] 待处理请求 1 条\n- request t_… from=ses_aaa: C round2 → 处理后用 collab_reply {threadID:\"t_…\"}\n全文/状态用 collab_inbox。"}]
PASS  C4b answered thread is not re-reminded -- []      （阴性对照：同一 inbox 记录在 answered 后不再提醒）
PASS  C5 round2 reply returned, round1 not
PASS  C6 old thread without a request record still readable -- thread t_legacy_0001 收到回执（status=answered）
```

- `status` 回 `open` → 接收方 hook 重新提醒（C4）；同一 inbox 记录在 `answered` 后不提醒（C4b），
  证明提醒确实由**状态**驱动，不是「第二次一定提醒」。
- 复用后 `collab_wait` **不会**立刻返回上一轮回执（C3 超时），第二轮回执到达后返回新内容（C5）。
- **旧数据安全退化**：没有 request 消息的历史 thread（`lastRequest = -1`）退化为「任意 reply」（C6），
  未抛错、未空等 —— 与 fix-notes §3 一致。
- 用**下标**而不是 `ts` 判定先后：同毫秒多条消息不会被误排序，这个选择正确。

## 5. F4 legacy 无 thread 消息 — 通过

**实现位置**：`normalizeThreadID`（`collab.js:204-212`）、`extractInbound`（`:576`）、`lineOf`（`:1307-1327`）、
`collab_inbox` 尾部提示（`:1108`）。

```
=== D. F4 legacy thread-less hint ===
PASS  D1 legacy message injected -- [collab] 待处理请求 1 条\n- request - from=cli-user: legacy body → 无 thread 关联，无需回执；直接处理即可（或 collab_send 发起新请求）
PASS  D2 no collab_reply hint
PASS  D3 no literal undefined/null threadID
PASS  D4 stored literal 'undefined' threadID normalized -- … - request - from=cli-user: leaked literal → 无 thread 关联，无需回执…
```

- 上一轮复现的 `collab_reply {threadID:"undefined"}` **不再出现**；`thread` 列显示 `-`。
- 额外覆盖了「旧存储里已经写成字符串 `"undefined"`」的历史脏数据（D4）：读路径也归一化，不会回显。
- `collab_inbox` 末行补了「无 thread 的 legacy 消息无需回执」（`collab.js:1108`），与注入文案一致。

## 6. F6 `collab_wait` 校验 — 通过

**实现位置**：`collab.js:1131-1145`（`normalizeThreadID` → 空值/非法格式立即抛错）、
`waitForReply:795-801`（thread 不存在立即抛错）。

```
=== E. F6 collab_wait validation ===
PASS  E1 malformed threadID fails immediately -- 1ms | threadID 格式不合法："not-a-thread"（期望 t_<base36ts>_<rand>…）
PASS  E2 unknown thread fails immediately     -- 0ms | 没有 thread t_ghost_0001：threadID 可能拼错，或该 thread 由别的项目/目录（不同 location）创建…
PASS  E3 both under 500ms                     -- malformed=1ms unknown=0ms
PASS  E4 literal 'undefined' threadID rejected -- 0ms | threadID 格式不合法："undefined"
PASS  E5 wait really waits then returns the late reply -- 801ms
```

- 上一轮 T4（畸形/未知 thread 空等 1000ms）**已修复**：0–1ms 报错。
- **没有把「真等待」改坏**：E5 在 600ms 后才回执，wait 于 801ms 返回正文（不是立刻返回、也不是超时）。
- `threadID: "undefined"`（legacy 脏值）也被拒，与 F4 同一条归一化规则。

## 7. 回归与真实服务侧证据

```
$ node --check .opencode/plugins/collab.js
CHECK_EXIT=0

$ node .trellis/tasks/11-17-collab-handoff/research/handoff-harness.mjs
...
=== 24/24 checks passed
HARNESS_EXIT=0          （✓ 行数 24）

$ opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"
… {"id":"collab","source":{"type":"local","path":"/data/project/muke-pos-app/.opencode/plugins/collab.js"},
   "features":{"server":true},"state":{"status":"active"}}      ← 无 failed

$ grep "loading plugin.*collab.js" ~/.local/share/opencode/log/opencode.log | tail -2
timestamp=2026-11-16T23:21:41.518Z / .525Z      ← = 07:21:41 CST，与 collab.js mtime 07:21:41 同秒 ⇒ 服务端跑的是修复版

$ opencode api get /api/session/ses_e196273b2ffekqAqqqKfyA4xMN
{"id":"ses_e196273b2ffekqAqqqKfyA4xMN","parentID":"ses_e1eb91cebffeTv1467ubJLKebk", …}
        ← 真实 Session.Info 带 parentID ⇒ F1 主路径在本机成立
```

补充：harness 的 S1–S16 仍是**只打印不断言**（S9 第二段按 F6 改成「快速失败」文案，删除的只有这一行 print-only 用例），
断言门只覆盖 S17–S22。这是上一轮 check-report §14 已提过的「harness 未进 CI」同类问题，
**不是**这一轮引入的，本次仅记录（建议后续把 `checks` 扩到 S1–S16 并纳入 CI）。

## 8. 越权 / 范围

`git diff --name-only` 的 collab 相关改动正好是 fix round 声明的 6 个文件，无第七个：

```
 .opencode/plugins/collab.js                        | 325 +++++++++++++++++----
 .trellis/spec/guides/cross-session-collab-guide.md |  23 +-
 .trellis/tasks/11-17-collab-handoff/implement.md   |  22 ++
 .trellis/tasks/11-17-collab-handoff/prd.md         |   3 +-
 .trellis/tasks/11-17-collab-handoff/research/handoff-harness.mjs | 222 +++++++++++++-
 docs/collab.md                                     |  58 +++-
```

- 工作区里另有 `packages/{contracts,schemas,machine,state}/**`、`bench/**`、`docs/issues/**`、
  `11-15-parity64-*`、`11-17-parity-vocab-coverage` 的未提交改动 —— **不是这一轮产生的**：
  mtime 均为 07:09–07:14（早于 fix round 的 07:21–07:23），内容属 order/schema 与 parity 线，
  且这四个代表文件里**没有任何 `collab` 字样**（`grep -l collab` → none）。属并行会话的正常在途改动。
- `.trellis/tasks/11-17-collab-workspace/`（07:22 新建，PRD-only、需求 TBD）是**另一个规划任务目录**，
  不含任何实现或本任务的产物，不构成越权；提交时注意**不要**把它带进本次 commit。
- `opencode.json`（上一轮的权限配置）本次**未改**，`git status` 干净；无 `git add`（`git diff --cached` 为空）。
- `collab.js` 仍无 `interrupt` / `generate` 调用，`BUILTIN_PROTECT` 两条 id 逐字未变（`collab.js:82`）。

## 9. 文档一致性（逐条对照代码）

| 文档断言 | 代码 | 结论 |
| --- | --- | --- |
| §11.2 `collab_list` 三种标记（`:256`、`:265`） | `collab.js:881-885` | ✅ 一致（`[self]` 与 `[protected]` 独立） |
| §11.2 `collab_inbox` 单条上限 4000（`:259`） | `INBOX_TEXT_LIMIT=4000`、`:1066`、`:1106` | ✅ 一致 |
| §11.2 `collab_reply`「恒为 queue」（`:258`） | `collab.js:1057` `resolveMode("queue", …)` | ✅ 一致 |
| §11.2/§11.7 `collab_wait` 只看最后一次 request 之后、仅参与者、快速失败（`:260`、`:368`） | `:795-820`、`:1131-1145` | ✅ 一致 |
| §11.4 血缘护栏 + list 标注 + list 回退（`:293-297`） | `:350-415`、`:878-891` | ✅ 一致（深度口径除外，见 §0.1-1） |
| §11.4「最多上溯 `MAX_LINEAGE_DEPTH=8` 级」（`:294`） | 实测 **7 跳** | ❌ 差 1 级（**应修**） |
| §11.4/§11.6-6「任意层级子会话都不可投递」（`:329`） | ≥8 跳可投递 | ❌ 绝对表述（同上一条） |
| §11.4「护栏是 fail-closed」（`:299`，语境是回执） | 回执确实受限（§7.1 复现）；但血缘读失败是 fail-open | ⚠️ 易误读，建议限定措辞（P3） |
| §11.7 storage 契约字段（`:334-341`） | `appendThreadMessage` 写入字段逐字一致 | ✅ 一致 |
| §11.7 状态机表（`:344-350`：request→open / reply→answered / note 不变 / closed 不可达） | `:532-537`；`closed` 无写入路径 | ✅ 一致 |
| §11.7「同一 threadID 第二个 request 会重开」（`:346`） | `:537` + C2 | ✅ 一致 |
| §11.7 参与者与路由校验（`:362-372`） | `:974-997`、`:1040-1055`、`:802-808` | ✅ 一致 |
| §11.7「无 sessionID 跳过身份校验但加注」（`:372`） | B9/B10 实测有注 | ✅ 一致 |
| §11.7「跨项目回执流程会静默超时」（`:380`） | 发起方确实超时；对端现在会**立刻报错**「storage 里没有 thread」 | ⚠️ 仅发起方视角的说法，可补一句（P3，非必要） |
| spec guide §2-2 / §2.1-2/3/4（`:20-21`、`:29-40`） | 同上各条 | ✅ 一致（含「thread 可复用」口径） |

文档 fmt：`docs/collab.md` 不满足 `vp fmt --check`（exit 1），但**HEAD 版本同样 exit 1**
（`git show HEAD:docs/collab.md` → 临时副本 → `FMT_CHECK_EXIT=1`），
formatter 要改的主要是本次**没动过**的 §3 / §11.5 表格内边距 —— 属文件级历史欠账，
本次只按原有风格追加表格，**没有新增一类偏差**。fix-notes §10.6 的说明属实。

## 10. 本轮新发现（均非阻断）

### 10.1（P2）血缘深度口径差 1 级

- 现象：`ses_d7`（7 跳）拒绝、`ses_d8`（8 跳）**投递成功**。
- 原因：`:404` 的 `depth < MAX_LINEAGE_DEPTH`，第 0 次迭代查的是目标本身，实际只上溯 7 级。
- 影响：子代理派生 1–2 级，实务无风险；但 `docs/collab.md:294`、`:329`、`collab.js:712` 是绝对表述。
- 建议二选一：`depth <= MAX_LINEAGE_DEPTH`（严格 8 跳），或文案改「最多 7 级祖先」。
  我按「只审不改」未改代码/文档。

### 10.2（P3）血缘链路断裂时 fail-open

- 复现：让中间父会话不可读（`get` 抛错且不在 `list` 页里），受保护祖父被隐藏 → 投递**成功**。
- 位置：`nodeOf` 的 `catch`（`:374-378`）+ 循环把 `parent` 缺失当成链尾（`:408-411`）。
- 建议：`if (!parent && current !== sessionID) → 视为链路不完整并拒绝`（fail-closed），
  或仅在文档明确「血缘不可读时按未受保护处理」。当前 `docs/collab.md:299` 的 fail-closed 只覆盖回执语义，
  容易被读成整条护栏。

### 10.3（P3）`kind:"note"` 未纳入参与者校验

- 复现：非参与者 `ses_ddd` 用别人的 `threadID` 发 `note` → 接受；thread `msgs` 1→2，
  末条 `toSession=ses_ccc`（与 thread 顶层 `toSession` 不一致），status 不变。
- 影响：状态机与 `collab_wait` 不受影响（note 不改变状态、wait 只认 reply），
  但会给别人的 thread 留一条伪装成参与方的记录（`collab_inbox` 里可见）。
- 建议：把「参与者 + 对端」校验从 `kind === "reply"` 扩到「`kind !== "request" && threadID`」，
  或在 §11.7 注明「note 可用任意 threadID，仅作通知」。上一轮 check-report 的 F2 只点名 reply，故不算漏修。

## 11. 硬约束遵守

- **零投递**：全部 F1/F2/F3/F4/F6 复现都在假 ctx（`session.prompt` 只 push 内存数组）里完成；
  对真实会话只发了 `GET /api/plugin` 与 `GET /api/session/{id}`。
  未向 `ses_e1eb91cebffeTv1467ubJLKebk`、`ses_e23a4a23fffe4c4m7UQFR8dUL3` 及任何子会话投递。
- 未创建/删除任何真实会话，未执行 `opencode service restart`，未 commit / push / `git add`。
- **实现文件零改动**：本轮唯一写入是本报告；探针脚本全部在 `/tmp`
  （`/tmp/collab-fix-review.mjs`、`-2`、`-3`）；为核对 fmt 曾在 `docs/` 放过一个临时副本，
  同一条命令内删除，`git status` 复核无残留。
- 未碰 `packages/**`、`apps/**`、`bench/**`、`docs/issues/**`、`11-15-design-normalize`、
  `11-17-parity-vocab-coverage`。

## 12. 残留风险 / 未验证

1. **真实事件流下的「复用提醒」**：C4 用假 ctx 直接调 `context` hook（并补了 inbox 记录）验证；
   真实 `session.inbox.enqueued` 路径本轮未重跑（需真实 agent 轮次）。事件路径代码本轮只改了
   `threadID` 归一化（`extractInbound:576`），风险低。
2. **`opencode service restart` 后的 `ctx.storage` 持久化**：仍未验证（会中断并行会话），
   与 fix-notes §10.3 一致；PRD AC5 已按「插件文件重载」口径改写并可复核。
3. **`ctx.session.get` 不带 `parentID` 的宿主**：回退路径由 A10 覆盖，但**未在真实宿主触发过**（本机主路径可用）。
4. thread 长期复用 > `MAX_STORED=50` 条消息时，`slice(-50)` 可能把最后一次 request 裁掉，
   `lastRequest` 退化为 -1 → 可能读到更早的 reply。极低频，建议后续在裁剪前保留最后一条 request。
5. harness S1–S16 仍无断言、未进 CI（上一轮已记录）。
