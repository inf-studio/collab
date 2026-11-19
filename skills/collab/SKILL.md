---
name: collab
description: 当需要在 OpenCode 会话之间派活或交接时使用——同一工作区的多个会话互相接手，或跨工作区（如 muke-interface / std-ui）把提案交给对端实施。覆盖 collab_* 二十二个工具的选路、交接包模板、匹配分与原子领取、会话级权限补丁与 agent 升降级、protected 护栏、送达确认（admitted/seen）与受限重发、即时状态回执（collab_status，只读非阻塞）、thread 聚合（collab_threads，列一个 target 的全部未闭环 thread）、加急催办（collab_escalate，delivery=steer）、临时冻结（collab_freeze，会话/工作区/一单，可逆可过期）、自动感知提示（context 尾部一行「本工作区候选 N · 其它工作区候选 M」+ 承接方两行协议头）、交接对接人（origin，转发链不再丢链头）、结构化 BLOCKED（blocked：需要对方/已排除/最小判别）、契约决策记录（collab_decisions：退出码/事件型/断言口径这类决定写进交接记录，只读可拉取）、闭环后追加（collab_followup + 提案文件）、受保护目标请求队列（collab_request_owner）、spawn 会话自动归档（collab_archive，归档≠删除）、缺陷自上报与挂起监控（collab_report / collab-triage）、以及常见排障（npm scope 大小写、location.directory、allowWrite、热重载、重复插件 id）。
---

# collab：会话间派活与交接

## 何时用

- 同一工作区有两个以上会话，需要把一件事交给**另一个会话**（而不是自己做）。
- 跨工作区需要对方改代码/确认，且已经/准备写对方 `docs/issues/` 提案。
- 你**不确定**该由谁处理，希望按匹配分自动选人。

## 何时不用

- 只是告诉用户结论、或当前会话自己能做完——直接做。
- 只是想留长期记录：用 `trellis channel`。
- 对方工作区没有会话、且你没法确认要不要新建：先问用户，不要静默拉起。

## 一、工具速查

| 工具 | 入参要点 | 作用 | 性质 |
| --- | --- | --- | --- |
| `collab_list` | `limit?`, `directory?` | 列会话（id/agent/state/`loc=`/`parent=`/title）+ 未闭环交接 | 只读 |
| `collab_inbox` | `limit?` | 本会话收到的跨会话消息全文 | 只读 |
| `collab_wait` | `threadID?` / `target?`, `timeoutMs?` | 等某 thread 的回执，或等某会话空闲 | 只读 |
| `collab_status` | `bid?` / `threadID?` / `session?` | **一单现在到哪一步**（state / 承接+剩余租约 / 投递 / 队列位置 / 最近回复 / 下一步）；非阻塞、零写入；protected 目标给 `canPush:false`；**消息 thread 降级**为 `kind=messages` + 出入站摘要（不再报错）；承接方报过结构化 BLOCKED 时多三行「需要对方 / 已排除 / 最小判别」；有契约决策时多一段 `决策 N 条` + 最近 3 条 | 只读 |
| `collab_threads` | `target`, `includeClosed?` | **与一个 target 的全部 thread**：threadID / kind（handoff\|messages）/ 状态 / 最近出入站摘要 / 唯一「← 建议继续」；默认只列未闭环，≤20 条 | 只读 |
| `collab_escalate` | `bid?` / `threadID?` / `session?`, `reason`, `mode?`, `confirm` | **加急**：默认 `delivery:steer` 进对方当前轮；只读 agent → `queue(forced)`；受保护目标 → 0 投递 + urgent 队列项；回执打印**实际** delivery | 发消息 / 写队列 |
| `collab_freeze` | `scope`(`session`/`workspace`/`bid`), `target?`, `reason`, `until?`, `freeze?`, `confirm` | **临时冻结**：对它的**新建**协作（handoff/broadcast/accept/escalate）可读拒绝，`until` 到期自动失效；通知一次；`freeze:false` 解冻；读取类只标 `[frozen]` | 写本地冻结文件 + 通知 |
| `collab_send` | `target, text, kind?, threadID?, mode?, origin?, force?, blocked?, confirm` | 投递消息；`kind=request/reply/note`；`origin?` 在正文首行写对接人（0.7.0）；`force?` 跳过正文去重（回执标 `dedupeOverridden`）；`blocked?` 结构化 BLOCKED（0.7.0，见一点八·再补） | 发消息 |
| `collab_reply` | `threadID, text, force?, confirm` | 回执糖，target 由 thread 解析；`force?` 同上 | 发消息 |
| `collab_handoff` | `target?, text, expected?, origin?, blocked?, confirm` | **同工作区**交接：选人 + 开 thread；`origin?` = 转发链起点（缺省继承）；`blocked?` = 把「卡住了」的结构化三段一起交给下一跳 | 发消息 |
| `collab_broadcast` | `workspace, issuePath, expected?, agent?, agentConfirm?, origin?, confirm` | **跨工作区**交接：读提案 → 打分 → 全局交接文件 → 问 top-1 / 必要时拉新 | 发消息 + 可能建会话 |
| `collab_request_owner` | `target?, text?, issuePath?, id?, revoke?, confirm` | **受保护目标请求队列**：只写队列文件（非保护 → 受保护），0 投递 | 写本地队列（旁路） |
| `collab_accept` | `bid, confirm` | 原子领取广播（只有一个 winner） | 写交接记录 |
| `collab_grant` | `target, revoke?, confirm` | 给**一个会话**加 5 条 `collab_*` 会话级权限 | 写会话权限 |
| `collab_promote` | `target, agent?, revert?, confirm` | 把会话 agent 切 `build`/`plan` | 写会话 agent |
| `collab_followup` | `bid, issuePath?, confirm` | **闭环后追加**：只登记结构化指针（不投递、不改 state） | 写交接记录（本单领取人） |
| `collab_decisions` | `bid`, `items`（1–10 条 `{id, decision, rationale?}`）, `confirm` | **契约决策记录**（0.7.0）：把「退出码 2→3 / `room:order` 纯事件型 / 断言只看末帧」写进记录 `decisions[]`；**只有本单发起方/承接方能写**；同一 `id` 再写 = 覆盖，每单 ≤20 条；不投递、不改 state/claim/receipt/replies | 写交接记录（本单两方） |
| `collab_report` | `note?, bid?, threadID?, confirm` | 上报疑似插件缺陷（证据脱敏落盘 + 可投递维护方） | 写本地证据（旁路） |
| `collab_archive` | `bid?` / `session?`, `restore?`, `confirm` | **归档 ≠ 删除**：把 spawn 会话藏起来（`PATCH {archived:true}`，消息全留），`restore:true` 恢复；交接终态 10 分钟后自动归档 | 写会话归档位 |

