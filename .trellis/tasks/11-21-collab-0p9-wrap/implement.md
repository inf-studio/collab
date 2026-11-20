# 执行计划：0.9.x 复盘、看板契约与收尾

## 顺序（固定）

```
③ collab-0p9-retro      （纯文档，先做：最低风险、可评审）
② collab-board-contract （UI 呈现，依赖 ① 之后的口径稳定）
① collab-0p9-close      （metrics 重算 + 机验，最后做：依赖安装后的真实数据）
```

每个子任务独立：`prd/design/implement` → 实现 → 门禁 → 独立复核 → 提交 → 归档。
父任务不做实现，只做跨子验收与集成记录。

## 门禁（每版通用）

```bash
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

- 本批**不新增工具**，工具数必须仍为 **28**；
- 回归基线：**1752**（`103+79+89+900+13+20+53+54+30+83+68+62+9+60+47+82`），新增用例后按实际报数；
- `dist/` 共享：build/test **串行**。

## 子任务要点

| 子任务 | 关键验收 |
|---|---|
| ③ retro | 3 份文档齐全、无占位空段；每个数字可在本仓命令复现 |
| ② board | 徽标优先级正确；`≤640px` 单栏不换行；无契约时与 0.9.6 逐字节一致；详情顺序固定 |
| ① close | `rebuild` 前后 metrics 同范围逐日一致；两次 rebuild checksum 相同；mac 与 24h 表格 |

## 独立复核门

- 每个子任务另派冷上下文复核子代理；自己跑门禁并贴原始输出；
- 变异（强制）：
  - board：徽标改成新增一行 → 布局断言红；无契约写空 `contract` → 逐字节断言红；
  - close：重算不排除 `_r\d+` → `msg_count` 断言红；
- 主会话抽检：`git diff --stat` + 亲跑一条决定性命令。

## 回滚点

| 阶段 | 触发 | 动作 |
|---|---|---|
| retro | 文档与事实不符 | 直接改文档（无代码风险） |
| board | 单栏换行/旧快照破相 | `git restore -- src/core/snapshot.ts src/gui.tsx src/tui.tsx src/rpc.ts src/types.ts` |
| close | 重算口径与写入侧不一致 | `git restore -- src/core/index-db.ts src/core/index-sync.ts src/tools/store.ts` |

## 归档顺序

③ → ② → ①；三个子任务归档后父任务写 `integration.md` 并归档。
