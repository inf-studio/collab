# 独立复核报告：collab 双向交接协议

> 复核人：冷上下文独立复核（trellis-check 角色，只审不改）
> 复核对象：提交 `86dd69ff5`（HEAD）`feat(collab): 双向交接协议（request/reply + 不打断 + 只读 agent 分级）— 待独立复核`
> 复核时间：2026-11-17 07:10–07:20（本机 opencode v2.3.0）
> 验收口径：`prd.md` 的 R1–R5 + Acceptance Criteria（`verification.md` 自述仅作线索）

## 0. 结论

**有条件通过** —— 主链路（request → reply → wait）、不打断、注入去重、只读 agent 权限四项经代码走读 + 确定性复现均成立；但**安全护栏对「受保护会话的子会话」不生效**（阻断级），以及 reply 参与者/路由未校验、thread 复用语义缺陷等应修项，需要处置后才能收尾归档。

| # | 项 | 结论 |
| --- | --- | --- |
| 1 | 闭环 request→reply→wait | **有条件通过**（主链路成立；对端可被非参与方伪造/误路由） |
| 2 | 不打断（queue 默认 / 无 interrupt / 只读强制 queue） | **通过** |
| 3 | 注入去重（三重过滤 / 上限 / 并发） | **通过**（有 legacy 提示文案缺陷） |
| 4 | 只读 agent 权限（`opencode.json`） | **通过**（实测为「追加」，非覆盖；未放开其它动作） |
| 5 | 防护与边界（protect / 自投 / threadID / inbox 全文） | **不通过（子会话缺口）** |

## 1. 复核对象与范围

- 提交只含 14 个文件，全部与本任务相关；**未**误带 `packages/schemas/**`、`packages/contracts/**`、`bench/`、`docs/issues/`、`packages/machine/**`、`apps/**`、`scripts/**`（`git show --name-only` 见 §3）。
- 复核时工作区里 `.trellis/spec/guides/cross-session-collab-guide.md` 有一处**不属于该提交**的未提交改动（mtime 07:13，内容为临时会话创建加 `location.directory`），疑为并发写者（主会话）所改；本次复核未触碰、未计入结论。
- `opencode.json`、`docs/collab.md`、spec guide、任务三件套与 `research/*` 已逐份对照代码。

## 2. 五项逐条结论与证据

### 2.1 闭环：request → reply → wait

**主链路：通过。**

- `collab_send` 自动生成 `threadID` 并写 `collab/threads/<tid>`：`collab.js:645-658`（`dispatch`）+ `appendThreadMessage`（`collab.js:420-450`）。
- thread 状态 `open → answered` 落 `ctx.storage`：确定性复现 S2（`status=open`）/ S8（`status=answered`），见 §3.1。
- `collab_wait{threadID}` **真的在等**，不是立即返回：无回执时按 `REPLY_POLL_MS=400` 轮询（`collab.js:675-704`）；我延迟 600ms 才回执，wait 在 801ms 返回全文（§3.4），超时返回可读错误（S9，1200ms）。
- 事件路径也能唤醒：`collab.js:1015` `signal.notify()`（本次未覆盖真实事件，见 §5 残留风险）。

**缺陷（应修）—— 对端/参与方可被伪造：**

| 场景 | 结果 | 复现 |
| --- | --- | --- |
| 非参与方 C 调 `collab_reply{threadID}` | **成功**：投递给 `thread.fromSession`，thread 置 `answered`；之后 A 的 `collab_wait` 返回 **C 的正文** | T1（§3.2） |
| `collab_send{kind:"reply", threadID, target:<无关会话>}` | **成功**：投递给无关 target，同时把这条 reply 写进别人的 thread（`msgs` 里出现 `reply->ses_ddd`，与 thread 顶层 `toSession` 不一致） | T2（§3.2） |
| 非参与方 D 用 `collab_wait{threadID}` | **成功**：直接读到该 thread 的 reply 全文 | T3（§3.2） |

