# 执行计划：GUI 修复 + TUI 视图

## 1. GUI

- [x] `opened` → `=== 'open'`
- [x] `list` 恒返回 tab（`autoOpen` 默认 true；false 时回退到 `input.open` 判定）
- [x] 确认 `PanelView` 在默认展示 + RPC 不可达时显示占位、不崩

## 2. TUI

- [x] `src/tui.tsx`：`Plugin.define({ id:'collab.tui', setup })`
- [x] 数据 store：`ctx.client.rpc(CollabState)`（失败 → `session.list()` + 不可达标记），2s 轮询
- [x] `session.panel` 贡献 `collab.status`：leases / handoffs / queue 三块 + 空态
- [x] `sidebar.content` 一行摘要：`锁 N · 交接 M · 队列 K`（不可达 → `collab: n/a`）
- [x] `/collab` 命令（`slash` + 快捷键 `ctrl+shift+l` + palette）→ `ui.panel.open('collab.status')`
- [x] dispose 时清定时器、注销 slot

## 3. 构建与包

- [x] `exports["./tui"] = "./dist/tui.js"`；`peerDependencies`：`@opentui/core`、`@opentui/solid`、`solid-js`
- [x] TUI 构建脚本（tsdown/esbuild，external `@opencode/*`/`solid-js`/`@opentui/*`）
- [x] `pnpm build` 产出 `dist/index.js`、`dist/gui-experimental.cjs`、`dist/tui.js`
- [x] `npm pack --dry-run` 含三产物

## 4. 回归

- [x] 既有 **608 + 12** 全绿（server 行为不变）；`snapshot-shape` 18 → 33 项，新增 `tui-render` 17 项
- [x] `node scripts/check-skill.mjs`
- [x] GUI/TUI 构建失败不影响 server 产物（构造验证：三产物独立、`emptyOutDir:false`）

## 5. 文档与发布

- [x] README：GUI 仅图形客户端；TUI 用 `/collab`；远端 `/api/plugin/gui`
- [x] `docs/collab.md` 增「状态视图（GUI/TUI）」小节 + 排查步骤
- [x] `0.4.2`（`package.json` + `PLUGIN_VERSION`）

## 备注（实施时确认）

- R5 的第三块「受保护目标队列」在 `Snapshot` 里原本没有数据：本次给 `collab.state.snapshot`
  加了**只读**的 `queue`（`{ session }` 限定，来源 `mineFor`），不改任何工具语义。
- TUI 的 `<Show>` 在无 fallback 时会产出 `""` → OpenTUI 抛 orphan text，因此面板正文用
  「行列表 + `<For>`」实现（详见 `research/impl-notes.md` §3）。

## 验证

```
pnpm install
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
ls -l dist/tui.js dist/gui-experimental.cjs
npm pack --dry-run 2>&1 | tail -5
```

## 回滚

移除 `./tui` 出口与 GUI 改动；server 零变化。
