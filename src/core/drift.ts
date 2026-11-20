/**
 * 0.9.3 (`11-20-collab-drift`, R1/R2/R4/R6) — drift detection.
 *
 * The failure this exists to remove: a session finishes its mainline at 13:00,
 * nobody gives it a next item, and it runs 10.8h doing only collaboration work
 * with zero reminders. "I won't answer any more" is a self-declaration, not a
 * stop; the contract has to say so, and the plugin has to ask.
 *
 * `drifted` (design §3, **no widening**):
 *
 *   turn.noAdvanceTurns >= 5                                  // D8 — already stamped, current request counts
 *   OR mission.state === 'suspended' && parkedHours > 2       // mainline parked
 *   OR a suspended todo whose wake condition expired          // 24h fallback, D17
 *   OR a previous `[drift]` was never resolved                // `[未处置]`
 *
 * The function is **pure** (no I/O, no clock): `now` is injected, so the
 * 4th/5th turn boundary and the 24h transition are testable without waiting.
 * Writing the state back (`status:'drifted'`, `turn.driftAt`) is the caller's
 * job — `markDrifted` below is the pure half.
 */

import {
  DRIFT_NO_ADVANCE_TURNS,
  DRIFT_PARKED_MS,
  INJECT_SECTION_LIMITS
} from '../constants.ts';
import { formatAge } from './contract.ts';
import type { Contract } from './contract.ts';
import { wakeExpired, wakeLabel, wakePhrase } from './wake.ts';

export type DriftCode = 'no-advance' | 'mission-parked' | 'suspended-expired' | 'unresolved';

export interface DriftReason {
  code: DriftCode;
  /** One clause, no `[drift]` prefix and no three-choice hint (the composer adds both). */
  text: string;
}

export interface ExpiredSuspended {
  id: string;
  subject: string;
  /** Age of the suspension at evaluation time. */
  ageMs: number;
  wake: string;
  /** `等 X` / `到期 X` — ready to drop into a parenthesis. */
  phrase: string;
}

export interface DriftEvaluation {
  drifted: boolean;
  reasons: DriftReason[];
  /**
   * Consecutive no-evidence requests **including the one being rendered**. The
   * stored counter lags by one (it is stamped after the block is built), so the
   * raw value would fire one request late.
   */
  noAdvanceTurns: number;
  /** Hours the mission has been `suspended` (0 when it is not). */
  parkedHours: number;
  /** Suspended todos whose wake condition expired — to be marked `drifted`. */
  expiredSuspended: ExpiredSuspended[];
  /** The `[drift]` section (≤ `INJECT_SECTION_LIMITS.drift` lines, empty when not drifted). */
  lines: string[];
}

const HOUR = 3_600_000;

/** `turn.driftAt > 0` = a `[drift]` was shown and no three-choice resolved it. */
export function driftUnresolved(contract: Contract): boolean {
  return (Number(contract.turn?.driftAt) || 0) > 0;
}

