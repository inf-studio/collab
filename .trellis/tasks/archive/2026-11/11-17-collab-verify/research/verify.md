# collab 插件：两项运行时验证结果（2026-11-17）

> 目的：补齐 `11-17-collab-plugin` 归档时未验证的两条 AC。
> 方法：全部使用自建临时会话（用完 `DELETE`），未向任何真实会话投递。

## 结论摘要

| AC | 结论 | 证据 |
| --- | --- | --- |
| ① 未读注入在下一轮 system 可见 | **未观察到**（两轮实测） | 见 §2 |
| ② 重启/reload 后 `ctx.storage` 游标持久 | **未验证**（重启会打断 9 个并行会话） | 见 §3 |
| 附加发现 | **受限 agent（`explore`）看不到 collab 工具** | 见 §1 |

## 1. 工具可见性（新发现）

- `build` 会话：工具列表含 `collab_list / collab_send / collab_inbox / collab_wait`（主会话实测可用）。
- `explore` 会话：模型自述「工具集仅 glob/grep/read/shell/skill/webfetch/websearch」——
  插件注册的工具**没有**出现在它的工具集里。

推断：V2 的 agent 工具有 allowlist/过滤，插件 `editor.add` 的工具对**所有 agent 可见**这一假设不成立；
`explore`/`plan` 这类只读 agent 被剥掉了工具。

影响：若协作方是 `explore`/`plan`，它无法主动 `collab_inbox`；只能被动收到 user 消息。

## 2. 未读注入：未观察到

两次实验：

| # | 目标 | 投递方式 | 结果 |
| --- | --- | --- | --- |
| 1 | `explore` 会话 | `collab_send`（`queue`） | 模型明确回答「我的 system prompt 里没有 `[collab]` 摘要；消息以 user 身份到达」 |
| 2 | `build` 会话 | `collab_send`（`queue`） | 同样只见 user 消息，未见 `[collab] 你有 N 条未读…` |

**结构性解释（更可能是设计问题，不是 bug）**：

`collab_send` 走的是 `session.prompt`，消息**本身就作为 user turn 送达**；而注入是给
「已记录但尚未被消费的入站」做提醒——两者在同一路径上重叠，摘要必然冗余。
注入了反而会让同一句话出现两次。

因此这条 AC 的**验收口径本身值得改**：
- 有意义的目标是「目标**忙碌**时用 `queue` 投递，等它这一轮结束后，下一轮能看到未读摘要」；
- 当前实现没有区分「本次请求已包含的 inbound」，也未见 `event.sessionID` 是否存在的运行时证据。

待定项（需要加日志或改实现才能确认）：
1. `ctx.session.hook("context")` 的事件里有没有 `sessionID`（代码里 `event?.sessionID` 直接取，若缺失会静默 return）；
2. `session.inbox.enqueued` 的 `data.sessionID` 是否等于目标会话 id（`extractInbound` 依赖它）。

## 3. 持久化：未验证

`opencode service restart` 会中断此刻 9 个 in-progress 会话（schema 线正在跑），风险高于收益，
本轮未执行。替代方案（未做）：改 `collab.json` 触发插件热重载后，让一个带未读的会话读 `collab_inbox`，
看条目是否还在——比全量重启温和，但仍需一次模型调用。

## 4. 建议

1. **先修语义**：把注入限定为「`delivery=queue` 且目标当时忙」的场景；或在 hook 里按 `inboxID`
   排除「本次请求已包含的那条」，避免重复。修完再验 ①，验收口径改为「忙碌目标 + queue」。
2. **工具可见性**：若希望 `explore`/`plan` 也能协作，需要给它们放开 collab 工具（agent 工具配置），
   或在文档里写明「只有 build 类 agent 能主动收发」。
3. ② 挑一个无并行会话的窗口做 `service restart` 验证。
