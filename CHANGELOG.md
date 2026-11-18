# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.5.0] - 2026-11-18

> 现象：`collab_broadcast` 在没人可接时拉起的 bootstrap 会话（`claim.kind="spawn"`）只为一单而存在，
> 那单闭环后仍一直占着会话列表与侧栏。owner 的决定是**归档**而不是删除：
> `PATCH /api/session/{id} { archived:true }` 从列表隐藏，会话与消息全部保留，`archived:false` 原样恢复。
> 本版新增自动归档判定 + `collab_archive` 手动工具；工具语义（handoff / lease / protected）不变，
> 归档路径**不调用** `DELETE /api/session/{id}`（`selftest` 清理与 spawn 落点回滚仍用 `session.remove`）。

### Added

- **R1–R3 自动归档（`src/core/archive.ts`）**：`shouldArchive(record, now, gate)` 按八条顺序判定——
  ① 目标是本插件拉起的会话（`claim.kind="spawn"` → `claim.by`；spawn 租约过期后才被领取、
  `claim.kind` 已改写成 `accept` 的 → `expiredClaim.by`）；② 终态 `done|blocked|expired`；③ 终态已过
  `archiveGraceMs`（**默认 10 分钟**，范围 1min–1h，越界夹取）；④ 目标 `session.get` 可读且 **idle**；
  ⑤ 非 `[protected*]`（按血缘）；⑥ 该 sid 不被任何**未决**交接引用（`from.sid` 或 `claim.by`）；
  ⑦ 没有未读 owner-queue 项；⑧ 记录还没有 `archivedAt`（幂等）。
  `archiveSession` 优先 `ctx.session.update({archived})`，宿主无 `update` 时走
  `COLLAB_SERVER_URL` 的 `PATCH /api/session/{id}`（带 `COLLAB_SERVER_TOKEN`）；**失败只 log，不抛、不改状态**。
  成功后才写 `archivedAt`（`mergeArchive`：读-合并-写，不覆盖并发字段）。触发点是 `chain.refresh()` ——
  发起方的 `context` 刷新，无 cron、无轮询；`collab_list` / 侧栏快照只读，**不触发**归档。
- **R4 `collab_archive { bid?, session?, restore?, confirm }`**：`bid` → 该单**拉起的** spawn 会话（`claim.by`，spawn 租约过期后才被领取的取 `expiredClaim.by`；非 spawn 单直接报错），`session` 可直指任意会话；
  `restore:true` → `archived:false` 并清 `archivedAt`；`confirm:false` 只预览（目标 / 标题 / 当前状态 / 动作）；
  `[protected*]` 拒绝；手动路径**跳过**自动判定的门（人说了算），但同样幂等（已归档不重复 PATCH）。
- **R5 配置**：`archiveSpawned`（默认 `true`；`false` 只关自动路径）、`archiveGraceMs`（默认 `600000`）。
- **R6 可见性**：`collab_list` 的会话 `state` 列显示 `archived` 并标 `[archived]`（记录行尾同样标）；
  `collab.state.snapshot` 的 `handoffs[]` 增可选 `archived?: boolean`（只读，不改变布局）。

### 文档

- `docs/collab.md`：§11.2 工具表 **十七个** + `collab_archive` 行；§11.4 配置示例 +
  `archiveSpawned` / `archiveGraceMs`；**新增 §11.13「协作结束后自动归档 spawn 会话」**（归档 ≠ 删除、
  `/api/session?archived` 可查、恢复命令、回滚开关）；§12.2 记录字段补 `archivedAt`；§12.5 新增第 17 条。
- README：能力表 + 配置表 + 回归清单（S94）；`skills/collab` 速查表 + §一点七。

### 回归

- `test/handoff-harness.mjs` **608 → 638 项**：新增 S94 —— 终态 + 11min + idle + 无引用 → 归档一次并写
  `archivedAt`（`state`/`receipt` 不变）；非 spawn / 非终态 / 防抖未满（30s）/ busy / protected /
  有未决引用 / 有未读队列 七类均不归档；`update` 抛错不抛且不写；二次刷新不重复 PATCH；
  `restore:true` 还原并清 `archivedAt`、未归档时恢复是 no-op；`[protected*]` 手动拒绝；
  `archiveSpawned:false` 只关自动路径；宿主无 `update` 时 HTTP `PATCH` 带 token；
  `collab_list` 的 `[archived]`；工具描述写明「archive is not delete」；
  spawn 租约过期后才被领取的孤儿（`expiredClaim`）仍会被归档、`collab_archive { bid }` 解析它而非接手人、
  非 spawn 单按 `bid` 归档是**可读拒绝**并提示改用 `session`。
- `test/snapshot-shape.mjs` **33 → 35 项**：归档行带 `archived:true` 且仍在列表里；schema 声明可选 `archived`。
- `test/readonly-default.mjs`：工具注册表 16 → 17（含 `collab_archive`）。
- 既有 608 + 12 + 33 + 17 全绿（现为 638 + 12 + 35 + 17）。

## [0.4.2] - 2026-11-18

> 现象：Desktop（远程连 Linux server）看不到 `collab` 侧栏；TUI 完全没有状态视图。
> 远端 `GET /api/plugin/gui?id=collab` 实测能返回 `dist/gui-experimental.cjs`，所以 server 侧能力齐备——
> 问题在 GUI 的**首启判定死锁**：首次进入会话时 `layout.state` 是 `undefined`，
> `undefined !== 'closed'` 为真 → 「+」菜单认为面板已打开、不再列入，而 `list` 只在打开时返回标签
> → **没有标签、没有入口**，面板永远打不开。本版只改视图层（+ 快照多一个只读 `queue` 字段），
> 工具语义、存储结构、权限模型全部不变。

### Fixed

- **R1 GUI 入口判定**：`opened` 由 `layout.state(...) !== 'closed'` 改为 `=== 'open'`
  （`undefined` / `closed` 都算未打开），「+」菜单重新提供「打开协作面板」。
- **R2 GUI 默认可见**：`list` 在 `options.autoOpen !== false`（默认 `true`）时恒返回 `collab` 标签，
  首次进入会话就能看到；`autoOpen:false` 回到「只从 + 菜单打开」的旧行为。
- **R3 GUI 不可达占位**：默认展示 + RPC 被 reject 时显示「server 不可达：<原因>」并保留上一份快照
  （既有行为，本版补回归）。

### Added

