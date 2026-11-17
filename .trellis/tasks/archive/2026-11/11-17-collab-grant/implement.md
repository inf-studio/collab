# 执行计划：会话级权限补丁 + agent 升级

> 完成记录见 `research/impl-notes.md`（`file:line`、harness 用例、真实链路原始输出、未验证项）。

## 1. 代码（`.opencode/plugins/collab.js`）

- [x] 常量 `COLLAB_TOOL_ACTIONS = ["collab_list","collab_inbox","collab_wait","collab_reply","collab_send"]`（`:207`）
- [x] `readSessionPermissions`（`:2040`）/ `patchSessionPermissions`（`:2051`，`ctx.session.update` 优先，`COLLAB_SERVER_URL` 显式 HTTP fallback）
- [x] `mergeRules`（`:708`）按 `action + resource` 去重；保留 base 顺序与优先级
- [x] `collab_broadcast` spawn 成功后：`grantForSession(sid, {reason:"spawn"})`（`:2959`），失败只记录 `permissionGrant:"failed"`
- [x] 新增工具 `collab_grant`（`:3600`）：预览 / 确认 / `revoke` 还原
- [x] 目标为 `[protected*]` → 拒绝（复用血缘护栏）
- [x] 只允许白名单 5 条 action；其它一律报错（`assertCollabOnly` `:731`）
- [x] 台账 `~/.config/opencode/collab-grants/<sid>.json` 存 `before` 快照，两半合并写（`writeGrant` `:784`）

## 2. 回归

- [x] harness 新增用例（S54–S67）：
      spawn 后 `permissions` 含 5 条 / 既有会话默认不被修改 / `mergeRules` 保留原有规则 /
      `revoke` 往返与 `before` 一致 / 非白名单 action 被拒 / PATCH 失败不阻断交接
- [x] 既有 212 项全绿；当前 `274/274`，`pnpm test:collab` exit 0

## 3. 文档

- [x] guide §2/§4/§7（拉新）/ §9（护栏）/ §10（已知偏差 #12/#13）/ §11（验收）补「会话级权限补丁」与「grant ≠ promote」
- [x] `docs/collab.md` §11.2 增 `collab_grant` / `collab_promote`，§12.2 台账、§12.3 流程、§12.5 限制
- [x] `docs/development.md` 计数（274，以脚本实际输出为准）

## 4. 真实验证

- [x] `muke-interface` 临时 explore → `collab_grant` → 模型自述含 5 工具（GET 亦含 5 条）→ `revoke` → 行为探针 `UNAVAILABLE`
      → 删会话（404），台账目录空
- [x] 临时 explore → `collab_promote`（build）→ GET `agent=build` / `permissions=None` → `revert` → GET `agent=explore`
      → 删会话（404），台账目录空

## 5. 收口

- [x] `node --check`、harness、`pnpm test:collab`
- [ ] 独立复核 → 提交（显式路径、不 push）→ 归档

## R7（追加，owner 已拍板）`collab_promote`

- [x] 工具 `collab_promote { target, agent?, confirm, revert? }`（`:3740`）
- [x] 默认 `build`，白名单 `PROMOTE_AGENTS = ["build","plan"]`（`:215`）；非白名单在写任何东西前抛错
- [x] `confirm:true` 才发 `POST /api/session/{target}/agent`（`switchSessionAgent` `:2178`）
- [x] `revert:true` 按 `agentBefore` 切回（`revertSessionAgent` `:2256`）；无记录报「无可还原」
- [x] 台账扩展 `agentBefore` / `promotedAt` / `promotedBy`，与 permissions 半段合并写、互不覆盖
- [x] 护栏：`[protected*]` 拒绝；白名单外 agent 拒绝；失败可读且不影响已有交接
- [x] spawn 路径**不**自动 promote（S54 断言）
- [x] harness S61–S67；真实链路已验证并清理
- [x] 文档：guide §2/§7/§9/§10/§11 + `docs/collab.md` §11.2/§12.2/§12.3/§12.5（含「review 永不 promote」）

## 回滚

`git restore -- .opencode/plugins/collab.js scripts/collab/handoff-harness.mjs`；删 `~/.config/opencode/collab-grants/`；
已授权的会话用 `collab_grant{revoke:true}` 还原，已升级的会话用 `collab_promote{revert:true}` 还原。
