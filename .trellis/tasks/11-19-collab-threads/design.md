# 设计：threads 聚合 + status 降级

## 1. 问题复述

- 同一对会话并行 7 个 thread（实测），发消息前无法知道「哪些没闭环」；
- `collab_status { threadID }` 对**消息类 thread** 直接报错（7 个里 6 个，频率极高）。

## 2. thread 索引（新增，唯一新存储）

`ThreadStore` 只能按 id 读、不能枚举，所以需要一份**轻量索引**：

```
~/.config/opencode/collab-threads.json
{ "version": 1,
  "entries": {
    "t_…": { "target": "ses_…", "kind": "handoff" | "messages",
              "from": "ses_…", "lastAt": 0, "preview": "≤80 字",
              "bid": "b_…"?(handoff 时) }
  } }
```

- 写点：每次**成功投递**的 `collab_send` / `collab_reply` / `collab_handoff`（只在这一处写，失败不写）；
- 上限 500 条、按 `lastAt` 淘汰；读时过滤 7 天前；
- 读-合并-写 + `tmp+rename`；坏文件按空处理并记一次日志（不让索引拖垮工具）。

## 3. `collab_threads { target, includeClosed? }`（新工具，只读）

- 目标解析：`ses_…` 或别名；
- 数据：索引里 `target === 目标` 的 thread（最近 7 天），join 广播记录（handoff）与 thread store 状态；
- 输出每行：`t_…  handoff|messages  open|answered  HH:MM  preview`；`bid` 有则附；
- 默认只列未闭环（thread store `status !== 'answered'` 或 handoff 非终态）；`includeClosed:true` 再列最近 3 条已闭环；
- ≤20 条，超出 `还有 N 个`。

## 4. `collab_status` 降级（R2）

- 先查广播记录（现有行为，逐字不变）；
- 无记录 → 查索引 + `threads.read(threadID)`：
  - 命中 → `kind:"messages"` + `target` + 最近 N 条出入站摘要 + 关联 handoff（若有）；
  - 索引也没有但 thread store 有 → 同样降级（`kind:"messages"`）；
  - 都没有 → 原错误文案（保留「可能拼错」提示）。

## 5. 只读保证

`collab_threads` 与降级后的 `collab_status` 都不得写索引/记录/thread（只有投递成功才写索引，读路径绝不写）。

## 6. 测试

| 用例 | 期望 |
| --- | --- |
| 1 handoff + 2 消息 thread | `collab_threads` 全列出，kind/状态正确 |
| `includeClosed` | 多出已闭环（≤3） |
| `collab_status { 消息 thread }` | `kind:messages` + 摘要，不报错 |
| 未知 thread | 原错误文案 |
| 索引损坏 | 按空处理、工具不崩 |
| 索引上限 | 501 条时淘汰最旧 |
| 只读 | 读前后索引 mtime/hash 不变 |

变异：索引 key 写成 `bid` → 消息线程列不出；降级直接返回错误 → 对应断言失败。

## 7. 回滚

删索引文件即失效；代码 `git restore -- src/core/thread-index.ts src/tools/{threads,status}.ts src/tools/index.ts`。
