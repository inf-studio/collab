# 复核报告：看板快捷动作（`11-19-collab-board2-actions`）

复核方式：冷上下文、只审不改（未修改实现文件；为变异故意改过的两处源码已按 sha256 还原并重建 `dist`）。
隔离：`COLLAB_AUDIT_FILE` / `COLLAB_FREEZE_FILE` / `COLLAB_BROADCAST_DIR` / `COLLAB_OWNER_QUEUE_DIR` /
`COLLAB_CONFIG` 全部指向 `mkdtemp` 临时目录；真实 `~/.config/opencode/collab-audit.jsonl` **未被创建也未被写**
（探针前后 mtime 均 `null → null`）。

独立探针 `/tmp/opencode/probe/p1.mjs`（自写，不依赖 S108/PN12）：用假宿主 `plugin.setup(ctx)`，
捕获 `ctx.rpc.register` 注册的 5 个 handler 与 22 个工具定义，直接驱动 RPC 与工具两条入口，
自己数 prompt / 队列文件 / archived PATCH / 审计行 / 冻结文件。**29/29 通过**。

---

## 结论

**可提交**（PRD R1–R6 验收全部满足；回归全绿、工具数 22、版本 0.7.0、无新依赖）。
附 **1 项建议修**（低风险、3 行内）：无 `ctx.dialogs` 时「两步点击」的上膛状态**跨目标泄漏**——
在 A 上点一次「加急」（只上膛），切到 B 再点一次「加急」→ **单次点击即在 B 上执行**，
与该降级路径自述「第一次点只上膛、再点同一个按钮才执行」不符（见风险 R1）。
真实 Desktop 窗口有 `ctx.dialogs`（`@opencode/plugin` 的 `Context.dialogs` 是正式能力），
主路径不经过该分支，因此不阻塞合并；建议与主会话确认是否本次一并修。

另有 2 项 nit（格式）与 3 项已评估并接受的设计取舍（见末尾）。

---

## 逐条结论（必查 9 项）

### 1. 四动作生效 + 工具/RPC 同一 core —— **通过**

| 动作 | 探针证据（自写，非 S108） |
| --- | --- |
| escalate | `P3` 只读目标得 1 条 `delivery=queue` prompt（`forced`）；`P13` `b_…` 目标 → 记录只加 `priority/urgentAt/urgentReason/urgentBy`，`state=claimed`、`claim.by` 未变，`target` 解析为 `ses_peer` |
| freeze | `P4` 写入冻结项；`P4c` 非受保护目标恰好 1 条 `queue` 通知；`P4d` 受保护目标 0 prompt + 1 条队列项；`P4b` 绝对路径无 `scope` → 推断 `workspace` |
| unfreeze | `P4` 冻结项被删除（`freeze:false` 幂等路径） |
| archive | `P5` 归档→恢复 = 恰好 2 次 PATCH（`true` 然后 `false`） |

无第二份编排（grep，全仓 `src/`）：

```
$ grep -rln "受保护目标：未投递" src/   → src/core/actions.ts
$ grep -rln "已加急 →"            src/   → src/core/actions.ts
$ grep -rln "已冻结 "             src/   → src/core/actions.ts
$ grep -rn  "markUrgent"        src/   → src/core/actions.ts
$ grep -rn  "escalateAction|freezeAction|archiveAction" src/ | grep -v core/actions.ts
  src/tools/{escalate,freeze,archive}.ts: 调用
  src/index.ts:224/232/244/251 : runAction 调用 + 423-425 __internals 导出
```

工具文件只剩 description / schema / `confirm` 接线（`src/tools/escalate.ts:99`、`freeze.ts:94`、`archive.ts:69`）。
`tools/escalate.ts:30` 用 `export { URGENT_PREFIX, sanitizeReason } from '../core/actions.ts'` 保住了旧导出面。

### 2. 门禁（服务端强制）—— **通过**（探针自己数写入）

| 门禁 | 探针结果 |
| --- | --- |
| protected（内置硬名单）加急 | `ok:false`，**0 prompt / 0 队列文件**，`detail` 含 `protect` 与「0 条 prompt」（`P1`）；审计 +1 行 `ok:false` |
| protected **血缘**（子会话）加急 | `ok:false`，0 prompt，0 队列（`P4e`）；归档同样 `ok:false` 且 **0 PATCH**（`P5b`） |
| 只读 agent（`explore`）加急 | 1 条 `delivery=queue`，回执 `forced`（`P3`） |
| 冻结中加急 | `ok:false`，0 prompt，`detail` 给出 `collab_freeze {…, freeze:false}`（`P4`） |
| 归档 protected | `ok:false`，0 PATCH（`P5`） |
| 冻结通知的护栏 | 受保护目标 0 prompt + 1 队列项（`P4d`，`core/actions.ts:604`） |

