# 独立复核报告 — 一致性修复（11-19-collab-consistency）

> 角色：独立复核（冷上下文，只审不改）。
> 方法：读 PRD §R1–R6 / design §1–§6 / implement.md，然后**自己写探针**（临时 `COLLAB_LOCK_DIR` + 假 ctx，
> 不复用实现方测试）复现每一条；再跑实现方全量回归与 3 组变异。
> 约束遵守：未 commit / push / git add；未修改任何实现或测试文件；未碰真实 `~/.config` 与真实会话。

## 结论

**可提交（无阻塞）。** R1–R6 的核心行为全部复现成立，回归 797 条全绿，三组变异都能让对应用例真实失败。
附 **2 条 P3 建议**（非阻塞，建议随手修）：非默认 `waiterTtlMs` 下 `collab_lock` 回执的 `[stale]` 判据不一致；
R2③「任何 collab 工具调用」只落了主要写工具（文档用「等」略宽）。详见「发现清单」。

## 环境与对象

- 路径：`/data/project/collab`，HEAD `d1f5316`，工作区 23 改 + 1 新增（`src/core/counts.ts`），未提交。
- 版本：`package.json` / `PLUGIN_VERSION` 均 **0.5.3**（未改）；工具数 **17**；`package.json` /
  `pnpm-lock.yaml` 无改动（无新依赖）。
- 我自己的探针：`research/evidence/probe-consistency.mjs`（34 条断言，全 PASS）、
  `research/evidence/probe-ttl-display.mjs`（[stale] 判据不一致复现）。
- 原始输出：`research/evidence/`（probe-final.log / full-suite.txt / mut*.txt）。

---

## 8 项逐条

### 1. 死锁真解了 — **通过**

证据（`file:line`）：

- `src/core/locks.ts:483` `reapWaiters()`：`now - waiter.at > ttl` 的 waiter 被删，并写
  `history: {event:'leave', reason:'stale'}`。
- `src/core/locks.ts:678` `acquire()` 在**公平性判定之前**：`reapWaiters(reap(base, now), now, waiterTtlMs)`。
- `src/core/locks.ts:700` 决策 1 的 `record.waiters` 已是回收后的列表 → 僵尸不再挡路。

我的探针（`probe-final.log`，自造 lock 文件）：

```text
PASS | 1a free + 3 over-TTL waiters → granted | 已获得资源租约: named:stale-queue
PASS | 1b the 3 expired waiters are gone | []
PASS | 1c each reaped waiter leaves history reason=stale | [{"sid":"ses_x2",...,"event":"leave","reason":"stale"},...]
PASS | 1d free + 1 fresh waiter → wait:false still refuses the newcomer (no jump) | 未获得资源租约: named:fresh-queue（资源空闲，但有人在排队）
PASS | 1e wait:true queues behind the fresh waiter (position 2) | waiters=["ses_w1","ses_d"]
```

即：**free + 3 个超 TTL waiter → 直接授予并清空**；**free + 1 个新鲜 waiter → 新人不能插队**（`wait:true` 排第 2）。

### 2. 心跳（三来源 / 30s 节流 / 读命令不刷 / 开关）— **通过（R2③ 见 P3-2）**

证据：

- ① `src/tools/locks.ts:183`（`confirm` 之后、`acquire` 之前）`touchWaiters(sid, now)`。
  预览分支在上面提前 return，**预览零写入**（`src/tools/locks.ts:155` 只调 `stateOf`）。
- ② `src/index.ts:153-160`：`createContextHook` 外包一层 `touchWaiters(event.sessionID)`，
  `config.waiterHeartbeat !== false` 才执行，异常吞掉（不拖垮模型请求）。
- ③ `src/tools/shared.ts:550`（`dispatch`：`collab_send` / `collab_reply`，也被 `handoff.ts:156` 复用）、
  `src/tools/shared.ts:705`（`deliverAsk`：`broadcast.ts:151/327/391` 的投递）→ 写类主要调用会 touch。
- 节流 `src/core/locks.ts:539`（内存）+ `:565` 写后记账；持久 `at` 也参与判据，重载后仍节流。

我的探针（三条来源各自独立 sid，避免互相掩盖）：

```text
PASS | 2a collab_lock refreshes the waiter heartbeat | 1795049744987 → 1795050044987
PASS | 2b 30s throttle: immediate second call does not move the heartbeat | 1795050044987/1795050044987
PASS | 2c context hook refreshes the heartbeat | 1795049745004 → 1795050045020
PASS | 2d context hook within 30s writes nothing | mtime 未变
PASS | 2e a writing collab tool refreshes the heartbeat | 1795049745037 → 1795050045056（collab_send）
PASS | 2f collab_locks is not a heartbeat (no write)
PASS | 2g waiterHeartbeat:false → context hook writes nothing | mtime 未变
```

