# 打包依赖修正：`@opencode/plugin` 应为 type-only（0.1.5）

> 来源：0.1.4 升级事故。宿主 CLI 2.3.1 安装 `@inf-studio/collab@0.1.4` 失败。

## 问题

```text
failed to load plugin target=@inf-studio/collab@0.1.4
cause=NpmInstallFailedError: No matching version found for @opencode/util@2.3.2
```

`package.json` 的 `dependencies` 声明了 `@opencode/plugin: ^2.3.0`；宿主安装时解析到最新 `2.3.x`，
其自身依赖 `@opencode/util@2.3.2` 在 npm 上不存在 → 整个插件安装失败 → 本会话 `collab_*` 工具消失。

而源码只用到 `import type { Plugin } from '@opencode/plugin'`（`src/index.ts:1`），**运行时不需要它**
（宿主注入 `ctx`）。

## Requirements

- **R1** 把 `@opencode/plugin` 从 `dependencies` 移到 `devDependencies`（保留类型检查能力）；
  发布产物不得在安装期解析 `@opencode/*` 依赖。
- **R2** 版本 bump `0.1.5`，CHANGELOG 写明「0.1.4 在 CLI 2.3.x 上不可安装，请直接使用 0.1.5」。
- **R3** 验证：`npm pack` 后的 `package.json` 无 `@opencode/plugin` 运行依赖；
  用宿主同款安装路径验证（`opencode plugin add @inf-studio/collab@0.1.5`）成功且 `collab_*` 可用。
- **R4** 回归：build/typecheck/test/check-skill 全绿；`pnpm typecheck` 仍能解析 type import（devDep 保留）。

## Acceptance Criteria

- [ ] `npm view @inf-studio/collab@0.1.5 dependencies` 不含 `@opencode/*`
- [ ] `opencode plugin add @inf-studio/collab@0.1.5` 成功，`/api/plugin` 为 active
- [ ] 本会话工具恢复（含 `collab_report`）
- [ ] 文档「版本与重载」补充：升级失败时的回滚方法（改回 0.1.3 + `opencode reload`）

## 边界

- 不改业务逻辑；不动 `@opencode/plugin` 的类型用法。
- 不删除 0.1.4（GitHub Packages 版本不可变；用 0.1.5 覆盖使用）。
