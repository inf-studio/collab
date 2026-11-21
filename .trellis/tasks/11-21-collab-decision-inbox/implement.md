# 执行计划：人类决策清单

## 顺序清单

- [ ] 1. `src/core/decision-inbox.ts`：读账本目录、过滤 open、算 age/TTL、排序、坏文件跳过
- [ ] 2. `src/tools/decision-inbox.ts`：`collab_decision_inbox { owner?, limit? }`；注册（28 → 29）
- [ ] 3. `src/gui.tsx`：看板顶部计数（有冲突 `⚠N`）+ 只读列表（无写按钮）
- [ ] 4. `src/tui.tsx`：详情行 `待决策 N（最老 X）`
- [ ] 5. 测试 `test/decision-inbox.mjs`：design §7 七例
- [ ] 6. 文档：`docs/collab.md` 工具表 + 新节、README、skill、CHANGELOG
- [ ] 7. 门禁 + 变异
- [ ] 8. 复核

## 门禁

```bash
HOME=<干净临时目录> pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

报数：工具数（29）、测试计数、GUI 计数与工具输出一致、只读断言。

## 复核门

- 独立子代理自己跑门禁与变异；
- 变异（强制 2 条）：排序反了 / 不过滤 open。

## 回滚

见 `design.md` §6。
