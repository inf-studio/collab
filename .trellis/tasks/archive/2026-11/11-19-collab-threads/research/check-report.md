# check-report：threads 聚合 + 状态降级（`11-19-collab-threads`）

> 独立复核（冷上下文，只审不改）。被复核对象 = 工作区 `/data/project/collab` 中**未提交**的改动
> （`git status`：15 modified + 2 untracked 源文件）。`research/impl-notes.md` 只作线索，所有结论均来自
> 本人复跑 / 自写探针的原始输出。
>
> 复核过程中**未执行** `git add / commit / push`、未 restart 服务、未动真实会话与用户 mac；
> 全部写入落在临时目录（`COLLAB_THREAD_INDEX_FILE` / 假宿主）与本任务 `research/` 下。

---

## 结论

**可提交（无阻断项）**。9 项必查全部通过；`pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs`
一次跑绿（`823 + 12 + 20 + 50 + 49 + 47 + 17` + `skills ok`，exit 0）；我自己的 2 组变异都被测试抓住。

建议顺手修 3 条**非阻断**项（均为文档事实/极端场景，见 §11 风险清单）：

1. `CHANGELOG.md:186-187` 两组变异的效果描述与实测不符（写「3 条断言红 / 2 条断言红」，实测为 **8 条红** / **进程直接中止**）；
2. `collab_threads { includeClosed:true }` 在「未闭环 ≥ 20」时 0 条已闭环，但首行仍写「本次另列已闭环 ≤3」；
3. `collab_threads` 在返回前对**全部**索引条目串行 `threads.read`（渲染上限 20 不约束读放大）。

---

## 0. 复核环境与既有约

| 项 | 值 |
| --- | --- |
| Node / pnpm | v26.13.1 / 12.21.0 |
| 回归入口 | `pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs` |
| 隔离手段 | `COLLAB_THREAD_INDEX_FILE` / `COLLAB_BROADCAST_DIR` / `COLLAB_CONFIG` / `COLLAB_FREEZE_FILE` 等全部指向 `mkdtemp` |
| 探针留档 | `research/check-probes/p1..p6.mjs`、`mut1/mut2/restored.trimmed.log` |
| 说明 | `.trellis/spec/backend|frontend/quality-guidelines.md` 目前是 `(To be filled by the team)` 占位；实际以 `.trellis/spec/backend/concurrency-locks.md` §2/§5 与既有代码约定（原子 rename、读路径零写入）为判据 |

---

## 1. 索引写点：只在成功投递后写 —— **通过**

写点只有两处，且都在投递之后：

- `src/tools/shared.ts:689-739`：`deliverPrompt()`（`shared.ts:359-365`，失败即 `throw deliveryFailure`）→
  `threads.update`（`:706-719`）→ `recordThread(...)`（`:729-739`）。`confirm:false` 已在 `:671-683` 提前返回，
  protect 拒绝已在 `:575-624` 抛错，去重命中已在 `:631-659` 返回。
- `src/tools/handoff.ts:236-281`：`writeBroadcast` 成功之后才 `recordThread({kind:'handoff', bid})`。

**自写探针（`check-probes/p2.mjs`，假宿主 + 临时索引）原始输出：**

```
PASS preview: index untouched
PASS protect refusal: no index entry, error still readable — 拒绝投递：目标 ses_guarded 本身在 protect 名单内（/tmp/probe-tools-…/
PASS delivery failure: no index entry — 投递失败：boom: provider 500
PASS deduped send (target dimension): no new index entry
PASS successful send indexed
PASS collab_reply indexed (participants sticky, reply direction) — {"target":"ses_peer","kind":"messages","from":"ses_me","lastAt":…,"preview":"a reply from peer"}
PASS collab_handoff indexed as kind=handoff with its bid — t_mwn7latf_rmz2 b_3151157d2132f63d
```

三条件逐一对照要求：**预览**（0 写）、**护栏拒绝**（0 写，且 `.trellis/spec/backend/concurrency-locks.md` §5
「查询在前、拒绝优先……不写索引」满足）、**投递失败**（`session.prompt` 抛错 → 0 写）。
`collab_send` / `collab_reply` / `collab_handoff` 三条路径各至少验一次（reply 方向也验了：`target`/`from`
粘性不变，`kind` 不回退）。

