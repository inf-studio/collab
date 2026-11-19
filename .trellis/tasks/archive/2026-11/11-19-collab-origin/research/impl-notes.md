# 实现笔记：交接对接人 `origin`（0.7.0 子任务）

> 任务：`.trellis/tasks/11-19-collab-origin`
> 验收：`pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs`
> 结果：**783 + 12 + 20 + 50 + 49 + 47 + 17 全绿**，工具数仍 20，版本号未改（`0.6.0`），无新依赖。

## 1. 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/types.ts` | 新增 `BroadcastOrigin { sid, role?, directory? }`；`BroadcastRecord.origin?` |
| `src/core/claim.ts` | `normalizeOrigin`（容忍畸形/未知）、`storedOrigin`（`origin == from` 不落盘）、`resolveOrigin`（显式 / 一层继承 / 默认本会话）、`fillOriginDirectory`（显式 sid 时向宿主要一次目录）；`normalizeBroadcast` 归一化 `origin` |
| `src/tools/shared.ts` | `canReplyToProtected` 增加 `acceptOrigin`（仅放宽回执**目标**：`from.sid` 或 `origin.sid`；见 §8.1） |
| `src/core/verdict.ts` | `originHint`（固定文案）；`protocolHeader` / `takeoverBody` / `handoffActions` 增加 `origin`（+ 回执指引里的「跨层结论可直接发给它」） |
| `src/core/chain.ts` | peer 接管请求块把 `record.origin` 传给 `protocolHeader` + `handoffActions` |
| `src/tools/handoff.ts` | 入参 `origin`；写记录 `origin`；投递正文协议头后加对接人行；结果打印来源（显式 / 继承自 `<bid>`） |
| `src/tools/broadcast.ts` | 入参 `origin`；peer（open / spawn）记录写 `origin`；结果 / 回执指引带上 |
| `src/tools/send.ts` | 入参 `origin`：**显式**才写正文首行（不写记录、不继承） |
| `src/tools/status.ts` | 头部 `origin=ses_… @ <dir>`（仅当 `origin ≠ from`） |
| `src/tools/list.ts` | 行尾 ` via ses_…`（仅当 `origin ≠ from`） |
| `test/handoff-harness.mjs` | 新增 **S100**（修补后 32 条，见 §8） |
| `docs/collab.md` | §11.2 五个工具行 + 新增 **§11.16**（字段/继承/渲染/三行模板/验收/回滚） |
| `README.md` | 工具表 + `context` hook 段落的 `origin` 说明 |
| `skills/collab/SKILL.md` | 工具速查表 + 新增「一点十二、对接人 `origin`」+ description |
| `CHANGELOG.md` | `[Unreleased] · 0.7.0` 的 Added / Docs / Tests |

**不改**：`package.json` / `PLUGIN_VERSION`（版本由父任务统一）、`BUILTIN_PROTECT`、依赖、`src/index.ts`（`__internals` 未扩展，新逻辑全部经工具/hook 验收）。

## 2. A → B → C 两跳时序（S100 实测）

| 步 | 谁 | 动作 | 结果 |
| --- | --- | --- | --- |
| 1 | A | `collab_broadcast { workspace: B_WS, issuePath, confirm:true }` | 记录 `from = A`、**无 `origin`**（自己就是链头），`asked = B` |
| 2 | B | `collab_accept { bid, confirm:true }` | `state=acked`、`claim.by = B` |
| 3 | B | `collab_broadcast { workspace: C_WS, issuePath, confirm:true }`（**不填 origin**） | 记录 `from = B`、`origin = A @ A_WS`（继承），结果打印 `对接人…（继承自 b_<hop1>）` |
| 4 | C | `context` 注入 | 块内同时有 `发起方=B` 与 `对接人（非本单发起方）：A @ A_WS`，回执指引给出 `collab_send {target:"A", text:"[handoff] DONE b_<hop2> …"}` |
| 5 | C | `collab_send {target: A, text:"[handoff] DONE b_<hop2> …"}`（真实投递，见 §8.3） | 按 `kind=reply` 投递 → A 收到即闭环：`state=done`，`receipt.from = C`，`origin` 仍为 A → **2 跳闭环**（原来 4 跳） |

