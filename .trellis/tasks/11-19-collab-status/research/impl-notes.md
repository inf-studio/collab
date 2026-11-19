# 实现说明：`collab_status`（只读、非阻塞）

> 任务：`.trellis/tasks/11-19-collab-status`　　版本：0.6.0 的一部分（`PLUGIN_VERSION` / `package.json`
> 均**未改**，仍 0.5.3，由父任务统一）

## 1. 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/tools/status.ts` | **新增**：`statusTool(kit)`（`collab_status { bid?, threadID?, session? }`） |
| `src/tools/index.ts` | 注册（`waitTool` 之后）：工具数 17 → 18 |
| `test/handoff-harness.mjs` | 新增 **S96**（17 条断言，含只读证明 + 变异对照） |
| `test/readonly-default.mjs` | 注册表 17 → 18（`collab_status` 在 `collab_wait` 之后） |
| `docs/collab.md` | §11.2 标题 17 → 18 + 工具表新行；新增 §11.14 |
| `README.md` | 首段「十七个」→「十八个」+ 工具表新行 + 源码结构行 |
| `skills/collab/SKILL.md` | frontmatter 描述、速查表、新增「一点八」、排障表一行 |
| `CHANGELOG.md` | `[0.6.0]` 内新增 `### Added`（collab_status）+ `### Tests` 两条 |

**未改 `src/types.ts`**：`implement.md` 提到给 `BroadcastRecord` 加 `priority?` 等字段，但（a）本任务的
硬约束清单里没有 `types.ts`；（b）`BroadcastRecord` 已带 `[key: string]: any`，读 `record.priority` 已是
`any`，`typecheck` 通过。所以按「只读取、不写入」处理：`asObject(record).priority === 'urgent' ? 'urgent' : 'normal'`，
缺失/旧记录即 `normal`。`priority` 的**写入**留给 `collab_escalate`（sibling 任务的 `types` 改动）。

## 2. 实现要点

- **解析顺序**（design §2）：`bid` → `readBroadcast`（不存在 = 可读错误）；`threadID` →
  `allBroadcasts().filter(record.threadID === …)`；`session` → 该 sid 作为 `from.sid` **或** `claim.by` 的
  全部未闭环 + **最近一条**已闭环；无参 → 本会话（`context.sessionID`）同口径的未闭环，≤5 条，
  `updatedAt` 倒序（`bid` 作同毫秒 tie-break）。
- **三选一**：多于一个 → `invalid('… 三选一（本次收到 bid + threadID）')`；`bid` 走 `isValidBid`、
  `threadID` 走 `normalizeThreadID` + `isValidThreadID`；`session` 接受别名（`collab.json` 优先于
  `ctx.storage` 的 `collab/aliases`，与 `resolveTarget` 同序）。未知别名按字面比较 → 「没有作为发起方或
  承接方的交接单」（状态查询不该像投递那样直接抛）。
- **每条输出**（design §3）：`bid state=… priority=… 承接=…（kind，剩 Xm） canPush=… "title"`
  ／`投递: admitted=HH:MM:SS seen=HH:MM:SS [ack=n/a…][unacked=…]`／`队列: N 项（目标 …，未读 K 条）`
  + 每项 `- q_… @ HH:MM:SS 第 K/N 位（未读）[urgent]`／`最近回复: HH:MM:SS "≤60 字"（short sid）`
  ／（已闭环）`回执: …`／`下一步: …`。
- **`canPush`**：承接方 = `claim.by` → `asked.sid` → `delivery.to` → 该单 owner-queue 项的 `target`；
  对它有值就 `createLineage(ctx).protectedAncestor(target, config.protect)`，受保护 → `false`。
  `canPush=false` 时下一步固定「只能队列（该目标受保护）：`collab_request_owner` 或等其下一轮」，优先于
  `claimed/acked` 的「等回执」文案；已闭环则恒为「无需动作」。
- **租约**：`leaseVerdict(record, now)`（只读判定，`collab_list` 同款）。`ok` → `剩 X`；`expired` →
  `租约已过期` + 一行注「下一次 refresh 才会释放并顺延；本命令不改写状态」。**不调 `refreshBroadcast`**。
- **队列**：`mineFor(record.from.sid)`（发起方提交的队列项）过滤 `item.bid === record.bid`；
  位置 = 该 target 的**未读**项里 `id` 的下标（`listFor(target).filter(!seenAt)`）。
- **零新契约**：不新增 JSON RPC 字段，不改 snapshot、不新增依赖。

## 3. 只读证明（测试怎么真会失败）

`test/handoff-harness.mjs` S96h：

1. 把 `ctx.session.prompt / update / create / remove / switchAgent` 与 `ctx.storage.set / remove`
   **整体替换**为「记录到 `s96Writes` 并 `throw`」的桩（`finally` 还原）；
2. 连打 7 次查询（bid claimed / threadID / session / protected / lapsed×2 / 无参×2）；
3. 前后对比三样东西：
   - `broadcastDir` 递归快照（`名:大小:mtime` 排序拼接）；
   - `ownerQueueDir` 同款递归快照（含 `<targetSid>/` 子目录）；
   - `ctx.storage` 的 `[...store.entries()]` JSON。
4. 断言：`s96Writes.length === 0`、无异常、三份快照完全一致。

另有 S96f：`lapsed` 单读前/读后 `mtimeMs` 相同且文件里 `state` 仍是 `claimed`（说明没有 `persistRefresh`）。
S96f 用的单在 S96h 之前被读过一次，所以 S96h 里另留了一条**只在只读块中第一次读**的 `lapsedStrict`
（`b_960000000000000d`）——否则「refresh+persist」型变异会被前一次读「消耗」掉，只读块就漏掉它。

