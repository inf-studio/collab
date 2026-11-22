/**
 * 0.10.x (`11-22-collab-metrics-dual`): the three delivery counts
 * `raw ≥ kept ≥ msg_count`, on the write side and through `rebuild`.
 *
 *   pnpm test                       # builds dist/ first; this file is in the chain
 *   node test/metrics-dual.mjs
 *
 * The measured problem this suite pins: `metrics.msg_count` only counted what
 * was **delivered** (after batching + suppression), while the 11-19 baseline of
 * 624 messages was the **raw** send volume. Two numbers, two definitions — the
 * "96% drop" was partly a unit change. The three counts must make the pipeline
 * readable end to end:
 *
 *   raw  every message that reached the delivery decision (suppressed included)
 *   kept were not suppressed (before the window merge)
 *   msg  were actually delivered (a batch is one message)
 *
 * Cases:
 *   1. 10 dispatch / 2 suppressed / 8 kept / 3 delivered (3 targets × one
 *      window) → `raw=10, kept=8, msg_count=3`, with `raw = kept + noop`;
 *   2. a second, direct-path scenario keeps `raw ≥ kept ≥ msg_count`;
 *   3. `rebuild` recomputes the same numbers as the write side (`pacingMetrics`
 *      + `upsertMetrics`), day by day, and two rebuilds share one checksum;
 *   4. old data (counters without `raw` / `kept`) → columns NULL, the tool
 *      prints `-` (never a fabricated 0);
 *   5. the rendered line and the tool surface (still 29 tools);
 *   6. **full coverage** (0.10.x): every direct delivery — 5×`escalate`, the
 *      freeze notice, the defect report, the bounded resend, `notifyRequester`
 *      and the `[ack]` loop — moves `raw` + `kept` by exactly one (the measured
 *      defect was `msg=5, raw=1`); `deliverAsk` (broadcast spawn) counts once and
 *      an idempotent repeat counts zero; a **refused direct prompt** moves
 *      neither (`Δraw=Δkept=0`); a rebuild after them still agrees;
 *   7. the **upgrade day** shape: counters written before `raw` / `kept` existed
 *      → NULL, then a partial `raw=1` against a full-day `msg_count` — legal and
 *      visibly different from a full-coverage day; an explicit `raw:null` never
 *      becomes `0`.
 *
 * Exits 1 if any check fails.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
const root = mkdtempSync(join(base, 'collab-metrics-dual-'));
const workspace = join(root, 'workspace');
const contractDir = join(root, 'contract');
mkdirSync(workspace, { recursive: true });
mkdirSync(contractDir, { recursive: true });

/** The operator's real files must not move (this machine runs the plugin). */
const realDir = join(homedir(), '.config', 'opencode');
const realPacingPath = join(realDir, 'collab-pacing.json');
const snapshotOf = path => {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'absent';
  }
};
const realPacingBefore = snapshotOf(realPacingPath);

// Every global path is read once at import: pin them *before* importing.
const messagesFile = join(root, 'collab-messages.jsonl');
process.env.COLLAB_CONTRACT_DIR = contractDir;
process.env.COLLAB_FACTS_FILE = join(root, 'collab-facts.json');
process.env.COLLAB_GLOSSARY_FILE = join(root, 'collab-glossary.json');
process.env.COLLAB_MESSAGES_FILE = messagesFile;
process.env.COLLAB_DB_FILE = join(root, 'collab.db');
process.env.COLLAB_BROADCAST_DIR = join(root, 'broadcast');
process.env.COLLAB_THREAD_INDEX_FILE = join(root, 'collab-threads.json');
process.env.COLLAB_CONFIG = join(root, 'collab.json');
process.env.COLLAB_LOCK_DIR = join(root, 'locks');
process.env.COLLAB_OWNER_QUEUE_DIR = join(root, 'owner-queue');
process.env.COLLAB_FREEZE_FILE = join(root, 'freeze.json');
process.env.COLLAB_AUDIT_FILE = join(root, 'collab-audit.jsonl');
process.env.COLLAB_GRANT_DIR = join(root, 'grants');
process.env.COLLAB_REPORT_DIR = join(root, 'reports');
process.env.COLLAB_PACING_FILE = join(root, 'collab-pacing.json');
process.env.COLLAB_DECISIONS_DIR = join(root, 'decisions');
for (const dir of ['broadcast', 'locks', 'owner-queue', 'grants', 'reports', 'decisions']) mkdirSync(join(root, dir), { recursive: true });

