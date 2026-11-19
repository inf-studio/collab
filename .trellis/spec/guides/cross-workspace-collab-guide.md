# 协作链路指南：同工作区并行会话 + 跨工作区（handoff chain）

> 适用范围：同一工作区的多个 OpenCode 会话互相派活；或本仓需要另一个工作区（`muke-interface`、`deploy`、`../std-ui`）修正/确认。
> 权威源：跨仓写边界见全局 AGENTS「工作区与数据边界」；投递语义见 `docs/collab.md` §11–§12；实现见 `.opencode/plugins/collab.js`。
> 最后校准基线：2026-11-17，opencode v2.3.0（协作链路实现落盘：`collab_broadcast` / `collab_accept` / `collab_handoff` + 全局广播存储；
> 加固轮 `11-17-collab-hardening`：accept 血缘护栏 / 接管请求带发起方完整 sid / `DECLINE <bid>` / 列表只读租约标注 / 广播目录 7 天清理；
> 自动回执轮 `11-17-collab-auto-receipt`：三处文案统一为「① 领取 → ② 回执 → ③ 只分析 = 未完成」，`spawn` 租约到期只读提取对端结论自动闭环；
> 受保护发起方轮 `11-18-collab-protected-receipt`：`receiptMode:"pull"`（发起方命中 protect → 回执写在自己最后一条
> 回复里，发起方租约到期只读提取）+ 限界 reply（`kind=reply` + 该 bid 的发起方 + 该单领取人 = 唯一放行条件）；
> `request`/`note`/`steer` 仍 fail-closed；`acked` 静默 2h 也可提取；
> 权限补丁轮 `11-17-collab-grant`：spawn 自动 + `collab_grant` 给**单个会话**追加 5 条 `collab_*` allow（会话级 `PATCH permissions`，合并去重、记录 `before` 支持 revoke）；`collab_promote` 按会话切 agent（白名单 `build`/`plan`，记录 `agentBefore` 支持 revert，与 grant 共用一份台账））。

## 0. 一条链路，两个 scope

编排层（广播 / 打分 / 领取 / 状态机 / 回执）只有一份实现；传输层按 scope 分叉。

| 层 | `scope:"local"` | `scope:"peer"` |
| --- | --- | --- |
| 提案 | 可选 | **必需**：对端 `docs/issues/{bugs,fix,feat}-*.md` |
| 传输 | thread 可用（原子、可等回执） | **只能消息**（`ctx.storage` 按 location 隔离） |
| 写权限 | 接手方可改本仓代码 | 只读 + 仅提案 |
| 拉新位置 | 本仓 | 对端 `location.directory` |
| 入口工具 | `collab_handoff` | `collab_broadcast` + `collab_accept` |

thread 不是主干，只是 local scope 的快路径/视图；跨仓一律消息闭环。

## 1. 三条硬事实

1. **thread 存储按 location 隔离**：跨工作区 `collab_reply {threadID}` / `collab_wait {threadID}` 必然报「没有 thread（可能由别的项目/目录创建）」。
2. **插件默认只装在本仓**：全局依赖 `~/.config/opencode/plugins/collab-global.js` shim（项目自带副本时让项目独占，否则加载本仓实现）。**不要直接软链实现文件**——会 `Duplicate plugin ID: collab`。
3. **广播与领取状态放全局文件**（`~/.config/opencode/collab-broadcast/`），不能放 `ctx.storage`，否则对端读不到、claim 无法原子。

## 2. 触发门

| 需求 | 动作 |
| --- | --- |
| 同仓：需要另一个会话接手 | `collab_handoff`（local） |
| 跨仓：对方要改代码/配置/数据 | 写提案 → `collab_broadcast`（peer，`expected:"implement"`） |
| 跨仓：只需对方确认 | 写提案 → 广播（`expected:"review"`） |
| 对端已有会话但缺 `collab_*` 权限（另一个工作区的 explore 拿不到工具） | `collab_grant { target:"ses_…", confirm:true }`；撤销同参数 + `revoke:true` |
| 对端**已 ACCEPT** 且确需它改代码（explore 只读，做不了） | `collab_promote { target:"ses_…", confirm:true }`（默认 `build`，白名单 `build`/`plan`）；`revert:true` 切回原 agent。**`expected:"review"` 的交接永不 promote** |
| 只是通报进展 | `note`，不发起交接 |
| 我方要改对方代码 | ❌ 不做；跨仓写只允许 `docs/issues/**` |

## 3. 提案（仅 peer scope 必需）

- 路径：`<目标仓>/docs/issues/{bugs,fix,feat}-<name>.md`；无目录就建，无模板用：状态 / 范围 / 问题 / 根因 / 方案 / 验证 / 涉及文件。
- 头部必写：`状态`、`范围`、`关联`（提出方 + 跟踪任务路径）、`核对日期`。
- 单一真源在目标仓；禁止对该提案做 git 写操作；禁止写目标仓其它路径。
- `collab_broadcast` 会硬校验：`issuePath` 必须落在 `<workspace>/docs/issues/` 下、文件必须存在且是 `.md`；
  **软链提案直接拒绝**（`lstat` + `realpath` 双重校验，防止 `docs/issues/x.md -> /etc/passwd` 把仓外内容写进全局记录）。

## 4. 群组与广播（`collab_broadcast`）

一个工作区 = 一个群组。成员 = `location.directory` 命中该工作区的**根会话**，排除 `[protected]` / `[protected-child]` 与子会话、排除发起方自己。

广播采用**文件为主 + 忙会话叫醒**（成本：1 次广播 = 0 模型调用）：

