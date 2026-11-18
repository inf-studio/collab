# 实施记录：C1 资源租约（`collab_lock` / `collab_unlock` / `collab_locks`）

> 任务：`.trellis/tasks/11-18-collab-lease`（父任务 `11-18-collab-coordination`）
> 版本：`0.2.0`（minor bump，新增 3 个工具）
> 验收：`pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs` → 全绿
> （harness 498/498 → 复核修复后 **506/506**，readonly 12/12，skills ok）

## 0. 复核修复（review round 1）

| 项 | 结论 | 修法 |
| --- | --- | --- |
| **R-1** 排队 >50 丢队首 | 成立（真缺陷） | 队列改为**硬上限** `LOCK_QUEUE_LIMIT=50`：满员时**拒绝新来者**（`status:"queue-full"`，可读文案「等待队列已满 50 … 队首 ses_q0 保留第 1 位」），已在队列的会话仍可刷新 mode/reason；`normalizeLock` 的 reads 截断由 `slice(-n)`（丢队首）改为 `slice(0,n)`（保队首）。`LOCK_HISTORY_LIMIT`（审计行）与队列上限解耦。 |
| **R-7** `expiresAt=0` 损坏记录永不过期 | 成立（真缺陷） | `reap()` 把「holders 非空但 `expiresAt` 非有限数或 ≤0」判为损坏 → 回收并写 `history: expire` + `reason:"invalid"`（`at` 取发现时刻）。`stateOf`/`isFree`/`collab_locks` 也只读地显示 `free`，下一次 `collab_lock` 落盘回收。 |
| **R-5a** `src/index.ts` 注释 "twelve" | 成立 | → "fifteen"。 |
| **R-5b** skill「TTL 必填」与实际不符 | 成立 | → 「TTL 可选，默认 15min，上限 2h」；另补一行「队列上限 50，满员拒新」+ §3 说明。 |

新增回归（并入 S87）：`S87g` 50 人排队后队首仍 `ses_q0#1`、第 51 人被可读拒绝且未被写进队列、
读取（`collab_locks` / `lockRead` / 原始文件）不丢队首、已排队者可刷新；`S87h`
`expiresAt=0` 的损坏记录：只读列表显示 free 且不重写文件、下一次 acquire 获得并留下
`{event:"expire", sid:"ses_lk1", reason:"invalid"}`。

## 1. 新增/修改文件

| 文件 | 内容 |
| --- | --- |
| `src/core/locks.ts`（新） | 规范化、`<hash>__<slug>.json` 存储、`open wx` 短锁、`acquire/release/reap/stateOf/locksFor`、`fmtTtl`；队列硬上限（满员拒新）、损坏租约回收（`reason:"invalid"`） |
| `src/tools/locks.ts`（新） | 三个工具（`collab_lock` / `collab_unlock` / `collab_locks`），全部 `confirm:true` 才写 |
| `src/constants.ts` | `LOCK_DIR`（`COLLAB_LOCK_DIR` 可覆盖）、TTL 默认/上下限、短锁超时/过期、history 上限、`LOCK_QUEUE_LIMIT`（排队硬上限）、reason 上限；`PLUGIN_VERSION` → `0.2.0` |
| `src/types.ts` | `LockMode/LockKind/LockEvent/LockWaiter/LockHistoryEntry/LockRecord/LockState` |
| `src/tools/index.ts` | 工具注册追加 3 个（原有 12 个顺序不变） |
| `src/tools/list.ts` | `collab_list` 追加本会话「持有 / 排队中（第 N 位）」 |
| `src/index.ts` | `__internals` 暴露 `normalizeResource/normalizeTtl/sanitizeReason/lockFile`（纯函数单测用） |
| `test/handoff-harness.mjs` | `COLLAB_LOCK_DIR` 指向临时目录；新增 S86–S88 共 42 项断言；文件头补章节说明 |
| `test/readonly-default.mjs` | 工具面断言 12 → 15；`COLLAB_LOCK_DIR` 临时目录 |
| `docs/collab.md` | §11.2 工具表 + 3 行，新增 §11.10「资源租约」（数据/状态机/规范化/原子性/排队/安全/用例） |
| `skills/collab-coordination/SKILL.md` | 「消息协商」升级为 `collab_lock` 机器判定（五步规程、FIFO、无 force、降级路径保留） |
| `README.md` | 工具数 12 → 15、工具表 3 行、测试计数 456 → 498、源码结构、版本兼容表 |
| `CHANGELOG.md` | `0.2.0` 条目（Added / Security / Changed / Tests） |
| `package.json` | `0.2.0` |

## 2. 关键实现决定（低风险、已自决）

1. **短锁语义**：`open(<file>.lock,'wx')` + 2s 等待 + 2s 过期清理。等待用
   `await setTimeout(5ms)`（不阻塞事件循环）；极端超时后**无保护推进**而不是报错——记录写仍是
   `tmp+rename` 原子替换，最坏是一次 lost update，不会产生半条记录。
2. **幂等**：同 `sid` 命中 `holders` 直接返回既有租约（`renewed:true`），不重复计数、**不延长 TTL**；
   若请求 `mode` 与既有不同，只提示「既有租约保持不变」而不静默升降级。
