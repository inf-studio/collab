# OpenCode 插件 UI（GUI / TUI）约定

适用于 `src/gui.tsx`、`src/tui.tsx` 及其测试。这里的规则来自 0.4.2 / 0.5.1 两次实际踩坑，不是理想设计。

## 1. 能挂在哪里（Desktop GUI）

GUI 插件只有这些槽位，**没有左侧应用侧栏**：

| 注册项 | 位置 |
| --- | --- |
| `Panel`（`region:"side"`） | 会话右侧面板的 tab |
| `MenuItem("session.panel")` | 右侧面板 `+` 菜单的启动项 |
| `Slot` | `window.bottom` / `session.header` / `session.location.menu` / `session.panel.end` |
| `ComposerPill` | 输入框上方那行（会话级） |
| `TitlebarItem` | 窗口标题栏 |
| `Command` | 命令面板 / Settings → Shortcuts / 斜杠菜单 |

**规矩**：每个面板都必须有 ≥2 条独立入口（`Command` + 一个常驻可见的 Slot 或 MenuItem）。
只注册 `Panel` 等于「有实现、没人能打开」——`list` 返回 tab 不代表右侧区域展开。

- `Command` 用**函数形式**注册（`(): Command => ({...})`），`enabled`/`title` 才会跟随路由会话与语言。
- 默认键只写默认值（本项目 GUI 用 `mod+shift+l`，TUI 用 `ctrl+shift+l`，**不要**写成同一个键）；
  命令面板与斜杠入口不依赖键位，必须始终可用。
- 常驻可见的指示器（如 `session.header` 的计数条）：无数据时**渲染 `null`**，不要显示 `0`；
  不可达时给 `n/a` 而不是留空，且保持可点击。

## 2. 一个窗口一个 store、一个轮询

- `src/gui.tsx` 的 `sharedStore` 由 Panel / ComposerPill / HeaderCounts 共用：**一次 RPC 一拍**。
  新增 UI 时读同一个 store，禁止再开 `setInterval` 或第二条 RPC 流。
- 轮询 key **必须包含路由会话 id**（0.5.1 修正）：

  ```ts
  // 轮询按会话 keyed（切会话立即重载），可见性用显式 start/stop，不要放进 key。
  const startPolling = () => {
    // 三个门：已有定时器 / 窗口隐藏 / 没有会话——少一个都会多出请求。
    if (timer || pageHidden() || ctx.sessions.list().length === 0) return;
    void store.load();
    timer = setInterval(() => void store.load(), POLL_MS);
  };
  const stopPolling = () => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };
  createKeyed(() => ctx.sessions.current()?.id ?? '', () => {
    stopPolling();
    startPolling();
    onCleanup(stopPolling);
  });
  // 必须成对反注册：宿主 dispose 插件时靠 onCleanup 停表、摘监听。
  document.addEventListener('visibilitychange', onChange);
  onCleanup(() => {
    document.removeEventListener('visibilitychange', onChange);
    stopPolling();
  });
  ```

  `onCleanup` 里的反注册不是可选项：没有它，插件被停用后监听仍挂在 `document` 上，旧 store 会被
  可见性事件唤醒（本项目 0.5.2 的测试就是靠 `createRoot` + `dispose` 专门盯这条）。

  只写「有会话 = true」时，切会话后 `queue`（按 requester 计算）会拿上一会话的结果最多 2 s——
  这是**错数**，不是慢数。`collab.state.snapshot` 调用的 `session` 参数同样必须传当前会话。
- **`document.hidden` 不是响应式的**：写进 key 只会「启动时判一次」——隐藏后定时器照跑，隐藏时挂载的窗口
  永不启动（0.5.1 的真实 bug，0.5.2 修）。必须监听 `visibilitychange` 显式 start/stop。
- 页面隐藏时停轮询；面板打开与否不影响这一次轮询（侧栏/计数条也要数）。

## 2.5 Desktop 只有「本机 sidecar」会加载 GUI 插件

桌面端源码（`out/main/host-*.js`，app.asar）确认：

- 插件宿主跟踪的 endpoint 是 `D = () => pe()`（本机 sidecar）；`subscribe-credentials` 用它，
  `ie(serverId)` 只有 `id === 'sidecar'` 分支返回本机凭据，远端分支存在但宿主不调用。
- 宿主对该 endpoint `plugin.list()` → 过滤 `features.gui && state === 'active' && source.type !== 'builtin'`
  → `plugin.gui({id})` 取 bundle。

**推论（务必记住）**：插件装在远端服务器时，Desktop 只会列出它的名字，**GUI 永远不会加载**
（设置页没有 GUI 开关是正常表现，不是配置错）。

**所以 Desktop 的 GUI 插件必须装在本机**：

```bash
npm config set @inf-studio:registry https://npm.pkg.github.com   # 私有 scope
opencode plugin add <pkg>@<version>                              # 装到 ~/.cache/opencode/npm
```

