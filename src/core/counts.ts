/**
 * R4 (0.6.0): the **four** numbers the header bar, the TUI sidebar and the TUI
 * panel print — computed in one place so the three surfaces cannot disagree.
 *
 *     持有 N · 排队 M · 待受保护 K · 宿主排队 J
 *
 * Why this file exists: the old `锁 N` was `snapshot.locks.length`, i.e. the
 * number of lock *records worth showing*. A resource that nobody held but that
 * carried one zombie waiter was kept by `snapshot.ts` (it has something to
 * show) and counted as a "锁" — reading as "1 lock" while the real answer was
 * "1 person waiting behind a free resource, 0 holders". The same number was
 * called `队列` in one place and `交接` in another. So:
 *
 *   - 持有 (`held`)      = leases with at least one **holder** (waiters never count)
 *   - 排队 (`waiting`)   = the sum of every FIFO queue
 *   - 待受保护 (`protected`) = the caller's owner-queue items (this session → a
 *     protected target; the panel has always called this `队列`)
 *   - 宿主排队 (`host`)  = the host's own prompt queue (`delivery=queue`); it is
 *     **not** part of the RPC snapshot, so it is read from the host and merged
 *     by each surface (`pendingCountOf` below).
 *
 * Pure and DOM-free: the GUI bundle imports it (type-only imports are erased, so
 * no `node:` module leaks into the window bundle).
 */
import type { Snapshot } from '../rpc.ts';

export interface CollabCounts {
  /** Leases that really have a holder. */
  held: number;
  /** Every queued waiter, summed over resources. */
  waiting: number;
  /** Owner-queue items this session submitted to protected targets. */
  protected: number;
}

/** The host's own prompt queue, tolerating a host without the API. */
export interface PendingLike {
  list(sessionID: string): unknown[] | undefined;
}

/**
 * The three numbers that live in the snapshot. `host` is deliberately absent:
 * the host prompt queue is not part of `collab.state.snapshot` (it belongs to
 * the app, not to this plugin), so each surface adds it with `pendingCountOf`.
 */
export function countsOf(snapshot: Pick<Snapshot, 'locks' | 'queue'> | undefined): CollabCounts {
  const locks = snapshot?.locks ?? [];
  const queue = snapshot?.queue ?? [];
  return {
    held: locks.filter(lock => (lock?.holders?.length ?? 0) > 0).length,
    waiting: locks.reduce((total, lock) => total + (Number(lock?.waiters) || 0), 0),
    protected: queue.length
  };
}

/**
 * `宿主排队`: how many prompts the app itself still has queued for a session
 * (`delivery:"queue"`). Read from the already-synced host data — no RPC, no new
 * poll — and `0` (never a throw, never `n/a`) when the host has no such API: a
 * status line must not take a pane down.
 */
export function pendingCountOf(pending: PendingLike | undefined, sessionID: string | undefined): number {
  const sid = String(sessionID ?? '').trim();
  if (!pending || !sid) return 0;
  try {
    return pending.list(sid)?.length ?? 0;
  } catch {
    return 0;
  }
}
