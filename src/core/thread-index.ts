/**
 * 0.7.0 (`11-19-collab-threads`): the **thread index** — the one new store of
 * this task, and the reason it exists:
 *
 * `ThreadStore` (`core/storage.ts`) is a `ctx.storage` key/value domain: it can
 * read one thread by id, but it cannot enumerate. Observed on a real chain: one
 * pair of sessions ran **7 threads in parallel** (6 of them plain
 * `collab_send` / `collab_reply` message threads) and there was no way to ask
 * "which of these is still open" before sending another message — and
 * `collab_status {threadID}` refused the 6 message threads outright because it
 * only knew broadcast (hand-off) records.
 *
 * So: one small JSON file at `~/.config/opencode/collab-threads.json`
 *
 *   { "version": 1,
 *     "entries": { "t_…": { "target": "ses_…", "kind": "handoff" | "messages",
 *                            "from": "ses_…", "lastAt": 0, "preview": "≤80 字",
 *                            "bid": "b_…"? } } }
 *
 * Rules (design §2):
 *   - written **only** after a message was really admitted (`dispatch` success,
 *     and `collab_handoff` after its record exists) — a failed or previewed call
 *     writes nothing;
 *   - read-modify-write + `tmp + rename` (the same atomic replace every other
 *     global store of this plugin uses);
 *   - ≤ `THREAD_INDEX_LIMIT` (500) entries, oldest `lastAt` evicted first — on
 *     **write** only; a read never mutates the file (`collab_threads` and the
 *     downgraded `collab_status` are read-only, proven with mtime + hash);
 *   - reads ignore entries older than `THREAD_INDEX_RETENTION_MS` (7 days);
 *   - a corrupt/foreign file is treated as empty and logged once, so a broken
 *     index can never take a tool down.
 *
 * `preview` is the sender's own words, whitespace-collapsed and cut at
 * `THREAD_INDEX_PREVIEW_CHARS`: the index is a **pointer list**, not a message
 * archive — the body itself stays in the thread record / inbox.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  THREAD_INDEX_FILE,
  THREAD_INDEX_LIMIT,
  THREAD_INDEX_PREVIEW_CHARS,
  THREAD_INDEX_RETENTION_MS,
  THREAD_INDEX_VERSION
} from '../constants.ts';
import { log } from '../log.ts';
import type { ThreadIndexEntry, ThreadIndexFile, ThreadIndexRecord } from '../types.ts';
import { asObject, randToken, readJsonFile, truncate } from '../util.ts';

/** `kind` of one indexed thread: a hand-off thread or a plain message thread. */
export type ThreadKind = 'handoff' | 'messages';

const isKind = (value: unknown): value is ThreadKind => value === 'handoff' || value === 'messages';

/** One entry, tolerantly normalised. Anything without a target / time is junk. */
function normalizeEntry(raw: unknown): ThreadIndexEntry | undefined {
  const value = asObject(raw);
  const target = String(value.target ?? '').trim();
  const lastAt = Number(value.lastAt) || 0;
  if (!target || !lastAt) return undefined;
  const bid = String(value.bid ?? '').trim();
  return {
    target,
    kind: isKind(value.kind) ? value.kind : 'messages',
    from: String(value.from ?? '').trim(),
    lastAt,
    preview: truncate(value.preview, THREAD_INDEX_PREVIEW_CHARS),
    ...(bid ? { bid } : {})
  };
}

/** The whole file, as `threadID → entry`. Never throws; junk is dropped. */
export function readThreadIndex(): Record<string, ThreadIndexEntry> {
  const raw = readJsonFile(THREAD_INDEX_FILE);
  const file = asObject(raw);
  if (!raw) return {}; // missing (never written) — not an error
  if (Number(file.version) && Number(file.version) !== THREAD_INDEX_VERSION) {
    // A future file shape is not ours to interpret: treat it as empty
    // (`readJsonFile` already logged the unreadable case).
    log(`ignoring ${THREAD_INDEX_FILE}: unsupported version ${String(file.version)}`);
    return {};
  }
  const entries = asObject(file.entries);
  const out: Record<string, ThreadIndexEntry> = {};
  for (const [threadID, value] of Object.entries(entries)) {
    if (!threadID) continue;
    const entry = normalizeEntry(value);
    if (entry) out[threadID] = entry;
  }
  return out;
}