根因：`collab_reply` 只做 `counterpart = fromSession===me ? toSession : fromSession`（`collab.js:858-861`），从不校验 `me ∈ {fromSession, toSession}`；`collab_send` 的 reply 分支（`collab.js:810-820`）不复核 `target` 是否等于 thread 对端；`waitForReply`（`collab.js:675-704`）不校验参与方。threadID 是 `t_<base36ts>_<rand4>`（4 位 base36 ≈ 1.7e6，时间戳可猜），一旦泄漏即可冒名/污染。`collab_reply` 描述写「against the thread's counterpart」，与实际行为不符。

### 2.2 不打断

**通过。**

- 默认 `queue`：`resolveMode` 仅当 `requested === "steer"` 才 steer（`collab.js:590-593`）；投递 `delivery: mode`（`collab.js:636-643`）。S2 preview/投递均为 `queue`。
- `steer` 必须显式：schema enum `["queue","steer"]`（`collab.js:788-794`）。
- **无 interrupt 调用**：`grep -n "interrupt" .opencode/plugins/collab.js` 只有 7 行注释/工具描述（15/37/768/792/793/833/923），没有任何 `ctx.session.interrupt` 或 HTTP 调用；`generate` 也只在注释里（26 行），未暴露。
- 只读 agent 强制 queue：S3（explore 传 `mode:"steer"`）→ `mode=queue(forced)`，实际 `prompt delivery=queue`，且返回里明示「已入队，不打断对方当前轮」。

**残留（可留 / 需产品裁定）**：强制是**发送方**维度（`resolveMode(..., context.agent)`）。`build` 发送方仍可显式 `steer` 到 `explore`/`plan` 目标；PRD R2 允许显式 steer，但 `collab.js:78-81` 的注释把理由写成「inbound hand-off 不会并入**对方**正在跑的轮次」，与实现（保护的是调用方自己的轮次）不一致，建议改注释或补目标侧保护。

### 2.3 注入去重

**通过。**

三重过滤逐条对照：

1. `injected` 列表：`accounted = new Set(box.injected)`（`collab.js:1041`），循环首行按 `messageIDs`（cid + id）跳过（`collab.js:1047-1048`）。
2. 本次请求已含：`collectRequestKeys` 收 `metadata.collab.cid`（`:516-518`）、`(kind,threadID,text)` 键（`:518`,`:530`）、纯文本退化（`:531`）；hook 用 cid / key / text 三路比对（`collab.js:1049-1056`）。
3. 已 answered/closed 的 thread：request 类消息跳过（`collab.js:1057-1064`）。

复现：S4 首注入 1 条 → S5 同消息再来 `[]` → S6 metadata cid `[]` → S7 纯文本退化 `[]` → S12 thread=answered `[]`；另外我自造 5 条 pending 验证 `maxInject=3` 分两批注入、第三批 `[]`（T5/T5b/T5c，§3.3）；1500 字正文 `collab_inbox` 原样返回（T6）。

`injected` 不会无限增长：`inbox.update` 用存活消息 id 过滤（`collab.js:360-362`，`alive` ≤ `MAX_STORED=50`），实测写入后只剩 id、条数 ≤ 50。

**两个缺陷：**

- **应修（低-中）**：legacy CLI 消息 `[collab:cli-user] <正文>`（无 `[kind:thread]`、无 metadata，`docs/collab.md` §3.2 明确支持）会被 `parseEnvelope` 命中并按 `kind=request, threadID=undefined` 入库（`extractInbound` `collab.js:454-485`），注入文案随即给出 **`collab_reply {threadID:"undefined"}`**（`lineOf` `collab.js:1098-1110`）——照做必然报「threadID 格式不合法」。复现见 §3.5。
- **可留（理论并发）**：hook 是 read→compute→update，`accounted` 在锁外计算（`collab.js:1033-1066`），`inbox.update` 只序列化写（`collab.js:352-373`）。同会话两个并发请求理论上可重复注入或丢 ack；V2 单会话串行处理，实际暴露很低。彻底修法是把 read+compute 移进 `serialize`。

### 2.4 只读 agent 权限（最高优先级越权检查）

**通过 —— 实测 `permissions` 为「追加」，且没有顺手放开别的动作。**

