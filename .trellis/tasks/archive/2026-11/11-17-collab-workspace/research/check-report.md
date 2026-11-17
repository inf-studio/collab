# 复核报告：统一协作链路（11-17-collab-workspace）

> 复核方式：冷上下文独立复核（只审不改）。实现方自述 `research/impl-notes.md` 只作线索。
> 复核时间：2026-11-17
> 复核对象：`.opencode/plugins/collab.js`、`docs/collab.md`、`.trellis/spec/guides/cross-workspace-collab-guide.md`、任务 `prd/design/implement.md` + `research/`
> 复现脚本（本次新建，均放在 `/tmp/check-collab/`，未改实现）：`repro.mjs`（状态机/并发/幂等/回执）、`score.mjs`（权重/窗口/落盘）、`guard.mjs`（写边界）、`receipt.mjs`（回执解析）、`list-compare.mjs`（旧版对比）、`local.mjs`（local scope 幂等）、`noloc.mjs`（拉新落点校验）

## 结论

**不通过（不可提交）。**

门禁本身全绿（`node --check` 0、harness 87/87 退出 0、两处插件 `active` 无 `failed`），
但**跨仓拉新（spawn）这条路径在 5 分钟后必然进入不可恢复的死锁**，且 **R3/R4 的 `ACCEPT`/`DECLINE` 问询协议没有实现**，
而 guide 明确写着这两件事「已实现 / 已验收」。属于功能缺陷 + 文档与实现不一致，不是措辞问题。

- 阻断 2 项（P0，必须修）：spawn→`acked` 状态迁移缺失；spawn 的 lock 归属错位导致 bid 永久不可领取。
- 应修 5 项：R3/R4 `DECLINE`/问询租约未实现（需求缺口 + guide 失真）；`collab_handoff` 重复调用会复活已闭环 bid 并二次投递；拉新落点校验有空档；回执按裸路径匹配会跨仓/非承接方误闭环；guide 三处断言与实现相反。
- 可留 7 项：软链绕过 `docs/issues` 校验（只读、无写入）、`SCORE_CANDIDATE_LIMIT=20` 截断、`collab_list` 不刷新租约、`allBroadcasts()` 无清理、`expired` 预览也抛错、guide 未进 `guides/index.md`、`bid` 含 mtime 与 AC 措辞不一致。

---

## 必跑命令原始输出

```
$ node --check .opencode/plugins/collab.js
node --check exit=0

$ node .trellis/tasks/11-17-collab-workspace/research/handoff-harness.mjs
...
=== 87/87 checks passed
harness exit=0

$ opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"
  collab-global  active   (/root/.config/opencode/plugins/collab-global.js)
  collab         active   (/data/project/muke-pos-app/.opencode/plugins/collab.js)
  → non-active: none

$ opencode api get "/api/plugin?location%5Bdirectory%5D=/data/project/muke-interface"
  collab-global  active   (/root/.config/opencode/plugins/collab-global.js)
  → non-active: none

$ git diff --stat -- .opencode/plugins/collab.js docs/collab.md
 .opencode/plugins/collab.js | 1584 +++++++++++++++++++++++++++++++++++++++----
 docs/collab.md              |   67 +-
 2 files changed, 1522 insertions(+), 129 deletions(-)
```

（注：工作区里 `packages/**`、`docs/issues/*`、`11-17-schema-governance/**` 等改动来自其它会话/任务，
本任务只动上述 4 类文件；`git status --porcelain packages/ apps/ bench/ | grep '^??'` → 无新增未跟踪文件，
实现方自述的临时探针 `__probe-cfg-scope.test.ts` 确认已删除。）

---

## 11 项逐条结论

### 1. 原子领取 / 幂等 — ✅ 基本成立（spawn 场景例外，见第 2 项）

- 实现：`claimLock` 用 `openSync(path,"wx")`，只允许首个创建者成功，其余读 lock 内容（`collab.js:587-604`）。
- 并发 accept（自建假 ctx，两个同工作区会话同时领取同一 bid）：

```
T3 winners = 1 | first lines: [
  '已领取 b_00591583b6ad8ed1（winner，token=k_mwjzgsu2_asux，state=acked，lease=300000ms）',
  '已被 ses_b1 领取（bid=b_00591583b6ad8ed1，token=k_mwjzgsu2_asux）—— 你不是 winner。不要重复领取，也不要再拉新。'
]
T3 state= acked claim.by= ses_b1
```

