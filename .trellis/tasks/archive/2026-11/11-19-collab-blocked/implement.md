# 执行计划：BLOCKED 结构化

- [x] `src/types.ts`：`BroadcastBlocked` + `BroadcastRecord.blocked?`
- [x] `src/tools/{send,handoff}.ts`：入参 `blocked`（校验/剥离/上限）+ 正文渲染
- [x] 有 bid 时写入记录（保留最近 3 次）；无 bid 不落库并在回执注明
- [x] `src/tools/status.ts`：聚合展示三段 + 历史计数
- [x] 测试：design §5 六例 + 变异 6 组（S105，23 条；原始输出见 `research/impl-notes.md` §7 / §10）
- [x] 文档：`docs/collab.md` 工具表 + 一节；skill；CHANGELOG
- [x] 回归 `846（823+23） + 12 + 20 + 50 + 49 + 47 + 17` 全绿；工具数仍 21；版本不改
- [x] 复核修复（`research/check-report.md` F1/F2 必修 + F3 建议）：`canWriteBlocked` 抽到 `verdict.ts`，handoff 幂等分支补 `confirm` 门与参与方判定，send 去重命中不重复追加（`research/impl-notes.md` §10）

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```
