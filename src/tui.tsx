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
 *   - **Selection is local** (0.8.0): `j`/`k` select a row and append 3–5
 *     detail lines under the tree, `escape` clears it. The flag is component
 *     memory, so the 2 s poll neither moves the cursor nor drops the detail.
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
import { buildBoard, boardOrphans, type BoardSession, type BoardWorkspace } from './core/board.ts';
import { contractBadgeText, contractSummary } from './core/contract-view.ts';
import { decisionSummaryLine } from './core/decision-view.ts';
import { buildGraph, type GraphEdge, type GraphLevel } from './core/graph.ts';

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
  /** Expandable tree row (mouse + keymap target); absent for a plain line. */
  key?: string;
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
 * A CJK / fullwidth code point takes two terminal cells (the renderer counts
 * cells). The regex is applied to a **grapheme cluster**, not a code point —
 * `clipCells` segments first (0.10.x: emoji used to count as one cell and a
 * `for…of` truncation could cut a ZWJ family in half).
 */
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;
/**
 * Emoji take two cells: pictographs (`🚀`), regional-indicator flags, skin-tone
 * modifiers, the emoji presentation selector and the keycap combiner. A ZWJ
 * sequence (`👨‍👩‍👧‍👦`) renders as **one** 2-cell glyph, so it is measured as a
 * single cluster too.
 */
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{20E3}]/u;

/** Grapheme segmentation when the runtime has it (Node ≥ 16 / every supported shell). */
const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined;

/** The text as user-perceived characters (ZWJ sequences stay whole). */
function graphemes(text: string): string[] {
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), part => part.segment);
}

/** Terminal cells of one grapheme cluster: 0 for nothing, 2 for wide/emoji, else 1. */
function cellWidth(cluster: string): number {
  if (!cluster) return 0;
  if (cluster.includes('\u200d') || EMOJI.test(cluster)) return 2;
  return WIDE.test(cluster) ? 2 : 1;
}

/** `clip`, but measured in **cells**: long CJK / emoji text must not wrap past the panel. */
function clipCells(value: string, width: number): string {
  const text = String(value ?? '');
  if (width <= 1) return '';
  const parts = graphemes(text);
  let used = 0;
  for (const part of parts) used += cellWidth(part);
  if (used <= width) return text;
  let out = '';
  let taken = 0;
  for (const part of parts) {
    const cells = cellWidth(part);
    // Never split a cluster: a truncated ZWJ family / flag is a broken glyph.
    if (taken + cells > width - 1) break;
    out += part;
    taken += cells;
  }
  return `${out}…`;
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
  // 0.9.0 (`11-20-collab-store`, R4): the storage verdict is passed through so
  // the panel can say `[索引不可用]`. Absent (an older server) = no marker.
  const index =
    value.index && typeof value.index === 'object'
      ? {
          available: value.index.available !== false,
          ...(value.index.reason ? { reason: String(value.index.reason) } : {})
        }
      : undefined;
  // 0.9.7 (`11-21-collab-decision-inbox`): the board's optional decision block
  // must survive this normaliser (it is the one place the TUI validates a server
  // reply). Absent (an older server) = no line, exactly as before.
  const decisions =
    value.decisions && typeof value.decisions === 'object' && Array.isArray(value.decisions.items)
      ? value.decisions
      : undefined;
  return {
    at: Number(value.at) || now,
    sessions: arrayOf<SnapshotSession>(value.sessions),
    locks: arrayOf<SnapshotLock>(value.locks),
    handoffs: arrayOf<SnapshotHandoff>(value.handoffs),
    queue: arrayOf<SnapshotQueueItem>(value.queue),
    ...(index ? { index } : {}),
    ...(decisions ? { decisions } : {}),
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
    // 0.6.0 (`collab_escalate`): one marker at the end of the existing row — no
    // column is added and nothing is re-laid-out.
    const urgent = handoff.priority === 'urgent' ? ' [urgent]' : '';
    // 0.6.0 (`collab_freeze`): the same rule — one marker, no layout change.
    const frozen = handoff.freeze ? ` [frozen] ${fmtClock(handoff.freeze.until).slice(0, 5)}` : '';
    // 0.5.0: the spawned session was archived — the row stays, the marker is added.
    const archived = handoff.archived ? ' [archived]' : '';
    const text = narrow
      ? `${clip(handoff.bid, width)}\n  ${clip(`${handoff.state} · ${age} · ${from}${urgent}${frozen}${archived}`, width - 2)}`
      : `${tableRow([
          [handoff.bid, 16],
          [handoff.state, 9],
          [age, 8],
          [from, Math.max(6, width - 35)]
        ])}${urgent}${frozen}${archived}`;
    // `open` = nobody has taken it yet; that is the row worth noticing.
    out.push({
      text,
      tone:
        handoff.priority === 'urgent' || handoff.freeze
          ? 'danger'
          : handoff.state === 'open'
            ? 'warning'
            : 'base'
    });
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
    const urgent = item.priority === 'urgent' ? ' [urgent]' : '';
    const text = narrow
      ? `${clip(item.queueId, width)}\n  ${clip(`${target} · ${age} · ${status}${urgent}`, width - 2)}`
      : `${tableRow([
          [item.queueId, 18],
          [target, 20],
          [age, 8],
          [status, Math.max(6, width - 48)]
        ])}${urgent}`;
    out.push({ text, tone: item.priority === 'urgent' ? 'danger' : item.seen ? 'muted' : 'base' });
  }
  return out;
}

