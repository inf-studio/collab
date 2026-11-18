# 设计：Desktop 入口 + TUI 侧栏折叠（0.5.1）

## 1. 边界

GUI SDK 能挂 UI 的地方只有：`Panel(region:"side")`、`MenuItem("session.panel")`、`Slot`（`window.bottom` /
`session.header` / `session.location.menu` / `session.panel.end`）、`ComposerPill`、`TitlebarItem`、`Command`。
**没有左侧应用侧栏槽位**——不做伪实现。

## 2. Desktop（`src/gui.tsx`）

### 2.1 Command（R1）

```ts
ctx.add(Command, (): Command => ({
  id: 'open',
  title: ctx.t('command.open'),            // "打开 collab 状态" / "Open collab panel"
  description: ctx.t('command.description'),
  keywords: 'collab lease lock handoff queue 协作 租约 交接 队列',
  group: ctx.t('command.group'),
  section: 'navigation',
  bind: 'mod+shift+l',
  slash: { name: 'collab' },
  enabled: !!ctx.sessions.current(),
  run: () => {
    const session = ctx.sessions.current();
    if (session) ctx.layout.open(`${ctx.id}:${PANEL_TAB}`, session);
  }
}));
```

- 宿主发布的 id 是 `<plugin id>.open`（即 `collab.open`），命令面板与 **Settings → Shortcuts** 都可见；
- `bind` 只是默认值，用户可改；不覆盖宿主的同类绑定（`mod+shift+l` 未被占用，落地前再核一次）；
- 只 `ctx.layout.open`，不碰任何写 API（R5）。

### 2.2 会话头计数条（R2）

```tsx
ctx.add(Slot, { at: 'session.header', order: 20, render: input => <HeaderCounts session={input.session} /> });
```

- 读 `sharedStore`（与 Panel/ComposerPill 同一个），不新建轮询；
- `Show when={data}`：无快照 → 渲染 `null`（不占位、不显示 0）；`store.state.error` → `collab: n/a`；
- 文本：`锁 N · 交接 M · 队列 K`（i18n：`header.counts` 带三个参数），`title` 给无障碍名；
- 点击 → `ctx.layout.open(`${ctx.id}:${PANEL_TAB}`, input.session)`；
- 样式进现有 `Style` 贡献的 CSS：`.collab-counts`（muted、12px、`cursor:pointer`、无边框按钮重置），
  不引入新的布局容器，避免撑高标题行。

### 2.3 不动的东西

`Panel`（`list`/`autoOpen`）、`MenuItem.opened === 'open'`、`ComposerPill` 的条件与 0.4.2 完全一致。

## 3. TUI（`src/tui.tsx`）

```
▶ 锁 2 · 交接 1 · 队列 0          ← 折叠（默认）
▼ 锁 2 · 交接 1 · 队列 0          ← 点击展开
   🔒 named:test-window  我 · 剩 4m
   🔒 db:primary         ses_e12…
   → b_aaaa…  open  8m  ses_e4c…
   +2                                ← 超出 4 行时
```

- `SidebarSummary` 内加 `createSignal(false)` 的 `expanded`；
- 摘要行是 `<box onMouseDown={toggle}>`，内部 `<text>`，前缀 `▸`/`▾`；折叠态高度仍为 1 行；
- 展开明细：`<For each={rows()}>`，每行 `<box onMouseDown={() => openPanel()}>`；
  `rows()` 由 `store.state.data` 派生（锁 → 交接 → 队列顺序），最多 4 条 + 一条 `+N`；
- `openPanel()` = `ctx.ui.panel.open('collab.status')`，返回 `false` 时 `toast.show` 提示先开会话（沿用现有文案）；
- 无数据时展开显示一行 `无协作活动 · 点击打开面板`，点击开面板；
- **不新增轮询**：仍用 `store.watch(sessionID)` + 现有 load；展开只是多渲染几行。

### 3.1 宿主裁剪风险

若宿主把 `sidebar.content` 固定为一行高度，展开内容会被裁掉（不崩溃）。降级顺序：
`▾` 行仍可点 → 明细不可见时用户仍能按 `ctrl+shift+l` / `/collab`。文档写明。

## 4. 测试

| 文件 | 新增断言 |
| --- | --- |
| `test/gui-entry.mjs`（新） | 以假 ctx（`add`/`t`/`layout`/`sessions`/`options`）require `dist/gui-experimental.cjs`：注册了 `Panel`/`MenuItem`/`ComposerPill`/`Command`/`Slot(session.header)`；Command 的 id/bind/slash/enabled/run 行为（run 调 `layout.open('collab:main', session)`）；Slot 的 `at` 与会话头渲染函数存在 |
| `test/tui-render.mjs` | 折叠态 1 行含 `▸`；展开态含 `▾` 与明细（锁/交接名）；明细点击调 `panel.open`；再点折叠；展开不额外 load（计数不涨） |
| `test/handoff-harness.mjs` / `snapshot-shape.mjs` / `readonly-default.mjs` | 不变，须全绿 |

- TUI 展开/点击：优先从 renderer 树取 renderable 调它的 `onMouseDown`；取不到时给组件加内部 `initialExpanded`
  （仅测试用，不进公开 API）——**不得只断言「props 里有个函数」**。
- GUI 测试若 CJS bundle 在 Node 下无法 require（DOM 依赖），降级为：把 `setup(ctx)` 的注册逻辑抽成
  `gui/entries.ts` 纯函数，测试直接调它；bundle 仍走 vite 构建。

## 5. 发布与回滚

- `0.5.1`（patch：只加只读入口，不改契约/工具/RPC 形状）。
- 回滚：`autoOpen:false` 只影响面板自启；新增入口是增量的，`git restore -- src/gui.tsx src/tui.tsx` 即回退。

## 6. 文档

README 状态视图一节、`docs/collab.md` §11.11、`skills/collab/SKILL.md` 一句、CHANGELOG。
