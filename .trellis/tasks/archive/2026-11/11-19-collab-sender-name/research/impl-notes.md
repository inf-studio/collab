# 实施记录：注入头带发出方会话名（0.8.0 `sender-name`）

任务：`.trellis/tasks/11-19-collab-sender-name`（父：`11-19-collab-board2`）
基线（开工时，未改任何文件）：`870 + 12 + 20 + 50 + 56 + 47 + 34`，`pnpm build && pnpm typecheck` 全绿。

---

## 1. 与 design.md 的偏差（**重要**）

design.md 写「拼装在 `src/core/verdict.ts`（`inboundHeader`）与 `src/index.ts` 的 context 注入调用处」，
但仓库里**没有** `inboundHeader`，context hook 也不拼注入头。实际的入站头是：

| 环节 | 文件 | 说明 |
| --- | --- | --- |
| 信封拼装 | `src/ids.ts` → `envelope()` | `[collab:<from>][<kind>:<threadID>] <body>`，5 个调用点共用 |
| 机读解析 | `src/constants.ts` → `COLLAB_ENVELOPE_RE` / `COLLAB_PREFIX_RE` | `normalizeText` / `parseEnvelope` / `extractInbound` |
| ① `collab_send` / `collab_reply` | `src/tools/shared.ts` → `dispatch()` | request / reply / note / steer 全在这里 |
| ② 接管请求 | `src/tools/shared.ts` → `deliverAsk()` | handoff / wake / resend 的首投 |
| ③ 重发 | `src/core/chain.ts` → `resendOnce()` | 同 `cid` 的第二次投递 |
| ④ ACCEPT / DECLINE note | `src/core/chain.ts` → `notifyRequester()` | 承接方 → 发起方 |
| ⑤ 缺陷自上报 | `src/core/report.ts` → `envelope({from:'collab-report'})` | **故意不改**：发送方是伪会话，见 §6 |

所以实现落在 `ids.ts` / `constants.ts` / `verdict.ts`（新增 `senderName`）/ `tools/shared.ts` /
`core/chain.ts`，**没有**动 `src/index.ts`（那里没有拼装点）。允许文件清单里的
`src/core/verdict.ts` 用于放 `senderName` + 缓存（design §1 的位置），其余为达成同一需求的必要落点。

## 2. 实现

### `src/core/verdict.ts`（新增，design §1）

```ts
export const SENDER_NAME_TTL_MS = 10 * 60_000;
export const SENDER_NAME_CHARS = 20;

export function senderNameOf(title) {            // 一行化 + `]`→`）` + truncate(…, 20)
  return text ? truncate(text, SENDER_NAME_CHARS) : '';
}

const senderNameCache = new Map<string, { name: string; at: number }>();

export async function senderName(ctx, sessionID, now = Date.now()) {
  // 命中且 < 10min → 直接返回
  // ctx.session.get 缺失 / 抛错 → ''（**不缓存**，下次重试）
  // 成功 → 缓存（title 为空也缓存 ''，与 design 的 label 语义一致）
}
```

命名：仓库里已有 `senderLabel`（`tools/shared.ts`，别名/shortID，同步）。新函数叫 `senderName` 避免同名二义。

### `src/ids.ts`

- `envelope({ from, name?, kind, threadID, body })`：`name` 非空 → `[<name>]` 前置；空 → **逐字等于**旧串。
- `parseEnvelope()` 返回新增 `name`，分组下标随正则改为 `1=name, 2=from, 3=kind, 4=threadID`。

### `src/constants.ts`

- `COLLAB_PREFIX_RE` / `COLLAB_ENVELOPE_RE` 增加**可选前置名称段**：
  `^(?:\[([^\]]*)\])?\[collab:([^\]]*)\]…`。旧文本（无名称）回溯后仍从头匹配，`from` 仍是箱位 2；
  名称段含 `[` 也能解析（`]` 已被替换掉，不会提前闭合）。

### 调用点

| 位置 | 取谁的标题 |
| --- | --- |
| `dispatch()` | `context.sessionID`（发送方） |
| `deliverAsk()` | `record.from.sid`（发起方） |
| `resendOnce()` | `record.from.sid` |
| `notifyRequester()` | `record.claim.by`（承接方 = 真正的发送者） |

`ackSeen()`（`[ack] <cid> seen`）**不加名称**：它是机器噪声，`isAckText` 依赖 `[ack]` 在正文首字符，
且它本来就不进注入（`hooks/context.ts` 过滤）。

## 3. 四类 kind 实测头（S107，`test/handoff-harness.mjs`）

