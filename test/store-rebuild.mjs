/**
 * 0.9.0 (`11-20-collab-store`): message history + SQLite projection.
 *
 *   pnpm test          # builds dist/ first; this file is part of the chain
 *   node test/store-rebuild.mjs
 *
 * Everything is driven through the built `dist/index.js` and temp paths — no
 * host, no `~/.config/opencode/collab-*`, no network. The eight cases are the
 * design's acceptance list (§10), plus the tool-surface check (22 → 23):
 *
 *   1. tool surface: `collab_index` registered exactly once, 23 tools, schema +
 *      description state the three verbs / idempotency / confirm
 *   2. R4 rollback switch: `storage:"json"` → `stats` says `[索引不可用]` and
 *      sqlite is **never imported** (`dbRuntimeState().imported === false`)
 *   3. R1/R2/R3: 1.5MB body → exactly 2 JSONL lines, full round-trip, the
 *      `messages` row keeps the full body, FTS matches only the first 8KB;
 *      two rebuilds → identical row counts **and** per-table checksums, and
 *      every `sent_at` equals the envelope's `sentAt` (the mutation target)
 *   4. corrupt line: one invalid JSON line → rebuild succeeds, count = valid
 *      lines, `warnCount` = 1
 *   5. degrade: a corrupt database file → `stats`/`indexStatus` report
 *      unavailable, no throw, and the JSON read path still returns everything
 *   6. circuit breaker: an injected driver that throws on `exec` opens the
 *      breaker once; the next open returns null without importing / throwing
 *   7. read path: the index message read equals the JSONL read (id/body/at);
 *      a snapshot with the index reader carries every JSON row unchanged and
 *      only adds the `index` marker (byte-for-byte outside that field)
 *   8. concurrency: 3 processes × 100 messages → 300 rows, 300 lines, no dup
 *   9. backfill: 24 hand-offs + 49 threads, `meta.backfilled=1`, and **no**
 *      fabricated `messages` rows (bodies were never stored)
 *  10. R1/R2 (0.9.7): `rebuild` recomputes `metrics` — equal to the write path
 *      day by day, resends excluded, `noop`/`late` from the pacing counters,
 *      the same checksum twice, `sinceDays` bounds the window, and `stats`
 *      prints the coverage range (「无」 when empty)
 *  11. R1/R2/R5 (0.9.7, `11-21-collab-index-metrics`): the read-only `metrics`
 *      action — newest day first, values straight from the table, `limit`
 *      bounds the shown rows but not the coverage line, NULL prints `-`, an
 *      empty table says 「metrics 无数据」, a missing database says
 *      「[索引不可用]」 **and creates no file**, and `collab.db`'s size/mtime are
 *      unchanged by the read.
 *
 * Exits 1 if any check fails.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  utimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
const root = mkdtempSync(join(base, 'collab-store-'));
const dist = resolve(import.meta.dirname, '../dist/index.js');
const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'));

// Global paths are read once at module load: point every one of them inside the
// temp dir *before* the import (the same pattern as `handoff-harness.mjs`).
const messagesFile = join(root, 'collab-messages.jsonl');
const dbPath = join(root, 'collab.db');
const broadcastDir = join(root, 'broadcast');
const threadIndexFile = join(root, 'collab-threads.json');
const configFile = join(root, 'collab.json');
const lockDir = join(root, 'locks');
const ownerQueueDir = join(root, 'owner-queue');
process.env.COLLAB_MESSAGES_FILE = messagesFile;
process.env.COLLAB_DB_FILE = dbPath;
process.env.COLLAB_CONTRACT_DIR = join(root, 'contract');
// 0.9.7 (`11-21-collab-decision-inbox`): `buildSnapshot` also scans the decision
// ledger — pin it to an empty temp dir (hermetic; never the operator's real one).
process.env.COLLAB_DECISIONS_DIR = join(root, 'decisions');
process.env.COLLAB_BROADCAST_DIR = broadcastDir;
process.env.COLLAB_THREAD_INDEX_FILE = threadIndexFile;
process.env.COLLAB_CONFIG = configFile;
// 0.9.6 (`11-20-collab-pacing`): the window buffer is a global file too — keep
// the operator's real one untouched (this suite never exercises batching).
process.env.COLLAB_PACING_FILE = join(root, 'collab-pacing.json');
process.env.COLLAB_LOCK_DIR = lockDir;
process.env.COLLAB_OWNER_QUEUE_DIR = ownerQueueDir;
process.env.COLLAB_FREEZE_FILE = join(root, 'freeze.json');
process.env.COLLAB_AUDIT_FILE = join(root, 'collab-audit.jsonl');
mkdirSync(broadcastDir, { recursive: true });

const built = await import(pathToFileURL(dist).href);
const plugin = built.default;
const internals = built.__internals;
const {
  makeEnvelope,
  envelopeLines,
  parseEnvelopeLine,
  appendMessage,
  readMessages,
  openDb,
  closeDb,
  resetDbRuntime,
  dbRuntimeState,
  indexInsert,
  indexStatus,
  indexStats,
  readMessagesFromIndex,
  resetIndexStatus,
  rebuildIndex,
  backfillIndex,
  buildSnapshot,
  recordMessage,
  indexSync,
  flushMirrors,
  writeBroadcast,
  acquireRebuildLock,
  preferredBroadcasts,
  preferredLocks,
  preferredQueue,
  allBroadcasts,
  allLocks,
  mineFor
} = internals;

const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};

/** Fresh runtime + status cache before a scenario that opens a database. */
const fresh = () => {
  resetDbRuntime();
  resetIndexStatus();
  closeDb();
};

const fileLines = path => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []);

// ============================ 1) tool surface (22 → 23, `collab_index`)
const registered = [];
const host = {
  location: { directory: root },
  options: {},
  storage: { get: async () => undefined, set: async () => undefined },
  session: { hook: async () => ({}), prompt: async () => ({ id: 'msg_x' }) },
  tool: {
    transform: async editor => {
      const domain = { add: definition => registered.push(definition) };
      editor(domain);
    }
  },
  event: {
    subscribe: async function* () {
      return;
    }
  }
};
const dispose = await plugin.setup(host);
const byName = name => registered.find(definition => definition.name === name);
const indexDefinition = byName('collab_index');
expect(
  '工具面 28 → 29：collab_index 只注册一次，0.9.1 的契约工具 / 0.9.7 的决策清单都在',
  registered.length === 29 && Boolean(indexDefinition),
  `${registered.length} tool(s)`
);expect(
  'collab_index 的 schema 只有 rebuild | backfill | stats | metrics 与 confirm/sinceDays/limit',
  Boolean(indexDefinition) &&
    indexDefinition.input.additionalProperties === false &&
    JSON.stringify(indexDefinition.input.properties.action.enum) ===
      JSON.stringify(['rebuild', 'backfill', 'stats', 'metrics']) &&
    indexDefinition.input.properties.action.type === 'string' &&
    indexDefinition.input.properties.confirm.type === 'boolean' &&
    indexDefinition.input.properties.limit.type === 'number',
  Object.keys(indexDefinition?.input?.properties ?? {}).join(',')
);
const indexDescription = String(indexDefinition?.description ?? '');
expect(
  '描述写明：幂等 rebuild / 原子替换 / JSON 是真源 / backfill 不伪造正文 / confirm',
  /idempotent/i.test(indexDescription) &&
    /atomically renames/.test(indexDescription) &&
    /source of\s+truth/i.test(indexDescription) &&
    /never stored/.test(indexDescription) &&
    /confirm:true/.test(indexDescription),
  indexDescription.slice(0, 140)
);
expect(
  'PLUGIN_VERSION 与 package.json 一致（0.9.6）',
  internals.PLUGIN_VERSION === pkg.version,
  `${internals.PLUGIN_VERSION} vs ${pkg.version}`
);
const runIndexTool = input => indexDefinition.execute(input, { sessionID: 'ses_tool' });

// ============================ 2) R4: storage:"json" never imports sqlite
fresh();
writeFileSync(configFile, JSON.stringify({ storage: 'json' }));
const jsonStats = await runIndexTool({ action: 'stats' });
expect(
  'storage:"json"：stats 报 [索引不可用]，且一次也没有 import sqlite',
  /\[索引不可用\]/.test(jsonStats.content) &&
    /storage:json/.test(jsonStats.content) &&
    dbRuntimeState().imported === false,
  `imported=${dbRuntimeState().imported}`
);
const jsonRebuild = await runIndexTool({ action: 'rebuild', confirm: true });
expect(
  'storage:"json"：rebuild 也拒绝（不建库、不 import）',
  /纯 JSON 模式/.test(jsonRebuild.content) &&
    dbRuntimeState().imported === false &&
    !existsSync(dbPath),
  `db exists=${existsSync(dbPath)}`
);
// The config reader caches by `statSync().mtimeMs`; on this filesystem two
// writes inside the same timestamp bucket keep serving the first one, so the
// test separates the two config writes by more than a second.
await new Promise(resolve => setTimeout(resolve, 1100));
writeFileSync(configFile, JSON.stringify({ storage: 'sqlite' }));

