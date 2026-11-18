# 独立复核报告：C1 资源租约（`collab_lock` / `collab_unlock` / `collab_locks`）

- 任务：`.trellis/tasks/11-18-collab-lease`（父任务 `11-18-collab-coordination`）
- 复核者：独立 Check 子代理（冷上下文；**只审不改**，未 commit / 未 push / 未 git add）
- 复核时间：2026-11-18 10:44–11:00
- 复核对象：`git status` 中未提交的 15 个改动文件 + 2 个新文件（见 §8）
- 复核方式：**自写独立脚本**，不复用 `test/handoff-harness.mjs` 的任何断言
  - `/tmp/opencode/lease-review.mjs`（77 项，直接驱动 `src/core/locks.ts` + `src/tools/locks.ts`，伪造时间用 `now` 入参、伪造 ctx 用 Proxy）
  - `/tmp/opencode/lease-probe.mjs` / `lease-probe2.mjs` / `lease-probe3.mjs`（对抗性探针：跨进程竞争、短锁超时、>50 排队、shared 饥饿、临时目录污染）
  - 隔离数据目录：`COLLAB_LOCK_DIR=/tmp/opencode/lease-*-locks`（真实 `~/.config/opencode/collab-locks` 全程未被创建）

## 结论

**通过，可提交。** 10 项必查全部通过（其中 1 项附带 1 个低频边界缺陷、3 项文档 nit，均不阻塞验收）。
R1–R7 与验收标准逐条有独立证据；回归 498/498 + 12/12 + skills ok + typecheck 全绿；
范围仅落在允许清单内，未动 `BUILTIN_PROTECT`、未动 handoff 语义、未加依赖。

---

## 逐项证据

### 1. 原子性 —— **通过**

| 证据 | 位置 |
| --- | --- |
| 短锁 `open(…,"wx")` + 2s 等待 + 2s 过期清理 + 超时无保护兜底 | `src/core/locks.ts:341-385`、`src/core/locks.ts:387-393` |
| `tmp + rename` 原子替换 | `src/core/locks.ts:300-308` |
| 常量（2s / 2s / 50 条历史） | `src/constants.ts:205,207,209` |

- **1a/1b/1c/1d**：同进程 5 路并发 exclusive → `held=1 busy=4`；4 个失败方均拿到 winner + 正剩余 TTL；
  记录 `holders=["ses_a"]`、`history` 仅 1 条 `acquire`。
- **1f（跨进程，真 OS 并发）**：4 轮 × 5 个 `node` 子进程 → 每轮 winner 数 `[1,1,1,1]`。
- **1g（崩溃遗留短锁）**：手工造 `.lock`（mtime −30s）→ 0ms 内清理并成功；`finally` 后文件消失。
- **1g（短锁被真占用）**：手工造 fresh `.lock` → 等待 **2004ms** 走超时兜底后仍写出完整记录
  （`holders=["ses_h"]`、`expiresAt>0`），未产生半条记录。
- **1e**：一次并发风暴后目录内无 `.tmp` / `.lock` 残留。
- 对抗探针 P1（5 进程 + 预置 fresh 短锁）与 `lease-probe2`（6 轮 × 8 进程 + **启动屏障**最大化同时性）：
  **0/6 轮出现 >1 winner**（全部 `winners=1`，`disk` 与报告一致）。超时兜底的理论 lost-update 窗口未复现，见风险 R-2。

### 2. 互斥矩阵 —— **通过**

判定集中在 `src/core/locks.ts:507-595`（1 幂等 / 1 free / 2 shared join / 3 conflict）。

| 组合 | 实测 |
| --- | --- |
| exclusive × exclusive | 第 2 个 `busy`，`holders=["ses_m1"]` |
| exclusive → shared | `busy`，回报 exclusive 持有者 |
| shared × shared × shared | 3 个共存（`["ses_s1","ses_s2","ses_s4"]`）|
| shared 组 → exclusive（反向） | `busy`，回报组内 2 个持有者 |
| shared 组内 1 人释放 | 组存活（`ses_s1,ses_s4`）|
| exclusive 释放后 | 另一个 exclusive 立即获得 |

