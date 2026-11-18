# 独立复核报告：C2 协作侧边栏（`11-18-collab-sidebar`）

- 复核人：独立复核 agent（冷上下文，只审不改；未 commit / 未 push / 未 git add / 未改实现文件）
- 复核对象：`/data/project/collab` 工作区未提交改动（`src/rpc.ts`、`src/core/snapshot.ts`、`src/gui.tsx`、
  `src/index.ts`、`vite.gui.config.ts`、`package.json`、`tsconfig.json`、`test/snapshot-shape.mjs`、
  `pnpm-workspace.yaml`、`pnpm-lock.yaml`、文档）
- 环境：Node v26.13.1 / pnpm 12.21.0 / 本机无 OpenCode Desktop 可交互实例
- 时间：2026-11-18

## 结论（TL;DR）

**代码可提交（functional 全绿：506 + 12 + 18 + check-skill，只读性、契约、产物、构建改动、回归、安全、范围均通过）。
提交前应修 2 处「文档/注释超出实现」的断言**，否则会变成后续争议点：

1. **「页面隐藏时停」不是实现行为**（`src/gui.tsx:399-400` 注释 + README + `docs/collab.md` + CHANGELOG 都这么写）。
   实现只在 source memo 里读一次 `pageHidden()`，没有任何 `visibilitychange` 订阅（产物里 `addEventListener` 计数 0）。
2. **README 关于 `fallback` 的括号说明（「宿主没存过选择时会优先选它」）与宿主 API 语义不符**：
   `Panel.list` 在 `input.open` 不含 `main` 时返回 `[]`，`fallback` 只能在**已列出**的 tab 里兜底 →
   全新安装时面板**不会自己出现**，必须先走 + 菜单 launcher（launcher 本身是有的、可用）。

其余为低风险 nit（见 §问题清单 N3–N7）。

| # | 必查项 | 结论 |
| --- | --- | --- |
| 1 | 只读（不写盘/不回收/不唤醒/不投递） | **通过**（构造断言 8/8） |
| 2 | 契约 schema / `reachable` 语义 / `ctx.rpc` 降级 | **通过**（构造断言 16/16）；真机 RPC 往返**存疑**（本机无 Desktop） |
| 3 | 产物（gui.cjs 只 require 宿主模块；server 产物零 `@opencode/*`；pack 含 GUI） | **通过** |
| 4 | 构建改动（vite 别名、`allowBuilds`） | **通过**（两者都必要且是最小/标准做法；CHANGELOG 已记录） |
| 5 | GUI 行为（2s 轮询可见性 / 不可达占位 / 数据一致） | **部分不通过**：可见性断言不成立；不可达占位通过（静态）；数据一致通过（11/11） |
| 6 | 回归（install/build/typecheck/test/check-skill，506 无删改） | **通过** |
| 7 | 安全（`BUILTIN_PROTECT` 未改、GUI 无写操作、无新增运行时依赖） | **通过** |
| 8 | 范围（越界文件） | **通过**（无越界，见 §8） |

---

## 1. 只读：`buildSnapshot` 不写盘、不回收、不唤醒、不投递 —— 通过

**静态证据**

- `src/core/snapshot.ts:99-137` 的 `buildSnapshot` 只做三件事：`source.sessions()`（唯一 await，3 s 上限）、
  `source.locks().map(toLock)`、`source.handoffs().map(toHandoff)`，然后排序/过滤。
- `grep -nE "writeFile|writeSync|mkdir|rename|unlink|deliver|notify|emit|event\." src/core/snapshot.ts` → **(none)**。
- `snapshot.ts` 的全部 import（`:14-18`）：`BCAST_DONE_STATES`、三个 `import type`、`util`、`stateOf`。
- 租约视图走 `stateOf(record, now)`（`src/core/locks.ts:449-471`），其 `reap` 是**纯函数**（`locks.ts:415-440`，
  返回新对象，不写回）；生产 reader 是 `allLocks`（`locks.ts:320-336`，只 `readdirSync`+读 JSON）与
  `allBroadcasts`（`src/core/claim.ts:160-174`，只读）。
