/**
 * C2 (0.3.0): the desktop sidebar — `./gui-experimental`.
 *
 * A **read-only** view of the same state the tools expose: who holds a
 * resource, who is queued behind it, which hand-off is still open. It owns no
 * state of its own; every number comes from `collab.state.snapshot` (the RPC in
 * `src/rpc.ts`, implemented in `src/index.ts`), which reads what `collab_locks`
 * and `collab_list` read.
 *
 * Deliberate choices:
 *   - **No `main`**: only `setup` (the window half). Nothing here needs Electron
 *     or Node, so the bundle stays free of both and of their placeholders.
 *   - **No write path**: the panel has no lock/release button (R5). Leasing stays
 *     with the tools and the skills; a mis-click in a status pane must never
 *     change what another session can do.
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
import { For, Show, createMemo, onCleanup } from 'solid-js';
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
import type { Snapshot, SnapshotHandoff, SnapshotLock, SnapshotSession } from './rpc.ts';

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
const PLUGIN_VERSION = '0.5.3';

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

interface WorkspaceGroup {
  dir: string;
  sessions: SnapshotSession[];
  locks: SnapshotLock[];
  handoffs: SnapshotHandoff[];
}

/**
 * Group one snapshot by workspace. Sessions carry their own directory; a lease
 * has none (leases are global), so it is filed under the workspace of the first
 * holder that is a listed session — and under the global group when nobody
 * listed holds it (e.g. a lease of a session the host did not return).
 */
function groupByWorkspace(snapshot: Snapshot): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>();
  const group = (dir: string): WorkspaceGroup => {
    let entry = groups.get(dir);
    if (!entry) {
      entry = { dir, sessions: [], locks: [], handoffs: [] };
      groups.set(dir, entry);
    }
    return entry;
  };

  const dirOf = new Map<string, string>();
  for (const session of snapshot.sessions) {
    dirOf.set(session.sid, session.workspace || '');
    group(session.workspace || '').sessions.push(session);
  }
  for (const lock of snapshot.locks) {
    const owner = [...lock.holders, ...lock.waiting].map(sid => dirOf.get(sid)).find(dir => dir !== undefined);
    group(owner ?? '').locks.push(lock);
  }
  for (const handoff of snapshot.handoffs) {
    group(handoff.workspace || '').handoffs.push(handoff);
  }
  return [...groups.values()]
    .filter(entry => entry.sessions.length || entry.locks.length || entry.handoffs.length)
    .sort((left, right) => left.dir.localeCompare(right.dir));
}

/* --------------------------------------------------------------------------- css */

const CSS = `
.collab-panel{display:flex;flex-direction:column;gap:14px;height:100%;overflow:auto;padding:10px 12px;font-size:12px;line-height:1.45;color:inherit;}
.collab-group{display:flex;flex-direction:column;gap:4px;}
.collab-group + .collab-group{border-top:1px solid color-mix(in srgb, currentColor 12%, transparent);padding-top:10px;}
.collab-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-weight:600;}
.collab-head-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.collab-sub{font-size:11px;font-weight:600;opacity:.55;margin-top:6px;}
.collab-row{display:flex;align-items:baseline;gap:6px;min-width:0;}
.collab-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.collab-mono{font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;}
.collab-muted{opacity:.6;}
.collab-badge{flex:none;border-radius:999px;padding:0 6px;font-size:10px;line-height:16px;background:color-mix(in srgb, currentColor 10%, transparent);}
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
`;

/* ----------------------------------------------------------------------- rows */

function SessionRow(props: { session: SnapshotSession; current: string }) {
  const ctx = usePlugin();
  return (
    <div class="collab-row" title={props.session.sid}>
      <span class={`collab-dot${props.session.busy ? ' collab-dot-busy' : ''}`} />
      <span class="collab-mono collab-muted">{shortSid(props.session.sid)}</span>
      <span class="collab-badge">{props.session.agent}</span>
      <span class="collab-row-title">{props.session.title}</span>
      <Show when={props.session.sid === props.current}>
        <span class="collab-badge collab-tone-success">{ctx.t('panel.current')}</span>
      </Show>
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
      <span class="collab-muted">{fmtTtl(props.handoff.ageMs)}</span>
      <span class="collab-row-title collab-muted">{props.handoff.title}</span>
    </div>
  );
}

