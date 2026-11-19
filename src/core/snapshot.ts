/**
 * C2 (0.3.0): assemble the sidebar's read-only snapshot.
 *
 * Everything here is a *view*: `allLocks()` + `stateOf()` (the same pair
 * `collab_locks` renders), `allBroadcasts()` (the same records `collab_list`
 * lists as "未闭环交接") and `mineFor()` (the same owner-queue items
 * `collab_list` lists as "我提交给受保护会话的请求"). Nothing is written, no
 * lease is reaped on disk, no waiter is woken, no hand-off is advanced, no
 * queue item is stamped — a sidebar poll must never move the state it displays.
 *
 * The readers are injected (`SnapshotSource`) rather than imported directly, so
 * the assembly is unit-testable without a host or a real `~/.config` directory
 * (`test/snapshot-shape.mjs`), and `index.ts` binds the real ones.
 */
import { BCAST_DONE_STATES, MAX_LINEAGE_DEPTH } from '../constants.ts';
import type { BroadcastRecord, FreezeEntry, LockRecord, OwnerQueueItem, SessionInfoLike } from '../types.ts';
import type { Snapshot, SnapshotFreeze, SnapshotHandoff, SnapshotLock, SnapshotQueueItem, SnapshotSession } from '../rpc.ts';
import { asObject, sessionState, truncate, withTimeout } from '../util.ts';
import { freezeFor } from './freeze.ts';
import { stateOf } from './locks.ts';

/** A hung `session.list` must not hang the panel: the lock/hand-off half still answers. */
const SESSIONS_TIMEOUT_MS = 3000;

export interface SnapshotSource {
  /** Sessions of one workspace (the chain's `listSessions`). */
  sessions(input: { directory?: string; limit?: number }): Promise<SessionInfoLike[]>;
  /** Every lease on disk (`allLocks`, read-only). */
  locks(): LockRecord[];
  /** Every hand-off record on disk (`allBroadcasts`, read-only). */
  handoffs(): BroadcastRecord[];
  /**
   * Owner-queue items one session submitted (`mineFor`, read-only). Optional:
   * a host / test that does not need the `queue` block simply omits it, and the
   * block stays empty — it is never an error.
   */
  queue?(from: string): OwnerQueueItem[];
  /**
   * Every **live** freeze (`readFreezes`, read-only). Optional for the same
   * reason as `queue`: omitted = no `frozen` / `freeze` markers at all, never an
   * error (an older server answers without them).
   */
  freezes?(): FreezeEntry[];
}

export interface SnapshotReader {
  /** `collab.state.snapshot` — `{ workspace? }`, anything else is ignored. */
  snapshot(input?: unknown): Promise<Snapshot>;
}

/** The workspace filter a caller may pass (an absolute directory). */
export function readWorkspace(input: unknown): string | undefined {
  const raw = asObject(input).workspace;
  if (typeof raw !== 'string') return undefined;
  const workspace = raw.trim();
  return workspace || undefined;
}

/**
 * The session whose owner queue the caller wants (`{ session }`). Deliberately
 * a plain string: the RPC handler never resolves it against the host, so a
 * wrong id yields an empty `queue` block, not a failed snapshot.
 */
export function readSession(input: unknown): string | undefined {
  const raw = asObject(input).session;
  if (typeof raw !== 'string') return undefined;
  const session = raw.trim();
  return session || undefined;
}

/** One freeze hit → the optional marker the panel reads (display only). */
function toFreeze(hit: { entry: FreezeEntry }): SnapshotFreeze {
  return {
    scope: hit.entry.scope,
    target: hit.entry.target,
    until: hit.entry.until,
    reason: hit.entry.reason
  };
}

