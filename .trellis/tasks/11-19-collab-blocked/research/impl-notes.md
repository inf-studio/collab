# 实现笔记：BLOCKED 结构化（`blocked`，0.7.0）

任务：`.trellis/tasks/11-19-collab-blocked`（PRD R1–R4 / design §1–§6 / implement.md）
基线：`b806e07`（交接链 **823** 条检查全绿）

---

## 1. 改了什么（文件清单）

| 文件 | 改动 |
| --- | --- |
| `src/types.ts` | 新增 `BroadcastBlocked { need, excluded, minimalTest, at, by }` / `BlockedSpec`；`BroadcastRecord.blocked?: BroadcastBlocked[]` |
| `src/core/verdict.ts` | 新增：`BLOCKED_KEEP=3` / `NEED_LIMIT=10` / `EXCLUDED_LIMIT=20` / `ITEM_CHARS=120` / `TEST_CHARS=200` / `AGGREGATE_ITEMS=3`；`normalizeBlocked`（校验 + 清洗 + 可读拒绝）、`blockedHistoryOf`（容忍读）、`appendBlocked`（保留最近 3）、`blockedLines`（三段渲染，`max` 控制聚合）、`blockedInjectionLines`（承接方注入块）；`takeoverBody` 在「期望」之后、「发起方 / 按顺序完成」之前插入聚合块 |
| `src/tools/send.ts` | 入参 `blocked`；`withMeta` = `origin` 首行 + 正文 + 三段（正文之后）；`finish` = `dispatch` + 有 bid 时写记录（`state/claim/receipt` 不动）、无 bid / 预览 / 记录不存在 / 非参与方 → 回执注明未落库 |
| `src/tools/handoff.ts` | 入参 `blocked`；投递正文 = 协议头 + 正文 + 三段；预览列出将追加的三段；新记录写 `blocked[]`；幂等分支只追加 `blocked`（不重投、不改状态） |
| `src/tools/status.ts` | `formatBlock` 增「BLOCKED（结构化，最新一次 / 历史 N 次；sid @ 时刻）」+ 三行（各 ≤3 条 + 「还有 N 条」）；描述同步 |
| `test/handoff-harness.mjs` | 新增 S105（20 条检查 + 真实叫醒链路） |
| `docs/collab.md` | 工具表 3 行 + 新增 §11.18（字段/校验/存储/三处渲染/护栏/测试/回滚） |
| `skills/collab/SKILL.md` | 3 行工具速查 + 「一点八·再补：结构化 BLOCKED」；frontmatter description 加一句 |
| `CHANGELOG.md` | 0.7.0 窗口导语 + Added 一条（R1–R4）+ Tests 一条（S105 + 三组变异） |

**没有改**：`src/tools/shared.ts`（`dispatch` 不感知 `blocked`，正文在 `send`/`handoff` 里拼好再传）、
`src/hooks/context.ts`（not in 任务允许清单）、`src/core/chain.ts`（同上）、`src/constants.ts`、版本号（仍 0.6.0）。

---

## 2. 「三处渲染」的实测

### ① 投递正文（`collab_handoff`，S105a 原始输出）

```
[collab:ses_s105…05me][request:t_mwn86ni1_nypq] 你是承接方（bid=b_393e164fd02da7f2 / thread=t_mwn86ni1_nypq）
完成后回执：collab_reply { threadID:"t_mwn86ni1_nypq", text:"[handoff] DONE b_393e164fd02da7f2 <摘要>", confirm:true }
阻塞回执：collab_reply { threadID:"t_mwn86ni1_nypq", text:"[handoff] BLOCKED b_393e164fd02da7f2 <缺什么>", confirm:true }

S105 卡在房态刷新：需要一次最小判别

需要对方：① 把房态改成「在住」后再触发一次入住 ② 给出 09:00–10:00 的后端推送日志
已排除：不是权限问题（已用 admin 复现）；不是时钟偏移（NTP 正常）
最小判别：改一次房态，看有没有帧下发：有帧 = 前端问题，无帧 = 后端推送未触发。
```

