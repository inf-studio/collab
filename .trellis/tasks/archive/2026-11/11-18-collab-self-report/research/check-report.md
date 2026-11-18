# 独立复核报告：缺陷自上报 + 挂起监控（0.1.3）

- 复核对象：`/data/project/collab` 未提交改动（27 改 + 6 新增）
- 复核方式：**冷上下文只审不改**（未修改任何实现文件、未 commit/add/push），
  用**自建的假 ctx + 临时 `COLLAB_REPORT_DIR`** 复现（`/tmp/opencode/collab-check/{check,check2,check3,check4,check5,check6,triage}.mjs`），
  不采信 `test/handoff-harness.mjs` 的既有断言（仅作为对照）。
- 时间：2026-11-18

## 结论

**可提交**（无阻塞项；PRD 的 11 条 Acceptance Criteria 全部由我自己的用例复现通过）。
发现 3 处**新代码的低成本缺陷**（1 处 R1 分类漏报、1 处 R1 投递漏报、1 处 triage 误导性跳过）+ 5 处低危/文档性问题，
建议先修前两条中的任意一条再发版；均不涉及设计变更，回滚面为零。

自建断言合计 **105 + 30 + 33 = 168 项**（另 4 组反向/一致性探针：`check3` 未被上报的路径、`check4` 宿主回显正文、`check5` 并发与跨端一致、`check6` 磁盘故障）。除下方 F3（记录在案的失败）外全绿。

## 10 项逐条

### 1. 分类白名单（通过；1 处存疑 → F1）

- `classify()` 见 `src/core/errors.ts:148`：`collabValidation === true || collabKind === 'validation'` → `undefined`（不上报）；
  `guard-conflict` / `invariant` / `extract-error` / `delivery-5xx`（`status>=500 || status===0`）/ 默认 `uncaught`。
- 我自建的 6 种「不该上报」用例，**每一种**都验证了三件事：仍抛错、**报告目录无新签名目录**、**无 note 投递**、**错误文案不含 `collab_report` 提示**：

| 用例 | 工具/入参 | 结果 |
| --- | --- | --- |
| 空 text | `collab_send {text:"   "}` | 不落盘 / 不投递 / 无提示 ✅ |
| 非法 bid | `collab_accept {bid:"not-a-bid"}` | 同上 ✅ |
| 未知目标 | `collab_send {target:"no-such-alias"}` | 同上 ✅ |
| protect 拦截 | `collab_send {target:<内置 protected>}` | 同上 ✅ |
| 非绝对路径 | `collab_list {directory:"relative/path"}` | 同上 ✅ |
| 未知 target 等待 | `collab_wait {target:"nope"}` | 同上 ✅ |

- 该上报的都上报了：投递 500 → `delivery-5xx`（`src/tools/shared.ts:133` `deliverPrompt`）；
  另一条未捕获异常（让 `ctx.storage.get` 抛 TypeError，`collab_reply` 读 thread 时触发）→ `uncaught`，
  证据 `tool=collab_reply`，错误仍原样抛出且带提示行。
- **存疑（F1）**：`collab_wait` 的 `catch` 把**宿主 500** 也包成 `validation`（`src/tools/wait.ts:69-70`），
  于是「等待期间宿主 5xx」既不落盘也不提示 —— 而这正是「静默挂起」最像的场景。实测见 F1。

### 2. 脱敏（通过）

- 送一条**含敏感串**的 `collab_send`（正文含 `SENSITIVE-BODY-…`、`ghp_ABC…` 与 `COLLAB_SERVER_TOKEN`），
  宿主返回 500 → 证据 JSON/MD 中：正文标记 0 次、token 标记 0 次、`COLLAB_SERVER_TOKEN` 0 次；
  无 `"text"` / `"note"` / `"token"` 字段；`stackTop` 3 帧（≤5）；`context.from = ses_xxxx…yyyy`（短 id）。
