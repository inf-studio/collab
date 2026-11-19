# 实现记录：看板主从布局（`board2-layout`）

日期：2026-11-19 · 版本：**不改**（`package.json` / `PLUGIN_VERSION` 仍 0.7.0，0.8.0 由父任务统一发）

## 0. 复核后修复（第 2 轮，2026-11-19）

复核结论「可提交」+ 2 个覆盖缺口 + 若干口径不一致（见 `research/check-report.md`）。本轮按派单修了 6 项：

| # | 问题 | 处理 |
| --- | --- | --- |
| 1 | 槽位顺序无断言（对调两槽位仍全绿） | `test/gui-panel.mjs` PN8 新增：`collab-detail-pane` 的**直接子元素**顺序必须逐字等于 `["collab-detail-header","…collab-graph-slot","…collab-actions-slot","collab-items"]` |
| 2 | 断点数值无守卫（640→100 仍全绿） | PN9 的 `matchMedia` 桩改为**按 viewport 求值**（解析 `max-width: Npx`），新增两条断言：`639px` = 单栏、`641px` = 分栏 |
| 3 | TUI 明细顺序与文档不符（实现 `↳` 在前） | **改实现为文档顺序**：`detailLines` 用 `lockRows → handoffRows → queueRows → spawnRows`（行内展开 `sessionDetailRows` 仍保持 0.6.0 的 `↳` 优先，未动）；新增断言锁定 `🔒 → → → … +3` 且 `↳` 不在这 3 行里 |
| 4 | `enter`/`space`/点击也会「激活详情」，与行内展开重复 | 去掉激活：`toggleSelected` / `clickRow` 只做 0.6.0 的展开/收起与移光标，不再 `setActive(true)`；`j`/`k` 选中、`esc` 清除不变；新增两条断言（`enter` 帧无 `详情`、鼠标点击帧无 `详情`） |
| 5 | PRD R3 写「归档即清空」，与实现不一致 | 回写 `prd.md` R3 / 验收：**活跃 + 归档都消失**才清空；仅归档时保留选择并显示 `[archived]` |
| 6 | `collab-split-narrow` 类无 CSS（悬空） | 补 CSS `.collab-split-narrow{grid-template-columns:minmax(0,1fr);}` —— 它同时是「媒体查询没生效时也不会把单栏挤进 320px 轨道」的兜底 |
| — | 快照 RPC 永不 settle → `inFlight` 永久 true（既有，非本任务引入） | 不改，只在下文「已知风险」记录 |

顺带（复核 nit，低风险）：PN9 点 `← 返回列表` 前先断言按钮存在（`if (back) fireClick(back)`），
变异下测试**报失败**而不是抛 `TypeError` 中断汇总。

## 1. 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/gui.tsx` | `PanelView` 拆成 `.collab-split` / `.collab-sidebar` / `.collab-detail-pane`；新增 `DetailHeader` / `GraphSlot` / `ActionRow` / `DetailItems` / `BoardDetail`；`SessionRow` 从「展开」改为「选中」；选中 signal + 消失清空 + toast；`matchMedia` 窄屏回落；CSS 新增分栏/详情/槽位/`-narrow` 样式；i18n 新增 8 个键（en/zh） |
| `src/tui.tsx` | `StatusPanel` 增加 `active`（选中）信号：**只有 `j`/`k`** 选中、`escape` 清除；`enter`/`space`/点击只展开（0.6.0 语义）；`detailLines()` + `sessionByKey()`；明细行按「锁 → 交接 → 队列 → ↳」排序（拆出 `lockRows`/`handoffRows`/`queueRows`/`spawnRows`） |
| `test/gui-panel.mjs` | harness 记录 toast；PN6 两处标题改为「选中」（断言内容不变）；PN8（分栏/槽位存在/**槽位顺序**/点选/详情/轮询计数/消失清空）、PN9（**639 单栏** / **641 分栏** / 选中替换 / 返回按钮存在 / 返回列表）共 17 条新断言；PN6 快照改为每次 `at` 递增 |
| `test/tui-render.mjs` | 新增「5c 选中行详情」7 条断言（挂载无选中、`j` 后 3–5 行、计数+明细、`k` 跟随、**明细顺序**、`esc` 清除、**`enter` 不激活**）；鼠标点击断言加「不打开详情」 |
| `test/gui-entry.mjs` | 目录键清单补 8 个新键（断言条数不变，仍 47） |
| `docs/collab.md` | §11.11 标题加 0.8.0；GUI / TUI 面板行改写；新增 §11.11.7；TUI 段写明「`enter`/`space`/点击不打开详情」 |
| `README.md` | 状态视图两张表的两行 + `pnpm test` 计数 |
| `skills/collab/SKILL.md` | 看板说明补主从布局与 TUI 选中详情 |
| `CHANGELOG.md` | 新增 `[Unreleased]`（0.8.0 看板主从布局） |
| `prd.md`（任务目录） | R3 / 验收回写为「活跃+归档都消失才清空」 |