门禁在 core（`src/core/actions.ts:367` 拒绝分支在**任何写之前**，`427` 才是队列分支），RPC 与工具都经过它，
GUI 不可能绕过：`src/index.ts:224` 的 `runAction` 只做 target 白名单解析 + 审计。

### 3. 入口策略差异（工具转队列 / 看板直接拒绝）—— **合理**（评估）

- 两者都满足「protected 永不 push」：工具写 1 条 `priority:"urgent"` 的 owner-queue（pull 通道，0 prompt），
  看板 0 prompt **且** 0 队列项。探针 `P2` / `P1` 同时复现两条路径，行为与文档一致。
- 不是「第二套规则」：差异是 `escalateAction` 的一个**参数**（`protected:'queue'|'refuse'`，
  `src/core/actions.ts:231-241`、`index.ts:238`），规则（名单 + 血缘 + 拒绝文本）只有一份。
- 合理性：GUI 一次点击不该代表 owner 向他人队列投递条目（队列语义是「我请求，owner 来拉」）；
  工具调用则保留了 0.6.0 已经写在 §11.14.1 的语义，属**向后兼容**而非新门槛。
- 文档化情况：`core/actions.ts` 模块注释、`CHANGELOG.md`（「工具仍走 0.6.0 的 urgent 队列路径，二者由
  `protected:"queue"|"refuse"` 区分」）、`docs/collab.md` §11.20 均写明；`tools/escalate.ts` 的 tool description 也仍是
  「queue + canPush:false」。
- **唯一措辞建议（非阻塞）**：§11.20 门禁表只写「protected → 拒绝」，同一节没有紧邻一句「工具路径仍排队」。
  建议补半句（`docs/collab.md:1761` 附近），避免读者以为看板改变了 `collab_escalate` 的语义。

### 4. 确认与失败隔离 —— **主路径通过**，降级路径有 1 处缺陷（R1）

- 有 `ctx.dialogs`：加急 `prompt`（理由）→ `confirm`；其余三个直接 `confirm`（归档 `danger:true`）——
  `src/gui.tsx:1005-1043`。取消（`prompt` 返回 `undefined` / `confirm` false）→ 直接 return，**0 写入**（PN12b 通过）。
- 无 `ctx.dialogs`：`dialogsOf` 安全探测（`gui.tsx:967`，读缺失 key 会 throw 的代理也能兜住），
  第一次点只上膛 + toast 说明，第二次点同一按钮执行（PN12e 通过）。
- 失败隔离：RPC 抛错 → `catch` → error toast，`finally` 复位 `busy/armed`，按钮仍可点（PN12c/PN12d 通过）。
- 成功 → toast(server `detail`) → `storeFor(ctx).load()` **一次**，没有新定时器（PN12a 的 `loads` 1→2 断言）。

**缺陷（R1，低风险）**：上膛状态是 `armed()`（只记 action id），而 `ActionRow` 不随选中会话重建
（`gui.tsx:993`、`PanelView` 的 `<Show>` 是非 keyed 的函数子节点）。实测：

```
$ node --conditions=browser test/zz-probe-actions.tmp.mjs   # 临时探针，跑完已删除
PROBE armed="再点一次： 加急" otherRow=true callsAfterOneClickOnNewTarget=1
PROBE calls: ["escalate:ses_act_me"]
```

即在 `ses_act_peer` 上上膛「加急」，切到 `ses_act_me` 后**单击一次**就发出了 escalate。
同源问题：`run()` 在 `await prepare(...)` **之后**才读 `props.session.sid` 建 `base`（`gui.tsx:1058`），
若在对话框打开期间切换选中，动作会落到新会话上。建议（3 行内，作者决定）：

```tsx
const target = props.session.sid;           // run() 开头一次性捕获
...
if (armed()?.sid !== target || armed()?.id !== id) { setArmed({ id, sid: target }); ... }
```

### 5. 审计 —— **通过**

