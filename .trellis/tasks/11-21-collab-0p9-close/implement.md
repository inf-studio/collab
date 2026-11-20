# 执行计划：收尾（metrics 重算 + 机验 + 24h 对比）

## 顺序清单

- [x] 1. `src/core/index-db.ts`：抽出 `aggregateDay()`（与写入侧同一实现），`rebuild` 结束后按 `sinceDays` 重算并 `UPSERT`
- [x] 2. `src/tools/store.ts`：`stats` 增加「metrics 覆盖 <首日>–<末日>」/「无」
- [x] 3. `test/store-rebuild.mjs`：造 3 天消息 + pacing 计数 → `rebuild` 前写入侧 vs 后重算逐日一致；两次 rebuild checksum 相同；`_r1` 不计入 `msg_count`；`noop_count` 来自 pacing 计数
- [x] 4. `test/pacing.mjs`：真实 pacing 文件「前后快照」断言（R5）
- [x] 5. 文档：`docs/collab.md`（rebuild 重算与覆盖范围）、README、CHANGELOG
- [x] 6. 门禁（干净 HOME）+ 变异
- [ ] 7. mac 机验清单（重启后版本/索引/覆盖范围）—— **Desktop 重启由用户执行（pending）**，证据见文末「机验记录」
- [ ] 8. 24h 对比表（不足则标注）—— 移交父任务 `11-21-collab-0p9-wrap`
- [x] F1 复核：`sinceDays:0` 由工具层原样下传（预览文案同步）+ 测试
- [x] F2 复核：`messages` 与 `metrics` 同一窗口（late 也过滤）+ 跨度一致断言 + 文档

## 门禁

```bash
HOME=<干净临时目录> pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

报数：工具数（28）、测试总数、重算前后每表 checksum、`metrics` 覆盖范围、真实 HOME 下 `pacing` 那一条是否已消失。

## 复核门

- 独立子代理自己跑门禁与变异；
- 变异（强制三条）：不排除重发行 / 不读 pacing 计数 / `stats` 不输出覆盖范围。

## 回滚

见 `design.md` §5。

## 说明

24h 对比可能在本任务完成时仍不足 24h：允许**先归档代码与 mac 机验**，把「满 24h 的对比表」作为父任务收尾项（`11-21-collab-0p9-wrap`）执行。

---

## 机验记录（F7，2026-11-21）

### Linux（本机，已生效）

| 项 | 命令 | 结果 |
|---|---|---|
| OpenCode | `opencode --version` | `opencode v2.3.2` |
| 插件配置 | `cat ~/.config/opencode/opencode.json` | `plugins: [{"package":"@inf-studio/collab@0.9.6","options":{"allowWrite":true}}]` |
| 索引可用 | `indexStats()`（`collab_index stats` 的同一实现） | `available:true` `backend:node` |
| 行数 | 同上 | `messages=18 threads=58 handoffs=26 locks=4 queue=10 sessions=100 metrics=2` |
| metrics 覆盖 | 同上 | `metrics 覆盖 2026-11-20–2026-11-21（2 天）`（R2 的新行） |
| pacing 隔离（R5） | `node test/pacing.mjs`（真实 HOME，`collab-pacing.json` 978B 存在） | `89/89`；`978:1795199598448.6467 → 978:1795199598448.6467`（未改动） |

即：Linux 全局 `collab:active:v0.9.6`，`metrics` 表有 2 天真实数据、覆盖范围可按人在 `stats` 里看到。

### mac（`x@10.254.1.6`，**Desktop 重启 pending**）

| 项 | 命令 | 结果 |
|---|---|---|
| Desktop 版本 | `defaults read /Applications/OpenCode.app/Contents/Info.plist CFBundleShortVersionString` | `2.3.2`（进程 `cli/2.3.2-x64/opencode-cli serve --service` 一致） |
| `opencode-cli` | `opencode --version` | `1.18.34`（PATH 上的 volta shim；Desktop 实际用自带 2.3.2 CLI，**不要**用这个数判断插件运行时） |
| 插件配置 | `cat ~/.config/opencode/opencode.json` | `plugins: [{"package":"@inf-studio/collab@0.9.6","options":{"allowWrite":true}}]` ✅ 已切 0.9.6 |
| 是否已安装 | `cat ~/.config/opencode/package.json`、`ls ~/.config/opencode/node_modules` | 只有 `@opencode-ai/plugin@1.15.13`；**没有** `@inf-studio/collab`；`plugins/` 空 |
| 是否已运行 | `ls ~/.config/opencode/collab.db collab-pacing.json collab-messages.jsonl` | 三者**都不存在** → 0.9.6 尚未激活 |
| 安装前置 | `grep -c _authToken ~/.npmrc` / 查 `@inf-studio:registry` | 有 token（1 条），但**没有** `@inf-studio:registry=https://npm.pkg.github.com` 行 |

结论：mac 只是**配置**切了 0.9.6，包还没装、插件还没跑。Desktop 重启由用户执行（本会话不改他人机器）；重启后按下面清单核验：

1. `~/.config/opencode/collab.db` / `collab-pacing.json` / `collab-messages.jsonl` 出现；
2. 插件版本 `collab:active:v0.9.6`（若装不上，先补 `@inf-studio:registry`，GitHub Packages 需要该 scope 的 token）；
3. `collab_index { action:"stats" }` → `索引可用` + `metrics 覆盖 …` 行；
4. 看板出现契约徽标（有契约的会话）。

### 24h 对比表

**移交父任务 `11-21-collab-0p9-wrap`，满 24h 后执行**（本任务完成时 `metrics` 只有 2 天、当天未满 24h，按 PRD「不足则标注」处理）。取数：`metrics` 当日行（`msg_count` / `median_gap_ms` / `noop_count` / `late_count`）与 11-20 基线（16% 空转 / p50 20s / 67:1 / 漂移 10.8h）并排，不足 24h 的项标「不足」。

