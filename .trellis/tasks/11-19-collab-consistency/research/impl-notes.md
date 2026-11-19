# 实施记录：一致性修复（11-19-collab-consistency）

> 范围：R1 waiter 心跳/回收 · R2 三个心跳来源 · R3 只读可见性 · R4 四数口径 · R5 正文去重 · R6 文档。
> 未新增工具（17 个不变）、未新增依赖、未改版本号（仍 0.5.3，由父任务统一到 0.6.0）、
> 未改 `BUILTIN_PROTECT`、未做 git 写操作。

## 0. 结论

- 僵尸 waiter 死锁：`at` 升级为心跳 + `acquire` 写路径 `reapWaiters`，free + 3 个过期 waiter 现在**直接授予**；
  心跳由「再次 collab_lock / context hook / 写类工具」三处刷新，写入节流 30s；读命令零写入。
- `锁 N` 误导：四数口径落在 `src/core/counts.ts`，GUI 会话头 / TUI 侧栏 / TUI 面板同源；
  `持有` 只数 `holders.length > 0`，`free 但有 waiter` 不再算被占用。
- 重复投递：`collab_send` / `collab_reply` 按 `threadID + 归一化正文` 去重（默认 60s，`0` 关闭），
  命中不投递、不追加 thread 消息。
- 回归：`657 + 12 + 42 + 32 + 47 + 7 = 797` 条全绿（原 638 + 12 + 35 + 29 + 47 + 5 = 766，新增 31 条）。

## 1. 死锁复现 → 修复时序

**生产症状**（外部会话实测）：资源 `free`，但存在「排过一次队再没回来」的 waiter →
`collab_lock` 返回 `未获得资源租约: …（资源空闲，但有人在排队）`，该会话只能换资源名。

**修复前状态**：`LockWaiter` 只有 `{sid, at, mode, reason}`，`at` 是入队时间，无 TTL，
只有**本人**再次 acquire/release 才出队。

**修复后的时序**（`named:stale-queue`，free + 3 个 30 分钟前的 waiter）：

```text
t0  record: holders=[] waiters=[a(30m), b(30m), c(30m)]
t1  collab_lock(sid=d, confirm:true)
      → touchWaiters(d)   : d 不是 waiter → 一次目录扫描、0 次写
      → acquire() withGuard:
          readLock → reap(base)（没有 holder，不做事）
          reapWaiters(record, now, 10min)
            a/b/c 心跳 30min > 10min → 删除，history += leave/stale ×3
            waiters=[]        ← 公平性判定看到的是**回收后**的队列
          !holders.length && waiters.length === 0 → 直接授予 d
          writeLock()
t2  结果：held（d），waiters=[]，history 三条 leave/stale
```

实测输出（`node test/handoff-harness.mjs`，S95a）：

```text
--- S95 stale queue reap
  ✓ S95 free + 3 expired waiters → the new applicant is granted directly — 已获得资源租约: named:stale-queue
  ✓ S95 … and all three heartbeat-less waiters are gone (history: leave/stale) —
    [{"sid":"ses_s95a",…,"event":"leave","reason":"stale"},
     {"sid":"ses_s95b",…,"event":"leave","reason":"stale"},
     {"sid":"ses_s95c",…,"event":"leave","reason":"stale"}]
```

**修复前（变异：注释掉 `reapWaiters`）** —— 同一用例复现生产症状：

```text
  ✗ S95 free + 3 expired waiters → the new applicant is granted directly —
    未获得资源租约: named:stale-queue（资源空闲，但有人在排队）
```

活 waiter 不受影响（S95b）：`free + 1 个心跳新鲜的 waiter` → 新人仍被拒绝（FIFO 不插队），
waiter 保留原位；`collab_locks` 显示 `waiters=ses_s95w#1:exclusive(0s)`（无 `[stale]`）。

## 2. 三个新配置

| 键 | 默认 | 夹取 | 代码 |
| --- | --- | --- | --- |
| `waiterTtlMs` | 600000（10min） | [60000, 3600000] | `constants.ts` / `config.ts` / `normalizeWaiterTtl()` |
| `waiterHeartbeat` | `true` | 布尔 | `hooks` 由 `index.ts` 包裹（`false` 只关 context 这一半） |
| `dedupeWindowMs` | 60000 | [0, 24h]，`0` 关闭 | `config.ts` / `findDuplicateSend()` |

`waiterTtlMs` 没有「0 = 永不回收」：想要旧行为请设上限 60min（`normalizeWaiterTtl` 对 ≤0 回落默认值）。

## 3. 心跳三来源实测（S95d，各用独立 sid 以避免 30s 节流互相掩盖）

