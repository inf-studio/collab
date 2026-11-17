# 实现笔记 — pull 模式 + 限界 reply（`11-18-collab-protected-receipt`）

日期：2026-11-18 · 作者：trellis-implement（子代理）· 基线：`0.1.1`（`500222a`）

## 0. 一句话

受保护会话发起的 peer 广播不再要求「撞墙式回执」：记录写 `receiptMode:"pull"`，接管请求 / `collab_accept` /
广播结果 / 租约提醒改为「在本会话最后一条回复写 `[handoff] …`」；同时给 `collab_send` / `collab_reply` 开了
**唯一**一个护栏例外（该 bid 的发起方 + 该单领取人 + `kind=reply`），其余仍 fail-closed。

---

## 1. 改法（`file:line`）

### 1.1 数据（只增字段）

| 文件 | 位置 | 内容 |
| --- | --- | --- |
| `src/types.ts` | `:246-249` | `BroadcastRecord.receiptMode?: 'push' \| 'pull'`（含注释：缺省 = `push`） |

`normalizeBroadcast` 用 `...record` 展开，字段自然透传；**没有**新增/改动任何存储键。

### 1.2 创建广播时判定（R1）

| 文件 | 位置 | 内容 |
| --- | --- | --- |
| `src/tools/broadcast.ts` | `:89-97` | `createLineage(ctx).protectedAncestor(me, readConfig().protect)` → `receiptMode = 'pull' \| 'push'`（在 preview/幂等分支之前算，两侧共用） |
| 同上 | `:257`（spawn 记录）、`:328`（open 记录） | 写入 `receiptMode` |
| 同上 | `:299`、`:354` | `handoffActions({ …, receiptMode })`（拉新结果 / 广播结果） |
| 同上 | `:134-138` | 幂等（已存在记录）分支：`receiptMode:"pull"` 时回执说明改为「写在它自己最后一条回复里 + 不要 collab_send」 |
| 同上 | `:355-357` | pull 模式不再给「推辞: collab_send … DECLINE」而是「不领取即可（5 分钟顺延）」 |

### 1.3 文案（R1 / R3）

| 文件 | 位置 | 内容 |
| --- | --- | --- |
| `src/core/verdict.ts` | `:207-262` | `handoffActions({ …, receiptMode='push' })` 新增分支：pull 的 ②/③/推辞三行（`不要尝试 collab_send：发起方在 protect 名单内`、`发起方在租约到期后只读提取`）；`push` 分支逐字未改 |
| `src/tools/accept.ts` | `:9-27` | 新增 `receiptLines(record)`：`pull` → 「在本会话最后一条回复里写一行 `<[handoff] DONE …>` / `BLOCKED` / 不要 collab_send / 租约到期只读提取」；`push` → 原 `collab_send {…}` |
| 同上 | `:133`、`:213` | 两处「完成后回执」改用 `receiptLines(record)` |
| 同上 | `:44-49` | 工具 description 补 pull 例外（模型可读到） |
| `src/tools/shared.ts` | `:378`、`:389-393` | `deliverAsk`（接管请求 / 叫醒 prompt）按 `record.receiptMode` 传 `receiptMode`，spawn 的 BLOCKED 提示同步改「写在最后一条回复里（不要 collab_send）」 |
| `src/core/chain.ts` | `:434-441` | `injectionFor` 的接管请求行按 `receiptMode` 生成 ② |
| 同上 | `:469-481` | 「交接未闭环」提醒：pull 模式 → `已无需等待推送回执，租约到期后会只读提取承接方的最后一条回复…`；push 保持 `用 collab_inbox 看回执…`（R3） |

### 1.4 限界 reply（R2）

