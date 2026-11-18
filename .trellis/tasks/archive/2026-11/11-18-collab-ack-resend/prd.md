# 协作可靠性：送达应答 + 消息重发 + 闭环后 24h 追加窗口（0.1.6）

> 数据驱动：本机 50 会话、5 忙；常驻会话 900h+（934h/926h/900h），token 最高 5774 万（$640），
> 单轮可达数十分钟——**「处理完成才算送达」不可行**，重发也会制造重复。

## Requirements

- **R1 两级 ack**
  - `admitted`：`prompt` 返回 `message.id` + `delivery`（已有，落记录 `delivery.messageId`）；
  - `seen`：收方插件在**首次把它注入上下文或 `collab_inbox` 读到**时，回一条 `[ack] <cid>`（`kind=note`，
    `queue`），按 `cid` 去重，单条消息最多一次。
- **R2 重发（受限）**
  - 仅当 `admitted` 失败，或 `seen` 在 **2 小时**内未到**且目标当时 idle** 时补投 **1 次**（同 `cid` 幂等）；
  - 目标 busy 时**永不重发**（只等）；超过 2 次记为 `unacked`，在 `collab_list` 显示。
- **R3 可见性**：`collab_list` / `collab_wait` 输出 `admitted / seen / queue-age`；`unacked` 单独标注。
- **R4 受保护发送方**：向受保护发起方投递本就受限，`seen` 也不可能回来 → 标 `ackUnavailable`，
  不重试、不报错，回落到 pull/提案文件。
- **R5 闭环后追加（pull hint，取代 24h push 窗口）**
  - owner 原则：协作必须落地，不能「发送方一直等、协作方送不到」；但**不**新开 push 窗口（评审：常设注入面与 protect 目的冲突）。
  - 承接方闭环后的追加结论：写入 `record.followUps[]` + 提案文件（`## 闭环后追加（<date>）`），**不投递、不重开 bid**。
  - 受保护发起方在自己的 `context` 注入里收到一行**只读提示**（仅自己发起的 bid 有 followUps 时）：
    `- b_xxx 已闭环，提案 <path> 有追加结论（<ts>），请读取文件`；不写目标输入流、不产生跨会话投递。
  - 由此需**窄化放开**「受保护会话 `injectionFor` 返回 []」的旧规则：只允许这一条只读文件提示，不含任何消息正文/回执指令。
- **R6 安全**：窗口只对「同一 bid、同一领取人、同一发起方」生效；`note`/`steer` 永不通过；
  回声/占位符/否定语守卫沿用 0.1.4。
- **R7 回归**：S83–S85（ack admitted/seen、重发边界、protected ackUnavailable、24h 窗口正反例、
  过期拒绝、followUps 不改 state）。
- **R8 文档与发布**：`docs/collab.md`（ack 语义、重发规则、24h 窗口、过期写提案文件）、skill、CHANGELOG；`0.1.6`。

## Acceptance Criteria

- [ ] 目标 idle 且正常处理 → 发方看到 `seen`；busy 时不产生「未送达」误判
- [ ] admission 失败 → 重发 1 次；busy 目标不重发；`unacked` 可见
- [ ] 受保护目标 → `ackUnavailable`，不重试
- [ ] 闭环后追加：`followUps[]` 增加、`state` 不变、不投递；受保护发起方下次运行能看到一行只读提示
- [ ] 既有 405+12 全绿；`0.1.6` 发布

## 边界

- 不上传网络；不新增依赖；不改 `BUILTIN_PROTECT`。
- 重发不打断：始终 `queue`；`steer` 不受影响。
