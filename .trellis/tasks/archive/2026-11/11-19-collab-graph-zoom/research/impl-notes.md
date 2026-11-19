# impl-notes — 11-19-collab-graph-zoom（0.8.2）

## 改了什么

| 文件 | 变更 |
| --- | --- |
| `src/core/graph-layout.ts` | **新增**（纯函数）：`layoutGraph` / `truncateLabel` / `labelWidth` / `boxWidth` / `viewBoxOf` / `viewBoxAttr` / `zoomBy` / `clampZoom` / `clampPan` + 常量（`GRAPH_VIEW` 640×360、`GRAPH_LABEL_MAX` 8、`GRAPH_BOX_H` 22、盒宽 44–96、缩放 0.6–2.5、平移边距 10%） |
| `src/gui.tsx` | `GraphSlot`：布局改调 `layoutGraph`（选中会话为圆心）；`viewBox` 由 `zoom`/`pan` 驱动；`onWheel`（指针为中心）、`onPointerDown` + document 上的 `pointermove`/`pointerup`（带钳制与 `onCleanup` 摘除）、`onDblClick`（空白复位，节点不复位）；节点矩形/角标/标签用布局给出的大小；CSS：`max-width:560px`、`cursor:grab`、`touch-action:none`、`.collab-graph-dragging`；i18n 增 `graph.hint`（en/zh） |
| `src/index.ts` | `__internals` 增上述纯函数（确定性测试从 `dist/index.js` 取；该文件的既有用途就是「给 harness 导出纯 helper」） |
| `test/graph-shape.mjs` | 36 → **53** 条 |
| `test/gui-panel.mjs` | 68 → **82** 条；mini DOM 的 `Elem` 增 `listeners`（真实 `addEventListener` 记录，`wheel` 不是 Solid 委托事件）与可注入的 `getBoundingClientRect` |
| `docs/collab.md` §11.11.8 | 新增「缩放 / 平移 / 布局（0.8.2）」小节 + 表格 + 测试/变异/回滚 |
| `README.md` | 关系图一行补 0.8.2 行为；测试条目数更新 |
| `CHANGELOG.md` | 新增 `## [0.8.2]`（版本号本身未改，`package.json` / `constants.ts` 仍是 0.8.1，按任务硬约束由父任务统一发版） |
| 未动 | `src/tui.tsx`（R6）、`src/core/graph.ts`（派生不变）、任何依赖、任何 git 写操作 |

## 布局：8 节点样例（L2，中心 = `ses_crowd_center`）

```
id                  x     y    w
ses_crowd_center  320   180   68   ← 中心
ses_crowd_00      320    96   62   ┐
ses_crowd_01      427.4 138   62   │ 内环 ≤6（椭圆 rx=124, ry=84）
ses_crowd_02      427.4 222   62   │ 起点 -90°，顺时针
ses_crowd_03      320   264   62   │
ses_crowd_04      212.6 222   62   │
ses_crowd_05      212.6 138   62   ┘
ses_crowd_06      320    32   62   ← 外环（rx=252, ry=148）
```

盒 = `(x - w/2, y - 11, w, 22)`。

### 不相交证明（程序化，非目测）

对每一对盒计算
`dx = |Δcx| - (wa+wb)/2`、`dy = |Δcy| - 22`；**只要 `dx ≥ 0` 或 `dy ≥ 0` 两盒就不相交**。

- 8 节点全部对：最小「分离余量」`max(dx, dy) = 42`（最紧的一对是 `ses_crowd_00 / ses_crowd_06`，
  两者同在 x=320 的竖线上，y 相差 64 → `dy = 64 - 22 = 42`）。所以 **0 对重叠，最窄处仍有 42px**。
- 更强的断言在测试里：对 **1…24** 个节点逐个数构造并检查，全部 0 重叠
  （`GR layout R3: every count 1…24 is non-overlapping`）。
- 布局本身也自检：环排布只有在 `isDisjoint()` 通过时才采用，否则退回 6 列网格
  （44–96 宽的盒 vs 106.7 的列宽，22 高的盒 vs ≥27 的行高，≤96 节点不可能重叠）。
  这也是为什么「收紧环半径」的变异只有在**同时**去掉自检时才会红。

## 缩放 / 平移实测值

| 场景 | 结果 |
| --- | --- |
| `viewBoxOf(1, {0,0})` | `0 0 640 360` |
| `viewBoxOf(0.6, {0,0})` | `-213.3 -120 1066.7 600`（视图比画布大 → 居中，pan 恒 0） |
| `viewBoxOf(2.5, {0,0})` | `192 108 256 144` |
| `clampZoom(9 / 0.05 / NaN)` | `2.5 / 0.6 / 1` |
| 滚轮一档（Δ=100） | ×`exp(±0.2)` = `1.2214`（上滚）/ `0.8187`（下滚），两者互逆 |
| 指针 (480,90) 上滚 Δ=-200 | `1× → 1.4918×`，`viewBox = 158.2 29.7 429 241.3`；指针下的图坐标 `(479.95, 90.03)`（误差 < 0.1px） |
| 拖拽 1×（向右 2000px） | `pan.x = clamp(-2000, -64, 64) = -64` → `viewBox = -64 0 640 360`（视口左移，内容右移） |
| 拖拽 1×（向左 3000px） | `pan.x = +64` → `viewBox = 64 0 640 360` |
| 拖拽 2.5×（越界） | `pan = (256, 144)` → `viewBox = 448 252 256 144`（缩到 2.5× 后可平移范围才变大） |
| 双击空白 | `1×`、`pan=(0,0)`、`viewBox = 0 0 640 360` |
| 双击节点 | 不变（`1.4918×` 保持） |

