# 实现记录：collab TS 包化（阶段 B）

任务：`.trellis/tasks/11-17-collab-ts-package`（续跑：上一个子代理因余额中断）
状态：**阶段 B 完成（包化 + 门禁 + 测试 + 文档），未发布、未切换加载方式**。
行为基准：`.opencode/plugins/collab.js`（未改动加载方式，未删除；本会话未编辑该文件）。

## 1. 完成度对照（`implement.md` 阶段 B）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| B1 `packages/collab` 脚手架 | ✅ | `package.json` / `tsconfig.json` / `vite.config.ts`（`vp pack` → `dist/index.js` + `dist/index.d.ts`）；`files` 只含 `dist/README/CHANGELOG` |
| B2 `core/` | ✅ | `storage` / `claim` / `score` / `verdict` / `lineage` / `grants` / `chain` / `messages`（脚手架阶段已迁，本会话补 `persistRefresh` 重载、`extractVerdict` 类型） |
| B3 `tools/` | ✅（本次补齐 7 个） | 本会话新增 `handoff` / `accept` / `send` / `reply` / `inbox` / `wait` / `grant` / `promote` + `tools/index.ts`；`list` / `broadcast` / `shared` 为脚手架已有 |
| B4 `hooks/` | ✅（本次） | `src/hooks/context.ts`：`injectInbox`（未读注入 + 去重/游标）+ `injectChain`（交接链路提醒），合并为单个 `context` hook；单文件版没有额外 SessionStart hook（`reminded` 由 `chain.injectionFor` 承担），因此未新增 `session-start.ts` |
| B5 `index.ts` 装配 | ✅（本次） | `Plugin.Plugin = { id:"collab", setup }`；tools transform → 事件流（`session.inbox.enqueued`）→ `context` hook → 日志 → cleanup；`__internals` 导出（harness 用） |
| B6 harness 迁入 | ✅（本次） | `test/handoff-harness.mjs`（指向 `dist/`，**279 项**）+ `test/readonly-default.mjs`（**12 项**）；`package.json` `test` = build → 两个测试 |
| B7 门禁 | ✅（本次） | 根 `typecheck:all` 加 `--filter=@info-studio/*`；`vp check` 覆盖 `packages/collab`（src+test 全绿） |
| B8 双轨切换 | ⏸ 未做（按任务口径） | 本任务明确「不切换加载方式、不删单文件」。切换步骤已写进 `docs/collab.md` §13.3（含 `Duplicate plugin ID: collab` 风险与回滚） |
| B9 行为对比 | ✅ | 274 项单文件用例在包内全绿 + 五个工具输出逐字一致（见 §4） |
| 附 B1 修复 | ✅ | 单文件版已有修复（`collab.js:3652-3663`）；包内 `grant.ts` 用 `grantHalfOf()` 复刻；新增 S68（5 项断言） |
| 阶段 C（发布/CI publish workflow） | ⏸ 不在本次范围 | `publishConfig.registry` 已写；`.npmrc`/`publish.yml`/建仓留给阶段 C（需 owner 操作 + 凭据） |

## 2. `file:line` 映射（单文件 → 包）

单文件基准行号来自 `.opencode/plugins/collab.js`（4152 行）。

### 2.1 入口与 hook

| 单文件 | 包 |
| --- | --- |
| `export default { id:"collab", setup }` `:3898-4140` | `src/index.ts:23-131` |
| tools transform `:3911-3915` | `src/index.ts:57-60` |
| 事件订阅循环 `:3917-3975` | `src/index.ts:63-114` |
| `context` hook 注册 `:3983-3997` | `src/index.ts:117` + `src/hooks/context.ts:23-158` |
| `injectInbox` `:3999-4113` | `src/hooks/context.ts:31-139` |
| `injectChain` `:4115-4121` | `src/hooks/context.ts:141-150` |
| setup 日志 / cleanup `:4123-4140` | `src/index.ts:119-134`（日志多一个 `allowWrite=`，见 §5） |
| `__internals` `:4142-4152` | `src/index.ts:136-143` |

