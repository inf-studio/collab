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
 */
import { For, Show, createMemo, onCleanup } from 'solid-js';
import { createStore } from 'solid-js/store';
import {
  ComposerPill,
  MenuItem,
  Panel,
  Plugin,
  Style,
  createKeyed,
  usePlugin,
  type ComposerPillView,
  type Context,
  type PanelTab
} from '@opencode/plugin/gui';
import { CollabState } from './rpc.ts';
import type { Snapshot, SnapshotHandoff, SnapshotLock, SnapshotSession } from './rpc.ts';

/** Two seconds: a lease list changes on human timescales, and this is cheap. */
const POLL_MS = 2000;
const PANEL_TAB = 'main';

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
}

interface SnapshotStore {
  readonly state: SnapshotState;
  load(): Promise<void>;
  dispose(): void;
}

/**
 * The store is created once per window, in `setup`, and shared by the panel and
 * the pill: one RPC per tick, not one per contribution.
 */
function createSnapshotStore(ctx: Context): SnapshotStore {
  const [state, setState] = createStore<SnapshotState>({ at: 0, loading: true });
  let inFlight = false;
  let disposed = false;

  const load = async (): Promise<void> => {
    if (disposed || inFlight) return;
    inFlight = true;
    try {
      // Read `ctx.client` here, not when the store is built: the desktop app
      // replaces it when its server restarts.
      const reply = await ctx.client.rpc(CollabState).snapshot({});
      if (disposed) return;
      const next = reply as Snapshot | undefined;
      if (!next || typeof next !== 'object') throw new Error('empty snapshot');
      setState({ at: Number(next.at) || Date.now(), data: next, error: undefined, loading: false });
    } catch (error) {
      if (disposed) return;
      // Keep the last snapshot: a blip shows the stale rows *and* the banner,
      // which is more honest than replacing data with an error screen.
      setState({ error: describe(error), loading: false });
    } finally {
      inFlight = false;
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
.collab-footer{font-size:11px;opacity:.5;border-top:1px solid color-mix(in srgb, currentColor 12%, transparent);padding-top:8px;}
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

  return (
    <div class="collab-panel">
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
      'pill.position': 'queue #{{position}}'
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
      'pill.position': '第 {{position}} 位'
    }
  },

  setup(ctx) {
    ctx.add(Style, CSS);
    // One store per window (and per plugin load): the panel and the pill read it.
    const store = (sharedStore = createSnapshotStore(ctx));
    onCleanup(() => store.dispose());

    // One poller for the whole window. It follows "a session is mounted", which
    // is exactly when a composer — and so the pill — exists and when the panel
    // can be on screen; `pageHidden()` skips polling when the panel mounts in a hidden window (no
    // background. `createKeyed` gives the run an owner, so the timer ends when
    // the condition stops holding and when the plugin goes away.
    createKeyed(
      () => !pageHidden() && ctx.sessions.list().length > 0,
      () => {
        void store.load();
        const timer = setInterval(() => void store.load(), POLL_MS);
        onCleanup(() => clearInterval(timer));
      }
    );

    const tab: PanelTab = {
      id: PANEL_TAB,
      get title() {
        return ctx.t('panel.title');
      },
      closable: 'compact',
      fallback: true
    };

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
      list: input => (input.open.includes(PANEL_TAB) ? [tab] : []),
      render: props => <PanelView session={props.session} />
    });

    // Discovery: the + menu's launcher, so the panel can be opened by hand and
    // reappears after it was closed.
    ctx.add(MenuItem, (): MenuItem => {
      const session = ctx.sessions.current();
      return {
        menu: 'session.panel',
        id: 'open',
        title: ctx.t('panel.open'),
        icon: 'lock',
        opened: !!session && ctx.layout.state(`${ctx.id}:${PANEL_TAB}`, session) !== 'closed',
        run: () => {
          const current = ctx.sessions.current();
          if (current) ctx.layout.open(`${ctx.id}:${PANEL_TAB}`, current, { background: true });
        }
      };
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
