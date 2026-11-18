# 复核报告：GUI 首启修复 + TUI 状态视图（0.4.2）

- **任务**：`.trellis/tasks/11-18-collab-sidebar-visible`
- **复核人**：Check Agent（冷上下文；实现方 `research/impl-notes.md` 只作线索，不采信其结论）
- **复核对象**：`/data/project/collab` 未提交改动（`git status --short` 见下）
- **日期**：2026-11-18
- **方式**：只读复核 + 自写探针（GUI 打真实 `dist/gui-experimental.cjs`、TUI 打真实 `dist/tui.js` 与 `dist/index.js`），**未修改任何实现文件、未 commit/push/git add**

## 结论

**可提交（0 blocking）。** 10 项必查全部**通过**；3 条自写探针共 **53 项**（17 + 28 + 8）全绿，
构建/类型/回归/打包/文档全绿。另有 8 条**非阻塞风险**（其中 2 条需要 product/宿主侧拍板：
`@opentui` peer 下界、Desktop 里「关闭后是否会被 `list()` 立刻重开」这条只能在图形宿主手工确认）。

| # | 必查项 | 结论 | 我的证据 |
| --- | --- | --- | --- |
| 1 | GUI 首启（`opened==='open'` / `autoOpen` / `list`） | **通过** | 探针 A（17/17，真实产物 + 假宿主） |
| 2 | GUI 不可达占位、不抛 | **通过** | 探针 A：jsdom 真渲染，`panel.unreachable` + 错误文案，无异常 |
| 3 | TUI 只读 | **通过** | 探针 B B6/B7（`client` Proxy 只记录到 `rpc`；产物无写调用） |
| 4 | TUI 三块 + 空态 + 窄终端 | **通过** | 探针 B B2 + 探针 C（width 40 / 20 / undefined + 空态，8/8） |
| 5 | 轮询生命周期（开/切/关闭/重开） | **通过** | 探针 B B3（含 unmount 停摆、侧栏不建定时器） |
| 6 | RPC `queue`（只 `mineFor(session)`、只读、schema 一致、旧 server 兜底） | **通过** | 探针 B A1–A4 + B5（临时 `$HOME` 前后字节/mtime 全等） |
| 7 | 降级（横幅 + `session.list()`，不白屏） | **通过** | 探针 B B4（TUI）、探针 A（GUI） |
| 8 | 构建/打包（无宿主运行时依赖、`npm pack` 三产物） | **通过** | 见 §证据 8 |
| 9 | 回归 608 + 12 + 33 + 17、既有用例无删改 | **通过** | 连续两轮全绿；`git diff --name-only` 无 harness/readonly 文件 |
| 10 | 范围/安全（`BUILTIN_PROTECT`、工具语义、peers optional） | **通过** | `git diff` 逐文件；`PROTECT` 无改动 |

---

## 证据 1–2：GUI（探针 A：`research/gui-probe.mjs`）

产物侧证据（不是源码 grep）：把 **`dist/gui-experimental.cjs` 直接 require 进来**（jsdom 作为 DOM、
`@opencode/plugin/gui` 拦截为真实 ESM 模块 + 仅替换 `usePlugin` 为假 context），
调用 `plugin.setup(fakeCtx)` 后取真实的 `Panel` / `MenuItem` 贡献。