- **R4–R7 TUI 状态视图（`./tui` → `dist/tui.js`）**：`Plugin.define({ id:'collab.tui' })`。
  `/collab`（快捷键 `ctrl+shift+l`，命令面板同样可见）打开 `session.panel` 里的 `collab.status` 面板：
  资源租约（resource / mode / holders / 剩余 TTL / waiters）、未闭环交接（bid / state / age / from）、
  受保护目标队列（queueId / target / age / status），窄终端每项拆两行；`sidebar.content` 追加一行
  `锁 N · 交接 M · 队列 K`。
  - 数据只走 `collab.state.snapshot`（TUI `ctx.client` 可连远端 server），与 `collab_locks` / `collab_list`
    同一读取层；2s 轮询**只在本插件的面板是打开的那个时**运行（切走/关闭即停），一句 `onCleanup` 清定时器。
  - RPC 不可用：有旧快照 → 横幅 + 旧数据；一份都没有 → 横幅 + 「仅显示本地会话列表」+ 宿主会话列表，
    不白屏、不崩。
  - **只读**：面板没有任何写路径（无加锁/释放/撤回按钮）。
  - 打包：`exports["./tui"] = "./dist/tui.js"`，`peerDependencies` 增
    `@opentui/core >=0.6.6`、`@opentui/solid >=0.6.6`、`solid-js >=1.9.0`（均 optional）；
    `vite.tui.config.ts` 用 `generate:'universal'` + `moduleName:'@opentui/solid'`，把
    `@opencode/*` / `@opentui/*` / `solid-js` 全部 external。
- **RPC `queue` 字段（快照的只读扩展）**：`collab.state.snapshot({ workspace?, session? })` 新增
  `queue: [{ queueId, target, ageMs, summary, issuePath?, bid?, seen }]`，来源 `mineFor(session)`——
  就是 `collab_list` 里「我提交给受保护会话的请求」那一块。不传 `session` 返回空数组（不扫全表）。
  旧客户端忽略该字段；旧 server 不返回时客户端按空数组处理。

### 文档

- README：侧栏章节改为「状态视图（Desktop 侧栏 / TUI）」——GUI 仅图形客户端、TUI 用 `/collab`、
  远端 GUI 由 `GET /api/plugin/gui?id=<plugin>` 提供；新增「看不到侧栏 / 面板？三步排查」。
- `docs/collab.md` §11.11 重写：契约加 `queue`、GUI/TUI 两张 UI 表、两个产物的构建规则、
  §11.11.1「GUI 首启看不到侧栏（0.4.2 修复）」、§11.11.2 排查三步（插件列表 → 开关 → 入口）。

### 回归

- `test/snapshot-shape.mjs` **18 → 33 项**：`{ session }` 只列本人排队项（撤回/别人的不出现、`seen` 标记、
  最旧优先）、无 queue reader 的 source 返回空数组、input 的 `session`、schema 的 `queue` 与行字段、
  `dist/tui.js` 存在且只 import 宿主模块、TUI 无写路径、`exports["./tui"]` 与 peers、
  GUI 首启判定（源码 + 产物）。
- 新增 `test/tui-render.mjs` **17 项**：`@opentui/solid` 的无头 `testRender` + 假宿主 context
  （`node --conditions=browser`，否则 solid-js 解析到 SSR 构建、effect 是 no-op）——
  `/collab` 注册、三块表格内容、不可达时的横幅 + 宿主会话列表、切到别的插件面板**不轮询**、
  轮询开启/停止/恢复、侧栏摘要一行、不可达摘要 `collab: n/a`。
- `pnpm test` 现在 = **608 + 12 + 33 + 17**。

## [0.4.1] - 2026-11-18

> 来源：std-ui 承接方对 0.2.0 的实测（`t_mwls3zbk_9ac9`）——同一提案既可用 `collab_followup`
> （登记追加）也可用 `collab_request_owner`（队列），两者在受保护会话的 `context` 注入里**各占一行**，
> 指向同一份提案 → 重复轰炸。只改**渲染层**与工具说明：队列/followUps 的存储结构、权限模型、
> handoff/lease 语义都不变。

### Fixed

- **R1 受保护注入按提案去重**：`chain.injectionFor` 先把 §11.9.3 的追加提示与 §11.12 的
  `[owner-queue]` 行合并为候选（每条带 `at` / `bid` / `issuePath` / 行文本 / 待标记键），
  再按**提案键集合**去重——每个候选登记它带的全部键（`path:<规范化路径>`、`bid:<bid>`，可同时有），
  **任一键相同即同一提案**且传递生效（A 与 B 同路径、B 与 C 同 bid → A/B/C 一组）；组内
  **保留 `at` 最新的一条**（同一毫秒内 `followUp` 优先）；两个键都没有的条目不参与合并。
  去重后按 `at` 升序取前 **3** 行——两类提示**合计** ≤3（旧口径为追加 ≤1 + 队列 ≤3，共可到 4 行）。
- **R2 去重项不标记**：`keys` / `ownerQueue` 只包含**实际渲染**的条目，`context` hook 仍然只在
  `event.system.push` 成功后写 `seenAt` / followUp key；被去重掉的条目保持待读，下一次请求仍会提示
  （不是静默丢弃）。

### Changed

- **R3 工具说明**：`collab_request_owner` 补「broadcast 的候选池**排除** `[protected*]`，因此触达受保护
  会话只有本工具排队、或它自己 pull 提案/提示两条路」，并说明同一提案只渲染一行；`collab_followup`
  补「同一提案若已用 `collab_request_owner` 提交，不必再登记 followUp（渲染层按提案去重，只显示最新一条）」。

### 文档

- `docs/collab.md`：新增 §11.12.1「两类提示的去重规则」（去重键 / 保留哪条 / ≤3 合计 / 只标记渲染项 /
  仅渲染层），§11.9.3 与 §11.12 的提示口径同步；`skills/collab` 补一句「已排队就不必再登记 followUp」。

### 回归

- `test/handoff-harness.mjs` 新增 **S93（26 项）**：同提案「队列较新」→ 1 行取队列、被去重的 followUp
  不 stamp 且下一轮渲染；同提案「追加较新」→ 1 行取追加、队列项不 stamp 且下一轮渲染；4 个不同提案 →
  首轮 3 行（最旧优先）、次轮 1 行；两条队列项指向同一提案 → 1 行（取新）+ 旧的下一轮仍提示；
  **只带 `bid` 的队列项**（`collab_request_owner { bid }`）与同 bid 的追加 → 1 行取新；同 bid 的一条带路径
  一条不带 → 1 行；`path` 链 + `bid` 链的传递分组（A–B 同路径、B–C 同 bid）→ 1 行且按新到旧逐轮放出；
  两个工具的描述含去重/broadcast 排除 protected 的说明。`pnpm test` 现在 = **608 + 12 + 18**。

