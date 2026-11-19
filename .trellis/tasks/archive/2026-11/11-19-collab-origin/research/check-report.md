# 复核报告：交接对接人（`origin`）

> 角色：独立复核（冷上下文，只审不改，未 commit / push / git add，未改实现文件）。
> 任务：`.trellis/tasks/11-19-collab-origin`；被复核对象：`/data/project/collab` 未提交改动
> （17 个文件，+970/−42，其中 `test/handoff-harness.mjs` +363/−0）。
> 复核时间：2026-11-19。实现方 `research/impl-notes.md` 只作线索，全部结论以下方自写探针为准。

> **第二轮（A+B 修复）已复核：通过（可提交），仅 2 条非阻塞文档小修。**
> 见文末「## 增量复核（A+B 修复）」——本文件上半部分是**首轮**结论（「需修」一项已在第二轮修掉并验证）。

## 结论

**需修（一处，属于本次新增的「对外承诺」与「测试真实性」，不涉及回滚）**，其余 7 项通过。

- ✅ 核心价值成立：A→B→C 两跳里 B **不填** `origin`，C 的记录与注入都是 **A**（含目录），
  `collab_status` / `collab_list` 也看得到 A。旧记录输出与 0.6.0 **逐字一致**（80 组渲染矩阵 + 工具级全文比对）。
- ❌ **唯一不通过项**：新增的回执提示行
  `src/core/verdict.ts:458`「跨层结论可直接发给它：`collab_send {target:"A", text:"[handoff] DONE <bid> …"}`（**同一条 [handoff] 行也能闭环本单**）」
  结论是 **假的**：该命令能把消息送到 A，但**不会闭环本单**。直接原因不是 `kind`（那只是下游闸门），而是
  `src/tools/shared.ts:128`（`canReplyToProtected` 第 ② 条判据）要求 `target === record.from.sid`（本单是 B），
  而提示把 `target` 指向了 A。同一句承诺同时写进了 `CHANGELOG.md:44`、`docs/collab.md:1397-1401`（§11.16.2）与 `docs/collab.md:1427`（§11.16.4 表格）、
  `README.md:48-50`（「阻塞时可直接发给 A 闭环（实测 4 跳 → 2 跳）」）。
  对应地，`test/handoff-harness.mjs:9948-9956` 用**合成的** `kind:'reply'` inbound 证明「2 跳闭环」，
  而真实插件根本产不出那条消息（见 §7）：所以该断言是自证，未覆盖它声称的路径。

修法两选一（见文末「最小改法」）：**推荐 B**（约 10 行代码，让 PRD 验收第 4 条真正成立）；
**A** 是纯文案回退（把「闭环」改成「先发给 A，本单闭环仍走 ② 回给发起方」）。

---

## 1. 两跳继承（核心价值）— **通过（对话链路）/ 不通过（按提示闭环）**

自写探针（`/tmp/probe/tool-probe.mjs flow`，假宿主：临时 `COLLAB_BROADCAST_DIR` + 自建 fake sessions/context/inbox 流）：

```text
### hop1_record
{"from":{"sid":"ses_p_a","directory":"<tmp>/ws/a"},"asked":{"sid":"ses_p_b",...}}
### hop1_record_after
{"state":"acked","claim":{"by":"ses_p_b","kind":"accept",...}}
### hop2_record
{"from":{"sid":"ses_p_b","directory":"<tmp>/ws/b"},
 "origin":{"sid":"ses_p_a","directory":"<tmp>/ws/a"},"ok":true}
### hop2_result（节选）
对接人（非本单发起方）：ses_p_a @ <tmp>/ws/a（继承自 <bid1>） —— 已写入记录 origin，对端注入/回执模板都会带上它
### hop2_inject（C 的 context 注入，前 4 行）
[collab-handoff] 交接链路提醒（每条只出现一次）:
你是承接方（bid=<bid2>）
完成后回执：[handoff] DONE|BLOCKED <bid2> <摘要>（…）
对接人（非本单发起方）：ses_p_a @ <tmp>/ws/a
### hop2_inject_has_origin_line  true
### hop2_inject_names_A_as_receipt_target  true
### hop2_status_head
<bid2>  state=acked  priority=normal  origin=ses_p_a @ <tmp>/ws/a  承接=ses_p_c…_p_c（accept）  canPush=true  "probe origin hop2"
### hop2_list_line
- <bid2> acked scope=peer "$ probe origin hop2" … 承接=ses_p_c attempts=0 … unacked=- via ses_p_a
```

