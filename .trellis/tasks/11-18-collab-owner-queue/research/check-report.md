# 独立复核报告：owner 队列 / `expected:research` / 同仓拒广播（0.4.0）

- 任务：`.trellis/tasks/11-18-collab-owner-queue`
- 复核对象：`/data/project/collab` 未提交改动（`git status` 见文末）
- 复核方式：**冷上下文 + 自写假 ctx**（`/tmp/opencode/qcheck.mjs`、`dbg4/5/7/8.mjs`），
  只读审查，未改任何实现文件、未 commit / add / push
- 复核时间：2026-11-18 14:45–15:00 CST

## 0. 结论

**可提交（无阻断）**。R1–R6 全部落地且可复现；6 套门禁全绿（build / typecheck / 582 + 12 + 18 / check-skill）；
零投递、方向、注入白名单、`seenAt` 时机、`research` 三值、同仓 `realpath` 拒绝均以**自写断言**独立复现。

发现 **1 条轻微不通过**（`summary`/`issuePath` 只去 C0+DEL，C1 控制字符与 bidi 控制符会留在受保护会话的注入行里，
与 R4「去控制字符」及模块注释「never introduce a second injected line」有缝隙；给出 1 行补丁）+
**5 条非阻断观察**（未校验的 `bid` 落盘、grant 白名单未含新工具、`revokedAt` 死字段、重复提交不幂等、
容量检查非原子）。详见 §5。

### ⚠ 复核过程中的重要事实：工作区在复核期间被改动

本轮复核读到的是**实现方仍在收尾**的中间态：`src/**`、`test/**`、文档的 mtime 落在 14:41–14:55，
而我最初的读文件发生在该区间内。为避免基于陈旧内容下结论，**全部结论以下列方式重做**：

1. 14:58 重新 `pnpm build`，把 `dist/index.js` 快照到 `/tmp/opencode/plugin-snapshot2.mjs`；
2. 6 套门禁 + 我的 61 条自写断言**全部对最终快照重跑**（不是复用中间态结果）；
3. 15:00 复查 mtime：最后一次写入是 14:55:01（README），此后无变更。

期间已修正的两点（说明实现方自检有效，非我发现）：预览的「已满」判定改为按**未读**计数
（`src/tools/owner-queue.ts:179-181`）、写入时 `at` 严格递增以固定 FIFO（`src/core/owner-queue.ts:261-262`）。

---

## 1. 队列零投递（PRD R1 / design §1、§2）

**通过**。

| 断言（自写假 ctx） | 结果 |
| --- | --- |
| `confirm:false` 连 `<queueDir>` 都不创建 | ✅ `!existsSync(ownerQueueRoot)` |
| `confirm:false`：0 prompt / 0 storage 写 / 0 session.create / 0 广播文件 / 0 lock | ✅ 五路计数均未变 |
| `confirm:true`：0 prompt（`ctx.session.prompt` 调用数不变） | ✅ |
| `confirm:true`：0 bid / 0 thread / 0 inbox（`ctx.storage.set` 次数与 key 集合完全不变） | ✅ |
| `confirm:true`：0 广播记录（`$COLLAB_BROADCAST_DIR/*.json` 计数不变）、0 lock | ✅ |
| 只落一个文件 `<dir>/<targetSid>/<queueId>.json`，字段 `{id,target,from,at,summary,issuePath,bid,revokedAt,seenAt}` | ✅ |

代码落点：`src/core/owner-queue.ts:238-286`（仅 `pruneSeen` + 容量读 + `mkdirSync` + `writeFileSync(tmp)` + `renameSync`）、
`src/tools/owner-queue.ts:88-227`（全路径无 `ctx.session.prompt` / `ctx.storage` 调用）。

---

## 2. 方向校验（PRD R4 / design §2）

**通过**。

