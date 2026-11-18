# 实施记录：缺陷自上报 + 挂起监控（0.1.3）

任务：`.trellis/tasks/11-18-collab-self-report`
完成时间：2026-11-18
结论：**全部验收项通过**（`pnpm build` / `pnpm typecheck` / `pnpm test` = 375 + 12 全绿 /
`node scripts/check-skill.mjs` / `node scripts/collab-triage.mjs --dry-run`）。
初版 0.1.3 = 364 + 12；独立复核（`research/check-report.md`）后追加复核修复轮 F1–F4，见 §6。

## 1. 变更清单（file:line）

### A. 上报内核（R1–R4、R7）

| 文件 | 关键位置 | 内容 |
| --- | --- | --- |
| `src/core/errors.ts` | `:57` `ValidationError` / `:67` `GuardConflictError` / `:148` `classify` | 错误分类法：`ValidationError`（参数校验 + 正常业务拒绝）→ `undefined`（不上报）；`guard-conflict` / `invariant` / `delivery-5xx`（status ≥500）/ `extract-error` / `uncaught`。分类靠稳定标签 `collabKind` 鸭子类型（不依赖 `instanceof`，防两份包共存/打包改名） |
| `src/core/errors.ts` | `:120` `deliveryFailure` | 把 `session.prompt` 的失败包成 `DeliveryError`（从 `status`/`statusCode`/`HTTP 5xx` 文案解析状态码） |
| `src/core/report.ts` | `:102` `signature` | `d_` + hash16(version + tool + errorName + 归一化 message)；归一化把 `ses_…`/`b_…`/`t_…`/绝对路径替换成占位符，同一缺陷不因 id 漂移而分裂 |
| `src/core/report.ts` | `:170` `buildEvidence` | **字段白名单**：version/tool/class/error{name,message≤2KB,stackTop≤5 帧}/context{bid,thread,from,claimBy,target（短 id）}/workspace/record{state,attempts,receiptMode,claimKind}/at/meta；禁 `text`/`note`/`token`/文件内容 |
| `src/core/report.ts` | `:219` `renderMarkdown` | `<ts>.md` = 可直接当 issue 的草稿（现象/复现/证据 JSON/影响面/修复后） |
| `src/core/report.ts` | `:308` `shouldReport` | 同 signatu re 1 小时限流（读 `index.json`） |
| `src/core/report.ts` | `:420` `createReporter` / `:507` `wrap` / `:526` `manual` | 上报编排：分类 → 限流 → 落盘（tmp+rename）→ 写索引 → 投递；全部 try/catch，失败只 log；`wrap` 只对缺陷追加 R8 提示后**原样抛出** |
| `src/tools/index.ts` | `:27` `registerTools` | 每个工具 `execute` 统一包 `reporter.wrap`；`collab_report` 自身不包（避免递归上报） |

**投放语义**：`src/core/report.ts:420` 起 `deliver()`：`report.to`（别名或 `ses_…`）存在且未
`enabled:false`、目标不在 `protect`（含血缘）→ `session.prompt`（`note` + `queue`，envelope
`[collab:collab-report][note] [defect] <sig> <一句话> → <路径>`）；否则只落盘。

### B. 挂起监控（R6）

| 文件 | 关键位置 | 内容 |
| --- | --- | --- |
| `src/core/stale.ts` | `:43` `staleClass` | `open`+`createdAt>1h` → `open-stale`；`claimed`+超租约 → `claimed-lapsed`；`acked`+`claim.at>2h` → `acked-stale`；缺时间戳的记录不猜 |
| `src/core/stale.ts` | `:81` `staleFor` / `:125` `markShown` | 只取本会话相关（发起方/领取人/被问询方）；按 `(class,bid)` 去重；「已提示」记忆写 `ctx.storage` 的 `collab/stale-seen/<sid>`（跨命令、跨重启共享） |
| `src/tools/list.ts` | `:14` `hintLine` / `:137` | `collab_list` 末尾固定上报入口；有挂起时输出「挂起提醒（每类每单只出现一次）」；有积压时输出「未处理缺陷上报 N 条」 |
| `src/hooks/context.ts` | `:148` `injectStale` | 注入挂起提醒（**排在链路提醒之前**：链路 refresh 会把超时 `claimed` 重开，排后面就看不到这类） |
| `src/hooks/context.ts` | `:164` `injectReportNotice` | 只有 `report.to` 指向的会话收到「未处理 N 条」（每会话一次，数量增长才再提示） |

