/**
 * 0.9.6 (`11-20-collab-pacing`, R1/R4/R5): the 2-minute batching window.
 *
 * The measured problem this module answers: two collaborating sessions produced
 * 624 messages, **69% of them full state mirrors** and not one a short receipt.
 * Each `collab_send` / `collab_reply` used to be one prompt, one inbox entry and
 * one compaction step. Batching keeps the *content* but collapses the *count*:
 *
 * ```
 * dispatch (guards / de-dup / delta already decided)
 *   ├─ direct  → prompt now (escalate · blocked · protected · bid · windowMs:0)
 *   └─ window  → buffer[target].items.push(item); arm a timer at first.sentAt+windowMs
 *                 flush → ONE envelope carrying items[] → prompt
 * ```
 *
 * Invariants (design §3, and the rules the task pinned):
 *
 *   1. **The window opens at the first item and flushes `windowMs` later.**
 *      `windowMs:0` disables the whole module (0.9.5 behaviour, rollback).
 *   2. **Per-thread order is never reordered.** Items are appended in arrival
 *      order; a window de-dup hit replaces the earlier item **in place** (the
 *      later content wins, the position does not move).
 *   3. **Only `thread + factId` (or the same normalised body on the same thread)
 *      is merged.** Two threads are always two items — a merge across threads
 *      would silently move a reply onto the wrong thread.
 *   4. **The buffer is a file, not a variable.** A reload / a sleeping process
 *      would otherwise lose undelivered messages; the next `context` hook calls
 *      `flushDueWindows()` and delivers everything past due.
 *   5. **A failed flush keeps its items** (`nextAt = now + PACING_RETRY_MS`,
 *      `attempts + 1`) — never dropped, never duplicated. A delivery later than
 *      `PACING_SLA_MS` after the first item is counted (`metrics.late_count`),
 *      not re-sent.
 *   6. **Timers never keep the process alive** (`unref`): a pending window must
 *      not be a reason for Node to stay up.
 *
 * The file is global (`~/.config/opencode/collab-pacing.json`) because windows
 * are per *target session*, and a target can live in another workspace.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  PACING_COUNTER_KEEP_DAYS,
  PACING_FILE,
  PACING_MAX_ITEMS,
  PACING_METRICS_TTL_MS,
  PACING_SLA_MS,
  PACING_VERSION,
  PACING_WINDOW_MS
} from '../constants.ts';
import { errText, log } from '../log.ts';
import type {
  DeltaSnapshot,
  EnvelopeItem,
  PacingDayCounters,
  PacingItem,
  PacingState,
  PacingWindow
} from '../types.ts';
import { fmtTime } from '../util.ts';
import { withFileLock } from './file-lock.ts';
import { upsertMetrics } from './index-db.ts';
import { aggregateDay, dayKey, normalizeCounters, timesByDay } from './metrics.ts';
import type { DayMetricsRow } from './metrics.ts';
import { readMessages } from './store.ts';

// 0.9.7: the pacing path and `rebuild` share one aggregation (`./metrics.ts`).
// Re-exported so the public surface (`__internals`) and the tests keep working.
export { dayKey, isResendID, medianGapMs } from './metrics.ts';
export type { DayMetricsRow as PacingMetricsRow } from './metrics.ts';
export { PACING_VERSION };

export interface PacingOptions {
  /** Override the state file (harness / sandbox runs). */
  file?: string;
  /** Bounded wait for the cross-process lock (default 2000ms). */
  waitMs?: number;
}

/* ------------------------------------------------------------------ state IO */
export function emptyPacingState(): PacingState {
  return { v: PACING_VERSION as 1, windows: [], counters: {}, lastSent: {}, noops: {} };
}