### 3. 读命令零写入 — **通过**

- `stateOf`（`src/core/locks.ts:577`）只读；回收只在 `acquire`。
- 我的探针用**全部 lock 文件 mtime + sha1** 对比：

```text
PASS | 3a collab_locks leaves every lock file byte-identical
PASS | 3b snapshot RPC leaves every lock file byte-identical | snapshotKeys=at,sessions,locks,handoffs,queue,reachable
PASS | 3c snapshot exposes the optional waiter fields
```

### 4. 四数口径 — **通过**

- `src/core/counts.ts:46` `countsOf`：`held = locks.filter(holders.length>0)`、`waiting = Σwaiters`、
  `protected = queue.length`；`src/core/counts.ts:62` `pendingCountOf`（try/catch，无 API / 抛错 → 0）。
- GUI 会话头 `src/gui.tsx:520`（`countsOf(data)` + `hostPending(ctx.sessions.current())`），
  `hostPending` 在 `src/gui.tsx:480`：读 `session.server.data.session.pending`、首次 `sync`（`void … .catch(()=>{})`，同步抛错也 try/catch → 0）、同一 session 不重复 sync。
- TUI 侧栏 `src/tui.tsx:546-548`、面板 `src/tui.tsx:393-397 + 453`，同源 `countsOf` / `pendingCountOf`。

我的探针：

```text
PASS | 4a countsOf: held = holders>0, waiting = Σwaiters, protected = queue | {"held":1,"waiting":3,"protected":2}
PASS | 4c pendingCountOf: throwing list → 0 (no throw)
PASS | 4d pendingCountOf: missing api → 0
PASS | 4e pendingCountOf: counts the host queue
PASS | 4f GUI header uses countsOf + host pending
PASS | 4g TUI sidebar + panel both use countsOf + pendingCountOf
```

实现方用例给出 `1 held + 3 waiters + 2 owner-queue + 1 宿主 pending` 的精确串（PN5 / R4）：
GUI `持有 1 · 排队 3 · 待受保护 2 · 宿主排队 1`；TUI 侧栏 `锁 1 · 排 3 · 待 2 · 宿 1`；面板同长串 + 图例。

### 5. 去重（send / reply / 61s 补发 / 0 关闭）— **通过**

证据：`src/tools/shared.ts:368` `findDuplicateSend`（record.replies 最近 3 条 → thread 尾部 20 条 → 进程内 memo），
`src/tools/shared.ts:525-548` 在**预览之后、投递之前**判定；命中直接 return（不投递、不追加、不写 memo）。
`normalizeSendBody` 折叠空白。

我的探针（`Date.now` 只在探针内可控推进，真实行为未改）：

```text
PASS | 5a first send is delivered
PASS | 5b same thread + normalised body <60s → not delivered | 未重复投递: thread t_probe_dedupe 在 60s 内已有同文…
PASS | 5c the duplicate is not appended to the thread either | msgs=1
PASS | 5d a different body is delivered
PASS | 5e collab_reply: same body <60s → not delivered | 已投递 … || 未重复投递 …
PASS | 5f 61s later the same body is delivered again | 已投递 → ses_bbb …（不误杀正常补发）
PASS | 5g dedupeWindowMs:0 disables the check (2 deliveries)
```

### 6. 兼容性（旧 lock 记录 / 旧 server 回包）— **通过**

```text
PASS | 6a old record with a very old `at` is reaped, no crash
PASS | 6b a waiter without `at` is treated as stale, no crash
PASS | 6c a non-numeric `at` renders (does not throw) | waiters=ses_legacy3#1:exclusive(498625h00m)[stale]
PASS | 6d countsOf works on an old snapshot without the new fields
PASS | 6e buildSnapshot is still exported (no signature break)
```

- 额外：`waiters` 键整体缺失的旧文件也能读（`readLock` 归一化为 `[]`，我单独验证）；
  `normalizeWaiterTtl(0/-1/'x'/undefined) → 600000`，`1000 → 60000`，`1e9 → 3600000`（夹取正确）。
- 快照新字段 `waiterAgeMs / staleWaiters / stale` 在 `src/rpc.ts:64-69` 声明、`:164-169` schema 注册，
  且**都不在 `required`**（`snapshot-shape` C2 断言覆盖）。

### 7. 回归与范围 — **通过**

必跑命令（`research/evidence/full-suite.txt`）：

