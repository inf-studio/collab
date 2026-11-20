/**
 * 0.9.0 (`11-20-collab-store`, R2/R4): the SQLite **runtime**, isolated from the
 * schema so the two failure modes that matter can be handled separately:
 *
 *   - **absence**: `node:sqlite` (Node 22.18+) or `bun:sqlite` may not be
 *     importable in this process (a bundler, an old runtime). The import is
 *     therefore dynamic and *lazy* — `storage:'json'` never reaches it at all
 *     (R4: "一次也不得 import"), and every caller treats `null` as "no index".
 *   - **fault**: a broken database (corrupt file, permission error, a driver
 *     that throws on `PRAGMA`) must not be retried on every message. The first
 *     unrecoverable error opens a process-wide breaker: subsequent calls return
 *     `null` immediately and the plugin runs on JSON only (design §7).
 *
 * Writes from one process are serialised (`runSerial`) and cross-process
 * contention is absorbed by `PRAGMA busy_timeout = 5000` plus three exponential
 * retries — the shape the PRD's 3-process acceptance test exercises.
 */
import { statSync } from 'node:fs';
import { errText, log } from '../log.ts';
import { DB_BUSY_TIMEOUT_MS, DB_RETRY_DELAYS_MS } from '../constants.ts';

export type SqliteBackend = 'bun' | 'node';
export type StorageMode = 'sqlite' | 'json';

export interface DbStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface DbHandle {
  backend: SqliteBackend;
  path: string;
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  close(): void;
}

/** A constructor (`new DatabaseSync(path)` / `new Database(path)`). */
export type SqliteCtor = new (path: string) => any;
/** Injected by the harness to exercise the breaker / the "never imported" case. */
export type SqliteLoader = () => Promise<SqliteCtor>;

export interface DbOpenOptions {
  path: string;
  /** `json` returns `null` **without importing anything** (R4 rollback switch). */
  storage?: StorageMode;
  loader?: SqliteLoader;
}

interface RuntimeState {
  imported: boolean;
  broken?: { reason: string; at: number };
  backend: SqliteBackend;
}

const state: RuntimeState = {
  imported: false,
  backend: detectBackend()
};

let cached: { path: string; handle: DbHandle; ino: number } | undefined;
let loadPromise: Promise<SqliteCtor | undefined> | undefined;

/** `typeof Bun !== 'undefined'` — the one honest runtime probe (design §2.4). */
export function detectBackend(): SqliteBackend {
  return (globalThis as { Bun?: unknown }).Bun !== undefined ? 'bun' : 'node';
}

async function defaultLoader(): Promise<SqliteCtor> {
  const backend = detectBackend();
  state.imported = true;
  // A variable specifier keeps the import opaque to the bundler on purpose:
  // `vp pack` must leave it as a runtime `import()`, not try to resolve it.
  const specifier = backend === 'bun' ? 'bun:sqlite' : 'node:sqlite';
  const module: any = await import(specifier);
  const ctor = module?.DatabaseSync ?? module?.Database ?? module?.default?.DatabaseSync ?? module?.default?.Database;
  if (typeof ctor !== 'function') throw new Error(`${specifier}: database constructor not found`);
  return ctor as SqliteCtor;
}

function load(loader?: SqliteLoader): Promise<SqliteCtor | undefined> {
  const source = loader ?? defaultLoader;
  if (!loader && loadPromise) return loadPromise;
  const promise = source().catch((error: unknown) => {
    log(`sqlite import failed: ${errText(error)}`);
    return undefined;
  });
  if (!loader) loadPromise = promise;
  return promise;
}

/**
 * 0.9.0 concurrency review: a `rebuild` replaces the database by rename, so a
 * handle opened before it points at an unlinked inode — every later write would
 * silently vanish (the acceptance race lost 20/40 rows). The cache therefore
 * remembers the inode and `openDb` re-opens whenever `stat(path).ino` differs.
 */
function inoOf(path: string): number {
  try {
    return Number(statSync(path).ino) || 0;
  } catch {
    return 0;
  }
}

function adapt(raw: any, backend: SqliteBackend, path: string): DbHandle {
  const prepare = (sql: string): DbStatement => (backend === 'bun' ? raw.query(sql) : raw.prepare(sql));
  return {
    backend,
    path,
    exec: sql => raw.exec(sql),
    prepare,
    close: () => raw.close()
  };
}

