# 实施记录：统一协作链路（11-17-collab-workspace）

> 执行者：trellis-implement（子会话 `ses_e19134f21ffeqkDolblhkxF2CL`）
> 时间：2026-11-17
> 结果：`.opencode/plugins/collab.js` 纯增量新增 `collab_broadcast` / `collab_handoff` / `collab_accept` +
> 全局广播存储/claim/打分/回执/注入；旧 5 个工具行为未变（harness S1–S22 全绿）。
> 门禁：`node --check` OK；`handoff-harness.mjs` **87/87 checks passed**（exit 0）；真实沙箱 peer 链路跑通。

---

## 1. 改动摘要（`file:line`）

全部改动文件：

| 文件 | 说明 |
| --- | --- |
| `.opencode/plugins/collab.js` | 实现（1364 → 2793 行） |
| `.trellis/spec/guides/cross-workspace-collab-guide.md` | 协议文档与实现对齐（已知偏差 #1/#2 移除，新增 §12 全局 shim） |
| `docs/collab.md` | §11.2 工具表补 3 个新工具；新增 §12「协作链路」 |
| `.trellis/tasks/11-17-collab-workspace/implement.md` | 执行清单打勾 + 偏差记录 |
| `.trellis/tasks/11-17-collab-workspace/research/handoff-harness.mjs` | 新 harness（S1–S22 原样 + S23–S30） |
| `.trellis/tasks/11-17-collab-workspace/research/harness-output.txt` | 本次全量原始输出（397 行） |
| `.trellis/tasks/11-17-collab-workspace/research/broadcast-samples/*.json` | 沙箱跑出的三份真实广播记录（证据） |

`collab.js` 结构（行号为最终文件）：

| 位置 | 内容 |
| --- | --- |
| `:47-60` | 新增 import：`node:crypto` / `node:fs`（mkdir/open/rename/unlink/write…）/ `node:path` |
| `:120-160` | 链路常量：`BROADCAST_DIR`(`COLLAB_BROADCAST_DIR` 可覆盖)、`BCAST_THRESHOLD=80`、`BCAST_LEASE_MS=300000`、`BCAST_MAX_ATTEMPTS=3`、`BCAST_BUSY_MS=30min`、`BCAST_RECENT_MS=2h`、`SCORE_MESSAGE_LIMIT=200`、`SCORE_MESSAGE_WINDOW_MS=7d`、`SCORE_CANDIDATE_LIMIT=20`、`BOOTSTRAP_TITLE_RE` |
| `:440-470` | 血缘深度口径修复：`depth <= MAX_LINEAGE_DEPTH`（自身 + 最多上溯 8 级，与 `docs/collab.md` §11.4 一致） |
| `:470-620` | 广播存储：`hash16` / `broadcastID` / `isValidBid` / `readBroadcast` / `normalizeBroadcast` / `writeBroadcast`（tmp+rename）/ `allBroadcasts` / `refreshBroadcast`（租约过期 → `attempts++`+`skipped`+释放 lock；`attempts>3`→`expired`）/ `claimLock`（`open(…,'wx')`）/ `releaseLock` / `persistRefresh` |
| `:640-800` | 内容解析：`extractPaths`（路径 token）/ `keywordsOf`（噪声词表含 `fix|bugs|feat|docs|task`）/ `taskSlugsOf` / `moduleWordsOf` / `titleOf` / `summarizeProposal` / `resolveBroadcastTargets`（workspace 绝对路径 + `docs/issues/**` 硬校验）/ `parseReceiptLine`（`[handoff] DONE|BLOCKED`）/ `receiptMatches` |
| `:800-930` | 打分：`sessionBusyMinutes` / `pathsMatch` / `collectInputPaths` / `pathsFromMessages`（只取 tool `state.input` + `snapshot.files`，200 条 / 7 天）/ `scoreCandidate`（45/25/15/10/5 −10，输出 `why`） |
| `:1097-1290` | `createHandoffChain`：`sessionInfo`(1min TTL) / `listSessions({directory})` / `sessionPaths`(2min TTL) / `rankCandidates`（根会话、排除子会话与 `[protected*]`）/ `applyReceipt` / `notifyRequester` / `injectionFor`（`seenBy`/`reminded` 去重） |
| `:1553-1600` | `deliverAsk`（接管请求，恒 `queue`，protect 校验） |
| `:1693-1940` | `collab_broadcast` |
| `:1942-2083` | `collab_handoff` |
| `:2085-2200` | `collab_accept` |
| `:1517-1690` | `collab_list` 扩展（`directory` / `loc=` / `[bootstrap]` / 未闭环交接摘要） |
| `:2500-2680` | `context` hook 拆分：`injectInbox`（原逻辑）+ `injectChain`（广播/未闭环提醒），合并为 1 个 system part；事件流新增 `chain.applyReceipt` |

## 2. 新增工具签名

```ts
collab_broadcast {
  workspace: string        // 目标工作区绝对路径
  issuePath: string        // 相对路径，必须在 <workspace>/docs/issues/*.md 且存在
  expected?: "implement" | "review"   // 默认 implement
  agent?: string           // 拉新会话的 agent，默认 "explore"
  agentConfirm?: boolean   // agent !== explore 时每次都要 true
  confirm: boolean         // false = 只预览（打分 + 计划），不写文件/不投递
}

collab_handoff {
  target?: string          // ses_… 或别名；省略 = 唯一目标直投 / 多目标按同一套打分择优
  text: string
  expected?: "implement" | "review"
  confirm: boolean
}

collab_accept {
  bid: string              // b_<hex16>
  confirm: boolean
}

collab_list {
  limit?: number
  directory?: string       // 新增：只列某工作区
}
```

