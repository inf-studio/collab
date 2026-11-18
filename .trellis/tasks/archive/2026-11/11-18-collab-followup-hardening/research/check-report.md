# 独立复核报告：followUps 硬化（F1–F3，0.3.1）

> 任务：`.trellis/tasks/11-18-collab-followup-hardening`
> 复核方式：冷上下文只读复核。**未改任何实现文件、未 commit/add/push、未重启任何服务。**
> 实现方 `research/impl-notes.md` 仅作线索；1/3/5 三项均用**自写假 ctx**（`/tmp/opencode/check-followup-independent.mjs`）
> 独立复现，未采信既有断言。

## 结论

**通过（可提交）。** R1–R5 与 4 条验收标准全部落实；`build / typecheck / test(526+12+18) / check-skill` 全绿；
既有 506 项无删改（`test/handoff-harness.mjs` +227/−0）。发现 3 条 P3 级（非阻塞）语义/文案瑕疵，1 条 P3 防御性建议，
均不影响本次验收，建议记录后由 owner 决定是否在本补丁或下一补丁处理。

| 必查项 | 结论 |
| --- | --- |
| 1. F1 标记时机 | **通过** |
| 2. F1 边界（keys/line 一致、整单无效不占位） | **通过** |
| 3. F2 无效路径（不 stamp / 汇总去重 / 可恢复 / 不回显路径） | **通过** |
| 4. F2 写入侧 | **通过** |
| 5. F3 规范化（正例 + 7 类反例） | **通过** |
| 6. 回归（526+12+18 / check-skill / 既有 506 零删改） | **通过** |
| 7. 接口（FollowUpHintResult 仅内部） | **通过** |
| 8. 范围/安全（允许清单 / BUILTIN_PROTECT / 无新依赖） | **通过** |

---

## 1. F1 标记时机 —— 通过

**代码**
- `src/core/followup.ts:218-236`：`nextFollowUpHint` 只做查询，函数体内**没有** `markFollowUpSeen`
  （唯一写入点 `src/core/followup.ts:189`，调用方只有 hook）。
- `src/core/chain.ts:697-712`：`followUpHints` 返回 `{ lines, keys }`，不再写 seen。
- `src/hooks/context.ts:241-247`：`event.system.push({...})` **之后**才
  `if (chainPart.keys.length) await markFollowUpSeen(deps.ctx, event.sessionID, chainPart.keys)`。
  `system` 在宿主契约里是普通数组（`src/types.ts:155-160`），`push` 同步抛错即跳过标记。

**自写假 ctx 复现**（`Object.freeze([])` 让 `push` 抛错）：

```
PASS  F1 hook never throws when system.push fails
PASS  F1 nothing injected on the throwing request
PASS  F1 throwing push stamps nothing  — []
PASS  F1 next request re-renders the pending hint  — - b_aaaa00000000f101 已闭环，提案 docs/issues/a.md 有追加结论（06:13:20），请读取文件
PASS  F1 stamp happens exactly once, after the successful push  — ["ses_check_req:b_aaaa00000000f101:1700000000111"]
PASS  F1 third request no longer shows it  — (empty)
```

即：push 抛错 → 未 stamp（`collab/followup-seen/<sid>` 为空）→ 下一轮仍提示 → 再下一轮消失。
另测「push 成功但 stamp 写入抛错」（`storage.set` 抛）：hook 不抛、下轮重复提示一次（fail-safe，不是丢失），
与 R1「注入成功后才标记」一致：

```
PROBE1 push-block present: true | hook threw: false
PROBE1 hint repeated next turn (duplicate, fail-safe): true
PROBE1 then stamped: true
```

## 2. F1 边界 —— 通过

**同一次注入多条 followUps（每会话每次 ≤1 行）**：`src/core/chain.ts:701-710`
命中第一条 `hint` 即 `return`；`keys` 只有该条（`src/core/followup.ts:230-233`）。

自写假 ctx：同单两条（旧条路径无效、新条有效）→ 只渲染新条，stamp 只有新条的 key：