3. **FIFO 不插队**：资源 free 但 `waiters` 非空时，只有队首能直接获得；其他人 `wait:true` 排队，
   `wait:false` 返回「资源空闲，但有人在排队」。释放**不自动授予**队首（不主动叫醒/不投递），
   队首下次 `collab_lock` 出队获得。
4. **`shared` 组的 `expiresAt`**：单记录单时间戳，取 `max(现有, now+ttl)` / `ttlMs` 取 max；
   shared 是只读共享，组租约偏向更长不会阻塞任何人（已在 docs 注明）。
5. **`reason`**：存到记录 `record.reason`（≤200、去控制字符、单行），列表里 `reason="…"` 展示；
   设计 schema 未列该字段，属于展示性补充，不参与判定。
6. **`file:` 规范化**：必须 workspace 相对；拒绝绝对路径 / `..` / `.` 段；
   存在的叶子拒绝软链；`realpath`（或最近存在祖先）必须仍在 workspace 内；**允许尚不存在的文件**
   （会话常要先锁「即将写的模块」）。
7. **`normalizeLock` 对 `ttlMs=0` 保留 0**：free 记录没有租约，不凭空补默认 TTL（避免列表显示 `ttl=15m` 的假象）。
8. **protected**：`[protected*]` 可持有；冲突输出标 `[protected]` + 「不可抢占」；
   `collab_unlock` 只有 holder 能调，schema 里**没有 force 字段**（`additionalProperties:false`），
   即「抢占需人工」在工具面就无法表达。
9. **不改 handoff**：未触碰 `BUILTIN_PROTECT`、`BCAST_*`、`claim.ts`；锁状态机与 handoff 状态机完全分离，
   仅共享只读视图（`stateOf` 供侧边栏任务直接消费）。

## 3. 与设计/PRD 的偏差（均在允许范围内）

| 项 | 说明 |
| --- | --- |
| 设计 §2 末句「同一文件绝对/相对路径归并」 vs §6「拒绝绝对」 | 按 §2 表格、§6 与任务文本执行：**拒绝绝对路径**（同一文件必须用同一种 workspace 相对写法），已写入 docs §11.10.1 |
| 设计 §5 提到 `collab_unlock { force? }` | 按任务文本执行：**不提供 force**（抢占需人工），设计 §6 的 protected 条款因此天然满足 |
| `renewed` 字段 | 设计未提；用于把「幂等命中」与「新获得」区分开，只是输出文案依据 |

## 3.1 越界项

- `skills/collab/SKILL.md` 的 description 原写「collab_* 十二个工具」——该文件不在本任务的硬约束
  白名单内，本会话未修改；**复核轮期间已由外部改成「十五个工具」**（工作区当前 `git status` 可见，
  非本会话改动）。租约的完整规程仍在 `skills/collab-coordination/SKILL.md`。

## 4. 回归覆盖（S86–S88）

- **S86**：5 路并发 exclusive 只有 1 winner、其余 4 个拿到 holder+TTL；preview 不落盘；
  同 sid 幂等（holders 不增、expiresAt 不变）；shared 共存；exclusive ↔ shared 双向互斥；
  shared holder 单独释放不影响组内他人。
- **S87**：过期租约被下一次 acquire 回收且 `history: expire`；`expiresAt=0` 的损坏记录同样回收（`reason:"invalid"`）；
  队列满 50 时拒绝新申请且队首名次不变；`collab_locks` 只读（显示 free、文件字节不变）；
  FIFO 排位 1/2；释放保留队列；新人无法插队；队首获得；`collab_list` 显示本人 held / 排队第 1 位；
  非 holder 无法释放；重复释放返回「无需释放」。
- **S88**：4 种中文/英文写法归并成 1 个资源、只写 1 个文件；`build`/`全量构建` 归并；
  `file:` 与裸相对路径归并；`..`/`.`/绝对/软链拒绝（无记录落盘）；缺失文件允许；
  ttl 夹取 10s / 2h 并在输出标注收敛；reason 单行 ≤200；protected 可持有、冲突标 `[protected]` 且不可抢占；
  全程 0 条消息投递。
- 既有 456 项 + readonly 12 项保持全绿（工具面断言已同步为 15 个）。

## 5. 回滚

```bash
# 释放全部租约（数据）
rm -rf ~/.config/opencode/collab-locks
# 代码
git restore -- src/ test/ docs/collab.md skills/collab-coordination/SKILL.md README.md CHANGELOG.md package.json
rm -f src/core/locks.ts src/tools/locks.ts
```

无数据迁移；`collab-locks/` 与 handoff / storage 完全独立。

## 6. 复核后残留（未改，越界）

- `docs/collab.md` §11.10 未写「队列上限 50」与「损坏记录回收」细节：本轮硬约束只允许
  `src/**`、`test/**`、`skills/collab-coordination/SKILL.md`，故留待下一轮补一句；
  行为已由 skill 与工具文案覆盖，不与现有文档冲突。
- `CHANGELOG.md` 的 `0.2.0` 条目未追加 `### Fixed`（同上，不在本轮白名单）；0.2.0 尚未发布，
  建议发版前一并补两条 Fixed 说明（队列硬上限、损坏租约回收）。
