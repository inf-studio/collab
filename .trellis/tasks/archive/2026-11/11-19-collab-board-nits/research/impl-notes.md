# impl-notes — 0.6.1 看板收尾（3 条 nit）

任务：`.trellis/tasks/11-19-collab-board-nits`（R1 单一真源 / R2 孤儿纯单测 / R3 按键分派）

最终验证（本机，全部跑过）：

```
pnpm build      → dist/index.js + dist/gui-experimental.cjs + dist/tui.js（0 错误）
pnpm typecheck  → tsc --noEmit，0 错误
pnpm test       → 735/735 · 12/12 · 20/20 看板 · 50/50 · 49/49 TUI · 47/47 GUI 入口 · 17/17 GUI 面板
node scripts/check-skill.mjs → ✓ collab / ✓ collab-coordination → skills ok
```

工具数仍 **20**（harness `S98 collab_freeze is registered exactly once (19 → 20 tools)` 通过）。
版本三处一致 = `0.6.1`（`package.json` / `src/constants.ts` `PLUGIN_VERSION` / `src/gui.tsx`），
构建产物里 `dist/index.js`、`dist/gui-experimental.cjs` 均含 `0.6.1`。

---

## 1. R1 去重后的调用链（一处实现，两个入口）

```
src/core/freeze-pure.ts          ← 唯一实现（零 node: 导入）
  FreezeKeys / FrozenHit
  freezeFor(entries, keys)       session(自身→祖先) > bid > workspace
  freezeMarker(entry)            FreezeEntry → SnapshotFreeze（渲染用形状）
  liveFreezes(entries, now)      until > now（唯一的过期判定）
  liveFreezeMarker(marker, now)  快照自带的 marker 是否仍然有效
        │
        ├── src/core/freeze.ts  `import … from './freeze-pure.ts'` + `export { … }`
        │     └─ 服务端调用方路径不变：snapshot.ts / tools/list.ts / index.ts(__internals)
        │        / frozenBy / freezeNotice / mergeFreezes
        └── src/core/board.ts   `import { freezeFor, freezeMarker, liveFreezeMarker, liveFreezes }`
              buildBoard → freezeOf(session, ancestors, live, now)
                          = liveFreezeMarker(session.frozen, now)   // 快照已算好，优先
                            ?? freezeFor(live, { session, ancestors, workspace }) → freezeMarker(…)
```

为什么必须拆出纯模块（**这是对 `implement.md` 文件清单的唯一增量：新增 `src/core/freeze-pure.ts`**）：

- GUI 构建（`@opencode/plugin/gui/vite`）把 Node 内建**外置**：`isBuiltin(source)` → `{ external: true }`，
  CJS 产物里变成顶层 `require("node:fs")`，而桌面窗口没有 `require` → 面板加载失败。
- 实测探针（临时把 `freeze.ts` 接进 `board.ts`，只跑 `vp build -c vite.gui.config.ts`）：

  ```
  dist/gui-experimental.cjs  30.56 kB
  $ grep -o 'require("node:[a-z]*")' dist/gui-experimental.cjs | sort -u
  require("node:crypto")
  require("node:fs")
  require("node:os")
  require("node:path")
  （另含 homedir / collab-freeze.json 字面量）
  ```

  还原（走 `freeze-pure.ts`）后同一命令：

  ```
  dist/gui-experimental.cjs  30.36 kB（最终构建 30.3x kB）
  $ grep -c 'require("node:' dist/gui-experimental.cjs
  0
  ```

所以 design.md 里「`import { freezeFor } from './freeze.ts'`」无法照抄；改为「`freeze.ts` 持有公共出口
（服务端照旧从它导入），`board.ts` 导入同一实现所在的纯模块」。**唯一实现仍只有一份**：

```
$ grep -rn "function freezeFor" src/
src/core/freeze-pure.ts:49:export function freezeFor(entries: FreezeEntry[], keys: FreezeKeys): FrozenHit | undefined {

$ grep -n "until\|scope ===" src/core/board.ts
（空）
```

行为：`buildBoard(snapshot, freezes, now)` 语义写进注释 —— `freezes` 应是 `readFreezes(now)` 的输出
（已过滤过期）；board 还额外用同一个 `liveFreezes` 兜底，因此老的/手写调用方传入原始列表也不会画出过期冻结
（0.6.0 的既有断言 `BD frozen uses the snapshot marker first and the freeze list second (expired freeze ignored)`
仍然通过）。`session.frozen` 的过期只看 `liveFreezeMarker`。

