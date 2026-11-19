# 实现记录：看板快捷动作（加急 / 冻结 / 解冻 / 归档）

任务：`.trellis/tasks/11-19-collab-board2-actions`（0.8.0 子任务，版本号未改，仍是 0.7.0）

## 1. 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/core/actions.ts`（新） | `escalateAction` / `freezeAction` / `archiveAction` + `appendAudit`；三个动作的编排从工具**原样搬入**（工具文本逐字不变），RPC 与工具共用同一份实现 |
| `src/tools/{escalate,freeze,archive}.ts` | 只保留 description / JSON schema / `confirm` 接线 → 调 `core/actions.ts`；`resolveTarget` / `resolveMode` / `senderLabel` / `listSessions` 组成 `ActionContext`（`ToolKit` 已具备） |
| `src/rpc.ts` | `CollabState` 增 `escalate` / `freeze` / `unfreeze` / `archive`（`ActionReceipt { ok, action, target, detail }`）；`Snapshot.actions?: boolean` |
| `src/index.ts` | 注册 4 个 RPC handler；`runAction()` 做**白名单 target 解析**（`b_…` / `t_…` / `ses_…` / 绝对路径）、`protected:"refuse"`（看板策略）、审计行、`ok:false` 回执；`snapshot` 附带 `actions: boardActions !== false`；`__internals` 导出三个 action + `appendAudit` |
| `src/constants.ts` | `AUDIT_FILE`（`COLLAB_AUDIT_FILE` 可覆盖）；`DEFAULTS.boardActions = true` |
| `src/config.ts` / `src/types.ts` | `boardActions`（boolean，默认 true；只认显式 boolean，typo 回落默认） |
| `src/gui.tsx` | `ActionRow` 四个按钮 + `ctx.dialogs`（prompt→confirm / confirm）→ RPC → toast → `store.load()` 一次；无 dialogs 时两步点击；`actions:false` 隐藏；CSS；i18n（en/zh）；尾部文案改「视图只读 · 动作需确认」 |
| `test/handoff-harness.mjs` | 新增 `ctx.rpc.register` 捕获 + `COLLAB_AUDIT_FILE`；**S108**（15 条） |
| `test/gui-panel.mjs` | `fakeClient` 支持 action、`harness` 支持 `dialogs`；**PN12**（14 条） |
| `test/snapshot-shape.mjs` | 契约断言从「只有 snapshot」改为「snapshot + 四个写方法」，新增 ActionReceipt 与白名单入参断言（+2） |
| `docs/collab.md` | §11.4 增 `boardActions`；§11.11 RPC 图；**§11.20** 新章节（RPC / 门禁 / 审计 / GUI / 已知限制 / 测试 / 回滚） |
| `README.md` / `CHANGELOG.md` / `skills/collab/SKILL.md` | 同步（动作行、`boardActions`、审计、两步点击已知限制） |

**未改**：`BUILTIN_PROTECT`、任何护栏、工具数量（仍 22）、版本号、依赖、`package.json`。

## 2. 四动作实测（假宿主，S108）

```text
✓ S108 the RPC registers snapshot + the four write actions (and the definition declares them) — snapshot,escalate,freeze,unfreeze,archive
✓ S108 the snapshot carries `actions: true` by default (an older server may omit it) — {"actions":true}
✓ S108 freeze writes the entry (and notifies once) — true / S108 冻结中
✓ S108 unfreeze removes the entry and reports it — 已解冻（scope=session, target=ses_s108_peer）。
✓ S108 archive → archived:true then restore → archived:false (both ok) — [{"sessionID":"ses_s108_peer","archived":true},{"sessionID":"ses_s108_peer","archived":false}]
✓ S108 read-only agent is forced to queue — delivery=queue / 已加急（delivery=queue，forced）→ ses_s108_ro
```

GUI（PN12，假 RPC + 假 dialogs）：

```text
✓ PN12 the detail pane renders the four action buttons (加急 / 冻结 / 解冻 / 归档) — ["escalate","freeze","unfreeze","archive"]
✓ PN12 加急 asks for the reason, confirms, then calls escalate with target + reason + actor
   {"kinds":["prompt","confirm"],"calls":[{"action":"escalate","input":{"target":"ses_act_peer","session":"ses_act_me","reason":"看板理由：先处理这一单"}}]}
✓ PN12 冻结 confirms (no reason prompt) and calls freeze with scope=session
   {"action":"freeze","input":{"target":"ses_act_peer","session":"ses_act_me","scope":"session","reason":"看板冻结（30 分钟）"}}
✓ PN12 a successful action shows a success toast and refreshes the snapshot once (no new poller) — loads 1 → 2
```

