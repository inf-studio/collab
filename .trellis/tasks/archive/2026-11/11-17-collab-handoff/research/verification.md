# 验证证据（交接协议，2026-11-17）

> 全部实验只用**自建临时会话**（`opencode api post /api/session` 建），结束 `DELETE` 并复核 404。
> 未向 `ses_e1eb91cebffeTv1467ubJLKebk`（schema 线）、`ses_e23a4a23fffe4c4m7UQFR8dUL3`（本线主会话）
> 或其子会话投递；`BUILTIN_PROTECT` 未改动。
> 未执行 `opencode service restart`（当时有 3 个 busy 会话：schema 线、design 线等）。

## 1. 闭环：request → reply → wait（真实 agent，最终代码）

A = `ses_e196ae5daffeWUBIjFiCEFs7fK`（build），B = `ses_e196ae582ffeO2VWnDXMkVc2yM`（build），
标题 `collab-final-A` / `collab-final-B`。

A 的两次工具返回原文（模型原样贴出）：

```
{"send":"已投递 → ses_e196ae582ffeO2VWnDXMkVc2yM  agent=build  state=idle  title=\"collab-final-B\"
kind=request  thread=t_mwjv6zhc_uxdg  status=open
mode=queue  message=msg_1e69524230014gJcfKrvCYvqxQ  delivery=queue
提示: 对方回执后可 collab_wait {threadID} 等结果；不要用 steer 打断对方的当前轮。"}

{"waited":"thread t_mwjv6zhc_uxdg 收到回执（status=answered）:
from=ses_e196…c2yM (ses_e196ae582ffeO2VWnDXMkVc2yM)  06:58:19

FINAL-OK"}
```

B 侧收到的 user turn 与回执：

```
[collab:ses_e196…s7fK][request:t_mwjv6zhc_uxdg] 请回执 FINAL-OK
collab_inbox → [collab] 共 1 条，未读 0 条（显示最近 1 条）:
06:58:16  [request] thread=t_mwjv6zhc_uxdg  from=ses_e196…s7fK (...)  seen injected status=open
    请回执 FINAL-OK
collab_reply → 已投递 → ses_e196ae5daffeWUBIjFiCEFs7fK  agent=build  state=busy  title="collab-final-A"
kind=reply  thread=t_mwjv6zhc_uxdg  status=answered
mode=queue  message=msg_1e695310c001XxIUDQUQT3LsXw  delivery=queue
```

结论：thread 从 `open` → `answered`，回执全文被 `collab_wait {threadID}` 取回。

## 2. 不打断：目标忙时投递，当前 assistant 消息 id 不变

B = `ses_e19703779ffejouxjys0NxJ712`，先用 `shell: sleep 20` 让它忙起来；
C = `ses_e19710adaffe6zKIt0dnWaccyc`（explore）在此期间投递 `mode:"steer"`。

投递前（`/tmp/handoff-before.json`）：

```
BEFORE assistant ids: ['msg_1e68fe2cd001Ysv8cNVrEjP8sk', 'msg_1e68fea6300107P9ZN7GpvnC5W',
                       'msg_1e6908a89001tTw4JI1BtLLVcs', 'msg_1e69091cf001CKBCwZSMO1sI6o',
                       'msg_1e691c5650012PkZJCSmqaipoQ']   ← 正在跑的那条
DURING ids:           完全相同的 5 个 id（列表长度 10 == 10，无新增 user turn）
```

投递返回：

```
已投递 → ses_e19703779ffejouxjys0NxJ712  agent=build  state=busy  title="collab-handoff-B2-build"
kind=request  thread=t_mwjv2gxu_frtn  status=open
mode=queue(forced)  message=msg_1e691ed43001rA78SXZyCQw2  delivery=queue
注: 只读 agent：已强制 queue（入队，不打断对方当前轮）。
```

目标 B 的 `context` hook 快照（探针插件）显示：`sleep 20` 期间的所有模型请求里**没有**这条消息；
它是在这一轮结束后的下一个 turn 才作为普通 user turn 出现
（`t=1794869698382` 的请求才包含 `[collab:ses_e197…ccyc][request:t_mwjv2gxu_frtn] 忙时投递测试…`）。

## 3. 去重：同一条消息不会在连续两次请求里重复注入

探针（临时插件，已删除）对 B 的 7 次 `context` 请求全部记录 `system` part：

```
B context requests: 7
--- t=1794869553767 injected= []
--- t=1794869594765 injected= []
--- t=1794869596627 injected= []
--- t=1794869675369 injected= []
--- t=1794869696997 injected= []
--- t=1794869698382 injected= []
```

即：投递正文本身就是 user turn，从未被再加一份 `[collab]` 摘要。

确定性验证（`/tmp/handoff-harness.mjs`，假 ctx、无模型调用，最终代码输出）：

```
--- S4 first request (message NOT in request)
[{"type":"text","text":"[collab] 待处理请求 1 条\n- request t_manual_0001 from=ses_bbb: 需要你复核 X → 处理后用 collab_reply {threadID:\"t_manual_0001\"}\n全文/状态用 collab_inbox。"}]

--- S5 second request (same message again)
[]

--- S6 message already in request (metadata cid)
[]

--- S7 message already in request (text fallback, no metadata)
[]

--- S12 request whose thread is answered
[]
```

