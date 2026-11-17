# 设计：collab TS 包化与发布

## 1. 包结构

```
packages/collab/
  package.json          # name @info-studio/collab, type module, exports ".", files ["dist"]
  tsdown.config.ts      # 或 vite.config.ts 的 tsdown 任务
  src/
    index.ts            # Plugin.define({ id:"collab", setup })
    config.ts           # 读 ~/.config/opencode/collab.json（惰性 + mtime）
    log.ts
    core/
      storage.ts        # inbox / threads / broadcast / grants 读写（tmp+rename）
      claim.ts          # open(lock,'wx') 原子领取 + 租约
      score.ts          # 匹配分（45/25/15/10/5）
      verdict.ts        # [handoff] 解析 + H1 护栏
      lineage.ts        # protected 血缘
    tools/
      broadcast.ts handoff.ts accept.ts grant.ts promote.ts
      list.ts wait.ts inbox.ts send.ts reply.ts
    hooks/
      context.ts        # 注入去重
      session-start.ts  # 未闭环提醒
  test/
    handoff-harness.mjs # 274 项（从 scripts/collab 迁入）
```

- 不引入运行时第三方依赖；`@opencode/plugin` 为 dependency（宿主提供实现）；
- `@opencode/client` **仅 devDependency + `import type`**；
- 所有存储键、`bid` 算法、文案保持逐字不变（R2）。

## 2. 构建与导出

```jsonc
{
  "name": "@info-studio/collab",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist", "README.md"],
  "dependencies": { "@opencode/plugin": "^2.3.0" },
  "devDependencies": { "@opencode/client": "^2.3.0" },
  "publishConfig": { "registry": "https://npm.pkg.github.com" }
}
```

- 构建用仓库既有 `tsdown`/`vite-plus`，产物 ESM；
- `@opencode/client` 的 `2.3.0` 与宿主版本对齐；升级 OpenCode 时同步升 peer 范围。

## 3. 加载与双轨期

| 阶段 | 加载方式 | 说明 |
| --- | --- | --- |
| B-1 | `.opencode/plugins/collab.js`（现状） | 不动 |
| B-2 | `opencode.json` → `plugins: ["./packages/collab"]` | 目录插件，本地调试；同时停用本地单文件避免重复 id |
| C | `opencode plugin add @info-studio/collab@0.1.0` | 包插件；注意缓存与「未监视依赖需重启」 |

**重复 id 风险**：包插件 `id:"collab"` 与本地文件同名会 `Duplicate plugin ID`。切换时二选一，global shim 逻辑同步调整（shim 需识别包已安装）。

## 4. 发布（GitHub Packages）

```ini
# .npmrc（不入库敏感 token；CI 用 NODE_AUTH_TOKEN）
@info-studio:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

- 仓库：`inf-studio/collab`（新仓；本仓只保留迁移前实现与 harness 快照）；
- CI：tag `v*` → `pnpm build && npm publish`；`permissions: packages: write`；
- 版本：`0.1.0` 起，遵循 semver；`CHANGELOG.md`；
- 安装方需有 `@info-studio` scope 的读权限（私有包）。

## 5. 安全

- `options.allowWrite`（默认 `false`）：为 `false` 时 `collab_promote` 与 `grant` 均拒绝，只保留消息/回执能力；
- `protect` 内置两条 id 仍不可被配置移除；
- 只读 agent 名单仍默认 `explore`/`plan`；
- README 明示「本插件可读会话内容、可发消息、可切 agent」。

## 6. 风险与回滚

| 风险 | 处置 |
| --- | --- |
| 包插件缓存导致改动不即时生效 | 开发期用目录插件；发布版锁版本 |
| 重复插件 id | 切换期严格二选一，`/api/plugin` 断言无 failed |
| scope 权限/CI token 配错 | 先 `npm pack` + 本地安装验证，再推 tag |
| 拆包行为漂移 | 274 项 harness + 5 个工具输出逐字对比 |
| 发布事故 | 撤销版本用 `npm unpublish`（GitHub Packages 支持有限），优先发 patch |