装完要**重启 Desktop**（宿主在 app 启动时列插件）；验证：`/api/plugin` 里该插件 `features.gui === true`。

**数据必须按会话所属服务器取**（否则装在本机后只看到本机数据）：

```ts
const session = ctx.sessions.current();
const client = session?.server?.client ?? ctx.client;   // ServerRef.client 已由 app 鉴权
```

轮询 key 要含 `server.id`；回包前后比对 key，丢弃迟到的旧服务器结果。

## 2.6 四个数：持有 / 排队 / 待受保护 / 宿主排队

会话头与侧栏**不要**只写一个「队列」。0.6.0 起统一四个数：

| 数 | 来源 | 含义 |
| --- | --- | --- |
| 持有 | `locks.filter(l => l.holders.length > 0).length` | 真正被持有的资源 |
| 排队 | `Σ locks[].waiters` | 在等锁的会话数（含 stale） |
| 待受保护 | `snapshot.queue.length` | 我提交给 protected 会话的 owner-queue |
| 宿主排队 | TUI `data.session.pending.list()` / GUI `server.data.session.pending.list()` | OpenCode 自己的 prompt 队列 |

- **`free` 但有 waiter ≠ 被占用**：侧栏若只数 `locks.length`，一个只有僵尸 waiter 的资源会被算成「锁 1」。
- 宿主 pending 在 GUI 走 `SessionRef.server.data`，首次读取可 `sync()` 一次，失败静默 0（不要因此报错或加轮询）。
- TUI 侧栏用紧凑写法 `锁 N · 排 M · 待 K · 宿 J`，面板首行给图例，避免再猜。

## 2.7 看板：一份派生、两个渲染器

- 派生只在 `src/core/board.ts`（纯函数）：`buildBoard()` 工作区→会话→明细，`boardOrphans()` 兜底
  「无法归属到任何会话行」的锁/交接/队列。**GUI 与 TUI 必须调同一对函数**，禁止各自算。
- **绝不静默丢行**：孤儿锁/交接/队列要单独成段（`· 未归属`），空态只在「树和孤儿段都为空」时显示。
- spawn 关系只画一层：`handoff.kind === 'spawn' && from === sid`，子 id = `spawned ?? claimBy`。
- 已归档默认折叠（底部 `已归档 N`），归档行的 `busy` 恒为 false（归档≠忙碌）。
- 展开状态是**组件本地** `createSignal<Set<string>>`：2s 轮询换 `data` 不得折叠行；断言要证明
  「期间确实发生过一次快照替换」。

## 2.8 TUI 键盘层：组件体顶层注册一次

`ctx.keymap.layer(...)` **不要**放进 `createEffect`：`PanelInput` 是 reactive props，effect 重跑会叠加层
（实测切走再切回 → 2 个 enabled 层，`enter` toggle 两次、`j/k` 跳两格）。注册放组件体顶层，
`enabled` 里读 reactive props 即可；测试断言「切走再切回只有 1 个带 `enter` 的 enabled 层」。

## 2.9 协作自动感知与协议头

- **感知行默认开**（`awareness:"line"`）：`context` 注入末尾一行
  `协作：本工作区候选 N（collab_handoff） · 其它工作区候选 M（collab_broadcast，需提案）`。
  只有「非 protected + 无自己发起的未闭环交接 + N+M≥1 + 10 分钟未提示」才注入；`maxInject` 满时**本行先让位**。
- **成本上界**：每窗口最多 **2 页**（本工作区页 + 全局页）；`M` 在 `AWARENESS_LIST_LIMIT` 下是**下界**；
  宿主列表失败只写 N，不抛。**无 `ctx.location.directory` 时 N=0**，只渲染 M（否则同一批会话会被算两次）。
- **协议头必须可照抄且能闭环**：给 `collab_reply { threadID, text:"[handoff] DONE|BLOCKED <bid> <摘要>", confirm:true }`；
  不要给缺 `text` 或 `kind:"note"` 的写法（实测停在 `acked`，看板一直 open）。peer 无 thread 时给
  `collab_send { text:"[handoff] DONE|BLOCKED <bid> <摘要>" }`。

## 2.9.9 轮询列表必须用稳定行（0.10.0）

- 面板每 2s 拉一次快照，派生出的行对象**每次都是新引用**；`<For each={rows()}>` 按引用比较，整棵子树会被重建 →
  长列表滚动位置被浏览器夹回顶部（实测 25+ 会话的工作区每次轮询都跳）。
- 用 `createStableRows(items, keyOf)`（`src/core/stable-rows.ts`）：成员不变时**同一数组引用 + 同一 row 对象**，
  字段变化只 `setValue`；成员增删才产生新数组。
- **不要用 `<Index>`**：它按下标复用，列表重排（busy 抢前）时内容会串行。
- 凡在滚动容器内的行都要稳定化，**包括孤儿行**（locks / handoffs / queue）——漏一类，该类行每轮仍被摘挂。
- 测试：迷你 DOM 必须实现**最小 clamp 模型**（`clientHeight` + 删子节点时沿 parent 链夹 `scrollTop`），
  否则「滚动保持」断言恒真、打不回原 bug。主assert 用**节点身份**（同一行是同一对象），滚动值是伴生观测。