---

## 2. `collab_threads` 正确性 —— **通过**

构造 1 handoff + 2 消息 thread（同一 target）——回归 S102c 原始输出：

```
与 ses_s102_peer 的 thread 3 个（未闭环 3）：
- t_s102_m2  messages  open  15:07  out="S102 消息 thread 2：补充信息"  in=-  ← 建议继续
- t_s102_m1  messages  open  15:07  out="S102 消息 thread 1：请复核 A"  in=-
- t_mwn7k8a1_ojca  handoff  acked  15:07  out="S102 交接：把并行 thread 的清单整理成一张表"  in=-  bid=b_ffaa2ec4a81407ac
建议: 先看 t_s102_m2（消息 thread，最近活动）→ collab_reply {threadID:"t_s102_m2", text:"…", confirm:true}；…
```

- `includeClosed`：S102e 已验证 `t_s102_m1` 回执后 `answered` → 默认列表消失、`includeClosed` 才出现并标「已闭环」，
  且 `in="S102 回执：已复核 A"` 取到真实入站正文。
- **≤20 条 + 「还有 N 个」**（回归未覆盖，我用 `p2.mjs` 补）：25 条并发消息 thread →

```
PASS 20-row render cap + 还有 N 个 notice — 20 rows / …还有 6 个（渲染上限 20；单条用 collab_status {threadID}）
```

- 排序/建议：`src/tools/threads.ts:209-214`（`lastAt` desc → 未闭环在前 → `slice(20)`），
  建议行 `:253-261` 固定指向 `unresolved[0]`。混排（最新是 handoff）时 `p4.mjs` 输出：

```
- t_mwn7n5pl_ib16  handoff  acked  15:10  out="newest is the hand-off"  in=-  bid=…  ← 建议继续
- t_msg_first  messages  open  15:10  out="older message thread"  in=-
建议: 先看 t_mwn7n5pl_ib16（交接单，最近活动）→ collab_status {threadID:"t_mwn7n5pl_ib16"}；…
CHECK suggestion → collab_status for the newest (hand-off) thread: PASS
```

---

## 3. `collab_status` 降级 —— **通过**

`src/tools/status.ts:412-445`：命中广播记录时逐字不变（bid 分支 `:412-419` 未改）；无记录 → `threadEntry` +
`threads.read` 命中即 `messageThreadBlock()`（`:263-318`）；两者都没有才 `throw invalid(原文案)`。

- S102d（消息 thread）：

```
thread t_s102_m2（kind=messages：由 collab_send / collab_reply 建立，没有广播记录）
target: ses_s102_peer  status=open  最近活动=15:07:48  消息 1 条
最近消息（最多 5 条，各 ≤120 字）:
  - 15:07:48 ses_s102…2_me → ses_s102…peer  "S102 消息 thread 2：补充信息"
```
  → `✓ S102 collab_status {threadID: message thread} answers kind=messages instead of refusing`，
  且 `✓ … the old refusal text is gone for a known message thread`。
- 未知 thread 保留原文案（`p2.mjs` 用证据里的**原 ID 形状** `t_mwn15sjw_pr7a` 复跑）：

```
PASS unknown thread keeps the original wording — 没有 thread t_mwn15sjw_pr7a 对应的交接单：threadID 可能拼错，或该 thread 由 collab_send / collab_reply 建立（没有广播记录）。可用 collab_inbox 核对 threadID。
```
- 索引损坏仍能靠 thread store 降级：S102h `✓`（列表退回 1 条广播 join，status 仍 `kind=messages` + 正文）；
  我另做「索引里删掉该行、thread store 保留」：`p2.mjs` → `PASS thread-store-only (no index row) still downgrades to kind=messages`。
  这正好对应证据里的老 thread（0.7.0 之前建立，索引里本来就没有）。
- 关联 handoff：`status.ts:306-310` 用 `entry.bid` → `readBroadcast`，有则给 `state` + 复制的 `collab_status {bid}`，
  记录已回收则注明（S102 未覆盖「记录已回收」分支，代码走读为低风险）。

---

## 4. 只读 —— **通过**