```
  ✓ R1 setup registers a side Panel
  ✓ R2 autoOpen default: list() returns the tab even with nothing open — ["main"]
  ✓ R2 autoOpen default: another plugin tab being open does not remove it — ["main"]
  ✓ R2 the tab id is main and it is a fallback tab
  ✓ R1 + menu "opened" with state undefined (first visit) → false — false
  ✓ R1 + menu "opened" with state closed → false — false
  ✓ R1 + menu "opened" with state open → true — true
  ✓ R1 "opened" is false when no session is mounted — false
  ✓ R1 the + menu still opens the panel (run → layout.open) — [{"path":"collab:main","session":{"id":"ses_a"}}]
  ✓ R2 autoOpen:false → list() is empty until the tab is opened — []
  ✓ R2 autoOpen:false → list() returns the tab once it is open
  ✓ R3 an unreachable RPC does not throw inside the panel render — no throw
  ✓ R3 … and the panel shows the "server unreachable" placeholder — "panel.unreachableconnect ECONNREFUSED 10.0.0.5:4096"
  ✓ R3 … with no stale rows invented
  ✓ R3 a reachable snapshot renders without throwing — no throw
  ✓ R3 … and shows the lease row — "collabpanel.sessions:1ses_abuildalphapanel.currentpanel.locksnamed:buildexclusiveses_apanel.remaining {\"ttl\":\"1m\"}panel."
  ✓ R6 a 0.4.1 server (snapshot without `queue`) still renders — ok

=== 17/17 checks passed
```

对应实现：

- `src/gui.tsx:453` — `opened: !!session && ctx.layout.state(...) === 'open'`（`undefined`/`closed` 均为未打开）；
- `src/gui.tsx:425,439` — `autoOpen = ctx.options?.autoOpen !== false`；`list: input => (autoOpen || input.open.includes(PANEL_TAB) ? [tab] : [])`；
- `src/gui.tsx:417`（`fallback: true` 保留）；
- `src/gui.tsx:303-330`（`PanelView` 的错误块 + `Show` fallback 占位）。GUI 从不读 `snapshot.queue`（`groupByWorkspace` 只用 sessions/locks/handoffs，`src/gui.tsx:163-191`），所以**新客户端 + 0.4.1 server** 也安全（探针最后一项即此用例）。

## 证据 3–7：TUI + RPC（探针 B：`research/tui-probe.mjs`）

A 段用**真实 `dist/index.js`**（`$HOME` 指向临时目录，预置 4 个队列文件：本人 2、他人 1、已撤回 1），
经假宿主拿到 `collab.state.snapshot` 的真实 handler：

```
  ✓ A0 setup registered collab.state.snapshot — ["collab.state"]
  ✓ A1 {session} returns only that sender's items (not ses_other, not revoked) — ["q_1000_aaaa","q_1000_cccc"]
  ✓ A1 oldest first — [["q_1000_aaaa",90007],["q_1000_cccc",10007]]
  ✓ A1 seen / issuePath / bid carried through — [{"seen":true},{"seen":false,"issuePath":"docs/issues/fix-x.md","bid":"b_1"}]
  ✓ A1 ageMs is a positive age, not a timestamp
  ✓ A2 no session named → empty queue (no whole-table scan) — []
  ✓ A2 an unknown session → empty queue, still a valid snapshot
  ✓ A3 the schema requires queue and the top level requires all six keys — ["at","reachable","sessions","locks","handoffs","queue"]
  ✓ A3 every produced item carries every required key — ["queueId","target","ageMs","summary","seen"]
  ✓ A3 types line up (queueId/target/summary string, ageMs number, seen boolean)
  ✓ A4 the snapshot wrote nothing (same bytes + mtimes in $HOME) — identical
  ✓ A4 … and the seen item was not re-stamped
```

> **「只读」是实测的**：调用前后对整个临时 `$HOME` 做了目录树 + 每个文件的 sha256 + mtime 比对，
> 完全一致 ⇒ 没有 `seenAt` 打点、没有 prune、没有 mkdir（`mineFor`→`listFor`→`readQueueItem` 纯读，
> `src/core/owner-queue.ts:135-160`；写函数 `enqueue`/`markSeen`/`pruneSeen` 未被快照路径引用）。

B 段用**真实 `dist/tui.js`** + 假宿主 + `@opentui/solid` 的 `testRender` 无头渲染：