## 2.10 看板主从布局

- **GUI 分栏**：左列表（320px 左右）/ 右详情（自适应）；`≤640px`（`max-width:640px`）回落单栏——选中后详情替换列表并给「← 返回列表」。
- **右详情顺序固定**：`会话头 → 契约块（0.9.7，`data-collab-slot="contract"`，无契约不渲染）→ 图槽（GraphSlot）→ 动作槽（ActionRow）→ items`；两个槽位必须是**真实占位元素**（带 `data-collab-slot`），后续子任务原地挂载。
- **选中是本地 signal（按 sid）**：2s 轮询换快照**不得重置**；会话从「活跃 + 归档」都消失才清空并 toast；拉取失败/暂无快照不算消失。
- **TUI**：树不变；只有 `j/k` 打开下方 3–5 行详情，`esc` 清除；`enter/space/click` 只做展开，不再附带「激活详情」。
- **测试要点**：槽位顺序用直接子元素类名数组逐字比较；断点用可注入 `matchMedia` 夹住 `639`（单栏）/`641`（分栏）两侧——否则改数值/换顺序都能全绿。

## 2.11 关系图（0.8.0）

- 派生唯一来源 `src/core/graph.ts`：L0 工作区 / L1 工作区展开 / L2 会话 ±1 跳（≤8 + `+N`）；四类边
  `handoff` / `origin` / `spawn` / `subagent`。节点按 id、边按 `from+kind+to` **码位排序**——同一快照两次构建、
  甚至输入数组倒序都必须字节一致（测试必须验证倒序）。
- `origin` 边依赖快照字段 `handoffs[].origin`（0.8.0 起 `toHandoff` 透传 `record.origin.sid`，且 `origin === from` 不写）。
  **不要**只在图里读记录文件：远端/无盘时那条边会静默消失。
- 线型：`handoff` 实线；**任何指向工作区占位节点的边一律虚线**（跨界边，与 kind 无关——判断顺序必须在
  `spawn/subagent` 之前）；`origin` 虚线；`spawn/subagent` 点线。没有图库依赖，用 `stroke-dasharray`。
- 交互（GUI）：点会话节点=选中（联动左列表/items）；点工作区=切 L1；`▸/▾` 折叠一跳（仅组件内存）；悬停高亮。
- 已知覆盖缺口：跨界 `spawn/subagent` 的虚线没有专门夹具（只有 kind 内联线型有断言）。

## 2.12 看板动作（0.8.0）

- 四个动作（加急 / 冻结 / 解冻 / 归档）的编排**只存在于** `src/core/actions.ts`：工具与看板 RPC 共用；
  工具对 protected 走 urgent 队列（`protected:"queue"`），看板走拒绝（`protected:"refuse"`）——这是**入口策略**，不是第二套规则。
- RPC 写方法必须服务端强制门禁：protected 拒绝、只读 agent 降级、冻结优先；每次调用（成功或失败）追加一行
  `collab-audit.jsonl`（`{at,actor,action,target,ok,reason}`，只追加）。
- `escalate` 没有真实发起会话时**拒绝**（否则对端无处回执）。
- GUI 的「两步点击」降级路径：`armed` 必须存 `{action, sessionID}`，且**切换选中即清空**；
  `run()` 在任何 `await` **之前**捕获目标 sid——否则对话框开着时切换，动作会落到新会话。
- `boardActions:false` 只隐藏按钮，RPC 仍可用（文档写清）。

## 2.13 会话契约 / 四段注入 / 闸门（表态）/ 漂移（0.9.x）

### 契约真源
- `~/.config/opencode/collab-contract/<sid>.json`，五面 `mission / plan / todos / peers`（+ `turn` 计数位）。
- `mission.confirmedBy` 一旦写入，`set` 必须带 `--reconfirm` 且 `by` 非空，否则拒绝——**自动推断永不覆盖人工确认**。`confirm`/`reconfirm` 本身也必须带 `by`（缺省拒绝），否则人类确认与模型自确认不可区分。
- 主线锚解析顺序：会话指针 → 同工作区唯一 `in_progress` 任务 → 空（标 `[未确认]`）。**不要**用会话标题猜；**2+ in_progress 时不猜**，无契约时静默、有契约时在 `[mission]` 行写明歧义并给可执行命令。
- **序号分配必须在 per-session 串行段内**：`T<n>` / `M<n>` 的 `nextID` 与上限判断要放进 `updateContract(sid, mutate)` 里算，不能先读快照再 append——并发 tool call 会撞 id，`close` 会一次关两条（实测 `[T1,T1,T1]`）。
- **读侧永不按总数截断 active 行**：只淘汰已关闭的历史（`KEEP_CLOSED`）；`MAX_OPEN` 与 `KEEP_CLOSED` 分开命名。写入前用返回值自检「刚写的行读得回」，否则拒绝静默丢行；`todoSeq` 记录历史最大序号（迁移取未裁剪原始行），保证 id 不复用。
- **`turn.count` 每请求无条件推进**（契约存在即推进），不要和「有没有 todo 可比较」耦合；推进判定用 `>=`（同毫秒下严格 `>` 会漏计）。
- `[未收尾]` 判定用「本轮开始时间」比较（`updatedAt <= startedAt`），语义是「本轮开始前未更新」；渲染发生在工具调用之前，本轮新建的行不会出现在本轮块里。

