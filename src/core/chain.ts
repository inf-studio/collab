import type { ConfigReader } from '../config.ts';
import {
  ACKED_EXTRACT_MS,
  BCAST_LEASE_MS,
  BCAST_DONE_STATES,
  MAX_STORED,
  OWNER_QUEUE_HINT_LIMIT,
  SCORE_CANDIDATE_LIMIT,
  VERDICT_MESSAGE_LIMIT
} from '../constants.ts';
import { envelope, newCorrelationID, normalizeKind } from '../ids.ts';
import { errText, log } from '../log.ts';
import type {
  BroadcastRecord,
  CollabContext,
  ProposalSummary,
  RankResult,
  RankedCandidate,
  SessionInfoLike
} from '../types.ts';
import { asObject, dedupe, fmtTime, sessionState, shortID, truncate } from '../util.ts';
import {
  buildAck,
  deliveryOf,
  markSeen,
  parseAck,
  resendDue,
  unackedDue
} from './ack.ts';
import { recordKept } from './pacing.ts';
import {
  allBroadcasts,
  declineAsked,
  mergeDelivery,
  normalizeBroadcast,
  persistRefresh,
  readBroadcast,
  refreshBroadcast,
  releaseLock,
  writeBroadcast
} from './claim.ts';
import { archiveIfDue, createArchiveGate } from './archive.ts';
import {
  followUpsOf,
  nextFollowUpHint,
  pendingFollowUpCandidates,
  readFollowUpSeen
} from './followup.ts';
import { createGrants } from './grants.ts';
import type { Grants } from './grants.ts';
import { createLineage } from './lineage.ts';
import { recordMessage } from './index-db.ts';
import { makeEnvelope } from './envelope.ts';
import { unseenCandidates } from './owner-queue.ts';
import { pathsFromMessages, scoreCandidate } from './score.ts';
import {
  assistantTexts,
  DECLINE_BID_RE,
  HANDOFF_DECLINE_RE,
  handoffActions,
  parseReceiptLine,
  protocolHeader,
  receiptAllowed,
  receiptMatches,
  senderName,
  takeoverBody,
  verdictFromTexts
} from './verdict.ts';

export type { RankResult };

/**
 * F1 (0.3.1): the follow-up hint is a **query** now — the lines to render and
 * the seen-keys to stamp. Stamping moved to the `context` hook, after the block
 * is actually pushed onto the request (a thrown push / a dropped block used to
 * lose the hint forever).
 */
export interface FollowUpHintResult {
  lines: string[];
  keys: string[];
  /**
   * D1 (0.4.0): `owner-queue` item ids (`q_…`) that the rendered lines belong
   * to. Same contract as `keys`: the caller stamps `seenAt` only **after** the
   * block was really pushed onto the request. Only a protected session ever
   * carries this list (see `injectionFor`).
   */
  ownerQueue?: string[];
}

/**
 * R7 (0.1.4): what the inbound message declared about itself. `explicit:false`
 * means neither the envelope nor its metadata carried a `kind` — the legacy
 * shape, where the `[handoff]` body is the only signal and may close a record.
 * An explicit `note` / `request` never does; only `reply` does besides.
 */
export interface ReceiptSource {
  kind?: string;
  explicit?: boolean;
}

export interface HandoffChain extends Grants {
  sessionInfo(sessionID: string | undefined): Promise<SessionInfoLike | undefined>;
  listSessions(input?: { directory?: string; limit?: number }): Promise<SessionInfoLike[]>;
  sessionPaths(sessionID: string): Promise<string[]>;
  rankCandidates(input: {
    workspace: string | undefined;
    proposal: ProposalSummary;
    expected: string;
    exclude?: string[];
  }): Promise<RankResult>;
  applyReceipt(
    text: unknown,
    from: unknown,
    now?: number,
    source?: ReceiptSource
  ): Promise<BroadcastRecord | undefined>;
  applyDecline(text: unknown, from: unknown, now?: number): Promise<BroadcastRecord | undefined>;
  /**
   * R1 (0.1.6): an `[ack] <cid> seen` note from a receiving plugin. Only the
   * session the message was delivered to may confirm it; the first ack writes
   * `delivery.seenAt`, repeats are no-ops.
   */
  applyAck(text: unknown, from: unknown): Promise<BroadcastRecord | undefined>;
  /**
   * R1 (0.1.6): the receiving side of the ack — best-effort, once per `cid`,
   * never throws. A protected requester gets `ackUnavailable` instead of a
   * delivery attempt (R4).
   */
  ackSeen(sessionID: string | undefined, cids: string[]): Promise<void>;
  /** R2 (0.1.6): sender-side bounded resend (idle target only). */
  resendIfDue(
    record: BroadcastRecord | undefined,
    now?: number,
    actor?: string
  ): Promise<BroadcastRecord | undefined>;
  /** R5 (0.1.6): the read-only "proposal has an append" hint(s), one per request. */
  followUpHints(sessionID: string | undefined): Promise<FollowUpHintResult>;
  notifyRequester(
    record: BroadcastRecord,
    input: { text: string; kind?: string; from?: string; threadID?: string }
  ): Promise<{ delivered: boolean; message?: string; reason?: string; error?: unknown }>;
  injectionFor(sessionID: string | undefined, directory: string | undefined): Promise<FollowUpHintResult>;
  extractVerdict(
    sessionID: string | undefined,
    input?: { since?: number; bid?: string }
  ): Promise<{ state: 'done' | 'blocked'; summary: string } | undefined>;
  refresh(
    record: BroadcastRecord | undefined,
    now?: number,
    input?: { actor?: string }
  ): Promise<BroadcastRecord | undefined>;
}

/**
 * R1 (0.4.1): one candidate line of a protected session's injection, **before**
 * de-duplication. Two read-only sources produce it — a closed hand-off's
 * pending `followUps` entry and an unread `[owner-queue]` item — and both may
 * name the same proposal, which used to cost one line each (the same proposal
 * bombarding the owner twice).
 */
interface ProtectedHint {
  at: number;
  bid?: string;
  issuePath?: string;
  /**
   * R1 (0.4.1, P2): **every** proposal key this hint carries — `path:<normalized>`
   * and/or `bid:<bid>`. Two hints naming the same proposal share at least one key
   * even when only one of them knows the path (`collab_request_owner { bid }`
   * without `issuePath`), so a single "path first, else bid" key was too coarse.
   * An empty list means "cannot be proven to be the same proposal" → never merged.
   */
  keys: string[];
  line: string;
  /** follow-up seen key (`<sid>:<bid>:<at>`) — stamped after the push. */
  key?: string;
  /** owner-queue item id — stamped after the push. */
  queueID?: string;
  source: 'followup' | 'owner-queue';
}

