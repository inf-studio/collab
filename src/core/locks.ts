/**
 * C1 (0.2.0): resource leases — `collab_lock` / `collab_unlock` / `collab_locks`.
 *
 * Why a *lease* and not a hand-off: the hand-off chain answers "whose job is
 * this?", which is a different question from "may I use the pytest window right
 * now?". Two sessions in **one workspace** kept negotiating that second question
 * in prose (a 10-minute window held by one session, two unanswered requests from
 * another, `ps` as the only evidence). So the negotiation becomes a decidable
 * state:
 *
 *     free ──acquire──▶ held ──release──▶ free
 *                        │
 *                        ├──expire──▶ free        (reaped on the next access)
 *                        └──shared join──▶ held(holders+1)
 *     held ──request(wait)──▶ waiters[]  (FIFO, never woken — informed)
 *
 * Deliberately **not** here: any message delivery. A lease is pure local state
 * in a global directory (`COLLAB_LOCK_DIR`), so taking one never interrupts a
 * session and losing one never loses a message. Preemption is not offered at
 * all: the only "force" path would be a human, and a protected (`[protected*]`)
 * holder is marked as such precisely so nobody mistakes a conflict for a bug.
 *
 * Storage, per resource:
 *   `~/.config/opencode/collab-locks/<sha256(resource)[0..16]>__<slug>.json`
 *   written `tmp + rename` (readers never see a half record), guarded for the
 *   read-decide-write window by `<file>.lock` via `open(…, "wx")` — the same
 *   primitive `collab_accept` uses, with a 2 s wait and stale-guard cleanup so a
 *   crashed caller cannot wedge a resource.
 */
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  LOCK_DIR,
  LOCK_GUARD_STALE_MS,
  LOCK_GUARD_TIMEOUT_MS,
  LOCK_HISTORY_LIMIT,
  LOCK_QUEUE_LIMIT,
  LOCK_REASON_LIMIT,
  LOCK_TTL_DEFAULT_MS,
  LOCK_TTL_MAX_MS,
  LOCK_TTL_MIN_MS
} from '../constants.ts';
import { errCode, log } from '../log.ts';
import type {
  JsonObject,
  LockEvent,
  LockHistoryEntry,
  LockKind,
  LockMode,
  LockRecord,
  LockState,
  LockWaiter
} from '../types.ts';
import { asObject, clamp, hash16, randToken, readJsonFile } from '../util.ts';

// ------------------------------------------------------------ normalisation

/**
 * Chinese / loose names seen in practice, mapped onto the canonical named
 * resource. The table exists because "窗口:测试", "测试窗口" and
 * "test-window" are *the same* resource — a lock that only folds two of them
 * would still let two sessions run pytest at once.
 */
const NAMED_ALIASES: Record<string, string> = {
  窗口: 'test-window',
  '窗口:测试': 'test-window',
  '窗口:test': 'test-window',
  测试窗口: 'test-window',
  'test-window': 'test-window',
  testwindow: 'test-window',
  build: 'build',
  构建: 'build',
  全量构建: 'build',
  '全量build': 'build'
};

/** Strip control characters / newlines, collapse spaces, cap the length. */
export function sanitizeReason(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LOCK_REASON_LIMIT);
}

export type ResourceCheck =
  | { ok: true; resource: string; kind: LockKind; relPath?: string; absPath?: string }
  | { ok: false; reason: string };

/** Lowercase, whitespace folded to `-`, alias-mapped — one canonical name. */
function canonicalNamed(raw: string): { resource: string; kind: LockKind } {
  const folded = raw.replace(/\s+/g, '').toLowerCase();
  const alias = NAMED_ALIASES[folded];
  if (alias) return { resource: `named:${alias}`, kind: alias === 'build' ? 'build' : 'named' };
  const name = raw
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  return { resource: `named:${name}`, kind: 'named' };
}

