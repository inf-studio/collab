# 实现记录：三级关系图（`board2-graph`）

日期：2026-11-19 · 基线 0.8.0 Unreleased（版本号未改，仍 `0.7.0`）

## 1. 交付

| 文件 | 内容 |
| --- | --- |
| `src/core/graph.ts`（新） | 纯派生 `buildGraph(snapshot, freezes, { level, workspace?, session?, now? })`；节点/边排序、L0 合并计数、L1 对端工作区占位、L2 ±1 跳 + 8 节点上限 + `truncated`；无 `node:` 导入（GUI bundle 可打包） |
| `src/index.ts` | `__internals.buildGraph`（单测入口） |
| `src/gui.tsx` | `GraphSlot` 内联 SVG（320×180 环形布局）、点节点选中、工作区标题可选（L1）、`▸/▾` 折叠一跳、悬停高亮、`+N`、级别随选中；i18n（en/zh） |
| `src/tui.tsx` | `graphRows()` 文本树（缩进 2、深度 ≤3、`─交接─▶` / `┄origin┄▶` / `┈agent┈▶` / `↳`、`clip` 截断） |
| `test/graph-shape.mjs`（新） | 32 条（L0/L1/L2、方向/类型、`+N`、两次构建 + **输入倒序**一致、目录 hash 不变、退化输入） |
| `test/gui-panel.mjs` | 34 → 46（PN10 三级别/点选/折叠/悬停/轮询；PN11 `+N`） |
| `test/tui-render.mjs` | 56 → 60（5d：L0 `─交接─▶`、L2 `↳`、30 列 `…`）；"3–5 行详情"改为**按详情块**计数（见 §6） |
| `package.json` | `test` 增加 `node test/graph-shape.mjs` |
| `docs/collab.md` | 新增 §11.11.8；§11.11.7 的「槽位为空」表述改为「GraphSlot 已挂图，ActionRow 仍空」 |
| `README.md` | 状态视图表新增「GUI 关系图」行；TUI 面板行补文本树 |
| `skills/collab/SKILL.md` | 状态视图段落补三级/交互/只读 |
| `CHANGELOG.md` | Unreleased → Added 新增 `board2-graph` 条目（含测试数与变异） |

## 2. 派生实测（构造快照：alpha 两个会话 + child + archived，beta 一个会话）

L0（`{ level: 'global' }`）：

```json
{
  "nodes": [
    { "id": "/data/project/alpha", "kind": "workspace", "label": "alpha" },
    { "id": "/data/project/beta", "kind": "workspace", "label": "beta" }
  ],
  "edges": [
    { "from": "/data/project/alpha", "to": "/data/project/beta", "kind": "handoff", "count": 2 }
  ],
  "truncated": 0
}
```

（两条 `from` 不同的跨区交接 → 一条 `count:2`；同区 spawn/handoff 不产生自环。）

L1（`{ level: 'workspace', workspace: '/data/project/alpha' }`）：

```json
{
  "nodes": ["/data/project/beta(workspace)", "ses_a1", "ses_a2", "ses_child", "ses_old(archived)"],
  "edges": [
    { "from": "ses_a1", "to": "/data/project/beta", "kind": "handoff", "bid": "b_cross_one" },
    { "from": "ses_a1", "to": "ses_child", "kind": "spawn", "bid": "b_spawn" },
    { "from": "ses_a1", "to": "ses_child", "kind": "subagent" },
    { "from": "ses_a2", "to": "/data/project/beta", "kind": "handoff", "bid": "b_cross_two" },
    { "from": "ses_a2", "to": "ses_a1", "kind": "handoff", "bid": "b_forward" }
  ],
  "truncated": 0
}
```

（`ses_b1` **不出现**——L1 只给对端一个 workspace 占位节点。）

L2（`{ level: 'session', session: 'ses_a1' }`）：

