/**
 * 0.9.7 (`11-21-collab-0p9-close`, R1/R2): the **one** metric aggregation.
 *
 * Two writers produce `metrics` rows:
 *
 *   - the delivery path (`pacing.refreshMetrics`) recomputes *today* after a
 *     flush / a suppressed turn;
 *   - `rebuild` recomputes *every day the message log covers* after the
 *     projection is rebuilt.
 *
 * Both call `aggregateDay`, so the two can never drift apart. Before 0.9.7 the
 * second writer did not exist and `rebuild` silently dropped every `metrics`
 * row (measured: `metrics=1` → `metrics=0`), which made history untraceable
 * under the "one global database, kept forever" policy.
 *
 * The module is pure except `readPacingCounters` (a tolerant read of the pacing
 * file): `noop_count` / `late_count` have their only write point there. A
 * missing / unreadable / foreign-version file is `{}` — never a throw, never a
 * fabricated number; a day absent from `counters` yields `null` (unknown), not
 * `0` (F3, 0.10.x: the counters are pruned after 30 days while rebuild covers
 * 180, so `0` was a claim the data could not support).
 */
import { existsSync, readFileSync } from 'node:fs';
import { PACING_FILE, PACING_VERSION } from '../constants.ts';
import { errText, log } from '../log.ts';
import type { PacingDayCounters } from '../types.ts';

/** One `metrics` row: the four fields the pacing path owns. */
export interface DayMetricsRow {
  day: string;
  msg_count: number;
  /**
   * `null` = the counter is **unknown**, not zero. `pacing` keeps only
   * `PACING_COUNTER_KEEP_DAYS` days (30) while `rebuild` covers a 180-day
   * window, so a day older than the retention has no counters left — writing
   * `0` there claimed "nobody was suppressed that day", which is not what the
   * data says. `collab_index metrics` prints `-` for these.
   */
  noop_count: number | null;
  late_count: number | null;
  median_gap_ms: number;
}

/** Local calendar day, the same "day" the facts metrics use. */
export function dayKey(now = Date.now()): string {
  const date = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Median of the **positive** gaps between consecutive timestamps (`0` < 2 rows). */
export function medianGapMs(times: number[]): number {
  const sorted = times.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (sorted.length < 2) return 0;
  const gaps: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = sorted[index] - sorted[index - 1];
    if (gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  const middle = gaps.length >> 1;
  return gaps.length % 2 ? gaps[middle] : Math.round((gaps[middle - 1] + gaps[middle]) / 2);
}

/** A resend row (`msg_…_r1`) is a real delivery but **never** a metric unit (S10). */
export function isResendID(id: string): boolean {
  return /^msg_.+_r\d+$/.test(String(id ?? ''));
}

/**
 * One day's row — the single aggregation implementation. `times` are that day's
 * message timestamps with resend rows **already excluded** (see `timesByDay`).
 *
 * `counters === null` means the pacing counters for that day are gone (pruned
 * after the retention window) or never existed: the row carries `null`, never a
 * fabricated `0`. The delivery path always passes a real counter object (it only
 * ever writes *today*), so its rows keep real numbers.
 */
export function aggregateDay(
  day: string,
  times: number[],
  counters: PacingDayCounters | null
): DayMetricsRow {
  return {
    day,
    msg_count: times.length,
    noop_count: counters ? counters.noop : null,
    late_count: counters ? counters.late : null,
    median_gap_ms: medianGapMs(times)
  };
}

/** Group message timestamps by local day, resends excluded (shared by both writers). */
export function timesByDay(messages: { id: string; sentAt: number }[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const message of messages) {
    if (isResendID(message.id)) continue;
    const day = dayKey(message.sentAt);
    const times = groups.get(day);
    if (times) times.push(message.sentAt);
    else groups.set(day, [message.sentAt]);
  }
  return groups;
}

/**
 * Every local day the log has a message on, **resends included** (F4,
 * 0.10.x): a day whose only rows are `_r1` resends still gets a `metrics` row
 * (`msg_count: 0`), exactly like the write path produced one. Grouping on
 * `timesByDay` alone dropped that day from a rebuild — the row existed before
 * the rebuild and vanished after it.
 */
export function daysWithMessages(messages: { id: string; sentAt: number }[]): string[] {
  const days = new Set<string>();
  for (const message of messages) days.add(dayKey(message.sentAt));
  return [...days].sort((left, right) => left.localeCompare(right));
}

/** Tolerant counters normalisation: same rule as `normalizePacingState`. */
export function normalizeCounters(raw: unknown): Record<string, PacingDayCounters> {
  const out: Record<string, PacingDayCounters> = {};
  for (const [day, countersRaw] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const value = countersRaw as Record<string, unknown>;
    out[day] = {
      noop: Math.max(0, Number(value.noop) || 0),
      late: Math.max(0, Number(value.late) || 0)
    };
  }
  return out;
}

/**
 * `counters[day]` of the pacing file — the only place `noop_count` /
 * `late_count` are accumulated. Missing file, unreadable JSON or a foreign
 * version → `{}` (a rebuild then writes NULL = unknown, never `0`).
 */
export function readPacingCounters(file?: string): Record<string, PacingDayCounters> {
  const path = String(file ?? PACING_FILE);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Number(raw.v) !== PACING_VERSION) return {};
    return normalizeCounters(raw.counters);
  } catch (error) {
    log(`ignoring unreadable pacing counters ${path}: ${errText(error)}`);
    return {};
  }
}
