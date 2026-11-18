# 实施记录：Desktop 入口 + TUI 侧栏折叠（0.5.1）

> 任务：`.trellis/tasks/11-18-collab-entrypoints`（prd.md / design.md / implement.md）
> 结果：`pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs` 全绿；
> 测试 **638 + 12 + 35 + 29 + 20**（TUI 17→29，新增 GUI 入口 20）。无 git 写操作。

## 1. 改动清单

| 文件 | 内容 |
| --- | --- |
| `src/gui.tsx` | `Command collab.open`（`mod+shift+l` / `/collab` / `navigation`）、`Slot at "session.header"` + `HeaderCounts`、`.collab-counts` CSS、i18n `command.*` / `header.*`（en+zh） |
| `src/tui.tsx` | `SidebarSummary` 折叠/展开（`expanded` signal、`▸`/`▾`、≤4 行 + `+N`、明细行开面板）、`sidebarRows()` 派生、`NO_SESSION` 常量复用 toast 文案、`DETAIL_LIMIT` |
| `test/gui-entry.mjs`（新） | 20 项：直接 require 构建产物 `dist/gui-experimental.cjs` |
| `test/tui-render.mjs` | 17 → 29 项：真实鼠标事件的折叠/展开/跳面板/`+N`/降级 |
| `package.json` | `0.5.1`；`test` 追加 `node --conditions=browser test/gui-entry.mjs` |
| `src/constants.ts` | `PLUGIN_VERSION = '0.5.1'` |
| `README.md` / `docs/collab.md` / `skills/collab/SKILL.md` / `CHANGELOG.md` | 入口、降级、版本 |

不改：`src/rpc.ts`（快照契约零新增字段）、`src/core/**`、`Panel` / `MenuItem` / `ComposerPill` 的既有语义。

## 2. GUI 测试走了哪条路（design §4 的分支判定）

design 给的路是「先试着 require bundle；require 不了就抽 `gui/entries.ts` 纯函数」。**实测走了 require 路线**，
没有抽 `entries.ts`（bundle 保持单一入口，测试断言的是宿主真正加载的那份产物）。两个坑，都是加载期而非渲染期：

1. `@opencode/plugin/gui` 的 `exports` 只有 `import` 条件 → CJS `require` 直接
   `ERR_PACKAGE_PATH_NOT_EXPORTED`。测试里用 `Module._resolveFilename` 把裸 specifier 映射到
   `node_modules/@opencode/plugin/dist/gui/index.js`，Node 的 `require(esm)` 随即加载同一个 ESM 实例。
   （不依赖模块身份：registry token 是 `{ kind:"registry", id }`，断言比对 `registry.id`。）
2. 新增的 `onClick` 让 Solid 把 `delegateEvents(["click"])` 发射到**模块顶层**，它在浏览器构建里读
   `window.document`；而 GUI bundle 又必须用 `--conditions=browser`（否则 `solid-js/web` 是 server 构建，
   `template()` 直接抛 client-only API）。所以测试在 require 之前垫一个
   `document = { addEventListener(){} , removeEventListener(){} , createElement(){ throw } }`。
   **模板体是惰性创建的，测试从不渲染 DOM**，`createElement` 一旦被调用就 fail-fast（说明有人真的开始渲染了）。

严格 context：假 ctx 是 `Proxy`，读到未提供的键就抛错 → 证明 `setup` 只用
`add / t / plural / layout / sessions / client / id / options`（没有任何 `ctx.session` / 工具 / 权限 API）。
`sessions.list()` 返回 `[]` 使 `createKeyed` 的轮询条件不成立 → 断言 `calls.length === 0`（入口不新增 RPC 流）。
最后一组（2 项）让 `sessions.list()` 返回一个会话把轮询打开：等 120ms 后断言**只有 1 次**调用、且入参带
`session: "ses_probe"`（`queue` 才是真值），并断言这次加载不会自己打开面板。

**没有覆盖的部分（诚实说明）**：`HeaderCounts` 的渲染分支（无快照隐藏 / 错误显示 `n/a` / 文本拼接）没有在
GUI 侧做 DOM 渲染断言——本仓没有 jsdom，也不允许加依赖。它被三段间接覆盖：
① `Slot.at === "session.header"` 且 `render` 存在；② 两个 locale 的 `header.*` 键 + `header.counts`
三参数插值（`锁 2 · 交接 1 · 队列 0`）；③ TUI 侧同一份 store 的同三个数字（渲染级）。渲染分支的最终确认
是 Desktop 手工验收（prd 验收第 1、2 条）。

