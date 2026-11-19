# 复核报告：协作看板三层展开（`11-19-collab-board`）

- 复核人：trellis-check（独立冷上下文，只审不改；未 commit / push / git add，未重启、未碰真实会话）
- 时间：2026-11-19
- 复核对象：工作区未提交改动（`src/core/board.ts` 新、`test/board-shape.mjs` 新、`src/rpc.ts`、`src/core/snapshot.ts`、
  `src/gui.tsx`、`src/tui.tsx`、`src/index.ts`、`package.json`、`test/snapshot-shape.mjs`、`test/gui-panel.mjs`、
  `test/tui-render.mjs`、`docs/collab.md`、`README.md`、`skills/collab/SKILL.md`、`CHANGELOG.md`）
- 线索（未采信）：`research/impl-notes.md`；所有结论均以自建探针 / 自跑命令 / 源码为准

## 结论：**需修**

R1–R6 的派生层与展示主线成立，回归数字与工具面完全符合要求，两组规定的变异都会真失败。

但有 **2 个中等问题**在提交前应处理（或明确写进文档作为已知限制）：

| # | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| F1 | GUI 丢失「无法归属到任何会话行」的锁 / 交接（当 `me` 不在快照里时还有 owner 队列）：头部计数说 `1 leases · 1 hand-offs`，展开后**一行也看不到**；0.5.3 的平铺视图是会显示这些行的 | `src/gui.tsx:503-531`（只 `For` 会话行 + 已归档段，无兜底）；`src/core/board.ts:175-186`（锁/交接可落进没有会话的组） | 数据在视图里丢失，与 docs §11.11.6「兼容」段「未被任何会话行认领的…仍在树后以原表格块显示」不符（该兜底只有 TUI 实现，`src/tui.tsx:566-583`） |
| F2 | TUI 键盘层在 `createEffect` 内重复注册：面板「切走 → 切回」后存在**两个 enabled** 的 `j/k/enter/space` 层 | `src/tui.tsx:671-689` | `enter` 一次按键执行两次 toggle = 看起来「展不开」；`j/k` 一次跳两格 |

另有 3 个 nit（不阻塞，建议顺手修）：F3 TUI 树夹具的队列断言可被兼容块满足（测试强度）、F4 `archived` 会话仍复制 `busy`、
F5 GUI「2 s 轮询不折叠」未断言期间真的发生过一次快照替换。

---

## 逐项证据（8 项）

### 1. 派生正确 —— **通过**（含 2 处良性偏离）

自建夹具（/tmp/board-probe.mjs，与 `test/board-shape.mjs` 无关）：2 工作区 + 祖先链 root→mid→leaf + 1 archived
（归档后仍持锁）+ spawn（显式 `spawned` 与仅 `claimBy` 回退两种）+ 子会话已消失的 spawn（bid 已归档）+
不存在的持有者（孤儿锁）+ 队列（me=ses_mid）+ workspace/session/祖先三层冻结条目。

原始输出（节选）：

```text
W1 counts                              {"sessions":3,"locks":2,"handoffs":2,"archived":1}
W1 active sids                         ["ses_mid","ses_leaf","ses_root"]
W1 archived sids                       ["ses_gone"]
root.spawned                           [{"sid":"ses_mid","state":"claimed","archived":false,"title":"mid"}]
mid.spawned (one level: leaf only)     [{"sid":"ses_leaf","state":"claimed","archived":false,"title":"leaf"}]
leaf.spawned (no recursion)            []
mid.handoffs                           ["b_1","b_2","b_3"]        ← from 或 claimBy 都算
mid.badges                             {"held":0,"waiting":0,"handoffs":3,"queue":2}
root.badges                            {"held":0,"waiting":1,"handoffs":1,"queue":0}
mid.urgent (queue belongs to me)       true
root.urgent (queue does NOT belong)    false
root.frozen (ancestor beats workspace) {"scope":"session","target":"ses_root",...}
leaf.frozen (own expired, ancestor live){"scope":"session","target":"ses_root",...}
w2.spawned (vanished child + archived bid) [{"sid":"ses_vanished","state":"claimed","archived":true,...}]
```