```
request  [S107 发起方会话][collab:ses_s107…07me][request:t_mwnidvrt_w5zt] S107 request 正文
reply    [S107 发起方会话][collab:ses_s107…07me][reply:t_mwnidvrt_w5zt] S107 reply 正文
note     [S107 发起方会话][collab:ses_s107…07me][note:t_mwnidvrt_w5zt] S107 note 正文
steer    [S107 发起方会话][collab:ses_s107…07me][request:t_mwnidvrw_icc6] S107 steer 正文   (delivery=steer)
接管请求  [S107 发起方会话][collab:ses_s107…07me][request:t_mwnidvry_5cnu] 你是承接方（bid=… / thread=…）
ACCEPT   [S107 对端][collab:ses_s107…07to][note] ACCEPT b_1070000000000001 —— ses_s107…07to 已领取 …（local，implement）。…
```

`metadata.collab.from` 仍是短 id（`ses_s107…07me`）——机读字段未变，只有正文头多一段前缀。

## 4. 边界用例（实测）

| 用例 | 实测头 |
| --- | --- |
| 标题 >20 字（23 字） | `[一二三四五六七八九十甲乙丙丁戊己庚辛壬…][collab:ses_s107…long][note:t_…] …`（前 19 字 + `…`） |
| 标题含 `]`（`S107 [WIP] 标题`） | `[S107 [WIP） 标题][collab:ses_s107…7brk][note:t_…] S107 括号标题正文` |
| 宿主读不到发送方（`session.get` 抛错） | `[collab:ses_s107…host][note:t_…] S107 宿主读不到正文`（与旧格式逐字一致） |
| 标题为空串 | `[collab:ses_s107…mpty][note:t_…] S107 空标题正文`（逐字一致） |
| 带标题的入站信封解析 | 注入行 `- reply   t_s107parse from=ses_s107to: S107 带回执 → 用 collab_wait …`，标题**不**进入注入行 |

## 5. 缓存计数（假宿主 `session.get` 计数）

`test/handoff-harness.mjs` 的假 `ctx.session.get` 现在记录每次 `sessionID`（`sessionGets`）。

| 断言 | 结果 |
| --- | --- |
| 四类 kind 共 4 次投递（request/reply/note/steer）→ 发送方 `get` 次数 | **1**（`gets=1`） |
| 同一 sid 两轮注入（`S107 缓存第一轮` / `第二轮`） | **1**（`gets=1`，缓存命中第二轮） |
| 读不到标题的 sid 不缓存 | 下一次仍会 `get`（未做「命中空值」计数断言；行为由「成功才缓存」分支保证） |

## 6. 未改动（有意）

- `src/core/report.ts`（`[collab:collab-report][note] [defect] …`）：发送方是伪会话 `collab-report`，
  写它的标题会把「上报方会话标题」挂在维护者的注入头上、与 `from=collab-report` 冲突；PRD R3 只要求
  request / reply / note / steer 这一套。
- `ackSeen()` 的 `[ack]` note（理由见 §2）。
- `collab_list` / `collab_status` / 看板 / TUI / GUI：一行未改。
- 版本号：`package.json` 仍 `0.7.0`（0.8.0 由父任务发版）。

## 7. 变异验证（原始输出）

### 变异 1：去掉缓存读取（`verdict.ts`）

```ts
  if (false && hit && now - hit.at < SENDER_NAME_TTL_MS) return hit.name; // MUTANT-1: no cache read
```

```
$ node test/handoff-harness.mjs        # exit=1
  ✗ S107 四类 kind 共 4 次投递：发送方 session.get 只 1 次（缓存跨 kind / mode） — gets=4
  ✗ S107 同一 sid 两轮注入：宿主 session.get 只调用一次（10 分钟缓存） — gets=2
=== 881/883 checks passed
```

### 变异 2：名称放到 id 之后（`ids.ts`）

```ts
  return `[collab:${from}]${tag}${label ? `[${label}]` : ''} ${body}`; // MUTANT-2: name after the id
```

