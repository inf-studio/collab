# 复核报告：R-7 修复 + Desktop 可见性探针（0.5.2）

- 任务：`.trellis/tasks/11-18-collab-desktop-probe`
- 复核角色：独立复核（冷上下文，**只审不改**；未改任何实现文件，未 commit / add / push）
- 被复核对象：工作区未提交改动 `src/gui.tsx`、`test/gui-entry.mjs`、`src/constants.ts`、`package.json`、
  `README.md`、`docs/collab.md`、`skills/collab/SKILL.md`、`CHANGELOG.md`（`git diff --stat`：
  8 files, +441 / −38）
- 复核日期：2026-11-18
- 参考：`prd.md`（R1–R5）、`design.md`（§1–§6）、`implement.md`、`docs/issues/bugs-gui-poll-inflight-stale-session.md`、
  `.trellis/spec/`（本仓无 lint 脚本，质量门 = `tsc --noEmit` + 三套 harness）

## 结论

**可提交（无阻断缺陷）。** 8 项必查全部**通过**；`dispose 后不补排` 一项由我独立探针证实（测试套件未覆盖，
见 R-1）。3 条**非阻断**问题，均为「注释/文档措辞与实测不符」或「测试缺口」，不改行为：

| # | 级别 | 内容 | 位置 |
| --- | --- | --- | --- |
| N-1 | 低（建议合并前顺手改） | `finally` 注释与文档称「隐藏窗口不轮询」；实测：可见→隐藏后**仍在轮询**（只是被浏览器节流）；隐藏状态下挂载时**永不恢复**（`pageHidden()` 不可响应） | `src/gui.tsx:164-166`、`docs/collab.md` §11.11「刷新」行、`test/gui-entry.mjs:472` |
| N-2 | 低（测试缺口） | PRD 验收含「dispose 后不补排」，套件无对应断言（变异 M5 存活）；行为已被我的探针证实正确，且 `load()` 首行 `if (disposed …) return` 形成第二道防线 | `test/gui-entry.mjs` §9 |
| N-3 | 低（记录准确性） | `implement.md`/`impl-notes.md` 称断言行已改写为「the poller's key names whatever session is routed…」，仓库里实际仍是「the key restarts the poll when it shows again」——后者所述机制为**假** | `test/gui-entry.mjs:472` |

未发现：功能回归、并发风暴、写路径、契约变更、版本漂移、范围越界。

---

## 方法与边界

1. **不采信 impl-notes 的结论**，只把它当线索；所有断言均用我自己的探针在**已构建的产物**
   （`dist/gui-experimental.cjs`，即宿主实际求值的文件）上复现。
2. 探针脚本全部在 `/tmp/opencode/`（`probe-final.mjs`、`probe-dispose2.mjs`、`probe-hidden-*.mjs`、
   `probe-close-session.mjs`、`mutate.mjs`）——**未向仓库写入任何临时文件**。
3. 变异验证只改**产物**（`dist/` 在 `.gitignore:2` 内，且脚本备份后 `pnpm build` 重建），不改源码。
   复核结束时除本报告外 `git status --short` 与开工时一致（8 个允许文件 + 未跟踪任务目录）。
4. 双 Solid 实例坑（前次复核 R-9）：bundle 是 CJS（`createStore`/`onCleanup`），SDK 是 ESM
   （`createKeyed`/effects）。探针里用 **ESM signal + 嵌套 CJS root/ESM root** 才能同时拿到「响应式」
   与「真实 onCleanup」。仓库测试只在 ESM 侧有 owner，因此**无法**验证 dispose（正是 N-2 的成因）。

---

## 逐条复核

### 1. R-7 正确性 —— **通过**

`src/gui.tsx`：

| 检查点 | 证据 |
| --- | --- |
| `wanted` 在**发请求前**记录 | `:141 const wanted = currentSessionID();`（在 `inFlight = true` 之后、`try` 之前） |
| 请求体用的就是 `wanted` | `:151 snapshot(wanted ? { session: wanted } : {})`（与 0.5.1 读 `current.id` 同一时刻，等价，无行为漂移） |
| `finally` 里**先** `inFlight = false` **再**判补排 | `:162 inFlight = false;` → `:167` 判断 |
| 条件逐字为 `!disposed && !pageHidden() && currentSessionID() !== wanted` | `:167` |
| 单一实现、无第二处补排 | `grep -n "void load()" src/gui.tsx` 只有 `:167`；`store.load()` 的另一处是 poller（`:528-529`），属原有轮询 |

我自己的四种场景（`/tmp/opencode/probe-final.mjs`，慢 RPC 300 ms，请求在飞时切会话）：

