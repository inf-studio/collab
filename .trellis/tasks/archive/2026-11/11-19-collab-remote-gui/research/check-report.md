# 独立复核报告：0.5.3 按会话服务器取 client

- 任务：`.trellis/tasks/11-19-collab-remote-gui`
- 复核者：`trellis-check`（冷上下文，只审不改实现；未 commit / 未 git add / 未 push）
- 复核对象（未提交，`/data/project/collab`）：`src/gui.tsx`、`test/gui-entry.mjs`、`src/constants.ts`、
  `package.json`、`README.md`、`docs/collab.md`、`skills/collab/SKILL.md`、`CHANGELOG.md`
  （`git diff --stat`：8 files changed, 467 insertions(+), 97 deletions(-)）
- 工作区状态：复核前后 `git status --short` 一致（仅上述 8 个 M + 任务目录 `??`）；未改动任何实现文件。

## 结论

**可提交（无阻塞缺陷）。** R1–R5 全部按设计落地，8 项必查全部通过；回归 **638 + 12 + 35 + 29 + 47** 全绿，
`check-skill` 通过，版本三处一致。

另有 **1 个测试覆盖缺口**（`catch` 分支的 key 比对，仓库测试对删除它无感知 —— 代码本身正确）与
**1 个设计取舍风险**（跨服务器切换时 single-flight 会把新服务器首次请求推迟到旧请求结束）。两者都
不阻塞提交，详见 §5 风险清单。

---

## 1. 复核方法（证据不是我复述实现方的话）

1. 通读实现与 `prd.md` / `design.md` / `implement.md`，逐条对照。
2. **自建探针**（不 import 实现方的 harness），直接对**构建产物** `dist/gui-experimental.cjs` 跑：
   - `research/probe-check.mjs`：16 条，覆盖 R1 / 迟到回包（成功**与失败**）/ 切换清屏 / 轮询定时器 /
     toast / 只读；含自有假 ctx（`ctx.client` 与每个 `server.client` 各自计数）。
   - `research/probe-panel.mjs`：5 条，用**最小 DOM** 真正渲染 `PanelView`（经注册的 `Panel.render`
     + `PluginContext.Provider`），实证面板 `@<server.id>` 的显示/隐藏 —— 这是实现方测试没有覆盖的部分。
   - 两个探针支持 `PROBE_ROOT=<dir>`，因此也对**变异后的副本**运行。
3. **变异验证**：把工作区复制到 `/tmp/opencode/collab-mut`（`node_modules` 软链），在副本里改源码 →
   `pnpm build` → 分别跑仓库测试与我的探针，全程不碰工作区源码。
4. 全量验证在工作区原样执行：`pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs`。

---

## 2. 八项必查（逐条）

### 2.1 R1 数据源跟随会话服务器 —— **通过**

- `src/gui.tsx:152-164` `sourceFor`：`const server = session?.server;`
  `client: server?.client ?? ctx.client`（`:160`）、`key: ${server?.id ?? 'local'}\n${session?.id ?? ''}`（`:156`）。
- 请求处 `src/gui.tsx:210`：`await source.client.rpc(CollabState).snapshot(source.session ? { session: source.session } : {})`
  —— 用的是解析后的 client，`session` 参数是该会话 id。
- 探针（我自己写的两个独立假 client）：

```text
✓ P1 a remote session reads server.client, with that session id; ctx.client untouched
     — {"remote":[{"session":"ses_remote"}],"local":[]}
✓ P1 … and the pill shows that server's rows — collab 4
✓ P2 a session with no `server` falls back to ctx.client (same id in the call) — [{"session":"ses_local"}]
```

→ 远端会话只打 `server.client`（`ctx.client` **0 次**）；无 `server` 时回退 `ctx.client`。
类型面也核过：`ServerRef.client: OpenCodeClient`、`ServerRef.local: boolean`、`SessionRef.server` 为
**必填**（`node_modules/@opencode/plugin/dist/gui/host-apis.d.ts:12-45`），所以回退只服务老/测试宿主，
与文档口径一致。

