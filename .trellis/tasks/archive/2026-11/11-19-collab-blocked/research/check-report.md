# 独立复核报告：BLOCKED 结构化（`blocked`，0.7.0）

任务：`.trellis/tasks/11-19-collab-blocked`（PRD R1–R4 / design §1–§6 / implement.md）
被复核对象：`/data/project/collab` 工作区未提交改动（基线 `b806e07`，`git status` 13 个已跟踪文件 + 4 个任务文件）
复核方式：冷上下文、**只审不改**（未修改任何实现文件、未 commit/add/push）；自写探针 + 独立构建 HEAD 逐字比对 + 两组变异。
复核时间：2026-11-19

---

## 0. 结论

**需修（不阻塞设计，阻塞提交）。**

- 主体实现正确：三处渲染、校验可读拒绝（0 投递 0 写入）、无 bid / 预览 / 记录不存在 / 非参与方不落库（`collab_send` 侧）、
  保留最近 3 次、`state/claim/receipt` 不变、护栏不放宽、不传 `blocked` 与 HEAD **逐字一致**、回归 843+12+20+50+49+47+17 全绿、
  工具面 21、版本 0.6.0、无新依赖。
- **必须修（1 个编辑点，2 个后果）**：`collab_handoff` 的**幂等分支**（`src/tools/handoff.ts:207-231`）写 `blocked` 时
  既不看 `confirm` 也不看参与方：
  1. `confirm:false`（**预览**）也会写盘 —— 与 PRD/design/docs/README/skill/CHANGELOG 反复承诺的
     「`confirm:false` 预览 → 不落库」直接冲突，也与 `collab_send`（`src/tools/send.ts:203-205`）不一致；
  2. 任意**非参与方**只要知道「workspace + target + 正文原文」就能把 `blocked` 写进别人的记录，而 `blocked` 会被渲染进
     **下一个承接方的 takeover 注入**（`src/core/verdict.ts:575`）—— 这正是实现方自己加「参与方判定」要堵的旁路，
     却在 handoff 分支漏了（已端到端复现：第三方文本进入重发注入块，见 §4 X1）。
- **建议（不阻塞）**：`collab_send` 在**去重命中**（未投递）时仍追加一条 `blocked`（`results=2` 条相同），
  会白占「最近 3 次」的名额、把更早的**不同**报告挤掉；建议命中时跳过写入或在回执里说明。
- 文档需修一处措辞：docs/README/skill 写「预览 → 未落库」「调用方是本单参与方才写」，与 handoff 幂等分支现状不符
  （修代码后可不动文档）。

推荐最小修法（不改数据结构、不影响任何现有断言）：

```diff
--- a/src/tools/handoff.ts   (previous 分支, 现 218-222)
-        if (blocked) {
-          record = writeBroadcast(appendBlocked(record, { ...blocked, at: Date.now(), by: String(me ?? '') }));
-          blockedNote = `注: blocked 已写入记录 ${bid}（…）`;
-        }
+        if (blocked && input?.confirm !== true) {
+          blockedNote = `注: 预览（confirm 不为 true）—— blocked 未落库；确认后会写进记录 ${bid}。`;
+        } else if (blocked) {
+          const participants = [record.from?.sid, record.claim?.by, record.asked?.sid, record.origin?.sid]
+            .map(value => String(value ?? '').trim()).filter(Boolean);
+          if (me && participants.length && !participants.includes(String(me))) {
+            blockedNote = `注: 当前会话不是 ${bid} 的参与方（from / claim.by / asked / origin）—— blocked 未落库。`;
+          } else {
+            record = writeBroadcast(appendBlocked(record, { ...blocked, at: Date.now(), by: String(me ?? '') }));
+            blockedNote = `注: blocked 已写入记录 ${bid}（保留最近 ${BLOCKED_KEEP} 次；未重复投递，state / claim / receipt 未改）。`;
+          }
+        }
```

并把两边共用的参与方规则抽到 `verdict.ts`（`isBlockedParticipant(record, me)`），避免第三处再漂移；
补 2 条 S105 断言（`handoff` 幂等分支：预览不写 / 第三方不写），届时计数 843 → 845。

---

