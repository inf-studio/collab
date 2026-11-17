# 独立复核报告 — `11-18-collab-protected-receipt`

日期：2026-11-18 · 复核人：`trellis-check`（冷上下文，只审不改）· 基线：`0.1.1`（`500222a`）+ 未提交改动
复核对象：`src/**`、`test/handoff-harness.mjs`、`CHANGELOG.md`（复核开始时 `git diff --stat` = 13 files, +880/−50）
复核窗口：07:44–07:48 —— **期间主会话并行迁入 `docs/collab.md` / guide，另一任务改了 `README.md` / `skills/collab/SKILL.md`**，两者均已按当前文本复核，见第 7、8 项。

## 结论（一句话）

**代码可提交**：R1 / R2 / R7 / R8 四条需求与 8 项必查的**行为侧全部通过**（我用自建假 ctx + 自造时间独立复现 58 项断言，全绿；仓库回归 307/307 + 12/12、build/typecheck/check-skill 全绿），未发现越权（`request/note/steer` 仍 fail-closed）、越界改动或吞错。
**文档侧基本收口**：`docs/collab.md` + guide 已在复核期间由主会话迁入本仓并写入 pull/R8 内容，与实现一致；剩 3 处措辞/表格待补（工具表漏 `bid?`、两处把 `acked` 写成「租约到期」）。
**另有 4 条低风险加固建议**（其中 2 条我复现出了具体行为），且**提交必须显式路径**（工作区同时含另一个任务的 `README.md` / `skills/collab/SKILL.md` 改动）。

---

## 复核方法

不采信既有断言。自写探针 `/tmp/opencode/check-probe.mjs`（不入库、不改实现）：

- 自建假宿主 ctx（`session.get/list/context/prompt/create`、`storage`、`tool.transform`、`session.hook`），全部 fixture 自造；
- `COLLAB_BROADCAST_DIR` / `COLLAB_GRANT_DIR` / `COLLAB_CONFIG` 指向临时目录 —— **未读写真实 `~/.config/opencode/collab-broadcast/`**（真记录 `b_bdae848832cd51fb` 等未被触碰）；
- 时间用 `claim.at / ackedAt / staleNoticedAt` 偏移伪造（301s、1h、2h01m、3h、30d）；
- 读取次数用包装 `ctx.session.context` 计数，验证「protected / 旁观者 / 同窗口 0 读取」；
- 结果：**58/58 PASS**（日志 `/tmp/opencode/probe.log`）。

---

## 8 项逐条

### 1. pull 判定与文案 — **通过**

| 证据 | `file:line` |
| --- | --- |
| 创建时判定 `protectedAncestor(me)` → `receiptMode`（preview/幂等之前算，写进 spawn + open 两条记录） | `src/tools/broadcast.ts:89-97`、`:257`、`:328` |
| `handoffActions({receiptMode})` pull 分支（②③ + 「不要尝试 collab_send」+ 推辞改为「不领取即可」） | `src/core/verdict.ts:241-259` |
| `collab_accept` 的 `receiptLines(record)` 按 `receiptMode` 分支 | `src/tools/accept.ts:14-27`、`:135`、`:215` |
| 接管请求 / 叫醒 prompt（`deliverAsk`）按 `receiptMode` | `src/tools/shared.ts:376-394` |
| 注入「接管请求」行按 `receiptMode` | `src/core/chain.ts:454-461` |
| 幂等分支（同内容再广播）回执说明 | `src/tools/broadcast.ts:135-139` |
| 未闭环提醒按 `receiptMode` | `src/core/chain.ts:490-501` |

我的复现（`A1`/`A4`/`A5`/`A6`）：