| 场景 | 结果 |
| --- | --- |
| 受保护发起方（`ses_e1eb91…`）→ 另一受保护 | ✅ 拒绝，文案含「受保护…不做 protected → protected 转发」 |
| `[protected-child]`（`ses_child`，parent 命中 BUILTIN_PROTECT）发起 | ✅ 拒绝（同上） |
| 普通目标 `ses_plain` | ✅ 拒绝，文案含 `collab_handoff { target, text, confirm:true }` |
| `[protected]` 目标 / `[protected-child]` 目标 | ✅ 均接受 |
| 三种拒绝后队列目录 0 文件 | ✅ |

代码：`src/tools/owner-queue.ts:160-176`（先判发起方、再判目标，均在 `confirmed` 分支之前）。
`BUILTIN_PROTECT` 名单未动（`git diff src/constants.ts` 只有 `EXPECTED` / 队列常量 / `PLUGIN_VERSION`），
血缘实现 `src/core/lineage.ts` 未改。

---

## 3. 容量与幂等（PRD R4 / design §1、§8）

**通过（含 2 处「与 design 措辞不同但已文档化」的取舍）**。

| 断言 | 结果 |
| --- | --- |
| 50 条未读可写；第 51 条拒绝，文案含「队列已满（50 条未读）」 | ✅ |
| 拒绝时**不驱逐**已有项（仍 50 文件） | ✅（harness S90 也覆盖，我独立复现） |
| owner 读掉 3 条后再提交成功（上限按**未读**计） | ✅ 50 unread + 3 seen → 接受，共 51 文件 |
| `revoke` 预览（`confirm:false`）不删 | ✅ |
| 旁观者 `revoke` → 「只有发起方」且文件仍在 | ✅ |
| 发起方 `revoke`（`id` only，无 `target`）→ 文件删除 | ✅ |

差异说明（非缺陷，均已写进 docs/CHANGELOG）：
1. **上限按「未读」而非「全部」**（`src/core/owner-queue.ts:249-255` + `src/constants.ts:198-204` 注释）——
   否则 owner 读完后队列永久占满，与该队列存在的目的相反。
2. **重复提交不幂等**：同 `(target, text)` 提交两次 = 两条独立项、两条提示、占两个名额（`at` 各自递增）。
   PRD 未要求幂等，但文档也未说明；建议在 `docs/collab.md §11.12` 补一句（见 §5-F5）。

---

## 4. 注入白名单与 `seenAt` 时机（PRD R2 / design §3）

**通过**。

| 断言 | 结果 |
| --- | --- |
| `[protected]` 目标：单次注入恰好 3 行（50 条未读时） | ✅ |
| 行格式 `- [owner-queue] <from 短 id> @ HH:MM：<summary>（<issuePath 或 ->）` | ✅ 正则逐行匹配 |
| 按 `at` 升序（含同一毫秒写入 5 条）：显示 1,2,3 再 4,5 | ✅（`at` 递增策略生效） |
| 每条只出现一次（第二次注入换成后 2 条，第三次 0 行） | ✅ |
| 注入块内无任何指令/回执要求（无 `collab_*` 调用串、无「必须/请回/confirm:true」） | ✅ |
| `system.push` 抛错（`Object.freeze([])`）→ 不写 `seenAt`；下一轮重新出现并在那时才写 | ✅ |
| `[protected-child]` 收到**自己**的队列项；**看不到父会话的项** | ✅ |
| 普通会话（哪怕手工造了 `<queueDir>/<其 sid>/`）→ 0 行 | ✅ |
| 受保护会话仍能看到既有的「闭环后追加」提示（白名单两类并存） | ✅（代码 `src/core/chain.ts:766`，harness S89/S91 覆盖） |

代码：`src/core/chain.ts:748-770`（守卫先算、`[protected-child]` 早退分支只给队列行）、
`src/core/owner-queue.ts:319-357`（`unseenHints` 纯查询 + `markSeen` 逐条重读、已 stamp 不覆盖）、
`src/hooks/context.ts:218-225, 246-253`（`markSeen` 在 `event.system.push` **之后**）。

> 安全语义确认：除「群组广播 / 接管请求 / 未闭环提醒」对受保护会话仍不可见外，
> 队列行是**唯一**新增的写入方向，且是 pull（对方不运行就永不消费）。

---

## 5. 发起方可见性（PRD R3 / design §4）

