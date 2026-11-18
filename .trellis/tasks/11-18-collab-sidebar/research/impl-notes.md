# 实施笔记：协作侧边栏（C2，0.3.0）

任务：`.trellis/tasks/11-18-collab-sidebar`（父 `11-18-collab-coordination`）。
结论：**server 侧契约 + GUI 面板/pill + 构建 + 文档 + 回归全部完成**；
未验证项只有「Desktop 里的实际渲染」（本机没有 Desktop 可跑的实例），见 §6。

---

## 1. 真实 API 形状（以本机安装的 `@opencode/plugin@2.3.0` 为准）

不是猜的：读了 `node_modules/@opencode/plugin/dist/**` 的类型与实现，并对照
`https://opencode.ai/docs/build/plugins/gui` 与 `/build/plugins/rpc`。

### 1.1 server 侧（`@opencode/plugin` → `dist/promise/plugin.d.ts`）

```ts
interface Context {
  // …location / storage / session / tool / event / app …
  readonly rpc: RpcDomain
}

interface RpcDomain extends RpcApi<{ signal?: AbortSignal }> {
  readonly register: <const D extends Rpc.PortableDefinition>(
    definition: D,
    handlers: RpcHandlers<NoInfer<D>>,        // (input, { signal, error }) => Promise<HandlerOutput | HandlerError>
  ) => Promise<RpcRegistration<D>>            // { events.emit, dispose }
}
```

- `Rpc.PortableDefinition`（`@opencode/schema/rpc`）要求 `input` / `output` 是
  `StandardSchemaV1 | JsonSchema.JsonSchema`；`JsonSchema.JsonSchema` 在 effect 4 里就是
  **开放记录** `{ [x: string]: unknown }` → 纯 JSON Schema 字面量合法，**不需要 effect 运行时**。
- JSON Schema 的 `Input` / `Output` 在 TS 里退化为 `unknown`（文档明说「narrow them before use」），
  所以客户端必须 `as Snapshot`。
- 客户端：`ctx.client.rpc(Definition)` → `{ [method](input, options?) => Promise<unknown> }`。
  `input` 类型为 `unknown` 时**必须传一个参数**（`RpcArguments` 的第一个分支），所以我们调用
  `snapshot({})` 而不是 `snapshot()`。
- `Rpc.define` 只是 `id` + 保留名检查后原样返回；本包用
  `satisfies Rpc.PortableDefinition` 的对象字面量替代它，避免 `@opencode/schema` 进 server 产物。

### 1.2 GUI 侧（`@opencode/plugin/gui`）

| 用到的东西 | 真实签名要点 |
| --- | --- |
| `Plugin.define({ i18n?, stores?, setup, main? })` | 至少一个 setup；`setup` **同步**、返回 cleanup 或 void（返回 thenable 会被拒绝） |
| `Panel` | `{ id, region:"side", width?: number|"narrow", mobile?, list(input), render(props) }`；`list` 收 `{ session, screen, open }`，`render` 收 `{ tab, session, screen }`（`session` 是 getter，别解构） |
| `PanelTab` | `{ id, title, closable?: "compact"|"hover"|false, fallback?, pinned?, … }` |
| `ComposerPill` | `{ id, order?, show(input): ComposerPillView | undefined, menu? }`；`tone` 只给 **icon** 上色 |
| `MenuItem`（`menu:"session.panel"`） | 侧栏 **+** 菜单的 launcher：`{ id, title, icon?, opened?, run() }` |
| `Style` | `Registry<string>`，`ctx.add(Style, css)` 注入全局样式 |
| `createKeyed(source, fn, { otherwise })` | 给副作用一个 owner：source 为假时 `fn` 不跑；每次 run 有自己的 `onCleanup` |
| `usePlugin()` | contribution 内的同一个 ctx；`usePanel()` 只在 `Panel.render` 内可用 |

`gui()` preset（`@opencode/plugin/gui/vite`）实际做的事（读实现确认）：
`vite-plugin-solid` + `build.lib` 单文件 CJS + `inlineDynamicImports` +
`resolveId` 把 `pluginSharedModules` / `pluginWindowModules` / `electron` / Node 内建标为 external，
其它 `effect/*` `solid-js/*` `@opencode/*` 直接 `this.error`。

---