- 落盘配置只加 5 条（`opencode.json:6-25`，explore/plan 各 5 条，无其它 action）。JSON 合法。
- 服务端解析后的**实际权限链**（`opencode api get "/api/agent?location%5Bdirectory%5D=$PWD"`）：

```
explore: * allow → *(deny) → shell/grep/glob/webfetch/websearch/read allow → subagent deny →
         external_directory allow → collab_list/inbox/wait/reply/send allow → browser deny → skill(browser) deny
plan:    * allow → question allow → edit deny → edit /root/.opencode/plan/* allow →
         collab_list/inbox/wait/reply/send allow → browser deny → skill(browser) deny
```

  → 内置 `*: deny` + 只读白名单**仍在**（未被覆盖），5 条 `collab_*` 追加在其后并因「最后匹配生效」而生效；`explore` 未获得 write/edit，`plan` 的 `edit deny` 未被破坏。有效性与「新会话生效」结论一致。
- 5 个工具在真实 explore 会话可见：`verification.md` §4 的探针记录（`tools=[collab_inbox, collab_list, collab_reply, collab_send, collab_wait, glob, grep, read, shell, skill, webfetch, websearch]`）与上面的权限链互相印证。
- `BUILTIN_PROTECT` 两条 hard list 未被 config 削弱：`loadConfig` 对 protect / readonlyAgents 都是**先内置、后追加**（`collab.js:287-300`），只能加不能减（与 docs §11.4 一致）。

### 2.5 防护与边界

**不通过（子会话缺口）；其余通过。**

| 检查点 | 结论 | 证据 |
| --- | --- | --- |
| `BUILTIN_PROTECT` 仍含两条 id | ✅ | `collab.js:76`；与旧版逐字一致 |
| 精确 id 的 protect 拒绝 | ✅ | `collab.js:602-607`；S14 |
| **受保护会话的「子会话」** | ❌ **未覆盖** | 见下 |
| 自投递拒绝 | ✅ | `collab.js:608-610`；S14 |
| 非法 threadID 拒绝（send/reply） | ✅ | `collab.js:807-809`、`846-848`；S14 |
| 非法 threadID 拒绝（**wait**） | ⚠️ 未校验 | `collab.js:935-939` 只 trim；T4 对 `not-a-thread` 空等 1000ms 才超时 |
| `collab_inbox` 全文不受 `maxInject` 截断 | ✅ | `collab.js:888-904`；T6（1500 字原样返回） |
| `collab_inbox` 只读、不推进游标 | ✅ | `collab.js:881-916` 无写操作 |
| `collab_send confirm` 门 | ✅ | `collab.js:622-634`；S1 `delivered prompts so far: 0` |

**子会话缺口（建议阻断级）**

`dispatch` 只做 `config.protect.includes(sessionID)`（`collab.js:602`），**不看 `parentID`**；`collab_list` 也不显示 parent（`collab.js:733-755`，而服务端 `Session.Info` 是带 `parentID` 的）。任务硬约束写的是「禁止投递给 schema 线 / 原会话**及其子会话**」，`HANDOFF.md` §四.1 又写着「插件 BUILTIN_PROTECT 已含」，读者会以为护栏已兜底。

实测（假 ctx，未触真实会话）：

```
[FORCED-PASS] ses_child_of_schema   (parentID=ses_e1eb91cebffeTv1467ubJLKebk)  → 已投递，prompt 真的 admit 到该会话
[FORCED-PASS] ses_child_of_main     (parentID=ses_e23a4a23fffe4c4m7UQFR8dUL3)  → 已投递
collab_list 里两个子会话都没有任何 parent/受保护标记
```

而服务端**当前就存在**这两条线的活跃子会话（GET 只读核对）：

```
ses_e195d42bdffeSCLeWVWiP4uUtV  agent=trellis-implement  parentID=ses_e23a4a23fffe4c4m7UQFR8dUL3  title=扩词表降 uncovered
ses_e196273b2ffekqAqqqKfyA4xMN  agent=trellis-implement  parentID=ses_e1eb91cebffeTv1467ubJLKebk  title=order:detailed 接线
```

