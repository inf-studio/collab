# 复核报告：协作自动感知（11-19-collab-awareness）

> 角色：独立复核（冷上下文，只审不改）。实现方 `research/impl-notes.md` 仅作线索，所有结论均以自建探针 / 原始输出为准。
> 复核日期：2026-11-19 · 工作区 `/data/project/collab` · 未提交工作树（14 个文件：13 改 + `src/core/awareness.ts` 新增）

## 结论

> **增量复核（同日第二轮，见文末「## 增量复核（P2/P3 修复）」）：下面这 1 处 P2 与 2 处 P3 已全部修复并复核通过，
> 最终结论改为「可提交」。本节保留第一轮的原始判定与证据，便于对照。**

**需修（1 处功能缺陷 P2 + 2 处文档口径 P3）。** 其余 8 项全部通过，回归与变异均复现。

| # | 项目 | 结论 |
| --- | --- | --- |
| 1 | 双计数正确（N/M、单边省略、两边 0） | 通过 |
| 2 | 触发条件（off / protected / 未闭环 / N+M=0 / 10min） | 通过 |
| 3 | 预算让位（不挤掉交接 / 队列 / 未读行） | 通过 |
| 4 | 成本上界（10min 一次；抛错只写 N） | 通过 |
| 5 | 协议头（承接方 + 回执方式 + 正文原样） | **不通过（P2）** |
| 6 | 只读（不写记录 / 不投递 / 不建 thread） | 通过 |
| 7 | 回归与范围（750+…；20 工具；0.6.0；无新依赖） | 通过 |
| 8 | 测试真实性（2 组变异 + 15 条 S99） | 通过（有 1 条断言把错误文案固化，见 §5） |
| 9 | 文档（§11.15 / §11.4 / README / skill / CHANGELOG） | 通过（2 处口径不准，随 §5 一起改） |

**唯一的实质缺陷（P2）**：协议头第二行宣传的回执命令 **不能闭环这笔交接**。

```
完成后回执：collab_reply { threadID:"t_…", confirm:true }；阻塞用 kind:"note" 说明缺什么。
```

- `collab_reply` 的 `text` 是**必填**，照抄这行直接报错（`src/tools/reply.ts:43` required + `src/tools/shared.ts:428` `text 不能为空`）→ 探针 **P9d**。
- `kind` 不是 `collab_reply` 的参数（`src/tools/reply.ts:27-44`，`jsonInput` 只有 threadID/text/bid/confirm），且 `kind:"note"` 在入站被当作**显式非回执**忽略（`src/core/chain.ts:381-382`）→ 探针 **P9e**。
- 闭环只认正文里的 `[handoff] DONE|BLOCKED <bid|threadID> <摘要>`（`src/core/chain.ts:383` `parseReceiptLine`，只在 `src/index.ts:125` 的入站路径调用）。补上 `text` 但按协议头只写「已完成」→ 记录**停在 `acked`**（探针 **P9f**）；只有写 `[handoff] DONE <bid> …` 才闭环（探针 **P9g**）。
- 后果（非灾难，但是真实的记账退化）：`collab_handoff` 重试显示「已存在同一交接（state=acked）」而非「已闭环」；看板 / `collab_list` 一直 open；发起方自己的感知行被 `hasOpenHandoff` 抑制；直到 **2 小时**后 `acked-stale` / `ACKED_EXTRACT_MS` 走「只读提取最后一条回答」兜底（`src/constants.ts:113`、`src/core/stale.ts:31`）。
- 同一消息里的 ①②③ 步骤仍写着能闭环的 `collab_send {text:"[handoff] DONE <bid> <摘要>"}`（`src/core/verdict.ts:376-377`），所以不是死路——但**最显眼的第一二行给了走不通的命令**，而 R2 的全部目的就是「让承接方知道怎么回执」。
- 与项目协议真源不一致（**本工作区**面）：`.trellis/spec/guides/cross-workspace-collab-guide.md:103`（§5.2 的 ② 回执）把回执固定为 `collab_send {text:"[handoff] DONE <bid> <摘要>", confirm:true}`。peer 面不受影响：peer 记录目前**不带** `threadID`（`src/tools/broadcast.ts:275-300`、`:360-380`），协议头第二行只有 `[handoff] DONE|BLOCKED <bid>`，是正确的；同文件 `:29` 说的「跨 location `collab_reply {threadID}` 必报错」只是说明不能把本工作区的做法搬到 peer 面。

