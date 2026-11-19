# check-report — 0.6.1 看板收尾（独立复核）

- 复核对象：`/data/project/collab` 未提交改动（11 改 + 1 新文件）；开工时 `git status` 只有这批改动（复核中另一会话提交了 1 个无关 docs commit，见 §6）。
- 复核方式：冷上下文、只读；**未修改实现/测试**，未 `git add`/`commit`/`push`，未重启任何服务。
  所有变异与探针都在 `/tmp/check-probe/**` 的副本上做，仓库工作区保持复核前的 dirty 状态。
- 时间：2026-11-19。

## 结论

**可提交（无阻塞项）。** 7 项必查 6 项通过、1 项通过但附 1 条边界差异 + 1 条覆盖缺口，均为**低风险、非阻塞**：

| # | 项 | 结论 |
| --- | --- | --- |
| 1 | 单一真源（freeze 优先级） | **通过**（附 1 处边界差异，见 §1.3） |
| 2 | 拆 `freeze-pure` 的必要性 | **通过**（已独立复现：接回 `freeze.ts` → 4 个 `require("node:…")`） |
| 3 | `boardOrphans` 纯单测 | **通过**（变异必失败已复现）；**存疑**：PRD R2 的「空输入」无显式断言 |
| 4 | 按键分派（`enabled()` + `run()`） | **通过**（两种变异各自必失败已复现） |
| 5 | 版本三处 + 产物 | **通过** |
| 6 | 全量回归 / 范围 | **通过**（735·12·20·50·49·47·17，工具 20，无新依赖，`tui.tsx` 未改） |
| 7 | 文档一致性 | **通过** |

---

## 1. 单一真源（R1）

### 1.1 只有一处实现

```
$ grep -rn "function freezeFor" src/
src/core/freeze-pure.ts:49:export function freezeFor(entries: FreezeEntry[], keys: FreezeKeys): FrozenHit | undefined {

$ grep -n "until\|scope ===\|scope==" src/core/board.ts
（空，exit=1）
```

- `src/core/freeze-pure.ts:49` 唯一实现；`:60` `freezeMarker`、`:70` `liveFreezes`、`:81` `liveFreezeMarker`（过期判定也只有这一处）。
- `src/core/freeze.ts:49-54`：`import { freezeFor } from './freeze-pure.ts'` + `export { freezeFor, freezeMarker, liveFreezeMarker, liveFreezes }`；
  服务端调用方（`frozenBy`、`snapshot`、`index.ts __internals`）导入路径不变。
- `src/core/board.ts:26` 直接导入纯模块；`:134-145` `freezeOf` 只剩「快照 marker 优先 → `freezeFor` → `freezeMarker`」，没有自己的优先级/过期判断。
- `buildBoard` 形参语义写在 `src/core/board.ts:147-159`（`freezes` = `readFreezes(now)` 输出），`:167` 仍用 `liveFreezes` 兜底，`:229` 把 `live` 传下去。

### 1.2 `freezeFor` 与 0.6.0 **逐字相同**

把 HEAD 的实现体抽出来与新文件对比：

```
$ git show HEAD:src/core/freeze.ts | sed -n '/^export function freezeFor/,/^}/p' > /tmp/check-old.txt
$ sed -n '/^export function freezeFor/,/^}/p' src/core/freeze-pure.ts > /tmp/check-new.txt
$ diff /tmp/check-old.txt /tmp/check-new.txt && echo IDENTICAL-BODY
IDENTICAL-BODY
```

自建探针（`/tmp/check-probe/equiv.mjs`，mulberry32 固定种子；旧实现从 `git show HEAD:src/core/freeze.ts` 抽成模块）：

```
freezeFor: 4000 random cases, 0 divergences
```

覆盖：session 自身 / 祖先链 / `via` / bid / workspace 优先级、空 keys、空 entries、目标不存在、重复 key。

### 1.3 `buildBoard` 派生：唯一差异 = 同一 `(scope,target)` 重复条目

同一探针跑整块派生（旧 board 从 `git show HEAD:src/core/board.ts` 抽成模块，新 board 直接 import `src/core/board.ts`）：

```
freezeFor: 4000 random cases, 0 divergences
buildBoard: 2000 random snapshots, 18 divergences
NOT-EQUIVALENT
```