```text
=== 657/657 checks passed      (handoff-harness)
=== 12/12 checks passed        (readonly-default，未改)
=== 42/42 checks passed        (snapshot-shape)
=== 32/32 checks passed        (tui-render)
=== 47/47 checks passed        (gui-entry)
=== 7/7 panel checks passed    (gui-panel)
skills ok                      (check-skill)
pnpm build / pnpm typecheck    EXIT=0
```

合计 **797**（预期 657+12+42+32+47+7）。工具数 17（`src/tools/index.ts` 列表 + setup 日志 `tools=17`）；
版本 0.5.3；`package.json`/lock 无 diff。

范围：`types.ts` / `rpc.ts` / `core/snapshot.ts` 的改动均为 design §1「派生字段 + 可选快照字段」的必要落点，
只追加可选字段，未改既有字段语义。未动 `BUILTIN_PROTECT`、未新增工具/依赖。
`docs/issues/bugs-gui-poll-inflight-stale-session.md` 无改动（`git status docs/issues` 为空；gui-entry R7 轮询用例 47/47 仍绿）。

### 8. 测试真实性（3 组变异）— **通过**

| 变异 | 做法 | 结果 |
| --- | --- | --- |
| 删 `reapWaiters` | `locks.ts:678` → `reap(base, now)` | harness **653/657**，4 条 ✗（含「free+3 过期 waiter」复现生产症状「资源空闲，但有人在排队」） |
| 删去重 | `shared.ts` 去重窗口恒 0 | harness **653/657**，4 条 ✗（同文 2 次投递 / thread 被追加 / reply 未去重） |
| `held = locks.length` | `counts.ts:50` | gui-panel **6/7**、tui-render **30/32**、snapshot-shape **41/42**，共 4 条 ✗ |

三次变异后均从备份还原，`sha1sum` 与还原前一致；随后**重新 build + 全量重跑仍 797 全绿**。
既有用例：`expect(` 出现次数 535 → 554（+19，正好 S95），**没有删除任何既有 expect 块**；
仅 S87 的排队显示断言按 R3 契约改为带年龄（1 条表达式文本），以及 tui/gui-entry 的文案串随 R4 更新。
S95 的 19 条断言基于**真实磁盘记录 / prompts 计数 / thread store**，不是断言实现自己写出的字符串；
我的探针用不同 fixture 独立复现了同样结论。

---

## 发现清单（均为 P3，不阻塞）

**P3-1（建议随手修）`collab_lock` 回执的 `[stale]` 判据与配置不一致。**
`acquire()` 内部 `stateOf(...)`（`src/core/locks.ts:682/700/722/741/752/770/778`）没有传 `waiterTtlMs`，
落回内置 10min；而预览（`src/tools/locks.ts:155`）和 `collab_locks`（`:391/:396`）用 `config.waiterTtlMs`。
复现（`probe-ttl-display.mjs`，`waiterTtlMs: 3600000`，waiter 心跳 20min）：

```text
预览:   waiters=ses_w20#1:exclusive(20m)                 ← 未标 stale（正确）
确认:   waiters=ses_w20#1:exclusive(20m)[stale],...        ← 误标（acquire 用了默认 10min）
collab_locks: waiters=ses_w20#1:exclusive(20m)          ← 未标（正确）
```

影响：仅显示（回执多一个 `[stale]`、`describeState` 可能说「下一次 collab_lock 回收」但本次未回收），
且只在 `waiterTtlMs > 10min` 的非默认配置下出现。修法：把 `waiterTtlMs` 传进 `acquire` 内的 `stateOf`。
（`release()` 同样未传，但 unlock 成功回执不打印 `[stale]`，无可见影响。）

**P3-2（文档措辞 / 可选补齐）R2③「任何 collab 工具调用」只覆盖主要写工具。**
实际 touch 的：`collab_lock`、`collab_send`、`collab_reply`、`collab_handoff`、`collab_broadcast`（复用 `deliverAsk`）。
未 touch 的写类工具：`collab_request_owner`、`collab_accept`、`collab_followup`、`collab_grant`、`collab_promote`、
`collab_report`、`collab_archive`（`collab_unlock` 亦无，但释放方无需保号）。
实用影响小（② `context` 钩子每轮都刷），但 `docs/collab.md` §11.10.6 与 CHANGELOG 用「…等 / 任何」，
比实现宽。建议：要么在 `src/index.ts` 注册处包一层统一 touch（本项目允许的文件内可做），要么把文档改成
「`collab_send` / `collab_reply` / `collab_handoff` / `collab_broadcast`」。

