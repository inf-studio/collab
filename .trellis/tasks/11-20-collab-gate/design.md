# 设计：协作闸门（0.9.2）

## 1. 边界

只拦**协作动作**（`accept` / `broadcast` / `handoff`），不拦 bash、不改权限、不放宽 protected。契约不存在时一律放行（升级期零影响）。

## 2. 模块

| 文件 | 职责 |
|---|---|
| `src/core/gate.ts`（新） | `evaluate(kind, payload, contract, config)` → `{verdict, reason, handoffTo, override}` |
| `src/core/audit.ts`（新） | append `collab-audit.jsonl`（override / 拒绝 / 溢出） |
| `src/tools/accept.ts` / `broadcast.ts` / `handoff.ts` | 调用前 `evaluate`，deny 直接返回 |
| `src/config.ts` | `gate: 'enforce'\|'warn'\|'off'`、`scopeAliases` |

## 3. scope 匹配

播报记录没有主题型 `scope` 字段，用文本载荷匹配：

```
bidText = [title, expected, issuePath, affectedFiles.join(' ')].filter(Boolean).join(' ')
```

- 对 `mission.outOfScope` 的每一项，若 `bidText` 命中（子串或 `scopeAliases` 别名）→ 越界；
- `mission.outOfScope` 为空 → **永不越界**（误伤 0）；
- 匹配是大小写不敏感的子串；别名表默认内置少量（如 `ws集群 → wsca,websocket,caddy,redis`），可配置。

## 4. 判定

| kind | 条件 | verdict |
|---|---|---|
| `accept` | 越界 | `deny` + `handoffTo` + override 用法 |
| `accept` | `openTodos ≥ 8` | `deny` + `TODO_OVERFLOW` |
| `accept` | 未越界且未溢出 | `allow` |
| `broadcast` / `handoff` | `openTodos ≥ 8` | `deny` + `TODO_OVERFLOW` |
| `broadcast` / `handoff` | 越界 | `allow` + `warn`（发起方有权提问） |
| `reply` / `send` | 任何 | `allow`（回复不扩大边界） |
| 任意 | `gate='warn'` | 把 `deny` 降为 `allow + warn` |
| 任意 | `gate='off'` | `allow`，不记 warn |

`openTodos` = `status ∈ {open, doing, blocked, suspended}` 的数量。

## 5. override

```ts
override: { reason: string; approvedBy: string }
```

- 两者必填；`approvedBy` 不得以 `ses_` 开头（必须是人类标识）；
- 通过 → 放行 + 写 audit（`kind, bid, sid, scope, reason, approvedBy, at, verdict:'override'`）；
- 缺字段 → `deny`，reason 指出缺哪个。

## 6. 审计

`~/.config/opencode/collab-audit.jsonl`，append-only，一行一条：

```json
{"at":0,"sid":"ses_…","kind":"accept","bid":"b_…","verdict":"deny|override|overflow","scope":"ws集群实施","reason":"…","approvedBy":"@长久同学^v^"}
```

写失败不阻断动作（只记日志）。

## 7. 测试

| 用例 | 断言 |
|---|---|
| outOfScope 命中 | deny，reason 含 `handoffTo` 与 override 示例 |
| 未命中 | allow |
| outOfScope 为空 | 任何 bid 都 allow |
| override 合法 | allow + audit 一行字段完整 |
| override 缺 approvedBy | deny |
| override approvedBy 以 ses_ 开头 | deny |
| open=8 | accept/broadcast 均 `TODO_OVERFLOW` |
| open=8 关 2 条 | 恢复 allow |
| `gate='warn'` | 越界 allow + warn 文本 |
| `gate='off'` | 越界 allow，无 warn |
| protected 会话 | 行为与 0.8.2 完全一致（不额外放宽） |

变异：scope 校验取反 → 「命中 deny」必红。

## 8. 回滚

```bash
git restore -- src/tools/accept.ts src/tools/broadcast.ts src/tools/handoff.ts src/config.ts
rm -f src/core/gate.ts src/core/audit.ts
```