```
  PASS 1a one request is out before the switch :: 1
  PASS 1b the slow reply landing is followed by exactly one more request :: [{"input":{"session":"ses_A"},"at":1},{"input":{"session":"ses_B"},"at":303}]
  PASS 1c the second request names the session that is routed now :: {"session":"ses_B"}
  PASS 1d the re-run is immediate (<= 40 ms after the reply) :: 3
  PASS 1e the reply that landed first was the old session (A) :: {"session":"ses_A"}
  PASS 1f concurrency never exceeded one request :: {"maxLive":1}
  PASS 2a inside the first tick an unchanged session makes one request :: 1
  PASS 2b one request per tick across two ticks (t≈0, 2 s, 4 s) :: [0,2000,4001]
  PASS 2c no request names anything but the routed session :: [...ses_A x3]
  PASS 3a a hidden window does not re-queue the dropped reload :: 1
  PASS 3b showing it again does not resurrect it either (policy: hidden ⇒ no poll) :: 1
  PASS 4a after dispose the in-flight reply starts no request :: 1
```

- **立即**：旧包落库（t=300）→ 第二次请求在 **t=303**（延迟 3 ms），不是下一个 tick。提案里 0.5.1 的复核实测是
  2303 ms，形态一致、已消除。
- **未切换不补排**：跨两个 tick 只有 3 次请求，且都带 `ses_A`（对应 PRD「每 tick 仍 1 次」）。
- **隐藏期间不补排**：`document.hidden = true` 后切会话 → 仍 1 次。
- **dispose 后不补排**：用嵌套 root（CJS root 提供 `onCleanup` owner、ESM root 提供 `createKeyed` owner）
  在请求在飞时 dispose（`/tmp/opencode/probe-dispose2.mjs`）：

```
dispose mid-flight: [{"input":{"session":"ses_A"},"at":1}]
  PASS dispose: the in-flight reply starts nothing
no dispose: [{"input":{"session":"ses_A"},"at":1},{"input":{"session":"ses_B"},"at":302}]
  PASS no dispose: re-queue for B
```

### 2. 不会打爆 —— **通过**

- **链条有界**：`:141` 每次都重记 `wanted`，`:167` 只在「本轮目标 ≠ 当前」时补一次 → 每次请求至多派生 1 次；
  第二次请求若会话未再变即停。
- **`inFlight` 仍有效**：25 次快速切换（每 7 ms 一次，慢 RPC 120 ms）→ 并发峰值 **1**、总请求 **2**
  （`probe-final.mjs`）：

```
  PASS 5a concurrency never exceeded one request :: {"maxLive":1}
  PASS 5b the last request names the final session :: {"session":"ses_B"}
  PASS 5c 25 switches stay bounded (<= 8 requests, no storm) :: 2
  PASS 5d the chain terminates (no further request while the session holds) :: {"settled":2,"after":2}
```

- **无死循环**：会话稳定后链条自停（5d）。
- 一个**良性**末梢：若请求在飞时把会话关掉，`currentSessionID()` 变 `''` ≠ `wanted` → 多一次 `snapshot({})`
  然后自停（实测 2 次后终止，`/tmp/opencode/probe-close-session.mjs`）。只读、有界，面板转成全局视图，可接受。

### 3. 探针语义 —— **通过**

`src/gui.tsx:616` 函数形式注册（`ctx.add(TitlebarItem, () => …)`，与 SDK `core.d.ts:340-357` 的 reactive
factory 契约一致；`registries.d.ts:560` 的 `TitlebarItem` 字段 `id/label/title?/icon?/run?()` 全部命中）。

| 断言 | 结果 |
| --- | --- |
| 无快照 `label === 'collab'`（**不含 `0`**） | `PASS 6a :: "collab"` |
| 有快照 `collab N`，N = locks+handoffs+queue | `PASS 6h :: "collab 6"`（2 锁 + 1 交接 + 3 队列，`probe-final.mjs`） |
| 有快照且三者皆空 → `collab 0`（数据是事实，不隐藏） | `PASS 6i :: "collab 0"` |
| `id/icon/title` | `PASS 6b :: {"id":"status","icon":"lock","title":"协作状态 — 打开面板"}` |
| 有会话点击 → `layout.open('collab:main', session)`、**0 toast** | `PASS 6c :: {"opened":1,"toasts":0}` |
| 无会话点击 → **1 toast、0 open** | `PASS 6d :: {"opened":0,"toasts":1}` |
| toast 文案含版本 / id / panel / app(platform) | `PASS 6f :: "插件 v0.5.2 · id=collab · panel=collab:main · app=2.4.1(desktop)"` |
| 命令与 pill 共用同一文案 | `PASS 6g`（逐字段相同） |

`icon:'lock'` 合法（类型编译通过，`IconName`），`title` 走 i18n（zh/en 均有键）。

### 4. 只读 —— **通过**

- 新增代码的全部对外调用：`ctx.layout.open`（`:602`、`:627`）与 `ctx.toast.show`（`:501`）；读侧
  `ctx.id` / `ctx.t` / `ctx.app.version` / `ctx.app.platform` / `ctx.sessions.current()`。