未改：`src/core/board.ts`（现有派生已够用，未新增导出）、`src/rpc.ts`、工具面（仍 22）、依赖、版本号。

## 2. 分栏结构

```text
PanelView
 └ div.collab-split                     CSS grid, 320px + minmax(0,1fr)
    ├ section.collab-sidebar            左列表：GroupView 树（含 已归档 折叠段）+ OrphanView
    └ section.collab-detail-pane        右详情
       ├ button.collab-back             仅窄屏：「← 返回列表」
       ├ header.collab-detail-header    标题 / agent / 完整 sid / 徽标（[archived][frozen][urgent]）
       ├ div[data-collab-slot=graph]    GraphSlot（空、min-height:0）
       ├ div[data-collab-slot=actions]  ActionRow（空、min-height:0）
       └ div.collab-items               DetailItems：锁 → 交接 → 队列 → ↳ 拉起的会话
```

- **顺序是有断言的**：PN8 读 `collab-detail-pane` 的直接子元素类名数组，与上面的顺序逐字比较
  （对调两个槽位 → 断言失败，见第 8 节变异 C）。
- 面板根仍是 `.collab-panel`（唯一的 store / 轮询 / source 徽标 / 错误横幅 / footer）。
- 未归属行（`boardOrphans`）留在左列表末尾：它们是「列表」的一部分，不属于任何选中会话。
- 取消行内展开：`expanded` 信号只剩 `archived:<workspace>` 一种 key。
- 槽位的 class 由 `slotClass(kind)` 计算得到，不是字面量：GUI 产物会把静态属性内联成
  `class="…"data-…=…`（无分隔符），测试用的最小 DOM 解析器要求至少一个属性在运行时 `setAttribute`
  （与文件里其他动态 `class` 一致）。`data-collab-slot` 仍以静态属性输出，作为下一个子任务的选择器。

## 3. 选中时序

1. 点击行 → `select(sid)`：`setSelected(prev => prev === sid ? null : sid)`（单选、再点取消），
   行上加 `collab-session-selected` + `›`，`aria-pressed`。
2. `selectedSession()`（`createMemo`）在 `buildBoard()` 的**活跃 + 已归档**里按 sid 查找 → 渲染 `BoardDetail`。
   按 sid 而不是行对象：快照整份替换后仍是同一个会话。
3. `createEffect` 每次 `data` 或 `selected` 变化时检查：
   - `selected === null` → 返回；
   - `store.state.data` 为空（adopt / 一次失败）→ **不清空**（横幅已在解释）；
   - sid 在活跃与已归档里都找不到 → `setSelected(null)` + `ctx.toast.show({ description: '该会话已不在快照中' })`。
4. 归档不是消失：会话进入 `archived[]` 后详情继续显示并带 `[archived]`（PRD R3 已按此口径回写；
   否则从「已归档」段选中也会被立刻清掉）。

## 4. 轮询不重置的证明

