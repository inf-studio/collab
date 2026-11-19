# 独立复核报告 · 11-19-collab-graph-zoom（0.8.2）

复核范围（未提交，`/data/project/collab` `main`，HEAD `6a2a238`）：
`src/core/graph-layout.ts`(新)、`src/gui.tsx`、`src/index.ts`、`test/graph-shape.mjs`、`test/gui-panel.mjs`、
`docs/collab.md`、`README.md`、`CHANGELOG.md`。

方法：冷上下文只读复核 + **自写探针**（`/tmp/opencode/probe-layout.mjs`、`/tmp/opencode/probe-gui.mjs`，
后者复用 `test/gui-panel.mjs` 的假宿主并另加 9 条断言）+ 5 次自做变异（4 组主题，改完即还原，sha256 校验一致）。
未 commit / push / git add；未改任何实现文件。

## 结论

**可提交。** 9 项必查全部通过，实现与 PRD R1–R6 / implement.md 一致，回归数字与基线完全吻合，
新增断言经 5 次变异证明有杀伤力、既有断言未被弱化。

唯一需修项（**文档级、1 行、不影响运行**）：`docs/collab.md:1233` 的回滚命令把 0.8.2 新增的
`src/core/graph-layout.ts` 写进了 `git restore --` 的路径列表。该文件是 **untracked**，`git restore`
遇到未知 pathspec 会整条命令报错并**一条都不还原**（我在 `/tmp/opencode/gittest` 独立验证：
`git restore -- tracked.txt untracked.txt` → `错误：路径规格 'untracked.txt' 未匹配任何 git 已知文件`，exit=1，
`tracked.txt` 仍是修改态）。建议改为两段：

```bash
git restore -- src/core/graph.ts src/gui.tsx src/tui.tsx src/index.ts test/graph-shape.mjs test/gui-panel.mjs test/tui-render.mjs
rm src/core/graph-layout.ts          # 0.8.2 新增（untracked），回滚时单独删除
```

---

## 1. 布局不重叠 / 标签截断 / 确定性 —— **通过**

证据（实现）：`src/core/graph-layout.ts:253-277`（`layoutGraph`，环排布 → `isDisjoint` 自检 → 6 列网格兜底）、
`:178-196`（`isDisjoint`/`overlaps`）、`:203-226`（中心 + 内环 ≤6 + 外环）、`:229-244`（网格）、
`:103-109`（`truncateLabel`，`Array.from` 按码点）、`:50-67`（640×360 / 8 码点 / 盒 44–96 / 间距 6 / 0.6–2.5 / 10%）。

**我自己的盒模型**（不复用 src 或 test 的任何 helper，用区间相交 `min(right)-max(left)`，要求两轴
**同时 >0** 才算重叠）：

- 8 节点、标题全为超长混合文本（CJK + 拉丁 + emoji + 空串 + 200 字符）：
  `PASS 8 long-label nodes: no two boxes overlap — none`；
- 标签全部 ≤ 8 码点：`["定点复核 P2…","aaaaaaa…","🚀🚀🚀🚀🚀🚀🚀…","关系图缩放与布…","short","","xxxxxxx…","中英Mixed…"]`；
- **1…48 各计数**：PASS；**最坏情形（每盒 96 宽，8 个全角字）1…48**：PASS；
- 两次布局 `JSON.stringify` 字节一致：PASS；
- **输入倒序**：经 `buildGraph`（`src/core/graph.ts:139-145` 码位排序）后布局字节一致：PASS；
- 文本带 vs 盒宽（9px 等宽字体模型：窄 5.5 / 全角 9.1，故意比实现的 5.4/9 略宽）：全部 padding ≥ 0，无溢出到角标位。

另：`truncateLabel('🚀×5',3) === '🚀🚀…'`（不劈代理对）；`ses_crowd_*` 8 节点中心/内环/外环坐标与
`research/impl-notes.md` §「8 节点样例」逐字一致。

## 2. 缩放（夹取 + 以指针为中心 + 双击复位）—— **通过**

实现：`graph-layout.ts:306-310`（`clampZoom`）、`:322-337`（`viewBoxOf`，10% 边距 + `zoom<1` 时居中）、
`:364-399`（`zoomBy`，`exp(-deltaY/500)` + 指针锚点 + `clampPan` 收尾）；接线 `src/gui.tsx:903-905`、
:917-921（`onDblClick` → `insideGraphNode` 判定）。