> 另一条等价路线：让 `collab_reply` 的 `bid` 真正闭环（`src/tools/reply.ts:31-36` 的字段描述已经承诺「the `b_…` hand-off this reply closes」，但代码只把它用于 protected 白名单，`applyReceipt` 只解析正文）。那条路要改 `applyReceipt` 的调用契约，风险比改文案大，不建议在本任务做。

最小修复（建议，未落地）：把 `protocolHeader` 的第二行改成可执行且能闭环的形式，例如
`完成后回执：collab_reply { threadID:"t_…", text:"[handoff] DONE <bid> <摘要>", confirm:true }；阻塞把 DONE 改成 BLOCKED、摘要写清原因。`（`[handoff]` 行的 target 也接受 threadID，见 `src/core/verdict.ts:64-73`），并同步 docs / skill / CHANGELOG 与 S99 断言、补一条「按协议头回执后 `state === 'done'`」的断言。

---

## 0. 必跑命令（原始输出）

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
build exit=0
typecheck exit=0        # $ tsc --noEmit
=== 750/750 checks passed
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

与要求的目标 `750 + 12 + 20 + 50 + 49 + 47 + 17` **逐项一致**。

---

## 1. 双计数正确 —— 通过

**代码**：`src/core/awareness.ts:95-119`（N/M）、`:23-31`（文案）、`:34-38`（countable=根会话+未归档）；`src/hooks/context.ts:273`（末尾追加）。

**自建探针**（`/tmp/opencode/aw-probe.mjs`，自建假宿主 3 个工作区 + 子会话 + 已归档；不使用项目 harness）：

```
PASS  P1 N=1 (mate; child+archived excluded), M=5 (3 in W2 + 2 in W3)  [协作：本工作区候选 1（collab_handoff） · 其它工作区候选 5（collab_broadcast，需提案）]
PASS  P2 N=0 keeps only the broadcast half  [协作：其它工作区候选 7（collab_broadcast，需提案）]
PASS  P3 N+M=0 → no block at all  [0 block(s)]
PASS  P6 awarenessText: both halves / single half / undefined
```

- N：页里另有一条子会话（`parentID`）与一条 `time.archived` → 均不计入 → N=1（根因 `:34-38`）。
- M：W2 三条 + W3 两条 = 5，`dir === workspace` 与 `id === sessionID` 均跳过（`:108-113`）。
- 单边 0 省略半句、两边 0 返回 `undefined`（`:23-31`），探针与 S99b/S99c/S99k 一致。

## 2. 触发条件 —— 通过

```
PASS  P4a awareness:"off" → no line
PASS  P4b protected and protected-child → no line  [prot=false child=false]
PASS  P4c own unfinished hand-off → no line and no list page  [line=false reads=0]
PASS  P4d a done record no longer suppresses the hint
PASS  P5a 9 minutes later: still suppressed  [first=true second=false]
PASS  P5b 10 minutes + 1ms later: line again
```

- `off` 只认精确字符串，写法见 `src/config.ts:116-120`（错拼回落 `line`，不会静默丢功能）。
- protected 走 `createLineage(ctx).protectedAncestor`（`src/core/awareness.ts:134-138`），血缘（protected 的子会话）同样命中。
- 「自己有未闭环交接」= `from.sid === me` 且 state ∉ `done/blocked/expired`（`:87-93` + `src/constants.ts:134`）；命中时**连列表页都不读**（P4c reads=0）。
- 10 分钟窗口在 `line()` 的最前面（`:129`），`markShown` 只在 `event.system.push` 之后调用（`src/hooks/context.ts:285`）——与 F1 规则一致；未 push 成功会重试（P5d）。

## 3. 预算让位 —— 通过

```
PASS  P7  maxInject=1 + unread → unread keeps its slot, awareness drops
PASS  P7b budget full + chain line: hand-off line kept, awareness absent
      [[collab] 新消息 1 条 | … | [collab-handoff] 交接链路提醒（每条只出现一次）: | - 群组广播 b_…：…]
```

预算口径 `budget = readConfig().maxInject - inboxPart.shown`（`src/hooks/context.ts:264`），`budget <= 0` 时**根本不调用** `awareness.line()`（`:266`，连缓存/宿主都不碰）。感知行永远排在最后（`:273`），交接 / 队列 / 未读行都在它之前入 `blocks`。

## 4. 成本上界 —— 通过

