# PRD：0.6.1 看板收尾（3 条低风险 nit）

## 背景

0.6.0 复核对 `board` 子任务给出 3 条低风险遗留（其余 F1/F2 已修）：

1. `src/core/board.ts` **复制了一份冻结优先级**（session/祖先 > workspace > 过期判定），与 `src/core/freeze.ts` 的 `freezeFor/frozenBy` 是两份实现——规则改动会漂移。
2. `boardOrphans` 未进 `__internals`，只有端到端覆盖，**没有纯单测**（分类错了要等 GUI/TUI 渲染才暴露）。
3. 键盘分派测试只直接调 `run()`；真实宿主还会看 `enabled()` 与焦点——**「按键真实分派」未覆盖**。

## 需求

- **R1 单一真源**：`board.ts` 不再自行判断冻结优先级，改为调用 `core/freeze.ts` 的导出函数（缺失时由调用方传入已解析的 freeze 列表）；`buildBoard(snapshot, freezes, now)` 的形参语义写进注释。
- **R2 纯单测**：`boardOrphans` 进 `__internals`；`test/board-shape.mjs` 增：孤儿锁/交接/队列分类、与 `buildBoard` 不重叠、空输入、全部被认领时为空。
- **R3 按键分派**：TUI 测试改为「宿主形状」——先过 `enabled()`（面板聚焦/非聚焦、当前面板名），再 `run()`；断言非当前面板时按键不生效、切回后生效。
- **R4 范围**：只动 `src/core/board.ts`、`src/index.ts`、`test/board-shape.mjs`、`test/tui-render.mjs`、必要的注释/文档；不改行为、不改快照字段。
- **R5 版本**：`0.6.1`（patch），`package.json` / `PLUGIN_VERSION` / gui 常量三处同步。

## 验收

- [ ] `board.ts` 内不再有 `until`/`session|workspace` 优先级判断的副本（grep 证明唯一实现仍在 `freeze.ts`）；
- [ ] `boardOrphans` 4 条纯单测全绿，且**变异**（把某类孤儿从结果里删掉）能让对应断言失败；
- [ ] 按键：`enabled()===false` 时 `run()` 不被调用；`enabled()===true` 时一次 `enter` 只 toggle 一次；
- [ ] 全量回归 `735 + 12 + 13(+n) + 50 + 44 + 47 + 17` 全绿；工具数仍 20；
- [ ] 版本三处一致 = `0.6.1`，`check-skill` 通过。

## 非目标

- 不改看板布局、不改快照契约、不发 minor。
