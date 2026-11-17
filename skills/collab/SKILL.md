---
name: collab
description: 当需要在 OpenCode 会话之间派活或交接时使用——同一工作区的多个会话互相接手，或跨工作区（如 muke-interface / std-ui）把提案交给对端实施。覆盖 collab_* 十个工具的选路、交接包模板、匹配分与原子领取、会话级权限补丁与 agent 升降级、protected 护栏，以及常见排障（npm scope 大小写、location.directory、allowWrite、热重载、重复插件 id）。
---

# collab：会话间派活与交接

## 何时用

- 同一工作区有两个以上会话，需要把一件事交给**另一个会话**（而不是自己做）。
- 跨工作区需要对方改代码/确认，且已经/准备写对方 `docs/issues/` 提案。
- 你**不确定**该由谁处理，希望按匹配分自动选人。

## 何时不用

- 只是告诉用户结论、或当前会话自己能做完——直接做。
- 只是想留长期记录：用 `trellis channel`。
- 对方工作区没有会话、且你没法确认要不要新建：先问用户，不要静默拉起。

## 一、工具速查

| 工具 | 入参要点 | 作用 | 性质 |
| --- | --- | --- | --- |
| `collab_list` | `limit?`, `directory?` | 列会话（id/agent/state/`loc=`/`parent=`/title）+ 未闭环交接 | 只读 |
| `collab_inbox` | `limit?` | 本会话收到的跨会话消息全文 | 只读 |
| `collab_wait` | `threadID?` / `target?`, `timeoutMs?` | 等某 thread 的回执，或等某会话空闲 | 只读 |
| `collab_send` | `target, text, kind?, threadID?, mode?, confirm` | 投递消息；`kind=request/reply/note` | 发消息 |
| `collab_reply` | `threadID, text, confirm` | 回执糖，target 由 thread 解析 | 发消息 |
| `collab_handoff` | `target?, text, expected?, confirm` | **同工作区**交接：选人 + 开 thread | 发消息 |
| `collab_broadcast` | `workspace, issuePath, expected?, agent?, agentConfirm?, confirm` | **跨工作区**交接：读提案 → 打分 → 全局交接文件 → 问 top-1 / 必要时拉新 | 发消息 + 可能建会话 |
| `collab_accept` | `bid, confirm` | 原子领取广播（只有一个 winner） | 写交接记录 |
| `collab_grant` | `target, revoke?, confirm` | 给**一个会话**加 5 条 `collab_*` 会话级权限 | 写会话权限 |
| `collab_promote` | `target, agent?, revert?, confirm` | 把会话 agent 切 `build`/`plan` | 写会话 agent |

默认值：`kind=request`、`mode=queue`（不打断）、匹配分门槛 **80**、租约 **5 分钟**、`attempts>3` 转 `expired`。
`confirm:true` 才真正执行；否则只预览。

## 二、同工作区（local）

```text
1) collab_handoff { text:"<要做什么 + 相关文件路径>", expected:"implement", confirm:true }
   → 返回 threadID；不传 target 时按匹配分选人（只有一个候选则直投）
2) 对方处理；需要全文时 collab_inbox
3) 对方 collab_reply { threadID, text, confirm:true }
4) 你 collab_wait { threadID, timeoutMs }
```

## 三、跨工作区（peer）

```text
0) 先写对端提案：<目标仓>/docs/issues/{bugs,fix,feat}-<name>.md（唯一允许的跨仓写）
1) collab_broadcast {
     workspace: "/data/project/muke-interface",
     issuePath: "docs/issues/fix-x.md",
     expected: "implement" | "review",
     confirm: true
   }
   → bid；无候选 ≥80 时会 spawn 一个 explore（只读）并投交接请求
2) 对端 ACCEPT 后处理；跨 location 不能用 thread，必须用消息回执
3) 对端：collab_send { target:"<发起方完整 sid>", text:"[handoff] DONE|BLOCKED <bid> <摘要>", confirm:true }
4) 你：collab_inbox 读回执；或等租约到期后由插件只读提取对端结论自动闭环
```

交接包模板（写进 `text` 或交给对端时）：

```text
[collab:<from>] <一句话结论>
提案：<目标仓相对路径>
范围：<前端/后端/跨工作区>
期望动作：<复核 / 实施 / 仅确认>
回执：collab_send { target:"<发起方 sid>", text:"[handoff] DONE|BLOCKED <bid> <摘要>", confirm:true }
边界：只写了提案，未改你仓代码、未动 git 历史、未 push
```

## 四、权限与升级（两根杠杆，别混）

| 需求 | 用什么 | 说明 |
| --- | --- | --- |
| 让对端**能回执** | `collab_grant` | 只加 5 条 `collab_*`，会话仍**只读** |
| 让对端**能改代码** | `collab_promote` | 切 agent 到 `build`，可 `revert` 还原 |
| `expected:"review"` | **永不 promote** | 研判只需要回执能力 |

- `allowWrite:false`（默认）时 `grant`/`promote` 会被拒绝；需要时在插件配置里传
  `options.allowWrite:true`。
- 两者共用台账 `~/.config/opencode/collab-grants/<sid>.json`，互不覆盖。

## 五、排障清单（按出现频率）

| 现象 | 真实原因 | 处置 |
| --- | --- | --- |
| 对端收不到/看不到工具 | 该会话没有 `collab_*` 权限（权限是**项目级** `opencode.json`） | 对自建会话 `collab_grant`；或在本仓配置 `agents.explore.permissions` |
| 会话建出来没反应 | 创建时缺 `location.directory` → 落在 `/root`，插件不加载 | 建会话必须带 `{"location":{"directory":"<abs>"}}` |
| 发布 403 `installation does not exist` | **npm scope ≠ 仓库 owner** | scope 必须与 owner 登录名逐字一致（`inf-studio` 不是 `info-studio`） |
| `Duplicate plugin ID: collab` | 项目内 `.opencode/plugins/collab.js` 与全局包同时加载 | 二选一：删本地副本或移除包 |
| 改了插件不生效 | 本地文件会热重载；**npm 包插件有缓存**，可能需重启 | `opencode plugin list` + `/api/plugin` 确认 |
| `collab_wait` 立刻报「没有 thread」 | thread 存储按 `location` 隔离 | 跨仓改用消息回执，不用 thread |
| 交接卡在 `claimed` | 对端只分析、没调用工具 | 租约到期自动提取结论；或 `collab_promote` 后重发 |
| 广播重复拉起会话 | 重复广播且 `bid` 不同（提案内容/mtime 变了） | 改提案后重新广播是预期行为；不要为同一内容反复广播 |

## 六、硬约束

1. 不向 `[protected]` / `[protected-child]` 投递或改权限（内置硬名单含 schema 线与原会话）。
2. 不打断：默认 `queue`；`steer` 仅显式；插件不提供 `interrupt`。
3. 不删除任何会话；自建会话也留给 owner 处置。
4. 跨工作区只写 `docs/issues/**`；对端 git 一律只读。
5. 一次交接只发一条；超时只提醒一次，不重投。

## 七、安装与升级

```bash
opencode plugin add @inf-studio/collab@<ver>     # GitHub Packages（需 @inf-studio scope 读权限）
opencode plugin list                              # 确认已装
opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"   # 无 failed
```

```jsonc
// ~/.config/opencode/opencode.json（需要写能力时）
{ "plugins": [{ "package": "@inf-studio/collab@<ver>", "options": { "allowWrite": true } }] }
```

`~/.npmrc`：`@inf-studio:registry=https://npm.pkg.github.com`（安装方需带 `read:packages` token）。
