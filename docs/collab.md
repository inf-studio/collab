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

### 11.2 二十八个工具（协作链路六个 + 权限/上报/追加/决策/租约/归档/状态/thread 聚合/加急/冻结/存储/会话契约/事实账本/决策账本各一组）

| 工具 | 入参 | 说明 |
| --- | --- | --- |
| `collab_list` | `{ limit?: number, directory?: string }` | 列会话 + `parent=<short>`、`loc=<项目名>`；本会话标 `[self]`，protect 名单标 `[protected]`，其子会话标 `[protected-child]`（后者同样不可投递），广播拉起的会话标 `[bootstrap]`；末尾列出未闭环交接（含 `admitted=/seen=/queue-age=/resend=/unacked=` 送达状态，见 §11.9；带 `origin` 的转发单行尾再加 ` via ses_…`，见 §11.16；有契约决策的单行尾再加 ` decisions=N`，见 §11.19）；本会话持有 / 排队中的资源租约（§11.10）；本会话**提交给受保护会话的队列项**（条数 + ≤3 行明细 + `queueId`，见 §11.12）。`directory` 只看一个工作区（省略 = 旧行为） |
| `collab_send` | `{ target, text, kind?, threadID?, bid?, mode?, origin?, force?, blocked?, grade?, factIds?, glossary?, confirm: boolean }` | **`confirm` 必须 true**；否则只返回预览（目标 agent/state/title + kind/thread/mode + 将发送内容）。`kind:"reply"` 时 `target` 必须等于 thread 对端，且调用方必须是参与者（见 §11.7）。`bid?` 仅供**限界 reply** 用：声明本条消息闭合哪一单（缺省时从正文 `b_…` 取），决定了能否把回执投进受保护发起方（§11.4，**仅未闭环的单**）。`origin?`（0.7.0）：转发别人的活儿时这条链真正的起点（`ses_…`/别名），给了就在**正文首行**写 `对接人（非本单发起方）：ses_… @ <dir>`；不写记录、不继承，缺省正文逐字不变（§11.16）。`force?`（0.7.0）：窗口内已有同文仍要投递时用，跳过两级判定、回执标注 `dedupeOverridden`（§11.9.4）。`blocked?`（0.7.0）：BLOCKED 结构化 `{ need?, excluded?, minimalTest? }`，三段追加在正文之后；有可解析 bid 且你是本单参与方时写进记录 `blocked[]`（保留最近 3 次），没有就只上正文、回执注明未落库；超限可读拒绝，不传时输出逐字不变（§11.18）。`grade?`（0.9.4）：`measured` / `inferred` / `relayed`，缺省 `unknown`（收端注入标 `[未标注]`）；`factIds?` 引用已登记事实（写进信封与 `basedOn.factIds`）；`glossary?`（0.9.4）：`{ define:{term,meaning}, conflict?[term] }`——同一术语第 2 次冲突且无更新定义 → 拒绝发送（§11.25） |
| `collab_reply` | `{ threadID, text, bid?, force?, grade?, factIds?, glossary?, confirm: boolean }` | 回执语法糖 = `collab_send{kind:"reply"}`；目标由 thread 里的对端自动解析，恒为 `queue`；非参与者调用会被拒绝。`bid?` 同上（限界 reply 归属判定）；`force?` 同 `collab_send`（§11.9.4）；`grade?` / `factIds?` / `glossary?` 同 `collab_send`（0.9.4） |
| `collab_followup` | `{ bid, issuePath?, confirm: boolean }` | **闭环后追加（pull，0.1.6）**：只有该单 `claim.by` 可调、只有 `done`/`blocked` 可调；只往 `record.followUps[]` 追加 `{bid, issuePath, at, by}`（**不存正文**），**不投递、不改 state/receipt、不重开 bid**。`issuePath` 缺省取记录的提案，必须先规范化再要求 realpath 落在该记录 workspace 的 `docs/issues/*.md`（`.`/`./`/重复 `/` 会被合并，`./docs/issues/x.md` 等价；拒绝 `..`/绝对路径/软链）。每单上限 3 条。见 §11.9.3 |
| `collab_decisions` | `{ bid, items, confirm }` | **契约决策记录（0.7.0）**：把「退出码 2→3 / `room:order` 纯事件型 / 断言只看末帧」这类**契约级决定**写进交接记录 `decisions[]`（**只有发起方 `from.sid` 或承接方 `claim.by` 能写**，第三方拒绝且 0 写入；比 `blocked` 更严：`asked` / `origin` 也不行）。`items` 1–10 条 `{ id, decision, rationale? }`（`id` ≤40、`decision` ≤200、`rationale` ≤400 字，控制字符剥成空格）；**同一 `id` 再写 = 覆盖**（不追加），每单上限 **20** 条，超出是**可读拒绝**（不静默淘汰）；`confirm:false` 零写入预览。**不投递、不改 state / claim / receipt / replies**；下游读：`collab_status { bid }`（最近 3 条）+ 承接方注入一行计数 + `collab_list` 行尾 `decisions=N`。见 §11.19 |
| `collab_inbox` | `{ limit?: number }` | 本会话跨会话消息**全文**（单条上限 `INBOX_TEXT_LIMIT=4000` 字，超出以 `…` 截断）+ kind/thread/线程状态；只读，不推进游标。读到即视为「已见」→ 会回一条 `[ack]`（§11.9.1）；`[ack]` 本身标 `system-ack` |
| `collab_wait` | `{ threadID?, target?, timeoutMs? }` | 传 `threadID` 等该线程「**最后一次 request 之后**」的 `kind:"reply"`（仅参与者可等；格式非法/thread 不存在立即报错）；不传则等 `target` 空闲。默认 120000，上限 1800000 |
| `collab_status` | `{ bid?, threadID?, session? }` | **只读、非阻塞**地看「这一单现在到哪一步」（0.6.0）：`state` / `priority` / 承接（`claim.by` + `kind` + 剩余租约）/ 投递（`admitted` / `seen` / `ack=n/a`）/ 该目标 `[owner-queue]` 队列项与**队列位置** / 最近一次 reply 摘要 / `receipt.note` / **下一步**一行。带 `origin` 的转发单还会显示 `origin=ses_… @ <dir>`（§11.16）。`bid` / `threadID` / `session` 三选一（`session` 也接受别名：列出它作为 `from.sid` 或 `claim.by` 的全部未闭环 + 最近一条已闭环）；都不传 = 本会话相关的未闭环（≤5 条，按 `updatedAt` 倒序）。受保护目标照常可查，并明确 `canPush:false` + 只能走队列。承接方报过结构化 BLOCKED 时多一段`BLOCKED（结构化，最新一次 / 历史 N 次）` + `需要对方` / `已排除` / `最小判别` 三行（各 ≤3 条，§11.18）；写了契约决策的单多一段 `决策 N 条` + 最近 3 条（`id: decision`，rationale 截断到 80 字，§11.19）。**消息 thread 不再报错**（0.7.0）：没有广播记录的 thread 降级为 `kind=messages` + 目标 + 最近出入站摘要（≤5 条）——只有索引与 thread store 都不认识的 thread 才保持原错误（§11.17）。**零写入**：不刷新状态（过期租约只描述不改写）、不释放锁、不投递。见 §11.14 |
| `collab_threads` | `{ target, includeClosed? }` | **thread 聚合（0.7.0，只读）**：列出与**一个** target 的全部 thread（`threadID` / `kind` handoff\|messages / 状态 / 最近活动 / 最近出入站摘要各 ≤120 字 / 交接单的 `bid`），并给出**建议继续哪个**（最新未闭环那条，附可直接复制的 `collab_reply` 或 `collab_status`）。默认只列未闭环，`includeClosed:true` 再列最近 3 条已闭环；≤20 条，超出给「还有 N 个」。数据 = thread 索引（`~/.config/opencode/collab-threads.json`，只在该消息**真的投递成功**后写）join 广播记录 + thread store。**零写入**（读前后索引 mtime/hash 不变）。见 §11.17 |
| `collab_escalate` | `{ bid?, threadID?, session?, reason, mode?, confirm }` | **加急（0.6.0）**：让被加急的一单**现在就进对方当前轮**——复用宿主的 `delivery:steer`（桌面端「引导」按钮同一机制），不造新投递。`bid` / `threadID` / `session` 三选一；`reason` 必填（≤200，剥控制字符）。`mode` 默认 **`steer`**（显式 `"queue"` 才排队），只读 agent（`explore`/`plan`）目标**强制 `queue`**（回执标 `forced`）；回执打印**宿主实际采用**的 `delivery`（空闲目标会降级为 `queue`）与 `messageID`。记录只追加 `priority:"urgent"` / `urgentAt` / `urgentReason` / `urgentBy`，**不改** `state` / `claim` / `receipt`。受保护目标（含血缘）**0 条 prompt** → 写一条 `priority:"urgent"` 的 owner-queue 项，回执 `canPush:false` + 队列位置。同 `bid + reason` 5 分钟内只刷新 `urgentAt`、不重复投递。`confirm:false` 零写入预览。见 §11.14.1 |
| `collab_freeze` | `{ scope, target?, reason, until?, freeze?, confirm }` | **临时冻结（0.6.0）**：让协作层自己遵守「先别动」。`scope` = `session`（覆盖其子会话，血缘）/ `workspace`（目录）/ `bid`（一单）；`target` 除 `workspace` 外必填（`session` 收别名，`workspace` 缺省 = 当前工作区）。`until` 支持相对 `"30m"`/`"2h"`/`"45s"` 或绝对 ISO，默认 **30 分钟**、上限 30 天；**到期在读取时失效**（无定时器、无清理）。写入 `~/.config/opencode/collab-freeze.json`（`{version:1,entries:[]}`，**读-合并-写** + 原子 rename + 短锁，并发不丢条目）。被冻结对象上的**新建**协作一律可读拒绝（0 写入）：`collab_handoff`（目标 / 祖先 / 目标工作区）、`collab_broadcast`（工作区，spawn 前再判一次）、`collab_accept`（该单或本会话）、`collab_escalate`（冻结优先）；读取类 `collab_list` / `collab_status` 只标 `[frozen]`。通知一次：非受保护 → 1 条 `queue` prompt（回执 `cid` / `messageId` 存 `delivery[]`）；受保护（含血缘）→ **0 条 prompt** + 一条 `priority:"urgent"` owner-queue 项。被冻会话自己的 `context` 只提示一次（写 `notifiedAt`）。`freeze:false` 解冻（幂等 no-op）；`confirm:false` 零写入预览。冻结 ≠ 归档 ≠ 删除。见 §11.14.2 |
| `collab_broadcast` | `{ workspace, issuePath, expected?, agent?, agentConfirm?, origin?, confirm }` | **跨工作区**广播（`workspace` 解析后等于当前工作区 → **拒绝**并提示用 `collab_handoff`，0.4.0）：`issuePath` 必须在 `<workspace>/docs/issues/` 下、存在、`.md` 且**不是软链**；确定性打分 + `why`；写全局广播文件（0 模型调用）→ 只有被问询的 top-1 收到「接管请求」注入（ACCEPT/DECLINE，5 分钟租约，`busy > 30min` 时额外补 1 条 `queue` 叫醒）；无候选 ≥80 时 `claim(kind=spawn)` 拉新一个会话（默认 explore；`build` 需 `agentConfirm:true`；宿主不回 `location` 时回滚刚建的会话）。`origin?`（0.7.0）：转发链的起点，缺省从「本会话正在承接的未闭环交接」继承一层（§11.16） |
| `collab_accept` | `{ bid, confirm, scopeCheck?, override? }` | **原子领取**（`open(<bid>.lock,'wx')`，只有一个 winner）；输家返回「已被 `ses_x` 领取」；会话若带 `location.directory` 且不属于广播所属工作区则拒绝；`accept` 直接 `acked`，spawn 的新会话自己调用则 `claimed → acked`（记 `ackedAt`）；领取后回执 `[handoff] DONE <bid> <摘要>`。**0.9.2 闸门**：本会话 `mission.outOfScope` 非空时**必须**带 `scopeCheck:{ inScope, reason? }`（插件不做语义判断，只逼表态 + 记录）；`inScope:false` → 拒绝并给 `handoffTo`，人类 `override:{ reason, approvedBy }` 是唯一通道；每次表态都写 `collab-audit.jsonl`。`openTodos ≥ 8` 只加一行提醒，不拦（§11.23） |
| `collab_handoff` | `{ target?, text, expected?, origin?, blocked?, confirm }` | **同工作区**交接：复用 thread 协议（`kind:request` + `queue`）。不传 `target` 时——目标唯一直接投；多目标用与广播同一套打分（阈值 80）择优。同 `(target, text)` 幂等：重复调用返回「已存在 / 已闭环」，不重投。`origin?`（0.7.0）：转发链起点，写进记录并在投递正文协议头后加「对接人」行（§11.16）。`blocked?`（0.7.0）：转发「卡住了」的活儿时带 `{ need?, excluded?, minimalTest? }`——追加在投递正文之后、写进记录（保留最近 3 次），下一跳的承接方注入与 `collab_status` 都聚合展示（§11.18） |
| `collab_request_owner` | `{ target?, text?, issuePath?, bid?, id?, revoke?, confirm }` | **受保护目标请求队列（0.4.0）**：只允许「非受保护 → `[protected]`/`[protected-child]`」，写入 `~/.config/opencode/collab-owner-queue/<targetSid>/<queueId>.json`（`tmp+rename`，每目标上限 **50 条未读**，满则拒新；已读项不计、7 天后回收）。**不投递、不唤醒、不建 bid/thread、不改任何协作状态**（0 条 prompt）；`confirm:false` 零写入。`text` → `summary`（去控制字符、≤500）；`issuePath` 只做**语法**校验（相对、`docs/issues/<name>.md`、无 `..`/绝对路径，不读 fs）。目标会话只在自己 `context` 注入里看到 ≤3 行只读提示（与「闭环后追加」合计 ≤3、同一提案一行，§11.12.1）；`revoke:true` + `id` 只允许发起方撤回自己的一条。见 §11.12 |
| `collab_grant` | `{ target, confirm, revoke? }` | **会话级权限补丁**：给**这一个**会话的 `permissions` 追加 5 条 `collab_*` allow（`collab_list/inbox/wait/reply/send`）。先 `GET` 现有规则 → 按 `action + resource` 去重合并 → PATCH（**整集替换**语义，原规则保留）；白名单之外（`edit`/`write`/`shell`…）一律拒绝。`confirm:true` 才写；否则只预览目标（id/agent/title/loc）与将加/将删规则。`revoke:true` 用记录里的 `before` 快照整集还原并删除记录（无记录报「无可还原」）。`[protected*]` 目标直接拒绝 |
| `collab_report` | `{ note?, bid?, threadID?, confirm }` | **缺陷上报（旁路，不改任何协作状态）**：把现场写到 `~/.config/opencode/collab-reports/<signature>/<ts>.{json,md}`（版本/工具/分类/错误名与消息≤2KB/stackTop 5 帧/短 id/工作区/记录快照；**不含正文、文件内容、token**），配了 `report.to` 时额外 `collab_send`（`note`+`queue`）通知维护方；同签名 1 小时最多 1 条。任何非参数校验类错误都会在错误文案末尾提示这个入口（见 §11.8） |
| `collab_lock` | `{ resource, mode?, ttlMs?, reason?, wait?, confirm }` | **资源租约（0.2.0）**：同工作区共享资源（测试窗口 / 同一文件 / 全量构建）的可判定互斥。`exclusive`（默认）与任何模式互斥，`shared` 之间可共存；`ttlMs` 默认 15 分钟、夹在 `[10s, 2h]`；过期在下次访问时回收（写 `history: expire`），无需人工清理。同一会话重复申请**幂等**（返回既有租约，不重复计数、不延长 TTL）。被占时：不传 `wait` → 返回「持有者 + 剩余 TTL」；`wait:true` → 按 FIFO 入队并返回排位。**不投递消息、不打断会话、不提供抢占**。`confirm:true` 才写，否则只预览。见 §11.10 |
| `collab_unlock` | `{ resource, confirm }` | 释放**自己**持有的租约；`shared` 组只移除自己、其他 holder 保留。free / 非持有者会得到可读拒绝——**没有 `force`**（抢占需人工；`[protected*]` 持有者永不被工具顶掉）。`confirm:true` 才写 |
| `collab_locks` | `{ resource? }` | **只读**列出租约：`resource / free 或 held / mode / holders / 剩余 / ttl / waiters / 我的位置`。不改状态、不回收、不叫醒排队者；过期租约直接显示 `free`。`collab_list` 会额外追加本会话「持有 / 排队中」 |
| `collab_promote` | `{ target, agent?, confirm, revert? }` | **按会话切 agent**（`POST /api/session/{id}/agent`）：默认 `build`，白名单仅 `build` / `plan`；`confirm:true` 才发。记录 `agentBefore/promotedAt/promotedBy` 到同一份 `collab-grants/<sid>.json`（与 grant 半段互不覆盖）；`revert:true` 切回记录里的原 agent 并删除该半段（无记录报「无可还原」）。`[protected*]` 与非法 agent 直接拒绝。**只在对端 `collab_accept` 且确需改代码时用；`expected:"review"` 的交接永不 promote** |
| `collab_archive` | `{ bid?, session?, restore?, confirm }` | **归档 spawn 会话（0.5.0，归档 ≠ 删除）**：`PATCH /api/session/{id} { archived:true }`（宿主无 `session.update` 时走 `COLLAB_SERVER_URL` HTTP），会话与消息保留、记录 `state/receipt` 不变，`restore:true` → `archived:false` 并清 `archivedAt`。`bid` 只认得**本插件拉起的**会话（`claim.by`；spawn 租约过期后才被领取的取 `expiredClaim.by`），别的单一律报错并提示改用 `session` 直指；`confirm:false` 只预览。自动路径还有 10 分钟防抖（默认）/idle/未决引用/未读队列等门（见 §11.13），**手动工具跳过这些门**，但 `[protected*]` 一律拒绝 |
| `collab_index` | `{ action, sinceDays?, confirm }` | **消息历史与可重建索引（0.9.0）**：`stats` 只读报索引状态（每表行数 / backend / 大小 / `backfilled`），不可用时回 `[索引不可用]` + 原因；`rebuild` 从 `collab-messages.jsonl` + `collab-*.json` 全量重建到 `<dbPath>.tmp` → fsync → 原子 rename（**幂等**：同一输入两次的行数与每表 checksum 相同；失败保留旧库；默认只保留最近 180 天）；`backfill` 只回填 0.9.0 之前的状态级历史（handoff / thread，**不伪造正文**，写 `meta.backfilled=1`）。`rebuild` / `backfill` 需 `confirm:true`，`stats` 零写入。见 §11.21 |
| `collab_mission` | `{ action, oneLine?, taskPath?, inScope?, outOfScope?, handoffTo?, state?, reconfirm?, by?, next?, on?, reason? }` | **会话契约主线（0.9.1；0.9.3 三选一）**：`get` 只读（含主线锚解析与建议主线，不写盘）；`set` 写一句话主线 / 任务路径 / 做·不做边界 / 转交对象 / 状态；`confirm` 一次确认后**固定**——此后注入与自动推断都不得覆盖，再改必须 `reconfirm:true` + `by`。**0.9.3**：`resume {next}` / `block {on,reason}` / `done` 是回答 `[drift]` 的唯一三个动作；`done` 要求已有 mainline next-up 待办。主线锚按「会话指针 → 工作区唯一 `in_progress` 任务 → 空」解析，**不猜标题、不跑 python**。见 §11.22 / §11.24 |
| `collab_progress` | `{ action, milestone?, title?, evidence?, confirm }` | **里程碑（0.9.1，只认证据）**：`list` 只读；`add` 规划 `M1` / `M2` …；`light` 必须给 `evidence`（`commit:<sha>` 存在且已合入 HEAD / `file:<path>:<line>` / `test:<path>` / `decision:<id>`），校验不过**拒绝点亮**并给原因。点亮后才推进 `plan.lastAdvancedAt` 并把 `turn.noAdvanceTurns` 归零；同一 evidence 重复点亮不重复推进。见 §11.22 |
| `collab_todo` | `{ action, id?, subject?, kind?, blockingOn?, status?, wakeWhen?, evidence?, reason?, until?, factId?, confirm }` | **契约待办（0.9.1；0.9.3 唤醒条件）**：`add`（`T1`/`T2`…，`blockingOn` = `me` 或 `ses_…`，可 `status:"doing"`）/ `close`（**必填 evidence**，四类可校验形式先校验）/ `defer`（保持 open、排到末尾）/ `suspend`（**必填 `wakeWhen`**：`{kind:"reply"|"decision"|"time"|"manual", ref?|at?}`，或 0.9.1 的自由文本）/ `list`。`[todo]` 注入每轮只列 top3 + 计数；挂起项显示 `suspended(等 X)`，到期未醒转 `drifted`（不自动关闭）；上一轮未动的 `doing` 项标 `[未收尾]`。读侧**保留全部 active**、只裁最近 50 条已关闭历史；id 由 `todoSeq` 单调分配、不复用。`factId?`（0.9.4）：这条待办依据的事实（`F3`，ref 同时记 `workspace`）；同一工作区的事实被作废后行保留并标 `⚠失效`（§11.25）。见 §11.22 / §11.24 |
| `collab_fact` | `{ action, claim?, evidence?, grade?, factIds?, id?, reason?, since?, includeAll?, limit?, confirm }` | **事实账本（0.9.4，工作区级）**：`settle` 登记 `F1`/`F2`…（`claim`/`evidence`/`grade` 必填；同 claim 覆盖旧 active 行；`relayed`/`unknown` 事实**不得**被引用为证据，按正文 `F3` 或 `factIds` 都会被拒）；`retract {id, reason}` 撤回单条并写当日 `metrics.retract_count` + 原因分类；`invalidate {since}` 作废一条事实及其**显式引用**（`basedOn.factIds`）的派生，或 epoch 数字作废该 epoch 及之前 settled 的 active 事实，`epoch+1`，工作区级传播，并在途 todo 标 `staleWork`（**不关闭**）；`list` 只读（默认 active，`includeAll` 含历史，并显示当日 `settled`/`retracted`/`stale` 计数）。写动作需 `confirm:true`。见 §11.25 |