- spawn **只一层**、子 id = `spawned ?? claimBy`（`src/core/board.ts:212-225`）、自调用不回环；
- `archived` 分流（`:167-171`）且归档会话保留自己的锁/交接，活跃列表不含它们；
- `urgent` 来自交接或「我」的队列项（`:234-246`）；`badges` held/waiting/handoffs/queue 分别只数holder/waiter/自身交接/自身队列；
- `frozen` 优先级 = 快照标记 > session（自身→祖先）> workspace，过期条目被丢弃（`:111-127`），与单一真源
  `core/freeze.ts:294-316`（session/祖先 > bid > workspace）口径一致；
- 偏离 1：`buildBoard` 多了第 4 参 `me`（design §1 的签名没有）——队列本来就只属于调用方，必要，且 docs §11.11.6 已写明；
- 偏离 2：`BoardSession` 多了 `workspace` 字段——additive，无害。

### 2. 老快照兼容 —— **通过**

```text
old snapshot shape   {"sessions":1,"archived":0,"badges":{"held":1,"waiting":0,"handoffs":1,"queue":0},
                      "spawned":[],"urgent":false,"archivedFlag":false}
undefined snapshot   []
empty object snapshot []
expired snapshot marker undefined
```

- `snapshot?.sessions ?? []` 等默认值（`src/core/board.ts:142-145`），缺字段即 `false`/空，不产生空徽标；
- 新增字段全部**不在 schema `required`**（`src/rpc.ts:195-198`、`:236-240`），`test/snapshot-shape.mjs` 50/50 已断言；
- 旧回包在面板层也被既有 PN1–PN5（`snap()` 夹具无新字段）覆盖，输出无 `[archived]/[urgent]` 空徽标。

### 3. GUI 行为 —— **通过**（F5 为测试强度 nit）

- 默认只见活跃会话 + `已归档 N`；`test/gui-panel.mjs` 15/15，原始帧：
  `"@srv-boardcollab2 sessions · 1 leases · 2 hand-offs · 1 archived▸ses_board…▸ Archived 1…"`（无 `↳`、无 archived 行）；
- 点击会话行展开：`↳ ses_child claimed child worker` + `named:board-window` + `b_board_spawn` + `b_board_urgent` + `q_board`；
- 点击 `已归档 1` 出现 `▸ ses_old build [archived] archived worker`；
- **2 s 轮询不折叠**：展开集合在 `PanelView` 的 `createSignal<Set<string>>`（`src/gui.tsx:541`），不在 store；测试真等
  `2100ms` 后再断言仍含 `↳` 与 `archived worker`（真实定时器，非 mock）；
- 收起路径未断言（同一 `toggle`），可接受。

### 4. TUI 行为 —— **通过，但 F2 成立**

- `test/tui-render.mjs` 40/40；同快照帧含工作区头 `2 会话 · 1 锁 · 2 交接 · 1 已归档`、`🔒1 ‹2› [frozen] [urgent]`、
  `enter` 展开后 `↳ ses_child claimed child worker` + 锁/交接/队列、`j`×2 + `enter` 打开 `已归档 1`、鼠标点击同一行可展开；
- 侧栏（`sidebar.content`）仍是四数一行（既有 R3/R5 断言全绿，未改）；
- `sessions: []` 的老回包不崩：孤儿块 `资源租约 (N)/未闭环交接 (N)/受保护目标队列 (N)` 兜底（`src/tui.tsx:566-583`）；
- **F2 探针**（自建，挂在 `test/tmp-check-tui-probe.mjs`，已删除）：

```text
CHECK-PROBE layers with enter after away/back >>> 2 | total layer registrations: 3 | enabled flags: [true,true]
```

即：同一组件实例 `panel.name` 切走再切回后，有两个 `enabled()===true` 的层。宿主的 `PanelInput` 是「reactive props
passed to every claim render」（`node_modules/@opencode/plugin/dist/tui/context.d.ts:139-149,156-159`），`createEffect`
会因此重跑（同文件已有的轮询 effect 正是依赖这一点），旧层不会因 effect 重跑而注销（`layer()` 无 disposer，只在组件/计算
dispose 时移除）→ 重复注册。
建议：把 `ctx.keymap.layer(...)` 移到组件体顶层**注册一次**（factory 本身是 reactive，`enabled` 已读
`panel.name/focused`），或加 `let registered` 守卫；并补一条「away→back 后仍只有一个 enter 层」的断言。

### 5. 只读 —— **通过**

```bash
grep -nE "writeFile|writeFileSync|unlink|rmSync|collab_unlock|collab_archive|collab_freeze|confirm" \
  src/core/board.ts src/gui.tsx src/tui.tsx   # 唯一命中是 tui.tsx:332 的注释
grep -c "node:fs\|require(\"fs\")" dist/gui-experimental.cjs   # 0
```

