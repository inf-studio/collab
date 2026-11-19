# 复核报告：契约决策记录（`collab_decisions`）

- 任务：`.trellis/tasks/11-19-collab-decisions`
- 复核方式：冷上下文独立复核（只审不改）；实现方 `research/impl-notes.md` 仅作线索
- 复核对象：`git status` 里未提交的 13 个改动 + `src/tools/decisions.ts`（新）
- 基线对照：`git archive HEAD` → `/tmp/opencode/collab-baseline`（21 工具、无 `decisions`）独立构建，与工作树并行比对
- 复核环境：临时目录 + 假宿主（`COLLAB_*_DIR` 全部指向 `/tmp/opencode/*`），未连真实会话、未 restart、未 commit/push/git add
- 复核结束时 `git status` 与开工时一致（仅新增本任务 `research/` 下的探针与报告）

---

## 结论

**需修（仅 2 处一行文档数字）→ 修完即可提交。**

实现、协议、权限、覆盖/上限语义、注入与展示、回归与变异全部通过：8 项必查中 6 项「通过」、2 项「通过但含需修/存疑的文档或边缘项」。
没有发现功能性缺陷；未发现护栏放宽、静默淘汰、隐式投递或既有断言被弱化。

| # | 检查项 | 结论 |
| --- | --- | --- |
| 1 | 写入语义（3 条 / 重复 id 覆盖 / 满 20 后新增拒、覆盖可） | ✅ 通过 |
| 2 | 权限（仅 from/claim.by；asked/origin/第三方；fail-closed） | ✅ 通过 |
| 3 | 预览与全部拒绝路径 0 写入 | ✅ 通过 |
| 4 | 只写展示字段、不投递 | ✅ 通过（`updatedAt` 由 `writeBroadcast` 固有刷新） |
| 5 | 展示（status 最近 3 / 注入一行 / list 行尾 / 旧记录逐字不变） | ✅ 通过（逐字比对见 §5） |
| 6 | 回归、工具数、版本、无新依赖、逻辑落位 | ✅ 通过 |
| 7 | 测试真实性（2 组变异 + 非自证） | ✅ 通过 |
| 8 | 文档与实现一致 | ⚠️ **需修**：`README.md:295`、`package.json:4` 的计数没跟上（其余全对） |

---

## 1. 写入语义 — ✅ 通过

实现：

- 上限/界值常量 `src/core/verdict.ts:579-587`（`DECISION_KEEP=20`、`DECISION_ITEMS_LIMIT=10`、`ID 40` / `decision 200` / `rationale 400`、展示 3、rationale 展示 80）
- 校验 `normalizeDecisionItems` `src/core/verdict.ts:625`
- 读取/容错 `decisionHistoryOf` `src/core/verdict.ts:659`
- 覆盖合并 `mergeDecisions` `src/core/verdict.ts:692`
- 写入顺序（校验 → 记录存在 → 身份 → 权限 → 上限 → 预览 → re-read 复判 → 写）`src/tools/decisions.ts:102-167`

我自己的探针（`.trellis/tasks/11-19-collab-decisions/research/check-probes/probe.mjs`，独立假宿主 + 自己的 fixture 记录，读的是磁盘上的记录文件）：

```
✓ write 3: three stamps, ids in order, by=ses_me
✓ status shows 决策 3 条 + the 3 lines
✓ list line ends with decisions=3
✓ repeat id: still 3, unique ids, latest text, by=ses_to, at moved
✓ repeat id: moved to the end (newest last)
✓ status after overwrite shows only the new answer
✓ same id twice in one call = one entry, later wins
✓ cap: 20 reached, the 21st new id is refused, 0 write
✓ cap: mixed batch (5 new + 5 overwrite) refused as a whole (no partial write)
✓ cap: overwrite at 20 still works, count stays 20
✓ cap: status says 决策 20 条（最近 3 条）:
✓ hand-edited record: status/list never throw and count ≤20
```

要点（均为我复现，不依赖实现方记录）：

- 重复 id：条数不变（3）、id 唯一、内容取最新、`by` 变成本次写者、`at` 变大、位置移到末尾（`mergeDecisions` 先 `splice` 再 `push`，`verdict.ts:703-719`）。
- 一次调用内同 id 两条 → `Map` 折叠成一条、后者胜（`verdict.ts:642-650`），所以「一次调用」不可能给同一决策留两份答案。
- 满 20：第 21 个**新** id 可读拒绝；**覆盖**已有 id 仍可（新增 0、覆盖 1、条数仍 20）。
- 混合批（5 新 + 5 覆盖）在满额时**整批拒绝**，验证拒绝前不落任何部分写入（`raw` 字节不变、`a0` 内容未变、`c*` 一条都没进）。
- 手工编辑坏记录（22 条 + `null`/字符串/空 id/缺 decision）→ `status`/`list` 不抛异常，计数按 20 容忍（`slice(-20)` + 去重 + 清洗）。