- 选中/展开/窄屏判定都在组件里（signal / media query），`sharedStore` 的 2 s `setState` 不触碰它们。
- 面板根带 `data-collab-at={store.state.at}`（快照自己的时间戳），测试：
  1. 选中 `ses_layout_board01`，记录 `data-collab-at` 与 `layoutLoads`；
  2. 等 2100 ms（一次真实轮询）；
  3. 断言 `layoutLoads` 与 `data-collab-at` 都变了（**确实发生了快照替换**），
     且 `collab-session-selected` 仍在、详情仍是同一 sid / 同一锁。
  4. PN6 也保留 0.6.0 的轮询断言（`boardLoads` 1 → 2，选中后的详情仍在）。

## 5. 窄屏回落（断点 640 有守卫）

- `narrowQuery()`：`globalThis.matchMedia('(max-width: 640px)')`，没有 `matchMedia`（测试宿主 / 老窗口）
  = 宽屏；有 `addEventListener` 时监听 `change`，`onCleanup` 反注册。
- JSX 层：`<Show when={!narrow() || !selected()}>` 左列表、`<Show when={!narrow() || selected()}>` 右详情，
  单栏时二者二选一；详情顶部渲染 `.collab-back`（`← 返回列表` → `setSelected(null)`）。
- CSS 同一断点：`@media (max-width:640px){ .collab-split{grid-template-columns:minmax(0,1fr)} … }`，
  另有 `.collab-split-narrow` 兜底（媒体查询不生效时也不会把单栏塞进 320px 轨道）。
- **数值守卫**：测试的 `matchMedia` 桩解析 `max-width: Npx` 并按可变 `viewport` 求值，
  断言 `639 ≤ N`（单栏）与 `641 > N`（分栏）两侧状态；把 640 改成 100 → 639 侧翻转 → 失败（变异 D）。

## 6. TUI

- `StatusPanel`：`active=false` 时 `selectedKey()` 返回 `undefined` —— 挂载帧没有 `›`、没有详情块，
  0.6.0 的树断言逐字不变。
- **只有 `j`/`k` 会选中**（`move()` 里 `setActive(true)`）；`escape` → `setActive(false)`。
  `enter`/`space`（`toggleSelected`）与鼠标点击（`clickRow`）保持 0.6.0 语义：只按光标位置展开/收起，
  **不**打开详情块 —— 行内已经展开过同一批行，再在树下重复一遍是噪音。
- `detailLines(session, width)`：`详情 <shortSid> · <agent> · <title>` + `N 持有 · N 排队 · N 交接 · N 队列 · N 拉起`
  + 最多 3 条明细，顺序为 **锁 → 交接 → 队列 → `↳`**（`lockRows`/`handoffRows`/`queueRows`/`spawnRows`），
  超出把第 3 条换成 `… +N`；没有明细时补一行 `（无锁 / 交接 / 队列 / 拉起）` → 恒为 **3–5 行**。
- 行内展开 `sessionDetailRows` 仍保持 0.6.0 顺序（`↳` 优先），与详情块互不影响。
- 插入位置：树的行之后、未归属段之前。

## 7. 测试

| 套件 | 之前 | 之后 |
| --- | --- | --- |
| `test/handoff-harness.mjs` | 870 | 870 |
| `test/readonly-default.mjs` | 12 | 12 |
| `test/board-shape.mjs` | 20 | 20 |
| `test/snapshot-shape.mjs` | 50 | 50 |
| `test/tui-render.mjs` | 49 | **56** |
| `test/gui-entry.mjs` | 47 | 47 |
| `test/gui-panel.mjs` | 17 | **34** |

新增断言明细：

- GUI PN8（12 条）：分栏三件套；未选中时的提示；行是选择按钮；点选后高亮 + 完整 sid；
  槽位元素存在；**槽位顺序（header → graph → actions → items）**；头部 title/agent/sid/[urgent]；
  items 顺序（资源租约 → 未闭环交接 → 受保护目标队列 → 拉起的会话）；轮询计数（loads +
  `data-collab-at`）；选中存活；消失清空；toast。
- GUI PN9（5 条）：**639px 单栏**；**641px 分栏**；选中后列表消失 + 详情 + 返回列表；
  **返回按钮真实存在**；返回后回到列表。
