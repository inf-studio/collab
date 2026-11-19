# 执行计划：origin

- [ ] `src/types.ts`：`origin?` 字段
- [ ] `src/core/claim.ts`：`normalizeBroadcast` 容忍 origin；写入路径合并
- [ ] `src/tools/handoff.ts` / `broadcast.ts` / `send.ts`：入参 `origin`（sid/别名）+ 一层继承规则
- [ ] `src/core/verdict.ts` / `chain.ts`：注入块加「对接人」行（仅当 origin≠from）
- [ ] `src/tools/status.ts` / `list.ts`：展示 origin（status `origin=`；list 行尾 `via ses_…`）
- [ ] 测试：A→B→C（显式/继承/覆盖）、旧记录兼容、别名失败、status
- [ ] 变异 2 组（继承改成恒取 me；渲染不判 origin≠from）
- [ ] 文档：`docs/collab.md` §11.9（交接）+ 三行模板；skill；CHANGELOG
- [ ] 回归 `756 + 12 + 20 + 50 + 49 + 47 + 17` 全绿；工具数仍 20；版本不改

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```