- `grep -nE "unlock|release|archive|lock\(|prompt|tools\." src/gui.tsx` 的 4 处命中全是注释
  （`:13`、`:645`）与 `fmtClock` / `panel.readonly` 文案（`:73`、`:370`），没有写调用。
- RPC 只有既有的 `CollabState.snapshot`（读）：`:151`。
- `src/core/**`、`src/rpc.ts`、`src/tui.tsx` **未出现在 diff 内**（`git status --short` 只有 8 个允许文件 +
  未跟踪的任务目录）。
- 严格 Proxy harness 仍覆盖 `setup`（未声明的 `ctx.x` 读取即抛），测试里「注册时零 RPC」仍为 `0 calls`。

### 5. 版本一致性 —— **通过（含一个已兜住的漂移风险）**

| 位置 | 值 | 证据 |
| --- | --- | --- |
| `package.json` | `0.5.2` | `git diff package.json` |
| `src/constants.ts:310` | `PLUGIN_VERSION = '0.5.2'` | 同上 |
| `src/gui.tsx:60` | `PLUGIN_VERSION = '0.5.2'`（bundle 本地重述） | toast 实测 `v0.5.2` |

**为什么 `gui.tsx` 必须本地重述**：`src/constants.ts` 顶层 `import { homedir } from 'node:os'` /
`import { join } from 'node:path'`（`:1-2`），且 `CONFIG_PATH` 在模块求值时就调用 `join(homedir(), …)`；
GUI bundle 在窗口里跑，无 `node:os/node:path`。所以「重述」是这个架构下的合理最小做法，
**不是**偷懒复制。

**漂移风险已被测试兜住**：`test/gui-entry.mjs:377` 同时比对 `package.json` / `src/constants.ts` 正则 /
toast 文案三处，任一处单独改动即红（我的 M2 反向验证了它确实在检查 toast 内容）。三处之外还有
`test/handoff-harness.mjs:4241` 断言 `PLUGIN_VERSION === package.json.version`。风险等级：低。

### 6. 测试真实性（变异验证）—— **通过（4/5 组被抓住，1 组因断言缺失存活）**

只改**构建产物**、只重建不重编译源码的方式做了 5 组变异（`/tmp/opencode/mutate.mjs`，脚本输出原文）：

```
baseline: green
  === 33/33 checks passed

M1 drop the R-7 re-queue (finally: only clear inFlight)
  RED as expected
  === 32/33 checks passed
  ✗ R7 switching while a request is in flight reloads at once, naming the new session — 1 → 1: [{"session":"ses_probe"}]

M2 label always counts (collab 0 with no snapshot)
  RED as expected
  === 32/33 checks passed
  ✗ R2 with no snapshot yet the pill reads "collab", never "collab 0" — collab 0

M3 command loses the probe-toast fallback
  RED as expected
  === 31/33 checks passed
  ✗ R1/R3 without a routed session the command is disabled and run() falls back to the probe toast — {"enabled":false,"opened":0,"toasts":0}
  ✗ R3 the command with no session shows the same toast as the pill (one implementation) — null

M4 re-queue ignores pageHidden()
  RED as expected
  === 32/33 checks passed
  ✗ R7 a hidden window queues no reload (the key restarts the poll when it shows again) — 2 calls

M5 re-queue ignores dispose
  STILL GREEN — the assertion is not sensitive to this
  === 33/33 checks passed
```

- 目标断言真的会失败（不是「声称跑了」）；**失败项数与 impl-notes 记录一致**（M1 一处、去掉 toast 分支 5 处
  ——我用 M3 只去掉命令分支得到 2 处，属同一族）。
- M5 存活的原因已查明，**不是**测试造假：`load()` 首行 `if (disposed || inFlight) return` 已使 disposed
  之后的补排成为空操作，所以去掉 `!disposed` 后行为不变。⇒ 行为上 `dispose 后不补排` 成立（我的探针证实），
  但套件里**没有**这条断言（N-2）。
- **既有 21 项未被弱化**：按断言行名做 `comm` 比对（`git show HEAD:test/gui-entry.mjs` vs 现文件），
  唯一变化是 `R1 without a routed session … no-op` → `R1/R3 … falls back to the probe toast`，
  新断言**多加** `toasts.length === 1`（更强，且是 R3 要求）。其余 18 条具名断言原样保留，
  **没有任何旧断言被删或放宽**。

### 7. 回归与范围 —— **通过**

`pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs`（原始输出摘要，退出码 0）：

```
=== 638/638 checks passed
=== 12/12 checks passed
=== 35/35 checks passed
=== 29/29 checks passed
=== 33/33 checks passed
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
EXIT=0
```

`pnpm typecheck`（`tsc --noEmit`）无任何输出。计数与 PRD「638 + 12 + 35 + 29 + 21」预期一致（GUI 21 → 33）。

