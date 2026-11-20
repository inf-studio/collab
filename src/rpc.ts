/**
 * C2 (0.3.0): the contract between the server part and the desktop sidebar.
 *
 * `collab.state.snapshot` answers one question — "who holds what, who is
 * waiting, which hand-offs are still open?" — from the same read layer the
 * `collab_locks` / `collab_list` tools use (`stateOf` + `allBroadcasts`), so the
 * sidebar can never disagree with the tools. It is deliberately a *snapshot*:
 *
 *   - no event stream (a 2 s poll in the GUI is enough for a lease list, and an
 *     event bus would be a second state machine to keep correct);
 *   - `reachable: true` is part of the payload, so the GUI can tell a *rejected
 *     call* (server down) from an *empty* answer instead of showing a blank pane.
 *
 * 0.8.0 (`board2-actions`) adds the **write** half the board needs — and only
 * that half: `escalate` / `freeze` / `unfreeze` / `archive`, each answering one
 * `ActionReceipt`. They are not a second rule set: the handlers call
 * `core/actions.ts`, the same functions `collab_escalate` / `collab_freeze` /
 * `collab_archive` call, so the protected guard, the read-only-agent demotion
 * and the freeze precedence cannot drift between the tool and the panel. A
 * readable refusal is `ok:false` + `detail` (the panel toasts it); only a
 * transport failure rejects the call. Locking / releasing stays with the tools
 * (the panel has no such button) — the four actions are the ones a human
 * explicitly confirms in a dialog.
 *
 * The definition is a plain object `satisfies Rpc.PortableDefinition` instead of
 * `Rpc.define(...)`: `Rpc.define` is the identity function, and the runtime
 * import would drag `@opencode/schema` into a package that must stay
 * dependency-free on the server side. `import type` is erased, so `dist/index.js`
 * stays free of any `@opencode/*` runtime require.
 */
import type { Rpc } from '@opencode/plugin/rpc';

/** One optional freeze marker (0.6.0) — display only, read from the freeze file. */
export interface SnapshotFreeze {
  scope: 'session' | 'workspace' | 'bid';
  target?: string;
  /** Epoch ms; an expired freeze is never reported at all. */
  until: number;
  reason: string;
}

/**
 * 0.9.7 (`11-21-collab-board-contract`): the **session contract**, as the board
 * reads it (design §3.1). Display only — a read-only projection of
 * `collab-contract/<sid>.json`, derived server-side so the GUI / TUI bundles
 * never touch the filesystem.
 *
 * Every face is optional and **omitted when it has no content** (R3: 缺项隐藏);
 * a session without a contract file carries no `contract` key at all, so the
 * payload stays byte-for-byte what 0.9.6 sent (R5).
 */
export interface SnapshotContractMission {
  /** The mainline anchor (`''` when the mission was only scoped). */
  oneLine: string;
  /** `active` / `idle` / `suspended` / `done`. */
  state: string;
  /** A human confirmed it (`mission.confirmedBy`), never inferred. */
  confirmed: boolean;
  inScope: string[];
  outOfScope: string[];
  /** Boundary → owning session (the `collab_accept` gate's `handoffTo`). */
  handoffTo?: Record<string, string>;
}

/** `M<lit>/<total>` + the first unfinished milestone (`M3「…」`). */
export interface SnapshotContractProgress {
  lit: number;
  total: number;
  next?: string;
}

/**
 * The open work, by status. **`open` is the total**: every todo that is neither
 * `closed` nor `dropped` (the number `[todo] N open` and `collab_todo list`
 * print). `blocked` / `suspended` / `drifted` are a **breakdown of `open`**, not
 * extra rows — a consumer that wants "unfinished work" reads `open` and never
 * `open + blocked` (that double counts a blocked todo).
 */
export interface SnapshotContractTodos {
  open: number;
  blocked: number;
  suspended: number;
  drifted: number;
}

/** The evaluated drift (`core/drift.ts#evaluate`) — present only when triggered. */
export interface SnapshotContractDrift {
  drifted: boolean;
  /** The primary reason, one line (`连续 6 轮无主线动作（11.2h）· 未处置`). */
  reason?: string;
  /** The moment the drift is measured from (epoch ms; feeds `drift 11h`). */
  since?: number;
}

/** The one optional block a session row gained in 0.9.7. */
export interface SnapshotContract {
  mission?: SnapshotContractMission;
  progress?: SnapshotContractProgress;
  todos?: SnapshotContractTodos;
  drift?: SnapshotContractDrift;
}

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
  /**
   * 0.6.0 (`collab_freeze`): this session is frozen — itself, through an
   * ancestor, or because its workspace is. Optional: an older server omits it.
   */
  frozen?: SnapshotFreeze;
  /**
   * 0.6.0 (board): the host says this session is archived (`time.archived`).
   * The snapshot now **keeps** archived sessions (it used to drop them) so the
   * board can file them under `已归档 N` instead of losing the row entirely.
   * Optional: an older server omits it and the reader treats absence as false.
   */
  archived?: boolean;
  /**
   * 0.9.7 (`11-21-collab-board-contract`): the session's contract, read-only
   * from `collab-contract/<sid>.json`. **Optional and absent when there is no
   * usable contract file** — an older server never sends it, and a session that
   * never used a contract tool must render exactly like 0.9.6.
   */
  contract?: SnapshotContract;
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
  /**
   * 0.6.0 (`collab_freeze`): this hand-off (its bid) or its workspace is frozen.
   * Display only — the row stays, one marker is added.
   */
  freeze?: SnapshotFreeze;
  /**
   * 0.6.0 (board): how the hand-off was taken. `spawn` is the relation the board
   * draws as `↳` (this record pulled a new session in). Optional: an older
   * server omits it, and absence is simply "not a spawn".
   */
  kind?: 'handoff' | 'spawn';
  /**
   * 0.6.0 (board): the session this hand-off spawned (`claim.by` of a
   * `claim.kind === 'spawn'` record; the expired-claim fallback is included).
   * Optional, display only.
   */
  spawned?: string;
  /**
   * 0.8.0 (`board2-graph`): the chain head of a **forwarded** hand-off
   * (`record.origin.sid`, 0.7.0). Absent on a single hop — `toHandoff` omits it
   * when it equals `from` — and on every record written before 0.7.0. Display
   * only: the graph draws it as the dashed `origin` edge.
   */
  origin?: string;
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