/**
 * Read-modify-write, atomic replace, bounded. Called **only** from a successful
 * delivery path, and never throws: an index that cannot be written means
 * `collab_threads` shows one thread less, not that the message failed (it was
 * already delivered).
 */
export function recordThread(input: {
  threadID?: string;
  target?: string;
  from?: string;
  kind: ThreadKind;
  text?: unknown;
  bid?: string;
  now?: number;
}): ThreadIndexEntry | undefined {
  const threadID = String(input.threadID ?? '').trim();
  const target = String(input.target ?? '').trim();
  const now = Number(input.now) || Date.now();
  if (!threadID || !target) return undefined;
  try {
    const entries = readThreadIndex();
    const previous = entries[threadID];
    const bid = String(input.bid ?? previous?.bid ?? '').trim();
    // A `handoff` mark is stickier than `messages`: the same thread keeps being
    // used for plain messages afterwards, and it is still a hand-off thread.
    const kind: ThreadKind = input.kind === 'handoff' || previous?.kind === 'handoff' ? 'handoff' : 'messages';
    const entry: ThreadIndexEntry = {
      // `target` / `from` are the **two participants**, recorded once: a reply
      // flows the other way, and both sides must still find this thread in
      // `threadsFor` (matching is `target === sid || from === sid`). They are
      // therefore sticky; only the activity fields move.
      target: previous?.target || target,
      kind,
      from: previous?.from || String(input.from ?? '').trim(),
      lastAt: now,
      preview: truncate(input.text, THREAD_INDEX_PREVIEW_CHARS) || previous?.preview || '',
      ...(bid ? { bid } : {})
    };
    entries[threadID] = entry;
    // Bounded: oldest `lastAt` out first (a hand-off preview is never the reason
    // the index grows — 500 threads is already far past what a pair of sessions
    // runs, and the retention window prunes the read side anyway).
    const kept = Object.entries(entries)
      .sort((a, b) => b[1].lastAt - a[1].lastAt)
      .slice(0, THREAD_INDEX_LIMIT);
    const file: ThreadIndexFile = {
      version: THREAD_INDEX_VERSION,
      entries: Object.fromEntries(kept)
    };
    mkdirSync(dirname(THREAD_INDEX_FILE), { recursive: true });
    const tmp = `${THREAD_INDEX_FILE}.${randToken()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(tmp, THREAD_INDEX_FILE);
    return entry;
  } catch (error) {
    log(`thread index write failed: ${(error as Error)?.message ?? error}`);
    return undefined;
  }
}

/** One entry, if it exists and is inside the retention window. Read-only. */
export function threadEntry(threadID: string | undefined, now = Date.now()): ThreadIndexEntry | undefined {
  const id = String(threadID ?? '').trim();
  if (!id) return undefined;
  const entry = readThreadIndex()[id];
  if (!entry) return undefined;
  return now - entry.lastAt <= THREAD_INDEX_RETENTION_MS ? entry : undefined;
}

/**
 * Every indexed thread one participant is part of, newest first. **Read-only**:
 * the retention filter is applied here and nothing is deleted (deletion only
 * happens on the next `recordThread`, which is a write path).
 *
 * Matching is on either participant (`target` **or** `from`), because both
 * fields are sticky — the thread the caller answered is the same thread the
 * counterpart started, and both sides must be able to list it.
 */
export function threadsFor(target: string, now = Date.now()): ThreadIndexRecord[] {
  const sid = String(target ?? '').trim();
  if (!sid) return [];
  return Object.entries(readThreadIndex())
    .filter(([, entry]) => entry.target === sid || entry.from === sid)
    .filter(([, entry]) => now - entry.lastAt <= THREAD_INDEX_RETENTION_MS)
    .map(([threadID, entry]) => ({ threadID, ...entry }))
    .sort((a, b) => b.lastAt - a.lastAt || a.threadID.localeCompare(b.threadID));
}

/** The store path — the harness asserts the one file it reads/writes. */
export function threadIndexFile(): string {
  return THREAD_INDEX_FILE;
}