| 文件 | 位置 | 内容 |
| --- | --- | --- |
| `src/tools/shared.ts` | `:20-21` | `RECEIPT_BID_RE = /\b(b_[0-9a-f]{8,32})\b/` |
| 同上 | `:30-67` | `canReplyToProtected({ kind, target, sender, bid, text })`：`kind !== 'reply'` → `undefined`；`bid` = 入参优先，其次正文；`readBroadcast(bid)` 后校验 `record.from.sid === target` **且** `record.claim.by === sender`；返回记录（只读，不改状态） |
| 同上 | `:96-101`、`:165-190` | `dispatch` 新增 `allowProtectedReply?: boolean`；`if (guard && !allowProtectedReply) throw` |
| 同上 | `:194-210` | 拒绝文案补一句「只有「本单发起方 + 该单领取人 + 该 bid」的 kind=reply 回执是白名单例外」 |
| 同上 | `:217-226` | 放行时 `queue(forced)` + `delivery: 'queue'`（即使调用方传 `steer`），并追加注记「回执按白名单放行（…），强制 queue 投递」 |
| `src/tools/send.ts` | `:68-72` | `requestedKind` 保留「请求时的 kind」（不让 `reply → request` 降级掩盖回执） |
| 同上 | `:114-127` | 有 threadID 的 reply 分支：算 `allowProtectedReply` 后传入 `dispatch` |
| 同上 | `:133-163` | 无 threadID 分支：`boundedReply` 命中时**撤销**降级（`kind='reply'` + 新 thread），删掉「已按新请求处理」的注记，传 `allowProtectedReply` |
| `src/tools/reply.ts` | `:73-88` | `collab_reply` 同样用 `canReplyToProtected`（`kind` 恒为 `reply`） |
| `src/tools/send.ts` `:30-37` / `reply.ts` `:28-33` | — | 两个工具新增可选入参 `bid`（`jsonInput` 是 `additionalProperties:false`，必须显式声明） |

安全要点：白名单只看 **记录归属**（`from.sid` + `claim.by`），不看调用方声明的任何自述；`request`/`note`/`steer` 连
`canReplyToProtected` 的门都进不去（`normalizeKind !== 'reply'` → `undefined`）。

### 1.5 pull 的闭环路径（R4 的「pull 提取」前提）

| 文件 | 位置 | 内容 |
| --- | --- | --- |
| `src/core/chain.ts` | `:329-337` | `refresh` 的只读提取条件从 `claim.kind === 'spawn'` 放宽为 `claim.kind === 'spawn' || receiptMode === 'pull'` |

为什么必须放宽：`collab_accept` 会把 `claim.kind` 改写成 `accept`（`accept.ts:160-170`）。若不放开，
**承接方一 accept 就再也提取不到**（原 push 模式的已知限制 §12.5 #11 也提到这点），pull 模式就彻底没有闭环路径。
H2（只有发起方能提取）/ R3（受保护承接方不读）两个护栏原样保留（`:338-343`）。

---

## 2. 新增回归（`test/handoff-harness.mjs` S69，`:3380-3670`）

新增 23 项断言（fixture：`WS_L` pull+spawn、`WS_N` pull+白名单/提取、`WS_M` push 对照 + `ses_m1` 强候选）。

