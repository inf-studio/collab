# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.3] - 2026-11-18

### Added

- **缺陷自上报（本次起支持）**：任何 `collab_*` 工具抛出**非参数校验类**异常（未捕获异常 / 内部不变量 /
  护栏与指令冲突 / 投递 5xx / 提取失败）时，插件把现场写到
  `~/.config/opencode/collab-reports/<signature>/<ts>.json` + 同名 `.md`（issue 草稿），
  并在配置了 `report.to` 时额外投一条 `note`（`queue`）给维护方会话。参数校验错误与正常业务拒绝
  （空 `text`、非法 `bid`、未知目标、`protect` 拦截、租约过期、等待超时）**不上报**。
- **证据白名单 + 脱敏（R2/R7）**：版本、工具、分类、错误名与消息（≤2KB）、stack 前 5 帧、短 id、
  工作区、记录状态快照、时间戳；**不含**正文全文、文件内容、token（`text` / `token` 输入与长 token
  形状的串替换为 `[redacted]`）。`COLLAB_REPORT_DIR` 可覆盖目录。
- **去重限流（R4）**：`signature = hash(version + tool + errorName + 归一化 message)`，
  同签名每 1 小时最多 1 条；`index.json` 以 `tmp + rename` 写入。
- **配置**：`collab.json` 新增 `report: { to?: "<alias|ses_…>", enabled?: boolean }`；
  目标命中 `protect`（含血缘）或未配置时只落盘。
- **`collab_report { note?, bid?, threadID?, confirm }`**：手工补一条现场（`confirm:false` 只预览），
  同签名 1 小时内幂等；不改变任何协作状态。
- **挂起监控（R6）**：`collab_list` 与 `context` 注入各输出一次
  `open-stale`（open >1h）/ `claimed-lapsed`（超租约）/ `acked-stale`（acked >2h），
  按 `(session, class, bid)` 去重（存储键 `collab/stale-seen/<sid>`，跨命令/重启共享）。
- **维护方消费端（R9）**：`scripts/collab-triage.mjs`（零依赖）——扫报告目录、按 signature 归并、
  生成/刷新 `docs/issues/bugs-collab-<sig>.md`、`triagedAt` 回写索引；`--dry-run` / `--since` /
  `--notify <alias|sid>`（经 `POST /api/session/{sid}/prompt`，需 `COLLAB_SERVER_URL`）；
  幂等 + `.triage.lock` 文件锁；cron 示例见 README（由 owner 决定是否安装）。
- **可发现性（R8）**：非校验类错误文案末尾追加 `collab_report` 入口；`collab_list` 末行固定入口；
  插件 `setup` 日志打印 `reportDir=` 与 `report.to` 是否配置；README / SKILL / `docs/collab.md` §11.8
  各有「遇到异常怎么办」；维护方会看到「未处理缺陷上报 N 条」（每会话一次）。

### Fixed（独立复核修复轮 F1–F4）

- **F1 `collab_wait` 漏报**：空闲等待的 `catch` 曾把宿主的任何失败都包成 `ValidationError`，
  于是「等待期宿主 5xx」（最像「卡住」的场景）既不落盘也无入口。现在只有**超时**保留为
  `ValidationError`（业务结果，不报）；`HTTP 5xx` → `delivery-5xx`，其它宿主异常 → `uncaught`，
  都照常上报，文案仍是可读的 `collab_wait 失败：…`。
- **F2 回执/ACCEPT 通知投递失败漏报**：`chain.notifyRequester` 的 `catch` 只返回
  `{delivered:false, reason}`；现在额外回传原始 `error`，`collab_accept` 的两个调用点用
  `reporter.reportNow({tool:'collab_accept', defect:'delivery-5xx', input:{bid}})` 旁路上报。
  返回给调用方的文案（`未通知发起方：…`）不变；受保护发起方/缺 sid 属预期，不上报。