默认值：`kind=request`、`mode=queue`（不打断）、匹配分门槛 **80**、租约 **5 分钟**、`attempts>3` 转 `expired`。
`expected` 三值：`implement`（默认，改代码）/ `review`（确认）/ **`research`**（只读排查 + 结论，对 `build` 也合法）。
承接方是只读 agent 却传 `implement` 时，结果会提示能力不匹配（建议 `research` 或先 `promote`）。
`confirm:true` 才真正执行；否则只预览。

> 资源租约（`collab_lock` / `collab_unlock` / `collab_locks`）的规程在同工作区 skill
> `collab-coordination`；需要看**全局**（谁持有/谁排队/哪些交接未闭环）时打开 OpenCode Desktop
> 侧栏的 `collab` 面板（0.3.0 起，只读，与 `collab_locks` 同一数据源）。0.6.0 起 GUI 与 TUI 共用同一份
> `buildBoard` 派生：工作区 → 会话（徽标 `🔒n`/`‹m›`/`[archived]`/`[frozen]`/`[urgent]`，点击展开）→
> `↳` 它拉起的会话 + 该会话的锁/交接/队列；`已归档 N` 默认折叠，看板本身仍然零写操作。
>
> 入口（0.5.1，全部只读）：Desktop 用命令面板的 `collab.open` / `mod+shift+l` / `/collab`，或点会话头部的
> 计数条；TUI 用 `/collab`（`ctrl+shift+l`），或点侧栏摘要行展开明细、再点明细行开面板。
>
> 0.6.0 计数口径（GUI 会话头 = `持有 N · 排队 M · 待受保护 K · 宿主排队 J`，TUI 侧栏紧凑写成
> `锁 N · 排 M · 待 K · 宿 J`）：**持有**只数真正有持有者的资源（排队者不算，`free 但有 waiter` 也不算
> 被占用）；**排队**是各资源 FIFO 人数之和（可能全是 `[stale]` 过期心跳，不占位）；**待受保护**是本会话提交给
> 受保护目标的请求；**宿主排队**是宿主自己的 prompt 队列。看 `collab_locks` 时同理：`free` + `waiters=…`
> 不是被占用。
>
> 0.5.2 探针：Desktop 标题栏常驻一个 **`collab` pill**（无数据时就是 `collab`，有数据 `collab N`）。
> 有会话时点它开面板；**没有会话时点它会弹「Collab GUI 已加载」toast**——看到 toast 就说明这个窗口确实
> 加载了本插件的 GUI（面板打不开只是当前没有路由会话），看不到就说明没加载。
>
> 0.5.3 数据源：GUI 的 snapshot 走**当前会话所属服务器**（`ctx.sessions.current()?.server?.client`，
> 缺失回退 `ctx.client`），所以打开远端会话时看到的是**远端**的租约/队列；面板顶部 `@<server.id>` 与
> toast 的 `server=` 标明数据源。桌面端 GUI 宿主**只加载本机 sidecar**（0.5.3 已用桌面端源码确认），
> 因此**插件要装在本机**（`opencode plugin add @inf-studio/collab@0.5.3` + 重启 app）；本机没装时远端
> 窗口仍然「无 GUI」，这是平台行为，**不要据此断定平台缺陷**（见 `docs/collab.md` §11.11.4–§11.11.5）。