- 协议头 / 正文**一字未改**，三段只追加在正文之后（`indexOf(正文) < indexOf('需要对方：')`）。
- 记录：`{"need":[2 条],"excluded":[2 条],"minimalTest":"…","at":1795…,"by":"ses_s105me"}`，`state` 仍 `acked`。
- 设计写「正文之后、协议头之前」：本版本协议头固定在消息**首行**（0.7.0 协议头不变式，S99 断言前缀），
  因此落点是「正文之后（消息末尾）」；`takeoverBody` 里则确实在「正文（标题/提案/影响面/期望）之后、
  协议动作块（发起方 + ①②③）之前」。两处都不插入正文内部。

### ② 承接方注入（`takeoverBody`：叫醒 / spawn / 重发，S105g 原始输出）

真实链路：广播问询候选（idle，0 prompt）→ 候选把结构化 BLOCKED 写进这条**未闭环**记录（`state` 仍 `open`）
→ 候选转 busy 45min → 再广播触发出 1 条叫醒 prompt：

```
[collab:ses_s105…05me][request] 你是承接方（bid=b_bf4c7360960e3e4d）
完成后回执：[handoff] DONE|BLOCKED b_bf4c7360960e3e4d <摘要>（…）
[collab-handoff] blocked 注入（11-17-worker-store）
提案：docs/issues/fix-blocked-inject.md（工作区 /tmp/collab-harness-VLy8wa/ws/x，scope=peer）
影响面：packages/state/src/machine/worker/store.ts
期望：implement
上一位承接方的 BLOCKED（结构化，ses_s105…105l）:
  需要对方：① 给出 09:00 的后端日志
  已排除：不是权限
  最小判别：改房态看有没有帧
发起方：ses_s105me
按顺序完成（三步都不要省略）：
① 领取（先做；领取即 acked）：collab_accept {bid:"b_bf4c7360960e3e4d", confirm:true}
…
```

- 断言：`prompts.length === before + 1`、三段齐全、`indexOf('最小判别：') < indexOf('按顺序完成')`；
  叫醒的 read-merge-write（`writeBroadcast({...woke.record})`）**不丢** `blocked`。

### ③ `collab_status { bid }`（S105e 原始输出）

```
b_dd05000000001051  state=acked  priority=normal  承接=ses_s105…05to（accept）  canPush=true  "S105 结构化 blocked fixture"
  投递: -（本单没有投递记录）
  BLOCKED（结构化，最新一次 / 历史 3 次；ses_s105…05to @ 15:25:14）:
    需要对方：① 给 09:00 的推送日志 ② 把房态改回在住 ③ 给出设备 id（还有 2 条）
    已排除：不是权限；不是时钟；不是网络（还有 1 条）
    最小判别：改房态看有没有帧：有帧 = 前端，无帧 = 后端
  队列: 0 项
  最近回复: -
  下一步: 等对端回执（已 acked）→ collab_wait {target}（该单没有 threadID）；静默过久会被自动提取
```

- 只读（沿用 §11.14 的只读契约；本任务没在 status 里加任何写调用）。

---

## 3. 不传 `blocked` → 逐字一致

- `collab_send`（S105b）：`prompts.at(-1).text === '[collab:ses_s105…05me][note:t_s105plain] S105 无 blocked 的正文'`
  （精确相等，不是 `includes`）。
- `collab_handoff`（S105b2）：`text` 以 `'\n\n' + body` 结尾、无 `需要对方：` / `最小判别：`、记录里**没有** `blocked` 键。
- 解析侧不受影响：`[handoff] BLOCKED <bid>` 仍是正文首行（`parseReceiptLine` 按行匹配），三段在其后。

---

## 4. 校验与可读拒绝（0 投递、0 写入）

```
✓ S105 blocked.excluded 21 条 → 可读拒绝 — blocked.excluded 最多 20 条（本次 21 条）—— 未发送任何内容（不静默截断）
✓ S105 blocked.need 单条 121 字 → 可读拒绝 — blocked.need[0] 最长 120 字（本次 121 字）—— 未发送任何内容（不静默截断）
✓ S105 blocked.minimalTest 201 字 → 可读拒绝 — blocked.minimalTest 最长 200 字（本次 201 字）—— 未发送任何内容（不静默截断）
✓ S105 blocked 全空 → 可读拒绝 — blocked 不能为空：need / excluded / minimalTest 至少给一项 —— 未发送任何内容
✓ S105 blocked 不是对象 → 可读拒绝 — blocked 必须是对象：{ need?: string[], excluded?: string[], minimalTest?: string } —— 未发送任何内容
✓ S105 五类非法输入都是可读拒绝：0 投递、0 写入（广播目录一字未变） — 0 deliveries / bids 97
```