- 重复广播同内容（同 mtime）：

```
T4 duplicate broadcast
bid a= b_00591583b6ad8ed1 bid b= b_00591583b6ad8ed1 files 3 -> 3
T4 second: 已存在同一内容的交接（bid 幂等，不新建）：state=acked attempts=0
```

- 预览不落盘：

```
T8 preview / files unchanged: true
```

结论：peer 广播路径的「原子领取 + 幂等」成立；**spawn 路径的 claim 有缺陷（第 2 项）**。
另一个边界：`bid` 含 `mtimeMs`（`collab.js:492-494`），同一内容被 `touch`/`git checkout` 后 mtime 变化会产生第二个 bid
——与 design §2 一致，但与 AC「同一内容不产生第二条 bid」字面有出入，建议 AC 措辞改成「同一内容 + 同一 mtime」。

### 2. 租约与状态机 — ❌ 不成立（阻断）

配置值本身正确：`BCAST_LEASE_MS=300_000`（`:148`）、`attempts > 3 → expired`（`:575`）、`expired` 拒绝领取（`:2127-2131`，实测抛错）。

**缺陷 A（阻断）：spawn 出来的会话无法把自己从 `claimed` 迁移到 `acked`。**
`collab_accept` 在 `record.claim.by === me` 时直接返回、不写状态（`:2137-2145`）：

```
--- T1 broadcast spawn
T1 bid= b_f778ca4978e67347 spawned= ses_spawn_1 state= claimed claim.by= ses_spawn_1
--- T1 spawned session collab_accept
你已领取 b_f778ca4978e67347（state=claimed，kind=spawn，token=k_mwjzgsu...）。
完成后回执: [handoff] BLOCKED b_f778ca4978e67347 <摘要>（用 collab_send 发给发起方 ses_req）。
T1 EXPECTED state=acked per implement.md 偏差#3; ACTUAL state= claimed
```

后果：design §4 / implement.md 偏差 #3 / guide §6:129 都要求「spawn 先 claimed，它自己 `collab_accept` 后转 acked」，
实际永远停在 `claimed` → 5 分钟后按租约回到 `open`，工作被判定「没人接」，接手方还被写进 `skipped`。
另外该分支把 `claimed` 状态的回执模板写成 `[handoff] BLOCKED`，等于引导对方报阻塞。

**缺陷 B（阻断）：spawn 的 lock 归属与 `claim.by` 不是同一个会话，过期后 lock 永远不被释放。**
spawn 时 lock 由**发起方**持有（`:1828` `claimLock(bid,{by:claimer,...})`），而记录里的 `claim.by` 是**新会话**（`:1880-1888`）；
租约过期时 `releaseLock(record.bid, claim.by)`（`:573`）拿新会话 id 去比对 lock 里的发起方 id，必然不匹配 → lock 保留：

```
T2 state= claimed claim.by= ses_spawn_2 lock.by= ses_req
--- T2 member accept after lease expiry
已被 ses_req 领取（bid=b_3cb2a715a6c70efc，token=...）—— 你不是 winner。不要重复领取，也不要再拉新。
T2 after: state= open attempts= 1 skipped= [ 'ses_spawn_2' ]
T2 lock still present (holder is the spawner, not claim.by): true {"by":"ses_req","kind":"spawn",...}
T2 retry first line: 已被 ses_req 领取（bid=...）—— 你不是 winner。
T2 spawned session re-accept first line: 已被 ses_req 领取（bid=...）—— 你不是 winner。
```

后果：记录显示 `open`、attempts 卡在 1（不再增长，因此**永远到不了 `expired`**），但任何会话领取都会被
「已被 ses_req 领取」挡回，而对端成员已被注入「请 collab_accept」。**每次 spawn 5 分钟后必现，且无法自愈**
（只有人工删 `~/.config/opencode/collab-broadcast/<bid>.lock` 才能恢复）。

**顺延/重复询问**：`skipped` 只在租约过期时写入（`:570`），注入与 `collab_broadcast` 重投都会跳过 `skipped`（`:1269`、`:1769`）——机制正确，但只覆盖「领了不干」，
不覆盖「没领也没答」（见第 4 项）。

