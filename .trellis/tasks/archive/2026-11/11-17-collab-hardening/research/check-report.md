# 独立复核报告：`11-17-collab-hardening`（R1–R2 代码/门禁/文档）

> 复核者：`trellis-check` 冷上下文子会话（只审不改，未 commit / 未 add / 未改实现文件）
> 复核时间：2026-11-17 ~11:00（本机）
> 复核对象（未提交）：`.opencode/plugins/collab.js`、`scripts/collab/handoff-harness.mjs`（新建）、`package.json`、
> `.github/workflows/collab.yml`（新建）、`docs/development.md`、`.trellis/spec/guides/cross-workspace-collab-guide.md`、`docs/collab.md`

## 结论（先说）

**R1 六条 + R2 门禁：通过，可提交（不含 R3/R4）。** 我用**自写的假 ctx 探针**（不采信 harness 断言）逐条复现：
R1-1/R1-2/R1-3/R1-4/R1-5 全部行为正确，且被拒/只读路径**无副作用**（记录字节不变、不写锁、不推进顺延）。
回归三门全绿：`node --check` 0、harness **155/155** exit 0、`pnpm test:collab` exit 0；
额外用**归档版 124 断言 harness 反向跑新插件**，同样 **124/124 exit 0**，证明既有语义未回归。

**任务整体尚不可归档**：R3（真实 peer 试点）与 R4（删 `/tmp/collab-sandbox`）未做——按 implement.md 属主会话执行范围，
但 AC 未满足。另有 1 条**文档与实现不符**（预览清理）、若干低风险项，见文末。

**运行态**：当前服务进程加载的**不是**本次代码（进程 11-15 启动，文件 11-17 10:47 修改），五条新行为需重启后才生效。

---

## 1. R1-1 `protected` / 子会话领取 — **通过**

实现：`.opencode/plugins/collab.js:2454-2478`（守卫位于 `isValidBid`/`readBroadcast` 之后、**`persistRefresh` 之前**，
且预览分支之前 → fail-closed）。

自写探针 `/tmp/opencode/probe.mjs`（自带 ctx，protect = 内置硬名单 `ses_e1eb91cebffeTv1467ubJLKebk`）：

```text
=== R1-1 collab_accept lineage guard
  PASS protected session itself is refused — 拒绝领取：ses_e1eb91cebffeTv1467ubJLKebk 在 protect 名单内（自身受保护），受保护会话及其子会话不参与广播领取。
  PASS direct child is refused with the 1st-level ancestor named — 拒绝领取：ses_pchild 在 protect 名单内（第 1 级祖先 ses_e1eb91cebffeTv1467ubJLKebk 受保护），…
  PASS grandchild is refused even on a confirm:false preview — 拒绝领取：ses_pgrand 在 protect 名单内（第 2 级祖先 …），…
  PASS refused claim leaves the record byte-identical — mtime 1794884297382.3699 -> 1794884297382.3699
  PASS refused claim does not refresh the lapsed ask (attempts/asked untouched) — {"attempts":0,"asked":"ses_slow","state":"open"}
  PASS refused claim creates no lock file — b_0000000000000001.json
  PASS an ordinary member still claims the same record — 已领取 … state=acked
  PASS a sub-session of a NON-protected session can still claim — 已领取 … state=acked
  PASS a protected ancestor at depth 8 is still caught — …（第 8 级祖先 … 受保护）
  PASS RESIDUAL: depth 9 escapes the cap (documented limit of MAX_LINEAGE_DEPTH=8) — 已领取 …
```

**无副作用证据**：探针预置一条「`open` + `asked.at` 已过期 10 分钟」的记录，被拒后 `attempts=0`、`asked.sid` 原样、
文件 mtime 与内容逐字节相同、目录里没有 `<bid>.lock`——即守卫确实早于 `persistRefresh`（否则会顺延成 `attempts=1`）。
「非受保护会话的子会话仍可领取」这条对日常工作流（`trellis-implement` 子会话代领）很关键，harness 未覆盖，我单独验证通过。

