# 独立复核报告：跨 thread 去重（target 维度）

- 任务：`.trellis/tasks/11-19-collab-dedupe-target`
- 复核角色：check agent（冷上下文，**只审不改**；除本报告外未改动仓库任何文件）
- 复核对象：`src/tools/{shared,send,reply}.ts`、`src/types.ts`、`test/handoff-harness.mjs`（S101）、
  `docs/collab.md`、`README.md`、`skills/collab/SKILL.md`、`CHANGELOG.md`（均未提交）
- 复核依据：`prd.md` R1–R5、`design.md` §1–§6、`implement.md`；`research/impl-notes.md` 仅作线索

---

## 结论：**可提交（no blocker）**

- 功能面 8 项必查全部**通过**（含实现方自述的 protect 顺序偏差——实测「拒绝优先」成立，且不写索引）；
- 必跑门禁全绿：`805 + 12 + 20 + 50 + 49 + 47 + 17`、`tsc --noEmit` 无输出、`skills ok`；
- 两组变异复现实现方数字（797/805、802/805），S101 的 17 条断言不是自证；既有断言**零删除**
  （`test/handoff-harness.mjs` diff = 298 增 / 0 删）；
- 余下问题只有 **3 条 P3 文案/文档措辞** + 4 条残余风险，均不影响行为与验收，建议随后补一次文档小改。

---

## 逐条结果

### 1. 核心场景（3 thread 同文只投 1 次，send / reply 两条路径）—— **通过**

- 实现：`src/tools/shared.ts:326` 进程内 `targetSendMemo`；`:328` `targetSendKey(targetSid, norm(body))`；
  `:332` `rememberTargetSend`；`:489-503` `findDuplicateSend` 第 ④ 级；`:630-660` 命中回执。
- **自写探针**（`/tmp/opencode/probe/s102.mjs`，独立于 S101）：
  - S102a `collab_send`：`ses_ccc` + `t_s102_1/2/3` 同文 → **1 次投递**，后两次回执
    `未重复投递: 目标 ses_ccc 在 60s 内已有同文（target 维度去重），已在 thread t_s102_1 发过同文；…`
    且含 `force:true` / `dedupeOverridden` 提示；被拦的两条**未生成 thread 记录**；
    空白折叠变体（多空格 + 前后空白）在 `t_s102_4` 同样被拦。
  - S102b `collab_reply`：`t_s102_re1` / `t_s102_re2` 同一句回执 → 1 次投递，第 2 条
    `已在 thread t_s102_re1 发过同文`，`force:true` 放行并标 `dedupeOverridden`。
- 官方 S101a / S101k 亦通过（`verify-final.log:2571` 附近）。

### 2. `force` —— **通过**

- 入参：`src/tools/send.ts:79`、`src/tools/reply.ts:43`；透传 `send.ts:177,261`、`reply.ts:108`；
  `dispatch` 签名 `shared.ts:546`（`dedupeForced`）、`:558-563`（`!force` 才查重）。
- S102b：3 发 3 投，第 2/3 条回执含 `dedupeOverridden`。
- S102c：`force:true` + `bid` → `dedupeOverriddenAt=1795071099545` 写入，
  `state=acked` / `claim` / `receipt` 与操作前**逐字符相同**（`src/tools/shared.ts:727-738`，
  `writeBroadcast` 同步读-合并-写，中间无 await → 无并发覆盖窗口）；
  **非 force 命中时零写入**（prompt 计数 +1 不变、记录快照不变、无 thread 记录）。

### 3. 不误杀 —— **通过（行为）**，`逐字` 一说 **存疑（仅文案）**

- S102d：59s 仍拦、61s 放行（`Date.now` 前跳，不真等）。
- S102e：不同 target（`ses_ccc` / `ses_ddd`）同文都投；同 target 改一处措辞照投。
- S102f：`dedupeWindowMs:0` → 两次（含 `force:true`）全投，且**无** `dedupeOverridden` 标记
  （`dedupeForced` 要求窗口 > 0，见 `shared.ts:546`，与 R4「0 关闭全部」一致）。
- 同 thread 同文：S95e 原 3 条断言未改且全绿；实测首行仍为
  `未重复投递: thread t_s101_h 在 60s 内已有同文（去重窗口），本次未投递、也未追加回复。`
- **存疑点**：同 thread 命中时的**第 4 行提示语**变了——0.6.0 为
  `…确实要再发一次：改一处措辞 / 换 threadID，或把 collab.json 的 dedupeWindowMs 设为 0 关闭去重。`
  现在为 `…确实要再发一次：force:true（强制投递，回执标注 dedupeOverridden）/ 改一处措辞 / 换 threadID / 把 … 设为 0…`
  （`shared.ts:649-651`）。行为一致（仍只投一次、仍不写 thread），但
  `docs/collab.md:665`「thread 级命中沿用 0.6.0 文案」与 `CHANGELOG.md`「同 thread 同文仍是 0.6.0 的文案」
  严格说**不准确**（首行/结构不变，提示行新增 force 选项）。建议改措辞，不建议改实现（新增 force 提示是 R2/R3 的自然延伸）。