// ============================ 3) sharding + rebuild idempotency + sent_at
fresh();
const bigBody = `HEADTOKEN ${'x'.repeat(1_500_000)} TAILTOKEN`;
const bigEnvelope = makeEnvelope({
  id: 'msg_big',
  threadId: 't_store_big',
  from: 'ses_store_a',
  to: 'ses_store_b',
  sentAt: 1_700_000_000_001,
  kind: 'note',
  body: bigBody
});
const encoded = envelopeLines(bigEnvelope);
expect(
  '1.5MB body 拆成 2 行，每行 ≤ 1MB（UTF-8 字节）',
  encoded.length === 2 && encoded.every(line => Buffer.byteLength(line) <= 1024 * 1024),
  `${encoded.length} line(s) / ${encoded.map(line => Buffer.byteLength(line)).join(',')}`
);
appendMessage(bigEnvelope, { file: messagesFile });
const smallEnvelope = makeEnvelope({
  id: 'msg_small',
  threadId: 't_store_big',
  from: 'ses_store_a',
  to: 'ses_store_b',
  sentAt: 1_700_000_000_002,
  kind: 'reply',
  body: '收到：先看帧'
});
appendMessage(smallEnvelope, { file: messagesFile });
const roundTrip = readMessages({ file: messagesFile });
expect(
  '读回：分片合并为全文，坏行 0，数量 2',
  roundTrip.messages.length === 2 &&
    roundTrip.messages[0].body === bigBody &&
    roundTrip.warnCount === 0,
  `${roundTrip.messages.length} message(s) / warn=${roundTrip.warnCount}`
);
const first = await rebuildIndex({ dbPath, messagesFile, broadcasts: [], threads: {}, sinceDays: 0 });
const second = await rebuildIndex({ dbPath, messagesFile, broadcasts: [], threads: {}, sinceDays: 0 });
// F5 (0.10.x): `undefined === undefined` was green — a rebuild that stopped
// returning checksums at all passed the "same checksum" comparison. Pin the
// shape first (a real sha-16 string), then compare.
expect(
  'rebuild 幂等：两次行数与每表 checksum 完全相同',
  first.ok &&
    second.ok &&
    typeof first.checksums?.messages === 'string' &&
    typeof second.checksums?.messages === 'string' &&
    JSON.stringify(first.counts) === JSON.stringify(second.counts) &&
    JSON.stringify(first.checksums) === JSON.stringify(second.checksums),
  `messages=${first.counts.messages} / checksum=${first.checksums?.messages}`
);
const rebuilt = await openDb({ path: dbPath });
const sentAtRows = rebuilt.prepare('SELECT id, sent_at FROM messages ORDER BY id').all();
const bodyLenRow = rebuilt.prepare('SELECT body_len, length(body) AS n FROM messages WHERE id = ?').get('msg_big');
expect(
  'rebuild 写入 sent_at（与信封一致）——去掉赋值这一组断言必须变红',
  sentAtRows.length === 2 &&
    Number(sentAtRows[0].sent_at) === bigEnvelope.sentAt &&
    Number(sentAtRows[1].sent_at) === smallEnvelope.sentAt,
  JSON.stringify(sentAtRows.map(row => Number(row.sent_at)))
);
expect(
  'messages.body 存全文（1500020 字），FTS 只索引前 8KB：HEAD 命中、TAIL 不命中',
  Number(bodyLenRow.n) === bigBody.length &&
    Number(bodyLenRow.body_len) === Buffer.byteLength(bigBody, 'utf8') &&
    Number(rebuilt.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'HEADTOKEN'").get().n) === 1 &&
    Number(rebuilt.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'TAILTOKEN'").get().n) === 0,
  `body=${bodyLenRow.n}/${bodyLenRow.body_len}B`
);
closeDb();
const statsAfter = await indexStats({ dbPath });
expect(
  'stats：索引可用、backend=node、messages=2',
  statsAfter.available &&
    statsAfter.backend === 'node' &&
    statsAfter.counts.messages === 2 &&
    !statsAfter.backfilled,
  `${statsAfter.backend} / messages=${statsAfter.counts.messages}`
);

// --- S5 (review): the 1MB budget is the **encoded** line, not the raw body.
const boundaryBodies = [
  { name: '700k 双引号（每个转义成 \\"）', body: '"'.repeat(700_000) },
  { name: '600k CJK（每字 3 字节 UTF-8）', body: '你'.repeat(600_000) },
  { name: '700k 换行（每个转义成 \\n）', body: 'a\n'.repeat(350_000) }
];
const boundary = boundaryBodies.map(({ name, body }) => {
  const lines = envelopeLines(makeEnvelope({ id: 'msg_boundary', from: 'ses_a', to: 'ses_b', sentAt: 1, kind: 'note', body }));
  const sizes = lines.map(line => Buffer.byteLength(line, 'utf8'));
  const parsed = lines.map(line => parseEnvelopeLine(line));
  return { name, lines: lines.length, max: Math.max(...sizes), ok: parsed.every(Boolean) };
});
expect(
  'S5 编码后长度边界：引号 / CJK / 换行三种 1MB 附近正文，每行编码后仍 ≤1MB 且可解析',
  boundary.every(item => item.max <= 1024 * 1024 && item.ok && item.lines >= 1),
  boundary.map(item => `${item.name}: ${item.lines} 行 / max=${item.max}B`).join(' | ')
);

// --- B2 (review): a lazily created database must report itself available.
const b2Dir = join(root, 'b2');
mkdirSync(b2Dir, { recursive: true });
const b2Db = join(b2Dir, 'collab.db');
const b2Messages = join(b2Dir, 'collab-messages.jsonl');
fresh();
const b2Env = makeEnvelope({ id: 'msg_b2', from: 'ses_b2_a', to: 'ses_b2_b', sentAt: 1_700_000_000_500, kind: 'note', body: 'B2 新装第一条' });
await appendMessage(b2Env, { file: b2Messages });
const b2Inserted = await indexInsert(b2Env, { dbPath: b2Db, messagesFile: b2Messages });
const b2Stats = await indexStats({ dbPath: b2Db });
expect(
  'B2 全新空目录 → 写一条 → stats.available=true（meta.schema 由 openIndex 写入）',
  b2Stats.available === true && b2Stats.counts.messages === 1,
  `available=${b2Stats.available} messages=${b2Stats.counts.messages} reason=${b2Stats.reason ?? '-'}`
);
fresh();

// --- S2 (review): a failed truth write must not be followed by an index write.
const s2Dir = join(root, 's2');
mkdirSync(s2Dir, { recursive: true });
const s2Db = join(s2Dir, 'collab.db');
const s2NotAFile = join(s2Dir, 'a-directory');
mkdirSync(s2NotAFile, { recursive: true });
fresh();
await recordMessage(
  makeEnvelope({ id: 'msg_s2', from: 'ses_s2_a', to: 'ses_s2_b', sentAt: 1_700_000_000_900, kind: 'note', body: 'S2 真源失败' }),
  { dbPath: s2Db, messagesFile: s2NotAFile }
);
const s2DbExists = existsSync(s2Db);
if (s2DbExists) closeDb();
const s2Rows = s2DbExists
  ? Number((await openDb({ path: s2Db })).prepare('SELECT COUNT(*) AS n FROM messages').get().n)
  : 0;
if (s2DbExists) closeDb();
expect(
  'S2 真源（jsonl）写失败 → 提前返回，不写索引（库中 0 行 / 甚至不建库）',
  s2Rows === 0,
  `dbExists=${s2DbExists} rows=${s2Rows}`
);
fresh();

// ============================ 4) corrupt line tolerance
appendFileSync(messagesFile, '{"v":1,"id":"msg_torn"  \n');
const afterBadLine = await rebuildIndex({ dbPath, messagesFile, broadcasts: [], threads: {}, sinceDays: 0 });
expect(
  '坏行容错：rebuild 成功，计数 = 正常行数，warnCount=1',
  afterBadLine.ok && afterBadLine.counts.messages === 2 && afterBadLine.warnCount === 1,
  `messages=${afterBadLine.counts.messages} / warn=${afterBadLine.warnCount}`
);

// ============================ 5) degraded: corrupt database, JSON still works
fresh();
const corruptPath = join(root, 'corrupt.db');
writeFileSync(corruptPath, 'this is not a sqlite database at all');
const corruptStats = await indexStats({ dbPath: corruptPath });
const corruptStatus = await indexStatus({ dbPath: corruptPath, cacheMs: 0 });
const stillRead = readMessages({ file: messagesFile });
expect(
  '库损坏：stats / indexStatus 报不可用且不抛；JSON 读路径仍返回全部 2 条',
  corruptStats.available === false &&
    corruptStatus.available === false &&
    Boolean(corruptStats.reason) &&
    stillRead.messages.length === 2,
  `reason=${corruptStats.reason?.slice(0, 40)} / messages=${stillRead.messages.length}`
);

// ============================ 6) circuit breaker
fresh();
let execCalls = 0;
const badCtor = class {
  exec() {
    execCalls += 1;
    throw new Error('driver exploded');
  }
  prepare() {
    throw new Error('driver exploded');
  }
  close() {}
};
const firstOpen = await openDb({ path: join(root, 'broken.db'), loader: async () => badCtor });
const execAfterFirst = execCalls;
const brokenAfterFirst = Boolean(dbRuntimeState().broken);
const secondOpen = await openDb({ path: join(root, 'broken.db') });
expect(
  '熔断：第 1 次 exec 抛错（含 3 次重试）→ 第 2 次直接降级（null），不再碰驱动、不 import',
  firstOpen === null &&
    secondOpen === null &&
    brokenAfterFirst &&
    execAfterFirst > 0 &&
    execCalls === execAfterFirst &&
    dbRuntimeState().imported === false,
  `exec first=${execAfterFirst} / after second=${execCalls} / broken=${brokenAfterFirst} / imported=${dbRuntimeState().imported}`
);
fresh();

// ============================ 7) read path equivalence
const fromJson = readMessages({ file: messagesFile }).messages.map(message => ({
  id: message.id,
  body: message.body.length,
  at: message.sentAt
}));
const fromIndex = (await readMessagesFromIndex({ dbPath, limit: 100 })) ?? [];
const normalizedIndex = fromIndex
  .map(message => ({ id: message.id, body: message.body.length, at: message.sentAt }))
  .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
expect(
  '读路径等价：索引读回的 id / 正文字节 / sentAt 与 JSONL 完全一致',
  JSON.stringify(normalizedIndex) === JSON.stringify(fromJson) && fromIndex.length === 2,
  `${fromIndex.length} row(s)`
);

// --- R5 (review): the index path must return byte-identical rows, and it must
// be possible for this assertion to fail (a mutation that drops `priority` from
// the indexed record turns the urgent marker into nothing).
const eqNow = Date.now();
const eqBidUrgent = 'b_0000000000e90101';
const eqBidPlain = 'b_0000000000e90202';
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
writeJson(join(broadcastDir, `${eqBidUrgent}.json`), {
  bid: eqBidUrgent,
  scope: 'peer',
  state: 'open',
  from: { sid: 'ses_eq_a' },
  claim: { by: 'ses_eq_b', kind: 'spawn' },
  origin: { sid: 'ses_eq_origin' },
  title: '等价-紧急单',
  workspace: '/ws/eq',
  priority: 'urgent',
  threadID: 't_eq_urgent',
  createdAt: eqNow - 60_000,
  updatedAt: eqNow - 30_000
});
writeJson(join(broadcastDir, `${eqBidPlain}.json`), {
  bid: eqBidPlain,
  scope: 'peer',
  state: 'claimed',
  from: { sid: 'ses_eq_a' },
  claim: { by: 'ses_eq_c' },
  title: '等价-普通单',
  workspace: '/ws/eq',
  createdAt: eqNow - 120_000,
  updatedAt: eqNow - 90_000
});
mkdirSync(lockDir, { recursive: true });
const eqLock = {
  resource: 'named:eq-window',
  kind: 'named',
  mode: 'exclusive',
  holder: 'ses_eq_a',
  holders: ['ses_eq_a'],
  reason: '等价测试',
  acquiredAt: eqNow - 5_000,
  ttlMs: 900_000,
  expiresAt: eqNow + 895_000,
  waiters: [{ sid: 'ses_eq_b', at: eqNow - 1_000, mode: 'exclusive' }],
  history: []
};
writeJson(join(lockDir, 'eq-window.json'), eqLock);
const eqQueueTarget = 'ses_eq_protected';
const eqQueueId = 'q_0000000000_e9a';
mkdirSync(join(ownerQueueDir, eqQueueTarget), { recursive: true });
writeJson(join(ownerQueueDir, eqQueueTarget, `${eqQueueId}.json`), {
  id: eqQueueId,
  target: eqQueueTarget,
  from: 'ses_eq_a',
  at: eqNow - 2_000,
  summary: '等价队列项',
  issuePath: 'docs/issues/fix-eq.md',
  bid: eqBidUrgent,
  priority: 'urgent',
  revokedAt: null,
  seenAt: null
});
writeJson(threadIndexFile, {
  version: 1,
  entries: {
    t_eq_urgent: {
      target: eqQueueTarget,
      kind: 'handoff',
      from: 'ses_eq_a',
      lastAt: eqNow - 30_000,
      preview: '等价线程',
      bid: eqBidUrgent
    }
  }
});

// P1-1 (review): build with **rebuild only** — no `indexSync`, no delivery. The
// reader must hit the freshly built projection (the old test called `indexSync`
// first, which hid the missing `meta.schema` marker).
fresh();
const synced = await rebuildIndex({ dbPath, messagesFile, sinceDays: 0 });
const schemaAfterRebuild = await (async () => {
  const handle = await openDb({ path: dbPath });
  const row = handle.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
  closeDb();
  return row ? String(row.value) : undefined;
})();
const uniqueSorted = list =>
  [...list].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
const eqSessions = async () => [
  { id: 'ses_eq_a', agent: 'build', title: 'eq-a', location: { directory: '/ws/eq' }, time: { busy: 1 } },
  { id: 'ses_eq_b', agent: 'explore', title: 'eq-b', location: { directory: '/ws/eq' } },
  { id: 'ses_eq_c', agent: 'build', title: 'eq-c', location: { directory: '/ws/eq' } }
];
const jsonSource = {
  sessions: eqSessions,
  locks: () => allLocks(),
  handoffs: () => allBroadcasts(),
  queue: from => mineFor(from),
  freezes: () => []
};
// Mirrors `index.ts`: prefer the projection, fall back to the JSON readers.
const indexSource = {
  sessions: eqSessions,
  locks: async () => (await preferredLocks({ dbPath })) ?? allLocks(),
  handoffs: async () => (await preferredBroadcasts({ dbPath })) ?? allBroadcasts(),
  queue: async from => (await preferredQueue(from, { dbPath })) ?? mineFor(from),
  freezes: () => []
};
const eqSnapshot = input => buildSnapshot(input, { session: 'ses_eq_a' }, eqNow);
const fromJsonPath = await eqSnapshot(jsonSource);
const fromIndexPath = await eqSnapshot(indexSource);
const sameRows = (left, right) =>
  JSON.stringify({
    locks: uniqueSorted(left.locks),
    handoffs: uniqueSorted(left.handoffs),
    queue: uniqueSorted(left.queue)
  }) ===
  JSON.stringify({
    locks: uniqueSorted(right.locks),
    handoffs: uniqueSorted(right.handoffs),
    queue: uniqueSorted(right.queue)
  });
const indexAnswered = await preferredBroadcasts({ dbPath });
expect(
  'P1-1 只跑 rebuild（不 indexSync / 不投递）→ meta.schema=1，preferredBroadcasts 命中',
  synced.ok &&
    schemaAfterRebuild === '1' &&
    Array.isArray(indexAnswered) &&
    indexAnswered.some(record => record.bid === eqBidUrgent),
  `rebuild.ok=${synced.ok} schema=${schemaAfterRebuild ?? 'undefined'} handoffs=${indexAnswered?.length ?? 'undefined'}`
);
expect(
  'R5 等价：同一组输入下索引路径与 JSON 路径的 locks/handoffs/queue 逐字段相等（急单仍带 priority）',
  sameRows(fromJsonPath, fromIndexPath) &&
    fromIndexPath.handoffs.some(handoff => handoff.priority === 'urgent' && handoff.origin === 'ses_eq_origin') &&
    fromIndexPath.locks.length === 1 &&
    fromIndexPath.locks[0].waiting.length === 1 &&
    fromIndexPath.queue.length === 1,
  `locks=${fromIndexPath.locks.length} handoffs=${fromIndexPath.handoffs.length} queue=${fromIndexPath.queue.length}`
);
// A stale projection must not be served: touching one source makes the reader
// fall back to JSON (and the fallback is again byte-identical).
const touched = join(broadcastDir, `${eqBidPlain}.json`);
const future = new Date(Date.now() + 5_000);
utimesSync(touched, future, future);
const afterTouch = await eqSnapshot(indexSource);
const staleReader = await preferredBroadcasts({ dbPath });
expect(
  'R5 陈旧回退：源文件 mtime 超过 synced_at 后索引 reader 返回 undefined，快照仍与 JSON 路径一致',
  staleReader === undefined && sameRows(fromJsonPath, afterTouch),
  `staleReader=${staleReader === undefined ? 'undefined' : 'served'}`
);
// Put the fixture mtime back: a future mtime would also poison the *broadcasts*
// watermark used by the P1-3 / backfill cases below.
utimesSync(touched, new Date(), new Date());

// --- P1-2 (review): a read path must not create the database, and a mirror
// without a schema must stay silent. Run in a child with a fresh directory and
// capture stderr (the parent has a db open, so it cannot answer this).
const p12Dir = join(root, 'p12');
mkdirSync(p12Dir, { recursive: true });
const p12Code = `
const { readdirSync } = await import('node:fs');
const { pathToFileURL } = await import('node:url');
const built = await import(pathToFileURL(${JSON.stringify(dist)}).href);
const i = built.__internals;
const cold = [
  await i.preferredBroadcasts(),
  await i.preferredLocks(),
  await i.preferredQueue('ses_cold')
];
for (let n = 0; n < 3; n += 1) {
  i.writeBroadcast({
    bid: 'b_0000000000c01d0' + n,
    scope: 'peer',
    state: 'open',
    from: { sid: 'ses_cold' },
    title: 'cold ' + n,
    createdAt: Date.now()
  });
}
// let the deferred mirrors run and try (and silently skip) the write-through
await new Promise(resolve => setTimeout(resolve, 120));
console.log(JSON.stringify({
  reader: cold.map(value => (value === undefined ? 'undefined' : 'served')),
  dbFiles: readdirSync(process.env.P12_DIR).filter(name => name.startsWith('collab.db'))
}));
`;
const p12 = spawnSync(process.execPath, ['--input-type=module', '-e', p12Code], {
  env: {
    ...process.env,
    P12_DIR: p12Dir,
    COLLAB_DB_FILE: join(p12Dir, 'collab.db'),
    COLLAB_MESSAGES_FILE: join(p12Dir, 'collab-messages.jsonl'),
    COLLAB_CONTRACT_DIR: join(p12Dir, 'contract'),
    COLLAB_BROADCAST_DIR: p12Dir,
    COLLAB_LOCK_DIR: join(p12Dir, 'locks'),
    COLLAB_OWNER_QUEUE_DIR: join(p12Dir, 'owner-queue'),
    COLLAB_THREAD_INDEX_FILE: join(p12Dir, 'collab-threads.json'),
    COLLAB_CONFIG: join(p12Dir, 'collab.json'),
    COLLAB_PACING_FILE: join(p12Dir, 'collab-pacing.json')
  },
  encoding: 'utf8'
});
let p12Result = {};
try {
  p12Result = JSON.parse(String(p12.stdout ?? '').trim().split('\n').at(-1) ?? '{}');
} catch {
  p12Result = {};
}
const p12MirrorErrors = (String(p12.stderr ?? '').match(/index mirror failed/g) ?? []).length;
expect(
  'P1-2 冷启动只读 + 3 次写广播：不生成任何 collab.db*，且 0 条 mirror 错误日志',
  p12.status === 0 &&
    JSON.stringify(p12Result.reader) === JSON.stringify(['undefined', 'undefined', 'undefined']) &&
    Array.isArray(p12Result.dbFiles) &&
    p12Result.dbFiles.length === 0 &&
    p12MirrorErrors === 0,
  `exit=${p12.status} files=${JSON.stringify(p12Result.dbFiles)} mirrorErrors=${p12MirrorErrors}`
);

// --- P1-3 (review): per-source watermarks. Another process writes a lock; this
// process mirrors a hand-off. The lock reader must still fall back to JSON.
const p13Db = join(root, 'p13', 'collab.db');
mkdirSync(join(root, 'p13'), { recursive: true });
const p13 = await rebuildIndex({
  dbPath: p13Db,
  messagesFile,
  broadcasts: allBroadcasts(),
  locks: allLocks(),
  queue: [],
  threads: {},
  sinceDays: 0
});
const p13Before = await preferredLocks({ dbPath: p13Db });
const extraLock = {
  ...eqLock,
  resource: 'named:p13-other-process',
  holders: ['ses_other'],
  holder: 'ses_other',
  waiters: [],
  acquiredAt: eqNow,
  expiresAt: eqNow + 900_000
};
writeJson(join(lockDir, 'p13-other-process.json'), extraLock);
const p13AfterOtherLock = await preferredLocks({ dbPath: p13Db });
const p13Bid = 'b_0000000000p13bad'.replace(/[^0-9a-f]/g, 'b');
writeBroadcast({
  bid: p13Bid,
  scope: 'peer',
  state: 'open',
  from: { sid: 'ses_p13' },
  title: 'P1-3 无关注入',
  createdAt: Date.now()
});
flushMirrors();
const p13Broadcasts = await preferredBroadcasts({ dbPath: p13Db });
const p13LocksAfterMirror = await preferredLocks({ dbPath: p13Db });
expect(
  'P1-3 他人写 locks + 本进程 mirror 一条 handoff → lock 读者仍回落 JSON（不被无关水位带新）',
  p13.ok &&
    p13Before?.length === 1 &&
    p13AfterOtherLock === undefined &&
    Array.isArray(p13Broadcasts) &&
    p13Broadcasts.some(record => record.bid === p13Bid) &&
    p13LocksAfterMirror === undefined,
  `locks before=${p13Before?.length} afterOther=${p13AfterOtherLock === undefined ? 'undefined' : 'served'} ` +
    `broadcasts=${p13Broadcasts?.length} locksAfterMirror=${p13LocksAfterMirror === undefined ? 'undefined' : 'served'}`
);

// --- S9 (review): a mirror must not clear `frozen` stamped by a full sync.
const s9Db = join(root, 's9', 'collab.db');
mkdirSync(join(root, 's9'), { recursive: true });
const s9Bid = 'b_0000000000f9ee01';
const s9Record = {
  bid: s9Bid,
  scope: 'peer',
  state: 'open',
  from: { sid: 'ses_s9' },
  title: 'S9 冻结单',
  createdAt: eqNow - 1000,
  updatedAt: eqNow - 1000
};
await indexSync({
  dbPath: s9Db,
  sources: {
    broadcasts: [s9Record],
    locks: [],
    queue: [],
    threads: {},
    sessions: [],
    frozenBids: [s9Bid]
  }
});
await preferredBroadcasts({ dbPath: s9Db }); // caches the handle for the mirror
writeBroadcast({ ...s9Record, title: 'S9 冻结单（更新）', updatedAt: Date.now() });
flushMirrors();
const s9Handle = await openDb({ path: s9Db });
const s9Row = s9Handle.prepare('SELECT frozen, title, priority FROM handoffs WHERE bid = ?').get(s9Bid);
const s9RecordRow = s9Handle.prepare('SELECT record_json FROM handoffs WHERE bid = ?').get(s9Bid);
closeDb();
let s9Parsed = {};
try {
  s9Parsed = JSON.parse(String(s9RecordRow?.record_json ?? '{}'));
} catch {
  s9Parsed = {};
}
expect(
  'S9 全量 sync 标 frozen=1 后，mirror 更新该单不清零 frozen，且记录确实更新',
  Number(s9Row?.frozen) === 1 && /更新/.test(String(s9Row?.title)) && /更新/.test(String(s9Parsed.title)),
  `frozen=${s9Row?.frozen} title=${s9Row?.title}`
);

const statusNow = await indexStatus({ dbPath, cacheMs: 0 });
expect('indexStatus：正常库报 available', statusNow.available === true, JSON.stringify(statusNow));

// Cleanup the equivalence fixtures: §9 counts exactly 24 hand-offs / 49 threads.
rmSync(join(broadcastDir, `${eqBidUrgent}.json`), { force: true });
rmSync(join(broadcastDir, `${eqBidPlain}.json`), { force: true });
rmSync(join(lockDir, 'eq-window.json'), { force: true });
rmSync(join(lockDir, 'p13-other-process.json'), { force: true });
rmSync(join(broadcastDir, `${p13Bid}.json`), { force: true });
rmSync(join(broadcastDir, `${s9Bid}.json`), { force: true });
rmSync(join(ownerQueueDir, eqQueueTarget), { recursive: true, force: true });

// ============================ 8) concurrency: writers + concurrent rebuilds
// 8a (review): only one rebuild may hold the lock; a second is refused readably.
const lockDir8 = join(root, 'lock-unit');
mkdirSync(lockDir8, { recursive: true });
const lockPath8 = join(lockDir8, 'collab.db');
const held = acquireRebuildLock(lockPath8);
const blocked = acquireRebuildLock(lockPath8);
held.release();
const afterRelease = acquireRebuildLock(lockPath8);
afterRelease.release();
expect(
  '并发 8a：同一时刻只允许一个 rebuild（第二次可读拒绝；释放后可重新取得）',
  held.ok === true && blocked.ok === false && /rebuild/.test(String(blocked.reason)) && afterRelease.ok === true,
  `held=${held.ok} blocked=${blocked.ok} afterRelease=${afterRelease.ok}`
);

// 8b (review): a writer appends 40 messages while the parent rebuilds 6 times.
// Before the fix the writer held a handle to the renamed (unlinked) inode and
// 20 of the 40 rows silently vanished from the new database.
const raceDir = join(root, 'race');
mkdirSync(raceDir, { recursive: true });
const raceDb = join(raceDir, 'collab.db');
const raceMessages = join(raceDir, 'collab-messages.jsonl');
const childCode = `
const { pathToFileURL } = await import('node:url');
const built = await import(pathToFileURL(${JSON.stringify(dist)}).href);
const i = built.__internals;
const tag = process.env.RACE_TAG;
for (let n = 0; n < 40; n += 1) {
  const envelope = i.makeEnvelope({
    id: 'msg_race_' + n,
    from: 'ses_writer',
    to: 'ses_race',
    sentAt: 1700000000000 + n,
    kind: 'note',
    body: '并发写 #' + n
  });
  i.appendMessage(envelope, { file: process.env.RACE_MESSAGES });
  const ok = await i.indexInsert(envelope, { dbPath: process.env.RACE_DB });
  if (!ok) { console.error('insert failed for ' + envelope.id); process.exit(3); }
  await new Promise(resolve => setTimeout(resolve, 10));
}
`;
const writer = new Promise(resolveChild => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
    env: { ...process.env, RACE_TAG: 'w', RACE_DB: raceDb, RACE_MESSAGES: raceMessages },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => (stderr += chunk));
  child.on('close', code => resolveChild({ code, stderr }));
});
// Six rebuilds while the writer is running (they take turns via the lock).
const rebuildResults = [];
for (let n = 0; n < 6; n += 1) {
  rebuildResults.push(await rebuildIndex({ dbPath: raceDb, messagesFile: raceMessages, sinceDays: 0 }));
  await new Promise(resolve => setTimeout(resolve, 40));
}
const writerResult = await writer;
fresh();
const raceHandle = await openDb({ path: raceDb });
const raceRows = Number(raceHandle.prepare('SELECT COUNT(*) AS n FROM messages').get().n);
const raceDistinct = Number(raceHandle.prepare('SELECT COUNT(DISTINCT id) AS n FROM messages').get().n);
closeDb();
const raceLines = fileLines(raceMessages).length;
const raceRead = readMessages({ file: raceMessages });
expect(
  '并发 8b：子进程持续写 40 条 + 父进程并发 rebuild 6 次 → 库中 40 行 / 40 个 id、JSONL 40 行，零丢失',
  writerResult.code === 0 &&
    rebuildResults.every(result => result.ok) &&
    raceRows === 40 &&
    raceDistinct === 40 &&
    raceLines === 40 &&
    raceRead.messages.length === 40,
  `exit=${writerResult.code} rebuilds=${rebuildResults.filter(result => result.ok).length}/6 rows=${raceRows} lines=${raceLines}`
);
if (writerResult.code !== 0 || rebuildResults.some(result => !result.ok)) {
  console.log(`    writer stderr: ${writerResult.stderr.slice(-300)}`);
  for (const result of rebuildResults.filter(item => !item.ok)) console.log(`    rebuild: ${result.reason}`);
}