返回里固定打印：`bid`、`score/why`、`state`、`claim.by`、下一步动作、回执格式。

## 3. 状态机实现

```
open ──claim(accept)──▶ acked ──[handoff] DONE──▶ done
  │                       └──[handoff] BLOCKED──▶ blocked
  ├──no candidate ≥80 → claim(kind=spawn) ──▶ claimed ──(被拉起的会话 accept)──▶ acked
  ├──lease 过期（5min，state=claimed）──▶ open（attempts+1，claim 持有者进 skipped）
  └──attempts > 3 ──▶ expired（只写状态，升级给人）
```

- `collab_accept` 成功后立刻 `acked`：领取即确认（ACCEPT 本身就是「收到」）。
- 所有 refresh 结果都会落盘（`persistRefresh`），避免「只读预览把状态改了却没写回」。
- 幂等：`bid = hash(scope+workspace+issuePath+内容hash+mtime)`；重复广播 `state` 原样返回且不新建文件。

## 4. harness S23–S30 清单（87 checks，全绿）

新路径：`.trellis/tasks/11-17-collab-workspace/research/handoff-harness.mjs`
（S1–S22 从归档任务原样搬入；归档里那份的 `../../../..` 相对根在归档目录下已失效，**以本路径为准**）

| 段 | 覆盖 | 关键断言 |
| --- | --- | --- |
| S23 | 打分 + why + 成员过滤 | `ses_b1=85`，why 含 `file:…store.ts` / `title:worker` / `task:11-17-worker-store` / `agent:build`；子会话与 protected 不在候选；预览 0 写入 |
| S23b | busy > 30min 叫醒 | `ses_d1=86`（busy 45min 仍 ≥80）→ 恰好 1 条 `queue` prompt，正文含 `collab_accept {bid:…}` |
| S24 | 阈值 80 / 文件为主 | 有 ≥80 候选只写文件、不投递 prompt |
| S25 | 并发领取 | `Promise.all` 两次 accept → 只有 1 个 winner；输家拿到「已被 ses_b1 领取」；记录 acked；发起方收到 ACCEPT note；第三次不可抢 |
| S26 | 幂等 | 同内容重复广播同 bid 且不新建；改内容 → 新 bid；预览仍不落盘 |
| S27 | 并发 spawn | 两并发只建 1 个会话；`location.directory` 正确；默认 `explore`；标题 `impl:<slug>`；输家「未拉新」；`agent:"build"` 无 `agentConfirm` 被拒且不建会话；带 `agentConfirm:true` 建 build |
| S28 | 回执闭环 | `[handoff] DONE <bid> …` → `state=done` + `receipt.note`；闭环后不可再领取 |
| S29 | 租约/升级 | 过期 claim → `attempts=1`、`state=open`、`skipped=[ses_d1]`；`attempts>3` → `expired` 且 accept 抛错 |
| S30 | list / 护栏 / 注入 | `collab_list{directory}` 只回该工作区且带 `loc=b`；`[bootstrap]` 标记；`docs/issues/**` 外路径与不存在文件被拒；群组广播对成员注入 **一次**、子会话与 protected 不注入；未闭环交接对发起方提醒 **一次** |
| S30c | local handoff | 多候选按分选中 `ses_a_target`；1 条 queue prompt；local bid `scope=local/state=acked/threadID`；thread 在接收侧 open；回执闭环 → `done` |

原始输出（节选，完整 397 行见 `research/harness-output.txt`）：

```
--- S23 preview
未广播（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。
bid=b_066e93f9f5674b2a  scope=peer  workspace=/tmp/collab-harness-400gU4/ws/b
提案: docs/issues/fix-worker-store.md  标题: "worker store 修复（11-17-worker-store）"  期望: implement
影响面(1): packages/state/src/machine/worker/store.ts
群组成员 2 个根会话（已排除子会话与 [protected*]），匹配分（阈值 80）:
   85  ses_b1  agent=build  "11-17-worker-store worker store 重构"  why=[file:packages/state/src/machine/worker/store.ts, title:worker, title:store, task:11-17-worker-store, agent:build, recent:10m]
    2  ses_b2  agent=explore  "bench 压测脚本"  why=[recent:60m]
top-1 ses_b1 score=85 → 不投递任何 prompt（等它自己在下一轮 context 注入里看到广播）

--- S25 concurrent accept #1
已领取 b_23ce77c38a83dea0（winner，token=k_mwjyycvj_rmmu，state=acked，lease=300000ms）
...
--- S25 concurrent accept #2
已被 ses_b1 领取（bid=b_23ce77c38a83dea0，token=k_mwjyycvj_rmmu）—— 你不是 winner。不要重复领取，也不要再拉新。

--- S27 concurrent spawn #1
已广播并拉新（无候选 ≥80）：bid=b_2ebb4dc51295941a
新会话: ses_spawn_1 agent=explore loc=/tmp/collab-harness-Y50wbQ/ws/c title="impl:fix-nobody-home"
--- S27 concurrent spawn #2
未拉新：bid 已被 ses_req 领取（并发下只有一个 winner）。

--- S28 receipt moves the bid to done
  ✓ S28 receipt moves the bid to done — done
  ✓ S28 receipt is recorded with its note — {"from":"ses_b1","at":1794876212156,"note":"shipped-in-abc1234"}

=== 87/87 checks passed
```

