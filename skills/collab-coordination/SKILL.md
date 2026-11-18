---
name: collab-coordination
description: 同一工作区多个会话并行、且会争抢共享资源（测试窗口、同一文件或模块、全量构建、数据库/服务端口）时使用。给出「查看占用 → 申请租约 → 等待或让行 → 释放 → 超时升级」的可执行规程（0.2.0 起由 collab_lock / collab_unlock / collab_locks 机器判定）、FIFO 排队与死锁避免规则，以及 collab_* 不可用时的降级路径，避免两个会话“都以为自己拿到了”。
---

# 同工作区协作协调（租约 / 让行 / 死锁避免）

## 何时用

- 同一工作区有 ≥2 个活跃会话，且**可能动同一资源**：
  - 测试窗口 / 全量测试套件（例：排钟专题 vs 加载未实施 issues 争 `pytest` 窗口）；
  - 同一个文件或模块（例：`packages/state/src/machine/worker/store.ts`）；
  - 全量构建、数据库迁移、占用固定端口的服务。
- 你已经**观察到等待**（「窗口被占用」「等对方释放」）——这时必须显式协调，不要靠 `ps` 猜。

## 何时不用

- 只读操作、批处理无关文件、单测互不干扰。
- 交接「谁来做」用 `collab_handoff` / `collab_broadcast`（那是 handoff），**不是**这里的锁。

## 规程（五步，0.2.0 起机器判定）

### 1. 查看占用

```text
collab_locks { resource: "test-window" }     # 只读：持有者/模式/剩余 TTL/排队者
collab_locks { }                             # 全部资源
```

`collab_list` 末尾也会追加**本会话**的「持有 / 排队中（第 N 位）」。
输出里 `free` 表示没人持有；`held` 时看 `holders=` 与 `剩余=`。

**要一眼看全局**（谁持有、谁在排队、哪些交接没闭环）就打开 OpenCode Desktop 的侧栏
`collab` 面板（0.3.0 起，只读；composer 上的 pill 显示本会话「锁 N · 等待 M」）——
它读的是同一份 `stateOf()`，不会和 `collab_locks` 不一致；但**面板不能加锁/释放**，
写操作仍然只有下面两步的工具。

### 2. 申请

```text
collab_lock { resource:"test-window", mode:"exclusive", ttlMs: 900000, reason:"全量 pytest", confirm:true }
```

- `exclusive`（默认）与任何模式互斥；`shared` 只用于**只读**共享（各跑各的定向用例）。
- `ttlMs` 默认 15 min，夹在 `[10s, 2h]`；过期自动回收（下次访问判定），不需要人工清理。
- 同一会话重复申请**幂等**：返回既有租约，不重复计数、不延长 TTL。
- 不带 `confirm:true` 只预览（当前持有 + 将要写入的字段），不写文件。

被占时的返回就是答案：「`holders=ses_x 剩余=8m 后到期`」。此时按第 3 步决策。

### 3. 等待或让行

```text
collab_lock { resource:"test-window", wait:true, confirm:true }   # 进入 FIFO 队列，返回排位
```

- **不会有人主动叫醒你**（锁不投递消息、不打断会话）：持有者释放 / 租约到期后，
  下一次 `collab_locks` 会显示 `free`，再次 `collab_lock` 即按 FIFO 获得；
  队首会被优先，新人不能插队。
- 队列上限 **50**：满员时**拒绝新申请**并给出可读原因（已有排队者一个都不会被挤掉）；
  稍后重试，或先做无冲突部分。
- 也可以让行：先做无冲突部分（静态检查、定向单测、读代码），并把「等窗口」写进任务记录。
- 不要重复催办；一次请求 + 一次到期检查即可。

### 4. 释放

```text
collab_unlock { resource:"test-window", confirm:true }
```

- 只有**持有者**能释放；`shared` 组只移除自己，其他人继续持有。
- **没有 force**：抢占是人工决定（`[protected*]` 持有者永不被顶掉）。
- 异常退出也要补释放；租约到期会自动回收，但那是兜底而不是习惯。

### 5. 超时升级

超过 `ttl` 仍未见释放 → 不要擅自抢占；发一条 `BLOCKED`/note 说明，并把冲突写进任务，交给 owner 裁决。

## 死锁避免

| 规则 | 说明 |
| --- | --- |
| 多资源按**名称排序**依次申请 | 避免 A 拿 X 等 Y、B 拿 Y 等 X |
| TTL 可选，默认 15min，上限 2h | 过期自动回收，不靠人工 |
| 队列上限 50，满员拒新 | 不挤掉已在排队的人（队首名次稳定） |
| 嵌套等待 ≤ 1 层 | 拿着锁去等另一个锁，必须显式说明并设更短 TTL |
| 抢占需人工 | 工具不提供 force；不接受「强行抢过来」 |
| 一次只持有一个独占资源 | 缩小持有面 |
| 排队即等待，不轮询轰炸 | 回合制的 `collab_locks` 检查足够 |

## 场景样例

1. **测试窗口**（真实案例）：排钟会话占 `test-window` 10+ 分钟，issues 会话两次请求未获释放。
   正确做法：排钟会话 `collab_lock {resource:"窗口", ttlMs:600000, reason:"全量 pytest"}`；
   issues 会话 `wait:true` 排队并转做定向用例，到期检查一次。
2. **同一文件**：两个会话都要改 `worker/store.ts` → 一个申请
   `file:packages/state/src/machine/worker/store.ts`，另一个改 `worker/project.ts` 并等前者。
   同一文件的不同写法（`file:` 前缀 / 裸相对路径 / 中文别名）会被归并为一个资源。
3. **全量构建**：`build`（= `全量构建`）独占；等待方跑定向 `pnpm --filter <pkg> build` 验证局部。

## 与 handoff 的分工

- **锁**：解决「同时做同一件事」的资源竞争；
- **handoff**：解决「这件事该谁做」；
- 不要把锁当成交接手段，也不要用交接代替互斥。

## 降级路径（`collab_*` 不可用 / 版本 < 0.2.0）

1. 明确写下「协作工具不可用，改用本地判定」；
2. 用 `ps` / `git status` / 端口占用判断；
3. 用消息协商，**写明三要素**：资源名、预计时长、释放条件：

```text
collab_send { target:"<对端会话>", kind:"request",
  text:"[窗口] 我要独占 test-window 约 10 分钟（全量 pytest），结束后立刻发 [窗口] released。若你需要先用请回 DECLINE。", confirm:true }
```

4. 保守策略：**假定资源被占用**，先做无冲突部分；
5. 在任务记录与最终回复里注明「未协调成功/原因」，不要静默假设。

## 硬约束

- 不向 `[protected]` / `[protected-child]` 投递；不删除他人会话。
- 不因锁阻断消息投递：锁只用于**自愿**协调；锁也不替代 git 操作。
- 释放必须显式（工具或消息），不要「跑完就算了」。