- 继承逻辑：`src/core/claim.ts:140-158`（`holder = 未闭环 && claim.by === me`，按 `updatedAt` 取最新；
  `origin ?? from`；`upstream.sid !== me` 兜底）。B 未填任何参数 → 记录 `origin = A`。**通过**。
- C 拿到 A 的 sid 与 location（注入 + status + list 三处一致）。**通过**。
- **不通过**：C 按提示把 `[handoff] BLOCKED <bid2>` 发给 **A** 之后，记录仍停在 `acked`：

```text
### hop2_receipt_delivered_meta
{"collab":{"from":"ses_p_c…_p_c","fromSessionID":"ses_p_c","cid":"…","kind":"request","threadID":"<thread>","ts":…}}
### hop2_after_replay_askind
{"state":"acked"}                        ← 消息到了 A，本单没闭环
### hop2_after_replay_kindreply
{"state":"blocked","receipt":{"from":"ses_p_c",…,"source":"kind"}}
```

根因链（自读代码 + 探针双向验证）：

1. `src/tools/send.ts:195-206` 的 `boundedReply = canReplyToProtected({...})` 是「无 `kind` 的 `[handoff]` 回执 → 自动按
   `kind:reply` 投递」的唯一开关；
2. `src/tools/shared.ts:128` `if (String(record.from?.sid ?? '') !== String(target ?? '')) return undefined;`
   —— 只有发给**本单发起方**（B）才命中；
3. 于是发给 A 时 `boundedReply=false` → `kind=request` → 接收侧 `src/core/chain.ts:382`
   `if (source?.explicit && sourceKind !== 'reply') return undefined;` 直接丢弃。
   对照组（同一条命令发给发起方 B）**是通的**：`requester_receipt_state = {"state":"done","source":"kind"}`。

所以：**「C 能直接找到 A、把结论交给 A」成立（2 跳对话）**；**「同一条 `[handoff]` 行也能闭环本单」不成立**。

## 2. 显式覆盖 + 别名失败 — **通过**

```text
### override_record
{"origin":{"sid":"ses_p_c","directory":"<tmp>/ws/c"},"from":{"sid":"ses_p_b","directory":"<tmp>/ws/b"}}
### override_result_has_line  true          ← 覆盖继承，目录由 fillOriginDirectory 向宿主要到
### alias_refusal
未知对接人 "probe-nobody"：既不是 ses_ 会话 id，也不在别名表里（…）。未写入任何内容。
### alias_zero_write
{"bids":[2,2],"prompts":[5,5]}              ← 0 写入、0 投递
```

`collab_handoff` / `collab_send` 的同类拒绝由 S100f 覆盖，且代码上 `resolveOrigin` 在两个工具里都排在
**解析目标 / 任何写入之前**（`src/tools/handoff.ts:88-96`、`src/tools/broadcast.ts:153-161`、`src/tools/send.ts:110-131`）。
`origin == 发送者` 被丢弃：`self_origin_record {"hasOrigin":false}`、注入无对接人行（**通过**，见 §4 偏差 1）。

## 3. 兼容逐字 — **通过（两套独立证据）**

**(a) 渲染函数矩阵**（`/tmp/probe/render-compare.mjs`：同一组入参分别喂 HEAD 与工作区的 `src/core/verdict.ts`）：

```text
cases: 80, byte-identical: 80, differ: 0
```

覆盖 `peer × spawn × expected(implement|research) × receiptMode(push|pull)` 的
`protocolHeader` / `takeoverBody` / `handoffActions`，且每组都跑了「无 origin」与「origin == requester」两种。

**(b) 工具级全文比对**（HEAD `dist` 由 `git archive HEAD` 在 `/tmp/origin-head` 独立构建；
`/tmp/probe/tool-probe.mjs legacy` 覆盖 `collab_status` / `collab_list` / context 注入 / `collab_handoff` 结果+正文 /
`collab_send` 结果+正文，含「旧记录无 origin」与「origin == from」两份记录）：

```text
$ diff legacy-head.txt legacy-new.txt && echo IDENTICAL
IDENTICAL (legacy, HEAD vs new, 76 lines)
```

即：**不是只信 S100**，是直接拿 0.6.0 的构建产物与工作区构建产物做了字节比对。

## 4. 两处「与 design 偏差」是否成立

**偏差 1（`origin.sid === from.sid` 不落盘、不渲染）→ 成立，判定合理；但 design 表格需改。**