`node --check .opencode/plugins/collab.js` → exit 0。

## 5. 沙箱验收（真实 OpenCode，跨 location）

环境：`/tmp/collab-sandbox/{a,b,c}`，各自 `git init` + `docs/issues/`（保留供复核）。
`b` 无项目副本 → 由全局 shim `collab-global` 加载本仓实现：`/api/plugin?location[directory]=/tmp/collab-sandbox/b`
→ `collab-global active`。

建的临时会话（全部是我自建）：

| 会话 | 用途 |
| --- | --- |
| `ses_e1909c413ffeQD5CoNmRdd7796` | b 侧候选 1（读提案里的文件 → 文件交集 45） |
| `ses_e1909c346ffeCw1L3NIqrEE6yZ` | b 侧候选 2（低分，用来竞争领取） |
| `ses_e1906b3e2ffehUuMUA8rErY4p5` | c 侧 spawn（`impl:fix-sandbox-spawn`，explore） |

### 5.1 广播 + 打分（A 侧 = 本会话 `ses_e19134f21ffeqkDolblhkxF2CL`）

```
未广播（confirm 不为 true，仅预览）...
bid=b_773d5bbb45ec03ee  scope=peer  workspace=/tmp/collab-sandbox/b
群组成员 2 个根会话（已排除子会话与 [protected*]），匹配分（阈值 80）:
   91  ses_e1909c413ffeQD5CoNmRdd7796  agent=build  "11-17-collab-sandbox worker store 交接"  why=[file:tmp/collab-sandbox/b/packages/state/src/machine/worker/store.ts, title:sandbox, title:worker, title:store, task:11-17-collab-sandbox, agent:build, recent:0m]
   18  ses_e1909c346ffeCw1L3NIqrEE6yZ  agent=build  "impl:sandbox-b-2"  why=[title:sandbox, agent:build, recent:1m]
top-1 ses_e1909c413ffeQD5CoNmRdd7796 score=91 → 不投递任何 prompt（等它自己在下一轮 context 注入里看到广播）
```

确认后写入真实全局目录：

```
已广播 peer 交接：bid=b_773d5bbb45ec03ee（写入 /root/.config/opencode/collab-broadcast，其余成员 0 模型调用）
=== repeat ===
已存在同一内容的交接（bid 幂等，不新建）：state=open attempts=0
```

磁盘证据：`ls ~/.config/opencode/collab-broadcast/ → b_773d5bbb45ec03ee.json`（1 个文件，无第二条）。
改提案内容（`sandbox: proposal v2`）后 → 新 `bid=b_5d9c3a42c786c040`（幂等边界正确）。

### 5.2 并发领取（两个 b 会话同时 `tools.collab_accept`）

```
# ses_e1909c413ffeQD5CoNmRdd7796（输家）
已被 ses_e1909c346ffeCw1L3NIqrEE6yZ 领取（bid=b_5d9c3a42c786c040 state=acked）—— 不要重复领取，也不要再拉新。

# ses_e1909c346ffeCw1L3NIqrEE6yZ（winner）
已领取 b_5d9c3a42c786c040（winner，token=k_mwjz2j9a_a0oo，state=acked，lease=300000ms）
scope=peer workspace=/tmp/collab-sandbox/b 期望=implement
跨仓护栏：只允许改目标仓 docs/issues/**，git 只读，不 push；实施由目标仓 owner 复核提交。
已通知发起方 ses_e19134f21ffeqkDolblhkxF2CL（message=msg_1e6f87d170…）
```

记录：`state=acked`, `claim.by=ses_e1909c346ffeCw1L3NIqrEE6yZ`。

### 5.3 回执闭环

winner 用 `collab_send` 发 `[handoff] DONE b_5d9c3a42c786c040 sandbox-receipt` 给发起方 →
发起方插件（本仓实例）事件流解析：

```
state done
claim {'by': 'ses_e1909c346ffeCw1L3NIqrEE6yZ', 'kind': 'accept', 'token': 'k_mwjz2j9a_a0oo', ...}
receipt {'from': 'ses_e1909c346ffeCw1L3NIqrEE6yZ', 'at': ..., 'note': 'sandbox-receipt'}
```

### 5.4 无候选 → spawn（并发两次只建一个）

```
=== #1
已广播并拉新（无候选 ≥80）：bid=b_52bfcec0096fc0f1
新会话: ses_e1906b3e2ffehUuMUA8rErY4p5 agent=explore loc=/tmp/collab-sandbox/c title="impl:fix-sandbox-spawn"
已向新会话投递接管请求（queue）。

=== #2
未拉新：bid 已被 ses_e19134f21ffeqkDolblhkxF2CL 领取（并发下只有一个 winner）。
```

新会话首条 user 消息（证明接管请求与 `location.directory` 都对）：