## 2. 权限（比 blocked 更严）— ✅ 通过

`canWriteDecisions` `src/core/verdict.ts:732-740`：`String(who).trim()` 为空直接 `false`；只比较 `from.sid` / `claim.by`，两者都没有时 `filter(Boolean)` 后为空数组 → `includes()` 恒 `false`（fail-closed）。

```
✓ third party / asked / origin: all refused, 0 bytes written
   拒绝写入：当前会话 ses_third 既不是 b_c0de… 的发起方（from.sid=ses_me），也不是承接方（claim.by=ses_to）…
✓ fail-closed: record with no from.sid / claim.by → refused, 0 write
✓ fail-closed: no sessionID → refused, 0 write
✓ every refusal above left the stores file-for-file identical (no new record / lock / queue item)
```

- `asked` / `origin` 两类也逐个用**真实 sid**试过并比对了记录字节（不只是 harness 标题里写的「也不行」）。
- 无身份（`input` 无 `sessionID`）→ 直接拒绝（`src/tools/decisions.ts:115-118`）。
- 记录无 `from.sid` 且无 `claim.by`（手工/损坏记录）→ 任何会话都写不进去（与 `canWriteBlocked` 的 fail-open 刻意不同）。
- 拒绝信息可读且指出双方 sid（`src/tools/decisions.ts:119-125`），不写任何字节。

## 3. 预览与拒绝路径 0 写入 — ✅ 通过

```
✓ confirm:false and confirm omitted: preview only, 0 write
✓ all 10 invalid inputs refused with 0 write            （空 items / 11 条 / id 41 / decision 201 / rationale 401 / items 非数组 / 条目非对象 / 缺 decision / bid 非法 / bid 不存在）
✓ every refusal above left the stores file-for-file identical …
```

- 预览文案含「未写入」+ 将写入条目 + 覆盖标记，且记录字节不变（`src/tools/decisions.ts:142-151`）。
- 校验先于一切 I/O（`decisions.ts:108` 在 `readBroadcast` 之前），所以非法输入连读取都不会发生；bid 不存在单独可读拒绝（`decisions.ts:110-114`）。
- 写前 re-read + 复判身份/上限（`decisions.ts:156-166`），并发下不会用陈旧记录覆盖或突破上限。
- 拒绝路径不仅记录内容不变，广播目录 / 锁目录 / 队列目录的文件列表也逐一相同（没有顺手建目录、落锁、写队列）。

## 4. 只写展示字段、不投递 — ✅ 通过

```
✓ write 3 touched no state/claim/receipt/replies/blocked
✓ write 3 changes no existing key value (only defaults materialize + updatedAt)
✓ a realistic record: decisions write changes no other key at all   → {"added":[],"removed":[],"changed":[]}
✓ write 3 delivered nothing (0 prompts)
```

- 真实记录（由 `collab_broadcast` 写出、自带 `scope/candidates/delivery/…`）上，`decisions` 写入**除 `decisions` 与 `updatedAt` 外没有任何键变化**；`updatedAt` 是 `writeBroadcast` 对任何写的固有刷新（`src/core/claim.ts:323-331`），不是本工具新增行为。
- prompt 计数 +0（不投递）；也没有写线程索引、锁、owner-queue。
- 说明（非缺陷）：对**手工/稀疏**记录（缺 `scope`/`candidates` 等默认字段）写入时，`writeBroadcast → normalizeBroadcast` 会把默认值补齐（我第一版探针因此看到 10 个 `added`）。这是所有 `writeBroadcast` 调用方的既有行为，真实记录不会触发；已在真实记录上复核为全空。

## 5. 展示 — ✅ 通过（含与改前构建的逐字比对）

- `collab_status`：`src/tools/status.ts:211-224` —— `决策 N 条`（>3 时补「（最近 3 条）」）+ 最新 3 条 `- id: decision`，rationale 括号内 `truncate(..., 80)`。
- 承接方注入：`src/core/verdict.ts:747-751` 只返回**单元素**数组；`takeoverBody` 在「按顺序完成」之前插入（`verdict.ts:801`），spawn/wake/resend 三处共用 `deliverAsk`（`src/tools/shared.ts:856-897`）。
- `collab_list`：`src/tools/list.ts:227,242`，行尾 ` decisions=N`，仅 N>0。
- 无 `decisions` 的旧记录：与**改前构建**逐字一致（见下）。

我用同一份探针分别跑「改前 HEAD 构建」和「当前构建」，把输出里的临时目录路径/时钟/随机 bid 归一后逐字比对：

