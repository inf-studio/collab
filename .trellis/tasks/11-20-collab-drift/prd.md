# 漂移检测 + 挂起唤醒 + 主线占位（0.9.3）

## 问题

- 排钟会话 13:00 主线完结后**没有下一项占位**，空槽被 ws 集群填满；10.8h 无任何提醒。
- 一批「等 owner 批复」的事项从未落成挂起项，12 小时无人再提（`t_mwlp60ia_unts` 里成片）。
- 现状「停」靠自声明：「我这条之后不再回执」出现 3 次，下一条照旧。

## 需求

- **R1 drift 判定**：`连续 5 轮无 mainline evidence` **或** `主线挂起 > 2h` → 触发（D8）。
  - mainline evidence = `progress` 点亮 / mainline todo 关闭 / 提交触及 `mission.taskPath`。
- **R2 三选一落账**：`[drift]` 注入后必须显式选择：`继续`（给下一步）/ `blocked`（给阻塞方）/ `done`（**必须建 next-up 占位**），结果写回 `contract.mission.state`。
- **R3 挂起语义**：`status='suspended'` 必须带 `wake_when`：`{kind:'reply'|'decision'|'time'|'manual', ref?, at?}`（D16）。
- **R4 挂起超时**：`wake_when` 到期未醒 → 自动转 `drifted` 并进下一轮 `[drift]`（D17：24h 兜底）。
- **R5 主线完结校验**：`mission.state='done'` 且无 next-up todo → 拒绝该状态，提示先建占位。
- **R6 注入**：`[drift]` 只在触发时出现；`[todo]` 中挂起项显示 `suspended(等 X)`。

## 验收

- [ ] 构造「连续 6 轮只做协作动作」序列 → **第 5 轮**注入出现 `[drift]`（第 4 轮不出现）。
- [ ] `[drift]` 后未做三选一 → 下一轮重复提醒且标记 `[未处置]`。
- [ ] `suspend` 缺 `wake_when` → 拒绝。
- [ ] `wake_when.kind='time'` 到期 → 自动 `drifted`，看板可见。
- [ ] `mission.state='done'` 无 next-up → 拒绝。
- [ ] mainline 提交一次 → `lastAdvancedAt` 更新、计数清零。
- [ ] 回归全绿；工具数不变（26）。

## 依赖

- 依赖 `0.9.1 collab-contract`（plan / todos / mission.state）。

## 影响文件（预估）

`src/core/drift.ts`（新）、`src/core/contract.ts`、`src/hooks/context.ts`、`test/drift.mjs`（新）。
