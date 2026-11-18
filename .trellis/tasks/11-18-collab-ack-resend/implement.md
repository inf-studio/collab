# 执行计划：ack / 重发 / 24h 窗口

## 1. 数据与常量

- [ ] `BroadcastRecord.delivery` / `followUps`（types.ts）
- [ ] `ACK_SEEN_WINDOW_MS=2h`、`POST_DONE_FOLLOWUP_MS=24h`、`MAX_RESENDS=1`（constants.ts）
- [ ] `normalizeBroadcast` / `persistRefresh` 归一化新字段

## 2. ack

- [ ] `src/core/ack.ts`：`buildAck(cid)` / `parseAck(text)` / `markSeen(record, cid)`
- [ ] 收方：`injectionFor` 注入后 & `collab_inbox` 读取后 → 发送 `[ack] <cid> seen`（同 cid 一次）
- [ ] 发方：事件流解析 `[ack]` → `delivery.seenAt`
- [ ] 受保护发送方 → `ackUnavailable`，不发送

## 3. 重发

- [ ] `refresh`/context 侧：按 design §3 条件重发（同 cid），`resends++`
- [ ] busy 目标跳过；失败置 `unacked`
- [ ] `collab_list` 显示 `delivered/seen/resend/unacked`

## 4. 闭环后追加（pull hint）

- [ ] 新工具 `collab_followup { bid, text, confirm }`：仅 `claim.by` 可调、仅 done/blocked、只追加 `followUps[]`
- [ ] `injectionFor` 窄化放开：`from.sid === me` 且有未提示的 followUps → 一行只读提示（文件+时间，无正文/指令）
- [ ] `followUpsSeenAt` 去重（每条只提示一次）
- [ ] 不投递、不改 state/receipt、不重开 bid

## 5. 回归（S83–S85）

- [ ] ack：正常注入 → seen；busy 不误判；受保护 → ackUnavailable
- [ ] 重发：admission 失败重发 1 次；busy 不重发；同 cid 不重复注入
- [ ] 追加：claimer 可写、非 claimer 拒绝、state 不变、受保护发起方看到一次提示、重复不重复提示
- [ ] 既有 405+12 全绿

## 6. 文档与发布

- [ ] `docs/collab.md`（ack/重发/窗口）+ skill + CHANGELOG
- [ ] `0.1.6` → tag → CI → 全局升级 → 实测 `opencode reload` 是否使已运行会话换版本（记录结论）

## 验证

```
pnpm build && pnpm typecheck && pnpm test && node scripts/check-skill.mjs
```