`expired` 不再被领取、也不再注入：

```
T5 attempts=4 → accept   THROW: 广播 b_... 已 expired（attempts=4 > 3）：需人工接手，不再自动重投。
T5 state= expired
T5 injection after expired: []
```

（小问题：`expired` 时连 `confirm:false` 的**预览**也直接抛错，预览本应只报告状态，见风险表 P2-5。）

### 3. 打分 — ✅ 成立

- 权重与 design §3 一致：45/25/15/10/5 −10（`collab.js:879-929`，注释与系数逐条对应）。
- `why` 含命中文件与命中词：

```
26  fileonly  why=[file:packages/state/src/machine/worker/store.ts, title:zzz]
16  busy      why=[file:..., title:zzz, busy:-10(45m)]      ← busy>30 扣 10 生效
```

- 200 条 / 7 天窗口（把命中藏在第 1 条 / 8 天前，均应不命中）：

```
3  windowed  why=[title:zzz]     ← 300 条里第 0 条的命中被 slice(-200) 丢掉
3  old       why=[title:zzz]     ← 8 天前的命中被窗口丢掉
```

- 不落盘正文（只看工具输入路径，记录里只有 `why` 的路径字符串）：

```
--- record contains message body text?  no (paths only)
--- record size bytes: 898
```

结论成立。取整/比例语义（45×命中比例、25×命中词比例）与 design「ratio」一致。

### 4. 阈值与问询 — ❌ 部分成立（R3/R4 未实现，应修）

- A≥80 才问询：代码 `ranked.find(c => c.score >= BCAST_THRESHOLD)`（`:1796`），harness S24 覆盖 ✅。
- 无候选只拉一个：✅（S27 `exactly one session spawned`；本次 T1/T2 也各只建一个）。
- **「top-1 串行 + 5 分钟问询租约 + `DECLINE` 顺延」没有实现**：
  - `DECLINE` 在实现里只出现在**提示文案**（`:1578`），全文件没有任何解析/监听（`grep -n "DECLINE"` 只有 1 处）；
  - 记录里没有「问询时间/被问候选」字段，`attempts` 只在 `state==="claimed"` 且租约过期时 +1（`:567-574`），
    「被问了但没答」永远不计数，因此**问询级超时顺延不存在**；
  - 实测：回一条 `DECLINE` 后记录完全没变化，再跑一次广播也不会推给次优候选：

```
--- T6 DECLINE
bid= b_c2e7e190336cc99d state= open attempts= 0
T6 after DECLINE: state= open attempts= 0 skipped= [] replies= 0
T6 re-broadcast after DECLINE: 没有需要补发/重投的动作（只提醒发起方一次，见 SessionStart 注入）。
T6 prompts delivered to b2? 0
```

  - 实际形态是「全员注入 + 谁先领取算谁的」，不是 R3 的「top-1 串行问询」。这不一定是坏事（0 成本、更快），
    但它**不是** prd R3/R4 写的协议，也不是 guide §5.3 写的协议。

### 5. 拉新权限 — ✅ 基本成立（落点校验有 1 个空档，应修）

- 默认 `explore`、`impl:<slug>` 标题、带 `location.directory`（`:1847-1851`），S27 实测通过。
- `build` 每次都要求 `agentConfirm:true`，无白名单、无静默升级；缺参数时**先释放 lock 再抛错、不建会话**（`:1838-1844`），S27 通过。
- 空档：落点校验写成 `if (!info?.id || (landed && landed !== workspace))`（`:1858`）——宿主**不返回** `location` 时
  `landed` 为 undefined，判为通过，且返回文案乐观打印 `loc=<workspace>`。实测（假 ctx 模拟旧宿主不回 location）：

```
已广播并拉新（无候选 ≥80）：bid=b_537e20d85476e18e
新会话: ses_nowhere agent=explore loc=/tmp/collab-noloc-.../ws title="impl:fix"
```

按 guide §7「落点不符时回滚刚建的那个会话并报错」，这里应当要求 `landed === workspace`（严格相等）或至少在
缺失时报错/回滚。实际风险：会话落在 `/root`（无插件、无人接）却记成「已投递成功」。

### 6. `peer` 写边界 — ✅ 路径穿越挡住；软链可绕（只读泄露，可留）

