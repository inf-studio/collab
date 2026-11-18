# 独立复核报告：遗留回执兼容（0.1.4）

> 角色：冷上下文复核（只审不改）。未 commit / 未 push / 未 git add / 未改实现文件。
> 被复核范围：`src/**`、`test/handoff-harness.mjs`、`CHANGELOG.md`、`package.json`（工作区未提交）。
> 复核方式：读 diff + 自写假 ctx 复现（**不采信**既有断言）+ 全量门禁。
> 证据附件：`research/check-independent.log`（49 项自写用例）、`research/check-probe.log`（定向探测）、`research/check-verify.log`（门禁原始输出）。

## 结论

**实现与 prd/implement 一致，未发现阻断性缺陷，可提交（发布前需主会话补 2 件事：docs/collab.md §11.4 与发布说明的升级顺序）。**

- 门禁：`pnpm build` + `pnpm typecheck` + `pnpm test`（405/405 + 12/12）+ `node scripts/check-skill.mjs`（skills ok）全绿。
- 自写用例：**49/49 通过**（覆盖 R1 边界、R2 文案与可执行性、R5 锚定、R6 守卫、R7 入站/出站、R8 来源、真实投递 E2E、非受保护回执回归、无信封前置过滤）。
- 逐条结论：**R1 通过 / R2 通过 / R5 通过 / R6 通过（含 1 处刻意收窄，判定合理）/ R7 通过 / R8 部分满足（目的部分落空）**；回归、安全、范围均通过。
- 未自修任何实现：本次角色为只读复核（派发方明确「只审不改」），下列 8 项风险均为**建议**，不阻断合入。

## 逐条证据

### 1. R1 兼容边界 —— 通过

代码：`src/tools/shared.ts:71-115`（`canReplyToProtected`）、`src/tools/send.ts:76-78`（`legacyKind = rawKind === ''`）、`send.ts:150-168`（放行后 `kind='reply'`）、`shared.ts:38,99`（`[handoff]` 存在性）、`shared.ts:103-113`（bid/state/from/claim 四条件）。

| 场景 | 判定 | 我的复现（自写假 ctx） |
| --- | --- | --- |
| 无 kind + 正文 `[handoff] DONE <bid>` + 三条件 | 放行 | `已投递 → P1`，信封 `[reply:t_…]`、`metadata.kind=reply`、`delivery=queue`；白名单不动记录（`acked`） |
| 正文无 `[handoff]` 的普通 request | 仍拒 | 拒绝文案「在 protect 名单内…未发送任何内容」，零投递 |
| 只给 `bid` 入参、正文无 `[handoff]` | 仍拒 | 同上（`shared.ts:99` 拦截） |
| 显式 `kind:"note"` | 仍拒 | 拒 + R2 提示 |
| 无 kind + `mode:"steer"` | 仍拒 | `shared.ts:101` 拦截 |
| 显式 `kind:"request"` | 仍拒 | `shared.ts:92` + `legacyAllowed=false` 拦截（R7 出站） |
| 旁观者（非领取人） | 仍拒 | `shared.ts:113` 拦截 |
| 目标受保护但不是该单发起方 | 仍拒 | `shared.ts:112` 拦截 |
| 外来 bid | 仍拒 | `readBroadcast` + `record.bid` 校验（`shared.ts:105-109`） |
| `done` / `blocked` 记录 | 仍拒 | `BCAST_DONE_STATES`（`constants.ts:109`） |

补充：`record.bid === wanted` 这条额外校验（`shared.ts:109`）能挡住「文件名与 `bid` 字段不一致」的手改记录，属正当加固；`readBroadcast` 已用文件名兜底（`core/claim.ts:34`），旧记录（0.1.1）不受影响。

### 2. R2 可操作报错 —— 通过

代码：`src/tools/shared.ts:293-311`。

实测被拒输出（原始）：