```
user [collab:ses_e191…F2CL][request] [collab-handoff] sandbox nobody home（11-17-collab-sandbox）
提案：docs/issues/fix-sandbox-spawn.md（工作区 /tmp/collab-sandbox/c，scope=peer）
影响面：apps/pos/src/main.ts | 期望：implement
领取：collab_accept {bid:"b_52bfcec0096fc0f1", confirm:true}（原子，只有一个 winner）
```

`collab_list{directory}`：

```
1 个会话（id / agent / state / loc / updated / title）:
ses_e1906b3e2ffehUuMUA8rErY4p5  explore  busy  loc=c  08:47:45  "impl:fix-sandbox-spawn"  [bootstrap]
未闭环交接:
- b_52bfcec0096fc0f1 claimed scope=peer "$ sandbox nobody home（11-17-collab-sandbox）" 提案=docs/issues/fix-sandbox-spawn.md 承接=ses_e1906b3e2ffehUuMUA8rErY4p5 attempts=0
```

`collab_handoff` 预览（local，未投递，避免打扰本仓其它会话）：

```
未投递（confirm 不为 true，仅预览）...
目标: ses_e1909c413ffeQD5CoNmRdd7796 agent=build state=idle title="11-17-collab-sandbox worker store 交接"
kind=request mode=queue thread=t_mwjz3sux_r3jc bid=b_70a9f24a66d60c7a
```

### 5.7 local 链路（真实宿主，同工作区）

为避免打扰本仓其它在跑的会话，新建了一个自用会话做目标：

```
$ opencode api post /api/session -d '{"title":"impl:local-handoff-selftest","agent":"build","location":{"directory":"/data/project/muke-pos-app"}}'
ses_e19033d51ffeNPRMU2hY8heliS build {'directory': '/data/project/muke-pos-app'}

# 预览
未投递（confirm 不为 true，仅预览）...
目标: ses_e19033d51ffeNPRMU2hY8heliS agent=build state=idle title="impl:local-handoff-selftest"
kind=request mode=queue thread=t_mwjz8ljb_r7r7 bid=b_be2d57dd25792c04

# 确认
已投递 → ses_e19033d51ffeNPRMU2hY8heliS  agent=build  state=idle
kind=request  thread=t_mwjz8ljm_shv5  status=open
mode=queue  message=msg_1e6fcce1b001W5y2Oz4iAvJowt  delivery=queue
bid=b_be2d57dd25792c04  thread=t_mwjz8ljm_shv5（local scope，回执用 collab_reply {threadID}）
等结果: collab_wait {threadID:"t_mwjz8ljm_shv5", timeoutMs:…}
```

落盘记录（`scope=local`，`claim.kind=handoff`，thread 已绑定）：

```json
{
  "bid": "b_be2d57dd25792c04", "scope": "local",
  "workspace": "/data/project/muke-pos-app", "threadID": "t_mwjz8ljm_shv5",
  "state": "acked",
  "claim": { "by": "ses_e19033d51ffeNPRMU2hY8heliS", "kind": "handoff", "token": "h_be2d57dd", "at": …, "leaseMs": 300000 },
  "from": { "sid": "ses_e19134f21ffeqkDolblhkxF2CL", "directory": "/data/project/muke-pos-app" }
}
```

目标会话收到的 user turn（thread 信封完整，可直接 `collab_reply {threadID}`）：

```
user [collab:ses_e191…F2CL][request:t_mwjz8ljm_shv5] local 链路自测：复核 packages/machine/src/cfg/impl.ts 的 handoff 记录，完成后回执。
```

清理（该会话是我建的，跑起来后立即停止以省成本）：

```
deleted ses_e19033d51ffeNPRMU2hY8heliS
verify: HTTP 404 Not Found
```

已知副作用与复原：该自测会话在 `packages/machine/__tests__/` 下留了一个临时探针
`__probe-cfg-scope.test.ts`（untracked，非本任务改动）——已删除，`git status` 回到「原有的他人改动 + 本任务的 4 个文件」。
`packages/**`、`apps/**` 下没有任何本任务产生的改动。

### 5.8 临时会话清理

```
deleted ses_e1909c413ffeQD5CoNmRdd7796
deleted ses_e1909c346ffeCw1L3NIqrEE6yZ
deleted ses_e1906b3e2ffehUuMUA8rErY4p5
ses_e1909c413ffeQD5CoNmRdd7796 → HTTP 404 Not Found
ses_e1909c346ffeCw1L3NIqrEE6yZ → HTTP 404 Not Found
ses_e1906b3e2ffehUuMUA8rErY4p5 → HTTP 404 Not Found
```

三个沙箱 bid 的 json/lock 已从全局目录删除（副本留在 `research/broadcast-samples/`），`~/.config/opencode/collab-broadcast/` 现为空。
`/tmp/collab-sandbox/{a,b,c}` 保留供复核（b 仓 2 个 commit 是我手工建的基线，用来固定提案 mtime）。

### 5.6 插件健康

```
== /data/project/muke-pos-app
  collab-global active          # 让路（静默，不注册工具）
  collab active                 # 项目副本
== /data/project/muke-interface
  collab-global active
```

无 `failed`。

## 6. 未验证项 / 已知限制