```
[relative ok]                          ACCEPTED
[traversal ..]                         REJECTED: 不在 .../ws/docs/issues/ 下
[traversal deep ../../../../etc/passwd] REJECTED: 不在 .../ws/docs/issues/ 下
[absolute /etc/passwd]                 REJECTED: 不在 .../ws/docs/issues/ 下
[workspace is file]                    REJECTED: workspace 不是目录
[symlink → outside workspace]          ACCEPTED   ← 读到了 docs/issues 外的内容（标题 "SECRET outside docs/issues"）
[symlink → /etc/passwd]                ACCEPTED   ← 标题 "passwd"
```

- 写入侧：插件所有文件写入只有 `mkdirSync/writeFileSync/renameSync/unlinkSync`，目标全部 `BROADCAST_DIR`（`:534-537`、`:588`、`:625`）；
  `grep child_process|execSync|git` 无命中 → 不会写目标仓其它文件、不执行任何 git 命令。✅
- 软链空档：`statSync/readFileSync` 跟随软链（`:743-775`），`docs/issues/x.md` 指到仓外也算通过，
  会把仓外文件的一级标题与文件路径写进全局广播记录。仅只读、需要目标仓内先存在该软链，故列**可留**，
  修法很简单：`realpathSync(abs)` 再比对 `issuesRoot`。

### 7. 广播注入 — ✅ 成立（与 inbox 注入是两套独立机制，有一次轻微重复）

- `seenBy` 保证同会话同 bid 只注入一次，`skipped` 的不再注入（`:1269-1278`）；harness S30 三次断言通过：
  `S30 broadcast injected into a group member` / `injected only once per session` / `child sessions get no broadcast` / `protected lines get no broadcast`。
- 与 inbox 注入互不干扰：两者拼进同一个 `system` part（`:2547-2551`），去重键不同（`seenBy` vs `cid/inboxID`），不会互相吞掉。
- 轻微重复：被叫醒的 top-1 会先收到一条 `queue` prompt（接管请求正文），下一轮 context 又会看到一行「群组广播」
  摘要（它不是 user turn，所以 inbox 侧去重管不到）。不影响正确性，可留。

### 8. 回执与提醒 — ✅ 解析健壮；⚠️ 匹配范围过宽（应修）

```
lowercase: claimed -> done note="ok"          # [handoff] done
multiline: open -> blocked note="卡在依赖"     # 状态行在第 2 行
no status line: open -> open                  # 不改状态
double space: open -> done note="x"           # [handoff]   DONE   <bid>
bare basename: open -> done note="byname"     # [handoff] DONE fix.md
```

提醒只一次：harness S30 `reminder happens only once`（第二次注入为 `[]`）；`expired` 不再重投（T5 `injection after expired: []`）。

过宽匹配（应修）：

```
--- T7 cross-workspace receipt
bidB= b_b6fcae9ce409db75 (WS_B)  bidF= b_ad1f206b15ab4cb2 (WS_F)   # 两个仓都有 docs/issues/fix-worker-store.md
T7 after path-only receipt: bidB.state= open bidF.state= done
T7 receipt.from = undefined / ses_f1
```

`applyReceipt` 扫**全机所有** open 记录（`:1204-1220`），只要 `target` 命中 `issuePath` 的 basename 就闭环，
且**不校验 `from === record.claim.by`**。后果：① 同名提案跨仓会误闭环另一条；② 任意会话写一行
`[handoff] DONE <路径>` 就能关掉别人的交接。建议：路径匹配限制在 `record.from.directory` 同仓或 `claim.by` 本人。

### 9. 兼容性回归 — ✅ 成立

- harness S1–S22 原样保留并全绿（`87/87`）；注意 S1–S16 是 print-only（无断言），因此 `send/reply/wait` 的回归主要靠 S17–S22 断言 + 本次代码走读。
- `git diff` 里既有工具只被「搬移/抽取」：`injectInbox` 从 hook 内联改为函数、`collab_list` 改用 `chain.listSessions`、
  血缘循环 `depth < 8` → `depth <= 8`（自身 + 最多上溯 8 级，与 `docs/collab.md` §11.4 对齐，属收紧而非放宽）。
- `collab_list` 不传 `directory` 的旧版对比（HEAD vs 工作区，同一假 ctx）：

