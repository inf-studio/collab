# 复核报告：`collab_freeze`（独立冷上下文 · 只审不改）

> 复核人：独立 check agent（未使用实现方结论，`research/impl-notes.md` 仅作线索）
> 对象：`/data/project/collab` 工作区未提交改动（19 files, +1024/−30；新增 `src/core/freeze.ts`、`src/tools/freeze.ts`）
> 契约源：`prd.md` R1–R6、`design.md` §1–§7、`implement.md`
> 复核方式：读代码 + 自建假宿主的端到端探针（`/tmp/probe-freeze.mjs`，48 条）+ 3 组 dist 变异
> 硬约束遵守：未 commit / 未 push / 未 git add / 未改 `src`、`test`、`docs`；未重启、未碰真实会话；
> 全部用临时 `COLLAB_*_DIR` / `COLLAB_FREEZE_FILE`；本机 `~/.config/opencode/collab-freeze.json` 复核前后都不存在。

---

## 0. 结论

**可提交。9 项必查全部通过，0 阻塞项。**

- 回归：`pnpm test` exit 0 → **734 + 12 + 48 + 32 + 47 + 7**；`pnpm typecheck` exit 0；`node scripts/check-skill.mjs` → skills ok；工具数 **20**；版本仍 **0.5.3**；`package.json` / `pnpm-lock.yaml` 无改动（无新依赖）。
- 独立探针 **48/48** 通过（自建假宿主，覆盖 0 写入、血缘、送达、通知一次、并发、坏文件、失败注入）。
- 3 组变异全部被 S98 抓住并各自精确落到预期断言（见 §4）。
- 4 条 **P3 非阻塞观察**（§5）：README 计数残留、自冻会给自己投一条 prompt、写盘失败仍报「已冻结」、快照祖先链只覆盖当前页。均不违反 PRD 验收；按本次「只审不改」未修。

---

## 1. 必查第 1 项：冻结判定（session 自身/祖先 > bid > workspace；到期；并发写）

**判定：通过。**

实现位置：

- `src/core/freeze.ts:294-316` `freezeFor()`：纯优先级查找；`chain = [session, ...ancestors]`（近→远），先 session，再 bid，最后 workspace。
- `src/core/freeze.ts:324-345` `frozenBy()`：有 `lineage` 时走 `lineage.protectedAncestor(session, sessionTargets)`（与 protect 护栏同一套有界防环走查，`src/core/lineage.ts`，`MAX_LINEAGE_DEPTH=8`），命中祖先时返回 `via`；无 session 命中再降级到 bid/workspace。
- `src/core/freeze.ts:167-175` `readFreezes()`：读时 `.filter(entry => entry.until > now)` —— 到期即不存在；不写文件。
- `src/core/freeze.ts:251-270` `mergeFreezes()`：**先** `acquireGuard()`（`open(<file>.lock,'wx')`，2s 陈旧回收，100×5ms 后降级）**再** `readFreezes`，最后 `writeFreezes`（`src/core/freeze.ts:234-240` = `tmp` + `renameSync`）。
- 去重：`dedupe()` `src/core/freeze.ts:178-182`，同 `scope+target` 后者胜（`Map.set` 覆盖），与「later write wins」一致。

我自己的探针（`/tmp/probe-freeze.mjs`）：

```
✓ core precedence: session > bid > workspace (self hit)
✓ core precedence: ancestor beats bid/workspace
✓ core precedence: bid beats workspace
✓ core precedence: workspace last
✓ core expiry: expired entries vanish on read (10s/60s/600s/999s windows) — 4/3/1/0
✓ 4 processes × 5 merges → all 20 entries survive (no lost entry) — exits=0,0,0,0 kept=20
✓ the guard file is removed afterwards
```