- 看板/GUI/TUI 只有 `ctx.t / ctx.plural / ctx.ui / ctx.layout / ctx.toast / ctx.keymap / ctx.client.rpc snapshot`；
- 展开/收起只改本地信号，无释放锁、归档、解冻路径；无「加锁/释放」字样（TUI 既有断言 `只读 … !/加锁|释放|unlock/` 全绿）。

### 6. 测试真实性 —— **通过**（非自证）

自跑变异（改源码 → `pnpm build` → 跑测试 → 用备份还原 → 重新 build → 全绿）：

| 变异 | 失败 | 原始输出 |
| --- | --- | --- |
| A `spawned` 过滤 `from` → `claimBy`（用 claimBy 当父） | board 12/13、GUI 13/15、TUI 38/40 | `✗ BD the spawn relation comes from kind:"spawn" + spawned … []`；`✗ PN6 clicking a session expands it: ↳ child …`；`✗ R2 enter expands the selected session: ↳ child …` |
| B 已归档默认展开（GUI `Show` 强制 true；TUI `open = true`） | GUI 14/15、TUI 39/40 | `✗ PN6 derived rows are folded by default: no ↳ and no archived row`；`✗ R3 archived rows are hidden by default … ▾ 已归档 1 ▸ ses_old …` |
| C（附加）board 不再分流 archived | board 11/13 | `✗ BD archived sessions are filed separately …`、`✗ BD workspace counts …` |

既有断言：`test/snapshot-shape.mjs` 的 C2 从「归档会话被丢弃」改为「保留 + `archived:true` + `!busy`」——这是 R6/R3 要求的
**行为变更**，改写后更严（多断言了两个新条件），不是弱化；`test/gui-panel.mjs` 的 mini-DOM 新增 `< ! >`/`<!-- -->` 注释节点
支持（Solid 插入标记），属解析器补齐，不改变既有断言强度。

### 7. 回归与范围 —— **通过**

```text
pnpm build       BUILD_OK
pnpm typecheck   tsc --noEmit（无输出）
pnpm test        === 735/735 checks passed      (handoff-harness)
                 === 12/12 checks passed        (readonly-default)
                 === 13/13 board checks passed  (board-shape)
                 === 50/50 checks passed        (snapshot-shape)
                 === 40/40 checks passed        (tui-render)
                 === 47/47 checks passed        (gui-entry)
                 === 15/15 panel checks passed  (gui-panel)
node scripts/check-skill.mjs   skills ok（collab / collab-coordination）
```

- 与要求的 `735 + 12 + 13 + 50 + 40 + 47 + 15` **逐项一致**；
- 工具数仍 20（`test/readonly-default.mjs:147-171` 的完整名单断言通过），版本仍 `0.5.3`（`package.json:3`、GUI 探针输出 `插件 v0.5.3`），
  无新增依赖（`git diff --stat package.json pnpm-lock.yaml` 只有 package.json 的 `test` 脚本一行）；
- 两处「越界」判定为**必要**：`package.json` 只加 `node test/board-shape.mjs`（否则新测试不会跑）；
  `src/index.ts` 只在既有 `__internals` 里加 `buildBoard`（dist 只打包入口，这是本仓库既有的单测入口约定，`buildSnapshot` 同样在此）。
  未新增公开 RPC / 工具 / 导出路径。

### 8. 文档 —— **基本一致，1 处与实现不符（F1）**

- `docs/collab.md` §11.11 快照形状（`archived?`、`kind?`、`spawned?`、`priority?`）与 §11.11.6 的规则表（归属 / `↳` / 归档 /
  冻结加急 / 老快照 / 只读）与实现一致；`:me` 第 4 参与 `queue` 只挂调用方一致；「看板零写操作」与实现一致；
- `README.md` 的 GUI/TUI 两行、`skills/collab/SKILL.md` 一句、`CHANGELOG.md`（含变异与用例条数 13/15/40/50）与实测一致；
- **不符**：§11.11.6「兼容」条写「未被任何会话行认领的租约 / 交接 / 队列仍在树后以原表格块显示」——只有 TUI 实现，
  GUI 没有（见 F1）。要么补 GUI 兜底，要么把该句限定为「TUI」。
- 未发现任何「看板可写」的表述。