| `collab_decide` | `{ action, key?, threadID?, bid?, question?, options?, owner?, id?, answer?, reason?, includeAll?, limit?, confirm }` | **决策账本（0.9.5，工具 27 → 28）**：`open { key, question, options[≥2], owner? }` —— `key` 是 threadID（`t_…`）**或** bid（`b_…`），所以没有交接记录的 thread 也能开决策；`owner` 缺省 = 契约里的 `decider`，再退到发单方（thread 发起人 / 交接单 `from.sid`）。同问（NFKC + 去空白/标点 + 小写后 sha1 相同）已 open → 拒绝并返回既有 `D#` + owner；同一 `key` 同时 open 的**手工**决策 ≤ **3**（D9，conflict 决策单独配额），第 4 条可读拒绝并提示先关。`answer { id, answer }` **只有 owner** 能写（提问方不得代答，提问方也不会被当成 owner），已回答不可再答（先 `supersede`）；`supersede { id, reason }` **提问方 / owner / 该 thread（或交接单）的参与方**都能作废（记 `by` + `reason`）；`list { key? }` 只读（省略 key = 本会话作为提问方 / owner / 参与方的全部 open）。存 `~/.config/opencode/collab-decisions/<key>.json`（`tmp+rename` + 跨进程 `<file>.lock`；`COLLAB_DECISIONS_DIR` 可覆盖）。双方下一轮注入一行 `[decide]`；`decision:<key>#D3` 作为 evidence 走**唯一 resolver**（账本优先、旧 hand-off `decisions[]` 兼容）。见 §11.26 |
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
- **自动感知（0.7.0）**：同一注入的**最后**追加一行只读提示「本工作区候选 N · 其它工作区候选 M」
  （每会话每 10 分钟最多一次、预算满时最先让位、protected 与「自己有未闭环交接」时不出现），
  `awareness:"off"` 关闭；详见 §11.15。

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
  "awareness": "line",
  "boardActions": true,
  "storage": "sqlite",
  "dbPath": "~/.config/opencode/collab.db",
  "report": { "to": "collab-maintainer" }
}
```

`storage`（默认 **`"sqlite"`**）决定是否维护消息投影 `collab.db`；设成 **`"json"`** 时插件
**一次也不 import** `node:sqlite` / `bun:sqlite`，所有工具与看板只读 JSON 文件（看板显示 `[索引不可用]`，
见 §11.21）。`dbPath` 覆盖投影路径（也可用 `COLLAB_DB_FILE`）。写错的值（`"jsom"`、`0`）回落默认，
不会悄悄换掉真源。

`archiveSpawned`（默认 `true`）控制**自动归档** spawn 会话（§11.13）；`false` 只关自动路径，
手动 `collab_archive` 仍然可用（回滚开关）。`archiveGraceMs` 是终态后的防抖窗口，默认
**600000（10 分钟）**，夹在 `[60000, 3600000]`（1 分钟–1 小时）——写错成 `600` 或一周都会被夹回。

`waiterTtlMs`（默认 **600000 = 10 分钟**，夹在 `[60000, 3600000]`）是**排队心跳**的存活窗口：排队者的
`LockWaiter.at` 记录「最近一次心跳」，超过这个窗口没有心跳的排队者在下一次 `collab_lock`（写路径）里被
回收——**读命令不回收**，只标 `[stale]`（§11.10.3 / §11.10.6）。没有「0 = 永不回收」：想要旧行为就设到上限
60 分钟。`waiterHeartbeat`（默认 `true`）控制「会话自己的 `context` 钩子每轮刷新一次心跳」这一半；
`false` 只关这一半，`collab_lock` 重复调用与其它写工具的轻量 touch 仍在（见 §11.10.6）。

`dedupeWindowMs`（默认 **60000**，`0` 关闭）是**正文去重**窗口：同一 **target**（或同一 thread）+ 归一化后
（空白折叠）完全一致的正文在窗口内重复提交时，`collab_send` / `collab_reply` 只投递第一次，后续**不投递、
不追加 thread 消息**，回执写明「60s 内已有同文，未重复投递」并给出它在哪个 thread 发过（§11.9.4）。
确需再发一条同样的正文 → 传 `force:true`（回执标注 `dedupeOverridden`）。

`awareness`（默认 **`"line"`**，`"off"` 关闭）是**自动感知**提示：`context` 注入末尾每会话每 10 分钟最多
一行「本工作区候选 N · 其它工作区候选 M」，只读、不写记录、不投递（§11.15）。

`boardActions`（默认 **`true`**）控制 Desktop 面板右详情的**动作行**（加急 / 冻结 / 解冻 / 归档，§11.20）：
`false` 只隐藏按钮（快照 `actions:false`），`collab.state.escalate|freeze|unfreeze|archive` 仍然可调
——这是回滚开关，不是权限开关；门禁始终在服务端。

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

1. `target` 就是该 `bid` 记录的**发起方**（`record.from.sid`）**或对接人（`record.origin.sid`）**——
   后者只用于「kind 改写为 reply」这一个判定；**受保护白名单没有放宽**（`allowProtectedReply` 仍只看 `from.sid`）；
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
| ① 请求 | `collab_send { target: see_b, text, kind: "request", confirm: true }` | 自动生成 `threadID`（`t_<base36ts>_<rand4>`），thread `open`，正文 `[<标题>][collab:<from>][request:<threadID>] …`（`<标题>` 见下） |
| ② 处理 | see_b 收到 user turn；需要全文/状态时 `collab_inbox` | 它自己决定怎么处理，插件不代替执行 |
| ③ 回执 | see_b：`collab_reply { threadID, text, confirm: true }` | thread → `answered`，投递给 thread 里的对端 |
| ④ 等回执 | see_a：`collab_wait { threadID, timeoutMs }` | 只看**最后一次 request 之后**的 `kind:"reply"`（复用 thread 时不会返回上一轮旧回执）；超时抛错 |

**入站注入头（0.8.0）**：每条投递在被投递会话里呈现为

```
[<发出方会话标题>][collab:<from>][<kind>:<threadID>] <正文>
```

- 标题来自 `ctx.session.get(发出方).title`：截断 20 字（超出以 `…` 收尾），`]` 替换为 `）`（否则会提前闭合名称段）；
- 按 sid 缓存 **10 分钟**：同一会话连续投递只查一次宿主，「改名」最多滞后 10 分钟；
- 取不到（宿主不可读 / 没有标题 / 空串）→ 只去掉名称段，与旧格式
  `[collab:<from>][<kind>:<threadID>]` **逐字一致**，失败不缓存（下一次会重试）；
- 只多这一段可读前缀：`[collab:…]` 与 `[kind:…]` 的位置/内容不变，现有解析（`COLLAB_ENVELOPE_RE`、
  `extractInbound`、去重、注入预算、protected 规则）一律不受影响。

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

#### 11.9.4 正文去重（0.6.0；0.7.0 增 target 维度）

记录层一直只对 `cid` / ack 幂等：同一 thread 在 15 秒内用同文调两次 `collab_send`，两次都会真的投递
（实测）。0.6.0 起加一层**内容幂等**，只作用于 `collab_send` / `collab_reply`；0.7.0 把去重单位从
thread 扩到 **target（会话）**：

| 项 | 规则 |
| --- | --- |
| 键 | ① thread 级：`threadID + 归一化正文`；② **target 级（0.7.0）**：`target sid + 归一化正文`（`\s+` → 单个空格、`trim`）——空白/换行不同视为同一句 |
| 窗口 | `dedupeWindowMs`，默认 **60000（60s）**；`0` 关闭（回滚开关，两级一起关） |
| 判据来源 | ① 交接记录的最近 3 条 `replies`（限界回执落在这里）；② thread 自己的消息列表（持久，插件重载后仍有效，只看尾部 20 条）；③ 进程内 thread memo（没有 thread 消息时兜底，重载即清空）；④ **进程内 target memo**（`{at, threadID, bid?}`，重载即清空） |
| 命中 | **不投递、不追加 thread 消息、不改记录**；thread 级命中的首行与结构与 0.6.0 一致（仅在末尾多一句 `force:true` 提示），target 级命中写明「已在 thread `t_…` 发过同文，未重复投递」并给出强制写法 |
| 强制 | `force:true`（0.7.0）：**两级判定都跳过**，照常投递，回执标注 `dedupeOverridden`；带 `bid` 时在记录上写 `dedupeOverriddenAt`（**只读标记**，`state`/`claim`/`receipt` 一律不动） |
| 不适用 | 预览（`confirm:false`）本来就零写入，因此**既不查也不消耗**窗口；`collab_escalate` 用自己 5min 窗口，不叠加 |

target 维度的来历是实测：同一条 BLOCKED 摘要发到同一会话的 3 个 thread（`t_mwmzdzhu_bluz` /
`t_mwmzyytb_b8g1` / `t_mwn15sjw_pr7a`）全部放行，对方三个 thread 各回一次「等你结论」，**没有一次落在它
当时使用的 thread** —— thread 是消息的容器，会话才是收件人。

顺序与护栏：去重查询发生在**投递之前**（命中就不投、不产生任何队列项），但**拒绝仍然优先**——目标本身或
祖先在 `protect` 里、且不属于 §11.4 的限界回执时，照旧报护栏错误，不会因为「同一句以前发过」而把错改成
一条投递历史提示（`fail-closed` 不因本功能放宽）。

去重只发生在**同一 target 或同一 thread**：换个 target（另一个会话）或改一处措辞都可以照常发；跨机器不去重
（进程内 memo 与本地 thread 存储各管各的）。想「再说一遍」不必换 thread：`force:true` 即可（会被标注）。

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

### 11.11 状态视图：桌面侧栏 + TUI（0.3.0 / 0.4.2 / 0.5.1 / 0.5.2 / 0.5.3 / 0.6.0 / 0.8.0，experimental）

> GUI 侧栏只在 **OpenCode Desktop** 的图形窗口里出现；**TUI 用 `/collab`（或 `collab_locks` /
> `collab_list` 的文本视图）**。宿主 GUI API 标注 experimental，版本区间见 README「版本兼容」。

侧栏/TUI 回答的是「现在全局在发生什么」：谁持有资源、谁在排队、哪些交接还没闭环、我给受保护会话
排了哪些请求。数据来自插件 **server 部分**自己，不经过第三方端口：

```text
src/index.ts (server part)  ── ctx.rpc.register(CollabState, { snapshot, escalate, freeze, unfreeze, archive }) ──▶  HTTP RPC
        │                       collab.state.snapshot({ workspace?, session? })
        │                       collab.state.escalate|freeze|unfreeze|archive  （0.8.0，§11.20）
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
  sessions: [{ sid, title, agent, busy, workspace, parent?, frozen?, archived? }],
  locks:    [{ resource, kind, mode, holders, waiters, waiting, expiresInMs, waiterAgeMs?, staleWaiters?, stale?, reason? }],
  handoffs: [{ bid, state, ageMs, from, claimBy?, workspace?, title, archived?, priority?, freeze?, kind?, spawned?, origin? }],
  queue:    [{ queueId, target, ageMs, summary, issuePath?, bid?, seen, priority? }]   // 0.4.2：{ session } 限定
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
- 空记录（无人持有、无人排队）不出现。0.6.0 起**归档会话仍留在快照里**（`archived:true`，`busy:false`），
  由看板归入「已归档 N」折叠段，而不是像以前那样直接丢掉——丢弃会让「谁被归档了」无法从视图回答。

**GUI UI**：

| 位置 | 内容 |
| --- | --- |
| 命令 `collab.open`（0.5.1） | 命令面板与 **Settings → Shortcuts** 可见；默认键 `mod+shift+l`（与 TUI 的 `ctrl+shift+l` 同义），`/collab` 也可触发；`enabled` 跟随当前路由到的会话，仅在会话里可用；执行 = `ctx.layout.open("collab:main", session)`。**只有打开面板这一个动作** |
| 会话头计数条（0.5.1；0.6.0 起四个数） | `持有 N · 排队 M · 待受保护 K · 宿主排队 J`（与面板**同一个 store / 同一次 2 s 轮询**；口径见上文「四个数」），点一下开面板；无快照时**整条不渲染**（不显示 `0`），server 不可达时 `collab: n/a` 且仍可点（面板里有横幅与原因）。这次轮询带 `session: <路由会话>`，否则 `queue` 按契约恒为空；`宿主排队` 不经过 RPC，直接读宿主已同步的 `server.data.session.pending`（首次 `sync` 一次，失败静默 0） |
| 标题栏 pill（0.5.2） | 常驻：无快照时就是 `collab`（**不显示 `0`**），有快照时 `collab N`（N = 租约 + 未闭环交接 + 本会话队列）。**有路由会话** → `ctx.layout.open("collab:main", session)`；**没有会话** → `ctx.toast.show` 弹「Collab GUI 已加载」（`probe.description` 含插件版本 / `id` / 面板 key / app 版本、platform 与数据源 `server=`）。它同时是本插件在窗口里的**自证**：弹得出来 = GUI 加载了，弹不出来 = 这个窗口没加载。只读（`toast.show` + `layout.open`） |
| 数据源（0.5.3） | 快照请求走**当前路由会话所属服务器**：`ctx.sessions.current()?.server?.client`，缺失（老宿主 / 无 `server`）时回退 `ctx.client`。远端会话 → 远端服务器的 `collab.state.snapshot`（`session` 参数仍是该远端会话 id）；本机会话 → 本机 sidecar。跨服务器/跨会话切换**立即**以新 client 重请求，上一台服务器的迟到回包**丢弃**（见 §11.11.5）；面板顶部在远端时显示 `@<server.id>`，本机不显示（避免噪音） |
| 侧栏 `collab` 面板（`region:"side"`, `width:"narrow"`） | 0.8.0 **主从布局**（§11.11.7）：左列表 `320px` / 右详情 `1fr`（CSS grid），窄窗口（`≤640px`，即 `max-width:640px`）回落单栏。左列表仍是 0.6.0 的三层结构：工作区头（`N 会话 · M 锁 · K 交接 · A 已归档`）→ 活跃会话行（agent + 徽标 `🔒n` / `⏳n` / `‹m›` / `⇢k` / `[archived]` / `[frozen]` / `[urgent]`）→ `已归档 N` 折叠段。点行 = **单选**该会话（`›` 高亮 + 右详情），不再行内展开；右详情自上而下是会话头（标题 / agent / **完整 sid** / 徽标）→ 关系图槽位 → 动作行槽位 → items（锁 / 交接 / owner 队列 / `↳` 拉起的会话）。选中是组件本地信号，2 s 轮询换快照**不会重置**；选中的会话从快照消失才清空并 toast「该会话已不在快照中」。租约本身是全局的，按「第一个是已列会话的持有者/排队者」归到对应工作区，否则落「全局」组 |
| composer pill | 当前会话「锁 N · 等待 M」；`success` 只持有 / `warning` 排第 1 位 / `danger` 排在更后面。展开是逐条租约（只显示，不可操作） |
| 刷新 | 有会话挂载时每 2 s 一次；**窗口隐藏时停止**、恢复可见后立即以当前会话继续（监听 `visibilitychange`，0.5.2 起；以前读 `document.hidden` 不是响应式的，隐藏不真停、隐藏时挂载的窗口也永不启动）；面板、pill、计数条、标题栏 pill 共用一个轮询与一份 store。0.5.2（R-7）：本轮请求发出后会记住目标会话，回包时若路由会话已经变了（且未隐藏 / 未 dispose）就**补排一次**——切换瞬间恰好有请求在飞也不会把新会话的 `queue` 压到下一个 tick；`inFlight` 仍然防并发，未切换不补排。0.5.3：轮询 key 改为 `${server.id}\n${session.id}`，切换服务器即重建；请求前后比对 key，不一致的回包丢弃 |
| 不可达 | RPC 被 reject（server 停 / 插件禁用 / 版本不匹配）→ 顶部「server 不可达：<原因>」，**保留上一份快照**；server 部分与工具完全不受影响 |

