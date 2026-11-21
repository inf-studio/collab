/**
 * 0.9.7 (`11-21-collab-decision-inbox`): the **human** decision inbox.
 *
 *   pnpm test                    # builds dist/ first; this file is in the chain
 *   node test/decision-inbox.mjs
 *
 * Everything runs through the built `dist/index.js` with a temp ledger
 * (`COLLAB_DECISIONS_DIR`) — the operator's real `~/.config/opencode/` is never
 * read or written. Design §7:
 *
 *   1. 3 keys mixed → sorted by age (oldest first), total / conflict counts
 *   2. `owner` filter → only that session's rows
 *   3. empty ledger → 「无待决策」 and the directory is **not created**
 *   4. a corrupt file → skipped, one log line, no throw
 *   5. conflict TTL → remaining 22.9h shown; an expired conflict shows none
 *   6. `limit` → 20 rows + 「还有 N 条」, totals still count everything
 *   7. read-only → directory / file mtime unchanged across two calls
 *   8. snapshot / GUI headline / TUI line read the same numbers
 *   9. an empty ledger adds no `decisions` key (0.9.6 payload intact)
 *  10. 520 keys → the oldest wait (`t_k0001`) is visible, total = 520
 *      (review: `readAllDecisions`' 500-slice dropped it and said 500)
 *  11. beyond `DECISION_INBOX_SCAN_LIMIT` → `已扫描 M/N` + the explicit warning,
 *      never a fake `共 N 条`
 *  12. the 2 s scan cache makes a 2000-file warm read much cheaper than cold
 *
 * Plus the surface (29 tools) and the one-derivation contract the board needs:
 * `buildSnapshot` carries the same counts, `decisionHeadline` prints them, and
 * an empty ledger adds no `decisions` key at all (the 0.9.6 payload stays
 * byte-for-byte identical).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
const root = mkdtempSync(join(base, 'collab-decision-inbox-'));
const workspace = join(root, 'workspace');
const decisionsDir = join(root, 'decisions');
const contractDir = join(root, 'contract');
mkdirSync(workspace, { recursive: true });
mkdirSync(contractDir, { recursive: true });

// Every global path is read once at import: pin them *before* importing.
process.env.COLLAB_DECISIONS_DIR = decisionsDir;
process.env.COLLAB_CONTRACT_DIR = contractDir;
process.env.COLLAB_MESSAGES_FILE = join(root, 'collab-messages.jsonl');
process.env.COLLAB_DB_FILE = join(root, 'collab.db');
process.env.COLLAB_BROADCAST_DIR = join(root, 'broadcast');
process.env.COLLAB_THREAD_INDEX_FILE = join(root, 'collab-threads.json');
process.env.COLLAB_CONFIG = join(root, 'collab.json');
process.env.COLLAB_PACING_FILE = join(root, 'collab-pacing.json');
process.env.COLLAB_LOCK_DIR = join(root, 'locks');
process.env.COLLAB_OWNER_QUEUE_DIR = join(root, 'owner-queue');
process.env.COLLAB_FREEZE_FILE = join(root, 'freeze.json');
process.env.COLLAB_AUDIT_FILE = join(root, 'collab-audit.jsonl');
writeFileSync(process.env.COLLAB_CONFIG, JSON.stringify({ windowMs: 0, suppressNoDelta: false }));

const dist = resolve(import.meta.dirname, '../dist/index.js');
const plugin = (await import(pathToFileURL(dist).href)).default;
const internals = (await import(pathToFileURL(dist).href)).__internals;

const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};
const section = title => console.log(`\n--- ${title}`);

// ---------------------------------------------------------------- fake host
const store = new Map();
const tools = [];
const sessions = new Map([['ses_me', { id: 'ses_me', agent: 'build', title: 'inbox reader' }]]);
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
    async hook() {
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
    async create() {
      throw new Error('not used');
    },
    async remove() {},
    async update() {},
    async switchAgent() {},
    async prompt() {
      throw new Error('not used');
    },
    async wait() {}
  },
  event: {
    async *subscribe() {}
  }
};

const originalError = console.error;
const logs = [];
const cleanup = await plugin.setup(ctx);
const tool = name => tools.find(definition => definition.name === name);

const call = async (input, sid = 'ses_me') => {
  logs.length = 0;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  try {
    return (await tool('collab_decision_inbox').execute(input, { sessionID: sid, agent: 'build' })).content;
  } finally {
    console.error = originalError;
  }
};

// ---------------------------------------------------------------- fixtures
const NOW = Date.now();
const HOUR = 3_600_000;
const OWNER_A = 'ses_e176aaaaaaaabbbbb';
const OWNER_B = 'ses_edc3cccccccccddddd';

const decision = (id, over = {}) => ({
  id,
  question: `问题 ${id}`,
  options: ['方案一', '方案二'],
  owner: OWNER_A,
  status: 'open',
  answer: null,
  by: null,
  askedBy: 'ses_asker',
  at: NOW,
  hash: 'a'.repeat(40),
  origin: 'manual',
  ...over
});

const writeLedger = (key, items, dir = decisionsDir) => {
  mkdirSync(dir, { recursive: true });
  const highest = items.reduce((max, item) => Math.max(max, Number(String(item.id).slice(1)) || 0), 0);
  writeFileSync(
    join(dir, `${key}.json`),
    `${JSON.stringify({ v: 1, key, next: highest + 1, items }, null, 2)}\n`,
    'utf8'
  );
};

// ------------------------------------------------- 1) surface (29 tools)
section('1) surface: 29 tools + collab_decision_inbox');
expect('29 tools are registered', tools.length === 29, `${tools.length} tools`);
expect(
  'collab_decision_inbox is registered exactly once (28 → 29)',
  tools.filter(definition => definition.name === 'collab_decision_inbox').length === 1,
  `${tools.filter(definition => definition.name === 'collab_decision_inbox').length} registration(s)`
);
expect(
  'collab_decide is still registered exactly once (existing 28 unchanged)',
  tools.filter(definition => definition.name === 'collab_decide').length === 1,
  `${tools.filter(definition => definition.name === 'collab_decide').length} registration(s)`
);

// ------------------------------------- 2) empty ledger: no mkdir, no throw
section('2) empty ledger → 无待决策, directory never created (R5)');
{
  expect('the ledger directory does not exist yet', !existsSync(decisionsDir), decisionsDir);
  const text = await call({});
  expect('empty ledger says 无待决策', text.includes('无待决策'), JSON.stringify(text));
  expect('empty ledger says 只读', text.includes('只读'), JSON.stringify(text));
  expect('reading an empty ledger never creates the directory', !existsSync(decisionsDir), decisionsDir);
}

// --------------------------------------------------------- 3) mixed ledger
section('3) 3 keys mixed → sorted oldest first, totals / conflicts (R1/R2)');
writeLedger('t_mwlp0001', [
  decision('D1', { at: NOW - 4.2 * HOUR, question: 'dev/prod 键空间是否隔离' }),
  decision('D2', { at: NOW - 5 * HOUR, status: 'answered', answer: '已定', by: OWNER_A }),
  decision('D3', { at: NOW - 2 * HOUR, question: '是否回退前缀隔离' })
]);
writeLedger('t_mwnm0002', [decision('D1', { at: NOW - 0.3 * HOUR, owner: 'human-reviewer' })]);
writeLedger('b_1bb1aaaa', [
  decision('D1', {
    at: NOW - 1.1 * HOUR,
    origin: 'conflict',
    question: '客户端增量帧的判据',
    options: ['以我方为准', '以对方为准']
  }),
  // Past the 24h TTL: still open in the ledger (the inbox must not hide it) but
  // no TTL is printed (a negative remainder is noise).
  decision('D2', { at: NOW - 25 * HOUR, origin: 'conflict', question: '过期冲突' })
]);

{
  const text = await call({});
  const lines = text.split('\n');
  expect(
    'header counts every open decision and the conflict subset',
    lines[0].startsWith('待决策 5 条（冲突 2）') && lines[0].includes('最老 1.0d'),
    JSON.stringify(lines[0])
  );
  const rows = lines.filter(line => line.startsWith('  '));
  expect(
    'answered decisions are filtered out (5 rows, not 6)',
    rows.length === 5,
    JSON.stringify(rows)
  );
  expect(
    'oldest wait is on top, newest at the bottom',
    rows[0].includes('#D2') && rows[0].includes('过期冲突') && rows[0].includes('1.0d') &&
      rows[1].includes('t_mwlp0001#D1') && rows[3].includes('b_1bb1aaaa#D1') &&
      rows[4].includes('t_mwnm0002#D1'),
    JSON.stringify(rows)
  );
  expect(
    'a manual row is `<key>#<D#> · 等 <owner> · <age> · <question>`',
    rows[1].includes('t_mwlp0001#D1') &&
      rows[1].includes('等 ses_e176…') &&
      rows[1].includes('4.2h') &&
      rows[1].includes('dev/prod 键空间是否隔离'),
    JSON.stringify(rows[1])
  );
  expect(
    'an owner that is not a session reads 人工',
    rows[4].includes('等 人工'),
    JSON.stringify(rows[4])
  );
  expect(
    'the conflict row carries ⚠冲突 and the remaining TTL',
    rows[3].includes('⚠冲突（TTL 剩 22.9h）'),
    JSON.stringify(rows[3])
  );
  expect(
    'an expired conflict shows ⚠冲突 without a TTL',
    rows[0].includes('⚠冲突') && !rows[0].includes('TTL'),
    JSON.stringify(rows[0])
  );
  expect('footer totals', lines.includes('共 5 条 · 其中冲突 2 条'), JSON.stringify(lines));
  expect('the answer is read-only', text.trim().endsWith('只读：未写入、未投递。'), JSON.stringify(text.slice(-40)));
}

// ------------------------------------------------------- 4) owner filter
section('4) owner filter (R1)');
{
  const text = await call({ owner: OWNER_A });
  const rows = text.split('\n').filter(line => line.startsWith('  '));
  expect('only the owner’s rows remain', rows.length === 4 && rows.every(row => row.includes('ses_e176…')), JSON.stringify(rows));
  expect('the header counts the filtered set', text.startsWith('待决策 4 条（冲突 2）'), JSON.stringify(text.split('\n')[0]));
  const missing = await call({ owner: 'ses_nobody' });
  expect('an owner with nothing open says 无待决策', missing.startsWith('无待决策'), JSON.stringify(missing.split('\n')[0]));
}

// ------------------------------------------------------- 5) corrupt file
section('5) corrupt ledger file → skipped + one log line (no throw)');
{
  writeFileSync(join(decisionsDir, 't_broken0003.json'), '{ not json', 'utf8');
  const text = await call({});
  expect('a corrupt file does not throw and does not hide the good rows', text.startsWith('待决策 5 条'), JSON.stringify(text.split('\n')[0]));
  expect('the corrupt file is named in exactly one log line', logs.filter(line => line.includes('ignoring unreadable decision file') && line.includes('t_broken0003')).length === 1, JSON.stringify(logs));
  expect('the bad file is not counted', !text.includes('t_broken0003#'), JSON.stringify(text));
}

// --------------------------------------------------------- 6) limit / 「还有」
section('6) limit → 20 rows + 还有 N 条, totals count everything (R1)');
{
  // 24 more open decisions over 8 keys (3 each): 5 + 24 = 29 open.
  for (let index = 0; index < 8; index += 1) {
    const key = `t_bulk000${index}`;
    writeLedger(key, [
      decision('D1', { at: NOW - (index * 3 + 6) * HOUR }),
      decision('D2', { at: NOW - (index * 3 + 7) * HOUR }),
      decision('D3', { at: NOW - (index * 3 + 8) * HOUR })
    ]);
  }
  const text = await call({});
  const rows = text.split('\n').filter(line => line.startsWith('  '));
  expect('default limit shows 20 rows', rows.length === 20, `${rows.length} rows`);
  expect('the truncation line says how many are left', text.includes('还有 9 条未显示（limit=20）'), JSON.stringify(text.split('\n').filter(line => line.includes('还有'))));
  expect('the header still counts every open decision', text.includes('待决策 29 条'), JSON.stringify(text.split('\n')[0]));
  expect('the footer still counts every open decision', text.includes('共 29 条 · 其中冲突 2 条'), JSON.stringify(text.split('\n').filter(line => line.startsWith('共 '))));
  const capped = await call({ limit: 2 });
  expect('an explicit limit is honoured', capped.split('\n').filter(line => line.startsWith('  ')).length === 2, JSON.stringify(capped.split('\n').slice(0, 3)));
}

// --------------------------------------------------------- 7) read-only
section('7) read-only: directory / file mtime unchanged (R5)');
{
  const dirStamp = statSync(decisionsDir).mtimeMs;
  const files = readdirSync(decisionsDir).sort();
  const stamps = files.map(name => [name, statSync(join(decisionsDir, name)).mtimeMs]);
  await call({});
  await call({ owner: OWNER_A });
  expect('the ledger directory mtime is unchanged', statSync(decisionsDir).mtimeMs === dirStamp, `${dirStamp} → ${statSync(decisionsDir).mtimeMs}`);
  expect(
    'every ledger file mtime is unchanged (nothing rewritten)',
    JSON.stringify(files.map(name => [name, statSync(join(decisionsDir, name)).mtimeMs])) === JSON.stringify(stamps),
    'mtime drift'
  );
  expect('the file set is unchanged (no temp / lock left behind)', JSON.stringify(readdirSync(decisionsDir).sort()) === JSON.stringify(files), JSON.stringify(readdirSync(decisionsDir).sort()));
}

// ------------------------------- 8) one derivation: snapshot + GUI / TUI lines
section('8) the snapshot block and both windows read the same numbers');{
  const now = Date.now();
  const source = {
    sessions: async () => [],
    locks: () => [],
    handoffs: () => [],
    queue: () => [],
    index: () => ({ available: true })
  };
  const snapshot = await internals.buildSnapshot(source, { session: 'ses_me' }, now);
  const inbox = internals.decisionInbox({ now });
  expect('the snapshot carries a decisions block', Boolean(snapshot.decisions), JSON.stringify(snapshot.decisions?.total));
  expect('snapshot total === tool/inbox total', snapshot.decisions.total === inbox.total && inbox.total === 29, `${snapshot.decisions.total} / ${inbox.total}`);
  expect('snapshot conflicts === inbox conflicts', snapshot.decisions.conflicts === inbox.conflicts && inbox.conflicts === 2, `${snapshot.decisions.conflicts}`);
  expect('the snapshot row cap is the tool default', snapshot.decisions.items.length === 20, `${snapshot.decisions.items.length}`);
  expect(
    'the GUI headline is derived from the same counts',
    internals.decisionHeadline(snapshot.decisions) === `待决策 29 ⚠2`,
    JSON.stringify(internals.decisionHeadline(snapshot.decisions))
  );
  const summary = internals.decisionSummaryLine(snapshot.decisions);
  expect('the TUI detail line carries the oldest wait', summary?.includes('最老') && summary.startsWith('待决策 29'), JSON.stringify(summary));
  const conflictRow = inbox.rows.find(row => row.origin === 'conflict' && row.ttlLeftMs);
  expect(
    'a conflict row carries ⚠冲突 + TTL when rendered',
    Boolean(conflictRow) && internals.decisionRowText(conflictRow).includes('⚠冲突（TTL 剩'),
    JSON.stringify(conflictRow && internals.decisionRowText(conflictRow))
  );
  expect('no open decision → no GUI headline and no TUI line', internals.decisionHeadline(undefined) === undefined && internals.decisionSummaryLine({ total: 0, conflicts: 0, oldestAgeMs: 0, items: [] }) === undefined);
}

// ------------------------------------- 9) empty ledger adds no snapshot key
section('9) an empty ledger leaves the snapshot byte-identical (no `decisions` key)');
{
  const emptyDir = join(root, 'empty-decisions');
  expect(
    'snapshotDecisions(empty) is undefined → buildSnapshot adds no key',
    internals.snapshotDecisions(Date.now(), emptyDir) === undefined,
    JSON.stringify(internals.snapshotDecisions(Date.now(), emptyDir))
  );
  expect('the empty directory is still not created', !existsSync(emptyDir), emptyDir);
  expect('COLLAB_DECISIONS_DIR is pinned to the fixture', process.env.COLLAB_DECISIONS_DIR === decisionsDir, process.env.COLLAB_DECISIONS_DIR);
}

// ------------------------- 10) >500 keys: the oldest wait is not dropped
section('10) 520 ledger keys: all scanned, the oldest wait stays visible (review fix)');
{
  // `readAllDecisions` keeps `.sort().slice(-500)` — the lexicographically
  // largest (≈ newest) names. This fixture is exactly the review's counter-example:
  // 520 keys, the oldest decision in `t_k0001` (the first name to be dropped).
  const manyDir = join(root, 'many-decisions');
  for (let index = 1; index <= 520; index += 1) {
    const key = `t_k${String(index).padStart(4, '0')}`;
    // k0001 is the oldest; later keys are progressively newer.
    writeLedger(key, [decision('D1', { at: NOW - (522 - index) * 60_000, question: `问题 ${key}` })], manyDir);
  }
  const coldStart = performance.now();
  const inbox = internals.decisionInbox({ directory: manyDir, now: NOW });
  const coldMs = performance.now() - coldStart;
  expect('520 keys are all scanned (not the old 500 slice)', inbox.totalKeys === 520 && inbox.scannedKeys === 520 && !inbox.truncated, JSON.stringify({ totalKeys: inbox.totalKeys, scannedKeys: inbox.scannedKeys, truncated: inbox.truncated }));
  expect('total is 520, not the 500-slice count', inbox.total === 520, `${inbox.total}`);
  expect('the oldest wait (t_k0001) is present and on top', inbox.rows[0]?.key === 't_k0001', JSON.stringify(inbox.rows.slice(0, 2).map(row => row.key)));
  const text = internals.formatDecisionInbox(inbox, {});
  expect(
    'the tool answer contains the oldest row and no truncation warning',
    text.includes('t_k0001#D1') && text.includes('共 520 条') && !text.includes('仅扫描'),
    JSON.stringify(text.split('\n').slice(0, 3))
  );
  console.log(`  · 520-key cold scan: ${coldMs.toFixed(1)}ms`);
}

// ------------------------- 11) explicit scan bound: warning, not a fake total
section('11) beyond the scan bound: explicit warning + 已扫描 M/N (never a fake 共 N)');
{
  const inbox = internals.decisionInbox({ directory: join(root, 'many-decisions'), now: NOW, scanLimit: 200 });
  expect('the scan is bounded and says so', inbox.truncated && inbox.totalKeys === 520 && inbox.scannedKeys === 200, JSON.stringify({ totalKeys: inbox.totalKeys, scannedKeys: inbox.scannedKeys }));
  const text = internals.formatDecisionInbox(inbox, {});
  expect(
    'the header says 已扫描 200/520, not "共 520 条"',
    text.split('\n')[0].includes('（已扫描 200/520 个 key）') && !text.includes('共 520 条'),
    JSON.stringify(text.split('\n').slice(0, 2))
  );
  expect(
    'the exact warning line is printed',
    text.includes('⚠账本 520 个 key，仅扫描 200 个（可能漏更老待办）'),
    JSON.stringify(text.split('\n').slice(0, 2))
  );
  expect('the footer says 已扫描 M/N', text.includes('已扫描 200/520 个 key · 其中冲突 0 条'), JSON.stringify(text.split('\n').filter(line => line.startsWith('已扫描'))));
  expect('the unscanned oldest key is genuinely absent', !inbox.rows.some(row => row.key === 't_k0001'), JSON.stringify(inbox.rows.slice(-2).map(row => row.key)));
  const truncatedBlock = { total: 5, conflicts: 1, oldestAgeMs: 3_600_000, items: [], truncated: true, keys: 5200, scannedKeys: 2000 };
  expect(
    'GUI headline / TUI line carry 已扫描 M/N when truncated',
    internals.decisionHeadline(truncatedBlock) === '待决策 5 ⚠1（已扫描 2000/5200 key）' &&
      internals.decisionSummaryLine(truncatedBlock).includes('已扫描 2000/5200'),
    JSON.stringify([internals.decisionHeadline(truncatedBlock), internals.decisionSummaryLine(truncatedBlock)])
  );
}

// ------------------------- 12) 2 s cache: 2 s poll does not re-read the ledger
section('12) scan cache: warm read is much cheaper than the cold scan');
{
  const perfDir = join(root, 'perf-decisions');
  for (let index = 0; index < 2000; index += 1) {
    writeLedger(`t_p${String(index).padStart(4, '0')}`, [], perfDir);
  }
  const time = () => {
    const start = performance.now();
    const scan = internals.decisionInbox({ directory: perfDir, now: NOW });
    return { ms: performance.now() - start, scan };
  };
  const cold = time();
  const warm = time();
  console.log(`  · 2000-file scan: cold ${cold.ms.toFixed(1)}ms · warm ${warm.ms.toFixed(1)}ms`);
  expect('2000 files are read on the cold scan', cold.scan.totalKeys === 2000, `${cold.scan.totalKeys}`);
  expect('the warm scan is served from the 2 s cache (much cheaper)', warm.ms < cold.ms && warm.ms < 20, `cold ${cold.ms.toFixed(1)}ms / warm ${warm.ms.toFixed(1)}ms`);
}

await cleanup?.();
console.log(
  `\n${checks.filter(check => check.ok).length}/${checks.length} checks passed` +
    ` · ${tools.length} tools · ${readdirSync(decisionsDir).length} ledger files`
);
if (checks.some(check => !check.ok)) process.exit(1);
