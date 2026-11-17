# 独立复核报告：会话级权限补丁（R1–R7）

> 任务：`.trellis/tasks/11-17-collab-grant`
> 复核者：`trellis-check`（冷上下文，**只审不改**；未 `git add` / `commit` / `push`，未改实现文件）
> 复核基线：`opencode v2.3.0`，`.opencode/plugins/collab.js` @ 15:11，harness @ 15:11
> 结论：**可提交**（5 个文件），2 项低风险文本问题建议顺手修（不阻塞），6 项记为风险/待验证（P3–P8）。
> 独立性：所有 R2/R3/R4/R5/R7 结论来自**我自己的假 ctx 复现**（52 项）与**真实宿主只读/临时会话探针**，不采信 `research/impl-notes.md` 与 harness 既有断言。

## 0. 复核方式

| 手段 | 说明 | 证据 |
| --- | --- | --- |
| 独立假 ctx 复现 | 自写 `research/check-evidence/independent-checks.mjs`（自带 sessions / patches / switches / 台账目录，`COLLAB_CONFIG` 指向不存在文件隔离真实配置）→ **52/52 PASS** | `research/check-evidence/independent-checks.log` |
| 真实宿主探针 | 自建临时会话 `ses_e17a20da0ffe…`（`location.directory=/tmp/opencode/check-ws`）：PATCH permissions → GET 回读 → POST /agent → GET → DELETE → 404 | `research/check-evidence/host-probe.txt` |
| 状态/护栏探针 | 全量会话权限扫描（`limit=1000`）、两个受保护会话、台账目录、广播目录、全局 `opencode.json` | `research/check-evidence/state-probe.txt` |
| 必跑命令 | `node --check` 0；harness 274/274 exit 0；`pnpm test:collab` exit 0；`/api/plugin` 两个 collab 均 `active` | `research/check-evidence/raw-outputs.txt` |

## 1. 逐项结论（10/10）

| # | 检查项 | 结论 |
| --- | --- | --- |
| 1 | R1 spawn 自动授权 | **通过** |
| 2 | R2 `collab_grant` 预览/确认/revoke | **通过** |
| 3 | R3 合并而非覆盖（deny 不放宽） | **通过**（跨 resource 优先级 → 风险 P4） |
| 4 | R4 幂等 + `before` 快照 | **通过** |
| 5 | R5 PATCH 失败不致命 | **通过** |
| 6 | R7 `collab_promote` | **通过**（「review 永不 promote」为约定 → 风险 P8） |
| 7 | 台账两半互不覆盖 | **通过** |
| 8 | 回归（274/274、node --check） | **通过** |
| 9 | 范围与护栏 | **通过**（附注） |
| 10 | 文档一致性 | **基本通过**，`docs/collab.md §12.5` 编号有缺陷（问题 P1） |

---

### 1. R1 spawn 自动授权 — 通过

**代码**：唯一调用点 `.opencode/plugins/collab.js:2960`（`grantForSession(info.id, {reason:"spawn", by:claimer})`），在 `writeBroadcast(...permissionGrant...) :2964` 与 `deliverAsk(...) :2965` **之前**；异常兜底 `.catch :2963`；`collab_handoff`（local）不 grant（无调用点）。

**我的复现**（假 ctx，spawn 到空工作区）：
- 只 PATCH 了新建会话：`patches+1`，`patches.at(-1).sessionID = ses_spawn_1`；
- 新会话 `permissions` **恰好** `internals.collabPermissionRules()` 的 5 条 allow，无 `edit/write/shell`；
- `agent=explore`，`switches=0`（spawn 不 promote）；
- 台账 `{"sid":"ses_spawn_1","before":[],"added":[5 条],"reason":"spawn","by":"ses_check_req"}`；
- 未 spawn / 未 grant 的会话无 PATCH、无台账（S55 语义我另跑一遍确认）。

**失败不阻断**：注入 PATCH 403 后 spawn 仍 `created=1`、`prompt+1`、输出含「未授予权限（…HTTP 403…）→ 交接照常」，新会话 `permissions=null`，无台账。

### 2. R2 `collab_grant` — 通过

**代码**：工具 `:3604`；预览分支 `:3656–3697`（仅 `chain.readSessionPermissions`，不写）；`confirm:true` 才走 `chain.grantForSession :3721`；`revoke` 走 `chain.revokeForSession :3699`（`before` 整集还原，`.opencode/plugins/collab.js:2137`）；`[protected*]` 前置拒绝 `:3631`。