- 受保护发起方（spawn 路径）→ 记录 `receiptMode:"pull"`；广播结果 / 接管 prompt / `collab_accept` 输出**都不含 `collab_send {...}` 指令**，含「最后一条回复」+ `[handoff] DONE <bid>`；`collab_accept` 仍 `claimed→acked`。
- 受保护发起方（ask 路径，有 ≥80 候选）→ 记录 pull + `state=open`；结果里推辞是「不领取即可（5 分钟不答自动顺延…；pull 模式没有推送，不需要 DECLINE 回执）」，**无 DECLINE 指令**；注入的接管行同样是 pull 文案。
- **push 分支逐字未变**：把 `git show HEAD:src/core/verdict.ts` 里的 `handoffActions()` push 五段文本硬编码，断言广播输出**整体 contains** 该块（A4 PASS）；非受保护 requester 记录 `receiptMode:"push"`，结果里仍有 `collab_send {target:"ses_req", text:"[handoff] DONE <bid>`，且无「最后一条回复」。
- 旧记录（无 `receiptMode`）→ 注入仍是 push 文案（A5），缺省语义正确。

> 说明 ①：pull 文案里出现 `collab_send` 字样只出现在**禁令**（「不要尝试 collab_send」），不是指令；我按「不含 `collab_send {…}` 命令」判定，与 prd 验收措辞一致。
> 说明 ②：`injectionFor` 对受保护会话直接返回 `[]`（`chain.ts:431`），而 `receiptMode:"pull"` 只由受保护发起方产生 → **pull 的「未闭环提醒」在真实宿主不可达**（只有 harness 伪造 `from.sid=ses_req` 时可见，S69f）。文案正确、属防御性代码，见风险 R3。

### 2. 限界 reply 三条件 — **通过**

| 证据 | `file:line` |
| --- | --- |
| `RECEIPT_BID_RE = /\b(b_[0-9a-f]{8,32})\b/`；`canReplyToProtected()`：`normalizeKind(kind)==='reply'` → 入参 bid 优先、正文兜底 → `readBroadcast` → `from.sid===target` 且 `claim.by===sender`；只读不改记录 | `src/tools/shared.ts:21`、`:39-67` |
| `dispatch` 增加 `allowProtectedReply`；`if (guard && !allowProtectedReply) throw` | `src/tools/shared.ts:173`、`:196` |
| 放行时强制 `queue`（即使调用方传 `steer`）+ 注记；preview 也显示 `queue(forced)` | `src/tools/shared.ts:217-225` |
| `collab_send`：保留 `requestedKind`，无 threadID 时撤销 reply→request 降级 | `src/tools/send.ts:68-80`、`:114-127`、`:134-160` |
| `collab_reply`：同一判定（kind 恒 reply） | `src/tools/reply.ts:73-88` |
| 工具 schema 新增 `bid` | `src/tools/send.ts:32-37`、`src/tools/reply.ts:28-33` |

我的复现（`B1`–`B14`，全部自造记录 `b_cccc000000001111`，`from.sid=ses_e1eb…`、`claim.by=ses_claim_b`）：

| 用例 | 结果 |
| --- | --- |
| 三条件全中（`mode:"steer"` + 正文带 bid） | 投递成功、`delivery=queue`、`mode=queue(forced)`、含「白名单放行」 |
| 记录未被改动 | 文件**字节一致**（before/after 比对） |
| 只传入参 `bid`、正文无 `[handoff]` 行 | 投递成功 |
| sender 错（旁观） / target 错（`ses_e23a…`） / bid 不存在（`b_dddd…`） / bid 属别人的记录 | 4 例全部 `throw …protect 名单…` |
| `kind=request` / `kind=note` / `kind=steer`（→request） / 无 `sessionID`（sender 空） | 4 例全部被拒（fail-closed） |
| `confirm:false` | 只预览、显示 `queue(forced)`、未追加 prompt |
| `collab_reply`（thread 对端=受保护） | 同一白名单放行；不带 bid 的普通 reply 仍被拒 |
| 边界：target 是受保护会话的**子会话**、且记录 `from.sid` 正是该子会话 | 放行（② 是身份相等，不是血缘） |
| 边界：target 是子会话、记录属于祖先 | 拒绝（命中「祖先第 1 级」） |

### 3. R7 提取扩面 — **通过（含一处叙述性偏差）**

