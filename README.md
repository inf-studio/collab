# `@inf-studio/collab`

多会话（含跨工作区）协作插件：二十二个原生 `collab_*` 工具（含缺陷上报、闭环后追加、契约决策、资源租约、受保护目标请求队列、
即时状态回执、thread 聚合、加急催办、临时冻结与 spawn 会话自动归档）+ thread/inbox 协议 + 一条「广播 → 打分 → 原子领取 → 回执」的交接链路。

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
| `collab_list`      | 列可协作会话（id/agent/state/loc/title/parent/别名）+ 未闭环交接（有契约决策的单行尾 `decisions=N`） | 只读              |
| `collab_inbox`     | 本会话收到的跨会话消息全文（单条 ≤4000 字）                                | 只读              |
| `collab_wait`      | 等某 thread 的回执，或等某会话空闲                                         | 只读              |
| `collab_status`    | 一单现在到哪一步：state / 承接+剩余租约 / 投递（admitted/seen）/ 队列位置 / 最近回复 / 承接方报过的结构化 BLOCKED（需要对方 / 已排除 / 最小判别）/ 契约决策（`决策 N 条` + 最近 3 条）/ 下一步（非阻塞、零写入）；消息 thread（`collab_send`/`collab_reply` 建立）降级为 `kind=messages` + 出入站摘要，不再报错 | 只读              |
| `collab_threads`   | 与**一个** target 的全部 thread：threadID / kind（handoff\|messages）/ 状态 / 最近出入站摘要 / 建议继续哪个（默认只列未闭环，≤20 条） | 只读              |
| `collab_escalate` | 加急一单：默认 `delivery:steer` 进对方当前轮（只读 agent / 受保护目标自动降级：queue 或 owner-queue 项），回执打印**实际** delivery；只追加 `priority/urgentAt/urgentReason/urgentBy` | 发消息 / 写队列 |
| `collab_freeze`   | **临时冻结**一个会话（含子会话）/ 工作区 / 一单：`handoff`/`broadcast`/`accept`/`escalate` 对它的**新建**协作可读拒绝（0 写入），`until` 到期自动失效；通知一次（受保护目标 → urgent 队列项）；`freeze:false` 解冻；读取类只标 `[frozen]` | 写本地冻结文件 + 通知 |
| `collab_send`      | 往另一个会话投递消息（`queue` 默认，不打断）；`blocked?` = BLOCKED 结构化三段（正文之后，有 bid 时落库） | 发消息            |
| `collab_reply`     | 按 thread 自动路由的回执                                                   | 发消息            |
| `collab_handoff`   | 同工作区交接：选人（同一套打分）+ 打开 thread；`origin?` 记录转发链链头；`blocked?` 把「卡住了」的结构化三段交给下一跳 | 发消息            |
| `collab_broadcast` | 跨工作区交接：读提案 → 打分 → 写全局交接文件 → 只问 top-1 / 必要时拉新会话；`origin?` 缺省继承上一跳 | 发消息 + 可建会话 |
| `collab_accept`    | 原子领取广播（`<bid>.lock`，只有一个 winner）；**0.9.2 闸门**：本会话 `mission.outOfScope` 非空时**必须**带 `scopeCheck:{inScope,reason?}`（插件不做语义判断，只逼表态 + 记录 `collab-audit.jsonl`）；`inScope:false` → 拒绝并给 `handoffTo`，人类 `override:{reason,approvedBy}` 是唯一通道；`openTodos ≥ 8` 只加一行提醒 | 写交接记录        |
| `collab_request_owner` | 给**受保护**会话（`[protected]`/`[protected-child]`）排队一条请求：只写队列文件，目标下次运行时看到 ≤3 行只读提示（**不投递**、不建 bid/thread、`revoke` 仅发起方） | 写本地队列        |
| `collab_grant`     | 给**一个会话**追加 5 条 `collab_*` 会话级权限（`revoke` 还原快照）         | **写会话权限**    |
| `collab_promote`   | 把一个会话的 agent 切到 `build`/`plan`（`revert` 还原）                    | **写会话 agent**  |
| `collab_report`    | 上报疑似插件缺陷（证据脱敏落盘 + 可投递维护方，不改协作状态）              | 写本地证据        |
| `collab_followup`  | 闭环后追加指针（**仅本单领取人**；只写 `{bid,issuePath,at,by}`，提案文件由调用方自己写） | 写追加记录        |
| `collab_decisions` | 契约决策记录：把「退出码 2→3」这类**契约级决定**写进记录 `decisions[]`（仅本单发起方/承接方；同一 `id` 覆盖，每单 ≤20；**不投递、不改 state/claim/receipt/replies**） | 写交接记录（本单两方） |
| `collab_lock`      | 取资源租约（测试窗口/同一文件/构建；exclusive 或 shared，TTL 10s–2h，被占可 `wait` 排队） | 写本地租约        |
| `collab_unlock`    | 释放**自己**持有的租约（`shared` 组只移除自己；无 force 抢占）             | 写本地租约        |
| `collab_locks`     | 只读列出租约：持有者/模式/剩余 TTL/排队者（`collab_list` 也会显示本人持有/排队） | 只读              |
| `collab_archive`   | 归档/恢复某个会话（**不是删除**）：`PATCH { archived }`，会话与消息保留；spawn 会话在交接终态 10 分钟后自动归档（可 `archiveSpawned:false` 关闭） | 写会话归档位      |
| `collab_index`     | **消息历史 / 可重建索引（0.9.0）**：`stats` 只读看投影（12 表 + FTS5，行数/backend/大小/`backfilled`，不可用回 `[索引不可用]`）；`rebuild` 从 `collab-messages.jsonl` + `collab-*.json` 全量重建（锁 + tmp → fsync → 原子 rename，**幂等**，失败保留旧库）；`backfill` 只补状态级历史（不伪造正文）。快照 / `collab_status` / `collab_threads` 在投影**新鲜**时优先读它，否则回落 JSON | 读/写本地投影     |
| `collab_mission`  | **会话契约主线（0.9.1；0.9.3 三选一）**：`get` 只读（主线锚：会话指针 → 工作区唯一 `in_progress` 任务 → 空；不猜标题、不跑 python）；`set` 写一句话主线 / 任务路径 / 做·不做边界 / 转交对象；`confirm` **必填 `by`**、一次确认后**固定**，再改必须 `reconfirm:true` + `by`（自动推断永不覆盖人工确认）；**`resume {next}` / `block {on,reason}` / `done`** 是回答 `[drift]` 的唯一三个动作（`done` 要求已有 mainline next-up 待办） | 写本地契约        |
| `collab_progress` | **里程碑（0.9.1）**：`list` 只读；`add` 规划 `M1`…；`light` **必须给可校验 evidence**（`commit:` 已合入 HEAD / `file:<path>:<line>` / `test:<path>` / `decision:<id>`），无 evidence 或校验失败一律拒绝；点亮后 `plan.lastAdvancedAt` 推进、`noAdvanceTurns` 归零 | 写本地契约        |
| `collab_todo`     | **契约待办（0.9.1；0.9.3 唤醒条件）**：`add`（`blockingOn`=`me` 或 `ses_…`，可 `status:"doing"`）/ `close`（必填 evidence）/ `defer` / `suspend`（必填 `wakeWhen`：`{kind:"reply"|"decision"|"time"|"manual"}` 或自由文本）/ `list`；`[todo]` 注入每轮只列 top3 + 计数，挂起显示 `suspended(等 X)`、到期未醒转 `drifted`（不自动关闭），上一轮未动的 `doing` 标 `[未收尾]`；读侧保留全部 active、只裁关闭历史，id 单调不复用 | 写本地契约        |

