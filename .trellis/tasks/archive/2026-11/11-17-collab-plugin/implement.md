# 执行计划：collab 插件化

## 0. 基线

- [ ] `opencode --version`、`opencode service status`、`opencode api get /api/info`
- [ ] `opencode api get /api/plugin` 记录现有插件状态（作为「无新增 failed」的对照）
- [ ] `git rev-parse --short HEAD` → `research/baseline.md`

## 1. 探明事件类型（先探测再写白名单）

- [ ] 临时插件里 `ctx.event.subscribe({})` 打印 10 条事件的 `type`，记录到 `research/events.md`
- [ ] 选定「入站消息 / 状态变化」相关 type，写进订阅白名单

## 2. 实现插件

- [ ] `.opencode/plugins/collab.js`：`export default { id:'collab', async setup(ctx){…} }`
- [ ] `ctx.tool.transform` 注册 4 工具（`collab_list / collab_send / collab_inbox / collab_wait`）
- [ ] `collab_send`：解析别名 → `protect` 校验 → `confirm` 校验 → `ctx.session.prompt`
- [ ] `ctx.event.subscribe`（`AbortController`）→ 写 `ctx.storage` 未读队列
- [ ] `ctx.session.hook("context")`：未读摘要注入 + 游标推进
- [ ] 读 `~/.config/opencode/collab.json`（缺省用内置默认），与 `ctx.storage` 的 aliases 合并

## 3. 加载验证

- [ ] `opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD"` → 无 `failed`、含 `collab`
- [ ] 若加载失败：按错误修（常见：导出形状、`id` 缺失、语法）

## 4. 功能验证（只用自建临时会话）

- [ ] 建 A、B 两个临时会话（agent=explore，省钱）
- [ ] A 内让模型调用 `collab_list` → 返回可用会话（贴 reply 摘要）
- [ ] A 调用 `collab_send {target:B, confirm:true}` → B `messages` +1 且首条带 `[collab:…]`
- [ ] `confirm:false` → 不投递（B messages 不变）
- [ ] `protect` 命中 → 拒绝且不投递
- [ ] `mode:"queue"` 投递后，B 下一轮 reply 含 `[collab]` 未读提示
- [ ] 清理：删除 A、B，复核 404

## 5. 全局配置与持久化

- [ ] 写 `~/.config/opencode/collab.json` 示例（aliases/protect/autoDeliver/maxInject）
- [ ] 改 aliases 后 `collab_send {target:"<alias>"}` 可用
- [ ] `opencode service restart` 后 `ctx.storage` 游标仍在（贴前后对比）

## 6. 文档

- [ ] `docs/collab.md` 增「插件」节：启用方式（仓库内 / 全局 symlink / `plugins` 数组）、4 个工具、与 CLI 的分工
- [ ] `.trellis/spec/guides/cross-session-collab-guide.md`（若校验者建议）：选路 + 硬规则 + API 语义 + 隔离惯例
- [ ] `docs/README.md` 已有 `collab.md` 行，无需新增

## 7. 收口

- [ ] `node --check .opencode/plugins/collab.js`
- [ ] 显式路径提交（禁 `git add -A`），禁止 push
- [ ] 独立复核（`trellis-check`）通过后归档

## 回滚

删 `.opencode/plugins/collab.js` + 从全局 `plugins` 移除条目；`ctx.storage` 数据不影响其它插件。