// ============================ 9) backfill: 24 hand-offs + 49 threads
fresh();
const handoffCount = 24;
const threadCount = 49;
for (let n = 0; n < handoffCount; n += 1) {
  const bid = `b_${String(n).padStart(16, '0')}`;
  writeFileSync(
    join(broadcastDir, `${bid}.json`),
    JSON.stringify({
      bid,
      scope: 'peer',
      state: n % 3 === 0 ? 'done' : 'open',
      from: { sid: `ses_hist_${n % 5}` },
      claim: { by: `ses_hist_${n % 7}`, kind: 'spawn' },
      title: `历史交接 ${n}`,
      threadID: `t_hist_${n}`,
      createdAt: 1_700_000_000_000 + n,
      updatedAt: 1_700_000_100_000 + n
    })
  );
}
const threadEntries = {};
for (let n = 0; n < threadCount; n += 1) {
  threadEntries[`t_hist_${n}`] = {
    target: `ses_hist_${n % 7}`,
    kind: n % 4 === 0 ? 'handoff' : 'messages',
    from: `ses_hist_${n % 5}`,
    lastAt: 1_700_000_000_000 + n,
    preview: `历史线程 ${n}`,
    ...(n % 4 === 0 ? { bid: `b_${String(n).padStart(16, '0')}` } : {})
  };
}
writeFileSync(threadIndexFile, JSON.stringify({ version: 1, entries: threadEntries }));
const backfilled = await backfillIndex({ dbPath });
const backfilledAgain = await backfillIndex({ dbPath });
const backfillHandle = await openDb({ path: dbPath });
const backfilledMeta = backfillHandle.prepare("SELECT key, value FROM meta WHERE key LIKE 'backfilled%'").all();
const fabricated = Number(
  backfillHandle.prepare("SELECT COUNT(*) AS n FROM messages WHERE id NOT IN ('msg_big','msg_small')").get().n
);
closeDb();
expect(
  '回填：handoffs=24、threads=49（重复回填幂等）',
  backfilled.ok &&
    backfilledAgain.ok &&
    backfilled.counts.handoffs === handoffCount &&
    backfilled.counts.threads === threadCount &&
    backfilledAgain.counts.handoffs === handoffCount &&
    backfilledAgain.counts.threads === threadCount,
  `handoffs=${backfilled.counts.handoffs} / threads=${backfilled.counts.threads}`
);
expect(
  '回填只补状态级历史：meta.backfilled=1，且没有伪造 messages 行',
  backfilledMeta.some(row => row.key === 'backfilled' && String(row.value) === '1') &&
    backfilledMeta.some(row => row.key === 'backfilled_at') &&
    fabricated === 0,
  `meta=${backfilledMeta.map(row => `${row.key}=${row.value}`).join(',')} / fabricated=${fabricated}`
);