### 2.2 R2 迟到回包（成功 + 失败两处）—— **通过**

- 成功路径：`src/gui.tsx:215` `if (sourceFor(ctx).key !== source.key) return;`
- 失败路径（catch）：`src/gui.tsx:227` 同样的比对（**复核重点，实现方测试未覆盖此分支**）。
- 探针（自建，A 慢 300ms，B 慢 400/250ms）：

```text
✓ P3 a late success from A never reaches B's state (mid = no data, end = B) — collab → collab 1; a=1 b=1
✓ P4 a late *failure* from A does not put A's error on B (mid = no data, end = B) — collab → collab 3
✓ PN4 a late failure from the previous server shows no error banner on the new one
     — "@srv-b-goodLoading…"        （变异 M4 下变成 "server unreachable · srv-a-bad exploded"）
```

- 变异 M2（删掉 `:215` 的比对）：仓库测试 `46/47`，失败项
  `R2 a slow reply from the previous server never reaches the new server's state — collab 9 → collab 1`；
  我的 P3 同样失败（`collab 9`）→ 该守卫是真正起作用的，不是时序侥幸。

### 2.3 切换即清屏（`adopt` 在 single-flight 之前；守卫命中仍清）—— **通过**

- `src/gui.tsx:184-194` `adopt()`：key 变化即 `setState({at:0, data:undefined, error:undefined, loading:true, source})`。
- `src/gui.tsx:200-202`：`const source = sourceFor(ctx); adopt(source); if (inFlight) return;`
  —— **清屏在守卫之前**，因此「有请求在飞」时也清。
- 探针（关键：屏幕上**已有** A 的数字，且 A 的第二笔请求在飞时切到 B）：

```text
✓ P5 switching servers clears the rows at once even with a request in flight — collab → collab
✓ P10 a server switch clears rows that are on screen while a request is in flight
      — before=collab 2 a-calls=2 between=collab
```

- 变异 M3（`adopt()` 只记 key、不清 data）：仓库测试 `46/47`（`collab 2 → collab 2 → collab 5`），
  我的 P10 也失败（`between=collab 2`）→ 清屏是 `adopt()` 带来的，不是 B 回得快。

### 2.4 轮询（key 含 server；同服务器切会话立即重载；只一个定时器；幂等/隐藏可见未破坏）—— **通过**

- key：`src/gui.tsx:629-639`，`:632 return sourceFor(ctx).key;`（含 server id 与 session id）；
  `startPolling/stopPolling`（`:614-623`）保持 0.5.2 的显式 start/stop 与幂等守卫。
- 探针：

```text
✓ P6 same server + other session reloads at once with the new session id — [{"session":"ses_one"},{"session":"ses_two"}]
✓ P7 cross-server hops keep exactly one interval alive (old ones cleared) — {"afterStart":{"live":1,"created":1},"afterHops":{"live":1,"created":4}}
✓ P7 each hop reads the newest server and never the local client — a=2 b=1 c=1 local=0
✓ P7 disposing the plugin clears the timer — 0
```

→ 3 次跨服务器跳转后**仍只有 1 个存活 interval**（期间创建 4 个、清掉 3 个），dispose 后 0 个；本机 client 0 调用。
- 隐藏/可见相关既有 5 条 R7 断言在最终测试里仍全绿（见 §3 原始输出），本次改动未破坏。

### 2.5 R3 探针（toast `server=` / 面板 `@id` / 无会话 0 次 open）—— **通过**

- toast：`src/gui.tsx:589-606`，`:602 server: !server || server.local ? LOCAL_SERVER : server.id`；
  `LOCAL_SERVER = 'this computer'`（`:72`）；i18n `probe.description` 含 `server={{server}}`（`:539`、`:572`）。
- 面板：`src/gui.tsx:425-437`，`sourceLabel()` 在 `server.local === true` 或 `state.source.server` 缺失时返回 `''`，
  否则 `@${store.state.source.server}`；样式 `.collab-source`（`:324`）；i18n `panel.source`（`:540`、`:573`）。
