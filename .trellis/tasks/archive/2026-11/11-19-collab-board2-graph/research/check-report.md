# 独立复核报告：`board2-graph`（三级关系图）

复核人：独立复核子代理（冷上下文，只审不改）
日期：2026-11-19
范围：`src/core/graph.ts`(新)、`src/gui.tsx`、`src/tui.tsx`、`src/index.ts`、`test/graph-shape.mjs`(新)、
`test/gui-panel.mjs`、`test/tui-render.mjs`、`package.json`、`docs/collab.md`、`README.md`、
`skills/collab/SKILL.md`、`CHANGELOG.md`（未提交）

---

## 结论

**需修（小修）**。核心派生（三级、四类边方向、排序、上限）**正确**，GUI/TUI 交互按 PRD 工作，回归全绿、
只读成立、工具数 22、版本 0.7.0、无新依赖。本轮**没有**发现会崩、会写盘、会破坏既有契约的缺陷。

阻断提交的只有两处「实现/文档不一致」，合计约 3 行；另有一处需要 owner 决策（`origin` 契约）：

| 编号 | 级别 | 问题 | 建议 |
| --- | --- | --- | --- |
| R-1 | 阻断（文档） | `CHANGELOG.md:61,67` 写 `test/graph-shape.mjs` 为 **29** 条，实际 **32** 条 | 两处 `29` → `32` |
| R-2 | 阻断（PRD R1） | GUI 只把 `origin` 和「对端工作区」画成虚线，`spawn` / `subagent` 仍是**实线**；README/docs 却写「点线」 | `src/gui.tsx:808` `dashOf()` 加 `spawn`/`subagent` → 点线（如 `'1 3'`），并补一条 `stroke-dasharray` 断言 |
| R-3 | 需决策（中） | `origin` 边在**真实运行路径永远不出现**：`buildSnapshot` 的 `toHandoff` 不透传 `record.origin`，快照里没有该字段（只有测试夹具自带） | 二选一：① 在 `toHandoff` + `SnapshotHandoff` 加可选 `origin` 透传（+ `snapshot-shape` 一条断言）；② 记录 D 条目并把 docs 的「从记录对象可选读取」改成「当前快照不透传，L2 不画 origin」 |
| R-4 | 低 | 同一 `(from,kind,to)` 的两条不同 `bid` 记录，保留哪条的 `bid/state` 取决于输入顺序；与 docs/CHANGELOG「输入数组倒序也一致」的强断言冲突 | 去重时选 canonical（如最小 `bid`），或把文档强断言降级为「同快照两次一致」 |
| R-5 | 低（文档） | `docs/collab.md:1140` 说 L1 只有「每条**出区**边」对应占位节点；实现**入区**边也会折到占位节点（已探针复现） | 改成「跨越本区边界（出/入）的边」 |
| R-6 | 低（UX/测试） | 点击图中「不在快照会话列表」的邻居节点（如 `origin.sid`、已关闭的 `from`）会触发 `panel.selectedGone` toast 并弹回 L0；GUI 测试未覆盖 | 加断言确认行为可接受，或对未列出节点禁用选中 |

> 以上均未由我修改（本次任务要求只审不改）。复核期间为验证测试真实性，曾临时改 `src/core/graph.ts` 做两组变异，
> 已按备份还原并校验 `sha256` 与还原前一致（见 §变异）。

---

