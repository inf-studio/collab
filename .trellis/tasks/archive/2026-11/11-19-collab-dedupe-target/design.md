# 设计：跨 thread 去重（target 维度）

## 1. 现状

`src/tools/shared.ts` 的 `findDuplicateSend` 有两级：
- 记录层：`record.replies` 里同 thread + 同归一化正文 + 窗口内；
- 进程内 memo：`threadID + '\n' + norm(text)`。
→ 同一句话发到 3 个不同 thread 时，两级都判「不重复」。

## 2. 目标判定

新增 **target 级**索引（进程内 Map，插件进程生命周期）：

```ts
// key = targetSid + '\n' + norm(text)
Map<string, { at: number; threadID: string; bid?: string }>
```

- 发送前先查（窗口 = `dedupeWindowMs`，默认 60s）；
- 命中 → **不投递**，回执：`已在 thread t_… 发过同文，未重复投递（force:true 可强制）`；
- 未命中 → 正常投递，并写索引（threadID / bid / at）。

为什么用进程内而不是落盘：投递本身就在服务端进程内完成；60s 窗口跨重启无意义；
不新增文件、不增加磁盘依赖。

## 3. force

- `collab_send` / `collab_reply` 增 `force?: boolean`；
- `force:true` → 跳过 target 级判定（**thread 级仍生效**？不：force 表示「我知道重复，发」，
  两级都跳过；但仍在回执里标注 `dedupeOverridden: true`）；
- 有记录时（handoff/reply 关联 bid）在该记录写 `dedupeOverriddenAt`（只读展示用），不改 state。

## 4. 保留的行为

- thread 级幂等保持不变（同 thread 同文仍只投一次，除非 force）；
- `dedupeWindowMs: 0` → 全部关闭（两级）；
- 不同正文、不同 target 不受影响；
- protected 目标：**查询在前、拒绝优先（refusal wins）**——查重先执行，但护栏拒绝仍然赢：命中且可投才抑制；命中但本该拒绝时，返回原护栏错误、0 次 prompt、不写索引（不产生队列项）。

## 5. 测试

| 用例 | 期望 |
| --- | --- |
| 同 target 3 个 thread 同文 <60s | 只投 1 次；后两次回执含「已在 thread … 发过」 |
| 同 target 3 thread + `force:true` | 3 次都投，回执含 `dedupeOverridden` |
| 61s 后同文 | 可再投 |
| thread 级（同 thread 同文） | 行为与 0.6.0 一致 |
| 不同 target 同文 | 都投 |
| `dedupeWindowMs:0` | 都投 |
| 命中时记录不被改写 | `state/claim/receipt` 前后一致 |

变异：把 target 级索引 key 改成 `threadID` → 跨 thread 用例失败；去掉 force 分支 → force 用例失败。

## 6. 回滚

`git restore -- src/tools/{shared,send,reply}.ts`；`dedupeWindowMs:0` 运行时关闭。
