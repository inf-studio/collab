# 受保护发起方的回执死锁（`receiptMode=pull` + 限界 reply）

> 来源：`docs/issues/bugs-protected-requester-receipt-undeliverable.md`（std-ui 提出，复核结论：**部分成立（修正描述后成立）**）。

## 问题

`scope=peer` 广播由受保护会话发起（`record.from.sid ∈ BUILTIN_PROTECT`）时：

1. 接管请求**要求**承接方 `collab_send {target:"<requester>"}` 回执；
2. `deliver()` 的血缘护栏对**所有** `kind`（含 `reply` / `note`）拒绝投递到受保护目标；
3. 结果：模型被引导去撞墙；闭环只能靠租约到期后的启发式拉取（`extractVerdict`）。

## Requirements

- **R1 pull 模式**：广播创建时若 `record.from.sid` 命中 `protectedAncestor`，记录置 `receiptMode:"pull"`。
  `handoffActions()`、`collab_accept` 输出、租约提醒在 pull 模式下**不再要求 `collab_send`**，改为：
  「在本会话最后一条回复写 `[handoff] DONE|BLOCKED <bid> <摘要>`；发起方租约到期后只读提取」。
- **R2 限界 reply**：`collab_send` / `collab_reply` 投递到受保护目标时，**三条同时满足**才允许：
  ① `record.from.sid === target`；② `sender === record.claim.by`；③ `bid` 归属该记录。
  `request` / `steer` / 其它来源一律 fail-closed；被允许时仍用 `queue`。
- **R3 提醒**：pull 模式的「未闭环」提醒文案说明「无需等待推送回执」。
- **R4 回归**：harness 新增 pull 文案、`receiptMode` 落盘、pull 提取闭环、reply 白名单正反例；
  既有 279 项不得回归。
- **R5 文档**：`docs/collab.md` 与 guide 增「受保护发起方（pull 模式）」小节；提案回写「已修复（0.1.2）」。
- **R6 发布**：版本 `0.1.2`，走 tag → CI 发布。
- **R7 自动提取扩面**：`refresh` 的 `extractVerdict` 从「仅 `claim.kind === 'spawn'`」扩到
  `spawn` / `accept` / `handoff` 全部领取类型；并补充结论识别（如「回执被硬拒、改回写提案」
  「已自愈/无需处理」），避免只有 `完成|done|fixed` 才判得出。

## Acceptance Criteria

- [ ] requester ∈ protect 的接管请求/accept 输出**不含** `collab_send` 回执指令，含「最后一条回复写 `[handoff]`」
- [ ] 记录出现 `receiptMode:"pull"`；非受保护 requester 行为不变
- [ ] 承接方最后一条回复写 `[handoff] DONE <bid>` → 租约到期后发起方提取为 `done`
- [ ] `kind=reply` 到受保护目标：三条件全满足时成功；任一不满足被拒；`request` 仍被拒
- [ ] harness 全绿（≥279 + 新增）；`build` / `typecheck` 通过
- [ ] `0.1.2` 发布成功；提案状态回写
- [ ] `accept` / `handoff` 领取的单也能在租约到期后自动收口（R7）

## 边界

- 不放松 `request` / `steer` 的 fail-closed；不改 `BUILTIN_PROTECT` 名单。
- 不新增运行时依赖；存储只新增字段，不改既有键。
- 不改 std-ui 工作区代码；只回写提案状态。
- **不手工干预**卡住的 `b_bdae848832cd51fb`，交由租约到期自动提取收口。
