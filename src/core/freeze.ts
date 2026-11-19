/**
 * 0.6.0 (`collab_freeze`): the **temporary freeze mark** — one reversible,
 * self-expiring record that the collaboration layer itself obeys.
 *
 * Before this module, "freeze this session / workspace / one hand-off" existed
 * only as a sentence in a message: the plugin did not know who was frozen, so a
 * new session (or a new hand-off) could keep writing into the frozen object,
 * and the freeze depended on a human remembering it.
 *
 * The contract, in one place:
 *
 *   1. **one global file** `~/.config/opencode/collab-freeze.json`
 *      (`{ version: 1, entries: FreezeEntry[] }`), read-merge-write, atomic
 *      `tmp + rename`. `COLLAB_FREEZE_FILE` overrides the path (tests).
 *   2. **expiry is read-time**: `readFreezes(now)` drops `until <= now`
 *      (an expired freeze simply stops existing — nothing has to run);
 *      a *write* also sweeps expired entries, so the file stays small.
 *   3. **merge, never replace**: `mergeFreezes(mutate)` re-reads the current
 *      entries and writes back the mutation, so two writers (two plugin
 *      instances / two workspaces — the file is global) do not drop each
 *      other's entries. A short `<file>.lock` guard (`open(…, "wx")`) keeps the
 *      read-modify-write atomic across processes; it is best-effort and never
 *      blocks a tool on a crashed holder (a stale guard is reclaimed).
 *   4. **precedence**: `session` (self **or any ancestor**) > `bid` >
 *      `workspace`. The ancestor half reuses `createLineage(...).protectedAncestor`
 *      — the same bounded, cycle-safe walk the protect guard uses — so a
 *      sub-agent cannot bypass a frozen parent line. The pure lookup itself
 *      lives in `core/freeze-pure.ts` (0.6.1) and is re-exported here: the
 *      board — which ships inside the GUI bundle and may not import `node:*` —
 *      shares that one implementation instead of copying the rule.
 *   5. **freeze ≠ archive ≠ delete**: no session is hidden, no file is removed,
 *      no permission/agent is touched. Only *new* collaboration into the frozen
 *      object is refused (`collab_handoff` / `collab_broadcast` /
 *      `collab_accept` / `collab_escalate`); read commands keep working.
 *
 * A corrupt / unreadable file is an **empty** freeze list (logged once by
 * `readJsonFile`), never a broken tool: a freeze is coordination metadata and
 * must not be able to take the plugin down.
 */
import { closeSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { errCode, log } from '../log.ts';
import type { FreezeEntry, FreezeFile } from '../types.ts';
import { asObject, randToken, readJsonFile } from '../util.ts';
// 0.6.1 (R1): the precedence lookup is **one** implementation, in the pure
// module (no `node:` import) that the GUI bundle can also carry. Everything
// server-side keeps importing it from here.
import { freezeFor } from './freeze-pure.ts';
import type { FreezeKeys, FrozenHit } from './freeze-pure.ts';
import type { Lineage } from './lineage.ts';

export { freezeFor, freezeMarker, liveFreezeMarker, liveFreezes } from './freeze-pure.ts';
export type { FreezeKeys, FrozenHit } from './freeze-pure.ts';

/** The single global file (design §1). `COLLAB_FREEZE_FILE` overrides it. */
export const FREEZE_FILE =
  process.env.COLLAB_FREEZE_FILE || join(homedir(), '.config', 'opencode', 'collab-freeze.json');

/** R1: `until` defaults to 30 minutes. */
export const DEFAULT_FREEZE_MS = 30 * 60 * 1000;
/** A freeze is a brake, not a policy: 30 days is the ceiling. */
export const MAX_FREEZE_MS = 30 * 24 * 60 * 60 * 1000;
/** `reason` is one short line (rendered in refusals / prompts). */
export const FREEZE_REASON_LIMIT = 200;
const FREEZE_SCOPES: FreezeEntry['scope'][] = ['session', 'workspace', 'bid'];
/** A guard file older than this was left by a crash and may be reclaimed. */
const FREEZE_GUARD_STALE_MS = 2000;
/** How long a writer waits for the guard before falling back to a plain merge. */
const FREEZE_GUARD_TRIES = 100;
const FREEZE_GUARD_SLEEP_MS = 5;

/** `HH:MM` (local) — the format the refusal / notice lines promise. */
function clock(ms: number): string {
  const date = new Date(Number(ms) || 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Control characters (newlines included) become spaces; capped at the limit. */
export function sanitizeFreezeReason(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FREEZE_REASON_LIMIT);
}

/**
 * `until` accepts (design §1, R1):
 *   - absent / empty → `now + 30m`;
 *   - a number > 1e11 → epoch ms; a smaller number → minutes from now;
 *   - `"30m"` / `"90"` (minutes) / `"2h"` / `"45s"` / `"500ms"` / `"1d"` → relative;
 *   - anything `Date.parse` understands (`"2026-11-19T16:00:00+08:00"`) → absolute.
 * Returns `undefined` for an unparseable value (the tool turns it into a
 * readable error); never silently falls back to the default for a typo.
 */
export function parseUntil(raw: unknown, now = Date.now()): number | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === '') return now + DEFAULT_FREEZE_MS;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    const until = raw > 1e11 ? Math.trunc(raw) : now + Math.round(raw * 60_000);
    return clampUntil(until, now);
  }
  const text = String(raw).trim();
  const relative = /^(\d+(?:\.\d+)?)\s*(ms|s|m|min|h|d)?$/i.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = (relative[2] ?? 'm').toLowerCase();
    const factor =
      unit === 'ms'
        ? 1
        : unit === 's'
          ? 1000
          : unit === 'h'
            ? 3_600_000
            : unit === 'd'
              ? 86_400_000
              : 60_000;
    return clampUntil(now + Math.round(amount * factor), now);
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return undefined;
  return clampUntil(parsed, now);
}

/** `undefined` when the value is not a usable future instant (readable error). */
function clampUntil(until: number, now: number): number | undefined {
  if (!Number.isFinite(until) || until <= now) return undefined;
  return Math.min(until, now + MAX_FREEZE_MS);
}

