# collab 插件化（V2 server plugin：原生工具 + 事件注入）

> 前置：`scripts/collab.mjs` 已交付并归档（`11-17-opencode-collab-bridge`），提供 shell 侧同一能力的 CLI。
> 本任务把它升级为 **OpenCode V2 server 插件**：工具原生可调用、事件驱动实时收、未读自动注入、全局配置。

## 背景

CLI 版每次都要 `node scripts/collab.mjs …` 走 shell、拿不到实时事件，且未读消息要人主动查。
V2 插件 API 提供（已核对官方文档 `https://opencode.ai/docs/build/plugins/server`）：

| 能力 | API |
| --- | --- |
| 注册工具 | `ctx.tool.transform(editor => editor.add({ name, description, input, execute }))` |
| 会话操作 | `ctx.session.prompt / generate / wait / interrupt / list / context` |
| 实时事件 | `ctx.event.subscribe({ types, signal })`（服务端事件流，非轮询） |
| 注入未读 | `ctx.session.hook("context", e => e.system.push({ type: "text", text }))` |
| 持久化 | `ctx.storage.get / set / scan`（插件级 KV，跨重启） |
| 全局配置 | `ctx.options`（`opencode.json` 的 `plugins[].options`） |

## Goal

让任意会话**用工具调用**就能跨会话收发，并把未读消息在下一轮模型请求里自动呈现，无需 shell、无需轮询。

## Requirements

### R1 原生工具（4 个）

| 工具 | 入参 | 行为 |
| --- | --- | --- |
| `collab_list` | `{ limit?: number }` | 列会话（id/agent/state/title/alias） |
| `collab_send` | `{ target: string, text: string, mode?: "steer"\|"queue", confirm: boolean }` | 解析别名 → `ctx.session.prompt`；**`confirm` 必须为 true**，否则只返回「将发送的内容」 |
| `collab_inbox` | `{ limit?: number }` | 返回本会话未读的跨会话消息（从 `ctx.storage` 读） |
| `collab_wait` | `{ target: string, timeoutMs?: number }` | 调 `ctx.session.wait`；超时返回明确错误 |

### R2 实时接收

`ctx.event.subscribe` 订阅目标为「本会话」的入站消息/状态变化，写入 `ctx.storage` 的未读队列 + 游标；
**不轮询、不阻塞**。清理时 `AbortController.abort()`。

### R3 未读注入

`ctx.session.hook("context", …)`：若存在未读，向 `event.system` 追加一条紧凑提示
（形如 `[collab] 你有 N 条未读跨会话消息：…`），并在成功注入后推进游标，避免重复注入。

### R4 全局配置

配置文件 `~/.config/opencode/collab.json`（插件自读，或缺省用内置默认）：

```jsonc
{
  "aliases": { "schema": "ses_…", "parity": "ses_…" },
  "autoDeliver": true,        // 未读是否自动注入 context
  "maxInject": 3,             // 单次最多注入几条摘要
  "protect": ["ses_…"]        // 禁止 collab_send 命中的会话（硬名单）
}
```

同时在 `docs/collab.md` 写清「仓库内插件 + 全局启用方式（`plugins` 数组或 symlink 到 `~/.config/opencode/plugins/`）」。

### R5 安全

- `collab_send` 必须 `confirm: true`；`protect` 名单内的目标直接拒绝（附原因）。
- 不自动向任何会话投递（注入只影响**本会话**的模型请求，不改别人）。
- 不记录 token / 凭据；`ctx.storage` 只存消息摘要与游标。

## Acceptance Criteria

- [x] `opencode api get /api/plugin` 中该插件**无 `failed`**，且 `id` 为 `collab`
- [x] `collab_list` 可用（主会话直接调用返回 8 个会话，含 `[self,protected]` 与 `alias` 标记）
- [x] A→B 投递：`collab_send` 到临时会话后 `GET /message` 见 `metadata.collab.from` + `[collab:` 前缀（临时会话已删，GET 404）
- [ ] 未读注入：**未运行时验证**（实现子代理因账户余额中断；仅代码走读：hook 读 storage 未读 → push system）
- [x] `confirm:false` → 只预览不投递；`protect` 名单目标 → 抛「拒绝投递…未发送任何内容」
- [ ] 重启后游标持久：**未验证**（服务重启会打断并行会话，未执行）
- [x] 全局配置生效：`collab_list` 输出里出现 `collab.json` 定义的 alias（`probeC`，配置已清理为 schema/parity）
- [ ] 不新增依赖；不改 `packages/**`、`apps/**`

## 边界

- 不碰 `11-15-design-normalize`；不向非自建会话做真实投递测试（保护名单见 R5）；
- 插件不得阻塞 server 启动（setup 内不做长等待）。
