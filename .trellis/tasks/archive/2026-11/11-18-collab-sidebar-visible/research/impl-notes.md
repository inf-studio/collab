# 实现笔记（0.4.2：GUI 首启修复 + TUI 状态视图）

## 1. 真实 TUI API 形状（`@opencode/plugin@2.3.0`，opencode 2.3.1）

来源：`node_modules/@opencode/plugin/dist/tui/{plugin,context,solid}.d.ts` +
<https://opencode.ai/docs/build/plugins/cli>（本机实测版本）。

```ts
// @opencode/plugin/tui
export * as Plugin                          // { define({ id, setup }) → { id, setup } }
export { PluginContextProvider, usePlugin } // Solid 组件 + 取 context 的 hook
import type { PanelInput } from '@opencode/plugin/tui/context';
```

`setup(context)` 的 `context`（只用到的部分）：

| 字段 | 形状 | 用途 |
| --- | --- | --- |
| `options` | `Record<string, any>` | `opencode.json` 的插件 options |
| `location` | `{ directory } \| undefined` | 传给 RPC 的 `workspace` |
| `client` | `OpenCodeClient`（`rpc(definition)` → 类型化客户端） | `collab.state.snapshot` |
| `data.session` | `{ list(), status(sid), get(sid), … }` | R6 退化：本地会话列表 / busy |
| `theme` | `ResolvedTheme`（`text.base` / `text.muted` / `text.feedback.{success,warning,error}.base`） | 行颜色 |
| `keymap.layer(factory)` | 反应式命令层（`bind` / `slash` / `palette`） | `/collab` |
| `ui.slot(claim)` | `{ append \| prepend \| before \| after \| replace }` → 注销函数 | `session.panel` / `sidebar.content` |
| `ui.panel.{open,close,current}` | `open(name) → boolean`（没有打开的会话时 `false`） | 开面板 |
| `ui.toast.show({message,variant})` | — | `open` 返回 `false` 时提示 |

`PanelInput`：`{ name, sessionID, width, presentation, focused, focus, close, toggleFullscreen }`，
`name` 是「当前选中值」，每个贡献自己决定渲不渲染。

`client.rpc(Definition)` 的返回是 `RpcClient<D>`：`D.methods` 每个方法一个函数（`snapshot(input)`），
类型来自 `Rpc.Output<schema>`；本仓 `@opencode/schema` 不在依赖里（`import type` 被擦除），
落地时是 `any`，所以 `src/tui.tsx` 里自己收窄/归一化（`normalize()` + `arrayOf()`）。

## 2. 构建：为什么 `generate: 'universal'` + `moduleName: '@opentui/solid'`

- `@opentui/solid` 的 JSX 运行时**不是** `solid-js/web` 的 DOM 模板：它的 `jsx-runtime` 只是
  `createElement(tag) + spread` 的薄封装；真正的响应式 props getter 需要 `babel-preset-solid`。
- `babel-preset-solid` 的 `generate:'universal'` 让内在元素走
  `createElement(tag)` / `setProp` / `insert` / `insertNode` / `createTextNode`（无 `template`），
  `moduleName:'@opentui/solid'` 让这些从宿主的那一份导入 —— 和宿主编译自己 TUI 源码时用的参数相同
  （opencode 二进制里的 `bun-plugin-solid` 就是 `{ moduleName: "@opentui/solid", generate: "universal" }`）。
- `vite.tui.config.ts` 的 external：`@opencode/*`、`@opentui/*`、`solid-js(/*)`。
  产物只有 4 条 import，正好是宿主 runtime-module 表里登记的键：
  `@opentui/solid`、`solid-js`、`solid-js/store`、`@opencode/plugin/tui`
  （证据：opencode 2.3.1 二进制里 `vDt={"@opentui/solid":…,"solid-js":…,"solid-js/store":…}` +
  `KW({ additional: { "@opencode/plugin/tui": { Plugin, PluginContextProvider, usePlugin } } })`）。
  → 装到 `~/.cache/opencode/npm/…/node_modules/@inf-studio/collab/` 下（那里没有 node_modules）
  也能解析，因为这几个 specifier 由宿主自己提供。
- 产物：`dist/tui.js` 17 KB（`pnpm build` 依次 `vp pack` → gui → tui，`emptyOutDir:false`）。

## 3. 踩到的真坑：`<Show>` 在没有 fallback 时返回 `""`

`solid-js/universal` 的 `createComponent` 把 `undefined` 映射成 `""`：

```js
const c = untrack(() => Comp(props)); return c === undefined ? "" : c;
```

而 OpenTUI 的 reconciler 对「非 `<text>` 父节点里插入裸文本节点」是**硬抛错**：

```
Error: Orphan text error: "" must have a <text> as a parent: box-1 above text-node-2
```

所以「`<box>` 里放一个条件为假的 `<Show>`（无 fallback）」在 TUI 里是**运行时崩溃**，
包括文档示例里那种 `render: panel => <Show when={panel.name === …}>` 的写法
（名字不匹配时整个 slot 渲染就抛）。

