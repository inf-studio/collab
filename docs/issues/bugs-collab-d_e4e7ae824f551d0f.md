# 插件缺陷 d_e4e7ae824f551d0f：collab_report / manual

> 状态：已定位（kind 缺省 → 默认 request 被 protect 护栏拒）；0.1.4 兼容修复中（任务 11-18-collab-legacy-receipt）
> 签名：d_e4e7ae824f551d0f
> 受影响版本：0.1.3
> 首次上报：2026-11-18T00:57:17.894Z
> 最近上报：2026-11-18T00:57:17.894Z
> 上报次数：1（同签名每小时最多 1 条，不代表真实发生次数）
> 工作区：/data/project/std-ui
> 涉及 bid：b_bdae848832cd51fb
> 涉及 thread：t_mwlbp7x5_sea5

## 现象

- `ManualReport: 回执无法投递：bid 发起方 [redacted] 在 BUILTIN_PROTECT 内，collab_send(request/reply/note) 一律 fail-closed；bid 长期停在 acked、replies=[]。已按催办改为回复末行标注 ×3 次仍未收口（发起方会话 idle 未再运行）。提案：/data/project/collab/docs/issues/bugs-protected-requester-receipt-undeliverable.md`

## 复现线索

- 工具：collab_report
- 分类：manual
- 调用方会话（短 id）：ses_e144…EWoq
- 参数正文/文件内容/token 未入库（证据白名单 + 脱敏）

## 证据

- `/root/.config/opencode/collab-reports/d_e4e7ae824f551d0f/1794963437894.json`（2026-11-18T00:57:17.894Z）

## 影响面

- 该错误让调用方拿到异常；是否可自愈未知（上报是旁路，不改变协作状态）
- 修复后：在 CHANGELOG 写明，并把上面「状态」改成「已修复（版本 x.y.z）」；triage 之后不再重复生成

## 处理流程

1. 读证据 JSON 与该工具的现状代码，判断是缺陷还是调用方误用
2. 复现 → 开 Trellis 任务 → 修 → 发补丁版本 → 回执上报方

<!-- 由 scripts/collab-triage.mjs 生成；重跑会按最新证据重建本文件（保留「状态」行） -->