### 2.2 工具

| 工具 | 单文件 | 包 |
| --- | --- | --- |
| `collab_list` | `:2632-2742` | `src/tools/list.ts:16` |
| `collab_broadcast` | `:2743-3034` | `src/tools/broadcast.ts:25` |
| `collab_handoff` | `:3035-3196` | `src/tools/handoff.ts:22` |
| `collab_accept` | `:3197-3355` | `src/tools/accept.ts:19` |
| `collab_send` | `:3356-3445` | `src/tools/send.ts:17` |
| `collab_reply` | `:3446-3501` | `src/tools/reply.ts:17` |
| `collab_inbox` | `:3502-3552` | `src/tools/inbox.ts:19` |
| `collab_wait` | `:3553-3603` | `src/tools/wait.ts:17` |
| `collab_grant` | `:3604-3765`（B1 修复 `:3652-3663`） | `src/tools/grant.ts:19`（`grantHalfOf` 在 `src/core/grants.ts:524-530`） |
| `collab_promote` | `:3766-3896` | `src/tools/promote.ts:19` |
| 共享 kit（resolveTarget/dispatch/waitForReply/deliverAsk） | `:2380-2630` | `src/tools/shared.ts:84-357` |
| 注册顺序 | `:2632,2743,3035,3197,3356,3446,3502,3553,3604,3766` | `src/tools/index.ts:22-36`（同序） |

### 2.3 core / 配置 / 工具函数

| 单文件 | 包 |
| --- | --- |
| 常量 `:92-231` | `src/constants.ts` |
| helpers `:235-309` | `src/util.ts` / `src/log.ts` |
| ids + signal `:313-400` | `src/ids.ts` |
| `loadConfig` / `createConfigReader` `:404-462` | `src/config.ts` |
| `createLineage` `:477-545` | `src/core/lineage.ts` |
| broadcast 存储 `:549-988` | `src/core/claim.ts` |
| 提案解析 + 打分 `:990-1508` | `src/core/score.ts` |
| inbox/thread 存储 `:1513-1639` | `src/core/storage.ts` |
| `extractInbound` `:1643-1674` | `src/core/storage.ts:176-...` |
| `createHandoffChain` `:1685-2315` | `src/core/chain.ts` |
| 权限/agent 台账 `:672-988` + `:2033-2315` | `src/core/grants.ts` |
| 回执/判决 `:1175-1387` | `src/core/verdict.ts` |
| 注入去重工具 `:2324-2378` | `src/core/messages.ts` |

## 3. 构建 / 类型 / 测试原始输出

```
$ pnpm --filter=@info-studio/collab build
ℹ dist/index.js    153.28 kB │ gzip: 47.37 kB
ℹ dist/index.d.ts    2.72 kB │ gzip:  1.25 kB
✔ Build complete in 2777ms

$ pnpm --filter=@info-studio/collab typecheck
$ tsc --noEmit          # 无输出 = 0 error

$ pnpm --filter=@info-studio/collab test
=== 279/279 checks passed      # 274 项单文件用例 + S68（5 项）
=== 12/12 checks passed        # readonly-default.mjs（R8）
=== 16/16 parity checks passed # 双轨对比（10 工具契约 + 5 预览输出）

$ pnpm test:collab            # 单文件版未变
=== 274/274 checks passed

$ node --check .opencode/plugins/collab.js
single-file entry parses OK

$ npx vp check packages/collab/src packages/collab/test
pass: All 30 files are correctly formatted
pass: Found no warnings or lint errors in 30 files

$ npm pack --dry-run           # 产物只含 dist + README + CHANGELOG + package.json
npm notice 2.2kB CHANGELOG.md
npm notice 7.4kB README.md
npm notice 2.7kB dist/index.d.ts
npm notice 153.3kB dist/index.js
npm notice 1.2kB package.json
npm notice total files: 5
```