- 额外做了「宿主在错误消息里回显整段正文」的极端用例（`check4.mjs`）：证据里正文被替换为 `[redacted]`，正文关键串未泄漏。
- `message` 截断：9000 字符的宿主错误 → 证据中 `error.message` 长度 **≤2048**。
- `record` 快照来自 `readBroadcast(bid)`，含 `state/attempts/receiptMode/claimKind`（`src/core/report.ts:170`）。
- 证据目录为 `REPORT_DIR/sig/<ts>.{json,md}`（`src/core/report.ts:388`），`.md` 含 `## 现象 / ## 证据 / ## 影响面`，可直接当 issue 草稿。

### 3. 限流与幂等（通过）

- 同签名 1h 内第二次触发：**不新增文件**（签名目录仍 1 个、json 仍 1 个）、**不二次投递**（note 计数不变）、
  仍抛原错并仍带提示行（`src/core/report.ts:308` `shouldReport`）。
- `collab_report` 预览（无 `confirm`）：返回「未上报…仅预览」+ 签名 + 证据目录，**不写盘**。
- `collab_report {confirm:true}`：新增一对文件、`class=manual`；同 note 1h 内重复 → 「未新增文件」；
  无 note 的 `collab_report {confirm:true}`（R8 提示里给的正是这个形式）可用。

### 4. 投递矩阵（通过）

| 配置 | 结果 |
| --- | --- |
| `report.to: "maintainer"`（别名） | 恰好 1 条 note → `ses_maint`，`delivery=queue`，信封 `[collab:collab-report][note]`，正文含 `[defect] <sig>` 与证据路径 ✅ |
| `report.to: "ses_maint"`（裸 sid） | 同上 ✅ |
| 目标在 protect（含 protected **子会话**，血缘） | 0 条 note，证据照常落盘 ✅ |
| `report.enabled:false` | 0 条 note，证据照常落盘 ✅ |
| 未配置 `report.to` | 0 条 note ✅ |
| 别名不在别名表 | 0 条 note，工具错误不变，证据落盘 ✅ |
| 维护方投递本身失败（全 500） | 工具仍抛原「投递失败：…」错误，证据仍落盘，失败只记日志 ✅（R7） |
| 报告目录不可写（`/proc/...`） | 工具错误、文案、提示行全部不变；仅日志 `defect report failed`；`setup` 未受影响 ✅（R7） |

### 5. 挂起监控（通过）

造 6 条记录（start/claim 时间由我控制）后 `collab_list`：

| 记录 | 期望 | 实测 |
| --- | --- | --- |
| `open` 2h 前 | `open-stale` | ✅ |
| `claimed` claim.at=10min 前（租约 5min） | `claimed-lapsed` | ✅ |
| `acked` claim.at=3h 前 | `acked-stale` | ✅ |
| `open` 1min 前 | 不报 | ✅ |
| `acked` 1h 前 | 不报（阈值 2h） | ✅ |
| `claimed` 无 `claim.at` | 不猜 | ✅ |

- 挂起块**恰好 3 行**、出现 1 次；第二次 `collab_list` 静默；无关会话 0 条；
  承接方（claimant）从 `context` 注入拿到自己相关的 `acked-stale`，第二次注入不再出现，
  且与 `collab_list` **共用** `collab/stale-seen/<sid>`（`src/core/stale.ts:125`、`src/hooks/context.ts:148`）。
- **只读**：6 个记录文件在列表前后**字节相同**；未创建/删除任何 `<bid>.lock`；`claimed` 记录未被 refresh（仍是 `claimed`）。
- `acked` 提醒排在链路提醒之前（`src/hooks/context.ts:198`），符合设计 §5 的原因说明（refresh 会重开超时 claimed）。

### 6. triage（通过；1 处低危缺陷 → F3）

自建 33 项（`triage.mjs`，临时 repo + 临时报告目录，未碰真实 `~/.config`）：

- `--dry-run`：打印 `· [dry-run]`，**未建 issue、未写 index.json、未留锁**；
- 首次真跑：一签名一 issue（`docs/issues/bugs-collab-<sig>.md`），含 `受影响版本 / 首次/最近上报 / 上报次数 / 涉及 bid / ## 现象 / ## 证据`；
  `triagedAt` 回写 `index.json`；