- GUI 侧无任何写路径：`dist/gui-experimental.cjs` 里 `.rpc(` 出现 1 次、`snapshot(` 出现 1 次，
  没有 `collab_lock` / `unlock` 字面量（`gui.tsx:117` 是唯一 RPC 调用）。

**我自己的构造断言**（`/tmp/opencode/collab-check/c2-review/probe.mjs`，用 ESM loader 把 `node:fs`
的 16 个写函数全部包了 tap，再跑 4 次快照）：

```
  ✓ no write-ish fs call during 4 snapshots — []
  ✓ lock/broadcast files byte- and mtime-identical (expired lease still on disk as held)
  ✓ no file/directory created in the store root — ["broadcasts","locks"]
  ✓ expired lease renders free with its queue intact — {"resource":"named:build","kind":"build","mode":"exclusive","holders":[],"waiters":1,"waiting":["ses_a2"],"expiresInMs":0}
  ✓ the caller's LockRecord was not mutated by the snapshot (holders/expiresAt/updatedAt) — {...} -> {...}   （前后完全一致）
  ✓ decided hand-off excluded, open one present — ["b_open_1"]
  ✓ workspace filter narrows to beta — ["ses_b1"]
  ✓ snapshot carries no write-capable field (methods only snapshot, events empty)

=== 8/8 read-only checks passed
```

即：过期租约在**视图里**变 `free`、磁盘记录（含 mtime）一字未改、调用方传入的记录对象未被原地修改，
「不回收」成立；`buildSnapshot` 完全不碰 `ctx.event` / 投递层，「不唤醒 / 不投递」成立。

## 2. 契约（schema / `reachable` / 降级） —— 通过（真机往返存疑）

**schema ↔ 返回结构**：`src/rpc.ts:92-145` 用纯 JSON Schema 字面量声明 `collab.state`
（1 个 method、0 个 events、`satisfies Rpc.PortableDefinition`，`import type` 擦除），
返回类型 `Snapshot`（`rpc.ts:24-76`）。

我的构造断言（`/tmp/opencode/collab-check/c2-review/contract.mjs`：真跑 `plugin.setup`，
用假宿主捕获 `register(definition, handlers)`，再用一个小 JSON-Schema 校验器验 handler 的真实输出）：

```
  ✓ old host (no ctx.rpc): setup resolves — function
  ✓ old host: all 15 tools are still registered — 15 tools
  ✓ register() rejection is swallowed (setup resolves) — ok
  ✓ register() rejection keeps the tools — 15 tools
  ✓ rpc host: register() is called once — yes
  ✓ rpc host: definition id is collab.state (under the plugin id) — collab.state
  ✓ rpc host: exactly one method, no events — []
  ✓ rpc host: handler is a function (not a {value} wrapper object) — function
  ✓ input schema accepts {} (workspace optional) — []
  ✓ input schema accepts { workspace: "/x" }
  ✓ handler output validates against the declared schema — []
  ✓ reachable:true is in the payload (a rejection is what marks unreachable) — {"at":...,"reachable":true}
  ✓ sessions come from the host list (2 listed, archived excluded) — [["ses_a1","/data/project/alpha"],["ses_a2","/data/project/alpha"]]
  ✓ no lock/hand-off files exist yet → empty arrays, not an error — 0/0
  ✓ cleanup disposes the rpc registration — true
  ✓ schema declares every interface field (no silent drift) — all present

=== 16/16 contract checks passed
```

（`rpc.ts` 的 4 个接口 `SnapshotSession/Lock/Handoff` + `Snapshot` 的字段与 schema `properties` 一一对应，
`required` 只覆盖服务端必然写出的字段：`parent` / `claimBy?` / `workspace?` / `reason?` 保持可选。）