0.9.0 起每条投递（`send` / `reply` / 接管请求 / 加急 / 冻结通知 / 回执通知 / ack / 受限重发 / 缺陷上报）
都会在 `~/.config/opencode/collab-messages.jsonl` 留一行全文信封，并投影到可随时删除重建的 `collab.db`。
投影只是缓存：读路径只在其 `synced_at` 不落后于任何源文件时使用，否则回落 JSON；删库不影响任何协作。
另有 `collab_index { action:"rebuild"|"backfill"|"stats" }` 维护它。

另有一个 `context` hook：把「未读消息 + 未闭环交接 + 挂起提醒」各注入一次（≤ `maxInject` 条、
单条 ≤200 字），不改历史、不影响别的会话；同一句话不会重复注入。

0.9.2 起协作层多一道**闸门**，但**插件不做语义判断**：本会话 `mission.outOfScope` 非空时，
`collab_accept` 必须自己表态 `scopeCheck:{ inScope, reason? }`——缺表态直接拒绝（文案给出两种可复制调用）；
`inScope:false` 拒绝接单并给 `handoffTo`，只有人类 `override:{ reason, approvedBy }`（`approvedBy` 不得以 `ses_` 开头）
能放行；`inScope:true` 正常接单。**每一次表态都写一行** `collab-audit.jsonl`
（`{at,sid,kind,bid,inScope,reason,verifiedBy,approvedBy?}`）。
`broadcast` / `handoff` 永不要求表态、永不拒绝（派活是清账手段），`reply` / `send` 不校验；
`openTodos ≥ 8` 只在返回末尾加一行 `[溢出提醒]`，不拦任何动作。
误伤/自证时把 `collab.json` 的 `gate` 改成 `"warn"`（只提示）或 `"off"`（完全跳过）即可即时降级。
**诚实边界：拦不住 bash 层跨仓写**，只拦协作动作。