- 幂等重跑：「没有待处理上报」，**issue mtime 不变**（确实没重写）；
- 人工把 `> 状态：` 改成 `已修复（9.9.9）` 后再来一条证据 → 重建时**保留人工状态行**、`上报次数：3`；
- `--since 2035-…` → 全部跳过；
- 并发：两次同时跑，一次拿到锁跳过（`另一个 triage`），最终 **6 个签名 → 6 个 issue、6 条 index，无重无丢**；
  10 分钟前的陈旧锁会被接管并清理；
- `--notify`：protected → 拒绝且退出码 0；本地假服务端验证请求形状 = **1 次** `POST /api/session/ses_maint/prompt`，
  `Authorization: Bearer tok`，body 含 `[defect]`；未配 `COLLAB_SERVER_URL` → 只警告、退出码 0（cron 不刷错）；
- triage → 插件的跨端一致性：triage 跑完后新起插件 `pendingReports=0`（`pendingReports` 用的是同一份 `index.json`）。
- **F3**：报告目录**尚不存在**时（全新安装 / 按回滚方案删过目录），`lockDir` 因 `ENOENT` 返回 `undefined`，
  脚本打印「另一个 triage 正在运行…本次跳过」并 exit 0 —— 误导，且首次真实上报前的 cron 永远空转。
  见 `scripts/collab-triage.mjs:216-235`（`if (error?.code !== 'EEXIST') return undefined;`）。

### 7. 可发现性（通过，四入口齐）

1. 错误文案末尾：非校验类错误最后一行 `提示: 若怀疑是插件缺陷，运行 collab_report { confirm:true } 上报现场（或看 <dir>）`（`src/core/report.ts:488`）；校验错误**没有**这一行；
2. `collab_list` 固定末行 `缺陷上报：collab_report { confirm:true }（证据目录 …）`（`src/tools/list.ts:14`），空列表时也在最后；
3. `collab_report` 已注册（`src/tools/index.ts:40`，工具面 11 个），`confirm:false` 预览可用；
4. `setup` stderr 打出 `reportDir=… report.to=… pendingReports=N`（`src/index.ts:133`），实测捕获到两行 setup 日志；
   文档：README「遇到异常（缺陷上报）」、`skills/collab/SKILL.md` §六点五、`docs/collab.md` §11.8（含 `report.to` 示例、脱敏说明、cron 示例）、`CHANGELOG.md` 顶部 `[0.1.3]` 明写「本次起支持」。

### 8. 回归（通过）

```
$ pnpm build      ✔ Build complete（dist/index.js 193.77 kB）
$ pnpm typecheck  tsc --noEmit，退出 0
$ pnpm test       === 364/364 checks passed / === 12/12 checks passed
$ node scripts/check-skill.mjs   ✓ skills/collab/SKILL.md (collab) / skills ok
$ node scripts/collab-triage.mjs --dry-run   ✓ 没有待处理上报（0 个签名已处理 …）
```

- `git diff test/handoff-harness.mjs` 只有 1 处删除（import 行），**既有 310 项断言一行未删**；`readonly-default.mjs` 仅工具面加 `collab_report` + 新增 `COLLAB_REPORT_DIR` 隔离。
- 校验抛点文案：逐条比对 diff，`new Error(msg)` → `invalid(msg)` 的**消息文本逐字相同**（含 14 个文件的 55 处）；
  唯一可见差异是 `deliverPrompt` 把宿主 prompt 失败包成 `投递失败：<原消息>`（`src/tools/shared.ts:133`），
  这一点 CHANGELOG「Changed」已写明，属有意变更。

### 9. 范围（通过）

`git status` 只有 `src/**`、`test/**`、`scripts/collab-triage.mjs`、`README/CHANGELOG/docs/collab.md/skills`、
`package.json`（仅 version）、`.trellis/tasks/11-18-collab-self-report/**`。
未触碰 `muke-pos-app` / `apps/**` / 任何归档任务；`BUILTIN_PROTECT` 未改（`src/constants.ts` 只有新增常量）；
未向受保护会话投递（投递侧有 `protectedAncestor` 血缘判定，我用 protected **子会话**验证过）。

