/**
 * 0.9.3 (`11-20-collab-drift`, R3/R4) — `wakeWhen`: what a suspended item is
 * waiting for, and whether that wait has expired.
 *
 *   { kind:"reply",    ref:"ses_…" }   some session replies
 *   { kind:"decision", ref:"D3"     }  a decision gets answered
 *   { kind:"time",     at:<epoch ms>}  a deadline (must be in the future)
 *   { kind:"manual"               }   only a human wakes it
 *
 * Two rules that matter:
 *
 *   - **No timer**: expiry is evaluated by the `context` hook on every request
 *     (`drift.ts` → `evaluate`). A background timer would die with the plugin
 *     process and silently keep a parked item parked (design §5).
 *   - **`manual` still has the 24h fallback** (D17). "Manual" only means the
 *     plugin cannot wake it from a reply / decision / deadline automatically —
 *     a park nobody ever looks at again turns `drifted` after 24h like any
 *     other. Do not read `manual` as "wait forever".
 *   - **Legacy strings stay valid**: 0.9.1 stored free text (`等 owner 回 D3`)
 *     and those files are still on disk. A string is accepted and behaves as
 *     `manual` for expiry purposes; it is never rewritten behind the model's
 *     back.
 *
 * Unlike `drift.ts` this module imports nothing but the constants and `util` —
 * it is the leaf both `contract.ts` (normalisation) and `drift.ts` (evaluation)
 * depend on.
 */

import { CONTRACT_WAKE_CHARS, SUSPEND_FALLBACK_MS, WAKE_KINDS } from '../constants.ts';
import { truncate } from '../util.ts';

export type WakeWhenKind = (typeof WAKE_KINDS)[number];

export interface WakeWhen {
  kind: WakeWhenKind;
  /** `reply`: the session id; `decision`: the decision id. */
  ref?: string;
  /** `time`: the deadline (epoch ms). */
  at?: number;
}

/** Stored shape: a structured value, a legacy free-text string, or nothing. */
export type WakeWhenValue = WakeWhen | string;

const text = (value: unknown, max: number): string => truncate(value, max);

function asKind(value: unknown): WakeWhenKind | undefined {
  const kind = String(value ?? '').trim();
  return (WAKE_KINDS as readonly string[]).includes(kind) ? (kind as WakeWhenKind) : undefined;
}

/**
 * Tolerant read: a stored value is normalised to `WakeWhen | string | null`.
 * An object with an unknown `kind` is **dropped** (it would claim a wake
 * condition that can never fire); junk is never allowed to throw.
 */
export function normalizeWakeWhen(value: unknown): WakeWhenValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return text(value, CONTRACT_WAKE_CHARS) || null;
  if (typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const kind = asKind(raw.kind);
  if (!kind) return null;
  const wake: WakeWhen = { kind };
  const ref = text(raw.ref, CONTRACT_WAKE_CHARS);
  if (ref) wake.ref = ref;
  const at = Number(raw.at);
  if (Number.isFinite(at) && at > 0) wake.at = at;
  // A deadline without a time or a wait without a target cannot ever expire
  // for the right reason — refuse the shape instead of parking forever.
  if (kind === 'time' && !wake.at) return null;
  if ((kind === 'reply' || kind === 'decision') && !wake.ref) return null;
  return wake;
}

/**
 * Tool input → validated value. `now` is injected so the `time` rule
 * (`at > now`) is testable without waiting.
 */
