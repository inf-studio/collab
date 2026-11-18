# 独立复核报告：协作结束后自动归档 spawn 会话（0.5.0）

> **阅读顺序**：上半部分是**上一轮**（R-1 修复前）的复核结论；最新状态见文件末尾的
> 「增量复核（R-1 / bid）」一节——R-1 已修复并验证，回归为 **638 + 12 + 35 + 17**。

- 任务：`.trellis/tasks/11-18-collab-archive`
- 复核方式：冷上下文、只审不改（未 commit / 未 add / 未改任何实现文件；只读 `git`）
- 复核范围（未提交改动）：`src/core/archive.ts`（新）、`src/tools/archive.ts`（新）、
  `src/core/{chain,claim,snapshot}.ts`、`src/tools/{index,list}.ts`、`src/{rpc,config,constants,types,index}.ts`、
  `test/{handoff-harness,readonly-default,snapshot-shape}.mjs`、`package.json`、文档（README / docs/collab.md /
  skills/collab/SKILL.md / CHANGELOG）
- 独立复现工具（自写，未复用既有断言）：
  - `/tmp/opencode/s94-independent.mjs`：自建假 ctx（`session.update` 计数）、**注入式 gate**（记录每次 I/O）、
    自动路径 / 手动工具 / 配置 / 只读路径 —— **66/66 通过**
  - `/tmp/opencode/s94-http.mjs`：无 `session.update` 宿主 + mock HTTP 服务（200 / 500）—— **6/6 通过**
  - `/tmp/opencode/s94-receipt-race.mjs`：自动回执与归档同一 pass 的数据安全回归 —— **2/2 通过**
  - `/tmp/opencode/s94-accept-boundary.mjs`：spawn → accept 生命周期边界 —— 3 项中 2 通过（见 R-1）

## 结论

**代码可提交（未发现会破坏数据、破坏交接语义或误归档的实现缺陷）。**
八条门禁、失败隔离、幂等、手动工具、配置夹取、只读路径均按 PRD/design 工作；回归
`635 + 12 + 35 + 17` 与 `check-skill` 全绿。发现 1 个**边界功能缺口（待决策，不阻塞）**、
3 处**文档表述不准**（建议同批修正）、若干低风险观察。

---

## 逐项结论（10 项）

### 1. 八条门禁（非 spawn / 非终态 / 未到 10min / busy / protected / 有未决引用 / 有未读队列 / 已归档）——**通过**

实现：`src/core/archive.ts:85-146`（`shouldArchive`），顺序与 design §1 一致，且纯判定先于 I/O
（`sessionInfo` 只在 spawn/终态/时间戳/`archivedAt`/防抖之后才调用）。

自写 gate 复现（每条独立构造，记录 I/O 次数）：

| 反例 | 结果 | 依据 |
| --- | --- | --- |
| 非 spawn（`kind:"accept"` / 无 claim / 无 `claim.by`） | 不归档 | `archive.ts:95-99`；复现 A2/A2b/A2c |
| 非终态（open / claimed / acked） | 不归档 | `archive.ts:100-102`；A3 |
| 终态（done / blocked / expired） | 归档 | `archive.ts:100-102`；A3b |
| 未到防抖（30s < 10min） | 不归档，且 0 次 I/O | `archive.ts:106-115`；A4 |
| busy | 不归档 | `archive.ts:116-125`；A5 |
| 目标不可读 | 不归档 | `archive.ts:117`；A5b |
| protected（含血缘） | 不归档 | `archive.ts:126-128`；A6 |
| 有未决引用（`from.sid` / `claim.by`） | 不归档 | `archive.ts:129-139`；A7/A7b |
| 已终态的旧单引用 | **不**阻塞（正确） | A7c |
| 有未读 owner-queue 项 | 不归档 | `archive.ts:140-144`；A8 |
| 已归档（`archivedAt`） | 不归档，0 次 I/O | `archive.ts:103-105`；A9 |
| 宿主已归档但记录无戳 | 不发第二次 PATCH | `archive.ts:119-121`；A11 |
| 无时间戳 | 不归档 | `archive.ts:106-107`；A14 |

端到端（真实 plugin + context hook）：C2–C13 逐类反例均为 0 次 `archived` 写入，唯一合格样本恰好 1 次。

### 2. 归档 ≠ 删除（不改 state/receipt，只写 archivedAt）——**通过（代码）/ 文档绝对化表述不准确（见 R-2）**

