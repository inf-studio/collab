# 独立复核报告：11-18-collab-ack-resend（0.1.6 ack / 重发 / 闭环后追加）

> 复核人：trellis-check（冷上下文）
> 对象：`/data/project/collab` 未提交改动（`git diff` + 3 个新文件）
> 方式：**只审不改**。未 commit / push / tag，未改任何实现文件，未向受保护会话投递。
> 复现产物：`research/check-harness.mjs`（我自写的假 ctx + 伪造时钟，69/71 通过；2 条失败见 F1/F2）

## 0. 结论

- **R1–R8 的功能实现成立**：我自己的假 ctx + 伪造时间复现了 ack（admitted/seen、去重、防伪、防环）、
  受限重发（busy 0 次、idle 1 次、同 cid、预算、unacked）、R4 受保护 `ackUnavailable`（零投递、不重复写盘）、
  H1–H4 全部通过，H5 的 `injectionFor` 白名单通过。
- **2 条需要处理**（均不改变已通过的协议语义）：
  - **F1（代码，建议发布前修）**：`ackSeen` 在 `await ctx.session.prompt` 之后用**旧快照**整条写回，
    若发方的 `applyAck` 在 await 期间落地 `seenAt`，会被覆盖 → 2h 后多投 1 次 + 误报 `unacked`
    （正是本任务要消灭的「未送达误判」）。有确定性复现。
  - **F2（文档，必须改或改代码）**：`docs/collab.md:358`「其它提醒一律不注入」与实现不符：
    `injectStale` 对受保护会话仍会注入「挂起提醒」块（0.1.5 既有行为）。H5 针对 `injectionFor` 的白名单本身是通过的。
- **存疑 1 条**：`docs/collab.md:252` 声称「实测（0.1.5）`opencode reload` 后即切换版本」，仓库内没有该实验证据，
  且 `research/impl-notes.md §9.2` 明确写「reload 实测不在本次范围」。需 owner 确认或先删掉「实测」措辞。
- **发布动作未做**（tag / CI / 全局安装 / 实测 reload），验收项「`0.1.6` 发布」未达成——属 owner 步骤，不在复核范围。

**是否可提交**：代码改动**可提交**（除 F1 建议顺手修 2 行、F2 改一句文档之外，无阻塞缺陷）；
**不可宣告「0.1.6 已发布」**。详见 §7。

## 1. 复核方法

```
# 自写复现（不读、不复用 test/handoff-harness.mjs 的断言）
pnpm build
node .trellis/tasks/11-18-collab-ack-resend/research/check-harness.mjs
```

`check-harness.mjs` 自带：

- 自建假 host：`storage`（Map）、`session.{get,list,context,prompt,wait,hook}`、`tool.transform`、
  `event.subscribe`（可控异步队列）；
- **伪造时钟**：`Date.now = () => NOW`，逐段 `NOW += 3h/4h` 验证 2h 窗口边界、预算与 `unacked`；
- 临时目录（`mkdtemp`）承载 `COLLAB_BROADCAST_DIR` / `COLLAB_GRANT_DIR` / `COLLAB_REPORT_DIR` / `COLLAB_CONFIG`，
  不触碰真实 `~/.config/opencode/*`；
- 每条断言都打印实测值（cid、prompt 目标、记录字段），便于对照。

## 2. 逐条结论

