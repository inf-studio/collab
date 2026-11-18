# 实施记录：受保护注入提示去重（0.4.1）

## 结论

同一提案在受保护会话的 `context` 注入里最多 **一行**：`followUps` 追加提示与 `[owner-queue]` 队列行
在渲染层合并，每个候选登记它带的**全部**提案键（`path:` / `bid:`，可同时有），**任一键相同即同一提案且可传递**，
组内取 `at` 最新者；两类合计仍 ≤3 行；被去重掉的条目**不 stamp**，下一轮仍可提示。
只改渲染层 + 工具说明，存储结构 / 权限模型 / handoff·lease 语义未动。
（0.4.1 复核的 P2 —— 单键 `issuePath ? path : bid` 导致同 bid 仍两行 —— 已改为多键并查。）

## 代码

| 文件 | 改动 |
| --- | --- |
| `src/core/followup.ts` | 新增 `FollowUpCandidate` + `pendingFollowUpCandidates(record, sid, seen, {workspace})`：**全部**待渲染条目（纯查询）；`nextFollowUpHint` 改为取它第 0 条（行为不变） |
| `src/core/owner-queue.ts` | 新增 `OwnerQueueCandidate` + `unseenCandidates(targetSid)`（全部未读项，带 `id/at/bid/issuePath/line`）；抽出 `hintLine()`；删除只被内部使用的 `unseenHints`（其 ≤3 截断移到合并后的渲染层） |
| `src/core/chain.ts` | 新增模块级 `ProtectedHint`（含 `keys: string[]`）与 `dedupeProtectedHints()`（**多键并查**：任一 `path:`/`bid:` 键相交即同组，传递闭包，组内取 `at` 最新）；`createHandoffChain` 增加 `followUpCandidates()` / `queueCandidates()`；`injectionFor` 的受保护两条分支（`[protected]` 与 `[protected-child]`）改为合并 → 去重 → ≤3，只返回实际渲染项的 `keys` / `ownerQueue` |
| `src/tools/owner-queue.ts` | 描述补：broadcast 候选池**排除** `[protected*]`（触达受保护只有本工具排队或对方自己 pull）、同一提案只渲染一行 |
| `src/tools/followup.ts` | 描述补：同一提案已用 `collab_request_owner` 提交时，不必再登记 followUp（渲染层按提案去重，只显示最新一条） |
| `src/constants.ts` / `package.json` | `0.4.1` |

### 去重口径实现细节

- 键：每个候选登记**它带的全部键** —— `path:<规范化 issuePath>`、`bid:<bid>`（可同时有，见 `hintKeys()`）；
  **任一键相同即同一提案**，且关系**可传递**（并查集 / union-find）。
  - P2 修正：上一版是单键 `issuePath ? path : bid`，导致「只带 `bid` 的队列项」（真实入口
    `collab_request_owner { target, text, bid }` 不传 `issuePath`）与同 bid 的追加/队列项**不合并**，
    与工具描述「same bid/issuePath is merged」及 §11.12.1 冲突（复核报告 P2）。
  - 都没有键的候选不参与合并（`keys` 为空 → 自成一组的独立候选）。
- 保留：组内 `at` 更大者；同一毫秒 tie-break 取 `followup`（结论优先于催办），代码与文档一致。
- 排序：去重后统一按 `at` 升序再取前 `OWNER_QUEUE_HINT_LIMIT`（=3），与队列原有 FIFO 口径一致。
- 标记：`FollowUpHintResult.keys` / `ownerQueue` 只装渲染项；`hooks/context.ts` 未改（仍只在
  `event.system.push` 成功后写），因此 R2 自动成立。
- 组内按新到旧「逐轮放出」：被合并掉的成员不 stamp，下一次请求重新参与合并（新增 S93g 验证）。

## 边界（有意未做）

- `[protected-child]` 仍只拿队列提示（它本来就不走 `followUpHints`），但队列项之间同样按提案合并。
- 非受保护会话路径不变（`followUpHints` ≤1 行 + 常规注入）。
- 不做 `(target, text)` 内容去重（补材料/催办场景仍可多次提交），只是同一提案的**提示行**合并。

## 回归（S93，26 项）

1. 队列较新 → 1 行（队列），被去重的 followUp 未 stamp、下一轮渲染并再次提示 → 之后不再重复。
2. 追加较新 → 1 行（followUp），队列项未 stamp、下一轮渲染并 stamp。
3. 4 个不同提案 → 首轮 3 行（最旧优先）、次轮第 4 条。
4. 两条队列项指向同一提案 → 1 行（新者），旧者下一轮仍提示。
5. **（P2）** `collab_request_owner { bid }`（无 `issuePath`，队列项 `提案: -`）+ 同 bid 的追加 → **1 行**
   （取新的队列行），追加未 stamp、下一轮渲染。
6. **（P2）** 两条同 bid 队列项（一条带路径、一条不带）→ **1 行**（取新），带路径的那条未 stamp。
7. **（P2）传递性** A(path p1, bid b1) + B(path p1, bid b2) + C(bid b2) → 首轮 1 行（C），
   次轮 1 行（B，A 被路径合并），第三轮 1 行（A），第四轮空。
8. 两个工具描述含去重 / broadcast 排除 protected 的措辞。

S93 使用 7 个 **config `protect`** 的根会话（`writeConfig({ protect: [...] })`，`config.protect` 是
追加式的），因为 `[protected-child]` 分支刻意不引入 followUp 提示。

## 验证

```
pnpm build      ✔
pnpm typecheck  ✔
pnpm test       ✔ 608/608 + 12/12 + 18/18
node scripts/check-skill.mjs ✔
node .trellis/tasks/11-18-collab-hint-dedupe/research/dedupe-check.mjs ✔ 34 passed, 0 failed
  （Case E / E2 / N 三个此前 [observed] 的缺口现在都是 1 行 = 已合并）
```

## P2 修正记录（本轮）

- 文件：`src/core/chain.ts`（`ProtectedHint.keys`、`hintKeys()`、`hintIsNewer()`、并查集版
  `dedupeProtectedHints()`、两个候选构造器补 `keys`）、`test/handoff-harness.mjs`（S93e–S93g，+10 项）、
  `docs/collab.md` §11.12.1 + §11.9.3、`README.md`、`CHANGELOG.md`、`skills/collab/SKILL.md`、
  `src/tools/owner-queue.ts` 描述、`src/core/{followup,owner-queue}.ts` 注释。
- 语义不变项：仍只在渲染层合并；仍只 stamp 实际渲染项；上限仍在合并后取 3；存储/权限/handoff/lease 未动。

## 回滚

`git restore -- src/ test/ docs/collab.md skills/collab/SKILL.md README.md CHANGELOG.md package.json`；
无数据迁移、无存量文件格式变化（`seenAt` / followUp seen key 语义不变）。