```text
nodes: ses_a1, ses_a2, ses_b1, ses_child
edges:
  ses_a1 ─handoff─▶ ses_b1      (from → claimBy)
  ses_a1 ─spawn───▶ ses_child   (spawned ?? claimBy；无 handoff 副本)
  ses_a1 ─subagent▶ ses_child   (parent → sid)
  ses_a2 ─handoff─▶ ses_a1      (方向保留)
  ses_a2 ─handoff─▶ ses_b1
```

`origin` 需以 `ses_a2` 为中心才可见（`ses_head → ses_a2`，kind `origin`）——±1 跳外不保留。

节点上限：12 邻居 + 中心 → `nodes.length === 8`、`truncated === 5`，保留 `ses_center + ses_n00…n06`。

## 3. 确定性（R4）证明

两条断言同时成立（`test/graph-shape.mjs`）：

1. 同一快照连续两次 `buildGraph` → `JSON.stringify` 字节一致；
2. **输入数组倒序**（`sessions.reverse()` + `handoffs.reverse()`）→ 输出仍是同一份字节。

实现保证：节点按 `id`、边按 `from + kind + to` 用**码位比较**（`<`/`>`，不用 `localeCompare`，后者随
机器 locale 变）。`Map` 插入序不进入契约。

## 4. GUI 实测（`test/gui-panel.mjs` PN10/PN11）

```text
PN10 L0：level=global，节点 = /data/project/alpha、/data/project/beta，边 handoff(alpha→beta)，图例「全局」
PN10 点 alpha 工作区标题 → level=workspace，节点 = alpha 两个会话 + beta 工作区占位（无 ses_g_beta01）
PN10 点 alpha 会话行 → level=session，节点 = alpha + child + beta
PN10 悬停 child 节点 → spawn 边 class 含 collab-graph-edge-active；cross 边不含（只高亮相邻）
PN10 点 child 节点 → 详情出现 ses_g_child01，左列表 collab-session-selected 落在 graph child
PN10 点 ▾（data-graph-toggle=ses_g_alpha01）→ 只剩中心；再点 → 邻居恢复
PN10 2.1s 后（loads 1 → 2，data-collab-at 变化）→ 仍为 session 级、child 仍在（折叠/选中都在本地）
PN11 12 邻居 → data-graph-node 共 8 个，.collab-graph-more 文本 "+5"
```

## 5. TUI 实测（`test/tui-render.mjs` 5d）

未选中（L0）：

```text
关系图 · 全局
  alpha
    ─交接─▶ beta
```

选中 `ses_g_a1`（j 之后再 k，游标语义按宿主）：

```text
关系图 · 会话 ses_g_a1
    ─交接─▶ ses_g_b1 · beta worker
    ↳ ses_g_child · child worker
```

宽度 30：

```text
关系图 · 会话 ses_g_child
    ↳ ses_g_child · child wor…
```

（`clip` 到面板宽度，超出 `…`；不换行错位、不抛错。）

## 6. 对既有测试的改动（说明）

- `test/tui-render.mjs` 的 “`j` selects one row and appends 3–5 detail lines” 改为**按详情块**计数
  （`详情 …` 到 `关系图`/`未闭环交接`/… 之间）。原因：0.8.0 在此块后面追加了 `关系图 · …` 段，
  原断言用「整帧行数差」会把图行也算进详情；新断言仍严格是 3–5 行，且另断言挂载时详情块为空。
- `test/gui-panel.mjs` 未削弱任何旧断言（PN8 的槽位顺序/直接子元素列表逐字未动——`GraphSlot`
  仍是 `collab-detail-section collab-graph-slot` 的真实元素）。

## 7. 变异（两组，均先失败、后还原）

### M1 边方向画反（`handoff` / `spawn` 的 from/to 互换）