- 三档 viewBox 逐字：`1× → 0 0 640 360`、`0.6× → -213.3 -120 1066.7 600`、`2.5× → 192 108 256 144`；
- **以指针为中心**（我自己构造：**非原点 rect** `left=100 top=50 560×315`、**已有 pan** `1.3× / pan(12,-9)`、
  指针在 31%/72% 处）：`graphX 238.46 → 238.46`（误差 0.00，渲染取整后 ≈0.05）；
- 滚轮上下 5 档互逆回到原值（`z: 1.37 → 1.9834 → 1.37`，pan 复原 1e-6 内）；
- `deltaY = 0 / NaN` 为 no-op，viewBox 无 `NaN`；
- 界面侧（假宿主，真 bundle）：60 档上滚钳到 `2.5×`（viewBox `[96,162,256,144]`）、120 档下滚钳到 `0.6×`
  （`[-213.3,-120,1066.7,600]`），无 NaN；
- 双击空白 → `[0,0,640,360]` 且 `data-graph-pan` 归零；**双击节点 → zoom 不变**（`1.822 → 1.822`）。

## 3. 拖拽（pan / 钳制 / 监听器 / 不误选）—— **通过**

实现：`src/gui.tsx:929-967`（`stopDragging`、`onPointerDown` 起拖、`document` 上 `pointermove/up/cancel`、
`onCleanup` 收尾），`:957-962` 客户端像素 → view 单位换算（`box.width / rect.width`）。

假宿主实测（`documentStub.listeners` 计数）：

```
RZ4 … {"listenersIdle":{"move":0,"up":0,"cancel":0},
      "listenersDuring":{"move":1,"up":1,"cancel":1},
      "listenersAfter":{"move":0,"up":0,"cancel":0},
      "panned":{"box":[-64,0,640,360],"pan":[-64,0]},"after":[-64,0,640,360]}
RZ7 disposing the panel mid-drag removes pointermove/up/cancel (no leak, no throw)
    {"beforeUnmount":{…0,0,0},"duringUnmount":{…1,1,1},"afterUnmount":{…0,0,0},"threw":false}
```

- 越界钳到 10% 边：1× 时 `±64 / ±36`；2.5× 时 `±256 / ±144`（`clampPan` 与 `viewBoxOf` 同源，不会互相矛盾）；
- `pointerup` 之后再 `pointermove` 不改变视图（监听器确实摘了）；
- 卸载中的 `pointermove/up` 不抛（闭包不引用已废弃节点）；
- **拖拽不选中节点**：整段手势前后 `el.textContent` 逐字相同、`toasts/opened/copied` 全 0；
- 右键（`button:2`）不起拖；在节点上 `pointerdown` 不起拖（`RZ5b/RZ5c` 通过）。

## 4. 命中（缩放后点击 / 折叠）—— **通过**

实现方式正确：节点几何永远来自布局（`gui.tsx:1076-1085` rect、`:1096-1116` 角标），缩放/平移只写
`viewBox`（`:885`），**没有自己做命中换算**，所以不存在"忘了补偿"的路径。

假宿主在 2.5× 下实测：节点 rect `{x:286,y:169,width:68,height:22}` 与 1× 时**逐字相同**；点节点 → 左列表
出现 `collab-session-selected`；点 `▸/▾` → 一跳节点消失（折叠），再点 → 复原。

说明（非缺陷）：mini DOM 不实现 viewBox 变换，所以"缩放后点击仍命中"这条断言在测试里是**间接**的
（等价于断言几何不变 + 元素仍在树上）。真正的命中由浏览器按变换后的几何做，实现没有可出错的假设，
因此这个间接证明是充分的。双击 `▸/▾` 角标会复位视图（角标是节点 `<g>` 的**兄弟**，不是子节点）——见风险 R-B。

## 5. 只读（不写状态 / 不发 RPC）—— **通过**

- 手势只操作两个本地信号（`gui.tsx:821-823`），无文件写、无 localStorage、无 `node:fs`
  （`grep localStorage|writeFile|node:fs src/gui.tsx src/core/graph-layout.ts` → 无命中）；