## 2. 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/rpc.ts`（新） | `collab.state.snapshot` 契约（纯 JSON Schema 字面量）+ `Snapshot*` 类型 |
| `src/core/snapshot.ts`（新） | `buildSnapshot(source, input, now)` / `createSnapshotReader`；注入式 reader（`sessions` / `locks` / `handoffs`） |
| `src/index.ts` | `ctx.rpc.register(CollabState, { snapshot })`（**可选**：`host.rpc` 缺失只打日志）；cleanup 里 `dispose()`；`__internals` 增 `CollabState` / `buildSnapshot` |
| `src/gui.tsx`（新） | `Panel` + `ComposerPill` + `MenuItem` + `Style`；2 s 轮询 store；不可达横幅 |
| `vite.gui.config.ts`（新） | `gui({ entry:'src/gui.tsx', outFile:'dist/gui-experimental.cjs' })` |
| `package.json` | `version 0.3.0`；`exports["./gui-experimental"]`；`build = vp pack && vp build -c vite.gui.config.ts`；`test` 串上快照测试；devDeps `vite` / `vite-plugin-solid` / `solid-js` |
| `src/constants.ts` | `PLUGIN_VERSION = '0.3.0'` |
| `test/snapshot-shape.mjs`（新） | 18 项：快照形状、过期租约、已决交接、workspace 过滤、契约字段、GUI 产物只 require 宿主模块 |
| `tsconfig.json` | `jsx: preserve` + `jsxImportSource: solid-js`；`include` 收 `**/*.tsx` 与 `vite.gui.config.ts` |
| `pnpm-workspace.yaml`（新） | `allowBuilds: { esbuild: true }`（见 §5） |
| `README.md` / `docs/collab.md` / `skills/**` / `CHANGELOG.md` | 「侧边栏（仅 Desktop，experimental）」章节 + 版本表 + 测试数量 |

### 数据来源（没有新状态）

```ts
createSnapshotReader({
  sessions: input => chain.listSessions(input),   // 与 collab_list 同一个
  locks: allLocks,                                // core/locks.ts
  handoffs: allBroadcasts                         // core/claim.ts
})
// 组装时只用 stateOf()（只读视图）与 BCAST_DONE_STATES 过滤
```

- 过期租约：`stateOf` 在内存里 `reap`，**不写盘**；`expiresInMs = 0`、`holders = []`。
- 无人持有且无人排队的记录：不出现（面板列的是「活动」，不是空记录）。
- `done/blocked/expired` 的 hand-off 不算「未闭环」。

---

## 3. 与 design.md 的差异（有意扩展，均已写入 CHANGELOG/docs）

1. **`locks[].waiting: string[]`**：design 只写了 `waiters: number`。只有长度无法回答
   「**当前会话**是否在排队」，而 R3 的 pill 必须回答。保留 `waiters`（计数）并**追加**
   `waiting`（FIFO 顺序的 sid 列表）。
2. **`sessions[].workspace`**：design 的 session 条目没有 workspace，但 R2 要求「按工作区分组」。
3. **`sessions[].parent`**：子会话一行可辨（`playwright`/`explore` 之类），不影响分组。
4. **`handoffs[].title`**：面板需要一行可读文本，否则只有 `bid`。
5. **租约的归属工作区是 GUI 推导的**：租约本身是全局的（`COLLAB_LOCK_DIR`），没有 workspace 字段。
   GUI 按「第一个是已列会话的持有者/排队者」归组，找不到就落「全局」组。**没有给租约记录加字段**。

---

## 4. 构建产物

```
pnpm build   # vp pack && vp build -c vite.gui.config.ts
dist/index.js              279.1 kB   （server；零运行时依赖，只 import node:fs/path/os/crypto）
dist/index.d.ts            961.9 kB
dist/gui-experimental.cjs   13.3 kB   （require 只出现：@opencode/plugin/gui, solid-js, solid-js/store, solid-js/web）
```

`npm pack --dry-run` → 8 个文件，含 `dist/gui-experimental.cjs`：
`CHANGELOG.md / README.md / dist×3 / package.json / skills×2`。

**GUI 构建失败不影响 server**：两条命令串行且各自独立产物，`dist/index.js` 不 import `src/gui.tsx`；
`vite.gui.config.ts` 的 `gui()` 设了 `emptyOutDir:false`，所以不会清掉 `vp pack` 的产物
（反过来说：先 `vp pack`（clean）再 GUI build，顺序不能反）。
**GUI 运行失败不影响 server**：宿主保证「server 失败则无 GUI；GUI 失败不影响 server」，
且插件内部 `ctx.rpc` 缺失/注册失败都只降级日志。