```
  ✓ B1 setup claims session.panel + sidebar.content — session.panel,sidebar.content
  ✓ B1 the command is /collab with ctrl+shift+l and palette — {"slash":{"name":"collab","aliases":["collab-status"]},"bind":"ctrl+shift+l"}
  ✓ B2 the panel renders the three blocks and the summary row
  ✓ B2 the sidebar line is 锁 N · 交接 M · 队列 K — 锁 1 · 交接 1 · 队列 1
  ✓ B3 open panel → more than one poll in 2.3 s — 2 → 3
  ✓ B3 switching to another plugin's panel stops the poll — 3 → 3
  ✓ B3 switching back resumes it — 3 → 5
  ✓ B3 unmounting (panel closed) stops the poll — 5 → 5
  ✓ B3 the sidebar alone keeps no timer (no growth after unmount) — 5 → 5
  ✓ B4 unreachable → banner + host session list, not blank — Collab · ses_probe · --:--:--
  ✓ B4 unreachable sidebar reads collab: n/a
  ✓ B5 a 0.4.1 server (no queue) renders the panel with an empty queue block — true
  ✓ B6 the TUI part only reached client.rpc (no session/tool write path) — rpc
  ✓ B7 dist/tui.js imports only host-provided modules — @opentui/solid,solid-js,solid-js/store,@opencode/plugin/tui
  ✓ B7 dist/tui.js contains no write call (prompt / update / enqueue / writeFile) — scanned

=== 28/28 checks passed
```

要点：

- **只读（#3）**：`client` 用 Proxy 记录所有属性访问，全程只出现 `rpc`；假宿主的
  `session.prompt` / `session.update` 一旦被调用就抛错，未触发。
  `src/tui.tsx` 里除 `client.rpc(CollabState).snapshot()`（`src/tui.tsx:164-176`）外无任何宿主写调用。
- **轮询（#5）**：定时器建在 `createEffect` 里（`src/tui.tsx:411-418`），cleanup 清 `setInterval`；
  我额外验证了**卸载（面板关闭）即停**与**侧栏单独挂载不建定时器**——仓库既有测试只覆盖了
  「切换面板名」和「重开」，这两条是我自己加的。
- **RPC queue（#6）**：`src/rpc.ts:126` 输入加 `session`、`src/rpc.ts:169-185` 输出加 `queue`；
  `src/core/snapshot.ts:176-186` 只有 `readSession(input)` 命中且 source 提供 `queue` 才调用
  （`src/index.ts:153` → `mineFor`）；`toQueueItem`（`src/core/snapshot.ts:119-132`）恒写满
  `queueId/target/ageMs/summary/seen` 五个 required 键，`issuePath/bid` 可选，与 schema 一致。
- **旧 server 兜底（#6）**：`src/tui.tsx:150-161` 的 `normalize()` 对 `queue` 走 `arrayOf()`；
  探针 B5 用「没有 queue 字段」的响应渲染 → `受保护目标队列 (0)`，不崩。

## 证据 4：窄终端 / 空态（探针 C：`research/tui-narrow.mjs`）

```
  ✓ C1 width=40 renders without throwing and stays inside the frame — longest line 44
  ✓ C1 width=40 keeps resource / bid / queueId visible
  ✓ C1 width=20 renders without throwing and stays inside the frame — longest line 44
  ✓ C1 width=20 keeps resource / bid / queueId visible
  ✓ C1 width=undefined renders without throwing and stays inside the frame — longest line 44
  ✓ C1 width=undefined keeps resource / bid / queueId visible
  ✓ C2 empty state names all three blocks instead of an empty pane —   （无租约） | （无交接） | （无排队）
  ✓ C2 the empty sidebar reads 锁 0 · 交接 0 · 队列 0

=== 8/8 checks passed
```

`test/tui-render.mjs` **确实**跑的是真无头渲染，不是文本匹配：
它 `import { createComponent, testRender } from '@opentui/solid'`（`test/tui-render.mjs:26`），
用 `PluginContextProvider` 挂载真实 slot 内容再 `captureCharFrame()` 断言帧；
运行时还会打宿主 OpenTUI 的 `ExperimentalWarning: FFI is an experimental feature`（真 renderer 已加载）。
另核实实现笔记里那条「`<Show>` 空值 → Orphan text error」的前提成立：

