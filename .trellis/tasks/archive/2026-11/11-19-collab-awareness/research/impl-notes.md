# 实现记录：协作自动感知（0.7.0）

> 任务：`.trellis/tasks/11-19-collab-awareness`（PRD R1–R5 / design §1–§6 / implement.md §1–§5）
> 日期：2026-11-19 · 版本号**未改**（0.7.0 由父任务统一）· 工具数仍 **20**

## 1. 改了什么（按文件）

| 文件 | 改动 |
| --- | --- |
| `src/core/awareness.ts`（新增） | 纯渲染 `awarenessText({n,m})` + `createAwareness({ctx,readConfig,listSessions,lineage?,now?})`：每会话 10min 缓存（`shownAt` / `listedAt`）、抑制条件、双计数、降级 |
| `src/hooks/context.ts` | 注入末尾追加感知行（**预算满则不调用**）；`injectInbox` 改为返回 `{text, shown, rest}` 以便算剩余预算；`markShown` 在 `event.system.push` 成功后才调用 |
| `src/core/verdict.ts` | 新增 `protocolHeader({bid,threadID,peer})`；`takeoverBody` 前两行改为协议头 |
| `src/core/chain.ts` | `injectionFor` 的「接管请求」块前插入同一协议头（peer 注入面） |
| `src/tools/handoff.ts` | thread 投递正文前插入协议头（`dispatch` 的 `text`），任务正文原样跟在后面 |
| `src/config.ts` / `src/constants.ts` / `src/types.ts` | `awareness: "line" \| "off"`（默认 `line`）+ `AWARENESS_TTL_MS` / `AWARENESS_LIST_LIMIT` |
| `src/index.ts` | `__internals` 导出 `awarenessText` / `AWARENESS_TTL_MS` / `AWARENESS_LIST_LIMIT`；setup 日志打印 `awareness=…` |
| `test/handoff-harness.mjs` | 新增 S99（15 项断言，见 §2） |
| `docs/collab.md` / `README.md` / `skills/collab/SKILL.md` / `CHANGELOG.md` | 文档（§11.15、配置行、skill「一点十一」、Unreleased 0.7.0 `### Added`） |

> 约束说明：`src/hooks/context.ts`（注入组装的真身，design 里称「`src/index.ts` context hook」）与
> `src/core/verdict.ts`（`takeoverBody` 与 `handoffActions` 所在，design 里称「`handoff.ts` / `broadcast.ts` 的
> dispatch 模板」）是 R1/R2 的落点；`src/types.ts` 只加一个配置字段类型。除此之外未动其它模块。

## 2. 注入行实测样例（假宿主，S99a）

会话页：同工作区 1 个根会话 + 1 个子会话 + 1 个已归档 + 其它工作区 3 个根会话。该会话**没有任何**未读 / 交接 / 挂起，
所以注入块只有这一行：

```text
协作：本工作区候选 1（collab_handoff） · 其它工作区候选 3（collab_broadcast，需提案）
```

单边为 0（`ses_s99_alone`，工作区只有自己）：

```text
协作：其它工作区候选 2（collab_broadcast，需提案）
```

两边都为 0（`ses_s99_zero`，会话页只有它自己）：**无注入块**（`blocks.length === 0`，不 push）。

## 3. 双计数口径 / 缓存命中计数

| 用例 | 期望 | 实测 |
| --- | --- | --- |
| 同工作区 1 + 其它 3 | 两半都有 | `本工作区候选 1 · 其它工作区候选 3` |
| 仅跨工作区 | 只有后半句 | `其它工作区候选 2` |
| 两边都 0 | 不注入 | 空 |
| 子会话 / 已归档 | 不计入 N | N=1（页里另有 2 条被排除） |
| 有自己发起的未闭环交接 | 不注入、**0 次列表页读取** | `line=false reads=0` |
| `[protected]` | 不注入 | 空 |
| `awareness:"off"` | 不注入 | 空 |
| 宿主列表抛错（无 `directory` 的 list 全失败） | 只写 N、不抛 | `协作：本工作区候选 1（collab_handoff）` |
| `maxInject:1` + 2 条未读 | 未读占满 → 本行让位 | `新消息 1 条 … 还有 1 条`，无 `协作：` |