---

## 风险清单

1. **F1（中）**：GUI 孤儿行丢失——头部计数与实际可见行不一致，属相对 0.5.3 的可见回归。触发条件：锁的持有者/等待者、
   交接的 `from` 不在快照会话列表（会话已结束、超出 `limit:100`、跨 workspace 过滤时）。建议照 TUI 的
   `attached*/orphan*` 兜底（`src/tui.tsx:566-583`）在 `GroupView` 末尾补同样区块，并加一条 GUI 断言（既有夹具 `snap(4)`
   正好是这种情况）。
2. **F2（中）**：TUI 键盘层重复注册（见上）。影响 `enter/space/j/k`，且随切换次数累积。
3. **F3（nit，测试强度）**：TUI `TREE` 夹具 `panelInput({ width: 100 })` 的 `sessionID` 是 `ses_probe`，不属于树内任何会话，
   因此 `q_tree` 是被「孤儿队列块」渲染出来的——变异 A 证明即使会话自身的队列渲染坏掉，`expandedTree.includes('q_tree')`
   仍通过。已实测：把该夹具改为 `sessionID:'ses_a1'` 并把鼠标行定位改为 `▸ ses_a1` 后 40/40 通过，且展开行出现
   `⇢ q_tree · ses_p · pending`（队列真正挂在会话下），建议采纳。
4. **F4（nit）**：`src/core/board.ts:230` 对归档会话仍复制 `busy`；`snapshot.ts` 已强制 `busy:false`，但手写/旧夹具给
   `archived+busy` 时会在归档行显示绿色忙点。建议 `busy: !session.archived && Boolean(session.busy)`。
5. **F5（nit，测试强度）**：GUI「2 s 轮询不折叠」未断言期间真的发生了一次快照替换（`fakeClient` 不计调用数），
   若轮询被意外停掉该断言仍会通过。建议加一次调用计数断言。
6. **F6（低，设计重复）**：`src/core/board.ts:96-127` 复制了 `core/freeze.ts` 的冻结优先级（因后者 `import node:fs`
   不能进 GUI bundle，理由成立且已注释）；后续若冻结规则变更需同步两处，建议下次把纯部分抽成无 IO 模块。
7. **F7（低，未验证项）**：`bind:'j'/'k'/'enter'/'space'` 在真实宿主的按键分派未验证（测试直接调 `run()`）；
   `space` 在 OpenTUI 的 key 表中存在（`node_modules/@opentui/core/index.node.js` 有 `Space`），风险低。
8. **旁注（非缺陷）**：`counts.handoffs` 按 `handoff.workspace` 归组；`from` 在 A、`workspace` 写 B 的交接会出现在 A 的
   会话明细里、同时计入 B 的头部计数——与 0.5.3 的归组口径一致，记录备查。

## 复核动作与现场

- 只读探针：`/tmp/board-probe.mjs`（board 派生，28 行断言输出）、`test/tmp-check-gui-probe.mjs`（GUI 孤儿/归档帧，跑完删除）、
  `test/tmp-check-tui-probe.mjs`（层重复，跑完删除）、`test/tmp-check-tui-probe2.mjs`（F3 验证，跑完删除）。
- 变异前备份 `/tmp/{board.ts,gui.tsx,tui.tsx}.bak`，还原后 `sha1sum` 与备份一致
  （`217ac6d1… board.ts`、`6bf920e2… gui.tsx`、`084644085… tui.tsx`），之后重新 `pnpm build` + 全量 `pnpm test` 全绿。
- 工作区现状：`git status --short` 与复核开始时一致（无新增/删除文件，无未预期改动）；未 commit / push / git add。

---

## 增量复核（F1/F2 修复）

- 复核人：trellis-check（独立冷上下文，只审不改；未 commit / push / git add，未重启、未碰真实会话）
- 对象：本轮未提交改动（`src/core/board.ts`、`src/gui.tsx`、`src/tui.tsx`、`test/{board-shape,gui-panel,tui-render}.mjs`、`docs/collab.md`、`CHANGELOG.md`）
- 方法：自建探针 + 自跑变异 + 全量回归；不采信仓库内新断言

### 结论：**可提交**

上轮 F1（GUI 孤儿行丢失）与 F2（TUI 键盘层重复注册）均已修复，且我用**自己的**探针复现了修复后的行为
（不是重跑作者断言）：

