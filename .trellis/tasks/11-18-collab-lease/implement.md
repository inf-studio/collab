# 执行计划：资源租约

## 1. 内核

- [x] `src/core/locks.ts`：`normalizeResource` / `readLock` / `writeLock`（tmp+rename）/ `withLockFile`（`open wx`，2s 超时）
- [x] `acquire()`：判定 free / shared 兼容 / 被占；`wait` 时入队；幂等
- [x] `release()`：仅 holder；`force` 默认拒绝
- [x] `reap()`：`expiresAt < now` → 释放 + `history: expire`
- [x] `stateOf()`：供 `collab_list` 与侧边栏

## 2. 资源规范化

- [x] `named:`（含中文别名表：`窗口/测试窗口` → `test-window`）
- [x] `file:`（workspace 内 realpath、拒 `..`/绝对/软链）
- [x] 同一资源不同写法归并（单测覆盖）

## 3. 工具

- [x] `collab_lock { resource, mode?, ttlMs?, reason?, wait?, confirm }`
- [x] `collab_unlock { resource, force?, confirm }`
- [x] `collab_locks { resource? }`
- [x] `collab_list` 追加「本人持有 / 排队中」

## 4. 回归（S86–S88）

- [x] 并发同一 exclusive：1 winner，另一个拿到「holder + 剩余 TTL」
- [x] shared 共存；shared vs exclusive 互斥
- [x] TTL 过期自动回收，等待者可见
- [x] 幂等：同一 sid 重复申请不重复计数
- [x] `file:` 越界/软链拒绝；named 别名归并
- [x] 既有 456+12 全绿

## 5. 文档与发布

- [x] `docs/collab.md` 新增「资源租约」节；skill `collab-coordination` 把 0.1.x 的「消息协商」升级为 `collab_lock`
- [x] `0.2.0`（新增工具，minor bump）
- [x] 归档后更新父任务进度

## 验证

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

## 回滚

删除 `collab-locks/`；`git restore -- src/`。