/* ------------------------------------------------------------------- board tree */

/** The last path segment of a workspace, without `node:path` (the TUI is a client). */
function workspaceLabel(directory: string): string {
  const parts = String(directory ?? '')
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : '';
}

/** One tree row; `key` makes it expandable (mouse + keymap target). */
interface BoardRow {
  text: string;
  tone: Tone;
  key?: string;
}

function sessionBadges(session: BoardSession): string {
  const badges = [
    session.badges.held ? `🔒${session.badges.held}` : '',
    session.badges.waiting ? `⏳${session.badges.waiting}` : '',
    session.badges.handoffs ? `‹${session.badges.handoffs}›` : '',
    session.badges.queue ? `⇢${session.badges.queue}` : '',
    session.archived ? '[archived]' : '',
    session.frozen ? '[frozen]' : '',
    session.urgent ? '[urgent]' : '',
    // 0.9.7 (`11-21-collab-board-contract`, R2): one glyph + ≤3 digits at the
    // **end of the row** — the same derivation the GUI badge uses, never a new
    // line. No contract → `''` → the row is exactly what 0.9.6 printed.
    contractBadgeText(session.contract)
  ].filter(Boolean);
  return badges.length ? `  ${badges.join(' ')}` : '';
}

function sessionTone(session: BoardSession): Tone {
  if (session.archived) return 'muted';
  if (session.frozen) return 'danger';
  if (session.urgent) return 'warning';
  return 'base';
}

/** One `↳` child row (a session this one pulled in). */
function spawnRows(session: BoardSession, indent: string): BoardRow[] {
  return session.spawned.map(spawn => ({
    text: `${indent}↳ ${shortSid(spawn.sid)}  ${spawn.state}${spawn.archived ? ' [archived]' : ''}${
      spawn.title ? `  ${spawn.title}` : ''
    }`,
    tone: spawn.archived ? 'muted' : 'base'
  }));
}

function lockRows(session: BoardSession, indent: string): BoardRow[] {
  return session.locks.map(lock => {
    const holders = lock.holders.length ? lock.holders.map(shortSid).join(',') : 'free';
    const ttl = lock.expiresInMs ? ` · 剩 ${fmtAge(lock.expiresInMs)}` : '';
    const waited = lock.waiters ? ` · 等 ${lock.waiters}` : '';
    return {
      text: `${indent}🔒 ${lock.resource} · ${lock.mode} · ${holders}${ttl}${waited}`,
      tone: leaseTone(lock, session.sid)
    };
  });
}

function handoffRows(session: BoardSession, indent: string): BoardRow[] {
  return session.handoffs.map(handoff => {
    const urgent = handoff.priority === 'urgent' ? ' [urgent]' : '';
    const frozen = handoff.freeze ? ` [frozen] ${fmtClock(handoff.freeze.until).slice(0, 5)}` : '';
    const archived = handoff.archived ? ' [archived]' : '';
    return {
      text: `${indent}→ ${handoff.bid} · ${handoff.state} · 剩 ${fmtAge(handoff.ageMs)}${urgent}${frozen}${archived}`,
      tone: handoff.freeze || handoff.priority === 'urgent' ? 'danger' : handoff.state === 'open' ? 'warning' : 'base'
    };
  });
}

