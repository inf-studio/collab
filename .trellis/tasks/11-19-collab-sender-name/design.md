# 设计：注入头名称

## 1. 构造点

入站注入头的拼装在 `src/core/verdict.ts`（`inboundHeader` / 各 kind 的 prefix）与 `src/index.ts` 的 context 注入调用处。
新增 `senderLabel(ctx, sid)`：

```ts
const cache = new Map<string, { label: string; at: number }>();
async function senderLabel(ctx, sid) {
  const hit = cache.get(sid);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.label;
  try {
    const info = await ctx.session.get({ sessionID: sid });
    const title = String(info?.title ?? '').trim();
    const label = title ? truncate(title, 20) : '';
    cache.set(sid, { label, at: Date.now() });
    return label;
  } catch { return ''; }   // 取不到 → 空，不缓存失败（下次再试）
}
```

- 渲染：`label ? \`[${label}][collab:${short}]\` : \`[collab:${short}]\``；
- 失败不缓存（避免宿主短暂不可用后永久无名称）。

## 2. 边界

- 只作用于入站注入头；出站正文、协议头、看板不动；
- 名称含 `]` 时替换为 `）`，避免破坏机读格式；
- 缓存容量：按 sid，无上限但会话数有限（≤数百），可接受。

## 3. 测试

| 用例 | 期望 |
| --- | --- |
| 四类 kind | 头形如 `[标题][collab:ses_…][request:t_…]` |
| 长标题 | 20 字 + `…` |
| 取不到 | 与旧格式逐字一致 |
| 缓存 | 两轮只查一次（假宿主计数） |
| 解析兼容 | 既有 `[collab:ses_…]` 正则断言全绿 |

变异：去掉缓存 → 计数断言失败；名称放 id 后 → 格式断言失败。

## 4. 回滚

`git restore -- src/core/verdict.ts src/index.ts`；无配置项。
