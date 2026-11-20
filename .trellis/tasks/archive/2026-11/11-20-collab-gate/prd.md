# 协作闸门：接单前模型表态（0.9.2）

> **口径变更（用户已拍板，覆盖初稿）**：初版用「关键词 + 别名」判断越界，复核证明它既会误伤主线单
> （`排钟 Redis 缓存键设计` 被判越界），又把领域词写死进通用插件。现在**完全删除关键词/别名匹配**，
> 判断权交给会话自己的模型：插件只负责**逼它表态 + 记录**，不做语义推断。

## 问题

- 排钟专题在 13:00–00:52 期间把主要精力投入 ws 集群（14:00 起「排钟」关键词归零、ws 98 次），最终要人类 766 字手工拉回主线。
- 现状所有规则都是**可选建议**：22 个工具没有任何一个会拒绝越界动作。
- 「插件猜越界」不可行：通用的子串/别名表必然误伤（`redis` 同时属于 ws 集群与排钟缓存键），
  而领域词不该写进插件。

## 需求

- **R1 接单表态（accept）**：契约存在且 `mission.outOfScope` **非空** → `collab_accept` 必须带
  `scopeCheck: { inScope: boolean; reason?: string }`：
  - 缺 `scopeCheck` → **拒绝**，文案给出二选一的可复制调用（`inScope:false, reason:"…"` / `inScope:true`），
    并说明「插件不做语义判断」；
  - `inScope:false` → 拒绝接单，返回 `handoffTo`（取自 `mission.handoffTo`，没有则提示「请转交 owner」）+
    override 用法（`override:{reason,approvedBy}`，仅供人类批准时使用）；
  - `inScope:true` → 正常接单；
  - 契约缺失或 `outOfScope` 为空 → 不需要表态，行为与 0.9.1 完全一致。
- **R2 审计**：**每一次表态都写 audit**（true 与 false 都写），一行一条：
  `{at,sid,kind:'accept',bid,inScope,reason,verifiedBy:'model'|'override',approvedBy?}`；
  override 通过后 `verifiedBy:'override'`。写失败不阻断动作。
- **R3 派活不拦**：`broadcast` / `handoff` **永不要求表态、永不拒绝**（派活是清账手段）。
- **R4 回复不校验**：`reply` / `send` 不校验 scope（回复不扩大边界）。
- **R5 溢出只提醒**：`open todos ≥ 8` → **不拦任何动作**，只在 `accept` / `broadcast` / `handoff` 的返回
  末尾加一行 `[溢出提醒] …`。注入头 `[todo]` 已有计数，不再造第二套。
- **R6 开关**：`gate: 'enforce' | 'warn' | 'off'`（默认 `enforce`）；`warn` 把「缺表态」等拒绝降为提示，
  `off` 完全跳过（不拒绝、不提醒、不写 audit）。

## 必须删除

- `DEFAULT_SCOPE_ALIASES`（constants）、`scopeAliases`（config）、`matchScope` / `matchScopeEntries` 及一切
  子串/别名/归一化匹配代码；`grep -rn "scopeAliases\|DEFAULT_SCOPE_ALIASES\|matchScope" src/` 必须为空。
- 连带：注入里的 `[scope]` 小节（同一个关键词匹配器）一并移除，注入从五段变四段
  （`[mission] [todo] [drift] [progress]`）。

## 验收

- [ ] 有 `outOfScope` + 缺 `scopeCheck` → 拒绝，文案含两种可复制调用，且**记录逐字节不变**
      （`state` / `claim` / `asked` / `attempts` / lock 全不变）。
- [ ] `inScope:false` → 拒绝、给 `handoffTo`、audit 一行（`verifiedBy:'model'`）。
- [ ] `inScope:false` + 合法 override → 接单成功、audit 一行（`verifiedBy:'override'`，含 `approvedBy`）。
- [ ] `inScope:true` → 接单成功、audit 一行（`verifiedBy:'model'`）。
- [ ] `approvedBy` 缺省 / 以 `ses_` 开头 → 拒绝。
- [ ] 契约无 `outOfScope` → 不需要表态，行为与 0.9.1 逐字节一致（无 audit）。
- [ ] `open todos = 8` 时 `accept` / `broadcast` / `handoff` 照常放行 + 提醒行。
- [ ] 「已被领取」返回原文、不被闸门改写；spawn 自领 ACK 不被误报。
- [ ] `gate:'warn'` 缺表态只提示；`gate:'off'` 完全跳过。
- [ ] protected 行为不变；工具数不变（26）。
- [ ] 回归全绿；变异：把「缺 `scopeCheck` 拒绝」改成放行 → 对应用例必红。

## 依赖

- 依赖 `0.9.1 collab-contract`（`mission.outOfScope` / `handoffTo` / `todos`）。

## 影响文件

`src/core/gate.ts`（新）、`src/core/audit.ts`（新）、`src/tools/accept.ts`、`src/tools/broadcast.ts`、
`src/tools/handoff.ts`、`src/config.ts`、`src/constants.ts`、`src/core/contract.ts`（删 `[scope]`）、
`src/hooks/context.ts`、`test/gate.mjs`（新）、`test/contract-inject.mjs`。
