# 实现记录：协作看板三层展开（0.6.0 子任务）

## 1. 派生规则（`src/core/board.ts`，纯函数无 IO）

```ts
buildBoard(snapshot, freezes = [], now = Date.now(), me?) => BoardWorkspace[]
```

| 项 | 规则 |
| --- | --- |
| `BoardWorkspace` | `{ workspace, sessions[], archived[], counts{sessions,locks,handoffs,archived} }`，按目录排序；只有锁/交接、没有会话的工作区也会出现 |
| `BoardSession` | `sid/title/agent/busy/workspace/archived/frozen?/urgent/locks/handoffs/spawned/queue/badges` |
| 租约归属 | `locks.filter(l => holders.includes(sid) || waiting.includes(sid))` |
| 交接归属 | `handoffs.filter(h => h.from === sid || h.claimBy === sid)` |
| owner 队列 | 快照 `queue` 是 `mineFor(session)`，只挂到 `me` 这一行（`buildBoard` 第 4 参；GUI 传 `props.session.id`，TUI 传 `panel.sessionID`） |
| `spawned` | `handoffs.filter(h => h.kind === 'spawn' && h.from === sid)`，子 id = `h.spawned ?? h.claimBy`，`state` 取交接 state，`archived` 取子会话 `archived` 或交接 `archived`；**只一层，不递归** |
| 归档分流 | `session.archived === true` 进 `archived[]`；活跃列表不含它们；`counts.archived` = 数量 |
| `urgent` | 该会话任一交接或队列项 `priority === 'urgent'` |
| `frozen` | 优先快照的 `session.frozen`（`until > now`），否则按传入 `freezes` 做 session（自身 → 祖先）> workspace 优先级匹配；过期条目不显示 |
| 老快照 | `archived/kind/spawned/priority` 缺失 = `false`/空；`undefined` 快照 = `[]`，不抛 |
| 只读 | 无任何写入；GUI/TUI 的展开状态都是组件本地信号 |

## 2. 快照 additive（`src/rpc.ts` + `src/core/snapshot.ts`）

- `SnapshotSession.archived?: boolean`：`toSession` 不再丢弃归档会话，改为 `archived:true` + `busy:false`。
- `SnapshotHandoff.kind?: 'handoff' | 'spawn'`、`spawned?: string`：
  `claim.kind === 'spawn'` → `spawned = claim.by`；`expiredClaim.kind === 'spawn'` 也保留（与 `archive.ts` 同口径）。
- 三个字段全部**不在 schema `required`**；方法签名与既有字段语义不变。
- `src/index.ts` 的 `__internals` 追加 `buildBoard`（单测入口），`package.json` 的 `test` 追加 `test/board-shape.mjs`。

## 3. GUI 渲染实测（`test/gui-panel.mjs` PN6，15/15）

默认帧（节选）：

```text
@board  collab
2 sessions · 1 leases · 2 hand-offs · 1 archived
▸ ses_board  build  🔒1 ‹2› ⇢1 [frozen] [urgent]  board worker  this session
▸ ses_child  build  ‹1›  child worker
▸ Archived 1
```

点击会话行后（`↳` 是 spawn 关系，不是 claimBy 的另一个 bid）：

```text
▾ ses_board  build  🔒1 ‹2› ⇢1 [frozen] [urgent]  board worker
  ↳ ses_child  claimed  child worker
  named:board-window  exclusive  ses_board  left 10m  mine
  b_board_spawn  claimed  1s  spawn the child
  b_board_urgent  open  urgent  2s  urgent thing
  q_board  ses_p  pending  1s  req
▸ ses_child  build  ‹1›  child worker
▸ Archived 1
```

点击 `已归档 1` 后出现 `▸ ses_old build [archived] archived worker`；等待 2.1 s（跨一次 2 s 轮询）后
`↳` 与已归档段仍然展开 —— 展开集合在 `createSignal<Set<string>>`，不在 store。

## 4. TUI 渲染实测（`test/tui-render.mjs`，40/40）

默认折叠（节选）：