## 2. R1-2 完整发起方 sid — **通过**

三处文案（`collab.js:1513-1534` 注入 / `:1843-1866` deliverAsk 叫醒 / `:2260-2263` 广播结果）：

```text
--- injected context（自写 probe2，真跑 collab_broadcast → context hook）
- 接管请求 b_cf7a2c8ba9dc5585：probe worker store 修复（…） 发起方=ses_me → 有余力请 collab_accept {bid:"b_cf7a2c8ba9dc5585", confirm:true}（= ACCEPT）；没余力就回 collab_send {target:"ses_me", text:"DECLINE b_cf7a2c8ba9dc5585 <理由>", confirm:true}（5 分钟不答自动顺延下一候选）。

--- wake prompt（busy 45min 的 top-1，真跑 queue prompt）
发起方：ses_me
领取：collab_accept {bid:"b_e2401da0971994ce", confirm:true}（原子，只有一个 winner；= ACCEPT）
没余力：回 collab_send {target:"ses_me", text:"DECLINE b_e2401da0971994ce <理由>", confirm:true}（5 分钟内不答也会自动顺延给下一候选）

--- broadcast result
推辞: collab_send {target:"ses_me", text:"DECLINE b_36dfa6adee710fbf <理由>", confirm:true}（由被问询的 top-1 发回；不带 bid 且同时有多个问询时不会被采纳）

=== 9/9 R1-2 probe checks passed
```

完整 `ses_…` 均全量写出（无截断），`record.from.sid` 缺失时回退占位而非渲染 `undefined`（读码确认）；两处文案都给了
**可直接复制**的 `collab_send {target:…}`（不必再去 inbox 找发起方）。

## 3. R1-3 `DECLINE` 按 bid 定位 — **通过**

实现：`collab.js:984`（`DECLINE_BID_RE`）+ `:1446-1465`（`applyDecline`）。自写探针（rd：两条记录同时问 `ses_slow`，
第三条问 `ses_member2`）：

```text
  PASS bid-less DECLINE with two open asks on the same session changes nothing — {"d":0,"e":0}
  PASS DECLINE naming a non-existent bid is ignored — {"d":0,"e":0}
  PASS DECLINE naming a hand-off that does not wait on me is ignored — {"other":0,"asked":"ses_member2"}
  PASS DECLINE <bid> advances exactly that record — {"attempts":1,"asked":"ses_member","state":"open"}
  PASS the sibling record asked to the same session is untouched — {"attempts":0,"asked":"ses_slow"}
  PASS a bid-less DECLINE with exactly one open ask still advances it — {"attempts":1,"skipped":["ses_member2"]}
  PASS a backtick-wrapped bid is still resolved — {"attempts":1,"asked":"ses_member"}
```

回归兼容：既有 S33/S34 用**不带 bid** 的单问询 DECLINE，归档版 harness 仍全绿（见 §7）——无行为倒退。
另外注意一个我第一版探针踩到的「正确行为」：当同一会话**同时**欠两条问询时，不带 bid 的 DECLINE 会被判歧义、一条都不动
（我的探针因此先退掉兄弟记录才验证单条路径）——与 guide §5.3 表一致。

## 4. R1-4 `collab_list` 租约只读 — **通过**

实现：`collab.js:703-723`（`leaseVerdict`）+ `:1967-2002`（列表输出，**未调用** `refreshBroadcast` / `persistRefresh` / `releaseLock`）。

```text
  PASS lapsed claim → lease=expired — - b_…0021 claimed lease=expired scope=peer … 承接=ses_member attempts=0
  PASS live claim → lease=ok — - b_…0022 claimed lease=ok …
  PASS lapsed ask on an open record → lease=expired — - b_…0023 open lease=expired … 问询=ses_member
  PASS the list states it is read-only
  PASS list leaves record bytes untouched (expired claim) — mtime 1794884297… -> 同值
  PASS list leaves record bytes untouched (live claim + lapsed ask)
  PASS list does not release the lock of the lapsed claim
  PASS list does not advance attempts / state on the lapsed ask — {"attempts":0,"state":"open"}
  PASS a later accept still performs the real advance (listing did not pre-empt it) — state=expired attempts=1
```

