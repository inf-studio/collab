# `@inf-studio/collab`

多会话（含跨工作区）协作插件：十六个原生 `collab_*` 工具（含缺陷上报、闭环后追加、资源租约与受保护目标请求队列）+
thread/inbox 协议 + 一条「广播 → 打分 → 原子领取 → 回执」的交接链路。

由 `.opencode/plugins/collab.js`（单文件 4000+ 行）迁移而来：行为、文案、存储键、
`bid` 算法与单文件版逐字一致，差别只有「可选类型 + 模块边界 + 默认只读」三点。

- 零运行时依赖：只用 Node 内置模块；宿主能力全部走插件 `ctx`（进程内），**不发 HTTP**
  （不猜端口、不读 token）。宿主契约按用到的字段本地声明，入口用 `@opencode/plugin` 的
  `Plugin.Plugin` 做一次签名对齐（type-only，构建后即可移除）。
- 构建产物：`dist/index.js`（ESM）+ `dist/index.d.ts`，可被 `opencode plugin add` 识别。
- 另有一个**可选**的桌面壳：`dist/gui-experimental.cjs`（`./gui-experimental` 出口），
  把同一份只读状态画进 OpenCode Desktop 的侧栏；server 部分完全不依赖它。

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
| `collab_request_owner` | 给**受保护**会话（`[protected]`/`[protected-child]`）排队一条请求：只写队列文件，目标下次运行时看到 ≤3 行只读提示（**不投递**、不建 bid/thread、`revoke` 仅发起方） | 写本地队列        |
| `collab_grant`     | 给**一个会话**追加 5 条 `collab_*` 会话级权限（`revoke` 还原快照）         | **写会话权限**    |
| `collab_promote`   | 把一个会话的 agent 切到 `build`/`plan`（`revert` 还原）                    | **写会话 agent**  |
| `collab_report`    | 上报疑似插件缺陷（证据脱敏落盘 + 可投递维护方，不改协作状态）              | 写本地证据        |
| `collab_followup`  | 闭环后追加指针（**仅本单领取人**；只写 `{bid,issuePath,at,by}`，提案文件由调用方自己写） | 写追加记录        |
| `collab_lock`      | 取资源租约（测试窗口/同一文件/构建；exclusive 或 shared，TTL 10s–2h，被占可 `wait` 排队） | 写本地租约        |
| `collab_unlock`    | 释放**自己**持有的租约（`shared` 组只移除自己；无 force 抢占）             | 写本地租约        |
| `collab_locks`     | 只读列出租约：持有者/模式/剩余 TTL/排队者（`collab_list` 也会显示本人持有/排队） | 只读              |

另有一个 `context` hook：把「未读消息 + 未闭环交接 + 挂起提醒」各注入一次（≤ `maxInject` 条、
单条 ≤200 字），不改历史、不影响别的会话；同一句话不会重复注入。
受保护会话的注入面是白名单：只有「闭环后追加」与「`[owner-queue]` 未读队列项」两类只读行
（每条一次，不含指令、不产生投递；两类合计 ≤3 行，同一提案只渲染 `at` 最新的一条）。

> **权限提示（务必读）**：本插件可以**读取该实例上的会话元信息与消息上下文**（用于打分与
> 判断回执）、可以**向其它会话投递消息**（即以该实例的身份说话）、在 `allowWrite:true`
> 时可以**修改某个会话的 permissions / agent**。默认 `allowWrite:false`，后两项写入能力关闭。

## 侧边栏（仅 Desktop，experimental）

`./gui-experimental` 是给 OpenCode Desktop 的**只读**视图：打开侧栏就能看到「谁持有资源 /
谁在排队 / 哪些交接没闭环」，不用再 `ps` 或轮询 `collab_list`。API 属于 experimental
（宿主侧标注），版本区间见下表。

| 位置 | 内容 |
| --- | --- |
| 侧栏 `collab` 面板 | 按工作区分组：会话（title / agent / busy）、持有租约（模式 + 剩余 TTL）、FIFO 排队、未闭环交接（`bid` / state / age）。从侧栏 **+** 菜单的「打开协作面板」打开；关掉后同样用这个入口找回（首次需从 **+** 菜单打开；`fallback` 只在已有 tab 列表时参与选择） |
| composer pill | 当前会话「锁 N · 等待 M」；`success` = 只持有，`warning` = 排第 1 位，`danger` = 排在别人后面 |
| 数据来源 | `collab.state.snapshot`（RPC）→ `stateOf()` + `allBroadcasts()`，与 `collab_locks` / `collab_list` 同一读取层；**没有第二份状态** |
| 刷新 | 有会话挂载时每 2 s 拉一次（面板在屏幕上时），面板与 pill 共用一个轮询 |
| 不可达 | server 停掉 / 插件被禁用时显示「server 不可达：…」，保留上一份快照，不空白也不崩 |