- 计数按 **code point**（`[...text].length`），所以 emoji / 全角都按「字」算。
- 清洗：控制字符（含 `\n`）→ 空格、空白折叠；三段都是单行，**不能借换行伪造注入块的第二行**。
- 校验发生在 `execute` 最前面（`normalizeBlocked`），因此护栏 / 投递 / 写盘一次都没发生（`bcBids()` 前后一致、
  `prompts.length` 不变）。

---

## 5. 落库 vs 不落库

| 输入 | 结果 |
| --- | --- |
| 有 `bid`（入参或正文 `b_…`）、`confirm:true`、记录存在、调用方是参与方 | 写 `record.blocked[]`，回执 `注: blocked 已写入记录 b_…（保留最近 3 次；state / claim / receipt 未改）。` |
| 无 bid | `注: blocked 未关联单据（bid 入参与正文都没有 b_…）—— 已渲染进正文，未落库。` + 广播目录不变（S105d） |
| `confirm:false` 预览 | `注: 预览（confirm 不为 true）—— blocked 未落库；确认后会写进记录 b_…。`（正文仍带三段预览） |
| 记录不存在 | `注: 没有交接单 b_…（拼错或已过 7 天保留期）—— blocked 已渲染进正文，未落库。` |
| 非参与方 | `注: 当前会话不是 b_… 的参与方（from / claim.by / asked / origin）—— 已渲染进正文，未落库。`（S105f：记录 JSON 一字不动） |

**为什么加「参与方」判定**（design 未写，按 G2 低风险自决并记录）：`blocked` 是**会被渲染进别人注入块**的自由文本。
若任何会话只要知道 bid 就能追加，等于给「往候选注入里塞字」开了一条旁路。参与方 = `from` / `claim.by` / `asked` /
`origin`，覆盖真实用法（发起方补充、承接方上报、被问询者回写）；无会话上下文（`me` 缺失）或手写记录的参与方列表为空时
**不做额外限制**（与既有「无 sessionID 不做身份校验」一致）。

`collab_handoff` 幂等分支（同 target + 同正文）：**不重投**，但如果这次带了 `blocked`，仍追加进记录
（回执 `注: blocked 已写入记录 b_…（保留最近 3 次；未重复投递…）`）——否则「重试一次带判别」会静默丢信息。

---

## 6. 连续 4 次 → 保留最近 3 次

```
✓ S105 连续 4 次：记录只保留最近 3 次（最旧的一条被挤掉） — ["判别二","判别三","改房态看有没有帧：有帧 = 前端，无帧 = 后端"]
✓ S105 state / claim / receipt 前后完全一致（blocked 是纯展示字段）
   — {"state":"acked","claim":{"by":"ses_s105to","kind":"accept","at":1,"token":"k_s105"},"receipt":{"from":"ses_s105to","at":2,"note":"初始回执，保持不动"}}
  /  {"state":"acked","claim":{"by":"ses_s105to","kind":"accept","at":1,"token":"k_s105"},"receipt":{"from":"ses_s105to","at":2,"note":"初始回执，保持不动"}}
```

（`appendBlocked` = `[...blockedHistoryOf(record), next].slice(-3)`；`blockedHistoryOf` 在写之前重新清洗一遍，
所以手改记录也不会把脏数据带进渲染。）

---

## 7. 变异验证（原始输出）

### 变异 ① `blockedLines` 丢 `minimalTest`（`if (entry.minimalTest) lines.push(…)` 删除 → build → 跑 harness）

```
=== 839/843 checks passed
FAIL: S105 handoff 正文：需要对方 / 已排除 / 最小判别 三段都在，且追加在正文之后
FAIL: S105 无 bid：三段仍进正文，回执注明「未关联单据 / 未落库」，0 写入
FAIL: S105 collab_status：最新一次的三段（各 ≤3 条 + 「还有 N 条」）+ 历史次数
FAIL: S105 承接方注入（叫醒 / takeoverBody）含三段，且在「按顺序完成」之前
```