- 每次 RPC 写动作**恰好 1 行**（成功 + 失败）：`P1` 的 `ok:false` 行、`P7` 快照 0 行、
  S108 的 8 次调用 = 8 行；字段 `{at,actor,action,target,ok,reason}` 逐条校验通过（`core/actions.ts:152`）。
- 只追加不轮转：`appendFileSync`，无 rotate/prune 代码（全仓 `AUDIT_FILE` 仅 `constants.ts:219` + `actions.ts:152`）。
- 写失败不抛：`P9` 用 `BigInt` 触发 `JSON.stringify` 异常 → 只记 `audit write failed:` 一条日志，调用不受影响。
- **actor 回退 `"gui"` 的评估**：可追溯性会退化但不致命——(a) 面板只有在右详情（已选中会话）才渲染动作行，
  正常情况下 `session` 一定带上（`gui.tsx:1058` 的 `ctx.sessions.current()?.id`）；(b) 真正拿不到时记 `gui`，
  仍能看出「面板发起」，只是分不清是哪个会话；(c) RPC 的 `actor` 是调用方自报（本地 JSON-RPC，无鉴权），
  任何本机 RPC 客户端都能写任意 actor——它只能作为「操作日志」，不能当安全审计。探针顺带确认：
  无 session 时加急仍会投递，且 prompt 的 `fromSessionID` 是 `"gui"`，对方**无处可回执**（`P6b`）。
  建议（非阻塞）：`escalate` 在无真实 session 时改为拒绝（`freeze/archive` 用 `gui` 无此问题）。

### 6. 只读回归 —— **通过**

`P7`：连续两次 `snapshot`（无参 + 带 session）→ 审计行不变、prompt 不变、审计文件 mtime 不变，
`actions` 是 boolean。`snapshot` 只多了一个布尔字段（`src/index.ts:297`，`rpc.ts` 的 `Snapshot.actions?`），
没有新增任何写路径。`collab_status` 未被本次改动触及（`src/tools/status.ts` 不在 diff 内），S 系列断言全绿。

