# 设计：看板稳定 keyed 列表

## 1. 边界

只改 GUI 的列表渲染路径（`src/gui.tsx`），新增一个通用的小工具模块；不动快照、RPC、工具、TUI。

## 2. 稳定行的实现

新增 `src/core/stable-rows.ts`（纯 TS，无 DOM 依赖）：

```ts
interface StableRow<T> { key: string; value: Accessor<T> }

function createStableRows<T>(
  items: () => T[],
  keyOf: (item: T) => string
): Accessor<StableRow<T>[]>
```

- 内部 `Map<key, { value: Signal<T>; row: StableRow<T> }>` + 一个 memo；
- 每次 `items()` 变化：已存在的 key → **只 `setValue(item)`**（同一 `row` 对象引用不变）；新 key → 建一个；
  消失的 key → 移除；
- 返回的数组**只有成员增删时才是新引用**，所以 `<For each={rows()}>` 在成员不变时不重建任何节点；
- 行内读 `row.value()`（accessor），字段变化只触发该行内容更新。

调用点：
- `PanelView` 的 `groups()` → 组用 `workspace` 作 key，组内 `sessions` 用 `sid` 作 key；
- `archived` 列表用 `sid`；
- `SessionDetail` 的 `spawned` 用 `sid`/`key`。

## 3. 为什么不用 `<Index>`

`Index` 按**下标**复用：成员顺序一变（会话按活跃度重排），内容就会串行；且删除中间项时尾部内容整体错位。
按 id 复用能保证「同一会话永远同一个节点」。

## 4. 与现有状态的关系

- `selected` / `expanded` / `collapsed` 继续留在组件内存（不动）；
- 行的 `props` 改为 `item: Accessor<Session>`，组件内 `const s = () => props.item()`；
- 徽标/契约等派生仍读 `s()`，不额外缓存。

## 5. 测试

在 `test/gui-panel.mjs` 增加：

1. **节点身份**：两次快照（成员相同、标题变化）→ 用 `WeakSet` 或节点上的自定义标记断言同一行是同一对象；
2. **滚动保持**：长列表（如 40 行）→ 设 `scrollTop = 300` → 更新快照 → 断言 `scrollTop` 仍为 300；
3. **成员增删**：新增一个会话 → 只多一个节点，其余节点身份不变；删除 → 只少一个。

变异：
- 退回「每次新建对象」→ 身份断言红；
- 字段更新改成重建节点 → 身份断言红。

## 6. 兼容与回滚

- 迷你 DOM 夹具需支持 `scrollTop`（若不支持，在夹具里补一个可写属性）；
- 回滚：`git restore -- src/gui.tsx` + `rm src/core/stable-rows.ts` + 测试还原。