- 探针：

```text
✓ P8 no-session toast says server=this computer and opens nothing
     — 插件 v0.5.3 · id=collab · panel=collab:main · app=2.5.0(desktop) · server=this computer
✓ P8 when the route appears mid-click the toast names that server=<id> and opens nothing
     — … · server=srv-remote8
✓ PN1 a remote session’s panel names the source server (@srv-remote) — "@srv-remoteGlobalLeasesres-0…read-only"
✓ PN1 … and the badge carries the translated title — {"class":"collab-source collab-mono collab-muted","title":"Rows come from this server"}
✓ PN2 a local server hides the badge (no @sidecar noise) — "GlobalLeasesres-0…read-only"
✓ PN3 a session without `server` shows no badge — "No collaboration activity.updated 08:00:00 · read-only"
```

→ 面板行为由**真渲染**证实（实现方 `research/impl-notes.md:181-183` 自述此项无 DOM 断言）。
无会话点击 = 1 条 toast、`layout.open` 0 次（探针与仓库断言一致）。

### 2.6 R4 只读 —— **通过**

- `src/gui.tsx` 全文件唯一 rpc 调用：`:210` `.rpc(CollabState).snapshot(...)`；新增代码只用 `layout.open` /
  `toast.show` / `sessions.*` 读取。
- 探针：`✓ P9 every rpc method entered is collab.state.snapshot (...) — ["collab.state.snapshot"]`；
  `✓ P9 … only layout/toast effect is opening the panel (no toast with a session) — {"opened":2,"toasts":0}`。
- `git diff --name-only`：只有 §0 列的 8 个文件；`src/core/**`、`src/tui.tsx`、`src/rpc.ts` **零改动**
  （`git diff --stat src/rpc.ts src/core src/tui.tsx` 为空）；`package.json` 只有 version 一行变化，
  **无新依赖**；`src/tui.tsx:173` 仍是 `ctx.client`，与 README「TUI 走宿主给它的 ctx.client」一致。

### 2.7 测试真实性 + 4 组变异 —— **通过（1 处覆盖缺口，见 R-2）**

新增 8 条断言（`test/gui-entry.mjs` §10，`grep -c "expect("` 在 §10 内 = 8；总数 39 → 47）：

| 变异（在 `/tmp/opencode/collab-mut` 副本） | 仓库测试 | 我的探针 |
| --- | --- | --- |
| **M1** `server?.client ?? ctx.client` → `ctx.client` | **40/47**，7 条失败（R1 两条 / R2 切换三条 / R2 迟到两条） | **7/16** 通过（9 条失败：P1×2、P3、P4、P5×2、P10、P6、P7） |
| **M2** 删 `:215` 成功路径 key 比对 | **46/47**：`R2 a slow reply … — collab 9 → collab 1` | **15/16**（P3 失败） |
| **M3** `adopt()` 只记 key 不清 data | **46/47**：`R2 … rows are dropped at once — collab 2 → collab 2 → collab 5` | **15/16**（P10 失败；P5 较弱，未覆盖） |
| **M4** 删 `:227` catch 路径 key 比对 | **47/47（未察觉）** | probe-check **16/16**（pill 无法区分 error，盲）；probe-panel **4/5**，**PN4 失败**：`"@srv-a-badserver unreachablesrv-a-bad exploded"` |

M1–M3 与 `CHANGELOG` / `impl-notes` 的记录一致（7 / 1 / 1 条失败，标题与观测值相同）。
**M4 是缺口**：仓库测试没有任何用例能观察到「旧服务器的 error 落到新服务器状态」（pill 在 error 与
loading 下都读 `collab`），实现方的「两处都判」在测试层只被证明了一半（代码本身正确）。

**既有 39 项未被弱化**：`git diff -U0 test/gui-entry.mjs` 删除行只有 harness 管线
（`const calls` / 旧 `client` 对象 / `return {...calls}`）与 `probe.description` 键列表一行；
被改写的只有 toast 断言，且是**加强**（加 `server=this computer`、版本改 0.5.3）。

