# 实施记录：按会话服务器取 client（0.5.3）

任务：`.trellis/tasks/11-19-collab-remote-gui` · 版本 `0.5.2 → 0.5.3`

## 0. 改了什么（对照 implement.md）

| 项 | 落点 | 说明 |
| --- | --- | --- |
| `sourceFor(ctx)` | `src/gui.tsx` | `client = session?.server?.client ?? ctx.client`；`key = ${server?.id ?? 'local'}\n${session?.id ?? ''}`；同时带出 `server` / `session` |
| `createSnapshotStore.load` | 同上 | 每次 `load()` 重新解析 source（不固定 client）；请求前后比对 `source.key`，不一致**丢弃**；`finally` 仍按 key 补排一次 |
| `adopt(source)` | 同上 | key 变化时**先**清 `data`（`loading:true`）+ 写 `state.source`，在 `inFlight` 守卫**之前**执行（切换瞬间即有请求在飞也照样清屏） |
| `state.source` | 同上 | `{ server?: string; session?: string }`，面板标源用 |
| 轮询 key | 同上 `createKeyed` | `sourceFor(ctx)?.key`（含 server），无会话/无 session 列表时 `false`；隐藏/可见仍走 0.5.2 的显式 start/stop |
| 探针 | `probeToast()` | `probe.description` 追加 `· server={{server}}`；`server.local === true` 或无 server → `this computer` |
| 面板 | `PanelView` | 远端时顶部一行 `@<server.id>`（`.collab-source`），本机不显示 |
| 只读 | 全程 | 仍只有 `layout.open` / `toast.show`；无新 RPC 方法、无写路径、无新依赖 |

测试 harness 的改造（`test/gui-entry.mjs`）：新增 `fakeClient({snapshot, delayMs})` 与
`serverSession(id, server, client)`；`ctx.client` 与每个 `session.server.client` 是**各自**的假 client，
各有独立 `calls` 数组——这是「打到哪台服务器」唯一可断言的证据。

## 1. 迟到回包丢弃的证明

### 1.1 代码路径

```ts
const load = async () => {
  if (disposed) return;
  const source = sourceFor(ctx);   // 本次请求属于哪台服务器/哪个会话
  adopt(source);                   // key 变了就先清屏（即使 inFlight）
  if (inFlight) return;
  inFlight = true;
  try {
    const reply = await source.client.rpc(CollabState).snapshot(...);
    if (disposed) return;
    if (sourceFor(ctx).key !== source.key) return;   // ← 迟到回包：丢弃
    ...
  } finally {
    inFlight = false;
    if (!disposed && !pageHidden() && sourceFor(ctx).key !== source.key) void load();  // ← 为新源补排
  }
};
```

三个条件缺一不可：

1. `adopt()` 在守卫之前 → 切换那一刻旧数字就消失（不靠回包）；
2. 回包后 key 比对 → 旧服务器的回包**不落库**（也不写 error）；
3. `finally` 的 key 比对 → 丢弃之后**立刻**为新源补一次（不需要等下一个 2 s tick）。

### 1.2 用例观测（`test/gui-entry.mjs` §10 第 4 例）

时间轴（A 慢 300 ms、B 慢 400 ms，setup 起算）：

```text
t=0      load(A) 发出                     A.calls=[{session:'ses_a2'}]
t=100    setCurrentSession(B)             key 变 → adopt(): data 清空、loading
                                          startPolling→load(): inFlight=true → 不发请求
t=300    A 的回包到达                     key('srv-a\nses_a2') ≠ 当前('srv-b\nses_b2') → 丢弃
                                          finally: inFlight=false, key 变 → load(B)
t≈480    断言 mid                        pill = 'collab'（无数据，**不是** A 的 9）
t=700    B 的回包到达                     落库，source = {server:'srv-b', session:'ses_b2'}
t≈1080   断言 end                        pill = 'collab 1'
```

实测输出（最终测试文件，47 条全绿）：

```text
  ✓ R2 a slow reply from the previous server never reaches the new server's state — collab → collab 1
  ✓ R2 … and it does not trigger a second request to either server — 1 / 1 calls
=== 47/47 checks passed
```

删掉「回包后的 key 比对」这一行后（见 §2 变异 B），`mid` 立刻变成 `collab 9` —— 证明这条断言确实由
key 比对兜住，而不是靠时序侥幸。

## 2. 变异验证原始输出

三组变异都用 `python3` 精确替换 → `pnpm build` → `node --conditions=browser test/gui-entry.mjs`，
每次改完立即从备份恢复并重新构建（最终基线回到 47/47）。

### 变异 A：`server?.client ?? ctx.client` → `ctx.client`

```text
  ✗ R1 a remote session is read through its own server's client, naming the remote session id — {"remote":[],"local":[{"session":"ses_remote"}]}
  ✗ R1 … and the numbers on screen are that server's (pill counts the remote rows) — collab
  ✗ R2 switching to another server reloads at once through the new server's client — {"a":[],"b":[],"local":[{"session":"ses_a"},{"session":"ses_b"}]}
  ✗ R2 … and the previous server's rows are dropped at once (no stale numbers while B loads) — collab → collab → collab
  ✗ R2 … and the pill then counts the new server's rows (no cross-server carry-over) — collab → collab → collab
  ✗ R2 a slow reply from the previous server never reaches the new server's state — collab → collab
  ✗ R2 … and it does not trigger a second request to either server — 0 / 0 calls
=== 40/47 checks passed
```

→ 「远端 client」相关的 7 条全部失败，`local` 收到本该属于远端服务器的调用（`ses_remote` / `ses_a` / `ses_b`）。