0.9.1 起 hook 的**最前面**多一个**会话契约**块（每轮重新计算、**不写 `injected[]`**、硬上限 12 行）：
`[mission]`（一句话主线 / 边界 / 状态 / 推进时间，未确认标 `[未确认]`）→ `[todo]`（N open · M 需要你 ·
K 等对方 · 最老 T2 6.2h · 还有 N 条，随后 top3）→ `[drift]`（仅触发时出现：连续 5 轮无主线动作 /
主线挂起 > 2h / 挂起 24h 未醒 / 上次提醒未处置）→ `[progress]`（done/total · 下一里程碑需要 evidence）。
0.9.2 删掉了 `[scope]` 小节与它背后的关键词匹配：
边界只在 `[mission]` 作为声明展示，接单判断由会话自己的 `scopeCheck` 作出。
放不下的段落整段丢弃；`[未收尾]` 用「下一轮回溯」标记上一轮未更新的 `doing` 待办（插件没有 idle 钩子，
不承诺 idle 写入）。契约存 `~/.config/opencode/collab-contract/<sid>.json`，读路径惰性创建、写路径 tmp+rename。
0.9.3 的 `[drift]` 必须用 `collab_mission resume {next}` / `block {on,reason}` / `done`（要求已有 mainline
next-up 待办）之一回答，否则下一轮带 `[未处置]` 再来（`resume` 会顺手关掉旧的挂起/到期行）；挂起必须给 `wakeWhen`
（`{kind:"reply"|"decision"|"time"|"manual"}`），到期未醒转 `drifted`（不自动关闭）；
**`manual` 只表示没有自动触发源，仍受 24h 兜底**。计数含当前请求：无论是否刚推进过，
都是第 4 轮安静、第 5 轮出现 `[drift]`。
0.7.0 起它在**末尾**再追加一行只读的**自动感知**提示（每会话每 10 分钟最多一次、预算满时最先让位）：
`协作：本工作区候选 N（collab_handoff） · 其它工作区候选 M（collab_broadcast，需提案）`——
只给数量与通道，不猜「该找谁」；`awareness:"off"` 关闭。受保护会话拿不到这一行。

0.7.0 起交接记录还带一个可选的 **`origin`（对接人）**：A → B → C 时 C 的记录 `from` 只能是 B，
但 `origin` 写的是链头 A（B 不用手填，缺省从「本会话正在承接的未闭环交接」继承一层）。
承接方的注入 / 回执模板因此多一行 `对接人（非本单发起方）：ses_A @ <dir>`，阻塞时可把
`[handoff] DONE|BLOCKED b_…` **直接发给 A**：接收侧按 `kind=reply` 认这条回执，本单即闭环
（实测 4 跳 → 2 跳）；`collab_status` 显示 `origin=`、`collab_list` 行尾 `via ses_…`。
边界：只有本单**发起方或对接人**能让这条行闭环（发给第三方仍是普通 `request`），
且受保护投递规则不变（`origin` 指向 `[protected*]` 时照旧拒投）。没有 `origin` 的旧记录输出与 0.6.0
逐字一致；`origin` 本身不产生任何投递。
0.7.0 起 `collab_send` / `collab_handoff` 还有可选的 **`blocked`（结构化 BLOCKED）**：
`{ need?: string[], excluded?: string[], minimalTest?: string }`（≤10 / ≤20 / ≤200 字，条目 ≤120 字）。
三段落渲染在**投递正文之后**（`需要对方：① …` / `已排除：…` / `最小判别：…`），有可解析 `bid` 且你是本单参与方时
写进记录 `blocked[]`（保留最近 3 次），下一跳的承接方注入与 `collab_status` 聚合展示（各段 ≤3 条 + 「还有 N 条」）。
没有 bid / 预览（`confirm:false`）/ 非参与方 / 同文去重命中（未投递）→ 只上正文、回执注明「未落库」；超条数 / 超长是可读拒绝（0 投递 0 写入），
不传时输出与旧版**逐字一致**；`state` / `claim` / `receipt` 一律不动。

0.7.0 起 `collab_decisions` 把**契约级决定**写进交接记录（`decisions?: [{ id, decision, rationale?, at, by }]`）：
一次交付里 3 条偏差（退出码 2→3 / `room:order` 纯事件型 / 断言只看末帧）以前只能口头纠正、散在 3–4 个 thread 里，
现在落在记录上、只读可拉取。**只有本单发起方（`from.sid`）或承接方（`claim.by`）能写**（第三方拒绝且 0 写入，
比 `blocked` 更严）；`items` 1–10 条（`id` ≤40 / `decision` ≤200 / `rationale` ≤400 字），**同一 `id` 再写 = 覆盖**，
每单上限 20 条（超出可读拒绝，不静默淘汰），`confirm:false` 零写入预览。它**不投递、不改 `state` / `claim` /
`receipt` / `replies`**：`collab_status { bid }` 显示 `决策 N 条` + 最近 3 条，承接方注入只加一行
`本单决策 N 条（collab_status { bid:"…" } 查看）`，`collab_list` 行尾 ` decisions=N`。

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

两个视图，问的是同一件事：「谁持有资源 / 谁在排队 / 哪些交接没闭环 / 我给受保护会话排了哪些请求」。
数据都来自插件 server 部分的 `collab.state.snapshot`（RPC），与 `collab_locks` / `collab_list`
**同一读取层**，没有第二份状态。Desktop 的 GUI 走**当前会话所属服务器**的 client（0.5.3；远端会话读远端），
TUI 走宿主给它的 `ctx.client`。

