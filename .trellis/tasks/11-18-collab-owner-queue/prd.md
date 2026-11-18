# 受保护目标请求队列 + `expected:research` + 同仓 broadcast 拒绝（0.4.0）

> 来源：缺陷上报 `d_6180f4ab4fb4368a`（muke-pos-app CLI 线，0.3.1）。
> 核实结论：**D2 不成立**（预览不落盘）；**D1/D3/D4 成立**。

## D1（阻断）受保护目标没有合规送达路径

`BUILTIN_PROTECT`（schema 线等）是单向硬边界，任何会话都无法投递。合法的跨线排查/请求送不进去，
只能退化为「broadcast 拉起 explore → 对方只能 BLOCKED」。

**Requirements**

- **R1 队列工具**：`collab_request_owner { target, text, issuePath?, confirm }`
  - 目标必须是 `[protected]` / `[protected-child]`（否则提示改用 `collab_handoff`）；
  - 写入 `~/.config/opencode/collab-owner-queue/<targetSid>/<queueId>.json`
    `{id, from, at, summary(≤500, 脱敏), issuePath?, bid?}`；
  - **不投递、不唤醒、不建 bid、不改任何协作状态**；`confirm:false` 只预览。
- **R2 只读提示**：受保护会话在自己的 `context` 注入里看到未读队列项各一行（最多 3 行/次）：
  `- [owner-queue] <from> @ <ts>：<summary 截断 120 字>（<issuePath 或 ->）`
  **只读**，不含指令、不要求回复；每条只提示一次（`seenAt`）。
- **R3 发起方可见**：`collab_list` 显示「我已提交给受保护会话的请求：N 条待处理」（附 queueId），
  可自行撤回（`collab_request_owner {id, revoke:true}`）。
- **R4 安全**：只允许「非受保护 → 受保护」方向；受保护会话不能给另一个受保护会话投队列项；
  summary 去控制字符、≤500；队列上限每目标 50（满则拒新）。

## D3 `expected:"research"`

- **R5**：`normalizeExpected` 接受 `research`；`collab_broadcast` / `collab_handoff` 的匹配与文案支持
  「只读排查 + 回执结论」；若承接 agent 为 `explore` 但 `expected=implement`，结果里**明确提示能力不匹配**；
  反之 `expected=research` 对 `build` 也合法。

## D4 同工作区 `collab_broadcast`

- **R6**：`workspace === ctx.location.directory` 时抛可读错误并提示改用 `collab_handoff`（不写全局记录）。

## Acceptance Criteria

- [ ] `collab_request_owner` 写入队列且**零投递**（构造断言 0 次 prompt）；`confirm:false` 零副作用
- [ ] 受保护会话下次运行看到 1–3 行只读提示，每条一次；不含任何指令
- [ ] 发起方 `collab_list` 看到待处理条数与 queueId；`revoke:true` 可撤回
- [ ] `expected:"research"` 可传；`explore` + `implement` 的结果带能力不匹配提示
- [ ] 同工作区 `collab_broadcast` 被拒并提示改用 `collab_handoff`
- [ ] 既有 526 + 12 + 18 全绿；`0.4.0` 发布

## 边界

- 不动 `BUILTIN_PROTECT` 名单；队列是 pull 模型，不构成投递通道。
- 不自动把队列项转成任务；owner 自己决定是否读取。
- D2（预览落盘）**不修**：已核实不成立（预览只打印 id，不写文件）。