| 断言 | 覆盖 |
| --- | --- |
| `S69 the record of a protected requester carries receiptMode:"pull"` | R1 落盘（+ `from.sid` 是受保护线） |
| `S69 the broadcast result asks for the in-session [handoff] line` | R1 文案 |
| `S69 … and never demands a collab_send receipt to the protected requester` | R1 反向断言（不含 `collab_send {target:"<受保护 sid>"`） |
| `S69 the spawned session is told to write the [handoff] line in its own reply` | 接管请求 prompt 文案（spawn） |
| `S69 the pull takeover prompt keeps ①③ and stays queue` | 三步骨架 + queue |
| `S69 collab_accept switches to pull wording` | accept 输出分支 |
| `S69 a non-protected requester stays push` | 非受保护 requester 字段不变 |
| `S69 … and its text still asks for the collab_send receipt` | 非受保护文案逐字不变 |
| `S69 the whitelist fixture really is "this bid's requester + its claimant"` | 前置条件（from/claim.by/pull） |
| `S69 the claimant's kind=reply receipt is delivered to the protected requester` | R2 正例（三条件全中） |
| `S69 … forced to queue even when steer was asked for` | 「放行时仍用 queue」 |
| `S69 … and it does not touch the record` | 放行不改记录状态 |
| `S69 an explicit bid authorizes the bounded reply without a [handoff] line in the body` | bid 入参优先 |
| `S69 a bystander (not the claimant) cannot reply` | 反例：sender 错 |
| `S69 another protected session is not this bid's requester → refused` | 反例：target 错 |
| `S69 a foreign bid (no record ties target + claimant) → refused` | 反例：bid 错 |
| `S69 request … stays fail-closed` | 反例：`request` |
| `S69 note … stays fail-closed` | 反例：`note` |
| `S69 collab_reply is whitelisted by the same rule` | `collab_reply` 接线 |
| `S69 pull 提取：… → done` + `… receipt points at the claimant` | R4 pull 提取闭环（`receipt.auto`，摘要 ≤200 字符） |
| `S69 the pull reminder says no pushed receipt is expected` | R3 pull 提醒 |
| `S69 a push reminder still points at collab_inbox` | R3 非 pull 不变 |

`docs/` 的 S38/S43 断言在本仓自动 skip（`hasRepoDocs=false`，包不在 monorepo 内），未改。

---

## 3. 原始输出（本机，2026-11-18）

```
$ pnpm build
ℹ dist/index.js    160.04 kB │ gzip: 49.38 kB
ℹ dist/index.d.ts    2.72 kB │ gzip:  1.25 kB
✔ Build complete in 3079ms

$ pnpm typecheck
$ tsc --noEmit          # 无输出 = 通过

$ node test/handoff-harness.mjs | tail -1
=== 295/295 checks passed           # 基线 272 + 新增 23

$ node test/readonly-default.mjs | tail -1
=== 12/12 checks passed

$ node scripts/check-skill.mjs
✓ skills/collab/SKILL.md (collab)
skills ok
```

关键实测片段（同一轮）：

```
--- S69 pull record used for the reply whitelist
{"bid":"b_7b46805c9eebc769","from":"ses_e1eb91cebffeTv1467ubJLKebk","claimBy":"ses_spawn_8","receiptMode":"pull","state":"claimed"}

--- S69 bounded reply from the claimant (allowed)
已投递 → ses_e1eb91cebffeTv1467ubJLKebk  agent=build  state=busy  title="schema"
kind=reply  thread=t_…  status=answered
mode=queue(forced)  message=…  delivery=queue
注: 本单由该受保护会话发起：回执按白名单放行（kind=reply + bid 归属该记录 + 领取人本人），强制 queue 投递。

--- S69 bounded reply from a bystander
拒绝投递：目标 ses_e1eb91cebffeTv1467ubJLKebk 本身在 protect 名单内（… protect + 内置硬名单…）。

--- S69 pull 提取（租约到期，发起方重新广播同内容触发 refresh）
state=done auto=true ; receipt={"from":"ses_spawn_8","by":"ses_spawn_8","note":"已按提案改好","auto":true}

--- S69 reminder（pull）
- 交接未闭环 b_…：… → pull 模式（发起方在 protect 名单内）：无需等待推送回执，租约到期后会只读提取承接方的最后一条回复…
```

> 注：harness 里的 `ctx.session.prompt` 是假宿主（只入数组），S69 的放行用例**没有**真的向
> `ses_e1eb…` 投递任何内容，也没有改它的权限。

---

## 4. CHANGELOG

`CHANGELOG.md` 新增 `## [未发布]`（`### Fixed`）条目，描述 pull 模式 + 限界 reply + 新字段 + S69。
**未改** `package.json` 的 `version`：发版 `0.1.2`、tag、`npm publish` 按分工由主会话执行（本次任务约束禁止
tag/push/发版）。

---

## 5. 未完成 / 需主会话接手

