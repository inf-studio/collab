# 设计：2min 批量投递 + 无增量不发（0.9.6）

## 1. 边界

只改投递时机与合并策略；不改消息语义、不改闸门、不改存储格式。

## 2. 模块

| 文件 | 职责 |
|---|---|
| `src/core/pacing.ts`（新） | 窗口缓冲、合并、去重、到期 flush |
| `src/core/delta.ts`（新） | 判断"本轮是否有状态增量" |
| `src/core/dispatch.ts` | 投递前经过 pacing；`escalate`/`blocked` 直通 |
| `src/tools/{send,reply,broadcast}.ts` | 传入 `kind`，由 dispatch 决定是否进窗口 |
| `src/config.ts` | `windowMs`（默认 120000）、`directKinds` |

## 3. 窗口

```
send/reply(non-urgent) → buffer[target].items.push(item)
                        setTimeout(flush, windowMs)   // 首个 item 起算
flush → 合并为 1 条 envelope（items[]）→ 原投递路径
```

- 合并规则：同 `threadId` 的连续回复合并；不同 thread 保留为多个 `item`；
- 窗口内同 `threadId + factId` 去重（保留最后一条）；
- **到期兜底**：每次 `context` 钩子先扫过期窗口并 flush（进程休眠/重启后补投）。

## 4. 直通

| 条件 | 行为 |
|---|---|
| `kind='escalate'` | 立即投递（<10s） |
| 消息带 `status='blocked'` | 立即投递 |
| `to` 为 protected 会话 | 直通（不排队，避免护栏失效） |
| 其它 | 进窗口 |

## 5. 无增量不发

`delta.ts` 计算与"上次已投递状态"的差异：

```ts
delta = {
  hasNewFact: factsEpoch > lastSent.factsEpoch,
  hasStatusChange: todoStatusHash != lastSent.todoStatusHash,
  hasEvidence: 本轮有 progress/decision 变更,
  hasAnswer: 本条是对未答问题的回答
}
```

全部为 false → **不产生消息**，只写 `collab_status`（`lastNoopAt`），下一次注入头更新计数。
配置 `suppressNoDelta`（默认 true）可关。

## 6. 时效

- 承诺 ≤5min（D11）：`windowMs=120s` + 投递/处理 ≤180s；
- 超出承诺（如 recepient 忙）→ 记 `metrics.lateCount`，不重发。

## 7. 指标

每日落 `metrics`：

| 字段 | 含义 |
|---|---|
| `median_gap_ms` | 当天相邻消息间隔中位数 |
| `msg_count` | 当天消息数 |
| `noop_count` | 被抑制的"无增量"次数 |
| `late_count` | 超 5min 投递次数 |

## 8. 测试

| 用例 | 断言 |
|---|---|
| 10 条非紧急连发 | 收端 1 条合并消息，items=10 |
| escalate | <10s 送达，不进窗口 |
| blocked | 直通 |
| 同 thread+factId ×3 | 合并为 1 |
| 无增量 | 不产生消息，status 更新 |
| 过期窗口 | 下一轮 context 钩子补投 |
| protected | 直通 |
| 回放 624 条 | p50 ≥ 120s；总量下降 ≥5× |
| 指标 | `metrics` 四字段落库 |

变异：`windowMs=0` → 「10 条合并为 1」必红。

## 9. 回滚

```bash
git restore -- src/core/dispatch.ts src/tools/send.ts src/tools/reply.ts src/tools/broadcast.ts src/config.ts
rm -f src/core/pacing.ts src/core/delta.ts
```