## 3. TUI 断言实际是怎么触发的（不是「props 里有函数」）

`@opentui/solid` 的 `testRender` 返回 `mockMouse`，它把 ANSI 鼠标序列写进 `renderer.stdin`，由渲染器自己做
命中测试并 `processMouseEvent` 派发到命中的 renderable。所以：

- **折叠态**：`captureCharFrame()` 里只有一行且以 `▸` 开头、不含 `🔒`；
- **展开**：`setup.mockMouse.click(2, 0)`（点摘要行，x=2 落在 `▸` 文本内）→ `sleep(80)` + `renderOnce()`
  → 帧里 `▾` + 4 行明细，且**逐行核对顺序**：`🔒 named:test-window` → `🔒 named:build` →
  `→ b_00000000a1` → `⇢ q_1_aaaa`（行数 = 1 + 4）；
- **点明细行**：`click(3, 2)`（第 2 条明细行）→ 假 host 的 `panel.open` 记录到 `"collab.status"`；
- **再折叠**：`click(2, 0)` → 回到 1 行 `▸`，且 `🔒` 消失；
- **不新增轮询**：展开前记 `calls.length`，展开后、折叠后都与它相等（侧栏只在挂载时 load 一次）；
- **`+N`**：6 个租约的假快照 → 4 行明细 + 第 5 行 `+2`（且 `named:window-5` 不出现）；
- **降级**：空快照 → `无协作活动 · 点击打开面板`；无快照（RPC 失败）→ `collab: n/a · 点击打开面板`
  （并断言**没有**「无协作活动」）；`panel.open` 返回 `false` → 既有 toast「先打开一个会话…」，且折叠仍可用。

`wrapMode="none"` 保证「一行明细 = 一个 `<text>` 行」，否则窄侧栏会折行、`+N` 的行号与点击坐标都会漂。

## 4. 设计取舍 / 与 design 的差异

- **`SidebarRow` 去掉了 `id`**：`<For>` 不需要 key，5 行以内重建无成本；留着就是死字段。
- **空/不可达的展开行**：design 只写了「无数据时 `无协作活动 · 点击打开面板`」。实现区分了三种状态
  （`loading` → `collab: …`；`error` 无快照 → `collab: n/a · 点击打开面板`；有快照但零行 → 无协作活动），
  因为把「server 不可达」说成「无协作活动」是假消息。
- **Cmd 的 `enabled` 用 `!!ctx.sessions.current()`（与 design 一致）而非 getter**：`ctx.add` 的函数形式
  会在读到的响应式值变化时重跑工厂，所以它仍然跟随路由变化。
- **计数条在「有数据 + error」时显示 `collab: n/a`**（design 只说了 `error → n/a`）：不可达时数字是陈旧的，
  和面板的横幅一致地提示「这份数字不一定新」。
- **`ctx.layout.open` 没加 `{ background: true }`**（design 原文无 options）：命令的语义就是「把面板拿出来」。
- **GUI 的那次快照请求加了 `session: <路由会话>`（design 未写，但 R2 的 `队列` 需要它）**：契约里
  `queue` 是「本人提交给受保护会话的请求」，**不传 `session` 就是空数组** —— 照 design 原样，
  桌面计数条的 `队列` 会永远显示 0，正是本版要消灭的「假 0」。仍是同一次调用/同一条流，
  `sessions` / `locks` / `handoffs` 的返回不受影响，面板本来也不读 `queue`。

## 5. 已知风险

1. **`mod+shift+l` 是否与宿主内置绑定冲突**：无法在本仓验证（要真机）。`bind` 只是默认值，用户可在
   Settings → Shortcuts 改；即使被占用，命令面板与 `/collab` 仍可用。真机验收时请顺手确认一次。
2. **宿主把 `sidebar.content` 固定成一行高度** → 展开内容被裁剪（不崩溃）。已在 `docs/collab.md` §11.11.3
   与 README 写明降级（`/collab` / `ctrl+shift+l`）。
3. **宿主未开鼠标** → TUI 的点击无效（同上的降级路径）；`onMouseDown` 在无鼠标环境下不会被触发，也不会抛。
4. **老 server 缺 `queue` 字段**：GUI 侧没有 normalize（0.4.2 起未改），计数条用 `data.queue?.length ?? 0` 兜底。