去重两条路径都生效：`metadata.collab.cid`（事件入站时可精确匹配）与
`(kind, threadID, text)` 文本退化匹配（CLI 发来的消息没有 metadata）。

## 4. 只读 agent：可见 + 强制 queue

改 `opencode.json` 的 `agents.explore.permissions` 前，explore 会话自述工具集只有
`glob/grep/read/shell/skill/webfetch/websearch`（见 archive/2026-11/11-17-collab-verify）。
加 allow 后，探针记录的 explore 会话 `event.tools`：

```
agent= explore
tools= ['collab_inbox', 'collab_list', 'collab_reply', 'collab_send', 'collab_wait',
        'glob', 'grep', 'read', 'shell', 'skill', 'webfetch', 'websearch']
```

模型实际调用（explore 会话，原文）：

```
1) collab_inbox → [collab] 本会话还没有任何跨会话消息。
2) collab_send（传了 mode:"steer"）→
已投递 → ses_e19710a5affeU5fkGT3NCk5XUG  agent=build  state=idle  title="collab-handoff-B-build"
kind=request  thread=t_mwjv0lq3_oxsa  status=open
mode=queue(forced)  message=msg_1e69098fd0010bgLdhSg9EpxYt  delivery=queue
注: 只读 agent：已强制 queue（入队，不打断对方当前轮）。
```

## 5. 持久化：插件重载后未读与 thread 仍在

插件重载证据：`opencode.log` 里 `collab.js` 的 `loading plugin` 记录持续新增（本次改动期间多次重载），
且保存 `collab.js` 后工具集立刻出现新工具 `collab_reply`（Code Mode 目录更新）。

`collab.js` mtime = `2026-11-17 06:55:42`；B 的 inbox 写入时间 `06:52:31` / `06:54:45`；
重载后（06:56）与再次读取（06:57）内容完全一致：

```
BEFORE-RELOAD inbox:
[collab] 共 2 条，未读 0 条（显示最近 2 条）:
06:52:31  [request] thread=t_mwjuzlpt_jdl9  from=ses_e197…5XUG (...)  seen injected status=answered
    请回执 PONG-42
06:54:45  [request] thread=t_mwjv2gxu_frtn  from=ses_e197…ccyc (...)  seen injected status=open
    忙时投递测试：不要中断当前任务

AFTER-RELOAD inbox:
（逐字相同，含 thread 状态 answered/open）
```

**口径订正（实测）**：改 `~/.config/opencode/collab.json` **不会**触发插件重载——它不是 OpenCode 配置
文件；插件按 mtime 懒读它，本身也不需要重载。因此本项改为「插件文件变更触发重载后数据仍在」，
结论成立。`opencode service restart` 仍未验证（会打断并行会话）。

## 6. 清理

```
ses_e19710adaffe6zKIt0dnWaccyc → SessionNotFoundError / HTTP 404
ses_e19710a5affeU5fkGT3NCk5XUG → SessionNotFoundError / HTTP 404
ses_e19703779ffejouxjys0NxJ712 → SessionNotFoundError / HTTP 404
ses_e196ae5daffeWUBIjFiCEFs7fK  → SessionNotFoundError / HTTP 404
ses_e196ae582ffeO2VWnDXMkVc2yM  → SessionNotFoundError / HTTP 404
```

探针插件 `.opencode/plugins/collab-probe.js` 已删除；`~/.config/opencode/collab.json` 已复原
（`diff` 与备份一致，`maxInject` 回到 3）。

> 另有一个非本任务创建的会话 `ses_e196ba958ffe1sGISNNTRQsnaE`（title `collab-handoff-demo-B`，
> 创建于 06:57:23）——不在我的清单里，未删除。

## 7. 语法检查

```
$ node --check .opencode/plugins/collab.js
（无输出，exit 0）
```

## 8. 确定性回归（可复跑，无模型调用）

```
$ node .trellis/tasks/11-17-collab-handoff/research/handoff-harness.mjs
```

覆盖项与关键输出：

| 场景 | 结果 |
| --- | --- |
| S1 `confirm:false` | 只预览，`delivered prompts so far: 0` |
| S2 默认 mode | `prompt delivery=queue`，thread `status=open`，metadata 含 `cid/kind/threadID` |
| S3 explore + `mode:"steer"` | `mode=queue(forced)`，`prompt delivery=queue` |
| S4 首次注入（不在请求里） | `[collab] 待处理请求 1 条` + `→ 处理后用 collab_reply {threadID:"t_manual_0001"}` |
| S5 同一请求再来一次 | `[]`（不重复） |
| S6 消息已在请求里（metadata cid） | `[]` |
| S7 消息已在请求里（纯文本退化） | `[]` |
| S8 `collab_reply` | 对端由 thread 解析，`status=answered`，`delivery=queue` |
| S9 `collab_wait{threadID}` | 有回执 → 返回全文；无回执 → `等待回执超时：thread t_missing_0000 …` |
| S10/S13 `collab_inbox` | 全文 + `kind/thread/status/seen/injected` 标记 |
| S11 `kind:"reply"` 无 threadID | 降级为 request，附注「已按新请求处理」 |
| S12 thread 已 answered | `[]`（不再当待处理提醒） |
| S14 保护名单 / 自投 / 未知 thread / 非法 threadID | 四类均被拒绝并给出可读原因 |
| S15/S16 | `collab_list` 标记 `[self]/[protected]`；`collab_wait{target}` 保留 idle 语义 |