### 10. 隐私/安全（通过）

- `src/` 中新增代码**无 `fetch`**：上报投递走 `ctx.session.prompt`（`src/core/report.ts:444`），
  `src/` 里唯二的 `fetch` 是 0.1.2 就有的 `grants.ts` HTTP fallback；`scripts/collab-triage.mjs --notify` 才发 HTTP（显式参数）。
- 上报不写 `collab-broadcast`：带 bid 的缺陷上报前后，记录文件**字节相同**、目录无新文件/锁。
- `package.json` 依赖零变化（只有 `version`）。
- 证据里没有完整 session 列表/消息历史（白名单构造函数 `buildEvidence`，`src/core/report.ts:170`）。

## 发现的问题（按优先级）

### F1（中低，R1 漏报）`collab_wait` 把宿主错误当成校验错误

- 位置：`src/tools/wait.ts:69-70`
- 复现（`check3.mjs`，`ctx.session.wait` 抛 `HTTP 500`）：

```
collab_wait + host 500 message: "collab_wait 失败：HTTP 500 wait exploded"
collab_wait + host 500 hint present: false
collab_wait + host 500 report files: 0
collab_wait + host 500 delivered notes: 0
```

- 影响：等待期间宿主 5xx（最典型的「卡住」）既不上报也无入口提示；`withTimeout` 的**超时**错误（业务拒绝）
  与宿主异常在同一个 `catch` 里，被一并标成 `validation`。
- 建议：`catch` 里只把超时文案那条包成 `invalid`，其余 `throw error`（自然落到 `uncaught`）。改动约 3 行；不影响既有文案。

### F2（低，R1 漏报）回执/唤醒投递失败不上报

- 位置：`src/core/chain.ts:400-417`（`notifyRequester` 的 `catch` 只 `return { delivered:false, reason }`），
  调用点 `src/tools/accept.ts:122,197`。
- 复现（`check3.mjs`，`prompt` 对发起方 502）：

```
accept content (notified?): "未通知发起方：HTTP 502 bad gateway"
accept: report files after failed receipt delivery: 0
accept: hint present: false
```

- 影响：R1 明列「投递 5xx」，但这条路径（收口回执/ACCEPT 通知）失败只在工具返回里一行文字，不落盘、不带入口。
  好的一面：对调用方**可见**，不是完全静默。
- 建议：`catch` 里补 `reporter.reportNow({tool:'collab_accept', defect:'delivery-5xx', error, input:{bid}})`（该分支拿不到 reporter 时可从 `deps` 传）。

### F3（低，新代码缺陷）triage 在报告目录不存在时误报「另一个 triage 正在运行」

- 位置：`scripts/collab-triage.mjs:216-235`（`lockDir` 把非 `EEXIST` 一律当失败，`open('wx')` 在缺目录时是 `ENOENT`）
- 复现：`node scripts/collab-triage.mjs --dir <不存在目录> --repo <repo>` →
  `! 另一个 triage 正在运行（…/no-reports-yet/.triage.lock）；本次跳过`，exit 0。
- 影响：全新安装（插件还没写第一条证据）或按文档回滚（删目录）后，cron 每 15 分钟打一条误导日志并空转。
- 建议：`lockDir` 前 `mkdirSync(dir,{recursive:true})`，或把 `ENOENT` 当作「无待处理」直接返回。

### F4（低）上报 note 的 `metadata.collab.fromSessionID` 是**短 id**，不可回投

- 位置：`src/core/report.ts:451` → `fromSessionID: evidence.context.from`（`ses_xxxx…yyyy`）。
- 后果：维护方 `collab_inbox` 里显示 `from=collab-report (ses_xxxx…yyyy)`，这个 id 无法作为 `collab_send` 目标；
  闭环「回执上报方」只能靠人按短 id 去 `collab_list` 里找。`collab_inbox` 对无 thread 的 note 不给回执提示（`src/hooks/context.ts` `lineOf`），
  所以不会产出错误命令，属摩擦而非错误。
