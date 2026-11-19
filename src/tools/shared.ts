import type { ConfigReader } from '../config.ts';
import {
  BCAST_DONE_STATES,
  CONFIG_PATH,
  DEDUPE_MEMO_LIMIT,
  DEDUPE_REPLY_LOOKBACK,
  INBOX_TEXT_LIMIT,
  REPLY_POLL_MS,
  STORAGE_ALIASES
} from '../constants.ts';
import { deliveryLine, deliveryOf, deliveryVisible } from '../core/ack.ts';
import type { HandoffChain } from '../core/chain.ts';
import { allBroadcasts, mergeDelivery, readBroadcast, writeBroadcast } from '../core/claim.ts';
import { GuardConflictError, classify, deliveryFailure, invalid } from '../core/errors.ts';
import { createLineage } from '../core/lineage.ts';
import type { Reporter } from '../core/report.ts';
import { appendThreadMessage } from '../core/storage.ts';
import type { InboxStore, ThreadStore } from '../core/storage.ts';
import { fmtTtl, touchWaiters } from '../core/locks.ts';
import { takeoverBody } from '../core/verdict.ts';
import { envelope, newCorrelationID, normalizeKind } from '../ids.ts';
import type { WakeSignal } from '../ids.ts';
import { errText, log } from '../log.ts';
import type {
  BroadcastRecord,
  CollabContext,
  JsonObject,
  SessionInfoLike,
  SessionPromptInput,
  SessionPromptResult,
  ToolContext,
  ToolResult
} from '../types.ts';
import { asObject, fmtTime, sessionState, shortID, truncate, truncateRaw } from '../util.ts';

/** `jsonInput` — the object schema every tool declares (extra keys refused). */
export function jsonInput(schema: JsonObject): JsonObject {
  return { type: 'object', additionalProperties: false, ...schema };
}

/** A `bid` written inside a message body (same shape the DECLINE parser uses). */
const RECEIPT_BID_RE = /\b(b_[0-9a-f]{8,32})\b/;
/**
 * The `[handoff]` mark of a receipt line. Every receipt carries it — including
 * the ones written before `kind:"reply"` existed (`[handoff] DONE <bid> <摘要>`),
 * which is the only thing that lets 0.1.4 recognise a legacy receipt.
 */
const HANDOFF_LINE_RE = /\[handoff\]/i;

/**
 * R2 (bounded reply) — the *only* message that may be delivered into a
 * protected session. A protected requester can never be written to
 * (fail-closed), yet the hand-off it started still has exactly one legitimate
 * answer: the receipt of the session that claimed that very bid. Three
 * conditions must **all** hold:
 *   ① `kind` is `reply` — or, for a *legacy* receipt, `request` (see below);
 *   ② `target` is the `from.sid` of the record the bid names (or, with
 *      `acceptOrigin`, its chain head `origin.sid` — 0.7.0);
 *   ③ `sender` is that record's `claim.by`.
 * A `note` / `steer`, a foreign bid, a bystander or an unknown sender stays
 * refused, and so does a **decided** record (`done` / `blocked` / `expired`): a
 * closed hand-off has nothing left to report, so the whitelist must not become a
 * generic way into the protected line. Returns the matching record, or
 * `undefined` (= refuse); the record itself is never modified — `applyReceipt`
 * still owns the state.
 *
 * R5 (0.1.6) keeps that refusal on purpose: a closure is **not** a licence to
 * push into a protected line. A post-closure conclusion is a *pull* — the
 * claimant writes `collab_followup` (and the proposal file), and the requester
 * sees one read-only hint in its own `context` injection.
 *
 * 0.7.0 (`11-19-collab-origin`, B): `acceptOrigin` widens **only** the target
 * half of ②, so a receipt can also be addressed to the chain head of a forwarded
 * hand-off (`A → B → C`: C answers A directly). It is deliberately an opt-in
 * *per call site*: the protected-delivery whitelist (`allowProtectedReply`) is
 * still decided by the untouched call (`acceptOrigin` absent), so a protected
 * `origin` never gains a delivery path through this widening.
 *
 * The bid comes from the explicit `bid` argument first, then from the body
 * (`[handoff] DONE b_… …`), so an existing receipt command needs no new field.
 *
 * R1 (0.1.4, legacy receipts) — broadcasts created by 0.1.1 and earlier told the
 * claimant to send `collab_send {target, text:"[handoff] DONE <bid> …"}`, i.e.
 * **without** `kind`, which defaults to `request` and used to be refused by
 * this very whitelist: those hand-offs could never be closed. A `request` is
 * therefore accepted too, but only when it looks unmistakably like a receipt:
 * its body carries the `[handoff]` line **and** the bid (arg or body) names this
 * exact record, and the caller did not ask for `steer` (a legacy receipt may
 * never ask to interrupt). Everything else about `request` stays fail-closed.
 * R7 (0.1.4): the legacy widening applies only when the caller did **not**
 * declare a kind (`legacyAllowed`). An explicit `kind:"request"` is a deliberate
 * request and stays fail-closed — the same rule the inbound side enforces.
 */