- 必要性：design §3 自己要求「仅当 `origin.sid !== from.sid` 时显示」；若不丢弃，S100a（第一跳）就要么渲染一行自我重复，
  要么在渲染层再判一次（等价，但记录里多一堆噪音）。
- 有没有更好等价做法：可以「照存 + 渲染层跳过」，但那样每条单跳记录都长出一个恒等于 `from` 的字段，
  `status`/`list`/继承都要多一层判断，收益为零。**当前做法更好**（`src/core/claim.ts:46-57`（`storedOrigin`））。
- 唯一需要跟的是 **design.md §5 第一行**（「A→B 显式 origin=A → 记录 origin=A；B 的注入含对接人行」）
  与 §3 自相矛盾（`origin == from` 时 §3 明说不显示）。建议作者把该行改成「显式自称链头 = 与首跳等价：不落盘、不渲染」，
  否则下一位复核者会把它当漏实现。代码无需改。

**偏差 2（`collab_send` 不继承、只显式生效）→ 部分成立：与 PRD R2 字面不冲突，但 R4 措辞需一句澄清；不改代码。**

- PRD R2 说「缺省 = 本会话」；`collab_send` 没有记录可写，`origin = 本会话` 在渲染上是空操作（`originHint` 返回 undefined），
  所以「显式才生效」与 R2 的**字面**等价。
- R4「B 转发 A 的单时，`origin` 默认继承上一跳」是链路规则，用于**写记录的**两个工具；若强加到 `collab_send`，
  C 给 B 发回执时正文首行会变成「对接人 A」——指向错对象（回执是给 B 的决策依据，不是给 A 的）。
  实现理由成立（`src/tools/send.ts:107-118` 注释 + `src/tools/verdict.ts` 无继承调用）。
- 对 C 回执场景的影响：**正向**——回执正文不被污染；但也意味着 `collab_send` 不是 2 跳闭环的载体（见 §1）。
- 最小改法：**只改文字**——`design.md §2` 加一句「`collab_send` 仅显式生效（无记录、回执正文不应被追加）」，
  PRD R2/R4 保持原文即可。SKILL（`skills/collab/SKILL.md`「`collab_send` 的 `origin` **只影响正文**…不继承」）与
  `docs/collab.md` §11.16.1 表格已经与实现一致，无需改。

## 5. 安全 — **通过**

```text
### protected_origin_record
{"sid":"ses_e1eb91cebffeTv1467ubJLKebk","directory":"<tmp>/ws/d"}
### protected_origin_prompts                 ← origin 指向 protected 会话
{"total":1,"toProtected":0}                  ← 只投给了正常目标 B2，protected 0 条
### protected_still_refused
拒绝投递：目标 ses_e1eb91cebffeTv1467ubJLKebk 本身在 protect 名单内（…）。未发送任何内容。
```

- `origin` 只进记录与文案，全代码无「向 origin 投递」的路径（`src/core/verdict.ts:441` pull 分支只展示；
  `src/core/verdict.ts:458` 只打印命令）。
- `fillOriginDirectory`（`src/core/claim.ts:175-189`）只会把**宿主返回的** `location.directory` 写进记录，
  与既有 `from.directory` 同源、同信任级别；`try/catch` 全吞，不抛。**没有引入新的信任边界**。
- 唯一低风险观察（非本次阻塞）：protected 会话的目录现在会被抄进非保护单的 `origin.directory` 并展示给承接方
  （`src/tools/status.ts:175`）。同类信息在 `collab_list` 的 `loc=` 上已可见，判定为**低**。
- 另：显式 `origin` 只校验**格式**（`^ses_[A-Za-z0-9_-]+$` 或别名可解析），不校验存在性
  （`src/core/claim.ts:110-136` 的显式分支）——指向已消失的会话会写进记录并显示 `(未知目录)`。与 design §4「一个已消失的链头不该让交接失败」一致，**判为可接受**。

## 6. 回归与范围 — **通过**

```text
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
EXIT=0
=== 783/783 checks passed        （HEAD 756 + S100 27）
=== 12/12 checks passed
=== 20/20 board checks passed
=== 50/50 checks passed
=== 49/49 checks passed
=== 47/47 checks passed
=== 17/17 panel checks passed
✓ skills/collab/SKILL.md (collab) / ✓ skills/collab-coordination/SKILL.md
skills ok
```

