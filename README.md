# `@inf-studio/collab`

多会话（含跨工作区）协作插件：十个原生 `collab_*` 工具 + thread/inbox 协议 + 一条
「广播 → 打分 → 原子领取 → 回执」的交接链路。

由 `.opencode/plugins/collab.js`（单文件 4000+ 行）迁移而来：行为、文案、存储键、
`bid` 算法与单文件版逐字一致，差别只有「可选类型 + 模块边界 + 默认只读」三点。

- 零运行时依赖：只用 Node 内置模块；宿主能力全部走插件 `ctx`（进程内），**不发 HTTP**
  （不猜端口、不读 token）。宿主契约按用到的字段本地声明，入口用 `@opencode/plugin` 的
  `Plugin.Plugin` 做一次签名对齐（type-only，构建后即可移除）。
- 构建产物：`dist/index.js`（ESM）+ `dist/index.d.ts`，可被 `opencode plugin add` 识别。

## 能力范围

| 工具               | 作用                                                                       | 读/写             |
| ------------------ | -------------------------------------------------------------------------- | ----------------- |
| `collab_list`      | 列可协作会话（id/agent/state/loc/title/parent/别名）+ 未闭环交接           | 只读              |
| `collab_inbox`     | 本会话收到的跨会话消息全文（单条 ≤4000 字）                                | 只读              |
| `collab_wait`      | 等某 thread 的回执，或等某会话空闲                                         | 只读              |
| `collab_send`      | 往另一个会话投递消息（`queue` 默认，不打断）                               | 发消息            |
| `collab_reply`     | 按 thread 自动路由的回执                                                   | 发消息            |
| `collab_handoff`   | 同工作区交接：选人（同一套打分）+ 打开 thread                              | 发消息            |
| `collab_broadcast` | 跨工作区交接：读提案 → 打分 → 写全局交接文件 → 只问 top-1 / 必要时拉新会话 | 发消息 + 可建会话 |
| `collab_accept`    | 原子领取广播（`<bid>.lock`，只有一个 winner）                              | 写交接记录        |
| `collab_grant`     | 给**一个会话**追加 5 条 `collab_*` 会话级权限（`revoke` 还原快照）         | **写会话权限**    |
| `collab_promote`   | 把一个会话的 agent 切到 `build`/`plan`（`revert` 还原）                    | **写会话 agent**  |

另有一个 `context` hook：把「未读消息 + 未闭环交接」各注入一次（≤ `maxInject` 条、
单条 ≤200 字），不改历史、不影响别的会话；同一句话不会重复注入。

> **权限提示（务必读）**：本插件可以**读取该实例上的会话元信息与消息上下文**（用于打分与
> 判断回执）、可以**向其它会话投递消息**（即以该实例的身份说话）、在 `allowWrite:true`
> 时可以**修改某个会话的 permissions / agent**。默认 `allowWrite:false`，后两项写入能力关闭。

## 安装

```bash
# 1) GitHub Packages（私有包，需要 @inf-studio scope 的读权限）
#    ~/.npmrc 里加：@inf-studio:registry=https://npm.pkg.github.com
opencode plugin add @inf-studio/collab@0.1.0

# 2) 本地目录（开发期；不会缓存，改完即生效）
#    opencode.json: { "plugins": ["./packages/collab"] }

# 3) 本地 tarball（验证打包内容）
npm pack && opencode plugin add ./info-studio-collab-0.1.0.tgz
```

验证已生效（无 `failed`，且列表里有 `collab`）：

```bash
opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"
```

### 卸载

```bash
opencode plugin remove @inf-studio/collab     # 包安装
# 目录/tarball 安装：删掉 opencode.json → plugins 里的对应条目
```

卸载不会删除已产生的数据（`ctx.storage` 里的 `collab/*`、`~/.config/opencode/collab-*`）。

## 配置

配置按优先级合并（低 → 高）：内置默认 < 插件 `options` < 旧别名文件
`~/.config/opencode/collab-aliases.json` < `~/.config/opencode/collab.json`
（可用 `COLLAB_CONFIG` 指向其它文件）。改完即时生效（按 mtime 惰性重读，无需重启）。

```jsonc
{
  "aliases": { "schema": "ses_…" },
  "autoDeliver": true,
  "maxInject": 3,
  "allowWrite": false,
  "protect": ["ses_…"],
  "readonlyAgents": ["explore", "plan"]
}
```

| 键               | 默认               | 说明                                                                                               |
| ---------------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| `allowWrite`     | `false`            | `false` 时 `collab_grant` / `collab_promote`（含 `revoke` / `revert`）一律拒绝；消息类工具照常可用 |
| `protect`        | 内置两条           | 投递/授权/切换 agent 的硬拒绝名单，按**血缘**生效（子会话、孙会话同样拒绝）                        |
| `readonlyAgents` | `explore` / `plan` | 只读 agent 永远不会收到 `steer`，入站消息一律降级为 `queue`                                        |
| `autoDeliver`    | `true`             | `false` 时不注入未读摘要（`collab_inbox` 仍可读）                                                  |
| `maxInject`      | `3`                | 每次请求最多注入几条未读（1–10）                                                                   |
| `aliases`        | `{}`               | 别名表：`collab_send {target:"schema"}`                                                            |

`protect` 与 `readonlyAgents` 都是**累加**的：内置项（schema 会话、长驻主线会话、
`explore`/`plan`）永远生效，配置文件只能加、不能减。

## 版本兼容

| 包版本  | OpenCode | Node      | 说明                                              |
| ------- | -------- | --------- | ------------------------------------------------- |
| `0.1.x` | `2.3.x`  | `>=22.18` | 与单文件版行为等价；`@opencode/plugin` 由宿主提供 |

宿主插件契约（`ctx.location / storage / session / tool / event`）只按用到的字段声明，
老宿主缺 `session.update` / `switchAgent` 时对应能力报可读错误而不是崩（也可配
`COLLAB_SERVER_URL` 走 HTTP fallback，默认不猜端口）。

## 开发

```bash
pnpm --filter=@inf-studio/collab build       # vp pack → dist/
pnpm install
pnpm typecheck
pnpm test          # build + 279 项 harness + 12 项只读默认
```

- `test/handoff-harness.mjs`：确定性回归（假宿主、真文件系统上的临时目录），
  覆盖 thread 状态机、注入去重、护栏、打分、原子领取、租约/顺延、自动闭环、
  权限补丁与 agent 切换（S68 = `collab_grant` 预览在「只有 promote 半段」台账上的崩溃回归）。
- `test/readonly-default.mjs`：R8 只读默认（默认拒绝 grant/promote、消息仍可用、
  `allowWrite:true` 正向对照、内置护栏不可被配置移除）。

源码结构：`src/core`（存储/领取/打分/回执/血缘）、`src/tools`（十个工具）、
`src/hooks`（context 注入）、`src/config.ts`、`src/index.ts`（`Plugin.define` 等价装配）。

## 许可

MPL-2.0