function queueRows(session: BoardSession, indent: string): BoardRow[] {
  return session.queue.map(item => {
    const urgent = item.priority === 'urgent' ? ' [urgent]' : '';
    return {
      text: `${indent}⇢ ${item.queueId} · ${shortSid(item.target)} · ${item.seen ? 'seen' : 'pending'}${urgent}`,
      tone: item.priority === 'urgent' ? 'danger' : item.seen ? 'muted' : 'base'
    };
  });
}

/**
 * The rows under one expanded session: `↳` children first (a spawn is the reason
 * the row exists), then locks / hand-offs / queue. The selected-row detail block
 * below uses the **documented** order instead (locks → hand-offs → queue → `↳`).
 */
function sessionDetailRows(session: BoardSession, indent: string): BoardRow[] {
  return [
    ...spawnRows(session, indent),
    ...lockRows(session, indent),
    ...handoffRows(session, indent),
    ...queueRows(session, indent)
  ];
}

/**
 * The three-layer tree (design §3): workspace header → session rows → expanded
 * details, with `已归档 N` as the last section of each workspace (collapsed by
 * default). Exactly one level of `↳` (a spawn is never recursive).
 */
function boardRows(board: BoardWorkspace[], expanded: Set<string>, width: number): BoardRow[] {
  const rows: BoardRow[] = [];
  const wide = width >= 56;
  for (const workspace of board) {
    const label = workspaceLabel(workspace.workspace) || '全局';
    const counts =
      `${workspace.counts.sessions} 会话 · ${workspace.counts.locks} 锁 · ` +
      `${workspace.counts.handoffs} 交接 · ${workspace.counts.archived} 已归档`;
    rows.push({
      text: wide ? `${pad(label, 16)}  ${counts}` : `${label}  ${counts}`,
      tone: 'muted'
    });
    for (const session of workspace.sessions) {
      rows.push(...sessionRows(session, expanded, '  '));
    }
    if (workspace.archived.length) {
      const key = `arch:${workspace.workspace}`;
      const open = expanded.has(key);
      rows.push({ text: `  ${open ? '▾' : '▸'} 已归档 ${workspace.archived.length}`, tone: 'muted', key });
      if (open) {
        for (const session of workspace.archived) rows.push(...sessionRows(session, expanded, '    '));
      }
    }
  }
  return rows;
}

function sessionRows(session: BoardSession, expanded: Set<string>, indent: string): BoardRow[] {
  const key = `ses:${session.sid}`;
  const open = expanded.has(key);
  const row: BoardRow = {
    text: `${indent}${open ? '▾' : '▸'} ${shortSid(session.sid)}  ${session.agent}  ${session.title}${sessionBadges(session)}`,
    tone: sessionTone(session),
    key
  };
  if (!open) return [row];
  return [row, ...sessionDetailRows(session, `${indent}    `)];
}