```text
Collab · ses_probe · 16:00:00
持有 1 · 排队 0 · 待受保护 1 · 宿主排队 0
图例: 持有=真实持有者 · 排队=FIFO 等候 · …
collab            2 会话 · 1 锁 · 2 交接 · 1 已归档
›   ▸ ses_a1  build  alpha worker  🔒1 ‹2› [frozen] [urgent]
    ▸ ses_child  build  child worker  ‹1›
    ▸ 已归档 1
    q_tree …（未被会话行认领的队列，兼容块）
```

`enter` 展开第一项后：

```text
›   ▾ ses_a1  build  alpha worker  🔒1 ‹2› [frozen] [urgent]
    ↳ ses_child  claimed  child worker
    🔒 named:tree-window · exclusive · ses_a1 · 剩 10m
    → b_tree_spawn · claimed · 剩 10s
    → b_tree_urgent · open · 剩 20s [urgent]
```

`j`×2 → `enter` 展开 `已归档 1`，出现 `▸ ses_old build archived worker [archived]`。
鼠标：`mockMouse.click` 点击会话行同样展开（`↳` 出现）。侧栏仍为 `锁 1 · 排 3 · 待 2 · 宿 1`（未改）。

## 5. 变异验证（真会失败，已还原）

### 变异 1：spawn 关系画错（用 `claimBy` 当父）

`board.ts` 的 spawned 过滤由 `handoff.from === session.sid` 改成 `handoff.claimBy === session.sid`，重新构建后：

```text
  ✗ BD the spawn relation comes from kind:"spawn" + spawned (child is ↳, not the claimant of another bid) — []
=== 12/13 board checks passed
FAIL: BD the spawn relation comes from kind:"spawn" + spawned (child is ↳, not the claimant of another bid)
```

还原后 13/13。

### 变异 2：已归档默认显示

GUI `archived` 段 `<Show when={props.expanded(archivedKey())}>` 改为 `<Show when={true}>`；
TUI `const open = expanded.has(key)` 改为 `const open = true`，重新构建后：

```text
  ✗ R3 archived rows are hidden by default and only the folded header shows — … | ▾ 已归档 1 | ▸ ses_old  build  archived worker  [archived] | …
=== 39/40 checks passed
FAIL: R3 archived rows are hidden by default and only the folded header shows
  ✗ PN6 derived rows are folded by default: no ↳ and no archived row — "…▸ Archived 1▸ses_oldbuild[archived]archived worker…"
=== 14/15 panel checks passed
FAILED: PN6 derived rows are folded by default: no ↳ and no archived row
```

还原后 TUI 40/40、GUI 15/15。

## 6. 老快照兼容

`test/board-shape.mjs` 用一份只有 `sessions/locks/handoffs/queue` 的旧快照（无 `archived/kind/spawned/priority`）：

```text
✓ BD an old snapshot (no archived / kind / spawned / priority) does not crash and has no empty badges
✓ BD an absent snapshot is an empty board (never a throw)
```

旧字段缺失时 `archived=false / urgent=false / spawned=[] / badges` 全 0；`test/snapshot-shape.mjs` 也断言
`archived/kind/spawned` 均不在 schema `required`。GUI 与 TUI 共用 `boardOrphans(snapshot, board)`：对
`sessions` 为空的老回包 / 持有者或 `from` 不在列表的行，把未被会话行认领的锁/交接/队列以
`资源租约 (N) · 未归属`、`未闭环交接 (N) · 未归属`、`受保护目标队列 (N) · 未归属` 成段显示，不静默丢行。

## 7. 验证

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

结果：

```
735/735 handoff-harness
12/12 readonly-default
13/13 board-shape
50/50 snapshot-shape
44/44 tui-render
47/47 gui-entry
17/17 gui-panel
tools = 20
skills ok
```

## 8. 复核修复（F1 / F2 + nits）

复核报告：`research/check-report.md`（未改动）。修复后全绿，版本仍 0.5.3、工具仍 20。

### F1 GUI 孤儿行兜底

- `src/core/board.ts` 新增纯函数 `boardOrphans(snapshot, board)`：从 `board` 的全部活跃 + 归档会话收集
  `attachedLocks / attachedHandoffs / attachedQueue`，返回快照里未被认领的三类行。
