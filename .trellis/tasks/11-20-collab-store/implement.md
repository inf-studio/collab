# 执行计划：消息历史 + SQLite 投影（0.9.0）

## 前置（已验）

spike 通过：`vp pack` 保留 `import("node:sqlite")` / `import("bun:sqlite")`；node 与 bun 均可建库/写/查/FTS5；JSON 模式懒加载不 import。证据见父 `design.md` §2.4。

## 顺序清单

- [x] 1. `src/core/envelope.ts`：类型 + 序列化 + **编码后** 1MB 分片 + `sha256`
- [x] 2. `src/core/db-runtime.ts`：运行时探测、懒加载、单写者队列、3 次退避、熔断、**inode 重开**
- [x] 3. `src/core/store.ts`：`appendMessage` / `readMessages`（坏行跳过、轮转拼接）
- [x] 4. `src/core/index-db.ts` + `index-sync.ts`：DDL/迁移、`indexInsert`、`rebuild`（锁 + 原子 rename + 增量回放）、
      `backfill`、`indexSync`、`preferred*` 读路径
- [x] 5. 写点接入：dispatch / deliverAsk + 六个补充投递点（escalate / freeze / notifyRequester / ack / resend / report）
- [x] 6. 读点接入：`snapshot.ts`（locks/handoffs/queue）、`status.ts`、`threads.ts` 走索引，不新鲜即回落
- [x] 7. `src/tools/index.ts` 注册 `collab_index`（`rebuild` / `backfill` / `stats`）；22 → 23
- [x] 8. `src/config.ts`：`storage: 'sqlite' | 'json'`（默认 sqlite）、`dbPath`（支持 `~`）
- [x] 9. 测试：`test/store-rebuild.mjs`（30）+ `test/delivery-history.mjs`（9）+ 3 组变异
- [x] 10. 文档：`docs/collab.md` §11.21、README、CHANGELOG、PRD/design/父 design §2.2
- [x] 11. 门禁 + 复核（review 轮已修 B1/B2/R5/并发/消息覆盖）

## 门禁

```bash
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

必须报数：工具数 23、测试计数、`rebuild` 耗时、`messages` 行数。

**实测（2026-11-20 第三轮复核）**：工具数 **23**；测试 **900 + 13 + 20 + 53 + 54 + 30 + 9 + 60 + 47 + 82 = 1268**；
`rebuild` 300 条消息：**43ms / 31ms**（checksum 相同）；`backfill`：handoffs **24** / threads **49**（宿主实测 50）。

## 复核门

- 独立子代理：自己跑全量门禁并贴原始输出；
- 变异 1 组（强制）：`rebuild` 里删掉 `sent_at` 赋值 → 幂等 checksum 必须变；
- 主会话抽检：`git diff --stat` + 亲跑 `rebuild` 两次比对 checksum。

## 回滚

见 `design.md` §11（显式文件清单；先 restore 已跟踪文件，再 `rm` 新增文件）。
