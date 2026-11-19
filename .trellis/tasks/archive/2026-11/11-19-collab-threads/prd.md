# PRD：threads 聚合 + 状态降级

## 问题

- 同一对会话并行 7 个 thread，发消息前无法一眼看到「哪些还没闭环」；
- `collab_status { threadID }` 对 **消息类 thread**（collab_send/reply 建立，无广播记录）直接报错——7 个里 6 个命中，频率极高。

## 需求

- **R1 `collab_threads { target }`**（新工具，只读）：列出与该 target 的全部未闭环 thread：`threadID / kind（handoff|messages）/ 最近出入站摘要（各 1 条）/ 最近时间 / 建议用哪个继续`。
- **R2 `collab_status` 降级**：消息 thread 不报错，返回 `kind:"messages"` + 最近 N 条出入站摘要 + 关联的 handoff（若有）；未知 thread 才报错。
- **R3 只读**：两者都零写入、不投递。
- **R4 数量上限**：≤20 thread、每条摘要 ≤120 字；超出给「还有 N 个」。

## 验收

- [ ] 造 3 个 thread（1 handoff + 2 消息）→ `collab_threads` 全列出、kind 正确、建议合理；
- [ ] `collab_status { threadID: 消息 thread }` → `kind:messages` + 摘要，不报错（证据包里的原文不再出现）；
- [ ] 未知 thread → 可读错误；
- [ ] 只读：目录哈希不变；
- [ ] 工具数 20 → 21。
