# 协作链路加固：残余风险 + CI 门禁 + 真实试点

> 前序：`11-17-collab-workspace`（已归档，提交 `e67486054`）交付了统一协作链路，第二轮复核**通过**但留了 6 条非阻断风险。

## 背景

- 链路已可用：`collab_broadcast` / `collab_handoff` / `collab_accept` / `collab_list{directory}`，harness 124/124。
- 复核留了 6 条风险，其中 2 条影响实际可用性（DECLINE 场景）。
- 回归目前只靠手动跑 `handoff-harness.mjs`，没有门禁保护。
- 跨仓链路尚未在**真实**对端工作区验证过。

## Requirements

- **R1 修 6 条残留风险**（全部）：
  1. `collab_accept` 校验领取者不在 protect 名单/不是其子会话；
  2. 接管请求里给出**完整发起方 sid**（DECLINE 不必去 inbox 找）；
  3. `DECLINE` 回执带 `bid`，解析时按 bid 定位；
  4. `collab_list` 不刷新租约 → 列表快照需按需刷新或注明；
  5. 广播目录无清理 → 增加 `done/expired` 记录的保留上限与清理策略；
  6. guide 两处措辞与实现对齐。
- **R2 CI 门禁**：`handoff-harness.mjs` 纳入可执行门禁（纯 Node、无网络/无模型调用）。
- **R3 真实试点**：用对端 `muke-interface/docs/issues/bugs-pagination-page-toArray-double-envelope.md`（状态「草拟，待后端 owner 评估/实施」）发起一次真实 peer 广播，观察：广播落盘、匹配分与 `why`、是否有会话 ACCEPT、回执是否闭合。
- **R4 清理**：删 `/tmp/collab-sandbox`；保留归档内 `broadcast-samples/` 作为证据。

## Acceptance Criteria

- [ ] 6 条风险各有对应改动或明确处置记录（`research/hardening-notes.md`）
- [ ] harness 新增/调整用例全绿（≥124 项，exit 0）
- [ ] CI 门禁可本地复跑，命令写进 `docs/development.md`
- [ ] 试点产出：`bid`、匹配分明细、最终状态（`open/claimed/acked/done`）与回执原文
- [ ] 试点未向受保护会话及其子会话投递；未删除任何非自建会话
- [ ] `/tmp/collab-sandbox` 已删

## 边界

- 试点只做「通知 + 等待一次」，**不催促、不重投**；对端是否实施由其自主决定。
- 不 push；不改 `packages/**`、`apps/**`；不动已归档任务。
- 跨仓写仍只允许 `docs/issues/**`，本次试点**不新增**提案文件。
