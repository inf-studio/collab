# 切换会话时若有请求在飞，`queue` 会短暂停留在旧会话

- 状态: open
- 范围: 前端（`src/gui.tsx` 的 GUI 快照轮询）
- 关联: 任务 `11-18-collab-entrypoints`（0.5.1）增量复核 R-7；`research/check-report.md`
- 影响版本: 0.5.1（0.5.0 及更早没有 `session` 参数，表现为「队列恒 0」，问题形态不同）

## 现象

`sharedStore.load()` 有 `inFlight` 守卫：一次请求没回来时后续调用直接返回。0.5.1 把轮询 key 改成
路由会话 id，正常情况下切会话会立刻重载；但如果切换的瞬间恰好有一次请求在飞，这次「立即重载」会被
`inFlight` 吞掉，旧会话的回包仍然落库，于是 `session.header` 计数条与面板里的 `队列` 最多显示到下一个 tick
（2 s）为止的旧会话数字。

复核实测：500 ms 慢快照 + 200 ms 处切换 → 第二次请求在 2303 ms 才发出。

## 根因

`src/gui.tsx` `load()`：

```ts
if (disposed || inFlight) return;
inFlight = true;
try { const reply = await rpc(); ... } finally { inFlight = false; }
```

守卫按「有没有请求在飞」丢弃调用，而不是按「目标会话是否已经变了」。

## 建议方案

在 `finally` 里比较：请求开始时记下 `wanted = ctx.sessions.current()?.id ?? ''`，收尾时若
`(ctx.sessions.current()?.id ?? '') !== wanted` 且未 `disposed`，补排一次 `void load()`（递归一层即可，
新请求会重新记 `wanted`）。不要为此去掉 `inFlight`（会打爆服务端）。

## 验证

- 假 ctx + 慢 RPC（>200 ms）：会话 A 请求在飞时切到 B → 旧包落库后**立即**再发一次且 `session === B`；
- 未切换时不产生额外请求（每 tick 仍 1 次）；
- `pageHidden()` 期间不补排。

## 涉及文件

- `src/gui.tsx`（`createSnapshotStore.load`）
- `test/gui-entry.mjs`（新增慢 RPC 断言；注意 Solid 双实例问题，见 check-report R-9）

## 优先级

低：只是切会话瞬间最多 2 s 的旧数字，不写任何状态。可与下一次 GUI 改动一起发。
