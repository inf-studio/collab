# PRD：0.7 协作自动感知与转发链

## 背景

0.6.0 解决了「排队/计数/去重/加急/冻结/看板」，但一次真实跨仓链路（A→B→C）暴露两层问题：

1. **没有自动感知**：会话 A 需要 B 协助时，必须**人**提醒它「走协作流程」；B 同样不知道何时该回执。工具存在 ≠ 会话知道该用。
2. **转发链表达层缺口**：对接人（A）在 B→C 的记录里丢失；同会话并行 7 个 thread 导致空转；同文跨 thread 重发全部放行；BLOCKED 只有自由正文；契约决策散落。

## 任务图（顺序即优先级）

| 顺序 | 子任务 | 交付 |
| --- | --- | --- |
| 0 | `collab-awareness` | 需要协助时不必靠人提醒：context 一行能力提示（可关）+ 承接方首行协议头 |
| 1 | `collab-origin` | 交接可选 `origin {sid,role,directory}`；承接方注入与 receipt 渲染「对接人」 |
| 2 | `collab-dedupe-target` | 去重增 **target** 维度；命中不静默再投，`force:true` 可强制 |
| 3 | `collab-threads` | `collab_threads { target }`；`collab_status` 对消息 thread 降级而非报错 |
| 4 | `collab-blocked` | 可选 `blocked {excluded,minimalTest,need}`，收件视图聚合 |
| 5 | `collab-decisions` | 轻量 `collab_decisions {bid,items[]}`，只读拉取 + 注入最近几条 |

## 验收（父）

- [x] 六项各自通过实现 + 独立复核（awareness / origin / dedupe-target / threads / blocked / decisions）；
- [x] 回归：`870 + 12 + 20 + 50 + 49 + 47 + 17` 全绿，工具数 20 → 22；
- [x] 证据包里的 4 条可复现链（4 跳→2 跳、3 thread 重发、7 thread 空转、消息 thread 报错）均有对应断言；
- [x] 文档与 skill 同步；一次发 `0.7.0`。

## 非目标

- 不做「自动判断该找谁」（候选打分已有）；
- 不做跨机器协作；
- 不改 `BUILTIN_PROTECT` 与只读 agent 的硬边界。


## 完成记录（2026-11-19）

| 子任务 | 交付 | 复核关键修复 |
| --- | --- | --- |
| `awareness` | 双计数提示 + 协议头 | 协议头原先给的回执命令缺 `text`，记录会停在 `acked`（已修，改为可照抄且能闭环） |
| `origin` | 对接人 + 一层继承 | A→B→C 两跳成立；对接人可闭环、第三方不可、protected 零放宽 |
| `dedupe-target` | 同 target 同文提示 | 查询在前、拒绝优先；`force:true` 可强制 |
| `threads` | thread 聚合 + status 降级 | 读放大（先排序再读）、`includeClosed` 预留槽位 |
| `blocked` | 结构化 BLOCKED | 预览写盘、非参与方旁路（抽 `canWriteBlocked`） |
| `decisions` | 契约决策 | 按 id 覆盖、权限 fail-closed、预览不写 |

版本 `0.7.0`；工具 20 → 22；快照仅追加可选字段。