- 工具数仍 **20**（S98 断言 `tools.length === 20` 通过）；`src/index.ts` 未改。
- 版本仍 **0.6.0**（`package.json:3`、`src/constants.ts:380`）；`package.json` / `pnpm-lock.yaml` **零改动** → 无新依赖。
- 范围：仅列出的 17 个文件有改动；`git diff --numstat` 无意外文件。

## 7. 测试真实性 — **部分通过**

**我自己做的两组变异**（备份 → 改 → `pnpm exec vp pack` → `node test/handoff-harness.mjs` → 原样还原并校验 sha256）：

| 变异 | 结果 |
| --- | --- |
| ① `src/core/claim.ts:148` `if (holder) {` → `if (false && holder) {`（继承短路） | `=== 776/783 checks passed`（−7，与实现方自述一致），失败项：`B→C inherits A` / `继承了…` 提示 / C 注入对接人行 / 回执指向 A / `status origin=` / `list via` / 闭环记录仍带 A |
| ② `src/core/verdict.ts:310` `if (!sid \|\| sid === String(requester ?? '').trim()) return undefined;` → `if (!sid) return undefined;` | `=== 782/783 checks passed`（−1）：`S100 an old record (origin == from) injects no 对接人 line` |

还原后：`=== 783/783 checks passed`，两文件 sha256 与变异前一致（`claim.ts 8aa306eb…` / `verdict.ts 7766d2c6…`）。

**断言未弱化**：`git diff --numstat test/handoff-harness.mjs` = `363 0`（纯新增），既有 756 条一条未删改。

**自证问题（必须修）**：`test/handoff-harness.mjs:9948-9956` 的闭环用例是

```js
push(inbound(S100_A, `[collab:S100_C][reply:t_s100_receipt] [handoff] BLOCKED ${s100BcBid} …`,
  { from: S100_C, fromSessionID: S100_C, cid: 'c_s100_receipt', kind: 'reply' }, 's100_inbox_receipt'));
```

两处不可由真实工具产生：
1. `kind:'reply'` 是手写的元数据，真实 `collab_send` 走 `boundedReply` 时**目标必须是 A 的记录发起方 B**（§1 根因），发给 A 永远是 `kind=request`；
2. `t_s100_receipt` 这个 thread **不存在**——实测 `collab_send {kind:"reply", threadID:"t_…"}` 会被降级：
   `ghost_thread_reply_kind = request` / `注: storage 里没有 thread … → 已按新请求处理`。

于是「S100 a blocked C closes the bid by answering A directly (2 hops, no forwarder)」在**实现完全不能用**的情况下也照样绿（变异 ① 里唯一没红的就是它）。**建议把该用例改成「回放真实投递」**：先真调 `collab_send`（按提示原文），取 `prompts.at(-1).{text,metadata}` 回灌成 inbound，再断言真实结果。
（同理：`docs/collab.md:1427` 的「C 阻塞 → 直接发给 A … 即闭环（2 跳）」这一行也要跟着改。）

## 8. 文档 — **通过（与实现一致）/ 但继承了 §1 的错误承诺**

- `docs/collab.md` §11.16.3 三行模板（提案 / bid / 对接人 sid+location）与实现一致（记录三个字段 + `originHint` 文案）；
  小节号 §11.16 合理——§11.9 确实是「送达确认（ack）」（`docs/collab.md:578`），design 里写的 §11.9 有误，实现方改成 §11.16 是对的。
- `skills/collab/SKILL.md` 的 `collab_send` 说明（「只影响正文、不写记录、不继承」）与代码一致（`src/tools/send.ts:107-118`）。
- `CHANGELOG.md` 归入 `## [Unreleased] · 0.7.0（原 0.6.1 批次）`，符合要求；但其中 3 处「闭环」措辞需按 §1 修正
  （`CHANGELOG.md:44` 与 Tests 段、`docs/collab.md:1397-1401` / `1427`、`README.md:48-50`）。
- 文档小瑕（不阻塞）：§11.16.1 的 JSONC 样例里带 `"role": "requester"`，但工具从不写 `role`（只在
  `normalizeOrigin` 里容忍）。建议样例注明「role 目前仅类型保留，工具不写」，或从样例删掉。

---

## 最小改法（按推荐顺序）

**B（推荐，让 PRD 验收第 4 条真正成立，约 10 行）**

在 `src/tools/send.ts:195-206` 处把「回执改写」与「受保护放行」拆开：

