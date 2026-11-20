# 执行计划：漂移检测 + 挂起唤醒 + 主线占位（0.9.3）

## 顺序清单

- [ ] 1. `src/core/drift.ts`：`evaluate()`（5 轮 / 2h / 24h 三条件）
- [ ] 2. `src/core/wake.ts`：`wakeWhen` 解析、到期扫描
- [ ] 3. `src/core/contract.ts`：`resume` / `block` / `done` 状态迁移 + next-up 校验
- [ ] 4. `src/tools/mission.ts`：三个新动作
- [ ] 5. `src/tools/todo.ts`：`suspend` 强制 `wakeWhen`；`drifted` 状态值
- [ ] 6. `src/hooks/context.ts`：`[drift]` 段 + `[未处置]` 标记
- [ ] 7. 测试 `test/drift.mjs`：design §7 十一例 + 变异
- [ ] 8. 文档：`docs/collab.md`「漂移与挂起」；skill；CHANGELOG
- [ ] 9. 门禁 + 复核

## 门禁

```bash
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

报数：工具数 26（不增）、drift 触发轮次（应=5）、24h 转换用例。

## 复核门

- 独立子代理跑全量门禁并贴原始输出；
- 变异（强制）：阈值 5 → 0，「连续 4 轮不触发」必红；
- 主会话抽检：构造 6 轮序列，亲跑注入看第 5 轮是否出现 `[drift]`。

## 回滚

见 `design.md` §8。
