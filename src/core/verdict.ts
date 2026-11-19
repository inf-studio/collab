import { VERDICT_MESSAGE_LIMIT, VERDICT_NOTE_LIMIT, BCAST_LEASE_MS } from '../constants.ts';
import { invalid } from './errors.ts';
import { normalizeThreadID } from '../ids.ts';
import type {
  BlockedSpec,
  BroadcastBlocked,
  BroadcastDecision,
  BroadcastOrigin,
  BroadcastRecord,
  DecisionSpec,
  JsonObject,
  SessionMessageLike
} from '../types.ts';
import { asObject, shortID, truncate, truncateRaw } from '../util.ts';

/**
 * Receipt line, written by the session that took the hand-off:
 *   `[handoff] DONE <提案路径|bid|thread> <commit sha 或摘要>`
 *   `[handoff] BLOCKED <…> <原因>`
 * The third field is free text.
 *
 * R5 (0.1.4): the line must **start a line** (`/^[ \t]*\[handoff\] …/m`). The
 * takeover prompt itself carries `[handoff] DONE <bid> <摘要>`, and any-position
 * matching let a quotation / a discussion in the middle of an answer close a
 * hand-off. A receipt is a line of its own — prose that merely mentions the
 * format is not one.
 */
const HANDOFF_RECEIPT_RE = /^[ \t]*\[handoff\][ \t]+(DONE|BLOCKED)[ \t]+(\S+)[ \t]*([^\n]*)/im;
/** An explicit refusal from the currently asked candidate. */
export const HANDOFF_DECLINE_RE = /\bDECLINE\b/i;
/** A `bid` written inside the DECLINE text, so several asks cannot be confused. */
export const DECLINE_BID_RE = /\b(b_[0-9a-f]{8,32})\b/;

export interface Receipt {
  state: 'done' | 'blocked';
  target: string;
  note: string;
}

/**
 * Parse a receipt line out of an inbound message (the push path).
 *
 * R6 (0.1.4): the push side now reuses the pull-side guards
 * (`verdictFromTexts`) instead of trusting the raw regex:
 *   - a `<…>` placeholder in the target or anywhere in the summary slot is the
 *     template itself (`<bid>` / `<摘要>` / `<原因>`), never a receipt;
 *   - negation / promise wording on the matched **line** (`未完成` / `不会发` /
 *     `完成后我会` / `not done yet` …) means "not done" — no `done` judgement
 *     (a `BLOCKED` line *is* the negative answer already, so its reason may use
 *     those very words: `BLOCKED … 无法完成` must still close as blocked);
 *   - only the matched line is judged (never a join with neighbouring lines).
 */
export function parseReceiptLine(text: unknown): Receipt | undefined {
  const match = HANDOFF_RECEIPT_RE.exec(String(text ?? ''));
  if (!match) return undefined;
  const line = match[0];
  const target = match[2];
  const summary = match[3] ?? '';
  const state = match[1].toUpperCase() === 'DONE' ? 'done' : 'blocked';
  // A placeholder target (`<bid>`) or any `<…>` left in the summary slot is the
  // template (or an echo of it) — exactly the pull-side H1 rule.
  if (VERDICT_PLACEHOLDER_RE.test(target) || VERDICT_ECHO_RE.test(summary)) return undefined;
  if (state === 'done' && (VERDICT_NEGATION_RE.test(line) || VERDICT_PENDING_RE.test(line))) return undefined;
  return { state, target, note: truncateRaw(summary, 500) };
}

/**
 * Which record a receipt line refers to. Only exact identifiers count
 * (`bid` / `threadID` / the full `issuePath`) — a bare file name is ambiguous
 * as soon as two workspaces carry `docs/issues/fix-x.md`, and matching it
 * closed the wrong hand-off. Cross-workspace safety comes from
 * `claim.by === from`, see `receiptAllowed`.
 */