1. **R5 文档未落盘（工作区边界）**：`docs/collab.md` 与 `.trellis/spec/guides/cross-workspace-collab-guide.md`
   **不在本工作区**（本仓 `git log --all -- docs/collab.md` 为空），唯一真源在 `/data/project/muke-pos-app`。
   按全局「工作区与数据边界」其他工作区**文档也只读**（豁免仅 `docs/issues/**`），故未改。
   已把逐字可粘贴的补丁写在 `research/docs-patch.md`（§11.4 替换段 + §11.4.1 新小节 + §12.2/§12.5 补白 +
   guide §0/§5.2/§5.3/§9/§11 四处）。→ 请主会话在 muke-pos-app 应用，或授权后由本会话应用。
2. **提案状态回写**（`docs/issues/bugs-protected-requester-receipt-undeliverable.md`）按指示留给主会话。
3. **版本号 / 发布**：`package.json` 仍为 `0.1.1`；`0.1.2` bump + tag + CI 发布由主会话做。
4. **全局插件升级 + 两工作区 `/api/plugin` 复核**：未做（需发布完成后）。
5. **未验证项**（本机无真实宿主环境，只能靠 harness 假 ctx）：
   - 真实 OpenCode 宿主上「pull 提取」的触发时机：受保护会话自己重新 `collab_broadcast`（幂等分支）或
     `collab_handoff` 才会带 `actor=from.sid` 触发 `refresh`；`context` 注入对受保护会话是**空**（`chain.ts:410`），
     所以 pull 的提醒分支在真实宿主上是**防御性**的（只有非受保护但被标 pull 的记录才会看到）。
     → 建议主会话在真机确认「受保护发起方下一次广播/握手时」能收口。
   - `collab_send {kind:"reply"}` 无 threadID + 命中白名单时，走的是「新 thread + reply」的组合（`status=answered`）。
     真实宿主对 `kind:reply` 的 thread 语义是否影响 `collab_wait` 未在真机验证。
6. **未改（按边界）**：`BUILTIN_PROTECT` 名单、`request`/`steer` 的 fail-closed、`skills/collab/SKILL.md`
   （不属允许路径；它目前没提 pull 模式，如需可另行补一句）、`docs/issues/**`、`package.json`。

## 6. 顺带覆盖到的相邻场景（未新增代码）

- **`collab_handoff`（local scope）+ 受保护发起方**：`handoff.ts` 写的记录 `state:'acked'`、没有 `receiptMode`，
  文案仍提「回执用 `collab_reply {threadID}`」。以前那条 reply 会被护栏拒（同类死锁）；现在只要回执正文含
  `[handoff] DONE b_…`，`canReplyToProtected` 就能命中（`from.sid`=发起方、`claim.by`=本地目标、bid 归属），
  于是 local 场景**顺带可用**。pull 的「租约到期提取」不适用于 local（记录是 `acked` 不是 `claimed`），
  但 local 本来就有 thread + `collab_wait`，不依赖提取。未为此加断言（prd 只要求 peer scope）。

---

# R7 补齐（2026-11-18，第二轮）

owner 追加的 R7：把 `refresh()` 的只读提取从「仅 `claim.kind === 'spawn'`」扩到**全部领取类型**，并补结论词表。

## R7.1 改法

| 文件 | 位置 | 内容 |
| --- | --- | --- |
| `src/core/chain.ts` | `:299-336` | 触发条件去掉 `claim.kind` 过滤：`if (!lapsed \|\| !current.from?.sid \|\| !claim.by) return refreshBroadcast(record, now);`（`lapsed` 本身已要求 `state==='claimed'` + `claim.by` + 租约过期）。H2（`:338` 仅 `actor === from.sid`）与 R3（`:340` 承接方 protected 不读）原样保留；JSDoc 从「`claim.kind = spawn`」改写为「任何 claim.kind + 只有发起方能触发」。 |
| `src/core/verdict.ts` | `:92-103` | `BLOCKED_VERDICT_RE` 追加 `回执被[^。\n]{0,20}拒 \| 无法投递 \| 改回写提案 \| 回写提案 \| 已自愈 \| 不需要改 \| 无需改动`。仍走「先否定语/计划语 → 先 `[handoff]` 行 → 再 BLOCKED 词 → 最后 DONE 词」的顺序，所以真正的 `[handoff] DONE <bid>` 行不会被词表抢走；`done` 词表（`完成\|done\|fixed`，先剔除「分析完成」）不变。 |

