import { closeSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  BCAST_DONE_STATES,
  BCAST_LEASE_MS,
  BCAST_MAX_ATTEMPTS,
  BCAST_PRUNE_LIMIT,
  BCAST_RETENTION_MS,
  BCAST_STATES,
  BCAST_THRESHOLD,
  BROADCAST_DIR,
  MAX_STORED
} from '../constants.ts';
import { errCode, errText, log } from '../log.ts';
import type { BroadcastRecord, JsonObject } from '../types.ts';
import { asObject, dedupe, randToken, readJsonFile } from '../util.ts';
import { sanitizePathText } from './followup.ts';

export function isValidBid(value: unknown): boolean {
  return /^b_[0-9a-f]{8,32}$/.test(String(value ?? '').trim());
}

export function bcastFile(bid: string): string {
  return join(BROADCAST_DIR, `${bid}.json`);
}

export function bcastLock(bid: string): string {
  return join(BROADCAST_DIR, `${bid}.lock`);
}

export function readBroadcast(bid: string | undefined): BroadcastRecord | undefined {
  if (!isValidBid(bid)) return undefined;
  const raw = readJsonFile(bcastFile(String(bid)));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return normalizeBroadcast({ ...asObject(raw), bid: String(asObject(raw).bid ?? bid) });
}

