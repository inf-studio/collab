# impl-notes：threads 聚合 + 状态降级（`11-19-collab-threads`）

## 1. 落盘文件与模块

| 文件 | 变更 |
| --- | --- |
| `src/core/thread-index.ts` | **新增**。索引的读 / 写 / 上限 / 7 天过滤 / 坏文件容错（`recordThread` / `threadEntry` / `threadsFor`） |
| `src/tools/threads.ts` | **新增**。`collab_threads { target, includeClosed? }`（只读） |
| `src/tools/status.ts` | 无广播记录时降级到「索引 + thread store」→ `kind=messages`；未知 thread 保留原文案 |
| `src/tools/shared.ts` | `dispatch` 成功投递后写索引（`collab_send` / `collab_reply` 的唯一写点） |
| `src/tools/handoff.ts` | 记录写完后把同一 thread 标 `kind:"handoff"` + `bid` |
| `src/tools/index.ts` | 注册 `collab_threads`（20 → 21，紧跟 `collab_status`） |
| `src/types.ts` | `ThreadIndexEntry` / `ThreadIndexRecord` / `ThreadIndexFile` |
| `src/constants.ts` | `THREAD_INDEX_FILE`（`COLLAB_THREAD_INDEX_FILE` 覆盖）/ `THREAD_INDEX_VERSION` / `_LIMIT`(500) / `_RETENTION_MS`(7d) / `_PREVIEW_CHARS`(80) / `THREADS_MAX`(20) / `THREADS_CLOSED_MAX`(3) / `THREAD_SUMMARY_CHARS`(120) / `THREAD_STATUS_MESSAGES`(5) |
| `test/handoff-harness.mjs` | `COLLAB_THREAD_INDEX_FILE` + **S102（18 条）**；S98 注册表断言 20 → 21 |
| `test/readonly-default.mjs` | 工具表 20 → 21（`collab_threads` 在 `collab_status` 之后）+ 索引路径进临时目录 |
| `docs/collab.md` | §11.2 标题与 `collab_threads` 行、`collab_status` 行补降级；§11.14 补「消息 thread 的降级」；**新增 §11.17** |
| `README.md` | 工具表 + `collab_threads` 行、`collab_status` 行、测试计数 805 → 823、结构行 |
| `skills/collab/SKILL.md` | description、工具表、「一点八·补：消息 thread 与聚合」 |
| `CHANGELOG.md` | Unreleased/0.7.0：Added 一条（`collab_threads` + 降级）、Tests（S102 + 变异）、Docs |

版本号未改（`package.json` / `PLUGIN_VERSION` / GUI 常量仍 0.6.0），无新依赖。

## 2. 索引样例（真跑里的文件内容）

写点只有两个（都在**投递成功**之后）：

- `shared.ts` `dispatch()`：`collab_send` / `collab_reply` 共用的投递路径 → `kind:"messages"`；
- `handoff.ts`：记录 `writeBroadcast` 之后 → 同一 thread 改标 `kind:"handoff"` + `bid`（`handoff` 是粘性的）。

```jsonc
// ~/.config/opencode/collab-threads.json（COLLAB_THREAD_INDEX_FILE 覆盖路径）
{
  "version": 1,
  "entries": {
    "t_mwn7fzis_3sc8": {
      "target": "ses_s102_peer",
      "kind": "handoff",
      "from": "ses_s102_me",
      "lastAt": 1795071870102,
      "preview": "S102 交接：把并行 thread 的清单整理成一张表",
      "bid": "b_3ec1f429c5579fb7"
    },
    "t_s102_m1": {
      "target": "ses_s102_peer",
      "kind": "messages",
      "from": "ses_s102_me",
      "lastAt": 1795071870108,
      "preview": "S102 消息 thread 1：请复核 A"
    }
  }
}
```

规则（实现即代码注释）：

- `target` / `from` = 这**两个参与者**，首次写入后固定（回复方向相反，两边都要能列出同一 thread；
  匹配 `target === sid || from === sid`）。`lastAt` / `preview` 每次投递更新；`kind:"handoff"` 不退回；