范围：`git status --short` 仅 `CHANGELOG.md` `README.md` `docs/collab.md` `package.json`
`skills/collab/SKILL.md` `src/constants.ts` `src/gui.tsx` `test/gui-entry.mjs` + 未跟踪任务目录。
`git diff package.json` 只有 `version` 一行 → **无新增运行时依赖**。

### 8. 文档事实 —— **通过（一处措辞不准，见 N-1）**

| 要求（PRD R5） | 证据 |
| --- | --- |
| README 四步（① 插件行 GUI 开关 ② 命令面板搜 collab ③ pill ④ 无会话点 pill/命令弹 toast） | README「### Desktop 看不到 collab？四步排查」——四步齐全，顺序与 PRD 一致 |
| `docs/collab.md` §11.11 / §11.11.4 同步 | §11.11 GUI UI 表新增「标题栏 pill（0.5.2）」行；新增 **§11.11.4「Desktop 排查（0.5.2）」**，含「已确认的 / 尚未确认的」分栏 + 判定表 |
| **必须写**「远端服务器是否加载 GUI 尚未确认」 | README：「**远端服务器是否加载 GUI 目前尚未确认**」；docs：「**远端服务器是否加载 GUI，目前尚未确认。**」；SKILL：「远端是否加载 GUI 尚未确认」；CHANGELOG 同句 |
| 不得断言平台缺陷 | README「不是平台缺陷的结论」；docs「本节**不下平台缺陷的结论**」「这属于「尚未确认」的部分，本节不下结论」 |
| 不得声称 Desktop 有左侧栏 | 新排查段（README 四步 / §11.11.4）**未**出现「左侧栏」。README 入口表仍列出「侧栏 `collab` 标签 / **+** 菜单」——那是本插件**贡献**的入口清单（该行本就存在，本次只是重排为 ③④），且同段已声明「窗口里也没有 collab 的任何部件」是待查现象。判定：可接受 |
| `mod+shift+l`（Desktop）与 `ctrl+shift+l`（TUI）分开书写 | README 表格分列两行、四步里写 `mod+shift+l`；docs §11.11.2 步骤 3 的 Desktop/TUI 分行；SKILL 亦分开 |
| 401 不得当作「没加载」 | docs §11.11.2 + §11.11.4 明确「401 是鉴权，不是 404/没加载」，与用户自述一致 |
| CHANGELOG 0.5.2 | 顶部新增 `## [0.5.2] - 2026-11-18`，Fixed / Added / 只读 / 测试 / 文档 分节，写明「远端 GUI 是否加载尚未确认」 |

文档与实现一致（pill 的 label 规则、N = 锁+交接+队列、toast 字段、`options.autoOpen:false` 下 pill 仍在
——pill 是无条件 `ctx.add`，已核对）。

---

## 附加实测（超出必查项，供主会话决策）

**N-1 的原始证据**（`pageHidden()` 不可响应，只在 key 求值的那一刻被读一次）：

```
# 可见挂载 → 隐藏 → 继续观察 2.4 s（/tmp/opencode/probe-hidden-tick.mjs）
hidden at +151ms, calls so far: 1
still hidden at +2554ms, calls: [{"input":{"session":"ses_A"},"at":1},{"input":{"session":"ses_A"},"at":2003}]
```

```
# 隐藏状态下挂载 → 显示 → 切会话（/tmp/opencode/probe-hidden-recover.mjs）
mounted hidden, sessions=[], calls: 0
sessions list changed while still hidden, calls: 0
shown, calls: 0
routed session object changed, calls: []
```

⇒ 文档/注释里「隐藏时暂停、恢复后继续」两半都不准确：

- **可见→隐藏**：`setInterval` 已建立，`pageHidden()` 不是响应式的 → **继续轮询**（真机上会被 Chromium
  对隐藏页的定时器节流，但那是节流不是暂停）；
- **隐藏时挂载**：key 求值时 `pageHidden()` 为真 → 返回 `false`，且**没有读到** `sessions.current()`，
  于是 memo 不依赖路由会话；`document.hidden` 又不是响应式的 → 除「会话列表变化」外**无法恢复**
  （连切会话都唤不醒，因为 memo 没订阅 `current()`）。

两者都是 **0.5.1 既有行为**（`git show HEAD:src/gui.tsx` 的 key 函数同款），不是本次引入；对 R-7 的影响是
「隐藏期间最多退回到下一个 tick 的旧数字」，也就是本来就要修的那个上限，可接受。但**新注释与测试标题**把
一个更强的结论写成了事实，建议改口径（见建议 ①②）。

---

## 风险清单（均非阻断）

