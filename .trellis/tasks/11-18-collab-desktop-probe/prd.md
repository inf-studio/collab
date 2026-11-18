# PRD：R-7 修复 + Desktop 可见性探针（0.5.2）

## 背景

1. **R-7（已记 issue）**：`src/gui.tsx` 的 `createSnapshotStore.load()` 用 `inFlight` 守卫直接丢弃并发调用。
   0.5.1 把轮询 key 改成路由会话 id 后，正常切换会立即重载；但切换瞬间若恰有一次请求在飞，
   这次重载被吞掉，`queue`（按 requester 计算）会短暂停留在**旧会话**的数字，最长到下一个 tick（2 s）。
   提案：`docs/issues/bugs-gui-poll-inflight-stale-session.md`。
2. **Desktop 可见性无法自证**：用户的 Desktop 连的是远端服务器 `vhost-remote`，Settings → 扩展 → 插件里
   `collab` 一行**没有 GUI 开关**（按官方文档，带 `./gui-experimental` 的插件应有开关），界面也没出现。
   包内 `dist/gui-experimental.cjs` 存在、服务端 `features.gui=true`、裸调 `/api/plugin/gui` 为 401（只有 app
   主进程持有凭据）。官方文档：GUI 从「桌面应用自己的后台服务器」加载。**远端是否不加载 GUI 尚未证实。**
   需要插件自己提供一个「我加载了」的证据，而不是继续靠猜。

## 需求

- **R1 R-7 修复**：`load()` 在请求开始时记下目标会话；收尾时若会话已变（且未 dispose / 未隐藏），补排一次
  `load()`。不得移除 `inFlight`（防打爆服务端），不得产生无限补排；未切换时不产生额外请求。
- **R2 常驻探针**：注册 `TitlebarItem`（`id:"status"`）：有数据时 `collab N`（N=锁+交接+队列），无数据时
  `collab`；点击有路由会话 → 打开面板；无会话 → `toast` 自证：标题「Collab GUI 已加载」+ 描述含
  插件 id、版本、面板 key、app 版本与 platform。**不新增写路径**。
- **R3 命令兜底**：现有 `collab.open` 命令在无路由会话时（`enabled` 仍应使其在无会话时不可用——
  该场景由标题栏 pill 覆盖）不改变语义；若实现上命令可行，`run` 拿不到会话时给同一条 toast。
- **R4 只读**：新增代码只允许 `layout.open` / `toast.show`；不得出现 rpc 写方法、归档、锁操作。
- **R5 文档**：README / `docs/collab.md` §11.11 增「Desktop 排查」小节：① 插件行是否有 GUI 开关；
  ② 命令面板搜 collab；③ 标题栏 pill 是否出现；④ 点 pill/命令无会话时是否弹「已加载」toast。
  措辞必须写「远端服务器是否加载 GUI 尚未确认」，不得断言平台缺陷。

## 约束

- 不新增运行时依赖；不改工具/RPC 契约；`mod+shift+l` 与 TUI `ctrl+shift+l` 分开书写。
- 探针必须**零配置**（不需要用户改 `opencode.json`），且在没有快照时不显示 `0`。
- 版本 `0.5.2`；`package.json` 与 `src/constants.ts` 的 `PLUGIN_VERSION` 一致。

## 验收

- [ ] 慢 RPC（>200 ms）+ 请求在飞时切会话 → 旧包落库后**立即**再发一次，且 `session` 为新会话；未切换时每 tick 仍 1 次。
- [ ] 隐藏（`pageHidden()`）期间不补排；dispose 后不补排。
- [ ] `TitlebarItem` 注册：无数据 `collab`、有数据 `collab N`；点击有会话 → `layout.open("collab:main", session)`；
      无会话 → `toast.show` 且不调用 `layout.open`。
- [ ] 回归：既有 `638 + 12 + 35 + 29 + 21` 全绿 + 新增断言；`node scripts/check-skill.mjs` 通过。
- [ ] 文档四处更新；CHANGELOG 0.5.2。

## 非目标

- 不做窗口级日志回传、不做远端 GUI 兼容层、不改桌面客户端。
- 上游 issue 单独处理（已获授权另提）。