| # | 项目 | 结论 | 关键位置 |
| --- | --- | --- | --- |
| 1 | ack admitted/seen、去重、防伪、防环 | **通过** | `src/tools/shared.ts:419`、`src/tools/handoff.ts:194`、`src/core/chain.ts:497,522,765`、`src/core/ack.ts:41,57`、`src/hooks/context.ts:63,98`、`src/tools/inbox.ts:59,72` |
| 2 | 受限重发（idle/2h/预算/busy/顺延） | **通过** | `src/core/ack.ts:73,94`、`src/core/chain.ts:581,598,716` |
| 3 | R4 受保护 → `ackUnavailable`，不投递、不反复写盘 | **通过** | `src/tools/broadcast.ts:289,349`、`src/tools/handoff.ts:195`、`src/core/chain.ts:537,604` |
| 4 | H1 `followUps[]` 只存结构、只渲染 path @ ts | **通过**（1 条加固建议 O6） | `src/core/claim.ts:69`、`src/core/followup.ts:38,45,140,181` |
| 5 | H2 仅 `claim.by` 可追加 | **通过** | `src/tools/followup.ts:76,80,86,96` |
| 6 | H3 `realpath` 边界、写入与渲染各校验、失败不渲染 | **通过** | `src/core/followup.ts:63,86,91,191`、`src/tools/followup.ts:106,125` |
| 7 | H4 去重 `(sid,bid,at)`、≤3/单、≤1 行/次 | **通过**（1 条边界说明 O4） | `src/core/followup.ts:159`、`src/core/chain.ts:663-681` |
| 8 | H5 protect 显式白名单 | `injectionFor` **通过**；**文档断言不成立（F2）** | `src/core/chain.ts:702`、`src/hooks/context.ts:214-228`、`src/core/stale.ts:81`、`docs/collab.md:358` |
| 9 | 回归 & S72 修复是否掩盖问题 | **通过** | `test/handoff-harness.mjs:4195` |
| 10 | 范围/安全（允许清单、PROTECT、依赖、他仓） | **通过**（README 有并发写者，见 O2） | `git diff`、`src/constants.ts` |

## 3. 逐条证据

### 1) ack admitted / seen —— 通过

- 发方：`dispatch` 返回 `delivery{cid,to,messageId,admittedAt}`（`src/tools/shared.ts:419`），
  `collab_handoff` 写进记录（`src/tools/handoff.ts:194`）；`collab_broadcast` 的注入式问询、
  spawn 均在建档时写 `{cid,to,admittedAt}`（`src/tools/broadcast.ts:287,347`）；
  `deliverAsk` 复用同 cid（`src/tools/shared.ts` `deliverAsk`）。
- 收方三处触发：`context` 注入（`src/hooks/context.ts:98-106`）、`collab_inbox`（`src/tools/inbox.ts:70-78`）、
  接管注入（`src/core/chain.ts:765`）。
- 发方解析：`src/core/chain.ts:497-512` 只认 `delivery.cid` 且 `String(delivery.to) === sender`；
  `markSeen` 只写第一次（`src/core/ack.ts:57`）。
- 假 ctx 实测（节选）：

```
  PASS handoff records delivery{cid,to,messageId,admittedAt}  — {"cid":"c_loyw3v28_3i16","to":"ses_t1","messageId":"msg_1","admittedAt":1700000000000,...}
  PASS the recorded cid is the cid the receiver actually got
  PASS receiver answers exactly one [ack] <cid> seen to the requester  — {"n":1,"to":"ses_req","text":"[collab:ses_t1…s_t1][note] [ack] c_loyw3v28_3i16 seen"}
  PASS the ack carries its own cid (never reuses the acked one)
  PASS the [ack] text is not injected into the receiver context
  PASS a second injection never re-acks the same cid  — +0
  PASS sender stamps delivery.seenAt from the [ack]; state untouched  — {"seenAt":1700000000000,"state":"acked"}
  PASS an ack from a session the message was not delivered to is ignored
  PASS an ack naming another cid does not touch the record
  PASS requester context does not surface or re-ack the [ack]  — +0
  PASS collab_inbox marks the [ack] note as system-ack
  PASS collab_inbox reading a message acks its cid  — +1
  PASS the ask injection is acknowledged on a side path (same cid)  — {"extra":["ses_req"],"ackSentAt":1700000000000}
```

- 可见性（R3）：`collab_list` 行 `admitted=0min seen=0min queue-age=0min resend=0 unacked=-`；
  `collab_wait` 追加「交付状态」（`src/tools/wait.ts:18,90`）——均实测通过。

### 2) 受限重发 —— 通过

`resendDue`（`src/core/ack.ts:73-92`）条件：`cid+to` 存在、`!seenAt`、`!ackUnavailable`、`resends<1`、
`asked.sid`/`claim.by` 必须仍等于 `delivery.to`（防顺延后错投）、`failedAt` 立即重试或 `now-admittedAt>2h`；
`resendOnce`（`src/core/chain.ts:598`）受保护 → `ackUnavailable`，`sessionState(info) !== 'idle'` 直接返回（不写、不计数）。