| 风险 | 影响 | 处置建议 |
| --- | --- | --- |
| R-1 「dispose 后不补排」无断言 | 该验收项只能靠人复核；将来若有人把 `load()` 首行的 `disposed` 判断挪走，测试不会红 | 建议补 1 条（见建议 ③）；本期可接受 |
| R-2 「未切换每 tick 1 次」仅覆盖 ~600 ms（不满一个 tick） | 若补排条件写错成「总是补」，仍会被抓到（立即风暴）；但「tick 仍为 1」这一半未被真正计时 | 我的探针已覆盖 t=0/2000/4001 三次；如需入库，可把该用例等到 4.2 s（代价 +3.6 s） |
| R-3 隐藏时挂载的轮询永不复活（既有） | 后台标签页/最小化启动的窗口可能永远拿不到快照，直到会话列表变化 | 另开 issue（需要宿主提供响应式的可见性信号，或 `document.visibilitychange` 监听 + `ctx` 提供的钩子）；本版非目标 |
| R-4 会话关闭瞬间多 1 次 `snapshot({})` | 只读、有界（实测 2 次后终止）；面板短暂转全局视图 | 无需处理，记录备查 |
| R-5 `TitlebarItem.id = 'status'` 是通用名 | 若宿主按全局 id 复用 pill 元素，理论上可能与其它插件撞 | SDK 官方示例同样用通用名（`id:"update"`），注册表是 per-plugin 的 `ctx.add`，判定无需处理 |
| R-6 三处版本号 | 已由两套测试兜住；但若只跑 `node test/gui-entry.mjs`（不 `build`），断言看到的是旧产物 | `pnpm test` 脚本本身先 build，已覆盖 |

---

## 建议（仅在「顺手修」时才做；我未改任何文件）

① `src/gui.tsx:164-166` 注释措辞（不涉及逻辑）：

```diff
-      // A hidden window polls nothing (the poller only runs while the window is
-      // visible), and a disposed store is silent.
+      // A window that mounts hidden never starts the poller, and a disposed
+      // store is silent. (A window hidden *after* mounting keeps its interval —
+      // `document.hidden` is not reactive — so the next tick covers this case.)
```

② `docs/collab.md` §11.11「刷新」行 + `test/gui-entry.mjs:472` 断言行名：

```diff
-| 刷新 | … **窗口隐藏时暂停**（`pageHidden()`），恢复可见后继续；…
+| 刷新 | … 窗口在**隐藏状态下挂载**时不启动轮询（`pageHidden()` 只在挂载/会话变化时求值）；…
-  'R7 a hidden window queues no reload (the key restarts the poll when it shows again)',
+  'R7 a hidden window queues no reload and does not resurrect it when shown',
```

③ 若要补「dispose 后不补排」（N-2），在当前 harness 下需要**双 owner**（bundle 是 CJS `onCleanup`、SDK 是
ESM `createKeyed`），可复用我 `/tmp/opencode/probe-dispose2.mjs` 的嵌套 `createRoot` 写法；也可以退一步：
在 harness 暴露 `store.dispose()` 的等价入口（当前 `setup` 不返回 store）。我判定**本期可不做**——
行为正确且有两道防线，缺口只是回归保险。

---

## 一句话汇报

**0.5.2 可提交**：R-7 三条件逐字落地、慢 RPC 下旧包落库后 **3 ms** 内补发且带新会话、25 次快速切换并发恒为
1（总 2 次请求）、未切换跨两 tick 仍每 tick 1 次、隐藏与 dispose 均不补排（dispose 由我独立探针证实，套件缺该
断言）；探针语义与只读边界全绿，5 组变异中 4 组被套件抓住（第 5 组因断言缺失存活，但行为由 `load()` 首行
兜住）；`638+12+35+29+33` 与 `check-skill` 全绿，版本三处一致，文档四处齐全且明确写「远端是否加载 GUI
尚未确认」。唯一值得顺手改的是 3 处**措辞**：`pageHidden()`「隐藏即暂停/恢复即可继续」的说法与实测不符
（可见→隐藏仍在轮询、隐藏时挂载永不恢复，均为 0.5.1 既有行为，不影响本次修复的正确性）。

---

## 增量复核（可见性重构）

- 日期：2026-11-18（第二轮，增量）
- 范围：`src/gui.tsx` 的 `startPolling` / `stopPolling` / `visibilitychange` 重构、`test/gui-entry.mjs` 的
  document stub + Solid 单实例映射 + 4 条新断言、`docs/collab.md` §11.11「刷新」行、
  `.trellis/spec/frontend/opencode-plugin-ui.md` §2、CHANGELOG、README 计数
- 只审不改：未改实现/测试/文档，未 commit/add/push（结束后 `git status --short` 仅那 9 个文件 + 任务目录）
- 方法：不用仓库 harness。自写两套探针，**分别模拟「单 Solid 实例」（真机）与「双实例」（当前测试环境）**，
  并给 `setInterval`/`clearInterval` 打桩，直接观测**存活定时器数**（仓库测试只能间接看请求数）。

