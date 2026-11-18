# 实施记录：遗留单回执兼容 + 正文嗅探防误判（0.1.4）

> 状态：**已实施，待独立复核**。`build` / `typecheck` / `test`（405 harness + 12 只读默认）/ `check:skill` 全绿。
> 未做：`git add/commit/tag/push`、发布、全局升级（主会话职责）。

## 0. 起因与两轮范围

- 真实上报 `d_e4e7ae824f551d0f`：`b_bdae848832cd51fb`（0.1.1 创建、`receiptMode:push`、`acked`）的承接方按
  当时文案回执（`collab_send {target, text:"[handoff] DONE <bid> <摘要>"}`，**无 `kind`**）→ 默认 `request`
  → 0.1.2 的限界 reply 白名单不适用 → protect 护栏拒绝，3 次全败，遗留单永远无法闭环。
- 第一轮（R1/R2）：兼容该形态 + 可操作报错。
- 第二轮（安全评审，已核对属实）：接管请求本身就把 `[handoff] DONE <bid> <摘要>` 写进承接方上下文，
  而准入与状态迁移共用一条宽松正则 → 引用模板即可关单。追加 R5（行首锚定）、R6（push 侧回声守卫）、
  R7（显式意图优先）、R8（`receipt.source` 可追溯）。

## 1. 代码改动

### R1 兼容遗留回执 —— `src/tools/shared.ts` `canReplyToProtected`

- `requestedKind ∈ {reply, request}`；`request` 额外要求：
  ① 正文含 `[handoff]`（`HANDOFF_LINE_RE`，大小写不敏感）**且** `bid`（入参优先，其次正文 `RECEIPT_BID_RE`）
  等于该记录（并额外校验 `record.bid === wanted`，防止手改文件让 bid 字段与文件名不一致）；
  ② `record.from.sid === target`；③ `record.claim.by === sender`；④ `state ∉ done/blocked/expired`。
- **R7 出站侧**：新增入参 `legacyAllowed`（缺省 `false`）——只有工具入参**完全没写 `kind`** 时才为 true
  （`send.ts` 用 `rawKind === ''` 计算）。显式 `kind:"request"` 不走兼容。
- 新增入参 `mode`：`request` 形态遇 `mode:"steer"` 直接拒绝（遗留回执是「收尾报告」，不许插队）。
  - 注：`steer` 是 **mode**，不是 kind（`KINDS = request|reply|note`）。显式 `kind:"reply"` + `mode:"steer"`
    仍按 0.1.2 语义**强制 queue** 投递（S69 既有断言），不打断对方；只有「无 kind 兼容通道」额外要求不能要 steer。
- 决定：`note` 与显式 `request` 恒拒；不做「按正文猜 kind」的通用放宽。

### 放行后的表现 —— `src/tools/send.ts`

- `requestedKind` 与新变量 `legacyKind = rawKind === ''`；`boundedReply` 计算沿用 `requestedKind` +
  `legacyAllowed: legacyKind`。
- 命中时把 `kind` 置回 `reply`（信封 `[reply:<thread>]`、metadata `kind:"reply"`），删掉「reply 缺 threadID
  已降级」注记，并追加一条注：`遗留回执（0.1.1 及更早的命令不带 kind）已按 kind=reply 放行…`。
- `collab_send` 描述补一句遗留回执说明（模型可见）。

### R2 可操作报错 —— `src/tools/shared.ts` `dispatch()` 的 protect 拒绝分支

- 拒绝时若 `normalizeKind(kind) !== 'reply'` 且正文含 `[handoff]`，再以 `kind:"reply"` 复核一次白名单；
  命中即追加：

  ```text
  提示：这是遗留回执，请加 kind:"reply" 重发（或让对端升级到 0.1.4+）：
    collab_send {target:"<sid>", kind:"reply", text:"[handoff] DONE <bid> <摘要>", confirm:true}
  ```

  bid 取记录真实 bid，命令可直接复制（该命令经 S81 实测可投递并闭环）。
- `kind === 'reply'` 的旧文案保留（回执仍 fail-closed 的解释）。

### R5 行首锚定 —— `src/core/verdict.ts`

```ts
const HANDOFF_RECEIPT_RE = /^[ \t]*\[handoff\][ \t]+(DONE|BLOCKED)[ \t]+(\S+)[ \t]*([^\n]*)/im;
```

- `m` 多行：单独成行才算；`^[ \t]*` 允许缩进 / 列表符后的行首。
- 正文中段引用（`参考命令：collab_send {…"[handoff] DONE b_x <摘要>"}`）不再匹配（S82）。
- 为什么不会误伤真实回执：真实回执由 `envelope()` 包裹后入站，`extractInbound` 会剥掉
  `[collab:…][kind:…] ` 前缀，body 里 `[handoff]` 正好在行首。
- 只锚定了 push 侧的 `HANDOFF_RECEIPT_RE`；pull 侧 `HANDOFF_VERDICT_RE` 保持原样（它已要求目标 token
  等于**当前 bid** + 摘要槽无占位符，且只判最后一条回答），避免改动既有 S44–S53 语义。

### R6 push 侧回声守卫 —— `parseReceiptLine`

复用 pull 侧（`verdictFromTexts`）的三个常量，**只判命中行**：

