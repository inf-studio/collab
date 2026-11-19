# 独立复核报告：注入头带发出方会话名（`11-19-collab-sender-name`）

- 复核角色：独立 Check Agent（冷上下文，**只审不改**，未 commit / 未 push / 未改实现文件）
- 被复核版本：`/data/project/collab` 工作区未提交改动（`main`，`package.json` 0.7.0）
- 复核时间：2026-11-19

## 结论

**可提交。** 9 项必查全部通过，无 P1/P2 缺陷；实现与 PRD R1–R4 一致，与 design 的落点偏差（`ids.ts`/`constants.ts` 而非 `verdict.ts` 的 `inboundHeader`）已核对属实——仓库从来不存在 `inboundHeader`，入站头确实由 `envelope()` 拼装。

- 验收全绿：`883 + 12 + 20 + 50 + 56 + 47 + 34`，`skills ok`，`typecheck` 0 错（复核跑了 **2 轮**，见 §原始输出 R1/R5）。
- 自写探针 **27/27**（直接 import `src/*.ts`，不复用 harness 断言）。
- 自做 2 组变异：去缓存 → 881/883（2 条失败）；名称放到 id 之后 → 870/883（13 条失败）。已按 md5 逐字节还原并重跑全绿。
- 遗留风险均为 P3（可选跟进），见 §风险清单。

---

## 逐条结论（9 项）

### 1. 格式：名称在最前，机读头位置/内容不变 — **通过**

证据：

- `src/ids.ts:66-67`：`const label = …trim(); return `${label ? `[${label}]` : ''}[collab:${from}]${tag} ${body}`;` —— 名称段在最前，`[collab:<from>]` 紧跟，`tag`（`[<kind>:<threadID>]`）位置不变。
- 四个投递点：
  - `src/tools/shared.ts:540`（`dispatch`：request / reply / note 全走这里；`steer` 只是 delivery 模式，头仍是 `[request:…]`）
  - `src/tools/shared.ts:883`（`deliverAsk`：接管请求 / wake / 首投）
  - `src/core/chain.ts:625`（`notifyRequester`：ACCEPT / DECLINE note）
  - `src/core/chain.ts:791`（`resendOnce`：重发）
- 探针 A1–A4：`envelope({from:'ses_abc',name:'T',kind:'note',threadID:'t_1',body:'B'})` === `[T][collab:ses_abc][note:t_1] B`；`s.indexOf('[collab:') === 3`；`COLLAB_ENVELOPE_RE` / `COLLAB_PREFIX_RE` 仍从位置 0 匹配。
- 实测（harness R1 原始行）：`✓ S107 request 头 … [S107 发起方会话][collab:ses_s107…07me][request:t_…] S107 request 正文`，reply / note / steer / 接管请求 / ACCEPT note 同构。
- `steer`：`delivery === 'steer'` 且头为 `[request:…]`（与 0.7.0 一致，`steer` 从来不是 kind）。

### 2. 退化：取不到标题 → 与旧格式逐字一致；失败不缓存 — **通过**

证据（严格比对两份文本，旧实现取自 `git show HEAD:src/ids.ts` 与 `HEAD:src/constants.ts`，逐字核对过）：

```ts
// HEAD（0.7.0）实现，原文
const tag = threadID ? `[${kind}:${threadID}]` : `[${kind}]`;
return `[collab:${from}]${tag} ${body}`;
```

- 探针 B1–B4：`name` 缺省 / `''` / 纯空白 / `senderNameOf(undefined)` 四种输入，新 `envelope()` 输出与上面旧实现**逐字节相等**（`assert.equal`）。
- 探针 D3：宿主 `get` 抛错 → 返回 `''`，**两次调用共 2 次宿主请求**（失败不缓存，下次重试）。
- 探针 D6：`ctx` 缺省 / 无 `session.get` / sid 为空 → 全部静默 `''`，不抛。
- `src/core/verdict.ts:290-311`：`catch { return ''; }` 分支不写缓存；只有成功分支 `senderNameCache.set(...)`。
- harness：`✓ S107 宿主读不到发送方 → 头与旧格式逐字一致（`[collab:…][note:t_…]`）`、`✓ S107 标题为空串 → …`。