最小复现（`/tmp/check-probe/first-diff.mjs`，CASE 175，重复的 `scope=session,target=ses_a`）：

```
freezes: [... {"scope":"session","target":"ses_a","reason":"r2","until":1800000060705},
             {"scope":"session","target":"ses_a","reason":"r3","until":1800000164136}]
old: [{"sid":"ses_a",...,"frozen":{"scope":"session","target":"ses_a","until":1800000060705,"reason":"r2"}}]
new: [{"sid":"ses_a",...,"frozen":{"scope":"session","target":"ses_a","until":1800000164136,"reason":"r3"}}]
```

根因：0.6.0 的 board 用 `live.find(...)`（**数组第一个**），`freezeFor` 用 `Map`（**最后一个**）。
把重复条目去重后再对比（`/tmp/check-probe/equiv2.mjs`）：

```
unique (scope,target) entries → freezeFor diffs 0/3000, buildBoard diffs 0/2000
```

即：**除「同一 scope+target 出现多条」外，新旧派生逐字段相同**（含过期条目丢弃、快照 marker 优先、祖先链、archived、badges、spawn）。

对该差异的定性（低风险，非阻塞）：
- 重复条目只有在 `readFreezes` 读到**手写/旧版本文件**时才会出现；`mergeFreezes` 写入前已 `dedupe`（`src/core/freeze.ts:189-193`，注释「later write wins」）。
- 新行为与 `freezeFor`/`dedupe` 一致（取 `at` 更新的一条，`readFreezes` 已按 `at` 升序排），**旧 board 与旧 snapshot 在同一份文件上本来就不一致**。所以这是「对齐单一真源」而非引入回归。
- 建议（不阻塞）：在 CHANGELOG 或 `buildBoard` 注释里加一句「重复 `(scope,target)` 时以 `freezeFor` 的 last-wins 为准（0.6.0 的 board 曾取 first）」，避免下次复核再当成漂移。

## 2. `freeze-pure.ts` 必要性（已独立复现）

```
$ grep -n "^import" src/core/freeze-pure.ts
18:import type { FreezeEntry } from '../types.ts';
19:import type { SnapshotFreeze } from '../rpc.ts';
```

全是 `import type`（编译期擦除，`rpc.ts` 本身也没有运行时依赖链）；文件里 `node:` 只出现在注释。

当前构建产物（`pnpm build` 后）：

```
$ ls -l dist/gui-experimental.cjs   → 30797 bytes
$ grep -c 'require("node:' dist/gui-experimental.cjs   → 0（exit=1）
$ grep -o 'require("[^"]*")' dist/gui-experimental.cjs | sort | uniq -c
      1 require("@opencode/plugin/gui")
      1 require("solid-js")
      1 require("solid-js/store")
      1 require("solid-js/web")
```

复现「拆分不是顺手改」：把 `src/` 拷到 `/tmp/check-probe/repro`（`node_modules` 软链），
`src/core/board.ts` 改回 `from './freeze.ts'`，只跑 `vp build -c vite.gui.config.ts`：

```
dist/gui-experimental.cjs  30993 bytes (with ./freeze.ts)
      1 require("node:crypto")
      1 require("node:fs")
      1 require("node:os")
      1 require("node:path")
      1 require("@opencode/plugin/gui") …
```

结论：拆分**必要**，与 `implement.md` 的实施偏差说明一致。（GUI bundle 是 minified，所以 `grep freezeFor` 为 0 属正常——函数体在 `function u(e,t)`，逐字是 `freezeFor` 的实现。）

## 3. `boardOrphans` 纯单测（R2）

- `src/index.ts:14,289-291`：`__internals` 增 `boardOrphans`；`board-shape.mjs:34` 先断言导出在。
- 5 条孤儿断言：`test/board-shape.mjs:308`（仅孤儿锁）、`:336`（孤儿交接）、`:364`（队列被 `me` 认领 → 不算孤儿）、
  `:376`（同一夹具无 `me` → 是孤儿，让 queue 分支可被变异打掉）、`:405`（全认领 → 三类空）。
  都同时断言「不重叠」：另两类为空 + 会话行内没有该行。另加 `:272` 冻结优先级断言。
- 我独立做的变异（在 `/tmp/check-probe/mut-board/dist/index.js` 副本上，不碰仓库）：

