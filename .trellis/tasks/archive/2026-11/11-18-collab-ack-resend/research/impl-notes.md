# 实现记录：ack / 重发 / 闭环后追加（0.1.6）

> 口径以 11-18 两轮 owner 裁决为准：R1–R4 保持；R5 从「24h push 窗口」改为 **pull hint**，
> 再按评审 4 条硬化（结构字段 / 只认 claim.by / 路径校验 / 粒度 `(sid,bid,at)`）。
> 未提交、未打 tag、未发布。

## 1. 数据与常量

| 面 | 位置 | 说明 |
| --- | --- | --- |
| `BroadcastDelivery` | `src/types.ts` | `cid / to / messageId / admittedAt / failedAt / lastAttemptAt / seenAt / ackSentAt / ackSentBy / resends / unacked / ackUnavailable` |
| `BroadcastFollowUp` | `src/types.ts` | **只存结构**：`{ bid, issuePath, at, by }`（不含任何正文/cid） |
| 常量 | `src/constants.ts` | `ACK_SEEN_WINDOW_MS=2h`、`MAX_RESENDS=1`、`PLUGIN_VERSION=0.1.6`（`POST_DONE_FOLLOWUP_MS` 随 push 窗口一并删除） |
| 归一化 | `src/core/claim.ts` `normalizeBroadcast` | 新增 `normalizeDelivery()` + `followUps` 只保留结构化字段（旧记录无 `delivery` → `undefined` = 「已 admitted、无 ack 能力」） |
| 版本 | `package.json` | `0.1.6`（`PLUGIN_VERSION` 与 harness 断言一致） |

## 2. ack（R1 / R4）

- `src/core/ack.ts`（纯函数）：`buildAck(cid)`、`parseAck(text)`、`isAckText`、`deliveryOf`、
  `markSeen`、`resendDue`、`unackedDue`、`ackUnavailableFor`、`deliveryLine`、`deliveryVisible`、`ageLabel`。
- **发方记录**：`deliverAsk`（spawn / 叫醒 / 重发）与 `dispatch`（`collab_send` / `collab_reply` /
  `collab_handoff`）都写 `delivery`；`broadcast` 建档时即写 `{cid, to, admittedAt}`（idle 目标的
  接管请求走注入，没有 prompt 也必须有 cid 才能 ack）；`handoff` 用 `dispatch` 返回的
  `delivery{ cid, to, messageId, admittedAt }`。
- **收方回 ack**：`chain.ackSeen(sid, cids)`，由三处触发 —— `hooks/context.ts`（本次请求被看见的
  消息，注入前先 `acknowledge(shown)` 再算 cids）、`tools/inbox.ts`（`collab_inbox` 返回的条目）、
  `chain.injectionFor`（接管请求注入后）。一次性：`delivery.seenAt || ackSentAt` 直接跳过；
  受保护发起方 → `ackUnavailable` 且下一次直接跳过（不重复写盘）。
- **发方解析**：`index.ts` 事件流里 `chain.applyAck(text, from)`；只认 `delivery.to === from`，
  伪造 ack 被忽略；只写第一次 `seenAt`。
- **防环/降噪**：`[ack]` 不进 `context` 注入（`injectInbox` 直接 accounted），`collab_inbox` 标
  `system-ack`，`isAckText` 阻止 ack 再 ack。
- **R4**：`pull` 记录（受保护发起方）建档即 `ackUnavailable`；`ackSeen` 发现发起方受保护时也只
  打标、不投递、不报错。

## 3. 重发（R2）

`chain.resendIfDue(record, now, actor)`（只在**发方**的 `context` 注入里跑，且在 workspace 过滤**之前**，
否则 peer 单永远到不了）：

```
resendDue: cid+to && !seenAt && !ackUnavailable && resends < 1
           && (admittedAt ? now-admittedAt > 2h : Boolean(failedAt))
resendOnce: 目标受保护 → ackUnavailable；目标非 idle → 只等（不写、不计数）
            成功 → resends+1、admittedAt(!) 补齐、messageId 更新、lastAttemptAt=now
            失败 → resends+1、unacked=true
unackedDue: resends>=1 && now-lastAttemptAt > 2h → delivery.unacked=true（collab_list 单列「可人工补投」）
```

