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
