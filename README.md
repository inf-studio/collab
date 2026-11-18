# `@inf-studio/collab`

多会话（含跨工作区）协作插件：十七个原生 `collab_*` 工具（含缺陷上报、闭环后追加、资源租约、受保护目标请求队列
与 spawn 会话自动归档）+ thread/inbox 协议 + 一条「广播 → 打分 → 原子领取 → 回执」的交接链路。

由 `.opencode/plugins/collab.js`（单文件 4000+ 行）迁移而来：行为、文案、存储键、
`bid` 算法与单文件版逐字一致，差别只有「可选类型 + 模块边界 + 默认只读」三点。

- 零运行时依赖：只用 Node 内置模块；宿主能力全部走插件 `ctx`（进程内），**不发 HTTP**
  （不猜端口、不读 token）。宿主契约按用到的字段本地声明，入口用 `@opencode/plugin` 的
  `Plugin.Plugin` 做一次签名对齐（type-only，构建后即可移除）。
- 构建产物：`dist/index.js`（ESM）+ `dist/index.d.ts`，可被 `opencode plugin add` 识别。
- 另有**可选**的两个只读视图（server 部分完全不依赖它们）：
  `dist/gui-experimental.cjs`（`./gui-experimental`，Desktop 侧栏 + composer pill + 命令 + 会话头计数条）与
  `dist/tui.js`（`./tui`，TUI 的 `collab.status` 面板 + 可展开的侧栏摘要）。

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
| `collab_archive`   | 归档/恢复某个会话（**不是删除**）：`PATCH { archived }`，会话与消息保留；spawn 会话在交接终态 10 分钟后自动归档（可 `archiveSpawned:false` 关闭） | 写会话归档位      |

另有一个 `context` hook：把「未读消息 + 未闭环交接 + 挂起提醒」各注入一次（≤ `maxInject` 条、
单条 ≤200 字），不改历史、不影响别的会话；同一句话不会重复注入。
受保护会话的注入面是白名单：只有「闭环后追加」与「`[owner-queue]` 未读队列项」两类只读行
（每条一次，不含指令、不产生投递；两类合计 ≤3 行，同一提案只渲染 `at` 最新的一条）。

> **权限提示（务必读）**：本插件可以**读取该实例上的会话元信息与消息上下文**（用于打分与
> 判断回执）、可以**向其它会话投递消息**（即以该实例的身份说话）、在 `allowWrite:true`
> 时可以**修改某个会话的 permissions / agent**。默认 `allowWrite:false`，第二项（投递）是插件本职、
> 不在此开关内，第三项关闭。
> 另有一种**独立写入**：`collab_archive` 写会话的**归档位**（`PATCH { archived }`，从列表隐藏，
> 会话与消息全部保留、可 `restore:true` 恢复）。它**不受 `allowWrite` 约束**——自动路径只碰本插件
> 自己 spawn 的会话，手动路径必须 `confirm:true` 且 `[protected*]` 一律拒绝；要彻底关掉用
> `archiveSpawned:false`（只关自动路径）。归档**不是删除**：归档路径不调用 `DELETE`。

## 状态视图（Desktop 侧栏 / TUI，experimental）

两个**只读**视图，问的是同一件事：「谁持有资源 / 谁在排队 / 哪些交接没闭环 / 我给受保护会话排了哪些请求」。
数据都来自插件 server 部分的 `collab.state.snapshot`（RPC），与 `collab_locks` / `collab_list`
**同一读取层**，没有第二份状态。

| 客户端 | 入口 | 说明 |
| --- | --- | --- |
| **Desktop**（图形窗口） | ① 命令面板里的 **`collab.open`**「打开协作面板」（默认键 `mod+shift+l`，`/collab`）；② 会话头部**常驻计数条** `锁 N · 交接 M · 队列 K`（点一下开面板）；③ 标题栏 **`collab` pill**（常驻；有会话点开面板，无会话弹「已加载」toast）；④ 侧栏 `collab` 标签 / 侧栏 **+** 菜单 | `./gui-experimental` 的 GUI 部件。`options.autoOpen:false` 可关掉侧栏标签自启（命令、计数条、pill 与 **+** 菜单仍在） |
| **TUI**（终端） | `/collab`（快捷键 `ctrl+shift+l`，也在命令面板里）；侧栏摘要行**点击**展开 | `./tui` 部件。打开 `session.panel` 里的 `collab.status` 面板；侧栏一行 `锁 N · 交接 M · 队列 K`，点 `▸`/`▾` 行展开最多 4 行明细，点明细行开面板 |
| Web / 其它客户端 | 没有视图 | 用 `collab_locks` / `collab_list` 的文本视图 |