- F1：`boardOrphans` 由 GUI/TUI **共用**（`src/core/board.ts:100-115`、`src/gui.tsx:582`、`src/tui.tsx:566`）；
  三段 `· 未归属` 在两端都渲染；只有孤儿、没有任何工作区组时 GUI 不再显示 “No collaboration activity.”
  （真正空的快照仍显示）。
- F2：键盘层改为组件顶层注册一次（`src/tui.tsx:659-676`）；面板「切走 → 切回」后**只有 1 个 enabled 层**，
  一次 `enter` 只展开一次，一次 `j` 只移动一行。

剩余 2 个 nit（不阻塞，建议后续收）：

| # | 观察 | 位置 |
| --- | --- | --- |
| R2-1 | GUI 只有孤儿时，仍会多渲一个空组头（`Global 0 sessions · 1 leases · 1 hand-offs · 0 archived`）再跟「未归属」段，信息重复 | `src/gui.tsx:614`（`groups()` 里存在「只因未归属行才建出来的组」时）+ `board.ts:175-186` |
| R2-2 | TUI 在「只有孤儿」时先打 `（无协作活动）` 再打未归属段（GUI 已不会），两端措辞不一致 | `src/tui.tsx:552-556`（先 `rows.length===0` 判空，后面才算 orphans） |

另：`boardOrphans` 没有进 `src/index.ts` 的 `__internals`，因此 `test/board-shape.mjs` 无法直接单测它——
目前由 PN7（GUI）与 TUI 的未归属断言端到端覆盖（我另外用两端面板探针验证过），可接受；若想加纯单测，
把它挂到 `__internals` 即可（本轮未做，属可选）。

### 证据 1：孤儿三类行在 GUI / TUI 都渲染（自建快照，`sessions: []`）

探针（复制 GUI/TUI 测试 harness，仅追加一段，跑完删除）构造 `1 锁（持有者 ses_ghost）+ 1 交接（from ses_ghost）+
1 队列（me=ses_me，不在会话列表）`，原始输出：

```text
CHECK-PROBE GUI 3-ORPHANS >>> "@srv-orphan3Global0 sessions · 1 leases · 1 hand-offs · 0 archived
  Leases (1) · unclaimednamed:ghost-windowexclusiveses_ghostleft 10m
  Open hand-offs (1) · unclaimedb_ghostopen1sghost hand-off
  Owner queue (1) · unclaimedq_ghostses_ppending1sghost requestupdated 08:00:00 · read-only"

CHECK-PROBE TUI 3-ORPHANS >>> … | 全局 0 会话 · 1 锁 · 1 交接 · 0 已归档 |
  资源租约 (1) · 未归属 | named:ghost-window exclusive ses_ghost 10m 0 |
  未闭环交接 (1) · 未归属 | b_ghost open 1s ses_ghost |
  受保护目标队列 (1) · 未归属 | q_ghost ses_p 1s pending | …
```

### 证据 2：「只有孤儿、没有任何工作区组」时不显示 No activity

仅有 1 条队列项（无会话、无锁、无交接 → `buildBoard` 返回 `[]`，没有任何组）：

```text
CHECK-PROBE GUI QUEUE-ONLY >>> "@srv-qonlyOwner queue (1) · unclaimedq_onlyses_ppending1slonelyupdated 08:00:00 · read-only"
CHECK-PROBE GUI EMPTY     >>> "@srv-emptyNo collaboration activity.updated 08:00:00 · read-only"   ← 真空快照仍保留空态
CHECK-PROBE TUI QUEUE-ONLY >>> … | （无协作活动） | 受保护目标队列 (1) · 未归属 | q_only ses_p 1s pending | …   ← R2-2
```

GUI 满足要求（`Show when={groups().length || hasOrphans()}`，`src/gui.tsx:614`）；TUI 仍多打一行空态（R2-2）。

### 证据 3：TUI 键盘层只注册一次 / 一次按键只动一次（自建探针，不采信仓库断言）

同一 `PanelInput` 对象（reactive getter）走 `collab.status → someone.else → collab.status`：

```text
CHECK-PROBE TUI enabled-enter-layers after away/back >>> 1 | registrations: 2
CHECK-PROBE TUI after ONE enter >>> … | ›   ▾ ses_a1  build  alpha worker  🔒1 ‹2› ⇢1 [frozen] [urgent] |
                                   ↳ ses_child  claimed  child worker | 🔒 named:tree-window … |
CHECK-PROBE TUI after ONE j + enter >>> ›   ▾ ses_child  build  child worker  ‹1›
```