## [0.4.0] - 2026-11-18

> 缺陷 `d_6180f4ab4fb4368a`（muke-pos-app CLI 线，0.3.1）的三条成立项：D1 受保护目标没有合规
> 送达路径、D3 `expected` 缺只读排查、D4 同工作区还能调 `collab_broadcast`。D2（预览落盘）经核实
> **不成立**，未改。`BUILTIN_PROTECT` 与血缘判定**完全不变**：新增的队列是 **pull**，不是投递。

### Added

- **D1 `collab_request_owner`（受保护目标请求队列）**：唯一合规的「给 owner 送请求」路径。
  只允许「非受保护 → `[protected]` / `[protected-child]`」（受保护会话不能投、也不做 protected →
  protected 转发；普通目标一律拒绝并提示改用 `collab_handoff`）。写入
  `~/.config/opencode/collab-owner-queue/<targetSid>/<queueId>.json`
  （`{id,target,from,at,summary,issuePath,bid,revokedAt,seenAt}`，`q_<base36ts>_<rand4>`，
  `tmp + rename`，每目标上限 **50 条未读**、满则拒新而不驱逐；已读项不计入上限并在 7 天后回收）。`summary` 去控制字符 / 合并空白 / ≤500；
  `issuePath` 只做**语法**校验（相对、`docs/issues/<name>.md`、无 `..`/绝对路径，不读 fs）。
  `confirm:false` 只预览、**零写入**；写入本身 **0 条 prompt**、不建 bid/thread、不改任何协作状态。
  `COLLAB_OWNER_QUEUE_DIR` 可覆盖目录（harness 用）。
- **D1 只读提示**：受保护会话（含 `[protected-child]`）在自己的 `context` 注入里看到未读队列项，
  每次 **≤3 行**、按 `at` 升序、每条只提示一次：
  `- [owner-queue] <from 短 id> @ <HH:MM>：<summary 截断 120>（<issuePath 或 ->）`。
  不含任何指令、不要求回复、不产生投递。`seenAt` 在 `event.system.push` **成功之后**才写
  （沿用 0.3.1 的 F1 规则：注入抛错 → 不标记，下一轮重试）。
- **D1 发起方视图**：`collab_list` 追加「我提交给受保护会话的请求：N 条待处理」+ ≤3 行明细
  （`queueId` → 目标短 id / 时间 / 摘要）+ `…还有 N 条`；`collab_request_owner { id, revoke:true, confirm:true }`
  可撤回（**仅发起方**，可省略 `target`；`confirm:false` 只预览）。
- **D3 `expected:"research"`**：`normalizeExpected` 接受三值（`implement` / `review` / `research`）；
  接管文案（`takeoverBody` / `handoffActions`，push 与 pull 两版）在 `research` 时改成
  「只读排查，不要改代码；结论写进最后一条回复并用回执发出」；匹配分对 `research` 不再偏向
  `explore`（`build` 同样合法）。

### Changed

- **D4 同工作区 `collab_broadcast` 拒绝**：`realpath(workspace) === realpath(ctx.location.directory)` 时
  抛可读错误并提示 `collab_handoff { text }`（预览同样拒绝），**不写任何记录**。比较用 `realpath`，
  所以 `./ws` / `ws/` / 指向同目录的软链都算同一个工作区。
- **D3 能力不匹配可见**：承接方是只读 agent（`explore` / `plan`）而 `expected:"implement"` 时，
  `collab_broadcast`（预览 / spawn / 结果）与 `collab_handoff`（预览 / 结果）都会追加
  「承接方为只读 agent，implement 期望可能无法完成；建议 `expected:"research"` 或先 `collab_promote`」。

### Fixed

- 受保护会话的注入面补上了「外界真的有话要说」的合法形态：此前只有「闭环后追加」一种 pull，
  合规的跨线排查请求只能退化为「广播拉起 explore → BLOCKED」。现在多了一类只读队列提示，
  其它交接类注入仍然不可见。

### 回归

- `test/handoff-harness.mjs` 新增 **S90–S92（56 项）**：预览零写入、写入 0 prompt / 0 bid / 0 thread、
  summary 清洗与 500 上限、`issuePath` 语法校验、方向拒绝（受保护发起方 / 非保护目标 / 目标为
  `[protected-child]` 合法）、队列满 50 条未读拒新（已读项不占名额、7 天后回收）、`[protected]` 与 `[protected-child]` 各 1 行只读提示且只提示
  一次、注入抛错不 stamp（下一轮重试）、每次 ≤3 行、仅发起方可 revoke（含 id-only 形式）、
  `collab_list` 待处理视图、`research` 枚举/文案/接管行、`explore`+`implement` 的能力不匹配提示、
  同工作区广播按 `realpath`（含软链写法）拒绝且零写入。S30 同步改为断言 D4 的拒绝。
  `pnpm test` 现在 = **582 + 12 + 18**。

### 文档

- `docs/collab.md`：新增 §11.12「受保护目标请求队列」；§11.2 工具表（十六个）+ `expected` 三值 +
  能力不匹配；§11.4 / §11.4.1 的白名单说明；§12.3 的 research 文案与同仓拒绝；§12.5 新增限制 15/16。
- `skills/collab`：新增 §一点六（受保护目标只能排队）、工具表行、排障两行；`skills/collab-coordination`
  补一句「广播只用于跨工作区 / 受保护目标走队列」。README：工具表、版本兼容表、回归说明、`pnpm test` 数字。

## [0.3.1] - 2026-11-18

> 复核补丁：std-ui 承接方对 0.2.0 的只读复核（H1–H5 5/5 落实）提出 3 条 followUps 硬化。
> 只改「闭环后追加」这条 pull 通道的**投递时机**与**失败可见性**，不放宽任何越界/软链拒绝，
> 不改 `followUps` 结构字段、不改 handoff / lease 语义。

### Fixed

- **F1 提示先标记、后投递 → 注入成功才标记**：`chain.followUpHints` 改为**纯查询**
  （返回 `{ lines, keys }`，不再自己 `markFollowUpSeen`）；`context` hook 在
  `event.system.push(...)` **成功之后**才标记 keys。注入抛错（宿主异常 / 块没接住）→ 不标记，
  下一次请求自然重试。旧行为是「先标记后投递」，等于一次没有投递确认的 at-most-once，
  提示会永久丢失。
