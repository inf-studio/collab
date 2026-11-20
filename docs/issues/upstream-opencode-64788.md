# 上游：GUI 插件只从 app 自己的 sidecar 加载（#64788 → 已并入 #63990）

- 状态: **已关闭（duplicate of #63990，2026-11-19）**；跟踪转 `anomalyco/opencode#63990`（OPEN）
- 范围: 上游（`anomalyco/opencode`），影响本仓 GUI 插件在「远端会话」下的可用性
- 关联: 现象与证据以本仓 `docs/issues/bugs-desktop-remote-gui-not-loaded.md` 为准；本文只记录**上游状态与解除条件**
- 影响版本: 0.5.x–0.9.6

## 上游状态（核实于 2026-11-20）

```
$ gh issue view 64788 -R anomalyco/opencode --json state,stateReason,closedAt,title
{"closedAt":"2026-11-19T10:11:36Z","state":"CLOSED","stateReason":"DUPLICATE",
 "title":"desktop: GUI plugin parts load only from the app's own sidecar, so remote-server plugins never get a GUI"}

$ gh issue view 63990 -R anomalyco/opencode --json state,title
{"state":"OPEN","title":"[FEATURE]: GUI plugins for sessions on every connected server, in the web app and Desktop"}
```

维护者在 64788 下的结论（要点）：

1. 关闭为 **#63990 的重复**；
2. 「从远端 server 加载插件 bundle」的方案**已被排除**——理由是远端代码 + 桌面端本地权限的信任模型；
3. #63990 的方向是：GUI 仍由**每个 server 自己的前端**提供，但按 `session.server` 作用域，让每个已连接 server 的会话都能显示自己那一侧的 GUI。

## 影响

- 跨机协作时「看不到对方会话的看板」；工具层（`collab_*`）不受影响，仍由各自 server 执行。
- 本机安装可绕过，但每台机器都要各装一份。

## 我方绕过（0.9.x 现状）

1. 每台机器（Linux / mac）都 `plugin add @inf-studio/collab@<version>`；
2. GUI 侧按会话取 `session.server.client ?? ctx.client`，避免直连本机数据；
3. 版本升级两端同步（发布节奏：0.9.0 / 0.9.3 / 0.9.6）。

## 解除条件（以 #63990 为准，不再引用 64788）

- 上游实现「每个已连接 server 的会话显示其自带 GUI」（`#63990`）；
- 在此之前，**不要把「从远端 server 加载 bundle」当作解除条件**——该方向已被上游否决。

## 跟进

- 本仓无需再对 64788 做任何操作（已关闭）；
- 若 #63990 落地，再评估是否移除「每台机器各装一份」的绕过。
