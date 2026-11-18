# 设计：按会话服务器取 client（0.5.3）

## 1. 现状与缺口

```ts
// 现在（0.5.2）：固定用宿主给本插件的 client
const reply = await ctx.client.rpc(CollabState).snapshot({ session });
```

插件装在本机后，`ctx.client` 是**本机 sidecar** 的 client（文档原话："the desktop app's own server"）。
远端会话的 `queue` / `locks` 在远端服务器的插件里，本机读到的是空数据。

## 2. 目标

```ts
type Source = { key: string; client: OpenCodeClient };

function sourceFor(ctx): Source | undefined {
  const session = ctx.sessions.current();
  const server = session?.server;            // MountedSession.server: ServerRef
  const client = server?.client ?? ctx.client;
  const key = session ? `${server?.id ?? 'local'}\n${session.id}` : 'local\n';
  return { key, client };
}
```

- `ServerRef.client` 已由 app 鉴权（页签/会话就是这个 server 上的），无需自建 token。
- 跨服务器不聚合：一次只显示**当前路由会话所属服务器**的 snapshot（与既有「一份 store、一个轮询」一致）。

## 3. Store 改造

```ts
function createSnapshotStore(ctx: Context): SnapshotStore {
  // load() 每次读取当前 source，而不是构造时固定 client
  const load = async () => {
    const source = sourceFor(ctx);
    if (!source) return;
    const sessionID = ctx.sessions.current()?.id;
    const reply = await source.client.rpc(CollabState).snapshot(sessionID ? { session: sessionID } : {});
    // 只在 source.key 未变时落库，避免旧服务器回包覆盖新服务器
    if (sourceFor(ctx)?.key !== source.key) return;
    setState({ ... });
  };
}
```

- **迟到回包保护**：请求前后比较 `source.key`，不同则丢弃（与 R-7 的 `wanted` 同思路）。
- 状态里增加 `source?: { server: string; session?: string }`，供 pill/toast 显示。

轮询 key 改为 `sourceFor(ctx)?.key ?? false`（含服务器），隐藏/可见仍走 0.5.2 的显式 start/stop。

## 4. 探针

- toast 描述追加 `server=${server?.id ?? 'this computer'}`；
- `TitlebarItem` 不变（`collab` / `collab N`），不把服务器名塞进窄 pill；
- 面板顶部/`panel.current` 行可显示 `server`（只在非本机时显示 `@<id>`，避免噪音）。

## 5. 测试（`test/gui-entry.mjs`）

| 用例 | 期望 |
| --- | --- |
| `sessions.current()` 带 `server.{id,client}` | snapshot 打到 **server.client**，参数 `session` 是该会话 id |
| 无 `server` | 回退 `ctx.client` |
| 两个会话分属 A/B 服务器 | 切换后立即用 B 的 client；**不出现**「A 的回包写进 B 的状态」 |
| 迟到回包 | A 慢回包在切到 B 之后到达 → 被丢弃，状态仍是 B |
| toast | 含 `server=` 与版本；无会话 0 次 `layout.open` |

harness 需要：`sessions.current()` 返回带 `server` 的对象（可切）；`client` 为可注入的假 client（记录 rpc 调用）；
`ctx.client` 仍是本机 client（用于回退断言）。

## 6. 安装（本机）

```bash
npm config set @inf-studio:registry https://npm.pkg.github.com
echo "//npm.pkg.github.com/:_authToken=$(gh auth token)" >> ~/.npmrc   # 已有则跳过
opencode plugin add @inf-studio/collab@0.5.3
```

- 装完重启 Desktop（GUI 宿主在 app 启动时读取插件清单）。
- 验证顺序：标题栏出现 `collab` → 打开远端会话 → 面板/计数条出数（数值应等于远端 `collab_locks`/`collab_list`）。

## 7. 回滚

`git restore -- src/gui.tsx test/gui-entry.mjs`；已装到本机的插件不影响远端会话（server 部分只服务本机会话）。