## 必跑命令与原始输出

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
EXIT=0
```

（还原变异后重跑一次，仍未提交状态）

```
=== 883/883 checks passed
=== 12/12 checks passed
=== 20/20 board checks passed
=== 32/32 graph checks passed
=== 50/50 checks passed
=== 60/60 checks passed
=== 47/47 checks passed
=== 46/46 panel checks passed
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
```

- `pnpm typecheck`（`tsc --noEmit`）：通过
- 版本：`package.json:3` `"version": "0.7.0"`（未改）
- 依赖：`git diff --stat package.json` 仅 `test` 脚本 +1 行，`pnpm-lock.yaml` 无 diff（无新依赖）
- 工具数：`test/handoff-harness.mjs:9253,10823,11309` 断言 `tools.length === 22`，883/883 通过

---

## 逐项结论（9 项）

### 1. 三级正确（L0/L1/L2 + 四类边方向/类型）——**通过**

自写探针 `/tmp/opencode/probe-graph.mjs`（独立夹具：alpha/beta/gamma、跨区双向、spawn、subagent、
forward 带 `origin`、同区交接）：

```
OK   L0 nodes are workspaces only
OK   L0 A->B count 2
OK   L0 B->A count 1 (direction not merged)
OK   L0 no self edges
OK   L1 has all A sessions
OK   L1 no B/G session nodes
OK   L1 ghost workspaces are B and G
OK   L1 outgoing handoff keeps direction a1->B
OK   L1 incoming handoff b1->a2 folds to B->a2
OK   L1 origin g1->a2 folds to G->a2 origin
OK   L2 handoff direction a1->b1
OK   L2 spawn a1->child only (no handoff copy)
OK   L2 subagent a1->child
OK   L2 origin g1->a2 when a2 is centre
```

实现位置：L2 `src/core/graph.ts:269-293`；L1 `:295-337`；L0 `:339-375`；关系边 `:158-185`；
上限 `GRAPH_NODE_LIMIT = 8`（`:88-89`）。L1 不展开对方会话（`:295-330` + 探针）、
L2 只保留两端都在保留集合的边（`:290`）、超限 `truncated = ids.length - 8` 且保留中心（`:280-286`）。

补充观测（非缺陷，与 design 一致）：**未闭环（open）的跨区交接在 L0 不产生边**——L0 以
`spawned ?? claimBy` 作为对端（`:353-354`），无 `claim.by` 时跳过；design §1 的边来源同样写着
`from.sid → claim.by`，故按设计执行。若产品希望「open 的 peer 交接」也在 L0 显示，需要 owner 另定。

### 2. 确定性（同快照两次一致 + 输入倒序一致）——**通过（R4 原文）/ 存疑（文档强形式）**

- 节点按 `id`、边按 `from+kind+to`，`compareText` 用 `<`/`>` 码位比较（`src/core/graph.ts:102-116`），
  不使用 `localeCompare` ✅
- 探针：`determinism: same snapshot twice` ✅；`reversed input`（L0/L1/L2）✅；额外做了一组
  **非 reverse 的 shuffle**（sessions/handoffs 任意置换）✅；排序契约 ✅
- **存疑**：同一 `(from,kind,to)` 但 `bid`/`state` 不同的两条记录，去重是「先到先留」（`:160-167`），
  所以 `bid/state` 会随输入顺序变：

```
forward:  [{"from":"ses_a","to":"ses_b","kind":"handoff","bid":"b_one","state":"claimed"}]
reversed: [{"from":"ses_a","to":"ses_b","kind":"handoff","bid":"b_two","state":"open"}]
byte-identical: false        # L0 仍然一致（L0 不带 bid）
```

  R4 原文只要求「同一快照两次渲染字节一致」，这一条成立；但 `docs/collab.md:1164` 与
  `CHANGELOG.md:52` 声称「输入数组倒序也一致」，在重复三元组下不成立。GUI/TUI 都不显示 `bid`，
  用户不可见，故评低。现有 `test/graph-shape.mjs:319-339` 的夹具三元组唯一，覆盖不到这一点。

### 3. `origin` 取舍——**不通过（生产路径丢边）/ 缺失时可读**

- 快照契约确有该字段吗？**没有**：`src/rpc.ts:88-124` 的 `SnapshotHandoff` 无 `origin`，
  `CollabState` 的输出 schema（`src/rpc.ts:185+`）也没有。
- `graph.ts` 的读取是防御式的（`originOf`，`src/core/graph.ts:126-135`），**缺失不乱画、不崩**（探针 `ses_nope`/无快照均正常）✅
- **但**记录上实际有 `origin`（`src/types.ts:375`，0.7.0 起），而 `src/core/snapshot.ts:126-161`
  的 `toHandoff` 只映射 `bid/state/ageMs/from/claimBy/workspace/title/archived/priority/kind/spawned/freeze`，
  **没有透传 `origin`**。端到端探针（用 `__internals.buildSnapshot` + 带 `origin` 的假 source）：

```
real snapshot handoff = [{"bid":"b_real","state":"claimed","ageMs":1000,"from":"ses_a2","claimBy":"ses_a1","workspace":"/ws/alpha","title":"real"}]
FAIL snapshot contract: origin survives buildSnapshot (needed for a real origin edge)
FAIL real path: origin edge rendered from a real snapshot :: [{"from":"ses_a2","to":"ses_a1","kind":"handoff","bid":"b_real"}]
```

  即：**同版本端到端永远没有 `origin` 边**，只有 `test/graph-shape.mjs:90-100` 这种自带 `origin`
  的夹具能看到。docs 写「`graph.ts` 从记录对象上可选读取……等快照补上字段即自动生效」是误导
  （`graph.ts` 拿不到记录对象，只拿快照）。这不算「崩」，但 R1 的四类边在生产上只有三类。
  → R-3（需 owner 决策：补透传，或明确降级并改文案）。

### 4. GUI 交互——**通过**（含 1 条 UX 存疑、1 条测试覆盖缺口）

`test/gui-panel.mjs:960-1200`（PN10/PN11，本次新增 12 条，总 46/46）：

- 点工作区标题 → `data-graph-level="workspace"`，只展开 alpha 会话 + beta 占位（无 `ses_g_beta01`）✅
- 点会话节点 → `collab-session-selected` 落在左列表同一行，详情/items 换成该会话 ✅
- 点 `▸/▾`（`data-graph-toggle`）折叠中心 → 只剩中心；再点恢复 ✅（状态是组件内 `createSignal<Set>`）
- 悬停节点 → 相邻边 `collab-graph-edge-active`，非相邻边没有 ✅
- `+N`：12 邻居 → `data-graph-node` 恰 8 个、`.collab-graph-more` = `+5` ✅
- 2 s 轮询换快照后级别与折叠仍在（本地状态）✅
- **不写 storage**：`grep -n "storage\|persist\|localStorage" src/gui.tsx src/tui.tsx src/core/graph.ts` 无结果 ✅
- 实现：`GraphSlot` `src/gui.tsx:727-918`；`dashOf` `:808-812`；`pick` `:819-822`；折叠角标是兄弟元素（`stopPropagation` 的等价做法，见 impl-notes §8.4）✅

存疑/缺口（低）：

- 点「工作区**节点**」本身（不是标题）只有共享 handler `pick()`，测试只点了标题；行为同源，但没断言。
- 点图中**未被快照列出**的邻居（`origin.sid`、已关闭的 `from`）→ `selected` 设了但
  `selectedSession()`（`src/gui.tsx:1043-1048`）找不到 → `createEffect`（`:1055-1066`）弹
  「该会话已不在快照中」并清空，视觉上「点了又弹回」。我未构造该 GUI 夹具实测（标存疑）。
- GUI 线型：见 R-2。

### 5. TUI——**通过**；L1 不可达已文档化

`test/tui-render.mjs:726+`（5d，本任务 56 → 60）：

```
OK R3 the L0 graph is a workspace text tree with a ─交接─▶ edge
OK R3 the L0 graph is read-only and adds no second RPC (same snapshot)   # calls === 1
OK R3 selecting a session switches the graph to L2 (session heading + ↳ spawn)
OK R3 a 30-column panel clips the graph lines with … instead of crashing
```

- 同一 `buildGraph`（`src/tui.tsx:597-602` 调 `buildGraph`），无第二 RPC ✅
- 级别随 `j`/`k` 的选中变化（`selectedSession ? 'session' : 'global'`，`src/tui.tsx:730-740`）✅
- 宽度：每行 `clip(..., width)`，30 列出 `…` 不崩 ✅
- `--conditions=browser` 下 60/60 ✅
- L1：TUI 没有工作区光标，只在 GUI 出现；`docs/collab.md:1140` 已写明「TUI 没有工作区光标，不产出」，
  PRD R3 也只要求「随级别切换」，**接受**（若要求 TUI 也能到 L1，需要新增工作区光标，超出本子任务）。
- 与 design 的小偏差：design §3 写 BFS + `┈spawn┈▶`，实现是带 `visited` 的 DFS + `↳`（`:640-657`）；
  PRD R3 原文就是 `↳ spawned`，实现**跟 PRD**，design 文字未同步（低，信息项）。

### 6. 只读——**通过**

- 派生/渲染前后**整个仓库相关目录 hash 不变**（我在 `pnpm test` 前后各算一次）：

```
BEFORE=d5d25f4ad5b49737321aac2ac37017bde071e243ae9df727a72973cf800e7079
AFTER =d5d25f4ad5b49737321aac2ac37017bde071e243ae9df727a72973cf800e7079
```

  （hash 覆盖 `src docs skills test scripts README.md CHANGELOG.md package.json`）
- `src/core/graph.ts` 无 `node:` 导入（头注释 + `:32-34` 只 import 类型与 `freeze-pure`）✅；
  不 go through `core/freeze.ts`（会带 `node:fs`），符合 GUI bundle 的既有约定 ✅
- `test/graph-shape.mjs:358-391` 另有目录 hash 断言；它证明的是「纯函数不碰盘」，属**弱证据**
  （`buildGraph` 根本没有 FS 入参），但配合上面的仓库 hash 与「无写 API」走读，结论成立 ✅
- gui/tui 新增代码无 `writeFile` / storage / 网络调用 ✅

### 7. 回归与范围——**通过**

- `883 + 12 + 20 + 32 + 50 + 60 + 47 + 46` 与任务书一致（原始输出见上）✅
- 工具数 22（`handoff-harness` S98/S102/末段三处断言）✅
- `package.json` 版本仍 `0.7.0`，`test` 仅插一条 `graph-shape` ✅
- 无新增依赖（lockfile 无 diff）✅
- 改动范围限定在任务清单 12 个文件（`git status --short` 与任务书一致；另有 `.trellis/` 任务目录未跟踪，属正常）✅

### 8. 测试真实性（自做 2 组变异）——**通过**

变异前备份 `src/core/graph.ts` 到 `/tmp/opencode/graph.ts.bak`（`sha256 091eee83…69656`），
改源码 → `pnpm build` → `node test/graph-shape.mjs` → 还原 → `sha256` 一致 → 重新 build + 全量回归。

**M1：边方向画反**（handoff/spawn/origin/subagent 的 from/to 互换）→ **7 条失败**：

```
✗ GR L1 workspace: both cross hand-offs point at the beta workspace node (direction kept)
✗ GR L1 workspace: same-workspace spawn + subagent + hand-off edges stay session → session
✗ GR L2 session: handoff direction is from → claimBy (a1 → b1)
✗ GR L2 session: a spawn record yields ONE spawn edge (a1 → child), not a handoff copy
✗ GR L2 session: parent → child is a subagent edge (a1 → child)
✗ GR L2 session: the incoming hand-off keeps its direction (a2 → a1)
✗ GR L2 session: an origin edge is head → from and dashed-worthy (kind origin)
```

**M2：去掉节点/边排序**（6 处 sort 全部移除）→ **5 条失败**：

```
✗ GR determinism workspace: nodes sorted by id, edges by from+kind+to
✗ GR determinism session: nodes sorted by id, edges by from+kind+to
✗ GR determinism global: reversing the snapshot arrays yields the same graph (canonical order)
✗ GR determinism workspace: reversing the snapshot arrays yields the same graph (canonical order)
✗ GR determinism session: reversing the snapshot arrays yields the same graph (canonical order)
```

注意：**M2 下「同一快照两次构建字节一致」仍然通过**（插入序稳定）——说明「输入倒序」那条断言才是
真正买到的性质，测试设计正确。还原后 `32/32 graph checks passed`，全量回归绿。

「32 条是否自证」：不是。断言读的是 `buildGraph` 的公开输出（节点/边/方向/类型/顺序/上限），
探针与变异都能推它；唯一「自证」风险是 `origin` 夹具绕过了 `buildSnapshot`（见 §3）。

「既有断言未弱化」：

- `git diff --numstat test/gui-panel.mjs` = **240 增 / 0 删**（纯新增 PN10/PN11），PN8 的槽位/顺序断言原样保留并通过。
- `test/tui-render.mjs` 只删了 1 条旧写法（整帧行数差），改成「按详情块计数 + 挂载时详情块为空」，
  并**追加**了 5d 四条：属于加严且范围更准（impl-notes §6 的说明与 diff 一致），未发现弱化。

### 9. 文档一致性——**不通过（3 处）**

| 位置 | 声称 | 实际 | 结论 |
| --- | --- | --- | --- |
| `CHANGELOG.md:61`、`:67` | `test/graph-shape.mjs` **29** 条 | **32** 条（`=== 32/32`） | 改数字（R-1） |
| `README.md:101`、`docs/collab.md:1149-1150` | GUI `spawn`·`subagent` **点线** | `dashOf()` 只对 `origin` 与「对端工作区」返回虚线段，`spawn/subagent` 返回 `''`（实线） | 改代码或改文案（R-2，PRD R1 要求点线 → 建议改代码） |
| `docs/collab.md:1152-1154` | `origin` 「从记录对象上可选读取……等快照补上字段即自动生效」 | `graph.ts` 只拿快照；`toHandoff` 不透传 → 现在永远读不到 | 按 R-3 二选一 |
| `docs/collab.md:1140` | L1 占位节点只来自「出区边」 | 入区边同样会生成占位节点（探针 `L1 incoming handoff b1->a2 folds to B->a2`） | 措辞 ±1 词（R-5） |

其余一致：`docs/collab.md:1113`（槽位表述）、`§11.11.8` 的三级/边来源/确定性/交互表、
`skills/collab/SKILL.md:55-60`、`README.md:101` 的 L0/L1/L2 与 `+N`、`CHANGELOG.md` 的
GUI/TUI/只读/变异描述与实现相符（除上表 3 处）。`README.md:101` 另有笔误「L2 选中会话 = 它**以**中心 ±1 跳」。

---

## 风险清单（按优先级）

1. **中 · `origin` 边在生产路径不可达**（R-3）。功能面「四类边」实际只出三类；测试夹具掩盖了这一点。
   改动最小方案：`src/rpc.ts` 的 `SnapshotHandoff` 加可选 `origin?: { sid: string; directory?: string }`
   （输出 schema 同样可选），`src/core/snapshot.ts:143-160` 增加
   `...(record.origin?.sid ? { origin: { sid: String(record.origin.sid), ...(record.origin.directory ? { directory: String(record.origin.directory) } : {}) } } : {})`，
   再在 `test/snapshot-shape.mjs` 加一条透传断言。属「改契约」→ G2 高风险，请 owner 决定是否本任务扩容。
2. **低-中 · GUI 线型不满足 R1**（R-2）：`src/gui.tsx:808-812` 加
   `if (edge.kind === 'spawn' || edge.kind === 'subagent') return '1 3';` 即可；建议在 `gui-panel.mjs`
   补一条 `stroke-dasharray` 断言（否则回归不会发现）。
3. **低 · 重复三元组的顺序依赖**（R-4）：可选 canonical 去重（按 `bid` 取最小），或把 docs 的
   「倒序一致」改成 R4 原文口径；同时给 `graph-shape` 加一条「同 (from,kind,to) 不同 bid」的夹具。
4. **低 · 未列出邻居点击的 toast 误导**（R-6）：建议 GUI 对 `kind==='session'` 但不在 board 的节点
   不做 `pick`（或提示「该会话不在当前快照」），并补测试。
5. **低 · 文档三处数字/措辞**（R-1、R-5、README 笔误）。
6. **信息 · design 文字滞后**：DFS vs BFS、spawn 连接符 `↳` vs `┈spawn┈▶`、`GraphNode.x/y` 未使用。
   实现跟 PRD，design 可后续同步；不影响功能。

## 未做/未验证

- 未在真实桌面窗口点选（用测试宿主的最小 DOM）；未接真实 server（用构造快照 / 假 source）。
- 未对「未列出邻居点击」构造 GUI 夹具（标存疑，见 §4）。
- 未验证远端 server 是否会在 RPC 输出里保留未知字段（本版本 `buildSnapshot` 必丢 `origin`，
  远端是否透传取决于对端版本；即使透传，本地 `rpc.ts` schema 也未声明该字段）。

## 复核过程的可逆性声明

- 只临时改过 `src/core/graph.ts` 做变异，随后从 `/tmp/opencode/graph.ts.bak` 还原，
  `sha256` 双方一致（`091eee83…69656`），并重新 `pnpm build` + 全量回归（全绿）。
- 未 commit / 未 push / 未 `git add`；未改实现文件（除上述已还原的变异）；未动真实会话、未 restart。
- 工作区 `git status --short` 与复核前一致（12 个任务文件 + `.trellis/` 任务目录）。

---

# 增量复核（契约/线型/数字）

复核人：独立复核子代理（冷上下文，只审不改）
日期：2026-11-19

## 结论

**可提交。** 上轮三处阻断（`origin` 生产路径缺失、GUI 线型与文档不符、CHANGELOG 数字）**全部修复**，
我用独立探针 + 自做变异逐条复现；回归全绿（`883 · 12 · 20 · 36 · 52 · 60 · 47 · 47`），工具数 22、
版本 0.7.0、无新依赖、改动全部落在声明范围。

随提交**建议**顺手修 3 处（都不阻断，合计约 3 行）：

| 编号 | 级别 | 问题 |
| --- | --- | --- |
| D-1 | 低（文档） | `README.md:296` 的 `pnpm test` 注释仍是旧口径（`870 / 50 / 56 / 34`），与本次实际 `883 / 36 / 52 / 60 / 47 / 47` 不符；这是 `board2-layout` 时代留下的陈旧行，本 delta 未更新 |
| D-2 | 低（文档） | `docs/collab.md:1186` §11.11.8「测试与变异」仍写 `test/gui-panel.mjs` **34 → 46**、只列两组变异；实际 47，且新增了 origin 真实路径 / 线型断言与 M3/M4 两组变异，段落未同步 |
| D-3 | 低（边界线型） | 跨界 `spawn`/`subagent` 边（对端是工作区占位节点）现在画**点线 `1 3`**，而 `docs/collab.md:1140` 说「跨界的边折到对端工作区节点上（GUI 画虚线）」；无测试覆盖（见 §2 末） |

未纳入本轮 delta 的上轮非阻断项状态：**R-5（L1 出/入区措辞）已修**；**R-4（同 `(from,kind,to)` 重复记录
的 `bid/state` 依赖输入顺序）仍可复现**（见文末「遗留」）；R-6（点未列出邻居弹 toast）未变、未实测。

## 6 项逐条

### 1. 生产路径 `origin`——**通过**

- `src/rpc.ts:130` `SnapshotHandoff.origin?: string`（可选）；输出 schema `src/rpc.ts:248` 声明 `origin: str`，
  **不在 required 列表**（必需项仍 `['bid','state','ageMs','from','title']`）。
- `src/core/snapshot.ts:143-163`：`const from = ...`；`const origin = String(asObject(record.origin).sid ?? '')`；
  仅 `origin && origin !== from` 时写字段（单跳不写、旧记录无字段）。
- `src/core/graph.ts:127-136` `originOf`：优先读字符串字段，同时容忍旧远端可能透传的 `origin.sid` 对象 /
  `originSid`（不造节点）。

**独立探针**（`/tmp/opencode/probe-origin.mjs`，用构建后的真实 `buildSnapshot → toHandoff → buildGraph`，不是手写快照）：

```
snapshot.handoffs = [{"bid":"b_fwd","state":"claimed","ageMs":1000,"from":"ses_a","claimBy":"ses_b","workspace":"/ws/alpha","title":"b_fwd","origin":"ses_head"}]
graph L2 edges = [{"from":"ses_a","to":"ses_b","kind":"handoff","bid":"b_fwd","state":"claimed"},{"from":"ses_head","to":"ses_a","kind":"origin","bid":"b_fwd"}]
OK   A1 toHandoff writes handoff.origin (string sid)
OK   A2 production path yields origin edge head -> from
OK   A3 origin head becomes a neighbour node
OK   B1 origin === from: field omitted
OK   B2 origin === from: no origin edge
OK   C1 record without origin: field absent
OK   C2 record without origin: no throw, no origin edge
OK   C3 old payload still has the handoff edge
OK   D1 object-shaped origin still draws the edge
OK   D2 originSid spelling still draws the edge
OK   E1 rpc output schema declares origin
OK   E2 origin is not in the hand-off required list
ALL INCREMENTAL PROBES PASSED
```

### 2. 线型——**通过（含 1 个边界，D-3）**

`src/gui.tsx:813-820`：

```ts
const dashOf = (edge: GraphEdge): string => {
  if (edge.kind === 'spawn' || edge.kind === 'subagent') return '1 3';
  if (edge.kind === 'origin') return '4 3';
  const target = graph().nodes.find(node => node.id === edge.to);
  return target?.kind === 'workspace' ? '4 3' : '';
};
```

即 handoff 实线（`''`）、origin 虚线 `4 3`、spawn/subagent 点线 `1 3`；对端工作区仍 `4 3`（L1 handoff 跨界）。
`test/gui-panel.mjs:1105` 直接断言四类 `stroke-dasharray` 的**实际 DOM 属性**（不是 class 名）：
handoff `''` / origin `4 3` / spawn `1 3` / subagent `1 3`（47/47 通过）。

边界（D-3）：`spawn`/`subagent` 分支在「对端工作区」判断**之前**，因此一条跨界的 spawn 边
（`kind==='spawn'`、目标被折成工作区占位）会画点线而不是虚线。用 `buildGraph` 复现：

```
L1: [{"from":"ses_a","to":"/ws/b","kind":"spawn","bid":"sp","state":"claimed"}]
```

docs `:1140` 写的是「跨界的边折到对端工作区节点上（GUI 画虚线）」。触发条件需要「跨工作区 spawn 且被拉起的
会话也在本快照里」（peer 跨 server 拉起的会话通常不在本快照，会被丢弃），属边角；建议把
`target?.kind === 'workspace'` 判断提到最前（handoff/origin 结果不变），或把 docs 措辞改成「跨界边保留其类型
线型」。无测试覆盖该组合。

### 3. 兼容性——**通过**

- 新字段**可选**：类型 `?` + schema 非 required；旧 server 回包没有 `origin` → `buildGraph` 不画、不崩
  （探针 C1–C3）；旧远端传对象拼写仍画（D1/D2）。
- `test/snapshot-shape.mjs` 纯新增：`git diff --numstat` = **21 增 / 0 删**，既有断言逐条未动，52/52 通过。
- GUI/TUI 其余代码不读 `handoff.origin`（`grep '\.origin' src/gui.tsx src/tui.tsx` 仅 graph 相关），无二次消费风险。

### 4. 数字——**部分通过**

- `CHANGELOG.md:61-71`：graph-shape **36**、snapshot-shape **50 → 52**、gui-panel **34 → 47**、
  tui-render **56 → 60**、末段「36 · 52 · 47 · 60」——与实际 `36/52/47/60` 一致 ✅
- `README.md:296` 仍是 `870 项 harness + 12 … + 20 看板 + 50 项快照/产物 + 56 项 TUI + 47 GUI 入口 +
  34 GUI 面板` ❌（D-1；本次未改这一行）
- `docs/collab.md:1186` 仍写 gui-panel **34 → 46**、缺 snapshot-shape/真实路径/线型与 M3/M4 ❌（D-2）

实际计数（原始输出见下）：`36/36 graph`、`52/52 snapshot`、`60/60 tui`、`47/47 gui-entry`、`47/47 panel`。

### 5. 变异——**通过（自做两组，均已还原）**

变异前备份 `src/core/snapshot.ts` / `src/gui.tsx`，还原后 `sha256sum -c` 校验成功。

**M3：去掉 `origin` 透传**（删 `snapshot.ts:163` 那一行）→ `graph-shape` 2 条 + `snapshot-shape` 1 条失败：

```
graph failed=2 snap failed=1
✗ GR a real snapshot carries handoff.origin (toHandoff passthrough)
✗ GR a real snapshot yields the origin edge head → from (not just a hand-written fixture)
✗ C2 a forwarded hand-off carries origin:<record.origin.sid> (graph `origin` edge)
```

**M4：spawn/subagent 改回实线**（删 `gui.tsx` 的 `1 3` 分支）→ panel 恰 1 条失败：

```
panel failed=1
✗ PN10 edge line styles follow R1: handoff solid / origin dashed / spawn & subagent dotted
=== 46/47 panel checks passed
```

还原后重新 build + 全量回归：全绿（见下）。

### 6. 回归与范围——**通过**

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
BUILD=0  TYPECHECK=0  TEST=0  SKILL=0
=== 883/883 checks passed
=== 12/12 checks passed
=== 20/20 board checks passed
=== 36/36 graph checks passed
=== 52/52 checks passed
=== 60/60 checks passed
=== 47/47 checks passed
=== 47/47 panel checks passed
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
```

