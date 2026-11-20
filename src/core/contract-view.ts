/**
 * 0.9.7 (`11-21-collab-board-contract`): the **one derivation** of the contract
 * badges and detail rows, shared by the GUI panel and the TUI.
 *
 * The snapshot carries the contract as plain data (`SnapshotContract`), derived
 * server-side from `collab-contract/<sid>.json`. This module only *presents* it:
 * no filesystem, no clock of its own (`now` is passed in), no host — that is why
 * it can be bundled into both windows (`core/contract.ts` cannot: it reads
 * `node:fs`, and `core/board.ts` avoids that for the same reason).
 *
 * Two rules from the design, kept literal:
 *
 *   - the badge is **1 glyph + at most 3 digits** (the list row must not grow a
 *     line and must not wrap at `≤640px`);
 *   - the detail rows are **fixed order** 主线 → 边界 → 进度 → 待办 → 漂移, and a
 *     face with no content is hidden instead of rendered empty.
 *
 * Read-only (R4): nothing here is an action.
 */
import type { SnapshotContract } from '../rpc.ts';
import { formatAge } from './age.ts';

/** The four visual states a row badge can have (`collab-tone-*` in the GUI). */
export type ContractTone = 'danger' | 'warning' | 'info' | 'muted';

export interface ContractBadgeView {
  /** `◇` drift · `◐` parked · `◑` open work · `●` all quiet. */
  glyph: string;
  tone: ContractTone;
  /** Only the `◑` form carries a number (design §3.2), capped at `99+`. */
  count?: number | string;
  /** The hover title: what the glyph means, in words. */
  title: string;
}

/** `>99` is `99+` — the badge stays ≤4 characters wide. */
function capped(value: number): number | string {
  return value > 99 ? '99+' : value;
}

/**
 * The list badge (R2), by priority:
 *
 *   `drift.drifted`              → `◇` red
 *   `suspended + drifted > 0`    → `◐` amber
 *   `todos.open > 0`             → `◑` blue + count
 *   a contract, nothing pending  → `●` grey
 *   no contract at all           → no badge (`undefined`, no element)
 *
 * **The count is `todos.open` and nothing else.** `open` already means "every
 * unfinished todo" — the same number the injection's `[todo] N open` header and
 * `collab_todo list` print — so `blocked` / `suspended` / `drifted` are a
 * *breakdown* of it, not extra rows. Adding `blocked` on top double-counted a
 * blocked todo (`open=3, blocked=2` → `◑5`, while the detail said `3 open`).
 *
 * `undefined` is the "render nothing" answer — an empty `contract: {}` never
 * reaches here (`snapshot.ts` omits such a block), and an older server sends no
 * `contract` at all.
 */
export function contractBadge(contract: SnapshotContract | undefined): ContractBadgeView | undefined {
  if (!contract) return undefined;
  const drift = contract.drift;
  if (drift?.drifted) {
    return { glyph: '◇', tone: 'danger', title: drift.reason ? `漂移 · ${drift.reason}` : '漂移' };
  }
  const todos = contract.todos;
  const parked = Number(todos?.suspended ?? 0) + Number(todos?.drifted ?? 0);
  if (parked > 0) return { glyph: '◐', tone: 'warning', title: `${parked} 条挂起 / 漂移待办` };
  const open = Number(todos?.open ?? 0);
  if (open > 0) return { glyph: '◑', tone: 'info', count: capped(open), title: `${open} 条待办未完成` };
  return { glyph: '●', tone: 'muted', title: '契约正常' };
}

/** The full badge text (`◑3` / `◇`), for the TUI's single-line rows. */
export function contractBadgeText(contract: SnapshotContract | undefined): string {
  const badge = contractBadge(contract);
  if (!badge) return '';
  return `${badge.glyph}${badge.count === undefined ? '' : badge.count}`;
}

/** The five detail rows, in the design's fixed order. */
export type ContractRowKey = 'mission' | 'scope' | 'progress' | 'todos' | 'drift';

export interface ContractRowView {
  key: ContractRowKey;
  /** The value column; the GUI prints its own (translated) label next to it. */
  text: string;
}