```
line 0: OLD="4 个会话（id / agent / state / updated / title）:"
         NEW="4 个会话（id / agent / state / loc / updated / title）:"
...（其余每行仅多 loc=<项目名>）
line 5: OLD="...均不可投递（后者是受保护会话的子会话）。"
         NEW="...均不可投递（后者是受保护会话的子会话）；[bootstrap] 是广播拉起的会话。"
```

判为「仅新增列 + 末尾附加说明」。唯一需注意的是新旧都打印 `未闭环交接` 段（新行为，属附加），旧版没有。

### 10. 范围与护栏 — ✅ 成立

- 本任务改动只落在：`.opencode/plugins/collab.js`、`docs/collab.md`、`.trellis/spec/guides/cross-workspace-collab-guide.md`、`.trellis/tasks/11-17-collab-workspace/**`。
- `packages/**`、`apps/**`、`bench/**` 无未跟踪新文件；其它已修改文件（`packages/schemas/**` 等）目录与主题属于
  `11-17-schema-governance`，mtime 与本任务文件不同批。**无法仅凭 diff 证明归属**，但插件代码本身不写仓库路径（见第 6 项），可交叉印证。
- 受保护会话投递：`rankCandidates` 直接排除 `parentID` 子会话 + `protectedAncestor`（`:1178-1184`），`deliverAsk`/`notifyRequester` 各自再查一次（`:1569-1571`、`:1231-1232`）。
  harness S30 断言 `protected lines get no broadcast`；真实沙箱未发现指向 `ses_e1eb91ce…` / `ses_e23a4a23…` 的 prompt 记录。
- 本次复核**未**新建任何真实会话、未向受保护线投递、未删除实现方会话。

### 11. 文档一致性 — ❌ 不成立（应修）

| # | 文档断言 | 实现 | 结论 |
| --- | --- | --- | --- |
| 1 | guide §6:129 / §11:186「`spawn` 先 `claimed`，它自己 `collab_accept` 后转 `acked`」 | 停在 `claimed`（T1） | **与实现相反** |
| 2 | guide §5.3:93-94「5 分钟内无 `collab_accept` → attempts+1 / skipped / 回 open；`DECLINE` 同样顺延」 | 只有已 claim 的记录才过期；`DECLINE` 完全未解析（T6） | **与实现相反** |
| 3 | guide §11:185「[x] ≥80 才问询；租约 5 分钟（S24 / S29）」 | S29 是手工改 claimed 记录，未覆盖问询级租约 | 勾选过度 |
| 4 | `docs/collab.md` §11.2:262「`collab_accept` 只接受广播所属工作区的会话」 | 会话无 `location.directory` 时只加注、仍可领取（`:2155-2161`） | 措辞过强 |
| 5 | guide §7「落点不符时回滚刚建的那个会话并报错」 | 宿主不回 `location` 时不回滚（`noloc.mjs`） | 与实现不符 |
| 6 | 新增 guide 未被索引进 `.trellis/spec/guides/index.md`（只有 `cross-session-collab-guide.md` 一行） | 孤儿文档，Agent 按索引找不到 | 文档体系缺口 |

`docs/collab.md` §12.5 列的 4 条限制与实现一致（`opencode.json` permissions、`ctx.session.context`、叫醒合并、不 poll），这部分没问题；
但**没有**列入上面 #1/#2 两条真正影响使用的偏差。

---

## 风险清单

### 阻断（必须修，否则不可提交）

| ID | 问题 | 位置 | 复现 |
| --- | --- | --- | --- |
| P0-1 | spawn 的新会话 `collab_accept` 不会 `claimed→acked`，5 分钟后被判定无人接手 | `collab.js:2137-2145` | `T1`（state 停在 claimed） |
| P0-2 | spawn 的 lock 由发起方持有、`claim.by` 是新会话，租约过期只比对 `claim.by` → lock 永不释放，bid 变「open 但谁都领不了」，且 attempts 卡死不再 `expired` | `collab.js:1828`、`:1880-1888`、`:573` | `T2`（lock 仍在、所有人被拒） |