缓存命中（S99a / S99c，假宿主计数 `list({limit:AWARENESS_LIST_LIMIT})` 且无 `directory` 的调用）：

| 时刻 | 注入 | 跨工作区列表页读取（累计） |
| --- | --- | --- |
| 第 1 次 `context`（N=1,M=3） | 有行 | 1 |
| 第 2 次 `context`（< 10min） | **无行** | 1（未再查） |
| N+M=0 的两次 `context` | 无行 / 无行 | 1（空结果也缓存 10min） |

## 4. 承接方协议头（S99i / S99j）

本工作区（`collab_handoff` 投递正文；envelope 前缀之后的第 1、2 行）：

```text
[collab:ses_s99_…_req][request:t_mwn2y1kp_2pxy] 你是承接方（bid=b_790b3e95dfd1ab82 / thread=t_mwn2y1kp_2pxy）
完成后回执：collab_reply { threadID:"t_mwn2y1kp_2pxy", confirm:true }；阻塞用 kind:"note" 说明缺什么。
S99 任务正文：请处理 X
```

跨工作区（peer 接管请求注入块）：

```text
你是承接方（bid=b_99999999999900e1）
完成后回执：[handoff] DONE|BLOCKED b_99999999999900e1 <摘要>（阻塞写清原因；不要只在会话里说“完成了”）。
- 接管请求 b_99999999999900e1：S99 peer 交接（提案 docs/issues/fix-s99.md，期望 implement，影响面 packages/x/src/y.ts） 发起方=ses_s99_preq → ① … ② … ③ …
```

`DONE|BLOCKED` 不会被回执解析误判：`HANDOFF_RECEIPT_RE` 要求 `DONE` 后紧跟空白（`|` 使其失配），
`verdictFromTexts` 又要求 `[handoff]` 的点名必须是**当前 bid** 且摘要位无 `<…>` 占位符（H1 规则）。

## 5. 变异验证（原始输出）

### 变异 1：把 `n+m >= 1` 收窄成 `n >= 1`（`awarenessText` 里加 `if (n < 1) return undefined`）

```text
  ✗ S99 N=0 keeps only the broadcast half (no 本工作区候选) — (缺失)
  ✗ S99 awarenessText omits a zero half and returns nothing when both are zero — 协作：本工作区候选 1（collab_handoff） · 其它工作区候选 3（collab_broadcast，需提案）
=== 748/750 checks passed
FAIL: S99 N=0 keeps only the broadcast half (no 本工作区候选)
FAIL: S99 awarenessText omits a zero half and returns nothing when both are zero
```

### 变异 2：去掉 10 分钟窗口（删 `shownAt` 去重的 early return，并让 `listedAt` 复用恒假）

```text
  ✗ S99 a second request inside 10min injects no line and reads no page — line=true reads=2
  ✗ S99 an empty count is cached too (the page is not re-read per request) — 2 page read(s)
=== 748/750 checks passed
FAIL: S99 a second request inside 10min injects no line and reads no page
FAIL: S99 an empty count is cached too (the page is not re-read per request)
```

两次变异后均已还原（`diff` 为空），回归恢复 `=== 750/750 checks passed`。

## 6. 回归 / 验收