/** The session behind a `ses:<sid>` row key (`arch:` folds have no session). */
function sessionByKey(board: BoardWorkspace[], key: string | undefined): BoardSession | undefined {
  if (!key || !key.startsWith('ses:')) return undefined;
  const sid = key.slice('ses:'.length);
  for (const workspace of board) {
    const hit = [...workspace.sessions, ...workspace.archived].find(session => session.sid === sid);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * R4 (0.8.0): the selected row's detail, **3–5 lines** under the tree — a header,
 * the counters, then up to three item rows in the documented order
 * (locks → hand-offs → queue → `↳` spawned; the inline expansion keeps its own
 * order). A row that overflows ends in `… +N` instead of growing without bound;
 * an empty session still says so (three lines, never two).
 */
function detailLines(session: BoardSession, width: number): Line[] {
  const counts =
    `${session.badges.held} 持有 · ${session.badges.waiting} 排队 · ` +
    `${session.badges.handoffs} 交接 · ${session.badges.queue} 队列 · ${session.spawned.length} 拉起`;
  const out: Line[] = [
    {
      text: clip(`详情 ${session.sid} · ${session.agent} · ${session.title}`, width),
      tone: 'muted'
    },
    { text: clip(`  ${counts}`, width), tone: 'muted' }
  ];
  // 0.9.7 (`11-21-collab-board-contract`, R3): the contract summary — one extra
  // line, `主线 … · M2/5 · todo 3 · drift 11h`, clipped to the panel width so it
  // truncates instead of wrapping. No contract → no line (3–5 rows as before).
  const contract = contractSummary(session.contract);
  if (contract) out.push({ text: clipCells(`  ${contract}`, width), tone: 'muted' });
  const rows = [
    ...lockRows(session, '  '),
    ...handoffRows(session, '  '),
    ...queueRows(session, '  '),
    ...spawnRows(session, '  ')
  ];
  if (!rows.length) {
    out.push({ text: '  （无锁 / 交接 / 队列 / 拉起）', tone: 'muted' });
    return out;
  }
  const shown = rows.slice(0, 3);
  if (rows.length > 3) shown[2] = { text: `  … +${rows.length - 2}`, tone: 'muted' };
  out.push(...shown);
  return out;
}


/* ------------------------------------------------------------- relation graph */

const GRAPH_LEVEL_LABEL: Record<GraphLevel, string> = {
  global: '全局',
  workspace: '工作区',
  session: '会话'
};

/**
 * R3 (0.8.0, `board2-graph`): the TUI form of the same `buildGraph` the GUI
 * draws. A box-drawing text tree, two spaces of indent per hop (depth capped at
 * three), `─交接─▶` / `┄origin┄▶` / `┈agent┈▶` connectors, and `↳ ` for a spawn —
 * the board's `↳` notation, which is what a reader already knows. Every line is
 * `clip`ped to the panel width, so a narrow terminal gets `…` instead of a
 * wrapped, unreadable mess (and never a throw).
 *
 * Level follows the selection exactly like the GUI: a selected `ses:` row is L2
 * (that session ±1 hop), nothing selected is L0 (workspaces). The terminal has
 * no workspace cursor, so L1 stays a GUI level; the derivation supports it all
 * the same (`buildGraph` is shared).
 */
function graphRows(
  data: Snapshot,
  level: GraphLevel,
  workspace: string | undefined,
  session: string | undefined,
  width: number
): BoardRow[] {
  const graph = buildGraph(data, [], { level, workspace, session });
  if (!graph.nodes.length) return [];
  const heading =
    level === 'session' && session
      ? `关系图 · ${GRAPH_LEVEL_LABEL.session} ${shortSid(session)}`
      : level === 'workspace'
        ? `关系图 · ${GRAPH_LEVEL_LABEL.workspace} ${workspaceLabel(workspace ?? '') || '全局'}`
        : `关系图 · ${GRAPH_LEVEL_LABEL.global}`;
  const rows: BoardRow[] = [{ text: clip(heading, width), tone: 'muted' }];

  const byId = new Map(graph.nodes.map(node => [node.id, node] as const));
  const labelOf = (id: string): string => {
    const node = byId.get(id);
    if (!node) return shortSid(id);
    if (node.kind === 'workspace') return node.label || '全局';
    const title = node.label && node.label !== node.id ? ` · ${node.label}` : '';
    return `${shortSid(node.id)}${title}${node.archived ? ' [archived]' : ''}`;
  };
  const toneOf = (id: string): Tone => {
    const node = byId.get(id);
    if (!node || node.kind === 'workspace' || node.archived) return 'muted';
    if (node.frozen) return 'danger';
    if (node.urgent) return 'warning';
    return 'base';
  };

  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Set<string>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from);
    if (list) list.push(edge);
    else outgoing.set(edge.from, [edge]);
    incoming.add(edge.to);
  }

  const visited = new Set<string>();
  const emit = (id: string, indent: string, connector: string, depth: number): void => {
    if (visited.has(id) || depth > 3) return;
    visited.add(id);
    rows.push({ text: clip(`${indent}${connector}${labelOf(id)}`, width), tone: toneOf(id) });
    for (const edge of outgoing.get(id) ?? []) {
      const count = edge.count && edge.count > 1 ? String(edge.count) : '';
      const mark =
        edge.kind === 'spawn'
          ? '↳ '
          : edge.kind === 'origin'
            ? '┄origin┄▶ '
            : edge.kind === 'subagent'
              ? '┈agent┈▶ '
              : `─交接${count}─▶ `;
      emit(edge.to, `${indent}  `, mark, depth + 1);
    }
  };

  for (const node of graph.nodes) {
    if (!incoming.has(node.id)) emit(node.id, '  ', '', 0);
  }
  // A pure cycle has no root: emit whatever the first pass could not reach.
  for (const node of graph.nodes) emit(node.id, '  ', '', 0);

  if (graph.truncated > 0) rows.push({ text: clip(`  … +${graph.truncated}`, width), tone: 'muted' });
  return rows;
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
  hostPending: number,
  board: BoardWorkspace[],
  expanded: Set<string>,
  selectedKey: string | undefined
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
    // 0.9.7 (`11-21-collab-decision-inbox`, R4): one detail line with the open
    // decision count and the longest wait. No decision → no line at all; a
    // narrow panel clips (never wraps), like every other row.
    const inbox = decisionSummaryLine(data.decisions);
    if (inbox) push(clipCells(inbox, width), 'muted');
  }
  if (state.error) {
    push(`RPC 不可达：${state.error}`, 'danger');
    push(data ? '（显示上一份快照）' : '（仅显示本地会话列表）', 'muted');
  }
  // 0.9.0 (`11-20-collab-store`, R4): a degraded projection is a marker, not a
  // blank pane — every row below is still built from the JSON truth.
  if (data?.index && data.index.available === false) {
    push(`[索引不可用] ${data.index.reason ?? ''}`.trim(), 'muted');
  }

  if (data) {
    // The same three-layer tree the GUI renders (design §2/§3). Expansion is
    // local UI state: a 2 s poll replaces `data` and never folds a row.
    const rows = boardRows(board, expanded, width);
    for (const row of rows) {
      const selected = row.key !== undefined && row.key === selectedKey;
      out.push({
        text: selected ? `› ${row.text}` : row.text,
        tone: selected ? 'success' : row.tone,
        ...(row.key ? { key: row.key } : {})
      });
    }

    // R4 (0.8.0): the selected row's detail, directly under the tree. Only a
    // `ses:` row has one; an `arch:` fold row selected by `j/k` adds nothing.
    const selectedSession = sessionByKey(board, selectedKey);
    if (selectedSession) out.push(...detailLines(selectedSession, width));

    // 0.8.0 (`board2-graph`): the same relation derivation the GUI draws. A
    // selected session is the centre (L2); nothing selected is the global view
    // (L0). Reading the derived board — not a second RPC — like every row above.
    out.push(
      ...graphRows(
        data,
        selectedSession ? 'session' : 'global',
        selectedSession?.workspace,
        selectedSession?.sid,
        width
      )
    );

    // Compatibility with a snapshot whose `sessions` block is empty (an older
    // server, a hand-built fixture): leases / hand-offs / queue items that no
    // session row owns are still shown, never silently dropped. The same helper
    // feeds the GUI's fallback section.
    const orphans = boardOrphans(data, board);
    if (orphans.locks.length) {
      push(`资源租约 (${orphans.locks.length}) · 未归属`, 'muted');
      out.push(...leaseLines(orphans.locks, width, panel.sessionID));
    }
    if (orphans.handoffs.length) {
      push(`未闭环交接 (${orphans.handoffs.length}) · 未归属`, 'muted');
      out.push(...handoffLines(orphans.handoffs, width));
    }
    if (!rows.length && !orphans.locks.length && !orphans.handoffs.length && !orphans.queue.length) {
      push('（无协作活动）', 'muted');
    }
    if (orphans.queue.length) {
      push(`受保护目标队列 (${orphans.queue.length}) · 未归属`, 'muted');
      out.push(...queueLines(orphans.queue, width));
    }
  } else {
    // No snapshot at all: the three blocks keep the old honest "unreachable"
    // rows, and the host's own session list stands in for the tree.
    push(`资源租约 (0)`, 'muted');
    push(pending('（无租约）'), 'muted');
    push(`未闭环交接 (0)`, 'muted');
    push(pending('（无交接）'), 'muted');
    push(`受保护目标队列 (0)`, 'muted');
    push(pending('（无排队）'), 'muted');

    if (state.error) {
      push(`会话 (${sessions.length})`, 'muted');
      for (const session of sessions) {
        const title = clip(session.title, Math.max(8, width - 26));
        push(`  ${session.busy ? '●' : '○'} ${shortSid(session.sid)} ${session.agent} ${title}`, session.busy ? 'success' : 'base');
      }
    }
  }

  push(`只读 · 每 ${POLL_MS / 1000}s 刷新 · /collab`, 'muted');
  return out;
}

