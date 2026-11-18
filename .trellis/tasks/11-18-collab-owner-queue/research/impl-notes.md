# 实现记录：owner 队列 / `expected:research` / 同仓拒广播（0.4.0）

任务：`.trellis/tasks/11-18-collab-owner-queue`
缺陷来源：`d_6180f4ab4fb4368a`（D1 / D3 / D4 成立；D2 已核实不成立，**未改**）

## 1. 改动文件

| 文件 | 内容 |
| --- | --- |
| `src/constants.ts` | `EXPECTED` 增加 `research`；新增 owner-queue 一组常量（目录 / 每目标 50 / summary 500 / 每次 3 行 / 行内 120 / 列表 60 / issuePath 200）；`PLUGIN_VERSION = 0.4.0` |
| `src/types.ts` | `OwnerQueueItem`（`{id,target,from,at,summary,issuePath,bid,revokedAt,seenAt}`） |
| `src/core/owner-queue.ts`（新） | `enqueue / revoke / pruneSeen / readQueueItem / listFor / mineFor / unseenHints / markSeen / sanitizeSummary / validateQueueIssuePath / queueID`；`tmp+rename`；每目标上限 **50 条未读**（满则拒新，不驱逐）；已读项 7 天后在下次写入时回收（每次 ≤20）；`at` 每目标严格递增（同毫秒也保持 FIFO）；`queueDir` 校验 sid（目录名不能含 `/`/`..`） |
| `src/tools/owner-queue.ts`（新） | `collab_request_owner { target?, text?, issuePath?, bid?, id?, revoke?, confirm }`；方向校验、`confirm:false` 零写入、`revoke` 仅发起方、`queueItemLine` |
| `src/tools/index.ts` | 注册第 16 个工具（`collab_handoff` 之后，`collab_accept` 之前） |
| `src/tools/list.ts` | 追加「我提交给受保护会话的请求：N 条待处理（M 条已被目标读到…）」+ ≤3 行明细（已读项标 `· 已读`）+ `…还有 N 条` + 撤回命令（只读）；空会话分支同样输出 |
| `src/core/chain.ts` | `FollowUpHintResult.ownerQueue`（待 stamp 的 `q_…` id）；`injectionFor` 白名单新增 owner-queue 行；`[protected-child]` 也能收到（仍不参与群组）；ask 行动作透传 `expected` |
| `src/hooks/context.ts` | `injectChain` 返回 `ownerQueue`；在 `event.system.push` **成功之后**调用 `markSeen` |
| `src/core/score.ts` | `AGENT_MATCH.research`（`explore/plan/build/review/check/trellis-*` 都算匹配，`research` 对 `build` 合法） |
| `src/core/verdict.ts` | `handoffActions({ expected })`：`research` 时第 ③ 步改为「只读排查，不要改代码，结论写进最后一条回复」；`takeoverBody` 在 `期望：<x>` 后加一行只读说明 + 透传 `expected` |
| `src/tools/shared.ts` | `Kit.capabilityNote(agent, expected)`：只读 agent + `implement` → 能力不匹配提示 |
| `src/tools/broadcast.ts` | `assertOtherWorkspace`（`realpath` 比较，入口最先执行，0 写入）；head 里 research 释义；预览/spawn/结果的 `capabilityNote`；工具描述与 `expected` 枚举说明 |
| `src/tools/handoff.ts` | `expected` 三值说明；预览与结果的 `capabilityNote` |
| `src/index.ts` | 注释 fifteen → sixteen |
| `test/handoff-harness.mjs` | 新增 `COLLAB_OWNER_QUEUE_DIR` 临时目录；S30 改为断言 D4 拒绝 + 直接写记录测注入；新增 **S90–S92（56 项）**；头部文档补 S90–S92 |
| `test/readonly-default.mjs` | 工具清单加 `collab_request_owner`（顺序与注册表一致） |
| `package.json` | `0.4.0`；description：sixteen tools + pull-only review queue |
| `docs/collab.md` | §11.2 十六个工具 + 新行 + `expected` 三值 + 能力不匹配；§11.4 指向队列；§11.4.1 白名单两类；**新增 §11.12 受保护目标请求队列**；§12.3 research 文案与同仓拒绝；§12.5 新增限制 15/16 |
| `skills/collab/SKILL.md` | 工具表行 + `expected` 三值 + 新 §一点六（受保护目标只能排队）+ 硬约束 6/7 + 排障两行 + description |
| `skills/collab-coordination/SKILL.md` | 「何时不用」补一句：广播只跨仓 / 受保护目标走队列 |
| `README.md` | 工具表行、版本兼容表 `0.4.x`、回归说明、`pnpm test` 数字、源码结构、hook 说明 |
| `CHANGELOG.md` | `0.4.0` 条目（Added / Changed / Fixed / 回归 / 文档） |

## 2. 关键设计落点（对应 design §1–§8）

- **零投递**：`enqueue` 只有 `mkdirSync + writeFileSync(tmp) + renameSync`；工具不使用 `ctx.session.prompt`，
  不写 `ctx.storage`、不建 bid/thread/lock。S90 用 `prompts.length` / `bcBids()` / thread key 三重断言。
