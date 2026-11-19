/**
 * 0.6.0 (`collab-board`): the **one derivation** the GUI panel and the TUI panel
 * both render — `snapshot → Workspace[] → Session[]` with the relations the
 * flat snapshot cannot express on its own.
 *
 * The snapshot is a set of independent lists (sessions, leases, hand-offs,
 * queue). The board answers the three questions a human actually asks of it:
 *
 *   - which leases / hand-offs / queue items belong to **this** session?
 *   - which sessions did **this** session pull in (`claim.kind = "spawn"`)?
 *   - which sessions are archived (filed under `已归档`, not mixed into the
 *     active list) and which are frozen / urgent?
 *
 * It is deliberately **pure and I/O-free** (`buildBoard(snapshot, freezes, now)`):
 * no host, no file, no clock of its own. The GUI bundle imports it, so it must
 * not pull `node:fs` in — the freeze marker therefore comes from
 * `core/freeze-pure.ts`, the same `freezeFor` implementation the server-side
 * `core/freeze.ts` re-exports (0.6.1, R1: one rule, never a copy). Older
 * snapshots (no `archived` / `kind` / `spawned` fields) derive exactly as
 * before: absence is `false`, never an empty badge.
 *
 * Read-only (R5): the board only *files* what the snapshot already reported.
 * No lease is released, no session archived, no freeze lifted.
 */
import type { FreezeEntry } from '../types.ts';
import { freezeFor, freezeMarker, liveFreezeMarker, liveFreezes } from './freeze-pure.ts';
import type {
  Snapshot,
  SnapshotFreeze,
  SnapshotHandoff,
  SnapshotLock,
  SnapshotQueueItem,
  SnapshotSession
} from '../rpc.ts';

/** One session this hand-off pulled in (`↳` line). */
export interface BoardSpawn {
  sid: string;
  state: string;
  archived: boolean;
  title?: string;
}

/** The short counters a session row prints (`🔒n` / `‹m›` / `⇢k`). */
export interface BoardBadges {
  /** Leases where this session is a **holder**. */
  held: number;
  /** Leases where this session is **queued**. */
  waiting: number;
  /** Open hand-offs this session started or took. */
  handoffs: number;
  /** Owner-queue items this session submitted (only when the caller names it). */
  queue: number;
}

export interface BoardSession {
  sid: string;
  title: string;
  agent: string;
  busy: boolean;
  /** Absolute workspace directory (`''` = the global group). */
  workspace: string;
  archived: boolean;
  frozen?: SnapshotFreeze;
  /** Any of this session's hand-offs / queue items is `priority:"urgent"`. */
  urgent: boolean;
  locks: SnapshotLock[];
  handoffs: SnapshotHandoff[];
  spawned: BoardSpawn[];
  queue: SnapshotQueueItem[];
  badges: BoardBadges;
}

/** Workspace header numbers: `N 会话 · M 锁 · K 交接 · A 已归档`. */
export interface BoardCounts {
  sessions: number;
  locks: number;
  handoffs: number;
  archived: number;
}

export interface BoardWorkspace {
  workspace: string;
  /** Active sessions (archived ones live in `archived[]`). */
  sessions: BoardSession[];
  archived: BoardSession[];
  counts: BoardCounts;
}

/** Snapshot rows no board session owns (an older server / a vanished session). */
export interface BoardOrphans {
  locks: SnapshotLock[];
  handoffs: SnapshotHandoff[];
  queue: SnapshotQueueItem[];
}

/**
 * The fallback rows: leases / hand-offs / queue items that no session row owns.
 * Both panels render these after the tree, so a row the header counts is never
 * silently missing from the body (0.5.3's flat view showed them too).
 */
export function boardOrphans(snapshot: Snapshot | undefined, board: BoardWorkspace[]): BoardOrphans {
  const attachedLocks = new Set<string>();
  const attachedHandoffs = new Set<string>();
  const attachedQueue = new Set<string>();
  for (const workspace of board) {
    for (const session of [...workspace.sessions, ...workspace.archived]) {
      for (const lock of session.locks) attachedLocks.add(lock.resource);
      for (const handoff of session.handoffs) attachedHandoffs.add(handoff.bid);
      for (const item of session.queue) attachedQueue.add(item.queueId);
    }
  }
  return {
    locks: (snapshot?.locks ?? []).filter(lock => !attachedLocks.has(lock.resource)),
    handoffs: (snapshot?.handoffs ?? []).filter(handoff => !attachedHandoffs.has(handoff.bid)),
    queue: (snapshot?.queue ?? []).filter(item => !attachedQueue.has(item.queueId))
  };
}

interface Group {
  workspace: string;
  sessions: SnapshotSession[];
  archived: SnapshotSession[];
  locks: SnapshotLock[];
  handoffs: SnapshotHandoff[];
}

/**
 * Marker + precedence for one session row: the snapshot's own marker first
 * (already resolved by `buildSnapshot` with ancestors + workspace, and kept
 * only while live), else `freezeFor` from `core/freeze-pure.ts` —
 * `session` (self, then ancestors) > `workspace`. No rule of its own.
 */
const freezeOf = (
  session: SnapshotSession,
  ancestors: string[],
  entries: FreezeEntry[],
  now: number
): SnapshotFreeze | undefined => {
  const fromSnapshot = liveFreezeMarker(session.frozen, now);
  if (fromSnapshot) return fromSnapshot;
  if (!entries.length) return undefined;
  const hit = freezeFor(entries, { session: session.sid, ancestors, workspace: session.workspace || '' });
  return hit ? freezeMarker(hit.entry) : undefined;
};