- TUI 5c（7 条）：挂载无选中；`j` 后 3–5 行；计数与明细行；`k` 跟随；**明细顺序（锁→交接→… +N，↳ 不在这 3 行）**；
  `esc` 清除；**`enter` 只展开、不打开详情**。另：鼠标点击断言加「不打开详情」。

## 8. 变异验证（原始输出）

### 变异 A（第 1 轮）：把选中放进会被轮询替换的快照（`store.state.data.selectedSid`）

补丁：`SnapshotStore` 增 `select()`（`setState('data','selectedSid', …)`），`PanelView` 的 `selected()`
读 `store.state.data.selectedSid`。

```text
$ node --conditions=browser test/gui-panel.mjs
  ✗ PN6 a 2 s poll does not drop the selection (detail still shown) — "@srv-boardcollab2 sessions · 1 leases · 2 hand-offs · 1 archived·ses_boardbuild🔒1‹2›⇢1[frozen][urgent]board workerthis session·ses_childbuild‹1›child worker▾ Archived 1·ses_oldbuild[archived]archived work
  ✗ PN8 … and the selection survived it: still highlighted, same session in the detail — {"loads":2,"text":"@srv-layoutcollab2 会话 · 1 锁 · 2 交接 · 0 已归档·ses_layo…rd01build🔒1‹2›⇢1[urgent]layout worker当前会话·ses_layo…ld01explore‹1›child workerother1 会…
  ✗ PN8 … and says why: 该会话已不在快照中 — []
=== 28/31 panel checks passed
FAILED: PN6 a 2 s poll does not drop the selection (detail still shown)
FAILED: PN8 … and the selection survived it: still highlighted, same session in the detail
FAILED: PN8 … and says why: 该会话已不在快照中
```

→ 断言确实能抓住「选中放错层」：轮询一换 `data` 选中就没了（连带消失 toast 也不再出现）。
还原后 31/31（第 1 轮基线）。

### 变异 B（第 1 轮）：窄屏不回落（`narrowQuery()` 恒 `undefined`）

```text
$ node --conditions=browser test/gui-panel.mjs
  ✗ PN9 below 640px the list is the only pane until something is selected — "@srv-narrowcollab2 会话 · 1 锁 · 0 交接 · 0 已归档·ses_narrow_mebuild🔒1narrow worker当前会话·ses_narr…hildexplorenarrow child选择左侧会话查看详情。更新于 08:00:00 · 只读"
  ✗ PN9 selecting a session replaces the list with the detail and offers ← 返回列表 — "@srv-narrowcollab2 会话 · 1 锁 · 0 交接 · 0 已归档›ses_narrow_mebuild🔒1narrow worker当前会话·ses_narr…hildexplorenarrow childnarrow workerbuildses_narrow_me🔒1当前会话资源…
```

（该轮在点 `← 返回列表` 时抛 `TypeError` 中断；第 2 轮已加存在性守卫，见变异 D。）

### 变异 C（第 2 轮）：对调 `GraphSlot` / `ActionRow`

```text
$ node --conditions=browser test/gui-panel.mjs
  ✗ PN8 the detail pane order is header → graph slot → actions slot → items (R2) — ["collab-detail-header","collab-detail-section collab-actions-slot","collab-detail-section collab-graph-slot","collab-items"]
=== 33/34 panel checks passed
FAILED: PN8 the detail pane order is header → graph slot → actions slot → items (R2)
```

→ 顺序断言按预期失败（此前变异 C 全绿）。还原后 34/34。

### 变异 D（第 2 轮）：断点 640 → 100（CSS 仍 640）

