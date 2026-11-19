# 复核报告：`collab_escalate`（11-19-collab-escalate）

- 复核人：独立 check 子代理（冷上下文，只审不改；未修改任何实现文件，未 commit/push/add）
- 被复核状态：`/data/project/collab` 未提交工作区（`src/tools/escalate.ts` 新 + 14 个修改文件）
- 口径：只采信自己写探针 / 自己跑的命令输出；`research/impl-notes.md` 仅作线索，结论已逐条独立复现
- 探针：`/tmp/opencode/check-probe.mjs`（假宿主 + 临时目录 + 真实 `dist/index.js`）、`/tmp/opencode/status-probe.mjs`、`/tmp/opencode/count-tools.mjs`
- **结论：可提交（0 个阻塞项）**，建议随本次一并补 2 处「弱断言 / 过期数字」，另有 5 条非阻塞风险与观察（见 §11）

---

## 1. 结论摘要

| 项 | 结论 |
| --- | --- |
| R1–R5 语义 | 全部成立（探针 31/31 + 快照 11a–11c） |
| 硬边界（protected / 血缘） | 成立：0 次 `session.prompt`（自建假宿主计数） |
| 状态不变 | 成立：`state/claim/receipt/replies` 逐字节一致；仅多 4 个 urgent 字段（`updatedAt` 被 `writeBroadcast` 顺带刷新，见 R-2） |
| 回归 | `696 + 12 + 42 + 32 + 47 + 7` 全绿；工具 19；版本 0.5.3；无新依赖；`BUILTIN_PROTECT` 未改 |
| 变异 | 4 组变异各自只打掉 1 条断言并已还原（sha256 一致） |
| **缺陷** | **无功能性缺陷**。2 条建议修：S97 一条断言是**弱断言**（删掉 `normalizeQueueItem` 的 priority 行仍 696/696 绿）；`README.md:262` 的 harness 条数仍是 676 |

---

## 2. 必查九项（逐条）

### ① delivery 语义 — **通过（含 1 条存疑）**

- 忙目标：`session.prompt` 收到的 `delivery` 是 `steer`（`src/tools/escalate.ts:268` → `:359-374`）。探针 1a/1b/1d 通过；`metadata.collab.urgent === true`、`kind:'note'`。
- 宿主**返回** `queue`：回执如实 `delivery=queue` + 一行「宿主实际采用 queue」（`:376-380`）。探针 2a 通过；探针里同时断言 **出参请求的是 steer、回执写的是 queue**（两者不同才证明读的是宿主回执而不是入参）。
- 变异 4（`const actual = mode`）→ `695/696`，唯一失败为 `S97 the host actually reported queue…` ⇒ 该语义**被测试真实绑定**，不是自证。
- **存疑（R-1，非阻塞）**：`const actual = String(admitted?.delivery ?? mode)`（`:376`）在宿主**没回** `delivery` 时会把 `mode` 当事实打印。探针 1e（假宿主返回 `{id:'msg_nodelivery_3'}`）复现：回执写 `mode=steer  delivery=steer`，而宿主并未确认任何方式。同一仓库的 `dispatch` 对同字段用的是 `admitted?.delivery ?? '?'`（`src/tools/shared.ts:592`）。
  - 设计稿 §2 确实写了 `result.delivery ?? mode`，所以**按设计是合规的**；但文档（`docs/collab.md` §11.14.1、SKILL、CHANGELOG）都承诺「回执是**实际**采用的」。建议改成 `delivery=${admitted?.delivery ?? `${mode}?`}`，或在缺失时补一行「宿主未回报 delivery，按请求值显示」。属 1 行改动，不影响任何断言（S97 的宿主始终回 `delivery`）。

### ② 只读降级 — **通过**