export function normalizeBroadcast(record: JsonObject): BroadcastRecord {
  const asked = asObject(record.asked);
  const delivery = asObject(record.delivery);
  return {
    ...record,
    bid: String(record.bid),
    scope: record.scope === 'local' ? 'local' : 'peer',
    state: BCAST_STATES.includes(record.state) ? record.state : 'open',
    candidates: Array.isArray(record.candidates) ? record.candidates : [],
    replies: Array.isArray(record.replies) ? record.replies : [],
    seenBy: Array.isArray(record.seenBy) ? record.seenBy.filter((id: unknown) => typeof id === 'string') : [],
    askSeen: Array.isArray(record.askSeen) ? record.askSeen.filter((id: unknown) => typeof id === 'string') : [],
    reminded: Array.isArray(record.reminded) ? record.reminded.filter((id: unknown) => typeof id === 'string') : [],
    skipped: Array.isArray(record.skipped) ? record.skipped.filter((id: unknown) => typeof id === 'string') : [],
    declines: Array.isArray(record.declines) ? record.declines : [],
    asked: asked.sid
      ? {
          sid: String(asked.sid),
          at: Number(asked.at) || 0,
          leaseMs: Number(asked.leaseMs) || BCAST_LEASE_MS
        }
      : undefined,
    attempts: Number(record.attempts) || 0,
    // R8: retry stamp of the `acked` extraction (absent on old records).
    staleNoticedAt: Number(record.staleNoticedAt) || undefined,
    // R1/R2 (0.1.6): delivery + ack bookkeeping. Absent on ≤0.1.5 records, which
    // is exactly the "already admitted, no ack capability" state (never resent).
    delivery: normalizeDelivery(delivery),
    // R5 (0.1.6): post-closure appends — **structure only**
    // (`{bid, issuePath, at, by}`); free text never enters this array (see
    // `core/followup.ts`: it would be a channel into a protected session).
    followUps: Array.isArray(record.followUps)
      ? record.followUps
          .filter((entry: unknown) => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
          .map((entry: JsonObject) => ({
            bid: String(entry.bid ?? record.bid ?? ''),
            issuePath: sanitizePathText(entry.issuePath),
            at: Number(entry.at) || 0,
            by: String(entry.by ?? '')
          }))
          .filter((entry: JsonObject) => Boolean(entry.at))
      : [],
    createdAt: Number(record.createdAt) || 0,
    updatedAt: Number(record.updatedAt) || 0
  };
}

/** Number/string fields of `delivery`, tolerant of hand-written records. */
function normalizeDelivery(raw: JsonObject): JsonObject | undefined {
  if (!raw.cid && !raw.to) return undefined;
  const num = (value: unknown): number | undefined => (Number(value) ? Number(value) : undefined);
  const str = (value: unknown): string | undefined => (value ? String(value) : undefined);
  return {
    ...raw,
    cid: str(raw.cid),
    to: str(raw.to),
    messageId: str(raw.messageId),
    admittedAt: num(raw.admittedAt),
    failedAt: num(raw.failedAt),
    lastAttemptAt: num(raw.lastAttemptAt),
    seenAt: num(raw.seenAt),
    ackSentAt: num(raw.ackSentAt),
    ackSentBy: str(raw.ackSentBy),
    resends: Number(raw.resends) || 0,
    unacked: raw.unacked === true,
    ackUnavailable: raw.ackUnavailable === true
  };
}

/**
 * Delete decided hand-offs that are past `BCAST_RETENTION_MS`. Runs on write
 * only — a preview / a `collab_list` snapshot never deletes anything.
 * `open` / `claimed` / `acked` records are never touched (still somebody's job),
 * and a single write sweeps at most `BCAST_PRUNE_LIMIT` files so a huge backlog
 * decays over a few writes instead of stalling one call.
 *
 * The matching `<bid>.lock` is removed together with the record: a decided
 * hand-off should have released it already (`applyReceipt` / lease expiry), and
 * an orphan lock would poison a later re-broadcast of the same content.
 */
export function pruneBroadcasts(now = Date.now()): number {
  let names: string[];
  try {
    names = readdirSync(BROADCAST_DIR);
  } catch {
    return 0; // no directory yet: nothing to prune
  }
  let removed = 0;
  for (const name of names) {
    if (removed >= BCAST_PRUNE_LIMIT) break;
    if (!name.startsWith('b_') || !name.endsWith('.json')) continue;
    const bid = name.slice(0, -5);
    const record = readBroadcast(bid);
    if (!record || !BCAST_DONE_STATES.includes(String(record.state))) continue;
    const stamp = Number(record.updatedAt || record.createdAt || 0);
    if (!stamp || now - stamp <= BCAST_RETENTION_MS) continue;
    try {
      unlinkSync(bcastFile(bid));
      removed += 1;
    } catch {
      continue; // concurrently removed / not ours: try the next one
    }
    try {
      unlinkSync(bcastLock(bid));
    } catch {
      /* no lock left: nothing to do */
    }
  }
  return removed;
}

/** Atomic replace: write `<bid>.json.<rand>.tmp`, then `rename`. */
export function writeBroadcast(record: JsonObject): BroadcastRecord {
  const next = { ...normalizeBroadcast(record), updatedAt: Date.now() };
  mkdirSync(BROADCAST_DIR, { recursive: true });
  const tmp = `${bcastFile(next.bid)}.${randToken()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, bcastFile(next.bid));
  pruneBroadcasts(next.updatedAt);
  return next;
}

export function allBroadcasts(): BroadcastRecord[] {
  let names: string[];
  try {
    names = readdirSync(BROADCAST_DIR);
  } catch {
    return []; // directory does not exist yet: no broadcasts anywhere
  }
  const out: BroadcastRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = readBroadcast(name.slice(0, -5));
    if (record) out.push(record);
  }
  return out;
}

/**
 * Candidates that may still be asked: score ≥ threshold and not skipped yet.
 * `skipped` is the serial-ask cursor — DECLINE, ask timeout and a lapsed claim
 * all push the session in there, so it is never asked twice.
 */
export function askableCandidates(record: BroadcastRecord): JsonObject[] {
  return (record.candidates ?? []).filter(
    (candidate: JsonObject) =>
      Number(candidate?.score) >= BCAST_THRESHOLD && !(record.skipped ?? []).includes(candidate.sid)
  );
}

/**
 * Ask the next candidate (top-1 串行). `asked` holds the *only* session that
 * currently owes an ACCEPT / DECLINE and the moment it was asked, so the 5-min
 * ask lease can be evaluated on any later read (no daemon).
 * Returns false when no candidate is left — callers turn that into `expired`.
 */
export function planAsk(record: BroadcastRecord, now = Date.now()): boolean {
  const next = askableCandidates(record)[0];
  if (!next?.sid) {
    delete record.asked;
    return false;
  }
  record.asked = { sid: String(next.sid), at: now, leaseMs: BCAST_LEASE_MS };
  return true;
}

/**
 * DECLINE (explicit) and ask-timeout (implicit) share one transition:
 * attempts+1, the session becomes `skipped`, the next candidate is asked.
 * Exhausted candidates or `attempts > 3` → `expired` (escalate to a human);
 * crucially this never spawns — spawn only happens when *no* candidate ≥ 80.
 */
export function declineAsked(record: BroadcastRecord, sid: string, now = Date.now()): BroadcastRecord {
  record.attempts = (record.attempts ?? 0) + 1;
  record.skipped = dedupe([...(record.skipped ?? []), String(sid)]);
  record.declines = [...(Array.isArray(record.declines) ? record.declines : []), { sid: String(sid), at: now }].slice(
    -MAX_STORED
  );
  delete record.asked;
  if (!planAsk(record, now) || (record.attempts ?? 0) > BCAST_MAX_ATTEMPTS) record.state = 'expired';
  return record;
}

/**
 * Lease bookkeeping, applied on every read:
 *   - `claimed` past its lease → reopen, attempts+1, skip the holder, release
 *     the lock (matched by holder *or* by `claimBy`, see `releaseLock`);
 *   - `asked` (state `open`) past its lease → same as an explicit DECLINE;
 *   - past `BCAST_MAX_ATTEMPTS` → `expired` (escalate to a human, no re-delivery).
 */
export function refreshBroadcast(input: BroadcastRecord | undefined, now = Date.now()): BroadcastRecord | undefined {
  if (!input) return input;
  const record = normalizeBroadcast(input);
  const claim = asObject(record.claim);
  if (record.state === 'claimed' && claim.by && now - Number(claim.at || 0) > BCAST_LEASE_MS) {
    record.state = 'open';
    record.attempts = (record.attempts ?? 0) + 1;
    record.skipped = dedupe([...(record.skipped ?? []), String(claim.by)]);
    record.expiredClaim = { ...claim, expiredAt: now };
    delete record.claim;
    releaseLock(record.bid, [String(claim.by), String(claim.spawner ?? '')]);
    if (claim.kind === 'spawn') {
      // Nobody accepted the spawned session's hand-off: the hand-off becomes
      // visible to the whole group again (no candidate was ever asked).
      delete record.asked;
    } else {
      // The holder took it but let the lease lapse: ask the next candidate if
      // one is left, otherwise leave it `open` for the group (a lapsed claim is
      // not "candidates exhausted" — that only applies to DECLINE/timeout).
      planAsk(record, now);
    }
  }

  const asked = asObject(record.asked);
  if (record.state === 'open' && asked.sid && now - Number(asked.at || 0) > (Number(asked.leaseMs) || BCAST_LEASE_MS)) {
    declineAsked(record, String(asked.sid), now);
  }

  if (!BCAST_DONE_STATES.includes(String(record.state)) && (record.attempts ?? 0) > BCAST_MAX_ATTEMPTS) {
    record.state = 'expired';
  }
  return record;
}

/**
 * Read-only lease verdict for `collab_list`: it *describes* whether the
 * claim / ask lease has lapsed without refreshing the record, writing anything
 * or releasing a lock — a listing must not mutate other sessions' hand-offs.
 * `undefined` = no lease applies (open without an ask, done, …).
 */
export function leaseVerdict(record: BroadcastRecord, now = Date.now()): 'ok' | 'expired' | undefined {
  if (record.state === 'claimed') {
    const claim = asObject(record.claim);
    const at = Number(claim.at || 0);
    if (!at) return 'expired'; // claimed without a lease stamp: cannot be trusted
    return now - at > (Number(claim.leaseMs) || BCAST_LEASE_MS) ? 'expired' : 'ok';
  }
  if (record.state === 'open' && record.asked?.sid) {
    const at = Number(record.asked.at || 0);
    if (!at) return 'expired';
    return now - at > (Number(record.asked.leaseMs) || BCAST_LEASE_MS) ? 'expired' : 'ok';
  }
  return undefined;
}

export interface ClaimSuccess {
  ok: true;
  claim: JsonObject & { bid: string; token: string; at: number };
}

export interface ClaimFailure {
  ok: false;
  holder: JsonObject;
}

export type ClaimResult = ClaimSuccess | ClaimFailure;

/**
 * Atomic claim: `open(<bid>.lock, "wx")` — exactly one caller creates the file,
 * everyone else reads the holder out of it. The lock is never recreated for a
 * decided hand-off, so a second `collab_accept` always answers "already
 * claimed" (and a lost spawn race cannot create a second session).
 */
export function claimLock(bid: string, claim: JsonObject): ClaimResult {
  mkdirSync(BROADCAST_DIR, { recursive: true });
  let fd: number;
  try {
    fd = openSync(bcastLock(bid), 'wx');
  } catch (error) {
    if (errCode(error) !== 'EEXIST') throw error;
    const holder = asObject(readJsonFile(bcastLock(bid)));
    return { ok: false, holder };
  }
  const value = { bid, token: `k_${Date.now().toString(36)}_${randToken()}`, at: Date.now(), ...claim };
  try {
    writeSync(fd, JSON.stringify(value));
  } finally {
    closeSync(fd);
  }
  return { ok: true, claim: value };
}

/**
 * R1 (0.1.6): merge fields into the **current** `delivery` of a record.
 *
 * Always re-reads first. A write built from a snapshot taken *before* an
 * `await` — a `session.prompt` admission, a protect check, a `sessionInfo` read
 * — silently drops whatever another plugin instance wrote meanwhile. The one
 * that matters is `delivery.seenAt`: the receiving side's `[ack]` can land while
 * the sender is still awaiting its own ack prompt, and overwriting it recreates
 * exactly the "2h later an extra resend, then `unacked`" false positive this
 * task removes (review F1).
 *
 * Only the named delivery fields are touched: `state` / `receipt` / `followUps`
 * and any other concurrent write stay exactly as they are on disk. A record
 * that disappeared (7-day prune) is **not** resurrected — the merge is a no-op.
 */
export function mergeDelivery(bid: string, patch: JsonObject): BroadcastRecord | undefined {
  const fresh = readBroadcast(bid);
  if (!fresh) return undefined;
  return writeBroadcast({ ...fresh, delivery: { ...asObject(fresh.delivery), ...patch } });
}

/**
 * 0.5.0: merge the archive stamp into the **current** record.
 *
 * Same read-merge-write rule as `mergeDelivery`: the `session.update` call is an
 * `await`, and in that window the requester's refresh may write `state` /
 * `receipt` (an auto receipt) or the session may be restored by hand. Writing
 * back the pre-await snapshot would undo that, so only `archivedAt` is touched.
 *
 * `null` clears the stamp (restore). A record that disappeared (7-day prune) is
 * not resurrected — the merge is a no-op.
 */
export function mergeArchive(bid: string, archivedAt: number | null): BroadcastRecord | undefined {
  const fresh = readBroadcast(bid);
  if (!fresh) return undefined;
  const next: BroadcastRecord = { ...fresh };
  if (archivedAt === null) delete next.archivedAt;
  else next.archivedAt = archivedAt;
  return writeBroadcast(next);
}

/**
 * Persist a record that `refreshBroadcast` mutated (lease expiry, attempts,
 * `expired`), so the next reader — a different location — sees the same state.
 */export function persistRefresh(before: BroadcastRecord, after: BroadcastRecord | undefined): BroadcastRecord;
export function persistRefresh(
  before: BroadcastRecord | undefined,
  after: BroadcastRecord | undefined
): BroadcastRecord | undefined;
export function persistRefresh(
  before: BroadcastRecord | undefined,
  after: BroadcastRecord | undefined
): BroadcastRecord | undefined {
  // A refresh that produced no record (unreadable / invalid) leaves the caller
  // on the snapshot it already had; `before` is never undefined at that point.
  if (!after) return before;
  const changed =
    before?.state !== after.state ||
    (before?.attempts ?? 0) !== after.attempts ||
    (before?.skipped ?? []).length !== (after.skipped ?? []).length ||
    Boolean(before?.claim) !== Boolean(after.claim) ||
    (before?.asked?.sid ?? '') !== (after.asked?.sid ?? '') ||
    // R8: the `acked` extraction retry stamp must survive the refresh as well.
    Number(before?.staleNoticedAt ?? 0) !== Number(after.staleNoticedAt ?? 0);
  return changed ? writeBroadcast(after) : after;
}

/**
 * Drop a lock only when the caller really owns it. A spawned session's hand-off
 * is locked by the **spawner** (`by`) while the record's `claim.by` is the new
 * session (`claimBy`, written right after `ctx.session.create`), so both fields
 * are accepted — otherwise a spawn lock could never be released.
 */
export function releaseLock(bid: string, expected: string | string[]): void {
  const wanted = new Set((Array.isArray(expected) ? expected : [expected]).filter(Boolean).map(String));
  if (!wanted.size) return;
  const holder = asObject(readJsonFile(bcastLock(bid)));
  const owners = [holder.by, holder.claimBy].filter(Boolean).map(String);
  if (!owners.some(owner => wanted.has(owner))) return;
  try {
    unlinkSync(bcastLock(bid));
  } catch {
    /* already released */
  }
}

/** Rewrite the lock file in place (only used to record the real claimant). */
export function updateLock(bid: string, patch: JsonObject): void {
  const holder = asObject(readJsonFile(bcastLock(bid)));
  if (!holder.by) return;
  try {
    writeFileSync(bcastLock(bid), JSON.stringify({ ...holder, ...patch }));
  } catch (error) {
    log(`updateLock failed for ${bid}: ${errText(error)}`);
  }
}