```
PASS  F1/F2 valid append beside an invalid one renders, and the key is the rendered one
      — - b_aaaa00000000f102 已闭环，提案 docs/issues/b.md … | seen=[…f101…, …f102:…202]
PASS  F2 neither the rendered request nor the stamp ever names the unusable entry
      — ["ses_check_req:b_aaaa00000000f101:1700000000111","ses_check_req:b_aaaa00000000f102:1700000000202"]
```

**整单无效不占唯一提示位**（单独探针，确保 readdir 把「全无效」排在前面）：

```
readdir order: b_aaaa00000000e201.json,b_aaaa00000000e202.json   # e201 = 全无效
rendered lines: - b_aaaa00000000e202 已闭环，提案 docs/issues/ok.md 有追加结论（06:13:20），请读取文件
good rendered: true | bad rendered: false | bad stamped: false
```

## 3. F2 无效路径 —— 通过

**不 stamp**：`src/core/followup.ts:229` `if (!check.ok) continue;`（旧实现 `skipped.push(key)` 已删除）。
**统计**：`invalidFollowUps` `:245-255`；`takeInvalidFollowUpNotice` `:271-287`（键 `collab/followup-invalid/<sid>`，
`:257-259`），按 `${bid}:${at}` 去重、排序后与上次集合比较，**集合变化才 true**；存储失败 true（fail-visible）。
**输出**：`invalidFollowUpLines` `:290-300` 只有 `bid` + `fmtTime(at)`，不含路径。
**接入点**：`src/tools/list.ts:32-44`（gate `:41-42`）、`:78-92`（早返回分支之前）、`:225`（正常列表尾部）。

自写假 ctx（独立 session，避免与 F1 场景串味）：

```
PASS  F2 collab_list reports the count + bid + time
      — 1 条 followUp 因路径无效未渲染（…）: | - b_aaaa00000000f105 追加于 06:13:20 → issuePath 未通过校验
PASS  F2 the summary never echoes the rejected path — (clean)
PASS  F2 unchanged set → no second notice
PASS  F2 a changed set → re-reported with the new count — 2 条 followUp 因路径无效未渲染…
PASS  F2 a formerly unusable entry renders once the file exists (not lost forever)
      — - b_aaaa00000000f105 已闭环，提案 docs/issues/secret-name.md 有追加结论（06:13:20），请读取文件
PASS  F2 … and after rendering it is stamped (no repeat)
PASS  F2 the backlog count shrinks once the file exists — 1 条 followUp 因路径无效未渲染…
PASS  F2 notice storage is per-session — {"sigs":["b_aaaa00000000f106:1700000000601"],"at":…}
```

「补建文件后恢复提示」直接证明无效条目未被永久丢弃（旧实现会在首次渲染时把 key stamp 掉）。

## 4. F2 写入侧 —— 通过

- `src/tools/followup.ts:120-125`：显式 `issuePath` 且 sanitize 后为空 → `invalid('…issuePath 为空…')`，**不再回退**记录自带路径。
- `:126`：省略参数时仍回退记录提案（正向对照）。
- `:156-170`：写成功后 `invalidFollowUps(written)`，只报条数、不回显路径。

自写假 ctx：

```
PASS  F2 write side: whitespace/control issuePath is refused, nothing stored
      — 拒绝追加：issuePath 为空（只含空白/控制字符）。要追加到记录自带的提案请省略该参数。
PASS  F2 write side: omitted issuePath still defaults to the record proposal — [{…"issuePath":"docs/issues/a.md"…}]
```

独立探针（本单已有 1 条失效旧追加时再写一条）：

```
注意：本单另有 1 条 followUp 路径无效，不会渲染（未标记；修好路径后下一轮会再试）。
--- leaks vanished path? false
```

## 5. F3 路径规范化 —— 通过

`src/core/followup.ts:86-92`：`isAbsolute` 先拒 → `split('/').filter(p => p && p !== '.')` → `parts.includes('..')` 只拒 `..` →
`parts.join('/')` 再走原正则；`:100-122` 的前缀/非软链/realpath 校验**未放宽**。