### 结论

**可提交（行为正确，无阻断）。** 6 项必查中 5 项**通过**；第 3 项（单实例映射）**不通过**——不是产品缺陷，
而是**测试基础设施**：映射走 pnpm 软链路径，`require(esm)` 与 `import()` 拿到的是**两份** Solid，
bundle 的三处 `onCleanup` 在套件里从未执行。修法是一行 `realpathSync`（已实测有效）。

| # | 级别 | 内容 |
| --- | --- | --- |
| D-1 | **建议修（1 行）** | `test/gui-entry.mjs:88-89` 映射用软链路径 → bundle 与 SDK/测试仍是两个 Solid 实例（实测 `createSignal` 身份 `false`、跨实例 effect 不响应）。后果：`onCleanup` 三条路径（`store.dispose` / listener 反注册 / keyed 的 `stopPolling`）在套件里**从不执行**；listener 跨 setup 累积，一次 `setHidden(false)` 会唤醒所有历史 setup 各发一次请求 |
| D-2 | 低（测试缺口） | 即使修了 D-1，套件仍无 dispose 断言：变异 M3（删反注册）/ M4（删 keyed 的 `onCleanup(stopPolling)`）都**存活**。「关掉最后一个会话必须停表」只靠 M4 那条 cleanup，无回归保险 |
| D-3 | 低（文档一致性） | spec §2 片段与实现两处不一致（缺 `list().length === 0 → false`、缺 `onCleanup(unlisten)`）；CHANGELOG「### 测试」小节仍写「R-7 三例 … `document.hidden = true` 期间切会话」，与现在的 7 条 R-7/可见性断言不符 |

### 逐条

#### 1. 行为正确 —— **通过**

我的探针（单实例，`/tmp/opencode/probe-visibility.mjs` + `probe-close-reopen.mjs`，26/27 与 9/9）：

```
  PASS 1a a visible mount starts exactly one timer :: 1
  PASS 1b hiding clears the timer :: 0
  PASS 1c no request while hidden (past one 2 s tick) :: {"first":1,"after":1}
  PASS 2a switching while hidden issues no request :: {"before":0,"after":0}
  PASS 2b … and starts no timer :: 0
  PASS 2c showing resumes at once with the session routed now :: {"session":"ses_B"}
  PASS 2d the resume is immediate (<= 40 ms after the event) :: 0
  PASS 2e one timer after resuming :: 1
  PASS 3a a hidden mount starts no poll :: 0
  PASS 3b … and no timer :: 0
  PASS 3c showing it starts polling at once :: [{"input":{"session":"ses_A"},"at":251}]
  PASS 3d … and the tick follows (2 calls after one tick) :: 2
  PASS 8c closing the last session stops the timer :: 0
  PASS 8d … and no request follows (past one tick) :: {"atClose":1,"after":1}
  PASS 8e a visibility event with no session starts nothing :: {"timers":0,"calls":1}
  PASS 8f reopening a session restarts the timer and loads at once :: {"timers":1,"calls":2}
  PASS 8g … naming that session :: {"session":"ses_A"}
```

- **隐藏即停**：`hide()` 后存活定时器立刻 0，跨 >1 tick 无请求（1b/1c）。
- **隐藏期间切会话 0 请求**（2a/2b）；keyed run 里 `stopPolling(); startPolling()` 因 `pageHidden()` 直接返回。
- **可见即恢复**：`show()` 后 **0 ms** 发出一次，`session` 是当时路由的会话（2c/2d），随后 1 个定时器。
- **隐藏时挂载**：0 请求、0 定时器；`show()` 后立刻 1 次并继续 tick（3a–3d）——0.5.1 的「永不启动」已消除。
- 额外覆盖了套件没有的两条：**关掉最后一个会话停表**（8c/8d）与 **重开会话恢复**（8f/8g）。

#### 2. 不打爆 / 不泄漏 —— **通过（单实例下）**

```
  PASS 4a never more than one timer, even with duplicate events :: {"peak":1}
  PASS 4b concurrency never exceeded one request :: {"maxLive":1}
  PASS 4d the chain terminates while the session holds :: {"settled":41,"after":41}
  PASS 5a one timer before teardown :: 1
  PASS 5b dispose clears the timer :: 0
  PASS 5c dispose removes the visibilitychange listener :: 0
  PASS 5d a disposed plugin ignores visibility events :: {"calls":1}
```

- `startPolling` 幂等（`timer` 守卫）、`stopPolling` 幂等（`undefined` 守卫）；20 轮 hide/show + 切会话，
  **存活定时器峰值恒为 1**，即使重复派发两次 `show` 也不叠加（4a）。
