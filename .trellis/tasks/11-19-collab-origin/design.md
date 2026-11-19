# 设计：交接对接人（origin）

## 1. 数据

```ts
interface BroadcastRecord {
  /** 真正发起这条协作链的会话（转发链上游）；缺省 = 本记录 from。 */
  origin?: { sid: string; role?: 'requester' | 'implementer' | 'observer'; directory?: string };
}
```

可选字段，旧记录缺省；`normalizeBroadcast` 容忍未知/畸形值。

## 2. 入参与继承

- `collab_handoff` / `collab_broadcast` / `collab_send` 增加可选 `origin`（`ses_…` 或别名）；
- **`collab_send` 仅显式生效**（不继承）：它不写记录，且回执正文不该被追加一行指向别人；「缺省 = 本会话」在渲染上是空操作。
- **继承规则**：未显式给 `origin` 时：
  1. 若当前会话是某条**未闭环**交接的承接方（`claim.by === me`），取该记录 `origin ?? from`；
  2. 否则 = 本会话（`sid = me`，`directory = ctx.location.directory`）。
- 继承只取一层（新记录写入解析后的 `origin`），保证 C 看到的是 A。

## 3. 渲染

- 承接方注入块（`takeoverBody` 与 peer 接管块）在协议头之后加一行：
  `对接人（非本单发起方）：ses_… @ <dir>`
  —— 仅当 `origin.sid !== from.sid` 时显示（避免本单发起方自我重复）。
- receipt 模板（`[handoff] DONE|BLOCKED …` 回执指引）同字段；发给 `origin.sid` 的同一条回执行按
  `kind=reply` 投递、可闭环本单（只放开 `from.sid` / `origin.sid` 两个目标；受保护投递规则不变）；
- `collab_status` 输出 `origin=`；`collab_list` 行尾 `via ses_…`（仅当 origin 存在且不同于 from）。

## 4. 兼容

- 无 origin：输出与 0.6.0 逐字一致；
- 别名解析失败 → 可读拒绝，不写记录；
- origin 指向 protected 会话：仅作为展示字段，不产生投递。

## 5. 测试

| 用例 | 期望 |
| --- | --- |
| A→B 显式 origin=A（自称链头） | 与首跳等价：**不落盘、不渲染**（§3 只对 `origin ≠ from` 显示） |
| B→C 不填 origin，B 是 A 单的承接方 | C 记录 origin=A（继承），注入含 A |
| B→C 显式 origin=B | 记录 origin=B（覆盖继承） |
| 旧记录（无 origin） | 输出无对接人行，逐字同 0.6.0 |
| origin 别名不存在 | 可读拒绝、0 写入 |
| status | 显示 `origin=` |

## 6. 回滚

`git restore -- src/core/claim.ts src/core/verdict.ts src/tools/{handoff,broadcast,send,status,list,shared}.ts`；旧记录不受影响。