const configPath = process.env.COLLAB_CONFIG;
const dbPath = join(root, 'collab.db');
const WINDOW_MS = 120_000;
const writeConfig = extra =>
  writeFileSync(configPath, JSON.stringify({ windowMs: WINDOW_MS, suppressNoDelta: true, dbPath, storage: 'sqlite', ...extra }, null, 2));
writeConfig({});

const dist = resolve(import.meta.dirname, '../dist/index.js');
const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'));
const plugin = (await import(pathToFileURL(dist).href)).default;
const internals = (await import(pathToFileURL(dist).href)).__internals;

const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};
const section = title => console.log(`\n--- ${title}`);
const settle = (ms = 10) => new Promise(done => setTimeout(done, ms));

// ---------------------------------------------------------------- fake host
const store = new Map();
const tools = [];
const hooks = {};
const prompts = [];
const sessions = new Map(
  ['ses_a', 'ses_b', 'ses_c', 'ses_d', 'ses_e', 'ses_f', 'ses_fail'].map(id => [
    id,
    { id, agent: 'build', title: `metrics ${id}` }
  ])
);
/** Sessions whose host refuses the prompt (the failed-delivery case). */
const failPrompts = new Set();
const ctx = {
  location: { directory: workspace },
  options: {},
  storage: {
    async get(key) {
      const value = store.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async set(key, value) {
      store.set(key, structuredClone(value));
    },
    async remove(key) {
      store.delete(key);
    }
  },
  tool: {
    async transform(callback) {
      callback({ add: definition => tools.push(definition) });
      return { dispose: async () => {} };
    }
  },
  session: {
    async hook(name, callback) {
      hooks[name] = callback;
      return { dispose: async () => {} };
    },
    async get({ sessionID }) {
      const info = sessions.get(sessionID);
      if (!info) throw new Error(`no session ${sessionID}`);
      return structuredClone(info);
    },
    async list() {
      return { data: [...sessions.values()] };
    },
    async context() {
      return [];
    },
    async create(input = {}) {
      const info = {
        id: `ses_spawn_${sessions.size + 1}`,
        agent: input.agent ?? 'explore',
        title: input.title ?? '',
        ...(input.location ? { location: input.location } : {})
      };
      sessions.set(info.id, info);
      return structuredClone(info);
    },
    async remove() {},
    async update() {},
    async switchAgent() {},
    async prompt(input) {
      if (failPrompts.has(String(input.sessionID))) throw new Error(`模拟宿主拒绝投递（${input.sessionID}）`);
      prompts.push(structuredClone(input));
      return { id: `msg_${prompts.length}`, delivery: input.delivery };
    },
    async wait() {}
  },
  event: {
    async *subscribe() {
      // no events in this suite
    }
  }
};

const originalError = console.error;
console.error = () => {};
await plugin.setup(ctx);
console.error = originalError;

const tool = name => tools.find(definition => definition.name === name);
const call = async (name, input, sid = 'ses_a') =>
  (await tool(name).execute(input, { sessionID: sid, agent: 'build' })).content;
const counters = () => internals.pacingCounters();
const messageLog = () => internals.readMessages().messages;
const readDayCounters = () => internals.readPacing().counters;
const update = async mutate => {
  await internals.updatePacing(mutate);
  await settle(5);
};

/** The `metrics` row values, straight from the database (NULL stays null). */
const readMetricRow = async (path, day) => {
  const handle = await internals.openDb({ path });
  const num = value => (value === null || value === undefined ? null : Number(value));
  const row = handle.prepare('SELECT * FROM metrics WHERE day = ?').get(day);
  internals.closeDb();
  if (!row) return undefined;
  return {
    day: String(row.day),
    msg_count: num(row.msg_count),
    raw_count: num(row.raw_count),
    kept_count: num(row.kept_count),
    noop_count: num(row.noop_count),
    late_count: num(row.late_count),
    median_gap_ms: num(row.median_gap_ms)
  };
};

// ------------------------------------------------------------- 0) surface
section('0) surface and a clean baseline');
expect('the tool surface is still 29 (no new tool)', tools.length === 29, `${tools.length}`);
expect('the plugin version agrees with package.json', internals.PLUGIN_VERSION === pkg.version, pkg.version);
await update(state => {
  state.counters = {};
  state.windows = [];
  state.lastSent = {};
  state.noops = {};
});
internals.clearFlushTimers();
expect('a pruned counters file has no raw / kept yet', counters().raw === undefined && counters().kept === undefined, JSON.stringify(counters()));
const day = internals.dayKey();

// ------------------------------------------ 1) 10 / 2 / 8 / 3 (the PRD case)
section('1) 10 dispatch · 2 suppressed · 8 kept · 3 delivered');
const before1 = messageLog().length;
// Two status mirrors: the no-increment gate suppresses both (nothing new).
const mirrorB = await call('collab_send', { target: 'ses_b', kind: 'note', text: '状态同上，没有新增内容', confirm: true });
const mirrorC = await call('collab_send', { target: 'ses_c', kind: 'note', text: '同上，仍在跑', confirm: true });
expect('both mirrors are withheld (未发送（无增量）)', mirrorB.startsWith('未发送（无增量）') && mirrorC.startsWith('未发送（无增量）'), mirrorB.split('\n')[0]);
// Eight increments across three targets → three windows → three messages.
const plan = { ses_b: 3, ses_c: 3, ses_d: 2 };
let fact = 0;
for (const [target, count] of Object.entries(plan)) {
  for (let index = 0; index < count; index += 1) {
    fact += 1;
    const receipt = await call('collab_send', {
      target,
      kind: 'note',
      text: `三计数用例 ${fact}`,
      factIds: [`F${fact}`],
      confirm: true
    });
    expect(`send ${fact} → ${target} is windowed`, receipt.startsWith('已进入投递窗口'), receipt.split('\n')[0]);
  }
}
const c1 = counters();
expect('raw counts every dispatch entry, suppressed included (10)', c1.raw === 10, `${c1.raw}`);
expect('noop counts the two suppressed turns (2)', c1.noop === 2, `${c1.noop}`);
expect('kept counts the eight that survived the gate (8)', c1.kept === 8, `${c1.kept}`);
expect('raw = kept + noop (the identity the counters promise)', c1.raw === c1.kept + c1.noop, `${c1.raw} = ${c1.kept} + ${c1.noop}`);
const windows1 = internals.readPacing().windows;
expect('three targets → three windows', windows1.length === 3, `items=${windows1.map(window => window.items.length).join(',')}`);
const flush1 = await internals.flushAllWindows();
expect('the eight items merge into three delivered messages', flush1.delivered === 3 && messageLog().length - before1 === 3, `delivered=${flush1.delivered} logged=${messageLog().length - before1}`);
const row1 = await internals.refreshMetrics({ force: true, dbPath, storage: 'sqlite' });
expect('the metrics row is raw=10 · kept=8 · msg=3', row1?.raw_count === 10 && row1?.kept_count === 8 && row1?.msg_count === 3, JSON.stringify(row1));
expect(
  'raw ≥ kept ≥ msg_count holds on the PRD case',
  row1.raw_count >= row1.kept_count && row1.kept_count >= row1.msg_count,
  `${row1.raw_count} ≥ ${row1.kept_count} ≥ ${row1.msg_count}`
);
const fileState = JSON.parse(readFileSync(process.env.COLLAB_PACING_FILE, 'utf8'));
expect(
  'the counters land in `counters[day]` next to noop / late',
  fileState.counters[day]?.raw === 10 && fileState.counters[day]?.kept === 8 && fileState.counters[day]?.noop === 2,
  JSON.stringify(fileState.counters[day] ?? null)
);
const stored1 = await readMetricRow(dbPath, day);
expect(
  'the two columns are really in the `metrics` table',
  stored1?.raw_count === 10 && stored1?.kept_count === 8 && stored1?.msg_count === 3,
  JSON.stringify(stored1 ?? null)
);

// ------------------------------------- 2) a second scenario (direct path)
section('2) a direct-path scenario keeps raw ≥ kept ≥ msg_count');
const before2 = counters();
const loggedBefore2 = messageLog().length;
const mirrorE = await call('collab_send', { target: 'ses_e', kind: 'note', text: '没有新东西，同上', confirm: true });
expect('the mirror is suppressed (raw without kept)', mirrorE.startsWith('未发送（无增量）'), mirrorE.split('\n')[0]);
for (const factId of ['F90', 'F91', 'F92']) {
  await call('collab_send', {
    target: 'ses_e',
    kind: 'note',
    text: `直通 ${factId}`,
    factIds: [factId],
    blocked: { need: ['一次复现'], minimalTest: `复现 ${factId}` },
    confirm: true
  });
}
const after2 = counters();
expect('raw moves by 4 (3 direct + 1 suppressed)', after2.raw - before2.raw === 4, `${after2.raw - before2.raw}`);
expect('kept moves by 3 (the three direct sends)', after2.kept - before2.kept === 3, `${after2.kept - before2.kept}`);
expect('msg_count moves by 3 (each direct send is one message)', messageLog().length - loggedBefore2 === 3, `${messageLog().length - loggedBefore2}`);
const row2 = await internals.refreshMetrics({ force: true, dbPath, storage: 'sqlite' });
expect(
  'raw ≥ kept ≥ msg_count holds on the direct scenario too',
  row2.raw_count === 14 && row2.kept_count === 11 && row2.msg_count === 6 && row2.raw_count >= row2.kept_count && row2.kept_count >= row2.msg_count,
  `${row2.raw_count} ≥ ${row2.kept_count} ≥ ${row2.msg_count}`
);

// ---------------------------------------- 3) rebuild == write side, twice
section('3) rebuild recomputes the same three counts (idempotent)');
const dayCounters = readDayCounters()[day];
const writeSide = internals.pacingMetrics(day, dayCounters);
expect(
  'the write side itself carries raw=14 / kept=11 / msg=6',
  writeSide.raw_count === 14 && writeSide.kept_count === 11 && writeSide.msg_count === 6,
  JSON.stringify(writeSide)
);
const rebuildOnce = () =>
  internals.rebuildIndex({
    dbPath,
    messagesFile,
    pacingFile: process.env.COLLAB_PACING_FILE,
    broadcasts: [],
    threads: {},
    sinceDays: 0
  });
const first = await rebuildOnce();
const rebuilt1 = await readMetricRow(dbPath, day);
const second = await rebuildOnce();
const rebuilt2 = await readMetricRow(dbPath, day);
expect(
  'rebuild reads the counters back: raw=14 · kept=11 · msg=6',
  rebuilt1?.raw_count === 14 && rebuilt1?.kept_count === 11 && rebuilt1?.msg_count === 6,
  JSON.stringify(rebuilt1 ?? null)
);
expect(
  'rebuild 与写入侧逐日、逐字段一致',
  JSON.stringify(rebuilt1) === JSON.stringify({ ...writeSide }),
  `${JSON.stringify(rebuilt1)} vs ${JSON.stringify(writeSide)}`
);
expect(
  'two rebuilds produce the same metrics checksum (and the same row)',
  typeof first.checksums?.metrics === 'string' &&
    first.checksums.metrics === second.checksums?.metrics &&
    JSON.stringify(first.checksums) === JSON.stringify(second.checksums) &&
    JSON.stringify(rebuilt1) === JSON.stringify(rebuilt2),
  `metrics=${first.checksums?.metrics} / ${second.checksums?.metrics}`
);

// ------------------------------------- 4) old data → NULL, rendered as `-`
section('4) counters without raw / kept → NULL (never 0), shown as `-`');
const oldDir = join(root, 'metrics-old');
mkdirSync(oldDir, { recursive: true });
const oldMessages = join(oldDir, 'collab-messages.jsonl');
const oldPacing = join(oldDir, 'collab-pacing.json');
const oldDb = join(oldDir, 'collab.db');
const oldTime = new Date(2026, 0, 5, 12, 0, 0).getTime();
const oldDay = internals.dayKey(oldTime);
internals.appendMessage(
  internals.makeEnvelope({ id: 'msg_old_1', from: 'ses_a', to: 'ses_b', kind: 'note', body: 'old', sentAt: oldTime }),
  { file: oldMessages }
);
writeFileSync(
  oldPacing,
  `${JSON.stringify(
    {
      v: internals.PACING_VERSION,
      windows: [],
      counters: { [oldDay]: { noop: 2, late: 1 } },
      lastSent: {},
      noops: {}
    },
    null,
    2
  )}\n`
);
const oldRebuild = await internals.rebuildIndex({
  dbPath: oldDb,
  messagesFile: oldMessages,
  pacingFile: oldPacing,
  broadcasts: [],
  threads: {},
  sinceDays: 0
});
const oldRow = await readMetricRow(oldDb, oldDay);
expect(
  'an old counters entry keeps noop/late and leaves raw/kept NULL',
  oldRebuild.ok && oldRow?.raw_count === null && oldRow?.kept_count === null && oldRow?.noop_count === 2 && oldRow?.late_count === 1,
  JSON.stringify(oldRow ?? null)
);
const oldWriteSide = internals.pacingMetrics(oldDay, internals.normalizePacingState(JSON.parse(readFileSync(oldPacing, 'utf8'))).counters[oldDay], {
  file: oldMessages
});
expect(
  'the write side normalises the same old counters to NULL too (not 0)',
  oldWriteSide.raw_count === null && oldWriteSide.kept_count === null,
  JSON.stringify(oldWriteSide)
);
writeConfig({ dbPath: oldDb });
await settle(1100);
const listed = await call('collab_index', { action: 'metrics' });
const printed = listed.split('\n').find(line => line.startsWith(`${oldDay} · raw `)) ?? '';
expect(
  '`collab_index metrics` prints raw - · kept - for that day',
  printed === `${oldDay} · raw - · kept - · msg 1 · noop 2 · late 1 · gap 0ms`,
  printed || listed.split('\n')[0]
);
expect(
  'the tool explains `-` (expired / never recorded, not 0)',
  /计数已过期/.test(listed),
  listed.split('\n').find(line => line.includes('计数已过期')) ?? '-'
);

// ------------------------------- 5) the rendered line for the live counters
section('5) the rendered row for the measured day');
writeConfig({});
await settle(1100);
const live = await call('collab_index', { action: 'metrics' });
const liveLine = live.split('\n').find(line => line.startsWith(`${day} · raw `)) ?? '';
expect(
  'the row reads `day · raw 14 · kept 11 · msg 6 · noop 3 · late L · gap G`',
  new RegExp(`^${day} · raw 14 · kept 11 · msg 6 · noop 3 · late \\d+ · gap \\d+ms$`).test(liveLine),
  liveLine || live.split('\n')[0]
);
console.log(`  · 样例输出: ${liveLine}`);

// --------------------- 6) 全量埋点：六个直投点各计一次 raw + kept（0.10.x）
section('6) direct deliveries count raw + kept too (all six points)');

/** One delivery's counter delta — every point must move raw/kept by exactly 1. */
const deltaOf = async (label, run) => {
  const before = counters();
  const loggedBefore = messageLog().length;
  const result = await run();
  const after = counters();
  const delta = {
    raw: (after.raw ?? 0) - (before.raw ?? 0),
    kept: (after.kept ?? 0) - (before.kept ?? 0),
    noop: (after.noop ?? 0) - (before.noop ?? 0),
    logged: messageLog().length - loggedBefore
  };
  console.log(`  · ${label}: Δraw=${delta.raw} Δkept=${delta.kept} Δnoop=${delta.noop} Δmessages=${delta.logged}`);
  return { delta, result };
};
const exactOne = delta => delta.raw === 1 && delta.kept === 1 && delta.noop === 0;

// 6a) 5× escalate — the measured defect (`msg=5, raw=1` before full coverage).
const escBefore = counters();
const escLoggedBefore = messageLog().length;
for (let index = 0; index < 5; index += 1) {
  const receipt = await call('collab_escalate', { session: 'ses_f', reason: `三计数全量 ${index + 1}`, confirm: true });
  expect(`escalate ${index + 1}/5 delivers`, receipt.startsWith('已加急'), receipt.split('\n')[0]);
}
const escAfter = counters();
const escMsg = messageLog().length - escLoggedBefore;
expect('5×escalate → msg=5 (five real deliveries)', escMsg === 5, `${escMsg}`);
expect('5×escalate → raw=5 (not 1: every URGENT is a raw unit)', escAfter.raw - escBefore.raw === 5, `${escAfter.raw - escBefore.raw}`);
expect('5×escalate → kept=5 (a direct delivery is never suppressed)', escAfter.kept - escBefore.kept === 5, `${escAfter.kept - escBefore.kept}`);

// 6a2) a **direct** prompt the host refuses is not a delivery: no raw/kept.
const failBefore = counters();
const failLoggedBefore = messageLog().length;
failPrompts.add('ses_fail');
const refused = await (async () => {
  try {
    return await call('collab_send', {
      target: 'ses_fail',
      kind: 'note',
      text: '直投失败：宿主拒绝',
      factIds: ['F777'],
      blocked: { need: ['一次复现'], minimalTest: '宿主拒绝 prompt' },
      confirm: true
    });
  } catch (error) {
    return `threw: ${String(error?.message ?? error)}`;
  }
})();
failPrompts.delete('ses_fail');
const failAfter = counters();
expect('the direct send really failed (a delivery error, not a silent success)', String(refused).startsWith('threw:'), String(refused).split('\n')[0]);
expect(
  'a refused direct prompt → Δraw=Δkept=0 and no message row',
  (failAfter.raw ?? 0) === (failBefore.raw ?? 0) &&
    (failAfter.kept ?? 0) === (failBefore.kept ?? 0) &&
    messageLog().length === failLoggedBefore,
  JSON.stringify({ before: failBefore, after: failAfter, logged: messageLog().length - failLoggedBefore })
);

// 6b) the freeze notice (`[frozen]`) is a direct delivery.
const frozen = await deltaOf('freeze 通知', () =>
  call('collab_freeze', { scope: 'session', target: 'ses_d', reason: '三计数全量验证', confirm: true })
);
expect('freeze notice → Δraw=Δkept=1, one message', exactOne(frozen.delta) && frozen.delta.logged === 1, JSON.stringify(frozen.delta));
await call('collab_freeze', { scope: 'session', target: 'ses_d', reason: '三计数全量验证', freeze: false, confirm: true });

// 6c) the defect report note is a direct delivery.
writeConfig({ report: { to: 'ses_f' }, aliases: {} });
await settle(30);
const reported = await deltaOf('缺陷上报', () => call('collab_report', { note: '三计数全量：缺陷上报直投点', confirm: true }));
expect('defect report → Δraw=Δkept=1, one message', exactOne(reported.delta) && reported.delta.logged === 1, JSON.stringify(reported.delta));
writeConfig({});
await settle(30);

// 6d) the bounded resend (`_r<n>`) is a real delivery: raw/kept +1, msg_count
// keeps excluding it (same rule as before full coverage).
await call('collab_handoff', { target: 'ses_b', text: '三计数全量：重发直投点', confirm: true });
const resendRecord = internals.allBroadcasts().filter(record => record.scope === 'local').at(-1);
expect('the resend record carries an admission receipt (delivery.cid)', Boolean(resendRecord?.delivery?.cid), JSON.stringify(resendRecord?.delivery ?? {}));
internals.writeBroadcast({
  ...resendRecord,
  delivery: {
    ...resendRecord.delivery,
    admittedAt: Date.now() - 3 * 3_600_000,
    lastAttemptAt: Date.now() - 3 * 3_600_000
  }
});
const resent = await deltaOf('重发 _r1', () => hooks.context({ sessionID: 'ses_a', agent: 'build', system: [], messages: [] }));
const resendMessage = messageLog().filter(message => internals.isResendID(message.id)).at(-1);
expect('resend → Δraw=Δkept=1 and one `_r1` row', exactOne(resent.delta) && resent.delta.logged === 1 && Boolean(resendMessage), JSON.stringify(resent.delta));
expect(
  'the resend row stays out of msg_count (`isResendID`)',
  internals.isResendID(String(resendMessage?.id ?? '')) &&
    (await internals.refreshMetrics({ force: true, dbPath, storage: 'sqlite' })).msg_count ===
      messageLog().filter(message => !internals.isResendID(message.id)).length,
  resendMessage?.id ?? '-'
);

// 6e) `notifyRequester` (the ACCEPT note back to the requester): an open record
// claimed by ses_b; the note to ses_a is the delivery.
const notifyBid = 'b_6e0f1a2b3c4d5e6f';
internals.writeBroadcast({
  bid: notifyBid,
  scope: 'local',
  workspace,
  title: '三计数全量：notifyRequester 直投点',
  expected: 'implement',
  affectedFiles: [],
  candidates: [{ sid: 'ses_b', score: 90, why: ['test'] }],
  state: 'open',
  attempts: 0,
  skipped: [],
  seenBy: [],
  reminded: [],
  replies: [],
  from: { sid: 'ses_a', directory: workspace },
  createdAt: Date.now()
});
const notified = await deltaOf('notifyRequester', () => call('collab_accept', { bid: notifyBid, confirm: true }, 'ses_b'));
expect(
  'notifyRequester (ACCEPT) → Δraw=Δkept=1, one message',
  notified.result.startsWith('已领取') && exactOne(notified.delta) && notified.delta.logged === 1,
  `${notified.result.split('\n')[0]} / ${JSON.stringify(notified.delta)}`
);

// 6f) the `[ack]` loop: ses_b reads its inbox → one ack note back to ses_a.
const ackCid = String(resendRecord?.delivery?.cid ?? '');
store.set('collab/inbox/ses_b', {
  messages: [
    {
      id: 'inbox_dual_ack',
      from: 'A',
      fromSession: 'ses_a',
      ts: Date.now(),
      kind: 'request',
      text: '三计数全量：ack 直投点',
      cid: ackCid
    }
  ],
  injected: [],
  cursor: 0
});
const acked = await deltaOf('ack 回环', () => call('collab_inbox', {}, 'ses_b'));
expect('ack → Δraw=Δkept=1, one message', exactOne(acked.delta) && acked.delta.logged === 1, JSON.stringify(acked.delta));

// 6g) `deliverAsk` (broadcast spawn / wake) — the 7th direct point: once per
// prompt, and **zero** on an idempotent repeat of the same broadcast.
const peerWorkspace = join(root, 'peer-ws');
mkdirSync(join(peerWorkspace, 'docs', 'issues'), { recursive: true });
writeFileSync(
  join(peerWorkspace, 'docs', 'issues', 'fix-dual.md'),
  '# 三计数 peer 提案\n\n修复 `apps/x/src/main.ts` 的计数口径。\n'
);
const spawnedAsk = await deltaOf('broadcast spawn/ask', () =>
  call('collab_broadcast', { workspace: peerWorkspace, issuePath: 'docs/issues/fix-dual.md', confirm: true })
);
expect(
  'broadcast spawn/ask → Δraw=Δkept=1, one takeover message',
  exactOne(spawnedAsk.delta) && spawnedAsk.delta.logged === 1,
  `${spawnedAsk.result.split('\n')[0]} / ${JSON.stringify(spawnedAsk.delta)}`
);
const repeatedAsk = await deltaOf('broadcast 幂等重复', () =>
  call('collab_broadcast', { workspace: peerWorkspace, issuePath: 'docs/issues/fix-dual.md', confirm: true })
);
expect(
  'an idempotent repeat broadcast → Δ=0 (no prompt, no message)',
  repeatedAsk.delta.raw === 0 &&
    repeatedAsk.delta.kept === 0 &&
    repeatedAsk.delta.noop === 0 &&
    repeatedAsk.delta.logged === 0,
  `${repeatedAsk.result.split('\n')[0]} / ${JSON.stringify(repeatedAsk.delta)}`
);

// 6h) after every direct point: rebuild == write side, twice, and the invariant.
const finalWrite = internals.pacingMetrics(day, readDayCounters()[day]);
const finalFirst = await rebuildOnce();
const finalRow1 = await readMetricRow(dbPath, day);
const finalSecond = await rebuildOnce();
const finalRow2 = await readMetricRow(dbPath, day);
expect(
  'after the direct points: rebuild == write side (raw/kept/msg/day)',
  JSON.stringify(finalRow1) === JSON.stringify({ ...finalWrite }),
  `${JSON.stringify(finalRow1)} vs ${JSON.stringify(finalWrite)}`
);
expect(
  'after the direct points: two rebuilds share one metrics checksum',
  typeof finalFirst.checksums?.metrics === 'string' &&
    finalFirst.checksums.metrics === finalSecond.checksums?.metrics &&
    JSON.stringify(finalRow1) === JSON.stringify(finalRow2),
  `metrics=${finalFirst.checksums?.metrics} / ${finalSecond.checksums?.metrics}`
);
expect(
  'full-coverage day: raw ≥ kept ≥ msg_count',
  finalWrite.raw_count >= finalWrite.kept_count && finalWrite.kept_count >= finalWrite.msg_count,
  `${finalWrite.raw_count} ≥ ${finalWrite.kept_count} ≥ ${finalWrite.msg_count}`
);

// --------------------- 7) 升级当天：部分计数是允许的形状（可识别，不冒充全量）
section('7) upgrade-day shape: partial counters are legal and detectable');
const upgradeState = internals.emptyPacingState();
const upgradeNow = Date.now();
upgradeState.counters[day] = { noop: 0, late: 0 };
const beforeUpgrade = internals.pacingMetrics(day, upgradeState.counters[day]);
expect(
  'a day whose counters predate raw/kept → both columns NULL, msg_count still real',
  beforeUpgrade.raw_count === null && beforeUpgrade.kept_count === null && beforeUpgrade.msg_count > 0,
  JSON.stringify(beforeUpgrade)
);
internals.bumpCounter(upgradeState, 'raw', upgradeNow);
internals.bumpCounter(upgradeState, 'kept', upgradeNow);
const afterUpgrade = internals.pacingMetrics(day, upgradeState.counters[day]);
expect(
  'one post-upgrade delivery → raw=1, kept=1 while msg_count still counts the pre-upgrade rows (raw < msg)',
  afterUpgrade.raw_count === 1 && afterUpgrade.kept_count === 1 && afterUpgrade.raw_count < afterUpgrade.msg_count,
  `${afterUpgrade.raw_count}/${afterUpgrade.kept_count}/${afterUpgrade.msg_count}`
);
expect(
  'the upgrade day is visibly different from a full day (the full day above keeps the inequality)',
  beforeUpgrade.msg_count === afterUpgrade.msg_count && finalWrite.raw_count >= finalWrite.msg_count,
  `${JSON.stringify({ partial: { raw: afterUpgrade.raw_count, msg: afterUpgrade.msg_count }, full: { raw: finalWrite.raw_count, msg: finalWrite.msg_count } })}`
);
expect(
  'an explicit `raw: null` is not normalised into 0',
  (() => {
    const state = internals.normalizePacingState({
      v: internals.PACING_VERSION,
      windows: [],
      counters: { [day]: { noop: 0, late: 0, raw: null, kept: null } },
      lastSent: {},
      noops: {}
    });
    return state.counters[day]?.raw === undefined && state.counters[day]?.kept === undefined;
  })()
);

// ---------------------------------------- 9) never write the real config
section('9) this suite never writes the operator’s real ~/.config/opencode');
expect(
  'the real collab-pacing.json is unchanged (size + mtime snapshot)',
  snapshotOf(realPacingPath) === realPacingBefore,
  `${realPacingBefore} → ${snapshotOf(realPacingPath)}`
);

// ------------------------------------------------------------- cleanup
rmSync(root, { recursive: true, force: true });
internals.clearFlushTimers();

const failed = checks.filter(check => !check.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`  ✗ ${check.title}`);
  process.exit(1);
}
