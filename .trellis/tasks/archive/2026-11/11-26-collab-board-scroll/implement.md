# 执行计划：看板稳定 keyed 列表

## 顺序

- [ ] 1. `src/core/stable-rows.ts`：`createStableRows`（Map + Signal，成员不变时引用不变）
- [ ] 2. `src/gui.tsx`：`groups()` / `sessions` / `archived` / `spawned` 改用稳定行；行组件改为 `item: Accessor<T>`
- [ ] 3. `test/gui-panel.mjs`：节点身份、滚动保持、成员增删三组用例
- [ ] 4. 文档：`docs/collab.md` 看板一节补「行按 id 复用，轮询不重建 DOM」
- [ ] 5. 门禁 + 变异 + 复核

## 门禁

```bash
HOME=<干净临时目录> pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

报数：工具数（29）、`gui-panel` 用例数、三组新用例输出。

## 变异（强制）

1. `createStableRows` 退回每次新对象 → 身份断言必红；
2. 行内容更新时重建节点 → 身份断言必红。

## 回滚

见 `design.md` §6。
