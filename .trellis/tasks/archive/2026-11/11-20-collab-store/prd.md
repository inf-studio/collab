# 消息历史 + SQLite 投影（0.9.0）

## 问题

- 插件自己不存消息正文：inbox 只存未读，`collab-threads.json` 只有 80 字 preview，broadcast 只有状态 → 复盘/指标只能去 `opencode api` 分页拉（2600 条/会话），且 `cursor` 与 `order` 不能并用。
- 没有任何查询能力：跨会话、按时间、按 thread 全靠人眼。

## 需求

- **R1 `collab-messages.jsonl`**：append-only，一行一个信封（`Envelope`，见父 design §3）；`body` 存**全文**（超长按 1MB 分片），行尾附 `sha256`；**仅 FTS 索引体截 8192 字符（CJK ≈ 24KB）**。
- **R2 `collab.db` 投影**：8 张表 + `messages_fts`（FTS5）；`WAL` + `busy_timeout=5000`；schema 见父 design §2.2。
- **R3 `collab_index rebuild`**：从 `jsonl` + `collab-*.json` 全量重建到 `collab.db.tmp` → `fsync` → 原子重命名；**幂等**。
- **R4 降级**：DB 不可用/损坏 → 自动纯 JSON；所有工具不报错，看板显示 `[索引不可用]`。
- **R5 读路径切换**：看板/快照/`collab_status`/`collab_threads` 优先读索引；索引不可用或**不新鲜**时回落
  现有实现（逐字段等价，见验收）。新鲜度**按源**判定：`meta.full_sync_at` 存在，且该源的
  `synced_broadcasts / synced_locks / synced_queue / synced_threads ≥ 该源文件 mtime`——
  一个源的写入不会让另一个源的陈旧行看起来新鲜。只读路径**不得创建** `collab.db`。
- **R6 回填**：24 条 handoff → `handoffs`；thread 索引 → `threads`（宿主实测 **50** 条，测试 fixture 49）；
  locks / queue 当前状态一并入表。
  正文不可得 → **不写 `messages` 行**（不伪造），用 `meta.backfilled=1` + `backfilled_at` 标记「历史不完整」。
- **R7 零语义改动**：不改变任何现有工具的输出契约、不新增投递行为。

## 验收（0.9.0 review 后口径）

- [x] 重建幂等：连续两次 `rebuild`，每表 checksum 相同、行数相同、`sent_at` 与信封一致。
- [x] 坏行容错：jsonl 中插入一行非法 JSON → rebuild 成功，计数 = 正常行数。
- [x] 降级：坏库（内容损坏，比 `chmod 000` 更贴近真实故障；root 下 chmod 不生效）→ 全部工具可用、
  看板退化、日志一条可读错误。
- [x] 并发：单进程 rebuild 锁；子进程持续写 40 条 + 父进程并发 `rebuild` 6 次 → 库中 40 行零丢失
  （修复前丢 16 行）。
- [x] 回填：`handoffs=24`、`threads=50`（宿主实测；fixture 断言 49）；`meta.backfilled=1`；`messages` 不伪造回填行。
- [x] 回归全绿；工具数 22 → 23（仅新增 `collab_index`）。
- [x] GUI 入口未引入存储模块（`--conditions=browser` 测试通过）。
- [x] 读路径等价：索引路径与 JSON 路径的 locks/handoffs/queue 逐字段相等；源文件变更后回落 JSON。
- [x] 测试隔离：测试套件不写真实 `~/.config/opencode/collab-messages.jsonl` / `collab.db`（mtime+size 断言）。
- [x] 消息覆盖：六个补充投递点各写 1 行（notify / notify / note / ack / request / note），ack 同 cid 不重复。
- [x] 只跑 `rebuild`（不 `indexSync`、不投递）→ `meta.schema=1` 且 `preferredBroadcasts` 命中。
- [x] 冷启动只读 + 写广播 → 不生成任何 `collab.db*`，0 条 mirror 错误日志。
- [x] 按源水位：他人写 locks + 本进程 mirror 一条 handoff → lock 读者仍回落 JSON。
- [x] `mirror` 不清零 `frozen`（S9）；重发行带 `resend_of`（S10）；mirror 异步不阻塞写路径（S11）。

## 依赖与风险

- 无前置依赖；后续 0.9.1 / 0.9.4 / 0.9.6 均依赖本版。
- 风险：打包器对 `node:sqlite` 的解析 → 动态 `import()` + 运行时探测 + `storage: 'json'` 开关兜底。

## 影响文件（预估）

`src/core/{envelope,store,db-runtime,index-db,index-sync}.ts`（新）、`src/tools/shared.ts`、`src/tools/store.ts`（新）、
`src/tools/{index,status,threads}.ts`、`src/core/{snapshot,claim,locks,owner-queue,chain,actions,report}.ts`、
`src/rpc.ts`、`src/config.ts`、`src/index.ts`、`src/{gui,tui}.tsx`、`test/{store-rebuild,delivery-history}.mjs`（新）。
