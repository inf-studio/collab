# 设计：R-7 修复 + Desktop 探针（0.5.2）

## 1. R-7：补排被 inFlight 吞掉的重载

```ts
const load = async (): Promise<void> => {
  if (disposed || inFlight) return;
  inFlight = true;
  const wanted = currentSessionID();          // ctx.sessions.current()?.id ?? ''
  try { ... } finally {
    inFlight = false;
    // 会话在这轮请求期间变了：这一轮的结果属于旧会话，补排一次（只一层）。
    if (!disposed && !pageHidden() && currentSessionID() !== wanted) void load();
  }
};
```

- 递归只有一层：新请求开始时会重新记 `wanted`，只有再次变化才会再补排；`inFlight` 仍然挡住并发。
- 隐藏（`pageHidden()`）期间不补排（隐藏时不轮询，由轮询 key 的变化在恢复时触发）。
- dispose 后不补排。

## 2. 探针：TitlebarItem

```ts
ctx.add(TitlebarItem, (): TitlebarItem => {
  const data = store.state.data;
  const n = data ? data.locks.length + data.handoffs.length + data.queue.length : 0;
  return {
    id: 'status',
    label: data ? `collab ${n}` : 'collab',
    title: ctx.t('titlebar.title'),
    icon: 'lock',
    run: () => {
      const session = ctx.sessions.current();
      if (session) { ctx.layout.open(`${ctx.id}:${PANEL_TAB}`, session); return; }
      ctx.toast.show({
        title: ctx.t('probe.title'),                       // "Collab GUI 已加载"
        description: `v${APP_VERSION} · id=${ctx.id} · panel=${ctx.id}:${PANEL_TAB}` +
                     ` · app=${ctx.app.version}(${ctx.app.platform})`,
        variant: 'success'
      });
    }
  };
});
```

- **无会话时**点击＝自证加载：能看到 toast 就说明 GUI 确实加载了，问题只在「面板打不开」；看不到就说明 GUI 没加载。
- 标签在无数据时为 `collab`（不显示 `0`）；有数据时 `collab N` 取三者之和。
- 只用 `layout.open` / `toast.show`（只读，R4）。

## 3. 命令兜底（R3）

`Command.run` 现在直接 `ctx.layout.open` 且 `enabled` 要求有会话。保持 `enabled`；`run` 内再加一次
`if (!session) { toast(...) ; return; }`，与 pill 共用同一个 `probeToast()`，避免两条实现漂移。

## 4. 测试（`test/gui-entry.mjs`）

| 用例 | 期望 |
| --- | --- |
| 无快照 | titlebar label === `collab`（不含 `0`） |
| 有快照（locks 2 + handoffs 1 + queue 3） | label === `collab 6` |
| 点击无会话 | `toast.title` 命中「已加载」；`layout.open` **0 次** |
| 点击有会话 | `layout.open('collab:main', session)`；无 toast |
| 命令 `run` 无会话 | 同一条 toast（与 pill 同一函数/文案） |
| R-7 慢 RPC | 请求在飞时切会话 → 旧包落库后立即第二次请求且 `session` 新值 |
| R-7 未切换 | 每 tick 仍 1 次（不补排） |
| R-7 隐藏 | 不补排 |

- harness 需补 `toast.show` 与 `app`（严格 Proxy 会拦未声明字段）。
- 慢 RPC：`harness` 增加可选 `delayMs`，用可 await 的 promise 控制回包时机。
- 每条新断言做一次**变异验证**（去掉补排 / 去掉 toast 分支 → 对应断言必须失败）。

## 5. 文档

- README「状态视图」加「Desktop 排查」四步；
- `docs/collab.md` §11.11.x 同步；
- `skills/collab/SKILL.md` 一句（探针是什么、看到什么说明什么）；
- CHANGELOG 0.5.2：R-7 + 探针，明确「远端 GUI 是否加载尚未确认」。

## 6. 回滚

`git restore -- src/gui.tsx test/gui-entry.mjs`；运行时无需开关（探针只读）。上游 issue 与本版解耦。