### 3. 清洗：20 字截断、`]`→`）`、控制字符 — **通过（附 P3 观察）**

证据：

- `src/core/verdict.ts:270-276`：`\s+`→单空格 → `trim` → `]`→`）` → `truncate(text, 20)`。
- 探针 C1：23 字标题 → `一二三四五六七八九十甲乙丙丁戊己庚辛壬…`（19 字 + `…`，总长 20；与 `truncate` 口径 `src/util.ts:31-36` 一致，也与 design `truncate(title, 20)` 一致）。
- 探针 C2/C3：20 字原样、21 字 → 19+`…`。
- 探针 C4/C5：`a]b`→`a）b`；`'  a\n\tb  '`→`a b`。
- 探针 C7：标题含 `[`（`[WIP] x` → `[WIP） x`）时头为 `[[WIP） x][collab:ses_abc][note:t_1] B`，`parseEnvelope` 仍取到 `from=ses_abc / threadID=t_1 / body=B / name=[WIP） x`。
- 控制字符：`senderNameOf('a\u0000b\u001bc')` 原样保留（见 §风险清单 P3-2）。PRD/design 只要求 `]` 清洗，故不算不通过。

### 4. 缓存：同 sid 两轮只查一次；不同 sid 各自查 — **通过**

证据：

- `src/core/verdict.ts:261`：`SENDER_NAME_TTL_MS = 10 * 60_000`；`:279` 模块级 `Map<sid,{name,at}>`；`:298` 命中且 `< TTL` 直接返回。
- 探针 D1：同 sid 两次 → `calls()===1`；D2：两个新 sid → 2 次，且各自命中；D4：`t0+TTL-1` 仍命中（1 次），`t0+TTL` 重新取（2 次），边界口径正确；D5：空标题按「成功」缓存（1 次）。
- harness：`✓ S107 四类 kind 共 4 次投递：发送方 session.get 只 1 次（缓存跨 kind / mode） — gets=1`；`✓ S107 同一 sid 两轮注入：宿主 session.get 只调用一次（10 分钟缓存） — gets=1`。
- 假宿主计数实现于 `test/handoff-harness.mjs:641`（`sessionGets.push(sessionID)`），S107e 还先断言 `s107CacheBefore === 0`，排除被前序用例预热。

### 5. 范围：只改入站注入头 — **通过（`[ack]` 为已声明例外，理由部分成立）**

| 面 | 是否受影响 | 依据 |
| --- | --- | --- |
| 出站正文 / 协议头（`takeoverBody` / `protocolHeader` / `receiptLines`） | 否 | `git diff -U0` 无这些函数的删除行；只有 `envelope()` 头多一段 |
| `collab_list` / `collab_status` / TUI / GUI / 看板 | 否 | 9 个改动文件不含 `board.ts` / `snapshot.ts` / `gui/*` / `tui/*`；`src/hooks/context.ts` 未动（注入行仍是 `- <kind> <threadID> from=…: <body>`） |
| `[ack]` 噪声 | 否（有意） | `src/core/chain.ts:714` 仍 `envelope({from, kind:'note', body: buildAck(cid)})` 无 name；`buildAck` = `[ack] <cid> seen`，`isAckText`/`parseAck` 依赖正文首段，`extractInbound` 先剥信封再存 `text`，故不受影响（S99/S100 闭环全绿） |
| `collab-report` 伪发送方 | 否（有意） | `src/core/report.ts:450` 未动；`from='collab-report'` 是伪会话，`session.get` 本就会失败 → 即便接入也恒为空；PRD R3 只点名 4 类 kind |
| `[urgent]`（escalate）/ `[collab-freeze]`（freeze） | 否 | 二者根本不用信封头（`URGENT_PREFIX` / `noticeBody`），保持原样自洽 |

`[ack]` 理由评估：**部分成立**。它确实不进 `[collab] 新消息` 注入块（`hooks/context.ts:73` 用 `isAckText` 过滤），但从投递语义看它仍是一条 `kind=note` 的用户轮消息，人在转录里仍会看到 `[collab:ses_…][note] [ack] c_… seen`。属 P3 可选跟进，不阻塞（CHANGELOG 已显式写明「`[ack]` 机器噪声不带头」）。