### 注入（硬上限 12 行）
固定顺序累加，超限即停，被截断的段落**不出现**：

```
[mission] ≤3（含并入首行的 [role:…]）  [todo] ≤4  [decide] ≤1  [drift] ≤2  [progress] ≤2   → 合计 12
```

- **角色并入 `[mission]` 首行**，不单独占行：3+4+1+2+2 = 12 = 生产预算，六段全满时**不允许任何段被丢**
  （`test/decide.mjs` 断言 12 行且 `dropped=[]`）。新增段必须重新核算这道等式，或明确写出让哪一段整段让位。
- 没有契约、也没有任务锚的会话：若它是某个 open 决策的当事人，**只**注入 `[decide]` 那一行（不要再顺手造
  `[mission] 未设置`）。

- **每轮重算、不注销**：绝不写 `injected[]`（这是 0.5.x 一次性注入的教训——展示过就永久消失）。
- `[todo]`：`N open · M 需要你 · K 等对方` + top3（`blockingOn=me` 优先，其次最老 `since`）。
- **没有 `[scope]` 段**（0.9.2 删除）：插件不从消息文本推断边界；`outOfScope` 只在 `[mission]` 作为声明展示，
  接单判断由会话在 `collab_accept` 的 `scopeCheck` 里作出。
- `[drift]`：仅触发时出现（连续 5 轮无 evidence，或挂起 >2h，或 suspended 超 24h）。
- 插件**没有 idle 钩子**：`[未收尾]` 靠下一轮回溯判定，不要在文档里承诺 idle 写入。

### 决策账本（0.9.5）
- 存储 `collab-decisions/<key>.json`，`key` = threadID 或 bid；**每个 key 一个 `D#` 命名空间**，所以注入写
  `D1@t_…`，`decision:<id>` 跨 key 重名必须报歧义（作用域写法 `decision:<key>#D#`），**绝不静默取第一条**。
- 读改写必须 `<file>.lock` + `tmp+rename`；hook 里的冲突路径用 `waitMs: 1000`（不能把请求拖到 30s）。
- **提问方（`askedBy`）与回答者（`by`）分开**：提问方是当事人（可见、可 `supersede`），但 answer 只有 owner。
- **手工 open ≤3（D9）；conflict 决策单独配额**：升级不能因为手工列表满了而失败。
- **conflict 不能永久只读**：owner 缺省 = 收到分叉的本会话（不把对端设为裁决者）；该 thread/bid 的参与方都能
  supersede；24h 未回答由注入时的扫描自动作废（`by=system`）。`openConflictOf` 对超 TTL 的决策直接放行，不等扫描。
- **升级闸门同时对 `threadID` 与 `bid` 生效**（`b_…` 曾经漏掉，消息照发）。

### 人类决策清单（只读聚合）
- `collab_decision_inbox` 只解决「看见」：**不得**复用 `readAllDecisions` 的 500 截断——它保留字典序最大（≈最新），
  会**静默丢掉最老的待办**并把总数低报。独立扫描，显式上限 `DECISION_INBOX_SCAN_LIMIT`（默认 2000）。
- 超限必须输出 `⚠账本 N 个 key，仅扫描 M 个（可能漏更老待办）`，且**不得**把扫描数写成「共 N 条」；
  GUI/TUI 同步追加 `（已扫描 M/N key）`。
- 2s 缓存：键 = 目录 `mtime` + 文件数；**新增文件必须失效**，不得跨目录串。
- 行点击只 `tabs.open(owner)`，**零写 RPC**；owner 不是 `ses_…` → 标「人工」、不可点。

### 闸门（只拦接单；**不推断语义**）
- **不写关键词 / 别名 / 子串匹配**：`mission.outOfScope` 与 bid 文案之间没有任何自动比对
  （**0.9.5 的角色行同样只做静态声明**：不要根据消息正文给「应转 decider / 该由 implementer 执行」这类
  建议——实测三句常见话都会误伤；判断权在模型）
  （`redis` 既是 ws 集群别名也是排钟缓存键的词，匹配必然误伤；领域词不进通用插件）。
  判断权在会话自己的模型，插件只**逼表态 + 记录**。