1. 发起方把广播写进 `~/.config/opencode/collab-broadcast/<bid>.json`（`tmp + rename` 原子替换）；
2. 对端插件在各会话的 `context` hook 里读全局目录，命中本工作区、`state=open` 且 `seenBy` 未含本会话 → 注入一行
   `- 群组广播 <bid>：<标题>（提案 <路径>，期望 <动作>，影响面 …） → 相关请 collab_accept {bid:"<bid>"}`；
   **同一会话对同一 bid 只注入一次**（写回 `seenBy`），未领取也不反复刷屏；
3. 当前被问询的那一个候选（`asked.sid`）额外拿到一行 `- 接管请求 <bid>：…`（同一套 `context` 注入，0 调用），
   行里写明**发起方完整 sid**（`发起方=ses_…`）与三步动作（§5.2）：可复制的 `collab_accept`、`collab_send {target:"ses_…", text:"[handoff] DONE|BLOCKED …"}` 回执、
   以及可复制的推辞写法 `collab_send {target:"ses_…", text:"DECLINE <bid> <理由>", confirm:true}`；**只有它会被问**
   （`askSeen` 去重），其余成员只看到群组广播那行；
4. **仅当被问的候选 busy > 30 分钟**时，再补发 1 条 `queue` prompt（= 同一条接管请求兼叫醒，不打断当前轮）；
5. 其余成员零调用；不做第二次补发。

> 实现细节：`busy > 30min` 同时扣 10 分（见 §5.1），所以能被叫醒的 top-1 必须是「忙但依然 ≥80」的强命中候选。

## 5. 双打分

### 5.1 匹配分 A（0–100，发起方确定性计算，0 模型调用）

| 信号 | 权重 | 来源（只读） |
| --- | --- | --- |
| 提案影响文件 ∩ 会话近期触碰文件 | 45 | `ctx.session.context`（最近 **200** 条 / **7 天**；只提取工具调用输入里的路径） |
| 提案模块词 ∩ 会话标题 | 25 | `Session.Info.title` |
| 同一任务线（Trellis task slug / issue 名） | 15 | `title` 与提案正文里的 `NN-MM-<slug>` |
| agent 匹配期望动作（implement→build，review→explore/build/plan/check） | 10 | `Session.Info.agent` |
| 最近活跃 ≤2h | 5 | `time.updated`（线性衰减） |

规则：A ≥ **80** 才问询；同分取更新者；busy > 30min 扣 10 分。`collab_broadcast` 的预览与结果都会打印
`why=[file:…, title:…, task:…, agent:build, recent:…m, busy:-10(…m)]`，可人工复核。

- 影响文件从提案正文里的路径 token 提取（`packages/…/x.ts` 之类）；提案文件名里的 `fix`/`bugs`/`feat`/`docs`/`task`
  等噪声词不参与标题打分（所有提案都带，没有区分度）。
- 读取会话消息只提取**文件路径**用于打分，**不落盘正文**，也不写回对端；会话路径缓存 2 分钟、会话信息缓存 1 分钟。

### 5.2 承接分 B（接手方，1 个模型轮）

top-1 候选（或刚拉起的会话）收到下面这条 **接管请求**（叫醒 prompt 用的是同一条文本）。它是**动作清单**，不是分析请求：

```text
[collab-handoff] <提案标题>
提案：<路径>（工作区 <workspace>，scope=peer）
影响面：<文件列表>
期望：<implement|review>
发起方：<发起方完整 ses_…>            ← 回执/推辞都用它，不必去 collab_inbox 找
按顺序完成（三步都不要省略）：
① 领取（先做；领取即 acked）：collab_accept {bid:"<bid>", confirm:true}
② 回执（必发，二选一）: collab_send {target:"<发起方 sid>", text:"[handoff] DONE <bid> <摘要>", confirm:true}
   无法实施/判定无需处理: collab_send {target:"<发起方 sid>", text:"[handoff] BLOCKED <bid> <原因>", confirm:true}
③ 只分析、不调用工具 = 未完成：结论必须用上面的 collab_send 真正发出。
   （② 里的文字只是格式示例——复述/回显它不算回执，也不会被自动闭环。）
   没余力/不接：collab_send {target:"<发起方 sid>", text:"DECLINE <bid> <理由>", confirm:true}（5 分钟不答自动顺延下一候选）
```

- 三处文案一致：**接管请求**（`deliverAsk`：`queue` prompt / busy 叫醒）、**`context` 注入的接管请求行**、**`collab_broadcast` 结果**；
  都由同一个 `handoffActions()` 生成，`bid` 与发起方 `ses_…` 都是完整可复制的字面量。
- 拉新（`spawn`）的那条没有 `DECLINE`：没人可顺延，做不了就发 `BLOCKED`。
- 为什么写成三步：试点（`11-17-collab-hardening` 的 `research/pilot.md`，见 §10 #11）里拉起的 `explore` 会话
  把交接当「分析请求」在**自己会话里答完**，回执原文都写好了，却既没 `collab_accept` 也没 `collab_send`，
  `bid` 停在 `claimed` 只能人工关单——所以「答完就算完成」必须在文案里被显式否掉。

### 5.3 问询策略（top-1 串行 + ACCEPT/DECLINE）

记录里 `asked: { sid, at, leaseMs }` 是「**当前**向谁问询、什么时候问的」。问询行为：