## 3. 门禁证据（服务端强制，GUI 不可绕过）

| 场景 | 结果 |
| --- | --- |
| protected（内置硬名单）加急 | `ok:false`，**0 prompt**，**0 队列文件**，`detail` 含 `protect` 与「0 条 prompt」 |
| 只读 agent（`explore`）加急 | 1 条 `delivery:queue` prompt，回执 `forced`（绝不 steer） |
| 冻结中的会话加急 | `ok:false`，0 prompt，`detail` 给出 `collab_freeze { …, freeze:false }` 解冻命令 |
| 归档 protected 会话 | `ok:false`，**0 次 PATCH**（`archivedPatches` 计数不变） |
| 看板每次调用 | 追加 1 行审计；8 次调用 = 8 行（含 3 次失败）；`snapshot` 不写审计（mtime 不变） |
| `boardActions:false` | `snapshot.actions === false`（GUI 不渲染按钮），RPC 仍 `ok:true` |

S108 关键断言原文：

```text
✓ S108 escalate → protected is refused: ok:false, 0 prompts, 0 queue writes — false / 0 prompt(s) / 0 queue file(s) / 拒绝加急：目标 ses_e1eb… 本身在 protect 名单内…
✓ S108 escalate → frozen is refused (freeze wins): ok:false, 0 prompts — false / 0 prompt(s) / 拒绝：目标被冻结（scope=session，到 21:52，原因：S108 冻结中）…
✓ S108 archive → protected is refused: ok:false, no PATCH — false / 0 patch(es) / 拒绝归档：ses_e1eb… 本身在 protect 名单内…
```

## 4. 审计样例（`~/.config/opencode/collab-audit.jsonl`，测试用 `COLLAB_AUDIT_FILE`）

```json
{"at":1795094524384,"actor":"ses_s108_me","action":"escalate","target":"ses_e1eb91cebffeTv1467ubJLKebk","ok":false,"reason":"拒绝加急：目标 ses_e1eb91cebffeTv1467ubJLKebk 本身在 protect 名单内（collab.json 的 protect + 内置硬名单）。看板动作不投递、也不写队列项（0 条 prompt / 0 队列项）；需要请求该会话请用 collab_request_owner。未写入任何内容。"}
{"at":1795094524386,"actor":"ses_s108_me","action":"escalate","target":"ses_s108_ro","ok":true,"reason":"S108 只读目标"}
{"at":1795094524387,"actor":"ses_s108_me","action":"freeze","target":"ses_s108_peer","ok":true,"reason":"S108 冻结中"}
{"at":1795094524388,"actor":"ses_s108_me","action":"escalate","target":"ses_s108_peer","ok":false,"reason":"拒绝：目标被冻结（scope=session，到 21:52，原因：S108 冻结中）。解冻: collab_freeze { scope:\"session\", target:\"ses_s108_peer\", freeze:false, confirm:true }。未写入任何内容。"}
{"at":1795094524411,"actor":"ses_s108_me","action":"unfreeze","target":"ses_s108_peer","ok":true,"reason":""}
{"at":1795094524415,"actor":"ses_s108_me","action":"archive","target":"ses_e1eb91cebffeTv1467ubJLKebk","ok":false,"reason":"拒绝归档：ses_e1eb91cebffeTv1467ubJLKebk 本身在 protect 名单内（collab.json 的 protect + 内置硬名单）。未做任何修改。"}
```

成功行的 `reason` = 调用方自己的理由（escalate / freeze）；unfreeze / archive / restore 没有理由参数，
记空串（失败行始终记回执 `detail`）。只追加、不轮转。

## 5. 确认取消（R4）

```text
✓ PN12 cancelling the confirmation calls nothing (0 writes) — {"calls":[],"kinds":["prompt","confirm","confirm"]}
✓ PN12 cancelling the reason prompt also writes nothing — []
✓ PN12 without ctx.dialogs the first click only arms (0 writes) and says so
   {"calls":[],"label":"再点一次： 加急","toast":{"description":"该窗口没有确认对话框：再点同一个按钮即执行（此前未写入任何内容）。"}}
✓ PN12 … the second click runs escalate with the default one-line reason
   {"action":"escalate","input":{"target":"ses_act_peer","session":"ses_act_me","reason":"看板加急"}}
```

## 6. 故障隔离（R6）