/** `ses_2f7b…d0e` — the same short form the board rows use (no `node:path`). */
function shortSid(sid: string): string {
  const value = String(sid ?? '');
  return value.startsWith('ses_') && value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value || '-';
}

/** `做 排钟 / 不做 ws集群实施 · 边界→ses_…` — one line, `''` when nothing is declared. */
function scopeText(mission: NonNullable<SnapshotContract['mission']>): string {
  const bits: string[] = [];
  const inScope = (mission.inScope ?? []).filter(Boolean);
  const outOfScope = (mission.outOfScope ?? []).filter(Boolean);
  if (inScope.length) bits.push(`做 ${inScope.join(' / ')}`);
  if (outOfScope.length) bits.push(`不做 ${outOfScope.join(' / ')}`);
  const handoffTo = Object.entries(mission.handoffTo ?? {}).filter(([, sid]) => String(sid ?? '').trim());
  if (handoffTo.length) {
    bits.push(handoffTo.map(([boundary, sid]) => `${boundary}→${shortSid(String(sid))}`).join(' · '));
  }
  return bits.join(' · ');
}

/**
 * The detail rows (R3): 主线 / 边界 / 进度 / 待办 / 漂移, each one line and each
 * omitted when it has no content. No contract → no rows (the caller renders no
 * block at all, so a contract-less session stays byte-identical to 0.9.6).
 */
export function contractRows(contract: SnapshotContract | undefined, now = Date.now()): ContractRowView[] {
  if (!contract) return [];
  const rows: ContractRowView[] = [];

  const mission = contract.mission;
  if (mission) {
    const oneLine = String(mission.oneLine ?? '').trim();
    const flag = mission.confirmed ? '（已确认）' : '（未确认）';
    const state = mission.state && mission.state !== 'active' ? ` · ${mission.state}` : '';
    rows.push({ key: 'mission', text: `${oneLine}${flag}${state}` });
  }

  const scope = mission ? scopeText(mission) : '';
  if (scope) rows.push({ key: 'scope', text: scope });

  const progress = contract.progress;
  if (progress && Number(progress.total) > 0) {
    const next = String(progress.next ?? '').trim();
    rows.push({
      key: 'progress',
      text: `${Number(progress.lit) || 0}/${Number(progress.total) || 0}${next ? ` · 下一里程碑 ${next}` : ''}`
    });
  }

  const todos = contract.todos;
  if (todos) {
    rows.push({
      key: 'todos',
      text:
        `${Number(todos.open) || 0} open · ${Number(todos.blocked) || 0} blocked · ` +
        `${Number(todos.suspended) || 0} suspended · ${Number(todos.drifted) || 0} drifted`
    });
  }

  const drift = contract.drift;
  if (drift?.drifted) {
    const reason = String(drift.reason ?? '').trim();
    const age = drift.since ? formatAge(now - Number(drift.since)) : '';
    rows.push({ key: 'drift', text: reason || `漂移${age ? `（${age}）` : ''} · 未处置` });
  }

  return rows;
}

/**
 * The TUI's single summary line (design §3.3): `主线 排钟 B4 接线 · M2/5 · todo 3 · drift 11h`.
 * Every part is optional; a contract with nothing to summarize yields `undefined`
 * and the TUI appends no line at all (byte-identical rows for 0.9.6 sessions).
 */
export function contractSummary(contract: SnapshotContract | undefined, now = Date.now()): string | undefined {
  if (!contract) return undefined;
  const parts: string[] = [];
  const oneLine = String(contract.mission?.oneLine ?? '').trim();
  if (oneLine) parts.push(`主线 ${oneLine}`);
  const progress = contract.progress;
  if (progress && Number(progress.total) > 0) {
    parts.push(`${Number(progress.lit) || 0}/${Number(progress.total) || 0}`);
  }
  const todos = contract.todos;
  if (todos) parts.push(`todo ${Number(todos.open) || 0}`);
  const drift = contract.drift;
  if (drift?.drifted) {
    parts.push(drift.since ? `drift ${formatAge(now - Number(drift.since))}` : 'drift');
  }
  return parts.length ? parts.join(' · ') : undefined;
}