**我的复现**：
- 预览：`patches=0`、台账文件不存在；
- 确认：`changed=true`，只追加缺失项；
- revoke：会话 `permissions` **逐字**回到原始 5 条 base（含 `edit:deny`/`shell:deny` 顺序不变），台账文件删除；
- 二次 revoke：`未还原：没有 … 的授权记录…无可还原`，不改会话、不抛错；
- 无 `confirm:true` 一律不写（代码条件 `input?.confirm !== true`，`:3656`）。

### 3. R3 合并而非覆盖 — 通过

**代码**：`mergeRules :708`（`action\0resource` 去重，base 顺序在前）、`normalizeRules :684`、`missingRules :721`、`assertCollabOnly :731`。

**我自造 base**（比 harness S56 更强）：

```json
[{"action":"edit","resource":"*","effect":"deny"},
 {"action":"read","resource":"*","effect":"allow"},
 {"action":"collab_list","resource":"*","effect":"ask"},
 {"action":"collab_send","resource":"*","effect":"deny"},
 {"action":"shell","resource":"*","effect":"deny"}]
```

结果（PATCH 后 GET）：
- 前 5 条**逐字保序**（base 前缀完全一致）；
- `collab_list` 仍是 **`ask`**（未放宽成 allow）、`collab_send` 仍是 **`deny`**；
- 只追加真正缺失的 `collab_inbox / wait / reply` 3 条；
- 无任何 `edit/write/shell` 的 allow；
- `edit:deny`、`shell:deny` 原样保留。

### 4. R4 幂等 + 快照 — 通过

**代码**：`:2088` 用 `existing?.before ?? before`（首次快照优先）；`:2105` 无缺失就不 PATCH；`:784` `writeGrant` 先读旧文件再合并。

**我的复现**：第二次 grant → `patches 1→1`、`changed=false`、台账 `before` 与首次逐字一致、`added` 未重复。

### 5. R5 失败不致命 — 通过

**代码**：`grantForSession :2088` 分 `read`/`patch` 两段捕获并返回 `{ok:false, phase, reason}`；spawn 路径另有 `.catch :2963`。

**我的复现**：
- `collab_grant` + PATCH 403 → `未授予权限（patch）: 写入 … HTTP 403…`，权限不变、无台账、**不抛错**；
- spawn + PATCH 403 → 会话仍创建、接管请求仍投递（`prompts+1`）、输出「未授予权限…交接照常」、`permissions=null`；广播记录 `permissionGrant:"failed"`（harness S60 同口径）。

### 6. R7 `collab_promote` — 通过

**代码**：工具 `:3746`；白名单 `PROMOTE_AGENTS=["build","plan"] :215` + 工具内前置校验 `:3792`（写任何东西之前）；`confirm:true` 才 `chain.promoteSession :3851`；`revert` → `chain.revertSessionAgent :3834`；protected 拒绝 `:3778`。

**我的复现**：
- 预览：`switches=0`，输出 `原 agent explore → 目标 agent build`；
- `agent:"trellis-implement"` / `agent:"explore"` → 抛可读错误，`switches=0`；
- 确认：`explore→build`，台账 `agentBefore:"explore"`，**无** permissions 半段；
- 重复 promote：`switches` 不增，`agentBefore` 保持 `explore`；
- `revert`：`build→explore`，台账删除；
- 无记录 revert：`无可还原`，不改会话；
- `[protected]` 本身与其子会话：拒绝，`switches` 不增、无台账；
- switch 403：`未切换 agent（switch）… HTTP 403…`，agent 不变、无台账、不抛错。

**spawn 不自动 promote / review 不 promote**：spawn 路径只有 `grantForSession`；我用 `expected:"review"` 广播一条 → 新会话 `agent=explore`、`switches=0`、台账只有 permissions 半段。全代码没有「自动 promote」的调用点（`grep promoteSession` 只有工具分支）。

### 7. 台账两半互不覆盖 — 通过

**代码**：`normalizeGrant :754` / `writeGrant :784` / `removeGrant :802`；revoke 只把 `before/added/at/by/reason` 置 null（`:2163–2170`），revert 只把 `agentBefore/promotedAt/promotedBy` 置 null（`:2281–2286`），两者都空才删文件（`:791`）。

**我的复现（两个方向都跑）**：
- promote → grant：`{"before":[…1 条…], "added":[5], "agentBefore":"explore", "promotedAt":…}` 共存；
- grant revoke：只剩 `agentBefore/promotedAt/promotedBy`，会话 agent 仍是 `build`；
- 再 revert：`explore`，文件删除（`ledger === null`）。