并发写是**真的多进程**：4 个 `node --input-type=module -e` 子进程各自连续 5 次 `mergeFreezes`（共 20 条不同 target），最后 20 条全在、`.lock` 已清理。另：坏文件（`{ not json`）→ `readFreezes()` 返回 `[]`、工具照常重写 `version:1`（`✓ a corrupt freeze file reads as empty (no throw)` / `✓ the tool still works after a corrupt file`）。

> 备注：`mergeFreezes` 在锁竞争超过 500ms 时「无锁降级」（`src/core/freeze.ts:221-222`）。这是有意的 best-effort（锁只是跨进程保障），探针在 4 进程压力下未出现丢条目；记录为设计取舍，不算缺陷。

---

## 2. 必查第 2 项：4 处强制点（可读拒绝 + 0 写入；读取类不受限）

**判定：通过。**

| 工具 | 判定点 | 位置 | 与写路径的关系 |
| --- | --- | --- | --- |
| `collab_handoff` | 目标 + 祖先 + 目标工作区 | `src/tools/handoff.ts:107-111` | 在 `resolveMode` 之后、`newThreadID/bid/写记录/prompt` 之前；`confirm:false` 只输出 `拒绝提示:`（`handoff.ts:149`） |
| `collab_broadcast` | 工作区（读提案前） | `src/tools/broadcast.ts:114-115` | 在 `readFileSync(提案)` 之前；另在 spawn 前再判一次 `broadcast.ts:230-231`（spawn 锁/`session.create` 之前） |
| `collab_accept` | bid + 领取方会话(含祖先) + 该单工作区 | `src/tools/accept.ts:120-121` | 在 `persistRefresh` / `claimLock` 之前 |
| `collab_escalate` | 冻结优先（session/bid/目标会话所在工作区） | `src/tools/escalate.ts:272-280` | 在预览与任何 prompt/记录写入之前；`record` 用 `let` 声明于 209 行，无 TDZ 风险 |
| `collab_list` / `collab_status` | 只读，不拒绝 | `src/tools/list.ts:106-116,151-181,213-226` | 只用 `readFreezes`，不写 |

我自己的 0 写入证明（不是只看断言，是对整棵目录做内容+mtime 哈希）：

```
✓ all three refusals wrote nothing (broadcast/queue/locks unchanged) and sent 0 prompts
✓ a preview of a frozen hand-off only carries the 拒绝提示 line
✓ broadcast into the frozen workspace is refused — 拒绝：工作区 …/wsA 被冻结（scope=workspace, …
✓ handoff into the frozen workspace is refused too (R3: the whole directory) — 拒绝：目标被冻结（scope=workspace …
✓ escalate to a session inside the frozen workspace is refused — 拒绝：目标被冻结（scope=workspace …
✓ accept of a bid inside a frozen workspace is refused — 拒绝：目标被冻结（scope=workspace …
✓ the refused accept/escalate did not touch the record or leave a lock
✓ broadcast/escalate refusals wrote nothing and sent 0 prompts
✓ collab_status still answers for a frozen session (read-only not blocked)
```

拒绝文案统一且必带可复制解冻命令：`src/core/freeze.ts:351-359`（`freezeDenyText`），探针实收：

```
拒绝：目标被冻结（scope=session，到 11:02，原因：probe session froze）。解冻: collab_freeze { scope:"session", target:"ses_t", freeze:false, confirm:true }。未写入任何内容。
```

> 说明：「冻结 workspace → `collab_broadcast`」必须先通过 D4（跨工作区）检查；`broadcast.ts:110` 的 `assertOtherWorkspace` 在冻结检查之前，所以「在自己的冻结工作区里广播」得到的是 D4 错误。这是既有顺序，不是冻结缺陷（`collab_handoff` 覆盖同仓路径）。

---

## 3. 必查第 3–7 项

### 3. 血缘绕过（父线冻结 → 子/孙 handoff 被拒；解冻立即恢复）

**判定：通过。**

