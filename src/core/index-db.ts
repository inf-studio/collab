/**
 * 0.9.0 (`11-20-collab-store`, R2/R3/R4/R5/R6): the `collab.db` **projection**.
 *
 * The database is a *derived* store. `collab-messages.jsonl` plus the existing
 * `collab-*.json` files are the truth; `collab.db` can be deleted at any moment
 * and rebuilt (`rebuild`) or topped up with the status-level history of the
 * files written before this version existed (`backfill`).
 *
 * Invariants this module keeps, in the order they matter:
 *
 *   1. **An index failure never blocks a delivery.** `indexInsert` /
 *      `recordMessage` log and return; only `rebuild` / `backfill` (explicit
 *      commands) report.
 *   2. **A failed rebuild keeps the old database.** The new one is built in
 *      `<dbPath>.tmp`, checkpointed, fsynced and only then renamed over the old
 *      file — a crash mid-build leaves the previous projection intact.
 *   3. **Only one rebuild at a time.** `<dbPath>.lock` holds `{pid, at}`; a
 *      second rebuild is refused (a 60 s lock is stale) and writers wait for it
 *      briefly, so the rename cannot race a write into the old inode.
 *   4. **Rebuild is idempotent.** The same input produces the same rows, hence
 *      the same per-table checksum.
 *   5. **`messages.body` is the full body; `messages_fts` indexes at most
 *      `FTS_BODY_LIMIT` (8192 chars ≈ 24KB for CJK).** A search index is not a
 *      second archive.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { DB_FILE, FTS_BODY_LIMIT, REBUILD_SINCE_DAYS } from '../constants.ts';
import { errCode, errText, log } from '../log.ts';
import type {
  BroadcastRecord,
  IndexMetrics,
  IndexStats,
  IndexedMessage,
  LockRecord,
  MessageEnvelope,
  MetricsDayRow,
  OwnerQueueItem,
  RebuildResult,
  SessionInfoLike,
  ThreadIndexEntry
} from '../types.ts';
import { allBroadcasts } from './claim.ts';
import { closeDb, dbRuntimeState, openDb, runSerial, withRetry } from './db-runtime.ts';
import type { DbHandle } from './db-runtime.ts';
import { envelopeHead } from './envelope.ts';
import { readFreezes } from './freeze.ts';
import { freezeFor } from './freeze-pure.ts';
import { allLocks } from './locks.ts';
import { aggregateDay, readPacingCounters, timesByDay } from './metrics.ts';
import type { DayMetricsRow } from './metrics.ts';
import { allQueueItems } from './owner-queue.ts';
import { appendMessage, readMessages } from './store.ts';
import { readThreadIndex } from './thread-index.ts';
import {
  DDL,
  configureIndexStore,
  ensureSchema,
  hasSchema,
  isFresh,
  metaValue,
  resolveStoreOptions,
  setMeta,
  syncRows
} from './index-sync.ts';
import type { SyncSources } from './index-sync.ts';

/** Re-exported for `__internals` / tests (one schema definition). */
export { DDL, configureIndexStore, preferredBroadcasts, preferredHandoff, preferredLocks, preferredQueue } from './index-sync.ts';

/** Tables a checksum is computed for (`meta` minus its volatile keys, see below). */
const TABLES = [
  'meta',
  'sessions',
  'threads',
  'messages',
  'facts',
  'todos',
  'decisions',
  'handoffs',
  'locks',
  'queue',
  'progress',
  'metrics'
] as const;

/** `meta` keys that are bookkeeping, not data: they change on every run. */
const VOLATILE_META = new Set([
  'rebuilt_at',
  'rebuilt_ms',
  'backfilled_at',
  'full_sync_at',
  'synced_broadcasts',
  'synced_locks',
  'synced_queue',
  'synced_threads'
]);

/** `<dbPath>.lock` older than this was left by a crashed rebuild. */
const REBUILD_LOCK_STALE_MS = 60_000;
/** How long a writer waits for a running rebuild before writing anyway. */
const REBUILD_WAIT_MS = 3_000;
export interface StoreOptions {
  /** Projection path; defaults to `collab.json` → `dbPath`, else `DB_FILE`. */
  dbPath?: string;
  /** `json` refuses to create/read the projection (the rollback switch). */
  storage?: 'sqlite' | 'json';
  /** Override the message log (harness). */
  messagesFile?: string;
  /** Override the pacing state file whose `counters[day]` feed `metrics` (harness). */
  pacingFile?: string;
  /** Override the hand-off source (harness). */
  broadcasts?: BroadcastRecord[];
  /** Override the thread index (harness). */
  threads?: Record<string, ThreadIndexEntry>;
  /** Override the lease source (harness). */
  locks?: LockRecord[];
  /** Override the owner-queue source (harness). */
  queue?: OwnerQueueItem[];
  /** Session page for `sessions` (rebuild / sync only; the board uses the host). */
  sessions?: SessionInfoLike[];
  /** `rebuild` keeps only this many days (default `REBUILD_SINCE_DAYS`). */
  sinceDays?: number;
  /** Injected clock (deterministic tests). */
  now?: number;
}

