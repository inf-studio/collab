# PRD：collab_status（即时状态回执，只读）

## 背景

冻结/加急这类操作需要「现在到哪一步」的**非阻塞**答案；现有 `collab_wait` 会阻塞，
`collab_inbox` 只读消息，`collab_list` 是列表。protected 目标连 push 都不可用，更需要能安全查询。

## 需求

- **R1 输入**：`{ bid?, threadID?, session? }` 三选一；都缺省 = 本会话相关的未闭环单（最多 5 条）。
- **R2 输出（单条）**：`state`、`claim{by,kind,at,leaseMs}`、`priority`、`delivery{admittedAt,seenAt,ackUnavailable?}`、
  队列项 `{id, at, seenAt, priority?}`、最近一次 `reply`（时间/摘要）、**建议下一步**（一行，例如
  「等回执用 collab_wait」「受保护目标只能队列」「可 collab_escalate」）。
- **R3 只读**：**零文件写入**（测试断言 0 次 write/patch/remove）；对 protected 目标同样可用，
  并明确 `canPush:false`。
- **R4 多目标**：传 `session` 时列出该会话作为 `from.sid` 或 `claim.by` 的所有未闭环单。
- **R5 不阻塞、不投递**：不得调用 `session.prompt` / 线程投递。

## 约束

- 不复用 `collab_wait`（语义要清晰：查询 ≠ 等待）；
- 输出以文本为主（工具返回值是文本），不要新增 JSON RPC 契约。

## 验收

- [ ] 未闭环单：字段齐全，含「建议下一步」；
- [ ] 已闭环单：显示 `receipt`，建议「无需动作」；
- [ ] protected 目标：`canPush:false` + 队列项 + 队列位置；
- [ ] 只读：假 ctx 断言 0 次写操作；
- [ ] 无参数：返回本会话相关单（≤5），空时给一句「当前没有未闭环交接」；
- [ ] 回归 `638 + 12 + 35 + 29 + 47 + 5` 全绿，工具数 17 → 18。

## 非目标

- 不做历史归档查询（有 `collab_list` / archived 过滤）；
- 不做自动催办（那是 escalate）。