`src/core/freeze.ts:335-342` 命中祖先时 `via = hit.sessionID`，拒绝文案追加 `继承自祖先 <sid>`。探针（父 `ses_t` → 子 `ses_child` → 孙 `ses_grand`）：

```
✓ handoff to a DIRECT child (lineage) is refused — 拒绝：目标被冻结（scope=session，继承自祖先 ses_t, …）
✓ handoff to a GRANDchild (2 hops) is refused — 拒绝：目标被冻结（scope=session，继承自祖先 ses_t, …）
✓ unfreeze removes the entry
✓ after unfreeze the same handoff goes through (prompt + record)
✓ unfreezing again is an idempotent no-op
```

### 4. 送达（非 protected → 恰 1 条 queue、不 steer、记 cid；protected/血缘 → 0 prompt + 1 urgent 队列项）

**判定：通过。**

`src/tools/freeze.ts:128-177` `notify()`：`createLineage(ctx)` + `readConfig().protect`（`src/config.ts` 内置 `BUILTIN_PROTECT` 叠加，不可移除）；`guard` 命中 → `enqueue({priority:'urgent'})`（`freeze.ts:145`）并记 `queueId`；否则 `ctx.session.prompt({delivery:'queue', metadata.collab.cid})`（`freeze.ts:154-171`），**没有 `steer` 分支**。

探针：

```
✓ freeze session → exactly one `queue` prompt with cid (never steer) — queue c_mwmxq5sy_1xel
✓ BUILTIN_PROTECT target: 0 prompts + one urgent queue item [frozen] — 1 / urgent
✓ the queue receipt is stored on the entry
✓ a child of the protected line is treated as protected (0 prompts, queued)
```

回执在工具返回里可读（`src/tools/freeze.ts:371-399`）：`送达（queue）: … message=… cid=…` / `受保护目标（0 条 prompt，已排队）: … → <queueDir>/<id>.json`。失败只记 `delivery[].error` 且不影响冻结（`freeze.ts:172-174`，不 throw）。

### 5. context 只提示一次；`notifiedAt` 只在 push 成功后写

**判定：通过。**

`src/index.ts:167-182`：`await contextHook(event)` → `freezeNotice()` → `event.system.push(block)` → **之后**才 `markFreezeNotified()`；整段在 try/catch 内（冻结提示不能弄挂模型请求）。`freezeNotice()` `src/core/freeze.ts:388-398`；`markFreezeNotified()` `405-420` 用 `notifiedFor[]` 做到「按会话一次」（父线冻结时每个子会话各一次），旧条目（只有 `notifiedAt`）按全局已提示兼容。

探针（含 F1 失败重试）：

```
✓ the frozen child sees the notice once (reason/expiry/unfreeze)
✓ second request carries no notice
✓ a frozen ancestor: both it and its child see the notice once (notifiedFor) — ["ses_e1eb91…","ses_schema_child"]
✓ a throwing injection does not stamp notifiedAt (the notice is retried, then shown once) — stampedAfterThrow=undefined
```

（最后一条把 `event.system` 设成 `Object.freeze([])`：push 抛错 → 不写 `notifiedAt` → 下一轮正常数组仍能收到提示 → 再下一轮不再出现。与方法注释的 F1 规则一致。）

### 6. 展示（`collab_list` 标记；快照可选字段；TUI/GUI 只加标记）

**判定：通过。**

- `src/tools/list.ts:173-181`：会话行 `[frozen] 冻结至 HH:MM`（继承时 `（继承 ses_…）`）；`:226` 未闭环交接行 `[frozen] 冻结至 HH:MM`；`:106-116` 单独「冻结（临时，到期自动失效；N 条）」段 + 解冻命令。
- `src/core/snapshot.ts:183-220`（会话，用已拉到页的 `parentID` 链 + `MAX_LINEAGE_DEPTH`，0 额外 host 调用）、`:235-242`（交接）；`typeof source.freezes === 'function' ? … : []` → 旧源无 reader 不炸。
- `src/rpc.ts:24-32` `SnapshotFreeze`、`:44-47` `frozen?`、`:100-104` `freeze?`；schema `CollabState` 里两个字段均**不在 required**（`rpc.ts:175-177,213-215`）。
- `src/tui.tsx:330-345,506-511`：只在行尾加 ` [frozen] HH:MM` / 侧栏 ` · frozen HH:MM`（tone=danger）；`src/gui.tsx:341-349,397-405`：只加一个 `collab-badge collab-tone-danger`（class 存在，`gui.tsx:321`），`title` 带到期+原因。

