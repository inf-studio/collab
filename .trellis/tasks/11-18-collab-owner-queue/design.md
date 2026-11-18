# 设计：owner 队列 / research / 同仓拒广播

## 1. 队列存储

```jsonc
// ~/.config/opencode/collab-owner-queue/<targetSid>/<queueId>.json
{
  "id": "q_<base36ts>_<rand4>",
  "target": "ses_…",
  "from": "ses_…",              // 发起方（非受保护）
  "at": 0,
  "summary": "≤500 字，去控制字符",
  "issuePath": "docs/issues/x.md | null",
  "bid": "b_… | null",          // 若发起方已在某个 bid 里提过
  "revokedAt": null,
  "seenAt": null                 // 由目标会话的 context hook 写入（每会话一次）
}
```

- 目录 `~/.config/opencode/collab-owner-queue/`（`COLLAB_OWNER_QUEUE_DIR` 可覆盖，harness 用）；
- 每目标上限 **50**，满则拒绝新项；写入 `tmp+rename`；
- 不进入 broadcast 目录、不建 thread、不产生 bid。

## 2. 工具 `collab_request_owner`

```
{ target, text, issuePath?, revoke?, confirm }
```

- `target`：必须 `protectedAncestor(...)` 命中（自身或祖先）；否则报错「请用 collab_handoff」；
- 发起方若本身受保护 → 拒绝（不做受保护→受保护的转发）；
- `text` 转 summary（≤500、去控制字符）；`issuePath` 仅做**语法**校验（相对路径、`docs/issues/*.md`、无 `..`/绝对），
  不做 fs 校验（目标工作区可能不在本机视图内）；
- `revoke:true`：删除该 queueId（仅 `from === me`）；
- `confirm:false`：只预览（目标、summary、queueId），**零写入**。

## 3. 只读提示（复用 pull 模型）

`injectionFor(sessionID)` 对受保护会话的返回为**显式白名单**：

1. `followUps` 只读提示（已有，≤1 行）；
2. `owner-queue` 未读项（`seenAt` 为空），**每次最多 3 行**，按 `at` 升序：
   `- [owner-queue] <from 短 id> @ <HH:MM>：<summary 截断 120>（<issuePath 或 ->）`

- 标记时机同 F1：`context` hook 在 `system.push` **成功后**才写 `seenAt`；
- 渲染不含任何指令/回执要求；不因队列项产生投递。

## 4. 发起方可见

`collab_list` 追加：

```
我提交给受保护会话的请求：2 条待处理
- q_…  → <target 短 id>  <HH:MM>  <summary 截断 60>
```

只读；`revoke` 通过工具。

## 5. `expected:research`

- `normalizeExpected` 接受 `{implement, review, research}`；
- `research` 的接管文案：只读排查 + 在最后一条回复写 `[handoff] DONE|BLOCKED <bid> <结论>`；
- 能力不匹配提示：`agent === 'explore' && expected === 'implement'` 时结果追加
  `注: 承接方为只读 agent，implement 期望可能无法完成；建议 expected:"research" 或显式 promote`。

## 6. 同仓 broadcast

`collab_broadcast` 入口比较 `realpath(workspace)` 与 `realpath(ctx.location.directory)`：相等则抛
`拒绝广播：目标就是当前工作区；同仓请用 collab_handoff { text }`（不写任何记录）。

## 7. 安全与回滚

| 面 | 处理 |
| --- | --- |
| 方向 | 仅 非保护 → 受保护；受保护 → 受保护拒绝 |
| 注入 | 只读白名单，不含正文以外的指令；summary 去控制字符 |
| 隐私 | summary 是发起方主动提供的内容，≤500；不读取目标会话内容 |
| 回滚 | 删除队列目录；代码 `git restore` |

## 8. 回归

| 用例 | 期望 |
| --- | --- |
| enqueue → 目标 hook | 1–3 行只读提示，`seenAt` 写入，第二次不再出现 |
| 注入失败 | 不写 `seenAt`，下轮重试 |
| 受保护发起方 | 拒绝 |
| 非受保护目标 | 拒绝并提示用 handoff |
| revoke | 仅发起方可删；删后不再提示 |
| 队列满 50 | 拒绝新项，已有项保留 |
| research | 可传；explore+implement 有提示 |
| 同仓 broadcast | 抛错且不写记录 |