- 建议：要么投递时带真实 sid 到 `metadata.collab.reporterSID`（证据文件仍只存短 id），要么在 note 正文里附「回执请用 collab_list 查 <短 id>」。

### F5（极低，与 R9.2 措辞有偏差但文档已写明）积压计数对**所有**会话可见

- `src/tools/list.ts:139`：任何会话 `collab_list` 都会看到「未处理缺陷上报 N 条」（每会话一次）；而 `context` 注入只给 `report.to` 会话（`src/hooks/context.ts:164`）。
- `docs/collab.md` §11.8 已明写「任何会话的 collab_list」，所以是**有意为之**；PRD R9.2 只写了「维护方会话」。
  风险：普通使用方看到维护方内部积压会困惑；无功能影响。若要严格对齐 R9.2，加一个 `report.to` 判定即可。

### F6（极低，文档准确性）`invariant` / `extract-error` 两类目前无抛出点

- `InvariantError` / `ExtractError` 在 `src/` 中只有定义与导出（`errors.ts:78,100`；`index.ts:167,169`），**没有任何 throw**。
- 实际效果：真正的不变量/解析异常会落到默认 `uncaught`（仍会上报，不丢），只是证据里的 `class` 标签与文档宣称不同。
- 建议：要么在 parse/verdict 的失败点显式抛 `ExtractError`，要么在文档里把这两类标注为「预留」。

### F7（维护风险）常量重复

- `scripts/collab-triage.mjs:33` 复制了 `BUILTIN_PROTECT`（注释「// src/constants.ts」）；`PLUGIN_VERSION` 与 `package.json` 双写（harness 有断言守）。
  两者都可接受，但 `BUILTIN_PROTECT` 变更时脚本不会报错，只会**少保护**（fail-open）。建议脚本读 `dist/` 或加一条 harness 断言。

### F8（文档准确性，非代码）`research/impl-notes.md` 的构建产物数字与实测不符

- impl-notes 写 `dist/index.js 192.10 kB / dist/index.d.ts 2.72 kB`，我实测 `193.77 kB / 8.64 kB`（同一 `pnpm build`）。
  不影响交付，但复核者会以为漏了改动；建议更新 impl-notes 或去掉易漂移的体积数字。

## 原始输出（节选）

```
$ pnpm build
ℹ dist/index.js    193.77 kB │ gzip: 60.60 kB
ℹ dist/index.d.ts    8.64 kB │ gzip:  3.42 kB
✔ Build complete in 1366ms

$ pnpm typecheck
$ tsc --noEmit            # 退出 0，无输出

$ pnpm test
=== 364/364 checks passed
=== 12/12 checks passed

$ node scripts/check-skill.mjs
✓ skills/collab/SKILL.md (collab)
skills ok

$ node scripts/collab-triage.mjs --dry-run
✓ 没有待处理上报（0 个签名已处理，报告目录 /root/.config/opencode/collab-reports）
```

自建用例：

```
# check.mjs —— R1/R2/R4/R5/R6/R8（假 ctx + 临时 REPORT_DIR）
=== 105/105 checks passed
  T1 6/6 校验类不上报（不落盘/不投递/无提示）
  T2 delivery-5xx：1 目录 / json+md / class,tool,version,sig,at,短id,bid,record,stackTop≤5 / 无正文与 token / 1 条 note
  T3 1h 限流不新增不重投；manual 预览不写、confirm 写、重复「未新增文件」
  T4 report.to 别名/裸 sid/protected/enabled:false/未配置/投递失败 矩阵
  T5 uncaught（threads.read 抛 TypeError）→ class=uncaught、tool=collab_reply、仍抛且带提示
  T6 三类挂起、边界不误报、只读（字节相同）、每会话一次、跨 list/context 共用去重
  T7 四入口：错误后缀 / list 末行 / collab_report 注册 / setup 日志

# check2.mjs —— R5/R6/R7/note 形状
30/30 round-2 checks passed

# check3.mjs —— 反向：未被上报的路径（F1/F2 证据）
collab_wait + host 500 hint present: false
collab_wait + host 500 report files: 0
accept: report files after failed receipt delivery: 0
accept: hint present: false

# check4.mjs —— 宿主在错误消息里回显正文
message: "投递失败：HTTP 500 admit failed for: [collab:…][request:…] [redacted]"
contains body detail: false / contains token: false / contains redacted marker: true

# triage.mjs —— R9.1/R9.3
32/33 triage checks passed
FAIL missing report dir is not reported as "another triage is running"
  :: ! 另一个 triage 正在运行（…/no-reports-yet/.triage.lock）；本次跳过

# check5.mjs —— 并发 + triage↔plugin pending 一致性
locked-out run happened: true      # 并发时确实有一侧被锁挡下
issue files: 6 (expected 6 — no duplicates/loss)
index entries: 6
setup log: [collab] reportDir=… report.to=(unset: 只落盘，不投递) pendingReports=0

# check6.mjs —— 报告目录不可写（R7）
tool still threw: true / error text starts with the delivery wording: true
hint still appended: true / report failure logged, not thrown: true / setup survived: true
```