> 0.8.0（`board2-actions`）：Desktop 面板右详情多一行**动作按钮**（加急 / 冻结 / 解冻 / 归档），每次点击
> **先确认**再调用 `collab.state.escalate|freeze|unfreeze|archive`（服务端复用工具同一份 core 实现，protected
> 拒绝、只读 agent 降级、冻结优先都在服务端强制），成功/失败只弹 toast，并追加一行
> `~/.config/opencode/collab-audit.jsonl`。`collab.json` 的 `boardActions:false` 只隐藏动作行（RPC 保留）；
> 没有 `ctx.dialogs` 的老窗口降级为「再点一次确认」。TUI 与所有读取视图仍然零写操作。

| 客户端 | 入口 | 说明 |
| --- | --- | --- |
| **Desktop**（图形窗口） | ① 命令面板里的 **`collab.open`**「打开协作面板」（默认键 `mod+shift+l`，`/collab`）；② 会话头部**常驻计数条** `持有 N · 排队 M · 待受保护 K · 宿主排队 J`（点一下开面板；口径见下）；③ 标题栏 **`collab` pill**（常驻；有会话点开面板，无会话弹「已加载」toast）；④ 侧栏 `collab` 标签 / 侧栏 **+** 菜单 | `./gui-experimental` 的 GUI 部件。`options.autoOpen:false` 可关掉侧栏标签自启（命令、计数条、pill 与 **+** 菜单仍在） |
| **TUI**（终端） | `/collab`（快捷键 `ctrl+shift+l`，也在命令面板里）；侧栏摘要行**点击**展开 | `./tui` 部件。打开 `session.panel` 里的 `collab.status` 面板；侧栏一行 `锁 N · 排 M · 待 K · 宿 J`，点 `▸`/`▾` 行展开最多 4 行明细，点明细行开面板 |
| Web / 其它客户端 | 没有视图 | 用 `collab_locks` / `collab_list` 的文本视图 |

| 位置 | 内容 |
| --- | --- |
| GUI 侧栏 `collab` 面板 | 0.8.0 **主从布局**：左列表 `320px` / 右详情 `1fr`，窄窗口（≤640px，`max-width:640px`）回落单栏（选中后详情替换列表 + 「← 返回列表」）。左列表仍是 0.6.0 的三层结构：工作区头（`N 会话 · M 锁 · K 交接 · A 已归档`）→ 会话行（agent + 徽标 `🔒n` / `‹m›` / `[archived]` / `[frozen]` / `[urgent]`）→ `已归档 N` 折叠段；无法归属的锁 / 交接 / 队列以 `· 未归属` 兜底。**点行 = 单选**（`›` 高亮），右详情自上而下是会话头（标题 / agent / 完整 sid / 徽标）→ 关系图 → 动作行（加急/冻结/解冻/归档，需确认）→ items（锁 / 交接 / owner 队列 / `↳` 拉起的会话）。选中与展开都是本地信号，2 s 轮询换快照不重置；选中的会话从快照消失才清空并 toast「该会话已不在快照中」 |
| GUI 关系图（0.8.0，0.8.2 起可缩放） | 右详情顶部的内联 SVG（无图库）：**L0** 未选中 = 工作区节点 + 跨工作区交接（同一对工作区合并为一条 `count`）；**L1** 选中工作区 = 本区会话 + 对端工作区占位节点（不展开对方，画虚线）；**L2** 选中会话 = 以它为中心 ±1 跳、最多 8 个节点（超出显示 `+N`）。点节点 = 选中（联动左列表与 items），节点角标 `▸/▾` 折叠一跳，悬停高亮相邻边；折叠/悬停只在本窗口内存，2 s 轮询不重置。派生来自 `src/core/graph.ts` 的 `buildGraph`，**与 TUI 同一份**（`handoff` 实线 / `origin` 虚线 / `spawn`·`subagent` 点线）。0.8.2：画布 **640×360**、中心 + 内环 ≤6 + 外环分层、标签截断 **8 字**且任意两盒不重叠（布局在 `src/core/graph-layout.ts`，纯函数）；**滚轮/双指缩放 0.6×–2.5×（以指针为中心）**、**空白处拖拽平移（越界拉回）**、**双击空白复位 1×**；缩放/平移只改 `viewBox`，节点几何与图数据不动，所以缩放后点节点/折叠仍准 |
| GUI 动作行（0.8.0） | 关系图下方四个按钮：`加急` / `冻结` / `解冻` / `归档`。加急先问理由（≤200 字）再确认；冻结默认 30 分钟；归档按钮为危险色。确认后才调 RPC，回执（成功或拒绝原因）用 toast 展示，成功后**刷新一次**快照（不新增轮询）。服务端门禁：protected 拒绝（加急 0 prompt / 0 队列、归档不 PATCH）、只读 agent 加急降级 `queue`、冻结中加急被拒。每次调用追加一行 `~/.config/opencode/collab-audit.jsonl`。`boardActions:false` 隐藏该行（RPC 仍可用）；无 `ctx.dialogs` 时降级为两步点击 |
| GUI composer pill | 当前会话「锁 N · 等待 M」；`success` = 只持有，`warning` = 排第 1 位，`danger` = 排在别人后面 |
| GUI 会话头计数条 | `持有 N · 排队 M · 待受保护 K · 宿主排队 J`（muted，不撑高标题行），点一下开面板；**没有快照时不占位**（不显示 `0 · 0 · 0`），server 不可达时 `collab: n/a` 且仍可点。四个数的口径见下方「四个数」 |
| GUI 标题栏 pill（0.5.2） | 常驻一行：没有快照时就是 `collab`（**不显示 `0`**），有快照时 `collab N`（N = 租约 + 未闭环交接 + 本会话队列）。**有路由会话**→ 点开面板；**没有会话**→ 弹「Collab GUI 已加载」toast（带插件版本、面板 key、app 版本、platform 与数据源 `server=`）——这是「窗口到底加载了 GUI 没有」的自证 |
| GUI 数据源（0.5.3） | **跟随会话所属服务器**：请求走 `ctx.sessions.current()?.server?.client`（远端会话 → 远端 server；没有 `server` 字段 → 回退 `ctx.client`）。跨服务器切换立即用新 server 的 client 重请求，上一台服务器的迟到回包**丢弃**；面板顶部在远端时显示 `@<server.id>`（本机不显示） |
| TUI `collab.status` 面板 | 首行四个数 + 一行图例（0.6.0），主体是与 GUI **同一份 `buildBoard`** 的三层树：工作区头 → 默认折叠的会话行（`🔒n` / `‹m›` / `[frozen]` / `[urgent]`）→ 展开后的锁 / 交接 / 队列 / `↳` 子会话；`已归档 N` 是末段，默认折叠。`j`/`k` 移动、`enter`/`space` 展开，鼠标点击行同样可展开。0.8.0：`j`/`k` 选中后树下方追加 3–5 行该会话详情（计数 + 锁/交接/队列/`↳`，超出 `… +N`），`esc` 清除；`enter`/`space`/点击仍只展开/收起；0.8.0 详情之后还有同一 `buildGraph` 的**文本树**（未选中 = L0 工作区 `─交接─▶`，选中 = L2 中心 `↳`/`┈agent┈▶`，窄宽度 `…` 截断） |
| TUI 侧栏摘要 | 一行 `锁 N · 排 M · 待 K · 宿 J`（持有 / 排队 / 待受保护 / 宿主排队；`▸` 折叠 / `▾` 展开）；RPC 不可达时 `collab: n/a`。展开最多 4 行明细（锁 → 交接 → 队列）+ `+N`，明细行点击开面板 |
| 刷新 | GUI：有会话挂载时每 2 s 一次（面板、pill、计数条共用**同一个**轮询与 store）。TUI：面板打开时每 2 s 一次，**关闭即停**；侧栏展开/折叠只渲染已有快照，**不新增轮询** |
| 不可达 | GUI / TUI 都显示「不可达：<原因>」并保留上一份快照；TUI 一份快照都没有时退化为「宿主会话列表 + 仅显示本地会话」——不白屏也不崩 |