- 回归 S96 式严格宿主（`session.prompt|update|create|remove`、`storage.set|remove` 一旦调用即抛）
  + 索引 `content + size:mtime` + 广播目录快照，四条读命令前后对比：
  `✓ S102 read-only: four queries, zero write calls, index mtime+hash and broadcast dir unchanged — 0 write(s) / index identical`。
- 我另用 **sha256 内容哈希**（回归的 `s96Snapshot` 只有 `size:mtime`）复跑，并把 `storage.set` 也换成抛错：

```
PASS read-only: strict host + index content/size:mtime + broadcast hashes unchanged — 3615:1795072118062.0437 → 3615:1795072118062.0437
```
- 读路径不建文件：`p6.mjs` → `missing file created by reads? false`（`readThreadIndex` 只在写路径 `mkdirSync`）。
- 读路径不删过期条目：`p1.mjs` → `PASS the stale row is NOT deleted by a read (still in the file)`。

---

## 5. 索引健壮 —— **通过**

`check-probes/p1.mjs` 逐条（原始输出）：

```
PASS missing file → {}
PASS recordThread writes normalized preview — {"target":"ses_peer","kind":"messages","from":"ses_me","lastAt":…,"preview":"hello world"}
PASS participants sticky + kind/bid upgraded on reply direction
PASS threadsFor finds it from both sides
PASS reads leave size:mtime:content unchanged
PASS threadsFor filters >7d — ["t_a_1"]
PASS threadEntry filters >7d
PASS the stale row is NOT deleted by a read (still in the file)
PASS cap: 501 → 500, oldest (t_bulk_499) evicted, newest kept — 500 entries
[collab] ignoring unreadable …/collab-threads.json: Expected property name or '}' in JSON at position 2
PASS corrupt JSON → empty + recovers on the next write
[collab] ignoring …/collab-threads.json: unsupported version 2
PASS unknown version → {} (row not trusted)
PASS a write after an unknown version restores version 1
PASS junk entries dropped, unknown kind → messages
PASS array-shaped file → {}
PASS recordThread({threadID:""}) → undefined, no write
PASS COLLAB_THREAD_INDEX_FILE is honoured
```

- 上限：`src/core/thread-index.ts:135-137` 写路径 `sort(lastAt desc).slice(500)`；回归 S102i 同结论。
- 7 天：读路径过滤（`:159`、`:176`），**不删**（`:26-29` 注释与实测一致）。
- 容错：坏 JSON 走 `readJsonFile` 的 `log(...)` 后返回 `undefined` → `:76` 空表；未知 `version` → `:77-82` 空表 + 一条日志。
- 覆盖路径：`src/constants.ts:370-371`（模块加载读取），回归两条测试均靠它隔离（`test/handoff-harness.mjs:290-294`、
  `test/readonly-default.mjs:40`），本人探针亦靠它。

---

## 6. 边界 —— **通过（1 条行为已记录）**

| 场景 | 结果 |
| --- | --- |
| target 为别名 | `p3.mjs`：`与 ses_peer（别名 peer） 的 thread 24 个（未闭环 22）：` ✔（`threads.ts:60-82`） |
| 未知别名 | 可选错误 `未知目标 "no-such-alias"…`（S102f `✓`） |
| 不存在的 `ses_…` | `p2.mjs`：`PASS unknown ses_ id answers readably`（不要求会话仍可读，`threads.ts:53-59` 注释一致） |
| 空 target | `PASS empty target is a readable error — target 不能为空…` |
| 无索引但有 thread store | 见 §3（`p2.mjs` PASS） |
| 无索引但有广播记录（0.7 前 handoff） | `p4.mjs`：`CHECK hand-off with no index row still listed (broadcast join): PASS` |
| handoff + 消息混排的建议 | 见 §2（`p4.mjs` PASS，指向 `collab_status`） |
| handoff 记录 state 仍 `acked`、thread 已 `answered` | `collab_threads` 按**未闭环**列（`threads.ts:192` 只看 record），偏保守；见风险 R-4 |

---

## 7. 回归与范围 —— **通过**

`pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs`（一次跑完，原始输出摘录）：