```
PASS  P1 cross-workspace page read once for that line  [1]
PASS  P1b second context inside 10min: no line, no page re-read  [line=false reads=1]
PASS  P5c one page (N+M share one read) per window  [4 list call(s) (2 per refresh × 2 refreshes)]
PASS  P8 host list throws → N only, no throw  [协作：本工作区候选 1（collab_handoff）]
```

- 跨工作区一览页（无 `directory` 的 `list({limit:200})`）每会话每 10 分钟**恰好 1 次**（`listedAt`，`:142-151`）；空结果同样缓存（P3/S99c 的 reads=1）。
- 宿主抛错：`counts` 内层 try/catch → `m = undefined`（`:104-117`），`awarenessText` 只渲染 N（`:28`），`context` 另有一层 try/catch（`src/hooks/context.ts:267-271`），不影响其它注入（P8 中 N 行正常出现、无异常）。
- 注意：每个窗口实际是 **2 次** `session.list`（N 用带 `directory` 的页、M 用全局页，P5c=4/2 刷新）——文档口径见 §9。

## 5. 协议头 —— **不通过（P2）**

**本工作区部分通过**：

```
PASS  P9a local delivery line1 = claimant header  [[collab:…_req][request:t_…] 你是承接方（bid=b_… / thread=t_…）]
PASS  P9b local delivery line2 = collab_reply command
PASS  P9c body preserved verbatim (first body line intact)
PASS  P9h peer block: header + [handoff] DONE|BLOCKED <bid> on line 2
```

- 首两行固定、peer 追加 `[handoff] DONE|BLOCKED <bid>`（`src/core/verdict.ts:247-277`）、正文原样跟随（`src/tools/handoff.ts:168-176`）。
- 覆盖三处投递面：`collab_handoff` 投递正文、peer 接管注入块（`src/core/chain.ts:1010-1028`）、`takeoverBody`（spawn/叫醒/重发，`src/core/verdict.ts:294-296`）。
- 唯一形态差异：`handoff` 投递在协议头与正文之间插了一个空行（`src/tools/handoff.ts:173`），正文本身未被改写。

**不通过的是「回执方式」这一半**（证据见文首）：

```
PASS  P9d the advertised command shape (threadID+confirm, no text) is rejected  [text 不能为空]
PASS  P9e kind:"note" is silently accepted by collab_reply and still does not close as blocked  [state=acked]
PASS  P9f a plain-text collab_reply (the header's instruction) does NOT close the hand-off  [reply=true state=acked]
PASS  P9g only a [handoff] DONE <bid> line closes it  [state=done]
```

（这里 PASS 的是「探针成功证明了某个事实」，不是「实现正确」。）P9d/P9e/P9f 三条共同说明：按协议头去做 → 要么直接报错，要么投出去但交接不闭环。因为 R2 的全部目的就是「承接方在读到任务正文**之前**就知道怎么回执」，这一行必须给能用的命令。

固定了错误文案的断言：`test/handoff-harness.mjs:9591-9602`（S99i 只断言 `startsWith('完成后回执：collab_reply { threadID:"t_')`），以及 `:9649-9658`（S99j）。它们验证了「文案长这样」，但没有一条验证「照它回执后 `state` 变化」——所以缺陷没被测试抓住。

## 6. 只读 —— 通过

```
PASS  P10 awareness line writes nothing (dir hash + storage keys unchanged, zero write calls)
      [err=- hashSame=true keysSame=true writeCalls=0 line=true]
```

- 探针把 `ctx.storage.set/remove`、`session.create/update/remove/prompt` 全部改成「一调用就抛」，并把临时根目录（broadcast / locks / grants / owner-queue / reports / config）做 sha256 快照：调用前后**逐字节相同**，写方法调用数 0，而感知行照常出现。
- 静态：`createAwareness` 只做 `readConfig` / `allBroadcasts`（读目录）/ `lineage.protectedAncestor`（`session.get|list`）/ `listSessions`；唯一「副作用」是进程内 `Map`（`src/core/awareness.ts:74,150,161-167`）。`protocolHeader` 是纯函数（`src/core/verdict.ts:247-277`）。
- 协议头本身不写记录：`collab_handoff` 写记录是工具本职（`src/tools/handoff.ts:188`），与本行无关。

## 7. 回归与范围 —— 通过