建议修法（任一 + 文档）：
1. `dispatch` 在 protect 精确匹配后追加：`if (config.protect.includes(info.parentID)) 拒绝`（`/api/session/{id}` 已确认返回 `parentID`；若插件 `ctx.session.get` 不含该字段，可用 `ctx.session.list()` 建映射或按血缘逐级上溯）；
2. `collab_list` 对 `parentID` 命中的会话标 `[protected-child]` / 打印 `parent=<short>`（CLI 的 `list` 本来就有 parent 列）；
3. 过渡期可把现存子会话 id 加进 `~/.config/opencode/collab.json` 的 `protect`（懒读，立即生效），但代码血缘检查才是根治。

## 3. 亲自执行的命令与原始输出摘要

### 3.1 任务自带确定性回归

```
$ node .trellis/tasks/11-17-collab-handoff/research/handoff-harness.mjs
EXIT=0
S1 preview: 未投递… / delivered prompts so far: 0
S2 send: kind=request thread=t_mwjvp43g_fx92 status=open / prompt delivery=queue / metadata 含 cid/kind/threadID
S3 explore+steer: mode=queue(forced) / prompt delivery=queue
S4: ["[collab] 待处理请求 1 条\n- request t_manual_0001 from=ses_bbb: 需要你复核 X → 处理后用 collab_reply {threadID:\"t_manual_0001\"}"]
S5/S6/S7/S12: []（均不重复注入）
S8 collab_reply: status=answered / target prompt sessionID=ses_aaa delivery=queue
S9: 有回执→返回全文；t_missing_0000 → 1200ms 后「等待回执超时」
S10: ses_bbb 无入站 →「本会话还没有任何跨会话消息」
S11: kind:reply 缺 threadID → 降级 request + 注记
S13 collab_inbox: 4 条全文 + seen/injected/status 标记
S14: protect / 自投 / 未知 thread / 非法 threadID 四类均拒绝
S15: 3 个会话，[self] / alias=schema [protected]
S16: idle 模式 wait →「目标已空闲」
```

> 与自述的差异：`verification.md` §8 把「S10/S13 `collab_inbox` 全文 + 标记」并列，但 S10 实际是**空 inbox**（ses_bbb 从未收到入站，S3 是它发出的），只有 S13 证明了全文/标记。自述整体属实，但存在这种小失真。

### 3.2 越权/伪造探针（/tmp/collab-edge-harness.mjs，假 ctx，无真实投递）

```
threadID = t_mwjvq17l_7j5k
T1 非参与方 ses_ccc collab_reply → NO-ERROR「已投递 → ses_aaa … kind=reply status=answered」
   A 的 collab_wait → 返回「我是第三方伪造的回执」（from=ses_ccc…）
T2 collab_send{kind:reply, threadID, target:ses_ddd} → NO-ERROR，prompt 真的投给 ses_ddd
   thread.msgs toSession = request->ses_bbb, reply->ses_aaa, reply->ses_ddd
T3 非参与方 ses_ccc collab_wait → 读到 thread 里 ses_aaa 的 reply 全文
T4 collab_wait{threadID:"not-a-thread"} → 1000ms 后「等待回执超时」（无格式校验、未知 thread 不快速失败）
```

### 3.3 注入上限 / 全文

```
T5 5 条 pending + maxInject=3 → 首次注入 3 条 +「…还有 2 条」
T5b 第二次请求 → 余下 2 条
T5c 第三次请求 → []
T6 1500 字正文 → collab_inbox 原样包含（inbox chars=1665）
T7 待处理消息正文 "ok" vs 请求里无关 user 文本 "ok" → 仍正常注入（不误判）
```

### 3.4 真等待

```
reply sent at 601 ms
wait returned after 801 ms
thread t_mwjvtinc_onr6 收到回执（status=answered）… 迟到 600ms 的回执
```

### 3.5 legacy CLI 消息

```
legacy message injected as:
["[collab] 待处理请求 1 条\n- request - from=cli-user: room/order 的 group 全 null 已修，请复核 → 处理后用 collab_reply {threadID:\"undefined\"}\n全文/状态用 collab_inbox。"]
collab_inbox: [request] thread=- from=cli-user …
```