- 用**计数 client** 实测：`rpcBefore = 1 → rpcAfterGesture = 1`（0 新增 snapshot），
  `toasts/opened/copied` 全 0，选中文本未变；
- `src/core/graph-layout.ts` 全文件无副作用（纯函数 + 常量），`dist/*` 无新增依赖（`package.json` /
  lockfile diff 为空）。

## 6. TUI 不变（R6）—— **通过**

`git diff --stat src/tui.tsx test/tui-render.mjs` → 空；`test/tui-render.mjs` **60/60**（与基线同数同断言）。

## 7. 回归与范围 —— **通过**

```
pnpm build       ✓（gui-experimental.cjs 64.05 kB / tui.js 56.58 kB）
pnpm typecheck   ✓ tsc --noEmit 无输出
test/handoff-harness.mjs   899/899
test/readonly-default.mjs   12/12
test/board-shape.mjs        20/20
test/graph-shape.mjs        53/53   （基线 36）
test/snapshot-shape.mjs     54/54
test/tui-render.mjs         60/60
test/gui-entry.mjs          47/47
test/gui-panel.mjs          82/82   （基线 68）
node scripts/check-skill.mjs → skills ok
```

- 合计 `899 + 12 + 20 + 53 + 54 + 60 + 47 + 82`，与任务给的期望**逐项相等**；
- 工具数仍 **22**（`test/handoff-harness.mjs:9272`、`:10842` 两条 `tools.length === 22` 未动，通过）；
- 版本 `package.json:3` / `src/constants.ts:441` 仍是 **0.8.1**，符合「父任务统一改 0.8.2」；
  `CHANGELOG.md:6` 已加 `## [0.8.2] - 2026-11-19`；
- 无新依赖；`src/graph.ts` 派生未改（只被 GUI 调用方式改变）；
- `src/index.ts:432-441` 的 `__internals` 增量**是必要的**：`test/graph-shape.mjs` 从 `dist/index.js` 取
  纯函数（该文件既有用途就是给 harness 导出纯 helper，`buildGraph` / `countsOf` 同款），没有第二条
  测试 `src/` 源码的通道，也不应新增一条。

## 8. 测试真实性（我自己做的 4 组变异）—— **通过**

改完立即 `cp` 还原并用 `sha256sum` 校验：
`9cde91d267b9b2ab4d505f61338546cd3800bf01b1089903eb02bb5997b5f69d`（原/还原一致）。

| 变异 | 改动 | 结果 |
| --- | --- | --- |
| **M1a** 只收紧环（`INNER_RX 124→44`、`INNER_RY 84→30`），保留自检 | `graph-layout.ts:70-71` | graph **52/53**、panel **82/82** —— 自检把环排布踢回网格，**不重叠断言仍绿**（证明自检是真兜底），唯一红的是 `GR layout R3: the selected session is the centre`（网格把中心放到格心） |
| **M1b** M1a + `isDisjoint` 直接 `return true` | `:178` | graph **51/53**：`8 nodes … no two node boxes intersect — overlaps: ses_center×ses_n01, …`、`every count 1…24 …`；panel **81/82**：`PN11 R3: the eight rendered boxes do not intersect … overlaps: ses_crowd_00×ses_crowd_01, …` |
| **M2** `clampZoom` 直接 `return Number(zoom)` | `:306` | graph **53→52**：`zoom is clamped to [0.6, 2.5] — 9 / 0.05 / NaN`；panel **82→81**：`the zoom range is clamped … {"top":{"zoom":4447.07,"box":[372.7,150.3,0.1,0.1]}, "bottom":{"zoom":5.0e-4,…}}` |
| **M3** `clampPan` 原样返回 pan | `:344` | graph **50/53** 三条红（0.6× 居中 / 越界拉回 / 2.5× 更大范围）；panel **81/82**：`dragging right pans … {"box":[-64,0,640,360],"pan":[-2280,0]}` |
| **M4**（额外）`zoomBy` 锚点写死 `fx=fy=0.5` | `:380-381` | graph **52/53**：`the graph point under the pointer stays under the pointer`；panel **81/82**：`wheel up zooms in around the pointer … {"anchorX":427.25,"anchorY":119.625}`；**我的探针同时红**（`graphX 238.46→261.31`） |

