# collab 使用 skill（随包分发 + 全局软链）

> 目标：让 agent 在**需要协作时按需加载**操作方法，而不是把长表格塞进全局 `AGENTS.md` 长期占用上下文。

## 背景

- 插件已独立为 `@inf-studio/collab`（GitHub Packages，`0.1.0`），提供 10 个 `collab_*` 工具与一条
  「广播 → 打分 → 原子领取 → 回执」的交接链路。
- 全局 `AGENTS.md` 已有 C1–C4 规则（何时用、硬约束、已知坑、与 Trellis 对接），但缺少**可执行的操作细节**。
- 现有 `docs/collab.md` 与 `.trellis/spec/guides/cross-workspace-collab-guide.md` 面向人类/长文档，
  agent 需要一份短、可扫读、带命令与模板的手册。

## Requirements

- **R1 位置**：源码在包仓 `skills/collab/SKILL.md`（随仓库分发、随版本走）；本机软链到
  `~/.config/opencode/skills/collab` 使其对所有工作区可用。
- **R2 格式**：YAML frontmatter（`name` + `description`，含触发场景关键词），正文简体中文、代码/标识符保英文。
- **R3 内容**（只写操作必需，不复述长文档）：
  1. 何时用 / 何时不用；
  2. 10 个工具速查（读/写、默认 `queue`、`allowWrite` 影响）；
  3. local 与 peer 两套三步交接 + 交接包模板；
  4. 排障清单：scope 大小写、`location.directory`、`allowWrite:false`、热重载、重复插件 id、租约 5min；
  5. 硬约束：protected 及子会话、不删会话、跨仓只写 `docs/issues`、默认不打断；
  6. 安装/升级与版本对齐。
- **R4 可验证**：frontmatter 可解析；软链指向真实文件；`git status` 只含预期文件。

## Acceptance Criteria

- [ ] `skills/collab/SKILL.md` 存在，frontmatter 含 `name: collab` 与可检索的 description
- [ ] 正文覆盖 R3 六块，且**不复制** `docs/collab.md` 的大表格
- [ ] `~/.config/opencode/skills/collab` 是指向该目录的软链，`readlink -f` 落在包仓内
- [ ] `git status` 仅包含 `skills/` 与任务目录；提交信息符合 Conventional Commits
- [ ] 不新增运行时依赖、不改插件代码

## 边界

- 不改 `src/`、`test/`、发布 workflow。
- 不把 skill 内容同步进全局 `AGENTS.md`（避免双份漂移）；必要时只在 AGENTS 加一行指针。
