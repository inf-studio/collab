# 协作转发链的 5 个工具层缺口（提案，2026-11-19）

- 状态: open（待排期；0.7 候选）
- 范围: 本仓（collab 工具/模板）
- 关联: 提出方 `ses_e0e3d0ffaffeJJdK2CCKLXFm8Z`（mojo-studio 实施方），请求 thread `t_mwn1z6bg_6yd7`；
  链路 A（muke-interface 提案方）→ B（实施）→ B 内部 local handoff → C（SDK/CLI 专题）
- 结论先行: 都不是缺陷，是**流程/表达层**的缺口；按影响排序 1 > 2 ≈ 3 > 4 ≈ 5

## 1) 转发链丢失「对接人」（影响最大）

**现象**：B→C 的 local handoff 记录里 `from` 只能是 B（发起本次交接的会话），真正的原始发起方 A 没有任何字段承载。C 不知道 A 是谁，BLOCKED 只能回流给 B，B 再转 A——多一跳，且 B 要在多个 thread 补摘要。

**现状证据**：`BroadcastRecord.from = { sid, directory }` 只表达「谁写了这条记录」；`title/issuePath` 可以间接带线索，但没有结构化字段，也没有在承接方注入/receipt 里渲染。

**候选方案**：

- 记录增可选 `origin?: { sid, role?: 'requester'|'implementer'|'observer', directory? }`；
- `collab_handoff` / `collab_broadcast` / `collab_send` 接受 `origin`（缺省 = 本会话）；
- 承接方的 context 注入与 receipt 模板渲染一行：`对接人（非本单发起方）：ses_… @ <dir>`；
- 最小替代：交接模板强制三行（提案路径 / bid / 对接人 sid+location），工具只校验格式。

## 2) 同一对会话并行多个 thread → 空转

**现象**：提案更正、退出码分歧、补材料、BLOCKED 各占一个 thread；对方在旧 thread 继续回，而 BLOCKED 在新 thread，空转 3 轮。

**候选**：`collab_threads { target }`（只读）列出与该会话的所有未闭环 thread + 最近出入站摘要 + 建议「用哪个 thread 继续」；或让 `collab_status { target }` 支持按会话聚合。发新消息前先看。

## 3) 跨 thread 重发实际无效（去重维度不足）

**现象**：为防丢失把同一条 BLOCKED 发到 3 个 thread——0.6.0 的 dedupe 按 **thread** 计算，全部放行；对方噪音大，且没有一次落在它当前用的 thread。

**候选**：dedupe 增加 **target 维度**：同 target 60s 内归一化正文重复 → **不静默再投**，回执提示「已在 thread X 发过，未重复投递」，由发起方决定是否强发（`force:true`）。

## 4) BLOCKED 缺结构化字段

**现象**：真正推动进展的是「做一次最小判别实验（改房态看有无帧）」，只存在于长正文里，接收方要读全文才能提炼。

**候选**：`collab_send` / `collab_handoff` 增可选 `blocked: { excluded: string[], minimalTest: string, need: string[] }`；收件视图/receipt 聚合展示（≤N 行），正文仍可自由。

## 5) 契约级纠错散落在 thread 里

**现象**：3 条契约级偏差（退出码 2→3、`room:order` 纯事件型、断言只看末帧）全靠口头纠正，跨 3–4 个 thread，最后人工回写提案。

**候选**：轻量 `collab_decisions { bid, items:[{id, decision, rationale}] }` 写进交接记录（≤N 条、只读拉取），`collab_status`/注入展示最近几条；或扩展 `collab_followup` 支持结构化决策段。

## 附：归档模板的 git 自检（不属 collab）

对端反馈：归档只 `git add` 了 archive 副本、未暂存源目录删除 → HEAD 双份（已由 `88477404b` 修）。若 Trellis 有归档模板，建议加 `git status --short` 自检：出现「新增 archive + 未删除源」时立即告警。

## 下一步

1. 请提出方整理结构化证据（消息 id / thread / bid / 命令与退出码），用于验收用例；
2. 0.7 规划时按 1 → 3 → 2 → 4 → 5 排（1 是结构缺口，3 是刚上线的去重语义延伸，2/4/5 是表达层）；
3. 每条落地时补：`docs/collab.md` 契约、skill 速查、测试（含「跨 thread 同文」用例）。