### 3. TTL —— **通过（含一处与文档一致性的确认）**

- 默认 15min：`normalizeTtl(undefined)=normalizeTtl(0)=normalizeTtl('abc')=900000`（`src/core/locks.ts:287-291`，`src/constants.ts:199`）。
- 夹取 `[10s,2h]`：`1→10000`、`10^10→7200000`、边界 `10000→10000`。
- `expiresAt = now + ttl`；`now+ttl−1` 仍 `busy`（剩余 1ms），`now+ttl+1` 下一个申请者直接获得（无需人工清理），
  `history` 出现 `{"event":"expire","sid":"ses_t1","at":expiresAt}`（`reap` `src/core/locks.ts:398-413`）。
- **`collab_locks` 只读已坐实**：先落一条 `expiresAt` 已过期的记录，调用 `collab_locks` 前后
  **字节串完全相同、mtime 未变**，输出 `- named:readonly  free … 剩余=-  ttl=-`（`src/tools/locks.ts:303-341`）。
  与 `docs/collab.md:655-656`「`collab_locks` 里过期即显示 `free`，下一次 `collab_lock` 回收」**一致**（显示 free 但不落盘，属设计语义，非“与文件不一致”）。
- `stateOf(record, now)` 只做内存 `reap`，不写盘（`src/core/locks.ts:422-444`）。

### 4. 排队 —— **通过**

`src/core/locks.ts:511-540`（不插队 / 出队）、`599-615`（入队保序）、`577-587`（冲突入队）。

- 申请顺序 1 → 2；重复 `wait`（且改 mode）**保留原排位**且不重复入队。
- 释放后资源 `free` 但队列保留：新人 `wait:false` → `busy`（`holders=[]`，提示“有人在排队”），**不能插队**。
- 队首下次申请即获得，写 `leave` 并从队列移除，队列保持 `ses_q3`。
- 新持有者不会被“自动授予”队尾（`4h` 仍 `busy`），队尾在其释放后获得（`4i`）。
- 不主动叫醒：释放路径不调用任何 `ctx`（见 §8 的 0 次 ctx 访问）。

### 5. 幂等 —— **通过**

`src/core/locks.ts:506-509`：

- 同 sid 重复申请（改 `ttlMs=2h`、改 `mode=shared`、带 reason）→ `status=held, renewed=true`；
- `holders` 仍 1；`acquire` 历史仍 1 条；
- **TTL 不延长**（`expiresAt` 仍 `t0+60000`、`ttlMs` 仍 60000）、**mode 不被静默升降级**（仍 `exclusive`，文案显式提示）；
- 非持有者释放被拒（`ok:false`），持有者正常释放。

### 6. `file:` 校验 —— **通过**

`src/core/locks.ts:123-171`（`canonicalFile`）、`182-202`（分派）。

| 场景 | 实测 |
| --- | --- |
| `file:sub/x.ts` vs `sub/x.ts` | 同一资源 `file:sub/x.ts` |
| 缺失文件 `file:sub/not-yet.ts` | **允许**（最近存在祖先校验）|
| 目录 `file:sub` | 允许（可租目录）|
| 绝对路径 | 拒绝（`绝对路径`）|
| `..` / `.` / `file:.` / `sub/../../etc/passwd` | 拒绝（`不能包含 .. / .`）|
| 软链叶子 `file:link.ts` | 拒绝（`是软链`）|
| `file:linkdir/passwd`（父目录软链指向 `/etc`） | 拒绝（`真实路径越界`）|
| 无 workspace 绝对路径 | 拒绝（fail-closed）|
| 被拒的写法 | **0 个记录落盘** |

### 7. `named:` 别名 —— **通过**

`NAMED_ALIASES` `src/core/locks.ts:75-86` + `canonicalNamed` `101-111`：