```
$ vp pack && vp build -c vite.gui.config.ts && vp build -c vite.tui.config.ts
$ tsc --noEmit          ← 无任何 error TS 行
=== 823/823 checks passed
=== 12/12 checks passed
=== 20/20 board checks passed
=== 50/50 checks passed
=== 49/49 checks passed
=== 47/47 checks passed
=== 17/17 panel checks passed
skills ok
EXIT=0
```

- 工具数 21：`✓ S102 collab_threads is registered exactly once and the surface is 21 collab_* tools — 21 tools / 1 collab_threads`；
  `✓ R8 the package registers the twenty-one collab_* tools + collab_report`（列表含 `collab_threads`，位置紧跟 `collab_status`，
  与 `src/tools/index.ts:46-50` 一致）。
- 版本：`package.json` `0.6.0`、`src/constants.ts:409` `PLUGIN_VERSION='0.6.0'`、`src/gui.tsx:71` `'0.6.0'`
  （GUI 回归断言三者相等，`✓ R2 package.json, PLUGIN_VERSION and the probe toast carry the same version`）。
- 无新依赖：`package.json` / `pnpm-lock.yaml` 均未改（`git diff --stat` 无二者）。
- S102 计数：`grep -c '✓ S102'` = **18**，与文档一致。

---

## 8. 测试真实性 + 我自己跑的两组变异 —— **通过（CHANGELOG 的计数描述不准确）**

### 我跑的变异 1：索引 key 写成 `bid`

`src/core/thread-index.ts:131` `entries[threadID] = entry;` → `entries[String(input.bid ?? '')] = entry;`

```
=== 815/823 checks passed
FAIL: S102 collab_handoff writes one index entry marked kind=handoff with its bid
FAIL: S102 collab_send writes one index entry per thread (kind=messages, target carried)
FAIL: S102 collab_threads lists every thread of the counterpart (1 handoff + 2 messages)
FAIL: S102 … with kind handoff/messages on the right rows, bid on the hand-off row
FAIL: S102 … and exactly one row is marked ← 建议继续 (the newest thread), named in the 建议 line
FAIL: S102 … the summaries are the sender's own words (in/out), capped, and it says it is read-only
FAIL: S102 an answered message thread leaves the default list and appears with includeClosed (marked 已闭环)
FAIL: S102 the index is capped at 500 entries on write (the oldest lastAt is evicted)
```

→ **8 条红**（与 `impl-notes.md` §6 一致，与 `CHANGELOG.md:186` 的「3 条断言红」不一致）。

### 我跑的变异 2：降级直接返回原错误

`src/tools/status.ts:428` `if (entry || thread) {` → `if (false && (entry || thread)) {`

```
ValidationError: 没有 thread t_s102_m2 对应的交接单：threadID 可能拼错，或该 thread 由 collab_send / collab_reply 建立（没有广播记录）。可用 collab_inbox 核对 threadID。
    at invalid (file:///data/project/collab/dist/index.js:1596:9)
    at execute (file:///data/project/collab/dist/index.js:9749:12)
    at async Object.execute (file:///data/project/collab/dist/index.js:2330:13)
    at async call (file:///data/project/collab/test/handoff-harness.mjs:710:4)
    at async file:///data/project/collab/test/handoff-harness.mjs:10678:22
```

→ 变异被抓住，但形式是 **harness 在 S102d 处抛出、进程 exit 1**（后续约 200 条不再执行），
不是 `CHANGELOG.md:187` 说的「2 条断言红」。

### 还原与复核

- 两文件从备份还原，`sha256` 与变异前逐字节一致
  （`thread-index.ts` `bf87fbd1…996922`、`status.ts` `e4a68947…116b57d`），`grep -rn MUTATION src/ test/` → none。
- 还原后重新 build + 跑 harness：`=== 823/823 checks passed`（`restored.trimmed.log`）。
- 工作区文件集未变（15 modified + 2 untracked，`636 insertions`，与复核开始时一致）。

### 「不是自证 / 既有断言未弱化」

- S102 的 18 条都断言**渲染出来的真实文本 / 文件内容**（`out=` / `in=` / `bid=` / `kind=` / `（已闭环）` / 索引 JSON / 500 条计数），
  没有 `assert(true)` 式或「调用没抛错即通过」的空断言；负向断言（原文案不再出现、预览零写入）都与正向断言配对。
