# 受保护会话提示去重：owner-queue 与 followUps 同提案只占一行（0.4.1）

> 来源：std-ui 承接方 0.2.0 实测反馈（`t_mwls3zbk_9ac9`）。
> 现象：同一提案既可用 `collab_followup`（登记追加）也可用 `collab_request_owner`（队列），
> 两者在受保护会话的 `context` 注入里**各占一行**，指向同一份提案 → 重复轰炸。

## Requirements

- **R1 渲染去重**：`injectionFor` 对受保护会话合并两类提示后，按 `(sid, bid, issuePath)` 去重，
  **保留最新一条**（比较 `at`）；同一提案最多一行。
  - `issuePath` 为空时按 `bid` 去重；两者都没有时不去重（无法判定同一提案）。
  - 去重后总行数仍受「每次 ≤3 行」限制（先按 at 升序，去重后取前 3）。
- **R2 标记语义**：被去重掉的条目（未渲染）**不写 `seenAt`**，保持未来可提示；
  仅对被实际渲染的条目写 `seenAt`（沿用 F1 的「push 成功后」时机）。
- **R3 工具说明**：`collab_request_owner` 描述补一句：broadcast 的候选池**排除 `[protected*]`**，
  因此触达受保护会话只有两条路：本工具，或它自己 pull 提案/提示。
  同时在 `collab_followup` 描述里补：同一提案若已用 `collab_request_owner` 提交，不必再登记 followUp。
- **R4 文档**：`docs/collab.md` §11.12 增「两类提示的去重规则」；skill 同步一句。
- **R5 回归**：同提案两类提示 → 只一行（取最新）；不同提案 → 各自一行（≤3）；去重项不 stamp；
  既有 **582 + 12 + 18** 全绿。

## Acceptance Criteria

- [ ] 同 `(sid,bid,issuePath)` 的 followUp + owner-queue → 注入 1 行，内容取 `at` 更新者
- [ ] 去重掉的条目下次仍可提示（未 stamp）
- [ ] 不同提案仍各占一行，总数 ≤3
- [ ] 工具说明补齐 broadcast 排除 protected 的事实
- [ ] 既有回归全绿；`0.4.1` 发布

## 边界

- 不改队列/followUps 的存储结构与权限；不改 handoff/lease 语义。
- 去重只在**渲染层**，不合并记录、不改状态。
