# 消息历史 + SQLite 投影（0.9.0）

## 问题

- 插件自己不存消息正文：inbox 只存未读，`collab-threads.json` 只有 80 字 preview，broadcast 只有状态 → 复盘/指标只能去 `opencode api` 分页拉（2600 条/会话），且 `cursor` 与 `order` 不能并用。
- 没有任何查询能力：跨会话、按时间、按 thread 全靠人眼。

## 需求

- **R1 `collab-messages.jsonl`**：append-only，一行一个信封（`Envelope`，见父 design §3）；`body` 存**全文**（超长按 1MB 分片），行尾附 `sha256`；**仅 FTS 索引体截 8KB**。
- **R2 `collab.db` 投影**：8 张表 + `messages_fts`（FTS5）；`WAL` + `busy_timeout=5000`；schema 见父 design §2.2。
- **R3 `collab_index rebuild`**：从 `jsonl` + `collab-*.json` 全量重建到 `collab.db.tmp` → `fsync` → 原子重命名；**幂等**。
- **R4 降级**：DB 不可用/损坏 → 自动纯 JSON；所有工具不报错，看板显示 `[索引不可用]`。
- **R5 读路径切换**：看板/快照/`collab_status` 优先读索引；无索引回落现有实现（逐字节等价）。
- **R6 回填**：24 条 handoff → `handoffs`；49 条 thread → `threads`；正文缺失留空并标 `backfilled=1`。
- **R7 零语义改动**：不改变任何现有工具的输出契约、不新增投递行为。

## 验收

- [ ] 重建幂等：连续两次 `rebuild`，每表 checksum 相同、行数相同。
- [ ] 坏行容错：jsonl 中插入一行非法 JSON → rebuild 成功，计数 = 正常行数。
- [ ] 降级：`chmod 000 collab.db` → 全部工具可用、看板退化、日志一条可读错误。
- [ ] 并发：3 个进程各写 100 条 → 库中 300 条，无丢失、无重复。
- [ ] 回填：`handoffs=24`、`threads=49`；`messages` 中 `backfilled=1` 的 body 为空。
- [ ] 回归全绿；工具数 22 → 23（仅新增 `collab_index`）。
- [ ] GUI 入口未引入存储模块（`--conditions=browser` 测试通过）。

## 依赖与风险

- 无前置依赖；后续 0.9.1 / 0.9.4 / 0.9.6 均依赖本版。
- 风险：打包器对 `node:sqlite` 的解析 → 动态 `import()` + 运行时探测 + `storage: 'json'` 开关兜底。

## 影响文件（预估）

`src/core/store.ts`（新）、`src/core/index-db.ts`（新）、`src/core/shared.ts`、`src/rpc.ts`、`src/tools/index.ts`、`test/store-rebuild.mjs`（新）。