判定口径与 `refreshBroadcast`（`:672-695`）一致：`claimed` 看 `claim.at`、`open`+`asked` 看 `asked.at`，阈值 300 s。
「列表不推进顺延」用两条证据确认：① 记录字节不变；② 之后再 `collab_accept` 才真正 `attempts 0→1`。

## 5. R1-5 广播目录清理 — **通过**

实现：`collab.js:170-172`（7 天 / 20）、`:558-588`（`pruneBroadcasts`）、`:596`（只在 `writeBroadcast` 之后调用）。

```text
  PASS collab_list prunes nothing — 25 -> 25
  PASS a confirm:false preview prunes nothing — 25 -> 25          ← 见 §9 的限定条件
  PASS a single write removes exactly the per-write budget (20) — 25 -> 5
  PASS one write spends its whole budget on the stale backlog (blocked/expired still queued) — stale left 5
  PASS open/claimed/acked (30d) are never pruned — {"open":true,"claimed":true,"acked":true}
  PASS a done record inside the 7-day window is kept
  PASS the lock of the pruned record that had one is removed
  PASS orphan lock (no json) is left alone
  PASS the next write finishes the backlog — 5 -> 0
  PASS blocked / expired older than 7d are pruned once the budget allows
  PASS kept records survive the sweep
  PASS lock of a kept record is still there
  PASS a write with nothing left to prune deletes nothing — 7 -> 7
```

（构造：25 条 8 天前 `done` + 8 天前 `blocked`/`expired` + 30 天前 `open`/`claimed`/`acked` + 6 天前 `done` + 1 条孤儿锁。）
`open/claimed/acked` 与孤儿锁（只有 `.lock` 没有 `.json`）**均不动**，与 guide §6 / §10 #10「被删记录的 `<bid>.lock` 一并清掉」的
措辞一致（未过度承诺）。

## 6. R2 CI 门禁 — **通过**

| 检查 | 结果 |
| --- | --- |
| `package.json:68` `"test:collab": "node scripts/collab/handoff-harness.mjs"` | 可跑，exit 0（§7） |
| `.github/workflows/collab.yml` | PyYAML 解析通过；`jobs=[harness]`；triggers `pull_request[main]/push[main]/workflow_dispatch` |
| 是否依赖 `pnpm install` | **否**（仅 `node --check` + `node scripts/...` 两步；无 pnpm/action-setup） |
| 失败会非零退出 | **是**（见下「门禁非恒真」4 组变异，全部 exit 1） |
| `actions/*` 版本 | `checkout@v7` / `setup-node@v7` —— 与本仓 `linter.yml` / `release*.yml` **一致**（不是本次引入的异常） |
| `docs/development.md` | 4 处写入命令（`:47` 命令表、`:79` 回归清单、`:98` CI 说明、`:119` 回归面表） |

**门禁非恒真验证**（复制插件与 harness 到 `/tmp`，逐项打坏实现，不改仓库）：

```text
mutant R1-1 (guard → false)      === 150/155 checks passed   exit=1
  FAIL: S39 a protected session cannot claim a hand-off 等 5 条
mutant R1-5 (prune → no-op)      === 152/155 checks passed   exit=1
  FAIL: S42 one write prunes at most 20 records / backlog / nothing-to-prune
mutant R1-3 (歧义 → 猜一条)       === 154/155 checks passed   exit=1
  FAIL: S40 a bid-less DECLINE with two open asks changes nothing
mutant R1-4 (claimed → 恒 ok)     === 154/155 checks passed   exit=1
  FAIL: S41 a lapsed claim is reported as lease=expired
```

## 7. 回归 — **通过**

```text
$ node --check .opencode/plugins/collab.js
exit=0

$ node scripts/collab/handoff-harness.mjs | tail -2
=== 155/155 checks passed
exit=0

$ pnpm test:collab | tail -2
=== 155/155 checks passed
exit=0
```

