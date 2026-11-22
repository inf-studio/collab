/**
 * 0.9.0 R5 (`11-20-collab-store` review): the **synchronised part** of the
 * projection — every row the board / snapshot / `collab_status` needs, written
 * through one function (`syncRows`) so the read path can never drift from the
 * JSON truth.
 *
 * Three rules make "prefer the index" safe:
 *
 *   1. **Rows are a projection, not a summary.** Each row keeps the typed
 *      columns a query needs *and* the original JSON (`record_json` /
 *      `item_json`), so a reader can reconstruct the exact same object the JSON
 *      path returns. This is the same idea as `messages.envelope`.
 *   2. **Every writer mirrors its own change** (`mirrorHandoff` /
 *      `mirrorLocks` / `mirrorQueue`) on a cached handle, **asynchronously**
 *      (coalesced on a 0 ms timer — a writer never waits on SQLite), and moves
 *      only **that source's** watermark forward.
 *   3. **Stale means JSON, per source.** `meta.synced_broadcasts` /
 *      `synced_locks` / `synced_queue` / `synced_threads` are independent: a
 *      lock written by another process invalidates the **locks** reader only —
 *      a hand-off mirror cannot make stale lock rows look fresh (a global
 *      `synced_at` did exactly that, and the board lost a live lease).
 *   4. **Read paths never create the database.** `readable()` returns
 *      `undefined` unless the file already exists; `mirror()` silently skips a
 *      missing schema instead of logging an error on every write.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { BROADCAST_DIR, DB_FILE, LOCK_DIR, OWNER_QUEUE_DIR, THREAD_INDEX_FILE } from '../constants.ts';
import { errText, log } from '../log.ts';
import type {
  BroadcastRecord,
  LockRecord,
  OwnerQueueItem,
  SessionInfoLike,
  ThreadIndexEntry
} from '../types.ts';
import { cachedDb, openDb } from './db-runtime.ts';
import type { DbHandle } from './db-runtime.ts';

/** The schema. Parent design §2.2 verbatim + the 0.9.0 review's extra columns. */
export const DDL = `
CREATE TABLE IF NOT EXISTS meta        (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS sessions    (id TEXT PRIMARY KEY, title TEXT, directory TEXT,
                                       agent TEXT, first_at INTEGER, last_at INTEGER,
                                       archived_at INTEGER);

CREATE TABLE IF NOT EXISTS threads     (id TEXT PRIMARY KEY, from_sid TEXT, target_sid TEXT,
                                       kind TEXT, opened_at INTEGER,
                                       state TEXT CHECK (state IN ('open', 'answered', 'closed')),
                                       close_reason TEXT,
                                       preview TEXT, last_at INTEGER, bid TEXT);

CREATE TABLE IF NOT EXISTS messages    (id TEXT PRIMARY KEY, thread_id TEXT,
                                       from_sid TEXT, to_sid TEXT,
                                       sent_at INTEGER, delivered_at INTEGER,
                                       kind TEXT, body TEXT, body_len INTEGER,
                                       based_on TEXT,
                                       grade TEXT CHECK (grade IN ('measured', 'inferred', 'relayed', 'unknown')),
                                       fact_ids TEXT,
                                       resend_of TEXT,
                                       envelope TEXT);
CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(thread_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_msg_to     ON messages(to_sid, delivered_at);
CREATE INDEX IF NOT EXISTS idx_msg_from   ON messages(from_sid, sent_at);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(body, content='messages', content_rowid='rowid');

CREATE TABLE IF NOT EXISTS facts       (id TEXT PRIMARY KEY, claim TEXT, grade TEXT, evidence TEXT,
                                       state TEXT CHECK (state IN ('active', 'superseded', 'retracted')),
                                       based_on TEXT, by_sid TEXT, at INTEGER, superseded_by TEXT,
                                       scope TEXT);

CREATE TABLE IF NOT EXISTS todos       (id TEXT PRIMARY KEY, sid TEXT, kind TEXT,
                                       subject TEXT,
                                       status TEXT CHECK (status IN ('open', 'doing', 'blocked', 'suspended', 'drifted', 'closed', 'dropped')),
                                       blocking_on TEXT, parked_by TEXT, parked_at INTEGER,
                                       wake_when TEXT,
                                       since INTEGER, closed_at INTEGER, evidence TEXT);

CREATE TABLE IF NOT EXISTS decisions   (id TEXT PRIMARY KEY, thread_id TEXT, bid TEXT,
                                       question TEXT, options TEXT, owner TEXT,
                                       status TEXT CHECK (status IN ('open', 'answered', 'superseded')),
                                       answer TEXT, by_sid TEXT, at INTEGER);

CREATE TABLE IF NOT EXISTS handoffs    (bid TEXT PRIMARY KEY, from_sid TEXT, claim_by TEXT,
                                       state TEXT CHECK (state IN ('open', 'claimed', 'acked', 'done', 'blocked', 'expired')),
                                       title TEXT, created_at INTEGER,
                                       updated_at INTEGER, thread_id TEXT,
                                       origin_sid TEXT, workspace TEXT, priority TEXT,
                                       frozen INTEGER, claim_kind TEXT, preview TEXT,
                                       archived_at INTEGER, claim_json TEXT,
                                       expired_claim_json TEXT, record_json TEXT);

CREATE TABLE IF NOT EXISTS locks       (id TEXT PRIMARY KEY, scope TEXT, sid TEXT, mode TEXT,
                                       at INTEGER, expires_at INTEGER,
                                       reason TEXT, record_json TEXT);

CREATE TABLE IF NOT EXISTS queue       (id TEXT PRIMARY KEY, target_sid TEXT, from_sid TEXT,
                                       at INTEGER, priority TEXT, summary TEXT,
                                       seen INTEGER, issue_path TEXT, bid TEXT,
                                       revoked_at INTEGER, item_json TEXT);

CREATE TABLE IF NOT EXISTS progress    (sid TEXT, milestone TEXT, title TEXT, done INTEGER,
                                       evidence TEXT, at INTEGER, PRIMARY KEY(sid, milestone));

CREATE TABLE IF NOT EXISTS metrics     (day TEXT PRIMARY KEY, msg_count INTEGER, fact_count INTEGER,
                                       retract_count INTEGER, idle_count INTEGER,
                                       drift_ms INTEGER, median_gap_ms INTEGER,
                                       noop_count INTEGER, late_count INTEGER,
                                       raw_count INTEGER, kept_count INTEGER);
`;

