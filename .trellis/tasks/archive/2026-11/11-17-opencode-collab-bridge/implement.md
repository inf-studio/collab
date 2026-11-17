# 执行计划：跨会话实时协作工具

## 0. 基线

- [x] `opencode --version`（记录，实测 v2.3.0）
- [x] `opencode api get /api/session | head -c 200` 确认服务可用（后台服务 `http://0.0.0.0:22016`）
- [x] 记 `git rev-parse --short HEAD` 到 `research/baseline.md`（`f4c7e41fa`）

## 1. 实现

- [x] 建 `scripts/collab.mjs`（Node，零依赖；调用 `opencode api` CLI）
- [x] 子命令：
  - `list`：会话 id / agent / parentID / 标题（可 grep）
  - `send <target> <text> [--yes] [--mirror <channel>]`：默认 dry-run 打印，`--yes` 才投递
  - `wait <target> [--timeout 10m]`：调 `.../wait`；超时退出码 2
  - `messages <target> [-n 10]`、`inbox <target>`
  - `selftest`：建临时会话 → send → wait → messages 命中 → delete（finally 清理）
- [x] 别名表读取 `~/.config/opencode/collab-aliases.json`（不存在则只接受 `ses_` 全名）
- [x] `--help` 输出与示例

## 2. 自测（关键）

- [x] `node scripts/collab.mjs selftest` 全绿（退出码 0，原始输出见下）
- [x] 失败路径：
  - 目标会话不存在 → 退出码 1 + 可读错误
  - 服务未启动 → 退出码 1 + 提示 `opencode service start` / `opencode serve`
  - `send` 不带 `--yes` → 只打印不发送（用临时会话验证 messages 未增加）

## 3. 文档

- [x] 新增 `docs/collab.md`：用途、四条命令、与 Trellis channel 的分工、风险边界
- [x] `docs/README.md` 索引加一行
- [x] 在 `.trellis/tasks/11-17-parity-closeout/research/channel-protocol.md` 补一句「实时通道可用 `collab`」（并更正该文「OpenCode 无按 sessionID 送消息能力」的过时结论）

## 4. 收口

- [x] 门禁：`node --check scripts/collab.mjs`；`pnpm exec vp fmt --check docs/collab.md docs/README.md`
      （`scripts/*.mjs` 在 `vite.config.ts` 的 fmt/lint 忽略表里，故脚本以 `node --check` 为准）
- [ ] 显式路径提交（禁 `git add -A`），禁止 push —— 由主会话执行
- [ ] 独立复核（`trellis-check`）通过后归档

## 实施记录（与计划的差异，按实测修正）

1. **`send` 默认走 `prompt` 而不是 `generate`**。实测 `POST /generate` 是**临时生成（不写历史、不驱动 agent loop）**（阻塞到该轮结束、
   返回 `{text,tokens,cost}`），不是「注入一条消息即返回」；异步投递语义在
   `POST /api/session/{id}/prompt`（立即返回 `{id, delivery}`，`delivery=steer|queue`）。
   因此 `send` 默认 `prompt`，需要「顺带拿回复原文」时用 `--generate`。
2. **`wait` 自实现超时**：`opencode api` 无 timeout 选项，用 `spawn` + 定时 `SIGTERM`（退出码 2）。
3. **`-d @file` 不可用**：`opencode api -d @x.json` 会把 `@x.json` 当字面量；改用 `spawnSync` 参数数组传
   JSON 字符串（不过 shell，多行/引号安全）。
4. **query 拼进 path**：`--param limit=` 在部分端点不生效，统一写 `.../message?limit=N&order=desc|asc`。
5. **未知选项即报错**（退出码 1），避免拼错的 `--ys` 被当正文吞掉；正文需以 `-` 开头时用 `--` 分隔。
6. **多加了 `aliases` / `alias set|rm`**（别名表可写），否则每次都要手编 JSON。
7. **`interrupt` 二次确认要求输入完整会话 id**（不止 y/N），非 TTY 直接拒绝（退出码 3）。
8. `selftest` 会消耗一次模型调用（实测 ≈$0.001–0.02）；默认 agent 用只读的 `explore`，`--keep` 可保现场。

## 证据（原始输出）

`node scripts/collab.mjs selftest` → 退出码 0：

```
collab 0.1.0 selftest —— 临时会话（title=collab-selftest-1794865699052, agent=explore）
注：会在临时会话上真实跑一轮模型（约 $0.01–0.03），结束即删除。
✓ 服务可用（GET /api/session） — 50 个会话
✓ 创建临时会话 — ses_e19aae579ffeM5x36YUJyPlP1P
✓ 不存在的目标 → 报错（GET 404） — SessionNotFoundError: Session not found: ses_selftest_not_exists_0000
✓ 不带 --yes 只做 dry-run（消息未增加） — messages=0 exit=0
✓ 投递消息（POST /prompt） — message=msg_1e6551e02001Jq3XNKHjmc1Tmc delivery=steer
✓ 等待空闲（POST /wait, timeout=3m） — 耗时 1.6s
✓ 读回消息命中 token（GET /message） — messages=3 assistant=1
✓ 空闲时 wait 立即返回 — 耗时 495ms
✓ list 能解析出临时会话与 agent — agent=explore
✓ 删除临时会话（DELETE /session） — ses_e19aae579ffeM5x36YUJyPlP1P
✓ 复核已删除（GET 返回错误） — SessionNotFoundError: Session not found: ses_e19aae579ffeM5x36YUJyPlP1P
✓ selftest 全绿：建 → dry-run → 发 → 等 → 读回 → 删
```

失败路径（退出码）：

| 场景 | 命令 | 结果 |
| --- | --- | --- |
| 目标不存在 | `send ses_doesnotexist... --yes` | 1，`会话不可用（...）：SessionNotFoundError: Session not found` |
| 服务未启动 | `list --server http://127.0.0.1:1` | 1，`Could not reach server ...` + 提示 `opencode service start` |
| 别名无法解析 | `send some-alias x` | 1，列出已知别名/建别名提示 |
| `--yes` 缺失 | `send <临时会话> ...`（不带 --yes） | 0，`[dry-run] 未发送`，messages 仍为 0 |
| wait 超时 | `wait <忙会话> --timeout 1s` | 2 |
| interrupt 缺开关 | `interrupt <会话>` | 3，拒绝执行 |
| interrupt 非 TTY | `interrupt <会话> --interrupt </dev/null` | 3 |
| interrupt 确认串错 | pty 下输入错误 id | 3，已取消（未打断） |
| interrupt 确认串对 | pty 下输入完整 id | 0，`interrupted=true`，会话 `outcome=interrupted` |
| 真实会话 dry-run | `send ses_e1eb91cebffeTv1467ubJLKebk ...` | 0，仅打印；该会话 messages 数前后一致（200/200） |

## 回滚

删 `scripts/collab.mjs` 与 `docs/collab.md` 即可；不涉及产品代码与数据迁移。