### 4. `protect` 顺序（实现方自述的偏差）—— **通过**

- 代码：`shared.ts:558-563` **只读查询**在前，`:569` 护栏拒绝在后，`:630` 才用查询结果；
  拒绝路径（`:600-628`）直接 `throw`，不写索引（写索引只在投递成功后 `:725`）。
- 自写场景（S102h，3 条断言全绿）：
  1. 先用**限界回执**把正文合法投进受保护发起方 `ses_s102prot1`（索引写下）→ `已投递`，1 prompt；
  2. 同一句改用 `kind:"note"` 再发 → **仍返回护栏错误**
     `拒绝投递：目标 ses_s102prot1 本身在 protect 名单内…未发送任何内容。`，
     prompt 数不变，回执**不含**「已发过同文 / 未重复投递」；
  3. 新受保护目标 `ses_s102prot2`：先普通 push 被拒 → 紧接着同一句的**限界回执仍能投出**（`已投递`）
     ⇒ 被拒的那次**没有写索引**。
- 与 PRD/design 的字面关系：PRD 无顺序要求；`design.md §4` 写「去重先于投递判定，命中即不投，不产生队列项」，
  实现满足（查询在前、命中即不投）；若把 `design.md §5`/任务书的「去重先于护栏判定」读成「去重结果先于拒绝返回」，
  则与实现不符。**建议在 `design.md` 补一行「查询在前、拒绝优先（refusal wins）」**，把 impl-notes §5 的偏差固化为设计记录；
  这一顺序是对的：字面实现会把 `fail-closed` 错误换成投递历史提示（= 变相放宽），且会打红 S69/S81。
  `docs/collab.md:669-671` 已按实际语义写清「拒绝仍然优先」，与实现一致。

### 5. 索引边界 —— **通过**

- `shared.ts:326` 进程内 `Map`，`:332-349` 写入后重插 + `while (size > DEDUPE_MEMO_LIMIT) delete(最旧)`
  （`constants.ts:336` `DEDUPE_MEMO_LIMIT=200`）。
- S102g：先投 A/B 两条，再灌 260 条不同正文，回发 A → **`已投递`**（A 已被挤出）⇒ 索引有界，非无限增长。
- 文档写明进程内语义：`docs/collab.md:665`「④ 进程内 target memo（`{at, threadID, bid?}`，重载即清空）」、
  `docs/collab.md:676`「跨机器不去重」；CHANGELOG「为什么用进程内 Map」。**跨重启失效符合 design §2 的取舍**。

### 6. 回归与范围 —— **通过**

`pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs` → `EXIT=0`

```
=== 805/805 checks passed
=== 12/12 checks passed
=== 20/20 board checks passed
=== 50/50 checks passed
=== 49/49 checks passed
=== 47/47 checks passed
=== 17/17 panel checks passed
skills ok
$ tsc --noEmit            (无输出)
```

- 工具数仍 **20**（S98 / R8 断言列出全部 20 个）；
- 版本 **0.6.0**（`src/constants.ts:380` `PLUGIN_VERSION`、`package.json`）；
- `package.json` / `pnpm-lock.yaml` **无改动** ⇒ 无新依赖；`git status` 无 `dist/` 变更。

### 7. 测试真实性 —— **通过**

- 我自己做两组变异（改完立即用备份 `cp` 还原并校验 sha256，未用 `git restore`，避免误伤未提交实现）：

  | 变异 | 改法 | 结果 |
  | --- | --- | --- |
  | ① target key → threadID | `shared.ts:493` `targetSendKey(to, text)` → `targetSendKey(thread, text)` | **797/805**，8 条 S101 红（跨 thread 四条、命中零写入、59s/61s、reply 跨 thread） |
  | ② 去掉 `!force` | `shared.ts:559` `if (confirmed && dedupeWindowMs > 0 && !force)` → 去掉 `!force` | **802/805**，3 条红（S101b ×2、S101k force） |

- 两组数字与 `research/impl-notes.md` §6 完全一致；还原后 sha256 回到
  `ebaa35a1cf591ae489ba8f2e5272b44393c886ab005ebd54567204e72910165b`，再跑全量仍 805/805。
- S101 共 **17** 条 `expect(`（`test/handoff-harness.mjs:10244-10540`），断言全部读真实产物
  （`prompts` 计数、`store` 里的 thread 记录、`bcRead` 的记录快照、`Date.now` 前跳），无「自证式」断言
  （例如只断言回执字符串包含自己刚写的字段）。
