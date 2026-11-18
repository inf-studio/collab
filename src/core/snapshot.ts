/**
 * C2 (0.3.0): assemble the sidebar's read-only snapshot.
 *
 * Everything here is a *view*: `allLocks()` + `stateOf()` (the same pair
 * `collab_locks` renders) and `allBroadcasts()` (the same records `collab_list`
 * lists as "未闭环交接"). Nothing is written, no lease is reaped on disk, no
 * waiter is woken, no hand-off is advanced — a sidebar poll must never move the
 * state it displays.
 *
 * The readers are injected (`SnapshotSource`) rather than imported directly, so
 * the assembly is unit-testable without a host or a real `~/.config` directory
 * (`test/snapshot-shape.mjs`), and `index.ts` binds the real ones.
 */
import { BCAST_DONE_STATES } from '../constants.ts';
import type { BroadcastRecord, LockRecord, SessionInfoLike } from '../types.ts';
import type { Snapshot, SnapshotHandoff, SnapshotLock, SnapshotSession } from '../rpc.ts';
import { asObject, sessionState, truncate, withTimeout } from '../util.ts';
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

function toSession(info: SessionInfoLike, workspace: string | undefined): SnapshotSession | undefined {
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
    ...(parent ? { parent: String(parent) } : {})
  };
}

function toLock(record: LockRecord, now: number): SnapshotLock | undefined {
  // The shared read view: the sidebar must never invent a holder or a TTL.
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
    ...(state.reason ? { reason: state.reason } : {})
  };
}

function toHandoff(record: BroadcastRecord, now: number): SnapshotHandoff | undefined {
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
    title: truncate(record.title ?? record.slug ?? '(untitled)', 60)
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

  const sessions = listed
    .map(info => toSession(info, workspace))
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
    .map(record => toHandoff(record, now))
    .filter((handoff): handoff is SnapshotHandoff => Boolean(handoff))
    .filter(handoff => (workspace ? handoff.workspace === workspace : true))
    .sort((left, right) => right.ageMs - left.ageMs || left.bid.localeCompare(right.bid));

  return { at: now, sessions, locks: leases, handoffs, reachable: true };
}

export function createSnapshotReader(source: SnapshotSource): SnapshotReader {
  return {
    snapshot(input?: unknown) {
      return buildSnapshot(source, input);
    }
  };
}
