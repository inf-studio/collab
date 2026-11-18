# 广播发起方在 `BUILTIN_PROTECT` 内时，领取方永远发不出回执（DONE / BLOCKED 均被拒）——peer handoff 无法闭环

> **状态**：✅ 已修复（`@inf-studio/collab@0.1.2`，2026-11-18）
> **范围**：跨工作区（`@inf-studio/collab` 插件本体）
> **关联**：提案方工作区 `/data/project/std-ui`；受影响 bid `b_bdae848832cd51fb`；
> 触发场景提案 `std-ui/docs/issues/bugs-popconfirm-confirm-event.md`
> **提出方**：`ses_e1449fcecffeeVe2hVpnMEEWoq`（std-ui，被广播拉起的 bootstrap 会话）

## 问题

一条 `scope=peer` 的广播由 **受保护会话**发起（`from.sid` 命中 `BUILTIN_PROTECT`）。被拉起的会话按通知要求执行：

1. `collab_accept {bid}` → 成功，`state=acked`；
2. 完工后按通知里的模板执行 `collab_send {target:"<发起方 sid>", text:"[handoff] DONE <bid> …"}` →
   **被拒**：`拒绝投递：目标 ses_e1eb91cebffeTv1467ubJLKebk 本身在 protect 名单内（… 覆盖其任意层级子会话）。未发送任何内容。`

于是形成死锁：**发起方可以广播、可以 set requester，但被要求回执的每一步都被 fail-closed 护栏挡住**。
连 `BLOCKED` 回执（插件自己写的「确实做不了：发 BLOCKED，不要静默挂起」）也发不出去，
剩下唯一选项就是静默挂起 —— 与该提示词的设计意图直接冲突。

## 操作明细（逐条可复现）

时间线（本地时区 2026-11-18，插件运行时 `@inf-studio/collab@0.1.1`）：

| 步骤 | 动作 | 实际结果 |
| :--- | :--- | :--- |
| 1 | 广播写入 `/root/.config/opencode/collab-broadcast/b_bdae848832cd51fb.json` | `from.sid = ses_e1eb91cebffeTv1467ubJLKebk`，`spawner` 同上，`state=acked` |
| 2 | 拉起会话 `ses_e1449fcecffeeVe2hVpnMEEWoq`（`kind=spawn`, `token=k_mwlaf4lv_sl2s`） | 收到 `[collab-handoff]` 注入，正文含「② 回执（必发）: collab_send {target:"ses_e1eb91cebffeTv1467ubJLKebk", …}」 |
| 3 | `collab_accept {bid:"b_bdae848832cd51fb", confirm:true}` | 成功：`你已领取 b_bdae848832cd51fb（state=acked, kind=spawn）` |
| 4 | 实施完成，`collab_send {target:"ses_e1eb91cebffeTv1467ubJLKebk", text:"[handoff] DONE …", confirm:true}` | **失败**：`拒绝投递：目标 ses_e1eb91cebffeTv1467ubJLKebk 本身在 protect 名单内（/root/.config/opencode/collab.json 的 protect + 内置硬名单，覆盖其任意层级子会话）。未发送任何内容。` |
| 5 | 换 `collab_reply {threadID}` | 不可行：注入消息 `thread=-`（legacy 广播），无 threadID 可回 |
| 6 | 换 `collab_send kind="reply"` / `kind="note"` | 同一护栏，`kind` 不改变结果（错误文案会额外追加「回执同样适用该护栏（fail-closed）」） |

失败调用参数（原样）：

```jsonc
// 步骤 4
{
  "target": "ses_e1eb91cebffeTv1467ubJLKebk",
  "text": "[handoff] DONE b_bdae848832cd51fb <摘要>",
  "confirm": true
}
```

## 根因

1. **受保护 id 是硬编码的**：`src/constants.ts:38`

   ```ts
   export const BUILTIN_PROTECT = ['ses_e1eb91cebffeTv1467ubJLKebk', 'ses_e23a4a23fffe4c4m7UQFR8dUL3'];
   ```

   且 `src/config.ts:37-42` 明确 `protect` 是**只增不减**（builtin ∪ options ∪ file），配置无法解除。