/** Tolerant parse: an unreadable / foreign file is an empty buffer, never a throw. */
export function normalizePacingState(raw: unknown): PacingState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyPacingState();
  const value = raw as Record<string, any>;
  if (Number(value.v) !== PACING_VERSION) return emptyPacingState();
  const windows: PacingWindow[] = [];
  for (const entry of Array.isArray(value.windows) ? value.windows : []) {
    const window = normalizeWindow(entry);
    if (window) windows.push(window);
  }
  const counters = normalizeCounters(value.counters);
  const lastSent: Record<string, DeltaSnapshot> = {};
  for (const [sid, snapshotRaw] of Object.entries(value.lastSent && typeof value.lastSent === 'object' ? value.lastSent : {})) {
    const snapshot = snapshotRaw as Record<string, unknown>;
    lastSent[sid] = {
      facts: (Array.isArray(snapshot.facts) ? snapshot.facts : []).map(String),
      todoHash: String(snapshot.todoHash ?? ''),
      advancedAt: Number(snapshot.advancedAt) || 0,
      at: Number(snapshot.at) || 0
    };
  }
  const noops: Record<string, { count: number; at: number }> = {};
  for (const [sid, entryRaw] of Object.entries(value.noops && typeof value.noops === 'object' ? value.noops : {})) {
    const entry = entryRaw as Record<string, unknown>;
    const count = Math.max(0, Number(entry.count) || 0);
    if (count) noops[sid] = { count, at: Number(entry.at) || 0 };
  }
  return {
    v: PACING_VERSION as 1,
    windows,
    counters,
    lastSent,
    noops,
    ...(Number(value.metricsAt) ? { metricsAt: Number(value.metricsAt) } : {})
  };
}

function normalizeWindow(raw: unknown): PacingWindow | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, any>;
  const target = String(value.target ?? '').trim();
  const openedAt = Number(value.openedAt) || 0;
  if (!target || openedAt <= 0) return undefined;
  const items: PacingItem[] = [];
  for (const entry of Array.isArray(value.items) ? value.items : []) {
    const item = normalizeItem(entry);
    if (item) items.push(item);
  }
  if (!items.length) return undefined;
  return {
    target,
    openedAt,
    items,
    ...(Number(value.nextAt) ? { nextAt: Number(value.nextAt) } : {}),
    ...(Number(value.attempts) ? { attempts: Number(value.attempts) } : {})
  };
}

function normalizeItem(raw: unknown): PacingItem | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, any>;
  const id = String(value.id ?? '').trim();
  const target = String(value.target ?? '').trim();
  const sentAt = Number(value.sentAt) || 0;
  if (!id || !target || sentAt <= 0) return undefined;
  const threadId = String(value.threadId ?? '').trim();
  const factIds = Array.isArray(value.factIds) ? value.factIds.map(String) : [];
  const basedOn =
    value.basedOn && typeof value.basedOn === 'object'
      ? {
          ...(value.basedOn.repo && typeof value.basedOn.repo === 'object' ? { repo: value.basedOn.repo } : {}),
          ...(value.basedOn.env && typeof value.basedOn.env === 'object' ? { env: value.basedOn.env } : {}),
          facts: Number(value.basedOn.facts) || 0
        }
      : { facts: 0 };
  return {
    id,
    target,
    from: String(value.from ?? ''),
    fromLabel: String(value.fromLabel ?? ''),
    ...(value.name ? { name: String(value.name) } : {}),
    ...(threadId ? { threadId } : {}),
    kind: String(value.kind ?? 'note'),
    body: String(value.body ?? ''),
    sentAt,
    grade: String(value.grade ?? 'unknown'),
    basedOn,
    mode: String(value.mode ?? 'queue'),
    ...(factIds.length ? { factIds } : {}),
    ...(value.factId ? { factId: String(value.factId) } : {}),
    ...(value.bid ? { bid: String(value.bid) } : {}),
    ...(value.baseline && typeof value.baseline === 'object'
      ? {
          baseline: {
            facts: (Array.isArray(value.baseline.facts) ? value.baseline.facts : []).map(String),
            todoHash: String(value.baseline.todoHash ?? ''),
            advancedAt: Number(value.baseline.advancedAt) || 0,
            at: Number(value.baseline.at) || 0
          }
        }
      : {})
  };
}