关键断言原文（S100 输出节选）：

```text
✓ S100 B→C inherits A as origin without filling anything (4 hops → 2) — {"origin":{"sid":"ses_s100_a","directory":"/tmp/collab-harness-…/ws/s100a"},"from":{"sid":"ses_s100_b","directory":"/tmp/collab-harness-…/ws/s100b"}}
✓ S100 C sees the 对接人 line (A @ its workspace) next to the requester (B)
✓ S100 … and the receipt guidance names A as the direct recipient of a cross-layer answer
✓ S100 … while stating the boundary: only the requester or the 对接人 can close it
✓ S100 a receipt addressed to the 对接人 really travels as kind=reply (legacy shape, no kind in the input)
✓ S100 … while a third target keeps kind=request and leaves the bid acked (only two targets open) — {"to":"ses_s100_e","kind":"request","state":"acked"}
✓ S100 C closes the bid by answering A directly (2 hops, no forwarder) — {"state":"done","receipt":{"from":"ses_s100_c","note":"已按链头 A 的决策修好","source":"kind"}}
✓ S100 the closed record still names A (the receipt carries the chain head) — {"sid":"ses_s100_a",…}
✓ S100 a receipt addressed to a protected origin is still refused (the kind rewrite never widens delivery)
✓ S100 … and nothing was delivered into the protected line — 0 prompt(s) / state=acked
```

（这些是 §8 修补后的最终断言；修补前的「闭环」用例是合成的，见 §8.3。）

## 3. 继承与覆盖样例

| 场景 | 入参 | 记录 `origin` | 依据 |
| --- | --- | --- | --- |
| 第一跳 A→B | 无 | **不写**（`from = A`） | `storedOrigin`：`origin.sid === from.sid` 即无意义 |
| A→B 显式 `origin: A`（自称链头） | `origin=A` | **不写**，注入无对接人行 | 同上（比 design 的表格更严格，见 §6 偏差 1） |
| B（A 单的承接方）→ C | 无 | `A @ A_WS` | 一层继承：`record.origin ?? record.from` |
| B → D（覆盖） | `origin=C` | `C @ C_WS` | 显式优先，且 `directory` 由 `fillOriginDirectory` 向宿主要到 |
| C → D（A 单已闭环） | 无 | `C @ C_WS`（不继承 A） | 继承只看**未闭环**交接（`claim.by = me`） |
| `origin` 指向不存在的别名 | `origin=nobody` | 拒绝：`未知对接人 "nobody"：…未写入任何内容。` | 三个工具一致：0 记录、0 投递 |
| `collab_send` 显式 `origin=A` | `origin=A` | 不写记录；正文首行 `对接人（非本单发起方）：A @ A_WS` | `collab_send` 不落记录，只影响正文 |
| `collab_send` 无 `origin` | 无 | 正文字节不变 | 无 origin = 不渲染 |

## 4. 旧记录逐字对比（compat）

S100e 用两条路径证明「无 `origin` 的输出与 0.6.0 逐字一致」：

1. **状态全文对比**（最强）：同一份旧记录（`b_99999999999900f1`，`from = ses_req`）先以「无 origin」读一次
   `collab_status`，再写成 `origin = { sid: 'ses_req' }`（等于 `from`）读第二次 —— 两次 `content` **完全相同**：

   ```text
   ✓ S100 an old record (no origin) prints no origin= and no 对接人 line — b_99999999999900f1  state=open  priority=normal  承接=-  "hardening fixture"
   ✓ S100 … and origin == from renders byte for byte the same status (self-origin is noise) — b_99999999999900f1  state=open  priority=normal  承接=-  "hardening fixture"
   ```