**通过**。

| 断言 | 结果 |
| --- | --- |
| `collab_list` 输出「我提交给受保护会话的请求：N 条待处理（…读到 / 只读提示，未投递…）」 | ✅ |
| ≤3 行明细（`q_… → 目标短 id  时间  "摘要"`）+ `…还有 N 条` + 撤回命令 | ✅ 3 行 + 余量行 + `撤回: collab_request_owner { id:…, revoke:true, confirm:true }` |
| 其它会话看不到这一块 | ✅ |
| **空会话分支**（`directory` 指向无会话的工作区）同样输出该块 | ✅ 实测输出见 §7-⑤ |

代码：`src/tools/list.ts:32-47`（只读：不 stamp / 不删）、`src/tools/list.ts:105-112, 249`。

---

## 6. `expected:"research"`（PRD R5 / design §5）

**通过**。

| 断言 | 结果 |
| --- | --- |
| `collab_broadcast` / `collab_handoff` 的 `expected` 枚举 = `implement,review,research` | ✅ |
| `normalizeExpected` 接受三值，其余回落 `implement` | ✅（`src/core/score.ts:29-34`） |
| **push** 接管文案：`期望：research` + 「本次期望是「只读排查」…不要改代码」+ ③ 改为只读措辞 | ✅ 实测（spawn 路径 prompt 原文见 §7-③） |
| **pull** 接管文案：③ 改为「只读排查…连同上面的 [handoff] 行写在本会话最后一条回复里」 | ✅ 实测（受保护发起方的 ask 行见 §7-④） |
| `explore` + `implement`：**结果**（非仅预览）追加「承接方为只读 agent（explore）…建议 expected:"research" 或 collab_promote」 | ✅ 实测 confirm:true 结果末行 |
| `research` + `explore` / `research` + `build`：不误报 | ✅ |
| 匹配分：`research` 对 build 也是合法匹配 | ✅（`src/core/score.ts:274-278`） |

代码：`src/core/verdict.ts:262-267, 296-345`、`src/tools/shared.ts:260-272`、`src/tools/broadcast.ts:190, 210-213, 344-348, 409-413`、
`src/tools/handoff.ts:140, 207`、`src/core/chain.ts:813-819`（ask 行透传 `record.expected`）。

---

## 7. 同仓 `collab_broadcast`（PRD R6 / design §6）

**通过**。

| 断言 | 结果 |
| --- | --- |
| `workspace === ctx.location.directory`（原样路径）→ 抛错，含「同仓」+ `collab_handoff` | ✅ |
| 软链 + 尾斜杠（`<link>/`）指向当前工作区 → 同样拒绝 | ✅ `realpath` 比较生效 |
| 拒绝时 **0 广播记录**（`*.json` 计数不变）、0 prompt、0 create | ✅ |
| `confirm:false` 预览同样拒绝（不是「预览放行」） | ✅ |
| 真·跨工作区（另一个有 `docs/issues` 的目录）不受影响，正常写记录 | ✅ +1 记录 |

代码：`src/tools/broadcast.ts:34-55`（`realpathSync` 两侧，失败回落字符串比较）、`:108`（在 `resolveBroadcastTargets`
之后、任何 claim/写之前）。

---

## 8. 回归与门禁

**通过**（全部在**最终**源码上重跑，14:58 构建）：

```
$ pnpm build                 → build+tc exit=0（dist/index.js + dist/gui-experimental.cjs）
$ pnpm typecheck             → tsc --noEmit，无输出（exit 0）
$ node scripts/check-skill.mjs → skills ok（skill exit=0）
$ node test/handoff-harness.mjs → === 582/582 checks passed（harness exit=0）
$ node test/readonly-default.mjs → === 12/12 checks passed（readonly exit=0）
$ node test/snapshot-shape.mjs  → === 18/18 checks passed
$ node /tmp/opencode/qcheck.mjs → === qcheck: 61 passed, 0 failed（自写假 ctx）
```

