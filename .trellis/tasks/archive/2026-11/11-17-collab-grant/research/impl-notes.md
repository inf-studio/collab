# 实现记录：会话级权限补丁（R1–R6）+ agent 升级（R7）

> 任务：`.trellis/tasks/11-17-collab-grant`
> 基线：`opencode v2.3.0`，`pnpm test:collab` 起始 212 checks → 现在 **274 checks / 全绿**。
> 改动文件（仅 5 个 + 本任务目录）：
> `.opencode/plugins/collab.js`、`scripts/collab/handoff-harness.mjs`、
> `.trellis/spec/guides/cross-workspace-collab-guide.md`、`docs/collab.md`、`docs/development.md`。

## 0. 状态一览

| 项 | 状态 | 证据 |
| --- | --- | --- |
| R1 spawn 自动授权 | ✅ | `collab.js:2959`；harness S54；真实链路 1（见 §2） |
| R2 `collab_grant` 预览/确认/还原 | ✅ | `collab.js:3600`；harness S56/S57 |
| R3 合并而非覆盖 | ✅ | `mergeRules` `collab.js:708`；harness S56/S58 |
| R4 幂等 + `before` 快照记录 | ✅ | `writeGrant` `collab.js:784`；harness S56/S57/S62 |
| R5 失败不致命 | ✅ | `grantForSession` `collab.js:2088`；harness S60/S67 |
| R6 回归 | ✅ | 既有 212 项全绿 + 新增 62 项 = 274 |
| R7 `collab_promote` 升级/还原 | ✅ | `collab.js:3740`；harness S61–S67；真实链路 2（见 §3） |

## 1. 代码改法（`file:line`）

### 1.1 常量与纯函数

| 位置 | 内容 |
| --- | --- |
| `.opencode/plugins/collab.js:207` | `COLLAB_TOOL_ACTIONS = [collab_list, collab_inbox, collab_wait, collab_reply, collab_send]`（唯一允许追加的动作） |
| `:209` | `COLLAB_RULE_RESOURCE = "*"` |
| `:215` | `PROMOTE_AGENTS = ["build", "plan"]`（R7 白名单） |
| `:224` | `GRANT_DIR = $COLLAB_GRANT_DIR ?? ~/.config/opencode/collab-grants` |
| `:230` | `SERVER_URL / SERVER_TOKEN`：宿主没有 `ctx.session.update` 时的**显式** HTTP fallback（不猜端口） |
| `:675` | `collabPermissionRules()` 由白名单常量重建 5 条 allow |
| `:684` | `normalizeRules()`：丢弃畸形规则（`action/resource` 非空 + effect ∈ allow/deny/ask），避免一条坏规则让整个 ruleset 被宿主拒绝 |
| `:708` | `mergeRules(base, add)`：`action+resource` 去重，**base 顺序与优先级保留**（已有 `deny` 不会被放宽） |
| `:721` | `missingRules(base, rules)`：预览/记录用「还缺哪几条」 |
| `:731` | `assertCollabOnly()`：fail-closed 白名单；非 5 条 collab 或 `effect!==allow` → 抛错 |
| `:750` | `grantFile()`（文件名做了 `[^\w.-]` 清洗） |
| `:754–802` | `normalizeGrant / readGrant / writeGrant / removeGrant`：**一份台账两个半段**（permissions 半段 `before/added/at/by/reason`；agent 半段 `agentBefore/promotedAt/promotedBy`），`writeGrant` 先读旧文件再合并，`null` 表示清空该字段，两半都空 → 删文件 |

### 1.2 会话侧能力（`createHandoffChain` 内）

| 位置 | 内容 |
| --- | --- |
| `:2040` | `readSessionPermissions()`：`ctx.session.get` → `Session.Info.permissions`（**不缓存**，快照必须精确） |
| `:2051` | `patchSessionPermissions()`：优先 `ctx.session.update({sessionID, permissions})`；无该方法时仅当 `COLLAB_SERVER_URL` 已配置才走 `PATCH /api/session/{id}` |
| `:2088` | `grantForSession()`：读 → 合并 → 仅在有缺失时 PATCH → 回读复核 → 写台账（`before` 取**首次**快照）。全程不抛错，返回 `{ok, changed, added, before, after, verified, record}` |
| `:2137` | `revokeForSession()`：要求 `record.before` 存在 → 整集还原 `before` → **只清 permissions 半段**（promote 半段保留） |
| `:2178` | `switchSessionAgent()`：优先 `ctx.session.switchAgent({sessionID, agent})`，否则 `POST /api/session/{id}/agent`（同样要求显式 `COLLAB_SERVER_URL`） |
| `:2211` | `promoteSession()`：白名单校验 → 读当前 agent → `agentBefore` 首次写死 → 需要时切 agent → 回读复核 → 写 agent 半段（不动 permissions 半段） |
| `:2256` | `revertSessionAgent()`：无 `agentBefore` → `{ok:false,"无可还原"}`；有则切回并只清 agent 半段 |

### 1.3 工具与调用点