export function readPacing(options: PacingOptions = {}): PacingState {
  const file = String(options.file ?? PACING_FILE);
  if (!existsSync(file)) return emptyPacingState();
  try {
    return normalizePacingState(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    log(`ignoring unreadable pacing state ${file}: ${errText(error)}`);
    return emptyPacingState();
  }
}

/** `tmp + rename`: a crash mid-write leaves the previous buffer intact. */
export function writePacing(state: PacingState, options: PacingOptions = {}): void {
  const file = String(options.file ?? PACING_FILE);
  const pruned = {
    ...state,
    counters: pruneCounters(state.counters, Date.now()),
    lastSent: pruneLastSent(state.lastSent),
    noops: pruneNoops(state.noops)
  };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pruned, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the tmp file may already be gone */
    }
    throw error;
  }
}

/** Keep `lastSent` bounded: the newest 200 sessions (a baseline, not a history). */
function pruneLastSent(lastSent: Record<string, DeltaSnapshot>): Record<string, DeltaSnapshot> {
  const entries = Object.entries(lastSent);
  if (entries.length <= 200) return lastSent;
  entries.sort((left, right) => (Number(right[1].at) || 0) - (Number(left[1].at) || 0));
  return Object.fromEntries(entries.slice(0, 200));
}

/** Keep the newest 200 sessions with a suppressed turn (a counter, not a log). */
function pruneNoops(noops: Record<string, { count: number; at: number }>): Record<string, { count: number; at: number }> {
  const entries = Object.entries(noops ?? {});
  if (entries.length <= 200) return noops ?? {};
  entries.sort((left, right) => (Number(right[1].at) || 0) - (Number(left[1].at) || 0));
  return Object.fromEntries(entries.slice(0, 200));
}

function pruneCounters(counters: Record<string, PacingDayCounters>, now: number): Record<string, PacingDayCounters> {
  const days = Object.keys(counters).sort();
  if (days.length <= PACING_COUNTER_KEEP_DAYS) return counters;
  const keep = new Set(days.slice(-PACING_COUNTER_KEEP_DAYS));
  const out: Record<string, PacingDayCounters> = {};
  for (const day of days) if (keep.has(day)) out[day] = counters[day];
  return out;
}

/**
 * Read-modify-write under `<file>.lock` (another workspace's plugin writes the
 * same file). Returns `undefined` when the lock cannot be taken — the caller
 * then falls back to a direct delivery, so a busy buffer never drops a message.
 */
export async function updatePacing<T>(
  mutate: (state: PacingState) => T,
  options: PacingOptions = {}
): Promise<{ state: PacingState; result: T } | undefined> {
  const file = String(options.file ?? PACING_FILE);
  try {
    return await withFileLock(
      file,
      () => {
        const state = readPacing(options);
        const result = mutate(state);
        writePacing(state, options);
        return { state, result };
      },
      { waitMs: Math.max(0, Number(options.waitMs ?? 2000)) }
    );
  } catch (error) {
    log(`pacing state unavailable (${errText(error)}); this delivery will go out directly`);
    return undefined;
  }
}

/* -------------------------------------------------------------- window rules */

/** The normalised body the window-dedup uses (whitespace is layout, not content). */
export function pacingBodyKey(text: unknown): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The window key of one item: `thread + factId` when a fact is cited (R4), else
 * `thread + normalised body` (the "same receipt twice" half of R4). Items
 * without a thread are never merged — there is no subject to merge them onto.
 */
export function pacingDedupeKey(item: Pick<PacingItem, 'threadId' | 'factId' | 'body'>): string {
  const thread = String(item.threadId ?? '').trim();
  if (!thread) return '';
  const fact = String(item.factId ?? '').trim();
  return fact ? `${thread}\n#${fact}` : `${thread}\n${pacingBodyKey(item.body)}`;
}

/**
 * The delta baseline is **per pair** (`from → target`), not per session.
 *
 * A session-level key is silently lossy in the one case that matters: `A` tells
 * `B` about `F1`, then wants to tell `C` the same fact. With one key per sender,
 * the second message carries "no new fact" and is suppressed — information `C`
 * never received. Every counterpart must receive each status change / fact once.
 *
 * `\u0000` cannot appear in a `ses_…` id, so the key is unambiguous.
 */
export function baselineKey(from: unknown, target: unknown): string {
  const fromSid = String(from ?? '').trim();
  const targetSid = String(target ?? '').trim();
  if (!fromSid || !targetSid) return '';
  return `${fromSid}\u0000${targetSid}`;
}

