# 设计：协作看板三层展开

## 1. 派生层（`src/core/board.ts`，无 IO）

```ts
interface BoardSession {
  sid: string; title: string; agent: string; busy: boolean;
  archived: boolean; frozen?: { until: number; reason: string };
  urgent: boolean;                       // 该会话任一张单 priority=urgent
  locks: SnapshotLock[];                 // holders 或 waiting 含本 sid
  handoffs: SnapshotHandoff[];           // from 或 claimBy === 本 sid
  spawned: Array<{ sid: string; state: string; archived: boolean; title?: string }>;
  queue: SnapshotQueueItem[];            // owner-queue（属于本 sid 提交的）
}
interface BoardWorkspace { workspace: string; sessions: BoardSession[]; archived: BoardSession[]; counts: {...} }

export function buildBoard(snapshot: Snapshot, freezes: FreezeEntry[], now: number): BoardWorkspace[];
```

规则：
- `spawned` 来自 `handoffs.filter(h => h.kind === 'spawn' && h.from === sid)`，用 `h.spawned ?? h.claimBy` 作子会话 id；
- `archived` 会话进 `archived[]`（不混入活跃列表）；
- `frozen` 匹配 freeze 文件的 session/workspace 作用域（过期即不显示）；
- 所有派生只读，不写任何文件。

## 2. GUI

- `PanelView` 改为渲染 `buildBoard(...)`；`GroupView` 内两个区块：活跃会话 + `已归档 N`（默认折叠）。
- 会话行：`▸/▾` + 标题 + agent + 徽标；展开后逐行渲染锁/交接/队列/`↳`。
- 展开状态放组件本地 `createSignal<Set<string>>`，不进 store（2s 轮询不应重置展开）。
- 徽标沿用现有 CSS 变量，新增 `.collab-badge` / `.collab-spawn` 两个类。

## 3. TUI

- `StatusPanel` 由「三段平铺」改为树：
  ```
  exvlan                23 会话 · 3 锁 · 5 交接 · 7 已归档
    ▾ ses_e105…  trellis-implement  rstun 独立化  🔒1 ‹1›
        ↳ ses_e104…  T1 互操作矩阵  run  [archived]
        b_14528…  claimed  剩 4m
  ```
- 展开/收起：`onMouseDown` + `keymap.layer`（`enter`/`space` 切换，`j/k` 移动）——只在该面板拥有输入时生效；
- 默认折叠；`已归档 N` 作为末段。
- 侧栏（`sidebar.content`）仍只显示四数一行，不改。

## 4. 快照新增字段（可选）

```ts
SnapshotSession.archived?: boolean;
SnapshotHandoff.kind?: 'handoff' | 'spawn';
SnapshotHandoff.spawned?: string;
SnapshotHandoff.priority?: 'urgent';
```

`src/core/snapshot.ts` 从 `info.time.archived`、记录的 `claim.kind`/`claim.by`/`priority` 填充；
缺字段一律 `undefined`，渲染层按 false 处理。

## 5. 测试

| 用例 | 期望 |
| --- | --- |
| `buildBoard` 构造快照 | 结构、spawn 关系、archived 分流、urgent/frozen 标记正确 |
| 老快照（无新字段） | 不崩、无空徽标 |
| GUI 渲染 | 默认只见活跃 + `已归档 1`；展开见明细 |
| TUI 渲染 | 字符帧含 `↳` 行与徽标；`enter` 可展开 |
| 变异 | spawn 关系画错 / 归档默认显示 → 断言失败 |

## 6. 回滚

`git restore -- src/core/board.ts src/gui.tsx src/tui.tsx src/core/snapshot.ts src/rpc.ts`；
展示层无运行时开关，回滚即回平铺。
