# 独立复核报告：collab 入口与 TUI 侧栏交互（0.5.1）

> 任务：`.trellis/tasks/11-18-collab-entrypoints`
> 复核对象：未提交改动（`/data/project/collab`），基线 `4546818`
> 复核方式：冷上下文、只审不改；不 `add` / `commit` / `push`；未修改任何实现文件
> 结论：**可提交**（无阻塞问题；风险与可选改进见文末）

## 0. 复核环境与改动范围

```
$ git status --short
 M CHANGELOG.md
 M README.md
 M docs/collab.md
 M package.json
 M skills/collab/SKILL.md
 M src/constants.ts
 M src/gui.tsx
 M src/tui.tsx
 M test/tui-render.mjs
?? .trellis/tasks/11-18-collab-entrypoints/
?? test/gui-entry.mjs
```

只改允许清单内文件 + 任务目录；`dist/` 被 `.gitignore` 忽略（构建产物，未入库）。`package.json`
仅改 `version` 与 `test` 脚本，`dependencies` 不存在、`devDependencies` 未变（无新增依赖）。

## 1. R1 Desktop 命令 —— 通过

- 注册：`src/gui.tsx:529-543`，`ctx.add(Command, () => ({...}))` 使用**函数形式**（SDK：函数形式会在其读到的响应式值变化时重跑，见
  `node_modules/@opencode/plugin/dist/gui/core.d.ts:345-355`）。
- 字段：`id:'open'`、`bind:'mod+shift+l'`、`slash:{name:'collab'}`、`section:'navigation'`、
  `keywords` 含 `collab lease lock handoff queue 协作 租约 交接 队列`（`src/gui.tsx:531-537`）。
- `enabled: !!ctx.sessions.current()`（`:539`）：`Sessions.current()` 在 SDK 文档标注 **Reactive**
  （`host-apis.d.ts:724-730`），配合函数形式注册，路由变化会重算 `enabled`（测试只验证两个静态快照：
  有会话 `true` / 无会话 `false`，见 `test/gui-entry.mjs:157-204`）。
- `run` 只有一处动作：`ctx.layout.open('${ctx.id}:${PANEL_TAB}', session)`（`src/gui.tsx:541`），
  无任何 rpc / tool / permission / 写 API（严格 Proxy context 通过：`test/gui-entry.mjs:241-246`）。
- 实测：`collab:main` + `session.id === 'ses_probe'`（`test/gui-entry.mjs:183-189` 输出 `"collab:main"`）。

## 2. R2 会话头计数条 —— 通过（渲染分支为静态证据，见风险 R1）

- 注册：`ctx.add(Slot, { at:'session.header', order:20, render: input => <HeaderCounts session={input.session}/> })`
  （`src/gui.tsx:548-552`）；SDK `SlotMap['session.header']` 确实提供 `session: MountedSession`
  （`registries.d.ts:822-840`）。
- 同一 store：`storeFor(ctx)` 返回 `setup` 里创建的 `sharedStore`（`src/gui.tsx:151-156, 457`），
  Panel（`:318`）、HeaderCounts（`:362`）、ComposerPill（`setup` 内同一个 `store`）共用；
  轮询仍只有 `setup` 里那一个 `createKeyed` + `setInterval`（`src/gui.tsx:464-468`），未新增流。
- 无快照：`label()` 在 `!data && !error` 时返回 `undefined`，`<Show when={label()}>` 无 fallback →
  渲染空（`src/gui.tsx:364-381`），不会出现 `0 · 0 · 0`。
- 不可达：`store.state.error` → `ctx.t('header.unreachable')` = `collab: n/a`（`src/gui.tsx:365`，
  i18n en/zh `:421, :450`），按钮仍 `onClick={open}` → `layout.open`。
- 数字同源：`data.locks.length` / `data.handoffs.length` / `data.queue.length`（`:368-372`），
  与面板/侧栏同一份 snapshot；桌面面板本身不渲染 queue 列（既有行为），lock/handoff 完全同源。
- 样式：`.collab-counts`（`:224-226`）只在既有 `Style` 里追加，无新容器/布局包裹。
- **实测边界**：`test/gui-entry.mjs` 的 20 项是**注册级**断言（Node 下无 DOM，design §4 允许降级），
  未渲染 HeaderCounts 的三个分支；分支正确性来自上述 `label()`/`Show` 构建产物证据
  （`dist/gui-experimental.cjs` 内 `createComponent(Show,{get when(){return o()},...})`），
  最终确认仍需 Desktop 手工验收（PRD 验收第 1、2 条）。

