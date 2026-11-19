# 执行计划：collab_freeze

## 1. 核心

- [ ] `src/core/freeze.ts`：`readFreezes(now)`、`mergeFreezes(mutate)`、`frozenBy(keys)`、`freezeDenyText(entry)`
- [ ] `src/types.ts`：`FreezeEntry` / `FreezeFile` / `OwnerQueueItem.priority`
- [ ] `src/tools/freeze.ts`：`collab_freeze { scope, target?, reason, until?, freeze?, confirm }`
      - 默认 30min；`until` 支持 "30m" / ISO；`freeze:false` 解冻
      - 送达：非 protected → queue 通知 + 回执；protected → urgent 队列项
- [ ] `src/tools/index.ts` 注册（19 → 20）

## 2. 强制点接入

- [ ] `collab_handoff`：目标 / 祖先 / 目标工作区冻结 → 拒绝（在 `confirm` 检查之后、写记录之前）
- [ ] `collab_broadcast`：workspace 冻结 → 拒绝（在 spawn 锁之前）
- [ ] `collab_accept`：bid 或本会话冻结 → 拒绝
- [ ] `collab_escalate`：冻结优先 → 拒绝并提示解冻命令
- [ ] `collab_list` / `snapshot.ts`：`[frozen]` 标记 + `freeze:{until,reason}` 字段
- [ ] `context` 注入：被冻会话一次提示（写 `notifiedAt`）

## 3. 测试

- [ ] 冻结/解冻/到期/血缘/并发 六组
- [ ] protected 路径（0 prompt + urgent 队列）
- [ ] 拒绝文案含解冻命令
- [ ] `test/readonly-default.mjs` 19 → 20；`snapshot-shape.mjs` 增 `freeze` 字段断言
- [ ] 变异：去掉 ancestry 判定 → 子会话绕过断言必失败；去掉到期过滤 → 到期断言必失败

## 4. 文档与版本

- [ ] `docs/collab.md` §11.2 工具表 + §11.14（三种工具合成一节：urgent / status / freeze）
- [ ] README、skill 速查表、CHANGELOG 0.6.0

## 5. 验证

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

## 6. 回滚

删除 `~/.config/opencode/collab-freeze.json` 即全量解除；代码 `git restore -- src/core/freeze.ts src/tools/freeze.ts src/tools/index.ts`