// ============ 10) R1/R2 (0.9.7): rebuild recomputes metrics + coverage range
// The measured defect: `rebuild` dropped the whole `metrics` table
// (`metrics=1` → `metrics=0`). These assertions compare the **write path** rows
// (the same `pacingMetrics` + `upsertMetrics` the delivery path calls) with the
// rows a rebuild produces, day by day, and check the coverage line `stats` shows.
fresh();
const metricsDir = join(root, 'metrics');
mkdirSync(metricsDir, { recursive: true });
const metricsDb = join(metricsDir, 'collab.db');
const metricsMessages = join(metricsDir, 'collab-messages.jsonl');
const metricsPacing = join(metricsDir, 'collab-pacing.json');
const dayAt = (month, day) => new Date(2026, month - 1, day, 12, 0, 0).getTime();
const mDay1 = dayAt(1, 5);
const mDay2 = dayAt(1, 6);
const mDay3 = dayAt(1, 7);
const mDay = time => internals.dayKey(time);
const appendMetricsMessage = (id, sentAt) =>
  appendMessage(
    internals.makeEnvelope({ id, from: 'ses_m_a', to: 'ses_m_b', sentAt, kind: 'note', body: `metrics ${id}` }),
    { file: metricsMessages }
  );
// Day 1: 3 messages (gaps 10s / 30s → median 20s) + 2 resends (`_r1`/`_r2`).
appendMetricsMessage('msg_metrics_1', mDay1);
appendMetricsMessage('msg_metrics_1_r1', mDay1 + 15_000);
appendMetricsMessage('msg_metrics_2', mDay1 + 10_000);
appendMetricsMessage('msg_metrics_1_r2', mDay1 + 20_000);
appendMetricsMessage('msg_metrics_3', mDay1 + 40_000);
// Day 2: 2 messages, gap 5s. Day 3: 1 message, median 0.
appendMetricsMessage('msg_metrics_4', mDay2);
appendMetricsMessage('msg_metrics_5', mDay2 + 5_000);
appendMetricsMessage('msg_metrics_6', mDay3);
// 0.10.x (`11-22-collab-metrics-dual`): days 1–2 carry the three delivery
// counts (raw ≥ kept ≥ msg_count); day 3 has no counters at all → NULL.
const mCounters = {
  [mDay(mDay1)]: { noop: 5, late: 1, raw: 20, kept: 15 },
  [mDay(mDay2)]: { noop: 2, late: 0, raw: 9, kept: 7 }
};
writeJson(metricsPacing, {
  v: internals.PACING_VERSION,
  windows: [],
  counters: mCounters,
  lastSent: {},
  noops: {}
});
// Write-side rows: exactly what `refreshMetrics` persists (pacingMetrics →
// upsertMetrics). `counterOf` normalises a missing day to `{noop:0,late:0}` —
// the write path only ever writes *today*, where that zero is real. A rebuild
// cannot know that for an old day, so it writes NULL (F3); the comparison below
// therefore covers the days the pacing file still holds counters for.
for (const [day, time] of [
  [mDay(mDay1), mDay1],
  [mDay(mDay2), mDay2],
  [mDay(mDay3), mDay3]
]) {
  await internals.upsertMetrics(internals.pacingMetrics(day, mCounters[day] ?? { noop: 0, late: 0 }, { file: metricsMessages }), {
    dbPath: metricsDb
  });
}
const readMetricRows = async path => {
  const handle = await openDb({ path });
  // F3 (0.10.x): keep NULL distinguishable from 0 — `Number(null)` is 0 and
  // would have hidden the "counters expired" rows behind a fake zero.
  const num = value => (value === null || value === undefined ? null : Number(value));
  const rows = handle
    .prepare('SELECT day, msg_count, raw_count, kept_count, noop_count, late_count, median_gap_ms FROM metrics ORDER BY day')
    .all()
    .map(row => ({
      day: String(row.day),
      msg_count: num(row.msg_count),
      raw_count: num(row.raw_count),
      kept_count: num(row.kept_count),
      noop_count: num(row.noop_count),
      late_count: num(row.late_count),
      median_gap_ms: num(row.median_gap_ms)
    }));
  closeDb();
  return rows;
};
const writeSideRows = await readMetricRows(metricsDb);
fresh();
const mFirst = await rebuildIndex({
  dbPath: metricsDb,
  messagesFile: metricsMessages,
  pacingFile: metricsPacing,
  broadcasts: [],
  threads: {},
  sinceDays: 0
});
const rebuiltSideRows = await readMetricRows(metricsDb);
fresh();
const mSecond = await rebuildIndex({
  dbPath: metricsDb,
  messagesFile: metricsMessages,
  pacingFile: metricsPacing,
  broadcasts: [],
  threads: {},
  sinceDays: 0
});
expect(
  'R1 rebuild 重算 metrics：与写入侧（pacingMetrics + upsertMetrics）逐日、逐字段一致（有 counters 的两天）',
  mFirst.ok &&
    writeSideRows.length === 3 &&
    JSON.stringify(rebuiltSideRows.slice(0, 2)) === JSON.stringify(writeSideRows.slice(0, 2)),
  `${JSON.stringify(rebuiltSideRows)} vs ${JSON.stringify(writeSideRows)}`
);
expect(
  'F3 缺失的 pacing 计数写 NULL（不是 0）：01-07 无 counters 行 → noop/late/raw/kept 为 null',
  rebuiltSideRows[2]?.day === mDay(mDay3) &&
    rebuiltSideRows[2]?.noop_count === null &&
    rebuiltSideRows[2]?.late_count === null &&
    rebuiltSideRows[2]?.raw_count === null &&
    rebuiltSideRows[2]?.kept_count === null &&
    writeSideRows[2]?.noop_count === 0,
  JSON.stringify({
    rebuilt: rebuiltSideRows[2] ?? null,
    writeSide: writeSideRows[2] ?? null
  })
);
expect(
  'R1 重发行（_r1/_r2）不计入 msg_count，median_gap_ms 用同一函数（20s / 5s / 0）',
  rebuiltSideRows[0]?.msg_count === 3 &&
    rebuiltSideRows[0]?.median_gap_ms === 20_000 &&
    rebuiltSideRows[1]?.msg_count === 2 &&
    rebuiltSideRows[1]?.median_gap_ms === 5_000 &&
    rebuiltSideRows[2]?.msg_count === 1 &&
    rebuiltSideRows[2]?.median_gap_ms === 0,
  JSON.stringify(rebuiltSideRows)
);
expect(
  'R1 noop_count / late_count / raw_count / kept_count 来自 collab-pacing.json 的 counters[day]（有计数时逐字一致）',
  rebuiltSideRows[0]?.noop_count === 5 &&
    rebuiltSideRows[0]?.late_count === 1 &&
    rebuiltSideRows[0]?.raw_count === 20 &&
    rebuiltSideRows[0]?.kept_count === 15 &&
    rebuiltSideRows[1]?.noop_count === 2 &&
    rebuiltSideRows[1]?.late_count === 0 &&
    rebuiltSideRows[1]?.raw_count === 9 &&
    rebuiltSideRows[1]?.kept_count === 7,
  JSON.stringify(rebuiltSideRows.map(row => `${row.day}:${row.noop_count}/${row.late_count}/${row.raw_count}/${row.kept_count}`))
);
expect(
  'R1 幂等：两次 rebuild 的 metrics checksum（以及整表 checksum）相同',
  mFirst.ok &&
    mSecond.ok &&
    // F5 (0.10.x): pin the shape first — `undefined === undefined` used to pass.
    typeof mFirst.checksums?.metrics === 'string' &&
    typeof mSecond.checksums?.metrics === 'string' &&
    mFirst.checksums?.metrics === mSecond.checksums?.metrics &&
    JSON.stringify(mFirst.checksums) === JSON.stringify(mSecond.checksums),
  `metrics=${mFirst.checksums?.metrics} / ${mSecond.checksums?.metrics}`
);
const metricsStats = await indexStats({ dbPath: metricsDb });
expect(
  'R2 indexStats 返回 metrics 覆盖范围（首日–末日 + 天数）',
  metricsStats.available &&
    metricsStats.metricsRange?.first === mDay(mDay1) &&
    metricsStats.metricsRange?.last === mDay(mDay3) &&
    metricsStats.metricsRange?.days === 3,
  JSON.stringify(metricsStats.metricsRange ?? null)
);
// The tool line is what an operator reads — assert the rendered text, not just
// the field (mutation: `stats` stops printing the range → this must go red).
await new Promise(resolve => setTimeout(resolve, 1100));
writeJson(configFile, { storage: 'sqlite', dbPath: metricsDb });
const coverageStats = await runIndexTool({ action: 'stats' });
expect(
  'R2 `collab_index stats` 输出「metrics 覆盖 <首日>–<末日>（N 天）」',
  coverageStats.content.includes(`metrics 覆盖 ${mDay(mDay1)}–${mDay(mDay3)}（3 天）`),
  coverageStats.content.split('\n').find(line => line.includes('metrics 覆盖')) ?? '-'
);
// sinceDays bounds the recompute too: 3 days before 2026-01-09 = from 01-06 00:00.
// F1/F2 (review): first prove the *other* end — `sinceDays:0` keeps a message a
// year older than the default window, and `messages` / `metrics` always share
// one window (a rebuild must never leave rows `metrics` does not cover).
appendMetricsMessage('msg_metrics_old', new Date(2025, 0, 5, 12, 0, 0).getTime());
/** The metric units of a database: non-resend rows, grouped by local day. */
const metricSpanOf = async path => {
  const handle = await openDb({ path });
  const rows = handle.prepare('SELECT id, sent_at FROM messages').all();
  const metricDays = handle.prepare('SELECT day FROM metrics ORDER BY day').all().map(row => String(row.day));
  closeDb();
  const units = rows.filter(row => !internals.isResendID(String(row.id)));
  const days = units.map(row => internals.dayKey(Number(row.sent_at))).sort();
  return { rows: rows.length, units: units.length, first: days[0], last: days.at(-1), metricDays };
};
const spansAgree = async path => {
  const span = await metricSpanOf(path);
  return span.units === 0
    ? span.metricDays.length === 0
    : JSON.stringify([span.first, span.last, span.metricDays.length]) ===
        JSON.stringify([span.metricDays[0], span.metricDays.at(-1), span.metricDays.length]);
};
fresh();
const mAll = await rebuildIndex({
  dbPath: metricsDb,
  messagesFile: metricsMessages,
  pacingFile: metricsPacing,
  broadcasts: [],
  threads: {},
  sinceDays: 0
});
const allRows = await readMetricRows(metricsDb);
const allSpan = await metricSpanOf(metricsDb);
expect(
  'F1 sinceDays:0 = 不按时间过滤：1 年前的消息也进库，metrics 覆盖 4 天（首日 2025-01-05）',
  mAll.ok &&
    allSpan.rows === 9 &&
    allSpan.units === 7 &&
    allRows.length === 4 &&
    allRows[0]?.day === mDay(new Date(2025, 0, 5, 12, 0, 0).getTime()) &&
    allRows.at(-1)?.day === mDay(mDay3),
  `messages=${allSpan.rows}(units ${allSpan.units}) days=${allRows.map(row => row.day).join(',')}`
);
expect(
  'F2 sinceDays:0：messages 的日期跨度与 metrics 覆盖范围一致（含 2025 年那一天）',
  await spansAgree(metricsDb),
  JSON.stringify(await metricSpanOf(metricsDb))
);
fresh();
const mWindowed = await rebuildIndex({
  dbPath: metricsDb,
  messagesFile: metricsMessages,
  pacingFile: metricsPacing,
  broadcasts: [],
  threads: {},
  sinceDays: 3,
  now: new Date(2026, 0, 9, 0, 0, 0).getTime()
});
const windowedRows = await readMetricRows(metricsDb);
const windowedSpan = await metricSpanOf(metricsDb);
expect(
  'R1 sinceDays 限定重算范围：窗口外的那一天不重算、也不伪造（首日 = 01-06）',
  mWindowed.ok &&
    windowedRows.length === 2 &&
    windowedRows[0]?.day === mDay(mDay2) &&
    windowedRows[1]?.day === mDay(mDay3),
  JSON.stringify(windowedRows.map(row => row.day))
);
expect(
  'F2 sinceDays:3：messages 也只剩窗口内 3 行（1 年前与 01-05 都不再插入），跨度与 metrics 覆盖一致',
  windowedSpan.rows === 3 &&
    windowedSpan.units === 3 &&
    windowedSpan.first === mDay(mDay2) &&
    windowedSpan.last === mDay(mDay3) &&
    (await spansAgree(metricsDb)),
  JSON.stringify(windowedSpan)
);
// And a database with no metrics row says 「无」 instead of inventing a range.
await new Promise(resolve => setTimeout(resolve, 1100));
writeJson(configFile, { storage: 'sqlite', dbPath: b2Db });
const emptyCoverage = await runIndexTool({ action: 'stats' });
expect(
  'R2 无数据时 `stats` 输出「metrics 覆盖 无」（不伪造范围）',
  /metrics 覆盖 无/.test(emptyCoverage.content),
  emptyCoverage.content.split('\n').find(line => line.includes('metrics 覆盖')) ?? '-'
);
// F1 (review): the tool layer used to drop `sinceDays:0` (only `> 0` was
// forwarded), so the documented "0 = 不按时间过滤" silently rebuilt 180 days.
// The shared log here is two messages from 2023 — far outside the default
// window — so the two rebuilds are distinguishable by row count alone.
const windowDb = join(metricsDir, 'window.db');
await new Promise(resolve => setTimeout(resolve, 1100));
writeJson(configFile, { storage: 'sqlite', dbPath: windowDb });
const previewDefault = await runIndexTool({ action: 'rebuild' });
const previewAll = await runIndexTool({ action: 'rebuild', sinceDays: 0 });
expect(
  'F1 预览文案跟随窗口：默认写「保留最近 180 天」，sinceDays:0 写「不按时间过滤」',
  /保留最近 180 天/.test(previewDefault.content) && /不按时间过滤/.test(previewAll.content),
  `default=${previewDefault.content.split('\n').find(line => line.startsWith('来源'))} / 0=${previewAll.content
    .split('\n')
    .find(line => line.startsWith('来源'))}`
);
const rebuildDefault = await runIndexTool({ action: 'rebuild', confirm: true });
const rebuildAll = await runIndexTool({ action: 'rebuild', sinceDays: 0, confirm: true });
const windowAllStats = await runIndexTool({ action: 'stats' });
const oldDay = internals.dayKey(1_700_000_000_001);
expect(
  'F1 `collab_index {sinceDays:0, confirm:true}` 真的下传到核心：默认窗口 messages=0，0 时 messages=2',
  /messages=0/.test(rebuildDefault.content) &&
    /messages=2/.test(rebuildAll.content) &&
    windowAllStats.content.includes(`metrics 覆盖 ${oldDay}–${oldDay}（1 天）`),
  `default=${rebuildDefault.content.split('\n').find(line => line.startsWith('行数'))} / 0=${rebuildAll.content
    .split('\n')
    .find(line => line.startsWith('行数'))} / ${windowAllStats.content
    .split('\n')
    .find(line => line.includes('metrics 覆盖'))}`
);
writeJson(configFile, { storage: 'sqlite' });