## 3. 实现方自述「共享轮询带 session」—— 通过（判定为修 bug，非回归；附带 ≤2 s 滞后）

- 契约：`collab.state.snapshot` 输入是 `{ workspace?, session? }`（`src/rpc.ts:131, 187-190`）；
  `queue` 明确是「**本人**提交给受保护会话的请求」，不传 `session` 就是空数组
  （`src/rpc.ts:99-107`；`src/core/snapshot.ts:176-185`，注释直说 “no session named → no scan”）。
- 因此旧 GUI 请求 `snapshot({})` 若被用于展示 `队列`，就是结构性假 0。实现改为
  `snapshot(current ? { session: current.id } : {})`（`src/gui.tsx:126-127`）；仍是**同一次调用、同一条流**，
  `sessions` / `locks` / `handoffs` 只受 `workspace` 影响，不受 `session` 影响（`snapshot.ts:174-185`）。
  TUI 早已传 session（`src/tui.tsx:200`），本改动只是把 Desktop 对齐。
- 失败面：`mineFor()` 的 `readdirSync/readdirSync(queueDir)` 全部 try/catch 返回空
  （`src/core/owner-queue.ts:155-194`），不会因队列目录缺失让整个快照 reject。
- **切换会话的滞后**：轮询 key 仍是 `!pageHidden() && ctx.sessions.list().length > 0`（`src/gui.tsx:464-465`），
  **不含 sessionID**；`load()` 每次调用时才读 `sessions.current()`（`:126`），所以切换会话后
  最多等一个 tick（2 s）才换成新会话的 queue，切换瞬间不会立即重载。旧行为是恒 0（更差），
  故不是回归；但计数条可能短暂显示上一个会话的 queue（风险 R2，可选改进：把 routed session id 放进
  `createKeyed` 条件，切换即重载）。
- `test/gui-entry.mjs:258-266` 实测：打开会话后只有 1 次调用，入参 `{"session":"ses_probe"}`。

## 4. R3 TUI 折叠 —— 通过

- 默认折叠：`createSignal(false)`（`src/tui.tsx:498`）、`rows()` 折叠时返回 `[]`（`:533`），摘要行
  `▸`（`:538`）。实测帧：`▸ 锁 2 · 交接 1 · 队列 1`，1 行、无 `🔒`（`test/tui-render.mjs:351`）。
- 点击摘要行：`<box onMouseDown={toggle}>`（`src/tui.tsx:537`），`toggle` 只翻转 signal（`:505`），
  **不调用 `load()`**。
- 明细：`sidebarRows()` 顺序 lock → handoff → queue（`src/tui.tsx:451-484`）；`DETAIL_LIMIT = 4`，
  超出 push `+N`（`:519-531`）。实测展开 1 + 4 行、逐行顺序断言（`test/tui-render.mjs:365-380`）；
  6 个租约 → 4 行 + `+2` 且第 5 条不出现（`:436`）。
- 点明细行：`<box onMouseDown={openPanel}>`（`src/tui.tsx:544`），`openPanel` 调
  `ctx.ui.panel.open('collab.status')`，返回 `false` 时 toast 既有文案（`:507-512`，`NO_SESSION`
  与 keymap 共用 `:53, :595`）。实测 `opened === ['collab.status']`（`test/tui-render.mjs:390`）。
- 再点摘要行折叠：实测回到 1 行 `▸` 且 `🔒` 消失（`:399`）。
- **不新增轮询**：展开/折叠前后 `calls.length` 始终 1（`:383, :405`）。我自己做了变异验证（见 §7），
  把 `store.load()` 塞进 toggle 后两条断言立即失败（1→2 / 1→3），证明断言不是摆设。

## 5. R4 降级 —— 通过

- 无鼠标：默认折叠；`/collab` 命令与 `ctrl+shift+l` keymap 未改动（`src/tui.tsx:581-598`；既有
  `test/tui-render.mjs` 的 R4/R7 keymap 断言全绿）。
- 宿主固定一行高度：只影响显示（`<box>` 内容被裁剪），不抛错；文档明确写出降级
  （`docs/collab.md:846-866`，尤其 §11.11.3 第 2 条 `:863-865`；README `:78`）。
