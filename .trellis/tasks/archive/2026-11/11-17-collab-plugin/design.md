# 设计：V2 插件承载 collab

## 1. 为什么插件优于 CLI

| 维度 | CLI（已交付） | 插件 |
| --- | --- | --- |
| 调用方式 | shell 往返、每次起 node | 模型原生工具调用 |
| 实时性 | 需人/脚本主动跑 | `ctx.event.subscribe` 事件驱动 |
| 未读可见 | 要手动 `messages` | `session.hook("context")` 自动注入 |
| 持久化 | 自建 JSON | `ctx.storage`（跨重启） |
| 与 server 同进程 | 否（额外 API 往返） | 是（直接调 `ctx.session.*`） |

CLI 保留：CI/脚本/人肉排障场景仍用它；两者共用同一语义（`prompt` 投递、`generate` 不投递）。

## 2. 文件与加载

```
.opencode/plugins/collab.js          # 单文件，export default { id:'collab', async setup(ctx){} }
```

- 与既有 `session-start.js` 等同风格：**不依赖 `@opencode/plugin` 包**，直接导出 `{ id, setup }`（V2 已实测可加载）。
- 仓库内放置便于评审；全局启用两种方式（文档写清）：
  1. `~/.config/opencode/opencode.json` 的 `plugins: [ { "package": "/abs/path/.opencode/plugins/collab.js", "options": {} } ]`
  2. `ln -s <repo>/.opencode/plugins/collab.js ~/.config/opencode/plugins/collab.js`

## 3. 数据契约（`ctx.storage`）

| key | 值 |
| --- | --- |
| `collab/aliases` | `{ alias: sessionID }`（与 `~/.config/opencode/collab.json` 合并，config 优先） |
| `collab/inbox/<sessionID>` | `{ messages: [{ id, fromSession, text, ts, delivered }], cursor }`（只存摘要，不存全文历史） |
| `collab/delivered` | 已注入游标（避免重复注入） |

## 4. 事件与注入

```
ctx.event.subscribe({ types: [...], signal })
   → 收到「本会话」入站 → 写 collab/inbox/<self>
ctx.session.hook("context", e => { 若有未读 → e.system.push({type:'text', text:'[collab] …'}) ; 推进游标 })
```

要点：

- 注入只影响**本会话**这一次模型请求（与 Trellis 的 session-start 注入同机制），不写历史、不改别人。
- 注入内容**截断**（`maxInject` 条、单条 ≤200 字符），避免污染上下文。
- 游标推进放在注入之后，失败不推进（下次再注入，宁可重复不丢）。

## 5. 工具定义

用 JSON Schema 作为 `input`（`additionalProperties:false`）。`collab_send` 必填 `confirm`，
未确认时**不调** `ctx.session.prompt`，只回「将发送 + 目标 title/agent」供人/模型二次确认。

`protect` 名单在解析目标后立即校验：命中 → 返回错误并非投递。

## 6. 风险与处置

| 风险 | 处置 |
| --- | --- |
| 插件加载失败是**静默**的 | 验收必须查 `api get /api/plugin`；setup 内 `console.error` 一次自报 |
| 注入内容污染上下文/重复注入 | 截断 + 游标；单次最多 `maxInject` 条 |
| 事件类型名不确定 | 实现时先用 `ctx.event.subscribe({})` 打印实际 type，再收敛白名单 |
| 与 CLI 语义漂移 | 两者共用同一段语义说明（`docs/collab.md` 为 SSOT）；spec 里写「`generate` 不投递」 |
| server 启动被阻塞 | setup 内只做注册与订阅，不做网络等待；订阅放到 `void (async () => …)()` |

## 7. 回滚

删除 `.opencode/plugins/collab.js` 并从全局 `plugins` 移除条目即可；`ctx.storage` 数据可留可删（不影响其它）。
