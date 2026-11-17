> ⚠ 已作废：补丁已由主会话应用到 `docs/collab.md` 与 guide；本文保留仅作历史，**勿再次应用**。

# 文档补丁（R5）— 待主会话落到权威文档

> **为什么没直接改**：`docs/collab.md` 与 `.trellis/spec/guides/cross-workspace-collab-guide.md`
> **不在本工作区**（`/data/project/collab` 只有 `src/ test/ README/ skills/`；`git log --all -- docs/collab.md`
> 为空）。它们的唯一真源在 `/data/project/muke-pos-app`，而全局 AGENTS「工作区与数据边界」规定其他工作区
> **文档也只读**，唯一跨仓写豁免是 `docs/issues/**`。
>
> 因此这里给出**逐字可粘贴**的补丁内容（锚点为现状原文），由主会话在 muke-pos-app 应用（或授权本会话后由
> 本会话应用）。`test/handoff-harness.mjs` 的 S38/S43 文档断言在本仓为 skip（`hasRepoDocs=false`），不阻塞
> 本次验收。

---

## 1. `docs/collab.md` §11.4 — 在「护栏是 fail-closed…」那一段替换

**锚点（现状原文，替换整段）**

```
护栏是 **fail-closed**，`collab_reply` 同样受限：受保护线（或其后代）**发起的**请求，其回执也无法投回
该线（错误文案会注明「回执同样适用该护栏」）。这类线需要结果时请自己 `collab_inbox` 查看状态，
或用 `trellis channel` / `--mirror` 留痕，避免让对端空等 `collab_wait`。
```

**替换为**

````markdown
护栏是 **fail-closed**，`collab_reply` 同样受限：受保护线（或其后代）**发起的**请求，其回执默认也无法投回
该线（错误文案会注明「回执同样适用该护栏」）。

唯一例外是**限界 reply（bounded reply）**：`kind:"reply"` 且以下三条**同时**满足时放行投递（仍强制 `queue`，
返回里注明「回执按白名单放行」）：

1. `target` 就是该 `bid` 记录的**发起方**（`record.from.sid`）；
2. 发送者就是该单的**领取人**（`record.claim.by`）；
3. `bid` 归属该记录 —— 取入参 `bid`，否则取正文里的 `b_[0-9a-f]{8,32}`。

`request` / `note` / `steer`、旁观会话、其它 `bid`、「目标受保护但不是这单发起方」一律仍然 fail-closed；
`BUILTIN_PROTECT` 与血缘判定不变。放行只影响投递，**不改**广播记录状态（闭环仍由回执解析负责）。

受保护线需要结果时还有 §11.4.1 的 pull 模式：它发起的广播不要求推送回执，结果由它自己在租约到期后只读提取，
或用 `trellis channel` / `--mirror` 留痕，避免让对端空等 `collab_wait`。

### 11.4.1 受保护发起方（`receiptMode:"pull"`）

`scope=peer` 广播创建时，若发起方命中 `protectedAncestor`（自身或任一祖先在 `protect` 内），记录写
`receiptMode:"pull"`；否则写 `"push"`（**旧记录没有该字段，一律按 `push` 处理**，行为与文案不变）。

| 面 | `push`（默认） | `pull`（受保护发起方） |
| --- | --- | --- |
| ② 回执 | `collab_send {target:"<发起方 sid>", text:"[handoff] DONE <bid> <摘要>", confirm:true}` | 在**本会话最后一条回复**里写 `[handoff] DONE|BLOCKED <bid> <摘要>`；**不要** `collab_send`（会被护栏拒绝） |
| ③ 未完成判定 | 结论必须用 `collab_send` 真正发出 | 结论必须写进最后一条回复（含上面的 `[handoff]` 行） |
| 推辞 | `collab_send {… "DECLINE <bid> <理由>"}` | 不领取即可（5 分钟不答自动顺延下一候选） |
| 闭环 | 承接方回执，或租约到期只读提取（仅 `kind=spawn` 的 `claimed`） | 租约到期后发起方只读提取承接方**最后一条有文本的回复**（`kind=accept` 的领取同样适用） |
| 未闭环提醒 | 「用 collab_inbox 看回执」 | 「pull 模式：无需等待推送回执，租约到期后会只读提取承接方的最后一条回复」 |