**TUI UI**（0.4.2 / 0.5.1）：

| 位置 | 内容 |
| --- | --- |
| `/collab`（`ctrl+shift+l`，也在命令面板里） | 打开 `session.panel` 里的 **`collab.status`** 面板；没有打开的会话时提示「先打开一个会话」 |
| 面板 | 首行时间戳 + **四个数**（`持有 · 排队 · 待受保护 · 宿主排队`）+ 一行图例（0.6.0）。0.6.0 起主体是**同一棵三层树**（工作区头 `N 会话 · M 锁 · K 交接 · A 已归档` → 默认折叠的会话行，带 `🔒n` / `‹m›` / `[frozen]` / `[urgent]` → 展开后的锁 / 交接 / 队列 / `↳` 子会话）；`已归档 N` 是每个工作区的末段，默认折叠。键盘 `j`/`k` 移动、`enter`/`space` 展开收起（只在面板拥有输入时生效），鼠标点击行同样可展开。0.8.0：`j`/`k` **选中**某行后，树下方追加 3–5 行该会话详情（`详情 …` + 五个计数 + 最多 3 条锁/交接/队列/`↳`，超出以 `… +N` 结尾），`esc` 清除选中；`enter`/`space`/鼠标点击只做 0.6.0 的展开/收起，不打开详情。挂载时未选中，树与 0.6.0 逐字一致 |
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


#### 11.11.6 三层看板（0.6.0）：GUI / TUI 同一份派生

快照是**三份独立列表**（会话 / 租约 / 交接 + 队列），平铺渲染时关系会丢：会话行不知道自己持有/排队/发起了什么，
「谁拉起了谁」只存在于记录的 `claim.kind`，已归档会话干脆不出现。0.6.0 把关系集中到一个**纯函数**：

```text
core/board.ts  buildBoard(snapshot, freezes, now, me?)  →  Workspace[] → Session[]
  Workspace: { workspace, sessions[], archived[], counts{sessions,locks,handoffs,archived} }
  Session:   { sid,title,agent,busy,workspace,archived,frozen?,urgent,
               locks[], handoffs[], spawned[{sid,state,archived,title?}], queue[],
               badges{held,waiting,handoffs,queue} }
```

| 规则 | 口径 |
| --- | --- |
| 归属 | 租约：`holders` 或 `waiting` 含本 sid；交接：`from` 或 `claimBy` 是本 sid；队列：快照 `queue` 属于**调用方**（`mineFor(session)`），只挂到 `me` 那一行 |
| `↳` 拉起 | `handoff.kind === "spawn" && from === sid`，子会话 id = `handoff.spawned ?? claimBy`（`expiredClaim` 的 spawn 也保留）；**只一层**，不递归 |
| 归档 | `session.archived === true` 进 `archived[]`，不混入活跃列表；数量进工作区头的 `已归档 A`，面板默认只显示 `已归档 N` 折叠段 |
| 冻结 / 加急 | `frozen` 优先用快照里的 `session.frozen`，否则按 **`core/freeze-pure.ts` 的 `freezeFor`**（与 `core/freeze.ts` 同一实现）：session（含祖先）> workspace，过期即不显示；`urgent` = 该会话任一交接或队列项 `priority:"urgent"` |
| 老快照 | `archived` / `kind` / `spawned` / `priority` 全部**可选**：缺失即 `false` / 空，不崩、不显示空徽标；快照方法签名不变 |
| 只读 | 看板只归类已有数据，没有释放 / 归档 / 解冻按钮（R5）；展开状态是组件本地信号，轮询不重置 |

- GUI：`PanelView` / `GroupView` 渲染 `buildBoard(...)`；会话行是按钮，`aria-expanded` 反映展开，明细缩进显示 `↳` / 锁 / 交接 / 队列。
- TUI：`collab.status` 面板同一棵树（缩进 2 空格、默认折叠）；`j`/`k` 移动、`enter`/`space` 切换、`onMouseDown` 点击行；
  侧栏（`sidebar.content`）仍是四数一行，不变。
- 兼容：快照里 `sessions` 为空 / 某行的持有者或 `from` 不在列表（老 server、手写夹具、会话已结束、超出 `limit:100`）时，
  未被任何会话行认领的租约 / 交接 / 队列在树后各自成段，标题注明 `· 未归属`（GUI 与 TUI 共用 `boardOrphans`），
  不静默丢行；头部计数与正文因此始终一致。
- 单一真源（0.6.1）：冻结判定（`freezeFor` / `liveFreezes`）只在 `src/core/freeze-pure.ts` 实现一次，
  `src/core/freeze.ts` 再导出给服务端调用方，`src/core/board.ts` 直接用它——board 里不再有
  `until` / session-vs-workspace 的第二份判断（纯模块不含任何 `node:` 导入，GUI bundle 才装得下）。


#### 11.11.7 看板主从布局（0.8.0，`board2-layout`）

0.7.0 的看板是「单栏 + 行内展开」：会话一多就要反复折叠，详情和列表抢同一列。0.8.0 把 GUI 面板拆成
**左列表 / 右详情**，并给随后两个子任务（`board2-graph` 关系图、`board2-actions` 快捷动作）留好槽位。

```text
PanelView                       （唯一的 2 s store 仍在这里；不新增轮询）
 └ .collab-split                CSS grid：320px + minmax(0,1fr)
    ├ .collab-sidebar           buildBoard() 的树（工作区 → 会话 → 已归档折叠段）+ 未归属段
    └ .collab-detail-pane       （窄屏 ≤640px 时与 sidebar 二选一）
       ├ .collab-back           「← 返回列表」（仅窄屏）
       ├ DetailHeader           标题 / agent / 完整 sid / 徽标
       ├ GraphSlot              `data-collab-slot="graph"`（0.8.0 `board2-graph`：三级关系图，见 §11.11.8）
       ├ ActionRow              `data-collab-slot="actions"`（空；动作子任务挂这里）
       └ DetailItems            锁 → 交接 → owner 队列 → `↳` 拉起的会话（复用 board.ts 派生）
```

| 规则 | 口径 |
| --- | --- |
| 单选 | `createSignal<string \| null>`（按 **sid**，跨快照稳定）；选中的行加 `collab-session-selected` 与 `›`，再点同一行 = 取消 |
| 轮询不重置 | 选中/展开/窄屏判定都是**组件本地信号**；`sharedStore` 每 2 s 换 `data` 不触碰它们（测试用 `data-collab-at` 计数证明「期间确实换过一次快照」） |
| 消失清空 | `createEffect` 检查选中的 sid 是否仍在 `buildBoard()` 的活跃或已归档列表里；不在才清空 + `ctx.toast.show`「该会话已不在快照中」。**没有快照**（adopt / 一次失败）不算消失——保留行，由横幅解释 |
| 归档 | 会话被归档后**仍存在**于快照与 `archived[]`，详情继续显示并带 `[archived]`；只有真的离开快照才清空 |
| 窄窗口 | `matchMedia('(max-width: 640px)')`（没有 `matchMedia` 的宿主 = 宽屏）：单栏时 `selected ? 详情 : 列表`，详情顶部给「← 返回列表」；CSS 里同一断点把 grid 收成一列（`@media (max-width:640px)`） |
| 槽位 | 两个槽位都是**真实元素**（`data-collab-slot`），不是 `null`：子任务在原地挂载，不重排布局。`GraphSlot` 已由 `board2-graph` 填上三级关系图（§11.11.8）；`ActionRow` 仍为空（`board2-actions` 挂载点），`min-height:0`、不占高度 |
| 只读 | 本子任务不引入任何写路径：新增的 DOM 事件只有「选中 / 返回列表」两个本地信号写操作 |

**TUI**（树不变）：`j`/`k` 移动光标即**选中**（`esc` 清除），树下方追加 3–5 行
`详情 <sid> · <agent> · <标题>` + `N 持有 · N 排队 · N 交接 · N 队列 · N 拉起` + 最多 3 条明细
（锁 / 交接 / 队列 / `↳`，超出以 `… +N` 结尾）。挂载时 `active=false`：没有 `›` 也没有详情块，
0.6.0 的树断言逐字不变；`enter`/`space` 与鼠标点击保持 0.6.0 语义（只展开/收起，**不**打开详情块），`escape` 只清除选中。

**回滚**：`git restore -- src/gui.tsx src/tui.tsx test/gui-panel.mjs test/tui-render.mjs`；没有运行时开关。

#### 11.11.8 三级关系图（0.8.0 `board2-graph` · 0.8.2 缩放/平移/布局 `graph-zoom`）

主从布局之后还剩一个说不清的关系：**谁和谁在协作**。0.6.0 的看板只能回答「这个会话持有/发起了什么」，
回答不了「这条工作流从哪个工作区来、下一跳是谁」。这一节加一张图，三个级别，GUI 画 SVG、TUI 画文本树，
**两个面板调同一个纯函数**（`src/core/graph.ts`），禁止各自算。

```ts
buildGraph(snapshot, freezes, { level, workspace?, session?, now? })
  → { nodes: GraphNode[], edges: GraphEdge[], truncated: number }

GraphNode  { id, kind: 'workspace'|'session', label, archived?, frozen?, urgent?, parent? }
GraphEdge  { from, to, kind: 'handoff'|'origin'|'spawn'|'subagent', bid?, state?, count? }
```

| 级别 | 什么时候 | 节点 | 边 |
| --- | --- | --- | --- |
| **L0 `global`** | 没有选中（GUI 右详情初始态 / TUI 未 `j`/`k`） | 工作区（`id` = 绝对目录，`''` = 全局组；`label` = 末段路径） | 跨工作区交接；**同一对工作区合并为一条** `count`（同工作区不画自环） |
| **L1 `workspace`** | GUI 点了工作区标题（TUI 没有工作区光标，不产出） | 该区全部会话（含已归档）+ 每条**跨越本区边界的边（出/入）**对应的一个**对端工作区节点**（不展开对方会话） | 本区内 `handoff` / `spawn` / `subagent` / `origin`；跨界的边折到对端工作区节点上（GUI 画虚线） |
| **L2 `session`** | 选中一个会话 | 该会话（中心）+ 直接邻居（±1 跳），上限 **8** 个，超出进 `truncated`（GUI 显示 `+N`） | 两端都在保留集合里的边（诱导子图），方向、类型见下 |

**边的来源与方向**（一条记录只产生一条主边，避免同一对会话画两遍）：

| `kind` | 来源 | 方向 | 样式（GUI / TUI） |
| --- | --- | --- | --- |
| `handoff` | 非 spawn 的交接 | `from → claimBy`（请求方 → 承接方） | 实线 / `─交接─▶`（合并时 `─交接N─▶`） |
| `origin` | `SnapshotHandoff.origin`（0.8.0 起由 `toHandoff` 透传 `record.origin.sid`；单跳同 `from` 不写） | `origin → from`（链头 → 上一跳） | 虚线 / `┄origin┄▶` |
| `spawn` | `kind === "spawn"` | `from → spawned ?? claimBy` | 点线 / `↳`（与看板的 `↳` 同一记号） |
| `subagent` | `session.parent` | `parent → sid` | 点线 / `┈agent┈▶` |

- `origin` 是快照字段（`SnapshotHandoff.origin`，**可选**）：`toHandoff` 从 `record.origin.sid` 透传，
  `origin === from` 的单跳不写；缺失就不画，绝不造节点。`graph.ts` 仍容忍旧远端可能透传的
  `origin.sid` 对象 / `originSid` 两种拼写（`test/graph-shape.mjs` 有真实 `buildSnapshot` 路径与
  旧拼写各一条断言）。
- **L0 的对端工作区**：对端会话不在本快照时，用 `handoff.workspace`（peer 记录里它是**目标**工作区，
  见 `src/tools/broadcast.ts`）；请求方目录未知时归入 `''`（全局）——快照不携带对方目录，宁可归到全局
  也不猜。
- **L1 的未知对端**：快照里没有该 sid 的目录，无法判断它属于哪个工作区，因此该边**丢弃**，不会错误地
  折到本工作区节点上。
- 冻结 / 加急：与看板同一优先级（快照 marker 优先，其次 `core/freeze-pure.ts` 的 `freezeFor`；
  `urgent` 只来自交接的 `priority:"urgent"`），过期冻结不画。

**确定性（R4）**：节点按 `id`、边按 `from + kind + to` 排序，都用**码位比较**（不用 `localeCompare`——
它随机器 locale 变）。所以「同一快照两次渲染」字节一致，且**输入数组顺序颠倒也一致**（测试两条都断言；
后者才是排序真正买到的性质）。`Map` 插入序不作为契约；同一 `(from,kind,to)` 出现多条记录的极端情况，
保留输入中的第一条的 `bid/state`（GUI/TUI 都不显示 `bid`）。

**GUI 交互**（`GraphSlot`，内联 SVG，无图库）：

| 动作 | 效果 | 状态位置 |
| --- | --- | --- |
| 点会话节点 | 选中该会话：左列表高亮、右详情 `DetailHeader` / items 跟着换（等价于点列表行） | `PanelView` 的 `selected` 信号 |
| 点工作区节点 / 左侧工作区标题 | 切到 L1（再点一次取消）。会话与工作区选中**互斥** | `selectedWorkspace` 信号 |
| 节点右上 `▸/▾` | 折叠 / 展开该节点的**一跳邻居**（中心节点折叠 = 隐藏所有邻居） | `GraphSlot` 本地 `createSignal<Set<string>>`，轮询不重置 |
| 悬停节点 | 相邻边加 `collab-graph-edge-active`（只高亮相邻） | 本地 `hovered` 信号 |
| `+N` | `truncated` 个节点未显示（L2 上限 8） | `graph().truncated` |

布局与视图（缩放 / 平移）在 0.8.2 拆到 `src/core/graph-layout.ts`（纯函数，窗口之外可单测），见下节。
所有点击都只写上面两个选中信号——看板仍然**只读**（R5），没有释放 / 归档 / 解冻 / 投递。

**TUI**（`collab.status` 面板）：树下方多一段文本树，级别跟选中走（未选中 = L0，选中 `ses:` 行 = L2）。
缩进 2 空格、深度上限 3；`─交接─▶` / `┄origin┄▶` / `┈agent┈▶` / `↳`；每行 `clip` 到面板宽度，
窄终端以 `…` 截断（30 列实测不崩）。展开/收起与选中都是本地状态，`buildGraph` 不额外 `load()`。

**测试与变异（0.8.0）**：`test/graph-shape.mjs`（L0/L1/L2 的节点/边/方向/类型、`+N`、两次构建与**输入倒序**一致、
目录 hash 前后不变；**真实路径** `buildSnapshot → toHandoff → buildGraph` 出 `origin` 边）；`test/gui-panel.mjs` 34 → 47（三级别切换、点节点联动、折叠/展开、悬停高亮、`+N`、轮询后图与选中不变、
四类边线型逐类断言）。变异：M3 去 `origin` 透传（snapshot 1 + graph 2 条红）、M4 `spawn` 改实线（线型 1 条红）；`test/tui-render.mjs` 56 → 60（L0 `─交接─▶`、会话选中切 L2 的 `↳`、30 列 `…`）。
变异两组都实测失败：① 把 `handoff`/`spawn` 边方向画反 → 方向断言失败；② 去掉节点/边排序 → 「输入倒序
一致」与「按 id 排序」断言失败。

**缩放 / 平移 / 布局（0.8.2，`graph-zoom`）**

0.8.0 的图是 320×180 上的**一圈**均匀分布、标签最多 14 字：节点一多，标签互相压、连线穿过文字，
而且**不能缩放**（截图见任务）。0.8.2 把三件事一起改：

```ts
layoutGraph(nodes, { width: 640, height: 360, center?, label? })
  → { points: Map<id,{x,y}>, labels: Map<id,string>, widths: Map<id,number>, width, height }

truncateLabel(text, max = 8)      // 码点计数，8 个含 `…`
viewBoxOf(zoom, pan, size?)       // 视图框（已钳制）
zoomBy(zoom, pan, deltaY, pointer, rect?)  // 一步滚轮/双指，围绕指针
clampZoom(zoom) / clampPan(pan, zoom) / viewBoxAttr(box)
```

| 项 | 规则 |
| --- | --- |
| 画布（R3） | **640×360**（16:9），`viewBox` 由缩放/平移驱动；CSS 只按面板宽度缩放 |
| 分层 | 中心 1（L2 是**选中的会话**，其它级别是排序后的第一个）→ 内环 ≤6（椭圆 124×84）→ 外环其余（252×148） |
| 标签 | 一律截断到 **8 个码点**（含 `…`）；盒宽 = 标签估算宽 + 12 内距 + 12 角标位，夹在 `44…96` |
| 不重叠 | 布局**自检**：环排布只有在「任意两盒不相交」时才采用，否则退回 6 列网格（≤96 节点不可能重叠）。判定用盒的**真实宽度**（`widths`），不是猜 |
| 稳定（R4） | 无时钟、无随机、无 `localeCompare`；坐标一次性取 1 位小数，同一节点数组两次布局字节一致；`buildGraph` 先按码位排序，所以**输入倒序也一致** |
| 缩放（R1） | 滚轮 / 双指（`ctrl+wheel` 同一条路），`0.6×–2.5×`，指数步长 `exp(-deltaY/500)`，**以指针为中心**（指针下的图坐标不动） |
| 平移（R2） | 空白处 `pointerdown` 起拖、`document` 的 `pointermove` 平移、`pointerup`/`pointercancel` 结束；视图最多离开画布 **10%**，越界被拉回；`zoom<1` 时视图比画布大，直接居中 |
| 复位 | **双击空白**回 1× / pan 0；双击节点**不**复位 |
| 命中 | 节点几何永远是布局坐标，缩放/平移只改 `viewBox` —— 命中由浏览器做，缩放后点节点、折叠角标都还准 |
| 只读（R5） | `zoom` / `pan` 是组件本地信号，不写文件、不写快照、不动图数据；拖拽监听在 `onCleanup` 里摘掉 |

**测试与变异**：`test/graph-shape.mjs` 36 → 53（三档 `viewBox` 逐字、钳制、围绕指针不动、
8 节点与 1…24 各计数的包围盒不相交、两次布局与输入倒序一致、标签 8 码点含 emoji 不劈半）；
`test/gui-panel.mjs` 68 → 82（`viewBox` 从 640 起、滚轮上/下的范围钳到 0.6 / 2.5、拖拽越界被夹在 ±64、
双击复位、双击节点不复位、缩放后点节点仍选中、折叠仍生效且节点几何未变、轮询保留缩放；PN11 另加「渲染出来的 8 个盒不重叠 + 标签 ≤8」）。
变异实测：M1 去掉布局自检 + 收紧环半径 → 关系图 2 条 + 面板 1 条红；M2 去掉 `clampZoom` → 关系图 1 条 + 面板 1 条红
（滚到 4447×）；M3 去掉 `clampPan` → 关系图 3 条 + 面板 1 条红（`data-graph-pan` 停在 -2280）。