| 证据 | `file:line` |
| --- | --- |
| `lapsedClaim` 去掉 `claim.kind === 'spawn'` 过滤（仍要求 `state==='claimed'` + `claim.by` + 租约过期） | `src/core/chain.ts:339-349` |
| H2（`actor===from.sid`）、R3（承接方 protected 不读）保持在前 | `src/core/chain.ts:350-355` |
| blocked 词表追加 `回执被…拒 / 无法投递 / 改回写提案 / 回写提案 / 已自愈 / 不需要改 / 无需改动` | `src/core/verdict.ts:102-103` |
| 判定顺序不变：否定/计划 → `[handoff]` 行 → blocked 词 → done 词 | `src/core/verdict.ts:175-211` |

我的复现（`C1`–`C10`、`E1`，fixture 自造、`actor=ses_req===from.sid`）：

- `claimed` + `kind=accept` + 301s + 最后一条 `[handoff] DONE <bid>` → `done`、`receipt.auto=true`、`receipt.by=<claimant>`、`attempts=0`。
- `claimed` + `kind=handoff` + 「回执被硬拒、无法投递…已改回写提案」→ `blocked`，摘要含「改回写提案」。
- 「已自愈，无需处理。」→ `blocked`。
- **真实态**（`acked` + `kind=handoff` + 2h01m）→ `blocked`（E1），证明 accept/handoff 单真的能收口 —— 走的是 R8 触发。
- 无结论 → 原路径：`open`、`attempts=1`、`skipped` 含承接方、无 `receipt`（C4）。
- 受保护承接方 → `context` 读取 **0 次**，不闭环（C5）。
- 旁观者（`actor=ses_other`）→ 0 读取、不闭环（C6）。
- `[handoff] DONE <别的 bid>` → 不闭环（H1，C7）；同一回复含「还没验证」→ 不闭环（否定语，C8）。
- `spawn` 老路径未回归（C10）。

> **叙述性偏差（低）**：`claim.kind=accept/handoff` 的真实状态是 **`acked`**（`accept.ts:112-117`、`:181-195`；`handoff.ts:172-179`），不是 `claimed`。因此 R7 去掉 kind 过滤对真实 accept/handoff 单是**无效分支**（只有 S70 的合成 fixture 会命中），真实覆盖来自 R8 的 2h 窗口 —— 即「租约到期（5min）收口」对 accept/handoff 并不成立，实际是「2h 静默收口」。功能上满足验收（能收口），但文档/注释措辞需要按此修正（见第 8 项）。
> 另：S50 的断言表达式**未改**（仅标题/注释改动，已 diff 核对）；但新标题「…by a bystander refresh (H2)」不精确 —— 该 fixture 的记录**没有 `from` 字段**，真正拦住它的是 `!from?.sid`，不是 H2。

### 4. R8 `acked` 2h — **通过**

| 证据 | `file:line` |
| --- | --- |
| `ACKED_EXTRACT_MS = 2h` | `src/constants.ts:88` |
| `staleAcked`（`acked` + `claim.by` + `now-claim.at>2h`）+ 与 `lapsedClaim` 并列 | `src/core/chain.ts:348-349` |
| 窗口去重：`staleNoticedAt` 在 2h 内 → 不读 | `src/core/chain.ts:356-359` |
| 无结论 → 状态/attempts 不变，只写 `staleNoticedAt` | `src/core/chain.ts:364-369` |
| 有结论 → `done|blocked` + `receipt{auto:true}` + `releaseLock`，不 `attempts++` | `src/core/chain.ts:370-379` |
| 新字段 + 归一化 + 落盘判定 | `src/types.ts:241-246`、`src/core/claim.ts:59-60`、`:295-303` |
| `collab_list` 只读标注 `静默=Nh 可自动提取` | `src/tools/list.ts:107-113` |

我的复现（`D1`–`D7`、`E2`）：