```text
  ✓ S95 heartbeat ①: re-applying collab_lock refreshes the waiter’s `at` — 1795049102360 → 1795049522393
  ✓ S95 heartbeat ②: the context hook refreshes it — 1795049102461 → 1795049522493
  ✓ S95 … and a second hook within the 30s throttle writes nothing — 1795049522493 / mtime 1795049522489.796 未变
  ✓ S95 heartbeat ③: a writing collab_* call (collab_send) refreshes it too — 1795049102573 → 1795049522624
  ✓ S95 a read command (collab_locks) is not a heartbeat: no write, no refresh — 1795049102720 / mtime 未变
```

`collab_locks` 只读（S95c）：

```text
  ✓ collab_locks marks an over-TTL waiter [stale] and prints its age —
    - named:stale-view  free  mode=exclusive  holders=-  剩余=-  ttl=-  waiters=ses_s95s#1:exclusive(20m)[stale]  ← 我排第 1
  ✓ … says how many waiters are stale in the header — 资源租约 17 个（持有=2 排队=53 free=15，其中排队心跳过期 1 人）:
  ✓ … and the read command wrote nothing at all (same mtime, same record) — 1795049522341.7917 → 1795049522341.7917
```

## 4. 去重三态实测（S95e）

```text
  ✓ 同 thread 同文（空白折叠后一致）→ 1 次投递 — 1 deliveries /
    未重复投递: thread t_s95_dedupe 在 60s 内已有同文（去重窗口），本次未投递、也未追加回复。
  ✓ 重复的正文没有追加进 thread — 1 → 1
  ✓ 同 thread 异文 → 2 次投递 — 2 deliveries / 已投递 → ses_bbb …
  ✓ collab_reply 同样去重（1 次投递）— 1 deliveries / 未重复投递 …
  ✓ dedupeWindowMs:0 关闭去重（同文 2 次投递）— 2 deliveries
```

判据来源：① 记录最近 3 条 `replies`；② **thread 自身消息**（持久，尾部 20 条，插件重载后仍生效）；
③ 进程内 memo（没有 thread 消息时兜底）。命中时不投递、不写 thread、不写 memo。

## 5. 四数在 GUI / TUI 的实测值

构造同一份快照：1 held（`holders=1, waiters=2`）+ 1 free 但含 1 个 `[stale]` waiter
+ 2 条 owner-queue + 宿主 pending = 1。

| 面 | 实测串 | 出处 |
| --- | --- | --- |
| GUI 会话头 | `持有 1 · 排队 3 · 待受保护 2 · 宿主排队 1` | `test/gui-panel.mjs` PN5 |
| TUI 侧栏 | `▸ 锁 1 · 排 3 · 待 2 · 宿 1` | `test/tui-render.mjs` R4 |
| TUI 面板 | `持有 1 · 排队 3 · 待受保护 2 · 宿主排队 1` + `图例: 持有=真实持有者 · 排队=FIFO 等候 · 待受保护=我交给受保护会话的请求 · 宿主排队=宿主 prompt 队列` | `test/tui-render.mjs` R4 |

- `held` 排除 `free + waiter` 记录（旧 `locks.length` 会把它算成 1 → 变异下 GUI 读到 `持有 2`）。
- GUI 宿主排队来自 `session.server.data.session.pending.list(session.id)`（首次 `sync` 一次，
  同一 session 的第二次渲染不再 sync）；没有 `server` / 没有 API / `list` 抛错 → 0，不新增 RPC。
- TUI 宿主排队来自 `ctx.data.session.pending.list(sessionID)`（宿主已同步数据，无第二条流）。

## 6. 变异验证（三组，均已还原）

### 变异 1：删 `reapWaiters`（`acquire` 不再回收）

```text
  ✗ S95 free + 3 expired waiters → the new applicant is granted directly — 未获得资源租约: named:stale-queue（资源空闲，但有人在排队）
  ✗ S95 … and all three heartbeat-less waiters are gone (history: leave/stale) — []
  ✗ S95 collab_locks shows the live waiter age and does not mark it stale — … waiters=ses_s95w#1:exclusive(0s)  ← 我排第 1
  ✗ S95 … says how many waiters are stale in the header — 资源租约 17 个（持有=2 排队=56 free=15，其中排队心跳过期 4 人）:
=== 653/657 checks passed
```

### 变异 2：删去重（`findDuplicateSend` 恒返回 undefined）

```text
  ✗ S95 the same thread + the same body (whitespace folded) within 60s is delivered once — 2 deliveries / 已投递 → ses_bbb …
  ✗ S95 … and the duplicate is not appended to the thread either — 1 → 2
  ✗ S95 a different body on the same thread is still delivered — 3 deliveries / 已投递 → ses_bbb …
  ✗ S95 collab_reply is de-duplicated the same way (one delivery) — 2 deliveries / 已投递 → ses_aaa …
=== 653/657 checks passed
```

### 变异 3：`held = locks.length`（回到旧口径）