**`reachable` 语义成立**：宿主 `ctx.client` 文档明确「While the server is unreachable, every call rejects」
（`node_modules/@opencode/plugin/dist/gui/core.d.ts:303-312`），因此「reject = 不可达、`reachable:true` = 空/满都是真数据」
是成立的；GUI 侧 catch 后保留上一份数据并显示横幅（`gui.tsx:111-130`、`:310-315`）。

**`ctx.rpc` 缺失降级成立**：`src/index.ts:154-162` 只在有 `rpc` 时 `register`，失败只 `log`，不冒泡；
`test/handoff-harness.mjs` 的假宿主**没有** `ctx.rpc`，506 项全过（日志 `rpc skipped: host has no ctx.rpc`），
说明老宿主路径被真实覆盖。

**存疑（无法本机验证）**：真机 `ctx.rpc.register` 的往返（definition 被宿主接受、handler 输出被宿主校验）。
与 impl-notes §6 一致，本机无 Desktop。代码侧已用 `Rpc.PortableDefinition` / `RpcHandlers` 类型对齐
（`node_modules/@opencode/plugin/dist/promise/rpc.d.ts`），且 `HandlerOutput<JsonSchema>` 退化为 `unknown`，
直接返回 payload（不需要 `{value}` 包装）——所以形状是对的，只差一次运行时验证。

## 3. 产物 —— 通过

```
$ ls -l dist/gui-experimental.cjs
-rw-r--r-- 1 root root 13280 Nov 18 14:04 dist/gui-experimental.cjs

$ grep -o 'require("[^"]*")' dist/gui-experimental.cjs | sort | uniq -c
   1 require("@opencode/plugin/gui")
   1 require("solid-js")
   1 require("solid-js/store")
   1 require("solid-js/web")

$ grep -c "@opencode/" dist/index.js
1        # 唯一一处在注释里：`@opencode/client` is imported for *types* only.
$ grep -oE '^import[^;]*;' dist/index.js
import {...} from "node:fs";   node:path / node:os / node:crypto（仅此 4 条）
```

- GUI 产物 `exports.default = ...`（tail 确认），无 `electron`、无 `node:*` require。
- server 产物**零 `@opencode/*` 运行时 import**（对照 0.2.0 构建：`git archive HEAD` 到 `/tmp` 用同一
  node_modules 重跑 `vp pack`，`dist/index.js` 的 `@opencode/` 计数同样是 1，且同样在注释里 →
  **本改动没有引入任何新的运行时依赖**）。
- `npm pack --dry-run` → 8 个文件，含 GUI：

```
npm notice 28.4kB CHANGELOG.md
npm notice 15.0kB README.md
npm notice 13.3kB dist/gui-experimental.cjs
npm notice 961.9kB dist/index.d.ts
npm notice 279.3kB dist/index.js
npm notice 1.8kB package.json
npm notice 6.5kB skills/collab-coordination/SKILL.md
npm notice 11.8kB skills/collab/SKILL.md
```

- `package.json:21-23` `files` 含 `dist`；`:30-36` `exports["./gui-experimental"]` 指向 `.cjs`；
  **`package.json` 没有 `dependencies` 字段**（只有 devDependencies）→ 消费者零运行时依赖。

**GUI 构建失败不影响 server 产物（构造验证）**：在 `/tmp` 复制仓库、`vp pack` 后再用
`entry: 'src/does-not-exist.tsx'` 跑 GUI 构建：

```
GUI_BUILD_EXIT=1
--- server artifact after the failed GUI build ---
-rw-r--r-- 1 root root 961909 dist/index.d.ts
-rw-r--r-- 1 root root 279305 dist/index.js      # 完好
```

## 4. 构建改动 —— 通过

### 4.1 `vite` → `@voidzero-dev/vite-plus-core` 别名：**必要，且就是本工具链的标准做法**

