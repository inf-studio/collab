# 实施笔记：followUps 硬化（F1–F3，0.3.1）

> 任务：`.trellis/tasks/11-18-collab-followup-hardening`
> 版本：`0.3.0 → 0.3.1`（`package.json` + `PLUGIN_VERSION`）
> 未执行：`git add/commit/tag`、`npm publish`（按硬约束留给 owner）

## 1. 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/core/followup.ts` | F1：`nextFollowUpHint` 变纯查询（不再 stamp）；F2：无效 entry 不再进 keys + 新增 `invalidFollowUps` / `takeInvalidFollowUpNotice` / `invalidFollowUpLines`；F3：`validateIssuePath` 先规范化再判定 |
| `src/core/chain.ts` | 新增 `FollowUpHintResult = { lines, keys }`；`followUpHints` 纯查询；`injectionFor` 返回 lines+keys |
| `src/hooks/context.ts` | `event.system.push(...)` **之后**才 `markFollowUpSeen`（push 抛错则不标记） |
| `src/tools/list.ts` | F2 汇总行：本会话发起的单里路径无效的 followUp 计数（`invalidFollowUpNotice`），放在早返回分支之前 |
| `src/tools/followup.ts` | `issuePath` 只含空白/控制字符时**直接报错**（不再静默回退到记录自带提案）；成功后提示本单已有的无效条数 |
| `test/handoff-harness.mjs` | 新增 S89（20 项）；文件头补 S89 摘要 |
| `docs/collab.md` | §11.9.3（标记时机 / 无效路径 / 路径规范化）、§12.5 #13、`collab_followup` 表格行 |
| `CHANGELOG.md` / `README.md` / `skills/collab/SKILL.md` | 0.3.1 段、526 项测试、followUps 行为说明 |
| `src/constants.ts` / `package.json` | 版本 0.3.1 |

## 2. 关键设计

### F1 标记时机（at-most-once → 注入成功才标记）

- `chain.followUpHints(sid)` 现在只返回 `{ lines, keys }`，**不写** `collab/followup-seen/<sid>`。
- `hooks/context.ts`：`injectChain` 返回 `{ text?, keys }`；`event.system.push(block)` 成功后
  才 `await markFollowUpSeen(deps.ctx, sid, keys)`。
- 自然重试：push 抛错 → 没走到 stamp → 下一轮 `nextFollowUpHint` 仍看到该 key 未 seen → 再次渲染。
  没有引入计数器/租约。
- 每次注入仍 ≤1 行（`followUpHints` 命中第一条就 return）。

### F2 无效路径不静默

- `nextFollowUpHint`：`validateIssuePath` 失败 → `continue`，**不把 key 放进 keys**（旧实现把 key
  塞进 `skipped` 一起 stamp，等于「提示已发」但什么都没渲染 → 永久丢失）。
- 顺带修掉一个同源问题：旧实现「整单无效」时返回 `{line:'', keys}`，`chain` 里 `continue` 到下一单
  但那一单的 keys 已经写完；现在返回 `undefined`，同一单里**有效的**那条追加照常渲染（新的
  `return { lines: [hint.line], keys: hint.keys }`）。
- 可见性：`invalidFollowUps(record)` 统计本会话发起、且路径当前不可校验的条目；
  `takeInvalidFollowUpNotice(ctx, sid, entries)` 用 `collab/followup-invalid/<sid>` 存上次汇总的
  `${bid}:${at}` 集合，**集合变化才返回 true**（同一无效条目每会话只提示一次，增量再提示一次）。
  存储失败返回 `true`（显式 pull，宁可多提示也不隐藏）。
- 输出只含 `bid` + 时间，**不回显路径文本**（无效路径正是「不能进注入/列表」的东西）。
- `collab_followup` 写入时：`input.issuePath` 提供但 sanitize 后为空 → 直接抛 `invalid(...issuePath 为空)`；
  成功后若本单还有其它无效条目，返回一行「另有 N 条 … 不会渲染」。

### F3 路径规范化

```ts
if (isAbsolute(issuePath)) return 拒;
const parts = issuePath.split('/').filter(p => p && p !== '.');
if (parts.includes('..')) return 拒;
const clean = parts.join('/');          // ./docs/issues/x.md → docs/issues/x.md
if (!/^docs\/issues\/[^/]+\.md$/i.test(clean)) return 拒;
// 之后仍是 realRoot / issuesRoot 前缀校验 + lstat(非软链) + realpath 前缀校验（未放宽）
```

- `.`/`./`/重复 `/` 合并；只拒 `..` 与绝对路径；软链、越界、非 `.md`、文件不存在仍拒。
- 错误文案改为 `issuePath 不能包含 ..：…`（旧的「.. / .」不再准确），保留 `/不能包含 \.\./` 可匹配。

## 3. 验证

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

结果：

- `pnpm build` ✅（`dist/index.js` 零运行时依赖不变；GUI 产物 13.28 kB）
- `pnpm typecheck` ✅
- `test/handoff-harness.mjs` **526/526**（506 + S89 的 20 项）
- `test/readonly-default.mjs` 12/12 ✅
- `test/snapshot-shape.mjs` 18/18 ✅
- `scripts/check-skill.mjs` ✅

S89 覆盖（`test/handoff-harness.mjs`）：

- `./docs/issues/x.md` 写入成功且**存储为规范化路径**；`docs//issues/./x.md` 预览同一路径；
- `../x`、中间的 `..`、绝对路径、软链全部仍拒；`issuePath` 只含空白/控制字符直接报错且不写入；
- 规范化后的提示行能渲染（不含 `./` 前缀）；
- `Object.freeze([])` 让 `event.system.push` 抛错 → hook 不抛、块没进去；**下一轮仍提示**，
  再下一轮才消失（证明 stamp 发生在 push 之后）；
- 无效路径：`collab_followup` 返回「另有 1 条路径无效」、`collab_list` 输出
  「1 条 followUp 因路径无效未渲染」且不回显路径、第二次 `collab_list` 不再出现；
  同单的有效追加照常渲染；**补建文件后**，之前无效的那条被提示（证明没被 stamp）；
  全部路径恢复合法后汇总行消失。

## 4. 兼容性 / 边界

- `followUps` 结构字段不变（`{bid, issuePath, at, by}`），无数据迁移；`collab/followup-seen/*`
  与新增 `collab/followup-invalid/*` 都只是 session 级旁路存储（后者缺失时视为「没提示过」）。
- 权限模型不变：只有 `claim.by` 能登记；`done`/`blocked` 才能追加；每单 ≤3 条。
- 越界/软链拒绝未放宽（F3 只放宽 `.` 段与重复 `/`）。
- `HandoffChain.followUpHints` / `injectionFor` 的返回类型从 `string[]` 变为
  `FollowUpHintResult`（插件内部接口；`__internals` 未导出这两个函数，无外部消费者）。

## 5. 留给 owner 的收尾

1. 复核 diff 后 `git add` 列出的 12 个文件 → commit；
2. `0.3.1` tag + `npm publish`（`prepublishOnly` 会重新 build）；
3. 归档任务（`task.py archive`）。
