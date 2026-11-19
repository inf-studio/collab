# 设计：契约决策记录（decisions）

## 1. 数据

```ts
interface BroadcastDecision { id: string; decision: string; rationale?: string; at: number; by: string }
BroadcastRecord.decisions?: BroadcastDecision[];   // 每单上限 20，按 id 覆盖
```

- `id` ≤40 字（如 `exit-code` / `D-064`）；`decision` ≤200 字；`rationale` ≤400 字；`items` 每次 1–10 条。
- 重复 `id` → **覆盖**（保留 `at/by` 为本次），不追加重复。

## 2. 工具

```text
collab_decisions { bid, items:[{id,decision,rationale?}], confirm }
```

- 只写记录：**不投递、不改 `state/claim/receipt/replies`**；
- 预览（`confirm:false`）不写；
- 权限：**本单发起方（`from.sid`）或承接方（`claim.by`）**；其余可读拒绝（比 `blocked` 更严——`asked`/`origin` 不得写）；
- 超 20 条 → 可读拒绝（不静默淘汰）。

## 3. 展示

- `collab_status { bid }`：`决策 N 条` + 最近 3 条（`id: decision`，rationale 截断）；
- 承接方注入（`takeoverBody`）：只加**一行** `本单决策 N 条（collab_status {bid} 查看）`，不展开全文；
- `collab_list` 行尾：`decisions=N`（仅 N>0）。

## 4. 兼容与安全

- 无 `decisions`：所有输出与 0.7.0 之前逐字一致；
- 纯展示字段；不放宽任何护栏；不对 protected 目标投递（本来就不投递）。

## 5. 测试

| 用例 | 期望 |
| --- | --- |
| 写 3 条 | status 显示「决策 3 条」+ 最近 3 条 |
| 重复 id | 覆盖、不重复计数 |
| 超 20 条 | 可读拒绝、0 写入 |
| 第三方写 | 拒绝、0 写入（目录 hash 不变） |
| `confirm:false` | 不写 |
| 注入 | 只有一行计数，不展开正文 |
| 状态不变 | `state/claim/receipt/replies` 前后一致 |
| 无 decisions | 输出逐字同旧版 |

变异：权限放宽成任意会话 → 第三方断言失败；重复 id 追加而非覆盖 → 计数断言失败。

## 6. 回滚

`git restore -- src/tools/decisions.ts src/tools/{status,index}.ts src/core/verdict.ts src/types.ts`；旧记录无 `decisions` 字段。