```
① queue: (snapshot?.queue ?? []).filter(...) → queue: []
  ✗ BD boardOrphans: the same queue item with no `me` is not attached to any row — it is an orphan — {"orphans":[]}
  === 19/20 board checks passed

② locks/handoffs 两分支同时置空
  === 18/20 board checks passed
  FAIL: … a lease no session row holds is an orphan lock (and only a lock)
  FAIL: … a hand-off neither started nor claimed by a listed session is an orphan

③ freezeFor 改为 workspace 优先
  ✗ BD freeze precedence comes from freezeFor: session (self or ancestor) beats the workspace freeze — {"parent":{"scope":"workspace",…},"child":{"scope":"workspace",…}}
  === 19/20 board checks passed
```

**存疑（低，非阻塞）**：PRD R2 列的「空输入」没有显式断言——`boardOrphans(undefined, [])` / 空 `snapshot` 从未被调用过
（现有 5 条都带至少一条 locks/handoffs/queue）。实现是 `snapshot?.locks ?? []`（`src/core/board.ts:113-117`），行为显然安全，
但「空输入」这条验收没有可失败的点。建议 +1 行：`boardOrphans(undefined, buildBoard(undefined))` 三类皆空（顺带覆盖 `buildBoard(undefined)` 的孤儿路径）。

## 4. 按键分派（R3）

测试侧模拟宿主（`test/tui-render.mjs:194-214`：读 `layers` 工厂 → 跳过 `enabled()===false` → 跑绑定该键的 command 并计数），
断言：

- `:454` 当前+聚焦 → `enabled()===true`；`:458` `hostPress(tree,'enter')===1`；
- `:541` 未聚焦：`enabled()===false` + `ran===0` + 帧里仍渲染 `▸ ses_a1` 且无 `↳`（真断言，不是空帧）；
- `:562` 切到别人的面板：`ran===0`，切回后仍是折叠态；
- `:570` 切走再切回只剩 1 个 enabled 层；`:581` 一次 `enter` 只 toggle 一次（`ran===1`）；`:591` 一次 `j` 只走一行。
- 门控在实现侧是 `src/tui.tsx:666`（`props.panel.name === PANEL && props.panel.focused === true`）——**`tui.tsx` 本次未改**。

我独立做的两个变异（`/tmp/check-probe/mut-tui`，`dist/tui.js:910`）：

```
④ enabled: () => props.panel.name === PANEL        （去掉聚焦判断）
  ✗ R3 an unfocused panel is skipped by the host… — enabled=true ran=1
  ✗ R3 a background panel is skipped… — ran=0 / …
  ✗ R4 one enter toggles once… — ran=1 / … ▸ ses_a1 …
  ✗ R4 one j moves one row… — … ▾ ses_a1 … ▾ ses_child …
  === 45/49 checks passed

⑤ enabled: () => props.panel.focused === true       （去掉面板名判断）
  ✗ R3 a background panel is skipped… — ran=1
  ✗ R4 one enter toggles once… / one j moves one row…
  === 46/49 checks passed
```

两种门控都各有断言真正失败 → 不是「props 里有个函数」式的空覆盖。稳定性：TUI 套件连跑 4 次均 49/49。

**残留（实现方已自认，非本任务范围）**：真实宿主 keybinding→command 那一跳无头环境无法复现，仍是实机验收项
（`implement.md` §5 未勾选 + `impl-notes.md` §6.1）。复核认可该边界。

## 5. 版本

```
package.json:3         "version": "0.6.1"
src/constants.ts:363   export const PLUGIN_VERSION = '0.6.1';
src/gui.tsx:71         const PLUGIN_VERSION = '0.6.1';
dist/index.js          → 2 处 0.6.1
dist/gui-experimental.cjs → B=`0.6.1`（minified 常量）
```

toast 断言不是硬编码：`test/gui-entry.mjs:444-449` 从 `package.json` 读版本、与 `src/constants.ts` 正则比对，并要求
toast 里出现 `v${pkgVersion}`；实跑输出：

```
✓ R2 package.json, PLUGIN_VERSION and the probe toast carry the same version — {"pkgVersion":"0.6.1","constantsVersion":"0.6.1"}
    toast: 插件 v0.6.1 · id=collab · panel=collab:main · app=2.5.0(desktop) · server=this computer
```

## 6. 回归与范围

