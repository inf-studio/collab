# 独立复核报告：受保护注入提示去重（0.4.1）

> 复核对象：工作区未提交改动（`git status --short` 见下），基线 `HEAD` = `0.4.0`。
> 方式：冷上下文、只读；1–4 项用**自写假 ctx**（不复用 `test/handoff-harness.mjs` 的代码，
> 直接用原始 JSON 文件控制 `at`/`bid`/`issuePath`）构造断言，5 项另用「HEAD 构建 vs 当前构建」
> 逐字节对比。

## 结论

**9 项中 8 项通过，1 项不通过（P2）**：`dedupeProtectedHints` 用的是**单一键**
（`issuePath` 有则用路径，否则用 `bid`），因此「**只有 bid**」的队列项与「bid + issuePath」的
追加/队列项**不会合并** —— 同一个 bid（=同一份提案）仍会渲染两行。该路径**真实工具可达**
（`collab_request_owner { target, text, bid }` 不传 `issuePath` 即可），且与本单新增的工具描述
（`src/tools/owner-queue.ts:52` 「for the same bid/issuePath is merged」）和
`docs/collab.md` §11.12.1 末段（「指向同一提案（`issuePath`/`bid`）的多条提示按上表合并成一行」）
**措辞冲突**。

其余项（含 R1 主场景、R2 不 stamp、≤3 合计、非受保护不变、`[protected-child]`、回归、安全）全部通过；
原始 S93 缺陷（同一提案 `issuePath` 两条路各一行）已修复。

**是否可提交**：**可提交，但需先处理 P2**（二选一，见「建议」）。除此之外无阻塞项。

---

## 逐项证据

### 1. 去重键：`issuePath` 优先 → `bid` → 都不去重 —— **通过（字面口径）/ 存在覆盖缺口**

- `src/core/chain.ts:185`
  ```ts
  const key = hint.issuePath ? `path:${hint.issuePath}` : hint.bid ? `bid:${hint.bid}` : '';
  ```
- `src/core/chain.ts:186-189`：空键直接进 `unique`（不参与合并）→「两者都没有时不去重」成立。
- **规范化已落实**（两侧都在读时归一）：
  - 追加侧 `src/core/followup.ts:242`（`validateIssuePath`）→ 返回 `parts.join('/')`
    （`src/core/followup.ts:92-97`：丢掉空段与 `.`）；
  - 队列侧 `src/core/owner-queue.ts:134`（`normalizeQueueItem` → `validateQueueIssuePath`，
    `src/core/owner-queue.ts:113-119`）→ 同样的 `parts.join('/')`。
- 自测（Case D）：队列写 `./docs//issues/./p.md`、追加写 `./docs/issues/./p.md` →
  **合并为 1 行**（`docs/issues/p.md`）。
- **缺口（不通过点）**：键是「二选一」而不是「任一」。
  - Case E（手写原始文件）：队列项 `{ issuePath: null, bid: b_…e05 }` + 同 bid 的追加
    `{ issuePath: docs/issues/f1.md }` → **2 行**。
  - Case E2（**真实工具**）：`collab_followup { bid }`（得 `docs/issues/p.md`）+
    `collab_request_owner { target, text, bid }`（不传 `issuePath`，队列项 `提案: -`）→ **2 行**：
    ```
    - b_aaaa0000000a1212 已闭环，提案 docs/issues/p.md 有追加结论（15:21:27），请读取文件
    - [owner-queue] ses_chk_…from @ 15:21：E2 只有 bid 的队列项（tool）（-）
    ```
  - Case N（队列 vs 队列）：A=`{path+bid}`、B=`{只有bid}`、同 bid → **2 行**。
  - 触发条件完全在现有工具契约内（`src/tools/owner-queue.ts:74-76`：`bid` 是合法可选入参，
    「display only」）；PRD 的去重身份写作 `(sid, bid, issuePath)`，`bid` 本就足以判定同一单。

### 2. 保留最新 / 同毫秒取 followUp / 升序 —— **通过**