```text
✓ PN12 a refused action shows an error toast with the server’s reason (no refresh, panel intact)
✓ PN12 … and the next action still works (the panel never breaks)
✓ PN12 a thrown RPC shows an error toast and writes no snapshot refresh
✓ PN12 … and the buttons are still rendered/clickable afterwards
```

## 7. 变异（2 组，均先 `pnpm build` 再跑，改完已还原）

### 变异 1：删掉 protected 拒绝分支（`core/actions.ts`）

```text
  ✗ S108 escalate → protected is refused: ok:false, 0 prompts, 0 queue writes — true / 0 prompt(s) / 1 queue file(s) / 受保护目标：未投递（0 条 prompt），已写入加急队列项 q_mwnkv9bj_wwf6。
  ✗ S108 a failure is audited with ok:false and the refusal as `reason` — escalate:拒绝：目标被冻结… / archive:拒绝归档…
=== 896/898 checks passed
FAIL: S108 escalate → protected is refused: ok:false, 0 prompts, 0 queue writes
FAIL: S108 a failure is audited with ok:false and the refusal as `reason`
```

### 变异 2：审计只写成功路径（`index.ts` 的 `appendAudit` 包进 `if (receipt.ok)`）

```text
  ✗ S108 every write action appends exactly one audit line (8 calls → 8 lines) — 5 line(s): escalate:true, freeze:true, unfreeze:true, archive:true, archive:true
  ✗ S108 a failure is audited with ok:false and the refusal as `reason`
  ✗ S108 snapshot is still zero-write: no audit line, no prompt, file untouched — 6 line(s) / 0 prompt(s)
=== 895/898 checks passed
FAIL: S108 every write action appends exactly one audit line (8 calls → 8 lines)
FAIL: S108 a failure is audited with ok:false and the refusal as `reason`
FAIL: S108 snapshot is still zero-write: no audit line, no prompt, file untouched
```

两组均已 `cp` 备份还原（`src/core/actions.ts` / `src/index.ts`），还原后全绿。

## 8. 回归

```text
pnpm build      ✅
pnpm typecheck  ✅
pnpm test       ✅
node scripts/check-skill.mjs ✅
```

| 套件 | 前 | 后 |
| --- | --- | --- |
| `test/handoff-harness.mjs` | 883 | **899**（+S108 16，含复核轮 S108k） |
| `test/readonly-default.mjs` | 12 | 12（工具数仍 22） |
| `test/board-shape.mjs` | 20 | 20 |
| `test/graph-shape.mjs` | 36 | 36 |
| `test/snapshot-shape.mjs` | 52 | **54**（契约改为 snapshot + 4 写方法；+ActionReceipt/白名单） |
| `test/tui-render.mjs` | 60 | 60（TUI 仍零写） |
| `test/gui-entry.mjs` | 47 | 47 |
| `test/gui-panel.mjs` | 47 | **65**（+PN12 18，含复核轮 PN12g） |

## 9. 已知限制 / 决策记录

1. **RPC 拿不到调用方 sessionID**：宿主 `rpc.register` 的 handler 只有 `{ signal, error }`。因此 `session` 由
   GUI 显式带入（`ctx.sessions.current()?.id`）；缺失时审计 `actor:"gui"`（设计 §1 允许）。
2. **看板加急对 protected 采用 `refuse` 而不是工具的 `queue`**：PRD R3 要求「protected 一律拒绝且 0 投递」，
   测试要求 0 prompt **且 0 队列写入**；工具保持 0.6.0 的 urgent 队列语义（883 条旧断言不变）。
   两者由 `escalateAction({ protected: 'queue' | 'refuse' })` 区分——是**入口策略**，不是两套规则。
3. **冻结/解冻不做 protected 拒绝**：冻结是保护性刹车，S98i 已规定受保护目标 0 prompt + 一条 urgent 队列项；
   看板沿用（0 投递）。归档按既有规则拒绝 protected。
4. **无 dialogs 的降级**：老窗口/测试宿主没有 `ctx.dialogs` → 两步点击（第一次只上膛）。加急用固定理由
   「看板加急」；freeze 用「看板冻结（30 分钟）」（core 要求 reason 非空）。
5. **审计只由 RPC 写**：工具不追加（不改变既有工具行为/回执）。若以后要求工具也审计，直接在 `runAction`
   之外再挂一处即可（`appendAudit` 已导出 + `__internals` 可见）。
6. **文件白名单偏离**：实现需给 `src/types.ts` 的 `CollabConfig` 加一个 `boardActions: boolean` 字段
   （硬约束清单未列，但缺它无法通过类型检查；只加 1 个字段，不改其它类型）。