```
$ pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs   → exit=0
=== 735/735 checks passed
=== 12/12 checks passed
=== 20/20 board checks passed
=== 50/50 checks passed
=== 49/49 checks passed
=== 47/47 checks passed
=== 17/17 panel checks passed
✓ skills/collab/SKILL.md (collab)
✓ skills/collab-coordination/SKILL.md (collab-coordination)
skills ok

✓ S98 collab_freeze is registered exactly once (19 → 20 tools) — 1 registration(s) / 20 tool(s)
✓ BD __internals exports boardOrphans
```

- 计数与 PRD 完全一致（735+12+20+50+49+47+17），工具数 20。
- 无新依赖：`package.json` diff 只有 version 一行；`pnpm-lock.yaml` 未改。
- `src/tui.tsx`、`src/core/snapshot.ts`、`src/tools/**`、快照字段均未改（`git diff --name-only` 11 个文件，无这三个）。
- 改动范围与 R4 一致（`freeze-pure.ts` 是 `implement.md` 已声明的偏差，且本报告 §2 证明其必要）。
- `dist/` 是 ignored，复核没有改动任何 review 目标文件。
  **并发写者说明**：复核期间另一个会话提交了 `e7a9d1c docs(issues): 转发链 5 个缺口…`（只含 `docs/issues/feat-forwarding-gaps.md`，
  `git show --stat HEAD` 已核对），与本任务 11 个文件无交集；复核对象的 `git diff` 在复核前后一致。

## 7. 文档

- `CHANGELOG.md:6` `## [0.6.1] - 2026-11-19`，含 Changed / Tests / Docs，且明确写了「零 `node:`」「13 → 20 项看板」「44 → 49 项 TUI」「两组变异」。
- `README.md:263` 测试计数改为 `20 项看板派生` / `49 项 TUI 渲染`，与实跑一致。
- `docs/collab.md:1040`（冻结行）改为「按 `core/freeze-pure.ts` 的 `freezeFor`（与 `core/freeze.ts` 同一实现）」；
  `:1050-1052` 新增「单一真源（0.6.1）」段落——与实现一致（board 只整理 keys，判定/过期都在纯模块）。

---

## 风险清单（按严重度）

| 级别 | 项 | 处置建议 |
| --- | --- | --- |
| 低 | 重复 `(scope,target)` 冻结条目：0.6.0 board 取 first，0.6.1 取 last（= `freezeFor`/`dedupe` 语义） | 记一句在 CHANGELOG/注释；可选加一条用重复条目的断言固化语义 |
| 低 | PRD R2「空输入」无显式断言（`boardOrphans(undefined, …)` 未被调用） | +1 行断言（顺带覆盖 `buildBoard(undefined)` 的孤儿路径） |
| 低 | 真实宿主 keybinding→command 一跳、Desktop 重启后 GUI 版本、发布安装、冻结过期 2 s 消失 | 保持 `implement.md` §5 未勾选，实机验收后再勾 |
| — | 未发现：`node:` 泄漏、范围越界、吞错、测试「声称跑了其实没跑」（各套件均实跑并做过变异） | — |

> 上述两条「低」都不影响提交：一条是语义对齐（新行为更正确），一条是覆盖补强。若要求严格「不改行为」，第一条需要在文档里显式承认；
> 代码层面不需要回滚（回滚会把 board 再变回与 `freezeFor` 不一致的旧行为）。

## 复核中执行的命令（原始，全部在仓库根或 `/tmp/check-probe`）

```
git status --short / git diff --stat / git diff
grep -rn "function freezeFor" src/ ; grep -n "until\|scope ===\|scope==" src/core/board.ts
git show HEAD:src/core/freeze.ts | sed -n '/^export function freezeFor/,/^}/p' | diff - <(sed -n …)
node /tmp/check-probe/equiv.mjs
node /tmp/check-probe/equiv2.mjs
node /tmp/check-probe/first-diff.mjs
cd /tmp/check-probe/repro && ./node_modules/.bin/vp build -c vite.gui.config.ts   # board → ./freeze.ts
cd /tmp/check-probe/mut-board && node test/board-shape.mjs                         # queue/locks/handoffs/freezeFor 变异
cd /tmp/check-probe/mut-tui  && node --conditions=browser test/tui-render.mjs      # enabled() 变异 ×2
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```
