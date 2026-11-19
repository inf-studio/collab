# 实现记录：collab_freeze（0.6.0）

> 契约源：`prd.md` R1–R6、`design.md` §1–§7、`implement.md`。
> 回归：`pnpm typecheck && pnpm test && node scripts/check-skill.mjs`
> → **734 + 12 + 48 + 32 + 47 + 7 = 880 条全绿**（基线 `696 + 12 + 42 + 32 + 47 + 7`）。

## 1. 落地文件

| 文件 | 内容 |
| --- | --- |
| `src/core/freeze.ts`（新） | `FREEZE_FILE` / `parseUntil` / `sanitizeFreezeReason` / `normalizeFreezeEntry` / `readFreezes(now)` / `mergeFreezes(mutate, now)`（读-合并-写 + `tmp+rename` + `<file>.lock` 短锁）/ `freezeFor(entries, keys)`（纯优先级）/ `frozenBy(keys,{lineage,now})`（血缘走查）/ `freezeDenyText` / `freezeHintText` / `freezeNoticeText` / `freezeNotice` / `markFreezeNotified` |
| `src/tools/freeze.ts`（新） | `collab_freeze { scope, target?, reason, until?, freeze?, confirm }`；预览 / 冻结 / 解冻；通知（queue prompt 或 urgent 队列项）；回执写入条目 `delivery[]` |
| `src/tools/index.ts` | 注册第 20 个工具（`collab_escalate` 之后） |
| `src/tools/handoff.ts` | confirm 之后、写记录之前判冻结（目标 + 目标工作区；预览只提示） |
| `src/tools/broadcast.ts` | 解析 workspace 后立刻判（读提案前）；spawn 前再判一次 |
| `src/tools/accept.ts` | protect 护栏之后、`persistRefresh` 之前判（bid / 领取方会话 / 该单工作区） |
| `src/tools/escalate.ts` | 先 `resolveTarget` 再判（会话 / bid / **目标会话所在工作区**），冻结优先 |
| `src/tools/list.ts` | 会话行 `[frozen] 冻结至 HH:MM`（继承附 `（继承 ses_…）`）、未闭环交接 `[frozen]`、单独「冻结」段 + 解冻命令；只读 |
| `src/core/snapshot.ts` | `SnapshotSource.freezes?()`；`sessions[].frozen` / `handoffs[].freeze`（用已拉到的 `parentID` 页做祖先链，0 额外 host 调用；过期项在视图层再滤一次） |
| `src/rpc.ts` | `SnapshotFreeze`；`SnapshotSession.frozen?` / `SnapshotHandoff.freeze?`；RPC schema 均**可选** |
| `src/types.ts` | `FreezeEntry` / `FreezeFile` / `FreezeDelivery` |
| `src/index.ts` | snapshot 绑定 `freezes: () => readFreezes()`；`context` 钩子在 push 成功后才 `markFreezeNotified`；`__internals` 导出 `readFreezes` / `mergeFreezes` / `freezeFor` |
| `src/gui.tsx` / `src/tui.tsx` | 只加 `frozen` 标记（不改布局；TUI 行/侧栏带 `HH:MM`，GUI badge 的 title 带到期+原因，tone=danger） |
| `test/handoff-harness.mjs` | 新增 **S98**（36 条）+ `COLLAB_FREEZE_FILE` 指向临时目录 |
| `test/readonly-default.mjs` | 注册表 19 → 20；冻结文件指向临时目录 |
| `test/snapshot-shape.mjs` | 42 → 48 条（frozen/freeze 标记、祖先继承、过期不显示、旧源无 reader、可选 schema） |
| `docs/collab.md` | §11.2 标题 19 → 20 + `collab_freeze` 行；新增 §11.14.2 |
| `README.md` / `skills/collab/SKILL.md` / `CHANGELOG.md` | 工具表 / 一点十 / 0.6.0 Added·Tests |

版本号未改（仍 0.6.0 / 代码 `PLUGIN_VERSION` 未动），无新依赖，未改 `BUILTIN_PROTECT`。

## 2. 实测时序（S98 原始输出摘录）

### 2.1 冻结会话 → handoff 拒绝（0 写入）

```
已冻结 会话（scope=session, target=ses_s98_peer, 到 10:45：30m 后）
送达（queue）: ses_s98_…peer message=msg_62 cid=c_mwmx4q5z_4pfy
=> entry = { scope:'session', target:'ses_s98_peer', by:'ses_s98_req',
             at:…, until:at+1800000,
             delivery:[{to:'ses_s98_peer', at:…, cid:'c_…', messageId:'msg_62'}] }

collab_handoff { target:"ses_s98_peer", confirm:true }
=> 拒绝：目标被冻结（scope=session，到 10:45，原因：S98 store.ts 先别动，等 schema 线确认）。
   解冻: collab_freeze { scope:"session", target:"ses_s98_peer", freeze:false, confirm:true }。未写入任何内容。
=> 断言：广播目录文件数 +0；prompts +0
```