**四个数**（0.6.0，GUI 会话头 / TUI 侧栏 / TUI 面板同一口径，`src/core/counts.ts`）：

| 数 | 含义 |
| --- | --- |
| 持有 | **有持有者**的资源数（`holders.length > 0`）；排队者不算，`free` 但有排队者的记录也不进这个数 |
| 排队 | 所有资源的 FIFO 排队人数之和（可能全是 `[stale]` 心跳过期者——它们不占位，下一次 `collab_lock` 回收） |
| 待受保护 | 本会话提交给受保护目标的请求条数（owner-queue；面板旧称「队列」） |
| 宿主排队 | 宿主自己的 prompt 队列（`delivery:"queue"`），来自宿主已同步数据，不是第二条 RPC |

`free` + `waiters=…` **不是被占用**：那只表示「没人持有、只是有人在排队」。排队者的 `at` 是**心跳**
（默认 10 分钟，`waiterTtlMs`）：心跳过期者在下一次 `collab_lock` 被回收，`collab_locks` 只显示
`sid#pos:mode(age)` 与 `[stale]`（读命令从不写文件）。`collab_send` / `collab_reply` 另外有正文去重：
同一 **target**（或同一 thread）+ 归一化后同文在 `dedupeWindowMs`（默认 60s，`0` 关闭）内只投递一次——
同一条结论发到同一会话的 3 个 thread 也算重复（回执写「已在 thread … 发过同文」）；确需再发传 `force:true`。

- **默认只读**：两个面板都没有加锁/释放按钮。取锁、排队、释放仍然只有 `collab_lock` / `collab_unlock`
  两个工具（以及 skill 里的规程）——状态面板点错不该改变别的会话能做什么。0.5.1 的命令与计数条、
  0.5.2 的标题栏 pill 同样只有一个动作：**打开面板**（pill 在无会话时还多一个 **toast**，仍是只读）。
  0.8.0 起 Desktop 面板右详情多了四个**写动作**（加急/冻结/解冻/归档），但每一个都**先确认**、服务端复用
  工具同一份门禁、失败只 toast，并且 `boardActions:false` 可以整行隐藏；TUI 与所有读取视图仍然零写。
- **鼠标不可用时 TUI 仍能进**：`/collab` 与 `ctrl+shift+l` 始终有效；宿主把侧栏固定成一行高度时展开内容
  会被裁掉（不崩溃），此时就是靠这两个入口。见 `docs/collab.md` §11.11.3。