| 事件 | 结果 |
| --- | --- |
| `collab_accept {bid, confirm:true}`（= ACCEPT） | 原子 claim，状态 `acked`，`asked` 清空 |
| 回一条 `DECLINE <bid> <理由>`（发给**发起方** sid） | 按 `bid` 定位该条记录：候选进 `skipped`、`attempts+1`、问下一个 ≥80 候选 |
| 回一条不带 `bid` 的 `DECLINE` | 只有当**恰好一条** open 记录在等这个会话时才生效；同时有两条及以上问询于同一会话 → 视为歧义、一条都不动 |
| `DECLINE` 里写的 `bid` 不存在 / 不是问你的那条 | 忽略，不影响其它交接 |
| 5 分钟（`300000ms`）内既没 ACCEPT 也没 DECLINE | 与 DECLINE 相同（问询租约超时） |
| 候选耗尽 或 `attempts > 3` | `expired`：只写状态、升级给人，**不 spawn**（spawn 只在「无候选 ≥80」时发生） |

> `DECLINE` 由 **发起方**插件的 inbox 事件流解析（对方只要把 `DECLINE <bid> <理由>` `collab_send` 回发起方即可）；
> 发起方 sid 已经写在接管请求里（`发起方=ses_…` + 可复制的 `collab_send {target:…}` 写法）。

`claimed`（已领取但没做完）超过租约同样 `attempts+1` / 进 `skipped` / 回 `open`：还有候选就继续问下一个，
没有就回到全员可见（任何成员都可领）。拉新（`kind=spawn`）的会话若一直没 `collab_accept`，租约到期后回到
`open` 让成员接手（`attempts+1`，超过 3 次才 `expired`）。

**例外（只读自动提取）**：`claimed`（任何 `claim.kind`：`spawn` / `accept` / `handoff`，R7）且租约过期，
**或** `acked` 且静默超 `ACKED_EXTRACT_MS`=2h（R8；`acked` 没有租约），**且触发这次刷新的会话就是该交接的发起方**
（`record.from.sid`）时，发起方先**只读**看一眼该会话**最后一条有文本的** assistant 回答
（`ctx.session.context`，向宿主请求尾部 10 条，只在这次刷新读一次，不轮询）：

| 对端最后一条有文本的回答 | 处置 |
| --- | --- |
| 显式 `[handoff] DONE\|BLOCKED <当前 bid> <摘要>`，且目标**就是本条 bid** | 直接采用，写 `receipt{note, auto:true, from:<对端 sid>}`，状态置 `done` / `blocked`，**释放 spawn lock、不 `attempts++`、不再拉新** |
| 关键词：`已实施\|已修复\|无需\|不需要\|已完成\|not needed\|already` | → `blocked`（同上） |
| 关键词：`完成\|done\|fixed` | → `done`（同上） |
| 模板回显（`<bid>`/`<摘要>`/`<原因>` 占位符）、其它 bid、`[handoff]` 行没写目标 | **不判定**（回显不是回执），走原顺延 |
| 摘要位仍残留任意 `<…>` 占位符（整行照抄 R1 命令，如 `… <摘要>", confirm:true}`、反引号包裹、`（以上是示例）`、`【<原因>】`） | **不判定**（回显不是回执），走原顺延 |
| 否定语（`未完成\|没有完成\|尚未\|无法完成\|不会发\|还没\|not done\|not yet\|haven't`…）或计划语（`完成后我会…`、`我会按…发`） | **不判定**，走原顺延（宁可人工兜底，不可误闭环） |
| 无法判定（无 assistant / 只有分析过程 / 会话已删 / 宿主报错） | 走上面的原有顺延逻辑，**绝不因为提取失败而中断提醒或抛错** |

- **只判最后一条有文本的 assistant 回答**：不跨多条拼接、也不回看更早的回答——否则「第 1 条回显模板、第 2 条说还没开始」
  会被第 1 条压过。显式 `[handoff]` 行也必须落在这一条里，且目标等于当前 `bid`。
- **只有发起方触发时才提取**：`context` 注入 / `collab_accept` / 同提案 `collab_broadcast` 都会先跑租约检查，但只有
  `actor == record.from.sid` 的那一次会读对端正文并写 `receipt`；旁观会话（同工作区或其它工作区）只走原顺延逻辑，
  不读正文、不改闭环状态。注意原顺延会让 `claimed` 回到 `open`（一次性窗口），所以自动提取只在发起方那次刷新里发生。
- 消息时间早于 `claim.at` 的忽略（避免把上一件活儿的「完成了」算到这次交接上）。
- 「分析/核对/排查/调研完成」这类**关于阅读本身**的措辞不算 `done`（先剔除该短语再判定），
  避免把「答完分析」当成「活儿干完」。
- `claim.kind` 不再限制提取：`spawn` / `accept` / `handoff` 的 `claimed` 在租约到期后都由**发起方**那次刷新
  只读提取承接方最后一条回答（S70）。
- blocked 措辞补：`回执被…拒` / `无法投递` / `改回写提案` / `回写提案` / `已自愈` / `无需改动`（R7）。
- `acked` 静默超 2h（`ACKED_EXTRACT_MS`）后同样由发起方只读收口；无结论保持 `acked` 并只打 `staleNoticedAt`（R8/S71）。
- `[protected*]` 的承接方不参与提取（不读、不改状态）。
- 摘要去空白后截断 **200 字**；只存摘要 + 来源 sid，**不落盘正文**。
- 预览（`confirm:false`）同样会先跑一次刷新，因此**也可能**落 `receipt.auto`——与既有「预览也会刷新租约」一致。

