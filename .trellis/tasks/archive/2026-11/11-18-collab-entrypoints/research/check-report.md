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
> 增量复核（`044f89f`，轮询 key + GUI 21 项）见文末「## 增量复核（轮询 key）」；上文的 `29 + 20` 是当时快照。

## 增量复核（轮询 key）

> 复核对象：`044f89f`（相对 `4546818` 的全部改动；本轮 delta = `src/gui.tsx` 轮询 key、`test/gui-entry.mjs` 第 21 项、
> `CHANGELOG.md` / `README.md` 计数、新增 `.trellis/spec/frontend/opencode-plugin-ui.md`）。
> 只审不改：未改实现/测试/文档，未 add/commit/push。

**结论：需修（仅 1 行文档；代码与测试无阻塞）**

- 代码：轮询 key 的三态语义正确；切换会话立即 `load()`；`pageHidden`/空列表时停止；**无切换后双定时器**；
  无隐藏时轮询路径（单实例探针实测）。
- 测试：新增第 21 项是真断言——把 key 改回布尔后**恰好这 1 项失败**，且 120+120 ms 的窗口远小于 2 s，
  不是靠定时器误判通过。
- 文档：`CHANGELOG.md:56` 仍写 **638 + 12 + 35 + 29 + 20**，与同文件 `:42`（21 项）、`README.md:189`（21 项）
  及实际 `21/21` 不一致。**这是本轮唯一需要修改的地方（20 → 21）**。
- 另一条非阻塞残余：`load()` 的 `inFlight` 守卫可能吞掉切会话时的“立即重载”（见风险 R-7，实测可复现但窗口窄）。

### 1. key 语义与三种状态切换 —— 通过

代码（`src/gui.tsx:465-478`）：

```ts
createKeyed(
  () => {
    if (pageHidden() || ctx.sessions.list().length === 0) return false;
    return ctx.sessions.current()?.id ?? '';
  },
  () => { void store.load(); const timer = setInterval(() => void store.load(), POLL_MS);
          onCleanup(() => clearInterval(timer)); }
);
```

SDK 语义（`node_modules/@opencode/plugin/dist/gui/reactive.js:31-73`）：plain accessor 的 key 为
`undefined/null/false` 时视为 inactive（有 `otherwise` 才跑）；每个 key 一个独立 `createRoot`，key 变化时
effect 的 cleanup **先** `scope.dispose()`（清掉上一轮的 `onCleanup`）**再**跑新一次 `fn`。

我用一个**单 instance** 的探针（见 §2 的说明：默认 Node 加载会得到两份 solid-js，必须注入同一命名空间，
才等价于生产）记录每次 snapshot 调用与 `setInterval/clearInterval`：

```
--- switch（id A → id B，200 ms 时切换）
before 1 total 4
1ms:ses_probe, 302ms:ses_other, 2303ms:ses_other, 4305ms:ses_other
timers: set:1@1ms, clear@302ms, set:2@302ms
```

- `false`（无列表 / 隐藏）：`stop` 场景 —— 列表清空后**不再有调用**（`total` 停在 1，2 s tick 未发生），
  恢复列表后立即 `load()` 并重新起表：
  ```
  before-empty 1 total 1
  1ms:ses_probe
  after-restore 2 1ms:ses_probe, 2614ms:ses_probe
  ```
- `''`（有列表、无当前会话）：`home` 场景 —— `'' → id` 与 `id → ''` 都立即重载且**各自只有一枚定时器**：
  ```
  home total 4 1ms:-, 302ms:ses_probe, 503ms:-, 2504ms:-
  timers: set:1@1ms, clear@302ms, set:2@302ms, clear@503ms, set:3@503ms
  ```
- hidden 初始（`document.hidden = true`）：`hidden total 0`（没有起表）。
- **无隐藏时轮询**、**无双定时器**：`switch`/`home` 的 timer 日志都是 `set → clear → set`，没有并存的两枚；
  4.3 s 内调用次数与新表 tick 对齐（旧表 tick 的 2.0/4.0 s 位置没有出现）。

补充：`pageHidden()` 是**非响应式**读取，`document.hidden` 变化本身不会触发 key 重算（依赖
`sessions.list()` 等其他响应式源推动）。这是 0.4.2 起就有的读法，本次 delta 未引入；见风险 R-8。

### 2. 第 21 项断言真实性（独立变异）—— 通过

把**构建产物** `dist/gui-experimental.cjs` 里的 key 改回旧布尔形式（源码不动），同一条命令：

```
$ node --conditions=browser test/gui-entry.mjs
  ✓ R2 the one poll names the routed session (the queue number is real, not a default 0) — {"session":"ses_probe"}
  ✗ R2 switching the routed session reloads at once (no 2s window with the old queue) — 1 → 1: {"session":"ses_probe"}
=== 20/21 checks passed
FAIL: R2 switching the routed session reloads at once (no 2s window with the old queue)
```

还原后 md5 与备份一致（`fc09580952c259f8b49c5228c651d3de`）。判定：

- 断言只失败这一项，说明它确实锁的是“key 含会话 id”这一改动；
- 测试窗口 = 首次 120 ms + 切换后 120 ms（共 240 ms ≪ `POLL_MS=2000`），旧表不可能在窗口内 tick，
  所以通过时只可能来自 key 变化触发的 `load()`；单实例探针也显示立即重载发生在 ~302 ms（而非 ~2000 ms）；
- 测试快照是**立即 resolve** 的，不覆盖“切换时恰有一次请求在飞”的情形（风险 R-7）。

