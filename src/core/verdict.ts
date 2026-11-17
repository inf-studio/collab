import { VERDICT_MESSAGE_LIMIT, VERDICT_NOTE_LIMIT } from '../constants.ts';
import type { BroadcastRecord, SessionMessageLike } from '../types.ts';
import { truncateRaw } from '../util.ts';

/**
 * Receipt line, written by the session that took the hand-off:
 *   `[handoff] DONE <提案路径|bid|thread> <commit sha 或摘要>`
 *   `[handoff] BLOCKED <…> <原因>`
 * Parsing is deliberately loose — the third field is free text.
 */
const HANDOFF_RECEIPT_RE = /\[handoff\]\s+(DONE|BLOCKED)\s+(\S+)\s*([^\n]*)/i;
/** An explicit refusal from the currently asked candidate. */
export const HANDOFF_DECLINE_RE = /\bDECLINE\b/i;
/** A `bid` written inside the DECLINE text, so several asks cannot be confused. */
export const DECLINE_BID_RE = /\b(b_[0-9a-f]{8,32})\b/;

export interface Receipt {
  state: 'done' | 'blocked';
  target: string;
  note: string;
}

export function parseReceiptLine(text: unknown): Receipt | undefined {
  const match = HANDOFF_RECEIPT_RE.exec(String(text ?? ''));
  if (!match) return undefined;
  return {
    state: match[1].toUpperCase() === 'DONE' ? 'done' : 'blocked',
    target: match[2],
    note: truncateRaw(match[3] ?? '', 500)
  };
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
 */
const BLOCKED_VERDICT_RE = /已实施|已修复|无需|不需要|已完成|not needed|already/i;
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
 * R1: what a receiving session must do, in order, with copy-pasteable commands
 * (full requester sid + bid). Shared by the takeover request, the wake prompt
 * and the broadcast result so all three say the same three things — after the
 * pilot, an `explore` session answered in its own turn, called nothing, and the
 * bid stayed `claimed`.
 */
export function handoffActions({
  bid,
  requester,
  spawn = false,
  leaseMin = 5
}: {
  bid: string;
  requester?: string;
  spawn?: boolean;
  leaseMin?: number;
}): string[] {
  const target = requester || 'ses_…';
  const lines = [
    `① 领取（先做；领取即 acked）：collab_accept {bid:"${bid}", confirm:true}`,
    `② 回执（必发，二选一）: collab_send {target:"${target}", text:"[handoff] DONE ${bid} <摘要>", confirm:true}`,
    `   无法实施/判定无需处理: collab_send {target:"${target}", text:"[handoff] BLOCKED ${bid} <原因>", confirm:true}`,
    '③ 只分析、不调用工具 = 未完成：结论必须用上面的 collab_send 真正发出。' +
      '（② 里的文字只是格式示例——复述/回显它不算回执，也不会被自动闭环。）'
  ];
  if (!spawn) {
    lines.push(
      `   没余力/不接：collab_send {target:"${target}", text:"DECLINE ${bid} <理由>", confirm:true}` +
        `（${leaseMin} 分钟不答自动顺延下一候选）`
    );
  }
  return lines;
}