### 2.8 回归与文档 —— **通过**

- 必跑（工作区原样，`/tmp/opencode/verify-053.log`，`EXIT:0`）：

```text
=== 638/638 checks passed
=== 12/12 checks passed
=== 35/35 checks passed
=== 29/29 checks passed
=== 47/47 checks passed
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
```

- `pnpm typecheck`（`tsc --noEmit`）无输出、`TYPECHECK_EXIT=0`。
- 版本三处一致：`package.json:3 0.5.3`、`src/constants.ts:310 '0.5.3'`、`src/gui.tsx:69 '0.5.3'`，
  toast 实测 `v0.5.3`，仓库断言 `package.json, PLUGIN_VERSION and the probe toast carry the same version` 通过。
- 文档口径（逐条核过）：
  - **必须装在本机 + 宿主只加载本机 sidecar**：`README.md:87-104`（含 `out/main/host-*.js`、
    `subscribe-credentials` 只对 `id === 'sidecar'`、`plugin.list()` → `plugin.gui({id})`）、
    `docs/collab.md:880-895`、`skills/collab/SKILL.md` 0.5.3 段。
  - **远端数据经 server client**：`docs/collab.md:922-948`（§11.11.5 六条规则 + 五条验证）、
    `docs/collab.md:776`（GUI UI 表「数据源（0.5.3）」）、`README.md` 状态视图表「GUI 数据源（0.5.3）」。
  - **不把上游限制说成我们的 bug**：`README.md:90-92`、`docs/collab.md:886-889` 均写「平台行为，不是本插件缺陷」
    且明确「本机没装插件时远端仍无 GUI，0.5.3 不改变这一点；不伪造左侧栏、不改桌面端」。
  - 安装步骤（`npm config set @inf-studio:registry` + `gh auth token` + `opencode plugin add @inf-studio/collab@0.5.3`
    + 重启）在 `README.md:94-100`，且有「远端服务器上仍要装本插件（工具与 RPC）」的提醒。

---

## 3. 原始输出（摘录，均为本机实测）

### 3.1 全量验证

```text
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
…
  ✓ R2 package.json, PLUGIN_VERSION and the probe toast carry the same version — {"pkgVersion":"0.5.3","constantsVersion":"0.5.3"}
  ✓ R2 switching to another server reloads at once through the new server's client — {"a":[{"session":"ses_a"}],"b":[{"session":"ses_b"}],"local":[]}
  ✓ R2 … and the previous server's rows are dropped at once (no stale numbers while B loads) — collab 2 → collab → collab 5
  ✓ R2 … and the pill then counts the new server's rows (no cross-server carry-over) — collab 2 → collab → collab 5
  ✓ R2 a slow reply from the previous server never reaches the new server's state — collab → collab 1
  ✓ R2 … and it does not trigger a second request to either server — 1 / 1 calls
=== 47/47 checks passed
=== 638/638 checks passed
=== 12/12 checks passed
=== 35/35 checks passed
=== 29/29 checks passed
=== 47/47 checks passed
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
EXIT:0
```

（`R7 hiding / a window that mounts hidden / disposing` 三条既有可见性断言同批输出全绿。）

### 3.2 自建探针 `research/probe-check.mjs`（16/16）