- **方向**：`protectedAncestor(me)` 命中即拒（含 `[protected-child]`）；目标必须命中，否则提示 `collab_handoff`。
- **summary 清洗**：控制字符 → 空格、空白合并、`slice(0,500)`；因此渲染时不可能多出第二行。
- **issuePath**：只做语法校验（相对、`docs/issues/<name>.md`、无 `..`/绝对路径），**超长直接拒**（不截断，
  避免截断后藏 `..` 或指向别的文件）；读取时再校验一次（防手写/篡改的记录把换行带进受保护会话的注入）。
  不读 fs（目标工作区可能不在本机视图内）。
- **提示**：`unseenHints` 是纯查询（`{lines, ids}`），`hooks/context.ts` 在 `push` 之后 `markSeen`
  （沿用 0.3.1 F1）；`markSeen` 逐条重读（并发 revoke 不复活、已 stamp 的不覆盖）。
- **上限 50**：只统计**未读**（`!seenAt`）——已读项不是 backlog，若计入会让 owner 读完后队列永久占满，
  正是本任务要消除的「无合规路径」。满则 `ValidationError`（不上报缺陷），不驱逐；并发下可能短暂超 1–2 条，
  设计未要求原子配额，未加锁。已读项保留 7 天（`collab_list` 仍可回顾）后按每次 ≤20 条回收。
- **FIFO**：`at` 取 `max(now, 该目标最新 at + 1)`，同毫秒写入也保持插入顺序（注入「按 at 升序」才稳定）。
- **sid 即目录名**：`queueDir` 先做 `^[A-Za-z0-9_-]{1,128}$` 校验，`markSeen`（hook 路径）逐条 try/catch，永不抛出。
- **`research`**：枚举 + `AGENT_MATCH` + 接管文案（push / pull 两版）+ 能力不匹配提示（预览与结果都提示）。
- **同仓广播**：`realpath` 比较（try/catch 回退字符串比较），在 `resolveBroadcastTargets` 之后、
  任何读/写之前；抛 `ValidationError`（可读、不上报）。

## 3. 自检

```
pnpm build      # dist/index.js + dist/gui-experimental.cjs
pnpm typecheck  # tsc --noEmit 通过
pnpm test       # 582/582 harness + 12/12 readonly + 18/18 snapshot
node scripts/check-skill.mjs   # skills ok
```

回归构成：原 526 → 528（S30 增加 2 项 D4 断言；同仓广播用例改写）+ S90–S92 共 **56** 项 = **582**。

## 4. 与 design 的差异 / 取舍

1. **`revoke` 入参**：design §2 写 `{ target, text, issuePath?, revoke?, confirm }`，R3 写
   `{id, revoke:true}`。实现两者都支持：`revoke` 用 `id`，`target` 可省略（省略时在「我提交的」里查）。
2. **`[protected-child]` 的注入**：`injectionFor` 原本对子会话（`info.parentID`）直接返回空。为满足
   「目标可以是 `[protected-child]`」，该早退分支改成：只有**受保护**的子会话返回 owner-queue 行
   （仍不给 followUps / 群组广播），非受保护子会话行为不变。
3. **`issuePath` 超长**：直接拒绝而不是截断（design 只写了校验，未提长度；截断会改变语义）。
4. **读取时二次校验 issuePath**：design 未要求，但注入行会渲染该字段，属防御性加固；无效值渲染为 `-`。
5. **能力不匹配提示位置**：除「结果」外也在 `confirm:false` 预览里出现（写之前就能看到），spawn 分支
   按「将要拉起的 agent」提示。未改 `score` 权重，仅增加提示。
6. **上限语义（复核后补充）**：design 只写「每目标上限 50」。实现把它定为 **50 条未读**，并加 7 天回收：
   否则 owner 读完后 50 个文件永久占满名额，requester 再也提交不了——与 D1 要解决的问题同类。
   S90 覆盖：50 条未读 → 第 51 条被拒；全部标 `seenAt` 后可再写；`seenAt` 超 7 天的项在下次写入时被回收。
7. **已读可见**：`collab_list` 区分「已读」与「未读」（计数 + 明细行 `· 已读`），让 requester 知道对方是否已看到。
8. **FIFO 稳定**：`at` 同目标严格递增，避免同毫秒写入按随机 id 排序（S91 用「追加请求 1/2/3」顺序断言）。
9. **未做的事**：不动 `BUILTIN_PROTECT`；不把队列项转成任务；不加 GUI/侧栏展示；不新增 RPC 字段。

## 5. 协作说明

本任务在实施期间出现过**并发写者**（同一任务被并行派发）：14:41–14:47 另一个会话完成了主体代码/测试/文档，
本轮复核在此基础上补齐上限语义、已读可见、FIFO、sid 校验与文档/计数更新。当前工作区是双方改动的并集，
无冲突遗留（`pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs` 全绿）。

## 6. 回滚

删除 `~/.config/opencode/collab-owner-queue/`（或 `COLLAB_OWNER_QUEUE_DIR` 指向的目录）；
代码 `git restore -- src/ test/ docs/collab.md skills/ README.md CHANGELOG.md package.json`。
队列是独立目录 + 独立模块，回滚不需要迁移任何既有广播/租约/权限数据。