→ 三处渲染 + 无 bid 分支都真的由这一个渲染函数供给（不是各写一份）。

### 变异 ② 去掉无 bid 早退（`if (!bid) { return …未关联单据… }` 删除 → 走到 `readBroadcast('')`）

```
=== 842/843 checks passed
FAIL: S105 无 bid：三段仍进正文，回执注明「未关联单据 / 未落库」，0 写入
```

→ 「无 bid 不落库、且回执说清楚」这条断言真会失败（不是永远为真）。

### 变异 ③ 去掉参与方判定（`if (me && participants… && !includes(me))` 删除）

```
=== 842/843 checks passed
FAIL: S105 非参与方：正文照渲染，但记录一字不动（不落库）
```

→ 与设计「无 bid 分支也写记录 → 断言失败」同类：证明「不该写的写不进去」是被测住的。

三次变异都已还原（`src/core/verdict.ts` / `src/tools/send.ts` 从备份恢复，`grep MUTATION` 为空），
还原后重跑 **843/843** 全绿。

---

## 8. 回归与验收

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
BUILD_OK
$ tsc --noEmit                      （无输出 = 通过）
=== 843/843 checks passed           handoff-harness（823 → 843，+20）
=== 12/12 checks passed             readonly-default
=== 20/20 board checks passed       board-shape
=== 50/50 checks passed             snapshot-shape
=== 49/49 checks passed             tui-render
=== 47/47 checks passed             gui-entry
=== 17/17 panel checks passed       gui-panel
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok
```

- 工具面仍 **21**（S105h 断言，S102j 也仍过）；版本号未动（`0.6.0`，0.7.0 统一发版时再改）。
- 未新增依赖；未做任何 git 写操作。

---

## 9. 边界与已知取舍

1. **注入点选择**：任务允许清单里只有 `src/core/verdict.ts`（「如需注入点」）。因此「接收方注入」落在
   `takeoverBody`（spawn / 叫醒 / 重发的承接方注入），没有改 `src/hooks/context.ts` 与 `src/core/chain.ts`
   （两者不在允许清单内）。`collab_send` 的正文本身就是对端的一条 user turn，三段随正文直达，无需再注入。
2. **`collab_reply` 不加 `blocked`**：PRD 只要求 `collab_send` / `collab_handoff`；回执需要结构化时用
   `collab_send {kind:"reply", bid, blocked}`（既闭环又落库）。
3. **`blocked` 不强制 kind**（design §4）：工具不检查正文是否含 `[handoff] BLOCKED`；文档建议同行，
   否则记录不会闭环（`state` 不变），但结构化信息仍可见。
4. **`collab_list` / 看板不展示 `blocked`**：design 只要求注入 + `collab_status`；快照契约（GUI/TUI）未改，
   避免 board/snapshot 的 50 + 49 项断言出现无关变更。
5. **旧记录**：没有 `blocked` 字段 → `blockedHistoryOf` 返回空 → 三处渲染为空，输出与旧版逐字一致（S105b 断言）。

---

## 10. 复核修复（round 2，2026-11-19）

复核报告：`research/check-report.md`（结论「需修」：F1 预览写盘 / F2 参与方旁路必修，F3 去重命中重复追加为建议）。
根因是同一件事：`blocked` 的「能不能写」原来有两份实现——`collab_send` 抄在 `recordBlocked` 里，
`collab_handoff` **新单**路径靠 `confirm` 门，而 **幂等分支**（`readBroadcast(bid)` 命中后提前 return 的那条）
既没有 `confirm` 门也没有参与方判定。

### 10.1 改法

| 文件 | 改动 |
| --- | --- |
| `src/core/verdict.ts` | 新增 `canWriteBlocked(record, who)`：**唯一**参与方规则（`from` / `claim.by` / `asked` / `origin`；无 sid 或记录无任何参与方字段时 fail-open，与既有「无 sessionID 不做身份校验」一致），`appendBlocked` 注释改成「调用方必须先过 `canWriteBlocked`」 |
| `src/tools/handoff.ts` | 幂等分支加两道门：`confirm:false` → `注: 预览（confirm 不为 true）—— blocked 未落库…`；`!canWriteBlocked` → `注: 当前会话不是 b_… 的参与方… blocked 未落库`；两者都不写盘、不改 `state/claim/receipt` |
| `src/tools/send.ts` | 改用 `canWriteBlocked`（删掉本地那份 participant 列表）；`finish` 用 `confirm:true && result.delivery === undefined` 识别**去重命中**（`dispatch` 只有真正投递成功才返回 `delivery` 回执），命中时跳过写盘并在回执说明（F3） |

F3 的回执措辞：`注: blocked 未落库（同文去重命中、本次未投递；记录里已有的那一条已含这段）。`

### 10.2 新增断言（S105i / S105j / S105k，843 → 846）

```
--- S105i idempotent preview
注: 预览（confirm 不为 true）—— blocked 未落库；确认后会写进记录 b_c47104d6f12a35d4。
注: blocked 已写入记录 b_c47104d6f12a35d4（保留最近 3 次；未重复投递，state / claim / receipt 未改）。
  ✓ S105 handoff 幂等分支：confirm:false 预览不落库，确认后才写（复核 F1） — before=0 preview=0 confirm=1 / 0 prompt(s)
  ✓ S105 handoff 幂等分支：非参与方不写别人的记录（复核 F2） — 注: 当前会话不是 b_c47104d6f12a35d4 的参与方（from / claim.by / asked / origin）—— blocked 未落库。
  ✓ S105 去重命中：不重复追加 blocked（不白占最近 3 次名额，复核 F3） — 3 → 3 → 3 / 注: blocked 未落库（同文去重命中、本次未投递；记录里已有的那一条已含这段）。
