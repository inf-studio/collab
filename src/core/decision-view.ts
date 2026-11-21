/**
 * 0.9.7 (`11-21-collab-decision-inbox`): the **presentation** of the decision
 * inbox, shared by the GUI panel and the TUI.
 *
 * The aggregation itself (`core/decision-inbox.ts`) reads the ledger with
 * `node:fs`, so it cannot be bundled into a window. This module is the other
 * half: plain data (`SnapshotDecisions`) in, one line out — no filesystem, no
 * clock, no host. `decisionHeadline` is the count the GUI prints, and it is the
 * same number the tool's header counts, because the snapshot block is derived
 * by the same function the tool calls.
 *
 * Read-only (R5): nothing here is an action. An answer still happens in the
 * session that owns the decision.
 */
import type { SnapshotDecision, SnapshotDecisions } from '../rpc.ts';
import { formatAge } from './age.ts';

/** `truncate` without `node:fs` (this module is bundled into both windows). */
function clipText(value: unknown, max: number): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A decision's owner: a session (`ses_…`, shortened) or a human. */
export function decisionOwnerLabel(owner: unknown): string {
  const sid = String(owner ?? '').trim();
  if (!/^ses_/.test(sid)) return '人工';
  return sid.length > 9 ? `${sid.slice(0, 8)}…` : sid;
}

/** `4.2h`, or `?` when the ledger row had no usable `at`. */
export function decisionAgeText(row: SnapshotDecision): string {
  return row.unknownAt ? '?' : formatAge(row.ageMs);
}

/** The conflict TTL keeps one decimal (`19.8h`), unlike the compact `formatAge`. */
function ttlText(ms: number): string {
  return `${(Math.max(0, Number(ms) || 0) / 3_600_000).toFixed(1)}h`;
}

/**
 * One row: `#D3 · 等 ses_e176… · 4.2h · ⚠冲突（TTL 剩 19.8h） · <question≤60>`.
 *
 * The tool prefixes the key (`t_mwlp…#D3`); the GUI list has no key column, so
 * the row starts at `#D3`. An expired conflict carries **no** TTL (the remaining
 * time would be negative, and "剩 -1.2h" is noise) — it is still listed, because
 * reading must never hide a row the ledger still calls open.
 */
export function decisionRowText(row: SnapshotDecision, maxQuestion = 60): string {
  const conflict =
    row.origin === 'conflict'
      ? `⚠冲突${row.ttlLeftMs && row.ttlLeftMs > 0 ? `（TTL 剩 ${ttlText(row.ttlLeftMs)}）` : ''}`
      : '';
  return [
    `#${row.id}`,
    `等 ${decisionOwnerLabel(row.owner)}`,
    decisionAgeText(row),
    conflict,
    clipText(row.question, maxQuestion)
  ]
    .filter(Boolean)
    .join(' · ');
}

/** `待决策 3` / `待决策 3 ⚠1`; `undefined` → render nothing (an empty inbox). */
export function decisionHeadline(decisions: SnapshotDecisions | undefined): string | undefined {
  if (!decisions || decisions.total <= 0) return undefined;
  const scanned = decisions.truncated ? `（已扫描 ${decisions.scannedKeys}/${decisions.keys} key）` : '';
  return `待决策 ${decisions.total}${decisions.conflicts > 0 ? ` ⚠${decisions.conflicts}` : ''}${scanned}`;
}

/** The TUI's one detail line: `待决策 3（最老 4.2h）`; `undefined` → no line. */
export function decisionSummaryLine(decisions: SnapshotDecisions | undefined): string | undefined {
  if (!decisions || decisions.total <= 0) return undefined;
  const scanned = decisions.truncated ? ` · 已扫描 ${decisions.scannedKeys}/${decisions.keys}` : '';
  return `待决策 ${decisions.total}（最老 ${formatAge(decisions.oldestAgeMs)}${scanned}）`;
}