### 2.2 血缘（祖先冻结 → 子会话）

```
collab_handoff { target:"ses_s98_child", confirm:true }   # child.parentID = ses_s98_peer
=> 拒绝：目标被冻结（scope=session，继承自祖先 ses_s98_peer，到 10:45，…）
```

`collab_list { directory: S98_WS }`：

```
ses_s98_peer   build  idle  …  [frozen] 冻结至 10:45
ses_s98_child  trellis-implement idle … [frozen] 冻结至 10:45（继承 ses_s98_…peer） parent=ses_s98_…peer
冻结（临时，到期自动失效；1 条）:
- [frozen] scope=session target=ses_s98_peer 到 10:45 原因=…  解冻: collab_freeze {scope:"session", target:"ses_s98_peer", freeze:false, confirm:true}
```

同一次 `collab_list` 前后 `freeze.json` mtime 相同（`…595.0002 → …595.0002`）——读命令零写入。

### 2.3 到期（假时钟，读取时失效）

```
readFreezes(until - 1) → 1 条（target=ses_s98_peer）
readFreezes(until + 1) → 0 条
freezeFor([], {session:'ses_s98_peer'}) → undefined
```

### 2.4 解冻 / 幂等

```
collab_freeze { scope:"session", target:"ses_s98_peer", freeze:false, confirm:true }
=> 已解冻（…）。文件: …（剩余 0 条冻结）
再次同参 => 没有该冻结项（no-op：scope=session, target=ses_s98_peer）。
之后 collab_handoff 同参 => 已投递（prompt +1、记录写入）
```

### 2.5 工作区冻结

```
通知根会话 2 个（peer / mate；自己、子会话、已归档排除；目录内 ≤5）
collab_broadcast { workspace: S98_WS, issuePath, confirm:true }
=> 拒绝：工作区 /tmp/…/ws/s98 被冻结（scope=workspace，到 10:45，…）；广播文件 +0
collab_escalate { session:"ses_s98_mate", reason, confirm:true }
=> 拒绝：目标被冻结（scope=workspace，…）；prompts +0
collab_list { directory: S98_WS2 }  → 该目录会话行无 [frozen]（冻结不跨工作区显示）
```

### 2.6 bid 冻结

```
collab_accept  { bid:b_9800000000000001, confirm:true }（旁路会话）
=> 拒绝：目标被冻结（scope=bid，…）；记录 state 仍 open、无 receipt / priority
collab_escalate{ bid:b_…, reason, confirm:true }
=> 拒绝：目标被冻结（scope=bid，…）；prompts +0
```

### 2.7 protected 目标（队列落盘）

```
已冻结 会话（scope=session, target=ses_e1eb91cebffeTv1467ubJLKebk, …）
受保护目标（0 条 prompt，已排队）: ses_e1eb…Kebk q_mwmx4iow_7q3x → /tmp/…/owner-queue/ses_e1eb…/q_mwmx4iow_7q3x.json
=> 文件内容：{ target:'ses_e1eb…', from:'ses_s98_req',
               summary:'[frozen] S98 schema 线暂停（scope=session，到 10:45；解冻: …）',
               priority:'urgent', issuePath:null, bid:null, seenAt:null }
=> 条目 delivery[0] = { to:'ses_e1eb…', queueId:'q_mwmx4iow_7q3x', at:… }
```

被冻会话的 `context`（第一次）：

```
[collab-freeze] 你被冻结：S98 schema 线暂停
到期: 10:45（scope=session，target=ses_e1eb91cebffeTv1467ubJLKebk；到期自动失效）
解冻: collab_freeze { scope:"session", target:"ses_e1eb91cebffeTv1467ubJLKebk", freeze:false, confirm:true }
冻结只阻止**新建**协作（collab_handoff / collab_broadcast / collab_accept / collab_escalate）；读取类（collab_list / collab_status）不受限。
```

第二次：`second=false notifiedAt=1795054538919`（块 push 成功后才写 `notifiedAt`，只提示一次）。

按会话一次（`notifiedFor[]`）：父线 `ses_s98_peer` 冻结时，`ses_s98_peer` 与 `ses_s98_child` 各自第一次
`context` 都看到提示（子会话那行是 `你被冻结（继承自祖先 ses_s98_peer）`），第二次都不再出现；条目上
`notifiedFor = ['ses_s98_peer','ses_s98_child']`。

### 2.8 并发写（两个独立进程）

两个子进程（`node --input-type=module -e`）各自 `mergeFreezes` 追加一条：

```
exits=0,0 entries=2
ses_s98_c1 reason='S98 并发写 A'
ses_s98_c2 reason='S98 并发写 B'
```

