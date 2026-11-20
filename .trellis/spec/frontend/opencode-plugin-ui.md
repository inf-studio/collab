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

## 2.10 看板主从布局

- **GUI 分栏**：左列表（320px 左右）/ 右详情（自适应）；`≤640px`（`max-width:640px`）回落单栏——选中后详情替换列表并给「← 返回列表」。
- **右详情顺序固定**：`会话头 → 图槽（GraphSlot）→ 动作槽（ActionRow）→ items`；两个槽位必须是**真实占位元素**（带 `data-collab-slot`），后续子任务原地挂载。
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

## 2.13 会话契约 / 五段注入 / 闸门 / 漂移（0.9.x）

### 契约真源
- `~/.config/opencode/collab-contract/<sid>.json`，五面 `mission / plan / todos / peers`（+ `turn` 计数位）。
- `mission.confirmedBy` 一旦写入，`set` 必须带 `--reconfirm` 且 `by` 非空，否则拒绝——**自动推断永不覆盖人工确认**。
- 主线锚解析顺序：会话指针 → 同工作区唯一 `in_progress` 任务 → 空（标 `[未确认]`）。**不要**用会话标题猜。

### 五段注入（硬上限 12 行）
固定顺序累加，超限即停，被截断的段落**不出现**：

```
[mission] ≤3  [todo] ≤4  [drift] ≤2  [scope] ≤2  [progress] ≤2
```

- **每轮重算、不注销**：绝不写 `injected[]`（这是 0.5.x 一次性注入的教训——展示过就永久消失）。
- `[todo]`：`N open · M 需要你 · K 等对方` + top3（`blockingOn=me` 优先，其次最老 `since`）。
- `[scope]`：仅当本条消息命中 `mission.outOfScope` 时出现，必须给出「转交/拒绝/问 owner」三条路。
- `[drift]`：仅触发时出现（连续 5 轮无 evidence，或挂起 >2h，或 suspended 超 24h）。
- 插件**没有 idle 钩子**：`[未收尾]` 靠下一轮回溯判定，不要在文档里承诺 idle 写入。

### 闸门（只拦协作层）
- 拦 `accept`（越界/溢出）与 `broadcast|handoff`（溢出）；**`reply|send` 永不校验 scope**（回复不扩大边界）。
- `outOfScope` 为空 = 永不越界（误伤 0）；`gate:'warn'|'off'` 是回滚开关。
- override 必须 `{reason, approvedBy}`，`approvedBy` 不得以 `ses_` 开头，通过后写 `collab-audit.jsonl`。
- **诚实边界**：拦不住 bash 层跨仓写；文档不得暗示能拦。

### 漂移三选一
- `resume`（给下一步）/ `block`（给 on+reason，转 suspended）/ `done`（**必须已有 mainline next-up todo**）。
- 未处置 → 下一轮 `[drift]` 加 `[未处置]`；挂起必须 `wakeWhen`，`kind:'time'` 必须 `at > now`。

### 投递节奏
- 非紧急消息进 2min 窗口合并；`escalate` / `blocked` / protected 直通（<10s）。
- 无增量（无新事实、无状态变化、非回答）→ **不产生消息**，只写 `collab_status`。
- 时效承诺 ≤5min；超时记 `metrics.late_count`，不重发。

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
