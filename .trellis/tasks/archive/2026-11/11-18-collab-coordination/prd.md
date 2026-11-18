# 父任务：协作协调（资源租约 / 状态机 / 侧边栏 / 同仓 skill）

> 调研来源：2026-11-18 观察 `排钟专题` 与 `加载全部未实施 issues` 两个会话的协作记录。
> 现象：它们已经在用 collab 协商**测试窗口**，但方式是自然语言 + 本地 `ps` 判定；中途 `collab_*` 掉线后
> 完全退化为人工判窗。结论：缺的是**可判定的资源租约**，不是更多聊天。

## 问题

- 同工作区多会话并行时，共享资源（测试窗口、同一文件/模块、全量构建）靠「互相客气」协调；
- 没有所有权与排队语义 → 出现「两次请求窗口未获释放」「靠 ps 猜」；
- 协作状态分散在 thread / broadcast / 会话标题里，人在客户端看不到全局。

## 目标

1. **资源租约**：`exclusive/shared` 两种模式，原子申请、TTL、排队、过期回收，可机器判定；
2. **状态机**：handoff 状态机（现有）与资源状态机（新）分离但共享真源，可被侧边栏/工具统一读取；
3. **侧边栏**：OpenCode Desktop 侧栏面板 + composer pill，显示「谁持有 / 谁等待 / 未闭环 handoff」；
4. **同仓 skill**：把「查看锁 → 申请 → 等待/让行 → 释放 → 超时升级」写成 agent 规程。

## 子任务与依赖

| # | 子任务 | 交付 | 依赖 |
| --- | --- | --- | --- |
| C1 | `collab-lease` | `collab_lock/unlock/locks` + 资源状态机 + 全局存储 + harness | 无（先做） |
| C2 | `collab-sidebar` | `./gui-experimental` 侧栏面板 + composer pill | C1 的读取接口（RPC/文件） |
| C3 | `collab-same-workspace-skill` | `skills/collab-coordination/SKILL.md` | C1 的工具语义 |

顺序：C1 → C3（快）→ C2（GUI 实验 API，最后做）。

## 跨子任务验收

- [ ] 两个会话可对同一 `resource` 竞争：一个获得、另一个排队或拒绝，无「双方都以为自己有」；
- [ ] 租约过期自动回收，等待方被唤醒或明确提示；
- [ ] 侧边栏能显示 C1 的真实状态（不是缓存快照）；
- [ ] skill 的规程与 C1 工具一致，且含死锁避免（按资源名排序、TTL 上限、超时升级）。

## 边界

- 不自动给所有操作加锁（避免长任务互相卡死）；**显式申请** + skill 指导。
- GUI 部分接受 experimental API 的变动风险；server 部分不依赖 GUI。
- 不改 `BUILTIN_PROTECT` 与既有 handoff 语义；资源租约是增量能力。
