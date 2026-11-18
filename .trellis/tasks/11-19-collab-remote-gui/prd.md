# PRD：Desktop 远端会话 GUI（本机承载 + 按会话取 client）

## 背景（已用桌面端源码验证，不是猜测）

- Desktop 的 GUI 插件宿主只跟踪**本机 sidecar**：`out/main/host-*.js` 里 `D = () => pe()`（本机 URL），
  `subscribe-credentials` 用 `D()`；`ie(serverId)` 只有 `id === 'sidecar'` 分支会返回本机凭据。
  宿主对它 `plugin.list()` → 过滤 `features.gui && active && 非 builtin`（`rt()`）→ `plugin.gui({id})` 取 bundle。
- 于是：**远端服务器上的插件的 GUI 部分永远不会被加载**——设置页只有名字、没有 GUI 开关。
- GUI SDK 提供了跨服务器能力：`ctx.servers.list()/get(id)` 返回**已鉴权**的 `ServerRef.client`；
  `MountedSession.server` 指向会话所属服务器；`ctx.app.platform === 'desktop'`。
- 因此可行路径：把插件装到**本机**（GUI 才会加载），GUI 再按「会话所属服务器」的 client 读取远端数据。

## 需求

- **R1 数据源跟随会话服务器**：GUI 的 snapshot 请求必须使用 `ctx.sessions.current()?.server?.client`
  （缺失时回退 `ctx.client`）。远端会话 → 远端 server 的 `collab.state.snapshot`；本机会话 → 本机。
- **R2 轮询按服务器+会话重建**：key 用 `${server.id}\n${session.id}`；服务器切换时旧 store 结果不得串台
  （不能用上一台服务器的 snapshot 渲染）。
- **R3 探针标明身份**：标题栏 pill / 无会话 toast 里显示当前数据源服务器（`server.id` 或 `this computer`）
  与插件版本，便于用户一眼确认「读取的是哪台服务器」。
- **R4 只读不变**：仍然只有 `layout.open` / `toast.show`；无 rpc 写方法。
- **R5 文档与安装**：README / `docs/collab.md` 增「Desktop 如何让它出现」：本机安装（
  `npm config set @inf-studio:registry https://npm.pkg.github.com` + `opencode plugin add`）、
  为什么必须装在本机（宿主只加载本机 sidecar）、远端数据如何来。

## 约束

- 不修改桌面端、不伪造左侧栏、不请求新权限。
- 本机没装插件时，远端仍然「无 GUI」——这是平台行为，文档必须写明。
- 版本 `0.5.3`；`package.json` 与 `PLUGIN_VERSION` 一致。

## 验收

- [ ] 远端会话：snapshot 打到该会话所属 server 的 client（不是 `ctx.client`）；`session` 参数是远端会话 id。
- [ ] 本机会话 / 无 `server` 字段：回退 `ctx.client`。
- [ ] 切换会话（跨服务器）→ 立即以新服务器 client 重新请求，不出现旧服务器的数字。
- [ ] toast 含服务器标识与版本；无会话点击仍只 toast、0 次 open。
- [ ] 回归：既有 `638 + 12 + 35 + 29 + 39` 全绿 + 新增断言；`check-skill` 通过。
- [ ] mac 实机：本机安装插件后，Desktop 出现标题栏 pill；打开远端会话时面板显示远端数据。

## 非目标

- 不做「本地缓存历史 / 跨服务器聚合视图」。
- 不修桌面端 UI（上游另议）。