function dbPathOf(options: StoreOptions): string {
  return resolveStoreOptions(options).dbPath;
}

/** Explicit call options + the configured defaults (path / storage mode). */
function resolved(options: StoreOptions): { dbPath: string; storage?: 'sqlite' | 'json' } {
  return resolveStoreOptions(options);
}

function cutoffOf(options: StoreOptions): number {
  const now = Number(options.now) || Date.now();
  const days = Number(options.sinceDays ?? REBUILD_SINCE_DAYS);
  if (!Number.isFinite(days) || days <= 0) return 0;
  return now - days * 24 * 60 * 60 * 1000;
}

/**
 * R1 (`11-21-collab-0p9-close`): rebuild recomputes `metrics` for **every day
 * the message log covers** — never a fabricated day, never a missing one.
 *
 * The measured defect this closes: `rebuild` dropped the whole `metrics` table
 * (`metrics=1` → `metrics=0`), so under the "one global database, kept forever"
 * policy the history was untraceable. `msg_count` / `median_gap_ms` come from
 * the log (resends excluded), `noop_count` / `late_count` from the pacing
 * file's `counters[day]` — the only place they are accumulated.
 */
function metricsRowsOf(messages: MessageEnvelope[], options: StoreOptions): DayMetricsRow[] {
  const counters = readPacingCounters(options.pacingFile);
  const byDay = timesByDay(messages);
  return [...byDay.keys()]
    .sort((left, right) => left.localeCompare(right))
    .map(day => aggregateDay(day, byDay.get(day) ?? [], counters[day] ?? { noop: 0, late: 0 }));
}

/** Which hand-off bids a freeze covers right now (`handoffs.frozen`, display only). */
function frozenBids(records: BroadcastRecord[], now: number): string[] {
  const entries = readFreezes(now);
  if (!entries.length) return [];
  const bids: string[] = [];
  for (const record of records) {
    const bid = String(record.bid ?? '');
    if (!bid) continue;
    if (freezeFor(entries, { bid, workspace: record.workspace })) bids.push(bid);
  }
  return bids;
}

const schemaReady = new Set<string>();

/**
 * Open the projection and make sure the schema exists (write paths only).
 * R2 (review): a lazily created database records `meta.schema` — without it the
 * board reported `[索引不可用]` on a fresh install while rows were being written.
 */
async function openIndex(options: StoreOptions): Promise<DbHandle | undefined> {
  const target = resolved(options);
  const handle = await openDb({ path: target.dbPath, storage: target.storage });
  if (!handle) return undefined;
  if (schemaReady.has(handle.path)) return handle;
  try {
    ensureSchema(handle);
    setMeta(handle, 'schema', '1');
    schemaReady.add(handle.path);
    return handle;
  } catch (error) {
    log(`index schema failed: ${errText(error)}`);
    return undefined;
  }
}

/** The head of a body for the `envelope` column — no second copy of the body. */
function basedOnJson(envelope: MessageEnvelope): string {
  return JSON.stringify(envelope.basedOn ?? { facts: 0 });
}

function factIdsJson(envelope: MessageEnvelope): string | null {
  return envelope.factIds?.length ? JSON.stringify(envelope.factIds) : null;
}

