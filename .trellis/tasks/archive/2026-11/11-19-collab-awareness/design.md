# 设计：协作自动感知

## 1. 注入行（`src/index.ts` context hook）

现有的注入组装点在 `context` 钩子（`maxInject` 预算）。新增一行，**最后追加**，预算不足时最先被丢弃：

```
协作：本工作区候选 {N}（collab_handoff） · 其它工作区候选 {M}（collab_broadcast，需提案）
```

- N：`listSessions({ directory: workspace, limit: 100 })` 里 `id !== me`、非子会话（`parentID` 空）、未归档；
- M：**其它工作区**先去重出 directory 集合，再各自 `listSessions({ directory, limit: 20 })` 计活跃数；
  本次证据里的 A(issues-wt)/B(mojoy-studio) 正属于这种情况。
- 只有 `N=0` 时把前半句省略，只留 `其它工作区候选 M（collab_broadcast，需提案）`；`M=0` 同理。

## 2. 去噪与成本

- 会话级缓存：`{ lastInjectedAt, n, m }`（10 分钟 TTL，进程内 Map by sessionID）；
- 跨工作区目录列表**每 10 分钟最多一次**（同一 Map 记录 `listedAt`）；宿主抛错 → `m` 记为 `undefined`，本行只写 N；
- 触发条件（全部满足）：
  1. `awareness !== 'off'`；
  2. 当前会话非 protected（`createLineage().protectedAncestor`）；
  3. 当前会话无未闭环交接（`from.sid === me` 且 state 非终态）；
  4. `n + m >= 1`；
  5. 距上次注入 ≥ 10 分钟。

## 3. 承接侧协议头

交接投递文本的构造处（`handoff.ts` / `broadcast.ts` 的 dispatch 模板）已有回执提示；改为**最前面固定几行**：

```
你是承接方（bid=b_… / thread=t_…）
完成后回执：collab_reply { threadID:"t_…", text:"[handoff] DONE b_… <摘要>", confirm:true }
阻塞回执：collab_reply { threadID:"t_…", text:"[handoff] BLOCKED b_… <缺什么>", confirm:true }
```

> 复核修正（P2）：初版写的是 `collab_reply { threadID, confirm }` + `阻塞用 kind:"note"`，实际闭不了环——
> `text` 是必填（照抄报 `text 不能为空`），`kind` 不在 `collab_reply` 的入参里，且显式 `note` 入站被当作
> 「有意非回执」忽略；闭环只认正文里的 `[handoff] DONE|BLOCKED <bid>` 行。所以命令必须把 `[handoff]` 行
> 放进 `text`。

跨工作区（peer，跨 location 没有共享 thread）改为：`[handoff] DONE|BLOCKED <bid> <摘要>`
（明确「写进 `collab_send` 的 `text` 发给发起方」；pull 模式同样）。

## 4. 兼容与回滚

- 注入行不写任何记录；`awareness:"off"` 立即归零；
- `maxInject` 已满时不追加（不挤掉交接/队列行）。

## 5. 测试

| 用例 | 期望 |
| --- | --- |
| 同工作区 2 + 跨工作区 3 | 行内容 `本工作区候选 1 · 其它工作区候选 3` |
| 仅跨工作区 | `其它工作区候选 M`，无前半句 |
| 有未闭环交接 | 不出现 |
| protected | 不出现 |
| `awareness:"off"` | 不出现 |
| 10 分钟去重 | 两次 context 只出现一次，列表只查一次（假宿主计数） |
| 宿主列表抛错 | 只写 N，不抛 |
| 承接方首行 | 含「承接方」+ 回执命令；跨工作区含 `[handoff] DONE\|BLOCKED` |

变异：把 `n+m>=1` 改成 `n>=1` → 仅跨工作区用例失败；去掉 10 分钟缓存 → 列表计数断言失败。

## 6. 回滚

`awareness:"off"`；代码 `git restore -- src/index.ts src/core/*`（仅注入组装）。