### 6. 兼容：既有解析全绿，`from` 仍是机器字段 — **通过**

证据：

- `src/constants.ts:28`：`/^(?:\[([^\]]*)\])?\[collab:([^\]]*)\](?:\[([a-z]+)(?::([^\]]*))?\])?\s*/`；`src/ids.ts:81-95` 分组随之为 `1=name,2=from,3=kind,4=threadID`。
- 探针 E1：对 9 条旧格式文本（含 `[collab:a][request:t]`、无 thread、`[reply]`、非法 kind、`[collab:a] bare`、多空格、空 from）逐条比对 **HEAD 正则的解析结果**，`{from,kind,threadID,body}` 完全一致。
- 探针 E2/E5：带标题信封 → `from=ses_a`（不是 title），`name='某会话'`。
- 探针 E4：仍锚定 `^`，文中出现的 `[collab:…]` 不会被误匹配（`parseEnvelope('x [collab:…]')` 仍为 `undefined`）。
- 探针 E3：`normalizeText` 会一并剥掉标题段（去重键不变）。
- 元数据未变：S107a 断言 `metadata.collab.from === shortOf(发送方)`；`src/tools/shared.ts:542` 之后 `metadata` 组装未改。
- 闭环回归：`S99` / `S100` 全绿（含变异 2 时它们会挂，说明它们真的覆盖了信封→回执链路）。

### 7. 回归与范围：计数、工具数、版本、依赖 — **通过**

- 复核执行（2 轮，第 1 轮在变异前，第 2 轮在还原后）：

```
=== 883/883 checks passed
=== 12/12 checks passed
=== 20/20 board checks passed
=== 50/50 checks passed
=== 56/56 checks passed
=== 47/47 checks passed
=== 34/34 panel checks passed
skills ok            (node scripts/check-skill.mjs)
EXIT=0               (pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs)
```

- 工具数 **22**：探针 F1 直接 `registerTools(kit)` → `names.length === 22` 且全部 `collab_*`（`src/tools/index.ts:38-61`，未改动）。
- 版本 **0.7.0**，`package.json` 未在 diff 中；`dependencies` 仍为 `{}`（无新依赖）。
- 改动面 = 9 个文件，全部在允许清单内（`git diff --name-only`）。`git status` 另有 3 个**其它任务**的未跟踪目录（`11-19-collab-board2*`），与本任务无关。

### 8. 测试真实性：自做 2 组变异，13 条非自证 — **通过**

变异前先 `md5sum` 留底；两组变异均 `pnpm exec vp pack` 后用 `node test/handoff-harness.mjs` 跑，再 `cp` 还原并 `md5sum -c` 校验。

**变异 A（去掉缓存读取，`src/core/verdict.ts:298`）**：

```ts
if (false && hit && now - hit.at < SENDER_NAME_TTL_MS) return hit.name; // MUTANT-A
```

```
  ✗ S107 四类 kind 共 4 次投递：发送方 session.get 只 1 次（缓存跨 kind / mode） — gets=4
  ✗ S107 同一 sid 两轮注入：宿主 session.get 只调用一次（10 分钟缓存） — gets=2
=== 881/883 checks passed
```

→ 恰好 2 条，说明缓存断言真的在查宿主调用次数（`gets=4` / `gets=2`），不是读缓存内部值。

**变异 B（名称放到 id 之后，`src/ids.ts:67`）**：

```ts
return `[collab:${from}]${tag}${label ? `[${label}]` : ''} ${body}`; // MUTANT-B
```

```
  ✗ S99 following the header command really closes the hand-off (state=done)
  ✗ S99 the BLOCKED variant closes the next hand-off as blocked
  ✗ S100 C closes the bid by answering A directly (2 hops, no forwarder)
  ✗ S105 不传 blocked：投递正文 = 信封（标题 + 机器头）+ 正文，零追加行
  ✗ S107 request / reply / note / steer / 接管请求 / ACCEPT note / 长标题 / `]` / 缓存（共 9 条 S107）
=== 870/883 checks passed
```

