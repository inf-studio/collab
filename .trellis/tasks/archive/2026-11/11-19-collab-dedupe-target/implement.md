# 执行计划：target 维度去重

- [ ] `src/tools/shared.ts`：target 级索引（Map）+ 查询/写入；回执文案
- [ ] `src/tools/{send,reply}.ts`：`force?: boolean`；命中/强制路径
- [ ] 有 bid 时写 `dedupeOverriddenAt`（只读标记，不改 state）
- [ ] 测试：design §5 七例 + 变异 2 组
- [ ] 文档：`docs/collab.md` 去重小节（target 维度 + force）、skill、CHANGELOG
- [ ] 回归 `788 + 12 + 20 + 50 + 49 + 47 + 17` 全绿；工具数仍 20；版本不改

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```
