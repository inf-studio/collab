# collab 双向交接协议（request / reply + 不打断）

> 前置：`11-17-collab-plugin`（插件已上线，4 工具可用）+ `11-17-collab-verify`（实测：注入在 prompt 路径上冗余、
> 只读 agent 看不到工具）。
> 本任务把「单向投递」升级为**可闭环的双向交接**，且**不干扰双方正在跑的任务**。

## 背景与目标流程

期望流程（用户口径）：

```
see_a 有协作需求 → 发给 see_b
see_b 监听协作消息 → 收到后处理
see_b 处理完 → 通知 see_a（回执）
see_a 收到回执 → 继续 / 复核
全程：双方正在跑的任务不受影响
```

现状差距：

| 差距 | 现状 | 目标 |
| --- | --- | --- |
| 无「请求/回执」语义 | 只有 `collab_send` 纯文本 | `kind: request\|reply\|note` + `threadID` 关联 |
| 回执无法等待 | `collab_wait` 只等 idle | 新增「等某个 thread 的回执」 |
| 监听不可见 | 注入在 prompt 路径上冗余 | 只对「未被本次请求消费」的未读注入，且带 kind/thread |
| 只读 agent 不能协作 | `explore`/`plan` 无工具 | 分级放开：`list/inbox/wait/reply` 可用，`send` 强制 `queue` |
| 可能打断对方 | `steer` 是默认 | 默认 `queue`；`steer` 必须显式且限同 thread 的紧急回执 |

## Requirements

### R1 消息带上 thread 与 kind

- `collab_send` 入参新增 `kind?: "request"|"reply"|"note"`（默认 `request`）、`threadID?: string`（缺省自动生成）；
- 每个会话侧存储：`collab/threads/<threadID>` → `{ from, to, kind, status: open|answered|closed, messages[] }`；
- 回执必须带原 `threadID`，否则视为新请求（并在结果里提示）。

### R2 不打断（硬约束）

- **默认 `mode: "queue"`**；`steer` 仅在显式传参时使用，且工具描述标明「会并入对方当前轮，可能打断」；
- 不使用 `interrupt`；
- 注入只影响**下一次**模型请求，不改对方当前轮。

### R3 监听与回执可见

- `ctx.session.hook("context")`：只注入「未读且未被本次请求消费」的条目；
  **必须排除本次请求已包含的 inboxID**（上次实测的冗余根因）；
- 注入格式带语义：`[collab] 待处理请求 2 条 / 新回执 1 条`，每条 `- <kind> <threadID> from=<from>: <摘要>`；
- 新增 `collab_reply` 工具：`{ threadID, text, confirm }` = `collab_send{kind:"reply"}` 的语法糖。

### R4 等待回执

`collab_wait` 扩展：`{ target?, threadID?, timeoutMs? }`

- 传 `threadID`：等该 thread 出现 `kind:"reply"` 的消息（读存储 + 事件通知，不轮询业务数据）；
- 不传 `threadID`：保持原语义（等目标 idle）。

### R5 只读 agent 分级放开

| agent | `collab_list` | `collab_inbox` | `collab_wait` | `collab_reply` | `collab_send` |
| --- | --- | --- | --- | --- | --- |
| `build` | ✅ | ✅ | ✅ | ✅ | ✅（可 `steer`） |
| `plan` / `explore` | ✅ | ✅ | ✅ | ✅（强制 queue） | ✅ **强制 queue**，不允许 `steer` |

实现方式：插件在 `execute` 里读 `context.agent`（或等价来源），对只读 agent 把 `mode` 强制为 `queue` 并在返回里注明；
agent 的工具 allowlist 调整走 `.opencode` 配置。

## Acceptance Criteria

- [ ] 请求→回执闭环：A `collab_send{kind:"request"}` → B `collab_reply` → A `collab_wait{threadID}` 返回该回执
- [ ] 不打断：B 正在跑长任务时，A 的投递**不改变** B 当前轮的输出（对比投递前后 B 的当前 assistant 消息 id 不变）
- [ ] 注入去重：同一条消息不会在连续两次请求里重复出现（按 inboxID 排除）
- [ ] 只读 agent：`explore` 能调 `collab_inbox`；其 `collab_send` 被强制 `queue`（返回里明示）
- [ ] 持久化：插件**文件变更**触发热重载后，`ctx.storage` 的未读与 thread 状态仍在（实测口径订正：改
      `~/.config/opencode/collab.json` **不触发**插件重载；`opencode service restart` 后的持久化**未验证**）
- [ ] 全部实验只用自建临时会话；结束删除并复核 404
- [ ] 不新增依赖；不改 `packages/**`、`apps/**`

## 边界

- 不碰 `11-15-design-normalize`；不碰 schema 线任务与 `packages/schemas/**` 的未提交改动；
- 不做「自动代替对方执行动作」——协作只负责传话与回执，动作仍由接收方自主决定。