2. **注入块**：`origin` 等于 `from` 的记录注入时**没有** `对接人（` 行（块首三行仍是
   `[collab-handoff] 交接链路提醒…`、`你是承接方（bid=…）`、`完成后回执：…`）。

3. **协议头位置不漂移**（S99 + S100g）：`collab_handoff` 投递正文第 1/2/3 行仍是「你是承接方 / 完成后回执 /
   阻塞回执」，对接人行固定在第 4 行；无 `origin` 时第 4 行不存在。

## 5. 变异验证（原始输出 · 修补前基线 783）

> 这两组跑在**复核修补前**的 783 基线上（继承 / 渲染层）；修补后新增的两组（回执改写层）见 §8.4。

### 变异 ①：继承恒取本会话（`resolveOrigin` 的继承分支短路）

```ts
// src/core/claim.ts
-  if (holder) {
+  if (false && holder) {
```

```text
  ✗ S100 B→C inherits A as origin without filling anything (4 hops → 2) — {"from":{"sid":"ses_s100_b","directory":"…/ws/s100b"}}
  ✗ S100 the requester result says the origin was inherited — (缺失)
  ✗ S100 C sees the 对接人 line (A @ its workspace) next to the requester (B) — … 发起方=ses_s100_b → ① 领取…
  ✗ S100 … and the receipt guidance names A as the direct recipient of a cross-layer answer — (缺失)
  ✗ S100 collab_status prints origin= (sid + directory) — b_df2ce8d0b5141b90  state=acked  priority=normal  承接=… （无 origin=）
  ✗ S100 collab_list ends the hand-off line with `via <chain head>` — - b_df2ce8d0b5141b90 acked … （无 via）
  ✗ S100 the closed record still names A (the receipt carries the chain head)
=== 776/783 checks passed
```

还原后：`=== 783/783 checks passed`。

### 变异 ②：渲染不判 `origin ≠ from`

```ts
// src/core/verdict.ts  originHint
-  if (!sid || sid === String(requester ?? '').trim()) return undefined;
+  if (!sid) return undefined;
```

```text
  ✗ S100 an old record (origin == from) injects no 对接人 line — [collab-handoff] 交接链路提醒（每条只出现一次）: | - 群组广播 b_99999999999900f1：… | 你是承接方（bid=b_99999999999900f2）
=== 782/783 checks passed
```

还原后：`=== 783/783 checks passed`。

## 6. 与 design 的偏差（记录在案）

1. **「A→B 显式 `origin=A` → 记录 `origin=A`」没有按字面实现**：`origin.sid === from.sid` 时字段不落盘、
   也不渲染。理由是 `§3 渲染` 自己要求「仅当 `origin.sid !== from.sid` 时显示」，且「无 origin 与 0.6.0 逐字一致」
   要求单跳交接不产生任何新字节。显式入参因此改为在**真正有第三方链头**时验收（S100d：`origin=C` 覆盖继承；
   S100g：`collab_handoff origin=A`；S100h：`collab_send origin=A`）。
2. **`collab_send` 不继承**（design R2/R4 里「三个工具都继承」的简化）：`collab_send` 不写记录，若也继承，
   C 回执给自己发起方 B 时会被追加一行指向 A 的「对接人」——错的对象。实现为**只认显式 `origin`**，
   并在 §11.16.1 与 SKILL 里写明原因。`collab_handoff` / `collab_broadcast` 的继承不变。
3. **文档小节号**：design/implement 写 `docs/collab.md §11.9`，但 §11.9 已被「送达确认（ack）」占用
   （真实 §11.9 内容与交接无关），新小节写成 **§11.16**，并在 CHANGELOG/README/SKILL 交叉引用同一编号。
4. **`origin.role`**：类型与 `normalizeOrigin` 支持 `requester|implementer|observer`，但工具**不写** `role`
   （纯展示字段，写错比不写更糟）；畸形值被丢弃而不是整条记录报废。
