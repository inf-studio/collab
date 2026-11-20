# 执行计划：事实账本 + settle/invalidate（0.9.4）

## 顺序清单

- [ ] 1. `src/core/facts.ts`：类型、读写、epoch、retract/supersede、2000 上限
- [ ] 2. `src/core/tri-state.ts`：本地状态快照 + `compare()`
- [ ] 3. `src/core/glossary.ts`：术语表 + 冲突检测
- [ ] 4. `src/tools/fact.ts`：`settle` / `retract` / `invalidate` / `list`；注册（26 → 27）
- [ ] 5. `src/core/messages.ts`：发送时补 `grade` / `factIds` / `basedOn`
- [ ] 6. `src/hooks/context.ts`：`[settled]` / `[retracted]` / `[未标注]` / `[stale]` / `[glossary]`
- [ ] 7. 在途失效：扫描 todos 标 `staleWork`
- [ ] 8. `metrics.retract_count` 接入
- [ ] 9. 测试 `test/facts.mjs`：design §9 十例 + 变异
- [ ] 10. 文档：`docs/collab.md`「事实账本 / 证据等级 / 三态」；skill；CHANGELOG
- [ ] 11. 门禁 + 复核

## 门禁

```bash
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

报数：工具数 27、撤回可度量（retract_count）、stale 回复长度比。

## 复核门

- 独立子代理跑全量门禁并贴原始输出；
- 变异（强制）：`compare` 恒 fresh → stale/conflict 必红；
- 主会话抽检：settle 一条 → invalidate 它 → 看注入是否出现 `[retracted]`。

## 回滚

见 `design.md` §10。
