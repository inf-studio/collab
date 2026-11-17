# 复核后修复记录（fix round，2026-11-17）

> 输入：`research/check-report.md`（独立复核，「有条件通过」）+ owner 裁定「阻断 + 应修全修，补规则用例，更新文档」。
> 范围：`.opencode/plugins/collab.js`、`docs/collab.md`、`.trellis/spec/guides/cross-session-collab-guide.md`、
> 本任务 `prd.md` / `implement.md` / `research/handoff-harness.mjs`。
> 未 commit / 未 push；未改 `packages/**`、`apps/**`、`bench/**`、`docs/issues/**`。

## 0. 结论

| # | 项 | 状态 | 主要落点 |
| --- | --- | --- | --- |
| F1 | 阻断：受保护会话的子会话不在护栏内 | 已修（含真实会话验证） | `collab.js:334-412`（`createLineage`）、`:699-714`（dispatch 拒绝）、`:864-912`（list 标记） |
| F2 | 应修：reply 参与者 / 路由未校验 | 已修 | `collab.js:966-1000`（send reply 分支）、`:1035-1060`（collab_reply）、`:790-812`（waitForReply） |
| F3 | 应修：thread 复用语义 | 已修 | `collab.js:514-540`（request → open）、`:784-840`（只看最后一次 request 之后的 reply） |
| F4 | 应修：legacy 消息的错误回执指引 | 已修 | `collab.js:205-214`（`normalizeThreadID`）、`:1306-1326`（`lineOf`） |
| F6 | 应修：`collab_wait` 缺 threadID 校验 | 已修 | `collab.js:1130-1148`（格式校验）、`:790-812`（thread 不存在快速失败） |
| 用例 | 规则用例 S17–S22 | 已补，harness 改为断言式（失败 exit 1） | `research/handoff-harness.mjs` |
| 文档 | `docs/collab.md` / spec guide / prd AC5 | 已更新 | 见 §6 |

## 1. F1（阻断）血缘护栏

**改法**

- 新增 `createLineage(ctx)`（`collab.js:350`）：
  - `nodeOf(sessionID)` 先 `ctx.session.get({sessionID})`；若返回对象**没有 `parentID` 字段**（不同宿主版本），
    退回 `ctx.session.list({limit:100})` 建立的映射（结果按实例缓存，最多一次 list 调用）。
  - `protectedAncestor(sessionID, protect)` 从目标向上逐级走 `parentID`，命中 protect 名单即返回
    `{sessionID, depth}`（`depth: 0` = 目标本身）；`MAX_LINEAGE_DEPTH = 8`（`collab.js:65`）截断，
    并用 `seen` 集合防 `parentID` 成环。
- `dispatch` 把原 `config.protect.includes(sessionID)` 换成 `protectedAncestor(...)`（`collab.js:704`），
  错误文案区分「本身 / 第 N 级祖先」并点名命中的祖先 id（`collab.js:706-714`）。
- `collab_list` 用同一 helper（`lineage.seed(sessions)` 复用已取的页），对命中血缘的会话标
  `[protected-child]`，并打印 `parent=<short id>`；`[self]` / `[protected]` 原标记保留
  （`collab.js:864-912`）。
- `fail-closed`：`collab_reply` 同样受限（受保护线发起的请求，其回执投不回去），错误里加
  「回执同样适用该护栏（fail-closed）」并在文档写明规避方式，见 §7「需裁定」。

**真实证据（只读 + 无投递）**

服务端 `Session.Info` 确实带 `parentID`（`opencode api get /api/session/ses_e196273b2ffekqAqqqKfyA4xMN`）：

```
{"id":"ses_e196273b2ffekqAqqqKfyA4xMN","parentID":"ses_e1eb91cebffeTv1467ubJLKebk", ...}
```

修复后的真实 `collab_list`（插件在跑新代码）已把两条受保护线的子会话标出来：

```
ses_e195d42bdffeSCLeWVWiP4uUtV  trellis-implement  busy  ...  "扩词表降 uncovered"      [protected-child] parent=ses_e23a…dUL3
ses_e195ad313ffeeGIDlpOmyIBAwd  trellis-check      busy  ...  "order:detailed 接线复核"  [protected-child] parent=ses_e1eb…Kebk
ses_e1eb91cebffeTv1467ubJLKebk  build              idle  ...  "machine/state 出入参 schema 固化"  alias=schema [protected]
...
[protected] / [protected-child] 均不可投递（后者是受保护会话的子会话）。
```