1. **`agents.explore|plan` 的 permissions 未覆盖新工具**（根 `opencode.json` 不在本任务可改范围）。
   实测：沙箱 `build` 会话直调 `collab_accept` 报 `No tool named "collab_accept"`，改用 Code Mode
   `tools.collab_accept(...)` 成功。需要在 `opencode.json` 的 `agents.*.permissions` 追加
   `collab_broadcast` / `collab_accept` / `collab_handoff` 三条 `allow`（已在 guide §10 #4、docs/collab.md §12.5 #1 记录）。
2. **匹配分数据源**：`GET /api/session/{id}/message?limit=200` 在插件 ctx 里没有对应方法，改用 `ctx.session.context`
   （最后一次 compaction 之后的消息）+ 200 条 / 7 天窗口二次过滤。若某会话刚 compact 过，历史文件触碰记录会变少。
3. **DECLINE 顺延**：发起方插件在 inbox 事件流里解析 `DECLINE`（只有「当前被问询的 `asked.sid`」发的才算），
   立即 `attempts+1` / `skipped` / 问下一候选；问询租约（5 分钟）超时同样顺延。无守护进程，超时推进发生在
   下一次读写该 `bid` 时（`collab_broadcast` / `collab_accept` / `context` 注入）。
4. **重启持久化**：未执行 `opencode service restart`（会中断并行会话），因此「跨重启后广播/claim 仍生效」只由
   「纯文件存储 + 每次读都刷新」推理保证，未实测。
5. 归档任务里的旧 harness（`.trellis/tasks/archive/2026-11/11-17-collab-handoff/research/handoff-harness.mjs`）
   相对根路径在归档深度下失效，属于历史产物（只读），未修改；现行门禁以本任务 `research/handoff-harness.mjs` 为准。

## 7. 收口与后续（给复核/主会话）

最终自检：

```
$ node --check .opencode/plugins/collab.js              # exit 0
$ node .trellis/tasks/11-17-collab-workspace/research/handoff-harness.mjs
=== 87/87 checks passed                                 # exit 0（完整输出 research/harness-output.txt）
$ opencode api get "/api/plugin?location[directory]=$PWD"
 collab: ['collab-global', 'collab']   non-active: none
$ opencode api get "/api/plugin?location[directory]=/data/project/muke-interface"
 collab: ['collab-global']             non-active: none
```

实测 `collab_list` 新列（真实数据，注意 `loc=` 与 `[protected*]`、`[self]` 并存）：

```
ses_e19134f21ffeqkDolblhkxF2CL  trellis-implement  busy  loc=muke-pos-app  08:51:14  "实现统一协作链路"  [self] parent=ses_e195…aqC4
ses_e1eb91cebffeTv1467ubJLKebk  build  idle  loc=muke-pos-app  08:47:16  "machine/state 出入参 schema 固化"  alias=schema [protected]
```

后续（不在本任务允许改动范围内，建议主会话跟进）：

1. 根 `opencode.json`：给 `agents.explore` / `agents.plan` 的 `permissions` 追加
   `collab_broadcast` / `collab_accept` / `collab_handoff` 三条 `{action, resource:"*", effect:"allow"}`，
   只读 agent 才能像老 5 个工具那样**直调**新工具（当前只能走 Code Mode）。
2. `.trellis/spec/guides/index.md` 增加一行指向 `cross-workspace-collab-guide.md`（索引目前缺这一行，本任务未改该文件）。
3. 提交（显式路径，不 push）：`.opencode/plugins/collab.js`、`docs/collab.md`、
   `.trellis/spec/guides/cross-workspace-collab-guide.md`、`.trellis/tasks/11-17-collab-workspace/**`。

### 收尾时收到的一条迟到消息（无需动作）

清理后本会话 inbox 又收到一条来自**已删除**沙箱会话 `ses_e1909c346ffeCw1L3NIqrEE6yZ` 的 note：

```
[collab:ses_e190…E6yZ][note] ACCEPT docs/issues/fix-sandbox-handoff.md —— ses_e190…E6yZ 已领取 b_773d5bbb45ec03ee（peer，implement）
```

随后又收到同一会话针对 `b_5d9c3a42c786c040` 的同类 note。两条都是沙箱第一/第二轮广播的「领取通知」，
在清理时已随 bid 文件一起删除：`~/.config/opencode/collab-broadcast/` 为空、该会话 `GET` 返回 **404**。
`note` 不改状态、这两个 bid 已不存在 → **不需要任何动作**（也不会产生未闭环提醒）。

第三条是**同一批里的回执本体**（`[request:t_mwjz2kj8_c8t4] [handoff] DONE b_5d9c3a42c786c040 sandbox-receipt`）：
它在发出时就被发起方插件解析并直接关闭了 `b_5d9c3a42c786c040`（当时日志 `[collab] handoff b_5d9c… → done`，
归档样本里 `state=done` + `receipt.note=sandbox-receipt`），属于**已经生效过**的消息，重复到达不需要再处理。

> 沙箱遗留物：`collab/threads/t_mwjz2kj8_c8t4`（本 location 的 `ctx.storage`）里还有一个 `open` 的 thread，
> 对端是已删除的沙箱会话；`collab_reply` 会因目标不存在而失败，插件也没有「关闭 thread」的工具。
> 该消息已被标记 `injected`（`collab_inbox` 显示 3 条 / 未读 0），不会再被提醒，属于无害残留，不在本任务范围内清理。

