# 统一协作链路（同工作区 + 跨工作区）

> 前身：`11-17-collab-handoff`（thread 协议，已归档）把「同工作区双向交接」做完；
> 本任务把**同工作区**与**跨工作区**统一成一条链路，并把它自动化到「发现需求 → 找到人 → 交出去 → 收结果」。

## 背景

- 同工作区：`collab_send/reply/wait` 已可用，但派活仍需人指定会话。
- 跨工作区：现状是手工三步——写 `docs/issues` 提案 → 找到对端任务会话 → 把提案贴进去。
- 痛点：**对端没被及时通知**，或**对端做完我们不知道**，任务长期挂起。
- 实测约束：`ctx.storage` 按 `location` 隔离（thread 不跨仓）；插件默认只装在本仓。

## 目标

一条链路、两个 scope：**广播 → 双打分 → 原子领取 → 执行 → 回执 → 闭环**。

| scope | 提案 | 传输 | 写权限 |
| --- | --- | --- | --- |
| `local` | 可选 | thread 可用 | 本仓正常权限 |
| `peer` | 必需（对端 `docs/issues`） | 只能消息 | 只读 + 仅提案 |

## Requirements

- **R1 群组与广播**：`workspace` 内根会话为成员，排除 `[protected]` / `[protected-child]` / 子会话。广播写全局文件（0 模型调用）；仅当 top 候选 busy > 30min 时补发 1 条 `prompt`。
- **R2 匹配分**：0–100，确定性计算。影响文件交集 45 / 标题词 25 / 同一任务线 15 / agent 匹配 10 / 最近活跃 5。读对端消息限**最近 200 条且 7 天内**，只提取文件路径。
- **R3 承接分**：≥80 的 top-1 收到接管请求，回答 `ACCEPT` / `DECLINE`。
- **R4 问询策略**：top-1 串行；租约 **5 分钟**；`DECLINE` 或超时顺延；`attempts > 3` 转 `expired` 并升级给人。
- **R5 竞争与幂等**：全局 `claim` 文件 `open(lock,'wx')` 原子领取；`bid = hash(scope+workspace+issuePath+内容hash+mtime)`；拉新也走同一条 claim，只建一个会话。
- **R6 拉新**：默认 `explore`（只读），必须带 `location.directory`；建 `build` **每次显式确认**；不删除任何会话。
- **R7 回执与闭环**：`[handoff] DONE|BLOCKED <路径> <摘要>`；发起方解析并更新 `bid`；`SessionStart` 列出未闭环项，只提醒一次。
- **R8 兼容**：`local` scope 复用既有 thread 协议（`collab_send/reply/wait`），不破坏现有行为。
- **R9 护栏**：跨仓只写 `docs/issues/**`；git 只读；不 push；不删会话；不 `interrupt`。

## Acceptance Criteria

- [ ] `/tmp` 双 `git init` 沙箱仓跑通 `local` 与 `peer` 两条链路（广播 → 打分 → 领取 → 回执）
- [ ] 并发领取只有一个 winner；重复广播幂等（同一内容不产生第二条 `bid`）
- [ ] 无候选 ≥80 时只拉新一个会话，且 `location.directory` 正确
- [ ] 匹配分可解释（`why` 含命中文件与命中词）
- [ ] 受保护会话及其子会话不会被投递
- [ ] 未闭环交接在下次 `SessionStart` 提醒一次后不再重复打扰
- [ ] 文档（guide）与实现行为一致

## 边界

- 不自动修改对端代码；对端实施由对端会话在其仓内自主完成。
- 不做跨机协作；不做常驻守护进程。
- 不改 `packages/**`、`apps/**`；不 push。
- 不替换 `collab_send/reply/wait`，只在其上编排。
