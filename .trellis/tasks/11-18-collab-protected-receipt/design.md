# 设计：pull 模式 + 限界 reply

## 1. 数据

```ts
// BroadcastRecord 新增（只增字段，不改既有键）
receiptMode?: 'push' | 'pull'   // 缺省视为 push
```

创建时判定：

```ts
const requesterProtected = Boolean(await lineage.protectedAncestor(fromSid, config.protect))
record.receiptMode = requesterProtected ? 'pull' : 'push'
```

`protectedAncestor` 已含「自身或任意祖先」语义，直接复用。

## 2. 文案（R1）

`handoffActions({ bid, requester, receiptMode, … })`：

| 模式 | ② 回执行 |
| --- | --- |
| `push` | 现状：`collab_send { target:"<requester>", text:"[handoff] DONE|BLOCKED <bid> …" }` |
| `pull` | `在本会话最后一条回复里写一行：[handoff] DONE|BLOCKED <bid> <摘要>（发起方在租约到期后只读提取；不要尝试 collab_send，该目标在 protect 名单内）` |

同步修改：
- `collab_accept` 的输出（accept.ts）按 `record.receiptMode` 分支；
- 租约提醒（chain.ts `injectionFor` 的 `reminded` 行）在 pull 模式追加一句「结果将从承接方会话提取」。

## 3. 限界 reply（R2）

新增 `canReplyToProtected(ctx, { target, sender, kind, bid })`：

```
if (kind !== 'reply') return false
record = readBroadcast(bid)
if (!record) return false
return record.from?.sid === target && record.claim?.by === sender
```

- **bid 解析顺序**：工具入参 `bid?` → 正文正则 `\b(b_[0-9a-f]{8,32})\b`；
- 只对 `reply` 生效；`request` / `note` / `steer` 维持 fail-closed；
- 记录命中后不修改记录状态（回执解析由既有 `applyReceipt` 负责）。

`deliver()` 增加参数 `allowProtectedReply?: boolean`，在 `guard` 命中时：

```ts
if (guard && !allowProtectedReply) throw ...
```

允许时在返回文案追加「注: 本单由该受保护会话发起，回执按白名单放行」。

## 4. 兼容与安全

| 面 | 处理 |
| --- | --- |
| 既有非受保护流程 | `receiptMode` 为 `push`，文案与行为不变 |
| 存储 | 仅新增字段；旧记录无 `receiptMode` 视为 `push` |
| 护栏 | 三条件全中才放行；`BUILTIN_PROTECT` 名单不变；`notifyRequester` 仍 fail-closed（它是 note） |
| 伪造风险 | 需同时知道 bid、是 claim.by、且目标是该单发起方；不满足即拒 |
| 回滚 | 删除 `allowProtectedReply` 分支与 `receiptMode` 读取即可；无数据迁移 |

## 5. 需要覆盖的回归

| 用例 | 期望 |
| --- | --- |
| 受保护 requester 的 spawn 文案 | 不含 `collab_send`，含「最后一条回复写 `[handoff]`」 |
| 记录字段 | `receiptMode === 'pull'` |
| 非受保护 requester | `receiptMode !== 'pull'`，文案不变 |
| pull 提取 | 承接方最后一条回复含 `[handoff] DONE <bid>` → 到期后 `done` |
| reply 白名单 | 三条件全中 → 成功；sender 错 / target 错 / bid 错 → 拒绝 |
| request 到 protected | 仍拒绝 |
| 既有 279 项 | 全绿 |


## 6. 自动提取扩面（R7）

现状：`refresh()` 仅当 `claim.kind === 'spawn'` 才尝试 `extractVerdict`（`src/core/chain.ts:328`）。
导致 `accept` / `handoff` 领取的单（本地交接、非 bootstrap 领取）永远不会自动收口。

改法：

- 触发条件改为 `lapsed && current.from?.sid && claim.by`（不限 kind）；
- `extractVerdict` 的结论识别补两类模式：
  - 「回执被硬拒 / 改回写提案 / 无法投递」→ `blocked`（附原因摘要）；
  - 「已自愈 / 无需处理 / 不需要改」→ `blocked`；
- 仍只读承接方**最后一条** assistant 文本，仍要求 `[handoff]` 行目标匹配优先，避免误判；
- 提取成功时同样写 `receipt{auto:true}` + `done|blocked`、释放锁、不 attempts++。

回归：`accept` / `handoff` 到期后能收口；无结论时走原顺延。
