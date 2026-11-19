# 执行计划：看板快捷动作

- [ ] 把工具里的编排抽到 core（`escalateAction` / `freezeAction` / `archiveAction`），工具改为调用
- [ ] `src/rpc.ts` + `src/index.ts`：4 个 RPC handler（白名单 + 门禁 + audit）
- [ ] audit：`~/.config/opencode/collab-audit.jsonl` 追加（成功/失败）
- [ ] GUI ActionRow：四个按钮 + 确认 + toast + 成功后刷新快照
- [ ] 配置 `boardActions`（默认 true）
- [ ] 测试：四动作 / 门禁 / 取消 / audit / 抛错 + 变异 2 组
- [ ] 文档：`docs/collab.md` §11.20、README、skill、CHANGELOG
- [ ] 回归全绿；工具数仍 22；版本不改（0.8.0 由父）

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```