```text
  ✗ PN5 the session header prints 持有 1 · 排队 3 · 待受保护 2 · 宿主排队 1 (held ≠ rows) — "持有 2 · 排队 3 · 待受保护 2 · 宿主排队 1"
=== 6/7 panel checks passed

  ✗ R4 the TUI sidebar reads 锁 1 · 排 3 · 待 2 · 宿 1 (held ≠ rows; the stale waiter holds nothing) — ▸ 锁 2 · 排 3 · 待 2 · 宿 1
  ✗ R4 the TUI panel prints the same four numbers in the long form — … 持有 2 · 排队 3 · 待受保护 2 · 宿主排队 1 …
=== 30/32 checks passed

  ✗ R4 countsOf: held = holders>0, waiting = sum of queues, protected = owner-queue length — {"snapshot":{"held":3,…},"mine":{"held":3,…}}
=== 41/42 checks passed
```

## 7. 回归

```text
pnpm typecheck                → OK
node test/handoff-harness.mjs → 657/657
test/readonly-default.mjs     → 12/12
test/snapshot-shape.mjs       → 42/42（原 35 + 7）
test/tui-render.mjs           → 32/32（原 29 + 3）
test/gui-entry.mjs            → 47/47
test/gui-panel.mjs            → 7/7（原 5 + 2）
node scripts/check-skill.mjs  → skills ok
```

既有断言只改了一处契约文本：S87c 的排队显示从 `waiters=a#1:exclusive,b#2:exclusive`
改为带心跳年龄 `waiters=a#1:exclusive(0s),b#2:exclusive(0s)`（同一条记录，语义未变）。

## 8. 边界与未做

- **只读口径**：`collab_locks` / 侧栏快照不回收、不写盘；回收只在 `acquire`。快照的 `stale` 用内置
  `LOCK_WAITER_TTL_MS`（默认 10min）判定——快照读取层拿不到 `collab.json`，若运维把 `waiterTtlMs`
  调到别处，面板的 `[stale]` 仍按默认阈值显示（仅显示差异，不影响回收）。
- **心跳第 ③ 来源**只接在 `dispatch`（`collab_send` / `collab_reply`）与 `deliverAsk`（`collab_handoff`）
  以及 `collab_lock` 上——受本子任务文件白名单限制没有逐个包住其余写工具；实际影响很小：任何模型回合都会
  触发 `context` 心跳（除非 `waiterHeartbeat:false`）。
- **去重不跨机器、不跨 thread**：不带 `threadID` 的 `collab_send` 每次都是新 thread，不会被判重复；
  `dedupeWindowMs:0` 是回滚开关。`collab_escalate` 用自己 5min 窗口，未叠加。
- 未动 `collab_wait` 语义、未做 waiter 主动唤醒（仍是 informed FIFO）、未改 `snapshot` 既有字段语义。
- 未改版本号（`package.json` / `PLUGIN_VERSION` 仍 0.5.3，父任务统一 0.6.0）；CHANGELOG 已写 0.6.0 条目。

## 9. 变更文件

新增：`src/core/counts.ts`、本文件。

修改：`src/constants.ts`、`src/types.ts`、`src/config.ts`、`src/core/locks.ts`、`src/core/snapshot.ts`、
`src/rpc.ts`、`src/tools/locks.ts`、`src/tools/shared.ts`、`src/tools/send.ts`、`src/tools/reply.ts`、
`src/index.ts`、`src/gui.tsx`、`src/tui.tsx`、`test/handoff-harness.mjs`、`test/snapshot-shape.mjs`、
`test/tui-render.mjs`、`test/gui-entry.mjs`、`test/gui-panel.mjs`、`docs/collab.md`、`README.md`、
`skills/collab/SKILL.md`、`skills/collab-coordination/SKILL.md`、`CHANGELOG.md`。

> 说明：`src/types.ts` / `src/rpc.ts` / `src/core/snapshot.ts` 不在任务书「硬约束」列表里，但 design §1/§3
> 要求 `stateOf` 追加派生字段、快照追加可选字段、配置追加三个键 —— 这三处是它们的必要落点，均只新增可选字段。

---

**一句话汇报**：R1–R6 全部落地——waiter 的 `at` 变成心跳（默认 10min，`waiterTtlMs` 夹在 1min–1h），
`acquire` 写路径先回收过期 waiter 再判公平性（free + 3 个过期 waiter 现在直接授予），心跳由「再次
`collab_lock` / 会话 `context` 每轮 / 写类 `collab_*` 顺手 touch」三处刷新并节流 30s，`collab_locks` 只读地
显示 `sid#pos:mode(age)` 与 `[stale]`；GUI 会话头 / TUI 侧栏 / TUI 面板统一为
`持有 1 · 排队 3 · 待受保护 2 · 宿主排队 1`（`src/core/counts.ts`，`held` 只数持有者）；`collab_send` /
`collab_reply` 对「同 thread + 归一化同文」在 60s 内只投递一次（`dedupeWindowMs:0` 关闭）。
`pnpm typecheck` + `pnpm test` + `check-skill` 全绿（797 条），三组变异分别让死锁 / 去重 / 四数用例真实失败后
已还原；未新增工具、未新增依赖、未改版本号、未做任何 git 写操作。
