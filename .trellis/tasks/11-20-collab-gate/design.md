# 设计：协作闸门（0.9.2）—— 表态，不推断

## 1. 边界

只拦**协作动作**里的**接单**（`accept`）；`broadcast` / `handoff` 永不拒绝，`reply` / `send` 不校验。
不拦 bash、不改权限、不放宽 protected。契约不存在或 `outOfScope` 为空时行为与 0.9.1 完全一致。

**为什么不做匹配**：初稿把 `mission.outOfScope` 与 bid 文案做子串匹配（含别名表），复核出现
`排钟 Redis 缓存键设计` 被判越界——`redis` 既是 ws 集群的别名，也是排钟缓存键的词。任何通用插件都无法靠
子串判断「这条算不算那个边界」，把领域词写进插件更不行。结论：**插件不判断，只逼表态并记录**。

## 2. 模块

| 文件 | 职责 |
|---|---|
| `src/core/gate.ts`（新） | `evaluate(kind, payload, contract, config, opts?)` → `{verdict, reason, handoffTo?, overrideUsage?, content, reminder?, statement?}`；解析 `scopeCheck` / `override`；溢出提醒 |
| `src/core/audit.ts`（新） | append `collab-audit.jsonl`（每次表态一行） |
| `src/tools/accept.ts` | 新入参 `scopeCheck`；`persistRefresh` **之前**判定；拒绝零写入 |
| `src/tools/broadcast.ts` / `handoff.ts` | 只取 `reminder`（永不拒绝） |
| `src/config.ts` / `src/constants.ts` | `gate` 三档（默认 `enforce`）；删除 `scopeAliases` / `DEFAULT_SCOPE_ALIASES` |
| `src/core/contract.ts` / `src/hooks/context.ts` | 删除 `matchScope` 与注入里的 `[scope]` 小节 |

## 3. 接单表态

```ts
scopeCheck: { inScope: boolean; reason?: string }
```

载荷只有 `{ bid, scopeCheck, override }`：插件**不接受**标题/文件/关键词等用于判断的输入。

| 契约状态 | `scopeCheck` | 结果 |
|---|---|---|
| `outOfScope` 非空 | 缺失 / 非对象 / `inScope` 非布尔 | **拒绝** `SCOPE_UNSTATED`：说明「插件不做语义判断」，给两种可复制调用 + override 形式 |
| `outOfScope` 非空 | `inScope:true` | 放行；写 audit（`verifiedBy:'model'`） |
| `outOfScope` 非空 | `inScope:false` | **拒绝** `SCOPE_OUT`：给 `handoffTo`（`mission.handoffTo` 唯一值；多个则全列）+ override 用法；写 audit（`inScope:false`） |
| `outOfScope` 非空 | `inScope:false` + 合法 override | 放行；写 audit（`verifiedBy:'override'`，含 `approvedBy`） |
| 契约缺失 / `outOfScope` 为空 | 任意（通常缺省） | 放行，**不写 audit**，输出与 0.9.1 一致 |

- 只有 `accept` 需要表态；`broadcast` / `handoff` / `reply` / `send` 永不要求、永不拒绝。
- `handoffTo` 不再按命中项查表（没有「命中项」）：`mission.handoffTo` 有**一个**不同目标 → 直接给；
  多个 → 文案里全列出（`handoffTo` 字段留空，避免暗示某一个是「对的」）；没有 → 提示「转交 owner」。

## 4. 执行顺序（复核 #3/#4）

`collab_accept` 的顺序固定为：

```
guards(protect/freeze)
→ chain.refresh(existing)       只读，得到 snapshot
→ newClaim = snapshot.state === 'open'
→ evaluate(...)                 只有 newClaim 才可能 deny
→ deny && confirm → throw       此时尚未 persistRefresh ⇒ 记录零变化
→ persistRefresh(existing, snapshot)
→ expired / done / 已领取 / spawn 自领 ACK 分支
→ 预览 / claimLock / 写 acked
```

- 「已被领取」「你已领取（spawn 自领 ACK）」「已闭环」「已过期」都不是新接单，**不经过闸门**；
- 拒绝的 `accept` 不改 `state` / `claim` / `asked` / `attempts`，也不建 `<bid>.lock`（测试逐字节断言）；
- 预览（`confirm:false`）只展示拒绝文案，不抛错、不写 audit。