```
拒绝投递：目标 ses_e1eb91cebffeTv1467ubJLKebk 本身在 protect 名单内（…）。未发送任何内容。
提示：这是遗留回执，请加 kind:"reply" 重发（或让对端升级到 0.1.4+）：
  collab_send {target:"ses_e1eb91cebffeTv1467ubJLKebk", kind:"reply", text:"[handoff] DONE b_cccc000000000010 <摘要>", confirm:true}
```

- 触发条件严格：仅当 `normalizeKind(kind) !== 'reply'` 且正文含 `[handoff]` 且**三条件命中**（`shared.ts:293-302`）才追加，旁观者/错 bid 拿不到提示（实测无提示）。
- 命令可直接执行：我把 `<摘要>` 换成真实结论后调用 → `已投递`；这个写法确实能闭环（E2E 已验证）。
- 未命中提示时保留旧文案（`shared.ts:306-308`），0.1.2 的解释语未被删。

### 3. R5 行首锚定 —— 通过

代码：`src/core/verdict.ts:17`（`/^[ \t]*\[handoff\][ \t]+(DONE|BLOCKED)[ \t]+(\S+)[ \t]*([^\n]*)/im`）。

| 正文 | 结果 |
| --- | --- |
| `参考命令：collab_send {…"[handoff] DONE b_x <摘要>"…} 照这个发` | 不判定 ✓ |
| `已完成。[handoff] DONE b_x 已修复`（同一行中段） | 不判定 ✓ |
| `> [handoff] DONE b_x 已修复`（markdown 引用） | 不判定 ✓ |
| `改好了。\n[handoff] DONE b_x 已修复`（换行后行首） | `done` ✓ |
| `  [handoff] DONE b_x 已修复`（缩进） | `done` ✓ |

- 真实链路成立：`extractInbound` 会剥掉 `[collab:…][kind:…] ` 前缀（`core/storage.ts:178-183`），body 里 `[handoff]` 正好在行首；我用真实投递文本走 `extractInbound → applyReceipt` 复现，闭环成功。
- pull 侧 `HANDOFF_VERDICT_RE`（`verdict.ts:91`）**未**锚定，属实现方的刻意选择（避免动 S44–S53）。风险见风险清单 #4。

### 4. R6 push 侧回声守卫 —— 通过（含 1 处自决，判定合理）

代码：`src/core/verdict.ts:42-54`（占位符 → `verdict.ts:51`；否定/计划仅 `done` → `verdict.ts:52`）。

自写用例（14 项）：

| 正文 | 期望 | 实测 |
| --- | --- | --- |
| `… <摘要>` / `BLOCKED … <原因>` / `改了 <file> 里的逻辑` | 不判定 | 不判定 ✓ |
| `[handoff] DONE <bid> 已修复`（占位符 target） | 不判定 | ✓ |
| `… 未完成，环境起不来` / `… 之前不会触发的问题…` / `… 还没跑回归` | 不判定 | ✓ |
| `… 完成后我会发真正的回执` / `… 接下来补测试` | 不判定 | ✓ |
| `… 已修复并提交 abc1234` | done | ✓ |
| `BLOCKED … 无法完成：接口不存在` | blocked | ✓ |
| `BLOCKED … 完成后我会再试，但依赖缺失` | blocked | ✓ |
| 多行文本，只判命中行 | note = 该行 | `"只这一行"` ✓ |

**对「否定守卫只作用于 DONE」的自决复核：判定合理，无反例被误判为「错误关单」。**

- 理由：`BLOCKED` 行本身就是否定答案，其理由天然含「无法完成」；若对 BLOCKED 也套否定守卫，则「做不了」的回执全部失效（正是本任务要救的那种单）。我实测 BLOCKED 的 `无法完成` / `完成后我会再试` 均正常关单为 `blocked`，符合语义。
- 反方向的越权担忧不成立：`BLOCKED` 与 `DONE` 落库的 `state` 不同，且能发 `BLOCKED` 的只有该单领取人（`applyReceipt` 里 `receiptAllowed`，`chain.ts:227`）；不新增能力。
- 但**同一守卫对 BLOCKED 是有效的**：`<原因>` 占位符仍拦（`verdict.ts:51` 对两种 state 都生效），所以模板回显关不了单。

