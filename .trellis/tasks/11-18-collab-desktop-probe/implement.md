# 执行计划：R-7 + Desktop 探针（0.5.2）

## 1. R-7（`src/gui.tsx`）

- [x] `createSnapshotStore`：抽出 `currentSessionID()`；`load()` 记 `wanted`；`finally` 里会话变了就补排一次
- [x] 补排条件：`!disposed && !pageHidden() && currentSessionID() !== wanted`；仍保留 `inFlight`
- [x] 确认不会无限补排（新请求重新记 `wanted`）

## 2. 探针（`src/gui.tsx`）

- [x] `probeToast()` 单一实现：`title=ctx.t('probe.title')`，description 含 `v${PLUGIN_VERSION}`、`id`、
      `panel key`、`ctx.app.version`、`ctx.app.platform`
- [x] `TitlebarItem { id:'status', label: data? `collab ${n}` : 'collab', icon:'lock', run }`
- [x] `Command.run` 无会话时调用同一个 `probeToast()`
- [x] i18n（en/zh）：`probe.title`、`probe.description` 相关键、`titlebar.title`

## 3. 测试（`test/gui-entry.mjs`）

- [x] harness 补 `toast.show`、`app`、可选 `delayMs`（可 await 控制回包）
- [x] 6 条新断言（见 design §4 表）
- [x] 变异验证：去掉补排 → R-7 断言失败；去掉 toast 分支 → 探针断言失败

## 4. 回归

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

- [x] 既有 `638 + 12 + 35 + 29 + 21` 全绿（GUI 入口数会增加）

## 5. 文档与版本

- [x] README / `docs/collab.md` §11.11「Desktop 排查」四步（含「远端是否加载 GUI 尚未确认」）
- [x] `skills/collab/SKILL.md` 一句；CHANGELOG 0.5.2
- [x] `package.json` + `PLUGIN_VERSION` → `0.5.2`

## 6. 复核与发布（主会话）

- [ ] 独立复核（重点：补排不会打爆、只读、探针可见性不回归）
- [ ] tag `v0.5.2` → CI → 安装 → reload → 运行时版本

## 7. 回滚

`git restore -- src/gui.tsx test/gui-entry.mjs`；探针只读，无运行时开关需要。