- `pnpm build` / `pnpm typecheck` / `pnpm test` / `check-skill` 全绿，计数逐项吻合（§0）。
- 工具数：运行时注册 **20**（自建假宿主 `tools.length === 20`，S98 断言未动）。
- 版本：`package.json` 0.6.0、`PLUGIN_VERSION = '0.6.0'`（`src/constants.ts:380`），`git diff -- package.json` 为空。
- 无新依赖：`package.json` / `pnpm-lock.yaml` 均未改动。
- 改动面与派单一致：`git status --short` = 13 M + 1 new（`src/core/awareness.ts`）+ 任务目录（untracked），无越界文件。
- `src/hooks/context.ts` **本来就在**：`git log -- src/hooks/context.ts` 显示它自 0.1.6（`1d3e9d3 feat(collab): 送达应答…`）起就在，此后 0.3.1 / 0.4.0 持续修改；HEAD 259 行 → 现在 292 行 → 是正常修改，不是为本次临时拆文件。
- `src/core/verdict.ts` 同理（`takeoverBody` / `handoffActions` 原就在此），新增 `protocolHeader` 放在这里是合理的单一真源。

## 8. 测试真实性 —— 通过（附 1 条覆盖缺口）

**15 条 S99 均为真实断言**（`grep -c "✓ S99"` = 15）：S99a(3) b(1) c(2) d(1) e(1) f(1) g(1) h(1) i(2) j(1) k(1)。其中 14 条走真实插件（真实 `dist` + 假宿主 + 真实临时 `COLLAB_BROADCAST_DIR`），只有 S99k 是纯函数单测；计数类用例每个都换掉会话页（避免「>0 就算过」）。

**既有断言未弱化**：`git diff -- test/handoff-harness.mjs | grep '^-'` = **0 行**（纯追加）。

**变异 1**（`n+m>=1` → `n>=1`；在 `/tmp` 的 dist 副本上做，未动工作区源码）：

```
  ✗ S99 N=0 keeps only the broadcast half (no 本工作区候选) — (缺失)
  ✗ S99 awarenessText omits a zero half and returns nothing when both are zero — 协作：本工作区候选 1（collab_handoff） · 其它工作区候选 3（collab_broadcast，需提案）
=== 748/750 checks passed
```

**变异 2**（去掉 10 分钟窗口：`shownAt` 早退 + `listedAt` 复用）：

```
  ✗ S99 a second request inside 10min injects no line and reads no page — line=true reads=2
  ✗ S99 an empty count is cached too (the page is not re-read per request) — 2 page read(s)
=== 748/750 checks passed
```

两次均在 `/tmp/opencode/mut` 的 dist 副本上做，还原后 `=== 750/750 checks passed`（工作区源码全程未改）。与 `impl-notes.md §5` 的输出逐字一致。

**覆盖缺口（随 P2 一起补）**：S99i/S99j 只断言文案前缀，锁定了一条不能闭环的命令；没有「承接方按协议头回执 → `state` 变 done/blocked」的断言。

## 9. 文档 —— 通过（2 处口径需随修复一起改）

一致性核对：

| 位置 | 与实现 |
| --- | --- |
| `docs/collab.md:1281-1341`（§11.15，双计数 / 抑制 / 成本 / 协议头 / 验收 / 回滚） | 与 `awareness.ts` 一致（N/M 口径、10min、`AWARENESS_LIST_LIMIT=200`、抑制三条、预算让位） |
| `docs/collab.md:302-305`（§11.3 hook 段）、`:336-341`（§11.4 `awareness` 配置） | 一致；「默认 `line`、`"off"` 关闭」写明 |
| `README.md:44-47`（hook 段）、`:216`（配置样例）、`:233`（配置表）、`:46`「受保护会话拿不到这一行」 | 一致 |
| `skills/collab/SKILL.md:205-228`（「一点十一」）、`:217`、`:223` | 一致；「默认开 / 关闭方式 / 不出现的三种情况」写明 |
| `CHANGELOG.md:7-30`（Unreleased 0.7.0 `### Added`） | 版本标题已是 0.7.0；「735 → 750」「工具仍 20」与实际一致 |

两个需要改的口径：

1. **回执命令**（与 §5 同一处缺陷）：`docs/collab.md:1314`、`skills/collab/SKILL.md:223`、`CHANGELOG.md:27` 都复制了 `collab_reply { threadID, confirm:true }` / `kind:"note"`。修 `protocolHeader` 时必须同步这三处，否则文档教的是走不通的命令。
2. **成本口径**：`docs/collab.md:1301`「会话列表页每 10 分钟最多一份」、`skills/collab/SKILL.md:217`「会话列表页每 10 分钟最多读一份」与实测不符——每个窗口是 **2 次** `session.list`（N 的带 `directory` 页 + M 的全局页；P5c = 4 calls / 2 窗口）。`CHANGELOG.md` 的措辞（「`listedAt` 让『其它工作区』页也只读一次」）是准确的。建议改成「跨工作区一览页每 10 分钟最多一份（另有一次同工作区页）」。

