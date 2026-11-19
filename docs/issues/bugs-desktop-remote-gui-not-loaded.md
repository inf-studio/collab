# Desktop 只从本机 sidecar 加载 GUI 插件（远端服务器无 GUI）

- 状态: 已确认（上游 issue 已提：anomalyco/opencode#64788）
- 范围: 前端（OpenCode Desktop 宿主行为；本插件只需据此调整安装方式）
- 关联: `docs/collab.md` §11.11、`.trellis/spec/frontend/opencode-plugin-ui.md` §2.5

## 现象

Desktop 连远端服务器时，`@inf-studio/collab` 在 **Settings → Extensions → Plugins** 里只有名字与图标：
**没有 GUI 开关**，命令面板/标题栏/侧栏/面板全部不出现。把**同一个版本**装到本机（`This computer`）
后 GUI 正常加载——证明 bundle 与插件本身没问题。

## 证据（都来自实测/源码，不是猜测）

1. 远端服务器 `/api/plugin`：`features {server:true,tui:true,gui:true}`、`state active`；
   `GET /api/plugin/gui?id=<id>` 裸调 401（桌面主进程持有凭据，属预期）。
2. 桌面端 `app.asar → out/main/host-*.js`：
   - `D = () => pe()`（本机 sidecar URL），`subscribe-credentials` 用 `D()`；
   - `ie(id)` 只有 `id === 'sidecar'` 走本机凭据，远端分支 GUI 宿主从不调用；
   - 枚举：`client.plugin.list()` → 过滤 `features.gui && active && 非 builtin` → `client.plugin.gui({id})`，全部打在同一 endpoint。
3. 本机装同版本后：GUI 加载成功、`features.gui` 生效（标题栏 pill/命令/面板都出现）。

## 结论

**远端服务器上的插件，GUI 部分永远不会被加载**——这是宿主当前行为，不是插件配置错误。

## 绕行（本插件已采用）

1. 插件装在**桌面本机**（`opencode plugin add @inf-studio/collab@<ver>`，桌面端会从本机 sidecar 加载 GUI）；
2. GUI 的数据源按**会话所属服务器**取：`session.server.client ?? ctx.client`（0.5.3 起）；
3. 轮询 key 含 `server.id`，迟到回包按 key 丢弃，避免跨服务器串台。

## 若要官方支持远端 GUI

上游 issue 64788 里给了两条建议：① 从当前选中的服务器加载 GUI bundle（app 内已有
`servers[].client` 鉴权）；② 至少文档化并在设置行里写明限制。