const MESSAGE_INSERT = `INSERT OR IGNORE INTO messages
   (id, thread_id, from_sid, to_sid, sent_at, delivered_at, kind, body, body_len,
    based_on, grade, fact_ids, resend_of, envelope)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * S10 (review): a resend row is a real delivery (`_r<n>`) but must be
 * excludable from metrics. The original id is derivable from the suffix, so the
 * write path needs no extra argument.
 */
function resendOf(id: string): string | null {
  const match = /^(.+)_r(\d+)$/.exec(id);
  return match && match[1].startsWith('msg_') ? match[1] : null;
}

/** Insert one message row (+ FTS only when the row really appeared). */
function insertRow(handle: DbHandle, envelope: MessageEnvelope, deliveredAt: number): boolean {
  const result = handle
    .prepare(MESSAGE_INSERT)
    .run(
      envelope.id,
      envelope.threadId ?? null,
      envelope.from,
      envelope.to,
      envelope.sentAt,
      deliveredAt,
      envelope.kind,
      envelope.body,
      Buffer.byteLength(envelope.body, 'utf8'),
      basedOnJson(envelope),
      envelope.grade,
      factIdsJson(envelope),
      resendOf(envelope.id),
      envelopeHead(envelope)
    ) as { changes?: number | bigint };
  if (Number(result?.changes ?? 0) <= 0) return false;
  const row = handle.prepare('SELECT rowid AS rowid FROM messages WHERE id = ?').get(envelope.id) as
    | { rowid?: number | bigint }
    | undefined;
  if (row?.rowid !== undefined) {
    // R2: the FTS index body is a search index, not a second archive.
    handle.prepare('INSERT INTO messages_fts(rowid, body) VALUES (?, ?)').run(row.rowid, envelope.body.slice(0, FTS_BODY_LIMIT));
  }
  if (envelope.threadId) {
    handle
      .prepare(
        `INSERT INTO threads (id, from_sid, target_sid, kind, opened_at, state, last_at, preview)
         VALUES (?, ?, ?, 'messages', ?, 'open', ?, '')
         ON CONFLICT(id) DO UPDATE SET last_at = MAX(COALESCE(threads.last_at, 0), excluded.last_at)`
      )
      .run(envelope.threadId, envelope.from, envelope.to, envelope.sentAt, envelope.sentAt);
  }
  return true;
}

function insertOne(handle: DbHandle, envelope: MessageEnvelope, deliveredAt?: number): boolean {
  handle.exec('BEGIN IMMEDIATE');
  try {
    const inserted = insertRow(handle, envelope, deliveredAt ?? envelope.sentAt);
    handle.exec('COMMIT');
    return inserted;
  } catch (error) {
    try {
      handle.exec('ROLLBACK');
    } catch {
      /* the transaction may already be gone; the original error matters */
    }
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * A writer waits out a running rebuild (bounded): the rebuild renames the file,
 * and a write that started just before it would land in the old inode. After
 * the wait the inode check in `openDb` re-opens the new file.
 */
async function waitForRebuild(dbPath: string): Promise<void> {
  const lockPath = `${dbPath}.lock`;
  const deadline = Date.now() + REBUILD_WAIT_MS;
  while (Date.now() < deadline) {
    if (!existsSync(lockPath)) return;
    let stale = false;
    try {
      stale = Date.now() - statSync(lockPath).mtimeMs > REBUILD_LOCK_STALE_MS;
    } catch {
      return; // vanished between the two calls
    }
    if (stale) return; // the rebuild itself (or the next one) reclaims it
    await sleep(25);
  }
}

/**
 * R2 write path: insert one message into the projection. **Never throws** and
 * never reports a delivery failure — the message is already out, and the
 * projection is rebuildable (design §5/§7).
 */
export async function indexInsert(envelope: MessageEnvelope, options: StoreOptions = {}): Promise<boolean> {
  const dbPath = dbPathOf(options);
  await waitForRebuild(dbPath);
  const handle = await openIndex(options);
  if (!handle) return false;
  try {
    await withRetry(() => runSerial(`db:${handle.path}`, () => insertOne(handle, envelope)));
    return true;
  } catch (error) {
    log(`index insert failed (${errText(error)}); the projection will be repaired by the next rebuild`);
    return false;
  }
}

/**
 * The one write point used by the delivery path: JSONL **first** (the truth),
 * then the projection. S2 (review): a failed truth write must not be followed by
 * an index write — that would leave the index with a message the log lost.
 */
export async function recordMessage(envelope: MessageEnvelope, options: StoreOptions = {}): Promise<void> {
  try {
    appendMessage(envelope, options.messagesFile ? { file: options.messagesFile } : {});
  } catch (error) {
    log(`message log write failed (${errText(error)}); the delivery itself stands, index skipped`);
    return;
  }
  await indexInsert(envelope, options);
}

/**
 * 0.9.6 (`11-20-collab-pacing`, R6): one row per local day in `metrics`.
 *
 * A partial row is a **merge**, not a replace (`COALESCE(excluded.x, metrics.x)`):
 * the pacing path owns `msg_count` / `noop_count` / `late_count` /
 * `median_gap_ms`, while the facts path writes `retract_count`. Two writers on
 * the same day must not erase each other's fields — an omitted field keeps what
 * is stored. Never throws: a failed metrics write is a log line, and the
 * projection is rebuildable anyway.
 */
export interface MetricsRowInput {
  day: string;
  msg_count?: number;
  fact_count?: number;
  retract_count?: number;
  idle_count?: number;
  drift_ms?: number;
  median_gap_ms?: number;
  noop_count?: number;
  late_count?: number;
}

const METRIC_FIELDS = [
  'msg_count',
  'fact_count',
  'retract_count',
  'idle_count',
  'drift_ms',
  'median_gap_ms',
  'noop_count',
  'late_count'
] as const;

/**
 * The one `metrics` UPSERT statement: the delivery path (`upsertMetrics`) and
 * the rebuild's recompute (`writeMetricsRow`) must not drift apart.
 */
const METRICS_UPSERT = `INSERT INTO metrics (${['day', ...METRIC_FIELDS].join(', ')})
   VALUES (${['?', ...METRIC_FIELDS.map(() => '?')].join(', ')})
   ON CONFLICT(day) DO UPDATE SET ${METRIC_FIELDS.map(field => `${field} = COALESCE(excluded.${field}, metrics.${field})`).join(', ')}`;

function metricsValues(row: MetricsRowInput): (number | null)[] {
  return METRIC_FIELDS.map(field => {
    const value = row[field];
    return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
  });
}

/** Write one row on a handle the caller already owns (inside its transaction). */
function writeMetricsRow(handle: DbHandle, row: MetricsRowInput): boolean {
  const day = String(row?.day ?? '').trim();
  if (!day) return false;
  handle.prepare(METRICS_UPSERT).run(day, ...metricsValues(row));
  return true;
}

export async function upsertMetrics(row: MetricsRowInput, options: StoreOptions = {}): Promise<boolean> {
  const day = String(row?.day ?? '').trim();
  if (!day) return false;
  const dbPath = dbPathOf(options);
  await waitForRebuild(dbPath);
  const handle = await openIndex(options);
  if (!handle) return false;
  try {
    await withRetry(() => runSerial(`db:${handle.path}`, () => writeMetricsRow(handle, row)));
    return true;
  } catch (error) {
    log(`metrics insert failed (${errText(error)}); the projection can be rebuilt`);
    return false;
  }
}

/** Per-table checksum used by the idempotency test (`rebuild` twice). */
export function tableChecksums(handle: DbHandle): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of TABLES) {
    const rows = handle.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    const normalized = table === 'meta' ? rows.filter(row => !VOLATILE_META.has(String(row.key))) : rows;
    normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    out[table] = createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
  }
  return out;
}

function countsOf(handle: DbHandle): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of TABLES) {
    try {
      const row = handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number | bigint };
      out[table] = Number(row?.n ?? 0);
    } catch {
      out[table] = 0;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- rebuild lock */

interface RebuildLock {
  ok: boolean;
  reason?: string;
  release(): void;
}

/** `open(…, "wx")` — the same single-winner pattern as the hand-off claim. */
export function acquireRebuildLock(dbPath: string): RebuildLock {
  const lockPath = `${dbPath}.lock`;
  const noop = () => {};
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      return {
        ok: true,
        release() {
          try {
            unlinkSync(lockPath);
          } catch {
            /* already gone (stale reaper / manual cleanup) */
          }
        }
      };
    } catch (error) {
      if (errCode(error) !== 'EEXIST') return { ok: false, reason: errText(error), release: noop };
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > REBUILD_LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (!stale) {
        return { ok: false, reason: `另一个 rebuild 正在运行（${lockPath}）；稍后重试或等 60s 判定陈旧锁`, release: noop };
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* somebody else reclaimed it first */
      }
    }
  }
  return { ok: false, reason: `无法取得 rebuild 锁（${lockPath}）`, release: noop };
}

/** The default sources of one sync, read from the JSON truth. */
function readSources(options: StoreOptions, applyCutoff = true): SyncSources {
  const cutoff = applyCutoff ? cutoffOf(options) : 0;
  const broadcasts = (options.broadcasts ?? allBroadcasts()).filter(record => {
    if (cutoff === 0) return true;
    return (Number(record.updatedAt ?? record.createdAt ?? 0) || 0) >= cutoff;
  });
  const threads = Object.entries(options.threads ?? readThreadIndex()).filter(([, entry]) => {
    if (cutoff === 0) return true;
    return (Number(entry.lastAt) || 0) >= cutoff;
  });
  return {
    broadcasts,
    threads: Object.fromEntries(threads),
    locks: options.locks ?? allLocks(),
    queue: options.queue ?? allQueueItems(),
    ...(options.sessions ? { sessions: options.sessions } : {}),
    frozenBids: frozenBids(broadcasts, Number(options.now) || Date.now())
  };
}

/**
 * R5 (review): one incremental sync used by `rebuild`, `backfill` and any caller
 * that wants the projection current (the `messages` table keeps its own write
 * path). `meta.synced_at` moves only after every row landed.
 */
export async function indexSync(options: StoreOptions & { sources?: SyncSources } = {}): Promise<{
  ok: boolean;
  counts: Record<string, number>;
  reason?: string;
}> {
  if (options.storage === 'json') return { ok: false, counts: {}, reason: 'storage:json' };
  const handle = await openIndex(options);
  if (!handle) return { ok: false, counts: {}, reason: dbRuntimeState().broken?.reason ?? '索引不可用' };
  const sources = options.sources ?? readSources(options);
  try {
    await withRetry(() =>
      runSerial(`db:${handle.path}`, () => {
        handle.exec('BEGIN IMMEDIATE');
        try {
          syncRows(handle, sources);
          handle.exec('COMMIT');
        } catch (error) {
          try {
            handle.exec('ROLLBACK');
          } catch {
            /* ignore */
          }
          throw error;
        }
      })
    );
    return { ok: true, counts: countsOf(handle) };
  } catch (error) {
    return { ok: false, counts: {}, reason: errText(error) };
  }
}

/**
 * R3: rebuild the projection from the JSON truth into `<dbPath>.tmp`, then
 * `fsync` + atomic rename. Idempotent; the old database survives any failure.
 */
export async function rebuild(options: StoreOptions = {}): Promise<RebuildResult> {
  const startedAt = Date.now();
  const dbPath = dbPathOf(options);
  const empty = (reason: string): RebuildResult => ({
    ok: false,
    dbPath,
    reason,
    ms: Date.now() - startedAt,
    counts: {},
    warnCount: 0
  });
  const target = resolved(options);
  if (target.storage === 'json') return empty('storage:json（纯 JSON 模式，不建立索引）');

  const lock = acquireRebuildLock(dbPath);
  if (!lock.ok) return empty(lock.reason ?? '另一个 rebuild 正在运行');
  try {
    const cutoff = cutoffOf(options);
    const now = Number(options.now) || Date.now();
    const read = readMessages(options.messagesFile ? { file: options.messagesFile } : {});
    const messages = read.messages
      .filter(envelope => cutoff === 0 || envelope.sentAt >= cutoff)
      // Deterministic order: `sent_at`, then id. The rebuild's checksum depends
      // on it, and so does the "same input → same rows" promise.
      .sort((left, right) => left.sentAt - right.sentAt || left.id.localeCompare(right.id));
    const built = new Set(messages.map(message => message.id));
    const sources = readSources(options);

    const tmp = `${dbPath}.tmp`;
    rmSync(tmp, { force: true });
    rmSync(`${tmp}-wal`, { force: true });
    rmSync(`${tmp}-shm`, { force: true });

    const handle = await openDb({ path: tmp, storage: target.storage });
    if (!handle) return empty(dbRuntimeState().broken?.reason ?? '索引不可用（sqlite 未加载）');

    let checksums: Record<string, string> | undefined;
    let counts: Record<string, number> = {};
    try {
      ensureSchema(handle);
      handle.exec('BEGIN IMMEDIATE');
      for (const envelope of messages) insertRow(handle, envelope, envelope.sentAt);
      syncRows(handle, sources);
      // P1-1 (review): a `rebuild`-built database must be readable. `schema` is
      // the readiness marker every `preferred*` reader checks; writing it only
      // in `openIndex` meant "rebuild ok" followed by a board that fell back to
      // JSON until the next delivery happened.
      setMeta(handle, 'schema', '1');
      setMeta(handle, 'rebuilt_at', String(now));
      setMeta(handle, 'rebuilt_ms', String(Date.now() - startedAt));
      setMeta(handle, 'source_messages', String(messages.length));
      handle.exec('COMMIT');
      counts = countsOf(handle);
      // Checksums are computed after the delta + metrics pass (below), so they
      // describe the database that is actually in place.
      // Everything is in the main file after a TRUNCATE checkpoint; closing then
      // removes the (empty) WAL siblings so the rename cannot resurrect them.
      handle.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      closeDb(tmp);
    } catch (error) {
      try {
        handle.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      closeDb(tmp);
      rmSync(tmp, { force: true });
      rmSync(`${tmp}-wal`, { force: true });
      rmSync(`${tmp}-shm`, { force: true });
      return empty(`重建失败：${errText(error)}`);
    }

    rmSync(`${tmp}-wal`, { force: true });
    rmSync(`${tmp}-shm`, { force: true });
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // The cached handle still points at the old inode: close it first, then drop
    // the old WAL siblings (a stale WAL beside a new main file is real corruption).
    closeDb(dbPath);
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    renameSync(tmp, dbPath);

    // Delta pass: writers are paused only while the lock is held, but a message
    // appended between our read and the rename must not be lost from the
    // projection. INSERT OR IGNORE makes the replay idempotent.
    const fresh = await openDb({ path: dbPath, storage: target.storage });
    if (fresh) {
      const after = readMessages(options.messagesFile ? { file: options.messagesFile } : {});
      // F2 (review): the delta pass applies the **same** `sinceDays` window as
      // the initial pass and the `metrics` recompute. Before that, a message
      // appended mid-rebuild with an old `sentAt` landed in `messages` while
      // `metrics` (cutoff-filtered) did not cover it — `stats` then showed
      // `messages=3` with a 2-day coverage. The projection is a derived store:
      // `sinceDays` trims it, the JSONL truth is never trimmed, and
      // `sinceDays:0` rebuilds the full history at any time.
      const inWindow = after.messages.filter(message => cutoff === 0 || message.sentAt >= cutoff);
      const late = inWindow.filter(message => !built.has(message.id));
      // R1: `metrics` is part of the projection. Recompute it from the **final**
      // log (same window as the rebuild) so the returned checksums — and the
      // "two rebuilds agree" promise — cover the rows the operator queries.
      const metricRows = metricsRowsOf(inWindow, options);
      try {
        fresh.exec('BEGIN IMMEDIATE');
        for (const envelope of late) insertRow(fresh, envelope, envelope.sentAt);
        for (const row of metricRows) writeMetricsRow(fresh, row);
        fresh.exec('COMMIT');
        counts = countsOf(fresh);
        checksums = tableChecksums(fresh);
      } catch (error) {
        try {
          fresh.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        log(`rebuild delta/metrics pass failed: ${errText(error)}`);
      }
      closeDb(dbPath);
    }

    // A rebuild changes what `stats` should say: drop the cached verdict so the
    // board / `collab_index stats` agree immediately with the new database.
    resetIndexStatus();
    return {
      ok: true,
      dbPath,
      ms: Date.now() - startedAt,
      counts,
      warnCount: read.warnCount,
      ...(checksums ? { checksums } : {})
    };
  } finally {
    lock.release();
  }
}

/**
 * R6: status-level backfill of the files written before 0.9.0. Bodies are not
 * available (the plugin never stored them), so **no `messages` row is
 * fabricated** — the hand-off / thread / lock / queue rows are what the JSON
 * files really contain. `meta.backfilled=1` records that the history is partial.
 */
export async function backfill(options: StoreOptions = {}): Promise<RebuildResult> {
  const startedAt = Date.now();
  const dbPath = dbPathOf(options);
  const empty = (reason: string): RebuildResult => ({
    ok: false,
    dbPath,
    reason,
    ms: Date.now() - startedAt,
    counts: {},
    warnCount: 0
  });
  if (resolved(options).storage === 'json') return empty('storage:json（纯 JSON 模式，不建立索引）');
  const handle = await openIndex(options);
  if (!handle) return empty(dbRuntimeState().broken?.reason ?? '索引不可用（sqlite 未加载）');

  // Backfill is status-level history by definition: the 180-day rebuild window
  // must not silently drop the older records it exists to restore.
  const sources = readSources(options, false);
  try {
    handle.exec('BEGIN IMMEDIATE');
    syncRows(handle, sources);
    setMeta(handle, 'backfilled', '1');
    setMeta(handle, 'backfilled_at', String(Number(options.now) || Date.now()));
    handle.exec('COMMIT');
  } catch (error) {
    try {
      handle.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    return empty(`回填失败：${errText(error)}`);
  }
  const counts = countsOf(handle);
  resetIndexStatus();
  return { ok: true, dbPath, ms: Date.now() - startedAt, counts, warnCount: 0 };
}

/**
 * R4/R5: what the board and `collab_index stats` show. Read-only: a missing
 * projection is *reported*, never created — a 2 s panel poll must not write a
 * database into `~/.config`.
 */
let statusCache: { key: string; at: number; value: Awaited<ReturnType<typeof computeStatus>> } | undefined;

/**
 * R2 (`11-21-collab-0p9-close`): the days `metrics` actually covers. `undefined`
 * when the table is empty — `stats` then says 「无」 instead of inventing a range.
 */
function metricsCoverage(handle: DbHandle): IndexStats['metricsRange'] {
  try {
    const row = handle.prepare('SELECT MIN(day) AS first, MAX(day) AS last, COUNT(*) AS days FROM metrics').get() as
      | { first?: string | null; last?: string | null; days?: number | bigint }
      | undefined;
    const first = String(row?.first ?? '').trim();
    const last = String(row?.last ?? '').trim();
    if (!first || !last) return undefined;
    return { first, last, days: Number(row?.days ?? 0) };
  } catch {
    return undefined;
  }
}

async function computeStatus(options: StoreOptions): Promise<{
  available: boolean;
  dbPath: string;
  backend?: string;
  reason?: string;
  bytes?: number;
  counts: Record<string, number>;
  backfilled: boolean;
  rebuiltAt?: number;
  metricsRange?: IndexStats['metricsRange'];
}> {
  const dbPath = dbPathOf(options);
  const mode = resolved(options).storage;
  const base = { dbPath, counts: {} as Record<string, number>, backfilled: false };
  if (mode === 'json') return { ...base, available: false, reason: 'storage:json（纯 JSON 模式）' };
  if (!existsSync(dbPath)) return { ...base, available: false, reason: '未建立索引（先跑 collab_index rebuild）' };
  const handle = await openDb({ path: dbPath, storage: mode });
  if (!handle) {
    return { ...base, available: false, reason: dbRuntimeState().broken?.reason ?? '索引不可用' };
  }
  try {
    // P1-1: one readiness rule for `stats.available` and every reader.
    if (!hasSchema(handle)) return { ...base, available: false, reason: '未建立索引（先跑 collab_index rebuild）' };
    const counts = countsOf(handle);
    const rebuiltAt = Number(metaValue(handle, 'rebuilt_at')) || undefined;
    const metricsRange = metricsCoverage(handle);
    return {
      ...base,
      available: true,
      backend: handle.backend,
      bytes: statSync(dbPath).size,
      counts,
      backfilled: metaValue(handle, 'backfilled') === '1',
      ...(rebuiltAt ? { rebuiltAt } : {}),
      ...(metricsRange ? { metricsRange } : {})
    };
  } catch (error) {
    log(`index stats failed: ${errText(error)}`);
    return { ...base, available: false, reason: dbRuntimeState().broken?.reason ?? errText(error) };
  }
}

export async function indexStats(options: StoreOptions = {}): Promise<IndexStats> {
  return computeStatus(options);
}

/** `metrics` rows per `collab_index metrics` call when the caller passes no `limit`. */
export const METRICS_DEFAULT_LIMIT = 30;

/** A stored integer / NULL — never coerced into a fabricated `0`. */
function nullableCount(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * 0.9.7 (`11-21-collab-index-metrics`): the daily `metrics` rows, newest day
 * first. **Read-only in the strict sense** (R2): a missing database is
 * *reported*, never created, and nothing is written — the numbers come straight
 * from the table (R5), so this view can never drift from `rebuild`.
 *
 * The span (`range`) is the **whole** table, not the limited slice: `limit:2` on
 * three days still says 「覆盖 …–…（3 天）」.
 */
export async function indexMetrics(options: StoreOptions & { limit?: number } = {}): Promise<IndexMetrics> {
  const dbPath = dbPathOf(options);
  const mode = resolved(options).storage;
  const base = { dbPath, rows: [] as MetricsDayRow[] };
  if (mode === 'json') return { ...base, available: false, reason: 'storage:json（纯 JSON 模式）' };
  // R2: a read must never leave `collab.db` / `-wal` / `-shm` behind.
  if (!existsSync(dbPath)) return { ...base, available: false, reason: '未建立索引（先跑 collab_index rebuild）' };
  const handle = await openDb({ path: dbPath, storage: mode });
  if (!handle) {
    return { ...base, available: false, reason: dbRuntimeState().broken?.reason ?? '索引不可用' };
  }
  try {
    if (!hasSchema(handle)) return { ...base, available: false, reason: '未建立索引（先跑 collab_index rebuild）' };
    const requested = Math.floor(Number(options.limit ?? METRICS_DEFAULT_LIMIT));
    const limit = Number.isFinite(requested) && requested > 0 ? requested : METRICS_DEFAULT_LIMIT;
    const rows = (
      handle
        .prepare(
          'SELECT day, msg_count, noop_count, late_count, median_gap_ms FROM metrics ORDER BY day DESC LIMIT ?'
        )
        .all(limit) as Record<string, any>[]
    ).map(row => ({
      day: String(row.day),
      msgCount: nullableCount(row.msg_count),
      noopCount: nullableCount(row.noop_count),
      lateCount: nullableCount(row.late_count),
      medianGapMs: nullableCount(row.median_gap_ms)
    }));
    const range = metricsCoverage(handle);
    return { ...base, available: true, backend: handle.backend, rows, ...(range ? { range } : {}) };
  } catch (error) {
    log(`index metrics read failed: ${errText(error)}`);
    return { ...base, available: false, reason: dbRuntimeState().broken?.reason ?? errText(error) };
  }
}

/** The board's `[索引不可用]` verdict, cached so a 2 s poll costs nothing. */
export async function indexStatus(options: StoreOptions & { cacheMs?: number } = {}): Promise<{
  available: boolean;
  reason?: string;
}> {
  const key = `${dbPathOf(options)}|${options.storage ?? 'sqlite'}`;
  const cacheMs = Number(options.cacheMs ?? 30_000);
  if (statusCache && statusCache.key === key && Date.now() - statusCache.at < cacheMs) {
    return { available: statusCache.value.available, ...(statusCache.value.reason ? { reason: statusCache.value.reason } : {}) };
  }
  const value = await computeStatus(options);
  statusCache = { key, at: Date.now(), value };
  return { available: value.available, ...(value.reason ? { reason: value.reason } : {}) };
}

/** Forget the cached verdict (after a rebuild / in tests). */
export function resetIndexStatus(): void {
  statusCache = undefined;
  schemaReady.clear();
}

/**
 * R5 read path: the newest messages from the index, `undefined` when the index
 * cannot answer (the caller then reads the JSON log / existing store).
 * Deterministic: `sent_at DESC, id DESC`.
 */
export async function readMessagesFromIndex(
  options: StoreOptions & { limit?: number; threadId?: string } = {}
): Promise<IndexedMessage[] | undefined> {
  const dbPath = dbPathOf(options);
  const mode = resolved(options).storage;
  if (mode === 'json' || !existsSync(dbPath)) return undefined;
  const handle = await openDb({ path: dbPath, storage: mode });
  if (!handle) return undefined;
  try {
    const limit = Math.max(1, Number(options.limit ?? 50));
    const threadId = String(options.threadId ?? '').trim();
    const rows = (
      threadId
        ? handle
            .prepare(
              `SELECT id, thread_id, from_sid, to_sid, sent_at, delivered_at, kind, body, grade, fact_ids, resend_of
                 FROM messages WHERE thread_id = ? ORDER BY sent_at DESC, id DESC LIMIT ?`
            )
            .all(threadId, limit)
        : handle
            .prepare(
              `SELECT id, thread_id, from_sid, to_sid, sent_at, delivered_at, kind, body, grade, fact_ids, resend_of
                 FROM messages ORDER BY sent_at DESC, id DESC LIMIT ?`
            )
            .all(limit)
    ) as Record<string, any>[];
    return rows.map(row => ({
      id: String(row.id),
      ...(row.thread_id ? { threadId: String(row.thread_id) } : {}),
      from: String(row.from_sid ?? ''),
      to: String(row.to_sid ?? ''),
      sentAt: Number(row.sent_at) || 0,
      ...(row.delivered_at ? { deliveredAt: Number(row.delivered_at) } : {}),
      kind: String(row.kind ?? ''),
      body: String(row.body ?? ''),
      grade: String(row.grade ?? 'unknown'),
      ...(row.fact_ids ? { factIds: JSON.parse(String(row.fact_ids)) as string[] } : {}),
      ...(row.resend_of ? { resendOf: String(row.resend_of) } : {})
    }));
  } catch (error) {
    log(`index read failed: ${errText(error)}`);
    return undefined;
  }
}

/** Exposed for the board: is the projection current enough to serve? */
export function indexFresh(handle: DbHandle): boolean {
  return isFresh(handle);
}