// ========== 10b) F3 / F4 (0.10.x): expired counters are NULL, resend-only days stay
// F3: pacing keeps `PACING_COUNTER_KEEP_DAYS` (30) days of counters while a
// rebuild covers `REBUILD_SINCE_DAYS` (180). A 100-day-old day with no counters
// used to be written as `noop 0 / late 0` — "nobody was suppressed that day",
// which the data cannot say. It must be NULL, and `collab_index metrics` must
// print `-`.
// F4: a day whose only rows are `_r<n>` resends produced a `msg_count=0` row on
// the write path; the rebuild grouped on resend-excluded rows, so that day had
// no key and the row vanished. Both writers must produce a row for every day
// the log has *any* message on.
{
  fresh();
  const nitsDir = join(root, 'metrics-nits');
  mkdirSync(nitsDir, { recursive: true });
  const nitsDb = join(nitsDir, 'collab.db');
  const nitsMessages = join(nitsDir, 'collab-messages.jsonl');
  const nitsPacing = join(nitsDir, 'collab-pacing.json');
  const nitsNow = dayAt(6, 1); // injected "today": 2026-06-01 12:00 local
  const oldDayTime = nitsNow - 100 * 24 * 3600_000; // inside 180d, outside 30d counters
  const resendDayTime = nitsNow - 2 * 24 * 3600_000; // only a `_r1` row
  const recentDayTime = nitsNow - 24 * 3600_000; // has counters
  const appendNits = (id, sentAt) =>
    appendMessage(
      internals.makeEnvelope({ id, from: 'ses_nits_a', to: 'ses_nits_b', sentAt, kind: 'note', body: `nits ${id}` }),
      { file: nitsMessages }
    );
  appendNits('msg_nits_old', oldDayTime);
  appendNits('msg_nits_recent', recentDayTime);
  appendNits('msg_nits_resendonly_r1', resendDayTime);
  writeJson(nitsPacing, {
    v: internals.PACING_VERSION,
    windows: [],
    counters: { [mDay(recentDayTime)]: { noop: 3, late: 2 } },
    lastSent: {},
    noops: {}
  });
  // Baseline (the write path): a resend-only day is a real `msg_count: 0` row.
  const resendDayWriteSide = internals.pacingMetrics(mDay(resendDayTime), { noop: 0, late: 0 }, { file: nitsMessages });
  expect(
    'F4 对照基准：写入侧（pacingMetrics）对「只有 _r1」的一天产出 msg_count=0 的行',
    resendDayWriteSide.msg_count === 0 && resendDayWriteSide.day === mDay(resendDayTime),
    JSON.stringify(resendDayWriteSide)
  );
  const nitsRebuilt = await rebuildIndex({
    dbPath: nitsDb,
    messagesFile: nitsMessages,
    pacingFile: nitsPacing,
    broadcasts: [],
    threads: {},
    sinceDays: 180,
    now: nitsNow
  });
  const nitsRows = await readMetricRows(nitsDb);
  const rowOfDay = day => nitsRows.find(row => row.day === day);
  const oldRow = rowOfDay(mDay(oldDayTime));
  const recentRow = rowOfDay(mDay(recentDayTime));
  const resendRow = rowOfDay(mDay(resendDayTime));
  expect(
    'F3 100 天前的一天（counters 已过期）→ rebuild 写 NULL，不是 0',
    nitsRebuilt.ok &&
      oldRow?.msg_count === 1 &&
      oldRow?.noop_count === null &&
      oldRow?.late_count === null,
    JSON.stringify(oldRow ?? null)
  );
  expect(
    'F3 当天仍有 counters 的行保持真实数值（NULL 只用于缺失的计数）',
    recentRow?.noop_count === 3 && recentRow?.late_count === 2,
    JSON.stringify(recentRow ?? null)
  );
  expect(
    'F4 只有 `_r1` 的一天在 rebuild 后仍有行，且 msg_count=0（与写入侧同口径）',
    Boolean(resendRow) && resendRow.msg_count === 0 && resendRow.median_gap_ms === 0,
    JSON.stringify(resendRow ?? null)
  );
  // The rendered view: NULL prints `-`; the real counters keep their numbers.
  await new Promise(resolve => setTimeout(resolve, 1100));
  writeJson(configFile, { storage: 'sqlite', dbPath: nitsDb });
  const nitsListed = await runIndexTool({ action: 'metrics' });
  const lineOfDay = day =>
    nitsListed.content.split('\n').find(line => line.startsWith(`${day} · raw `)) ?? '';
  expect(
    'F3 `collab_index metrics` 对过期计数显示 `-`（当天行仍是真实值）',
    lineOfDay(mDay(oldDayTime)).includes('noop - · late -') &&
      lineOfDay(mDay(oldDayTime)).includes('raw - · kept -') &&
      lineOfDay(mDay(recentDayTime)).includes('noop 3 · late 2') &&
      lineOfDay(mDay(recentDayTime)).includes('raw - · kept -'),
    `${lineOfDay(mDay(oldDayTime))} | ${lineOfDay(mDay(recentDayTime))}`
  );
  expect(
    'F3 `collab_index metrics` 说明 `-` 的语义（NULL = 计数已过期，不是 0）',
    nitsListed.content.includes('计数已过期'),
    nitsListed.content.split('\n').find(line => line.includes('计数已过期')) ?? '-'
  );
  const nitsStats = await runIndexTool({ action: 'stats' });
  expect(
    'F3 `collab_index stats` 写明 NULL 语义（30 天 counters vs 180 天窗口）',
    nitsStats.content.includes('NULL = 该日 pacing 计数已过期'),
    nitsStats.content.split('\n').find(line => line.includes('NULL')) ?? '-'
  );
  writeJson(configFile, { storage: 'sqlite' });
}