- **只读**：面板没有加锁/释放按钮。取锁、排队、释放仍然只有 `collab_lock` / `collab_unlock`
  两个工具（以及 skill 里的规程）——状态面板点错不该改变别的会话能做什么。
- **可关闭**：Settings → Extensions → Plugins 里本插件的开关；关掉 GUI 不影响 server 部分的工具。
- TUI / Web 没有侧栏，`collab_locks` / `collab_list` 的文本视图仍在。

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
  "aliases": { "schema": "ses_…", "collab-maintainer": "ses_…" },
  "autoDeliver": true,
  "maxInject": 3,
  "allowWrite": false,
  "protect": ["ses_…"],
  "readonlyAgents": ["explore", "plan"],
  "report": { "to": "collab-maintainer" }
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
| `report.to`      | 未配置             | 缺陷上报的**主通道**：别名或 `ses_…`，插件把证据摘要当 `note`（`queue`）投给它；未配置只落盘 |
| `report.enabled` | `true`             | `false` = 关闭投递（仍落盘），回滚开关                                                             |

`protect` 与 `readonlyAgents` 都是**累加**的：内置项（schema 会话、长驻主线会话、
`explore`/`plan`）永远生效，配置文件只能加、不能减。

## 版本兼容

| 包版本  | OpenCode | Node      | 说明                                              |
| ------- | -------- | --------- | ------------------------------------------------- |
| `0.4.x` | `2.3.x`  | `>=22.18` | 新增 `collab_request_owner`（受保护目标请求队列，pull 模型）+ `expected:"research"`；同工作区 `collab_broadcast` 改为拒绝（用 `collab_handoff`）；0.4.1 受保护注入按提案去重（追加提示与队列行合计 ≤3 行、只显示最新一条） |
| `0.3.x` | `2.3.x`  | `>=22.18` | 新增**只读**桌面侧栏（`./gui-experimental`，experimental API）；工具与存储不变 |
| `0.2.x` | `2.3.x`  | `>=22.18` | 新增资源租约（`collab_lock` / `collab_unlock` / `collab_locks`）；其余与 0.1.x 等价 |
| `0.1.x` | `2.3.x`  | `>=22.18` | 与单文件版行为等价；`@opencode/plugin` 由宿主提供 |

宿主插件契约（`ctx.location / storage / session / tool / event / rpc`）只按用到的字段声明，
老宿主缺 `session.update` / `switchAgent` 时对应能力报可读错误而不是崩（也可配
`COLLAB_SERVER_URL` 走 HTTP fallback，默认不猜端口）。构建需要 `pnpm-workspace.yaml` 的 `allowBuilds: esbuild`（pnpm 12 的构建脚本白名单）。`ctx.rpc` 缺失时只跳过侧栏注册
（日志 `rpc skipped`），工具照常工作。

> 侧栏用的是宿主 **experimental** GUI API（`@opencode/plugin/gui`）。`vite.gui.config.ts`
> 与三个 GUI devDependencies 只在构建时需要；server 产物 `dist/index.js` 仍然零运行时依赖。

## 开发

```bash
pnpm --filter=@inf-studio/collab build       # vp pack → dist/，再 vp build -c vite.gui.config.ts → dist/gui-experimental.cjs
pnpm install
pnpm typecheck
pnpm test          # build + 598 项 harness + 12 项只读默认 + 18 项侧栏快照
```

- `test/handoff-harness.mjs`：确定性回归（假宿主、真文件系统上的临时目录），
  覆盖 thread 状态机、注入去重、护栏、打分、原子领取、租约/顺延、自动闭环、
  权限补丁与 agent 切换（S68 = `collab_grant` 预览在「只有 promote 半段」台账上的崩溃回归），
  以及 S72–S80 缺陷上报：证据白名单/脱敏/1h 限流、`report.to` 投递与 protected 只落盘、
  `collab_report` 预览与幂等、三类挂起提醒去重、`collab-triage` 的 `--dry-run`/幂等/`--since`/`--notify`、
  `collab_wait` 宿主 5xx 上报（超时不报）与缺目录 triage（复核 F1–F4）。
  0.1.6 追加 S83–S85：两级 ack（`admitted`/`seen`）、受限重发（busy 永不重发、同 cid 幂等、
  `unacked` 可见）、闭环后追加（结构指针 + 受保护发起方一行只读提示 + 路径校验）。
  0.2.0 追加 S86–S88：资源租约——五路并发申请只有一个 winner、exclusive/shared 互斥矩阵、
  同会话幂等（不重复计数/不延长 TTL）、TTL 过期回收（读命令只读不改）、FIFO 排队与不插队、
  `collab_list` 显示本人持有/排队、`file:` 越界/绝对/软链拒绝、中文别名与路径写法归并、
  TTL 夹取、`reason` 清洗、`[protected]` 可持有但不可抢占、加锁不投递任何消息。
  0.3.1 追加 S89：闭环后追加的三条硬化——注入抛错不标记（下一轮仍提示）、无效路径条目不标记且
  `collab_list` 只汇总一次、`./docs/issues/x.md` 归一化后可渲染（`..`/绝对/软链仍拒）。
  0.4.0 追加 S90–S92：受保护目标请求队列（`confirm:false` 零写入、0 次 prompt、
  `[protected]` 与 `[protected-child]` 各 1 行只读提示且只提示一次、注入抛错不 stamp、
  每次 ≤3 行、队列满 50 条未读拒新（已读项不占名额，7 天后回收）、仅发起方可 `revoke`、
  `collab_list` 的待处理 / 已读视图）、
  `expected:"research"`（枚举 + 接管文案 + `explore`+`implement` 的能力不匹配提示）、
  同工作区 `collab_broadcast` 按 `realpath` 拒绝且零写入。
  0.4.1 追加 S93：受保护注入按提案去重（任一 `issuePath`/`bid` 键相同即同一提案、含传递，追加提示与
  `[owner-queue]` 行只渲染 `at` 最新的一条、两类合计 ≤3 行；被去重掉的条目不标记、下一轮仍提示；
  不同提案各占一行；同 bid 的队列项与追加（哪怕队列项不带路径）同样合并）。
