# 跨机同步协作状态与投递（提案）

- 状态: open（仅调研，未立项）
- 范围: 本仓（存储层 + 投递通道）；涉及 `~/.config/opencode/collab-*` 的布局
- 关联: 0.10.x；`docs/issues/feat-collab-protocol-v2.md`
- 结论先行: **「同步文件」只能让你看到对方做过什么；要让协作真正发生，需要一条跨机投递通道。** 推荐「共享目录 + 每机分片 + 邮箱」的分阶段方案，前置是把 facts 的 workspace key 改成可移植的。

## 1. 问题

现在所有协作状态都在**每台机器**的 `~/.config/opencode/collab-*`：
mac 与 linux 各一份，互不可见；会话 id 也只存在于各自的 server。
结果是：跨机时既看不到对方的看板，也无法 `collab_send` 给对方会话。

必须区分两件事，成本差一个数量级：

| | 问题 | 只靠文件同步能否解决 |
|---|---|---|
| ① | **状态可见**（看板/账本/消息历史） | 能 |
| ② | **跨机投递**（mac 会话 ↔ linux 会话） | 不能，需要通道 |

## 2. 现状取证（读代码得到）

| 事实 | 位置 | 影响 |
|---|---|---|
| 所有状态在 `~/.config/opencode/collab-*`，可用 `COLLAB_*` 覆盖 | `src/constants.ts` | 可指到共享目录 |
| 锁是本地文件锁 `open(…,'wx')` | `src/core/file-lock.ts` | **NFS/同步盘上不可靠 → 不能共享写** |
| `collab.db` 是投影，可重建 | `src/core/index-db.ts` | **不要同步 DB**（WAL 跨网络 FS 会坏） |
| facts 按**绝对路径**分 workspace | `src/core/facts.ts` | mac/linux 路径不同 → 同步了也是两本账 |
| contracts 按 session id | `src/core/contract.ts` | 会话只在单机存在 → 同步无意义 |
| decisions 按 `threadID/bid` | `src/core/decisions.ts` | 理论可跨机，但前提是 thread 跨机 |
| locks / owner-queue 绑本地资源 | `src/core/locks.ts` 等 | 同步无意义 |

## 3. 三个方案

### A. 共享目录 + 每机分片（推荐）

```
collab-messages.<host>.jsonl       每机只写自己的分片，读时合并
collab-decisions/<host>/<key>.json 同上（按 host 分目录，避免同 key 双写）
collab-mailbox/<targetHost>/*.json 跨机投递（见 A3）
```

- **A1 可移植 workspace key**（前置）：facts 从绝对路径改为 `remote#relative`（如 `github.com:org/repo#packages/era`），两台机器才可能合并同一工作区。
- **A2 分片写入**：每机只写 `<host>` 分片 → 不需要跨机锁，不会互相覆盖；读取时按时间合并。
- **A3 邮箱投递**：A 机把消息写成 `collab-mailbox/<B-host>/<msgId>.json`；B 机插件轮询自己目录、消费并写 `<msgId>.ack`。延迟 = 同步间隔（秒级），适合异步协作。
- **明确不同步**：`collab.db`、`collab-contract/`（按 session）、`collab-locks/`、`collab-owner-queue/`、`collab-pacing.json`。

成本：中；风险：低（无共享写）。需要一台常开的同步器（Syncthing / 对象存储 / rsync 定时）。

### B. Hub 服务

一台机器跑 HTTP 服务，另一端走 remote adapter（鉴权 + 重试 + 去重）。

成本：高（新增网络层与运维）；收益：一致性与实时性最好。
在 A 验证「跨机协作确实有价值」之前，不划算。

### C. 导出/导入快照

`collab_index export/import`，人手动搬。成本最低，但只有 ①，且是快照不是同步。

## 4. 推荐路线（分阶段）

1. **P1 可移植 workspace key**（1 个子任务）：facts 的 key 改为 `remote#relative`，旧 key 兼容读。
2. **P2 分片写入 + 合并读**（1 个子任务）：messages / audit / decisions 按 host 分片；`rebuild` 读全部并合。
3. **P3 邮箱投递**（1 个子任务）：`collab-mailbox`，poll + ack + 去重（msgId），protected 名单按目标机策略。
4. **不做**：共享 DB、共享 contracts/locks/queue。

## 5. 风险

| 风险 | 处理 |
|---|---|
| 同步盘冲突 | 分片写入规避；同一 key 双写用 host 目录隔离 |
| 时钟偏差 | age/TTL 用接收方时钟；决策 TTL 是 24h 级，可容忍 |
| 重复投递 | 邮箱 msgId + ack + TTL |
| protected 名单各机一份 | 投递前查**目标机**策略；跨机不继承 |
| 安全 | 邮箱内容含正文；共享目录需限制访问 |

## 6. 非目标

- 不做实时（毫秒级）协作；只做异步。
- 不做跨机锁（租约语义留在单机）。
- 不改现有单机行为；不启用时与 0.10.x 完全一致。
