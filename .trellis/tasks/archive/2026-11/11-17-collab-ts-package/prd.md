# collab TS 包化与 GitHub Packages 发布（`@inf-studio/collab`）

> 来源：`11-17-collab-grant` 收口时确认：单文件 `.opencode/plugins/collab.js` 已约 3400 行，
> 且 `.opencode/**` 被仓库 lint/typecheck 忽略，无法复用与分发。
> 目标仓库/包：`inf-studio/collab` → npm scope `@inf-studio` → 包名 `@inf-studio/collab`。

## 背景

- 现状：单文件 JS、零依赖、靠 `.opencode/plugins/` 自动加载与热重载。
- 痛点：无类型、无模块边界、不在 `fmt/typecheck/lint` 门禁内、无法给其它机器/仓库复用。
- 已核实：OpenCode 支持 npm 包插件（`opencode plugin add @scope/pkg@ver`），官方文档含 Publish 章节。

## 目标（两阶段，先 B 后 C）

- **阶段 B（包化）**：`packages/collab` TS 包 + 构建 + 迁入 harness + 接入门禁；仍本地引用，不发布。
- **阶段 C（发布）**：发布到 GitHub Packages，包名 `@inf-studio/collab`，仓库 `inf-studio/collab`。

## Requirements

- **R1 包结构**：`packages/collab`，`exports: { ".": "./dist/index.js" }` + `types`；`@opencode/plugin` 为依赖；构建产物可被 `opencode plugin add` 识别。
- **R2 行为等价**：迁移后现有 harness **274 项全绿**，工具签名、文案、状态机、存储键、`bid` 算法**零变化**。
- **R3 模块化**：至少拆分为 `core`（存储/claim/打分/回执解析）、`tools`（broadcast/handoff/accept/grant/promote/list/wait/inbox/send/reply）、`config`、`index`。
- **R4 门禁**：`packages/collab` 纳入 `pnpm typecheck` / `vp check`；harness 作为 `pnpm test:collab` 保留并可移植进包内测试。
- **R5 类型**：允许 `@opencode/client` 仅作 `import type`（Session.Info、工具 schema 等）；**运行时不得**改为 HTTP 客户端，继续用插件 `ctx`（进程内能力，避免端口/凭据问题）。
- **R6 发布**：GitHub Packages（`https://npm.pkg.github.com`），`publishConfig.registry`、`.npmrc`、CI 发布 workflow（tag `v*` 触发，`packages: write`），语义化版本与 CHANGELOG。
- **R7 兼容/回滚**：双轨期保留 `.opencode/plugins/collab.js`；切换为包后删除本地副本；任一阶段失败可单文件回退。
- **R8 安全开关**：包插件新增 `options`（如 `allowWrite: false` 默认，`protect`/`readonlyAgents` 可配）；不得因拆包放宽既有护栏（受保护会话、只读 agent、默认 queue）。

## Acceptance Criteria

- [ ] `packages/collab` 可构建，`pnpm --filter=@inf-studio/collab build` 成功
- [ ] 迁移后 harness 274/274 全绿，工具行为与单文件版逐字一致（抽查 5 个工具输出）
- [ ] `pnpm typecheck` 覆盖该包且通过；`vp check` 无 error
- [ ] 本地以目录/包两种方式都能被 `opencode` 加载（`/api/plugin` active、无 failed）
- [ ] `npm pack` 产物不含源码外敏感文件；版本 0.1.0 可安装
- [ ] GitHub Packages 发布后 `opencode plugin add @inf-studio/collab@0.1.0` 在干净目录可用
- [ ] README 写清：能力范围、权限（会话读写）、默认只读开关、卸载方法

## 附带修复（本任务一并处理）

- **B1（post-archive 缺陷）**：`collab_grant` 预览在「台账只有 promote 半段」时抛 `TypeError: ... reading 'join'`
  （`collab.js:3669-3673`、`:3690-3691`）。`11-17-collab-grant` 提交时依据的第一份复核报告未发现；
  第二份复核（晚到）复现确认。本任务在包化时一并修复，两版都补 S68 回归。

## 边界

- 不改 `packages/**` 既有包；新包独立。
- 不把插件改成 HTTP 客户端架构。
- 发布前必须完成独立复核；不 push tag 直到人工确认。
- 不把任何凭据写进仓库（token 走 GitHub Actions secrets / 本地 `.npmrc` 600）。