### C. 可发现性（R8）

1. 错误文案后缀：`src/core/report.ts:507` 的 `annotate()`（只对分类为缺陷的错误；校验错误文案保持原样）；
2. `collab_list` 末行：`src/tools/list.ts:14`；
3. 新工具 `collab_report { note?, bid?, threadID?, confirm }`：`src/tools/report.ts`（新增文件）；
4. setup 日志：`src/index.ts:134`（`reportDir=… report.to=… pendingReports=N`，stderr）；
5. 文档：`README.md`「遇到异常（缺陷上报）」、`skills/collab/SKILL.md` §六点五、`docs/collab.md` §11.8；
6. `CHANGELOG.md` 顶部 `[0.1.3]`。

### D. 维护方 triage（R9）

`scripts/collab-triage.mjs`（新增，零依赖）：`:155` `renderIssue`、`:279` `notify`、`:317` `main`。

- 扫 `COLLAB_REPORT_DIR`（默认 `~/.config/opencode/collab-reports`），按 signature 归并；
- 未处理（`triagedAt` < 最新证据）→ 生成/刷新 `<repo>/docs/issues/bugs-collab-<sig>.md`，保留人工改过的
  `> 状态：` 行；`triagedAt` 回写 `index.json`（tmp+rename）；
- `--dry-run` / `--since <iso>` / `--notify <alias|sid>` / `--repo` / `--dir`；
- 幂等（无新证据 → 不写、「没有待处理上报」）；并发：`<dir>/.triage.lock`（`open 'wx'`，10 分钟视为过期）；
- `--notify` 走 `POST ${COLLAB_SERVER_URL}/api/session/{sid}/prompt`（可选 Bearer），
  内置 + config 的 `protect` 一律拒绝；未配 URL 只警告（退出码 0，cron 不刷错）。

### E. 旁路改造（不改返回语义）

- `src/tools/shared.ts:5` 引入 `invalid`/`deliveryFailure`/`GuardConflictError`；
  参数校验与业务拒绝的 `throw new Error` 全部改为 `throw invalid(...)`（14 个文件），**文案逐字不变**；
- `src/tools/shared.ts:243`：`dispatch` 护栏拒绝时，若白名单本身认为「这就是该 bid 的限界回执」
  （`canReplyToProtected` 命中）却未生效 → `GuardConflictError`（R1 的「护栏与指令冲突」形状：
  调用方拿到的仍是拒绝，但会按缺陷上报）；
- `src/tools/shared.ts` `deliverPrompt()`：`session.prompt` 失败包成 `DeliveryError`（错误前缀
  `投递失败：`），分类 `delivery-5xx`；
- `deliverAsk` 的投递失败从「只写 log」改为同时上报（这正是「静默挂起」的证据）；
- 配置：`src/config.ts` 新增 `report: { to?, enabled? }`；`src/types.ts` `ReportConfig`。

## 2. 新增/修改用例

`test/handoff-harness.mjs` 新增 **S72–S76 共 54 项**（总 364）：