（`registrations: 2` = `setup` 里的 `/collab` 命令层 + 面板层；`/collab` 层没有 `enter` 绑定，故 enabled 的 board 层恒为 1。）

### 证据 4：归档会话 `busy` 恒为 false（自建输入 `archived:true, busy:true`）

```text
archived busy -> false | active: 0
```

`src/core/board.ts:262`（`busy: !session.archived && Boolean(session.busy)`）；同时
`test/board-shape.mjs:50` 的夹具已改成 `busy:true` 并在既有断言里检查 `archived[0].busy === false`（条数仍 13）。

### 证据 5：变异自证（改源码 → build → 跑测试 → 备份还原 → 复跑全绿）

| 变异 | 结果 | 原始输出 |
| --- | --- | --- |
| 删掉 GUI 的 `<Show when={hasOrphans()}>`（不渲染 `OrphanView`） | GUI 16/17 | `✗ PN7 orphan leases / hand-offs / queue render as 未归属 sections (never silently dropped) — "…0 sessions · 1 leases · 1 hand-offs · 0 archivedupdated 08:00:00 · read-only"` |
| 键盘层放回 `createEffect` 内（旧形态） | TUI 41/44 | `✗ R4 panel away→back leaves exactly one enabled board keyboard layer — 2 enabled / 3 registrations`；`✗ R4 one enter toggles once …`；`✗ R4 one j moves one row …` |

还原后 `sha1sum` 与备份一致（`031e7c4d… gui.tsx`、`c0338996… tui.tsx`、`b7f434bf… board.ts`），重新 `pnpm build`。

### 回归与范围

```text
pnpm build              BUILD_OK
pnpm typecheck          tsc --noEmit（无输出）
pnpm test               === 735/735  (handoff-harness)
                        === 12/12    (readonly-default)
                        === 13/13    (board-shape)
                        === 50/50    (snapshot-shape)
                        === 44/44    (tui-render)
                        === 47/47    (gui-entry)
                        === 17/17    (gui-panel)
node scripts/check-skill.mjs   skills ok
```

- 与要求 `735 + 12 + 13 + 50 + 44 + 47 + 17` **逐项一致**；
- 工具数仍 20（`test/readonly-default.mjs:147-171` 完整名单断言通过），版本仍 `0.5.3`，无新依赖
  （`git diff --stat package.json pnpm-lock.yaml` 只有 package.json 的 `test` 脚本一行 —— 上轮既有改动）；
- 范围：本轮只改 `src/core/board.ts`、`src/gui.tsx`、`src/tui.tsx`、`test/{board-shape,gui-panel,tui-render}.mjs`、
  `docs/collab.md`、`CHANGELOG.md`；`src/index.ts`（3 行）/`src/rpc.ts`（28 行）/`src/core/snapshot.ts`（18 行）/
  `package.json`（2 行）/`skills/collab/SKILL.md`（4 行）/`README.md`（4 行）diff 行数与上轮一致、内容未变；
- 文档：`docs/collab.md` §11.11.6 已写「未被任何会话行认领的租约/交接/队列在树后成段，标题 `· 未归属`（GUI 与 TUI
  共用 `boardOrphans`）」，CHANGELOG 已更新为 17/44 与变异 ③（删兜底 → PN7 失败），与实测一致。

### 剩余风险

1. **R2-1（外观，低）**：孤儿行同时被「空组头」与「未归属段」表达，数字重复但不丢行。可考虑 `GroupView` 在
   `counts.sessions + counts.archived === 0` 时只渲染未归属段。
2. **R2-2（措辞，低）**：TUI 只有孤儿时会同时出现 `（无协作活动）` 与未归属块；GUI 已不会。建议把空态判断挪到
   orphans 之后。
3. **F7（沿用上轮，低）**：`bind:'j'/'k'/'enter'/'space'` 的真实宿主按键分派仍未验证（测试与探针都直接调 `run()`）；
   `space` 在 OpenTUI key 表中存在，风险低。
4. **F6（沿用上轮，低）**：`board.ts` 复制了 `core/freeze.ts` 的冻结优先级（为避免 `node:fs` 进 GUI bundle，理由成立），
   后续冻结规则变更需同步两处。
5. **范围旁注**：`boardOrphans` 未进 `__internals`，无纯单测（由两端面板端到端覆盖）。