- 归档写路径只有 `archiveSession`（`archive.ts:154-197`）→ `session.update({archived})` 或
  `PATCH /api/session/{id}`；`src/` 内**归档相关**无 `DELETE` / `session.remove`。
- `mergeArchive`（`src/core/claim.ts:352-358`）只增删 `archivedAt`，不碰 `state` / `receipt` / `followUps`。
- 复现：C3/C4（`state=done`、`receipt.note='closed'` 归档后不变）；E5（restore 后 `archived` 清零）。
- **注意**：仓内存在**既有**的 `ctx.session.remove`（spawn 落点校验失败时回滚刚建的会话，
  `src/tools/broadcast.ts:258`，0.4.0 引入，本次未改）。因此新增文档中的绝对化表述
  「插件从不调用 `DELETE /api/session/{id}`」与代码不符（见 R-2）。归档语义本身**不调用 DELETE**。

### 3. 失败隔离（update 抛错 / 403 / 404 / 无 host → 只 log，不抛、不改返回、不写 archivedAt）——**通过**

- `archive.ts:190-196`：所有异常收敛为 `{ok:false, reason}`；`archive.ts:213-216`：自动路径只 `log`。
- `src/core/chain.ts:588-601`：`refresh` 外层再包一层 try/catch（双保险），拒绝/失败都返回原记录。
- 手动工具 `src/tools/archive.ts:140-152`：失败返回可读「失败」文本，提前 return（不落 `archivedAt`）。
- 复现：B2（403）/B5（404）/B3（无 host 且无 URL）/B4（空 sid）均不抛；C1/C12（hook 不抛、无戳）；
  H4（HTTP 500：请求已发、不写戳、不抛）。原始日志：
  `[collab] archive ses_spawn_fail skipped (bid b_…09): session.update 失败：HTTP 403: refused`
  `[collab] archive ses_spawn_500 skipped (bid b_…02): PATCH /api/session/ses_spawn_500 → HTTP 500 {"error":"nope"}`

### 4. 幂等（重复刷新不重复 PATCH）——**通过**

- 判据：`archivedAt` 先于任何 I/O 检查（`archive.ts:103-105`）；宿主已归档同样不发第二次（`archive.ts:119-121`）。
- 手动工具：`already` 时只补写记录戳、不 PATCH（`tools/archive.ts:133-139`；restore 反向同理）。
- 复现：C14（连续两次 hook，PATCH 次数仍 1、戳不变）；E6（未归档时 restore 不再 PATCH）；H6。

### 5. 手动工具（bid→claim.by / session 直指 / 预览零写入 / restore / protected 拒绝 / 不受 grace 限制）——**通过**

- `bid` → `claim.by`，且与显式 `session` 冲突时拒绝（`tools/archive.ts:28-50`）；无 `claim.by` 时给出可读引导。
- `confirm:false` 只预览、零写入（`tools/archive.ts:115-130`）；`restore:true` → `archived:false` + 清戳
  （`tools/archive.ts:160-169` + `claim.ts:352-358`）。
- `[protected*]`（含血缘）一律拒绝且零写入（`tools/archive.ts:100-106`）。
- 手动路径**跳过**自动门（busy / 非 spawn / 防抖），与 design §4 一致。
- 复现：E1/E2（0 写入）、E3/E4（busy + accept 记录也能手动归档并落戳）、E5/E6（restore / no-op）、
  E7（protected 拒绝，0 次 PATCH）、E8（宿主拒绝可读）、E9/E10/E11（参数错误可读）、E12（30s 旧单手动归档成功）。
- 原始输出示例：`E7 :: 拒绝归档：ses_spawn_prot 本身在 protect 名单内（collab.json 的 protect + 内置硬名单）。未做任何修改。`

### 6. 配置（archiveSpawned 默认 true；archiveGraceMs 默认 600000，夹 1min–1h；false 只关自动）——**通过**

- `src/config.ts:74-90`（优先级 file > options > default；`clamp` 夹取）；`src/constants.ts:299-303`
  （`ARCHIVE_GRACE_MS=600000`、MIN=60000、MAX=3600000）；`DEFAULTS.archiveSpawned=true`（`constants.ts:57-61`）。
- 复现：F1（无配置文件：11min 旧单归档、30s 不归档 → 默认 true + 10min）、F2（`archiveGraceMs:1` 夹到 60s）、
  F3（`archiveGraceMs:1 周` 夹到 1h）、F4/F5（`archiveSpawned:false` 只关自动，手动仍可用）；
  A12/A13 为纯 gate 层的同结论。

