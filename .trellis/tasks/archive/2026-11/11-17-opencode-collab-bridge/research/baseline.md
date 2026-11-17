# 基线（11-17-opencode-collab-bridge）

| 项 | 值 | 采集方式 |
| --- | --- | --- |
| 仓库提交 | `f4c7e41fa` | `git rev-parse --short HEAD` |
| opencode | `v2.3.0` | `opencode --version` |
| 后台服务 | `http://0.0.0.0:22016` | `opencode service status` |
| 会话总数（当日） | 50 | `opencode api get /api/session` |
| openapi 快照 | `/tmp/opencode-openapi.json`（448 KB，本地临时） | `opencode api get /openapi.json` |

## 关键端点（实测 operationId）

```
POST   /api/session                                session.create
GET    /api/session                                session.list
GET    /api/session/{sessionID}                    session.get
DELETE /api/session/{sessionID}                    session.remove
POST   /api/session/{sessionID}/prompt             session.prompt        异步投递（立即返回 {id, delivery}）
POST   /api/session/{sessionID}/generate           session.generate      临时生成（不写历史、不驱动 agent loop）（返回 {text,tokens,cost}）
POST   /api/experimental/session/{sessionID}/wait  experimental.session.wait  204 = 空闲/本轮完成
GET    /api/session/{sessionID}/message            session.message.list  query: limit / order / cursor / type
GET    /api/session/{sessionID}/inbox              session.inbox.list
POST   /api/session/{sessionID}/interrupt          session.interrupt     返回 {interrupted}
```

## 实测行为差异（影响设计）

1. `generate` 是**临时生成（不写历史、不驱动 agent loop）**（`time` 实测 1.3s，返回 `data.text`），不是「注入即返回」。
2. `prompt` 是**异步入列**（0.1s 返回 `{id, delivery}`），会话随即 `time.busy`；目标忙时 `delivery=steer`。
3. `opencode api` 的 `--param` 对 message 列表的 `limit` 不生效；query 必须拼进 path。
4. `opencode api -d @file` 不支持（当字面量处理）。
5. 错误：非 0 退出码；错误 JSON 在 stdout（`_tag`/`message`），`HTTP 404 Not Found` 在 stderr。
