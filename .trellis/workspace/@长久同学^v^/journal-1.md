# Journal - @长久同学^v^ (Part 1)

> AI development session journal
> Started: 2026-11-17

---


## 2026-11-21 · 0.9.x 复盘/看板/收尾（3/3）

- 复盘三份 `docs/issues/`：协议取舍、rebuild 丢 metrics、上游 #63990（64788 已作为重复关闭）。
- 看板：列表徽标（◇/◐/◑n/●，不新增行）+ 契约详情（GUI+TUI）；无契约与 0.9.6 逐字节一致。
- 收尾：`rebuild` 从 jsonl + pacing 计数重算 metrics；`sinceDays` 只裁剪投影（0 = 不限）；
  pacing 测试改为前后快照，插件运行时不再误红。
- 回归 1801 项 / 28 工具 / 版本仍 0.9.6。

### 更正（归档任务只读，记录在此）

- `11-21-collab-0p9-close/implement.md` 的 F7 写「mac 未安装」，**检查位置有误**：
  CLI 用缓存式安装，包在 `~/.cache/opencode/npm/@inf-studio/collab@0.9.6`（2026-11-20 22:02 已装），
  `~/.config/opencode/node_modules` 本来就不会有。mac 只需**重启 Desktop** 即生效。

## 2026-11-21 · 0.10.0-rc.1 发布

- 内容：看板契约（徽标+详情）、人类决策清单（`collab_decision_inbox`）、`collab_index metrics`、收尾修复。
- `publish.yml` 改为：版本带 `-` → dist-tag `next`；稳定版仍 `latest`。实测 `latest: 0.9.6` / `next: 0.10.0-rc.1`。
- CI：`44853279670` success。
- Linux：`collab:active:v0.10.0-rc.1`；实机验证 `collab_decision_inbox`（无待决策、不建目录）与
  `collab_index metrics`（11-20: 9 条/gap 210s；11-21: 20 条/gap 220s）。
- mac：配置与 `~/.cache/opencode/npm/@inf-studio/collab@0.10.0-rc.1` 均就位，**待重启 Desktop**。
- 待补：满 24h（22:03 后）的指标对比表；mac 重启后 4 条核验。

## 2026-11-22 · 0.10.0-rc.2（三计数 + 5 条遗留修复）

- 内容：`metrics` 三计数（raw/kept/delivered，全量埋点 7 个直投点）+ F3/F4/F5/emoji/mtime 五条修复。
- 口径：全量日 `raw = kept + noop`、`raw ≥ kept ≥ msg_count`；升级当天为部分计数（历史不回填）。
- CI：`45022043527` success；dist-tags `latest: 0.9.6` / `next: 0.10.0-rc.2`。
- Linux：`collab:active:v0.10.0-rc.2`；实机 rebuild 39ms，`metrics 覆盖 2026-11-20–2026-11-22（3 天）`，
  历史三天的 raw/kept 显示 `-`（旧 counters 无字段，预期）。
- mac：配置与 `~/.cache/opencode/npm/@inf-studio/collab@0.10.0-rc.2` 就位，**待重启 Desktop**。
- 待办：mac 重启后 4 条核验；正式版 0.10.0 观察后发布；每日 22:05 cron 持续采集。