→ 13 条失败、`870/883`，与实现方 `research/impl-notes.md` §7 记录**逐字一致**；且连 S99/S100 闭环都挂，证明「名称必须在最前」这条约束被真实业务链路钉住了。

**是否自证 / 是否弱化既有断言**：

- S107 的断言全部是**字面量严格相等**（`===` 整串）或对机读字段的独立断言，另有 `head107()` 仅做字符串拼接，`shortOf` 是 harness 既有的 `shortID` 镜像（`test/handoff-harness.mjs:10879` vs `src/util.ts:53-56`），不调用被测函数。
- 既有断言只改 1 处：S105b 由旧格式整串改为新格式整串（仍是 `===`，仍断言「零追加行」）。`git diff -U0 | grep '^-'` 只剩这 3 行删除，无 `includes` 替换 `===` 之类弱化。
- 新增 S107 13 条：request / reply / note / steer / 4×kind 的 get 计数 / 接管请求 / ACCEPT note / 长标题 / `]` / 读不到 / 空串 / 缓存两轮 / 带标题解析 = 13 ✓。

### 9. 文档与实现一致 — **通过**

- `docs/collab.md:443-486`（§11.7，新增块在 466-486）：三步表 ① 改为 `[<标题>][collab:<from>][request:<threadID>]`（`:469`）；新增块写明格式、20 字截断、`]`→`）`、10 分钟缓存、「取不到 → 逐字一致 + 失败不缓存」、「解析/预算/protected 不受影响」——与代码逐条对得上（`verdict.ts:261/263/270-276/290-311`、`ids.ts:67`）。
- `docs/collab.md:71-86`（§3.2 消息前缀）未改：那一节讲的是 **CLI**（`scripts/collab.mjs --from/--no-prefix`）的前缀，没有会话标题概念，不算过期。
- `CHANGELOG.md:13-24`（`[Unreleased]` → `### Added` 首条）：含格式、20 字 / `]`→`）` 的理由（「否则会提前闭合名称段」——探针 C7 + 变异 4 证实）、10 分钟缓存与「只有成功读取才缓存」、退化逐字一致、覆盖点、测试 870 → 883。版本号未改（`[Unreleased]` 下 0.8.0 由父任务发版），与 implement.md 一致。
- `src/tools/send.ts:30-31` 工具描述同步为新头格式，`node scripts/check-skill.mjs` → `skills ok`。

---

## 原始输出（复核会话）

### R0 改动面

```
$ git diff --name-only
CHANGELOG.md
docs/collab.md
src/constants.ts
src/core/chain.ts
src/core/verdict.ts
src/ids.ts
src/tools/send.ts
src/tools/shared.ts
test/handoff-harness.mjs
$ git status --short
(仅上述 9 个 M + 3 个其它任务的 ?? 目录)
```