/** One tolerant entry (a hand-written file must not crash a tool). */
export function normalizeFreezeEntry(raw: unknown): FreezeEntry | undefined {
  const value = asObject(raw);
  const scope = String(value.scope ?? '') as FreezeEntry['scope'];
  if (!FREEZE_SCOPES.includes(scope)) return undefined;
  const target = String(value.target ?? '').trim();
  const reason = sanitizeFreezeReason(value.reason);
  const by = String(value.by ?? '').trim();
  const at = Number(value.at) || 0;
  const until = Number(value.until) || 0;
  if (!target || !by || !at || !until) return undefined;
  const notifiedAt = Number(value.notifiedAt) || 0;
  const notifiedFor = Array.isArray(value.notifiedFor)
    ? [...new Set(value.notifiedFor.filter((sid: unknown) => typeof sid === 'string' && Boolean(sid)).map(String))]
    : [];
  const delivery = Array.isArray(value.delivery)
    ? value.delivery
        .filter((item: unknown) => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
        .map((item: unknown) => {
          const raw = asObject(item);
          const to = String(raw.to ?? '').trim();
          const at = Number(raw.at) || 0;
          if (!to || !at) return undefined;
          const cid = raw.cid ? String(raw.cid) : undefined;
          const messageId = raw.messageId ? String(raw.messageId) : undefined;
          const queueId = raw.queueId ? String(raw.queueId) : undefined;
          const error = raw.error ? String(raw.error).slice(0, FREEZE_REASON_LIMIT) : undefined;
          return { to, at, ...(cid ? { cid } : {}), ...(messageId ? { messageId } : {}), ...(queueId ? { queueId } : {}), ...(error ? { error } : {}) };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : undefined;
  return {
    scope,
    target,
    reason,
    by,
    at,
    until,
    ...(notifiedAt ? { notifiedAt } : {}),
    ...(notifiedFor.length ? { notifiedFor } : {}),
    ...(delivery && delivery.length ? { delivery } : {})
  };
}

/** Every **live** entry (`until > now`), oldest first. Never writes. */
export function readFreezes(now = Date.now()): FreezeEntry[] {
  const raw = readJsonFile(FREEZE_FILE);
  const entries = Array.isArray(asObject(raw).entries) ? (asObject(raw).entries as unknown[]) : [];
  return entries
    .map(normalizeFreezeEntry)
    .filter((entry): entry is FreezeEntry => Boolean(entry))
    .filter(entry => entry.until > now)
    .sort((left, right) => left.at - right.at || left.target.localeCompare(right.target));
}

/** Same-scope-and-target entries are one freeze: the later write wins. */
function dedupe(entries: FreezeEntry[]): FreezeEntry[] {
  const byKey = new Map<string, FreezeEntry>();
  for (const entry of entries) byKey.set(`${entry.scope}\u0000${entry.target}`, entry);
  return [...byKey.values()];
}

function sleepSync(ms: number): void {
  try {
    // Synchronous, no timer: the merge is a tiny critical section and every
    // caller (tool / context hook) expects a sync answer.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* environments without SharedArrayBuffer: a plain tight retry */
  }
}

/** `open(…, 'wx')` guard; `undefined` = proceed unguarded (best effort). */
function acquireGuard(): string | undefined {
  const path = `${FREEZE_FILE}.lock`;
  try {
    mkdirSync(dirname(FREEZE_FILE), { recursive: true });
  } catch {
    return undefined;
  }
  for (let attempt = 0; attempt < FREEZE_GUARD_TRIES; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return path;
    } catch (error) {
      if (errCode(error) !== 'EEXIST') return undefined;
      try {
        if (Date.now() - statSync(path).mtimeMs > FREEZE_GUARD_STALE_MS) unlinkSync(path);
      } catch {
        /* the holder released it between stat and unlink */
      }
      sleepSync(FREEZE_GUARD_SLEEP_MS);
    }
  }
  log(`freeze guard busy for ${FREEZE_GUARD_TRIES * FREEZE_GUARD_SLEEP_MS}ms: merging without it`);
  return undefined;
}

function releaseGuard(path: string | undefined): void {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

function writeFreezes(entries: FreezeEntry[]): void {
  const next: FreezeFile = { version: 1, entries };
  mkdirSync(dirname(FREEZE_FILE), { recursive: true });
  const tmp = `${FREEZE_FILE}.${randToken()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, FREEZE_FILE);
}

/**
 * Read-merge-write (design §5): the mutation sees the **current** live entries
 * (expired ones already dropped, duplicates collapsed) and returns the whole
 * next list, which is swept once more and written atomically.
 *
 * A failure (unwritable file, a racing writer) never throws: the tool has
 * already been told what it intended to do, and the *effective* list is what
 * this function returns — the caller prints that, not its own snapshot.
 */
export function mergeFreezes(mutate: (entries: FreezeEntry[]) => FreezeEntry[], now = Date.now()): FreezeEntry[] {
  const guard = acquireGuard();
  try {
    const current = dedupe(readFreezes(now));
    const proposed = mutate(current.map(entry => ({ ...entry }))) ?? [];
    const next = dedupe(
      proposed
        .map(normalizeFreezeEntry)
        .filter((entry): entry is FreezeEntry => Boolean(entry))
        .filter(entry => entry.until > now)
    ).sort((left, right) => left.at - right.at || left.target.localeCompare(right.target));
    writeFreezes(next);
    return next;
  } catch (error) {
    log(`freeze write failed: ${(error as Error)?.message ?? error}`);
    return readFreezes(now);
  } finally {
    releaseGuard(guard);
  }
}

/**
 * The live lookup the tools use. `lineage` is optional: the `session` half is
 * then self-only (an older caller / a unit test without a host), which is why
 * every enforcement point passes one — the ancestor walk is the whole point of
 * R3's "子会话不能绕过".
 */
export async function frozenBy(
  keys: FreezeKeys,
  options: { lineage?: Lineage; now?: number } = {}
): Promise<FrozenHit | undefined> {
  const now = options.now ?? Date.now();
  const entries = readFreezes(now);
  if (!entries.length) return undefined;
  const lineage = options.lineage;
  const sessionTargets = entries
    .filter(entry => entry.scope === 'session')
    .map(entry => entry.target);
  if (keys.session && sessionTargets.length && (lineage || keys.ancestors?.length)) {
    if (lineage) {
      const hit = await lineage.protectedAncestor(keys.session, sessionTargets);
      if (!hit) return freezeFor(entries.filter(entry => entry.scope !== 'session'), keys);
      const entry = entries.find(candidate => candidate.scope === 'session' && candidate.target === hit.sessionID);
      if (!entry) return freezeFor(entries.filter(candidate => candidate.scope !== 'session'), keys);
      return hit.depth === 0 ? { entry } : { entry, via: hit.sessionID };
    }
  }
  return freezeFor(entries, keys);
}

/**
 * The one refusal text (design §3). Every enforced tool prints exactly this
 * shape, so a caller never has to guess which command lifts the freeze.
 */
export function freezeDenyText(hit: FrozenHit, what = '目标'): string {
  const entry = hit.entry;
  return (
    `拒绝：${what}被冻结（scope=${entry.scope}${hit.via ? `，继承自祖先 ${hit.via}` : ''}，` +
    `到 ${clock(entry.until)}，原因：${entry.reason || '-'}）。` +
    `解冻: collab_freeze { scope:"${entry.scope}", target:"${entry.target}", freeze:false, confirm:true }。` +
    '未写入任何内容。'
  );
}

/** `HH:MM` of a freeze deadline (the shared freeze line shape). */
export function clockOf(ms: number): string {
  return clock(ms);
}

/** Same words without the leading `拒绝：` — for a preview's "拒绝提示:" line. */
export function freezeHintText(hit: FrozenHit, what = '目标'): string {
  return freezeDenyText(hit, what).replace(/^拒绝：/, '');
}

/** What the frozen session itself sees once (R4). */
export function freezeNoticeText(entry: FreezeEntry, via?: string): string {
  return [
    `[collab-freeze] 你被冻结${via ? `（继承自祖先 ${via}）` : ''}：${entry.reason || '(未写原因)'}`,
    `到期: ${clock(entry.until)}（scope=${entry.scope}，target=${entry.target}；到期自动失效）`,
    `解冻: collab_freeze { scope:"${entry.scope}", target:"${entry.target}", freeze:false, confirm:true }`,
    '冻结只阻止**新建**协作（collab_handoff / collab_broadcast / collab_accept / collab_escalate）；' +
      '读取类（collab_list / collab_status）不受限。'
  ].join('\n');
}

/**
 * The pending notice for one session, or `undefined` when there is none / it was
 * already shown (`notifiedAt`). **Does not write**: the caller pushes the block
 * first and *then* calls `markFreezeNotified` — the same F1 rule the follow-up
 * hint uses, so an injection that throws shows the notice again next request.
 */
export async function freezeNotice(
  sessionID: string,
  options: { lineage?: Lineage; now?: number } = {}
): Promise<FrozenHit | undefined> {
  if (!sessionID) return undefined;
  const hit = await frozenBy({ session: String(sessionID) }, options);
  if (!hit) return undefined;
  const seen = Array.isArray(hit.entry.notifiedFor) ? hit.entry.notifiedFor : [];
  if (hit.entry.notifiedAt && (seen.includes(String(sessionID)) || !seen.length)) return undefined;
  return hit;
}

/**
 * Stamp the notice as delivered (read-merge-write): `notifiedAt` = last stamp,
 * `notifiedFor[]` = the sessions that already saw it — so a frozen ancestor
 * still tells *each* of its sub-sessions once instead of only the first one.
 */
export function markFreezeNotified(entry: FreezeEntry, sessionID: string, now = Date.now()): FreezeEntry | undefined {
  let stamped: FreezeEntry | undefined;
  mergeFreezes(entries =>
    entries.map(candidate => {
      if (candidate.scope !== entry.scope || candidate.target !== entry.target) return candidate;
      const seen = Array.isArray(candidate.notifiedFor) ? candidate.notifiedFor : [];
      stamped = {
        ...candidate,
        notifiedAt: now,
        notifiedFor: [...new Set([...seen, String(sessionID)])]
      };
      return stamped;
    })
  );
  return stamped;
}