- `accept`：本会话 `outOfScope` 非空 → 必须带 `scopeCheck:{inScope:boolean, reason?}`；
  缺表态（或 `inScope` 非布尔）→ 拒绝，文案说明「插件不做语义判断」并给两种可复制调用；
  `inScope:false` → 拒绝并给 `handoffTo`（`mission.handoffTo`）；`inScope:true` → 正常接单。
  `outOfScope` 为空 / 无契约 → 不需要表态，行为与 0.9.1 一致。
- **每一次表态都写 `collab-audit.jsonl`**：`{at,sid,kind,bid,inScope,reason,verifiedBy:'model'|'override',approvedBy?}`；
  未表态的拒绝、溢出提醒、`gate:'off'`、预览都不写。写失败只记日志。
- override 只在 `inScope:false` 时有意义：`{reason, approvedBy}` 必填，`approvedBy` 不得以 `ses_` 开头；
  单独给 override 而没有 `scopeCheck` 仍算未表态。
- `broadcast|handoff` **永不要求表态、永不拒绝**（派活是清账手段）；`reply|send` 不校验。
- 溢出（`openTodos ≥ 8`）**只提醒不拦**：`accept`/`broadcast`/`handoff` 返回末尾一行 `[溢出提醒]`，
  不改状态、不写 audit。
- 顺序：`guards → refresh（读）→ evaluate → persistRefresh → 只读分支`；拒绝时记录**零变化**
  （`state/claim/asked/attempts` 与 `<bid>.lock`），「已被领取」「spawn 自领 ACK」「已闭环/已过期」不经过闸门。
- `gate:'enforce'|'warn'|'off'`：`warn` 把拒绝降为提示（表态照常审计）；`off` 完全跳过；写错回落 `enforce`。
- **诚实边界**：拦不住 bash 层跨仓写；文档不得暗示能拦。

### 漂移三选一
- 判定只有四条，**不得放宽**：`noAdvanceTurns >= 5`（hook 在**请求开始**stamp：首个请求 / 上一轮刚推进 → 1，
  否则 prev+1；`evaluate` 直接读、不再 `+1`。无 advance 与「推进一次后再静默」两条路径都是第 4 轮安静、第 5 轮触发）/
  `mission.state='suspended'` 且 `parkedAt` 超 2h / suspended 或 drifted 待办的 `wakeWhen` 到期 / `turn.driftAt > 0`（未处置）。
- `resume`（给 `next`，state=active、计数与 `driftAt` 归零、mainline todo 建/更新，**并关闭同一契约里的 mainline
  `suspended`/`drifted` 行**——否则 `block → resume` 留僵尸行，24h 后每轮重新顶 `[drift]`）/
  `block`（给 `on`+`reason`，转 suspended + `parkedAt` + suspended todo）/ `done`（**必须已有 `kind:'mainline' && status:'open'` 的 next-up**）。
- 未处置 → 下一轮 `[drift]` 加 `[未处置]`；**只有三选一会清 `turn.driftAt`**，继续干活不清。
- 挂起必须 `wakeWhen`（`reply` / `decision` / `time` / `manual`），`kind:'time'` 必须 `at > now`；
  **`manual` 仍受 24h 兜底**（它只表示没有可自动观察的触发源，不是永久免打扰）；
  0.9.1 的自由文本按 `manual` 兼容，不改写。到期在**每次注入时**扫描（不依赖定时器），到期转 `drifted`，**不自动关闭**；
  非 `time` 型 24h 兜底；记录的未来 `at` 优先于 24h 兜底。
- 评估 / 写入都在 `context` hook：读 → `evaluate` → 渲染 → 串行 `stampTurn` + `markDrifted`（一次写）。
- `[drift]` ≤2 行；0.9.5 起五段上限之和 = **12**（mission 含 role 3 + todo 4 + decide 1 + drift 2 + progress 2），
  恰好用满预算，**六段全满时不允许任何段被丢**；新增段必须重算这道等式。`renderInjection {maxLines}` 仅测试用，
  截断分支保留但正常路径不可达。

### 事实账本（0.9.4）
- 存储：`collab-facts.json` 是**全机单文件**、按 `workspaces[dir]` 分区；读改写必须外套 `<file>.lock`（`wx` + 60s 陈旧 + pid 存活检查）。`tmp+rename` 只保证原子性，**不保证互斥**——不加锁的双进程并发会静默丢对方整本账（实测 `lost=20~25/50`，两边 exit 0）。
- 锁预算：`attempts = delays.length + 1`（与 `withRetry` 同约定），并且**每个退避必须真的被消费**；正常竞争靠事件驱动等待（`fs.watch` + 25ms 兜底轮询），不要靠"多试几次"硬抢。
- 基线快照（`git rev-parse` / `.env` sha1）必须在**锁外**计算并按目录缓存（5s）：放在锁内会把持锁时间拉到几十毫秒，锁几乎不空闲，突发写会饿死。
- `release()` 只删「可读且 token 完全匹配」的锁；读不到内容 → 不删（交给陈旧回收），否则会误删被接管者的锁。
- 派生作废：`invalidate {since:F#}` 走 `factIds` **显式引用闭包**；只有 `since:<epoch>` 才用 `basedOn.facts <= epoch`。两者混用会把同 epoch 的无关事实一起作废。
- `staleWork` 必须按 `workspace` 过滤：`F#` 在每个工作区从 `F1` 重新编号，跨区同名是必然而不是巧合。
- `metrics.retracted` 要计 `settle` 覆盖（design 口径是 retract + supersede）；`retract` 不得清空已有 `supersededBy`。
- 「stale 回复 ≤30% 原文」是**行为约定，不是闸门**（插件不生成模型回复，无法机器判定）：只保证注入逐字带指令，并把每次 stale 投递记入 `metrics.staleDeliveries` 供人工抽检。

