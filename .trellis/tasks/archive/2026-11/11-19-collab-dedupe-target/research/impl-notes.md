# 实现记录：跨 thread 去重（target 维度）

任务：`.trellis/tasks/11-19-collab-dedupe-target`（0.7.0 子任务，版本号不改）
实现文件：`src/tools/shared.ts` / `src/tools/send.ts` / `src/tools/reply.ts` / `src/types.ts` /
`test/handoff-harness.mjs` / `docs/collab.md` / `README.md` / `skills/collab/SKILL.md` / `CHANGELOG.md`

## 1. 改了什么

| 位置 | 改动 |
| --- | --- |
| `src/tools/shared.ts` | 新增进程内 `targetSendMemo`（`targetSid + '\n' + 归一化正文` → `{at, threadID, bid?}`，上限复用 `DEDUPE_MEMO_LIMIT`）+ `targetSendKey` / `rememberTargetSend`；`findDuplicateSend` 增 `target?` 入参与第 ④ 级判据（返回 `source:"target"` + 原 `threadID` / `bid`）；`dispatch` 增 `force?: boolean`，去重查询前移到护栏之前（但拒绝优先，见 §5），投递后写 target 索引 + `force` 时写 `dedupeOverriddenAt` |
| `src/tools/send.ts` / `reply.ts` | 入参 `force?: boolean`；两处 `dispatch` 调用透传 `input.force === true`；工具描述改成「同一 body / 同一 thread **或** 已发到同一 target 会话」+ `force:true` |
| `src/types.ts` | `BroadcastRecord.dedupeOverriddenAt?: number`（只读标注） |
| `test/handoff-harness.mjs` | 新增 S101 段（17 条断言） |
| 文档 | `docs/collab.md` §11.9.4 重写 + §11.2 两个工具行 + §11.4 配置段；`README.md` 正文 / 配置表；`skills/collab/SKILL.md` 工具表 + 去重小节；`CHANGELOG.md` 0.7.0 Unreleased |

复用而非新造：thread 级判据（record replies / thread 消息尾 20 条 / thread memo）原样保留，target 级只在
它们都未命中时才查，因此**同 thread 同文的回执文案逐字不变**（S95 全绿）。

## 2. 3 thread 实测（S101a，真实投递回放）

同一 target（`ses_bbb`）的 3 个 thread（`t_s101_a` / `t_s101_b` / `t_s101_c`）发同一句正文，<60s：

```
--- S101a three threads, one body
已投递 → ses_bbb  agent=explore  state=busy  title="B"
未重复投递: 目标 ses_bbb 在 60s 内已有同文（target 维度去重），已在 thread t_s101_a 发过同文；本次未投递、也未追加回复。
未重复投递: 目标 ses_bbb 在 60s 内已有同文（target 维度去重），已在 thread t_s101_a 发过同文；本次未投递、也未追加回复。
  ✓ S101 same target + same body on 3 threads (<60s) is delivered exactly once — 1 deliveries
  ✓ S101 … and both repeats say where the earlier copy went (已在 thread … 发过同文)
  ✓ S101 … the repeat receipt offers the override (force:true) and marks it target-level
      — 未重复投递: … | 目标: ses_bbb … | kind=note  本次 thread=t_s101_c  命中来源=target  上次=t_s101_a @ 14:40:34
  ✓ S101 … and the suppressed sends created no thread record (nothing was appended) — false / false
```

一次投递；后两次既不投递也不写 thread（`store.get('collab/threads/t_s101_b|c')` 均为空）。

`collab_reply` 同口径（S101k：两条 thread 同一句回执，第 2 条被拦、`force:true` 放行）：

```
--- S101k reply across threads
已投递 → ses_aaa  agent=build  state=busy  title="A"
未重复投递: 目标 ses_aaa 在 60s 内已有同文（target 维度去重），已在 thread t_s101_re1 发过同文；本次未投递、也未追加回复。
已投递 → ses_aaa  agent=build  state=busy  title="A"
```

## 3. `force:true` 前后（S101b / S101c-d）

同一正文第二次、第三次调用带 `force:true`：

```
--- S101b force
已投递 → ses_bbb  …
已投递 → ses_bbb  …
已投递 → ses_bbb  …
  ✓ S101 force:true delivers every repeat (3 deliveries, none suppressed) — 3 deliveries
  ✓ S101 … every forced receipt carries dedupeOverridden (never a silent override)
      — 注: dedupeOverridden: 本次为 force:true 强制投递（去重窗口内已有同文仍发送；thread 与 target 两级判定都跳过）。
```

带 `bid` 时只写标注、不动状态：

```
  ✓ S101 force + bid stamps dedupeOverriddenAt on the record (display-only marker)
      — dedupeOverriddenAt=1795070434858
  ✓ S101 … while state / claim / receipt stay exactly as they were
      — {"state":"acked","claim":{"by":"ses_bbb","kind":"accept","at":1,"token":"k_s101"}}
```

