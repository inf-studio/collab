# 执行计划：消息历史 + SQLite 投影（0.9.0）

## 前置（已验）

spike 通过：`vp pack` 保留 `import("node:sqlite")` / `import("bun:sqlite")`；node 与 bun 均可建库/写/查/FTS5；JSON 模式懒加载不 import。证据见父 `design.md` §2.4。

## 顺序清单

- [ ] 1. `src/core/envelope.ts`：类型 + 序列化 + 1MB 分片 + `sha256`
- [ ] 2. `src/core/db-runtime.ts`：运行时探测、懒加载、单写者队列、3 次退避、熔断
- [ ] 3. `src/core/store.ts`：`appendMessage` / `readMessages`（坏行跳过、轮转拼接）
- [ ] 4. `src/core/index-db.ts`：DDL（父 design §2.2 逐字）、`indexInsert`、查询、`rebuild`、`backfill`
- [ ] 5. 写点接入：`src/tools/shared.ts` 的 dispatch 成功后写 jsonl + 索引（顺序：jsonl 先）
- [ ] 6. 读点接入：`src/core/snapshot.ts` / `board.ts` 走 `readFromIndex()`，失败回落
- [ ] 7. `src/tools/index.ts` 注册 `collab_index`（`rebuild` / `backfill` / `stats`）；22 → 23
- [ ] 8. `src/config.ts`：`storage: 'sqlite' | 'json'`（默认 sqlite）、`dbPath`
- [ ] 9. 测试 `test/store-rebuild.mjs`：design §10 八例 + 3 组变异
- [ ] 10. 文档：`docs/collab.md` 新增「存储与索引」节、README、CHANGELOG
- [ ] 11. 门禁 + 复核

## 门禁

```bash
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

必须报数：工具数 23、测试计数、`rebuild` 耗时、`messages` 行数。

## 复核门

- 独立子代理：自己跑全量门禁并贴原始输出；
- 变异 1 组（强制）：`rebuild` 里删掉 `sent_at` 赋值 → 幂等 checksum 必须变；
- 主会话抽检：`git diff --stat` + 亲跑 `rebuild` 两次比对 checksum。

## 回滚

见 `design.md` §11（显式文件清单；先 restore 已跟踪文件，再 `rm` 新增文件）。