```
  PASS busy target: 0 resends, resends=0, not unacked  — +0
  PASS busy target is shown as seen=- unacked=- (no false "not delivered")
  PASS idle target + no seen after 2h → exactly 1 re-delivery, same cid, queue  — {"n":1,"to":"ses_t1","cid":"c_resend"}
  PASS the resent message lands once (same cid de-duplicated on the receiving side)  — 1
  PASS the record counts it (resends=1) and keeps the cid
  PASS budget is 1: a further 4h never delivers a third copy  — +0
  PASS a cid whose ask advanced is never resent to the old target
  PASS a cid claimed by another session is never resent to the old target
  PASS failed admission → 1 resend, admittedAt stamped, failedAt cleared
  PASS budget spent + 2h → delivery.unacked=true
  PASS collab_list marks unacked=yes and lists it with 可人工补投
  PASS record without delivery → no resend, no crash  — +0
  PASS a peer hand-off in another workspace is still re-delivered (before the ws filter)  — +1
```

> 注：PRD R2 写「超过 2 次记为 unacked」，design §3 / `MAX_RESENDS=1` 为「初始 1 次 + 补投 1 次」。
> 实现与 design 一致；属 PRD 措辞歧义，非缺陷。

### 3) R4 受保护 —— 通过

`collab_broadcast` / `collab_handoff` 在建档时即 `ackUnavailable`（`src/tools/broadcast.ts:289,349`、
`src/tools/handoff.ts:195`）；`ackSeen` 遇到 `ackUnavailable` 直接 `continue`（`src/core/chain.ts:537`），
遇到受保护发起方只写一次标记（`:545`），不 prompt、不报错。

```
  PASS a hand-off started by a protected session is ackUnavailable from birth  — {"cid":"...","ackUnavailable":true}
  PASS the receiver never prompts the protected requester for an ack (0 deliveries)  — +0
  PASS nothing was written to the record on repeated injections
  PASS protected requester + legacy record → ackUnavailable, no prompt  — {"extra":[]}
  PASS … and a second injection writes nothing more (no repeated disk write)
```

### 4) H1 只存结构 —— 通过

- `normalizeBroadcast` 只保留 `{bid,issuePath,at,by}` 并在读入时即丢弃旧数据的正文（`src/core/claim.ts:66-82`）；
- `appendFollowUp` 只写这 4 个字段（`src/core/followup.ts:140-156`）；
- `followUpHintLine` 只渲染 `bid + path + fmtTime`（`src/core/followup.ts:181`）；
- `sanitizePathText`：控制字符/换行 → 空格、折叠空白、`slice(0,200)`（`:45-53`）。

```
  PASS the stored entry is exactly {bid, issuePath, at, by}  — bid,issuePath,at,by
  PASS no free text from the call or the old record reached the file      # 传入 text 与旧记录 text 都没落盘
  PASS state / receipt are untouched and nothing was delivered  — +0
  PASS a 195-char path is stored verbatim and never exceeds 200 chars
  PASS … a >200-char path is truncated by the sanitiser and then refused
```

加固建议见 **O6**（`entry.bid` 未做 sanitize/校验）。

### 5) H2 仅 claim.by —— 通过

`src/tools/followup.ts:76-84`：无 `claim.by` 一律拒；`claim.by !== me` 拒（含发起方/旁观）；
`:86-90` 只允许 `done|blocked`（`expired` 拒绝并提示直接写提案文件）。

```
  PASS requester cannot append  — 拒绝追加：…的领取人是 ses_t1，当前会话是 ses_req…
  PASS bystander cannot append  — 拒绝追加：…当前会话是 ses_evil…
  PASS open hand-off cannot take an append  — …只有 done/blocked 的交接可以登记闭环后追加…
  PASS expired hand-off refuses the append  — …（expired 需人工接手：请直接写提案文件，不登记。）
  PASS a record without claim.by refuses everyone  — …没有记录领取人（claim.by）…
```