```ts
// 现状：boundedReply 同时决定 kind 改写与 allowProtectedReply
const receiptTargetsOrigin =
  !boundedReply &&
  legacyKind &&                                  // 调用方没声明 kind（0.1.1 形态）
  HANDOFF_LINE_RE.test(String(input?.text ?? '')) &&
  String(readBroadcast(/* bid from arg/body */)?.origin?.sid ?? '') === target.sessionID &&
  String(readBroadcast(...)?.claim?.by ?? '') === me;
if (boundedReply || receiptTargetsOrigin) kind = 'reply';
...
allowProtectedReply: Boolean(boundedReply)       // origin 分支绝不放宽 protect
```

（更简洁的等价：给 `canReplyToProtected` 加一个 `alsoAcceptOrigin?: boolean` 入参，只在 `target === record.origin?.sid`
时返回记录，但仍用 `boundedReply` 原值决定 `allowProtectedReply` —— 这样 protected 的 origin 仍被 fail-closed 拒投。）
配套：把 S100 的闭环用例改成「真调 `collab_send` → 回放 `prompts.at(-1)`」，并补一条「origin 是 protected 时仍拒投」。
注意 `applyReceipt`（`src/core/chain.ts:375-415`）**不用改**（接收侧不看 target）。

**A（保底，5 分钟，不动代码逻辑）**

- `src/core/verdict.ts:458`：删掉「（同一条 [handoff] 行也能闭环本单，不必再经发起方转发）」，改为
  「（这一步只是把跨层结论交给它；本单闭环仍按 ② 的 `[handoff]` 行回给发起方）».
- 同步 `CHANGELOG.md:44`（Added 段）与 Tests 段、`docs/collab.md:1397-1401` + `1427`、`README.md:48-50`；
- S100 闭环用例改为「A 收到消息（`state` 仍非 done）」+「② 发给发起方 B 才闭环（`done`）」两条，
  并把「2 跳」表述限定为「决策对话 2 跳」，不写成「2 跳闭环」。

**其他（可与上条一起）**

- `design.md §5` 第一行按 §4 偏差 1 改成「自称链头 = 不落盘、不渲染」；
- `design.md §2` 加一句 `collab_send` 仅显式生效（§4 偏差 2）；
- `src/tools/handoff.ts:98-101`：确认路径的 `originNote` 用未来时「会写进记录 origin」，写成「已写入记录 origin」更准确（Nit）；
- §11.16.1 的 `role` 样例加注（Nit）。

---

## 风险清单（按严重度）

| 级别 | 项 | 说明 / 位置 |
| --- | --- | --- |
| **高（本次新增）** | 「发给 A 即闭环」的承诺不成立 | `verdict.ts:458`、`CHANGELOG.md`、`docs §11.16.2/§11.16.4`、`README.md`；根因 `shared.ts:132` target 必须是 `from.sid`；证据见 §1/§7 |
| **高（本次新增）** | S100 闭环用例自证 | `test/handoff-harness.mjs:9948-9956`（合成 `kind:reply` + 不存在的 thread），不能证明它声称的路径 |
| 中（既有，非本 diff） | 单跳/非转发场景的 `origin` 语义仍靠「最新未闭环 claim」猜测 | `claim.ts:140-150`：同一会话同时承接多张单时，新任务会继承「最近那张」的链头；显式 `origin=<自己>` 可关闭（有逃生口），design §2 已声明 |
| 中（既有，非本 diff） | `origin ≠ from` 判定在 3 处重复实现 | `verdict.ts:310`、`status.ts:174`、`list.ts:233-236`；变异 ② 证明只改注入层时 status/list 不会跟着破——一致性问题，建议后续抽一个 `showOrigin(record)` |
| 低 | `origin` 只校验格式，不校验存在性 | `claim.ts:110-136`；显示 `(未知目录)`，与 design §4 一致 |
| 低 | protected 会话的 `directory` 被抄进非保护记录并展示 | `claim.ts:175-189` + `status.ts:175` |
| 低 | 每次 handoff/broadcast 都多一次 `storage.get(aliases)` + `allBroadcasts()` 全扫 | `broadcast.ts:144-152`（即使未传 `origin` 也读）；单次调用毫秒级，可接受 |
| 低 | `role` 在文档样例里出现但工具从不写 | `docs/collab.md` §11.16.1 |
| 低 | `handoff` 确认路径文案时态 | `handoff.ts:98-101` |

---

## 附：复核用探针与命令（可复现）