export function canReplyToProtected({
  kind,
  target,
  sender,
  bid,
  text,
  mode,
  legacyAllowed = false,
  acceptOrigin = false
}: {
  kind: unknown;
  target: unknown;
  sender: string | undefined;
  bid?: unknown;
  text?: unknown;
  /** Delivery mode asked for by the caller; a legacy (`request`) receipt must not `steer`. */
  mode?: unknown;
  /** True only when the tool input carried **no** `kind` (legacy receipt command). */
  legacyAllowed?: boolean;
  /**
   * 0.7.0 (B): also accept the record's chain head (`origin.sid`) as the receipt
   * target. Used **only** to decide the `kind:reply` rewrite of a non-protected
   * receipt; never passed where `allowProtectedReply` is decided.
   */
  acceptOrigin?: boolean;
}): BroadcastRecord | undefined {
  const requested = normalizeKind(kind);
  if (requested !== 'reply' && requested !== 'request') return undefined;
  if (requested === 'request' && !legacyAllowed) return undefined;
  if (!sender) return undefined;
  const body = String(text ?? '');
  if (requested === 'request') {
    // The legacy shape is `[handoff] DONE <bid> …` in the body: without that
    // line a plain `request` can never borrow this whitelist just because its
    // text happens to contain a `b_…` string.
    if (!HANDOFF_LINE_RE.test(body)) return undefined;
    // A legacy receipt is a closing report, never an interruption.
    if (String(mode ?? '').trim() === 'steer') return undefined;
  }
  const wanted = String(bid ?? '').trim() || RECEIPT_BID_RE.exec(body)?.[1] || '';
  if (!wanted) return undefined;
  const record = readBroadcast(wanted);
  if (!record) return undefined;
  // The file must really be about the bid that was authorised (a hand-written
  // record whose `bid` field disagrees with its name is not a receipt).
  if (String(record.bid ?? '') !== wanted) return undefined;
  // A decided hand-off is not a receipt anymore: fail-closed again (R5: the
  // post-closure conclusion is a pull — `collab_followup` + the proposal file).
  if (BCAST_DONE_STATES.includes(String(record.state))) return undefined;
  // ② the receipt may be addressed to this hand-off's requester — or, when the
  // caller opted in (`acceptOrigin`, 0.7.0 B), to the chain head of a forwarded
  // one. A third target (or an empty one) never matches, so the widening is
  // exactly two sids.
  const targetSid = String(target ?? '').trim();
  const requesterSid = String(record.from?.sid ?? '').trim();
  const originSid = String(record.origin?.sid ?? '').trim();
  if (!targetSid) return undefined;
  if (targetSid !== requesterSid && !(acceptOrigin && originSid && targetSid === originSid)) return undefined;
  if (String(record.claim?.by ?? '') !== String(sender)) return undefined;
  return record;
}

export interface ToolDeps {
  ctx: CollabContext;
  readConfig: ConfigReader;
  inbox: InboxStore;
  threads: ThreadStore;
  signal: WakeSignal;
  chain: HandoffChain;
  /** Defect self-reporting (R1–R8): side path, never changes a tool result. */
  reporter: Reporter;
}

export interface Target {
  sessionID: string;
  alias?: string;
  info: SessionInfoLike;
}

export interface DeliveryMode {
  mode: string;
  forced: boolean;
}

/**
 * R1 (0.1.6): what `dispatch` actually admitted. The caller writes it into the
 * hand-off record (`delivery`), so the receiving plugin can ack it and the
 * sender can resend / show `admitted / seen`.
 */
export interface DeliveryOutcome {
  cid: string;
  to: string;
  messageId?: string;
  admittedAt: number;
}

/** Everything a tool file needs besides `deps`: the shared delivery helpers. */
export interface ToolKit {
  deps: ToolDeps;
  resolveTarget(raw: unknown): Promise<Target>;
  senderLabel(sessionID: string | undefined): string;
  isReadonlyAgent(agent: unknown): boolean;
  /**
   * D3 (0.4.0): the visible capability-mismatch note — `expected:"implement"`
   * against a read-only agent (`explore` / `plan`) cannot end in code, so the
   * result says so and points at `expected:"research"` / `collab_promote`.
   * `undefined` when the pair is fine (`research` is legal for any agent).
   */
  capabilityNote(agent: unknown, expected: unknown): string | undefined;
  resolveMode(requested: unknown, agent: unknown): DeliveryMode;
  /**
   * R5 (0.6.0) + R1 (0.7.0, `11-19-collab-dedupe-target`): the same normalised
   * body inside `dedupeWindowMs` is one message, not two — on the same thread
   * **or** towards the same target session through another thread. Returns the
   * moment of the duplicate (and where it was found) or `undefined`. Read-only.
   */
  findDuplicateSend(input: {
    threadID: string;
    /** Target session id — enables the target-level half (0.7.0, R1). */
    target?: string;
    text: string;
    record?: BroadcastRecord;
    now?: number;
  }): Promise<DuplicateSend | undefined>;
  dispatch(input: {
    context: ToolContext | undefined;
    input: JsonObject | undefined;
    kind: string;
    threadID: string | undefined;
    mode: string;
    forced: boolean;
    notes: string[];
    target: Target;
    /** R2: a bounded reply (`canReplyToProtected`) — the only guard bypass. */
    allowProtectedReply?: boolean;
    /**
     * 0.7.0 (R1, `11-19-collab-dedupe-target`): the caller knows it is repeating
     * itself — skip **both** de-dup levels, deliver anyway, and mark the result
     * (`dedupeOverridden`) + the record (`dedupeOverriddenAt`).
     */
    force?: boolean;
  }): Promise<ToolResult & { delivery?: DeliveryOutcome }>;
  waitForReply(threadID: string, timeoutMs: number, context: ToolContext | undefined): Promise<ToolResult>;
  /**
   * R3 (0.1.6): read-only `admitted / seen / queue-age / resend / unacked` of
   * the hand-offs a thread (or a target session) is involved in.
   */
  deliveryStatus(input: { threadID?: string; target?: string }): string[];
  deliverAsk(input: {
    record: JsonObject;
    target: string;
    wake: boolean;
    threadID?: string;
    spawn?: boolean;
  }): Promise<{ delivered: boolean; record: BroadcastRecord }>;
}