- **可关闭**：Settings → Extensions → Plugins 里本插件的开关；关掉视图不影响 server 部分的工具。
- TUI 部件依赖宿主的 `@opentui/core` / `@opentui/solid` / `solid-js`（`peerDependencies`，optional）；
  老宿主不加载 `./tui` 时 server 与 GUI 都不受影响。

### Desktop 如何让它出现（0.5.3：必须装在本机）

**结论**：桌面端（2.3.x）的 GUI 宿主**只跟踪本机 sidecar**——`out/main/host-*.js` 里的
`subscribe-credentials` 只对 `id === 'sidecar'` 返回凭据，`plugin.list()` → `plugin.gui({id})`
取的都是本机 URL。所以**装在远端服务器上的插件，其 GUI 部分永远不会被窗口加载**（设置页只有名字、
没有 GUI 开关，标题栏也没有 pill）。这不是本插件的缺陷，也不是权限问题。

可行路径是：**插件装到本机**（窗口才会加载 GUI），GUI 再按「当前会话所属服务器」的 client 读远端数据
（0.5.3 起；见上表「GUI 数据源」）。

```bash
# 1) @inf-studio scope 指向 GitHub Packages（已有可跳过）
npm config set @inf-studio:registry https://npm.pkg.github.com
# 2) 读包凭据（已有可跳过；用你自己的 gh token）
echo "//npm.pkg.github.com/:_authToken=$(gh auth token)" >> ~/.npmrc

# 3) 装到本机（Desktop 所在机器）
opencode plugin add @inf-studio/collab@0.5.3

# 4) 重启 Desktop（GUI 宿主在 app 启动时读插件清单）
```

验证顺序：

```text
1) 标题栏出现 `collab` pill（或在命令面板搜到 collab.open）= 本机 GUI 已加载
2) 打开一个**远端**会话 → 面板顶部出现 `@<server.id>`，计数条/面板出数
3) 数值应与该远端服务器上的 collab_locks / collab_list 一致（不是本机的）
4) 没有会话时点 pill → toast 里 `server=` 说明当前数据源（无会话时为 `this computer`）
```

远端服务器上**仍要装**本插件（工具与 `collab.state.snapshot` RPC 在那边跑），它只是不需要承载 GUI。

### Desktop 看不到 collab？四步排查

结论先行：**远端服务器上的 GUI 永远不会被窗口加载**（0.5.3 用桌面端源码确认：宿主只跟踪本机
sidecar）。所以「远端窗口里没有 collab」是平台行为，不是加载失败；正确做法是把插件装到本机，
见上一节。下面四步用于确认**本机**到底加载了没有。

```text
1) 插件行有没有 GUI 开关？   Settings → Extensions → Plugins → collab
   → 有开关：关掉只影响视图，工具仍在；没有开关：先按 2)–4) 自证是否加载
2) 命令面板搜「collab」      → 有 collab.open「打开协作面板」说明命令已注册
3) 标题栏有没有 `collab` pill？（0.5.2 新增，常驻；无数据时就是 `collab`，不显示 0）
4) 点 pill（或 /collab、mod+shift+l）而当前没有打开会话
   → 弹「Collab GUI 已加载」toast（含 `server=`）= GUI 确实加载了（问题只是「没有会话可开面板」）
   → 什么都不弹 = 这个窗口没加载本插件的 GUI（本机装了？重启过 app？）
```

先确认 server 侧没问题的命令：

```text
opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"   # 列表里应有 collab，且没有 failed
```