---

## 风险清单（按严重度）

| # | 级别 | 风险 | 证据 / 位置 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | **P2** | 协议头宣传的回执命令不能闭环（缺 `text`、`kind:"note"` 无效、正文无 `[handoff] DONE <bid>`） | 探针 P9d/e/f/g；`src/tools/reply.ts:27-44`、`src/tools/shared.ts:428`、`src/core/chain.ts:381-383`、`src/index.ts:125` | 改 `protocolHeader` 第二行；补「回执后 state=done」断言；同步 3 处文档 |
| 2 | P3 | 「会话列表页每 10 分钟最多一份」不准确（实为 2 页/窗口） | `docs/collab.md:1301`、`skills/collab/SKILL.md:217`；P5c | 改文案（M 页 1 份 + N 页 1 份） |
| 3 | P3 | M 用单页 `limit=200`：宿主会话数 >200 时 M **静默少计**（design 原写「逐目录 list(20)」） | `src/core/awareness.ts:105`、`src/constants.ts:31`；`impl-notes.md §7` 已声明取舍 | 可接受；在 §11.15.1 注明「>200 会话时 M 为下界」，或按目录分页 |
| 4 | P3 | `ctx.location.directory` 缺失时，N 与 M **同时**统计全局页（实测：`ctx:{}` + 3 会话 → `协作：本工作区候选 2（collab_handoff） · 其它工作区候选 2（collab_broadcast，需提案）`） | `src/core/awareness.ts:95-113`（`directory: undefined` → 全局页；M 循环 `dir === workspace` 恒假） | 加一行 `if (!workspace) return { n: 0, m: undefined }`（或只渲染 M） |
| 5 | P3 | 无 `location` 的会话被 `chain.listSessions` 当作「本工作区」（`dir === undefined || dir === directory`）→ 抬 N、漏 M | `src/core/chain.ts:300-303`（0.x 既有口径） | 不必改；知悉即可 |
| 6 | P3 | 协议头把 `~120` 字塞进 inbox 摘要行，200 字上限里留给任务正文的只剩约 70 字（投递 prompt 本身不受影响） | `src/hooks/context.ts:159`（`truncate(message.text)`，`INJECT_CHARS=200`） | 可接受；若在意可对 inbox 摘要先剥协议头 |
| 7 | P3 | 感知缓存 `Map<sessionID>` 永不清理（长驻进程 + 大量会话时缓慢增长） | `src/core/awareness.ts:74` | 可接受（PRD 就是进程内缓存）；如需可顺手按 TTL 清理 |
| 8 | P4 | peer 注入**块**的第一行仍是 `[collab-handoff] 交接链路提醒…`，协议头是块内第 1 条而非块首 | `src/core/chain.ts:1010-1028`、`src/hooks/context.ts:235` | design §3「注入块首行」字面 ≈ 未达成；但 `takeoverBody` 的投递文本首行确为协议头，判为可接受，建议文档措辞写「每条接管请求的前两行」 |
| 9 | P4 | `hasOpenHandoff` 的口径是 `from.sid = me`（design §2.3），比 PRD R1 的「当前会话没有未闭环交接」窄：作为**承接方**（`claim.by = me`，open/acked）时仍会出感知行 | `src/core/awareness.ts:87-93` | 与 design 一致，判为通过；如需严格按 PRD 再加一个 `claim.by === me` 条件 |
| 10 | P4 | 未闭环交接一直不闭环（风险 1）→ 发起方自己的感知行被持续抑制至多 2h | `src/constants.ts:113`、`src/core/stale.ts:31` | 随风险 1 一起消失 |

## 复核方法（可复现）

```bash
# 必跑
cd /data/project/collab && pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs

# 自建探针（自建假宿主；不读项目 harness、不碰真实会话）
node /tmp/opencode/aw-probe.mjs            # === probe: 26/26 passed

# 变异（在 /tmp 的 dist 副本上做，工作区源码未改）
cd /tmp/opencode/mut && node test/handoff-harness.mjs   # 750/750 基线
```