**回滚**：`git restore -- src/core/graph.ts src/gui.tsx src/tui.tsx src/index.ts test/graph-shape.mjs test/gui-panel.mjs test/tui-render.mjs`，
再删掉 0.8.2 新增的未跟踪文件 `rm src/core/graph-layout.ts`（`git restore` 对未跟踪文件会整条报错，不能混在一起）。

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
- **消息 thread 的降级（0.7.0）**：`collab_send` / `collab_reply` 建立的 thread 没有广播记录，过去直接报错
  （7 个 thread 里 6 个命中）。现在改为 `kind=messages` + `target` + `status` + 最近 ≤5 条出入站摘要
  （各 ≤120 字）+ 关联交接单（索引里的 `bid`）；只有索引与 thread store 都不认识的 thread 才保留原错误。
  同批新增的 `collab_threads { target }` 一次列出「与该 target 的全部 thread」并指出先答哪个——见 §11.17。
- **非目标**：不做历史归档查询（用 `collab_list` / 归档过滤）、不做自动催办（用 `collab_escalate`）。

#### 11.14.1 加急（`collab_escalate`，0.6.0）

「冻结 / 停手 / 先别合」这类话不能等下一轮。`collab_escalate` 把一单加急，**复用宿主的
`delivery:steer`**（桌面端 UI 的「引导」按钮就是它）——不新增 RPC、不直连 API、不加投递机制：

```text
collab_escalate { bid:"b_14528d828f9df27b", reason:"冻结：store.ts 先别动", confirm:true }   # 默认 steer
collab_escalate { threadID:"t_m3k9_abcd", reason:"…", mode:"queue", confirm:true }             # 显式排队
collab_escalate { session:"ses_e105…d85", reason:"…", confirm:true }                            # 直接点名会话
```

- **目标三选一**，`reason` 必填（≤200 字，控制字符剥成空格）；`confirm:false` 只预览（零写入、零 prompt）。
- **默认 `steer`**：并入目标当前轮；显式 `mode:"queue"` 才排队。只读 agent（`explore` / `plan`）目标
  **强制 `queue`**（沿用 `resolveMode`），回执写 `queue(forced)`。
- **回执是真实的**：`delivery=` 取宿主返回的 `result.delivery ?? mode`。目标空闲时 `steer` 会降级为
  `queue`，回执如实打印 `delivery=queue` + 一行「宿主实际采用 queue（目标空闲 / 被降级）」。
- **记录只追加四个字段**：`priority:"urgent"` / `urgentAt` / `urgentReason` / `urgentBy`（read-merge-write）。
  `state` / `claim` / `receipt` **不变**；`urgent` 也不会被自动撤销——单闭环后展示层自然不再标 `[urgent]`。
- **受保护目标（含血缘）**：0 条 `session.prompt`，改写一条 `priority:"urgent"` 的 owner-queue 项
  （`collab_request_owner` 同一个队列 / 上限 / 回收），回执 `canPush=false` + `第 K/N 位（未读）`；
  对端下次运行在自己的 `context` 注入里看到 `- [owner-queue] [urgent] …`。
- **幂等（防手抖，不是定时器）**：同 `bid` + 同 `reason` 在 **5 分钟**内重复调用只刷新 `urgentAt`，
  **不重复投递**（受保护目标也不重复写队列项）。换一处措辞 = 新加急；定时重复催办由人决定。
- **展示**：`collab_list` 未闭环交接行尾 `[urgent]`，我提交的队列项标 `· [urgent]`；
  `collab_status` 读 `priority=urgent`；`collab.state.snapshot` 的 `handoffs[]` / `queue[]` 增**可选**
  `priority:"urgent"`（TUI / GUI 只在已有行尾加标记，不改布局）。
- **边界**：不因加急放宽任何护栏——不 push 受保护线、不改 permissions、不改 `state`；已闭环的单拒绝加急。

#### 11.14.2 冻结（`collab_freeze`，0.6.0）

「先别动」如果只是一句话，插件并不知道：新会话 / 新的交接还会继续往里写，冻结只靠人记。所以 0.6.0 把它做成本地
**可逆、可过期**的一层标记，被工具与展示共同遵守：

```text
collab_freeze { scope:"session",   target:"ses_…",       reason:"等 schema 线确认", until:"2h", confirm:true }
collab_freeze { scope:"workspace", target:"/data/project/mux", reason:"本仓暂停接管", confirm:true }
collab_freeze { scope:"bid",       target:"b_…",         reason:"这一单先别改", confirm:true }
collab_freeze { scope:"session",   target:"ses_…",       freeze:false, confirm:true }   # 解冻（幂等 no-op）
```

- **输入**：`scope` 三选一；`target` 除 `workspace` 外必填（`session` 收别名；`workspace` 缺省 = 当前工作区，
  且必须是绝对路径；`bid` 必须是真实存在的记录，拼错给可读错误）。`reason` 冻结时必填（≤200，剥控制字符）。
  `until` 相对（`"30m"`/`"2h"`/`"45s"`/`"1d"`）或绝对 ISO，默认 **30 分钟**、上限 30 天；解析不出直接报错，
  **不会**静默回落默认值。`confirm:false` 是零写入预览（作用域 / 到期 / 受影响会话 / 将写入的文件）。
- **存储**：`~/.config/opencode/collab-freeze.json` = `{ version:1, entries:[{scope,target,reason,by,at,until,notifiedAt?,notifiedFor?,delivery?}] }`。
  每次写都是 **读-合并-写**（读当前 → 变异 → 清理过期 / 去重 → `tmp + rename`），并有一个 `<file>.lock` 短锁
  （`open(…,"wx")`，2 秒视为陈旧可回收），所以两个工作区（不同进程）同时写不会互相覆盖。文件坏 / 读不出按
  **空** 处理并记一次日志——冻结是协作元数据，不能让工具挂掉。
- **到期**：`readFreezes(now)` 只返回 `until > now` 的项，过期即不存在；**写入时**顺手清理。没有定时器，
  没有清理任务，`until` 就是唯一真源。
- **优先级**：`session`（自身，或 `parentID` 链上任一祖先）> `bid` > `workspace`；血缘复用
  `createLineage(...).protectedAncestor` 的同一套有界、防环走查，所以子会话绕不过被冻结的父线。
- **强制点**（全部是「新建协作」，0 写入，错误文案统一带可复制的解冻命令）：

  | 工具 | 判定 |
  | --- | --- |
  | `collab_handoff` | 目标本身 / 祖先 / 目标工作区冻结 → 拒绝（预览只提示） |
  | `collab_broadcast` | 工作区冻结 → 拒绝（读提案之前）；spawn 前再判一次 |
  | `collab_accept` | 该 `bid`、领取方会话（含祖先）或该单工作区冻结 → 拒绝（在 `persistRefresh` 之前） |
  | `collab_escalate` | 冻结优先 → 拒绝（加急也不行） |
  | `collab_list` / `collab_status` | **不受限**，只展示 |

- **展示（只读）**：`collab_list` 的会话行尾 `[frozen] 冻结至 HH:MM`（继承时附 `（继承 ses_…）`），未闭环交接行尾
  `[frozen]`，并单独列一段「冻结（临时，到期自动失效；N 条）」+ 解冻命令；`collab.state.snapshot` 的 `sessions[]`
  增**可选** `frozen`、`handoffs[]` 增**可选** `freeze`（`{scope,target,until,reason}`，TUI / GUI 只在已有行尾加
  `frozen` 标记，不改布局）。列 / 看都不写文件、不写 `notifiedAt`。
- **送达（通知一次）**：写入后给目标投一条 `[frozen] …`——非受保护目标走 `session.prompt { delivery:"queue" }`
  （**不用 `steer`**：冻结不是加急打断），回执 `cid` / `messageId` 记进条目 `delivery[]`；受保护目标（含血缘）
  **0 条 prompt**，改写一条 `priority:"urgent"` 的 owner-queue 项（同一队列 / 上限 / 回收），条目里记 `queueId`。
  投递失败只记录（`delivery[].error`），**不影响冻结生效**。`scope:"workspace"` 只通知该目录的根会话
  （排除自己 / 子会话 / 已归档，最多 5 个），不制造 prompt 风暴。
- **被冻会话自己**：它下一次 `context` 注入里看到一次 `[collab-freeze] 你被冻结：原因 / 到期 / 解冻命令 / 只阻止新建协作`
  （继承时写明 `继承自祖先 ses_…`）；`notifiedAt` / `notifiedFor[]` 在**注入块 push 成功之后**才写（与 §11.9.3 的
  F1 规则一致），所以注入失败会在下一轮重试而不是永久丢失。`notifiedFor[]` 让「一次」是**按会话**的：被冻结的父线
  覆盖多个子会话时，每个子会话各得到一次提示。重新冻结（新 entry）会再提示一次。
- **解冻**：`freeze:false` + 同 `scope`/`target` 删除条目，删除不存在的条目是 no-op（幂等）；解冻不通知任何人。
- **语义边界**：冻结 **≠** 归档 **≠** 删除——不隐藏会话、不删文件、不写 `permissions`、不切 agent；
  也不覆盖既有硬边界（受保护线依然 0 投递、只读 agent 依然被强制 `queue`），只是**叠加**一层拒绝。
- **回滚**：删掉 `~/.config/opencode/collab-freeze.json`（或 `rm` 单条）即全量解除；代码回滚见任务目录 `implement.md`。

### 11.15 协作自动感知（0.7.0）

**为什么**：0.6.0 把工具配齐了，但「什么时候用哪个」仍然靠人提醒——需要帮忙的会话不知道还有别的会话可问，
跨工作区更是全靠人点。实测链路 A（issues-wt）→ B（mojo-studio）就是一个例子。0.7.0 只补两处**只读**提示：

#### 11.15.1 需求侧：一行双计数（R1 / R3 / R4 / R5）

`context` 注入**末尾**（所有既有行之后）追加：

```text
协作：本工作区候选 N（collab_handoff） · 其它工作区候选 M（collab_broadcast，需提案）
```

| 项 | 规则 |
| --- | --- |
| N | 同 `ctx.location.directory` 的**根会话**里，排除自己、子会话（`parentID`）、已归档（`time.archived`）；**无 workspace 时 N=0**（否则同一批会话会被 N、M 各算一次） |
| M | 其它工作区（按 `location.directory` 分组）的同口径会话数；一次 `session.list` 页内去重 id；页上限 `AWARENESS_LIST_LIMIT=200`，宿主会话更多时 M 是**下界** |
| 单边为 0 | 省略该半句（只有跨工作区时只留后半句；只有本工作区时只留前半句） |
| N+M = 0 | **不注入** |
| 频率 | 每会话每 **10 分钟**最多一次（进程内 Map；插件重载重置） |
| 成本 | 每窗口 **2 页**：一页带 `directory` 数本工作区（N）+ 一页全局数其它工作区（M），各一次；宿主抛错 → **M 省略、只写 N**，不抛 |
| 抑制条件 | `awareness:"off"` · 当前会话 `[protected*]` · 当前会话有**自己发起的未闭环交接**（`from.sid = 自己` 且状态非 `done/blocked/expired`） |
| 预算 | 与 `maxInject` 共享：未读消息已占满（`shown = maxInject`）时本行**不追加**——交接 / 队列 / 未读永远优先 |
| 写入 | **零**。不写记录、不建 thread、不投递；只读会话列表与广播目录 |

不猜「该找谁」：行里只有数量与通道，选人仍由 `collab_handoff` 打分或人指定。`collab_list` 看名单。

#### 11.15.2 承接侧：协议头 + **可执行**的回执命令（R2）

交接**投递文本 / 注入块**的前几行固定为（`src/core/verdict.ts` 的 `protocolHeader`）：

```text
你是承接方（bid=b_… / thread=t_…）
完成后回执：collab_reply { threadID:"t_…", text:"[handoff] DONE b_… <摘要>", confirm:true }
阻塞回执：collab_reply { threadID:"t_…", text:"[handoff] BLOCKED b_… <缺什么>", confirm:true }
```

这三行是**能直接执行、执行后真的闭环**的（0.7.0 复核对第一版的修正，见下）。跨工作区（peer，跨 location 没有
可用 thread）第二行改为：

```text
完成后回执：[handoff] DONE|BLOCKED b_… <摘要>（把这一行写进 collab_send 的 text 发给发起方，confirm:true）。
```

> **为什么必须带 `text` 里的 `[handoff]` 行**：`collab_reply` 的 `text` 是必填参数；`kind` 根本不在它的入参里，
> 而且入站把显式 `note` 当作「有意非回执」忽略；闭环只认正文里的 `[handoff] DONE|BLOCKED <bid>`。
> 第一版写的 `collab_reply { threadID, confirm }` + `kind:"note"` 两条路都走不通（照抄报 `text 不能为空` /
> 发出去了但记录停在 `acked`，只能等 2h 的 `acked-stale` 兜底），所以回执命令必须把 `[handoff]` 行放进 `text`：
> 只有「能闭环」的命令才配当协议头。

覆盖三处投递面：`collab_handoff` 的 thread 投递正文（正文最前几行）、peer 的**接管请求条目**
（该条目自己的前两行；注入块整体仍以 `[collab-handoff] 交接链路提醒…` 起头，协议头不抢块首）、以及
`takeoverBody`（spawn / `busy > 30min` 叫醒 / 重发，投递文本最前几行）。正文里的 `①②③` 步骤与 `DECLINE` 不变——
协议头只是把「你是谁、怎么回」提到最前面（试点里对端把交接当分析请求、答完就算，就是缺这一句）。

> `DONE|BLOCKED` 是**模板**，不会被回执解析误判：`[handoff]` 行必须点名**当前 bid**，且摘要位残留
> `<…>` 占位符一律当作回显（§5.3 的 H1 规则），所以照抄协议头（不替换占位符）不会闭环任何单。

#### 11.15.3 验收与回滚

| 用例 | 期望 |
| --- | --- |
| 同工作区 1 + 其它工作区 3 | `本工作区候选 1 · 其它工作区候选 3`（子会话 / 已归档不算） |
| 仅跨工作区 | 只有后半句 |
| 无 `ctx.location.directory` | `N=0`，只出现后半句（同一批会话不被两半各算一次） |
| N+M = 0 / protected / 有未闭环交接 / `awareness:"off"` | 不出现 |
| 10 分钟内两次 `context` | 只出现一次；两页（本工作区 + 跨工作区）各只读一次（第二次连查询都不发） |
| 宿主列表抛错 | 只写 N，不抛 |
| 承接方块 | 首行含「承接方」；第二行是可复制的 `collab_reply`/`collab_send` 命令，且 `text` 里带 `[handoff]` |
| 照协议头回执 | `collab_reply {text:"[handoff] DONE <bid> …"}` → 记录 `done`；BLOCKED → `blocked` |

回滚：`awareness:"off"` 立即归零；代码见任务 `11-19-collab-awareness` 的 `implement.md`。

### 11.16 交接对接人（`origin`，0.7.0）

**为什么**：真实链路 A(`ses_edc3…`, muke-interface) → B(`ses_e0e3…`, mojo-studio) → C(`ses_e4c0…`) 里，
B→C 的记录 `from.sid` 只能是 B，A 只能写在正文里。C 遇阻塞不知道 A 是谁，只能回 B、B 再转 A、A 在别的 thread
回「等你结论」、B 再指路——**4 跳**才回到问题本身（本可 2 跳）。实测把「对接人 sid + location」写在正文首行后
一次即通，所以 0.7.0 把它变成记录字段与固定渲染。

#### 11.16.1 字段与入参

记录新增**可选**字段（旧记录没有它，一切照旧）：

```jsonc
"origin": { "sid": "ses_…", "role": "requester", "directory": "/data/project/muke-interface" }
```

> `role` 目前**只保留在类型里**（`normalizeOrigin` 容忍 `requester|implementer|observer`）：工具从不写它，
> 写入的只有 `sid` 与（尽力而为的）`directory`。样例里的 `role` 是手写记录可用，不是工具产出。

| 工具 | 入参 `origin` | 语义 |
| --- | --- | --- |
| `collab_handoff` | `ses_…` 或别名 | 写进记录；投递正文的协议头后加「对接人」行 |
| `collab_broadcast` | `ses_…` 或别名 | 同上（peer 记录 / spawn 记录都写） |
| `collab_send` | `ses_…` 或别名 | **只影响正文**：首行加「对接人」行（不写记录、不继承） |

**一层继承（B 不需要手填）**：未显式给 `origin` 时——

1. 若当前会话是某条**未闭环**交接的承接方（`claim.by = 本会话`），取该记录的 `origin ?? from`；
2. 否则 = 本会话。

于是 A→B 的第一跳不写 `origin`（`from` 本身就是链头），B→C **什么也不填**，C 的记录里 `origin` 就是 A。
继承只取一层（写入的是解析后的值），C 再往下转也不会丢 A。

- `origin.sid === from.sid`（本会话自己）不写进记录、也不渲染——单跳交接的输出与 0.6.0 逐字一致。
- 别名解析失败 = **可读拒绝、0 写入**（`未知对接人 "…"：既不是 ses_ 会话 id，也不在别名表里`）。
- `origin` 只是展示/回路字段：指向 `[protected*]` 不产生任何投递，任何护栏都不因它放宽。
- `directory` 尽力而为：显式 sid 时向宿主要一次会话信息（失败只影响显示，不抛），继承时直接沿用上一跳记录里的目录。

#### 11.16.2 渲染（三处固定同一行）

承接方拿到的块（`protocolHeader` / `takeoverBody` / peer 接管请求 / `collab_handoff` 正文）在协议头之后多一行，
**仅当 `origin` 存在且不同于 `from.sid`**：

```text
对接人（非本单发起方）：ses_A @ /data/project/muke-interface
```

回执指引（`handoffActions` 的 ② 之后）同字段，并给出「跨层结论可直接发给它」的那一条命令：

```text
   对接人（非本单发起方）：ses_A @ /data/project/muke-interface —— 跨层结论可直接发给它：collab_send {target:"ses_A", text:"[handoff] DONE b_… <摘要>", confirm:true}（同一条 [handoff] 行也能闭环本单，不必再经发起方转发；仅限本单发起方或对接人，第三方发送不会闭环）
```

这条命令**真的能闭环**（0.7.0 复核 B 修）：`collab_send` 把「正文含 `[handoff]` + bid 归属该单 + 发送者是该单领取人 +
目标是本单发起方**或对接人**」的遗留形态按 `kind=reply` 投递，接收侧才会认这一行。
两个边界必须记住：① 目标只有**两个**（`from.sid` / `origin.sid`），发给第三方仍是普通 `request`，不闭环；
② 这只是「回执改写」，**受保护投递规则一点没放宽**——`origin` 指向 `[protected*]` 时照旧拒投。

`receiptMode:"pull"` 时只显示这一行（照旧写在承接方自己最后一条回复里，不邀请 `collab_send`）。
只读视图：`collab_status` 头部 `origin=ses_… @ <dir>`；`collab_list` 行尾 ` via ses_…`（同样仅当 `origin ≠ from`）。