```text
✓ P1 a remote session reads server.client, with that session id; ctx.client untouched — {"remote":[{"session":"ses_remote"}],"local":[]}
✓ P1 … and the pill shows that server's rows — collab 4
✓ P2 a session with no `server` falls back to ctx.client (same id in the call) — [{"session":"ses_local"}]
✓ P3 a late success from A never reaches B's state (mid = no data, end = B) — collab → collab 1; a=1 b=1
✓ P4 a late *failure* from A does not put A's error on B (mid = no data, end = B) — collab → collab 3
✓ P5 switching servers clears the rows at once even with a request in flight — collab → collab
✓ P5 … and B is only requested once A settles (single-flight deferral, not "immediately") — b before/after = 0/1; end = collab 5
✓ P6 same server + other session reloads at once with the new session id — [{"session":"ses_one"},{"session":"ses_two"}]
✓ P7 cross-server hops keep exactly one interval alive (old ones cleared) — {"afterStart":{"live":1,"created":1},"afterHops":{"live":1,"created":4}}
✓ P7 each hop reads the newest server and never the local client — a=2 b=1 c=1 local=0
✓ P7 disposing the plugin clears the timer — 0
✓ P8 no-session toast says server=this computer and opens nothing — 插件 v0.5.3 · … · server=this computer
✓ P8 when the route appears mid-click the toast names that server=<id> and opens nothing — … · server=srv-remote8
✓ P9 every rpc method entered is collab.state.snapshot (no write method, no new contract) — ["collab.state.snapshot"]
✓ P9 and the only layout/toast effect is opening the panel (no toast with a session) — {"opened":2,"toasts":0}
✓ P10 a server switch clears rows that are on screen while a request is in flight — before=collab 2 a-calls=2 between=collab

=== 16/16 probe checks passed
```

### 3.3 自建探针 `research/probe-panel.mjs`（5/5，真渲染 `PanelView`）

```text
✓ PN1 a remote session’s panel names the source server (@srv-remote) — "@srv-remoteGlobalLeasesres-0exclusivefree…read-only"
✓ PN1 … and the badge carries the translated title — {"class":"collab-source collab-mono collab-muted","title":"Rows come from this server"}
✓ PN2 a local server hides the badge (no @sidecar noise) — "GlobalLeasesres-0exclusivefreeupdated 08:00:00 · read-only"
✓ PN3 a session without `server` shows no badge — "No collaboration activity.updated 08:00:00 · read-only"
✓ PN4 a late failure from the previous server shows no error banner on the new one — "@srv-b-goodLoading…"

=== 5/5 panel checks passed
```

### 3.4 变异原始输出（副本 `/tmp/opencode/collab-mut`）

```text
M1 (server?.client → ctx.client)            → 仓库 40/47；探针 7/16
  ✗ R1 a remote session is read through its own server's client, naming the remote session id — {"remote":[],"local":[{"session":"ses_remote"}]}
  ✗ R2 switching to another server reloads at once through the new server's client — {"a":[],"b":[],"local":[{"session":"ses_a"},{"session":"ses_b"}]}
M2 (删成功路径 key 比对)                     → 仓库 46/47；探针 15/16
  ✗ R2 a slow reply from the previous server never reaches the new server's state — collab 9 → collab 1
M3 (adopt 不清屏)                            → 仓库 46/47；探针 15/16
  ✗ R2 … and the previous server's rows are dropped at once (no stale numbers while B loads) — collab 2 → collab 2 → collab 5
M4 (删 catch 路径 key 比对)                  → 仓库 47/47（未察觉）；probe-check 16/16（盲）；probe-panel 4/5
  ✗ PN4 a late failure from the previous server shows no error banner on the new one — "@srv-a-badserver unreachablesrv-a-bad exploded"
```

---

## 4. 与 `implement.md` / `design.md` 的逐点对照

| 计划项 | 落点 | 结论 |
| --- | --- | --- |
| `sourceFor(ctx)`：`server.client ?? ctx.client`，key `${server.id}\n${session.id}` | `src/gui.tsx:152-164` | 一致 |
| `load()` 每次解析 source，前后比对 `source.key` | `:196-239`（`:200`、`:215`、`:227`、`:237`） | 一致 |
| `state.source = { server, session }` | `:129`、`:192`、`:223`、`:230` | 一致 |
| 轮询 key 含 server；隐藏/可见不变 | `:629-639`、`:614-623`、`:644-656` | 一致 |
| `probeToast()` 追加 `server=<id|this computer>` | `:589-606` | 一致 |
| 面板非本机显示 `@<server.id>` | `:425-437` | 一致（真渲染验证） |
| 仍只有 `layout.open` / `toast.show` | 全文件 | 一致 |
| 测试五类断言 + 变异 | `test/gui-entry.mjs:621-737` | 一致（catch 分支缺口见 R-2） |
| 文档 + 版本 0.5.3 | 8 文件中 6 个 | 一致 |

