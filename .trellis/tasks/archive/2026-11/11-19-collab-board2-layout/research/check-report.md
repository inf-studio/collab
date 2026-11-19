# 复核报告：看板主从布局（`board2-layout`）

- 复核身份：独立复核（冷上下文，只审不改；实现方 `research/impl-notes.md` 未采信为证据）
- 复核对象（工作区未提交；首轮 9 文件 +748/−71，增量复核后 +874/−95）：`src/gui.tsx`、`src/tui.tsx`、`test/gui-panel.mjs`、
  `test/tui-render.mjs`、`test/gui-entry.mjs`、`docs/collab.md`、`README.md`、`skills/collab/SKILL.md`、`CHANGELOG.md`
- 基线：`git status` 与派单文件清单逐一对齐（无越界文件）；`package.json` / `pnpm-lock` 未改动
- 回归命令：`pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs` → 全绿

## 结论

**可提交（无阻塞缺陷）。** 8 项必查全部通过；实现与 PRD/design 的功能性约定一致，只读约束成立。
发现 2 个**测试覆盖缺口**（新测试未守住 R2 的槽位顺序、未守住 640px 断点数值）、3 处**文档/PRD 措辞与实现不一致**、
1 个**UX 存疑**（TUI `enter` 同时激活详情）、1 个**历史遗留健壮性风险**（快照 RPC 永不返回会永久卡住轮询，非本次引入）。
建议随本任务补两条断言（成本 10 行以内），其余按低风险记录，不阻塞合入。

---

## 必查 8 项

### 1. 分栏与详情顺序 —— 通过

`src/gui.tsx:313` `.collab-split{grid-template-columns:320px minmax(0,1fr)}`（R1 要求 300–340px，320 ✓）；
`:315–:325` 侧栏/详情/头部/槽位样式；`:325` 同断点 `@media (max-width: 640px)` 收成一列。

`BoardDetail`（`src/gui.tsx:674–689`）自上而下 = `DetailHeader`(`:683`) → `GraphSlot`(`:684`) → `ActionRow`(`:685`)
→ `DetailItems`(`:686`)，与 R2/design §1 一致。槽位是**真实元素**而非注释/`null`：`GraphSlot`/`ActionRow`
（`:633–641`）各渲染 `<div class="collab-detail-section collab-{graph,actions}-slot" data-collab-slot="…"/>`，
后续子任务可按 `data-collab-slot` 原地替换。

自写探针（`/tmp/opencode/probe-gui.mjs`，复用仓库 mini-DOM + 已构建 bundle）直接读 DOM 子节点顺序：

```
✓ CA1 detail order is header -> graph -> actions -> items (real elements, wide)
   — ["collab-detail-header","collab-detail-section collab-graph-slot","collab-detail-section collab-actions-slot","collab-items"]
✓ CA1b header is title then meta — ["collab-detail-title","collab-detail-meta"]
✓ CA1c both slots are live <div> nodes and empty today
   — div#collab-detail-section collab-graph-slot / div#collab-detail-section collab-actions-slot
```

**覆盖缺口（见 7）**：仓库测试只断言两个槽位"存在"，未断言它们相对 header/items 的顺序 ——
把 `GraphSlot`/`ActionRow` 对调后 `test/gui-panel.mjs` 仍 31/31 全绿。

### 2. 选择状态 —— 通过（含归档会话）

- 单选、按 sid：`const [selected, setSelected] = createSignal<string | null>(null)`（`src/gui.tsx:717`）；
  再点同一行取消（`:763–765`）；行高亮 `collab-session-selected`（`:494`）。
- 2s 轮询换快照不重置：选中是组件内存，`createEffect`（`:751–761`）只在 `selected` 与 `selectedSession()` 变化时运行；
  store 替换 `data` 不触碰 `selected`。仓库测试用 `data-collab-at`（`:776`）+ 客户端 `layoutLoads` 双计数证明期间确实换过快照：

```
✓ PN8 a poll really replaced the snapshot during the wait (loads and `at` both moved) — 1 → 2 loads; at 1 → 2
✓ PN8 … and the selection survived it: still highlighted, same session in the detail — {"loads":2,...}
```