我用官方 `vite@7.3.8` 在 `/tmp` 复制仓库里复现了你记录的那条错误（不是猜测）：

```
$ pnpm install --no-frozen-lockfile --offline      # vite: ^7.3.8
$ ./node_modules/.bin/vp pack
error: Failed to resolve pack command: GenericFailure, Expected @voidzero-dev/vite-plus-core@1.6.0,
but found vite@7.3.8 at .../node_modules/vite/package.json. Run `vp migrate` to align the Vite alias,
then run `vp install`.
```

而且 vite-plus 自己的迁移代码里就写着「pnpm 必须保留一条**直接** `vite` 边并指向 core」
（`node_modules/.pnpm/vite-plus@1.6.0_*/node_modules/vite-plus/dist/create/bin.js:4750-4761`：
`vite-plus-core there (and for 'vp why vite' to show it) rather than pnpm auto-installing an upstream Vite
to satisfy Vitest's peer ... Migration points that edge at the workspace catalog`）。所以别名不是绕路，
就是 `vp migrate` 的建议产物。

- 对 `vp pack`：`pnpm build` 通过（见 §6）；对 typecheck：通过（`tsc --noEmit` exit 0）。
- `pnpm why vite` → 全图**只有** `@voidzero-dev/vite-plus-core@1.6.0`（`Found 1 version`）；
  `.pnpm/vite@7.3.8_*` 是 store 里的陈旧目录，不在本项目依赖图里。
- `vite.gui.config.ts:1-2` 只 `import { defineConfig } from 'vite'` + 宿主 `gui()` preset，
  `@opencode/plugin/dist/gui/vite.js` 本身不 import `vite`（只 `node:module`/`node:path`/`vite-plugin-solid`），
  所以别名不会把 GUI preset 绑到别的 API 上。

### 4.2 `pnpm-workspace.yaml: allowBuilds: esbuild`：**必要，且最小**

`/tmp` 复制仓库（拷 `package.json` + `pnpm-lock.yaml`，**不带** `pnpm-workspace.yaml`）离线安装：

