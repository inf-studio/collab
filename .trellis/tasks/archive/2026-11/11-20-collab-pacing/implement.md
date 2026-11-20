# 执行计划：2min 批量投递 + 无增量不发（0.9.6）

## 顺序清单

- [x] 1. `src/core/pacing.ts`：窗口缓冲、合并、去重、定时 flush、过期补投
- [x] 2. `src/core/delta.ts`：四类增量判定 + `suppressNoDelta`
- [x] 3. `src/core/dispatch.ts`：接入 pacing；`escalate`/`blocked`/protected 直通
- [x] 4. `src/tools/{send,reply,broadcast}.ts`：传 `kind`，删除各自的重试逻辑（统一到 dispatch）
- [x] 5. `src/config.ts`：`windowMs`、`directKinds`、`suppressNoDelta`
- [x] 6. `metrics` 四字段落库（`median_gap_ms` / `msg_count` / `noop_count` / `late_count`）
- [x] 7. `src/hooks/context.ts`：每轮先扫过期窗口
- [x] 8. 测试 `test/pacing.mjs`：design §8 九例 + 变异 + 回放
- [x] 9. 文档：`docs/collab.md`「投递节奏与增量」；skill；CHANGELOG
- [x] 10. 门禁 + 复核

## 门禁

```bash
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

报数：工具数 28（不增）、回放 p50 间隔、消息总量下降倍数、noop 次数。

## 复核门

- 独立子代理跑全量门禁并贴原始输出；
- 变异（强制）：`windowMs=0` → 「10 条合并为 1」必红；
- 主会话抽检：连发 5 条非紧急，亲测收端只收 1 条。

## 回滚

见 `design.md` §9；紧急时把 `windowMs` 配成 0 即恢复逐条投递。

## 实施记录（0.9.6 落盘）

- 文件：`src/core/pacing.ts`（新）· `src/core/delta.ts`（新）· `src/core/dispatch.ts`（新，策略 + 运行时 + flush）
  `src/tools/shared.ts`（`admitOne` / `admitBatch` 两个写入点，dispatch 接 delta + policy）· `src/tools/handoff.ts`
  （把 `bid` 传进 dispatch，交接单因此直通）· `src/tools/status.ts`（只读两行：投递窗口 / 无增量抑制）·
  `src/config.ts` · `src/constants.ts` · `src/core/{envelope,index-db,index-sync,contract}.ts` · `src/hooks/context.ts` ·
  `src/types.ts` · `src/index.ts`（`__internals`）
- 直通（比 design §4 多两条，均为必需）：带 `bid` 的交接单（一个 `cid` 只能 ack 一单；否则 record 的 `delivery` 拿不到）、
  `steer`（显式打断不该排队）、`force:true`（「我知道重复，现在发」）。
- 合并后 envelope 的 `sentAt` = **首个 item** 的原始时间；`items[]` 同时进 JSONL 与投影（`envelopeHead` 把 item 的
  body 清空，避免批量正文在投影里存两遍）。
- 失败 flush：整窗回缓冲区（`attempts` / `nextAt`，60s×≤5 退避），下一次 timer / `context` 注入重投；不丢、不重发。
- 指标：`metrics` 新增 `noop_count` / `late_count` 两列（`ensureSchema` 迁移）；`msg_count` 按 id 形状 `msg_…_r<n>`
  排除重发行（与投影的 `resend_of` 同判据）；`median_gap_ms` 是**全机**口径；
  刷新 ≤1 分钟一次（`PACING_METRICS_TTL_MS`），`storage:"json"` 跳过。
- 既有 6 个测试套件（`facts` / `decide` / `gate` / `delivery-history` / `readonly-default` / `handoff-harness`）
  以 `windowMs:0` + `suppressNoDelta:false` 运行（逐条投递口径，同时把回滚开关纳入 CI）；
  批量行为由 `test/pacing.mjs`（89 项）覆盖。

## 报数（验收）

| 项 | 实测 |
| --- | --- |
| 10 条非紧急 → 收端 | **1 条**，`items=10`，每个 item 原始 `sentAt` + thread 顺序不变，各写各自 thread 行 |
| `escalate` 延迟 | **1ms**（同一进程内直接 `ctx.session.prompt`；断言 <10s） |
| blocked / protected / bid / force / windowMs:0 | 全部直通，0 窗口 |
| 窗口去重 | 同 thread+factId ×3 → **1** item（保留最后一条、位置不变）；不同 factId / 不同 thread 不合并 |
| 无增量 | 0 投递、0 thread 写入；`collab_status` 显示「无增量抑制: 1 次」；`metrics.noop_count` +1 |
| 过期窗口 | 下一轮 `context` 钩子 1 条（2 items）补投 |
| 迟到窗口（>5min） | 照常投递 1 次，`late_count` +1（不重发） |
| 回放 624 条（25% 增量，**两 target 轮转**） | per-target **p50 410s**（输入 23.5s）· 总量 **5.11×**（624 → 122） |
| 回放上界（31% 增量） | 4.46×（上界仅打印，不作断言；不跨口径比较临界值） |
| 工具数 | 28（不增） |
| 变异 `PACING_TEST_WINDOW_MS=0` | 「10 条合并为 1」必红，退出码 **1**（实测 `✗ no prompt is sent while the window is open — 10 prompt(s)`） |

## 复核修（0.9.6 复核轮）

- **C1** 增量基线改为**按对端**（`lastSent` 键 = `${from}\u0000${target}`）：同一事实发给 B 之后，发给 C **必须投递**，
  再发给 B 才抑制（`test/pacing.mjs` §4b）。`runFlush` / `recordSentBaseline` / `lastSentOf` 全部按对传。
- **C2** `admitBatch` 拆成「投递」+「逐条 best-effort 记账」：只有 `deliverPrompt` 抛错才回缓冲（§8b：storage 写失败 →
  投递 **1** 次、`failed=0`、窗口不回缓冲；thread 行确实丢了）。
- **C3** 回放改为**两 target 轮转**（原来 `sent % 2` 与「每 4 条一个增量」对齐，156 个 item 全落 ses_a）：
  5.11× / p50 410s；docs / spec / 本文件数字同步，并标注「合成数据估计」。
- **C4** typo 用例真跑：写 `windowMs:"2m"` 后发一条，回执 `mode=window(120s)`（原来只断言常量，恒真）。
- **C5** `context` 钩子零窗口/无到期窗口时**只读返回**（不取锁、不建 `collab-pacing.json`，文件字节不变）。
- **C6** `collab_wait` 对仍在窗口里的 thread 报「还在投递窗口 + 预计 flush 时间」，不再说「threadID 可能拼错」。
- **C7** 失败重放与新窗口合并时 `openedAt = Math.min(...)`（`sentAt` 与 `late` 判定不再被后到窗口覆盖）。
- **C10** `directKinds` 默认 `[]`（escalate/blocked/protected/bid/force 是架构直通，不靠配置）。
- **C11** 文档口径修正：线性退避 + 无限重试、`msg_count` 按 id 形状排除、`median_gap_ms` 全机口径、6 个既有套件。

## 偏差

1. **≥5× 依赖增量率**：PRD 的 69% 是状态镜像，但「非镜像」不等于「有增量」。25% 增量率下 **5.11×**，31% 下 4.46×
   —— 两个口径增量率不同，**不跨口径比较临界值**。抑制是降幅主因，窗口只是把剩下的合并 —— 已在 docs §11.27 /
   spec 写入口径。
2. **回放序列是合成数据估计，不是线上实测**：本机没有 624 条的原始 JSONL，按 PRD 自己的测量（gap 分位数 +
   最长 151 连发）重建，**两个 target 轮转**（单 target 是虚高上界），增量率建模 25%（上界 31% 只打印不断言）。
3. **`rebuild` 不重建 `metrics`**：它是派生值，删库后当天那一行在下一次投递刷新时重算（已写进 docs）。
