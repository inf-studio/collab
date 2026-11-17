# 加固笔记：6 条残余风险 + CI 门禁（`11-17-collab-hardening` R1–R2）

> 范围：只改 `.opencode/plugins/collab.js`、`scripts/collab/handoff-harness.mjs`（新建）、`package.json`、
> `.github/workflows/collab.yml`（新建）、`docs/development.md`、`.trellis/spec/guides/cross-workspace-collab-guide.md`、
> `docs/collab.md`、本任务目录。
> **未做**：R3 真实跨仓试点（主会话执行）、`/tmp/collab-sandbox` 清理（主会话收口）。
> 没有 git add / commit / push；没有向受保护会话或其子会话投递；没有删除任何会话。

## 1. 六条风险逐项处置（`file:line` 指改动后的位置）

| # | 风险 | 处置 | 位置 |
| --- | --- | --- | --- |
| 1 | `collab_accept` 不校验领取者血缘 | 领取前先跑 `createLineage(ctx).protectedAncestor(me, protect)`：命中即抛错（自身 / 第 N 级祖先），**预览也拒绝**（fail-closed）。守卫放在 `persistRefresh` / expired / claim / 工作区校验**之前**，因此被拒的调用既不会写锁、也不会改动记录（连租约刷新都不做） | `.opencode/plugins/collab.js:2460-2472` |
| 2 | 接管请求缺完整发起方 sid | 注入行改为 `发起方=<完整 ses_…>` + 可直接复制的 `collab_send {target:"ses_…", text:"DECLINE <bid> <理由>", confirm:true}`；`deliverAsk`（busy>30min 叫醒 / 拉新 prompt）同样带上 `发起方：` 全量 sid 与同一写法；广播结果里补一行「推辞」写法 | `:1514-1534`（injection）、`:1842-1866`（deliverAsk）、`:2263`（broadcast 结果） |
| 3 | `DECLINE` 不带 `bid` | 新增 `DECLINE_BID_RE = /\b(b_[0-9a-f]{8,32})\b/`；`applyDecline` 先按文本里的 `bid` 精确命中；**不带 bid 时只有「恰好一条 open 记录在等这个会话」才生效**，多条同时问询 → 歧义、一条都不动；`bid` 不存在 → 忽略。接管文案一律要求带 bid | `:982-984`、`:1436-1461` |
| 4 | `collab_list` 不刷新租约 | 新增只读判定 `leaseVerdict()`（`claimed` 看 `claim.at`，`open`+`asked` 看 `asked.at`，缺失视为 expired），`collab_list` 按快照输出 `lease=expired|ok` 并追加「只标注、不改状态、不删锁、不推进顺延」说明。**仍然不调用 `refreshBroadcast` / `persistRefresh` / `releaseLock`** | `:702-723`（判定）、`:1970-2002`（列表输出） |
| 5 | 广播目录无清理 | 新增 `BCAST_RETENTION_MS = 7 天` / `BCAST_PRUNE_LIMIT = 20`；`pruneBroadcasts()` 只删 `done|blocked|expired` 且 `updatedAt` 超 7 天的记录，单次最多 20 个，`open/claimed/acked` 一律不动；被删记录的 `<bid>.lock` 一并清掉（避免残留锁毒化同内容重播）。只在 `writeBroadcast()` 里调用 → 预览/列表永不删文件 | `:164-172`、`:548-588`、`:590-599` |
| 6 | guide 措辞与实现 | guide §0 校准基线、§4.3、§5.2 代码块、§5.3 表 + 只读快照说明、§6（只读快照 / 保留与清理）、§9 会话行、§10 #9/#10、§11 验收 + 回归门全部对齐；`docs/collab.md` §12.2 / §12.3 / §12.5 #6-#7 同步 | `.trellis/spec/guides/cross-workspace-collab-guide.md`、`docs/collab.md` |

### 1.1 改动要点（实现细节，便于复核）