- 目标或摘要槽出现 `<…>`（`VERDICT_PLACEHOLDER_RE` / `VERDICT_ECHO_RE`）→ 不判定；
- `DONE` 行自身含否定语（`未完成|无法完成|不会|还没|not done yet…`）或计划语（`完成后我会…`）→ 不判定；
- 不跨行拼接（`match[0]` 即整行）。

  **一处刻意收窄**：否定/计划守卫只作用于 `DONE` 行。`BLOCKED` 行本身就是否定答案，其理由
  （`无法完成：接口不存在`、`完成后我会再试`）**必须**能关单，否则「做不了」的回执全部失效。
  占位符守卫对两者都生效。已加用例：`[handoff] BLOCKED b_x 无法完成：接口不存在` → `state=blocked`。

### R7 显式意图优先（入站）—— `src/core/storage.ts` / `types.ts` / `src/core/chain.ts` / `src/index.ts`

- `extractInbound` 计算 `declaredKind = meta.kind ?? parsed.kind`，新增 `InboxMessage.kindExplicit = Boolean(declaredKind)`。
- `chain.applyReceipt(text, from, now?, source?: { kind?, explicit? })`：`source.explicit === true` 且
  `normalizeKind(source.kind) !== 'reply'` → 直接 `undefined`（不解析正文、不动记录）。
- `src/index.ts` 入站调用点传入 `{ kind: inbound.kind, explicit: inbound.kindExplicit === true }`。
- 结论矩阵：`kind` 缺省 → 允许正文回执（legacy CLI / ≤0.1.1）；`reply` → 允许；
  `note` / `request`（显式）→ 一律不迁移。
- 顺带防住一个真实隐患：`collab_accept` 的 ACCEPT 通知（`notifyRequester`，`kind:"note"`）正文含
  `完成后回执 [handoff] DONE <bid> <摘要>。`——R5（中段）+R6（占位符）+R7（note）三重都不让它关单。

### R8 可追溯 —— `receipt.source`

- `BroadcastRecord.receipt` 增 `source?: 'kind' | 'body'`；`applyReceipt` 写入：
  显式 `kind:"reply"` → `'kind'`，其余（缺省 kind，按正文识别）→ `'body'`。

## 2. 回归

`test/handoff-harness.mjs`：**405 项**（原 375 + S81 13 + S82 17），
`test/readonly-default.mjs`：12 项。

### S81（R1/R2，13 项）

1. 无 `kind` + `[handoff] DONE <bid>`（三条件匹配）→ 已投递 + 白名单放行 + `kind=reply`；
2. 信封为 `[reply:…]`、metadata `kind=reply`、强制 `queue`；
3. 白名单不改记录（`state` 仍 `claimed`）；
4. 入站无 kind 的正文回执 → `state=done`，`receipt.source=body`；
5. `note` + `[handoff]` 仍拒，且报错含 `这是遗留回执，请加 kind:"reply" 重发` + 可复制命令 + `0.1.4+`；
6. 显式 `kind:"request"` 不走兼容（R7）；
7. 无 kind 但 `mode:"steer"` 仍拒；
8. 普通 `request`（无 `[handoff]`）仍拒；
9. 只有 `bid` 入参、正文无 `[handoff]` → 不算遗留回执；
10. 旁观者（非领取人）拒；11. 换受保护目标拒；12. 错 bid / `done` 记录拒；
13. 全部拒绝路径零投递、记录未动。

### S82（R5–R8，17 项）

- 中段引用（真实 bid + `<摘要>`）→ 不改状态；
- 行首但 `<摘要>` 占位符 → 不改状态；行首否定语 → 不改；行首计划语 → 不改；
- `[handoff] BLOCKED b_x 无法完成：接口不存在` → 改（`blocked`；否定守卫只作用于 `DONE` 行）；
- 显式 `kind=note` / `kind=request` + 合法行 → 不改；同文本**缺省 kind** → 改（legacy）；
- 正文一句话 + 换行行首回执 → 改（R5 正例），`receipt.source=body`；
- 显式 `kind=reply` → 改，`receipt.source=kind`；
- 负例集合最终全部仍 `claimed`。

### 既有用例的必要调整（非「迁就实现」，是 R7 的直接后果）

- S28 / S30c / S36 的回执入站 fixture 原为 `kind:'note'`（S28/S30c 连信封也是 `[note:…]`）。按 R7，
  显式 `note` **不得**触发迁移，故改为 `kind:'reply'` / `[reply:…]`——这与 0.1.2+ 文档要求的回执形态一致。
- S69 的「request to the protected requester stays fail-closed」原用 `[handoff] DONE <bid>` 正文（正是
  R1 现在要放行的形态），改为「普通 request（正文无 `[handoff]`，仅含 bid 串）」仍拒；
  遗留形态放行的正例移到 S81。

## 3. 验证（原始输出摘要）

```text
$ pnpm build        ✔ Build complete
$ pnpm typecheck    $ tsc --noEmit   （无输出）
$ pnpm test         === 405/405 checks passed
                    === 12/12 checks passed
$ node scripts/check-skill.mjs   ✓ skills/collab/SKILL.md (collab) / skills ok
```

## 4. 遗留 / 交接给主会话

- `package.json` + `PLUGIN_VERSION` 已 bump `0.1.4`；`CHANGELOG.md` 顶部已写 `[0.1.4]`。
- 未改 `docs/**`、`skills/**`（本轮硬约束）；`docs/collab.md` §11.4 若需补「遗留回执 + R5–R7」说明，
  由主会话决定（工作区里 `docs/collab.md` / `SKILL.md` 另有他人的未提交改动，我未触碰）。
- 发布后：`b_bdae848832cd51fb` 可用原命令（无 `kind`）直接闭环；若仍用旧版插件则会收到带
  `kind:"reply"` 提示的新文案（仅 0.1.4+）。
- 上报签名 `d_e4e7ae824f551d0f` 的 `triagedAt` / 提案回写属主会话。