#### 11.16.3 三行模板（提案 / bid / 对接人）

人工转达（不在工具链路里）时照这三行写，对方不需要再问「该找谁」：

```text
提案：<目标工作区>/docs/issues/<file>.md
bid：b_…
对接人（非本单发起方）：ses_… @ <对接人的 location.directory>
```

工具不强制正文格式，只校验 `origin` 的 sid / 别名是否可解析——上面三行是**人读**模板，等价于记录里的三个字段。

#### 11.16.4 验收与回滚

| 用例 | 期望 |
| --- | --- |
| A→B 第一跳（无 `origin`） | 记录无 `origin`，输出与 0.6.0 逐字一致 |
| B 已领取 A 的单 → B→C 不填 `origin` | C 的记录 `origin = A`（含 A 的目录），C 的注入含对接人行 |
| B→C 显式 `origin` | 覆盖继承（显式优先） |
| 旧记录 / `origin.sid == from.sid` | 无对接人行；`collab_status` 输出逐字相同 |
| 未知别名 | 可读拒绝，0 记录、0 投递（三个工具一致） |
| C 阻塞 → 直接发给 A | 真实 `collab_send {target:"A", text:"[handoff] DONE b_… …"}` 按 `kind=reply` 投递，A 收到即闭环（2 跳，`state=done`），记录仍带 `origin = A` |
| C 把同一行发给**第三方** | 目标不是本单发起方也不是对接人 → 仍是 `request`，记录保持 `acked`（只放开两个目标） |
| `origin` 指向 `[protected*]` | 只展示；对该目标投递仍被拒（`allowProtectedReply` 只看 `from.sid`） |

回滚：`git restore -- src/types.ts src/core/{claim,verdict,chain}.ts src/tools/{handoff,broadcast,send,status,list,shared}.ts`；
旧记录不受影响，新记录退化为「无对接人」。

### 11.17 thread 聚合 + 状态降级（0.7.0，只读）

**为什么**：实测一条跨仓链路里同一对会话并行 **7 个 thread**（6 个是 `collab_send` / `collab_reply`
建立的消息 thread），于是两件事都做不到：① 发消息前不知道「哪些还没闭环」；②
`collab_status { threadID }` 对消息 thread **直接报错**（`没有 thread … 对应的交接单`，7 个里 6 个命中）。
根因是 `ThreadStore` 只能按 id 读、**不能枚举**——所以补一份轻量索引，而不是让某个工具去扫全量存储。

**索引文件**（唯一新存储）：

```jsonc
// ~/.config/opencode/collab-threads.json（COLLAB_THREAD_INDEX_FILE 可覆盖路径）
{ "version": 1,
  "entries": {
    "t_m3k9_abcd": { "target": "ses_…", "kind": "handoff", "from": "ses_…",
                     "lastAt": 1795071578447, "preview": "≤80 字", "bid": "b_…" }
  } }
```

| 规则 | 说明 |
| --- | --- |
| 写点 | **只在消息真的投递成功之后**：`collab_send` / `collab_reply`（`dispatch` 成功）、`collab_handoff`（记录写完后标 `kind:"handoff"` + `bid`）。预览、护栏拒绝、投递失败都**不写** |
| 语义 | `target` / `from` 是这**两个参与者**，首次写入后不再改动（回复方向相反，两边都要能列出这个 thread；匹配用 `target === sid \|\| from === sid`）；`kind` 一旦为 `handoff` 不再退回；`lastAt` / `preview` 每次投递更新 |
| 上限 | ≤ **500** 条，超出按 `lastAt` 淘汰最旧——只在**写**路径淘汰 |
| 保留 | 读时过滤 **7 天**前的条目（不删文件） |
| 容错 | 坏文件 / 未知 `version` → 按空处理并记一次日志（索引坏了只少一行，不让工具挂掉） |
| 原子性 | 读-合并-写 + `tmp + rename`（与广播/冻结/租约同一套） |

**`collab_threads { target, includeClosed? }`**：按索引列出该 target 的 thread，join 广播记录（→ `kind:handoff`、
`state`、`bid`）与 thread store（`open|answered` + 真实出入站正文）。每行：

```
- t_m3k9_abcd  handoff  acked   14:59  out="…"  in="…"  bid=b_…  ← 建议继续
```

默认只列未闭环（交接单非终态 / thread store `status !== "answered"`），`includeClosed:true` 再列最近
**3** 条已闭环（标 `（已闭环）`）；渲染上限 **20** 条，超出 `…还有 N 个`。建议行固定指向**最新未闭环**的
thread，并给出可直接复制的下一步（交接单 → `collab_status {threadID}`；消息 thread →
`collab_reply {threadID}`）。`target` 接受 `ses_…` 或别名；未知别名是可读错误，但**不要求会话仍可读**
（thread 比会话行活得久）。

**`collab_status` 降级**：命中广播记录时行为**逐字不变**；没有记录时查索引 + `threads.read(threadID)`，
命中即返回 `kind=messages` + `target` + `state/status` + 最近 ≤5 条出入站摘要（各 ≤120 字）+ 关联交接单
（索引里的 `bid`，记录已回收则注明）。两者都没有才保留原文案（「可能拼错，或该 thread 由 collab_send /
collab_reply 建立」）。

**只读**（`collab_threads` 与降级后的 `collab_status`）：不写索引、不改 thread 状态、不投递、不刷新记录；
回归用严格宿主（所有写方法抛错）+ 索引文件 **mtime + 内容**与广播目录前后比对。

**测试**：`test/handoff-harness.mjs` S102（18 条）——1 handoff + 2 消息 thread 全列出且 kind/bid 正确、
唯一「← 建议继续」、`includeClosed` 才列已闭环、消息 thread 的 `collab_status` → `kind=messages`、未知 thread
原错误、预览零写入、坏索引按空、500 上限淘汰最旧、四个读命令只读。
变异必做：索引 key 写成 `bid` → 消息 thread 列不出；降级直接返回错误 → 对应用例失败。

**回滚**：删 `~/.config/opencode/collab-threads.json` 即失效（工具回到「只有广播记录」）；
代码 `git restore -- src/core/thread-index.ts src/tools/{threads,status,shared,handoff,index}.ts`。

### 11.18 结构化 BLOCKED（`blocked` 字段，0.7.0）

**为什么**：实测一条跨仓链路里，真正推动进展的是 BLOCKED 正文里的**一句**「做一次最小判别实验（改房态看有没有帧）」——
接收方要读完长正文才提炼得出来，转发一跳还要再复述一遍。所以把这段做成**可选结构化字段**，正文仍然自由（人话照写）。

```jsonc
blocked: {
  "need":        ["给出 09:00–10:00 的后端推送日志"],                      // ≤10 条，每条 ≤120 字
  "excluded":    ["不是权限（已用 admin 复现）", "不是时钟偏移（NTP 正常）"], // ≤20 条，每条 ≤120 字
  "minimalTest": "改一次房态看有没有帧：有帧 = 前端，无帧 = 后端推送未触发"   // ≤200 字
}
```

| 规则 | 说明 |
| --- | --- |
| 入参 | `collab_send` / `collab_handoff` 可选 `blocked`；**不传 = 输出与旧版逐字一致**（正文、协议头、回执一字不改） |
| 校验 | 超条数 / 单条超长 / 不是对象 / 三段全空 → **可读拒绝**，例如 `blocked.need[0] 最长 120 字（本次 121 字）—— 未发送任何内容（不静默截断）`；0 投递、0 写入 |
| 清洗 | 控制字符（含换行）→ 空格、空白折叠：三段都是单行，不能借换行伪造注入块的第二行 |
| 存储 | 有可解析 `bid`（入参或正文里的 `b_…`）**且** `confirm:true` **且**调用方是本单参与方（`from` / `claim.by` / `asked` / `origin`，单一实现 = `canWriteBlocked`）→ 写进 `record.blocked[]`（**保留最近 3 次**）；`state` / `claim` / `receipt` 一律不动。`collab_handoff` 的**幂等分支**（同 target + 同正文的重复调用）走同样的两道门，不会因「记录已存在」而绕过 |
| 不落库 | 没有 bid / `confirm:false` 预览 / 记录不存在 / 非参与方 / **同文去重命中（本次未投递）** → 只渲染进正文，回执写明「未落库」（去重命中的那一条已含在同一段里，不重复占名额） |
| 渲染①投递正文 | 正文**之后**追加三段：`需要对方：① … ② …` / `已排除：…；…` / `最小判别：…`（正文本身一字不改） |
| 渲染②承接方注入 | `takeoverBody`（spawn / 叫醒 / 重发）在「期望」之后、「按顺序完成」之前展示**最新一次**：各段 ≤3 条 + `（还有 N 条）` + 历史次数 |
| 渲染③`collab_status` | `BLOCKED（结构化，最新一次 / 历史 N 次；sid @ HH:MM:SS）` + 同样三行（各 ≤3 条 + `（还有 N 条）`） |
| 兼容 | 旧记录没有该字段 → 三处都渲染为空；`blocked` 不强制 kind（建议与 `[handoff] BLOCKED` 同行，回执才真的闭环） |
| 护栏 | 纯展示字段：不放宽任何投递许可（受保护目标照旧拒投），不因它改 `state` / `claim` / `receipt` |

示例（承接方把「卡住了」写成可复用的判别）：

```text
collab_send { target:"ses_发起方", text:"[handoff] BLOCKED b_14528d828f9df27b 缺后端推送日志",
              blocked:{ need:["09:00–10:00 推送日志"], excluded:["不是权限","不是时钟"],
                        minimalTest:"改房态看有没有帧：有帧 = 前端，无帧 = 后端未触发" }, confirm:true }
```

对端（发起方 / 下一个承接方）看到的是：

```text
需要对方：① 09:00–10:00 推送日志
已排除：不是权限；不是时钟
最小判别：改房态看有没有帧：有帧 = 前端，无帧 = 后端未触发
```

**测试**：`test/handoff-harness.mjs` S105（23 条）——投递正文 / 承接方注入 / `collab_status` 三处都含三段；
不传时逐字一致；五类非法输入可读拒绝且 0 投递 0 写入；无 bid、「非参与方」（`collab_send` 与 `collab_handoff`
幂等分支各一条）、`confirm:false` 预览、同文去重命中都不落库；连续 4 次只留最近 3 次；
`state` / `claim` / `receipt` 前后一致；叫醒注入含三段且排在「按顺序完成」之前；工具面 22 个（同一窗口新增 `collab_decisions`，§11.19）。
变异必做：`blockedLines` 丢 `minimalTest` → 4 条用例失败；去掉无 bid 早退 → 「无 bid」用例失败；
去掉参与方判定 → 「非参与方」用例失败（`send` 与 `handoff` 两条各一）；去掉幂等分支的 `confirm` 门 → 「预览不落库」失败；
去掉去重命中的跳过 → 「去重命中不重复追加」失败。

**回滚**：`git restore -- src/types.ts src/core/verdict.ts src/tools/{send,handoff,status}.ts`；旧记录没有 `blocked`，
回滚后只是不展示（正文里的三段仍留在历史消息里）。

### 11.19 契约决策记录（`collab_decisions`，0.7.0）

**为什么**：一次交付里 3 条**契约级**偏差（退出码 2→3、`room:order` 是纯事件型、断言只看末帧）全靠口头纠正，
跨 3–4 个 thread，最后还得人工把提案补写一遍——决定只活在聊天记录里，「后来人」要翻完所有 thread 才知道
该按哪个契约实现。所以把决定写进**交接记录本身**：只读、可拉取、和这一单绑定。

```text
collab_decisions {
  bid: "b_…",
  items: [
    { id: "exit-code", decision: "退出码用 3（不是 2）", rationale: "D-064 与 CLI 约定一致" },
    { id: "room-order", decision: "room:order 是纯事件型，不参与状态断言" }
  ],
  confirm: true
}
```

| 规则 | 说明 |
| --- | --- |
| 存储 | 记录新增可选 `decisions?: [{ id, decision, rationale?, at, by }]`；**只写这一个字段**——`state` / `claim` / `receipt` / `replies` 与 `blocked` 一律不动，也**不投递**任何消息 |
| 权限 | **只有本单发起方（`from.sid`）或承接方（`claim.by`）** 能写（`canWriteDecisions`）；其余会话——包括当前被问询的 `asked` 与转发链头 `origin`——一律**可读拒绝、0 写入**。比 `blocked`（四类参与方、无身份时 fail-open）更严，且**无身份/无参与方时 fail-closed** |
| 上限与覆盖 | `items` 1–10 条/次；`id` ≤40、`decision` ≤200、`rationale` ≤400 字（控制字符 → 空格、空白折叠，永远单行）。**同一 `id` 再写 = 覆盖**（`at`/`by` 取本次，位置移到末尾），不追加。每单上限 **20** 条：写后会超 → **可读拒绝**（0 写入），不静默淘汰旧决策；满 20 时覆盖已有 `id` 仍然可以 |
| 预览 | `confirm:false` 只返回「未写入」+ 将写入的条目（覆盖项标「（覆盖）」）+ 条数变化，记录逐字不变 |
| 渲染①`collab_status` | `决策 N 条`（或 `决策 N 条（最近 3 条）`）+ 最近 3 条 `- id: decision`，有 rationale 时括号内截断到 80 字 |
| 渲染②承接方注入 | `takeoverBody`（spawn / 叫醒 / 重发）只加**一行** `本单决策 N 条（collab_status { bid:"…" } 查看）`——不展开正文（注入要短，全文一次只读查询就能拿） |
| 渲染③`collab_list` | 未闭环交接行尾 ` decisions=N`，仅 N>0 |
| 兼容 | 旧记录没有该字段 → 三处都不多一个字；不加任何护栏、不放宽任何投递许可 |

**测试**：`test/handoff-harness.mjs` S106（24 条）——写 3 条 / 重复 id 覆盖（计数不变、只显示最新）/
五类非法输入可读拒绝且 0 写入 / 控制字符折叠 / 第三方拒绝且记录逐字不变 / `confirm:false` 不写 /
真实叫醒链路的注入只有一行计数且不含正文 / `collab_list` 行尾 `decisions=N` / `state`、`claim`、`receipt`、
`replies` 前后一致 / 无 `decisions` 的旧记录输出不变 / 写满 20 条后新增被拒、覆盖仍可。
变异必做：`canWriteDecisions` 放宽成任意会话 → 第三方两条断言失败（记录被改）；
`mergeDecisions` 改回「追加」→ 覆盖用例显示 4 条（重复 `exit-code`）并失败。

**回滚**：`git restore -- src/types.ts src/core/verdict.ts src/tools/{decisions,index,status,list}.ts`；
旧记录没有 `decisions`，回滚后只是不展示（写过的决策仍留在文件里）。

### 11.20 看板快捷动作（加急 / 冻结 / 解冻 / 归档，0.8.0，`board2-actions`）

**为什么**：0.8.0 的看板已经把「谁在等、谁被冻结、哪些交接没闭环」画出来了，但要做点什么仍得回终端敲
`collab_escalate` / `collab_freeze` / `collab_archive`。这一节给面板右详情的动作行：四个按钮，
**点一下先确认**，再走和工具**同一份**实现。

#### RPC（additive）

```ts
// src/rpc.ts — `collab.state` 新增四个写方法（读方法 snapshot 不变）
escalate(input: { target: string; reason?: string; mode?: string; session?: string }): Promise<ActionReceipt>
freeze(input:   { target: string; scope?: string; until?: number|string; reason?: string; session?: string }): Promise<ActionReceipt>
unfreeze(input: { target: string; scope?: string; session?: string }): Promise<ActionReceipt>
archive(input:  { target: string; restore?: boolean; session?: string }): Promise<ActionReceipt>

interface ActionReceipt { ok: boolean; action: string; target: string; detail: string }
```

| 规则 | 说明 |
| --- | --- |
| 目标 | `target` = 会话 id（`ses_…`）/ 交接单（`b_…`）/ thread（`t_…`，仅 escalate）/ 绝对路径（`scope:"workspace"`）。`scope` 省略时按 target 推断：`b_…` → `bid`、`/…` → `workspace`、其余 → `session` |
| 发起方 | `session` = 调用方会话（面板传当前路由会话），只用于**审计 actor**；拿不到记 `actor:"gui"`。RPC handler 本身拿不到 sessionID（宿主只在工具里给），所以由 GUI 显式带入。**加急必须有真实 `session`**：缺失时直接 `ok:false`（否则 prompt 的 `fromSessionID="gui"`，对方无处回执）；`freeze` / `unfreeze` / `archive` 不受影响（仍记 `gui`） |
| 确认 | GUI 先弹 `ctx.dialogs`（confirm / prompt），确认后才调 RPC；服务端因此**总是执行**（`confirm:true`），不存在「GUI 漏确认但服务端也拒绝」的第二套语义 |
| 复用 | 四个方法调用 `src/core/actions.ts` 的 `escalateAction` / `freezeAction` / `archiveAction`——工具（`collab_escalate` / `collab_freeze` / `collab_archive`）调用的**同一批函数**，没有第二份规则 |
| 失败 | 可读拒绝（protected / 冻结 / 校验 / 宿主拒绝写入）返回 `ok:false` + `detail`（不抛）；只有传输层失败才让 RPC reject。面板对两种都只弹 toast，不崩（R6） |

#### 门禁（服务端强制，GUI 不可绕过）

| 动作 | 门禁 |
| --- | --- |
| `escalate` | **protected（含血缘）→ 拒绝**：`ok:false`、**0 条 prompt、0 个队列项**（看板点击不是 `collab_request_owner` 的请求，不代写队列）。**工具路径不变**：`collab_escalate` 对 protected 仍写 1 条 `priority:"urgent"` 队列项 + 0 prompt（0.6.0 语义）；两条入口由 `escalateAction({ protected:"queue"\|"refuse" })` 区分，名单 / 血缘 / 拒绝文本只有一份。只读 agent（`explore` / `plan`）→ 强制 `queue`（回执 `forced`）。目标被冻结（会话 / 工作区 / 该 bid）→ **拒绝**，先解冻。5 分钟同 `bid` + 同 `reason` 仍只刷新 `urgentAt` |
| `freeze` / `unfreeze` | 复用 `freezeAction`：写 `~/.config/opencode/collab-freeze.json`（读-合并-写）；受保护目标**0 prompt**（改为一条 urgent owner-queue 项）；`unfreeze` = `freeze:false`（幂等 no-op） |
| `archive` | 复用 `archiveAction`：`archived:true`（`archive ≠ delete`），`restore:true` 恢复；**`[protected*]` 拒绝**且不 PATCH；只写交接记录的 `archivedAt` |
| 只读回归 | `snapshot` 仍然零写入（不写审计、不投递、不改任何文件），这条由 S108 用 mtime + 计数断言 |

#### 审计（R5）

每次写动作向 `~/.config/opencode/collab-audit.jsonl` **追加一行**（`COLLAB_AUDIT_FILE` 可覆盖路径）：

