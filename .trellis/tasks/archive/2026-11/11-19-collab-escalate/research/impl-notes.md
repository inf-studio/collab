# 实现记录：`collab_escalate`（加急，复用 delivery=steer）

任务：`.trellis/tasks/11-19-collab-escalate`（0.6.0 子任务；不新增依赖、不改版本号、不 git 写）。

## 1. 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/tools/escalate.ts`（新） | `collab_escalate`：目标三选一、`reason` 清洗（≤200、剥控制字符）、`resolveMode` 默认 `steer` / 只读 agent 强制 `queue`、真实 `delivery` 回执、protected → urgent owner-queue、5 分钟幂等、read-merge-write 四个 urgent 字段 |
| `src/tools/index.ts` | 注册（`collab_status` 之后），18 → 19 |
| `src/types.ts` | `BroadcastRecord.priority/urgentAt/urgentReason/urgentBy`；`OwnerQueueItem.priority` |
| `src/core/owner-queue.ts` | `priority` 的写入与**读回**（`normalizeQueueItem` 原来会丢掉未知字段，不补这一行 `collab_status` / `collab_list` / 快照都读不到 `[urgent]`）；注入行 `- [owner-queue] [urgent] …` |
| `src/tools/list.ts` | 未闭环交接行尾 `[urgent]` |
| `src/tools/owner-queue.ts` | 「我提交给受保护会话的请求」行尾 `· [urgent]` |
| `src/core/snapshot.ts` / `src/rpc.ts` | `handoffs[].priority?` / `queue[].priority?`（可选，只读） |
| `src/tui.tsx` / `src/gui.tsx` | 只在已有行尾加标记（TUI 行尾 ` [urgent]` + danger 色；GUI 一个 `urgent` badge），不改布局 |
| `test/handoff-harness.mjs` | 新增 **S97**（20 条断言） |
| `test/readonly-default.mjs` | 注册表 18 → 19 |
| `docs/collab.md` / `README.md` / `skills/collab/SKILL.md` / `CHANGELOG.md` | 工具表、§11.14.1、一点九、0.6.0 条目 |

> 硬约束里没列 `src/core/owner-queue.ts` / `src/tools/list.ts` / `src/tools/owner-queue.ts`，但
> `implement.md` 明确要求「`collab_list` 行尾 `[urgent]`」与 `OwnerQueueItem.priority`，而
> `normalizeQueueItem` 不保留未知字段——不补这三处，验收项（队列文件带 `priority`、展示 `[urgent]`、
> `collab_status` 读出 `priority`）无法实现。改动均为追加可选字段 / 追加标记，无既有语义变化。

## 2. 与设计稿的差异

1. **`deliverPrompt` 是 `createToolKit` 的闭包，不在 `ToolKit` 上**。`escalate.ts` 自己写了 4 行
   `deliverUrgent`（`ctx.session.prompt` + `deliveryFailure`），分类行为与 `dispatch` 一致；没有改
   `src/tools/shared.ts` 的 `ToolKit` 契约。
2. **`session` 目标**：直接投递到该会话，并标记「最新一条由它承接 / 被问询（`claim.by` / `asked.sid` /
   `delivery.to`）的未闭环单」；没有对应单时仍投递，回执说明「没有记录可标记」。
3. **`threadID` 目标**：取该 thread **最新的未闭环**单；都闭环则给可读错误。
4. **幂等分支优先于 protected 分支**：受保护目标重复加急也不会重复写队列项（R5 的「不重复投递」在
   队列通道上的同义处理）。
5. 已闭环的单拒绝加急（`已闭环（state=done）：无需加急`）；`urgent` 标记不自动撤销（只由终态自然收起）。

## 3. 证据：实际 delivery（两例 + 只读降级）

`/tmp/s97-evidence.mjs`（临时目录、假宿主，真实 `dist/index.js`）输出：