// ========== 11) R1/R2/R5 (0.9.7, `11-21-collab-index-metrics`): `metrics` 动作
// The daily rows were only reachable by opening `collab.db` directly (which the
// repo rules require per-query authorization for, even read-only). `metrics`
// exposes the same numbers read-only: newest day first, straight from the table
// (no second calculation), `limit` bounds the printed rows only.
fresh();
const readDir = join(root, 'metrics-read');
mkdirSync(readDir, { recursive: true });
const readDb = join(readDir, 'collab.db');
const readMessagesFile = join(readDir, 'collab-messages.jsonl');
const readPacing = join(readDir, 'collab-pacing.json');
const rDay1 = dayAt(2, 3);
const rDay2 = dayAt(2, 4);
const rDay3 = dayAt(2, 5);
const appendReadMessage = (id, sentAt) =>
  appendMessage(
    internals.makeEnvelope({ id, from: 'ses_r_a', to: 'ses_r_b', sentAt, kind: 'note', body: `read ${id}` }),
    { file: readMessagesFile }
  );
// Day 1: 3 messages (resend `_r1` excluded) → gaps 10s / 30s, median 20s.
appendReadMessage('msg_read_1', rDay1);
appendReadMessage('msg_read_1_r1', rDay1 + 1_000);
appendReadMessage('msg_read_2', rDay1 + 10_000);
appendReadMessage('msg_read_3', rDay1 + 40_000);
// Day 2: 2 messages, gap 5s. Day 3: 1 message, median 0.
appendReadMessage('msg_read_4', rDay2);
appendReadMessage('msg_read_5', rDay2 + 5_000);
appendReadMessage('msg_read_6', rDay3);
writeJson(readPacing, {
  v: internals.PACING_VERSION,
  windows: [],
  counters: { [mDay(rDay1)]: { noop: 5, late: 1 }, [mDay(rDay2)]: { noop: 2, late: 0 } },
  lastSent: {},
  noops: {}
});
fresh();
const readRebuild = await rebuildIndex({
  dbPath: readDb,
  messagesFile: readMessagesFile,
  pacingFile: readPacing,
  broadcasts: [],
  threads: {},
  sinceDays: 0
});
await new Promise(resolve => setTimeout(resolve, 1100));
writeJson(configFile, { storage: 'sqlite', dbPath: readDb });
/** The rendered daily rows, in output order (`day · raw … · gap …`). */
const metricLinesOf = content => content.split('\n').filter(line => /^\d{4}-\d{2}-\d{2} · raw /.test(line));
const readBefore = statSync(readDb);
const listed = await runIndexTool({ action: 'metrics' });
const readAfter = statSync(readDb);
// readPacing above has no raw/kept (a day recorded before those counters
// existed) → they must print `-`, exactly like an expired counter.
const expectedMetricLines = [
  `${mDay(rDay3)} · raw - · kept - · msg 1 · noop - · late - · gap 0ms`,
  `${mDay(rDay2)} · raw - · kept - · msg 2 · noop 2 · late 0 · gap 5000ms`,
  `${mDay(rDay1)} · raw - · kept - · msg 3 · noop 5 · late 1 · gap 20000ms`
];
expect(
  'R1 `metrics` 按日期倒序输出 3 天，数值与 rebuild 写入的 `metrics` 表逐字一致',
  readRebuild.ok && JSON.stringify(metricLinesOf(listed.content)) === JSON.stringify(expectedMetricLines),
  JSON.stringify(metricLinesOf(listed.content))
);
expect(
  'R1 末尾给出覆盖范围与总天数（整表口径）',
  listed.content.includes(`覆盖 ${mDay(rDay1)}–${mDay(rDay3)}（3 天）`),
  listed.content.split('\n').find(line => line.startsWith('覆盖')) ?? '-'
);
// R2 mutation target: sorting the SQL by `day` ASC flips this array → red.
const limited = await runIndexTool({ action: 'metrics', limit: 2 });
const limitedLines = metricLinesOf(limited.content);
expect(
  'R1 `limit:2` 只输出最近 2 天，覆盖范围仍报整表 3 天',
  JSON.stringify(limitedLines) === JSON.stringify(expectedMetricLines.slice(0, 2)) &&
    limited.content.includes(`覆盖 ${mDay(rDay1)}–${mDay(rDay3)}（3 天）`) &&
    limited.content.includes('仅显示最近 2 天'),
  JSON.stringify(limitedLines)
);
expect(
  'R2 只读：调用前后 `collab.db` 的 size / mtime 不变',
  readBefore.size === readAfter.size && readBefore.mtimeMs === readAfter.mtimeMs,
  `${readBefore.size}B@${readBefore.mtimeMs} → ${readAfter.size}B@${readAfter.mtimeMs}`
);
// R5: a NULL column is "never written", not zero — print `-` (never invent).
const nullHandle = await openDb({ path: readDb });
nullHandle.prepare("INSERT INTO metrics (day) VALUES ('2030-01-01')").run();
closeDb();
const withNull = await runIndexTool({ action: 'metrics' });
expect(
  'R5 NULL 字段显示 `-`（不把「没写过」变成 0）',
  metricLinesOf(withNull.content)[0] === '2030-01-01 · raw - · kept - · msg - · noop - · late - · gap -',
  metricLinesOf(withNull.content)[0] ?? '-'
);
// R3: an existing projection with no `metrics` row is empty, not an error.
await new Promise(resolve => setTimeout(resolve, 1100));
writeJson(configFile, { storage: 'sqlite', dbPath: b2Db });
const emptyMetrics = await runIndexTool({ action: 'metrics' });
expect(
  'R3 空库：输出「metrics 无数据」且不报错（无日期行）',
  /metrics 无数据/.test(emptyMetrics.content) && metricLinesOf(emptyMetrics.content).length === 0,
  emptyMetrics.content.split('\n')[0] ?? '-'
);
// R2: a cold start must not create the database (no `collab.db*` at all).
const coldDir = join(root, 'metrics-cold');
mkdirSync(coldDir, { recursive: true });
const coldDb = join(coldDir, 'collab.db');
await new Promise(resolve => setTimeout(resolve, 1100));
writeJson(configFile, { storage: 'sqlite', dbPath: coldDb });
const coldMetrics = await runIndexTool({ action: 'metrics' });
const coldFiles = readdirSync(coldDir).filter(name => name.startsWith('collab.db'));
expect(
  'R2 冷启动（无库）：报 [索引不可用]，且目录里不产生 collab.db / -wal / -shm',
  /\[索引不可用\]/.test(coldMetrics.content) && coldFiles.length === 0,
  `files=${coldFiles.join(',') || '(none)'}`
);

// ============================ cleanup + summary
rmSync(root, { recursive: true, force: true });
if (typeof dispose === 'function') await dispose();

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAIL: ${check.title}`);
  process.exit(1);
}
process.exit(0);
