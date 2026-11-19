# 执行计划：threads 聚合 + status 降级

- [x] `src/core/thread-index.ts`：读写索引（上限 500、7 天、坏文件容错）
- [x] 投递成功处（`shared.ts` dispatch / handoff）写索引
- [x] `src/tools/threads.ts` 新工具（只读，≤20 条，未闭环默认）
- [x] `src/tools/status.ts`：无广播记录时降级到索引 + thread store
- [x] `src/tools/index.ts` 注册（20 → 21）；`test/readonly-default.mjs` 同步
- [x] 测试：design §6 七例 + 变异 2 组
- [x] 文档：`docs/collab.md` 工具表 + 新节；README；skill；CHANGELOG
- [x] 回归 `823 + 12 + 20 + 50 + 49 + 47 + 17` 全绿；版本不改

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```