- 取最新 + tie-break：`src/core/chain.ts:196`
  `const newer = hint.at > previous.at || (hint.at === previous.at && hint.source === 'followup');`
- 排序与截断：`src/core/chain.ts:201` `unique.sort((a,b) => a.at - b.at).slice(0, OWNER_QUEUE_HINT_LIMIT)`。
- 自测：
  - Case A（追加 `at=1000`、队列 `at=2000`）→ 1 行，取**队列**（`A 队列较新`）；
  - Case B（反向）→ 1 行，取**追加**（`b_…b02 已闭环 …`）；
  - Case C（同为 `at=5000`）→ 1 行，取**追加**（与实现声明一致；因 `[...hints, ...queued]`
    顺序 + 稳定排序，同毫秒时追加先入 `kept`，队列项被判为「不更新」）；
  - Case G 首轮顺序 = `f1@1000, f2@2000, q1@3000`（升序，最旧优先）。

### 3. 只 stamp 渲染项；去重项不 stamp；渲染项只提示一次 —— **通过**

- 返回值只装渲染项：`src/core/chain.ts:878-882`
  ```ts
  keys: rendered.flatMap(hint => (hint.key ? [hint.key] : [])),
  ownerQueue: rendered.flatMap(hint => (hint.queueID ? [hint.queueID] : []))
  ```
- 标记时机未变（F1）：`src/hooks/context.ts:245` push → `:249` `markFollowUpSeen` / `:252`
  `markQueueSeen`。`hooks/context.ts` 本次**无改动**（`git status` 未列出）。
- 自测：
  - Case A/1：渲染队列项 → `seenAt > 0`，追加的 seen key **为空**；A/2 下一轮追加渲染并 stamp；
    A/3 第三轮为空。
  - Case B/1、B/2 同理（反向）。
  - Case L（`event.system.push` 抛错）→ 队列 `seenAt === null`、followUp keys `[]`（F1 未被破坏）；
    下一轮渲染 **1 行**（仍按提案去重）。
  - Case M（同一 bid 两条追加 `at=1000/2000`）→ 首轮只渲染 `2000` 且只 stamp `…:2000`；
    次轮渲染 `1000`；第三轮为空。

### 4. 两类合计 ≤3 行/次（不是各 ≤3）—— **通过**

- 截断发生在**合并 + 去重之后**：`src/core/chain.ts:201`（`OWNER_QUEUE_HINT_LIMIT = 3`，
  `src/constants.ts:215`）；队列侧不再自带截断（`unseenCandidates` 返回全部未读，
  `src/core/owner-queue.ts:342-352`），旧 `unseenHints` 已删除且无残留引用（`grep -rn unseenHints src/ test/` → 无）。
- 自测 Case G：2 条追加（`f1@1000`、`f2@2000`）+ 3 条队列（`3000/4000/5000`）→ 首轮 **3 行**
  （`1q+2f`，最旧优先），次轮 **2 行**，第三轮 **0 行**。
- 旧口径（追加 ≤1 + 队列 ≤3 = 最多 4 行）确已作废（CHANGELOG/README/docs 措辞一致）。

### 5. 非受保护会话：注入路径与文案完全不变 —— **通过（逐字节对比）**

- 代码上：非 guard 分支仍是 `const hints = await followUpHints(sessionID);`（`src/core/chain.ts:884`），
  `followUpHints`（`:763-778`）与群组/接管/未闭环循环**没有任何 diff 行**（本单只移动了这一行语句的位置）。
- `nextFollowUpHint` 重构为 `pendingFollowUpCandidates()[0]`（`src/core/followup.ts:272-279`），
  循环体逐行等价（same key / validate / line）。