> 没有常驻进程（边界：不做守护进程）。「顺延」发生在下一次读写该 `bid` 时：`collab_broadcast`（同一提案）、
> `collab_accept` 以及任意一次 `context` 注入都会先跑一遍租约检查。
> `collab_list` 是**只读快照**：它按快照判定并标注 `lease=expired|ok`（`claimed` 看 `claim.at`，`open` 且有 `asked` 看
> `asked.at`），但**不改状态、不删锁、不推进顺延**——真正的顺延仍以上面三条路径为准。

## 6. 竞争与幂等

```jsonc
// ~/.config/opencode/collab-broadcast/<bid>.json
{
  "bid": "b_<hash16>",                // hash(scope + workspace + issuePath + 内容 hash + mtime)
  "scope": "local|peer",
  "workspace": "/data/project/muke-interface",
  "issuePath": "docs/issues/fix-x.md",
  "title": "…",
  "expected": "implement|review",
  "affectedFiles": ["packages/state/src/machine/worker/store.ts"],
  "candidates": [{ "sid": "ses_…", "score": 91, "why": ["file:…", "title:worker"] }],
  "state": "open|claimed|acked|done|blocked|expired",
  "claim": { "by": "ses_…", "kind": "accept|spawn|handoff", "token": "k_…", "at": 0, "leaseMs": 300000 },
  "asked": { "sid": "ses_…", "at": 0, "leaseMs": 300000 },   // 当前问询的候选 + 问询租约（§5.3）
  "attempts": 0,
  "skipped": ["ses_…"],                // 已问过 / DECLINE / 领了不干：不再问询
  "declines": [{ "sid": "ses_…", "at": 0 }], // DECLINE 与问询超时的审计流水
  "seenBy": ["ses_…"],                // 群组广播注入去重（每会话每 bid 一次）
  "askSeen": ["ses_…"],               // 接管请求注入去重（每会话每 bid 一次）
  "reminded": ["ses_…"],              // SessionStart 提醒去重（每会话每 bid 一次）
  "replies": [],
  "from": { "sid": "ses_…", "directory": "/abs/path" },
  "receipt": { "from": "ses_…", "at": 0, "note": "…" }, // 手动回执无 auto 字段；auto:true = 租约到期只读提取（§5.3）
  "autoVerdictAt": 0                  // 仅在自动提取闭环时写入
}
```

- **原子领取**：`open(<bid>.lock, 'wx')` 成功者赢得 claim；失败者读到持有者并返回「已被 `ses_x` 领取」，**不重复拉新**。
- **租约**：见 §5.3；过期时删掉旧的 lock（只删持有者匹配的那把），再允许下一位领取。拉新（spawn）的 lock 由
  发起方持有、写 claim 后补记 `claimBy=<新会话>`；释放时 `by` / `claimBy` 任一命中即删（否则 spawn 的 lock 永不放）。
- **幂等**：`bid` 由提案内容 + mtime 决定；同一提案重复广播返回「已存在同一内容」且不新建文件；改了提案内容 = 新 `bid`。
  `local` scope 的 `collab_handoff` 同 `(target, text)` 也是同一 `bid`：重复调用直接返回「已存在 / 已闭环」，**不重投、不复活**。
- **写入**：`tmp 文件 + rename` 原子替换，禁止原地改写。
- **只读快照**：`collab_list` 不改状态、不删锁，只按快照标注 `lease=expired|ok`（见 §5.3）；要推进顺延请用
  `collab_accept` / 同一提案的 `collab_broadcast` / 一次 `context` 注入。
- **保留与清理**：只在**写入**（`writeBroadcast`）时顺带清理 `done` / `blocked` / `expired` 且 `updatedAt` 超过
  **7 天**（`BCAST_RETENTION_MS`）的记录；`open` / `claimed` / `acked` 一律不动（仍是谁的活儿）。单次写入最多删
  **20** 个（`BCAST_PRUNE_LIMIT`），积压会分摊到后续几次写入；被删记录的 `<bid>.lock` 一并清掉，避免残留锁
  毒化同一内容的重播。`collab_list` 不删文件；`collab_accept confirm:false` 属于「预览但会刷新」——它先做一次
  租约刷新与保留清理（可能删掉逾期的 `done`/`expired` 文件），但**不领取、不投递**。
- **状态语义**：`accept` 领取后直接 `acked`（领取即确认收到）；`spawn` 拉起的新会话先 `claimed`，它自己 `collab_accept`
  后转 `acked`（并记 `ackedAt`）；`acked` 只等回执（不再被抢），超时只提醒发起方。
- **自动闭环**：`spawn` 的 `claimed` 租约到期且对端会话里有结论（§5.3）→ 发起方在**自己触发**的那次刷新里写入 `receipt{auto:true}`
  并置 `done` / `blocked`，同时释放 spawn lock；这是**唯一**不经过 `collab_send` 的闭环路径，仍然只读、只存摘要。
  已闭环（`done` / `blocked`）的记录不再给发起方发「交接未闭环」提醒；`expired` 仍提醒（需人接手）。

## 7. 无可用会话时拉新

```text
collab_broadcast { workspace: "<对端绝对路径>", issuePath: "docs/issues/fix-x.md", confirm: true }
  → 无候选 ≥80 → claim(kind=spawn) → ctx.session.create({ title: "impl:<slug>", agent: "explore", location: { directory: <workspace> } })
```

- `location.directory` 必须带；**宿主不回 `location` 也算落点不明**（会话可能落在 `/root`、插件不加载）→
  删除刚建的那个会话并报错，绝不把「未知落点」记成已投递；
