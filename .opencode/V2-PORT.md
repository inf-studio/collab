# OpenCode V2 插件移植说明（trellis-*）

> 由 `trellis-init-v2` 自动生成于 2026-11-17T08:01:54Z

## 这是什么

`.opencode/plugins/*.js` 与 `lib/context-visibility.js` 采用 **OpenCode V2 移植**，
不是 `trellis init/update` 生成的原始模板。

| 项 | 值 |
|---|---|
| 来源 | Trellis PR #639 `feat(opencode): support OpenCode 2.x` |
| commit | `bc64d35f6bd42a41e7c6ce787415ed00f7e1e022` |
| 上游状态 | PR closed 未合并；issue #628 仍 open |

## 为什么需要

OpenCode V2 插件 API 是破坏性变更：V1 是 `export default async ({client,directory}) => ({ "hook.name": ... })`，
V2 要求 `export default { id, async setup(ctx) { ... } }`。V1 实现会 `failed` 或静默失效。

## 移植做了什么

1. 双入口 `{ id, async server(){/*v1*/}, async setup(ctx){/*v2*/} }`
2. `experimental.chat.messages.transform` → `ctx.session.hook("context")`；`tool.execute.before` → `ctx.tool.hook("execute.before")`
3. V2 改名兼容：`bash`→`shell`、`task`→`subagent`、`subagent_type`→`agent`、容忍命名空间 agent ID
4. `lib/context-visibility.js` 提供 `*V2` helper（模板自带版本缺这些）
5. 注入内容以 `metadata.trellis.*` 标记；插件零依赖

## ⚠️ 重要：`trellis update` 会覆盖

`trellis update/upgrade` 会用 V1 模板重新生成 `.opencode/plugins/*.js`，抹掉本移植。

重放：

```bash
cd $(git rev-parse --show-toplevel) && git apply .opencode/v2-port.patch
# 或：trellis-init-v2 <项目目录> --no-init
```

重放后验证：

```bash
opencode api get "/api/plugin?location[directory]=$PWD"   # 3 个插件应全部 active
rm -f /tmp/trellis-plugin-debug.log && opencode run "读取当前任务状态"
grep -E 'Built context, length|Injected breadcrumb|Injected TRELLIS_CONTEXT_ID' /tmp/trellis-plugin-debug.log
```