```
Packages: +389 ...
Error: ERR_PNPM_IGNORED_BUILDS
  × installing dependencies
  ╰─▶ Ignored build scripts: esbuild@0.28.2
  help: Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

→ 没有这个文件 `pnpm install` 直接失败（pnpm 12）。文件内容只有 `allowBuilds: { esbuild: true }`（2 行），
不含 `packages:`，不会把仓库变成多包 workspace；单包仓库下只影响 esbuild 的 postinstall。
**文档**：CHANGELOG 0.3.0「Changed」已写清原因与「只是安装期声明，不影响产物」；README「开发」段没有提，
建议补一行（非阻塞，N4）。

## 5. GUI 行为 —— 部分不通过（1 条不成立，2 条通过）

### 5.1 ❌「2 s 轮询只在可见时」——**不成立（文档/注释超出实现）**

代码：`src/gui.tsx:402-409`

```ts
createKeyed(
  () => !pageHidden() && ctx.sessions.list().length > 0,   // pageHidden() 是普通全局读，不是信号
  () => {
    void store.load();
    const timer = setInterval(() => void store.load(), POLL_MS);
    onCleanup(() => clearInterval(timer));
  }
);
```

`pageHidden()`（`gui.tsx:81-85`）读 `globalThis.document.hidden`——**没有订阅**，产物里
`grep -c "visibilitychange" dist/gui-experimental.cjs` → `0`，`grep -c "addEventListener"` → `0`。
因此：

1. 「窗口变隐藏 → 停」不成立：已启动的 `setInterval` 只受 `createKeyed` 的 key 变化或 owner 结束影响，
   而 key 不会因为 `document.hidden` 变化而重算 → **后台仍在每 2 s 拉一次**。
2. 「挂载时窗口已隐藏 → 之后变可见」也不会自动开始：source 只在被跟踪的信号（`sessions.list()`）变化时重算。
   若插件加载时窗口在后台且已有会话挂载，面板/pill 可能一直没有数据，直到 shell tab 列表发生变化。

而 `gui.tsx:399-400` 的注释（「`pageHidden()` pauses it while the window is in the background」）、
README（「有会话挂载时每 2 s 拉一次（页面隐藏时停）」）、`docs/collab.md` §11.11、CHANGELOG R4 都断言了
「页面隐藏时停」。**三处文档 + 一处注释与实现不一致**。

- 影响：低。每 2 s 一次只读快照的实测成本很小（见 5.3 的 2.3 ms）；后台多拉几次不会崩。
- 但这是「文档承诺 > 实现」的典型，必须二选一：**(a) 删掉文档/注释里的「页面隐藏时停」，改成
  「有会话挂载时每 2 s 拉一次（与 pill 共用）」；或 (b) 补一个 `visibilitychange` 信号**
  （`createSignal(document.hidden)` + `addEventListener('visibilitychange')`，在 `onCleanup` 里移除），
  再让 key 读那个信号。推荐 (b)（既省电又让文档成真），(a) 是 5 分钟改法。
- 另注：design.md §3 写的「**面板**可见时轮询，不可见时停」本身与 R3（pill 需要数据）矛盾；
  实现选择「有会话挂载就轮询」是合理的扩展，但应回写 design.md（目前只写在 impl-notes §4）。

### 5.2 ✅ 不可达占位不崩溃 —— 通过（静态路径验证；无 DOM 测试）

- 失败路径：`gui.tsx:111-130` `try { rpc } catch { setState({ error, loading:false }) }`，
  **保留上一份 `data`**；渲染 `gui.tsx:310-315` 顶部「server 不可达 + 原因」，`:316-330`
  在没有 data 且没有 error 时才显示 loading/empty → 不会空白。
- `store.load` 里有 `inFlight` 去重（`:112`）、`disposed` 早退（`:113,118,123`）、
  `setInterval` 在 `createKeyed` 的 run owner 里 `onCleanup(clearInterval)`（`:407`）。
- 覆盖度说明：没有 headless DOM 测试（本机无 jsdom / 无 Desktop），所以这条只有**代码路径 + 类型**
  证据；宿主文档保证 render 抛错只影响该贡献（`registries.d.ts:299-301`「A render that throws renders
  nothing and records the error」）。

### 5.3 ✅ 面板/pill 数据与 `collab_locks` / `collab_list` 一致 —— 通过（11/11）

`locks` 复用 `stateOf()`（`snapshot.ts:61-75`），`handoffs` 用 `allBroadcasts()` +
`BCAST_DONE_STATES` 过滤（`snapshot.ts:77-93`），与 `tools/list.ts:113-118`（`workspace` 过滤 + 非已决）
和 `locksFor()`（`locks.ts:715-725`）是同一读取层。

我的构造断言（`/tmp/opencode/collab-check/c2-review/consistency.mjs`：用**真工具** `collab_lock`
造出「a1 持有 + a2 排队 + a2 另持有一个 shared」，再对比快照、`collab_locks`、`collab_list`）：

```
  ✓ collab_lock acquire really held it — 已获得资源租约: named:test-window
  ✓ collab_lock wait:true really queued — 已进入排队: named:test-window  排第 1 位
  ✓ snapshot: test-window held by a1 with a2 as the only waiter — {"holders":["ses_a1"],"waiters":1,"waiting":["ses_a2"],"mode":"exclusive"}
  ✓ collab_locks prints the same holder — holders=ses_a1  剩余=15m  waiters=ses_a2#1:exclusive
  ✓ collab_locks prints the same queue head — waiters=ses_a2#1:exclusive
  ✓ snapshot: a2 shared lease on named:docs is present with mode shared
  ✓ pill would read "lock 1 · wait 1" for a2 — 1/1
  ✓ collab_list reports the same 1 held / 1 waiting for a2 — 1/1 vs pill 1/1
  ✓ snapshot: only the open hand-off is listed — [["b_cccccccccccc","claimed"]]
  ✓ collab_list lists the same single open hand-off
  ✓ snapshot and collab_list agree on "claimed"/承接人