远端部署（Desktop 连 Linux server）时，GUI bundle 由**远端** server 提供：`GET /api/plugin/gui?id=collab`
返回 `dist/gui-experimental.cjs`。但桌面端宿主只为本机 sidecar 建 GUI 宿主，**不会**为远端窗口加载它
（0.5.3 已用桌面端源码确认）——所以「200 但窗口里没标签」对远端是**预期行为**，解决方式是装到本机
（上一节）。本机安装后 `GET` 走本机 sidecar；请求 404/500 才说明插件没加载或产物缺失，先修 server 侧。
本机 pill 与第 4 步 toast 都正常 = GUI 端到端可用，剩下的差异在窗口/客户端侧（见 `docs/collab.md` §11.11.4）。

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
  "waiterTtlMs": 600000,
  "waiterHeartbeat": true,
  "dedupeWindowMs": 60000,
  "awareness": "line",
  "boardActions": true,
  "storage": "sqlite",
  "dbPath": "~/.config/opencode/collab.db",
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
| `waiterTtlMs`    | `600000`           | 排队**心跳**存活窗口（1 分钟–1 小时）：超过未心跳的排队者在下一次 `collab_lock` 被回收；`collab_locks` 只标 `[stale]` 不写文件 |
| `waiterHeartbeat`| `true`             | `false` 只关「会话 `context` 每轮刷新排队心跳」这一半；`collab_lock` / 写工具的 touch 仍在 |
| `dedupeWindowMs` | `60000`            | 正文去重窗口：同一 **target**（或同一 thread）+ 归一化后同文在窗口内只投递一次（`force:true` 强制并标 `dedupeOverridden`）；**`0` 关闭**（回滚开关） |
| `awareness`      | `"line"`           | **自动感知**提示：`context` 里每 10 分钟最多一行「本工作区候选 N（collab_handoff） · 其它工作区候选 M（collab_broadcast，需提案）」；`"off"` = 0 行。只读、不写记录、不投递 |
| `boardActions`   | `true`             | Desktop 面板右详情的动作行（加急/冻结/解冻/归档）。`false` **只隐藏按钮**（`snapshot.actions=false`），`collab.state.escalate\|freeze\|unfreeze\|archive` 仍可调；每次写动作追加一行 `~/.config/opencode/collab-audit.jsonl` |
| `storage`        | `"sqlite"`         | 消息投影 `collab.db` 的开关。`"json"` = **一次也不 import** `node:sqlite` / `bun:sqlite`，全部工具与看板只读 JSON（看板显示 `[索引不可用]`，回滚开关）。写错的值回落 `"sqlite"` |
| `dbPath`         | `~/.config/opencode/collab.db` | 投影路径（也可用 `COLLAB_DB_FILE`）。删掉它不影响协作，`collab_index {action:"rebuild",confirm:true}` 可重建 |
| `gate`           | `"enforce"`        | **0.9.2 闸门模式**：`enforce` 要求 `collab_accept` 带 `scopeCheck` 表态（`inScope:false` 且无人类 override → 拒绝）；`warn` 降为提示（表态照常审计）；`off` 完全跳过（不拒绝、不提醒、不写 audit）。写错的值回落 `enforce` |
| `aliases`        | `{}`               | 别名表：`collab_send {target:"schema"}`                                                            |
| `report.to`      | 未配置             | 缺陷上报的**主通道**：别名或 `ses_…`，插件把证据摘要当 `note`（`queue`）投给它；未配置只落盘 |
| `report.enabled` | `true`             | `false` = 关闭投递（仍落盘），回滚开关                                                             |

`protect` 与 `readonlyAgents` 都是**累加**的：内置项（schema 会话、长驻主线会话、
`explore`/`plan`）永远生效，配置文件只能加、不能减。

0.9.1 的会话契约目录固定为 `~/.config/opencode/collab-contract/`（一个会话一个 JSON），
测试 / 沙箱可用 `COLLAB_CONTRACT_DIR` 覆盖；它不是 projection，删掉只丢契约（主线 / 里程碑 / 待办），
不影响消息历史与协作状态。

## 版本兼容