## 1. 基线（必跑，原始输出）

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
BUILD / TEST_EXIT=0
=== 843/843 checks passed            handoff-harness（823 → 843，+20）
=== 12/12 checks passed              readonly-default
=== 20/20 board checks passed        board-shape
=== 50/50 checks passed              snapshot-shape
=== 49/49 checks passed              tui-render
=== 47/47 checks passed              gui-entry
=== 17/17 panel checks passed        gui-panel
$ tsc --noEmit                       （无输出）
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
```

`git diff --stat package.json pnpm-lock.yaml` → 空（**无新依赖、版本仍 0.6.0**）；
`test/handoff-harness.mjs` 只有新增（`git diff -U0 | grep -c '^-'` 仅命中 `--- a/...` 头，**0 行删除**，既有断言未弱化）。
工具数：harness S105h 断言 `tools.length === 21`（实测通过）。

---

## 2. 九项逐条

### 1) 三处渲染 —— **通过（spawn 路径为静态覆盖，见下）**

| 落点 | 位置 | 证据 |
| --- | --- | --- |
| 投递正文 | `src/tools/handoff.ts:276-281`、`src/tools/send.ts:183-188` | P1：`需要对方：①…⑤…` / `已排除：…` / `最小判别：…` 三段齐全，正文位置 < 段首（`indexOf` 断言），正文一字未改；发送侧**保留全部条目**（5 条 need、4 条 excluded，无「还有」） |
| 承接方注入 | `src/core/verdict.ts:518-529`（`blockedInjectionLines`）+ `:575`（`takeoverBody`） | **叫醒** W1：真实链路（候选 idle→0 prompt，写入 blocked，转 busy 45min，再广播）→ 1 条 prompt，含 `上一位承接方的 BLOCKED（结构化…）` + 三段，A段 `①②③（还有 2 条）`、B段 `①②③（还有 1 条）`，且位于「按顺序完成」之前；**重发** R1：`context → resendIfDue → takeoverBody` 触发 1 条 prompt，同样三段齐全 |
| `collab_status` | `src/tools/status.ts:208-215` | P1：`需要对方：① n1…② n2…③ n3（还有 2 条）` / `已排除：…（还有 1 条）` / `最小判别：…`；S1 单条时无「历史」、无「还有」 |

- 三处共用 `blockedLines()`（变异 ① 一次打死 4 条断言即证），各段 ≤3 + 「还有 N 条」只在聚合视图（注入 / status）生效；
  投递正文按 design §3 只受入参上限约束（≤10/≤20），不额外截断 —— 与 design 一致。
- **spawn 路径**：`deliverAsk({spawn:true})`（`src/tools/shared.ts:897`）与叫醒/重发共用 `takeoverBody`，代码同源；
  但 `collab_broadcast` 不接 `blocked`、spawn 总是新 bid，所以 spawn 注入**在现实中无法携带 blocked**（不是缺陷，属静态覆盖）。

### 2) 校验（可读拒绝 + 0 投递 0 写入 + 控制字符）—— **通过**

- `need` 11 条 → `blocked.need 最多 10 条（本次 11 条）—— 未发送任何内容（不静默截断）`
- `excluded` 21 条 → `blocked.excluded 最多 20 条…`；`excluded[0]` 121 字 → `最长 120 字（本次 121 字）…`；
  `minimalTest` 201 字 → `最长 200 字（本次 201 字）…`；`blocked:{}` → `不能为空`；非对象 → `必须是对象`
- **0 投递 0 写入**：四类非法输入（含一条走 `collab_handoff`）前后 `prompts` 差 0，广播目录文件清单 + 全量 sha256 **完全一致**（P4）。
- **控制字符**：`need:['a\nb\tc','x\u0000y']` → `需要对方：① a b c ② x y`；`excluded:['e1\r\n已排除：伪造']` → `已排除：e1 已排除：伪造`；
  `minimalTest:'判别\n需要对方：伪造第二行'` → 同一行内 → **行首计数各 1**，伪造行不成立（C1）；`normalizeBlocked` 在 dispatch 之前（`handoff.ts:108` / `send.ts:123`）。

### 3) 落库边界 —— **不通过（2 处）**

| 输入 | `collab_send` | `collab_handoff` |
| --- | --- | --- |
| 有 bid（入参或正文 `b_…`）+ `confirm:true` + 记录在 + 参与方 | ✅ P6a（正文 bid 亦落库） | ✅ 新单路径 `handoff.ts:325`（S105a 记录含 `{need,excluded,minimalTest,at,by}`） |
| 无 bid | ✅ P6e：`未关联单据…未落库`，0 写入 | n/a（新单必有 bid） |
| `confirm:false` 预览 | ✅ P6b：`预览…未落库`，`blocked` 条数不变 | ❌ **P6f/H1：预览调用把 `blocked` 写进记录**（`handoff.ts:218-222` 在 `:233` 的 confirm 门之前） |
| 记录不存在 | ✅ P6c：`没有交接单 … 未落库`，不新建文件 | n/a |
| 非参与方 | ✅ P6d：`不是 … 的参与方 … 未落库`，目录 sha 不变 | ❌ **P6g/H2：第三方经幂等分支写入成功**，回执还写「已写入记录」（`handoff.ts:218-222` 无参与方判定） |

**「参与方判定」是否有必要且安全？**
- **必要**：`blocked` 是自由文本，且会被渲染进**下一个承接方的 takeover 注入**（`verdict.ts:575`），
  而 bid 在文档/回执/正文里到处可见 —— 不设限等于给「往别人的注入里塞字」开旁路。设计未写、实现方按 G2 自决，**判断合理**。
- **安全（部分不安全）**：
  - 覆盖的真实用法齐了（`from` / `claim.by` / `asked` / `origin`）：S105g（asked 写入）、P6a（claim.by 写入）通过；
  - **留了旁路**：handoff 幂等分支无此判定（X1 端到端复现，见 §4）；
  - 降级可接受：合法但不在四类里的会话（如承接方的**子会话**）只渲染不落库，回执写明 —— 有说明，不阻塞；
  - `me` 缺失或记录无任何参与方字段时不校验（与既有「无 sessionID 不做身份校验」一致，风险低）。

### 4) 兼容逐字（不传 `blocked`）—— **通过（独立构建比对）**

- 方法：`git archive HEAD`（`b806e07`）→ `/tmp/opencode/review/head` 独立构建；同一探针分别跑 HEAD 与工作区 dist，
  13 个场景（send 投递/预览/origin、handoff 预览/投递/幂等重复、status、broadcast 结果/叫醒注入、list、inbox、status by thread、context 注入）。
- 结果：仅运行期噪声不同（thread 随机 token、tmp 根目录、钟点、由 workspace 参与的 bid），**归一化后 diff 为空**（`IDENTICAL_AFTER_NORMALIZATION`）。
- 代码侧对应：`withMeta` 无 `blocked` 时**返回 `withOrigin(raw)` 原对象**（`send.ts:183-188`）；`finish` 在 `!blocked` 时原样返回
  `dispatch` 结果（`send.ts:221-227`）；handoff 的 `text` 数组在 `blockedText` 为空时与旧版逐元素相同（`handoff.ts:276-281`）；
  `blockedInjectionLines`/status 对无该字段的记录返回空（`verdict.ts:518-521`、`status.ts:208-215`）。

### 5) 状态不变 / 护栏不放宽 —— **通过**

- P7：`state/claim/receipt/replies` 前后 JSON 完全一致；S105e 独立断言同。
- P7 受保护目标 + `blocked`：照旧 `throw 拒绝投递：… 在 protect 名单内`，0 prompt、目录 sha 不变。
- `appendBlocked` 只返回 `{...record, blocked: [...]}`（`verdict.ts:463-476`），不触碰其它字段。

### 6) 注入点取舍（`takeoverBody` 而非 `context` 钩子）—— **通过，无未说明降级**

- 「对端只收到 `collab_send` 正文、从未被叫醒」：三段**随正文直达**（P3：投递 prompt 自带三段）；
  实证「消息正文 → inbox 全文 → context 注入」三处都有三段（RV4：`delivered/inbox/inject` 全 true），
  所以不需要 `context` 钩子也能被看到；文档把三处渲染点列清（docs §11.18 渲染①②③），无隐性降级。
- 注入块位置：`期望` 之后、`发起方 / 按顺序完成` 之前（`verdict.ts:571-578`），实测 `indexOf('最小判别') < indexOf('按顺序完成')`。
- 唯一残余风险：inbox 展示上限 4000 字（超长正文会截断尾部，即三段），但交付给对方的 **user turn 本身**不截断 —— 见风险清单 R3。

### 7) 回归与范围 —— **通过**

见 §1。`843 + 12 + 20 + 50 + 49 + 47 + 17`；工具数 21；版本 0.6.0；`package.json` / `pnpm-lock.yaml` 无改动（无新依赖）；
改动文件与任务允许清单一致（`types.ts` / `core/verdict.ts` / `tools/{send,handoff,status}.ts` / test / docs / README / skill / CHANGELOG）。

### 8) 测试真实性（自做 2 组变异）—— **通过（变异有效），但 S105 有覆盖空洞（对应 §3 的两处缺陷）**

在 `/tmp/opencode/review/mut`（工作区完整副本 + node_modules 软链，**不动真实工作区**）里做：

| 变异 | 结果 | 与实现方自述 |
| --- | --- | --- |
| ① `blockedLines` 删 `if (entry.minimalTest) lines.push(…)` | **839/843**，4 条红：S105 handoff 正文 / 无 bid / collab_status / 叫醒注入 | 一致 |
| ② `recordBlocked` 删无 bid 早退（`send.ts:200-202`） | **842/843**，1 条红：S105 无 bid | 一致 |

- 还原后逐文件 sha256 与工作区一致（`send.ts 323bc903…`、`verdict.ts ab629c5d…`），`grep MUTATION` 为空；工作区未被改动。
- **空洞**：S105 只测了 `collab_send` 的非参与方（S105f）与**新单** handoff（S105a），
  **没有** `collab_handoff` 幂等分支的「预览 / 第三方」用例 —— 这正是 §3 两处缺陷没被拦住的原因（建议补 2 条）。

### 9) 文档 —— **基本一致，1 处与实现不符（随 §3 修复消解）**

| 文档 | 核对 |
| --- | --- |
| `docs/collab.md` §11.18 + 工具表 3 行 | 字段/上限/清洗/保留 3 次/三处渲染/回执「未落库」/护栏/回滚，与实现一致；**「`confirm:false` 预览 → 不落库」「调用方是本单参与方 → 才写」与 handoff 幂等分支现状不符** |
| `README.md` | 工具表 + 一段说明一致（同样受上述措辞影响） |
| `skills/collab/SKILL.md` | 工具表 + 「一点八·再补」一致（同上） |
| `CHANGELOG.md` | R1–R4 描述、S105（20 条）、三组变异、823 → 843 计数与实际一致 |

设计偏差（已在 `research/impl-notes.md` §2 说明，接受）：design §3 写「正文之后、协议头之前」，而协议头固定在消息**首行**，
实现落点为「正文之后（消息末尾）」；`takeoverBody` 内确实位于「正文之后、动作块之前」。属可读的实现解释，不视为缺陷。

---

## 3. 发现的问题（按严重度）

| # | 严重度 | 位置 | 问题 | 证据 |
| --- | --- | --- | --- | --- |
| F1 | **需修（中）** | `src/tools/handoff.ts:207-231`（写点在 `:218-222`，confirm 门在 `:233`） | `confirm:false` 的**预览**调用照样把 `blocked` 写进记录 —— 违反 PRD/design/docs「预览零写入」，且与 `collab_send` 行为不一致 | P6f / H1：`before=0 after=1`，回执首行仍是「已存在同一交接…」 |
| F2 | **需修（中）** | 同上 | **非参与方**可经 handoff 幂等分支把 `blocked` 写进别人的记录；该文本会进入下一承接方的 takeover 注入 —— 实现方自加的参与方判定被这条分支绕过 | P6g / H2（`已写入记录 b_…`）+ X1（第三方文本出现在交给 `ses_rv_to` 的重发注入块里） |
| F3 | 建议（低） | `src/tools/send.ts:221-227` | 去重命中（未投递）时仍 `appendBlocked` → 记录里出现**两条相同**条目，白占「最近 3 次」名额，可能挤掉更早的**不同**报告 | D1：`entries=2 dedupe=true wrote=true` |
| F4 | 建议（低，文档） | docs/README/skill | 修 F1/F2 后无需改；若选择不修，则必须把「预览 / 非参与方」的例外写进文档（不推荐） | §3 表格 |
| F5 | 观察（极低） | `src/tools/send.ts:12,225` | 正文里的 `b_…` 取**第一个**匹配：正文引用他人 bid 时可能把 `blocked` 写到另一条单（仍受参与方与存在性约束，回执会说明） | 代码走读 |

---

## 4. 关键原始输出（复核者自写探针）

探针位置（不落仓库）：`/tmp/opencode/review/{probe-compat,probe-review,probe-review2,probe-review3,probe-review4}.mjs`
（复用 harness 的 fake host 前 838 行 setup，独立断言）。

```
# probe-review（第一轮）
PASS P1 投递正文含三段，正文之后，正文一字未改 — 9 lines
PASS P1 投递正文保留全部条目：5 条 need、4 条 excluded、无「还有」
PASS P1 status 聚合：各段 ≤3 条 + 「还有 N 条」
PASS P3 只收正文的对端也看得到三段
✓ P4 need 11 条 / excluded 21 条 / 121 字 / 201 字 → 可读拒绝
PASS P4 四类非法输入：0 投递、0 写入 — 0 prompt(s), 3 files
PASS P6a 正文里的 bid 也落库 — 1 entries
PASS P6b 预览：0 投递 0 写入 — 1 entries
PASS P6c 记录不存在：不落库
PASS P6d 非参与方（send）：不落库
PASS P6e 无 bid：未落库、0 写入
FAIL P6f handoff 幂等分支 confirm:false（预览）仍会写 blocked? — before=0 after=1
FAIL P6g 第三方走 handoff 幂等分支：记录未被改写? — 注: blocked 已写入记录 b_f471ce6e…
PASS P7 state / claim / receipt / replies 前后一致
PASS P7 受保护目标：照旧拒投（0 投递 0 写入）

