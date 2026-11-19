# 执行计划：注入头名称

- [x] `src/core/verdict.ts`：`senderName` + `senderNameOf`（名称前置，截断 20、`]`→`）`，10 分钟按 sid 缓存、成功才缓存）
- [x] 注入调用处异步取名称（失败不缓存）：`src/tools/shared.ts`（`dispatch` / `deliverAsk`）、
      `src/core/chain.ts`（`resendOnce` / `notifyRequester`）；**注**：design 写的 `src/core/verdict.ts` 里
      没有 `inboundHeader`，实际的入站头由 `src/ids.ts` 的 `envelope()` 拼装，故落点在此（详见
      `research/impl-notes.md` §1）
- [x] `src/ids.ts` / `src/constants.ts`：`envelope({name})` 可选前置段；`COLLAB_(ENVELOPE|PREFIX)_RE` 容忍该段
- [x] 测试：四类 kind / 长标题 / 含 `]` / 取不到 / 缓存只查一次 / 解析兼容（S107，13 条）
- [x] 变异 2 组（去缓存、名称放后），失败原始输出记录在 `research/impl-notes.md` §7
- [x] 文档：`docs/collab.md` §11.7 注入头格式；CHANGELOG（`[Unreleased]`，版本号未改）
- [x] 回归全绿；工具数仍 22；版本不改（0.8.0 由父）

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

结果：`883 + 12 + 20 + 50 + 56 + 47 + 34` 全绿，`skills ok`。