/**
 * Columns added after a database may already exist (`CREATE TABLE IF NOT EXISTS`
 * never alters an existing table). Applied by `migrate()`; the type is only used
 * for a fresh `ALTER TABLE … ADD COLUMN`.
 */
const NEW_COLUMNS: Record<string, Record<string, string>> = {
  sessions: { archived_at: 'INTEGER' },
  threads: { preview: 'TEXT', last_at: 'INTEGER', bid: 'TEXT' },
  handoffs: {
    origin_sid: 'TEXT',
    workspace: 'TEXT',
    priority: 'TEXT',
    frozen: 'INTEGER',
    claim_kind: 'TEXT',
    preview: 'TEXT',
    archived_at: 'INTEGER',
    claim_json: 'TEXT',
    expired_claim_json: 'TEXT',
    record_json: 'TEXT'
  },
  locks: { reason: 'TEXT', record_json: 'TEXT' },
  queue: { seen: 'INTEGER', issue_path: 'TEXT', bid: 'TEXT', revoked_at: 'INTEGER', item_json: 'TEXT' },
  messages: { resend_of: 'TEXT' },
  metrics: { noop_count: 'INTEGER', late_count: 'INTEGER', raw_count: 'INTEGER', kept_count: 'INTEGER' }
};

/** Create missing tables/columns. Idempotent; a new table is created by `DDL`. */
export function ensureSchema(handle: DbHandle): void {
  handle.exec(DDL);
  for (const [table, columns] of Object.entries(NEW_COLUMNS)) {
    let existing: Set<string>;
    try {
      existing = new Set((handle.prepare(`PRAGMA table_info(${table})`).all() as { name?: string }[]).map(row => String(row.name)));
    } catch {
      continue; // table may not exist in a very old / partial database
    }
    for (const [column, type] of Object.entries(columns)) {
      if (existing.has(column)) continue;
      handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}

export function setMeta(handle: DbHandle, key: string, value: string): void {
  handle
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export function metaValue(handle: DbHandle, key: string): string | undefined {
  try {
    const row = handle.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: unknown } | undefined;
    return row?.value === undefined ? undefined : String(row.value);
  } catch {
    return undefined;
  }
}

/** Everything `syncRows` may write, in one input. All arrays are already read. */
export interface SyncSources {
  broadcasts?: BroadcastRecord[];
  threads?: Record<string, ThreadIndexEntry>;
  locks?: LockRecord[];
  queue?: OwnerQueueItem[];
  sessions?: SessionInfoLike[];
  /** Bids frozen at sync time (`handoffs.frozen` — display/query only). */
  frozenBids?: Iterable<string>;
}

export interface SyncCounts {
  handoffs: number;
  threads: number;
  locks: number;
  queue: number;
  sessions: number;
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/**
 * `frozen` is `undefined` on the write-through path: a mirror must **not** clear
 * a freeze another process stamped (S9) — `COALESCE` keeps the stored value and
 * only a full sync (which knows the live freeze list) may set it.
 */
function insertHandoff(handle: DbHandle, record: BroadcastRecord, frozen: boolean | undefined): void {
  const bid = String(record.bid ?? '').trim();
  if (!bid) return;
  const claim = record.claim && typeof record.claim === 'object' ? record.claim : undefined;
  const expired = (record as { expiredClaim?: unknown }).expiredClaim;
  handle
    .prepare(
      `INSERT INTO handoffs
         (bid, from_sid, claim_by, state, title, created_at, updated_at, thread_id,
          origin_sid, workspace, priority, frozen, claim_kind, preview, archived_at,
          claim_json, expired_claim_json, record_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bid) DO UPDATE SET
         from_sid = excluded.from_sid, claim_by = excluded.claim_by, state = excluded.state,
         title = excluded.title, created_at = excluded.created_at, updated_at = excluded.updated_at,
         thread_id = excluded.thread_id, origin_sid = excluded.origin_sid,
         workspace = excluded.workspace, priority = excluded.priority,
         frozen = COALESCE(excluded.frozen, handoffs.frozen),
         claim_kind = excluded.claim_kind, preview = excluded.preview,
         archived_at = excluded.archived_at, claim_json = excluded.claim_json,
         expired_claim_json = excluded.expired_claim_json, record_json = excluded.record_json`
    )
    .run(
      bid,
      String(record.from?.sid ?? ''),
      claim?.by ? String(claim.by) : null,
      String(record.state ?? 'open'),
      String(record.title ?? record.slug ?? ''),
      Number(record.createdAt ?? record.updatedAt ?? 0) || 0,
      Number(record.updatedAt ?? record.createdAt ?? 0) || 0,
      record.threadID ? String(record.threadID) : null,
      String((record as { origin?: { sid?: unknown } }).origin?.sid ?? '') || null,
      record.workspace ? String(record.workspace) : null,
      (record as { priority?: unknown }).priority === 'urgent' ? 'urgent' : null,
      frozen === undefined ? ((record as { frozen?: unknown }).frozen === true ? 1 : null) : frozen ? 1 : 0,
      claim?.kind ? String(claim.kind) : null,
      String((record as { preview?: unknown; title?: unknown }).preview ?? record.title ?? '').slice(0, 200),
      Number((record as { archivedAt?: unknown }).archivedAt) || null,
      jsonOrNull(claim),
      jsonOrNull(expired),
      JSON.stringify(record)
    );
}

function insertThread(handle: DbHandle, threadID: string, entry: ThreadIndexEntry): void {
  handle
    .prepare(
      `INSERT INTO threads (id, from_sid, target_sid, kind, opened_at, state, preview, last_at, bid)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         from_sid = excluded.from_sid, target_sid = excluded.target_sid, kind = excluded.kind,
         opened_at = excluded.opened_at, preview = excluded.preview,
         last_at = excluded.last_at, bid = excluded.bid`
    )
    .run(
      threadID,
      String(entry.from ?? ''),
      String(entry.target ?? ''),
      String(entry.kind ?? 'messages'),
      Number(entry.lastAt) || 0,
      String(entry.preview ?? ''),
      Number(entry.lastAt) || 0,
      entry.bid ? String(entry.bid) : null
    );
}

function insertLock(handle: DbHandle, record: LockRecord): void {
  const resource = String(record.resource ?? '').trim();
  if (!resource) return;
  const holder = String(record.holders?.[0] ?? '');
  const sid = holder || String(record.waiters?.[0]?.sid ?? '');
  handle
    .prepare(
      `INSERT INTO locks (id, scope, sid, mode, at, expires_at, reason, record_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         scope = excluded.scope, sid = excluded.sid, mode = excluded.mode, at = excluded.at,
         expires_at = excluded.expires_at, reason = excluded.reason, record_json = excluded.record_json`
    )
    .run(
      resource,
      String(record.kind ?? 'named'),
      sid,
      String(record.mode ?? 'exclusive'),
      Number(record.acquiredAt) || 0,
      Number(record.expiresAt) || 0,
      record.reason ? String(record.reason) : null,
      JSON.stringify(record)
    );
}

function insertQueueItem(handle: DbHandle, item: OwnerQueueItem): void {
  const id = String(item.id ?? '').trim();
  if (!id) return;
  handle
    .prepare(
      `INSERT INTO queue (id, target_sid, from_sid, at, priority, summary, seen, issue_path, bid, revoked_at, item_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         target_sid = excluded.target_sid, from_sid = excluded.from_sid, at = excluded.at,
         priority = excluded.priority, summary = excluded.summary, seen = excluded.seen,
         issue_path = excluded.issue_path, bid = excluded.bid, revoked_at = excluded.revoked_at,
         item_json = excluded.item_json`
    )
    .run(
      id,
      String(item.target ?? ''),
      String(item.from ?? ''),
      Number(item.at) || 0,
      item.priority === 'urgent' ? 'urgent' : null,
      String(item.summary ?? ''),
      item.seenAt ? 1 : 0,
      item.issuePath ? String(item.issuePath) : null,
      item.bid ? String(item.bid) : null,
      Number(item.revokedAt) || null,
      JSON.stringify(item)
    );
}

function insertSession(handle: DbHandle, info: SessionInfoLike): void {
  const id = String(info?.id ?? '').trim();
  if (!id) return;
  const time = (info.time ?? {}) as { created?: number; updated?: number; archived?: number | boolean };
  const archived = time.archived ? Number(time.archived) || 1 : null;
  handle
    .prepare(
      `INSERT INTO sessions (id, title, directory, agent, first_at, last_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, directory = excluded.directory, agent = excluded.agent,
         first_at = COALESCE(sessions.first_at, excluded.first_at),
         last_at = excluded.last_at, archived_at = excluded.archived_at`
    )
    .run(
      id,
      String(info.title ?? ''),
      String(info.location?.directory ?? info.location?.workspace ?? ''),
      String(info.agent ?? ''),
      Number(time.created) || null,
      Number(time.updated) || 0,
      archived
    );
}

/**
 * Write a set of sources into the projection. Caller controls the transaction
 * (`rebuild` runs it inside its own); every **source watermark** moves after the
 * rows, so a reader can never see a watermark ahead of half a table.
 */
export function syncRows(
  handle: DbHandle,
  sources: SyncSources,
  options: { replaceLocks?: boolean; replaceQueue?: boolean } = {}
): SyncCounts {
  const frozen = new Set([...(sources.frozenBids ?? [])].map(String));
  // A sync is a *mirror*: a row whose file disappeared must disappear too, or a
  // rebuild would keep resurrecting records the source pruned. (Mirroring one
  // record uses `mirrorHandoff`, never this path.)
  if (sources.broadcasts) handle.exec('DELETE FROM handoffs');
  if (sources.threads) handle.exec('DELETE FROM threads');
  let handoffs = 0;
  for (const record of sources.broadcasts ?? []) {
    insertHandoff(handle, record, frozen.has(String(record.bid ?? '')));
    handoffs += 1;
  }
  let threads = 0;
  for (const [threadID, entry] of Object.entries(sources.threads ?? {})) {
    if (!threadID || !entry) continue;
    insertThread(handle, threadID, entry);
    threads += 1;
  }
  if (sources.locks) {
    if (options.replaceLocks !== false) handle.exec('DELETE FROM locks');
    for (const record of sources.locks) insertLock(handle, record);
  }
  if (sources.queue) {
    if (options.replaceQueue !== false) handle.exec('DELETE FROM queue');
    for (const item of sources.queue) insertQueueItem(handle, item);
  }
  let sessions = 0;
  for (const info of sources.sessions ?? []) {
    insertSession(handle, info);
    sessions += 1;
  }
  const syncedAt = String(Date.now());
  // Only a source that was actually written earns its watermark: a partial sync
  // must not make an untouched table look current.
  if (sources.broadcasts) setMeta(handle, WATERMARK.broadcasts, syncedAt);
  if (sources.threads) setMeta(handle, WATERMARK.threads, syncedAt);
  if (sources.locks) setMeta(handle, WATERMARK.locks, syncedAt);
  if (sources.queue) setMeta(handle, WATERMARK.queue, syncedAt);
  // `full_sync_at` is the completeness marker: only a sync that wrote **every**
  // source may claim the projection mirrors the truth. A write-through mirror
  // moves one watermark alone (it proves freshness of one table, not that the
  // table is complete).
  setMeta(handle, 'full_sync_at', syncedAt);
  return { handoffs, threads, locks: sources.locks?.length ?? 0, queue: sources.queue?.length ?? 0, sessions };
}

/* ------------------------------------------------------------------ freshness */

/** The four independently mirrored sources. */
export type IndexSource = 'broadcasts' | 'locks' | 'queue' | 'threads';

/** Per-source watermark key: one source's staleness never hides another's rows. */
const WATERMARK: Record<IndexSource, string> = {
  broadcasts: 'synced_broadcasts',
  locks: 'synced_locks',
  queue: 'synced_queue',
  threads: 'synced_threads'
};

const STAT_LIMIT = 500;

function newestMtime(path: string, depth = 0): number {
  let newest = 0;
  try {
    const stat = statSync(path);
    newest = stat.mtimeMs;
    if (!stat.isDirectory() || depth > 1) return newest;
    const names = readdirSync(path).slice(0, STAT_LIMIT);
    for (const name of names) {
      const child = newestMtime(`${path}/${name}`, depth + 1);
      if (child > newest) newest = child;
    }
  } catch {
    return 0;
  }
  return newest;
}

/** The newest mtime of one source (the staleness signal for its readers). */
export function sourceStamp(source: IndexSource = 'broadcasts'): number {
  switch (source) {
    case 'locks':
      return newestMtime(LOCK_DIR);
    case 'queue':
      return newestMtime(OWNER_QUEUE_DIR);
    case 'threads':
      return newestMtime(THREAD_INDEX_FILE);
    default:
      return newestMtime(BROADCAST_DIR);
  }
}

/** `full_sync_at` exists and this source's watermark covers its files. */
export function isFresh(handle: DbHandle, source: IndexSource = 'broadcasts'): boolean {
  const synced = Number(metaValue(handle, WATERMARK[source])) || 0;
  const full = Number(metaValue(handle, 'full_sync_at')) || 0;
  return synced > 0 && full > 0 && synced >= sourceStamp(source);
}

/* ------------------------------------------------------------------- mirroring */

interface PendingMirrors {
  handoffs: BroadcastRecord[];
  locks: LockRecord[];
  queue?: OwnerQueueItem[];
}

const pending: PendingMirrors = { handoffs: [], locks: [] };
let flushScheduled = false;

function tableExists(handle: DbHandle, table: string): boolean {
  try {
    handle.prepare(`SELECT 1 FROM ${table} LIMIT 0`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply the queued write-through. Never creates a database and never logs when
 * the projection has no schema yet: a plugin that has not run `rebuild` must not
 * see a "mirror failed" line after every write.
 */
export function flushMirrors(dbPath?: string): void {
  flushScheduled = false;
  const batch = { handoffs: pending.handoffs.splice(0), locks: pending.locks.splice(0), queue: pending.queue };
  pending.queue = undefined;
  if (!batch.handoffs.length && !batch.locks.length && !batch.queue) return;
  const handle = cachedDb(dbPath);
  if (!handle) return; // not open here: the file mtime already marks the source stale
  // Decide the tables *before* opening a transaction: a missing schema is the
  // "not built yet" case, which must be silent (P1-2), never an open transaction.
  if (!metaValue(handle, 'schema')) return;
  const writeHandoffs = batch.handoffs.length > 0 && tableExists(handle, 'handoffs');
  const writeLocks = batch.locks.length > 0 && tableExists(handle, 'locks');
  const writeQueue = Boolean(batch.queue) && tableExists(handle, 'queue');
  if (!writeHandoffs && !writeLocks && !writeQueue) return;
  try {
    handle.exec('BEGIN IMMEDIATE');
    if (writeHandoffs) {
      for (const record of batch.handoffs) insertHandoff(handle, record, undefined);
      setMeta(handle, WATERMARK.broadcasts, String(Date.now()));
    }
    if (writeLocks) {
      for (const record of batch.locks) insertLock(handle, record);
      setMeta(handle, WATERMARK.locks, String(Date.now()));
    }
    if (writeQueue && batch.queue) {
      handle.exec('DELETE FROM queue');
      for (const item of batch.queue) insertQueueItem(handle, item);
      setMeta(handle, WATERMARK.queue, String(Date.now()));
    }
    handle.exec('COMMIT');
  } catch (error) {
    try {
      handle.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    log(`index mirror failed (${errText(error)}); the board will read JSON until the next rebuild`);
  }
}

/**
 * S11 (review): writers never wait on SQLite. A mirror is queued and applied on
 * the next 0 ms tick (coalesced), so a `busy_timeout=5000` contention can never
 * stall `writeBroadcast` / `writeLock` / `enqueue`. Until it runs, the source
 * mtime is ahead of its watermark → readers fall back to JSON (safe).
 */
function scheduleMirror(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  const timer = setTimeout(() => flushMirrors(), 0);
  (timer as { unref?: () => void }).unref?.();
}

export function mirrorHandoff(record: BroadcastRecord): boolean {
  pending.handoffs.push(record);
  scheduleMirror();
  return true;
}

export function mirrorLocks(records: LockRecord[]): boolean {
  pending.locks.push(...records);
  scheduleMirror();
  return true;
}

export function mirrorQueue(items: OwnerQueueItem[]): boolean {
  pending.queue = items;
  scheduleMirror();
  return true;
}

/* ---------------------------------------------------------------- read side */

type ReaderOptions = { dbPath?: string; storage?: 'sqlite' | 'json' };

/**
 * The tool / snapshot call sites do not know the configured path; `setup`
 * registers the reader once (`configureIndexStore`), exactly like the config
 * reader. An explicit `dbPath` in a call always wins (harness / tests).
 */
let storeDefaults: (() => ReaderOptions) | undefined;

export function configureIndexStore(provider: () => ReaderOptions): void {
  storeDefaults = provider;
}

/** The effective projection path / mode (configured defaults + explicit call). */
export function resolveStoreOptions(options: ReaderOptions = {}): { dbPath: string; storage?: 'sqlite' | 'json' } {
  const defaults = storeDefaults?.() ?? {};
  return {
    dbPath: String(options.dbPath ?? defaults.dbPath ?? DB_FILE),
    ...(options.storage ?? defaults.storage ? { storage: options.storage ?? defaults.storage } : {})
  };
}

function resolveOptions(options: ReaderOptions): ReaderOptions {
  const defaults = storeDefaults?.() ?? {};
  return {
    ...(options.dbPath ?? defaults.dbPath ? { dbPath: options.dbPath ?? defaults.dbPath } : {}),
    ...(options.storage ?? defaults.storage ? { storage: options.storage ?? defaults.storage } : {})
  };
}

/**
 * Is this handle a usable projection? One definition shared by the readers and
 * `indexStats.available`, so "stats says available" and "the board reads it"
 * can never disagree.
 */
export function hasSchema(handle: DbHandle): boolean {
  if (metaValue(handle, 'schema')) return true;
  // A database written before `meta.schema` existed (or by an older build): any
  // real row proves the tables work. Never treat an empty file as built.
  try {
    for (const table of ['messages', 'handoffs', 'locks', 'queue', 'threads']) {
      const row = handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number | bigint };
      if (Number(row?.n ?? 0) > 0) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** `undefined` = not available / not current → caller reads JSON (no exception). */
async function readable(rawOptions: ReaderOptions, source: IndexSource = 'broadcasts'): Promise<DbHandle | undefined> {
  const options = resolveOptions(rawOptions);
  if (options.storage === 'json') return undefined;
  if (!options.dbPath) return undefined;
  // P1-2: a read path must never create the database (opening a missing file
  // would leave `collab.db` + `-shm`/`-wal` behind after one `collab_status`).
  if (!existsSync(String(options.dbPath))) return undefined;
  const handle = await openDb({ path: String(options.dbPath), storage: options.storage });
  if (!handle) return undefined;
  try {
    if (!hasSchema(handle)) return undefined;
    return isFresh(handle, source) ? handle : undefined;
  } catch (error) {
    log(`index freshness check failed: ${errText(error)}`);
    return undefined;
  }
}

function parseRows(rows: unknown[]): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const row of rows as { record_json?: string }[]) {
    try {
      out.push(JSON.parse(String(row.record_json ?? '')) as Record<string, any>);
    } catch {
      /* a corrupt row is skipped, never fatal */
    }
  }
  return out;
}

export async function preferredBroadcasts(options: ReaderOptions = {}): Promise<BroadcastRecord[] | undefined> {
  const handle = await readable(options, 'broadcasts');
  if (!handle) return undefined;
  const rows = handle.prepare('SELECT record_json FROM handoffs ORDER BY bid').all();
  return parseRows(rows) as BroadcastRecord[];
}

export async function preferredHandoff(bid: string, options: ReaderOptions = {}): Promise<BroadcastRecord | undefined> {
  const wanted = String(bid ?? '').trim();
  if (!wanted) return undefined;
  const handle = await readable(options, 'broadcasts');
  if (!handle) return undefined;
  const row = handle.prepare('SELECT record_json FROM handoffs WHERE bid = ?').get(wanted) as
    | { record_json?: string }
    | undefined;
  if (!row?.record_json) return undefined;
  try {
    return JSON.parse(row.record_json) as BroadcastRecord;
  } catch {
    return undefined;
  }
}

export async function preferredLocks(options: ReaderOptions = {}): Promise<LockRecord[] | undefined> {
  const handle = await readable(options, 'locks');
  if (!handle) return undefined;
  const rows = handle.prepare('SELECT record_json FROM locks ORDER BY id').all();
  return parseRows(rows) as LockRecord[];
}

export async function preferredQueue(from: string, options: ReaderOptions = {}): Promise<OwnerQueueItem[] | undefined> {
  const sid = String(from ?? '').trim();
  if (!sid) return undefined;
  const handle = await readable(options, 'queue');
  if (!handle) return undefined;
  const rows = handle.prepare('SELECT item_json, revoked_at FROM queue WHERE from_sid = ? ORDER BY at').all(sid) as {
    item_json?: string;
    revoked_at?: number | null;
  }[];
  const out: OwnerQueueItem[] = [];
  for (const row of rows) {
    if (row.revoked_at) continue;
    try {
      out.push(JSON.parse(String(row.item_json ?? '')) as OwnerQueueItem);
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}
