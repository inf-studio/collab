# 执行计划：交接协议

## 0. 基线

- [x] `opencode --version`、`opencode api get /api/plugin`（确认 `collab` 无 failed）
- [x] 记当前 tally/无关状态到 `research/baseline.md`
- [x] 读现有 `.opencode/plugins/collab.js`（603 行）确认要改的段落：tools / event / hook / storage

## 1. 数据层

- [x] `collab/threads/<tid>` 读写（`ctx.storage`）
- [x] `collab/inbox/<sid>` 增 `injected: string[]`
- [x] `threadID` 生成器 + 校验

## 2. 工具层

- [x] `collab_send` 增 `kind`/`threadID`；默认 `mode:"queue"`；只读 agent 强制 queue
- [x] `collab_reply`（语法糖）新增
- [x] `collab_inbox` 返回全文 + thread 状态（open/answered）
- [x] `collab_wait` 增 `threadID` 模式（等回执），保留 idle 模式

## 3. 注入层

- [x] `context` hook：过滤已 `injected` 的 inboxID；按 kind 分组输出
- [x] 与请求内 inboxID 比对（拿不到则按 `(threadID,kind,text)` 退化去重）

## 4. agent 可见性

- [x] 在 `.opencode` agent 配置里给 `explore`/`plan` 加 collab 工具 allowlist
- [x] 新会话验证可见（旧会话不生效）

## 5. 验证（只用自建临时会话）

- [x] 闭环：A request → B reply → A `collab_wait{threadID}` 拿到回执
- [x] 不打断：B 忙时投递，B 当前 assistant 消息 id 不变
- [x] 去重：连续两次请求，同一消息不重复注入
- [x] 只读 agent：`explore` 能 `collab_inbox`；`send` 返回 `mode=queue(forced)`
- [x] 持久化：插件重载后未读与 thread 状态仍在（口径订正：改 `collab.json` **不触发**重载，见 research/verification.md §5）
- [x] 清理：临时会话全删，`collab_list` 无残留

## 6. 文档

- [x] `docs/collab.md` 增「交接协议」节（三步流程 + 工具矩阵 + 只读 agent 降级说明）
- [x] `docs/collab.md` §11.6 的「注入冗余」更新为「按 inboxID 去重后的行为」
- [x] `.trellis/spec/guides/cross-session-collab-guide.md` 补「request/reply 契约 + 不打断」两条

## 7. 收口

- [x] `node --check .opencode/plugins/collab.js`
- [ ] 显式路径提交（禁 `git add -A`），禁止 push —— 留给主会话（implement 子代理不执行 git commit）
- [ ] 独立复核（`trellis-check`）通过后归档

## 8. 复核后处置（fix round，2026-11-17）

复核报告：`research/check-report.md`（结论「有条件通过」，owner 裁定「阻断 + 应修全修」）。
实现摘要与证据：`research/fix-notes.md`。

- [x] **F1（阻断）血缘护栏**：`dispatch` 改为 `protectedAncestor()` 逐级上溯 `parentID`（≤8 级、环保护；
      `ctx.session.get` 缺字段时回退 `ctx.session.list()`）；`collab_list` 标 `[protected-child]` + `parent=<short>`
- [x] **F2（应修）reply 参与者与路由**：`collab_reply` / `collab_wait{threadID}` 校验 `me ∈ {from,to}`；
      `collab_send{kind:"reply"}` 校验 `target === thread 对端`，不一致拒绝且不写 thread；无 sessionID 时加注
- [x] **F3（应修）thread 复用**：`request` 一律把 status 置 `open`；`collab_wait` 只看最后一次 request 之后的 reply
- [x] **F4（应修）legacy 消息指引**：无 threadID 时不再拼 `collab_reply {threadID:"undefined"}`；
      `normalizeThreadID` 把 `undefined/null/"undefined"/"null"` 一律视为无 thread
- [x] **F6（应修）`collab_wait` 校验**：格式非法立即报错；thread 不存在快速失败（不再空等到 timeout）
- [x] 规则用例：harness 新增 S17–S22（血缘直系/孙级、非参与方 reply/wait、reply 误路由、thread 复用、
      legacy 文案、wait 快速失败），并改为**断言式**（失败 exit 1）；S1–S16 全部仍通过
- [x] 文档：`docs/collab.md` §11.2/§11.3/§11.4/§11.6/§11.7、spec guide §2/§2.1、`prd.md` AC5 口径

### 回滚（fix round）

`git restore -- .opencode/plugins/collab.js docs/collab.md .trellis/spec/guides/cross-session-collab-guide.md`
+ 还原 harness；`ctx.storage` 数据无需迁移（新增字段对旧数据是可选读）。

## 回滚

`git restore -- .opencode/plugins/collab.js docs/collab.md`；`ctx.storage` 数据可留（旧版忽略新字段）。