### 投递节奏（0.9.6 落地）
- **窗口按 target**：`src/core/pacing.ts` + `src/core/dispatch.ts`；`windowMs` 默认 **120000**，从**首个 item** 起算；
  合并成**一条** envelope（`items[]`，每条保留原始 `sentAt`；落库 1 行 = `msg_count` +1）。`windowMs:0` = 逐条（回滚）。
- **直通**：`escalate` · 结构化 `blocked` · protected（含血缘）· 带 `bid` 的交接单（一个 `cid` 只能 ack 一单）·
  `force:true` · `windowMs:0`。别把「同 thread 的重复回执」做成第二个投递通道——它在窗口内本来就合并。
- **合并键**：`thread + factId`，否则 `thread + 归一化正文`；**命中时替换在原地**（保留最后一条、位置不变）；
  不同 thread 永不合并正文。没有 thread 的 item 不参与合并。
- **缓冲区是文件**（`collab-pacing.json`，`tmp+rename` + `<file>.lock`）：`setTimeout` **必须 `unref`**，
  `context` 钩子每轮 `flushDueWindows()` 是**持久路径**（休眠 / 重载 / 崩溃后补投）。只靠内存变量会在 reload 时丢消息。
- **失败不丢**：flush 抛错 → 整窗回缓冲区（`attempts` / `nextAt`，`PACING_RETRY_MS` 退避），不重发已投的窗。
- **无增量不发**：`src/core/delta.ts` 四类（新事实 / 状态指纹变化 / `lastAdvancedAt` 前进 / 回答未答问题）；
  `request` / `blocked` / `[handoff]` / `force` 一律算增量；**不做正文关键词匹配**（`[handoff]` 是协议标记）。抑制时
  **不写 thread、不写消息历史**，只写 `collab-pacing.json` 计数 + 契约 `turn.noopCount/lastNoopAt`（`collab_status` 可见）。
- **基线只在投递成功后推进**（`lastSent`）：被抑制 / 还在窗口里的条目不能推进基线，否则下一轮真增量会被误判为旧。
- **时效承诺 ≤5min**：晚于 `首个 item + 5min` 记 `metrics.late_count`，照常投递，不重发。
- **基线按对端各一份**（`lastSent` 键 = `${from}\u0000${target}`）：同一事实先发给 B 再发给 C **必须都投递**；
  用 session 级键会静默丢掉第二个对端（复核 C1）。`todoHash` / `advancedAt` 也因此天然按对端各自比较。
- **只有 `deliverPrompt` 抛错才是投递失败**；`recordMessage` / `threads.update` / memo / 指标刷新逐条 try/catch ——
  否则一次记账失败会让已投出的整窗重投一遍（复核 C2）。
- **`context` 钩子零窗口时不得写缓冲文件**（先无锁读，无到期窗口直接返回）；`flushAll` 之外不要为了「扫一遍」加锁。
- **指标**：`metrics` 每日一行 `msg_count`（按 id 形状 `_r<n>` **排除重发行**）/ `noop_count` / `late_count` /
  `median_gap_ms`（当天**全机**相邻间隔中位数）；
  刷新由投递路径触发、≤1 分钟一次（`PACING_METRICS_TTL_MS`），`storage:"json"` 跳过。
- **计数标记与 `uncounted`（0.10.0）**：投递成功并被计数后，行上写 `rawSeq` = `recordKept` 返回的当日新 `kept` 值
  （**一个生产者**，不要另算序号）；`collab_index metrics` 每行追加 `uncounted N`（当日无 `rawSeq` 的 message 行，
  `_r<n>` 重发除外），`N > 0` 行尾标 `⚠未计数`。口径必须与 `msg_count` **同源**（同一份投影），老行计入但不回填、
  不猜版本；`msg > raw` 时先用它归因。
- 测试：`test/pacing.mjs`（120s 用注入时钟，不等真实 2 分钟）；变异 `PACING_TEST_WINDOW_MS=0` 必须让「10 条合并为 1」变红。
  回放数字是**合成数据估计**（按 PRD gap 分位 + 151 连发重建、**两 target 轮转**）：25% 增量率 → 5.11× / p50 410s；
  31% 是上界参考（4.46×），**不跨口径比较临界值**。

