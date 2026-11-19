# 执行计划：看板主从布局

- [x] `src/gui.tsx`：BoardLayout/Sidebar/Detail 拆分；CSS grid + 窄屏单栏
- [x] 选中 signal + 快照消失清空 + toast
- [x] `GraphSlot` / `ActionRow` 占位（不塌陷）
- [x] `src/tui.tsx`：选中行详情 3–5 行 + `esc` 清除
- [x] 测试：`gui-panel.mjs` 五例 + `tui-render.mjs` 三例 + 变异 2 组
- [x] 文档：`docs/collab.md` §11.11 布局、README、skill、CHANGELOG
- [x] 回归全绿；工具数仍 22；版本不改（0.8.0 由父任务统一）

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```
