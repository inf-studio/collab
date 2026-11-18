import type { ConfigReader } from '../config.ts';
import {
  ACKED_EXTRACT_MS,
  BCAST_LEASE_MS,
  BCAST_DONE_STATES,
  MAX_STORED,
  SCORE_CANDIDATE_LIMIT,
  VERDICT_MESSAGE_LIMIT
} from '../constants.ts';
import { envelope, newCorrelationID, normalizeKind } from '../ids.ts';
import { errText } from '../log.ts';
import type {
  BroadcastRecord,
  CollabContext,
  ProposalSummary,
  RankResult,
  RankedCandidate,
  SessionInfoLike
} from '../types.ts';
import { asObject, dedupe, fmtTime, truncate } from '../util.ts';
import {
  allBroadcasts,
  declineAsked,
  normalizeBroadcast,
  persistRefresh,
  refreshBroadcast,
  releaseLock,
  writeBroadcast
} from './claim.ts';
import { createGrants } from './grants.ts';
import type { Grants } from './grants.ts';
import { createLineage } from './lineage.ts';
import { pathsFromMessages, scoreCandidate } from './score.ts';
import {
  assistantTexts,
  DECLINE_BID_RE,
  HANDOFF_DECLINE_RE,
  handoffActions,
  parseReceiptLine,
  receiptAllowed,
  receiptMatches,
  verdictFromTexts
} from './verdict.ts';

export type { RankResult };

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
  notifyRequester(
    record: BroadcastRecord,
    input: { text: string; kind?: string; from?: string; threadID?: string }
  ): Promise<{ delivered: boolean; message?: string; reason?: string; error?: unknown }>;
  injectionFor(sessionID: string | undefined, directory: string | undefined): Promise<string[]>;
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
  async function refresh(
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
    try {
      const admitted = await ctx.session.prompt({
        sessionID: target,
        text: envelope({ from: from ?? 'handoff', kind, threadID, body: text }),
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
      return { delivered: true, message: admitted?.id };
    } catch (error) {
      // `error` (not just its text) is returned so the calling tool can file a
      // defect report (R1: 投递 5xx) without making the chain depend on the
      // reporter — a protected requester / missing sid stays a plain `reason`.
      return { delivered: false, reason: errText(error), error };
    }
  }

  /**
   * What this session should be told on its next model request, as plain text
   * lines (the hook wraps them):
   *   - open broadcasts of its own workspace it has not seen yet (`seenBy`);
   *   - hand-offs it started that are still unresolved and stale (`reminded`).
   * Both are written back so each line is surfaced exactly once per session.
   */
  async function injectionFor(sessionID: string | undefined, directory: string | undefined): Promise<string[]> {
    const now = Date.now();
    if (!sessionID || !directory) return [];
    const info = await sessionInfo(sessionID);
    if (!info || info.parentID) return []; // children are not group members
    const config = readConfig();
    if (await createLineage(ctx).protectedAncestor(sessionID, config.protect)) return [];

    const lines: string[] = [];
    for (const raw of allBroadcasts()) {
      // H2: pass the trigger as `actor` — only the requester may auto-close.
      const record: BroadcastRecord | undefined = persistRefresh(raw, await refresh(raw, now, { actor: sessionID }));
      if (!record || record.workspace !== directory) continue;

      if (record.state === 'open') {
        if (String(record.from?.sid ?? '') === sessionID) continue; // 发起方不需要自己的广播
        if ((record.skipped ?? []).includes(sessionID)) continue; // 已问过 / 已顺延，不再打扰
        const files = (record.affectedFiles ?? []).slice(0, 4).join(', ') || '(未标注)';
        if (record.asked?.sid === sessionID && !(record.askSeen ?? []).includes(sessionID)) {
          // 接管请求：只有当前被问询的 top-1 收到，串行、一条。
          // R1-2: the requester sid is written out in full, so a DECLINE (or the
          // receipt later) needs no `collab_inbox` lookup.
          // R1 (G1): accept → receipt → "answering in-session is not done", all
          // three copy-pasteable, because the pilot's `explore` session answered
          // in its own turn and called neither tool.
          const requester = String(record.from?.sid ?? '');
          const leaseMin = Math.round((record.asked.leaseMs ?? BCAST_LEASE_MS) / 60_000);
          lines.push(
            `- 接管请求 ${record.bid}：${truncate(record.title ?? '(untitled)', 80)}（提案 ${record.issuePath}，期望 ${record.expected}，影响面 ${files}）` +
              ` 发起方=${requester || '(缺失，用 collab_inbox 查)'} → ${handoffActions({
                bid: record.bid,
                requester,
                leaseMin,
                // R1 (pull): a protected requester cannot receive a pushed
                // receipt, so the ask line must not demand one.
                receiptMode: record.receiptMode === 'pull' ? 'pull' : 'push'
              }).join(' ')}`
          );
          writeBroadcast({
            ...record,
            askSeen: dedupe([...(record.askSeen ?? []), sessionID]),
            seenBy: dedupe([...(record.seenBy ?? []), sessionID])
          });
          continue;
        }
        if (!(record.seenBy ?? []).includes(sessionID)) {
          lines.push(
            `- 群组广播 ${record.bid}：${truncate(record.title ?? '(untitled)', 80)}` +
              `（提案 ${record.issuePath}，期望 ${record.expected}，影响面 ${files}）` +
              ` → 相关请 collab_accept {bid:"${record.bid}"}；没余力就不领取（勿占用）。`
          );
          writeBroadcast({ ...record, seenBy: dedupe([...(record.seenBy ?? []), sessionID]) });
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
      writeBroadcast({ ...record, reminded: dedupe([...(record.reminded ?? []), sessionID]) });
    }
    return lines;
  }

  return {
    sessionInfo,
    listSessions,
    sessionPaths,
    rankCandidates,
    applyReceipt,
    applyDecline,
    notifyRequester,
    injectionFor,
    extractVerdict,
    refresh,
    // session-level permission grants (R1–R5) + agent promotion (R7)
    ...createGrants(ctx, readConfig)
  };
}