### 变异 B：删掉回包前的 `sourceFor(ctx).key !== source.key` 比对

```text
  ✗ R2 a slow reply from the previous server never reaches the new server's state — collab 9 → collab 1
=== 46/47 checks passed
```

→ 只有迟到回包那条失败，且失败原因正是「A 的 9 写进了 B 的状态」（`mid = collab 9`）。

### 变异 C：`adopt()` 只记 key、不清 `data`（去掉切换即清屏）

```text
  ✗ R2 … and the previous server's rows are dropped at once (no stale numbers while B loads) — collab 2 → collab 2 → collab 5
=== 46/47 checks passed
```

→ 切换后 80 ms 仍读到 A 的 `collab 2`（虽然 B 的回包最终会覆盖）。这条证明「不出现旧服务器的数字」是由
`adopt()` 的清屏保证的，而不是碰巧 B 回得够快。

## 3. 跨服务器切换的时序（`test/gui-entry.mjs` §10 第 3 例）

A 快（0 ms，2 条租约）、B 慢（300 ms，5 条租约）：

```text
t=0      setup，load(A)                     A.calls=[{session:'ses_a'}]
t=150    断言 before                        pill='collab 2'
t=150    setCurrentSession(B)               keyed key 变 → stopPolling→startPolling→load()
                                            adopt(): data=undefined, source={server:'srv-b',session:'ses_b'} → 发 B 请求
t=230    断言 between（B 仍在飞）            pill='collab'（旧服务器数字已消失）
t=530    断言 after                         pill='collab 5'（B 的数字）
```

实测：

```text
  ✓ R2 switching to another server reloads at once through the new server's client — {"a":[{"session":"ses_a"}],"b":[{"session":"ses_b"}],"local":[]}
  ✓ R2 … and the previous server's rows are dropped at once (no stale numbers while B loads) — collab 2 → collab → collab 5
  ✓ R2 … and the pill then counts the new server's rows (no cross-server carry-over) — collab 2 → collab → collab 5
```

要点：`ctx.client`（`local`）**零调用**——切换路径不会回落到本机 sidecar。

## 4. 全量验证

```text
$ pnpm build && pnpm typecheck
$ tsc --noEmit                     （无输出）
$ node test/handoff-harness.mjs     === 638/638 checks passed
$ node test/readonly-default.mjs    === 12/12 checks passed
$ node test/snapshot-shape.mjs      === 35/35 checks passed
$ node --conditions=browser test/tui-render.mjs   === 29/29 checks passed
$ node --conditions=browser test/gui-entry.mjs    === 47/47 checks passed   （0.5.2 为 39）
$ node scripts/check-skill.mjs
  ✓ skills/collab/SKILL.md (collab)
  ✓ skills/collab-coordination/SKILL.md (collab-coordination)
  skills ok
```

版本一致性由既有断言兜住（`package.json` / `PLUGIN_VERSION` / toast 三处）：

```text
  ✓ R2 package.json, PLUGIN_VERSION and the probe toast carry the same version — {"pkgVersion":"0.5.3","constantsVersion":"0.5.3"}
```

## 5. 文档改动

- `README.md`
  - 「状态视图」表：pill 行补 `server=`；新增「GUI 数据源（0.5.3）」行。
  - 新增 **「Desktop 如何让它出现（0.5.3：必须装在本机）」**：宿主只跟踪本机 sidecar 的结论、
    `npm config set @inf-studio:registry …` + `opencode plugin add @inf-studio/collab@0.5.3` + 重启 app、
    四步验证顺序；并写明「本机没装插件时远端仍然无 GUI，这是平台行为」。
  - 「Desktop 看不到 collab？四步排查」改成以「远端永远不会加载 GUI」为前提，只排查本机。
  - 「版本兼容」`0.5.x` 行、`test/gui-entry.mjs` 的断言清单（39 → 47 + 三组变异）。
- `docs/collab.md`
  - §11.11 标题补 0.5.3；数据流图 GUI 侧改为 `(session.server?.client ?? ctx.client)`。
  - GUI UI 表新增「数据源（0.5.3）」行；「刷新」行补 key 规则。
  - §11.11.4 重写：**已确认**的宿主行为（`out/main/host-*.js`：`D = () => pe()`、`ie(serverId)` 只有
    `sidecar` 分支、`plugin.list()`→`plugin.gui({id})`），只描述源码位置不复刻代码；排查表只针对本机。
  - 新增 §11.11.5「数据源跟随会话服务器（0.5.3）」：数据源 / 轮询 key / 迟到回包 / 切换即清屏 / 只读 /
    不聚合六条规则 + 五条验收对应断言。
- `skills/collab/SKILL.md`：0.5.3 一段（数据源、面板 `@server`、toast `server=`、必须装在本机、不要据此断缺陷）。

## 6. 未做 / 需注意

- 面板顶部的 `@<server.id>` **没有**直接断言：`test/gui-entry.mjs` 不渲染 DOM（`document.createElement`
  是抛错的桩），只断言到 store / pill / toast 这一层。面板标源的逻辑与 `state.source` 由
  「远端 → pill 数字」用例间接覆盖（同一 `state.source`）。
- pill 的 label 仍是 `collab` / `collab N`（design §4），服务器身份走面板 `@id` 与 toast `server=`；
  没有把服务器名塞进标题栏窄 pill。
- 未改桌面端、未加权限、未动 `src/core/**` / `src/tui.tsx` / `src/rpc.ts`。
- mac 实机验收（本机安装 → pill → 远端会话出数）仍需主会话在 mac 上执行（implement.md §5）。
