# 设计：统一协作链路

## 1. 分层

```
入口   collab_handoff{scope:"local"}      collab_broadcast{scope:"peer"}      collab_accept{bid}
        └───────────────┬──────────────────────────┬──────────────────────────────┘
内核    匹配分 → 候选排序 → 问询/顺延 → 原子 claim → 状态机 → 回执解析
传输    local: thread（collab_send/reply/wait）   peer: 消息（collab_send → 发起方 sid）
存储    全局文件 ~/.config/opencode/collab-broadcast/（跨 location 可见）
```

不做「一个工具带所有参数」：`scope` 决定提案是否必需、传输方式、写权限，分开暴露可把非法组合挡在 schema 之外。

## 2. 数据契约

```jsonc
// ~/.config/opencode/collab-broadcast/<bid>.json
{
  "bid": "b_<hash16>",
  "scope": "local|peer",
  "workspace": "/abs/path",
  "issuePath": "docs/issues/fix-x.md",
  "title": "…",
  "expected": "implement|review",
  "affectedFiles": ["packages/state/src/machine/worker/store.ts"],
  "candidates": [{ "sid": "ses_…", "score": 87, "why": ["file:worker/store.ts", "title:worker"] }],
  "state": "open|claimed|acked|done|blocked|expired",
  "claim": { "by": "ses_…", "kind": "accept|spawn", "token": "…", "at": 0, "leaseMs": 300000 },
  "attempts": 0,
  "replies": [{ "from": "ses_…", "at": 0, "text": "…" }],
  "createdAt": 0,
  "updatedAt": 0
}
```

- `bid` 幂等：`hash(scope + workspace + issuePath + sha256(content) + mtime)`；
- 写入：写 `<bid>.json.tmp` 后 `rename`，禁止原地改写；
- 领取：`open(<bid>.lock, 'wx')`，失败即读取 `claim.by` 回「已被领取」。

## 3. 打分

```text
score = 45 * fileOverlapRatio
      + 25 * titleKeywordHit
      + 15 * sameTaskLine
      + 10 * agentMatch
      +  5 * recentActivity
      - 10 * (busyMinutes > 30)
```

- `fileOverlapRatio` = 提案影响文件中，被该会话在最近 200 条 / 7 天内触碰过的比例；
- `titleKeywordHit` = 提案模块词命中标题的比例；
- `sameTaskLine` = 标题含 Trellis task slug 或提案文件名主干；
- `recentActivity` = `now - time.updated <= 2h` 时线性衰减；
- 数据来源全部只读：`GET /api/session`、`GET /api/session/{id}/message`；
- 只从消息的 tool 调用里提取路径，不保留正文。

## 4. 状态机与租约

```
open ──claim(accept)──▶ claimed ──acked──▶ done
  │                        │
  │                        └──lease 过期──▶ open (attempts+1)
  │
  ├──no candidate ≥80 / all DECLINE──▶ claim(spawn) ──▶ claimed(kind=spawn) ──▶ done
  └──attempts > 3──▶ expired（升级给人）
```

- `attempts` 在每次 lease 过期或 DECLINE 顺延时 +1；
- 顺延时把当前候选移到 `skipped`，不重复询问；
- `expired` 只写状态，不重投。

## 5. 广播投递

| 步骤 | 做法 | 成本 |
| --- | --- | --- |
| 写广播 | 全局文件 | 0 |
| 对端可见 | 对端插件 `context` hook 读全局目录，命中本 workspace 的 `open` 广播 → 注入一行摘要 | 0 |
| 叫醒 | 仅 top-1 且 busy > 30min：补发 1 条 `queue` `prompt` | 1 轮 |

`context` hook 注入必须去重（按 `bid` 记 `acked`），且不影响既有 inbox 注入的三重过滤。

## 6. 拉新

- `POST /api/session`，body 必带 `location.directory`；
- 默认 `agent:"explore"`；`agent:"build"` 需要工具调用时显式传参 + `confirm:true`（每次确认，无白名单）；
- 标题 `impl:<slug>`；创建后立即投递接管请求（同一 `bid`，`claim.kind="spawn"`）；
- 不删除会话；`collab_list` 标 `[bootstrap]`。

## 7. 回执

- 接手方：`collab_send { target: "<发起方 sid>", text: "[handoff] DONE <路径> <sha>" }`；
- 发起方：既有 inbox 事件写入 + `context` 注入；解析器扫 `replies` 中的状态行，更新 `bid.state`；
- 解析失败（无状态行）→ 保持不变并记 `replies`，下次 `SessionStart` 一并展示。

## 8. 兼容与回滚

- 新工具是纯增量；`collab_send/reply/wait/list/inbox` 行为不变（单测回归保护）；
- 全局 shim 不影响项目带副本的工作区（muke-pos-app 仍只有项目副本 active）；
- 回滚：删除 `collab-broadcast/` 与新增工具注册即可，无数据迁移。

## 9. 风险

| 风险 | 处置 |
| --- | --- |
| 对端会话不跑 → 广播看不到 | 超时由 `SessionStart` 提醒发起方；不无限重投 |
| 打分误判（把活派错人） | 承接分（ACCEPT/DECLINE）兜底；`why` 可人工复核 |
| 并发领取 | 原子 `wx` 锁 + `attempts` 上限 |
| 读对端消息越界 | 只取路径、200 条/7 天、不落盘正文 |
| 跨仓误写 | 工具层硬校验：`peer` 只允许 `issuePath` 落在目标仓 `docs/issues/` |