```
  ✗ GR L1 workspace: both cross hand-offs point at the beta workspace node (direction kept) — []
  ✗ GR L2 session: handoff direction is from → claimBy (a1 → b1) — [{"from":"ses_b1","to":"ses_a1",...},{"from":"ses_child","to":"ses_a1",...}]
  ✗ GR L2 session: a spawn record yields ONE spawn edge (a1 → child), not a handoff copy — [{"from":"ses_a1","to":"ses_child","kind":"subagent"}]
  ✗ GR L2 session: the incoming hand-off keeps its direction (a2 → a1) — [{"from":"ses_a1","to":"ses_a2",...}]
FAIL: GR L1 workspace: both cross hand-offs point at the beta workspace node (direction kept)
FAIL: GR L2 session: handoff direction is from → claimBy (a1 → b1)
exit=1
```

还原后：`=== 32/32 graph checks passed`。

### M2 去掉节点/边排序（Map 插入序）

```
  ✗ GR determinism workspace: nodes sorted by id, edges by from+kind+to — ["ses_a1\0handoff\0/data/project/beta","ses_a2\0handoff\0/data/project/beta","ses_a1\0spawn\0ses_child",...]
  ✗ GR determinism session: nodes sorted by id, edges by from+kind+to — ["ses_a1\0handoff\0ses_b1","ses_a2\0handoff\0ses_b1","ses_a1\0spawn\0ses_child",...]
  ✗ GR determinism global: reversing the snapshot arrays yields the same graph (canonical order) — {"nodes":[{"id":"/data/project/beta"...},{"id":"/data/project/alpha"...}] ...}
  ✗ GR determinism workspace: reversing the snapshot arrays yields the same graph (canonical order) — nodes 顺序变成 ses_old / ses_child / ses_a2 / ses_a1 …
FAIL: GR determinism workspace: nodes sorted by id, edges by from+kind+to
FAIL: GR determinism global: reversing the snapshot arrays yields the same graph (canonical order)
exit=1
```

还原后：`=== 32/32 graph checks passed`。

## 8. 设计取舍（与 design.md 的差异，均有意）

1. **`origin` 不在快照契约**：`rpc.ts` 的 `SnapshotHandoff` 没有该字段，本任务不改 `rpc.ts` / `snapshot.ts`。
   `graph.ts` 以 `SnapshotHandoff & { origin?; originSid? }` 方式**可选读取**（对象/字符串两种拼写），
   缺失即不画。快照补上字段后自动生效，测试夹具里显式带 `origin`。
2. **L1 只在 GUI 出现**：TUI 没有工作区光标，级别在 L0（未选中）与 L2（选中 `ses:` 行）之间切换；
   `buildGraph` 的 L1 仍被 `test/graph-shape.mjs` 覆盖，GUI 也走它。
3. **GUI 箭头**：去掉了 `<defs><marker>`（Solid 把静态属性内联成 `viewBox="…"refX=5`，测试宿主的最小
   DOM 解析器读不了，会产生伪文本节点）。方向由派生保证（测试断言）与 TUI 文本树给出；GUI 线型区分
   实线/虚线/点线。
4. **折叠角标是兄弟元素而非嵌套 + `stopPropagation`**：避免委托事件从角标冒泡到节点触发选中；
   行为等价（点节点选中、点角标折叠）。
5. **L1 未知对端丢弃**：快照不提供未列出会话的目录，宁可丢边也不错误折叠到本工作区节点。

## 9. 验证命令与结果

```bash
pnpm typecheck        # 通过
pnpm build            # 通过（dist/index.js、gui-experimental.cjs、tui.js）
pnpm test             # 883 · 12 · 20 · 32 · 50 · 60 · 47 · 46 全绿
node scripts/check-skill.mjs   # skills ok
```

工具数仍 22（`handoff-harness` 883 条含工具面断言）；未改版本号；未新增依赖；无写路径。

---

## 10. 复核返修（check-report.md 的 3 项必修）

### 10.1 `origin` 边打通生产路径（R-3）

- `src/rpc.ts`：`SnapshotHandoff.origin?: string` + RPC 输出 schema `handoffs[].origin: str`（可选）。
- `src/core/snapshot.ts` `toHandoff`：`const origin = String(asObject(record.origin).sid ?? '')`，
  仅当 `origin && origin !== from` 时写入。单跳（`origin === from`）与 ≤0.6.0 记录都不出字段。