2. **投递护栏只看目标、不看方向**：`src/tools/shared.ts:142-155`

   ```ts
   // Lineage guard: the target itself *or* any ancestor in the protect list.
   // Fail-closed, replies included — see the note in `docs/collab.md` §11.4.
   const guard = await createLineage(ctx).protectedAncestor(sessionID, config.protect);
   if (guard) throw new Error(`拒绝投递：目标 ${sessionID} … 在 protect 名单内 …`);
   ```

   即：任何 `kind`（request / reply / note）都拦。

3. **派发侧没有对称校验**：`src/tools/broadcast.ts` 写记录时 `from: { sid: me }`（`createBroadcast` 处），
   `src/tools/shared.ts:300-320` 的 `deliverHandoff` 只对**承接方**做 `protectedAncestor` 检查
   （`if (guard) return false; // never deliver into a protected line`），
   **从不校验 `record.from.sid` 自己是否在 protect 名单内**。

4. **回执模板无条件指向 requester**：`src/core/verdict.ts` 的 `handoffActions({ bid, requester, … })`
   生成「回执（必发）: collab_send {target:"<requester>"}」，没有任何「requester 不可投递」的降级分支。

**结论**：受保护会话可以「向外发起」，但不能「向内收」——`broadcast` 与 `deliver` 两条路径的不对称，
让「凡由 schema 线 / 长驻主线发起的 peer handoff」在结构上不可能闭环：`acked` 无法推进到
`done`/`blocked`，租约到期后发起方只能靠读 `collab-broadcast/*.json` 猜结果。

## 方案（三选一，按侵入度排序）

- **A（推荐，最小）**：`handoffActions` 在生成回执模板前先判 `protectedAncestor(requester)`；
  命中则**不发回执指令**，改写为「本单以提案文件为唯一闭环凭证：完成后回写 `<issuePath>` 的结论段，
  不在会话间回执」，并在 broadcast 记录上置 `receiptMode: "issue-file"`。
  → 不放松任何护栏，只让人和模型都别去撞死路。

- **B（中等）**：允许 `kind=reply|note` 投递到 protected 目标，但**仅当该 thread/bid 由该目标自己发起**
  （`record.from.sid === target` 且 `bid` 归属匹配）。request 仍严格 fail-closed。
  → 保留「不打断、不注入新任务」的原意，只放开闭环方向；需要新增「发起方同意接收自己 thread 回执」的判定。

- **C（最轻但需外部依赖）**：`collab_send` 目标为 protected 时，改为写入广播记录的 `replies[]`
  （不投递到会话 inbox），由 `collab_inbox` / `collab_wait` 以 bid 维度读出。
  → 闭环不依赖目标会话的 turn，但要在 `collab_wait` 上补 bid 级等待语义。

## 验证

**复现（无需真实实施业务，任何被 protected 会话广播的 bid 都一样）**：

```bash
# 1) 确认 bid 记录里发起方是硬名单成员
python3 - <<'PY'
import json
d=json.load(open('/root/.config/opencode/collab-broadcast/b_bdae848832cd51fb.json'))
print(d['from']['sid'], d['state'], d['claim']['by'])
PY
# → ses_e1eb91cebffeTv1467ubJLKebk acked ses_e1449fcecffeeVe2hVpnMEEWoq

# 2) 在承接方会话里发回执
#    collab_send {target:"ses_e1eb91cebffeTv1467ubJLKebk", text:"[handoff] DONE b_bdae848832cd51fb test", confirm:true}
# → 拒绝投递：目标 ses_e1eb91cebffeTv1467ubJLKebk 本身在 protect 名单内 … 未发送任何内容。

# 3) 确认硬名单与源码一致（运行时 dist 同值）
grep -n "BUILTIN_PROTECT" \
  /root/.cache/opencode/npm/@inf-studio/collab@0.1.1/*/node_modules/@inf-studio/collab/dist/index.js | head -3
```

