# 并发与租约：waiter 心跳 / 回收 / 幂等投递

适用于 `src/core/locks.ts`、`src/tools/locks.ts`、`src/tools/shared.ts`。这些规则来自 0.6.0 的真实事故
（僵尸 waiter 卡死 `test-window`，一晚误判 3 次）。

## 1. waiter 是心跳，不是入队时间

```ts
interface LockWaiter { sid: string; at: number; mode: LockMode; reason?: string }
```

- `at` = **最近心跳**；TTL 由 `waiterTtlMs` 控制（默认 10min，夹取 1min–60min）。
- 心跳来源只有三类（写清在文档里，别写「任何工具」）：
  1. 同 sid 再次 `collab_lock`（含 `wait:true` 重排，位置不变）；
  2. 该会话的 `context` 钩子，每轮一次（`waiterHeartbeat:false` 关闭）；
  3. `collab_lock` / `collab_send` / `collab_reply` / `collab_handoff` / `collab_broadcast`。
- 心跳写入 **30s 节流**；`collab_accept` / `request_owner` / `followup` / `grant` / `promote` / `report` /
  `archive` **不**刷新（它们不代表「我还在等」）。

## 2. 回收只发生在写路径

- `acquire()` 在公平性判断**之前** `reapWaiters(reap(record), now, ttl)`；回收后无 waiter → 直接授予。
- 读命令（`collab_locks`、快照）**零写入**：只展示 `sid#pos:mode(age)`，超过 TTL 标 `[stale]`。
- 违反这条会出现「读一次就把别人的队列改了」，测试里用 **mtime + hash** 断言。

## 3. 显示用的 TTL 必须一路传到底

`stateOf(record, now, sid, { waiterTtlMs })` —— `acquire` 的所有分支（含 `queueOrFull`）与 `release`
都必须传，否则 preview 用配置值、confirm 回执用内置 10min，出现「同一条队列，两处标 stale 不一致」。

## 4. 配置解析别用 `clamp` 兜 typo

`clamp("10m")` → `Number` 得 NaN → 返回 **最小值**，会把 10min 的意图悄悄变成 1min，误杀真实排队。
数字型配置先判 `typeof === 'number' && Number.isFinite && > 0`，否则回落默认值：
`normalizeWaiterTtl()` / `config.ts` 的 `waiterTtlMs` 都按这条写。

## 5. 内容幂等（投递层）

- 记录层的 `cid`/ack 幂等只解决「同一次投递重放」，**不解决同文重复发送**。
- `collab_reply` / `collab_send`：同 `threadID` + 归一化正文（`\s+`→空格、trim）在 `dedupeWindowMs`
  （默认 60s，`0` 关闭）内 → 不投递、不追加 `replies`，回执写明。
- 不要按 `(target, text)` 全局去重（补材料/催办是合法重复），窗口要短、维度要含 thread。

## 6. 相关测试

- `test/handoff-harness.mjs` S95：过期 waiter 授予、活 waiter 不插队、三来源心跳、`[stale]` + mtime、
  去重三态、配置缺省/typo 回落。
- 变异必做：删 `reapWaiters`、删去重、`held = locks.length`、`queueOrFull` 丢 TTL —— 各打掉对应断言。
