---
name: collab-coordination
description: 同一工作区多个会话并行、且会争抢共享资源（测试窗口、同一文件或模块、全量构建、数据库/服务端口）时使用。给出「查看占用 → 申请/协商 → 等待或让行 → 释放 → 超时升级」的可执行规程、死锁避免规则与降级路径，避免两个会话“都以为自己拿到了”。
---

# 同工作区协作协调（锁 / 让行 / 死锁避免）

## 何时用

- 同一工作区有 ≥2 个活跃会话，且**可能动同一资源**：
  - 测试窗口 / 全量测试套件（例：排钟专题 vs 加载未实施 issues 争 `pytest` 窗口）；
  - 同一个文件或模块（例：`packages/state/src/machine/worker/store.ts`）；
  - 全量构建、数据库迁移、占用固定端口的服务。
- 你已经**观察到等待**（「窗口被占用」「等对方释放」）——这时必须显式协调，不要靠 `ps` 猜。

## 何时不用

- 只读操作、批处理无关文件、单测互不干扰。
- 交接「谁来做」用 `collab_handoff` / `collab_broadcast`（那是 handoff），**不是**这里的锁。

## 规程（五步）

### 1. 查看占用

```text
collab_locks { resource: "<资源名>" }        # 0.2.0+：机器判定
```

在此之前（0.1.x）：用 `collab_send` 问 + 本机探针：

```bash
ps -ef | grep -E "pytest|vitest|pnpm build" | grep -v grep
git status --short            # 同文件是否有人在改
```

### 2. 申请 / 协商

```text
collab_lock { resource:"test-window", mode:"exclusive", ttlMs: 900000, reason:"全量 pytest", confirm:true }
```

未支持时（0.1.x）用消息协商，**写明三要素**：资源名、预计时长、释放条件：

```text
collab_send { target:"<对端会话>", kind:"request",
  text:"[窗口] 我要独占 test-window 约 10 分钟（全量 pytest），结束后立刻发 [窗口] released。若你需要先用请回 DECLINE。", confirm:true }
```

### 3. 等待或让行

- 对方明确释放 / `collab_locks` 显示 free → 开始；
- 对方在忙 → **让行**：先做无冲突部分（静态检查、定向单测、读代码），并把「等窗口」写进你的任务记录；
- 不要重复催办；一次请求 + 一次到期检查即可。

### 4. 释放

```text
collab_unlock { resource:"test-window", confirm:true }
```

0.1.x：发一条 `[窗口] released` 给对方会话（`collab_send`, `kind:"note"`）。**异常退出也要补发**。

### 5. 超时升级

超过 `ttl` 仍未见释放 → 不要擅自抢占；发一条 `BLOCKED`/note 说明，并把冲突写进任务，交给 owner 裁决。

## 死锁避免

| 规则 | 说明 |
| --- | --- |
| 多资源按**名称排序**依次申请 | 避免 A 拿 X 等 Y、B 拿 Y 等 X |
| TTL 必填，上限 2h | 过期自动回收，不靠人工 |
| 嵌套等待 ≤ 1 层 | 拿着锁去等另一个锁，必须显式说明并设更短 TTL |
| 抢占需人工 | 任何「强制抢过来」都要 owner 同意 |
| 一次只持有一个独占资源 | 缩小持有面 |

## 场景样例

1. **测试窗口**（真实案例）：排钟会话占 `test-window` 10+ 分钟，issues 会话两次请求未获释放。
   正确做法：排钟会话申请时写明「约 10 分钟 + 释放即发 released」；issues 会话收到后**让行**做定向用例，到期检查一次。
2. **同一文件**：两个会话都要改 `worker/store.ts` → 一个申请 `file:packages/state/.../store.ts`，另一个改 `worker/project.ts` 并等前者。
3. **全量构建**：`build` 资源独占；等待方跑定向 `pnpm --filter <pkg> build` 验证局部。

## 与 handoff 的分工

- **锁**：解决「同时做同一件事」的资源竞争；
- **handoff**：解决「这件事该谁做」；
- 不要把锁当成交接手段，也不要用交接代替互斥。

## 降级路径（`collab_*` 不可用时）

1. 明确写下「协作工具不可用，改用本地判定」；
2. 用 `ps` / `git status` / 端口占用判断；
3. 保守策略：**假定资源被占用**，先做无冲突部分；
4. 在任务记录与最终回复里注明「未协调成功/原因」，不要静默假设。

## 硬约束

- 不向 `[protected]` / `[protected-child]` 投递；不删除他人会话。
- 不因锁阻断消息投递：锁只用于**自愿**协调。
- 释放必须显式（消息或工具），不要「跑完就算了」。