- **F2 无效路径静默丢弃 → 不标记 + 汇总可见**：路径校验失败的 entry 不再进入 keys（不 stamp），
  因此提案被归档/移动、或 `docs/issues` 变成软链后不再「一次性静默丢弃」；`collab_list` 汇总
  「N 条 followUp 因路径无效未渲染」（同一会话按无效条目集合去重，集合变化才再提示一次，
  条目只显示 `bid` + 时间、不回显路径文本）；`collab_followup` 的返回也会提示本单已有的无效条数。
  另外，写入时只含空白/控制字符的 `issuePath` 现在**直接报错**，不再静默回退到记录自带的提案。
- **F3 `./docs/issues/x.md` 被拒 → 先规范化**：`validateIssuePath` 改为先拆段、丢空段与 `.`、
  合并重复 `/`，再判定边界；只拒 `..` 与绝对路径。软链仍拒（`lstat` + `realpath` 前缀校验不变）。
- 无效路径的 entry 不再占用「每会话每轮 ≤1 行」的提示位——同一单的有效追加照常渲染。

### Added

- 回归 S89（`test/handoff-harness.mjs`，20 项）：注入抛错不标记（下轮仍提示）、
  无效路径不标记 + `collab_list` 只提示一次 + 修好路径后恢复提示、`./docs/issues/x.md`
  可渲染并归一化存储、`../x` / 绝对路径 / 软链仍拒。`pnpm test` 现在 = 526 + 12 + 18。

### Changed

- 文档：`docs/collab.md` §11.9.3（标记时机 / 无效路径 / 路径规范化）与 §12.5 #13；
  `collab_followup` 的工具描述与表格行同步。

## [0.3.0] - 2026-11-18

> 只读侧边栏：同工作区并行会话不再靠 `ps` 或反复 `collab_locks` 猜「窗口在谁手里」。
> OpenCode Desktop 侧栏直接看到「谁持有资源 / 谁在排队 / 哪些交接没闭环」，
> composer 上还有一枚本会话的「锁 N · 等待 M」。
> **没有新增写入能力**：面板只显示，取锁/释放仍走 `collab_lock` / `collab_unlock`。

### Added

- **R1 出口 `./gui-experimental`**：`dist/gui-experimental.cjs`（单文件 CJS，13 KB）。
  `vite.gui.config.ts` 用宿主 `@opencode/plugin/gui/vite` 的 `gui()` preset：编译 Solid JSX、
  内联动态 `import()`、把宿主提供的模块（`effect` / `@opencode/plugin/gui` / `@opencode/plugin/rpc` /
  `solid-js` / `solid-js/store` / `solid-js/web`）留作 external。`pnpm build` = `vp pack` + `vp build -c vite.gui.config.ts`。
- **R1 RPC 契约** `src/rpc.ts`：`collab.state.snapshot({ workspace? })` → `{ at, reachable, sessions[], locks[], handoffs[] }`。
  server 侧在 `setup` 里 `ctx.rpc.register(...)`；契约用 `satisfies Rpc.PortableDefinition` 的纯 JSON Schema
  字面量声明（`import type` 即擦除），所以 `dist/index.js` 仍是**零运行时依赖**。
- **R2 侧栏面板** `Panel { id:"collab", region:"side", width:"narrow" }`：按工作区分组列出会话
  （title / agent / busy / 当前会话）、持有租约（模式 + 剩余 TTL + `[我]`）、FIFO 排队、未闭环交接
  （`bid` / state / age / title）。租约是全局的，按「第一个已列会话的持有者/排队者」归组，否则落「全局」。
  侧栏 **+** 菜单加了一条「打开协作面板」launcher，关掉后可以找回。
- **R3 composer pill**：当前会话「锁 N · 等待 M」；`success` 只持有、`warning` 排第 1 位、
  `danger` 排在更后面。展开是逐条租约（只显示，不带任何操作）。
- **R4 实时性**：有会话挂载时每 2 s 拉一次快照（面板在屏幕上时），面板与 pill 共用一个 store / 一个轮询；
  RPC reject（server 停 / 插件禁用 / 版本不匹配）→ 顶部「server 不可达：<原因>」并**保留上一份快照**，
  不空白、不崩。
- **R5 只读**：`buildSnapshot` 只调 `stateOf()` / `allBroadcasts()`，不写文件、不回收租约、不叫醒排队者；
  面板与 pill 没有任何加锁/释放入口。
- **R6 兼容**：`ctx.rpc` 缺失（老宿主）只跳过侧栏注册（日志 `rpc skipped`），工具与 context hook 照常；
  GUI 构建失败不影响 `dist/index.js`；Settings → Extensions → Plugins 可单独关闭 GUI。
- 测试：`test/snapshot-shape.mjs`（18 项）——过期租约在视图里是 `free` 且不落盘、空记录不出现、
  已决交接不算未闭环、`{ workspace }` 过滤、契约字段齐全、GUI 产物只 require 宿主模块。
  `pnpm test` 现在 = 506 + 12 + 18。

### Changed

- devDependencies 增 `vite`（指向 `@voidzero-dev/vite-plus-core`，与 `vite-plus` 的别名对齐）、
  `vite-plugin-solid`、`solid-js`；新增 `vite.gui.config.ts`。
- `tsconfig.json` 增 `jsx: preserve` / `jsxImportSource: solid-js`，`include` 收 `src/**/*.tsx` 与
  `vite.gui.config.ts`（`pnpm typecheck` 现在也检查 GUI）。
- 新增 `pnpm-workspace.yaml`（`allowBuilds: esbuild: true`）：pnpm 12 把构建脚本白名单放到这里，
  否则 `pnpm install` 以 `ERR_PNPM_IGNORED_BUILDS` 退出。只是安装期声明，不影响产物。

### Notes

- GUI API 在宿主侧标注 **experimental**：`@opencode/plugin` 的 `./gui` / `./gui/vite` 形状可能变，
  本包按 `2.3.x` 实现（README 有版本区间表）。
- 面板只在 Desktop 出现；TUI / Web 用 `collab_locks` / `collab_list` 文本视图。

## [0.2.0] - 2026-11-18

> 复核修复：等待队列满（50）不再驱逐队首，改为拒绝新申请；`expiresAt` 缺失/≤0 的损坏记录会被回收（`reason:"invalid"`）。

> 数据驱动：同工作区并行会话为**共享资源**（pytest 窗口 / 同一文件 / 全量构建）反复协商——
> 排钟专题占窗口 10+ 分钟，加载未实施 issues 的会话两次请求未获释放，最后只能 `ps` 猜。
> 0.2.0 把这件事变成可判定的**资源租约**：机器判互斥、TTL 自动回收、FIFO 排队，且不投递、不打断。

### Added

