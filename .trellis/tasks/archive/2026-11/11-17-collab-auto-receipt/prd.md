# 协作链路：强制回执动作 + 租约到期自动提取结论

> 来源：`11-17-collab-hardening` 的真实跨仓试点（`research/pilot.md`，已归档）发现 **G1**。

## 背景

试点中，拉起的 `explore` 会话完成了完整核验，并在**自己的回复里**写好了应发的回执原文：

```
[handoff] BLOCKED b_a4f161ed783e6686 该提案已实施（f2f8ef52/79eac02d/631dd502），无需 implement
```

但它**没有调用任何协作工具**：既没 `collab_accept`（bid 停在 `claimed`），也没 `collab_send`。
结果链路不闭环，只能人工读它的会话内容再手工关单。

## Requirements

- **R1 强制动作顺序**：接管请求/叫醒 prompt 必须明确要求
  ① 先 `collab_accept {bid}`（领取即 acked）；
  ② 处理完（或判定不需处理）**必须**用 `collab_send` 回执；
  ③ 给出两条可直接复制的完整命令（含发起方完整 sid 与 bid）。
- **R2 租约到期自动提取**：`claimed` 的 spawn 记录租约到期时，发起方**只读**读取该会话最后一条 assistant 文本：
  - 能判定结论（`DONE` / `BLOCKED` / 「已实施」「无需」「已修复」等）→ 写 `receipt`（≤200 字摘要）并置 `blocked|done`，**不再拉新**；
  - 无法判定 → 维持既有顺延 / `attempts+1` / `expired` 逻辑。
- **R3 安全**：只读、只存摘要与来源 sid，不落盘正文；`[protected*]` 不参与；不得因提取失败而中断提醒。
- **R4 回归**：既有 155 项全绿；新增用例覆盖 R1 文案与 R2 判定分支。

## Acceptance Criteria

- [ ] 接管请求文案含 ① ② ③ 三要素，且命令可复制
- [ ] 伪造「到期 + 对端有结论」→ `bid` 自动 `blocked` 且 `receipt` 有摘要，**不 spawn**
- [ ] 伪造「到期 + 对端无结论」→ 走原顺延/`attempts+1`
- [ ] 只读提取失败（会话已删/无消息）不抛错、不影响其它逻辑
- [ ] 提取内容截断且不含正文全文（≤200 字）
- [ ] harness ≥155 项全绿，`pnpm test:collab` exit 0

## 边界

- 不自动替对端执行任何动作；只读它的会话内容做判定。
- 不改对端工作区任何文件；不 push。
- 不新增「关闭 bid」的人工工具（若需要可后续）。