```
empty-string THROW Orphan text error: "" must have a <text> as a parent: box-1 above text-node-1
null OK
undefined OK
```

（即：往 `box` 里插空文本节点确实硬抛；因此「扁平 `Line[]` + `<For>`」的偏离是有依据的，
不是无谓改写。补充：我的构造里 `createComponent(Show,{when:false})` 返回 `undefined` 而非 `""`，
没有独立复现出「用 `<Show>` 必崩」，但该偏离本身在三种宽度与空态下均已验证无副作用。）

## 证据 8：构建与打包

```
$ pnpm build
ℹ dist/index.js    321.81 kB │ gzip: 102.17 kB
ℹ dist/index.d.ts  964.27 kB │ gzip: 139.28 kB
✔ Build complete in 4991ms
dist/gui-experimental.cjs  13.46 kB │ gzip: 4.41 kB
✓ built in 112ms
dist/tui.js  17.05 kB │ gzip: 6.36 kB
✓ built in 89ms
```

- `dist/index.js` 的 import 只有 `node:fs / node:path / node:os / node:crypto`；
  `grep -c "@opencode/plugin" dist/index.js` = **0**，无 `require("@opencode…")` ⇒ server 产物零宿主运行时依赖。
- `dist/tui.js` 的 import 恰好四个宿主提供者：`@opentui/solid`、`solid-js`、`solid-js/store`、`@opencode/plugin/tui`
  （即宿主 runtime-module 表里的键，没有多带一份 Solid/@opentui）。
- `dist/gui-experimental.cjs` require：`solid-js/web`、`solid-js`、`solid-js/store`、`@opencode/plugin/gui`（皆为宿主提供）。

```
$ npm pack --dry-run | grep dist/
npm notice 13.5kB dist/gui-experimental.cjs
npm notice 964.3kB dist/index.d.ts
npm notice 321.8kB dist/index.js
npm notice 17.1kB dist/tui.js
npm notice total files: 9
```

`package.json`：`exports["./tui"] = "./dist/tui.js"`、`exports["./gui-experimental"]` 不变；
`peerDependencies` 三个 `@opentui/core|@opentui/solid|solid-js` 均 `optional: true`（`peerDependenciesMeta`）；
`build` = `vp pack && gui && tui`，两个 vite 构建 `emptyOutDir:false`（三产物互不覆盖）。

## 证据 9：回归（连跑两轮）

```
$ pnpm typecheck      → exit 0（无输出）
$ pnpm test           → exit 0
=== 608/608 checks passed      （handoff-harness.mjs）
=== 12/12 checks passed        （readonly-default.mjs）
=== 33/33 checks passed        （snapshot-shape.mjs，18 → 33）
=== 17/17 checks passed        （tui-render.mjs，新增）
$ node scripts/check-skill.mjs
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
```

「既有 608 无删改」：`git diff --name-only` 里**没有** `test/handoff-harness.mjs`、
`test/readonly-default.mjs`；`test/snapshot-shape.mjs` 的 `-` 行只有注释位置与两处数组/对象字面量被扩写
（`-  handoffs: () => broadcasts` → `+  handoffs: () => broadcasts,` / `+  queue: …`），
没有断言被删（`git diff test/snapshot-shape.mjs | grep '^-[^-]'` 共 5 行，全部是上面列举的上下文/字面量行）。

> ⚠️ 一次不可复现的抖动（记录在案，非代码缺陷）：我第一次跑 `pnpm test` 时，
> harness 608 通过后 `readonly-default.mjs` 报 `Cannot find module '/data/project/collab/dist/index.js'`
> （`dist` 是 gitignore 的共享目录，`vp pack` 的 `clean:true` 会先清空它）。
> 随后**单独**重跑该文件 12/12 通过，再连跑两轮 `build → typecheck → test` 全绿；
> 期间核对过没有本仓的并发构建进程（`ps` 里只有别的项目的 `vp dev`）。判断为同工作区另一会话
> 恰在同时构建造成的瞬时窗口，不是本改动的缺陷；发版仍建议按顺序单独跑一次（我已跑两轮）。