- `explore` 目标传 `steer`：实际 `delivery:'queue'`，回执 `mode=queue(forced)` + 「已强制 queue（forced）」注（`escalate.ts:268`、`:379`）。探针 3a/3b 通过。
- 非只读不受影响：`build` + 显式 `mode:"queue"` → `queue` 且**不含** `forced`（探针 3c 通过）。
- 变异 1（把 `target.info?.agent` 换成 `'build'`，即去掉降级）→ `695/696`，唯一失败 `S97 read-only agent: delivery === queue, the receipt marks forced`。

### ③ protected 硬边界（含血缘）— **通过**

- 直接 protected（`ses_e1eb…Kebk`）：`prompts.length` 前后相等 = **0 次**（假宿主自计数）；写 1 条 `priority:"urgent"` 队列项（`bid` / `[URGENT]` 前缀 / `summary` 均对）；回执 `canPush=false  队列位置: 第 1/1 位（未读）`（`escalate.ts:326-355`）。探针 5a–5d 通过。
- **血缘**（`ses_probe_child`，`parentID = BUILTIN_PROTECT`）：同样 0 次 prompt、1 条 urgent 队列项、`canPush=false`，且标 `[protected-child depth=1]`（复用 `createLineage(...).protectedAncestor`，`:266-267`）。探针 5e 通过。
- 判定顺序正确：`guard` 分支在 `deliverUrgent(...)` 之前返回，函数体内**没有**任何先行的 `session.prompt`。
- 变异 2（`if (guard)` → `if (guard && false)`）→ `695/696`，唯一失败 `S97 protected: 0 prompts, one urgent queue item, canPush:false + the queue position`；且是**干净断言失败**（测试里的 `readdirSync` 已 try/catch，不再抛栈）。

### ④ 状态不变 — **通过（1 条观察）**

- 投递前后把 `priority/urgentAt/urgentReason/urgentBy/updatedAt` 剔除后序列化对比：**逐字节一致**（`state` / `claim` / `receipt` / `replies` 全等）。探针 4a 通过。
- 只追加 4 个字段，`urgentAt` 为数字、`urgentReason` 与入参一致、`urgentBy` = 调用方 sid（探针 4b）。
- **观察（R-2）**：`markUrgent` 走 `writeBroadcast`（`src/core/claim.ts:150-158`），后者强制 `updatedAt: Date.now()`，所以记录实际还多动了一个 `updatedAt`（探针 4c 观察位）。不违反 R2（R2 只点名 `state/claim/receipt`），也不影响 7 天保留（只对已闭环单剪枝）；但会让**被加急的旧单在按 `updatedAt` 排序的列表里跳到最前**。若希望「只多四个字段」严格成立，需在 `claim.ts` 加一个保留 `updatedAt` 的写入口——不建议为它扩大改动面，记录在案即可。

### ⑤ 幂等 — **通过**

- 同 `bid` + 同 `reason` 5 分钟内第二次调用：0 次 prompt、回执「已加急过…只刷新 urgentAt」、`urgentAt` 前进、`urgentReason` 不变（`escalate.ts:277-280`、`:307-323`）。探针 6a/6b 通过。
- 换措辞（`reason` 不同）→ 再投一次（探针 6c 通过）。
- 受保护通道上的幂等同样生效：重复调用**不新增**队列项（探针 6d：1 → 1）。
- 边界：`now - urgentAt <= 5min`（含端点）；`urgentBy` 不参与比较（PRD R5 只要求 `bid + reason`，符合）。

### ⑥ 队列 priority 落地 — **通过（但测试覆盖有洞，见 S-1）**