---

## 5. 环境相关（不在原计划的文件，必须说明）

1. **`vite` 必须指向 `@voidzero-dev/vite-plus-core`**。
   本项目用 `vite-plus`（`vp`）做 library build，它要求 `node_modules/vite` 是它的 core；
   直接装官方 `vite@7.3.8` 会让 `vp pack` 直接失败：
   `Expected @voidzero-dev/vite-plus-core@1.6.0, but found vite@7.3.8`。
   现在的 devDep 是 `"vite": "npm:@voidzero-dev/vite-plus-core@^1.6.0"`（`vp migrate` 建议的同一别名），
   `vp build -c vite.gui.config.ts` 走的就是这个 core（Vite 7 API，`gui()` preset 完全兼容）。
2. **`pnpm-workspace.yaml`（新文件）**：pnpm 12 把「允许运行构建脚本」的白名单放在这里；
   `esbuild`（vite-plus-core 的传递依赖）没有白名单时 `pnpm install` 以
   `ERR_PNPM_IGNORED_BUILDS` 退出 1。`package.json` 里的 `pnpm.ignoredBuiltDependencies`
   在 pnpm 12 **不生效**，只有 `pnpm approve-builds` 写的这个文件生效。
   内容仅 `allowBuilds: { esbuild: true }`，不影响产物；删掉它则 `pnpm install` 又会失败。
3. **`tsconfig.json` 被改动**（原计划没列）：不把 `src/**/*.tsx` 加进 `include` 并打开
   `jsx: preserve` / `jsxImportSource: solid-js`，`pnpm typecheck` 就完全看不到 GUI 代码。
   `lib` 仍只有 `ES2023`（不加 DOM），`document.hidden` 用 `globalThis` 的结构化类型读。
4. `pnpm add` 过程中 esbuild 的 postinstall 被批准并执行过一次（`approve-builds`），
   lockfile 已更新（`pnpm-lock.yaml`）。

---

## 6. 未验证项（明确列出）

| 项 | 现状 | 怎么验 |
| --- | --- | --- |
| Desktop 里侧栏真的出现 `collab` 面板 | **未验证**（本机没有可交互的 Desktop） | 装包后在 Desktop 打开任一会话，看侧栏；或 **+** 菜单 →「打开协作面板」 |
| `fallback: true` 是否会让面板「自动」出现 | **未验证**。`list` 只在 `input.open` 含 `main` 时返回 tab，按文档这是标准写法，但宿主「没存过也自动选中」的行为在本地 dist 里看不到实现 | 若没有自动出现，用 `+` 菜单（已提供 launcher）；必要时改成 `pinned:true` |
| pill 的 `tone` 观感（success/warning/danger） | 只验证了类型与取值逻辑，未看真机配色 | Desktop 里分别造「只持有 / 排第 1 / 排第 3」三种状态 |
| 面板在窄屏（`mobile.kind:"menu"`）的入口 | 只声明了 `mobile`，未验证菜单位置 | 把窗口拉窄到 <768px |
| `ctx.rpc` 的真实注册往返 | 单测只覆盖契约与快照组装；`register` 的真机返回未跑 | Desktop/server 起来后看 `rpc ok: collab.state.snapshot` 日志 + 面板有数据 |
| GUI 构建失败时 server 不受影响 | 逻辑上独立（两条命令、两份产物），**没有故意构造 GUI 失败来跑一遍** | `git stash` 掉 `src/gui.tsx` 之类的破坏性验证不建议在共享工作区做；可用 `vp build -c vite.gui.config.ts` 的退出码单独确认 |

---

## 7. 验收命令与结果

```
pnpm install                    → exit 0（Lockfile is up to date）
pnpm build                      → vp pack ✓ + vp build ✓（dist/gui-experimental.cjs 13.3 kB）
pnpm typecheck                  → exit 0（含 src/gui.tsx 与 vite.gui.config.ts）
pnpm test                       → 506/506 + 12/12 + 18/18
node scripts/check-skill.mjs    → skills ok
ls -l dist/gui-experimental.cjs → 13280 bytes
npm pack --dry-run              → 8 files，含 dist/gui-experimental.cjs
```

回归说明：`test/handoff-harness.mjs` 与 `test/readonly-default.mjs` 的假宿主没有 `ctx.rpc`，
走的正是「老宿主」分支（`rpc skipped: host has no ctx.rpc`），工具/注入行为零变化。