**P3-3（低）配置 typo 的方向与工具入参不一致。**
`config.ts:94` 对 `waiterTtlMs` 直接用 `clamp`：非数值（如 `"10m"`）→ 回落到**下界 1min**（比默认 10min 激进得多）；
而 `normalizeWaiterTtl` 对非数值回落默认 10min。JSON 里写错单位会让所有排队者在 1 分钟后被回收。
建议 config 侧也走 `normalizeWaiterTtl`（或先判 `Number.isFinite` 再回落默认）。

---

## 风险清单（已知 / 设计内，需要知情而非返工）

1. **升级瞬间的旧队列**：旧 lock 文件的 `at` = 入队时间 → 升级后第一次 `acquire` 会把「30 分钟前入队但一直在等」
   的真人 waiter 当僵尸清掉。design §1 已明示「可接受」；发布说明里值得写一句。
2. **`snapshot` 的 `[stale]` 用内置 10min**（`src/core/snapshot.ts:85` 不传 options）——运维把 `waiterTtlMs`
   调离 10min 后，侧栏/面板的 `[stale]` 标记与回收阈值不同；只影响显示（impl-notes §8 已声明）。
3. **`touchWaiters` 在 context 钩子里 `await`**：遇到残留 `.lock` guard 时最多加 `LOCK_GUARD_TIMEOUT_MS`
   （2s）到一次模型请求；30s 节流把频率压到每会话每 30s 最多一次，可接受。
4. **空闲即过期**：长时间没有模型请求的排队会话（纯等人、`collab_wait` 长轮询）会在 10min 后被回收。
   这是 R1 的取舍，skill/文档已给「定期 `collab_lock {wait:true}`」的自救办法。
5. **去重的边界**：同 thread 内**两个不同会话** 60s 内发同一句也会被压制；`collab_send` 不带 `threadID`
   不去重；`dedupeWindowMs:0` 是回滚开关。均为 design §3 明示行为。
6. **`pendingSynced`（`src/gui.tsx:478`）会随会话数增长**（每个 session key 一条），无清理；量级可忽略。

---

## 复跑方式（给下一位复核者）

```bash
cd /data/project/collab
node /tmp/opencode/probe-consistency.mjs      # 或 research/evidence/probe-consistency.mjs
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

探针只用临时目录（`mkdtemp`）+ 假 ctx，不读写 `~/.config/opencode`，不触碰任何真实会话。

---

## 增量复核（P3 修复）

> 复核节点：作者对上轮 3 条 P3 的修复（工作区仍未提交）。本轮仍只审不改；探针/变异后均已还原，
> `src/core/locks.ts` / `src/config.ts` 的 sha1 与还原前一致。

### 结论

**修复成立，可提交。** 三条 P3 全部闭环：P3① 用代码修（`stateOf` 全链路带 `waiterTtlMs`）、
P3③ 用代码修（config 不再 `clamp(NaN)→1min`）、P3② 用文档修（③ 逐个列举）。
新增 2 条回归断言**确实会失败**（两次变异各打掉 1 条，658/659），全量 **659 + 12 + 42 + 32 + 47 + 7 = 799** 全绿。
本轮无新发现。

### 1. `probe-ttl-display.mjs` 重跑：三处口径一致 — **通过**

`waiterTtlMs: 3_600_000` + 20min waiter（`research/evidence/ttl-display-after.txt`）：

```text
预览:        holders=ses_h  waiters=ses_w20#1:exclusive(20m)                                   ← 无 [stale]
确认回执:    holders=ses_h  waiters=ses_w20#1:exclusive(20m),ses_new#2:exclusive(0s)           ← 无 [stale]（修复前误标）
collab_locks: waiters=ses_w20#1:exclusive(20m),ses_new#2:exclusive(0s)                         ← 无 [stale]
```

上轮「预览无、确认有、读命令无」的矛盾消失。代码落点：`src/core/locks.ts:683/701/723/742/753`（acquire 全分支）、
`:771/:779`（`queueOrFull` 第 4 参）、`:832-863`（release）。

### 2. typo 一律回落 10min — **通过**

`research/evidence/delta-probe.txt`（我自己的探针，不只跑实现方用例）：

```text
PASS | config waiterTtlMs="10m" → default 10min | got 600000
PASS | config waiterTtlMs="60000" → default 10min | got 600000
PASS | config waiterTtlMs=null → default 10min | got 600000
PASS | config waiterTtlMs=-1 → default 10min | got 600000
PASS | config waiterTtlMs=0 → default 10min | got 600000
PASS | config waiterTtlMs=true / [] → default 10min
PASS | e2e waiterTtlMs="10m": 5m waiter is NOT [stale]
PASS | e2e waiterTtlMs="60000": 5m waiter is NOT [stale]
PASS | e2e waiterTtlMs=60000 (real number): 5m waiter IS [stale]        ← 区分性证据：真 1min 会标 stale
```

「真 1min → stale / typo → 不 stale」这一对把「回落到 10min」与「仍用旧 60min」「被 clamp 成 1min」区分开，
不是自证。代码：`src/config.ts:92-101`（非有限正数 → `DEFAULTS.waiterTtlMs`）、
`src/core/locks.ts:314-320`（`normalizeWaiterTtl` 同样只认同类型有限正数）。

### 3. 反向：显式数值仍夹在 [1min, 60min] — **通过**

```text
PASS | waiterTtlMs=60000 clamps to 60000
PASS | waiterTtlMs=90000 clamps to 90000
PASS | waiterTtlMs=30000 clamps to 60000        ← 未放宽下界
PASS | waiterTtlMs=3599999 clamps to 3599999
PASS | waiterTtlMs=1000000000 clamps to 3600000 ← 未放宽上界
PASS | waiterTtlMs=600000.9 clamps to 600000    ← 仍取整
```

### 4. `release` / `collab_unlock` 与 `acquire` 同源 — **通过**

构造 held(`ses_hold`) + 20m waiter，用**非持有者** `ses_out` 走 unlock（失败分支会打印 `stateLines`）：

```text
60min 配置：preview 无 [stale] / confirm 无 [stale]，两者一致
 1min 配置：preview 有 [stale] / confirm 有 [stale]，两者一致