### 7. 只读路径（collab_list / 快照不得触发归档）——**通过**

- 触发点只在 `chain.refresh`（`src/core/chain.ts:596`）；`collab_list` 不调用 `refresh`
  （`src/tools/list.ts` 只用 `allBroadcasts` + `leaseVerdict` 只读判定）。
- 复现（`session.update` 全量计数）：D1（`collab_list` 期间 0 次归档写入）、D3（同上，且记录行标 `[archived]`）、
  D4（`buildSnapshot` 期间 0 次写入，`handoffs[].archived === true` 且行仍在）。
- 可见性：D2 会实行 `ses_spawn_ok  build  archived  loc=ws  …  [bootstrap,archived]`。

### 8. 回归（build / typecheck / test 635+12+35+17 / check-skill）——**通过**

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
EXIT=0
=== 635/635 checks passed
=== 12/12 checks passed
=== 35/35 checks passed
=== 17/17 checks passed
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
```

既有 608 项无删改：`git diff --numstat test/` = `360 1 test/handoff-harness.mjs`（唯一删除行是把
`if (input.archived !== undefined)` 改为块以加计数）、`3 2 test/readonly-default.mjs`（工具数 16→17）、
`25 0 test/snapshot-shape.mjs`（纯新增）。全套 635 项通过，说明既有断言未失效。

### 9. 范围 / 安全（BUILTIN_PROTECT 未改、允许清单、无新运行时依赖）——**通过（含 1 处清单外但合理的改动）**

- `git diff src/constants.ts | grep BUILTIN` → 无输出（`BUILTIN_PROTECT` 未改）。
- `package.json`：仅 `version 0.4.2→0.5.0` 与 `description`；无新增 `dependencies`，`pnpm-lock.yaml` 未改。
- 改动文件 = 任务允许清单 + `src/index.ts`（启动日志一行 + `__internals` 导出 `shouldArchive/archiveSession` +
  注释数字，属合理改动）+ `.trellis/tasks/…/task.json`（Trellis 记账）。
- 归档写路径复用既有宿主能力（`session.update` 的 `archived` 字段早已在 `src/types.ts:111-117` 声明），
  HTTP 兜底不猜端口（沿用 `SERVER_URL`）。
- 安全边界：自动路径只碰 `claim.kind==='spawn'` 的 `claim.by`；手动路径仅 `[protected*]` 硬拒绝（design §4 允许）。

### 10. 边界行为：restore 后再次自动归档 —— **符合 design（design 未定义“墓碑”），已在文档写明；非缺陷**

- 复现 G1/G2：restore 清 `archivedAt`，`mergeArchive → writeBroadcast` 同时把 `updatedAt` 刷新为恢复时刻，
  因此**防抖窗口从恢复时刻重新计时**；紧接着的 refresh 不会立刻再归档。
- 窗口过后若仍是终态 + idle + 其他条件成立，会再次归档——与 design §2/§4 不冲突（design/PRD 未定义
  「恢复后永不再归档」的墓碑字段），`docs/collab.md` §11.13 已写明，长期保留用 `archiveSpawned:false`。
- 判断：**可接受**；若产品希望「人工恢复即永久保留」，需要新增墓碑字段（后续任务，非本任务范围）。

---

## 风险清单

| 编号 | 等级 | 位置 | 描述 | 建议 |
| --- | --- | --- | --- | --- |
| R-1 | **中低（待决策）** | `src/core/archive.ts:95-99`；`src/tools/accept.ts:197-215` | **spawn 租约过期后才 accept 会丢失 `claim.kind='spawn'`**：`accept` 先 `refresh`，lapsed claim 被 `refreshBroadcast` 重开（删 `claim`、写入 `expiredClaim.kind='spawn'`），随后走通用领取分支写入 `kind:'accept'`。之后自动归档永远看不到 `kind==='spawn'` → **该 spawn 会话永不自动归档**。自写复现：`INFO late accept → state=acked claim.kind=accept expiredClaim.kind=spawn` / `FAIL late-accepted spawn is auto-archived :: count=0`。正常即时 accept 分支（`accept.ts:128-152`）会保留 `kind:'spawn'`，**主路径正常**（已复现 PASS）。 | 二选一（低成本）：① gate 兼认 `record.expiredClaim?.kind==='spawn'` 且取 `expiredClaim.by`；② late accept 若 `expiredClaim.kind==='spawn'` 则保留 spawn 身份。PRD R1 字面只写 `claim.kind === 'spawn'`，故需产品点头；不阻塞本次提交。 |
| R-2 | **低（文档事实错误）** | `docs/collab.md:904`、`skills/collab/SKILL.md:109`、`CHANGELOG.md:12` | 新增的绝对化表述「插件**从不**调用 `DELETE /api/session/{id}`」与既有代码冲突：`src/tools/broadcast.ts:258` 在 spawn 落点校验失败时会 `session.remove` 回滚**刚建**会话（0.4.0 既有）；文档自身也记录了 selftest 的 DELETE（`docs/collab.md:109/143`）。 | 收窄为「**归档路径**不调用 DELETE；唯一的删除是 spawn 落点校验失败时回滚刚建会话（既有行为）」。 |
| R-3 | 低（文档过期） | `README.md:179` | `pnpm test  # build + 608 项 harness + 12 项只读默认 + 33 项快照/产物 + 17 项 TUI 渲染` 仍是旧计数；实际 `635 + 12 + 35 + 17`（CHANGELOG 已写对）。 | 改 608→635、33→35。 |
| R-4 | 低（安全提示不完整） | `README.md:44-46` | 「权限提示（务必读）」只列 grant/promote 两项写能力；新增 `collab_archive` 是第三种写能力且**不受 `allowWrite` 限制**（实施决策 D4：自动路径默认开，手动再设开关会自相矛盾）。 | 在该段补一句：`collab_archive` 可归档/恢复非 protected 会话（默认开启，不受 allowWrite 限制）。 |
| R-5 | 低（任务文档不一致） | `prd.md` R2-③/R5 vs `design.md` §1/§6 | PRD 写「≥5min / 默认 5min」，design 与实现（`ARCHIVE_GRACE_MS=600000`）是 10min，全部对外文档也写 10min。实现 10min 满足 PRD R2「≥5min」，但 R5 的「默认 5min」未落地。 | 改 PRD R2/R5 为 10min（或若要 5min，只改 `constants.ts` 一处 + 文档；测试用显式配置，不受影响）。属产品口径，需拍板。 |
| R-6 | 低（语义细节） | `src/core/claim.ts:352-358` → `writeBroadcast`（`claim.ts:150-158`） | design §2 说「只写 `archivedAt`」，实际 `writeBroadcast` 同时刷新 `updatedAt` 并触发 7 天 prune。这与全仓写入惯例一致，且 restore 后的防抖重启依赖它（文档已说明）。 | 保持现状；若严格按 design 字面，需在 `mergeArchive` 用底层写且不 bump（不建议）。 |
| R-7 | 低（可见性小缺口） | `src/core/archive.ts:119-121` | 宿主已归档但记录未盖章时，自动路径拒绝「宿主已归档」且**不补戳** → `collab_list` 记录行不会显示 `[archived]`（会话行仍显示 `state=archived`）。这是为避免重复 PATCH 的取舍。 | 可在拒绝分支改为「不发 PATCH，但补写 `archivedAt`」以统一可见性；非必须。 |
| R-8 | 低（理论脆弱性） | `src/core/chain.ts:588-601` + `archiveIfDue`（`archive.ts:205-219`） | `refresh` 在归档成功时返回**磁盘合并记录**（`mergeArchive`），而 `refreshCore` 的改动靠调用方 `persistRefresh` 落盘。今天所有能走到归档的分支中，磁盘记录必为终态（非终态会被「仍被未决交接引用（自身）」拦下），实测自动回执场景（2 步）收据与状态均未丢。若未来让 `refreshCore` 改终态记录，存在被 `changed` 判定漏写的风险。 | 保留；在 `refresh` 注释里已说明顺序，建议后续为此加一条单元断言。 |
| R-9 | 低（范围提示） | `src/tools/archive.ts:28-50,83-90` | 手动工具可归档**任意**非 protected 会话（含用户自己的会话 / requester / `collab_handoff` 对象），不校验 spawn 痕迹也不受 `allowWrite` 限制——design §4 有意如此（"允许人工归档任意自建会话需确认"）。 | 文档补一句「手动可指定任意非 protected 会话」即可，不建议加开关。 |
| R-10 | 低（测试覆盖） | `test/handoff-harness.mjs` S94 | S94 全部用手写 `writeRaw` 记录，未驱动真实 `collab_broadcast → spawn → accept → receipt → 归档` 生命周期，因此 R-1 不会被现有断言发现。 | 补 1 条端到端生命周期用例（含 late accept 的期望口径）。 |