- **R1 两种模式**：`exclusive`（默认）与任何模式互斥；`shared` 之间可共存（只读共享）。
- **R2 原子申请**：全局目录 `~/.config/opencode/collab-locks/<sha256(resource)[0..16]>__<slug>.json`
  （`COLLAB_LOCK_DIR` 可覆盖）+ `open(<file>.lock, "wx")` 短锁（2s 超时、崩溃遗留清理）包住
  「读 → 判定 → `tmp+rename` 写」；并发申请同一 exclusive 资源只有一个 winner，其余立即拿到
  「持有者 + 剩余 TTL」。
- **R3 租约与排队**：`ttlMs` 默认 15min、夹在 `[10s, 2h]`；`expiresAt` 过期在下次访问时回收并写
  `history: expire`；同一会话重复申请**幂等**（返回既有租约，不重复计数、不延长 TTL）；
  `wait:true` 按 FIFO 入队并返回排位，重复 `wait` 保留原申请时间。
- **R4 状态机**：`free → held → queued → expired`，与 handoff（`open/claimed/acked/done/blocked/expired`）
  **完全分离**，只共享只读视图 `stateOf()`（`{resource, kind, mode, holders, ttlMs, expiresIn, waiters, mine}`）。
- **R5 可见性**：新工具 `collab_locks { resource? }`（只读，不改状态/不回收/不叫醒排队者）；
  `collab_list` 追加本会话「持有 / 排队中（第 N 位）」。
- **R6 资源规范化**：`test-window` / `窗口` / `测试窗口` / `窗口:测试` → `named:test-window`；
  `build` / `全量构建` → `named:build`；`file:` 与裸相对路径归并为 `file:<相对路径>`。
  `file:` 拒绝绝对路径、`..`/`.`、软链，`realpath` 必须仍在 workspace 内；尚未创建的文件允许
  （最近存在祖先须在 workspace 内）。
- 新工具 `collab_lock { resource, mode?, ttlMs?, reason?, wait?, confirm }` 与
  `collab_unlock { resource, confirm }`；两者 `confirm:true` 才写，否则只预览当前持有与将写入字段。

### Security

- `[protected*]` 会话**可持有**租约，冲突输出标 `[protected]` 且注明「不可抢占」；
  `collab_unlock` 只有持有者能调，**不提供 force**——抢占是人工决定。
- `reason` 去控制字符、单行、≤200 字；`mode` 只接受 `exclusive|shared`；资源名 ≤300 字。
- 锁是纯本地状态：**不投递任何消息**、不打断会话、不替代 git 操作；它只服务自愿协调。

### Changed

- 工具面 12 → 15（`registerTools` 末尾追加 `collab_lock` / `collab_unlock` / `collab_locks`）；
  `PLUGIN_VERSION` / `package.json` → `0.2.0`。
- `skills/collab-coordination` 的「消息协商」升级为 `collab_lock` 机器判定（保留 `collab_send` 降级路径）。
- `docs/collab.md` 新增 §11.10「资源租约」；README 工具表/测试计数同步。

### Tests

- harness 456 → 498（S86 并发/模式矩阵/幂等；S87 TTL 回收、只读列表、FIFO 排队、`collab_list` 可见性；
  S88 别名归并、`file:` 边界、TTL 夹取、`reason` 清洗、protected 持有不可抢占、零投递）。
- `test/readonly-default.mjs` 12 项，工具面断言更新为 14 个 `collab_*` + `collab_report`。

## [0.1.7] - 2026-11-18

### Added

- `skills/collab-coordination/SKILL.md`：同工作区共享资源（测试窗口 / 同一文件 / 全量构建）的「查看占用 → 申请 → 等待或让行 → 释放 → 超时升级」规程，含死锁避免与 `collab_*` 不可用时的降级路径。
  来源：排钟专题与「加载全部未实施 issues」两个会话为 pytest 窗口反复协商的实证。

## [0.1.6] - 2026-11-18

> 数据驱动：本机 50 会话、5 忙；常驻会话 900h+，单轮可达数十分钟，单会话 token 峰值 5774 万。
> 「对方这一轮跑完 = 送达」太晚也不可靠，盲目重投又会把同一件事排两次队。因此送达拆成两级、
> 重发严格受限、闭环后的补充结论改成**拉取**。

### Added

- **R1 两级送达确认（ack）**：接管请求/回执的投递写 `record.delivery`
  （`cid` / `to` / `messageId` / `admittedAt`）；收方插件第一次把这条消息注入 `context` 或
  被 `collab_inbox` 读到时，回一条 `[ack] <cid> seen`（`kind:note` + `queue`，旁路、失败不影响收方流程、
  同一 `cid` 只回一次）；发方事件流解析后写 `delivery.seenAt`。`[ack]` 自身不再产生 ack（防环），
  `collab_inbox` 把它标 `system-ack`，`context` 注入不展示。伪造的 `[ack]`（不是 `delivery.to` 那个会话）
  会被忽略。
- **R3 可见性**：`collab_list` / `collab_wait` 每条交接显示
  `admitted=<age> seen=<age> queue-age=<age> resend=<n> unacked=<yes|->`；`unacked` 的单在
  `collab_list` 里单独一行「未确认送达 … → 可人工补投」。
- **R5 闭环后追加（pull）**：新工具
  `collab_followup { bid, issuePath?, confirm }` —— 只有该单 `claim.by` 可调、只有 `done`/`blocked` 可调，
  只往 `record.followUps[]` 追加结构 `{ bid, issuePath, at, by }`（**不存正文**，每单 ≤3 条），
  **不投递、不改 state/receipt、不重开 bid**。结论本身写进提案文件
  （`## 闭环后追加（<date>）`）；发起方（含受保护线）在自己的 `context` 注入里看到**一行只读提示**
  「`- b_xxx 已闭环，提案 <path> 有追加结论（<ts>），请读取文件`」——只含路径与时间，不含正文/指令。

### Fixed

- **ack 竞态会丢掉 `seenAt`（复核 F1）**：`ackSeen` 在 `await session.prompt(…)` 之后用**进入循环前**的
  记录快照整条写回；若发方的 `applyAck` 在这段 await 期间写入 `delivery.seenAt`，会被这次写回覆盖
  （`ackSentAt/ackSentBy` 在、`seenAt` 丢）→ 2h 后多余重发 → 再 2h 变 `unacked`。
  现在所有「await 之后写 `delivery`」的地方（`ackSeen` / `resendOnce` / `resendIfDue` / `deliverAsk`）
  统一走新增的 `mergeDelivery(bid, patch)`：**先重读**当前记录、只合并本次字段
  （`state`/`receipt`/`followUps`/`claim` 与其它并发写入保持原样；被 7 天保留策略删除的记录不复活）。

### Changed

