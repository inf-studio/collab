# 第二轮复核报告：统一协作链路（11-17-collab-workspace）

> 复核方式：**冷上下文独立复核**（只审不改；未 commit / push / git add；未修改实现）。
> 复核时间：2026-11-17
> 复核对象：`.opencode/plugins/collab.js`（工作区版）、`docs/collab.md`、`.trellis/spec/guides/cross-workspace-collab-guide.md`、`.trellis/spec/guides/index.md`、任务 `prd/design/implement.md` + `research/`
> 上一轮报告：`research/check-report.md`（不通过）；实现方修复说明：`research/impl-notes.md` §8。
> **自建复现**（不采信 impl-notes 自述、也不采信既有 harness 的断言结论）：
> - `/tmp/collab-round2/repro.mjs`：假 ctx + 真实临时广播目录，**43/43 通过**；B1/B2/B3 的时间用**磁盘改 `claim.at` / `asked.at`** 伪造（不是 mock `Date.now`）。
> - `/tmp/collab-round2/compare.mjs`：`HEAD` 版 vs 工作区版，同一假 ctx 跑既有 5 个工具，逐项比输出。

## 结论

**通过（可提交）。**

上一轮的 2 项阻断（B1 spawn 无法 `claimed→acked`、B2 spawn lock 归属错位）与需求缺口 B3（R3/R4 ACCEPT/DECLINE 问询协议）都已按描述实现，且能被独立复现验证；
S1–S5 五项应修全部落地。门禁 `node --check` 退出 0、harness **124/124** 退出 0、两处 `/api/plugin` 无 `failed`。
既有 5 个工具（`collab_send/reply/wait/inbox/list`）行为除 `collab_list` 的新增列/说明外与 `HEAD` 逐字节一致（时间戳除外）。

非阻断风险 6 条（见末尾），均不改变验收结论；其中 4 条是第一轮就登记为「可留」的已知限制。

---

## 必跑命令原始输出

```text
$ node --check .opencode/plugins/collab.js
node --check exit=0

$ node .trellis/tasks/11-17-collab-workspace/research/handoff-harness.mjs
  ✓ S38 the cross-workspace guide is listed in the guide index — guides/index.md
=== 124/124 checks passed
harness exit=0            # ✓ 行数=124，✗ 行数=0

$ opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"
collab-global  active  /root/.config/opencode/plugins/collab-global.js
collab         active  /data/project/muke-pos-app/.opencode/plugins/collab.js
non-active: []

$ opencode api get "/api/plugin?location%5Bdirectory%5D=/data/project/muke-interface"
collab-global  active  /root/.config/opencode/plugins/collab-global.js
non-active: []

$ git diff --stat -- .opencode/plugins/collab.js docs/collab.md .trellis/spec/guides/index.md
 .opencode/plugins/collab.js   | 1835 ++++++++++++++++++++++++++++++++++++++---
 .trellis/spec/guides/index.md |    1 +
 docs/collab.md                |   76 +-
 3 files changed, 1783 insertions(+), 129 deletions(-)
```

自建复现（`node /tmp/collab-round2/repro.mjs`）：