数字一致性：README `pnpm test # build + 582 项 harness`、CHANGELOG「`pnpm test` 现在 = **582 + 12 + 18**」与实测一致
（复核早期曾读到 581/579 的中间态，最终态已自洽）。

**S30 改动是否掩盖问题？** 逐条核对后：**没有**，理由三条：
1. 旧 S30 的「本仓 broadcast」路径在 D4 后**已不可达**（同仓必抛错），保留它反而会红；
2. 注入侧断言原样保留（首个注入有 bid、第二次无、子会话无、受保护无、随后 ack 提醒只一次）；
3. 被删掉的「工具写记录」环节，用 **S30 拒绝 + 零写入**（2 条断言）+ S92b（软链写法、预览也拒、零记录）
   与我自己的独立复现补回。
> 仅剩一个覆盖缝隙（非缺陷）：现在**没有**端到端用例覆盖「工具写出的 peer 记录 → 本工作区会话注入」
> （S30/S92c 都是直接写记录文件）。建议日后在跨仓 harness 里补一条，不进本任务的范围。

既有语义：`test/readonly-default.mjs` 工具清单加 `collab_request_owner` 后仍是 12/12；
只读默认 / grant / promote / locks / followup / stale 全部未受影响。

---

## 9. 安全

| 项 | 结果 |
| --- | --- |
| `BUILTIN_PROTECT` 未被移除/放宽 | ✅ `git diff src/constants.ts` 无该常量改动 |
| 队列不构成投递通道（0 prompt / 无 ack / 无「已送达」语义） | ✅ 见 §1 |
| 目录逃逸：`<targetSid>` 作为目录名先过 `^[A-Za-z0-9_-]{1,128}$`，`/`、`..` 不可能 | ✅ `src/core/owner-queue.ts:55-64` |
| `summary` ≤500、去控制字符、合并空白、单行 | ⚠ **部分**：C0+DEL 已去，**C1（U+0080–U+009F）与 bidi 控制符未去**（见 §5-F1） |
| `issuePath` 语法校验（相对、`docs/issues/<name>.md`、拒 `..`/绝对/超长；读时二次校验，坏值渲染成 `-`） | ✅ `src/core/owner-queue.ts:95-116, 130-137` |
| 队列不自动转任务、不改任何协作状态 | ✅ |
| 保护方向单向（受保护 → 任何目标均拒绝） | ✅ §2 |

---

## 10. 范围

**通过**：

- 改动文件与允许清单一致：`src/{constants,types,index}.ts`、`src/core/{owner-queue(new),chain,score,verdict}.ts`、
  `src/tools/{owner-queue(new),index,list,broadcast,handoff,shared}.ts`、`src/hooks/context.ts`、
  `test/{handoff-harness,readonly-default}.mjs`、`docs/collab.md`、`README.md`、`CHANGELOG.md`、
  `skills/collab{,-coordination}/SKILL.md`、`package.json`（仅 version + description），
  新增 `docs/issues/bugs-collab-d_6180f4ab4fb4368a.md` 与任务目录 `.trellis/tasks/11-18-collab-owner-queue/`。
- **无新依赖**（`package.json` 的 `devDependencies` / `dependencies` 未变）。
- **未碰** `muke-pos-app`（只读）、未碰已归档任务 `11-18-collab-followup-hardening`。
- `PLUGIN_VERSION = 0.4.0` == `package.json` 0.4.0（harness 断言）。

---

## 11. 发现清单（按严重度）

### F1（轻微不通过，建议修：1 行）`summary` / `issuePath` 未去 C1 控制字符

- 位置：`src/core/owner-queue.ts:82` 与 `:97`（`/[\u0000-\u001f\u007f]+/g`）
- 证据（最终构建，`/tmp/opencode/dbg4.mjs`）：

```
C1 NEL U+0085: stored="line1\u0085line2" hasLineBreak=true
C1 CSI U+009B: stored="a\u009bb"
bidi override U+202E: stored="safe\u202etxt.exe"
C0 + DEL: stored="a b c"            ← 只有 C0/DEL 被清掉
注入行: - [owner-queue] ses_plai…lain @ 14:58：line1\u0085line2（-）
```

