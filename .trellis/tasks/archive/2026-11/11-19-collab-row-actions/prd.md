# PRD：看板行内交互（0.8.1）

## 背景（漏项）

0.8.0 的看板行是「整行选中 + 纯文本标题 + 短 id」，owner 要求的「**标题作子链接跳会话、id 点击复制**」在拆任务时被漏掉。
SDK 已具备能力：GUI `ctx.tabs.open({server,id},{focus:true})` / `ctx.system.copy(text)`；TUI `ctx.ui.tabs.focus(sid)`。

## 需求

- **R1 GUI 行**：整行点击仍 = 选中；**标题**是子链接（点击 → 跳该会话，`stopPropagation`）；**短 id** 点击 → 复制**完整** id + toast「已复制会话 id」（`stopPropagation`）。
- **R2 GUI 详情头**：sid 同样可点复制（与行内一致）。
- **R3 TUI**：`o` → `ui.tabs.focus(sid)` 跳会话；选中详情显示**完整 id**（终端可选中复制）；无 tabs 时给可读提示。
- **R4 可访问性**：标题链接有 `title`（完整标题）；id 有 `title`（完整 id + 「点击复制」）。
- **R5 只读**：跳转与复制都不写协作状态；不新增 RPC。

## 验收

- [ ] 点标题 → 只触发跳转（`tabs.open` 一次），**不改变选中**；
- [ ] 点 id → 只触发 `system.copy(完整 id)` 一次 + toast，**不改变选中**；
- [ ] 点行其他区域 → 只改变选中，不跳不复制；
- [ ] 详情头 sid 点击同样复制；
- [ ] TUI `o` → `tabs.focus(sid)` 一次；tabs 关闭时给提示；
- [ ] 回归全绿；工具数仍 22。

## 非目标

- 不做 TUI 剪贴板（终端能力不保证）；
- 不改图/动作区。
