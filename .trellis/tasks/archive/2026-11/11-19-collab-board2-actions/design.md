# 设计：看板快捷动作

## 1. RPC 契约（additive）

```ts
// src/rpc.ts
interface CollabState {
  snapshot(input): Promise<Snapshot>;
  escalate(input: { target: string; reason?: string }): Promise<ActionReceipt>;
  freeze(input: { target: string; scope?: 'session'|'workspace'; until?: number|string; reason?: string }): Promise<ActionReceipt>;
  unfreeze(input: { target: string; scope?: 'session'|'workspace' }): Promise<ActionReceipt>;
  archive(input: { target: string; restore?: boolean }): Promise<ActionReceipt>;
}
interface ActionReceipt { ok: boolean; action: string; target: string; detail: string }
```

- 服务端 `index.ts` 注册同名 handler，内部调用与工具相同的 core 函数（把工具里的编排抽到 core，避免两套）；
- actor = 调用方会话（RPC handler 拿到 sessionID 时）；拿不到则记 `actor:"gui"` 并在 audit 标注。

## 2. GUI

- 动作行按钮：`escalate` 需理由（弹出 `dialog.prompt` 或复用 confirm 的输入）；`freeze` 默认 30min，可填时长；
- 点击 → `ctx.dialogs.confirm`（不可用则两步点击）→ `ctx.client.rpc(CollabState).escalate(...)` → toast；
- 成功后触发一次 snapshot 刷新（不新增轮询）。

## 3. 安全

- 复用 `BUILTIN_PROTECT` + 血缘 + 只读 agent 降级 + 冻结优先；
- RPC 只接受白名单动作与目标，不接受任意文件路径/命令；
- audit 只追加，失败也记（含 reason）。

## 4. 测试

假 RPC 客户端 + 假 ctx：四动作生效、门禁、确认取消、audit 行数、RPC 抛错。

变异：把 protected 判定去掉 → 拒绝断言失败；audit 漏写失败路径 → 断言失败。

## 5. 回滚

配置 `boardActions: false` 隐藏动作行（不删 RPC）。