# probe-review2（修正探针自身假设后）
PASS W1 叫醒注入（真实链路）含三段、各 ≤3 条 + 还有 N 条、在「按顺序完成」之前 — 1 prompt(s)
PASS C1 控制字符（含换行）剥成空格：三段各只有一行，伪造行不成立（行首计数各 1）
FAIL H1 handoff 幂等分支 confirm:false（预览）不应写入 blocked — before=0 after=1
FAIL H2 handoff 幂等分支：非参与方不应写入别人的记录 — 注: blocked 已写入记录 b_848fd72a7d50e702…

# probe-review3
PASS R1 重发注入（context → resendIfDue → takeoverBody）含三段、在「按顺序完成」之前 — prompts +1
PASS S1 status 单次：无「历史 N 次」、三段齐全、无「还有」
FAIL D1 去重命中时是否重复追加同一条 blocked — entries=2 dedupe=true wrote=true
PASS X1 非参与方通过 handoff 幂等分支写入了别人的记录，且进入发起方的重发注入块（注入旁路）
        thirdNote=注: blocked 已写入记录 b_1408ab90535b225d（保留最近 3 次；未重复投递，state / claim / receipt 未改）。

# probe-review4（只收正文的对端）
PASS? { delivered: true, inbox: true, inject: true,
        note: '注: blocked 未关联单据（bid 入参与正文都没有 b_…）—— 已渲染进正文，未落库。' }