- 影响：R4 写的是「summary 去控制字符」；`U+0085`(NEL) 是 Unicode 行终止符，`\s` 也不含它，
  因此模块注释 `src/core/owner-queue.ts:76-79`「can never introduce a second injected line」并不严格成立；
  `U+202E` 可在渲染层做视觉重排（把 `issuePath` 伪装到别处）。触发前提是**非受保护会话主动构造**这些字符，
  影响面仅限「受保护会话注入行里多一行/视觉错位」，不改变任何权限或状态。
- 建议补丁（保持既有约定，只多一段范围）：

```ts
.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, ' ')
```

  （`src/core/locks.ts:92,185`、`src/core/followup.ts:58` 是同样的旧写法，属项目既有约定，不必在本任务扩散修。）
- 是否阻断：**否**（不满足「明确安全缺陷」门槛：无权限影响、无投递、需发起方主动构造；但建议随 0.4.0 一起修掉）。

### F2（观察）`bid` 未校验、无长度上限，且落盘后从不渲染

- 位置：`src/tools/owner-queue.ts`（入参 `bid`）→ `src/core/owner-queue.ts:270`（`bid: bid ? String(bid) : null`）
- 说明：`summary` ≤500、`issuePath` ≤200，但 `bid` 无上限；而 `unseenHints` / `queueItemLine` **都不渲染 `bid`**。
- 建议：要么用 `isValidBid` 校验（≤ 合法 `b_…`），要么干脆不入库；至少加长度上限。

### F3（观察）`collab_grant` 的 5 条 allow 未包含新工具

- 位置：`src/constants.ts:136`（`COLLAB_TOOL_ACTIONS` 仍是 list/inbox/wait/reply/send）
- 影响：被 grant / spawn 自动授权的会话（如广播拉起的 `explore`）若想 `collab_request_owner`，
  取决于宿主是否按 action 校验自定义工具权限；按现状可能被拦。
- 说明：PRD 未要求，`readonly-default.mjs` 也仍断言 5 条，属**有意未改**；建议记一笔（下一轮决定是否加入）。

### F4（观察）`revokedAt` 是死字段

- `revoke` 直接删文件，`revokedAt` 永远是 `null`（`src/types.ts` 注释已写「kept for tolerant reads」）。
- 建议：文档/类型里标注「保留兼容、当前恒为 null」，或下一版删掉。

### F5（观察）重复提交不幂等，文档未说明

- 同 `(target, text)` 两次 = 两条项（§3 已实测）。建议在 `docs/collab.md §11.12` 的「边界」行补
  「不做 (target,text) 去重：重复提交会产生两条提示」。

### F6（观察）容量检查非原子

- `enqueue` 是「读未读计数 → 写文件」，并发两个发送方在 49 条时都可能通过（可短暂到 51）。
  有界、不损坏数据、`impl-notes.md` 已声明不加锁；可接受，留作记录。

### F7（观察）残余注入面（设计已接受，建议文档点明）

- 任何非受保护会话都可以把 ≤120 字的**自撰文本**放进受保护会话的 system block（以前完全不可能）。
  设计 §7 明确接受（「summary 是发起方主动提供的内容」），且只读、一次性、无回执要求、无指令模板；
  但 `docs/collab.md §11.12` 的「边界」行没有写出这一点。建议补一句「行内正文由发起方撰写，仅作提示，不是指令」。

---

## 12. 原始输出（节选，逐字）

### ① 门禁（最终源码，14:58 构建）

```
$ pnpm build
dist/gui-experimental.cjs  13.28 kB │ gzip: 4.33 kB
✓ built in 161ms
build+tc exit=0

$ pnpm typecheck
$ tsc --noEmit

$ node scripts/check-skill.mjs
skills ok
skill exit=0

$ node test/handoff-harness.mjs
=== 582/582 checks passed
harness exit=0

$ node test/readonly-default.mjs
=== 12/12 checks passed
readonly exit=0

$ node test/snapshot-shape.mjs
=== 18/18 checks passed
```

### ② 自写假 ctx（`/tmp/opencode/qcheck.mjs`，61 条断言）

