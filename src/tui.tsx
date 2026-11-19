/** @jsxImportSource @opentui/solid */
/**
 * 0.4.2 (R4–R7): the **TUI** half of the read-only status view.
 *
 * The same three questions the desktop sidebar answers — who holds a resource,
 * which hand-offs are open, what did *I* queue for a protected session — asked
 * from the terminal. Two surfaces, both contributions to the host's slot tree:
 *
 *   - `session.panel` → the `collab.status` panel (`/collab`, `ctrl+shift+l`);
 *   - `sidebar.content` → one summary line — 0.6.0: the four numbers
 *     `锁 N · 排 M · 待 K · 宿 J` (held / waiting / for-protected / host queue) —
 *     that 0.5.1 made *clickable*: a click expands up to four detail rows, a
 *     click on a row opens the panel, a click on the summary line collapses it.
 *
 * Deliberate choices:
 *   - **No state of its own**: every number comes from `collab.state.snapshot`
 *     (the RPC in `src/rpc.ts`, implemented in `src/index.ts`), which reads what
 *     `collab_locks` / `collab_list` read. The TUI client can reach a *remote*
 *     server, so the panel still works when the terminal is not the server.
 *   - **No write path** (R7): no lock/release button, no queue action. The panel
 *     renders rows; changing collaboration state stays with the tools. The
 *     sidebar's only action is `panel.open` (R5 of 0.5.1).
 *   - **Poll only while open** (R7): the 2 s timer is created inside the effect
 *     that reads `panel.name`, so the host's own dispose (panel closed, another
 *     plugin's panel selected, plugin disabled) clears it. The sidebar line
 *     refreshes once per mount instead of keeping a second timer alive; expanding
 *     it renders more lines from the same snapshot and polls nothing (R3).
 *   - **Failure is local** (R6): a rejected RPC keeps the last snapshot and adds
 *     a banner; with no snapshot at all the panel falls back to the host's own
 *     session list plus an explicit "unreachable" line — never a blank pane, and
 *     never a crash of the TUI.
 *   - **Lines, not nested slots**: OpenTUI's reconciler throws on a bare text
 *     node inside a `box` ("Orphan text error"), and Solid's universal renderer
 *     turns `undefined` (an empty `<Show>`) into exactly that `""`. So the body
 *     is one flat list of `<text>` lines and conditionals are lists, not
 *     `<Show>`: an empty list inserts nothing at all.
 */