- 清空条件 = 活跃与归档都找不到：`selectedSession()` 同时查 `workspace.sessions` 与 `workspace.archived`
  （`src/gui.tsx:737–746`）；仅当 `store.state.data` 存在且查不到才清空 + toast（`:751–761`）。
- 归档会话仍可选中并标 `[archived]`：徽标在 `SessionBadges`（`src/gui.tsx:374–376`），归档行在折叠段内仍用同一
  `SessionRow` + `onSelect`（`:548–564`）。我的探针（仓库测试未覆盖这一点）：

```
✓ CA2 an archived session is selectable and shows [archived] + the full sid
   — {"selected":"›ses_probe_oldexplore[archived]probe archived"}
✓ CA2b selecting the active row moves the single selection back
   — ›ses_probe_abuild🔒1‹2›⇢1[urgent]probe active当前会话
```

- "一次失败 / 无快照不算消失"（仓库测试未覆盖）—— 我分别用**可控失败**与**换源后暂无快照**复现：

```
✓ CA3 a failed 2 s poll keeps the selection and raises no "gone" toast — 1 -> 2 loads; toasts=[]
✓ CA3b the next good poll also keeps it — toasts=[]
✓ CA4 a source with no snapshot yet does not clear the selection (no toast) — "@srv-probe-slow加载中…"
✓ CA4b coming back to the same snapshot still shows the detail (selection never dropped) — ›ses_probe_a…
✓ CA5 gone from active AND archived clears once and toasts exactly once
   — [{"title":"协作","description":"该会话已不在快照中","variant":"default"}]
```

> 与 PRD R3 的出入：PRD 字面为"选中的会话**被归档/消失**时自动清空"，实现/design/文档取"归档 ≠ 消失，只有真的离开
> 快照才清空"（`src/gui.tsx:737` 注释、`docs/collab.md:1101`）。派单第 2 条明确要求"归档会话仍可选中"，实现与该口径一致；
> 建议把 PRD R3 的措辞同步改掉，避免下一位复核者按字面判不通过。

### 3. 窄屏回落 + 可注入断点 —— 通过

`narrowQuery()` 读 `globalThis.matchMedia('(max-width: 640px)')`（`src/gui.tsx:131–137` 定义、`:720–728` 使用），
不读真实 viewport，测试可在 `globalThis` 上注入假 `matchMedia`；`change` 监听同步翻转 `narrow` 信号（`:722–728`）。
窄屏渲染：`Show when={!narrow() || !selected()}` 列表 / `Show when={!narrow() || selected()}` 详情（`:798–:838`），
`← 返回列表` 按钮仅在窄屏（`BoardDetail :678–682`），点击清空选中回列表。

仓库 PN9 三断言通过（31/31 内含）；我的注入探针还验证了**运行时翻转**而不只是挂载时读取：

```
✓ CA6 injected matchMedia matches:false = the wide two-pane form
✓ CA6b a live media change flips to one pane: list replaced by detail + back button — "@srv-narrow-probe← 返回列表…"
✓ CA6c flipping back restores the split and keeps the selection
```

**覆盖缺口（见 7）**：测试桩对任何含 `max-width` 的查询都返回 `matches:true`，未断言 **640** 这个数值
（把 JS 侧断点改成 100px，仓库 31/31 仍全绿）。

### 4. TUI —— 通过（含一处 UX 存疑）

- 挂载帧无 `›`、无详情：`active` 初值 false（`src/tui.tsx:658–664`），`selectedKey()` 在 `active=false` 时返回
  `undefined`（`:667–674`）。仓库新增断言通过；我复算行数 `9 → 9`。
- `j/k` 后正好 +3–5 行：`detailLines`（`src/tui.tsx:517–545`）固定 2 行头 + `min(rows,3)`；`rows>3` 时第 3 条换成
  `… +N`。探针实测两端边界：

```
✓ CA7 j selects ses_child: +3 lines (header + counters + 1 item) — 9 -> 12
✓ CA7b selecting ses_a1 adds exactly 5 lines (upper bound of R4) — 9 -> 14
✓ CA7c the 3 item rows are capped with "… +N" and come from sessionDetailRows
   — ↳ ses_child … | 🔒 named:tree-window … | … +3
✓ CA7d selecting the 已归档 fold (no session) adds no detail lines — 9 -> 9
✓ CA7e escape clears the marker and the detail (tree back to the mount frame)
```