```text
/tmp/probe/tool-probe.mjs <dist/index.js> legacy   # 旧记录渲染/工具输出（HEAD vs 工作区各跑一次后 diff）
/tmp/probe/tool-probe.mjs <dist/index.js> flow     # A→B→C 两跳、覆盖、别名拒绝、protected、真实回执回放
/tmp/probe/render-compare.mjs                      # verdict.ts 渲染矩阵（HEAD vs 工作区，80 组）
/tmp/origin-head/                                  # git archive HEAD + 独立 pnpm build 的 0.6.0 基线
```

变异的还原方式：`cp /tmp/probe/bak/{claim,verdict}.ts src/core/` → `sha256sum -c /tmp/probe/bak/before.sha`
→ `pnpm exec vp pack` → `node test/handoff-harness.mjs`（783/783）。**未使用 `git restore`/`git checkout -- .`**，
未触碰用户其它工作区与真实会话。

---

# 增量复核（A+B 修复）

> 范围：owner 选定 **A（文案+测试真实性）+ B（代码）** 后作者的增量改动（工作区仍未提交）。
> 只审不改、不 commit/push；全部行为结论由自写探针 `/tmp/probe/probe-r2.mjs`（独立假宿主，**回灌宿主实际
> prompt**）与自做变异得出，不采信 harness 断言本身。

## 结论

**通过（可提交）**。首轮唯一「需修」项已修好并且可被真实路径复现：C 用**真实** `collab_send
{ target: A, text:"[handoff] DONE <bid> …" }` 发给对接人 A → 实际投递 **`kind=reply`**，A 侧回放后记录
`state=done`；同一行发给**第三方** E → 仍是 `kind=request`、记录保持 `acked`；`origin` 指向 `[protected*]`
→ **0 条 prompt**、护栏照旧拒绝。S100 已改为真回放（不再手写 `kind:'reply'` / 假 thread），我做的两组变异
都能把它打红。

**2 条非阻塞文档小修**（不影响行为，可一并提交）：

1. `docs/collab.md:1439` 的回滚命令缺 `src/tools/shared.ts`（本轮新增 `acceptOrigin` 就在那里）；
   `design.md §6` 的回滚清单同样缺。补上 `shared` 即可（单独留下该参数默认 `false` 无行为差异，但会留死代码）。
2. `docs/collab.md:366-371`（§11.4「三条判据 ①」）仍只写 `target` = 发起方，容易被读成「protect 也放宽了」。
   建议加一句括注：「`origin.sid` 只用于**非保护区间**的回执 kind 改写（§11.16.2）；受保护投递白名单仍只看
   `from.sid`」。

1 条文案 nit（可选）：命中「发给对接人」时，`collab_send` 结果里会同时出现两条注——第一条仍叫
「遗留回执（0.1.1 及更早的命令不带 kind）…」，在 0.7.0 的新命令场景下略误导；建议命中
`receiptToChainHead` 时只保留下方那条「回执发往对接人…」。

---

## 1. 对接人闭环（真实投递）— **通过**

```text
### setup_hop2_record
{"from":{"sid":"ses_r2_b","directory":"<tmp>/ws/b"},"origin":{"sid":"ses_r2_a","directory":"<tmp>/ws/a"}}

### third_prompt_kind   request          ← 发给第三方 E
### third_after         {"before":"acked","after":"acked"}

### head_prompt
{"to":"ses_r2_a","kind":"reply","text":"[collab:ses_r2_c…r2_c][reply:<thread>] [handoff] DONE <bid> 已按链头 A 的决策修好"}
### head_after
{"state":"done","receipt":{"from":"ses_r2_c","at":…,"note":"已按链头 A 的决策修好","source":"kind"},
 "origin":{"sid":"ses_r2_a","directory":"<tmp>/ws/a"}}
```

- C 只是普通调用 `collab_send {target:A, text:"[handoff] DONE <bid> …", confirm:true}`（**没有** `kind`），
  投递元数据被改写成 `kind=reply`（`src/tools/send.ts:214-241` 的 `receiptToChainHead`），
  回放**宿主实际收到的 prompt** 后接收侧认这条回执：`state=done`、`receipt.from=C`、`source=kind`、
  `origin` 仍在记录里。
- 第三方 E：同一个 body、同样的调用，`kind=request`，回放后 `state` 仍 `acked`（`src/tools/shared.ts:151`
  只放开两个 sid）。**正反两面都成立。**