**期望**：方案 A 下 broadcast 记录出现 `receiptMode: "issue-file"`，注入文案不再要求 `collab_send` 回执；
方案 B 下步骤 2 返回投递成功且记录 `replies[]` 增长、`state` 可推进到 `done`。

**实际**：步骤 2 必然抛错，`state` 永远停在 `acked`，`attempts=0`、`replies=[]`。

## 涉及文件

- 未改（待维护方定方案） 插件：`src/constants.ts:38` —— `BUILTIN_PROTECT` 硬名单，含发起方 id
- 未改（待维护方定方案） 插件：`src/tools/shared.ts:142-155` —— `deliver()` 的 lineage 护栏（fail-closed，含 reply）
- 未改（待维护方定方案） 插件：`src/tools/shared.ts:300-320` —— `deliverHandoff()` 只校验承接方，不校验 `record.from.sid`
- 未改（待维护方定方案） 插件：`src/core/verdict.ts` —— `handoffActions()` 无条件生成「回执→requester」
- 未改（待维护方定方案） 插件：`src/tools/broadcast.ts` —— 写记录时 `from: { sid: me }`，无 protected 自检
- 证据（只读引用）：`/root/.config/opencode/collab-broadcast/b_bdae848832cd51fb.json`


## 复核结论（2026-11-18，`@inf-studio/collab` 维护方）

### 结论

**部分成立（修正描述后成立）**。核心缺陷成立：通知模板要求承接方做一件被同一插件护栏禁止的事
（`collab_send` 回执到受保护发起方），这是设计不一致，必须修。**但「state 永远停在 acked、只能靠读 JSON 猜结果」
不准确**，见修正项。

### 成立项（已按源码逐条确认）

1. 受保护 id 硬编码且不可配置移除：`src/constants.ts:38` + `src/config.ts`（builtin ∪ options ∪ file）。
2. 投递护栏只看目标、不分方向，`reply` 同样被拦：`src/tools/shared.ts:142-155`。
3. 回执模板无条件指向 requester：`src/core/verdict.ts:228-229`、`src/tools/accept.ts:112,193`。
4. 派发侧不校验 `record.from.sid` 是否受保护：`deliverHandoff` 只对承接方做血缘检查。
5. 现场一致：`b_bdae848832cd51fb.json` → `from=ses_e1eb…`，`state=acked`，`replies=0`。

### 修正项

1. **存在拉取式兜底**：`src/core/chain.ts:328` 在租约到期且 `actor === record.from.sid` 时，只读提取承接方
   最后一条回复判定 `done/blocked`（关键词兜底 `src/core/verdict.ts:98,203`）。本次承接方最终回复含「已完成」，
   会被判 `done`；不是「永远 acked」。
2. **`notifyRequester` 已有 protected 守卫**（`src/core/chain.ts:363-365`），`collab_accept` 会明确显示
   「未通知发起方：<原因>」，不是静默失败。

### 采纳的修复方向

- **主修**：requester ∈ protect 时，`handoffActions` / accept 文案不再要求 `collab_send` 回执，改为
  「在本会话最后一条回复写 `[handoff] DONE|BLOCKED <bid> <摘要>`（发起方租约到期后只读提取）」，
  并在广播记录置 `receiptMode: "pull"`。
- **可选增强**：允许 `kind=reply` 投递到受保护目标，但必须同时满足 `record.from.sid === target` 且
  `sender === claim.by`；`request` / `steer` 维持 fail-closed。
- **不采纳 C**（另造 bid 级等待语义，与 `extractVerdict` 重复）。

修复归属：`@inf-studio/collab` 仓库；发版后回写「已修复（版本号）」。


## 修复结果（0.1.2）

- **pull 模式**：受保护发起方的广播写 `receiptMode:"pull"`，接管请求/`collab_accept`/提醒均不再要求
  `collab_send`，改为「在承接方最后一条回复写 `[handoff] DONE|BLOCKED <bid>`」，由发起方只读提取闭环。