## 一点五、送达与闭环后追加（0.1.6）

**两级 ack**：`admitted` = 宿主收下（`prompt` 返回 `message.id`，或接管请求写进记录）；`seen` = 收方插件把它
送到模型面前（`context` 注入 / `collab_inbox` 读到 → 回 `[ack] <cid> seen`）。`collab_list` / `collab_wait`
显示 `admitted= / seen= / queue-age= / resend= / unacked=`。

- `seen=-` **不等于**「没送到」：目标 busy 时它只是还没开下一轮；busy 目标**永不重发**。
- 只会补投 **1 次**（admission 失败，或 2h 无 `seen` 且目标当时 idle），同 `cid` 幂等。
- `unacked=yes` = 预算用满 + 窗口已过仍无 ack → 人工补投；受保护发起方恒为 `seen=n/a`（`ackUnavailable`）。
- **正文去重（0.6.0；0.7.0 增 target 维度）**：同一 **target 会话**（或同一 thread）里，归一化后（空白折叠）
  完全一致的正文在 `dedupeWindowMs`（默认 60s）内只投递一次——同一条结论发到同一会话的 3 个 thread 也只投 1 次；
  重复时返回「未重复投递…已在 thread `t_…` 发过同文」，**不投递、不追加 thread 消息、不改记录**。
  真要再发：传 `force:true`（照常投递并标注 `dedupeOverridden`，带 `bid` 时记录标 `dedupeOverriddenAt`，
  `state`/`claim`/`receipt` 不变）或把 `dedupeWindowMs` 设为 0 关闭。预览（`confirm:false`）不受影响。

**闭环后追加（pull，不是 push）**：