结论：新增断言**不是自证**（读的是 viewBox 数值 / 渲染出来的 rect 属性，不是实现自报的布尔）；
`git diff -U0 test/*.mjs` 里被删除的行共 5 行、3 处，全是无行为变化的改写：`__internals` 解构改名（1 行）、
mini DOM 的 `addEventListener(){} / removeEventListener(){}` 空桩改成真记录（2 行）、`fireClick` 抽出
`fireDocumentEvent`（2 行，事件对象形状不变）。**没有任何既有断言被删或弱化**（全量数字只增不减）。
三组变异的红数与 `research/impl-notes.md` 记录一致（其 79/80、80/80 是加 2 条折叠断言之前的快照，
现为 81/82、82/82，差 2 = 新增断言，符合预期）。

## 9. 文档一致性 —— **基本通过**（1 处需修，见「结论」）

| 文档 | 位置 | 与实现对照 |
| --- | --- | --- |
| `docs/collab.md` §11.11.8 | `:1198` 新增小节、`:1200-1231` 表格 | **640×360** ✓、内环 ≤6（124×84）/ 外环（252×148）✓、**8 码点** ✓、盒 44–96 ✓、**0.6×–2.5×** ✓、`exp(-deltaY/500)` ✓、**10%** ✓、`zoom<1` 居中 ✓、`onCleanup` 摘监听 ✓、"≤96 节点不可能重叠" ✓（我实测 120 节点确实重叠，文档也只承诺 ≤96） |
| `docs/collab.md:1233` | 回滚命令 | ❌ **需修**：包含 untracked 的 `src/core/graph-layout.ts`，整条 `git restore` 会失败且不还原任何文件 |
| `README.md:107` | GUI 关系图行 | 与实现逐条一致（640×360 / 8 字 / 0.6–2.5 / 指针为中心 / 越界拉回 / 双击空白复位 / 只改 viewBox） |
| `README.md:307` | 测试条目 | `53 项关系图/布局/缩放` + `82 项 GUI 面板渲染` ✓（顺带修正了原先 stale 的 "65 项"，实际基线是 68） |
| `CHANGELOG.md:6-33` | `[0.8.2]` | 640×360 / 8 码点 / 0.6–2.5 / 指针为中心 / 10% 边 / 双击空白 / 卸载摘监听 / TUI 不变 / 回归数字，全部与实测相符 |
| i18n | `gui.tsx:1775` / `:1863` | 新增 `graph.hint` en/zh 双份，legend 只在 `nodes().length > 0` 时出现（不会在空图时多一行） |

---

## 原始输出（关键片段）

```
$ pnpm test
=== 899/899 checks passed
=== 12/12 checks passed
=== 20/20 board checks passed
=== 53/53 graph checks passed
=== 54/54 checks passed
=== 60/60 checks passed
=== 47/47 checks passed
=== 82/82 panel checks passed
$ node scripts/check-skill.mjs
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
```

```
$ node /tmp/opencode/probe-layout.mjs          # 我的独立探针（19 条）
PASS  8 long-label nodes: no two boxes overlap (independent interval test)  — none
PASS  labels truncated to 8 code points, ellipsis included
PASS  counts 1…48 non-overlapping
PASS  worst case 1…48 × (8 full-width chars, 96-wide boxes): still non-overlapping
PASS  counts 120 (beyond the 96-node grid guarantee) — report only — 114 overlapping pair(s)
PASS  two layouts of the same array are byte identical
PASS  reversed snapshot → buildGraph → layout is byte identical
PASS  zoom around the pointer keeps the graph coordinate under it (off-origin rect, pre-existing pan)
PASS  pan clamp = 10 % margin: ±64 / ±36 at 1×, ±256 / ±144 at 2.5×
=== probe-layout: 19/19 passed
```