```
$ node test/handoff-harness.mjs        # exit=1
  ✗ S99 following the header command really closes the hand-off (state=done) — state=acked / reply=已投递 …
  ✗ S99 the BLOCKED variant closes the next hand-off as blocked — state=acked
  ✗ S100 C closes the bid by answering A directly (2 hops, no forwarder) — {"state":"acked"}
  ✗ S105 不传 blocked：投递正文 = 信封（标题 + 机器头）+ 正文，零追加行 — [collab:ses_s105…05me][note:t_s105plain][S105 发起方] …
  ✗ S107 request 头：… — [collab:ses_s107…07me][request:t_mwnieoiq_sem8][S107 发起方会话] S107 request 正文
  ✗ S107 reply 头：… — [collab:ses_s107…07me][reply:…][S107 发起方会话] …
  ✗ S107 note 头：… — …
  ✗ S107 steer 投递：… — steer / [collab:ses_s107…07me][request:…][S107 发起方会话] …
  ✗ S107 接管请求头：… — …
  ✗ S107 ACCEPT note 头：… — [collab:ses_s107…07to][note][S107 对端] ACCEPT …
  ✗ S107 标题 >20 字 → 前 19 字 + `…` — …
  ✗ S107 标题含 `]` → 替换为 `）`，机器头 `[collab:…]` 不受影响 — …
  ✗ S107 同一 sid 两轮注入：宿主 session.get 只调用一次（10 分钟缓存） — gets=1
=== 870/883 checks passed
```

两点值得记：
1. 变异 2 连 **S99 / S100 的闭环**都挂了 —— 名称放到 id 之后时，接收侧 `COLLAB_ENVELOPE_RE` 仍然能解析
   （前置段不是 `[collab:`），但回执正文的 `[handoff]` 行被挤到信封里，`extractInbound` 取到的 body 变了，
   回执不再闭环。这正好证明「名称必须在最前、且不影响 body」。
2. 变异 2 下「标题 >20 字」失败在**名称位置**而不是截断，说明两条断言互相独立。

### 变异 3：不截断（`SENDER_NAME_CHARS = 40`）

```
  ✗ S107 标题 >20 字 → 前 19 字 + `…` — [一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅][collab:ses_s107…long][note:t_…
=== 882/883 checks passed
```

### 变异 4：不替换 `]`（去掉 `.replace(/\]/g,'）')`）

```
  ✗ S107 标题含 `]` → 替换为 `）`，机器头 `[collab:…]` 不受影响 — [S107 [WIP] 标题][collab:ses_s107…7brk][note:t_…
=== 882/883 checks passed
```

（这一条不只是「显示难看」：名称里的裸 `]` 会让 `COLLAB_ENVELOPE_RE` 前置段提前闭合、整体匹配失败，
接收侧只剩 metadata 可用 —— 所以 `]`→`）` 是机读要求，不是审美。）

变异均已 `cp` 还原（`verdict.ts` / `ids.ts`），还原后重跑 883/883。

## 8. 验收

```
$ pnpm build && pnpm typecheck          # 0 错
$ pnpm test
=== 883/883 checks passed        (基线 870，+13)
=== 12/12 checks passed
=== 20/20 board checks passed
=== 50/50 checks passed
=== 56/56 checks passed
=== 47/47 checks passed
=== 34/34 panel checks passed
$ node scripts/check-skill.mjs
skills ok
```

工具数仍 22（未新增/删除工具）。版本号未改。

## 9. 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/core/verdict.ts` | 新增 `SENDER_NAME_TTL_MS` / `SENDER_NAME_CHARS` / `senderNameOf` / `senderName`（10 分钟按 sid 缓存，成功才缓存） |
| `src/ids.ts` | `envelope()` 增加可选 `name`；`parseEnvelope()` 返回 `name`、分组下标随正则调整 |
| `src/constants.ts` | `COLLAB_PREFIX_RE` / `COLLAB_ENVELOPE_RE` 容忍可选前置名称段 |
| `src/tools/shared.ts` | `dispatch()` / `deliverAsk()` 取发送方标题并传 `name` |
| `src/core/chain.ts` | `resendOnce()` / `notifyRequester()` 同上 |
| `src/tools/send.ts` | 工具描述里的信封格式补 `[<sender title>]` |
| `test/handoff-harness.mjs` | 假宿主记录 `session.get` 调用（`sessionGets`）；S105b 断言改为新头；新增 S107（13 条） |
| `docs/collab.md` | §11.7 新增「入站注入头（0.8.0）」；三步流程表 ① 改为 `[<标题>][collab:<from>][request:<threadID>]` |
| `CHANGELOG.md` | `[Unreleased]` 新增 `sender-name` 条目（含测试 870 → 883） |
| 本文件 | `.trellis/tasks/11-19-collab-sender-name/research/impl-notes.md` |

## 10. 回滚

`git restore -- src/core/verdict.ts src/ids.ts src/constants.ts src/tools/shared.ts src/core/chain.ts src/tools/send.ts test/handoff-harness.mjs docs/collab.md CHANGELOG.md`
（无配置项、无迁移、无新增依赖。）