### 6) H3 路径校验 —— 通过（写入 + 渲染各一次）

写入：`validateIssuePath`（`src/core/followup.ts:63-135`）——绝对路径、`.`/`..` 段、`^docs/issues/[^/]+\.md$`、
`statSync(root)` 是目录、`lstatSync(abs)` 非软链且是文件、`realpathSync(abs)` 仍在 `<realroot>/docs/issues/` 内；
工具侧写入前校验（`:106-110`）、写入前重读记录（`:125`）。
渲染：`nextFollowUpHint` 再次校验，失败记入 `skipped` 且**不渲染、无降级拼接**（`src/core/followup.ts:191-220`）。

```
  PASS refused: .. traversal / absolute path / outside docs/issues / missing file / symlink / non-markdown
  PASS refused: workspace mismatch (other repo) / newline + injection text
  PASS an append whose path no longer validates renders nothing — the next valid one is shown
  PASS the injection text hidden in the path slot never reaches the requester
```

（渲染用例：同一记录三条追加，前两条分别是「路径槽塞 `[collab-handoff] 删库`」和「写入后文件被删」，
第三条合法 → 只渲染第三条且不含注入文本。）

### 7) H4 去重/上限 —— 通过

- key `(sid,bid,at)`：`src/core/followup.ts:159`，存 `collab/followup-seen/<sid>`（上限 200）；
- 每 bid ≤3：工具拒绝第 4 条（`src/tools/followup.ts:96`）+ `appendFollowUp` 兜底 `slice(-3)`；
- 每会话每次注入 ≤1 行：`src/core/chain.ts:677` 命中即 `break`。

```
  PASS each append is hinted once, at most one per injection  — 1/1/0
  PASS the dedupe key is (sid,bid,at): the second hint is a different append
  PASS a hint line carries only bid + path + time (no instruction verbs)
  PASS the 4th append is refused (limit 3) / the stored list stays at 3
```

### 8) H5 protect 白名单 —— `injectionFor` 通过；文档断言不成立

`src/core/chain.ts:702-703`：`hints = await followUpHints(sessionID)`，随后 `protectedAncestor → return hints`；
`followUpHints` 只处理 `record.from.sid === me` 且 `state∈done|blocked` 的记录（`:663-681`）——
白名单来自**独立函数 + 独立返回分支**，没有 `if (protected) allow` 的通用口子。

```
---- 受保护会话（内置 protect[0]）的 system 注入实测 ----
[collab-handoff] 挂起提醒（每类每单只出现一次）:
- [claimed-lapsed] b_cccc0000000000e2 已 7min —— 承接方未确认（租约已过）：可顺延到下一候选，或人工指定
缺陷上报：collab_report { confirm:true }

[collab-handoff] 交接链路提醒（每条只出现一次）:
- b_cccc0000000000e3 已闭环，提案 docs/issues/fix-check.md 有追加结论（13:13:19），请读取文件
-----------------------------------------------------------
  PASS H5a: injectionFor returns ONLY the follow-up line (no ask/broadcast/unclosed reminder)
  FAIL H5b: NO sibling hook block injects into a protected session (docs claim: 其它提醒一律不注入)
```

→ `injectionFor` 块内确实只有一行；但 `contextHook` 还会跑 `injectStale`（`src/hooks/context.ts:223` →
`src/core/stale.ts:81` `staleFor`/`involves`，对 `from.sid===自己` 的挂起单成立），对受保护会话照常注入。
这是 **0.1.5 既有行为**（`git show HEAD:src/hooks/context.ts` 第 148/198 行已存在），
但本次**新增**的 `docs/collab.md:358`「其它提醒一律不注入」是错的 → 见 F2。

### 9) 回归 —— 通过

```
$ pnpm build        → ✔ Build complete（exit 0）
$ pnpm typecheck    → tsc --noEmit（exit 0，无诊断）
$ pnpm test         → === 453/453 checks passed / === 12/12 checks passed（exit 0）
$ node scripts/check-skill.mjs → ✓ skills/collab/SKILL.md (collab) / skills ok（exit 0）
```