### 5. R7 显式意图 —— 通过

代码：`src/core/storage.ts:182,191-192`（`declaredKind` / `kindExplicit`）、`src/core/chain.ts:212-225`（`source.explicit && sourceKind !== 'reply'` 直接返回）、`src/index.ts:104-108`（传入 `{kind, explicit}`）、`src/tools/send.ts:76-78`（出站 `legacyAllowed`）。

| 入站 | 结果 |
| --- | --- |
| 无声明 kind（`extractInbound` 判不出） | 正文生效 → `done` ✓ |
| 显式 `kind=note` + 合法行首回执 | 不迁移（仍 `acked`）✓ |
| 显式 `kind=request` + 合法行首回执 | 不迁移 ✓ |
| 显式 `kind=reply` | 迁移 → `done` ✓ |
| 非领取人 + 合法行首回执 | 不迁移 ✓ |

额外核实：出站侧同样只在 `rawKind === ''` 时才走兼容（`send.ts:76-78,157`），显式 `kind:"request"` 即使正文是合法回执也被拒 —— 出入站策略一致。

### 6. R8 `receipt.source` —— **部分满足（存疑）**

代码：`src/core/chain.ts:242-247`、`src/types.ts:256`。

- 行为与实现说明一致：显式 `reply` → `'kind'`；无声明 kind → `'body'`。两种都复现到（`{"source":"kind"}` / `{"source":"body"}`）。
- **但 triage 目的部分落空**：0.1.4 的 `send.ts` 在投递前就把遗留回执归一成 `kind=reply`（`send.ts:159-160`），所以**本任务要救的真实遗留单，落库是 `source:"kind"`**（我的 E2E：`kind=reply explicit=true … source=kind`）。`'body'` 只在「信封无 kind 标签」时出现，而 `dispatch` 永远写 `[reply:…]`；`extractInbound` 还会丢弃既无信封又无 metadata 的纯文本（`storage.ts:176`）。→ 现场无法区分「遗留回执」与「正常 reply」。
- 可选改法见风险清单 #6。

