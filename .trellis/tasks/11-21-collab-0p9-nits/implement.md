# 执行计划：0.10.x 遗留小修（5 条）

## 顺序（互不依赖，按风险从低到高）

- [ ] 1. **F5** 幂等断言加类型守卫（纯测试，最安全）
- [ ] 2. **F4** 重算与写入同口径：有消息就出行（含全为重发行）
- [ ] 3. **F3** 缺失 pacing 计数写 NULL；`metrics` 显示 `-`；文档说明
- [ ] 4. **emoji 宽度**：`clipCells` 的宽字符表 + ZWJ 不切分
- [ ] 5. **mtime 缓存**：契约快照去掉 mtime 缓存（直接读）；决策清单缓存保留
- [ ] 6. 文档同步 + 门禁 + 变异
- [ ] 7. 独立复核

## 门禁

```bash
HOME=<干净临时目录> pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

另用**真实 HOME** 单跑 `node test/pacing.mjs`（应 89/89）。

报数：工具数（29）、测试总数、每条的变异红/绿、100 会话快照耗时（去缓存后）。

## 变异（每条一组）

| 条目 | 变异 | 必须红 |
|---|---|---|
| F3 | 缺失计数写 0 | `metrics` 的 `-` 断言 |
| F4 | 分组前排除重发行 | 「只有 `_r1` 的日期行存在」 |
| F5 | checksum 返回 undefined | 幂等类型断言 |
| emoji | 宽度表退回 1 格 | 窄面板不换行断言 |
| mtime | 把缓存加回去 | 「同毫秒二次写读到新值」 |

## 回滚

逐条按显式文件清单回滚：`src/core/metrics.ts`、`src/core/index-db.ts`、`src/tui.tsx`、`src/core/snapshot.ts`、`test/store-rebuild.mjs`、`test/tui-render.mjs`、`test/snapshot-shape.mjs`、`docs/collab.md`。
