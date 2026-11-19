# PRD：契约决策记录（decisions）

## 问题

一次交付里 3 条契约级偏差（退出码 2→3、`room:order` 纯事件型、断言只看末帧）全靠口头纠正，跨 3–4 个 thread，最后人工回写提案。

## 需求

- **R1 工具**：`collab_decisions { bid, items: [{id, decision, rationale?}], confirm }`；`items` 1–10 条，`decision` ≤200 字。
- **R2 存储**：写进记录 `decisions[]`（每单上限 20，重复 `id` 覆盖）；不投递、不改 state/receipt。
- **R3 读取**：`collab_status` 展示最近 3 条；承接方 context 注入带「本单决策 N 条」一行（不展开全文）。
- **R4 权限**：发起方或承接方都可写（其余拒绝）。
- **R5 只读拉取**：`collab_status { bid }` 已覆盖，不新增查询工具。

## 验收

- [ ] 写入 3 条 → status 显示最近 3 条；重复 id 覆盖不重复；
- [ ] 超 20 条 → 可读拒绝；
- [ ] 第三方写 → 拒绝且 0 写入；
- [ ] 注入只有一行计数；
- [ ] 回归全绿。
