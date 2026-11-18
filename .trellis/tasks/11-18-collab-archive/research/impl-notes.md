# 实现记录：协作结束后自动归档 spawn 会话（0.5.0）

## 结论

自动归档 + 手动 `collab_archive` 已实现，验收命令全绿：

```
pnpm build        # 0
pnpm typecheck    # 0
pnpm test         # 635/635 + 12/12 + 35/35 + 17/17
node scripts/check-skill.mjs   # skills ok
```

归档只调用 `PATCH /api/session/{id} { archived:true|false }`，**没有** `DELETE`；
`BUILTIN_PROTECT`、handoff/lease 语义、记录 `state` / `receipt` 均未改动。

## 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/core/archive.ts`（新） | `shouldArchive`（design §1 八条，顺序执行、先纯判定后 I/O）、`archiveSession`（`session.update` → HTTP 兜底，绝不抛）、`archiveIfDue`（判定 + 写 + `mergeArchive`）、`createArchiveGate`（真实 reader：fresh `session.get` / lineage / `allBroadcasts` / `unseenCandidates`） |
| `src/core/claim.ts` | `mergeArchive(bid, number\|null)`：读-合并-写；`null` 清 `archivedAt`（restore） |
| `src/core/chain.ts` | 原 `refresh` 改名 `refreshCore`；导出 `refresh` = `refreshCore` + `archiveIfDue`（带 try/catch 双保险）。`createHandoffChain` 内建 `archiveGate` |
| `src/core/snapshot.ts` | `toHandoff` 增 `archived?: true`（`archivedAt > 0`） |
| `src/rpc.ts` | `SnapshotHandoff.archived?` + schema 可选 `archived: boolean` |
| `src/tools/archive.ts`（新） | `collab_archive { bid?, session?, restore?, confirm }`：`bid`→`claim.by`、`session` 直取、预览、幂等、`[protected*]` 拒绝、失败可读不抛 |
| `src/tools/index.ts` | 注册第 17 个工具 |
| `src/tools/list.ts` | 会话 `state=archived` 时标记 `[archived]`；记录行尾 `[archived]` |
| `src/config.ts` / `src/constants.ts` / `src/types.ts` | `archiveSpawned`（默认 true）、`archiveGraceMs`（默认 600000，夹 `[60s, 1h]`）、`ARCHIVE_GRACE_*`、`PLUGIN_VERSION=0.5.0`、`BroadcastRecord.archivedAt` |
| `src/index.ts` | 注释/日志（十七个工具、`archiveSpawned` / `archiveGraceMs`）、`__internals` 导出 `shouldArchive` / `archiveSession` |
| `test/handoff-harness.mjs` | 新增 S94（27 项）；顶部在 import 前起一个 mock server 设 `COLLAB_SERVER_URL/TOKEN`；fake `update` 记录 `archivedPatches` |
| `test/snapshot-shape.mjs` | +2：归档行 `archived:true` 且仍在列表；schema 声明可选 `archived` |
| `test/readonly-default.mjs` | 工具注册表 16 → 17 |
| `docs/collab.md` | §11.2 十七个工具 + `collab_archive` 行；§11.4 配置；**§11.13 新增**；§12.2 `archivedAt`；§12.5 第 17 条 |
| `README.md` / `skills/collab/SKILL.md` / `CHANGELOG.md` | 工具表 / 配置表 / S94 / 0.5.0 条目 |

## 关键决策（低风险，已记录）

- **D1 防抖默认值 10min vs PRD 的 5min**：prd R2 写「≥5min」，但 design §1/§6、implement §2 与派发说明都写
  **默认 10min**（`600000`）。实现取 **10min**，并把 5min 视为下限语义（`archiveGraceMs` 可配 1min–1h，
  夹取）。若产品最终要 5min，只需改 `ARCHIVE_GRACE_MS` 一处（测试用显式 `archiveGraceMs: 600000` + 相对时间，不依赖绝对默认）。
- **D2 「终态已过 grace」用 `updatedAt`（fallback `createdAt`）**：与 design 一致；无时间戳的记录不归档（拒绝原因写明）。
- **D3 触发点放在 `refresh()` 而非仅 `injectionFor`**：`applyReceipt` / `applyDecline` / `accept` / `broadcast` / `handoff`
  都会经过 `refresh`，比「只由 context 注入触发」更早收口；所有条件仍由 `shouldArchive` 把关，且归档失败只 log。
  `collab_list` / 快照不 refresh → 只读命令永不写盘（design §3）。
- **D4 手动工具跳过自动门**（busy / 非 spawn / 有引用 / 未读队列 / 防抖），只保留 `[protected*]` 拒绝：
  人明确要求时按 design §4「不强制 spawn 痕迹」。`allowWrite` 不参与——自动路径默认开启，若手动再加开关会自相矛盾。
- **D5 幂等标记只有 `archivedAt`**：宿主侧已是 archived 但记录未盖章时，自动路径不再 PATCH（理由：宿主已归档），
  手动工具在该状态下仍会补盖 `archivedAt`（不重复 PATCH）。
- **D6 记录行 `[archived]` 的可达性**：`collab_list` 只列非终态交接，所以标记主要出现在「手动归档了仍有未决单的会话」；
  终态记录的标记在快照层（`handoffs[].archived`）。快照同样只列非终态，字段为只读扩展，旧客户端忽略即可。

## 测试覆盖（S94）

自动：终态+11min+idle+无引用 → 归档一次 + `archivedAt`（`state`/`receipt` 不变）；二次刷新不重复 PATCH。
拒绝七类：非 spawn（accept）/ 非终态（open）/ 防抖未满（30s）/ busy / protected / 有未决引用（`from.sid`）/
有未读队列项；另加 `update` 抛错（只 log、不写、不抛）。
手动：预览零写入；`session` 归档（跳过 busy/非 spawn 门）；`bid` restore（`archived:false` + 清戳）；
未归档时 restore 为 no-op；`[protected*]` 拒绝且零写入；update 失败返回可读「失败」不抛；缺参可读报错。
开关：`archiveSpawned:false` 时自动不动、手动仍可用。
HTTP：删除 `ctx.session.update` 后 `collab_archive` 走 `PATCH /api/session/{id}`，body `{"archived":true}`、
带 `Bearer s94-token`，成功才写 `archivedAt`。
可见性：`collab_list` 会话行 `archived` + `[bootstrap,archived]`；非终态但已归档的记录行带 `[archived]`。

## 未做 / 边界

- 未实现 `GET /api/session?archived=true` 的客户端封装（文档只说明宿主端点可查；`ctx.session.list` 是否返回归档会话由宿主决定）。
- 不做批量 restore 工具（`collab_archive` 可逐个恢复；回滚也可直接 `archivedSpawned:false`）。
- 未改 `scripts/collab-triage.mjs` / TUI 布局（`archived` 只是快照字段，TUI 忽略它保持布局）。
- **restore 后可能再次被自动归档**：`archivedAt` 清空 + 记录 `updatedAt` 刷新为恢复时刻，10 分钟后若该单仍是终态、
  目标 idle 且其它条件成立，自动路径会再次归档（PRD/design 未定义「恢复后永不再归档」的墓碑字段；
  需要长期保留请设 `archiveSpawned:false`）。已在 `docs/collab.md` §11.13 明写。
- 防抖默认 **10min**（design/implement），PRD R2 的「≥5min」按下限理解；改默认只需动 `ARCHIVE_GRACE_MS`。