function GroupView(props: { group: WorkspaceGroup; current: string }) {
  const ctx = usePlugin();
  const label = () => workspaceLabel(props.group.dir) || ctx.t('panel.global');
  return (
    <section class="collab-group">
      <header class="collab-head">
        <span class="collab-head-label" title={props.group.dir || undefined}>
          {label()}
        </span>
        <span class="collab-muted">
          {props.group.sessions.length ? ctx.plural('panel.sessions', props.group.sessions.length) : ''}
        </span>
      </header>
      <For each={props.group.sessions}>{session => <SessionRow session={session} current={props.current} />}</For>
      <Show when={props.group.locks.length}>
        <div class="collab-sub">{ctx.t('panel.locks')}</div>
        <For each={props.group.locks}>{lock => <LockRow lock={lock} current={props.current} />}</For>
      </Show>
      <Show when={props.group.handoffs.length}>
        <div class="collab-sub">{ctx.t('panel.handoffs')}</div>
        <For each={props.group.handoffs}>{handoff => <HandoffRow handoff={handoff} />}</For>
      </Show>
    </section>
  );
}

/** The side panel's content. Reads `props.session` as a getter, never destructured. */
function PanelView(props: { session: { id: string } }) {
  const ctx = usePlugin();
  const store = storeFor(ctx);
  const groups = createMemo(() => (store.state.data ? groupByWorkspace(store.state.data) : []));

  // 0.5.3 (R3): name the server the rows came from — remote only. The app's own
  // server is the default and would be noise (`@sidecar` on every window).
  const sourceLabel = (): string => {
    const server = ctx.sessions.current()?.server;
    if (server?.local === true || !store.state.source?.server) return '';
    return `@${store.state.source.server}`;
  };

  return (
    <div class="collab-panel">
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
      <Show
        when={store.state.data}
        fallback={
          <Show when={!store.state.error}>
            <div class="collab-empty">{store.state.loading ? ctx.t('panel.loading') : ctx.t('panel.empty')}</div>
          </Show>
        }
      >
        <Show when={groups().length} fallback={<div class="collab-empty">{ctx.t('panel.empty')}</div>}>
          <For each={groups()}>{group => <GroupView group={group} current={props.session.id} />}</For>
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
 * R2 (0.5.1): the always-visible entry point. One muted line in the session
 * header carries the same three numbers as the panel, read from the same
 * `sharedStore` — no second RPC stream, no second timer.
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
    return ctx.t('header.counts', {
      locks: String(data.locks.length),
      handoffs: String(data.handoffs.length),
      queue: String(data.queue?.length ?? 0)
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
      'panel.remaining': 'left {{ttl}}',
      'panel.updated': 'updated {{time}}',
      'panel.readonly': 'read-only',
      'panel.sessions.one': '{{count}} session',
      'panel.sessions.other': '{{count}} sessions',
      'panel.waiting.one': '{{count}} waiting',
      'panel.waiting.other': '{{count}} waiting',
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
      'header.counts': '{{locks}} locks · {{handoffs}} hand-offs · {{queue}} queue',
      'header.title': 'Collab status — open the panel',
      'header.unreachable': 'collab: n/a',
      'titlebar.title': 'Collab status — open the panel',
      'probe.title': 'Collab GUI loaded',
      'probe.description': 'plugin v{{version}} · id={{id}} · panel={{panel}} · app={{app}}({{platform}}) · server={{server}}',
      'panel.source': 'Rows come from this server'
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
      'panel.remaining': '剩余 {{ttl}}',
      'panel.updated': '更新于 {{time}}',
      'panel.readonly': '只读',
      'panel.sessions.other': '{{count}} 个会话',
      'panel.waiting.other': '等待 {{count}}',
      'pill.title': '协作资源',
      'pill.held.other': '锁 {{count}}',
      'pill.waiting.other': '等待 {{count}}',
      'pill.remaining': '剩余 {{ttl}}',
      'pill.position': '第 {{position}} 位',
      'command.open': '打开协作面板',
      'command.description': '只读：资源租约 / 未闭环交接 / 受保护目标队列',
      'command.group': 'Collab',
      'header.counts': '锁 {{locks}} · 交接 {{handoffs}} · 队列 {{queue}}',
      'header.title': '协作状态 — 打开面板',
      'header.unreachable': 'collab: n/a',
      'titlebar.title': '协作状态 — 打开面板',
      'probe.title': 'Collab GUI 已加载',
      'probe.description': '插件 v{{version}} · id={{id}} · panel={{panel}} · app={{app}}({{platform}}) · server={{server}}',
      'panel.source': '数据来自该服务器'
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