归档证据（`research/broadcast-samples/`）里两者的终态：

```
b_773d5bbb45ec03ee  state=acked  claim.by=ses_e190…E6yZ  receipt=None          # 第一轮，被第二轮取代
b_5d9c3a42c786c040  state=done   claim.by=ses_e190…E6yZ  receipt={note:"sandbox-receipt"}   # 真正跑通闭环的那条
```

> 工作区里还有别的会话的改动（`packages/**`、`docs/issues/**`、`11-17-schema-governance/**`），
> 与本任务无关；本任务**未** `git add`/`commit`/`push`，也未触碰那些文件。

---

## 8. 复核修复轮（对照 `research/check-report.md`，2026-11-17）

> 复核结论是「不通过（不可提交）」：2 项阻断 + 1 项需求缺口 + 5 项应修。
> 本轮只改 `.opencode/plugins/collab.js`、`.trellis/spec/guides/{cross-workspace-collab-guide,index}.md`、
> `docs/collab.md`、`.trellis/tasks/11-17-collab-workspace/**`；未动 `packages/**` / `apps/**` / `bench/**` /
> `docs/issues/**` / 其它任务；未做任何 git 写操作。

### 8.1 B1（阻断）spawn 会话无法 `claimed → acked`

**改法**：`collab_accept` 的「已是我领取」分支不再直接返回，而是按状态处理——
`state==="claimed" && claim.by===me` 时写 `state:"acked"` + `ackedAt`、释放 spawn lock、给发起方一条 `ACCEPT` note；
`acked` 时只返回状态。回执模板**只给 `DONE`**（`BLOCKED` 从模板里删掉，改成「确实无法完成」时才用）。

- `collab.js:2355-2385`（promote 分支）
- 回归 harness `S31`（`handoff-harness.mjs`，原始输出见 `research/harness-output.txt`）

```
✓ S31 spawned hand-off starts claimed by the new session — {"by":"ses_spawn_3","kind":"spawn",...,"spawner":"ses_req"}
✓ S31 spawned session accept moves it to acked — {"state":"acked","by":"ses_spawn_3"}
✓ S31 ackedAt is recorded — 1794877788331
✓ S31 receipt template is DONE and never BLOCKED — 你已领取 b_eafe…（state=acked，kind=spawn…） / 完成后回执: [handoff] DONE b_eafe… <commit sha 或摘要>
✓ S31 requester was told about the ACCEPT — prompts→ses_req
```

### 8.2 B2（阻断）spawn 的 lock 归属错位，租约过期永不释放

**改法**：

1. spawn 建好会话后 `updateLock(bid,{claimBy:<新会话>})`，lock 里同时有 `by`（真正持锁的发起方）与 `claimBy`（记录里的承接者）
   —— `collab.js:2060`、`updateLock` `:713-722`；
2. `releaseLock(bid, expected)` 接受数组，`by` **或** `claimBy` 任一命中即删 —— `:697-711`；
3. 租约过期按 `[claim.by, claim.spawner]` 释放 —— `refreshBroadcast` `:617-660`；
4. spawn 的领取者自己 `collab_accept`（B1）与回执闭环时也按同样规则释放。

回归 `S32`：

```
✓ S32 spawn lock exists before expiry — /tmp/collab-harness-…/broadcast/b_1118….lock
✓ S32 lapsed spawn reopens: attempts=1, holder skipped — {"state":"open","attempts":1,"skipped":["ses_spawn_1"]}
✓ S32 lapsed spawn releases the lock — false
✓ S32 the loser is no longer told 已被 … 领取 — 未领取（confirm 不为 true，仅预览）…
✓ S32 a member can claim once the lock is released — 已领取 b_1118…（winner，… state=acked）
```

真实宿主复跑（同 §8.6）：伪造 5 分钟后 `state=open attempts=1`，`.lock` 从目录消失。

### 8.3 B3（需求缺口）R3/R4 的 ACCEPT/DECLINE 问询协议

按 prd R3/R4 补实现（未改需求语义）：

| 设计要求 | 实现 | 位置 |
| --- | --- | --- |
| 记录增 `asked: { sid, at, leaseMs }` | `normalizeBroadcast` 规范化 + 广播创建时写入 top-1 | `:530-533`、`:2120` |
| `DECLINE` → 该候选 `skipped` / `attempts+1` / 顺延下一候选（并发 1 条问询） | `applyDecline`（事件流里解析，只认 `asked.sid` 发的）→ `declineAsked` → `planAsk` | `:1367-1376`、`:598-611`、`:582-596`、事件流 `:2766` |
| 问询租约 300000ms 到期无 ACCEPT → 同样顺延 | `refreshBroadcast` 的 `asked` 分支走同一个 `declineAsked` | `:640-643` |
| 全部候选耗尽 / `attempts>3` → `expired`，**不 spawn** | `declineAsked` 里 `!planAsk(...) \|\| attempts > MAX` → `expired`；spawn 只在 `plannedSpawn`（无 ≥80）分支 | `:598-611`、`:1984` |
| top-1 串行：只有当前被问的会话收到接管请求 | `injectionFor` 拆成「接管请求」（`askSeen` 去重，只给 `asked.sid`）+「群组广播」（`seenBy` 去重）；`asked` 前进后新候选会拿到自己那条 | `:1410-1450` |

