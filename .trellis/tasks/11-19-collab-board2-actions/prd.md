# PRD：看板快捷动作（加急/冻结/解冻/归档）

## 需求

- **R1 动作**：详情栏动作行提供四个按钮：`加急`（`collab_escalate` 语义）、`冻结`（30min 默认）、`解冻`、`归档`。
- **R2 写 RPC**：`CollabState` 增加 4 个方法（`escalate` / `freeze` / `unfreeze` / `archive`），入参 `{ target, reason?, until? }`；
  **复用 core 现有实现**（不复制规则）：加急→`escalate` 的投递/队列逻辑；冻结/解冻→`freeze.ts`；归档→`archive.ts`。
- **R3 门禁**：protected（含血缘）一律拒绝且 0 投递；只读 agent 的加急降级为 queue；冻结目标上的加急被拒（先解冻）。
- **R4 确认**：GUI 点击动作先弹确认（`ctx.dialogs.confirm` 或等价能力）；确认后调用 RPC，回执用 toast 展示成功/失败原因。
- **R5 审计**：每次写动作在 `~/.config/opencode/collab-audit.jsonl` 追加一行（`at/actor/action/target/ok/reason`），只追加不轮转。
- **R6 失败隔离**：RPC 抛错不得让面板崩溃；失败只 toast。

## 验收

- [ ] 四个动作在假宿主上生效（记录/冻结文件/归档位变化正确）
- [ ] protected 拒绝且 0 投递；只读 agent 加急降级；冻结中加急被拒
- [ ] 确认弹窗取消 → 0 写入
- [ ] 每次成功/失败都有一行 audit
- [ ] RPC 失败 → toast + 面板仍可交互
- [ ] 回归全绿；工具数仍 22