- 默认 `explore`（只读）；建 `build` 必须**每次显式**传 `agentConfirm:true`（无白名单、无静默升级）；
- 标题固定 `impl:<slug>`；**不删除**任何会话（除落点校验失败时回滚刚建的那一个）；`collab_list` 标 `[bootstrap]`；
- 并发两次广播只建**一个**会话（同一把 lock，输家返回「未拉新：bid 已被 … 领取」）。
- **会话级权限补丁（R1，实测必需）**：`opencode.json` 的 `agents.explore|plan.permissions` 是**项目级**的——
  只对**本仓**会话生效，对端工作区的 explore 一个 `collab_*` 都没有，所以它即使收到接管请求也**调不动**
  `collab_accept` / `collab_send`。因此拉新成功后立刻 `PATCH /api/session/{sid}`（`ctx.session.update`）
  把 5 条 `collab_*` allow 写进**新会话自身**的 `permissions`：
  - 先 `GET` 现有 `permissions` → `mergeRules` 去重（按 `action + resource`，保留原顺序与原规则，**不覆盖**）→ 再 PATCH；
  - 只加 `collab_list / collab_inbox / collab_wait / collab_reply / collab_send`，白名单之外（`edit`/`write`/`shell`…）
    一律拒绝；`explore` 仍然只读；
  - 记录 `~/.config/opencode/collab-grants/<sid>.json`（`{sid, before, added, at, by, reason:"spawn"}`），
    同一会话重复 spawn/grant 幂等、不累积，`before` 保留**首次**快照供 `revoke` 整集还原；
  - 失败（403/404/宿主无 `ctx.session.update`）**不阻断交接**：广播记录标 `permissionGrant:"failed"`，
    回执退化为「租约到期只读提取结论并自动闭环」。
- **既有会话（非本次拉新）默认一个字节都不改**；需要时显式 `collab_grant { target, confirm:true }`
  （`revoke:true` 用 `before` 快照整集还原并删除记录；目标为 `[protected*]` 直接拒绝）。
- **spawn 只自动 grant，不自动 promote**（R7）：拉起的会话始终是 `explore`（只读）。要它真正改代码，
  必须在它 `collab_accept` 之后、由发起方显式 `collab_promote` 切到 `build`（白名单 `build`/`plan`，
  记录 `agentBefore`；`revert:true` 切回原值）。`expected:"review"` 的交接只需要判定，**永不 promote**——
  升级执行能力是「改代码」场景的专用动作，不是交接的默认步骤。

## 8. 执行与回执

- 接手方自主实施；`scope:"peer"` 时严格只读 + 仅提案（提案状态由目标仓 owner 更新）。
- 完成后回执（`collab_send` 给发起方，`confirm:true`）：

```text
[handoff] DONE <bid 或 提案路径 或 thread> <commit sha 或摘要>
[handoff] BLOCKED <同上> <原因>
```

- **匹配规则**：`bid` / 完整 `issuePath`（`docs/issues/xxx.md`）/ `threadID` 三者之一，**裸文件名不算**
  （两个仓都可能有 `docs/issues/fix-x.md`，按 basename 匹配会关错交接）；
- **只有承接方能闭环**：`receipt.from` 必须等于记录的 `claim.by`，第三方写一行 DONE 不会改状态；
- 发起方插件的 inbox 事件流解析状态行 → 更新 `bid.state`（`done` / `blocked`）并记 `receipt`；
- 对端**没有发**回执时，发起方自己那次刷新只读提取它自己会话里的结论并自动闭环（`receipt.auto = true`）：
  `claimed` 走租约到期，`acked` 走静默超 2h（`acked` **没有租约**，别混用）；
- 解析失败（无状态行 / 不是承接方 / 提取不出结论）→ 只留在 `collab_inbox` 或走原顺延，不改状态；
- 发起方 `context` hook（会话下一次模型请求时，等价 SessionStart）列出未闭环 handoff（`claimed/acked` 超租约或 `expired`），
  **只提醒一次**（`reminded`），不重投。

## 9. 护栏

| 项 | 规则 |
| --- | --- |
| 写 | `peer` 只允许目标仓 `docs/issues/**`；`local` 按本仓正常权限 |
| git | 跨仓只读（log/show/diff/status/blame/ls-files）；禁止 add/commit/push/pull/fetch/checkout/reset/stash/merge/rebase/tag |
| 会话 | 不向 `[protected]` / `[protected-child]` 投递（唯一例外 = 限界 reply：`kind=reply` + 该 bid 的发起方 + 该单领取人，强制 `queue`）；`collab_accept` 拒绝 [protected] / [protected-child] 领取（领取者自身或其祖先命中 protect 即报错，子代理不能替受保护线代领）；不删会话（落点校验失败时只回滚自己刚建的那个）；不 `interrupt`；`collab_accept` 拒绝**明确属于其它工作区**的会话（`location.directory` 不符时直接报错） |
| 权限 | 只允许给**单个会话**追加 5 条 `collab_*` allow（`collab_grant` 与 spawn 自动授权共用同一份白名单，fail-closed）；不授予 `edit`/`write`/`shell`；不自动改非自建会话；`[protected*]` 目标直接拒绝；`revoke` 只能还原本工具记录的 `before` 快照（不动快照外的改动） |
| agent | `collab_promote` 只切到白名单 `build` / `plan`（默认 `build`，`explore` 不自动升级）；不改非显式指定的会话；`[protected*]` 拒绝；`revert` 只能按记录切回 `agentBefore`；spawn 永不自动 promote；`expected:"review"` 的交接永不 promote |
| 投递 | 默认 `queue`；跨仓不要 `steer` |
| 成本 | 一次交接 = 1 次广播（0 调用）+ 最多 1 次叫醒 + 执行轮 |
| 隐私 | 读取会话 messages 只提取文件路径用于打分、只取最后一条 assistant 回答用于「结论判定」；两种情况都**不落盘正文**（结论摘要 ≤200 字 + 来源 sid） |

