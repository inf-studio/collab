# 执行计划：decisions

- [ ] `src/types.ts`：`BroadcastDecision` + `BroadcastRecord.decisions?`
- [ ] `src/tools/decisions.ts`：入参/校验/权限（from|claim.by）/按 id 覆盖/上限 20/预览不写
- [ ] `src/tools/index.ts` 注册（21 → 22）；`test/readonly-default.mjs` 同步
- [ ] `src/core/verdict.ts`：`takeoverBody` 加一行计数
- [ ] `src/tools/status.ts`：最近 3 条 + 计数；`list.ts` 行尾 `decisions=N`
- [ ] 测试：design §5 八例 + 变异 2 组
- [ ] 文档：`docs/collab.md` 工具表 + 一节；README；skill；CHANGELOG
- [ ] 回归 `846 + 12 + 20 + 50 + 49 + 47 + 17` 全绿；版本不改

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```
