# 遗留单回执：兼容无 `kind` 的 `[handoff]` 回执 + 可操作报错

> 来源：真实缺陷上报 `d_e4e7ae824f551d0f`（工具 `collab_report`，2026-11-18）。
> 现场：`b_bdae848832cd51fb`（`receiptMode:push`，`state=acked`），承接方 3 次回执均被拒。

## 问题

0.1.2 引入「限界 reply」后，回执必须显式 `kind:"reply"` 才走白名单。但 **0.1.1 及更早创建的广播**，其
接管请求文案是：

```text
collab_send { target:"<requester>", text:"[handoff] DONE <bid> <摘要>", confirm:true }
```

不带 `kind` → 默认 `request` → 白名单不适用 → 被 `deliver()` 的 protect 护栏拒绝。

结果：**遗留单永远无法闭环**（发起方受保护且不会自动触发提取），且报错只说「在 protect 名单内」，
不告诉承接方「加 `kind:"reply"` 就行」。

## Requirements

- **R1 兼容遗留回执**：`canReplyToProtected` 接受 `requestedKind ∈ {reply, request}`，
  **但必须同时满足**：
  ① 正文命中 `[handoff]` 且携带的 `bid` 等于记录 `bid`（或入参 `bid` 命中）；
  ② `record.from.sid === target`；③ `record.claim.by === sender`；④ 记录 `state ∉ done/blocked/expired`。
  `note` / `steer` 仍 fail-closed。
- **R2 可操作报错**：当投递因 protect 被拒、且命中「三条件 + 正文含 `[handoff] <bid>`」时，
  错误文案追加：`提示：这是遗留回执，请加 kind:"reply" 重发（或让对端升级到 0.1.4+）。`
- **R3 回归**：新增用例（无 kind 的 [handoff] 回执放行；无 [handoff] 的 request 仍拒；note/steer 仍拒；
  sender/target/bid 任一不符仍拒；done 记录仍拒；报错含提示）。
- **R4 发布**：`0.1.4`，tag → CI；提案/上报闭环回写。

- **R5 行首锚定**：`HANDOFF_RECEIPT_RE` 改为按行匹配（`/^[ \t]*\[handoff\][ \t]+(DONE|BLOCKED)[ \t]+(\S+)/m`），
  正文中间出现（引用、讨论）不算回执。
- **R6 push 侧回声守卫**：`parseReceiptLine` 复用 pull 侧守卫——摘要槽命中 `<摘要>` / `<原因>` / 任意 `<…>`
  占位符、否定语/计划语（未完成/不会发/完成后我会…）一律不判定。
- **R7 显式意图优先**：入站消息显式 `kind=note|request` 时**不得**被正文嗅探触发状态迁移；
  只有 `kind` 缺省（legacy）才允许正文回执。限界 reply 的白名单同样只在 `kind` 缺省或 `reply` 时生效。
- **R8（可选）**：记录 `receiptSource: "kind" | "body"`，便于 triage 区分。

> 背景：评审指出「准入判定与状态迁移共用同一条宽松正则」，兼容后引用模板会同时骗过两者。

## Acceptance Criteria

- [ ] 无 `kind` 但正文含 `[handoff] DONE <bid>` 且三条件匹配 → 投递成功、记录可闭环
- [ ] 普通 `request`（正文无 `[handoff]`）仍被拒
- [ ] 报错在被拒时给出 `kind:"reply"` 的可复制写法
- [ ] 引用模板（含真实 bid + `<摘要>`）出现在正文中段 → **不**触发状态迁移
- [ ] 显式 `kind:"note"/"request"` 携带 `[handoff] <bid>` → **不**触发迁移；缺省 kind → 行首命中才触发
- [ ] 既有 375+12 全绿；`0.1.4` 发布

## 边界

- 不放宽 `request`/`note`/`steer` 的通用投递；只认「本单回执」这一种形态。
- 不改 `BUILTIN_PROTECT`、不改存储键。