| 位置 | 内容 |
| --- | --- |
| `:2959` | `collab_broadcast` spawn 成功后（带 `.catch` 兜底，内部/磁盘异常也只降级为 `failed`）：`chain.grantForSession(info.id, {reason:"spawn", by:claimer})`，**在投递接管请求之前**（对端第一轮就能看到工具）；结果写入广播记录 `permissionGrant: "granted" | "failed"`；失败只多一行可读提示，交接照常。**spawn 不 promote** |
| `:3600` | 新工具 `collab_grant { target, confirm, revoke? }`：预览显示目标 id/agent/title/loc + 现有规则 + 仅缺失条数 + 台账路径；`confirm:true` 才 PATCH；`revoke:true` 还原并删记录；`[protected*]` 抛错拒绝 |
| `:3740` | 新工具 `collab_promote { target, agent?, confirm, revert? }`：默认 `build`，`agent` 白名单外**在写任何东西之前**抛错；预览显示 `原 agent X → 目标 agent Y` 与 `expected:"review" 永不 promote` 提醒；`revert:true` 切回 `agentBefore` |

### 1.4 文档

- `.trellis/spec/guides/cross-workspace-collab-guide.md`：基线行、§2 触发门（grant/promote 两个场景）、§4 步骤、
  §7 拉新（会话级权限补丁全段 + spawn 只 grant 不 promote）、§9 护栏新增「权限」「agent」两行、
  §10 已知偏差 #12（权限作用域根因/整集替换/删目录≠撤回）/ #13（grant≠promote，review 永不 promote）、§11 验收清单 + 回归门（274）。
- `docs/collab.md`：§11.2 工具表新增 `collab_grant` / `collab_promote`（表头 → 五个工具 + 协作链路五个）、
  §12.2 台账字段与两半互不覆盖、§12.3 流程图 spawn 行 + 「spawn 只 grant 不 promote」、
  §12.5 限制 #1 更新（会话级权限）+ 新增 #2（grant≠promote）。
- `docs/development.md`：harness 计数 `212 → 274`，并补「会话级权限补丁/agent 升级与还原」。

## 2. 真实链路 1（R1/R2/R4，muke-interface 临时 explore）

自建临时会话（`location.directory=/data/project/muke-interface`）：

```text
POST /api/session {"title":"collab-grant-verify","agent":"explore","location":{"directory":"/data/project/muke-interface"}}
→ ses_e17aef322ffeFAiNf6DfJeZBWm  agent=explore  loc=/data/project/muke-interface  permissions=(absent)
```

`collab_grant {confirm:false}`（预览，未改）：

```text
未修改（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。
目标: ses_e17aef322ffeFAiNf6DfJeZBWm  agent=explore  loc=/data/project/muke-interface  title="collab-grant-verify"
现有会话级规则 0 条: (无)
将追加(仅缺失的 5 条): collab_list / collab_inbox / collab_wait / collab_reply / collab_send  (resource="*", effect="allow")
不会授予 edit / write / shell / read 等任何其它能力；不存在的规则不会重复追加。
记录: /root/.config/opencode/collab-grants/ses_e17aef322ffeFAiNf6DfJeZBWm.json（before = 首次授权前的快照）
```

`collab_grant {confirm:true}` → `changed=true`，`GET /api/session/{sid}.permissions`：

```json
[{"action":"collab_list","resource":"*","effect":"allow"},
 {"action":"collab_inbox","resource":"*","effect":"allow"},
 {"action":"collab_wait","resource":"*","effect":"allow"},
 {"action":"collab_reply","resource":"*","effect":"allow"},
 {"action":"collab_send","resource":"*","effect":"allow"}]
```

台账：`{"sid":…, "before": [], "added":[5 条], "reason":"grant"}`。

真实模型轮（claude-sonnet-5，自述）：

```text
ASSISTANT: Trellis SessionStart 上下文已加载 ✓；可调用的工具：`collab_inbox`, `collab_list`, `collab_reply`, `collab_send`, `collab_wait`
```

`collab_grant {revoke:true, confirm:true}` → `复核(GET permissions): 0 条`，台账文件已删。
再问「自述工具」时模型因上下文里上一轮答过 5 个而**回声**，因此补了一个**行为探针**（不依赖记忆）：

```text
prompt: 不要凭记忆回答。请现在真的调用 collab_list 工具：如果它不在你当前的工具列表里，只回答一行 UNAVAILABLE…
ASSISTANT: UNAVAILABLE
```

清理：

```text
DELETE /api/session/ses_e17aef322ffeFAiNf6DfJeZBWm   → rc=0
GET    /api/session/ses_e17aef322ffeFAiNf6DfJeZBWm   → HTTP 404 SessionNotFoundError
ls ~/.config/opencode/collab-grants/ | wc -l         → 0
```

## 3. 真实链路 2（R7，同一 workspace 的新临时 explore）