/**
 * R5 (0.6.0) / R1 (0.7.0): where a duplicate was found and when it was admitted.
 * `thread` = the thread's own message list (persistent, survives a reload);
 * `record` = the hand-off record's recent `replies`; `memo` = the in-process
 * fallback for a send that never made it into a thread message; `target` = the
 * same body already reached this **session** through another thread (the hit
 * carries that thread's id, which is what makes the receipt actionable).
 */
export interface DuplicateSend {
  at: number;
  source: 'thread' | 'record' | 'memo' | 'target';
  /** `source:"target"` only: the thread that carried the earlier copy. */
  threadID?: string;
  /** `source:"target"` only: the hand-off that copy carried, when known. */
  bid?: string;
}

/**
 * The de-dup normalisation: whitespace is layout, not content — the same
 * sentence with a different line break (a re-typed message, a pasted one, a
 * wrapper that wrapped it) is the same message.
 */
export function normalizeSendBody(text: unknown): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Process-local memo for sends that have no thread message to compare against.
 * Cleared when the plugin reloads — acceptable: the thread is the SSOT, the memo
 * only covers a same-process repeat.
 */
const sendMemo = new Map<string, number>();

/**
 * The de-dup window as a human label: below two minutes it is spelled in
 * seconds (`60s 内同文`, exactly what the PRD asks the receipt to say);
 * longer windows use the shared `14m`/`1h02m` shape.
 */
function dedupeWindowLabel(ms: number): string {
  return ms < 120_000 ? `${Math.round(ms / 1000)}s` : fmtTtl(ms);
}

/** `threadID + '\n' + normalised body` — the de-dup key (design §3). */
function sendKey(threadID: string, text: string): string {
  return `${threadID}\n${normalizeSendBody(text)}`;
}

function rememberSend(threadID: string, text: string, at: number): void {
  sendMemo.set(sendKey(threadID, text), at);
  // Bounded: oldest key out first (insertion order), never a scan per send.
  while (sendMemo.size > DEDUPE_MEMO_LIMIT) {
    const oldest = sendMemo.keys().next();
    if (oldest.done) break;
    sendMemo.delete(oldest.value);
  }
}

/**
 * R1 (0.7.0, `11-19-collab-dedupe-target`): the **target** dimension.
 *
 * The thread-level index above cannot see the failure it was added for: one
 * BLOCKED summary sent to three threads of the same target passed every check
 * three times (each thread is a different key), so the counterpart answered
 * three times — none of them on the thread it was actually using. A send is a
 * message to a *session*, so the session is the real de-dup unit:
 *
 *   key   = `targetSid + '\n' + normalised body`
 *   value = where/when it actually went (`at`, `threadID`, `bid?`)
 *
 * Process-local on purpose: the delivery itself happens in this process, the
 * 60s window is meaningless across a reload, and a file would add a disk
 * dependency to a hot path. Bounded by the same cap as the thread memo.
 */
const targetSendMemo = new Map<string, { at: number; threadID: string; bid?: string }>();

function targetSendKey(targetSid: string, text: string): string {
  return `${targetSid}\n${normalizeSendBody(text)}`;
}

function rememberTargetSend(
  targetSid: string,
  threadID: string,
  text: string,
  at: number,
  bid?: string
): void {
  const key = targetSendKey(targetSid, text);
  // Re-insert so the eviction order stays "oldest *written* first".
  targetSendMemo.delete(key);
  targetSendMemo.set(key, { at, threadID, ...(bid ? { bid } : {}) });
  while (targetSendMemo.size > DEDUPE_MEMO_LIMIT) {
    const oldest = targetSendMemo.keys().next();
    if (oldest.done) break;
    targetSendMemo.delete(oldest.value);
  }
}

