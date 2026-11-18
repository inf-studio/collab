# 执行计划：followUps 硬化（F1–F3）

## 1. F1 标记时机

- [x] `chain.followUpHints(sessionID)` 改为**纯查询**：返回 `{ lines: string[], keys: string[] }`，内部不再 `markFollowUpSeen`
- [x] `hooks/context.ts`：`event.system.push(...)` **成功之后**才 `markFollowUpSeen(keys)`
- [x] 注入抛错 → 不标记（下一轮自然重试）
- [x] 回归：伪造 hook 抛错 → 下轮仍提示；正常注入 → 只提示一次

## 2. F2 无效路径不静默

- [x] `nextFollowUpHint` 对校验失败的 entry **不纳入 keys**（不 stamp）
- [x] 新增 `invalidFollowUps(record)` 统计；`collab_list` 输出「N 条 followUp 因路径无效未渲染」
- [x] 提示去重：按 `(session, bid, 无效条目 at 集合)` 记录最近一次汇总，数量变化才再提示（避免每轮噪声）
- [x] `collab_followup` 在写入无效路径时直接报错（比静默更早暴露）

## 3. F3 路径规范化

- [x] 先规范化：拆段、丢空段与 `.`、合并重复 `/`；**只拒 `..`** 与绝对路径
- [x] 软链仍拒：`lstat` + `realpath` 后校验前缀
- [x] 回归：`./docs/issues/x.md` 可渲染；`../x`、绝对路径、软链仍拒

## 4. 回归与发布

- [x] 新增 harness 场景（S89）：F1/F2/F3 各正反例
- [x] 既有 506 + 12 + 18 全绿
- [x] 文档：`docs/collab.md` §11.9/§12.5；CHANGELOG `0.3.1`
- [x] `package.json` / `PLUGIN_VERSION` → 0.3.1

## 验证

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

## 回滚

`git restore -- src/`；followUps 数据格式不变，无需迁移。