- `normalizeQueueItem` 会丢未知字段，本次已补 `src/core/owner-queue.ts:144-145`；`enqueue` 写入 `:283`；注入行 `:327`。`readQueueItem/listFor/mineFor` 全部经 `normalizeQueueItem`，故读回链路成立。
- 三处可见性（探针实测）：
  - `collab_list` 交接行：`- b_c000…0001 claimed [urgent] lease=ok …`（`src/tools/list.ts:189`；标记只加在**未闭环**记录上，见 `list.ts:170-172` 的 `BCAST_DONE_STATES` 过滤，符合「只按 state 未闭环时标」）。
  - `collab_list` 我提交的队列项：`- q_… → ses_e1eb…Kebk "…" · [urgent]`（`src/tools/owner-queue.ts:23-25` 经 `list.ts:39`）。
  - `collab_status`：`priority=urgent`（`src/tools/status.ts:51-53`，**该文件未改**——上个任务已预埋容错读）与队列行 `第 1/1 位（未读） [urgent]`（`status.ts:208`，`status-probe.mjs` 实测输出见 §9）。
  - `collab.state.snapshot`：`handoffs[].priority` / `queue[].priority`（`src/core/snapshot.ts:119`、`:138`；探针 11a/11b 通过，11c 证明已闭环单不进快照）。
- **必要性**：见 ⑦。

### ⑦ 越界修改是否必要 — **通过（均有必要性，且是「读回/展示」的最小追加）**

| 文件 | 判定 | 证据 |
| --- | --- | --- |
| `src/core/owner-queue.ts`（`normalizeQueueItem` 一行） | **必需** | 变异 3（删掉 `:145` 这一行）→ 我的探针 10c 立刻红：`collab_list` 队列行不再带 `· [urgent]`。`normalizeQueueItem` 是白名单构造，不补这行字段就**读不回来**；`enqueue` 的形参同理（不补 `:283`，`priority` 传进来也不会落盘）。 |
| `src/tools/list.ts`（`:189`） | **必需** | `implement.md` §1 明确要求「`collab_list` 行尾 `[urgent]`」；是验收项。无条件追加 `''`，priority 缺省时输出与改动前**逐字符相同**（全量 696 断言无变化可证）。 |
| `src/tools/owner-queue.ts`（`:23-25`） | **必需** | 与上同源：受保护目标的加急项只能通过 `collab_list` 的「我提交给受保护会话的请求」区展示（`collab_request_owner` 本身只有 enqueue/revoke，没有 list 模式）。同样是 `''` 拼接，缺省不变。 |
| `src/core/snapshot.ts` / `src/rpc.ts` / `src/tui.tsx` / `src/gui.tsx` | **必需且最小** | 设计与 `implement.md` 都要求快照+两个只读面板标 `[urgent]`；均在已有行尾追加，未改布局（TUI 只改 `handoffLines`/`queueLines` 的字符串尾巴与 tone，`tui.tsx:326-341`、`:361-372`）。 |

最小回退建议（若坚持「只改清单内文件」）：**不建议回退**——回退任一处都会直接打掉一条验收项（`[urgent]` 展示 / 队列读回），且不需要新增机制。真要缩：`src/gui.tsx` 的 badge（`:386-388`）与 `src/tui.tsx` 的队列 tone 属「好看」而非验收硬项，可选择性保留。

### ⑧ 回归与范围 — **通过**

```
pnpm build      ✔
pnpm typecheck  ✔
pnpm test       696/696 · 12/12 · 42/42 · 32/32 · 47/47 · 7/7
node scripts/check-skill.mjs   skills ok
```

- 工具数：`dist` 实测 **19** 个注册（`collab_list,…,collab_archive`，无重名），`test/readonly-default.mjs:146-179` 期望表也是 19 项（18 个非 report + `collab_report`）。
- 版本仍 `0.5.3`（`package.json` 未在工作区改动里）；无新依赖（`package.json`/lock 未改）；`BUILTIN_PROTECT` 未改（`src/constants.ts` 未改，仍两个 id）。
- 改动面：15 个文件（1 新 + 14 改），无 `src/constants.ts` / `src/core/claim.ts` / `src/tools/shared.ts` 触碰（`deliverPrompt` 没被导出复用，`escalate.ts:118-124` 自写 4 行等价实现——与 `shared.ts:280-286` 行为一致，属可接受的重复，见 R-3）。