- 2h01m + `[handoff] DONE` → `done`、`attempts=0`、**锁已释放**；2h01m + 「回执被硬拒…改回写提案」→ `blocked`（E1）。
- 2h01m + 无结论 → 仍 `acked`、`attempts=0`、无 `receipt`，`staleNoticedAt` 已落盘；**同窗口第二次刷新读取次数仍为 1**（总计 1）。
- 1h → **0 读取**、无 `staleNoticedAt`、仍 `acked`。
- 受保护承接方 → **0 读取**、无戳、不闭环。
- 旁观者（`actor≠from.sid`）→ **0 读取**、无戳、不闭环。
- `staleNoticedAt` 已过 2h（伪造 2h01m 前的戳）→ 重新读并收口（窗口会滚动，D6）。
- 已 `done` 的记录 → 不再处理（D7）。
- `collab_list`：3h 静默 `acked` 显示 `静默=3h 可自动提取`；1h 的不显示（E2）。

### 5. 回归 — **通过**

```
$ pnpm build        → build_exit=0   ✔ Build complete in 1513ms（164.57 kB）
$ pnpm typecheck    → typecheck_exit=0   $ tsc --noEmit（无输出）
$ pnpm test         → test_exit=0
                       === 307/307 checks passed
                       === 12/12 checks passed
$ node scripts/check-skill.mjs → ✓ skills/collab/SKILL.md (collab) / skills ok（skill_exit=0）
```

注：实现笔记里说「基线 279」，实际当前仓基线为 **272**（S69 前 272 → S69 +23 = 295 → S70 +6 = 301 → S71 +6 = 307）；数字自洽，只是 prd 里写的 279 与实际基线不符（不影响验收）。

### 6. 安全 — **通过**

- `BUILTIN_PROTECT` 未改：`git diff src/constants.ts` 只新增 `ACKED_EXTRACT_MS`（常量 38 行原样）。
- `request/note/steer` 仍 fail-closed：`canReplyToProtected` 第一行 `normalizeKind(kind) !== 'reply' → undefined`（`shared.ts:52`）；我用 request/note/steer/无 sender 四例实测全被拒（B6/B6b/B6c/B6d）。
- 伪造风险：白名单只看**记录归属**（`from.sid` + `claim.by`）+ bid 命中，不看调用方自述；旁观者/换 target/换 bid 四种伪造实测全拒。
- `notifyRequester` 未改动，仍是 note + fail-closed（`chain.ts:387-395`）。
- 无新依赖：`git diff package.json` 为空。
- 存储只增字段：`receiptMode`、`staleNoticedAt`；`normalizeBroadcast` 用 `...record` 透传，无键改名；旧记录缺字段行为=push/无戳。
- 放行路径仍强制 `queue`：`delivery` 被显式改写（`shared.ts:218`），实测 `mode:"steer"` 进来的也是 `delivery=queue`。

### 7. 范围 — **通过（但工作区被另一任务共用，提交必须显式路径）**

复核开始时的 `git status --short`（本仓）：

```
 M CHANGELOG.md
 M src/constants.ts  M src/core/chain.ts  M src/core/claim.ts  M src/core/verdict.ts
 M src/tools/{accept,broadcast,list,reply,send,shared}.ts  M src/types.ts
 M test/handoff-harness.mjs
?? .trellis/tasks/11-18-collab-protected-receipt/
?? .trellis/tasks/11-18-collab-self-report/     ← 另一个会话的任务目录
?? docs/issues/bugs-protected-requester-receipt-undeliverable.md
```

**复核结束前（07:47）工作区又变了** —— 主会话/其它会话并行落了别的东西：

```
 M README.md                    ← 属于另一个任务（11-18-collab-self-report：0.1.3 缺陷上报）
 M skills/collab/SKILL.md       ← 同上（新增「六点五、遇到异常怎么办」，与本任务无关）
?? docs/collab.md               ← R5 权威文档（47 KB，刚从别的仓迁入，含 pull/R8 小节）
?? .trellis/spec/guides/cross-workspace-collab-guide.md  ← 同上（含 pull/R8 补充）
```