function toSession(
  info: SessionInfoLike,
  workspace: string | undefined,
  frozen?: SnapshotFreeze
): SnapshotSession | undefined {
  const sid = String(info?.id ?? '');
  if (!sid) return undefined;
  const state = sessionState(info);
  if (state === 'archived') return undefined; // an archived session holds nothing a human watches
  const parent = info.parentID ?? info.parentId;
  return {
    sid,
    title: truncate(info.title ?? '(untitled)', 80),
    agent: String(info.agent ?? '?'),
    busy: state === 'busy',
    workspace: info?.location?.directory ?? workspace ?? '',
    ...(parent ? { parent: String(parent) } : {}),
    ...(frozen ? { frozen } : {})
  };
}

function toLock(record: LockRecord, now: number): SnapshotLock | undefined {
  // The shared read view: the sidebar must never invent a holder or a TTL.
  // 0.6.0 (R3): `stateOf` also derives the waiter heartbeat ages here — the
  // staleness window is the built-in default (`LOCK_WAITER_TTL_MS`); the view is
  // read-only either way, an old heartbeat is only *shown*, never reaped.
  const state = stateOf(record, now);
  if (state.free && state.waiters.length === 0) return undefined; // nothing to show
  return {
    resource: state.resource,
    kind: state.kind,
    mode: state.mode,
    holders: [...state.holders],
    waiters: state.waiters.length,
    waiting: state.waiters.map(waiter => waiter.sid),
    expiresInMs: state.free ? 0 : Math.max(0, state.expiresIn),
    ...(state.waiterAgeMs ? { waiterAgeMs: [...state.waiterAgeMs] } : {}),
    ...(state.staleWaiters ? { staleWaiters: [...state.staleWaiters], stale: true } : {}),
    ...(state.reason ? { reason: state.reason } : {})
  };
}

function toHandoff(record: BroadcastRecord, now: number, freeze?: SnapshotFreeze): SnapshotHandoff | undefined {
  const bid = String(record.bid ?? '');
  if (!bid) return undefined;
  const state = String(record.state ?? 'open');
  // A decided hand-off is *closed*: the sidebar shows the open queue, not history.
  if (BCAST_DONE_STATES.includes(state)) return undefined;
  const createdAt = Number(record.createdAt ?? record.updatedAt ?? 0) || now;
  return {
    bid,
    state,
    ageMs: Math.max(0, now - createdAt),
    from: String(record.from?.sid ?? ''),
    ...(record.claim?.by ? { claimBy: String(record.claim.by) } : {}),
    ...(record.workspace ? { workspace: String(record.workspace) } : {}),
    title: truncate(record.title ?? record.slug ?? '(untitled)', 60),
    // 0.5.0: read-only marker for a hand-off whose spawned session was archived.
    ...(Number(record.archivedAt) > 0 ? { archived: true } : {}),
    // 0.6.0 (`collab_escalate`): read-only marker; the panel layout is unchanged.
    ...(asObject(record).priority === 'urgent' ? { priority: 'urgent' as const } : {}),
    // 0.6.0 (`collab_freeze`): the bid or its workspace is frozen (read-only).
    ...(freeze ? { freeze } : {})
  };
}

/**
 * One queue item as the panel reads it. `revokedAt` items are left out (revoke
 * deletes the file; the field only survives tampered / legacy records), and a
 * `seen` item stays — the owner read it, the request is still pending a reply.
 */
function toQueueItem(item: OwnerQueueItem, now: number): SnapshotQueueItem | undefined {
  const queueId = String(item.id ?? '');
  if (!queueId || item.revokedAt) return undefined;
  return {
    queueId,
    target: String(item.target ?? ''),
    ageMs: Math.max(0, now - (Number(item.at) || now)),
    summary: truncate(item.summary ?? '', 80),
    ...(item.issuePath ? { issuePath: String(item.issuePath) } : {}),
    ...(item.bid ? { bid: String(item.bid) } : {}),
    ...(asObject(item).priority === 'urgent' ? { priority: 'urgent' as const } : {}),
    seen: Boolean(item.seenAt)
  };
}

/**
 * Build one snapshot. Read-only, and the only await is the session list (with a
 * 3 s cap): a 2 s poll touches the same files the tools read, never a write.
 */
