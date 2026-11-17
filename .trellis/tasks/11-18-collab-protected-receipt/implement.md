# 执行计划：pull 模式 + 限界 reply

## 1. 记录与文案

- [ ] `BroadcastRecord` 加 `receiptMode?: 'push' | 'pull'`（`src/core/messages.ts` 类型）
- [ ] `createBroadcast` 判定 `protectedAncestor(from.sid)` → 写 `receiptMode`
- [ ] `handoffActions()` 增加 `receiptMode` 分支（pull 文案见 design §2）
- [ ] `collab_accept` 输出按 `record.receiptMode` 分支
- [ ] 租约提醒（`injectionFor` 的 `reminded`）在 pull 模式追加说明

## 2. 限界 reply

- [ ] `canReplyToProtected()`（`src/tools/shared.ts`）：kind=reply + bid 命中 + `from.sid===target` + `claim.by===sender`
- [ ] bid 解析：入参 `bid?` 优先，其次正文 `\b(b_[0-9a-f]{8,32})\b`
- [ ] `collab_send` / `collab_reply` 调用前计算并传入 `allowProtectedReply`
- [ ] `deliver()` guard 分支放行时追加说明注记
- [ ] `request` / `note` / `steer` 不加该参数（保持 fail-closed）

## 2.5 自动提取扩面（R7）

- [ ] `refresh()` 触发条件去掉 `claim.kind === 'spawn'` 限制
- [ ] 结论识别补「回执被硬拒/改回写提案」「已自愈/无需处理」→ blocked
- [ ] 回归：accept/handoff 到期可收口；无结论走原顺延

## 3. 回归

- [ ] harness 新增用例（design §5 全部 8 项）
- [ ] 既有 279 项全绿
- [ ] `pnpm build` / `pnpm typecheck` / `pnpm test`

## 4. 文档

- [ ] `docs/collab.md` 增「受保护发起方（pull 模式）」；`docs/collab.md §11.4` 的 fail-closed 表述补白名单例外
- [ ] `.trellis/spec/guides/cross-workspace-collab-guide.md` 同步
- [ ] `docs/issues/bugs-protected-requester-receipt-undeliverable.md` 状态回写「已修复（0.1.2）」

## 5. 发布与收口

- [ ] `package.json` → `0.1.2`；CHANGELOG
- [ ] 独立复核（`trellis-check`）→ 提交（显式路径、不 push 代码仓以外）
- [ ] tag `v0.1.2` → CI 发布 → `npm view` 验证
- [ ] 全局插件升级到 `0.1.2`；两个工作区 `/api/plugin` 无 failed
- [ ] 归档任务

## 验证命令

```
pnpm build && pnpm typecheck && pnpm test
node scripts/check-skill.mjs
opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"
```

## 回滚

- 代码：`git restore -- src/`
- 发版：GitHub Packages 删除版本需 `delete:packages`（本机 token 支持），或直接发 `0.1.3` 修正
