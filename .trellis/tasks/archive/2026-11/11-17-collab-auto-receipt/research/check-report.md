# 独立复核报告：强制回执动作 + 租约到期自动提取（11-17-collab-auto-receipt）

> 复核角色：冷上下文只读复核（`trellis-check`），**只审不改**；未做任何 git 写操作，未改实现文件。
> 基线：`HEAD=c7b84f465`；被审对象 = 工作区未提交改动（`.opencode/plugins/collab.js` +451 行、
> `scripts/collab/handoff-harness.mjs` +359 行、guide、`docs/collab.md`）。
> 复核时间：2026-11-17 14:0x（本地）。

## 0. 结论

- **R1 / R2 / R3 / R4 的实现与 AC 全部对得上**：186/186 全绿、`node --check` 0、`pnpm test:collab` exit 0；
  我用**自建假 ctx + 伪造 `claim.at`**（不复用 harness）独立复现了 R2 的四种分支 + R1 的四处文案，38/38 通过。
- **AC 全绿、可提交**（无越界改动、无护栏违规、无 push/重启），但**建议合并前先修两处**：
  ① H1 —— `verdictFromTexts()` 有多条可复现的「未完成 → 判 done」误闭环路径（见 §4 H1），
  其中一条正是 R1 自己在接管请求里写出的 `[handoff] DONE <bid> <摘要>` 模板被对端回显；
  ② L2 —— `docs/development.md:119` 仍写 155 checks。修好后再重载插件。
- 其余为文档/成本级小问题（M1/L1–L6），不阻塞提交。

## 1. 必查 10 项（逐条）

### 1. R1 文案三要素 — **通过**

`handoffActions({bid, requester, spawn, leaseMin})`（`.opencode/plugins/collab.js:1133`）生成
① `collab_accept {bid:"<bid>", confirm:true}` / ② DONE + BLOCKED 两条 `collab_send {target:"<发起方 ses_…>", …}` /
③「只分析、不调用工具 = 未完成」；非 spawn 追加 `DECLINE` +「5 分钟不答自动顺延」

四处 `handoffActions()` 调用点 + `collab_accept` 输出都接上了，且 `bid`/`ses_…` 都是字面量（非占位）：

| 位置 | 行 | 我复现的断言 |
| --- | --- | --- |
| `context` 注入的接管请求行 | `:1735`（`handoffActions(...).join(" ")`） | 独立 #14：①②③ + 完整 bid + `collab_send {target:"ses_req", text:"[handoff] DONE <bid>` ✓ |
| 叫醒 prompt（busy>30min，`deliverAsk` wake） | `:2072`（`deliverAsk`） | 独立 #16：真有 busy 45min 的 top-1 → 收到 prompt，内含 ①②③ + `target:"ses_host"` + DECLINE ✓ |
| spawn 接管请求 | `:2072` + `spawn:true` | 独立 #15：有 ①②③，**无 DECLINE** ✓ |
| `collab_broadcast` 结果（spawn 分支 / 串行分支） | `:2431` / `:2483` | 独立 #15/#16：两处均含 ①②③ ✓ |
| `collab_accept` 输出（回执可复制） | `:2732` / `:2803` | 含 `collab_send {target:"<from.sid>", text:"[handoff] DONE <bid> …", confirm:true}` ✓ |

> 预览分支（`collab_broadcast confirm:false`，`:2316`）不含 ①②③——未发生投递，可接受。

### 2. R2 触发条件 — **通过**

`refresh()`（`:1644`）门槛：`state === "claimed"` && `claim.kind === "spawn"` && 租约过期 && `from.sid` 存在；
否则直接 `refreshBroadcast()`（`:1652`）。

- 未到期 spawn：`state=claimed, attempts=0, 无 receipt`（独立 #50 类；harness S50）✓
- `kind=accept` 过期：`state=open, attempts=1`，且**未读**对端（`context` 调用记录里没有该 sid）✓（独立 #8）
- `state=acked` 过期：不提取（独立 #8b）✓
- `[protected*]` 承接方：`protectedAncestor` 命中 → 不读不闭环（`:1654`，独立 #9：`context` 从未被调用）✓
- 消息早于 `claim.at` 被丢弃（`assistantTexts` 的 `since`，`:1087`；独立 #7）✓

### 3. R2 判定 — **通过（有保留，见 H1/H2）**