自写假 ctx（正例 3、反例 7）：

```
PASS  F3 ./docs/issues/x.md accepted and stored normalised — 已登记闭环后追加：… | [{"issuePath":"docs/issues/a.md"…}]
PASS  F3 docs//issues/./b.md normalised — [{"issuePath":"docs/issues/b.md"…}]
PASS  F3 the rendered hint shows the normalised path — - …b_…f109 已闭环，提案 docs/issues/b.md 有追加结论（…），请读取文件
PASS  F3 refused: docs/issues/../issues/a.md — 拒绝追加：issuePath 不能包含 ..：…
PASS  F3 refused: ../docs/issues/a.md — 拒绝追加：issuePath 不能包含 ..：…
PASS  F3 refused: absolute path — 拒绝追加：issuePath 不能是绝对路径：…
PASS  F3 refused: non-.md — 拒绝追加：issuePath 必须是 docs/issues/<name>.md：docs/issues/a.txt…
PASS  F3 refused: missing file — 拒绝追加：提案文件不存在：docs/issues/nope.md…
PASS  F3 refused: symlink — 拒绝追加：提案 docs/issues/link.md 是软链（不允许绕过 docs/issues/ 边界）…
PASS  F3 refused: docs/issues itself is a symlink out of the workspace
      — 拒绝追加：提案真实路径不在 docs/issues/ 下：/tmp/…/outside-issues/x.md…
```

（第 7 类为额外加固验证：`<ws>/docs/issues` 整体软链到仓外时，`realpath` 前缀校验仍拒。）

## 6. 回归 —— 通过

命令与结果（完整日志 `/tmp/opencode/collab-verify.log`，EXIT=0）：

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
✔ Build complete in 5143ms
=== 526/526 checks passed
=== 12/12 checks passed
=== 18/18 checks passed
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
EXIT=0
```

- 526 = 既有 506 + S89 的 20 项（逐条计数核对：S89 输出恰好 20 个 `✓`）。
- 既有用例零删改：`git diff --numstat test/handoff-harness.mjs` → `227  0`；`test/readonly-default.mjs`、
  `test/snapshot-shape.mjs` 未改动。
- `pnpm test` 内建 build，`typecheck` 与 build 均无 error。

## 7. 接口 —— 通过

- `FollowUpHintResult` 定义在 `src/core/chain.ts:69-72`，只被 `HandoffChain` 内部方法使用
  （`followUpHints` `:121`、`injectionFor` `:126`）；唯一外部调用点是 `src/hooks/context.ts:218`。
- 未泄漏到 `__internals`（`src/index.ts:200-228`）：运行时枚举不含 `followUp*`/`validateIssuePath`：

```
PASS  I: follow-up internals are not exported from __internals
      — PLUGIN_VERSION,BUILTIN_PROTECT,classify,…,CollabState,buildSnapshot
PASS  I: dist/index.d.ts does not export FollowUpHintResult / followUpHints
```

- `grep` 全仓（src/test/scripts/docs/skills）`injectionFor|followUpHints` 无其它消费者。

## 8. 范围/安全 —— 通过

`git diff --numstat`（改动文件 12 个，与允许清单一致；另有一个未跟踪的任务目录）：

```
33 0 CHANGELOG.md        3 1 README.md        17 6 docs/collab.md
 1 1 package.json        5 3 skills/collab/SKILL.md
 1 1 src/constants.ts   33 16 src/core/chain.ts   101 17 src/core/followup.ts
