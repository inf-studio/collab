# 执行计划：行内交互

- [ ] `src/gui.tsx` `SessionRow`：标题 `<button class="collab-link">`（`tabs.open` + `stopPropagation`）；id `<button>`（`system.copy` + toast + `stopPropagation`）
- [ ] `DetailHeader`：sid 可点复制
- [ ] `src/tui.tsx`：`o` → `ui.tabs.focus(sid)`；详情显示完整 sid；失败提示
- [ ] 测试：三组交互（标题/ id / 整行）+ TUI `o`
- [ ] 文档：`docs/collab.md` §11.11、README、CHANGELOG
- [ ] 回归全绿；版本 0.8.1（父无）

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```