- 既有断言未弱化：harness diff **298 增 / 0 删**；S95e 的去重 3 条原样保留。

### 8. 文档 —— **通过（1 处措辞需修）**

| 文件 | 与实现一致性 |
| --- | --- |
| `docs/collab.md` §11.9.4（`:654-676`） | 键 / 窗口 / 四个判据来源 / 命中零写入 / force 语义 / 顺序与护栏 / 回滚 → 与代码一致；**唯一不准确**：`:665`「thread 级命中沿用 0.6.0 文案」（见第 3 条） |
| `docs/collab.md` §11.2（`:265-266`） | `collab_send` / `collab_reply` 入参都加了 `force?` ✓ |
| `docs/collab.md` §11.4 配置段（`:335-338`） | 「同一 target（或同一 thread）…`force:true`」✓ |
| `README.md`（`:105`、`:242`、`:278`、`:308`） | 正文/配置表/测试计数 805 / harness 追加 S101 说明 ✓ |
| `skills/collab/SKILL.md`（`:31-32`、`:81-85`） | 工具表 `force?` + 去重小节（含 `dedupeOverridden` / `dedupeOverriddenAt` / 预览不消耗）✓ |
| `CHANGELOG.md`（0.7.0 Unreleased） | 新增/变更/测试/文档四段齐；「同 thread 同文仍是 0.6.0 的文案」同第 3 条措辞问题；版本号未改 ✓ |

> 附注：本仓打包布局下 harness 的 `repo` 指向 `/data`（`test/handoff-harness.mjs:249`），S38/S43 的文档断言
> 平时会**被跳过**（`verify-final.log:665`、`:737`）。我在临时副本里把 `repo` 指到 `/data/project/collab`
> 补跑了这两组：S43 五条全过；S38「guide index 列出 cross-workspace-collab-guide.md」失败——
> `.trellis/spec/guides/index.md` 里确实没有该条目。**与本任务无关、平时不执行**，列为范围外 P3。

---

## 必跑原始输出（关键行）

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
...
=== 805/805 checks passed
=== 12/12 checks passed
=== 20/20 board checks passed
=== 50/50 checks passed
=== 49/49 checks passed
=== 47/47 checks passed
=== 17/17 panel checks passed
skills ok
EXIT=0
```

独立探针（临时副本 `/tmp/opencode/probe/harness-all.mjs` = 官方 harness + 自写 S102/S103/S104；827+3 条断言）：

```
--- S102a send 3 threads
已投递 → ses_ccc …
未重复投递: 目标 ses_ccc 在 60s 内已有同文（target 维度去重），已在 thread t_s102_1 发过同文；本次未投递、也未追加回复。
未重复投递: …
  ✓ S102a collab_send: same target + 3 threads + same body → exactly 1 delivery — 1 deliveries
  ✓ S102a repeats name the earlier thread (已在 thread t_s102_1 发过同文) and offer force:true
  ✓ S102a suppressed sends wrote no thread record — false / false
  ✓ S102a whitespace-folded body is the same message across threads
--- S102b reply 2 threads
  ✓ S102b collab_reply: target-deduped across threads, force delivers — 2 deliveries
  ✓ S102c a target-level hit changes neither the record nor the prompt count — 1 delivery / record unchanged
  ✓ S102c force + bid: delivered, receipt marked, record stamped, state/claim/receipt intact — dedupeOverriddenAt=1795071099545 / state=acked
  ✓ S102d 59s later still suppressed, 61s later deliverable again
  ✓ S102e different target and different body are both delivered — 3 deliveries
  ✓ S102f dedupeWindowMs:0 delivers every copy (force included, unmarked) — 3 deliveries
  ✓ S102g an entry pushed past DEDUPE_MEMO_LIMIT is evicted (index is bounded) — 已投递
  ✓ S102h a bounded receipt still reaches the protected requester (index written once) — 已投递
  ✓ S102h protected target + known duplicate still returns the guard refusal (refusal wins), 0 prompts
      — 拒绝投递：目标 ses_s102prot1 本身在 protect 名单内（… protect + 内置硬名单…）。未发送任何内容。
  ✓ S102h a refused push writes no target index entry (the bounded receipt of the same body still goes out)
--- S103a no threadID
  ✓ S103a a send without threadID is still target-deduped (…已在 thread t_mwn6zh1p_ma7c 发过同文)
--- S103b two senders
  ✓ S103b the target key ignores the sender (two senders, same body → 1 delivery within the window)
--- S104a force without a duplicate
  ✓ S104a force on a first send is delivered and still marked dedupeOverridden (per R3)
      — 注: dedupeOverridden: 本次为 force:true 强制投递（去重窗口内已有同文仍发送；thread 与 target 两级判定都跳过）。
  ✓ S104b force + bid on a first send stamps dedupeOverriddenAt too (R3 letter; no duplicate existed)