- **重发受限（R2）**：只由**发方**自己的 `context` 注入评估；条件为
  `admission 失败` 或 `2h 内没有 seen` 且 **目标当时 idle**，且 `resends < 1`；同 `cid` 幂等
  （收方按 `cid` 去重，重发不会变成第二条消息）。**busy 目标永不重发**（它已握着消息）。
  预算用满、窗口又过、仍无 ack → `unacked`。
- **受保护发起方（R4）**：往 protect 线投递本就受限，`seen` 不可能回来 → 记录标
  `delivery.ackUnavailable`，不重试、不报错，回执继续走 pull / 提案文件。
- **受保护会话的注入窄化为白名单**：`injectionFor` 原先对 protect 线直接返回空，现在**只多返回**
  上面那条只读 follow-up 提示（条件：`record.from.sid === 自己` 且存在未提示的追加）；不是放开注入，
  是单独函数产出、单独分支返回，任何消息正文/回执指令都进不去。
- `collab_followup` 的 `issuePath` 校验与 `collab_broadcast` 一致：必须 realpath 落在该记录 workspace 的
  `docs/issues/<name>.md`，拒绝 `..`、绝对路径、软链、非 `.md`；控制字符/换行剔除、上限 200 字。
  校验失败 → 写入口拒绝，渲染时**整行不渲染**（不做降级拼接）。去重粒度是 `(sid, bid, at)`，
  所以同一单的第二条追加会在下一次注入里再提示一次；每次注入 ≤1 行。
- 旧记录（≤0.1.5，无 `delivery`）视为「已 admitted、无 ack 能力」，**永不重发**；旧收方不认 `[ack]`
  只意味着发方收不到 `seen`，不影响投递。

### Regression

- `test/handoff-harness.mjs` 新增 **S83**（ack：本地交接写 admission、收方注入 → `[ack] <cid> seen`
  （note+queue，独立 cid）、发方写 `seenAt`、同一 cid 只 ack 一次、旁观者伪造 ack 无效、
  `collab_list` 与 `collab_wait` 的 admitted/seen/queue-age 行、busy 目标不误判不重发、
  受保护发起方 `ackUnavailable` 且零投递、**ack 在 prompt await 期间落地时不被写回覆盖**
  （复核 F1：`seenAt` 与 `ackSentAt` 并存、之后不重发））、**S84**（重发：idle 目标 2h 无 seen →
  恰好 1 次同 cid 投递、预算用尽不再投、同 cid 只落一条 inbox、admission 失败立即重试 1 次、
  问询已顺延的单不会重投给旧目标、`unacked` 在 `collab_list` 单独一行可人工补投）、
  **S85**（闭环后追加：预览不写、非 claim.by/旁观者/未闭环拒绝、只追加结构化字段、
  state 与 receipt 不变、受保护发起方看到一次性只读提示、两条追加各提示一次、
  非法路径（`..`/绝对/越界/缺失/软链/非 md/自由文本）全部拒绝或整行不渲染、每单第 4 条拒绝、
  以及 `kind:reply`/`note` 仍无法 push 进受保护发起方）。
- S72 的 `staleClass` 边界用例改为显式传入时钟（原来 1ms 抖动会导致偶发失败）。
- 合计 **456 项 harness + 12 项只读默认**；`build` / `typecheck` / `check:skill` 通过。

## [0.1.5] - 2026-11-18

> **0.1.4 在 OpenCode CLI 2.3.x 上无法安装**（`No matching version found for @opencode/util@2.3.2`），
> 请直接使用 0.1.5；若已升级到 0.1.4 导致 `collab_*` 工具消失，把配置改回 `0.1.3` 并 `opencode reload` 即可恢复。

### Fixed

- `@opencode/plugin` 仅用于 `import type`，从 `dependencies` 移到 `devDependencies`：
  发布包不再在安装期解析 `@opencode/*` 运行依赖。

## [0.1.4] - 2026-11-18

> **升级顺序（重要）**：显式 `kind:"note"/"request"` 不再由正文触发状态迁移（R7）。混版本期间，
> 仍跑 ≤0.1.3 的会话其行为与 0.1.4 不一致；请把所有常驻会话升级到 0.1.4（见 docs/collab.md 「版本与重载」）。

### Fixed

- **遗留单永远无法闭环**（缺陷上报 `d_e4e7ae824f551d0f`，实例 `b_bdae848832cd51fb`）：
  0.1.1 及更早的接管请求让承接方发
  `collab_send {target:"<requester>", text:"[handoff] DONE <bid> <摘要>"}`，**不带 `kind`** →
  默认 `request` → 0.1.2 的限界 reply 白名单不适用 → 被 protect 护栏拒绝，3 次回执全部失败，
  而受保护发起方也不会自动触发 pull 提取。现在：
  - **R1 兼容遗留回执**：`canReplyToProtected` 在 `requestedKind = "request"` 时也放行，但必须
    ① 正文含 `[handoff]` 且其中的 `bid`（或入参 `bid`）等于该记录、② `record.from.sid === target`、
    ③ `record.claim.by === sender`、④ 记录未 `done`/`blocked`/`expired`；放行后仍按 `kind=reply`
    投递并强制 `queue`。`note`、显式 `kind:"request"`、`mode:"steer"` 一律 fail-closed。
  - **R2 可操作报错**：被 protect 拒绝、且命中「三条件 + 正文含 `[handoff] <bid>`」时，错误文案追加
    `提示：这是遗留回执，请加 kind:"reply" 重发（或让对端升级到 0.1.4+）：` 与可直接复制的
    `collab_send {… kind:"reply" …}` 命令。
- **正文嗅探误判面（R5–R7，安全评审核对后补）**：接管请求本身就含
  `[handoff] DONE <bid> <摘要>`，而准入与状态迁移共用一条宽松正则，引用模板即可关单。
  - **R5 行首锚定**：`HANDOFF_RECEIPT_RE` 改为 `/^[ \t]*\[handoff\][ \t]+(DONE|BLOCKED)[ \t]+(\S+)[ \t]*([^\n]*)/im`
    —— 正文中段的引用/讨论不再算回执，单独成行才算。
  - **R6 push 侧回声守卫**：`parseReceiptLine` 复用 pull 侧守卫——目标或摘要槽出现 `<bid>` /
    `<摘要>` / 任意 `<…>` 占位符不算；`DONE` 行自身含否定语（`未完成` / `无法完成` / `不会发` /
    `还没` / `not done yet` …）或计划语（`完成后我会` …）不算；只判命中行，不跨行拼接。
    （否定/计划守卫只作用于 `DONE`：`BLOCKED` 行本身就是否定答案，理由里的「无法完成」仍照常关单。）
  - **R7 显式意图优先**：入站消息**显式**声明 `kind=note|request` 时不再由正文触发状态迁移
    （`applyReceipt` 现在拿到入站 kind，只有 `kind` 缺省（legacy）或 `reply` 才允许）；
    `extractInbound` 记录 `kindExplicit`。出站限界白名单同样只在 `kind` 缺省或 `reply` 时生效。
  - **R8 可追溯**：记录 `receipt.source = "kind" | "body"`，triage 可区分「按 kind 回执」与
    「按正文识别的遗留回执」。