| 段 | 覆盖 |
| --- | --- |
| S72（a） | 投递 5xx → 仍失败（行为不变）+ 恰好一对 `<sig>/<ts>.{json,md}`；`class=delivery-5xx`/`tool`/`version`/`at`/`stackTop≤5`；`PLUGIN_VERSION === package.json.version`；**正文与 token 均不出现在 json/md**；json 无 `text`/`note`/`token` 字段；md 含「## 现象/## 证据」；错误文案带 `collab_report` 入口 |
| S72（b） | 同签名 1h 内重复 → 不新增文件，但仍带入口提示 |
| S72（c） | 空 `text` / 非法 `bid` / 未知 target / `protect` 拒绝 → **不上报**且**不带**入口提示 |
| S72（d） | 分类法单测：Validation→不报；guard-conflict/invariant/delivery-5xx(503)/extract-error/uncaught；4xx delivery→uncaught；`signature` 对 `ses_…` 稳定、对 tool/version 敏感；`staleClass` 三类边界 |
| S73 | `report.to` 别名 → 恰好一条 `note`（`queue`，`[collab:collab-report][note] [defect] d_…`，含证据路径）；调用方错误仅多一行提示 |
| S73b | `report.to` 指向 protected → 0 条 note，证据照常落盘 |
| S73c | `report.enabled:false` → 0 条 note（回滚开关） |
| S74 | `collab_report` 预览不写盘；`confirm:true` 落一对文件（class=manual，无消息历史/文件内容）；同 note 1h 内 → 「未新增文件」；R8 提示里的无 note 形式可用 |
| S75 | 三类挂起都在 `collab_list` 出现；只显示本会话相关的单；只读（`claimed` 不被 refresh、无锁动作）；第二次列表静默；`context` 注入与 `collab_list` **共用去重**；承接方看到自己的 `claimed-lapsed`+`acked-stale` 且只一次 |
| S76 | `--dry-run` 不写盘；一签名一 issue（含现象/证据/版本/首次最近/bid）；重跑幂等（同内容、无新文件）；`--since` 过滤全部；`--notify` 恰好一次 `POST /api/session/ses_aaa/prompt`（Bearer + `[defect]`）；`--notify` 对 protected 拒绝且退出 0；维护方会话「未处理 N 条」只出现一次；`collab_list` 末行固定入口 |
| S76c | （同上，被动提示与末行入口） |

`test/readonly-default.mjs`：工具面断言改为「十个 + `collab_report`」；新增 `COLLAB_REPORT_DIR` 指向临时目录。

**harness 自身隔离**：`COLLAB_REPORT_DIR` / `COLLAB_CONFIG` 都指向 `mkdtemp` 目录——首轮跑测试时发现
S37（spawn 落点不对）会往真实 `~/.config/opencode/collab-reports/` 写一条，已修并删除该残留文件。

## 3. 原始输出

```
$ pnpm typecheck
$ tsc --noEmit            # 无输出 = 通过

$ pnpm build
ℹ dist/index.js    194.88 kB │ gzip: 60.96 kB
ℹ dist/index.d.ts    8.64 kB │ gzip:  3.42 kB
✔ Build complete in 1414ms          # 体积/耗时会随构建漂移，只看「Build complete」

$ pnpm test
=== 375/375 checks passed
=== 12/12 checks passed

$ node scripts/check-skill.mjs
✓ skills/collab/SKILL.md (collab)
skills ok

$ node scripts/collab-triage.mjs --dry-run
✓ 没有待处理上报（0 个签名已处理，报告目录 /root/.config/opencode/collab-reports）
```

端到端 triage（临时目录，手工造一条 `d_demo…` 证据）：

```
✓ d_demo00000000abcd 1 条证据 (collab_send/guard-conflict) → …/docs/issues/bugs-collab-d_demo00000000abcd.md
✓ 1 个签名 已生成/刷新 issue
# 重跑（无新证据）
✓ 没有待处理上报（1 个签名已处理，…）
# 人工把「> 状态：」改成「已修复（0.1.4）」后再来一条证据
✓ … → 2 条证据；文件里 `> 状态：已修复（0.1.4）` 被保留，`上报次数：2`
# --since 2030-01-01
✓ 没有待处理上报（1 个签名已处理，…）
# --dry-run（有新证据）
· [dry-run] d_demo00000000abcd 3 条证据 … ；docs/issues 无新增文件
```

一条真实证据（S72 的 delivery-5xx）形状：

```json
{
  "signature": "d_ca08bbd618b17e4d",
  "version": "0.1.3",
  "tool": "collab_send",
  "class": "delivery-5xx",
  "error": { "name": "DeliveryError", "message": "投递失败：HTTP 500 upstream unavailable (token [redacted])", "stackTop": ["at deliveryFailure (…)", "…共 5 帧"] },
  "context": { "from": "ses_aaa…_aaa", "target": "ses_bbb…_bbb" },
  "workspace": "/tmp/collab-harness-…/ws/a",
  "at": 1794960131771,
  "meta": { "status": 500 }
}
```

## 4. 设计偏差与取舍（需评审知晓）

1. **`ValidationError` 同时承载「参数校验」与「正常业务拒绝」**：PRD R1 把两者都列为「不触发」，
   而 design 只提到参数校验。为避免 58 处抛点里遗漏任何一处业务拒绝导致误报，两者共用一个标记类
   （类注释写明契约）。