5. **`directory` 来源**：继承时沿用上一跳记录（`from.directory` / `origin.directory`）；显式 sid 时
   `fillOriginDirectory` 向宿主要一次（失败只显示 `(未知目录)`，不抛——一个已消失的链头不该让交接失败）。
6. **`src/index.ts` 未改**：不改 `__internals`，S100 全部经真实工具 + `context` hook 验收（更贴近生产路径）。

## 7. 回归

```text
$ pnpm run typecheck        # 0 error
$ pnpm run build            # OK
$ node test/handoff-harness.mjs        === 788/788 checks passed   （原 756 + S100 32）
$ node test/readonly-default.mjs       === 12/12
$ node test/board-shape.mjs            === 20/20 board checks passed
$ node test/snapshot-shape.mjs         === 50/50
$ node --conditions=browser test/tui-render.mjs   === 49/49
$ node --conditions=browser test/gui-entry.mjs    === 47/47
$ node --conditions=browser test/gui-panel.mjs    === 17/17 panel checks passed
$ node scripts/check-skill.mjs         skills ok
```

（上表是**复核修补后**的最终值；修补前的基线是 783 + S100 27，见 §8。）

## 8. 复核修补（owner 定：A + B 组合）

> 复核报告：`research/check-report.md`（未改动）。结论「需修」只有一条：`handoffActions` 承诺
> 「发给对接人 A 的同一条 `[handoff]` 行也能闭环本单」**不成立**——`canReplyToProtected` 的目标判据只有
> `record.from.sid`，发给 A 的消息被投成 `kind=request`，接收侧按「显式 request 非回执」丢弃。
> owner 决定 **A+B 组合**：代码按 B 放开（对接人也能闭环），文档与测试按 A 的严谨度修正。

### 8.1 代码（B，`src/tools/shared.ts` + `src/tools/send.ts`）

- `canReplyToProtected` 新增 `acceptOrigin?: boolean`：**只**放宽第 ② 条（目标）——
  `target === from.sid || (acceptOrigin && target === origin.sid)`，仍要求 ③ `sender === claim.by`；
  空目标/第三方目标一律 `undefined`。
- `send.ts` **拆成两个判定**：
  - `boundedReply`（原样，不传 `acceptOrigin`）→ 仍决定 `allowProtectedReply` 与既有「遗留回执」提示；
  - `receiptToChainHead`（仅在 `boundedReply` 为空时算）→ 只决定 **`kind='reply'` 改写**，
    并在结果里加一条注（「回执发往对接人 …；受保护投递规则不变」）。
- `allowProtectedReply: Boolean(boundedReply)` —— **受保护投递一点没放宽**：`origin` 指向
  `[protected*]` 时 `receiptToChainHead` 会把 kind 改成 reply，但 dispatch 的护栏照旧拒绝（0 条 prompt）。
- 接收侧（`chain.applyReceipt`）/ `receiptAllowed` 未改：闭环只认 `claim.by === 发送者`。

### 8.2 文案（A，与实现一致 + 边界）

- `src/core/verdict.ts` 的对接人行：保留承诺，补边界「仅限本单发起方或对接人，第三方发送不会闭环」；
- 同步 `CHANGELOG.md`（Added 渲染段 + 新增 Fixed 段 + Tests）、`docs/collab.md` §11.16.2（并新增一段
  解释两个边界 + 受保护不变）与 §11.16.4 表格（拆成三行：发给 A 闭环 / 发给第三方不闭环 / protected 仍拒投）、
  `README.md`；
- 顺带修掉 review 的 Nit：`docs/collab.md` §11.16.1 注明 `role` 只保留在类型里（工具不写）；
  `handoff.ts` 的 `originNote` 分成「预览 = 会写进」「确认 = 已写入」。

### 8.3 测试：S100 闭环用例改为**真实回放**（不再是自证）

