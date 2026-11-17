# 设计：交接协议的数据与流程

## 1. 为什么不是「往 system 塞提示」

上一版把「未读」注入 system，但 `collab_send` 走 `session.prompt`，消息**本身就是 user turn** →
摘要重复、且看不出「谁在等什么」。交接协议要解决的是**状态机**，不是文案：

```
open(request) --reply--> answered --note/close--> closed
```

因此真源是**存储里的 thread**，注入只是「下一步该干什么」的提醒视图。

## 2. 存储契约（`ctx.storage`）

| key | 值 |
| --- | --- |
| `collab/threads/<threadID>` | `{ threadID, fromSession, toSession, kind, status, msgs: [{ id, inboxID, kind, text, ts }], createdAt, updatedAt }` |
| `collab/inbox/<sessionID>` | `{ msgs: [...], cursor, injected: string[] }`（`injected` 记已注入过的 inboxID，用于去重） |
| `collab/aliases` | 与 `collab.json` 合并，config 优先 |

`threadID`：`t_<base36timestamp>_<rand4>`；跨会话唯一即可，不做分布式一致性。

## 3. 三条流程（实现要能对上）

### 3.1 请求

```
see_a: collab_send { target: see_b, kind: "request", threadID?: auto, text, mode: "queue" }
  → ctx.session.prompt({ sessionID: see_b, text: "[collab:see_a][req:<tid>] …", delivery: "queue" })
  → 写 collab/threads/<tid> { status: open }
```

### 3.2 监听与处理

```
see_b 下一次模型请求：
  context hook 读 inbox（cursor 之后、且未在 injected 里）
  → 注入 "[collab] 待处理请求 1 条… - req <tid> from=see_a: <摘要>"
  → 把本次注入的 inboxID 记进 injected（不推进 cursor，保证 collab_inbox 仍能读到全文）
see_b 决定处理（它自己决定，插件不代替）
```

### 3.3 回执

```
see_b: collab_reply { threadID, text, confirm: true }
  → collab_send { kind: "reply", threadID, mode: "queue" }
  → thread.status = answered
see_a: collab_wait { threadID, timeoutMs }
  → 命中 kind=reply 的消息 → 返回全文 + 发送者
```

## 4. 不打断的保证

| 手段 | 说明 |
| --- | --- |
| 默认 `queue` | 目标繁忙时排队，不并入当前轮 |
| 只读 agent 强制 `queue` | `execute` 里按 `context.agent` 降级 `steer` → `queue` |
| 不用 `interrupt` | 插件不提供打断能力 |
| 注入只在下一次请求 | `context` hook 只影响本次请求的 system，不改历史、不动目标当前轮 |

验证方式（AC）：在目标忙时投递，比较投递前后目标**当前 assistant 消息 id** 是否不变。

## 5. 去重的正确做法

上一版根因：注入只推进 `cursor`，但 `prompt` 投递的同一句话也在同一请求里 → 重复。
新做法：

- 注入时按 `inboxID` 记入 `injected`；
- 注入前过滤「本次请求已包含的 inboxID」——通过 `payload.metadata.collab.inboxID` 与请求消息比对（拿不到时退化为按 `(threadID,kind,text)` 去重）；
- `collab_inbox` 永远返回全文（供模型主动查），不依赖注入。

## 6. 只读 agent 的工具可见性

- 现状：`explore` 看不到任何 `collab_*`（实测）。
- 方案：在 `.opencode` 的 agent 配置里把 4（+1）个工具加入 `explore`/`plan` 的 allowlist；
  同时插件内按 `context.agent` 做**能力降级**（只读 agent 只能 queue）。
- 注意：allowlist 是 agent 级配置，改完需确认 `explore` 会话重启后可见（新会话生效）。

## 7. 风险

| 风险 | 处置 |
| --- | --- |
| thread 状态与实际消息不一致 | 回执必须带回 threadID；找不到 thread 时提示「按新请求处理」 |
| 注入仍重复 | `injected` + 请求内 inboxID 比对，双保险 |
| 只读 agent 被强制 queue 后误以为已送达 | 工具返回里明示 `mode=queue(forced)` 与「已入队，未打断对方」 |
| 热重载后存储丢失 | 本任务用热重载验证；若丢失则说明 `ctx.storage` 不跨实例，需改用文件（`~/.config/opencode/collab-state.json`） |

## 8. 回滚

改回上一版行为只需：`kind/thread` 字段可选、`collab_reply` 是语法糖、注入去重可关（`autoDeliver:false`）。
不涉及产品代码与数据迁移。
