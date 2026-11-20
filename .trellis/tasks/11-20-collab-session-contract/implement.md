# 执行计划：会话契约与协作根治（0.9.x）

## 0. 执行原则

- 父任务**不做实现**，只负责：需求源、任务地图、跨子任务验收、最终集成复核。
- 每个子任务独立走：`prd/design/implement` → 实现 → 门禁 → 独立复核 → 提交 → 归档。
- **一个子任务一个补丁版本**（0.9.0…0.9.6），不攒批。
- 并发铁律：`dist/` 是共享构建目录，**build/test 必须串行**；子任务按 §1 顺序推进，不并行跑构建。
- 回滚按显式文件清单（禁止 `git restore .` / `git clean -fd`）。

## 1. 依赖与顺序

```
0.9.0 collab-store        （无依赖，先做：后续所有验收都要靠它报数）
   └── 0.9.1 collab-contract   （读索引；注入依赖 store）
          ├── 0.9.2 collab-gate    （依赖契约里的 scope）
          └── 0.9.3 collab-drift   （依赖契约里的 plan/todos）
   └── 0.9.4 collab-facts      （依赖 store 的 messages/facts 表）
          ├── 0.9.5 collab-decide  （依赖 facts 判 conflict）
          └── 0.9.6 collab-pacing  （依赖 envelope 判增量）
```

串行推荐：`0.9.0 → 0.9.1 → 0.9.2 → 0.9.3 → 0.9.4 → 0.9.5 → 0.9.6`。
允许的唯一并行：0.9.2 与 0.9.3 在 0.9.1 归档后同时开（不共享文件），但构建仍串行。

## 2. 子任务地图

| 版本 | 子任务 | 核心改动 | 门禁 |
|---|---|---|---|
| 0.9.0 | `11-20-collab-store` | `messages.jsonl` 信封 + `collab.db` 投影 + `collab_index rebuild` + 看板读索引 | 重建幂等；降级可用；零语义改动 |
| 0.9.1 | `11-20-collab-contract` | `collab-contract/<sid>.json` + `collab_mission` / `collab_progress` / `collab_todo` + 五段式注入 | 配额 ≤12 行；确认一次不被覆盖；无 evidence 不点亮 |
| 0.9.2 | `11-20-collab-gate` | scope 校验 + `override{reason,approvedBy}` + audit + overflow 拒单 | 越界拒绝且给 handoffTo；override 留审计；误伤 0 |
| 0.9.3 | `11-20-collab-drift` | `[drift]` 三选一；挂起 `wake_when` 必填；24h → drifted；next-up 校验 | 连续 5 轮触发；2h 挂起触发；三选一必须落账 |
| 0.9.4 | `11-20-collab-facts` | `facts` + 证据等级强制 + `settle`/`invalidate` + 三态判定 | 撤回可度量；stale 回复 ≤30% 原文；invalidate 一窗口内生效 |
| 0.9.5 | `11-20-collab-decide` | 决策载具（thread 可用）+ owner 独占关闭 + 同问去重 + open ≤3 + 角色四元组 | 第 4 条被拒；重复提问被挡；角色注入正确 |
| 0.9.6 | `11-20-collab-pacing` | 2min 批量窗口 + escalate/blocked 直通 + 无增量不发 | p50 间隔 ≥2min；escalate <10s；无增量不产生消息 |

## 3. 每版通用门禁

```bash
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

- 回归基线随版本递增（当前 0.8.2：`899 + 12 + 20 + 53 + 54 + 60 + 47 + 82`，工具数 22）；
- 每版必须给出：工具数、测试计数、6 项指标里**本版影响项**的新数值；
- 文档同步：`docs/collab.md`（工具表 + 新节）、`README.md`、`skills/collab/SKILL.md`、`CHANGELOG.md`；
- `.trellis/spec/frontend/opencode-plugin-ui.md` 在看板/注入变更时同步。

## 4. 独立复核门（每版必过）

- 另派**冷上下文**复核子代理，任务是挑错：范围越界、吞错、路径/端口字面量、协议兼容、测试是否真覆盖、是否"声称跑了其实没跑"。
- 复核必须自己跑门禁命令并贴原始输出；只审不改。
- 主会话只做证据抽检：`git diff --stat` + 亲自跑 1–2 条决定性命令。
- 发现问题退回作者子代理修，修完重跑门禁。

## 5. 变异验证（每版至少 1 组）

| 版本 | 变异 | 必须失败的断言 |
|---|---|---|
| 0.9.0 | rebuild 不写 `sent_at` | 幂等 checksum 变化 |
| 0.9.1 | 注入改回一次性 `injected[]` | 重放测试第二轮缺少 `[mission]` |
| 0.9.2 | scope 校验取反 | 越界 accept 被通过 |
| 0.9.3 | `lastAdvancedAt` 接受任意轮 | drift 测试不触发 |
| 0.9.4 | stale 判定恒为 fresh | 回复长度断言失败 |
| 0.9.5 | 同问去重关闭 | 重复提问用例失败 |
| 0.9.6 | 窗口设为 0 | p50 间隔断言失败 |

## 6. 跨子任务验收（父任务收尾时执行）

- [ ] 用两会话真实序列回放：每轮注入含 `[mission]` + `[todo]`；
- [ ] 6 项指标达 §PRD §3 目标（同一份回放数据）；
- [ ] 删 `collab.db` → 全工具可用 → `rebuild` 后 checksum 一致；
- [ ] 未升级对端互通（模拟无 envelope 的对端）；
- [ ] 保护会话零放宽（protected 仍拒绝看板写动作）；
- [ ] 全量回归绿 + 工具数 28。

## 7. 归档顺序

1. 每个子任务单独提交并归档；
2. 父任务在 7 个子任务全部归档后，跑 §6 全量验收 → 提交集成记录 → 归档父任务；
3. 归档后只读；需求变更 → fork 新任务。

## 8. 回滚点

| 阶段 | 触发 | 动作 |
|---|---|---|
| 任一子任务门禁红 | 测试/类型/构建失败 | 按 design §11 的显式文件清单回滚，退回实现 |
| 0.9.0 后指标无改善 | 消息量未降 | 停下重估 0.9.1–0.9.6 顺位，不盲目推进 |
| 闸门误伤 >2 例/天 | 正常协作被拦 | 立即关闭闸门（配置开关），回到只提示 |
| DB 反复损坏 | rebuild 失败 ≥2 次 | 降级纯 JSON，暂停 0.9.4 之后的版本 |
