# 实现记录：契约决策记录（`collab_decisions`）

任务：`.trellis/tasks/11-19-collab-decisions`（0.7.0 未发布窗口，工具 21 → 22，版本号未动）

## 1. 落盘位置（为什么不是新 core 文件）

硬约束只允许改 `src/types.ts`、`src/tools/decisions.ts`(新)、`src/tools/{index,status,list}.ts`、
`src/core/verdict.ts`。纯逻辑（上限 / 校验 / 覆盖合并 / 权限 / 注入行）放在 `src/core/verdict.ts`——
那里已经是 `blocked`（同为「只写显示字段、不动 state」）的家，`tools/*` → `core/*` 的依赖方向不变。

| 文件 | 改动 |
| --- | --- |
| `src/types.ts` | `BroadcastDecision { id, decision, rationale?, at, by }`、`DecisionSpec`、`BroadcastRecord.decisions?` |
| `src/core/verdict.ts` | 常量（20 / 10 / 40 / 200 / 400 / 展示 3 / rationale 截 80）、`normalizeDecisionItems`、`decisionHistoryOf`、`mergeDecisions`、`canWriteDecisions`、`decisionInjectionLines`；`takeoverBody` 加一行；`blockedText` → `sanitizeInline`（复用同一清洗，重命名） |
| `src/tools/decisions.ts` | 新工具（校验 → 权限 → 上限 → 预览/写入；写入前 re-read 再判一次） |
| `src/tools/index.ts` | 注册在 `collab_followup` 之后（21 → 22） |
| `src/tools/status.ts` | `决策 N 条` + 最近 3 条（rationale 截 80）+ 描述 |
| `src/tools/list.ts` | 行尾 ` decisions=N`（仅 N>0） |
| `test/handoff-harness.mjs` | 新增 S106（24 条）；S98/S102/S105h 三处工具面 21 → 22 |
| `test/readonly-default.mjs` | 工具面顺序加 `collab_decisions`、标题 21 → 22 |
| `docs/collab.md` / `README.md` / `skills/collab/SKILL.md` / `CHANGELOG.md` | 工具表 + §11.19 一节 + 兼容说明 |

## 2. 关键语义

- **权限**：`canWriteDecisions` 只认 `from.sid` / `claim.by`；**fail-closed**（两者都没有 = 谁都不能写）。
  与 `canWriteBlocked`（四类参与方、无身份 fail-open）刻意不同：决策是契约，不是批注。
- **覆盖**：`mergeDecisions` 按 `id` 先删后 push（`at`/`by` 取本次，位置到末尾）；同一次调用里重复 `id` 也合并成一条（后者胜）。
- **上限 20**：合并后长度 > 20 → 抛 `invalid`（可读拒绝），**不 slice 掉最旧的**；`decisionHistoryOf`
  读取时只做容忍（desensitize + 去重 + `slice(-20)`），不会让写入路径的「拒绝」变成静默淘汰。
- **写入只碰 `decisions`**：`writeBroadcast({ ...fresh, decisions })`；`state/claim/receipt/replies/blocked` 全不动
  （`updatedAt` 由 `writeBroadcast` 自身刷新，属于任何写记录的固有行为）。
- **注入只一行**：`decisionInjectionLines` 返回单元素数组 `本单决策 N 条（collab_status { bid:"…" } 查看）`，不展开正文。

## 3. 验收（`pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs`）

```
=== 870/870 checks passed          (baseline 846 + S106 24 条)
=== 12/12 checks passed            (readonly-default)
=== 20/20 board checks passed
=== 50/50 checks passed            (snapshot-shape)
=== 49/49 checks passed            (tui-render)
=== 47/47 checks passed            (gui-entry)
=== 17/17 panel checks passed      (gui-panel)
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
```

S106 原始输出（节选，全部 ✓）：