/**
 * `file:` resources: workspace-relative, no `..`, inside `workspace` after
 * `realpath`, never a symlink. An absolute path is refused (the *same* file
 * must be spelled the same way from every workspace — accepting absolute paths
 * would let `/data/x/a.ts` and `a.ts` name one file twice).
 *
 * A not-yet-created file is allowed, but only when the nearest existing ancestor
 * still resolves inside the workspace — that keeps `../` and a symlinked parent
 * out while letting a session lease the module it is about to write.
 */
function canonicalFile(raw: string, workspace: string | undefined): ResourceCheck {
  const path = raw.trim().replace(/^file:/i, '').trim();
  if (!path) return { ok: false, reason: 'file: 资源缺少路径' };
  if (isAbsolute(path)) {
    return { ok: false, reason: `file: 资源必须是 workspace 相对路径（收到绝对路径 ${path}）` };
  }
  if (path.split(/[\\/]/).some(part => part === '..' || part === '.')) {
    return { ok: false, reason: `file: 资源不能包含 .. / .：${path}` };
  }
  if (!workspace || !isAbsolute(workspace)) {
    return { ok: false, reason: '当前会话没有 workspace 绝对路径，无法校验 file: 资源（改用 named:<名字>）' };
  }
  let realRoot: string;
  try {
    if (!statSync(workspace).isDirectory()) return { ok: false, reason: `workspace 不是目录：${workspace}` };
    realRoot = realpathSync(workspace);
  } catch {
    return { ok: false, reason: `workspace 不存在或不可读：${workspace}` };
  }
  const clean = relative(realRoot, resolve(realRoot, path)).split(sep).join('/');
  if (!clean || clean.startsWith('..')) {
    return { ok: false, reason: `file: 资源越界（不在 ${workspace} 内）：${path}` };
  }
  const abs = resolve(realRoot, clean);
  // The leaf: reject a symlink outright (design §6, same rule as proposals).
  let leaf: ReturnType<typeof lstatSync> | undefined;
  try {
    leaf = lstatSync(abs);
  } catch {
    leaf = undefined; // does not exist yet — validated through its ancestor
  }
  if (leaf?.isSymbolicLink()) return { ok: false, reason: `file: 资源 ${clean} 是软链（不允许绕过 workspace 边界）` };
  // Validate the nearest existing ancestor so a symlinked directory cannot
  // smuggle a missing leaf outside the workspace.
  let probe = leaf ? abs : resolve(abs, '..');
  for (;;) {
    try {
      const real = realpathSync(probe);
      const inside = real === realRoot || real.startsWith(realRoot + sep);
      if (!inside) return { ok: false, reason: `file: 资源真实路径越界（不在 ${workspace} 内）：${real}` };
      break;
    } catch {
      const parent = resolve(probe, '..');
      if (parent === probe) return { ok: false, reason: `file: 资源无法校验：${clean}` };
      probe = parent;
    }
  }
  return { ok: true, resource: `file:${clean}`, kind: 'file', relPath: clean, absPath: abs };
}

/**
 * Canonical resource id (design §2). Accepts:
 *   `test-window` / `窗口:测试` / `test window`   → `named:test-window`
 *   `build` / `全量构建`                          → `named:build`
 *   `file:packages/x/store.ts` / `packages/x/store.ts` → `file:packages/x/store.ts`
 *   `<dir>` (a directory can be leased too)      → `file:<dir>`
 * The throwing wrapper lives in the tool (`invalid(reason)`); this form is
 * unit-testable and reused by `collab_list`.
 */
export function normalizeResource(raw: unknown, workspace?: string): ResourceCheck {
  const text = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return { ok: false, reason: 'resource 为空' };
  if (text.length > 300) return { ok: false, reason: 'resource 过长（≤300 字）' };
  const lower = text.toLowerCase();
  if (lower.startsWith('named:')) {
    const name = text.slice('named:'.length).trim();
    if (!name) return { ok: false, reason: 'named: 资源缺少名字' };
    const { resource, kind } = canonicalNamed(name);
    return { ok: true, resource, kind };
  }
  if (lower.startsWith('file:')) return canonicalFile(text, workspace);
  if (lower === 'build' || lower === 'build:') return { ok: true, resource: 'named:build', kind: 'build' };
  // A bare path (`packages/state/.../store.ts`) is a file resource, not a name.
  if (/[\\/]/.test(text) && !text.includes(':')) return canonicalFile(text, workspace);
  const { resource, kind } = canonicalNamed(text);
  return { ok: true, resource, kind };
}