S72 时钟抖动修复是否掩盖问题：**未掩盖**。`staleClass` 的默认参数只在调用方省略 `now` 时生效，
生产路只有 `staleFor`（`src/core/stale.ts:81`）调它且**显式传 `now`**（`list.ts:147`、`context.ts:176` 都传 `Date.now()`）；
测试仍保留两侧边界（`-3_600_001` vs `-3_600_000` 等），只是去掉同一次断言内的两次 `Date.now()` 漂移。
测试 diff 的删除行只有 S72 用例与工具数标题（`git diff test/ | grep '^-'` 已核对）。

### 10) 范围/安全 —— 通过（含 2 条观察）

- 改动文件：`CHANGELOG.md`、`docs/collab.md`、`package.json`、`skills/collab/SKILL.md`、`src/{constants,types,index}.ts`、
  `src/core/{ack,followup,chain,claim,verdict}.ts`、`src/tools/*`、`src/hooks/context.ts`、`test/*` ——
  与派单允许清单一致（`constants.ts` / `types.ts` 是 design §1 的必需项；`send.ts` / `reply.ts` 未被改动）；
- `BUILTIN_PROTECT` 未改：`git diff src/constants.ts | grep -c PROTECT` = **0**；
- 无新依赖：`git diff package.json` 仅 `version` + `description`；
- 未改归档任务：`git status` 无 `.trellis/tasks/archive/**` 变更；
- `muke-pos-app` 工作区虽有改动（`apps/cli/*`、`docs/cli.md`、其 `11-18-cli-release-hardening` 任务目录），
  但主题与本任务无关，非本次改动所写；
- **并发写者**：`README.md` 在我复核开始后才被改（mtime 10:01:02，只改工具计数/结构说明）——见 O2。

## 4. 发现

### F1（代码，建议发布前修）`ackSeen` 用旧快照写回，可能丢掉 `seenAt`

- 位置：`src/core/chain.ts:522-566`，关键行 `:559`（`delivery` 快照取于 `:527`）
  `writeBroadcast({ ...record, delivery: { ...delivery, ackSentAt, ackSentBy } })`，
  其中 `record` / `delivery` 是 `:527` 循环开始时的快照，中间隔着 `await createLineage(...)` 与
  `await ctx.session.prompt(...)`（真实 host 调用，可能数十/数百毫秒甚至更久）。
- 交错：收方 `prompt` 发出的 `[ack]` 被发方插件在 await 期间处理 → `applyAck`（`:497`）写入 `seenAt`；
  随后收方的旧快照写回 → `seenAt` 被覆盖（`ackSentAt` 保留 → 之后再也不会补 ack）。
- 确定性复现（`research/check-harness.mjs` 的 “concurrent write” 段：让 `prompt` 在返回前把 `[ack]`
  投进事件流并等待 `seenAt` 落地）：

```
  FAIL seenAt survives the receiver writing ackSentAt (no lost update)
       — {"cid":"c_race","to":"ses_t1","admittedAt":...,"ackSentAt":...,"ackSentBy":"ses_t1","resends":0,"unacked":false}
  PASS … consequence: after 2h the "unseen" record is re-delivered and later marked unacked
       — {"resends":1,"unacked":true,"extraPrompts":1}
```

- 影响：一条**已被看到**的消息在 2h 后被补投 1 次（同 cid，收方去重，无重复注入），再过 2h 变成
  `unacked=yes` 并在 `collab_list` 里提示「可人工补投」——即用户被引导去手工重发一件已经完成的事。
  无安全影响；属于本任务要消除的「未送达误判」类别。
- 最小修复建议（不动协议）：在写回前重读并合并，例如

  ```ts
  // src/core/chain.ts, after the prompt succeeded
  const fresh = readBroadcast(record.bid) ?? record;
  const d = deliveryOf(fresh);
  writeBroadcast({ ...fresh, delivery: { ...d, ackSentAt: Date.now(), ackSentBy: me } });
  ```

  同类（但窗口更短）的盲写还有 `:537` 的 `ackUnavailableFor(record, …)` 与 `applyAck` 的 `writeBroadcast(next)`；
  若要彻底，可加一个 `mergeBroadcast(bid, patch)` 帮助函数（读-改-写在同一次同步段内）。
