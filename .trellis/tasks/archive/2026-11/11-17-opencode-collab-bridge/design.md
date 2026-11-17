# 设计：直接复用 OpenCode v2 会话 API

## 1. 为什么不自己做总线 / MCP / ACP

| 方案 | 结论 |
| --- | --- |
| 自建文件总线 / SQLite | 重复造轮子；消息持久化、会话路由、并发写入都要自己处理 |
| MCP server | 只能「工具调用时拉取」，仍是轮询语义，且要新增进程与配置 |
| ACP | 是**编辑器 ↔ agent** 的协议，不是 agent ↔ agent；解决不了本问题 |
| **OpenCode v2 HTTP API** | 已有 `generate` / `wait` / `message` / `list`，**注入即实时**，持久化自带 |

结论：薄封装 CLI（或极小的 MCP 工具）直接调 API，是最短路径。

## 2. 端点契约（实测自 `opencode api get /openapi.json`）

```
POST /api/session/{sessionID}/generate     body {prompt:string}      → 注入一条用户消息
POST /api/experimental/session/{sessionID}/wait                        → 等空闲/完成
GET  /api/session/{sessionID}/message      ?limit=…                   → 读消息
GET  /api/session/{sessionID}/inbox
GET  /api/session                         → 列会话（含 parentID / agent / time）
POST /api/session                         → 建会话（自测用）
DELETE /api/session/{sessionID}           → 删会话（自测清理）
POST /api/session/{sessionID}/interrupt   → 打断（需显式开关）
```

传输两种可选：

1. `opencode api <method> <path> [-d @file]` —— CLI 自己解析当前后台服务地址，**无需知道端口**（推荐）；
2. 直连 `--server <url>` + Node `fetch` —— 需要知道服务地址，适合脚本内多次调用。

首版选 **1**（零依赖、与服务端版本自洽），把 2 作为 `--server` 备选。

## 3. 会话寻址

`collab send` 既接受 `ses_xxx`，也接受**别名**。别名表放 `~/.config/opencode/collab-aliases.json`
（不進仓库），例如：

```json
{ "schema": "ses_e1eb91cebffeTv1467ubJLKebk", "parity": "ses_e23a4a23fffe4c4m7UQFR8dUL3" }
```

## 4. 安全与幂等

- `send` 默认 **dry-run**：打印目标 agent/标题/将发送内容，`--yes` 才真发。
- `interrupt` 必须 `--interrupt` 且再确认一次（`--yes` 不能替代）。
- `selftest` 只用**自己新建**的临时会话；结束 `DELETE`，失败也删除（finally）。
- 不记录任何 token；`opencode api` 走本机服务凭据。

## 5. 与 Trellis channel 的关系

Channel 仍是**审计与跨会话留痕**的真源（人类可读、可 grep、跨机可搬）。
`--mirror <channel>` 时，`send` 成功后追加一条 `trellis channel send`，实现 「实时投递 + 长期留痕」双轨。

## 6. 风险

| 风险 | 处置 |
| --- | --- |
| 向**运行中**会话注入可能排队或被拒 | `wait` 先探空闲；被拒时回退为「写 channel + 提示用户」 |
| `generate` 语义可能与「用户输入」不同（如不带上下文） | 首版文档写清边界；必要时在消息里带 `[跨会话]` 前缀与来源 |
| 目标会话被自己的插件注入干扰 | 消息统一前缀 `[collab:<from>]`，便于过滤 |
| 服务未启动 | 报错信息直接给 `opencode serve` / `opencode service start` 提示 |

## 7. 回滚

单脚本 + 文档；删除脚本与文档即回滚，不影响产品代码与既有任务。