建议修法（供实现方参考，本次未改）：① `record.claim.kind === "spawn" && record.claim.by === me` 时执行与 accept 相同的
lock 校验/升级，把状态写成 `acked`；② lock 里额外记 `claimBy`（记录承接者）与 `by`（真正持锁者）两字段，
`releaseLock` 按 `claimBy` 或 `spawner` 任一匹配释放；③ 加一条 harness：spawn → 新会话 accept → 断言 `acked`；伪造 5 分钟后断言 lock 被释放且次优会话可领取。

### 应修

| ID | 问题 | 位置 |
| --- | --- | --- |
| P1-1 | R3/R4 的 `DECLINE` 与「问询级 5 分钟租约 / 串行顺延」未实现，`attempts` 不覆盖「被问了没答」 | `collab.js:563-579`、`:1578`；guide §5.3 |
| P1-2 | `collab_handoff` 无幂等保护：同 `(target,text)` 重复调用复用同一 bid 但**覆盖**记录 → 二次投递 prompt、threadID 变化、已 `done` 的 bid 被复活成 `acked` 且 `receipt` 丢失 | `collab.js:2023-2087` |
| P1-3 | 拉新落点校验只拒「落了但不是目标目录」，宿主不回 `location` 时不回滚（且文案谎报 `loc=`） | `collab.js:1858`、`:1903` |
| P1-4 | 回执按 `issuePath` basename 全局匹配、不校验承接方 → 跨仓误闭环 / 任意会话可关别人交接 | `collab.js:800-810`、`:1204-1220` |
| P1-5 | guide 三处断言与实现相反（spawn→acked、DECLINE/租约、落点回滚）+ §11 勾选过度 | guide §5.3 / §6:129 / §7 / §11 |

`P1-2` 复现（`local.mjs`）：

```
first bid:  b_6ccf5e6ff64cb640 state: acked thread: t_mwjzitjn_ud5y
prompts after 1st: 1
second bid: b_6ccf5e6ff64cb640 thread: t_mwjzitjx_q62l state: acked     ← 同 bid 被覆盖、thread 换了、又投一次
prompts after 2nd: 2
after forced done: done {"note":"sha1"}
after 3rd handoff (same text): acked receipt: null                      ← 闭环被复活
```

### 可留

| ID | 问题 | 位置 |
| --- | --- | --- |
| P2-1 | `docs/issues/*.md` 软链可指向仓外文件，标题/路径会进全局记录（只读，无写入） | `collab.js:743-775` |
| P2-2 | `SCORE_CANDIDATE_LIMIT=20`：按最近活跃取前 20 才打分，极忙的工作区里第 21 个完美候选不会被发现 | `collab.js:159`、`:1187` |
| P2-3 | `collab_list` 不过 `refreshBroadcast`，列表里的 state/attempts 可能是过期快照（与 `collab_accept` 读到的不一致） | `collab.js:1689-1694` |
| P2-4 | `allBroadcasts()` 每次读全目录、done/expired 永不清理，每次模型请求 O(N) 次读文件 | `collab.js:541-555`、`:1265` |
| P2-5 | `expired` 时连 `confirm:false` 预览也抛错（预览宜只报告） | `collab.js:2127-2131` |
| P2-6 | 新增 guide 未加入 `.trellis/spec/guides/index.md` | `guides/index.md:20-32` |
| P2-7 | `bid` 含 mtime，`touch` 同一提案会产生第二个 bid（与 design 一致，但与 AC 措辞不一致，建议改 AC） | `collab.js:492-494` |

---

## 是否可提交

**否。** 建议顺序：

1. 修 P0-1 / P0-2（spawn 状态机 + lock 归属），补 harness：spawn → accept → `acked`；租约过期 → lock 释放 → 次优可领取。
2. 二选一处理 P1-1：要么实现 `DECLINE` 解析 + 问询级租约（`askedAt`/`asked` 字段，读记录时推进），
   要么把 prd R3/R4 与 guide §5.3 明确降级为「全员广播 + 领取即承接」（需产品确认，不能既不改 code 又保留 [x]）。
3. 修 P1-2（`collab_handoff` 幂等：`done|blocked|expired` 直接返回，不覆盖）、P1-3、P1-4。
4. 回写 guide 三处断言 + 索引行，然后重跑 `node --check` / harness / 两处 `/api/plugin`。

修完后需要重新复核（尤其 P0 两项必须附「伪造 5 分钟后」的复现输出，而不是只跑正常路径）。
