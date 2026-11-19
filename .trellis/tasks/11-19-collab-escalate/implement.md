# 执行计划：collab_escalate

## 1. 实现

- [ ] `src/types.ts`：`BroadcastRecord.priority/urgentAt/urgentReason/urgentBy`；`OwnerQueueItem.priority`
- [ ] `src/tools/escalate.ts`：
      - 解析目标（bid / threadID / session）
      - protected → `owner-queue` 写入 `priority:'urgent'`
      - 非 protected → `deliverPrompt`（`delivery` 默认 steer，只读 agent 降级）
      - 记录 urgent 字段（read-merge-write，不动 state/receipt）
      - 幂等窗口 5min（同 bid + reason）
- [ ] `src/tools/index.ts` 注册（18 → 19）
- [ ] 展示：`collab_list` 行尾 `[urgent]`；`snapshot.handoffs[].priority`；TUI/GUI 只读标（不新增交互）

## 2. 测试（`test/handoff-harness.mjs` 新段）

- [ ] 普通目标 steer / queue 各一例（断言传给 `session.prompt` 的 `delivery`）
- [ ] 只读 agent 降级（`forced`）
- [ ] protected：0 次 prompt + 队列项 `priority:'urgent'` + `canPush:false`
- [ ] 幂等：5 分钟内二次调用 0 次 prompt
- [ ] 状态不变：`state`/`claim`/`receipt` 前后一致
- [ ] `test/readonly-default.mjs` 18 → 19
- [ ] 变异 2 组（只读降级、protected 分支）

## 3. 文档

- [ ] `docs/collab.md` §11.2 工具表、§11.14（与 status/freeze 合并写）
- [ ] README 工具表、skill 速查表、CHANGELOG

## 4. 验证

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

## 5. 回滚

`git restore -- src/tools/escalate.ts src/tools/index.ts src/types.ts test/`