两个实现细节（写进 guide §5.3）：

- **`claimed` 租约过期**（领了不干）→ `open` + `attempts+1` + 更新 `skipped`；还有候选就继续问下一个，没有就回到全员可见
  （**不是** `expired`：没被问过就不算候选耗尽；`attempts>3` 仍会 `expired`）；
- **spawn 租约过期**（拉起后没人 ACCEPT）→ `open` 且不带 `asked`，让群组成员直接接手（对应 S32）；
- `collab_accept` 成功时清空 `asked`，问询租约不会再跑。

回归 `S33` / `S34`：

```
✓ S33 only the top-1 candidate is asked (serial) — {"state":"open","asked":{"sid":"ses_f1","at":…,"leaseMs":300000}}
✓ S33 DECLINE skips the candidate and counts one attempt — {"attempts":1,"skipped":["ses_f1"]}
✓ S33 DECLINE asks the next candidate (state stays open) — {"asked":"ses_f2","state":"open"}
✓ S33 the next candidate gets the takeover request — …- 接管请求 b_fe9e…：worker store 修复…
✓ S33 the ask line explains ACCEPT / DECLINE / lease — …"DECLINE <理由>" 让下一候选接手；5 分钟不答自动顺延…
✓ S33 the next candidate can claim it — ses_f2
✓ S34 ask timeout skips the candidate and counts one attempt — {"attempts":1,"skipped":["ses_g1"]}
✓ S34 ask timeout asks the next candidate — {"asked":"ses_g2","state":"open"}
✓ S34 exhausted candidates → expired (no re-delivery) — 广播 b_bca6… 已 expired（attempts=2 > 3）
✓ S34 an expired hand-off never spawns — 0 spawn(s)
✓ S34 an expired hand-off is not re-delivered — 0 prompt(s)
✓ S34 attempts > 3 → expired even with a candidate left — 广播 b_bca6… 已 expired（attempts=4 > 3）
```

（S33 的 peer 侧注入用**第二个 plugin 实例**模拟对端 location：`ctxF.location.directory=WS_F`，
`session.hook` 收进独立 map，`event.subscribe` 空实现以避免和主实例抢同一条事件流。）

### 8.4 应修 S1–S5

| ID | 问题 | 改法 | 位置 | 回归 |
| --- | --- | --- | --- | --- |
| S1 | `collab_handoff` 重复调用复活已 `done` 的 bid | 复用同一 `bid` 前先 `readBroadcast`：已存在就直接返回「已存在同一交接」/「已闭环」，**不投递、不覆盖、不改状态** | `:2232-2252` | S35 |
| S2 | 拉新落点校验有空档（宿主不回 `location` 也当成功） | 判定改为 `landed !== workspace`（严格相等）；缺失同样删除刚建的会话并抛错；文案用真实 `landed` | `:2045-2062` | S37 |
| S3 | 回执按 `issuePath` basename 全局匹配 | 只认 `bid` / 完整 `issuePath` / `threadID`；新增 `receiptAllowed`（`from` 必须等于 `claim.by`） | `:929-945`、`:1340-1364` | S36 |
| S4 | 软链绕过 `docs/issues` 校验 | `lstat` 拒绝软链 + `realpath` 复查真实路径仍在 `<workspace>/docs/issues/` 下（workspace 也走 `realpath`） | `:843-905` | S38 |
| S5 | 新 guide 未进 `guides/index.md` | 索引加一行（`cross-workspace-collab-guide.md`） | `.trellis/spec/guides/index.md:31` | S38 |

```
✓ S35 a repeated handoff is a no-op (same bid, no second delivery) — 已存在同一交接（bid 幂等，不重复投递）…
✓ S35 a closed handoff is not resurrected and keeps its receipt — {"state":"done","note":"sha-1"}
✓ S36 a bare basename does not close a hand-off — acked
✓ S36 a non-claimant receipt does not close a hand-off — acked
✓ S36 the exact issuePath from the claimant closes it — {"state":"done","from":"ses_f2"}
✓ S37 spawn without a verifiable landing is refused — 拉新失败：会话落点不对（期望 …ws/i，实际 (未知)），已回滚刚建的会话。
✓ S37 the unknown-landing session is rolled back — {"removed":["ses_spawn_4"],"ghost":"ses_spawn_4"}
✓ S37 a rolled-back spawn leaves no record behind
✓ S38 a symlinked proposal is refused — 拒绝广播：提案 docs/issues/fix-symlink.md 是软链…
✓ S38 the cross-workspace guide is listed in the guide index — guides/index.md
```

### 8.5 门禁原始输出（2026-11-17 复核修复轮）

```
$ node --check .opencode/plugins/collab.js
node --check exit=0

$ node .trellis/tasks/11-17-collab-workspace/research/handoff-harness.mjs
=== 124/124 checks passed
harness exit=0                       # 完整输出 research/harness-output.txt

$ opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"
  collab-global active /root/.config/opencode/plugins/collab-global.js
  collab        active /data/project/muke-pos-app/.opencode/plugins/collab.js
$ opencode api get "/api/plugin?location%5Bdirectory%5D=/data/project/muke-interface"
  collab-global active /root/.config/opencode/plugins/collab-global.js
$ opencode api get "/api/plugin?location%5Bdirectory%5D=/tmp/collab-sandbox/b"
  collab-global active /root/.config/opencode/plugins/collab-global.js
```