- **F3 triage 缺目录误报并发**：报告目录不存在时 `open('wx')` 是 `ENOENT`（不是 `EEXIST`），
  旧逻辑打印「另一个 triage 正在运行」并空转。现在先 `mkdirSync(dir,{recursive:true})`，
  `ENOENT` 视为「目录缺失」重试一次；只有真正的 `EEXIST` 才算并发。
- **F4 上报 note 的 `fromSessionID` 不可回投**：投递 metadata 里的 `fromSessionID` 由短 id
  改为**完整 `ses_…`**（证据文件仍只存短 id，R2 不变），维护方可直接 `collab_send` 回投上报方。

### Changed

- 工具层所有「参数校验 / 正常业务拒绝」的抛出改为 `ValidationError`（旁路判定依据），
  错误文案不变；投递失败改抛 `DeliveryError`（文案前缀 `投递失败：`），分类为 `delivery-5xx`。
- `collab_list` 末尾新增固定上报入口行与（有积压时）未处理上报计数行。

### Regression

- `test/handoff-harness.mjs` 新增 S72–S80 共 65 项：异常→落盘一次 / 字段白名单 / 正文与 token 脱敏 /
  1h 限流 / 参数校验与护栏拒绝不上报 / `report.to` 收到一条 note / protected 只落盘 /
  `report.enabled:false` / `collab_report` 预览与幂等 / 三类挂起与跨命令去重 /
  triage 的 `--dry-run`、幂等、`--since`、`--notify`（含 protected 拒绝）。
  合计 **375 项 harness + 12 项只读默认**；`build` / `typecheck` / `check:skill` 通过。
- Harness 与只读默认用例现在都通过 `COLLAB_REPORT_DIR` / `COLLAB_CONFIG` 指向临时目录，
  不再读写真实 `~/.config/opencode/collab-*`。

## [0.1.2] - 2026-11-18

### Fixed

- **受保护发起方的回执死锁**（`docs/issues/bugs-protected-requester-receipt-undeliverable.md`，
  std-ui 提出，复核结论「部分成立」）：`scope=peer` 广播的发起方在 `protect` 名单内时，
  接管请求/`collab_accept` 仍要求承接方 `collab_send` 回执，而 `deliver()` 的血缘护栏对
  **所有** `kind` 拒绝投递到受保护目标——通知要求做一件被自己禁止的事，闭环只剩租约到期后的
  启发式提取。现在：
  - 广播创建时若发起方命中 `protectedAncestor`，记录写 `receiptMode:"pull"`；接管请求、
    `collab_accept`、`collab_broadcast` 结果与租约提醒改为「在本会话最后一条回复里写
    `[handoff] DONE|BLOCKED <bid> <摘要>`」，由发起方在租约到期后只读提取（`accept` 领取
    同样适用，不再只限 `spawn` 领取）。
  - **限界 reply**：`collab_send` / `collab_reply` 投递到受保护目标时，只有三条同时满足才放行
    ——`kind=reply`、目标是该 `bid` 的发起方（`record.from.sid`）、发送者是该单领取人
    （`record.claim.by`）；`bid` 取入参或正文里的 `b_…`。放行时强制 `queue` 并追加说明；
    `request` / `note` / `steer` 与其他来源仍 fail-closed，`BUILTIN_PROTECT` 名单不变。
  - 新增 `receiptMode` 字段（只增不改）；旧记录缺省视为 `push`，行为与文案不变。
  - **自动提取扩面（R7）**：租约到期后的只读提取不再限定 `claim.kind = spawn`，`accept` / `handoff`
    领取的单同样在**发起方**那次刷新里从承接方最后一条回答收口（仍只读最后一条、仍只有发起方能触发、
    受保护承接方不读）；结论词表补「回执被硬拒 / 无法投递 / 改回写提案 / 已自愈 / 无需改动」→ `blocked`，
    `done` 判定不变。此前这类单没有推送回执就只能一直挂着。
  - **`acked` 静默收口（R8）**：`acked` 没有租约路径，回执丢失时会永远停在 `acked`。现在静默超过
    `ACKED_EXTRACT_MS`（2h）后，发起方的刷新按同一套规则只读提取（仍只读最后一条、仍只有发起方能触发、
    受保护承接方不读）；判不出结论时**状态不变**（不降级、不 `attempts++`），只写 `staleNoticedAt`，
    每个窗口最多读一次。`collab_list` 对这类单额外标「静默=Nh 可自动提取」。
  - 回归：`test/handoff-harness.mjs` 新增 S69 共 23 项（pull 文案 / 字段落盘 / pull 提取闭环 /
    reply 白名单正反例 / 提醒文案）、S70 共 6 项（accept/handoff 收口 / 无结论走原顺延 /
    受保护承接方不读不闭环 / 旁观者不闭环）与 S71 共 6 项（acked 2h+ 收口 / 无结论保持不变且
    每窗口只读一次 / 1h 不读 / 旁观者不读 / protected 不读）。
  - 复核收尾：限界 reply 对**已闭环**（`done`/`blocked`/`expired`）的单不再放行；`acked` 提取要求
    `claim.at > 0`（缺失时 `since=0` 会把很久以前的回答当结论）；回归 +3 项（共 310）。

