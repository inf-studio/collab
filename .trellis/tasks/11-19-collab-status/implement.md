# 执行计划：collab_status

## 1. 实现

- [x] `src/tools/status.ts`：`collabStatusTool(kit)`，`input: { bid?, threadID?, session? }`
- [x] 解析顺序（design §2）；读 `priority`（缺省普通）
- [x] 输出格式化（design §3），含 `canPush` 与「下一步」
- [x] `src/tools/index.ts` 注册（工具数 17 → 18）
- [ ] `src/types.ts`：`priority?` / `urgentAt?` / `urgentReason?` / `urgentBy?`（本任务只读取，写入留给 escalate）
      → **不适用**：`BroadcastRecord` 已有 `[key: string]: any`，读 `priority` 即 `any`；且本任务硬约束不含
      `types.ts`。字段声明随 `collab_escalate` 落地。

## 2. 测试

- [x] `test/handoff-harness.mjs` 新 S 段：pending / done / protected / 无参 / 只读六例（S96，17 条）
- [x] 只读证明：严格假 ctx + 目录快照对比
- [x] `test/readonly-default.mjs`：工具注册表 17 → 18
- [x] 变异：把 `readBroadcast` 之后加一次 `persistRefresh` → 只读断言必失败（已还原，见 research/impl-notes.md §3）

## 3. 文档与版本

- [x] `docs/collab.md` §11.2 工具表 + 新增 §11.14 一节；README 工具表；skill 速查表
- [x] CHANGELOG 0.6.0（本条）；`PLUGIN_VERSION` 保持 0.5.3（由父任务统一到 0.6.0）

## 4. 验证

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
→ 676 + 12 + 42 + 32 + 47 + 7 全绿；skills ok
```

## 5. 回滚

`git restore -- src/tools/status.ts src/tools/index.ts test/ docs/collab.md README.md CHANGELOG.md skills/`
（`src/tools/status.ts` 为新增文件：`rm`）
