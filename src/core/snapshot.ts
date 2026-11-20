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
import type {
  Snapshot,
  SnapshotContract,
  SnapshotFreeze,
  SnapshotHandoff,
  SnapshotIndex,
  SnapshotLock,
  SnapshotQueueItem,
  SnapshotSession
} from '../rpc.ts';
import { asObject, mtime, sessionState, truncate, withTimeout } from '../util.ts';
import { contractFile, readContract, TODO_DONE_STATUSES, type Contract } from './contract.ts';
import { driftUnresolved, evaluate, type DriftEvaluation } from './drift.ts';
import { freezeFor } from './freeze.ts';
import { stateOf } from './locks.ts';

/** A hung `session.list` must not hang the panel: the lock/hand-off half still answers. */
const SESSIONS_TIMEOUT_MS = 3000;

export interface SnapshotSource {
  /** Sessions of one workspace (the chain's `listSessions`). */
  sessions(input: { directory?: string; limit?: number }): Promise<SessionInfoLike[]>;
  /**
   * Every lease (read-only). 0.9.0 (R5): may be async — the index-preferred
   * reader falls back to `allLocks()` when the projection is stale/absent.
   */
  locks(): Promise<LockRecord[]> | LockRecord[];
  /** Every hand-off record (read-only; async for the same reason). */
  handoffs(): Promise<BroadcastRecord[]> | BroadcastRecord[];
  /**
   * Owner-queue items one session submitted (`mineFor`, read-only). Optional:
   * a host / test that does not need the `queue` block simply omits it, and the
   * block stays empty — it is never an error.
   */
  queue?(from: string): Promise<OwnerQueueItem[]> | OwnerQueueItem[];
  /**
   * Every **live** freeze (`readFreezes`, read-only). Optional for the same
   * reason as `queue`: omitted = no `frozen` / `freeze` markers at all, never an
   * error (an older server answers without them).
   */
  freezes?(): FreezeEntry[];
  /**
   * 0.9.0 (R4): can the projection be read? Optional and awaited once per
   * snapshot: a host / test without the reader omits the marker entirely (an
   * older server is not "degraded"). Read-only — the check must never create the
   * database.
   */
  index?(): Promise<SnapshotIndex> | SnapshotIndex;
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

/* ------------------------------------------------- 0.9.7: the contract block */

/**
 * `collab-contract/<sid>.json`, **mtime-cached**: the panel polls every 2 s and
 * a contract only changes when a contract tool writes it, so re-parsing 100
 * files per tick would be pure waste. Same pattern as `createConfigReader`
 * (`config.ts`): the stat is the cache key, a changed file is re-read, a deleted
 * file evicts the entry.
 *
 * Read-only: `readContract` never writes (lazy creation, `contract.ts`), so a
 * board poll cannot create a contract file for a session that never had one —
 * R5's "no file, byte-identical output" depends on that.
 */
const contractCache = new Map<string, { stamp: number; contract?: Contract }>();

function cachedContract(sessionID: string): Contract | undefined {
  const stamp = mtime(contractFile(sessionID));
  if (!stamp) {
    contractCache.delete(sessionID);
    return undefined;
  }
  const hit = contractCache.get(sessionID);
  if (hit && hit.stamp === stamp) return hit.contract;
  const read = readContract(sessionID);
  // Two different kinds of "no contract here", both of which must **omit** the
  // field rather than paint an empty block — but only one of them is an error:
  //
  //   - **unparseable JSON** (truncated / hand-edited junk): `readContract` logs
  //     exactly one line (`ignoring unreadable contract …`) and returns the empty
  //     contract. This is the only case that logs.
  //   - **parseable but not ours** (`v` ≠ 1, a foreign `sid`, or `updatedAt: 0`):
  //     normalised to the empty contract **silently** — an older / newer file is
  //     not corruption, so no log line. `updatedAt === 0` is the marker: every
  //     `writeContract` stamps it, so a real contract always has one.
  const contract = Number(read.updatedAt) > 0 ? read : undefined;
  contractCache.set(sessionID, { stamp, contract });
  return contract;
}

/**
 * The moment a drift is measured from — what the board prints as `drift 11h`.
 *
 * Each trigger is measured against **its own** stamp (the one the reason text
 * quotes), otherwise the TUI said `drift <1m` while the injection said
 * 「T1 已挂起 4.0d 未醒」:
 *
 *   no-advance        → last verified advance (`turn.lastAdvancedAt`, then `lastAt`)
 *   mission-parked    → `mission.parkedAt`
 *   suspended-expired → now − the **oldest** expired suspension's age
 *   unresolved / rest → `turn.driftAt` (when the reminder was first shown)
 */
function driftSince(contract: Contract, evaluation: DriftEvaluation, now: number): number {
  const code = evaluation.reasons[0]?.code;
  if (code === 'no-advance') {
    return (
      Number(contract.turn?.lastAdvancedAt) ||
      Number(contract.turn?.lastAt) ||
      Number(contract.updatedAt) ||
      now
    );
  }
  if (code === 'mission-parked') return Number(contract.mission?.parkedAt) || now;
  if (code === 'suspended-expired') {
    const oldest = evaluation.expiredSuspended.reduce((max, item) => Math.max(max, Number(item.ageMs) || 0), 0);
    return oldest > 0 ? now - oldest : now;
  }
  return Number(contract.turn?.driftAt) || now;
}

/**
 * One contract file → the optional block the board renders (design §3.1).
 *
 * Each face is derived only when it has content (R3: 缺项隐藏), and a contract
 * with nothing to say yields `undefined` — so a stray empty file does not paint
 * a `●` badge. Nothing here writes or throws: a broken file has already been
 * turned into "absent" by `cachedContract`.
 */
function toContract(sessionID: string, now: number): SnapshotContract | undefined {
  const contract = cachedContract(sessionID);
  if (!contract) return undefined;

  const mission = contract.mission;
  const inScope = [...(mission.inScope ?? [])];
  const outOfScope = [...(mission.outOfScope ?? [])];
  const handoffTo = { ...(mission.handoffTo ?? {}) };
  const view: SnapshotContract = {};

  const oneLine = String(mission.oneLine ?? '').trim();
  if (oneLine || inScope.length || outOfScope.length || Object.keys(handoffTo).length) {
    view.mission = {
      oneLine,
      state: String(mission.state ?? 'active'),
      confirmed: Boolean(mission.confirmedBy),
      inScope,
      outOfScope,
      ...(Object.keys(handoffTo).length ? { handoffTo } : {})
    };
  }

  const milestones = contract.plan?.milestones ?? [];
  if (milestones.length) {
    const lit = milestones.filter(milestone => milestone.done).length;
    const next = milestones.find(milestone => !milestone.done);
    view.progress = {
      lit,
      total: milestones.length,
      ...(next ? { next: `${next.id}「${truncate(next.title, 60)}」` } : {})
    };
  }

  const todos = contract.todos ?? [];
  if (todos.length) {
    const open = todos.filter(todo => !TODO_DONE_STATUSES.includes(todo.status));
    const count = (status: string): number => open.filter(todo => todo.status === status).length;
    view.todos = {
      open: open.length,
      blocked: count('blocked'),
      suspended: count('suspended'),
      drifted: count('drifted')
    };
  }

  // The same pure evaluation the injection uses (`core/drift.ts`) — the board
  // never invents a second definition of "drifted".
  const evaluation = evaluate(contract, now);
  if (evaluation.drifted) {
    const primary = evaluation.reasons[0];
    // `unresolved` already reads 「上次漂移提醒未处置（… 前）」 — appending the
    // marker again would print 「未处置」 twice in the GUI row.
    const suffix = primary?.code !== 'unresolved' && driftUnresolved(contract) ? ' · 未处置' : '';
    view.drift = {
      drifted: true,
      ...(primary ? { reason: `${primary.text}${suffix}` } : {}),
      since: driftSince(contract, evaluation, now)
    };
  }

  return Object.keys(view).length ? view : undefined;
}

function toSession(
  info: SessionInfoLike,
  workspace: string | undefined,
  frozen?: SnapshotFreeze,
  contract?: SnapshotContract
): SnapshotSession | undefined {
  const sid = String(info?.id ?? '');
  if (!sid) return undefined;
  const state = sessionState(info);
  const archived = state === 'archived';
  const parent = info.parentID ?? info.parentId;
  return {
    sid,
    title: truncate(info.title ?? '(untitled)', 80),
    agent: String(info.agent ?? '?'),
    // An archived session is not running: `busy` is false even when the host
    // still carries the last clock values. The board files it under `已归档`.
    busy: state === 'busy',
    workspace: info?.location?.directory ?? workspace ?? '',
    ...(parent ? { parent: String(parent) } : {}),
    ...(archived ? { archived: true } : {}),
    ...(frozen ? { frozen } : {}),
    // 0.9.7: optional — a session without a contract file omits the key entirely.
    ...(contract ? { contract } : {})
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
  // 0.6.0 (board): the spawn relation, from the claim that took the hand-off.
  // `claim.kind` is the current shape; `expiredClaim` survives a spawn whose
  // lease lapsed before anybody accepted (the same fallback `archive.ts` uses),
  // so a `↳` line does not disappear when a human later took the bid over.
  const claim = asObject(record.claim);
  const expired = asObject(record.expiredClaim);
  const spawned = String(
    (claim.kind === 'spawn' ? claim.by : undefined) ?? (expired.kind === 'spawn' ? expired.by : undefined) ?? ''
  );
  const isSpawn = claim.kind === 'spawn' || expired.kind === 'spawn';
  const from = String(record.from?.sid ?? '');
  // 0.8.0 (`board2-graph`): the chain head of a forwarded hand-off. A record
  // written before 0.7.0 has none, and `origin === from` is a single hop (noise
  // the writer already omits) — both are simply absent, never an empty marker.
  const origin = String(asObject(record.origin).sid ?? '');
  return {
    bid,
    state,
    ageMs: Math.max(0, now - createdAt),
    from,
    ...(record.claim?.by ? { claimBy: String(record.claim.by) } : {}),
    ...(record.workspace ? { workspace: String(record.workspace) } : {}),
    title: truncate(record.title ?? record.slug ?? '(untitled)', 60),
    // 0.5.0: read-only marker for a hand-off whose spawned session was archived.
    ...(Number(record.archivedAt) > 0 ? { archived: true } : {}),
    // 0.6.0 (`collab_escalate`): read-only marker; the panel layout is unchanged.
    ...(asObject(record).priority === 'urgent' ? { priority: 'urgent' as const } : {}),
    // 0.6.0 (board): `↳` relation, optional so an older server stays valid.
    ...(isSpawn ? { kind: 'spawn' as const } : {}),
    ...(spawned ? { spawned } : {}),
    ...(origin && origin !== from ? { origin } : {}),
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
    .map(info => {
      const sid = String(info?.id ?? '');
      return toSession(info, workspace, frozenSessions.get(sid), sid ? toContract(sid, now) : undefined);
    })
    .filter((session): session is SnapshotSession => Boolean(session))
    .filter(session => (workspace ? !session.workspace || session.workspace === workspace : true))
    .sort(
      (left, right) =>
        left.workspace.localeCompare(right.workspace) ||
        Number(right.busy) - Number(left.busy) ||
        left.sid.localeCompare(right.sid)
    );

  const leases = (await source.locks())
    .map(record => toLock(record, now))
    .filter((lock): lock is SnapshotLock => Boolean(lock))
    .sort((left, right) => left.resource.localeCompare(right.resource));

  const handoffs = (await source.handoffs())
    .map(record => {
      const hit = freezes.length
        ? freezeFor(freezes, { bid: record.bid, workspace: record.workspace })
        : undefined;
      return toHandoff(record, now, hit ? toFreeze(hit) : undefined);
    })
    .filter((handoff): handoff is SnapshotHandoff => Boolean(handoff))
    .filter(handoff => (workspace ? handoff.workspace === workspace : true))
    .sort((left, right) => right.ageMs - left.ageMs || left.bid.localeCompare(right.bid));

  // 0.9.0 (R4): the projection verdict, display only. A throwing reader is
  // "unavailable", never a failed snapshot — the board keeps every JSON row.
  let index: SnapshotIndex | undefined;
  if (typeof source.index === 'function') {
    try {
      index = await source.index();
    } catch {
      index = { available: false, reason: 'index status unavailable' };
    }
  }

  // The queue is *the caller's own*: no session named → no scan of every
  // target's directory, and no row that belongs to somebody else.
  const from = readSession(input);
  const queue = from && typeof source.queue === 'function'
    ? (await source.queue(from))
        .map(item => toQueueItem(item, now))
        .filter((item): item is SnapshotQueueItem => Boolean(item))
        .sort((left, right) => right.ageMs - left.ageMs || left.queueId.localeCompare(right.queueId))
    : [];

  return { at: now, sessions, locks: leases, handoffs, queue, ...(index ? { index } : {}), reachable: true };
}

export function createSnapshotReader(source: SnapshotSource): SnapshotReader {
  return {
    snapshot(input?: unknown) {
      return buildSnapshot(source, input);
    }
  };
}