```text
1) 结论写进提案文件： <提案> 的 `## 闭环后追加（<date>）`
2) collab_followup { bid:"b_…", confirm:true }        # 只有本单 claim.by 能调；done/blocked 才行
3) 发起方下次 context 注入看到一行只读提示： - b_xxx 已闭环，提案 <path> 有追加结论（<ts>），请读取文件
```

记录里只存 `{ bid, issuePath, at, by }`（**不存正文**，每单 ≤3 条），路径先规范化（`./`、`.`、重复 `/`
等价）再要求是该记录 workspace 下 `docs/issues/*.md`（拒绝 `..`/绝对路径/软链）。**不投递、不改
state/receipt、不重开 bid**——想补内容就写文件，不要试图再 collab_send 进受保护会话。
提示是「注入成功后才标记」（注入失败下一轮重试）；路径校验失败的条目不标记，`collab_list` 会汇总
「N 条 followUp 因路径无效未渲染」（只提示一次），把提案修回 `docs/issues/` 后提示会自动恢复。
同一提案若已用 `collab_request_owner` 排队给受保护会话，**不必再登记 followUp**：两类提示在渲染层按提案
（共享任一 `issuePath` / `bid` 键，含传递）去重，只显示 `at` 最新的一条，被去重掉的条目不标记、之后仍会提示。

## 一点六、受保护目标只能「排队」，不能投递（0.4.0）

`[protected]` / `[protected-child]`（schema 线等）**投递一律拒绝**，这是单向硬边界，不要试图绕过
（换 target / 中转 / 让第三方转发 都不行）。要给 owner 送请求，只有一条路：

```text
collab_request_owner {
  target: "ses_…(受保护)",           # 或 collab.json 里的别名
  text: "<一句话：要 owner 看什么>",   # → summary，去控制字符、≤500
  issuePath: "docs/issues/fix-x.md",  # 可选，只做语法校验（相对、docs/issues/*.md）
  confirm: true
}
→ 写 ~/.config/opencode/collab-owner-queue/<targetSid>/<queueId>.json
→ 0 条 prompt、不建 bid/thread、不改任何协作状态（不是送达）
→ 对方下次运行看到 ≤3 行：- [owner-queue] <from> @ <HH:MM>：<summary>（<path>）
```

- **不是投递**：没有 ack、没有「已送达」，对方会话不运行就永远不消费；也不会自动变成任务。
- 每目标上限 **50 条未读**（满则拒新；已读项不占名额，7 天后回收）；只有发起方能
  `collab_request_owner { id, revoke:true, confirm:true }` 撤回。
- 发起方自己在 `collab_list` 里能看到「我提交给受保护会话的请求：N 条待处理」。
- 受保护会话不能给另一个受保护会话投队列项（不做 protected → protected 转发）；普通目标请用 `collab_handoff`。
- 想看「这一单现在到哪一步」（含队列位置、`canPush:false`）用 `collab_status { bid:"b_…" }`，
  见一点八。

## 一点七、spawn 会话会在协作结束后自动归档（0.5.0）

`collab_broadcast` 拉起的 bootstrap 会话（`collab_list` 标 `[bootstrap]`）只为一单存在。那单
`done|blocked|expired` 且过了防抖窗口（默认 10 分钟）、目标 idle、不在 `protect`、没有别的未决交接引用它、
也没有未读 owner-queue 项时，发起方下一次 `context` 刷新会把它**归档**：

```text
PATCH /api/session/{sid} { archived: true }     # 只是隐藏：会话与消息全留，记录 state/receipt 不变
collab_archive { bid:"b_…", confirm:true }      # 手动归档（跳过上面那些门）
collab_archive { bid:"b_…", restore:true, confirm:true }   # 恢复（archived:false + 清 archivedAt）
```

- **归档 ≠ 删除**：归档路径不 `DELETE`（`selftest` 清理与 spawn 落点回滚另有用例）；归档会话仍可用 `GET /api/session?archived=true` 找到。
- 关掉自动路径：`collab.json { "archiveSpawned": false }`（手动工具仍可用）；窗口 `archiveGraceMs` 夹在 1min–1h。
- 用户自己的会话 / `collab_handoff` 对象 / requester **永不**归档；`[protected*]` 连手动工具也拒绝。

## 一点八、即时状态回执（`collab_status`，0.6.0，只读）

冻结 / 加急 / 有人问「到哪一步了」时，**不要用 `collab_wait`**（它会阻塞到有回执为止）。用：

```text
collab_status { bid:"b_…" }          # 一单（最精确）
collab_status { threadID:"t_…" }     # 该 thread 的交接单
collab_status { session:"ses_…" }    # 它发起（from.sid）或承接（claim.by）的全部未闭环 + 最近一条已闭环
collab_status { }                    # 本会话相关未闭环，≤5 条，按 updatedAt 倒序
```

每条给：`state` / `priority` / 承接（`claim.by` + 剩余租约）/ 投递（`admitted=` `seen=` `ack=n/a`）/
该目标的 `[owner-queue]` 队列项 + **第 K/N 位** / 最近一次 reply 摘要 / 已闭环时的 `receipt` / **下一步**一行。

- `canPush:false` = 目标（或其祖先）在 `protect` 名单内：**只能队列**，下一步会写
  「`collab_request_owner` 或等其下一轮」。
- **零写入**：不刷新状态（过期租约只描述「下次 refresh 会释放」，不改写）、不释放锁、不投递。
  所以它可以安全地反复问，不会把 `claimed` 的租约提前推进。
- 已闭环 → `下一步: 无需动作`；全量清单仍用 `collab_list`，阻塞等回执照旧用 `collab_wait`。

### 一点八·补：消息 thread 与聚合（`collab_threads`，0.7.0，只读）

同一对会话并行多条 thread 时（实测 7 条，6 条是 `collab_send`/`collab_reply` 建立的消息 thread），
先看清单再发消息：

```text
collab_threads { target:"ses_…" }                 # 未闭环 thread（≤20 条）
collab_threads { target:"ses_…", includeClosed:true }  # 再列最近 3 条已闭环
collab_status { threadID:"t_…" }                  # 单条详情
```

- 每行：`threadID / kind（handoff|messages）/ 状态 / 最近活动 / out= / in= / bid?`；唯一一条标 `← 建议继续`
  （最新未闭环），并给出可直接复制的下一步（消息 thread → `collab_reply {threadID}`）。
- 默认只列未闭环；已闭环的（交接单终态 / `status=answered`）要 `includeClosed:true` 才出现。
- `collab_status { threadID }` 对**消息 thread 不再报错**：返回 `kind=messages` + target + 最近 ≤5 条
  出入站摘要；只有拼错的 thread 才报「没有 thread … 对应的交接单」。
- 索引（`~/.config/opencode/collab-threads.json`）**只在该消息真的投递成功后**写：预览 / 护栏拒绝 /
  投递失败都不写；上限 500 条按 `lastAt` 淘汰、读时过滤 7 天、坏文件按空处理。两个读命令零写入。

### 一点八·再补：结构化 BLOCKED（`blocked`，0.7.0）

「卡住了」真正的信息量常常只有一句：**做哪个最小实验就能判别**。别把它埋进长文——用可选结构化字段，正文照写人话。

```text
collab_send { target:"ses_发起方", text:"[handoff] BLOCKED b_… 缺后端推送日志",
              blocked:{ need:["09:00–10:00 推送日志"],            # ≤10 条，每条 ≤120 字
                        excluded:["不是权限","不是时钟"],          # ≤20 条，每条 ≤120 字
                        minimalTest:"改房态看有没有帧：有帧=前端，无帧=后端未触发" },  # ≤200 字
              confirm:true }
```

- 三段渲染在**投递正文之后**（`需要对方：① … ② …` / `已排除：…；…` / `最小判别：…`）；承接方注入
  （spawn / 叫醒 / 重发）与 `collab_status` 同样聚合（各段 ≤3 条 + 「还有 N 条」，status 只展示最新一次 + 历史次数）。
- 有可解析 bid、`confirm:true` 且你是本单参与方（`from` / `claim.by` / `asked` / `origin`）→ 写进记录 `blocked[]`，
  **保留最近 3 次**；没有 bid / 预览 / 非参与方 / 同文去重命中（未投递）→ 只上正文，回执注明「未落库」。
  `collab_handoff` 的幂等重复（同 target + 同正文）也走这两道门，不会因为「记录已存在」而绕过。
- 超条数 / 超长 / 三段全空 → **可读拒绝**（不静默截断，0 投递 0 写入）；控制字符（含换行）剥成空格。
- **不传就逐字不变**；`state` / `claim` / `receipt` 一律不动，也不放宽任何投递许可。
- 转发一个「卡住了」的活儿给下一跳时用 `collab_handoff { blocked }`：下一跳的注入里直接有「已排除什么、该做哪个实验」。

### 一点八·再再补：契约决策（`collab_decisions`，0.7.0）

一次交付里 3 条**契约级**偏差（退出码 2→3、`room:order` 是纯事件型、断言只看末帧）全靠口头纠正、散在 3–4 个 thread：
后来人仍可能按旧契约写。把它们写进这一单的记录，谁接都能拉到：

```text
collab_decisions { bid:"b_…",
  items:[ { id:"exit-code", decision:"退出码用 3（不是 2）", rationale:"D-064" },
          { id:"room-order", decision:"room:order 是纯事件型，不参与状态断言" } ],
  confirm:true }
```

- **只有本单发起方（`from.sid`）或承接方（`claim.by`）能写**（第三方 / `asked` / `origin` 一律拒绝、0 写入）；
  读谁都能读：`collab_status { bid }`、承接方注入的一行计数、`collab_list` 行尾 `decisions=N`。
- `items` 1–10 条/次；`id` ≤40、`decision` ≤200、`rationale` ≤400 字（控制字符剥成空格）；**同一 `id` 再写 = 覆盖**
  （不追加：一个决定只留最新答案），每单上限 **20** 条——超出是**可读拒绝**，不静默淘汰。
- **不投递、不改 `state` / `claim` / `receipt` / `replies`**；`confirm:false` 零写入预览。
- 承接方注入只有一行 `本单决策 N 条（collab_status { bid:"…" } 查看）`——正文一次只读查询就能拿，不占注入预算。

## 一点九、加急（`collab_escalate`，0.6.0）

「冻结 / 停手 / 先别合」要**现在就进对方当前轮**，不是等下一轮：

```text
collab_escalate { bid:"b_…", reason:"冻结：store.ts 先别动", confirm:true }   # 默认 steer
collab_escalate { threadID:"t_…", reason:"…", mode:"queue", confirm:true }    # 显式排队
collab_escalate { session:"ses_…", reason:"…", confirm:true }                 # 直接点名会话
```

- 复用宿主的 `delivery:steer`（桌面端「引导」按钮同一机制），不造新投递；`mode` 默认 `steer`。
- 只读 agent（`explore`/`plan`）目标强制 `queue`（回执 `queue(forced)`）；目标空闲时宿主也可能降级——
  回执里的 `delivery=` 是**实际**采用的方式，不是我们请求的。
- 记录只追加 `priority:"urgent"` / `urgentAt` / `urgentReason` / `urgentBy`，**不改** `state`/`claim`/`receipt`。
- 受保护目标（含血缘）**0 条 prompt** → 写一条 urgent owner-queue 项，回执 `canPush:false` + 队列位置。
- 同 `bid + reason` **5 分钟**内重复调用只刷新 `urgentAt`、不重复投递；换措辞才是新加急。
- 没闭环就想看结果：`collab_status { bid }`（admitted / seen / 队列位置）。

## 一点十、临时冻结（`collab_freeze`，0.6.0）

「先别动」不能只靠一条消息——插件必须自己知道，否则新会话 / 新的交接还会继续往里写：

```text
collab_freeze { scope:"session", target:"ses_…", reason:"等 schema 线确认", until:"2h", confirm:true }
collab_freeze { scope:"workspace", target:"/data/project/mux", reason:"本仓暂停接管", confirm:true }
collab_freeze { scope:"bid", target:"b_…", reason:"这一单先别改", confirm:true }
collab_freeze { scope:"session", target:"ses_…", freeze:false, confirm:true }   # 解冻（幂等 no-op）
```

- `until` 默认 30 分钟、上限 30 天；相对（`"30m"`/`"2h"`/`"45s"`）或绝对 ISO 都行。**到期在读取时失效**，
  没有定时器、没有清理任务。
- 被冻结对象上的**新建**协作全部可读拒绝（0 写入）：`collab_handoff`（目标本身 / 祖先 / 目标工作区）、
  `collab_broadcast`（该工作区，spawn 前再判一次）、`collab_accept`（该单或本会话）、
  `collab_escalate`（冻结优先，加急也不行）。拒绝文案带可复制的解冻命令。
- 血缘：冻结会话会覆盖它的**子会话**（`parentID` 链，`createLineage` 同一套走查）。
- `collab_list` / `collab_status` **不受限**：只在已有行尾标 `[frozen] 冻结至 HH:MM`（截图/侧栏同样只加标记）。
- 通知一次：非受保护目标 → 1 条 `queue` prompt（不用 `steer`；`cid`/`messageId` 存进条目的 `delivery[]`）；
  受保护目标（含血缘）→ **0 条 prompt** + 一条 `priority:"urgent"` owner-queue 项。被冻会话自己的
  `context` 只提示一次（写 `notifiedAt`）。
- 存储 `~/.config/opencode/collab-freeze.json`（`{version:1,entries:[]}`，**读-合并-写** + 原子 rename +
  短锁），两个工作区同时写不会互相覆盖。
- **冻结 ≠ 归档 ≠ 删除**：不隐藏会话、不删文件、不写 permissions、不切 agent；`freeze:false` 立刻恢复。

## 一点十一、自动感知：一行提示 + 承接方协议头（0.7.0）

**需求侧**：不用等人提醒「用 collab_handoff」。`context` 注入**末尾**会有一行（每会话每 10 分钟最多一次）：

```text
协作：本工作区候选 N（collab_handoff） · 其它工作区候选 M（collab_broadcast，需提案）
```

- 只给**数量与通道**，不猜「该找谁」：要名单用 `collab_list`，要选人让 `collab_handoff` 打分或人来定。
- 单边为 0 就省略该半句；两边都 0 不出现；`awareness:"off"` 关闭（`~/.config/opencode/collab.json`）。
- 以下情况**不出现**（不是故障）：当前会话是 `[protected*]`；自己已有一笔**未闭环**交接（先处理它）；
  注入预算被未读消息占满（交接 / 队列 / 未读永远优先）。
- 只读：不写记录、不建 thread、不投递。每个 10 分钟窗口只查 **2 页**（一页本工作区数 N、一页全局数 M）；
  没有 `ctx.location.directory` 时 N=0，只显示 M；宿主报错就只显示 N。

**承接侧**：收到的交接投递 / 接管请求，**最前面几行**固定是（命令可直接执行，且执行后真的闭环）——

```text
你是承接方（bid=b_… / thread=t_…）
完成后回执：collab_reply { threadID:"t_…", text:"[handoff] DONE b_… <摘要>", confirm:true }
阻塞回执：collab_reply { threadID:"t_…", text:"[handoff] BLOCKED b_… <缺什么>", confirm:true }
```

跨工作区（peer，没有可用 thread）第二行是
`完成后回执：[handoff] DONE|BLOCKED b_… <摘要>（把这一行写进 collab_send 的 text 发给发起方）`。
「回执」才是完成：只在会话里说「做完了」既不会被采纳，也不会自动闭环——闭环**只认**正文里的
`[handoff] DONE|BLOCKED <bid>` 行；`collab_reply` 没有 `kind` 参数，`text` 是必填，别省（协议头里的
`①领取 → ②回执 → ③只分析=未完成` 三步照旧）。

## 一点十二、对接人 `origin`：转发链不丢 A（0.7.0）

A → B → C 时，B→C 的记录 `from` 只能是 B。没有 `origin` 时 C 遇阻塞只能回 B、B 再转 A（实测 4 跳）；
现在记录带一个可选的 `origin`（真正的链头），C 一眼看到 A，阻塞时把 `[handoff] DONE|BLOCKED b_…` **直接发给 A**
就闭环（2 跳）。边界：只有本单**发起方或对接人**能闭环（发给第三方仍是普通 `request`），
且受保护投递规则不变（`origin` 指向 `[protected*]` 时照旧拒投）。

```text
你是承接方（bid=b_… / thread=t_…）
完成后回执：<…>
对接人（非本单发起方）：ses_A @ /data/project/muke-interface
```

- **不用手填**：`collab_handoff` / `collab_broadcast` 的 `origin` 缺省时，若当前会话是某条**未闭环**交接的
  承接方（`claim.by = 本会话`），自动继承该记录的 `origin ?? from`；否则就是本会话。
  第一跳（自己就是链头）不写、不显示；`origin == from` 时输出与旧版逐字一致。
- 显式 `origin`（`ses_…` 或别名）永远优先，用来**覆盖**继承；未知别名 = 可读拒绝、0 写入、0 投递。
- `collab_send` 的 `origin` **只影响正文**（首行加同一行，不写记录、不继承）——转发一段话时用。
- `directory` 是尽力而为：继承时沿用上一跳记录里的目录，显式 sid 时向宿主要一次（失败只显示
  `(未知目录)`，不抛）。
- 只读视图：`collab_status` 头部 `origin=ses_… @ <dir>`；`collab_list` 行尾 ` via ses_…`。
- `origin` 只是展示：指向 `[protected*]` 也不会产生任何投递，护栏不因它放宽。
- 人工转达时照三行写：`提案：<路径>` / `bid：b_…` / `对接人（非本单发起方）：ses_… @ <dir>`。

## 二、同工作区（local）

```text
1) collab_handoff { text:"<要做什么 + 相关文件路径>", expected:"implement", confirm:true }
   → 返回 threadID；不传 target 时按匹配分选人（只有一个候选则直投）
2) 对方处理；需要全文时 collab_inbox
3) 对方 collab_reply { threadID, text, confirm:true }
4) 你 collab_wait { threadID, timeoutMs }
```

## 三、跨工作区（peer）

```text
0) 先写对端提案：<目标仓>/docs/issues/{bugs,fix,feat}-<name>.md（唯一允许的跨仓写）
1) collab_broadcast {
     workspace: "/data/project/muke-interface",
     issuePath: "docs/issues/fix-x.md",
     expected: "implement" | "review" | "research",
     confirm: true
   }
   → bid；无候选 ≥80 时会 spawn 一个 explore（只读）并投交接请求
2) 对端 ACCEPT 后处理；跨 location 不能用 thread，必须用消息回执
3) 对端：collab_send { target:"<发起方完整 sid>", text:"[handoff] DONE|BLOCKED <bid> <摘要>", confirm:true }
4) 你：collab_inbox 读回执；或等租约到期后由插件只读提取对端结论自动闭环
```

交接包模板（写进 `text` 或交给对端时）：

```text
[collab:<from>] <一句话结论>
提案：<目标仓相对路径>
范围：<前端/后端/跨工作区>
期望动作：<复核 / 实施 / 仅确认>
回执：collab_send { target:"<发起方 sid>", text:"[handoff] DONE|BLOCKED <bid> <摘要>", confirm:true }
边界：只写了提案，未改你仓代码、未动 git 历史、未 push
```

## 四、权限与升级（两根杠杆，别混）

| 需求 | 用什么 | 说明 |
| --- | --- | --- |
| 让对端**能回执** | `collab_grant` | 只加 5 条 `collab_*`，会话仍**只读** |
| 让对端**能改代码** | `collab_promote` | 切 agent 到 `build`，可 `revert` 还原 |
| `expected:"review"` | **永不 promote** | 研判只需要回执能力 |

- `allowWrite:false`（默认）时 `grant`/`promote` 会被拒绝；需要时在插件配置里传
  `options.allowWrite:true`。
- 两者共用台账 `~/.config/opencode/collab-grants/<sid>.json`，互不覆盖。

## 五、排障清单（按出现频率）

| 现象 | 真实原因 | 处置 |
| --- | --- | --- |
| 对端收不到/看不到工具 | 该会话没有 `collab_*` 权限（权限是**项目级** `opencode.json`） | 对自建会话 `collab_grant`；或在本仓配置 `agents.explore.permissions` |
| 会话建出来没反应 | 创建时缺 `location.directory` → 落在 `/root`，插件不加载 | 建会话必须带 `{"location":{"directory":"<abs>"}}` |
| 发布 403 `installation does not exist` | **npm scope ≠ 仓库 owner** | scope 必须与 owner 登录名逐字一致（`inf-studio` 不是 `info-studio`） |
| `Duplicate plugin ID: collab` | 项目内 `.opencode/plugins/collab.js` 与全局包同时加载 | 二选一：删本地副本或移除包 |
| 改了插件不生效 | 本地文件会热重载；**npm 包插件版本不会热重载到已运行会话** | 重启 OpenCode 或新开会话；用 `collab_report` 预览里的「版本」确认运行时版本 |
| `collab_wait` 立刻报「没有 thread」 | thread 存储按 `location` 隔离 | 跨仓改用消息回执，不用 thread |
| 交接卡在 `claimed` | 对端只分析、没调用工具 | 租约到期自动提取结论；或 `collab_promote` 后重发 |
| 不知道一单到哪一步 / 要不要催 | 查状态、等待、加急是三件事 | 查：`collab_status { bid }`（非阻塞、零写入）；等：`collab_wait`；催：`collab_escalate { bid, reason, confirm:true }`（默认 steer，受保护目标自动转队列） |
| `collab_broadcast` 报「就是当前工作区」 | 同仓广播（0.4.0 起拒绝） | 改用 `collab_handoff { text, confirm:true }` |
| 受保护线收不到我的请求 | 投递对它一律拒绝（设计如此） | `collab_request_owner` 排队；对方下次运行时才会看到 |
| 广播重复拉起会话 | 重复广播且 `bid` 不同（提案内容/mtime 变了） | 改提案后重新广播是预期行为；不要为同一内容反复广播 |

## 六、硬约束

1. 不向 `[protected]` / `[protected-child]` 投递或改权限（内置硬名单含 schema 线与原会话）。
2. 不打断：默认 `queue`；`steer` 仅显式；插件不提供 `interrupt`。
3. 不删除任何会话；自建会话也留给 owner 处置。
4. 跨工作区只写 `docs/issues/**`；对端 git 一律只读。
5. 一次交接只发一条；超时只提醒一次，不重投。
6. `collab_broadcast` 只用于**跨工作区**：`workspace` 解析后等于当前工作区会直接报错（改用 `collab_handoff`）。
7. 给受保护会话只用 `collab_request_owner` 排队，不要尝试任何形式的投递/中转。

## 六点五、遇到异常怎么办（缺陷上报 + 挂起监控）

协作失败**不要静默重试或放弃**：0.1.3 起插件自己会留证据，你只需要把入口用起来。

### 自动（你什么都不用做）

工具抛出**非参数校验类**异常（未捕获异常 / 护栏与指令冲突 / 投递 5xx / 提取失败）时，插件会：

1. 写 `~/.config/opencode/collab-reports/<signature>/<ts>.json` + 同名 `.md`（issue 草稿）；
2. 若 `collab.json` 配了 `report: { to: "<alias|ses_…>" }`，再投一条 `note`（`queue`）给维护方；
3. 在错误文案末尾追加一行入口提示（受保护目标只落盘，不投递）。

同签名 **1 小时最多 1 条**；证据是字段白名单（版本/工具/分类/错误名与消息≤2KB/stack 前 5 帧/短 id/
工作区/记录快照），**不含正文、文件内容、token**。

### 手动（自动判定没覆盖到时）

```text
collab_report { note:"回执被 protect 拒绝，bid=b_…（复现步骤：…）", bid:"b_…", confirm:true }
```

- `confirm:false` 只预览签名与目录，不写盘；
- 同一个 note 1 小时内重复调用不会重复写文件（返回「未新增文件」）；
- 只写证据 + 一条 note，**不改变任何协作状态**（不领取、不闭环、不改记录）。

### 挂起怎么看

`collab_list` 与每次 `context` 注入各带一次「挂起提醒」（同 `(session, class, bid)` 只提示一次）：

| 类 | 含义 | 你能做什么 |
| --- | --- | --- |
| `open-stale` | `open` 超 1h 没人领 | 重新广播 / 显式指定 target |
| `claimed-lapsed` | 领取后超租约没确认 | 顺延下一候选 / 人工指定 |
| `acked-stale` | `acked` 静默超 2h | 发起方只读提取承接方最后一条回答收口 |

### 维护方（只有维护方会话需要做）

```bash
node scripts/collab-triage.mjs --dry-run                  # 看待处理签名
node scripts/collab-triage.mjs                            # 生成 docs/issues/bugs-collab-<sig>.md
node scripts/collab-triage.mjs --notify collab-maintainer  # 额外补投一条 note（需 COLLAB_SERVER_URL）
```

幂等、文件锁、`--since` 过滤；维护方会话还会在 `context` 注入/`collab_list` 看到「未处理缺陷上报 N 条」。

### 不是缺陷（不用上报）

参数校验错误（空 `text` / 非法 `bid` / 未知 target）、对端不跑、目标在 `protect` 内
（受保护回执见 pull 模式，§三）。

## 七、安装与升级

```bash
opencode plugin add @inf-studio/collab@<ver>     # GitHub Packages（需 @inf-studio scope 读权限）
opencode plugin list                              # 确认已装
opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"   # 无 failed
```

```jsonc
// ~/.config/opencode/opencode.json（需要写能力时）
{ "plugins": [{ "package": "@inf-studio/collab@<ver>", "options": { "allowWrite": true } }] }
```

`~/.npmrc`：`@inf-studio:registry=https://npm.pkg.github.com`（安装方需带 `read:packages` token）。
