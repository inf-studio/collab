# 设计：一致性修复

## 1. waiter 心跳（`src/core/locks.ts`）

```ts
interface LockWaiter { sid: string; at: number; mode: LockMode; reason?: string; }
```

- `at` 语义从「入队时间」升级为「最近心跳」（旧记录直接沿用，等同「很久没心跳」→ 会被回收，可接受）。
- 新常量：`LOCK_WAITER_TTL_MS = 10 * 60 * 1000`、`LOCK_WAITER_TTL_MIN_MS = 60s`、`_MAX = 60min`；
  配置 `waiterTtlMs`（`collab.json`）夹取范围。
- `touchWaiters(sid, now)`：扫描所有 lock 文件，把含该 sid 的 waiter `at = now`；
  **节流**：距上次写入 < 30s 则跳过（避免每轮都写盘）。
- `reapWaiters(record, now, ttl)`：`record.waiters = record.waiters.filter(w => now - w.at <= ttl)`，
  在 `acquire()` 进入决策前调用（写路径）。
- 决策 1 的公平性判断使用**回收后**的 waiter 列表：不再被僵尸卡住。
- `stateOf()` 不变（不改文件），新增派生字段 `waiterAges: number[]`（或 `staleWaiters: string[]`）
  供 `collab_locks` 与快照只读展示。

调用点：
| 位置 | 行为 |
| --- | --- |
| `collab_lock` | 先 `touchWaiters(me)`；再 acquire（内部 reap） |
| `context` hook | `touchWaiters(sessionID)`（`waiterHeartbeat !== false`） |
| 其它 collab 工具 | tool kit 统一入口顺手 `touchWaiters(me)`（节流） |

## 2. 四数口径

纯函数放 `src/core/counts.ts`：

```ts
export function countsOf(snapshot: Snapshot): { held: number; waiting: number; protected: number };
// held    = locks.filter(l => l.holders.length > 0).length
// waiting = locks.reduce((n, l) => n + l.waiters, 0)
// protected = queue.length
```

宿主排队（不经过 RPC）：

- TUI：`ctx.data.session.pending.list(sessionID).length`（已有 API）；
- GUI：`ctx.sessions.current()?.server.data.session.pending.list(session.id).length`；
  首次读取后调一次 `pending.sync(session.id)`（fire-and-forget），失败静默为 0。

展示：
- GUI 会话头 i18n：`持有 {{held}} · 排队 {{waiting}} · 待受保护 {{protected}} · 宿主排队 {{host}}`；
- TUI 侧栏紧凑：`锁 {{held}} · 排 {{waiting}} · 待 {{protected}} · 宿 {{host}}`；
- TUI 面板首行给一行图例，避免再猜。

## 3. 内容幂等（`src/tools/shared.ts` + `reply`/`send`）

```ts
const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
// key: threadID + '\n' + norm(text)
```

- 持久来源：`record.replies` 最近 3 条（`{from, at, text}`）——同 thread、60s 内、同文 → 判定重复；
- 无 record（`collab_send` 首投）时退回进程内 `Map<key, at>`（插件重载即清空，可接受）；
- 命中：**不投递、不追加 reply**，回执 `已发送过（60s 内同文，未重复投递）`；
- 配置 `dedupeWindowMs` 默认 `60000`，`0` 关闭；`collab_escalate` 用自己 5min 窗口，不叠加。

## 4. 只读保证

- `collab_locks` 只读（`stateOf`），只多展示 age/stale；
- waiter 回收只发生在 `acquire`（工具调用）与 `context`（本就是写路径）；
- 测试断言：`collab_locks` 调用前后 lock 目录文件 mtime 不变。

## 5. 测试与变异

| 用例 | 期望 |
| --- | --- |
| free + 3 过期 waiter | 新申请授予，waiter 清空 |
| free + 1 活 waiter（心跳新鲜） | 新申请排队（不插队） |
| 心跳来源 ×3 | `at` 被刷新（节流生效：30s 内不重复写） |
| stale waiter 展示 | `[stale]` + age |
| 四数（构造快照） | GUI/TUI 各一例，数字一致 |
| 去重同文/异文/关闭 | 1 / 2 / 2 次投递 |
| 回归 | `638 + 12 + 35 + 29 + 47 + 5` |

变异：删 `reapWaiters` → 死锁用例失败；删去重 → 重复用例失败；把 `held` 改成 `locks.length` → 四数用例失败。

## 6. 回滚

`git restore -- src/core/locks.ts src/core/counts.ts src/tools/shared.ts src/gui.tsx src/tui.tsx`；
`waiterTtlMs` / `dedupeWindowMs` 可运行时置 0 关闭。