- 并发恒 ≤1（R-7 的 `inFlight` 仍在）；链条自停（4d）。
- dispose：清定时器、反注册 listener、之后事件全忽略（5a–5d）。
- 我最初写的 `4c`「20 次切换 ≤8 次请求」失败（实测 41）——**是我的断言写错**：每次 `show()` 都按设计
  立即刷新一次（20 次 show ≈ 20 次请求），加 20 次切会话重载，41 次是预期值，且并发为 1、定时器 1 个。
  用户不可能 175 ms 内切 20 次可见性；这不是风暴。

#### 3. 单实例映射 —— **不通过（测试基础设施，非产品）**

实测（`/tmp/opencode/dbg-map*.mjs`）：

```
sym: /data/project/collab/node_modules/solid-js/dist/solid.js
real: /data/project/collab/node_modules/.pnpm/solid-js@1.9.19/node_modules/solid-js/dist/solid.js
# 按仓库现有映射（指向软链路径）
namespace identity: false    same createSignal: false
cross-instance effect runs: [ 'a' ]          ← 跨实例响应式已死
# 把映射改为 realpathSync 后
req === impReal: true        same createSignal: true
cross effect: [ 'a', 'b' ]                   ← 单实例
```

- 根因：CJS `require` 以「交给它的路径」为 key，ESM loader 以 **real URL** 为 key。映射到
  `node_modules/solid-js/dist/solid.js`（软链）时两者仍是两个实例；映射到 realpath 才合一。
  Node 对**普通** ESM 文件是 `require(esm) === import()`（用 `/tmp/opencode/modtest/m.mjs` 验过），
  所以这不是 Node 的通例，是软链路径造成的。
- 后果（用仓库现有映射、两次 `plugin.setup` 复现，`/tmp/opencode/probe-harness-bleed.mjs`）：

```
listeners after two setups (no dispose): 2
one.calls=1 two.calls=1
after hide: one=1 two=1
after show: one=2 two=2  (the earlier setup was resurrected)
bundle's solid (require) === test/SDK's solid (import)? false
```

  → ① listener 每 setup 累积（套件里有 ~9 次 setup，结束后 9 个 listener 全在）；
     ② 一次 `setHidden(false)` 会唤醒所有历史 setup 并各发一次请求（不破坏现有断言，但**不隔离**）。
- **哪些断言实际不依赖跨实例响应式**：全部 4 条 visibility 断言（`startPolling`/`stopPolling`/
  `document.addEventListener` 都是纯 JS）；keyed 的会话切换（测试的 `createSignal` 与 SDK 的
  `createKeyed` 都在 import 实例）；pill 的 `rerun()`（手工重跑工厂）；toast/版本断言（纯数据）。
  **真正依赖 `onCleanup` 的三件事都没被断言**：`store.dispose()`、keyed 的 `onCleanup(stopPolling)`、
  listener 反注册。
- 修法（1 行，已实测）：`const solidEsm = realpathSync(resolve(root, 'node_modules/solid-js/dist/solid.js'))`
  （`solid-js/web` 同理）。修完仍应 37/37，但 cleanup 才是真跑了。

#### 4. 断言真实性（变异）—— **通过（关键路径被抓住）**

只改产物（`dist/` 被 `.gitignore` 忽略，脚本备份后 `pnpm build` 重建）：

```
baseline: green — === 37/37 checks passed

M1 drop the visibilitychange listener (never registered)
  RED
  === 34/37 checks passed
  ✗ R7 hiding the window stops the poll (no tick while hidden) — 1 → 2 calls over >1 tick
  ✗ R7 showing the window again resumes at once with the routed session — 2 calls, last={"session":"ses_probe"}
  ✗ R7 … and starts polling once it becomes visible — 0 calls

M2 startPolling ignores pageHidden() (hidden mount starts anyway)
  RED
  === 34/37 checks passed
  ✗ R7 a session switch while hidden queues nothing — 1 → 2 calls
  ✗ R7 showing the window again resumes at once with the routed session — 2 calls, last={"session":"ses_other"}
  ✗ R7 a window that mounts hidden starts no poll — 1 calls

M3 the listener is never unregistered (onCleanup(unlisten) dropped)
  STILL GREEN — not covered

M4 the keyed run keeps its timer when the key changes (onCleanup(stop) dropped)
  STILL GREEN — not covered
```

- 两条核心变异各打掉 3 条断言 → 不是「声称跑了」。
- M3/M4 存活 = D-1 + D-2 的直接证据（cleanup 未覆盖）。M4 尤其值得注意：**关掉最后一个会话时**
  唯一停表手段就是那条 cleanup（run body 不会执行），套件对此零覆盖。
- 既有探针 / R-7 断言**未被弱化**：对比 HEAD 的 21 条，断言行名只有上一轮记录的那一条改名（并加强）；
  相对上一轮的 33 条，唯一被替换的是「hidden window queues no reload」1 条，换成了 5 条更细的断言
  （隐藏即停 / 隐藏期间切会话不排队 / 显示即恢复 / 隐藏时挂载不启动 / 可见后启动），净 +4：
  33 → 37，与 README/CHANGELOG 一致。