行为影响面：
- 非 pull + `accept` / `handoff` 的 `claimed` 单，租约到期后**也会**在发起方那次刷新里只读收口（实例
  `b_26325553fb615e57` 正是 `claim.kind=handoff`，此前只能等回执）。
- `acked`（含 `b_bdae848832cd51fb`）**不在此次扩面内**：`lapsed` 要求 `state==='claimed'`，`acked` 没有租约路径
  （`refreshBroadcast` 只重开 `claimed`）。按指示未手工干预、也未擅自把提取扩到 `acked`（那会让「承接方正在做」的单被一次误读提前关掉）。见 §R7.3。
- pull 记录的行为与上一轮完全一致（放宽后是 R7 的真子集）。

## R7.2 新增回归（`test/handoff-harness.mjs` S70，`:3683-3790`，6 项）

| 断言 | 覆盖 |
| --- | --- |
| `S70 an accept-kind claim is closed from the claimant answer (R7)` | 非 pull + `kind=accept` + 租约过期 + `[handoff] DONE <bid>` → `done`、`receipt.auto`、`attempts=0` |
| `S70 a handoff-kind claim is closed as blocked from 「回执被硬拒 / 改回写提案」 (R7)` | 非 pull + `kind=handoff` + 「回执被硬拒、无法投递…已改回写提案」→ `blocked`，摘要含「改回写提案」 |
| `S70 no verdict keeps the old reopen path for accept/handoff claims too` | 非 pull + 无结论 → `open`、`attempts=1`、`skipped` 含承接方、无 `receipt` |
| `S70 a protected claimant is never read (R3)` | 用 `ctx.session.context` 探针计数：protected 承接方 0 次读取 |
| `S70 … and the hand-off is not auto-closed` | 同上记录保持 `open` + `attempts=1` |
| `S70 a bystander's refresh never closes it (H2)` | `actor=ses_a_target` ≠ `from.sid` → 不闭环，走原顺延 |

同时把 S50 一条断言的**标题**改为 `a lapsed accept-kind claim is not extracted by a bystander refresh (H2)`
（断言不改）：R7 之后该记录不闭环的原因是 H2（触发者不是发起方），不是 kind；注释也已同步，避免回归用例
叙述与实现漂移。S47/S48/S49/S50/S69 全部仍绿。

新增原始输出：

```
--- S70 accept-kind claim after the requester refresh
  ✓ S70 an accept-kind claim is closed from the claimant answer (R7) — {"state":"done","attempts":0,"receipt":{"from":"ses_r7_accept","by":"ses_r7_accept","note":"已按提案改好，测试通过","auto":true}}
--- S70 handoff-kind claim after the requester refresh
  ✓ S70 a handoff-kind claim is closed as blocked from 「回执被硬拒 / 改回写提案」 (R7) — {"state":"blocked","note":"回执被硬拒、无法投递到发起方；已改回写提案 docs/issues/fix-x.md，不再改代码。"}
  ✓ S70 no verdict keeps the old reopen path for accept/handoff claims too — {"state":"open","attempts":1}
  ✓ S70 a protected claimant is never read (R3) — 0 read(s)
  ✓ S70 … and the hand-off is not auto-closed — {"state":"open","attempts":1}
  ✓ S70 a bystander's refresh never closes it (H2) — {"state":"open","attempts":1}

=== 301/301 checks passed     # 295 + 6
=== 12/12 checks passed
```

## R7.3 真机记录抽查（只读，未干预）

`~/.config/opencode/collab-broadcast/` 里两条被点名的记录（只用 `cat`/`python json` 读取，**未**调用任何会
`persistRefresh` 的工具）：