- **R1-1**：`protectedAncestor` 自带 `MAX_LINEAGE_DEPTH=8` 与环保护；复用同一函数，不新增血缘逻辑。
  目标会话不存在时 `ctx.session.get` 抛错被吞掉 → 视为无血缘证据（与 `collab_send` 一致）。
- **R1-2**：`record.from.sid` 缺失时文案回退成 `ses_…` 占位并提示「用 collab_inbox 查」，不会渲染 `undefined`
  （与 S22 的既有约束一致）。
- **R1-3**：`DECLINE` 仍是「发起方插件的 inbox 事件流」解析；本次只改**定位**，不改传输。
  歧义时返回 `undefined`（静默不改任何记录），因此不会误伤兄弟交接；代价是歧义下的 DECLINE 会丢失，
  由 5 分钟问询租约兜底（超时等同 DECLINE）。
- **R1-4**：列表里额外输出 `问询=<sid>`，方便人肉看出「在等谁」。
- **R1-5**：清理在 `rename` 之后执行（新记录一定先落盘），读 `readdir` 的当下快照，删除失败只跳过该文件。
  注意：只有写入会触发清理，长期只读的目录不会自行收缩（已知偏差 guide §10 #10 已写明）。

## 2. 新增 / 调整的 harness 用例

harness 从归档目录**复制**到正式位置 `scripts/collab/handoff-harness.mjs`（归档是只读语义，归档内快照未改）。
`repo` 解析从 `../../../..` 改为 `../..`；头部注释更新（路径 / S39–S43 / 迁移原因）。

| 用例 | 断言 | 行 |
| --- | --- | --- |
| S39（7 条） | 受保护会话领取被拒（`自身受保护`）、子会话被拒（`第 1 级祖先 …`）、孙会话连预览也被拒（`第 2 级`）、被拒后记录仍 `open` 且**没有**生成 `.lock`、普通成员仍能领取 | `scripts/collab/handoff-harness.mjs:1679-1724` |
| S40（7 条） | 接管请求注入含 `发起方=ses_req` 与 `collab_send {target:"ses_req"` + `DECLINE <bid>`；两条记录同时问同一会话时，不带 bid 的 DECLINE 两条都不动；带 bid 的 DECLINE 只推进命中的那条（`attempts=1`、`asked` 顺延到次候选）；兄弟记录 `attempts=0`；未知 bid 无副作用 | `:1725-1815` |
| S41（5 条） | `claimed` 且 `claim.at` 超租约 → 列表 `lease=expired`；新鲜 claim → `lease=ok`；列表后记录仍 `claimed`/`attempts=0`/`skipped` 空；`.lock` 仍在；列表带「不改状态、不删锁」说明 | `:1816-1861` |
| S42（6 条） | 造 25 条 8 天前的 `done` + 1 条超龄 `open` / `claimed` / `acked` + 1 条新鲜 `done`；一次写入后只少了 20 条（剩 5）；`open/claimed/acked` 与新鲜 `done` 全在；第二次写入清空积压；第三次写入不再删任何东西 | `:1862-1940` |
| S43（6 条） | guide 与 `docs/collab.md` 措辞对齐断言（accept 血缘、`DECLINE <bid>` + 完整 sid、只读 `lease=expired`、7 天 + `BCAST_PRUNE_LIMIT`、回归门指向 `scripts/collab`、§12 同步） | `:1941-1974` |

新用例全部直接写广播存储文件（`writeRaw`），**不依赖打分阈值 / 拉新 / busy 状态**，避免脆弱耦合。
既有 124 条的**断言**一条未改（只做了格式化 + 3 处 `no-shadow` 改名 + 1 处 `no-unused-vars`：S27 把 `buildSpawn` 用 `out()` 打出来）。

## 3. 门禁改动

