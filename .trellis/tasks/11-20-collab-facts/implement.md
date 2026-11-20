# 执行计划：事实账本 + settle/invalidate（0.9.4）

## 顺序清单

- [ ] 1. `src/core/facts.ts`：类型、读写、epoch、retract/supersede、2000 上限
- [ ] 2. `src/core/tri-state.ts`：本地状态快照 + `compare()`
- [ ] 3. `src/core/glossary.ts`：术语表 + 冲突检测
- [ ] 4. `src/tools/fact.ts`：`settle` / `retract` / `invalidate` / `list`；注册（26 → 27）
- [ ] 5. `src/core/messages.ts`：发送时补 `grade` / `factIds` / `basedOn`
- [ ] 6. `src/hooks/context.ts`：`[settled]` / `[retracted]` / `[未标注]` / `[stale]` / `[glossary]`
- [ ] 7. 在途失效：扫描 todos 标 `staleWork`（按 `ref.workspace` 过滤，防跨工作区误标）
- [ ] 8. `metrics.retract_count` 接入（retract + supersede）；`metrics.staleDeliveries` 接入
- [ ] 9. 测试 `test/facts.mjs`：design §9 十例 + 变异 + 双进程并发写回归 + 跨工作区隔离
- [ ] 10. 文档：`docs/collab.md`「事实账本 / 证据等级 / 三态 / 跨进程锁」；skill；CHANGELOG
- [ ] 11. 门禁 + 复核
- [ ] 12. 跨进程文件锁：`<file>.lock`（`open(…,'wx')` + pid/at + 60s 陈旧回收 + 3 次指数退避），`tmp+rename` 不变

## 门禁

```bash
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

报数：工具数 27、撤回可度量（`retract_count`，retract + supersede）、`staleDeliveries` 当日计数、
双进程并发写 `wsA=25/25 wsB=25/25 lost=0`（3 轮）。
（「stale 回复长度比」**不作为报数项**：插件不生成回复，30% 是行为约定，见 PRD 验收口径。）

## 复核门

- 独立子代理跑全量门禁并贴原始输出；
- 变异（强制）：`compare` 恒 fresh → stale/conflict 必红；`withFileLock` 置空 → 双进程回归必红；
- 主会话抽检：settle 一条 → invalidate 它 → 看注入是否出现 `[retracted]`。

## 回滚

见 `design.md` §10。
