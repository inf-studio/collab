# thread 索引与 status 降级

`ThreadStore`（`src/core/storage.ts`）只能按 id 读、不能枚举；而同一对会话可能并行多个 thread
（实测一条链路 7 个），所以需要一份轻量索引。

## 索引

- 文件：`~/.config/opencode/collab-threads.json`（`COLLAB_THREAD_INDEX_FILE` 可覆盖，测试隔离靠它）；
- 形状：`{version:1, entries:{t_…:{target,kind,from,lastAt,preview,bid?}}}`；
- **只在投递成功后写**（预览 / 护栏拒绝 / 投递失败都不写）；`kind:"handoff"` 粘性；
- 上限 500 按 `lastAt` 淘汰；读时 7 天过滤**只过滤不删**（读路径零写入）；
- 坏 JSON / 未知 version / 数组形状 → 按空处理 + 一次日志，绝不让索引拖垮工具。

## 两个读命令

- `collab_threads { target, includeClosed? }`：默认只列未闭环；`includeClosed` **预留** ≤3 个槽位，
  不能被满屏未闭环吞掉；≤20 条 + 「还有 N 个」；给唯一「← 建议继续」。
- `collab_status { threadID }`：无广播记录时**降级**为 `kind:"messages"` + 最近出入站摘要 +
  关联交接单；未知 thread 才保留「可能拼错」原文案。
  教训：旧版对消息 thread 直接报错，而线上 7 个 thread 里 6 个是消息 thread。

## 性能

索引可能有几百条，但渲染上限 20。**先按 `lastAt` 排序取前 `MAX + CLOSED + 7`，再逐条
`threads.read`**——否则 400 条索引会触发 400 次宿主 RPC（数百 ms~数秒）。更老的 thread 仍可用
`collab_status {threadID}` 直达。