function openHandle(ctor: SqliteCtor, path: string): DbHandle {
  const backend = detectBackend();
  const handle = adapt(new ctor(path), backend, path);
  try {
    // `busy_timeout` first: switching to WAL needs a write lock, and during a
    // 3-process start-up it may already be held (the acceptance race). Without
    // the timeout first, the *open* — not just an insert — would fail busy.
    handle.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS};`);
    handle.exec('PRAGMA journal_mode = WAL;');
    handle.exec('PRAGMA synchronous = NORMAL;');
    return handle;
  } catch (error) {
    try {
      handle.close();
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/**
 * Open (and cache) the projection, or `null` when it must not / cannot be used.
 *
 * The cache is per path: a config change (`dbPath`) re-opens; the process-wide
 * breaker is **not** reset by a path change — a broken driver is a property of
 * the runtime, not of the file.
 */
export async function openDb(options: DbOpenOptions): Promise<DbHandle | null> {
  const path = String(options.path ?? '');
  // R4: the rollback switch is decided *before* anything is imported.
  if (options.storage === 'json') return null;
  if (!path) return null;
  if (state.broken) return null;
  if (cached?.path === path) {
    // The file may have been replaced (`rebuild`) since this handle was opened.
    // A differing inode means every write would go to the deleted old file.
    if (cached.ino === inoOf(path)) return cached.handle;
    try {
      cached.handle.close();
    } catch {
      /* ignore */
    }
    cached = undefined;
  }
  if (cached) {
    try {
      cached.handle.close();
    } catch {
      /* closing a broken handle must not throw a second error */
    }
    cached = undefined;
  }
  const ctor = await load(options.loader);
  if (!ctor) {
    state.broken = { reason: 'sqlite module unavailable', at: Date.now() };
    return null;
  }
  try {
    // The open itself can lose the WAL race to another process; retry it with
    // the same budget as a write instead of tripping the breaker on a busy lock.
    const handle = await withRetry(() => openHandle(ctor, path));
    cached = { path, handle, ino: inoOf(path) };
    return handle;
  } catch (error) {
    breaker(`open failed: ${errText(error)}`);
    return null;
  }
}

/** Process-wide circuit breaker: log once, degrade from then on (design §7). */
export function breaker(reason: string): void {
  if (state.broken) return;
  state.broken = { reason: String(reason || 'unknown sqlite error'), at: Date.now() };
  log(`index disabled for this process: ${state.broken.reason}`);
}

/**
 * The handle already open in this process for `path` (any path when omitted) —
 * the sync write-through path (`mirrorHandoff` / `mirrorLocks` / `mirrorQueue`)
 * must never open a database from a synchronous writer.
 */
export function cachedDb(path?: string): DbHandle | undefined {
  if (!cached) return undefined;
  if (path && cached.path !== path) return undefined;
  if (cached.ino !== inoOf(cached.path)) {
    try {
      cached.handle.close();
    } catch {
      /* ignore */
    }
    cached = undefined;
    return undefined;
  }
  return cached.handle;
}

/** Close the cached handle (a `rebuild` renames the file underneath it). */
export function closeDb(path?: string): void {
  if (!cached) return;
  if (path && cached.path !== path) return;
  try {
    cached.handle.close();
  } catch (error) {
    log(`closing ${cached.path} failed: ${errText(error)}`);
  }
  cached = undefined;
}

/** Test hook / diagnostics: what the runtime has done so far. */
export function dbRuntimeState(): { imported: boolean; backend: SqliteBackend; broken?: { reason: string; at: number } } {
  return { imported: state.imported, backend: state.backend, ...(state.broken ? { broken: { ...state.broken } } : {}) };
}

/** Test hook: forget the cache, the breaker and the import memo. */
export function resetDbRuntime(): void {
  closeDb();
  state.imported = false;
  state.backend = detectBackend();
  delete state.broken;
  loadPromise = undefined;
}

const tails = new Map<string, Promise<unknown>>();

/**
 * Serialise writes inside this process (design §2.4: "单进程内一个 Promise
 * 队列"). One tail per key — the index queue is keyed by the database path, so
 * two databases never wait on each other.
 */
export function runSerial<T>(key: string, task: () => Promise<T> | T): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  tails.set(
    key,
    next.then(
      () => {},
      () => {}
    )
  );
  return next;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Three attempts with exponential backoff. Every attempt is a whole transaction,
 * so a `SQLITE_BUSY` retry cannot leave half a row behind.
 */
export async function withRetry<T>(
  task: () => Promise<T> | T,
  options: { attempts?: number; delays?: number[] } = {}
): Promise<T> {
  const delays = options.delays ?? DB_RETRY_DELAYS_MS;
  const attempts = Math.max(1, options.attempts ?? delays.length + 1);
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      last = error;
      if (attempt >= attempts - 1) break;
      await sleep(delays[Math.min(attempt, delays.length - 1)] ?? 0);
    }
  }
  throw last;
}
