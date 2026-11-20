/**
 * D1 (0.4.0): the **owner review queue** — the compliant way to reach a
 * protected session.
 *
 * `BUILTIN_PROTECT` is a one-way hard boundary: nothing can be *pushed* into
 * those sessions (and their descendants), which is exactly what protects the
 * schema line. The pilot's D1 showed the cost of that boundary without an
 * alternative: a legitimate cross-line request could only degrade into
 * "broadcast → spawned explore → BLOCKED".
 *
 * This module adds the one thing that does not weaken the guard — a **pull**:
 *
 *   1. a non-protected session writes one JSON file per request into
 *      `~/.config/opencode/collab-owner-queue/<targetSid>/<queueId>.json`;
 *   2. the protected session sees 1–3 read-only lines in its own `context`
 *      injection and stamps them `seenAt` **after** the block was pushed (the
 *      same F1 rule as `followUps`);
 *   3. the sender can list / revoke its own pending items.
 *
 * What is deliberately **not** here: `session.prompt`, an inbox entry, a
 * hand-off record, a bid, a thread, a lock. Writing a queue item produces
 * **zero** model calls and changes **no** collaboration state — an item is not
 * a delivery, it is a note on the owner's desk.
 *
 * Sanitisation: `summary` is the sender's own text (≤500 chars, control
 * characters stripped, whitespace collapsed), so rendering it cannot forge
 * lines. `issuePath` is only *syntactically* validated here (relative,
 * `docs/issues/*.md`, no `..`, no absolute path): the target workspace may not
 * even be on this machine, so there is no `realpath` to check — and because the
 * owner reads the file itself, under its own permissions, a bad path costs
 * nothing.
 *
 * 0.4.1 (R1): `unseenCandidates` returns every unread item with its `at` /
 * `bid` / `issuePath`, so the render layer can merge these lines with the
 * pending `followUps` hints and show one line per proposal (newest wins; any
 * shared `bid` / `issuePath` key groups them, transitively). The cap is applied
 * by that caller, *after* the merge.
 */
import { mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OWNER_QUEUE_DIR,
  OWNER_QUEUE_HINT_CHARS,
  OWNER_QUEUE_ISSUE_LIMIT,
  OWNER_QUEUE_LIMIT,
  OWNER_QUEUE_PRUNE_LIMIT,
  OWNER_QUEUE_RETENTION_MS,
  OWNER_QUEUE_SUMMARY_LIMIT
} from '../constants.ts';
import type { OwnerQueueItem } from '../types.ts';
import { asObject, randToken, readJsonFile, shortID } from '../util.ts';
import { mirrorQueue } from './index-sync.ts';
import { invalid } from './errors.ts';

/**
 * A session id is used as a **directory name**, so it is validated first: a sid
 * containing `/` (or `..`) must never be able to escape `<OWNER_QUEUE_DIR>`.
 * Host ids are `ses_<alnum>`; the pattern is deliberately a superset so an
 * older / odd host spelling still works while separators stay impossible.
 */
function safeSid(value: unknown): string {
  const sid = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sid)) throw invalid(`非法的会话 id：${JSON.stringify(sid)}`);
  return sid;
}

/** One target's directory (`<OWNER_QUEUE_DIR>/<targetSid>`). */
export function queueDir(targetSid: string): string {
  return join(OWNER_QUEUE_DIR, safeSid(targetSid));
}

/** `q_<base36ts>_<rand4>` — ordering is display-only (`at` is the truth). */
export function queueID(now = Date.now()): string {
  return `q_${now.toString(36)}_${randToken()}`;
}

export function isValidQueueID(value: unknown): boolean {
  return /^q_[0-9a-z]+_[0-9a-z]{1,8}$/.test(String(value ?? '').trim());
}

/**
 * The one text field of a queue item: control characters (including newlines)
 * become spaces, runs collapse, the result is capped at `OWNER_QUEUE_SUMMARY_LIMIT`.
 * A summary therefore can never introduce a second injected line.
 */
export function sanitizeSummary(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, OWNER_QUEUE_SUMMARY_LIMIT);
}

