/**
 * C2 (0.3.0): the desktop sidebar — `./gui-experimental`.
 *
 * A view of the same state the tools expose: who holds a resource, who is
 * queued behind it, which hand-off is still open. It keeps no collaboration
 * state of its own; every number comes from `collab.state.snapshot` (the RPC in
 * `src/rpc.ts`, implemented in `src/index.ts`), which reads what `collab_locks`
 * and `collab_list` read.
 *
 * Deliberate choices:
 *   - **No `main`**: only `setup` (the window half). Nothing here needs Electron
 *     or Node, so the bundle stays free of both and of their placeholders.
 *   - **No lock/release button**: leasing stays with the tools and the skills; a
 *     mis-click in a status pane must never change who may take a resource. The
 *     one write half is the 0.8.0 **action row** (加急 / 冻结 / 解冻 / 归档):
 *     four buttons that each ask in a dialog first and call `collab.state.*`,
 *     which runs the same core functions as the native tools — the panel decides
 *     no gate itself (`ActionRow`).
 *   - **Poll, do not subscribe**: one 2 s poll while a session is mounted. The
 *     pill and the panel are fed by the same store, so the composer pill is
 *     never a second RPC stream, and a rejected call (server down) shows
 *     "server 不可达" instead of a blank pane (R4).
 *   - **Failure is local**: a throw inside a contribution fails only that
 *     contribution; the server plugin (tools, context hook) is untouched (R6).
 *   - **A probe, not a guess** (0.5.2): a titlebar pill labelled `collab` is
 *     always there, and clicking it with no routed session shows a toast naming
 *     the plugin, version, panel key and app/platform. That is the one piece of
 *     evidence a window can give that the GUI actually loaded — see README
 *     "Desktop 排查".
 *   - **Read the session's server, not the window's** (0.5.3): the GUI host only
 *     tracks the app's own sidecar, so a plugin installed *on a remote server*
 *     never gets its window half loaded (see docs/collab.md §11.11.x). The
 *     supported setup is "install on this computer": the window loads the GUI,
 *     and every request goes to the client of the **server the routed session
 *     belongs to** (`ctx.sessions.current()?.server?.client`), falling back to
 *     `ctx.client` when a session carries no server. Remote rows therefore come
 *     from the remote server, local rows from the local one — one source at a
 *     time, never mixed.
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { createStore } from 'solid-js/store';
import {
  Command,
  ComposerPill,
  MenuItem,
  Panel,
  Plugin,
  Slot,
  Style,
  TitlebarItem,
  createKeyed,
  usePlugin,
  type ComposerPillView,
  type Context,
  type MountedSession,
  type PanelTab
} from '@opencode/plugin/gui';
import { CollabState } from './rpc.ts';
import type { ActionReceipt, Snapshot, SnapshotHandoff, SnapshotLock, SnapshotQueueItem } from './rpc.ts';
import { buildBoard, boardOrphans, type BoardOrphans, type BoardSession, type BoardWorkspace } from './core/board.ts';
import { buildGraph, GRAPH_NODE_LIMIT, type GraphEdge, type GraphLevel, type GraphNode } from './core/graph.ts';
import {
  GRAPH_BADGE_W,
  GRAPH_BOX_H,
  GRAPH_BOX_MIN_W,
  GRAPH_VIEW,
  clampPan,
  layoutGraph,
  viewBoxAttr,
  viewBoxOf,
  zoomBy,
  type GraphPoint,
  type GraphRect
} from './core/graph-layout.ts';
import { countsOf, pendingCountOf } from './core/counts.ts';

/** Two seconds: a lease list changes on human timescales, and this is cheap. */
const POLL_MS = 2000;
const PANEL_TAB = 'main';

/**
 * 0.5.3: the same version as `PLUGIN_VERSION` in `src/constants.ts` (and
 * `package.json`), restated rather than imported — `constants.ts` reads
 * `node:os` / `node:path` when it loads, and this bundle runs inside a window,
 * where neither exists. It appears in exactly one place (the probe toast's
 * description); `test/gui-entry.mjs` asserts all three agree.
 */
const PLUGIN_VERSION = '0.9.1';

/** What the probe calls the app's own server: there is no `ServerRef.id` to show. */
const LOCAL_SERVER = 'this computer';

/* ------------------------------------------------------------------ formatting */

