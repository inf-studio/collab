# 执行计划：Desktop 入口 + TUI 侧栏折叠（0.5.1）

## 1. Desktop（`src/gui.tsx`）

- [ ] 引入 `Command`、`Slot` 类型；新增 i18n：`command.open`、`command.description`、`command.group`、
      `header.counts`（`锁 {{locks}} · 交接 {{handoffs}} · 队列 {{queue}}`）、`header.title`（en 同名键）
- [ ] 注册 `Command { id:'open', bind:'mod+shift+l', slash:{name:'collab'}, section:'navigation', enabled, run→layout.open }`
- [ ] `HeaderCounts` 组件：读 `sharedStore`，`Show` 包裹，点击开面板，CSS 进现有 `Style`
- [ ] 注册 `Slot at 'session.header'`；确认 Panel/MenuItem/ComposerPill 未改

## 2. TUI（`src/tui.tsx`）

- [ ] `SidebarSummary`：`expanded` signal + `toggle` + `rows()` 派生（锁→交接→队列，≤4 条 + `+N`）
- [ ] 摘要行 `onMouseDown=toggle`，前缀 `▸/▾`；明细行 `onMouseDown=openPanel`
- [ ] `openPanel()` 复用现有 `PANEL` 常量与 toast 文案；无数据时一行提示 + 点击开面板
- [ ] 确认不新增轮询（展开不调用 `load()`，除既有 watch 外）

## 3. 测试

- [ ] `test/gui-entry.mjs`：假 ctx 跑 bundle → 5 个注册齐、Command 行为、Slot 位置（或按 design §4 抽
      `gui/entries.ts` 后直测）
- [ ] `test/tui-render.mjs`：折叠/展开/点行跳面板/折叠回落 4 条断言（真触发 `onMouseDown`，不只看 props）
- [ ] `pnpm test` = 既有 `638 + 12 + 35 + 17` 全绿，TUI 17 → 21 左右

## 4. 文档与版本

- [ ] README「状态视图」：Desktop 入口（命令 / `mod+shift+l` / 会话头计数条）、TUI 点击展开
- [ ] `docs/collab.md` §11.11 增「入口」小节（含宿主裁剪风险与降级）
- [ ] `skills/collab/SKILL.md` 一句；CHANGELOG 0.5.1
- [ ] `package.json` / `PLUGIN_VERSION` → `0.5.1`（`src/constants.ts`）

## 5. 验证

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

## 6. 回滚

`git restore -- src/gui.tsx src/tui.tsx test/ docs/collab.md README.md CHANGELOG.md`；
运行时无开关需要（新入口只读，`autoOpen:false` 不受影响）。