=== 11/11 consistency checks passed
```

pill 的取值逻辑（`gui.tsx:458-499`）与 `locksFor` 等价：`holders.includes(sid)` / `waiting.includes(sid)`，
排位 `waiting.indexOf(sid)+1`，`tone = 只持有 success / 排第 1 warning / 更靠后 danger`。
租约按持有者归组（`gui.tsx:174-185`），找不到已列会话就落「全局」——与 docs 描述一致。

**性能**（`/tmp/.../perf.mjs`：200 租约 + 200 交接 + 30 会话）：
`median 2.3 ms, max 3.2 ms` 每快照 → 2 s 轮询可接受（`MAX_STORED = 50` 会让交接记录自然收敛）。

### 5.4 ⚠️ 面板「自动出现」的文档断言不成立（与 5.1 并列的第二处文档问题）

README「侧边栏」表里写：「关掉后同样用这个入口找回（tab 带 `fallback`，宿主没存过选择时会优先选它）」。
按宿主类型文档：

- `Panel.list` 的 `open` 是「this plugin's stored tab ids in the strip」(`registries.d.ts:293-302`)；
- `fallback` 是「Opts into fallback selection: the first eligible regular tab, then a pinned tab」(`:182-183`)，
  只能从**已列出**的 tab 里选。

`gui.tsx:432` `list: input => (input.open.includes(PANEL_TAB) ? [tab] : [])` → 全新安装时 `open` 为空 →
`list` 返回 `[]` → 没有可兜底的 tab → **面板不会自己出现**，必须点 + 菜单的「打开协作面板」（`gui.tsx:438-451`，
这条 launcher 是完整可用的）。所以：

- 功能上没问题（Acceptance「侧栏出现 collab 面板」可用 launcher 达成）；
- 但 README 那句括号会让人以为「装了就自动出现」；impl-notes §6 自己也把它列为未验证。
  建议改为「首次从侧栏 + 菜单 →『打开协作面板』打开；关闭后同一入口找回」，或改 `list` 让它常驻
  （`pinned: true` 或忽略 `open`）。

## 6. 回归 —— 通过

```
$ pnpm install
Already up to date
Done in 7ms using pnpm v12.21.0

$ pnpm build
ℹ dist/index.js    279.31 kB │ gzip:  88.38 kB
ℹ dist/index.d.ts  961.91 kB │ gzip: 138.47 kB
✔ Build complete in 7140ms
dist/gui-experimental.cjs  13.28 kB │ gzip: 4.33 kB
✓ built in 166ms

$ pnpm typecheck
$ tsc --noEmit            → exit 0
（--listFiles 确认 GUI 真的被检查：src/gui.tsx / src/rpc.ts / src/core/snapshot.ts / vite.gui.config.ts）

$ pnpm test
=== 506/506 checks passed
=== 12/12 checks passed
=== 18/18 checks passed