## 10. 已知偏差

| # | 事项 | 现状 |
| --- | --- | --- |
| 1 | 跨 location thread 不可见 | 设计如此；跨仓一律消息闭环 |
| 2 | `docs/agents/issue-tracker.md` 说「Issue 走 GitHub issues」，与本仓 `docs/issues/*.md` 实践不一致 | 待统一 |
| 3 | 全局 shim 需手动装到 `~/.config/opencode/plugins/` | 一次性动作，机器本地；重建方法见 §12 |
| 4 | 新工具（`collab_broadcast` / `collab_accept` / `collab_handoff`）未进 `agents.explore|plan` 的 permissions allow 列表 | 只读 agent 目前只能通过 Code Mode（`tools.collab_accept(...)`）调用；要给它们直调权限需在根 `opencode.json` 的 `agents.*.permissions` 追加 3 条 `allow`（本任务不改 `opencode.json`） |
| 5 | 匹配分的数据源是 `ctx.session.context`（最后一次 compaction 之后的消息） | 在本机等价于「近期消息」；未接 `/api/session/{id}/message?limit=200`（插件 ctx 未暴露该端点）。200 条 / 7 天窗口在其上再过滤 |
| 6 | 叫醒与接管请求是同一条 prompt | 只投给被问询的候选且 `busy > 30min`；空闲 top-1 只靠 `context` 注入（0 调用）。固定为「最多 1 次」 |
| 7 | 会话没有 `location.directory` 时无法校验工作区归属 | `collab_accept` 只加注不拒绝（宿主老版本可能不返回该字段）；正常宿主都会返回 |
| 8 | 匹配只在最近活跃的前 20 个根会话里打分（`SCORE_CANDIDATE_LIMIT`） | 极忙的工作区里第 21 个完美候选不会被问到；可调大该常量 |
| 9 | `collab_list` 的租约判定是只读快照 | 列表会标注 `lease=expired` / `lease=ok`（`claimed` 看 `claim.at`，`open`+`asked` 看 `asked.at`），但**不改状态、不删锁、不推进顺延**（S41）；`state/attempts` 仍以 `collab_accept` 读到的最新值为准 |
| 10 | 广播目录的自动清理是「写入时顺带」 | `done` / `blocked` / `expired` 且 `updatedAt` 超过 **7 天**的记录在下次写入时删除，单次最多 **20** 个（`BCAST_RETENTION_MS` / `BCAST_PRUNE_LIMIT`）；`collab_list` 不删文件，`collab_accept confirm:false` 会先刷新再清理（不领取、不投递）；长期不写入的目录不会自行收缩，需要时手工删（S42） |
| 11 | 对端会话可能「答完就算」，不调协作工具 | 试点实测（`11-17-collab-hardening/research/pilot.md`，G1）：拉起的 `explore` 会话把交接当分析请求，回执原文写好却没发，`bid` 停在 `claimed`。处置：① 接管请求 / 叫醒 / 广播结果统一写成「① 领取 → ② 回执 → ③ 只分析 = 未完成」的可复制命令（S44）；② `spawn` 的 `claimed` 租约到期时只读提取对端结论并在能判定时自动闭环（S45–S49）；③ 判定不出来就保持原顺延，**不猜**（S47/S48）。提取依赖 `ctx.session.context`（同 #5），只判**最后一条有文本的** assistant 回答；`[handoff]` 行必须点名当前 `bid`（占位符/其它 bid/无目标一律不认），否定语与计划语一律不判定；只有发起方（`record.from.sid`）触发的刷新才允许闭环，旁观会话只走原顺延（S51/S52） |
| 12 | 「对端 explore 看不到 `collab_*` 工具」的**另一半**根因是权限作用域，不是模型/插件 | 项目级 `agents.*.permissions` 只覆盖本仓会话：`muke-pos-app` 的 explore 有 5 条，`muke-interface` 的 explore 一条都没有 → 拉起的对端 explore 拿到接管请求也调不动工具。修法是**会话级 `PATCH permissions`**（spawn 后自动 + `collab_grant`），不是改 agent、不是改全局配置（S54–S60）。副作用与限制：`permissions` 是**整集替换**（必须先 GET 合并）；宿主无 `ctx.session.update` 时只能靠 `COLLAB_SERVER_URL` 显式配置的 HTTP fallback；删 `~/.config/opencode/collab-grants/` 只是丢掉还原凭据，**不会**撤回已写进会话的权限（要撤回必须 `collab_grant {revoke:true}`） |
| 13 | 「有回执能力」≠「能改代码」：grant 后 explore 仍然只读 | `collab_grant` 只给 5 个 `collab_*` 动作，`edit`/`write`/`shell` 一律不授予（S58/S60 断言）。真要让对端改代码必须显式 `collab_promote`（`POST /api/session/{id}/agent`，白名单 `build`/`plan`，记录 `agentBefore`，S61–S67）。**分工**：`grant` = 回执能力；`promote` = 执行能力，且只在对端 ACCEPT 后用；`expected:"review"` 的交接永不 promote（review 只需判定）。`PATCH /api/session` 不接受 `agent` 字段，切 agent 必须走独立的 `/agent` 端点 |

