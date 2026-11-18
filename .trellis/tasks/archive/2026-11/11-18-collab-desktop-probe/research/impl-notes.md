# 实施记录：R-7 修复 + Desktop 探针（0.5.2）

日期：2026-11-18 · 任务：`11-18-collab-desktop-probe`
改动文件：`src/gui.tsx`、`test/gui-entry.mjs`、`src/constants.ts`、`package.json`、`README.md`、
`docs/collab.md`、`skills/collab/SKILL.md`、`CHANGELOG.md`。

## 1. R-7：补排只可能有一层

实现（`src/gui.tsx` `createSnapshotStore`）：

```ts
const currentSessionID = (): string => ctx.sessions.current()?.id ?? '';

const load = async (): Promise<void> => {
  if (disposed || inFlight) return;
  inFlight = true;
  const wanted = currentSessionID();                     // ① 本轮的目标会话
  try {
    const reply = await ctx.client.rpc(CollabState).snapshot(wanted ? { session: wanted } : {});
    ...
  } finally {
    inFlight = false;
    if (!disposed && !pageHidden() && currentSessionID() !== wanted) void load();  // ②
  }
};
```

**为什么不会无限递归**：② 里的 `void load()` 是一次**新的** `load` 调用，它在 ① 重新记录
`wanted`。于是：

- 会话在第二次请求期间**没有再变** → `currentSessionID() === wanted` → 不再补排，链条停止。
- 会话**又变了** → 再补一次，但同样以「一次请求的时长」为节拍；`inFlight` 仍在（并发恒 ≤ 1），
  不会出现风暴。
- `disposed`（`onCleanup`）后 ② 整个条件为假；`pageHidden()` 期间也为假。
- **未切换时零额外请求**：`currentSessionID() === wanted`，② 不触发。

`inFlight` 未被移除，也没被改成「立即并发」：被 `inFlight` 挡下的并发调用仍然直接返回，
唯一的例外是「挡下它的那一刻会话已经变了」这种情况，由 ② 在**旧请求收尾后**补一次。

### 实测（`test/gui-entry.mjs`，`delayMs = 250`）

| 场景 | 断言 | 结果 |
| --- | --- | --- |
| t≈0 发请求（`ses_probe`），t≈80 切到 `ses_other`，t≈250 旧包落库 | 请求数 `1 → 2`，第二次 `session === "ses_other"` | ✓ `1 → 2: [{"session":"ses_probe"},{"session":"ses_other"}]` |
| 不切换，等 600 ms（跨过一整次 250 ms 慢回包 + 富余） | 仍 **1** 次请求 | ✓ `1 calls` |
| t≈80 时 `document.hidden = true` 再切会话 | 不补排（仍 1 次） | ✓ `1 calls` |

修复前（0.5.1，同一用例）：第二次请求要到下一个 tick（约 2000 ms）才发出——提案里复核实测是
「500 ms 慢快照 + 200 ms 处切换 → 第二次请求 2303 ms 才发出」，与本例的形态一致。

## 2. 探针：TitlebarItem

```ts
ctx.add(TitlebarItem, (): TitlebarItem => {
  const data = store.state.data;
  const counts = data ? data.locks.length + data.handoffs.length + (data.queue?.length ?? 0) : 0;
  return {
    id: 'status',
    label: data ? `collab ${counts}` : 'collab',
    title: ctx.t('titlebar.title'),
    icon: 'lock',
    run: () => { const session = ctx.sessions.current();
      if (session) { ctx.layout.open(`${ctx.id}:${PANEL_TAB}`, session); return; }
      probeToast(); }
  };
});
```

`probeToast()` 是**唯一**实现（pill 与 `Command.run` 共用）：

```
title       = ctx.t('probe.title')            → "Collab GUI 已加载" / "Collab GUI loaded"
description = ctx.t('probe.description', {…}) → "插件 v0.5.2 · id=collab · panel=collab:main · app=2.5.0(desktop)"
variant     = 'success'
```

### 四种可见性场景（一眼判定）

| 场景 | 用户看到什么 | 说明什么 |
| --- | --- | --- |
| 窗口加载了 GUI，且**有**路由会话 | 标题栏 `collab N`（或 `collab`，无数据）→ 点击打开 `collab:main` | 端到端可用 |
| 窗口加载了 GUI，但**没有**会话 | `collab` pill 存在；点击弹「Collab GUI 已加载」toast，**不**调 `layout.open` | GUI 加载了，只是没有会话可开面板 |
| 窗口**没有**加载 GUI | 没有 pill、没有 toast；命令面板也搜不到 `collab.open` | 这个窗口没加载本插件 GUI |
| pill 在、点击无反应（无 toast 也无面板） | 只有 pill | 注册成功但点击没被派发 → 记 app 版本 + platform，另提上游 |