**既有语义未回归（更强证据）**：把**归档版**（124 断言）harness 复制到 `/tmp`、只把 `repo` 改成绝对路径后**指向新插件**运行：

```text
=== 124/124 checks passed
ARCH_EXIT=0
```

另外对 126 个归档断言做了「去格式」语义比较：前缀 126 条中仅 14 处差异，**全部**是格式化造成的箭头函数括号省略
（`(p) => …` → `p => …`），无断言条件/标题被削弱。
工具签名未变：`git diff` 中对 `jsonInput` / `properties` / `required` **零改动**（只有 `collab_accept` 的 description 文本新增了
protect 说明）。

## 8. 范围 — **通过（工作区与其他任务混用，需按文件归属提交）**

`git status --short` 里出现的越界文件**不属于本任务**，证据：

- `packages/schemas/src/reserve.ts` 的 diff 头部自带 `## 报错路径（R2 / Q3=A，11-17-schema-polish）` → 属并发任务 `11-17-schema-polish`；
- `packages/machine/__tests__/reserve-guards.test.ts`、`packages/schemas/__tests__/reserve-conformance.test.ts` 同属该任务（reserve schema 用例）；
- `docs/issues/feat-worker-onboarding-approval-delivered.md`（mtime 11-16 07:27）、未跟踪的 `docs/issues/*`（11-16 / 11-17 07:54）
  **早于本任务创建时间（11-17 10:38）** → 历史未提交残留。
- 复核期间工作区**仍在被其它任务并发写入**（复核前半段只有 schema 线，后半段又出现 `packages/components/src/{room,worker}/card.vue`、
  `packages/provider/src/room/detail/components/ops.vue`、`docs/design/design-deviations.md`、
  `.trellis/tasks/11-17-parity-eng-fix-batch/task.json`、`mcp` 子模块指针），对应在跑的任务目录有
  `11-17-design-code-eng-fixes` / `11-17-parity-design-brief` / `11-17-parity-eng-fix-batch` / `11-17-schema-polish`。
  → **提交时必须按显式路径**（禁止 `git add -A`），且提交前再跑一次 `git status --short` 复核。

本任务自身改动**只**落在：`collab.js`、`scripts/collab/handoff-harness.mjs`、`package.json`、`.github/workflows/collab.yml`、
`docs/development.md`、`.trellis/spec/guides/cross-workspace-collab-guide.md`、`docs/collab.md`、本任务目录。
`.trellis/tasks/archive/**` **零改动**（`git status` 无该项；归档 harness 快照仍在）。
`scripts/collab/` 只有 `handoff-harness.mjs`（`__selftest.mjs` 已清理，无残留）。

## 9. 文档一致性 — **基本通过，1 处与实现不符**

逐条对过 guide §0/§4/§5.2/§5.3/§6/§9/§10/§11 与 `collab.js`：`发起方=`/`发起方：` 两处文案、`DECLINE <bid>` 表、
只读 `lease=expired|ok` 口径、7 天 + `BCAST_PRUNE_LIMIT`、`scripts/collab` 路径与 155 计数**均与代码一致**；
`docs/collab.md` §12.2/§12.3/§12.5 与工具签名一致。

**⚠️ 不符项（低危，需改文案或改实现）——“预览不删文件”不成立**

文档三处断言：guide `:163`「预览与 `collab_list` 永远不删文件」、guide `:222` #10「只读操作（预览 / `collab_list`）不删文件」、
`docs/collab.md:413`「只读命令（预览 / `collab_list`）不删任何文件」。

实测（`/tmp/opencode/probe3.mjs`）：`collab_accept` 的 `confirm:false` **预览**会先 `persistRefresh`（既有设计：租约检查），
一旦该记录有已过期租约 → 触发写入 → 触发清理：

```text
records before preview: 26 (| stale | 25 )
preview content: 未领取（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。
records after preview: 6
live record after preview: {"state":"open","attempts":1,"asked":"ses_m2"}
=> the accept PREVIEW pruned files (side effect)
```