```
=== qcheck: 61 passed, 0 failed
```

覆盖：预览零写入 / 0 prompt·0 storage·0 create·0 bid·0 thread·0 lock / 方向三拒 /
50 条上限与不驱逐 / 已读不占名额 / 预览·旁观者·id-only revoke / 3 行上限与 FIFO 顺序 /
每条一次 / 抛错不 stamp 下轮重试 / 子会话只看自己的 / 普通会话 0 行 / list 视图与空分支 /
三值枚举 / push+pull research 文案 / explore+implement 结果提示 / 同仓（原样 + 软链）拒绝且零记录 / 跨仓不受影响。

### ③ `research` 的 push 接管文案（spawn 路径，最终构建）

```
期望：research
（本次期望是「只读排查」：只读代码/提案并给出结论，不要改代码；要改代码需发起方另发 implement。）
...
③ 本次是只读排查：不要改代码；结论（发现 / 建议 / 风险）写进最后一条回复，并用 ② 的 collab_send 真正发出。
```

### ④ `research` 的 pull 接管文案（受保护发起方的 ask 行）

```
- 接管请求 b_c0de0000000000a1：cold pull research（提案 docs/issues/fix-x.md，期望 research，影响面 (未标注)）
  发起方=ses_e1eb91cebffeTv1467ubJLKebk → ① 领取… ② 回执（pull 模式，必写）：在本会话最后一条回复里写一行
  `[handoff] DONE b_c0de0000000000a1 <摘要>`… 不要尝试 collab_send：发起方在 protect 名单内，投递会被拒绝。
  ③ 本次是只读排查：不要改代码；结论（发现 / 建议 / 风险）连同上面的 [handoff] 行写在本会话最后一条回复里。
```

### ⑤ 空会话分支也输出发起方视图

```
工作区 /tmp/opencode/dbg6/anywhere 下没有可列出的会话。
我提交给受保护会话的请求：1 条待处理（只读提示，未投递；不是送达通道）:
- q_mwlrshtp_0iow → ses_e1eb…Kebk  14:58  "empty branch probe"
撤回: collab_request_owner { id:"<q_…>", revoke:true, confirm:true }
```

### ⑥ 上限按未读计（owner 读掉 3 条后仍可写）

```
未写入（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true；即使确认也不会投递。
...
当前未读: 47 条（另有 3 条已读到）（每目标上限 50 条未读，满则拒新；已读项 7 天后回收）
...
已写入受保护会话请求队列：q_mwlrqm01_u5g9        ← 真实写入成功，共 51 文件
```

### ⑦ 能力不匹配（confirm:true 的**结果**，不只是预览）

```
注: 承接方为只读 agent（explore），implement 期望可能无法完成；建议 expected:"research"（只读排查 + 结论）
或显式 collab_promote { target, confirm:true } 之后再交接。
```

---

## 13. 是否可提交

**是（无阻断）**。建议按以下顺序处理，然后由主会话复核后提交：

1. **F1**（1 行正则，`src/core/owner-queue.ts:82` + `:97`）——建议本次带上；
   若不带，请在 CHANGELOG「已知限制」写明「C1 控制字符/Bidi 控制符未过滤」。
2. **F5 / F7**（各 1 句文档）——`docs/collab.md §11.12` 补「不去重」「正文由发起方撰写，仅提示不是指令」。
3. **F2 / F3 / F4 / F6**——可留 TODO，不阻断 0.4.0。

提交前请再跑一次：`pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs`
（预期 582 + 12 + 18 全绿）。

> 本报告由冷上下文复核代理产出；未修改任何实现文件、未执行 `git add/commit/push`、未向受保护会话投递任何内容。
> 复现脚本：`/tmp/opencode/qcheck.mjs`、`dbg4.mjs`（清洗）、`dbg5.mjs`（上限/预览）、`dbg7.mjs`（research 文案）、
> `dbg8.mjs`（能力不匹配结果），均使用 `dist/index.js` 快照 `/tmp/opencode/plugin-snapshot2.mjs` 与临时目录下的假 ctx。