### 7. 回归 / 门禁 —— 通过

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
=== 405/405 checks passed
=== 12/12 checks passed
✓ skills/collab/SKILL.md (collab)
skills ok
EXIT=0
```

（375 + S81 13 + S82 17 = 405，与说明一致。）

**既有用例调整是否掩盖回归 —— 结论：未掩盖，属 R7 的直接后果。**

- S28 / S30c / S36：入站 fixture `kind:'note'` → `kind:'reply'`（`test/handoff-harness.mjs:1250-1256,1454-1460,1636-1660`）。这些用例断言的核心是「回执能闭环」，R7 后 `note` 不再闭环，改 `reply` 是唯一与文档一致的形态；`note` 负例由 S82 新增（`handoff-harness.mjs:4983-4990`）补上，覆盖没有丢。
- S69：`[handoff] DONE <bid>` 的 request 由「拒」改为「普通 request（无 `[handoff]`）拒」（`handoff-harness.mjs:3657-3666`），原「显式 request 仍拒」的能力移到 S81（`4813-4823`），两者都还在测。
- 我另外独立验证了一条**既有语义**：无 kind 回执发给**非受保护**发起方，现在也会被归一成 `kind=reply` 并闭环（`REGRESSION` 用例 `delivered=true kind=reply state=done`）。0.1.3 时它是 `kind=request`；因 R7 需要 reply 才能迁移，该归一化是必要前提，行为变化（thread 状态 `open→answered`）无副作用。

### 8. 安全 —— 通过

- `BUILTIN_PROTECT` 未改：`src/constants.ts` 只动了 `PLUGIN_VERSION`（`0.1.3 → 0.1.4`，与 `package.json:3` 一致，harness 的等值断言通过）。
- `note` / `steer` 永不满足：出站 `shared.ts:91`；入站 `chain.ts:224`；`steer` 见 `shared.ts:101`（且这是额外收紧，不影响 `kind:"reply" + steer` 的既有强制 queue 语义）。
- 无新依赖（`package.json` 仅版本号）；存储仅增字段（`receipt.source`、`InboxMessage.kindExplicit`），键名与 `STORAGE_*` 未动。
- 放行只影响投递，不改记录状态（`shared.ts` 白名单纯读；实测 `acked` 不变），闭环仍由 `applyReceipt` 拥有 —— 与 docs §11.4 现有约定一致。
- 受影响模板核对：`collab_accept` 的 ACCEPT 通知正文含 `完成后回执 [handoff] DONE <bid> <摘要>。`（`src/tools/accept.ts:147,223`，`kind` 默认 `note`）→ R5（中段）+ R6（占位符）+ R7（note）**三重**都关不了单，实测不判定。

### 9. 范围 —— 通过（需注意提交拆分）

- `src/**` 改动仅 8 个文件（constants / chain / storage / verdict / index / tools/send / tools/shared / types），均在允许清单内；`test/handoff-harness.mjs`、`CHANGELOG.md`、`package.json` 同。
- 工作区还有 `docs/collab.md`、`skills/collab/SKILL.md`、`docs/issues/*` 的未提交改动（属主会话/提案回写，内容与本实现无耦合）；`.trellis/tasks/11-18-…/` 为任务产物。
- 未触碰 `muke-pos-app`（只读核对：该仓未出现本任务产生的新文件，`m cp` 为既有 submodule 状态）；未碰归档任务。
- 建议提交时按文件清单分批 `git add`，禁止 `git add -A`。

## 风险清单（均不阻断，按严重度）

1. **【中】R7 的混版本效应**：仍跑 ≤0.1.3 的承接方投递的是 `[request:…]` 信封，0.1.4 接收方按 R7 **不再**由正文迁移，于是「旧版能闭环的单，新版反而不闭环」（我的用例：`kind=request explicit=true state=acked`）。而 docs 已承认 npm 包插件**不会热重载到已运行会话**（`docs/collab.md:251-254`），混版本是现实场景；此时 2h 拉取也未必判得出（承接方若只调了 `collab_send`，其最后一条回答里没有结论语）。
   → 发布说明必须写升级顺序：**先升级承接方（或双方同时重启）**；或后续在入站侧对「行首合法回执 + claim 人」放宽 explicit `request`（与 PRD R7 冲突，需产品拍板）。
2. **【中】R6 对合法 DONE 摘要的误杀**：`VERDICT_NEGATION_RE` / `VERDICT_PENDING_RE` / `VERDICT_ECHO_RE` 作用在整行，实测 `… 已修复，之前不会触发的问题现在正常`、`… 已改，接下来补测试`、`… 改了 <file> 里的逻辑` 都**不关单**（`verdict.ts:51-52`）。语义安全（fail-closed），但会静默留下未闭环单。
   → 建议在 docs/CHANGELOG 明确「摘要里避免否定/计划语与 `<…>`」，或后续把否定判定收窄到「摘要开头」。
3. **【中】文档与实现不一致（发布前必补）**：`docs/collab.md:313-325` 仍写「唯一例外是 `kind:"reply"`…`request`/`note`/`steer` 一律 fail-closed」，未提遗留兼容；`docs/collab.md:338` 的 push 模板与 `§12.5` 也未提 R5 锚定、R7 显式意图、`receipt.source`。当前只有 CHANGELOG 有描述，而 §11.4 是模型/运维实际查阅处。
   → 主会话发布前补 §11.4（遗留回执例外 + 行首锚定 + 显式 kind 不升级），否则下一个承接方仍会按旧文档踩坑。
4. **【低】准入判定比闭环判定宽**：`canReplyToProtected` 用任意位置的 `[handoff]` + `b_…`（`shared.ts:38,99,103`），而闭环要求行首（`verdict.ts:17`）。实测：承接方发 `参考命令：「[handoff] DONE <真实bid> <摘要>」照发即可` → `已投递` 且附「遗留回执…已放行」注记，但记录**仍 `acked`**（`research/check-probe.log` 第 3 段）。不构成越权（发送者必须是领取人），但会让人误以为已闭环。
   → 建议准入复用 `parseReceiptLine` 的 `(state,target)` 作为判定，或在注记里提示「需行首回执才闭环」。
5. **【低】R2 提示命令原样复制不闭环**：提示里的 `text:"[handoff] DONE <bid> <摘要>"` 含字面 `<摘要>`，原样复制 → 投递成功但 R6 判不出（我复现到 `verbatim … cannot close`）。
   → 文案建议写成「把 `<摘要>` 换成真实结论」。
6. **【低】R8 目的部分落空**（见第 6 条证据）：遗留回执落库为 `source:"kind"`。
   → 可选：`send.ts` 走兼容通道时给 metadata 加 `legacy:true`，入站记 `source:'legacy'`；或接受现状（可选需求）。
7. **【低】注释/实现说明有一处不准确**：`verdict.ts:11-17` 与 `research/impl-notes.md:58` 称 `^[ \t]*` 允许「列表符后的行首」，实测 `- [handoff] DONE b_x ok` **不匹配**（`-` 不在 `[ \t]`）。行为符合 R5，只是注释表述需修正。
8. **【低／UX】普通回执也会出现「遗留回执…放行」注记**：`send.ts:163-167` 对所有命中记录的回执（含非受保护发起方）都加该注，措辞暗示发生过护栏放行（`shared.ts:328-331` 的“白名单放行”注记才是 guard 专属）。实测非受保护单的输出含该注。
   → 建议措辞中性化（如「无 kind 的限界回执已按 kind=reply 投递」）。
9. **【提示】接管模板仍教不带 `kind` 的写法**：`verdict.ts:284-285`（`handoffActions`）与 `docs/collab.md:338`。R1 使其可用，所以新单同样是「遗留形态」；这与 R7「靠 kind 判意图」的方向长期相反，未来若收紧 R1 会再炸一次。
   → 后续迭代可在模板里加 `kind:"reply"`（我推演：无 threadID 会先降级为 request，随后 `boundedReply` 再置回 reply，可闭环），但需单独回归验证。

## 门禁原始输出（摘）

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
EXIT=0
…
  ✓ S82 a mid-sentence [handoff] quotation with the real bid never closes (R5) — claimed
  ✓ S82 an explicit kind=note with a valid receipt line never moves the record (R7) — claimed
[collab] handoff b_aaaa0000000000e4 → done
  ✓ S82 the same receipt with no kind at all does close it (R7 legacy) — done
[collab] handoff b_aaaa0000000000e8 → done
  ✓ S82 … receipt.source=kind, not body — {"from":"ses_a_target",…,"source":"kind"}
=== 405/405 checks passed
=== 12/12 checks passed
✓ skills/collab/SKILL.md (collab)
skills ok
```

自写假 ctx 复现（49 项）见 `research/check-independent.log`；定向探测（准入 vs 闭环、注记措辞、`- ` 列表符）见 `research/check-probe.log`。
复现脚本（不在仓库内）：`/tmp/opencode/legacy-check.mjs`、`/tmp/opencode/legacy-probe.mjs`。

## 是否可提交

**可以提交。** 未发现阻断缺陷；R1/R2/R5/R7 与 prd 逐字对应，R6/R8 有实现方自决（R6 合理、R8 部分满足）。

发布前建议主会话按顺序收口：

1. 补 `docs/collab.md` §11.4 / §12.5：遗留回执例外、行首锚定、显式 `kind` 不升级、`receipt.source`（风险 #3）。
2. 发布说明写**升级顺序**（先承接方或双方同时重启），并保留「拉取提取可兜底」的说明（风险 #1）。
3. 可选（不阻断）：#5 提示文案、#7 注释、#8 注记措辞；#4/#6 建议开后续任务。
4. 提交按文件清单分批 `git add`（`src/…` 8 个 + `test/handoff-harness.mjs` + `CHANGELOG.md` + `package.json`），不要把 `docs/collab.md`、`skills/**` 等他人改动混进同一提交。