> 「`bid` 含 mtime」与 AC 措辞（「同一内容不产生第二条 bid」）的差异：同一内容被 `touch`/`git checkout`
> 改了 mtime 会产生第二个 `bid`，与 design §2 一致；判幂等请按「同一内容 + 同一 mtime」理解。

## 11. 验收清单

- [x] 群组成员枚举正确，未打扰 `[protected*]`（harness S23 / S30）
- [x] 匹配分有 `why` 明细，可解释（S23）
- [x] ≥80 只问 top-1（`asked`，串行）；`DECLINE` 顺延；问询租约 5 分钟超时同样顺延（S33 / S34）
- [x] 候选耗尽 / `attempts > 3` → `expired`，且**不 spawn**（S34）
- [x] 并发下只有一个 winner（原子 claim；accept 领取后直接 `acked`，S25）
- [x] spawn 的新会话自己 `collab_accept` → `claimed` 转 `acked`（S31）
- [x] spawn 的 lock 租约过期后按 `claimBy` 释放，成员可接手（S32）
- [x] 重复广播不新建（`bid` 幂等，S26）；`collab_handoff` 重复调用不重投、不复活已闭环（S35）
- [x] 拉新默认 explore；build 每次显式确认；宿主不回 `location` 时回滚刚建的会话（S27 / S37）
- [x] 回执只认 `bid` / 完整 `issuePath` / thread，且只有承接方能闭环（S28 / S30c / S36）
- [x] 软链提案被拒绝（S38）
- [x] `peer` scope 全程未对目标仓做 git 写操作：插件不含任何 git 调用；`/tmp/collab-sandbox` 实测里 b 仓的两个 commit
      是**人工**建的基线（用来固定提案 mtime / 复核 bid），工具只写 `docs/issues/*.md` 与全局广播目录
- [x] 未闭环交接只提醒一次（S30）
- [x] `collab_accept` 拒绝受保护会话及其子会话领取（S39）
- [x] 接管请求写明发起方完整 sid；`DECLINE <bid>` 按 bid 定位，不带 bid 的多问询歧义不误伤（S40）
- [x] `collab_list` 标注 `lease=expired|ok` 且只读（不改状态、不删锁，S41）
- [x] 广播目录按 7 天保留 + 单次 ≤20 清理，`open/claimed/acked` 不动（S42）
- [x] 接管请求 / 叫醒 prompt / 广播结果三处都含「① 领取 → ② 回执 → ③ 只分析 = 未完成」，命令含完整 `bid` 与发起方 sid（S44）
- [x] `spawn` 的 `claimed` 租约到期 + 对端有 `[handoff] BLOCKED` → 自动 `blocked` + `receipt.auto`，**不 spawn、不 `attempts++`、释放 lock**（S45）
- [x] 关键词兜底：`已实施/无需` → `blocked`，`完成` → `done`；已闭环不再提醒发起方（S46）
- [x] 到期但无结论 → 原顺延（`attempts+1` / `skipped`），可被成员接手（S47）
- [x] 对端会话 404 / 无 assistant 文本 → 不抛错、走原逻辑（S48）
- [x] 摘要 ≤200 字、去 bid、不落盘正文（S49）
- [x] 未到期 / `kind=accept` / `[protected*]` 承接方都不做提取（S50）
- [x] 回显模板（`<bid>`/`<摘要>` 占位、本 bid 写在「我会发…」里）、其它 bid、否定语（未完成/无法完成/not done yet）都不闭环；
      真 `[handoff] DONE|BLOCKED <当前 bid>` 才闭环；只判最后一条有文本的回答（S51）
- [x] 只有发起方（`record.from.sid`）触发刷新才读对端并闭环；同工作区旁观会话 / 其它工作区会话只走原顺延（S52）
- [x] 整行照抄 R1 命令（摘要位残留 `", confirm:true}` / 反引号 / `（以上是示例）` / `【<原因>】`）**不闭环**；
      真 `[handoff] DONE <当前 bid> 修好了` 仍闭环（S53）
- [x] spawn 成功后新会话自身 `permissions` 恰好 5 条 `collab_*` allow（`read` 回读，S54）；广播记录标 `permissionGrant=granted`，
      台账 `before=[]` / `reason=spawn`（S54）
- [x] 未 spawn / 未 grant 的会话不被隐式修改（S55）
- [x] `collab_grant` 合并而非覆盖：原有 `read`/`grep` 保留、原有 `collab_list=deny` 不被放宽为 allow，只补 4 条缺失（S56）
- [x] 重复 grant 幂等（无第二次 PATCH、`changed=false`、`before` 不变）；`revoke` 往返与快照逐字一致并删除记录，
      再 `revoke` 返回「无可还原」而不抛错（S57）
- [x] 白名单 fail-closed：`edit`/`write`/`shell`/`collab_broadcast` 与 `effect:"deny"` 一律拒绝（S58）
- [x] `[protected]` 与其子会话拒绝授权，且不写 PATCH / 台账（S59）
- [x] PATCH 被拒（403）时 `collab_grant` 只报可读原因、不改权限；spawn 自动授权失败仍照常创建会话 + 投递接管请求，
      记录 `permissionGrant:"failed"`（S60）
- [x] `collab_promote` 预览不调用（S61）；confirm 后 `explore → build` 且 GET 复核一致，记录 `agentBefore/promotedAt/promotedBy`
      且不动 permissions（S62）；重复 promote 同 agent 为 no-op、`agentBefore` 保持首次值（S62）