```text
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

| 套件 | 结果 |
| --- | --- |
| 交接链 `test/handoff-harness.mjs` | **750/750**（735 → 750，新增 S99 的 15 项） |
| `readonly-default.mjs` | 12/12 |
| `board-shape.mjs` | 20/20 |
| `snapshot-shape.mjs` | 50/50 |
| `tui-render.mjs` | 49/49 |
| `gui-entry.mjs` | 47/47 |
| `gui-panel.mjs` | 17/17 |
| `scripts/check-skill.mjs` | `skills ok` |
| 工具注册数 | 20（S98 断言未变） |

## 7. 已知取舍

- **N/M 不排除 protected 候选**：design §1 的口径只排除「自己 / 子会话 / 已归档」，保护名单由
  `collab_handoff` 打分时再过滤；把 protected 排除在计数外会多一次逐会话血缘走查（N+M 次 `session.get`），
  与 R3 的成本上界不符。
- **`autoDeliver:false` 不影响本行**：R5 只给了 `awareness:"off"` 一个开关；两个开关语义独立
  （前者是未读摘要，后者是通道提示）。
- **抑制判定用 `from.sid === me` 且 state 非 `done/blocked/expired`**（design §2 的「非终态」按
  `BCAST_DONE_STATES` 理解）；`expired` 单由挂起提醒负责，不再叠加「该找谁」。
- **M 的列表页一次读全量**（`limit=200`）而不是 design 写的「逐个其它工作区 `list(directory, 20)`」：
  同口径、请求数更少，且能被假宿主按「无 directory + limit 200」精确计数（S99 的 1 次断言）。

---

# 复核修复轮（P2 + P3a + P3b）

> 依据：`research/check-report.md`（独立复核，未改动）。复核判「需修」：1 个 P2 + 2 个 P3。
> 本轮只改这三处 + 它们的断言/文档；版本号、工具数、依赖、`BUILTIN_PROTECT` 均未动。

## 8. P2：协议头给的回执命令闭不了环

**问题**（复核 §5）：第一版第二行是

```text
完成后回执：collab_reply { threadID:"t_…", confirm:true }；阻塞用 kind:"note" 说明缺什么。
```

三条都不成立：`text` 是 `collab_reply` 的必填参数（照抄 → `text 不能为空`）；`kind` 不在它的入参里，且显式
`note` 入站被当作「有意非回执」忽略；正文没有 `[handoff] DONE|BLOCKED <bid>` 行时记录**不会闭环**（停在
`acked`，要等 2h 的 `acked-stale` 兜底）。R2 的目的就是「承接方在读到正文前知道怎么回执」，所以这一行必须能用。

**现在**（`src/core/verdict.ts` 的 `protocolHeader`）：

```text
你是承接方（bid=b_… / thread=t_…）
完成后回执：collab_reply { threadID:"t_…", text:"[handoff] DONE b_… <摘要>", confirm:true }
阻塞回执：collab_reply { threadID:"t_…", text:"[handoff] BLOCKED b_… <缺什么>", confirm:true }
```

- `kind:"note"` 的说法整段删除；两条命令的 `text` 都自带 `[handoff]` 行（回执解析只认这行）。
- peer（无 thread / 跨 location 没有共享 thread）保持 `[handoff] DONE|BLOCKED b_… <摘要>`，并写明
  **「把这一行写进 `collab_send` 的 text」**；`peer && thread` 也不再宣传 `collab_reply`（跨 location 不可用）。
- 同步文档：`docs/collab.md` §11.15.2、`skills/collab/SKILL.md`「一点十一」、`CHANGELOG.md`（新增 `### Fixed`）。

**实测样例**（S99i，真实 `dist` + 假宿主）：

```text
--- S99 local hand-off prompt (first 3 lines)
[collab:ses_s99_…_req][request:t_…] 你是承接方（bid=b_e21144be1ee2a12a / thread=t_…）
完成后回执：collab_reply { threadID:"t_…", text:"[handoff] DONE b_e21144be1ee2a12a <摘要>", confirm:true }
阻塞回执：collab_reply { threadID:"t_…", text:"[handoff] BLOCKED b_e21144be1ee2a12a <缺什么>", confirm:true }
```

**新增/改写的断言（S99i，5 条）**——不再只看文案，而是**从协议头里取命令**执行：

| 断言 | 做法 | 实测 |
| --- | --- | --- |
| line 2 = 可复制的 `collab_reply` + `text` 带 `[handoff]` | 子串匹配完整命令（含 bid/thread）+ 在正文之前 | ✓ |
| line 3 = BLOCKED 变体，且无 `kind:"note"` | 子串匹配 + 全文不得出现 `kind:"note"` | ✓ |
| **照协议头回执 → `done`** | 从 line 2 取 `threadID`/`text`（只替换 `<摘要>`）→ `collab_reply` → 把投递原文作为入站事件喂回发起方 | `state=done` |
| **BLOCKED 变体 → `blocked`** | 同上，取 line 3（`<缺什么>` → 真实原因） | `state=blocked` |
| header 首行（bid / thread） | 不变 | ✓ |

