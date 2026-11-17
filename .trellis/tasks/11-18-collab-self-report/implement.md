# 执行计划：缺陷自上报 + 挂起监控

> 依赖：`11-18-collab-protected-receipt` 先归档（同仓 `src/**` 串行）。

## 1. 上报内核

- [ ] `src/core/report.ts`：`signature()` / `buildEvidence()`（白名单 + 截断）/ `writeReport()`（tmp+rename）/ `shouldReport()`（1h 限流）
- [ ] `src/core/errors.ts`：`ValidationError` 标记类；`classify(error)` → `DefectClass | undefined`
- [ ] `withReport(toolName, fn)` 包裹各工具 `execute`（旁路，不改返回）

## 2. 证据与脱敏

- [ ] 版本来源：构建期常量或 `package.json` 注入
- [ ] 短 id、消息截断 2KB、stackTop 5 帧
- [ ] 禁字段清单单元测试（含敏感样本）

## 3. 投递

- [ ] `config.report = { to?, enabled? }` 解析
- [ ] 目标非 protect → `collab_send note`；失败只记日志
- [ ] 默认只落盘

## 4. 挂起监控

- [ ] `staleClass(record)`：`open-stale` / `claimed-lapsed` / `acked-stale`
- [ ] `collab_list` 与 `context` 注入各输出一次（每类每 session 去重）

## 4.5 维护方消费端（R9）

- [ ] `scripts/collab-triage.mjs`：扫目录 → 按 signature 归并 → 生成/追加 `docs/issues/bugs-collab-<sig>.md`
- [ ] 幂等：`triagedAt` 索引；`--dry-run` / `--since` / `--notify`；文件锁
- [ ] 维护方 `SessionStart` 摘要「未处理上报 N 条」（被动）
- [ ] README 写 cron 示例（不自动安装）

## 5. 回归

- [ ] harness S72+：异常→落盘一次；重复→不新增；校验错误→不上报；`report.to`→收到 note；protected→只落盘；脱敏断言
- [ ] 挂起三类各一条用例
- [ ] 既有 301 不回归

## 6. 文档与发布

- [ ] 文档迁到本仓后补「缺陷上报 / 挂起监控」小节（见下）
- [ ] `0.1.3`（或与 11-18 合并到 0.1.2，视时序）

## 验证命令

```
pnpm build && pnpm typecheck && pnpm test
COLLAB_REPORT_DIR=/tmp/... node test/handoff-harness.mjs
```

## 回滚

删 `collab-reports/`；`git restore -- src/`；配置去掉 `report`。