- [x] grant 与 promote **共用一份台账互不覆盖**：grant 后 `agentBefore` 仍在；`revoke` 只清 permissions 半段、保留 promote 半段（S63）
- [x] `revert` 切回记录里的原 agent 并删除 promote 半段（S64）；无记录时返回「无可还原」且不改会话（S66）
- [x] agent 白名单 `build`/`plan`；非白名单直接拒绝且不切换（S65）；spawn 只 grant **不** promote（S54）
- [x] `[protected]` / `[protected-child]` 拒绝 promote 且不写记录；宿主拒绝切换（403）只报可读原因（S67）
- [x] `expected:"review"` 的交接永不 promote（文档约定 + spawn 不自动 promote）
- [x] `docs/development.md` 的 harness 计数以脚本实际输出为准（当前 274）

回归门（无模型调用 = 无网络、无 `node_modules`、~1s）：

```bash
pnpm test:collab                                  # = node scripts/collab/handoff-harness.mjs，274 checks，全绿退出 0
node scripts/collab/handoff-harness.mjs           # 同上，直跑
node --check .opencode/plugins/collab.js
```

CI 门禁：`.github/workflows/collab.yml`（`ubuntu-latest` + `actions/setup-node`，**不跑 `pnpm install`**——本仓 CI
全新 checkout 装不上依赖，见 `AGENTS.md`），只跑上面两条 `node` 命令。

## 12. 全局 shim（机器本地，一次性）

`~/.config/opencode/plugins/collab-global.js` 只在**目标工作区没有项目副本**时动态 `import` 本仓实现，
因此其它工作区的会话也拿得到 `collab_*` 工具；项目自带 `.opencode/plugins/collab.js` 时它静默让路
（否则会 `Duplicate plugin ID: collab`）。

```js
// ~/.config/opencode/plugins/collab-global.js（要点）
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
const IMPL = "/data/project/muke-pos-app/.opencode/plugins/collab.js"
export default {
  id: "collab-global",
  async setup(ctx) {
    const directory = ctx?.location?.directory
    if (directory && existsSync(join(directory, ".opencode", "plugins", "collab.js"))) return
    if (!existsSync(IMPL)) return
    const mod = await import(pathToFileURL(IMPL).href)
    return mod.default.setup(ctx)
  },
}
```

校验（两处都应是 `active`，无 `failed`）：

```bash
opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"                            # collab + collab-global(静默)
opencode api get "/api/plugin?location%5Bdirectory%5D=/data/project/muke-interface"    # collab-global
```

## 对接人（`origin`）与「谁能闭环一单」

- 转发链 A→B→C：B 写记录时 `from=B`，真正的链头放 `origin`（`collab_handoff/broadcast` 接受 `origin`；
  未显式给时**一层继承** B 作为承接方那条未闭环单的 `origin ?? from`）。
- 记录 `origin.sid === from.sid` 时**不落盘、不渲染**（保证单跳交接与旧版逐字一致）。
- **回执可发给两个人**：本单发起方（`from.sid`）或对接人（`origin.sid`）。发给第三方仍是 `kind=request`，不会闭环。
- **受保护白名单没有因此放宽**：能否向 `[protected*]` 投递，仍只看 `target === from.sid`
  且发送者是领取人；`origin` 只影响「kind 改写」，不影响放行。

## 结构化 BLOCKED（`blocked`）

- 可选字段：`blocked { need[], excluded[], minimalTest }`（need ≤10、excluded ≤20、单条 ≤120 字、minimalTest ≤200 字）；
  超限**可读拒绝**（0 投递 0 写入），不静默截断。
- 三处渲染：投递正文（协议头之前）、承接方注入（`takeoverBody`，spawn/叫醒/重发）、`collab_status`（最新一次 + 历史次数）。
- 落库条件**全部满足**才写：解析出 `bid`、`confirm:true`、记录存在、**调用方是参与方**（`from`/`claim.by`/`asked`/`origin`，
  唯一实现 `canWriteBlocked`）；否则只上正文并注明未落库。保留最近 3 次。
- 预览（`confirm:false`）与「同文去重命中（未投递）」**都不写**——否则会污染记录或白占最近 3 次名额。

## 契约决策记录（`decisions`）

- `collab_decisions { bid, items:[{id,decision,rationale?}] }`：每单上限 **20**、每次 1–10 条、**按 `id` 覆盖**
  （`at/by` 取本次）；`id` ≤40、`decision` ≤200、`rationale` ≤400。
- 权限**仅**本单发起方（`from.sid`）或承接方（`claim.by`）；`asked`/`origin`/第三方一律拒绝且 0 写入（比 `blocked` 更严）。
- 只写展示字段：不投递、不改 `state/claim/receipt/replies`；预览不写。
- 展示：`collab_status` 最近 3 条；承接方注入只加一行计数；`collab_list` 行尾 `decisions=N`。
- 已知低风险：id 若含天文面字符（emoji），「按码点校验 / 按 UTF-16 截断」不一致会让覆盖失效（既有 `truncate` 约定，非本功能引入）。

## 入站注入头（0.8.0）

`[<发出方会话标题>][collab:ses_…][<kind>:<threadID>] <正文>`

- 名称在前；`[collab:ses_…]` 与 `[kind:thread]` 是**机读字段**，位置与内容不得变（`parseEnvelope().from` 仍取 sid）；
- 标题 `truncate(20)`、`]` 替换为 `）`（裸 `]` 会让信封正则提前闭合）、空白折叠；
- 取不到标题（宿主抛错/无标题/空串）→ **与无名称格式逐字一致**；失败**不缓存**，下轮重试；
- 标题按 sid 缓存 10 分钟（同会话两轮只查一次宿主）；
- 例外：`[ack]` 机器噪声与 `collab-report` 伪发送方不带名称。