- 严重度：**低–中**（概率取决于 host 事件/响应顺序；后果是多余 1 次投递 + 一次误报）。

### F2（文档，必须改；或改代码）受保护会话并非「只多一条提示」

- 位置：`docs/collab.md:358`（本次新增）
  > 「受保护会话的 `context` 注入**只**包含一条只读的「提案有闭环后追加」提示……其它提醒一律不注入。」
- 实测：`contextHook` 依次运行 `injectInbox` / `injectStale` / `injectChain` / `injectReportNotice`
  （`src/hooks/context.ts:214-228`），其中 `injectStale`（`:173`）对**所有**会话工作，
  `staleFor` 会为「自己是发起方/领取人/被问询者」的挂起单产出 `open-stale` / `claimed-lapsed` / `acked-stale`
  提醒（`src/core/stale.ts:81-103`）。受保护会话发起过交接 → 必然可能命中。
- 归属：该行为在 0.1.5 就存在（`git show HEAD:src/hooks/context.ts` 第 148/198 行），**本次未回归**；
  但本次新增的这句文档把它说反了，且 H5 的意图（「受保护线只多这一条」）在 hook 层并不成立。
- 两个选项：
  1. **改文档（推荐，零行为变更）**：把断言限定在 `injectionFor` 内，并补一句
     「此外 `collab-handoff` 的『挂起提醒』块（若该单由它发起）仍会注入——0.1.5 既有行为，
     内容是本地记录字段（bid + 固定文案 + 时长），不含任何消息正文」；
  2. **改代码**：`contextHook` 里对受保护会话跳过 `injectStale`（`src/hooks/context.ts:223`）。
     代价：受保护发起方失去「该刷新了」的推动（pull 模式靠它自己下一次 broadcast/handoff 收口）。
     属行为变更，建议 owner 拍板。
- 补注：`injectInbox` 同样不受 protect 限制（若受保护会话的 inbox 里有消息就会注入正文）；
  正常路径下向受保护会话投递已被拒，故其 inbox 一般为空，属既有面。

### 观察（不阻塞）

- **O1 文档「实测 reload」缺证据**：`docs/collab.md:252` 写「实测（0.1.5）`opencode reload` 后当前会话即切换版本」。
  `research/impl-notes.md §9.2` 明确「reload 实测不在本次范围」，仓库内（含归档任务）无该实验记录。
  建议改为未验证措辞，或由 owner 在发布时真跑一次再补结论。
- **O2 README 计数过期**：`README.md:124` 仍写「375 项 harness」（现为 453）。该文件在我复核期间（10:01）
  被另一写者改过（工具数/结构），只剩这个数字没跟上；另 `README` 的「十二个工具」措辞与实现一致。
- **O3 `collab_followup` 不在会话级授权白名单**：`COLLAB_TOOL_ACTIONS`（`src/constants.ts:130`）仍是 5 条，
  spawn 出来的承接方（R5 的主要调用者）不会被自动授予该工具——与 `collab_accept` 今天的处境相同
  （既有模型，非本任务回归）。若将来 permission 变成严格 allowlist，这两者都会失效。
- **O4 H4 的 `at` 粒度**：两条追加若落在同一毫秒，`(sid,bid,at)` 相同 → 第二条提示被吞。设计规定的 key，
  手工作业不可能命中；若将来批量追加需换成 `at + 序号`。
- **O5 重发在 `context` hook 内 `await prompt`**：host 调用慢时会拖慢该次模型请求（每单最多一次）。
- **O6 渲染未校验 `entry.bid`**：`followUpHintLine` 直接插值 `entry.bid`（`src/core/followup.ts:181`）。
  写入侧 `appendFollowUp` 固定用 `record.bid`（受 `isValidBid` 约束），所以工具路径不可注入；
  但被手改/异常的记录可在 `followUps[].bid` 里塞换行与文本并渲染进上下文。建议渲染时用 `isValidBid` 过一遍
  （与 issuePath 的处理保持一致）。

## 5. 原始输出

### 5.1 必跑命令