| 位置 | 内容 |
| --- | --- |
| GUI 侧栏 `collab` 面板 | 按工作区分组：会话（title / agent / busy）、持有租约（模式 + 剩余 TTL）、FIFO 排队、未闭环交接（`bid` / state / age） |
| GUI composer pill | 当前会话「锁 N · 等待 M」；`success` = 只持有，`warning` = 排第 1 位，`danger` = 排在别人后面 |
| GUI 会话头计数条 | `锁 N · 交接 M · 队列 K`（muted，不撑高标题行），点一下开面板；**没有快照时不占位**（不显示 `0 · 0 · 0`），server 不可达时 `collab: n/a` 且仍可点 |
| GUI 标题栏 pill（0.5.2） | 常驻一行：没有快照时就是 `collab`（**不显示 `0`**），有快照时 `collab N`（N = 租约 + 未闭环交接 + 本会话队列）。**有路由会话**→ 点开面板；**没有会话**→ 弹「Collab GUI 已加载」toast（带插件版本、面板 key、app 版本与 platform）——这是「窗口到底加载了 GUI 没有」的自证 |
| TUI `collab.status` 面板 | 三块等宽表格：资源租约（resource / mode / holders / 剩余 TTL / waiters）、未闭环交接（bid / state / age / from）、受保护目标队列（queueId / target / age / status）。窄终端每项拆两行 |
| TUI 侧栏摘要 | 一行 `锁 N · 交接 M · 队列 K`（`▸` 折叠 / `▾` 展开）；RPC 不可达时 `collab: n/a`。展开最多 4 行明细（锁 → 交接 → 队列）+ `+N`，明细行点击开面板 |
| 刷新 | GUI：有会话挂载时每 2 s 一次（面板、pill、计数条共用**同一个**轮询与 store）。TUI：面板打开时每 2 s 一次，**关闭即停**；侧栏展开/折叠只渲染已有快照，**不新增轮询** |
| 不可达 | GUI / TUI 都显示「不可达：<原因>」并保留上一份快照；TUI 一份快照都没有时退化为「宿主会话列表 + 仅显示本地会话」——不白屏也不崩 |

- **只读**：两个面板都没有加锁/释放按钮。取锁、排队、释放仍然只有 `collab_lock` / `collab_unlock`
  两个工具（以及 skill 里的规程）——状态面板点错不该改变别的会话能做什么。0.5.1 的命令与计数条、
  0.5.2 的标题栏 pill 同样只有一个动作：**打开面板**（pill 在无会话时还多一个 **toast**，仍是只读）。
- **鼠标不可用时 TUI 仍能进**：`/collab` 与 `ctrl+shift+l` 始终有效；宿主把侧栏固定成一行高度时展开内容
  会被裁掉（不崩溃），此时就是靠这两个入口。见 `docs/collab.md` §11.11.3。
- **可关闭**：Settings → Extensions → Plugins 里本插件的开关；关掉视图不影响 server 部分的工具。
- TUI 部件依赖宿主的 `@opentui/core` / `@opentui/solid` / `solid-js`（`peerDependencies`，optional）；
  老宿主不加载 `./tui` 时 server 与 GUI 都不受影响。

### Desktop 看不到 collab？四步排查

结论先行：**远端服务器是否加载 GUI 目前尚未确认**。「插件行没有 GUI 开关 / 界面里没有 collab」可能是
远端窗口没加载 GUI bundle，也可能是平台侧的显示差异——下面四步只负责把「加载了没有」问清楚，
不是平台缺陷的结论。

```text
1) 插件行有没有 GUI 开关？   Settings → Extensions → Plugins → collab
   → 有开关：关掉只影响视图，工具仍在；没有开关：先按 2)–4) 自证是否加载
2) 命令面板搜「collab」      → 有 collab.open「打开协作面板」说明命令已注册
3) 标题栏有没有 `collab` pill？（0.5.2 新增，常驻；无数据时就是 `collab`，不显示 0）
4) 点 pill（或 /collab、mod+shift+l）而当前没有打开会话
   → 弹「Collab GUI 已加载」toast = GUI 确实加载了（问题只是「没有会话可开面板」）
   → 什么都不弹 = 这个窗口没加载本插件的 GUI
```

先确认 server 侧没问题的命令：

