# 执行计划：一致性修复

## 1. waiter 心跳与回收（先做，解死锁）

- [ ] `src/constants.ts`：`LOCK_WAITER_TTL_MS`（10min）、MIN/MAX（60s / 60min）、`DEFAULTS.waiterTtlMs`、`DEFAULTS.waiterHeartbeat`
- [ ] `src/core/locks.ts`：`reapWaiters()`、`touchWaiters(sid, now, {throttleMs:30_000})`、`stateOf` 增 `waiterAgeMs[]` / `stale: boolean`
- [ ] `acquire()`：决策前 reap；公平性用回收后的列表
- [ ] `src/tools/locks.ts`：acquire 前 `touchWaiters(me)`；`collab_locks` 显示 `sid#pos(age)`，超 TTL 加 `[stale]`
- [ ] `src/index.ts` context hook：`touchWaiters(sessionID)`（受 `waiterHeartbeat` 控制）
- [ ] `src/tools/shared.ts` 的 `createToolKit`：统一入口节流 touch

## 2. 四数口径

- [ ] `src/core/counts.ts`：`countsOf(snapshot)`（held / waiting / protected）
- [ ] GUI：`HeaderCounts` 用 `countsOf` + `server.data.session.pending.list()`（首次 `sync`，失败静默 0）
- [ ] TUI：侧栏紧凑四数；面板首行图例
- [ ] i18n：`header.counts` / TUI 文案同步；文档写清四个数

## 3. 内容幂等

- [ ] `src/tools/shared.ts`：`normalizeText()`、`isDuplicateSend(record, threadID, text, now, window)`
- [ ] `collab_reply` / `collab_send`：命中即不投递、不追加 reply，回执说明
- [ ] 配置 `dedupeWindowMs`（默认 60000，0 关闭）

## 4. 测试

- [ ] `test/handoff-harness.mjs` 新段 S-consistency：
      free+过期 waiter 授予 / 活 waiter 不插队 / 心跳三来源 / stale 展示 / 只读 mtime / 去重三态
- [ ] `test/snapshot-shape.mjs`：`waiterAgeMs` 与 stale 字段
- [ ] `test/tui-render.mjs`、`test/gui-panel.mjs`：四数渲染（构造快照）
- [ ] 变异 3 组：删 reap / 删去重 / held 用 locks.length

## 5. 文档

- [ ] `docs/collab.md`：§11.4 配置（`waiterTtlMs` / `waiterHeartbeat` / `dedupeWindowMs`）、§11.7 锁、§11.10 投递
- [ ] README 配置表、skill 速查表、CHANGELOG（0.6.0 条目）

## 6. 验证

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

## 7. 回滚

按 design §6；运行时可 `waiterTtlMs: 0`?（不做 0=关闭，最小 60s）→ 用大值 60min 退化；
`dedupeWindowMs: 0` 关闭去重。