### 存储
- JSON 是唯一真源（`collab-messages.jsonl` 存全文，超 1MB 分片）；`collab.db` 是**可重建投影**，删了不影响协作。
- 索引失败只记日志，**不得阻断投递**；`rebuild` 必须幂等（两次 checksum 相同）。
- `node:sqlite` / `bun:sqlite` 动态 import + 探测；`storage:'json'` 时**一次也不得 import**。
- **`rebuild` 必须写 `meta.schema='1'`**：就绪判据 `hasSchema()` = `schema` 标记 **或** 任一表有真实行；`stats.available` 与 `readable()` 必须同口径（实测过「rebuild 后看板永远回落、stats 却报可用」）。
- **只读路径不得建库**：`readable()` 先 `existsSync`；`openDb` 一开就会建库，漏了这道守卫会让一次 `collab_status` 产出 `collab.db` + `-shm`/`-wal`，并让后续每次写刷 mirror 错误。
- **水位按源分开**（`synced_broadcasts / synced_locks / synced_queue / synced_threads`）。全局 `synced_at` 会让「他人写 A + 本地 mirror B」把 A 的陈旧行当新鲜供出（实测看板丢掉仍生效的 lease）。
- **mirror 在写路径之外**（入队 + 0ms 合并）：写广播不得等 `busy_timeout`；等待期间读者按 mtime 回落 JSON。
- `messages.resend_of` 标记重发行（`_r<n>`）；统计消息数时必须排除，否则重发会被重复计数。
- `messages_fts` 截的是 **8192 字符**（CJK ≈ 24KB），不是 8KB 字节；文档不要写成字节。
- `backfill` 只写 `meta.backfilled`，**不造 `messages` 行**（历史正文不可得；造空行会污染计数与 FTS）。

### 投递计数三列（raw / kept / msg）
- `raw_count` = **进入投递管道的每一条**；`kept_count` = 未被抑制的条数；`msg_count` = 实际交付（排除 `_r<n>` 重发）。
- 计数时机：**窗口分支在入窗前计**（入管即计数）；**直投分支在 `prompt` 成功后计**（失败不计数）。唯一例外是窗口分支——flush 失败/重试会留下 `raw > msg`，这正是 `raw ≥ kept ≥ msg_count` 的由来。
- 全量日恒等式：`raw = kept + noop`；`raw ≥ kept ≥ msg_count`。**升级当天是部分计数**（历史消息只进 `msg`、历史 noop 不回填），该日不等式可不成立，文档必须写明。
- 全量埋点：dispatch 之外还有 7 个直投点（escalate / freeze / 缺陷上报 / resend / notifyRequester / `[ack]` / deliverAsk），漏一处就会让 `msg > raw`；每处都必须走同一个 `recordKept`。
- 老库首读：`metrics` 表还是旧结构时 `collab_index metrics` 会报 `no such column`；先做一次投递（自动 `ALTER`）或先 `rebuild`。
- **计数标记 `rawSeq` 与 `uncounted`**：投递成功时把当日 `kept` 序号写进 message 行（唯一生产者是 `recordKept`，避免序号与行漂移）；窗口批量行取窗口内最大序号。
- **「无标记」≠「没计数」**：`uncounted > 0` 只说明存在未标记行，来源有三种（0.10.0 之前 / **0.10.x-rc.2 已计数但无标记 → 假阳性** / 本版本漏埋），数据上无法区分；**只有 `uncounted = 0` 能证明当日全部计入**。
- **诊断向前生效**：历史行没有标记，`uncounted` 会等于 `msg`，**不能**用它追溯历史差异；归因历史时应按 `from` 会话的插件版本 + 该行 `kind` 是否直投点来核对。
- 不要为了「让历史干净」去回填 `rawSeq`——那会把「未标记」这个信号直接抹掉。
- **指标读取走工具、不直连库**：`collab_index { action:"metrics" }` 是唯一入口（默认 `limit:30`、按 day 倒序、覆盖范围报整表）；
  NULL 显示 `-`，不做二次计算；**先 `existsSync` 再 `openDb`**，读路径不得建库或建表（`ensureSchema` 只有 `rebuild` 调）。
- **metrics 的 NULL 是「未知」不是 0**：`noop_count` / `late_count` 来自 `collab-pacing.json` 的 `counters[day]`，
  只保留 30 天；180 天窗口里更早的日子必须写 NULL（`-`）。写 0 会被读成「当天没有抑制」。
  重建的**日期集合取全部消息**（含只有 `_r<n>` 的日期 → `msg_count=0` 的行仍保留）。

### 2.14 看板显示会话契约（0.9.7）

- **派生唯一来源** `src/core/contract-view.ts`（纯函数、**无 `node:` 导入**）：`contractBadge()` / `contractRows()` /
  `contractSummary()`；GUI 与 TUI 必须调这三个，禁止各自算。徽标颜色是 `collab-tone-*`，TUI 用行 tone。
- **快照字段可选**：`sessions[].contract` 缺失即「没有契约」。**无契约时不得写 `contract: {}`**——整份 `snapshot`
  要与 0.9.6 逐字节一致（`test/snapshot-shape.mjs` 的黄金串就是 HEAD 构建出来的），测试里这是硬断言。