- `panel.open` 返回 false：toast + 不抛，且折叠仍可用（`test/tui-render.mjs:472-491`）。
- 无快照：展开显示 `collab: n/a · 点击打开面板`，明确**不是**「无协作活动」（`test/tui-render.mjs:501`）；
  空快照（可达、0 行）显示「无协作活动 · 点击打开面板」（`:458`）。
- `panel.open` 是 UI 动作，不涉及数据写；无鼠标时不会被触发。

## 6. R5 只读 —— 通过

- `src/gui.tsx` 新增代码只调用 `layout.open`（`:541, :375`）；`src/tui.tsx` 新增代码只调用
  `ctx.ui.panel.open` / `ctx.ui.toast.show`（`:507-512`）。
- 新增行内无 `unlock` / `archive` / rpc 写方法 / `layout.close`（对 diff 的新增行 grep 无命中）。
- GUI 测试用严格 `Proxy` context（读未提供的键即抛，`test/gui-entry.mjs:96-121`），
  `setup` 全流程未触碰任何写 API（`:241-246`）。
- 快照契约未改（`git diff src/rpc.ts src/core/**` 为空）。

## 7. 测试真实性（变异实验，直接改构建产物、不碰源码）

方法：备份 `dist/tui.js` / `dist/gui-experimental.cjs` → 对**构建产物**打坏一处 → 只跑对应测试 →
用备份还原（还原后 md5 与备份一致，已核）。这样能验证「断言真的会失败」且不修改实现源码。

1) 摘要行 `onMouseDown` 改成空函数（`dist/tui.js` 内 `_el$4`）：
```
=== 22/29 checks passed
FAIL: R3 clicking the summary line expands it: ▾ plus the detail rows
FAIL: R3 the details go leases → hand-offs → queue, at most 4 rows
FAIL: R3 clicking a detail row opens the /collab panel
FAIL: R3 more than 4 rows end with a +N line instead of growing without bound
FAIL: R3 an empty snapshot expands to an explicit "no activity" row (not a blank pane)
FAIL: R4 a host that refuses panel.open gets the existing toast, and nothing throws
FAIL: R3 expanded with no snapshot says collab: n/a, not "no activity"
```
→ 展开确实由**真实鼠标事件 + 渲染器命中测试**触发，不是直接读 props。

2) `toggle` 里加一句 `store.load()`：
```
✗ R3 expanding renders from the same snapshot: no extra load() — 1 → 2 calls
✗ R3 folding is free too: still the same number of loads — 1 → 3 calls
=== 27/29 checks passed
```
→ “展开不新增轮询”是真断言。

3) 明细行 `onMouseDown` 从 `openPanel` 改成 `toggle`：
```
✗ R3 clicking a detail row opens the /collab panel — []
=== 25/29 checks passed
```
→ 明细行的打开行为被单独锁住。

4) GUI 产物里 `enabled` 恒 true + `run` 打开 `collab:other`：
```
✗ R1 run opens this plugin's panel tab for the current session — "collab:other"
✗ R1 without a routed session the command is disabled and run() is a no-op — {"enabled":true,"opened":0}
=== 18/20 checks passed
```
→ Command 的 enabled / run 断言有效。

既有 17 项 TUI 检查：`git diff test/tui-render.mjs` 只改了 harness（新增 `snapshot`/`panelOpen`、
`opened`/`toasts` 计数）并在文件末尾**追加** 12 项；原有断言未删除、未放宽（唯一文本变化是新增 §7 注释）。
`test/snapshot-shape.mjs` / `test/readonly-default.mjs` / `test/handoff-harness.mjs` 未被改动。

**测试质量备注（非阻塞）**：`test/gui-entry.mjs` 的 20 项里有 2 项接近恒真：
`R2 the setup returns no cleanup that writes (it may return one)`（`:151`）与
`R5 the command declares no write action (only open/close of the panel text)`（`:176`，只是对标题/描述做正则）。
真正的只读证明由严格 Proxy（`:241`）和 0 调用断言（`:246`）承担，所以不影响结论。

## 8. 回归与范围 —— 通过