```
✓ collab_list marks [frozen] 冻结至 HH:MM and prints the entry
✓ collab_list did not rewrite the freeze file
✓ a workspace freeze marks the sessions of that directory — 6 markers
✓ a workspace freeze is not shown for another workspace
```

快照侧的「老回包不炸」由 `test/snapshot-shape.mjs` 覆盖并通过（48/48，含 `a source without a freezes reader answers no markers` 与「frozen/freeze 均非 required」）。

### 7. 语义边界（不改 permissions/agent/归档；BUILTIN_PROTECT 未改；解冻幂等）

**判定：通过。**

- 代码里没有任何 `session.update` / `switchAgent` / `remove` 调用（只 `session.prompt` / `get` / `list` / `create`（broadcast 原有 spawn 路径））。
- `git diff` 不含 `src/constants.ts` → `BUILTIN_PROTECT` 原样；探针对 `ses_e1eb91…` 的 handoff 仍被 protect 拒绝。
- 探针：整轮冻结/解冻/送达后 `JSON.stringify(sessions)` 与开始时**逐字节相同**：

```
✓ freeze never changed permissions / agent / archived / title of any session
✓ BUILTIN_PROTECT is untouched (a handoff to the schema line is still refused) — 拒绝投递：目标 … 本身在 protect 名单内…
✓ unfreezing again is an idempotent no-op
```

---

## 4. 必查第 8–9 项：回归/范围 + 测试真实性

### 8. 回归与范围

**判定：通过。**

```
$ pnpm test        # exit=0
=== 734/734 checks passed          handoff-harness
=== 12/12 checks passed            readonly-default
=== 48/48 checks passed            snapshot-shape
=== 32/32 checks passed            tui-render
=== 47/47 checks passed            gui-entry
=== 7/7 panel checks passed        gui-panel

$ pnpm typecheck   # exit=0  ($ tsc --noEmit，无输出)
$ node scripts/check-skill.mjs
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
```

等于要求的 `734 + 12 + 48 + 32 + 47 + 7`。

- 工具数：`tools.length === 20`，`collab_freeze` 恰好注册一次（`src/tools/index.ts:49`）。
- 版本：`package.json` **0.5.3**、`src/constants.ts:363 PLUGIN_VERSION='0.5.3'`（gui-entry 断言亦通过）。
- 依赖：`git diff --stat package.json pnpm-lock.yaml` 为空。
- 改动范围：19 个文件全部与冻结相关（强制点/存储/展示/文档/测试）。
  - 唯一「顺手」改动：`src/tui.tsx:506-511` 侧栏行顺带补了 escalate 的 `· urgent` 标记与 tone（本属上一个任务的展示补漏）。不影响布局，TUI 32/32 通过，**无害但非本任务必需**。
  - `CHANGELOG.md:10` 的「17 → 19」是 escalate 的历史记录，`:51` 的「19 → 20」才是本次，正确。
- 既有断言未弱化：`git diff test/handoff-harness.mjs` **没有任何删除行**；`snapshot-shape.mjs` 纯新增；`readonly-default.mjs` 只改标题与追加 `collab_freeze`。
- 文档：`docs/collab.md` §11.2（二十个工具 + `collab_freeze` 行）+ 新增 §11.14.2；`README.md` 工具表首段与表格；`skills/collab/SKILL.md` 描述 + 速查表 + 「一点十」；`CHANGELOG.md` 0.6.0 Added/Tests。`check-skill` 通过。

