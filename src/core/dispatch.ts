/**
 * 0.9.6 (`11-20-collab-pacing`, R1/R2/R5/R6): the delivery policy.
 *
 * `tools/shared.ts#dispatch` already owns every guard (protect / self-target /
 * content de-dup / conflict gate). This module owns the one question left —
 * **when** a message goes out — plus the durable window buffer that makes the
 * answer "in 2 minutes, together with the others":
 *
 * ```
 * policy(item)  direct  → the caller's `deliverOne` runs now
 *               window  → enqueueWindow(item) → timer / context hook → deliverWindow(window)
 * ```
 *
 * Direct (never batched) — the four cases the design pins:
 *
 *   | case                                   | why |
 *   |----------------------------------------|-----|
 *   | `kind` in `directKinds` (`escalate`)    | the urgent path promises <10s |
 *   | structured `blocked` / `[handoff]` line | an alert is not a status mirror |
 *   | target in the protected lineage         | the batching buffer must never become a delayed path into a closed line |
 *   | item carries a `bid` (hand-off)         | one ack per `cid`; a batch cid cannot ack several bids |
 *
 * `windowMs:0` (or `storage` / the buffer being unwritable) also means direct —
 * a message is never lost because a buffer could not be used.
 *
 * The runtime (`deliverWindow`) is registered by `createToolKit`, because only
 * it can write the thread store / message log / inbox of this process. The
 * timer is only a *hint*: every `context` hook calls `flushDueWindows()`, which
 * is the durable path after a reload or a sleep.
 */
import { PACING_RETRY_MS } from '../constants.ts';
import { errText, log } from '../log.ts';
import type { DeltaSnapshot, PacingDayCounters, PacingItem, PacingState, PacingWindow } from '../types.ts';
import {
  armFlush,
  baselineKey,
  bumpCounter,
  counterOf,
  mergeIntoWindow,
  readPacing,
  updatePacing,
  windowDue,
  windowFlushAt,
  windowFor,
  windowIsLate
} from './pacing.ts';
import type { PacingOptions } from './pacing.ts';

/** What `deliverWindow` reports back (a failure keeps the items, it never drops them). */
export interface PacingDeliveryResult {
  ok: boolean;
  reason?: string;
}

export interface PacingRuntime {
  /** Live config: `windowMs` may be edited while the plugin runs. */
  windowMs(): number;
  /** Send one merged window (one prompt + one log row + the thread bookkeeping). */
  deliverWindow(window: PacingWindow): Promise<PacingDeliveryResult>;
  /** Retry delay of a failed flush (tests shorten it). */
  retryMs?: number;
}

let runtime: PacingRuntime | undefined;

export function configurePacingRuntime(next: PacingRuntime | undefined): void {
  runtime = next;
}

export function pacingRuntime(): PacingRuntime | undefined {
  return runtime;
}

/** Test/reset helper: a new install must not inherit the previous delivery path. */
export function resetPacingRuntime(): void {
  runtime = undefined;
}

/* ------------------------------------------------------------------ policy */

export interface PacingPolicyInput {
  kind: string;
  /** Structured BLOCKED report (`blocked` argument) — always direct. */
  blocked?: boolean;
  /** Target (or an ancestor) is in the protect list — always direct. */
  protectedTarget?: boolean;
  /** The message closes a hand-off (`bid`) — always direct (per-cid ack). */
  bid?: string;
  /** `force:true` means "deliver now": a forced message never waits in a window. */
  force?: boolean;
  /** `steer` is an explicit interruption — nothing about it is "non-urgent". */
  mode?: string;
  windowMs: number;
  directKinds?: string[];
}

/**
 * `direct` or `window`. Pure: the caller can print the decision in the receipt
 * (`mode=window(120s)` vs `mode=queue`) without touching the buffer.
 */
export function pacingPolicy(input: PacingPolicyInput): 'direct' | 'window' {
  if (!(Number(input.windowMs) > 0)) return 'direct';
  const kind = String(input.kind ?? '').trim();
  const directKinds = (input.directKinds ?? []).map(value => String(value ?? '').trim());
  if (kind && directKinds.includes(kind)) return 'direct';
  if (input.blocked) return 'direct';
  if (input.protectedTarget) return 'direct';
  if (String(input.bid ?? '').trim()) return 'direct';
  if (input.force) return 'direct';
  if (String(input.mode ?? '').trim() === 'steer') return 'direct';
  return 'window';
}

/* --------------------------------------------------------------- enqueueing */

export interface EnqueueResult {
  /** `false` = the buffer was unusable; the caller must deliver directly. */
  queued: boolean;
  window?: PacingWindow;
  flushAt?: number;
  /** The item replaced an earlier one (same thread + factId / same body). */
  deduped?: boolean;
  reason?: string;
}

/**
 * Buffer one prepared item for `item.target` and arm the flush timer. The item
 * is written **before** the caller returns, so a crash between the two loses
 * nothing (the next hook flushes the file).
 */
