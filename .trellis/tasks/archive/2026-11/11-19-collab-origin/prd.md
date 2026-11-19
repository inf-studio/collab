# PRD：交接对接人（origin）

## 问题

A→B→C 的转发链里，B→C 的记录 `from.sid` 只能是 B；A 的身份只能塞进正文。C 遇阻塞时不知道 A，只能回 B 再转，多两跳（实测 4 跳 vs 2 跳）。

## 需求

- **R1 记录字段**：`BroadcastRecord.origin?: { sid, role?: "requester"|"implementer"|"observer", directory? }`（可选，旧记录缺省）。
- **R2 入参**：`collab_handoff` / `collab_broadcast` / `collab_send` 接受 `origin`（sid 或别名）；缺省 = 本会话。
- **R3 渲染**：承接方注入与 receipt 模板固定一行 `对接人（非本单发起方）：ses_… @ <dir>`；`collab_status` 输出同字段。
- **R4 传递**：B 转发 A 的单时，`origin` 默认继承上一跳的 `origin ?? from`，不需要 B 手填。
- **R5 模板**：文档给出三行模板（提案路径 / bid / 对接人 sid+location），工具不强制但校验格式。

## 验收

- [ ] A→B→C 两跳：C 的注入与 receipt 都含 A；B 不填 origin 时自动继承；
- [ ] 旧记录（无 origin）不崩、不显示空行；
- [ ] `collab_status` 显示 origin；
- [ ] 证据包 4 跳链路在实现后可用 2 跳完成（用假宿主模拟）。