根 `npx vp check`（全仓，只读）在我收尾时仍报 **7 个既有格式漂移**，全部是本任务**未触碰**的文件：
`docs/design/{element-map,impl-spec,parity-diff,token-reconciliation}.md`、`docs/requirements.md`、
`docs/issues/bugs-dev-tls-chain-verified.md`（其它会话的未跟踪提案）、`scripts/collab/handoff-harness.mjs`。
也就是说 `vp check` 在 main 上本来就是红的（本次之前 `docs/collab.md` 也在名单里）；本任务把**自己改过的**
`docs/collab.md`、`docs/development.md` 一并格式化了（`docs/development.md` 仅表格补白，36 行内），
`packages/collab/**`、`package.json`、guide 均 0 漂移、0 lint error。剩下的 7 个不在允许改动范围内，
留给对应 owner。

## 4. 五个工具逐字对比（单文件 vs 包）

对比脚本已固化进包内（双轨期回归门）：`packages/collab/scripts/parity-single-file.mjs`
（= `pnpm --filter=@info-studio/collab parity`，已并入 `test`）。它用同一套假宿主、同一
`COLLAB_CONFIG`/`COLLAB_BROADCAST_DIR`/`COLLAB_GRANT_DIR`，只跑**预览**路径（不写任何存储），
归一化动态值（`t_…` / `b_…` / `c_…` / 时钟 / 耗时）后比较：

1. 十个工具的**注册顺序 + description + JSON schema + execute 形态**（契约层）；
2. 五个**预览**输出逐字一致（`collab_list` / `collab_broadcast` / `collab_handoff` / `collab_grant` / `collab_promote`）。

实际输出：

```
  ✓ tool set + registration order are identical — collab_list,collab_broadcast,collab_handoff,collab_accept,collab_send,collab_reply,collab_inbox,collab_wait,collab_grant,collab_promote
  ✓ collab_list / collab_broadcast / collab_handoff / collab_accept / collab_send /
    collab_reply / collab_inbox / collab_wait / collab_grant / collab_promote:
    description + input schema + execute arity   （10/10）
  ✓ collab_list: output identical — 269 chars
  ✓ collab_broadcast: output identical — 702 chars
  ✓ collab_handoff: output identical — 180 chars
  ✓ collab_grant: output identical — 416 chars
  ✓ collab_promote: output identical — 369 chars

=== 16/16 parity checks passed
```

单文件版退役（阶段 C）后脚本自动跳过（exit 0）。

### 4.1 旧的一次性对比输出（同一结论）

脚本：`/tmp/opencode/collab-parity.mjs`（同一套假宿主、同一 `COLLAB_CONFIG`/`COLLAB_BROADCAST_DIR`/
`COLLAB_GRANT_DIR`，只跑**预览**路径，因此不写任何存储）。仅归一化动态值（`t_…` / `b_…` / `c_…` /
时钟 / 耗时）。

```
✓ collab_list: identical (269 chars)
✓ collab_broadcast: identical (702 chars)
✓ collab_handoff: identical (180 chars)
✓ collab_grant: identical (416 chars)
✓ collab_promote: identical (369 chars)

broadcast dir created by previews: false
PASS: all five outputs identical
```

差异：**0**（未归一化前唯一的差异是随机 `threadID` 与逐秒时间，属预期动态值）。

## 5. 与单文件版的**有意**差异（全部已写进 README/CHANGELOG/docs）

1. `allowWrite`（R8，默认 `false`）：`collab_grant` / `collab_promote`（含 `revoke`/`revert`）在默认下
   返回「未授予权限（disabled）: allowWrite=false…」/「未切换 agent（disabled）: …」，不写 PATCH、不切 agent。
   消息类工具（send/reply/handoff/broadcast/accept/list/inbox/wait）不受影响。单文件版无此开关
   （等价 `allowWrite:true`）。强制点落在 `src/core/grants.ts:294/344/422/468`
   （`grantForSession` / `revokeForSession` / `promoteSession` / `revertSessionAgent`，核心层，工具层无法绕过）。
