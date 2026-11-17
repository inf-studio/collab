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