三处文案（接管请求注入 / 叫醒 prompt / `collab_broadcast` 结果）与 `collab_accept` 的输出保持同一套说法。
````

## 2. `docs/collab.md` §12.2 — ③⑤⑥ 补 pull 说明

**⑤ 回执**：现状原文

```
⑤ 回执         collab_send { target:"<发起方 sid>", text:"[handoff] DONE <bid> <sha/摘要>", confirm:true }
               （只认 bid / 完整 issuePath / thread，且必须由承接方发送；判定无需处理时用 BLOCKED）
```

在其后追加一行（同一缩进层级）：

```
               ⚠ 记录 receiptMode:"pull"（发起方在 protect 名单内）时改成本会话最后一条回复写
                 `[handoff] DONE|BLOCKED <bid> <摘要>`——不要 collab_send；发起方租约到期后只读提取（§11.4.1）
```

**⑥ 闭环**：在现有「对端没发回执时，`kind=spawn` 的租约到期会…」之后追加

```
               pull 模式（receiptMode:"pull"）不受 `kind=spawn` 限制：`kind=accept` 的领取在租约到期后同样只读提取
               （受保护发起方没有推送通道，这是唯一闭环路径）。
```

## 3. `docs/collab.md` §12.5 第 11 条 — 修正「只覆盖 spawn」的表述

**锚点开头**：`11. **自动闭环只覆盖 `spawn` 的 `claimed`，且只有发起方能触发**：`

把标题改为：

```
11. **自动闭环覆盖所有领取类型的 `claimed`（`spawn` / `accept` / `handoff`），且只有发起方能触发**：
```

在该条末尾追加一句：

```
   例外：`receiptMode:"pull"`（受保护发起方）的记录对 `claim.kind` 不设限——`accept` 领取的 `claimed` 也会在
   租约到期后提取，因为该发起方没有可用的推送通道（S69）。
   `acked` 仍然没有租约路径：`acked` 只等回执，不做提取（人接手 / 重新广播另说）。
```

## 3.1 `docs/collab.md` §12.2 ⑥「闭环」词表补 R7

在现有 blocked 词表（`已实施|已修复|无需|不需要|已完成|already|not needed`）后追加：

```
               R7 另补 blocked 措辞：`回执被…拒` / `无法投递` / `改回写提案` / `回写提案` / `已自愈` / `无需改动`
               （真实回执被硬拒后「改回写提案」的答法也能收口）；`done` 仍只认 `完成|done|fixed`（先剔除「分析完成」）。
               判定顺序不变：[handoff] 行 > blocked 词 > done 词，否定语/计划语一律不判定。
```

## 3.2 `docs/collab.md` §12.5 — 新增第 12 条（R8：`acked` 静默收口）

在第 11 条之后新增：

```markdown
12. **`acked` 静默超 2h 可自动收口（R8）**：`acked` 没有租约（`refreshBroadcast` 只重开 `claimed`），
    回执丢失时曾会永远停在 `acked`。现在 `now - claim.at > ACKED_EXTRACT_MS`（2h）时，**发起方**触发的刷新
    会按与 `claimed` 相同的规则只读提取承接方最后一条回答：有结论 → `done|blocked` + `receipt{auto:true}`
    （不 `attempts++`）；判不出结论 → **状态保持 `acked`**、attempts 不变，只写 `staleNoticedAt`，
    同一窗口（2h）内不再重复读对端历史。承接方 protected 不读；`actor !== from.sid` 不读；
    `done` / `blocked` / `expired` 不处理。`collab_list` 对这类单标 `静默=Nh 可自动提取`（只读快照）。
    注意：受保护发起方没有 `context` 注入，收口发生在其下一次 `collab_broadcast` / `collab_handoff` 刷新时。
```

## 4. `.trellis/spec/guides/cross-workspace-collab-guide.md`

### 4.1 头部变更说明（第 7 行附近）

**锚点**：`> 自动回执轮 `11-17-collab-auto-receipt`：……`

追加一行：