#### 5. 回归与范围 —— **通过**

`pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs`（EXIT=0）：

```
=== 638/638 checks passed
=== 12/12 checks passed
=== 35/35 checks passed
=== 29/29 checks passed
=== 37/37 checks passed
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
```

- 改动清单 = `src/gui.tsx`、`test/gui-entry.mjs` + 文档（README / `docs/collab.md` / spec /
  CHANGELOG / SKILL）+ `package.json` / `src/constants.ts`（版本）+ 任务目录，**均在允许范围**。
- `src/core/**`、`src/rpc.ts`、`src/tui.tsx` 未改；`git diff package.json` 仍只有 `version` → **无新依赖**。

#### 6. 文档一致 —— **通过（两处小漂移，见 D-3）**

- `docs/collab.md` §11.11「刷新」行：改写成「窗口隐藏时停止、恢复可见后立即以当前会话继续（监听
  `visibilitychange`，0.5.2 起；以前读 `document.hidden` 不是响应式的，隐藏不真停、隐藏时挂载的窗口也
  永不启动）」——与我两轮实测**一致**，不再把「读 `document.hidden`」写成做法。
- `.trellis/spec/frontend/opencode-plugin-ui.md` §2：新增「`document.hidden` 不是响应式的 … 必须监听
  `visibilitychange` 显式 start/stop」，方向正确；但片段与实现有两处差异（见 D-3），其中**缺
  `onCleanup` 反注册**会让照抄者泄漏 listener，建议补全。
- README：计数 33 → 37 已同步；README 原本没有「隐藏暂停」的表述，无需改。
- CHANGELOG：Fixed 段准确记录了「旧行为与文档不符」，与实测吻合；**「### 测试」小节仍描述旧的
  `document.hidden = true` 三例**，与现在的 5 条可见性断言 + 2 条 R-7 断言（共 7 条）不符（D-3）。

### 剩余风险（非阻断）

| 风险 | 说明 | 处置 |
| --- | --- | --- |
| R-a 生产环境的 Solid 单实例假设 | 0.5.2 首次让**反注册 document listener** 依赖 `onCleanup`。若某个宿主把 CJS bundle 与 ESM SDK 装到两份 solid（与本地 harness 同款分裂），`onCleanup` 会静默不执行 → listener 泄漏、`store.dispose()` 不跑；`createKeyed` 的会话切换仍能用（那是 SDK 侧），但「禁用插件后仍在轮询」会变成真的 | 可选加固：除 `onCleanup` 外再听 `ctx.signal` 的 `abort`（`core.d.ts` 明确它「在插件被禁用/重载/窗口关闭时 abort」，与 Solid 实例无关）做一次 `stopPolling()`；成本 3 行，可放 0.5.3 |
| R-b harness 不隔离 | 见 D-1：listener 累积、`setHidden` 广播到历史 setup。当前断言不受影响，但以后有人断言「旧 harness 的请求数」会莫名其妙地变 | 修 D-1 + 给 harness 加 `dispose()` 并在每个用例后调用 |
| R-c Home（有标签、无路由会话）仍轮询 | key 落到 `''`，每 2 s 发一次 `snapshot({})`（全局视图）。0.5.1 同款，未回归 | 无需处理 |
| R-d 每次 `show()` 立即刷新 | N 次可见性切换 = N 次请求（并发恒 1）。设计使然 | 无需处理 |

### 一句话汇报（增量）

**行为对了，可以发；测试的「单实例」是名义上的。** 自写探针（单实例）26/27 + 9/9：隐藏即停表（跨 >1 tick
零请求）、隐藏期间切会话零请求、显示后 **0 ms** 以当前会话恢复、隐藏时挂载 0 请求且显示后启动、关掉最后一个
会话停表、重开恢复、dispose 清表并反注册、20 轮 hide/show+切会话定时器峰值恒 1、并发恒 1——全部命中；
两条核心变异（去 visibility 监听、`startPolling` 去掉 `pageHidden()`）各打掉 3 条断言，回归 `638+12+35+29+37`
与 `check-skill` 全绿，范围与依赖未越界。唯一实质问题是 `test/gui-entry.mjs` 的 Solid 映射走软链路径：
实测 `require('solid-js').createSignal !== import(...).createSignal`，仍是**两份**实例，于是 bundle 的三处
`onCleanup`（store.dispose / listener 反注册 / keyed 停表）在套件里从未执行，listener 每 setup 累积且
`setHidden(false)` 会唤醒所有历史 setup（实测 2 个 setup → 2 个 listener，旧实例 1→2 请求）；改成
`realpathSync` 即合一（已实测 `true` / 跨实例 effect 生效），顺带建议补一条 dispose 断言——否则「关掉最后
一个会话必须停表」这条只靠 cleanup 的路径永远没有回归保险。
