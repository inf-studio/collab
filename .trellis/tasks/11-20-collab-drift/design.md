# 设计：漂移检测 + 挂起唤醒 + 主线占位（0.9.3）

## 1. 边界

只读契约 + 写契约状态；不新增投递行为，不改变闸门。

## 2. 模块

| 文件 | 职责 |
|---|---|
| `src/core/drift.ts`（新） | `evaluate(contract, now)` → `{drifted, reason, noAdvanceTurns, parkedHours}` |
| `src/core/wake.ts`（新） | `wakeWhen` 解析与到期判定（`reply` / `decision` / `time` / `manual`） |
| `src/core/contract.ts` | 增加 `mission.resume/block/done` 状态迁移 + next-up 校验 |
| `src/tools/mission.ts` | 新增 `resume` / `block` / `done` 动作 |
| `src/tools/todo.ts` | `suspend` 强制 `wakeWhen`；到期扫描 |
| `src/hooks/context.ts` | `[drift]` 段（仅触发时） |

## 3. 判定

```
drifted =
  turn.noAdvanceTurns >= 5                   // D8
  OR mission.state == 'suspended' && parkedHours > 2
  OR exists(todo: status='suspended' && wakeWhen 到期 && age > 24h)   // D17
```

- `noAdvanceTurns`：由 `collab_progress` 点亮或 mainline todo 关闭清零；每轮注入 +1（无 evidence 时）；
- `parkedHours`：`mission.state='suspended'` 时 `mission.parkedAt` 起的时长；
- 24h 兜底：任何 `suspended` todo 超过 24h 未醒 → 转 `drifted` 并保留原因。

## 4. 三选一（必须落账）

`[drift]` 出现后，模型必须调用其一：

| 动作 | 写什么 | 校验 |
|---|---|---|
| `collab_mission resume --next "<下一步>"` | `state='active'`，`noAdvanceTurns=0`，建/更新 mainline todo | `next` 非空 |
| `collab_mission block --on <sid> --reason "<原因>"` | `state='suspended'`，`parkedAt=now`，建 `suspended` todo（`wakeWhen.kind='manual'`） | `on`/`reason` 非空 |
| `collab_mission done` | `state='done'` | **必须已存在 `kind='mainline'` 且 `status='open'` 的 next-up todo**，否则拒绝 |

未处置：下一轮 `[drift]` 继续出现并加 `[未处置]` 标记。

## 5. wakeWhen

```ts
type WakeWhen =
  | { kind: 'reply';    ref: string }                   // 等某会话回复
  | { kind: 'decision'; ref: string }                   // 等某决策 answered
  | { kind: 'time';     at: number }                    // 到期时间
  | { kind: 'manual' };                                 // 仅人工唤醒
```

- `suspend` 时必须提供；`kind='time'` 必须 `at > now`；
- 到期判定在**每次注入时**扫描（不依赖定时器，避免进程生命周期问题）；
- 到期 → todo `status='drifted'`（新增状态值）并进 `[drift]` 原因。

## 6. 注入

`[drift]` 段（≤2 行）：

```
[drift] 连续 6 轮无主线动作（11.2h）→ 三选一：resume / block / done（未处置）
```

或挂起超时：

```
[drift] T4 已挂起 24.3h 未醒（等 ses_e176…）→ 重新评估或关闭
```

## 7. 测试

| 用例 | 断言 |
|---|---|
| 连续 4 轮无推进 | 无 `[drift]` |
| 第 5 轮 | 出现 `[drift]`，含 `noAdvanceTurns=5` |
| 第 6 轮仍未处置 | 出现且带 `[未处置]` |
| resume 带 next | 状态 active、计数清零、todo 生成 |
| block 带 on/reason | suspended + parkedAt + suspended todo |
| done 无 next-up | 拒绝 |
| done 有 next-up | 通过 |
| suspend 缺 wakeWhen | 拒绝 |
| `kind='time'` 已过期 | 拒绝 |
| 挂起 2.1h | `[drift]` 触发 |
| suspended 24h 未醒 | 转 drifted + 进 `[drift]` |

变异：`noAdvanceTurns` 阈值改成 0 → 「连续 4 轮无 [drift]」必红。

## 8. 回滚

```bash
git restore -- src/core/contract.ts src/tools/mission.ts src/tools/todo.ts src/hooks/context.ts
rm -f src/core/drift.ts src/core/wake.ts
```
