# 独立复核报告：`11-17-collab-grant`（会话级权限补丁 + agent 升级）

> 复核人：`trellis-check`（冷上下文，只审不改；未 commit/add/push，未改实现文件）
> 时间：2026-11-17 15:1x
> 复核对象：`.opencode/plugins/collab.js`、`scripts/collab/handoff-harness.mjs`、
> `.trellis/spec/guides/cross-workspace-collab-guide.md`、`docs/collab.md`、`docs/development.md`
> 复核基准：`prd.md` R1–R7 + AC、`design.md` §1–§7、`implement.md`、`research/impl-notes.md`（仅作线索）

---

## 结论（一句话）

**R1–R5 / R7 的主路径与回滚语义均按设计实现，274 项回归全绿；但存在 1 个必修缺陷：
`collab_grant` 的「预览」路径在台账只有 promote 半段（`agentBefore`、无 `before/added`）时抛
`TypeError: Cannot read properties of undefined (reading 'join')`**，违反 R2（预览可用）与 R5（失败可读、不致命）。
修掉这 1 处（外加 `docs/collab.md` 一处编号重复）即可提交。

**是否可提交：❌ 暂不可**（先修 B1；B2 建议同批修）。修完按 §6 的验收命令复跑即可。

---

## 1. 逐项结论（必查 10 项）

