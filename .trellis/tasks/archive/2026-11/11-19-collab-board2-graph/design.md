# 设计：三级关系图

## 1. 派生

```ts
type GraphLevel = 'global' | 'workspace' | 'session';
interface GraphNode { id: string; kind: 'workspace'|'session'; label: string; archived?: boolean; frozen?: boolean; urgent?: boolean; parent?: string; x?: number; y?: number }
interface GraphEdge { from: string; to: string; kind: 'handoff'|'origin'|'spawn'|'subagent'; bid?: string; state?: string; count?: number }
buildGraph(snapshot, freezes, { level, workspace, session }): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: number }
```

- 边来源：handoff `{from.sid → claim.by}`；`origin` 存在时加 `origin → from`；spawn `from → spawned`；`parent → child`；
- L0 折叠：同一对工作区多条边合并为一条 `count`；
- L2 以选中会话为中心，取直接邻居；超过 8 → `truncated`；
- 排序：节点按 `id`，边按 `from+kind+to`，保证两次渲染一致。

## 2. GUI

- `<svg viewBox="0 0 320 180">`；节点 = `<g>`（矩形 + 文本），边 = `<path>`；坐标用简单分层布局（按 level 分列，列内均分），**不做力导向**；
- 交互：`onClick` 选中、节点角标 `onClick` 折叠（`stopPropagation`）、`onMouseEnter` 高亮（本地 signal `hovered`）；
- 折叠集合：`createSignal<Set<string>>`，仅组件内存。

## 3. TUI

- 文本树按 BFS 缩进 2 空格；边用 `─交接─▶` / `┄origin┄▶` / `┈spawn┈▶`；宽度不足按 `truncate` 截断 + `…`。

## 4. 测试

| 用例 | 期望 |
| --- | --- |
| 三份快照（L0/L1/L2） | 节点/边/方向/类型正确 |
| 同快照两次 | 输出字节一致 |
| 节点超限 | `+N` |
| GUI 交互 | 点选联动、折叠、悬停 |
| TUI | 文本树、窄宽度 |

变异：边方向画反 → L2 断言失败；排序改成 Map 插入序 → 一致性断言失败。

## 5. 回滚

`git restore -- src/core/graph.ts src/gui.tsx src/tui.tsx`。