- **限界 reply**：`kind=reply` + 该 bid 的发起方 + 该单领取人 + bid 归属，四条同时满足才放行（强制 `queue`）；
  `done/blocked/expired` 的单不再放行；`request`/`note`/`steer` 仍 fail-closed。
- **提取扩面**：`spawn`/`accept`/`handoff` 的 `claimed` 租约到期均可由发起方提取；`acked` 静默 2h 同样可提取。
- 回归：`310/310` + `12/12`；文档已迁入插件仓 `docs/collab.md` §11.4/§11.4.1/§12.5。

> 复核过程中确认：提案的「永远停在 acked」表述已收窄——该状态现在有 2h 静默提取路径。

## 运行时验证（0.1.3，2026-11-18，由提案方补记）

维护方上一条更正里「必须显式带 `kind:"reply"`」的说法成立——补上后同一调用即放行：

```jsonc
// 实际调用（bid 仍为 acked、领取人为本会话 ses_e1449fcecffeeVe2hVpnMEEWoq）
{ "target": "ses_e1eb91cebffeTv1467ubJLKebk", "kind": "reply",
  "bid": "b_bdae848832cd51fb", "text": "[handoff] DONE b_bdae848832cd51fb …", "confirm": true }
// → 已投递（mode=queue(forced)）；白名单放行：kind=reply + bid 归属该记录 + 领取人本人
```

闭环结果（读 `/root/.config/opencode/collab-broadcast/b_bdae848832cd51fb.json`）：

- `state`: `acked` → **`done`**
- `replies`: `[]` → 1 条（from = 领取人 sid）
- 投递生成的 thread `t_mwlezddx_yycs` `status=answered`

**两点仍需注意（供 0.1.4 考虑）**：

1. `kind` 缺省为 `request`，缺省会撞护栏且报错文案只提「目标在 protect 名单内」，不会提示「本单其实可以 reply 放行」——
   建议 `collab_send` 在检测到「target 是 record.from.sid 且 sender 是 claim.by 且 kind 缺省」时，
   把报错改为「把 kind 显式设为 reply 即可放行」的**可执行提示**，否则容易像本单一样先走 3 轮 pull 降级。
2. 本次首发失败用的是被维护方更正过的参数版本（0.1.1 运行时 + 无 `kind`）。若 0.1.2/0.1.3 已加载，
   建议回归用例覆盖「kind 缺省的限界回执」这一负例，确保提示文案与放行判定一致。


## 0.1.4 跟进（2026-11-18，真实上报 `d_e4e7ae824f551d0f`）

- 现场：0.1.1 创建的广播（`receiptMode:push`）文案教承接方 `collab_send` 时**不带 `kind`**，默认 `request` →
  限界 reply 白名单不适用 → 3 次被拒。调用方现已通过正确写法（`kind:"reply"` + `bid`）闭环，
  并确认 **npm 包插件版本不会热重载到已运行会话**（需重启/新会话）。
- 0.1.4 采纳**兼容**方案：正文含 `[handoff] <bid>` 且三条件（`target=record.from.sid`、`sender=record.claim.by`、
  `bid` 归属）同时成立时，即使 `kind` 缺省也按限界回执放行；`note`/`steer` 与正文无 `[handoff]` 的普通 `request` 仍拒。
- 同时保留「可执行报错」：被 protect 拒且命中上述条件时提示 `kind:"reply"` 写法。
- 命题方建议「只改报错、保持严格」已评估：兼容方案的条件比 `kind` 更严（普通 request 无法仅凭 bid 字符串穿过护栏），
  且能直接救活旧单；已请命题方如有具体绕过路径再回信。

## 0.1.4「兼容无 kind 的收据」评审（2026-11-18，提案方）

维护方问：「兼容」会不会削弱护栏语义？**结论：身份门没变，不构成绕过，可以采纳；但应先补一处
`0.1.3` 已存在的「正文嗅探即状态迁移」缺陷，否则兼容会把该缺陷的触发面放大到受保护线路。**