```text
opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"   # 列表里应有 collab，且没有 failed
```

远端部署（Desktop 连 Linux server）时 GUI bundle 由 server 提供：`GET /api/plugin/gui?id=collab`
返回 `dist/gui-experimental.cjs`。这条请求 200 但窗口里没标签 = 0.4.1 及更早的**入口判定死锁**
（`undefined !== 'closed'` 被当成「已打开」，于是既无标签也无 + 菜单入口），0.4.2 已修；
请求本身 404/500 = 插件没加载或产物缺失，先修 server 侧。它 200 且第 4 步的 toast 也弹了 = 本插件的
GUI 端到端可用，剩下的差异在窗口/客户端侧，需要另行确认（见 `docs/collab.md` §11.11.4）。

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
  "archiveSpawned": true,
  "archiveGraceMs": 600000,
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
| `archiveSpawned` | `true`             | 交接终态后自动归档 spawn 会话（**不是删除**，可 `collab_archive {restore:true}`）；`false` 只关自动路径 |
| `archiveGraceMs` | `600000`           | 终态后的防抖窗口（1 分钟–1 小时），夹取                                                           |
| `aliases`        | `{}`               | 别名表：`collab_send {target:"schema"}`                                                            |
| `report.to`      | 未配置             | 缺陷上报的**主通道**：别名或 `ses_…`，插件把证据摘要当 `note`（`queue`）投给它；未配置只落盘 |
| `report.enabled` | `true`             | `false` = 关闭投递（仍落盘），回滚开关                                                             |

`protect` 与 `readonlyAgents` 都是**累加**的：内置项（schema 会话、长驻主线会话、
`explore`/`plan`）永远生效，配置文件只能加、不能减。

## 版本兼容

| 包版本  | OpenCode | Node      | 说明                                              |
| ------- | -------- | --------- | ------------------------------------------------- |
| `0.5.x` | `2.3.x`  | `>=22.18` | 只加**只读入口**：**0.5.2** 修 R-7（切会话时在飞的请求会吞掉重载，`queue` 最多滞留 2 s 旧会话数字）+ 新增标题栏 `collab` pill 探针（无会话点击弹「已加载」toast）；0.5.1 新增 Desktop `collab.open` 命令（`mod+shift+l` / `/collab`）+ 会话头计数条（`session.header`）+ TUI 侧栏摘要点击展开/折叠；0.5.0 新增 spawn 会话自动归档。契约 / 工具 / RPC 形状不变 |
| `0.4.x` | `2.3.x`  | `>=22.18` | 新增 `collab_request_owner`（受保护目标请求队列，pull 模型）+ `expected:"research"`；同工作区 `collab_broadcast` 改为拒绝（用 `collab_handoff`）；0.4.1 受保护注入按提案去重（追加提示与队列行合计 ≤3 行、只显示最新一条）；**0.4.2** 修复 GUI 首启看不到侧栏（入口判定死锁）+ 新增 TUI 状态视图（`./tui`，`/collab`）+ 快照增加 `queue`（本人提交给受保护会话的请求） |
| `0.3.x` | `2.3.x`  | `>=22.18` | 新增**只读**桌面侧栏（`./gui-experimental`，experimental API）；工具与存储不变 |
| `0.2.x` | `2.3.x`  | `>=22.18` | 新增资源租约（`collab_lock` / `collab_unlock` / `collab_locks`）；其余与 0.1.x 等价 |
| `0.1.x` | `2.3.x`  | `>=22.18` | 与单文件版行为等价；`@opencode/plugin` 由宿主提供 |

宿主插件契约（`ctx.location / storage / session / tool / event / rpc`）只按用到的字段声明，
老宿主缺 `session.update` / `switchAgent` 时对应能力报可读错误而不是崩（也可配
`COLLAB_SERVER_URL` 走 HTTP fallback，默认不猜端口）。构建需要 `pnpm-workspace.yaml` 的
`allowBuilds: esbuild`（pnpm 12 的构建脚本白名单）。宿主的 `ctx.rpc` 缺失时只跳过视图注册
（日志 `rpc skipped`），工具照常工作。

> 两个视图用的都是宿主 **experimental** API：GUI 走 `@opencode/plugin/gui`（`vite.gui.config.ts`），
> TUI 走 `@opencode/plugin/tui` + `@opentui/solid`（`vite.tui.config.ts`）。
> `@opentui/core` / `@opentui/solid` / `solid-js` 只是 **optional peer**（宿主自己提供，构建时用
> 本地 devDependency）；server 产物 `dist/index.js` 仍然零运行时依赖。

