/**
 * R1–R6 (0.1.6): two-level acknowledgement, bounded resend and the post-closure
 * follow-up hint — the pure half (no I/O, no `ctx`).
 *
 * Why "seen" and not "handled": this host runs 50 sessions with 900h+ uptime,
 * a single turn can take tens of minutes, and the same session may hold a 57M
 * token history. "The turn finished" is therefore not a usable definition of
 * delivered, and blind re-delivery would queue the same work twice. So a
 * hand-off is acknowledged in two steps:
 *
 *   admitted  the host took it (`session.prompt` → `message.id`), or the ask was
 *             written into the record for the receiving plugin's next
 *             `context` injection (`delivery.admittedAt`);
 *   seen      the *receiving* plugin surfaced it (its `context` hook or
 *             `collab_inbox`) and answered `[ack] <cid> seen` on a side path.
 *
 * A message may be re-delivered **once**, after `ACK_SEEN_WINDOW_MS`, and only
 * to an **idle** target (a busy target already holds the message; queueing a
 * second copy only grows its backlog). No `seen` after the resend → `unacked`,
 * which is surfaced by `collab_list` for a human to re-deliver.
 *
 * R5 is a **pull** design, deliberately: a closure is not a licence to push
 * into a protected line (that is what `protect` exists to prevent). See
 * `core/followup.ts` for the structured append + read-only hint.
 */
import { ACK_SEEN_WINDOW_MS, MAX_RESENDS } from '../constants.ts';
import type { BroadcastDelivery, BroadcastRecord } from '../types.ts';
import { asObject } from '../util.ts';

/** `[ack] <cid> seen` — a machine note, never a hand-off receipt. */
const ACK_RE = /^[ \t]*\[ack\][ \t]+(c_[0-9a-z_]+)\b/i;
/** Anything starting with `[ack] ` is ack traffic (never re-acked, never injected). */
const ACK_PREFIX_RE = /^[ \t]*\[ack\]/i;

/** The ack body a receiving plugin sends back (`kind:"note"`, `queue`). */
export function buildAck(cid: unknown): string {
  return `[ack] ${String(cid ?? '').trim()} seen`;
}

/** The `cid` an `[ack]` names, or undefined when the text is not an ack. */
export function parseAck(text: unknown): string | undefined {
  const match = ACK_RE.exec(String(text ?? ''));
  return match?.[1];
}

/** Is this text ack traffic? Ack messages never produce another ack (no loops). */
export function isAckText(text: unknown): boolean {
  return ACK_PREFIX_RE.test(String(text ?? ''));
}

/** The `delivery` block of a record, as a plain object (`{}` when absent). */
export function deliveryOf(record: BroadcastRecord | undefined): BroadcastDelivery {
  return asObject(asObject(record).delivery) as BroadcastDelivery;
}

/** R1: the receiving side stamps `seenAt` when the ack arrives. */
export function markSeen(record: BroadcastRecord, cid: unknown, now = Date.now()): BroadcastRecord | undefined {
  const delivery = deliveryOf(record);
  if (!delivery.cid || String(delivery.cid) !== String(cid ?? '').trim()) return undefined;
  if (delivery.seenAt) return undefined; // already seen: nothing to write
  return { ...record, delivery: { ...delivery, seenAt: now } };
}

/**
 * R2: may this hand-off be delivered one more time? Pure predicate; the caller
 * still has to check the target is idle (`busy` never resends) and unprotected.
 *
 *   - no `delivery` / no `cid` (record written by ≤0.1.5) → never;
 *   - already `seen`, `ackUnavailable`, or the budget is used up → never;
 *   - the admission failed → retry on the next refresh (nothing was queued);
 *   - the admission is older than `ACK_SEEN_WINDOW_MS` and no ack came back → retry.
 */
export function resendDue(record: BroadcastRecord, now = Date.now()): boolean {
  const delivery = deliveryOf(record);
  if (!delivery.cid || !delivery.to) return false;
  if (delivery.seenAt || delivery.ackUnavailable) return false;
  if ((Number(delivery.resends) || 0) >= MAX_RESENDS) return false;
  // The single session that still owes an answer must be the one the message
  // went to. After a DECLINE / lease advance / someone else's claim the cid
  // belongs to a session that no longer owes anything — never re-queue into it.
  const asked = String(record.asked?.sid ?? '');
  if (asked && asked !== String(delivery.to)) return false;
  const claimant = String(asObject(record.claim).by ?? '');
  if (claimant && claimant !== String(delivery.to)) return false;
  const admittedAt = Number(delivery.admittedAt || 0);
  if (!admittedAt) return Boolean(delivery.failedAt);
  return now - admittedAt > ACK_SEEN_WINDOW_MS;
}

/**
 * R2: the resend budget is spent and the last attempt is older than the same
 * window, still without an ack → `unacked` (`collab_list` says "可人工补投").
 */
export function unackedDue(record: BroadcastRecord, now = Date.now()): boolean {
  const delivery = deliveryOf(record);
  if (!delivery.cid || delivery.seenAt || delivery.ackUnavailable) return false;
  if ((Number(delivery.resends) || 0) < MAX_RESENDS) return false;
  const since = Number(delivery.lastAttemptAt || delivery.failedAt || delivery.admittedAt || 0);
  return Boolean(since) && now - since > ACK_SEEN_WINDOW_MS;
}

/** `45min` / `2.1h` — the label `collab_list` uses for ages. */
export function ageLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const minutes = ms / 60_000;
  return minutes < 90 ? `${Math.max(0, Math.round(minutes))}min` : `${(minutes / 60).toFixed(1)}h`;
}

/**
 * R3: one line of delivery visibility:
 *   `admitted=30min seen=24min queue-age=30min resend=0 unacked=-`
 *
 * `queue-age` = how long the message has been the target's job (admitted → now);
 * `unacked=yes` means "budget spent, still no ack — 可人工补投".
 */
export function deliveryLine(record: BroadcastRecord, now = Date.now()): string {
  const delivery = deliveryOf(record);
  if (!delivery.cid) return 'admitted=- seen=- queue-age=- resend=0 unacked=-';
  const admittedAt = Number(delivery.admittedAt || 0);
  const seenAt = Number(delivery.seenAt || 0);
  const admitted = delivery.failedAt && !admittedAt ? 'failed' : admittedAt ? ageLabel(now - admittedAt) : '-';
  const seen = seenAt ? ageLabel(now - seenAt) : delivery.ackUnavailable ? 'n/a' : '-';
  const queueAge = admittedAt ? ageLabel(now - admittedAt) : '-';
  const unacked = delivery.unacked || unackedDue(record, now) ? 'yes' : '-';
  return (
    `admitted=${admitted} seen=${seen} queue-age=${queueAge} ` +
    `resend=${Number(delivery.resends) || 0} unacked=${unacked}`
  );
}

/** R3: show the delivery line for unresolved work and for anything unacked. */
export function deliveryVisible(record: BroadcastRecord, now = Date.now()): boolean {
  const delivery = deliveryOf(record);
  if (!delivery.cid) return false;
  if (!['done', 'blocked', 'expired'].includes(String(record.state))) return true;
  return Boolean(delivery.unacked || unackedDue(record, now));
}