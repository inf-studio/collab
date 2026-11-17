# 执行计划：collab TS 包化与发布

> 前置：`11-17-collab-grant` 必须先归档（同一文件 `collab.js` 不能两个任务同时改）。

## 阶段 B：包化（不发布）

- [ ] B1 建 `packages/collab`：`package.json` / tsconfig / tsdown 配置 / `.npmignore` 或 `files`
- [ ] B2 抽 `core/`：storage、claim、score、verdict、lineage（保持键名与算法逐字不变）
- [ ] B3 抽 `tools/`：broadcast / handoff / accept / grant / promote / list / wait / inbox / send / reply
- [ ] B4 抽 `hooks/`：context 注入、SessionStart 提醒
- [ ] B5 `index.ts` 用 `Plugin.define({ id:"collab", setup })` 组装，保持 `ctx` 用法不变
- [ ] B6 迁入 harness 到 `packages/collab/test/handoff-harness.mjs`，`pnpm test:collab` 指过去
- [ ] B7 门禁：`pnpm --filter @inf-studio/collab build/typecheck/lint`；根 `typecheck` 纳入
- [ ] B8 双轨切换：`opencode.json` 加 `plugins: ["./packages/collab"]`，停用 `.opencode/plugins/collab.js`；`/api/plugin` 无 failed、无 duplicate id
- [ ] B9 行为对比：274 项全绿 + 5 个工具输出逐字对比

## 阶段 C：发布

- [ ] C1 建 `inf-studio/collab` 仓（由 owner 操作）；同步包目录与 CI
- [ ] C2 `.github/workflows/publish.yml`：tag `v*` → build → `npm publish`（`NODE_AUTH_TOKEN`、`packages: write`）
- [ ] C3 `npm pack` 检查内容（只含 dist/README/package.json）
- [ ] C4 本地干净目录验证安装：`opencode plugin add @inf-studio/collab@0.1.0`
- [ ] C5 README：能力、权限、`allowWrite` 默认、卸载、版本兼容矩阵
- [ ] C6 在 `muke-pos-app` 用包插件替换本地单文件，观察一轮真实交接（review 类）

## 验证命令

```
pnpm --filter @inf-studio/collab build
pnpm --filter @inf-studio/collab typecheck
pnpm test:collab
opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"
npm pack --dry-run
```

## 回滚

- B 阶段：删 `packages/collab`，恢复 `plugins: []`，本地单文件仍在；
- C 阶段：`opencode plugin remove @inf-studio/collab`，指回本地目录；
- 任一阶段不改动既有存储格式（`collab/*` 键不变），数据无需迁移。