## 是否可提交

**可以提交。** 10 项必查中 9 项明确通过；第 10 项（restore 后再次归档）判定为符合设计并已文档化。
未发现误归档、数据丢失、破坏 handoff/lease 语义、或违反 protected 硬边界的实现缺陷；验收命令全绿
（`635 + 12 + 35 + 17` + `skills ok`）。

提交前建议（不阻塞）：
1. 修 R-2 / R-3 / R-4 三处文档表述（纯文档，10 行以内）；
2. 把 R-5（5min vs 10min）与 R-1（late accept 丢 spawn 身份）登记为待决策 / 后续任务；
3. 若一并处理 R-1，补一条真实生命周期的回归用例（R-10）。

## 原始输出（节选）

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
EXIT=0
=== 635/635 checks passed
=== 12/12 checks passed
=== 35/35 checks passed
=== 17/17 checks passed
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok

$ node /tmp/opencode/s94-independent.mjs
PASS  A1 eligible spawn+done+11min+idle → archive:true
PASS  A4 grace not reached (30s < 10min) refused, no I/O  :: io={"sessionInfo":0,"isProtected":0,"records":0,"unseen":0}
PASS  A9 already archived (archivedAt) refused before any I/O
PASS  A12 archiveGraceMs=1 clamps up to 60s (30s no, 61s yes)
PASS  A13 archiveGraceMs=1e12 clamps down to 1h (30min no, 61min yes)
PASS  B2 update throwing 403 → readable failure, never thrown
PASS  C1 the context hook does not throw (update failure is isolated)
PASS  C4 archive is not delete: state/receipt untouched  :: done/closed
PASS  C8 unread owner-queue item blocks archiving
PASS  C14 repeated refreshes neither re-PATCH nor restamp (idempotent)  :: 1/1794992626725
PASS  D1 collab_list performs zero archive writes
PASS  D2 collab_list marks the archived session [archived]  :: ses_spawn_ok  build  archived  loc=ws  … [bootstrap,archived]
PASS  D4 snapshot carries archived:true and does not write
PASS  E7 protected target refused with zero writes
PASS  E12 manual archive ignores the grace window (30s-old terminal bid archived)
PASS  F1 defaults: archiveSpawned=true and grace=10min (11min archives, 30s does not)
PASS  G1/G2 restore clears archivedAt, bumps updatedAt, no immediate re-archive
=== 66/66 independent checks passed