```json
{"at":1795094250174,"actor":"ses_…","action":"freeze","target":"ses_…","ok":true,"reason":"S108 冻结中"}
{"at":1795094250179,"actor":"ses_…","action":"escalate","target":"ses_1eb…","ok":false,"reason":"拒绝加急：目标…在 protect 名单内…"}
```

- 成功与失败都写；**只追加、不轮转、不删除**。成功记调用方自己的 `reason`，失败记回执 `detail`。
- 只由 RPC 入口写（GUI 动作）；工具保持自己的回执文本，不额外写这一行。
- 写失败只打一条日志，不影响已经发生的动作（R6）。

#### GUI

- 右详情动作行四个按钮：`加急` / `冻结` / `解冻` / `归档`（`data-collab-action="…"`）；
  加急弹 `dialogs.prompt`（理由，默认一行）→ `dialogs.confirm`；其余三个直接 `dialogs.confirm`（归档 `danger`）。
- 确认 → RPC → **toast**（成功 `success` / 失败 `error`，描述用服务端 `detail`）；成功后 `store.load()`
  **刷新一次**（不新增轮询，不复制 2 s 定时器）。
- **已知限制**：窗口没有 `ctx.dialogs`（老宿主 / 测试宿主）时降级为**两步点击**——第一次点只「上膛」
  （按钮变 `再点一次：加急`，toast 说明「此前未写入」），第二次点同一按钮才执行；加急用固定一行理由。
  **上膛按 `(动作, 会话)` 记录**（`armed = { id, sid }`），且 `run()` 在任何 await 之前就捕获目标 sid：
  在 A 上上膛后切到 B，按钮显示未上膛、单击**不会**执行，必须在 B 上重新上膛并确认。
  这样既不违反 R4（不确认不写），也不假装有对话框，更不会把一次点击落到别的会话上。
- `collab.json` 的 `boardActions:false` 只**隐藏动作行**（`snapshot.actions === false`）：RPC 仍然可调，
  面板仍然是只读视图（回滚开关，设计 §5）。尾部文案相应改为「视图只读 · 动作需确认」。

#### 测试

- `test/handoff-harness.mjs` S108（16 条）：注册与 `snapshot.actions`、protected 拒绝且 0 prompt / 0 队列、
  只读 agent 降级、冻结中加急被拒、解冻、归档/恢复、protected 归档拒绝、审计 8 行逐条字段、失败行 ok:false、
  `boardActions:false` 仍可调用、snapshot 零写入。
- `test/gui-panel.mjs` PN12（18 条）：四个按钮、加急 prompt→confirm→RPC、成功 toast + 一次刷新、
  取消（两处）0 写入、拒绝 toast 且面板仍可用、RPC 抛错只 toast、无 dialogs 两步点击、`actions:false` 隐藏。
- 变异必做：删掉 protected 拒绝分支 → S108 的 0 prompt / 0 队列断言失败；审计只写成功路径 →
  「失败也有一行」断言失败。

**回滚**：`collab.json` 设 `boardActions:false`（只隐藏动作行，RPC 保留）；
彻底回退 `git restore -- src/rpc.ts src/index.ts src/core/actions.ts src/tools/{escalate,freeze,archive}.ts src/gui.tsx`。

### 11.21 存储与索引（`collab-messages.jsonl` + `collab.db`，0.9.0）

**为什么**：插件过去不存正文（inbox 只有未读、thread 索引只有 80 字 preview、广播只有状态），复盘只能去
`opencode api` 分页拉消息。0.9.0 只做**存储**，不改任何协作语义（R7）：每条投递成功写一行信封，
再维护一份**可删可重建**的 SQLite 投影。

#### 真源与投影

| 文件 | 角色 | 说明 |
| --- | --- | --- |
| `~/.config/opencode/collab-messages.jsonl` | **唯一真源** | append-only，一行一个 `Envelope`；`body` 是**全文**；单行 ≤1MB（超出按 1MB 分片，同 `id` + `part` 连续写，读时合并）；每行带 `sha256`；256MB 轮转为 `…-1.jsonl` / `-2` …（读时按序拼接） |
| `~/.config/opencode/collab.db` | **可重建投影** | 12 张表 + `messages_fts`（FTS5，外部内容表）；`WAL` + `busy_timeout=5000`；`messages.body` 存全文，**FTS 只索引前 8192 字符（CJK ≈ 24KB）**；typed 列 + `*_json` 原始对象（`handoffs.record_json` / `locks.record_json` / `queue.item_json`）供读路径逐字段还原；删掉它不影响任何协作 |
| `collab-broadcast/*.json` / `collab-threads.json` | 现状不变 | `rebuild` / `backfill` 的输入之一；`backfill` 只补状态级历史（24 单 / 49 thread 的参考量级） |

信封字段（父 design §3）：`v/id/threadId?/from/to/sentAt/kind/body/basedOn/grade/factIds?/deltaOnly?/sha256?/part?`。
`from` / `to` 是**会话 id**（`from` 只在拿不到 id 时用显示别名）；`id` 由投递的 `cid` 派生（`msg_<cid>`），
所以同一次投递的唤醒 / 重发不会在历史里长出新行。

#### 写入顺序（不可颠倒）

```
投递成功（宿主已 admitted）
  ├─ appendMessage(jsonl)   // 真源，先写
  ├─ indexInsert(row)       // 投影，失败只记日志 + 熔断
  └─ 返回工具结果（逐字不变）
```

- **索引失败不得阻断投递**：投影坏了看板陈旧是可接受的，消息丢了不可接受。
- 历史是**旁路**：`recordMessage` 从不抛错、从不改工具返回（R7）。极端情况下写盘失败只留一条日志。
- 预览 / 被护栏拒绝 / 去重命中 → **0 行**（只有真的 admitted 才写）。

#### `collab_index`

```bash
collab_index { action:"stats" }                              # 只读
collab_index { action:"rebuild", confirm:true }              # 全量重建（幂等）
collab_index { action:"rebuild", sinceDays:30, confirm:true }# 只保留最近 30 天
collab_index { action:"backfill", confirm:true }             # 回填历史状态（不伪造正文）
```

| 规则 | 说明 |
| --- | --- |
| 幂等 | 同一输入两次 rebuild：行数 + 每表 checksum 完全相同（`meta` 的 `rebuilt_at` / `rebuilt_ms` 等易变键不计入） |
| 原子 | 建在 `<dbPath>.tmp` → `PRAGMA wal_checkpoint(TRUNCATE)` → 关闭 → `fsync` → rename；**失败保留旧库**并返回可读错误 |
| 坏行 | jsonl 里一行非法 JSON / 半行 / 哈希不符 → 跳过并计入 `warnCount`，rebuild 仍然成功 |
| 回填 | 只写 `handoffs` / `threads`；正文历史上没存过 → **不写 messages 行**，`meta.backfilled=1` 标记「历史不完整」 |
| 降级 | `storage:"json"` 不 import sqlite；库损坏 / 驱动异常 → 进程级熔断，后续调用直接走 JSON；看板显示 `[索引不可用]` |
| 并发 | 写入单进程串行（Promise 队列）+ 跨进程 WAL / `busy_timeout` / 3 次指数退避（50/200/800ms）；`rebuild` 持 `<dbPath>.lock`（60s 判陈旧），写方短暂等待；**rename 后按 inode 重开**，否则会写进被 unlink 的旧文件 |
| 消息覆盖 | 除 `send`/`reply`/接管请求外，`collab_escalate` / `collab_freeze` 通知（notify）· `notifyRequester`（note）· `[ack]`（ack，同 cid 只写一次）· 受限重发（request，`_r<n>`，带 `resend_of`，指标可排除）· 缺陷上报（note）都各写一行 |

#### 读路径（0.9.0 review 后）

- `snapshot` 的 locks / handoffs / queue、`collab_status`、`collab_threads` 都**先问投影**：
  `preferredLocks()` / `preferredBroadcasts()` / `preferredHandoff(bid)` / `preferredQueue(from)`。
- **新鲜度门槛（按源）**：`meta.full_sync_at` 存在（做过一次完整 sync），且**该源自己的水位**
  `synced_broadcasts / synced_locks / synced_queue / synced_threads ≥ 该源文件 mtime`。
  另一个进程写 locks 只会让 locks 读者回落，不会因为本进程镜像了一条 handoff 就把陈旧 lease 当新鲜供出。
- **写穿（异步）**：`writeBroadcast` / `writeLock` / owner-queue 写只把变更排进一个 0ms 合并队列，
  由 `flushMirrors()` 在写路径之外应用（不会让写等 `busy_timeout`）；句柄不在（另一进程拥有/降级中）
  就只留 mtime 变化，让读路径回落。
- **只读不建库**：`preferred*` 在 `collab.db` 不存在时直接返回 `undefined`；mirror 在库还没有 schema 时
  **静默跳过**，不会每次写刷一条错误日志。
- **等价性**：投影保存原始对象，索引读出的 locks / handoffs / queue 与 JSON 路径**逐字段相同**；
  `test/store-rebuild.mjs` 对此做深度相等断言，并用「reader 丢掉 `priority`」的变异证明断言会红。
- **边界**：`sessions` 表只供查询/后续指标，**不参与看板**（宿主的实时 `session.list` 更准）；
  `index: { available, reason? }` 仍是 additive 标记，`available:false` 时 GUI / TUI 显示 `[索引不可用]`，
  **不隐藏任何行**。

#### 验收

`test/store-rebuild.mjs`（30 项）：工具面 22 → 23 · `storage:"json"` 不 import · 1.5MB 分片 + 引号/CJK/换行三种
**编码后** 1MB 边界 · 重建幂等（行数 + checksum + `sent_at` 值）· 坏行容错 · 新装 `stats.available=true` ·
坏库降级 · 熔断只触发一次 · 读路径命中 / 等价 / 陈旧回落 · 单 rebuild 锁 · 子进程连续写 + 6 次并发 rebuild 零丢失 ·
回填 24 / 49（宿主实测 50）且不伪造 messages；真源写失败时跳过索引（S2）；
只跑 rebuild 读者命中（P1-1）· 冷启动只读不建库 / 0 条 mirror 日志（P1-2）· 按源水位（P1-3）· frozen 不被清零（S9）。
`test/delivery-history.mjs`（9 项）：六个补充投递点各 1 行、kind 正确、ack 同 cid 不重复；
重发行 `resend_of` 可用于排除指标（S10）。

回滚：`rm -f ~/.config/opencode/collab.db* ~/.config/opencode/collab-messages*.jsonl`，或把
`collab.json` 的 `storage` 设为 `"json"`（不删任何文件，纯 JSON 运行）。

### 11.22 会话契约与四段注入（0.9.1；0.9.2 移除 `[scope]`）

**为什么**：主线、边界、进度、待办过去只存在于对话里。会话 323 轮、人类只说 6 句时，
主线 13:00 → 00:52 **10.8h 零推进、零提醒**；而旧注入是**一次性**的（展示后进 `injected[]` 注销），
compaction 或消息一多就什么都不剩。0.9.1 把任务层落成一份**契约文件**，并让模型**每轮**都看得到。

#### 存储

`~/.config/opencode/collab-contract/<sid>.json`（`COLLAB_CONTRACT_DIR` 可覆盖，测试/沙箱用）：

```jsonc
{
  "v": 1, "sid": "ses_…", "updatedAt": 0,
  "mission": { "taskPath": ".trellis/tasks/…", "oneLine": "…",
               "inScope": [], "outOfScope": [], "handoffTo": {},
               "state": "active|idle|suspended|done",
               "parkedAt": null,
               "confirmedBy": null, "confirmedAt": null },
  "plan": { "milestones": [{ "id": "M1", "title": "…", "done": false,
                             "evidence": null, "at": null }],
            "lastAdvancedAt": 0 },
  "todos": [{ "id": "T1", "kind": "mainline|collab", "subject": "…",
              "status": "open|doing|blocked|suspended|drifted|closed|dropped",
              "blockingOn": "me|<sid>", "parkedBy": null, "parkedAt": null,
              "wakeWhen": null,               // 0.9.3：{kind,ref|at} 或 0.9.1 的自由文本
              "since": 0, "closedAt": null, "evidence": null }],
  "peers": [],
  "turn": { "count": 0, "lastAt": 0, "lastAdvancedAt": 0,
            "noAdvanceTurns": 0, "driftAt": 0 }
}
```

- 写路径 **tmp + rename**（写前归一化，工具拿到的是读者可见的同一份）；读路径**惰性创建**——只读永远不落盘，
  第一次 `set/confirm/add/light/close/...` 才建文件；
- **todo 保留策略**：读侧保留**全部 active**（open/doing/blocked/suspended），只把 closed/dropped 历史裁到最近
  `CONTRACT_TODO_KEEP_CLOSED=50`；`todoSeq` 记住「曾发行过的最大 id」，历史被裁也不会复用 id。
  绝不能按总数 `slice()`——那会让刚 add 的行对所有读者不可见并在下一次写入被覆盖；
- 文件可手工编辑：读时逐字段归一化（未知字段丢弃、长度截断、枚举回落），坏文件不会让一次请求失败；
- `collab_mission confirm` **必填 `by`**（如 `"human"`）；不接受缺省成当前会话 id——确认必须能追溯到人。
- `mission.confirmedBy` 一旦写入，`set` 必须 `reconfirm:true` **且** `by` 非空——**自动推断永不覆盖人工确认**（D7）。

#### 主线锚（`collab_mission get`）

1. `<workspace>/.trellis/.runtime/sessions/<platform>_<sid>.json` 的 `current_task`（或 `task_path`，两种都收）；
2. 该工作区 **恰好一个** `.trellis/tasks/<slug>/task.json` 且 `status:"in_progress"`；
3. 都没有 → 空，注入显示 `[mission] … [未确认]`，提示 `collab_mission set`。

不做标题猜测、不调用 `task.py`（每轮请求都跑 python 太重；指针文件是同一信息且已在磁盘上）。
多个 `in_progress` → 明确报「多个候选，不猜」，要求手工指定。

#### 进度只认证据（D20/D21）

`collab_progress { action:"light", milestone:"M3", evidence:"commit:<sha>", confirm:true }`

| 形式 | 校验 |
| --- | --- |
| `commit:<sha>` | `git cat-file -e <sha>^{commit}` 成功，且 `git merge-base --is-ancestor <sha> HEAD`（未合入不算） |
| `file:<path>:<line>` | 文件存在且行数 ≥ `line`（`line` 可省 = 仅存在性） |
| `test:<path>` | 测试报告 / 输出文件存在 |
| `decision:<id>` | 某个 hand-off 记录的 `decisions[]` 里有该 id（`collab_decisions` 写入即为已决策；独立决策账本在 0.9.5，上线时必须与本处合并为**单一 resolver**，hand-off 只作兼容输入） |

- 无 evidence → **拒绝**；校验失败 → 拒绝并返回原因；不写入任何字段。
- 点亮后 `plan.lastAdvancedAt = now`、`turn.noAdvanceTurns = 0`；同一 evidence 重复点亮**不重复推进**时间。
- `close` 一个 todo 同样必填 evidence；四类可校验形式会先校验，自由文本只记录、不推进里程碑。
- `suspend` 必填 `wakeWhen`（没有唤醒条件的挂起 = 工作永久消失）。

#### 四段注入（每轮重算，不注销）

固定顺序累加，**硬上限 12 行**，放不下的段落**整段丢弃**（不出现半截）：

```
[mission]  ≤3 行    一句话主线 · 任务路径 · [未确认] / 边界 · 状态 · 推进于 N 前 / 确认命令
[todo]     ≤4 行    N open · M 需要你 · K 等对方 · 最老 T2 6.2h · 还有 7 条；随后 top3
[drift]    ≤2 行    仅触发时出现（连续 5 轮无主线动作 / 主线挂起 > 2h / 挂起 24h 未醒 / [未处置]）
[progress] ≤2 行    done/total · 下一里程碑需要 evidence；或「未设置里程碑」
```

> 0.9.2 删掉了 `[scope]` 小节（连同它背后的关键词/别名匹配）：插件不再从消息文本猜「这条算不算越界」，
> 边界只在 `[mission]` 里作为声明展示；接单时的判断由会话自己在 `collab_accept` 的 `scopeCheck` 里作出。

- **每轮重新计算、绝不写 `injected[]`**：这是与 0.5.x 一次性注入的关键差别，也是本版最重要的回归用例
  （「连续两轮，第二轮仍含 `[mission]` 与 `[todo]`」）。
- `[todo]` 只列 **top3**（`blockingOn=me` 优先，其次最老 `since`），头部给总数与「还有 N 条」；
- `[未收尾]`：插件**没有 idle 钩子**，改为**下一轮回溯**——上一轮结束时 `status:"doing"`、且在本轮开始前未被更新
  （`updatedAt ≤ 本轮 startedAt`；请求中途新建的 doing 会在下一轮被标）的 todo 标 `[未收尾]`。
  语义等价于「上一轮没收尾」，不承诺 idle 写入；
- `turn.count` / `lastAt` / `startedAt`：**契约文件存在就每轮推进**（只有 mission 或只有里程碑也一样），
  `noAdvanceTurns` 单独按「上一轮是否有已验证推进」维护；0.9.3 起**首个请求也计入**（否则漂移会晚一轮触发），
  阈值 5 与 `[drift]` 见 §11.24；
- 没有契约的会话不会被 hook 建文件（惰性创建）；
- 该块排在注入最前（主线/待办是整体框架），失败独立兜底，不影响未读消息 / 交接 / 感知行。

#### 配置与回滚

- 目录固定为 `~/.config/opencode/collab-contract`，`COLLAB_CONTRACT_DIR` 覆盖（测试/沙箱）；
- 回滚：`rm -rf ~/.config/opencode/collab-contract`，并 `git restore -- src/hooks/context.ts src/tools/index.ts`、
  删除 `src/core/contract.ts` / `mission-resolve.ts` / `evidence.ts` / `src/tools/{mission,progress,todo}.ts`。

#### 验收

`test/contract-inject.mjs`（0.9.2 复审后 83 项）：工具面 23 → 26 · 连续两轮注入（变异「写回 `injected[]`」→ 第二轮必红）·
无 evidence / 假 commit 拒绝 · 真 commit 点亮并推进时间 · 同 evidence 不重复推进 · confirm 后 set 拒绝 / reconfirm+by 通过 ·
无任务仍显示 `[mission] … [未确认]` · 10 条 todo 只列 3 条 + 「还有 7 条」且整块 ≤12 行 ·
suspend 缺 `wakeWhen` 拒绝 · close 缺 evidence / 文件不存在拒绝 · 四段齐全且**没有 `[scope]` 行**（0.9.2 删除匹配器）·
`[未收尾]` 下一轮标记 · 主线锚（指针 > 唯一任务 > 多任务不猜；无契约时 ambiguous 静默）· `get` 用会话首条人类指令作建议且不写盘 ·
并发 `add` 不产生重复 id · mission-only / milestone-only 契约的 `turn.count` 正常递增 · `confirm` 缺 `by` 拒绝 ·
50 closed + 10 open 时新行可读（变异：读侧截断加回 → 必红）· 只裁关闭历史且 id 不复用 · 同毫秒 advance 归零 `noAdvanceTurns`。