`verdictFromTexts()`（`:1108`）：先倒序找 `[handoff] DONE|BLOCKED`（`:1039`）直接采用；否则只判**最后一条**
（blocked 词优先 `:1046`，done 词 `:1048`，且先剔除「分析/核对/排查…完成」`:1054`）。

- 显式前缀优先于关键词：`[handoff] DONE … 已修复并提交 79eac02d` → `done`（独立 #2）✓
- `已实施/无需` → `blocked`（独立 #3）✓；`实现完成，测试通过` → `done`（独立 #4）✓
- `核对完成，详见上面…` → 不判 done，走顺延（独立 #5b、harness S47）✓
- 10 条窗口边界：第 12 条之前的历史 `[handoff]` 不被采纳；第 10 条之内采纳（独立 #20，双向）✓

### 4. R2 闭环副作用 — **通过**

判定成功时（`:1661`–`:1668`）：`state=done|blocked`、`receipt{from,by,at,note,auto:true}`、`autoVerdictAt`、
`releaseLock(bid,[claim.by, claim.spawner])`；**不** `attempts++`、**不** `delete claim` 走 reopen、**不** 拉新。

- 独立 #1：`state=blocked / attempts=0 / lock 已释放 / created+0 / prompts+0` ✓
- 判定失败：`state=open, attempts=1, skipped=[接入者], 无 receipt`（独立 #5、harness S47）✓
- 终态不再重复提取（独立 #11：第二次 `collab_accept` 未再读对端，直接「已闭环」）✓

### 5. R3 安全 — **通过（一条成本级偏差见 L1）**

- 只读：唯一新读路径 `ctx.session.context({sessionID})`（`:1612`），try/catch → `[]`；`extractVerdict` 外层再 try/catch（`:1625`）。
- 404 / 抛出 / 无 assistant / 只有 user 消息 → `undefined` → 原顺延，**不抛错**（独立 #6、harness S48）✓
- 只存摘要：`verdictNote` = 折叠空白 + `slice(0,200)`（`:1062`，`VERDICT_NOTE_LIMIT=200` `:173`）；
  记录文件里找不到正文尾部标记（独立 #10：`note=200 chars`，`tailFound=false`）✓
- `[protected*]` 不参与（同上）✓

### 6. 提醒 — **通过**

`injectionFor` 的「交接未闭环」分支显式跳过 `done`/`blocked`（`:1759`），`expired` 仍提醒。

- 自动闭环的 bid 不再出现在 `交接未闭环` 行（独立 #13）✓
- 提醒仍**只一次**：伪造 `acked` 过期记录 → 首次注入有该行、第二次注入没有（独立 #21）✓

### 7. 回归 — **通过**

| 命令 | 结果 |
| --- | --- |
| `node --check .opencode/plugins/collab.js` | exit 0 |
| `node scripts/collab/handoff-harness.mjs` | `=== 186/186 checks passed`，`✗` 0 条，exit 0 |
| `pnpm test:collab` | `=== 186/186 checks passed`，exit 0 |
| 旧用例语义 | harness diff 只有两个 hunk（文件头注释 + 追加 S44–S50）；按标题切分 = **155 旧 + 31 新 = 186**，旧断言一行未改 |
| `vp fmt --check` / `vp lint`（两个被改 js/mjs） | `All matched files use the correct format.` / exit 0，无 findings |

### 8. 范围 — **通过（工作区里有别的会话的改动，已区分）**

本任务只动了 4 个文件（`collab.js` 13:59:58、harness 14:00:17、guide 14:00:14、`docs/collab.md` 14:00:31）。

工作区其它未提交项**不属于本任务**，已核验：
`packages/schemas/src/reserve.ts`(10:57)、`packages/machine/src/reserve/impl.ts`(14:02)、
两个 reserve 测试、`docs/issues/feat-worker-onboarding-approval-delivered.md`(11-16)、
`.trellis/tasks/11-17-parity-wait-chip/task.json`、`mcp` 子模块 dirty。
`git diff packages/ | grep -icE 'collab|handoff'` = **0**。
未改 `apps/**`、`bench/**`、归档任务、`/data/project/muke-interface`。

### 9. 文档 — **基本通过（3 处小偏差：L2/L5）**

- guide §4-3 / §5.2 / §5.3 / §6 / §8 / §9 / §10#11 / §11 与代码一致：三步文案、自动提取表（显式前缀 / 关键词 / 无法判定）、
  `receipt.auto` + `autoVerdictAt`、只读边界、`[protected*]` 排除、200 字摘要、186 计数 ✓