对两个**真实**的受保护线子会话调用 `collab_send`（`confirm:false`，即使护栏失效也只会预览）均被拒绝：

```
拒绝投递：目标 ses_e196273b2ffekqAqqqKfyA4xMN 的祖先（第 1 级）ses_e1eb91cebffeTv1467ubJLKebk 在 protect 名单内
（/root/.config/opencode/collab.json 的 protect + 内置硬名单，覆盖其任意层级子会话）。未发送任何内容。
拒绝投递：目标 ses_e195d42bdffeSCLeWVWiP4uUtV 的祖先（第 1 级）ses_e23a4a23fffe4c4m7UQFR8dUL3 在 protect 名单内
（…）。未发送任何内容。
```

> 这两次调用没有产生任何投递（护栏在 `prompt` 之前抛错，且 `confirm:false`）。

## 2. F2（应修）reply 参与者与路由

**改法**

- `collab_send` 的 `kind:"reply"` 分支（`collab.js:966-1000`）：
  - thread 不存在 → 仍降级为新请求（原语义，S11 保留）；
  - `me` 存在但不是 `fromSession`/`toSession` → 抛「拒绝回执：当前会话 … 不是 thread … 的参与方」；
  - 参与者但 `target !== 对端` → 抛「拒绝回执：thread 的对端是 …，与 target … 不一致」，
    **在 `dispatch` 之前**，因此不投递、不写 thread；
  - `me` 缺失（CLI 等无工具上下文）→ 不校验身份，`dispatch` 的返回里加注「未校验 reply 的参与者与对端」。
- `collab_reply`（`collab.js:1035-1060`）：`me ∉ {fromSession, toSession}` → 抛错；`counterpart`
  优先按 `me` 解析，无 `me` 时退化为 `fromSession ?? toSession` 并加注。
- `waitForReply`（`collab.js:795-812`）：进入轮询前先读 thread，`me` 非参与者直接抛错（不再静默返回全文）；
  无 `me` 时在返回正文末尾加注。

**用例**：S19（非参与者 reply / wait）、S20（reply 误路由 + thread 未被污染 + 合法回执仍可用）。

## 3. F3（应修）thread 复用语义

**改法**

- `appendThreadMessage`：`request` 一律把 status 置 `open`（`collab.js:534-540`），不再保留 `answered`。
- `waitForReply`：以 `msgs` 的**追加顺序**定位最后一次 `request` 的下标，只看其后的 `reply`
  （`collab.js:814-822`）。选择下标而不是比较 `ts`，因为同一毫秒内多条消息的 `ts` 会相等，
  数组顺序才是真实的追加顺序；这也天然兼容旧数据 —— 没有 request 记录时 `lastRequest = -1`，
  退化为「任意 reply」（原行为）。

**用例**：S21 —— 第二轮 request 后 `status=open`、接收方 hook 重新提醒、`collab_wait` 不会立即
返回上一轮回执（1000ms 超时），第二轮回执到达后返回新内容。

## 4. F4（应修）legacy 消息指引

**改法**

- 新增 `normalizeThreadID`（`collab.js:205-214`）：`undefined` / `null` / `"undefined"` / `"null"` 统一视为
  「无 thread」。
- `extractInbound` 用它解析 metadata 与信封里的 threadID（`collab.js:573-576`），不再可能写入字符串
  `"undefined"`。
- 注入文案 `lineOf`（`collab.js:1306-1326`）：`!threadID` 时不再拼 `collab_reply {threadID:"undefined"}`，
  改为「无 thread 关联，无需回执；直接处理即可（或 collab_send 发起新请求）」；
  reply 类改为「无 thread 关联，无需等待回执」。
- `collab_inbox` 尾部提示补「无 thread 的 legacy 消息无需回执」（`collab.js:1108`）。

**用例**：S22（注入文案不含 `collab_reply`、不含 `undefined`；入库记录无 threadID）。

## 5. F6（应修）`collab_wait` 校验