| 包版本  | OpenCode | Node      | 说明                                              |
| ------- | -------- | --------- | ------------------------------------------------- |
| `0.9.x` | `2.3.x`  | `>=22.18` | **0.9.4** 新增事实账本（`src/core/facts.ts` / `tri-state.ts` / `glossary.ts` + `collab_fact`，26 → 27 个工具）：工作区级 `collab-facts.json`（`settle` / `retract` / `invalidate` / `list`，`F1`…`F#` 可寻址，`epoch` 只在作废后 +1，同 claim 覆盖，2000 条上限，跨进程 `<file>.lock` + `tmp+rename`）；证据等级 `measured`/`inferred`/`relayed`/`unknown`（`relayed`/`unknown` 不得被引用为证据，未标注消息注入 `[未标注]`）；三态 `fresh`/`stale`/`conflict`（无 `basedOn` → `fresh`+`[基线未知]`，`stale` 只回增量 ≤30%）；`invalidate` 工作区级传播（注入 `[retracted:F3→F4]`）并在途 todo 标 `staleWork`+`⚠失效`（不关闭，按 `ref.workspace` 过滤）；`metrics.retract_count` 含 retract/supersede，`metrics.staleDeliveries` 记每次 stale 投递；每对会话 3–10 条术语表（`[glossary]` 一行，同一术语第 2 次冲突拒绝发送）；**0.9.3** 新增漂移检测与挂起唤醒（`src/core/drift.ts` / `wake.ts`）：连续 5 轮无 mainline evidence / 主线挂起 > 2h / suspended 24h 未醒 / 上次未处置 → `[drift]`（≤2 行），必须用 `collab_mission {action:"resume",next}` / `{action:"block",on,reason}` / `{action:"done"}`（`done` 必须已有 mainline next-up 待办）三选一落账，未处置下一轮带 `[未处置]`；`collab_todo suspend` 的 `wakeWhen` 结构化（`reply`/`decision`/`time`/`manual`，`time` 必须未来，其余 24h 兜底），到期转 `drifted` 且不自动关闭；工具数不变（26）；**0.9.2** 新增协作闸门（`src/core/gate.ts` / `audit.ts`）：**接单前模型表态**（`collab_accept` 的 `scopeCheck`，插件不做语义判断）+ 每次表态写 `collab-audit.jsonl`（`inScope`/`verifiedBy`/`approvedBy`）+ 人类 `override{reason,approvedBy}` + `openTodos ≥ 8` 只提醒不拦 + `broadcast`/`handoff` 永不拒绝 + `reply`/`send` 不校验 + `gate:"warn"|"off"` 回滚开关；删除关键词/别名匹配（连同注入里的 `[scope]`，五段→四段）；工具数不变（26）；**0.9.1** 新增会话契约（`collab_mission` / `collab_progress` / `collab_todo`，23 → 26 个工具）+ 每轮五段注入（`[mission]/[todo]/[drift]/[scope]/[progress]`，≤12 行，不写 `injected[]`）+ 主线锚解析 + evidence 校验（commit/file/test/decision）+ `[未收尾]` 回溯标记；**0.9.0** 新增消息历史 + 可重建索引：每条投递写一行 `Envelope` 到 `collab-messages.jsonl`（全文，>1MB 分片），并投影到 `collab.db`（8 表 + FTS5，WAL）；新增 `collab_index`（`stats`/`rebuild`/`backfill`，22 → 23 个工具）；`storage:"json"` 回滚开关不 import sqlite；现有工具输出契约不变（读路径仍以 JSON 为真源，看板只多一个 `[索引不可用]` 标记） |
| `0.5.x` | `2.3.x`  | `>=22.18` | 只加**只读入口**：**0.5.3** 快照改为按「会话所属服务器」取 client（远端会话读远端 `server.client`，跨服务器切换不串台、迟到回包丢弃）+ 探针/面板标出数据源服务器 + 文档写明 Desktop 必须装在本机；**0.5.2** 修 R-7（切会话时在飞的请求会吞掉重载，`queue` 最多滞留 2 s 旧会话数字）+ 新增标题栏 `collab` pill 探针（无会话点击弹「已加载」toast）；0.5.1 新增 Desktop `collab.open` 命令（`mod+shift+l` / `/collab`）+ 会话头计数条（`session.header`）+ TUI 侧栏摘要点击展开/折叠；0.5.0 新增 spawn 会话自动归档。契约 / 工具 / RPC 形状不变 |
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
pnpm test          # build + 899 项 harness + 12 项只读默认 + 20 项看板派生 + 53 项关系图/布局/缩放 + 54 项快照/产物 + 60 项 TUI 渲染 + 47 项 GUI 入口 + 82 项 GUI 面板渲染
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
  0.7.0 追加 S101：跨 thread 正文去重（同一 target 的 3 个 thread 同文只投 1 次、回执写明「已在 thread … 发过」）、
  `force:true` 三投三中且标 `dedupeOverridden`（带 `bid` 时记录标 `dedupeOverriddenAt` 且状态字段不变）、
  窗口边界（59s 拦 / 61s 放行，`Date.now` 前跳）、不同 target / 预览 / `dedupeWindowMs:0` 各一条。
  0.7.0 追加 S106：契约决策（`collab_decisions`）——写 3 条 / 重复 id 覆盖（计数不变、只显示最新）/
  五类非法输入可读拒绝且 0 写入 / 控制字符折叠 / 第三方拒绝且记录逐字不变 / `confirm:false` 不写 /
  真实叫醒链路的注入只有一行计数且不含正文 / `collab_list` 行尾 `decisions=N` /
  `state`/`claim`/`receipt`/`replies` 前后一致 / 无 `decisions` 的旧记录输出不变 / 写满 20 条后新增被拒、覆盖仍可。
  0.7.0 追加 S105：BLOCKED 结构化——投递正文 / 承接方注入（真实叫醒链路）/ `collab_status` 三处都含三段、
  不传时投递正文与信封+正文精确相等、五类非法输入可读拒绝且 0 投递 0 写入、无 bid 与非参与方都不落库、
  连续 4 次只留最近 3 次、`state/claim/receipt` 前后一致、工具面 22 个（同一窗口新增 `collab_decisions`）。
  0.7.0 追加 S102：thread 聚合（`collab_threads` 一次列出 1 handoff + 2 消息 thread、kind/bid/出入站摘要、
  唯一「← 建议继续」、`includeClosed` 才列已闭环 ≤3）与 `collab_status` 降级（消息 thread → `kind=messages`
  + 摘要、未知 thread 保留原错误）；索引只在该消息**真的投递成功**后写（预览零写入）、上限 500 按 `lastAt` 淘汰、
  坏文件按空处理、四个读命令前后索引 mtime+hash 与广播目录不变。
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
  0.5.3 追加 8 条：`ctx.client` 与每个 `session.server.client` 是**各自记录调用**的假 client——
  远端会话打到 `server.client` 且 `session` 为远端 id（`ctx.client` 零调用）、无 `server` 回退、
  A→B 跨服务器切换立即用 B 的 client 且旧服务器的数字在 B 的请求在飞时就已消失（不串台）、
  A 的慢回包在切到 B 之后被丢弃（中途「无数据」而非 A 的数字）、toast 含 `server=this computer` 与版本。
  变异验证：`server?.client` 改回 `ctx.client` → 7 条失败；去掉回包前的 key 比对 → 迟到回包那条失败；
  去掉 `adopt()` 的清屏 → 「切走即清」那条失败。

源码结构：`src/core`（存储/领取/打分/回执/血缘/上报/挂起/租约/队列/归档/侧栏快照/thread 索引）、`src/tools`（二十二个工具）、
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