同 `cid` 复用（收方按 cid 去重，harness S84b 验证只落一条 inbox）。

## 4. 闭环后追加（R5，pull hint）

- **新工具** `collab_followup { bid, issuePath?, confirm }`（`src/tools/followup.ts`）：
  只认 `record.claim.by`（发起方/旁观者一律拒绝）；只认 `done|blocked`（`expired` 拒绝并提示
  直接写提案文件）；每单 ≤3 条；只写 `followUps[]`，**不投递、不改 state/receipt、不重开 bid**。
- **路径校验** `src/core/followup.ts`：`sanitizePathText`（控制字符/换行 → 空格、≤200 字）+
  `validateIssuePath`（非绝对、无 `..`/`.`、`docs/issues/<name>.md`、`statSync` 是文件、
  `lstatSync` 非软链、`realpathSync` 仍在该 workspace 的 `docs/issues/` 内）。写入时拒绝并给原因；
  **渲染时再校验一次**，失败整行不渲染（无降级拼接）。
- **提示注入**：`chain.followUpHints(sid)` 只在 `record.from.sid === sid`、`state ∈ done|blocked`、
  有 `followUps` 时工作；取最旧的一条未提示条目（`(sid,bid,at)` 去重，存
  `ctx.storage['collab/followup-seen/<sid>']`，上限 200 条），每次请求 **≤1 行**；行内容只有
  `- b_xxx 已闭环，提案 <path> 有追加结论（HH:MM:SS），请读取文件`。
- **protect 白名单**：`injectionFor` 先算 `hints`，若该会话在 protect 线则**直接返回 hints**
  （不 refresh、不写任何记录、不出现别的内容）；非受保护会话把 hints 追加在常规提醒之后。
  —— 没有「`if (protected) allow`」的通用宽口子。

## 5. 可见性（R3）

- `collab_list`：每条未闭环记录同一行追加 `admitted= seen= queue-age= resend= unacked=`
  （`deliveryVisible`），`unacked` 记录另起一段「未确认送达 … → 可人工补投」。
- `collab_wait`：`deliveryStatus({threadID|target})` 追加「交付状态」小节（只读快照，不 refresh）。
- 旧行为不变：`collab_list` 仍然不改状态、不删锁。

## 6. 兼容

| 面 | 处理 |
| --- | --- |
| ≤0.1.5 记录 | 无 `delivery` → 不 ack、不重发、不显示 `seen` |
| 旧收方不认 `[ack]` | 发方只是收不到 `seen`；不影响投递 |
| `canReplyToProtected` | **保持 0.1.4 语义**（done/blocked/expired 一律拒），没有 push 窗口 |
| `followUps` 旧数据（若有 `text`/`from`） | `normalizeBroadcast` 只保留 `{bid,issuePath,at,by}`，正文丢弃 |
| 数据迁移 | 无；回滚 = 删 `delivery`/`followUps` 读取 + `core/ack.ts` / `core/followup.ts` / 工具注册 |

## 7. 回归

- 新增 **S83**（15 项）/ **S84**（10 项）/ **S85**（26 项），与既有 405 项合计 **456 项**；只读默认 **12 项**。
- 顺手修了 S72 的 `staleClass` 边界用例（显式传时钟，原来 1ms 抖动会偶发失败）。
- 断言覆盖：ack admitted/seen、独立 ack cid、one-per-cid、伪造 ack 无效、busy 不误判不重发、
  受保护 ackUnavailable 且零投递、重发一次/同 cid 只落一条/预算用尽/admission 失败立即重试/`unacked` 可见、
  追加的 claim.by 权限与 done 约束、结构化字段（无正文）、state/receipt 不变、
  受保护发起方一次性只读提示、两条追加两次提示、非法路径（`..`/绝对/越界/缺失/软链/非 md/自由文本）
  拒绝且不渲染、第 4 条拒绝、闭环后 `kind:reply`/`note` 仍不可 push。

## 8. 命令结果

```
pnpm build      ✔
pnpm typecheck  ✔
pnpm test       ✔ (456/456 harness + 12/12 readonly)
check:skill     ✔
```

## 9. 遗留 / 需要 owner 决策

