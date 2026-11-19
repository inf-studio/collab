# 执行计划：三级关系图

- [ ] `src/core/graph.ts`：buildGraph + 稳定排序 + 上限
- [ ] `src/index.ts` `__internals` 暴露 buildGraph（单测）
- [ ] GUI：GraphSlot 渲染 SVG，点选/折叠/悬停（仅本窗口）
- [ ] TUI：文本树 + 级别跟随选中
- [ ] `test/graph-shape.mjs`（新）+ `gui-panel.mjs` / `tui-render.mjs` 扩
- [ ] 变异 2 组（边方向、排序）
- [ ] 文档：`docs/collab.md` §11.11（图的三级与交互）、README、skill、CHANGELOG
- [ ] 回归全绿；工具数仍 22

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```
