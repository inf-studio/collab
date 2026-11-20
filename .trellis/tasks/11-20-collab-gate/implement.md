# 执行计划：协作闸门（0.9.2，表态版）

> 口径变更见 `prd.md` 顶部：关键词/别名匹配整体删除，改为「模型表态 + 插件记录」；溢出不拦只提醒。

## 顺序清单

- [x] 1. `src/core/gate.ts`：`evaluate()`（`scopeCheck` 解析 / override 校验 / 溢出提醒）+ `demote`
- [x] 2. `src/core/audit.ts`：每次表态 append 一行（`inScope` / `verifiedBy` / `approvedBy?`），写失败不阻断
- [x] 3. `src/tools/accept.ts`：新入参 `scopeCheck`；`refresh → evaluate → persistRefresh → 分支` 的顺序；
      拒绝零写入；预览只提示
- [x] 4. `src/tools/broadcast.ts` / `handoff.ts`：只取 `reminder`（永不拒绝、永不要求表态）
- [x] 5. `src/config.ts` / `src/constants.ts`：`gate` 三档（默认 `enforce`）；删除 `scopeAliases` / `DEFAULT_SCOPE_ALIASES`
- [x] 6. 删除匹配器与 `[scope]`：`src/core/gate.ts`、`src/core/contract.ts`（`matchScope` / `scopeLines`）、
      `src/hooks/context.ts`、`src/core/mission-resolve.ts`（`latestRequestText`）、`src/index.ts`（internals）
- [x] 7. `test/gate.mjs` 重写（62 项）；`test/contract-inject.mjs` 删 `[scope]` 用例、改截断用例
- [x] 8. 文档：任务 `prd/design/implement`、`docs/collab.md` §11.22/§11.23、README、skill、CHANGELOG、spec §2.13
- [x] 9. 门禁 + 变异

## 门禁

```bash
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
grep -rn "scopeAliases\|DEFAULT_SCOPE_ALIASES\|matchScope" src/   # 必须为空
```

报数：工具数 26（本版不增）、测试计数（1413）、误伤用例数（0，因为不再有匹配）、audit 行数（gate 套件 5）。

## 复核门

- 独立子代理跑全量门禁并贴原始输出；
- 变异（强制）：`gate.ts` 把「缺 `scopeCheck` 拒绝」改成放行 → 「缺 scopeCheck」组必红；
- 主会话抽检：构造 `outOfScope=[ws集群实施]` 的契约，`collab_accept` 不带 `scopeCheck` 看拒绝原文，
  再带 `scopeCheck:{inScope:true}` 看 audit 行。

## 回滚

见 `design.md` §10；紧急情况把 `gate` 配成 `off` 即可即时停用（不拒绝、不提醒、不写 audit）。