### 3.6 子会话护栏

见 §2.5（`/tmp/collab-child-harness.mjs`）。

### 3.7 thread 复用

```
status after reply: answered
status after 2nd request: answered          ← 未重开
B hook system for 2nd request: []           ← 复用 thread 的第二个请求不再提醒
A collab_wait on reused thread: 第一轮回执   ← 立即返回旧回执
```

### 3.8 必跑命令

```
$ node --check .opencode/plugins/collab.js        → EXIT=0
$ grep -n "interrupt" …/collab.js                  → 仅 7 处注释/描述，无 API 调用
$ python3 -c "json.load(open('opencode.json'))"    → opencode.json OK
$ opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"
  → {"id":"collab","source":{"type":"local","path":"…/.opencode/plugins/collab.js"},"state":{"status":"active"}}
     （无 failed；同目录另 3 个 trellis 插件 active）
$ git show 86dd69ff5 --name-only
  .opencode/plugins/collab.js
  .trellis/spec/guides/cross-session-collab-guide.md
  .trellis/tasks/11-17-collab-handoff/{check.jsonl,design.md,implement.jsonl,implement.md,prd.md,task.json}
  .trellis/tasks/11-17-collab-handoff/research/{HANDOFF.md,baseline.md,handoff-harness.mjs,verification.md}
  docs/collab.md
  opencode.json
  → forbidden path scan（packages/schemas|packages/contracts|bench/|docs/issues/|packages/machine|apps/|scripts/）= none
$ ls .trellis/tasks/11-17-collab-handoff/research/  → 无 check-report.md（此前确实未落盘）
```

### 3.9 清理复核（verification.md §6 的 5 个临时会话 + 遗留 demo）

```
ses_e196ae5daffeWUBIjFiCEFs7fK → SessionNotFoundError
ses_e196ae582ffeO2VWnDXMkVc2yM → SessionNotFoundError
ses_e19703779ffejouxjys0NxJ712 → SessionNotFoundError
ses_e19710adaffe6zKIt0dnWaccyc → SessionNotFoundError
ses_e19710a5affeU5fkGT3NCk5XUG → SessionNotFoundError
ses_e196ba958ffe1sGISNNTRQsnaE → SessionNotFoundError
```

## 4. 风险清单

### 阻断（收尾前必须处置）

1. **受保护会话的子会话不在护栏内**（`collab.js:602` 只比对精确 id；`collab_list` 不显示 parentID）。任务硬约束要求「及其子会话」，服务端现有 2 个受保护线的活跃子会话，假 ctx 已证明可投递成功，且 HANDOFF §四.1 容易被读成「插件已兜底」。→ 加 `parentID` 血缘检查 + list 标注，或由 owner 明确裁定「子会话不兜底」并改 HANDOFF/docs。

### 应修

2. **reply 的参与者与路由未校验**：非参与方 `collab_reply` 可冒充回执（T1）、`collab_send{kind:reply}` 可投给任意 target 并写进别人的 thread（T2）、`collab_wait` 可读任意 thread（T3）。→ `collab_reply` 校验 `me ∈ {fromSession,toSession}`；reply 的 `target` 必须等于 thread 对端；`waitForReply` 校验参与方；或在 docs 明确「threadID 是 bearer 凭据，只发给参与者」。
3. **thread 复用语义**：同 thread 的第二个 `request` 不重开（status 仍 `answered`）、接收方 hook 不再提醒、发起方 `collab_wait` 立即返回**旧回执**（§3.7）。`collab_send` 的 `threadID` 入参是公开可用的，这不是纯理论场景。→ request 时置 `open`；`waitForReply` 只看「最后一次 request 之后」的 reply；或文档写明 thread 一次性。
4. **legacy CLI 消息产生 `collab_reply {threadID:"undefined"}` 的错误指引**（§3.5）。→ `lineOf` 在 `!message.threadID` 时不拼回执提示，改为「无 thread，无法回执」。
5. **持久化 AC 口径被改写**：PRD AC 写「改 `~/.config/opencode/collab.json` 触发热重载后数据仍在」，实测该文件不触发重载（`implement.md` §5 已订正为「插件文件重载」）。实质（`ctx.storage` 跨实例持久）有证据，但**验收条目与 prd 不一致**，需 owner 书面确认；`opencode service restart` 后持久化仍未验证。
6. **`collab_wait` 缺 threadID 校验**，未知/畸形 thread 会空等到超时（T4）。→ 与 send/reply 对齐 `isValidThreadID`，未知 thread 快速报错。

