# 跨会话实时协作（`collab`）

> 适用范围：多会话并行时需要「一条命令把消息实时送到另一个 OpenCode 会话，并等它跑完」的场景；
> 工具本体为 `scripts/collab.mjs`（零依赖，Node 内置即可）。
> 权威源：端点契约以本机 `opencode api get /openapi.json`（opencode v2.3.0）为准；本文只记录用法与实测结论。
> 最后校准基线：2026-11-17，`main` @ `f4c7e41fa`，opencode v2.3.0（后台服务 `http://0.0.0.0:22016`）。

## 1. 它解决什么

多会话并行（例如 parity 线与 schema 线）原先只能靠 `trellis channel` 的**事件日志 + 双方主动 poll**：
对方不 `trellis channel wait` 就永远收不到，实质是异步邮箱，不是实时通道。

OpenCode v2 已原生提供**会话级** HTTP API，`generate` / `prompt` 一调就是「往那个会话注入一条用户消息」，
消息持久化由 OpenCode 自身负责 —— 因此**不需要自建总线、不需要 MCP、也不需要 ACP**（ACP 是编辑器↔agent
协议，解决不了 agent↔agent）。

`collab` 就是这层 API 的薄封装：`send` 即时投递、`wait` 阻塞等回执、`messages` 读回。

> 历史说明：`.trellis/tasks/11-17-parity-closeout/research/channel-protocol.md` 里「OpenCode 没有按
> sessionID 给另一个会话发消息的能力」的结论**已过时**（那句话基于 v1 / 旧版 CLI 的观察）。v2.3.0 起可用，
> 但 channel 仍然是留痕真源，两者分工见 §6。

## 2. 一条命令示例

```bash
# 0) 先看有哪些会话（只读）
node scripts/collab.mjs list

# 1) 把消息送到 schema 线（默认 dry-run：只打印目标与内容，不发）
node scripts/collab.mjs send ses_e1eb91cebffeTv1467ubJLKebk "room/order 的 group 全 null 已修，请复核"

# 2) 确认无误后真发（异步投递，命令立即返回）
node scripts/collab.mjs send ses_e1eb91cebffeTv1467ubJLKebk "room/order 的 group 全 null 已修，请复核" --yes

# 3) 等对方把这一轮跑完（空闲或超时；超时退出码 2）
node scripts/collab.mjs wait ses_e1eb91cebffeTv1467ubJLKebk --timeout 10m

# 4) 读回最近几条消息
node scripts/collab.mjs messages ses_e1eb91cebffeTv1467ubJLKebk -n 5
```

## 3. 命令参考

| 命令                        | 作用                                                                   | 关键选项                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `list`                      | 列会话：`id / agent / state / parent / title / aliases`（可直接 grep） | `--roots`（只看根会话）、`--json`、`--no-header`                                                          |
| `send <目标> <文本\|->`     | 投递一条消息；**默认 dry-run**                                         | `--yes`（真发）、`--generate`（**临时生成**：用对方会话上下文做一次问答，回复只回给调用方）、`--mirror <channel>`、`--from <名字>`、`--no-prefix` |
| `wait <目标>`               | 等待目标空闲/本轮完成                                                  | `--timeout 10m`（超时退出码 2）、`--quiet`                                                                |
| `messages <目标>`           | 最近 N 条消息，按时间正序打印（含 tool 调用标记）                      | `-n 10`、`--json`、`--order asc`、`--reasoning`                                                           |
| `inbox <目标>`              | 读 inbox（已入列但未消费的输入）                                       | `--json`                                                                                                  |
| `interrupt <目标>`          | 打断目标当前轮次                                                       | 必须 `--interrupt` + 交互式二次确认                                                                       |
| `selftest`                  | 在**自建临时会话**上跑 建→发→等→读→删 全链路                           | `--agent explore`、`--keep`、`--timeout 3m`                                                               |
| `aliases` / `alias set\|rm` | 查看/维护别名表                                                        | `--json`                                                                                                  |

其余细节见 `node scripts/collab.mjs --help`。

> `inbox` 实测**经常为空**：`prompt` 的消息会被立即 admit 进消息流（忙时 `delivery=steer`），
> 只有真正的排队/待消费输入才会留在 inbox。需要「对方说了什么」请用 `messages`，`inbox` 只作补充。

### 3.1 `send` 的两种投递语义（实测差异，务必分清）

| 模式             | 端点                              | 行为                                                                                                           | 耗时                      |
| ---------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 默认（`prompt`） | `POST /api/session/{id}/prompt`   | **异步入列**：立即返回 `message.id` 与 `delivery`（`steer` = 并入当前轮次，`queue` = 排队），会话随即进入 busy | ~0.1s                     |
| `--generate`     | `POST /api/session/{id}/generate` | **临时生成**：不写入对方消息历史、不驱动对方 agent loop，回复只回给调用方（**不能当投递用**）                    | 秒级 |

`generate` **不是**「注入一条消息就返回」——它是同步生成，会阻塞调用方；设计文档里「generate = 注入」的
描述应按实测修正。跨会话协作默认走 `prompt`（`scripts/collab.mjs:430` `deliver()`），需要「顺带拿到对方这一轮
的回复原文」时才用 `--generate`。

### 3.2 消息前缀与署名

默认在正文前加 `[collab:<from>] `，`<from>` 取 `--from` → `COLLAB_FROM` → 当前系统用户。
接收方看到的样子：

```
[collab:parity-session] room/order 的 group 全 null 已修，请复核
```

前缀的作用是让接收侧（以及它自己的插件）能按前缀过滤、并把「跨会话消息」与真实用户输入区分开。
正文需要原样发送时加 `--no-prefix`。多行文本用 `-` 从 stdin 读，或用 `--` 断开选项：

```bash
printf '第一行\n第二行' | node scripts/collab.mjs send ses_xxx - --yes --from parity
node scripts/collab.mjs send ses_xxx -- '文本以破折号开头也没问题'
```

### 3.3 会话寻址与别名表

- 目标可以是会话全名（`ses_...`），也可以是别名。
- 别名表：`~/.config/opencode/collab-aliases.json`（**不进仓库**，`collab alias set` 写入时权限 600）：

```json
{ "schema": "ses_e1eb91cebffeTv1467ubJLKebk", "parity": "ses_e23a4a23fffe4c4m7UQFR8dUL3" }
```

- 别名表不存在时**只接受** `ses_` 全名（不会静默猜测）。解析逻辑见 `scripts/collab.mjs:339`。
- `list` 会在 `ALIASES` 列标出命中的别名，便于把 id 和团队叫法对上。

## 4. 端点依据（opencode v2.3.0）

全部取自 `opencode api get /openapi.json`（本机实测，operationId 为原样）：

| 方法     | 路径                                         | operationId                 | `collab` 用法                                                   |
| -------- | -------------------------------------------- | --------------------------- | --------------------------------------------------------------- |
| `GET`    | `/api/session`                               | `session.list`              | `list`；selftest 的服务可用性探测与删除复核                     |
| `POST`   | `/api/session`                               | `session.create`            | selftest 建临时会话（`{title, agent}`）                         |
| `GET`    | `/api/session/{sessionID}`                   | `session.get`               | 所有命令的「目标是否存在/状态」探测                             |
| `DELETE` | `/api/session/{sessionID}`                   | `session.remove`            | selftest 清理                                                   |
| `POST`   | `/api/session/{sessionID}/prompt`            | `session.prompt`            | `send` 默认路径（异步投递，`body {text}`）                      |
| `POST`   | `/api/session/{sessionID}/generate`          | `session.generate`          | `send --generate`（`body {prompt}`，返回 `{text,tokens,cost}`） |
| `POST`   | `/api/experimental/session/{sessionID}/wait` | `experimental.session.wait` | `wait`（204 = 已空闲/本轮完成）                                 |
| `GET`    | `/api/session/{sessionID}/message`           | `session.message.list`      | `messages`（query `limit` / `order` / `cursor` / `type`）       |
| `GET`    | `/api/session/{sessionID}/inbox`             | `session.inbox.list`        | `inbox`                                                         |
| `POST`   | `/api/session/{sessionID}/interrupt`         | `session.interrupt`         | `interrupt`（返回 `{interrupted}`）                             |

**传输方式**：走 `opencode api <method> <path> [-d <json>]`（`scripts/collab.mjs:215` `apiArgs`），
由 CLI 自己解析本机后台服务地址，**不需要记端口**。

⚠ `--server` 的语义是「直连一个**远程/带密码**的服务」：实测即便填本机后台服务地址
（`http://127.0.0.1:22016`）也会报 `requires a password; set OPENCODE_PASSWORD`。
所以**连本机后台服务时不要加 `--server`**；只有直连远程实例才用 `--server <url>` + `OPENCODE_PASSWORD`
（`scripts/collab.mjs:225` 会对这种误用给出提示）。

实测注意点：

- `opencode api` **支持**把 query 写进 path（`.../message?limit=5&order=asc`）；`--param` 对部分端点不生效，
  因此脚本统一把 query 拼进 path。
- `-d @file` **不支持**（会把 `@file` 当字面量）。脚本用 `spawnSync` 的参数数组直接传 JSON 字符串，
  不过 shell，因此多行/引号安全。
- 失败语义：非 0 退出码；错误 JSON 在 **stdout**（`_tag` / `message`），`HTTP 404 Not Found` 在 **stderr**。
  脚本据此归一成一行可读错误（`scripts/collab.mjs:225` `describeApiError`）。
- 默认 `order` 为 `desc`（新→旧）、默认页大约 20 条；`messages` 内部取 `desc` 再反转为正序打印。

## 5. 安全模型

| 机制                 | 行为                                                                                                                   | 实现                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `send` 默认 dry-run  | 打印目标（id/agent/state/title/parent）、模式、署名与将要发送的**完整正文**，不调投递端点                              | `scripts/collab.mjs:458`             |
| `--yes` 才真发       | 缺省即预览；`--dry-run` 可强制预览（即便误加了 `--yes`）                                                               | 同上                                 |
| 未知选项即报错       | 拼错的 `--ys` 不会被当成正文吞掉，直接退出码 1                                                                         | `scripts/collab.mjs:145` `takeFlags` |
| `interrupt` 双重确认 | 必须显式 `--interrupt`，且要**交互式输入完整会话 id**才执行；非 TTY（脚本/管道）一律拒绝                               | `scripts/collab.mjs:645`             |
| 自测隔离             | `selftest` 只操作**它自己新建**的临时会话（`collab-selftest-<ts>`），结束（含异常）在 `finally` 里 `DELETE` 并复核 404 | `scripts/collab.mjs:728`             |
| 只读命令             | `list` / `messages` / `inbox` / `aliases` 全部只发 `GET`                                                               | —                                    |
| 凭据                 | 不读不写任何 token/密钥；认证复用本机 `opencode api` 的服务凭据                                                        | —                                    |

`list` 输出的 `state` 由 `time.busy` 与 `time.idle` 的时间先后推导（`busy > idle` 即忙），
不额外打接口，`--json` 时直接给原始 `Session.Info`。

## 6. 与 Trellis channel 的分工

| 维度             | `collab`（OpenCode API）                             | `trellis channel`                                                  |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| 语义             | **实时投递**：消息直接进入目标会话的输入流并触发轮次 | **持久留痕**：事件日志 `events.jsonl`，人类可读、可 grep、可跨机搬 |
| 是否需要对方配合 | 不需要（对方不需 `wait`，会话会自己跑）              | 需要对方 `channel wait` 或事后翻日志                               |
| 历史位置         | OpenCode 自己的会话存储（`messages` 读回）           | `~/.trellis/channels/<project>/<channel>/events.jsonl`             |
| 适用             | 「现在就让它动起来」                                 | 审计、跨机协作、事后复盘、非 OpenCode 参与者                       |

两者不互斥。`send --yes --mirror <channel>` 会在投递成功后追加一条 channel 记录
（`[collab:<from> → <sessionID>] <正文>`，`scripts/collab.mjs:442`），实现**实时投递 + 长期留痕**双轨；
镜像失败只打印 `⚠ mirror 失败` 告警、不影响已完成的投递（也不回滚投递）。

## 7. 退出码

| 码  | 含义                    | 典型场景                                                                      |
| --- | ----------------------- | ----------------------------------------------------------------------------- |
| `0` | 成功（含 dry-run 预览） | —                                                                             |
| `1` | 用法错误 / API 错误     | 目标会话不存在（404）、服务未启动、别名无法解析、未知选项                     |
| `2` | `wait` 超时             | 目标在 `--timeout` 内仍未空闲                                                 |
| `3` | 缺少显式确认（被拒绝）  | 缺 `--yes` 不会走到这里；`interrupt` 缺 `--interrupt` / 确认串不匹配 / 非 TTY |

## 8. 自测

```bash
node scripts/collab.mjs selftest        # 全链路：建 → dry-run 不落地 → 发 → 等 → 读回 → 删
```

实跑输出（2026-11-17，opencode v2.3.0）：

```
collab 0.1.0 selftest —— 临时会话（title=collab-selftest-1794865699052, agent=explore）
注：会在临时会话上真实跑一轮模型（约 $0.01–0.03），结束即删除。
✓ 服务可用（GET /api/session） — 50 个会话
✓ 创建临时会话 — ses_e19aae579ffeM5x36YUJyPlP1P
✓ 不存在的目标 → 报错（GET 404） — SessionNotFoundError: Session not found: ses_selftest_not_exists_0000
✓ 不带 --yes 只做 dry-run（消息未增加） — messages=0 exit=0
✓ 投递消息（POST /prompt） — message=msg_1e6551e02001Jq3XNKHjmc1Tmc delivery=steer
✓ 等待空闲（POST /wait, timeout=3m） — 耗时 1.6s
✓ 读回消息命中 token（GET /message） — messages=3 assistant=1
✓ 空闲时 wait 立即返回 — 耗时 495ms
✓ list 能解析出临时会话与 agent — agent=explore
✓ 删除临时会话（DELETE /session） — ses_e19aae579ffeM5x36YUJyPlP1P
✓ 复核已删除（GET 返回错误） — SessionNotFoundError: Session not found: ses_e19aae579ffeM5x36YUJyPlP1P
✓ selftest 全绿：建 → dry-run → 发 → 等 → 读回 → 删
```

要点：`selftest` 会消耗一次模型调用（实测 ≈$0.001–0.02，取决于 agent 上下文），因此它**只**建临时会话；
`--keep` 可保留现场（此时会提示你手动 `DELETE`）。

其它已验证的失败路径：

```bash
# 目标不存在 → 1
node scripts/collab.mjs send ses_doesnotexist000000000000 'x' --yes
# 服务不可用 → 1（并提示 opencode service start）
node scripts/collab.mjs list --server http://127.0.0.1:1
# 忙时超时 → 2
node scripts/collab.mjs wait <忙的会话> --timeout 1s
# interrupt 缺 --interrupt / 非 TTY → 3
node scripts/collab.mjs interrupt ses_xxx
```

## 9. 已知边界与风险