- 工具数 22：`handoff-harness` 三处 `tools.length === 22` 断言在 883/883 内通过
- 版本仍 `0.7.0`；`package.json` 仅 `test` 脚本 +1 行；lockfile 无 diff（无新依赖）
- 改动文件 = 任务既有的 12 个 + 本轮声明的 `src/rpc.ts`、`src/core/snapshot.ts`、`test/snapshot-shape.mjs`；
  无越界文件（`git status --short` 只列这些 + `.trellis/` 任务目录）
- 只读：`pnpm test` 前后仓库 hash 一致：

```
BEFORE=042c9eea769e001c5e254c876dfe59fdd9aed4e37345f1700495a2f8dc6e2ddf
AFTER =042c9eea769e001c5e254c876dfe59fdd9aed4e37345f1700495a2f8dc6e2ddf
```

## 遗留（上轮非阻断，本轮未修）

1. **R-4（低）**：同一 `(from,kind,to)` 的两条不同 `bid` 记录，L1/L2 保留哪条的 `bid/state` 仍取决于输入顺序
   （`src/core/graph.ts` `relationEdges` 的「先到先留」未变）：

```
R-4 still reproducible: true
[{"from":"ses_a","to":"ses_b","kind":"handoff","bid":"b_one","state":"claimed"}]
[{"from":"ses_a","to":"ses_b","kind":"handoff","bid":"b_two","state":"open"}]
```

   GUI/TUI 都不显示 `bid`，用户不可见；但 docs/CHANGELOG 的「输入数组倒序一致」强断言在该组合下不成立。
2. **R-6（低，存疑未实测）**：点图中「未被快照列出」的邻居（如 `origin` 链头）仍会触发
   `panel.selectedGone` toast 并弹回 L0。本 delta 后 `origin` 链头节点在真实路径中出现，触发概率略增。
3. **D-3（低）**：跨界 spawn/subagent 线型（见 §2）。

## 本轮可逆性声明

- 只临时改过 `src/core/snapshot.ts`（M3）与 `src/gui.tsx`（M4），均从 `/tmp/opencode/*.bak` 还原，
  `sha256sum -c` 通过，并重新 build + 全量回归（全绿）。
- 未 commit / 未 push / 未 `git add`；未动真实会话、未 restart。