- **读路径只读、不缓存（0.10.x 起）**：`snapshot.ts` 每次快照**直接读** `collab-contract/<sid>.json`。**不要**按
  `mtimeMs` 缓存：本机 FS 粒度约 4ms，同桶内二次写会被当成「没变」，看板会显示旧值直到下一次写入
  （100 会话全读实测额外 ≈1–3ms/轮询，2s 周期可接受）。决策清单的 2s 缓存（另一个读取器）保留。
  **绝不**在快照里调 `updateContract*`。两种情况都省略字段，但**只有一种算损坏**：
  **不可解析的 JSON** → 省略 + **一条**日志 + 不抛（`ignoring unreadable contract …`）。**日志按
  「文件路径 + mtime」节流**（0.10.x，C2）：同一版本的文件每 2s 轮询（GUI + TUI 各一次）只记一条，
  文件被改写（mtime 变）后再记一条——去掉缓存后不能退化成「每快照一条」，那与 `log.ts` 的
  「once per occurrence」自相矛盾。测试断言：同一坏文件连续 3 次快照 → 1 条；改写后再快照 → 第 2 条。
  **可解析但不是本版**（`v` 不认识 / 外部 `sid` / `updatedAt === 0`）→ 同样省略，**不记日志**（旧文件不是错误）。
- **徽标**：1 字符 + ≤3 位数字（`>99` → `99+`），插在 GUI 第二行末尾 / TUI 同一行末尾，**不新增行**；
  优先级 `drift ◇红 > suspended+drifted ◐琥珀 > todos.open ◑蓝+数量 > 正常 ●灰 > 无契约不显示`。
  **数量只取 `todos.open`**：`open` 已是「全部未完成」（注入 `[todo] N open` 与 `collab_todo list` 的口径），
  `blocked/suspended/drifted` 是它的分解——`open + blocked` 会把 blocked 重复计入（`open=3,blocked=2` → `◑5`）。
- **漂移 `since` 按触发源取**：`no-advance` → `lastAdvancedAt`；`mission-parked` → `parkedAt`；
  `suspended-expired` → `now − 最老 expiredSuspended.ageMs`；`unresolved` → `turn.driftAt`。
  一律回落 `now` 会让 TUI 打 `drift <1m`，而注入同时说「已挂起 4.0d 未醒」；`unresolved` 的 reason 已含
  「未处置」，不要追加第二个。
- **详情固定顺序** `主线 / 边界 / 进度 / 待办 / 漂移`，缺项隐藏；GUI 槽位 `data-collab-slot="contract"` 位于
  会话头与图槽之间，无契约整块不渲染。TUI 在计数行后追加**一行**摘要，用 `clipCells` 截断（按**字素簇**、
  CJK/全角/emoji/ZWJ 组合均记 2 格；`Intl.Segmenter` 切分，不得切开组合序列），不换行。
- 测试要点：三种徽标优先级各一例 + 无契约不显示；断言行体只有两个子元素（徽标不新增行）；`639px` 单栏仍有徽标；
  详情子元素类名数组逐字比对；TUI 宽 34 的摘要行以 `…` 结尾且下一行不是续行。

## 3. 只读是硬约束

状态面板/计数条/侧栏**不得**出现写动作（释放锁、归档、改权限）。点击只允许
`layout.open` / `panel.open` / toast。

## 4. TUI 侧栏

- `sidebar.content` 是宿主插槽，宿主可能把内容固定为一行高：**默认一行**，点击展开是增强而非前提。
  展开被裁剪时不抛错，且 `/collab`、`ctrl+shift+l` 必须仍可用。
- 点击用 renderable 的 `onMouseDown`（`@opentui/core/Renderable.d.ts`）；展开/折叠状态用局部
  `createSignal`，不要写 `storage`。
- 展开**不得**额外 `load()`：明细从已有快照派生，轮询仍由面板/侧栏既有的一次 load 负责。
- 子元素用 `wrapMode="none"` 保证「一行一条」，否则长 id 会换行错位。

## 5. 测试（`test/tui-render.mjs`、`test/gui-entry.mjs`）

- **TUI**：用 `@opentui/solid` 的 `testRender` + `captureCharFrame` 断言真实字符帧；
  交互要**真触发** `onMouseDown`，不能只断言「props 里有个函数」。
- **GUI**：直接 require `dist/gui-experimental.cjs`（构建产物，不是源码），用严格 Proxy 假 ctx：
  读未声明字段即抛错，可顺便证明「没有写 API」；需要 `--conditions=browser` 与
  `document.addEventListener` 垫片（Solid 委托事件在模块加载时注册）。
- 每条新断言做完后做一次**变异验证**（改坏实现，确认断言真的失败），否则视为无效覆盖。
- 版本号两处（`package.json` / `src/constants.ts` 的 `PLUGIN_VERSION`）必须一致。