### ⑨ 测试真实性 — **通过（有 1 处弱断言）**

- S97 实测 **20 条**（`grep -c "✓ S97"` = 20），与 `implement.md` / CHANGELOG 一致；`git diff --numstat test/handoff-harness.mjs` = **293 增 / 0 删** ⇒ 既有断言未被改写或弱化。
- 4 组变异（均自行施加 → 跑 → 还原，`sha256sum` 前后一致）：

| # | 变异 | 结果 |
| --- | --- | --- |
| 1 | `resolveMode(..., target.info?.agent)` → `'build'`（去掉只读降级） | 695/696，`FAIL: S97 read-only agent: delivery === queue, the receipt marks forced` |
| 2 | `if (guard)` → `if (guard && false)`（protected 改为直投） | 695/696，`FAIL: S97 protected: 0 prompts, one urgent queue item, canPush:false + the queue position`（干净断言，不崩栈） |
| 3 | 删 `owner-queue.ts:145`（priority 读回） | **696/696 仍全绿** ← 测试洞（见 S-1），我的探针 30/31（10c 红） |
| 4 | `actual = String(admitted?.delivery ?? mode)` → `actual = mode` | 695/696，`FAIL: S97 the host actually reported queue…` |

- **S-1（建议修，非阻塞）**：`test/handoff-harness.mjs:8701-8702` 的断言标题写「marks the hand-off `[urgent]` **and its queue item**」，但实际两个条件里第二个 `s97List.includes('[urgent]')` 被第一个条件（交接行本身含 `[urgent]`）满足 ⇒ **队列项的 `[urgent]` 没被真正断言**，这也正是变异 3 能全绿的原因。建议把第二个条件改成 `s97List.includes('· [urgent]')`（我的探针 10c 用的就是它）。同理 `collab_status` 队列行的 `[urgent]`（`status.ts:208`）与 `snapshot.queue[].priority` 目前也无断言覆盖（我另用探针 11b 验证通过，实现是对的，只是缺护栏）。

---

## 3. 原始输出（节选，均为本次亲跑）

### 3.1 验证命令

```text
build=0
typecheck=0
harness=0
=== 696/696 checks passed
=== 12/12 checks passed
=== 42/42 checks passed
=== 32/32 checks passed
=== 47/47 checks passed
=== 7/7 panel checks passed
skills ok
```

### 3.2 工具数（`/tmp/opencode/count-tools.mjs`）

```text
19 collab_list,collab_broadcast,collab_handoff,collab_request_owner,collab_accept,collab_send,collab_reply,collab_followup,collab_inbox,collab_wait,collab_status,collab_escalate,collab_grant,collab_promote,collab_report,collab_lock,collab_unlock,collab_locks,collab_archive
dups: []
```

### 3.3 自建探针（`/tmp/opencode/check-probe.mjs`，主段 31/31 + 快照段 11a–11c）

