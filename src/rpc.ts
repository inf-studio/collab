/**
 * C2 (0.3.0): the **read-only** contract between the server part and the
 * desktop sidebar.
 *
 * `collab.state.snapshot` answers one question — "who holds what, who is
 * waiting, which hand-offs are still open?" — from the same read layer the
 * `collab_locks` / `collab_list` tools use (`stateOf` + `allBroadcasts`), so the
 * sidebar can never disagree with the tools. It is deliberately a *snapshot*:
 *
 *   - no event stream (a 2 s poll in the GUI is enough for a lease list, and an
 *     event bus would be a second state machine to keep correct);
 *   - no method that writes (the panel has no lock/release button — R5);
 *   - `reachable: true` is part of the payload, so the GUI can tell a *rejected
 *     call* (server down) from an *empty* answer instead of showing a blank pane.
 *
 * The definition is a plain object `satisfies Rpc.PortableDefinition` instead of
 * `Rpc.define(...)`: `Rpc.define` is the identity function, and the runtime
 * import would drag `@opencode/schema` into a package that must stay
 * dependency-free on the server side. `import type` is erased, so `dist/index.js`
 * stays free of any `@opencode/*` runtime require.
 */
import type { Rpc } from '@opencode/plugin/rpc';

/** One session the host lists, as the panel groups it. */
export interface SnapshotSession {
  /** OpenCode session id (`ses_…`) — the same id the tool context reports. */
  sid: string;
  title: string;
  agent: string;
  busy: boolean;
  /** Absolute workspace directory; `''` when the host reports none. */
  workspace: string;
  /** Parent session id, for a sub-agent line. */
  parent?: string;
}

/** One resource lease, from `stateOf()` — never a second source of truth. */
export interface SnapshotLock {
  resource: string;
  /** `named` / `file` / `build` (display grouping only). */
  kind: string;
  mode: 'exclusive' | 'shared';
  holders: string[];
  /** Queue length (the `waiters` the design asks for). */
  waiters: number;
  /**
   * Queued session ids in FIFO order. The count alone cannot tell a composer
   * pill whether *this* session is queued, so the reader reports both.
   */
  waiting: string[];
  /** Remaining TTL in ms; `0` when the resource is free. */
  expiresInMs: number;
  /**
   * 0.6.0 (R3): `now − waiter.at` per queued session, same order as `waiting` —
   * "is this queue alive or is it a heartbeat-less leftover?". Optional: an
   * older server answers without it and every consumer must tolerate that.
   */
  waiterAgeMs?: number[];
  /** 0.6.0 (R3): the queued sids whose heartbeat is older than the waiter TTL. */
  staleWaiters?: string[];
  /** 0.6.0 (R3): shorthand for `staleWaiters.length > 0`. */
  stale?: boolean;
  reason?: string;
}

/** One hand-off that has not reached a decided state. */
export interface SnapshotHandoff {
  bid: string;
  state: string;
  /** Now − `createdAt`, clamped at 0. */
  ageMs: number;
  from: string;
  claimBy?: string;
  workspace?: string;
  title: string;
  /**
   * 0.5.0: the spawned session of this hand-off was archived (read-only display;
   * the panel keeps the row, only the marker is added).
   */
  archived?: boolean;
  /**
   * 0.6.0 (`collab_escalate`): the hand-off was escalated as urgent. Display
   * only — the panel keeps its layout and adds one marker.
   */
  priority?: 'urgent';
}

/**
 * One owner-queue item that the **asking** session submitted to a protected
 * target (`mineFor(session)` — the same list `collab_list` prints). 0.4.2:
 * without it the TUI panel could show leases and hand-offs but not the queue it
 * is also expected to show, and would have to read `~/.config` from the client.
 *
 * `queueId` / `target` / `ageMs` are the panel's three columns; `summary` is
 * the sender's own sanitised text (`collab_list` shows it too).
 */
export interface SnapshotQueueItem {
  queueId: string;
  target: string;
  /** Now − `at`, clamped at 0 (oldest first, like the hand-offs). */
  ageMs: number;
  summary: string;
  issuePath?: string;
  bid?: string;
  /** The target's `context` hook already showed it (`seenAt`). */
  seen: boolean;
  /** 0.6.0 (`collab_escalate`): an urgent item (display marker only). */
  priority?: 'urgent';
}

/** The whole read-only picture. */
export interface Snapshot {
  at: number;
  sessions: SnapshotSession[];
  locks: SnapshotLock[];
  handoffs: SnapshotHandoff[];
  /**
   * Items this session queued for protected targets. Empty when the caller did
   * not name a session (no "me" to filter by) — never a scan of every queue.
   */
  queue: SnapshotQueueItem[];
  /** The server answered. A rejected call never produces a snapshot at all. */
  reachable: true;
}

const str = { type: 'string' } as const;
const num = { type: 'number' } as const;
const bool = { type: 'boolean' } as const;
const strArray = { type: 'array', items: str } as const;
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required
});

/**
 * `collab.state` — one method, no events. The id is under the plugin id
 * (`collab`), which is the namespace the host reserves for this plugin.
 *
 * Input is `{ workspace?, session? }`: `workspace` narrows sessions/ hand-offs
 * to one directory, `session` selects whose owner-queue items `queue` holds
 * (the TUI panel passes the session the panel is open in; omitted = empty).
 */
export const CollabState = {
  id: 'collab.state',
  methods: {
    snapshot: {
      input: obj({ workspace: str, session: str }),
      output: obj(
        {
          at: num,
          reachable: bool,
          sessions: {
            type: 'array',
            items: obj(
              { sid: str, title: str, agent: str, busy: bool, workspace: str, parent: str },
              ['sid', 'title', 'agent', 'busy', 'workspace']
            )
          },
          locks: {
            type: 'array',
            items: obj(
              {
                resource: str,
                kind: str,
                mode: str,
                holders: strArray,
                waiters: num,
                waiting: strArray,
                expiresInMs: num,
                // 0.6.0 (R3): optional, so an older server's answer stays valid.
                waiterAgeMs: { type: 'array', items: num },
                staleWaiters: strArray,
                stale: bool,
                reason: str
              },
              ['resource', 'kind', 'mode', 'holders', 'waiters', 'waiting', 'expiresInMs']
            )
          },
          handoffs: {
            type: 'array',
            items: obj(
              {
                bid: str,
                state: str,
                ageMs: num,
                from: str,
                claimBy: str,
                workspace: str,
                title: str,
                archived: bool
              },
              ['bid', 'state', 'ageMs', 'from', 'title']
            )
          },
          queue: {
            type: 'array',
            items: obj(
              {
                queueId: str,
                target: str,
                ageMs: num,
                summary: str,
                issuePath: str,
                bid: str,
                seen: bool
              },
              ['queueId', 'target', 'ageMs', 'summary', 'seen']
            )
          }
        },
        ['at', 'reachable', 'sessions', 'locks', 'handoffs', 'queue']
      )
    }
  },
  events: {}
} satisfies Rpc.PortableDefinition;
