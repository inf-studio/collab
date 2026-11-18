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

> ⚠ **版本与重载**：npm 包插件**不会**把新版本热重载到已运行会话（只有 `.opencode/plugins/*.js` 这类本地文件插件会）。
> 升级 `@inf-studio/collab` 后需**重启 OpenCode 或新开会话**；`opencode plugin list` 显示的是*已安装*版本，
> 不等于当前会话的*运行时*版本。诊断方法：`collab_report` 预览会打印「版本: x.y.z」——那是运行时真实版本。

### 11.2 五个工具（+ 协作链路五个 + 缺陷上报一个）

| 工具 | 入参 | 说明 |
| --- | --- | --- |
| `collab_list` | `{ limit?: number, directory?: string }` | 列会话 + `parent=<short>`、`loc=<项目名>`；本会话标 `[self]`，protect 名单标 `[protected]`，其子会话标 `[protected-child]`（后者同样不可投递），广播拉起的会话标 `[bootstrap]`；末尾列出未闭环交接。`directory` 只看一个工作区（省略 = 旧行为） |
| `collab_send` | `{ target, text, kind?, threadID?, bid?, mode?, confirm: boolean }` | **`confirm` 必须 true**；否则只返回预览（目标 agent/state/title + kind/thread/mode + 将发送内容）。`kind:"reply"` 时 `target` 必须等于 thread 对端，且调用方必须是参与者（见 §11.7）。`bid?` 仅供**限界 reply** 用：声明本条消息闭合哪一单（缺省时从正文 `b_…` 取），决定了能否把回执投进受保护发起方（§11.4） |
| `collab_reply` | `{ threadID, text, bid?, confirm: boolean }` | 回执语法糖 = `collab_send{kind:"reply"}`；目标由 thread 里的对端自动解析，恒为 `queue`；非参与者调用会被拒绝。`bid?` 同上（限界 reply 归属判定） |
| `collab_inbox` | `{ limit?: number }` | 本会话跨会话消息**全文**（单条上限 `INBOX_TEXT_LIMIT=4000` 字，超出以 `…` 截断）+ kind/thread/线程状态；只读，不推进游标 |
| `collab_wait` | `{ threadID?, target?, timeoutMs? }` | 传 `threadID` 等该线程「**最后一次 request 之后**」的 `kind:"reply"`（仅参与者可等；格式非法/thread 不存在立即报错）；不传则等 `target` 空闲。默认 120000，上限 1800000 |
| `collab_broadcast` | `{ workspace, issuePath, expected?, agent?, agentConfirm?, confirm }` | **跨工作区**广播：`issuePath` 必须在 `<workspace>/docs/issues/` 下、存在、`.md` 且**不是软链**；确定性打分 + `why`；写全局广播文件（0 模型调用）→ 只有被问询的 top-1 收到「接管请求」注入（ACCEPT/DECLINE，5 分钟租约，`busy > 30min` 时额外补 1 条 `queue` 叫醒）；无候选 ≥80 时 `claim(kind=spawn)` 拉新一个会话（默认 explore；`build` 需 `agentConfirm:true`；宿主不回 `location` 时回滚刚建的会话） |
| `collab_accept` | `{ bid, confirm }` | **原子领取**（`open(<bid>.lock,'wx')`，只有一个 winner）；输家返回「已被 `ses_x` 领取」；会话若带 `location.directory` 且不属于广播所属工作区则拒绝；`accept` 直接 `acked`，spawn 的新会话自己调用则 `claimed → acked`（记 `ackedAt`）；领取后回执 `[handoff] DONE <bid> <摘要>` |
| `collab_handoff` | `{ target?, text, expected?, confirm }` | **同工作区**交接：复用 thread 协议（`kind:request` + `queue`）。不传 `target` 时——目标唯一直接投；多目标用与广播同一套打分（阈值 80）择优。同 `(target, text)` 幂等：重复调用返回「已存在 / 已闭环」，不重投 |
| `collab_grant` | `{ target, confirm, revoke? }` | **会话级权限补丁**：给**这一个**会话的 `permissions` 追加 5 条 `collab_*` allow（`collab_list/inbox/wait/reply/send`）。先 `GET` 现有规则 → 按 `action + resource` 去重合并 → PATCH（**整集替换**语义，原规则保留）；白名单之外（`edit`/`write`/`shell`…）一律拒绝。`confirm:true` 才写；否则只预览目标（id/agent/title/loc）与将加/将删规则。`revoke:true` 用记录里的 `before` 快照整集还原并删除记录（无记录报「无可还原」）。`[protected*]` 目标直接拒绝 |
| `collab_report` | `{ note?, bid?, threadID?, confirm }` | **缺陷上报（旁路，不改任何协作状态）**：把现场写到 `~/.config/opencode/collab-reports/<signature>/<ts>.{json,md}`（版本/工具/分类/错误名与消息≤2KB/stackTop 5 帧/短 id/工作区/记录快照；**不含正文、文件内容、token**），配了 `report.to` 时额外 `collab_send`（`note`+`queue`）通知维护方；同签名 1 小时最多 1 条。任何非参数校验类错误都会在错误文案末尾提示这个入口（见 §11.8） |
| `collab_promote` | `{ target, agent?, confirm, revert? }` | **按会话切 agent**（`POST /api/session/{id}/agent`）：默认 `build`，白名单仅 `build` / `plan`；`confirm:true` 才发。记录 `agentBefore/promotedAt/promotedBy` 到同一份 `collab-grants/<sid>.json`（与 grant 半段互不覆盖）；`revert:true` 切回记录里的原 agent 并删除该半段（无记录报「无可还原」）。`[protected*]` 与非法 agent 直接拒绝。**只在对端 `collab_accept` 且确需改代码时用；`expected:"review"` 的交接永不 promote** |

`kind`：`request`（默认）／`reply`（必须带 `threadID`，缺失会被当作新请求并在返回里提示）／`note`（不改线程状态）。
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
  "report": { "to": "collab-maintainer" }
}
```

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

> ⚠ 提醒可达性：受保护会话自己**没有** `context` 注入（`injectionFor` 对 protect 线直接返回空），
> 所以上面那条 pull 的「未闭环提醒」在真实宿主里**用户看不到**——它是防御性代码（只有非保护但被标
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
```

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

13. **闭环后不再放行回执（刻意设计）**：`done` / `blocked` / `expired` 的单，限界 reply 白名单**关闭**——
    任何会话都不得再向受保护发起方投递回执（`collab_reply` 与 `collab_send { kind:"reply", bid }` 均拒）。
    闭环后的**追加结论 / 复查回写**请写进提案文件（单一真源），由受保护发起方下次读取；
    护栏按**目标**判定，其它会话「中转」同样不可达（不存在绕过路径）。
    注意：受保护发起方没有 `context` 注入，收口发生在其下一次 `collab_broadcast` / `collab_handoff` 刷新时。