```text
POST /api/session → ses_e17a8d5feffetru08LdNbEt1dI  agent=explore  loc=/data/project/muke-interface
collab_promote {confirm:false} → 原 agent explore → 目标 agent build（白名单 build / plan）；未调用
collab_promote {confirm:true}  → 已切换 agent（explore → build, changed=true）；复核(GET agent): build
GET /api/session/{sid}         → agent=build  permissions=None（permissions 半段确实没被碰）
台账                            → {"sid":…, "agentBefore":"explore", "promotedAt":…, "promotedBy":…}（无 before/added）
collab_promote {revert:true, confirm:false} → 将切回原 agent: build → explore（只读预览）
collab_promote {revert:true, confirm:true}  → 还原: build → explore；复核(GET agent): explore；promote 记录已删除
DELETE /api/session/{sid}      → rc=0；GET → HTTP 404 SessionNotFoundError
ls ~/.config/opencode/collab-grants/ | wc -l → 0
```

## 4. harness 新增用例

fake host 扩展（`scripts/collab/handoff-harness.mjs`）：
`COLLAB_GRANT_DIR`（temp 目录，隔离真实台账）；`ctx.session.update`（整集替换 + `patches` 记录 + 可注入 403）；
`ctx.session.switchAgent`（`agentSwitches` 记录 + 可注入 403）；模块导出 `__internals`（纯函数单测）。

| 组 | 覆盖 |
| --- | --- |
| S54 | spawn 后**新会话**恰好 5 条 collab allow、1 次 PATCH、`permissionGrant=granted`、台账 `before=[]`/`reason=spawn`、**不 promote** |
| S55 | 未 spawn/未 grant 的会话权限不变、无台账（"非自建会话不被自动修改"） |
| S56 | 预览不写 + 显示 loc/agent/title/缺失数；合并后 `read`/`grep` 顺序保留、已有 `collab_list=deny` 不被放宽、只补 4 条；台账 `before` = 3 条原样 |
| S57 | 重复 grant 幂等（无第二次 PATCH、`changed=false`、`before` 不变）；revoke 预览不写；revoke 往返与快照逐字一致并删记录；再 revoke → 「无可还原」且不改会话 |
| S58 | 白名单单元：`edit`/`write`/`shell`/`collab_broadcast`/`effect:deny` 全拒；`mergeRules` 保序/保优先级/去重；`normalizeRules` 丢弃畸形项 |
| S59 | `[protected]` 与 `[protected-child]` 拒绝；无 PATCH、无台账 |
| S60 | `collab_grant` PATCH 403 → 可读原因、权限不变、无台账；spawn 自动授权 403 → 会话仍创建、接管请求仍投递、记录 `permissionGrant:"failed"`、会话无权限 |
| S61 | promote 预览不调用，显示 `原 agent explore → 目标 agent build` + loc/title + review 提醒 |
| S62 | confirm → `explore→build` + GET 复核；台账 `agentBefore/promotedAt/promotedBy`，permissions 不动；重复 promote 同 agent = no-op 且 `agentBefore` 保持首次 |
| S63 | 两个方向都验：promote→grant 后 `agentBefore` 仍在；grant revoke 只清 permissions 半段；grant→promote 后 `before/added` 仍在；promote revert 只清 agent 半段；两半都撤后文件删除 |
| S64 | revert 预览只读；revert 后 agent 回 explore、台账删除、输出 `build → explore` |
| S65 | `plan` 合法；`trellis-implement` 拒绝且一次都没切 |
| S66 | 无记录 revert → 「无可还原」且不改会话 |
| S67 | protected / protected-child 拒绝 promote 且不写台账；宿主 403 → 「未切换 agent」、agent 不变、无台账 |

## 5. 验收命令（原始结果）

```text
$ node --check .opencode/plugins/collab.js          # 通过（无输出）
$ node scripts/collab/handoff-harness.mjs           # === 274/274 checks passed
$ pnpm test:collab                                  # === 274/274 checks passed（exit 0）
$ opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"
  collab-global active /root/.config/opencode/plugins/collab-global.js
  collab        active /data/project/muke-pos-app/.opencode/plugins/collab.js
```

## 6. 未验证项 / 已知限制

1. **HTTP fallback 未在真实宿主上跑过**：本机 `ctx.session.update` / `ctx.session.switchAgent` 都存在，走的是 SDK 路径；
   `COLLAB_SERVER_URL` 分支只有代码路径（harness 也未覆盖 HTTP 分支）。老宿主需要显式配置 `COLLAB_SERVER_URL`（+ 可选 `COLLAB_SERVER_TOKEN`），
   不猜端口（猜错会改到别的实例）。
2. **`permissions` 整集替换是破坏性的**：`revoke` 用 `before` 覆盖回去，若授权期间**别人**又改了同一会话的 permissions，那些改动会被覆盖
   （已在工具输出与 `docs/collab.md` §12.2 写明）。
3. **revoke 后工具消失**用「行为探针（真的调一次 collab_list → UNAVAILABLE）」验证（自述法会被上一轮上下文回声污染）。
4. **`expected:"review"` 不 promote** 目前是**约定 + spawn 不自动 promote**（没有任何代码路径会自动 promote）；
   工具本身不知道广播的 `expected`，无法在 `collab_promote` 里硬拦（记录里 `expected` 与目标会话没有绑定关系）。
5. 台账目录被删/丢失后无法再还原（`revoke`/`revert` 会报「无可还原」）；已写入会话的权限/agent 仍保留。