> 说明：`aw-probe.mjs` 的 26 条断言与项目 S99 的 15 条是**两套独立夹具**（工作区数量、会话命名、时钟注入方式都不同），结论互不依赖；S99 里没有的自建覆盖包括：10 分钟边界的毫秒级（9min vs 10min+1ms）、「未标记 shown 会重试且不重复读页」、以及「协议头回执是否真闭环」。

---

# 增量复核（P2/P3 修复）

> 第二轮 · 2026-11-19 · 同一工作树仍未提交。作者已改 `src/core/verdict.ts`、`src/core/awareness.ts`、
> `test/handoff-harness.mjs`、`docs/collab.md`、`skills/collab/SKILL.md`、`CHANGELOG.md`（下 §6 有逐文件 delta 证明）。
> 本轮仍是「只审不改、不 commit/push」；变异在 `/tmp` 的 dist 副本上做，工作区源码全程未改。

## 结论：**可提交**

| # | 必查项 | 结论 |
| --- | --- | --- |
| 1 | 真闭环：只按协议头命令执行 → `done` / `blocked` | 通过（探针 Q1–Q4） |
| 2 | peer 分支：不宣传 `collab_reply`，按 `collab_send` + `[handoff]` 能闭环 | 通过（Q6–Q8） |
| 3 | P3b：无 `workspace` → 只有 M、不重复计数 | 通过（Q9–Q10） |
| 4 | P3a：每窗口 2 页，文档与实现同口径 | 通过（Q11 + 文档 grep） |
| 5 | 变异 2 组按预期失败并还原 | 通过（见 §5 原始输出） |
| 6 | 回归 756+12+20+50+49+47+17、20 工具、0.6.0、无新依赖、改动面 | 通过（见 §6） |

第一轮的 P2 / P3a / P3b 全部闭合：P2 不再是「文案像回执」，而是**照抄即可闭环**（done 与 blocked 双场景各有端到端断言）；
P3a 的文档口径与实测读取次数一致；P3b 的重复计数已消除。剩余只有 4 条 P4 备注（§7），不阻塞提交。

## 1. 真闭环（逐字符照抄协议头命令）—— 通过

自建探针 `/tmp/opencode/aw-probe2.mjs`（与项目 harness 完全独立的夹具）：**从投递文本里取协议头那一行**，
只用正则取出 `threadID:"…"` / `text:"…"` 两个参数，仅把 `<摘要>` / `<缺什么>` 换成真实摘要，其余逐字符照发。

```
PASS  Q1 header line2 = copy-pasteable DONE command with [handoff] + real bid/thread
      [完成后回执：collab_reply { threadID:"t_mwn3tw7c_rtzf", text:"[handoff] DONE b_e9ac3674190fc508 <摘要>", confirm:true }]
PASS  Q2 header line3 = copy-pasteable BLOCKED command
      [阻塞回执：collab_reply { threadID:"t_mwn3tw7c_rtzf", text:"[handoff] BLOCKED b_e9ac3674190fc508 <缺什么>", confirm:true }]
PASS  Q2b no dead kind:"note" in the prompt
[collab] handoff b_e9ac3674190fc508 → done
PASS  Q3 verbatim DONE command closes the hand-off (state=done)  [state=done err=]
[collab] handoff b_e1a60b951a0a97d4 → blocked
PASS  Q4 verbatim BLOCKED command closes as blocked  [state=blocked err=]
PASS  Q5 sanity: a [handoff]-less reply still leaves it acked (why text matters)  [state=acked]
```

- 不需要任何额外参数：`collab_reply` 只收到 `threadID` / `text` / `confirm` 三个键，与协议头逐字一致；
  `text` 里的 `[handoff] DONE|BLOCKED <bid>` 就是 `applyReceipt → parseReceiptLine` 认的收据（`src/core/chain.ts:383`）。
- BLOCKED 走的是**另一笔**交接（不同 bid），所以 done / blocked 两条互不借用状态。
- Q5 是反证：把 `text` 换成「已完成」（旧形状）仍停在 `acked`——说明闭环来自 `[handoff]` 行，而不是「发了 reply」这件事本身。
- 代码位置：`src/core/verdict.ts:256-286`（`protocolHeader`；本地分支 `:271-277` 给两行命令，peer 分支 `:278-283`，兜底 `:284`），删除了 `kind:"note"`。

## 2. peer 分支 —— 通过

