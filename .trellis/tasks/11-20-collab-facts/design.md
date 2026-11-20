# 设计：事实账本 + settle/invalidate（0.9.4）

## 1. 边界

工作区级（D4/D6）。只处理"事实"的登记、作废与传播，不改投递、不改闸门。

## 2. 模块

| 文件 | 职责 |
|---|---|
| `src/core/facts.ts`（新） | Fact 类型、读写 `collab-facts.json`、epoch、retract/supersede |
| `src/core/tri-state.ts`（新） | `compare(basedOn)` → `fresh` / `stale` / `conflict` |
| `src/core/glossary.ts`（新） | 术语表（每对会话 3–10 条）、冲突检测 |
| `src/tools/fact.ts`（新） | `collab_fact {action: settle\|retract\|invalidate\|list}`（26 → 27） |
| `src/core/messages.ts` | 发送时写 `grade` / `factIds` / `basedOn` |
| `src/hooks/context.ts` | `[settled]` / `[retracted]` / `[未标注]` / `[glossary]` |

## 3. 存储

```jsonc
// ~/.config/opencode/collab-facts.json
{ "v": 1, "epoch": 7, "workspace": "/data/project/muke-interface",
  "facts": [
    { "id": "F3", "claim": "serverId 恒非空", "grade": "measured",
      "evidence": "repo/era RedisClient.php:601", "state": "active",
      "basedOn": { "repo": {"repo/era": "20e35a51"}, "facts": 5 },
      "by": "ses_…", "at": 0, "supersededBy": null, "scope": "workspace" }
  ] }
```

- `epoch` 在每次 `invalidate` 成功后 +1；
- 上限 **2000 条**（永久库的边界），超出按 `state != 'active'` 优先淘汰最旧；
- 写：`tmp + rename`。

## 4. 动作

| action | 语义 | 校验 |
|---|---|---|
| `settle` | 新事实或覆盖同 `claim` 的旧事实 | `claim`/`evidence` 非空；`grade` 必填 |
| `retract {id, reason}` | `state='retracted'` | `id` 存在；`reason` 非空 |
| `invalidate {since}` | 该事实**及其派生**（`basedOn.facts ≤ since`）全部 `superseded`；`epoch+1` | `since` 是合法 `F#` 或 epoch |
| `list` | 只读，默认只列 `active` | — |

派生判定：`fact.basedOn.facts <= sinceEpoch` 且 `id != since` → `supersededBy = since`。

## 5. 证据等级（D5）

- 发送时 `grade` 缺省 → `'unknown'`；
- 接收注入：`grade === 'unknown'` → 消息前标 `[未标注]`；
- `relayed` 事实不可作为 `settle` 的 `evidence`（拒绝并提示补 `measured`）；
- 统计：`metrics.retract_count` 当日计数（retract + supersede）。

## 6. 三态判定

```
localState = { repo: HEAD(每个已知仓库), env: 各 .env 的 sha1 前 8 位, facts: epoch }
compare(basedOn):
  basedOn 缺失            → fresh + [基线未知]        (D2)
  repo/env 均 ≤ 本地 且 facts ≤ epoch → fresh
  repo/env 有落后                    → stale（只回增量）
  双方各有超前（分叉）                → conflict（升决策，0.9.5）
```

`stale` 时注入附一句：

```
[stale] 本条基于 <commit>，你已到 <commit2>；只回增量（≤30% 原文），不要重述已作废事实
```

## 7. 在途失效

`invalidate` 后，扫描该工作区所有契约的 todos：

- `todo.ref.factId` 命中被作废事实 → todo 保留但加 `staleWork: true`；
- 注入 `[todo]` 行尾标 `⚠失效`；
- 不自动关闭（避免替人做决定）。

## 8. glossary

- 每对会话（`from+to` 规范化排序）维护 `terms: [{term, meaning, at, by}]`，3–10 条；
- 注入 `[glossary] 状态=读后立即；已发版=hotfix 正式化`（≤1 行）；
- 同一 term 第 2 次出现在冲突上下文（`conflict` 或显式 `glossary-conflict`）→ 拒绝继续，要求先定义。

## 9. 测试

| 用例 | 断言 |
|---|---|
| settle + list | active 可见，id 连续 |
| retract | state=retracted，metrics +1 |
| invalidate F3 | F3 及派生 `superseded`，epoch+1 |
| relayed 当证据 | 拒绝 |
| 未标注消息 | 注入含 `[未标注]` |
| basedOn 落后 | 判 stale，注入含 `[stale]` |
| 分叉 | 判 conflict |
| 无 basedOn | 判 fresh + `[基线未知]` |
| invalidate 后在途 todo | 标 `staleWork` + `⚠失效` |
| 第 2 次术语冲突 | 拒绝继续 |

变异：`compare` 恒返回 fresh → stale/conflict 用例必红。

## 10. 回滚

```bash
rm -f ~/.config/opencode/collab-facts.json
git restore -- src/core/messages.ts src/hooks/context.ts src/tools/index.ts
rm -f src/core/facts.ts src/core/tri-state.ts src/core/glossary.ts src/tools/fact.ts
```
