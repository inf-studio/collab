# 交接：collab 双向交接协议（接管方必读）

> 交接时间：2026-11-17。原会话已转回 design-code 主线，本任务由新会话接管。
> 任务目录：`.trellis/tasks/11-17-collab-handoff`（`task.py` 指针当前指向它）。

## 一、现在是什么状态

| 项 | 状态 |
| --- | --- |
| 代码实现 | ✅ 已完成（`.opencode/plugins/collab.js` 603 → 1146 行） |
| 文档 | ✅ 已改（`docs/collab.md` §11.2/§11.6/§11.7、spec guide §2.1/§3.1） |
| 配置 | ✅ 已改（`opencode.json` 给 `explore`/`plan` 加 5 个 `collab_*` 权限） |
| 自测 | ✅ 实现方自测通过（闭环 / 不打断 / 去重 / 只读 agent / 持久化） |
| **独立复核** | ⚠️ **未落盘**：最后一次 `trellis-check` 已派出但结果未知，`research/` 里没有 check 报告 |
| **提交** | ⚠️ 未提交（见 §二 文件清单） |

## 二、未提交的文件（必须按显式路径 `git add`）

```
.opencode/plugins/collab.js                          (M, +760/-130)
opencode.json                                        (M, +20)
docs/collab.md                                       (M, +80/-…)
.trellis/spec/guides/cross-session-collab-guide.md   (M, +26/-…)
.trellis/tasks/11-17-collab-handoff/                 (??)
```

**禁止 `git add -A`**：工作区还有 schema 线（`packages/schemas/**`、`packages/contracts/**`）与其它会话的改动。

## 三、接管后要做的事（按序）

1. **跑一次独立复核**（`trellis-check`），重点：
   - 闭环：A `request` → B `collab_reply` → A `collab_wait{threadID}` 拿到回执；
   - 不打断：B 忙时投递 `steer` → 应返回 `queue(forced)`，且 B 的 assistant 消息 id 不变；
   - 去重：相邻两次请求，同一条消息只注入一次（三重过滤：`injected` / 本次请求 cid / thread answered）；
   - 只读 agent：`explore` 能用 5 个工具，`send` 强制 queue；
   - `opencode.json` 是否只给 `collab_*` 开口子、没有顺带放开别的能力。
2. **确定性回归**（不依赖模型）：`node .trellis/tasks/11-17-collab-handoff/research/handoff-harness.mjs` —— 覆盖 S1–S16（预览/投递/强制 queue/去重/reply/wait/防护）。
3. 复核通过后 **提交**（显式路径），消息建议：
   `feat(collab): 双向交接协议（request/reply + 不打断 + 只读 agent 分级）`
4. Phase 3.3 spec 已更新（`cross-session-collab-guide.md`），无需重复；如需补再补。
5. `task.py finish` + `task.py archive 11-17-collab-handoff`。

## 四、硬约束（别踩）

1. **禁止真实投递给** `ses_e1eb91cebffeTv1467ubJLKebk`（schema）、`ses_e23a4a23fffe4c4m7UQFR8dUL3`（原会话）及其子会话；
   插件 `BUILTIN_PROTECT` 已含，别删别绕。
2. 验证只用**自建临时会话**（`opencode api post /api/session`），用完 `DELETE` 并复核 404。
3. 不使用 `interrupt`；不改 `packages/**`、`apps/**`、`packages/schemas/**`。
4. 不碰 `11-15-design-normalize`（不属于本线）。
5. 插件改动会**热重载**：改完 `opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"` 确认无 `failed`。

## 五、关键设计（避免重复讨论）

- 消息信封：`[collab:<from>][<kind>:<threadID>] …`；metadata 带 `cid/kind/threadID/from/fromSessionID`。
- thread 状态机：`open → answered → closed`，落 `ctx.storage` 的 `collab/threads/<tid>`。
- 投递默认 `delivery:"queue"`（不打断）；只读 agent 强制 queue 并返回 `mode=queue(forced)`。
- 注入三重过滤，且 `collab_inbox` 永远返回全文（注入只是提醒视图）。
- 持久化口径：`~/.config/opencode/collab.json` **不是** OpenCode 配置，改它不会触发重载；真实触发是改插件文件。

## 六、已知限制（写进 docs §11.6，别再当成 bug 查）

- 只读 agent 的可见性由 `opencode.json` 的 permissions 决定（V2 无 `tools` 字段），**新会话生效**；
- `opencode service restart` 后的持久化仍未验证（重启会打断并行会话，需挑空窗）。