$ node /tmp/opencode/s94-http.mjs
PASS  H1 auto path uses PATCH /api/session/{id}
PASS  H2 body {"archived":true} + bearer token
PASS  H4 HTTP 500 → request made, no stamp, never thrown
PASS  H5 manual restore over HTTP sends archived:false and clears archivedAt
=== 6/6 HTTP-path checks passed

$ node /tmp/opencode/s94-receipt-race.mjs
PASS  1st pass: auto-receipt is written and NOT archived in the same pass
PASS  2nd pass: the record is archived and the receipt survives

$ node /tmp/opencode/s94-accept-boundary.mjs
PASS  prompt accept keeps kind=spawn :: state=acked kind=spawn by=ses_spawn_a
INFO  late accept → state=acked claim.kind=accept claim.by=ses_spawn_b expiredClaim.kind=spawn attempts=1
PASS  prompt-accepted spawn is auto-archived :: count=1
FAIL  late-accepted spawn is auto-archived :: count=0 (record claim.kind=accept)   ← R-1，待决策
```

---

# 增量复核（R-1 / bid）

- 复核对象：上一轮 4 项建议的作者改动（未提交）
  - `src/core/archive.ts` 新增 `spawnedSessionID`（`claim.kind==='spawn'` → `claim.by`；
    否则 `expiredClaim.kind==='spawn'` → `expiredClaim.by`；都没有 → 空），`shouldArchive` 改用它取目标
  - `src/tools/archive.ts` 的 `resolveSession` 改用 `spawnedSessionID`；非 spawn 单按 `bid` → 可读校验错误；
    `session` 路径不变；无 record 时补 `spawnedSessionID(other) === sessionID` 的落戳过滤
  - 文档收窄 DELETE 表述、README 计数 638、§11.13 增「与 allowWrite 无关」、PRD 5min→10min
- 复核方式：仍是冷上下文、**只审不改**；`/tmp/opencode/*.mjs` 自写假 ctx 复现，未对真实会话做任何归档/恢复
- 复现脚本（本轮全部重跑）：`s94-independent.mjs`（66）、`s94-http.mjs`（6）、`s94-receipt-race.mjs`（2）、
  `s94-accept-boundary.mjs`（4）、`s94-incremental.mjs`（28，本轮新增）

## 结论

**可提交。** R-1 已修复并经端到端复现：spawn 租约过期后才被领取的孤儿会话现在会被归档一次，
**接手的人自己的会话零写入**；`claim.spawner` 从未被当作目标。上一轮八条门禁、失败隔离、幂等、手动工具、
配置夹取、只读路径均无回归；`allowWrite` 门禁**没有**被引入（owner 决策已落地，文档与代码一致）。
验收命令：`638 + 12 + 35 + 17` + `skills ok`。

## 逐项证据（7 项）

### 1. `spawnedSessionID` 三个分支 —— **通过**

`src/core/archive.ts:92-98`；`shouldArchive` 用它在 `archive.ts:114` 取目标（原 `claim.kind!=='spawn'`
的直接拒绝分支已删除）。用注入式 gate 经 `shouldArchive` 观测三个分支（`s94-incremental.mjs` §1）：

| 用例 | 期望 | 结果 |
| --- | --- | --- |
| `claim.kind='spawn'`，`claim.by=ses_orphan` | 目标 = `ses_orphan` | 1a PASS |
| `claim.kind='accept'`（人）+ `expiredClaim.kind='spawn'`,`by=ses_orphan`,`spawner=ses_req` | 目标 = `ses_orphan`（**不是**人、**不是** spawner） | 1b PASS |
| `accept` 无 `expiredClaim` | 拒绝 | 1c PASS |
| `expiredClaim.kind='accept'` | 拒绝 | 1d PASS |
| `spawn` 但 `claim.by` 缺失 / 空白 | 拒绝 | 1e/1h PASS |
| `expiredClaim.spawn` 但无 `by` | 拒绝 | 1f PASS |
| 只有 `claim.spawner` | 拒绝（spawner 永不是目标） | 1g PASS |
| 孤儿 fallback 仍要求终态 / idle / 非 protected | 三者均拒绝 | 1i/1j/1k PASS |

### 2. 上一轮八条门禁无回归 —— **通过**

重跑 `s94-independent.mjs`：**66/66**。非 spawn（含 accept）仍拒绝、非终态、防抖 30s、busy、protected、
未决引用（`from.sid` / `claim.by`）、未读队列、`archivedAt` 幂等、`archiveSpawned:false`、宿主已归档、
`archiveGraceMs` 双向夹取全部与上一轮一致（A1–A14、C2–C14、D1–D4、E1–E12、F1–F5、G1–G2）。
本轮唯一调整的两条断言是**口径变化**而非回归：
- E10 的「bid+session 不一致」改用 spawn 单（非 spawn 单现在先被 spawn 校验拒绝，见第 3 项）；
- E11 的「无 `claim.by`」断言改为新文案「不是本插件拉起的会话」。

### 3. 手动 `bid` 路径 —— **通过**

`src/tools/archive.ts:32-53`（`resolveSession`）、`:43-49`（拒绝文案）、`:168`（落戳过滤）、`:66-72`（工具描述）。

- 非 spawn 单（`claim.kind=accept`，领取人是人）：`collab_archive { bid, confirm:true }` →
  **ValidationError**（可读，非崩溃），**0 次写入**，文案含「请用 `session` 直接指定」：
  `b_…12 不是本插件拉起的会话（claim.kind=accept，当前领取方 ses_human 是人自己的会话）：按 bid 归档只针对本插件 spawn 的会话；…`（3a/3b）
- expired-spawn 单的**预览**解析出孤儿，不含接手人/发起方：`目标: ses_orphan …`（3c）
- 已归档时 `bid` 不重复 PATCH（`目标已是归档状态（幂等，未重复 PATCH）`，3d）
- `bid` restore → `archived:false` + 清 `archivedAt`，接手人 0 次写入（3e）
- `bid` confirm → 只 PATCH 孤儿一次，接手人 0 次（3f）
- `session` 仍可直指任意非 protected 会话（归档 3g / 恢复 3h）
- 自动路径同口径：孤儿归档一次 + `archivedAt` 落库，**接手人 `ses_human` 零 PATCH**，
  `state=done` / `receipt.note` 不变，二次刷新不重复 PATCH（2a–2d）

> 口径变化提示（已文档化）：手动归档了**非 spawn** 会话后，恢复也必须用 `session`（`bid` 不再接受非 spawn 单）。
> 仓内 S94 的 restore 用例已相应改为 `session: S94_MANUAL`（`test/handoff-harness.mjs:7710`），非 bug。

### 4. 没有新增 `allowWrite` 门禁 —— **通过**

`grep allowWrite src/core/archive.ts src/tools/archive.ts` → 无命中。宿主以默认 `allowWrite=false` 启动
（`setup ok: … allowWrite=false`），手动 `collab_archive { session }` 仍成功（4a/4b），自动路径也未受影响。
文档与代码一致：
- `README.md:44-51`：明确「`collab_archive` **不受 `allowWrite` 约束**」+ 关断方式 `archiveSpawned:false`；
- `docs/collab.md:926-928`：§11.13「与 `allowWrite` 无关」小节；
- `docs/collab.md:280`：§11.2 工具行（bid 只认 spawn 会话 / 手动跳过自动门 / `[protected*]` 拒绝）。
无任何文档声称归档受 `allowWrite` 约束。

### 5. 只读路径 / 归档语义 / 无 DELETE —— **通过**

- `collab_list`：0 次 `session.update`（4c），仍标 `[archived]`（4d：
  `ses_other  build  archived  loc=ws  …  [archived]`）；`buildSnapshot` 0 次写入且 `archived:true` 保留（4e）。
- 归档不改 `state`/`receipt`：2c（`done` + `closed by human` 不变）、`s94-independent` C4。
- `grep DELETE src/core/archive.ts src/tools/archive.ts src/core/chain.ts` → 归档路径无 `DELETE` /
  `session.remove`（唯一命中是 `archive.ts:10` 的注释文字，见剩余风险）。

### 6. 回归数字真实性 —— **通过**

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
EXIT=0
=== 638/638 checks passed
=== 12/12 checks passed
=== 35/35 checks passed
=== 17/17 checks passed
skills ok
```

635 → 638 的 3 条新增全部在 S94，且都是**行为断言**（非填充）：
1. `S94 a lapsed spawn lease re-accepted by a human still archives the spawned orphan`（`test/handoff-harness.mjs:7608`）
   —— 断言孤儿被归档 1 次 **且接手人 `ses_s94manual` 0 次**；
2. `S94 collab_archive { bid } refuses a hand-off that spawned nothing`（`:7721`）—— `expectFail` + `/不是本插件拉起的会话/`；
3. `S94 collab_archive { bid } resolves the orphan from expiredClaim, not the human who took over`（`:7727`）
   —— 预览含孤儿、不含接手人。
对应 fixture `s94LapsedBid`（`:7563-7569`）有 `claim.kind='accept'` + `expiredClaim.kind='spawn'`，能真正区分两支。

### 7. 文档事实与实现/测试一致 —— **通过（用户文档）**

- `README.md:184`：`638 项 harness + 12 + 35/产物 + 17 TUI`；`README.md:44-51` 权限提示补第三种写能力；
- `docs/collab.md:904-905`：DELETE 收窄为「归档路径不调用 DELETE（selftest 清理与 spawn 落点回滚除外）」；
  `:908` 八条① 写了两种 spawn 形态；`:920` 手动命令标注 `claim.by / expiredClaim.by`；`:1120` §12.5 同步收窄；
- `skills/collab/SKILL.md:109`：同样收窄（`selftest` 清理与 spawn 落点回滚另有用例）；
- `CHANGELOG.md:12` 收窄 DELETE 表述；`:42-52` 计 638 并列出 3 条新增；
- `prd.md` R2-②/R5 已改为 10min（与 design/实现/全部文档一致）；
- `node scripts/check-skill.mjs` → `skills ok`。

## 原始输出（本轮）

```
$ node /tmp/opencode/s94-incremental.mjs
INFO  setup: [collab] setup ok: version=0.5.0 … tools=17 … allowWrite=false
PASS  1a spawn → claim.by  :: {"archive":true,"sessionID":"ses_orphan"}
PASS  1b accept + expiredClaim.spawn → expiredClaim.by (not the human, not the spawner)
PASS  1j the orphan fallback still honours [protected*]  :: 目标在 protect 名单内
PASS  1k the orphan fallback still requires idle  :: 目标不是 idle（busy）
PASS  2a the orphan is archived exactly once  :: [{"sessionID":"ses_orphan","archived":true}]
PASS  2b the human who took the hand-off is never archived  :: []
PASS  2c archivedAt is stamped on the orphan record and state/receipt are untouched
PASS  2d idempotent: a second refresh does not re-PATCH the orphan
PASS  3a non-spawn bid → readable ValidationError, zero writes
PASS  3b … and the message offers the `session` escape hatch
PASS  3c bid preview resolves the orphan from expiredClaim (not the human, not the spawner)
PASS  3d bid archive on an already-archived orphan is a no-op (no second PATCH)
PASS  3e bid restore sends archived:false to the orphan and clears archivedAt
PASS  3f bid confirm archives the orphan only, and writes nothing for the human
PASS  3g `session` still archives any non-protected session directly
PASS  3h … and restores it
PASS  4a the host runs with allowWrite=false (default)
PASS  4b manual archive works with allowWrite=false (no new gate)
PASS  4c collab_list performs zero writes
PASS  4d collab_list still marks the archived session [archived]  :: ses_other  build  archived  …  [archived]
PASS  4e snapshot carries archived:true and performs zero writes
=== 28/28 incremental checks passed

$ node /tmp/opencode/s94-independent.mjs        → === 66/66 independent checks passed ===
$ node /tmp/opencode/s94-http.mjs               → === 6/6 HTTP-path checks passed ===
$ node /tmp/opencode/s94-receipt-race.mjs       → 2/2 PASS (auto receipt survives the archive pass)
$ node /tmp/opencode/s94-accept-boundary.mjs
PASS  prompt accept keeps kind=spawn
PASS  prompt-accepted spawn is auto-archived :: count=1
PASS  late-accepted spawn is auto-archived :: count=1 (record claim.kind=accept)   ← 上一轮 R-1 已闭环
```

## 剩余风险（都不阻塞提交）

| 编号 | 等级 | 位置 | 描述 | 建议 |
| --- | --- | --- | --- | --- |
| R-11 | 低（注释与文档不一致） | `src/core/archive.ts:10` | 模块头注释仍写「The plugin never calls `DELETE`」；用户文档已收窄为「归档路径不 DELETE（selftest 清理 / spawn 回滚除外）」。 | 注释改为「this module never calls DELETE」。 |
| R-12 | 低（任务文档滞后） | `design.md` §4、`implement.md` §1/§3 | design §4 仍写「`bid` → 解析记录取 `claim.by`」，未反映「非 spawn 单拒绝、孤儿取 `expiredClaim.by`」；implement 里写的是 `spawnTarget()`（代码叫 `spawnedSessionID`）且多数勾选未回填。 | 提交前一并更新 design §4 / implement 勾选，避免下一轮复核按旧口径判断。 |
| R-13 | 低（可测性） | `src/index.ts` `__internals`（`:211+`） | `spawnedSessionID` 未通过 `__internals` 导出，仓内测试只能经 `shouldArchive` / 工具间接覆盖（已能区分三支）。 | 若要单测三支，导出到 `__internals` 即可（非必须）。 |
| R-14 | 极低（极窄场景） | `src/core/claim.ts:236`（`refreshBroadcast` 重写 `expiredClaim`） | 孤儿 fallback 依赖 `expiredClaim` 保留 spawn 身份；若该单在**同一条记录**上再次 lease 过期（接手人也过期），`expiredClaim` 会被覆盖成 `accept` 单，孤儿从此不再被自动归档。 | 无数据风险（只是不归档）；如要覆盖，可加 `spawnTrace` 一次性字段。非本任务范围。 |
| R-15 | 低（措辞） | `docs/collab.md:904` | 「全插件唯一的 `DELETE` 是 `selftest` 清理**与** spawn 落点回滚的 `session.remove`」——「唯一」后接两项，读起来略拧。 | 改「插件里的 `DELETE` 只出现在这两处：…」。 |

上一轮风险的状态：R-1 已修并验证；R-2/R-3/R-4 已在用户文档落地（残留见 R-11/R-12）；R-5 PRD 已改 10min；
R-6/R-7/R-8/R-9/R-10 未变（仍为可接受的低风险）。