2. **`guard-conflict` 是防御式分支**：`dispatch` 里「白名单认为该放行却拿到 `allowProtectedReply=false`」
   在现有两个调用点不可达（`send.ts`/`reply.ts` 都算过白名单）。它只在调用点回归/绕过白名单时触发；
   分类法本身有单测。
3. **triage 的 `--notify` 用 HTTP**：脚本无宿主 `ctx`，只能走 `COLLAB_SERVER_URL` 的
   `POST /api/session/{sid}/prompt`（文档 §4 已记录该端点；与授权/切 agent 的 fallback 同一条原则：
   不猜端口）。未配 URL 时只警告，不算失败（cron 不刷错）。
4. **`index.json` 条目是对象**（`{lastAt, triagedAt, count, tool, class}`）而不是 design 里的
   `{sig: lastAt}`；读取同时兼容数字（旧/外部写法）。
5. **挂起提醒的过滤是「本会话相关」**（发起方/领取人/被问询），而不是全实例广播——否则每个会话都会
   收到别人的挂起单。维护方要看全局积压走 triage 列表。
6. **挂起注入排在链路注入之前**（原因见 §1.B）。
7. **未实现「自动关闭挂起单」**——PRD 边界明确只提示/上报。

## 5. 未验证项 / 风险

- **真实宿主未跑**：所有验证都在假宿主 harness 上（`ctx` 为内存实现）。特别是
  `ctx.session.prompt` 的 `delivery:'queue'` 语义、`error.message` 可写（只用于追加提示行，
  `try/catch` 兜底新建 Error）未在真实 opencode 2.3 上验证。
- **per-request fs 开销**：`pendingReports()` 每个 `context` 注入会扫一次报告目录
  （readdir per signature 目录）。签名数量很小（个位数）时可忽略；若未来积压到几十个签名，
  建议加 60s 缓存（本次为确定性测试未加）。
- **索引并发**：两个工具同时上报不同签名可能丢一次 `lastAt` 更新（读-改-写），
  影响仅是限流窗口偶尔失效，不会丢证据文件。
- **`protect` 血缘判定**：`report.to` 的 protected 判定复用 `createLineage`（会 `session.get`），
  不可读的会话视为「不在名单」并继续投递；这与 `collab_send` 的 fail-closed 语义略有差异
  （投递侧仍会被 `collab_send` 的护栏拦住，不会真发出去）——本次未改。
- **`--notify` 的 HTTP 端点**：仅在 fake server 上验证了请求形状；未对真实 opencode 服务端验证
  `{text}` body 是否足够（CLI `scripts/collab.mjs` 用的是同一端点，参考其实现，但本次未实机验证）。
- **版本号**：`src/constants.ts` 的 `PLUGIN_VERSION` 与 `package.json` 需同步；harness 有一条断言
  在两者不一致时失败（单源真相的折中）。

## 6. 复核修复轮 F1–F4（2026-11-18，独立复核后）

复核结论「可提交，但 4 个漏网点」，逐条修复如下（只动 `src/**`、`test/**`、`scripts/collab-triage.mjs`、
本任务目录；无 git 写、无 tag/publish）：

| 项 | 位置 | 修复 |
| --- | --- | --- |
| **F1** `collab_wait` 把宿主 5xx 当校验错误 → 漏报 | `src/tools/wait.ts:69-80` | `catch` 里只把**超时**（`/^等待超时：/`）保留为 `invalid`；`status>=500` → `DeliveryError`（class `delivery-5xx`）；其它宿主异常 → 普通 `Error`（class `uncaught`）。三者文案统一仍是 `collab_wait 失败：<原文>` |
| **F2** 回执/ACCEPT 通知投递失败只返回文字 | `src/core/chain.ts:393`（返回类型 + catch 回传 `error`）、`src/tools/accept.ts:41-63`（`reportUndelivered()`）、`:133`、`:216` | `notifyRequester` 在 catch 里多返回原始 `error`；`collab_accept` 两个调用点用 `reporter.reportNow({tool:'collab_accept', defect:'delivery-5xx', input:{bid}})` 旁路上报。返回文案 `未通知发起方：…` 不变；受保护发起方 / 缺 sid 无 `error`，属预期不上报 |
| **F3** triage 在报告目录不存在时误报「另一个 triage 正在运行」 | `scripts/collab-triage.mjs:216-252` | `lockDir()` 先 `mkdirSync(dir,{recursive:true})`；`ENOENT` 视为「目录缺失」并重试一次（`retried` 防无限递归）；只有真正的 `EEXIST`（且锁未过期）才算并发。`--dry-run` 仍不写任何东西 |
| **F4** 上报 note 的 `metadata.collab.fromSessionID` 是短 id | `src/core/report.ts:432`（`deliver(..., reporterSessionID)`）、`:463` | 投递时用**完整 `ses_…`**（来自 `input.sessionID`）；**证据文件仍只存短 id**（R2 不变）。维护方可直接 `collab_send` 回投 |