**改法**

- `collab_wait`（`collab.js:1130-1148`）：`threadID` 先过 `normalizeThreadID`；非空但格式不合法 →
  **立即**抛「threadID 格式不合法」；合法格式交给 `waitForReply`。
- `waitForReply`：thread 不存在 → 立即抛「没有 thread …（可能拼错 / 由别的项目目录创建 / 刚发出请稍后重试）」，
  不再空等到 timeout（`collab.js:793-801`）。

> 已知窗口：`dispatch` 是「先 `prompt` 后写 thread」。若接收方在收到消息的瞬间就 `collab_wait`，可能撞上
> thread 尚未写入的微秒级窗口 —— 错误文案已写明「若请求刚发出，稍后重试」，且不改变「先投递后记账」的
> 安全顺序（避免 prompt 失败却留下已投递的 thread 记录）。

**用例**：S22 两个快速失败（实测 0–1ms，断言 <500ms）。

## 6. 新增规则用例（`research/handoff-harness.mjs`）

假 ctx 新增 4 个会话 fixture：`ses_child`（parentID=schema）、`ses_grand`（parentID=ses_child）、
`ses_ccc` / `ses_ddd`（无关会话）。新增断言帮助函数 `expect` / `expectFail`，harness 结束打印
`=== N/M checks passed`，任一失败 `process.exit(1)`。

| 编号 | 意图 | 断言 |
| --- | --- | --- |
| S17 | 受保护会话的**直接子会话**不可投递；`collab_list` 标 `[protected-child]` + `parent=` | 拒绝 + 文案含祖先 id 与「第 1 级」 |
| S18 | **孙级**子会话（验证逐级上溯） | 拒绝 + 文案含「第 2 级」与受保护 id |
| S19 | 非参与方 `collab_reply` / `collab_wait` | 均抛「不是 … 的参与方」 |
| S20 | `collab_send{kind:"reply", threadID, target:无关}`；非参与方 kind:reply；合法回执 | 拒绝 + `msgs` 数量与 `toSession` 未变 + 未投递到无关会话 + 合法回执仍成功 |
| S21 | 同 thread 第二个 request | `status=open`、hook 重新提醒、wait 不返回旧回执（超时）、第二轮回执可取回 |
| S22 | legacy 无 thread 消息 + `collab_wait` 校验 | 注入无 `collab_reply` / 无 `undefined`；`not-a-thread` 与 `t_ghost_9999` 均 <500ms 报错 |

S1–S16 原样保留并通过（S9 的第二段改为「未知 thread 现在快速失败」，只是文案/命名更新，仍属同一断言意图）。

## 7. 验收命令原始输出

```
$ node --check .opencode/plugins/collab.js
CHECK_EXIT=0

$ node .trellis/tasks/11-17-collab-handoff/research/handoff-harness.mjs
HARNESS_EXIT=0
...
  ✓ S17 send to a direct child is rejected — 0ms / 拒绝投递：目标 ses_child 的祖先（第 1 级）ses_e1eb91cebffeTv1467ubJLKebk 在 protect 名单内（…）。未发送任何内容。
  ✓ S17 list marks [protected-child] + parent=<short> — ses_child  trellis-implement  busy  --:--:--  "child of schema"  [protected-child] parent=ses_e1eb…Kebk
  ✓ S18 send to a grandchild is rejected — 0ms / … 第 2 级 …
  ✓ S19 non-participant collab_reply is rejected — 0ms / 拒绝回执：当前会话 ses_ccc 不是 thread t_mwjw19k7_nh8t 的参与方（…）
  ✓ S19 non-participant collab_wait is rejected — 0ms / 拒绝等待：… 不是 thread … 的参与方（…）
  ✓ S20 kind:reply to a non-counterpart target is rejected — 0ms / 拒绝回执：thread … 的对端是 ses_aaa，与 target ses_ddd 不一致。…
  ✓ S20 non-participant kind:reply is rejected — 0ms / …
  ✓ S20 thread not polluted — msgs 1→1
  ✓ S20 nothing delivered to the unrelated target
  ✓ S20 legit reply still accepted — kind=reply  thread=t_mwjw19k7_nh8t  status=answered
  ✓ S21 round-1 reply is returned
  ✓ S21 second request reopens the thread (open) — kind=request  thread=t_mwjw19k8_njq9  status=open
  ✓ S21 wait does not return the stale reply — 1000ms / 等待回执超时：… 没有新的 kind=reply 消息（只看最后一次 request 之后的回执…）
  ✓ S21 reused thread is reminded again — [{"type":"text","text":"[collab] 待处理请求 1 条\n- request t_mwjw19k8_njq9 from=ses_aaa: S21 round 2 → 处理后用 collab_reply {threadID:\"t_mwjw19k8_njq9\"}\n全文/状态用 collab_inbox。"}]
  ✓ S21 round-2 reply is returned
  ✓ S22 legacy message injected
  ✓ S22 legacy hint has no collab_reply
  ✓ S22 no literal "undefined" threadID
  ✓ S22 legacy record has no threadID
  ✓ S22 collab_wait malformed threadID fails fast — 1ms / threadID 格式不合法："not-a-thread"（…）
  ✓ S22 collab_wait unknown threadID fails fast — 0ms / 没有 thread t_ghost_9999：… 
  ✓ S22 both failures are immediate (<500ms) — 1ms

=== 24/24 checks passed

$ opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"
# 非 active 的插件（应为空）：
[]
{"id":"collab","source":{"type":"local","path":"/data/project/muke-pos-app/.opencode/plugins/collab.js"},
 "features":{"server":true},"state":{"status":"active"}}
```