`窗口` / `测试窗口` / `窗口:测试` / `TEST-WINDOW` / `  test window  ` → `named:test-window`；
`构建` / `全量构建` / `Build` / `named:build` → `named:build`；
`My Resource` 与 `MY   RESOURCE` → 同一 `named:my-resource`；
`窗口2` 不被误并（`named:窗口2`）。
5 种写法并发申请 → **1 winner、1 个文件**（`lease-probe` P3）。

### 8. 安全 —— **通过**

- `[protected*]` **可持有**；冲突输出含 `ses_protected_line [protected]` + `不可抢占`（`src/tools/locks.ts:200-209`、`src/core/locks.ts:692-703`）。
- 他人调用 `collab_unlock` → `未释放`，记录 holder 不变；`collab_unlock` schema **无 force**（`additionalProperties:false`，字段仅 `resource,confirm`），`collab_lock` 同样封闭（`src/tools/locks.ts:95-119,232-238`）。
- `reason`：`'  a\0b\nc\x07d  '+500×x` → `"a b c d xxxx…"`，长度恰 200，无控制字符（`src/core/locks.ts:89-95`）；预览文案也无控制字符。
- 非法 `mode` 被拒（`mode 只能是 exclusive 或 shared`）。
- **锁不产生任何消息投递（构造断言）**：假 `ctx` 用 Proxy，访问除 `location` 之外任何属性即抛错；
  三个工具（含 preview/held/busy/queued/unlock/列表全路径）执行完毕 **ctx 访问次数 = 0**（`8i/8j`）。
  与 harness「prompts +0」互为独立证据。