命中（不带 force）时**零写入**：

```
  ✓ S101 a target-level hit writes nothing at all: no prompt, no thread, no record change
      — 1 delivery / record unchanged
```

## 4. 窗口边界（S101e：`Date.now` 前跳，不真等 61s）

```
--- S101e window
59s: 未重复投递: 目标 ses_bbb 在 60s 内已有同文（target 维度去重），已在 thread t_s101_w0 发过同文；…
61s: 已投递 → ses_bbb  …
  ✓ S101 59s later the same body is still suppressed (inside the window) — 1 deliveries
  ✓ S101 61s later the same body is deliverable again (outside the window) — 2 deliveries
```

其余：不同 target 同文都投（S101f）；`confirm:false` 预览不查不消耗窗口（S101g）；同 thread 仍是
0.6.0 文案（S101h）；`dedupeWindowMs:0` 两投（S101i）。

## 5. 与 `protect` 护栏的先后（设计偏差，已按「拒绝优先」落地）

design §5 与任务书写「去重先于护栏判定」。字面实现会让**受保护目标**在「同一句以前发过」时把
`fail-closed` 错误换成一条投递历史提示——实测直接打红既有断言：

```
FAIL: S81 an explicit `bid` without a [handoff] body is not a legacy receipt
```

（S69 曾把同一句 `已收到，按提案完成` 合法投进同一受保护发起方，S81 期望这次仍被拒。）

最终顺序：**先做只读去重查询 → 再过护栏 → 拒绝优先 → 未拒绝才用去重结果**。效果：
- 命中且可投（非保护 / 限界回执）→ 不投递、不产生队列项、回执写「已在 thread … 发过」（满足「命中即不投」）；
- 命中但目标不可投 → 照旧护栏错误（边界一点没放宽，S81 / S69 全部原样通过）；
- 首次就被拒的投递从不写索引，所以第二次仍是拒绝而不是「重复」。

## 6. 变异（原始输出）

变异 ①：target 索引改用**当前 threadID** 作键（`targetSendKey(thread, text)`）。

```
=== 797/805 checks passed
FAIL: S101 same target + same body on 3 threads (<60s) is delivered exactly once
FAIL: S101 … and both repeats say where the earlier copy went (已在 thread … 发过同文)
FAIL: S101 … the repeat receipt offers the override (force:true) and marks it target-level
FAIL: S101 … and the suppressed sends created no thread record (nothing was appended)
FAIL: S101 a target-level hit writes nothing at all: no prompt, no thread, no record change
FAIL: S101 59s later the same body is still suppressed (inside the window)
FAIL: S101 61s later the same body is deliverable again (outside the window)
FAIL: S101 collab_reply is target-deduped across threads, then force delivers it
```

变异 ②：去掉 `force` 分支（`if (confirmed && dedupeWindowMs > 0)`）。

```
=== 802/805 checks passed
FAIL: S101 force:true delivers every repeat (3 deliveries, none suppressed)
FAIL: S101 force + bid stamps dedupeOverriddenAt on the record (display-only marker)
FAIL: S101 collab_reply is target-deduped across threads, then force delivers it
```

两次变异后均还原源码并重建，最终：

```
=== 805/805 checks passed
=== 12/12 checks passed
=== 20/20 board checks passed
=== 50/50 checks passed
=== 49/49 checks passed
=== 47/47 checks passed
=== 17/17 panel checks passed
✓ skills ok
$ tsc --noEmit            (无输出 = 通过)
```

工具数仍 20（S98 断言 `tools.length === 20`），版本号未改（`package.json` / `PLUGIN_VERSION` 仍 0.6.0，
0.7.0 由父任务统一发）。

## 7. 回滚

- 代码：`git restore -- src/tools/shared.ts src/tools/send.ts src/tools/reply.ts src/types.ts`；
- 运行时：`collab.json` 设 `dedupeWindowMs: 0` → 两级判定一起关闭（已被 S101i 覆盖）；
- 只想去掉 target 维度：删 `findDuplicateSend` 的第 ④ 段（thread 级行为与 0.6.0 完全一致）。

## 8. 一句话汇报

60s 同文幂等从「同 thread」扩到「同 target 会话」：一条结论发到同一会话的 3 个 thread 现在只投 1 次，
后两次回执写明「已在 thread `t_…` 发过同文」并给出 `force:true`；`force` 照发并标 `dedupeOverridden`
（带 `bid` 时记录写 `dedupeOverriddenAt`，`state/claim/receipt` 不动），命中时零写入，`protect` 拒绝
仍然优先、边界未放宽；S101 17 条新断言 + 两组变异验证，回归 805 / 12 / 20 / 50 / 49 / 47 / 17 全绿，
工具仍 20、版本不变。