```text
PASS [B1.0] spawn created a session and state=claimed
PASS [B1.0b] lock has by=requester and claimBy=spawned
PASS [B1.1] state moves claimed → acked — state=acked
PASS [B1.2] ackedAt recorded — ackedAt=1794878079861
PASS [B1.3] receipt template only offers DONE
PASS [B1.4] spawn lock released on ACCEPT — lockExists=false
PASS [B1.5] requester notified about ACCEPT
PASS [B2.1] lock by/claimBy consistent with claim.by — {"by":"ses_req_b2","claimBy":"ses_spawn_2"}
PASS [B2.2] state reopens with attempts=1 — state=open attempts=1
PASS [B2.3] spawned holder skipped — ["ses_spawn_2"]
PASS [B2.4] lease expiry really deletes the .lock — lockExists=false
PASS [B2.5] member can claim (not 'already taken by requester')
PASS [B2.6] claim.by becomes the member, state=acked — {"by":"ses_m_b2","state":"acked"}
PASS [B3.1] only the top-1 is asked (serial)
PASS [B3.2] protected line is not a candidate
PASS [B3.3] no prompt went to protected sessions
PASS [B3.4] asked session gets the takeover line (ACCEPT/DECLINE/5min)
PASS [B3.5] askSeen persisted
PASS [B3.6] DECLINE parsed: attempts+1 and candidate skipped
PASS [B3.7] DECLINE advances to the next candidate
PASS [B3.8] asked/askSeen/declines persisted to disk
PASS [B3.9] ask timeout behaves like DECLINE (attempts+1, skip, next)
PASS [B3.10] attempts > 3 → expired even with an unasked ≥80 candidate left
PASS [B3.11] expired hand-off is refused and never spawns
PASS [B3b.1] candidates exhausted → expired (no re-delivery)
PASS [B3b.2] exhaustion never spawns
PASS [S1.1] same bid, no second delivery
PASS [S1.2] done hand-off is not resurrected and keeps its receipt — {"state":"done","note":"sha-1"}
PASS [S1.3] third call reports closed, no re-delivery
PASS [S2.1] unknown landing is refused
PASS [S2.2] the just-created session is rolled back — ["ses_spawn_1"]
PASS [S2.3] no broadcast record is left behind
PASS [S3.1] bare basename closes nothing — acked/acked
PASS [S3.2] non-claimant cannot close it — acked
PASS [S3.3] exact issuePath from the claimant closes only its own record — done/acked
PASS [S4.1] symlink under docs/issues is refused
PASS [S4.2] regular proposal still accepted
PASS [G.1] another workspace's session is refused — open
PASS [G.2] protected session receives no broadcast/ask injection — []
PASS [REG.1] collab_send preview does not deliver / confirm delivers
PASS [REG.2] collab_reply routes to the counterpart
PASS [REG.3] collab_inbox contains the request
PASS [REG.4] collab_list still lists sessions with the new loc= column
=== 43/43 checks passed
```

---

## 11 项逐条结论

### 1. B1 — spawn 会话自己 `collab_accept` → `acked` ✅ 通过

- 代码：`collab.js:2358-2384`。`record.claim.by === me` 且 `state==="claimed"` 时写 `state:"acked"` + `ackedAt`（`:2365`），释放 spawn lock（`:2368`），并给发起方回一条 `ACCEPT … 完成后回执 [handoff] DONE`（`:2369-2374`）。
- 复现（自建假 ctx，真实 spawn）：spawn 后 `state=claimed`、lock `{by:"ses_req_b1", claimBy:"ses_spawn_1"}`；spawn 会话调 `collab_accept {confirm:true}` 后：

```text
你已领取 b_90a16d8de0b83bd4（state=acked，kind=spawn，token=k_mwk02e0h_z03z）。
完成后回执: [handoff] DONE b_90a16d8de0b83bd4 <commit sha 或摘要>（用 collab_send 发给发起方 ses_req_b1）。
```

`state=acked`、`ackedAt=1794878079861`、lock 已消失、发起方收到 ACCEPT 通知；模板**只有 DONE**，无 BLOCKED。
（`collab_broadcast`/回执协议文案仍保留 `DONE|BLOCKED`，与 PRD R7 一致；B1 针对的是 accept 模板，已满足。）

### 2. B2 — spawn lock 的 `by`/`claimBy` 与租约过期 ✅ 通过

- 代码：spawn 建会话后 `updateLock(bid,{claimBy:info.id})`（`collab.js:2063`，`updateLock` `:713-722`；lock 里 `by`=发起方 + `claimBy`=新会话）；`releaseLock` 接受数组，`by` **或** `claimBy` 命中即删（`:697-711`）；租约过期按 `[claim.by, claim.spawner]` 释放（`refreshBroadcast` `:617-655`）。
- 复现（**磁盘伪造** `claim.at = now-301000` 后，用同工作区成员读一次）：

```text
lock before: {"by":"ses_req_b2","kind":"spawn","claimBy":"ses_spawn_2"}
forge claim.at -> 301s ago
member preview: bid=... state=open attempts=1
lock after: lockExists=false
record after: {"state":"open","attempts":1,"skipped":["ses_spawn_2"]}
member accept: 已领取 b_5cb578eedbee27df（winner，token=…，state=acked，lease=300000ms）
```

成员**能成功领取**，不再出现「已被 ses_req 领取」的死锁；`.lock` 真的被删除；`attempts=1`。