## 2. R2 `boardOrphans` 纯单测（`test/board-shape.mjs`，13 → 20 项）

`src/index.ts` 的 `__internals` 增 `boardOrphans`（与 `buildBoard` 同一 import 行来源 `./core/board.ts`）。
新增断言：

| # | 断言 | 覆盖点 |
| --- | --- | --- |
| 1 | `__internals exports boardOrphans` | 导出在（此前只有端到端覆盖） |
| 2 | `a lease no session row holds is an orphan lock (and only a lock)` | 孤儿锁：`sessions: []`、holder 不在列表 → `locks=[named:gone-window]`、另两类空 |
| 3 | `a hand-off neither started nor claimed by a listed session is an orphan` | 孤儿交接：`from`/`claimBy` 都不在列表 → `handoffs=[b_orphan]`，且没有任何会话行持有它 |
| 4 | `a queue item the caller's own row claimed is not an orphan` | 队列被认领（`buildBoard(..., me)`）→ `orphans.queue=[]`，行内 `queue[0]`、`badges.queue===1` |
| 5 | `the same queue item with no me … it is an orphan` | 同一夹具去掉 `me` → `orphans.queue=[q_mine]`（让 queue 分支真的可被变异打掉） |
| 6 | `when every row is claimed all three orphan lists are empty` | 全部被认领 → 三类空；行内各有 1 条（不是重复行） |
| 7 | `freeze precedence comes from freezeFor: session (self or ancestor) beats the workspace freeze` | R1 的派生断言（见 §4 变异 ②） |

## 3. R3 按键分派按宿主形状（`test/tui-render.mjs`，44 → 49 项）

新增两个 helper（测试侧，模拟宿主，不改实现）：

```js
// 宿主：读每个 layer 工厂 → 跳过 enabled()===false 的层 → 跑绑定到该键的命令
function hostPress(target, bind) { … return ran; }
function boardLayerOf(target) { /* 含 enter 绑定的那一层 */ }
```

`enabled()` 在 **layer** 上（不在 command 上，0.6.1 调试实测：`command.enabled === undefined`），
所以断言都走 `boardLayerOf(...).enabled()`。

替换/新增的断言：

- `R4 the layer is enabled while the panel is current and focused (the host would dispatch)` — `enabled()===true`；
- `R4 the host dispatches one enter to the board layer` — `hostPress(tree,'enter') === 1`；
- 原来直接 `run()` 的 `j`/`j`/`enter` 改为 `hostPress(tree, 'j')` …（同一渲染断言保留）；
- `R3 the current, focused panel: enabled() is true`；
- `R3 an unfocused panel is skipped by the host: enabled() false, 0 commands run, nothing expands`
  （面板**仍然渲染**树，所以这是真断言：`▸ ses_a1` 前后不变、无 `↳`）；
- `R3 a background panel is skipped by the host (enabled() false, 0 commands run) and the board did not change`
  （切到 `someone.else` 按键 → 切回后树仍是折叠的 `▸ ses_a1`）；
- `R4 panel away→back leaves exactly one enabled board keyboard layer`（F2 保留）；
- `R4 one enter toggles once …`（`ran===1` + 只展开一次）、`R4 one j moves one row …`。

**未覆盖（实机待验，见 §6）**：宿主内部把 keybinding 映射到 command 的那一跳（无头环境拿不到真实键盘事件），
测试覆盖到「`enabled()` 门控 + `run()` 分派」为止。

## 4. 变异验证（原始输出，均已还原）

### ① 删 `boardOrphans` 的 queue 分支（`queue: (snapshot?.queue ?? [])…` → `queue: []`）

```
  ✗ BD boardOrphans: the same queue item with no `me` is not attached to any row — it is an orphan — {"orphans":[]}
=== 19/20 board checks passed
FAIL: BD boardOrphans: the same queue item with no `me` is not attached to any row — it is an orphan
```

（该变异后 `pnpm exec vp pack` 重建 `dist`，未跑其它套件。）

### ② 冻结优先级改错（`freeze-pure.ts` 里把 workspace 判断挪到 session 之前）