- **构造性对比**：`git archive HEAD` 导出 0.4.0 到 `/tmp` 并构建，同一脚本
  （`research/compare-inject.mjs`）分别在两个 `dist` 上跑：
  - S1 非受保护请求方（群组广播 1 条 + 含 2 条追加的 done 单）；
  - S2 `[protected-child]` 的 3 条不同提案队列项；
  - 两次结果 **除 `DIST=` 首行外逐字节相同**（`diff` 仅 1c1）：

    ```
    ### S1 non-protected requester
    [collab-handoff] 交接链路提醒（每条只出现一次）:
    - 群组广播 b_000000c0a10001：cmp open hand-off（提案 docs/issues/p.md，期望 implement，影响面 (未标注)） → 相关请 collab_accept {bid:"b_000000c0a10001"}；没余力就不领取（勿占用）。
    - b_000000c0a10002 已闭环，提案 docs/issues/q.md 有追加结论（05:58:20），请读取文件
    ### S2 protected child (queue only)
    - [owner-queue] ses_cmp_…peer @ 06:13：cmp queue 1（docs/issues/c1.md）
    - [owner-queue] ses_cmp_…peer @ 06:13：cmp queue 2（docs/issues/c2.md）
    - [owner-queue] ses_cmp_…peer @ 06:13：cmp queue 3（docs/issues/c3.md）
    ### S2 again (stamped => nothing)
    (empty)
    ```
- 另 Case I：非受保护请求方 3 条待渲染追加 → 每次请求仍只 **1** 行；且永不出现 `[owner-queue]` 行。

### 6. `[protected-child]`：只收队列项、去重同样生效 —— **通过**

- `src/core/chain.ts:863-874`：子会话分支只 `dedupeProtectedHints(queued)`，`keys: []`，
  `ownerQueue` 只含渲染项；非 guard 的子会话仍返回空（与 0.4.0 相同）。
- 自测 Case H（child 挂在受保护线下，且它自己有 done 单带追加）：
  - 两条同提案队列项 → **1 行**（取 `H 子会话新`）；
  - 无追加行、无「群组广播」、无「接管请求」。

### 7. 工具说明（R3）—— **部分通过**

- ✅ `src/tools/owner-queue.ts:55-57`：写明 broadcast 候选池 **excludes `[protected*]`**，
  且「this tool（或受保护会话自己 pull）才是唯一触达方式」。实跑描述文本含
  `excludes` + `[protected*]` + `only way to reach one`。
- ✅ `src/tools/followup.ts:53-55`：写明「已用 `collab_request_owner` 提交则不要同时登记 followUp」。
- ❌ `src/tools/owner-queue.ts:52`：「a pending collab_followup hint for the **same bid/issuePath**
  is merged」——在 Case E2/N（一侧只有 bid）下**不成立**，属于对实现的过度承诺；
  `docs/collab.md` §11.12.1 末段同样写了「（`issuePath`/`bid`）…合并成一行」。
  → 要么改实现（推荐），要么收窄这两处措辞。

### 8. 回归 —— **通过**

- `pnpm build` ✔（`✔ Build complete in 7186ms`）
- `pnpm typecheck` ✔（`$ tsc --noEmit`，无输出）
- `pnpm test` ✔ **598/598 + 12/12 + 18/18**（`=== 598/598 checks passed` 等三行）
- `node scripts/check-skill.mjs` ✔（`skills ok`）
- 既有 582 **无删改**：`git diff test/handoff-harness.mjs | grep -c '^-[^-]'` → **0**
  （纯新增 235 行 = S93 的 **16** 条断言，`598 - 582 = 16`，与 CHANGELOG 一致）。

### 9. 安全 / 范围 —— **通过**

- `BUILTIN_PROTECT` 与 HEAD 完全一致（`src/constants.ts:38`，
  `git show HEAD:src/constants.ts` 对比相同）；血缘/权限/handoff/lease 语义无 diff。
- 无新依赖：`package.json` 仅 `version` 一行；`pnpm-lock.yaml` / `pnpm-workspace.yaml` 未改。
- 改动文件均在本单允许清单内：
  `CHANGELOG.md` `README.md` `docs/collab.md` `package.json` `skills/collab/SKILL.md`
  `src/constants.ts`（仅版本行，implement.md §5 要求 `PLUGIN_VERSION` 同步）
  `src/core/{chain,followup,owner-queue}.ts` `src/tools/{followup,owner-queue}.ts` `test/handoff-harness.mjs`。