### 3. B3 — DECLINE / 问询租约 / 候选耗尽 / 字段落盘 ✅ 通过

- 代码：`applyDecline`（`:1367-1376`，只认 `asked.sid === from`）→ `declineAsked`（`:598-611`：`attempts+1`、`skipped`、`declines` 审计、`asked` 前移；`!planAsk || attempts>3 → expired`）；问询超时由 `refreshBroadcast` 的 `asked` 分支走同一函数（`:639-643`）；只有 `asked.sid` 收到接管请求（`:1424-1440`，`askSeen` 去重）；spawn 只在 `plannedSpawn = !top` 分支（`:1987`/`:2015`）。
- 事件流解析：`collab.js:2765-2778`（`applyReceipt` 后 `applyDecline`）。
- 复现（5 个 ≥80 候选，逐个 DECLINE/超时）：

```text
after DECLINE:  attempts=1 skipped=[ses_f1] asked=ses_f2 state=open declines=[{sid:"ses_f1",at:...}]
after timeout:  attempts=2 skipped=[ses_f1,ses_f2] asked=ses_f3 state=open
after 4 skips:  state=expired attempts=4 skipped=[f1..f4] （f5 仍在候选里，未问）
accept expired: THROW 广播 b_ec0f3d5ceb7d06e1 已 expired（attempts=4 > 3）
spawn delta=0, prompt delta=0
单候选 DECLINE → state=expired attempts=1 asked=null，spawn 数不变
```

`asked / askSeen / declines` 均真写入 `<bid>.json`（见上，且 `askSeen` 在注入后包含被问会话）。
S33/S34 描述的「串行、顺延、耗尽即升级、不 spawn」与实现一致。

### 4. S1 — `collab_handoff` 幂等、不复活已闭环 ✅ 通过

- 代码：`collab.js:2235-2252`，复用 `bid` 前先 `readBroadcast`；已存在直接返回，不投递、不覆盖。
- 复现：

```text
1st: bid=b_f18d212eab50f9ba thread=t_… prompts=4
2nd: 已存在同一交接（bid 幂等，不重复投递）… promptsDelta=0
receipt → done, note=sha-1
3rd: 已闭环（state=done）：sha-1。不重复投递、不改状态。 state 仍 done，receipt 保留
```

### 5. S2 — 拉新落点校验失败时回滚 ✅ 通过

- 代码：`landed !== workspace` 严格相等；缺失同样失败（`collab.js:2053-2061`），随后 `ctx.session.remove` 刚建会话 + `releaseLock`，且**在写广播记录之前**抛错。
- 复现（假宿主不回 `location`）：

```text
THROW: 拉新失败：会话落点不对（期望 …/ws/s2，实际 (未知)），已回滚刚建的会话。
removed = ["ses_spawn_1"]
该 bid 没有留下 .json / .lock
```

### 6. S3 — 回执匹配收紧 + 承接方校验 ✅ 通过

- 代码：`receiptMatches`（`:929-939`）只认 `bid` / `threadID` / **完整** `issuePath`，basename 已删除；`receiptAllowed`（`:941-945`）要求 `claim.by === from`；`applyReceipt` 只扫未闭环记录（`:1340-1364`）。
- 复现（两个仓都有 `docs/issues/fix-same.md`，均已 `acked`）：

```text
bare basename "fix-same.md"（两个承接方各发一次）→ A=acked B=acked（都没闭环）
非承接方发完整路径 "docs/issues/fix-same.md" → A=acked（被拒）
真正的承接方发完整路径 → A=done receipt.from=ses_claim_s3a；B=acked（未被误关）
```

### 7. S4 — `docs/issues` 软链提案被拒 ✅ 通过

- 代码：`resolveBroadcastTargets` 先 `lstatSync` 拒软链，再 `realpathSync` 复查真实路径仍在 `<workspace>/docs/issues/`（`collab.js:843-905`；workspace 也走 `realpath`）。
- 复现：

```text
docs/issues/fix-symlink.md -> /tmp/…/outside-secret.md
THROW: 拒绝广播：提案 docs/issues/fix-symlink.md 是软链（不允许软链绕过 docs/issues/ 写边界）。
普通提案仍可预览（未广播）。
```

### 8. 回归 ✅ 通过

