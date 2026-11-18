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
}

/** The whole read-only picture. */
export interface Snapshot {
  at: number;
  sessions: SnapshotSession[];
  locks: SnapshotLock[];
  handoffs: SnapshotHandoff[];
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
 */
export const CollabState = {
  id: 'collab.state',
  methods: {
    snapshot: {
      input: obj({ workspace: str }),
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
                title: str
              },
              ['bid', 'state', 'ageMs', 'from', 'title']
            )
          }
        },
        ['at', 'reachable', 'sessions', 'locks', 'handoffs']
      )
    }
  },
  events: {}
} satisfies Rpc.PortableDefinition;