- 上限 500（按 `lastAt` 淘汰最旧，**只在写路径**）；读取时过滤 7 天（**不删文件**）；
- 坏文件 / 未知 `version` → 按空处理 + 一条日志（`ignoring unreadable …/collab-threads.json: …`）；
- 读-合并-写 + `tmp + rename`；写失败只记日志，不影响已经投递出去的消息。

## 3. 复现场景（1 handoff + 2 消息 thread；原始事故是 7 个）

原始事故：同一对会话并行 **7 个** thread（6 个是 `collab_send` / `collab_reply` 建立的消息 thread），
`collab_status { threadID }` 对其中 6 个直接报错。回归里用同形的 3 个 thread 复现（1 handoff + 2 messages）：

```text
--- S102 collab_threads
与 ses_s102_peer 的 thread 3 个（未闭环 3）：
- t_s102_m2  messages  open  15:04  out="S102 消息 thread 2：补充信息"  in=-  ← 建议继续
- t_s102_m1  messages  open  15:04  out="S102 消息 thread 1：请复核 A"  in=-
- t_mwn7fzis_3sc8  handoff  acked  15:04  out="S102 交接：把并行 thread 的清单整理成一张表"  in=-  bid=b_3ec1f429c5579fb7
建议: 先看 t_s102_m2（消息 thread，最近活动）→ collab_reply {threadID:"t_s102_m2", text:"…", confirm:true}；其它未闭环同理，别在同一 target 上再开新 thread。
只读查询：不写索引、不改 thread 状态、不投递；单条详情用 collab_status {threadID}。
```

`includeClosed:true`（对端回执后 `t_s102_m1` 变 `answered`）：

```text
与 ses_s102_peer 的 thread 3 个（未闭环 2，本次另列已闭环 ≤3）：
- t_s102_m2  messages  open  15:04  out="S102 消息 thread 2：补充信息"  in=-  ← 建议继续
- t_mwn7fzis_3sc8  handoff  acked  15:04  out="S102 交接：…"  in=-  bid=b_3ec1f429c5579fb7
- t_s102_m1  messages  answered  15:04  out="S102 消息 thread 1：请复核 A"  in="S102 回执：已复核 A"  （已闭环）
```

## 4. 降级输出（`collab_status { threadID: 消息 thread }`）

```text
thread t_s102_m2（kind=messages：由 collab_send / collab_reply 建立，没有广播记录）
target: ses_s102_peer  status=open  最近活动=15:04:30  消息 1 条
最近消息（最多 5 条，各 ≤120 字）:
  - 15:04:30 ses_s102…2_me → ses_s102…peer  "S102 消息 thread 2：补充信息"
下一步: 继续该 thread → collab_reply {threadID:"t_s102_m2", text:"…", confirm:true}；阻塞等回执 → collab_wait {threadID:"t_s102_m2"}
只读查询：不改状态、不释放租约、不投递；阻塞等待用 collab_wait，全量清单用 collab_list。
```

未知 thread 仍是原文案（逐字保留）：

```text
没有 thread t_s102x_ghost0 对应的交接单：threadID 可能拼错，或该 thread 由 collab_send / collab_reply 建立（没有广播记录）。可用 collab_inbox 核对 threadID。
```

坏索引（写入 `{ this is not json`）时：`collab_threads` 照常回答（索引按空）、`collab_status` 仍从 thread store
降级（`kind=messages` + 摘要），插件只打一条日志：

```text
[collab] ignoring unreadable /tmp/collab-harness-7Ttpt7/collab-threads.json: Expected property name or '}' in JSON at position 2 (line 1 column 3)
与 ses_s102_peer 的 thread 1 个（未闭环 1）：      # 只剩广播记录 join 出来的那条 handoff
```

## 5. 只读证明