### 11.23 协作闸门：接单前模型表态（0.9.2）

**为什么**：排钟专题在一次 13:00 → 00:52 的会话里把主要精力投进了 ws 集群（「排钟」关键词 14:00 后归零），
22 个工具**没有任何一个会拒绝越界动作**，最后要人类用 766 字手工拉回主线。

**为什么不做关键词匹配**：初版把 `mission.outOfScope` 与 bid 文案做子串/别名匹配，复核当场误伤
`排钟 Redis 缓存键设计`（`redis` 既是 ws 集群别名，也是排钟缓存键的词）。通用插件无法靠文本判断
「这条算不算那个边界」，把领域词写进插件更不行。**结论：插件不判断，只逼表态并记录。**

**诚实边界**：插件拦不住 `bash` 层跨仓写，只能拦**协作动作**里的**接单**。实测漂移 90% 经协作层进入。

#### 接单表态（唯一需要表态的动作）

本会话 `mission.outOfScope` **非空**时，`collab_accept` 必须带：

```text
collab_accept { bid:"b_…", confirm:true,
                scopeCheck:{ inScope:true  |  false, reason:"…" } }
```

| 情况 | 结果 |
| --- | --- |
| 缺 `scopeCheck`（或 `inScope` 不是布尔） | **拒绝**：说明「插件不做语义判断」，给出两种可复制调用 + override 形式 |
| `inScope:true` | 正常接单；写 audit（`verifiedBy:"model"`） |
| `inScope:false` | **拒绝接单**：给 `handoffTo`（`mission.handoffTo`）+ override 用法；写 audit（`inScope:false`） |
| `inScope:false` + 合法 `override` | 放行；写 audit（`verifiedBy:"override"`，含 `approvedBy`） |
| 契约缺失 / `outOfScope` 为空 | **不需要表态**，行为与 0.9.1 逐字节一致（不写 audit） |

- `override:{ reason, approvedBy }` 两者必填，`approvedBy` 不得以 `ses_` 开头（会话不能给自己批越界）；
  单独给 `override` 而没有 `scopeCheck` 仍算**未表态**；
- `handoffTo` 不再按「命中项」查表（没有命中项）：`mission.handoffTo` 只有一个不同目标 → 直接给；
  多个 → 文案里全列出（避免暗示某一个是「对的」）；没有 → 「请转交 owner」；
- **顺序**（复核 #3/#4）：`refresh → evaluate → persistRefresh → 只读分支`。拒绝时记录**零变化**
  （`state`/`claim`/`asked`/`attempts` 与 `<bid>.lock` 全不变），「已被领取」「spawn 自领 ACK」「已闭环 / 已过期」
  都不经过闸门，不会被误报成越界。

#### 派活不拦、回复不校验

- `collab_broadcast` / `collab_handoff`：**永不要求表态、永不拒绝**——派活是清账手段；
- `collab_reply` / `collab_send`：不校验（回复不扩大边界）。

#### 溢出只提醒（R5）

`open todos ≥ 8`（`open / doing / blocked / suspended`）时，在 `accept` / `broadcast` / `handoff` 的返回
**末尾**追加一行，不拒绝、不改状态、不写 audit：

```text
[溢出提醒] 你已有 8 条协作待办；若这次接单/派活会把它们挂起，先处理再继续。
```

#### 审计

每次**表态**写一行 `~/.config/opencode/collab-audit.jsonl`（append-only，与看板动作审计共用文件）：

```json
{"at":0,"sid":"ses_…","kind":"accept","bid":"b_…","inScope":true,"reason":"排钟主线内","verifiedBy":"model"}
{"at":0,"sid":"ses_…","kind":"accept","bid":"b_…","inScope":false,"reason":"…","verifiedBy":"override","approvedBy":"@长久同学^v^"}
```

未表态的拒绝、溢出提醒、`gate:"off"`、预览：不写（没有判断可记）。写失败只记日志，不阻断动作；
`COLLAB_AUDIT_FILE` 可覆盖（测试/沙箱）。

#### 开关与回滚

```json
// ~/.config/opencode/collab.json
{ "gate": "enforce" }
```

- `enforce`（默认）：按上表执行；`warn`：拒绝降为提示（已作出的表态照常写 audit）；
  `off`：完全跳过（不要求表态、不拒绝、不提醒、不写 audit）。写错的值回落 `enforce`；
- 改完即时生效（配置按 mtime 重读），无需重载插件；
- 代码回滚：`git restore -- src/tools/accept.ts src/tools/broadcast.ts src/tools/handoff.ts src/config.ts src/types.ts
  src/constants.ts src/core/contract.ts src/hooks/context.ts src/index.ts`、`rm -f src/core/gate.ts src/core/audit.ts`。

#### 验收

`test/gate.mjs`（62 项）：工具面仍 26 · 缺表态拒绝（含两种可复制调用；记录逐字节不变、无 lock、不写 audit）·
`inScope:false` 拒绝 + `handoffTo` + audit（model）· 合法 override 放行 + audit（override/approvedBy）·
`approvedBy:"ses_…"` 拒绝 · `inScope:true` 接单 + audit（model）· 无 `outOfScope` 不需要表态且无 audit ·
`open=8` 时 accept / broadcast / handoff 全放行 + 提醒行 · 「已被领取」/ spawn 自领不被闸门改写 ·
`reply`/`send` 永不校验 · `gate:"warn"` 只提示 · `gate:"off"` 全跳过 · protected 行为不变。
变异（强制）：「缺 `scopeCheck` 拒绝」改成放行 → 该组 8 项红（实测）。


### 11.24 漂移与挂起（0.9.3）

**为什么**：排钟会话 13:00 主线完结后没有下一项占位，空槽被 ws 集群填满，**10.8h 无人提醒**；
一批「等 owner 批复」从未落成挂起项；「我这条之后不再回执」出现过 3 次，下一条照旧——
「停」靠自声明不成立，必须由契约落账并**反复追问**。

#### 触发（只有这四条，不放宽）

```
[drift] = turn.noAdvanceTurns >= 5                 // 连续 5 轮无 mainline evidence（当前请求已计入）
        OR mission.state='suspended' && 挂起 > 2h  // 主线 park 太久
        OR 存在 suspended/drifted todo 的 wakeWhen 到期   // kind='time' 到点，其余（含 manual）24h 兜底
        OR turn.driftAt > 0                        // 上次 [drift] 未处置（下一轮加 [未处置]）
```

- **mainline evidence** = `collab_progress light` 点亮 / 关闭一个 `kind:"mainline"` 的 todo（提交证据走 `light` 的
  `commit:<sha>`）；两者都会把 `turn.noAdvanceTurns` 归零并推进 `lastAdvancedAt`；
- `turn.noAdvanceTurns` 由 hook 在**请求开始**时 stamp：首个请求 / 上一轮刚推进过 → **1**，否则 `prev+1`；
  `evaluate` 直接读这个值（不再 `+1`）。于是「从未推进」与「推进过一次后再静默」两条路径都是：
  第 4 轮安静、**第 5 轮**出现 `[drift]`（`test/drift.mjs` 用例 1 / 17）；
- 每轮最多 2 行，只在触发时出现；`[未处置]` 表示上一轮的提醒没被三选一回答。

```
[drift] 连续 5 轮无主线动作（3.2h）→ 三选一：resume / block / done
[drift] T4 已挂起 1.0d 未醒（等 ses_e176 回复）→ 重新评估（resume / block / done） [未处置]
```

#### 三选一（必须落账）

| 动作 | 写什么 | 校验 |
| --- | --- | --- |
| `collab_mission { action:"resume", next:"<下一步>" }` | `state=active`、`noAdvanceTurns=0`、`driftAt=0`，建/更新一条 mainline `doing` 待办 | `next` 非空 |
| `collab_mission { action:"block", on:"<me\|ses_…>", reason:"…" }` | `state=suspended`、`parkedAt=now`、一条 `suspended` mainline 待办（`wakeWhen:{kind:"manual"}`） | `on` / `reason` 非空；重复 block 复用同一行 |
| `collab_mission { action:"done" }` | `state=done`、`driftAt=0` | **必须已存在 `kind:"mainline"` 且 `status:"open"` 的 next-up 占位**，否则拒绝 |

未处置：下一轮 `[drift]` 继续出现并加 `[未处置]`（`turn.driftAt` 只在三个动作里清零）。
`set { state:"done" }` 走同一条 next-up 校验，绕不过去。

> 已知行为（不加守护）：`done` **只在迁移时**校验 next-up 是否存在；之后那个占位被关闭不会回滚
> `mission.state`（PRD 只要求迁移校验）。这时下一次 `[drift]` 会重新问，处置仍是 resume / block / done 三选一。

#### 挂起的唤醒条件（`wakeWhen`，R3/R4）

```ts
{ kind: "reply",    ref: "ses_…" }   // 等某会话回复
{ kind: "decision", ref: "D3"    }   // 等某决策 answered
{ kind: "time",     at: <epoch ms> } // 到期时间，必须 > now
{ kind: "manual"                  } // 没有自动触发源（仍受 24h 兜底）
```

- `collab_todo suspend` / `collab_mission block` 都要求它；缺 `wakeWhen` 直接拒绝（没有唤醒条件的挂起 = 永久消失）；
- 0.9.1 写的**自由文本仍然有效**（按 `manual` 处理，注入显示 `suspended(等 <原文>)`），不会被静默改写；
- 到期判定**在每次注入时扫描**（不依赖定时器）：`kind:"time"` 到点即到期；其余类型超过 **24h** 兜底到期；
- **`manual` 只是「不因 reply/decision/time 自动醒」，仍受 24h 兜底**：`manual` 的挂起 24h 后同样转 `drifted` 并进
  `[drift]`——它表示「没有可自动观察的触发源」，不是「永久免打扰」；
- `resume` 会**收尾**同一契约里所有 mainline `suspended`/`drifted` 行（转 `closed`、`evidence:"resume"`），
  否则 `block → resume` 会留下一条僵尸挂起行、24h 后每轮重新把 `[drift]` 顶出来（0.9.3 复核 B）；
- 到期 → todo `status:"drifted"`（进 `[todo]` 显示 `挂起到期`，进 `[drift]` 原因）——**绝不自动关闭**，
  必须由人/模型决定 `resume` / 重新 `suspend` / `close`；
- 记录一个**未来** `at` 时，24h 兜底让位给这个明确截止时间（截止未到不判漂移）。

#### 配置 / 常量与回滚

```ts
DRIFT_NO_ADVANCE_TURNS = 5      // 连续无 evidence 轮数
DRIFT_PARKED_MS  = 2h           // 主线挂起多久算漂移
SUSPEND_FALLBACK_MS = 24h       // 非 time 型 wakeWhen 的兜底
```

无新增工具（仍 26），无新配置文件；状态写在既有的 `collab-contract/<sid>.json`（`mission.parkedAt` /
`turn.driftAt` / todo `status:"drifted"`）。回滚：
`git restore -- src/core/contract.ts src/hooks/context.ts src/tools/mission.ts src/tools/todo.ts`、
`rm -f src/core/drift.ts src/core/wake.ts`、`node test/drift.mjs` 从 `pnpm test` 移除。

#### 验收

`test/drift.mjs`（68 项）：4 轮安静 / **第 5 轮**出现 `[drift]` / 第 6 轮带 `[未处置]` · 推进一次后再静默 5 轮仍是第 5 轮触发（不再晚一轮）·
`resume`（缺 `next` 拒绝）·
`block`（缺 `on`/`reason` 拒绝、重复 block 复用行）· `done` 无 next-up 拒绝 / 有则通过（`doing` 不算 next-up、`set` 同校验）·
`suspend` 缺 `wakeWhen` / `time` 已过期拒绝 · `time` 未来的对象写入与渲染 · 主线挂起 2.1h 触发 ·
24h 未醒 → `drifted` 且不关闭、下一轮 `[未处置]` · 未来截止不被 24h 兜底误伤 · legacy 字符串 wakeWhen ·
`close` mainline / `light` 归零计数 · `block → 25h → [drift] → resume` 后下一轮无 `[drift]` · 截断分支（段落整段丢弃，被丢的是 `[progress]`）· 工具数 26。
变异（强制）：`DRIFT_NO_ADVANCE_TURNS` 5 → 0 → 「1–4 轮不出现 `[drift]`」必红（实测，退出码 1）。

### 11.25 事实账本、证据等级与三态（0.9.4）

**为什么**：624 条消息里 **117 条（19%）**后来被撤回或更正——环境干扰 39、工具误用 33（`rg -rn` 把匹配替换成
`n`，于是得出「签名头改名」的假结论）、探针假象 26、口径不同 25。撤回没有传播：00:45 owner 裁定「不做前缀隔离」，
对方在途工作到 **00:59** 才停（14 分钟、67 条消息 / 85 KB 都在同步一个已作废的事实）。275 条消息带「你读的是
旧快照 / 落后」，接收方却无法判断哪条结论仍然有效。

0.9.4 把「事实」做成**可寻址的一等值**（`F1` / `F2` …）：可登记、可引用、可撤回、可作废；消息写明它据以成立的
事实与基线，于是撤回能沿引用传播，而不是再发一条「上面那条不算」。

#### 存储（工作区级，D4/D6）

```jsonc
// ~/.config/opencode/collab-facts.json   （COLLAB_FACTS_FILE 可覆盖；测试/沙箱用）
{ "v": 1, "workspaces": { "/data/project/muke-interface": {
    "epoch": 7, "seq": 9,
    "facts": [{ "id": "F3", "claim": "serverId 恒非空", "grade": "measured",
                "evidence": "repo/era RedisClient.php:601", "state": "active",
                "basedOn": { "repo": { "/data/project/muke-interface": "20e35a51" },
                             "env": { ".env": "a1b2c3d4" }, "facts": 5,
                             "factIds": ["F2"] },
                "by": "ses_…", "at": 0, "supersededBy": null, "scope": "workspace" }],
    "metrics": { "2026-11-20": { "settled": 4, "retracted": 1,
                                 "staleDeliveries": 2,
                                 "reasons": { "口径错误": 1 } } } } }
```

- **一个文件、每个工作区一本账**：事实对某个工作区成立，对会话/整机不成立（D4）。设计文档里的扁平形状
  `{ v, epoch, workspace, facts }` 仍然是合法输入（读时迁进容器，写时落新形状）。
- `epoch` **只在 `invalidate` 成功后 +1**（设计 §3）：它是「这条事实settle 时所处的世界版本」，不是写入计数器。
  事实的 `basedOn.facts` 记录这个版本号；消息的 `basedOn.facts` 同样。
- `seq` 是「发放过的最大 `F<n>`」，裁剪历史后 id 也**不会复用**。上限 **2000** 行：超出先淘汰最旧的
  non-active，再淘汰最旧的 active。
- 写：**`<file>.lock` 跨进程互斥 + `tmp + rename` 原子替换**；读：坏文件/坏行只丢该行，不抛错
  （`error-handling` 的降级口径）。

#### 跨进程并发写（0.9.4 复核必改）

`collab-facts.json` 是**全机一个文件**，每次写入都是整文件读改写。只按 workspace 串行（进程内队列）不够：
两个 OpenCode 进程（不同工作区，本机常态）会各自读到同一份快照，后写的把对方**整个 workspace 条目**抹掉，
而且两边都 exit 0、无任何报错（复核实测 3 轮丢 21–26 条 / 50）。

修法（`src/core/file-lock.ts`，`collab-glossary.json` 同型）：

| 项 | 规则 |
| --- | --- |
| 锁文件 | `<file>.lock`，`open(…, 'wx')` 原子创建；内容 `{ pid, at, token }` |
| 互斥范围 | 覆盖**整个** read-modify-write（不是只包 `rename`） |
| 陈旧回收 | `at` 超过 **60s**（`FILE_LOCK_STALE_MS`）或 `pid` 已不存在（`kill(pid,0)` → ESRCH）即回收；刚 `open` 还没写内容的锁**不算陈旧**（按年龄判定，不按可解析性） |
| 重试 | **`1 + delays.length` 次**（4 次；与 `withRetry` 同一约定，**三个延迟 `50 / 200 / 800ms` 都会被消费**） |
| 等待（复核追加） | 4 次尝试后**事件驱动等待**：`fs.watch` 目录，持锁方一 `unlink` 就立刻再抢；25ms 兜底轮询，上限 **30s**。只「再采样一次」在 3 进程连续写时必然饿死（实测 4–6 次拒绝 / 9）；等待超限才是**可读拒绝**（`ValidationError`，不报缺陷）：未写入任何内容，稍后重试 |
| 释放 | 只在**内容可解析且 token 仍是自己**时删除；读不到内容（`open` → `write` 窗口 / 撕裂写）或 token 不匹配 → **不删**，交回 60s 陈旧回收兜底——绝不误删接管者的锁 |
| 临界区 | 只包含读账本 / 校验 / 写账本；**基线快照（`git` + `.env`）在锁外算**（`git` spawn 10–30ms，放在锁内会把 25 次突发拉成数秒并饿死别人）。`gitHead` 按目录缓存 **5s**（基线是「我当时看的 HEAD」，不是每次调用的 oracle） |
| 原子性 | `tmp + rename` 保持不变：锁是**互斥**，rename 是**原子性**，两者不能互相替代 |

> 进程内队列（按 workspace / pair）保留：它省掉同进程内的锁竞争，但**不是**安全边界。
> `noteStaleDeliveries`（注入侧计数）走同一把锁；计数失败只记日志，不影响请求。

#### `collab_fact`（26 → 27 个工具）

| action | 语义 | 校验 |
| --- | --- | --- |
| `settle` | 新事实，或覆盖同 `claim` 的旧 active 事实（旧的转 `superseded → 新 id`） | `claim` / `evidence` 非空、`grade` 必填；`relayed` / `unknown` 事实**不得**被引用为证据 |
| `retract {id, reason}` | `state='retracted'`，记原因；当日 `metrics.retracted` +1、`reasons[原因]` +1 | `id` 存在且不是已撤回；`reason` 非空 |
| `invalidate {since}` | `F#`：该事实 + 传递引用它的派生 → `superseded`；数字：`basedOn.facts <= epoch` 的 active 事实 → `superseded`；`epoch+1` | `since` 是合法 `F#` 或非负整数；已无 active 可作废 → 幂等 no-op（不涨 epoch） |
| `list` | 只读；默认只列 `active`，`includeAll:true` 连历史；显示当日 `settled` / `retracted` / `stale` 与原因分类 | — |

- 写动作都要 `confirm:true`；否则只返回预览。
- `settle` 允许显式 `grade:"unknown"`（诚实登记「未标注」），但这样的行同样不能被引用为证据——`list` 会显示
  `F3 [unknown]`（PRD 验收：未标注消息 / 事实必须可见）。
