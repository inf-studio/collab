# 执行计划：遗留回执兼容

## 1. 代码

- [ ] `canReplyToProtected`（`src/tools/shared.ts`）：`requestedKind === 'request'` 时，额外要求
      正文 `RECEIPT_BID_RE` 命中且 `[handoff]` 前缀存在（避免普通 request 借 bid 字符串穿过护栏）
- [ ] `src/tools/send.ts`：`boundedReply` 计算沿用 `requestedKind`；放行时把 `kind` 置回 `reply` 并去掉降级注记
- [ ] `deliver()` 的 protect 拒绝分支：当「三条件 + 正文含 `[handoff] <bid>`」时追加 `kind:"reply"` 提示

## 2. 回归（S81）

- [ ] 无 kind + `[handoff] DONE <bid>`（三条件匹配）→ 放行、`state` 可闭环
- [ ] 无 kind + 普通 request（无 `[handoff]`）→ 仍拒
- [ ] `note` / `steer` → 仍拒
- [ ] sender / target / bid 任一不符 → 仍拒
- [ ] `done` 记录 → 仍拒
- [ ] 被拒文案含 `kind:"reply"` 提示
- [ ] 既有 375+12 全绿

## 3. 收口

- [ ] `CHANGELOG` 0.1.4；`package.json` bump
- [ ] 独立复核 → 提交 → tag `v0.1.4` → 发布 → 全局升级
- [ ] 用修正后的命令让 `b_bdae848832cd51fb` 闭环（或由新版本自动兼容）
- [ ] 上报签名 `d_e4e7ae824f551d0f` 标记已处理

## 验证

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```