- 结果文案也说明了路径（`head_send_result` 第 6 行）：`回执发往对接人 ses_r2_a（本单 origin，不是发起方 ses_r2_b）…`

## 2. protected 零放宽 — **通过（自己数 prompt）**

```text
### protected_origin_refusal
拒绝投递：目标 ses_e1eb91cebffeTv1467ubJLKebk 本身在 protect 名单内（…）。未发送任何内容。
回执同样适用该护栏（fail-closed）；只有「本单发起方 + 该单领取人 + 该 bid」的 kind=reply 回执是白名单例外。
### protected_origin_prompt_delta
{"prompts":[5,5],"toProtected":0,"state":"acked"}
```

- 同一份记录（`origin = protected`，`claim.by = B`）用**回执形态**发给 `origin`：抛可读错误，
  `prompts` 从 5 → 5（**0 条新增**，发给受保护会话的 0 条），记录 `acked` 不变。
- 代码依据：`allowProtectedReply` 仍是 `Boolean(boundedReply)`（`src/tools/send.ts:251`），
  `acceptOrigin: true` 只出现在 `receiptToChainHead` 那次调用（`:214-226`）——**kind 改写与投递放行是两条独立判定**，
  与 design §3 新增那句「受保护投递规则不变」一致。
- 对照：同一 `origin ≠ protected` 的场景正常闭环（§1）。

## 3. 不误伤 — **通过**

```text
### requester_control_kind      reply
### requester_control_after     {"state":"done","receipt":{"from":"ses_r2_b",…,"source":"kind"}}
### local_reply_prompt         {"to":"ses_r2_b","kind":"reply","text":"…[handoff] DONE <bid> 同仓完成"}
### local_reply_after          {"state":"done","receipt":{"from":"ses_r2_b2",…}}
### nonclaimant_kind           request      ← 非领取人（C）发 [handoff] DONE 给对接人 A
### nonclaimant_after          {"state":"acked"}
### explicit_request_kind      request      ← 显式 kind:"request" 发给对接人
### explicit_request_after     {"state":"acked"}
### plain_message_kind         request      ← 无 [handoff] 正文
```

- 发给**发起方**（`from.sid`）的遗留回执照旧闭环（`boundedReply` 原样，`send.ts:195-213`）。
- `collab_reply`（local，kind=reply + thread）不受影响：`done`。
- **非领取人**发同一行给对接人 → 不改写（`claim.by !== sender`，`shared.ts:152`）→ 不闭环。
- **显式 `kind:"request"`** → 不改写（`legacyAllowed=false`，`shared.ts:122`）→ R7 语义保持。
- 无 `[handoff]` 正文的普通消息 → `kind=request`，不误判。
- 受保护拒投的既有用例 S69/S81：本轮 788 全绿（`grep -c "✗"` = 0，S69/S81 相关 40 条全 ✓）。

## 4. S100 是否真回放 — **通过**

- `test/handoff-harness.mjs:9958-9959`：
  `const replayPrompt = (prompt, inboxID) => inbound(prompt.sessionID, prompt.text, prompt.metadata?.collab, inboxID);`
  —— 回灌的是 `collab_send` **真实产生**的 prompt（text + `metadata.collab`），`inbound()` 再包一层 `{collab: …}`，
  与宿主事件形状一致；块内**不再出现**手写 `kind:'reply'`，旧的假 thread `t_s100_receipt` 已消失
  （`grep -c t_s100_receipt` = 0）。
- 反向先跑第三方（`:10002`）、再跑对接人（`:9991`），断言两侧的 `metadata.kind` 与状态，不是「只测成功」。
- 变异下会红：见 §7（去掉 origin 分支 → 「C closes the bid…」红）。
- 顺带确认：本轮**没有**弱化任何既有断言——`git diff test/handoff-harness.mjs` 的删除行数为 **0**（449/0），
  新增 5 条（27 → 32），与 `788 = 756 + 32` 吻合。

## 5. 文案一致性 — **通过（4 处同口径，无「任意发送都能闭环」）**

