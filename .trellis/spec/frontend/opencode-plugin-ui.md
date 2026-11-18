# OpenCode 插件 UI（GUI / TUI）约定

适用于 `src/gui.tsx`、`src/tui.tsx` 及其测试。这里的规则来自 0.4.2 / 0.5.1 两次实际踩坑，不是理想设计。

## 1. 能挂在哪里（Desktop GUI）

GUI 插件只有这些槽位，**没有左侧应用侧栏**：

| 注册项 | 位置 |
| --- | --- |
| `Panel`（`region:"side"`） | 会话右侧面板的 tab |
| `MenuItem("session.panel")` | 右侧面板 `+` 菜单的启动项 |
| `Slot` | `window.bottom` / `session.header` / `session.location.menu` / `session.panel.end` |
| `ComposerPill` | 输入框上方那行（会话级） |
| `TitlebarItem` | 窗口标题栏 |
| `Command` | 命令面板 / Settings → Shortcuts / 斜杠菜单 |

**规矩**：每个面板都必须有 ≥2 条独立入口（`Command` + 一个常驻可见的 Slot 或 MenuItem）。
只注册 `Panel` 等于「有实现、没人能打开」——`list` 返回 tab 不代表右侧区域展开。

- `Command` 用**函数形式**注册（`(): Command => ({...})`），`enabled`/`title` 才会跟随路由会话与语言。
- 默认键只写默认值（本项目 GUI 用 `mod+shift+l`，TUI 用 `ctrl+shift+l`，**不要**写成同一个键）；
  命令面板与斜杠入口不依赖键位，必须始终可用。
- 常驻可见的指示器（如 `session.header` 的计数条）：无数据时**渲染 `null`**，不要显示 `0`；
  不可达时给 `n/a` 而不是留空，且保持可点击。

## 2. 一个窗口一个 store、一个轮询

- `src/gui.tsx` 的 `sharedStore` 由 Panel / ComposerPill / HeaderCounts 共用：**一次 RPC 一拍**。
  新增 UI 时读同一个 store，禁止再开 `setInterval` 或第二条 RPC 流。
- 轮询 key **必须包含路由会话 id**（0.5.1 修正）：

  ```ts
  // 轮询按会话 keyed（切会话立即重载），可见性用显式 start/stop，不要放进 key。
  const startPolling = () => {
    // 三个门：已有定时器 / 窗口隐藏 / 没有会话——少一个都会多出请求。
    if (timer || pageHidden() || ctx.sessions.list().length === 0) return;
    void store.load();
    timer = setInterval(() => void store.load(), POLL_MS);
  };
  const stopPolling = () => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };
  createKeyed(() => ctx.sessions.current()?.id ?? '', () => {
    stopPolling();
    startPolling();
    onCleanup(stopPolling);
  });
  // 必须成对反注册：宿主 dispose 插件时靠 onCleanup 停表、摘监听。
  document.addEventListener('visibilitychange', onChange);
  onCleanup(() => {
    document.removeEventListener('visibilitychange', onChange);
    stopPolling();
  });
  ```

  `onCleanup` 里的反注册不是可选项：没有它，插件被停用后监听仍挂在 `document` 上，旧 store 会被
  可见性事件唤醒（本项目 0.5.2 的测试就是靠 `createRoot` + `dispose` 专门盯这条）。

  只写「有会话 = true」时，切会话后 `queue`（按 requester 计算）会拿上一会话的结果最多 2 s——
  这是**错数**，不是慢数。`collab.state.snapshot` 调用的 `session` 参数同样必须传当前会话。
- **`document.hidden` 不是响应式的**：写进 key 只会「启动时判一次」——隐藏后定时器照跑，隐藏时挂载的窗口
  永不启动（0.5.1 的真实 bug，0.5.2 修）。必须监听 `visibilitychange` 显式 start/stop。
- 页面隐藏时停轮询；面板打开与否不影响这一次轮询（侧栏/计数条也要数）。

## 3. 只读是硬约束

状态面板/计数条/侧栏**不得**出现写动作（释放锁、归档、改权限）。点击只允许
`layout.open` / `panel.open` / toast。

## 4. TUI 侧栏

- `sidebar.content` 是宿主插槽，宿主可能把内容固定为一行高：**默认一行**，点击展开是增强而非前提。
  展开被裁剪时不抛错，且 `/collab`、`ctrl+shift+l` 必须仍可用。
- 点击用 renderable 的 `onMouseDown`（`@opentui/core/Renderable.d.ts`）；展开/折叠状态用局部
  `createSignal`，不要写 `storage`。
- 展开**不得**额外 `load()`：明细从已有快照派生，轮询仍由面板/侧栏既有的一次 load 负责。
- 子元素用 `wrapMode="none"` 保证「一行一条」，否则长 id 会换行错位。

## 5. 测试（`test/tui-render.mjs`、`test/gui-entry.mjs`）

- **TUI**：用 `@opentui/solid` 的 `testRender` + `captureCharFrame` 断言真实字符帧；
  交互要**真触发** `onMouseDown`，不能只断言「props 里有个函数」。
- **GUI**：直接 require `dist/gui-experimental.cjs`（构建产物，不是源码），用严格 Proxy 假 ctx：
  读未声明字段即抛错，可顺便证明「没有写 API」；需要 `--conditions=browser` 与
  `document.addEventListener` 垫片（Solid 委托事件在模块加载时注册）。
- 每条新断言做完后做一次**变异验证**（改坏实现，确认断言真的失败），否则视为无效覆盖。
- 版本号两处（`package.json` / `src/constants.ts` 的 `PLUGIN_VERSION`）必须一致。
