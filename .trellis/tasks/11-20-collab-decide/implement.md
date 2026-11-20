# 执行计划：决策载具 + 角色四元组（0.9.5）

## 顺序清单

- [ ] 1. `src/core/decisions.ts`：类型、读写、`normalize`+`sha1` 去重、上限 3、owner 校验
- [ ] 2. `src/tools/decide.ts`：`open` / `answer` / `supersede` / `list`；注册（27 → 28）
- [ ] 3. `src/core/contract.ts`：`peers[].role` 写入与默认推导
- [ ] 4. `src/hooks/context.ts`：`[role:…]` 与 `[decide]` 段
- [ ] 5. `src/core/tri-state.ts`：`conflict` → 自动 `open`
- [ ] 6. 角色提示规则（implementer / requester 两条）
- [ ] 7. 测试 `test/decide.mjs`：design §8 十例 + 变异
- [ ] 8. 文档：`docs/collab.md`「决策与角色」；skill；CHANGELOG
- [ ] 9. 门禁 + 复核

## 门禁

```bash
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

报数：工具数 28、open 上限拦截次数、去重命中次数。

## 复核门

- 独立子代理跑全量门禁并贴原始输出；
- 变异（强制）：去重 hash 去掉 `normalize` → 「同问二次 open」必红；
- 主会话抽检：同 thread 连开 4 条，第 4 条必须被拒。

## 回滚

见 `design.md` §9。
