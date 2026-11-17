# 执行计划：强制回执 + 到期自动提取

## 1. 代码（`.opencode/plugins/collab.js`）

- [x] R1 接管请求 / 叫醒 prompt 改为三段式（领取命令、回执命令、禁止只分析不动作）
- [x] R2 `extractVerdict(sessionID)`：只读最后一条 assistant 文本，`[handoff]` 前缀优先，关键词兜底，200 字摘要
- [x] R2 租约刷新处接提取：判定成功 → `receipt{auto:true}` + `done|blocked`，不拉新；失败 → 原逻辑
- [x] 404 / 无消息 / 无 text → undefined，不抛错
- [x] 提取后不重复执行（终态不再刷新）

### 1.1 复核修复轮（H1 / H2 / L1）

- [x] H1 `extractVerdict(sessionID, { bid })` 传入当前 bid；`[handoff]` 行目标必须等于该 bid（占位符/其它 bid/无目标不采信）
- [x] H1 否定护栏 + 计划语护栏（`未完成/无法完成/not done yet`、`完成后我会…`）→ `undefined`，不误闭环
- [x] H1 只判**最后一条有实质文本**的 assistant 回答（不跨条拼接、不回看更早回答；tool-only 末条跳过）
- [x] H2 `refresh(record, now, { actor })`：只有 `actor === record.from?.sid` 才允许自动提取闭环；旁观者只走原顺延
- [x] L1 `ctx.session.context({ limit: 10 })` 优先，宿主不支持时回退全量读

### 1.2 第二轮复核修复（H1 残留：整行回显 R1 命令）

- [x] 新增 `VERDICT_ECHO_RE = /<[^>]{0,32}>/`；摘要位**任意位置**残留 `<…>` 占位符 → 不采信（`continue`），不再只做整串精确匹配
- [x] 同一处检查天然覆盖 `BLOCKED` 分支；目标位仍用 `VERDICT_PLACEHOLDER_RE`（精确匹配 `<bid>` token）
- [x] 既有护栏不变：目标 = 当前 bid、否定/计划语、只看最后一条有文本的 assistant、actor 闸门、`[protected*]`
- [x] harness 新增 S53（+8，204 → 212）：整行回显 `", confirm:true}` / 反引号 / `（以上是示例）` / `【<原因>】` 都不闭环；`[handoff] DONE <当前bid> 修好了` 仍闭环（正向对照）
- [x] guide §5.3/§11、`docs/collab.md` §12.3/§12.5、`docs/development.md` 计数同步（212）

## 2. 回归

- [x] harness 新增用例（S44–S50）：
  - R1 文案含 ①②③ 与完整 sid / bid；
  - 到期 + 对端有 `[handoff] BLOCKED` → 自动 blocked，不 spawn；
  - 到期 + 对端仅关键词 → done/blocked 判定正确；
  - 到期 + 对端无结论 → 原顺延路径；
  - 会话 404 → 不抛错、走原逻辑；
  - 摘要 ≤200 字。
- [x] harness 新增用例（S51–S52，复核轮）：回显模板（`<bid>`/`<摘要>`/本 bid 写在承诺句/其它 bid）、否定语、两消息「模板 + 未开始」都不闭环；
      真 `[handoff] DONE|BLOCKED <当前 bid>` 闭环；旁观会话与新工作区会话不读不闭环，发起方才闭环
- [x] 既有 155 项全绿；`pnpm test:collab` exit 0（第二轮复核修复后当前 **212/212**）
- [x] 第二轮复核脚本 `research/check-round2-probes.mjs` 34/34 全绿（修复前 25/34）

## 3. 文档

- [x] guide §5.2 / §5.3 / §6 / §10 补「到期自动提取」与「强制回执动作」
- [x] guide §5.3 / §9 / §11 补 H1/H2 边界与验收项；修正「回溯更早回答」旧措辞、`receipt.auto:false` 示例
- [x] `docs/collab.md` §12 同步
- [x] `docs/development.md` harness 计数改为「以脚本实际输出为准（当前 212）」
- [x] 试点结论（G1）引用到 guide 的已知限制/设计说明

## 4. 验证与收口

- [x] `node --check`
- [x] 独立复核（`trellis-check`）→ `research/check-report.md`，H1/H2 已按报告修复
- [x] 第二轮独立复核 → `research/check-report-round2.md`，唯一阻塞（整行回显误闭环）已修 → `research/impl-notes.md` §8
- [ ] 提交（显式路径、不 push）→ 归档

> 注：新行为需插件重载/重启后生效；提交时不要重启服务。

## 回滚

`git restore -- .opencode/plugins/collab.js scripts/collab/handoff-harness.mjs docs/collab.md docs/development.md .trellis/spec/guides/cross-workspace-collab-guide.md`