export type QueueIssuePathCheck = { ok: true; issuePath: string } | { ok: false; reason: string };

/**
 * **Syntax only** — no fs access, on purpose (see the module comment). Accepts
 * `docs/issues/<name>.md`, with `.`/empty segments collapsed; refuses `..`,
 * absolute paths, other directories and non-`.md` names.
 */
export function validateQueueIssuePath(raw: unknown): QueueIssuePathCheck {
  const text = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return { ok: false, reason: 'issuePath 为空' };
  // Refused, not truncated: a cut path would name a file nobody asked for (and
  // could hide a `..` beyond the cut).
  if (text.length > OWNER_QUEUE_ISSUE_LIMIT) {
    return { ok: false, reason: `issuePath 过长（上限 ${OWNER_QUEUE_ISSUE_LIMIT} 字符）：${text.slice(0, 60)}…` };
  }
  if (text.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(text)) {
    return { ok: false, reason: `issuePath 不能是绝对路径：${text}` };
  }
  const parts = text.split('/').filter(part => part && part !== '.');
  if (parts.includes('..')) return { ok: false, reason: `issuePath 不能包含 ..：${text}` };
  const clean = parts.join('/');
  if (!/^docs\/issues\/[^/]+\.md$/i.test(clean)) {
    return { ok: false, reason: `issuePath 必须是 docs/issues/<name>.md：${clean || text}` };
  }
  return { ok: true, issuePath: clean };
}

/** Tolerant read: anything without an id/at/target is not a queue item. */
export function normalizeQueueItem(raw: unknown, targetSid: string, fallbackID?: string): OwnerQueueItem | undefined {
  const value = asObject(raw);
  const id = String(value.id ?? fallbackID ?? '').trim();
  const target = String(value.target ?? targetSid).trim();
  const from = String(value.from ?? '').trim();
  const at = Number(value.at) || 0;
  if (!id || !target || !from || !at) return undefined;
  // Re-validate on read: the injected line renders this field, so a hand-written
  // / tampered file must not be able to smuggle a newline (or a path nobody
  // validated) into a protected session's request. An unusable path renders as
  // `-` instead of failing the whole item.
  const issueCheck = value.issuePath ? validateQueueIssuePath(value.issuePath) : undefined;
  return {
    id,
    target,
    from,
    at,
    summary: sanitizeSummary(value.summary),
    issuePath: issueCheck?.ok ? issueCheck.issuePath : null,
    bid: value.bid ? String(value.bid) : null,
    // 0.6.0 (`collab_escalate`): additive display marker, tolerated on read.
    ...(value.priority === 'urgent' ? { priority: 'urgent' as const } : {}),
    revokedAt: Number(value.revokedAt) || null,
    seenAt: Number(value.seenAt) || null
  };
}

export function readQueueItem(targetSid: string, id: string): OwnerQueueItem | undefined {
  if (!isValidQueueID(id)) return undefined;
  return normalizeQueueItem(readJsonFile(join(queueDir(targetSid), `${id}.json`)), targetSid, id);
}

