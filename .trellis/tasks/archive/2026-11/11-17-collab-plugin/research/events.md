# V2 事件类型探测（collab 白名单依据）

> 方法：临时插件 `.opencode/plugins/collab-probe.js` 用 `ctx.event.subscribe({})` 记录真实事件，
> 跑统计后删除该探针插件（其自身注释即要求删除）。日志 `/tmp/collab-events.log`，已清理。

## 观测到的类型（按频次）

| 次数 | type |
| ---: | --- |
| 5992 | `session.compaction.delta` |
| 4080 | `session.reasoning.delta` |
| 276 | `session.step.started` |
| 266 | `session.tool.success` / `session.tool.input.ended` / `session.tool.called` |
| 264 | `session.usage.updated` |
| 262 | `session.step.ended` |
| 260 | `session.step.streamed` |
| 258 | `session.step.first-token` / `session.reasoning.started` |
| **30** | **`session.inbox.enqueued`** ← 采用 |

## 结论

`collab` 只订阅 **`session.inbox.enqueued`**（入站消息入队，正是「别的会话给我发消息」的信号），
其余高频 delta/step 事件一律不碰，避免 `setup` 里的消费循环被 token 流压垮。

- 依据：该类型在探针日志里真实出现 30 次，不是猜的；
- 若未来 v2 改了事件名，`collab.js` 的 `EVENT_TYPES` 是单一改动点。
