# 跨会话实时协作工具（OpenCode v2 API）

## 背景

多会话并行时（例如 parity 线与 schema 线），目前只能靠 Trellis channel 的**事件日志 + 双方主动 poll**，
不是实时：对方不 `channel wait` 就收不到。

实测 OpenCode v2.3.0 已原生提供会话级 API（`opencode api get /openapi.json` 可查）：

| 端点 | 作用 |
| --- | --- |
| `POST /api/session/{sessionID}/generate` `{prompt:string}` | 给指定会话注入一条用户消息 |
| `POST /api/experimental/session/{sessionID}/wait` | 等待目标会话空闲/完成 |
| `GET /api/session/{sessionID}/message`、`GET /api/session/{sessionID}/inbox` | 读消息 |
| `GET /api/session`、`POST /api/session`、`DELETE /api/session/{sessionID}` | 列/建/删会话 |
| `POST /api/session/{sessionID}/interrupt` | 打断当前轮次 |

消息持久化由 OpenCode 自身存储保证，**无需自建总线**；MCP / ACP 都不是必需路径
（ACP 是编辑器↔agent 协议，不适用于 agent↔agent）。

## Goal

提供一个可复用的小工具，让任意两个 OpenCode 会话能**实时**互发消息并等待回执，
把「靠人肉 poll 频道」升级为「一条命令送达」。

## Requirements

- **R1 发送**：`collab send <sessionID|别名> "<text>"` → 调 `generate` 注入；默认**先打印将要发送的内容并 dry-run**，
  加 `--yes` 才真正发送。
- **R2 等待**：`collab wait <sessionID> [--timeout 10m]` → 调 `wait`，超时给出明确退出码。
- **R3 读取**：`collab messages <sessionID> [-n 10]`、`collab inbox <sessionID>`、`collab list`（列会话与 agent）。
- **R4 测试隔离**：提供 `collab selftest`，**创建一次性会话**完成 发送→等待→读回 全链路，然后删除该会话；
  绝不在真实业务会话上做破坏性测试。
- **R5 与现有通道的关系**：默认只走 OpenCode API；可选 `--mirror <channelName>` 同步写一条到 Trellis channel，
  供事后审计（持久双写）。
- **R6 安全**：`interrupt` 必须显式 `--interrupt` + 二次确认；`list` 只读。

## Acceptance Criteria

- [ ] `collab selftest` 全绿：临时会话创建 → send → wait → 读到消息 → 删除，退出码 0
- [ ] `collab send --yes` 能让目标会话真的开始一轮（用一个**自己新建的**临时会话验证，不动真实会话）
- [ ] `collab wait` 在目标空闲时立即返回、在目标忙时阻塞；超时退出码可区分
- [ ] `collab list` 输出会话 id / agent / 状态，可被 grep
- [ ] 文档：一条命令示例 + 端点依据（file:line 或 openapi 路径）
- [ ] 不修改产品代码（`packages/**`、`apps/**`）

## 边界

- 不碰 `11-15-design-normalize`；不改其它会话的既有消息；
- 不把 token/凭据写进仓库；不新增依赖（Node 内置 `fetch` 即可，或直接用 `opencode api` CLI）。