## 开发

```bash
pnpm --filter=@inf-studio/collab build       # vp pack → dist/，再 GUI / TUI 两个 vite 构建
pnpm install
pnpm typecheck
pnpm test          # build + 638 项 harness + 12 项只读默认 + 35 项快照/产物 + 29 项 TUI 渲染 + 39 项 GUI 入口
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
  0.5.0 追加 S94：spawn 会话归档——终态 + 10 分钟防抖 + idle + 非 protected + 无未决引用 + 无未读队列 →
  归档一次并写 `archivedAt`；六类拒绝（非 spawn / 非终态 / 防抖未满 / busy / protected / 有引用）加未读队列、
  抛错、幂等各一条；`restore:true` 还原并清 `archivedAt`；宿主无 `session.update` 时走 HTTP `PATCH`；
  `archiveSpawned:false` 只关自动路径；`collab_list` 的 `[archived]`。
- `test/readonly-default.mjs`：R8 只读默认（默认拒绝 grant/promote、消息仍可用、
  `allowWrite:true` 正向对照、内置护栏不可被配置移除）。
- `test/snapshot-shape.mjs`：侧栏只读快照（注入 reader，不碰真实 `~/.config`）——
  过期租约在视图里是 `free` 且不落盘、无人的空记录不出现、已决交接不算「未闭环」、
  `{ workspace }` 过滤、`{ session }` 只列本人排队项（撤回/别人的不出现）、RPC 契约为 portable、
  两个产物的构建规则（GUI 只 require 宿主模块；TUI 只 import 宿主模块、无写路径）、
  GUI 首启判定与 `autoOpen` 规则。
- `test/tui-render.mjs`：TUI 部件**无头渲染**（`@opentui/solid` 的 `testRender` + 假宿主 context，
  需 `node --conditions=browser`，否则 solid-js 解析到 SSR 构建）——`/collab` 注册、三块表格内容、
  不可达时的横幅 + 宿主会话列表、切到别的插件面板不轮询、轮询开启/停止/恢复、侧栏摘要一行；
  0.5.1 追加侧栏**真实鼠标事件**：折叠 1 行（`▸`）→ 点击展开 `▾` + 4 行明细 → 点明细行开面板 →
  再点折叠；`+N` 溢出标记；空快照与 `panel.open` 失败的降级；展开前后 `load()` 次数不变。
- `test/gui-entry.mjs`：Desktop 入口（**直接 require 构建产物** `dist/gui-experimental.cjs`，
  需 `node --conditions=browser` + 一个只提供 `addEventListener` 的 `document` 垫片，因为 bundle 在
  加载期注册 Solid 的事件委托）——`Panel` / `MenuItem` / `ComposerPill` 未回退，`Command` 的
  id / `mod+shift+l` / `/collab` / `navigation` / `enabled` / `run → layout.open("collab:main")`，
  `Slot(session.header)` 的 `at` 与渲染函数，两个 locale 的 `command.*` / `header.*` 键，
  以及「严格 context」证明入口只用 `add/t/layout/app/toast/sessions/client`（无写路径、注册时零 RPC）；
  打开会话后仍只有 **1 次**轮询且带 `session`（`队列` 不是契约默认的空数组 0）。
  0.5.2 追加：标题栏 pill（无快照 `collab` / 有快照 `collab 6` / 有会话点开面板 / 无会话只弹 toast、
  `layout.open` 0 次）、命令与 pill 共用**同一条** toast 文案、三处版本号一致（`package.json` /
  `PLUGIN_VERSION` / toast），以及 R-7 的慢 RPC（250 ms）三例：请求在飞时切会话→旧包落库后**立即**
  补一次且 `session` 为新会话；未切换仍每 tick 1 次；`document.hidden` 期间不补排。

源码结构：`src/core`（存储/领取/打分/回执/血缘/上报/挂起/租约/队列/归档/侧栏快照）、`src/tools`（十七个工具）、
`src/hooks`（context 注入）、`src/config.ts`、`src/rpc.ts`（`collab.state` 契约）、
`src/gui.tsx`（`./gui-experimental`：Panel + ComposerPill + 命令 + `session.header` 计数条 + 标题栏 pill 探针，只在 `setup` 里跑）、
`src/tui.tsx`（`./tui`：`collab.status` 面板 + 可展开的侧栏摘要 + `/collab` 命令，只读）、
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