export async function enqueueWindow(item: PacingItem, options: PacingOptions & { windowMs?: number } = {}): Promise<EnqueueResult> {
  const windowMs = Math.max(0, Number(options.windowMs ?? runtime?.windowMs() ?? 0));
  if (!(windowMs > 0)) return { queued: false, reason: 'windowMs=0' };
  const updated = await updatePacing(
    state => {
      let window = windowFor(state, item.target);
      if (!window) {
        window = { target: item.target, openedAt: item.sentAt, items: [] };
        state.windows.push(window);
      }
      const merged = mergeIntoWindow(window, item);
      // Past the item cap the flush is **pulled forward** (not the item
      // dropped): one prompt must not grow without bound.
      if (merged.overflow) {
        window.nextAt = Math.min(Number(window.nextAt) || window.openedAt + windowMs, item.sentAt);
      }
      return { window, merged };
    },
    options
  );
  if (!updated) return { queued: false, reason: '状态文件不可写' };
  const window = updated.result.window;
  const flushAt = windowFlushAt(window, windowMs);
  // `item.sentAt` as the clock: the delay is `windowMs` even when a caller (the
  // replay test) drives an injected clock instead of `Date.now()`.
  arm(window, flushAt, windowMs, item.sentAt);
  return { queued: true, window, flushAt, deduped: updated.result.merged.replaced };
}

/** Arm (or re-arm) every pending window of one state snapshot. */
export function armAllWindows(state: PacingState, windowMs: number, now = Date.now()): void {
  for (const window of state.windows) {
    arm(window, windowFlushAt(window, windowMs), windowMs, now);
  }
}

function arm(window: PacingWindow, at: number, windowMs: number, now = Date.now()): void {
  if (!(windowMs > 0)) return;
  armFlush(window.target, at, () => {
    void flushDueWindows();
  }, now);
}

/* -------------------------------------------------------------------- flush */

export interface FlushSummary {
  flushed: number;
  delivered: number;
  failed: number;
  /** Items of the delivered windows. */
  items: number;
  late: number;
}

const emptySummary = (): FlushSummary => ({ flushed: 0, delivered: 0, failed: 0, items: 0, late: 0 });

let inflight: Promise<FlushSummary> | undefined;

/**
 * Deliver every window that is past due. Called by the timer (a hint) and by
 * every `context` hook (the durable path). Re-entrant calls share one run, so a
 * hook and a timer firing together cannot deliver a window twice.
 */
export function flushDueWindows(options: PacingOptions & { now?: number } = {}): Promise<FlushSummary> {
  if (inflight) return inflight;
  inflight = runFlush(false, options).finally(() => {
    inflight = undefined;
  });
  return inflight;
}

/** Force every window out (tests / shutdown / a `windowMs` flip to 0). */
export function flushAllWindows(options: PacingOptions & { now?: number } = {}): Promise<FlushSummary> {
  return runFlush(true, options);
}

async function runFlush(force: boolean, options: PacingOptions & { now?: number }): Promise<FlushSummary> {
  const startedAt = Number(options.now) || Date.now();
  const summary = emptySummary();
  const rt = runtime;
  if (!rt) return summary;
  const windowMs = Math.max(0, Number(rt.windowMs()) || 0);
  // A `windowMs` flipped to 0 must **drain** the buffer, not strand it.
  const takeAll = force || !(windowMs > 0);

  // C5 (review): the `context` hook runs on **every** request, so the common
  // case must not take a lock nor create the file. One unlocked read decides:
  // no window (or none due) → nothing to write, just (re)arm the timers.
  const snapshot = readPacing(options);
  if (!takeAll && !snapshot.windows.some(window => windowDue(window, startedAt, windowMs))) {
    armAllWindows(snapshot, windowMs, startedAt);
    return summary;
  }

  // Take the due windows **atomically**: removing them before delivery is what
  // makes two flushers (timer + hook) unable to send the same batch twice.
  const taken = await updatePacing(
    state => {
      const due = state.windows.filter(window => takeAll || windowDue(window, startedAt, windowMs));
      state.windows = state.windows.filter(window => !due.includes(window));
      return due;
    },
    options
  );
  if (!taken) return summary;
  const due = taken.result;
  if (!due.length) {
    armAllWindows(taken.state, windowMs, startedAt);
    return summary;
  }

  const retryMs = Math.max(1, Number(rt.retryMs ?? PACING_RETRY_MS) || PACING_RETRY_MS);
  for (const window of due) {
    summary.flushed += 1;
    let result: PacingDeliveryResult = { ok: false, reason: '未注册投递路径' };
    try {
      result = await rt.deliverWindow(window);
    } catch (error) {
      result = { ok: false, reason: errText(error) };
    }
    if (result.ok) {
      summary.delivered += 1;
      summary.items += window.items.length;
      // `startedAt` (not `Date.now()`): the replay drives an injected clock, and
      // the promise is measured against the window's own first item.
      const late = windowIsLate(window, startedAt);
      if (late) summary.late += 1;
      await updatePacing(
        state => {
          if (late) bumpCounter(state, 'late', startedAt);
          for (const item of window.items) {
            if (!item.baseline) continue;
            // The baseline is cumulative **per pair** (`from → target`): several
            // items of one window each cite their own fact, and this counterpart
            // received all of them. Another counterpart's baseline is untouched.
            const key = baselineKey(item.from, item.target);
            if (!key) continue;
            const previous = state.lastSent[key];
            const facts = [...new Set([...(previous?.facts ?? []), ...item.baseline.facts])].sort();
            state.lastSent[key] = { ...item.baseline, facts };
          }
        },
        options
      );
      continue;
    }
    // Never drop an item: put the whole window back, **in front of** anything
    // that arrived while it was being delivered (older items keep their order).
    summary.failed += 1;
    log(`pacing flush failed for ${window.target} (${result.reason ?? 'unknown'}); keeping ${window.items.length} item(s)`);
    const attempts = (Number(window.attempts) || 0) + 1;
    const nextAt = startedAt + retryMs * Math.min(attempts, 5);
    await updatePacing(
      state => {
        const existing = windowFor(state, window.target);
        if (!existing) {
          state.windows.push({ ...window, attempts, nextAt });
          return;
        }
        // C7 (review): the retried (older) items keep the **earlier** opening
        // time — `openedAt` drives the batched envelope's `sentAt` and the
        // 5-minute lateness verdict, and taking the newer value would hide it.
        existing.openedAt = Math.min(Number(existing.openedAt) || window.openedAt, window.openedAt);
        existing.items = [...window.items, ...existing.items];
        existing.attempts = attempts;
        existing.nextAt = nextAt;
      },
      options
    );
  }

  const rest = readPacing(options);
  armAllWindows(rest, windowMs, startedAt);
  return summary;
}

