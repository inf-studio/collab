# 执行计划：提示去重

## 1. 渲染层

- [ ] `chain.injectionFor`：把 followUps 提示与 owner-queue 行合并为候选列表，每条带 `{at, bid, issuePath, line, stampKey, source}`
- [ ] 去重键：`issuePath ? issuePath : (bid ? bid : unique)`；保留 `at` 最大者
- [ ] 去重后按 `at` 升序取前 3 行；仅对渲染项返回 `stampKeys`
- [ ] 非受保护会话不走这套合并（保持现有行为）

## 2. 标记

- [ ] `context` hook 只对 `stampKeys` 在 `push` 成功后写入（沿用 F1）
- [ ] 去重掉、未渲染的项不 stamp

## 3. 工具说明

- [ ] `collab_request_owner` description：broadcast 候选池排除 `[protected*]`；触达受保护只有本工具或对方 pull
- [ ] `collab_followup` description：同一提案已 request_owner 时不必再登记

## 4. 回归（S93）

- [ ] 同 `(sid,bid,issuePath)` 两类提示 → 1 行，取最新
- [ ] 去重项下轮仍提示（未 stamp）；渲染项只提示一次
- [ ] 不同提案各一行，≤3
- [ ] 既有 582 + 12 + 18 全绿

## 5. 文档与发布

- [ ] `docs/collab.md` §11.12 去重规则；skill 一句
- [ ] `0.4.1`（`package.json` + `PLUGIN_VERSION`）

## 验证

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

## 回滚

`git restore -- src/`；无数据迁移。