```text
# tool count = 19
  ✓ registry has 19 tools incl. collab_escalate
--- 1) steer receipt
没有  delivery=steer 的假设，实际回执：
mode=steer  delivery=steer  message=msg_1
  ✓ 1a one prompt, delivery=steer sent to the claimant
  ✓ 1b prompt body starts with [URGENT] and carries the bid
  ✓ 1c receipt prints delivery=steer + message id
  ✓ 1d metadata.collab.urgent === true
--- 4) record before/after keys: ...,receipt => ...,receipt,candidates,seenBy,askSeen,reminded,skipped,declines,attempts,followUps,priority,urgentAt,urgentReason,urgentBy
  ✓ 4a state / claim / receipt / replies byte-identical
  ✓ 4b only the four urgent fields were added (plus writeBroadcast updatedAt)
  ✓ 4c updatedAt is the only non-urgent field that moved (observation)
--- 2) host degraded
mode=steer  delivery=queue  message=msg_forced_2
注: 宿主实际采用 queue（目标空闲 / 被降级），本次未进入其当前轮。
  ✓ 2a asked for steer, receipt honestly says delivery=queue
--- 1e) host returned no delivery field
mode=steer  delivery=steer  message=msg_nodelivery_3      ← R-1 复现点
  ✓ 1e host omitted delivery: receipt still claims delivery=steer (unverified)
--- 3) read-only
mode=queue(forced)  delivery=queue  message=msg_4
  ✓ 3a read-only target: prompt delivery === queue
  ✓ 3b receipt marks queue(forced)
  ✓ 3c non-readonly + explicit mode:queue → queue, NOT forced
--- 5) protected (self)
受保护目标：未投递（0 条 prompt），已写入加急队列项 q_mwmwkg3r_zh0t。
canPush=false  队列位置: 第 1/1 位（未读）
  ✓ 5a protected: 0 prompts
  ✓ 5b protected: exactly one urgent queue item with the bid
  ✓ 5c receipt: canPush=false + queue position
  ✓ 5d protected record still marked urgent
--- 5e) protected via lineage (child)
  受保护: [protected-child depth=1] ses_e1eb91cebffeTv1467ubJLKebk
canPush=false  队列位置: 第 1/1 位（未读）
  ✓ 5e lineage child: 0 prompts + one urgent queue item + canPush=false
--- 6) idempotent repeat
已加急过（5 分钟内同 bid + 同 reason）：只刷新 urgentAt，未重复投递。
  ✓ 6a 6b 6c 6d（见 §2⑤）
--- 7) session target
  ✓ 7a session target: delivered to that session and marked its hand-off
  ✓ 7b session without an open hand-off: still delivered, receipt says so
  ✓ 8a confirm:false: zero prompts, zero writes, preview shows the body
  ✓ 9a readable refusals (target / both / reason / closed / bid / self)
  ✓ 9b control chars become spaces and the reason is capped at 200
--- 10) collab_list / status / owner-queue
- b_c0000000000001 claimed [urgent] lease=ok scope=local "$ probe 01" 提案=- 承接=ses_probe_busy attempts=0
- q_mwmwkycr_0esj → ses_e1eb…Kebk  10:00  "[URGENT] schema 线：先别合 thisPR (bid …" · [urgent]
b_c0000000000001  state=claimed  priority=urgent  承接=ses_prob…busy（handoff，剩 4m）  canPush=true  "probe 01"
  ✓ 10a collab_list marks [urgent]
  ✓ 10b collab_status reads priority=urgent
  ✓ 10c collab_list lists the urgent queue item (queueItemLine)
  ✓ 10d the three read paths wrote nothing
--- 11) snapshot
{"handoff":"urgent","queue":"urgent"}
  ✓ 11a snapshot.handoffs[].priority = urgent
  ✓ 11b snapshot.queue[].priority = urgent (protected item)
  ✓ 11c a closed hand-off is not listed even if it had been urgent

=== 31/31 probe checks passed        ← 主段（快照段 11a–11c 在其后追加跑，3 条全过）
```

### 3.4 `collab_status` 对受保护目标的队列行（`/tmp/opencode/status-probe.mjs`）

```text
受保护目标：未投递（0 条 prompt），已写入加急队列项 q_mwmwp3hq_xyrr。
b_aa00000000000001  state=claimed  priority=urgent  承接=ses_e1eb…Kebk（handoff，剩 4m40s）  canPush=false  "t"
  投递: -（本单没有投递记录）
  队列: 1 项（目标 ses_e1eb…Kebk，未读 1 条）:
    - q_mwmwp3hq_xyrr @ 10:03:39 第 1/1 位（未读） [urgent]
  最近回复: -
  下一步: 只能队列（该目标受保护）：collab_request_owner 或等其下一轮
```

### 3.5 变异（各自还原，sha256 一致）