/**
 * 0.9.0 (`11-20-collab-store`, R4): the storage verdict the board renders as
 * `[索引不可用]` when the projection cannot be read. Optional so an older
 * server's snapshot stays valid (absence = no marker).
 */
export interface SnapshotIndex {
  available: boolean;
  /** Why the projection is unavailable (shown next to the marker). */
  reason?: string;
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
  /**
   * 0.8.0 (`board2-actions`): whether the detail pane renders its action row
   * (`collab.json` → `boardActions`, default `true`). Optional: an older server
   * omits it, and absence means "actions available" (the default) — but the RPC
   * methods themselves are registered either way, so `false` only hides the row.
   */
  actions?: boolean;
  /**
   * 0.9.0 (R4): whether `collab.db` can be read. `available:false` is a
   * display-only marker — every number above still comes from the JSON files,
   * so a degraded index never hides a lease or a hand-off.
   */
  index?: SnapshotIndex;
  /** The server answered. A rejected call never produces a snapshot at all. */
  reachable: true;
}

/**
 * 0.8.0 (`board2-actions`): the receipt of one **write** action
 * (`escalate` / `freeze` / `unfreeze` / `archive`).
 *
 * `ok:false` is a readable refusal (protected target, frozen object, a host that
 * refused the write, a validation error) — it is not a transport failure, and it
 * always carries the reason in `detail`. A rejected RPC call (server down) never
 * produces a receipt at all, so the panel can tell the two apart.
 */
export interface ActionReceipt {
  ok: boolean;
  action: string;
  /** The resolved target: a session id, a hand-off id, or a workspace path. */
  target: string;
  /** One line: the verdict, or the refusal reason (shown in the toast). */
  detail: string;
}

const str = { type: 'string' } as const;
const num = { type: 'number' } as const;
const bool = { type: 'boolean' } as const;
const strArray = { type: 'array', items: str } as const;
/** `until` accepts a relative window (`"30m"`) or an absolute epoch ms. */
const until = { anyOf: [{ type: 'number' }, { type: 'string' }] } as const;
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required
});
/** Every write action answers with the same receipt (see `ActionReceipt`). */
const actionOutput = obj({ ok: bool, action: str, target: str, detail: str }, ['ok', 'action', 'target', 'detail']);

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
              { sid: str, title: str, agent: str, busy: bool, workspace: str, parent: str,
                // 0.6.0 (`collab_freeze`): optional marker — an older server omits it.
                frozen: obj({ scope: str, target: str, until: num, reason: str }, ['until', 'reason']),
                // 0.6.0 (board): optional archived flag (absence = false).
                archived: bool,
                // 0.9.7 (`11-21-collab-board-contract`): the contract block. Every
                // face is optional and omitted when empty (an older server sends
                // none of it, and a session without a contract file gets no key).
                contract: obj({
                  mission: obj(
                    {
                      oneLine: str,
                      state: str,
                      confirmed: bool,
                      inScope: strArray,
                      outOfScope: strArray,
                      handoffTo: { type: 'object', additionalProperties: str }
                    },
                    ['oneLine', 'state', 'confirmed', 'inScope', 'outOfScope']
                  ),
                  progress: obj({ lit: num, total: num, next: str }, ['lit', 'total']),
                  todos: obj({ open: num, blocked: num, suspended: num, drifted: num }, [
                    'open',
                    'blocked',
                    'suspended',
                    'drifted'
                  ]),
                  drift: obj({ drifted: bool, reason: str, since: num }, ['drifted'])
                })
              },
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
                archived: bool,
                // 0.6.0 (`collab_freeze`): optional freeze marker (bid or workspace).
                freeze: obj({ scope: str, target: str, until: num, reason: str }, ['until', 'reason']),
                // 0.6.0 (board): optional spawn relation — an older server omits both.
                kind: str,
                spawned: str,
                // 0.8.0 (`board2-graph`): optional chain head of a forwarded record.
                origin: str
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
          },
          // 0.9.0 (R4): optional — an older server omits it (no marker).
          index: obj({ available: bool, reason: str }, ['available'])
        },
        ['at', 'reachable', 'sessions', 'locks', 'handoffs', 'queue']
      )
    },
    /*
     * 0.8.0 (`board2-actions`): the four write actions of the board. Each one
     * runs the **same** core function the native tool runs (`core/actions.ts`),
     * so the gates (protected lineage, read-only agent → queue, freeze first,
     * `[protected*]` archive refusal) are not re-implemented here. `session` is
     * the calling session (the routed one), used as the audit `actor`; the
     * confirmation is the GUI's dialog, so the server side always executes.
     */
    escalate: {
      input: obj({ target: str, reason: str, mode: str, session: str }),
      output: actionOutput
    },
    freeze: {
      input: obj({ target: str, scope: str, until, reason: str, session: str }),
      output: actionOutput
    },
    unfreeze: {
      input: obj({ target: str, scope: str, session: str }),
      output: actionOutput
    },
    archive: {
      input: obj({ target: str, restore: bool, session: str }),
      output: actionOutput
    }
  },
  events: {}
} satisfies Rpc.PortableDefinition;
