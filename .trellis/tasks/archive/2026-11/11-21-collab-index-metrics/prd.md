# `collab_index` 增加 metrics 只读动作

## 问题

`metrics` 逐日行只能直连 `collab.db` 查询；而按仓库规矩（AGENTS §5），**只读查询也要逐次授权**。
`stats` 只给覆盖范围（`metrics 覆盖 2026-11-20–2026-11-21（2 天）`），看不到具体数值，导致：
- 24h 对比要临时申请数据库直连；
- 日常观察「空转率/间隔有没有降」没有低成本入口。

## 需求

- **R1** `collab_index { action: "metrics", limit?: number }`（默认 30，按日期倒序）：
  输出逐日行 `day · msg_count · noop_count · late_count · median_gap_ms`，并在末尾给覆盖范围与总天数。
- **R2 只读**：不建库、不写、不触发 rebuild；库不存在 → 返回「索引不可用」，不创建文件。
- **R3 空库**：`metrics 无数据`，不报错。
- **R4 不新增工具**：复用 `collab_index`（工具数仍 **28**）。
- **R5 口径一致**：数值直接读 `metrics` 表；不做二次计算，不猜测缺失字段（NULL 显示 `-`）。

## 验收

- [ ] 造 3 天 metrics → `metrics` 动作按日期倒序输出 3 行，数值与 `store-rebuild` 用例一致；
- [ ] `limit: 2` 只输出最近 2 天；
- [ ] 空库 → `metrics 无数据`；
- [ ] 冷启动（无库）→ 「索引不可用」，且目录里**不产生** `collab.db*`；
- [ ] 只读：调用前后 `collab.db` 的 size/mtime 不变；
- [ ] 回归全绿；工具数 **28**（不新增）；
- [ ] 文档：`docs/collab.md` 工具表 + `README` + `CHANGELOG`。

## 依赖

- 依赖 0.9.6 与 `rebuild` 重算（已完成）。

## 备注

- 输出保持「一行一天」，便于直接贴进对比表；不引入 JSON 输出（需要时再加）。
