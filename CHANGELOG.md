# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.2] - 2026-11-18

### Fixed

- **受保护发起方的回执死锁**（`docs/issues/bugs-protected-requester-receipt-undeliverable.md`，
  std-ui 提出，复核结论「部分成立」）：`scope=peer` 广播的发起方在 `protect` 名单内时，
  接管请求/`collab_accept` 仍要求承接方 `collab_send` 回执，而 `deliver()` 的血缘护栏对
  **所有** `kind` 拒绝投递到受保护目标——通知要求做一件被自己禁止的事，闭环只剩租约到期后的
  启发式提取。现在：
  - 广播创建时若发起方命中 `protectedAncestor`，记录写 `receiptMode:"pull"`；接管请求、
    `collab_accept`、`collab_broadcast` 结果与租约提醒改为「在本会话最后一条回复里写
    `[handoff] DONE|BLOCKED <bid> <摘要>`」，由发起方在租约到期后只读提取（`accept` 领取
    同样适用，不再只限 `spawn` 领取）。
  - **限界 reply**：`collab_send` / `collab_reply` 投递到受保护目标时，只有三条同时满足才放行
    ——`kind=reply`、目标是该 `bid` 的发起方（`record.from.sid`）、发送者是该单领取人
    （`record.claim.by`）；`bid` 取入参或正文里的 `b_…`。放行时强制 `queue` 并追加说明；
    `request` / `note` / `steer` 与其他来源仍 fail-closed，`BUILTIN_PROTECT` 名单不变。
  - 新增 `receiptMode` 字段（只增不改）；旧记录缺省视为 `push`，行为与文案不变。
  - **自动提取扩面（R7）**：租约到期后的只读提取不再限定 `claim.kind = spawn`，`accept` / `handoff`
    领取的单同样在**发起方**那次刷新里从承接方最后一条回答收口（仍只读最后一条、仍只有发起方能触发、
    受保护承接方不读）；结论词表补「回执被硬拒 / 无法投递 / 改回写提案 / 已自愈 / 无需改动」→ `blocked`，
    `done` 判定不变。此前这类单没有推送回执就只能一直挂着。
  - **`acked` 静默收口（R8）**：`acked` 没有租约路径，回执丢失时会永远停在 `acked`。现在静默超过
    `ACKED_EXTRACT_MS`（2h）后，发起方的刷新按同一套规则只读提取（仍只读最后一条、仍只有发起方能触发、
    受保护承接方不读）；判不出结论时**状态不变**（不降级、不 `attempts++`），只写 `staleNoticedAt`，
    每个窗口最多读一次。`collab_list` 对这类单额外标「静默=Nh 可自动提取」。
  - 回归：`test/handoff-harness.mjs` 新增 S69 共 23 项（pull 文案 / 字段落盘 / pull 提取闭环 /
    reply 白名单正反例 / 提醒文案）、S70 共 6 项（accept/handoff 收口 / 无结论走原顺延 /
    受保护承接方不读不闭环 / 旁观者不闭环）与 S71 共 6 项（acked 2h+ 收口 / 无结论保持不变且
    每窗口只读一次 / 1h 不读 / 旁观者不读 / protected 不读）。
  - 复核收尾：限界 reply 对**已闭环**（`done`/`blocked`/`expired`）的单不再放行；`acked` 提取要求
    `claim.at > 0`（缺失时 `since=0` 会把很久以前的回答当结论）；回归 +3 项（共 310）。

## [0.1.1] - 2026-11-17

- 包可见性改为 public（`publishConfig.access`）
- 新增 `skills/collab/SKILL.md`（随包分发）与 CI frontmatter 校验

## [0.1.0] - 2026-11-17

首个版本：`@inf-studio/collab` 由仓库内单文件插件 `.opencode/plugins/collab.js`
迁移为独立 TS 包。工具签名、文案、状态机、存储键与 `bid` 算法保持不变。

### Added

- 十个原生工具：`collab_list` / `collab_inbox` / `collab_wait` / `collab_send` /
  `collab_reply` / `collab_handoff` / `collab_broadcast` / `collab_accept` /
  `collab_grant` / `collab_promote`。
- `context` hook：未读消息与未闭环交接各注入一次（去重，≤ `maxInject` 条）。
- 跨工作区交接链路：确定性打分（0–100 + `why`）、原子领取（`<bid>.lock`）、
  5 分钟问询租约与顺延、`DECLINE <bid>`、租约到期的只读自动闭环。
- 会话级权限补丁（`collab_grant`）与 agent 切换（`collab_promote`），共用一份
  `collab-grants/<sid>.json` 台账（两半互不覆盖，`revoke` / `revert` 各清一半）。
- 模块结构：`src/core`（storage / claim / score / verdict / lineage / grants）、
  `src/tools`、`src/hooks`、`src/config.ts`、`src/index.ts`。
- `test/handoff-harness.mjs`（279 项：单文件版的 274 项 + S68）、
  `test/readonly-default.mjs`（12 项只读默认/护栏）与
  `scripts/parity-single-file.mjs`（16 项双轨对比：十个工具的契约 + 五个预览输出逐字一致；
  单文件版退役后自动跳过）。

### Changed

- 插件 `options` 新增 `allowWrite`（默认 `false`）：新装包默认**只读**，不修改任何
  会话的 permissions / agent；消息、回执、收发、打分全部可用。单文件版无此开关
  （其行为等价于 `allowWrite:true`）。

### Fixed

- `collab_grant` 预览在台账**只有 promote 半段**（有 `agentBefore`、无 permissions
  快照）时崩溃：`TypeError: … reading 'join'`。现在按「无授权记录」报告，并说明
  确认授权时会补写 grant 半段、两半共存（回归用例 S68）。

### Notes

- 运行时零第三方依赖；`@opencode/plugin` 由宿主提供，`@opencode/client` 仅 `import type`。
- 存储格式与单文件版一致（`collab/*` 键、`~/.config/opencode/collab-broadcast/`、
  `collab-grants/`），切换加载方式无需迁移数据。