```
PASS  Q6 peer header advertises only [handoff] via collab_send (no collab_reply)
      [你是承接方（bid=b_aaaaaaaaaaaaaaa9） | 完成后回执：[handoff] DONE|BLOCKED b_aaaaaaaaaaaaaaa9 <摘要>（把这一行写进 collab_send 的 text 发给发起方，confirm:true；阻塞写清缺什么，不要只在会话里说“完成了”）。]
PASS  Q7 peer accept succeeds  [已领取 b_aaaaaaaaaaaaaaa9（winner，token=k_mwn3typq_wsf1，state=acked，lease=300000ms）]
[collab] handoff b_aaaaaaaaaaaaaaa9 → done
PASS  Q8 peer receipt written into collab_send text closes it (state=done)  [state=done]
```

- peer 且无 thread（`src/core/verdict.ts:278-283`）只给 `[handoff] DONE|BLOCKED <bid>`，并明说「写进 `collab_send` 的 text」；
  prompt 里**不再出现** `collab_reply`（Q6 同时断言了 `includes('collab_send')` 与 `!includes('collab_reply')`）。
- 按它执行确实能闭环：`collab_accept`（① 领取，`claim.by = 我`）→ `collab_send {target:发起方, text:"[handoff] DONE <bid> …"}`
  （不给 `kind`，走 `send.ts:147-175` 的遗留回执升级，delivered kind 被改成 `reply`）→ 记录 `done`。
- 顺带确认：`record.claim.by === sender` 是前提（`src/tools/shared.ts:129`），所以「不领取直接回执」不会闭环——协议头后面的 ① 领取不能省
  （`design.md` §3 与 `docs/collab.md:1330-1334` 都写「①②③ 步骤不变」）。

## 3. P3b（无 `workspace` 不重复计数）—— 通过

```
PASS  Q9 no workspace: only the broadcast half (no 本工作区候选, no double count)
      [协作：其它工作区候选 2（collab_broadcast，需提案）]
PASS  Q10 … and no workspace page is read (global page only)  [global=1 workspace=0]
```

- 夹具：3 个会话分处 3 个工作区，`ctx.location.directory = undefined`。修复后不再读 N 页（`workspace===0`），
  全局页只读 1 次，文案只有后半句；第一轮的 `本工作区候选 2 · 其它工作区候选 2` 不再出现。
- 代码：`src/core/awareness.ts:96-105`（`let n = 0; if (workspace) {…}`）。

## 4. P3a（每窗口 2 页）—— 通过

```
PASS  Q11 one window reads exactly 2 pages (1 workspace + 1 global), and the line is correct
      [1w+1g | 协作：本工作区候选 1（collab_handoff） · 其它工作区候选 2（collab_broadcast，需提案）]
```

文档已同步为同一口径：

```
docs/collab.md:1301  | 成本 | 每窗口 **2 页**：一页带 `directory` 数本工作区（N）+ 一页全局数其它工作区（M），各一次；…
skills/collab/SKILL.md:217 | …每个 10 分钟窗口只查 **2 页**（一页本工作区数 N、一页全局数 M）；…
CHANGELOG.md          | 每窗口 2 页（一页带 `directory` 数 N、一页全局数 M，`listedAt` 让两者都只读一次）
```

harness 侧新增断言 `S99 one window reads 2 pages: one workspace page (N) + one global page (M)`（`test/handoff-harness.mjs:9365-9370`），
与我的 Q11 口径一致；`AWARENESS_LIST_LIMIT=200 → M 为下界`也写进了 §11.15.1 表格。

## 5. 变异（原始输出）

在 `/tmp/opencode/mut2`（本轮构建的 dist 副本；工作区源码未改）上做，基线 `=== 756/756 checks passed`。

**变异 A：`protocolHeader` 退回缺 `text` 的旧文案**

```
  ✗ S99 … line 3 is the BLOCKED variant, and no dead kind:"note" survives
  ✗ S99 following the header command really closes the hand-off (state=done) — state=acked / reply=ERR: text 不能为空
  ✗ S99 the BLOCKED variant closes the next hand-off as blocked — state=acked
=== 752/756 checks passed
FAIL: S99 … line 2 is a copy-pasteable collab_reply whose text carries the [handoff] line
FAIL: S99 … line 3 is the BLOCKED variant, and no dead kind:"note" survives
FAIL: S99 following the header command really closes the hand-off (state=done)
FAIL: S99 the BLOCKED variant closes the next hand-off as blocked
```

**变异 B：无 workspace 分支退回「两边都算」**