| 风险                | 说明 / 处置                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 目标忙时投递        | `prompt` 返回 `delivery=steer`，消息并入当前轮次；若对方正在长任务中途，它可能把这条当补充指令而不是新任务。先 `wait` 再 `send` 更稳 |
| `generate` 语义     | 同步阻塞整轮、消耗对方会话的模型额度；只用于「我要它现在就回我原文」                                                                 |
| 上下文差异          | 注入的消息对目标会话等同「用户新输入」，**不会**带上你这边的上下文；关键背景请写进正文，或先 `--mirror` 留档                         |
| 插件注入干扰        | 目标会话的 SessionStart / workflow 插件会照常触发；用 `[collab:<from>]` 前缀便于识别与过滤                                           |
| 服务未启动          | 报错会直接提示 `opencode service start` / `opencode serve`；也可用 `--server` 指定                                                   |
| 会话不存在 / 已归档 | 统一在探测阶段报 `SessionNotFoundError`，不再往下调投递                                                                              |
| 跨项目              | 会话带 `location.directory`，属于哪个项目就在哪个项目跑；`list` 不按项目过滤，注意别发错会话                                         |

## 10. 不做什么

- 不新增依赖：只用 Node 内置 `child_process` / `fs` / `readline`，以及本机 `opencode` CLI。
- 不动产品代码（`packages/**`、`apps/**`）。
- 不写 token、不建自研总线、不改其它会话的既有消息。

## 11. 插件形态（推荐日常使用）

CLI 适合脚本/CI/排障；**日常协作走插件**——工具原生可调用、事件驱动、未读自动注入。

### 11.1 启用