```
✓ S106 写 3 条决策：记录 decisions 3 条，回执标明「决策 3 条」且不投递 — 3 / 已写入决策：b_dd06000000001061 决策 3 条（本次新增 3，覆盖 0；上限 20）
✓ S106 state / claim / receipt / replies 前后完全一致（决策是纯展示字段） — {…acked / claim / receipt / replies…} / 同一串
✓ S106 collab_status：决策 3 条 + 最近 3 条 —   决策 3 条: |     - exit-code: 退出码用 3（不是 2）（D-064 与 CLI 约定一致）
✓ S106 collab_list 行尾 decisions=3 — … attempts=0 decisions=3
✓ S106 重复 id 覆盖：仍 3 条、id 不重复、内容取最新，回执标明「覆盖 1」 — room-order:… / assert-last-frame:… / exit-code:退出码用 3（覆盖：以 CLI 契约为准）
✓ S106 覆盖后 status 只显示最新内容（旧答案不再出现），计数仍是 3 —     - exit-code: 退出码用 3（覆盖：以 CLI 契约为准）
✓ S106 控制字符剥成空格 — {"id":"one line","decision":"换行 也要折叠",…}
✓ S106 items 为空 / 11 条 / id 41 字 / decision 201 字 / rationale 401 字 → 可读拒绝（5 条）
✓ S106 五类非法输入都是可读拒绝：0 写入（记录逐字不变） — unchanged
✓ S106 第三方写 → 拒绝（比 blocked 更严） — 拒绝写入：当前会话 ses_s106third 既不是 … 的发起方（from.sid=ses_s106me），也不是承接方（claim.by=ses_s106to）…
✓ S106 第三方拒绝后 0 写入（记录逐字不变） — unchanged
✓ S106 confirm:false 只预览（「未写入」），记录逐字不变 — unchanged
✓ S106 承接方注入只有一行计数（含 collab_status 指路，不展开正文） — 本单决策 1 条（collab_status { bid:"b_567f3bff31ebe763" } 查看） / 1 prompt(s)
✓ S106 无 decisions：status 不出现「决策 N 条」行、collab_list 行尾没有 decisions= 
✓ S106 上限 20：从已有条数写满 20（分批 ≤10），一条也不淘汰 — 4 → 20 条
✓ S106 第 21 条（新 id）→ 可读拒绝，0 写入 — 拒绝写入：… 写入后会到 21 条决策，超过上限 20（本次新增 1 条…）
✓ S106 超限拒绝后记录逐字不变（不静默淘汰旧决策） — 20 条 / unchanged
✓ S106 满 20 条时覆盖已有 id 仍然可以（覆盖不增加条数） — 20 条
✓ S106 collab_decisions 注册一次，items 是数组且声明 id/decision/rationale 与界值 — ["bid","items","confirm"]
```

## 4. 变异验证（原始失败输出，改坏 → 跑 → 按备份还原）

### M1：权限放宽成任意会话（`canWriteDecisions` 直接 `return true`）

```
  ✗ S106 第三方写 → 拒绝（比 blocked 更严：asked / origin 也不行） — 没有报错: 已写入决策：b_dd06000000001061 决策 5 条（本次新增 1，覆盖 0；上限 20） - third: 第三方的决定 未投递、未改 state / claim / receipt / replies（state=acked）
  ✗ S106 第三方拒绝后 0 写入（记录逐字不变） — CHANGED
=== 868/870 checks passed
FAIL: S106 第三方写 → 拒绝（比 blocked 更严：asked / origin 也不行）
FAIL: S106 第三方拒绝后 0 写入（记录逐字不变）
```

→ 2 条断言真的会失败（第三方把记录改了 5 条）。

### M2：重复 id 追加而非覆盖（`mergeDecisions` 不再 `splice` 旧条目）

```
  ✗ S106 重复 id 覆盖：仍 3 条、id 不重复、内容取最新，回执标明「覆盖 1」 — exit-code:退出码用 3（不是 2） / room-order:room:order 是纯事件型，不参与状态断言 / assert-last-frame:断言看状态机最终帧，不看中间帧 / exit-code:退出码用 3（覆盖：以 CLI 契约为准）
ValidationError: 拒绝写入：b_dd06000000001061 写入后会到 21 条决策，超过上限 20（本次新增 0 条；覆盖已有 id 不增加条数）。未写入任何内容（不静默淘汰旧决策）。
```

→ 覆盖用例显示 4 条（重复 `exit-code`）并失败；后续「写满 20」因重复条目提前触发上限拒绝（同一根因，直接中止）。

还原方式：`cp` 备份回 `src/core/verdict.ts` → `pnpm build` → 复跑 **870/870**（上方第 3 节）。

## 5. 兼容 / 回滚

- 旧记录没有 `decisions`：`status` / `list` / 注入三处输出不多一个字（S106g 用真实旧形状 fixture 断言）。
- 回滚：`git restore -- src/types.ts src/core/verdict.ts src/tools/{decisions,index,status,list}.ts`；
  旧记录不受影响（已写的 `decisions` 只是不再展示）。