## 证据 10：范围与安全

`git diff --name-only`：
`CHANGELOG.md / README.md / docs/collab.md / package.json / pnpm-lock.yaml / src/constants.ts /
src/core/snapshot.ts / src/gui.tsx / src/index.ts / src/rpc.ts / test/snapshot-shape.mjs / tsconfig.json`
+ 新增 `src/tui.tsx / test/tui-render.mjs / vite.tui.config.ts`（+ 任务目录）。

- `src/constants.ts` 只改 `PLUGIN_VERSION = '0.4.2'`（与 `package.json` 一致，harness 的相等断言通过）。
- `git diff … | grep PROTECT` **无输出** ⇒ `BUILTIN_PROTECT` 与 protect 语义未动。
- `src/index.ts` 唯一改动是给 snapshot reader 注入只读 `queue: from => mineFor(from)`（`src/index.ts:153`）；
  工具定义、hook、rpc 注册方式、`allowWrite` 路径零改动 ⇒ **server 工具语义不变**（PRD 边界满足）。
- `pnpm-lock.yaml` 的 `-` 行只涉及 `@opencode/plugin` peer 快照（新增 `@opentui/*` peer 造成），
  没有既有依赖版本被升降。
- 文档（R8）已就位：`README.md:44-84` 两栏（Desktop/TUI）+ 三步排查 + `GET /api/plugin/gui?id=collab`
  的 200-vs-404 解读；`README.md:174` 的测试项数已更新为 608/12/33/17；`docs/collab.md` 增
  「状态视图」小节；`CHANGELOG.md` 0.4.2 段对 R1–R7 逐条说明。

---

## 风险清单（均为非阻塞；按影响排序）

| # | 风险 | 位置 | 说明 / 建议 |
| --- | --- | --- | --- |
| R-1 | **Desktop 侧「关闭后是否会被立刻重开」未能实机验证** | `src/gui.tsx:439` | `autoOpen` 默认 `true` 时 `list()` 恒返回 tab；若宿主把「`list` 里有」当作「显示」，用户关掉面板可能又被列出。PRD 验收第 1 条（首次出现 / 关闭后可重开 / `autoOpen:false` 不自动出现）必须**在 Desktop 手工过一遍**。代码侧三条判定我已用真实 bundle 验证无误。 |
| R-2 | `@opentui/*` peer 下界 `>=0.6.6` 比宿主自己的要求更松 | `package.json:80-82` | `@opencode/plugin@2.3.0` 自己声明 `@opentui/core >=0.8.4`、`@opentui/solid >=0.8.4`（实测其 `package.json`）。0.6.x/0.7.x 未实测，且宿主也不可能满足；建议（需拍板，design 写的是 0.6.6）把下界抬到 `>=0.8.4`，与本机 devDependency（0.9.2）也更一致。 |
| R-3 | 侧栏摘要只在挂载时拉一次 | `src/tui.tsx:436-448` | 面板没开时摘要不会刷新（`RPC` 失败后停在 `collab: n/a`，直到重挂）。与 design「摘要数据来自同一个 2s store」略有偏差；R7 只要求「面板打开时 2s、关闭即停」，故不算违规。若要更实时，可在摘要里维护一个 10–30s 的低频定时器（会与「关闭即停」的措辞冲突，建议明确取舍）。 |
| R-4 | 侧栏与面板共用一份 store 的 `me`（最后 `watch()` 者胜） | `src/tui.tsx:180,209-213,441` | 若宿主把 `sidebar.content` 为**多个会话**各渲染一次，且当前面板属于另一个会话，`queue` 块可能显示别的会话的队列。单会话/当前会话场景无影响（impl-notes §4 已记）。建议给 `watch` 加个「面板优先」的写权，或在宿主 API 明确后改按 sid 分桶。 |
| R-5 | 每次 2s 轮询会全量 `readdir` 队列根 + 每个 target 目录 | `src/core/owner-queue.ts:135-160`（经 `mineFor`） | 与既有「每轮读全部租约/交接文件」同量级；量级 = 所有 target × 其队列文件。当前规模可接受，无缓存。若队列目录变大，可加一次 `stat` 早退或按 `SESSION` 索引。 |
| R-6 | RPC 输出把 `queue` 加进 **required** | `src/rpc.ts:185` | 对严格校验「只允许已知字段 / 必填」的第三方消费者是破坏性扩字段（本仓两个客户端都做了兜底，我已实测旧 server→新客户端 OK）。宿主当前不校验额外字段（无 `additionalProperties:false`）。发版说明里点一句即可（CHANGELOG 已提）。 |
| R-7 | `inFlight` 去重会让「面板刚打开那一刻」的刷新等上一轮 | `src/tui.tsx:178-196` | 侧栏与面板同时挂载时，最多 2s 内看到的是另一会话/上一轮的结果；宽恕范围内。 |
| R-8 | `docs/collab.md:767`「窗口隐藏仍会轮询」与代码相反 | `docs/collab.md:767` vs `src/gui.tsx:402-403` | `createKeyed(() => !pageHidden() && …, …)` ⇒ 窗口隐藏时**停止**轮询。该行**是既有文本**（`git show HEAD:docs/collab.md` 同一行，非本次引入），但既然本次改了同一小节的表格，建议顺手改成「窗口隐藏时暂停轮询」。 |