```
baseline tools: 21  new tools: 22
IDENTICAL  statusPlain  200 chars
IDENTICAL  statusFull   535 chars     （带 claim/receipt/replies/blocked/origin/urgent 的满字段旧记录）
IDENTICAL  list         912 chars
IDENTICAL  wakePlain    815 chars     （真实叫醒链路拿到的 takeover 正文）
```

新构建自己的注入用例：

```
✓ injection: exactly one count line, no body, mentions collab_status + bid
   本单决策 2 条（collab_status { bid:"b_…" } 查看） / 1 prompt(s)
✓ injection: count line is placed before the three steps
✓ status cuts the rationale at 80 chars with …
✓ control chars folded into one line; no forged decision line in status
```

`rationale` 截断为 79 字 + `…`；控制字符（`\n`/`\t`）折成单空格，`id` 里的换行不会在 status 里伪造第二行。

## 6. 回归与范围 — ✅ 通过

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs   → EXIT=0

=== 870/870 checks passed
=== 12/12 checks passed
=== 20/20 board checks passed
=== 50/50 checks passed
=== 49/49 checks passed
=== 47/47 checks passed
=== 17/17 panel checks passed
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
```

- 与要求的 `870 + 12 + 20 + 50 + 49 + 47 + 17` 完全一致（846 → 870 = S106 新增 24 条：S106 区块内 `expect(` 17 + `expectFail(` 7 = 24）。
- 工具面 22（探针读到 `toolSurface.length === 22`，`collab_decisions` 注册一次；`test/readonly-default.mjs` 顺序与 `src/tools/index.ts:47` 一致）。
- `package.json` 未改：版本仍 `0.6.0`，无新依赖（`git diff --stat` 无 package.json / lockfile）。
- 纯逻辑落位：`src/core/verdict.ts` 已是 `blocked`（同属「只写展示字段、不动 state」）的家，依赖方向仍是 `tools/* → core/*`，未新建 core 文件、未引入环 —— 合适。

## 7. 测试真实性 — ✅ 通过

我自己在**工作树副本**（`/tmp/opencode/collab-mut`，与真实工作树隔离）上做变异，不碰被复核文件：

**M1：`canWriteDecisions` 放宽成任意会话（`return true`）**

```
  ✗ S106 第三方写 → 拒绝（比 blocked 更严：asked / origin 也不行） — 没有报错: 已写入决策：b_dd… 决策 5 条（本次新增 1，覆盖 0；上限 20）…
  ✗ S106 第三方拒绝后 0 写入（记录逐字不变） — CHANGED
=== 868/870 checks passed
FAIL: S106 第三方写 → 拒绝（比 blocked 更严：asked / origin 也不行）
FAIL: S106 第三方拒绝后 0 写入（记录逐字不变）
```

**M2：`mergeDecisions` 覆盖改成追加（去掉 `out.splice`）**

```
  ✗ S106 重复 id 覆盖：仍 3 条、id 不重复、内容取最新，回执标明「覆盖 1」 —
    exit-code:退出码用 3（不是 2） / room-order:… / assert-last-frame:… / exit-code:退出码用 3（覆盖：以 CLI 契约为准）
867 passed / 1 failed，随后 ValidationError 中止（同一根因：重复条目把条数顶到 21，满 20 用例的覆盖被上限拒绝）
```

**还原验证**：备份回填 → `cmp` 与真实工作树 `src/core/verdict.ts` 逐字节相同 → 副本重建后 `=== 870/870 checks passed / EXIT=0`。

关于「不是自证」：S106 的断言都读**磁盘上的记录文件**（`bcRead`/`readFileSync`）或调公共工具拿文本，没有引用被测内部函数；「0 写入」全部用前后字节比较，而不是用返回文案倒推。

既有断言未弱化：`git diff test/` 里除 S106 新增外只有 3 处 `21 → 22`（S98 / S102 / S105 的工具面与标题）与 `readonly-default.mjs` 的名称数组/标题，没有一条既有断言被改松或删除。

## 8. 文档 — ⚠️ 需修（其余全对）

已核对一致的部分（逐条 grep + 比对实现）：

| 文档 | 位置 | 与实现一致 |
| --- | --- | --- |
| `docs/collab.md` 工具表 | §11.2 `collab_decisions` 行 | ✅ 入参/1–10/id40/decision200/rationale400/仅发起方+承接方/同 id 覆盖/≤20/不投递 |
| `docs/collab.md` 专题 | §11.19（规则表 6 行 + 测试 + 回滚） | ✅ 「仅发起方/承接方」「每单 20」「按 id 覆盖」「注入只有一行」全在 |
| `docs/collab.md` `collab_status` / `collab_list` 行 | §11.2 | ✅ 指向 §11.19、` decisions=N` |
| `README.md` 工具表 + 0.7.0 段落 | 表格新增行 / §「0.7.0 起 `collab_decisions`…」 | ✅ |
| `skills/collab/SKILL.md` | 工具表 + 「一点八·再再补」 | ✅（`check-skill` ok） |
| `CHANGELOG.md` | Added 段 | ✅ S106 24 条、21 → 22、权限/上限/覆盖表述与实现一致 |

需修：

1. `README.md:295` — `pnpm test # build + 823 项 harness …` 仍写 **823**；本次为 **870**（顺带补上前一任务漂移的 846）。
2. `package.json:4` — description 仍写 `twenty-one native collab_* tools`，现为 **twenty-two**（README / docs / skill 都已经 22；`11-19-collab-threads` 的先例就是同步改这里）。

两处都是一行改动，不影响实现与测试；属「改完再提交」，不属功能缺陷。

---

## 风险清单

| # | 级别 | 风险 | 依据 / 建议 |
| --- | --- | --- | --- |
| R1 | 需修·低 | `README.md:295` 的 harness 计数（823）落后（实为 870） | §8 |
| R2 | 需修·低 | `package.json:4` 仍写 twenty-one 工具 | §8 |
| R3 | 存疑·低 | **天文面字符 id 的「覆盖」会失效**：校验用码点（`charCount = [...text].length`，`verdict.ts:356`），读回用 UTF-16 `truncate`（`util.ts:31-36`）。40 个 emoji 的 id 通过校验，但 `decisionHistoryOf` 读回截成 39 emoji + `…` → 同一 id 再写被当成新 id 追加。实测：第一次 1 条（存储 id 长度 80），第二次 **2 条**（`第一次`/`第二次` 并存） | 与 `blocked` 同一既有约定（校验码点 / 读取 UTF-16），非本次引入；但决策的后果是「同一决策两份答案」，正是该功能要消除的形态。建议后续统一（id 限 ASCII 白名单，或读取截断改用码点），本次不阻塞 |
| R4 | 说明·无 | 稀疏/手工记录的写入会被 `normalizeBroadcast` 补齐默认键（`scope`/`candidates`/`attempts`/`createdAt`…） | 所有 `writeBroadcast` 调用方的既有行为；真实记录已验证 `added/removed/changed` 全空 |
| R5 | 说明·无 | `confirm:false` 在「会超 20」时也直接抛拒绝，而不是给出预览 | 上限检查在 `decisions.ts:130` 早于 `decisions.ts:142` 的预览分支；与「校验失败即拒绝、不写」一致，只是预览拿不到条目 |
| R6 | nit | 校验先于权限：第三方可用「校验/记录不存在/拒绝写入」区分 bid 是否存在 | 仅泄露存在性，不含决策内容；与其它工具同一顺序，可接受 |
| R7 | nit | 设计文档 `design.md §6` 的回滚命令漏了 `src/tools/list.ts` | `docs/collab.md §11.19` 与 `impl-notes.md` 的回滚清单已含 `list`，仅任务内部文档不一致 |
| R8 | nit | M2 变异后 harness 以未捕获 `ValidationError` 中止（无汇总行） | 仍 `EXIT=1`，不影响「变异被抓到」；只是失败现场不够干净 |
| R9 | 说明·无 | `collab_decisions` 在 `allowWrite:false`（只读默认）下也能写记录 | 与 `collab_followup` 一致（只写插件自身记录、不写会话），未放宽任何会话级写权限 |

---

## 复现命令

```bash
cd /data/project/collab

# 必跑（EXIT=0，870 + 12 + 20 + 50 + 49 + 47 + 17）
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs

# 我的独立探针（假宿主 + 临时目录；28 条断言，含权限/上限/预览/注入/兼容）
node .trellis/tasks/11-19-collab-decisions/research/check-probes/probe.mjs ./dist/index.js new

# 改前构建的逐字比对（可选，需要可重建 HEAD）
git archive HEAD | tar -x -C /tmp/opencode/collab-baseline
ln -s /data/project/collab/node_modules /tmp/opencode/collab-baseline/node_modules
(cd /tmp/opencode/collab-baseline && npx --no-install vp pack && npx --no-install vp build -c vite.gui.config.ts && npx --no-install vp build -c vite.tui.config.ts)
node .trellis/tasks/11-19-collab-decisions/research/check-probes/probe.mjs /tmp/opencode/collab-baseline/dist/index.js baseline
# → facts.compat 的 statusPlain / statusFull / list / wakePlain 归一后逐字相同
```

变异（在副本里做，不碰工作树）：`cp -a` 工作树到 `/tmp/opencode/collab-mut` → 改 `src/core/verdict.ts` → `npx --no-install vp pack && node test/handoff-harness.mjs`；结果见 §7。
