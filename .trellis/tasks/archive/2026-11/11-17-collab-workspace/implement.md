# 执行计划：统一协作链路（已执行）

> 状态：2026-11-17 实施完成（未提交）；当日完成**复核修复轮**（B1/B2/B3 + S1–S5），
> 回归门 `handoff-harness.mjs` 现为 **124 checks** 全绿。改动证据与原始输出见 `research/impl-notes.md`
> （§8 复核修复轮）；复核报告见 `research/check-report.md`。

## 0. 前置：全局 shim

- [x] `~/.config/opencode/plugins/collab-global.js`（已落盘）
- [x] 断言两处：`muke-interface` → `collab-global: active`；`muke-pos-app` → `collab`（项目副本）+ `collab-global`（静默让路）均 `active`，无 `failed`

## 1. 会话枚举（只读）

- [x] `collab_list` 增 `{ directory?: string }`；输出每行加 `loc=<项目名>`、`[bootstrap]`
- [x] 内部抽 `listSessions({directory})`（`createHandoffChain` 内，供打分复用；host 不支持 `directory` 时本地按 `location.directory` 过滤）
- [x] 校验：本仓调用不带 directory 时行为不变（harness S15/S17 + 真实 `collab_list`）

## 2. 广播存储与领取

- [x] 全局目录读写：`~/.config/opencode/collab-broadcast/`（`COLLAB_BROADCAST_DIR` 可覆盖）
- [x] `bid` 哈希、`tmp+rename` 写入、`open(lock,'wx')` 领取
- [x] 状态机 + `attempts` + lease 过期重开（`persistRefresh` 把 refresh 结果落盘）
- [x] 单测/假 ctx：并发领取 1 winner（S25）、重复广播幂等（S26）、并发 spawn 只建一个（S27）

## 3. 打分

- [x] `scoreCandidate` + `rankCandidates`（`createHandoffChain`）
- [x] 读最近 200 条 / 7 天消息，只提取工具调用输入里的路径（`ctx.session.context`，见「偏差记录」）
- [x] 输出 `why` 明细（`file:` / `title:` / `task:` / `agent:` / `recent:` / `busy:-10(…)`）
- [x] 阈值 80；busy > 30min 扣 10

## 4. 工具

- [x] `collab_broadcast { workspace, issuePath, expected?, agent?, agentConfirm?, confirm }`
      —— 生成 bid、写广播、算分、top-1 busy>30min 时补 1 条叫醒（或直接 spawn）
- [x] `collab_handoff { target?, text, expected?, confirm }`（local；复用 thread）
- [x] `collab_accept { bid, confirm }` —— 原子领取 + 通知发起方
- [x] `collab_list` 显示 `[bootstrap]` / 广播摘要

## 5. 回执与提醒

- [x] 解析 `[handoff] DONE|BLOCKED <bid|路径|thread>`，更新 `bid`（事件流 `applyReceipt`）
- [x] `context` hook（会话下一次请求 = SessionStart 等价物）列出 `claimed/acked` 超租约与 `expired` 项，只提醒一次（`reminded`）
- [x] 群组广播注入按 `seenBy` 去重：同一会话对同一 bid 只注入一次

## 6. 验证

- [x] `node --check .opencode/plugins/collab.js`
- [x] harness 新增 S23–S30（打分、阈值、claim 并发、幂等、spawn 唯一、回执解析、过期升级、list/注入）
      —— 新路径 `.trellis/tasks/11-17-collab-workspace/research/handoff-harness.mjs`（S1–S22 原样保留 + 新增 87 checks 全绿）
- [x] `/tmp/collab-sandbox/{a,b,c}` 双仓 `git init` 跑通 `peer` 链路（广播 → 打分 → 领取 → 回执 → 闭环）与 spawn
- [x] 两处 `/api/plugin` 断言
- [x] 不向 `ses_e1eb91cebffeTv1467ubJLKebk` / `ses_e23a4a23fffe4c4m7UQFR8dUL3` 及其子会话投递（打分直接排除 + harness S23/S30）

## 7. 文档与收口

- [x] 更新 `.trellis/spec/guides/cross-workspace-collab-guide.md`（已知偏差 #1/#2 已移除；新增 §12 全局 shim 重建方法）
- [x] `docs/collab.md` 加「§12 协作链路」一节 + §11.2 工具表补 3 个新工具，指向 guide
- [x] 血缘深度口径对齐：`protectedAncestor` 比较符改 `depth <= MAX_LINEAGE_DEPTH`（自身 + 最多上溯 8 级），与 `docs/collab.md` §11.4 一致
- [ ] 复核（`trellis-check`）→ 提交（显式路径，不 push）——待主会话执行

## 偏差记录（实施后回写，供复核）

0. **2026-11-17 复核修复轮**（详见 `research/impl-notes.md` §8）：B1 spawn 自领取 → `acked`；B2 spawn lock 记
   `claimBy` 并按 `by|claimBy` 释放；B3 补齐 R3/R4 问询协议（`asked` / `DECLINE` 解析 / 问询租约 / 候选耗尽 → `expired` 不 spawn）；
   S1 `collab_handoff` 幂等（不复活已闭环）；S2 拉新落点严格校验 + 回滚；S3 回执只认 `bid`/完整 `issuePath` 且必须是承接方；
   S4 软链提案拒绝；S5 guide 进索引。以下 1–5 为第一轮偏差，仍然成立。

1. **匹配分数据源**：设计写 `GET /api/session/{id}/message?limit=200`，但插件 V2 `ctx.session` 只暴露 `context`
   （= 最后一次 compaction 之后的消息）。实现用 `ctx.session.context` + 200 条 / 7 天窗口二次过滤，只取工具输入路径。
2. **叫醒与接管请求合并为同一条 prompt**（仍遵守「仅 top-1 且 busy > 30min 才补发、最多 1 条」）；
   空闲 top-1 不投递 prompt，只靠 `context` 注入（0 模型调用）与 `collab_accept` 触发。
3. **accept 即 acked**：`collab_accept` 领取后状态直接 `acked`（ACCEPT 本身就是「收到」）；`spawn` 出来的会话先
   `claimed`，它自己 `collab_accept` 之后转 `acked`。
4. **`agentConfirm`**：拉新 `build`（或任何非 `explore`）需要额外的 `agentConfirm:true`，每次都要传，无白名单。
5. **`collab_handoff` 不拉新**：local 多候选但无 ≥80 时直接报错并列出候选，要求显式 `target`（拉新只走 peer 广播）。

## 回滚

- 删 `~/.config/opencode/collab-broadcast/`；移除新增工具注册；`git restore -- .opencode/plugins/collab.js`
- 全局 shim 可单独删除，不影响项目副本