即：`collab_broadcast` 预览确实不写不删，但 **`collab_accept` 预览**会写（顺延）并因此删 20 个旧文件。
建议二选一（都不难）：
1. 文案精确化（推荐，最小改动）：改为「`collab_broadcast` 预览与 `collab_list` 不删文件；`collab_accept` 预览会先做租约检查，
   顺延产生的写回会顺带清理」；
2. 或让 `pruneBroadcasts` 只在非「refresh-only」写入时执行（需要给 `writeBroadcast` 加来源标记，改动更大）。

另两处**文档补漏（info）**：
- `docs/collab.md:262` 的 `collab_accept` 工具表行未提「拒绝 [protected]/[protected-child] 领取」（guide §9 已有；建议同步一行）；
- guide §11 仍有「`/tmp/collab-sandbox` 实测里 b 仓的两个 commit 是人工建的基线」——R4 删除沙箱后该指向会悬空，
  建议改成「见归档 `research/broadcast-samples/`」。

## 10. 护栏（不投递受保护线 / 不删他人会话）— **通过（无违规痕迹）**

- 全局广播存储 `~/.config/opencode/collab-broadcast/`：**0 条记录**，故不存在 `asked/claim/candidates` 命中
  `ses_e1eb91cebffeTv1467ubJLKebk` / `ses_e23a4a23fffe4c4m7UQFR8dUL3` 的历史投递；
- harness 全程使用 `COLLAB_BROADCAST_DIR` 临时目录（跑完真实目录仍为空、mtime 停在 09:09）——回归不会污染真实链路；
- 会话删除路径只有一处：`collab.js:2165`，且只 `remove` **刚落点校验失败的自己新建**的会话
  （`ctx.session.remove({ sessionID: info.id })`，`info.id` 来自本函数 `ctx.session.create`）；无其它删除调用；
- 本次复核未创建/删除真实会话，未 `interrupt`，未重启服务，未 push。

## 11. 运行态一致性 — **⚠️ 运行中是旧代码，新行为需重启**

```text
$ opencode api get "/api/plugin?location[directory]=$PWD"
… {"id":"collab","source":{"type":"local","path":"…/.opencode/plugins/collab.js"},…,"state":{"status":"active"}}
… {"id":"collab-global",…,"state":{"status":"active"}}        （无 failed）
```

但：

- 服务进程 `346860`（`opencode.exe serve --service`，即 API 后端）**启动于 11月15 12:06**，早于 `collab.js` 的 mtime
  （11月17 10:47）；今天没有新的 opencode 进程（`ps` 今天只有 shell）。
- 插件是 `setup` 时一次性 `import`（全局 shim `~/.config/opencode/plugins/collab-global.js` 亦在 `setup` 内 `import`），
  模块实例在进程内缓存。

因此**以下新行为在未重启前不可用**（当前进程仍是旧逻辑）：
1. R1-1 `collab_accept` 的 protect 血缘拒绝；
2. R1-2 接管请求/叫醒/广播结果里的完整 `发起方=` 与可复制 `collab_send` 写法；
3. R1-3 `DECLINE <bid>` 精确定位（旧代码仍会「找第一条 open」）；
4. R1-4 `collab_list` 的 `lease=expired|ok` 标注与只读说明；
5. R1-5 写入时清理 7 天前 `done/blocked/expired`。

我无法排除宿主存在插件热重载（未在本地代码中确认），但按进程启动时间判断**几乎必然仍是旧代码**。
**重启后一行验证**：调一次 `collab_list`，输出里出现 `lease=` 即新代码生效。
（按硬约束我没有重启服务、也没有为验证而调用 `collab_*` 投递。）

---

## 复跑命令（供主会话抽检）