| bid | state | claim.kind | receiptMode | 备注 |
| --- | --- | --- | --- | --- |
| `b_bdae848832cd51fb` | `acked` | `spawn` | 无 | 发起方是受保护 schema 线；**`acked` 没有租约路径**，R7 不覆盖（见 R7.1）。未手工干预。 |
| `b_26325553fb615e57` | `done` | `handoff` | 无 | 已是 `done`（有人/某次刷新已收口）；R7 前它只能等回执，R7 后同类单会被提取收口。 |

→ 需要主会话决定是否把提取再扩到 `acked`（`lapsed` 之外新增一条「acked 静默过期」判定）；本轮按 R7 的
字面范围（`lapsed && from.sid && claim.by`）实现，没有自行加码。

## R7.4 验收（本轮重跑）

```
$ pnpm build      ✔ Build complete
$ pnpm typecheck  $ tsc --noEmit    # 无输出 = 通过
$ pnpm test       === 301/301 checks passed / === 12/12 checks passed
$ node scripts/check-skill.mjs   skills ok
```

---

# R8 补齐（2026-11-18，第三轮）

owner 裁决：给 `acked` 加一条「静默 2h 允许发起方提取」的收口路径（`b_bdae848832cd51fb` 这类）。

## R8.1 改法

| 文件 | 位置 | 内容 |
| --- | --- | --- |
| `src/constants.ts` | `:80-88` | 新增 `ACKED_EXTRACT_MS = 2 * 60 * 60 * 1000`（紧邻 `BCAST_LEASE_MS`） |
| `src/types.ts` | `:246-252` | `BroadcastRecord.staleNoticedAt?: number` —— acked 提取「本窗口已查过」的戳（只增字段） |
| `src/core/claim.ts` | `:58-61` | `normalizeBroadcast` 归一化 `staleNoticedAt`（`Number(...) \|\| undefined`） |
| `src/core/claim.ts` | `:295-302` | `persistRefresh` 的 `changed` 判定加入 `staleNoticedAt` 差异（否则只有戳变化时不会落盘） |
| `src/core/chain.ts` | `:299-378` | `refresh` 的两条触发条件：`lapsedClaim`（`claimed` + 租约过期，既有）**或** `staleAcked`（`acked` + `now - claim.at > ACKED_EXTRACT_MS`）；两者都必须 `current.from?.sid && claim.by` |
| 同上 | `:353-356` | 窗口去重：`staleAcked && staleNoticedAt && now - staleNoticedAt < ACKED_EXTRACT_MS` → 直接走 `refreshBroadcast`（不读对端历史） |
| 同上 | `:361-366` | 判不出结论且 `staleAcked` → 返回 `{ ...current, staleNoticedAt: now }`：**状态仍是 `acked`、attempts 不变、无 receipt**；`claimed` 路径保持原样（`refreshBroadcast`，无戳） |
| 同上 | `:367-374` | 成功路径与既有完全一致：`state=done|blocked`、`receipt{auto:true}`、`replies` 追加、`releaseLock`、**不** `attempts++` |
| `src/tools/list.ts` | `:104-115` | `collab_list` 对 `acked` 且静默 > 2h 的记录追加 `静默=Nh 可自动提取`（只读快照，不动状态） |

护栏未动：H2（`actor === from.sid`）、R3（承接方 protected 不读）、`done/blocked/expired` 不处理
（两者条件都不成立 → 直接 `refreshBroadcast`）。

## R8.2 新增回归（`test/handoff-harness.mjs` S71，`:3792-3899`，6 项）