| # | 项 | 结论 | 关键证据（`file:line` + 我的复现） |
| --- | --- | --- | --- |
| 1 | R1 spawn 自动授权 | **通过** | `collab.js:2959-2964`（`grantForSession(info.id,…,reason:"spawn")` → 再 `writeBroadcast({…permissionGrant})` → `:2965 deliverAsk`，即授权在投递之前）；只作用于 `ctx.session.create` 返回的 `info.id`；`.catch` 兜底 `:2963`；未自动 promote。我的探针 I1–I7 全通过 |
| 2 | R2 `collab_grant` 预览/确认/revoke | **部分通过**（B1） | 预览不写 `:3656-3696`；`confirm:true` 才 PATCH `:3721`；`revoke` 用 `before` 整集还原 `:3698-3719` + `revokeForSession:2137-2172`；protected 拒绝 `:3631-3638`。**缺陷**：`:3669-3673` / `:3690-3691` 无 `before/added` 保护，见 B1 |
| 3 | R3 合并而非覆盖（deny 不放宽、保序） | **通过** | `mergeRules:708-718`（按 `action+resource` 去重、base 在前、effect 不被改写）、`missingRules:721-724`；我自造 base `edit:deny / read:allow / collab_list:deny / grep:allow` → 合并结果前 4 条逐字不变、`collab_list` 仍 `deny`、只补 4 条（探针 A7–A12） |
| 4 | R4 幂等与首次快照 | **通过** | `snapshot = existing?.before ?? before`（`:2101`，`[]` 也保留）、`added` 只在缺失时追加 `:2102`、`added.length===0` 不 PATCH `:2105`、`writeGrant` 合并写 `:784-800`。探针 B1–B3：第二次 grant 无第二次 PATCH、`changed=false`、`before` 不变 |
| 5 | R5 PATCH 失败不致命 | **通过（主路径）** | `grantForSession` 全程不抛 `:2088-2130`；spawn 路径 `.catch` + `permissionGrant:"failed"` `:2959-2973`。探针 D1–D4（grant 403：可读、权限不变、无台账）、J1–J6（spawn 403：会话照建、接管请求照发、记录 failed、无台账） |
| 6 | R7 promote 白名单/确认/还原/protected/不自动 | **通过** | `PROMOTE_AGENTS:215`；白名单校验在写任何东西之前 `:3792-3796`；`promoteSession:2211-2253`（`agentBefore` 首次写死）、`revertSessionAgent:2256-2294`；proto 拒绝 `:3778-3785`；**spawn 路径无 promote 调用**（`grep promoteSession` 仅 `:3851` 一处）。探针 F1–F14、G1–G5、E1–E6 |
| 7 | 台账两半互不覆盖 | **通过** | `normalizeGrant:754-770` / `writeGrant:784-800`（合并写、`null` 清字段、两半皆空才删文件）；`revokeForSession:2163-2170` 只清 permissions 半段；`revertSessionAgent:2281-2286` 只清 agent 半段。探针 H1–H6（先 grant 后 promote：两半共存；revoke 后 `agentBefore` 仍在；revert 后文件删除） |
| 8 | 回归 | **通过** | `node --check` exit 0；harness `274/274` exit 0；`pnpm test:collab` exit 0；harness diff **0 行删除**（既有 212 项断言逐字未动） |
| 9 | 范围 / 护栏 | **通过（附流程提示）** | 插件删除行仅注释重写 + `writeBroadcast(spawned)` 一处替换；未改 `~/.config/opencode/opencode.json`（mtime 11-13）；两个真实临时会话均 404、`collab-grants/` 空（0 文件）。工作区另有与本任务无关的脏文件（parity / mcp submodule），提交必须走显式路径 |
| 10 | 文档一致性 | **基本一致（B2 + 措辞见 R-1）** | guide §2/§7/§9/§10(#12/#13)/§11 与 `docs/collab.md` §11.2/§12.2/§12.3/§12.5 内容对齐（「spawn 只 grant」「grant≠promote」「review 不自动升级」）；`docs/development.md` 计数 274 与实测一致。**缺陷**：`docs/collab.md` §12.5 出现两个 `8.`，见 B2 |

---

## 2. 缺陷详述

### B1（必修）`collab_grant` 预览在「只有 promote 半段」的台账上抛 TypeError

**位置**：`.opencode/plugins/collab.js:3669-3673`（revoke 预览）、`:3690-3691`（grant 预览）

**可达状态**（设计 §7 明确允许，impl-notes §3 真实链路 2 就是这个状态）：

```jsonc
// ~/.config/opencode/collab-grants/<sid>.json —— 只 promote 过、没 grant 过
{ "sid": "ses_…", "agentBefore": "explore", "promotedAt": 0, "promotedBy": "ses_…" }
```

此时工具先用 `:3654 const record = readGrant(sessionID)` 拿到 truthy 的 record，接着无条件访问
`record.added.join(...)` / `record.before.length` / `fmtRules(record.before)`。

**我的复现**（自写假 ctx，`/tmp/opencode/probe-promote-only-ledger.mjs`）：

```text
after promote: agent = build switches = 1
grant preview → THREW: Cannot read properties of undefined (reading 'join')
grant revoke preview → THREW: Cannot read properties of undefined (reading 'join')
promote revert preview (both halves) → OK        # 对称方向没问题
```

**影响**：不损坏数据（崩在写之前），但工具直接抛原始 `TypeError`，违反 R2「未带 `confirm:true` 只预览」与
R5「失败不致命、原因可读」；按文档推荐流程「先 `collab_promote`、后补 `collab_grant`」就会踩到。
`confirm:true` 两条路径（`grantForSession` / `revokeForSession`）本身是正确的（`existing?.before` / `!record.before` 都有处理）。

**建议修法**（4 处，最小改动；判据统一用「有没有 permissions 半段」）：

```js
// :3664 revoke 预览
const hasPermHalf = Boolean(record?.before)
...
hasPermHalf
  ? `授权记录: reason=${record.reason} by=${record.by || "-"} at=${fmtTime(record.at)} ` +
    `added=${(record.added ?? []).join(",") || "-"} → ${grantPath}`
  : `授权记录: 无 permissions 半段（${grantPath}${record ? " 只有 promote 记录" : " 不存在"}）→ 确认后会报「无可还原」`,
...
hasPermHalf ? `将整集恢复为快照的 ${record.before.length} 条: ${fmtRules(record.before)}` : "",

// :3690 grant 预览
`记录: ${grantPath}（before = 首次授权前的快照${hasPermHalf ? "，已存在（不会覆盖）" : ""}）`,
hasPermHalf
  ? `已有记录: reason=${record.reason} by=${record.by || "-"} added=${(record.added ?? []).join(",") || "-"}`
  : record?.agentBefore
    ? `已有记录: 只有 promote 半段（agentBefore=${record.agentBefore}），无 permissions 快照`
    : "",
```

修完补一条 harness 用例（S68）：先 `collab_promote confirm:true`，再
`collab_grant {confirm:false}` 与 `{revoke:true, confirm:false}` 都返回内容、不抛、不写。

### B2（建议同批修）`docs/collab.md` §12.5 编号重复

`docs/collab.md:494` 与 `:497` 都是 `8.`（本次把原 `7. 广播目录…` 改成 `8.`，但后面那条没顺延）。
建议：`:497` → `9.`、`:498` → `10.`、`:499` → `11.`（后续逐条 +1）。

---

## 3. 风险清单（不阻断，供 owner 决定）

| 级别 | 项 | 说明 |
| --- | --- | --- |
| 低（文档口径） | 「`expected:"review"` 的交接永不 promote」在 guide §10 #13 / `docs/collab.md` §12.5 写成硬规则，但代码只保证「**没有自动** promote 路径」；显式 `collab_promote` 仍可对 review 会话发起（工具不知道广播的 `expected`）。PRD AC 只要求「不会被自动 promote」→ 满足；建议文档改成「不会被自动 promote；显式调用需人工判断」 | impl-notes §6.4 已自述 |
| 低（理论） | `mergeRules:708-718` 对 **base** 也做 `action+resource` 去重，保留第一条。若宿主语义是「后者覆盖」且 base 里同一 key 同时有 `allow` 与 `deny`，去重会把 `deny` 丢掉（放宽）。宿主 `Permission.Rule` 是 `additionalProperties:false` 的定长对象，实际重复 key 概率极低 | 交付前无需改，记录即可 |
| 低（覆盖度） | 32 位 HTTP fallback（`COLLAB_SERVER_URL` / `COLLAB_SERVER_TOKEN`）只有代码路径，harness 未覆盖；本机宿主存在 `ctx.session.update`/`switchAgent`，走不到该分支 | 作者已在 impl-notes §6.1 记录 |
| 低（体验） | 重复 promote 且 `by` 为空时，`promotedBy` 会被空串覆盖后由 `normalizeGrant` 丢弃（只是记录字段，不影响 revert） | 建议顺手 `by: existing?.promotedBy` |
| 低（体验） | 对「本来就有全部 5 条」的会话 grant，仍会写一份 `before`（含 5 条）的台账，输出首行固定写「已授予 5 条」（`changed=false` 在括号里），细看第二行才知「未重复追加」 | 文案问题，不影响语义 |
| 流程 | 工作区还有 parity 任务 / `mcp` submodule / `docs/design` / `docs/issues` 等**与本任务无关**的脏文件；提交必须按显式路径：`.opencode/plugins/collab.js`、`scripts/collab/handoff-harness.mjs`、`.trellis/spec/guides/cross-workspace-collab-guide.md`、`docs/collab.md`、`docs/development.md`（+ 任务目录） | G6「禁止 `git add -A`」 |

---

## 4. 我自己的复现（不采信既有断言）

探针全部用**我自写的假 ctx**驱动**真实插件文件**（`copyFileSync` 到 temp `.mjs` 后 `import`），
广播目录/台账目录均为临时目录，未接触真实 `~/.config/opencode/`。

### 4.1 主探针 `/tmp/opencode/check-r3r4r7.mjs` → **74/74 通过**

覆盖：R3 deny 不放宽 + 保序（A7–A12）、R4 幂等（B1–B3）、R2 revoke 往返（C1–C8）、
R5 grant 403（D1–D4）、protected（E1–E6）、R7 全周期（F1–F14）、白名单/切换失败（G1–G5）、
台账两半（H1–H6）、spawn 自动授权 + 不 promote（I1–I7）、spawn 授权失败不阻断（J1–J6）、
非自建会话默认不被改（K1–K2）。

关键原始输出（节选）：

```text
PASS A7  patch keeps base order/effects first — [{"action":"edit","resource":"*","effect":"deny"},{"action":"read",…"allow"},{"action":"collab_list",…"deny"},{"action":"grep",…"allow"}]
PASS A8  pre-existing collab_list stays deny
PASS A12 ledger before === original 4 rules verbatim
PASS B1  second grant did NOT PATCH again — patches=1
PASS C4  revoke payload === original snapshot
PASS F7  repeat promote (same agent) does not switch — switches=1
PASS H2  revoke keeps the promote half — {"sid":"ses_t_both","agentBefore":"explore","promotedAt":…,"promotedBy":"ses_t_caller"}
PASS I3  spawned session got exactly the 5 collab allows
PASS I4  spawn path did not promote — agent=explore
PASS J4  takeover prompt still delivered — prompts 1 → 2
PASS J5  record permissionGrant=failed
=== review probe: 74 passed, 0 failed ===
```

### 4.2 缺陷探针 `/tmp/opencode/probe-promote-only-ledger.mjs` → 复现 B1

见 §2 原始输出。

### 4.3 边界探针 `/tmp/opencode/probe-edge-cases.mjs` → 全通过

```text
promote to explore → THREW: 拒绝切换：agent="explore" 不在白名单（只允许 build / plan）。未修改任何会话。 | switches: 0
grant on a session with no permissions → 已授予 5 条 collab_* 会话级权限: ses_e（changed=true）
ledger before = []
revoke to empty snapshot → 已还原会话级 permissions 并删除记录 … 恢复为 before 的 0 条: (无) | 复核(GET permissions): 0 条: (无)
patches = [[5 条 allow], []] | live = [] | ledger exists after revoke = false
```

---

## 5. 必跑命令原始输出

```text
$ node --check .opencode/plugins/collab.js
(node-check-exit=0，无输出)

$ node scripts/collab/handoff-harness.mjs
  ✓ S67 a refused switch is reported (not thrown), agent unchanged, no ledger
=== 274/274 checks passed
harness-exit=0

$ pnpm test:collab
=== 274/274 checks passed
pnpm-test-collab-exit=0

$ opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"
… {"id":"collab-global","source":{"type":"local","path":"/root/.config/opencode/plugins/collab-global.js"},…,"state":{"status":"active"}},
  {"id":"collab","source":{"type":"local","path":"/data/project/muke-pos-app/.opencode/plugins/collab.js"},…,"state":{"status":"active"}} …
（无 failed）

$ opencode api get /api/session/ses_e17aef322ffeFAiNf6DfJeZBWm   → HTTP 404 SessionNotFoundError
$ opencode api get /api/session/ses_e17a8d5feffetru08LdNbEt1dI   → HTTP 404 SessionNotFoundError
$ ls -A ~/.config/opencode/collab-grants/ | wc -l                → 0
```

补充只读核对：

- **未重启服务**：`opencode.exe serve --service` 的 `lstart = 11-15 12:06`（etime 2 天），今天没有重启；
  而 `collab_grant` / `collab_promote` 是新代码才有的工具、作者真实链路能调到它们 → 说明插件文件热更新生效，
  `/api/plugin` 的 `active` 不是旧版本误导。
- `~/.config/opencode/opencode.json` mtime = 11-13（本任务未改）；`collab.json` mtime = 11-17 06:56（早于本任务工作时段）。
- **未向 `muke-interface` 发起本任务的交接**：`collab-broadcast/` 仅 2 条记录，均为**其它会话**的历史广播
  （`b_a4f161…` 11:04 `blocked`、`b_e7da59…` 15:03 `open`/`review`，`from.sid` 为 schema 线），
  两条的 `permissionGrant` 都没被本功能写过；两个临时会话只出现在 `seenBy` 里（它们调过 `collab_list`），
  没有以它们为 `from` 的广播。
- `openapi.json`：`PATCH /api/session/{sessionID}` 的 body 只接受 `title/metadata/permissions/archived`
  （无 `agent`，与 design §1 一致）；`POST /api/session/{sessionID}/agent` 只接受 `{agent}`；
  `Permission.Rule` 为 `{action, resource, effect}` 且三者必填、`additionalProperties:false`
  → `normalizeRules` 丢弃畸形规则不会误伤宿主承认的规则。

---

## 6. 修复后验收（给实现方）

```bash
node --check .opencode/plugins/collab.js
node scripts/collab/handoff-harness.mjs      # 期望 274 + 新增 ≥2 = 全绿
pnpm test:collab
```

外加 B1 的回归用例（建议直接加进 harness 的 S68）：

```text
1) collab_promote { target, confirm:true }        → 台账仅 agentBefore
2) collab_grant  { target, confirm:false }        → 有内容、不抛
3) collab_grant  { target, revoke:true, confirm:false } → 有内容（提示无可还原）、不抛
4) 会话 permissions / agent 均未被这两次预览改动
```

提交前确认显式路径只含本任务 5 个文件 + 任务目录；不要 `git add -A`。

---

## 7. 一句话汇报

R1–R5 / R7 的实现、护栏与回滚语义与设计一致，274 项回归全绿、真实会话已清理；
唯一实质缺陷是 `collab_grant` 预览在「只有 promote 半段」的台账上抛 `TypeError`（`collab.js:3669-3673`、`:3690-3691`），
外加 `docs/collab.md:494/497` 编号重复——修这两处后即可提交。