1. `implement.md` 里 `collab_followup { bid, text, confirm }` 的 `text` 被评审否掉（不存正文），
   实际签名为 `{ bid, issuePath?, confirm }`。文档已按实际实现写。
2. 版本发布（tag / CI / 全局升级 / `opencode reload` 实测）不在本次范围（未 git 写）。
3. 已知观测：`collab_handoff`（local）建档用 `ctx.location.directory` 作为 `workspace`，
   与调用方会话所在目录无关；`collab_list {directory}` 因此看不到跨目录的 local 单（既有行为，未改）。
4. **`README.md` 未改**（不在本次允许清单内），但它现在有两处过时，建议主会话补：
   - L3「十一个原生 `collab_*` 工具」→「十二个」；
   - L28 工具表缺 `collab_followup` 一行（建议插在 `collab_promote` 与 `collab_report` 之间）：
     `| collab_followup | 闭环后追加：只登记结构指针（提案路径 + 时间），不投递、不改状态 | 写交接记录 |`
   - L126「`src/tools`（十一个工具）」→「十二个」，`src/core` 可补「送达 ack / 闭环后追加」。
   `package.json` 的 description 已同步（在允许清单内）。

## 10. 复核修复（review round 2）

### F1（真 bug，已修）`ackSeen` 在 `await prompt` 后写回旧快照

- 现象：`ackSeen` 用**进入循环前**的 `record` 快照整条写回；若发方 `applyAck` 在这段 await 期间写入
  `seenAt`，会被覆盖（`ackSentAt/ackSentBy` 在、`seenAt` 丢）→ 2h 后多余重发 → 再 2h 变 `unacked`。
- 修法：`src/core/claim.ts` 新增 `mergeDelivery(bid, patch)` —— **先重读**当前记录，只合并
  `delivery` 里本次要写的字段，其它并发写入（`state`/`receipt`/`followUps`/`claim`）原样保留；
  记录已被 7 天保留策略删除时**不复活**（返回 `undefined`，调用方回落到内存记录）。
- 应用点（同类 bug 一并修，因为它同样是「await 后写旧快照」）：
  - `chain.ackSeen`：成功分支（`ackSentAt/ackSentBy`）与 `ackUnavailable` 分支；
  - `chain.resendOnce`：成功 / 失败 / 目标受保护三个分支；
  - `chain.resendIfDue`：`unacked` 打标；
  - `tools/shared.ts` `deliverAsk`：成功 / 失败分支；
  - `chain.injectionFor`：`askSeen`/`seenBy`/`reminded` 三处「按会话打标」的写回（它们同样发生在
    `resendIfDue` 的 await 之后，同样先重读再合并）。
  同时删掉 `core/ack.ts` 的 `ackUnavailableFor(record, reason)`——它本身就是「快照整条写」的坏形状。
- 回归：S83g（3 项断言）在 `prompt` 实现里**同步写入 `seenAt`** 复现竞态：
  修复后 `seenAt` 与 `ackSentAt` 并存、`state/claim` 不变、之后永不重发。
  已验证该用例在旧代码上**确定性失败**（`seenAt` 缺失），修复后通过。

### F2（文档）受保护会话的注入语义

- `docs/collab.md` §11.4.1 的提示改为：`injectionFor` 的**外部**提醒对受保护会话白名单化
  （仅 followUps 只读行）；`injectStale` 是**本地**「与本人相关的挂起记录」提醒
  （`involves`：本人发起/领取/被问询），不含他人正文、不含指令，因此照常生效。
- 代码未改（`staleFor` 确实只处理 `involves(record, sessionID)`）。

### 计数与证据

- `README.md`：`375 项 harness` → **456**；补 0.1.6 的 S83–S85 覆盖说明；
  `collab_followup` 行改为「只写 `{bid,issuePath,at,by}`，提案文件由调用方自己写」（避免误读为本工具写文件）。
- `docs/collab.md` §11.1：补 `opencode reload` 的实测证据（0.1.5：`plugin add` + `reload` 后，
  已运行会话里 `collab_report {confirm:false}` 预览显示「版本: 0.1.5」）。

### 复核轮验收

```
pnpm build ✔ / pnpm typecheck ✔ / pnpm test ✔ (456 harness + 12 readonly) / check:skill ✔
```