| 断言 | 覆盖 |
| --- | --- |
| `S71 an acked hand-off silent for 2h+ is closed from the claimant answer (R8)` | 2h01m + `[handoff] DONE <bid>` → `done`、`receipt.auto`、`attempts=0` |
| `S71 no verdict keeps the acked state (no downgrade, no attempts++)` | 无结论 → `acked`、attempts 0、无 receipt |
| `S71 … and stamps staleNoticedAt so the next window alone re-reads` | 戳已落盘，且同窗口第二次刷新**再读次数 = 0**（`ctx.session.context` 探针：总计 1 次） |
| `S71 an acked hand-off younger than 2h is never read or closed (R8)` | 1h → 仍 `acked`、无 receipt、无戳 |
| `S71 a bystander's refresh never reads or closes a silent acked hand-off (H2)` | `actor=ses_a_target` → 仍 `acked`、无戳 |
| `S71 a protected claimant is never read for a silent acked hand-off (R3)` | 探针 0 次读取，状态仍 `acked` |

原始输出：

```
--- S71 silent acked hand-off after the requester refresh
  ✓ S71 an acked hand-off silent for 2h+ is closed from the claimant answer (R8) — {"state":"done","attempts":0,"receipt":{"from":"ses_r8_done","by":"ses_r8_done","note":"已按提案改好","auto":true}}
  ✓ S71 no verdict keeps the acked state (no downgrade, no attempts++) — {"state":"acked","attempts":0}
  ✓ S71 … and stamps staleNoticedAt so the next window alone re-reads — staleNoticedAt=1794958862134 reads=1
  ✓ S71 an acked hand-off younger than 2h is never read or closed (R8) — {"state":"acked","attempts":0}
  ✓ S71 a bystander's refresh never reads or closes a silent acked hand-off (H2) — {"state":"acked"}
  ✓ S71 a protected claimant is never read for a silent acked hand-off (R3) — reads=0 state=acked

=== 307/307 checks passed     # 301 + 6
=== 12/12 checks passed
```

## R8.3 关于 `b_bdae848832cd51fb`

它是 `acked` + 发起方为受保护 schema 线 + `claim.at = 1794955936531`（≈2h+ 前）。R8 之后：

- 只要**发起方自己**下次触发一次刷新（`collab_broadcast` 幂等分支 / `collab_handoff` / 对同一 bid 的
  `collab_accept`──受保护会话被 accept 拒绝，故实际是前两者），就会按新规则读 `ses_e1449fcecffeeVe2hVpnMEEWoq`
  的最后一条回答：有结论 → `done|blocked`；判不出 → 保持 `acked` 并写 `staleNoticedAt`（每 2h 最多再读一次）。
- 受保护会话**没有** `context` 注入（`chain.ts:410` 对 protect 线返回 `[]`），所以不会「自动」发生——需要它在
  下一次广播/握手时顺带触发。本次未手工干预该记录（仅 `cat` 只读查看）。
- 若希望它立刻收口：由主会话在 schema 线跑一次同内容 `collab_broadcast`（幂等，不会新建会话、不会重投）。

## R8.4 验收（本轮重跑）

```
$ pnpm build      ✔ Build complete
$ pnpm typecheck  $ tsc --noEmit    # 无输出 = 通过
$ pnpm test       === 307/307 checks passed / === 12/12 checks passed
$ node scripts/check-skill.mjs   skills ok
```

---

# 复核收尾（2026-11-18，第四轮）

独立复核结论「代码可提交」，2 处加固 + 3 处文档不符 + 1 处过期标注，本轮全部处理。

## C1. 代码加固

| 项 | 文件 | 位置 | 改动 |
| --- | --- | --- | --- |
| R2 白名单不校验记录状态 | `src/tools/shared.ts` | `:39-83` | `canReplyToProtected` 增加 `if (BCAST_DONE_STATES.includes(String(record.state))) return undefined;` —— `done/blocked/expired` 一律不因白名单放行（已闭环的单没有可回执的内容，避免白名单变成进受保护线的通用通道）；`BCAST_DONE_STATES` 重新 import |
| R8 缺 `claimAt > 0` | `src/core/chain.ts` | `:346-352` | `staleAcked` 增加 `claimAt > 0`：`claim.at` 缺失时 `now - 0 > 2h` 恒真、`since: 0` 会把很久以前的回答当结论；`claimed` 路径保持原样（既有行为，未在本轮扩大改动面） |