- `docs/collab.md` §12.2 / §12.3 ⑥ / §12.5 #10 同步 ✓
- 偏差：`docs/development.md:119` 仍写 `155 checks`（应 186）；guide §9 写「只取最后一条 assistant 回答」，
  实现是「尾部最多 10 条（关键词只判最后一条）」；guide §6 示例把手动 receipt 写成 `auto:false`，实际手动路径无该字段。

### 10. 护栏 — **通过**

- 未向 `ses_e1eb91cebffeTv1467ubJLKebk`、`ses_e23a4a23fffe4c4m7UQFR8dUL3` 及其子会话投递：
  diff 里新增的提取路径有 `protectedAncestor` 前置；`deliverAsk`/`collab_send` 原有护栏未改。
- 未删会话：diff 没有新增 `session.remove`/`unlinkSync`（唯一 `releaseLock` 是原有函数）。
- 未 `interrupt`：diff 无 `interrupt`，`deliverAsk` 仍 `delivery:"queue"`。
- 未重启服务：`opencode … serve --service` 启动于 **11-15 12:06**（`etime 2-01:58`），晚于 `collab.js` 改动；
  `/api/plugin` 显示 `collab`、`collab-global` 均 `active`（只代表已加载，运行时仍是旧码）。
- 未写真实广播目录：`~/.config/opencode/collab-broadcast/` 只有 11:04 与 13:56 两条旧记录，**14:00 后无新文件**；
  真实会话列表里没有本任务新拉的 `impl:*`（现存两条是 pilot/别的任务 03:02、05:51 UTC）。

## 2. 必跑命令原始输出

```text
$ node --check .opencode/plugins/collab.js
(no output)                                   node-check exit=0

$ node scripts/collab/handoff-harness.mjs | tail -6
  ✓ S50 a live spawn lease is never extracted — {"state":"claimed","attempts":0}
  ✓ S50 a lapsed accept-kind claim is not extracted either — {"state":"open","attempts":1}
  ✓ S50 a protected claimant is never read and never auto-closed — {"state":"open","attempts":1}

=== 186/186 checks passed
                                              harness exit=0    (✗ 计数 = 0)

$ pnpm test:collab
=== 186/186 checks passed
                                              test:collab exit=0

$ opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD" | (collab 过滤)
[ { "id": "collab-global", "state": { "status": "active" } },
  { "id": "collab",        "state": { "status": "active" } } ]

$ node_modules/.bin/vp fmt --check .opencode/plugins/collab.js scripts/collab/handoff-harness.mjs
All matched files use the correct format.
$ node_modules/.bin/vp lint  .opencode/plugins/collab.js scripts/collab/handoff-harness.mjs
(no findings)  lint exit=0

# 旧/新用例切分（按标题）
total=186  S44-S50=31  others=155  failed=0
```

## 3. 自建假 ctx 的独立复现（不复用 harness）

脚本：`.trellis/tasks/11-17-collab-auto-receipt/research/check-independent-r2.mjs`
（`node .trellis/tasks/11-17-collab-auto-receipt/research/check-independent-r2.mjs`；copy 插件到临时目录、`COLLAB_BROADCAST_DIR` 指向临时目录、
自写 `ctx.session.{get,list,context,create,prompt}`、直接写 `b_*.json` 并伪造 `claim.at = now-301000`）。
入口用 `context` 注入 + `collab_accept`/`collab_broadcast` 工具，不碰真实会话。

