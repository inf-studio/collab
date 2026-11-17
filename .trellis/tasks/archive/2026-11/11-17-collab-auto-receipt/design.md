# 设计：强制回执 + 到期自动提取

## 1. 接管请求文案（R1）

注入/投递的请求体改为三段式：

```
[collab-handoff] <提案标题>
提案：<issuePath>（workspace=<ws>，bid=<bid>）
影响面：<files>
期望：<implement|review>

完成后请按顺序做两件事（不要省略）：
1) 领取：collab_accept { bid: "<bid>", confirm: true }
2) 回执：collab_send { target: "<发起方完整 sid>", text: "[handoff] DONE <bid> <摘要>", confirm: true }
   若无法实施：text: "[handoff] BLOCKED <bid> <原因>"
```

- 两处 `ses_…` 必须是完整 id（R1-2 已具备）；
- 文案里同时写明「仅分析不动作 = 未完成」，降低「答完就算」的概率。

## 2. 到期自动提取（R2）

```
refresh(record) →
  if state=claimed && now - claim.at > leaseMs:
      if claim.kind == "spawn" && record.from?.sid:
          verdict = extractVerdict(claim.by)      # 只读，失败返回 undefined
          if verdict:
              record.receipt = { by: claim.by, at: now, note: verdict.summary, auto: true }
              record.state = verdict.state         # "done" | "blocked"
              return record                        # 不拉新、不 attempts++
      # 否则沿用既有：state=open, attempts++, skipped+=claim.by, 释放锁
```

`extractVerdict(sessionID)`：

- `GET /api/session/{sid}/message?limit=10&order=asc`（只读）；
- 取最后一条 `assistant` 的 text 段；
- 命中规则（按序）：`\[handoff\]\s*(DONE|BLOCKED)` → 直接采用；否则关键词
  `已实施|已修复|无需|不需要|已完成|not needed|already` → `blocked`，`完成|done|fixed` → `done`；
- 摘要：去空白、截断 200 字；只存摘要，不存全文；
- 会话不存在 / 无 assistant / 超时 → 返回 `undefined`（走原逻辑）。

## 3. 触发点

- 只在**读路径的租约刷新**处调用（`persistRefresh` / `refreshBroadcast`），以及 `collab_accept` 的刷新；
- 不做后台轮询；不超过 1 次消息读取/记录/刷新。

## 4. 兼容与风险

| 风险 | 处置 |
| --- | --- |
| 误判（把「完成了…分析」当 DONE） | 只认显式 `[handoff]` 前缀或强关键词；不确定就不闭环 |
| 会话已删 | 捕获 404 → undefined，走原逻辑 |
| 隐私 | 只存 ≤200 字摘要 + sid；不落盘正文 |
| 重复提取 | 记录 `auto:true` 后状态已终态，不再刷新 |

## 5. 回滚

仅在 `collab.js` 内新增一个函数与两处调用，`git restore` 即可；无数据迁移。
