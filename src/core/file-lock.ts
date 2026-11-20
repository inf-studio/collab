/**
 * Cross-process mutual exclusion for the whole-file ledgers (0.9.4 review).
 *
 * `collab-facts.json` / `collab-glossary.json` are **one file per machine**, but
 * each mutation is a *whole-file* read-modify-write. An in-process queue (keyed
 * by workspace / pair) is not enough: two OpenCode processes — different
 * workspaces on the same machine is the normal case — each read the same
 * snapshot and the second write silently erases the first one's workspace
 * entry. The failure is invisible: both processes exit 0 and no error is
 * logged.
 *
 * So every mutation takes `<file>.lock` (`open(…, 'wx')`, atomic on POSIX and
 * Windows) around the read-modify-write, and keeps the `tmp + rename` write.
 * The lock is the **mutual exclusion**, rename is the **atomicity**; neither
 * replaces the other.
 *
 * Rules (mirrors `acquireRebuildLock` in `core/index-db.ts`):
 *
 *   - the lock file carries `{ pid, at, token }` — `token` is what the releaser
 *     compares, so a process that lost its lock to a stale reaper never deletes
 *     the new owner's lock;
 *   - a lock older than `staleMs` (60s) is reclaimed, and so is one whose `pid`
 *     is gone (`kill(pid, 0)` → ESRCH) — a crashed writer must not wedge the
 *     ledger forever;
 *   - 3 attempts with exponential backoff, then a readable refusal (a lock
 *     timeout is an expected, retryable condition — not a defect report);
 *   - a fresh but unreadable lock (the `open` → `write` window) is **not**
 *     treated as stale; age decides, not parseability.
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, watch, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { invalid } from './errors.ts';
import { errCode, errText, log } from '../log.ts';

/** A lock older than this is considered abandoned (a writer never holds it long). */
export const FILE_LOCK_STALE_MS = 60_000;
/**
 * Backoff between attempts. The first retry is quick because the critical
 * section is milliseconds; the later ones cover a *burst* from other processes
 * (25 sequential settles hold the lock tens of times), which a ~200ms total
 * budget starved into a refusal.
 */
export const FILE_LOCK_RETRY_DELAYS_MS = [50, 200, 800];
/**
 * Total acquisition attempts: `1 + delays.length` (4), the same convention as
 * `withRetry` in `core/db-runtime.ts` (`attempts = delays.length + 1`). The
 * earlier `3` made the third delay (800ms) unreachable — the loop slept
 * `50 / 200` and then gave up.
 */
export const FILE_LOCK_ATTEMPTS = FILE_LOCK_RETRY_DELAYS_MS.length + 1;

export interface FileLockHandle {
  file: string;
  lockPath: string;
  token: string;
  release(): void;
}

interface LockOwner {
  pid?: number;
  at?: number;
  token?: string;
}

function token(): string {
  return `${process.pid}:${Date.now()}:${randomBytes(4).toString('hex')}`;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function readOwner(lockPath: string): { owner: LockOwner; ageMs: number; readable: boolean } {
  let ageMs = 0;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return { owner: {}, ageMs: 0, readable: false };
  }
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8'));
    const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return {
      owner: { pid: Number(value.pid) || undefined, at: Number(value.at) || undefined, token: String(value.token ?? '') || undefined },
      ageMs,
      readable: true
    };
  } catch {
    // A fresh lock may be mid-`write` (open then write); age decides staleness.
    return { owner: {}, ageMs, readable: false };
  }
}

/** `kill(pid, 0)`: ESRCH = gone (stale), EPERM = alive but not ours. */
function alive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errCode(error) !== 'ESRCH';
  }
}

function isStale(owner: LockOwner, ageMs: number, staleMs: number): boolean {
  if (ageMs > staleMs) return true;
  // A dead owner is stale even before the timeout — a crashed process must not
  // block the ledger for a minute.
  return Boolean(owner.pid) && !alive(owner.pid);
}

/**
 * Acquire `<file>.lock`, or `undefined` when another live writer holds it.
 * Exported for tests (the ledger's entry points use `withFileLock`).
 */
export function tryAcquireFileLock(
  file: string,
  options: { staleMs?: number } = {},
  depth = 0
): FileLockHandle | undefined {
  const lockPath = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const mine = token();
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token: mine }));
    } finally {
      closeSync(fd);
    }
    return {
      file,
      lockPath,
      token: mine,
      release() {
        // Only delete the lock when the file is readable **and** still carries
        // our token. An unreadable lock is either a different process inside its
        // `open` → `write` window or a lock we already lost to a stale reaper:
        // deleting either would hand two writers the same lock. The 60s stale
        // reaper is the backstop, so leaking here is safe.
        const { owner, readable } = readOwner(lockPath);
        if (!readable || !owner.token || owner.token !== mine) return;
        try {
          unlinkSync(lockPath);
        } catch (error) {
          log(`file lock release failed (${lockPath}): ${errText(error)}`);
        }
      }
    };
  } catch (error) {
    if (errCode(error) !== 'EEXIST') throw error;
    const { owner, ageMs, readable } = readOwner(lockPath);
    const staleMs = Number(options.staleMs) || FILE_LOCK_STALE_MS;
    if (!isStale(owner, ageMs, staleMs)) return undefined;
    // Reclaim: compare the token we judged so a race cannot delete a fresh lock.
    if (readable && owner.token) {
      const again = readOwner(lockPath);
      if (again.owner.token !== owner.token) return undefined;
    }
    try {
      unlinkSync(lockPath);
    } catch {
      /* somebody else reclaimed it first */
    }
    // One reclaim per acquisition chain is enough; a storm of stale locks must
    // not recurse without bound (bounded, then the caller's retry decides).
    return depth >= 1 ? undefined : tryAcquireFileLock(file, options, depth + 1);
  }
}

