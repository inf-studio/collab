# 执行计划：owner 队列 / research / 同仓拒广播

## 1. 队列内核（`src/core/owner-queue.ts`）

- [ ] `enqueue/revoke/read/listFor/ unseenHints`
- [ ] `COLLAB_OWNER_QUEUE_DIR` 覆盖；每目标上限 50；`tmp+rename`
- [ ] summary 去控制字符、≤500；`issuePath` 语法校验

## 2. 工具（`src/tools/owner-queue.ts`）

- [ ] `collab_request_owner { target, text, issuePath?, revoke?, confirm }`
- [ ] 校验方向（非保护 → 保护）；`confirm:false` 零写入
- [ ] `collab_list` 追加「我提交给受保护会话的请求：N 条」（≤3 行明细）

## 3. 注入白名单（`src/hooks/context.ts` + `src/core/chain.ts`）

- [ ] 受保护会话：followUps 提示 + owner-queue 未读（每次 ≤3 行）
- [ ] `seenAt` 在 `system.push` 成功后写（沿用 F1 修复）

## 4. `expected: research`

- [ ] `normalizeExpected` 接受 `research`
- [ ] 接管文案（pull/push 两版）支持 research
- [ ] explore + implement → 结果追加能力不匹配提示

## 5. 同仓 broadcast

- [ ] `collab_broadcast` 比较 realpath(workspace) 与当前目录 → 相等则拒绝并提示 `collab_handoff`

## 6. 回归（S90–S92）

- [ ] enqueue → 提示一次 → 不再出现；注入失败不 stamp
- [ ] 受保护发起方/非保护目标拒绝；revoke 仅发起方；队列满 50 拒新
- [ ] research 可传 + explore/implement 提示
- [ ] 同仓 broadcast 抛错且零写入
- [ ] 既有 526 + 12 + 18 全绿

## 7. 文档与发布

- [ ] `docs/collab.md` 新增「受保护目标请求队列」+ expected 三值 + 同仓限制
- [ ] skill/collab 与 skill/collab-coordination 补一句
- [ ] `0.4.0`（新增工具，minor）

## 验证

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```

## 回滚

删除 `collab-owner-queue/`；`git restore -- src/`。
