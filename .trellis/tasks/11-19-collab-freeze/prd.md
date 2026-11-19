# PRD：collab_freeze（临时冻结标记）

## 背景

「临时冻结某个会话/工作区/一单」目前只能人工：发消息 + 自己记账 + 靠人守。插件不知道谁被冻，
新人/新会话还能继续往里投。需要的是一个**协作层**的冻结标记：可逆、可过期、被工具与展示共同遵守。

## 需求

- **R1 输入**：`{ scope: "session"|"workspace"|"bid", target?, reason, until?, freeze?: false, confirm }`
  - `target`：session/bid 必填；workspace 缺省 = 当前工作区；
  - `until`：绝对时间或相对分钟，默认 **30 分钟**；
  - `freeze:false` → 立刻解冻（同 scope + target）。
- **R2 存储**：`~/.config/opencode/collab-freeze.json`
  `{ version:1, entries:[{ scope, target, reason, by, at, until, notifiedAt? }] }`，读-合并-写。
- **R3 强制**：向冻结对象**新建**协作一律可读拒绝（`collab_handoff` / `collab_broadcast` / `collab_accept` /
  `collab_escalate`）；读取类（`collab_list` / `collab_status`）不受限。
- **R4 展示**：`collab_list` / 侧栏快照标 `[frozen]`（含到期时间）；被冻会话的 context 注入提示**一次**
  「你被冻结：原因 / 到期 / 解冻方式」。
- **R5 送达**：能 push 的目标投一条冻结通知并保留回执；`BUILTIN_PROTECT`/血缘 protected → 写 urgent 队列项。
- **R6 语义**：冻结 ≠ 归档 ≠ 删除；不写 permissions、不动 agent；到期自动失效。

## 约束

- 不做跨机器同步；不做定时提醒；
- 冻结不覆盖「只读 agent」「protected 不 push」等既有硬边界（叠加，不替代）。

## 验收

- [ ] 冻结 session：`collab_handoff {target}` 与 `collab_broadcast` 被拒（可读错误、0 写入）；
- [ ] 冻结 workspace：该目录下所有新建协作被拒；
- [ ] 冻结 bid：`collab_accept` / `collab_escalate` 被拒；
- [ ] `freeze:false` 解冻后可继续；`until` 到期后自动失效（用假时钟）；
- [ ] protected 目标：0 次 prompt，队列出现 `priority:'urgent'` 的冻结项；
- [ ] `collab_list` 标 `[frozen]`；context 只注入一次；
- [ ] 并发写冻结文件不丢条目（读-合并-写）；
- [ ] 回归全绿，工具数 19 → 20。

## 非目标

- 不做「冻结后自动归档」；
- 不做冻结的审批流（谁能冻由人决定）。
