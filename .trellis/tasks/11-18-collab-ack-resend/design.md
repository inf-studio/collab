# 设计：ack / 重发 / 24h 追加窗口

## 1. 数据

```ts
// BroadcastRecord 新增（只增）
delivery?: {
  messageId?: string;      // admission 回执
  admittedAt?: number;
  seenAt?: number;         // 收方首次读到
  resends?: number;        // 0..1
  unacked?: boolean;
  ackUnavailable?: boolean; // 目标是受保护发起方（或自己受保护）
};
followUps?: Array<{ from: string; at: number; text: string; cid: string }>;
```

常量：`ACK_SEEN_WINDOW_MS = 2h`、`POST_DONE_FOLLOWUP_MS = 24h`、`MAX_RESENDS = 1`。

## 2. ack 协议

| 消息 | 方向 | 说明 |
| --- | --- | --- |
| `[ack] <cid> seen` | 收方 → 发方（`note`, `queue`） | 收方首次注入/`collab_inbox` 读到该 cid 时发送 |
| 解析 | 发方插件事件流 | 命中 `[ack] <cid>` → `record.delivery.seenAt = now` |

- **防环**：`[ack]` 消息本身不产生 ack（`kind=note` + prefix 判定）。
- **受保护**：若发方在 protect 内，ack 发不出去 → 记 `ackUnavailable`，不再尝试。
- 发送 ack 失败不影响收方流程（旁路 + try/catch）。

## 3. 重发

触发（发方侧 `refresh`/context）：

```
delivery.admittedAt && !seenAt && resends < MAX_RESENDS
&& now - admittedAt > ACK_SEEN_WINDOW_MS
&& target 当前 idle
&& !ackUnavailable
→ 重新 prompt（同 cid 的 metadata），resends++
```

- **busy 永不重发**（只等）；
- 同 cid 幂等：收方 `extractInbound` 已有 cid 去重，不会重复注入；
- 重发失败 → `unacked=true`，`collab_list` 标注。

## 4. 闭环后追加（pull hint，取代 push 窗口）

- 新入口：`collab_followup { bid, text, confirm }`（或 `collab_send` 的 `followUp` 形态）：
  **仅本单领取人**可调，且 `record.state ∈ done/blocked`；只追加 `followUps[]`，不投递、不改 state/receipt。
- 追加内容同时要求写入提案文件（调用方自行落笔；记录只存摘要 ≤500 字）。
- 受保护发起方的 `injectionFor` 现有 `protect → []` 规则**窄化放开**：
  仅当 `record.from.sid === me` 且 `followUps.length > 0` 且该条**尚未提示过**（`followUpsSeenAt`）时，
  注入一行只读提示（文件路径 + 时间），**不含正文、不含指令**。
- 非受保护发起方：同一提示走常规 context 注入（一次）。

### 4.1 硬化（评审 4 条，必须满足）

| # | 约束 |
| --- | --- |
| H1 | `followUps[]` **只存结构化字段** `{bid, issuePath, at, by}`，**不存正文**；提示行只渲染 `path @ <ts>`；path 去换行/控制字符、长度 ≤200 |
| H2 | 只有该 bid 的 `claim.by` 可 append；发起方与旁观会话一律拒绝 |
| H3 | `issuePath` 必须 `realpath` 落在 `record.workspace` 内且匹配 `docs/issues/*.md`；拒绝 `..`/绝对路径/软链；校验失败整行不渲染 |
| H4 | 去重粒度 `(sid, bid, followUp.at)`；每 bid ≤3 条；每会话每次注入 ≤1 行 |
| H5 | protect 的窄化必须是**显式白名单**（仅 `sid === record.from.sid` 且有未提示 followUps），禁止通用 `if (protected) allow` |

## 5. 可见性

`collab_list` 每条未闭环/窗口内记录追加：

```
delivered=0.5h seen=0.4h resend=0 unacked=-
```

`unacked` 的记录单独一行提示「可人工补投」。

## 6. 兼容与回滚

| 面 | 处理 |
| --- | --- |
| 旧记录 | 无 `delivery` 字段 → 视为「已 admitted、无 ack 能力」，不重发 |
| 旧收方 | 不认 `[ack]` → 发方只是收不到 seen，不影响投递 |
| 保护 | 窗口只在 done 后 24h、三条件内；`note/steer` 永不通过 |
| 回滚 | 删 `delivery`/`followUps` 读取与 ack 模块即可；数据无迁移 |

## 7. 风险

- ack 消息可能被当普通 note 展示 → prefix 明确 + `collab_inbox` 标注为系统 ack；
- 重发对 busy 目标禁止，避免长任务队列膨胀（数据：单轮可达数十分钟）；
- 窗口扩大攻击面 → 行首锚定 + 三条件 + 回声守卫 + 24h 截止。