```bash
node --check .opencode/plugins/collab.js          # 0
node scripts/collab/handoff-harness.mjs           # 155/155, exit 0
pnpm test:collab                                  # 155/155, exit 0
pnpm exec vp check scripts/collab/handoff-harness.mjs docs/development.md   # pass（只读）
# 自写探针（不采信 harness 断言；fresh ctx + 临时广播目录）
node /tmp/opencode/probe.mjs     # 41/41 exit 0  —— R1-1 / R1-3 / R1-4 / R1-5
node /tmp/opencode/probe2.mjs    #  9/9  exit 0  —— R1-2（注入 / 叫醒 / 广播结果）
node /tmp/opencode/probe3.mjs    # 见 §9：accept 预览会触发清理
```

## 风险清单（按严重度）

| # | 级别 | 事项 | 证据 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | **低（建议提交前顺手改文案）** | 「预览不删文件」与 `collab_accept` 预览实测相悖（预览 26→6 条） | §9 / `probe3.mjs` | 改 3 处文案，或给 `writeBroadcast` 加来源标记 |
| 2 | 低 | `leaseVerdict` 用 `claim.leaseMs`，`refreshBroadcast` 忽略它 → 非默认 `leaseMs` 的记录列表判 `ok` 但 accept 会顺延 | `probe.mjs` RESIDUAL 用例 | 当前无写入方产生该值（全部 `BCAST_LEASE_MS`），可留 |
| 3 | 低 | 每次写入 `pruneBroadcasts` 会 `readdirSync` + 逐条 `readBroadcast`（**扫描**不设上限，只限删除数），目录很大时写入变成 O(N) | `collab.js:558-588` | 需要时可加「最多扫描 K 条」；当前目录量级无感 |
| 4 | 低（继承） | 血缘上溯上限 8 级：第 9 级子会话可领取 | `probe.mjs` depth 9 用例 | 与 `collab_send` 同口径，`docs/collab.md` 已写「最多上溯 8 级」 |
| 5 | 低（继承） | 孤儿锁（`.json` 已被人工删、`.lock` 残留）永不清 → 同内容重播的 bid 会「已被领取」 | `probe.mjs` 孤儿锁用例 | 文档只承诺「被删记录的锁一并清」，不算过度承诺；可后续加孤儿锁扫描 |
| 6 | info（继承） | `已 expired（attempts=1 > 3）` 文案在「候选耗尽」时自相矛盾（attempts 未超 3） | `probe.mjs` R1-4 段 | 老文案，非本次引入 |
| 7 | info | `docs/collab.md:262` accept 行未提血缘护栏 | §9 | 补一句 |
| 8 | info | guide §11 引用 `/tmp/collab-sandbox`，R4 删后会悬空 | §9 | 改成归档 `broadcast-samples/` |
| 9 | info | harness 实测 ~2.0s（文档写 ~1s） | `time node …` | 无害，可不改 |
| 10 | **阻断归档** | R3 试点未做（全局广播目录 0 条、无 `bid`）、R4 `/tmp/collab-sandbox` 仍存在 | `ls -d /tmp/collab-sandbox` 存在；`~/.config/opencode/collab-broadcast/` 空 | 主会话按 implement.md §4/§5 执行 |

## 是否可提交

**可以提交（R1+R2 范围，按显式路径）**：代码、harness、CI、docs 均通过独立复核，回归与门禁全绿，无越界改动。
提交前建议顺手处理风险 #1（3 行文档措辞）；风险 #2–#9 可留作已知偏差。
提交**不要**带上并发任务的文件（当前至少 4 个任务在跑）：`packages/schemas/**`、`packages/machine/__tests__/reserve-guards.test.ts`、
`packages/components/src/{room,worker}/card.vue`、`packages/provider/src/room/detail/components/ops.vue`、`docs/design/design-deviations.md`、
`docs/issues/**`、`mcp` 子模块、`.trellis/tasks/11-17-{schema-polish,parity-*}/`。
本任务可提交集合应精确为：
`.opencode/plugins/collab.js`、`.trellis/spec/guides/cross-workspace-collab-guide.md`、`docs/collab.md`、`docs/development.md`、
`package.json`、`.github/workflows/collab.yml`、`scripts/collab/handoff-harness.mjs`、`.trellis/tasks/11-17-collab-hardening/`。
R3/R4 完成后才能归档任务。