- `test/readonly-default.mjs`：R8 只读默认（默认拒绝 grant/promote、消息仍可用、
  `allowWrite:true` 正向对照、内置护栏不可被配置移除）。
- `test/snapshot-shape.mjs`：侧栏只读快照（注入 reader，不碰真实 `~/.config`）——
  过期租约在视图里是 `free` 且不落盘、无人的空记录不出现、已决交接不算「未闭环」、
  `{ workspace }` 过滤、RPC 契约为 portable、`dist/gui-experimental.cjs` 只 require 宿主提供的模块。

源码结构：`src/core`（存储/领取/打分/回执/血缘/上报/挂起/租约/队列/侧栏快照）、`src/tools`（十六个工具）、
`src/hooks`（context 注入）、`src/config.ts`、`src/rpc.ts`（`collab.state` 契约）、
`src/gui.tsx`（`./gui-experimental`：Panel + ComposerPill，只在 `setup` 里跑）、
`src/index.ts`（`Plugin.define` 等价装配 + `ctx.rpc.register`）、
`scripts/collab-triage.mjs`（维护方 triage，零依赖）。

## Skill（给 agent 的操作手册）

`skills/collab/SKILL.md` — 按需加载：工具速查、交接模板、权限/升级、排障清单。
`skills/collab-coordination/SKILL.md` — 同工作区共享资源（测试窗口/同文件/构建）的锁与让行规程。
本机安装：`ln -s "$PWD/skills/collab" ~/.config/opencode/skills/collab`。

## 遇到异常（缺陷上报）

`0.1.3` 起**自动收集并上报**：工具执行中抛出非参数校验类异常（未捕获异常 / 护栏与指令冲突 /
投递 5xx / 提取失败）时，插件把现场写到
`~/.config/opencode/collab-reports/<signature>/<ts>.{json,md}`，配了 `report.to` 时再投一条
`note` 给维护方会话。参数校验错误（空 `text`、非法 `bid`、未知目标）与正常业务拒绝
（`protect` 拦截、租约过期、等待超时）**不上报**。

**你不需要读文档**：错误文案末尾、`collab_list` 最后一行、插件 `setup` 日志都能看到入口。

```text
提示: 若怀疑是插件缺陷，运行 collab_report { confirm:true } 上报现场（或看 ~/.config/opencode/collab-reports）
```

- 自动上报同签名 **1 小时最多 1 条**（60 分钟内重复触发只提示、不再写文件）；
- 手动补一条：`collab_report { note: "回执被 protect 拒绝，bid=b_…", bid: "b_…", confirm: true }`
  （`confirm:false` 只预览签名与目录）；
- 证据是**字段白名单**：版本、工具、分类、错误名与消息（≤2KB）、stack 前 5 帧、短 id、工作区、
  记录状态快照、时间戳；**不含**正文全文、文件内容、token（敏感串替换为 `[redacted]`）；
- 目录可用 `COLLAB_REPORT_DIR` 覆盖。
- 维护方消费：`node scripts/collab-triage.mjs --dry-run` 先看，去掉 `--dry-run` 生成
  `docs/issues/bugs-collab-<sig>.md`（幂等、文件锁）；cron 示例：

```cron
*/15 * * * * cd /data/project/collab && node scripts/collab-triage.mjs --notify collab-maintainer >> /tmp/collab-triage.log 2>&1
```

> `--notify` 需要 `COLLAB_SERVER_URL`（+ 可选 `COLLAB_SERVER_TOKEN`）才能真的补投；
> 目标命中 `protect` 时只落盘。目录/细节见 `docs/collab.md` §11.8 与 `skills/collab/SKILL.md` §六点五。

## 许可

MPL-2.0