- `package.json`：新增 `"test:collab": "node scripts/collab/handoff-harness.mjs"`。
- `.github/workflows/collab.yml`（**新建**）：`ubuntu-latest` + `actions/setup-node@v7`（node 22），
  只跑 `node --check .opencode/plugins/collab.js` 与 `node scripts/collab/handoff-harness.mjs`，
  **不跑 `pnpm install`**（本仓 CI 全新 checkout 装不了依赖，见 `AGENTS.md` / `linter.yml` 注释）。
  triggers：`pull_request[main]` / `push[main]` / `workflow_dispatch`。
- `docs/development.md`：§2 命令表 + §3 质量门 + §5.1 CI 说明 + §5.2 回归面各补一行 `pnpm test:collab`。
- guide §11 回归门：路径改 `scripts/collab/handoff-harness.mjs`，数量改 155，补 CI 说明。

### 3.1 顺带修的坑（harness 进 `scripts/` 后落进 fmt/lint 覆盖面）

`vite.config.ts` 的 ignore 里 `.opencode/**`、`.trellis/**` 被忽略，但 `scripts/*.mjs` 只匹配一层——
`scripts/collab/handoff-harness.mjs` **会被 `vp check`（CI 只读门）检查**。因此：

- 用 `pnpm exec vp check --fix scripts/collab/handoff-harness.mjs` 只对这一个新文件跑了格式化
  （输出改成仓库 canonical 风格：分号 + 单引号），随后 `vp check` 该文件 pass。
- 修掉 4 个 lint error（都是归档版里被 ignore 掩盖的）：
  - `no-shadow` ×3：`tools.find(entry => …)` → `definition`；`checks.filter(entry => …)` / `for (const entry of failed)`
    → `check`（与模块级 `const entry = join(dir, "collab.mjs")` 冲突）。
  - `no-unused-vars` ×1：`buildSpawn` 从未使用 → 改成真正使用它：`out('S27 build spawn result', buildSpawn)`。
- `docs/development.md` 也因新增表格行被要求补齐 padding，已用 `vp check --fix docs/development.md`
  格式化（HEAD 版本本来是 clean，所以 diff 只落在新增行）。
- `docs/collab.md` **在 HEAD 上本来就不满足 fmt**（§3 命令表、§3.1、§11.2、§11.5 等历史表格 padding 不齐），
  属既有格式债；本任务**没有**整篇重构（会把 diff 炸成几百行，且越界）。已单独验证：把当前文件 `--fix` 后
  的 diff 里**没有** §12 的新增段落 → 本次新增内容本身格式合法。

## 4. 原始输出（本机实跑）

```text
$ node --check .opencode/plugins/collab.js
(无输出，exit 0)

$ node scripts/collab/handoff-harness.mjs
  ✓ S39 ...
  ...（155 条全 ✓）
=== 155/155 checks passed
exit=0

$ pnpm test:collab
=== 155/155 checks passed
EXIT=0

$ node -e "JSON.parse(require('fs').readFileSync('package.json'))"
package.json OK

$ pnpm exec vp check scripts/collab/handoff-harness.mjs docs/development.md
pass: All 2 files are correctly formatted (220ms, 32 threads)
pass: Found no warnings or lint errors in 1 file (381ms, 32 threads)

$ python3 -c "import yaml; ..."   # 无 actionlint / yamllint，退化为 PyYAML 结构校验
.github/workflows/collab.yml ok; jobs= ['harness'] ; triggers= {'pull_request': {'branches': ['main']}, 'push': {'branches': ['main']}, 'workflow_dispatch': None}
.github/workflows/linter.yml ok; jobs= ['lint']   （未改动，仅作对照）

$ opencode api get "/api/plugin?location%5Bdirectory%5D=/data/project/muke-pos-app"
collab-global {'status': 'active'}
collab {'status': 'active'}
failed: []
```

闸门自证非恒真（临时把 S43 的一条断言改坏，跑完即删副本）：

```text
$ node scripts/collab/__selftest.mjs     # = harness 副本，S43 一条断言故意改坏
exit=1
=== 154/155 checks passed
FAIL: S43 INTENTIONALLY BROKEN (self-test)
$ rm -f scripts/collab/__selftest.mjs    # 已删，git status 里没有残留
```