2. setup 日志多一项 `allowWrite=<bool>`（`src/index.ts:123`）。只影响服务端 stderr，不是工具输出。
3. `@opencode/client` **未**作为 devDependency（与 design.md §1 的措辞有偏差）：包内没有任何
   `import type` 用到它，留着会被 `node scripts/check-deps.mjs` 报「未使用」；类型契约按用到的字段
   本地声明（`src/types.ts`），入口用 `@opencode/plugin` 的 `Plugin.Plugin` 做一次签名对齐（R5 仍满足：
   没有运行时 HTTP 客户端、没有新增运行时依赖）。
4. `test/` 两个文件在 monorepo 外（独立仓库）会自动跳过 S38/S43 的**文档**断言（`hasRepoDocs`），
   其余用例照跑；`copyFileSync` 换成直接 import `dist/index.js`。

## 6. 未验证项 / 阻塞

| 项 | 原因 |
| --- | --- |
| `/api/plugin` active（目录插件 / 包插件） | 任务口径「不切换加载方式」；切换会与单文件版 `id` 冲突（`Duplicate plugin ID: collab`），需 owner 在场时做一次真实交接观察（implement.md B8/C6） |
| GitHub Packages 发布 / `opencode plugin add @info-studio/collab@0.1.0` | 阶段 C：需新建 `inf-studio/collab` 仓、CI `packages: write`、token；本次不发布 |
| `.github/workflows/collab.yml` 加包 job | 该 workflow 的设计前提是**不跑 `pnpm install`**（本仓 CI 全新 checkout 因 `../std-ui` 兄弟仓缺失装不上依赖）；包 build/typecheck/test 需要依赖，故只保留本地/可安装依赖的 CI 跑法（文档已注明） |
| 根 `pnpm typecheck` 全量跑 | 会连带 `@std-x/*` / `@effects/*` 等，耗时且可能受其它会话在改的文件影响；已用等效的 `pnpm --filter=@info-studio/* typecheck` 验证新包在 filter 内且通过 |
| 真实宿主上的 `ctx.session.update` / `switchAgent` | 假宿主覆盖了成功/403 两条路径（S54–S67）；真实宿主行为仍以单文件版的历史实测为准（同一代码路径） |

## 7. 本会话改动文件

新增（`packages/collab/**`，均为未跟踪）：
`src/index.ts`、`src/tools/{index,handoff,accept,send,reply,inbox,wait,grant,promote}.ts`、
`src/hooks/context.ts`、`test/{handoff-harness.mjs,readonly-default.mjs}`、
`scripts/parity-single-file.mjs`、`README.md`、`CHANGELOG.md`。
删除：`src/helper.ts`、`src/probe-types.ts`（脚手架探针）。
微调（脚手架既有文件）：`src/core/claim.ts`（`persistRefresh` 重载 + `before` 兜底）、`src/core/chain.ts`
（`extractVerdict` 收窄字面量类型、去掉隐式 any）、`src/tools/broadcast.ts`（`create` 返回收窄）、
`src/ids.ts`（去掉多余 spread，lint）、`src/types.ts`（注释与 harness 入口一致）。

`packages/collab` 之外：`package.json`（`typecheck:all` 加 `@info-studio/*`）、
`docs/collab.md`（§11.1 指针 + 新 §13）、`docs/development.md`（命令表/门禁说明）、
`.trellis/spec/guides/cross-workspace-collab-guide.md`（§11 回归门补充包形态）、本记录。
`pnpm-lock.yaml` 是本机 gitignored 文件，仅本地同步（未跟踪，不影响提交）。