- `node --check` 0；harness 124/124、退出 0；`✗` 计数 0。
- 既有 5 工具与 `HEAD` 对比（`/tmp/collab-round2/compare.mjs`，同一假 ctx、同一输入）：

```text
preview: IDENTICAL        send: IDENTICAL        reply: IDENTICAL
replyAsOutsider: IDENTICAL sendToProtected: IDENTICAL
inbox: 仅时间戳不同（09:15:36 vs 09:15:37），正文/状态行一致
wait: IDENTICAL           waitMissing: IDENTICAL
list / listNoDir: 仅新增 `loc=<项目名>` 列 + 末尾 `[bootstrap]` 说明（预期内）
```

- `collab_list` 的血缘深度口径仍是 `depth <= MAX_LINEAGE_DEPTH`（自身 + 最多 8 级），与 `docs/collab.md` §11.4 一致。

### 9. 范围 ✅ 通过（附环境说明）

- 本任务实际改动：`.opencode/plugins/collab.js`、`docs/collab.md`、`.trellis/spec/guides/index.md`、新增 `.trellis/spec/guides/cross-workspace-collab-guide.md`、`.trellis/tasks/11-17-collab-workspace/**`。
- 工作区里确实存在 `packages/**`、`docs/issues/**`、`11-17-schema-governance/**` 的改动，但内容全部是 **schema-governance** 主题（member/reserve zod schema、契约、conformance test）；`git diff -- packages/ apps/ bench/ docs/issues/ .trellis/tasks/11-17-schema-governance/ | grep -i collab` **零命中**，且 `packages/ apps/ bench/` 无新增未跟踪文件。
- 结论：不是本任务误改，属并行任务的在途改动。**提交时必须按显式路径**（见「是否可提交」）。

### 10. 文档一致性 ✅ 通过（2 处措辞小瑕疵）

| 文档 | 断言 | 实现 | 结论 |
| --- | --- | --- | --- |
| guide §3:42-43 | 软链提案双重校验拒绝 | `lstat` + `realpath` | ✅ |
| guide §4:47-58 | 群组成员=根会话，排除 protected/子会话/自己；广播只注入一次；仅 top-1 收到接管请求；busy>30min 才补 1 条 | `rankCandidates` / `injectionFor` / `deliverAsk` | ✅ |
| guide §5.2:83-92 | top-1 / 新会话收到接管请求（ACCEPT / DECLINE） | `deliverAsk`（`:1748-1786`） | ✅（spawn 版把 `DECLINE` 换成 `BLOCKED`，见风险 R2-6） |
| guide §5.3:94-111 | `asked`/5min 顺延/DECLINE/耗尽或 attempts>3→expired 不 spawn；claimed 过期回 open；`collab_list` 只读快照 | `planAsk`/`declineAsked`/`refreshBroadcast` | ✅ |
| guide §6:113-148 | 数据契约、`wx` 原子锁、`by`/`claimBy` 释放、bid 幂等、tmp+rename、spawn `claimed→acked` | 实码逐项对应 | ✅ |
| guide §7:150-161 | 必带 location、宿主不回 location 回滚、explore 默认、build 每次确认、`impl:<slug>`、只回滚自建、并发只建一个 | `collab_broadcast` `:2015-2095` | ✅ |
| guide §8:163-179 | 回执格式、只认 bid/完整 issuePath/thread、只有承接方能闭环、事件流解析、提醒一次 | `applyReceipt` / `injectionFor` | ✅ |
| guide §10:192-208 | 10 条已知偏差 | 与代码一致（限 20、`ctx.session.context`、无清理、list 快照、expired 预览抛错、bid 含 mtime 等） | ✅ |
| guide §11:210-232 | 验收清单 12 项 | 本轮逐项复现 / harness 覆盖 | ✅ |
| `docs/collab.md` §11.2:255-260、§12:382-451 | 3 个新工具签名、两 scope、状态机、存储、最小流程、8 条限制 | 与 schema/实现一致 | ✅ |
| `guides/index.md:31` | 新增 guide 已进索引 | 有一行 | ✅ |

### 11. 护栏 ✅ 通过

- protected 投递：`rankCandidates` 排除 `parentID` 子会话 + `protectedAncestor`（`:1311-1318`）；`deliverAsk`（`:1750`）、`notifyRequester`（`:1385`）、`injectionFor`（`:1416`）各自再挡一次。
  自建复现：protected 会话及其子会话不在候选、没有 prompt 指向它们、context 注入为 `[]`。