既有 87 项未被削弱（S1–S30 全绿），新增 37 项覆盖 B1/B2/B3/S1–S5。

### 8.6 真实宿主沙箱复跑（/tmp/collab-sandbox/b）

用的是**运行中的 OpenCode + 全局 shim**（插件文件热重载，输出里已出现本轮新增的
「当前问询: …」「必须由承接方 … 发送」文案与 lock 里的 `claimBy`，证明跑的是新代码）。

```text
# 1) 广播（无 ≥80 候选）→ 真实 spawn
已广播并拉新（无候选 ≥80）：bid=b_e0ca26687b6bd74c
新会话: ses_e18f36b0fffel4K7UTmxUXlqaV agent=explore loc=/tmp/collab-sandbox/b title="impl:fix-sandbox-ack"
已向新会话投递接管请求（queue）。

# 2) 落盘：spawn lock 同时记 by(发起方) + claimBy(新会话)
$ cat ~/.config/opencode/collab-broadcast/b_e0ca26687b6bd74c.lock
{"bid":"b_e0ca26687b6bd74c","token":"k_mwjzurcf_gayp","at":1794877723887,
 "by":"ses_e18fa4c2bffeYTuUquLBONwDPq","kind":"spawn","claimBy":"ses_e18f36b0fffel4K7UTmxUXlqaV"}

# 3) 伪造 5 分钟后（claim.at -= 301000）再读同一条广播
已存在同一内容的交接（bid 幂等，不新建）：state=open attempts=1
承接: -  候选 top: -  当前问询: -
$ ls ~/.config/opencode/collab-broadcast/     # .lock 已消失
b_e0ca26687b6bd74c.json
$ python3 -c "..."
{'state': 'open', 'attempts': 1, 'skipped': ['ses_e18f36b0fffel4K7UTmxUXlqaV'], 'asked': None, 'claim': None}

# 4) 真实打分（真实会话 + 真实 ctx.session.context），确认「无 ≥80 不 spawn 之外不乱投递」
群组成员 3 个根会话（已排除子会话与 [protected*]），匹配分（阈值 80）:
   53  ses_e18f36b0…  agent=explore  "impl:fix-sandbox-ack"  why=[file:…/worker/store.ts, title:sandbox, recent:0m]
   42  ses_e18f2d05…  agent=build    "11-17-collab-sandbox worker store 交接（复核轮）"  why=[title:sandbox, title:collab, title:worker, task:11-17-collab-sandbox, agent:build, recent:0m]
   42  ses_e18f2d92…  agent=build    （同上）
无候选 ≥80 → 确认后用 claim(kind=spawn) 拉新一个会话：agent=explore location.directory=/tmp/collab-sandbox/b
```

清理（全部是本轮自建会话；无删除他人会话、无 `interrupt`、无 `opencode service restart`）：

```
deleted ses_e18f36b0fffel4K7UTmxUXlqaV   # 广播 spawn
deleted ses_e18f2d059ffeyTzaUaexVrKg0r   # 自建（打分用）
deleted ses_e18f2d925ffea8VqvIn1Y21dmc   # 自建（打分用）
$ opencode api get /api/session/ses_e18f36b0fffel4K7UTmxUXlqaV
{"_tag":"SessionNotFoundError",...} / HTTP 404 Not Found
$ opencode api get /api/session/ses_e18f2d059ffeyTzaUaexVrKg0r
HTTP 404 Not Found
$ rm ~/.config/opencode/collab-broadcast/b_e0ca26687b6bd74c.json   # 样本留在 research/broadcast-samples/
$ ls ~/.config/opencode/collab-broadcast/   → empty
```

**未在真实宿主复跑的部分（据实说明）**：`DECLINE` / 问询超时 / `spawn → 自己 ACCEPT` 需要「被问的候选会话自己调用工具」
或「有真实文件触达历史的 ≥80 候选」，两者都要跑模型轮；本轮为控制成本与避免打扰并行会话，只在 harness
（S31–S36，含伪造 5 分钟、两个 plugin 实例模拟对端 location）里覆盖。真实宿主已验证的等价路径：lock 的
`by/claimBy` 双字段、租约刷新与释放、`open` 后的可领取性、广播幂等、真实打分与 spawn 落点。

### 8.7 已知限制（复核清单里「可留」的项，保持现状）

1. `SCORE_CANDIDATE_LIMIT=20`：只对最近活跃的前 20 个根会话打分，第 21 个完美候选不会被问询（`collab.js:161`、`:1321`）。
2. `collab_list` 不过 `refreshBroadcast`，列表里的 `state/attempts` 可能是快照（`:1869-1876`）。
3. 广播目录无清理：`done/expired` 的 `<bid>.json` 永久保留，每次请求 O(N) 次读文件（`:549-563`、`:1419`）。
4. `expired` 时连 `confirm:false` 的预览也直接抛错（`:2344-2348`），预览不返回记录内容。
5. `bid` 含提案 `mtime`：同一内容被 `touch`/`git checkout` 会产生第二个 `bid`（与 design §2 一致，AC 措辞按「内容 + mtime」理解）。


