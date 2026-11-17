# 协作链路：会话语义权限补丁（spawn 自动授权 + `collab_grant`）

> 来源：`11-17-collab-auto-receipt` 收尾时对真实对端的追踪。实测结论：
> **对端 explore 会话看不到 `collab_*` 工具，不是模型问题，是权限作用域问题。**

## 背景（实测证据，2026-11-17）

1. `opencode.json` 的 `agents.explore|plan.permissions` 是**项目级**的：
   - `muke-pos-app` 的 explore：`collab_list/inbox/wait/reply/send = allow`
   - `muke-interface` 的 explore：**无任何 collab 权限**
   → 全局 shim 只解决「插件加载」，不解决「工具可见」。
2. `PATCH /api/session/{sessionID}` 支持 `archived` / `metadata` / `permissions` / `title`（**不支持 `agent`**）。
3. 给一个 `muke-interface` 的 explore 临时会话 PATCH 5 条 `collab_*` allow 后，模型自述可用工具变为
   `collab_inbox / collab_list / collab_reply / collab_send / collab_wait`（真实模型轮，会话已删并复核 404）。
4. 因此「让对端能回执」的正确修法是**按会话授予 permissions**，不是全局配置，也不是把拉新改成 `build`。

## Requirements

- **R1 spawn 自动授权**：`collab_broadcast` 在拉新会话成功后，给**自己创建的**会话 PATCH 追加 5 条
  `collab_*` allow；`explore` 仍然不能被授予 `edit`/`write`。
- **R2 显式授权既有会话**：新增 `collab_grant { target, confirm, revoke? }`：
  - `revoke:false`（默认）追加 5 条；
  - `revoke:true` 移除本工具曾追加的 5 条（按记录还原，不动原有规则）。
  - 未带 `confirm:true` 只预览（目标 id/agent/title + 将加/将删的规则）。
- **R3 合并而非覆盖**：先读会话现有 `permissions`，追加去重后再 PATCH；不得丢弃既有规则。
- **R4 幂等与记录**：同一会话重复 spawn/grant 不重复累积；把「原始 permissions 快照」写入广播记录或
  grant 记录，供 `revoke` 还原。
- **R5 失败不致命**：PATCH 失败（403/404/宿主老版本不支持）→ 返回可读原因，交接照常进行
  （回执可退化为租约到期自动提取）。
- **R6 回归**：既有 212 项 harness 全绿；新增用例覆盖 R1–R5。
- **R7 `collab_promote`（升级/降级 agent）**：`POST /api/session/{id}/agent`（`session.switchAgent`）实测可把
  explore 切成 build。新增 `collab_promote { target, agent?, confirm, revert? }`：
  - 默认 `build`，白名单 `["build","plan"]`；
  - `confirm:true` 才切换；`revert:true` 按记录还原原 agent；
  - 目标为 `[protected*]` → 拒绝；spawn 路径**不**自动 promote；
  - 记录与 grant 共用 `collab-grants/<sid>.json` 且互不覆盖；
  - **`expected:"review"` 的交接永不 promote**（研判只需回执能力）。

> 分工：`grant` = 回执能力（只读）；`promote` = 执行能力（可写）。两者独立、都可回滚。

## Acceptance Criteria

- [ ] spawn 出的会话 `GET /api/session/{sid}` 的 `permissions` 含 5 条 `collab_*`
- [ ] 非自建会话不会被自动修改（默认路径）
- [ ] `collab_grant` 预览/确认/还原三步可用；`revoke` 后与快照一致
- [ ] 目标已有其它 permissions 时，合并后**原规则仍在**
- [ ] PATCH 失败时交接照常，错误可读
- [ ] harness ≥212 全绿，`pnpm test:collab` exit 0
- [ ] `collab_promote` 预览/确认/还原可用；非白名单 agent 与 `[protected*]` 被拒
- [ ] `review` 类交接不会被自动 promote

## 边界

- 不授予 `edit` / `write` / `shell` 等任何额外能力；只加 5 条 collab 动作。
- 不改全局 `~/.config/opencode/opencode.json`。
- 不改别人的会话权限，除非显式调用 `collab_grant` 且 `confirm:true`。
- 不 push；不改 `packages/**`。
