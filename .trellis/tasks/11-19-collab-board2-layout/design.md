# 设计：看板主从布局

## 1. 组件

```
PanelView
 └ BoardLayout            // CSS grid: 340px 1fr；窄窗口单栏
    ├ BoardSidebar        // 现有 GroupView 树（去掉详情渲染）
    └ BoardDetail
        ├ DetailHeader    // 标题 / agent / sid / [archived][frozen][urgent]
        ├ GraphSlot       // graph 子任务插入；现在渲染 null + min-height 0
        ├ ActionRow       // actions 子任务插入；现在 null
        └ DetailItems     // 锁 / 交接 / 队列 / ↳ spawned（复用 board.ts 的派生）
```

- 选中：`const [selected, setSelected] = createSignal<string | null>(null)`，按 `sid` 存（跨快照稳定）；
- 轮询：现有 `sharedStore` 2s 更新 `data`，**不触碰 selected**；`createEffect` 里检查 `selected` 是否仍存在，不在则清空 + `toast`；
- 窄窗口：`window.matchMedia('(max-width: 640px)')` 或用 CSS 容器查询；单栏时 `selected ? Detail : Sidebar` + 「← 返回」。

## 2. TUI

- `StatusPanel` 已有 `selectedKey`（`j/k` 移动）；在其下方追加 `detailLines(selectedRow)`（≤5 行，复用 `boardRows`/`lockLines`/`handoffLines`）；
- `esc` 清空选中（keymap 已有 escape 语义时复用）。

## 3. 样式

新增 `.collab-split` / `.collab-sidebar` / `.collab-detail` / `.collab-detail-section`；沿用现有 CSS 变量，不引入框架。

## 4. 测试

- `test/gui-panel.mjs`：分栏渲染、点选联动、轮询不重置、消失清空、窄屏回落（最小 DOM 探针已具备）；
- `test/tui-render.mjs`：`j/k` 后详情行、`esc` 清除、既有树不变；
- 变异：把选择存进 store（轮询会重置）→ 断言失败；窄屏不回落 → 断言失败。

## 5. 回滚

`git restore -- src/gui.tsx src/tui.tsx test/gui-panel.mjs test/tui-render.mjs`；无运行时开关。