旧写法手写 `kind:'reply'` + 一个不存在的 `t_s100_receipt`，真实插件产不出那条消息（复核 §7）。新写法：

```js
// C 按注入里的提示原文调 collab_send，再把宿主**实际收到**的 prompt 回灌成 inbound
const replayPrompt = (prompt, inboxID) =>
  inbound(prompt.sessionID, prompt.text, prompt.metadata?.collab, inboxID);
```

| 断言 | 结果（原文） |
| --- | --- |
| 发给对接人 A：真实投递按 `kind=reply`，A 收到即闭环 | `{"to":"ses_s100_a","kind":"reply","text":"[collab:…][reply:t_…] [handoff] DONE b_… 已按链头 A 的决策修好"}` → `state=done`，`receipt.from=ses_s100_c` |
| 发给**第三方**：仍是 `request`，记录保持 | `{"to":"ses_s100_e","kind":"request","state":"acked"}` |
| `origin` 指向 `[protected*]`：改写不放宽投递 | `拒绝投递：目标 ses_e1eb91cb… 本身在 protect 名单内 … 未发送任何内容` / `0 prompt(s) / state=acked` |
| 注入块的边界文案 | `仅限本单发起方或对接人，第三方发送不会闭环` |

断言数 27 → **32**（+kind 改写、+第三方反向、+protected 拒投 ×2、+边界文案），交接链 **783 → 788**。

### 8.4 变异（原始输出，最终基线 788）

**③ 去掉 origin 分支**（`shared.ts`：`if (targetSid !== requesterSid) return undefined;`）：

```text
  ✗ S100 a receipt addressed to the 对接人 really travels as kind=reply (legacy shape, no kind in the input) — {"to":"ses_s100_a","kind":"request","text":"[collab:ses_s100…00_c][request:t_mwn5v2oe_pu2u] [handoff] DONE b_6752e05a5b744ee1 已按链头 A 的决策修好"}
  ✗ S100 C closes the bid by answering A directly (2 hops, no forwarder) — {"state":"acked"}
=== 786/788 checks passed
```

**④ 放宽成任意 target**（`if (false && targetSid !== requesterSid) …`）：

```text
  ✗ S69 another protected session is not this bid's requester → refused — 没有报错: 已投递 → ses_e23a4a23fffe4c4m7UQFR8dUL3 … kind=reply …
  ✗ S81 another protected session is not this bid's requester → refused — 没有报错: 已投递 → …
  ✗ S81 no refused legacy shape leaked a delivery or moved the record — claimed / +1 prompt(s)
  ✗ S100 … while a third target keeps kind=request and leaves the bid acked (only two targets open) — {"to":"ses_s100_e","kind":"reply","state":"blocked",…}
  ✗ S100 C closes the bid by answering A directly (2 hops, no forwarder) — {"state":"blocked",…}
  ✗ S100 a receipt addressed to a protected origin is still refused (the kind rewrite never widens delivery) — 没有报错: 已投递 → ses_e1eb91cb… kind=reply …
  ✗ S100 … and nothing was delivered into the protected line — 1 prompt(s) / state=acked
=== 781/788 checks passed
```

还原后：`=== 788/788 checks passed`。④ 连既有 S69/S81（受保护拒投）一起变红，正是「改写」与
「受保护放行」必须拆开的证据：把目标判定塞回共用判据，护栏就跟着漏。

### 8.5 仍然成立的旧结论

- 继承 / 覆盖 / 别名拒绝 / 旧记录逐字一致 / `status`·`list` 展示：**全部未改**，仍由 S100 原断言覆盖；
- 复核 §4 的两处 design 偏差：`design.md` §5 第一行已改为「自称链头 = 不落盘、不渲染」，
  §2 补「`collab_send` 仅显式生效」，§3 补「发给 `origin.sid` 按 kind=reply 可闭环（两个目标）」；
- 版本 `0.6.0`、工具数 20、无新依赖、未 `git add`/`commit`。