26 8 src/hooks/context.ts 31 2 src/tools/followup.ts 34 3 src/tools/list.ts
227 0 test/handoff-harness.mjs
```

- `src/constants.ts` 只改 `PLUGIN_VERSION`（`src/constants.ts:242` → `0.3.1`），`BUILTIN_PROTECT`
  （`src/constants.ts:38`）与 `DEFAULTS` 未动；`package.json` 只改 version 行。
- 无新依赖：`package.json` 的 `dependencies/devDependencies` 未变，无 lockfile 改动。
- handoff / lease 语义未动：`src/core/chain.ts` 的改动只在 `FollowUpHintResult`、`followUpHints`、
  `injectionFor` 的返回形状；protect 守卫（`chain.ts:739`）与其余分支未改。
- `followUps` 结构字段保持 `{bid, issuePath, at, by}`（`src/core/followup.ts:41-46`），无需迁移。

---

## 风险清单（均非阻塞）

| 级别 | 风险 | 证据 | 建议 |
| --- | --- | --- | --- |
| P3 | `collab_list` 会把**已被 stamp**、之后文件被删除/归档的追加也计入「未渲染（未标记…下一轮注入会自动提示）」。对这类条目文案不成立（它已渲染过，且不会再提示）。 | 探针：先渲染 `b_…d102`（seen 含其 key），删除 `docs/issues/gone.md` 后 `collab_list` 输出 `1 条 followUp 因路径无效未渲染（未标记…）` 且列出该 bid。 | 二选一：①`invalidFollowUpNotice` 里读一次 seen 并跳过已 stamp 条目；②把括注改为「其中 N 条从未提示过」。 |
| P3 | 集合变化（含数量不变但成员变化）时会**重列**仍在集合内的旧条目，严格讲不满足 PRD「同一无效 entry 每会话最多提示一次统计」。 | 2 → 1 条时，输出为 `1 条 … :` 并再次列出仍在集合内的 `b_…f106`。 | 若坚持 PRD 字面：只列「本次新增」的 sig；否则在 `docs/collab.md` 明确「集合变化时重列当前集合」（现文档已是此口径）。 |
| P3 | `invalidFollowUpLines` 直接渲染 `entry.bid`（未 sanitize）。手工改广播文件可让 `bid` 带换行/控制字符，从而在 `collab_list` 输出里伪造行。 | `src/core/followup.ts:137`（`followUpsOf` 对 `bid` 只 `String()`）、`:297`（渲染点）；同类问题在 0.1.6 的 `followUpHintLine` `:198` 已存在，非本次引入。 | 渲染时对 `bid` 走 `sanitizePathText`（或 `shortID`）。 |
| P4 | 永久无效的条目每轮请求都会 `stat/lstat/realpath`（旧的「记住跳过」被有意移除）。 | `src/core/followup.ts:229`；每个 bid ≤3 条、广播 7 天保留，量级可控。 | 接受（PRD 明确「自然重试，无需额外计数」）。 |
| P4 | `collab_list` 文档写「只读」，但新增的汇总会写 `collab/followup-invalid/<sid>`。 | `src/tools/list.ts:42`。 | 接受：与既有 `stale` 的 `markShown`、上报的 `takePendingNotice` 同一约定；如需严格只读可改内存态。 |
| P4 | `push` 成功但宿主在 hook 返回后丢弃本次请求（abort）时仍会 stamp。 | 代码读：`src/hooks/context.ts:242-246`。 | PRD 已界定只处理「注入抛错」，此残差为设计取舍；真要闭环需投递 ack。 |

## 是否可提交

**可以。** 建议 owner 提交这 12 个文件（逐文件 `git add`，勿 `git add -A`；任务目录按 Trellis 约定处理）。
上面 3 条 P3 都是文案/统计口径层面的改进，可在 0.3.1 内顺手改（改动面极小，仅 `src/tools/list.ts` +
`src/core/followup.ts` 两处），也可留到下一补丁；不影响本次验收与 `0.3.1` 发布。

## 复核动作说明

- 只读：未 `git add/commit/push/tag`，未改任何仓库文件（本报告除外），未重启服务，未向任何会话投递。
- 自写脚本：`/tmp/opencode/check-followup-independent.mjs`（32/32 通过）、`/tmp/opencode/probe-slot-order.mjs`、
  `/tmp/opencode/probe-risks.mjs`、`/tmp/opencode/probe-writecount.mjs`。
- 验证日志：`/tmp/opencode/collab-verify.log`（`pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs`，EXIT=0）。