### 新增回归（S77–S80，共 11 项，总 375）

| 用例 | 断言 |
| --- | --- |
| S77a | `ctx.session.wait` 抛 `HTTP 500` → 工具仍报 `collab_wait 失败：HTTP 500 …`；**恰好一个**新签名，`tool=collab_wait`、`class=delivery-5xx`；错误文案带 `collab_report` 入口 |
| S77b | `session.wait` 永不返回 + `timeoutMs:1000` → `等待超时` 仍为业务拒绝：**报告数不变**、**无入口提示** |
| S78 | `prompt` 对发起方抛 `HTTP 502` 的 `collab_accept` → 返回文案不变（`已领取` + `未通知发起方：HTTP 502 …`）；**一个**新签名，`tool=collab_accept`、`class=delivery-5xx`、`context.bid` = 该单 |
| S79 | `--dir <不存在的目录>` 跑 triage → 退出码 0、stderr **无**「另一个 triage」、打印「没有待处理上报」、目录被创建 |
| S80 | 配 `report.to` 触发缺陷 → 投递 note 的 `metadata.collab.fromSessionID === 'ses_aaa'`（完整 sid、不含 `…`） |
| S79b | （复核 F7）解析 `scripts/collab-triage.mjs` 的 `BUILTIN_PROTECT` 字面量，与插件 `__internals.BUILTIN_PROTECT` 逐项相等 → 复制列表不会静默少保护 |

### 验证（修复后）

```
$ pnpm build
ℹ dist/index.js    194.88 kB │ gzip: 60.96 kB
ℹ dist/index.d.ts    8.64 kB │ gzip:  3.42 kB
✔ Build complete in 1414ms

$ pnpm typecheck
$ tsc --noEmit               # 退出 0

$ pnpm test
=== 375/375 checks passed
=== 12/12 checks passed

$ node scripts/check-skill.mjs
✓ skills/collab/SKILL.md (collab)
skills ok

$ rm -rf /tmp/triage-nodir && COLLAB_REPORT_DIR=/tmp/triage-nodir node scripts/collab-triage.mjs --dry-run
✓ 没有待处理上报（0 个签名已处理，报告目录 /tmp/triage-nodir）

$ rm -rf /tmp/triage-nodir && COLLAB_REPORT_DIR=/tmp/triage-nodir node scripts/collab-triage.mjs --repo /tmp/triage-demo/repo
✓ 没有待处理上报（0 个签名已处理，报告目录 /tmp/triage-nodir）   # 不再误报「另一个 triage」
```

### 复核未列入本轮的处理（保留现状，理由）

- **F5 积压计数对所有会话可见**：`docs/collab.md` §11.8 已明写「任何会话的 collab_list」，
  属有意设计（显式命令给谁看都给）；`context` 注入仍只给 `report.to` 会话。如需严格对齐 R9.2 措辞，
  加一行 `report.to` 判定即可，本次不改。
- **F6 `invariant` / `extract-error` 无抛出点**：分类法有单测（S72c），两类目前为预留；
  真正的不变量/解析异常落到 `uncaught` 仍会上报（不丢证据），标签差异已在 `docs/collab.md` §11.8 列出。
- **F7 `BUILTIN_PROTECT` 在 triage 里复制**：脚本必须零依赖、不能 import TS，复制无法避免；
  已按复核建议**加守门**——`src/index.ts` 的 `__internals` 导出 `BUILTIN_PROTECT`，harness S79b
  解析脚本里的数组字面量并逐项比对（不一致即 FAIL），避免未来改硬名单时 triage 静默少保护。
- **`report.to` == 当前会话**：仍会产生一条自投 note（维护方自测场景），未加 self 判定（低危）。
