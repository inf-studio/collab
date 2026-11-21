# 设计：人类决策清单

## 1. 边界

只读聚合 + 呈现。不新增写动作、不改决策账本格式、不投递。

## 2. 数据来源

```
~/.config/opencode/collab-decisions/<key>.json
  { key, next, items: [{ id, question, options, owner, status, askedBy, at, parties?, origin?, hash }] }
```

- 只取 `status === 'open'`；
- `age = now - at`（`at` 缺失 → 0 并标 `?`）；
- `origin === 'conflict'` → 冲突标记 + `ttlLeft = 24h - age`（负值不显示，等价过期）；
- 目录不存在 → 空集，**不创建**；
- 单文件损坏 → 跳过 + 一条日志（不抛）。

## 3. 工具 `collab_decision_inbox`（只读，工具数 28 → 29）

```
collab_decision_inbox { owner?: "ses_…", limit?: number /* 默认 20 */ }
```

输出：

```
待决策 3 条（冲突 1）· 最老 4.2h
  t_mwlp…#D3 · 等 ses_e176… · 4.2h · ⚠冲突（TTL 剩 19.8h）· dev/prod 键空间是否隔离
  b_1bb1…#D1 · 等 ses_edc3… · 1.1h · 客户端增量帧的判据
  t_mwnm…#D2 · 等 人工 · 0.3h · 是否回退前缀隔离
```

- 排序：`at` 升序（最老在上）；
- `question` 截断 60 字；`limit` 截断后给「还有 N 条」；
- `owner` 过滤后计数按过滤集算。

## 4. GUI

- 看板顶部一行：`待决策 3`（有冲突 → `待决策 3 ⚠1`），点击展开只读列表；
- 列表行：`#D3 · 等 <会话短名> · 4.2h · <问题>`；冲突行用 `warn` tone；
- **不提供 answer/supersede 按钮**（写动作留后续）。

### 4.1 点击行为：只跳会话（零写入）

- 整行点击 → `tabs.open` 跳到该决策的 `owner` 会话（复用 0.8.1 的行内跳转能力）；
- `owner` 缺失或不是 `ses_…`（例如「人工」）→ 行不可点，hover 提示「该决策没有对应会话」；
- **不投递、不排队、不写任何文件**：看板不成为第二个写入面；
- 跳转失败（会话已归档/不存在）→ toast，不改变任何状态。

> 人类在那个会话里自己回答；会话侧的 `[decide]` 注入与 `collab_decide answer` 仍由会话模型执行。

## 5. TUI

- 详情区追加一行：`待决策 3（最老 4.2h）`；无 → 不显示；
- 宽度不够时截断，不换行。

## 6. 兼容与回滚

- 新工具注册后工具数 29；既有 28 个工具输出不变；
- 账本不存在/损坏 → 空集，不建目录；
- 回滚：`git restore -- src/tools/index.ts src/tools/decision-inbox.ts src/gui.tsx src/tui.tsx` + `rm src/core/decision-inbox.ts`。

## 7. 测试

| 用例 | 断言 |
|---|---|
| 3 key 混合 | 排序按 age、计数/冲突数正确 |
| owner 过滤 | 只剩该 owner 的条目 |
| 空账本 | 「无待决策」，不建目录 |
| 坏文件 | 跳过 + 1 条日志，不抛 |
| 冲突 TTL | 剩 19.8h / 过期不显示 |
| limit | 20 条上限 + 「还有 N 条」 |
| 只读 | 目录 mtime 不变 |
| 点击跳转 | 触发 `tabs.open(ownerSid)`；`owner` 缺失时不可点；全程零写入 |

变异：
1. 排序改成 `at` 降序 → 断言必红；
2. 不过滤 `status='open'` → 「已回答不出现」必红。