```text
# 1) steer 生效
已加急 → ses_ev_busy  agent=build  state=busy  busy peer
交接: b_e0000000000001 state=claimed thread=t_0001 承接=ses_ev_busy
reason: 冻结：store.ts 先别动
mode=steer  delivery=steer  message=msg_1
记录: b_e0000000000001 priority=urgent urgentAt=09:54:31（state / claim / receipt 未变）。
prompt.delivery = steer
record = {"priority":"urgent","urgentAt":1795053271241,"urgentReason":"冻结：store.ts 先别动","urgentBy":"ses_ev_req","state":"claimed"}

# 2) 宿主返回 queue（空闲目标）
mode=steer  delivery=queue  message=msg_2
注: 宿主实际采用 queue（目标空闲 / 被降级），本次未进入其当前轮。
prompt.delivery = steer          ← 我们请求的是 steer，宿主实际给的是 queue

# 3) 只读 agent 降级
已加急 → ses_ev_ro  agent=explore  state=idle  read-only peer
mode=queue(forced)  delivery=queue  message=msg_3
注: 目标为只读 agent（explore）：已强制 queue（forced），不打断对方当前轮。
prompt.delivery = queue
```

## 4. 证据：protected 目标 0 次 prompt + 队列落盘

```text
受保护目标：未投递（0 条 prompt），已写入加急队列项 q_mwmwdcju_7um9。
目标: ses_e1eb91cebffeTv1467ubJLKebk  agent=build  state=idle  schema line
  受保护: [protected] ses_e1eb91cebffeTv1467ubJLKebk
交接: b_e0000000000004 state=claimed thread=t_0004 承接=ses_e1eb91cebffeTv1467ubJLKebk
摘要: [URGENT] schema 线：先别合 thisPR (bid b_e0000000000004 / thread t_0004)
canPush=false  队列位置: 第 1/1 位（未读）
prompts added = 0
```

队列文件（`~/.config/opencode/collab-owner-queue/<targetSid>/<qid>.json`，临时目录实跑）：

```json
{
  "id": "q_mwmwdcju_7um9",
  "target": "ses_e1eb91cebffeTv1467ubJLKebk",
  "from": "ses_ev_req",
  "at": 1795053271242,
  "summary": "[URGENT] schema 线：先别合 thisPR (bid b_e0000000000004 / thread t_0004)",
  "issuePath": null,
  "bid": "b_e0000000000004",
  "priority": "urgent",
  "revokedAt": null,
  "seenAt": null
}
```

## 5. 证据：幂等时序

```text
after first : prompts added = 1   urgentAt = 1795053271243
已加急过（5 分钟内同 bid + 同 reason）：只刷新 urgentAt，未重复投递。
after second: prompts added = 0   urgentAt = 1795053271244
timing: t0=1795053271243 first urgentAt=1795053271243 t1(first done)=1795053271244
        t2(second done)=1795053271244 delta(second)=0ms
```

（窗口常量 `URGENT_WINDOW_MS = 5 * 60_000`，本地定义——`src/constants.ts` 不在允许改动清单内。）

## 6. 展示回读

```text
- b_e0000000000001 claimed [urgent] lease=ok scope=local "$ …" 提案=- 承接=ses_ev_busy attempts=0
b_e0000000000001  state=claimed  priority=urgent  承接=ses_ev_b…busy（handoff，剩 4m30s）  canPush=true
```

## 7. 变异验证（已还原）

变异 1：去掉只读降级（`resolveMode(...)` → 直接用请求的 mode）：

```text
  ✗ S97 read-only agent: delivery === queue, the receipt marks forced — mode=steer  delivery=steer  message=msg_57
FAIL: S97 read-only agent: delivery === queue, the receipt marks forced
```

变异 2：protected 分支改成直接 prompt（`if (guard)` → `if (guard && false)`）：

```text
  ✗ S97 protected: 0 prompts, one urgent queue item, canPush:false + the queue position — 0 item(s) / undefined / undefined
FAIL: S97 protected: 0 prompts, one urgent queue item, canPush:false + the queue position
```

（第一次跑变异 2 时测试在 `readdirSync(ownerQueueDir/…)` 上直接 ENOENT 崩了，已把该读取改成
try/catch → `[]`，让变异表现为一条干净的断言失败，而不是一条堆栈。）

## 8. 回归

```text
pnpm build      ✔
pnpm typecheck  ✔（tsc --noEmit）
pnpm test       696/696 · 12/12 · 42/42 · 32/32 · 47/47 · 7/7
node scripts/check-skill.mjs   skills ok
```

基线 676 + 12 + 42 + 32 + 47 + 7；本次 harness +20（S97），其余五项数量不变。
