# 设计：决策载具 + 角色四元组（0.9.5）

## 1. 边界

只处理"决策"的登记与关闭；不投递、不改闸门。thread 与 handoff 两条路径都可用。

## 2. 模块

| 文件 | 职责 |
|---|---|
| `src/core/decisions.ts`（新） | Decision 类型、读写、去重 hash、上限、owner 校验 |
| `src/tools/decide.ts`（新） | `collab_decide {action: open\|answer\|supersede\|list}`（27 → 28） |
| `src/core/contract.ts` | `peers[].role` 读写、默认角色推导 |
| `src/hooks/context.ts` | `[role:…]` + `[decide]`（open 摘要） |
| `src/core/tri-state.ts` | `conflict` → 自动 `open` |

## 3. 存储

```
~/.config/opencode/collab-decisions/<key>.json      key = threadID 或 bid
{ "v": 1, "key": "t_…", "next": 4,
  "items": [{ "id": "D1", "question": "…", "options": ["A","B"],
              "owner": "ses_…", "status": "open|answered|superseded",
              "answer": null, "by": null, "at": 0, "hash": "…" }] }
```

写：`tmp + rename`。key 不存在时惰性创建。

> **与 0.9.1 的接口（复核记录）**：0.9.1 的 `decision:<id>` evidence 目前读 hand-off 的 `decisions[]`
> （`src/core/evidence.ts`）。本版上线独立决策账本后，必须把两处合并成**单一 resolver**
> （先读本账本，hand-off `decisions[]` 只作为兼容输入），不允许保留两套「算不算已决策」的判断。


## 4. 动作与规则

| action | 语义 | 校验 |
|---|---|---|
| `open {question, options, owner}` | 新建 `D#` | `question` 非空、`options ≥ 2`、`owner` 为合法 sid |
| `answer {id, answer}` | `status='answered'` | **调用者必须 == owner**；已回答不可再答（需先 `supersede`） |
| `supersede {id, reason}` | `status='superseded'` | 任意一方可作废，但记 `by`+`reason` |
| `list` | 只读，默认只列 open | — |

**去重**：`hash = sha1(normalize(question))`，`normalize` = 去空白 + 去标点 + 小写。
新建时若同 hash 的 `open` 已存在 → 拒绝，返回 `D3 open, wait <owner>`（不重复计数）。

**上限（D9 = 3）**：同一 key 内 `status='open'` 最多 3 条；第 4 条拒绝并提示先 `answer` 或 `supersede`。

**owner 缺省**：`owner` 未给 → `contract.peers` 中 `role='decider'`；再无 → 发单方会话（`origin` / `from`）。

## 5. 角色四元组

```ts
peers: [{ sid, role: 'requester'|'implementer'|'decider'|'verifier', threadId, since }]
```

- 未声明时按关系推导：handoff 发起方 = `requester`，承接方 = `implementer`，`decider` = 发起方 owner，`verifier` = `requester`；
- 注入 `[role:implementer]`（≤1 行）；
- 行为约束（**注入提示，不硬拦**）：
  - `implementer` 收到"请你决定实现方案" → 提示「应转 decider」；
  - `requester` 收到"请你改这个文件" → 提示「该由 implementer 执行」。
- 硬拦只在闸门层（越界），角色层只提示——避免误伤。

## 6. conflict 自动升决策

`tri-state` 判 `conflict` 时：

1. `open {question: "基线分叉：<摘要>", options: ["以我方为准","以对方为准","重新测量"], owner: decider}`；
2. 注入 `[conflict] 已开 D#，等 <owner>`；
3. 该 thread 在决策未关闭前**不再产生新消息**（降级为只读回执）。

## 7. 注入

```
[role:implementer] 你负责实现；实现选择请交 decider
[decide] D1 open（等 ses_e176…，4.2h）· D2 answered
```

## 8. 测试

| 用例 | 断言 |
|---|---|
| thread 路径 open | 成功，list 可见 |
| bid 路径 open | 成功，与 thread 互不串 |
| 非 owner answer | 拒绝 |
| 已回答再 answer | 拒绝 |
| 同问二次 open | 拒绝并返回既有 D# 与 owner |
| 第 4 条 open | 拒绝（上限 3） |
| supersede 后 open | 允许（占用释放） |
| owner 缺省 | 落到 decider |
| 角色推导 | handoff 双方角色正确 |
| conflict | 自动开 D#，thread 静默 |

变异：去重 hash 去掉 `normalize` → 「同问二次 open」必红（大小写/空白变体漏过）。

## 9. 回滚

```bash
rm -rf ~/.config/opencode/collab-decisions
git restore -- src/core/contract.ts src/hooks/context.ts src/tools/index.ts src/core/tri-state.ts
rm -f src/core/decisions.ts src/tools/decide.ts
```