## 风险清单

| 级别 | 风险 | 来源 | 处置建议 |
| --- | --- | --- | --- |
| 中低 | `collab_wait` 宿主 5xx 被当校验，漏报（F1） | `src/tools/wait.ts:69` | 区分超时/宿主异常（3 行） |
| 低 | 回执投递（notifyRequester）失败不上报（F2） | `src/core/chain.ts:417` | catch 里 `reportNow(delivery-5xx)` |
| 低 | triage 缺目录时误导性跳过（F3） | `scripts/collab-triage.mjs:216` | 先 mkdir / 认 ENOENT |
| 低 | 上报 note 的 fromSessionID 不可回投（F4） | `src/core/report.ts:451` | 附真实 sid 或正文加提示 |
| 极低 | 积压计数对所有会话可见（F5，文档已写明） | `src/tools/list.ts:139` | 可选加 `report.to` 判定 |
| 极低 | `invariant`/`extract-error` 无抛出点（F6） | `src/core/errors.ts:78,100` | 补抛点或文档标「预留」 |
| 维护 | triage 复制 `BUILTIN_PROTECT`（fail-open）（F7） | `scripts/collab-triage.mjs:33` | 加 harness 断言 |
| 文档 | impl-notes 产物体积与实测不符（F8） | `research/impl-notes.md` §3 | 更新数字 |
| 设计取舍 | `index.json` 读-改-写无锁（不同签名并发可能丢一次 `lastAt`，只影响限流窗口） | `src/core/report.ts:300` | 可接受，implement.md 已记录 |
| 设计取舍 | `context` 注入每次扫报告目录（readdir per signature） | `src/core/report.ts:371` | 签名数量小可忽略；积压多时加 60s 缓存 |
| 设计取舍 | `report.to` == 当前会话时未拦自我排队（会产生一条自投 note） | `src/core/report.ts:432` | 观察；必要时加 self 判定 |

## 未验证（受环境限制，与实现方自述一致）

- 真实 opencode 2.3 宿主：`ctx.session.prompt({delivery:'queue'})` 的实际唤醒语义、`error.message` 可写性、
  `ctx.storage` 的持久化范围（我只用内存假宿主）。
- `--notify` 对真实服务端 `POST /api/session/{sid}/prompt` 的 body 兼容性（我只验证了请求形状与本地假服务端）。
- cron 实际安装（按 PRD 由 owner 决定，文档给示例即可）。

## 复核动作声明

- 未修改任何实现文件；未 `git add` / `commit` / `push`；未改权限、未向受保护会话投递、未创建/删除任何真实会话。
- 只在 `/tmp/opencode/collab-check/` 下写了 7 个临时脚本与临时目录（临时目录未删除，便于复跑）。
- 真实 `~/.config/opencode/collab-reports` **全程未被创建**（复核前后 `ls` 均不存在；`--dry-run` 报 0 个签名）。
  `test/handoff-harness.mjs` 与 `test/readonly-default.mjs` 现均用临时 `COLLAB_REPORT_DIR`，我两次完整 `pnpm test` 后该目录仍不存在 —— 上一轮实现的隔离修复有效。