命中：节点 `rect` 的 `x/y/width` 在缩放前后**逐字相同**（测试 `… and the node geometry is untouched`），
变化只在 `viewBox` —— 命中测试由浏览器按变换后的几何做，所以缩放后点节点、点 `▸/▾` 都照旧
（PN14 三条：点节点选中、角标存在、折叠一跳仍生效）。

## 变异原始输出（改完即还原）

### M1 去掉布局自检 + 收紧内环（`INNER_RX=44, INNER_RY=30`，`isDisjoint` 直接 `return true`）

```
--- graph-shape
  ✗ GR layout R3: 8 nodes at 640×360 — no two node boxes intersect — overlaps: ses_center×ses_n01, ses_center×ses_n02, ses_center×ses_n04, ses_center×ses_n05, ses_n00×ses_n01, ses_n00×ses_n05, ses_n02×ses_n03, ses_n03×ses_n04
  ✗ GR layout R3: every count 1…24 is non-overlapping (the ring layout is verified, not assumed)
=== 51/53 graph checks passed
--- gui-panel
  ✗ PN11 R3: the eight rendered boxes do not intersect, and every label is ≤ 8 code points — {"overlaps":["ses_crowd_00×ses_crowd_01","ses_crowd_00×ses_crowd_05","ses_crowd_01×ses_crowd_center","ses_crowd_02×ses_crowd_03","ses_crowd_02×ses_crowd_center","ses_crowd_03×ses_crowd_04","ses_crowd_04×ses_crowd_center","ses_crowd_05×ses_crowd_center"], …}
=== 79/80 panel checks passed
```

### M2 去掉缩放钳制（`clampZoom` 直接返回原值）

```
--- graph-shape
  ✗ GR zoom R1: zoom is clamped to [0.6, 2.5] (a wild wheel cannot leave the range) — 9 / 0.05 / 1
=== 52/53 graph checks passed
--- gui-panel
  ✗ PN14 the zoom range is clamped: 2.5× at the top, 0.6× at the bottom (never NaN) — {"top":{"zoom":4447.066747699861,"box":[372.7,150.3,0.1,0.1]},"bottom":{"zoom":0.0005004514334406094,"box":[-639102.7,-359495.3,1278845.4,719350.5]}}
=== 79/80 panel checks passed
```

### M3 去掉平移钳制（`clampPan` 原样返回）

```
--- graph-shape
  ✗ GR zoom R1: 0.6× shows 1066.7×600 and stays centred (nothing to pan) — -213.3 -120 1066.7 600 · {"x":500,"y":500}
  ✗ GR pan R2: an over-drag is pulled back inside the 10 % margin — {"x":9999,"y":-9999}
  ✗ GR pan R2: at 2.5× the pan range is larger (the canvas is the limit, not the pointer) — {"x":9999,"y":9999}
=== 50/53 graph checks passed
--- gui-panel
  ✗ PN14 dragging right pans the view left, and an over-drag is clamped — {"box":[-64,0,640,360],"pan":[-2280,0]}
=== 79/80 panel checks passed
```

（M3 里 `viewBox` 仍被 `viewBoxOf` 钳住，但本地 `pan` 停在 -2280 → 下一次拖拽从错位起点开始；
面板断言的正是这个 `data-graph-pan`。）

三组变异都还原后复跑：`53/53` + `80/80` 全绿（随后另加 2 条折叠断言 → `82/82`）。

## 全量验收

```
pnpm build          ✓（dist/gui-experimental.cjs 64.03 kB）
pnpm typecheck      ✓
test/handoff-harness.mjs    899/899
test/readonly-default.mjs    12/12
test/board-shape.mjs         20/20
test/graph-shape.mjs         53/53   （原 36）
test/snapshot-shape.mjs      54/54
test/tui-render.mjs          60/60   （R6：文本树一条未改）
test/gui-entry.mjs           47/47
test/gui-panel.mjs           82/82   （原 68）
node scripts/check-skill.mjs  skills ok
```

工具数仍 22（`handoff-harness` 的清单断言未动）。

## 已知取舍

- 标签按**码点**截断到 8 个（含 `…`），与 0.8.0 的「总数含省略号」口径一致；中文 8 字最宽 72px，
  盒宽上限 96（72 + 12 内距 + 12 角标位）。
- 外环容量取决于最大盒宽：短标签时可容 30+ 节点，8 个中文字时约 17 个；超过环排布的自检上限
  （或总数 > 40）直接走 6 列网格，网格在 ≤96 节点内保证不重叠。L2 本身上限 8，L0/L1 才会用到网格。
- 视图在 `zoom < 1` 时比画布大，此时「平移」没有可揭示的内容，直接居中（`clampPan` 归零）。