### 8. 回归 — 通过

```
$ node --check .opencode/plugins/collab.js            → exit=0
$ node scripts/collab/handoff-harness.mjs             → === 274/274 checks passed（exit 0）
$ pnpm test:collab                                    → === 274/274 checks passed（exit=0）
$ opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"
  collab-global active /root/.config/opencode/plugins/collab-global.js
  collab        active /data/project/muke-pos-app/.opencode/plugins/collab.js
```

既有 212 项语义未变：`git diff -U0 scripts/collab/handoff-harness.mjs` 的删除行数 = **0**（656 行纯新增，全部是 S54–S67 fixture 与断言）；插件侧 8 行删除均为注释/描述/空行（`git diff` 逐行核对：文件头 `eight native` → `ten`、`collab_broadcast` 描述续行、一处空行、`const record = writeBroadcast(spawned)` 被带 `permissionGrant` 的版本替换）。

### 9. 范围与护栏 — 通过（附注）

- 本任务改动 = 5 个文件（`.opencode/plugins/collab.js`、`scripts/collab/handoff-harness.mjs`、guide、`docs/collab.md`、`docs/development.md`）+ 任务目录；`git diff --numstat`：`765/8`、`656/0`、`44/3`、`33/10`、`1/1`。
- **未改全局配置**：`~/.config/opencode/opencode.json` mtime `2026-11-13 16:06:30`，`grep -c collab_` = **0**。
- **台账已清空**：`~/.config/opencode/collab-grants/` 只有 `.`/`..`。
- **受保护会话未被授权**：`ses_e1eb91cebffeTv1467ubJLKebk`、`ses_e23a4a23fffe4c4m7UQFR8dUL3` 的 `permissions=[]`；会话全量扫描（`limit=1000` → rows=1000）里**没有任何**会话带 `collab_*` 权限。
- **无残留临时会话**：全量扫描里没有 `collab-grant-verify` / promote 测试标题（仅两条复核会话本身）；impl-notes 里的 `ses_e17aef…` 已 404（只出现在另一条既有广播的 `seenBy` 里，未产生副作用）。
- **未向 `muke-interface` 投递交接**：本任务没有新广播记录（全局目录 2 条，均早于本任务改动，且无 `permissionGrant` 字段）。
- 附注：`docs/design/impl-spec.md`、`docs/design/parity-diff.md`、`.trellis/tasks/11-17-parity-disabled-variant/*`、`docs/issues/*`、`mcp` 指针等 dirty 项**不属于本任务**（内容为 parity/disabled 变体与后端提案），提交时须按显式路径，勿 `git add -A`。
- 「未重启服务」无法从仓库侧证明；可观测证据是 `/api/plugin` 两个 collab 均 `active`，无 `failed`。

### 10. 文档一致性 — 基本通过（1 处编号缺陷）

核对 `guide §2 / §4 / §7 / §9 / §10 / §11` 与 `docs/collab.md §11.2 / §12.2 / §12.3 / §12.5`：

- 「spawn 只 grant、不自动 promote」「`expected:"review"` 永不 promote」在 guide §2（:37–38）、§7（:239–242）、§9（:270–271）、§10 #13（:292）、§11（:343–345）与 `docs/collab.md` §11.2（:264–265）、§12.3、§12.5 #2 均一致，与实现一致。
- 「合并而非覆盖 / 整集替换 / 删目录≠撤回 / revoke 只还原快照」在 guide #12（:291）与 `docs/collab.md` §12.2 一致。
- 计数：`docs/development.md` 与 guide §11 均为 274，与脚本实际输出一致。
- guide §4（群组与广播）未提 grant —— 不构成不一致：spawn 在 §7，§4 描述既有成员的广播路径。

## 2. 问题与风险清单

### 建议修改（非阻塞，均为文本/提示层）

**P1｜`docs/collab.md §12.5` 列表编号错乱（本 diff 引入）**
- 现状：`:494` 与 `:497` 两个 `8.`；`:498` 的 `9.`（mtime）、`:499` 的 `10.`（自动闭环）应顺延为 `10.` / `11.`；
- 且 `:501`「（同限制 **2**，向宿主请求尾部 10 条）」已失效——限制 2 现在是「grant ≠ promote」，`ctx.session.context` 是限制 **3**。
- 原因：在列表头部插入 2 条（§12.5 #1/#2）后只改了前半段编号。
- 证据：`git show HEAD:docs/collab.md` 原为 7/8/9/10 单份编号；当前 `grep -n "^8\. "` 命中两行。