### 3. 无回归 —— 通过

```
$ pnpm build        → exit 0
$ pnpm typecheck    → $ tsc --noEmit，exit 0
$ pnpm test         → exit 0
  === 638/638 checks passed
  === 12/12 checks passed
  === 35/35 checks passed
  === 29/29 checks passed
  === 21/21 checks passed
$ node scripts/check-skill.mjs → skills ok
```

与要求一致：**638 + 12 + 35 + 29 + 21**；TUI 17→29 未回退，GUI 20→21。

### 4. spec 文档与实现 —— 一致（除 CHANGELOG 计数）

- 新增 `.trellis/spec/frontend/opencode-plugin-ui.md`：
  - §1 槽位表写“**没有左侧应用侧栏**”，与 `docs/collab.md` §11.11.3、实现一致（不伪造左栏）；
  - §2 的 key 代码片段与 `src/gui.tsx:465-478` 一致（含 `pageHidden()`、`list().length===0 → false`、
    `current()?.id ?? ''`），并写明 `snapshot({session})` 必须传当前会话（`:126-127`）；
  - §3 只读硬约束与实现一致（只有 `layout.open` / `panel.open` / toast）；
  - §4 TUI 约定（默认一行、`onMouseDown`、局部 signal、`wrapMode="none"`、展开不 `load()`）与
    `src/tui.tsx:495-553` 一致；
  - §5 测试约定（真实鼠标、require 产物 + 严格 Proxy + `--conditions=browser` + `document` 垫片、变异验证）
    与 `test/tui-render.mjs` / `test/gui-entry.mjs` 现状一致。
- `.trellis/spec/frontend/index.md` 新增一行指向该文档。
- **唯一不一致**：`CHANGELOG.md:56` 仍写 `… + 29 + 20`，应为 `… + 29 + 21`
  （同文件 `:42` 已写 21 项，`README.md:189` 已写 21 项）。属文档计数漏改，不影响代码。
- spec §2 的“页面隐藏时停轮询”与实现的关系同 §1 末尾的 R-8（非响应式读取，继承既有行为，不矛盾但有时机差）。

### 5. 提交范围 —— 通过

`git show --stat 044f89f` 共 20 个文件，全部在允许/声明范围内：

- 实现：`src/gui.tsx`、`src/tui.tsx`
- 测试：`test/gui-entry.mjs`（新，299 行）、`test/tui-render.mjs`
- 文档/版本：`README.md`、`docs/collab.md`、`CHANGELOG.md`、`skills/collab/SKILL.md`、
  `package.json`（仅 `version` + `test` 脚本）、`src/constants.ts`
- Trellis 工作流：`.trellis/spec/frontend/{index.md,opencode-plugin-ui.md}`（delta 声明的新 spec）、
  `.trellis/tasks/11-18-collab-entrypoints/**`（PRD/design/implement/研究记录，含上一轮 check-report）
- **无** `pnpm-lock.yaml` / `dist/` / `node_modules/` / 无关源码；`git diff 4546818 044f89f -- package.json`
  只有 version 与 test 脚本两处，无新依赖。

### 本轮风险（均非代码阻塞）

- **R-7（in-flight 竞态，残余）**：`load()` 在 `inFlight` 时直接 return（`src/gui.tsx:115`）。若切会话瞬间
  恰有一次请求在飞，新 key 的“立即 load”被吞掉，旧会话的回包仍会落库，直到下一个 tick 才换：
  ```
  $ SLOW=1 node --conditions=browser <单实例探针> switch
  before 1 total 3
  1ms:ses_probe, 2303ms:ses_other, 4304ms:ses_other
  timers: set:1@1ms, clear@301ms, set:2@301ms
  ```
  （快照人为延迟 500 ms；切换发生在 200 ms。）建议（可选）：在 `load()` 的 `finally` 里比较
  “请求时的 session id != 当前 `sessions.current()?.id`”，若是则再排一次 `load()`。窗口窄、非本次验收项。
- **R-8（pageHidden 非响应式，继承）**：见 §1 末尾；不是本次引入，若要“隐藏即停/可见即续”需把可见性
  做成响应式源或监听 `visibilitychange`。
- **R-9（测试加载保真度）**：`test/gui-entry.mjs` 里 bundle 的 `require('solid-js')` 解析到 `dist/solid.cjs`，
  而测试自身 `import 'solid-js'` 解析到 `dist/solid.js`——**两份 Solid**。结果是 bundle 里的 `onCleanup`
  在该 harness 中不生效：默认探针日志为 `set:1@1ms, set:2@302ms`（无 clear），只有把两者注入成同一命名空间后
  才出现 `clear@302ms`。所以第 21 项能验证“立即重载”，但**这个 harness 无法用来断言定时器清理/双定时器**；
  生产是单实例（否则 0.4.2 的 GUI 渲染也不成立），我用单实例探针补验了无双重定时器。无需改代码，
  但后续若加“无重复定时器”断言，必须先统一 Solid 实例（例如用 `Module._load` 注入命名空间）。
- **R-10（文档）**：`CHANGELOG.md:56` 计数 20 → 21。

### 增量结论

轮询 key 的语义、启停、切换重载均正确，第 21 项断言经变异验证有效，构建/类型/测试全绿且计数为
**638 + 12 + 35 + 29 + 21**；提交范围干净、无新依赖、spec 与实现一致且未声称左侧栏。
**需修 1 处文档计数（`CHANGELOG.md:56` 20 → 21）；代码可提交。** R-7/R-8/R-9 为记录在案的非阻塞风险。