- `esc` 清除：新增 `collab.board.clear`（`:733`），OpenTUI 的键名 `escape` 合法（`@opentui/core/lib/keybinding.internal.d.ts` 示例即 `{name:"escape"}`）；
  探针 CA7e 与仓库断言均通过。
- 0.6.0 既有树断言**逐字未变**：`git diff test/tui-render.mjs` 只有 1 个插入 hunk（61/0，无删除），`enter` 展开、
  `j` 单步、鼠标点击等断言全部保留且 54/54 通过。

**UX 存疑（低）**：`move`/`toggleSelected`/`clickRow` 都会 `setActive(true)`（`:684–:703`），因此 `enter`/`space`/鼠标点击
**展开的同时也激活详情块** —— 已展开的 `↳/🔒/…` 子行与新增的 3–5 行详情重复展示。文档已显式写明该行为
（`docs/collab.md:1107`），但 PRD R4 只把详情绑定到 `j/k`。仓库既有断言是 `includes` 语义，捕获不到"enter 帧多了 4 行"。
建议 owner 决定：接受并在 PRD 补一句，或让 `toggleSelected` 不再 `setActive(true)`。

### 5. 只读 —— 通过

`git diff` 中新增的宿主调用只有 `ctx.t(...)` 与 `ctx.toast.show(...)`（`src/gui.tsx:756–760`）：

```
$ git diff src/gui.tsx src/tui.tsx | grep '^+.*ctx\.'
+ … {ctx.t('panel.current')}
+ … {ctx.t('panel.detailLocks', …)} / detailHandoffs / detailQueue / detailSpawned / detailEmpty / panel.back
+        ctx.toast.show({
```

无 `collab_lock`/`collab_unlock`/`collab_queue`/`collab_archive`/`collab_freeze`/`permission`/`tools.*` 的新调用；
`ctx.toast.show` 是 0.5.2 起既有的只读出口（标题栏 pill 同款）。假 ctx 探针（`harness` 的 Proxy 白名单）在整套
`gui-panel`/`gui-entry` 下未抛 "setup read ctx.*"，且 `toast.show` 被替换为记录器后无写副作用。