```
$ node --conditions=browser /tmp/opencode/probe-gui.mjs   # 82 条既有 + 我加的 9 条
✓ RZ1 wheel zoom keeps the graph point under the pointer (off-origin 560×315 rect)
✓ RZ2 zoom clamps at 2.5× / 0.6× and the viewBox follows (no NaN, no runaway)
✓ RZ3 double-click on blank resets to 1×/pan 0; on a node it does nothing
✓ RZ4 drag pans, clamps at the 10 % margin, and pointerup removes every listener
✓ RZ5 zoom + drag + drag-on-node do not call the host (0 RPC, 0 toast, selection unchanged)
✓ RZ5b a pointerdown on a node does not pan the view
✓ RZ5c a right-button pointerdown on blank does not start a drag
✓ RZ6 at 1.9× the node rect is byte-identical, clicking selects, ▸/▾ folds and unfolds — {"zoom":2.5,"rect":{"x":"286","y":"169","width":"68","height":"22"},…}
✓ RZ7 disposing the panel mid-drag removes pointermove/up/cancel (no leak, no throw)
=== 91/91 panel checks passed
```

## 风险清单（均不阻断提交）

| # | 级别 | 内容 | 依据 / 触发条件 |
| --- | --- | --- | --- |
| R-A | 低 | **>96 节点**时网格兜底本身会重叠（120 节点实测 114 对相交）。`docs` 只承诺 "≤96 不可能重叠"，L2 上限 8，因此只有 L0（工作区数 >96）或 L1（单工作区会话 >96）才可能触发 | 探针 `counts 120 … 114 overlapping pair(s)`；`graph.ts:281-291` 的 `GRAPH_NODE_LIMIT` 只作用于 L2 | 
| R-B | 低 | **双击 `▸/▾` 角标会复位视图**：角标 `<g data-graph-toggle>` 是节点 `<g data-graph-node>` 的兄弟，`insideGraphNode` 认不出它 | `gui.tsx:917-921`、`:1093-1116`；实测单击折叠正常，只有双击（= 折叠+展开+复位）异常 | 
| R-C | 低 | 拖拽时**没有抑制原生文本选中**：`.collab-graph-svg` 只有 `cursor:grab` / `touch-action:none`，缺 `user-select:none`，真浏览器里拖过标签会出现选区高亮 | `gui.tsx:363`；mini DOM 不模拟选区，测试覆盖不到 | 
| R-D | 低 | `clampZoom(Infinity) === 1`（而 `1e9 → 2.5`）：非有限值走"非法输入"分支。只有当 `deltaY` 为 `±Infinity` 时才可达，实际不存在 | `graph-layout.ts:308` | 
| R-E | 低（PRD 有意） | 指针在图上时 `wheel` **总是** `preventDefault`，所以面板在该区域无法滚动页面（macOS 双指滑动 = 缩放）。PRD 明确要求"滚轮/双指缩放"，属预期取舍，若要改需产品决策（如 ctrl/meta 才缩放） | `gui.tsx:903-905` | 
| R-F | 低 | 切换级别/选中会话时 **zoom/pan 保留**（不清零）：2.5× 下切到 L1 会看到被放大的另一张图。PRD 未规定，两种行为都合理 | `gui.tsx:821-823`（信号不随 `props.level` 重置） | 
| R-G | 低 | 标签按**码点**截断（PRD 口径），因此 ZWJ 家族 emoji（`👨‍👩‍👧`）会被切在簇中间 → 显示半个组合。单码点 emoji 不会劈（已验证） | `graph-layout.ts:103-109`；探针 `"👨‍👩…"` | 
| R-H | 信息 | 拖拽中途滚轮缩放会用到 pointerdown 时的 `scaleX/scaleY` 与 `startPan`（下一次 move 会跳一小下）；`alt-tab` 等场景若无 `pointerup/pointercancel`，监听器留到下一次 pointerdown 或卸载 | `gui.tsx:936-967` |
| R-I | 低（文档） | `docs/collab.md:1233` 回滚命令包含 untracked 文件 → 整条命令失败（见「结论」的替换建议） | 独立 `git init` 实验复现：exit=1，tracked 未被还原 |

## 复核边界

- 未在真实 GUI 窗口 / 用户 mac 上跑（按任务硬约束），真机观感（字号、间距、触控板手感）未被验证；
- mini DOM 不实现 viewBox 变换与 CSS 布局，所以"命中"与"渲染尺寸"是间接证明（见第 4 项说明）；
- 变异的 4 次 `pnpm build` 与还原后的 `pnpm test` 均在本次复核内完成，`src/core/graph-layout.ts`
  sha256 与原文件一致，工作区状态仍为"7 改 + 1 新 + 任务目录"。