7. **工具数量/版本**：仍 22 个工具、0.7.0（0.8.0 由父任务发）。

## 10. 复核修复轮（`check-report.md` R1 + R2 + 2 nit）

复核结论「可提交」，附 1 项必修（R1 上膛跨会话泄漏）、1 项建议（R2 无 session 的加急）、2 个格式 nit、
1 处文档措辞。本轮全部处理。

### 10.1 R1（必修）：两步点击的上膛不再跨会话

- `armed` 从 `BoardActionId | null` 改为 `{ id, sid } | null`；渲染用 `armedHere(id)`（`id` **且** `sid`
  都匹配当前 `props.session.sid`）——切换选中后按钮自动回到未上膛。
- `run(id)` 在**任何 await 之前**捕获 `const target = props.session.sid`，`prepare(id, target)` 用它上膛/比对，
  之后的 `base.target` 也用捕获值：即使对话框打开期间切换选中，动作也不会落到新会话上。
- `prepare` 里上膛判定同样按 `(id, target)`：在 A 上上膛后切到 B，B 的第一次点击**只上膛 B**。

新增断言（`test/gui-panel.mjs` PN12g，4 条）：

```text
✓ PN12 (setup) an arm on act peer writes nothing, and the other row exists
✓ PN12 switching the selection clears the arm: the button on the new session shows 加急 again — {"label":"加急","calls":[]}
✓ PN12 one click on the new session does NOT execute — it only arms that session (R1) — {"calls":[],"label":"再点一次： 加急"}
✓ PN12 … the second click on the new session executes against it (not the previously armed one)
   [{"action":"escalate","input":{"target":"ses_act_me","session":"ses_act_me","reason":"看板加急"}}]
```

变异（把 `armedHere` 改回只比 `id`，先 build 再跑，跑完 `cp` 还原并重建）：

```text
  ✗ PN12 switching the selection clears the arm: the button on the new session shows 加急 again — {"label":"再点一次： 加急","calls":[]}
  ✗ PN12 one click on the new session does NOT execute — it only arms that session (R1) — {"calls":[{"action":"escalate","input":{"target":"ses_act_me",…}}],"label":"加急"}
=== 63/65 panel checks passed
FAILED: PN12 switching the selection clears the arm: the button on the new session shows 加急 again
FAILED: PN12 one click on the new session does NOT execute — it only arms that session (R1)
```

### 10.2 R2（建议）：无真实发起会话的加急直接拒绝

`src/index.ts` 的 `runAction`：`escalate` 且 `session` 为空 → 不发 prompt，直接
`ok:false` +「拒绝加急：没有调用方会话（session）。看板动作必须带上发起会话，否则对方无处回执。未写入任何内容。」，
仍写一行审计（`actor:"gui"`、`ok:false`）。`freeze` / `unfreeze` / `archive` 不需要 actor，保留 `"gui"` 回退。

新增断言（S108k）：

```text
✓ S108 escalate without a caller session is refused: ok:false, 0 prompt, audited as actor=gui —
  false / 0 prompt(s) / {"at":…,"actor":"gui","action":"escalate","target":"ses_s108_ro","ok":false,"reason":"拒绝加急：没有调用方会话（session）…"}
```

### 10.3 文档（§11.20 半句）与 nit

- §11.20 门禁表补：「**工具路径不变**：`collab_escalate` 对 protected 仍写 1 条 `priority:"urgent"` 队列项 +
  0 prompt（0.6.0 语义）；两条入口由 `escalateAction({ protected:"queue"|"refuse" })` 区分」。
- §11.20「发起方」行补：加急缺 `session` → `ok:false`；freeze/unfreeze/archive 仍记 `gui`。
- §11.20「已知限制」补：上膛按 `(动作, 会话)` 记录，切换会话后必须重新上膛。
- N1：`test/handoff-harness.mjs` 的 `app: { version: 'test' },  storage: {` 恢复为两行。
- N2：`test/gui-panel.mjs` 末尾补回换行。

### 10.4 回归（复核修复轮后）

```text
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs   ✅
=== 899/899 checks passed     (883 + S108 16)
=== 12/12 checks passed       (工具数仍 22)
=== 20/20 board checks passed
=== 36/36 graph checks passed
=== 54/54 checks passed
=== 60/60 checks passed
=== 47/47 checks passed
=== 65/65 panel checks passed (47 + PN12 18)
skills ok
```

未改版本号（0.7.0）、未新增依赖、未做任何 git 写操作。
