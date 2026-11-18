/**
 * Hang-up monitoring (PRD R6).
 *
 * A hand-off can be perfectly "valid" and still be stuck: nobody claimed an
 * `open` broadcast, the claimant never confirmed, or the receipt of an `acked`
 * hand-off never arrived. The chain's own reminders are per-record and fire at
 * transition time; this module adds a **session-scoped** view of what is stale
 * *now*, shown once per `(session, class, bid)` from both `collab_list` and the
 * `context` injection (design §5).
 *
 * Read-only by design: it never refreshes a record, never releases a lock and
 * never closes anything — the only write is the per-session "already shown"
 * memory in `ctx.storage`.
 */
import { STALE_ACKED_MS, STALE_OPEN_MS, STALE_SEEN_LIMIT, BCAST_LEASE_MS } from '../constants.ts';
import type { BroadcastRecord, CollabContext } from '../types.ts';
import { asObject } from '../util.ts';

export type StaleClass = 'open-stale' | 'claimed-lapsed' | 'acked-stale';

export interface StaleItem {
  bid: string;
  class: StaleClass;
  ageMs: number;
  note: string;
}

const NOTES: Record<StaleClass, string> = {
  'open-stale': '无人领取太久：可重新广播，或人工指定 target',
  'claimed-lapsed': '承接方未确认（租约已过）：可顺延到下一候选，或人工指定',
  'acked-stale': '回执静默超过 2h：发起方可只读提取承接方最后一条回答收口'
};

function hours(ms: number): string {
  const h = ms / 3_600_000;
  return h >= 1 ? `${h.toFixed(1)}h` : `${Math.max(1, Math.round(ms / 60_000))}min`;
}

/**
 * Which class (if any) a record falls into. `undefined` = on time / decided /
 * no timestamp to judge (a record without `claim.at` is never guessed at).
 */
export function staleClass(record: BroadcastRecord, now = Date.now()): StaleItem | undefined {
  const bid = String(record?.bid ?? '');
  if (!bid) return undefined;
  if (record.state === 'open') {
    const createdAt = Number(record.createdAt || record.updatedAt || 0);
    if (createdAt && now - createdAt > STALE_OPEN_MS) {
      return { bid, class: 'open-stale', ageMs: now - createdAt, note: NOTES['open-stale'] };
    }
    return undefined;
  }
  if (record.state === 'claimed') {
    const at = Number(asObject(record.claim).at ?? 0);
    if (!at) return undefined;
    const lease = Number(asObject(record.claim).leaseMs) || BCAST_LEASE_MS;
    if (now - at > lease) return { bid, class: 'claimed-lapsed', ageMs: now - at, note: NOTES['claimed-lapsed'] };
    return undefined;
  }
  if (record.state === 'acked') {
    const at = Number(asObject(record.claim).at ?? 0);
    if (at && now - at > STALE_ACKED_MS) {
      return { bid, class: 'acked-stale', ageMs: now - at, note: NOTES['acked-stale'] };
    }
  }
  return undefined;
}

/** Does this hand-off involve the session (requester / claimant / asked)? */
export function involves(record: BroadcastRecord, sessionID: string | undefined): boolean {
  if (!sessionID) return false;
  const claim = asObject(record.claim);
  return (
    String(record.from?.sid ?? '') === sessionID ||
    String(claim.by ?? '') === sessionID ||
    String(record.asked?.sid ?? '') === sessionID
  );
}

/** Stale items of this session, one per `(class, bid)`, oldest first. */
export function staleFor(
  records: BroadcastRecord[],
  sessionID: string | undefined,
  now = Date.now()
): StaleItem[] {
  if (!sessionID) return [];
  const seen = new Set<string>();
  const out: StaleItem[] = [];
  for (const record of records) {
    if (!involves(record, sessionID)) continue;
    const item = staleClass(record, now);
    if (!item) continue;
    const key = `${item.class}:${item.bid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.sort((a, b) => b.ageMs - a.ageMs);
}

export function staleKey(item: StaleItem): string {
  return `${item.class}:${item.bid}`;
}

export function formatStale(items: StaleItem[], now = Date.now()): string[] {
  void now;
  return items.map(item => `- [${item.class}] ${item.bid} 已 ${hours(item.ageMs)} —— ${item.note}`);
}

function seenKey(sessionID: string): string {
  return `collab/stale-seen/${sessionID}`;
}

/** Per-session memory of shown reminders (survives restarts, same as inbox). */
export async function readSeen(ctx: CollabContext, sessionID: string): Promise<string[]> {
  const raw = asObject(await ctx.storage.get(seenKey(sessionID)));
  return Array.isArray(raw.keys) ? raw.keys.filter((key: unknown): key is string => typeof key === 'string') : [];
}

/**
 * Filter to the items this session has not been shown yet **and** remember
 * them. Called right before the lines are appended, so a reminder is emitted at
 * most once per session even across restarts.
 */
export async function markShown(
  ctx: CollabContext,
  sessionID: string,
  items: StaleItem[]
): Promise<StaleItem[]> {
  if (!items.length) return [];
  const seen = new Set(await readSeen(ctx, sessionID));
  const fresh = items.filter(item => !seen.has(staleKey(item)));
  if (!fresh.length) return [];
  const keys = [...seen, ...fresh.map(staleKey)].slice(-STALE_SEEN_LIMIT);
  await ctx.storage.set(seenKey(sessionID), { keys, updated: Date.now() });
  return fresh;
}