/** R1 (0.4.1, P2): the proposal keys of a hint — path and bid may both be present. */
function hintKeys(issuePath: string | undefined, bid: string | undefined): string[] {
  const keys: string[] = [];
  if (issuePath) keys.push(`path:${issuePath}`);
  if (bid) keys.push(`bid:${bid}`);
  return keys;
}

/** R1 (0.4.1): within one proposal group, does `hint` replace `previous`? */
function hintIsNewer(hint: ProtectedHint, previous: ProtectedHint | undefined): boolean {
  if (!previous) return true;
  if (hint.at !== previous.at) return hint.at > previous.at;
  // Same millisecond (only possible across sources / hand-written items): the
  // conclusion wins over the nudge; otherwise the first one seen is kept.
  return hint.source === 'followup' && previous.source !== 'followup';
}

/**
 * R1 (0.4.1): merge the two protected-session hint sources into at most
 * `OWNER_QUEUE_HINT_LIMIT` lines, one per proposal.
 *
 *   - a candidate is identified by **all** the keys it carries (`path:…`,
 *     `bid:…`); any shared key means "same proposal", and the relation is
 *     transitive (A shares a path with B, B shares a bid with C → one group).
 *     So a queue item that only knows the `bid` still merges with the follow-up
 *     that knows both, which a single `issuePath ? path : bid` key did not;
 *   - a candidate with no key at all is never merged (nothing proves it is the
 *     same thing), so two unrelated queue items both still render;
 *   - the **newest** `at` wins (a later append beats an older nudge; on the same
 *     millisecond the conclusion wins over the nudge);
 *   - the survivors are sorted `at` ascending and capped — oldest first, the same
 *     FIFO order the queue alone used;
 *   - only the survivors are returned, so only they get stamped (R2): a merged
 *     away entry stays pending and can be shown on the next request.
 */