// ---------------------------------------------------------------- storage io

/** `<hash>__<slug>.json` — the hash is the identity, the slug is for humans. */
export function lockFile(resource: string): string {
  const slug =
    resource
      .replace(/^[a-z]+:/i, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .toLowerCase() || 'resource';
  return join(LOCK_DIR, `${hash16(resource)}__${slug}.json`);
}

function guardFile(resource: string): string {
  return `${lockFile(resource)}.lock`;
}

/** Tolerant of hand-written / older records: arrays and numbers are repaired. */
export function normalizeLock(record: JsonObject): LockRecord {
  const mode: LockMode = record.mode === 'shared' ? 'shared' : 'exclusive';
  const holders = Array.isArray(record.holders)
    ? record.holders.filter((sid: unknown): sid is string => typeof sid === 'string' && Boolean(sid))
    : [];
  const waiters: LockWaiter[] = Array.isArray(record.waiters)
    ? record.waiters
        .map((entry: unknown) => {
          const value = asObject(entry);
          const sid = String(value.sid ?? '');
          if (!sid) return undefined;
          return {
            sid,
            at: Number(value.at) || 0,
            mode: (value.mode === 'shared' ? 'shared' : 'exclusive') as LockMode,
            ...(value.reason ? { reason: sanitizeReason(value.reason) } : {})
          };
        })
        .filter((entry): entry is LockWaiter => Boolean(entry))
    : [];
  const history: LockHistoryEntry[] = Array.isArray(record.history)
    ? record.history
        .map((entry: unknown) => {
          const value = asObject(entry);
          const event = String(value.event ?? '');
          if (!['acquire', 'release', 'expire', 'wait', 'leave'].includes(event)) return undefined;
          return {
            sid: String(value.sid ?? ''),
            at: Number(value.at) || 0,
            event,
            ...(value.reason ? { reason: sanitizeReason(value.reason) } : {})
          } as LockHistoryEntry;
        })
        .filter((entry): entry is LockHistoryEntry => Boolean(entry))
    : [];
  return {
    ...record,
    resource: String(record.resource ?? ''),
    kind: (['named', 'file', 'build'].includes(String(record.kind)) ? record.kind : 'named') as LockKind,
    mode,
    ...(record.holder ? { holder: String(record.holder) } : {}),
    holders,
    ...(record.reason ? { reason: sanitizeReason(record.reason) } : {}),
    acquiredAt: Number(record.acquiredAt) || 0,
    // A free record has no lease: keep 0 instead of inventing a default TTL.
    ttlMs: Number(record.ttlMs) > 0 ? normalizeTtl(record.ttlMs) : 0,
    expiresAt: Number(record.expiresAt) || 0,
    // The queue is bounded at *write* time (`LOCK_QUEUE_LIMIT`); on read keep
    // the head, never the tail — truncating here used to drop the oldest waiter
    // (the one whose turn is next) and silently void its place.
    waiters: waiters.slice(0, LOCK_QUEUE_LIMIT),
    history: history.slice(-LOCK_HISTORY_LIMIT),
    updatedAt: Number(record.updatedAt) || 0
  };
}

/** A free record for previews: `stateOf(undefined)` has no resource to print. */
export function emptyLock(resource: string, kind: LockKind = 'named', mode: LockMode = 'exclusive'): LockRecord {
  return {
    resource,
    kind,
    mode,
    holders: [],
    acquiredAt: 0,
    ttlMs: 0,
    expiresAt: 0,
    waiters: [],
    history: []
  };
}

/** `ttlMs` from a caller: default, clamped to [10s, 2h]. */
export function normalizeTtl(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return LOCK_TTL_DEFAULT_MS;
  return clamp(n, LOCK_TTL_MIN_MS, LOCK_TTL_MAX_MS);
}

export function readLock(resource: string): LockRecord | undefined {
  const raw = readJsonFile(lockFile(resource));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return normalizeLock({ ...asObject(raw), resource });
}

/** `tmp + rename`: a concurrent reader sees the old record or the new one. */
export function writeLock(record: LockRecord): LockRecord {
  mkdirSync(LOCK_DIR, { recursive: true });
  const next = { ...normalizeLock(record), updatedAt: Date.now() };
  const file = lockFile(next.resource);
  const tmp = `${file}.${randToken()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file);
  return next;
}

/** Every lease on disk (read-only; used by `collab_locks` / `collab_list`). */
export function allLocks(): LockRecord[] {
  let names: string[];
  try {
    names = readdirSync(LOCK_DIR);
  } catch {
    return []; // no directory yet: nothing is held anywhere
  }
  const out: LockRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // `.lock` / `.tmp` are protocol, not leases
    const raw = readJsonFile(join(LOCK_DIR, name));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = normalizeLock(asObject(raw));
    if (record.resource) out.push(record);
  }
  return out.sort((left, right) => left.resource.localeCompare(right.resource));
}

// ------------------------------------------------------------- short guard

const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

/**
 * Run `fn` while holding `<file>.lock`.
 *
 * `open(…, "wx")` is the atomic step: exactly one caller creates the file.
 * Everyone else retries for up to `LOCK_GUARD_TIMEOUT_MS`; a guard file older
 * than `LOCK_GUARD_STALE_MS` is a crash leftover and is removed (the holder
 * writes a record in milliseconds, so waiting longer than that is pointless).
 */
export async function withGuard<T>(resource: string, fn: () => T | Promise<T>): Promise<T> {
  const file = guardFile(resource);
  mkdirSync(LOCK_DIR, { recursive: true });
  const deadline = Date.now() + LOCK_GUARD_TIMEOUT_MS;
  let fd: number | undefined;
  for (;;) {
    try {
      fd = openSync(file, 'wx');
      break;
    } catch (error) {
      if (errCode(error) !== 'EEXIST') throw error;
      if (guardStale(file)) {
        try {
          unlinkSync(file);
        } catch {
          /* another caller cleaned it first */
        }
        continue;
      }
      if (Date.now() >= deadline) {
        // Last resort: proceed without the guard rather than fail the whole
        // acquisition — the record write is still atomic (tmp+rename), so the
        // worst case is a lost update, not a corrupt file.
        log(`lock guard timeout for ${resource}; proceeding unguarded`);
        return fn();
      }
      await sleep(5);
    }
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    return await fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      unlinkSync(file);
    } catch {
      /* someone cleaned it (stale sweep) */
    }
  }
}

function guardStale(file: string): boolean {
  try {
    return Date.now() - statSync(file).mtimeMs > LOCK_GUARD_STALE_MS;
  } catch {
    return false; // gone already: the retry loop will succeed
  }
}

// ------------------------------------------------------------------ state

/**
 * Drop a lease that must not be trusted any more, recording why (R-7).
 *
 * Two ways a lease ends without a release: `expiresAt` passed, or the record is
 * **corrupt** — `holders` non-empty but no usable `expiresAt` (0 / NaN / ≤0),
 * which used to mean "held forever, nobody can ever take it". Both are reaped on
 * the next access; the corrupt one is stamped `reason:"invalid"` so the audit
 * trail says the lease was broken, not that it merely lapsed.
 */
export function reap(record: LockRecord, now = Date.now()): LockRecord {
  if (!record.holders.length) return record;
  const expiresAt = Number(record.expiresAt);
  const invalid = !Number.isFinite(expiresAt) || expiresAt <= 0;
  if (!invalid && expiresAt > now) return record;
  const history = [...record.history];
  for (const sid of record.holders) {
    history.push({
      sid,
      at: invalid ? now : expiresAt,
      event: 'expire',
      ...(invalid ? { reason: 'invalid' } : {})
    });
  }
  const next: LockRecord = {
    ...record,
    holders: [],
    acquiredAt: 0,
    ttlMs: 0,
    expiresAt: 0,
    history: history.slice(-LOCK_HISTORY_LIMIT)
  };
  delete next.holder;
  delete next.reason;
  return next;
}

/** Free = no live holder. Waiters never make a resource held. */
export function isFree(record: LockRecord | undefined, now = Date.now()): boolean {
  if (!record) return true;
  return reap(record, now).holders.length === 0;
}

/** The read-only view `collab_locks` / `collab_list` render (design §3). */
export function stateOf(record: LockRecord | undefined, now = Date.now(), sid?: string): LockState {
  const live = record ? reap(record, now) : undefined;
  const holders = live?.holders ?? [];
  const waiters = (live?.waiters ?? []).map((waiter, index) => ({ ...waiter, position: index + 1 }));
  const minePosition = sid ? waiters.find(waiter => waiter.sid === sid)?.position ?? 0 : 0;
  const expiresIn = holders.length && live?.expiresAt ? Math.max(0, live.expiresAt - now) : 0;
  return {
    resource: live?.resource ?? '',
    kind: live?.kind ?? 'named',
    mode: live?.mode ?? 'exclusive',
    free: holders.length === 0,
    holders,
    ...(live?.holder ? { holder: live.holder } : {}),
    ...(live?.reason ? { reason: live.reason } : {}),
    ttlMs: live?.ttlMs ?? 0,
    expiresAt: live?.expiresAt ?? 0,
    expiresIn,
    waiters,
    ...(sid
      ? { mine: { held: holders.includes(sid), waiting: minePosition > 0, position: minePosition } }
      : {})
  };
}

// ------------------------------------------------------------- acquire/release

export interface AcquireInput {
  /** Canonical resource id (already `normalizeResource`d). */
  resource: string;
  kind?: LockKind;
  mode?: string;
  ttlMs?: unknown;
  reason?: unknown;
  wait?: boolean;
  sid: string;
  now?: number;
}

export type AcquireResult =
  | { status: 'held'; record: LockRecord; state: LockState; renewed: boolean }
  | { status: 'queued'; record: LockRecord; state: LockState; ahead: number }
  | { status: 'queue-full'; record: LockRecord; state: LockState; limit: number }
  | {
      status: 'busy';
      record: LockRecord | undefined;
      state: LockState;
      holders: string[];
      remainingMs: number;
    };

/**
 * Atomic acquire: guard → read → decide → write → unguarded.
 *
 * Decisions, in order:
 *   0. a live lease held by **this** sid is idempotent (`status:"held"`,
 *      `renewed:true` — no second count, no TTL extension);
 *   1. free (after reaping an expired lease):
 *        - no waiters, or this sid is the head waiter → grant (dequeue);
 *        - someone else is queued ahead → queue this sid (FIFO is not skipped);
 *   2. held `shared` + requested `shared` → join the group;
 *   3. anything else → conflict: `wait:true` enqueues, otherwise `busy` with the
 *      holders and the remaining TTL. A full queue (`LOCK_QUEUE_LIMIT`) answers
 *      `queue-full` — the newcomer is refused, nobody already queued is evicted.
 */
export async function acquire(input: AcquireInput): Promise<AcquireResult> {
  const mode: LockMode = input.mode === 'shared' ? 'shared' : 'exclusive';
  const ttlMs = normalizeTtl(input.ttlMs);
  const reason = sanitizeReason(input.reason);
  const wait = input.wait === true;
  const sid = input.sid;

  return withGuard(input.resource, () => {
    const now = input.now ?? Date.now();
    const base = readLock(input.resource) ?? {
      resource: input.resource,
      kind: input.kind ?? 'named',
      mode,
      holders: [],
      acquiredAt: 0,
      ttlMs,
      expiresAt: 0,
      waiters: [],
      history: []
    };
    let record = reap(base, now);

    // 0) idempotent re-application (R3): same sid, same resource → same lease.
    if (record.holders.includes(sid)) {
      return { status: 'held', record, state: stateOf(record, now, sid), renewed: true } as AcquireResult;
    }

    const dequeue = (): void => {
      if (!record.waiters.some(waiter => waiter.sid === sid)) return;
      record.waiters = record.waiters.filter(waiter => waiter.sid !== sid);
      record.history = [...record.history, { sid, at: now, event: 'leave' as LockEvent }];
    };

    // 1) free → grant, but never in front of an existing queue.
    if (!record.holders.length) {
      const ahead = record.waiters.findIndex(waiter => waiter.sid === sid);
      const queueBlocked = record.waiters.length > 0 && ahead !== 0;
      if (queueBlocked && !wait) {
        record = writeLock(record);
        return {
          status: 'busy',
          record,
          state: stateOf(record, now, sid),
          holders: [],
          remainingMs: 0
        } as AcquireResult;
      }
      if (queueBlocked) {
        return queueOrFull(record, { sid, at: now, mode, reason }, now);
      }
      dequeue();
      record = {
        ...record,
        kind: input.kind ?? record.kind,
        mode,
        holder: sid,
        holders: [sid],
        ...(reason ? { reason } : {}),
        acquiredAt: now,
        ttlMs,
        expiresAt: now + ttlMs,
        history: [...record.history, { sid, at: now, event: 'acquire' as LockEvent }].slice(-LOCK_HISTORY_LIMIT)
      };
      const written = writeLock(record);
      return { status: 'held', record: written, state: stateOf(written, now, sid), renewed: false } as AcquireResult;
    }

    // 2) shared group join.
    if (record.mode === 'shared' && mode === 'shared') {
      dequeue();
      const expiresAt = Math.max(record.expiresAt, now + ttlMs);
      record = {
        ...record,
        holders: [...record.holders, sid],
        // The group keeps the first reason: a later joiner must not relabel it.
        ...(record.reason || !reason ? {} : { reason }),
        // A group's expiry follows the latest joiner; shared is read-only, so
        // over-covering a peer never blocks anyone.
        ttlMs: Math.max(record.ttlMs, ttlMs),
        expiresAt,
        history: [...record.history, { sid, at: now, event: 'acquire' as LockEvent }].slice(-LOCK_HISTORY_LIMIT)
      };
      const written = writeLock(record);
      return { status: 'held', record: written, state: stateOf(written, now, sid), renewed: false } as AcquireResult;
    }

    // 3) conflict.
    if (wait) {
      return queueOrFull(record, { sid, at: now, mode, reason }, now);
    }
    record = writeLock(record);
    return {
      status: 'busy',
      record,
      state: stateOf(record, now, sid),
      holders: record.holders,
      remainingMs: Math.max(0, record.expiresAt - now)
    } as AcquireResult;
  });
}

/**
 * Enqueue or report a full queue. The record is written either way, so a reaped
 * expiry (and the untouched queue) is persisted for the next reader.
 */
function queueOrFull(record: LockRecord, waiter: LockWaiter, now: number): AcquireResult {
  const queued = enqueue(record, waiter);
  if (!queued) {
    const written = writeLock(record);
    return {
      status: 'queue-full',
      record: written,
      state: stateOf(written, now, waiter.sid),
      limit: LOCK_QUEUE_LIMIT
    } as AcquireResult;
  }
  const written = writeLock(queued);
  return {
    status: 'queued',
    record: written,
    state: stateOf(written, now, waiter.sid),
    ahead: written.waiters.findIndex(entry => entry.sid === waiter.sid) + 1
  } as AcquireResult;
}

/**
 * Append (or refresh) one waiter; `at` is preserved so FIFO keeps its order.
 *
 * `undefined` = the queue is full (`LOCK_QUEUE_LIMIT`). A full queue refuses the
 * **newcomer** — it never evicts an existing waiter: dropping the oldest entry
 * (a former `slice(-50)`) silently voided the place of the session whose turn
 * was next. A session already in the queue may still refresh its mode/reason.
 */
function enqueue(record: LockRecord, waiter: LockWaiter): LockRecord | undefined {
  const existing = record.waiters.find(entry => entry.sid === waiter.sid);
  if (existing) {
    return {
      ...record,
      waiters: record.waiters.map(entry =>
        entry.sid === waiter.sid ? { ...entry, mode: waiter.mode, ...(waiter.reason ? { reason: waiter.reason } : {}) } : entry
      )
    };
  }
  if (record.waiters.length >= LOCK_QUEUE_LIMIT) return undefined;
  return {
    ...record,
    waiters: [...record.waiters, waiter],
    history: [...record.history, { sid: waiter.sid, at: waiter.at, event: 'wait' as LockEvent }].slice(-LOCK_HISTORY_LIMIT)
  };
}

export type ReleaseResult =
  | { ok: true; record: LockRecord; state: LockState; remaining: string[] }
  | { ok: false; reason: 'free' | 'not-holder'; record?: LockRecord; state: LockState };

/**
 * Release only what this session really holds. `shared` drops just its own
 * entry (the group survives); `exclusive` frees the resource. There is no
 * `force`: preemption is a human decision, and a `[protected*]` holder must
 * never be displaced by a tool call (R6).
 */
export async function release(input: { resource: string; sid: string; now?: number }): Promise<ReleaseResult> {
  return withGuard(input.resource, () => {
    const now = input.now ?? Date.now();
    const current = readLock(input.resource);
    if (!current) {
      return { ok: false, reason: 'free', state: stateOf(emptyLock(input.resource), now, input.sid) } as ReleaseResult;
    }
    const record = reap(current, now);
    if (!record.holders.length) {
      if (record !== current) writeLock(record); // persist the expiry so others see it
      return { ok: false, reason: 'free', record, state: stateOf(record, now, input.sid) } as ReleaseResult;
    }
    if (!record.holders.includes(input.sid)) {
      return {
        ok: false,
        reason: 'not-holder',
        record,
        state: stateOf(record, now, input.sid)
      } as ReleaseResult;
    }
    const remaining = record.holders.filter(sid => sid !== input.sid);
    const next: LockRecord = {
      ...record,
      holders: remaining,
      history: [...record.history, { sid: input.sid, at: now, event: 'release' as LockEvent }].slice(-LOCK_HISTORY_LIMIT)
    };
    if (!remaining.length) {
      next.holder = undefined;
      next.reason = undefined;
      next.acquiredAt = 0;
      next.ttlMs = 0;
      next.expiresAt = 0;
    } else if (record.holder === input.sid) {
      next.holder = remaining[0];
    }
    const written = writeLock(next);
    return { ok: true, record: written, state: stateOf(written, now, input.sid), remaining } as ReleaseResult;
  });
}

/** Leases this session holds or waits for (used by `collab_list`). */
export function locksFor(sid: string | undefined, now = Date.now()): { held: LockState[]; waiting: LockState[] } {
  if (!sid) return { held: [], waiting: [] };
  const held: LockState[] = [];
  const waiting: LockState[] = [];
  for (const record of allLocks()) {
    const state = stateOf(record, now, sid);
    if (state.mine?.held) held.push(state);
    else if (state.mine?.waiting) waiting.push(state);
  }
  return { held, waiting };
}

/** `14m32s` / `45s` — the remaining-TTL shape every listing uses. */
export function fmtTtl(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** One-line description shared by `collab_lock` / `collab_locks` output. */
export function describeState(state: LockState, protect: string[] = []): string {
  const mark = (sid: string): string => (protect.includes(sid) ? ' [protected]' : '');
  if (state.free) {
    const waiters = state.waiters.length
      ? `，排队 ${state.waiters.length} 人（下一位 ${state.waiters[0]?.sid}）`
      : '';
    return `free${waiters}`;
  }
  const holders = state.holders.map(sid => `${sid}${mark(sid)}`).join(', ');
  const ttl = state.ttlMs ? `（ttl=${fmtTtl(state.ttlMs)}）` : '';
  return `${state.mode} 持有者=${holders} 剩余=${fmtTtl(state.expiresIn)}${ttl}`;
}
