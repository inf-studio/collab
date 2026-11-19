# PRD：BLOCKED 结构化

## 问题

真正推动进展的是 BLOCKED 正文里的一句「做一次最小判别实验」，接收方要读长文才能提炼；B 还要复述给 A。

## 需求

- **R1 字段**：`collab_send` / `collab_handoff` 可选 `blocked: { excluded: string[], minimalTest: string, need: string[] }`；`excluded` ≤20 条、`need` ≤10 条、`minimalTest` ≤200 字。
- **R2 存储**：写进记录 `blocked`（追加上限 3 次，保留最近）；正文仍自由。
- **R3 展示**：接收方注入 + `collab_status` 聚合展示（各一行，`需要/已排除/最小判别`）。
- **R4 可选**：不传即行为不变。

## 验收

- [ ] 带 `blocked` 的 BLOCKED 投递：接收方注入含三段；`collab_status` 同；
- [ ] 不传时输出与 0.6.0 逐字一致；
- [ ] 超长/超条数 → 可读拒绝（不截断静默）；
- [ ] 回归全绿。