- `src/gui.tsx` 新增 `OrphanView`，在树的 `For` 之后渲染三段，标题 `Leases (N) · unclaimed` /
  `Open hand-offs (N) · unclaimed` / `Owner queue (N) · unclaimed`（zh：`资源租约 (N) · 未归属` 等）；
  `Show when={groups().length || hasOrphans()}` 保证「只有孤儿队列、没有任何组」时也不落到 “No activity”。
- TUI 改为调用同一个 `boardOrphans`（删掉本地 attached/orphan 计算），标题同样追加 `· 未归属`。
- 新断言 PN7（`test/gui-panel.mjs`）：`sessions: []` + 1 锁（holder `ses_ghost`）+ 1 交接（`from: ses_ghost`）
  + 1 队列（`me` 不在快照）→ 三段标题与三条行都出现在正文。

### F2 TUI 键盘层只注册一次

- `ctx.keymap.layer(...)` 从 `createEffect` 内移到 `StatusPanel` 组件体顶层；`PanelInput` 的 reactive props
  由 factory 内部读取（`enabled: () => props.panel.name === PANEL && props.panel.focused`），不需要随 effect 重注册。
- 新断言（`test/tui-render.mjs`）：稳定 PanelInput（getter 而非每次重建对象）→ `collab.status` → `someone.else`
  → `collab.status` 后，带 `enter` 的 enabled 层 = **1**；一次 `enter` 只展开一次；一次 `j` 只移动到下一行。
  测试用「稳定对象 + reactive getter」模拟宿主，避免重新 mount 掩盖问题。

### nits

- F3：TUI 树夹具改为 `sessionID: 'ses_a1'`，鼠标行定位 `▸ ses_a1`；断言默认没有 `q_tree` / `未归属`，
  展开后出现 `⇢ q_tree`（队列真正挂在会话下，不再被孤儿块满足）。
- F4：`buildBoard` 的 `busy: !session.archived && Boolean(session.busy)`；board 夹具给 `ses_old` 设 `busy:true`，
  断言归档行 `busy === false`。
- F5：PN6 用计数的 `boardClient`；等待 2.1 s 后断言 `boardLoads` 从 1 → 2，再断言展开状态未丢。

### 修复变异（各还原，重新 build 后全绿）

```text
# ① 去掉 GUI OrphanView（<Show when={hasOrphans()}> → false）
  ✗ PN7 orphan leases / hand-offs / queue render as 未归属 sections (never silently dropped)
    — "@srv-orphanGlobal0 sessions · 1 leases · 1 hand-offs · 0 archivedupdated 08:00:00 · read-only"
=== 16/17 panel checks passed
FAILED: PN7 orphan leases / hand-offs / queue render as 未归属 sections (never silently dropped)

# ② 把 keymap 注册放回 createEffect
  ✗ R4 panel away→back leaves exactly one enabled board keyboard layer — 2 enabled / 3 registrations
  ✗ R4 one enter toggles once (the tree expands after a single keypress) — … ▸ ses_a1 …
  ✗ R4 one j moves one row (ses_child expands, not 已归档 / not two rows) — … ▸ ses_a1 … ▸ 已归档 1 …
=== 41/44 checks passed
FAIL: R4 panel away→back leaves exactly one enabled board keyboard layer
FAIL: R4 one enter toggles once (the tree expands after a single keypress)
FAIL: R4 one j moves one row (ses_child expands, not 已归档 / not two rows)
```

## 9. 文件

- 新增：`src/core/board.ts`、`test/board-shape.mjs`、本文件
- 修改：`src/rpc.ts`、`src/core/snapshot.ts`、`src/gui.tsx`、`src/tui.tsx`、`src/index.ts`、
  `test/snapshot-shape.mjs`、`test/gui-panel.mjs`、`test/tui-render.mjs`、`package.json`、
  `docs/collab.md`（§11.11 + 新增 §11.11.6）、`README.md`、`skills/collab/SKILL.md`、`CHANGELOG.md`
- 未改版本号；无新增依赖；无 git 写操作。
