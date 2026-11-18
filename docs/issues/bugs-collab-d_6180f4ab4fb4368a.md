# 插件缺陷 d_6180f4ab4fb4368a：collab_report / manual

> 状态：已核实（D2 不成立；D1/D3/D4 成立，任务 11-18-collab-owner-queue 0.4.0 修复中）
> 签名：d_6180f4ab4fb4368a
> 受影响版本：0.3.1
> 首次上报：2026-11-18T06:35:02.466Z
> 最近上报：2026-11-18T06:35:02.466Z
> 上报次数：1（同签名每小时最多 1 条，不代表真实发生次数）
> 工作区：/data/project/muke-pos-app
> 涉及 bid：b_df1134f81244b028, b_18015f0c6002beec
> 涉及 thread：-

## 现象

- `ManualReport: 缺陷上报（来自 muke-pos-app CLI 线，2026-11-18）：
D1【阻断】protected 目标无合规送达路径：schema 线 ses_e1eb91… 在 BUILTIN_PROTECT（collab dist index.js:34，配置只能加不能减），collab_handoff 预览即返回「目标在 protect 名单内（depth=0），确认后仍会被拒绝」→ 合法的跨线排查请求无法送达 owner；退化为 broadcast 拉起的 explore 会话只能 BLOCKED（b_18015f0c6002beec 案例：对端回复「我是只读检索代理，无 collab…`

## 复现线索

- 工具：collab_report
- 分类：manual
- 调用方会话（短 id）：ses_e4c0…QstQ
- 参数正文/文件内容/token 未入库（证据白名单 + 脱敏）

## 证据

- `/root/.config/opencode/collab-reports/d_6180f4ab4fb4368a/1794983702466.json`（2026-11-18T06:35:02.466Z）

## 影响面

- 该错误让调用方拿到异常；是否可自愈未知（上报是旁路，不改变协作状态）
- 修复后：在 CHANGELOG 写明，并把上面「状态」改成「已修复（版本 x.y.z）」；triage 之后不再重复生成

## 处理流程

1. 读证据 JSON 与该工具的现状代码，判断是缺陷还是调用方误用
2. 复现 → 开 Trellis 任务 → 修 → 发补丁版本 → 回执上报方

<!-- 由 scripts/collab-triage.mjs 生成；重跑会按最新证据重建本文件（保留「状态」行） -->


## 维护方核实（2026-11-18）

- **D2 不成立**：`collab_handoff(confirm:false)` 只**打印** `thread=`/`bid=`，不写文件；全局目录里查无 `b_df1134f81244b028`。
  `threads.update` / `writeBroadcast` 都在 `dispatch()` 里，护栏在投递前抛错，不会留下悬挂记录。
- **D1 成立**：受保护目标是单向硬边界，合法请求确实送不进去。采纳「owner 审阅队列」：写全局队列 + 受保护会话
  下次运行收到**一行只读提示**（不投递、不唤醒），与 followUps 的 pull 模型同构。
- **D3 成立**：`expected` 增 `research`；`explore + implement` 时结果会明确提示能力不匹配。
- **D4（观察）成立为设计遗漏**：同工作区调用 `collab_broadcast` 改为**拒绝并提示用 `collab_handoff`**。
