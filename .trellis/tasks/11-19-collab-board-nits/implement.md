# 执行计划：0.6.1 看板收尾

> 执行记录见 `research/impl-notes.md`（含变异原始输出与实机待验项）。
> 实施偏差（1 处）：新增 `src/core/freeze-pure.ts` —— GUI bundle 把 Node 内建外置，board 不能经
> `core/freeze.ts` 引入 `node:fs`；纯实现拆出后 `freeze.ts` 再导出，唯一实现仍只有一份。

## 1. 冻结优先级去重

- [x] `src/core/freeze.ts`：`freezeFor` 可被 board 复用（纯函数、签名合适）；改为从 `./freeze-pure.ts` 导入并再导出
- [x] `src/core/board.ts`：删除本地优先级/过期判断，改调 `freezeFor` / `freezeMarker` / `liveFreezeMarker` / `liveFreezes`；`buildBoard` 注释写明 `freezes` 是 `readFreezes(now)` 的输出
- [x] grep 证明：`board.ts` 不再出现 `until`/`scope === 'session'|'workspace'` 副本（`grep -n "until\|scope ===" src/core/board.ts` → 空）

## 2. 孤儿单测

- [x] `src/index.ts`：`__internals` 增 `boardOrphans`
- [x] `test/board-shape.mjs`：+4 例（仅孤儿锁 / 孤儿交接 / 队列被认领 / 全部被认领）+「无 `me` 时同一队列项是孤儿」+ 冻结优先级 1 例（13 → 20 项）
- [x] 变异：删 queue 分支 → 对应断言失败（19/20，原始输出见 impl-notes §4①）

## 3. 按键分派

- [x] `test/tui-render.mjs`：改为「`enabled()` 门控 + `run()`」形状（非当前面板 / 未聚焦不生效；切回后一次 enter 只 toggle 一次、一次 j 只走一行）；44 → 49 项

## 4. 版本与文档

- [x] `package.json` / `src/constants.ts` / `src/gui.tsx` → `0.6.1`
- [x] `CHANGELOG` `[0.6.1]`；README 测试计数同步（20 项看板 / 49 项 TUI）
- [x] `docs/collab.md` §11.11.6 补「看板复用 `freeze-pure` 的判定，不复制」

## 5. 验证

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

- [x] 全量回归：735 · 12 · 20 · 50 · 49 · 47 · 17 全绿；工具数 20；版本三处 `0.6.1`；`check-skill` 通过
- [ ] 实机验收项（未执行，清单见 impl-notes §6）：Desktop 重启后按键真实分派（`enter`/`j`）与看板展开、
  toast 里 `version=0.6.1`、发布后 `plugin add @inf-studio/collab@0.6.1`、冻结过期 2 s 内消失

## 6. 回滚

按 design §5（另加 `git restore -- src/core/freeze-pure.ts` 前先确认该文件是本次新增，回滚即删除它）。