export function windowFor(state: PacingState, target: string): PacingWindow | undefined {
  return state.windows.find(window => window.target === target);
}

/**
 * Merge `item` into `window` (append, or replace the earlier duplicate **in
 * place** so a thread's order is preserved). Returns what happened.
 */
export function mergeIntoWindow(
  window: PacingWindow,
  item: PacingItem
): { merged: boolean; replaced: boolean; overflow: boolean } {
  const key = pacingDedupeKey(item);
  if (key) {
    const index = window.items.findIndex(existing => pacingDedupeKey(existing) === key);
    if (index >= 0) {
      window.items[index] = item; // later content wins, position does not move
      return { merged: true, replaced: true, overflow: false };
    }
  }
  window.items.push(item);
  return { merged: false, replaced: false, overflow: window.items.length > PACING_MAX_ITEMS };
}

/**
 * A window is due when its timer expired — or, after a failed flush, when its
 * retry moment came. A scheduled retry **replaces** the timer: without that,
 * every hook would retry a failing window in a tight loop (openedAt is already
 * in the past).
 */
export function windowDue(window: PacingWindow, now: number, windowMs = PACING_WINDOW_MS): boolean {
  const retryAt = Number(window.nextAt) || 0;
  if (retryAt) return now >= retryAt;
  return now - window.openedAt >= Math.max(0, windowMs);
}

/** The flush moment of a window: the retry moment when one is scheduled, else the timer. */
export function windowFlushAt(window: PacingWindow, windowMs = PACING_WINDOW_MS): number {
  const retryAt = Number(window.nextAt) || 0;
  return retryAt || window.openedAt + Math.max(0, windowMs);
}

/** The envelope kind of a batch: any request makes it a request. */
export function batchKind(items: PacingItem[]): string {
  if (items.some(item => item.kind === 'request')) return 'request';
  if (items.some(item => item.kind === 'reply')) return 'reply';
  return 'note';
}

/** The single thread of a batch, when every item shares one (else `undefined`). */
export function batchThread(items: PacingItem[]): string | undefined {
  const threads = new Set(items.map(item => String(item.threadId ?? '')));
  if (threads.size !== 1) return undefined;
  const only = [...threads][0];
  return only || undefined;
}

/**
 * Render a window into the one body the receiver sees. Every item keeps its own
 * header (kind / thread / **original** `sentAt`) and its own body, in arrival
 * order — the batch head only says how many and which window.
 */
export function renderWindow(window: PacingWindow, windowMs = PACING_WINDOW_MS): string {
  const count = window.items.length;
  const first = window.items[0];
  const last = window.items[count - 1];
  const span =
    count === 1
      ? fmtTime(first.sentAt)
      : `${fmtTime(first.sentAt)}–${fmtTime(last.sentAt)}`;
  const head = `批量消息 ${count} 条（${span} 的窗口，${Math.round(Math.max(0, windowMs) / 1000)}s 合并）`;
  const body = window.items
    .map((item, index) => {
      const where = `${index + 1}/${count} · ${item.kind}${item.threadId ? ` · ${item.threadId}` : ''} · ${fmtTime(item.sentAt)}`;
      return `--- ${where}\n${item.body}`;
    })
    .join('\n');
  return `${head}\n${body}`;
}

/** The `items[]` half of the batched envelope (original ids, threads and times). */
export function windowItems(window: PacingWindow): EnvelopeItem[] {
  return window.items.map(item => ({
    id: item.id,
    ...(item.threadId ? { threadId: item.threadId } : {}),
    kind: item.kind,
    body: item.body,
    sentAt: item.sentAt,
    ...(item.factIds?.length ? { factIds: item.factIds } : {})
  }));
}

/** Was this batch delivered later than the 5-minute promise? */
export function windowIsLate(window: PacingWindow, now: number): boolean {
  return now - window.openedAt > PACING_SLA_MS;
}

/* ------------------------------------------------------------------- timers */

interface ArmedTimer {
  timer: ReturnType<typeof setTimeout>;
  at: number;
}
const timers = new Map<string, ArmedTimer>();