### Changed

- `collab_send` 描述补充遗留回执说明；放行时额外提示「遗留回执（0.1.1 及更早的命令不带 kind）
  已按 kind=reply 放行」。
- 既有回执用例（S28 / S30c / S36）的入站 `kind` 由 `note` 改为 `reply`：按 R7，`note` 不再迁移状态。

### Regression

- `test/handoff-harness.mjs` 新增 S81（13 项：无 kind 回执投递 + `state=done` 闭环 +
  `receipt.source=body` + note/显式 request/steer/普通 request/仅 bid/旁观者/错目标/错 bid/done 全拒 +
  报错含 `kind:"reply"` 命令）与 S82（17 项：中段引用、占位符、否定语、计划语不判定；`BLOCKED` 理由
  含「无法完成」仍关单；显式 note/request 不迁移；缺省 kind 与 `reply` 才迁移；行首正例；
  `receipt.source` 两种来源）。
  合计 **405 项 harness + 12 项只读默认**；`build` / `typecheck` / `check:skill` 通过。

## [0.1.3] - 2026-11-18

### Added

- **缺陷自上报（本次起支持）**：任何 `collab_*` 工具抛出**非参数校验类**异常（未捕获异常 / 内部不变量 /
  护栏与指令冲突 / 投递 5xx / 提取失败）时，插件把现场写到
  `~/.config/opencode/collab-reports/<signature>/<ts>.json` + 同名 `.md`（issue 草稿），
  并在配置了 `report.to` 时额外投一条 `note`（`queue`）给维护方会话。参数校验错误与正常业务拒绝
  （空 `text`、非法 `bid`、未知目标、`protect` 拦截、租约过期、等待超时）**不上报**。
- **证据白名单 + 脱敏（R2/R7）**：版本、工具、分类、错误名与消息（≤2KB）、stack 前 5 帧、短 id、
  工作区、记录状态快照、时间戳；**不含**正文全文、文件内容、token（`text` / `token` 输入与长 token
  形状的串替换为 `[redacted]`）。`COLLAB_REPORT_DIR` 可覆盖目录。
- **去重限流（R4）**：`signature = hash(version + tool + errorName + 归一化 message)`，
  同签名每 1 小时最多 1 条；`index.json` 以 `tmp + rename` 写入。
- **配置**：`collab.json` 新增 `report: { to?: "<alias|ses_…>", enabled?: boolean }`；
  目标命中 `protect`（含血缘）或未配置时只落盘。
- **`collab_report { note?, bid?, threadID?, confirm }`**：手工补一条现场（`confirm:false` 只预览），
  同签名 1 小时内幂等；不改变任何协作状态。
- **挂起监控（R6）**：`collab_list` 与 `context` 注入各输出一次
  `open-stale`（open >1h）/ `claimed-lapsed`（超租约）/ `acked-stale`（acked >2h），
  按 `(session, class, bid)` 去重（存储键 `collab/stale-seen/<sid>`，跨命令/重启共享）。
- **维护方消费端（R9）**：`scripts/collab-triage.mjs`（零依赖）——扫报告目录、按 signature 归并、
  生成/刷新 `docs/issues/bugs-collab-<sig>.md`、`triagedAt` 回写索引；`--dry-run` / `--since` /
  `--notify <alias|sid>`（经 `POST /api/session/{sid}/prompt`，需 `COLLAB_SERVER_URL`）；
  幂等 + `.triage.lock` 文件锁；cron 示例见 README（由 owner 决定是否安装）。
- **可发现性（R8）**：非校验类错误文案末尾追加 `collab_report` 入口；`collab_list` 末行固定入口；
  插件 `setup` 日志打印 `reportDir=` 与 `report.to` 是否配置；README / SKILL / `docs/collab.md` §11.8
  各有「遇到异常怎么办」；维护方会看到「未处理缺陷上报 N 条」（每会话一次）。

### Fixed（独立复核修复轮 F1–F4）

- **F1 `collab_wait` 漏报**：空闲等待的 `catch` 曾把宿主的任何失败都包成 `ValidationError`，
  于是「等待期宿主 5xx」（最像「卡住」的场景）既不落盘也无入口。现在只有**超时**保留为
  `ValidationError`（业务结果，不报）；`HTTP 5xx` → `delivery-5xx`，其它宿主异常 → `uncaught`，
  都照常上报，文案仍是可读的 `collab_wait 失败：…`。
- **F2 回执/ACCEPT 通知投递失败漏报**：`chain.notifyRequester` 的 `catch` 只返回
  `{delivered:false, reason}`；现在额外回传原始 `error`，`collab_accept` 的两个调用点用
  `reporter.reportNow({tool:'collab_accept', defect:'delivery-5xx', input:{bid}})` 旁路上报。
  返回给调用方的文案（`未通知发起方：…`）不变；受保护发起方/缺 sid 属预期，不上报。
- **F3 triage 缺目录误报并发**：报告目录不存在时 `open('wx')` 是 `ENOENT`（不是 `EEXIST`），
  旧逻辑打印「另一个 triage 正在运行」并空转。现在先 `mkdirSync(dir,{recursive:true})`，
  `ENOENT` 视为「目录缺失」重试一次；只有真正的 `EEXIST` 才算并发。
- **F4 上报 note 的 `fromSessionID` 不可回投**：投递 metadata 里的 `fromSessionID` 由短 id
  改为**完整 `ses_…`**（证据文件仍只存短 id，R2 不变），维护方可直接 `collab_send` 回投上报方。

### Changed

- 工具层所有「参数校验 / 正常业务拒绝」的抛出改为 `ValidationError`（旁路判定依据），
  错误文案不变；投递失败改抛 `DeliveryError`（文案前缀 `投递失败：`），分类为 `delivery-5xx`。
- `collab_list` 末尾新增固定上报入口行与（有积压时）未处理上报计数行。

### Regression