数据来源是面板**同一个** `sharedStore`：不新增 RPC 流、不新增轮询（`test/gui-entry.mjs` 的
「注册时零 RPC」断言仍是 `0 calls`）。CSS 没变——pill 由宿主绘制。

### 只读（R4）

新增代码只出现 `ctx.layout.open` / `ctx.toast.show`（以及只读的 `ctx.app.version` / `ctx.app.platform`、
`ctx.id`、`ctx.t`）。`src/rpc.ts` 契约未动，没有 rpc 写方法、没有归档、没有锁操作。严格 Proxy harness
（未声明的 `ctx.x` 读取即抛）仍然全覆盖 `setup`，所以「多摸了一个 API」会立刻失败。

## 3. 测试：21 → 33 项，两次变异验证

新增 12 项断言：pill 注册（id/icon/title）、无快照 `collab`（不含 `0`）、有快照 `collab 6`
（2 锁 + 1 交接 + 3 队列）、有会话点击 → `layout.open("collab:main", ses_probe)` 且 0 toast、
无会话点击 → 1 toast / 0 open / 标题含「已加载」、toast 描述含版本 + id + panel + app(platform)、
三处版本号一致（`package.json` / `PLUGIN_VERSION` / toast）、命令与 pill 的 toast 逐字段相同、
R-7 三例（见 §1）。

harness 增补：`toast.show`（只记录，不渲染）、`app {version:'2.5.0', platform:'desktop'}`、
`delayMs`（慢回包），以及 `registered[].factory`（宿主的 pill 是响应式的，测试可在快照落库后重跑
工厂，取到 `collab 6`）。

### 变异 1：去掉 R-7 补排

把 `if (!disposed && !pageHidden() && currentSessionID() !== wanted) void load();` 改成 `if (false) void load();`，
只重建 GUI 产物后跑 `test/gui-entry.mjs`：

```
  ✗ R7 switching while a request is in flight reloads at once, naming the new session — 1 → 1: [{"session":"ses_probe"}]
  ✓ R7 an unchanged routed session queues no extra request (still one per tick) — 1 calls
  ✓ R7 a hidden window queues no reload (the key restarts the timer when it shows again) — 1 calls
=== 32/33 checks passed
FAIL: R7 switching while a request is in flight reloads at once, naming the new session
```

（第三行的断言标题在变异之后又改过一次措辞，现为 `R7 a hidden window queues no reload — the poller's key names whatever session is routed when it runs again`；这一行的结论不变。）

→ 只有目标断言失败（`1 → 1`，正是提案描述的「被吞掉」），另两例保持绿：它们测的是**不该**补排的
方向，所以这个变异对它们是负向证明。

### 变异 2：去掉 toast 分支

`probeToast()` 开头插 `if (probeToast) return;`（函数永不弹 toast），重建 GUI 产物：

```
  ✗ R1/R3 without a routed session the command is disabled and run() falls back to the probe toast — {"enabled":false,"opened":0,"toasts":0}
  ✗ R2 with no routed session the pill shows the "loaded" toast and opens nothing — {"opened":0}
  ✗ R2 the probe toast names the plugin, version, panel key and app/platform
  ✗ R2 package.json, PLUGIN_VERSION and the probe toast carry the same version — {"pkgVersion":"0.5.2","constantsVersion":"0.5.2"}
  ✗ R3 the command with no session shows the same toast as the pill (one implementation) — null
=== 28/33 checks passed
```

→ 5 条失败（含「命令与 pill 同一条文案」这条共实现断言，证明两条路径不会各自漂移）。
两次变异后都执行 `cp` 还原 `src/gui.tsx` 并重新 `pnpm build`，再跑全量。

## 4. 回归与版本

```
pnpm build        ✓
pnpm typecheck    ✓ (tsc --noEmit，无输出)
pnpm test         === 638/638  === 12/12  === 35/35  === 29/29  === 33/33  checks passed
node scripts/check-skill.mjs   skills ok
```

版本：`package.json` `0.5.2`、`src/constants.ts` `PLUGIN_VERSION = '0.5.2'`。GUI bundle **不能**
import `constants.ts`（它读 `node:os` / `node:path`，窗口里不存在），所以在 `src/gui.tsx` 里以
`PLUGIN_VERSION` 常量重述一次，并用测试断言三处一致——这是「不改 `vite.gui.config.ts` 也能检测漂移」
的最小做法。

## 5. 未做 / 留给主会话

- 不建 tag、不发布、不 `git add/commit`（按硬约束）。
- 远端窗口「到底有没有加载 GUI」仍是**尚未确认**：本版只提供探针，不做远端兼容层，不改桌面客户端；
  文档四处（README / `docs/collab.md` §11.11.2 + §11.11.4 / `skills/collab/SKILL.md` / CHANGELOG）
  都写明了这一点，没有断言平台缺陷。