### 变异（已还原，原始输出）

在 `bid` 分支的 `readBroadcast` 之后插入：

```ts
persistRefresh(record, refreshBroadcast(record));
```

`node test/handoff-harness.mjs`（`dist/` 用变异后源码重建）：

```
  ✗ S96 a lapsed claim says 租约已过期 and names the next refresh — the read rewrites nothing — 1795051616355.723 → 1795051616387.7239 / open
  ✗ S96 read-only: seven queries, zero write calls, broadcast / owner-queue dirs and storage unchanged — 0 write(s) / dirs CHANGED
=== 674/676 checks passed
FAIL: S96 a lapsed claim says 租约已过期 and names the next refresh — the read rewrites nothing
FAIL: S96 read-only: seven queries, zero write calls, broadcast / owner-queue dirs and storage unchanged
```

即：**「读会推进状态」的写法必然被这两条拦下**。还原后 `=== 676/676 checks passed`。

## 4. 各分支样本输出（harness 实跑，节选）

pending（claimed + urgent）：

```
b_9600000000000001  state=claimed  priority=urgent  承接=ses_s96_…peer（handoff，剩 4m）  canPush=true  "S96 01"
  投递: admitted=09:24:49  seen=09:25:03
  队列: 0 项
  最近回复: 09:25:08 "已接管，先读交接包"（ses_s96_…peer）
  下一步: 等回执 → collab_wait {threadID:"t_s96_claimed"}；超时用 collab_escalate
只读查询：不改状态、不释放租约、不投递；阻塞等待用 collab_wait，全量清单用 collab_list。
```

已闭环（done；blocked/expired 同形，仅 state/回执不同）：

```
b_9600000000000002  state=done  priority=normal  承接=ses_s96_…peer（handoff）  canPush=true  "S96 02"
  投递: -（本单没有投递记录）
  队列: 0 项
  最近回复: -
  回执: 09:24:58 "修好了，回归全绿"（ses_s96_…peer）
  下一步: 无需动作（已闭环：结论看上面的 receipt / 最近回复，历史用 collab_list）
```

protected 目标（`collab_request_owner { bid }` 写过一条队列项）：

```
b_9600000000000005  state=open  priority=normal  承接=-  canPush=false  "S96 05"
  投递: -（本单没有投递记录）
  队列: 1 项（目标 ses_e1eb…Kebk，未读 1 条）:
    - q_mwmvceyb_7ehl @ 09:25:48 第 1/1 位（未读）
  最近回复: -
  下一步: 只能队列（该目标受保护）：collab_request_owner 或等其下一轮
```

过期租约（不改写）：

```
b_960000000000000c  state=claimed  priority=normal  承接=ses_s96_…peer（handoff，租约已过期）  canPush=true  "S96 0c"
  注: 租约已过期 —— 下一次 refresh（collab_accept / context 注入）才会释放并顺延；本命令不改写状态。
  投递: -（本单没有投递记录）
  队列: 0 项
  最近回复: -
  下一步: 等回执 → collab_wait {threadID:"t_s96_lapsed"}；超时用 collab_escalate
```

无参（多条 / 空）：

```
本会话相关的未闭环交接 5 条（按 updatedAt 倒序，最多 5 条）:
b_9600000000000006  state=open  priority=normal  承接=-  "S96 06"
  …
```

```
当前没有未闭环交接。
只读查询：不改状态、不释放租约、不投递；阻塞等待用 collab_wait，全量清单用 collab_list。
```

`threadID` / `session`：

```
thread t_s96_claimed 的交接 1 条:
b_9600000000000001  state=claimed …

ses_s96 的交接 2 条（未闭环在前，最近一条已闭环在后）:
b_9600000000000001  …（未闭环）
b_9600000000000002  …（最近一条 done）
```

## 5. 验证

```
pnpm build          ✔
pnpm typecheck      ✔ (tsc --noEmit)
pnpm test           ✔ 676 + 12 + 42 + 32 + 47 + 7 全绿
node scripts/check-skill.mjs  ✔ skills ok
```

（任务给的基线是 `659 + 12 + 42 + 32 + 47 + 7`，S96 新增 17 条断言 → harness 676。）

## 6. 交给父任务 / 复核的注意点

1. **文案里的 `collab_escalate`**：design §3 要求 `claimed` 的下一步写「超时用 `collab_escalate`」，
   该工具由 sibling 任务（`11-19-collab-escalate`）提供。若两者合并顺序相反，会出现「文档提到尚不存在的
   工具」的窗口期；合并后即自洽。
2. **计数**：本任务把 17 → 18；父任务最终是 20（status + escalate + freeze）。`docs/collab.md` §11.2 标题、
   `README.md` 首段与「源码结构」行、`skills/collab` 描述里的数字需要父任务统一改成 20（sibling 也会各改一次）。
3. **§11.14 编号**：父 PRD 计划的「§11.14 高优先级协作」是一个大节，本任务按 implement.md 先占了
   `### 11.14 即时状态回执（collab_status）`。父任务可把它并成 `#### 11.14.x` 子节并重排。
4. **`session` 的「相关」口径**：按 design §2 只认 `from.sid` / `claim.by`，**不含** `asked.sid`。
   即「被问询但还没领取」的会话在无参模式下看不到这一单（它自己的 context 注入会收到接管请求）。
   若要扩到 `asked.sid`，是改 `involved()` 一行 + 一条断言，但会与 design 文案不一致，故未擅自扩。
5. **未动**：`src/types.ts`（`priority` 走既有 index signature 读取）、`src/core/*`、snapshot / GUI / TUI、
   版本号、任何 git 写操作。