```text
# 变异 1（只读降级）
695/696 checks passed
FAIL: S97 read-only agent: delivery === queue, the receipt marks forced

# 变异 2（protected 直投）
695/696 checks passed
FAIL: S97 protected: 0 prompts, one urgent queue item, canPush:false + the queue position

# 变异 3（删 normalizeQueueItem 的 priority 行）
696/696 checks passed        ← 测试未覆盖（S-1）
my probe: 30/31，10c 红

# 变异 4（回执忽略宿主 delivery）
695/696 checks passed
FAIL: S97 the host actually reported queue: the prompt asked for steer but the receipt says delivery=queue

# 还原
escalate.ts     de162d0c5073bd5a09ff2b3a3059b33c842f1997d734d6d40108e8e147197bab
owner-queue.ts  f17f30d16223d3879113d254aa52db618e38b8bc62bb231d8e2ffeb946e79c55
（还原后 pnpm build + typecheck + 696/696 + 探针全绿）
```

---

## 4. 建议修（2 条，均不阻塞提交）

| # | 位置 | 问题 | 最小改法 |
| --- | --- | --- | --- |
| S-1 | `test/handoff-harness.mjs:8701-8702` | 标题声称「and its queue item」，实际条件被交接行自身满足 ⇒ 队列项 `[urgent]` 无覆盖（变异 3 全绿为证） | 第二条件改成 `s97List.includes('· [urgent]')`；可顺带在 S97h 加一条「`collab_status` 队列行含 `[urgent]`」。 |
| S-2 | `README.md:262` | `pnpm test # build + 676 项 harness …` 已过期（现在 696） | 676 → 696。 |

---

## 5. 风险 / 观察清单（非阻塞）

| # | 级别 | 说明 | 建议 |
| --- | --- | --- | --- |
| R-1 | 低 | 宿主未回 `delivery` 时回执把 `mode` 当事实打印（`escalate.ts:376`，探针 1e 复现）；与 `shared.ts:592` 的 `?? '?'` 不一致 | 补 `?` 或补一行「宿主未回报」。设计稿 §2 原文为 `?? mode`，属「按设计但措辞过强」 |
| R-2 | 低 | `writeBroadcast` 强制刷新 `updatedAt`（`claim.ts:151`）⇒ 加急会让旧单在 `updatedAt` 排序里跳到最前；「只多四个字段」严格说不成立 | 接受即可；如需严格，另开写入口保留 `updatedAt`（不建议为它扩大改动面） |
| R-3 | 低 | `escalate.ts` 自写 `deliverUrgent`（`:118-124`）与 `shared.ts:280-286` 的 `deliverPrompt` 重复 4 行；`sanitizeReason` 与 `core/locks.ts:94` 同名同义（后者不剥 C1 / 双向字符，长度上限也不同，故并非纯重复） | 可把 `deliverPrompt` 提到 `ToolKit`，或从 `locks.ts` 抽公共清洗正则；不做也行 |
| R-4 | 低 | `mode` 只按「是否等于 `'queue'`」判断（`:205`），`mode:"QUEUE"` / `"xxx"` / `""` 都会走 `steer`（可能意外打断） | schema enum 已限制正常调用方；若要更稳可 `String(mode).toLowerCase()` + 非白名单回落到 `queue` |
| R-5 | 低 | preview 里 `将写入: <queueDir>/<queueID(now)>.json`（`:300`）用的是预览时刻的随机 id，实际写入是另一个 id | 文案改成目录级（`<queueDir>/（新文件）`）即可，纯文案 |

上述 5 条均不影响验收项、不影响契约、不影响安全边界。

---

## 6. 复核边界声明

- 未 `git add` / `commit` / `push`；未改动任何被复核文件（`git status --short` 与接手时逐行一致）。
- 变异实验先 `cp` 备份 → 施加 → 构建跑测 → `cp` 还原 → `sha256sum` 比对一致 → 再全量复跑；探针与临时目录全在 `/tmp/opencode/`、`/tmp/chk-escalate-*`。
- 未触碰真实会话、未 restart、未连任何 DB/外部系统。