/**
 * Arm one flush per window. `unref()` is mandatory: a buffered message must not
 * keep the host process alive (the `context` hook is the durable fallback).
 */
export function armFlush(key: string, at: number, run: () => void, now = Date.now()): void {
  const when = Math.max(0, Number(at) || 0);
  const existing = timers.get(key);
  if (existing && Math.abs(existing.at - when) <= 5) return;
  if (existing) clearTimeout(existing.timer);
  const handle = setTimeout(() => {
    timers.delete(key);
    try {
      run();
    } catch (error) {
      log(`pacing flush failed for ${key}: ${errText(error)}`);
    }
  }, Math.max(0, when - now));
  // Node keeps a process alive for a pending timer; a window is not a reason to.
  (handle as unknown as { unref?: () => void }).unref?.();
  timers.set(key, { timer: handle, at: when });
}

export function clearFlushTimers(): void {
  for (const entry of timers.values()) clearTimeout(entry.timer);
  timers.clear();
}

/** Test helper: the armed timers (key → flush moment), without touching them. */
export function armedFlushes(): { key: string; at: number }[] {
  return [...timers.entries()].map(([key, entry]) => ({ key, at: entry.at }));
}

/* --------------------------------------------------------------- counters */

export function counterOf(state: PacingState, now = Date.now()): PacingDayCounters {
  return state.counters[dayKey(now)] ?? { noop: 0, late: 0 };
}

export function bumpCounter(state: PacingState, key: keyof PacingDayCounters, now = Date.now(), by = 1): PacingDayCounters {
  const day = dayKey(now);
  const current = state.counters[day] ?? { noop: 0, late: 0 };
  const next = { ...current, [key]: current[key] + by };
  state.counters[day] = next;
  return next;
}

/* ---------------------------------------------------------------- metrics */

/** Every message timestamp of one local day, from the JSONL truth (resends excluded). */
export function dayMessageTimes(day: string, options: { file?: string } = {}): number[] {
  const { messages } = readMessages(options.file ? { file: options.file } : {});
  return timesByDay(messages).get(day) ?? [];
}

/** Compute one day's row from the log + the counters (pure except the file read). */
export function pacingMetrics(day: string, counters: PacingDayCounters, options: { file?: string } = {}): DayMetricsRow {
  return aggregateDay(day, dayMessageTimes(day, options), counters);
}

/**
 * Persist today's four fields into `collab.db`'s `metrics` row. Throttled by
 * `PACING_METRICS_TTL_MS` unless `force` is set (the flush path calls it; a
 * per-message recompute would read the whole log every time). A `storage:json`
 * install has no projection — the row is skipped, never synthesized.
 */
export async function refreshMetrics(
  options: {
    file?: string;
    dbPath?: string;
    storage?: 'sqlite' | 'json';
    day?: string;
    now?: number;
    force?: boolean;
  } = {}
): Promise<DayMetricsRow | undefined> {
  const now = Number(options.now) || Date.now();
  const day = String(options.day ?? dayKey(now));
  const state = readPacing(options.file ? { file: options.file } : {});
  const last = Number(state.metricsAt) || 0;
  if (!options.force && last && now - last < PACING_METRICS_TTL_MS && dayKey(last) === day) return undefined;
  const row = pacingMetrics(day, counterOf(state, now), options.file ? { file: options.file } : {});
  try {
    await upsertMetrics(row, {
      ...(options.dbPath ? { dbPath: options.dbPath } : {}),
      ...(options.storage ? { storage: options.storage } : {})
    });
  } catch (error) {
    log(`metrics write failed (${errText(error)}); the projection can be rebuilt`);
  }
  try {
    await updatePacing(state => {
      state.metricsAt = now;
    }, options.file ? { file: options.file } : {});
  } catch (error) {
    log(`metrics stamp failed: ${errText(error)}`);
  }
  return row;
}

/** Exposed so a scheduler can compute "when should I look again". */
export function nextFlushAt(state: PacingState, windowMs = PACING_WINDOW_MS): number {
  let best = 0;
  for (const window of state.windows) {
    const at = windowFlushAt(window, windowMs);
    if (!best || at < best) best = at;
  }
  return best;
}