新增用例逐条（节选，全部 ✓）：

```text
  ✓ S39 a protected session cannot claim a hand-off — 拒绝领取：ses_e1eb91cebffeTv1467ubJLKebk 在 protect 名单内（自身受保护），受保护会话及其子会话不参与广播领取。
  ✓ S39 the child rejection reports the 1st-level protected ancestor — …（第 1 级祖先 ses_e1eb91cebffeTv1467ubJLKebk 受保护）…
  ✓ S39 a refused claim leaves the record open and takes no lock — {"state":"open","lock":false}
  ✓ S40 the ask line writes the requester's full sid — … 发起方=ses_req …
  ✓ S40 the ask line gives a runnable collab_send DECLINE (target + bid)
  ✓ S40 a bid-less DECLINE with two open asks changes nothing — {"ask":0,"sibling":0}
  ✓ S40 a DECLINE carrying the bid advances exactly that hand-off — {"attempts":1,"asked":"ses_f2","state":"open"}
  ✓ S40 the sibling hand-off waiting on the same session is untouched — {"attempts":0,"skipped":[]}
  ✓ S41 a lapsed claim is reported as lease=expired — - b_aaaa000000000071 claimed lease=expired scope=peer …
  ✓ S41 listing does not refresh the record (still claimed / attempts=0) — {"state":"claimed","attempts":0,"skipped":[]}
  ✓ S41 listing does not release the claim lock — b_aaaa000000000071.lock
  ✓ S42 one write prunes at most 20 records — 5/25 left
  ✓ S42 open / claimed / acked records are never pruned — {"open":true,"claimed":true,"acked":true,"freshDone":true}
  ✓ S42 the backlog finishes on the next write — 0/25 left
```

## 5. 未验证 / 需主会话留意

1. **CI 只在本地语法层验证过**：本机没有 `actionlint` / `yamllint`，只用 PyYAML 解析结构与人工核对
   （`jobs.harness`、三步、无 `pnpm install`、`actions/checkout@v7` / `actions/setup-node@v7` 与既有 workflow 一致）。
   真实 Actions 运行未验证（本任务不 push）。
2. **运行中的 opencode 进程仍是旧代码**：`/api/plugin` 显示 `collab` active 且无 `failed`，但插件是进程启动时
   加载的——新逻辑要等进程重启/新会话生效。未执行 restart（硬约束）。
3. **`collab_accept` 血缘护栏的负面边界**：只按 `protect` 名单 + `parentID` 链判定；宿主若不返回 `parentID`
   则该会话被视为无血缘证据（与既有 `collab_send` 行为一致，未新增失败模式）。
4. **R1-3 歧义取舍**：不带 bid 且多条同时问询时选择「一条都不动」，依赖 5 分钟租约兜底；若后续希望
   「就近回答最新一条」，需要产品决策（本任务按「不误伤」优先）。
5. **R1-5 长期只读目录**：清理只在写入时发生，纯读环境下目录不会收缩（guide §10 #10 已写明，未做定时任务——边界是「不做守护进程」）。
6. **R3 真实跨仓试点未做**（明确划给主会话）；`/tmp/collab-sandbox` 未删（主会话收口）。
7. 未跑 `pnpm lint` / `pnpm typecheck` / `pnpm fmt` 全量：本任务改动不落在 `packages/**`、`apps/**`（根 `package.json`
   只加一个脚本，`collab.js` 在 `.opencode/` 下被 fmt/lint ignore）。只对**新增的** `scripts/collab/handoff-harness.mjs`
   与 `docs/development.md` 跑了只读 `vp check`（现全绿）。`docs/collab.md` 存在**既有**格式债（HEAD 即不满足 fmt，
   见 §3.1），本任务未整篇重构；若 CI 真跑 `pnpm exec vp check` 全仓，该文件在 HEAD 就是红的，不是本次引入。
8. `pnpm lint` / `pnpm fmt` 会**自改文件**，收口时若要用，请只对显式路径执行并复核 `git diff --stat`。