function dedupeProtectedHints(hints: ProtectedHint[]): ProtectedHint[] {
  // Union–find over the candidates (a proposal group may be built from both
  // sources, in any order), then the newest member of each group survives.
  const ordered = [...hints].sort((a, b) => a.at - b.at);
  const roots = ordered.map((_, index) => index);
  const find = (start: number): number => {
    let root = start;
    while (roots[root] !== root) root = roots[root];
    let cursor = start;
    while (roots[cursor] !== root) {
      const next = roots[cursor];
      roots[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const firstWithKey = new Map<string, number>();
  ordered.forEach((hint, index) => {
    for (const key of hint.keys) {
      const previous = firstWithKey.get(key);
      if (previous === undefined) {
        firstWithKey.set(key, index);
        continue;
      }
      const a = find(index);
      const b = find(previous);
      if (a !== b) roots[a] = b;
    }
  });
  const groups = new Map<number, ProtectedHint>();
  ordered.forEach((hint, index) => {
    const root = find(index);
    const previous = groups.get(root);
    if (hintIsNewer(hint, previous)) groups.set(root, hint);
  });
  return [...groups.values()].sort((a, b) => a.at - b.at).slice(0, OWNER_QUEUE_HINT_LIMIT);
}

/**
 * Shared core of the hand-off chain: session enumeration, matching score,
 * receipt parsing and the "what should this session see" query used by the
 * `context` hook. Both scopes (`local` / `peer`) go through it, so the ranking
 * rules and the idempotency guarantees are the same for a same-workspace
 * hand-off and a cross-workspace broadcast.
 */
export function createHandoffChain(ctx: CollabContext, readConfig: ConfigReader): HandoffChain {
  // Short-lived caches: a session that starts touching a file (or goes idle)
  // while we are ranking must not be judged on a snapshot from minutes ago.
  const INFO_TTL_MS = 60_000;
  const PATH_TTL_MS = 120_000;
  const infoCache = new Map<string, { at: number; value: SessionInfoLike | undefined }>();
  const pathCache = new Map<string, { at: number; paths: string[] }>();
  // 0.5.0: the archive gate (design §1). It reads sessions **fresh** through its
  // own `sessionInfo`, because the 60s `infoCache` above may still say "idle"
  // after the session started working — exactly the case that must not archive.
  const archiveGate = createArchiveGate(ctx, readConfig);

  async function sessionInfo(sessionID: string | undefined): Promise<SessionInfoLike | undefined> {
    if (!sessionID) return undefined;
    const hit = infoCache.get(sessionID);
    if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit.value;
    let info: SessionInfoLike | undefined;
    try {
      info = await ctx.session.get({ sessionID });
    } catch {
      info = undefined;
    }
    infoCache.set(sessionID, { at: Date.now(), value: info });
    return info;
  }

  /**
   * Sessions of one workspace (root + children, caller filters). `directory` is
   * passed to the host so a big instance does not page every session in; the
   * result is also filtered locally, because `ctx.session.list` may ignore the
   * field on older hosts.
   */
  async function listSessions({ directory, limit = 100 }: { directory?: string; limit?: number } = {}): Promise<
    SessionInfoLike[]
  > {
    let page;
    try {
      page = directory ? await ctx.session.list({ directory, limit }) : await ctx.session.list({ limit });
    } catch {
      page = await ctx.session.list({ limit }).catch(() => []);
    }
    const sessions = Array.isArray(page) ? page : Array.isArray(page?.data) ? page.data : [];
    if (!directory) return sessions;
    return sessions.filter(info => {
      const dir = info?.location?.directory;
      return dir === undefined || dir === directory;
    });
  }

  /** Files a session touched (tool inputs only, in-memory, never persisted). */
  async function sessionPaths(sessionID: string): Promise<string[]> {
    const hit = pathCache.get(sessionID);
    if (hit && Date.now() - hit.at < PATH_TTL_MS) return hit.paths;
    let paths: string[] = [];
    try {
      const result = await ctx.session.context({ sessionID });
      const messages = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [];
      paths = pathsFromMessages(messages);
    } catch {
      return []; // unreadable session: it simply scores on its metadata (not cached)
    }
    pathCache.set(sessionID, { at: Date.now(), paths });
    return paths;
  }

  /**
   * Group members of `workspace`: root sessions only, never `[protected]` /
   * `[protected-child]`. Scored against the proposal and returned sorted.
   */
  async function rankCandidates({
    workspace,
    proposal,
    expected,
    exclude = []
  }: {
    workspace: string | undefined;
    proposal: ProposalSummary;
    expected: string;
    exclude?: string[];
  }): Promise<RankResult> {
    const config = readConfig();
    const listed = await listSessions({ directory: workspace, limit: 100 });
    const lineage = createLineage(ctx);
    lineage.seed(listed);
    const now = Date.now();
    const pool: SessionInfoLike[] = [];
    for (const info of listed) {
      if (!info?.id || exclude.includes(info.id)) continue;
      if (info.parentID) continue; // sub-sessions are not group members
      if (asObject(info.time).archived) continue;
      if (await lineage.protectedAncestor(info.id, config.protect)) continue;
      pool.push(info);
    }
    pool.sort((a, b) => Number(b?.time?.updated ?? 0) - Number(a?.time?.updated ?? 0));
    const ranked: RankedCandidate[] = [];
    for (const info of pool.slice(0, SCORE_CANDIDATE_LIMIT)) {
      const paths = await sessionPaths(info.id);
      ranked.push({ ...scoreCandidate({ info, paths, proposal, expected, now }), info });
    }
    ranked.sort((a, b) => b.score - a.score || Number(b.info?.time?.updated ?? 0) - Number(a.info?.time?.updated ?? 0));
    return { candidates: ranked, members: pool.length };
  }

  /**
   * Parse a receipt out of an inbound message and close the matching hand-off.
   * An exact `bid` / `threadID` match wins over a full-`issuePath` match, and
   * only the claiming session may close it, so re-broadcasting an edited
   * proposal (new bid, same issuePath) or a same-named proposal of another
   * workspace cannot close the wrong hand-off. Returns the updated record, or
   * undefined when the text carries no `[handoff] DONE|BLOCKED` line / matches
   * nothing / comes from a non-claimant. Async because the refresh in front of
   * it may auto-close a lapsed spawn hand-off (R2).
   *
   * R7 (0.1.4): the body is only allowed to speak for a message that did **not**
   * declare a kind. An explicit `note` / `request` is a deliberate non-receipt
   * (it may well be quoting the takeover template) and never moves a record;
   * `reply` does, and silence (legacy CLI text / ≤0.1.1 receipts) does too.
   */
  async function applyReceipt(
    text: unknown,
    from: unknown,
    now = Date.now(),
    source?: ReceiptSource
  ): Promise<BroadcastRecord | undefined> {
    const sourceKind = source?.kind ? normalizeKind(source.kind) : undefined;
    if (source?.explicit && sourceKind !== 'reply') return undefined;
    const receipt = parseReceiptLine(text);
    if (!receipt) return undefined;
    const open: BroadcastRecord[] = [];
    for (const raw of allBroadcasts()) {
      // R2: same refresh as the read paths, so a lapsed spawn is auto-closed
      // here instead of being reopened just before the receipt is applied.
      const record = persistRefresh(raw, await refresh(raw, now, { actor: String(from) }));
      if (!record || BCAST_DONE_STATES.includes(String(record.state))) continue;
      if (!receiptAllowed(record, from)) continue;
      open.push(record);
    }
    const record =
      open.find(entry => entry.bid === receipt.target || entry.threadID === receipt.target) ??
      open.find(entry => receiptMatches(entry, receipt.target));
    if (!record) return undefined;
    releaseLock(record.bid, [String(record.claim?.by ?? ''), String(record.claim?.spawner ?? '')]);
    return writeBroadcast({
      ...record,
      state: receipt.state,
      receipt: {
        from: String(from ?? record.claim?.by ?? '') || undefined,
        at: now,
        note: receipt.note,
        // R8: how the receipt was recognised — an explicit `kind:"reply"` or a
        // legacy body (`[handoff] …`) — so triage can tell them apart.
        source: sourceKind === 'reply' ? 'kind' : 'body'
      },
      replies: [...(record.replies ?? []), { from: String(from ?? 'unknown'), at: now, text: receipt.note }].slice(
        -MAX_STORED
      )
    });
  }

  /**
   * `DECLINE` from the currently asked candidate: skip it, count one attempt and
   * ask the next candidate. Returns the updated record, or undefined when the
   * text carries no DECLINE / the sender is not the asked session (so an
   * unrelated message mentioning the word cannot derail a hand-off).
   *
   * R1-3: the bid inside the text wins. One session can owe an answer on several
   * hand-offs at once, so a bid-less DECLINE is only applied when exactly one
   * open hand-off is waiting for that session — otherwise it is ignored rather
   * than applied to a guessed one.
   */
  async function applyDecline(text: unknown, from: unknown, now = Date.now()): Promise<BroadcastRecord | undefined> {
    const raw = String(text ?? '');
    if (!from || !HANDOFF_DECLINE_RE.test(raw)) return undefined;
    const wanted = DECLINE_BID_RE.exec(raw)?.[1];
    const open: BroadcastRecord[] = [];
    for (const entry of allBroadcasts()) {
      const record = persistRefresh(entry, await refresh(entry, now, { actor: String(from) }));
      if (record && record.state === 'open' && record.asked?.sid === String(from)) open.push(record);
    }
    if (!open.length) return undefined;
    if (wanted) {
      const record = open.find(entry => entry.bid === wanted);
      if (!record) return undefined; // wrong bid: never touch the other hand-offs
      return writeBroadcast(declineAsked({ ...record }, String(from), now));
    }
    if (open.length > 1) return undefined; // ambiguous without a bid: leave all of them alone
    return writeBroadcast(declineAsked({ ...open[0] }, String(from), now));
  }

  /**
   * R2: last assistant answers of one session — **read-only**, at most
   * `VERDICT_MESSAGE_LIMIT` of them. `ctx.session.context` is the plugin-side
   * mapping of `GET /api/session/{sid}/context` (a `Session.Message.Info[]`), so
   * this reads the same history `docs/collab.md` §4 lists for `messages`.
   * A deleted session / a host without the read path yields `[]` (never throws).
   */
  async function assistantAnswer(
    sessionID: string | undefined,
    { since = 0 }: { since?: number } = {}
  ): Promise<string[]> {
    if (!sessionID) return [];
    let result;
    try {
      // L1: ask the host for the tail only. The plugin ctx may ignore the
      // option; a host that rejects it still gets the old full read, so a
      // missing `limit` support cannot disable R2.
      result = await ctx.session.context({ sessionID, limit: VERDICT_MESSAGE_LIMIT });
    } catch {
      try {
        result = await ctx.session.context({ sessionID });
      } catch {
        return [];
      }
    }
    const messages = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [];
    return assistantTexts(messages, { since });
  }

  /**
   * Verdict the claimed session wrote in its own answer, or `undefined` when it
   * cannot be judged. `bid` is the hand-off being closed (H1): a `[handoff]`
   * line for another bid — or the template echo of this very bid — is not a
   * receipt. Failure never propagates: a missing session, an empty history or a
   * host error simply means "fall back to the old lease logic".
   */
  async function extractVerdict(
    sessionID: string | undefined,
    { since = 0, bid }: { since?: number; bid?: string } = {}
  ): Promise<{ state: 'done' | 'blocked'; summary: string } | undefined> {
    if (!sessionID) return undefined;
    try {
      return verdictFromTexts(await assistantAnswer(sessionID, { since }), { bid });
    } catch {
      return undefined;
    }
  }

  /**
   * Lease refresh with the auto-receipt in front of it:
   *   `claimed` + lease lapsed (any `claim.kind`) **+ the caller is the
   *   requester** → read the claimant's own answer once. A verdict closes
   *   the hand-off (`done` / `blocked`, receipt with `auto:true` and a
   *   ≤200-char summary) — **no reopen, no `attempts++`, no new session**.
   *   No verdict / unreadable session → the unchanged `refreshBroadcast` path.
   *
   * H2 (review): `actor` is the session that triggered this refresh. Only the
   * hand-off's own requester (`record.from.sid`) may auto-close from the
   * counterpart's answer; a same-workspace bystander or a session of another
   * workspace only gets the old lease logic — it must never read the
   * counterpart's body or flip the bid.
   *
   * R7: the read is not limited to `claim.kind = spawn` any more. `accept`
   * (a member that claimed it itself) and `handoff` (a local thread hand-off)
   * used to be left to a pushed receipt forever; both are closed from the
   * claimant's own answer the same way once the lease lapses, so a lost receipt
   * cannot keep a hand-off open for hours.
   *
   * R8: an `acked` hand-off has **no** lease at all, so it used to stay there
   * forever when the receipt never arrived. After `ACKED_EXTRACT_MS` of silence
   * the same read is allowed (requester only, never a protected claimant). A
   * read that finds no verdict leaves the state untouched — no downgrade, no
   * `attempts++` — and only stamps `staleNoticedAt`, so the retry happens at
   * most once per window instead of on every single refresh.
   *
   * The returned record is *not* written: callers keep using `persistRefresh`,
   * which sees the state change and writes it once.
   */
  async function refreshCore(
    record: BroadcastRecord | undefined,
    now = Date.now(),
    { actor }: { actor?: string } = {}
  ): Promise<BroadcastRecord | undefined> {
    if (!record) return record;
    const current = normalizeBroadcast(record);
    const claim = asObject(current.claim);
    const claimAt = Number(claim.at || 0);
    // `lapsed` already requires `claim.by`; R7 drops the old `claim.kind`
    // filter (spawn / accept / handoff all qualify).
    const lapsedClaim =
      current.state === 'claimed' &&
      Boolean(claim.by) &&
      now - claimAt > (Number(claim.leaseMs) || BCAST_LEASE_MS);
    // R8: `acked` is not a lease state, so silence is measured against a fixed
    // 2-hour window; a fresh `acked` claim (the claimant may still be working)
    // is never read. `claimAt > 0` is required: a record without `claim.at`
    // would make `now - 0` look infinitely stale and `since: 0` would treat an
    // ancient answer as the verdict.
    const staleAcked =
      current.state === 'acked' && Boolean(claim.by) && claimAt > 0 && now - claimAt > ACKED_EXTRACT_MS;
    if ((!lapsedClaim && !staleAcked) || !current.from?.sid || !claim.by) return refreshBroadcast(record, now);
    // H2: the requester is the only actor allowed to close from the answer.
    if (!actor || String(actor) !== String(current.from.sid)) return refreshBroadcast(record, now);
    // R3: `[protected*]` sessions never participate — no read, old logic only.
    if (await createLineage(ctx).protectedAncestor(String(claim.by), readConfig().protect)) {
      return refreshBroadcast(record, now);
    }
    // R8: one read per window; between reads there is nothing new to extract.
    if (staleAcked && Number(current.staleNoticedAt ?? 0) && now - Number(current.staleNoticedAt) < ACKED_EXTRACT_MS) {
      return refreshBroadcast(record, now);
    }
    const verdict = await extractVerdict(String(claim.by), {
      since: claimAt,
      bid: current.bid
    });
    if (!verdict) {
      if (!staleAcked) return refreshBroadcast(record, now);
      // No conclusion: leave the hand-off exactly as it is (`acked`, same
      // attempts) and only remember that this window has been checked.
      return { ...current, staleNoticedAt: now };
    }
    const sid = String(claim.by);
    releaseLock(current.bid, [sid, String(claim.spawner ?? '')]);
    return {
      ...current,
      state: verdict.state,
      // Summary + source sid only — the counterpart's body is never stored (R3).
      receipt: { from: sid, by: sid, at: now, note: verdict.summary, auto: true },
      replies: [...(current.replies ?? []), { from: sid, at: now, text: verdict.summary }].slice(-MAX_STORED),
      autoVerdictAt: now
    };
  }

  /**
   * 0.5.0: the lease / auto-receipt refresh, plus the archive pass (design §3).
   *
   * The archive decision runs at the **end** of every refresh, i.e. exactly where
   * the state is already settled: a record that just flipped to `done` is judged
   * in the same turn the requester sees it, and the `context` hook is the only
   * trigger (no timer, no polling, and `collab_list` — a read-only view — never
   * writes). A refusal or a failed PATCH changes nothing and never throws; the
   * hand-off result is returned untouched.
   */
  async function refresh(
    record: BroadcastRecord | undefined,
    now = Date.now(),
    options: { actor?: string } = {}
  ): Promise<BroadcastRecord | undefined> {
    const refreshed = await refreshCore(record, now, options);
    if (!refreshed) return refreshed;
    try {
      const archived = await archiveIfDue(refreshed, now, archiveGate);
      return archived ?? refreshed;
    } catch (error) {
      // Belt and braces: `shouldArchive` / `archiveSession` already refuse to
      // throw, but an archive must never be able to break a refresh.
      log(`archive pass failed for ${refreshed.bid}: ${errText(error)}`);
      return refreshed;
    }
  }

  /**
   * Best-effort note to the requester (acceptance / decline). Cross-location
   * delivery is a plain `prompt`; a protected requester is never written to
   * (fail-closed, same as `collab_send`).
   */
  async function notifyRequester(
    record: BroadcastRecord,
    { text, kind = 'note', from, threadID }: { text: string; kind?: string; from?: string; threadID?: string }
  ): Promise<{ delivered: boolean; message?: string; reason?: string; error?: unknown }> {
    const target = record?.from?.sid;
    if (!target) return { delivered: false, reason: '记录里没有发起方会话 id' };
    const config = readConfig();
    const guard = await createLineage(ctx).protectedAncestor(target, config.protect);
    if (guard) return { delivered: false, reason: `发起方 ${target} 在 protect 名单内，未回执` };
    const cid = newCorrelationID();
    // 0.8.0 (`sender-name`): the note lands in the requester's inbound header, so
    // the sender (the claimant, `claim.by`) is named there as well.
    const name = await senderName(ctx, String(record.claim?.by ?? ''));
    try {
      const admitted = await ctx.session.prompt({
        sessionID: target,
        text: envelope({ from: from ?? 'handoff', name, kind, threadID, body: text }),
        delivery: 'queue',
        metadata: {
          collab: {
            from: from ?? 'handoff',
            fromSessionID: record.claim?.by ?? 'unknown',
            cid,
            kind,
            threadID
          }
        }
      });
      // 0.9.0 (R1): the requester note is a delivered message too.
      // 0.10.x (`11-22-collab-metrics-dual`): a direct delivery → `raw` + `kept`.
      // 0.10.0 (`11-23-collab-metrics-attribution`, R1): count first, stamp the
      // row with the value `recordKept` returned (`rawSeq`) — one producer. One
      // timestamp for both, so the row and its counter cannot land on two days.
      const at = Date.now();
      const rawSeq = await recordKept(at);
      await recordMessage(
        makeEnvelope({
          id: `msg_${cid}`,
          ...(threadID ? { threadId: threadID } : {}),
          from: String(record.claim?.by ?? from ?? 'handoff'),
          to: target,
          sentAt: at,
          kind,
          body: text,
          ...(typeof rawSeq === 'number' ? { rawSeq } : {})
        })
      );
      return { delivered: true, message: admitted?.id };
    } catch (error) {
      // `error` (not just its text) is returned so the calling tool can file a
      // defect report (R1: 投递 5xx) without making the chain depend on the
      // reporter — a protected requester / missing sid stays a plain `reason`.
      return { delivered: false, reason: errText(error), error };
    }
  }

  /**
   * R1 (0.1.6): the receiving plugin's `[ack] <cid> seen`. It is machine
   * chatter on a note, so it is parsed by body only; the record is found by the
   * `cid` it names (never by bid — the ack does not carry one). `delivery.to`
   * must be the sender: a bystander that echoes a cid cannot fake `seen`.
   */
  async function applyAck(text: unknown, from: unknown): Promise<BroadcastRecord | undefined> {
    const cid = parseAck(text);
    const sender = String(from ?? '');
    if (!cid || !sender) return undefined;
    for (const record of allBroadcasts()) {
      const delivery = deliveryOf(record);
      if (!delivery.cid || String(delivery.cid) !== cid) continue;
      if (String(delivery.to ?? '') !== sender) continue;
      const next = markSeen(record, cid);
      if (!next) return record; // already seen: nothing to write
      return writeBroadcast(next);
    }
    return undefined;
  }

  /**
   * R1 (0.1.6): the receiving side confirms it surfaced a message. Called from
   * the `context` hook and `collab_inbox`; **best-effort** — a failed ack must
   * never affect the receiving session's own flow (it only means the sender
   * keeps waiting, or falls back to a resend / the proposal file).
   *
   * Once per `cid` (`ackSentAt`), and never for an ack itself (the caller
   * filters those). A protected requester can never be written to: the record
   * is stamped `ackUnavailable` instead (R4) — no retry, no error.
   *
   * Every write here goes through `mergeDelivery`: the prompt is an `await`, and
   * in that window the requester's `applyAck` may stamp `seenAt`. Writing back
   * the pre-await snapshot would drop it (review F1: an extra resend 2h later,
   * then a bogus `unacked`), so only the ack fields are merged into the current
   * record — `state` / `receipt` / `followUps` are never touched.
   */
  async function ackSeen(sessionID: string | undefined, cids: string[]): Promise<void> {
    const me = String(sessionID ?? '');
    const wanted = new Set((cids ?? []).map(cid => String(cid ?? '')).filter(Boolean));
    if (!me || !wanted.size) return;
    let config: ReturnType<ConfigReader> | undefined;
    for (const record of allBroadcasts()) {
      const delivery = deliveryOf(record);
      if (!delivery.cid || !wanted.has(String(delivery.cid))) continue;
      if (String(delivery.to ?? '') !== me) continue;
      if (delivery.seenAt || delivery.ackSentAt) continue; // single ack per message
      if (delivery.ackUnavailable) continue; // R4: already known to be unreachable
      const requester = String(record.from?.sid ?? '');
      if (!requester || requester === me) continue;
      config ??= readConfig();
      if (await createLineage(ctx).protectedAncestor(requester, config.protect)) {
        // Re-read inside the merge: a concurrent write during the lineage check
        // must not be clobbered by this snapshot.
        mergeDelivery(record.bid, {
          ackUnavailable: true,
          ackUnavailableReason: `发起方 ${requester} 在 protect 名单内，ack 无法投递`
        });
        continue;
      }
      const cid = String(delivery.cid);
      // Fresh correlation id for *this* note; the acknowledged one is carried
      // separately (`ack`) so it is never confused with it.
      const noteCid = newCorrelationID();
      const noteText = buildAck(cid);
      try {
        await ctx.session.prompt({
          sessionID: requester,
          text: envelope({ from: shortID(me), kind: 'note', body: noteText }),
          delivery: 'queue',
          metadata: {
            collab: {
              from: shortID(me),
              fromSessionID: me,
              cid: noteCid,
              ack: cid,
              kind: 'note',
              ts: Date.now()
            }
          }
        });
        // 0.9.0 (R1): the ack is a message (`kind:"ack"`). The `seenAt` guard
        // above means one ack per delivery, so this is one line per ack.
        // 0.10.x: the `[ack]` loop is a direct delivery → `raw` + `kept`.
        // 0.10.0 (R1): count first, stamp the row with the returned value.
        const ackAt = Date.now();
        const ackSeq = await recordKept(ackAt);
        await recordMessage(
          makeEnvelope({
            id: `msg_${noteCid}`,
            from: me,
            to: requester,
            sentAt: ackAt,
            kind: 'ack',
            body: noteText,
            ...(typeof ackSeq === 'number' ? { rawSeq: ackSeq } : {})
          })
        );
        // F1: merge into the *current* record. The requester's `applyAck` may
        // have stamped `seenAt` while this prompt was being admitted; writing
        // back the pre-await snapshot would drop it (→ an extra resend 2h
        // later → a bogus `unacked`).
        mergeDelivery(record.bid, { ackSentAt: Date.now(), ackSentBy: me });
        log(`ack ${cid} → ${requester}`);
      } catch (error) {
        // Bypass: never let a failed ack change the receiver's own flow.
        log(`ack for ${cid} not delivered: ${errText(error)}`);
      }
    }
  }

  /**
   * R2 (0.1.6): sender-side resend, run from the requester's `context` hook
   * only (the requester is the only side that may re-queue its own ask).
   *
   * Rules, all of them fail-closed:
   *   - `resendDue` (window / failed admission / budget / no `seen` / no `ackUnavailable`);
   *   - the target must be **idle** — a busy target already holds the message,
   *     and a second copy only grows the backlog of a session that may run one
   *     turn for tens of minutes;
   *   - a protected target is never written to (`ackUnavailable`, no retry);
   *   - same `cid`, so the receiving side's `extractInbound` de-duplication
   *     keeps the second copy out of the inbox.
   */
  async function resendIfDue(
    record: BroadcastRecord | undefined,
    now = Date.now(),
    actor?: string
  ): Promise<BroadcastRecord | undefined> {
    if (!record) return record;
    if (!actor || String(record.from?.sid ?? '') !== String(actor)) return record;
    if (BCAST_DONE_STATES.includes(String(record.state))) return record;
    let current = record;
    if (resendDue(current, now)) current = await resendOnce(current, now);
    if (!deliveryOf(current).unacked && unackedDue(current, now)) {
      // Budget spent, still no ack: say so once (`collab_list` shows 可人工补投).
      // Merged into the current record (F1): an ack may have landed meanwhile.
      current = mergeDelivery(current.bid, { unacked: true }) ?? current;
    }
    return current;
  }

  async function resendOnce(record: BroadcastRecord, now: number): Promise<BroadcastRecord> {
    const delivery = deliveryOf(record);
    const target = String(delivery.to ?? '');
    if (!target) return record;
    const config = readConfig();
    if (await createLineage(ctx).protectedAncestor(target, config.protect)) {
      // F1: merged into the current record — never a pre-await snapshot.
      return mergeDelivery(record.bid, {
        ackUnavailable: true,
        ackUnavailableReason: `目标 ${target} 在 protect 名单内，不能重发`
      }) ?? record;
    }
    const info = await sessionInfo(target);
    if (!info || sessionState(info) !== 'idle') return record; // busy: only wait
    const cid = String(delivery.cid);
    const resends = (Number(delivery.resends) || 0) + 1;
    const from = shortID(String(record.from?.sid ?? 'handoff'));
    // 0.8.0 (`sender-name`): the resend keeps the header readable too.
    const name = await senderName(ctx, String(record.from?.sid ?? ''));
    const resendBody = takeoverBody({ record, spawn: record.claim?.kind === 'spawn' });
    try {
      const admitted = await ctx.session.prompt({
        sessionID: target,
        text: envelope({
          from,
          name,
          kind: 'request',
          threadID: record.threadID,
          body: resendBody
        }),
        delivery: 'queue',
        metadata: {
          collab: {
            from,
            fromSessionID: String(record.from?.sid ?? 'unknown'),
            cid,
            kind: 'request',
            threadID: record.threadID,
            resend: resends,
            ts: now
          }
        }
      });
      // 0.9.0 (R1): a resend is a real delivery, so it gets its own row
      // (`_r<n>`): the original message id is kept for the receiver's de-dup,
      // which is exactly why the history needs the suffix to tell them apart.
      // 0.10.x: a resend is a real delivery (raw/kept +1); `msg_count` keeps
      // excluding `_r<n>` via `isResendID` — that asymmetry is documented.
      // 0.10.0 (R1): the row still gets the marker (it *was* counted); only the
      // `uncounted` diagnostic skips `_r<n>` rows.
      const resendSeq = await recordKept(now);
      await recordMessage(
        makeEnvelope({
          id: `msg_${cid}_r${resends}`,
          ...(record.threadID ? { threadId: record.threadID } : {}),
          from: String(record.from?.sid ?? 'handoff'),
          to: target,
          sentAt: now,
          kind: 'request',
          body: resendBody,
          ...(typeof resendSeq === 'number' ? { rawSeq: resendSeq } : {})
        })
      );
      // F1: merge into the current record. An `[ack]` for the very cid can land
      // while this prompt is being admitted — that `seenAt` must survive, or the
      // resend itself creates the false "unacked" it was meant to avoid.
      return (
        mergeDelivery(record.bid, {
          resends,
          // The first admission failed (`failedAt` only): this delivery *is*
          // the admission, so the window is measured from here on.
          admittedAt: Number(delivery.admittedAt) || now,
          messageId: admitted?.id ?? delivery.messageId,
          lastAttemptAt: now,
          failedAt: undefined
        }) ?? record
      );
    } catch (error) {
      log(`resend failed for ${target}: ${errText(error)}`);
      // A resend that could not even be admitted is as unacked as it gets.
      return mergeDelivery(record.bid, { resends, lastAttemptAt: now, unacked: true }) ?? record;
    }
  }

  /**
   * R5 (0.1.6): the only thing a requester is told about a closed hand-off's
   * append — one read-only line naming the proposal file and the append time
   * (never the append's words; see `core/followup.ts`). Deduped per
   * `(sid, bid, at)`, so a second append is shown on the next request, and at
   * most one line per request.
   *
   * F1 (0.3.1): **pure query**. It returns the line(s) plus the keys that make
   * them "seen"; the caller (`hooks/context.ts`) writes those keys only after
   * the line is really in the request. A failed injection therefore leaves the
   * hint pending for the next request instead of dropping it.
   */
  async function followUpHints(sessionID: string | undefined): Promise<FollowUpHintResult> {
    const me = String(sessionID ?? '');
    if (!me) return { lines: [], keys: [] };
    const seen = await readFollowUpSeen(ctx, me);
    for (const record of allBroadcasts()) {
      if (String(record.from?.sid ?? '') !== me) continue; // requester only
      if (!['done', 'blocked'].includes(String(record.state))) continue;
      if (!followUpsOf(record).length) continue;
      const hint = nextFollowUpHint(record, me, seen, { workspace: record.workspace });
      if (!hint) continue;
      // 每会话每次注入 ≤1 行；F2: an all-invalid record no longer consumes the
      // slot (it returns undefined and the next record still gets its chance).
      return { lines: [hint.line], keys: hint.keys };
    }
    return { lines: [], keys: [] };
  }

  /**
   * R1 (0.4.1): **every** follow-up hint this requester could see right now —
   * all of its closed records, all pending entries, oldest first. The plain
   * `followUpHints` path renders at most one line; the protected path merges
   * these with the owner-queue candidates and de-duplicates before it caps, so
   * it needs the whole list. Pure query (F1): nothing is stamped here.
   */
  async function followUpCandidates(sessionID: string): Promise<ProtectedHint[]> {
    const seen = await readFollowUpSeen(ctx, sessionID);
    const out: ProtectedHint[] = [];
    for (const record of allBroadcasts()) {
      if (String(record.from?.sid ?? '') !== sessionID) continue; // requester only
      if (!['done', 'blocked'].includes(String(record.state))) continue;
      if (!followUpsOf(record).length) continue;
      for (const candidate of pendingFollowUpCandidates(record, sessionID, seen, {
        workspace: record.workspace
      })) {
        out.push({
          at: candidate.at,
          bid: candidate.bid,
          issuePath: candidate.issuePath,
          keys: hintKeys(candidate.issuePath, candidate.bid),
          line: candidate.line,
          key: candidate.key,
          source: 'followup'
        });
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** R1 (0.4.1): the unread owner-queue items as render candidates (all of them). */
  function queueCandidates(sessionID: string): ProtectedHint[] {
    return unseenCandidates(sessionID).map(item => ({
      at: item.at,
      bid: item.bid,
      issuePath: item.issuePath,
      keys: hintKeys(item.issuePath, item.bid),
      line: item.line,
      queueID: item.id,
      source: 'owner-queue' as const
    }));
  }

  /**
   * What this session should be told on its next model request, as plain text
   * lines (the hook wraps them), plus the follow-up keys to stamp **after** the
   * block was pushed (F1, 0.3.1):
   *   - open broadcasts of its own workspace it has not seen yet (`seenBy`);
   *   - hand-offs it started that are still unresolved and stale (`reminded`).
   * Both are written back so each line is surfaced exactly once per session.
   *
   * R5 (0.1.6) — the protected-session whitelist: a `[protected]` line gets
   * **nothing** from this function except `followUpHints` (a read-only
   * "proposal has an append, read the file" line). It is returned *before* the
   * protect guard, and nothing else is ever added to that list.
   *
   * D1 (0.4.0) extends that whitelist by exactly one read-only source: the
   * **owner review queue** (`- [owner-queue] <from> @ <HH:MM>：<summary>（<path>）`,
   * at most 3 per injection, oldest first). It is not a delivery — the item was
   * written by another session, and the ids travel back so the hook stamps
   * `seenAt` only after the block is pushed (same F1 rule as the follow-ups).
   * A `[protected-child]` is not a group member and therefore returns early
   * below; it still gets its queue hints (nothing can be delivered to it either).
   *
   * R1 (0.4.1): those two sources are now **merged before rendering**. One
   * proposal reported twice — a queue item plus a `followUps` append, or two
   * queue items — costs one line as soon as they share **any** key (`bid` or
   * normalized `issuePath`, transitively), which also covers the reachable
   * `collab_request_owner { bid }` (no path) case; the survivor is the newest
   * (`at`). Only the lines that actually render are returned for stamping, so a
   * de-duplicated entry stays pending for the next request instead of
   * disappearing.
   */
  async function injectionFor(
    sessionID: string | undefined,
    directory: string | undefined
  ): Promise<FollowUpHintResult> {
    const now = Date.now();
    if (!sessionID || !directory) return { lines: [], keys: [] };
    const info = await sessionInfo(sessionID);
    const config = readConfig();
    // R5/D1 whitelist input: computed once, for every session. Non-protected
    // sessions can never be a queue target (`collab_request_owner` refuses
    // them), so the directory read is skipped for them.
    const guard = await createLineage(ctx).protectedAncestor(sessionID, config.protect);
    const queued = guard ? queueCandidates(sessionID) : [];
    if (!info || info.parentID) {
      // Children are not group members: they used to get nothing at all. A
      // protected child is still a legal queue target, so its (read-only) queue
      // lines are the one thing it may see.
      if (!guard) return { lines: [], keys: [] };
      const rendered = dedupeProtectedHints(queued);
      return {
        lines: rendered.map(hint => hint.line),
        keys: [],
        ownerQueue: rendered.flatMap(hint => (hint.queueID ? [hint.queueID] : []))
      };
    }
    if (guard) {
      const hints = await followUpCandidates(sessionID);
      const rendered = dedupeProtectedHints([...hints, ...queued]);
      return {
        lines: rendered.map(hint => hint.line),
        keys: rendered.flatMap(hint => (hint.key ? [hint.key] : [])),
        ownerQueue: rendered.flatMap(hint => (hint.queueID ? [hint.queueID] : []))
      };
    }
    const hints = await followUpHints(sessionID);

    const lines: string[] = [];
    for (const raw of allBroadcasts()) {
      // H2: pass the trigger as `actor` — only the requester may auto-close.
      let record: BroadcastRecord | undefined = persistRefresh(
        raw,
        await refresh(raw, now, { actor: sessionID })
      );
      if (!record) continue;
      // R2 (0.1.6): before the workspace filter — a peer hand-off the requester
      // started lives in *another* workspace, and that is exactly the case a
      // resend exists for.
      record = await resendIfDue(record, now, sessionID);
      if (!record || record.workspace !== directory) continue;

      if (record.state === 'open') {
        if (String(record.from?.sid ?? '') === sessionID) continue; // 发起方不需要自己的广播
        if ((record.skipped ?? []).includes(sessionID)) continue; // 已问过 / 已顺延，不再打扰
        const files = (record.affectedFiles ?? []).slice(0, 4).join(', ') || '(未标注)';
        if (record.asked?.sid === sessionID && !(record.askSeen ?? []).includes(sessionID)) {
          // R1 (0.1.6): one `cid` per ask. If the ask advanced to this session,
          // mint a fresh delivery so the ack names the message it really saw
          // (an ack for the previous candidate's cid would be refused).
          if (String(deliveryOf(record).to ?? '') !== sessionID) {
            const previous = deliveryOf(record);
            record = writeBroadcast({
              ...record,
              delivery: {
                cid: newCorrelationID(),
                to: sessionID,
                admittedAt: now,
                ...(previous.ackUnavailable ? { ackUnavailable: true } : {})
              }
            });
          }
          // 接管请求：只有当前被问询的 top-1 收到，串行、一条。
          // R1-2: the requester sid is written out in full, so a DECLINE (or the
          // receipt later) needs no `collab_inbox` lookup.
          // R1 (G1): accept → receipt → "answering in-session is not done", all
          // three copy-pasteable, because the pilot's `explore` session answered
          // in its own turn and called neither tool.
          const requester = String(record.from?.sid ?? '');
          const leaseMin = Math.round((record.asked?.leaseMs ?? BCAST_LEASE_MS) / 60_000);
          lines.push(
            // 0.7.0 (R2): the receiving side's protocol header — first two lines
            // of the block: "you are the claimant" + the exact receipt command.
            ...protocolHeader({
              bid: record.bid,
              threadID: record.threadID,
              peer: record.scope === 'peer',
              // 0.7.0 (R3): the chain head of a forwarded hand-off (`A → B → C`).
              origin: record.origin,
              requester
            }),
            `- 接管请求 ${record.bid}：${truncate(record.title ?? '(untitled)', 80)}（提案 ${record.issuePath}，期望 ${record.expected}，影响面 ${files}）` +
              ` 发起方=${requester || '(缺失，用 collab_inbox 查)'} → ${handoffActions({
                bid: record.bid,
                requester,
                leaseMin,
                // R1 (pull): a protected requester cannot receive a pushed
                // receipt, so the ask line must not demand one.
                receiptMode: record.receiptMode === 'pull' ? 'pull' : 'push',
                expected: record.expected,
                // 0.7.0 (R3): the receipt block names the chain head too.
                origin: record.origin
              }).join(' ')}`
          );
          // F1 (same class): this write follows `resendIfDue`'s awaits, so merge
          // the per-session marks into the *current* record instead of a
          // snapshot that may predate a concurrent `seenAt`.
          const asked = readBroadcast(record.bid) ?? record;
          writeBroadcast({
            ...asked,
            askSeen: dedupe([...(asked.askSeen ?? []), sessionID]),
            seenBy: dedupe([...(asked.seenBy ?? []), sessionID])
          });
          // R1 (0.1.6): the ask is now in front of this session → confirm it on
          // a side path (best-effort; never affects the receiver).
          void ackSeen(sessionID, [String(deliveryOf(record).cid ?? '')]).catch(() => {});
          continue;
        }
        if (!(record.seenBy ?? []).includes(sessionID)) {
          lines.push(
            `- 群组广播 ${record.bid}：${truncate(record.title ?? '(untitled)', 80)}` +
              `（提案 ${record.issuePath}，期望 ${record.expected}，影响面 ${files}）` +
              ` → 相关请 collab_accept {bid:"${record.bid}", confirm:true}` +
              `（你的 outOfScope 非空时它会先要求 scopeCheck 表态）；没余力就不领取（勿占用）。`
          );
          const seen = readBroadcast(record.bid) ?? record;
          writeBroadcast({ ...seen, seenBy: dedupe([...(seen.seenBy ?? []), sessionID]) });
        }
        continue;
      }

      const mine = String(record.from?.sid ?? '') === sessionID && !(record.reminded ?? []).includes(sessionID);
      if (!mine) continue;
      // A closed hand-off (receipt already written, incl. the R2 auto-receipt) has
      // nothing left to chase — only `expired` still needs a human.
      if (['done', 'blocked'].includes(String(record.state))) continue;
      const claimAt = Number(record.claim?.at ?? record.receipt?.at ?? record.createdAt) || 0;
      const stale = record.state === 'expired' || now - claimAt > BCAST_LEASE_MS;
      if (!stale) continue;
      const who = record.claim?.by ? ` 接手 ${record.claim.by}` : '';
      // R3: a `pull` hand-off closes from the claimant's own answer, so there is
      // no pushed receipt to wait for — say that instead of pointing at
      // `collab_inbox` (which will never carry one).
      const pull = record.receiptMode === 'pull';
      lines.push(
        `- 交接未闭环 ${record.bid}：${truncate(record.title ?? '(untitled)', 60)} state=${record.state}${who} 自 ${fmtTime(claimAt)} 起 → ${
          pull
            ? `pull 模式（发起方在 protect 名单内）：无需等待推送回执，租约到期后会只读提取承接方的最后一条回复` +
              `（其中应有 [handoff] DONE|BLOCKED <${record.bid}> <摘要>）。`
            : `用 collab_inbox 看回执；回执格式 [handoff] DONE|BLOCKED <${record.bid}> <摘要>。`
        }${record.state === 'expired' ? ' attempts 已超限，需人接手。' : ''}`
      );
      const current = readBroadcast(record.bid) ?? record;
      writeBroadcast({ ...current, reminded: dedupe([...(current.reminded ?? []), sessionID]) });
    }
    return { lines: [...lines, ...hints.lines], keys: hints.keys };
  }

  return {
    sessionInfo,
    listSessions,
    sessionPaths,
    rankCandidates,
    applyReceipt,
    applyDecline,
    applyAck,
    ackSeen,
    resendIfDue,
    followUpHints,
    notifyRequester,
    injectionFor,
    extractVerdict,
    refresh,
    // session-level permission grants (R1–R5) + agent promotion (R7)
    ...createGrants(ctx, readConfig)
  };
}
