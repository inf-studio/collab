# 设计：会话级权限补丁

## 1. 为什么是 permissions 而不是 agent

| 手段 | 可行 | 说明 |
| --- | --- | --- |
| 改会话 `agent`（explore→build） | ❌ | `PATCH /api/session/{id}` 只接受 `archived/metadata/permissions/title` |
| 全局 `~/.config/opencode/opencode.json` 授权 | ⚠️ | 影响所有项目；且既有会话不重新解析 |
| 项目 `opencode.json` 授权 | ❌ | 只对本仓生效（本次根因） |
| **会话级 `PATCH permissions`** | ✅ | 只影响目标会话，可撤销；实测工具立即可见 |

## 2. 数据与接口

```jsonc
// PATCH /api/session/{sessionID}
{ "permissions": [
  { "action": "collab_list",  "resource": "*", "effect": "allow" },
  { "action": "collab_inbox", "resource": "*", "effect": "allow" },
  { "action": "collab_wait",  "resource": "*", "effect": "allow" },
  { "action": "collab_reply", "resource": "*", "effect": "allow" },
  { "action": "collab_send",  "resource": "*", "effect": "allow" }
] }
```

- `permissions` 是**整集替换**语义（实测 PATCH 后 `GET` 返回即传入数组）；
- 所以先 `GET /api/session/{sid}` 取 `permissions`，做 `merge(base, add)` 去重后再 PATCH；
- `revoke` 用记录里的 `before` 快照替换回去（不是「删除 5 条」——若原会话本就有同名规则，删了会误伤）。

## 3. 记录

```jsonc
// ~/.config/opencode/collab-grants/<sid>.json
{
  "sid": "ses_…",
  "before": [ /* PATCH 前的 permissions 原样 */ ],
  "added": ["collab_list", "…"],
  "at": 0,
  "by": "ses_<发起方>",
  "reason": "spawn|grant"
}
```

- spawn 自动授权也写一条，`reason:"spawn"`；
- `collab_grant {revoke:true}` 读该记录 → 用 `before` 还原 → 删记录。

## 4. 调用点

| 场景 | 行为 |
| --- | --- |
| `collab_broadcast` spawn 成功 | 立即 PATCH 5 条（`reason:"spawn"`）；失败只记 `permissionGrant:"failed"`，不阻断 |
| `collab_grant {target}` | 预览/确认；`confirm:true` 才 PATCH |
| `collab_grant {target, revoke:true}` | 用 `before` 还原；无记录则报「无可还原记录」 |
| `collab_handoff`（local） | 不改权限（同仓 agent 权限已具备） |

## 5. 安全

- 白名单常量：只允许 5 条 collab 动作，其它 action 一律拒绝（防止被当成提权工具）；
- 目标若在 protect 名单/其子会话 → 直接拒绝（复用血缘护栏）；
- 不授予 `edit`/`write`/`shell`；
- `confirm:true` 必填，预览显示目标 `id/agent/title/loc`。

## 6. 失败与回滚

- PATCH 403/404/500 → 返回 `{ ok:false, reason }`，交接继续；回执退化为租约到期自动提取；
- 全局回滚：删除 `collab-grants/` 目录即可（不影响会话，权限留在会话上直到 revoke）。

## 7. 升级/降级 agent（`collab_promote`）

```bash
POST /api/session/{sessionID}/agent   { "agent": "build" }   # session.switchAgent
```

- 白名单 `["build","plan"]`；`explore` 本身不允许作为 promote 目标（它就是默认态）；
- `confirm:true` 才切换；`revert:true` 用记录里的 `agentBefore` 还原；
- 记录合并进 `collab-grants/<sid>.json`：`{ sid, before, added, agentBefore, promotedAt, promotedBy }`，
  grant 与 promote 各写各的字段，互不覆盖；
- `spawn` 只自动 grant，**不**自动 promote；
- `expected:"review"` 永不 promote。

**为什么两套并存**：

| 能力 | grant（permissions） | promote（switchAgent） |
| --- | --- | --- |
| 回执 | ✅ | ✅（build 是 `* allow`） |
| 改文件 | ❌ | ✅ |
| 风险 | 只读，可给任意会话 | 可写对端仓，必须显式确认 |
| 适用 | 研判 / review 交接 | 确认实施 |

若只保留 promote：研判阶段就得拿到写权限；若只保留 grant：对端永远不能实施。