- 本任务的改动仍然只在 `src/**` + `test/handoff-harness.mjs` + `CHANGELOG.md`，**未越界**；`package.json`、`docs/issues/**` 未改。
- **提交时必须显式路径**（`git add src test/handoff-harness.mjs CHANGELOG.md`）：`README.md` / `skills/collab/SKILL.md` 是另一个任务的改动，`docs/**`、`.trellis/**` 也不该混进本任务提交。
- 该提案文件 `docs/issues/…` mtime **07:21**，早于首个源码改动（07:27）→ 由主会话/上一轮创建，实现方未改；内容仍是「待修复」，R5 状态回写待主会话。
- 其它工作区未被本任务改动：`std-ui` `git status` 干净；`muke-pos-app` 只有其自身的 `mcp` 与 4 个 `docs/issues/*`（与本任务无关）。

### 8. 文档一致性 — **部分通过（R5 已由主会话并行落盘；3 处措辞/表格待补）**

复核开始时 `docs/collab.md` 在本仓**不存在**、`research/docs-patch.md` 的前提（真源在 muke-pos-app）当时成立；
07:42–07:43 文档被迁入本仓（`docs/collab.md` 47 KB、guide 36 KB）并由主会话写入 pull/R8 内容。我按**当前已落盘文本**逐条对照实现：

**已一致（逐字核对）**

- §11.4 fail-closed 段 + 「限界 reply」三条（`target===record.from.sid`、`sender===record.claim.by`、`bid` 入参优先/正文兜底）、强制 `queue`、不改记录、`request/note/steer` 仍拒 → 与 `shared.ts:39-67`、`:196-225` 一致。
- §11.4.1 pull 表（②③ 文案、推辞「不领取即可」、未闭环提醒）→ 与 `verdict.ts:241-259`、`chain.ts:490-501` 一致；旧记录缺字段按 push 的说明与 `broadcast.ts:97` 一致。
- §12.2 ⑤/⑥ 的 pull ⚠、R7 词表、R8「2h 由发起方提取」→ 与 `verdict.ts:102-103`、`chain.ts:348` 一致。
- §12.5 第 12 条（`ACKED_EXTRACT_MS`、`staleNoticedAt` 每窗口一次、protected/旁观者不读、`collab_list` 的 `静默=Nh`）→ 与 `constants.ts:88`、`chain.ts:348-369`、`list.ts:107-113` 一致。
- guide 头部第 8-10 行、§5.2/§5.3（第 162 行）、§9 护栏行（第 275 行）→ 与实现一致（且已含「`acked` 静默 2h 也可提取」）。

**待补/不准（均为文档措辞，非代码缺陷）**

1. **工具签名表漏了新增的 `bid?`**：`docs/collab.md` 的工具表仍写
   `collab_send | { target, text, kind?, threadID?, mode?, confirm }`、`collab_reply | { threadID, text, confirm }`，
   而实现已新增可选 `bid`（`send.ts:32-37`、`reply.ts:28-33`，`additionalProperties:false` 必须显式声明）。
   §11.4 正文提到「取入参 `bid`」，但表里没有 → 模型读表时不知道有这个入参。建议补 `bid?` 并注明「仅限界回执使用」。
2. **§12.5 第 11 条**：「`accept` 领取的单同样**在租约到期后**由发起方那次刷新提取（S70）」——
   `accept` 领取一律是 `acked`（`accept.ts:112-117`、`:181-195`），收口发生在 **2h 静默**（R8），不是 5min 租约。
   建议改为「`accept` 领取的单是 `acked`，按第 12 条的 2h 静默收口」。
3. **§12.2 ⑥** 仍写「对端没发回执时，**`kind=spawn` 的**租约到期会…只读提取」——R7 后不再限 `claim.kind`，
   与同文档 §12.5 第 11 条（「覆盖所有领取类型」）自相矛盾。建议删掉 `kind=spawn` 限定。