export function createToolKit(deps: ToolDeps): ToolKit {
  const { ctx, readConfig, threads, signal } = deps;

  /**
   * One delivery. A refused/thrown `session.prompt` is tagged as a delivery
   * defect (R1: 投递 5xx) instead of a generic `Error`, so `reporter.wrap` files it
   * under `delivery-5xx` and the caller still receives the readable message.
   */
  async function deliverPrompt(input: SessionPromptInput): Promise<SessionPromptResult> {
    try {
      return await ctx.session.prompt(input);
    } catch (error) {
      throw deliveryFailure(error);
    }
  }

  /** Resolve `<alias>|ses_…` → existing session info, or throw a readable error. */
  async function resolveTarget(raw: unknown): Promise<Target> {
    const target = String(raw ?? '').trim();
    if (!target) throw invalid('target 不能为空：请给 ses_… 会话 id 或 collab.json 里的别名');

    let sessionID = target;
    let alias: string | undefined;
    if (!target.startsWith('ses_')) {
      const stored = asObject(await ctx.storage.get(STORAGE_ALIASES));
      const table: Record<string, string> = { ...stored, ...readConfig().aliases };
      sessionID = table[target];
      if (!sessionID) {
        throw invalid(
          `未知目标 "${target}"：既不是 ses_ 会话 id，也不在别名表里` +
            `（${CONFIG_PATH} 的 aliases，或 ~/.config/opencode/collab-aliases.json）`
        );
      }
      alias = target;
    }

    let info: SessionInfoLike;
    try {
      info = await ctx.session.get({ sessionID });
    } catch (error) {
      throw invalid(`会话不存在或不可读：${sessionID}（${errText(error)}）`, error);
    }
    return { sessionID, alias, info };
  }

  function senderLabel(sessionID: string | undefined): string {
    const hit = Object.entries(readConfig().aliases).find(([, value]) => value === sessionID);
    return hit ? hit[0] : shortID(sessionID);
  }

  function isReadonlyAgent(agent: unknown): boolean {
    const id = String(agent ?? '').trim();
    return Boolean(id) && readConfig().readonlyAgents.includes(id);
  }

  /**
   * D3 (0.4.0): the capability mismatch that used to be invisible. A hand-off
   * whose `expected` is `implement` but whose counterpart is read-only can only
   * end in `BLOCKED` (the pilot's D1a shape), so the result names it and gives
   * the two ways out. `research` never warns — it is legal for every agent.
   */
  function capabilityNote(agent: unknown, expected: unknown): string | undefined {
    if (String(expected ?? '') !== 'implement') return undefined;
    if (!isReadonlyAgent(agent)) return undefined;
    const id = String(agent ?? '').trim();
    return (
      `注: 承接方为只读 agent（${id}），implement 期望可能无法完成；建议 expected:"research"（只读排查 + 结论）` +
      '或显式 collab_promote { target, confirm:true } 之后再交接。'
    );
  }

  /**
   * `queue` is the default. Read-only agents never get `steer`: an inbound
   * hand-off must not merge into the turn they are already running.
   */
  function resolveMode(requested: unknown, agent: unknown): DeliveryMode {
    if (isReadonlyAgent(agent)) return { mode: 'queue', forced: true };
    return { mode: requested === 'steer' ? 'steer' : 'queue', forced: false };
  }

  /**
   * R5 (0.6.0) / R1 (0.7.0): content-level idempotency for `collab_send` / `collab_reply`.
   *
   * The record layer only ever deduped `cid` / ack traffic, so the **same text**
   * sent twice into the same thread 15 s apart was delivered twice (observed).
   * Three sources are consulted, cheapest first — all read-only:
   *
   *   ① the hand-off record's own recent `replies` (a bounded receipt lands
   *     there, `DEDUPE_REPLY_LOOKBACK` of them);
   *   ② the thread's own message list — the persistent source (survives a plugin
   *     reload; `dispatch` appends every admitted body there);
   *   ③ a process-local memo, for a send that never became a thread message.
   *
   * ④ (0.7.0, R1) the **target** memo: the same normalised body already went to
   *   this session on *another* thread. Checked last, so a same-thread repeat
   *   keeps the 0.6.0 receipt word for word; a target hit reports the thread
   *   that actually carried the earlier copy.
   *
   * Nothing is ever delivered *or* appended when this hits: the caller gets the
   * readback ("未重复投递") instead of a silent second copy.
   */
  async function findDuplicateSend({
    threadID,
    target,
    text,
    record,
    now = Date.now()
  }: {
    threadID: string;
    target?: string;
    text: string;
    record?: BroadcastRecord;
    now?: number;
  }): Promise<DuplicateSend | undefined> {
    const windowMs = Math.max(0, Number(readConfig().dedupeWindowMs) || 0);
    if (!windowMs) return undefined; // `dedupeWindowMs:0` = off (rollback switch)
    const thread = String(threadID ?? '');
    const norm = normalizeSendBody(text);
    if (!norm) return undefined;
    const fresh = (at: number): boolean => Number.isFinite(at) && at > 0 && now - at <= windowMs && now >= at;

    for (const reply of (record?.replies ?? []).slice(-DEDUPE_REPLY_LOOKBACK)) {
      const at = Number(reply?.at) || 0;
      if (fresh(at) && normalizeSendBody(reply?.text) === norm) return { at, source: 'record' };
    }

    if (thread) {
      const stored = await threads.read(thread);
      // The tail only: an old message in a long-lived thread is history, not a repeat.
      for (const message of [...(stored?.msgs ?? [])].reverse().slice(0, 20)) {
        const at = Number(message?.ts) || 0;
        if (!fresh(at)) continue;
        if (normalizeSendBody(message?.text) === norm) return { at, source: 'thread' };
      }

      const memoAt = sendMemo.get(sendKey(thread, text));
      if (memoAt && fresh(memoAt)) return { at: memoAt, source: 'memo' };
    }

    // ④ target dimension: the same words already reached this session — whichever
    // thread carried them, they are not a new message.
    const to = String(target ?? '').trim();
    if (to) {
      const hit = targetSendMemo.get(targetSendKey(to, text));
      if (hit && fresh(hit.at)) {
        return {
          at: hit.at,
          source: 'target',
          threadID: hit.threadID,
          ...(hit.bid ? { bid: hit.bid } : {})
        };
      }
    }
    return undefined;
  }

  /** Delivery + thread bookkeeping shared by `collab_send` and `collab_reply`. */
  async function dispatch({
    context,
    input,
    kind,
    threadID,
    mode,
    forced,
    notes,
    target,
    allowProtectedReply = false,
    force = false
  }: {
    context: ToolContext | undefined;
    input: JsonObject | undefined;
    kind: string;
    threadID: string | undefined;
    mode: string;
    forced: boolean;
    notes: string[];
    target: Target;
    allowProtectedReply?: boolean;
    force?: boolean;
  }): Promise<ToolResult & { delivery?: DeliveryOutcome }> {
    const config = readConfig();
    const body = String(input?.text ?? '').trim();
    if (!body) throw invalid('text 不能为空');

    const { sessionID, alias, info } = target;
    const from = senderLabel(context?.sessionID);
    const cid = newCorrelationID();
    const text = envelope({ from, kind, threadID, body });
    const targetLine =
      `${sessionID}${alias ? ` (alias=${alias})` : ''}  agent=${info?.agent ?? '?'}  ` +
      `state=${sessionState(info)}  title="${truncate(info?.title ?? '(untitled)', 60)}"`;
    const confirmed = input?.confirm === true;
    const dedupeWindowMs = Math.max(0, Number(config.dedupeWindowMs) || 0);
    const bid = String(input?.bid ?? '').trim();
    // R3 (0.7.0): `force:true` means "I know it is a repeat, send it" — both de-dup
    // levels are skipped and the overridden write is *marked*, never silent.
    const dedupeForced = confirmed && force && dedupeWindowMs > 0;

    // R5 (0.6.0) + R1 (0.7.0, `11-19-collab-dedupe-target`): content idempotency,
    // for a confirmed call only — a preview writes nothing (including the index),
    // so it must not report or consume somebody else's window.
    //
    // Looked up **before** the protect guard so a body that already reached this
    // target is answered with the read-back instead of being judged as a brand-new
    // push (nothing is delivered either way, so no boundary moves). The refusal
    // below still wins: a target that may not be written to never learns
    // "already sent" — that would replace a fail-closed error with a delivery
    // history hint, i.e. a widening by accident.
    let duplicate: DuplicateSend | undefined;
    if (confirmed && dedupeWindowMs > 0 && !force) {
      duplicate = await findDuplicateSend({
        threadID: threadID ?? '',
        target: sessionID,
        text: body,
        ...(bid ? { record: readBroadcast(bid) } : {})
      });
    }

    // Lineage guard: the target itself *or* any ancestor in the protect list.
    // Fail-closed, replies included — see the note in `docs/collab.md` §11.4.
    // R2: the single exception is a *bounded* reply — this bid's own requester,
    // from this bid's own claimant, as `kind:reply` — decided before the call by
    // `canReplyToProtected`; nothing else may bypass the guard (a closed record
    // stays refused: R5's post-closure conclusion is a pull, not a push).
    const guard = await createLineage(ctx).protectedAncestor(sessionID, config.protect);
    if (guard && !allowProtectedReply) {
      // R1 (guard-conflict): the whitelist itself says this is the receipt of
      // this very bid (live record, target = its requester, sender = its
      // claimant) yet the caller passed `allowProtectedReply:false` — a call
      // site forgot to consult `canReplyToProtected`, or the whitelist was
      // bypassed. That is a plugin defect, not a caller error, so it is
      // reported (and still refused) instead of being a plain validation error.
      if (
        canReplyToProtected({
          kind,
          target: sessionID,
          sender: context?.sessionID,
          bid: input?.bid,
          text: input?.text,
          mode
        })
      ) {
        throw new GuardConflictError(
          `护栏与指令冲突：本条是发往受保护发起方 ${sessionID} 的限界回执` +
            `（kind=reply + 该 bid 的领取人本人），白名单本应放行却未生效。已按插件缺陷上报，未发送任何内容。`,
          { bid: String(input?.bid ?? '') || undefined, target: sessionID }
        );
      }
      const where = guard.depth === 0 ? '本身' : `的祖先（第 ${guard.depth} 级）${guard.sessionID} `;
      // R2 (0.1.4): a receipt shaped the ≤0.1.1 way (`request` + `[handoff]`
      // body) is refused for exactly one reparable reason — the missing
      // `kind:"reply"`. Say so, with the command to copy, instead of only
      // "target is protected" (that is what kept the legacy hand-offs stuck).
      const legacyReceipt =
        normalizeKind(kind) !== 'reply' && HANDOFF_LINE_RE.test(body)
          ? canReplyToProtected({
              kind: 'reply',
              target: sessionID,
              sender: context?.sessionID,
              bid: input?.bid,
              text: input?.text
            })
          : undefined;
      const hint = legacyReceipt
        ? '提示：这是遗留回执，请加 kind:"reply" 重发（或让对端升级到 0.1.4+）：\n' +
          `  collab_send {target:"${sessionID}", kind:"reply", text:"[handoff] DONE ${legacyReceipt.bid} <摘要>", confirm:true}`
        : kind === 'reply'
          ? '回执同样适用该护栏（fail-closed）；只有「本单发起方 + 该单领取人 + 该 bid」的 kind=reply 回执是白名单例外。'
          : '';
      throw invalid(
        `拒绝投递：目标 ${sessionID}${alias ? `（别名 ${alias}）` : ''} ${where}在 protect 名单内` +
          `（${CONFIG_PATH} 的 protect + 内置硬名单，覆盖其任意层级子会话）。未发送任何内容。${hint}`
      );
    }
    if (context?.sessionID && context.sessionID === sessionID) {
      throw invalid('拒绝投递：target 就是当前会话本身（会导致自我排队）。未发送任何内容。');
    }

    // The read-only hit from above, now that no refusal applies: not delivered,
    // not appended — the caller gets the read-back (and the way to force it).
    if (duplicate) {
      if (duplicate.source === 'target') {
        const earlierThread = String(duplicate.threadID ?? '');
        return {
          content: [
            `未重复投递: 目标 ${sessionID} 在 ${dedupeWindowLabel(dedupeWindowMs)} 内已有同文（target 维度去重），` +
              `已在 thread ${earlierThread || '(未知)'} 发过同文；本次未投递、也未追加回复。`,
            `目标: ${targetLine}`,
            `kind=${kind}  本次 thread=${threadID ?? '-'}  命中来源=target  上次=${earlierThread || '(未知)'} @ ${fmtTime(duplicate.at)}`,
            '只有正文归一化后完全一致才算重复（空白差异会被折叠）。确实要再发一次：force:true（强制投递，' +
              '回执标注 dedupeOverridden）/ 改一处措辞 / 把 collab.json 的 dedupeWindowMs 设为 0 关闭去重。',
            earlierThread
              ? `读回已有消息: collab_wait { threadID:"${earlierThread}" } 或 collab_inbox`
              : '读回已有消息: collab_inbox'
          ].join('\n')
        };
      }
      return {
        content: [
          `未重复投递: thread ${threadID} 在 ${dedupeWindowLabel(dedupeWindowMs)} 内已有同文（去重窗口），` +
            `本次未投递、也未追加回复。`,
          `目标: ${targetLine}`,
          `kind=${kind}  命中来源=${duplicate.source}  上次=${fmtTime(duplicate.at)}`,
          '只有正文归一化后完全一致才算重复（空白差异会被折叠）。确实要再发一次：force:true（强制投递，' +
            '回执标注 dedupeOverridden）/ 改一处措辞 / 换 threadID / 把 collab.json 的 dedupeWindowMs 设为 0。',
          `读回已有消息: collab_wait { threadID:"${threadID}" } 或 collab_inbox`
        ].join('\n')
      };
    }

    const modeLine = forced || (guard && allowProtectedReply) ? 'queue(forced)' : mode;
    const delivery = guard && allowProtectedReply ? 'queue' : mode;
    const tailNotes = [...(notes ?? [])];
    if (forced) tailNotes.push('只读 agent：已强制 queue（入队，不打断对方当前轮）。');
    if (guard && allowProtectedReply) {
      tailNotes.push(
        '本单由该受保护会话发起：回执按白名单放行（kind=reply + bid 归属该记录 + 领取人本人），强制 queue 投递。'
      );
    }

    if (!confirmed) {
      return {
        content: [
          '未投递（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。',
          `目标: ${targetLine}`,
          `kind=${kind}  thread=${threadID}`,
          `模式: ${modeLine}`,
          ...tailNotes.map(note => `注: ${note}`),
          '将发送:',
          text
        ].join('\n')
      };
    }

    // R2 (0.6.0): any writing collab call refreshes this session's waiter
    // heartbeat (throttled ≥30s inside) — the context hook is not the only path.
    await touchWaiters(context?.sessionID);

    const admittedAt = Date.now();
    const admitted = await deliverPrompt({
      sessionID,
      text,
      delivery,
      metadata: {
        collab: {
          from,
          fromSessionID: context?.sessionID ?? 'unknown',
          cid,
          kind,
          threadID,
          ts: admittedAt
        }
      }
    });

    const thread = threadID
      ? await threads.update(threadID, current =>
          appendThreadMessage(current, {
            threadID,
            cid,
            kind,
            text: truncateRaw(body, INBOX_TEXT_LIMIT),
            ts: Date.now(),
            from,
            fromSession: context?.sessionID ?? 'unknown',
            toSession: sessionID
          })
        )
      : undefined;

    // R5 (0.6.0): remember this body for the in-process half of the check. A
    // thread message is the persistent half and needs no memo.
    if (threadID) rememberSend(threadID, body, admittedAt);
    // R1 (0.7.0, `11-19-collab-dedupe-target`): the target half — whichever
    // thread carried it, this body just reached this session.
    rememberTargetSend(sessionID, threadID ?? '', body, admittedAt, bid || undefined);

    if (dedupeForced) {
      // R3: a forced repeat is delivered *and* marked — never a silent override.
      // The record annotation is display-only: `state` / `claim` / `receipt` stay
      // exactly as they are (read-merge-write, no field dropped).
      tailNotes.push(
        'dedupeOverridden: 本次按 force:true 发送（thread 与 target 两级去重判定都跳过；窗口内若确有同文，已按你的要求重复投递）。'
      );
      const record = bid ? readBroadcast(bid) : undefined;
      if (record) {
        writeBroadcast({ ...record, dedupeOverriddenAt: admittedAt });
        tailNotes.push(`record ${bid} 已标注 dedupeOverriddenAt（只读标记，不改 state/claim/receipt）。`);
      }
    }

    return {
      content: [
        `已投递 → ${targetLine}`,
        `kind=${kind}  thread=${threadID}  status=${thread?.status ?? '-'}`,
        `mode=${modeLine}  message=${admitted?.id ?? '?'}  delivery=${admitted?.delivery ?? '?'}`,
        ...tailNotes.map(note => `注: ${note}`),
        kind === 'request'
          ? '提示: 对方回执后可 collab_wait {threadID} 等结果；不要用 steer 打断对方的当前轮。'
          : kind === 'reply'
            ? '提示: 回执已记入 thread；对端可用 collab_wait {threadID} 取到全文。'
            : '提示: note 只作通知，不改变 thread 状态。'
      ].join('\n'),
      // R1 (0.1.6): the admission receipt the caller writes into the record
      // (`delivery`), so the receiver can ack it and the sender can resend.
      delivery: { cid, to: sessionID, messageId: admitted?.id, admittedAt }
    };
  }

  /**
   * Wait for a reply on a thread. Only replies *after the last request* count, so
   * reusing a thread (`collab_send` with an existing `threadID`) cannot return the
   * previous round's reply. Ordering comes from the append order in `msgs` (ts can
   * collide within the same millisecond); threads without a recorded request fall
   * back to "any reply", which keeps old data working.
   */
  async function waitForReply(
    threadID: string,
    timeoutMs: number,
    context: ToolContext | undefined
  ): Promise<ToolResult> {
    const deadline = Date.now() + timeoutMs;
    const me = context?.sessionID;
    const notes: string[] = [];

    const initial = await threads.read(threadID);
    if (!initial) {
      throw invalid(
        `没有 thread ${threadID}：threadID 可能拼错，或该 thread 由别的项目/目录（不同 location）创建。` +
          `请用 collab_inbox 核对 threadID；若请求刚发出，稍后重试。`
      );
    }
    if (me && me !== initial.fromSession && me !== initial.toSession) {
      throw invalid(
        `拒绝等待：当前会话 ${me} 不是 thread ${threadID} 的参与方` +
          `（发起方 ${initial.fromSession ?? '?'}，对端 ${initial.toSession ?? '?'}）。`
      );
    }
    if (!me) notes.push('无会话上下文（无 sessionID）：未校验参与者身份。');

    for (;;) {
      const thread = await threads.read(threadID);
      const msgs = thread?.msgs ?? [];
      let lastRequest = -1;
      for (const [index, message] of msgs.entries()) {
        if (normalizeKind(message.kind) === 'request') lastRequest = index;
      }
      const replies = msgs
        .slice(lastRequest + 1)
        .filter(message => normalizeKind(message.kind) === 'reply')
        .filter(message => !me || message.fromSession !== me);
      if (replies.length) {
        const reply = replies[replies.length - 1];
        return {
          content: [
            `thread ${threadID} 收到回执（status=${thread?.status ?? '-'}）:`,
            `from=${reply.from} (${reply.fromSession})  ${fmtTime(reply.ts)}`,
            '',
            String(reply.text ?? ''),
            ...notes.map(note => `注: ${note}`)
          ].join('\n')
        };
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw invalid(
          `等待回执超时：thread ${threadID} 在 ${timeoutMs}ms 内没有新的 kind=reply 消息` +
            `（只看最后一次 request 之后的回执；可加大 timeoutMs，或让对端 collab_reply {threadID}）`
        );
      }
      await signal.wait(Math.min(REPLY_POLL_MS, left));
    }
  }

  /**
   * The 接管请求: one queued prompt to the chosen candidate, used both for the
   * `busy > 30min` wake-up of a peer broadcast and for telling a freshly spawned
   * session what to do. `queue` only — the plugin never interrupts anyone.
   *
   * R1/R2 (0.1.6): the delivery is recorded on the record (`delivery.cid` /
   * `to` / `messageId` / `admittedAt` / `failedAt` / `resends`), so the receiving
   * plugin can ack it and the requester can resend / show `admitted · seen`.
   * The `cid` is **reused** across wake / spawn / resend for the same target —
   * one message id per hand-off, which is what keeps the receiving side's
   * de-duplication working when the same text arrives twice.
   *
   * Returns the (written) record too: the caller must not keep writing a stale
   * copy of it, or the delivery bookkeeping would be clobbered.
   */
  async function deliverAsk({
    record,
    target,
    wake,
    threadID,
    spawn = false
  }: {
    record: JsonObject;
    target: string;
    wake: boolean;
    threadID?: string;
    spawn?: boolean;
  }): Promise<{ delivered: boolean; record: BroadcastRecord }> {
    const current = readBroadcast(String(record?.bid ?? '')) ?? (record as BroadcastRecord);
    const config = readConfig();
    const guard = await createLineage(ctx).protectedAncestor(target, config.protect);
    if (guard) return { delivered: false, record: current }; // never deliver into a protected line
    // R2 (0.6.0): a hand-off attempt is a writing collab call — it also counts as
    // the requester's waiter heartbeat (throttled ≥30s inside).
    await touchWaiters(current.from?.sid);
    const requester = String(record?.from?.sid ?? '');
    const from = senderLabel(requester) || 'handoff';
    const previous = current.delivery ?? {};
    // Same message, same cid — a wake / spawn / resend is not a new message.
    const cid = previous.to === target && previous.cid ? String(previous.cid) : newCorrelationID();
    const at = Date.now();
    const base = {
      ...previous,
      cid,
      to: target,
      admittedAt: Number(previous.admittedAt) || at,
      lastAttemptAt: at,
      ...(previous.ackUnavailable ? {} : {})
    };
    try {
      const admitted = await deliverPrompt({
        sessionID: target,
        text: envelope({
          from,
          kind: 'request',
          threadID,
          body: takeoverBody({ record: current, wake, spawn })
        }),
        delivery: 'queue',
        metadata: {
          collab: {
            from,
            fromSessionID: record?.from?.sid ?? 'unknown',
            cid,
            kind: 'request',
            threadID,
            ts: at
          }
        }
      });
      // F1 (review): merge into the *current* record — this write happens after
      // an `await`, so a concurrent `seenAt` (the receiver's `[ack]`) must not
      // be overwritten by the pre-await snapshot.
      return {
        delivered: true,
        record:
          mergeDelivery(current.bid, {
            ...base,
            messageId: admitted?.id ?? previous.messageId,
            failedAt: undefined
          }) ?? current
      };
    } catch (error) {
      log(`deliverAsk failed for ${target}: ${errText(error)}`);
      // A takeover request that could not be delivered used to be a log line
      // only — exactly the "silent hang" this task exists for. Reporting is a
      // side path: the hand-off still follows its lease path (R2: the failed
      // admission is the one case that may be retried without waiting 2h).
      const written = mergeDelivery(current.bid, { ...base, failedAt: at }) ?? current;
      await deps.reporter.reportNow({
        tool: 'collab_handoff',
        defect: classify(error) ?? 'delivery-5xx',
        error,
        input: { bid: String(record?.bid ?? ''), target }
      });
      return { delivered: false, record: written };
    }
  }

  /**
   * R3 (0.1.6): what `collab_wait`/`collab_list` show about the delivery of the
   * hand-offs a thread or a target is part of. Read-only: no refresh, no write.
   */
  function deliveryStatus({ threadID, target }: { threadID?: string; target?: string }): string[] {
    const now = Date.now();
    const thread = threadID ? String(threadID) : '';
    const to = target ? String(target) : '';
    if (!thread && !to) return [];
    return allBroadcasts()
      .filter(record => (thread && String(record.threadID ?? '') === thread) || (to && String(deliveryOf(record).to ?? '') === to))
      .filter(record => deliveryVisible(record, now))
      .map(record => `${record.bid} ${deliveryLine(record, now)}`);
  }

  return {
    deps,
    resolveTarget,
    senderLabel,
    isReadonlyAgent,
    capabilityNote,
    resolveMode,
    findDuplicateSend,
    dispatch,
    waitForReply,
    deliveryStatus,
    deliverAsk
  };
}
