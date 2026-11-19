# 设计：0.6.1 看板收尾

## 1. 冻结优先级单一真源（R1）

现状（`src/core/board.ts`）复制了：

```ts
// 伪代码：board 里的判定
const frozen = sessionFrozen ?? workspaceFrozen   // 还有过期过滤
```

改为：

```ts
import { freezeFor } from './freeze.ts';   // 纯函数，输入 entries + keys，输出 entry | undefined

// board 只负责整理 keys（sid / ancestors / workspace / bid），判定交给 freeze.ts
const frozen = freezeFor(freezes, { session: sid, ancestors, workspace, bid });
```

- `freezeFor` 已是纯函数（0.6.0 落地），`frozenBy` 里的祖先走查仍留在调用方（board 已从快照拿到祖先链）；
- `buildBoard(snapshot, freezes, now)` 的 `freezes` 必须是**已过滤过期**的列表（`readFreezes(now)` 的输出），
  注释写清，避免再把过期判断塞进 board。

## 2. `boardOrphans` 纯单测（R2）

- `src/index.ts` 的 `__internals` 增 `boardOrphans`；
- `test/board-shape.mjs` 新增 4 例：
  1. 只有孤儿锁（无会话）→ `locks=[…]`、`handoffs=[]`、`queue=[]`；
  2. 交接的 `from/claimBy` 都不在会话列表 → 归 orphan；
  3. 队列项属于某会话（`mineFor`）→ 不归 orphan；
  4. 全部被会话认领 → 三类都空。

变异：把 `boardOrphans` 的 queue 分支删掉 → 例 1/3 必失败。

## 3. 按键分派（R3）

TUI 测试从「直接调 `run()`」改为宿主形状：

```ts
const layer = registeredLayer();            // ctx.keymap.layer 的 factory 结果
const command = layer.commands.find(c => c.bind === 'enter');
expect('非当前面板：enabled=false', command.enabled() === false);
command.run();                              // 宿主在 enabled=false 时不会调用，这里证明即使调用也不改变
expect('当前面板：enabled=true', ...);
command.run();
expect('一次 enter 只展开一次', expandedOnce);
```

说明：真实宿主的键盘分派（keybinding → command）无法在无头环境复现，测试覆盖到「`enabled()` 门控 + `run()`」为止，
真实按键仍记为实机验收项（写进 `implement.md` 的验证清单）。

## 4. 版本与发布

- 三处同步 `0.6.1`；`CHANGELOG` 加 `[0.6.1]`（Fixed/Changed/Tests）；
- 发布后：Linux 安装 + reload + 运行时版本；mac `plugin add` 替换（无需重启即可验证版本，GUI 要重启）。

## 5. 回滚

`git restore -- src/core/board.ts src/index.ts test/board-shape.mjs test/tui-render.mjs`；无行为变更，回滚无副作用。