### 9. 测试真实性（3 组变异，各自还原）

**判定：通过。S98 实际 38 条**（`test/handoff-harness.mjs:8776-9345`；`expect` 35 + `expectFail` 3），断言有真实约束力。

| 变异 | 补丁（`dist/index.js`） | 结果 | 命中断言 |
| --- | --- | --- | --- |
| ① 去掉祖先走查 | `frozenBy` 的 `lineage.protectedAncestor(...)` → 仅自身命中 | **exit 1，732/734** | `S98 ancestor freeze: a sub-session cannot bypass it (血缘)`；`S98 both the frozen session and its sub-session get the notice` |
| ② 去掉到期过滤 | `readFreezes` 的 `.filter(entry => entry.until > now)` → `.filter(() => true)` | **exit 1，733/734** | `S98 until expires on read: live a millisecond before, gone a millisecond after` |
| ③ protected 分支改直接 prompt | `notify()` 的 `if (guard) {` → `if (false) {`（对受保护目标也会 `session.prompt`） | **exit 1，733/734** | `S98 protected: 0 prompts, one priority:"urgent" owner-queue item starting with [frozen]` |

原始输出摘录：

```
# ①
=== 732/734 checks passed
FAIL: S98 ancestor freeze: a sub-session cannot bypass it (血缘)
FAIL: S98 both the frozen session and its sub-session get the notice (each once, notifiedFor[])

# ②
=== 733/734 checks passed
FAIL: S98 until expires on read: live a millisecond before, gone a millisecond after (no cleanup needed)

# ③
=== 733/734 checks passed
FAIL: S98 protected: 0 prompts, one priority:"urgent" owner-queue item starting with [frozen]
```

还原：`cp /tmp/dist-index.backup.js dist/index.js` → `cmp` 与变异前**逐字节相同**；随后 `pnpm test` 734/734 全绿。

S98 覆盖度（38 条）：entry 形状/默认 30m、queue 通知 + cid/messageId、handoff 拒绝且 0 写入、祖先继承、list 标记 + mtime 只读、到期假时钟、纯 ancestry 查询对照、解冻 + 幂等 + 解冻后可投、workspace 只通知根会话 + 别的目录不标记 + broadcast/escalate 拒绝、bid 冻结 + accept/escalate 拒绝且记录不动、protected 0 prompt + urgent 队列项、context 一次（含父/子各一次）、并发两进程、预览零写入、相对 `5m`、6 条可读错误、注册一次 + 20 工具 + 描述。**未发现同义反复或恒真断言**；唯一偏宽的是「别的目录不显示」用 `!includes('[frozen] 冻结至')`（全局「冻结」段用的是「到 HH:MM」，不会误伤；名称略强于实际断言范围，非缺陷）。

---

## 5. 未修问题 / 风险清单（P3，均不阻塞提交）

按本次任务「只审不改」的约束，以下**均未改动代码**，留给实现方决定：

1. **P3 文档残留**：`README.md:323` 仍写 `src/tools`（**十九个**工具）。同文件工具表已改二十、`docs`/`skill` 已改，仅此一处漏改。证据：`grep -n "十九" README.md docs skills src` 只命中此行。
2. **P3 自冻会给自己投一条 prompt**：`recipientsOf`（`src/tools/freeze.ts:98-121`）对 `scope:"session"` 直接返回 `[target]`，没有排除 `me`（只有 workspace 分支排除了自己）。实测冻结自己时：
   ```
   prompts to self: ses_me/queue
   已冻结 会话（scope=session, target=ses_me, 到 11:05：30m 后）
   ```
   这与本仓既有约定不一致（`src/tools/shared.ts:488`「拒绝投递：target 就是当前会话本身（会导致自我排队）」、`src/tools/escalate.ts:263` 同义）。同时被冻会话的 context 还会再注入一次提示，等于「自己收到两条」。建议：`recipientsOf` 对 session/bid 也过滤 `me`（条目照写、冻结照生效），或显式拒绝自冻。
