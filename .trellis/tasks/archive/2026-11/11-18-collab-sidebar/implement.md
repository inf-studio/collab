# 执行计划：协作侧边栏

> 依赖 C1（`collab-lease`）的读取层；建议 C1 归档后再 `task.py start` 本任务。

## 1. 契约

- [ ] `src/rpc.ts`：`Contract` 定义 `collab.state.snapshot`
- [ ] server 侧实现并 `provide`（确认真实 API 形状后写死类型）
- [ ] 快照组装复用 `stateOf()` + broadcast 读取，不新增状态文件

## 2. GUI

- [ ] `src/gui.tsx`：`Plugin.define({ setup })`
- [ ] `Panel { id:"collab", region:"side", width:"narrow", list/render }`
- [ ] `ComposerPill { id:"collab", show }`：当前会话持有/等待
- [ ] 快照轮询 2s（面板可见时），失败显示占位

## 3. 构建

- [ ] `vite.gui.config.ts` + `gui()` preset（入口 `src/gui.tsx`，输出 `dist/gui-experimental.cjs`）
- [ ] `package.json`：`build` 串上 GUI 构建；`exports` 增 `./gui-experimental`；`files` 含 dist
- [ ] devDeps：`vite` / `vite-plugin-solid` / `solid-js`
- [ ] `pnpm build` 产物含 `.cjs`；`npm pack` 5+ 文件

## 4. 验证

- [ ] Desktop 中侧栏出现 `collab` 面板；数据与 `collab_locks` 一致
- [ ] composer pill 显示当前会话持有/等待
- [ ] server 停掉 → 面板显示「不可达」，不崩溃
- [ ] 关闭插件开关后 GUI 消失、server 不受影响
- [ ] `pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs`

## 5. 文档与发布

- [ ] README/docs 增「侧边栏」章节（仅 Desktop；experimental）
- [ ] `0.2.x` 发布；归档后更新父任务

## 回滚

移除 GUI 出口与构建配置；恢复 `package.json` 即可，server 不动。