处理：面板正文改成**扁平的行列表**（`Line[] = { text, tone }`），用 `<For each={lines()}>` 渲染
`<text>`；条件为假时数组为空 → 插入 `SlotRenderable`（合法），什么也不显示。
`StatusPanel` 自身永远返回一个 `<box>`（对别的插件的面板就是空 box）。
副作用是颜色可以按行给（租约按「我持有 / shared / 被别人独占」着色）。

> 这条是本任务用 `@opentui/solid` 的无头 `testRender` 才发现的；纯 typecheck/构建都发现不了。

## 4. 数据通道

- `collab.state.snapshot({ workspace?, session? })`：`workspace` 来自 `ctx.location.directory`，
  `session` 来自 `panel.sessionID` / `sidebar.content` 的 `sessionID`。
- 0.4.2 给快照加了 **`queue`**（`mineFor(session)` 的只读视图）——PRD R5 要求第三块，
  但 `src/rpc.ts`/design 里的 `Snapshot` 只有 sessions/locks/handoffs。**这是对 RPC 契约的只读扩展**：
  没有新增工具、没有改任何工具语义、没有新写路径；旧客户端忽略该字段，旧 server 不返回时客户端按空数组
  （`normalize()` 用 `arrayOf` 兜底，另有测试 `C2 a source without a queue reader …`）。
- 轮询：定时器建在 `createEffect(() => { if (panel.name !== PANEL) return; … setInterval; onCleanup(clearInterval) })`
  里 —— `panel.name`/`panel.sessionID` 变化时 Solid 先跑上一次的 cleanup，所以「切到别的插件的面板」= 立刻停；
  面板关掉 = slot 内容 dispose = 同样停。侧栏摘要只在挂载时拉一次（不另开第二个定时器）。
- `store.state` 用 `solid-js/store`；`me`（当前会话）是普通变量而不是 store 字段，
  避免 `load()` 里的读取被 effect 追踪成循环依赖。`me` 是「最后 watch 的会话」：
  侧栏摘要与面板同时挂载且**不是同一个会话**时，队列块会跟着最后一次 watch 走
  （实际使用中两者都是当前会话；多会话侧栏并排时以最后渲染者为准）。

## 5. 测试

| 文件 | 变化 |
| --- | --- |
| `test/handoff-harness.mjs` | 不改（608 项全绿；`PLUGIN_VERSION` 0.4.2 与 package.json 一致） |
| `test/readonly-default.mjs` | 不改（12 项） |
| `test/snapshot-shape.mjs` | 18 → **33 项**：queue（`{session}` 过滤 / 撤回与别人的不出现 / seen / 最旧优先 / 无 reader 兜底）、schema（`queue` 行字段、input 的 `session`）、TUI 产物（存在 / 只 import 宿主模块 / 声明 panel+slash+两个 slot / 无写路径）、`exports["./tui"]` + peers、GUI 首启判定 |
| `test/tui-render.mjs` | **新增 17 项**：`@opentui/solid` 的 `testRender` + 假宿主 context，真渲染面板/摘要 |

`node --conditions=browser` 是必须的：Node 默认条件下 `solid-js` 解析到 **SSR 构建**
（`createEffect` / `onMount` 是 no-op），面板永远停在「加载中」。真实 TUI 跑在 Bun 上用的是反应式构建。
`pnpm test` 已串上（`node --conditions=browser test/tui-render.mjs`）。

## 6. 未验证 / 已知限制

1. **未在真实 TUI 里点过**（本机无法交互式启动 TUI）：`./tui` 的加载靠宿主的 runtime-module 表，
   证据是二进制里的 specifier 表（§2），但没有端到端跑一次 `opencode` + 本包的 TUI 部件。
   风险点：宿主的 rewrite 只覆盖它表里的 specifier —— 我们的产物正好只用这四个。
2. **`@opentui/*` peer 下界 `>=0.6.6`** 取自官方 docs 的 peer 片段（design 也这么写），
   而 `@opencode/plugin@2.3.0` 自己声明 `>=0.8.4`、本地 devDependency 装的是 `0.9.2`。
   实际用到的 API（`<text>/<box>`、`fg`、`createElement/insert/setProp`）都很老，
   但**没有在 0.6.x 上实测**；如遇老宿主报错，优先把 peer 下界抬到 `>=0.8.4`。
3. **GUI 首启修复只做了静态断言**（没有 Desktop 窗口可跑）：`test/snapshot-shape.mjs` 校验
   源码里 `opened === 'open'`、`list` 的 `autoOpen` 规则、产物里带 `autoOpen`。
   真正的「首次进入会话侧栏出现 collab 标签」需要在 Desktop 里手工确认（验收项 1）。
4. **TUI 面板宽度**：用 `panel.width` 估算列宽，`<48` 列时每项拆两行；CJK 只在标题/空态里出现，
   表格单元格保持 ASCII，避免东亚宽字符把列挤歪。
5. `collab.state.snapshot` 的 `queue` 走 `mineFor(session)`：每次轮询会 `readdir` 一次队列根目录 +
   每个有项的 target 一次。与既有「每次轮询读全部租约/交接文件」同量级，未做缓存。
6. TUI 没有 i18n API（GUI 的 `ctx.t` 是 GUI 专有），所以面板文案直接写中文，与 README/文档一致。