function fmtTtl(ms: number): string {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function fmtClock(ms: number): string {
  if (!ms) return '--:--:--';
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** `ses_2f7b…d0e` — long enough to match a `collab_list` line, short enough for a row. */
function shortSid(sid: string): string {
  const value = String(sid ?? '');
  return value.startsWith('ses_') && value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value || '-';
}

/** The last path segment of a workspace, without `node:path` (this runs in a window). */
function workspaceLabel(directory: string): string {
  const parts = String(directory ?? '')
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : '';
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return text.length > 160 ? `${text.slice(0, 159)}…` : text || 'unknown error';
}

/** `document.hidden` without the DOM lib: the window half runs in a browser context. */
function pageHidden(): boolean {
  const doc = (globalThis as { document?: { hidden?: boolean } }).document;
  return doc?.hidden === true;
}

/** The slice of `MediaQueryList` this panel reads (a test host simply has none). */
interface MediaQuery {
  matches: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
}

/**
 * R1 (0.8.0): the one breakpoint of the split layout. Guards like `pageHidden`:
 * a test host (or an older window) has no `matchMedia`, and then the panel is
 * simply the wide, two-column form.
 */
function narrowQuery(): MediaQuery | undefined {
  const win = globalThis as { matchMedia?: (query: string) => MediaQuery };
  if (typeof win.matchMedia !== 'function') return undefined;
  try {
    return win.matchMedia('(max-width: 640px)');
  } catch {
    return undefined;
  }
}

/* --------------------------------------------------------------------- snapshot */

interface SnapshotState {
  at: number;
  data?: Snapshot;
  error?: string;
  loading: boolean;
  /**
   * 0.5.3 (R3): which server/session the numbers in `data` belong to. The panel
   * names it (when it is not this computer); it is also the record that the
   * rows on screen were not carried over from another server.
   */
  source?: { server?: string; session?: string };
}

interface SnapshotStore {
  readonly state: SnapshotState;
  load(): Promise<void>;
  dispose(): void;
}

/**
 * 0.5.3 (R1): where a snapshot must come from — **the routed session's server**.
 *
 * `ctx.client` is the client of the server that runs this plugin, i.e. the
 * desktop app's own sidecar. A session routed from another server (an http
 * connection, or a server another plugin contributes) has its own already
 * authenticated `ServerRef.client`; the window is on that server's tab, so the
 * credentials are the app's, not ours. Without a `server` (a window that predates
 * the field, a test host) the fallback keeps the old behaviour.
 *
 * `key` names the source, so a reply can be matched to the request that asked for
 * it: `${server id}\n${session id}`, `local\n<session>` when a session carries no
 * server, and `local\n` with no routed session.
 */
function sourceFor(ctx: Context): { key: string; client: Context['client']; server?: string; session?: string } {
  const session = ctx.sessions.current();
  const server = session?.server;
  return {
    key: `${server?.id ?? 'local'}\n${session?.id ?? ''}`,
    // Read `server.client` / `ctx.client` here, not when the store is built: a
    // restarted or re-authenticated server gets a new controller under the same
    // id, and the app replays that into the ref.
    client: server?.client ?? ctx.client,
    server: server?.id,
    session: session?.id
  };
}

/**
 * The store is created once per window, in `setup`, and shared by the panel, the
 * pill and the header counts: one RPC per tick, not one per contribution.
 */
function createSnapshotStore(ctx: Context): SnapshotStore {
  const [state, setState] = createStore<SnapshotState>({ at: 0, loading: true });
  let inFlight = false;
  let disposed = false;
  /** The source the rows on screen belong to; '' before the first request. */
  let shown = '';

  /**
   * 0.5.3 (R2): switching server or session means the rows on screen belong to a
   * source that is no longer routed. Drop them **before** the new request, so a
   * slow answer from the previous server is never rendered as if it were the new
   * one's. Runs even while a request is in flight (the poll re-run may be
   * queued), which is why it is separate from `load`'s single-flight guard.
   */
  const adopt = (source: { key: string; server?: string; session?: string }): void => {
    if (source.key === shown) return;
    shown = source.key;
    setState({
      at: 0,
      data: undefined,
      error: undefined,
      loading: true,
      source: { server: source.server, session: source.session }
    });
  };

  const load = async (): Promise<void> => {
    if (disposed) return;
    // Resolve the source on every call: the routed session (and with it the
    // server) changes while this window stays open.
    const source = sourceFor(ctx);
    adopt(source);
    if (inFlight) return;
    inFlight = true;
    try {
      // 0.5.1: name the routed session. `queue` is the *requester's* owner-queue
      // ("what did I ask of a protected session?"), and the server returns an
      // empty list without a `session` — i.e. it would look like "0" forever.
      // It narrows only `queue`; sessions / leases / hand-offs are unchanged,
      // and it is the same single call, not a second stream.
      const reply = await source.client.rpc(CollabState).snapshot(source.session ? { session: source.session } : {});
      if (disposed) return;
      // 0.5.3 (R2): a reply that lands after the window switched servers or
      // sessions answers a source that is no longer routed. Drop it; the
      // `finally` below re-runs for the source that is routed now.
      if (sourceFor(ctx).key !== source.key) return;
      const next = reply as Snapshot | undefined;
      if (!next || typeof next !== 'object') throw new Error('empty snapshot');
      setState({
        at: Number(next.at) || Date.now(),
        data: next,
        error: undefined,
        loading: false,
        source: { server: source.server, session: source.session }
      });
    } catch (error) {
      if (disposed) return;
      if (sourceFor(ctx).key !== source.key) return;
      // Keep the last snapshot: a blip shows the stale rows *and* the banner,
      // which is more honest than replacing data with an error screen.
      setState({ error: describe(error), loading: false, source: { server: source.server, session: source.session } });
    } finally {
      inFlight = false;
      // One re-run, not a loop: the next `load` records its own source, so a
      // second change queues a second run and an unchanged one queues none.
      // A hidden window queues nothing (the poller is not running while the
      // window is hidden) and a disposed store is silent.
      if (!disposed && !pageHidden() && sourceFor(ctx).key !== source.key) void load();
    }
  };

  return {
    state,
    load,
    dispose() {
      disposed = true;
    }
  };
}

let sharedStore: SnapshotStore | undefined;

function storeFor(ctx: Context): SnapshotStore {
  // `setup` always assigns `sharedStore` before a contribution can render; the
  // fallback only exists for the type checker.
  sharedStore ??= createSnapshotStore(ctx);
  return sharedStore;
}

/* ---------------------------------------------------------------------- grouping */

/*
 * The workspace/session tree is no longer assembled here: `core/board.ts` does
 * it once and the TUI renders the same object (R1). The panel only owns three
 * pieces of **local** UI state — the archived folds, the selected `sid` and the
 * narrow-window flag — so a 2 s poll that replaces `data` can never fold a row,
 * drop the selection or flip the layout.
 */

/* --------------------------------------------------------------------------- css */

const CSS = `
.collab-panel{display:flex;flex-direction:column;gap:14px;height:100%;overflow:auto;padding:10px 12px;font-size:12px;line-height:1.45;color:inherit;}
.collab-group{display:flex;flex-direction:column;gap:4px;}
.collab-group + .collab-group{border-top:1px solid color-mix(in srgb, currentColor 12%, transparent);padding-top:10px;}
.collab-orphans{opacity:.9;}
.collab-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-weight:600;}
.collab-head-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.collab-sub{font-size:11px;font-weight:600;opacity:.55;margin-top:6px;}
.collab-row{display:flex;align-items:baseline;gap:6px;min-width:0;}
.collab-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.collab-mono{font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;}
.collab-muted{opacity:.6;}
.collab-badge{flex:none;border-radius:999px;padding:0 6px;font-size:10px;line-height:16px;background:color-mix(in srgb, currentColor 10%, transparent);}
.collab-session{appearance:none;border:0;background:transparent;color:inherit;font:inherit;text-align:left;padding:0;margin:0;width:100%;cursor:pointer;border-radius:4px;}
.collab-session:hover{background:color-mix(in srgb, currentColor 6%, transparent);}
.collab-session:focus-visible{outline:1px solid currentColor;outline-offset:1px;}
.collab-caret{flex:none;width:10px;opacity:.7;}
.collab-session-selected{background:color-mix(in srgb, currentColor 10%, transparent);}
.collab-split{display:grid;grid-template-columns:320px minmax(0,1fr);gap:12px;align-items:start;min-height:0;}
.collab-split-narrow{grid-template-columns:minmax(0,1fr);}
.collab-sidebar{display:flex;flex-direction:column;gap:10px;min-width:0;max-height:100%;overflow:auto;}
.collab-detail-pane{display:flex;flex-direction:column;gap:8px;min-width:0;padding-left:12px;border-left:1px solid color-mix(in srgb, currentColor 12%, transparent);}
.collab-detail-header{display:flex;flex-direction:column;gap:3px;min-width:0;}
.collab-detail-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.collab-detail-meta{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px;min-width:0;}
.collab-detail-section{display:flex;flex-direction:column;gap:2px;min-width:0;}
.collab-graph-slot,.collab-actions-slot{flex:none;min-height:0;}
.collab-items{display:flex;flex-direction:column;gap:2px;min-width:0;}
.collab-back{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-size:11px;text-align:left;padding:2px 0;margin:0 0 2px;cursor:pointer;opacity:.7;border-radius:4px;}
.collab-back:hover{opacity:1;background:color-mix(in srgb, currentColor 6%, transparent);}
.collab-back:focus-visible{outline:1px solid currentColor;outline-offset:1px;}
@media (max-width: 640px){.collab-split{grid-template-columns:minmax(0,1fr);}.collab-detail-pane{padding-left:0;border-left:0;}}
.collab-spawn{opacity:.85;}
.collab-spawn-mark{flex:none;opacity:.55;}
.collab-archived{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-size:11px;text-align:left;padding:2px 0;margin:4px 0 0;cursor:pointer;opacity:.6;border-radius:4px;}
.collab-archived:hover{opacity:.9;background:color-mix(in srgb, currentColor 6%, transparent);}
.collab-archived:focus-visible{outline:1px solid currentColor;outline-offset:1px;}
.collab-dot{flex:none;width:6px;height:6px;border-radius:999px;background:currentColor;opacity:.35;}
.collab-dot-busy{opacity:1;background:#2ea043;}
.collab-tone-success{color:#2ea043;}
.collab-tone-warning{color:#d29922;}
.collab-tone-danger{color:#f85149;}
.collab-error{display:flex;flex-direction:column;gap:2px;border-radius:6px;padding:6px 8px;color:#f85149;background:color-mix(in srgb, #f85149 10%, transparent);}
.collab-error-title{font-weight:600;}
.collab-empty{opacity:.6;padding:2px 0;}
.collab-source{flex:none;align-self:flex-start;border-radius:4px;padding:0 6px;background:color-mix(in srgb, currentColor 8%, transparent);opacity:.75;}
.collab-footer{font-size:11px;opacity:.5;border-top:1px solid color-mix(in srgb, currentColor 12%, transparent);padding-top:8px;}
.collab-counts{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;padding:0 4px;margin:0;border-radius:4px;opacity:.6;white-space:nowrap;cursor:pointer;}
.collab-counts:hover{opacity:.9;background:color-mix(in srgb, currentColor 10%, transparent);}
.collab-counts:focus-visible{outline:1px solid currentColor;outline-offset:1px;opacity:.9;}
.collab-graph{display:flex;flex-direction:column;gap:2px;min-width:0;}
.collab-graph-svg{display:block;width:100%;max-width:560px;height:auto;overflow:hidden;color:inherit;cursor:grab;touch-action:none;}
.collab-graph-dragging{cursor:grabbing;}
.collab-graph-edge{stroke:currentColor;stroke-width:1;fill:none;opacity:.45;}
.collab-graph-edge-active{opacity:1;stroke-width:2;}
.collab-graph-node{cursor:pointer;}
.collab-graph-node .collab-graph-box{fill:color-mix(in srgb, currentColor 8%, transparent);stroke:currentColor;stroke-width:1;opacity:.75;}
.collab-graph-node:hover .collab-graph-box{opacity:1;}
.collab-graph-node-selected .collab-graph-box{fill:color-mix(in srgb, currentColor 18%, transparent);stroke-width:2;opacity:1;}
.collab-graph-node-archived .collab-graph-box{stroke-dasharray:2 2;opacity:.45;}
.collab-graph-node-frozen .collab-graph-box{stroke:#f85149;}
.collab-graph-node-urgent .collab-graph-box{stroke:#d29922;}
.collab-graph-node-workspace .collab-graph-box{fill:transparent;stroke-dasharray:4 3;}
.collab-graph-label{fill:currentColor;font-size:9px;font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);}
.collab-graph-toggle{cursor:pointer;opacity:.7;}
.collab-graph-toggle:hover{opacity:1;}
.collab-graph-toggle .collab-graph-toggle-box{fill:color-mix(in srgb, currentColor 12%, transparent);}
.collab-graph-toggle .collab-graph-toggle-label{fill:currentColor;font-size:8px;}
.collab-graph-more{font-size:10px;opacity:.6;}
.collab-graph-legend{font-size:10px;opacity:.5;}
.collab-ws{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-weight:600;text-align:left;padding:0 2px;margin:0;min-width:0;cursor:pointer;border-radius:4px;}
.collab-ws:hover{background:color-mix(in srgb, currentColor 6%, transparent);}
.collab-ws:focus-visible{outline:1px solid currentColor;outline-offset:1px;}
.collab-ws-selected{background:color-mix(in srgb, currentColor 10%, transparent);}
.collab-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0;}
.collab-action{appearance:none;border:1px solid color-mix(in srgb, currentColor 22%, transparent);background:transparent;color:inherit;font:inherit;font-size:11px;line-height:16px;padding:1px 8px;border-radius:999px;cursor:pointer;}
.collab-action:hover{background:color-mix(in srgb, currentColor 8%, transparent);}
.collab-action:focus-visible{outline:1px solid currentColor;outline-offset:1px;}
.collab-action:disabled{opacity:.5;cursor:default;}
.collab-action-armed{border-color:#d29922;color:#d29922;background:color-mix(in srgb, #d29922 12%, transparent);}
.collab-action-danger{border-color:color-mix(in srgb, #f85149 45%, transparent);}
.collab-action-danger:hover{background:color-mix(in srgb, #f85149 12%, transparent);}
`;

/* ----------------------------------------------------------------------- rows */

function SessionBadges(props: { session: BoardSession }) {
  const ctx = usePlugin();
  const frozenTitle = () =>
    `冻结至 ${new Date(props.session.frozen!.until).toLocaleTimeString()}（${props.session.frozen!.reason}）`;
  return (
    <>
      <Show when={props.session.badges.held > 0}>
        <span class="collab-badge collab-tone-success" title={ctx.t('panel.badgeHeld')}>
          🔒{props.session.badges.held}
        </span>
      </Show>
      <Show when={props.session.badges.waiting > 0}>
        <span class="collab-badge collab-tone-warning" title={ctx.t('panel.badgeWaiting')}>
          ⏳{props.session.badges.waiting}
        </span>
      </Show>
      <Show when={props.session.badges.handoffs > 0}>
        <span class="collab-badge" title={ctx.t('panel.badgeHandoffs')}>
          ‹{props.session.badges.handoffs}›
        </span>
      </Show>
      <Show when={props.session.badges.queue > 0}>
        <span class="collab-badge" title={ctx.t('panel.badgeQueue')}>
          ⇢{props.session.badges.queue}
        </span>
      </Show>
      <Show when={props.session.archived}>
        <span class="collab-badge collab-muted">[archived]</span>
      </Show>
      <Show when={props.session.frozen}>
        <span class="collab-badge collab-tone-danger" title={frozenTitle()}>
          [frozen]
        </span>
      </Show>
      <Show when={props.session.urgent}>
        <span class="collab-badge collab-tone-warning">[urgent]</span>
      </Show>
    </>
  );
}

function SpawnRow(props: { child: BoardSession['spawned'][number] }) {
  return (
    <div class="collab-row collab-spawn" title={props.child.sid}>
      <span class="collab-spawn-mark">↳</span>
      <span class="collab-mono collab-muted">{shortSid(props.child.sid)}</span>
      <span class="collab-badge">{props.child.state}</span>
      <Show when={props.child.archived}>
        <span class="collab-badge collab-muted">[archived]</span>
      </Show>
      <Show when={props.child.title}>
        <span class="collab-row-title collab-muted">{props.child.title}</span>
      </Show>
    </div>
  );
}

function QueueRow(props: { item: SnapshotQueueItem }) {
  const ctx = usePlugin();
  return (
    <div class="collab-row" title={props.item.queueId}>
      <span class="collab-mono">{props.item.queueId}</span>
      <span class="collab-mono collab-muted">{shortSid(props.item.target)}</span>
      <span class="collab-badge">{props.item.seen ? ctx.t('panel.seen') : ctx.t('panel.pending')}</span>
      <Show when={props.item.priority === 'urgent'}>
        <span class="collab-badge collab-tone-warning">[urgent]</span>
      </Show>
      <span class="collab-muted">{fmtTtl(props.item.ageMs)}</span>
      <span class="collab-row-title collab-muted">{props.item.summary}</span>
    </div>
  );
}

function LockRow(props: { lock: SnapshotLock; current: string }) {
  const ctx = usePlugin();
  const mine = () => props.lock.holders.includes(props.current) || props.lock.waiting.includes(props.current);
  // Tone answers "can I take it?": mine or a joinable `shared` group is fine,
  // an exclusive lease in someone else's hands is the one that blocks.
  const tone = () => {
    if (!props.lock.holders.length) return 'collab-muted';
    if (props.lock.holders.includes(props.current)) return 'collab-tone-success';
    return props.lock.mode === 'shared' ? 'collab-tone-success' : 'collab-tone-danger';
  };
  return (
    <div class="collab-row" title={props.lock.reason ?? props.lock.resource}>
      <span class={`collab-mono ${tone()}`}>{props.lock.resource}</span>
      <span class="collab-muted">{props.lock.mode}</span>
      <Show
        when={props.lock.holders.length}
        fallback={<span class="collab-muted">{ctx.t('panel.free')}</span>}
      >
        <span class="collab-mono">{props.lock.holders.map(shortSid).join(', ')}</span>
        <span class="collab-muted">{ctx.t('panel.remaining', { ttl: fmtTtl(props.lock.expiresInMs) })}</span>
      </Show>
      <Show when={props.lock.waiters > 0}>
        <span class="collab-badge collab-tone-warning">{ctx.plural('panel.waiting', props.lock.waiters)}</span>
      </Show>
      <Show when={mine()}>
        <span class="collab-badge">{ctx.t('panel.mine')}</span>
      </Show>
    </div>
  );
}

function HandoffRow(props: { handoff: SnapshotHandoff }) {
  const ctx = usePlugin();
  return (
    <div class="collab-row" title={props.handoff.bid}>
      <span class="collab-mono">{props.handoff.bid}</span>
      <span class="collab-badge">{props.handoff.state}</span>
      <Show when={props.handoff.priority === 'urgent'}>
        <span class="collab-badge collab-tone-warning">urgent</span>
      </Show>
      <Show when={props.handoff.archived}>
        <span class="collab-badge collab-muted">[archived]</span>
      </Show>
      <Show when={props.handoff.freeze}>
        <span
          class="collab-badge collab-tone-danger"
          title={`冻结至 ${new Date(props.handoff.freeze!.until).toLocaleTimeString()}（${props.handoff.freeze!.reason}）`}
        >
          frozen
        </span>
      </Show>
      <span class="collab-muted">{fmtTtl(props.handoff.ageMs)}</span>
      <span class="collab-row-title collab-muted">{props.handoff.title}</span>
    </div>
  );
}

/**
 * 0.8.0 (`board2-layout`): one row of the **left list**. Clicking it selects the
 * session (single-select, `sid`-keyed); the rows that belong to it render in the
 * right detail pane, so the row carries no inline detail of its own and the list
 * stays narrow.
 */
function SessionRow(props: {
  session: BoardSession;
  current: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const ctx = usePlugin();
  const store = storeFor(ctx);
  /** Jump to this session's tab. Read the server from the snapshot's source: the
   * rows all come from one server, and a remote one is the interesting case. */
  const jump = (): void => {
    const server = store.state.source?.server ?? ctx.sessions.current()?.server?.id;
    try {
      if (!server) throw new Error('no server');
      ctx.tabs.open({ server, id: props.session.sid }, { focus: true });
    } catch {
      ctx.toast.show({ title: ctx.t('row.jumpFailed'), description: props.session.sid, variant: 'error' });
    }
  };
  const copy = (): void => {
    void ctx.system
      .copy(props.session.sid)
      .then(() => ctx.toast.show({ title: ctx.t('row.copied'), description: props.session.sid, variant: 'success' }))
      .catch(() => ctx.toast.show({ title: ctx.t('row.copyFailed'), variant: 'error' }));
  };
  return (
    <button
      type="button"
      class={`collab-row collab-session${props.selected ? ' collab-session-selected' : ''}`}
      title={props.session.sid}
      aria-pressed={props.selected}
      onClick={props.onSelect}
    >
      <span class="collab-caret">{props.selected ? '›' : '·'}</span>
      <span class={`collab-dot${props.session.busy ? ' collab-dot-busy' : ''}`} />
      <span class="collab-row-body"><span class="collab-row-main"><span class="collab-row-title collab-link" title={`${props.session.title} · ${ctx.t('row.jumpHint')}`} onClick={event => { event.stopPropagation?.(); jump(); }}>{props.session.title}</span><Show when={props.session.sid === props.current}><span class="collab-badge collab-tone-success">{ctx.t('panel.current')}</span></Show><SessionBadges session={props.session} /></span><span class="collab-row-meta"><span class="collab-badge">{props.session.agent}</span><span class="collab-mono collab-muted collab-link" title={`${props.session.sid} · ${ctx.t('row.copyHint')}`} onClick={event => { event.stopPropagation?.(); copy(); }}>{shortSid(props.session.sid)}</span></span></span>
    </button>
  );
}

function GroupView(props: {
  group: BoardWorkspace;
  current: string;
  selected: string | null;
  selectedWorkspace: string | null;
  expanded: (key: string) => boolean;
  onToggle: (key: string) => void;
  onSelect: (sid: string) => void;
  onSelectWorkspace: (workspace: string) => void;
}) {
  const ctx = usePlugin();
  const label = () => workspaceLabel(props.group.workspace) || ctx.t('panel.global');
  const archivedKey = () => `archived:${props.group.workspace}`;
  return (
    <section class="collab-group">
      <header class="collab-head">
        {/* 0.8.0 (`board2-graph`): clicking the workspace name selects the
            workspace, which is what puts the graph on its L1 level. The same
            button is the only way there — the session rows keep selecting a
            session (L2). */}
        <button
          type="button"
          class={`collab-ws${props.selectedWorkspace === props.group.workspace ? ' collab-ws-selected' : ''}`}
          title={props.group.workspace || undefined}
          aria-pressed={props.selectedWorkspace === props.group.workspace}
          onClick={() => props.onSelectWorkspace(props.group.workspace)}
        >
          <span class="collab-head-label">{label()}</span>
        </button>
        <span class="collab-muted">
          {ctx.t('panel.workspaceCounts', {
            sessions: props.group.counts.sessions,
            locks: props.group.counts.locks,
            handoffs: props.group.counts.handoffs,
            archived: props.group.counts.archived
          })}
        </span>
      </header>
      <For each={props.group.sessions}>
        {session => (
          <SessionRow
            session={session}
            current={props.current}
            selected={props.selected === session.sid}
            onSelect={() => props.onSelect(session.sid)}
          />
        )}
      </For>
      <Show when={props.group.archived.length}>
        <button type="button" class="collab-archived" onClick={() => props.onToggle(archivedKey())}>
          {props.expanded(archivedKey()) ? '▾' : '▸'} {ctx.t('panel.archived', { count: props.group.archived.length })}
        </button>
        <Show when={props.expanded(archivedKey())}>
          <For each={props.group.archived}>
            {session => (
              <SessionRow
                session={session}
                current={props.current}
                selected={props.selected === session.sid}
                onSelect={() => props.onSelect(session.sid)}
              />
            )}
          </For>
        </Show>
      </Show>
    </section>
  );
}

/**
 * Rows the board could not attach to any session row (a lease whose holder is
 * gone, a hand-off from a session outside this snapshot, the caller's queue
 * when it is not listed). 0.5.3's flat view showed them; the tree must not drop
 * a row its own header counted. Same `boardOrphans` helper as the TUI.
 */
function OrphanView(props: { orphans: BoardOrphans; current: string }) {
  const ctx = usePlugin();
  return (
    <section class="collab-group collab-orphans">
      <Show when={props.orphans.locks.length}>
        <div class="collab-sub">{ctx.t('panel.orphanLocks', { count: props.orphans.locks.length })}</div>
        <For each={props.orphans.locks}>{lock => <LockRow lock={lock} current={props.current} />}</For>
      </Show>
      <Show when={props.orphans.handoffs.length}>
        <div class="collab-sub">{ctx.t('panel.orphanHandoffs', { count: props.orphans.handoffs.length })}</div>
        <For each={props.orphans.handoffs}>{handoff => <HandoffRow handoff={handoff} />}</For>
      </Show>
      <Show when={props.orphans.queue.length}>
        <div class="collab-sub">{ctx.t('panel.orphanQueue', { count: props.orphans.queue.length })}</div>
        <For each={props.orphans.queue}>{item => <QueueRow item={item} />}</For>
      </Show>
    </section>
  );
}

/**
 * R2 (0.8.0): the right pane, top to bottom — header, graph, action row,
 * items. Both insertions are real elements with a stable
 * `data-collab-slot` (`graph` / `actions`), so a later component mounts in place
 * instead of reshaping the layout; the action row is hidden (not removed) when
 * `snapshot.actions === false`.
 */
function DetailHeader(props: { session: BoardSession; current: string }) {
  const ctx = usePlugin();
  return (
    <header class="collab-detail-header">
      <div class="collab-detail-title" title={props.session.title}>
        {props.session.title}
      </div>
      <div class="collab-detail-meta">
        <span class="collab-badge">{props.session.agent}</span>
        {/* The **full** sid: the list row is shortened, the detail pane is where
            a human copies it into a command. */}
        <span class="collab-mono collab-muted collab-link" title={`${props.session.sid} · ${ctx.t('row.copyHint')}`} onClick={() => { void ctx.system.copy(props.session.sid).then(() => ctx.toast.show({ title: ctx.t('row.copied'), description: props.session.sid, variant: 'success' })).catch(() => ctx.toast.show({ title: ctx.t('row.copyFailed'), variant: 'error' })); }}>{props.session.sid}</span>
        <SessionBadges session={props.session} />
        <Show when={props.session.sid === props.current}>
          <span class="collab-badge collab-tone-success">{ctx.t('panel.current')}</span>
        </Show>
      </div>
    </header>
  );
}

/*
 * The slot classes are computed, not literals: the GUI bundle inlines static
 * attributes (unquoted, no separator), and the test host's template parser
 * needs the class set at runtime, like every other class in this file. The
 * `data-collab-slot` attribute is the slot's stable identity: `board2-graph`
 * renders inside `graph` (see `GraphSlot`); `board2-actions` renders inside
 * `actions` (see `ActionRow`, hidden when `snapshot.actions === false`).
 */
function slotClass(kind: 'graph' | 'actions'): string {
  return `collab-detail-section collab-${kind}-slot`;
}

/* ---------------------------------------------------------------------- graph */

/*
 * 0.8.2 (`graph-zoom`): the graph's coordinate space and layout moved to
 * `src/core/graph-layout.ts` (pure, unit-tested without a window). This half
 * only renders it:
 *
 *   - `layoutGraph` → where each box goes (centre + inner ring + outer ring,
 *     labels cut to 8 code points, no two boxes overlap);
 *   - `viewBoxOf` / `zoomBy` / `clampPan` → the view transform (R1/R2);
 *   - the SVG keeps every node at its layout coordinate, so a zoom or a pan
 *     cannot move node geometry — hit-testing stays the browser's job and a
 *     click on a node after zooming is still a click on that node (R1).
 */

/** Is the event's target (or an ancestor) a node group? Used by dblclick / drag. */
interface GraphDomNode {
  parentNode?: GraphDomNode | null;
  getAttribute?: (name: string) => string | null;
  attrs?: Record<string, string>;
}

/** The little of the SVG element this file touches (the bundle has no DOM lib). */
interface GraphSvgElement {
  getBoundingClientRect?: () => {
    left?: number;
    top?: number;
    width?: number;
    height?: number;
  };
}

/** The fields of the three gestures, declared locally (no `lib.dom` in this bundle). */
interface GraphWheelEvent {
  deltaY?: number;
  clientX?: number;
  clientY?: number;
  preventDefault?: () => void;
}
interface GraphPointerEvent {
  button?: number;
  clientX?: number;
  clientY?: number;
  target?: unknown;
}
interface GraphMouseEvent {
  target?: unknown;
}

function insideGraphNode(target: unknown): boolean {
  let node = target as GraphDomNode | null;
  let guard = 0;
  while (node && guard < 32) {
    const attr =
      typeof node.getAttribute === 'function'
        ? node.getAttribute('data-graph-node')
        : node.attrs?.['data-graph-node'];
    if (attr !== null && attr !== undefined) return true;
    node = node.parentNode ?? null;
    guard += 1;
  }
  return false;
}

/** The document, when this window has one (a test host provides both methods). */
function documentOf():
  | {
      addEventListener(type: string, listener: (event: never) => void): void;
      removeEventListener(type: string, listener: (event: never) => void): void;
    }
  | undefined {
  const doc = (globalThis as { document?: never }).document as
    | { addEventListener?: unknown; removeEventListener?: unknown }
    | undefined;
  if (!doc || typeof doc.addEventListener !== 'function' || typeof doc.removeEventListener !== 'function') {
    return undefined;
  }
  return doc as never;
}

/**
 * R1/R2 (0.8.0 `board2-graph`, 0.8.2 `graph-zoom`): the detail pane's graph slot.
 *
 * The derivation is `core/graph.ts` (the TUI renders the same object); the
 * geometry and the view transform are `core/graph-layout.ts` (pure, no window).
 * This component owns **window-local** state only:
 *
 *   - `collapsed` — a set of node ids whose one-hop neighbours are folded away
 *     (a poll that replaces `data` must not unfold them);
 *   - `hovered` — the node under the pointer, used to brighten its edges;
 *   - `zoom` / `pan` — the **view** (0.8.2): the SVG's `viewBox`, nothing else.
 *     Zooming and dragging never touch a node coordinate, which is exactly why
 *     a click after zooming still hits the node the browser draws (R1) and why
 *     a poll can never "move" anything because the pointer moved (R4/R5).
 *
 * Level follows the selection, which the panel owns: no selection = `global`
 * (workspaces), a workspace = `workspace` (its sessions + ghost workspace
 * nodes), a session = `session` (that session ±1 hop, ≤ `GRAPH_NODE_LIMIT`).
 * Nodes are clickable: a session selects that session, a workspace selects that
 * workspace — the left list and the items below follow (R2). Read-only (R5):
 * the only effects of a click are those two selections.
 */
function GraphSlot(props: {
  snapshot?: Snapshot;
  level: GraphLevel;
  workspace?: string;
  session?: string;
  onPickSession: (sid: string) => void;
  onPickWorkspace: (workspace: string) => void;
}) {
  const ctx = usePlugin();
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const [hovered, setHovered] = createSignal<string | null>(null);
  /* 0.8.2 view state: pure view numbers, reset by a double-click on the canvas. */
  const [zoom, setZoom] = createSignal(1);
  const [pan, setPan] = createSignal<GraphPoint>({ x: 0, y: 0 });
  const [dragging, setDragging] = createSignal(false);
  let svgRef: GraphSvgElement | undefined;
  let endDrag: (() => void) | undefined;

  const graph = createMemo(() =>
    buildGraph(props.snapshot, [], { level: props.level, workspace: props.workspace, session: props.session })
  );

  /**
   * One-hop fold (R2): a node that is **only** reachable through a collapsed
   * node disappears; the selected session and any node still connected to an
   * expanded neighbour stay. Two passes over the (small) edge list, no state
   * beyond the click set — a poll cannot fold a row by itself.
   */
  const hidden = createMemo((): Set<string> => {
    const folded = collapsed();
    const gone = new Set<string>();
    if (!folded.size) return gone;
    const view = graph();
    for (const id of [...folded].sort()) {
      for (const edge of view.edges) {
        const other = edge.from === id ? edge.to : edge.to === id ? edge.from : undefined;
        if (!other || other === props.session || gone.has(other)) continue;
        const kept = view.edges.some(candidate => {
          const pair =
            candidate.from === other ? candidate.to : candidate.to === other ? candidate.from : undefined;
          return pair !== undefined && pair !== id && !folded.has(pair);
        });
        if (!kept) gone.add(other);
      }
    }
    return gone;
  });

  const nodes = createMemo(() => graph().nodes.filter(node => !hidden().has(node.id)));
  const edges = createMemo(() =>
    graph().edges.filter(edge => !hidden().has(edge.from) && !hidden().has(edge.to))
  );

  /**
   * R3: positions and the printed labels come from the one pure layout — the
   * selected session is the centre at L2, everything else follows the (already
   * sorted) node order. `layoutGraph` verifies that no two boxes overlap; this
   * component never re-derives geometry.
   */
  const layout = createMemo(() =>
    layoutGraph(nodes(), {
      width: GRAPH_VIEW.width,
      height: GRAPH_VIEW.height,
      center: props.session,
      label: node => (node.kind === 'workspace' ? node.label || ctx.t('panel.global') : node.label)
    })
  );
  const pointOf = (id: string): GraphPoint =>
    layout().points.get(id) ?? { x: GRAPH_VIEW.width / 2, y: GRAPH_VIEW.height / 2 };
  const widthOf = (id: string): number => layout().widths.get(id) ?? GRAPH_BOX_MIN_W;
  const labelOf = (id: string): string => layout().labels.get(id) ?? '';

  /* ------------------------------------------------------------- view (R1/R2) */

  const viewBox = createMemo(() => viewBoxAttr(viewBoxOf(zoom(), pan())));

  /** The SVG's on-screen box; without layout (a test DOM) the canvas itself. */
  const rectOf = (): GraphRect => {
    try {
      const rect = svgRef?.getBoundingClientRect?.();
      if (rect && Number(rect.width) > 0 && Number(rect.height) > 0) return rect;
    } catch {
      // A host without measurement: fall through to the canvas size.
    }
    return { left: 0, top: 0, width: GRAPH_VIEW.width, height: GRAPH_VIEW.height };
  };

  /**
   * R1: wheel / trackpad pinch zoom, **around the pointer** (the graph point
   * under the pointer stays put — `zoomBy`). `ctrlKey` needs no branch: a
   * trackpad pinch arrives as a ctrl+wheel with the same `deltaY` shape.
   */
  const onWheel = (event: GraphWheelEvent): void => {
    if (typeof event.preventDefault === 'function') event.preventDefault();
    const next = zoomBy(
      zoom(),
      pan(),
      Number(event.deltaY) || 0,
      { x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 },
      rectOf()
    );
    setZoom(next.zoom);
    setPan(next.pan);
  };

  /** R2: reset to 1× / centred — only on the **blank** canvas, never on a node. */
  const onDblClick = (event: GraphMouseEvent): void => {
    if (insideGraphNode(event.target)) return;
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  /**
   * R2: drag the blank canvas to pan. The listeners live on `document` for the
   * duration of the gesture (a pointer that leaves the SVG still pans), and are
   * removed on pointerup / cancel **and** when the slot unmounts — a disposed
   * plugin must not keep a listener alive.
   */
  const stopDragging = (): void => {
    const stop = endDrag;
    endDrag = undefined;
    setDragging(false);
    stop?.();
  };

  const onPointerDown = (event: GraphPointerEvent): void => {
    if (typeof event.button === 'number' && event.button !== 0) return;
    if (insideGraphNode(event.target)) return;
    const doc = documentOf();
    if (!doc) return;
    stopDragging();
    const rect = rectOf();
    const box = viewBoxOf(zoom(), pan());
    const startX = Number(event.clientX) || 0;
    const startY = Number(event.clientY) || 0;
    const startPan = pan();
    // Client px → view units: the same drag moves the same amount of graph at
    // any zoom (one graph unit per *rendered* pixel).
    const scaleX = box.width / Math.max(1, Number(rect.width) || GRAPH_VIEW.width);
    const scaleY = box.height / Math.max(1, Number(rect.height) || GRAPH_VIEW.height);
    const onMove = (moveEvent: GraphPointerEvent): void => {
      const dx = ((Number(moveEvent.clientX) || 0) - startX) * scaleX;
      const dy = ((Number(moveEvent.clientY) || 0) - startY) * scaleY;
      // Dragging right moves the content right, i.e. the view left.
      setPan(clampPan({ x: startPan.x - dx, y: startPan.y - dy }, zoom()));
    };
    const onUp = (): void => stopDragging();
    setDragging(true);
    doc.addEventListener('pointermove', onMove as (event: never) => void);
    doc.addEventListener('pointerup', onUp as (event: never) => void);
    doc.addEventListener('pointercancel', onUp as (event: never) => void);
    endDrag = () => {
      doc.removeEventListener('pointermove', onMove as (event: never) => void);
      doc.removeEventListener('pointerup', onUp as (event: never) => void);
      doc.removeEventListener('pointercancel', onUp as (event: never) => void);
    };
  };

  onCleanup(() => {
    stopDragging();
  });

  const neighbours = (id: string): number =>
    graph().edges.reduce((total, edge) => total + (edge.from === id || edge.to === id ? 1 : 0), 0);

  const toggle = (id: string): void => {
    setCollapsed(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const isSelected = (node: GraphNode): boolean =>
    node.kind === 'session' ? props.session === node.id : props.workspace === node.id;

  const nodeClass = (node: GraphNode): string =>
    [
      'collab-graph-node',
      `collab-graph-node-${node.kind}`,
      isSelected(node) ? 'collab-graph-node-selected' : '',
      node.archived ? 'collab-graph-node-archived' : '',
      node.frozen ? 'collab-graph-node-frozen' : '',
      node.urgent ? 'collab-graph-node-urgent' : ''
    ]
      .filter(Boolean)
      .join(' ');

  /**
   * `stroke-dasharray` per R1: `handoff` solid, `origin` dashed, `spawn` /
   * `subagent` dotted (a short dash reads as dots at this stroke width). An edge
   * that leaves a workspace in L1 keeps the dashed form of a collapsed
   * counterpart (`origin` stays dashed either way).
   */
  const dashOf = (edge: GraphEdge): string => {
    // A cross-boundary edge is folded onto a workspace placeholder, whatever its
    // kind: it stays dashed so it never reads like a session-to-session link.
    const target = graph().nodes.find(node => node.id === edge.to);
    if (target?.kind === 'workspace') return '4 3';
    if (edge.kind === 'spawn' || edge.kind === 'subagent') return '1 3';
    if (edge.kind === 'origin') return '4 3';
    return '';
  };

  const edgeClass = (edge: GraphEdge): string => {
    const active = hovered() === edge.from || hovered() === edge.to;
    return `collab-graph-edge collab-graph-edge-${edge.kind}${active ? ' collab-graph-edge-active' : ''}`;
  };

  const pick = (node: GraphNode): void => {
    if (node.kind === 'workspace') props.onPickWorkspace(node.id);
    else props.onPickSession(node.id);
  };

  return (
    <div class={slotClass('graph')} data-collab-slot="graph">
      <div class="collab-graph" data-graph-level={props.level}>
        <svg
          class={dragging() ? 'collab-graph-svg collab-graph-dragging' : 'collab-graph-svg'}
          ref={(node: GraphSvgElement) => {
            svgRef = node;
          }}
          viewBox={viewBox()}
          data-graph-zoom={zoom()}
          data-graph-pan={`${Math.round(pan().x * 10) / 10},${Math.round(pan().y * 10) / 10}`}
          aria-label={ctx.t('graph.title')}
          onWheel={onWheel}
          onDblClick={onDblClick}
          onPointerDown={onPointerDown}
        >
          <For each={edges()}>
            {edge => {
              const from = () => layout().points.get(edge.from);
              const to = () => layout().points.get(edge.to);
              return (
                <Show when={from() && to()}>
                  <line
                    class={edgeClass(edge)}
                    data-graph-edge={edge.kind}
                    data-graph-from={edge.from}
                    data-graph-to={edge.to}
                    x1={from()!.x}
                    y1={from()!.y}
                    x2={to()!.x}
                    y2={to()!.y}
                    stroke-dasharray={dashOf(edge)}
                  />
                </Show>
              );
            }}
          </For>
          <For each={nodes()}>
            {node => {
              const point = () => pointOf(node.id);
              const width = () => widthOf(node.id);
              return (
                <>
                  <g
                    class={nodeClass(node)}
                    data-graph-node={node.id}
                    onClick={() => pick(node)}
                    onMouseOver={() => setHovered(node.id)}
                    onMouseOut={() => setHovered(null)}
                  >
                    <rect
                      class="collab-graph-box"
                      x={point().x - width() / 2}
                      y={point().y - GRAPH_BOX_H / 2}
                      width={width()}
                      height={GRAPH_BOX_H}
                      rx="4"
                    />
                    {/* The badge owns the right `GRAPH_BADGE_W`, the label the rest. */}
                    <text
                      class="collab-graph-label"
                      x={point().x - GRAPH_BADGE_W / 2}
                      y={point().y + 3}
                      text-anchor="middle"
                    >
                      {labelOf(node.id)}
                    </text>
                  </g>
                  <Show when={neighbours(node.id) > 0}>
                    <g
                      class="collab-graph-toggle"
                      data-graph-toggle={node.id}
                      onClick={() => toggle(node.id)}
                    >
                      <rect
                        class="collab-graph-toggle-box"
                        x={point().x + width() / 2 - GRAPH_BADGE_W - 2}
                        y={point().y - 5}
                        width="10"
                        height="10"
                        rx="2"
                      />
                      <text
                        class="collab-graph-toggle-label"
                        x={point().x + width() / 2 - GRAPH_BADGE_W + 3}
                        y={point().y + 3}
                        text-anchor="middle"
                      >
                        {collapsed().has(node.id) ? '▸' : '▾'}
                      </text>
                    </g>
                  </Show>
                </>
              );
            }}
          </For>
        </svg>
        <Show when={graph().truncated > 0}>
          <span class="collab-graph-more" title={ctx.t('graph.truncated', { count: graph().truncated })}>
            +{graph().truncated}
          </span>
        </Show>
        <Show when={!nodes().length}>
          <div class="collab-empty">{ctx.t('graph.empty')}</div>
        </Show>
        <Show when={nodes().length}>
          <div class="collab-graph-legend">
            {ctx.t('graph.legend', {
              max: GRAPH_NODE_LIMIT,
              level: ctx.t(`graph.level.${props.level}`)
            })}
            {' · '}
            {ctx.t('graph.hint')}
          </div>
        </Show>
      </div>
    </div>
  );
}

/** `board2-actions`: the action row — four confirmed writes (0.8.0). */
type BoardActionId = 'escalate' | 'freeze' | 'unfreeze' | 'archive';
const BOARD_ACTIONS: BoardActionId[] = ['escalate', 'freeze', 'unfreeze', 'archive'];

/** The slice of `collab.state` the board calls (the write half of `CollabState`). */
interface BoardActionApi {
  escalate(input: { target: string; reason?: string; session?: string }): Promise<ActionReceipt>;
  freeze(input: {
    target: string;
    scope?: string;
    until?: number | string;
    reason?: string;
    session?: string;
  }): Promise<ActionReceipt>;
  unfreeze(input: { target: string; scope?: string; session?: string }): Promise<ActionReceipt>;
  archive(input: { target: string; restore?: boolean; session?: string }): Promise<ActionReceipt>;
}

/**
 * `ctx.dialogs` is missing in a test host and in an older window. Reading a
 * missing key on the probe-proxied context throws, so this is the one place that
 * answers "does this window have confirmation dialogs?" safely.
 */
function dialogsOf(ctx: Context): Context['dialogs'] | undefined {
  try {
    return ctx.dialogs;
  } catch {
    return undefined;
  }
}

/**
 * R1/R4 (0.8.0, `board2-actions`): the detail pane's action row —
 * `加急` / `冻结` / `解冻` / `归档`.
 *
 * Each click asks first, then calls the server (`collab.state.escalate|freeze|
 * unfreeze|archive`), then shows the **server's** verdict in a toast. The panel
 * never decides a gate itself: protected / frozen / read-only / refused-host
 * outcomes all arrive as `ActionReceipt { ok, detail }` from the same core
 * functions the tools run.
 *
 * Fallback (known limitation, docs/collab.md §11.20): a window without
 * `ctx.dialogs` confirms with **two clicks** on the same button (`再点一次`),
 * because the alternative — silently writing on one click — is exactly what R4
 * forbids. The arm is keyed by `(action, session)` and the target is captured
 * before any await, so switching the selection can never turn one click into an
 * execution on another session. Escalation then uses a fixed one-line reason.
 *
 * A failed call (server down, a thrown RPC) only shows an error toast: the panel
 * stays interactive (R6).
 */
function ActionRow(props: { session: BoardSession; enabled: boolean }) {
  const ctx = usePlugin();
  const [busy, setBusy] = createSignal<BoardActionId | null>(null);
  /**
   * The two-step fallback's armed state — **keyed by the target session**.
   * `ActionRow` is not recreated when the selection changes (the detail pane is
   * a non-keyed child), so an armed button that only remembered the action id
   * would let a single click on *another* session execute the action. An arm
   * therefore belongs to `(id, sid)`: switching sessions simply shows no armed
   * button, and the new target must be armed (and confirmed) on its own.
   */
  const [armed, setArmed] = createSignal<{ id: BoardActionId; sid: string } | null>(null);

  // Switching sessions drops the arm: coming back to A must not execute on a
  // single click (review R-1: A→B→A resurrection).
  createEffect(() => {
    void props.session.sid;
    setArmed(null);
  });

  const label = (id: BoardActionId): string => ctx.t(`action.${id}`);
  const defaultFreezeReason = (): string => ctx.t('action.freezeDefaultReason');
  /** Is this button armed **for the session on screen right now**? */
  const armedHere = (id: BoardActionId): boolean => armed()?.id === id && armed()?.sid === props.session.sid;

  /**
   * The confirmation a click must pass. `null` = cancelled (0 writes); a string
   * = go (the escalation reason; `''` for the other three). `sid` is the target
   * captured by `run()` **before** any await, so a dialog that is still open when
   * the selection changes can never retarget the action.
   */
  const prepare = async (id: BoardActionId, sid: string): Promise<string | null> => {
    const dialogs = dialogsOf(ctx);
    if (!dialogs) {
      // Two-step fallback: the first click only arms this button — on the
      // target captured by `run()`. An arm left on another target is ignored.
      const sameTarget = (): boolean => armed()?.id === id && armed()?.sid === sid;
      if (!sameTarget()) {
        setArmed({ id, sid });
        ctx.toast.show({ title: label(id), description: ctx.t('action.armHint'), variant: 'default' });
        return null;
      }
      setArmed(null);
      return id === 'escalate' ? ctx.t('action.escalateDefaultReason') : '';
    }
    if (id === 'escalate') {
      const reason = await dialogs.prompt({
        title: ctx.t('action.escalateReasonTitle'),
        description: ctx.t('action.escalateReasonDesc'),
        placeholder: ctx.t('action.escalatePlaceholder'),
        value: ctx.t('action.escalateDefaultReason'),
        submit: label(id)
      });
      if (reason === undefined) return null;
      const go = await dialogs.confirm({
        title: ctx.t('action.escalateConfirm', { sid }),
        description: reason,
        confirm: label(id)
      });
      return go ? reason : null;
    }
    const question =
      id === 'freeze' ? 'action.freezeConfirm' : id === 'unfreeze' ? 'action.unfreezeConfirm' : 'action.archiveConfirm';
    const note = id === 'freeze' ? 'action.freezeDesc' : id === 'unfreeze' ? 'action.unfreezeDesc' : 'action.archiveDesc';
    const go = await dialogs.confirm({
      title: ctx.t(question, { sid }),
      description: ctx.t(note),
      confirm: label(id),
      danger: id === 'archive'
    });
    return go ? '' : null;
  };

  const run = async (id: BoardActionId): Promise<void> => {
    if (busy()) return;
    // Captured **once**, before the confirmation: everything below (dialogs,
    // RPC, toasts) belongs to the session that was on screen when the click
    // happened, even if the selection changes while a dialog is open.
    const target = props.session.sid;
    let reason: string | null;
    try {
      reason = await prepare(id, target);
    } catch (error) {
      setArmed(null);
      ctx.toast.show({ title: label(id), description: describe(error), variant: 'error' });
      return;
    }
    if (reason === null) return; // cancelled: nothing is written
    // The routed session's client — the same source the snapshot came from.
    const api = sourceFor(ctx).client.rpc(CollabState) as unknown as BoardActionApi;
    const base = { target, session: ctx.sessions.current()?.id };
    setBusy(id);
    try {
      const receipt =
        id === 'escalate'
          ? await api.escalate({ ...base, reason })
          : id === 'freeze'
            ? await api.freeze({ ...base, scope: 'session', reason: reason || defaultFreezeReason() })
            : id === 'unfreeze'
              ? await api.unfreeze({ ...base, scope: 'session' })
              : await api.archive({ ...base });
      const ok = receipt?.ok !== false;
      ctx.toast.show({
        title: ok ? ctx.t('action.done', { action: label(id) }) : ctx.t('action.failed', { action: label(id) }),
        description: receipt?.detail ?? '',
        variant: ok ? 'success' : 'error'
      });
      // R4: one refresh after a successful write — the existing poller is not
      // duplicated and no new interval is created.
      if (ok) void storeFor(ctx).load();
    } catch (error) {
      // R6: a thrown RPC never breaks the panel — a toast, and it stays usable.
      ctx.toast.show({
        title: ctx.t('action.failed', { action: label(id) }),
        description: describe(error),
        variant: 'error'
      });
    } finally {
      setBusy(null);
      setArmed(null);
    }
  };

  return (
    <div class={slotClass('actions')} data-collab-slot="actions">
      <Show when={props.enabled}>
        <div class="collab-actions" title={ctx.t('action.rowTitle')}>
          <For each={BOARD_ACTIONS}>
            {id => (
              <button
                type="button"
                class={`collab-action${armedHere(id) ? ' collab-action-armed' : ''}${
                  id === 'archive' ? ' collab-action-danger' : ''
                }`}
                data-collab-action={id}
                disabled={busy() !== null}
                aria-busy={busy() === id}
                title={`${label(id)} · ${props.session.sid}`}
                onClick={() => void run(id)}
              >
                {armedHere(id) ? `${ctx.t('action.armed')} ${label(id)}` : label(id)}
              </button>
            )}
          </For>
          <Show when={busy()}>
            <span class="collab-muted">{ctx.t('action.running')}</span>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** Leases → hand-offs → owner queue → `↳` spawned (the same derivation the row badges use). */
function DetailItems(props: { session: BoardSession; current: string }) {
  const ctx = usePlugin();
  const session = () => props.session;
  const empty = () =>
    !session().locks.length && !session().handoffs.length && !session().queue.length && !session().spawned.length;
  return (
    <div class="collab-items">
      <Show when={session().locks.length}>
        <div class="collab-sub">{ctx.t('panel.detailLocks', { count: session().locks.length })}</div>
        <For each={session().locks}>{lock => <LockRow lock={lock} current={props.current} />}</For>
      </Show>
      <Show when={session().handoffs.length}>
        <div class="collab-sub">{ctx.t('panel.detailHandoffs', { count: session().handoffs.length })}</div>
        <For each={session().handoffs}>{handoff => <HandoffRow handoff={handoff} />}</For>
      </Show>
      <Show when={session().queue.length}>
        <div class="collab-sub">{ctx.t('panel.detailQueue', { count: session().queue.length })}</div>
        <For each={session().queue}>{item => <QueueRow item={item} />}</For>
      </Show>
      <Show when={session().spawned.length}>
        <div class="collab-sub">{ctx.t('panel.detailSpawned', { count: session().spawned.length })}</div>
        <For each={session().spawned}>{child => <SpawnRow child={child} />}</For>
      </Show>
      <Show when={empty()}>
        <div class="collab-empty">{ctx.t('panel.detailEmpty')}</div>
      </Show>
    </div>
  );
}

function BoardDetail(props: {
  session: BoardSession;
  current: string;
  narrow: boolean;
  snapshot?: Snapshot;
  actions: boolean;
  onBack: () => void;
  onPickSession: (sid: string) => void;
  onPickWorkspace: (workspace: string) => void;
}) {
  const ctx = usePlugin();
  return (
    <section class="collab-detail-pane">
      <Show when={props.narrow}>
        <button type="button" class="collab-back" onClick={props.onBack}>
          ← {ctx.t('panel.back')}
        </button>
      </Show>
      <DetailHeader session={props.session} current={props.current} />
      {/* L2: the selected session is the centre (±1 hop, ≤ GRAPH_NODE_LIMIT). */}
      <GraphSlot
        snapshot={props.snapshot}
        level="session"
        workspace={props.session.workspace}
        session={props.session.sid}
        onPickSession={props.onPickSession}
        onPickWorkspace={props.onPickWorkspace}
      />
      <ActionRow session={props.session} enabled={props.actions} />
      <DetailItems session={props.session} current={props.current} />
    </section>
  );
}

/**
 * R1/R3 (0.8.0): the side panel's content. Left = the tree, right = the detail
 * of the selected session (single-select, `sid`-keyed so it survives a snapshot
 * replacement). Below 640 px the two panes become one: selecting a session
 * replaces the list and a `← 返回列表` button brings it back.
 *
 * Reads `props.session` as a getter, never destructured.
 */
function PanelView(props: { session: { id: string } }) {
  const ctx = usePlugin();
  const store = storeFor(ctx);
  // Expand/collapse lives here, not in the store: a 2 s poll replaces `data`
  // and must not fold a row the user opened. The only key left is
  // `archived:<workspace>` — sessions are selected, not expanded.
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const isExpanded = (key: string): boolean => expanded().has(key);
  const toggle = (key: string): void => {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  // R3: the selection is component memory, not snapshot data — a poll that
  // replaces `data` cannot reset it.
  const [selected, setSelected] = createSignal<string | null>(null);
  // 0.8.0 (`board2-graph`): a workspace can be selected too (the L1 level of the
  // graph). Session and workspace selections are mutually exclusive: picking
  // one clears the other, so the graph level is never ambiguous.
  const [selectedWorkspace, setSelectedWorkspace] = createSignal<string | null>(null);
  // R1: the one breakpoint. Read once per mount (a media query, not a resize
  // listener on every render); a host without `matchMedia` is the wide form.
  const query = narrowQuery();
  const [narrow, setNarrow] = createSignal(query?.matches === true);
  if (query && typeof query.addEventListener === 'function') {
    const onChange = (): void => {
      setNarrow(query.matches === true);
    };
    query.addEventListener('change', onChange);
    onCleanup(() => query.removeEventListener?.('change', onChange));
  }

  const groups = createMemo(() =>
    store.state.data ? buildBoard(store.state.data, [], Date.now(), props.session.id) : []
  );
  const orphans = createMemo(() => boardOrphans(store.state.data, groups()));
  const hasOrphans = (): boolean =>
    orphans().locks.length > 0 || orphans().handoffs.length > 0 || orphans().queue.length > 0;

  /** The selected session, active **or** archived: an archived session still exists. */
  const selectedSession = createMemo((): BoardSession | undefined => {
    const sid = selected();
    if (!sid) return undefined;
    for (const workspace of groups()) {
      const hit = [...workspace.sessions, ...workspace.archived].find(session => session.sid === sid);
      if (hit) return hit;
    }
    return undefined;
  });

  // R3: a selection that left the snapshot (closed, or no longer listed) is
  // cleared and said out loud. No snapshot at all (adopt / a failed poll) is
  // *not* a disappearance: the rows are kept while the banner explains them.
  createEffect(() => {
    const sid = selected();
    if (!sid || !store.state.data) return;
    if (selectedSession()) return;
    setSelected(null);
    ctx.toast.show({
      title: ctx.t('panel.title'),
      description: ctx.t('panel.selectedGone'),
      variant: 'default'
    });
  });

  // The same rule for a selected workspace: only when it stops being listed.
  createEffect(() => {
    const workspace = selectedWorkspace();
    if (workspace === null || !store.state.data) return;
    if (groups().some(group => group.workspace === workspace)) return;
    setSelectedWorkspace(null);
    ctx.toast.show({
      title: ctx.t('panel.title'),
      description: ctx.t('panel.workspaceGone'),
      variant: 'default'
    });
  });

  // The left list toggles a session off on a second click (unchanged). The
  // graph's node click is absolute: clicking the centre must keep it selected.
  const select = (sid: string): void => {
    setSelected(previous => (previous === sid ? null : sid));
    setSelectedWorkspace(null);
  };
  const pickSession = (sid: string): void => {
    setSelected(sid);
    setSelectedWorkspace(null);
  };
  const selectWorkspace = (workspace: string): void => {
    setSelectedWorkspace(previous => (previous === workspace ? null : workspace));
    setSelected(null);
  };

  /** L0 / L1 / L2 — the one rule the graph slot reads (R2). */
  const graphLevel = (): GraphLevel =>
    selectedSession() ? 'session' : selectedWorkspace() !== null ? 'workspace' : 'global';

  // 0.5.3 (R3): name the server the rows came from — remote only. The app's own
  // server is the default and would be noise (`@sidecar` on every window).
  const sourceLabel = (): string => {
    const server = ctx.sessions.current()?.server;
    if (server?.local === true || !store.state.source?.server) return '';
    return `@${store.state.source.server}`;
  };

  return (
    <div class="collab-panel" data-collab-at={String(store.state.at)}>
      <Show when={sourceLabel()}>
        <div class="collab-source collab-mono collab-muted" title={ctx.t('panel.source')}>
          {sourceLabel()}
        </div>
      </Show>
      <Show when={store.state.error}>
        <div class="collab-error">
          <span class="collab-error-title">{ctx.t('panel.unreachable')}</span>
          <span class="collab-mono">{store.state.error}</span>
        </div>
      </Show>
      {/* 0.9.0 (`11-20-collab-store`, R4): the projection is a cache. A bad or
          missing `collab.db` degrades only this marker — every row above still
          comes from the JSON truth, so nothing is hidden by a broken index. */}
      <Show when={store.state.data?.index && store.state.data.index.available === false}>
        <div class="collab-source collab-mono collab-muted" title={store.state.data?.index?.reason ?? ''}>
          {ctx.t('panel.indexUnavailable')} {store.state.data?.index?.reason ?? ''}
        </div>
      </Show>
      <Show
        when={store.state.data}
        fallback={
          <Show when={!store.state.error}>
            <div class="collab-empty">{store.state.loading ? ctx.t('panel.loading') : ctx.t('panel.empty')}</div>
          </Show>
        }
      >
        <Show when={groups().length || hasOrphans()} fallback={<div class="collab-empty">{ctx.t('panel.empty')}</div>}>
          <div class={`collab-split${narrow() ? ' collab-split-narrow' : ''}`}>
            <Show when={!narrow() || (!selected() && selectedWorkspace() === null)}>
              <section class="collab-sidebar">
                <For each={groups().filter(group => group.sessions.length || group.archived.length)}>
                  {group => (
                    <GroupView
                      group={group}
                      current={props.session.id}
                      selected={selected()}
                      selectedWorkspace={selectedWorkspace()}
                      expanded={isExpanded}
                      onToggle={toggle}
                      onSelect={select}
                      onSelectWorkspace={selectWorkspace}
                    />
                  )}
                </For>
                <Show when={hasOrphans()}>
                  <OrphanView orphans={orphans()} current={props.session.id} />
                </Show>
              </section>
            </Show>
            <Show when={!narrow() || selected() || selectedWorkspace() !== null}>
              <Show
                when={selectedSession()}
                fallback={
                  <section class="collab-detail-pane">
                    <Show when={narrow()}>
                      <button
                        type="button"
                        class="collab-back"
                        onClick={() => {
                          setSelectedWorkspace(null);
                          setSelected(null);
                        }}
                      >
                        ← {ctx.t('panel.back')}
                      </button>
                    </Show>
                    {/* No session selected: L0 (global) or L1 (a workspace). */}
                    <GraphSlot
                      snapshot={store.state.data}
                      level={graphLevel()}
                      workspace={selectedWorkspace() ?? undefined}
                      onPickSession={pickSession}
                      onPickWorkspace={selectWorkspace}
                    />
                    <div class="collab-empty">{ctx.t('panel.pick')}</div>
                  </section>
                }
              >
                {(session: () => BoardSession) => (
                  <BoardDetail
                    session={session()}
                    current={props.session.id}
                    narrow={narrow()}
                    snapshot={store.state.data}
                    actions={store.state.data?.actions !== false}
                    onPickSession={pickSession}
                    onPickWorkspace={selectWorkspace}
                    onBack={() => {
                      setSelected(null);
                      setSelectedWorkspace(null);
                    }}
                  />
                )}
              </Show>
            </Show>
          </div>
        </Show>
        <div class="collab-footer">
          {ctx.t('panel.updated', { time: fmtClock(store.state.at) })} · {ctx.t('panel.readonly')}
        </div>
      </Show>
    </div>
  );
}

/* ---------------------------------------------------------------- header counts */

/**
 * 0.6.0 (R4): 宿主排队 — the app's own pending prompt queue for this session
 * (`delivery:"queue"`). It is **not** part of `collab.state.snapshot` (it belongs
 * to the host, not to this plugin) and it is not a second poll: it is read from
 * the server data the window has already synced (`MountedSession.server.data`),
 * so the header can print all four numbers from one store.
 *
 * `pending.sync` is asked for once per session (fire-and-forget, failures
 * silent) so the number reflects the host rather than whichever screen last
 * touched it. A host without the API — or a session that carries no `server`
 * (an older window, the test host) — simply reports `0`.
 */
const pendingSynced = new Set<string>();

function hostPending(session: MountedSession | undefined): number {
  const pending = session?.server?.data?.session?.pending;
  if (!session || !pending) return 0;
  const key = session.key ?? session.id;
  if (!pendingSynced.has(key)) {
    pendingSynced.add(key);
    try {
      // Never awaited and never surfaced: a status line must not fail a render.
      void Promise.resolve(pending.sync(session.id)).catch(() => {});
    } catch {
      /* host without sync(): keep the synced snapshot */
    }
  }
  return pendingCountOf(pending, session.id);
}

/**
 * R2 (0.5.1): the always-visible entry point. One muted line in the session
 * header carries the same numbers as the panel, read from the same
 * `sharedStore` — no second RPC stream, no second timer.
 *
 * 0.6.0 (R4): the line is `持有 N · 排队 M · 待受保护 K · 宿主排队 J`, computed by
 * `countsOf` + `hostPending` — one vocabulary with the TUI sidebar. It used to
 * read `锁 N` from `data.locks.length`, which counts *rows worth showing*
 * (including a free resource that only has a queued waiter) and read like
 * "N holders". `held` is now literally `holders.length > 0`.
 *
 * It renders **nothing** while there is no snapshot and no error: a `0 · 0 · 0`
 * row would claim "no collaboration activity" when the real answer is "not
 * asked yet". An unreachable server reads `collab: n/a` (the honest answer) and
 * still opens the panel, whose banner carries the reason.
 */
function HeaderCounts(props: { session: MountedSession }) {
  const ctx = usePlugin();
  const store = storeFor(ctx);

  const label = (): string | undefined => {
    if (store.state.error) return ctx.t('header.unreachable');
    const data = store.state.data;
    if (!data) return undefined;
    const counts = countsOf(data);
    return ctx.t('header.counts', {
      held: String(counts.held),
      waiting: String(counts.waiting),
      protected: String(counts.protected),
      host: String(hostPending(ctx.sessions.current()))
    });
  };

  const open = () => ctx.layout.open(`${ctx.id}:${PANEL_TAB}`, props.session);

  return (
    <Show when={label()}>
      <button type="button" class="collab-counts" title={ctx.t('header.title')} onClick={open}>
        {label()}
      </button>
    </Show>
  );
}

/* --------------------------------------------------------------------- plugin */

export default Plugin.define({
  i18n: {
    en: {
      'panel.title': 'Collab',
      'panel.open': 'Open collab panel',
      'panel.current': 'this session',
      'panel.mine': 'mine',
      'panel.locks': 'Leases',
      'panel.handoffs': 'Open hand-offs',
      'panel.free': 'free',
      'panel.global': 'Global',
      'panel.empty': 'No collaboration activity.',
      'panel.loading': 'Loading…',
      'panel.unreachable': 'server unreachable',
      'panel.indexUnavailable': '[index unavailable]',
      'panel.remaining': 'left {{ttl}}',
      'panel.updated': 'updated {{time}}',
      'panel.readonly': 'read-only views · actions ask first',
      'panel.sessions.one': '{{count}} session',
      'panel.sessions.other': '{{count}} sessions',
      'panel.workspaceCounts': '{{sessions}} sessions · {{locks}} leases · {{handoffs}} hand-offs · {{archived}} archived',
      'panel.archived': 'Archived {{count}}',
      'panel.badgeHeld': 'leases held',
      'panel.badgeWaiting': 'leases queued',
      'panel.badgeHandoffs': 'open hand-offs',
      'panel.badgeQueue': 'my owner-queue items',
      'panel.orphanLocks': 'Leases ({{count}}) · unclaimed',
      'panel.orphanHandoffs': 'Open hand-offs ({{count}}) · unclaimed',
      'panel.orphanQueue': 'Owner queue ({{count}}) · unclaimed',
      'panel.seen': 'seen',
      'panel.pending': 'pending',
      'panel.waiting.one': '{{count}} waiting',
      'panel.waiting.other': '{{count}} waiting',
      'panel.pick': 'Select a session to see its details.',
      'panel.back': 'Back to the list',
      'panel.selectedGone': 'That session is no longer in the snapshot',
      'panel.detailLocks': 'Leases ({{count}})',
      'panel.detailHandoffs': 'Open hand-offs ({{count}})',
      'panel.detailQueue': 'Owner queue ({{count}})',
      'panel.detailSpawned': 'Spawned ({{count}})',
      'panel.detailEmpty': 'No leases, hand-offs or queue items for this session.',
      'pill.title': 'Collaboration leases',
      'pill.held.one': '{{count}} lease',
      'pill.held.other': '{{count}} leases',
      'pill.waiting.one': '{{count}} waiting',
      'pill.waiting.other': '{{count}} waiting',
      'pill.remaining': 'left {{ttl}}',
      'pill.position': 'queue #{{position}}',
      'command.open': 'Open collab panel',
      'command.description': 'Read-only: leases, open hand-offs, and the owner queue',
      'command.group': 'Collab',
      'header.counts': '{{held}} held · {{waiting}} waiting · {{protected}} for protected · {{host}} host queue',
      'header.title': 'Collab status — open the panel',
      'header.unreachable': 'collab: n/a',
      'row.copyHint': 'click to copy the session id',
      'row.jumpHint': 'click to open this session',
      'row.copied': 'Session id copied',
      'row.copyFailed': 'Could not copy the session id',
      'row.jumpFailed': 'Could not open that session',
      'titlebar.title': 'Collab status — open the panel',
      'probe.title': 'Collab GUI loaded',
      'probe.description': 'plugin v{{version}} · id={{id}} · panel={{panel}} · app={{app}}({{platform}}) · server={{server}}',
      'panel.source': 'Rows come from this server',
      'panel.workspaceGone': 'That workspace is no longer in the snapshot',
      'graph.title': 'Relations',
      'graph.empty': 'No relations to draw.',
      'graph.legend': '{{level}} · click a node to select it · ▸/▾ folds one hop · at most {{max}} nodes',
      'graph.hint': 'wheel zooms · drag pans · double-click resets',
      'graph.truncated': '{{count}} more node(s) not shown',
      'graph.level.global': 'global',
      'graph.level.workspace': 'workspace',
      'graph.level.session': 'session',
      'action.rowTitle': 'Actions (each asks first)',
      'action.escalate': 'Escalate',
      'action.freeze': 'Freeze',
      'action.unfreeze': 'Unfreeze',
      'action.archive': 'Archive',
      'action.armed': 'Click again:',
      'action.running': 'working…',
      'action.armHint': 'This window has no confirmation dialog: click the same button again to confirm (nothing was written yet).',
      'action.escalateReasonTitle': 'Why now?',
      'action.escalateReasonDesc': 'One line (≤200 chars). Cancel sends nothing.',
      'action.escalatePlaceholder': 'e.g. store.ts is blocked, wait for the schema line',
      'action.escalateDefaultReason': 'Escalated from the board',
      'action.escalateConfirm': 'Escalate {{sid}}?',
      'action.freezeConfirm': 'Freeze {{sid}}?',
      'action.freezeDesc': 'Default 30 minutes; it expires by itself. New hand-offs / escalations are refused until then.',
      'action.freezeDefaultReason': 'Frozen from the board (30 min)',
      'action.unfreezeConfirm': 'Unfreeze {{sid}}?',
      'action.unfreezeDesc': 'New collaboration is accepted again immediately (nobody is notified).',
      'action.archiveConfirm': 'Archive {{sid}}?',
      'action.archiveDesc': 'Archive is not delete: the session and its messages stay, and restore brings it back.',
      'action.done': '{{action}} done',
      'action.failed': '{{action}} failed'
    },
    zh: {
      'panel.title': '协作',
      'panel.open': '打开协作面板',
      'panel.current': '当前会话',
      'panel.mine': '我',
      'panel.locks': '资源租约',
      'panel.handoffs': '未闭环交接',
      'panel.free': '空闲',
      'panel.global': '全局',
      'panel.empty': '没有协作活动。',
      'panel.loading': '加载中…',
      'panel.unreachable': 'server 不可达',
      'panel.indexUnavailable': '[索引不可用]',
      'panel.remaining': '剩余 {{ttl}}',
      'panel.updated': '更新于 {{time}}',
      'panel.readonly': '视图只读 · 动作需确认',
      'panel.sessions.other': '{{count}} 个会话',
      'panel.workspaceCounts': '{{sessions}} 会话 · {{locks}} 锁 · {{handoffs}} 交接 · {{archived}} 已归档',
      'panel.archived': '已归档 {{count}}',
      'panel.badgeHeld': '持有的锁',
      'panel.badgeWaiting': '排队的锁',
      'panel.badgeHandoffs': '未闭环交接',
      'panel.badgeQueue': '我提交的队列项',
      'panel.orphanLocks': '资源租约 ({{count}}) · 未归属',
      'panel.orphanHandoffs': '未闭环交接 ({{count}}) · 未归属',
      'panel.orphanQueue': '受保护目标队列 ({{count}}) · 未归属',
      'panel.seen': '已读',
      'panel.pending': '未读',
      'panel.waiting.other': '等待 {{count}}',
      'panel.pick': '选择左侧会话查看详情。',
      'panel.back': '返回列表',
      'panel.selectedGone': '该会话已不在快照中',
      'panel.detailLocks': '资源租约 ({{count}})',
      'panel.detailHandoffs': '未闭环交接 ({{count}})',
      'panel.detailQueue': '受保护目标队列 ({{count}})',
      'panel.detailSpawned': '拉起的会话 ({{count}})',
      'panel.detailEmpty': '该会话没有锁 / 交接 / 队列 / 拉起的会话。',
      'pill.title': '协作资源',
      'pill.held.other': '锁 {{count}}',
      'pill.waiting.other': '等待 {{count}}',
      'pill.remaining': '剩余 {{ttl}}',
      'pill.position': '第 {{position}} 位',
      'command.open': '打开协作面板',
      'command.description': '只读：资源租约 / 未闭环交接 / 受保护目标队列',
      'command.group': 'Collab',
      'header.counts': '持有 {{held}} · 排队 {{waiting}} · 待受保护 {{protected}} · 宿主排队 {{host}}',
      'header.title': '协作状态 — 打开面板',
      'header.unreachable': 'collab: n/a',
      'row.copyHint': '点击复制会话 id',
      'row.jumpHint': '点击打开该会话',
      'row.copied': '已复制会话 id',
      'row.copyFailed': '复制会话 id 失败',
      'row.jumpFailed': '无法打开该会话',
      'titlebar.title': '协作状态 — 打开面板',
      'probe.title': 'Collab GUI 已加载',
      'probe.description': '插件 v{{version}} · id={{id}} · panel={{panel}} · app={{app}}({{platform}}) · server={{server}}',
      'panel.source': '数据来自该服务器',
      'panel.workspaceGone': '该工作区已不在快照中',
      'graph.title': '关系图',
      'graph.empty': '没有可画的关系。',
      'graph.legend': '{{level}} · 点节点选中 · ▸/▾ 折叠一跳 · 最多 {{max}} 个节点',
      'graph.hint': '滚轮缩放 · 拖拽平移 · 双击复位',
      'graph.truncated': '另有 {{count}} 个节点未显示',
      'graph.level.global': '全局',
      'graph.level.workspace': '工作区',
      'graph.level.session': '会话',
      'action.rowTitle': '动作（每次点击都会先确认）',
      'action.escalate': '加急',
      'action.freeze': '冻结',
      'action.unfreeze': '解冻',
      'action.archive': '归档',
      'action.armed': '再点一次：',
      'action.running': '执行中…',
      'action.armHint': '该窗口没有确认对话框：再点同一个按钮即执行（此前未写入任何内容）。',
      'action.escalateReasonTitle': '加急理由',
      'action.escalateReasonDesc': '一句话（≤200 字）。取消则不投递。',
      'action.escalatePlaceholder': '如：store.ts 先别动，等 schema 线确认',
      'action.escalateDefaultReason': '看板加急',
      'action.escalateConfirm': '加急 {{sid}}？',
      'action.freezeConfirm': '冻结 {{sid}}？',
      'action.freezeDesc': '默认 30 分钟，到期自动失效；期间新的交接 / 加急会被拒绝。',
      'action.freezeDefaultReason': '看板冻结（30 分钟）',
      'action.unfreezeConfirm': '解冻 {{sid}}？',
      'action.unfreezeDesc': '解冻后新建协作立即可用（不通知任何人）。',
      'action.archiveConfirm': '归档 {{sid}}？',
      'action.archiveDesc': '归档 ≠ 删除：会话与消息都保留，restore 可恢复。',
      'action.done': '{{action}}完成',
      'action.failed': '{{action}}失败'
    }
  },

  setup(ctx) {
    ctx.add(Style, CSS);

    // One store per window (and per plugin load): the panel and the pill read it.
    const store = (sharedStore = createSnapshotStore(ctx));
    onCleanup(() => store.dispose());

    // 0.5.2 (R2): the visibility probe. With no routed session there is nothing
    // to open, so the click answers the question the panel cannot: *did this
    // window load the plugin at all?* A toast means yes (and the problem is only
    // "nothing to open yet"); no toast means the GUI never loaded. Read-only —
    // it shows a toast and nothing else (R4).
    const probeToast = (): void => {
      // 0.5.3 (R3): name the server the numbers would come from. With no routed
      // session the source is the window's own client (the app's sidecar), so
      // the honest answer is "this computer", not an invented id.
      const server = ctx.sessions.current()?.server;
      ctx.toast.show({
        title: ctx.t('probe.title'),
        description: ctx.t('probe.description', {
          version: PLUGIN_VERSION,
          id: ctx.id,
          panel: `${ctx.id}:${PANEL_TAB}`,
          app: ctx.app.version,
          platform: ctx.app.platform,
          server: !server || server.local ? LOCAL_SERVER : server.id
        }),
        variant: 'success'
      });
    };

    // One poller for the whole window, run by hand instead of keyed on
    // `document.hidden`: that read is not reactive, so a window that mounted
    // hidden never started and a hidden window kept its timer alive. `start`
    // loads at once and then ticks; `stop` only clears the timer.
    let timer: ReturnType<typeof setInterval> | undefined;
    const startedPolling = (): boolean => timer !== undefined;
    const startPolling = (): void => {
      if (timer || pageHidden() || ctx.sessions.list().length === 0) return;
      void store.load();
      timer = setInterval(() => void store.load(), POLL_MS);
    };
    const stopPolling = (): void => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    };

    // 0.5.3 (R2): keyed on the **source**, not just the session id: a session of
    // another server is another set of rows, and `queue` is per-requester, so a
    // switch must reload at once instead of showing another server's numbers
    // until the next tick.
    createKeyed(
      () => {
        if (ctx.sessions.list().length === 0) return false;
        return sourceFor(ctx).key;
      },
      () => {
        stopPolling();
        startPolling();
        onCleanup(stopPolling);
      }
    );

    // Visibility: hide stops the poll, show resumes it with whatever session is
    // routed now. Registered on `document`; a window without one is always
    // "visible" (the plugin still works in a test host).
    {
      const doc = (globalThis as { document?: { addEventListener?: unknown; removeEventListener?: unknown } })
        .document;
      const listen = doc?.addEventListener as ((...args: unknown[]) => void) | undefined;
      const unlisten = doc?.removeEventListener as ((...args: unknown[]) => void) | undefined;
      const onChange = (): void => {
        if (pageHidden()) stopPolling();
        else if (!startedPolling()) startPolling();
      };
      listen?.call(doc, 'visibilitychange', onChange);
      onCleanup(() => unlisten?.call(doc, 'visibilitychange', onChange));
    }
    onCleanup(stopPolling);

    const tab: PanelTab = {
      id: PANEL_TAB,
      get title() {
        return ctx.t('panel.title');
      },
      closable: 'compact',
      fallback: true
    };

    // 0.4.2 (R2): the side panel is visible by default — `list` returns the tab
    // even before anything was opened. Before this, the first `layout.state`
    // read `undefined`, `list` saw "not open" and the + menu saw "already open"
    // (see `opened` below): no tab, no entry, the panel could never be opened.
    // `autoOpen:false` restores the old opt-in behaviour (only the + menu).
    const autoOpen = ctx.options?.autoOpen !== false;

    ctx.add(Panel, {
      id: 'collab',
      region: 'side',
      width: 'narrow',
      mobile: {
        get title() {
          return ctx.t('panel.title');
        },
        order: 60,
        kind: 'menu',
        icon: 'lock'
      },
      list: input => (autoOpen || input.open.includes(PANEL_TAB) ? [tab] : []),
      render: props => <PanelView session={props.session} />
    });

    // Discovery: the + menu's launcher, so the panel can be opened by hand and
    // reappears after it was closed. `opened` must be an explicit "open": a
    // first visit has no state (`undefined`), which is *not* the same as open.
    ctx.add(MenuItem, (): MenuItem => {
      const session = ctx.sessions.current();
      return {
        menu: 'session.panel',
        id: 'open',
        title: ctx.t('panel.open'),
        icon: 'lock',
        opened: !!session && ctx.layout.state(`${ctx.id}:${PANEL_TAB}`, session) === 'open',
        run: () => {
          const current = ctx.sessions.current();
          if (current) ctx.layout.open(`${ctx.id}:${PANEL_TAB}`, current, { background: true });
        }
      };
    });

    // R1 (0.5.1): the panel had a + menu entry and an auto-open tab, but nothing
    // in the command palette and no shortcut — a user whose side region was
    // closed had no way to look. One read-only command: it only *opens* the
    // panel (R5). The host publishes it as `collab.open`, so it shows up in the
    // palette and in Settings → Shortcuts; `enabled` follows the routed session.
    ctx.add(Command, (): Command => ({
      id: 'open',
      title: ctx.t('command.open'),
      description: ctx.t('command.description'),
      keywords: 'collab lease lock handoff queue 协作 租约 交接 队列',
      group: ctx.t('command.group'),
      section: 'navigation',
      bind: 'mod+shift+l',
      slash: { name: 'collab' },
      enabled: !!ctx.sessions.current(),
      run: () => {
        const session = ctx.sessions.current();
        if (session) {
          ctx.layout.open(`${ctx.id}:${PANEL_TAB}`, session);
          return;
        }
        // R3 (0.5.2): the palette can still race the router (no session yet, or
        // the last one just closed). Same probe toast as the titlebar pill, so
        // the two entry points can never drift apart.
        probeToast();
      }
    }));

    // R2 (0.5.2): a permanent pill in the titlebar — visible before any panel is
    // opened, and also in a window with no session routed (where the header slot
    // has no place to render). No snapshot yet reads `collab`, never `collab 0`:
    // "not asked yet" is not "nothing is held".
    ctx.add(TitlebarItem, (): TitlebarItem => {
      const data = store.state.data;
      const counts = data ? data.locks.length + data.handoffs.length + (data.queue?.length ?? 0) : 0;
      return {
        id: 'status',
        label: data ? `collab ${counts}` : 'collab',
        title: ctx.t('titlebar.title'),
        icon: 'lock',
        run: () => {
          const session = ctx.sessions.current();
          if (session) {
            ctx.layout.open(`${ctx.id}:${PANEL_TAB}`, session);
            return;
          }
          probeToast();
        }
      };
    });

    // R2 (0.5.1): a permanent, quiet presence in the session header. It shares
    // the panel's store (one poll for the whole window) and only ever opens the
    // panel; with nothing to report it renders nothing at all.
    ctx.add(Slot, {
      at: 'session.header',
      order: 20,
      render: input => <HeaderCounts session={input.session} />
    });

    // Composer pill: this session's own leases and queue places (R3). Read-only —
    // the rows show state, they do not release anything (R5).
    ctx.add(ComposerPill, {
      id: 'collab',
      order: 20,
      show: (input): ComposerPillView | undefined => {
        const snapshot = store.state.data;
        if (!snapshot) return undefined;
        const sid = input.session.id;
        const held = snapshot.locks.filter(lock => lock.holders.includes(sid));
        const waiting = snapshot.locks.filter(lock => lock.waiting.includes(sid));
        if (!held.length && !waiting.length) return undefined;
        const place = (lock: SnapshotLock) => lock.waiting.indexOf(sid) + 1;
        const position = waiting.reduce((best, lock) => {
          const index = place(lock);
          return index > 0 && (best === 0 || index < best) ? index : best;
        }, 0);
        const tone = !waiting.length ? 'success' : position <= 1 ? 'warning' : 'danger';
        const label = [
          held.length ? ctx.plural('pill.held', held.length) : '',
          waiting.length ? ctx.plural('pill.waiting', waiting.length) : ''
        ]
          .filter(Boolean)
          .join(' · ');
        return {
          icon: 'lock',
          tone,
          label,
          title: ctx.t('pill.title'),
          rows: [
            ...held.map(lock => ({
              id: `held:${lock.resource}`,
              label: lock.resource,
              icon: 'lock' as const,
              tone: 'success' as const,
              detail: ctx.t('pill.remaining', { ttl: fmtTtl(lock.expiresInMs) })
            })),
            ...waiting.map(lock => ({
              id: `waiting:${lock.resource}`,
              label: lock.resource,
              icon: 'lock' as const,
              tone: (place(lock) <= 1 ? 'warning' : 'danger') as 'warning' | 'danger',
              detail: ctx.t('pill.position', { position: place(lock) })
            }))
          ]
        };
      }
    });
  }
});
