# PRD：collab 入口与 TUI 侧栏交互（0.5.1）

## 背景

0.4.2 的侧栏方案有两处「存在但看不见」：

1. **Desktop**：GUI 插件只能挂 `Panel`（会话右侧面板）/`MenuItem`（+ 菜单）/`Slot`/`ComposerPill`，没有左侧应用侧栏。
   我们只注册了 Panel + MenuItem + 只在「本会话持有租约」时出现的 ComposerPill，**没有注册 Command**，
   于是命令面板里搜不到、也没有快捷键；右侧面板区没打开时，用户完全看不到任何 collab 痕迹。
2. **TUI**：`sidebar.content` 只有一个静态 `<text>`，没有点击/展开；宿主 MCP 那种折叠是宿主自己画的，
   插件可以给自己的行加鼠标事件，我们没做。

owner 决策（2026-11-18）：Desktop 走「命令 + 会话头计数条」；TUI 走「点击展开 + 点行跳面板」。

## 需求

- **R1 Desktop 命令**：注册 `Command`，`id="open"`，命令面板可搜（中英文关键词），默认键 `mod+shift+l`
  （与 TUI 的 `ctrl+shift+l` 语义一致），`slash: { name: "collab" }`；仅在当前路由到会话时 `enabled`；
  执行 = 打开 `collab` 右侧面板（`ctx.layout.open("<id>:main", session)`）。不得引入写入能力。
- **R2 Desktop 常驻计数条**：`Slot at "session.header"` 渲染 `锁 N · 交接 M · 队列 K`，数据与面板同一个 store
  （同一轮询，不新增 RPC 流）；点击 = 打开面板；无快照时**不占位**（隐藏，不显示 `0`）；不可达时显示 `collab: n/a`
  并可点击打开面板看横幅。
- **R3 TUI 折叠**：侧栏摘要行默认一行（带折叠指示 `▸`/`▾`）；**点击**该行就地展开/折叠，展开最多 4 行明细
  （锁 → 交接 → 队列，超出的以 `+N` 结尾）；**点击明细行**打开 `/collab` 全量面板；再次点击摘要行折叠。
  展开行数、文本都来自已有 `collab.state.snapshot`，不得新增轮询（沿用面板那把 2s 轮询 / 侧栏一次 load）。
- **R4 兜底**：鼠标不可用（宿主未开鼠标）时，`/collab` 与 `ctrl+shift+l` 仍能打开面板；展开态不得抛错。
- **R5 只读**：本版不新增任何写路径（无锁释放、无归档按钮）；Desktop 命令与计数条只做「打开面板」。

## 约束

- 只能在 GUI SDK 现有槽位内实现（`session.header` / `Command`），**不要**伪造左侧栏。
- 面板/pill/菜单的既有行为不回退（`autoOpen` 语义、`opened === 'open'` 判定保持）。
- TUI 侧栏若被宿主固定为一行高度，展开内容可能被裁剪：必须有降级（不崩溃、`/collab` 仍可用），
  并在文档写明这一风险。

## 验收

- [ ] Desktop：`Command` 出现在命令面板、`mod+shift+l` 打开面板、`/collab` 可用；会话头计数条显示三个数并点击开面板。
- [ ] Desktop：无数据时计数条隐藏；server 不可达时显示 `n/a` 且点击仍能开面板。
- [ ] TUI：默认一行；点击展开出现明细（≤4 行）；点击明细行打开面板；再点摘要行折叠；展开态不新增轮询。
- [ ] 回归：既有 `638 + 12 + 35 + 17` 全绿 + 新增断言；`node scripts/check-skill.mjs` 通过。
- [ ] 文档：README / `docs/collab.md` §11.11 / CHANGELOG / skill 各一句；版本 `0.5.1`。

## 非目标

- 不改宿主、不新增 GUI 槽位、不接管桌面左栏。
- 不做「本地缓存历史」「多窗口共享状态」等新能力。