=== 829/830 checks passed     # 唯一失败 = 上述范围外 S38（平时被跳过）
```

变异原始输出（官方 harness）：

```
# ① targetSendKey(to,…) → targetSendKey(thread,…)
✗ S101 same target + same body on 3 threads (<60s) is delivered exactly once — 3 deliveries
✗ S101 … and both repeats say where the earlier copy went
✗ S101 … the repeat receipt offers the override (force:true) and marks it target-level
✗ S101 … and the suppressed sends created no thread record
✗ S101 a target-level hit writes nothing at all
✗ S101 59s later the same body is still suppressed
✗ S101 61s later the same body is deliverable again
✗ S101 collab_reply is target-deduped across threads, then force delivers it
=== 797/805 checks passed

# ② 去掉 `!force`
✗ S101 force:true delivers every repeat (3 deliveries, none suppressed) — 1 deliveries
✗ S101 force + bid stamps dedupeOverriddenAt on the record — dedupeOverriddenAt=undefined
✗ S101 collab_reply is target-deduped across threads, then force delivers it — 1 deliveries
=== 802/805 checks passed
```

---

## 需修（P3，均可随后小改，不阻塞提交）

1. `docs/collab.md:665`「thread 级命中沿用 0.6.0 文案」→ 建议改「首行与结构不变，末尾提示新增 `force:true` 选项」；
   `CHANGELOG.md`（0.7.0 Fixed 段）「同 thread 同文仍是 0.6.0 的文案」同改（实测提示行变了，见第 3 条）。
2. `design.md §5` + 任务书的「去重先于护栏判定」建议补成「去重**查询**在前、**拒绝优先**」（实现与文档 `docs/collab.md:669-671` 已经是这么写的）。
3. `src/tools/shared.ts:731-733`：`force:true` 但**窗口内本来没有同文**时，回执仍写「去重窗口内已有同文仍发送」
   （S104a 证据）。R3 字面要求「force 即标注」，行为可保留；建议把文案改成中性表述
   （如「`force:true` 已跳过去重判定」），避免对事实的错误陈述。

（次要）`DuplicateSend.bid`（`shared.ts:265-268`、`:500`）只写不读，回执未使用——可留作后续
`collab_status` 关联，或删掉以免误导。

---

## 风险清单（残余，均已文档化或不可达）

| 级别 | 风险 | 依据 / 缓解 |
| --- | --- | --- |
| P2 | **同 target 键忽略发送方**：`ses_aaa` 与 `ses_ddd` 在 60s 内向 `ses_ccc` 发同一句 → 只投 1 次（S103b 实测） | design §2 明确 key = target + body；若未来出现「两个请求方问同一句话」的常态场景，需要把 `from` 并入键或提供按 `threadID` 的例外 |
| P3 | 进程内 Map **跨重启/重载即清空**，多实例各自去重 | design §2 的取舍；`docs/collab.md:665,676` 已写明 |
| P3 | 无 threadID 的 send 现在也会被 target 维度拦（0.6.0 文档曾说「换 thread 即可再发」） | 属 R1 预期（S103a）；`docs/collab.md:676` 已改为「`force:true` 即可」，旧说法已删除 |
| P3 | `collab_handoff` 共用 `dispatch`（`src/tools/handoff.ts:214`），其正文会写入 target 索引；理论上命中会「不投递但记录照写」 | 实际不可达：正文含新 bid + 新 threadID，且 handoff 先用 bid 幂等短路（`handoff.ts:171-181`） |
| P3 | 强制投递会给记录 bump `updatedAt`（`writeBroadcast` 统一设置） | 只影响 7 天保留判定的时间戳，不改 `state`；S101d/S102c 证明 `state/claim/receipt` 不变 |
| 范围外 | `.trellis/spec/guides/index.md` 未列 `cross-workspace-collab-guide.md`，S38 若被执行会红 | 平时被 `hasRepoDocs` 跳过；与本任务无关，交 owner 决定是否补 |

---

## 复现方式

```bash
# 1) 官方门禁（仓库内，无改动）
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs

# 2) 独立探针（临时目录，不写仓库）
cp test/handoff-harness.mjs /tmp/opencode/probe/harness.mjs   # 并把 repo/dist/package/triage 路径改成绝对路径
#   再把 /tmp/opencode/probe/s102.mjs + s103.mjs + s104.mjs 插到 `const failed = checks.filter(` 之前
node /tmp/opencode/probe/harness-all.mjs
```

复核期间仓库状态与复核前一致（`src/tools/shared.ts` sha256 = `ebaa35a1…10165b`，`git status` 仅实现方改动；
未 commit / 未 add / 未 push、未重启任何服务、未接触真实会话与用户 mac）。