export function receiptMatches(record: BroadcastRecord, target: unknown): boolean {
  const value = String(target ?? '')
    .trim()
    .replace(/^\.\//, '');
  if (!value) return false;
  if (value === record.bid) return true;
  if (record.threadID && value === record.threadID) return true;
  const issue = String(record.issuePath ?? '').replace(/^\.\//, '');
  return Boolean(issue) && value === issue;
}

/** Only the session that actually claimed the hand-off may close it. */
export function receiptAllowed(record: BroadcastRecord | undefined, from: unknown): boolean {
  const claimant = String(record?.claim?.by ?? '');
  return Boolean(claimant) && Boolean(from) && claimant === String(from);
}

// ------------------------------------------- broadcast: lease auto-receipt (R2)

/**
 * Explicit receipt written *inside* the counterpart's own answer — the pilot
 * showed an `explore` session writing exactly this line and never sending it,
 * so this is the strongest signal a read-only extraction can get.
 *
 * H1 (review): the very same line is part of the R1 prompt, so an echo of the
 * template must never count. A mention is only trusted when the token right
 * after DONE/BLOCKED is the *current* bid — see `verdictFromTexts`.
 */
const HANDOFF_VERDICT_RE = /\[handoff\][ \t]*(DONE|BLOCKED)\b([^\n]*)/i;
/** A `[handoff] BLOCKED <bid> …` line still carries the bid; it is not the summary. */
const VERDICT_BID_RE = /^b_[0-9a-f]{8,32}\b\s*/i;
/** `<bid>` / `<摘要>` / `<原因>` — the template placeholders are not a target (H1). */
const VERDICT_PLACEHOLDER_RE = /^<[^>]*>$/;
/**
 * H1 (round 2): any `<…>` token **anywhere** in the summary slot is a leftover
 * template placeholder, not a receipt. Exact matching was not enough — echoing
 * the R1 command verbatim leaves `", confirm:true}` / backticks / `（以上是示例）`
 * right after `<摘要>`, and that used to be closed as a real verdict.
 */
const VERDICT_ECHO_RE = /<[^>]{0,32}>/;
/**
 * H1 negation guard: an answer that says it did *not* finish is never a verdict,
 * even when it also quotes the requested receipt format.
 */
const VERDICT_NEGATION_RE =
  /不会|未完成|没有完成|没完成|尚未|无法完成|不能完成|做不到|还没|未开始|not\s+(?:yet\s+)?done|not\s+yet|haven'?t|did\s+not|didn'?t|unfinished|incomplete/i;
/**
 * H1 (second half): promise / plan wording describes what the session *will*
 * do, not what it did. Ambiguous → no verdict.
 */
const VERDICT_PENDING_RE =
  /完成后|完之后|之后(?:我)?会|稍后|接下来|待(?:我|确认|环境)|先(?:确认|看|核对)|打算|计划|将会|将要|我会(?:按|先|发|在|照)/i;
/**
 * Strong "no work needed" wording → `blocked`. Checked *before* the generic DONE
 * words, because 「已完成/已修复」 must never be read as "implemented".
 *
 * R7: real answers also close a hand-off by saying the receipt was refused and
 * the proposal was updated instead (`回执被硬拒` / `无法投递` / `改回写提案`), or
 * that the symptom healed itself (`已自愈` / `无需改动`). None of these contain a
 * negation or a promise, so they are safe to read as `blocked` (with the answer
 * as the reason). A `[handoff] DONE|BLOCKED <bid>` line still wins over them.
 */
const BLOCKED_VERDICT_RE =
  /已实施|已修复|无需|不需要|已完成|回执被[^。\n]{0,20}拒|无法投递|改回写提案|回写提案|已自愈|不需要改|无需改动|not needed|already/i;
/** Generic completion wording → `done` (only the last answer is judged on this). */
const DONE_VERDICT_RE = /完成|done|fixed/i;
/**
 * …but 「分析/核对完成」 is a report *about* the reading, not a finished task.
 * These phrases are removed before the generic DONE words are tested.
 */
const ANALYSIS_DONE_RE =
  /(?:分析|核对|排查|调研|审阅|查看|阅读)(?:已|都)?完成|完成(?:了)?(?:分析|核对|排查|调研|审阅|查看|阅读)/g;

export function flattenText(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whitespace-collapsed and capped — the only piece of the answer that gets stored. */
export function verdictNote(text: unknown): string {
  return flattenText(text).slice(0, VERDICT_NOTE_LIMIT);
}

/** The text blocks of one assistant message (`content[]`, `parts[]`, or a bare `text`). */
export function assistantText(message: SessionMessageLike | undefined): string {
  const blocks = Array.isArray(message?.content) ? message.content : Array.isArray(message?.parts) ? message.parts : [];
  const texts: string[] = [];
  for (const block of blocks) {
    if (typeof block === 'string') texts.push(block);
    else if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }
  if (!texts.length && typeof message?.text === 'string') texts.push(message.text);
  return flattenText(texts.join(' '));
}

/**
 * Assistant answers of a message list, oldest → newest, capped to the trailing
 * `VERDICT_MESSAGE_LIMIT`. `since` drops messages written before the claim, so an
 * unrelated "完成了" from last week's work cannot close the hand-off.
 */
export function assistantTexts(messages: unknown, { since = 0 }: { since?: number } = {}): string[] {
  const list = (Array.isArray(messages) ? messages : []) as SessionMessageLike[];
  return list
    .filter(message => {
      const role = String(message?.type ?? message?.role ?? '');
      if (role !== 'assistant') return false;
      const at = Number(message?.time?.created ?? message?.time?.completed ?? 0);
      return !since || !at || at >= since;
    })
    .map(assistantText)
    .filter(Boolean)
    .slice(-VERDICT_MESSAGE_LIMIT);
}

export interface Verdict {
  state: 'done' | 'blocked';
  summary: string;
}

/**
 * Verdict of one session's answers, or `undefined` when it cannot be judged:
 *   - only the **last** answer with real text is judged (H1) — never a join and
 *     never a scan-back, so an echoed template from an earlier turn cannot
 *     outvote the actual answer;
 *   - a `[handoff] DONE|BLOCKED …` line counts only when its target is the
 *     current `bid`; a placeholder (`<bid>`) or another bid means the text is an
 *     echo / another hand-off → `undefined` (H1); the same holds when the summary
 *     slot still contains a `<…>` placeholder anywhere (verbatim echo of R1);
 *   - negation (`未完成` / `无法完成` / `not done yet` …) and promise wording
 *     (「完成后我会发…」) → `undefined` (H1);
 *   - otherwise the same answer is keyword-checked (blocked words first);
 *   - anything else is "not decided" — the caller keeps the old lease logic, so a
 *     wrong guess can never close a hand-off that is still open (R2/R3).
 */
export function verdictFromTexts(texts: string[] | undefined, { bid }: { bid?: string } = {}): Verdict | undefined {
  const list = Array.isArray(texts) ? texts.filter(Boolean) : [];
  if (!list.length) return undefined;
  const last = list[list.length - 1];
  if (VERDICT_NEGATION_RE.test(last) || VERDICT_PENDING_RE.test(last)) return undefined;
  const wanted = String(bid ?? '')
    .trim()
    .toLowerCase();
  const mentions = [...last.matchAll(new RegExp(HANDOFF_VERDICT_RE.source, 'gi'))];
  if (mentions.length) {
    if (!wanted) return undefined; // a receipt line is never trusted without the current bid
    for (const mention of mentions) {
      const rest = flattenText(mention[2]);
      const target = (/^[`"'“「]?([^\s`"'”」,，。.:：;；]+)/.exec(rest)?.[1] ?? '')
        .replace(/[.,:;，。：；、)\]}】`'"]+$/, '')
        .toLowerCase();
      // Placeholder, missing or foreign target → this mention is not our receipt.
      if (!target || VERDICT_PLACEHOLDER_RE.test(target) || target !== wanted) continue;
      const state = mention[1].toUpperCase() === 'DONE' ? 'done' : 'blocked';
      const summary = rest
        .replace(/^[`"'“「]/, '')
        .replace(VERDICT_BID_RE, '')
        .replace(/^[`"'”」]/, '')
        .trim();
      // Any `<…>` left in the summary slot = the template itself (echo), not an answer (H1).
      if (VERDICT_ECHO_RE.test(summary)) continue;
      return { state, summary: verdictNote(summary || mention[1].toUpperCase()) };
    }
    // The answer *mentions* a receipt line, but none for this bid: echo or a
    // different hand-off. Do not fall through to the keywords (H1).
    return undefined;
  }
  if (BLOCKED_VERDICT_RE.test(last)) return { state: 'blocked', summary: verdictNote(last) };
  // A 「分析完成」 report is not a finished hand-off: strip those phrases first.
  const claim = last.replace(ANALYSIS_DONE_RE, '');
  if (DONE_VERDICT_RE.test(claim)) return { state: 'done', summary: verdictNote(last) };
  return undefined;
}

/**
 * 0.7.0 (R2): the receiving-side protocol header — the first lines of every
 * hand-off block, so a session knows it is the claimant and how to answer
 * *before* it reads the task. Without it the pilot's `explore` session answered
 * in its own turn and never sent a receipt.
 *
 * **P2 (0.7.0 review): the advertised command must actually close the hand-off.**
 * The first version printed `collab_reply { threadID, confirm:true }` plus
 * `阻塞用 kind:"note"`, and neither works:
 *   - `collab_reply` requires `text` (a copy-paste fails with `text 不能为空`);
 *   - it has no `kind` field, and an explicit `note` is ignored as a non-receipt;
 *   - a plain-text reply closes nothing — only a `[handoff] DONE|BLOCKED <bid>`
 *     line moves the record (`applyReceipt` → `parseReceiptLine`).
 * So the header now hands out two copy-pasteable commands whose `text` already
 * carries the `[handoff]` line. Peer scope has no usable thread across
 * locations, so there the `[handoff]` line itself is the receipt (pushed with
 * `collab_send`, which the block's ①②③ steps spell out with the requester sid).
 */
export function protocolHeader({
  bid,
  threadID,
  peer = false,
  origin,
  requester
}: {
  bid?: string;
  threadID?: string;
  /** Cross-workspace: never advertise `collab_reply` (no shared thread there). */
  peer?: boolean;
  /** 0.7.0 (R3): the chain head of a forwarded hand-off (`origin ≠ from`). */
  origin?: BroadcastOrigin;
  /** `from.sid` of the record — the line is omitted when it *is* the origin. */
  requester?: string;
}): string[] {
  const id = String(bid ?? '');
  const target = id || '<bid>';
  const thread = normalizeThreadID(threadID);
  const ids = [id ? `bid=${id}` : '', thread ? `thread=${thread}` : ''].filter(Boolean).join(' / ');
  const lines = [`你是承接方（${ids || '未标注 id'}）`];
  if (thread && !peer) {
    // Local scope: `collab_reply` resolves the counterpart, but the body still
    // has to carry the `[handoff]` line — that line *is* the receipt.
    lines.push(
      `完成后回执：collab_reply { threadID:"${thread}", text:"[handoff] DONE ${target} <摘要>", confirm:true }`,
      `阻塞回执：collab_reply { threadID:"${thread}", text:"[handoff] BLOCKED ${target} <缺什么>", confirm:true }`
    );
  } else if (id) {
    lines.push(
      `完成后回执：[handoff] DONE|BLOCKED ${id} <摘要>（把这一行写进 collab_send 的 text 发给发起方，confirm:true；` +
        '阻塞写清缺什么，不要只在会话里说“完成了”）。'
    );
  } else {
    lines.push('完成后回执：把 [handoff] DONE|BLOCKED <bid> <摘要> 写进 collab_send 的 text 发给发起方。');
  }
  // 0.7.0 (R3): the chain head, when it is not this hand-off's own requester.
  // Appended — the two receipt lines above keep their exact positions (S99).
  const hint = originHint(origin, requester);
  if (hint) lines.push(hint);
  return lines;
}

/**
 * 0.7.0 (R3, `11-19-collab-origin`): `对接人（非本单发起方）：ses_… @ <dir>`.
 *
 * The real chain `A → B → C` used to hide A in prose: C's record could only say
 * `from = B`, so a blocked C went back to B, B forwarded to A, A answered in
 * another thread — 4 hops for a 2-hop question. The line is emitted **only when
 * the origin really differs from `from.sid`**, which is what keeps every
 * pre-0.7.0 record (no `origin`) byte for byte identical.
 */
export function originHint(origin: BroadcastOrigin | undefined, requester: string | undefined): string | undefined {
  const sid = String(origin?.sid ?? '').trim();
  if (!sid || sid === String(requester ?? '').trim()) return undefined;
  const directory = String(origin?.directory ?? '').trim() || '(未知目录)';
  return `对接人（非本单发起方）：${sid} @ ${directory}`;
}

// ------------------------------------------- structured BLOCKED (0.7.0)

/**
 * 0.7.0 (`11-19-collab-blocked`): the caps of a structured `BLOCKED` report
 * (design §1). Over the cap is a **readable refusal**, never a silent truncation
 * — a silently dropped "已经排除的方向" is worse than no field at all.
 */
export const BLOCKED_KEEP = 3;
export const BLOCKED_NEED_LIMIT = 10;
export const BLOCKED_EXCLUDED_LIMIT = 20;
export const BLOCKED_ITEM_CHARS = 120;
export const BLOCKED_TEST_CHARS = 200;
/** Per section in the aggregate view (接收方注入 / `collab_status`). */
export const BLOCKED_AGGREGATE_ITEMS = 3;

/**
 * Same sanitation as `sanitizeReason`: control characters (newlines included)
 * become spaces and runs collapse. Every rendered block is line-oriented, so a
 * caller's stray newline must never be able to forge a second line.
 */
const BLOCKED_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g;

/** Control characters → spaces, whitespace folded: always exactly one line. */
function sanitizeInline(value: unknown): string {
  return String(value ?? '')
    .replace(BLOCKED_CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Code points, so "120 字" counts what a human calls a character. */
const charCount = (text: string): number => [...text].length;

/** `①`…`⑳` — the numbering the design shows (`需要对方：① … ② …`). */
const circled = (index: number): string => String.fromCodePoint(0x2460 + index);

/** One capped string field (`minimalTest`): sanitised, then length-checked. */
function blockedOne(value: unknown, field: string, limit: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw invalid(`blocked.${field} 必须是字符串 —— 未发送任何内容`);
  const text = sanitizeInline(value);
  const chars = charCount(text);
  if (chars > limit) {
    throw invalid(
      `blocked.${field} 最长 ${limit} 字（本次 ${chars} 字）—— 未发送任何内容（不静默截断）`
    );
  }
  return text;
}

/** One capped string list (`need` / `excluded`): sanitised, then checked. */
function blockedList(value: unknown, field: string, limit: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid(`blocked.${field} 必须是字符串数组 —— 未发送任何内容`);
  if (value.length > limit) {
    throw invalid(
      `blocked.${field} 最多 ${limit} 条（本次 ${value.length} 条）—— 未发送任何内容（不静默截断）`
    );
  }
  return value
    .map((item, index) => {
      if (typeof item !== 'string') {
        throw invalid(`blocked.${field}[${index}] 必须是字符串 —— 未发送任何内容`);
      }
      const text = sanitizeInline(item);
      const chars = charCount(text);
      if (chars > BLOCKED_ITEM_CHARS) {
        throw invalid(
          `blocked.${field}[${index}] 最长 ${BLOCKED_ITEM_CHARS} 字（本次 ${chars} 字）—— 未发送任何内容（不静默截断）`
        );
      }
      return text;
    })
    .filter(Boolean);
}

/**
 * Validate the caller's `blocked` input (design §2). Missing field → `undefined`
 * and the call behaves exactly as before; anything unusable is a **readable
 * refusal** before a single byte is delivered or written.
 */
export function normalizeBlocked(raw: unknown): BlockedSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid(
      'blocked 必须是对象：{ need?: string[], excluded?: string[], minimalTest?: string } —— 未发送任何内容'
    );
  }
  const value = raw as JsonObject;
  const need = blockedList(value.need, 'need', BLOCKED_NEED_LIMIT);
  const excluded = blockedList(value.excluded, 'excluded', BLOCKED_EXCLUDED_LIMIT);
  const minimalTest = blockedOne(value.minimalTest, 'minimalTest', BLOCKED_TEST_CHARS);
  if (!need.length && !excluded.length && !minimalTest) {
    throw invalid('blocked 不能为空：need / excluded / minimalTest 至少给一项 —— 未发送任何内容');
  }
  return { need, excluded, minimalTest };
}

/** Tolerant read of one stored list: sanitised, capped, junk dropped. */
function storedList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => (typeof item === 'string' ? truncate(sanitizeInline(item), BLOCKED_ITEM_CHARS) : ''))
    .filter(Boolean)
    .slice(0, limit);
}

/**
 * The stored structured `BLOCKED` reports of a record, oldest first. Read
 * tolerantly (a hand-edited / newer file must never break `collab_status`) and
 * re-sanitised here, because a record can also be written by a version that did
 * not validate it. Records written before this field existed simply have none.
 */
export function blockedHistoryOf(record: BroadcastRecord | undefined): BroadcastBlocked[] {
  const raw = asObject(record).blocked;
  if (!Array.isArray(raw)) return [];
  const out: BroadcastBlocked[] = [];
  for (const entry of raw) {
    const value = asObject(entry);
    const need = storedList(value.need, BLOCKED_NEED_LIMIT);
    const excluded = storedList(value.excluded, BLOCKED_EXCLUDED_LIMIT);
    const minimalTest = String(value.minimalTest ?? '')
      ? truncate(sanitizeInline(value.minimalTest), BLOCKED_TEST_CHARS)
      : '';
    if (!need.length && !excluded.length && !minimalTest) continue;
    out.push({
      need,
      excluded,
      minimalTest,
      at: Number(value.at) || 0,
      by: String(value.by ?? '')
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Append one structured `BLOCKED` to a record, keeping the newest
 * `BLOCKED_KEEP`. **Only** `blocked` changes: `state` / `claim` / `receipt` are
 * exactly what they were (design §4 — the field is display only).
 *
 * Callers must have cleared {@link canWriteBlocked} first — this function does
 * not judge who is writing.
 */
export function appendBlocked(
  record: BroadcastRecord,
  entry: BlockedSpec & { at?: number; by?: string }
): BroadcastRecord {
  const next: BroadcastBlocked = {
    need: entry.need.slice(0, BLOCKED_NEED_LIMIT),
    excluded: entry.excluded.slice(0, BLOCKED_EXCLUDED_LIMIT),
    minimalTest: entry.minimalTest,
    at: Number(entry.at) || Date.now(),
    by: String(entry.by ?? '')
  };
  return { ...record, blocked: [...blockedHistoryOf(record), next].slice(-BLOCKED_KEEP) };
}

/**
 * Whether `who` may write a structured `BLOCKED` onto this record — the **one**
 * implementation of that rule, shared by `collab_send` and `collab_handoff`
 * (the review found the second copy drifting: the hand-off's idempotent branch
 * had no check at all).
 *
 * Why the rule exists: `blocked` is free text that is rendered into the **next**
 * claimant's takeover injection (`blockedInjectionLines`), while a `bid` is
 * visible in bodies, receipts and documents. Without a gate any session that can
 * name the hand-off could push words into somebody else's prompt — the same
 * "write into a line you were not given" shape the `protect` guard closes by
 * hand.
 *
 * The four participants are the requester (`from.sid`), the claimant
 * (`claim.by`), the session currently being asked (`asked.sid`) and the chain
 * head (`origin.sid`) — that covers every real use: the requester annotating its
 * own hand-off, the claimant reporting, and a forwarded hop passing it on. It is
 * deliberately **fail-open when nothing can be judged** (no session context, or
 * a hand-written record with none of the four fields), which keeps the old
 * "no sessionID = no identity check" behaviour.
 */
export function canWriteBlocked(record: BroadcastRecord | undefined, who: string | undefined): boolean {
  const sid = String(who ?? '').trim();
  if (!sid) return true;
  const participants = [
    record?.from?.sid,
    record?.claim?.by,
    record?.asked?.sid,
    record?.origin?.sid
  ]
    .map(value => String(value ?? '').trim())
    .filter(Boolean);
  return !participants.length || participants.includes(sid);
}

/**
 * The three sections (design §3):
 *
 * ```
 * 需要对方：① … ② …
 * 已排除：…
 * 最小判别：…
 * ```
 *
 * `max` caps each section at N items and appends `（还有 N 条）` — the aggregate
 * view (receiving injection / `collab_status`) uses 3; the delivered body keeps
 * everything the caller sent (already capped by `normalizeBlocked`).
 */
export function blockedLines(
  entry: BlockedSpec,
  { max = Number.POSITIVE_INFINITY }: { max?: number } = {}
): string[] {
  const lines: string[] = [];
  if (entry.need.length) {
    const shown = entry.need.slice(0, max);
    const rest = entry.need.length - shown.length;
    lines.push(
      `需要对方：${shown.map((text, index) => `${circled(index)} ${text}`).join(' ')}` +
        `${rest > 0 ? `（还有 ${rest} 条）` : ''}`
    );
  }
  if (entry.excluded.length) {
    const shown = entry.excluded.slice(0, max);
    const rest = entry.excluded.length - shown.length;
    lines.push(`已排除：${shown.join('；')}${rest > 0 ? `（还有 ${rest} 条）` : ''}`);
  }
  if (entry.minimalTest) lines.push(`最小判别：${entry.minimalTest}`);
  return lines;
}

/**
 * The same three lines for a **receiving** session (`takeoverBody`: spawn /
 * wake / resend) or for `collab_status`: the latest report plus how many older
 * ones the record keeps. An empty list means "render nothing" — a record without
 * `blocked` keeps every pre-0.7.0 output byte for byte.
 */
export function blockedInjectionLines(record: BroadcastRecord | undefined): string[] {
  const entries = blockedHistoryOf(record);
  if (!entries.length) return [];
  const latest = entries[entries.length - 1];
  const who = latest.by ? shortID(latest.by) : '';
  const history = entries.length > 1 ? `历史 ${entries.length} 次，展示最新一次` : '';
  const suffix = [who, history].filter(Boolean).join('，');
  return [
    `上一位承接方的 BLOCKED（结构化${suffix ? `，${suffix}` : ''}）:`,
    ...blockedLines(latest, { max: BLOCKED_AGGREGATE_ITEMS }).map(line => `  ${line}`)
  ];
}

// ------------------------------------------- contract decisions (0.7.0)

/**
 * 0.7.0 (`11-19-collab-decisions`): the caps of a contract decision (design §1).
 * Over a cap is a **readable refusal**, never a silent truncation or eviction —
 * a dropped decision reads exactly like a decision that was never made.
 */
export const DECISION_KEEP = 20;
export const DECISION_ITEMS_LIMIT = 10;
export const DECISION_ID_CHARS = 40;
export const DECISION_TEXT_CHARS = 200;
export const DECISION_RATIONALE_CHARS = 400;
/** How many decisions `collab_status` shows (newest first) and the count line. */
export const DECISION_SHOW = 3;
/** Display cut for a rationale in `collab_status` (stored value may be 400). */
export const DECISION_RATIONALE_SHOW = 80;

/**
 * One capped single-line field of a decision. Same sanitation as `blocked`
 * (control characters → spaces, whitespace folded): every rendered decision is
 * line-oriented, so a caller's stray newline must never forge a second line.
 */
function decisionField(
  value: unknown,
  field: string,
  limit: number,
  { required = true }: { required?: boolean } = {}
): string {
  if (value === undefined || value === null) {
    if (required) throw invalid(`decisions.${field} 必填 —— 未写入任何内容`);
    return '';
  }
  if (typeof value !== 'string') throw invalid(`decisions.${field} 必须是字符串 —— 未写入任何内容`);
  const text = sanitizeInline(value);
  const chars = charCount(text);
  if (required && !text) throw invalid(`decisions.${field} 不能为空 —— 未写入任何内容`);
  if (chars > limit) {
    throw invalid(
      `decisions.${field} 最长 ${limit} 字（本次 ${chars} 字）—— 未写入任何内容（不静默截断）`
    );
  }
  return text;
}

/**
 * Validate the caller's `items` (design §2): 1–10 entries, `id` ≤40,
 * `decision` ≤200, `rationale` ≤400. Anything unusable is a readable refusal
 * **before** a single byte is written.
 *
 * Two entries with the same `id` in one call collapse to the later one — the
 * same "按 id 覆盖" rule the record uses, so a call can never append two answers
 * to one decision.
 */
export function normalizeDecisionItems(raw: unknown): DecisionSpec[] {
  if (raw === undefined || raw === null) {
    throw invalid(`decisions 需要 items（1–${DECISION_ITEMS_LIMIT} 条 { id, decision, rationale? }）—— 未写入任何内容`);
  }
  if (!Array.isArray(raw)) throw invalid('decisions 的 items 必须是数组 —— 未写入任何内容');
  if (!raw.length) throw invalid(`decisions 的 items 不能为空（1–${DECISION_ITEMS_LIMIT} 条）—— 未写入任何内容`);
  if (raw.length > DECISION_ITEMS_LIMIT) {
    throw invalid(
      `decisions 的 items 最多 ${DECISION_ITEMS_LIMIT} 条（本次 ${raw.length} 条）—— 未写入任何内容（不静默截断）`
    );
  }
  const out = new Map<string, DecisionSpec>();
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw invalid(`decisions.items[${index}] 必须是对象 { id, decision, rationale? } —— 未写入任何内容`);
    }
    const value = item as JsonObject;
    const id = decisionField(value.id, `items[${index}].id`, DECISION_ID_CHARS);
    const decision = decisionField(value.decision, `items[${index}].decision`, DECISION_TEXT_CHARS);
    const rationale = decisionField(value.rationale, `items[${index}].rationale`, DECISION_RATIONALE_CHARS, {
      required: false
    });
    out.set(id, { id, decision, ...(rationale ? { rationale } : {}) });
  });
  return [...out.values()];
}

/**
 * The stored decisions of a record, oldest first, deduped by `id` (the later
 * occurrence wins) and capped to the newest {@link DECISION_KEEP}. Read
 * tolerantly and re-sanitised: a record can also be written by a version that
 * did not validate the field, and a hand-edited one must never break
 * `collab_status`. Records written before this field existed simply have none.
 */
export function decisionHistoryOf(record: BroadcastRecord | undefined): BroadcastDecision[] {
  const raw = asObject(record).decisions;
  if (!Array.isArray(raw)) return [];
  const out: BroadcastDecision[] = [];
  for (const entry of raw) {
    const value = asObject(entry);
    const id = truncate(sanitizeInline(value.id), DECISION_ID_CHARS);
    const decision = truncate(sanitizeInline(value.decision), DECISION_TEXT_CHARS);
    if (!id || !decision) continue;
    const rationale = String(value.rationale ?? '')
      ? truncate(sanitizeInline(value.rationale), DECISION_RATIONALE_CHARS)
      : '';
    const next: BroadcastDecision = {
      id,
      decision,
      ...(rationale ? { rationale } : {}),
      at: Number(value.at) || 0,
      by: String(value.by ?? '')
    };
    const seen = out.findIndex(item => item.id === id);
    if (seen >= 0) out.splice(seen, 1);
    out.push(next);
  }
  return out.slice(-DECISION_KEEP);
}

/**
 * Apply `items` on top of a record's decisions, **keyed by `id`** (design §1):
 * a repeat overwrites in place and moves to the end (its `at`/`by` are this
 * write's), a new id appends. Returns the full (uncapped) list so the caller can
 * refuse a write that would pass {@link DECISION_KEEP} — this function never
 * drops an old decision silently.
 */
export function mergeDecisions(
  record: BroadcastRecord | undefined,
  items: DecisionSpec[],
  stamp: { at?: number; by?: string }
): { decisions: BroadcastDecision[]; added: number; replaced: number } {
  const at = Number(stamp.at) || Date.now();
  const by = String(stamp.by ?? '');
  const out = decisionHistoryOf(record);
  let added = 0;
  let replaced = 0;
  for (const item of items) {
    const index = out.findIndex(entry => entry.id === item.id);
    if (index >= 0) {
      out.splice(index, 1);
      replaced += 1;
    } else {
      added += 1;
    }
    out.push({
      id: item.id,
      decision: item.decision,
      ...(item.rationale ? { rationale: item.rationale } : {}),
      at,
      by
    });
  }
  return { decisions: out, added, replaced };
}

/**
 * Whether `who` may write a decision onto this record. **Stricter than
 * {@link canWriteBlocked}** on purpose: only the requester (`from.sid`) and the
 * claimant (`claim.by`). The asked candidate and the chain head may annotate a
 * BLOCKED report (they are in the delivery path), but a *contract* decision must
 * not be writable by a bystander — otherwise anyone who can name a `bid` could
 * rewrite the contract through the record.
 *
 * Fail-**closed** when the record names no participant at all (unlike
 * `canWriteBlocked`, which stays fail-open for hand-written records).
 */
export function canWriteDecisions(record: BroadcastRecord | undefined, who: string | undefined): boolean {
  const sid = String(who ?? '').trim();
  if (!sid) return false;
  return [record?.from?.sid, record?.claim?.by]
    .map(value => String(value ?? '').trim())
    .filter(Boolean)
    .includes(sid);
}

/**
 * The **one line** a claimant sees in its takeover injection (design §3):
 * a count, never the text — the full list is one read-only `collab_status` call
 * away, so the injection stays small. A record without `decisions` renders
 * nothing, so every pre-0.7.0 output is unchanged.
 */
export function decisionInjectionLines(record: BroadcastRecord | undefined): string[] {
  const entries = decisionHistoryOf(record);
  if (!entries.length) return [];
  return [`本单决策 ${entries.length} 条（collab_status { bid:"${record?.bid ?? ''}" } 查看）`];
}


/**
 * R1: the takeover message body, shared by the three places that deliver it:
 * the `busy > 30min` wake prompt, the freshly spawned session and the 0.1.6
 * resend (same `cid`, so the receiving side de-duplicates it). One builder keeps
 * all of them saying the same three steps.
 */
export function takeoverBody({
  record,
  wake = false,
  spawn = false
}: {
  record: BroadcastRecord;
  wake?: boolean;
  spawn?: boolean;
}): string {
  const requester = String(record?.from?.sid ?? '');
  const leaseMin = Math.round(BCAST_LEASE_MS / 60_000);
  // R1 (pull): a protected requester cannot receive a pushed receipt, so the
  // takeover text asks for the in-session `[handoff]` line instead.
  const receiptMode: 'push' | 'pull' = record?.receiptMode === 'pull' ? 'pull' : 'push';
  return [
    // 0.7.0 (R2): the claimant learns who it is and how to answer first.
    ...protocolHeader({
      bid: record.bid,
      threadID: record.threadID,
      peer: record.scope === 'peer',
      // 0.7.0 (R3): `A → B → C` — C sees A here even when `from` is B.
      origin: record.origin,
      requester
    }),
    `[collab-handoff] ${record.title ?? '(untitled)'}`,
    `提案：${record.issuePath ?? '-'}${record.workspace ? `（工作区 ${record.workspace}，scope=${record.scope}）` : ''}`,
    `影响面：${(record.affectedFiles ?? []).slice(0, 8).join(', ') || '(未标注)'}`,
    `期望：${record.expected}`,
    // D3 (0.4.0): `research` is read-only investigation — say so before the
    // three steps, so a `build` session does not start editing.
    ...(record.expected === 'research'
      ? ['（本次期望是「只读排查」：只读代码/提案并给出结论，不要改代码；要改代码需发起方另发 implement。）']
      : []),
    // 0.7.0 (`11-19-collab-blocked`, R3): what the previous claimant already
    // ruled out and the one experiment that settles it — before the three steps
    // (there is nothing to act on yet, this is context). A record without
    // `blocked` renders nothing here, so old output is unchanged.
    ...blockedInjectionLines(record),
    // 0.7.0 (`11-19-collab-decisions`, R3): the contract decisions of this
    // hand-off — **one count line only** (the text is one `collab_status` away).
    // A record without `decisions` renders nothing here.
    ...decisionInjectionLines(record),
    // R1-2: full requester sid (no `collab_inbox` lookup needed to say no).
    `发起方：${requester || '(记录里没有发起方 sid，回执用 collab_inbox 查)'}`,
    '按顺序完成（三步都不要省略）：',
    // R1 (G1): accept → receipt → "analysing in-session is not done", with
    // copy-pasteable commands (full sid + bid).
    ...handoffActions({
      bid: record.bid,
      requester,
      spawn,
      leaseMin,
      receiptMode,
      expected: record.expected,
      // 0.7.0 (R3): the receipt block names the chain head too.
      origin: record.origin
    }),
    spawn
      ? receiptMode === 'pull'
        ? '确实做不了：在最后一条回复里写 BLOCKED 回执（不要 collab_send），不要静默挂起。'
        : '确实做不了：发 BLOCKED 回执，不要静默挂起。'
      : '',
    wake ? '（你已 busy 超过 30 分钟，这条是叫醒消息：不打断当前轮，排在下一轮）' : ''
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * R1: what a receiving session must do, in order, with copy-pasteable commands
 * (full requester sid + bid). Shared by the takeover request, the wake prompt
 * and the broadcast result so all three say the same three things — after the
 * pilot, an `explore` session answered in its own turn, called nothing, and the
 * bid stayed `claimed`.
 *
 * `receiptMode: 'pull'` (requester on the protect list) swaps only step ②/③:
 * a `collab_send` into a protected requester is refused by the very guard that
 * protects it, so the receipt is the claimant's own last answer and the
 * requester extracts it from there. `push` (default) is unchanged.
 */
export function handoffActions({
  bid,
  requester,
  spawn = false,
  leaseMin = 5,
  receiptMode = 'push',
  expected = 'implement',
  origin
}: {
  bid: string;
  requester?: string;
  spawn?: boolean;
  leaseMin?: number;
  receiptMode?: 'push' | 'pull';
  /** D3 (0.4.0): `research` swaps step ③ for read-only wording. */
  expected?: string;
  /**
   * 0.7.0 (R3): the chain head of a forwarded hand-off. Only rendered when it
   * differs from `requester`; adds the 对接人 line (and, on the push path, the
   * one command that lets a blocked claimant answer the chain head directly —
   * the whole point of the field, 4 hops → 2).
   */
  origin?: BroadcastOrigin;
}): string[] {
  const target = requester || 'ses_…';
  const research = expected === 'research';
  const lines = [`① 领取（先做；领取即 acked）：collab_accept {bid:"${bid}", confirm:true}`];
  if (receiptMode === 'pull') {
    // R1 (pull): the requester is on the protect list, so a `collab_send` into
    // it is refused by the same guard that protects it — asking for one is
    // asking for a wall. The receipt is the claimant's own last answer instead,
    // read once by the requester when the lease lapses (see `refresh`).
    lines.push(
      `② 回执（pull 模式，必写）: 在本会话最后一条回复里写一行 \`[handoff] DONE ${bid} <摘要>\`；` +
        '发起方在租约到期后只读提取（这条回复就是回执）。',
      `   无法实施/判定无需处理: 同一行改成 \`[handoff] BLOCKED ${bid} <原因>\`。`,
      '   不要尝试 collab_send：发起方在 protect 名单内，投递会被拒绝。',
      research
        ? '③ 本次是只读排查：不要改代码；结论（发现 / 建议 / 风险）连同上面的 [handoff] 行写在本会话最后一条回复里。'
        : '③ 只分析、不调用工具 = 未完成：结论必须写在本会话最后一条回复里（含上面的 [handoff] 行）。'
    );
    if (!spawn) {
      lines.push(
        `   没余力/不接：不领取即可（${leaseMin} 分钟不答自动顺延下一候选；pull 模式没有推送，不需要回执）`
      );
    }
    // 0.7.0 (R3): display only here — a push into any protected line is refused,
    // so naming the chain head must not turn into a `collab_send` invitation.
    const pullHint = originHint(origin, requester);
    if (pullHint) lines.push(`   ${pullHint}（只作展示：跨层结论仍写在你自己最后一条回复里）`);
    return lines;
  }
  lines.push(
    `② 回执（必发，二选一）: collab_send {target:"${target}", text:"[handoff] DONE ${bid} <摘要>", confirm:true}`,
    `   无法实施/判定无需处理: collab_send {target:"${target}", text:"[handoff] BLOCKED ${bid} <原因>", confirm:true}`,
    research
      ? '③ 本次是只读排查：不要改代码；结论（发现 / 建议 / 风险）写进最后一条回复，并用 ② 的 collab_send 真正发出。' +
        '（② 里的文字只是格式示例——复述/回显它不算回执，也不会被自动闭环。）'
      : '③ 只分析、不调用工具 = 未完成：结论必须用上面的 collab_send 真正发出。' +
        '（② 里的文字只是格式示例——复述/回显它不算回执，也不会被自动闭环。）'
  );
  // 0.7.0 (R3): the chain head, when it is not this hand-off's own requester.
  const hint = originHint(origin, requester);
  const head = String(origin?.sid ?? '').trim();
  if (hint && head) {
    lines.push(
      `   ${hint} —— 跨层结论可直接发给它：collab_send {target:"${head}", text:"[handoff] DONE ${bid} <摘要>", confirm:true}` +
        `（同一条 [handoff] 行也能闭环本单，不必再经发起方转发；仅限本单发起方或对接人，第三方发送不会闭环）`
    );
  }
  if (!spawn) {
    lines.push(
      `   没余力/不接：collab_send {target:"${target}", text:"DECLINE ${bid} <理由>", confirm:true}` +
        `（${leaseMin} 分钟不答自动顺延下一候选）`
    );
  }
  return lines;
}