```

- S105i 同时断言「确认后才写」（防止把门修成「永远不写」）：`before=0 → preview=0 → confirm=1`，
  且两次幂等重复都不重投（`0 prompt(s)`，幂等分支本来就不投递）。
- S105j 用**同一 target + 同一正文**（=> 同一 bid）由第三方调用，命中同一条幂等分支，断言记录 JSON 一字不动。
- S105k 用 `S105_REC` 连发两次同文：第一次 `已写入记录`、第二次 `未重复投递` + `去重命中`，`blocked` 数组 JSON 不变
  （`3 → 3 → 3`，且最后一条仍是新写的那条），证明没有白占名额。

### 10.3 变异（原始输出）

```
# ④ 去掉 handoff 幂等分支的 confirm 门
=== 845/846 checks passed
FAIL: S105 handoff 幂等分支：confirm:false 预览不落库，确认后才写（复核 F1）

# ⑤ 去掉 handoff 幂等分支的 canWriteBlocked 判定
=== 845/846 checks passed
FAIL: S105 handoff 幂等分支：非参与方不写别人的记录（复核 F2）

# ⑥ 去掉 send 的去重命中跳过
=== 845/846 checks passed
FAIL: S105 去重命中：不重复追加 blocked（不白占最近 3 次名额，复核 F3）
```

三次都已还原（`handoff.ts` / `send.ts` 从备份恢复，`grep MUTATION` 为空），还原后 **846/846**。

### 10.4 回归

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
=== 846/846 checks passed           handoff-harness（843 → 846，+3）
=== 12/12 checks passed
=== 20/20 board checks passed
=== 50/50 checks passed
=== 49/49 checks passed
=== 47/47 checks passed
=== 17/17 panel checks passed
skills ok
```

工具面仍 21（S105h）、版本仍 0.6.0、无新依赖；文档（docs §11.18 存储/不落库/测试段、README、skill、CHANGELOG）
已同步「两道门 + 去重命中不落库」，与实现一致（复核 F4 的措辞不符已消解）。

F5（正文里取**第一个** `b_…`）保持现状：仍受「记录存在 + 参与方 + `confirm`」三重约束，回执会写明写入的是哪一单；
改成「必须显式 `bid` 入参」会破坏 `[handoff] BLOCKED b_…` 的既有用法（回执正文天然带 bid），因此只记录不改。