**另有一条必须处理**：`research/docs-patch.md` 已**作废/过期**，其 §3「`acked` 仍然没有租约路径：只等回执，不做提取」与
§4.3 同句**与已落盘文档和 R8 实现相反**。若后续有人照它再应用一次，会把刚写对的 R8 文档改回错误表述。建议在文件头标 `已应用（见 docs/collab.md）/ 勿再使用`。

**仍未做的**：提案 `docs/issues/bugs-protected-requester-receipt-undeliverable.md` 头部状态仍是「待修复」（R5 最后一项，主会话职责）。

---

## 原始输出（关键片段）

```
$ node /tmp/opencode/check-probe.mjs | tail -1
=== PROBE 58/58 passed

--- A1 pull (spawn) --------------------------------------------------------
  PASS  A1 protected requester → record.receiptMode="pull" — {"receiptMode":"pull","from":"ses_e1eb91cebffeTv1467ubJLKebk"}
  PASS  A1 broadcast result asks for the in-session line — … ③ 只分析、不调用工具 = 未完成：结论必须写在本会话最后一条回复里（含上面的 [handoff] 行）。
  PASS  A1 broadcast result never asks for a collab_send receipt — no collab_send command
  PASS  A1 spawn prompt: in-session line, no collab_send command, queue — queue / collab_send cmd=false
  PASS  A1 collab_accept on a pull record: in-session line, no collab_send command —    不要 collab_send——租约到期后它会只读提取你最后一条回复并自动闭环。
  PASS  A1 ask-path record is pull too — {"receiptMode":"pull","state":"open","asked":"ses_l1"}
  PASS  A1 pull: no DECLINE receipt is demanded — 推辞: 不领取即可（5 分钟不答自动顺延下一候选；pull 模式没有推送，不需要 DECLINE 回执）
  PASS  A1 pull takeover injection: in-session line, no collab_send command — ② 回执（pull 模式，必写）: 在本会话最后一条回复里写一行 `[handoff] DONE b_…
  PASS  A4 non-protected requester → receiptMode "push" — {"receiptMode":"push"}
  PASS  A4 push text is byte-identical to HEAD handoffActions() (spawn variant)
  PASS  A5 legacy record (no receiptMode) keeps the push ask text
  PASS  A6 pull reminder explains "no pushed receipt" — … 无需等待推送回执，租约到期后会只读提取承接方的最后一条回复…
  PASS  A6 push reminder still points at collab_inbox

--- B (R2) -----------------------------------------------------------------
  PASS  B1 all three conditions → delivered — 已投递 → ses_e1eb91cebffeTv1467ubJLKebk  agent=build  state=idle  title="schema"
  PASS  B1 forced to queue even when steer was requested — queue / mode=queue(forced)  message=msg_4  delivery=queue
  PASS  B1 record untouched by an allowed reply — byte-identical
  PASS  B3 sender wrong (bystander) → refused
  PASS  B3c target = protected descendant whose own bid it is → allowed
  PASS  B3d target = protected descendant, but the record belongs to the ancestor → refused
  PASS  B4 target wrong (other protected session) → refused
  PASS  B5 foreign bid (no such record) → refused
  PASS  B5b bid of another record (target/claimant do not match) → refused
  PASS  B6 kind=request → refused        PASS  B6b kind=note → refused
  PASS  B6c kind=steer (→request) → refused   PASS  B6d no session context (no sender) → refused
  PASS  B11 confirm:false → preview only, shows queue(forced)
  PASS  B12 collab_reply uses the same whitelist     PASS  B13 collab_reply without a bid stays refused
  INFO  B14 reply for an already-done bid → STILL ALLOWED (time-unbounded)

--- C (R7) -----------------------------------------------------------------
  PASS  C1 claimed + kind=accept + lapsed + DONE line → done — {"state":"done","attempts":0,"receipt":{"from":"ses_c1","by":"ses_c1","note":"已按提案改好，测试通过","auto":true}}
  PASS  C2 kind=handoff + 「回执被硬拒 / 改回写提案」 → blocked
  PASS  C3 「已自愈」 → blocked
  PASS  C4 no conclusion → open + attempts++ + claimant skipped + no receipt — {"state":"open","attempts":1}
  PASS  C5 protected claimant → 0 reads / not auto-closed — {"state":"open","attempts":1}
  PASS  C6 bystander refresh → no read, not closed — {"reads":0,"state":"open"}
  PASS  C7 a [handoff] DONE line for another bid never closes it (H1)
  PASS  C8 negation in the same answer blocks the verdict
  INFO  C9 「无法投递…已完成」 classified as state=blocked (BLOCKED words win over DONE words)
  PASS  C10 the old spawn path still closes (no regression)

