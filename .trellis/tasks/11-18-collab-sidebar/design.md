# 设计：协作侧边栏（GUI）

## 1. 包结构变化

```jsonc
// package.json
"exports": {
  ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./gui-experimental": "./dist/gui-experimental.cjs"
},
"files": ["dist", "README.md", "CHANGELOG.md", "skills"],
"devDependencies": { "vite": "^7", "vite-plugin-solid": "^2.11", "solid-js": "^1.9" }
```

- `@opencode/plugin/gui` 由宿主提供（runtime），只取类型；
- 构建：`vite build -c vite.gui.config.ts`（`@opencode/plugin/gui/vite` 的 `gui()` preset），输出单 `.cjs`；
- `build` 脚本 = `vp pack && vite build -c vite.gui.config.ts`（CI 已跑 `pnpm build`）。

## 2. 数据通道

```
server part (src/index.ts) ── RPC Contract (src/rpc.ts) ──▶ GUI (ctx.client.rpc)
```

- Contract `collab.state`：`snapshot({ workspace?: string })` → 只读快照；
- 返回结构：

```ts
type Snapshot = {
  at: number
  sessions: Array<{ sid: string; title: string; agent: string; busy: boolean }>
  locks: Array<{ resource: string; mode: 'exclusive'|'shared'; holders: string[]; expiresInMs: number; waiters: number }>
  handoffs: Array<{ bid: string; state: string; ageMs: number; from: string; claimBy?: string }>
  reachable: true
}
```

- 数据来源复用 `collab_locks` / `collab_list` 的读取层（C1 的 `stateOf` + 现有 broadcast 读取），**不新造状态**。

## 3. UI

| 位置 | 内容 |
| --- | --- |
| **Panel** `region:"side"`, `width:"narrow"` | 按工作区分组：会话（title/agent/busy）、其持有锁（模式/剩余 TTL）、等待队列、未闭环 handoff（state/age） |
| **ComposerPill** | 当前会话：`锁 2 · 等待 1`（有冲突时 `tone: warning/danger`） |

- 只读：不提供加锁/释放按钮；
- 面板可见时每 2s 拉一次快照（`createKeyed` + 定时器），不可见时停；
- server 不可达 → 显示「server 不可达」占位，不空白、不崩溃；
- 关闭：Settings → Extensions → Plugins 的开关（宿主提供）。

## 4. 失败与兼容

| 场景 | 行为 |
| --- | --- |
| GUI 加载失败 | server 插件不受影响（官方保证「server 失败则无 GUI；GUI 失败不影响 server」） |
| server 版本不匹配 | RPC 调用 reject → 占位提示 |
| TUI / Web | GUI 不加载；`collab_list` 文本视图仍可用 |
| experimental API 变动 | 锁 opencode 版本区间；CI 只在 install 成功的环境构建 |

## 5. 回滚

移除 `./gui-experimental` 出口与 `vite.gui.config.ts`；server 与工具不受影响。