严格宿主（`session.prompt|update|create|remove`、`storage.set|remove` 一旦调用即抛）+ 索引内容与
`size:mtime` + 广播目录快照，四个读命令（`collab_threads` ×2、`collab_status {threadID}` ×2）前后对比：

```text
✓ S102 read-only: four queries, zero write calls, index mtime+hash and broadcast dir unchanged — 0 write(s) / index identical
```

预览不写索引（同一条的 `size:mtime` 前后一致，且没有新 key）：

```text
✓ S102 a preview writes no index entry at all (0 writes, unchanged mtime/size) — 8882:1795071870110.9636 / 8882:1795071870110.9636
```

500 上限（先铺 500 条、再真投一条 → 501 取前 500，最旧 `lastAt` 被淘汰）：

```text
✓ S102 the index is capped at 500 entries on write (the oldest lastAt is evicted) — 500 entries / oldest kept=true / t_s102bulk_499 kept=false
```

## 6. 变异验证（原始输出，已还原）

### 变异 1：索引 key 写成 `bid`（`entries[bid] = entry`）

消息 thread 没有 `bid` → 全部写进空 key，读取时被丢弃 ⇒ 消息 thread 列不出。

```text
=== 815/823 checks passed
FAIL: S102 collab_handoff writes one index entry marked kind=handoff with its bid
FAIL: S102 collab_send writes one index entry per thread (kind=messages, target carried)
FAIL: S102 collab_threads lists every thread of the counterpart (1 handoff + 2 messages)
FAIL: S102 … with kind handoff/messages on the right rows, bid on the hand-off row
FAIL: S102 … and exactly one row is marked ← 建议继续 (the newest thread), named in the 建议 line
FAIL: S102 … the summaries are the sender's own words (in/out), capped, and it says it is read-only
FAIL: S102 an answered message thread leaves the default list and appears with includeClosed (marked 已闭环)
FAIL: S102 the index is capped at 500 entries on write (the oldest lastAt is evicted)
```

（另一种写法 `entries[bid || threadID]` 只打掉 2 条：handoff 那条按 bid 存，`t_…` 行消失 + 列表条数不对。）

### 变异 2：降级直接返回原错误（`if (false && (entry || thread))`）

`collab_status { threadID: 消息 thread }` 抛回原文案，harness 在 `call()` 处直接抛出并 `exit=1`：

```text
exit=1
ValidationError: 没有 thread t_s102_m2 对应的交接单：threadID 可能拼错，或该 thread 由 collab_send / collab_reply 建立（没有广播记录）。可用 collab_inbox 核对 threadID。
    at invalid (file:///…/dist/index.js:1596:9)
    at execute (file:///…/dist/index.js:9749:12)
    at async Object.execute (file:///…/dist/index.js:2330:13)
    at async call (file:///…/test/handoff-harness.mjs:710:4)
    at async file:///…/test/handoff-harness.mjs:10678:22
```

还原后（`grep -c MUTATION` = 0）复跑：

```text
=== 823/823 checks passed
=== 12/12 checks passed
=== 20/20 board checks passed
=== 50/50 checks passed
=== 49/49 checks passed
=== 47/47 checks passed
=== 17/17 panel checks passed
skills ok
```

## 7. 两个实现决策（偏离字面会踩坑）

1. **索引的 `target` / `from` 是「两个参与者」，首次写入固定**。第一版把 `target` 写成「本条消息的收件人」，
   于是对端回执后同一 thread 的 `target` 被翻成发起方 → 发起方那边反而列不出（S102 首跑就红了：
   `includeClosed` 少了 `t_s102_m1`）。现在 `threadsFor` 用 `target === sid || from === sid` 匹配，
   两个方向都能列出同一条 thread；`lastAt` / `preview` 仍然每次投递更新。
2. **`collab_handoff` 的正文带协议头**（`你是承接方（bid=… …）` + 两条回执命令 + 空行）。thread store 里存的是
   全文，所以 `collab_threads` 显示 `out=` 前把这段「管道」剥掉（`summarize()`，只在渲染层）；存储不动。