/* ----------------------------------------------------------------------- panel */

function StatusPanel(props: { panel: PanelInput }) {
  const ctx = usePlugin();
  const store = storeFor(ctx);
  // Expand/collapse + cursor are local UI state (never in the snapshot): the
  // 2 s poll must not fold a row the user opened.
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [cursor, setCursor] = createSignal(0);
  // R4 (0.8.0): a row counts as *selected* only after `j`/`k`. `esc` clears it.
  // `enter`/`space` and a mouse click keep their 0.6.0 meaning (expand / collapse
  // the row) and do **not** open the detail block: the tree already renders those
  // rows inline, and doubling them under the tree would be noise.
  const [active, setActive] = createSignal(false);
  const width = () => Math.max(24, Number(props.panel.width) || FALLBACK_WIDTH);
  const board = createMemo(() =>
    store.state.data ? buildBoard(store.state.data, [], Date.now(), props.panel.sessionID) : []
  );
  const selectable = createMemo(() =>
    store.state.data ? boardRows(board(), expanded(), width()).flatMap(row => (row.key ? [row.key] : [])) : []
  );
  const cursorKey = (): string | undefined => {
    const keys = selectable();
    if (!keys.length) return undefined;
    return keys[Math.min(cursor(), keys.length - 1)];
  };
  const selectedKey = () => (active() ? cursorKey() : undefined);
  const selectedSession = () => sessionByKey(board(), selectedKey());
  const toggle = (key: string): void => {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const move = (delta: number): void => {
    const keys = selectable();
    if (!keys.length) return;
    setActive(true);
    setCursor(value => (value + delta + keys.length) % keys.length);
  };
  const toggleSelected = (): void => {
    const key = cursorKey();
    if (key) toggle(key);
  };
  const clearSelection = (): void => {
    setActive(false);
  };
  const clickRow = (key: string): void => {
    const index = selectable().indexOf(key);
    if (index >= 0) setCursor(index);
    toggle(key);
  };

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

  // R4 (0.6.0): keyboard expansion, only while this panel owns the input.
  // Register **once** at component scope: `PanelInput` is reactive props, and a
  // layer created inside an effect would stack a new one on every name/focus
  // change (then one `enter` toggles twice). The factory itself is reactive;
  // the host disposes the layer when this component is disposed.
  ctx.keymap.layer(() => ({
    mode: 'global',
    // `focused` is the host's own statement that this panel owns the input;
    // a panel rendered in the background must not steal j/k/enter.
    enabled: () => props.panel.name === PANEL && props.panel.focused === true,
    commands: [
      { id: 'collab.board.down', title: 'Collab 下一项', group: 'Collab', bind: 'j', run: () => move(1) },
      { id: 'collab.board.up', title: 'Collab 上一项', group: 'Collab', bind: 'k', run: () => move(-1) },
      { id: 'collab.board.toggle', title: 'Collab 展开/收起', group: 'Collab', bind: 'enter', run: () => toggleSelected() },
      { id: 'collab.board.toggle-space', title: 'Collab 展开/收起', group: 'Collab', bind: 'space', run: () => toggleSelected() },
      { id: 'collab.board.clear', title: 'Collab 清除选中', group: 'Collab', bind: 'escape', run: () => clearSelection() },
      {
        id: 'collab.board.open',
        title: 'Collab 打开选中会话',
        group: 'Collab',
        bind: 'o',
        run: () => {
          const sid = selectedSession()?.sid;
          if (!sid) {
            ctx.ui.toast.show({ message: '先 j/k 选一个会话', variant: 'warning' });
            return;
          }
          if (!ctx.ui.tabs.enabled() || !ctx.ui.tabs.focus(sid)) {
            ctx.ui.toast.show({ message: '该终端不支持会话标签页；用 collab_status 查看', variant: 'warning' });
          }
        }
      }
    ]
  }));

  const lines = createMemo(() =>
    panelLines(
      store.state,
      props.panel,
      fallbackSessions(ctx),
      pendingCountOf(ctx.data?.session?.pending, props.panel.sessionID),
      board(),
      expanded(),
      selectedKey()
    )
  );

  return (
    <box flexDirection="column">
      <For each={lines()}>
        {line =>
          line.key ? (
            <box onMouseDown={() => clickRow(line.key!)}>
              <text fg={color(ctx, line.tone)}>{line.text}</text>
            </box>
          ) : (
            <text fg={color(ctx, line.tone)}>{line.text}</text>
          )
        }
      </For>
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
      text: `→ ${handoff.bid} · ${handoff.state} · ${fmtAge(handoff.ageMs)} · ${shortSid(handoff.from)}${
        handoff.priority === 'urgent' ? ' · urgent' : ''
      }${handoff.freeze ? ` · frozen ${fmtClock(handoff.freeze.until).slice(0, 5)}` : ''}`,
      // `open` = nobody has taken it yet; that is the row worth noticing.
      tone: handoff.freeze || handoff.priority === 'urgent' ? 'danger' : handoff.state === 'open' ? 'warning' : 'base'
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
