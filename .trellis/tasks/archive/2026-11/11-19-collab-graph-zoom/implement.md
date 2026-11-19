# 执行计划：图缩放/拖拽/布局

- [x] `src/core/graph-layout.ts`（新，纯函数）：`layout(nodes)` → 坐标（640×360，中心 + 内环 + 外环，标签 8 字）；
      单测：8 节点包围盒不相交、两次一致
- [x] `src/gui.tsx`：`viewBox` 由缩放/平移状态驱动；滚轮缩放（0.6–2.5，以指针为中心）、拖拽平移（钳制）、双击复位
- [x] 命中补偿：缩放/平移后点击节点/折叠仍正确（用 `getBoundingClientRect` 或 viewBox 反算）
- [x] 测试：`test/graph-shape.mjs` 增布局用例；`gui-panel.mjs` 增滚轮/拖拽/复位 + 缩放后点击
- [x] 变异：去掉间距 → 重叠断言失败；缩放不钳制 → 边界断言失败
- [x] 文档：`docs/collab.md` §11.11.8、README、CHANGELOG；版本 0.8.2

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```
