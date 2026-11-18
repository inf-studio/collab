# 执行计划：按会话服务器取 client（0.5.3）

## 1. `src/gui.tsx`

- [x] `sourceFor(ctx)`：`session.server.client ?? ctx.client`，key = `${server.id}\n${session.id}`
- [x] `createSnapshotStore`：`load()` 每次解析 source；请求前后比对 `source.key`，不同则丢弃回包
- [x] `state.source = { server, session }`，供 pill/toast 使用
- [x] 轮询 key 改为 `sourceFor(ctx)?.key ?? false`；隐藏/可见处理保持 0.5.2
- [x] `probeToast()` 描述追加 `server=<id|this computer>`
- [x] 面板标题行：非本机时追加 `@<server.id>`（本机不显示，避免噪音）
- [x] 仍只调用 `layout.open` / `toast.show`

## 2. 测试（`test/gui-entry.mjs`）

- [x] harness：`sessions.current()` 可切（含 `server`），`client`/`server.client` 用可记录调用的假 client
- [x] design §5 五条断言（远端 client、回退、跨服务器切换、迟到回包丢弃、toast 带 server）
- [x] 变异验证：把 `server.client` 改回 `ctx.client` → 相应断言必失败；去掉 key 比对 → 迟到回包断言必失败
- [x] 既有 `638 + 12 + 35 + 29 + 39` 全绿（实测 GUI 47/47，其余 638/12/35/29）

## 3. 文档与版本

- [x] README「状态视图」+「Desktop 如何让它出现」：必须装在本机、registry 配置、重启 app
- [x] `docs/collab.md` §11.11.x：宿主只加载本机 sidecar（附源码位置描述）、远端数据经 `server.client`
- [x] `skills/collab/SKILL.md` 一句；CHANGELOG 0.5.3
- [x] `package.json` + `src/constants.ts` → `0.5.3`

## 4. 验证

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

## 5. 发布后（主会话，mac 实机）

- [x] mac：配 `@inf-studio` scope registry（用 `gh auth token`）→ `opencode plugin add @inf-studio/collab@0.5.3`
- [x] 重启 Desktop → 标题栏出现 `collab`（GUI 已加载）
- [x] 打开远端会话 → 计数条/面板出数，数值与远端 `collab_locks` 一致
- [x] 失败时按 PRD R5 的排查顺序记录：pill 有无 → toast 有无 `server=` → 面板是否有横幅

## 6. 回滚

`git restore -- src/gui.tsx test/gui-entry.mjs`；本机已装插件可 `opencode plugin remove @inf-studio/collab`。