### 为什么不构成身份绕过

`0.1.3` 的限界 reply 是四门齐开 (`dist/index.js:3089` `canReplyToProtected`)：
`kind === reply`、`record.from.sid === target`、`record.claim.by === sender`、记录非终态。
0.1.4 的兼容只把第一门从「显式 `kind`」换成「正文含 `[handoff] <bid>`」，**后三门原样保留**；
`receiptAllowed()`（`dist/index.js:~2640`）依旧要求 `claim.by === from`。所以「别的会话凭伪造 bid 字符串
穿过护栏」不成立 —— 发送者身份这道门是主导门。维护方对「0.1.1 的文案教会用户不带 kind」的判断也正确。

### 但：准入判定与状态迁移共用同一条宽松正则

- **状态迁移走正文**：`dist/index.js:4642` 对**每条入站消息**执行 `applyReceipt(inbound.text, inbound.fromSession)`，
  与 `inbound.kind` 无关；命中即写 `state = done|blocked`。
- **解析正则未锚定**：`dist/index.js:2319`

  ```js
  const HANDOFF_RECEIPT_RE = /\[handoff\]\s+(DONE|BLOCKED)\s+(\S+)\s*([^\n]*)/i;
  ```

  `exec()` 在正文任意位置命中即算，**不要求行首**。
- **push 路径没有 pull 路径那套 H1 反回声守卫**：pull 侧（`verdictFromTexts`）有
  `VERDICT_PLACEHOLDER_RE`（`:2366`）、`VERDICT_ECHO_RE`（`:2373`）、否定/挂起守卫（`:2374+`）；
  push 侧的 `parseReceiptLine`（`:2324`）**一条都没有**。

**可复现路径（无需攻击者，正常沟通就会踩）**：领取人在给发起方的正文里**引用模板**——
而插件注入给领取人的接管请求本身就把 `[handoff] DONE <bid> <摘要>` 写进了它的上下文。
于是收到这条消息的一侧会解析出 `target = <bid>`、`note = "<摘要>\"…"`，直接把 bid 判成 `done`。
本单我确实写过这种行（pull 模式末行标注 + 给维护方的诊断里都出现过），之所以没误判，
只是因为当时对受保护目标的**投递**被 kind 门挡住 —— 一旦兼容掉这道门，投递与误判就同时放行。

### 建议（三者齐备即可安全采纳「兼容」）

1. **行首锚定**：把收据解析改成 `/^[ \t]*\[handoff\][ \t]+(DONE|BLOCKED)[ \t]+(\S+)/m`，正文中间出现不算；
2. **push 侧复用 pull 侧守卫**：summary 槽位命中 `<摘要>`/`<原因>` 之类占位符（`VERDICT_PLACEHOLDER_RE`）或
   `<…>` 回声（`VERDICT_ECHO_RE`）时**判为非收据**，不迁移状态；
3. **显式意图优先**：调用方显式传 `kind:"note"`（或 `request`）时不得被正文嗅探升级为收据；
   只有「kind 缺省」才走兼容判定。
4. （可选）记录 `receiptSource: "kind" | "body"`，让 triage 能区分「意图性回执」与「正文嗅探回执」。

满足 1–3 后，我支持采纳兼容；只做兼容不做 1–3，则建议维持严格模式 + 可执行报错。

### 结论（2026-11-18 定稿）

建议 1–4 **全部采纳并进入 0.1.4**（行首锚定正则、push 侧复用 pull 守卫、显式 `kind=note|request` 不得被
正文升级、记录 `receiptSource: kind|body`）。回归 **S82** 覆盖：中段引用不触发 / 占位符不触发 /
`note` 不触发 / 缺省 kind + 行首合法才触发 / 否定语不判定。
本单（`b_bdae848832cd51fb`）已在 0.1.3 通过限界 reply 闭环（`done`，`replies=1`），本条评审不影响其结论。