## 5. override

```ts
override: { reason: string; approvedBy: string }
```

- 只在 `inScope:false` 时有意义；两者必填，`approvedBy` 不得以 `ses_` 开头（会话不能给自己批越界）；
- 通过 → 放行 + audit 一行 `{inScope:false, verifiedBy:'override', approvedBy}`；
- 缺字段 / 非法 → 同「没有 override」一样拒绝，并指名缺哪个字段；
- 单独给 `override` 而没有 `scopeCheck` 仍算**未表态**（override 不是表态的替代品）。

## 6. 审计

`~/.config/opencode/collab-audit.jsonl`，append-only，一行一条，**只有表态才写**：

```json
{"at":0,"sid":"ses_…","kind":"accept","bid":"b_…","inScope":true,"reason":"排钟主线内","verifiedBy":"model"}
{"at":0,"sid":"ses_…","kind":"accept","bid":"b_…","inScope":false,"reason":"…","verifiedBy":"override","approvedBy":"@长久同学^v^"}
```

- 未表态的拒绝（`SCOPE_UNSTATED`）、溢出提醒、`gate:"off"`、预览：**不写**（没有判断可记）；
- 写失败只记日志，不阻断动作；`COLLAB_AUDIT_FILE` 可覆盖（测试 / 沙箱）。
- 与看板动作审计（`{at,actor,action,target,ok,reason}`）共用同一文件，行形状按 `verifiedBy` / `action` 区分。

## 7. 溢出（R5）

`openTodos ≥ 8`（`status ∈ {open, doing, blocked, suspended}`）→ 在 `accept` / `broadcast` / `handoff` 的
返回**末尾**追加一行：

```
[溢出提醒] 你已有 8 条协作待办；若这次接单/派活会把它们挂起，先处理再继续。
```

不拒绝、不写 audit、不改状态。`gate:"off"` 时连这一行也不出现。注入头 `[todo]` 已有计数，不重复造第二套。

## 8. 开关

| 值 | 行为 |
|---|---|
| `enforce`（默认） | 按 §3 执行 |
| `warn` | `SCOPE_UNSTATED` / `SCOPE_OUT` 降为放行 + 提示（`[gate="warn"：只提示不拦截]`）；已作出的表态**照常写 audit** |
| `off` | 完全跳过：不要求表态、不拒绝、不提醒、不写 audit |

写错的值（`"of"`、`false`）回落 `enforce`——回滚开关不能因为手滑就静默失效。

## 9. 测试（`test/gate.mjs`，62 项）

| 用例 | 断言 |
|---|---|
| 有 outOfScope + 缺 scopeCheck | 拒绝；含「不做语义判断」+ 两种可复制调用 + override 形式；记录逐字节不变、无 lock；不写 audit |
| `inScope:false` | 拒绝 + `handoffTo` + audit（model） |
| `inScope:false` + override | 接单成功 + audit（override、approvedBy） |
| `approvedBy:"ses_…"` | 拒绝且记录未动 |
| `inScope:true` | 接单成功 + audit（model） |
| 无 outOfScope | 不需要表态、无 audit、输出无闸门字样 |
| open=8 | accept / broadcast / handoff 全部放行 + 提醒行；`evaluate('broadcast')` 恒 `allow` |
| 已被领取 / spawn 自领 | 原文返回、记录未动、无表态不写 audit |
| reply / send | 永不校验 |
| `gate:"warn"` | 缺表态只提示；`inScope:false` 放行但仍写 audit |
| `gate:"off"` | 全跳过（无提醒、无 audit） |
| protected | 行为不变 |
| audit 形状 | 无 `verdict` 字段；`inScope` 布尔；`verifiedBy ∈ {model,override}` |

变异（强制）：把「缺 `scopeCheck` 拒绝」改成放行 → 「缺 scopeCheck」组必红（实测 8 项红）。

## 10. 回滚

```bash
git restore -- src/tools/accept.ts src/tools/broadcast.ts src/tools/handoff.ts src/config.ts \
              src/types.ts src/constants.ts src/core/contract.ts src/hooks/context.ts src/index.ts
rm -f src/core/gate.ts src/core/audit.ts
```

紧急停用：`collab.json` 的 `gate` 设为 `"off"`（即时生效，配置按 mtime 重读）。
