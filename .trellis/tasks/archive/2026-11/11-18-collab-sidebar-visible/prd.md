# 侧栏可见性：GUI 首启修复 + TUI 视图（0.4.2）

> 现象：Desktop（远程连 Linux server）看不到 `collab` 侧栏；TUI 没有任何状态视图。
> 实测：远端 `GET /api/plugin/gui?id=collab` 能返回 `dist/gui-experimental.cjs`（server 侧能力齐备）。

## 根因（GUI）

```ts
// src/gui.tsx
opened: !!session && ctx.layout.state(`${ctx.id}:${PANEL_TAB}`, session) !== 'closed'
list: input => (input.open.includes(PANEL_TAB) ? [tab] : [])
```

首次 `layout.state` 为 `undefined`，`undefined !== 'closed'` 为 **true** → 「+」菜单启动器认为已打开、不列入；
`list` 又只在打开时返回标签 → **无入口、无标签**，面板永远打不开。

## Requirements

### GUI（R1–R3）

- **R1 入口判定**：`opened` 改为 `=== 'open'`（`undefined`/`closed` 视为未打开）。
- **R2 默认可见**：`list` 恒返回该 tab（`fallback:true`）；`options.autoOpen`（默认 `true`）可关。
- **R3 不可达占位**：RPC 不可用/远程未加载时显示「不可达」，不崩溃。

### TUI（R4–R7）

- **R4 入口**：新增 `./tui` 部件；注册 `/collab` 命令（含快捷键）打开 `session.panel`（名 `collab.status`）。
- **R5 内容**：面板展示
  - 资源租约：resource / mode / holders / 剩余 TTL / waiters；
  - 交接：bid / state / age / from；
  - 我方提交给受保护会话的请求：queueId / target / age。
  另在 `sidebar.content` 追加**一行摘要**：`锁 N · 交接 M · 队列 K`。
- **R6 数据源**：优先 server 插件 RPC `collab.state.snapshot`（TUI `context.client` 可连远端）；
  RPC 不可用时退化为「仅会话列表 + 明确不可达提示」，不白屏。
- **R7 只读与刷新**：面板打开时 2s 刷新、关闭即停；不提供写操作。

### 文档（R8）

- README/docs：GUI 仅图形客户端；**TUI 用 `/collab`（或 `collab_list`）**；远端 GUI 由
  `GET /api/plugin/gui?id=<plugin>` 提供；排查步骤（插件列表 → 开关 → 「+」菜单 / TUI `/collab`）。

## Acceptance Criteria

- [ ] GUI：首次进入会话侧栏出现 `collab` 标签；关闭后可从「+」重开；`autoOpen:false` 时不自动出现
- [ ] GUI：RPC 不可达时显示占位、不崩溃
- [ ] TUI：`/collab` 打开 `collab.status` 面板，数据与 `collab_locks`/`collab_list` 一致
- [ ] TUI：`sidebar.content` 出现一行摘要；面板关闭时摘要仍可见
- [ ] TUI：RPC 不可用时显示「不可达/仅会话」，不白屏
- [ ] 构建：`pnpm build` 产出 `dist/gui-experimental.cjs` 与 `dist/tui.js`；`npm pack` 含两者
- [ ] 既有回归（608 + 12 + 18）全绿；`0.4.2` 发布

## 边界

- 不改 server 工具语义；TUI 依赖 `@opentui/core`、`@opentui/solid`、`solid-js` 走 peerDependencies。
- TUI 面板只读；写操作仍走工具。