## [0.1.1] - 2026-11-17

- 包可见性改为 public（`publishConfig.access`）
- 新增 `skills/collab/SKILL.md`（随包分发）与 CI frontmatter 校验

## [0.1.0] - 2026-11-17

首个版本：`@inf-studio/collab` 由仓库内单文件插件 `.opencode/plugins/collab.js`
迁移为独立 TS 包。工具签名、文案、状态机、存储键与 `bid` 算法保持不变。

### Added

- 十个原生工具：`collab_list` / `collab_inbox` / `collab_wait` / `collab_send` /
  `collab_reply` / `collab_handoff` / `collab_broadcast` / `collab_accept` /
  `collab_grant` / `collab_promote`。
- `context` hook：未读消息与未闭环交接各注入一次（去重，≤ `maxInject` 条）。
- 跨工作区交接链路：确定性打分（0–100 + `why`）、原子领取（`<bid>.lock`）、
  5 分钟问询租约与顺延、`DECLINE <bid>`、租约到期的只读自动闭环。
- 会话级权限补丁（`collab_grant`）与 agent 切换（`collab_promote`），共用一份
  `collab-grants/<sid>.json` 台账（两半互不覆盖，`revoke` / `revert` 各清一半）。
- 模块结构：`src/core`（storage / claim / score / verdict / lineage / grants）、
  `src/tools`、`src/hooks`、`src/config.ts`、`src/index.ts`。
- `test/handoff-harness.mjs`（279 项：单文件版的 274 项 + S68）、
  `test/readonly-default.mjs`（12 项只读默认/护栏）与
  `scripts/parity-single-file.mjs`（16 项双轨对比：十个工具的契约 + 五个预览输出逐字一致；
  单文件版退役后自动跳过）。

### Changed

- 插件 `options` 新增 `allowWrite`（默认 `false`）：新装包默认**只读**，不修改任何
  会话的 permissions / agent；消息、回执、收发、打分全部可用。单文件版无此开关
  （其行为等价于 `allowWrite:true`）。

### Fixed

- `collab_grant` 预览在台账**只有 promote 半段**（有 `agentBefore`、无 permissions
  快照）时崩溃：`TypeError: … reading 'join'`。现在按「无授权记录」报告，并说明
  确认授权时会补写 grant 半段、两半共存（回归用例 S68）。

### Notes

- 运行时零第三方依赖；`@opencode/plugin` 由宿主提供，`@opencode/client` 仅 `import type`。
- 存储格式与单文件版一致（`collab/*` 键、`~/.config/opencode/collab-broadcast/`、
  `collab-grants/`），切换加载方式无需迁移数据。