### R1 必跑命令（变异前）

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
=== 883/883 checks passed
=== 12/12 checks passed
=== 20/20 board checks passed
=== 50/50 checks passed
=== 56/56 checks passed
=== 47/47 checks passed
=== 34/34 panel checks passed
skills ok
EXIT=0
```

S107 原始行（节选）：

```
  ✓ S107 request 头：`[标题][collab:ses_…][request:t_…]` 且正文逐字在后 — [S107 发起方会话][collab:ses_s107…07me][request:t_mwnioyhr_6agp] S107 request 正文
  ✓ S107 reply 头：名称仍在 `[collab:…]` 之前，`[reply:t_…]` 位置不变 — …
  ✓ S107 note 头：同格式（note 也带标题） — …
  ✓ S107 steer 投递：头同格式，delivery 仍是 steer（只多一段可读前缀） — steer / …
  ✓ S107 四类 kind 共 4 次投递：发送方 session.get 只 1 次（缓存跨 kind / mode） — gets=1
  ✓ S107 接管请求头：`[发起方标题][collab:…][request:t_…]`，协议头正文不变 — …
  ✓ S107 ACCEPT note 头：`[承接方标题][collab:…][note] ACCEPT …` — …
  ✓ S107 标题 >20 字 → 前 19 字 + `…` — [一二三四五六七八九十甲乙丙丁戊己庚辛壬…][collab:ses_s107…long][note:t_…
  ✓ S107 标题含 `]` → 替换为 `）`，机器头 `[collab:…]` 不受影响 — [S107 [WIP） 标题][collab:ses_s107…7brk][note:t_…
  ✓ S107 宿主读不到发送方 → 头与旧格式逐字一致（`[collab:…][note:t_…]`） — [collab:ses_s107…host][note:t_…
  ✓ S107 标题为空串 → 头与旧格式逐字一致（只去掉名称段） — [collab:ses_s107…mpty][note:t_…
  ✓ S107 同一 sid 两轮注入：宿主 session.get 只调用一次（10 分钟缓存） — gets=1
  ✓ S107 带标题入站仍解析出 from / threadID / 正文（标题不进入注入行） — [collab] 新回执 1 条 / - reply t_s107parse from=ses_s107to: S107 带回执 …
```

### R2 自写探针（不复用 harness）

```
$ node --experimental-strip-types /tmp/opencode/probe-sender-name.mjs
  ✓ A1 name first, exact header
  ✓ A2 no threadID
  ✓ A3 kinds keep the machine head shape
  ✓ A4 regex still matches at position 0 for the machine head
  ✓ B1 name omitted === old bytes
  ✓ B2 name "" === old bytes
  ✓ B3 name whitespace-only === old bytes
  ✓ B4 senderNameOf(undefined) === old bytes
  ✓ C1 long title truncates to 19 chars + …
  ✓ C2 exactly 20 chars untouched
  ✓ C3 21 chars → 19 + …
  ✓ C4 ] → ）
  ✓ C5 newline / tab collapse to one space, trimmed
  ✓ C7 title with [ is safe for the machine head
  ✓ D1 two reads of the same sid → one host call
  ✓ D2 different sids are cached independently (fresh sids: cache is module-wide)
  ✓ D3 a throwing host is NOT cached (retried)
  ✓ D4 TTL boundary: <10min reuses, =10min refetches
  ✓ D5 empty title is cached as "" (success is cached)
  ✓ D6 missing host / missing sid degrade silently
  ✓ E1 legacy envelopes parse exactly as before
  ✓ E2 titled envelope parses name/from/kind/threadID/body
  ✓ E3 normalizeText strips the title segment too
  ✓ E4 parseEnvelope is still anchored (no mid-text match)
  ✓ E5 from is never the title (group shift)
  ✓ E6 widened match: a bracketed non-head prefix now parses
  ✓ F1 exactly 22 collab_* tools, unchanged names

probe: 27/27 checks ok
```

（探针首跑时 D2 因 D1 已缓存 `ses_a` 而失败——是探针自身串了模块级缓存，改用独立 sid 后通过；这反过来证明缓存确实是模块级、按 sid 生效。）

### R3 变异 A（去缓存读取）

```
$ (MUTANT-A) pnpm exec vp pack && node test/handoff-harness.mjs
  ✗ S107 四类 kind 共 4 次投递：发送方 session.get 只 1 次（缓存跨 kind / mode） — gets=4
  ✗ S107 同一 sid 两轮注入：宿主 session.get 只调用一次（10 分钟缓存） — gets=2
=== 881/883 checks passed
exit=1
```

### R4 变异 B（名称放到 id 之后）

```
$ (MUTANT-B) pnpm exec vp pack && node test/handoff-harness.mjs
  ✗ S99 following the header command really closes the hand-off (state=done)
  ✗ S99 the BLOCKED variant closes the next hand-off as blocked
  ✗ S100 C closes the bid by answering A directly (2 hops, no forwarder)
  ✗ S105 不传 blocked：投递正文 = 信封（标题 + 机器头）+ 正文，零追加行
  ✗ S107 request 头 …
  ✗ S107 reply 头 …
  ✗ S107 note 头 …
  ✗ S107 steer 投递 …
  ✗ S107 接管请求头 …
  ✗ S107 ACCEPT note 头 …
  ✗ S107 标题 >20 字 …
  ✗ S107 标题含 `]` …
  ✗ S107 同一 sid 两轮注入 …
=== 870/883 checks passed
exit=1
```

### R5 还原 + 复跑（终态）

```
$ cp 备份 → src/core/verdict.ts src/ids.ts
$ md5sum -c /tmp/opencode/collab-bak/md5.before
src/core/verdict.ts: 成功
src/ids.ts: 成功
$ grep -c MUTANT src/core/verdict.ts src/ids.ts
src/core/verdict.ts:0
src/ids.ts:0
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
=== 883/883 checks passed
=== 12/12 checks passed
=== 20/20 board checks passed
=== 50/50 checks passed
=== 56/56 checks passed
=== 47/47 checks passed
=== 34/34 panel checks passed
skills ok
EXIT=0
```

工作区终态与复核开始时一致（9 个 M，无新增/还原遗留；`dist/` 为构建产物，未入库）。

---

## 风险清单（均为 P3，不阻塞提交）

| # | 级别 | 项 | 说明 / 建议 |
| --- | --- | --- | --- |
| P3-1 | 低 | `[ack]` note 不带头 | `chain.ts:714` 有意不加名称（CHANGELOG 已声明）。理由部分成立：它不进注入块，但仍以 `kind=note` 的用户轮出现在转录。若要与 R3 字面完全对齐，可加 `name: await senderName(ctx, me)`——已核实 `isAckText`/`parseAck` 走 `parsed.body`，加了也不会破（成本：每次 ack 一次宿主查询，有 10 分钟缓存）。 |
| P3-2 | 低 | 标题控制字符未过滤 | `senderNameOf('a\u0000b\u001bc')` 原样保留（ANSI ESC 可能影响 TUI 渲染）。同一标题本来就会显示在 `collab_list` / 看板里，暴露面未扩大；如要收口，可用仓库既有的 `sanitizeReason` 同类做法。 |
| P3-3 | 低 | emoji 截断可能切出半个代理对 | `'x'*18 + '😀' + 'y'`（21 码元）→ `xxxxxxxxxxxxxxxxxx\ud83d…`（lone surrogate）。属 `truncate()` 既有口径（`src/util.ts:35` `slice`），不是本任务引入；仅显示问题，机读头不受影响。 |
| P3-4 | 低 | `]` 清洗只在 `senderNameOf`，`envelope()` 不设防 | 当前唯一生产者就是 `senderNameOf`，无现实问题；若将来有第二个调用点直接传标题，裸 `]` 会破坏机读头（变异 4 已证明）。可考虑把 `.replace(/\]/g,'）')` 下沉到 `envelope()` 做纵深防御。 |
| P3-5 | 低 | `notifyRequester` 的名称来源是 `record.claim.by` 而非 `from` 参数 | 现有两个调用点均 `claim.by === me`，正确；但二者未来若分离会「头有 id、无名称」。建议在注释里点明该耦合，或改由调用方传入 `nameSid`。 |
| P3-6 | 低 | `resendOnce` 无专门测试 | 代码已接 `senderName`（`chain.ts:791`），CHANGELOG 列入覆盖点，但 S107 未单独钉住重发路径（重发由既有 S 组间接覆盖）。可补 1 条断言。 |
| P3-7 | 低 | 缓存无上限、失败不缓存但「空标题」缓存 10 分钟 | design §2 明确接受容量；「空标题缓存」= design 的「成功才缓存」语义。会话从无标题到有标题最多滞后 10 分钟，PRD R2 允许。 |
| P3-8 | 轻微 | harness 顶部索引未列 S107 | `S99` 之后本来就没再更新索引（S106 也未列），沿用现状；非本任务引入。 |

## 复核未做（越界/禁止项自查）

- 未 commit / push / git add；未改实现文件；未 restart 服务；未碰真实会话（全程假宿主 + 临时目录）；未改用户 mac。
- 变异期间只临时改了 `src/core/verdict.ts` / `src/ids.ts` 各一行，已按备份 md5 逐字节还原并复跑全绿。
