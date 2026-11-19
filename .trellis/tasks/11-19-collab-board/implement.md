# 执行计划：协作看板三层展开

> 依赖：必须在 `escalate`（priority）与 `freeze`（frozen）之后实现。

## 1. 派生层

- [ ] `src/core/board.ts`：`buildBoard(snapshot, freezes, now)`（design §1）
- [ ] 单测：spawn 关系、archived 分流、urgent/frozen、老快照兼容

## 2. 快照字段

- [ ] `src/rpc.ts`：`SnapshotSession.archived?`、`SnapshotHandoff.kind/spawned/priority?`（全部可选 + schema）
- [ ] `src/core/snapshot.ts`：从 host `time.archived` 与记录 `claim.kind/claim.by/priority` 填充

## 3. GUI

- [ ] `PanelView`/`GroupView` 改渲染 `buildBoard`
- [ ] 会话行徽标 + 展开（本地 signal）、`已归档 N` 折叠段
- [ ] `.collab-badge` / `.collab-spawn` 样式；展开时 2s 轮询不重置

## 4. TUI

- [ ] `StatusPanel` 改树（缩进 2 空格、默认折叠、`已归档` 末段）
- [ ] `onMouseDown` + keymap（`enter`/`space` 切换、`j/k` 移动）
- [ ] 侧栏保持四数一行

## 5. 测试

- [ ] `test/board-shape.mjs`（新，纯派生）
- [ ] `test/gui-panel.mjs` 扩：默认折叠/展开/已归档/`↳`
- [ ] `test/tui-render.mjs` 扩：`↳` 行、徽标、`enter` 展开
- [ ] 变异 2 组（spawn 关系、归档默认）

## 6. 文档

- [ ] `docs/collab.md` §11.11（三层结构 + 已归档折叠）、README 视图段、skill 一句、CHANGELOG

## 7. 验证

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

## 8. 回滚

按 design §6。