/* ---------------------------------------------------------------- baselines */

/**
 * The last **delivered** message baseline of one pair (`from → target`).
 *
 * Per pair, not per session: telling `B` about a fact must not make the same
 * message to `C` look like a repeat (the C1 review case).
 */
export function lastSentOf(
  from: string | undefined,
  target: string | undefined,
  options: PacingOptions = {}
): DeltaSnapshot | undefined {
  const key = baselineKey(from, target);
  if (!key) return undefined;
  return readPacing(options).lastSent[key];
}

/** Record what **this counterpart** has received (after a successful delivery). */
export async function recordSentBaseline(
  from: string | undefined,
  target: string | undefined,
  snapshot: DeltaSnapshot,
  options: PacingOptions = {}
): Promise<void> {
  const key = baselineKey(from, target);
  if (!key) return;
  await updatePacing(
    state => {
      state.lastSent[key] = snapshot;
    },
    options
  );
}

/**
 * Record a turn the gate **suppressed**: `raw` + `noop` in one write.
 *
 * 0.10.x (`11-22-collab-metrics-dual`): a suppressed turn still *entered* the
 * delivery decision, so it counts in `raw` — the whole point of the three
 * counts is that `raw` (what the unbatched version would have sent) can be
 * compared with `kept` (what the gate let through) and `msg_count` (what was
 * delivered). Bumping only `noop` here would silently make `raw === kept`.
 */
export async function recordNoop(
  sessionID: string | undefined,
  now = Date.now(),
  options: PacingOptions = {}
): Promise<void> {
  const sid = String(sessionID ?? '').trim();
  await updatePacing(
    state => {
      bumpCounter(state, 'raw', now);
      bumpCounter(state, 'noop', now);
      if (!sid) return;
      const current = state.noops[sid] ?? { count: 0, at: 0 };
      state.noops[sid] = { count: current.count + 1, at: now };
    },
    options
  );
}

/**
 * The gate-passed turn's counter write lives with the other counters in
 * `./pacing.ts` (`recordKept`) — one implementation for the dispatch path and
 * the direct deliveries alike. Re-exported here so the public surface
 * (`__internals.recordKept`) and existing importers keep working.
 */
export { recordKept } from './pacing.ts';

/** How many turns of this session were withheld as "no increment" (read-only). */
export function noopInfo(sessionID: string | undefined, options: PacingOptions = {}): { count: number; at: number } {
  const sid = String(sessionID ?? '').trim();
  if (!sid) return { count: 0, at: 0 };
  return readPacing(options).noops[sid] ?? { count: 0, at: 0 };
}

/** Today's counters (used by the receipt, `collab_status` and the metrics row). */
export function pacingCounters(now = Date.now(), options: PacingOptions = {}): PacingDayCounters {
  return counterOf(readPacing(options), now);
}

/** Windows still buffered, oldest first (read-only — `collab_status` uses it). */
export function pendingWindows(target?: string, options: PacingOptions = {}): PacingWindow[] {
  const state = readPacing(options);
  const windows = target ? state.windows.filter(window => window.target === target) : state.windows;
  return [...windows].sort((left, right) => left.openedAt - right.openedAt);
}
