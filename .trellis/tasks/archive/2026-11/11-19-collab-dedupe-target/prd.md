# PRD：跨 thread 去重（target 维度）

## 问题

0.6.0 的 60s 同文幂等按 **thread** 计算；同一条 BLOCKED 发到 3 个 thread 全部放行，对方三个 thread 各回一次「等你结论」，没有一次落在它当前使用的 thread。

## 需求

- **R1 target 维度**：同 `target` + 归一化正文在 `dedupeWindowMs` 内重复 → **不静默再投**；
- **R2 回执**：明确写「已在 thread t_… 发过同文，未重复投递」+ 如何强制（`force:true`）；
- **R3 强制**：`force:true` 时正常投递，仍在记录里标注 `dedupeOverridden`；
- **R4 兼容**：thread 维度行为保持不变（同 thread 同文仍幂等）；`dedupeWindowMs:0` 关闭全部。
- **R5 不误杀**：窗口外同文可再投；不同正文不受影响。

## 验收

- [ ] 同 target 三个 thread 同文（<60s）→ 只投 1 次，后两次回执含「已在 thread … 发过」；
- [ ] `force:true` → 3 次都投，且记录标注；
- [ ] 61s 后同文 → 可再投；
- [ ] `dedupeWindowMs:0` → 全放行；
- [ ] 回归全绿（现有 thread 维度用例不变）。
