# C3 同工作区协作 skill（锁 / 让行 / 死锁避免）

> 父任务：`11-18-collab-coordination`。依赖 C1 的工具语义。纯文档，可先于 C2 完成。

## 目标

把「同工作区多会话共享资源」的协调写成 agent 可执行规程，替代自然语言客气与 `ps` 猜测。

## Requirements

- **R1 位置**：`skills/collab-coordination/SKILL.md`（随包分发；本机软链到 `~/.config/opencode/skills/`）。
- **R2 规程**（可复制步骤）：
  1. 开工前 `collab_locks {resource}` 查看是否被持有；
  2. 需要独占 → `collab_lock {resource, mode:"exclusive", ttlMs, reason}`；
  3. 失败 → 读「持有者 + 剩余 TTL」决定**等待**还是**让行**（先做无冲突部分）；
  4. 完成 → `collab_unlock`（或依赖 TTL）；
  5. 超时未释放 → 升级给 owner，不擅自抢占。
- **R3 死锁避免**：多资源按**资源名排序**依次申请；TTL 上限；禁止嵌套等待超过 N 层；抢占需人工。
- **R4 场景样例**：排钟 vs issues 的测试窗口；同文件修改（`packages/state/.../store.ts`）；全量构建。
- **R5 与 handoff 的分工**：锁解决「同时做」，handoff 解决「交给谁做」；不要用锁代替交接。
- **R6 降级**：`collab_*` 不可用时（如插件未加载）退回「先 `ps`/`git status` 判定 + 在会话里明说」，并记录到消息。

## Acceptance Criteria

- [ ] skill 有 frontmatter（name/description）并通过 `check-skill`
- [ ] 规程覆盖申请/等待/让行/释放/超时升级五步
- [ ] 含 3 个真实场景样例与「降级路径」
- [ ] 与 C1 的工具名/参数逐字一致

## 边界

- 不鼓励对所有操作加锁；明确「只在共享资源上使用」。
- 不写入他人工作区。