$ node scripts/check-skill.mjs
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
```

- **既有 506 无删改**：`git diff --name-only -- test/` 为空（`test/handoff-harness.mjs`、
  `test/readonly-default.mjs` 均未被改动），只新增 `test/snapshot-shape.mjs`。
- 说明：README 里「498 项 harness」是 0.2.0 之前的陈旧数字（0.2.0 已 506），本次顺手改成 506，属文档修正。
- `dist/` 在 `.gitignore` 中，不会被提交；`npm pack` 已单独验证含 GUI 产物（§3）。

## 7. 安全 —— 通过

- `git diff src/constants.ts` 只有版本号 `0.2.0 → 0.3.0`；`BUILTIN_PROTECT`（`src/constants.ts:38`）
  两个 id 原样未动，`DEFAULTS.protect` 仍指向它。
- GUI 无写操作：产物里没有 `collab_lock`/`collab_unlock`/`release`/`acquire` 字面量，
  RPC 只有 `collab.state.snapshot` 一个方法（`rpc.ts:92-145`，`events: {}`）。
- 无新增运行时依赖：`package.json` 无 `dependencies`；`dist/index.js` 只 import 4 个 `node:*`；
  GUI bundle 只 require 宿主提供的 4 个模块（`solid-js` / `solid-js/store` / `solid-js/web` /
  `@opencode/plugin/gui`）。
- 复核期间未接触受保护会话、未改权限、未 restart、未 push；3 个临时构建实验全部在 `/tmp` 内完成
  （只 `cp` + `ln -s node_modules`，未写入本工作区）。

## 8. 范围 —— 通过（无越界）

`git status --short` 的全部条目都能对上任务边界：

| 文件 | 归类 |
| --- | --- |
| `src/rpc.ts` / `src/core/snapshot.ts` / `src/gui.tsx` / `vite.gui.config.ts` / `test/snapshot-shape.mjs` | 新文件，任务本体 |
| `src/index.ts`（RPC 注册 + cleanup + `__internals`） | 任务本体 |
| `src/constants.ts`（仅 `PLUGIN_VERSION`） | 发版必需 |
| `package.json` / `tsconfig.json` / `pnpm-workspace.yaml` / `pnpm-lock.yaml` | 已说明的 4 处环境/构建改动 |
| `README.md` / `docs/collab.md` / `CHANGELOG.md` / `skills/**` | 文档交付物 |
| `.trellis/tasks/11-18-collab-sidebar/{task.json,design.md,implement.md,research/}` | 任务管理 |

- `pnpm-lock.yaml` 的 804 行增量只来自 `vite` 别名 + `vite-plugin-solid` + `solid-js` 及其传递依赖
  （`babel-preset-solid` / `seroval` / `parse5` / `esbuild@0.28.2` …）；`@opencode/plugin` 仍是 `2.3.0`，
  `typescript` 仍是 `6.0.3`，**没有顺带升级**（lock 里版本号变化只是 peer facet 多了 `esbuild`/`solid-js`）。
  0.2.0 的 lock 里本来就有 `vite: '@voidzero-dev/vite-plus-core@1.6.0'` 这条 peer 边，别名与既有生态一致。

---

## 问题清单

### 必须在提交前处理（文档与实现不一致）

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| **N1** | `src/gui.tsx:399-400`（注释）、`README.md`「刷新」行、`docs/collab.md` §11.11「刷新」行、`CHANGELOG.md` R4 | 声称「页面隐藏时停」，实际没有 `visibilitychange` 订阅（产物 `addEventListener` 计数 0），后台仍在轮询；且「挂载时已隐藏 → 变可见」不会自动开始 | 二选一：(a) 改 3 处文档 + 1 处注释为「有会话挂载时每 2 s 拉一次（与 pill 共用）」；(b) 用 `createSignal(document.hidden)` + `visibilitychange` 订阅（`onCleanup` 移除）让它成真。推荐 (b) |
| **N2** | `README.md`「侧栏 `collab` 面板」表格单元（`fallback` 括号） | 断言「宿主没存过选择时会优先选它」；但 `Panel.list` 未列出时 `fallback` 无对象可选 → 首次不会自动出现 | 改为「首次从侧栏 **+** 菜单『打开协作面板』打开」；若要自动出现，改 `list` 常驻或 `pinned: true`（然后真机验证） |

### 低风险 nit（可后续，不阻塞）

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| N3 | `src/index.ts:155-161` | register 失败后日志会出现两句：`rpc registration failed: ...` 紧跟 `rpc skipped: host has no ctx.rpc`（后者在失败分支上是误导） | 用三元区分：`rpcRegistration ? 'rpc ok' : rpcDomain ? 'rpc unavailable (registration failed)' : 'rpc skipped: host has no ctx.rpc'` |
| N4 | `README.md`「开发」段 | 没有提 `pnpm-workspace.yaml`/`allowBuilds`（CHANGELOG 已提） | 补一行：`pnpm install` 依赖该文件放行 `esbuild` 的构建脚本，勿删 |
| N5 | `src/core/snapshot.ts:104` vs `src/tools/list.ts:47` | 快照固定 `limit: 100`，`collab_list` 默认 `limit: 20`（上限 100）→ 会话多于 20 时面板列得比默认 `collab_list` 多 | 可接受（面板是全局视图），建议在 docs 注明口径；或让快照也走可配的 limit |
| N6 | `src/gui.tsx:235, 461-464` | `lock.waiting.includes(...)` / `snapshot.locks.filter` 假定字段一定存在；experimental API 下若服务端版本错配返回「部分形状」，`show`/render 会抛（宿主只保证 render 抛错被记录，`show` 未文档化） | 加防御默认：`(lock.waiting ?? [])`、`(snapshot.locks ?? [])` |
| N7 | `src/core/snapshot.ts:115` vs `:133` | `{workspace}` 过滤时 session 允许「workspace 未知」的条目（与 `chain.listSessions` 一致），handoff 却丢弃无 workspace 的记录（与 `collab_list` 一致）——两者口径不同 | 目前 GUI 不传 `workspace`，无实际影响；若以后要用这个入参，先明确口径 |

## 风险清单（提交后仍需关注）

1. **真机未验证**（与 impl-notes §6 同）：Desktop 中面板是否出现（需 launcher）、pill 观感、
   `ctx.rpc` 真机往返、窄屏 `mobile.kind:"menu"` 入口、Settings 里单独关闭 GUI。
   本地能做的都做了（类型、契约、产物、构建隔离）；剩下必须真机。
2. **experimental GUI API 漂移**：`@opencode/plugin` 的 `./gui` / `./gui/vite` 形状若变，
   `vite-plugin-solid` / `gui()` preset / `Panel`/`ComposerPill` 字段可能一起变；README 已锁 `2.3.x`，
   但 `^2.3.0` 的 devDep 仍会漂到 2.4+（建议 CI 里把「Desktop 冒烟」列入发版清单，而不是只依赖 `^`）。
3. **文档-实现漂移的历史包袱**：N1/N2 都属于「实现没做/没验，文档先写了」，建议在本轮就改掉，
   否则下一个会话会按文档去查后台轮询/自动出现。
4. **面板不区分 `[protected]`**：租约列表里受保护会话只是普通 sid（`collab_locks` 会标 `[protected]`）。
   设计没要求，但读面板的人可能误以为是可抢占对象——可考虑后续加标记（非本任务范围）。
5. `snapshot()` 不消费 RPC 的 `signal`：客户端取消后，`session.list` 仍会跑到 3 s 超时。
   只读、有上限，可忽略。

## 是否可提交

**可提交（代码质量层面没有阻塞项）**，条件是：

1. 先处理 **N1 / N2** 两处文档断言（改文档约 5 分钟；或按 N1(b) 补 `visibilitychange`，约 20 行）；
2. 提交信息里如实写「Desktop 真机渲染与 RPC 往返未验证」（和 impl-notes §6 一致）；
3. 不要 `git add -A`：本次改动跨 `src/`、`test/`、`package.json`、`tsconfig.json`、`pnpm-workspace.yaml`、
   `pnpm-lock.yaml`、文档与 `.trellis/tasks/...`，按文件清单提交。

若 Owner 判定 N1/N2 属「先记文档债、下轮修」，则**不建议在本轮发版说明里保留「页面隐藏时停」和
「fallback 自动出现」这两句**——它们是唯一会被用户立刻证伪的断言。