```
  ✗ BD freeze precedence comes from freezeFor: session (self or ancestor) beats the workspace freeze —
    {"parent":{"scope":"workspace","target":"/data/project/beta",…,"reason":"beta 仓暂停"},
     "child":{"scope":"workspace","target":"/data/project/beta",…,"reason":"beta 仓暂停"}}
=== 19/20 board checks passed
FAIL: BD freeze precedence comes from freezeFor: session (self or ancestor) beats the workspace freeze
```

TUI 套件同时跑（49/49 通过）——TUI 树用的是快照自带 marker，不经过 board 的 freeze 回退，属预期。

### ③ 孤儿锁 / 交接分支同时删掉（`locks: []` + `handoffs: []`）

```
  ✗ BD boardOrphans: a lease no session row holds is an orphan lock (and only a lock) — {"locks":[],"handoffs":0,"queue":0}
  ✗ BD boardOrphans: a hand-off neither started nor claimed by a listed session is an orphan — {"handoffs":[],"locks":0,"queue":0}
=== 18/20 board checks passed
```

### ④ 去掉 `enabled()` 的聚焦判断（`src/tui.tsx`：`enabled: () => props.panel.name === PANEL`）

```
  ✗ R3 an unfocused panel is skipped by the host: enabled() false, 0 commands run, nothing expands — enabled=true ran=1
  ✗ R3 a background panel is skipped by the host (enabled() false, 0 commands run) and the board did not change — ran=0 / …
  ✗ R4 one enter toggles once (the tree expands after a single keypress) — ran=1 / … ▸ ses_a1 …
  ✗ R4 one j moves one row (ses_child expands, not 已归档 / not two rows) — … ▾ ses_a1 … ▾ ses_child …
=== 45/49 checks passed
```

（还原 `src/tui.tsx` 后 49/49；`git diff` 里没有 tui.tsx 的改动。）

## 5. 改动文件

- 新增 `src/core/freeze-pure.ts`（纯冻结判定，零 `node:`）
- `src/core/freeze.ts`（导入 + 再导出，删掉本地 `freezeFor`/`FreezeKeys`/`FrozenHit`；头部文档同步）
- `src/core/board.ts`（删本地 `freezeOf`/`marker` 副本，改调 `freezeFor`/`freezeMarker`/`liveFreezeMarker`/`liveFreezes`；`buildBoard` 注释写清 `freezes` 语义）
- `src/index.ts`（`__internals` 增 `boardOrphans`）
- `test/board-shape.mjs`（+7 断言：1 导出 + 5 孤儿 + 1 优先级；头注释）
- `test/tui-render.mjs`（`hostPress`/`boardLayerOf`；宿主门控断言；原有 `run()` 改走门控；头注释）
- `package.json` / `src/constants.ts` / `src/gui.tsx`（`0.6.1`）
- `CHANGELOG.md`（`[0.6.1]`：Changed / Tests / Docs）
- `README.md`（测试计数：20 项看板 / 49 项 TUI）
- `docs/collab.md`（§11.11.6 冻结行改为「`freeze-pure.ts` 的 `freezeFor`」，末尾补单一真源说明）
- 本文件

未改：`src/tui.tsx`、`src/gui.tsx` 的逻辑（仅版本常量）、`src/tools/index.ts`（不需要）、快照字段、工具数。

## 6. 实机待验项（未在本机执行）

1. **真实键盘分派（桌面 + TUI）**：重启 Desktop 后打开 `collab` 侧栏面板，焦点在面板内按 `enter` / `j` / `k`
   各一次：面板获得焦点时只展开一行/移动一行；切到输入框（面板失焦）后同样按键不再改变树。
   TUI 侧 `ctrl+shift+l` 打开面板后重复同一组按键（含 `space`），确认 `enabled()` 门控在真实宿主里同样生效。
2. **GUI 版本可见**：Desktop 重启后 titlebar `collab` pill 点击 → toast 里 `version=0.6.1`（GUI 要在重启后才会加载新 bundle）。
3. **发布后安装**：`opencode plugin add @inf-studio/collab@0.6.1`（Linux 需 reload/重启；mac 替换后版本可直接验证，GUI 要重启）。
4. **看板冻结显示**：在 `collab_freeze { scope:"session", … }` 与 `{ scope:"workspace", … }` 同时生效时，
   侧栏/面板该会话行只出现一个 `[frozen]`；过期（等到 `until`）后 2 s 轮询内消失。