/**
 * Build the three-layer board.
 *
 * `freezes` is the **live** freeze list, i.e. `readFreezes(now)` output
 * (expired entries already dropped); the panels pass `[]` and rely on
 * `session.frozen`, which the snapshot already computed. `now` decides whether
 * that marker is still live and re-applies the same pure `liveFreezes` filter to
 * whatever list came in (a raw file must not paint an expired freeze) — the
 * expiry rule and the precedence rule both live in `core/freeze-pure.ts`, not
 * here. `me` is the caller's session id: the snapshot's `queue` block belongs
 * to *that* session (it is `mineFor(session)`), so it is attached to that row
 * instead of being guessed onto somebody else.
 */
export function buildBoard(
  snapshot: Snapshot | undefined,
  freezes: FreezeEntry[] = [],
  now = Date.now(),
  me?: string
): BoardWorkspace[] {
  const sessions = snapshot?.sessions ?? [];
  const live = liveFreezes(freezes, now);
  const locks = snapshot?.locks ?? [];
  const handoffs = snapshot?.handoffs ?? [];
  const queue = snapshot?.queue ?? [];

  const dirOf = new Map<string, string>();
  const parentOf = new Map<string, string>();
  const bySid = new Map<string, SnapshotSession>();
  for (const session of sessions) {
    dirOf.set(session.sid, session.workspace || '');
    bySid.set(session.sid, session);
    if (session.parent) parentOf.set(session.sid, session.parent);
  }

  const groups = new Map<string, Group>();
  const group = (workspace: string): Group => {
    const key = workspace || '';
    let entry = groups.get(key);
    if (!entry) {
      entry = { workspace: key, sessions: [], archived: [], locks: [], handoffs: [] };
      groups.set(key, entry);
    }
    return entry;
  };

  for (const session of sessions) {
    const entry = group(session.workspace || '');
    if (session.archived) entry.archived.push(session);
    else entry.sessions.push(session);
  }

  // A lease has no directory of its own: file it under the first holder/waiter
  // that is a listed session, else under the global group (`''`).
  for (const lock of locks) {
    const owner = [...(lock.holders ?? []), ...(lock.waiting ?? [])]
      .map(sid => dirOf.get(sid))
      .find(dir => dir !== undefined);
    group(owner ?? '').locks.push(lock);
  }

  // A hand-off carries its workspace, but an older record may not: fall back to
  // the requester's workspace, then to the global group.
  for (const handoff of handoffs) {
    group(handoff.workspace || dirOf.get(handoff.from) || '').handoffs.push(handoff);
  }

  const ancestorsOf = (sid: string): string[] => {
    const chain: string[] = [];
    const seen = new Set<string>([sid]);
    let parent = parentOf.get(sid) ?? '';
    while (parent && chain.length < 32 && !seen.has(parent)) {
      chain.push(parent);
      seen.add(parent);
      parent = parentOf.get(parent) ?? '';
    }
    return chain;
  };

  const board: BoardWorkspace[] = [];
  for (const entry of [...groups.values()].sort((left, right) => left.workspace.localeCompare(right.workspace))) {
    const toBoard = (session: SnapshotSession): BoardSession => {
      const mine = me !== undefined && session.sid === me;
      const frozen = freezeOf(session, ancestorsOf(session.sid), live, now);
      const myLocks = locks.filter(
        lock => (lock.holders ?? []).includes(session.sid) || (lock.waiting ?? []).includes(session.sid)
      );
      const myHandoffs = handoffs.filter(
        handoff => handoff.from === session.sid || handoff.claimBy === session.sid
      );
      const myQueue = mine ? queue : [];
      const spawned: BoardSpawn[] = handoffs
        .filter(handoff => handoff.kind === 'spawn' && handoff.from === session.sid)
        .map(handoff => {
          const child = String(handoff.spawned ?? handoff.claimBy ?? '');
          const info = child ? bySid.get(child) : undefined;
          const title = info?.title ?? handoff.title;
          return {
            sid: child,
            state: handoff.state,
            archived: Boolean(info?.archived || handoff.archived),
            ...(title ? { title } : {})
          };
        })
        .filter(spawn => Boolean(spawn.sid));
      return {
        sid: session.sid,
        title: session.title,
        agent: session.agent,
        // An archived session is not running: never carry the host's last busy
        // clock into the 已归档 section (snapshot.ts also forces busy:false).
        busy: !session.archived && Boolean(session.busy),
        workspace: session.workspace || entry.workspace,
        archived: Boolean(session.archived),
        ...(frozen ? { frozen } : {}),
        urgent:
          myHandoffs.some(handoff => handoff.priority === 'urgent') ||
          myQueue.some(item => item.priority === 'urgent'),
        locks: myLocks,
        handoffs: myHandoffs,
        spawned,
        queue: myQueue,
        badges: {
          held: myLocks.filter(lock => (lock.holders ?? []).includes(session.sid)).length,
          waiting: myLocks.filter(lock => (lock.waiting ?? []).includes(session.sid)).length,
          handoffs: myHandoffs.length,
          queue: myQueue.length
        }
      };
    };

    const active = entry.sessions.map(toBoard).sort(
      (left, right) =>
        Number(right.busy) - Number(left.busy) || left.sid.localeCompare(right.sid)
    );
    const archived = entry.archived.map(toBoard).sort((left, right) => left.sid.localeCompare(right.sid));
    board.push({
      workspace: entry.workspace,
      sessions: active,
      archived,
      counts: {
        sessions: active.length,
        locks: entry.locks.length,
        handoffs: entry.handoffs.length,
        archived: archived.length
      }
    });
  }
  return board;
}