- `test/handoff-harness.mjs` 新增 S72–S80 共 65 项：异常→落盘一次 / 字段白名单 / 正文与 token 脱敏 /
  1h 限流 / 参数校验与护栏拒绝不上报 / `report.to` 收到一条 note / protected 只落盘 /
  `report.enabled:false` / `collab_report` 预览与幂等 / 三类挂起与跨命令去重 /
  triage 的 `--dry-run`、幂等、`--since`、`--notify`（含 protected 拒绝）。
  合计 **375 项 harness + 12 项只读默认**；`build` / `typecheck` / `check:skill` 通过。
- Harness 与只读默认用例现在都通过 `COLLAB_REPORT_DIR` / `COLLAB_CONFIG` 指向临时目录，
  不再读写真实 `~/.config/opencode/collab-*`。

## [0.1.2] - 2026-11-18

### Fixed

- **受保护发起方的回执死锁**（`docs/issues/bugs-protected-requester-receipt-undeliverable.md`，
  std-ui 提出，复核结论「部分成立」）：`scope=peer` 广播的发起方在 `protect` 名单内时，
  接管请求/`collab_accept` 仍要求承接方 `collab_send` 回执，而 `deliver()` 的血缘护栏对
  **所有** `kind` 拒绝投递到受保护目标——通知要求做一件被自己禁止的事，闭环只剩租约到期后的
  启发式提取。现在：
  - 广播创建时若发起方命中 `protectedAncestor`，记录写 `receiptMode:"pull"`；接管请求、
    `collab_accept`、`collab_broadcast` 结果与租约提醒改为「在本会话最后一条回复里写
    `[handoff] DONE|BLOCKED <bid> <摘要>`」，由发起方在租约到期后只读提取（`accept` 领取
    同样适用，不再只限 `spawn` 领取）。
  - **限界 reply**：`collab_send` / `collab_reply` 投递到受保护目标时，只有三条同时满足才放行
    ——`kind=reply`、目标是该 `bid` 的发起方（`record.from.sid`）、发送者是该单领取人
    （`record.claim.by`）；`bid` 取入参或正文里的 `b_…`。放行时强制 `queue` 并追加说明；
    `request` / `note` / `steer` 与其他来源仍 fail-closed，`BUILTIN_PROTECT` 名单不变。
  - 新增 `receiptMode` 字段（只增不改）；旧记录缺省视为 `push`，行为与文案不变。
  - **自动提取扩面（R7）**：租约到期后的只读提取不再限定 `claim.kind = spawn`，`accept` / `handoff`
    领取的单同样在**发起方**那次刷新里从承接方最后一条回答收口（仍只读最后一条、仍只有发起方能触发、
    受保护承接方不读）；结论词表补「回执被硬拒 / 无法投递 / 改回写提案 / 已自愈 / 无需改动」→ `blocked`，
    `done` 判定不变。此前这类单没有推送回执就只能一直挂着。
  - **`acked` 静默收口（R8）**：`acked` 没有租约路径，回执丢失时会永远停在 `acked`。现在静默超过
    `ACKED_EXTRACT_MS`（2h）后，发起方的刷新按同一套规则只读提取（仍只读最后一条、仍只有发起方能触发、
    受保护承接方不读）；判不出结论时**状态不变**（不降级、不 `attempts++`），只写 `staleNoticedAt`，
    每个窗口最多读一次。`collab_list` 对这类单额外标「静默=Nh 可自动提取」。
  - 回归：`test/handoff-harness.mjs` 新增 S69 共 23 项（pull 文案 / 字段落盘 / pull 提取闭环 /
    reply 白名单正反例 / 提醒文案）、S70 共 6 项（accept/handoff 收口 / 无结论走原顺延 /
    受保护承接方不读不闭环 / 旁观者不闭环）与 S71 共 6 项（acked 2h+ 收口 / 无结论保持不变且
    每窗口只读一次 / 1h 不读 / 旁观者不读 / protected 不读）。
  - 复核收尾：限界 reply 对**已闭环**（`done`/`blocked`/`expired`）的单不再放行；`acked` 提取要求
    `claim.at > 0`（缺失时 `since=0` 会把很久以前的回答当结论）；回归 +3 项（共 310）。

## [0.1.1] - 2026-11-17

- 包可见性改为 public（`publishConfig.access`）
- 新增 `skills/collab/SKILL.md`（随包分发）与 CI frontmatter 校验

## [0.1.0] - 2026-11-17

首个版本：`@inf-studio/collab` 由仓库内单文件插件 `.opencode/plugins/collab.js`
迁移为独立 TS 包。工具签名、文案、状态机、存储键与 `bid` 算法保持不变。

### Added

- 十个原生工具：`collab_list` / `collab_inbox` / `collab_wait` / `collab_send` /
  `collab_reply` / `collab_handoff` / `collab_broadcast` / `collab_accept` /
  `collab_grant` / `collab_promote`。
- `context` hook：未读消息与未闭环交接各注入一次（去重，≤ `maxInject` 条）。
- 跨工作区交接链路：确定性打分（0–100 + `why`）、原子领取（`<bid>.lock`）、
  5 分钟问询租约与顺延、`DECLINE <bid>`、租约到期的只读自动闭环。
- 会话级权限补丁（`collab_grant`）与 agent 切换（`collab_promote`），共用一份
  `collab-grants/<sid>.json` 台账（两半互不覆盖，`revoke` / `revert` 各清一半）。
- 模块结构：`src/core`（storage / claim / score / verdict / lineage / grants）、
  `src/tools`、`src/hooks`、`src/config.ts`、`src/index.ts`。
- `test/handoff-harness.mjs`（279 项：单文件版的 274 项 + S68）、
  `test/readonly-default.mjs`（12 项只读默认/护栏）与
  `scripts/parity-single-file.mjs`（16 项双轨对比：十个工具的契约 + 五个预览输出逐字一致；
  单文件版退役后自动跳过）。

### Changed

- 插件 `options` 新增 `allowWrite`（默认 `false`）：新装包默认**只读**，不修改任何
  会话的 permissions / agent；消息、回执、收发、打分全部可用。单文件版无此开关
  （其行为等价于 `allowWrite:true`）。

### Fixed

- `collab_grant` 预览在台账**只有 promote 半段**（有 `agentBefore`、无 permissions
  快照）时崩溃：`TypeError: … reading 'join'`。现在按「无授权记录」报告，并说明
  确认授权时会补写 grant 半段、两半共存（回归用例 S68）。

### Notes

- 运行时零第三方依赖；`@opencode/plugin` 由宿主提供，`@opencode/client` 仅 `import type`。
- 存储格式与单文件版一致（`collab/*` 键、`~/.config/opencode/collab-broadcast/`、
  `collab-grants/`），切换加载方式无需迁移数据。