## 8. 真实链路抽取 + 清理

临时会话（带 `location.directory`，`parentID=null`）：

```
$ opencode api post /api/session -d '{"title":"collab-fix-probe","location":{"directory":"/data/project/muke-pos-app"}}'
SID=ses_e19553215ffeOqD3m8Yew2Gm3W
{"id":"ses_e19553215ffeOqD3m8Yew2Gm3W","parentID":null,"directory":"/data/project/muke-pos-app","title":"collab-fix-probe"}
```

插件工具链（真实代码路径）：

```
collab_send confirm:false →
未投递（confirm 不为 true，仅预览）。目标: ses_e19553215ffeOqD3m8Yew2Gm3W  agent=?  state=idle  title="collab-fix-probe"
kind=request  thread=t_mwjw1go6_w6y6 / 模式: queue / 将发送: [collab:ses_e195…Ozbd][request:t_mwjw1go6_w6y6] fix-round probe: preview only

collab_send confirm:true →
已投递 → ses_e19553215ffeOqD3m8Yew2Gm3W  agent=?  state=idle  title="collab-fix-probe"
kind=request  thread=t_mwjw1goi_c58n  status=open
mode=queue  message=msg_1e6aad6be001oHbqjYXVKXCUCP  delivery=queue
```

清理并复核 404：

```
$ opencode api delete "/api/session/ses_e19553215ffeOqD3m8Yew2Gm3W" -d '{}'
$ opencode api get "/api/session/ses_e19553215ffeOqD3m8Yew2Gm3W"
{"_tag":"SessionNotFoundError","sessionID":"ses_e19553215ffeOqD3m8Yew2Gm3W",
 "message":"Session not found: ses_e19553215ffeOqD3m8Yew2Gm3W"}
HTTP 404 Not Found
```

未向 `ses_e1eb91cebffeTv1467ubJLKebk`、`ses_e23a4a23fffe4c4m7UQFR8dUL3` 及其任何子会话投递消息；
对真实会话只发了 `GET` 与两次 `confirm:false`（护栏在投递前抛错，未产生 prompt）。

**补充证据（真实回执链路）**：临时会话在被删除前对上面那次真实投递回了执，我方 `collab_inbox` 读到：

```
[collab] 共 1 条，未读 0 条（显示最近 1 条，单条上限 4000 字）:
07:22:02  [reply] thread=t_mwjw1goi_c58n  from=ses_e195…Gm3W (ses_e19553215ffeOqD3m8Yew2Gm3W)  seen injected status=answered
    收到 probe，已读。……（本条探针可删除）
```

即真实链路上：`request` 投递 → 对端 `collab_reply` → 入站记录 + thread `answered` 全部成立
（参与方校验通过、目标路由正确、状态机 `open → answered` 落地）。该 thread 的对端会话已删除，
因此无法（也不需要）再回执；`ctx.storage` 里的探针 thread 记录无副作用，可留待自然裁剪。