export async function buildSnapshot(source: SnapshotSource, input?: unknown, now = Date.now()): Promise<Snapshot> {
  const workspace = readWorkspace(input);
  let listed: SessionInfoLike[] = [];
  try {
    listed = await withTimeout(
      source.sessions(workspace ? { directory: workspace, limit: 100 } : { limit: 100 }),
      SESSIONS_TIMEOUT_MS,
      'session list timeout'
    );
  } catch {
    listed = []; // an unreachable session list is an empty list, not a failed snapshot
  }

  // 0.6.0 (`collab_freeze`): live freezes, read-only. A source without the
  // reader (an older server / a unit test) simply has no markers; an expired
  // entry is dropped here as well, so a reader that returns the raw file still
  // cannot mark a freeze that is over.
  const freezes = (typeof source.freezes === 'function' ? source.freezes() : []).filter(
    entry => Number(entry?.until) > now
  );

  // 0.6.0 (`collab_freeze`): the freeze marker per session, computed once from
  // the page we already have (its `parentID` chain) — no host call, no write.
  const frozenSessions = new Map<string, SnapshotFreeze>();
  if (freezes.length) {
    const parentOf = new Map(
      listed.map(info => [String(info?.id ?? ''), String(info?.parentID ?? info?.parentId ?? '')] as const)
    );
    for (const info of listed) {
      const sid = String(info?.id ?? '');
      if (!sid) continue;
      const chain: string[] = [];
      const seen = new Set<string>([sid]);
      let parent = parentOf.get(sid) ?? '';
      while (parent && chain.length < MAX_LINEAGE_DEPTH && !seen.has(parent)) {
        chain.push(parent);
        seen.add(parent);
        parent = parentOf.get(parent) ?? '';
      }
      const hit = freezeFor(freezes, {
        session: sid,
        ancestors: chain,
        workspace: info?.location?.directory ?? workspace
      });
      if (hit) frozenSessions.set(sid, toFreeze(hit));
    }
  }

  const sessions = listed
    .map(info => toSession(info, workspace, frozenSessions.get(String(info?.id ?? ''))))
    .filter((session): session is SnapshotSession => Boolean(session))
    .filter(session => (workspace ? !session.workspace || session.workspace === workspace : true))
    .sort(
      (left, right) =>
        left.workspace.localeCompare(right.workspace) ||
        Number(right.busy) - Number(left.busy) ||
        left.sid.localeCompare(right.sid)
    );

  const leases = source
    .locks()
    .map(record => toLock(record, now))
    .filter((lock): lock is SnapshotLock => Boolean(lock))
    .sort((left, right) => left.resource.localeCompare(right.resource));

  const handoffs = source
    .handoffs()
    .map(record => {
      const hit = freezes.length
        ? freezeFor(freezes, { bid: record.bid, workspace: record.workspace })
        : undefined;
      return toHandoff(record, now, hit ? toFreeze(hit) : undefined);
    })
    .filter((handoff): handoff is SnapshotHandoff => Boolean(handoff))
    .filter(handoff => (workspace ? handoff.workspace === workspace : true))
    .sort((left, right) => right.ageMs - left.ageMs || left.bid.localeCompare(right.bid));

  // The queue is *the caller's own*: no session named → no scan of every
  // target's directory, and no row that belongs to somebody else.
  const from = readSession(input);
  const queue = from && typeof source.queue === 'function'
    ? source
        .queue(from)
        .map(item => toQueueItem(item, now))
        .filter((item): item is SnapshotQueueItem => Boolean(item))
        .sort((left, right) => right.ageMs - left.ageMs || left.queueId.localeCompare(right.queueId))
    : [];

  return { at: now, sessions, locks: leases, handoffs, queue, reachable: true };
}

export function createSnapshotReader(source: SnapshotSource): SnapshotReader {
  return {
    snapshot(input?: unknown) {
      return buildSnapshot(source, input);
    }
  };
}