### 9. 回归 —— **通过**

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
=== 498/498 checks passed
=== 12/12 checks passed
skills ok
EXIT=0
```

（在评审期间 `skills/collab/SKILL.md` 被主会话并发改了一行描述（十二→十五），**改后重跑仍全绿**；
`git diff -U0 test/handoff-harness.mjs | grep '^-[^-]'` 为空 → 既有断言无删改，只有追加。）

### 10. 范围 —— **通过**

- 改动文件：`src/core/locks.ts`(新) `src/tools/locks.ts`(新) `src/tools/{index,list}.ts` `src/constants.ts`
  `src/types.ts` `src/index.ts` `test/{handoff-harness,readonly-default}.mjs` `docs/collab.md`
  `skills/{collab,collab-coordination}/SKILL.md` `README.md` `CHANGELOG.md` `package.json` + 本任务目录。
- `BUILTIN_PROTECT` 零改动（`git diff src/constants.ts | grep PROTECT` 为空）；未触碰 handoff/claim/chain。
- `pnpm-lock.yaml` 未改、`package.json` 仅 `version`+`description` → **无新依赖**。
- `muke-pos-app`：本任务未写入（其 `M mcp` 是子模块脏标记、0 行 diff；`docs/issues/*` 未跟踪文件 mtime 为 8/10/11-13，属其它会话）。
- 归档任务：`.trellis/tasks/archive/**` 无改动。
- 观察：`.trellis/tasks/11-18-collab-sidebar/{design,implement}.md`（10:29，未跟踪）属**下一个子任务**的
  规划产物，不是本任务实现代码 —— 提交时**不要**一起 add。

---

## 原始输出（节选）

```
$ node /tmp/opencode/lease-review.mjs
=== 1. atomicity: 5 concurrent exclusive acquires (in-process) ===
✓ 1a five concurrent exclusive acquires → exactly one winner — held=1 busy=4
✓ 1d exactly one acquire history line — [{"sid":"ses_a","at":1700000000000,"event":"acquire"}]
=== 1f. multi-process race (5 processes × 4 rounds) ===
✓ 1f 4 rounds × 5 processes → exactly one winner each round — [1,1,1,1]
=== 1g. guard: stale leftover vs live guard ===
✓ 1g a stale `.lock` from a crash is swept and the acquire succeeds — held in 0ms
✓ 1g a live guard is waited on (~2s timeout), then proceeds — held in 2004ms
=== 3. TTL ===
✓ 3d 1ms before expiry the lease is still held — busy 1
✓ 3f … and history carries `expire` for the old holder — [acquire, expire, acquire]
✓ 3h … and neither rewrites the record nor touches its mtime — true/true
=== 4. FIFO queue ===
✓ 4e a newcomer cannot jump a free-but-queued resource — busy holders=[] waiters=2
✓ 4f the head waiter gets it on its next attempt — held
=== 5. idempotency ===
✓ 5c the TTL is NOT extended and the mode is NOT silently switched — {"expiresAt":1700000060000,"ttlMs":60000,"mode":"exclusive"}
=== 8. security / no delivery ===
✓ 8d the conflict names the holder, marks [protected] and refuses preemption
✓ 8j locks never touch ctx at all (0 delivery paths exercised) — 
=== 77/77 independent checks passed
```

```
$ node /tmp/opencode/lease-probe.mjs
P1 winners reported: 1; on disk: ["ses_gb3"]
P2 waiters=50 head=ses_w10 tail=ses_w59 (enqueued 60, cap is 50)
P2 the dropped waiter #0 (ses_w0) re-applying: status=busy holders=["ses_holder"] ahead=-
P3 alias race: held=1 files=1
P4 real lock dir exists=false entries=0

$ node /tmp/opencode/lease-probe2.mjs      # 8 进程 + 启动屏障，走短锁超时路径
round 0..5: winners=1 / winners=1 / winners=1 / winners=1 / winners=1 / winners=1
rounds with more than one reported winner: 0/6

$ node /tmp/opencode/lease-probe3.mjs
P5 preview left 0 new file(s); lock preview mode=true unlock preview=true recordExists=false
P6 missing dir: 没有资源租约（目录 …）。可用: collab_lock { resource:"test-window", confirm:true }
P7 queued writer ahead=1; later shared joins=5 holders=6 writerStillQueued=true expiresAt extended by 5000ms
P8 allLocks ignores a crashed .tmp: true; leftovers=1
```

---

## 风险清单（均非阻塞）

| # | 级别 | 问题 | 证据 | 建议 |
| --- | --- | --- | --- | --- |
| R-1 | **低（可复现的真缺陷，边界）** | **排队 >50 人时最老的等待者被静默丢弃**：`waiters` 用 `slice(-LOCK_HISTORY_LIMIT)` 截尾，被丢的正是队首。被丢的会话再申请得到 `busy`（不知道自己已不在队列里），永远不会被“轮到”。 | `src/core/locks.ts:265`（`normalizeLock`）、`src/core/locks.ts:612`（`enqueue`）；探针 P2：入队 60 → `head=ses_w10`，`ses_w0` 再申请 `status=busy ahead=-` | 队列不要与 history 共用上限：要么不限队长，要么独立上限（如 200）并对被逐出者写 `history: leave` + 在返回值里明示「你的排队已被移除」。50 个会话同时排一个资源现实中罕见，故列低。 |
| R-2 | 低 | 短锁 **超时兜底“无保护推进”**（`src/core/locks.ts:360-366`）理论上允许两个跨进程调用者都读到 free 并各写一次 → 双方都被告知“已获得”（lost update）。 | 4 轮×5 进程 + 6 轮×8 进程（启动屏障）**未复现**（0/10 轮 >1 winner）；实现说明已自陈该取舍（`research/impl-notes.md:29-31`） | 加固成本极低：`acquire` 写完后 `readLock` 自检，若 `holders[0] !== sid` 则返回 `busy`；或超时路径直接 fail-closed（返回“忙，请重试”）。不阻塞。 |
| R-3 | 低（设计后果） | `file:` 资源 id **不含 workspace 前缀**（`file:<相对路径>`）：两个不同 workspace 的同名文件会争同一把锁（**假冲突，安全方向**）；反之若某会话 `location.directory` 是仓库子目录，同一文件会得到不同资源（**漏合并**）。 | `src/core/locks.ts:142,170`（`relative(realRoot, …)`）；`src/tools/locks.ts:23-28` 取 `ctx.location.directory` | 保持现状可接受（宁可多锁不可少锁）；若将来出现子目录会话，考虑把 workspace 的 `basename`（或仓库名）纳入 `file:` id。 |
| R-4 | 低 | shared 组「后加入者延长组到期」→ 已排队的 exclusive 可能被持续到期的 shared 加入者**饥饿**（文档未承诺读写公平性）。 | `src/core/locks.ts:561-570`；探针 P7：5 次 shared join 把 `expiresAt` 延长 5000ms，writer 仍在队列 | 在 docs §11.10.3 补一句「shared 组对排队中的 exclusive 不保证公平，需要独占请尽早 `wait:true`」即可（可选）。 |
| R-5 | nit（文档） | `src/index.ts:29` 注释仍写 “the twelve native `collab_*` tools”（实际 15）；`skills/collab-coordination/SKILL.md:77` 写「TTL 必填」，而 `ttlMs` 是可选（默认 15min）。 | `src/index.ts:29`、`skills/collab-coordination/SKILL.md:77` | 注释改 `fifteen`；表格行改为「TTL 必须有界（默认 15min，上限 2h）」。不影响行为与验收。 |
| R-6 | nit | 崩溃在 `writeFileSync`→`renameSync` 之间会留下 `<hash>__<slug>.json.<tok>.tmp`，`allLocks` 忽略但**永不清理**（仅磁盘垃圾）。 | `src/core/locks.ts:304-306`；探针 P8 | 下次写同一资源时顺手删同前缀 `.tmp`，或在 `allLocks` 里清理 mtime 超 1h 的 `.tmp`。 |
| R-7 | nit | 手工/rcon 破坏的记录（`holders` 非空但 `expiresAt=0`）在 `reap` 里被直接返回 → **永不过期**（正常路径不可达）。 | `src/core/locks.ts:399`（`!record.expiresAt` 早退） | 可选：`expiresAt=0 && holders.length` 视为损坏，按 `acquiredAt+ttlMs` 兜底或强制回收。 |

### 与设计/PRD 的偏差（复核结论：**接受**）

1. 设计 §5 写了 `collab_unlock { force? }`，实现**完全不提供 force**（PRD R6 要求“force 需 owner 显式、默认拒绝”）。
   实现更严格（工具面无法表达抢占），`research/impl-notes.md:56` 已记录。**接受**，但属“实现比设计更严”，
   若后续需要人工抢占的逃生口，应作为新需求另议。
2. PRD R5 说「`collab_list` 追加当前会话的持有与等待」——已实现（`src/tools/list.ts:150-160,187-197`），
   harness S87e 覆盖“我持有 / 我排第 1 位”。
3. 设计 §2 末句「同一文件绝对/相对路径归并」与 §6「拒绝绝对」冲突，实现选“拒绝绝对”（更安全），
   `docs/collab.md:643-646` 已写明。**接受**。

---

## 是否可提交

**可以提交**（建议由 owner 复核后提交，提交范围**只含**本任务 §10 列出的文件）。

- 阻塞项：0
- 建议随提交一同修的可选项：R-5（两行文档注释），其余 R-1/R-2/R-6/R-7 建议登记为后续 hardening 任务，
  R-3/R-4 建议在 docs 补一句边界说明。
- 提交注意：`.trellis/tasks/11-18-collab-sidebar/**`（下一子任务的 design/implement）与
  `muke-pos-app` 的既有脏文件**不要**一并 add；`skills/collab/SKILL.md` 的一行描述改动是主会话并发写入，
  与本任务同向（十二→十五），可一同提交。

### 复核者未做的事（按派单约束）

- 未修改任何实现文件 / 文档 → 因此本报告不含“已修复项”（0 处自修）。
- 未 commit / push / git add / restart；未向受保护会话投递；未改任何会话权限。