## 9. 文档改动

- `docs/collab.md`
  - §11.2：`collab_list` 标记修正为 `[self]` / `[protected]` / `[protected-child]` + `parent=<short>`
    （删除不准确的 `[self,protected]` 说法）；`collab_inbox` 标注单条上限 `INBOX_TEXT_LIMIT=4000`；
    `collab_wait` 注明只看最后一次 request 之后、仅参与者、快速失败；`collab_send` 注明 reply 路由/参与者规则。
  - §11.3：注入说明补「无 thread 的 legacy 消息提示无需回执」。
  - §11.4：`protect` 说明升级为血缘护栏（`parentID`、≤8 级、环保护、`ctx.session.get` / `list` 回退），
    并写明 fail-closed 对 `collab_reply` 同样生效。
  - §11.6：新增第 5、6 条（参与者校验 / 子会话血缘护栏）。
  - §11.7：storage 契约字段与实现对齐；新增**状态机表**（request → open、reply → answered、note 不变、
    closed 不可达）；明确 thread **可复用**（同一 threadID 的第二个 request 会重开）；
    新增「参与者与路由校验」小节；新增「跨项目/跨目录回执会静默超时」提示。
- `.trellis/spec/guides/cross-session-collab-guide.md`
  - §2 硬规则 2：protect 覆盖任意层级子会话。
  - §2.1 由「两条契约」扩为四条：新增「子会话血缘护栏」「reply / wait 需参与者身份」，并在第 2 条补
    「thread 可复用、wait 只看最后一次 request 之后」。
- `prd.md`：AC 第 5 条按实测口径改写（插件**文件变更**触发热重载后数据仍在；`collab.json` 不触发重载；
  `opencode service restart` 后的持久化未验证）。
- `implement.md`：新增 §8「复核后处置（fix round）」勾选清单与回滚命令。

## 10. 未验证 / 需裁定

1. **fail-closed 的副作用（需 owner 裁定，未自行改契约）**：受保护线（或其子会话）**发起**的请求，
   其回执也会被护栏拒绝（`collab_reply` → 目标是对端 → 命中血缘）。当前实现严格按「一律拒绝投递」，
   已在错误文案与 `docs/collab.md` §11.4 写明，并给出规避（该线自查 `collab_inbox` / 走 channel 留痕）。
   若希望「回执回到发起方」不受限，可加一条例外：`kind:"reply"` 且 `thread.fromSession === target.sessionID`
   时放行 —— 但这会把「伪造 thread 记录」变成绕过护栏的路径（storage 同 location 共享），需产品权衡。
   本子代理**未**实现该例外。
2. **真实事件流下的 hook 去重 / 复用提醒**：S21 的「重新提醒」用假 ctx 直接调 `context` hook 验证；
   真实 `session.inbox.enqueued` 事件路径本次未重跑（需真实 agent 轮次，成本与「不打搅并行会话」约束）。
   事件路径代码未改动（仅 `threadID` 归一化），风险低。
3. **`opencode service restart` 后的 `ctx.storage` 持久化**：仍未验证（会中断并行会话），与复核报告 §5 一致。
4. **`ctx.session.get` 在别的宿主版本是否带 `parentID`**：本机实测带（见 §1 与真实 `collab_list`）；
   不带时走 `ctx.session.list` 回退，该回退只在假 ctx（fixture 缺字段）下覆盖，**未在真实宿主上触发过**。
5. **`closed` 状态仍不可达**（复核报告「可留」第 7 项）：文档已按现状写明「没有工具写入 closed」，
   未新增 close 工具。
6. **`vp fmt`**：`docs/collab.md` 在 HEAD 上就不满足 `vp fmt --check`（`git show HEAD:docs/collab.md`
   同样报 format issues），本次只改内容、**未**整篇重排，避免把无关表格宽度改动混进 diff。
   `.opencode/**` 与 `.trellis/**` 在 `eslint.config.mjs` / `vite.config.ts` 的忽略列表内，生产插件不在
   fmt/typecheck/lint 范围，本次门禁为 `node --check` + harness。