- 删除会话：全文件仅 `collab.js:2054` 一处 `ctx.session.remove`，只删「刚建且落点不可验证」的会话；实测只删 `ses_spawn_1`。
- 无 `interrupt` 调用、无 `child_process`/git 调用；`interrupt` 只出现在工具描述文案里。
- 本轮复核**未创建任何真实会话**、未向受影响会话投递、未删任何会话；全局广播目录 `~/.config/opencode/collab-broadcast/` 为空。

---

## 风险清单（均为非阻断）

| ID | 级别 | 事项 | 位置 | 建议 |
| --- | --- | --- | --- | --- |
| R2-1 | 低 | `collab_accept` 不校验领取者是否在 protect 血缘内。protected 会话**主动**领取不会被拒（投递侧已全部挡住，AC 未被违反）。 | `collab.js:2331-2420` | 与 `deliverAsk` 对齐加一次 `protectedAncestor(me)` 检查，失败即抛错。 |
| R2-2 | 低 | 接管请求里没有发起方的**完整** sid（envelope 用 `shortID`，如 `ses_e18f…DPq`）。候选要发 DECLINE 需先 `collab_inbox` 从 `(fromSession)` 取全 id。 | `deliverAsk` `:1769-1779` | 在 prompt 里附一行「DECLINE 用 collab_send 发给 <full sid>」。 |
| R2-3 | 低 | `DECLINE` 只按「被问会话」匹配，不带 `bid`；同一会话同时被问两条广播时，一条 DECLINE 只能顺延其中一条；正文只要含 `DECLINE` 就触发。 | `applyDecline` `:1367-1376` | 支持 `DECLINE <bid> <理由>`，无 bid 时再回退到当前行为。 |
| R2-4 | 低 | 第一轮「可留」项仍成立：只对最近活跃前 20 个根会话打分；广播目录不清理；`collab_list` 不刷新租约；`expired` 连预览也抛错；`bid` 含 mtime。 | `:161`/`:549`/`:1869`/`:2348` | 已在 guide §10 全部登记，可留。 |
| R2-5 | 环境 | 工作区同时存在 `11-17-schema-governance` 任务的在途改动（`packages/**`、`docs/issues/**`）。 | — | 提交只用显式路径，**不要** `git add -A`；不要 push。 |
| R2-6 | 文档 | guide §4:55 用「额外拿到一行」描述被问候选，实现是**只发接管请求行**（已含广播全部信息）；guide §5.2 的模板没体现 spawn 版的 `BLOCKED` 分支。 | guide §4/§5.2 | 措辞微调即可，不影响行为。 |

---

## 门禁适用性说明

- `.opencode/plugins/collab.js` 是插件脚本，**不在** TS project references 内（`pnpm typecheck` 不覆盖），也**被** `vp check` 的 ignore 规则排除（实测 `vp check .opencode/plugins/collab.js` → “All matched files may have been excluded by ignore rules”）；`oxlint` 不在本仓依赖里。
- 因此本文件的等价门禁是 `node --check` + 124 项 harness（均已通过），与 `implement.md` / guide §11 的口径一致。未运行会自改文件的 `pnpm lint`（`--fix`），以免污染实现方工作区。

---

## 是否可提交

**是。**

- 上轮 2 个 P0 + 1 个需求缺口 + 5 个应修全部关闭，且都用**自建假 ctx + 磁盘伪造时间**独立复现。
- 提交建议（**不 push**，显式路径，避免带入并行任务改动）：

```text
git add .opencode/plugins/collab.js \
        docs/collab.md \
        .trellis/spec/guides/index.md \
        .trellis/spec/guides/cross-workspace-collab-guide.md \
        .trellis/tasks/11-17-collab-workspace/
# 不要 git add -A / . ；不要提交 packages/**、docs/issues/**、11-17-schema-governance/**
```

- R2-1 / R2-2 / R2-3 可留作后续小改进，不阻塞本次提交。

**一句话汇报**：第二轮复核通过——B1/B2/B3/S1–S4 全部用自建脚本复现成立，harness 124/124 与两处插件健康检查全绿，既有工具行为未变，改动范围干净，可提交（按显式路径、不 push）。
