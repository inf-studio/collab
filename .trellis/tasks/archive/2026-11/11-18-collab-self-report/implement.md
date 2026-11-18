# 执行计划：缺陷自上报 + 挂起监控

> 依赖：`11-18-collab-protected-receipt` 先归档（同仓 `src/**` 串行）。✅ 已归档（0.1.2）。
> 状态：**已完成**（0.1.3，375 + 12 全绿；含独立复核后的修复轮 F1–F4 + F7 守门）。
> 实施记录见 `research/impl-notes.md`（§6 = 复核修复轮）。

## 1. 上报内核

- [x] `src/core/report.ts`：`signature()` / `buildEvidence()`（白名单 + 截断）/ `writeReport()`（tmp+rename）/ `shouldReport()`（1h 限流）
- [x] `src/core/errors.ts`：`ValidationError` 标记类；`classify(error)` → `DefectClass | undefined`
- [x] `withReport(toolName, fn)` 包裹各工具 `execute`（旁路，不改返回）—— 实为 `reporter.wrap`，在 `registerTools` 统一包裹

## 2. 证据与脱敏

- [x] 版本来源：`PLUGIN_VERSION`（`src/constants.ts`，与 `package.json` 同步，harness 断言相等）
- [x] 短 id、消息截断 2KB、stackTop 5 帧
- [x] 禁字段清单单元测试（含敏感样本）—— S72（a）正文/token 双向断言 + 分类法单测

## 3. 投递

- [x] `config.report = { to?, enabled? }` 解析
- [x] 目标非 protect → `collab_send note`（等价 `session.prompt`：`note` + `queue` + envelope）；失败只记日志
- [x] 默认只落盘

## 4. 挂起监控

- [x] `staleClass(record)`：`open-stale` / `claimed-lapsed` / `acked-stale`
- [x] `collab_list` 与 `context` 注入各输出一次（按 `(session, class, bid)` 去重，存储 `collab/stale-seen/<sid>`）

## 4.5 维护方消费端（R9）

- [x] `scripts/collab-triage.mjs`：扫目录 → 按 signature 归并 → 生成/追加 `docs/issues/bugs-collab-<sig>.md`
- [x] 幂等：`triagedAt` 索引；`--dry-run` / `--since` / `--notify`；文件锁（`.triage.lock`）
- [x] 维护方「启动视图」摘要「未处理上报 N 条」—— 插件无 SessionStart hook，落在 setup 日志 +
      `context` 注入（仅 `report.to` 指向的会话）+ `collab_list`
- [x] README 写 cron 示例（不自动安装）

## 5. 回归

- [x] harness S72+：异常→落盘一次；重复→不新增；校验错误→不上报；`report.to`→收到 note；protected→只落盘；脱敏断言
- [x] 挂起三类各一条用例
- [x] 既有 310 不回归（基线随 0.1.2 从 301 → 310）

## 6. 文档与发布

- [x] 文档迁到本仓后补「缺陷上报 / 挂起监控」小节（README / SKILL §六点五 / docs/collab.md §11.8）
- [x] `0.1.3`（`package.json` + `PLUGIN_VERSION` + CHANGELOG 顶部）

## 验证命令

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
node scripts/collab-triage.mjs --dry-run
```

## 回滚

删 `collab-reports/`；`git restore -- src/`；配置去掉 `report`（或 `report.enabled:false` 只关投递）。

## 复核修复轮（F1–F4，见 `research/impl-notes.md` §6）

- [x] F1 `collab_wait`：只有**超时**是 `invalid`；宿主 5xx → `delivery-5xx`、其它 → `uncaught`（都上报）
- [x] F2 `collab_accept`：`notifyRequester` 回传 `error` → 回执/ACCEPT 投递失败也 `reportNow(delivery-5xx)`，返回文案不变
- [x] F3 `collab-triage`：先 `mkdirSync`；`ENOENT` 不再误报「另一个 triage 正在运行」
- [x] F4 上报 note 的 `fromSessionID` 用完整 `ses_…`（证据仍只存短 id）
- [x] F7 守门：`__internals.BUILTIN_PROTECT` + S79b 比对脚本里复制的名单
- [x] 回归 S77–S80 + S79b（11 项），既有 364 + 12 不回归

## 实施中的取舍（详见 `research/impl-notes.md` §4）

1. `ValidationError` 同时承载「参数校验」与「正常业务拒绝」（PRD R1 两类都不上报）。
2. `guard-conflict` 是防御式分支（现有两个调用点已算过白名单），分类法有单测。
3. triage `--notify` 走 `COLLAB_SERVER_URL` 的 `POST /api/session/{sid}/prompt`（不猜端口）。
4. `index.json` 条目为对象（含 `triagedAt`），读取兼容旧的数字写法。
5. 挂起提醒只显示「本会话相关」的单；全局积压看 triage。