## 9. P3a：成本口径（文档）

实现没改（保留 N 页 + M 页，这是「宿主列表抛错 → 只写 N」的前提）。文档与断言改成与实现一致：

- `docs/collab.md` §11.15.1：**每窗口 2 页**（带 `directory` 的本工作区页 + 全局页，各一次）；补
  「`AWARENESS_LIST_LIMIT=200`，宿主会话更多时 M 是下界」。
- `skills/collab/SKILL.md`：同一口径。
- 新增 S99 断言 `S99 one window reads 2 pages: one workspace page (N) + one global page (M)`
  （假宿主计数：`workspace=1 global=1`），让文档口径也有回归锚点。

## 10. P3b：无 `ctx.location.directory` 时重复计数

**问题**（复核风险 #4）：`directory === undefined` 时 `listSessions({directory: undefined})` 退化成全局页，
于是同一批会话同时进 N 与 M（实测 `本工作区候选 2 · 其它工作区候选 2`）。

**修法**（`src/core/awareness.ts` `counts()`）：`workspace` 缺失时不读 N 页、`n = 0`，只算全局页的 M。
没有 workspace 就没有「本工作区」这个概念，M 里的 `dir === workspace` 判定自然不命中任何会话。

**新增断言（S99l，2 条）**：

```text
--- S99 no workspace
  ✓ S99 without a workspace the same sessions are not counted twice (N=0, only M) — 协作：其它工作区候选 2（collab_broadcast，需提案）
  ✓ S99 … and it costs the global page only (no workspace page to read) — 1 global page read(s)
```

## 11. 变异验证（本轮新增两组，原始输出）

### 变异 A：`protocolHeader` 改回缺 `text` 的旧文案

```text
  ✗ S99 … line 2 is a copy-pasteable collab_reply whose text carries the [handoff] line — 完成后回执：collab_reply { threadID:"t_mwn3kpwv_6iid", confirm:true }；阻塞用 kind:"note" 说明缺什么。
  ✗ S99 … line 3 is the BLOCKED variant, and no dead kind:"note" survives
  ✗ S99 following the header command really closes the hand-off (state=done) — state=acked / reply=ERR: text 不能为空
  ✗ S99 the BLOCKED variant closes the next hand-off as blocked — state=acked
=== 752/756 checks passed
FAIL: S99 … line 2 is a copy-pasteable collab_reply whose text carries the [handoff] line
FAIL: S99 … line 3 is the BLOCKED variant, and no dead kind:"note" survives
FAIL: S99 following the header command really closes the hand-off (state=done)
FAIL: S99 the BLOCKED variant closes the next hand-off as blocked
```

注意第 3 条：断言是**执行**协议头里的命令，不是自己拼一条能用的——所以文案退化会真的把状态留在 `acked`。

### 变异 B：无 workspace 分支改回「两边都算」

```text
  ✗ S99 without a workspace the same sessions are not counted twice (N=0, only M) — 协作：本工作区候选 2（collab_handoff） · 其它工作区候选 2（collab_broadcast，需提案）
  ✗ S99 … and it costs the global page only (no workspace page to read) — 2 global page read(s)
=== 754/756 checks passed
FAIL: S99 without a workspace the same sessions are not counted twice (N=0, only M)
FAIL: S99 … and it costs the global page only (no workspace page to read)
```

复现的正是复核报告里的 `本工作区候选 2 · 其它工作区候选 2`。两次变异后均已还原（`diff` 为空）。

## 12. 修复后门禁

```text
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

| 套件 | 结果 |
| --- | --- |
| 交接链 | **756/756**（750 → 756：+2 页形状、+line3 BLOCKED、+done、+blocked、+无 workspace ×2；原「second line startsWith」由两条更精确的断言取代） |
| `readonly-default` / `board-shape` / `snapshot-shape` | 12/12 · 20/20 · 50/50 |
| `tui-render` / `gui-entry` / `gui-panel` | 49/49 · 47/47 · 17/17 |
| `scripts/check-skill.mjs` | `skills ok` |
| 工具数 / 版本 | 20 / `0.6.0`（未改） |