--- D (R8) -----------------------------------------------------------------
  PASS  D1 acked 2h01m + conclusion → done, attempts unchanged — {"state":"done","attempts":0}
  PASS  D1 also released the lock
  PASS  D2 no conclusion keeps acked / attempts / no receipt — {"state":"acked","attempts":0}
  PASS  D2 stamps staleNoticedAt     PASS  D2 same window does not read again — 1 read(s) total
  PASS  D3 acked 1h → never read, no stamp, stays acked — {"reads":0,"state":"acked"}
  PASS  D4 protected claimant → 0 reads, no close, no stamp
  PASS  D5 bystander → no read, no close, no stamp (H2)
  PASS  D6 an expired read window re-reads and closes — {"state":"done"}
  PASS  D7 an already-done record is left alone
  INFO  D8 acked without claim.at → state=done reads=1 (claimAt=0 counts as "silent forever")

--- E / F ------------------------------------------------------------------
  PASS  E1 a real acked handoff claim closes as blocked after 2h (R7 words + R8 trigger)
  PASS  E2 collab_list marks a 3h-silent acked hand-off as extractable — - b_aaaa0000000000f2 acked 静默=3h 可自动提取 …
  PASS  E2 collab_list does not mark a 1h acked hand-off
  PASS  F1 protected requester re-broadcast closes the lapsed pull hand-off as done — {"state":"done","receipt":{"from":"ses_spawn_3","by":"ses_spawn_3","note":"已按提案改好","auto":true}}
  PASS  F1 … and the result text reports the closure — 已存在同一内容的交接（bid 幂等，不新建）：state=done attempts=0