| 位置 | 现行文本要点 |
| --- | --- |
| `src/core/verdict.ts:459` | 「同一条 [handoff] 行也能闭环本单…；**仅限本单发起方或对接人，第三方发送不会闭环**」 |
| `docs/collab.md:1400-1409` | 引文同款 +「这条命令**真的能闭环**（复核 B 修）」+ 两个边界（只有两个目标 / 受保护一点没放宽） |
| `docs/collab.md:1435-1437`（验收表三行） | 正向：真实 `collab_send` 按 `kind=reply` 投递、`state=done`；反向：第三方 → `acked`；`origin` 受保护 → 拒投 |
| `README.md:48-54` | 「直接发给 A…接收侧按 `kind=reply` 认这条回执」+ 边界两句 |
| `CHANGELOG.md`（Added + Fixed 各一段） | 明确写「复核前这条承诺是假的」，并写清两处刻意拆开 |
| `skills/collab/SKILL.md`（一点十二） | 「只有本单发起方或对接人（发给第三方仍是普通 `request`）」+ 受保护不变 |
| `design.md §2/§3/§5` | §3 已写入 origin 闭环规则与「只放开两个目标」；§5 首行已改为「自称链头 = 不落盘、不渲染」；§2 已写 `collab_send` 仅显式生效 |

探针侧原文确认：`inject_boundary_text = true`（注入里带边界句）；`docs` 里未再出现「发给任何会话都能闭环」类表述。

## 6. 回归与范围 — **通过**

```text
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
EXIT=0
=== 788/788 checks passed        （756 + S100 32）
=== 12/12 · 20/20 board · 50/50 · 49/49 · 47/47 · 17/17 panel
skills ok
```

- 工具数仍 **20**（S98 断言在 788 内通过）；版本仍 **0.6.0**（`package.json:3` / `src/constants.ts:380`），
  `package.json` / `pnpm-lock.yaml` **零改动** → 无新依赖。
- 本轮实际触达文件与预期一致：`src/tools/{shared,send,handoff}.ts`（`handoff.ts` 只把注释拆成
  `originPreviewNote`/`originNote` 的时态，`handoff.ts:101-108`）、`src/core/verdict.ts`（边界句）、
  `test/handoff-harness.mjs`、`docs/collab.md`、`README.md`、`CHANGELOG.md`、`skills/collab/SKILL.md`、任务目录。
  `src/index.ts` / `src/types.ts` / `src/core/{claim,chain}.ts` 本轮无新改动。

## 7. 变异 — **通过（两组都能打红，均已还原）**

| 变异 | 结果 |
| --- | --- |
| **A：去掉 origin 分支**（`src/tools/send.ts:224` `acceptOrigin: true` → `false`） | `=== 786/788 checks passed`：<br>`✗ S100 a receipt addressed to the 对接人 really travels as kind=reply … — {"to":"ses_s100_a","kind":"request",…}`<br>`✗ S100 C closes the bid by answering A directly (2 hops, no forwarder) — {"state":"acked"}` |
| **B：放宽成任意 target**（`src/tools/shared.ts:151` → `if (!acceptOrigin && targetSid !== requesterSid) return undefined;`） | `=== 786/788 checks passed`：<br>`✗ S100 … while a third target keeps kind=request and leaves the bid acked — {"to":"ses_s100_e","kind":"reply","state":"blocked",…}`<br>`✗ S100 C closes the bid by answering A directly … — {"state":"blocked",…}` |

还原后：`sha256sum -c` 两文件 OK → `pnpm exec vp pack` → `=== 788/788 checks passed`，探针复跑结论与 §1-§3 一致。

> 方法学备注：第一次尝试写成 `const receiptToChainHead = false ? undefined : canReplyToProtected({…})`，
> 被 bundler **常量折叠**成原样（dist 里仍是 `canReplyToProtected({…})`），因此 788 全绿并不代表变异有效；
> 改为 `acceptOrigin: false` 才真正切断分支。后续复核变异请以 **dist 产物**核对（`grep acceptOrigin dist/index.js`），
> 不要只看源码。

---

## 剩余风险（与首轮一致，均非本轮引入）

1. **引用模板误判**：claimant 在正常消息里「引用」`[handoff] DONE <bid> …` 仍可能被当成回执（占位符/回显守卫
   `parseReceiptLine` 会挡掉 `<摘要>` 等形态）。这与 0.1.4 的 `from.sid` 遗留路径同类，`origin` 只是把目标放宽到
   两个 sid，**未新增类别**。
2. 发往对接人的回执会顺带创建一个 `answered` 的 thread（auto threadID），A 侧会多一条 thread 记录；
   与 `boundedReply` 既有行为一致。
3. 首轮列出的其它风险（继承取「最新未闭环 claim」的猜测性、`origin≠from` 三处重复判定、`origin` 不校验存在性、
   protected 目录被抄进记录）本轮未改，仍按「可接受 / 低」计。
