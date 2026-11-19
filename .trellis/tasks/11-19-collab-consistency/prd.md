# PRD：一致性修复（waiter 死锁 / 四数口径 / 重复投递）

## 背景（来自外部会话实测，已复核）

1. **僵尸 waiter 死锁**：`LockWaiter` 没有 TTL、永不被唤醒，只在**本人**再次 acquire/release 时出队。
   资源 free 但残留 waiter 时，新申请被拒（`tools/locks.ts:219`「资源空闲，但有人在排队」），
   该会话只能换资源名或人工协调。实测一晚误判 ≥3 次。
2. **「锁 1」误导**：`snapshot.ts:83` 会丢弃 free 且无 waiter 的锁记录，于是只有 waiter 的
   `test-window` 被保留并计入 `锁 N`（`gui.tsx:486` 用 `data.locks.length`）——这个「1」是僵尸排队，不是 holder。
3. **两个「队列」同名**：面板的「队列 N」是 owner-queue（提交给 protected 的请求），
   输入框上方的折叠项是**宿主 prompt 队列**（`delivery=queue`），两者语义不同却都叫「队列」。
4. **重复投递**：记录层只对 `cid`/ack 幂等，正文无去重；同一 thread 15s 内同文两次都投递。

## 需求

- **R1 waiter 心跳与回收**：`LockWaiter.at` 作为心跳；默认 TTL **10min**（`waiterTtlMs`，1–60min 可配）；
  `acquire` 的写路径回收过期 waiter；回收后无 waiter → 直接授予。
- **R2 心跳来源**：① 同 sid 再次 `collab_lock`；② 该会话 `context` hook（每轮一次，可关 `waiterHeartbeat`）；
  ③ 该会话的任何 collab 工具调用（轻量 touch，节流 ≥30s 写一次）。
- **R3 只读可见性**：`collab_locks` 显示 waiter 年龄，超 TTL 标 `[stale]`；**读命令不写文件**。
- **R4 四数口径**：`持有 N · 排队 M · 待受保护 K · 宿主排队 J`
  - 持有 = `locks.filter(l => l.holders.length > 0).length`
  - 排队 = `sum(l.waiters)`
  - 待受保护 = owner-queue（现「队列」）
  - 宿主排队 = 宿主 pending（TUI `data.session.pending`；GUI `server.data.session.pending`）
  - GUI 会话头与 TUI 侧栏/面板同口径；侧栏用紧凑写法（`锁 N · 排 M · 待 K · 宿 J`）。
- **R5 内容幂等**：`collab_reply` / `collab_send` 同 thread + 归一化正文，**60s** 内重复 → 只记录不投递
  （`dedupeWindowMs`，0 关闭）；回执写明「60s 内同文，未重复投递」。
- **R6 文档**：写清四个数、`free 但有 waiter ≠ 被占用`、去重窗口；skill 速查表同步。

## 约束

- 工具体系**不新增工具**（仍是 17 个，工具数断言不变）；
- 不改 `snapshot` 的既有字段语义（新增字段一律可选）；
- `collab_locks` 等读命令保持零写入（waiter 回收只发生在 `acquire` / context 写路径）；
- 版本 `0.6.0`（本子任务不改版本号，由父任务统一）。

## 验收

- [ ] free + 3 个过期 waiter → 新申请**直接授予**，过期 waiter 被清；
- [ ] 活 waiter（心跳 < TTL）仍然排队，不被插队；
- [ ] 心跳：`collab_lock` 重复调用 / context hook / 工具调用都会刷新 `at`（≥30s 节流）；
- [ ] `collab_locks` 显示 age 与 `[stale]`，且调用前后文件 mtime 不变；
- [ ] 四数：构造 1 held + 3 waiters + 2 owner-queue + 1 宿主 pending → 显示 `持有 1 · 排队 3 · 待受保护 2 · 宿主排队 1`（GUI/TUI 各一例）；
- [ ] 去重：同 thread 同文 2 次（间隔 <60s）→ 只有 1 次投递；不同文 → 2 次；`dedupeWindowMs:0` → 2 次；
- [ ] 回归 `638 + 12 + 35 + 29 + 47 + 5` 全绿。

## 非目标

- 不做 waiter「唤醒」（仍是 informed FIFO）；
- 不做跨机器 dedupe；
- 不动 `collab_wait` 语义。