```

`git diff` 侧：

```
$ git diff -U0 test/handoff-harness.mjs | grep '^-'
-// --- S50 (R2/R3): only a *lapsed spawn* claim is extracted; protected never is.
-  'S50 a lapsed accept-kind claim is not extracted either',
（仅标题/注释；断言表达式逐字未动）
$ git diff --stat package.json     → 空（无新依赖）
$ git show HEAD:src/core/verdict.ts | 对比 push 五段文案 → 与现实现逐字相同（A4 断言）
```

---

## 风险清单（均低，均不阻断提交）

| # | 风险 | 证据 | 建议 |
| --- | --- | --- | --- |
| R1 | **`research/docs-patch.md` 已过期且含错误表述**：§3 / §4.3 写「`acked` 无租约路径、只等回执、不做提取」，与已落盘的 §12.5 第 12 条（R8）及实现相反；照它再应用一次会把文档改错 | `docs-patch.md:97`、`:166` vs `docs/collab.md:537-542`、`chain.ts:348` | 文件头标「已应用（见 docs/collab.md）/ 勿再使用」，或直接删除 |
| R2 | **两处把 `acked` 写成「租约到期」**：`accept`/`handoff` 领取是 `acked`，收口在 2h 静默（不是 5min 租约）；R7 的 kind 放宽对真实单是无效分支 | `docs/collab.md:§12.5#11`、`:§12.2⑥`；`accept.ts:112-117,181-195`；`handoff.ts:172-179`；`chain.ts:341-349` | 文档改为「`acked` 2h 静默」；R7 注释说明它是历史/异常态兜底 |
| R3 | **pull 提醒不可达**：`injectionFor` 对受保护会话返回 `[]`，而 pull 只由受保护发起方产生 → 「无需等待推送回执」这条提醒在真实宿主永远看不到（S69f 是伪造 `from.sid`） | `chain.ts:431` vs `:490-501` | 保留（无害）；文档不要承诺用户会看到这条提醒 |
| R4 | **R2 白名单不校验记录状态**：`done/blocked/expired` 的 bid 仍允许其领取人再发一条 `kind=reply` 进受保护会话（我复现：`STILL ALLOWED`） | `shared.ts:39-67`（无 state 判定） | 加 `!BCAST_DONE_STATES.includes(record.state)`（一行，收紧「限界」语义） |
| R5 | **R8 缺 `claimAt > 0`**：`acked` 记录若 `claim.at` 缺失（损坏/历史），`now - 0 > 2h` 恒真且 `since=0` → 用全部历史判「最后一条」，可把 30 天前的回答当结论收口（我复现：`state=done`） | `chain.ts:348`、`:360-363` | `staleAcked` 加 `claimAt > 0` |
| R6 | **词表顺序副作用**：「无法投递…但已完成修复」会被判 `blocked`（blocked 词先于 done 词） | `verdict.ts:207-210`；复现 C9 | 符合 R7 字面要求，可接受；若担心低估完成度，可要求 blocked/done 词共存时不判定 |
| R7 | **local handoff 被 R8 覆盖**：`scope:"local"` 的 `acked` 记录 2h 后同样可被发起方提取收口（`handoff.ts` 写了 `claim.at`，`refresh` 无 scope 过滤） | `handoff.ts:172-187`、`chain.ts:348` | 行为正向，但 prd 只提 peer —— 文档需写明 local 也生效 |
| R8 | **工具签名表漏 `bid?`**：`docs/collab.md` 的 `collab_send` / `collab_reply` 入参见表未含新参数（schema 已声明、`additionalProperties:false`），模型读表时看不到；`skills/collab/SKILL.md` 仍只教 push 回执 | `send.ts:32-37`、`reply.ts:28-33` vs `docs/collab.md` 工具表；`skills/collab/SKILL.md:60,71` | 补 `bid?`（注明仅限界回执），并在 SKILL.md 补一句 pull 例外 |
| R9 | **工作区共用**：`README.md` / `skills/collab/SKILL.md` 已被另一任务（`11-18-collab-self-report`）改动 | `git status`；`git diff README.md skills/collab/SKILL.md` | 提交用显式路径，禁止 `git add -A` |
| R10 | 轻微开销：`canReplyToProtected` 每次 send/reply 多一次广播文件读；`refresh` 对每条记录多一次 lineage 查询（窗口内也会查） | `shared.ts:39-67`、`chain.ts:350-359` | 可接受，无需改 |
| R11 | 真机未验证项（承自 impl-notes）：① 无 threadID 的 `kind=reply` 组合（新 thread + reply）在真实宿主的 `collab_wait` 语义；② 受保护发起方无 context 注入，只能靠下一次广播/握手触发收口 | impl-notes §5 | 发布后在两工作区用 `collab_list` / 一次幂等广播抽查 |

---

## 是否可提交

- **代码：可以提交**（显式路径 `git add src test/handoff-harness.mjs CHANGELOG.md` —— **不要**带 `README.md` / `skills/collab/SKILL.md`（另一任务）、不要带 `docs/**` / `.trellis/**`）。四条需求行为侧全部通过，回归全绿，无越权、无吞错、无新依赖、存储只增字段。
- **文档：R5 已基本落盘**，提交前建议顺手补 R2/R8 三行措辞（工具表 `bid?`、两处「租约到期」→「2h 静默」），并把 `research/docs-patch.md` 标注作废（R1），避免以后被重复应用。
- **发布门（R6 `0.1.2`）**：`package.json` 仍是 `0.1.1`，属主会话职责，本轮未动，符合分工。注意工作区里另一任务在写 `0.1.3` 的说法（README/SKILL），发版前请确认版本号与 CHANGELOG 不打架。
- 建议在提交前（可选、非阻断）合并 R4/R5 两个一行加固；若本轮不改，请把它们记进任务 `research/DECISIONS-PENDING.md` 以免丢失。
