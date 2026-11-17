# 执行计划：协作链路加固

## 1. 代码（`.opencode/plugins/collab.js`）

- [ ] R1-1 `collab_accept` 加血缘护栏（protected / protected-child 拒绝领取）
- [ ] R1-2 接管请求注入完整 `record.from.sid`，文案给出 `collab_send{target}` 写法
- [ ] R1-3 `DECLINE` 优先按 `bid` 解析；文案要求带 `bid`
- [ ] R1-4 `collab_list` 输出 `lease=ok|expired`（只读判定，不改状态）
- [ ] R1-5 广播存储写入时清理 `done/expired` 超 7 天记录（每次 ≤20 个）
- [ ] 既有 124 项用例不得回归

## 2. 回归与门禁

- [ ] harness 迁到 `scripts/collab/handoff-harness.mjs`（归档内保留快照，不改归档）
- [ ] 根 `package.json` 加 `test:collab`
- [ ] CI workflow 增加 `pnpm test:collab`
- [ ] `docs/development.md` 回归清单补一行
- [ ] 新增用例：protected 领取被拒 / DECLINE 带 bid / 列表 lease / 清理上限

## 3. 文档

- [ ] guide §4 / §5.3 / §6 / §10 与实现对齐
- [ ] `docs/collab.md` §12 同步

## 4. 真实试点（主会话执行，不经子代理）

- [ ] 预览 `collab_broadcast`（`confirm:false`）
- [ ] 确认后投递；记录 `bid`、候选、`why`
- [ ] 观察 10 分钟：`collab_wait{target}` 或回执；超时只记录
- [ ] 试点结果写 `research/pilot.md`

## 5. 清理与收口

- [ ] `rm -rf /tmp/collab-sandbox`
- [ ] 归档内 `broadcast-samples/` 保留
- [ ] 独立复核（`trellis-check`）→ 提交（显式路径、不 push）→ 归档

## 回滚

`git restore -- .opencode/plugins/collab.js scripts/collab docs/development.md .github/workflows/*`；
试点 `bid` 文件保留，`done/expired` 由清理策略处理。