```
  ✗ S99 without a workspace the same sessions are not counted twice (N=0, only M) — 协作：本工作区候选 2（collab_handoff） · 其它工作区候选 2（collab_broadcast，需提案）
  ✗ S99 … and it costs the global page only (no workspace page to read) — 2 global page read(s)
=== 754/756 checks passed
```

还原后 `=== 756/756 checks passed`（`/tmp/opencode/mut2` 上）。两组变异分别精确打掉「照抄闭环」和「不重复计数」，
说明新断言不是自证：文案一退化，端到端断言立刻红。

## 6. 回归、范围与测试真实性 —— 通过

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs   # exit=0
=== 756/756 checks passed
=== 12/12 checks passed
=== 20/20 board checks passed
=== 50/50 checks passed
=== 49/49 checks passed
=== 47/47 checks passed
=== 17/17 panel checks passed
skills ok
```

- **计数**：`756 + 12 + 20 + 50 + 49 + 47 + 17` 与派单目标逐项一致（第一轮 750 → 756，+6 = S99a 的「2 页」+1、S99i 的第 3 行文案 +1、S99i 的闭环断言 +2、S99l 的 +2；S99 段共 **21** 条）。
- **工具 / 版本 / 依赖**：运行时注册 **20**；`package.json` = `PLUGIN_VERSION` = **0.6.0**；`git diff --name-only -- package.json pnpm-lock.yaml` 为空。
- **改动面（用第一轮快照做逐文件 delta）**：

```
$ diff -rq /tmp/opencode/mut/src ./src
Files /tmp/opencode/mut/src/core/awareness.ts and ./src/core/awareness.ts differ
Files /tmp/opencode/mut/src/core/verdict.ts   and ./src/core/verdict.ts   differ
$ diff -q … docs/collab.md / skills/collab/SKILL.md / CHANGELOG.md / test/handoff-harness.mjs  → 4 个都 differ
$ diff -q … README.md → 相同；其余 11 个 src 文件 → 相同
```

  即本轮只动了派单允许的 6 个文件 + 任务目录，没有顺手改别的实现。
- **既有断言未弱化**：相对 HEAD，harness 仍是纯追加（`git diff | grep '^-'` = 0 行）。相对**第一轮快照**，本轮只在
  S99 段内改了 7 行：S99i/S99j 的旧文案断言被替换成更严的版本（第 2 行形状 + 新增第 3 行 + 闭环 ×2；peer 行追加
  `collab_send` 与「无 kind:"note"」），S99 段之外 0 改动（`diff -u` 的 hunk 全部 ≥ 第 9324 行）。
- S99i 现在**从协议头里取命令**（`s99CommandArgs` 用正则取 `threadID:"…"` / `text:"…"`，只换占位符），
  所以它锁定的不再是某段字面量，而是「协议头给出的东西必须能执行且闭环」。

## 7. 残留备注（P4，不阻塞）

| # | 备注 | 位置 |
| --- | --- | --- |
| 1 | **PRD R2 仍写「首行固定两行」**，实现与已更新的 `design.md` 是「最前面固定几行」（本地 3 行：身份 + DONE + BLOCKED）。建议父任务顺手把 PRD 的文字改成「固定前几行」，否则下一轮按 PRD 字面复核会再报一次。 | `prd.md` R2 vs `design.md` §3 |
| 2 | **pull 模式（受保护发起方）文案不一致**：协议头仍给 `collab_reply` 命令，而同一投递的 ①②③ 说「pull 模式写在自己最后一条回复里、不要尝试 collab_send」。属第一轮就有、本轮未扩大的既有问题（本轮未验证哪条在实际路径上被采用）。 | `src/core/verdict.ts:271-277` + `handoffActions` 的 pull 分支（`src/core/verdict.ts:369-383`） |
| 3 | 无 `workspace` 时 M 无法排除「与我同目录」的会话（会把它算进「其它工作区」），已知上限、比重复计数好；轨迹里 `ctx.location.directory` 实际总是存在。 | `src/core/awareness.ts:110-120` |
| 4 | 第一轮 §风险清单的 P4 项仍在（peer 块首行是块标题、inbox 摘要被协议头占位、M 为下界、无 `location` 会话计入 N）——均已在文档里写明或属既有口径。 | 见本文件「风险清单」 |

## 复核方法（本轮可复现）

```bash
cd /data/project/collab && pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
node /tmp/opencode/aw-probe2.mjs        # === probe2: 12/12 passed
cd /tmp/opencode/mut2 && node test/handoff-harness.mjs   # 756/756 基线（变异前/还原后）
```