### 6. 回归与范围 —— 通过（一处基线口径校正）

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
=== 870/870 checks passed          (handoff-harness)
=== 12/12 checks passed            (readonly-default)
=== 20/20 board checks passed      (board-shape)
=== 50/50 checks passed            (snapshot-shape)
=== 54/54 checks passed            (tui-render)
=== 47/47 checks passed            (gui-entry)
=== 31/31 panel checks passed      (gui-panel)
✓ skills/collab/SKILL.md (collab) / ✓ skills/collab-coordination/SKILL.md
skills ok
$ pnpm typecheck → tsc --noEmit，无输出（通过）
```

与派单目标 `870 + 12 + 20 + 50 + 54 + 47 + 31` 完全一致（合计 1084）。
- 工具数仍 22：`test/handoff-harness.mjs:9250 / :10820 / :11306` 三处 `tools.length === 22` 均在全绿范围内。
- 版本：`package.json:3` 与 `src/constants.ts:409` 均为 `0.7.0`，本 diff 未改（派单写的"0.6.0"是旧基线；0.8.0 由父任务统一，符合 implement.md）。
- 无新依赖：`package.json`/lock 未出现在 `git status`；`git status` 恰为 9 个修改文件 + 5 个既有未跟踪任务目录。
- 范围：`git diff --numstat` = CHANGELOG 27/0、README 3/3、docs 37/3、SKILL 4/1、gui 281/54、tui 66/4、
  gui-entry 9/1、gui-panel 260/5、tui-render 61/0；无越界文件。

### 7. 测试真实性（4 组变异，临时改源码后**已还原**）—— 2 个覆盖缺口

改动前备份、每次 `pnpm exec vp build -c vite.gui.config.ts`（~0.5s）后只跑 `test/gui-panel.mjs`；
结束后 `cp` 回备份，`sha1` 与备份一致（`5eadb537… gui.tsx` / `790e43e9… tui.tsx`），`git status` 未变。

| # | 变异 | 结果 | 判定 |
| --- | --- | --- | --- |
| A | `narrowQuery` 恒返回 `undefined`（永远宽屏） | PN9 ×2 ✗，随后 `fireClick(byClass('collab-back'))` 抛 `TypeError`（测试中断，无法打印汇总） | 被抓到，但**以崩溃而非失败报告**（测试健壮性 nit） |
| B | 选中放进"轮询快照"（`createEffect(()=>{store.state.at; setSelected(null)})`） | 28/31：PN6 轮询不重置 ✗、PN8 轮询存活 ✗、PN8 消失 toast ✗ | 被抓到 ✓ |
| C | 对调 `GraphSlot` / `ActionRow` | 仓库 31/31 **全绿**；我的探针 CA1 ✗ | **覆盖缺口**：R2 顺序无回归守卫 |
| D | JS 断点 640 → 100（CSS 仍 640） | 仓库 31/31 **全绿** | **覆盖缺口**：断点数值无回归守卫 |

新增断言不是自证：GUI 测试读已构建 bundle（`dist/gui-experimental.cjs`）+ mini-DOM 的 `class`/文本/`data-*`，
`data-collab-at` 又与客户端独立计数 `layoutLoads` 交叉印证；TUI 断言读 `captureCharFrame()` 的字符帧，非重算期望值。
既有断言未弱化：`test/gui-panel.mjs` 的 5 行删除全部是断言标题改名 + fixture 增强（`return {...BOARD, at: boardLoads}`）；
`test/tui-render.mjs` 无删除行。

### 8. 文档一致性 —— 通过（3 处措辞需改）

核对 `docs/collab.md:806 / :874 / :882 / :1076–1108`、`README.md:100 / :105 / :295`、`skills/collab/SKILL.md:52–55`、
`CHANGELOG.md:6–32` 与实现：

- 一致：320px/1fr、窄屏单栏 + 返回列表、`data-collab-slot` 空元素 + `min-height:0`、轮询不重置、归档仍存在、
  消失清空 + toast、只读、TUI 3–5 行与 `… +N`、测试计数（17→31 / 49→54）。
- **不一致①**：TUI 明细实际顺序是 `↳` 拉起的会话**在最前**（复用 `sessionDetailRows`，`src/tui.tsx:428–460`），
  而 `docs/collab.md:1105` / `README.md:105` / `CHANGELOG.md:26` 写成"锁 / 交接 / 队列 / `↳`"。GUI 的
  `DetailItems` 顺序（锁→交接→队列→`↳`，`src/gui.tsx:651–666`）与 R2 一致；TUI 建议只改文档措辞。
- **不一致②**：PRD R3 的"被归档/消失时自动清空" vs 实现/文档的"归档仍存在"（见第 2 项）。
- **不一致③**：PRD R2 的"关系图槽位 ~200px，可折叠"在当前实现是 `min-height:0` 空占位；design §1 明确写了
  "现在渲染 null + min-height 0"。需 owner 确认高度/折叠归 `board2-graph` 子任务所有（本任务按 design 执行）。
- 小瑕疵：`docs/collab.md:872 / :1085`、`README.md:100` 写"<640px"，CSS 实际是 `max-width:640px`（≤640 即触发）；纯文字口径。

---

## 风险清单（按严重度）

| 级别 | 项 | 位置 | 建议 |
| --- | --- | --- | --- |
| 中 | R2 槽位顺序无回归断言（变异 C 全绿） | `test/gui-panel.mjs:786–793` | 断言 `collab-detail-pane` 直接子元素顺序 = header/graph/actions/items |
| 中 | 断点数值 640 无断言（变异 D 全绿） | `test/gui-panel.mjs:870–874`、`src/gui.tsx:135` | 桩里匹配 `640px` 字面量，或断言 `matchMedia` 收到 `(max-width: 640px)` |
| 低 | TUI `enter/space/click` 同时激活详情，与已展开子行重复展示 | `src/tui.tsx:684–703` | owner 定：接受（补 PRD）或去掉 `setActive(true)` |
| 低 | PRD R3 / R2 与实现、design 的口径冲突 | `prd.md:7–8` | 回写 PRD（归档不清空；槽位高度归 graph 子任务） |
| 低 | TUI 明细顺序文档写反 | `docs/collab.md:1105`、`README.md:105`、`CHANGELOG.md:26` | 改成"（`↳` 优先，其次 锁 / 交接 / 队列）" |
| 低 | 变异下测试**崩溃**而非报失败 | `test/gui-panel.mjs:901`（`fireClick(byClass('collab-back'))` 无存在性守卫） | 加 `expect('back button exists', Boolean(back))` 或可选链守卫 |
| 低 | `collab-split-narrow` 类无对应 CSS | `src/gui.tsx:797` vs `:313–:325` | 删除或补样式（当前仅作 hook） |
| 低（既有） | 快照 RPC **永不 settle** 时 `inFlight` 永久为 true，面板数据不再刷新 | `src/gui.tsx:220–263`（0.5.x 起） | 非本次引入；可另开任务加超时（探针 CA4 首次版本意外复现） |
| 低 | `escape` 命令占用面板焦点下的 Esc（宿主可能用 Esc 关面板） | `src/tui.tsx:733` | 文件头已注明"真机键位映射为人工检查"；建议真机确认一次 |

## 复核过程留痕

- 探针（未入库，位于 `/tmp/opencode/`）：`probe-gui.mjs`（44 项 = 仓库 31 + CA 13）、`probe-tui.mjs`（59 项 = 仓库 54 + CA 5）；
  两者由 `test/*.mjs` 复制、仅把 root 改为绝对路径并追加探针块，**未改动仓库测试文件**。
- 变异源码均临时写入 `src/gui.tsx`，每次结束 `cp /tmp/opencode/gui.impl.tsx src/gui.tsx` 还原并重建 GUI bundle；
  最终 `sha1sum` 与备份一致，`git status --short` 仍为原有 9 改 + 5 未跟踪目录。
- 未 commit / 未 add / 未 push / 未重启任何服务、未触碰真实会话。


---

## 增量复核（覆盖缺口与口径）

- 触发：首轮判「可提交」，留 2 个覆盖缺口（槽位顺序、断点数值）与 4 处口径不一致；作者已补齐。
- 本轮对象：`src/gui.tsx`（+1 行 CSS）、`src/tui.tsx`（明细顺序 + 取消 enter/click 激活）、
  `test/gui-panel.mjs`、`test/tui-render.mjs`、`docs/collab.md`、`README.md`、`CHANGELOG.md`、任务 `prd.md`。
- 结论：**代码与测试：可提交；文档：需修 3 处**（`CHANGELOG.md:29–30` 与 `README.md:295` 的测试计数仍是旧的
  31/54，实际 34/56；`prd.md:6` R1 仍写 `<640px`，实现/文档是 `max-width:640px`＝`≤640px`）。
  首轮两条覆盖缺口均已闭合并经变异证明；代码侧无新缺陷、无新写路径。

### 1. 槽位顺序 —— 通过（缺口已闭合，变异必失败）

实现未变（`src/gui.tsx:684–687` 仍是 header → `GraphSlot` → `ActionRow` → `DetailItems`），
新增断言 `test/gui-panel.mjs:799–813` 直接比较 `collab-detail-pane` 的**直接元素子节点类名数组**。

隔离副本变异（`/tmp/opencode/iso-board2`，仓库工作区未动；对调 `GraphSlot`/`ActionRow` 后重建 GUI bundle）：

```
--- MUTATION 1 (slots swapped):
  ✗ PN8 the detail pane order is header → graph slot → actions slot → items (R2)
     — ["collab-detail-header","collab-detail-section collab-actions-slot","collab-detail-section collab-graph-slot","collab-items"]
=== 33/34 panel checks passed
```

恢复后：`=== 34/34 panel checks passed`（基线见下）。

### 2. 断点守卫 —— 通过（缺口已闭合，变异必失败）

`test/gui-panel.mjs:885–957` 用可变 `viewport` 计算 `matches`（`viewport <= limit`），分别在 **639 / 641**
挂载两次：639 = 单栏、641 = 分栏；并保留 `← 返回列表` 存在性守卫（`test/gui-panel.mjs:947–950`），
上一轮"缺节点 → `TypeError` 崩测试"的问题随之消失。

隔离副本变异（`narrowQuery` 的 `640` → `100`）：

```
--- MUTATION 2 (640 -> 100):
  ✗ PN9 639px is one pane: the list only, no detail placeholder
  ✗ PN9 selecting a session replaces the list with the detail and offers ← 返回列表
  ✗ PN9 the detail offers a real ← 返回列表 button
  ✗ PN9 返回列表 clears the selection and brings the list back
=== 30/34 panel checks passed
```

（641 一条仍绿——宽屏侧本来就该分栏；639 侧按预期失败，满足"至少一条失败"。）

正常实现下：

```
✓ PN8 the detail pane order is header → graph slot → actions slot → items (R2)
  — ["collab-detail-header","collab-detail-section collab-graph-slot","collab-detail-section collab-actions-slot","collab-items"]
✓ PN9 639px is one pane: the list only, no detail placeholder
✓ PN9 641px is the split: list + detail pane, no 返回列表 button
✓ PN9 the detail offers a real ← 返回列表 button
✓ PN9 返回列表 clears the selection and brings the list back
=== 34/34 panel checks passed
```

残余小口（不阻塞）：`viewport=640` 本身没有断言（639/641 已把数字夹住；`≤` 与 `<` 的边界差 1 只在措辞）。

### 3. TUI 新旧一致 —— 通过（enter/space/click 不再激活）

- 明细顺序改为 `detailLines` 内联拼接 `lockRows → handoffRows → queueRows → spawnRows`（`src/tui.tsx:547–578`）；
  **展开树**仍走 `sessionDetailRows`（spawn 在前，`src/tui.tsx:476–484`），0.6.0 的 `enter` 展开帧因此逐行不变。
- `toggleSelected` / `clickRow` 不再 `setActive(true)`（`src/tui.tsx:717–729`）；`move` 仍激活（`j/k` 选中），
  `clearSelection` 仍由 `escape` 调用（`:757`）。顶部注释同步改成"`enter`/`space` 与点击只展开/收起"（`:685–689`）。
- 仓库新增断言：

```
✓ R4 the detail rows are ordered locks → hand-offs → … +N (↳ last, truncated here)
  — 详情 ses_a1 · build · alpha worker |   1 持有 · 0 排队 · 2 交接 · 1 队列 · 1 拉起 |   🔒 named:tree-window · … |   → b_tree_spawn · … |   … +3
✓ R4 enter expands the row but opens no detail block (only j/k selects)
  —   ▾ ses_a1  build  alpha worker  🔒1 ‹2› ⇢1 [frozen] [urgent]
✓ R4 clicking a session row expands it (the same tree, mouse path) and does not open the detail block
✓ R4 at mount no row is selected: no › marker and no 详情 block
✓ R4 j selects one row and appends 3–5 detail lines under the tree — 9 → 12 lines
✓ R4 esc clears the selection: no › marker, no detail block, the tree is unchanged
=== 56/56 checks passed
```

- 自写探针（`/tmp/opencode/probe-tui2.mjs` = 仓库测试副本 + 独立断言，跑在仓库 `dist/tui.js` 上）：

```
✓ CB1 enter expands the tree exactly as 0.6.0 (5 inline rows) and opens no detail — 9 -> 14
✓ CB2 space collapses back and still does not select — 9 -> 9
✓ CB3 j selects ses_child: +3 lines — 9 -> 12
✓ CB4 selecting ses_a1 gives 5 detail lines in the documented order (锁 → 交接 → 队列 → ↳)
  — 详情 ses_a1 … | 🔒 named:tree-window … | → b_tree_spawn … | … +3
✓ CB5 escape clears: no ›, no detail, frame equals the mount frame
✓ CB6 the 已归档 fold can be selected but adds no detail block — ›   ▸ 已归档 1
=== 62/62 checks passed
```

- 既有断言：`test/tui-render.mjs` 本轮新增 2 条；唯一被改动的是既有鼠标展开断言
  （`test/tui-render.mjs:608–613` 加了 `!mouseFrame.includes('详情')` 并改标题）——**加强、非弱化**；
  `enter` / `j` / `esc` / 树结构断言均未改。`git diff` 中该文件 92 增 2 删（2 删即上述断言的两行）。

### 4. PRD 与实现/文档口径 —— 通过（R3/归档），1 处措辞仍需改

- 「归档只保留不清空」：`prd.md` R3 与验收条目已回写（"活跃与已归档都消失…；被归档 ≠ 消失…仍可选中"），
  `docs/collab.md:1101`、`README.md:100`、`CHANGELOG.md:18–20` 一致；探针/测试（首轮 CA2/CA5 + 仓库 PN8）
  与实现 `src/gui.tsx:739–748` 一致。
- 「≤640px」：`docs/collab.md:872 / :1085 / :1099`、`README.md:100`、`CHANGELOG.md:23` 均写
  `≤640px` / `max-width:640px`，与 `src/gui.tsx:135 / :326` 一致；**但 `prd.md:6` R1 仍写 `<640px`**（差在 640 这一像素）。
- 测试计数：`CHANGELOG.md:29–30` 仍写 `gui-panel 17 → 31` / `tui-render 49 → 54`，`README.md:295` 仍写
  `54 项 TUI 渲染 … 31 项 GUI 面板渲染`；本轮实测 **56 / 34**（作者 `research/impl-notes.md` 的原始输出也是 56/34）。
- TUI 明细顺序的文档已改为"锁 / 交接 / 队列 / `↳`"（`docs/collab.md:1104–1105`、`README.md:105`、
  `CHANGELOG.md:26–27`），与 `detailLines` 一致。可选 nit：`docs/collab.md:882` / `README.md:105` 里描述
  **展开树**的"锁 / 交接 / 队列 / `↳` 子会话"仍是旧顺序（实际 spawn 在前，0.6.0 起如此，非本次引入）。

### 5. 回归与只读 —— 通过

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
=== 870/870 checks passed
=== 12/12 checks passed
=== 20/20 board checks passed
=== 50/50 checks passed
=== 56/56 checks passed      (tui-render)
=== 47/47 checks passed      (gui-entry)
=== 34/34 panel checks passed (gui-panel)
✓ skills/collab/SKILL.md (collab) / ✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
```

与派单目标 `870 + 12 + 20 + 50 + 56 + 47 + 34` 一致（合计 1084）。工具数 22（`test/handoff-harness.mjs:9250 / :10820 / :11306`）
不变；版本仍 0.7.0（`package.json:3`、`src/constants.ts:409`），未改。
只读：本轮 `src/gui.tsx`/`src/tui.tsx` 新增宿主调用仍只有 1 处 `ctx.toast.show`（首轮引入的消失提示），
无锁 / 队列 / 归档 / 权限调用；`test/gui-entry.mjs` 的严格 Proxy（47/47）通过。

### 6. 范围 —— 通过

`git diff --numstat`＝CHANGELOG 27/0、README 3/3、docs 37/3、SKILL 4/1、gui 282/54、tui 112/26、
gui-entry 9/1、gui-panel 308/5、tui-render 92/2；`git status` 仍是 9 个修改文件 + 5 个既有未跟踪任务目录。
PRD 改动在任务目录内（未跟踪），符合"只改实现/测试/文档/PRD/任务目录"。
两轮变异全部在 `/tmp/opencode/iso-board2`（当前工作区的 tar 副本 + `node_modules` 符号链接）中进行，
**未修改工作区源码**；结束后已删除副本，`sha1sum src/gui.tsx = 12f25a8a…`、`src/tui.tsx = 3847d48c…` 与复核开始时一致。
未 commit / 未 add / 未 push / 未重启服务。

### 增量风险清单

| 级别 | 项 | 位置 | 处置 |
| --- | --- | --- | --- |
| 中（文档） | 测试计数过期：31/54 → 应为 34/56 | `CHANGELOG.md:29–30`、`README.md:295` | 改数字（并可在括号里补"槽位顺序 / 639·641 / enter 不打开详情"） |
| 低（文档） | PRD R1 仍写 `<640px`，实现/文档为 `≤640px` | `.trellis/.../prd.md:6` | 改 `≤`（或把 639/641 断言改成 640/641） |
| 低 | `viewport=640` 本身未被断言 | `test/gui-panel.mjs:885–957` | 可选：加第三条 640 断言，或接受 639/641 夹逼 |
| 低（既有） | 展开树顺序的旧文案（spawn 在后） | `docs/collab.md:882`、`README.md:105` | 非本次引入，可顺手改"`↳` 子会话 / 锁 / 交接 / 队列" |
| 低（既有） | 快照 RPC 永不 settle → `inFlight` 卡死 | `src/gui.tsx:220–263` | 已按派单只记 notes（`research/impl-notes.md` §10），不修 |
