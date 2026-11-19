# 设计：BLOCKED 结构化字段

## 1. 数据

```ts
interface BroadcastBlocked {
  excluded: string[];      // ≤20 条，每条 ≤120 字：已经排除的方向
  minimalTest: string;     // ≤200 字：让对端一次就能判别的最小实验/判别式
  need: string[];          // ≤10 条，每条 ≤120 字：需要对方提供什么
  at: number; by: string;
}
BroadcastRecord.blocked?: BroadcastBlocked[];   // 保留最近 3 次
```

## 2. 入参与校验

- `collab_send` / `collab_handoff` 增可选 `blocked`；字段缺失 = 行为不变（逐字）；
- 超长/超条数 → **可读拒绝**（不静默截断）；控制字符剥离；
- 有可解析的 `bid`（入参或正文）→ 写入记录（保留最近 3 次）；无 → 仍渲染进投递正文，回执注明「未关联单据，未落库」。

## 3. 渲染

- 投递正文追加块（在正文之后、协议头之前）：

```
需要对方：① … ② …
已排除：…
最小判别：…
```

- 接收方注入与 `collab_status` 都聚合展示这三行（最多各 3 条 + 「还有 N 条」）；
- 最近 3 次历史：`collab_status` 只展示最新一次 + 「历史 N 次」。

## 4. 兼容与安全

- 不传 `blocked`：输出与 0.7.0 之前逐字一致；
- 纯展示字段：不改 `state/claim/receipt`；不因 `blocked` 放宽任何护栏；
- `blocked` 只在 BLOCKED 语义下使用，工具不强制 kind（但文档建议与 `[handoff] BLOCKED` 同行）。

## 5. 测试

| 用例 | 期望 |
| --- | --- |
| 带 blocked 的 BLOCKED 投递 | 正文含三段；接收注入含三段；status 同 |
| 不传 blocked | 输出与旧版逐字一致 |
| 超条数/超长 | 可读拒绝、0 写入 |
| 无 bid | 正文仍含三段，回执注明未落库 |
| 连续 3 次 | 记录保留最近 3 次；status 展示最新 + 历史计数 |
| 状态不变 | `state/claim/receipt` 前后一致 |

变异：渲染丢 `minimalTest` → 断言失败；无 bid 分支也写记录 → 断言失败。

## 6. 回滚

`git restore -- src/tools/{send,handoff,status}.ts src/types.ts`；旧记录无 `blocked` 字段。