import { For, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { createStore } from 'solid-js/store';
import { Plugin, usePlugin } from '@opencode/plugin/tui';
import type { Context, PanelInput } from '@opencode/plugin/tui/context';
import { CollabState } from './rpc.ts';
import type { Snapshot, SnapshotHandoff, SnapshotLock, SnapshotQueueItem, SnapshotSession } from './rpc.ts';
import { countsOf, pendingCountOf } from './core/counts.ts';

/** Two seconds: a lease list changes on human timescales, and this is cheap. */
const POLL_MS = 2000;
/** The panel name this plugin owns (`collab.status`, plugin-prefixed per the API). */
const PANEL = 'collab.status';
/** Fallback width when a host does not report the panel width. */
const FALLBACK_WIDTH = 80;
/** R3 (0.5.1): how many detail rows the sidebar's expanded form shows before `+N`. */
const DETAIL_LIMIT = 4;
/** The one message for "there is no session to put the panel in" (keymap and sidebar). */
const NO_SESSION = '先打开一个会话，再看 collab 状态';

/* ------------------------------------------------------------------ formatting */

function fmtAge(ms: number): string {
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

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return text.length > 160 ? `${text.slice(0, 159)}…` : text || 'unknown error';
}

/* ---------------------------------------------------------------------- table */

type Tone = 'base' | 'muted' | 'success' | 'warning' | 'danger';

/** One rendered line: the panel body is a flat list of these (see the header). */
interface Line {
  text: string;
  tone: Tone;
}

/** One cell: cut to `width`, with an ellipsis when it had to be cut. */
function clip(value: string, width: number): string {
  const text = String(value ?? '');
  if (width <= 1) return '';
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function pad(value: string, width: number): string {
  const text = clip(value, width);
  return `${text}${' '.repeat(Math.max(0, width - text.length))}`;
}

/**
 * Rows are plain monospace text, padded by code: the panel is a status view, and
 * a table whose columns hold still is worth more than nested layout boxes that
 * change shape with the host's renderer version.
 */
function tableRow(cells: Array<[value: string, width: number]>): string {
  return cells.map(([value, width]) => pad(value, width)).join(' ').trimEnd();
}

/* --------------------------------------------------------------------- colours */

/**
 * Theme tokens from `context.theme` (`@opencode/theme/tui`): `text.base`,
 * `text.muted` and the `text.feedback.*` pair. Read defensively — a host whose
 * theme is older or thinner falls back to plain text instead of throwing inside
 * a slot render (which would take the panel down with it).
 */
function color(ctx: Context, tone: Tone): any {
  const text = (ctx as { theme?: any }).theme?.text;
  const feedback = text?.feedback;
  if (tone === 'success') return feedback?.success?.base ?? text?.base;
  if (tone === 'warning') return feedback?.warning?.base ?? text?.base;
  if (tone === 'danger') return feedback?.error?.base ?? text?.base;
  if (tone === 'muted') return text?.muted ?? text?.base;
  return text?.base;
}

/* -------------------------------------------------------------------- snapshot */

interface TuiState {
  at: number;
  data?: Snapshot;
  error?: string;
  loading: boolean;
}

interface SnapshotStore {
  readonly state: TuiState;
  /** Point the queue filter at a session (the panel's / sidebar's session). */
  watch(sessionId?: string): void;
  load(): Promise<void>;
  dispose(): void;
}

function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Tolerate an older server: a snapshot without `queue` (0.4.1) is still a
 * usable snapshot, so the blocks are defaulted here instead of crashing `For`.
 */
function normalize(reply: unknown, now: number): Snapshot {
  const value = (reply ?? {}) as Partial<Snapshot>;
  if (!value || typeof value !== 'object') throw new Error('empty snapshot');
  return {
    at: Number(value.at) || now,
    sessions: arrayOf<SnapshotSession>(value.sessions),
    locks: arrayOf<SnapshotLock>(value.locks),
    handoffs: arrayOf<SnapshotHandoff>(value.handoffs),
    queue: arrayOf<SnapshotQueueItem>(value.queue),
    reachable: true
  };
}

/** `context.client.rpc(definition)` — absent on a host without the typed client. */
function rpcDomain(ctx: Context): { snapshot?: (input: unknown) => Promise<unknown> } {
  const client = ctx.client as unknown as {
    rpc?: (definition: unknown) => { snapshot?: (input: unknown) => Promise<unknown> };
  };
  if (!client || typeof client.rpc !== 'function') throw new Error('host client has no rpc()');
  const domain = client.rpc(CollabState);
  if (!domain || typeof domain.snapshot !== 'function') throw new Error('collab.state.snapshot is not available');
  return domain;
}

function createSnapshotStore(getCtx: () => Context): SnapshotStore {
  const [state, setState] = createStore<TuiState>({ at: 0, loading: true });
  let inFlight = false;
  let disposed = false;
  // Plain variable, not store state: `load` runs from effects and timers, and a
  // tracked read here would make the caller's effect re-run on every set.
  let me: string | undefined;

  const load = async (): Promise<void> => {
    if (disposed || inFlight) return;
    inFlight = true;
    try {
      // Read `ctx` here, not when the store is built: the TUI replaces its
      // client when the server restarts, and the location can change.
      const ctx = getCtx();
      const input: Record<string, string> = {};
      const workspace = String((ctx.location as { directory?: string } | undefined)?.directory ?? '').trim();
      if (workspace) input.workspace = workspace;
      if (me) input.session = me;
      const reply = await rpcDomain(ctx).snapshot!(input);
      if (disposed) return;
      const next = normalize(reply, Date.now());
      setState({ at: next.at, data: next, error: undefined, loading: false });
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
    watch(sessionId) {
      const next = String(sessionId ?? '').trim();
      if (next) me = next;
    },
    load,
    dispose() {
      disposed = true;
    }
  };
}

let sharedStore: SnapshotStore | undefined;

function storeFor(ctx: Context): SnapshotStore {
  sharedStore ??= createSnapshotStore(() => ctx);
  return sharedStore;
}

/* ------------------------------------------------------- fallback: session list */

interface FallbackSession {
  sid: string;
  title: string;
  agent: string;
  busy: boolean;
}

/**
 * R6 fallback: the host's own session list, which the TUI already caches, so an
 * unreachable server still shows *something* real (who is running) instead of an
 * empty pane. Never throws — a host without the API simply lists nothing.
 */
function fallbackSessions(ctx: Context): FallbackSession[] {
  let listed: unknown[] = [];
  try {
    listed = arrayOf<unknown>(ctx.data.session.list());
  } catch {
    return [];
  }
  const out: FallbackSession[] = [];
  for (const entry of listed) {
    const info = (entry ?? {}) as Record<string, any>;
    const sid = String(info.id ?? '');
    if (!sid) continue;
    let busy = false;
    try {
      busy = ctx.data.session.status(sid) === 'running';
    } catch {
      busy = false;
    }
    out.push({ sid, title: String(info.title ?? '(untitled)'), agent: String(info.agent ?? '?'), busy });
  }
  return out.sort((left, right) => Number(right.busy) - Number(left.busy) || left.sid.localeCompare(right.sid));
}

/* ------------------------------------------------------------------ panel body */

function leaseTone(lock: SnapshotLock, me: string): Tone {
  if (lock.holders.includes(me) || lock.waiting.includes(me)) return 'success';
  if (!lock.holders.length) return lock.waiters > 0 ? 'warning' : 'muted';
  return lock.mode === 'shared' ? 'warning' : 'danger';
}

function leaseLines(locks: SnapshotLock[], width: number, me: string): Line[] {
  const narrow = width < 48;
  const header = narrow
    ? 'RESOURCE'
    : tableRow([
        ['RESOURCE', Math.max(10, width - 30)],
        ['MODE', 9],
        ['HOLDERS', 12],
        ['TTL', 7],
        ['WAIT', 4]
      ]);
  const out: Line[] = [{ text: header, tone: 'muted' }];
  for (const lock of locks) {
    const holders = lock.holders.length ? lock.holders.map(shortSid).join(',') : 'free';
    const ttl = lock.expiresInMs ? fmtAge(lock.expiresInMs) : '-';
    const wait = String(lock.waiters || 0);
    const text = narrow
      ? `${clip(lock.resource, width)}\n  ${clip(`${lock.mode} ${holders} · ${ttl} · 排队 ${wait}`, width - 2)}`
      : tableRow([
          [lock.resource, Math.max(10, width - 30)],
          [lock.mode, 9],
          [holders, 12],
          [ttl, 7],
          [wait, 4]
        ]);
    out.push({ text, tone: leaseTone(lock, me) });
  }
  return out;
}

function handoffLines(handoffs: SnapshotHandoff[], width: number): Line[] {
  const narrow = width < 48;
  const header = narrow
    ? 'BID'
    : tableRow([
        ['BID', 16],
        ['STATE', 9],
        ['AGE', 8],
        ['FROM', Math.max(6, width - 35)]
      ]);
  const out: Line[] = [{ text: header, tone: 'muted' }];
  for (const handoff of handoffs) {
    const from = shortSid(handoff.from);
    const age = fmtAge(handoff.ageMs);
    const text = narrow
      ? `${clip(handoff.bid, width)}\n  ${clip(`${handoff.state} · ${age} · ${from}`, width - 2)}`
      : tableRow([
          [handoff.bid, 16],
          [handoff.state, 9],
          [age, 8],
          [from, Math.max(6, width - 35)]
        ]);
    // `open` = nobody has taken it yet; that is the row worth noticing.
    out.push({ text, tone: handoff.state === 'open' ? 'warning' : 'base' });
  }
  return out;
}

function queueLines(queue: SnapshotQueueItem[], width: number): Line[] {
  const narrow = width < 48;
  const header = narrow
    ? 'QUEUE'
    : tableRow([
        ['QUEUEID', 18],
        ['TARGET', 20],
        ['AGE', 8],
        ['STATUS', Math.max(6, width - 48)]
      ]);
  const out: Line[] = [{ text: header, tone: 'muted' }];
  for (const item of queue) {
    const target = shortSid(item.target);
    const age = fmtAge(item.ageMs);
    const status = item.seen ? 'seen' : 'pending';
    const text = narrow
      ? `${clip(item.queueId, width)}\n  ${clip(`${target} · ${age} · ${status}`, width - 2)}`
      : tableRow([
          [item.queueId, 18],
          [target, 20],
          [age, 8],
          [status, Math.max(6, width - 48)]
        ]);
    out.push({ text, tone: item.seen ? 'muted' : 'base' });
  }
  return out;
}

/**
 * The whole panel as lines. Reading `panel.name` here (and in the caller's memo)
 * keeps it reactive: switching to another plugin's panel empties the list, and
 * the effect that owns the poll is cleaned up in the same pass.
 *
 * 0.6.0 (R4): the second line is the four-number summary
 * (`持有 · 排队 · 待受保护 · 宿主排队`) plus a one-line legend — the same
 * vocabulary as the GUI header and the sidebar, so `锁 N` can no longer be read
 * as "N holders" (it used to be `locks.length`, i.e. rows worth showing).
 */
function panelLines(
  state: TuiState,
  panel: PanelInput,
  sessions: FallbackSession[],
  hostPending: number
): Line[] {
  if (panel.name !== PANEL) return [];
  const width = Math.max(24, Number(panel.width) || FALLBACK_WIDTH);
  const data = state.data;
  const out: Line[] = [];
  const push = (text: string, tone: Tone = 'base') => out.push({ text, tone });
  const pending = (label: string) => `  ${data ? label : state.loading ? '加载中…' : '（不可达）'}`;

  push(`Collab · ${shortSid(panel.sessionID)} · ${fmtClock(state.at)}`);
  if (data) {
    const counts = countsOf(data);
    push(
      `持有 ${counts.held} · 排队 ${counts.waiting} · 待受保护 ${counts.protected} · 宿主排队 ${hostPending}`,
      counts.held || counts.waiting ? 'base' : 'muted'
    );
    push('图例: 持有=真实持有者 · 排队=FIFO 等候 · 待受保护=我交给受保护会话的请求 · 宿主排队=宿主 prompt 队列', 'muted');
  }
  if (state.error) {
    push(`RPC 不可达：${state.error}`, 'danger');
    push(data ? '（显示上一份快照）' : '（仅显示本地会话列表）', 'muted');
  }

  push(`资源租约 (${data?.locks.length ?? 0})`, 'muted');
  if (data && data.locks.length) out.push(...leaseLines(data.locks, width, panel.sessionID));
  else push(pending('（无租约）'), 'muted');

  push(`未闭环交接 (${data?.handoffs.length ?? 0})`, 'muted');
  if (data && data.handoffs.length) out.push(...handoffLines(data.handoffs, width));
  else push(pending('（无交接）'), 'muted');

  push(`受保护目标队列 (${data?.queue.length ?? 0})`, 'muted');
  if (data && data.queue.length) out.push(...queueLines(data.queue, width));
  else push(pending('（无排队）'), 'muted');

  // R6: no snapshot at all → the host's own session list, clearly labelled.
  if (!data && state.error) {
    push(`会话 (${sessions.length})`, 'muted');
    for (const session of sessions) {
      const title = clip(session.title, Math.max(8, width - 26));
      push(`  ${session.busy ? '●' : '○'} ${shortSid(session.sid)} ${session.agent} ${title}`, session.busy ? 'success' : 'base');
    }
  }

  push(`只读 · 每 ${POLL_MS / 1000}s 刷新 · /collab`, 'muted');
  return out;
}

/* ----------------------------------------------------------------------- panel */

function StatusPanel(props: { panel: PanelInput }) {
  const ctx = usePlugin();
  const store = storeFor(ctx);

  // R7: the poll belongs to "this plugin's panel is the open one". Reading
  // `panel.name` / `panel.sessionID` makes the effect re-run when either
  // changes; its cleanup clears the previous timer, so a closed (or someone
  // else's) panel stops polling immediately.
  createEffect(() => {
    if (props.panel.name !== PANEL) return;
    store.watch(props.panel.sessionID);
    void store.load();
    const timer = setInterval(() => void store.load(), POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  const lines = createMemo(() =>
    panelLines(
      store.state,
      props.panel,
      fallbackSessions(ctx),
      pendingCountOf(ctx.data?.session?.pending, props.panel.sessionID)
    )
  );

  return (
    <box flexDirection="column">
      <For each={lines()}>{line => <text fg={color(ctx, line.tone)}>{line.text}</text>}</For>
    </box>
  );
}

/* --------------------------------------------------------------------- sidebar */

/** One expanded sidebar line: a lease, an open hand-off, or one of my queue places. */
interface SidebarRow {
  text: string;
  tone: Tone;
}

/**
 * R3 (0.5.1): the rows behind the summary, in the order the panel shows them —
 * leases, open hand-offs, my owner-queue places. Derived from the snapshot the
 * panel already reads; no second RPC, no second timer (expanding only renders
 * more lines).
 */
function sidebarRows(data: Snapshot, me: string): SidebarRow[] {
  const rows: SidebarRow[] = [];
  for (const lock of data.locks) {
    const mine = lock.holders.includes(me) || lock.waiting.includes(me);
    const holders = lock.holders.length ? lock.holders.map(shortSid).join(',') : 'free';
    const ttl = lock.expiresInMs ? ` · 剩 ${fmtAge(lock.expiresInMs)}` : '';
    const waited = lock.waiters ? ` · 等 ${lock.waiters}` : '';
    rows.push({
      text: `🔒 ${lock.resource} · ${holders}${mine ? ' (我)' : ''}${ttl}${waited}`,
      tone: leaseTone(lock, me)
    });
  }
  for (const handoff of data.handoffs) {
    rows.push({
      text: `→ ${handoff.bid} · ${handoff.state} · ${fmtAge(handoff.ageMs)} · ${shortSid(handoff.from)}`,
      // `open` = nobody has taken it yet; that is the row worth noticing.
      tone: handoff.state === 'open' ? 'warning' : 'base'
    });
  }
  for (const item of data.queue) {
    rows.push({
      text: `⇢ ${item.queueId} · ${shortSid(item.target)} · ${item.seen ? 'seen' : 'pending'}`,
      tone: item.seen ? 'muted' : 'base'
    });
  }
  return rows;
}

/**
 * R5 (0.4.2) / R3 (0.5.1) / R4 (0.6.0): the sidebar summary. Collapsed it is one
 * line — the four compact numbers `锁 N · 排 M · 待 K · 宿 J` — with a `▸`/`▾`
 * caret; a click on that line expands up to `DETAIL_LIMIT` detail rows (plus
 * `+N`), a click on a detail row opens the full `/collab` panel.
 *
 * Deliberate choices:
 *   - **No extra polling**: the mount effect is the same one load it always had;
 *     expanding only renders lines that come from `store.state.data`.
 *   - **Mouse may be off**: the host decides whether a TUI gets mouse events. The
 *     caret and rows are an addition, never the only way in — `/collab` and
 *     `ctrl+shift+l` stay (R4). A host that pins this slot to one row height
 *     clips the details, which is also handled by the panel.
 *   - **Unreachable stays honest**: with no snapshot the expanded row says
 *     `collab: n/a · 点击打开面板` instead of pretending "no activity".
 */
function SidebarSummary(props: { sessionID: string }) {
  const ctx = usePlugin();
  const store = storeFor(ctx);
  const [expanded, setExpanded] = createSignal(false);

  createEffect(() => {
    store.watch(props.sessionID);
    void store.load();
  });

  const toggle = () => setExpanded(value => !value);

  const openPanel = () => {
    if (!ctx.ui.panel.open(PANEL)) {
      ctx.ui.toast.show({ message: NO_SESSION, variant: 'warning' });
    }
  };

  const line = () => {
    const data = store.state.data;
    if (!data) return store.state.loading ? 'collab: …' : 'collab: n/a';
    // 0.6.0 (R4): the four numbers, compact — 持有 / 排队 / 待受保护 / 宿主排队.
    // `锁 N` used to be `data.locks.length` (rows worth showing, a queued waiter
    // behind a free resource included), which read as "N holders".
    const counts = countsOf(data);
    const host = pendingCountOf(ctx.data?.session?.pending, props.sessionID);
    return `锁 ${counts.held} · 排 ${counts.waiting} · 待 ${counts.protected} · 宿 ${host}`;
  };

  const details = (): SidebarRow[] => {
    const data = store.state.data;
    if (!data) {
      return [{ text: store.state.loading ? 'collab: …' : 'collab: n/a · 点击打开面板', tone: 'muted' }];
    }
    const rows = sidebarRows(data, props.sessionID);
    if (!rows.length) return [{ text: '无协作活动 · 点击打开面板', tone: 'muted' }];
    const shown = rows.slice(0, DETAIL_LIMIT);
    if (rows.length > DETAIL_LIMIT) {
      shown.push({ text: `+${rows.length - DETAIL_LIMIT}`, tone: 'muted' });
    }
    return shown;
  };

  const rows = () => (expanded() ? details() : []);

  return (
    <box flexDirection="column">
      <box onMouseDown={toggle}>
        <text wrapMode="none" fg={color(ctx, store.state.error ? 'danger' : 'muted')}>
          {`${expanded() ? '▾' : '▸'} ${line()}`}
        </text>
      </box>
      <For each={rows()}>
        {row => (
          <box onMouseDown={openPanel}>
            <text wrapMode="none" fg={color(ctx, row.tone)}>
              {`  ${row.text}`}
            </text>
          </box>
        )}
      </For>
    </box>
  );
}

/* ---------------------------------------------------------------------- plugin */

export default Plugin.define({
  id: 'collab.tui',

  setup(ctx) {
    const store = (sharedStore = createSnapshotStore(() => ctx));
    const cleanups: Array<() => void> = [];
    let disposed = false;

    // R4/R5: the panel content and the one-line summary. Both are ordinary slot
    // claims; the host disposes them when the plugin is disabled.
    cleanups.push(
      ctx.ui.slot({
        append: 'session.panel',
        render: (panel: PanelInput) => <StatusPanel panel={panel} />
      })
    );
    cleanups.push(
      ctx.ui.slot({
        append: 'sidebar.content',
        render: input => <SidebarSummary sessionID={input.sessionID} />
      })
    );

    // R4: `/collab`, `ctrl+shift+l`, and the command palette all open the same
    // panel. The host owns the layer's lifetime (removed on deactivate).
    ctx.keymap.layer(() => ({
      mode: 'global',
      commands: [
        {
          id: 'collab.status',
          title: 'Collab 状态面板',
          description: '只读：资源租约 / 未闭环交接 / 受保护目标队列',
          group: 'Collab',
          bind: 'ctrl+shift+l',
          slash: { name: 'collab', aliases: ['collab-status'] },
          palette: true,
          run: () => {
            if (!ctx.ui.panel.open(PANEL)) {
              ctx.ui.toast.show({ message: NO_SESSION, variant: 'warning' });
            }
          }
        }
      ]
    }));

    return () => {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          // A slot already removed by the host is not an error here.
        }
      }
      store.dispose();
    };
  }
});