export function evaluate(contract: Contract, now: number = Date.now()): DriftEvaluation {
  const turn = contract.turn;
  // `stampTurn` already counts the request being rendered (it is called at the
  // request start, before this turn's tool calls), so the value is used **as
  // is** — adding another `+1` here made drift fire one request late after an
  // advance and printed "连续 4 轮" for the fifth quiet request.
  const noAdvanceTurns = Math.max(0, Number(turn?.noAdvanceTurns) || 0);

  const mission = contract.mission;
  const parkedMs =
    mission.state === 'suspended' && Number(mission.parkedAt) > 0
      ? Math.max(0, now - Number(mission.parkedAt))
      : 0;
  const parkedHours = parkedMs / HOUR;

  const expiredSuspended: ExpiredSuspended[] = [];
  for (const todo of contract.todos) {
    // `drifted` rows stay in the list until a three-choice resolves them: the
    // expiry already happened, and silence is exactly what this version removes.
    if (todo.status !== 'suspended' && todo.status !== 'drifted') continue;
    const parkedAt = Number(todo.parkedAt) || Number(todo.updatedAt) || Number(todo.since) || now;
    const expiry =
      todo.status === 'drifted'
        ? { expired: true, reason: 'wakeWhen 已到期', ageMs: Math.max(0, now - parkedAt) }
        : wakeExpired(todo.wakeWhen, parkedAt, now);
    if (!expiry.expired) continue;
    expiredSuspended.push({
      id: todo.id,
      subject: todo.subject,
      ageMs: expiry.ageMs,
      wake: wakeLabel(todo.wakeWhen),
      phrase: wakePhrase(todo.wakeWhen)
    });
  }

  const reasons: DriftReason[] = [];
  if (noAdvanceTurns >= DRIFT_NO_ADVANCE_TURNS) {
    const last = Number(turn?.lastAdvancedAt) || Number(turn?.lastAt) || Number(contract.updatedAt) || now;
    reasons.push({
      code: 'no-advance',
      text: `连续 ${noAdvanceTurns} 轮无主线动作（${formatAge(Math.max(0, now - last))}）`
    });
  }
  if (parkedHours > DRIFT_PARKED_MS / HOUR) {
    // The blocker lives on the suspended todo `block` created; the mission only
    // needs its own parking stamp (design §7).
    const parkedTodo = [...contract.todos]
      .filter(todo => todo.status === 'suspended' || todo.status === 'drifted')
      .sort((a, b) => (Number(b.parkedAt) || 0) - (Number(a.parkedAt) || 0))[0];
    reasons.push({
      code: 'mission-parked',
      text: `主线已挂起 ${formatAge(parkedMs)} 未醒（${parkedTodo ? wakePhrase(parkedTodo.wakeWhen) : '等 人工唤醒'}）`
    });
  }
  if (expiredSuspended.length) {
    const oldest = expiredSuspended.reduce((max, item) => Math.max(max, item.ageMs), 0);
    const ids = expiredSuspended
      .slice(0, 3)
      .map(item => item.id)
      .join('/');
    const more = expiredSuspended.length > 3 ? ` 等 ${expiredSuspended.length} 条` : '';
    reasons.push({
      code: 'suspended-expired',
      text: `${ids}${more} 已挂起 ${formatAge(oldest)} 未醒（${expiredSuspended[0] ? expiredSuspended[0].phrase : '等 未指定'}）`
    });
  }
  const unresolved = driftUnresolved(contract);
  // An unresolved reminder stays visible **without** a fresh reason: the model
  // did nothing about it, so the next round must say so again (R2).
  if (!reasons.length && unresolved) {
    reasons.push({
      code: 'unresolved',
      text: `上次漂移提醒未处置（${formatAge(Math.max(0, now - Number(turn?.driftAt)))} 前）`
    });
  }

  const drifted = reasons.length > 0;
  const lines = drifted ? compose(reasons, unresolved) : [];
  return { drifted, reasons, noAdvanceTurns, parkedHours, expiredSuspended, lines };
}

/** `[drift]` ≤2 lines: the primary reason + the hint, then at most one more. */
function compose(reasons: DriftReason[], unresolved: boolean): string[] {
  const limit = INJECT_SECTION_LIMITS.drift;
  const primary = reasons[0];
  if (!primary) return [];
  const hint =
    primary.code === 'suspended-expired'
      ? ' → 重新评估（resume / block / done）'
      : ' → 三选一：resume / block / done';
  const marker = unresolved ? ' [未处置]' : '';
  const lines = [`[drift] ${primary.text}${hint}${marker}`];
  if (lines.length >= limit) return lines;
  const rest = reasons.slice(1);
  if (rest.length) {
    const secondary = rest.map(reason => reason.text).join(' · ');
    lines.push(`  ${secondary}`);
  }
  return lines;
}

/**
 * Pure write half: flip the expired suspended rows to `drifted` (R4: marked,
 * **never auto-closed**) and stamp `turn.driftAt` when a `[drift]` was shown.
 * `driftAt` is what makes the next round say `[未处置]`.
 */
export function markDrifted(
  contract: Contract,
  evaluation: DriftEvaluation,
  now: number
): Contract {
  const expired = new Set(evaluation.expiredSuspended.map(item => item.id));
  const todos = expired.size
    ? contract.todos.map(todo =>
        todo.status === 'suspended' && expired.has(todo.id)
          ? { ...todo, status: 'drifted' as const, updatedAt: now }
          : todo
      )
    : contract.todos;
  const driftedAt = Number(contract.turn?.driftAt) || 0;
  return {
    ...contract,
    todos,
    turn: {
      ...contract.turn,
      driftAt: evaluation.drifted ? driftedAt || now : driftedAt
    }
  };
}
