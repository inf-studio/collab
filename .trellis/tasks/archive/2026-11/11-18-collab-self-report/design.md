# 设计：缺陷自上报 + 挂起监控

## 1. 触发与分类

```ts
type DefectClass =
  | 'uncaught'        // 未捕获异常 / TypeError
  | 'invariant'       // 状态机不变量失败（如 done 记录被改写）
  | 'guard-conflict'  // 指令要求做被护栏禁止的事（如 protected 回执）
  | 'delivery-5xx'    // prompt/inbox 接口 5xx
  | 'extract-error'   // 提取/解析异常
```

- 用 `withReport(toolName, fn)` 包裹各工具 `execute`：捕获 `DefectClass` 白名单内的错误 → 上报后**原样抛出**
  （不吞错、不改返回）。
- 参数校验错误用显式 `ValidationError` 标记，`withReport` 直接放行不报。

## 2. 证据（脱敏白名单）

```jsonc
{
  "signature": "d_<hash16>",
  "version": "0.1.2",
  "tool": "collab_send",
  "class": "guard-conflict",
  "error": { "name": "Error", "message": "…", "stackTop": ["at …"] },
  "context": { "bid": "b_…", "thread": "t_…", "from": "ses_…", "claimBy": "ses_…" },
  "workspace": "/data/project/x",
  "record": { "state": "acked", "attempts": 0, "receiptMode": "push" },
  "at": 0
}
```

- `error.message` 截断 2KB；`stackTop` 只留前 5 帧；
- **禁止**字段：消息正文、文件内容、token、完整 session 列表；
- session id 用短 id（`ses_xxxx…yyyy`）。

## 3. 落盘与去重

```
~/.config/opencode/collab-reports/
  index.json                      # { signature: lastAt }
  <signature>/<ts>.json           # 证据
  <signature>/<ts>.md             # issue 草稿（现象/复现/证据/影响/版本）
```

- 写 `index.json` 用 `tmp + rename`；1 小时内同 signature 直接返回；
- 目录可用 `COLLAB_REPORT_DIR` 覆盖（harness 用）。

## 4. 投递

```jsonc
// ~/.config/opencode/collab.json
{ "report": { "to": "collab-maintainer" } }   // alias 或 ses_id
```

- 配置存在且目标不在 protect → `collab_send { kind:"note", text:"[defect] <sig> <一句话> → <path>" }`；
- 投递失败只记日志，不影响主流程；
- 默认（未配置）只落盘。

## 5. 挂起监控

在 `collab_list` 与 `context` 注入里各输出一次（按会话去重）：

| 类别 | 条件 | 文案 |
| --- | --- | --- |
| `open-stale` | `state=open` 且 `now-createdAt > 1h` | 「无人领取，可重新广播或人工指定」 |
| `claimed-lapsed` | `state=claimed` 且超租约 | 「承接方未确认，可顺延」 |
| `acked-stale` | `state=acked` 且 `now-claim.at > 2h` | 「可自动提取收口（R8）」 |

与 R1 共用「每类每 session 只提示一次」的去重键。

## 6. 兼容与回滚

| 面 | 处理 |
| --- | --- |
| 工具返回 | 不变（旁路） |
| 存储 | 新目录 + `index.json`；不改 `collab-broadcast` |
| 失败 | 上报异常 swallow + log，不阻断 |
| 回滚 | 删目录 / 关 `report.enabled`；代码 `git restore` |

## 7. 风险

- 误报噪音：用 `DefectClass` 白名单 + signature 限流；
- 隐私：字段白名单 + 截断；
- 投递打扰：默认不投；配置才投；受保护目标不投。