```text
PASS 1  explicit [handoff] BLOCKED → blocked；receipt.auto=true；note 含「已实施」且去 bid；
        attempts=0；spawn lock 释放；created+0 / prompts+0
PASS 2  explicit DONE 压过摘要里的「已修复」→ done
PASS 3  关键词 已实施/无需 → blocked
PASS 4  关键词 完成 → done
PASS 5  无结论 → open + attempts=1 + skipped + 无 receipt
PASS 5b 「核对完成」→ 不判 done
PASS 6  context 抛 404 → 不抛错 + 走原重开路径
PASS 7  早于 claim.at 的 assistant 被忽略
PASS 8  kind=accept 过期 → 不提取、不读
PASS 8b state=acked → 不提取
PASS 9  [protected] 承接方 → 不读、不闭环
PASS 10 摘要 200 chars 上限；正文尾部标记不在记录文件里
PASS 11 已闭环不再读、再 accept 只报「已闭环（state=blocked）」
PASS 12 较新的回答无结论、较老的回答有 [handoff] → 采纳（窗口内回溯）
PASS 13 自动闭环的 bid 不再出现在「交接未闭环」提醒
PASS 14 context 注入接管请求：①②③ + 完整 bid + 完整 sid（accept/DONE/BLOCKED 均可复制）
PASS 15 spawn：新建 1 个会话；prompt 含 ①②③ + target:"ses_host"；无 DECLINE；结果同 ①②③
PASS 16 busy 45min 的 top-1 真收到叫醒 prompt（①②③ + DECLINE）；广播结果同 ①②③
PASS 19 collab_list 仍只读（不提取、状态不变）
PASS 20 10 条窗口边界双向（12 条外不采纳 / 10 条内采纳）
PROBE reminder first=true second=false
=== independent: 38/38 passed                      exit=0
```

## 4. 风险清单

### H1（高，建议启用前修）误判为 `done` 的多条路径

`verdictFromTexts()` 的显式前缀分支不校验「行首位置 / 目标 bid / 是否为模板回显 / 是否有否定」，
关键词分支只做「分析完成」剔除，没有否定词护栏。实测（同一假 ctx，伪造到期 spawn claim）：

| 对端最后一条 assistant 文本 | 实际判定 | 应有 |
| --- | --- | --- |
| 完成后我会发：`[handoff] DONE <bid> <摘要>`，先确认一下环境。 | `done`（note=`<bid> <摘要>…`） | 不闭环 |
| 回执格式 `[handoff] DONE b_00000000000abcde <摘要>` —— 但我还没开始。 | `done` | 不闭环 |
| 我不会发 `[handoff] DONE`，因为环境起不来。 | `done` | 不闭环（或 blocked） |
| `任务未完成，卡在权限问题上` | `done` | 不闭环 |
| `无法完成，需要人接手` | `done` | 不闭环 |
| `not done yet, blocked by permissions` | `done` | 不闭环 |

更糟的一个组合（两条消息）：第 1 条「我会按提示发 `[handoff] DONE <bid> <摘要>`。」、
第 2 条（最后）「环境起不来，我还没开始，需要人接手。」 → **`state=done`，note 取自第 1 条的回显**
（显式前缀会在整个 10 条窗口里回溯，压过最后一条的明确「还没开始」）。

为什么这条比 design 的「把完成分析当 DONE」更值得担心：**R1 的新文案本身就在接管请求里写着
`[handoff] DONE <bid> <摘要>`（真实 bid）**，被拉起的会话在第一轮复述「我会按 ①②③ 做，回执用
`collab_send {…text:"[handoff] DONE b_… <摘要>"…}`」是很自然的行为；一旦复述，租约到期即被闭环为 `done`，
而它其实什么都没做——比 pilot 的 G1 更糟（G1 至少 bid 停在 claimed 可人工发现）。

建议（最小改动，二选一或叠加）：

1. 给 `extractVerdict` 传当前 `bid`，显式前缀要求行内目标 **等于该 bid**（模板回显的 `<bid>` 与杜撰 bid 都被挡掉）；
   同时拒绝 `<摘要>`/`<原因>`/`<bid>` 占位。
2. `assistantText` 保留换行，显式前缀只认「行首 `^\[handoff\]`」；再加否定护栏
   `未完成|没完成|无法完成|不能完成|不会发|尚未|not (yet )?done|unfinished` → 直接返回 `undefined`。
3. 不做上述修正时，至少把「模板回显 / 否定语」写进 guide §5.3 已知限制，并在启用前用真实会话回归一次。

### H2（中）「谁触发提取」与设计/文档的「发起方」不一致

`injectionFor` 在 `record.workspace !== directory` 过滤**之前**就 `await refresh(...)`（`:1715`），
而 `refresh()` 不看调用者是不是 `record.from.sid`。实测：让 **WS_B 里的无关会话** 跑一次 `context` 注入，
它会读取 WS_A 里被拉起的会话内容并把该 bid 闭环为 `done`
（`PROBE bystander(WS_B) read counterpart=true state=done`）。
能力上没有新增权限（`collab_list`/打分本来就跨目录读元数据），但「跨工作区旁观者读正文并改状态」与
design §2「发起方」、guide §5.3 的措辞不符，也放大了 H1 的触发面（任何会话的一次请求都可能踩到）。
建议：`refresh(record, now, {actor})`，`injectionFor` 只在 `actor === record.from.sid` 时自动闭环，其它入口维持现状。