- `src/core/graph.ts` `originOf`：优先读 `handoff.origin`（string），仍容忍旧远端透传的
  `origin.sid` 对象 / `originSid` 拼写（对象分支改为显式 `typeof === 'object'`，避免把对象
  `String()` 成 `[object Object]`——返修中实测踩到过一次）。
- 断言：
  - `test/snapshot-shape.mjs`：`b_00000000a1` 带 `origin:{sid:'ses_head'}` → 快照 `origin==='ses_head'`；
    `b_00000000b2` 的 `origin.sid === from` → 字段**不存在**。
  - `test/graph-shape.mjs`：新增 `buildSnapshot(realSource)` → `toHandoff` → `buildGraph` 的**真实路径**
    夹具，断言快照带 `origin` 且 L2 出 `ses_real_head → ses_real_a` 的 `origin` 边；另加一条旧对象拼写
    仍可出边。

### 10.2 线型与文档一致（R-2）

`src/gui.tsx` `dashOf()`：

| kind | `stroke-dasharray` |
| --- | --- |
| `handoff` | `''`（实线；L1 对端工作区为 `'4 3'`） |
| `origin` | `'4 3'`（虚线） |
| `spawn` / `subagent` | `'1 3'`（点线） |

断言 `test/gui-panel.mjs` PN10：四类边逐条比对 `getAttribute('stroke-dasharray')`
（`{"handoff":"","origin":"4 3","spawn":"1 3","subagent":"1 3"}`）。

### 10.3 CHANGELOG 数字（R-1）

`29` → 实际条数（返修后 `test/graph-shape.mjs` = **36**）。同段同步 `snapshot-shape 50 → 52`、
`gui-panel 34 → 47`、`tui-render 56 → 60`。

### 10.4 返修后的变异（原始输出，均已还原）

**M3：去掉 `origin` 透传**（删掉 `toHandoff` 的 `...(origin && origin !== from ? { origin } : {})`）

```
snapshot-shape exit=1
  ✗ C2 a forwarded hand-off carries origin:<record.origin.sid> (graph `origin` edge) — [["b_00000000b2",null],["b_00000000a1",null],["b_00000000d4",null]]
FAIL: C2 a forwarded hand-off carries origin:<record.origin.sid> (graph `origin` edge)
graph-shape exit=1
  ✗ GR a real snapshot carries handoff.origin (toHandoff passthrough) — [{"bid":"b_real_origin",...,"claimBy":"ses_real_b",...}]
  ✗ GR a real snapshot yields the origin edge head → from (not just a hand-written fixture) — [{"from":"ses_real_a","to":"ses_real_b","kind":"handoff",...}]
FAIL: GR a real snapshot carries handoff.origin (toHandoff passthrough)
FAIL: GR a real snapshot yields the origin edge head → from (not just a hand-written fixture)
```

还原后：`=== 52/52 checks passed`、`=== 36/36 graph checks passed`。

**M4：把 `spawn` 改回实线**（`dashOf` 的 spawn/subagent 分支 `return ''`）

```
panel exit=1
  ✗ PN10 edge line styles follow R1: handoff solid / origin dashed / spawn & subagent dotted — {"handoff":"","origin":"4 3","spawn":"","subagent":""}
FAILED: PN10 edge line styles follow R1: handoff solid / origin dashed / spawn & subagent dotted
```

还原后：`=== 47/47 panel checks passed`。

### 10.5 返修后回归

```
pnpm typecheck                  # 通过
pnpm build                      # 通过
pnpm test                       # 883 · 12 · 20 · 36 · 52 · 60 · 47 · 47 全绿
node scripts/check-skill.mjs    # skills ok
```

工具数仍 22；版本仍 0.7.0；无新增依赖；只读路径未变（快照只多一个可选字符串字段）。
文档同步：`docs/collab.md` §11.11 契约块 + §11.11.8（origin 来源/透传、L1 跨界措辞、去重口径），
`README.md` 笔误，`CHANGELOG.md` 数字与 origin 描述。
