# C2 协作侧边栏（GUI `Panel` + `ComposerPill`）

> 父任务：`11-18-collab-coordination`。依赖 C1 的读取接口；GUI API 标注 experimental。

## 目标

在 OpenCode Desktop 侧栏看到「谁持有资源 / 谁在等待 / 哪些 handoff 未闭环」，不用再 `ps` 或翻 `collab_list`。

## Requirements

- **R1 出口**：包内新增 `./gui-experimental`（Solid + vite 构建为单 `.cjs`）；server 部分通过 RPC 暴露只读状态。
- **R2 侧栏面板**：`Panel { region:"side", id:"collab" }`，按工作区分组列出：
  会话（title/agent/busy）、其持有资源（模式/剩余 TTL）、等待队列、未闭环 handoff（bid/state/age）。
- **R3 composer pill**：当前会话持有/等待一览（如「锁 2 · 等待 1」），颜色区分（success/warning/danger）。
- **R4 实时性**：数据来自 server 部分（`ctx.client.rpc`），面板可见时轮询或事件驱动；不可用时显示「server 不可达」而非空白。
- **R5 只读**：面板不提供加锁/释放按钮（避免误操作）；操作仍走工具/skill。
- **R6 兼容**：GUI 加载失败不影响 server 插件；`opencode plugin list` 中可见。

## Acceptance Criteria

- [ ] Desktop 中侧栏出现 `collab` 面板，数据与 `collab_locks`/`collab_list` 一致
- [ ] composer pill 显示当前会话持有与等待
- [ ] server 不可达/插件禁用时面板给出明确提示，不崩溃
- [ ] `pnpm build` 产出 `dist/gui-experimental.cjs`；`files` 含 dist
- [ ] 不需要时可在 Settings → Extensions → Plugins 关闭

## 边界

- 不引入写操作；不改 server 语义。
- 接受 experimental API 变动风险（锁定 opencode 版本区间）。