**P2｜`collab_promote` 在「已是目标 agent 且无既有记录」时提示与实际不符（`collab.js:2242–2244`）**
- `promoteSession` 仅当 `changed || existing?.agentBefore` 才 `writeGrant`；否则返回 `existing`（可能为 `undefined`）。
- 但工具成功分支（`:3863–3872`）无条件打印「记录: …/sid.json（agentBefore=…）」与「还原: collab_promote {revert:true…}」。
- 我的复现（`research/check-evidence/promote-noop-edge.mjs`）：`agent=build` 的会话 confirm promote →
  `已切换 agent（build → build，changed=false）` + 声称写了台账 + 给出还原命令；实际 `ledgerExists=false`，紧接着 `revert` 返回「无可还原」。
- 无状态损坏，仅误导。建议：仅当 `result.record?.agentBefore` 存在时打印记录/还原行，否则输出「已是目标 agent，无需记录」。

### 风险 / 待验证（不阻塞）

**P3｜台账写盘异常会冒泡到工具调用**：`grantForSession` 只捕获 read/patch，`writeGrant` 的 fs 异常（EACCES/磁盘满）会让 `collab_grant` / `collab_promote` 抛错（spawn 路径有 `.catch :2963` 兜底，工具路径没有）。R5 只要求 PATCH/switch 失败不致命，此项属于增强。

**P4｜跨 resource 的 deny 优先级未验证**：若会话已有 `{action:"collab_list", resource:"ses_x", effect:"deny"}`，本次仍会追加 `{action:"collab_list", resource:"*", effect:"allow"}`；是否被放宽取决于宿主「多个 resource 重叠规则」的匹配/优先级语义（未在宿主文档中固定）。同 `action+resource` 的 deny 已确认**不会**被放宽（S56 + 我的 `ask`/`deny` 用例）。

**P5｜`normalizeRules` 会丢弃无法识别的规则项**：换宿主版本若 `permissions` 规则形状变化（字段名不同 / 多必填字段），merge 后的整集 PATCH 可能把既有规则一起删掉。当前 v2.3.0 已由真实会话（`permissions:[{action,resource,effect}]`）与我的 PATCH 探针确认形状与整集替换语义。

**P6｜HTTP fallback（`COLLAB_SERVER_URL`）零覆盖**：实现方已在 impl-notes §6 承认；本机走 SDK 路径。风险限于老宿主/无 `ctx.session.update` 的环境。

**P7｜台账卫生**：每个被 spawn 的会话留一条 `collab-grants/<sid>.json`，会话删除后记录不清理（无 TTL/prune）；仅影响磁盘卫生，撤回凭据语义已在文档写明。

**P8｜「review 永不 promote」是约定而非硬拦**：代码没有自动 promote 路径（本任务 AC 的「不会被自动 promote」满足）；但 `collab_promote` 无法从广播记录反查 `expected`，人工显式 promote 一个 review 交接不会被拒绝。与 design §7 / impl-notes §6.4 的口径一致，记录在案。

## 3. 是否可提交

**可以提交（as-is）**：R1–R7 的硬性验收全部由我独立复现通过；274/274 全绿、`node --check` 0、插件 `active`；范围与护栏未被突破；无残留会话/台账/广播。

建议在提交前顺手处理 **P1（文档编号 2 行）** 与 **P2（promote no-op 提示 1 处）**——两者都是纯文本层、零行为风险。P3–P8 记入后续任务即可。

提交时用显式路径（本任务 5 个文件），**不要** `git add -A`：工作区里还有 parity/disabled 变体、后端 `docs/issues/*`、`mcp` 指针等其它会话的改动。

## 4. 证据索引

| 文件 | 内容 |
| --- | --- |
| `research/check-evidence/independent-checks.mjs` | 自写假 ctx 复核脚本（52 断言；R2/R3/R4/R5/R7 + 台账两半 + 护栏） |
| `research/check-evidence/independent-checks.log` | 52/52 PASS 原始输出 |
| `research/check-evidence/promote-noop-edge.mjs` | P2 的最小复现 |
| `research/check-evidence/host-probe.txt` | 真实宿主：PATCH permissions / POST /agent / DELETE→404 |
| `research/check-evidence/state-probe.txt` | 全量会话权限扫描（limit=1000）、受保护会话、台账/广播/全局配置 |
| `research/check-evidence/raw-outputs.txt` | `node --check`、harness、`pnpm test:collab`、`/api/plugin`、diff numstat |