export interface FileLockOptions {
  staleMs?: number;
  attempts?: number;
  retryDelaysMs?: number[];
  /**
   * Delay injection for tests: every configured backoff must actually be slept
   * through, which a real 1.05s wait would make slow to assert. Production never
   * passes this.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Bounded final wait after the configured attempts (`0` disables it). */
  waitMs?: number;
  /** Longest wait between attempts when no filesystem event arrives. */
  pollMs?: number;
}

/**
 * After the configured attempts, keep **waiting** for the holder instead of
 * sampling once and giving up. Under a 3-process burst the lock is held almost
 * continuously (each write is ~1ms and the loops are tight), so a single sample
 * after the last backoff loses at random — the acceptance measured 4–6 refusals
 * / 9 with a pure attempt count.
 *
 * The wait is **event-driven**: watch the directory and attempt the instant the
 * holder unlinks its lock, with a short timeout as the polling fallback. That
 * makes the lock a queue in practice (one waiter wins per release, the others
 * wait for the next), so a live holder always hands over in a few milliseconds.
 * Only a genuinely stuck holder reaches the deadline.
 */
export const FILE_LOCK_WAIT_MS = 30_000;
/** Longest wait between attempts when no filesystem event arrives. */
export const FILE_LOCK_POLL_MS = 25;

/**
 * Resolve on the next directory change (a lock created / removed) or after
 * `timeoutMs`, whichever comes first. `watch` can miss or coalesce events, so
 * the timeout is the fallback — no busy loop, no missed progress.
 */
function waitForLockEvent(directory: string, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        watcher?.close();
      } catch {
        /* already closed */
      }
      resolve();
    };
    // **Not** unref'd: this timer is the only handle keeping a waiting process
    // alive while the lock is held. An unref'd timer + a non-persistent watcher
    // let Node exit with code 13 ("unsettled top-level await") mid-wait.
    const timer = setTimeout(finish, Math.max(1, timeoutMs));
    try {
      watcher = watch(directory, { persistent: false }, () => finish());
      watcher.on('error', finish);
    } catch {
      /* no watcher available: the timeout is the (slower) fallback */
    }
  });
}

/**
 * Run `fn` while holding `<file>.lock`. Throws a **readable** refusal after the
 * attempts + final wait are exhausted (`ValidationError`, so the report path
 * never files it as a plugin defect): the caller's data is intact, retrying
 * later is correct.
 */
export async function withFileLock<T>(file: string, fn: () => T | Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const delays = Array.isArray(options.retryDelaysMs) && options.retryDelaysMs.length
    ? options.retryDelaysMs
    : FILE_LOCK_RETRY_DELAYS_MS;
  // `attempts = delays.length + 1` (same convention as `withRetry`): one first
  // try plus one retry per delay, so **every** delay is reachable.
  const attempts = Math.max(1, Number(options.attempts) || delays.length + 1);
  const pause = options.sleep ?? sleep;
  const lockPath = `${file}.lock`;
  let last: LockOwner = {};
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const handle = tryAcquireFileLock(file, { staleMs: options.staleMs });
    if (handle) {
      try {
        return await fn();
      } finally {
        handle.release();
      }
    }
    const snapshot = readOwner(lockPath);
    last = snapshot.owner;
    if (attempt < attempts - 1) await pause(delays[Math.min(attempt, delays.length - 1)]);
  }
  // The final bounded wait (a queue, not a sample): every event / poll is itself
  // an acquisition attempt, so a lock released in between is picked up at once.
  const waitMs = options.waitMs === undefined ? FILE_LOCK_WAIT_MS : Math.max(0, Number(options.waitMs) || 0);
  const pollMs = Math.max(1, Number(options.pollMs) || FILE_LOCK_POLL_MS);
  const directory = dirname(file);
  const deadline = Date.now() + waitMs;
  while (waitMs > 0 && Date.now() < deadline) {
    await waitForLockEvent(directory, Math.min(pollMs, Math.max(1, deadline - Date.now())));
    const handle = tryAcquireFileLock(file, { staleMs: options.staleMs });
    if (handle) {
      try {
        return await fn();
      } finally {
        handle.release();
      }
    }
    const snapshot = readOwner(lockPath);
    last = snapshot.owner;
  }
  throw invalid(
    `账本正被另一个进程写入（${lockPath}${last.pid ? `，pid ${last.pid}` : ''}）：未写入任何内容，` +
      '稍后重试即可（锁 60s 后判陈旧；崩溃的持有者按 pid 立即回收）。'
  );
}