持有者释放（60min）：已释放资源租约 … 排队 1 人 …，无 [stale]
```

代码：`src/tools/locks.ts:320` `release({…, waiterTtlMs: config.waiterTtlMs})`；`src/core/locks.ts:820-863`
`release` 的四处 `stateOf` 全部带该值。

### 5. 新增 2 条断言真会失败 — **通过（两次变异）**

| 变异 | 结果（原始输出 `research/evidence/dmut*.txt`） |
| --- | --- |
| `queueOrFull` 两处 `stateOf` 去掉 `{ waiterTtlMs }` | **658/659**，✗ `S95 a waiter younger than the configured TTL is not shown as [stale] in the confirm receipt — waiters=ses_s95t20#1:exclusive(20m)[stale]…` |
| `config.ts` 改回 `clamp(file.waiterTtlMs ?? …)` | **658/659**，✗ `S95 a misspelled waiterTtlMs falls back to 10 minutes (a 5m waiter is not [stale]) — waiters=ses_s95t5#1:exclusive(5m)[stale]` |

两次均只打掉**对应的那一条**，不动其它用例——断言与修复点一一对应。变异后已还原并重新 build。

### 6. 回归 — **通过**

`research/evidence/full-suite-after.txt`：

```text
659/659 · 12/12 · 42/42 · 32/32 · 47/47 · 7/7 · skills ok · build/typecheck EXIT=0
setup ok: version=0.5.3 … tools=17
```

合计 **799**（上轮 797 + 新增 2），工具数 17，版本仍 0.5.3，无新依赖（`package.json` / lock 无 diff）。

### 7. 范围 — **通过**

本轮只有 5 个文件 mtime 晚于上轮报告（09:05）：`docs/collab.md 09:07`、`src/tools/locks.ts 09:07`、
`src/config.ts 09:10`、`test/handoff-harness.mjs 09:12`、`src/core/locks.ts 09:13`；
`src/tools/shared.ts` / `src/core/counts.ts` 的 sha1 与上轮备份**逐字节一致**，其余 16 个改动文件 mtime 未变。
`git diff --stat` 只在这 5 个文件上增长（1342→1404 / 78→94 行）。`docs/collab.md:770` 的③ 行已改为逐个列举
touch / 不 touch 的工具，与实现一致。

### 本轮风险 / 备注（无阻塞）

1. `normalizeWaiterTtl` 现在拒绝**数字字符串**（`"60000"` → 10min）。工具并不暴露该入参（`collab_lock` 只有 `ttlMs`），
   内部调用传的都是 number，故无用户可见影响；若未来加工具入参，需保持一致的类型约定。
2. 新增的 typo 用例断言的是「不 stale」（默认 10min 与旧 60min 都不会 stale），它抓的是「被 clamp 成 1min」这一原始缺陷；
   我的探针另用「真 60000 → stale」补上了区分性（见 §2）。
3. 上轮风险清单 1/2/4/5 仍适用（升级瞬间旧队列、snapshot 用内置 10min、空闲即过期、去重边界），本轮未改其语义。
