# 执行计划：会话契约骨架 + 五段式注入（0.9.1）

## 顺序清单

- [ ] 1. `src/core/contract.ts`：类型、读写（tmp+rename）、合并、惰性创建
- [ ] 2. `src/core/mission-resolve.ts`：会话指针 → 唯一 in_progress 任务 → 空
- [ ] 3. `src/core/evidence.ts`：4 种 evidence 校验 + 可读拒绝原因
- [ ] 4. `src/tools/mission.ts` / `progress.ts` / `todo.ts`：动作与参数校验
- [ ] 5. `src/hooks/context.ts`：五段注入（顺序 / 12 行截断 / 每轮重算 / 不注销）
- [ ] 6. `src/tools/index.ts`：注册 3 个工具（23 → 26）
- [ ] 7. `src/core/evidence.ts` 接入 `plan.lastAdvancedAt` 与 `turn.noAdvanceTurns`
- [ ] 8. 未收尾回溯标记（design §7）
- [ ] 9. 测试 `test/contract-inject.mjs`：design §8 八例 + 变异
- [ ] 10. 文档：`docs/collab.md` 新增「会话契约 / 五段注入」；README；skill；CHANGELOG
- [ ] 11. 门禁 + 复核

## 门禁

```bash
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

报数：工具数 26、测试计数、注入最大行数（构造全段场景实测）。

## 复核门

- 独立子代理跑全量门禁并贴原始输出；
- 变异（强制）：注入改回一次性 `injected[]` → 「第二轮仍有 [mission]」必红；
- 主会话抽检：手构造 10 条 todo 的契约，亲跑注入并数行数。

## 回滚

见 `design.md` §9。
