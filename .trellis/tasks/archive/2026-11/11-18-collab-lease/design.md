# 设计：资源租约与状态机

## 1. 数据

```jsonc
// ~/.config/opencode/collab-locks/<hash>.json
{
  "resource": "test-window",          // 规范化后的资源名
  "kind": "named|file|build",         // 仅展示用
  "mode": "exclusive|shared",
  "holder": "ses_…",
  "holders": ["ses_…"],               // shared 模式：多个
  "acquiredAt": 0,
  "ttlMs": 900000,
  "expiresAt": 0,
  "waiters": [{ "sid": "ses_…", "at": 0, "mode": "exclusive", "reason": "…" }],
  "history": [{ "sid": "…", "at": 0, "event": "acquire|release|expire|preempt" }]
}
```

- `<hash> = sha256(normalize(resource)).slice(0,16)`；文件名同时保留可读前缀 `<hash>__<slug>.json`；
- 目录 `~/.config/opencode/collab-locks/`（`COLLAB_LOCK_DIR` 可覆盖，harness 用）。

## 2. 资源规范化

| 输入 | 归一化 |
| --- | --- |
| `test-window` / `窗口:测试` | `named:test-window`（小写、去空白、中文别名映射表） |
| `packages/state/.../store.ts` | `file:<workspace 相对路径>`，`realpath` 校验在 workspace 内，拒绝 `..`/绝对/软链 |
| `build` | `named:build` |

不同写法指向同一资源（同一文件绝对/相对路径、同一中文别名）。

## 3. 状态机

```
free ──acquire──▶ held ──release──▶ free
                   │
                   ├──expire──▶ free（holder 记录为 expire）
                   └──shared acquire──▶ held(holders+1)

被占用时的申请：held ──request──▶ waiters[]（排队）
waiters 在下次访问时按 FIFO 提示；不主动唤醒（避免打断）
```

- 与 handoff 状态机（`open/claimed/acked/done/blocked/expired`）**完全分离**；
- 共享只读视图 `stateOf(record)` 供侧边栏：`{resource, mode, holders, waiters, expiresIn}`。

## 4. 原子性

- 申请：`open(<file>.lock, 'wx')` 抢短锁 → 读记录 → 判定（free / 兼容 shared / 被占）→ 写记录（`tmp+rename`）→ 释放短锁；
- 短锁 2s 超时 + 过期清理（防崩溃遗留）；
- 幂等：同一 `sid` 对同一资源重复申请 → 返回既有租约（不重复计数）。

## 5. 工具

| 工具 | 入参 | 行为 |
| --- | --- | --- |
| `collab_lock` | `{resource, mode?, ttlMs?, reason?, wait?, confirm}` | `wait:true` 时进入排队并返回排位；否则立即返回「被谁持有 + 剩余 TTL」 |
| `collab_unlock` | `{resource, force?, confirm}` | 仅 holder 可释放；`force` 需 owner 显式（默认拒绝） |
| `collab_locks` | `{resource?}` | 列表：持有/模式/剩余 TTL/等待者；`collab_list` 复用该读取 |

- 所有写操作 `confirm:true`；预览展示当前状态与将要写入的字段；
- 不触发任何消息投递（锁是纯本地状态，跨会话通过文件共享）。

## 6. 安全与边界

- `[protected*]` 会话**可持有**（不因其身份阻断），但 `force` 抢占一律拒绝；
- `file:` 资源必须 realpath 在 `workspace` 内；软链拒绝（与 broadcast 提案一致）；
- TTL 上限 2h、下限 10s；`reason` ≤200 字并去控制字符；
- 不自动加锁；不阻塞消息投递。

## 7. 回滚

删除 `collab-locks/` 即释放全部；代码 `git restore`；无数据迁移。
