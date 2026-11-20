# 设计：会话契约骨架 + 五段式注入（0.9.1）

## 1. 边界

本版建立**契约真源**与**每轮注入**；不做闸门（0.9.2）、不做漂移判定（0.9.3），只把数据存起来并让模型每轮看得到。

## 2. 模块划分

| 文件 | 职责 |
|---|---|
| `src/core/contract.ts`（新） | 读写 `collab-contract/<sid>.json`、合并、确认语义 |
| `src/core/mission-resolve.ts`（新） | 从 Trellis 活动任务解析主线锚 |
| `src/core/evidence.ts`（新） | 里程碑 evidence 校验（commit / file / test / decision） |
| `src/tools/mission.ts`（新） | `collab_mission {action: get\|set\|confirm}` |
| `src/tools/progress.ts`（新） | `collab_progress {milestone, evidence}` + `list` |
| `src/tools/todo.ts`（新） | `collab_todo {action: add\|close\|defer\|suspend\|list}` |
| `src/hooks/context.ts` | 注入五段（改造） |
| `src/tools/index.ts` | 注册 3 个工具（23 → 26） |

## 3. 存储

```
~/.config/opencode/collab-contract/<sid>.json
```

```jsonc
{
  "v": 1, "sid": "ses_…", "updatedAt": 0,
  "mission": { "taskPath": ".trellis/tasks/…", "oneLine": "…",
               "inScope": [], "outOfScope": [], "handoffTo": {},
               "state": "active|idle|suspended|done",
               "confirmedBy": null, "confirmedAt": null },
  "plan": { "milestones": [{ "id": "M1", "title": "…", "done": false,
                             "evidence": null, "at": null }],
            "lastAdvancedAt": 0 },
  "todos": [{ "id": "T1", "kind": "mainline|collab", "subject": "…",
              "status": "open|doing|blocked|suspended|closed|dropped",
              "blockingOn": "me|<sid>", "parkedBy": null, "parkedAt": null,
              "wakeWhen": null, "since": 0, "closedAt": null, "evidence": null }],
  "peers": [{ "sid": "ses_…", "role": "requester|implementer|decider|verifier",
              "threadId": null, "since": 0 }],
  "turn": { "count": 0, "lastAt": 0, "lastAdvancedAt": 0, "noAdvanceTurns": 0 }
}
```

写：`tmp + rename`；读：缺失即**惰性创建**（不写盘，直到首次 `set`）。

## 4. 主线锚解析（D7）

优先级：

1. `.trellis/.runtime/sessions/<key>.json` 中与该会话匹配的 `task_path`；
2. 该工作区 `.trellis/tasks/*/task.json` 中 `status == 'in_progress'` 的任务——**恰好 1 个**才采用；
3. 多个或无 → `mission` 留空，注入 `[mission][未确认]`，提示 `collab_mission set`。

> 不做"猜标题"（D7 已排除）。`task.py` 子进程调用**不采用**（每次注入跑 python 太重），改为直接读 JSON 指针。

**确认语义**：`confirm {by}` 写入 `confirmedBy/confirmedAt` 后，`set` 修改 `mission` 必须带 `--reconfirm` 且 `by` 非空；否则拒绝。

## 5. evidence 校验（D20）

| 形式 | 校验 |
|---|---|
| `commit:<sha>` | `git cat-file -e <sha>^{commit}` 成功且是 HEAD 祖先 |
| `file:<path>:<line>` | 文件存在且行数 ≥ line |
| `test:<path>` | 文件存在（测试报告/输出文件） |
| `decision:<D#>` | 该决策 `status == 'answered'` |

不通过 → 拒绝点亮，返回可读原因。点亮后 `plan.lastAdvancedAt = now`、`turn.noAdvanceTurns = 0`。

## 6. 注入（每轮）

固定顺序累加，超 12 行即停（被截断的段落不出现）：

```
[mission] …(≤3 行)
[todo]    …(≤4 行)
[drift]   …(≤2 行，仅触发时)
[scope]   …(≤2 行，仅命中时)
[progress]…(≤2 行)
```

- `[todo]` 头部 `N open · M 需要你 · K 等对方`，随后 top3（按 `blockingOn=me` > 最老 since 排序）；
- `[scope]`：把本条消息正文与 `mission.outOfScope` 做**关键词匹配**（配置化别名表）；命中才出现；
- 全部**每轮重算**，不写入 `injected[]`，不注销。

## 7. 未收尾标记（对 PRD R6 的实现偏差）

插件没有 idle 钩子，无法在"空闲前"写入。改为**下一轮回溯判定**：

- 每次注入前，若 `turn.lastAt` 存在且上一轮结束时有 `status='doing'` 的 todo 未被更新 → 该 todo 注入标 `[未收尾]`；
- 语义等价（"上一轮没收尾"），且不需要 idle 事件。

## 8. 测试

| 用例 | 断言 |
|---|---|
| 连续两轮注入 | 第二轮仍含 `[mission]` 与 `[todo]` |
| 点亮无 evidence | 拒绝 |
| 点亮合法 commit | `lastAdvancedAt` 更新、`noAdvanceTurns=0` |
| confirm 后覆盖 | 拒绝；带 `--reconfirm` + by 才通过 |
| 10 条 todo | 注入 ≤12 行、只列 3 条 + `还有 7 条` |
| 无任务 | `[mission][未确认]` |
| suspend 缺 wakeWhen | 拒绝 |
| 截断顺序 | mission+todo+drift+scope+progress 全出现时，progress 被丢 |

变异：把注入改回写 `injected[]` → 第二轮用例必红。

## 9. 回滚

```bash
rm -rf ~/.config/opencode/collab-contract
git restore -- src/hooks/context.ts src/tools/index.ts
rm -f src/core/contract.ts src/core/mission-resolve.ts src/core/evidence.ts \
      src/tools/mission.ts src/tools/progress.ts src/tools/todo.ts
```