```
$ pnpm build       → exit 0（dist/gui-experimental.cjs 15.58 kB，dist/tui.js 21.07 kB）
$ pnpm typecheck   → $ tsc --noEmit，exit 0
$ pnpm test        → exit 0
  === 638/638 checks passed
  === 12/12 checks passed
  === 35/35 checks passed
  === 29/29 checks passed
  === 20/20 checks passed
$ node scripts/check-skill.mjs → ✓ skills/collab/SKILL.md / ✓ skills/collab-coordination/SKILL.md，skills ok
```

- 版本一致：`package.json:3` = `0.5.1`；`src/constants.ts:310` `PLUGIN_VERSION = '0.5.1'`
  （harness 内断言两者相等，已随 638 全绿）。
- `test` 脚本已追加 `node --conditions=browser test/gui-entry.mjs`（`package.json:45`）。
- 无新增运行时依赖；`files` / `exports` 未改。
- 只改了允许清单内文件；`dist/` 为构建产物（gitignore）。

## 9. 文档事实 —— 通过

- README 入口表 `:61-62` 正确区分 Desktop `mod+shift+l` 与 TUI `ctrl+shift+l`；桌面入口写着
  「侧栏 `collab` 标签 / 侧栏 **+** 菜单」——既有右侧面板，**没有**声称左侧应用侧栏。
- README `:69` 写清「没有快照时不占位（不显示 `0 · 0 · 0`）」与 `collab: n/a` 可点；
  `:78` 写明「鼠标不可用时 `/collab` 与 `ctrl+shift+l` 仍有效；宿主固定一行高度时展开会被裁掉（不崩溃）」。
- `docs/collab.md:846-866` 新增 §11.11.3：显式写「不伪造左侧应用侧栏（GUI SDK 没有这个槽位）」，
  两条降级路径齐全，含宿主裁剪风险与「请用 `/collab` 看全量明细」。
- `skills/collab/SKILL.md:48-49` 一句入口，`scripts/check-skill.mjs` 通过。
- CHANGELOG `:6-64` 与实现一致：命令/计数条/折叠/降级/只读/测试计数/版本；文档段与 README、
  `docs/collab.md`、SKILL 的实际改动对得上。
- 契约未变：文档明确「快照契约无新增字段」（`docs/collab.md:868-870`），与 `git diff src/rpc.ts` 为空一致。

## 风险清单（均非阻塞，无需本次修复）

- **R1（测试覆盖）**：`HeaderCounts` 的「无快照隐藏 / error→n/a / 点击开面板」三个渲染分支没有
  Node 级运行时断言（本仓无 DOM、不得加依赖；design §4 明确允许该降级）。静态证据充分，
  但应保留为 Desktop 手工验收项（PRD 验收第 1、2 条）。
- **R2（≤2 s 跨会话滞后）**：GUI 轮询 key 不含 sessionID，切换路由会话后计数条的 `队列` 最多滞后
  一个 tick；旧行为恒 0，故非回归。可选改进：把 `ctx.sessions.current()?.id` 纳入 `createKeyed`
  条件，切换即重载。
- **R3（`compact` 未处理）**：`session.header` 的输入带 `compact`（SDK 建议标题挤不下时给紧凑形态，
  `registries.d.ts:826-840`），`HeaderCounts` 始终渲染全长 `锁 N · 交接 M · 队列 K`；窄窗口可能挤标题。
  PRD/design 未要求，属 UX 风险。
- **R4（默认键冲突不可验证）**：`mod+shift+l` 是否与宿主既有绑定冲突，只能在 Desktop 实机确认
  （design §2.1 已注明落地前再核）。
- **R5（缓存 timeline 的计数口径）**：`session.header` 对缓存（`active:false`）的 timeline 也会 render，
  此时组件里的 `props.session` 是该 timeline 的会话，而 queue 数来自路由会话；正常单视图不可见、
  不可点击，影响可忽略。
- **R6（测试小瑕疵）**：见 §7 末两条接近恒真的 GUI 断言；不影响只读/入口结论。

## 结论

9 项必查均通过；构建、类型检查、638 + 12 + 35 + 29 + 20 全部绿，`check-skill` 通过；
范围与版本一致，无写路径、无新依赖、无契约变更。变异实验证明新增断言（尤其 TUI 折叠/展开/跳面板/
不新增轮询、GUI 命令 enabled/run）确实会失败。**可提交**；上述 R1–R6 建议留作验收注意项或后续 patch。
