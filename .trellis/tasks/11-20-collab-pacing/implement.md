# 执行计划：2min 批量投递 + 无增量不发（0.9.6）

## 顺序清单

- [ ] 1. `src/core/pacing.ts`：窗口缓冲、合并、去重、定时 flush、过期补投
- [ ] 2. `src/core/delta.ts`：四类增量判定 + `suppressNoDelta`
- [ ] 3. `src/core/dispatch.ts`：接入 pacing；`escalate`/`blocked`/protected 直通
- [ ] 4. `src/tools/{send,reply,broadcast}.ts`：传 `kind`，删除各自的重试逻辑（统一到 dispatch）
- [ ] 5. `src/config.ts`：`windowMs`、`directKinds`、`suppressNoDelta`
- [ ] 6. `metrics` 四字段落库（`median_gap_ms` / `msg_count` / `noop_count` / `late_count`）
- [ ] 7. `src/hooks/context.ts`：每轮先扫过期窗口
- [ ] 8. 测试 `test/pacing.mjs`：design §8 九例 + 变异 + 回放
- [ ] 9. 文档：`docs/collab.md`「投递节奏与增量」；skill；CHANGELOG
- [ ] 10. 门禁 + 复核

## 门禁

```bash
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

报数：工具数 28（不增）、回放 p50 间隔、消息总量下降倍数、noop 次数。

## 复核门

- 独立子代理跑全量门禁并贴原始输出；
- 变异（强制）：`windowMs=0` → 「10 条合并为 1」必红；
- 主会话抽检：连发 5 条非紧急，亲测收端只收 1 条。

## 回滚

见 `design.md` §9；紧急时把 `windowMs` 配成 0 即恢复逐条投递。
