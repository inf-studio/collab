# 设计：协作链路加固

## 1. 6 条风险的处置口径

| # | 风险 | 处置 | 影响面 |
| --- | --- | --- | --- |
| 1 | `collab_accept` 不校验领取者 | 领取前复用 `lineageGuard()`：命中 `[protected]` / `[protected-child]` 直接拒绝 | `collab_accept` |
| 2 | 接管请求缺完整发起方 sid | 注入文案改为 `回执/推辞请发 collab_send {target:"ses_…"}`，sid 取 `record.from.sid` 全量 | `injectionFor` |
| 3 | `DECLINE` 不带 bid | 回执解析先按 `bid` 命中；候选仍可显式写 bid；文案要求带 bid | `applyDecline` + 文案 |
| 4 | `collab_list` 不刷新租约 | 列出前对 `claimed` 记录做一次只读租约判定（不改状态），输出 `lease=expired|ok` | `collab_list` |
| 5 | 广播目录无清理 | 写入时顺带清理 `done/expired` 且 `updatedAt` 超过 7 天的记录；每次最多删 20 个 | `broadcastStore` |
| 6 | guide 措辞 | 与实现逐条对齐（§4 / §5.3 / §6 / §10） | guide |

## 2. CI 门禁

- 新增根 `package.json` script：`"test:collab": "node .trellis/spec/…/handoff-harness.mjs"`。
  > harness 已随任务归档，路径指向归档目录不可接受（归档是只读语义）。
  > 方案：把 harness 复制到 `scripts/collab/handoff-harness.mjs`（正式位置），任务归档里保留当时快照。
- CI 增加一步 `pnpm test:collab`（无网络、无模型调用、~1s）。
- `docs/development.md` 回归清单补一行。

## 3. 真实试点

```
目标提案：muke-interface/docs/issues/bugs-pagination-page-toArray-double-envelope.md
命令：collab_broadcast { workspace:"/data/project/muke-interface",
                        issuePath:"docs/issues/bugs-pagination-page-toArray-double-envelope.md",
                        expected:"implement", confirm:true }
```

- 先 `confirm:false` 预览，再 `confirm:true`；
- 记录 `bid`、候选与 `why`、是否 spawn（默认不 spawn，除非无候选 ≥80 且确认）；
- 等待窗口：一次 `collab_wait{target}` 或 10 分钟；超时只记录，不重投；
- 回执到达则解析并更新 `bid`。

## 4. 回滚

- 代码改动集中在 `collab.js` 的 accept/注入/列表/清理四处，可 `git restore`；
- CI script 与 docs 各自独立；
- 试点产生的 `bid` 文件保留（`done/expired` 会被自动清理）。