- 存储结构 / 队列与 followUps 记录形态 / `seenAt` 与 followUp seen key 语义均未变（纯渲染层）。

---

## 建议（P2，二选一）

**A（推荐，约 6 行）**：`dedupeProtectedHints` 改为**多键匹配**（任一键相同即同一提案）：

```ts
// 每个候选登记两个键（缺一为 undefined），任一命中即视为同一提案
const keys = [hint.issuePath ? `path:${hint.issuePath}` : '', hint.bid ? `bid:${hint.bid}` : ''].filter(Boolean);
```

语义上安全：`bid` 唯一对应一份提案（`isValidBid` 只允许 `b_[0-9a-f]{8,32}`），
路径相同时合并也符合 R1；`两者都没有` 仍然不合并。
补 1 条 S93 断言即可：`collab_request_owner { bid }`（无 `issuePath`）+ 同 bid 的 followUp → 1 行。

**B**：保留实现，收窄措辞 —— `src/tools/owner-queue.ts:52` 与 `docs/collab.md` §11.12.1 末段
改成「两侧都有 `issuePath` 时按路径合并；只有一侧有路径时按 `bid` 合并的前提是**另一侧也只有 `bid`**」
（读起来别扭，故推荐 A）。

---

## 风险清单

| 级别 | 项 | 说明 |
| --- | --- | --- |
| **P2** | 交叉键不合并 | 上述 Case E/E2/N：同一 `bid` 仍可两行；属于「新增文案 > 实现」的契约不一致 |
| P3 | 去重把提案排序位置推到最新 | 例：`Q@1 + F@100` 与 `2/3/4` 竞争时，本轮渲染 2/3/4，该提案顺延一轮。符合文档口径（去重后按 `at` 升序取前 3），非缺陷 |
| P3 | `unique[unique.indexOf(previous)]` | O(n²) 且依赖对象同一性（n ≤ 53，安全）；可读性可改 `Map<key, index>`，无功能影响 |
| P3 | 队列项可「顶替」同提案的追加行 | 队列较新时本轮只显示队列摘要，追加下一轮再出现（不丢信息；R2 设计如此） |
| P3 | 大小写等价不合并 | `DOCS/ISSUES/x.md` 与 `docs/issues/x.md` 视为两个键；只可能来自手改队列文件（followup 侧在 Linux 上会校验失败）。不在 R1 范围 |
| — | 数据/权限 | 无迁移、无权限改动、无投递；`BUILTIN_PROTECT` 未改 |

## 复现方式

```bash
# 自写假 ctx：34 条断言（含 3 个 [observed] 缺口复现）
node .trellis/tasks/11-18-collab-hint-dedupe/research/dedupe-check.mjs

# 非受保护 / protected-child 旧 vs 新逐字节对比
git archive HEAD | tar -x -C /tmp/base && ln -s "$PWD/node_modules" /tmp/base/node_modules
(cd /tmp/base && ./node_modules/.bin/vp pack)
DIST=/tmp/base/dist/index.js node .trellis/tasks/11-18-collab-hint-dedupe/research/compare-inject.mjs > /tmp/old.txt
DIST=$PWD/dist/index.js    node .trellis/tasks/11-18-collab-hint-dedupe/research/compare-inject.mjs > /tmp/new.txt
diff /tmp/old.txt /tmp/new.txt
```

> 本报告为**只读复核**：未修改任何实现/测试/文档文件，未 `git add` / `commit` / `push`，
> 未向任何受保护会话投递消息，未改权限。

## 附：复核时的改动清单

```
 M CHANGELOG.md
 M README.md
 M docs/collab.md
 M package.json
 M skills/collab/SKILL.md
 M src/constants.ts
 M src/core/chain.ts
 M src/core/followup.ts
 M src/core/owner-queue.ts
 M src/tools/followup.ts
 M src/tools/owner-queue.ts
 M test/handoff-harness.mjs
?? .trellis/tasks/11-18-collab-hint-dedupe/
```