插件已独立为仓库 [`inf-studio/collab`](https://github.com/inf-studio/collab)，包名 `@inf-studio/collab`（GitHub Packages）：

```bash
opencode plugin add @inf-studio/collab@0.1.0
```

全局配置可传选项（默认 `allowWrite:false`，即 grant/promote 被拒绝）：

```jsonc
{ "plugins": [{ "package": "@inf-studio/collab@0.1.0", "options": { "allowWrite": true } }] }
```

验证：`opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"` → 无 `failed`，且含 `collab`。

> ⚠ **版本与重载（2026-11-18 实测）**：升级 npm 包插件的正确顺序是
> `opencode plugin add @inf-studio/collab@<ver>` → **`opencode reload`**。
> 实测（0.1.5）reload 后当前会话的 `collab_*` 工具即切换到新版本，**无需重启服务**；
> 证据（2026-11-18 实测 0.1.5）：`opencode plugin add @inf-studio/collab@0.1.5` + `opencode reload` 后，
> 在同一**已运行**会话里调 `collab_report {confirm:false}`，预览里的
> 「分类: manual  工具: collab_report  版本: 0.1.5」显示运行时版本已是 0.1.5。
> 若 reload 后仍失败（例如安装报 `NpmInstallFailedError`），才需要 `opencode service restart`（会打断会话）或新开会话。
> `opencode plugin list` 只是*已安装*版本；诊断*运行时*版本用 `collab_report {confirm:false}` 预览里的「版本: x.y.z」。

### 11.2 十八个工具（协作链路六个 + 权限/上报/追加/租约/归档/状态各一组）

| 工具 | 入参 | 说明 |
| --- | --- | --- |
| `collab_list` | `{ limit?: number, directory?: string }` | 列会话 + `parent=<short>`、`loc=<项目名>`；本会话标 `[self]`，protect 名单标 `[protected]`，其子会话标 `[protected-child]`（后者同样不可投递），广播拉起的会话标 `[bootstrap]`；末尾列出未闭环交接（含 `admitted=/seen=/queue-age=/resend=/unacked=` 送达状态，见 §11.9）；本会话持有 / 排队中的资源租约（§11.10）；本会话**提交给受保护会话的队列项**（条数 + ≤3 行明细 + `queueId`，见 §11.12）。`directory` 只看一个工作区（省略 = 旧行为） |
| `collab_send` | `{ target, text, kind?, threadID?, bid?, mode?, confirm: boolean }` | **`confirm` 必须 true**；否则只返回预览（目标 agent/state/title + kind/thread/mode + 将发送内容）。`kind:"reply"` 时 `target` 必须等于 thread 对端，且调用方必须是参与者（见 §11.7）。`bid?` 仅供**限界 reply** 用：声明本条消息闭合哪一单（缺省时从正文 `b_…` 取），决定了能否把回执投进受保护发起方（§11.4，**仅未闭环的单**） |
| `collab_reply` | `{ threadID, text, bid?, confirm: boolean }` | 回执语法糖 = `collab_send{kind:"reply"}`；目标由 thread 里的对端自动解析，恒为 `queue`；非参与者调用会被拒绝。`bid?` 同上（限界 reply 归属判定） |
| `collab_followup` | `{ bid, issuePath?, confirm: boolean }` | **闭环后追加（pull，0.1.6）**：只有该单 `claim.by` 可调、只有 `done`/`blocked` 可调；只往 `record.followUps[]` 追加 `{bid, issuePath, at, by}`（**不存正文**），**不投递、不改 state/receipt、不重开 bid**。`issuePath` 缺省取记录的提案，必须先规范化再要求 realpath 落在该记录 workspace 的 `docs/issues/*.md`（`.`/`./`/重复 `/` 会被合并，`./docs/issues/x.md` 等价；拒绝 `..`/绝对路径/软链）。每单上限 3 条。见 §11.9.3 |
| `collab_inbox` | `{ limit?: number }` | 本会话跨会话消息**全文**（单条上限 `INBOX_TEXT_LIMIT=4000` 字，超出以 `…` 截断）+ kind/thread/线程状态；只读，不推进游标。读到即视为「已见」→ 会回一条 `[ack]`（§11.9.1）；`[ack]` 本身标 `system-ack` |
| `collab_wait` | `{ threadID?, target?, timeoutMs? }` | 传 `threadID` 等该线程「**最后一次 request 之后**」的 `kind:"reply"`（仅参与者可等；格式非法/thread 不存在立即报错）；不传则等 `target` 空闲。默认 120000，上限 1800000 |
| `collab_status` | `{ bid?, threadID?, session? }` | **只读、非阻塞**地看「这一单现在到哪一步」（0.6.0）：`state` / `priority` / 承接（`claim.by` + `kind` + 剩余租约）/ 投递（`admitted` / `seen` / `ack=n/a`）/ 该目标 `[owner-queue]` 队列项与**队列位置** / 最近一次 reply 摘要 / `receipt.note` / **下一步**一行。`bid` / `threadID` / `session` 三选一（`session` 也接受别名：列出它作为 `from.sid` 或 `claim.by` 的全部未闭环 + 最近一条已闭环）；都不传 = 本会话相关的未闭环（≤5 条，按 `updatedAt` 倒序）。受保护目标照常可查，并明确 `canPush:false` + 只能走队列。**零写入**：不刷新状态（过期租约只描述不改写）、不释放锁、不投递。见 §11.14 |
| `collab_broadcast` | `{ workspace, issuePath, expected?, agent?, agentConfirm?, confirm }` | **跨工作区**广播（`workspace` 解析后等于当前工作区 → **拒绝**并提示用 `collab_handoff`，0.4.0）：`issuePath` 必须在 `<workspace>/docs/issues/` 下、存在、`.md` 且**不是软链**；确定性打分 + `why`；写全局广播文件（0 模型调用）→ 只有被问询的 top-1 收到「接管请求」注入（ACCEPT/DECLINE，5 分钟租约，`busy > 30min` 时额外补 1 条 `queue` 叫醒）；无候选 ≥80 时 `claim(kind=spawn)` 拉新一个会话（默认 explore；`build` 需 `agentConfirm:true`；宿主不回 `location` 时回滚刚建的会话） |
| `collab_accept` | `{ bid, confirm }` | **原子领取**（`open(<bid>.lock,'wx')`，只有一个 winner）；输家返回「已被 `ses_x` 领取」；会话若带 `location.directory` 且不属于广播所属工作区则拒绝；`accept` 直接 `acked`，spawn 的新会话自己调用则 `claimed → acked`（记 `ackedAt`）；领取后回执 `[handoff] DONE <bid> <摘要>` |
| `collab_handoff` | `{ target?, text, expected?, confirm }` | **同工作区**交接：复用 thread 协议（`kind:request` + `queue`）。不传 `target` 时——目标唯一直接投；多目标用与广播同一套打分（阈值 80）择优。同 `(target, text)` 幂等：重复调用返回「已存在 / 已闭环」，不重投 |
| `collab_request_owner` | `{ target?, text?, issuePath?, bid?, id?, revoke?, confirm }` | **受保护目标请求队列（0.4.0）**：只允许「非受保护 → `[protected]`/`[protected-child]`」，写入 `~/.config/opencode/collab-owner-queue/<targetSid>/<queueId>.json`（`tmp+rename`，每目标上限 **50 条未读**，满则拒新；已读项不计、7 天后回收）。**不投递、不唤醒、不建 bid/thread、不改任何协作状态**（0 条 prompt）；`confirm:false` 零写入。`text` → `summary`（去控制字符、≤500）；`issuePath` 只做**语法**校验（相对、`docs/issues/<name>.md`、无 `..`/绝对路径，不读 fs）。目标会话只在自己 `context` 注入里看到 ≤3 行只读提示（与「闭环后追加」合计 ≤3、同一提案一行，§11.12.1）；`revoke:true` + `id` 只允许发起方撤回自己的一条。见 §11.12 |
| `collab_grant` | `{ target, confirm, revoke? }` | **会话级权限补丁**：给**这一个**会话的 `permissions` 追加 5 条 `collab_*` allow（`collab_list/inbox/wait/reply/send`）。先 `GET` 现有规则 → 按 `action + resource` 去重合并 → PATCH（**整集替换**语义，原规则保留）；白名单之外（`edit`/`write`/`shell`…）一律拒绝。`confirm:true` 才写；否则只预览目标（id/agent/title/loc）与将加/将删规则。`revoke:true` 用记录里的 `before` 快照整集还原并删除记录（无记录报「无可还原」）。`[protected*]` 目标直接拒绝 |
| `collab_report` | `{ note?, bid?, threadID?, confirm }` | **缺陷上报（旁路，不改任何协作状态）**：把现场写到 `~/.config/opencode/collab-reports/<signature>/<ts>.{json,md}`（版本/工具/分类/错误名与消息≤2KB/stackTop 5 帧/短 id/工作区/记录快照；**不含正文、文件内容、token**），配了 `report.to` 时额外 `collab_send`（`note`+`queue`）通知维护方；同签名 1 小时最多 1 条。任何非参数校验类错误都会在错误文案末尾提示这个入口（见 §11.8） |
| `collab_lock` | `{ resource, mode?, ttlMs?, reason?, wait?, confirm }` | **资源租约（0.2.0）**：同工作区共享资源（测试窗口 / 同一文件 / 全量构建）的可判定互斥。`exclusive`（默认）与任何模式互斥，`shared` 之间可共存；`ttlMs` 默认 15 分钟、夹在 `[10s, 2h]`；过期在下次访问时回收（写 `history: expire`），无需人工清理。同一会话重复申请**幂等**（返回既有租约，不重复计数、不延长 TTL）。被占时：不传 `wait` → 返回「持有者 + 剩余 TTL」；`wait:true` → 按 FIFO 入队并返回排位。**不投递消息、不打断会话、不提供抢占**。`confirm:true` 才写，否则只预览。见 §11.10 |
| `collab_unlock` | `{ resource, confirm }` | 释放**自己**持有的租约；`shared` 组只移除自己、其他 holder 保留。free / 非持有者会得到可读拒绝——**没有 `force`**（抢占需人工；`[protected*]` 持有者永不被工具顶掉）。`confirm:true` 才写 |
| `collab_locks` | `{ resource? }` | **只读**列出租约：`resource / free 或 held / mode / holders / 剩余 / ttl / waiters / 我的位置`。不改状态、不回收、不叫醒排队者；过期租约直接显示 `free`。`collab_list` 会额外追加本会话「持有 / 排队中」 |
| `collab_promote` | `{ target, agent?, confirm, revert? }` | **按会话切 agent**（`POST /api/session/{id}/agent`）：默认 `build`，白名单仅 `build` / `plan`；`confirm:true` 才发。记录 `agentBefore/promotedAt/promotedBy` 到同一份 `collab-grants/<sid>.json`（与 grant 半段互不覆盖）；`revert:true` 切回记录里的原 agent 并删除该半段（无记录报「无可还原」）。`[protected*]` 与非法 agent 直接拒绝。**只在对端 `collab_accept` 且确需改代码时用；`expected:"review"` 的交接永不 promote** |
| `collab_archive` | `{ bid?, session?, restore?, confirm }` | **归档 spawn 会话（0.5.0，归档 ≠ 删除）**：`PATCH /api/session/{id} { archived:true }`（宿主无 `session.update` 时走 `COLLAB_SERVER_URL` HTTP），会话与消息保留、记录 `state/receipt` 不变，`restore:true` → `archived:false` 并清 `archivedAt`。`bid` 只认得**本插件拉起的**会话（`claim.by`；spawn 租约过期后才被领取的取 `expiredClaim.by`），别的单一律报错并提示改用 `session` 直指；`confirm:false` 只预览。自动路径还有 10 分钟防抖（默认）/idle/未决引用/未读队列等门（见 §11.13），**手动工具跳过这些门**，但 `[protected*]` 一律拒绝 |

`kind`：`request`（默认）／`reply`（必须带 `threadID`，缺失会被当作新请求并在返回里提示）／`note`（不改线程状态）。
`expected`：`implement`（默认，改代码）／`review`（确认/复核）／**`research`**（0.4.0，只读排查 + 结论；对 `build` 也合法）。
若承接方是只读 agent（`explore` / `plan`）而 `expected:"implement"`，结果里会明确提示**能力不匹配**并建议 `expected:"research"` 或先 `collab_promote`。
`mode`：**默认 `queue`**（等目标下一轮，不打断）；`steer` 必须显式传，且只读 agent 会被强制降级（见 §11.7）。

> `collab_list` 的 `[self]` 与 `[protected]` 是**独立**标记：普通会话只显示 `[self]`，只有当前会话本身
> 在 protect 名单里时才会是 `[self,protected]`（实测 S15）。

### 11.3 自动机制

- **实时接收**：订阅 `session.inbox.enqueued`（白名单见 `.trellis/tasks/archive/2026-11/11-17-collab-plugin/research/events.md`），
  入站消息连同 `kind`/`threadID`/`cid` 写进 `ctx.storage` 的未读队列 `collab/inbox/<sessionID>`；
- **未读注入**：`ctx.session.hook("context")` 只对「本次请求里没有、且此前没注入过」的条目向 `system`
  追加一条 `[collab] 待处理请求 N 条 / 新回执 M 条`（最多 `maxInject` 条、单条 ≤200 字）。
  已经被本次请求包含的条目（`collab_send` 的正文本身就是 user turn）会被标记为「已见」而**不注入**，
  因此同一句话不会出现两次；只影响本会话本次请求，不写历史、不改别人。
  无 thread 的 legacy 消息（CLI 的 `[collab:…]` 纯文本）提示「无需回执」，不会拼出不存在的 threadID。

### 11.4 全局配置 `~/.config/opencode/collab.json`

```jsonc
{
  "aliases": { "schema": "ses_…", "parity": "ses_…", "collab-maintainer": "ses_…" },
  "autoDeliver": true,
  "maxInject": 3,
  "protect": ["ses_…"],
  "readonlyAgents": ["explore", "plan"],
  "archiveSpawned": true,
  "archiveGraceMs": 600000,
  "waiterTtlMs": 600000,
  "waiterHeartbeat": true,
  "dedupeWindowMs": 60000,
  "report": { "to": "collab-maintainer" }
}
```

`archiveSpawned`（默认 `true`）控制**自动归档** spawn 会话（§11.13）；`false` 只关自动路径，
手动 `collab_archive` 仍然可用（回滚开关）。`archiveGraceMs` 是终态后的防抖窗口，默认
**600000（10 分钟）**，夹在 `[60000, 3600000]`（1 分钟–1 小时）——写错成 `600` 或一周都会被夹回。

`waiterTtlMs`（默认 **600000 = 10 分钟**，夹在 `[60000, 3600000]`）是**排队心跳**的存活窗口：排队者的
`LockWaiter.at` 记录「最近一次心跳」，超过这个窗口没有心跳的排队者在下一次 `collab_lock`（写路径）里被
回收——**读命令不回收**，只标 `[stale]`（§11.10.3 / §11.10.6）。没有「0 = 永不回收」：想要旧行为就设到上限
60 分钟。`waiterHeartbeat`（默认 `true`）控制「会话自己的 `context` 钩子每轮刷新一次心跳」这一半；
`false` 只关这一半，`collab_lock` 重复调用与其它写工具的轻量 touch 仍在（见 §11.10.6）。

`dedupeWindowMs`（默认 **60000**，`0` 关闭）是**正文去重**窗口：同一 thread + 归一化后（空白折叠）完全一致的
正文在窗口内重复提交时，`collab_send` / `collab_reply` 只投递第一次，第二次**不投递、不追加 thread 消息**，
回执写明「60s 内已有同文，未重复投递」（§11.9.4）。

`report.to`（别名或 `ses_…`）是**缺陷上报的主通道**：插件把上报当作 `note`（`queue`）投给该会话，
空闲也会被唤醒；文件只作证据与兜底。`report.enabled:false` 关闭投递但仍落盘（回滚开关）。
目标命中 `protect`（含血缘）时**不投递**只落盘。详见 §11.8。

`protect` 与 `readonlyAgents` 都是**累加**的：内置硬名单（schema 会话、本会话）与内置只读 agent 名单
（`explore`/`plan`）永远生效，配置文件只能加、不能减。

`protect` 是**血缘**护栏，不是纯 id 列表：目标本身在名单内，或它的任一祖先（`Session.Info.parentID` 链，
最多上溯 `MAX_LINEAGE_DEPTH=8` 级、带环保护）在名单内，一律拒绝投递 —— 派生一个子会话
（如 `trellis-implement` / `trellis-check`）不会绕过名单。`collab_list` 会把这类会话标
`[protected-child]` 并打印 `parent=<short id>`。`parentID` 取自 `ctx.session.get`；宿主不返回该字段时
回退到 `ctx.session.list()`。整个判定只读，不产生任何投递。

护栏是 **fail-closed**，`collab_reply` 同样受限：受保护线（或其后代）**发起的**请求，其回执默认也无法投回
该线（错误文案会注明「回执同样适用该护栏」）。

唯一例外是**限界 reply（bounded reply）**：以下三条**同时**满足时放行投递（仍强制 `queue`，
返回里注明「回执按白名单放行」）：

- 形态一：`kind:"reply"`；
- 形态二（**遗留兼容，0.1.4+**）：`kind` 缺省，且正文含 `[handoff]` 与命中的 `bid`（0.1.1 的旧文案就是这种写法）；
  显式 `kind:"request"` / `"note"` / `"steer"` **不**走兼容。

三条判据：

1. `target` 就是该 `bid` 记录的**发起方**（`record.from.sid`）；
2. 发送者就是该单的**领取人**（`record.claim.by`）；
3. `bid` 归属该记录 —— 取入参 `bid`，否则取正文里的 `b_[0-9a-f]{8,32}`。

`request` / `note` / `steer`、旁观会话、其它 `bid`、「目标受保护但不是这单发起方」，以及**已闭环的单**
（`done` / `blocked` / `expired` —— 没什么可回执了）一律仍然 fail-closed；
`BUILTIN_PROTECT` 与血缘判定不变。放行只影响投递，**不改**广播记录状态（闭环仍由回执解析负责）。
闭环后的追加结论走**拉取**而不是推送：承接方 `collab_followup` + 写提案文件，发起方下次注入看到一行只读提示
（§11.9.3）；插件**不再**为闭环后的单开放任何 push 窗口（0.1.6 起，评审裁定：常设注入面与 protect 目的冲突）。

**要给受保护线送东西**：投递仍然一律拒绝（`BUILTIN_PROTECT` 是单向硬边界，不变）。
唯一合规路径是 §11.12 的**受保护目标请求队列**（`collab_request_owner`）：写一条队列项，对方下次运行在自己的
`context` 注入里看到一行只读提示——这是 **pull**，不是投递，不存在绕过护栏的通道。

受保护线需要结果时还有 §11.4.1 的 pull 模式：它发起的广播不要求推送回执，结果由它自己只读提取
（`claimed` 走 5 分钟租约到期，`acked` 走静默 2h，见 §12.5 #12），
或用 `trellis channel` / `--mirror` 留痕，避免让对端空等 `collab_wait`。

### 11.4.1 受保护发起方（`receiptMode:"pull"`）

`scope=peer` 广播创建时，若发起方命中 `protectedAncestor`（自身或任一祖先在 `protect` 内），记录写
`receiptMode:"pull"`；否则写 `"push"`（**旧记录没有该字段，一律按 `push` 处理**，行为与文案不变）。

| 面 | `push`（默认） | `pull`（受保护发起方） |
| --- | --- | --- |
| ② 回执 | `collab_send {target:"<发起方 sid>", text:"[handoff] DONE <bid> <摘要>", confirm:true}` | 在**本会话最后一条回复**里写 `[handoff] DONE|BLOCKED <bid> <摘要>`；**不要** `collab_send`（会被护栏拒绝） |
| ③ 未完成判定 | 结论必须用 `collab_send` 真正发出 | 结论必须写进最后一条回复（含上面的 `[handoff]` 行） |
| 推辞 | `collab_send {… "DECLINE <bid> <理由>"}` | 不领取即可（5 分钟不答自动顺延下一候选） |
| 闭环 | 承接方回执，或发起方只读提取（`claimed`：租约到期；`acked`：静默 2h） | 同左——发起方只读提取承接方**最后一条有文本的回复**（`claimed` 租约到期 / `acked` 静默超 `ACKED_EXTRACT_MS`=2h） |
| 未闭环提醒 | 「用 collab_inbox 看回执」 | 「pull 模式：无需等待推送回执，`claimed` 到期 / `acked` 静默 2h 后只读提取承接方的最后一条回复」 |

三处文案（接管请求注入 / 叫醒 prompt / `collab_broadcast` 结果）与 `collab_accept` 的输出保持同一套说法。

> ⚠ 提醒可达性：`injectionFor` 的**外部**提醒对受保护会话是白名单化的——只有两类只读提示：
> ① 「提案有闭环后追加」（§11.9.3；条件：它是该单发起方且存在未提示的 `followUps`）；
> ② 「`[owner-queue] …`」未读队列项（§11.12；每条一次）。两类提示**合计 ≤3 行**，且同一提案只渲染
> `at` 最新的一条（§11.12.1）。
> 接管请求 / 群组广播 / 未闭环提醒都不会注入。
> 另一路 `injectStale` 是**本地**「与本人相关的挂起记录」提醒（`involves(record, sessionID)`：
> 本人发起、本人领取或正在问询本人），不含任何他人正文、不含任何指令，因此对受保护会话照常生效。
> 所以上表那条 pull 的「未闭环提醒」在真实宿主里**用户看不到**——它是防御性代码（只有非保护但被标
> `receiptMode:"pull"` 的记录才会命中）。真正发生收口的时机是**发起方自己下一次** `collab_broadcast`
> （幂等分支）或 `collab_handoff` 触发的那次 `refresh`；受保护会话不会因为「等」而自动收口。

### 11.5 与 CLI 的分工

| 场景 | 用哪个 |
| --- | --- |
| Agent 之间互相传话 | 插件 `collab_send` / `collab_reply` |
| CI / shell 脚本 / 人肉排障 | CLI `node scripts/collab.mjs` |
| 需要长期留痕、跨机审计 | `--mirror <channel>` 同步到 Trellis channel |

两者语义一致：`prompt`/`collab_send` 才是投递；`generate`/`--generate` 是**临时生成，不写对方历史，不能当送达**。

### 11.6 已知限制（2026-11-17 实测，交接协议版）

1. **工具可见性由 agent permissions 决定**（V2 没有 `tools` 字段）：内置 `explore` 的权限链是
   `* deny` + read/glob/grep/shell/webfetch/websearch 白名单，所以插件工具默认不可见。
   已在根 `opencode.json` 的 `agents.explore|plan.permissions` 里为 5 个 `collab_*` 动作加 `allow`，
   **新会话生效**（实测 explore 会话工具集已含全部 5 个）。
2. **未读摘要不再冗余**：注入按 inboxID/cid 去重——`collab_send` 的正文作为 user turn 已在请求里，
   对应条目会被标记「已见」直接跳过；只有「不在本次请求里的入站」才会出现在 system 摘要中（每条只出现一次）。
   `collab_inbox` 始终返回全文，不依赖摘要。
3. **线程/未读跨插件重载持久**：`ctx.storage` 是服务端持久存储；实测插件文件变更触发的重载前后，
   `collab_inbox` 内容与 thread 状态完全一致。注意 `~/.config/opencode/collab.json` **不是** OpenCode 配置
   文件，改它不会触发插件重载（插件按 mtime 懒读配置，本身也不需要重载）。
4. **重启持久化仍未验证**：`opencode service restart` 会中断并行会话，未在活跃窗口执行。
5. **参与者校验**：`collab_reply` 与 `collab_wait {threadID}` 要求调用方 ∈ `{fromSession, toSession}`，
   `collab_send {kind:"reply"}` 还要求 `target` 等于 thread 对端；不满足即拒绝且**不写 thread**。
   无 `sessionID` 的调用（CLI 等无工具上下文）跳过身份校验，但返回里会加注 —— threadID 不再是 bearer 凭据。
6. **子会话血缘护栏**：受保护会话的任意层级子会话都不可投递（§11.4），`collab_list` 标 `[protected-child]`。

### 11.7 交接协议（request → reply，不打断）

数据与流程的唯一真源是插件内的 thread 存储，注入只是「下一步该做什么」的提醒视图：

```
collab/threads/<threadID> = {
  threadID, fromSession, toSession, kind,
  status: "open"|"answered"|"closed",
  msgs: [{ threadID, cid, kind, text, ts, from, fromSession, toSession }],
  createdAt, updatedAt
}
```

**状态机**（`status` 只由消息驱动，没有单独「关闭」工具）：

| 事件 | status 变化 | 说明 |
| --- | --- | --- |
| `request` 写入 | → `open` | **同一 threadID 的第二次 request 会重开**（`answered` → `open`），接收方 hook 重新提醒 |
| `reply` 写入 | → `answered` | 回执同时写进 `msgs`，供对端 `collab_wait` 读取 |
| `note` 写入 | 不变 | 纯通知 |
| `closed` | — | 仅在数据结构里保留，当前没有工具/路径写入它 |

三步流程：

| 步骤 | 调用 | 结果 |
| --- | --- | --- |
| ① 请求 | `collab_send { target: see_b, text, kind: "request", confirm: true }` | 自动生成 `threadID`（`t_<base36ts>_<rand4>`），thread `open`，正文 `[collab:<from>][request:<threadID>] …` |
| ② 处理 | see_b 收到 user turn；需要全文/状态时 `collab_inbox` | 它自己决定怎么处理，插件不代替执行 |
| ③ 回执 | see_b：`collab_reply { threadID, text, confirm: true }` | thread → `answered`，投递给 thread 里的对端 |
| ④ 等回执 | see_a：`collab_wait { threadID, timeoutMs }` | 只看**最后一次 request 之后**的 `kind:"reply"`（复用 thread 时不会返回上一轮旧回执）；超时抛错 |

**参与者与路由校验**（threadID 不是 bearer 凭据）：

- `collab_reply`：调用方必须是 `fromSession` 或 `toSession`，否则拒绝并说明「你不是该 thread 的参与方」；
- `collab_send {kind:"reply", threadID, target}`：除参与者校验外，`target` 必须等于 thread 对端
  （`fromSession===me ? toSession : fromSession`），不一致直接拒绝，**不写 thread、不投递**；
- `collab_wait {threadID}`：同样要求参与者身份；`threadID` 格式非法或 thread 不存在**立即报错**（不等满 timeout）；
- 无 `sessionID` 的调用（CLI / 脚本等无工具上下文）跳过身份校验，返回里会加注「未校验参与者身份」。

**不打断**的保证：

- `collab_send` 默认 `queue`，只读 agent（`explore`/`plan`）即便传 `steer` 也会被强制 `queue`，
  返回里明写 `mode=queue(forced)` 与「已入队，不打断对方当前轮」；
- 插件不提供 `interrupt`，也没有任何绕过路径；
- 注入只改**本会话下一次**模型请求的 system，不动目标当前轮、不改历史。

实测（build 目标忙时用 `sleep 20` 跑长任务，从 explore 投递 `steer`）：投递后目标的消息列表
（含当前 assistant 消息 id）**完全不变**，队列消息在目标这一轮结束后才作为新的 user turn 进入。

**跨项目/跨目录**：thread 与 inbox 存储按 `location.directory` 隔离，而 `collab_list` 不过滤项目。
给别的项目（不同目录）的会话发请求，对方能收到消息，但**回执流程会静默超时**（`collab_wait` 的
thread 读不到对端写入）——跨项目协作请改用 `collab_accept` 的广播链路（§12），或用
`trellis channel` / `collab … --mirror` 留痕。
`collab_wait` 对「thread 不存在」会快速报错并提示这一点，不会空等到 timeout。

### 11.8 缺陷自上报 + 挂起监控（0.1.3）

插件本身的缺陷（护栏冲突、状态机死角、投递不可达）曾让交接静默挂起数小时甚至一天：调用方只看到
一句「被拒绝」，无法把现场传回维护方。0.1.3 起两条路一起补上。

**触发（R1）**：工具执行中抛出**非参数校验类**异常时自动上报——未捕获异常、不变量失败、
护栏与指令冲突、投递 5xx、提取/解析异常。**不触发**：参数校验（空 `text`、非法 `bid`、未知目标）
与正常业务拒绝（`protect` 拦截、租约过期、等待超时）；这些走 `ValidationError` 标记，直接放行。

**证据（R2/R7）**：字段白名单 + 脱敏，`<reportDir>/<signature>/<ts>.json` 与同名 `.md`
（`.md` 可直接当 issue 草稿：现象/复现/证据/影响面）。

```jsonc
{
  "signature": "d_<hash16>",        // hash(version + tool + errorName + 归一化 message)
  "version": "0.1.3",
  "tool": "collab_send",
  "class": "delivery-5xx",          // uncaught | invariant | guard-conflict | delivery-5xx | extract-error | manual
  "error": { "name": "DeliveryError", "message": "…（≤2KB）", "stackTop": ["at …"] }, // 前 5 帧
  "context": { "bid": "b_…", "thread": "t_…", "from": "ses_xxxx…yyyy" },  // 短 id
  "workspace": "/data/project/x",
  "record": { "state": "acked", "attempts": 0, "receiptMode": "push" },
  "at": 0
}
```

**不含**：消息正文全文、文件内容、token、完整 session 列表（`text`/`note`/`token` 输入与长
token 形状的串都会被替换为 `[redacted]`）。目录可用 `COLLAB_REPORT_DIR` 覆盖（沙箱/harness）。

**去重与限流（R4）**：同 signature 每 1 小时最多 1 条；`index.json` 以 `tmp + rename` 写入
（`{ signature: { lastAt, triagedAt } }`，`triagedAt` 由 triage 回写）。

**投递（R5）**：`report.to` 存在且目标不在 `protect` → `collab_send`（`kind:note`、`queue`）一条
`[defect] <sig> <一句话> → <证据路径>`；未配置 / `enabled:false` / 目标受保护 → 只落盘。
上报失败（写盘/投递）只记日志，**绝不改变工具返回值或抛出**（R7）。

**可发现性（R8）**——不需要读文档也能在报错当下看到入口：

1. 非校验类错误文案末尾追加 `提示: 若怀疑是插件缺陷，运行 collab_report { confirm:true } 上报现场（或看 <reportDir>）`；
2. `collab_list` 最后一行固定 `缺陷上报：collab_report { confirm:true }（证据目录 …）`；
3. `collab_report { note?, bid?, threadID?, confirm }` 手工补一条（`confirm:false` 只预览签名与目录）；
4. 插件 `setup` 日志（stderr）打印 `reportDir=<路径> report.to=<别名或 (unset)>`；
5. 本文件 / README / `skills/collab/SKILL.md` 各有一节「遇到异常怎么办」；
6. CHANGELOG 顶部写明支持缺陷上报。

**挂起监控（R6）**：`collab_list` 与 `context` 注入各输出一次（按 `(session, class, bid)` 去重，
跨命令/跨重启共享存储 `collab/stale-seen/<sid>`）：

| 类 | 条件 | 提示 |
| --- | --- | --- |
| `open-stale` | `state=open` 且 `now-createdAt > 1h` | 无人领取：重新广播或人工指定 |
| `claimed-lapsed` | `state=claimed` 且超租约 | 承接方未确认：顺延或人工指定 |
| `acked-stale` | `state=acked` 且 `now-claim.at > 2h` | 回执静默：发起方可只读提取收口 |

只读：不 refresh、不释放锁、不自动闭环。注入里挂起提醒排在链路提醒**之前**（链路 refresh 会把超时的
`claimed` 重开，排后面就看不到那一类）。

**维护方消费端（R9）**：`node scripts/collab-triage.mjs`

```bash
node scripts/collab-triage.mjs --dry-run                 # 只看：哪些签名待处理、会写哪个 issue
node scripts/collab-triage.mjs                           # 生成/刷新 docs/issues/bugs-collab-<sig>.md
node scripts/collab-triage.mjs --since 2026-11-18T00:00:00Z
node scripts/collab-triage.mjs --notify collab-maintainer # 额外补投一条 note（需 COLLAB_SERVER_URL）
```

- 按 signature 归并，未处理（`triagedAt` 早于最新证据）才写；`triagedAt` 回写 `index.json`；
- 幂等：重复运行不重复建 issue（内容重建但保留人工改过的 `> 状态：` 行）；
- 并发安全：`<reportDir>/.triage.lock`（`open 'wx'`，10 分钟视为过期）；
- `--notify` 走 `POST /api/session/{sid}/prompt`，需要 `COLLAB_SERVER_URL`（+ 可选 `COLLAB_SERVER_TOKEN`），
  目标命中 `protect` 时拒绝；
- 被动提示：维护方会话（`report.to` 指向它）的 `context` 注入与任何会话的 `collab_list` 会显示
  「未处理缺陷上报 N 条」（每会话一次，数量增长才再提示）。

cron 由 owner 决定是否安装（脚本本身不自动跑）：

```cron
# 每 15 分钟补投一次未确认上报（先确认 COLLAB_SERVER_URL / COLLAB_SERVER_TOKEN 已配置）
*/15 * * * * cd /data/project/collab && node scripts/collab-triage.mjs --notify collab-maintainer >> /tmp/collab-triage.log 2>&1
```

**边界**：不上传网络（除 `report.to` 的单条 `note`）；不新增依赖；不改 `BUILTIN_PROTECT`；
不自动关闭挂起单（只提示/上报）。回滚 = 删 `collab-reports/`、配置去掉 `report`、`git restore -- src/`。

### 11.9 送达确认（ack）、受限重发、闭环后追加（0.1.6）

**为什么需要**：本机 50 个会话、900h+ 常驻，单轮可达数十分钟，单个会话 token 可到 5774 万。
「对方这一轮跑完 = 送达」既太晚也不可靠，而盲目重投会把同一件事排两次队。所以送达拆成两级，
重发严格受限，闭环后的补充结论改为**拉取**。

#### 11.9.1 两级 ack

| 级别 | 谁记录 | 含义 |
| --- | --- | --- |
| `admitted` | 发方（记录 `delivery.messageId` / `admittedAt`） | 宿主收下了这条消息：`session.prompt` 返回了 `message.id`，或接管请求已写进记录、等收方下一次 `context` 注入 |
| `seen` | 收方（回执 `[ack] <cid> seen`） | 收方插件**第一次**把它送到模型面前（`context` 注入或 `collab_inbox` 读到），`kind=note`、`queue`、旁路发送 |

- 收方视角：注入/`collab_inbox` 里出现的消息即视为已见 → 回 `[ack] <cid> seen`（同一个 `cid` 只回一次）。
  发 ack 失败只记日志，**不影响收方任何流程**。
- 发方视角：事件流解析 `[ack] <cid>` → `record.delivery.seenAt = now`。只有 `delivery.to` 指向的那个会话能确认，
  旁观会话伪造的 `[ack]` 会被忽略。
- 防环：`[ack]` 消息自己不会再产生 ack；`collab_inbox` 把它标成 `system-ack`，`context` 注入**不展示**它。
- **受保护发起方（R4）**：往受保护会话投递本就受限，`seen` 不可能回来 → 记录直接标
  `delivery.ackUnavailable=true`，**不重试、不报错**，回执走 pull / 提案文件（§11.4.1）。

#### 11.9.2 受限重发（最多 1 次）

只有**发方自己**下一次 `context` 注入时会评估（`resendIfDue`，`actor === record.from.sid`）：

```
delivery.cid 存在 && !seenAt && resends < 1
&& (admitted 失败（failedAt） 或 now - admittedAt > 2h)
&& 目标当前 idle && !ackUnavailable
→ 重新 prompt（同一个 cid、queue），resends++
```

- **busy 目标永不重发**：它已经握着这条消息，只是还没开下一轮；再投只会堆队列。
- 同 `cid` 幂等：收方 `extractInbound` 按 `cid` 去重，重发不会变成第二条消息。
- 预算用满、窗口又过、仍然没有 `seen` → `delivery.unacked=true`；
  `collab_list` 会单列一行「未确认送达（…）→ 可人工补投」。
- 旧记录（≤0.1.5 写入、没有 `delivery`）一律视为「admitted、没有 ack 能力」，**永不重发**。

#### 11.9.3 闭环后追加 = 写提案文件 + pull hint

闭环（`done`/`blocked`）**不是**再往对方输入流里塞内容的许可：

```text
① 承接方把结论写进提案文件（单一真源）：  <提案> 里的 `## 闭环后追加（<date>）`
② 承接方登记指针：                       collab_followup { bid:"b_…", confirm:true }
   → record.followUps[] += { bid, issuePath, at, by }（只存结构，不存正文；每单上限 3 条）
③ 发起方（含受保护线）下一次 context 注入看到一行只读提示：
   - b_xxx 已闭环，提案 docs/issues/xxx.md 有追加结论（09:53:43），请读取文件
```

- **只存结构**：`followUps[] = { bid, issuePath, at, by }`。任何自由文本都不落记录、不进注入——
  否则任何会话都能借这条通道往 protect 会话的 context 塞话。
- **路径校验（写入与渲染各一次）**：**先规范化**——丢掉空段与 `.`、合并重复 `/`，所以
  `./docs/issues/x.md`、`docs//issues/./x.md` 与 `docs/issues/x.md` 是同一个文件；
  再要求 realpath 落在该记录 workspace 的 `docs/issues/<name>.md`。只拒 `..`、绝对路径、
  非 `docs/issues/`、非 `.md`、软链；控制字符/换行一律剔除、上限 200 字。
  校验失败 → **整行不渲染**（不做降级拼接），写入口直接拒绝并给出原因；
  写入时 `issuePath` 若只含空白/控制字符直接报错，不再回退到记录自带的提案（0.3.1）。
- **权限**：只有该单 `claim.by` 能登记；发起方与旁观会话一律拒绝；`expired` 也不接受（需人工接手）。
- **不投递、不改 state、不改 receipt、不重开 bid**：记录只是多了一个「有追加」的指针。
- **去重粒度是 `(sid, bid, followUp.at)`**：同一单的第二条追加会在下一次注入里再提示一次；
  每次注入最多 1 行。
- **跨类去重（0.4.1）**：受保护会话的注入把这条提示与 §11.12 的 `[owner-queue]` 行**合并**后按提案
  （共享任一 `issuePath` / `bid` 键，含传递）去重，只渲染 `at` 更新的一条；被去重掉的条目不标记，之后仍会提示（§11.12.1）。
- **标记时机（0.3.1 F1）**：提示行**先进入本次请求，再标记**。`context` hook 在
  `event.system.push(...)` 成功之后才 `markFollowUpSeen`；注入抛错（或宿主没接住这块）→ **不标记**，
  下一次请求自然重试。旧实现是「先标记、后投递」，等于一次没有投递确认的 at-most-once。
- **无效路径不静默（0.3.1 F2）**：路径校验失败的条目**不标记**、也不渲染；`collab_list` 汇总
  「N 条 followUp 因路径无效未渲染」（同一会话按无效条目集合去重，集合变化才再提示一次），
  条目本身只显示 `bid` + 时间、**不回显路径文本**。把提案修回 `docs/issues/` 后，下一次注入就会提示。
- **protect 的窄化白名单**：受保护会话的 `injectionFor` 仍然**只**返回这一类只读提示行
  （条件：`record.from.sid === 自己` 且存在未提示的 followUps）；不是「放开注入」，而是单独的
  一个函数产出、单独的返回分支，其它任何提醒都不进受保护线。

#### 11.9.4 正文去重（0.6.0）

记录层一直只对 `cid` / ack 幂等：同一 thread 在 15 秒内用同文调两次 `collab_send`，两次都会真的投递
（实测）。0.6.0 起加一层**内容幂等**，只作用于 `collab_send` / `collab_reply`：

| 项 | 规则 |
| --- | --- |
| 键 | `threadID + 归一化正文`（`\s+` → 单个空格、`trim`）——空白/换行不同视为同一句 |
| 窗口 | `dedupeWindowMs`，默认 **60000（60s）**；`0` 关闭（回滚开关） |
| 判据来源 | ① 交接记录的最近 3 条 `replies`（限界回执落在这里）；② thread 自己的消息列表（持久，插件重载后仍有效，只看尾部 20 条）；③ 进程内 memo（没有 thread 消息时兜底，重载即清空） |
| 命中 | **不投递、不追加 thread 消息**，返回写明「未重复投递 … 60s 内已有同文（去重窗口）」并给出读回方式 |
| 不适用 | 预览（`confirm:false`）本来就零写入；`collab_escalate` 用自己 5min 窗口，不叠加 |

去重只发生在**同一 thread**：不带 `threadID` 的 `collab_send` 每次都是新 thread，因此不会被当成重复
（想「再说一遍」就换 thread 或改措辞）。跨机器不去重（进程内 memo 与本地 thread 存储各管各的）。

### 11.10 资源租约（`collab_lock` / `collab_unlock` / `collab_locks`，0.2.0）

**为什么需要**：同工作区的并行会话常抢**同一件东西**——pytest 窗口、同一个
`store.ts`、全量构建。0.1.x 只能靠 `collab_send` 自然语言协商：排钟会话占了窗口 10+ 分钟，
issues 会话两次请求都没等到释放，最后只能 `ps` 猜。租约把这件事变成**可判定**的状态。

```jsonc
// ~/.config/opencode/collab-locks/<sha256(resource)[0..16]>__<slug>.json
{
  "resource": "named:test-window",
  "kind": "named|file|build",
  "mode": "exclusive|shared",
  "holder": "ses_…",
  "holders": ["ses_…"],
  "reason": "全量 pytest",              // 可选，≤200 字，去控制字符
  "acquiredAt": 0, "ttlMs": 900000, "expiresAt": 0,
  "waiters": [{ "sid": "ses_…", "at": 0, "mode": "exclusive", "reason": "…" }],
  "history": [{ "sid": "…", "at": 0, "event": "acquire|release|expire|wait|leave" }]
}
```

**状态机**（与 handoff 的 `open/claimed/acked/done/blocked/expired` **完全分离**，
只共享读取层）：

```text
free ──acquire──▶ held ──release──▶ free
                   │
                   ├──expire──▶ free            （下次访问时判定并写 history）
                   └──shared join──▶ held(holders+1)

被占用时的申请：held ──request(wait:true)──▶ waiters[]（FIFO）
waiters 不会被主动叫醒（避免打断）；按顺序在下次 collab_locks / collab_lock 时获知
waiters[].at 是**心跳**（不是入队时间）：超过 waiterTtlMs 没心跳 → 下一次 acquire 回收
```

#### 11.10.1 资源名规范化

| 输入 | 归一化 |
| --- | --- |
| `test-window` / `窗口` / `测试窗口` / `窗口:测试` | `named:test-window`（小写、去空白、中文别名表） |
| `build` / `全量构建` | `named:build` |
| `file:packages/state/src/store.ts` / `packages/state/src/store.ts` | `file:packages/state/src/store.ts` |

- `file:` 必须是 **workspace 相对路径**：绝对路径、`..`、`.` 段一律拒绝；
  已存在的文件 `realpath` 必须仍在 workspace 内、且**不是软链**；
  尚未创建的文件允许（`file:packages/x/not-yet.ts`），但最近的存在祖先仍要落在 workspace 内。
- 一个资源 = 一个文件（`<hash>__<slug>.json`）；四种写法归并后只会有一个文件、一个 winner。

#### 11.10.2 原子性与幂等

- 申请 = `open(<file>.lock, "wx")` 抢**短锁** → 读记录 → 判定 → `tmp+rename` 写记录 → 释放短锁；
  短锁 2s 超时，超过 2s 的遗留短锁视为崩溃残留并清理（最坏情况是无保护推进，记录写仍是原子替换）。
- 并发 N 个 `exclusive` 申请同一资源 → **只有一个 winner**，其余立即拿到「持有者 + 剩余 TTL」。
- 同一会话重复申请同一资源 → **幂等**：返回既有租约，`holders` 不重复、TTL 不延长、历史不新增。
- TTL：默认 900000ms（15min），夹在 `[10000, 7200000]`；`collab_locks` 里过期即显示 `free`，
  下一次 `collab_lock` 回收并写 `history: expire`。

#### 11.10.3 排队（FIFO，不插队）

- `wait:true` 且资源被占 → 入队并返回排位；重复 `wait` 只刷新 mode/reason 与**心跳**，保留队列位置（顺序不变）。
- 持有者释放后资源变 `free`，**队列保留**；新人（没排过队）在 `wait:false` 时会被拒绝
  （「资源空闲，但有人在排队」），`wait:true` 则排到队尾。
- 队首再次 `collab_lock` 即获得（出队）；不会有人主动叫醒你——这是刻意的：
  锁不得打断任何会话，也不得投递消息。
- **`free` 但有 waiter ≠ 被占用**：`collab_locks` 里的 `free` + `waiters=…` 表示「没人持有，只是有人在
  排队」，与 `held` 是两件事（见 §11.10.6 与「四个数」§11.11）。
- 排队者不是租约：**它不持有任何东西**，也不会阻止持有者释放；队列只是「谁先到」的记录。

#### 11.10.4 安全边界

- `[protected*]` 会话**可以持有**租约；冲突输出会标 `[protected]` 并注明「不可抢占」。
  `collab_unlock` 只有持有者能调，**没有 force**：抢占是人工决定。
- `reason` / 资源名都会剔除控制字符并截断；`collab_lock` 的 `mode` 只接受 `exclusive|shared`。
- 锁是**纯本地状态**：不加锁不会阻塞消息投递，锁也不替代 git 操作；它只服务**自愿**协调。

#### 11.10.5 典型用法

```text
# 1) 先看窗口在谁手里（只读）
collab_locks { resource: "test-window" }

# 2) 申请 10 分钟（confirm:true 才写；否则只预览当前持有与将写入字段）
collab_lock { resource:"窗口", mode:"exclusive", ttlMs:600000, reason:"全量 pytest", confirm:true }
#    → 已获得资源租约: named:test-window ...
#    → 未获得资源租约: … holders=ses_x 剩余=8m 后到期（可选 wait:true 排队）

# 3) 被占又必须等 → 排队（FIFO，无叫醒）
collab_lock { resource:"test-window", wait:true, confirm:true }
collab_locks { resource:"test-window" }        # 轮到你时 free；再次 collab_lock 获得

# 4) 跑完立刻释放（异常退出也要补）
collab_unlock { resource:"test-window", confirm:true }
```

`collab_list` 会为当前会话追加一段「我的资源租约 / 排队中（第 N 位）」，
不必再问对端或 `ps`。

**等待队列上限**：每个资源最多 **50** 个等待者；满员时**拒绝新申请**（返回可读错误，不驱逐已排队者，
队首排位不变）。
**损坏记录**：`expiresAt` 缺失或 ≤0 视为损坏，下次访问时回收并写 `history: { event:"expire", reason:"invalid" }`。

#### 11.10.6 排队心跳、回收与 `[stale]`（0.6.0）

**为什么**：`LockWaiter` 原来没有 TTL、也永不被唤醒，只有**本人**再次 acquire/release 时才出队。于是
「排过一次队、然后再没回来」的会话会让一个**空闲**资源对所有人不可用（`资源空闲，但有人在排队`）——
一晚实测误判 ≥3 次。

| 规则 | 行为 |
| --- | --- |
| `at` = 心跳 | 不再是入队时间；每次心跳刷新为「现在」。旧记录（≤0.5.3）等同「很久没心跳」，会被回收 |
| 心跳来源 ① | 同 sid 再次 `collab_lock`（含 `wait:true` 重排） |
| 心跳来源 ② | 该会话的 `context` 钩子，**每轮一次**（`waiterHeartbeat:false` 关闭） |
| 心跳来源 ③ | 该会话的 **`collab_lock` / `collab_send` / `collab_reply` / `collab_handoff` / `collab_broadcast`** 调用顺手 touch；`collab_accept` / `collab_request_owner` / `collab_followup` / `collab_grant` / `collab_promote` / `collab_report` / `collab_archive` **不**刷新（它们不代表「我还在等」） |
| 节流 | 心跳写入 ≥30s 一次（`LOCK_WAITER_TOUCH_MS`）：长回合不会把同一个文件写成千上万次 |
| 回收 | **只在 `acquire` 写路径**（`reapWaiters`）发生：`now - at > waiterTtlMs` 的排队者被删，写 `history: { event:"leave", reason:"stale" }`；回收后再做公平性判定 → 僵尸 waiter 不再挡路 |
| 只读 | `collab_locks` / 侧栏快照**不回收、不写文件**，只显示年龄与 `[stale]` |

`collab_locks` 的排队段现在带年龄：`waiters=ses_a#1:exclusive(12m),ses_b#2:exclusive(0s)[stale]`。
`(12m)` 是距上次心跳的时长，`[stale]` 表示已超 `waiterTtlMs`（下一次 `collab_lock` 会回收它）；
`free` 且存在 `[stale]` 排队者时，头部还会写「其中排队心跳过期 N 人」。**年龄大的排队者不占位**：
它只是「还没被回收」，不是「资源被占用」。

活的心跳（< TTL）仍按 FIFO 排队，不会被插队；只有 `waiterTtlMs` 设到上限 60min 才接近旧行为。

### 11.11 状态视图：桌面侧栏 + TUI（0.3.0 / 0.4.2 / 0.5.1 / 0.5.2 / 0.5.3 / 0.6.0，experimental）

> GUI 侧栏只在 **OpenCode Desktop** 的图形窗口里出现；**TUI 用 `/collab`（或 `collab_locks` /
> `collab_list` 的文本视图）**。宿主 GUI API 标注 experimental，版本区间见 README「版本兼容」。

侧栏/TUI 回答的是「现在全局在发生什么」：谁持有资源、谁在排队、哪些交接还没闭环、我给受保护会话
排了哪些请求。数据来自插件 **server 部分**自己，不经过第三方端口：

```text
src/index.ts (server part)  ── ctx.rpc.register(CollabState, { snapshot }) ──▶  HTTP RPC
        │                       collab.state.snapshot({ workspace?, session? })
        │                                        │
        └── stateOf(allLocks) + allBroadcasts + mineFor(session) ──────────────┘
                                                 │        （与 collab_locks / collab_list 同一读取层）
        ┌────────────────────────────────────────┴───────────────────────┐
        │                                                                │
src/gui.tsx (./gui-experimental)                        src/tui.tsx (./tui)
(ctx.sessions.current().server?.client ?? ctx.client)    ctx.client.rpc(CollabState).snapshot({ session })
  .rpc(CollabState).snapshot({ session? })               TUI 里画 collab.status 面板 + 侧栏一行摘要
桌面窗口里画侧栏 + composer pill
```

**契约**（`src/rpc.ts`，一个只读方法、无事件）：

```ts
{
  at: number,                              // 快照时间
  reachable: true,                         // server 真的回答了
  sessions: [{ sid, title, agent, busy, workspace, parent? }],
  locks:    [{ resource, kind, mode, holders, waiters, waiting, expiresInMs, waiterAgeMs?, staleWaiters?, stale?, reason? }],
  handoffs: [{ bid, state, ageMs, from, claimBy?, workspace?, title }],
  queue:    [{ queueId, target, ageMs, summary, issuePath?, bid?, seen }]   // 0.4.2：{ session } 限定
}
```

- `waiters` 是队列长度，`waiting` 是排队会话 id（FIFO 顺序）——只有长度无法判断「**我**是否在排队」，
  而 composer pill 需要这一点。
- 0.6.0（R3）：`waiterAgeMs` 是每个排队者的**心跳年龄**（与 `waiting` 同序），`staleWaiters` / `stale`
  标出超过等待 TTL 的那些。三个字段都是**可选**的：老 server 不返回、客户端不得假设存在；快照照旧
  只读（年龄只用于显示，回收仍只发生在 `collab_lock`）。
- **四个数**（0.6.0；GUI 会话头 / TUI 侧栏 / TUI 面板同一口径，实现见 `src/core/counts.ts`）：

  | 数 | 含义 | 来源 |
  | --- | --- | --- |
  | 持有 | **有持有者**的资源数（`holders.length > 0`），排队者不算 | `countsOf().held` |
  | 排队 | 所有资源的 FIFO 排队人数之和 | `countsOf().waiting` |
  | 待受保护 | 本会话提交给受保护目标的 owner-queue 条数（面板旧称「队列」） | `countsOf().protected` |
  | 宿主排队 | 宿主自己的 prompt 队列（`delivery:"queue"`） | `ctx.data.session.pending.list(sid)`（GUI：`server.data…`，首次 `pending.sync` 一次） |

  旧会话头的 `锁 N` 是 `locks.length`（「值得显示的行数」）：`free` 但有一个僵尸排队者的资源会被算进去，
  读起来像「N 个持有者」。现在「持有」只数持有人，「排队」单列；`free 但有 waiter` 也不再被当成被占用。
- `queue` 是**调用方自己**提交给受保护会话的请求（`mineFor(session)`，与 `collab_list` 同一来源）；
  不传 `session` 就是空数组——绝不扫全表，也不会把别人的请求列出来。`revokedAt` 的条目不出现。
- **不新造状态**：`locks` 由 `stateOf()` 渲染（过期的在视图里就是 `free`，不落盘、不回收）；
  `handoffs` 只取未决的（`done` / `blocked` / `expired` 不算「未闭环」）。
- 空记录（无人持有、无人排队）不出现；归档会话不列。

**GUI UI**：

| 位置 | 内容 |
| --- | --- |
| 命令 `collab.open`（0.5.1） | 命令面板与 **Settings → Shortcuts** 可见；默认键 `mod+shift+l`（与 TUI 的 `ctrl+shift+l` 同义），`/collab` 也可触发；`enabled` 跟随当前路由到的会话，仅在会话里可用；执行 = `ctx.layout.open("collab:main", session)`。**只有打开面板这一个动作** |
| 会话头计数条（0.5.1；0.6.0 起四个数） | `持有 N · 排队 M · 待受保护 K · 宿主排队 J`（与面板**同一个 store / 同一次 2 s 轮询**；口径见上文「四个数」），点一下开面板；无快照时**整条不渲染**（不显示 `0`），server 不可达时 `collab: n/a` 且仍可点（面板里有横幅与原因）。这次轮询带 `session: <路由会话>`，否则 `queue` 按契约恒为空；`宿主排队` 不经过 RPC，直接读宿主已同步的 `server.data.session.pending`（首次 `sync` 一次，失败静默 0） |
| 标题栏 pill（0.5.2） | 常驻：无快照时就是 `collab`（**不显示 `0`**），有快照时 `collab N`（N = 租约 + 未闭环交接 + 本会话队列）。**有路由会话** → `ctx.layout.open("collab:main", session)`；**没有会话** → `ctx.toast.show` 弹「Collab GUI 已加载」（`probe.description` 含插件版本 / `id` / 面板 key / app 版本、platform 与数据源 `server=`）。它同时是本插件在窗口里的**自证**：弹得出来 = GUI 加载了，弹不出来 = 这个窗口没加载。只读（`toast.show` + `layout.open`） |
| 数据源（0.5.3） | 快照请求走**当前路由会话所属服务器**：`ctx.sessions.current()?.server?.client`，缺失（老宿主 / 无 `server`）时回退 `ctx.client`。远端会话 → 远端服务器的 `collab.state.snapshot`（`session` 参数仍是该远端会话 id）；本机会话 → 本机 sidecar。跨服务器/跨会话切换**立即**以新 client 重请求，上一台服务器的迟到回包**丢弃**（见 §11.11.5）；面板顶部在远端时显示 `@<server.id>`，本机不显示（避免噪音） |
| 侧栏 `collab` 面板（`region:"side"`, `width:"narrow"`） | 按工作区分组：会话（title/agent/busy）、持有租约（模式 + 剩余 TTL）、FIFO 排队、未闭环交接（bid/state/age）。租约本身是全局的，按「第一个是已列会话的持有者/排队者」归到对应工作区，否则落「全局」组 |
| composer pill | 当前会话「锁 N · 等待 M」；`success` 只持有 / `warning` 排第 1 位 / `danger` 排在更后面。展开是逐条租约（只显示，不可操作） |
| 刷新 | 有会话挂载时每 2 s 一次；**窗口隐藏时停止**、恢复可见后立即以当前会话继续（监听 `visibilitychange`，0.5.2 起；以前读 `document.hidden` 不是响应式的，隐藏不真停、隐藏时挂载的窗口也永不启动）；面板、pill、计数条、标题栏 pill 共用一个轮询与一份 store。0.5.2（R-7）：本轮请求发出后会记住目标会话，回包时若路由会话已经变了（且未隐藏 / 未 dispose）就**补排一次**——切换瞬间恰好有请求在飞也不会把新会话的 `queue` 压到下一个 tick；`inFlight` 仍然防并发，未切换不补排。0.5.3：轮询 key 改为 `${server.id}\n${session.id}`，切换服务器即重建；请求前后比对 key，不一致的回包丢弃 |
| 不可达 | RPC 被 reject（server 停 / 插件禁用 / 版本不匹配）→ 顶部「server 不可达：<原因>」，**保留上一份快照**；server 部分与工具完全不受影响 |

**TUI UI**（0.4.2 / 0.5.1）：

| 位置 | 内容 |
| --- | --- |
| `/collab`（`ctrl+shift+l`，也在命令面板里） | 打开 `session.panel` 里的 **`collab.status`** 面板；没有打开的会话时提示「先打开一个会话」 |
| 面板 | 首行时间戳 + **四个数**（`持有 · 排队 · 待受保护 · 宿主排队`）+ 一行图例（0.6.0）；三块等宽表格：`资源租约`（resource / mode / holders / 剩余 TTL / waiters）、`未闭环交接`（bid / state / age / from）、`受保护目标队列`（queueId / target / age / status）。窄终端（<48 列）每个条目拆成两行 |
| 侧栏摘要（0.5.1；0.6.0 起四个数） | 一行 `▸ 锁 N · 排 M · 待 K · 宿 J`（紧凑写法的持有/排队/待受保护/宿主排队）；**点击摘要行**就地展开（`▾`）最多 4 行明细（锁 → 交接 → 队列，超出的以 `+N` 结尾），**点击明细行**打开 `/collab` 面板，再点摘要行折叠。RPC 不可达时 `collab: n/a`（不假装 0），展开行读 `collab: n/a · 点击打开面板` |
| 刷新 | 面板打开时每 2 s 一次；**面板关闭或切到别的插件的面板就停**（定时器属于面板这次渲染）。侧栏只在挂载时 load 一次，**展开/折叠不新增轮询** |
| 不可达 | 顶部「RPC 不可达：<原因>」；有上一份快照就继续显示并标注；一份都没有时退化为「宿主自己的会话列表 + 仅显示本地会话列表」，不白屏、不崩 |

**只读**：GUI 面板与 TUI 面板都没有加锁/释放按钮。取锁、排队、释放仍然只有 `collab_lock` / `collab_unlock`
（以及 `skills/collab-coordination` 的规程）；TUI 面板只有渲染，没有写路径。0.5.1 的两个桌面入口
（命令、会话头计数条）与 TUI 的展开行同样只有一个动作：**打开面板**；0.5.2 的标题栏 pill 只有
`layout.open` 与 `toast.show` 两个调用（后者仅在**没有路由会话**时，用来自证加载）。

**构建**：

| 产物 | 出口 | 构建 |
| --- | --- | --- |
| `dist/gui-experimental.cjs` | `exports["./gui-experimental"]` | `vite.gui.config.ts`（宿主的 `gui()` preset：编译 Solid JSX、内联动态 `import()`、宿主模块留 external） |
| `dist/tui.js` | `exports["./tui"]` | `vite.tui.config.ts`：`generate:'universal'` + `moduleName:'@opentui/solid'`，把 `@opencode/*`、`@opentui/*`、`solid-js` 全部 external |

`pnpm build` = `vp pack`（server）→ GUI → TUI。**任一副产物构建失败都不影响 `dist/index.js`**（server 零依赖、
工具与注入不变）。宿主侧的 TUI peer（`@opentui/core` / `@opentui/solid` / `solid-js`）由 OpenCode 自己提供，
本包只在 `peerDependencies` 里声明（optional）。

**关闭**：Settings → Extensions → Plugins 里关掉本插件的 GUI 开关；`opencode.json(c)` 里移除插件
则连 server 一起停。TUI 是宿主自己加载的部件，`cli.json` 里移除 TUI-only 条目或禁用插件即消失。

#### 11.11.1 GUI 首启看不到侧栏（0.4.2 修复）

0.3.0–0.4.1 的判定是「**不是 `closed` 就算打开**」：

```ts
opened: !!session && ctx.layout.state(`${ctx.id}:${PANEL_TAB}`, session) !== 'closed'   // 旧
list: input => (input.open.includes(PANEL_TAB) ? [tab] : [])                           // 旧
```

首次进入某个会话时 `layout.state` 是 `undefined` → `!!= 'closed'` 为真 → **「+」菜单认为面板已打开**、
不再提供入口；而 `list` 只在「已经打开」时返回标签 → **既没有标签，也没有入口**，面板永远打不开
（远端 `GET /api/plugin/gui?id=collab` 明明能返回 bundle，所以不是 server 侧问题）。

0.4.2 起：

| 规则 | 行为 |
| --- | --- |
| **R1 入口判定** | `opened` 改为 `layout.state(...) === 'open'`；`undefined` / `closed` 都算未打开 → 「+」菜单重新提供「打开协作面板」 |
| **R2 默认可见** | `list` 在 `options.autoOpen !== false`（默认 `true`）时**恒返回** `collab` 标签；置 `autoOpen:false` 则回到「只从 + 菜单打开」 |
| **R3 不可达** | 默认展示 + RPC 被 reject 时显示「server 不可达：<原因>」，保留上一份快照，不崩 |

#### 11.11.2 排查：看不到侧栏 / 面板

按顺序四步，每步都能独立判定：

```text
1) 插件是否真的加载了？   opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"
   → 列表里应有 collab 且没有 failed（failed 会带原因）
2) 开关是否打开？         Desktop: Settings → Extensions → Plugins → collab 的 GUI 开关
   → 关掉只影响 GUI/TUI 的视图，server 工具仍在（也可在 opencode.json 里 autoOpen:false 验证）
3) 入口在哪？
   Desktop：命令面板搜「collab」/ mod+shift+l / 会话头计数条 / 标题栏 collab pill / 会话右侧栏的「+」菜单
   TUI    ：/collab（或 ctrl+shift+l），或点侧栏摘要行展开；再不行用 collab_locks / collab_list 的文本视图
4) Desktop 远端窗口：插件行没有 GUI 开关是预期行为（宿主只加载本机 sidecar，0.5.3 已确认）——
   把插件装到本机，再用标题栏 pill 自证是否加载（0.5.2）——见 §11.11.4
```

远端部署（Desktop 连 Linux server）时，GUI bundle 由 **远端** server 提供：
`GET /api/plugin/gui?id=collab` 返回 `dist/gui-experimental.cjs`——但宿主**不会**为远端窗口加载它
（§11.11.4）。本机安装后这条请求走本机 sidecar；本机请求 200 但窗口里没标签 → 是 §11.11.1
的入口判定问题（0.4.1 及更早）；请求本身 404/500 → 先修 server 侧（插件未加载或产物缺失）。裸调这个
端点得到 **401** 不说明任何事（它只接受 app 主进程的凭据）。

#### 11.11.3 入口（0.5.1）：命令、会话头计数条、侧栏折叠

0.4.2 仍然有两处「存在但看不见」：Desktop 只注册了 `Panel` / `MenuItem` / 条件出现的 `ComposerPill`，
**没有 `Command`**——命令面板搜不到、没有快捷键，右侧面板区没打开时用户看不到任何 collab 痕迹；
TUI 的 `sidebar.content` 只是一行静态 `<text>`，没有点击/展开。0.5.1 只在宿主**已有的**槽位里补入口，
不伪造左侧应用侧栏（GUI SDK 没有这个槽位）：

| 面 | 补的东西 | 为什么在这个槽位 |
| --- | --- | --- |
| Desktop | `Command { id:"open", bind:"mod+shift+l", slash:{name:"collab"}, section:"navigation" }` | 宿主把命令发布成 `collab.open`，命令面板与 Settings → Shortcuts 都可见；`bind` 只是默认值，用户可改 |
| Desktop | `Slot at "session.header"` → `持有 N · 排队 M · 待受保护 K · 宿主排队 J`（0.6.0） | 会话标题行本来就一直渲染，无需用户先打开任何面板；读的是面板**同一个** store |
| TUI | 摘要行 `onMouseDown` 展开/折叠 + 明细行 `onMouseDown` 开面板 | OpenTUI 的 renderable 支持鼠标事件，宿主负责把事件派发到命中的行 |

两条降级路径（都不抛错）：

1. **宿主没开鼠标**（或终端不支持）：TUI 的 `▸`/`▾` 与明细行点不了，`/collab` 与 `ctrl+shift+l` 照旧可用；
   Desktop 侧的命令（键盘 / `/collab`）与计数条（键盘可达的按钮）也都不依赖鼠标。
2. **宿主把 `sidebar.content` 固定为一行高度**：展开内容会被**裁剪**（不是崩溃、不是覆盖别的行），
   用户仍看到 `▾` 摘要行与正确数字；此时请用 `/collab` 看全量明细。这是宿主的槽位高度策略，
   插件侧不做高度协商（那会越过槽位边界）。

不变的部分：`Panel` 的 `list` / `autoOpen` 语义、`MenuItem.opened === 'open'` 的判定、`ComposerPill`
的显示条件与 0.4.2 完全一致；没有新增轮询——计数条与展开行都从已有 store / 已有快照派生。
0.6.0 只给快照**追加了可选字段**（`waiterAgeMs` / `staleWaiters` / `stale`，见上文）与四个数的口径，
既有字段语义不变；`宿主排队` 读宿主已同步的数据，仍不是第二条 RPC 流。


#### 11.11.4 Desktop 排查（0.5.2 / 0.5.3）：插件行没有 GUI 开关 / 界面里没有 collab

**结论（0.5.3 已用桌面端源码验证）**：桌面端（2.3.x）的 GUI 宿主**只跟踪本机 sidecar**。`out/main/host-*.js`
里解析服务器 URL 的函数（`D = () => pe()`）返回的是本机地址，`subscribe-credentials` 用它；按 serverId
取凭据的 `ie(serverId)` 只有 `id === 'sidecar'` 分支会返回凭据。宿主对 `plugin.list()` 过滤
`features.gui && active && 非 builtin`（`rt()`）后调 `plugin.gui({ id })` 取 bundle——**请求永远打向本机**。

因此：

- **装在远端服务器上的插件，其 GUI 部分永远不会被窗口加载**：设置页只有名字、没有 GUI 开关，
  标题栏也没有 pill。这是平台行为，不是本插件的缺陷，也不是权限/产物问题。
- **可行路径是「装到本机」**（见 README「Desktop 如何让它出现」）：本机 sidecar 有插件 → 窗口加载 GUI；
  用户打开远端会话时，GUI 用**该会话所属服务器**的 `ServerRef.client` 去读远端数据（§11.11.5）。
- **本机没装插件时，远端窗口仍然「无 GUI」**——0.5.3 不改变这一点（不伪造左侧栏、不改桌面端）。

排查步骤（针对**本机**是否加载）：

| 步骤 | 看什么 | 说明 |
| --- | --- | --- |
| ① | Settings → Extensions → Plugins → **collab** 一行有没有 GUI 开关 | 有：关掉只影响视图，工具仍在；**没有**（且本机确实装了插件）：先做 ②–④ |
| ② | 命令面板搜「collab」 | 能看到 `collab.open`「打开协作面板」= `Command` 已注册（0.5.1 起） |
| ③ | 标题栏有没有 **`collab` pill** | 0.5.2 新增、常驻；无数据时就是 `collab`（不显示 `0`），有数据时 `collab N` |
| ④ | **没有打开会话**时点 pill（或 `/collab` / `mod+shift+l`） | 弹「Collab GUI 已加载」toast = **GUI 确实加载了**；什么都不弹 = 这个窗口没加载本插件的 GUI |

判定：

- **本机装了插件但 ①②③ 都不成立** → 先确认安装目标是本机（`opencode plugin add` 在 Desktop 所在机器执行），
  再确认装完**重启过** Desktop（GUI 宿主在 app 启动时读插件清单）；最后查
  `opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"`（本机列表里应有 `collab` 且没有 `failed`）。
- **远端窗口没有 collab** → 预期行为（见上）。用 `@<server.id>` 与 toast 里的 `server=` 确认数据源，
  而不是找 GUI 开关。
- **能看到 ③ 的 pill，但点它没反应、也没有 toast** → 注册成功但点击路径没被派发，记录 app 版本与
  platform（toast 里本来就有），作为上游问题另提。
- **④ 弹了 toast** → 本插件 GUI 端到端可用；进入任意会话，pill 的点击就会变成
  `layout.open("collab:main", session)`。

toast 的文案是 `ctx.t('probe.title')` + `ctx.t('probe.description')`，`variant:'success'`，例如
`插件 v0.5.3 · id=collab · panel=collab:main · app=2.5.0(desktop) · server=this computer`——插件版本、
面板 key、app 版本、platform 与**数据源服务器**都在里面（无路由会话时数据源就是本机 sidecar，所以是
`this computer`；面板顶部的 `@<server.id>` 显示远端）。排查时直接抄这一行即可
（`test/gui-entry.mjs` 断言版本号与 `server=`）。

#### 11.11.5 数据源跟随会话服务器（0.5.3）

**背景**：`ctx.client` 是「运行本插件的那台服务器」的 client——把插件装到本机后，它就是**本机 sidecar**。
远端会话的租约/队列在远端服务器的插件里，用 `ctx.client` 读到的是空数据（看起来像「远端没有协作活动」）。

**做法**：每次请求前解析数据源，而不是在 store 构造时固定 client。

| 项 | 规则 |
| --- | --- |
| 数据源 | `ctx.sessions.current()?.server?.client ?? ctx.client`。`ServerRef.client` 由 app 鉴权（当前窗口就在该 server 的页签/会话上），**不自建 token**；`server` 缺失（老宿主、测试宿主）时回退 `ctx.client` |
| 轮询 key | `${server.id}\n${session.id}`（无 server 时 `local\n<sid>`，无会话时 `local\n`）。切换服务器或会话 → key 变 → 停旧 timer、立即以新源请求一次 |
| 迟到回包 | 请求前记下 `source.key`，回包时再算一次；**不一致就丢弃**（不落库、不写 error）。`finally` 里若 key 已变则补排一次（与 0.5.2 的 R-7 同思路，只是从「会话」扩到「服务器+会话」） |
| 切换即清屏 | key 变化时**先**把 `data` 清空（`loading`），再发新请求——避免用上一台服务器的数字渲染新会话；即使此刻有请求在飞也照样清（`adopt()` 在 single-flight 守卫之前） |
| 只读 | 仍然只有 `layout.open` / `toast.show`；没有新增 RPC 方法、没有写路径 |
| 不聚合 | 一次只显示**当前路由会话所属服务器**的一份快照；不做跨服务器合并/缓存历史 |

验证（`test/gui-entry.mjs`，断言均可变异验证）：

- 远端会话 → 打到 `server.client`，`session` 是该远端会话 id，`ctx.client` **零**调用；
- 无 `server` → 回退 `ctx.client`；
- A→B 跨服务器切换 → 立即用 B 的 client；pill 数字从 A 的快照变成 B 的（不串台）；
- A 慢回包在切到 B 之后到达 → **丢弃**：中途读到的是「无数据」而不是 A 的数字，最终是 B 的数字，且两个 client 各只被调用一次；
- 无会话点 pill → toast 含 `server=this computer` 与版本，0 次 `layout.open`。


### 11.12 受保护目标请求队列（`collab_request_owner`，0.4.0）

D1（缺陷 `d_6180f4ab4fb4368a`）：受保护线（schema 线等 `BUILTIN_PROTECT`）此前**没有任何合规送达路径**——
投递被拦、`collab_send` 被拦、广播拉起的 `explore` 只能 `BLOCKED`。0.4.0 给出的是 **pull**，不是投递：

```text
collab_request_owner { target:"ses_…(受保护)", text:"<一句话请求>", issuePath:"docs/issues/x.md", confirm:true }
  → 写入 ~/.config/opencode/collab-owner-queue/<targetSid>/<queueId>.json
  → 0 条 prompt、不唤醒、不建 bid/thread、不改任何协作状态
  → 对方下次运行（自己的 context 注入）看到：
     - [owner-queue] ses_ab12…cd34 @ 14:06：<summary ≤120>（docs/issues/x.md 或 -）
```

| 面 | 规则 |
| --- | --- |
| 方向 | 只允许「**非受保护 → 受保护**」；发起方本身受保护（含 `[protected-child]`）一律拒绝——不做 protected → protected 转发。目标不是受保护 → 拒绝并提示改用 `collab_handoff` |
| 存储 | `<dir>/<targetSid>/<queueId>.json`，`q_<base36ts>_<rand4>`，`tmp + rename`；每目标上限 **50 条未读**，满则**拒新**（不驱逐已有项）；已读项**不计入上限**（否则 owner 读完后队列会永久占满），并在 `seenAt` 超过 7 天后于下次写入时回收（每次最多 20 条）。`COLLAB_OWNER_QUEUE_DIR` 可覆盖目录（harness/沙箱） |
| 字段 | `{ id, target, from, at, summary, issuePath, bid, revokedAt, seenAt }`；`summary` 去控制字符 / 合并空白 / ≤500，`issuePath` 只做**语法**校验（相对、`docs/issues/<name>.md`、无 `..`/绝对路径；目标工作区可能不在本机视图内，故不读 fs） |
| 提示 | 受保护会话每次 `context` 注入最多 **3 行**（与 §11.9.3 的追加提示**合计**），按 `at` 升序，**只读**：不含指令、不要求回复、不产生投递；每条只提示一次（`seenAt`）；同一提案最多一行（§11.12.1） |
| 标记时机 | 与 §11.9.3 的 F1 一致：`context` hook 在 `event.system.push` **成功之后**才写 `seenAt`；注入抛错 → 不标记，下一轮重试 |
| 发起方视图 | `collab_list` 追加「我提交给受保护会话的请求：N 条待处理（其中 M 条已被目标读到）」+ ≤3 行明细（`queueId` → 目标短 id / 时间 / 摘要，已读项标 `· 已读`）+ `…还有 N 条`；只读 |
| 撤回 | `collab_request_owner { id:"q_…", revoke:true, confirm:true }`（可省略 `target`）；**只有发起方**能删自己写的项；`confirm:false` 只预览 |
| 边界 | 队列**不是**投递通道、不构成送达确认；不会自动变成任务；`BUILTIN_PROTECT` 名单与血缘判定完全不变 |

受保护会话的注入面是**显式白名单**：`[protected]` / `[protected-child]` 只会看到两类行——
① §11.9.3 的「提案有闭环后追加」（≤1 行）；② 本节 `[owner-queue]` 行（≤3 行，与 ① 合计 ≤3）。
接管请求 / 群组广播 / 未闭环提醒对其仍然**不可见**（§11.4.1 的 ⚠ 一节）。

### 11.12.1 两类提示的去重规则（0.4.1）

两类只读提示可能指向**同一份提案**：§11.9.3 的「提案有闭环后追加」（`followUps`）与本节 `[owner-queue]` 行。
0.4.1 起渲染层先合并、再去重（只改渲染，不改存储）：

| 规则 | 口径 |
| --- | --- |
| 去重键 | 每个候选登记它带的**全部**键：`path:<规范化路径>`、`bid:<bid>`（可同时有）；**任一键相同即同一提案**，且关系**可传递**（A 与 B 同路径、B 与 C 同 `bid` → A/B/C 一组）。所以「只带 `bid` 的队列项」与「`bid`+路径的追加」也会合并；`./`、`.`、重复 `/` 视为同一路径；**两个键都没有 → 不去重**（无法判定是同一提案） |
| 保留哪条 | 组内 `at` **更新**的那条；同一毫秒内 `followUp` 优先于队列行 |
| 上限 | 去重后存活的行按 `at` 升序取前 **3** 行（两类合计；合并前各自 ≤1 / ≤3 的旧口径作废） |
| 标记 | 只对**实际渲染**的行写 `seenAt` / followUp seen key；被去重掉的条目**不标记**，下一次请求仍可提示（§11.9.3 的 F1 口径不变） |
| 范围 | 只在渲染层：队列文件、`followUps[]`、状态与权限都不改；非受保护会话的注入不走这条合并 |

因此「同一提案既 `collab_followup` 又 `collab_request_owner`」最多只占一行；两边都还在待读时先渲染最新一条，
另一条在之后的请求里出现（不是丢弃）。两个会话对同一提案各排一条队列项也一样按提案合并；
`collab_request_owner { bid }`（**不传** `issuePath`）与同 `bid` 的追加同样合并。

**去重口径**：不做 `(target, text)` 去重——同一内容可以多次提交（补材料/催办场景），由发起方自行撤回；
但指向同一提案（共享任一 `issuePath` / `bid` 键，含传递）的多条提示按上表合并成一行。
**内容归属**：提示行里的 `<summary>` 由**发起方**撰写并已去控制字符（含 C1 与 bidi）；受保护会话看到的只是
「有一条待读请求」的提示，**不是指令**，读不读、做不做由它自己决定。

### 11.13 协作结束后自动归档 spawn 会话（0.5.0）

**归档 ≠ 删除。** `collab_broadcast` 在没人可接时拉起的 bootstrap 会话（`claim.kind="spawn"`，
`collab_list` 标 `[bootstrap]`）只为一单而存在；那单闭环后它会一直占着会话列表。0.5.0 起：

```text
PATCH /api/session/{sid} { "archived": true }     # 归档：从会话列表隐藏，会话与消息全部保留
PATCH /api/session/{sid} { "archived": false }    # 恢复：原样回来
```

- **不是 DELETE**：归档路径不调用 `DELETE /api/session/{id}`（`DELETE` 只出现在 `selftest` 清理与
  spawn 落点回滚两处，都与归档无关）；归档后消息、`bid` 记录、`receipt` 都还在，
  `state` 不变（记录里只多一个 `archivedAt` 时间戳）。
- **何时自动归档**（全部满足）：① 目标是**本插件拉起的**会话——`claim.kind="spawn"` 取 `claim.by`，
  spawn 租约过期后才被领取的（`claim.kind` 已改写成 `accept`）取 `expiredClaim.by`；② 已终态
  `done|blocked|expired`；③ 终态已过 `archiveGraceMs`（默认 10 分钟，防抖）；④ 目标 **idle**；
  ⑤ 目标不在 `protect`（含血缘）；⑥ 该 sid 不被任何**未决**交接引用（既非 `from.sid` 也非
  `claim.by`）；⑦ 没有未读的 `[owner-queue]` 项；⑧ 记录还没有 `archivedAt`（幂等）。
  用户自己的会话、`collab_handoff` 对象、requester 一律不碰。
- **触发点**：发起方的 `context` 刷新（与租约/自动回执同一处，无 cron、无轮询）。`collab_list` /
  侧栏快照**只读**：它们只显示 `[archived]`，绝不触发归档。
- **写失败只记录**：宿主拒绝（403/404）或没有 `session.update` 且未配 `COLLAB_SERVER_URL` 时，
  只写日志，不改记录状态、不影响工具返回、不打断刷新。
- **手动**：

```text
collab_archive { bid:"b_…", confirm:true }                     # 归档该单拉起的 spawn 会话（claim.by / expiredClaim.by）
collab_archive { session:"ses_…", confirm:true }               # 直接指定（跳过自动路径的门）
collab_archive { bid:"b_…", restore:true, confirm:true }       # 恢复：archived:false + 清 archivedAt
collab_archive { session:"ses_…", restore:false, confirm:false } # 只预览，零写入
```

- **与 `allowWrite` 无关**：归档位是**可恢复、可读**的（`PATCH { archived }`，内容全留），所以不受
  `allowWrite` 约束——自动路径只碰本插件自己 spawn 的会话，手动路径可直指**任意**会话（`[protected*]` 除外，
  且必须 `confirm:true`）。
- **回滚开关**：`collab.json { "archiveSpawned": false }` 关掉自动路径（手动工具仍可用）；
  已归档的会话用 `collab_archive { restore:true }` 批量恢复。
- **恢复之后**：`restore` 会清掉 `archivedAt`（并把记录的 `updatedAt` 刷新为恢复时刻）。如果该单仍是终态、
  目标空闲且其它条件仍满足，**防抖窗口过后自动归档会再次生效**——想长期留着这个会话，就设
  `archiveSpawned:false`（或让它保持 busy/继续使用）。
- **查已归档**：`GET /api/session?archived=true`（或宿主会话列表里的 `time.archived`）能看到它们；
  `collab_list` 里归档会话的 `state` 列显示 `archived`，标记 `[archived]`。
- **可见性**：`collab.state.snapshot` 的 `handoffs[]` 增可选的 `archived?: boolean`（只读展示，不改变布局）；
  非终态但已被手动归档的单行尾也会标 `[archived]`。

### 11.14 即时状态回执（`collab_status`，0.6.0，只读）

> **口径（容易误会）**：「本会话相关」只算它**发起**（`from.sid`）或**承接**（`claim.by`）的单，
> **不含**「只是被问询过、还没领取」（`asked.sid`）的单——那种单对它是 context 注入的接管请求，
> 用 `collab_inbox` / 注入块看，`collab_status` 不重复列。已闭环的单只在显式传 `session` 时附最近一条。


冻结 / 加急这类动作需要「这一单现在到哪一步」的**非阻塞**答案。`collab_wait` 会**阻塞**（等到有回执为止），
`collab_inbox` 只读消息，`collab_list` 是**清单**。所以 0.6.0 新增一个纯查询工具——查询 ≠ 等待：

```text
collab_status { bid:"b_14528d828f9df27b" }        # 最精确：一单
collab_status { threadID:"t_m3k9_abcd" }          # 该 thread 的全部交接单
collab_status { session:"ses_e4c03493…" }         # 它发起（from.sid）或承接（claim.by）的全部未闭环 + 最近一条已闭环
collab_status { }                                 # 本会话相关未闭环，≤5 条，按 updatedAt 倒序
```

输出（每条一单）：

```text
b_14528d828f9df27b  state=claimed  priority=urgent  承接=ses_e105…d85（handoff，剩 4m12s）  canPush=true
  投递: admitted=03:57:59  seen=03:58:10
  队列: 1 项（目标 ses_e1eb…Kebk，未读 1 条）:
    - q_mwmvceyb_7ehl @ 03:58:02 第 1/1 位（未读）[urgent]
  最近回复: 03:58:12 "已接管，先读交接包"（ses_e105…d85）
  下一步: 等回执 → collab_wait {threadID:"t_m3k9_abcd"}；超时用 collab_escalate
```

（已闭环的单多一行 `回执: 03:58:12 "修好了"（…）`，且 `下一步` 为「无需动作」。）

- **`canPush`**：`true` = 对该目标还能 push（`collab_send` / `collab_escalate`）；`false` = 目标本身或祖先
  在 `protect` 名单内，**只能队列**——`下一步` 会写成「只能队列（该目标受保护）：`collab_request_owner`
  或等其下一轮」。`session` / 记录里定位不到目标时该字段省略。
- **队列位置**：该 bid 对应的 `[owner-queue]` 项（`collab_request_owner { bid }` 写入的那些）逐条列出，
  并给出它在目标**未读**队列里的位置（`第 1/1 位` / `已读 03:58（不在队列）`）。
- **已闭环**（`done` / `blocked` / `expired`）：显示 `receipt` 摘要，`下一步` 恒为「无需动作」。
- **过期租约只描述不改写**：`claimed` 且租约已过 → 行内 `租约已过期` + 一行注「下一次 refresh
  （`collab_accept` / `context` 注入）才会释放并顺延；本命令不改写状态」。顺延是写路径的职责。
- **只读契约**：只用 `readBroadcast` / `allBroadcasts` / `mineFor` / `listFor` / `session.get|list`；
  **不**调用 `writeBroadcast`、`persistRefresh`、`session.prompt|update|remove`、`releaseLock`。
  测试用「写方法一旦调用即抛」的严格宿主 + 广播 / 队列目录（文件名 + 大小 + mtime）与 `ctx.storage`
  调用前后一致来证明（S96）。
- **非目标**：不做历史归档查询（用 `collab_list` / 归档过滤）、不做自动催办（用 `collab_escalate`）。

## 12. 协作链路（handoff chain：local + peer）

把「发现需求 → 找到人 → 交出去 → 收结果」串成一条链路；协议细节与打分口径的唯一真源是
`.trellis/spec/guides/cross-workspace-collab-guide.md`，本节只讲**怎么用**与**本地存储**。

### 12.1 两个 scope

| scope | 入口 | 提案 | 传输 | 写权限 |
| --- | --- | --- | --- | --- |
| `local` | `collab_handoff` | 可选 | thread（`collab_reply` / `collab_wait` 可用） | 本仓正常权限 |
| `peer` | `collab_broadcast` + `collab_accept` | **必需**（对端 `docs/issues/`） | 只能消息 | 只读 + 仅提案 |

### 12.2 状态与存储（跨 location 可见）

```text
~/.config/opencode/collab-broadcast/<bid>.json   # 广播 + 候选分 + 状态机（tmp + rename 原子写）
~/.config/opencode/collab-broadcast/<bid>.lock   # open(…,'wx') 原子领取，只有一个 winner
~/.config/opencode/collab-grants/<sid>.json      # 会话级权限 + agent 台账：{sid, before?, added?, at?, by?, reason?, agentBefore?, promotedAt?, promotedBy?}（tmp + rename）
```

`state: open → claimed → acked → done|blocked|expired`；`attempts > 3` 转 `expired`（升级给人，不再重投）。

`asked: { sid, at, leaseMs }` 记录当前问询对象（top-1 串行）；`skipped` 是「已问过 / DECLINE / 领了不干」的顺延游标。
`receipt: { from, at, note, auto? }` 是闭环凭据：手动回执没有 `auto` 字段；`auto:true` 表示「**发起方**只读提取对端结论」自动写入
（`claimed` 是租约到期后、`acked` 是静默超 `ACKED_EXTRACT_MS`=2h 后；摘要 ≤200 字，不落盘正文）。
`ACKED_EXTRACT_MS` 的失败路径只写 `staleNoticedAt`（本窗口已查过，状态仍 `acked`）。`COLLAB_BROADCAST_DIR` 可覆盖目录（harness / 沙箱用）。

`delivery: { cid, to, messageId?, admittedAt?, failedAt?, lastAttemptAt?, seenAt?, ackSentAt?, ackSentBy?, resends, unacked?, ackUnavailable? }`
是**送达账本**（0.1.6，§11.9）：`cid` 一条接管消息一个（重发复用），`seenAt` 由收方 `[ack]` 回填；
`followUps: [{ bid, issuePath, at, by }]` 是**闭环后追加**的结构指针（不存正文，§11.9.3）。两者都只增。

`archivedAt`（0.5.0）是 spawn 会话的**归档时间戳**（§11.13）：写入即表示该会话已 `PATCH { archived:true }`，
它是自动归档的幂等标记；`collab_archive { restore:true }` 会清掉它。归档**不改** `state` / `receipt`
（归档 ≠ 删除，会话与消息都保留）。

`collab-grants/<sid>.json` 是**会话级权限 + agent** 台账（`collab_grant` + spawn 自动授权 + `collab_promote` 共用一份文件）：
`before` = 首次授权前的 `permissions` 原样快照、`added` = 追加过的动作名、`reason: spawn|grant`；
`agentBefore` / `promotedAt` / `promotedBy` = 首次 promote 前的 agent 与该次记录。两半**互不覆盖**：
`collab_grant {revoke:true}` 只清 permissions 半段，`collab_promote {revert:true}` 只清 agent 半段，两半都清空时文件被删除。
`PATCH /api/session/{sid}` 的 `permissions` 是**整集替换**，所以每次写回都是「GET → `mergeRules` 去重合并 → PATCH」；
切 agent 走独立端点 `POST /api/session/{sid}/agent`（`permissions` PATCH 不接受 `agent` 字段）。
注意：删掉 `collab-grants/` 只是丢掉还原凭据，**不会**撤回已经写进会话的权限或 agent（撤回只能 `revoke` / `revert`）。
`COLLAB_GRANT_DIR` 可覆盖目录（harness 用）。

保留策略：写入时顺带删除 `done` / `blocked` / `expired` 且 `updatedAt` 超过 **7 天**的记录（单次最多 **20** 个，
`BCAST_RETENTION_MS` / `BCAST_PRUNE_LIMIT`）；`open` / `claimed` / `acked` 不动——`collab_list` 不删任何文件；
`collab_accept confirm:false` 属于「预览但会刷新」：先做租约刷新与保留清理（可能删掉逾期的 `done`/`expired`），但不领取、不投递。

`collab_list` 会按快照标注 `lease=expired|ok`（`claimed` 看 `claim.at`，`open`+`asked` 看 `asked.at`），但**只标注**：
不改状态、不删锁、不推进顺延（真正的顺延只在 `collab_accept` / 广播 / `context` 注入时发生）。

> 这一层**不能**放 `ctx.storage`：storage 按 `location` 隔离，对端读不到，claim 也无法原子。

### 12.3 最小流程（peer）

```text
① 写提案       <对端仓>/docs/issues/fix-x.md（状态/范围/关联/问题/根因/方案/验证/涉及文件）
② 广播         collab_broadcast { workspace, issuePath, expected:"implement", confirm:true }
               （cross-workspace 专用：workspace 解析后等于当前工作区 → 拒绝并提示改用 collab_handoff，0 模型调用、0 写入）
               → 打印 bid + 候选匹配分 why（文件交集 45 / 标题词 25 / 同任务线 15 / agent 10 / 最近活跃 5，busy>30min −10）
               → 有 ≥80 候选：只写文件（0 调用）；只有被问询的 top-1 会收到「接管请求」注入（busy > 30min 额外补 1 条 queue 叫醒）
               → 没有 ≥80 候选：claim(kind=spawn) 拉一个会话（默认 explore；build 需 agentConfirm:true）
                 spawn 成功后自动给它**自身**追加 5 条 collab_* allow（会话级 PATCH；失败只记 permissionGrant:"failed"，不阻断）；
                 对端已有会话缺权限时用 collab_grant { target:"ses_…", confirm:true } 补，撤销加 revoke:true
                 ★ spawn 只自动 grant、**不**自动 promote：拉起的仍是只读 explore。要它真改代码，必须在它
                   collab_accept 之后显式 collab_promote { target, confirm:true }（白名单 build/plan），
                   完事 collab_promote { target, revert:true, confirm:true } 切回。expected:"review" 永不 promote。
③ 领取/问询    被问的候选：有余力 collab_accept { bid, confirm:true }（= ACCEPT，并发只有一个 winner）；
               没余力回一条 `DECLINE <bid> <理由>` 给发起方（bid 必带；不带 bid 且同时有多个问询时不生效）；
               5 分钟不答 → 自动顺延下一候选（attempts+1）。接管请求 / 叫醒 prompt / 广播结果都写成三步：
               `① collab_accept …` / `② collab_send {target:"ses_…", text:"[handoff] DONE|BLOCKED <bid> …", confirm:true}` /
               `③ 只分析、不调用工具 = 未完成`——命令里的 `bid` 与发起方 sid 都是完整可复制的字面量。
               expected 为 `research` 时 ③ 换成「只读排查：不要改代码；结论写进最后一条回复」；
               承接方是只读 agent（explore/plan）而 expected=implement 时，预览与结果都会提示能力不匹配。
               受保护会话及其子会话不能领取；只读 agent 不能 `steer`。
④ 实施         对端自主实施（peer：只改 docs/issues/**，git 只读，不 push）
⑤ 回执         collab_send { target:"<发起方 sid>", text:"[handoff] DONE <bid> <sha/摘要>", confirm:true }
               （只认 bid / 完整 issuePath / thread，且必须由承接方发送；判定无需处理时用 BLOCKED）
               ⚠ 记录 receiptMode:"pull"（发起方在 protect 名单内）时改成本会话最后一条回复写
                 `[handoff] DONE|BLOCKED <bid> <摘要>`——不要 collab_send；发起方只读提取
                 （`claimed` 租约到期 / `acked` 静默 2h，§11.4.1、§12.5 #12）
⑥ 闭环         发起方插件解析状态行 → bid.state=done|blocked；候选耗尽 / attempts>3 → expired 升级给人；
               对端没发回执时，**发起方自己触发**的那次刷新会只读提取承接方会话里最后一条有文本的 assistant 回答：
                 · `claimed`：5 分钟租约到期后（任何 claim.kind：spawn / accept / handoff，R7）；
                 · `acked`：**没有租约**，静默超 `ACKED_EXTRACT_MS`=2h 后（R8）；
               判定依据（显式 `[handoff] DONE|BLOCKED <当前 bid> …`，或
               `已实施|已修复|无需|不需要|已完成|already|not needed` → blocked，`完成|done|fixed` → done），
               能判定就写 `receipt{auto:true}` 并闭环（不拉新、不 attempts++）；判定不出才走原顺延（acked 保持原状，只写 `staleNoticedAt`）。
               R7 另补 blocked 措辞：`回执被…拒` / `无法投递` / `改回写提案` / `回写提案` / `已自愈` / `无需改动`；
               `done` 仍只认 `完成|done|fixed`（先剔除「分析完成」）。`acked` 静默超 2h 同样由发起方提取（R8，见 §12.5 第 12 条）。
               回显模板（`<bid>`/`<摘要>`/`<原因>`）、其它 bid、否定语（未完成/无法完成/not done yet）与计划语（「完成后我会…」）
               一律不判定；摘要位残留**任意** `<…>` 占位符也不算回执（整行照抄 R1 命令留下的
               `", confirm:true}`、反引号、`（以上是示例）`、`【<原因>】` 都属此列）；旁观会话 / 其它工作区的刷新不读对端正文、不闭环。
               未闭环项在其下一次请求的 context 注入里提醒一次（`done`/`blocked` 不再提醒）

⑦ 追加         闭环后仍有结论：结论写提案文件 + `collab_followup { bid, confirm:true }` 登记指针；
                发起方下次 context 注入看到一行只读提示（不投递、不重开 bid，§11.9.3）
```

> 送达状态（0.1.6）：接管请求/回执的投递记 `delivery`，收方注入或 `collab_inbox` 读到后回
> `[ack] <cid> seen` → 发方 `seenAt`。`collab_list` 每条单显示 `admitted=/seen=/queue-age=/resend=/unacked=`；
> 只有「admission 失败」或「2h 无 seen 且目标 idle」会补投 1 次，busy 目标永不重发（§11.9）。


### 12.4 同工作区（local）

```text
collab_handoff { text, expected?, confirm:true }            # 不传 target：唯一目标直投，多目标按同一套打分择优
collab_handoff { target:"ses_…", text, confirm:true }       # 指定目标
  → thread 打开（t_…），对方 collab_reply { threadID } 回执，发起方 collab_wait { threadID } 等结果
  → 同时写一条 scope=local 的 bid，回执同样可用 [handoff] DONE <bid> 闭环
```

### 12.5 已知限制

1. **新工具的直接调用权限**：`agents.explore|plan.permissions` 是**项目级**的——本仓 allow 了 `collab_*`，
   其它工作区（如 `muke-interface`）的 explore 一条都没有，所以拉起的对端 explore 即使收到接管请求也调不动工具。
   现在：spawn 成功后自动给**新会话自身**追加 5 条 `collab_*` allow（`PATCH permissions`，见 §12.2 的 `collab-grants/`），
   已有会话用 `collab_grant` 显式补/撤；仍然**不改** `opencode.json`、不给 `edit`/`write`/`shell`。
   `collab_broadcast/handoff/accept/grant` 本身不在那 5 条里（它们是发起方能力），只读 agent 需要时仍走 Code Mode。
2. **grant ≠ promote**：`collab_grant` 只补回执能力（5 个 `collab_*`），explore 仍然只读；要让对端改代码得
   `collab_promote`（切 agent，白名单 `build`/`plan`，记录 `agentBefore` 可 `revert`）。两者共用
   `collab-grants/<sid>.json`，`revoke` 与 `revert` 各清一半。`expected:"review"` 的交接永不 promote。
3. **匹配分读消息用 `ctx.session.context`**（最后一次 compaction 之后），插件 ctx 未暴露 `/session/{id}/message`；
   200 条 / 7 天窗口在其上再过滤，只提取工具调用输入里的文件路径，不落盘正文。
4. **叫醒与接管请求是同一条 prompt**：只有被问询的 top-1 且 `busy > 30min` 才投；空闲 top-1 靠 `context` 注入（0 调用）。
5. 广播不会主动 poll 对端：对端会话不跑就看不到，超时只提醒发起方一次，不无限重投。
6. **匹配只在最近活跃的前 20 个根会话里打分**（`SCORE_CANDIDATE_LIMIT`）；极忙的工作区里第 21 个完美候选不会被问到。
7. `collab_list` 是只读快照：不改状态、不删锁，只按快照标注 `lease=expired|ok`（`claimed` 看 `claim.at`，
   `open`+`asked` 看 `asked.at`）；推进顺延仍以 `collab_accept` / 广播 / `context` 注入为准。
8. 广播目录按 **7 天**保留自动清理：写入时对 `done` / `blocked` / `expired` 且 `updatedAt` 超过 7 天的记录删除，
   单次最多 20 个（`BCAST_RETENTION_MS` / `BCAST_PRUNE_LIMIT`）；`open` / `claimed` / `acked` 不动。
   长期不写入的目录不会自行收缩，需人工按需删；被删记录的 `<bid>.lock` 一并清掉。
9. `expired` 的广播连 `confirm:false` 预览也会报错（提示「需人工接手」），预览不返回记录内容。
10. `bid` 含提案 `mtime`：同一内容被 `touch` / `git checkout` 改了 mtime 会产生第二个 `bid`（与 design §2 一致）。
11. **自动闭环覆盖所有领取类型的 `claimed`（`spawn` / `accept` / `handoff`），且只有发起方能触发**：
    `accept` 领取的单同样在租约到期后由发起方那次刷新提取（S70）；`[protected*]` 承接方不读不判；旁观会话（同工作区或其它工作区）的刷新只走原租约/顺延逻辑，不读对端正文、
    不写 `receipt`。提取读的是 `ctx.session.context`（同限制 3，向宿主请求尾部 10 条），**只判最后一条有文本的**
    assistant 回答（不跨条拼接、不回看更早的回答）；`[handoff]` 行必须点名**当前 bid**——模板回显（`<bid>`/`<摘要>`/`<原因>`）、
    摘要位残留任意 `<…>`（整行照抄 R1 命令的 `", confirm:true}` / 反引号 / `（以上是示例）` / `【<原因>】`）、
    其它 bid、没写目标一律不认；否定语（未完成/无法完成/不会发/not done yet）与计划语（「完成后我会…」）直接判「判定不出」。
    会话已删 / 无 assistant / 宿主报错一律返回「判定不出」并走原顺延，不抛错、不影响其它交接。
    「分析/核对完成」这类关于阅读本身的措辞会先被剔除，因此「答完分析」不会被当成 `done`。
    **注意本条的「租约到期」只指 `claimed`**；`acked` 根本没有租约，它的收口条件是静默 2h，见第 12 条（别把两者混为一谈）。
12. **`acked` 静默超 2h 可自动收口（R8）**：`acked` 没有租约（`refreshBroadcast` 只重开 `claimed`），
    回执丢失时会永远停在 `acked`。现在 `claim.at > 0` 且 `now - claim.at > ACKED_EXTRACT_MS`（2h）时，**发起方**触发的刷新
    会按与 `claimed` 相同的规则只读提取承接方最后一条回答：有结论 → `done|blocked` + `receipt{auto:true}`
    （不 `attempts++`）；判不出结论 → **状态保持 `acked`**、attempts 不变，只写 `staleNoticedAt`，
    同一窗口（2h）内不再重复读对端历史。`claim.at` 缺失（0）的记录**一律不读**（否则 `since=0` 会把很久以前的回答当结论）。
    承接方 protected 不读；`actor !== from.sid` 不读；`done` / `blocked` / `expired` 不处理。
    `collab_list` 对这类单标 `静默=Nh 可自动提取`。

13. **闭环后只拉不推（0.1.6 起）**：`done` / `blocked` / `expired` 的单，限界 reply 白名单**关闭**——
    任何会话都不得再向受保护发起方投递回执（`collab_reply` 与 `collab_send { kind:"reply", bid }` 均拒）。
    闭环后的**追加结论**有两条路，都不属于「投递」：
    1. 承接方写进**提案文件**（单一真源），并 `collab_followup { bid }` 登记一个结构指针
       （`record.followUps[] = {bid, issuePath, at, by}`，每单 ≤3 条，不存正文）；
    2. 发起方（含受保护线）在**自己的** `context` 注入里看到一行只读提示
       「`- b_xxx 已闭环，提案 <path> 有追加结论（<ts>），请读取文件`」，每次注入 ≤1 行，
       按 `(sid, bid, at)` 去重，所以第二条追加会再提示一次。
    `note` / `steer` / 任何自由文本都进不去这条路；路径必须 realpath 落在该记录 workspace 的
    `docs/issues/*.md`（路径先规范化：`.` / `./` / 重复 `/` 合并；拒绝 `..`、绝对路径、软链），校验失败整行不渲染。
    0.3.1 起：提示**在注入成功之后才标记**（注入抛错则下一轮重试）；校验失败的条目不标记，
    `collab_list` 汇总「N 条 followUp 因路径无效未渲染」（每会话按无效条目集合只提示一次）。
    护栏按**目标**判定，其它会话「中转」同样不可达（不存在绕过路径）。

14. **ack 只是「送到了模型面前」，不是「处理完成」**：`seen=…` 表示收方插件把它注入了上下文/被
    `collab_inbox` 读到；它**不**代表对方已经开始处理。目标 busy 时不会重发、也不会被判「未送达」
    （`unacked` 只在使用满 1 次重发预算 + 2h 窗口之后才出现）。受保护发起方永远是 `seen=n/a`
    （`ackUnavailable`）。
    注意：受保护发起方**没有交接类** `context` 注入（只有 §11.9.3 的追加提示与 §11.12 的队列提示），
    收口发生在其下一次 `collab_broadcast` / `collab_handoff` 刷新时。

15. **同工作区不允许 `collab_broadcast`（0.4.0，D4）**：`realpath(workspace) === realpath(ctx.location.directory)`
    时直接抛错并提示 `collab_handoff { text }`，**不写任何记录**（预览也同样拒绝）。比较用 `realpath`，
    所以 `./ws` / `ws/` / 指向同目录的软链都算同一个工作区。跨工作区要广播，工作区路径必须解析到别处。
16. **受保护目标只有队列，没有送达（0.4.0，D1）**：`collab_request_owner` 写的是**队列文件**，
    目标会话只在自己的 `context` 注入里看到 ≤3 行只读提示（每条一次；与「闭环后追加」合计 ≤3、
    同一提案只渲染 `at` 最新的一条，§11.12.1）。它不是投递：没有 prompt、没有 ack、
    没有任何「已送达」语义，也不会自动变成任务；对端不看（会话不运行）就永远不消费。`BUILTIN_PROTECT` 与血缘判定不变。
17. **spawn 会话归档 ≠ 删除（0.5.0，§11.13）**：`PATCH /api/session/{id} { archived:true }` 只是把会话从列表里
    隐藏，**归档路径不调用 DELETE**，会话与消息都还在，`restore:true` 原样恢复；`bid` 记录的 `state` / `receipt`
    / `followUps` 一律不变（只多一个 `archivedAt`）。自动路径要求「终态 + 防抖 10 分钟 + idle + 非 protected
    + 无未决引用 + 无未读队列 + 未归档」全部满足；缺一就只 log 不动。宿主没有 `session.update` 时
    走 `COLLAB_SERVER_URL` 的 `PATCH /api/session/{id}`（不猜端口）；写失败不影响任何工具返回。
    归档会话仍可能出现在宿主自己的「已归档」过滤里（`GET /api/session?archived=true`）。