- 既有测试只改了两处**必须改**的契约：`test/handoff-harness.mjs:9249-9251`（S98 工具数 20 → 21）、
  `test/readonly-default.mjs:150-170`（工具表插入 `collab_threads`）；其余断言一字未动（`git diff` 逐行确认）。

---

## 9. 文档 —— **通过（1 处事实需改，见风险 R-3）**

| 文件 | 核对结果 |
| --- | --- |
| `docs/collab.md:260` | 标题「二十一个工具」✔；`:271` 新增 `collab_threads` 行，紧跟 `collab_status` ✔ |
| `docs/collab.md:270` | `collab_status` 行补「消息 thread 不再报错」+ 指 §11.17 ✔ |
| `docs/collab.md:1212-1216` | §11.14 补「消息 thread 的降级（0.7.0）」✔ |
| `docs/collab.md:1459-1513` | 新增 §11.17：索引样例、写点表、上限 500 / 7 天 / 容错 / 原子性、输出样例、只读证明、测试与变异、回滚 ✔ |
| 常量与文档一致性 | 500（`constants.ts:375`）/ 7d（`:377`）/ 80（`:379`）/ 20（`:381`）/ 3（`:383`）/ 120（`:385`）/ 5（`:387`）与 §11.17 全部对齐 ✔ |
| `README.md:3-4, 25, 279, 312-315, 346` | 「二十一个」、工具表两行、测试计数 823、S102 段落、源码结构 ✔ |
| `skills/collab/SKILL.md:3, 27-28, 165-182` | description / 工具表 / 「一点八·补」✔；`node scripts/check-skill.mjs` → `skills ok` |
| `CHANGELOG.md:8-13, 113-131, 179-187` | Changed/Added/Tests/Docs 齐全 ✔；**但 `:186-187` 两组变异的「红几条」与实测不符**（R-3） |

另：`docs/collab.md:1512-1513` 回滚命令写的五个文件（含 `shared`/`handoff`）与 `design.md §7` 的三文件不同——
两者都能用，属描述粒度差异，不构成缺陷（未计入风险）。

---

## 10. 与设计/计划的对照

| design 条款 | 实现 | 结论 |
| --- | --- | --- |
| §2 索引文件形状 `{version:1, entries:{t_…:{target,kind,from,lastAt,preview,bid?}}}` | `types.ts:599-635`、`thread-index.ts:13-18` | 一致（多一个 `from` 粘性约定，已在 impl-notes §7 记录） |
| §2 写点：只在成功投递 | `shared.ts:729-739`、`handoff.ts:274-281` | 一致（§1 探针） |
| §2 上限 500 / 读时 7 天 / 坏文件按空 / tmp+rename | `thread-index.ts:112-151`、`:154-179` | 一致（§5 探针） |
| §3 输出 `t_… kind status HH:MM preview`、bid、`← 建议继续`、≤20、`还有 N 个` | `threads.ts:231-273` | 一致 |
| §3 默认只列未闭环；`includeClosed` 再列 ≤3 | `threads.ts:210-214` | 一致（但见 R-1 的边界交互） |
| §4 先广播记录、再索引+thread store、最后原错误 | `status.ts:417-445` | 逐字一致（原错误文案未改） |
| §5 只读 | 见 §4 | 一致 |
| §6 七例 + 两组变异 | S102 18 条覆盖七例；变异我自己复跑 | 一致 |

`implement.md` 八项全部勾选，逐项可对上落地文件；无「勾了但没做」的项。

---

## 11. 风险清单（按严重度，均非阻断）