```
> 受保护发起方轮 `11-18-collab-protected-receipt`：`receiptMode:"pull"`（发起方命中 protect → 回执写在自己最后一条
> 回复里，发起方租约到期只读提取）+ 限界 reply（`kind=reply` + 该 bid 的发起方 + 该单领取人 = 唯一放行条件）；
> `request`/`note`/`steer` 仍 fail-closed。
```

### 4.2 §5.2（承接分 B）末尾「为什么写成三步」之后追加

````markdown
**pull 变体（发起方在 protect 名单内）**：同一个 ①②③ 骨架，但 ② 改成「在本会话最后一条回复里写
`[handoff] DONE|BLOCKED <bid> <摘要>`」，并显式写「不要尝试 collab_send：发起方在 protect 名单内，投递会被拒绝」；
③ 随之改为「结论必须写在本会话最后一条回复里」。推辞不写 DECLINE，直接不领取（5 分钟顺延）。

为什么不是「放宽投递」：`deliver()` 的血缘护栏对**所有** `kind` fail-closed，这是护栏本意；让承接方去撞墙只会
产生一次失败调用 + 一条误导文案。唯一值得放行的只有「该单自己的回执」，因此有了限界 reply：

| 条件 | 说明 |
| --- | --- |
| `kind=reply` | `request` / `note` / `steer` 永不放行（不是回执） |
| `target === record.from.sid` | 这单的发起方本人，不是「任意受保护会话」 |
| `sender === record.claim.by` | 这单的领取人本人，旁观会话伪造无效 |
| `bid` 命中该记录 | 入参 `bid` 优先，其次正文 `b_[0-9a-f]{8,32}` |

放行时强制 `queue` 并注明「回执按白名单放行」；记录状态不变（闭环仍由 `applyReceipt` 负责）。
````

### 4.3 §5.3 自动闭环小节

**锚点**：`- `claim.kind = accept`（成员领取）**不自动提取**——那是人/会话自己领的，等它回执。`

**替换为**（R7 之后该条已过时）：

```
- `claim.kind` 不再限制提取：`spawn` / `accept` / `handoff` 的 `claimed` 在租约到期后都由**发起方**那次刷新
  只读提取承接方最后一条回答（S70）；`acked` 没有租约路径，只等回执。
```

并追加：

```
- blocked 措辞补：`回执被…拒` / `无法投递` / `改回写提案` / `回写提案` / `已自愈` / `无需改动`（R7）。
```

### 4.4 §9 护栏表「会话」行的补充（可并入说明）

在「不向 `[protected]` / `[protected-child]` 投递」之后追加：

```
（唯一例外 = 限界 reply：`kind=reply` + 该 bid 的发起方 + 该单领取人，强制 `queue`）；
```

### 4.5 §11 验收清单追加

```markdown
- [x] 受保护发起方的接管请求 / accept 输出 / 广播结果不含 `collab_send` 回执指令，含「最后一条回复写 `[handoff]`」，
      记录 `receiptMode:"pull"`；非受保护发起方文案与字段不变（S69）
- [x] pull 提取：承接方最后一条回复含 `[handoff] DONE <bid>` → 租约到期后发起方提取为 `done`（`receipt.auto`）（S69）
- [x] 限界 reply：三条件全中放行（强制 queue、不改记录），sender 错 / target 错 / bid 错 / `request` / `note` 仍拒绝（S69）
- [x] pull 模式的未闭环提醒说明「无需等待推送回执」（S69）
- [x] `accept` / `handoff` 领取的单租约到期后同样由发起方只读收口；无结论走原顺延；受保护承接方不读不闭环；
      旁观者不闭环；「回执被硬拒 / 改回写提案 / 已自愈」判为 `blocked`（S70）
- [x] `acked` 静默超 2h（`ACKED_EXTRACT_MS`）后发起方只读收口；无结论保持 `acked`（不降级、不 attempts++）
      且每窗口最多读一次（`staleNoticedAt`）；<2h / 旁观者 / protected 承接方都不读（S71）
```

## 5. `docs/issues/bugs-protected-requester-receipt-undeliverable.md`（状态回写由主会话做）

建议在提案头部状态行回写：`已修复（0.1.2）：pull 模式 + 限界 reply，回归 S69`。