`design.md` §4「`TitlebarItem` 不变、不把服务器名塞进窄 pill」也遵守（pill 仍 `collab` / `collab N`）。

---

## 5. 风险清单（均非阻塞）

- **R-1（中低）跨服务器切换时 single-flight 把新服务器的首次请求推迟到旧请求结束。**
  实测 `P5 …: b before/after = 0/1`：切到 B 后、A 的请求还在飞时，B 一次都没被请求；`adopt()` 已清屏，
  期间显示 loading（不显示旧数字），但「立即以新服务器 client 重新请求」在「旧请求在飞」这一情形下
  退化为「旧请求结束后立刻请求」。若旧服务器请求长时间不返回（本仓无法确认 `rpc` 是否有超时），
  新服务器会持续无数据。`design.md` §3 明确保留 single-flight 与 `finally` 补排，故按设计不算违背；
  若要严格对齐 PRD 的「立即」，可考虑按 source 维度允许最新者优先（旧回包丢弃即可，已有守卫）。
- **R-2（中低，测试缺口）仓库测试覆盖不到 catch 分支的 key 比对。** 变异 M4 后仍 47/47；
  需能观察到 `state.error` 的断言（如把本报告的 PN4 渲染断言并入 `test/gui-entry.mjs`，或给
  `HeaderCounts`/panel 增加可测输出）。代码本身正确，故仅记为缺口。
- **R-3（低，UI）`@<server.id>` 对 http 服务器就是 URL**（`ServerRef.id` 文档：`sidecar` / http URL /
  `${plugin}:${id}`），`.collab-source`（`src/gui.tsx:324`）没有 `overflow`/`ellipsis`，窄面板可能横向溢出。
- **R-4（低，语义）`server.local === true` 也覆盖“loopback http”服务器**（同机另一个 server 进程）：
  badge 与 toast 都会说 `this computer`。同机语义成立，但用户无法区分“本机 sidecar”与“本机另一个 server”。
- **R-5（低，设计）无路由会话时的 toast 在正常路径始终是 `this computer`**（两个入口都先判 `current()`，
  有会话就走 `layout.open`），`server=<远端 id>` 分支只在「点击瞬间路由出现」时可达（我用该时序验证了字符串）。
  R3 的「哪台服务器」实际由面板 `@id` 承担，`design.md` §4 也是这么定的 —— 与设计一致，仅提示。
- **R-6（外部事实，不可在本仓复核）**「桌面端 2.3.x GUI 宿主只跟踪本机 sidecar」的证据来自 PRD 背景
  （`out/main/host-*.js`、`ie(serverId)`、`rt()`）；本机无桌面端源码可验，mac 实机验收（`implement.md` §5）
  仍未执行（标题栏 pill / 远端会话出数只有实机能确认）。
- **R-7（低，测试稳定性）**新增迟到回包用例在 t≈480 断言（A 300ms、B 700ms），机器卡顿 >200ms 可能偶发；
  建议后续改成事件/回调驱动或放宽采样点。
- **R-8（既有，非本次引入）** 路由会话消失（所有页签关闭）时 key 变 `false`，轮询停止但 `store.data`
  不清，pill 会继续显示上一次的数字；0.5.2 行为相同，本次未加剧，仅记录。

---

## 6. 复核产物

- 本报告：`.trellis/tasks/11-19-collab-remote-gui/research/check-report.md`
- 独立探针（可直接重跑；`PROBE_ROOT` 可指向变异副本）：
  - `research/probe-check.mjs`（16 条，行为/调用/定时器/toast/只读）
  - `research/probe-panel.mjs`（5 条，最小 DOM 真渲染面板 badge + 迟到失败横幅）
- 变异副本：`/tmp/opencode/collab-mut`（`node_modules` 软链自工作区；工作区源码未被修改，
  `git status` 复核前后一致）