## 是否有需要修的缺陷

**没有。** 上述 8 条都不构成实现缺陷：R-1 是验收项（需人工），R-2 是需要拍板的取值，R-3/R-4 是已知取舍，
R-5/R-6/R-7 是可接受/文档化的残余风险。按派单「只审不改」，本次未修改任何实现文件。

## 复核产物

| 文件 | 说明 |
| --- | --- |
| `research/check-report.md` | 本报告 |
| `research/gui-probe.mjs` | 探针 A：真实 `dist/gui-experimental.cjs` + jsdom（17 项） |
| `research/tui-probe.mjs` | 探针 B：真实 `dist/index.js` 的 `collab.state.snapshot` + 真实 `dist/tui.js`（28 项） |
| `research/tui-narrow.mjs` | 探针 C：窄终端 / 空态（8 项） |

复跑方式（探针里的绝对路径即当时运行环境；`dist/` 需先 `pnpm build`）：

```bash
mkdir -p /tmp/collab-check && cd /tmp/collab-check
npm i --no-save jsdom
ln -sfn /data/project/collab/node_modules/solid-js   node_modules/solid-js
ln -sfn /data/project/collab/node_modules/@opencode  node_modules/@opencode
ln -sfn /data/project/collab/node_modules/@opentui   node_modules/@opentui
cp /data/project/collab/.trellis/tasks/11-18-collab-sidebar-visible/research/gui-probe.mjs \
   /data/project/collab/.trellis/tasks/11-18-collab-sidebar-visible/research/tui-probe.mjs \
   /data/project/collab/.trellis/tasks/11-18-collab-sidebar-visible/research/tui-narrow.mjs .
cd /data/project/collab
node --conditions=browser /tmp/collab-check/gui-probe.mjs
node --conditions=browser /tmp/collab-check/tui-probe.mjs
node --conditions=browser /tmp/collab-check/tui-narrow.mjs
```

## 是否可提交

**可以提交（附 1 条发版前人工确认）：**

1. Desktop 实机过 PRD 验收第 1 条（首次出现 / 关闭后从「+」重开 / `autoOpen:false` 不出现）——R-1；
2. 若同意 R-2，把 peer 下界抬到 `>=0.8.4`（可选，属改动就需重跑本轮命令）；
3. 发版按 `pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs` 的**顺序单跑**一次（我已连跑两轮全绿）。