| # | 级别 | 内容 | 证据 | 建议 |
| --- | --- | --- | --- | --- |
| R-1 | 低 | `includeClosed:true` 在未闭环 ≥20 时**一条已闭环也不显示**，但首行仍写「本次另列已闭环 ≤3」。`threads.ts:212-214` 先把 closed 追加到 20 条上限之外，再被 `slice(0,20)` 切掉 | `p3.mjs`：22 未闭环 + 2 已闭环 → `本次另列已闭环 ≤3` / `closed rows shown: 0` / `…还有 4 个` | 要么为已闭环预留 3 行（`unresolved.slice(0,17)` + closed 3），要么按实际渲染改文案（「未闭环已占满 20 条，已闭环未渲染」） |
| R-2 | 低 | 读放大：渲染上限 20，但**先对全部索引条目**逐条 `await threads.read`（`threads.ts:184-207`）。索引上限 500 → 最坏 500 次串行 `storage.get` | `p5.mjs`：400 条索引 → `storage.get calls: 400`，`rendered rows: 20`（内存宿主 2.4ms；真宿主是 RPC，可能到数百 ms–数秒） | 先按 `lastAt` 排序取前 `20+3` 再读；或 `Promise.all` 并发（失序无所谓，排序在后面） |
| R-3 | 低（文档事实） | `CHANGELOG.md:186` 说变异①「3 条断言红」，实测 8 条；`:187` 说变异②「2 条断言红」，实测是 harness 在 S102d 抛错中止（exit 1） | §8 两组原始输出；`impl-notes.md:139-165` 自己写的就是 815/823 与 exit=1 | 改成「8 条断言红（815/823）」「降级分支被删后 harness 在 S102d 直接中止」 |
| R-4 | 记录（偏保守） | handoff thread 的 `closed` 只看广播记录终态（`threads.ts:192`）：记录仍 `acked`、thread store 已 `answered` 时，该 thread 仍算「未闭环」并可能被标「← 建议继续」 | `p4.mjs`：claimant `collab_reply` 后 record 仍 `acked`（记录终态由发起方 hook 的 verdict 推进），`collab_threads` 仍列 open | 无需改：偏保守 = 不会藏起可能还开着的单；若想更准可 `closed = recordDone \|\| thread.status==='answered'` |
| R-5 | 记录 | 索引读-改-写无跨进程锁（同进程内是同步写，不会交错；跨 OpenCode 服务端并存时理论上可丢一条） | `thread-index.ts:112-146` | design §2 未要求锁；与广播/冻结同一套「tmp+rename」已够；若担心可复用 freeze 的短锁 |
| R-6 | 记录（既有） | `package.json` description 仍写 `seventeen native collab_* tools`（本次未改，与 21 不一致） | `package.json:5` | 下次动 `package.json` 时顺手改成二十一 / 或改成不带数字 |
| R-7 | 记录（风格） | `threads.ts:191` 三目依赖 `||`/`===` 优先级（正确但易误读）；`status.ts:263-270` 用内联结构类型重复 `ThreadIndexEntry` | 源码走读 | 加括号 / 直接用 `ThreadIndexEntry` 类型，纯可读性 |

---

## 12. 未覆盖 / 受限

- 未在真实 OpenCode 宿主上跑（无宿主会话可投递）；`session.prompt` 的 `delivery` 语义由假宿主代替，
  与既有 S102 同一口径。
- 「记录已回收、只剩 `entry.bid`」的 `collab_status` 分支（`status.ts:298-301`）只做了代码走读，未构造删除记录的场景。
- `COLLAB_THREAD_INDEX_FILE` 在**真实插件进程**里的生效路径未验（只在 harness/探针进程验证；模块加载读取与
  `COLLAB_BROADCAST_DIR` 同一套写法，风险很低）。
- 未评估 GUI/TUI 是否应展示 `collab_threads`（不在本任务范围；两个视图的回归仍全绿）。

---

## 13. 附：原始输出位置

- `research/check-probes/p1.mjs` 索引健壮（上限/7 天/坏文件/未知 version/只读/未知字段）
- `research/check-probes/p2.mjs` 写点负例、降级、别名、只读哈希
- `research/check-probes/p3.mjs` `includeClosed` 与 20 条上限的交互（R-1 证据）
- `research/check-probes/p4.mjs` 混排建议 / 无索引但有广播记录 / 记录未终态的 closed 判定（R-4 证据）
- `research/check-probes/p5.mjs` 读放大（R-2 证据）
- `research/check-probes/p6.mjs` 读路径不创建索引文件
- `research/check-probes/mut{1,2}.trimmed.log`、`restored.trimmed.log` 变异与还原的原始行