3. **P3 写盘失败仍报「已冻结」**：`mergeFreezes` 失败时按设计不抛（`src/core/freeze.ts:264-267` 只记日志并返回旧列表），而 `src/tools/freeze.ts:349-350` 用 `written.find(...) ?? entry` 兜底，于是不可写路径下会出现「已冻结 + 已通知」但文件里 0 条。实测（`COLLAB_FREEZE_FILE=/proc/collab-freeze.json`）：
   ```
   已冻结 会话（scope=session, target=ses_me, 到 11:05：30m 后）
   送达（queue）: ses_me… message=msg_1 cid=…
   文件: /proc/collab-freeze.json（现有 0 条冻结）
   ```
   「现有 0 条」是唯一线索。解冻路径同源（会报「已解冻」）。建议：对比 `written` 是否真的包含本条，不含则给可读失败（或至少降级为「未生效」）。正常环境（`~/.config/opencode` 可写）不会触发。
4. **P3 快照祖先链只看当前页**：`src/core/snapshot.ts:194-215` 的 `parentOf` 来自**已拉取的会话页**；若父会话不在该页（例如传了 `workspace` 过滤而父会话在别的目录），继承冻结不会显示。仅影响展示，不影响强制点（工具侧走 `createLineage` 的 host 查询）。
5. **边界备忘（非缺陷）**：冻结只拦 PRD 枚举的 4 个「新建协作」入口；`collab_send` / `collab_reply` / `collab_followup` / `collab_request_owner` / `collab_promote` / `collab_archive` 不受影响。这是 R3 的明确枚举，但使用者容易误解为「全写屏障」，建议在 skill/文档已写明的「新建协作」定义处再强调一句（当前 §11.14.2 已列工具名，可接受）。
6. **P3 研究记录小差异**：`research/impl-notes.md:24` 写 S98 = 36 条，实际 **38 条**（`CHANGELOG.md` 已写 38）。仅研究文档不一致，不影响代码/测试。
7. **既有问题（非本次引入）**：`package.json:4` 描述仍写 `seventeen native collab_* tools`（0.5.3 时已是 19 个）。`git diff package.json` 为空，属历史遗留。

---

## 6. 复核未覆盖 / 明确不做

- 未在真实宿主（OpenCode 桌面端/TUI 实机）验证 `event.system` 注入与 `delivery:'queue'` 的真实渲染；只用假宿主（与既有 S1–S98 同一套桩）。
- 未测 `until` 跨时区/夏令时的 `Date.parse` 行为（实现用宿主本地时区，`clock()` 亦本地，属预期）。
- 未做跨机器同步/定时提醒验证（PRD 明确非目标）。
- 未改任何实现文件；所有临时产物在 `/tmp`（`probe-freeze.mjs`、`probe-selffreeze.mjs`、`dist-index.backup.js`、各日志），复核结束未写入 `~/.config/opencode/collab-freeze.json`。

---

## 7. 原始输出（完整回归一次）

```
$ pnpm test
… (build: dist/index.js / dist/gui-experimental.cjs / dist/tui.js)
=== 734/734 checks passed
=== 12/12 checks passed
=== 48/48 checks passed
=== 32/32 checks passed
=== 47/47 checks passed
=== 7/7 panel checks passed

$ pnpm typecheck
$ tsc --noEmit          # 无输出，exit 0

$ node scripts/check-skill.mjs
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
```

```
$ node /tmp/probe-freeze.mjs
=== 48/48 probe checks passed
```

（探针完整列表见本文 §1–§4 摘录；脚本位于 `/tmp/probe-freeze.mjs`，使用 `mkdtempSync` 临时根目录 + 假宿主，结束删除临时目录。）
