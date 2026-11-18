# 设计：GUI 首启修复 + TUI 视图

## 1. GUI 修复（`src/gui.tsx`）

```ts
const autoOpen = ctx.options?.autoOpen !== false;
ctx.add(Panel, {
  ...,
  list: () => (autoOpen ? [tab] : input.open.includes(PANEL_TAB) ? [tab] : []),
  ...
});
ctx.add(MenuItem, () => ({
  ...,
  opened: !!session && ctx.layout.state(`${ctx.id}:${PANEL_TAB}`, session) === 'open'
}));
```

- `tab.fallback: true` 保留：没有其它选择时默认选中；
- `autoOpen:false` 时行为回到「仅 + 菜单打开」；
- 不可达占位已在 `PanelView`（`fallback` 文案），确认默认展示时不崩。

## 2. TUI 部件（`src/tui.tsx`）

```ts
import { Plugin } from '@opencode/plugin/tui';

export default Plugin.define({
  id: 'collab.tui',
  setup(ctx) {
    // 1) 数据：每 2s 拉一次快照（仅面板打开时）
    // 2) session.panel 贡献：collab.status
    // 3) sidebar.content 一行摘要
    // 4) /collab 命令 + 快捷键
  }
});
```

### 2.1 数据通道

- 首选 RPC：`ctx.client.rpc(CollabState)`（契约来自 `src/rpc.ts`，TUI 可 `import` 类型/定义）；
  失败时 `ctx.client.call?` 不可用 → 退化：
  - 用 `ctx.data.session.list()` 显示会话（agent/busy/title），
  - 面板顶部一行「RPC 不可达：仅显示会话」。
- 快照结构复用 `Snapshot`（`sessions / locks / handoffs / reachable`）。
- 轮询：`setInterval(2000)`；面板关闭（`panel.name !== 'collab.status'` 或 dispose）时 `clearInterval`。

### 2.2 面板

- `ctx.ui.slot({ append: 'session.panel', render: panel => <Show when={panel.name==='collab.status'}>…</Show> })`
- 三块（窄终端用表格式两列）：
  - `leases`: `resource  mode  holders  ttl  waiters`
  - `handoffs`: `bid  state  age  from`
  - `queue`: `queueId  target  age`
- 空态：`（无租约 / 无交接 / 无排队）`。

### 2.3 侧栏摘要

- `ctx.ui.slot({ append: 'sidebar.content', render: () => <text>{`锁 ${locks.length} · 交接 ${handoffs.length} · 队列 ${queue.length}`}</text> })`
- 摘要数据来自同一个 2s store；RPC 不可用时显示 `collab: n/a`。

### 2.4 命令

```ts
ctx.keymap.layer(() => ({
  mode: 'global',
  commands: [{
    id: 'collab.status', title: 'Collab 状态面板', group: 'Collab',
    bind: 'ctrl+shift+l',
    slash: { name: 'collab' },
    palette: true,
    run: () => void ctx.ui.panel.open('collab.status')
  }]
}));
```

## 3. 包与构建

```jsonc
"exports": { ".": …, "./gui-experimental": "./dist/gui-experimental.cjs", "./tui": "./dist/tui.js" },
"peerDependencies": { "@opentui/core": ">=0.6.6", "@opentui/solid": ">=0.6.6", "solid-js": ">=1.9.0" }
```

- 构建 `src/tui.tsx` → `dist/tui.js`：与 GUI 同一套 Solid JSX 编译（`tsdown`/esbuild，external `@opencode/*`、`solid-js`、`@opentui/*`）；
- `pnpm build` 串上：`vp pack && vite build -c vite.gui.config.ts && <tui build>`；
- `files` 已含 dist。

## 4. 兼容与回滚

| 场景 | 行为 |
| --- | --- |
| 无 TUI 支持的老客户端 | 不加载 `./tui`，server/GUI 不受影响 |
| TUI RPC 不可用 | 面板/摘要显示 n/a，不崩 |
| `autoOpen:false` | GUI 不自动出现，+ 菜单可开 |
| 回滚 | 移除 `./tui` 出口与 GUI 改动；server 零变化 |

## 5. 风险

- TUI API 与 OpenTUI 版本强相关（peer 范围钉在 `>=0.6.6`）；
- 面板轮询在远端连接下有 2s 延迟（可接受）；
- 一侧 slot 渲染异常不应影响 TUI 主界面（宿主隔离）。
