/**
 * 0.9.7 (`11-21-collab-decision-inbox`): the **human decision inbox** — every
 * open decision of the machine, oldest first, in one read-only list.
 *
 * 0.9.5's ledger was visible only to the parties: `[decide]` is injected into the
 * asker / owner, and `collab_decide list` needs a `key`. A human asking "what is
 * waiting on me right now?" had to open each session and read its injection —
 * i.e. the human was demoted to a router. This module aggregates the same ledger
 * (`collab-decisions/*.json`) and writes nothing:
 *
 *   - `status === 'open'` only (`answered` / `superseded` are history);
 *   - `age = now − at` (`at` missing → 0 + `?`, never a negative age);
 *   - `origin === 'conflict'` → a marker plus the remaining 24h TTL (an expired
 *     one shows no TTL at all — the value would be negative);
 *   - sorted by `at` **ascending** (the oldest wait is on top);
 *   - a missing directory is an empty inbox, **never** a `mkdir`;
 *   - a corrupt file is skipped (`readDecisions` logs once and returns empty).
 *
 * **Do not reuse `readAllDecisions` here.** That helper is bounded by
 * `.sort().slice(-500)` — it keeps the lexicographically **largest** 500 keys,
 * which for thread / bid ids is roughly the *newest* ones. An inbox built on it
 * silently dropped the oldest waits (and reported `total: 500` for a 520-key
 * ledger; review finding: `k0001` missing). The inbox therefore reads the
 * directory itself, with an explicit, visible scan bound:
 *
 *   - `DECISION_INBOX_SCAN_LIMIT` (default 2000) caps how many files are read;
 *   - beyond it the answer says `已扫描 M/N 个 key` and prints
 *     `⚠账本 N 个 key，仅扫描 M 个（可能漏更老待办）` — it never presents the
 *     scanned subset as "all open decisions";
 *   - the scanned set is the **newest-named** `M` keys (the old behaviour), so
 *     the warning is accurate: the older rows may be missing.
 *
 * A 2 s mtime + file-count cache keeps the board's 2 s poll from re-reading the
 * whole ledger every tick (2 s is the poll period; every write goes through
 * `tmp + rename`, which updates the directory mtime, so a real change always
 * invalidates the cache).
 *
 * Derivation only: the tool (`collab_decision_inbox`), the snapshot block and
 * therefore both windows read this one function, so the GUI count can never
 * disagree with the tool's count.
 */
import { readdirSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import {
  CONFLICT_DECISION_TTL_MS,
  DECISION_INBOX_CACHE_MS,
  DECISION_INBOX_LIMIT,
  DECISION_INBOX_SCAN_LIMIT
} from '../constants.ts';
import type { SnapshotDecision, SnapshotDecisions } from '../rpc.ts';
import { formatAge } from './age.ts';
import { decisionsDir, readDecisions, type DecisionFile } from './decisions.ts';
import { decisionRowText } from './decision-view.ts';

export type DecisionInboxRow = SnapshotDecision;

export interface DecisionInboxOptions {
  /** `COLLAB_DECISIONS_DIR` override (tests); default is the global ledger. */
  directory?: string;
  now?: number;
  /** Only the decisions waiting on this session (`ses_…`). */
  owner?: string;
  /**
   * Read at most this many ledger files (default `DECISION_INBOX_SCAN_LIMIT`).
   * Test-only override, used to prove the explicit warning without writing
   * 2000 files.
   */
  scanLimit?: number;
}

export interface DecisionInbox {
  /** Every matching open decision **among the scanned keys**, oldest first. */
  rows: DecisionInboxRow[];
  /** Open decisions found in the scanned keys (see `truncated`). */
  total: number;
  conflicts: number;
  oldestAgeMs: number;
  /** Ledger files present in the directory. */
  totalKeys: number;
  /** How many of them were actually read. */
  scannedKeys: number;
  /** `scannedKeys < totalKeys` — the answer is a subset and says so. */
  truncated: boolean;
}

interface LedgerScan {
  keys: string[];
  totalKeys: number;
  files: DecisionFile[];
}

/**
 * `directory mtime + file count + scanLimit` → parsed ledger files, kept for
 * `DECISION_INBOX_CACHE_MS`. Every writer in this package uses `tmp + rename`
 * inside the directory, which bumps the directory mtime; an in-place edit that
 * somehow keeps both stamp and count stale for 2 s is the accepted bound (the
 * board polls at 2 s anyway).
 */
const scanCache = new Map<string, { stamp: string; at: number; scan: LedgerScan }>();

function listKeys(directory?: string): { keys: string[]; stamp: string } {
  const dir = decisionsDir(directory);
  try {
    // `statSync` first: a missing directory is an empty answer, never a mkdir.
    const info = statSync(dir);
    const names = readdirSync(dir)
      .filter(name => name.endsWith('.json') && !name.includes('.tmp'))
      .sort();
    return { keys: names.map(name => basename(name, '.json')), stamp: `${info.mtimeMs}:${names.length}` };
  } catch {
    return { keys: [], stamp: '' };
  }
}

function scanLedger(directory: string | undefined, limit: number): LedgerScan {
  const { keys: allKeys, stamp } = listKeys(directory);
  if (!allKeys.length) return { keys: [], totalKeys: 0, files: [] };
  const dir = decisionsDir(directory);
  const cacheKey = `${dir}\u0000${limit}`;
  const now = Date.now();
  const hit = scanCache.get(cacheKey);
  if (hit && hit.stamp === stamp && now - hit.at < DECISION_INBOX_CACHE_MS) return hit.scan;

  // The scanned set is the newest-named `limit` keys; the warning says the older
  // ones may be missing instead of pretending they do not exist.
  const keys = allKeys.length > limit ? allKeys.slice(-limit) : allKeys;
  const files = keys.map(key => readDecisions(key, directory)).filter(file => file.items.length > 0);
  const scan: LedgerScan = { keys, totalKeys: allKeys.length, files };
  scanCache.set(cacheKey, { stamp, at: now, scan });
  return scan;
}

function toRow(
  key: string,
  item: { id: string; question: string; owner: string; at: number; origin: string },
  now: number
): DecisionInboxRow {
  const at = Number(item.at) || 0;
  const ageMs = at > 0 ? Math.max(0, now - at) : 0;
  const conflict = item.origin === 'conflict';
  const ttlLeftMs = conflict ? CONFLICT_DECISION_TTL_MS - ageMs : 0;
  return {
    key,
    id: item.id,
    question: item.question,
    owner: item.owner,
    at,
    ageMs,
    origin: conflict ? 'conflict' : 'manual',
    // An expired conflict no longer shows a TTL (a negative "remain" is noise).
    ...(conflict && ttlLeftMs > 0 ? { ttlLeftMs } : {}),
    ...(at > 0 ? {} : { unknownAt: true })
  };
}

/**
 * Read the ledger and derive the inbox. Pure read: never creates the directory
 * and never writes a file (R5). Bounded reading is explicit (`scanLimit`).
 */
export function decisionInbox(options: DecisionInboxOptions = {}): DecisionInbox {
  const now = Number(options.now) || Date.now();
  const owner = String(options.owner ?? '').trim();
  const limit = Math.max(1, Number(options.scanLimit) || DECISION_INBOX_SCAN_LIMIT);
  const scan = scanLedger(options.directory, limit);
  const rows: DecisionInboxRow[] = [];
  for (const file of scan.files) {
    for (const item of file.items) {
      if (item.status !== 'open') continue;
      if (owner && item.owner !== owner) continue;
      rows.push(toRow(file.key, item, now));
    }
  }
  // `at` ascending = the longest wait on top (PRD R1). The key / id tie-break
  // keeps two polls of one snapshot byte-identical (same order every time).
  rows.sort(
    (left, right) =>
      left.at - right.at || left.key.localeCompare(right.key) || left.id.localeCompare(right.id)
  );
  const conflicts = rows.filter(row => row.origin === 'conflict').length;
  return {
    rows,
    total: rows.length,
    conflicts,
    oldestAgeMs: rows.reduce((max, row) => Math.max(max, row.ageMs), 0),
    totalKeys: scan.totalKeys,
    scannedKeys: scan.keys.length,
    truncated: scan.keys.length < scan.totalKeys
  };
}

/**
 * The tool's answer: header, rows (≤ limit), truncation line, totals, read-only.
 *
 * A truncated scan never says `共 N 条` — that would present the scanned subset
 * as the whole ledger. It says `已扫描 M/N 个 key` and warns explicitly.
 */
export function formatDecisionInbox(
  inbox: DecisionInbox,
  options: { owner?: string; limit?: number } = {}
): string {
  const owner = String(options.owner ?? '').trim();
  const limit = Math.max(1, Number(options.limit) || DECISION_INBOX_LIMIT);
  const warning = `⚠账本 ${inbox.totalKeys} 个 key，仅扫描 ${inbox.scannedKeys} 个（可能漏更老待办）`;
  if (!inbox.total) {
    return [
      `无待决策${owner ? `（owner=${owner} 名下没有 open 决策）` : '（collab-decisions/ 为空或不存在）'}${
        inbox.truncated ? `（已扫描 ${inbox.scannedKeys}/${inbox.totalKeys} 个 key）` : ''
      }`,
      ...(inbox.truncated ? [warning] : []),
      '只读：未写入、未投递（账本不存在时也不会创建目录）。'
    ].join('\n');
  }
  const shown = inbox.rows.slice(0, limit);
  const scanned = inbox.truncated ? `（已扫描 ${inbox.scannedKeys}/${inbox.totalKeys} 个 key）` : '';
  return [
    `待决策 ${inbox.total} 条${inbox.conflicts ? `（冲突 ${inbox.conflicts}）` : ''}${scanned} · 最老 ${formatAge(inbox.oldestAgeMs)}`,
    ...(inbox.truncated ? [warning] : []),
    ...shown.map(row => `  ${row.key}${decisionRowText(row)}`),
    ...(inbox.total > shown.length ? [`还有 ${inbox.total - shown.length} 条未显示（limit=${limit}）`] : []),
    inbox.truncated
      ? `已扫描 ${inbox.scannedKeys}/${inbox.totalKeys} 个 key · 其中冲突 ${inbox.conflicts} 条`
      : `共 ${inbox.total} 条 · 其中冲突 ${inbox.conflicts} 条`,
    '只读：未写入、未投递。'
  ].join('\n');
}

/** The snapshot's optional block (absent when there is nothing open). */
export function snapshotDecisions(now: number, directory?: string): SnapshotDecisions | undefined {
  const inbox = decisionInbox({ now, directory });
  if (!inbox.total) return undefined;
  return {
    total: inbox.total,
    conflicts: inbox.conflicts,
    oldestAgeMs: inbox.oldestAgeMs,
    items: inbox.rows.slice(0, DECISION_INBOX_LIMIT),
    ...(inbox.truncated
      ? { truncated: true, keys: inbox.totalKeys, scannedKeys: inbox.scannedKeys }
      : {})
  };
}