export function parseWakeWhen(value: unknown, now: number): { ok: true; wake: WakeWhenValue } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: false, error: '缺 wakeWhen' };
  if (typeof value === 'string') {
    const note = text(value, CONTRACT_WAKE_CHARS);
    if (!note) return { ok: false, error: 'wakeWhen 不能是空字符串' };
    return { ok: true, wake: note };
  }
  if (typeof value !== 'object') {
    return { ok: false, error: `wakeWhen 必须是字符串或对象（收到 ${typeof value}）` };
  }
  const raw = value as Record<string, unknown>;
  const kind = asKind(raw.kind);
  if (!kind) {
    return { ok: false, error: `wakeWhen.kind 必须是 ${WAKE_KINDS.join(' | ')}` };
  }
  if (kind === 'time') {
    const at = Number(raw.at);
    if (!Number.isFinite(at) || at <= 0) return { ok: false, error: 'wakeWhen.kind="time" 必须给 at（epoch ms）' };
    if (at <= now) {
      return {
        ok: false,
        error: `wakeWhen.at 已过期（${new Date(at).toISOString()} ≤ now）：挂起到一个过去的时间等于直接丢弃`
      };
    }
    return { ok: true, wake: { kind, at } };
  }
  if (kind === 'reply' || kind === 'decision') {
    const ref = text(raw.ref, CONTRACT_WAKE_CHARS);
    if (!ref) {
      return { ok: false, error: `wakeWhen.kind="${kind}" 必须给 ref（${kind === 'reply' ? '会话 id' : '决策 id'}）` };
    }
    return { ok: true, wake: { kind, ref } };
  }
  return { ok: true, wake: { kind: 'manual' } };
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** `11-20 12:46` in the **local** timezone (same shape as the other time displays). */
function localStamp(at: number): string {
  const date = new Date(Number(at) || 0);
  if (Number.isNaN(date.getTime())) return '时间未定';
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** One short human label, **without** a leading `等` (callers add the prefix). */
export function wakeLabel(value: WakeWhenValue | null | undefined): string {
  if (!value) return '未指定';
  if (typeof value === 'string') {
    const note = value.trim().replace(/^等\s*/, '');
    return note || '人工唤醒';
  }
  switch (value.kind) {
    case 'reply':
      return `${value.ref} 回复`;
    case 'decision':
      return `决策 ${value.ref}`;
    case 'time':
      return localStamp(Number(value.at) || 0);
    default:
      return '人工唤醒';
  }
}

/**
 * The label as it appears in `suspended(…)` / `挂起(…)` / `[drift]`:
 * `等 <label>` for waits, `到期 <label>` for a recorded deadline (never
 * `等 到期`, and never a UTC `T…Z` stamp — every other time here is local).
 */
export function wakePhrase(value: WakeWhenValue | null | undefined): string {
  const label = wakeLabel(value);
  if (typeof value === 'object' && value && value.kind === 'time') return `到期 ${label}`;
  return `等 ${label}`;
}

/** Why (and whether) a suspended item's wake condition has expired. */
export interface WakeExpiry {
  expired: boolean;
  /** Short, human-readable cause for the `[drift]` line. */
  reason: string;
  /** The age of the suspension, whatever the verdict. */
  ageMs: number;
}

/**
 * `parkedAt` is the todo's own stamp (fallback `updatedAt` / `since`).
 *
 *   - `kind:"time"` → expired the moment `at` passes.
 *   - anything else (`reply` / `decision` / **`manual`**) → the 24h fallback
 *     (D17): the plugin cannot observe a reply or a decision for free, and an
 *     item nobody ever looks at again is exactly the failure this version
 *     exists to remove. `manual` means "no automatic trigger", **not** "never
 *     expires".
 */
export function wakeExpired(value: WakeWhenValue | null | undefined, parkedAt: number, now: number): WakeExpiry {
  const ageMs = Math.max(0, Number(now) - (Number(parkedAt) || Number(now)));
  if (!value) return { expired: false, reason: '', ageMs };
  if (typeof value !== 'string' && value.kind === 'time') {
    const at = Number(value.at) || 0;
    if (at && at <= now) return { expired: true, reason: 'wakeWhen 已到期', ageMs };
    return { expired: false, reason: '', ageMs };
  }
  if (ageMs > SUSPEND_FALLBACK_MS) {
    return { expired: true, reason: `${Math.round((ageMs / 3_600_000) * 10) / 10}h 未醒`, ageMs };
  }
  return { expired: false, reason: '', ageMs };
}