### 7. 回归与范围 —— **通过**

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs   → EXIT=0
=== 898/898 checks passed        (handoff-harness)
=== 12/12 checks passed          (readonly-default)
=== 20/20 board checks passed    (board-shape)
=== 36/36 graph checks passed    (graph-shape)
=== 54/54 checks passed          (snapshot-shape)
=== 60/60 checks passed          (tui-render)
=== 47/47 checks passed          (gui-entry)
=== 61/61 panel checks passed    (gui-panel)
✓ skills/collab/SKILL.md (collab) / ✓ skills/collab-coordination/SKILL.md / skills ok
```

- 与要求的 898 + 12 + 20 + 36 + 54 + 60 + 47 + 61 **完全一致**。
- 工具数 22（探针 `[collab] setup ok: version=0.7.0 … tools=22`），版本仍 0.7.0，`package.json` 未改（无新依赖）。
- `types.ts:772` 的 `boardActions: boolean` 增量**必要**：`loadConfig` 返回 `CollabConfig`，
  字段必填才能让 `readConfig().boardActions` 不用 `as`/可选链；`config.ts:124-125` 只认显式 boolean（typo 回落默认），
  与 `awareness` 的处理风格一致；`Snapshot.actions?` 用可选是为了兼容旧 server（`rpc.ts` 注释写明了）。

### 8. 测试真实性 —— **通过**（我自己做了 2 组变异，先 build 再跑 harness，改完还原并 `sha256sum -c`）

**变异 1**：删掉 `core/actions.ts:367` 的 `if (guard && input.protected === 'refuse') throw …`

```
=== 896/898 checks passed
✗ S108 escalate → protected is refused: ok:false, 0 prompts, 0 queue writes — true / 0 prompt(s) / 1 queue file(s) / …
✗ S108 a failure is audited with ok:false and the refusal as `reason` — …
FAIL: S108 escalate → protected is refused: ok:false, 0 prompts, 0 queue writes
FAIL: S108 a failure is audited with ok:false and the refusal as `reason`
```

**变异 2**：`index.ts:267` 的 `appendAudit(...)` 包进 `if (receipt.ok)`

```
=== 895/898 checks passed
✗ S108 every write action appends exactly one audit line (8 calls → 8 lines) — 5 line(s): escalate:true, freeze:true, …
✗ S108 a failure is audited with ok:false and the refusal as `reason` — …
✗ S108 snapshot is still zero-write: no audit line, no prompt, file untouched — 6 line(s) / 0 prompt(s)
```

（变异 2 的副作用佐证：我复跑自写探针时，`P1/P2` 也因为「失败行缺失」红了——即探针与官方断言互相独立地检出同一缺陷。）

- S108 不是自证：它断言的是**外部可观测状态**（`prompts[]`、owner-queue 目录里的文件数、`archivedPatches`、
  freeze 文件、审计文件行数与字段），且能杀死两组变异。
- PN12 走的是「假 client 记录调用」，天然是 GUI 自身布线的测试（这类测试无法完全避免），但它断言了
  dialog 顺序（`prompt,confirm`）、取消 0 写入、抛错后仍可点、`loads` 只 +1，能抓住「漏确认/漏 toast」类回归；
  它的盲点正是上面 R1 的跨目标上膛（无断言覆盖切换场景）。
- 既有断言未弱化：`git diff -U0 test/ | grep '^-'` 只有 12 行删除，全是 harness 管线/注释/被 supersede 的契约断言：

```
-function fakeClient({ reply, delay = 0, fail = false, message = 'down' } = {}) {   (签名扩展)
-function harness(session, { locale = 'en' } = {}) {                               (签名扩展)
-        // Recorded, never rendered: … R5 …                                     (注释改写)
-    client: fakeClient({ reply: snap(0) })                                         (改为可注入)
-  app: { version: 'test' },   /  -  storage: {                                   (见 nit N1)
-  event: { subscribe: feed }                                                      (补 rpc 注册)
-  'C2 the RPC definition is portable: one snapshot method, no events'             (被 supersede)
-    Object.keys(CollabState.methods) .join(',') === 'snapshot' &&                  (被 supersede)
```

唯一「改写」的旧断言是 snapshot-shape 的 C2 契约（`snapshot` → `snapshot + 四个写方法`），属需求变更的必要更新，
并新增 2 条（ActionReceipt 形状、入参白名单）。

### 9. 文档 —— **通过**（1 处措辞建议见第 3 条）

- `docs/collab.md` §11.20（RPC 契约 / 门禁表 / 审计 / GUI / 已知限制 / 测试 / 回滚）与实现逐条对得上；
  §11.4 增 `boardActions`（明确「只隐藏按钮，不是权限开关」）；§11.11 的 RPC 图更新。
- 「工具写队列 / 看板拒绝」：CHANGELOG 明写二者由 `protected:"queue"|"refuse"` 区分；§11.20 只说看板侧（建议补半句）。
- 「actor 回退」：§11.20 写明「拿不到记 `actor:"gui"`，RPC handler 拿不到 sessionID」。
- 「boardActions 只隐藏按钮」：docs / README / skill / CHANGELOG 四处一致，且探针 `P8/P8b` 复现。
- README / SKILL / CHANGELOG 的按钮、确认、审计、两步点击、回滚叙述与代码一致：
  README 的「归档按钮为危险色」↔ `gui.tsx` 的 `collab-action-danger`；skill 的「protected 拒绝 / 只读降级 /
  冻结优先 / protected 不归档」↔ 探针 P1/P3/P4/P5。

---

## 风险清单

| # | 级别 | 内容 | 建议 |
| --- | --- | --- | --- |
| R1 | 低（建议修） | 无 `dialogs` 的两步点击：`armed` 只记 action id，切换选中会话后**单击一次**就在新目标上执行（`gui.tsx:993/1005/1046`）；同源问题：`run()` 在 `await prepare` 之后才读 `props.session.sid`（`gui.tsx:1058`） | `run()` 开头 `const target = props.session.sid`，`armed` 改存 `{id, sid}` 并比对；3 行内 |
| R2 | 低（记录） | actor 回退 `"gui"` 时 escalate 仍会投递，prompt 的 `fromSessionID="gui"`（`P6b`）——对方看到 `[gui][collab:gui]` 且无处回执；审计行也因此不可追溯 | escalate 无真实 session 时拒绝（freeze/archive 可保留 `gui`） |
| R3 | 低（已评估接受） | 审计只覆盖 RPC 入口，工具侧的加急/冻结/归档不写审计 → 审计不是「所有写动作」的完整账本 | 已在 `constants.ts:206-219`、§11.20 明写；若日后要合规账本需把 `appendAudit` 下沉到 core（会改变工具输出/性能，不建议本任务做） |
| R4 | 低（已评估接受） | `runAction` 的 `catch` 把**任何**异常（含代码缺陷 TypeError）都变成 `ok:false` 回执，不进 defect reporter，真 bug 会伪装成「策略拒绝」 | 与 R6「失败只 toast」一致，接受；若担心可只对已知错误类型转回执 |
| R5 | 极低 | 陈旧上膛不会超时（无 dialogs 时） | 与 R1 一起修（切换/超时都清空 `armed`） |
| N1 | nit | `test/handoff-harness.mjs:618` 被顺手合并成 `app: { version: 'test' },  storage: {`（双空格、单行两字段） | 还原为两行，减少无意义 diff |
| N2 | nit | `test/gui-panel.mjs` 文件末尾丢了换行（原文件有） | 补一个 `\n` |

---

## 原始输出（节选）

### 官方验收

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
=== 898/898 checks passed
=== 12/12 checks passed
=== 20/20 board checks passed
=== 36/36 graph checks passed
=== 54/54 checks passed
=== 60/60 checks passed
=== 47/47 checks passed
=== 61/61 panel checks passed
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
EXIT=0
```

### 自写探针（`/tmp/opencode/probe/p1.mjs`，假宿主，隔离目录）

```
✓ probe: registration captured snapshot + 4 actions — snapshot,escalate,freeze,unfreeze,archive
✓ P1 RPC escalate → protected: ok:false, 0 prompts, 0 queue files — false / 0p / 0q / 拒绝加急：目标 ses_e1eb91cebffeTv1467ubJLKebk 本身在 protect 名单内…
✓ P1 audit +1 with actor/action/target/ok/reason — {"lines":1,"a0":0,"last":{"at":…,"actor":"ses_me","action":"escalate","target":"ses_e1eb…","ok":false,"reason":"拒绝加急：…"}}
✓ P2 TOOL escalate → protected still queues (0.6.0): 0 prompts, 1 queue file, text says 排队 — 0p / 1q / 受保护目标：未投递（0 条 prompt），已写入加急队列项 q_…
✓ P2 the tool call writes NO audit line (audit is RPC-only) — 0 extra
✓ P3 RPC escalate → explore forced to queue — queue / 已加急（delivery=queue，forced）→ ses_ro
✓ P4 RPC freeze writes the entry — true / entry=true
✓ P4 RPC escalate on a frozen session is refused with 0 prompts — false / 0p
✓ P4 RPC unfreeze removes it — 已解冻（scope=session, target=ses_peer）。
✓ P4c RPC freeze notifies a non-protected target with exactly 1 queue prompt — 1 prompt(s) / queue
✓ P4d RPC freeze of a protected target: 0 prompts, 1 queue item (never a push) — 0p / 1q
✓ P4e RPC escalate on a protected descendant: refused, 0 prompts, 0 queue items — false / 0p / 0q
✓ P4b RPC freeze without scope on an absolute path → workspace — ["workspace:/tmp/probe-board2-…/ws"]
✓ P5 RPC archive then restore → exactly 2 PATCHes with true then false — [{"sessionID":"ses_peer","archived":true},{"sessionID":"ses_peer","archived":false}]
✓ P5 RPC archive on protected → ok:false, 0 PATCH — false / 0 patch
✓ P5b RPC archive on a protected descendant → ok:false (lineage), 0 PATCH — …
✓ P6 no session → actor "gui" — {"actor":"gui","action":"escalate","ok":true,…}
✓ P6b … and the delivered prompt carries fromSessionID "gui" — {"from":"gui","fromSessionID":"gui","kind":"note","urgent":true}
✓ P7 snapshot is zero-write and actions is a boolean — 0 lines / 0 prompts / actions=true
✓ P8 boardActions:false → snapshot.actions=false, RPC still runs — false / true
✓ P8b boardActions back to default → actions=true — true
✓ P9 appendAudit never throws (an unserialisable entry is one log line)
✓ P12 a b_… target routes to the bid branch — 没有交接单 b_deadbeefdeadbeef…
✓ P12b a t_… target routes to the thread branch — thread t_m3k9_abcd 没有未闭环的交接单…
✓ P12c freeze on a b_… target infers scope=bid and refuses a missing record
✓ P13 RPC escalate on a b_… target marks the record (4 urgent fields only) — {"target":"ses_peer","priority":"urgent","state":"claimed","claim":"ses_peer"}
✓ P10 the real ~/.config/opencode/collab-audit.jsonl was never written by this probe — null → null
✓ P11 tool preview (confirm:false) is still a zero-write preview
=== 29/29 probe checks passed
```

### 变异 1（protected 拒绝分支被删）

```
=== 896/898 checks passed
✗ S108 escalate → protected is refused: ok:false, 0 prompts, 0 queue writes — true / 0 prompt(s) / 1 queue file(s) / 受保护目标：未投递（0 条 prompt），已写入加急队列项 q_…
✗ S108 a failure is audited with ok:false and the refusal as `reason` — escalate:拒绝：目标被冻结… / archive:拒绝归档：…
FAIL: S108 escalate → protected is refused: ok:false, 0 prompts, 0 queue writes
FAIL: S108 a failure is audited with ok:false and the refusal as `reason`
```

### 变异 2（审计只写成功）

```
=== 895/898 checks passed
✗ S108 every write action appends exactly one audit line (8 calls → 8 lines) — 5 line(s): escalate:true, freeze:true, unfreeze:true, archive:true, archive:true
✗ S108 a failure is audited with ok:false and the refusal as `reason` — …
✗ S108 snapshot is still zero-write: no audit line, no prompt, file untouched — 6 line(s) / 0 prompt(s)
```

两组变异后：`cp` 还原 + `sha256sum -c`（`src/core/actions.ts`、`src/index.ts` 均「成功」）+ `pnpm run build` 重建，
最终全量回归再次 EXIT=0（上表）。

### R1 复现（临时 GUI 探针，跑完已删，`test/` 无残留）

```
PROBE armed="再点一次： 加急" otherRow=true callsAfterOneClickOnNewTarget=1
PROBE calls: ["escalate:ses_act_me"]
=== 61/61 panel checks passed
```

---

## 复核期间未改动的东西

- 未改任何实现/测试文件（`git status --short` 与被复核时的清单一致；两份变异文件已按 sha256 还原）。
- 临时 GUI 探针放在 `test/zz-probe-actions.tmp.mjs` 运行后已删除；`test/` 只剩被复核的 3 个改动文件。
- 未 commit / 未 push / 未 restart / 未触碰真实会话与真实 `~/.config/opencode/collab-audit.jsonl`。

---

## 增量复核（上膛与 escalate 守卫）

范围：上轮 3 条发现的修复（① 两步点击的上膛跨会话泄漏；② 无真实 session 的加急会发出
`fromSessionID:"gui"`；③ 2 处格式 nit），复核方式同前：**只审不改**，自写探针 + 自跑 4 组变异，
变异过的两处源码已按 sha256 还原并重建 `dist`。

### 结论

**可提交**。两项修复在自写探针上都成立（探针在旧代码上能复现、在新代码上不成立），4 组回归全绿，
2 组变异均被测试杀死。仅 1 处**数字**未同步（CHANGELOG `898/61`、§11.20 测试节 `15/14 条`、`README.md:307`
的旧计数 → 现为 `899/65`、`16/18 条`），属文档精度 nit，建议合入前顺手改（README 那行在本任务之前就已过期）。
另 1 项残留低风险（上膛无 TTL，A→B→A 会在 A 上「复活」）记录在风险 D-R1，不阻塞。

### 1. 上膛不跨会话 —— **通过**

实现（`src/gui.tsx`）：

- `armed` 改 `{ id: BoardActionId; sid: string } | null`（`gui.tsx:1003-1010`），渲染与判定都走
  `armedHere(id) = armed()?.id === id && armed()?.sid === props.session.sid`（`gui.tsx:1011`）；
- `run(id)` 在**第一个 await 之前**捕获 `const target = props.session.sid`（`gui.tsx:1046-1054`），
  `prepare(id, target)` 用捕获值建上膛与对话框标题，`base.target` 也用捕获值。

自写探针（复制 `test/gui-panel.mjs` 的假宿主，另加 4 个自定义 case；跑在 `dist` 上、跑完即删）：

```
# P-D1 在 peer 上上膛 → 切到 me → 单击
PROBE-D1 {"armedPeer":true,"labelAfterSwitch":"加急","callsAfterOneClick":0,"labelAfterOneClick":"再点一次： 加急","finalCalls":["escalate:ses_act_me"]}

# P-D2 对话框打开期间切换选中（archive 与 escalate 各一次）
PROBE-D2 archive ["archive:ses_act_peer"]
PROBE-D2 escalate ["escalate:ses_act_peer"]

# P-D3 上膛后经历一次 2 s 轮询，再点第二下
PROBE-D3 {"armedLabel":"再点一次： 加急","labelAfterPoll":"再点一次： 加急","calls":["escalate:ses_act_peer"]}
```

与上轮同场景对照（上轮记录）：`callsAfterOneClickOnNewTarget=1`、`calls:["escalate:ses_act_me"]`；
本轮同一操作 **0 次调用**，第三次点击才落在 `ses_act_me`。P-D2 说明「对话框开着时切走」也不会改投目标
（`target` 在 await 之前已固定）。P-D3 说明上膛不被轮询清掉（同一会话仍有效），即 R4 的「确认」语义没被削弱。

### 2. 无 session 的 escalate —— **通过**

实现（`src/index.ts:225-241`）：`action === 'escalate' && !sessionInput` → 直接组 `ok:false` 回执，
**不进入** `escalateAction`（0 prompt / 0 队列 / 0 记录写入），随后仍走统一的 `appendAudit`
（`actor = sessionInput || 'gui'` → `"gui"`，`ok:false`，`reason = detail`）。判断在 target 解析之前，
所以 `ses_…` / `b_…` / `t_…` / workspace 一律同样拒绝。

自写探针（`/tmp/opencode/probe/p2.mjs`，假宿主，**13/13**）：

```
✓ D1 escalate without session: ok:false, 0 prompt, 0 queue file — false / 0p / 0q / 拒绝加急：没有调用方会话（session）…
✓ D1 … and it is still audited (actor "gui", ok:false, reason = verdict) — {"at":…,"actor":"gui","action":"escalate","target":"ses_peer","ok":false,"reason":"拒绝加急：没有调用方会话…"}
✓ D1b the no-session guard wins over every other target form (no prompt, no queue) — false / 0p
✓ D2 freeze without session still works (entry written, audited as actor "gui") — {"actor":"gui","action":"freeze","ok":true,…}
✓ D3 unfreeze without session still works — 已解冻（scope=session, target=ses_peer）。
✓ D4 archive / restore without session still works (2 PATCHes) — [{"sessionID":"ses_peer","archived":true},{"sessionID":"ses_peer","archived":false}]
=== 13/13 delta checks passed
```

（上轮 `P6b` 观测到的 `fromSessionID:"gui"` 不再出现：该路径已被挡在投递之前。）

### 3. 不误伤 —— **通过**

| 面 | 证据 |
| --- | --- |
| 有 session 时加急不变 | `p2 D5`：1 条 prompt、`ok:true`、审计 `actor=ses_me` |
| 只读降级 / protected 拒绝仍生效 | `p2 D5b`：`queue` + `forced`；protected `ok:false` 且 0 新 prompt |
| 冻结 / 解冻 / 归档不要求 session | `p2 D2/D3/D4`（见上） |
| 轮询不丢上膛（同一会话） | `PROBE-D3`（见上） |
| `actions:false` 仍隐藏 | 套件仍 65/65（PN12f 未改）；`p2 D6` `snapshot.actions` 是 boolean 且零写入 |
| 契约 / 工具面未动 | `p2 D6b` 5 个方法仍在；`D6c` `tools=22`；版本 0.7.0（setup 日志）；`package.json` 未改 |

### 4. 变异（2 组，均被杀；改完还原）

**M3**：`gui.tsx:1011` `armedHere` 改回只比 id（去掉 sid 判定）

```
=== 63/65 panel checks passed
✗ PN12 switching the selection clears the arm: the button on the new session shows 加急 again — {"label":"再点一次： 加急","calls":[]}
✗ PN12 one click on the new session does NOT execute — it only arms that session (R1) — {"calls":[{"action":"escalate","input":{"target":"ses_act_me",…}}],"label":"加急"}
```

**M4**：`index.ts` 的 `if (action === 'escalate' && !sessionInput)` → `if (false && …)`

```
=== 898/899 checks passed
✗ S108 escalate without a caller session is refused: ok:false, 0 prompt, audited as actor=gui — true / 1 prompt(s) / {"at":…,"actor":"gui","action":"escalate","target":"ses_s108_ro","ok":true,"reason":"S108 无发起会话"}
```

还原：`cp` 回原文件 + `sha256sum -c`（`src/gui.tsx`、`src/index.ts` 均「成功」）+ `pnpm run build`，
之后全量回归再次 EXIT=0；自写探针在最终产物上复跑仍 13/13 与 P-D1..D3 不变。

### 5. 回归与范围 —— **通过**

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
=== 899/899 checks passed         (handoff-harness)
=== 12/12 checks passed           (readonly-default)
=== 20/20 board checks passed     (board-shape)
=== 36/36 graph checks passed     (graph-shape)
=== 54/54 checks passed           (snapshot-shape)
=== 60/60 checks passed           (tui-render)
=== 47/47 checks passed           (gui-entry)
=== 65/65 panel checks passed     (gui-panel)
✓ skills/collab/SKILL.md (collab) / ✓ skills/collab-coordination/SKILL.md / skills ok
EXIT=0
```

与要求的 `899 + 12 + 20 + 36 + 54 + 60 + 47 + 65` 完全一致。范围（与上轮 `git diff --stat` 对比，
只多了这 5 个文件的行数增量）：

| 文件 | 上轮 | 本轮 | 结论 |
| --- | --- | --- | --- |
| `src/gui.tsx` | 271 | 289 | ✅ 允许 |
| `src/index.ts` | 122 | 137 | ✅ 允许 |
| `test/gui-panel.mjs` | 287 | 322 | ✅ 允许（PN12g 4 条） |
| `test/handoff-harness.mjs` | 222 | 239 | ✅ 允许（S108k 1 条） |
| `docs/collab.md` | 81 | 83 | ✅ 允许（3 处措辞） |
| 其余 11 个文件 | — | 不变 | ✅ 无越界；无新依赖、版本仍 0.7.0、工具数 22 |

### 6. 文档 —— 三处措辞 **与实现一致**；计数未同步（nit）

- §11.20「发起方」行（`docs/collab.md:1752`）：加急必须有真实 `session`，缺失 `ok:false`，
  `freeze/unfreeze/archive` 不受影响仍记 `gui` ↔ `p2 D1/D2/D3/D4`。
- §11.20「escalate 门禁」行（`docs/collab.md:1761`）：明确「工具路径不变（仍写 1 条 urgent 队列项 + 0 prompt），两条入口由
  `protected:"queue"|"refuse"` 区分」↔ 上轮 `P2` + 本轮 `D5b`（这正是上轮建议补的那半句）。
- §11.20「GUI 已知限制」（`docs/collab.md:1787`）：`armed = { id, sid }` + `run()` 在任何 await 前捕获目标 ↔ `PROBE-D1/D2`。
- **未同步的数字**（nit，见风险 D-R2）：CHANGELOG 仍写 `883 → 898` / `47 → 61`；§11.20「测试」节仍写
  `S108（15 条）` / `PN12（14 条）`（`docs/collab.md:1795` / `:1798`，现 16 / 18）；`README.md:307` 仍是 `883 项 harness … 52 项快照 … 47 项 GUI 面板`
  （该行在本任务之前就已过期，现差距更大）。

### 本次增量风险的清单

| # | 级别 | 内容 | 建议 |
| --- | --- | --- | --- |
| D-R1 | 低（残留，非新缺陷） | 上膛无 TTL，且切走再切回同一会话会「复活」：`PROBE-D4 {"onMe":"加急","backOnPeer":"再点一次： 加急","callsAfterOneClickBack":1}` —— A 上膛 → 切 B → 切回 A，单击即在 A 上执行。与文档一致（文档只承诺「在 B 上必须重新上膛」），但「确认」可能发生在很久以前 | 若要更严：`createEffect(on(() => props.session.sid, () => setArmed(null)))`，或在 `prepare` 里发现 `armed().sid !== sid` 时先清空（本项属上轮 R5 的同源残留） |
| D-R2 | nit | 三处计数过期（见第 6 条） | 合入前改 `898→899`、`61→65`、`15→16 条`、`14→18 条`；`README.md:307` 一并校正 |
| D-R3 | nit | `prepare(id, sid)` 内两处判定仍用 `armedHere(id)`（比较 `props.session.sid`）而不是入参 `sid`。今天等价（`run()` 到 `prepare()` 之间没有 await），但语义上应比 `sid`，否则日后在 `prepare` 前加一个 await 就会重新引入同类问题 | 改成 `armed()?.id === id && armed()?.sid === sid`（或在 `prepare` 开头断言相等） |

### 增量复核期间未改动的东西

未改实现/测试文件（两份被变异文件已按 sha256 还原）；临时 GUI 探针只在 `test/` 短暂存在并已删除
（`git status --short test/` 无 `??`）；未 commit / 未 push / 未 restart；真实
`~/.config/opencode/collab-audit.jsonl` 前后 `mtime` 均 `null → null`（未被创建）。