# 变异 ①（blockedLines 丢 minimalTest）
=== 839/843 checks passed
FAIL: S105 handoff 正文：需要对方 / 已排除 / 最小判别 三段都在，且追加在正文之后
FAIL: S105 无 bid：三段仍进正文，回执注明「未关联单据 / 未落库」，0 写入
FAIL: S105 collab_status：最新一次的三段（各 ≤3 条 + 「还有 N 条」）+ 历史次数
FAIL: S105 承接方注入（叫醒 / takeoverBody）含三段，且在「按顺序完成」之前

# 变异 ②（recordBlocked 删无 bid 早退）
=== 842/843 checks passed
FAIL: S105 无 bid：三段仍进正文，回执注明「未关联单据 / 未落库」，0 写入

# 兼容比对（HEAD b806e07 独立构建 vs 工作区）
$ node normalize.mjs head.out > head.norm.json ; node normalize.mjs new.out > new.norm.json
$ diff head.norm.json new.norm.json && echo IDENTICAL_AFTER_NORMALIZATION
IDENTICAL_AFTER_NORMALIZATION
（归一化项仅：tmp 根、t_… 随机 token、b_… 由 workspace 参与生成的 id、HH:MM:SS、msg_N、list 顺序）
```

---

## 5. 风险清单

| # | 风险 | 判断 |
| --- | --- | --- |
| R1 | **注入旁路（F2）**：非参与方写 `blocked` → 进入别人 takeover 注入。需要同时知道「workspace + target + 正文原文」（bid 的确定性输入），门槛不低，但属于提示注入面，且违反文档承诺 | 修（一行判定复用即可） |
| R2 | **预览写盘（F1）**：`confirm:false` 语义被破坏，调用方以为「什么都没改」 | 修（同上，同一分支） |
| R3 | inbox 展示上限 4000 字：超长正文（近上限 + 三段）在 `collab_inbox` 摘要里可能被截掉 | 记录即可；真实 user turn 不截断，三段仍在正文 |
| R4 | 去重命中重复追加（F3）：同一条占 3 个槽位、挤掉不同报告 | 建议修或文档说明 |
| R5 | 承接方的**子会话**不落库（只渲染） | 可接受，回执有说明 |
| R6 | 旧记录（无 `blocked`）与坏记录：`blockedHistoryOf` 容忍读 + 重清洗 + 上限 | 已处理（`verdict.ts:435-461`） |
| R7 | `blocked` 不强制 kind：正文不写 `[handoff] BLOCKED` 时记录只展示不闭环 | 设计明示（design §4），文档已建议同行 |
| R8 | spawn 注入路径无真实可触达数据（新 bid 无 `blocked`） | 静态同源，无缺陷 |

---

## 6. 复核方法备注

- 全部实验在 `/tmp/opencode/review/**`（HEAD 存档构建、变异副本、探针）与 harness 自带临时目录内完成；
  `COLLAB_BROADCAST_DIR` / `COLLAB_CONFIG` 等全部指向临时目录，**未触碰 `~/.config/opencode`**、未操作真实会话、未 push/restart。
- 工作区零改动：复核前后 `src/tools/send.ts`、`src/core/verdict.ts` sha256 一致；本报告是唯一新增文件。

---

# 增量复核（F1/F2/F3 修复）

复核轮次：round 2（2026-11-19）。范围：上一轮 `F1`（handoff 幂等分支预览写盘）/ `F2`（同路径非参与方旁路）
/ `F3`（send 去重命中重复追加）的修复，以及「不误伤」回归。仍然**只审不改**（未修改任何实现文件、未 commit/add/push）。

## 7.0 结论

**可提交。** F1/F2/F3 都是**真修**（不是改断言）：三条新断言在对应实现被移除时各自失败（845/846，见 §7.5），
我上一轮用于暴露缺陷的探针（H1/H2/D1）现在全部翻绿，端到端的注入旁路探针（X1）也已闭合。
回归 **846 + 12 + 20 + 50 + 49 + 47 + 17** 全绿，工具面 21、版本 0.6.0、无新依赖；
「不传 `blocked` 逐字一致」以 HEAD 独立构建重新比对仍 `IDENTICAL_AFTER_NORMALIZATION`。

唯一遗留为**文档一行**：`CHANGELOG.md:86` 仍写「**测试**：S105（20 条，见 Tests）」，而 Tests 段（同文件 219 行）、
`docs/collab.md:1557`、实际计数都是 **23 条**；建议顺手改成 23（不阻塞）。

判定：上一轮 F1/F2/F3 → **已修**；F4（文档措辞）→ **已消解**；新增观察项 X2/X3/X4（见 §7.8，均低风险、不阻塞）。

## 7.1 F1 真修（handoff 幂等分支：预览不写）—— 通过

- 位置：`src/tools/handoff.ts:224`（`if (blocked && input?.confirm !== true)` → 只回执「预览…未落库」）、
  写盘在 `:229`。该分支在 `:243` 的预览 return **之前**，所以它自己的门是必需的（注释 `:218-219` 写清了）。
- 自写探针（`/tmp/opencode/review/probe-delta.mjs`，F1a/F1b）：

```
PASS F1a 幂等分支 confirm:false 连续 2 次预览：文件 hash / 条数 / prompts 全不变，回执明说未落库
        — hash d90e21d0→d90e21d0 / count 1→1 / +0 prompt
PASS F1b 同一路径 confirm:true 后才 +1，且内容正确；state/claim/receipt 不变
        — count 1→2 / 注: blocked 已写入记录 b_d6b3a9bc3bb79c61（保留最近 3 次；未重复投递，state / claim / receipt 未改）。
```

- 判据用**记录文件 sha256**（不是条数）：两次预览后 hash 逐字节不变；确认后 hash 改变且 `blocked.at(-1).minimalTest` 正确。
  上一轮的 H1 探针（`before=0 after=1`）现在为 `before=0 after=0`。

## 7.2 F2 真修（同一路径：非参与方不写）—— 通过

- 单一实现：`src/core/verdict.ts:501 canWriteBlocked(record, who)`；调用点只有两处 ——
  `src/tools/send.ts:216` 与 `src/tools/handoff.ts:226`（`grep canWriteBlocked src/` 已核）。
- 证据：

```
PASS F2a 非参与方（third）走幂等分支：文件 hash 不变，回执点名「不是 … 的参与方」+ 未落库
        — 注: 当前会话不是 b_d6b3a9bc3bb79c61 的参与方（from / claim.by / asked / origin）—— blocked 未落库。
PASS F2b 参与方（claim.by）在同一幂等分支仍能写 — F2 承接方写
PASS F2c asked 参与方可写、非参与方不可写（共用 canWriteBlocked） — 1 entries
PASS F2d origin 参与方可写、其他人不可写 — 1 entries
PASS F2e fail-open 面：记录无任何参与方字段 / 无 sessionID 时仍写（既有「无身份不校验」语义，观察项）
        — bare=1 nosid=1
```

- 覆盖完整：`from`（F1b 的发起方写入）、`claim.by`（F2b）、`asked`（F2c）、`origin`（F2d）都能写；
  四类之外的会话一律「只渲染不落库 + 回执点名」。上一轮的 H2 探针（记录被第三方改写）现在为「记录 JSON 不变」。
- **fail-open 分支判断**（任务点名）：
  - `who` 为空（工具无 session 上下文）→ 放行。这与仓库既有「无 sessionID 不做身份校验」一致；
    现实中 agent 工具总有 sessionID，且放行的仍受「bid 必须存在 + 记录必须存在」约束，**不构成实际旁路**。
  - 记录 `from/claim.by/asked/origin` 全空 → 放行。这种记录只能手写/损坏：`collab_handoff`（`:329` 写 `from`）与
    `collab_broadcast` 都必写 `from.sid`，正常路径写不出「无参与方」的记录。**可接受**（代码注释 `verdict.ts:494-499` 已声明）。
- 顺带核对了「不因参与方判定挡住合法调用」：新单路径不看该判定（`from = me` 天然成立）；幂等分支的合法三方
  （发起方补注 / 承接方上报 / 被问询方回写 / 链头转发）都能写。

## 7.3 F3（去重命中不重复追加）—— 通过

- 位置：`src/tools/send.ts:236`（`duplicate = confirm:true && result.delivery === undefined`）、`:220` 命中即跳过写盘（`recordBlocked` 在 `:205`）。
  该判据成立的前提已核对：`dispatch` 只有**真实投递**才返回 `delivery`（`shared.ts:772`），
  `confirm:true` 的其它非投递出口只可能是去重读回（护栏/自投都是 `throw`）。
- 证据：

```
PASS F3a 首投真实投递 → +1；同文第二次（去重命中未投递）→ 不追加；回执明说
        — 0→1→1 / +1 prompt / 注: blocked 未落库（同文去重命中、本次未投递；记录里已有的那一条已含这段）。
PASS F3b 换正文 → 真实投递 +1；force:true 强制投递 → 真实投递 +1（不被误判为去重） — 3 entries
PASS F3c F3 全程 state/claim/receipt/replies 不变
PASS F3d 观察：首发被拒写（非参与方）→ 参与方同文遇去重命中被跳过（记录仍为空，回执说「已含这段」） — entries=0
```

- 三个方向都覆盖了：真实投递 → 追加；去重命中 → 不追加；`force:true` → 照常投递并追加（不会被误判）。
  上一轮的 D1 探针由 `entries=2` 变为 `entries=1`。

## 7.4 回归不误伤 —— 通过

- **首投带 `blocked`**（`collab_handoff` 新单）：正文三段齐全（`需要对方：① n1 ② n2 ③ n3 ④ n4`）、记录一条、
  `collab_status` 聚合 `①②③（还有 1 条）` —— delta R1 通过。
- **`collab_send` 路径**：P6a（正文 bid 落库）/ P6b（预览不写）/ P6c（记录不存在）/ P6d（非参与方）/ P6e（无 bid）全通过。
- **三处渲染**：叫醒（W1 真实链路，`①②③（还有 2 条）` / `（还有 1 条）`）/ 重发（R1，`context → resendIfDue → takeoverBody`）/
  `collab_status`（S1）全通过；投递正文、inbox 全文、context 注入三处都带三段（`probe-review4`：`{delivered,inbox,inject} = true`）。
- **超限拒绝**：R2（21 条 excluded）+ 上一轮四类非法输入，均 0 投递 0 写入。
- **兼容**：`node probe-new.mjs`（新 dist）+ normalize vs HEAD 归一化基线 → `IDENTICAL_AFTER_NORMALIZATION`。

## 7.5 变异（3 组，自做，在 `/tmp` 副本内）—— 通过

副本 `/tmp/opencode/review/mut2`（工作区完整拷贝 + node_modules 软链），基线 `846/846`。

| 变异 | 结果 | 失败断言 |
| --- | --- | --- |
| ① handoff 幂等分支去掉 `confirm` 门（`handoff.ts:224` 条件加 `&& false`） | **845/846** | `S105 handoff 幂等分支：confirm:false 预览不落库，确认后才写（复核 F1）` |
| ② handoff 幂等分支跳过 `canWriteBlocked`（`:226` 条件加 `&& false`） | **845/846** | `S105 handoff 幂等分支：非参与方不写别人的记录（复核 F2）` |
| ③ `send` 去掉去重命中跳过（`send.ts:236` 改为 `duplicate = false`） | **845/846** | `S105 去重命中：不重复追加 blocked（不白占最近 3 次名额，复核 F3）` |

每次只红 1 条 → 三条新断言各自咬住对应实现，不是自证。还原后 `grep MUTATION` 为空、
`sha256(send.ts)=bb0e9023…`、`sha256(handoff.ts)=37973b2d…` 与工作区一致，副本重跑 846/846。

## 7.6 回归与范围 —— 通过

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
BUILD=0  TSC=0（无输出）
=== 846/846 checks passed
=== 12/12 checks passed
=== 20/20 board checks passed
=== 50/50 checks passed
=== 49/49 checks passed
=== 47/47 checks passed
=== 17/17 panel checks passed
skills ok
```

- 工具面 **21**（S105h 断言）、版本 **0.6.0**、`git diff package.json pnpm-lock.yaml` 空（无新依赖）。
- 范围：本轮的 diffstat 增量只落在 `src/core/verdict.ts`(+38) / `src/tools/handoff.ts`(+10) / `src/tools/send.ts`(+11) /
  `test/handoff-harness.mjs`(+105) / `CHANGELOG.md` / `README.md` / `docs/collab.md` / `skills/collab/SKILL.md` / 任务目录；
  `src/tools/status.ts` 与 `src/types.ts` 的 diff 与本轮无关（`grep canWriteBlocked|duplicate` = 0 命中），未被改动。

## 7.7 文档 —— 一致（1 处计数瑕疵）

| 三条规则 | 文档 |
| --- | --- |
| 预览不写 | `docs/collab.md:1533-1534`、`README.md:61`、`skills/collab/SKILL.md:198-199`、`CHANGELOG.md:77-78` 全部写明 `confirm:true` 才写，`confirm:false` → 未落库 |
| 非参与方不写 | 同上（`from` / `claim.by` / `asked` / `origin`，单一实现 `canWriteBlocked`），并写明 handoff **幂等分支**走同样的两道门 |
| 去重命中不写 | 同上（「同文去重命中（本次未投递）→ 未落库，不重复占名额」） |
| 计数值 | `docs/collab.md:1557` = 23 条、`CHANGELOG.md:220` = 823 → 843 → 846、Tests 段 = 23 条 —— 但 **`CHANGELOG.md:86` 仍写「S105（20 条，见 Tests）」**（stale，建议改 23） |

## 7.8 增量风险清单

| # | 风险 | 判断 |
| --- | --- | --- |
| X1 | `canWriteBlocked` 的两处 fail-open（无 sessionID / 记录无任何参与方字段） | **保留**：与既有「无 sessionID 不做身份校验」一致；正常写出的记录必有 `from.sid`。已在代码注释与本节记录 |
| X2 | F3 的回执措辞「记录里已有的那一条已含这段」在「首发被拒写、随后参与方同文被去重跳过」时**不准确**（记录其实为空，本次本可写入；60s 窗口后重发即可写入） | **低**：只会漏写一次，不会写错；如需严格可把措辞改成「本次未落库；若记录里仍没有，请 60s 后重发」 |
| X3 | `duplicate` 由 `!result.delivery` 推断 —— 与 `dispatch` 的「非投递出口」集合耦合；未来若新增一个 `confirm:true` 的非投递返回，会被误判为去重并跳过写入 | **低**：当前集合已核对为「仅去重」；建议在 `dispatch` 返回类型上加显式 `deduped?: true`（后续重构项） |
| X4 | `CHANGELOG.md:86` 「S105（20 条）」stale | **建议一行修**（不阻塞） |
| X5 | 幂等分支在 `protect` 门之前返回；参与者可给「目标后来变受保护」的既有记录补 `blocked` | **可接受**：只写本地记录的展示字段，不产生投递；`deliverAsk`/`resendOnce` 仍对受保护目标拒投，注入不出去 |

## 7.9 本轮复核方法备注

- 探针：`/tmp/opencode/review/probe-delta.mjs`（本轮 13/13）、`probe-review{,2,3,4}.mjs`（上一轮，用于翻绿对照）；
  变异副本 `/tmp/opencode/review/mut2`；HEAD 基线 `/tmp/opencode/review/head`（`b806e07`）。
- 全部实验使用 harness 临时目录（`COLLAB_BROADCAST_DIR` / `COLLAB_CONFIG` / `COLLAB_REPORT_DIR` 等），
  未触碰 `~/.config/opencode`、未操作真实会话、未 push/restart。
- 工作区零改动：`src/tools/{send,handoff}.ts`、`src/core/verdict.ts` 复核前后 sha256 与作者提交一致（见 §7.5）；
  本报告是唯一新增内容。