```
$ pnpm build
ℹ dist/index.js    233.31 kB │ gzip:  72.97 kB
ℹ dist/index.d.ts  954.80 kB │ gzip: 136.08 kB
✔ Build complete in 7914ms

$ pnpm typecheck
$ tsc --noEmit
(无输出，exit 0)

$ pnpm test
...
=== 453/453 checks passed
...
=== 12/12 checks passed
(exit 0)

$ node scripts/check-skill.mjs
✓ skills/collab/SKILL.md (collab)
skills ok
```

### 5.2 独立复现（69/71）

```
$ node .trellis/tasks/11-18-collab-ack-resend/research/check-harness.mjs
...
  PASS H5a: injectionFor returns ONLY the follow-up line (no ask/broadcast/unclosed reminder)
  FAIL H5b: NO sibling hook block injects into a protected session (docs claim: 其它提醒一律不注入)
  PASS … and no [handoff]/command text leaked in
  PASS a protected session with no follow-ups gets no follow-up line

== concurrent write: ackSeen vs applyAck (lost update?)
  FAIL seenAt survives the receiver writing ackSentAt (no lost update)  — {"cid":"c_race",...,"ackSentAt":1700025200000,"ackSentBy":"ses_t1",...}
  PASS … consequence: after 2h the "unseen" record is re-delivered and later marked unacked  — {"resends":1,"unacked":true,"extraPrompts":1}

=== 69/71 independent checks passed
```

> 2 条 FAIL 对应 F2（文档断言）与 F1（并发盲写）。其余 69 条覆盖 #1–#7、#9、#10 以及 R5/R6 的「闭环后仍不可 push」。

## 6. 风险清单（按严重度）

| # | 风险 | 级别 | 处置建议 |
| --- | --- | --- | --- |
| F1 | `ackSeen` 旧快照写回吞掉 `seenAt` → 补投 1 次 + 误报 `unacked` | 低–中 | 发布前重读合并（2 行），或接受并记入已知问题 |
| F2 | `docs/collab.md:358` 与实现不符（受保护线仍有「挂起提醒」块） | 中（文档/承诺） | 改文档（推荐）或 gate `injectStale`（owner 决策） |
| O1 | 文档声称 `opencode reload` 已实测，仓库无证据 | 中（对外承诺） | 改措辞 / 发布时补实测结论 |
| O2 | README harness 计数 375（现 453） | 低 | 顺手改 |
| O3 | `collab_followup` 未进入会话级授权白名单 | 低（既有模型） | 记录在案，权限模型变更时一并处理 |
| O6 | `followUps[].bid` 渲染未校验 | 低（需篡改记录） | 渲染时 `isValidBid` |
| O4/O5 | 同毫秒追加吞提示 / hook 内 `prompt` 延迟 | 很低 | 无需动作 |
| — | 发布步骤未执行（tag/CI/全局安装/reload 实测） | — | owner 执行，勿在未发布时宣称 0.1.6 |

## 7. 是否可提交

- **代码改动：可提交**。R1–R8 的协议语义、H1–H4、H5 的 `injectionFor` 白名单均经我自己的假 ctx + 伪造时间复现；
  无回归（453+12 全绿），无范围越界，`BUILTIN_PROTECT` 与依赖未变。
- **建议同一批修掉**：F1（`src/core/chain.ts:559` 重读合并；`:537` 同理）与 F2（`docs/collab.md:358` 措辞）。
  两者都是小改动、不触碰协议；若 owner 选择「先提交后修」，请至少在 CHANGELOG 的「已知问题」里登记 F1。
- **不可宣告**：`0.1.6` 已发布 / reload 已验证（见 O1 + 发布步骤未做）。
- 本次复核**未做**：commit / push / tag / 修改实现文件 / 向受保护会话投递；`README.md` 在我复核期间被其他写入者改动，
  我未触碰。

## 8. 复核清单（逐条可复跑）

```
cd /data/project/collab
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
node .trellis/tasks/11-18-collab-ack-resend/research/check-harness.mjs   # 69/71，2 条 = F1/F2
git diff --name-only && git diff src/constants.ts | grep -c PROTECT && git diff package.json
```
