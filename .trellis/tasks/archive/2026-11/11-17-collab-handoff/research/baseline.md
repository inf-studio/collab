# 基线（实现前）

- `opencode --version` → `2.3.0`
- `opencode api get "/api/plugin?location[directory]=$PWD"` → `collab` state `active`，source 为
  `/data/project/muke-pos-app/.opencode/plugins/collab.js`
- 现有实现：`.opencode/plugins/collab.js` 603 行，4 工具（list/send/inbox/wait）+ 1 事件源 + 1 个 `context` hook
- V2 Agent 配置**没有** `tools` 字段（已从 `/openapi.json` 的 `Agent.Info` / `Config.AgentEncoded` 核实），
  工具可见性由 **permissions** 决定（action = 工具名）
- `explore` 内置权限链含 `{action:"*",resource:"*",effect:"deny"}` 后接 read/glob/grep/shell/webfetch/websearch 白名单
  → 这解释了 verify.md 里「explore 看不到 collab_*」：插件工具名不在白名单里
- `plan` 权限链是 `* allow` + `edit deny`（无全量 deny），插件工具本应可见（待实测）
- 服务器当前有 3 个 busy 会话（含 schema 线、design 线）→ **不执行 `opencode service restart`**
