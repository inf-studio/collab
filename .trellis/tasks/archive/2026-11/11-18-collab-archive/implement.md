# 执行计划：自动归档 spawn 会话

## 1. 判定与执行

- [x] `src/core/archive.ts`：`shouldArchive(record, now, deps)`（design §1 八条）+ `archiveSession()`（update/HTTP 兜底，失败只 log）
- [x] 复核 R-1：`spawnTarget()` 兼认 `expiredClaim.kind==='spawn'`（租约过期后才被领取的孤儿会话）
- [x] `mergeArchive(bid, patch)`：读-合并-写（不覆盖并发字段）
- [x] `refresh()` 末尾接入：终态且满足条件 → 归档并写 `archivedAt`

## 2. 配置与类型

- [x] `archiveSpawned`（默认 true）、`archiveGraceMs`（默认 600000，范围 60s–1h）
- [x] `BroadcastRecord.archivedAt?: number`
- [x] 快照 `handoffs[].archived?: boolean`

## 3. 工具

- [x] `collab_archive { bid?, session?, restore?, confirm }`
- [x] `bid` → `claim.by`；`session` 直接指定；`restore` 清 `archivedAt`
- [x] protected 拒绝；`confirm:false` 只预览

## 4. 可见性

- [x] `collab_list` 标 `[archived]`
- [x] TUI/GUI 快照带 `archived`

## 5. 回归（S94）

- [x] design §6 全部用例（六类不归档 + 正常 + 幂等 + 抛错 + restore + 开关）
- [x] 既有 608 + 12 + 33 + 17 全绿

## 6. 文档与发布

- [x] `docs/collab.md` 新增「自动归档」节（含「归档 ≠ 删除」、`/api/session?archived` 可查、恢复命令）
- [x] README、skill 一句
- [x] `0.5.0`（新增工具，minor）

## 验证

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

## 回滚

`archiveSpawned:false` + `git restore -- src/`；已归档会话 `collab_archive {restore:true}`。