### M1（中，design 继承）「已修复 / 已完成」判 `blocked`

`BLOCKED_VERDICT_RE`（`:1046`）按 design 把 `已修复|已完成` 归 blocked。对「真做完了」的 spawn 会话
（如「已完成修复并提交 631dd502」）会记成 `blocked`，发起方可能据此以为没做而重新派活。
note 保留原文，人能分辨；建议后续把 `已实施|无需|not needed|already`（= 不需要做）与
`已修复|已完成`（= 做完了）分开映射，或在 guide 明说这是刻意的保守取舍。

### L1（低）单次读取量 ≠ design 的 `?limit=10`

design §2 写 `GET /api/session/{sid}/message?limit=10&order=asc`；实现用 `ctx.session.context`（整段，
随后才 `slice(-10)`，`:1087`）。语义等价、404 安全，但长会话（几 MB）会整段读入。
另外 `context` 返回的是「最后一次 compaction 之后」的视图（guide 已知偏差 #5）——
若结论消息已被压缩掉，会退化为「判定不出 → 顺延」，安全但功能失效，已在 impl-notes 承认「未做真实会话端到端验证」。

### L2（低，文档）`docs/development.md:119` 仍写 `155 checks`

`pnpm test:collab` 现在是 186。按 AGENTS「命令/脚本变化 → 更新 docs/development.md」，建议改这一行。

### L3（低）预览也会写闭环状态

`collab_accept confirm:false`（`:2696` 先 refresh）与 `collab_broadcast confirm:false`（`:2278`）
都会在 lapsed spawn 上落 `receipt.auto`。与「仅预览」的直觉不同（但与既有「预览也会刷新租约」一致，
guide 未写）。建议文档补一句。

### L4（低）窗口只有一次机会

`claimed` 一旦被判「无结论」，`refreshBroadcast` 会立刻 `state=open` + 删 `claim`，
之后再写结论也不会被提取（design 如此）。R1 的 ① accept（→ acked）能规避；不改。

### L5（低，文档）三处措辞/示例与实现不一致

guide §9「只取最后一条 assistant 回答」→ 实现为「尾部最多 10 条，关键词只判最后一条」；
guide §6 记录示例 `receipt.auto:false` → 手动 receipt 实际无该字段；
guide §5.3 首句「最后一条」与同段「尾部 10 条」自相矛盾。

### L6（低）`extractVerdict` 对外导出但无外部调用

只被 `refresh` 使用；导出无害（便于测试），可留。

## 5. 是否可提交

- **技术上可提交**：AC 1–6 全部满足；186/186 + `pnpm test:collab` exit 0 + `node --check` 0 + fmt/lint 干净；
  范围/护栏/文档同步都过关；无 push、无服务重启、真实广播目录与会话列表无新增。
- **但建议先修两处再提交/合并**（都不改架构，合计约 10–15 行）：
  1. **H1**：把当前 `bid` 传进 `extractVerdict`，要求 `[handoff]` 行的目标等于该 `bid` 且不是 `<bid>/<摘要>` 占位；
     加否定词护栏（命中即返回 `undefined`，不闭环）。否则重启插件后，「回显 receipt 模板」的会话会被静默判 `done`。
  2. **L2**：`docs/development.md:119` 的 `155 checks` → `186 checks`（一行，AGENTS 的文档同步要求）。
- 若决定按现状合并：请把 H1/H2 写进 guide §5.3 / §10 已知限制，并在重载前用一次真实 spawn 会话回归（先不闭环任何真实 bid）。

## 6. 本次复核未做 / 限制

- 未做真实会话端到端验证（会触碰真实会话内容/受保护线），R2 全部用假 ctx + 伪造 `claim.at`；
  线上 `ctx.session.context` 的语义按 `/api/session/{sessionID}/context` 的 openapi 契约核对
  （返回 `{data: Session.Message.Info[]}`，assistant 有 `type:"assistant"` / `time.created` / `content[].{type:"text",text}`）。
- 未重启/重载服务（按约束）；`/api/plugin` 的 `active` 只说明已加载。
- 未运行全量 `pnpm typecheck`（本任务只改 `.js`/`.mjs`/`.md`，不参与 TS 工程）。
