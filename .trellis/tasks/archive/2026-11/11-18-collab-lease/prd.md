# C1 资源租约与状态机（`collab_lock` / `collab_unlock` / `collab_locks`）

> 父任务：`11-18-collab-coordination`。首个交付，无依赖。

## 问题

同工作区并行时，共享资源（测试窗口、同一文件/模块、全量构建）靠自然语言协商：
排钟会话占窗口 10+ 分钟、issues 会话两次请求未获释放、只能靠 `ps` 猜。

## Requirements

- **R1 两种模式**：`exclusive`（默认，独占）与 `shared`（共享读）。同一资源：exclusive 与任何模式互斥；
  shared 之间可共存。
- **R2 原子申请**：全局目录 `~/.config/opencode/collab-locks/<resource-hash>.json` + `open(lock,'wx')`；
  并发只有一个 winner，其余进入排队或立即返回「被谁持有 + 剩余 TTL」。
- **R3 租约与排队**：`ttlMs`（默认 15min，上限 2h）；过期自动回收（下次访问时判定），排队者按申请顺序获知；
  同一会话对同一资源重复申请 → 幂等返回既有租约。
- **R4 状态机**：`free → held → queued → expired`；与 handoff 状态机（`open/claimed/acked/done/blocked/expired`）
  **分离**，但共享同一读取层（供侧边栏使用）。
- **R5 可见性**：`collab_locks {resource?}` 列出持有者/模式/剩余 TTL/排队者；`collab_list` 追加当前会话的持有与等待。
- **R6 安全**：资源标识规范化（同一文件不同写法归并；禁止 `..` 越界）；`[protected*]` 会话可持有，但不可被抢占；
  不因锁阻断消息投递（锁只用于**自愿**协调）。
- **R7 回归**：并发同一资源 1 winner；exclusive vs shared 互斥矩阵；TTL 过期回收 + 排队提示；幂等申请。

## Acceptance Criteria

- [ ] 两个会话同时申请同一 exclusive 资源 → 一个获得、另一个拿到「持有者 + TTL」
- [ ] shared 可共存；shared 与 exclusive 互斥
- [ ] 租约过期后资源可被他人获得（无需人工清理）
- [ ] `collab_locks` 输出与真实文件一致；`collab_list` 显示本人持有/等待
- [ ] harness 全绿（含并发用例）；文档与 skill 用语一致

## 边界

- 不自动加锁；不替代 git 操作；不改 handoff 语义。
