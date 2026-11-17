# 协作可靠性：插件缺陷自上报 + 挂起监控

> 动机：插件本身的缺陷（护栏冲突、状态机死角、投递不可达）会让协作**静默挂起**数小时甚至一天，
> 而调用方往往只能看到一句「被拒绝」，无法把现场准确传回维护方。

## 背景

- 已发生的实例：受保护发起方的回执被护栏拒绝（`b_bdae8488…` 卡 `acked` 33m+）、`accept/handoff` 领取的单无自动收口（`b_26325553…` 卡 14.8h）。
- 现状：调用方只能靠人描述现象；插件没有结构化上报能力，也没有「挂起清单」的可执行视图。

## 维护方模型（owner 已定，2026-11-18）

- **维护方 = 当前主会话**（插件落地初期缺陷多，需要人/主会话及时消费并修）。
- **主通道 = 投递**：缺陷证据通过 `collab_send`（`note` + `queue`）直达维护方会话，空闲也会被唤醒；
  文件（`collab-reports/`）只是证据与兜底，不是主通道。
- **兜底 = cron 补投**：每 15 分钟扫未确认上报，重投给 `report.to`；并自动生成
  `docs/issues/bugs-collab-<sig>.md`，避免维护方掉线期间堆积。
- **闭环 = 维护方修复 + 发补丁版本**：读证据 → 复现 → 开 Trellis 任务 → 修 → 发 `0.1.x` → 回执上报方。
- **边界**：维护方只改插件仓；不写上报方工作区代码；高风险改动仍先问 owner。

## Requirements

- **R1 缺陷识别与上报**：工具执行中捕获到**非用户输入类**异常时，收集现场证据并落盘：
  - 触发：未捕获异常 / 内部不变量失败 / 护栏与指令冲突（如「要求回执但目标受保护」）/ 投递 5xx / 提取异常；
  - 不触发：参数校验类错误（空 text、非法 bid、未知 target）、正常业务拒绝。
- **R2 证据内容**（脱敏）：插件版本、工具名、错误名与消息（截断 2KB）、stack 摘要、bid/thread、from/claim 短 id、workspace、记录状态快照、时间戳；**不含**消息正文全文、token、文件内容。
- **R3 落盘**：`~/.config/opencode/collab-reports/<signature>/<ts>.json`（证据）+ 同目录 `<ts>.md`（可直接当 issue 草稿：现象/复现/证据/影响面）。
- **R4 去重与限流**：`signature = hash(version + tool + errorName + 归一化 message)`；同一 signature 每 **1 小时最多 1 条**。
- **R5 投递**：配置 `report: { to: "<alias|sid>" }` 时，额外 `collab_send`（`kind=note`, `queue`）给维护方，
  正文一句话 + 报告路径；未配置则只落盘。目标命中 `protect` 时不投递（只落盘）。
- **R6 挂起监控**：会话级视图新增「挂起分类」：`open > 1h` / `claimed > lease` / `acked > 2h`，
  在 `collab_list` 或 `context` 注入中各出现一次；与 R1 共用去重。
- **R7 隐私与安全**：上报内容经过白名单字段裁剪；不因上报而改变任何协作状态；上报失败不得影响工具主流程。

- **R8 可发现性（本次事故的直接教训）**：上报能力不能是"藏起来的开关"，必须让**所有使用方**在第一现场就知道：
  1. 任何 `collab_*` 工具抛出**非参数校验类**错误时，错误文案末尾追加一行
     `提示: 若怀疑是插件缺陷，运行 collab_report { confirm:true } 上报现场（或看 <reportDir>）`；
  2. `collab_list` 末尾固定一行「缺陷上报：<路径/命令>」；
  3. README + skill 增加「遇到异常怎么办」一节（含 `report.to` 配置示例与证据脱敏说明）；
  4. 插件 setup 日志（stderr）打印 `reportDir=<路径>` 与是否已配置 `report.to`；
  5. 新版本发布时在 CHANGELOG 顶部写明「本次起支持缺陷上报」。
  目标：使用方**不需要读文档**也能在报错当下看到上报入口。

- **R9 维护方消费端（本条的闭环）**：上报必须有人/有进程读，否则仍会静默堆积。
  1. **一次性 triage 脚本** `scripts/collab-triage.mjs`：扫描 `collab-reports/`，按 signature 去重，
     对未处理的生成/追加 `docs/issues/bugs-collab-<sig>.md`（含证据摘要、受影响版本、首次/最近时间、
     bid 列表），并把 `triagedAt` 写回索引；`--dry-run` / `--since` / `--notify <alias>`。
  2. **被动**：维护方会话 `SessionStart`/`collab_list` 显示「未处理上报 N 条」一次。
  3. **定时**：文档给出 cron 示例（如 `*/15 * * * * node scripts/collab-triage.mjs --notify <alias>`），
     由 owner 决定是否安装；脚本本身幂等、可并发（文件锁）。
  4. **处理闭环**：triage 生成的 issue 由维护方按常规任务流修复；issue 修复后 triage 不再重复生成。

## Acceptance Criteria

- [ ] 注入一个内部异常 → 生成 `<sig>/<ts>.json` + `.md`，字段符合 R2
- [ ] 同一异常 1 小时内重复触发 → 不新增文件
- [ ] 参数校验错误（空 text / 非法 bid）→ **不上报**
- [ ] 配置 `report.to` → 收到一条 `note`；目标为 protected → 只落盘、不投递
- [ ] 报告不含正文全文与 token（用样本含敏感串的输入验证裁剪）
- [ ] `collab_list`/context 能列出三类挂起，且每类只提示一次
- [ ] 非校验类错误文案、`collab_list` 末尾、setup 日志都能看到上报入口（R8）
- [ ] README/skill 有「遇到异常怎么办」；CHANGELOG 顶部有说明
- [ ] `collab-triage` 能按 signature 生成 issue、幂等重跑不重复、`--dry-run` 不落盘
- [ ] 维护方会话能看到「未处理上报 N 条」；cron 示例写进 README
- [ ] harness 全绿（现有 301 + 新增），`build`/`typecheck` 通过

## 边界

- 不上传网络（除 `collab_send` 到配置目标）；不新增依赖。
- 不改变任何工具的既有返回语义（上报是旁路）。
- 不改 `BUILTIN_PROTECT`；不自动关闭挂起单（只提示/上报）。
