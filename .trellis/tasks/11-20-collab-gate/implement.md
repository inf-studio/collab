# 执行计划：协作闸门（0.9.2）

## 顺序清单

- [ ] 1. `src/core/gate.ts`：`evaluate()` + scope 匹配 + 别名表 + 溢出计数
- [ ] 2. `src/core/audit.ts`：append jsonl，写失败不阻断
- [ ] 3. `src/tools/accept.ts`：deny 早返回（含 handoffTo 与 override 示例）
- [ ] 4. `src/tools/broadcast.ts` / `handoff.ts`：溢出 deny、越界 warn
- [ ] 5. `src/config.ts`：`gate`、`scopeAliases`、默认值 `enforce`
- [ ] 6. 测试 `test/gate.mjs`：design §7 十一例 + 变异
- [ ] 7. 文档：`docs/collab.md` 新增「闸门与 override」；skill 补一条；CHANGELOG
- [ ] 8. 门禁 + 复核

## 门禁

```bash
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

报数：工具数 26（本版不增）、误伤用例数（应为 0）、audit 行数。

## 复核门

- 独立子代理跑全量门禁并贴原始输出；
- 变异（强制）：`gate.ts` 越界判断取反 → 「命中 deny」必红；
- 主会话抽检：构造 outOfScope=`[ws集群实施]` 的契约，亲跑 accept 看返回。

## 回滚

见 `design.md` §8；紧急情况把 `gate` 配成 `off` 即可即时停用。
