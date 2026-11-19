# 执行计划：协作自动感知

## 1. 注入行

- [ ] `src/index.ts` context hook：按 design §1/§2 组装一行（双计数 + 触发条件 + 10min 缓存）
- [ ] `src/config.ts` / `src/constants.ts`：`awareness: "line" | "off"`（默认 `line`）
- [ ] 预算：`maxInject` 满时不追加（不挤掉交接/队列行）

## 2. 承接侧协议头

- [ ] `src/tools/handoff.ts` / `src/tools/broadcast.ts` 的投递模板首行固定两行
- [ ] 跨工作区追加 `[handoff] DONE|BLOCKED <bid>`

## 3. 测试

- [ ] `test/handoff-harness.mjs` 新段：双计数 / 仅跨工作区 / 有未决不提示 / protected / off / 10min 去重 + 列表只查一次 / 宿主抛错降级
- [ ] 承接方首行断言（handoff 与 peer 两种）
- [ ] 变异 2 组（n+m→n、去缓存）
- [ ] 回归：`735 + 12 + 20 + 50 + 49 + 47 + 17` 全绿

## 4. 文档与版本

- [ ] `docs/collab.md` 新增「自动感知」小节 + 配置项；README；skill；CHANGELOG（0.7.0 Unreleased）
- [ ] 版本号不改（0.7.0 由父任务统一）

## 5. 验证

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```