`since` 本来就是 `claim.at`（`since: claimAt`），配合新守卫后 acked 的读取窗口才是有意义的。

## C2. 文档（本仓 `docs/collab.md`，主会话已落地该文件）

| 项 | 位置 | 改动 |
| --- | --- | --- |
| 工具表补 `bid?` | `:256-257` | `collab_send` 入参 `{ target, text, kind?, threadID?, bid?, mode?, confirm }`、`collab_reply` 入参补 `bid?`，并说明它只服务「限界 reply 归属判定」 |
| `acked` 不等于「租约到期」 | `:316`、`:331-332`、`:447-449`、`:491-494`、`:540-558` | pull 的闭环/提醒两行、`receipt.auto` 语义、§12.2 ⑥、§12.5 #11 全部改写为「`claimed` 才是租约到期；`acked` 没有租约，是静默超 `ACKED_EXTRACT_MS`=2h」；#12 补「`claim.at` 缺失一律不读」 |
| pull 提醒的**不可达**说明 | `:336-339`（§11.4.1 表格后） | 明确「受保护会话没有 `context` 注入 → 该提醒在真实宿主用户看不到，是防御性代码；收口发生在发起方下一次 `collab_broadcast`/`collab_handoff` 刷新」，不再承诺用户能看到 |
| 白名单再补「已闭环不适用」 | `:313-315` | 与 C1 对齐（`done/blocked/expired` 仍 fail-closed） |

guide 的两处同源不一致也顺手对齐（同一类「文档不符」，未被点名但不该留矛盾）：
`.trellis/spec/guides/cross-workspace-collab-guide.md:139` 的「例外（租约到期自动提取）」标题与首句改成
「只读自动提取」+ `claimed`（任何 kind）/ `acked`（静默 2h）；`:264` 的闭环 bullet 同样区分两者。

## C3. 过期标注

`.trellis/tasks/11-18-collab-protected-receipt/research/docs-patch.md` 顶部加：
`> ⚠ 已作废：补丁已由主会话应用到 docs/collab.md 与 guide；本文保留仅作历史，勿再次应用。`

## C4. 回归（S71 追加 3 项）

| 断言 | 覆盖 |
| --- | --- |
| `S71 a decided bid no longer authorizes a reply into the protected requester` | `state=done` 的 bid，其领取人 `kind=reply` 到受保护发起方 → 被拒（`/protect 名单/`） |
| `S71 … and the rejection is the plain lineage guard (no whitelist bypass)` | 拒绝文案是普通血缘护栏，不是白名单放行 |
| `S71 an acked record without claim.at is never extracted (0 reads, state untouched)` | `claim.at` 缺失 + 5h 前 `ackedAt` → 探针 0 次读取、状态仍 `acked`、无 receipt、无 `staleNoticedAt` |

原始输出：

```
  ✓ S71 a decided bid no longer authorizes a reply into the protected requester — 0ms / 拒绝投递：目标 ses_e1eb91cebffeTv1467ubJLKebk 本身在 protect 名单内（…）。未发送任何内容。
  ✓ S71 … and the rejection is the plain lineage guard (no whitelist bypass) — 拒绝投递：目标 ses_e1eb91cebffeTv1467ubJLKebk 本身在 protect 名单内（…）。
  ✓ S71 an acked record without claim.at is never extracted (0 reads, state untouched) — reads=0 state=acked staleNoticedAt=undefined

=== 310/310 checks passed     # 307 + 3
=== 12/12 checks passed
```

## C5. 验收（本轮重跑）

```
$ pnpm build      ✔ Build complete
$ pnpm typecheck  $ tsc --noEmit    # 无输出 = 通过
$ pnpm test       === 310/310 checks passed / === 12/12 checks passed
$ node scripts/check-skill.mjs   skills ok
```

仍未做（按分工）：`package.json` 版本 bump、tag、`npm publish`、全局插件升级、提案状态回写 —— 均由主会话执行。