实现：`open(<file>.lock,'wx')` 短锁（2s 陈旧可回收，100×5ms 后降级为无锁 merge）+ `tmp+rename`；读-合并-写。

## 3. 变异验证（各已还原；对 `dist/index.js` 打补丁后跑 S98）

### 3.1 去掉祖先判定

补丁：`const hit = await lineage.protectedAncestor(keys.session, sessionTargets);`
→ `const hit = keys.session && sessionTargets.includes(keys.session) ? {sessionID:keys.session, depth:0} : void 0;`

原始输出：

```
  ✓ S98 freeze session → collab_handoff is refused with the unfreeze command — 1ms / 拒绝：目标被冻结（scope=session，到 10:46，…）
  ✓ S98 … and the refusal wrote nothing: no broadcast file, 0 prompts — 0 file(s) / 0 prompt(s)
  ✗ S98 ancestor freeze: a sub-session cannot bypass it (血缘) — 没有报错: 已投递 → ses_s98_child agent=trellis-implement state=idle title="S98 child of the frozen peer" kind=request thread=t_…
=== 732/734 checks passed
FAIL: S98 ancestor freeze: a sub-session cannot bypass it (血缘)
```

→ 「祖先冻结」断言必失败（子会话交接成功），证明血缘判定确有作用。

### 3.2 去掉到期过滤

补丁：`readFreezes` 的 `.filter((entry) => entry.until > now)` → `.filter(() => true)`

原始输出：

```
  ✗ S98 until expires on read: live a millisecond before, gone a millisecond after (no cleanup needed) — 1 live / 1 expired
=== 733/734 checks passed
FAIL: S98 until expires on read: live a millisecond before, gone a millisecond after (no cleanup needed)
```

→ 到期断言必失败（`until+1` 仍返回条目），证明「读取时失效」是唯一真源。

还原：`cp /tmp/collab-dist-index.backup2.js dist/index.js` 后重跑 → 734/734。

## 4. 与 design 的偏差 / 自行决定的实现细节（均记录在案）

1. **`FreezeEntry.delivery[]`（新增可选字段）**：design 只要求「保留 `delivery.cid` 供回执」。为了让「有没有真送到」
   跨轮次可查（而不是只活在一次工具返回里），把 `{to,cid?,messageId?,queueId?,at,error?}` 写进条目；类型在
   `src/types.ts`，读侧宽容（`normalizeFreezeEntry` 重校验）。
2. **`workspace` 冻结也拒绝 `collab_escalate`**（design 表只写了 handoff/broadcast/accept/escalate 的通用判定，
   没有细分 escalate 的工作区）：escalate 先 `resolveTarget` 再判 `target.info.location.directory`，这样
   「冻结一个目录」对「点名目录里的会话加急」同样生效（验收口径：该目录下所有新建协作被拒）。
3. **`mergeFreezes` 加了跨进程短锁**：design 写的是「读-合并-写」。纯读-合并-写在**不同进程**（文件是全局的，
   两个工作区各跑一个插件实例）下仍可能丢条目，所以加了 `open(…,'wx')` 锁 + 陈旧回收 + 失败降级（只记日志，
   不阻断工具）。同一进程内 JS 串行，锁只是跨进程保障。
4. **context 提示放在 `src/index.ts` 的钩子包装层**（不是 `hooks/context.ts`）：硬约束只允许改 `src/index.ts`；
   包装层在 `contextHook(event)` 之后 push 自己的块，再 `markFreezeNotified`，与 F1 规则（push 成功后才标记）一致。
5. **snapshot 的祖先链用已拉到的会话页**（`parentID`），不额外调 host；过期条目在视图层再过滤一次，
   即使调用方给的是原始文件也不会标出一个已过期的冻结。
6. **`workspace` 通知上限 5 个根会话**（排除自己 / 子会话 / 已归档）：design 未规定，取「通知但不制造 prompt 风暴」。
7. **`notifiedFor[]`（新增可选字段）**：design 的 `notifiedAt` 只能表达「这个冻结被提示过」。一个被冻结的父线
   覆盖多个子会话时，第一名子会话消费 `notifiedAt` 后其余子会话永远看不到提示。所以补 `notifiedFor[]`（已提示的
   session id 列表），`notifiedAt` 保留为最近一次时间戳；旧条目（只有 `notifiedAt`、没有 `notifiedFor`）按
   「全局已提示」兼容处理。

## 5. 回归计数

```
handoff-harness : 696 → 734（+38 = S98）
readonly-default: 12  → 12（注册表 19 → 20 已同步）
snapshot-shape  : 42  → 48（+6 frozen/freeze/schema）
tui-render      : 32  → 32
gui-entry       : 47  → 47
gui-panel       : 7   → 7
check-skill     : skills ok
```