```text
$ node --conditions=browser test/gui-panel.mjs
  ✗ PN9 639px is one pane: the list only, no detail placeholder — "@srv-narrowcollab2 会话 · 1 锁 · 0 交接 · 0 已归档·ses_narrow_mebuild🔒1narrow worker当前会话·ses_narr…hildexplorenarrow child选择左侧会话查…
  ✗ PN9 selecting a session replaces the list with the detail and offers ← 返回列表 — "@srv-narrowcollab2 会话 · 1 锁 · 0 交接 · 0 已归档›ses_narrow_mebuild🔒1narrow worker当前会话·ses_narr…hildexplorenarrow childnarrow workerbuildses_narrow_me🔒1当前会话…
  ✗ PN9 the detail offers a real ← 返回列表 button — "@srv-narrowcollab2 会话 · 1 锁 · 0 交接 · 0 已归档›ses_narrow_mebuild🔒1narrow worker当前会话·ses_narr…hildexplorenarrow childnarrow workerbuildses_narrow…
  ✗ PN9 返回列表 clears the selection and brings the list back — "@srv-narrowcollab2 会话 · 1 锁 · 0 交接 · 0 已归档›ses_narrow_mebuild🔒1narrow worker当前会话·ses_narr…hildexplorenarrow childnarrow workerbuild…
=== 30/34 panel checks passed
FAILED: PN9 639px is one pane: the list only, no detail placeholder
FAILED: PN9 selecting a session replaces the list with the detail and offers ← 返回列表
FAILED: PN9 the detail offers a real ← 返回列表 button
FAILED: PN9 返回列表 clears the selection and brings the list back
```

→ 断点数值被抓住（639 判定翻成宽屏），且测试**正常汇总**而非崩溃。还原后 34/34。

## 9. 验收

```text
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
✓ built … dist/index.js / dist/gui-experimental.cjs / dist/tui.js
$ tsc --noEmit                      （无输出）
=== 870/870 checks passed
=== 12/12 checks passed
=== 20/20 board checks passed
=== 50/50 checks passed
=== 56/56 checks passed
=== 47/47 checks passed
=== 34/34 panel checks passed
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
```

只读核查：`src/gui.tsx` / `src/tui.tsx` 里新增的宿主调用只有 `ctx.toast.show`（消失提示）与既有的
`layout.open` / `panel.open`；没有锁 / 队列 / 归档 / 权限 API（`test/gui-entry.mjs` 的严格 Proxy 也通过）。
工具数 22 不变（`test/snapshot-shape.mjs` 50/50）。

## 10. 已知风险（不在本任务修）

- **快照 RPC 永不 settle 时 `inFlight` 永久为真**（`src/gui.tsx` `createSnapshotStore.load`，0.5.x 起既有）：
  一次永不返回的请求让 `inFlight` 永远 `true`，之后每次 `load()` 都在 `if (inFlight) return` 处返回，
  面板数据不再刷新（横幅也不会出现——没有 reject）。复核用「可控失败 + 换源」探针时意外复现过一次。
  非本次引入，本任务不改；修法应是给 `client.rpc(...).snapshot()` 加超时（`AbortSignal`/`Promise.race`）
  并在 `finally` 里复位。建议单独开任务。

## 11. 给后续子任务的接口

- `board2-graph`：在 `GraphSlot()`（`div[data-collab-slot="graph"]`，class `collab-detail-section collab-graph-slot`）
  里渲染即可；槽位顺序由 PN8 的断言守卫（header → graph → actions → items），替换绘制内容时不要改顺序。
  需要选中态时读 `PanelView` 的 `selected()`（本任务未导出，图子任务可把 `GraphSlot` 改成
  `props: { session }`）。CSS 已有 `.collab-detail-section`，`min-height:0` 现在不占高度。
- `board2-actions`：`ActionRow()`（`data-collab-slot="actions"`）同理；R5 只读约束只属于本任务。
- 注意：GUI 产物会把**相邻静态属性**内联成 `"a"b=`（无空格），测试宿主的最小 DOM 解析不了；
  新增元素若同时带静态 `class` 与静态 `data-*`，请让其中一个走运行时（本项目用 `slotClass()`）。
- 改窄屏断点时：`src/gui.tsx` 的 `(max-width: 640px)`、CSS 的 `@media` 与 `test/gui-panel.mjs`
  的 639/641 两侧断言要一起改（这是故意的：断点是契约）。