/** Every readable item of one target, oldest first. */
export function listFor(targetSid: string): OwnerQueueItem[] {
  if (!targetSid) return [];
  let names: string[];
  try {
    names = readdirSync(queueDir(targetSid));
  } catch {
    return []; // no directory yet: this target has never been queued to
  }
  const out: OwnerQueueItem[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    const item = readQueueItem(targetSid, id);
    if (item && item.id === id) out.push(item);
  }
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/**
 * Everything **this session** submitted, across targets — the requester's own
 * view (`collab_list`). One `readdir` of the base directory + one per target
 * that has items; a missing base directory is simply "nothing pending".
 */
export function mineFor(fromSid: string): OwnerQueueItem[] {
  const me = String(fromSid ?? '').trim();
  if (!me) return [];
  let targets: string[];
  try {
    targets = readdirSync(OWNER_QUEUE_DIR);
  } catch {
    return [];
  }
  const out: OwnerQueueItem[] = [];
  for (const target of targets) {
    for (const item of listFor(target)) {
      if (item.from === me) out.push(item);
    }
  }
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/**
 * 0.9.0 (R5): every queue item of every target — the projection's `queue` table
 * source. Read-only (`listFor` already refuses a missing directory), ordered
 * oldest first so a rebuild is deterministic.
 */
export function allQueueItems(): OwnerQueueItem[] {
  let targets: string[];
  try {
    targets = readdirSync(OWNER_QUEUE_DIR);
  } catch {
    return [];
  }
  const out: OwnerQueueItem[] = [];
  for (const target of targets) out.push(...listFor(target));
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

export interface EnqueueInput {
  target: string;
  from: string;
  text: unknown;
  issuePath?: unknown;
  bid?: unknown;
  /**
   * 0.6.0 (`collab_escalate`): mark the item urgent. Display only — the FIFO
   * contract of this queue (oldest first) is unchanged.
   */
  priority?: 'urgent';
  /** Injectable clock (tests / deterministic rendering). */
  now?: number;
}

/**
 * Sweep the items the owner already read and that are older than the retention
 * window. Without it a seen item would live forever: `collab_list` would keep
 * reporting it, and — before the cap counted only unread items — the queue could
 * stay "full" after the owner had read everything. Bounded per write, like the
 * broadcast prune, so one enqueue never deletes a whole directory at once.
 * Never throws: a failed sweep only leaves a file for the next write.
 */
export function pruneSeen(targetSid: string, now = Date.now()): number {
  let removed = 0;
  try {
    for (const item of listFor(targetSid)) {
      if (removed >= OWNER_QUEUE_PRUNE_LIMIT) break;
      if (!item.seenAt || now - Number(item.seenAt) < OWNER_QUEUE_RETENTION_MS) continue;
      try {
        unlinkSync(join(queueDir(item.target), `${item.id}.json`));
        removed += 1;
      } catch {
        // already gone / unreadable: nothing to reclaim
      }
    }
  } catch {
    // best effort (see above)
  }
  return removed;
}

/**
 * Write one item. Atomic (`tmp + rename`), and **refuses** a full queue
 * (`OWNER_QUEUE_LIMIT` **unread** items) instead of evicting: the oldest
 * request is still someone's question, dropping it is the silent loss this
 * queue exists to avoid. Read items are not backlog — they never count toward
 * the cap and are swept once they are older than `OWNER_QUEUE_RETENTION_MS`.
 *
 * Throws `ValidationError` for caller-fixable input (empty summary, bad
 * `issuePath`, full queue) so the defect reporter never files them.
 */
export function enqueue({ target, from, text, issuePath, bid, priority, now = Date.now() }: EnqueueInput): OwnerQueueItem {
  const summary = sanitizeSummary(text);
  if (!summary) throw invalid('text 不能为空：队列项需要一句话说明请求（≤500 字，会去掉控制字符）');
  let cleanIssue: string | null = null;
  if (issuePath !== undefined && issuePath !== null && String(issuePath).trim() !== '') {
    const check = validateQueueIssuePath(issuePath);
    if (!check.ok) throw invalid(check.reason);
    cleanIssue = check.issuePath;
  }
  pruneSeen(String(target), now);
  const existing = listFor(String(target));
  const pending = existing.filter(item => !item.seenAt);
  if (pending.length >= OWNER_QUEUE_LIMIT) {
    throw invalid(
      `拒绝写入：该目标队列已满（${OWNER_QUEUE_LIMIT} 条未读）。` +
        `请让对方先运行一次（它会看到只读提示），或撤回自己的一条` +
        `（collab_request_owner { id, revoke:true, confirm:true }）。未写入任何内容。`
    );
  }
  // FIFO is the contract of this queue ("oldest first, ≤3 per injection"), and
  // two items written in the same millisecond would otherwise be ordered by a
  // random id. `at` is therefore strictly increasing per target — a sub-ms bump,
  // invisible in the rendered `HH:MM`.
  const latest = existing.reduce((max, item) => Math.max(max, Number(item.at) || 0), 0);
  const at = latest >= now ? latest + 1 : now;
  const item: OwnerQueueItem = {
    id: queueID(at),
    target: String(target),
    from: String(from),
    at,
    summary,
    issuePath: cleanIssue,
    bid: bid ? String(bid) : null,
    ...(priority === 'urgent' ? { priority: 'urgent' as const } : {}),
    revokedAt: null,
    seenAt: null
  };
  mkdirSync(queueDir(item.target), { recursive: true });
  const file = join(queueDir(item.target), `${item.id}.json`);
  const tmp = `${file}.${randToken()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(item, null, 2)}\n`);
  renameSync(tmp, file);
  // 0.9.0 (R5): the `queue` table is a snapshot of every item, so a write mirrors
  // the whole list (it is small and bounded by the owner-queue limits).
  mirrorQueue(allQueueItems());
  return item;
}

/**
 * Remove one item — only the session that wrote it (`from === me`). Returns the
 * removed item so the caller can print what it withdrew. A missing / unreadable
 * file is a readable error, not a silent success.
 */
export function revoke(targetSid: string, id: string, by: string): OwnerQueueItem | undefined {
  const item = readQueueItem(String(targetSid), String(id));
  if (!item) return undefined;
  if (item.from !== String(by)) return undefined;
  try {
    unlinkSync(join(queueDir(item.target), `${item.id}.json`));
  } catch {
    return undefined;
  }
  mirrorQueue(allQueueItems());
  return item;
}

/** `HH:MM` of an item (the injected / listed line format, design §3). */
function hhmm(at: number): string {
  const d = new Date(Number(at) || 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * The line an owner sees for one item. It carries no instruction and no reply
 * request — `summary` is the sender's own words, capped, and the rest is
 * `from` / time / proposal path:
 *   `- [owner-queue] <from short id> @ <HH:MM>：<summary ≤120>（<issuePath 或 ->）`
 */
function hintLine(item: OwnerQueueItem): string {
  return (
    `- [owner-queue]${item.priority === 'urgent' ? ' [urgent]' : ''} ${shortID(item.from)} @ ${hhmm(item.at)}：` +
    `${item.summary.slice(0, OWNER_QUEUE_HINT_CHARS)}（${item.issuePath ?? '-'}）`
  );
}

/**
 * R1 (0.4.1): one unread item, with the fields the render layer
 * de-duplicates on — `bid` / `issuePath` — plus the line itself.
 */
export interface OwnerQueueCandidate {
  id: string;
  at: number;
  bid?: string;
  issuePath?: string;
  line: string;
}

/**
 * **All** unread items of one target, oldest first, as render candidates. The
 * cap belongs to the caller: the protected injection merges these with the
 * pending `followUps` lines, de-duplicates by proposal and *then* keeps at most
 * `OWNER_QUEUE_HINT_LIMIT` — so the three it renders are the three oldest that
 * survived, not the three oldest items regardless of overlap.
 */
export function unseenCandidates(targetSid: string): OwnerQueueCandidate[] {
  return listFor(targetSid)
    .filter(item => !item.seenAt)
    .map(item => ({
      id: item.id,
      at: item.at,
      bid: item.bid ?? undefined,
      issuePath: item.issuePath ?? undefined,
      line: hintLine(item)
    }));
}

/**
 * Stamp `seenAt` on the items that were **really** injected. Re-reads every
 * file so a concurrent revoke is not resurrected (a deleted item is skipped),
 * and keeps the first `seenAt` if another plugin instance already stamped it.
 *
 * Runs from the `context` hook, so it never throws: a sid that is not a valid
 * directory name, an unreadable file or a failed write all just mean the line is
 * shown again on the next request.
 */
export function markSeen(targetSid: string, ids: string[], now = Date.now()): number {
  let stamped = 0;
  for (const id of ids ?? []) {
    try {
      const item = readQueueItem(String(targetSid), String(id));
      if (!item || item.seenAt) continue;
      const file = join(queueDir(item.target), `${item.id}.json`);
      const tmp = `${file}.${randToken()}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ ...item, seenAt: now }, null, 2)}\n`);
      renameSync(tmp, file);
      stamped += 1;
    } catch {
      // Best effort: a failed stamp only means the line is shown again.
    }
  }
  return stamped;
}