- **派生判定**：沿 `basedOn.factIds` 的**传递闭包**（`settle` 时按 `factIds` 或正文里的 `F3` token 建立边）。
  设计 §4 的 `basedOn.facts <= sinceEpoch` 公式保留给 **epoch 形式**；把它套到单个 fact id 上会把同 epoch 的
  无关事实一起作废（已记录为偏差，见下）。
- 撤回可度量：`retract`、`invalidate` **以及 `settle` 覆盖同 claim 的旧行（supersede）**都计入
  `metrics.retract_count`（设计 §5），按本地日期分桶、按原因分类（supersede 只计数，原因由 overwrite 本身表达）。
- `retract` 一行已 `superseded` 的事实时**保留 `supersededBy`**（复核）：否则 `[retracted:F2→F4]` 会退化成 `F2`，
  丢失「被哪条取代」。

#### 证据等级（D5/R2）

- `measured` = 自己量到的；`inferred` = 由已知推出；`relayed` = 转述；缺省 = `unknown`。
- **发送**：`collab_send` / `collab_reply` 可带 `grade` 与 `factIds`；未带 → 信封 `grade:"unknown"`。
- **接收注入**：`grade === "unknown"` → 消息行前标 **`[未标注]`**；接收方可要求补 `measured`。
- **引用**：`relayed` / `unknown` **不得**作为另一条事实的 `evidence`（正文 `F3` 或 `factIds` 两条路径都拒，
  错误文案直接给「补 measured」的写法）。没有这一步，一条转述会变成一条「已 settle」的事实。

#### 三态判定（R4/D2）

```
localState = { repo: HEAD(工作区), env: .env sha1 前 8 位, facts: ledger.epoch }
compare(basedOn):
  缺失                      → fresh + [基线未知]        （D2：不是 stale，不制造无法处置的告警）
  repo/env/facts 都相同     → fresh
  有一侧落后（值不同 / epoch 更小） → stale
  两侧各有超前（如 facts 更新、repo 更旧） → conflict    （本版只标记；0.9.5 才开决策）
```

- **hash 无法排序**：值不同按「我这边更新」处理（保守读法），并且只有**同时**出现 ahead + behind 才算
  `conflict`——两串不同 commit 不会单独变成冲突。
- 收端不认识 key（没见过的仓库）**跳过**，不猜。
- `stale` 注入附一句（每轮 ≤1 行）：

```
[stale] 本条基于 <commit>，你已到 <commit2>；只回增量（≤30% 原文），不要重述已作废事实
```

> **「≤30%」是行为约定，不是自动闸门**（0.9.4 复核调整）：插件不生成回复，无法机器判定长度。可验证的两条：
> ① 注入逐字包含上面这句；② 每次 `stale` 投递计入 `metrics.staleDeliveries`（当日计数），供人工抽检比值。
> 插件**不会**因为回复过长而拒绝任何内容。

- `conflict` 只注入 `[conflict] 基线分叉（本条 …，本地 …）—— 先各自报增量，0.9.5 会开决策`，**不自动开决策**。
- `[基线未知]` 标在消息行前（D2），与 `[未标注]` 可同时出现：一个说「不知道等级」，一个说「不知道基线」。

#### 注入（每段 ≤1 行，四段预算不变）

| 行 | 何时 | 内容 |
| --- | --- | --- |
| `[settled:F#]` | 本工作区新 settle 的事实，每会话只播一次（seen 集合） | `claim（grade · evidence）` |
| `[retracted:F#→F#]` | retract / invalidate 后，每会话只播一次 | 根 → 派生（多条时附「另有 N 条作废」） |
| `[未标注]` | 收到的消息 `grade=unknown` | 消息行前缀 |
| `[基线未知]` | 收到的消息没有 `basedOn`（D2） | 消息行前缀 |
| `[stale]` / `[conflict]` | `basedOn` 落后 / 分叉 | 消息行标记 + 每轮各 ≤1 行指令 |
| `[glossary]` | 本会话参与的会话对已有术语 | 一行摘要（最多 5 条） |

- 事实行**每轮重算**（不写 `injected[]`），只用每会话的 seen 集合去重；`markFactSeen` 在 block **push 成功之后**
  才写（注入失败下轮重试）。
- 四段 `[mission]/[todo]/[drift]/[progress]` 的 12 行预算**不变**；事实/术语行是同一 block 之外的独立段。

#### 在途失效（R5）

`invalidate` 成功后扫描契约文件：`todos[].ref.factId` 命中被作废事实的 **open** 行加 `staleWork: true`，
`[todo]` 行尾标 **`⚠失效`**、`collab_todo list` 同时显示 `依据 F#`。**不自动关闭**——替人决定「这条不用做了」
是另一种数据丢失。`ref` 由 `collab_todo { action:"add", factId }` 写入。

**按 workspace 过滤（复核）**：`F#` 在每个工作区从 `F1` 重新编号，只按 id 匹配会把另一个工作区的同名 todo
也标 `⚠失效`。因此 ref 记录创建时的工作区（`{ factId, workspace }`），`invalidate` 只标记 **ref.workspace ==
被作废账本所在工作区** 的行；没有 workspace 的旧 ref 一律不动（0.9.4 是第一个写 ref 的版本，不存在需要兜底的旧数据）。

#### glossary（R6）

每个会话对（`from+to` 排序后）维护 3–10 条术语（`~/.config/opencode/collab-glossary.json`，
`COLLAB_GLOSSARY_FILE` 可覆盖）：

```
collab_send { target, text, glossary:{ define:{ term:"状态", meaning:"读后立即" } }, confirm:true }
collab_send { target, text, glossary:{ conflict:["状态"] }, confirm:true }
```

- 同一术语第 **2** 次冲突且没有「上一次冲突之后」的新定义 → **拒绝发送**（0 写入），要求先定义；
  `define` 与 `conflict` 同一条消息里给齐则放行（一次定义 = 正是 R6 要的动作）。
- 定义会覆盖旧定义；每对上限 10 条；注入只取最新活动的会话对，1 行。

#### 偏差与边界（如实记录）

| # | 事项 | 现状 |
| --- | --- | --- |
| 1 | 设计 §4 的派生公式 `basedOn.facts <= sinceEpoch` | 只用于 `invalidate {since: epoch}`；`since: F#` 用**显式引用闭包**。套用公式到单个 id 会作废同 epoch 的全部无关事实（过度撤回会让真事实也被标死） |
| 2 | `facts` 表（SQLite） | **0.9.4 不投影**：真源是 `collab-facts.json`；`collab_index stats` 显示 `facts=0（真源在 collab-facts.json）` |
| 3 | repo / env 的先后 | 没有任意 commit 的祖先判定：值不同按「落后」；只有同时 ahead+behind 才 `conflict` |
| 4 | 契约本身没有 workspace 字段 | 由 todo 的 `ref.workspace` 承担（复核后）；无 workspace 的旧 ref 不参与 `staleWork` 标记 |
| 5 | `[未标注]` / `[基线未知]` 的噪声 | 这是**故意可见的债**：旧消息 / CLI 消息没有元数据，标记它们正是 R2 的验收项 |
| 6 | `conflict` 不开决策 | 0.9.4 只标记 + 注入；**0.9.5 起**由 `core/decisions.ts#openConflictDecision` 自动开一条 `origin:"conflict"` 的决策，thread/bid 只读直到 answer / supersede（24h 未回答自动作废）——见 §11.26 |

#### 配置 / 回滚

```ts
FACTS_FILE      = ~/.config/opencode/collab-facts.json   // COLLAB_FACTS_FILE
GLOSSARY_FILE   = ~/.config/opencode/collab-glossary.json // COLLAB_GLOSSARY_FILE
FACTS_LIMIT     = 2000      // 永久账本上限（非 active 先淘汰）
STALE_REPLY_RATIO = 0.3     // stale 回复的增量预算（只写进注入文案，不是闸门）
FILE_LOCK_STALE_MS = 60000  // 跨进程锁的陈旧阈值
FILE_LOCK_ATTEMPTS = 4      // = FILE_LOCK_RETRY_DELAYS_MS.length + 1（1 次首试 + 3 次重试）
FILE_LOCK_WAIT_MS   = 30000 // 4 次尝试之后的事件驱动等待上限
FILE_LOCK_POLL_MS   = 25    // 没有目录事件时的兜底轮询间隔
FILE_LOCK_RETRY_DELAYS_MS = [50, 200, 800]
```

回滚：`git restore -- src/core/messages.ts src/core/storage.ts src/core/contract.ts src/hooks/context.ts src/tools/{index,send,reply,todo,store,shared}.ts`、
`rm -f src/core/facts.ts src/core/tri-state.ts src/core/glossary.ts src/core/file-lock.ts src/tools/fact.ts test/facts.mjs`、
`rm -f ~/.config/opencode/collab-facts.json ~/.config/opencode/collab-glossary.json`；
从 `package.json` 的 `test` 链里移除 `node test/facts.mjs`。

#### 验收

`test/facts.mjs`（103 项）：27 个工具 · settle/list（id 连续、grade 必填、`unknown` 可见、同 claim 覆盖且计入
`retracted`）·
relayed/unknown 引用被拒（正文与 `factIds` 两条路径）· retract（state / reason / 当日计数 / 不可重复）·
invalidate F#（根 + 派生 superseded、epoch+1、幂等 no-op、`[retracted:F2→F6]` 工作区级传播）·
invalidate epoch（`basedOn.facts <= epoch`）· 三态 fresh/stale/conflict/无基线（D2）· `[未标注]` / `[stale]`（≤30% 文案）/
`[基线未知]` / `[conflict]` 注入 · `[settled]` 每会话只播一次 · 在途 todo 标 `staleWork` + `⚠失效` 且不关闭 ·
glossary（定义、第 2 次冲突拒绝、define+conflict 放行、一行注入、`collab_reply` 同参数）· 发送元数据
`grade` / `factIds` / `basedOn`（缺省 `unknown`，信封同）· 10 条进程内并发 settle 零丢失 · 跨工作区账本 /
`[settled]` / `staleWork` 隔离 · 注入预算（契约 ≤12 行、事实段 ≤3 行、整块 ≤15）· **3 个工作区（3 进程）各
settle 25 条 × 3 轮 `wsA/wsB/wsC = 25/25/25 lost=0`、9 次子进程 `refusals 0/9`** · 锁预算（`attempts = delays+1`、
`[50,200,800]` 全部被 sleep）· 超过退避预算仍持有的锁会被**等待**而不是采样拒绝 · `release()` 对空内容 /
他人 token 不删除、对自己 token 删除。
**变异（强制）**：`compareBasedOn` 恒返回 `fresh` → stale / conflict 三例必红（退出码 1）；
`withFileLock` 置空 → 3 工作区回归必红（实测单轮 lost = 22–24，退出码 1）。

### 11.26 决策载具与角色四元组（0.9.5）

> 问题（PRD）：24 条交接的 `decisions[]` **全空**、`collab_decisions` 一次没用过；两条最大的 thread（418 / 140 条）
> **根本没有交接记录**，决策无处可落。同一个决策反复重开（11:09 起「决策」类措辞 19 次，00:52 出现「第四次/第五次
> 同步同一事实」）；角色边界靠自然语言重申（B 54 次决策类措辞 / 31 次边界声明，A 38 / 36）——**双方都在声明边界 =
> 边界没被写下来**。

#### 存储

```
~/.config/opencode/collab-decisions/<key>.json     key = threadID（t_…）或 bid（b_…）
{ "v": 1, "key": "t_…", "next": 4,
  "items": [{ "id": "D1", "question": "…", "options": ["A","B"], "owner": "ses_…",
              "status": "open|answered|superseded", "answer": null, "by": null, "at": 0,
              "hash": "sha1", "origin": "manual|conflict" }] }
```

惰性创建（读不写）· `tmp + rename` · **整段 read-modify-write 套 `<file>.lock`**（跨进程互斥，`tmp+rename` 只保证
原子性不保证互斥）· 坏文件降级为空、不抛错 · `COLLAB_DECISIONS_DIR` 覆盖目录（测试绝不写真实 `~/.config`）。

#### 动作与规则

| action | 语义 | 校验 |
| --- | --- | --- |
| `open {key, question, options≥2, owner?}` | 新建 `D#` | `question` 非空；`options ≥ 2`；`owner` 为 `ses_…`（缺省见下） |
| `answer {key, id, answer}` | `status='answered'` + `by` | **调用者必须 == owner**；已回答需先 `supersede` |
| `supersede {key, id, reason}` | `status='superseded'` | **提问方 / owner / 该 thread（或交接单）的参与方**可作废，但 `by` + `reason` 必记；占用释放 |
| `list {key?, includeAll?}` | 只读 | 省略 `key` = 本会话作为提问方 / owner / 参与方的全部 open |

- **同问去重（R3）**：`hash = sha1(normalize(question))`，`normalize` = NFKC + 小写 + 去空白/标点/符号。
  同 hash 的 **open** 记录已存在 → 拒绝，返回 `已有同问决策 D3 open, wait ses_x`（不重复计数）。
- **上限 3（D9）**：同一 `key` 同时 open 的**手工**决策 ≤ 3；第 4 条拒绝并列出当前 `D#`，提示先 `answer` 或 `supersede`。
  **conflict 决策单独占一条配额**（不占手工 3 条）：手工列表满了也必须能升级，否则 thread 会继续用对话争论。
- **提问方是当事人（B1）**：`askedBy` 与 `owner` 分开记 —— 提问方拿得到 `[decide]`、能 `supersede` 撤回，
  但**不能 answer**（owner 独占）。
- **owner 缺省**：契约 `peers` 里的 `decider` → 发单方（thread 发起人 / 交接单 `from.sid`）→ 当前会话。
  **conflict 决策例外**：`decider` 未声明时 owner = **收到分叉的本会话**（不把提出分叉的对端设为裁决者，N11）。
- **`D#` 每个 key 独立**（两条 thread 各有 D1）：所以注入行写成 `D1@t_…`，而 `decision:<id>` 在跨 key 重名时
  会明确报**歧义**，要求写作用域 `decision:<key>#D1` —— 绝不静默挑一个。

#### 角色四元组（R5）

`peers: [{ sid, role: 'requester'|'implementer'|'decider'|'verifier', threadId, since }]`（0.9.1 的占位字段，本版有语义）。

- 默认推导：交接发起方 = `requester`、承接方 = `implementer`、`decider` = 发起方 owner、`verifier` = `requester`；
  `collab_accept` 领取成功时写进承接方契约，`collab_decide open` 时写进提问方契约（都是注入提示，写失败不影响主流程）。
- 注入：`[role:implementer] 你负责实现；实现选择请交 decider` —— 并入 `[mission]` 首行，**不单独占行**。
- **只声明角色，不做文本推断**：0.9.2 起插件不对消息正文做任何关键词 / 子串匹配（闸门也一样）。角色行是静态的；
  「这条消息是不是在让我决定实现」由模型自己判断，插件不猜（B4：早期子串匹配在「帮我改 PRD 验收口径」
  「这个模块怎么实现的？」「我先看一下再决定」三句上都误伤过）。

#### conflict 自动升决策（R6）

`tri-state` 判 `conflict`（两侧在不同维度各自超前）时：

1. `core/decisions.ts#openConflictDecision` 开一条 `origin:"conflict"` 的决策：`question = 基线分叉：<维度>`，
   `options = 以我方为准 / 以对方为准 / 重新测量`，`owner = decider ?? 收到分叉的本会话`，并记 `parties`（thread 的两端）；
   **幂等**（同 key 已有 open 的 conflict 决策 → 复用），**不占手工 3 条配额**。
2. 注入 `[conflict] 已开 D2（等 ses_…）—— 决策关闭前本 thread 只读（不再产生新消息）；双方都可 supersede 解除`。
3. `collab_send` / `collab_reply` / `collab_handoff` 在**该 thread 或该 bid**（`b_…` 同样拦）上有未关闭的 conflict
   决策时**可读拒绝**（降级为只读，读用 `collab_inbox` / `collab_status`）；`answer` / `supersede` 后恢复。
   **逃生口（B2）**：owner 缺席时，该 thread 的任一方（`parties`）都能 supersede；且冲突决策 **24h 未回答自动
   作废**（`expireConflictDecisions` 在每次注入时扫描，`by=system`，理由写明「24h 未回答」），thread 一定不会永久只读。
   `tri-state.ts` 保持纯函数（`conflictDecision(verdict)` 只产生 question/options），写盘在 `core/decisions.ts`。

#### `decision:` 的单一 resolver

`core/decisions.ts#resolveDecision` 是**唯一**回答「这条算不算已决策」的地方：先读决策账本（权威），再读 0.7.0 的
hand-off `decisions[]`（兼容输入）。`core/evidence.ts`、`collab_todo close`、`collab_progress light` 全部走它；
open / superseded 的决策**不是**证据（旧 hand-off 记录里的 id 仍按「已记录」处理）。

#### 注入

```
[mission] 排钟 B4 接线 · .trellis/tasks/… · [role:requester+verifier] 你发单；你验收
[decide] D2@t_mwoy2460_b9pm open（等 ses_e176…，4.2h） · D3@b_55ab… open（等 ses_p…，<1m） · 还有 1 条
```

`[role]` **并入 `[mission]` 首行**（不占新行），`[decide]` 独立 ≤1 行。段上限 mission 3 + todo 4 + decide 1 +
drift 2 + progress 2 = **12**，与生产预算相等：六段全满时**没有任何一段被丢**（`test/decide.mjs` 有一条
12 行 / `dropped=[]` 的用例）。没有契约、也没有任务锚的会话，如果它是某个 open 决策的当事人，只注入 `[decide]` 那一行。

#### 验收

`test/decide.mjs`（**79 项**）：28 个工具 · thread 路径 open/list · bid 路径 open 且与 thread 命名空间隔离 · 非 owner
answer 拒绝（0 写入）· 已回答再 answer 拒绝（提示 supersede）· 同问变体（大小写/空白/标点 + **NFKC 全角**）拒绝并返回
既有 `D#` + owner · 第 4 条 open 拒绝（上限 3）+ supersede 释放槽位 · owner 缺省（decider → 交接发起方）· 四元组推导 +
`[role:…]` 静态声明（三句常见话都不产生建议）· **提问方是当事人**（owner≠asker：看得见、可 supersede、不能 answer）·
conflict → 一个 open 决策 + 同 thread 只读（answer 后恢复）· **conflict 逃生口**（对端 supersede、25h 自动作废）·
**bid-key 拦截** · **手工 cap 满仍能升级** · **六段全满 12 行 / 无 dropped** · **501 条扫描保留最新 500** ·
`[decide]` 一行且只列 open · `decision:` 单一 resolver（open 不是证据 / answered 是 / superseded 不是 / 跨 key 重名报歧义 /
旧 `decisions[]` 兼容 / `collab_todo close` 使用它）。
**变异（强制）**：去掉 `normalizeQuestion`（hash 直接 sha1 原文）→ 「同问变体被拒」与「重复 open 0 写入」两条必红
（实测退出码 1）；去掉 `.normalize('NFKC')` → 「全角数字同问被拒」必红（该行为由 S9 用例固定）。

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