### 可留

7. `closed` 状态**不可达**：`STATUSES` 含它，`appendThreadMessage` 也处理它（`collab.js:66,439`），但没有任何工具/路径写入 `closed`；design §1/§2、docs §11.2/§11.7 却把它写成状态机一环。建议实现 close 或从文档移除。
8. `design.md` 与实现/文档不同步：storage 契约写 `msgs:[{id,inboxID,…}]`，实现是 `{threadID,cid,…}`；信封示例写 `[req:<tid>]`，实现是 `[request:<tid>]`。
9. `collab_inbox` 的「全文」实际单条上限 `INBOX_TEXT_LIMIT=4000`（`collab.js:63,481`），超出会截断并加 `…`；docs 写「全文」未注明上限。
10. `injected` 标记语义偏宽：既包含真正注入过的，也包含「已在本次请求里」和「thread 已 answered 被跳过」的消息（`collab.js:1043-1064`），`collab_inbox` 会把它们都显示成 `injected`。
11. `context` hook 的 read→compute→update 未放进 serializer（理论并发下可重复注入/丢 ack，§2.3）。
12. `collab.js:78-81` 注释把只读强制 queue 的理由写成「保护对方当前轮」，实际保护的是调用方；`build` 仍可显式 steer 到只读目标（PRD 允许，但与注释冲突）。
13. `docs/collab.md` §11.2 `collab_list` 行「本会话标 `[self,protected]`」只在当前会话本身在 protect 名单时成立（普通会话只显示 `[self]`，见 S15）。
14. 门禁覆盖：`.opencode/**` 在 `eslint.config.mjs:30` 与 `vite.config.ts:22` 的忽略列表里，生产插件不在 `fmt/typecheck/lint` 范围；本提交唯一自动化检查是 `node --check` + 研究用 harness，而 harness 未进 CI。建议把该 harness 纳入 CI 防回归。
15. 跨项目：`collab_list` 不过滤 location，而 thread/inbox 存储按 location 隔离；给别的项目的会话发请求后，回执流程会静默超时。docs §11.7 未提示「需同一目录/项目」。

## 5. 本次复核的残留风险（未能独立验证的部分）

- **真实端到端（真实 agent + 真实 `ctx.session.prompt`/事件流）未重跑**：需要真模型轮次与自建临时会话；成本与「不打断并行会话」的约束下，本次以确定性复现覆盖状态机/去重/护栏，结合实现方留存的真实工具返回原文判断。建议收尾前由主会话按 §3.1 口径抽一次真链路（自建会话 → 删 → 404）。
- 插件重载后持久化：本次只核对了 `verification.md` 的 before/after 原文，未制造重载。

## 6. 硬约束遵守与清理

- 未向 `ses_e1eb91cebffeTv1467ubJLKebk`、`ses_e23a4a23fffe4c4m7UQFR8dUL3` 及其子会话投递任何消息（全部探针使用假 ctx，`prompt` 只进内存数组）。对真实会话只发了 `GET`。
- 未改 `packages/**`、`apps/**`、`packages/schemas/**`；未碰 `11-15-design-normalize`；未执行 `opencode service restart`。
- 未 commit / push / `git add`；实现文件零改动。
- 未创建临时会话/临时插件。本次新增文件仅为：本报告（任务允许路径）+ `/tmp` 下 5 个复现脚本与 1 份旧版快照（`/tmp/collab-{edge,child,reuse,legacy,wait}-harness.mjs`、`/tmp/collab-old.js`），未写入仓库。
