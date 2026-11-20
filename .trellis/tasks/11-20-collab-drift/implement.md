# 执行计划：漂移检测 + 挂起唤醒 + 主线占位（0.9.3）

## 顺序清单

- [x] 1. `src/core/drift.ts`：`evaluate()`（5 轮 / 2h / 24h 三条件）
- [x] 2. `src/core/wake.ts`：`wakeWhen` 解析、到期扫描
- [x] 3. `src/core/contract.ts`：`resume` / `block` / `done` 状态迁移 + next-up 校验
- [x] 4. `src/tools/mission.ts`：三个新动作
- [x] 5. `src/tools/todo.ts`：`suspend` 强制 `wakeWhen`；`drifted` 状态值
- [x] 6. `src/hooks/context.ts`：`[drift]` 段 + `[未处置]` 标记
- [x] 7. 测试 `test/drift.mjs`：design §7 十一例 + 截断 + 变异 + 复核 A/B（68 项）
- [x] 8. 文档：`docs/collab.md`「漂移与挂起」；skill；CHANGELOG
- [x] 9. 门禁 + 复核

## 门禁

```bash
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

报数：工具数 26（不增）、drift 触发轮次（应=5）、24h 转换用例。

## 复核门

- 独立子代理跑全量门禁并贴原始输出；
- 变异（强制）：阈值 5 → 0，「连续 4 轮不触发」必红；
- 主会话抽检：构造 6 轮序列，亲跑注入看第 5 轮是否出现 `[drift]`。

## 回滚

见 `design.md` §8。

## 实测（2026-11-20，含复核 A/B 修复）

- 工具数 **26**（不增；`collab_mission` 只多了 `resume`/`block`/`done` 三个动作）；
- 计数口径：hook 先 `stampTurn`（含当前请求；首个请求 / 上一轮刚推进 → 1，否则 prev+1）再 `evaluate`（直接读、不再 +1）；
- 触发轮次：**无 advance** 与 **推进一次后静默** 两条路径都是第 1–4 轮无 `[drift]`、**第 5 轮**出现
  `连续 5 轮无主线动作`、第 6 轮带 `[未处置]`（复核 A 修复前，推进路径第 6 轮才触发且文案仍是 5 轮）；
- 复核 B：`block → 25h → [drift] → resume` → `resume` 关闭旧挂起行（`evidence="resume"`），**下一轮无 `[drift]`**；
- 24h 转换：`wakeWhen={kind:"reply"}`、`parkedAt=now-25h` → 待办 `status:"drifted"`（不关闭）+ `[drift]` 原因；
  未来 `kind:"time"` 的 `at` 优先于 24h 兜底（未到点不判漂移）；
- 三选一：`resume`（缺 `next` 拒绝）/ `block`（缺 `on`/`reason` 拒绝，同阻塞方复用挂起行）/
  `done`（无 mainline open next-up 拒绝，`doing` 不算，`set{state:"done"}` 同校验）；
- 截断：生产预算 12 下四段 3+4+2+2 = 11 行、无丢弃（每段上限之和 11 不可能超 12）；
  用 `renderInjection {maxLines:10}` 驱动真实丢弃分支 → `dropped=["progress"]`，`lines=9`（其余三段整段保留）；
  传入 3 行 drift 时按 section 上限截为 2 行；
- 门禁：`pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs` 全绿；
  测试计数 900+13+20+53+54+30+83+68+62+9+60+47+82 = 1481；
- 强制变异：`DRIFT_NO_ADVANCE_TURNS 5 → 0` → 退出码 1，`requests 1–4 never contain [drift]` 等 10 项红（已复原）。
