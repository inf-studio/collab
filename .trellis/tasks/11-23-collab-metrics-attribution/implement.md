# 执行计划 · 消息计数标记 + 未计数诊断

任务 PRD-only（`prd.md`）。范围：`rawSeq` 行标记 + `collab_index metrics` 的 `uncounted N`。工具面不变（29）。

## 实现路径（低风险自决项）

- **D1（自决）标记名与生产者**：字段名按 PRD 用 `rawSeq`；值 = `recordKept` 返回的**当日新 `kept` 值**（raw/kept 同一次 bump，
  两者数值相同）。不新增序号生成器；`recordKept` 的返回类型 `Promise<number | undefined>`，`undefined` = 计数文件不可写
  → 该行**不带**标记（诚实反映「没被计数」，正是诊断要抓的）。
- **D2（自决）写入顺序**：直投路径改为「prompt 成功 → `recordKept` → `recordMessage`」，计数与标记在同一处产生；
  窗口路径保持「入窗时计数」，标记随 `PacingItem.rawSeq` 落盘（`normalizeItem` 保留），flush 时批量行取窗口内最大值；
  缓冲不可用的回退把入口序号传给 `admitOne`，不重复计数。
- **D3（自决）`uncounted` 的数据源**：从**投影**（`messages.envelope` 里的 `rawSeq`，按展示的最早一天起一次查询）读，
  与同表的 `msg_count` 同一批行；不新增列、不建文件、不读第二份日志（`rebuild --messagesFile` 的库也一致）。
  `_r<n>` 由 `uncountedByDay` 按 `isResendID` 排除（与 `msg_count` 同一规则）。
- **D4（自决）说明文案**：不猜版本（`sentAt` 无法证明升级时刻），只写「没有标记 = 没被计数」+ 两种可能（旧插件 / 本版本漏埋）。
- **D5（自决）重发行**：仍然打标记（它确实被计数），只是不计入 `uncounted`；无标记的重发行也不计入（旧版本写入）。

## 覆盖的写点

`dispatch` 直投（`admitOne`）/ 窗口批量（`admitBatch`）/ 加急 `[URGENT]` / 冻结通知 `[frozen]` / 缺陷上报 note /
`notifyRequester` / `[ack]` / 受限重发 `_r<n>` / `deliverAsk`（broadcast ask·wake·spawn）。

## 验收

```bash
HOME=<干净临时目录> pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
node test/pacing.mjs
```

- 全绿：metrics-dual 73/73、store-rebuild 58/58，整链退出码 0（工具数 29）。
- 变异（工作树副本 `/tmp/opencode/collab-mut-attrib`，跑完已删）：
  1. 投递不写标记（`makeEnvelope` 丢掉 `rawSeq`）→ **13 条红**（`uncounted 0` → 17、各直投点 `marked=false`，EXIT=1）；
  2. `_r<n>` 也计入 `uncounted`（删 `uncountedByDay` 的重发跳过）→ **3 条红**（`uncounted 1` → 2 等，EXIT=1）。
