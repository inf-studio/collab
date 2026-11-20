/**
 * 0.9.4 (`11-20-collab-facts`): the facts ledger, the three-state freshness
 * verdict and the pair glossary. Design §9's ten cases plus the surface and the
 * message-side wiring (`grade` / `factIds` / `basedOn`, `[未标注]`, `[settled]`,
 * `[retracted]`, `[glossary]`, `staleWork`).
 *
 *   pnpm test                 # builds dist/ first; this file is part of the chain
 *   node test/facts.mjs
 *
 * Everything runs through the built `dist/index.js` with temp paths — no host,
 * no `~/.config/opencode/collab-*`. `compare` is clock/git free (an explicit
 * local state), so the fresh/stale/conflict cases need no repository.
 *
 *   1. surface: 28 tools, `collab_fact` once, four actions, version 0.9.5
 *   2. settle + list: sequential ids, active visible, grade required,
 *      explicit `unknown` is listable as `grade=unknown`
 *   3. `relayed` / `unknown` facts are refused as evidence (by text and by
 *      `factIds`); so is a superseded / retracted fact
 *   4. retract: state, reason, `metrics.retract_count` +1, no double retract
 *   5. invalidate F#: the fact and its cited dependants are superseded, epoch+1,
 *      `[retracted:F#→F#]` in the next injection (workspace-level)
 *   6. invalidate epoch: every active fact settled up to it is superseded
 *   7. tri-state: fresh / stale / conflict / no-baseline (D2)
 *   8. injection: `[未标注]`, `[stale]` + the ≤30% instruction, `[基线未知]`,
 *      `[conflict]`
 *   9. `[settled]` appears once per session (after-push seen set)
 *  10. invalidate marks an open todo `staleWork` + `⚠失效`, never closes it
 *  11. glossary: define, 2nd conflict refused, define+conflict in one call,
 *      one-line `[glossary]` injection
 *  12. send metadata carries grade / factIds / basedOn (default `unknown`)
 *  13. a superseded / retracted fact cannot be cited; the design's flat ledger
 *      shape is still readable
 *  14. review: `supersededBy` survives a retract · 10 in-process concurrent
 *      settles · cross-workspace ledger / `[settled]` / `staleWork` isolation ·
 *      `staleDeliveries` counter
 *  15. review: three processes settling 25 facts each (3 rounds) never lose a
 *      workspace — `wsA/wsB/wsC = 25/25/25 lost=0`, `refusals 0/9`
 *  16. review: the retry budget is fully consumed (`attempts = delays + 1`,
 *      `[50,200,800]` all slept), a holder that releases *after* the budget is
 *      waited for (event-driven, not one last sample), and `release()` never
 *      deletes an unreadable / foreign lock
 *
 * Exits 1 if any check fails.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
const root = mkdtempSync(join(base, 'collab-facts-'));
const workspace = join(root, 'workspace');
const contractDir = join(root, 'contract');
mkdirSync(workspace, { recursive: true });
mkdirSync(contractDir, { recursive: true });
// A `.env` makes the env dimension comparable in the conflict case.
writeFileSync(join(workspace, '.env'), 'API_BASE=http://localhost:1\n', 'utf8');

// Every global path is read once at import: pin them *before* importing.
process.env.COLLAB_FACTS_FILE = join(root, 'collab-facts.json');
process.env.COLLAB_GLOSSARY_FILE = join(root, 'collab-glossary.json');
process.env.COLLAB_CONTRACT_DIR = contractDir;
process.env.COLLAB_MESSAGES_FILE = join(root, 'collab-messages.jsonl');
process.env.COLLAB_DB_FILE = join(root, 'collab.db');
process.env.COLLAB_BROADCAST_DIR = join(root, 'broadcast');
process.env.COLLAB_THREAD_INDEX_FILE = join(root, 'collab-threads.json');
process.env.COLLAB_CONFIG = join(root, 'collab.json');
process.env.COLLAB_LOCK_DIR = join(root, 'locks');
process.env.COLLAB_OWNER_QUEUE_DIR = join(root, 'owner-queue');
process.env.COLLAB_FREEZE_FILE = join(root, 'freeze.json');
process.env.COLLAB_AUDIT_FILE = join(root, 'collab-audit.jsonl');
process.env.COLLAB_GRANT_DIR = join(root, 'grants');
for (const dir of ['broadcast', 'locks', 'owner-queue', 'grants']) mkdirSync(join(root, dir), { recursive: true });

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

// ---------------------------------------------------------------- fake host
const store = new Map();
const tools = [];
const hooks = {};
const prompts = [];
const sessions = new Map([
  ['ses_me', { id: 'ses_me', agent: 'build', title: 'facts sender' }],
  ['ses_peer', { id: 'ses_peer', agent: 'build', title: 'facts peer' }]
]);
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
      const info = { id: `ses_spawn_${sessions.size + 1}`, agent: input.agent ?? 'build', title: input.title ?? '' };
      sessions.set(info.id, info);
      return structuredClone(info);
    },
    async remove() {},
    async update() {},
    async switchAgent() {},
    async prompt(input) {
      prompts.push(structuredClone(input));
      return { id: `msg_${prompts.length}`, delivery: 'queue' };
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
const cleanup = await plugin.setup(ctx);
console.error = originalError;

const tool = name => tools.find(definition => definition.name === name);
const call = async (name, input, sid = 'ses_me', agent = 'build') =>
  (await tool(name).execute(input, { sessionID: sid, agent })).content;
const callError = async (name, input, sid = 'ses_me') => {
  try {
    await call(name, input, sid);
    return undefined;
  } catch (error) {
    return String(error?.message ?? error);
  }
};
const ask = async sid => {
  const event = { sessionID: sid, agent: 'build', messages: [], system: [] };
  await hooks.context(event);
  return event.system.map(block => String(block?.text ?? '')).join('\n\n');
};
const settle = (claim, evidence, grade, extra = {}, sid = 'ses_me') =>
  call('collab_fact', { action: 'settle', claim, evidence, grade, confirm: true, ...extra }, sid);
const ledger = () => internals.readLedger(process.env.COLLAB_FACTS_FILE);
const factOf = id => ledger().workspaces[workspace]?.facts.find(fact => fact.id === id);
const workspaceLedger = () => ledger().workspaces[workspace] ?? { epoch: 0, seq: 0, facts: [], metrics: {} };
const seedInbox = (sid, messages) =>
  store.set(`collab/inbox/${sid}`, {
    messages: messages.map((message, index) => ({
      id: `inbox_${index + 1}_${sid}`,
      cid: `cid_${index + 1}_${sid}`,
      sessionID: sid,
      fromSession: 'ses_peer',
      from: 'peer',
      kind: 'request',
      text: `message ${index + 1}`,
      ts: Date.now(),
      ...message
    })),
    cursor: 0,
    injected: [],
    updated: Date.now()
  });

// ============================================================ 1) surface
section('1) surface: 28 tools + collab_fact');
expect('PLUGIN_VERSION / package.json agree (0.9.5)', internals.PLUGIN_VERSION === pkg.version && pkg.version === '0.9.5', `${internals.PLUGIN_VERSION} vs ${pkg.version}`);
expect('28 tools are registered', tools.length === 28, `${tools.length} tools`);
expect(
  'collab_fact is registered exactly once',
  tools.filter(definition => definition.name === 'collab_fact').length === 1,
  `${tools.filter(definition => definition.name === 'collab_fact').length} registration(s)`
);
expect(
  'collab_fact actions: settle | retract | invalidate | list',
  JSON.stringify(tool('collab_fact').input.properties.action.enum) ===
    JSON.stringify(['settle', 'retract', 'invalidate', 'list']),
  JSON.stringify(tool('collab_fact').input.properties.action.enum)
);
expect('the ledger path is isolated', internals.factsFile() === process.env.COLLAB_FACTS_FILE, internals.factsFile());

// ============================================================ 2) settle + list
section('2) settle + list');
const first = await settle('serverId 恒非空', 'repo/era RedisClient.php:601', 'measured');
const second = await settle('retry 上限是 3', 'repo/era retry.ts:41', 'inferred');
expect('ids are sequential (F1, F2)', factOf('F1')?.id === 'F1' && factOf('F2')?.id === 'F2', `${factOf('F1')?.id} / ${factOf('F2')?.id}`);
expect('settle names the id + epoch', /已登记 F1 \[measured\] epoch 0/.test(first), first.split('\n')[0]);
const listed = await call('collab_fact', { action: 'list' });
expect('list shows both active facts', listed.includes('F1') && listed.includes('F2'), listed.split('\n')[0]);
expect('list is read-only (no new facts)', workspaceLedger().facts.length === 2, `${workspaceLedger().facts.length}`);
const missingGrade = await callError('collab_fact', { action: 'settle', claim: 'x', evidence: 'y', confirm: true });
expect('settle without grade is refused', /必填 grade/.test(missingGrade ?? ''), missingGrade);
const missingEvidence = await callError('collab_fact', { action: 'settle', claim: 'x', evidence: '', grade: 'measured', confirm: true });
expect('settle without evidence is refused', /必填 evidence/.test(missingEvidence ?? ''), missingEvidence);
const preview = await call('collab_fact', { action: 'settle', claim: 'preview only', evidence: 'x', grade: 'measured' });
expect('preview writes nothing', /未写入/.test(preview) && workspaceLedger().facts.length === 2, `${workspaceLedger().facts.length}`);
await settle('未标注的断言', 'someone said so', 'unknown');
const unknownList = await call('collab_fact', { action: 'list' });
expect('an explicit unknown grade is listable as grade=unknown', unknownList.includes('F3 [unknown]'), unknownList.split('\n').find(line => line.includes('F3')) ?? '');
const retractedBeforeOverwrite = internals.metricsOf(workspace).retracted;
const overwrite = await settle('serverId 恒非空', 'repo/era RedisClient.php:640', 'measured');
const retractedAfterOverwrite = internals.metricsOf(workspace).retracted;
expect('an identical claim supersedes the active older one', /旧事实已 supersede: F1/.test(overwrite) && factOf('F1')?.state === 'superseded', overwrite.split('\n').slice(-1)[0]);
expect('the replacement is F4 with evidence moved', factOf('F4')?.evidence === 'repo/era RedisClient.php:640', factOf('F4')?.evidence);
expect(
  'a settle overwrite counts in retract_count (design §5: retract + supersede)',
  retractedAfterOverwrite === retractedBeforeOverwrite + 1,
  `${retractedBeforeOverwrite} → ${retractedAfterOverwrite}`
);

// ============================================================ 3) relayed evidence
section('3) relayed / unknown facts cannot be evidence');
const relayed = await settle('对方说缓存命中率 90%', '转述自 ses_peer', 'relayed');
expect('a relayed fact is registrable', /已登记 F5 \[relayed\]/.test(relayed), relayed.split('\n')[0]);
const relayedByText = await callError('collab_fact', {
  action: 'settle',
  claim: '缓存命中率 90%',
  evidence: '依据 F5 的结论',
  grade: 'measured',
  confirm: true
});
expect('relayed cited in evidence text is refused', /F5 的等级是 relayed/.test(relayedByText ?? ''), relayedByText);
const relayedByList = await callError('collab_fact', {
  action: 'settle',
  claim: '缓存命中率 90%',
  evidence: 'independent probe',
  grade: 'measured',
  factIds: ['F5'],
  confirm: true
});
expect('relayed cited via factIds is refused', /不能作为 settle 的证据/.test(relayedByList ?? ''), relayedByList);
const fromWeakUnknown = await callError('collab_fact', {
  action: 'settle',
  claim: 'another claim',
  evidence: 'independent probe',
  grade: 'measured',
  factIds: ['F3'],
  confirm: true
});
expect('unknown cited via factIds is refused too', /F3 的等级是 unknown/.test(fromWeakUnknown ?? ''), fromWeakUnknown);
const goodCite = await settle('retry 上限是 3（复核）', 'test/retry.mjs 通过', 'measured', { factIds: ['F2'] });
expect('a measured fact may be cited', /已登记 F6/.test(goodCite) && JSON.stringify(factOf('F6')?.basedOn.factIds) === '["F2"]', JSON.stringify(factOf('F6')?.basedOn.factIds));

// ============================================================ 4) retract
section('4) retract is measurable');
const retracted = await call('collab_fact', { action: 'retract', id: 'F5', reason: '口径错误', confirm: true });
expect('retract sets state=retracted', factOf('F5')?.state === 'retracted', factOf('F5')?.state);
expect('the reason is stored', factOf('F5')?.retractReason === '口径错误', factOf('F5')?.retractReason);
expect('metrics.retract_count moved today', internals.metricsOf(workspace).retracted >= 1, String(internals.metricsOf(workspace).retracted));
expect('the reason is classifiable', internals.metricsOf(workspace).reasons['口径错误'] === 1, JSON.stringify(internals.metricsOf(workspace).reasons));
const noReason = await callError('collab_fact', { action: 'retract', id: 'F5', confirm: true });
expect('retract without a reason is refused', /必填 reason/.test(noReason ?? ''), noReason);
const twice = await callError('collab_fact', { action: 'retract', id: 'F5', reason: 'again', confirm: true });
expect('a fact cannot be retracted twice', /已经是 retracted/.test(twice ?? ''), twice);
expect('the retract receipt names the counter', /今日 metrics: retracted/.test(retracted), retracted.split('\n')[1]);

// ============================================================ 5) invalidate F#
section('5) invalidate a fact and its dependants');
const epochBefore = workspaceLedger().epoch;
const invalidated = await call('collab_fact', { action: 'invalidate', since: 'F2', confirm: true });
expect('the root is superseded', factOf('F2')?.state === 'superseded', factOf('F2')?.state);
expect('the dependant citing F2 is superseded', factOf('F6')?.state === 'superseded', factOf('F6')?.state);
expect('the dependant points at its root', factOf('F6')?.supersededBy === 'F2', factOf('F6')?.supersededBy);
expect('the epoch moved by one', workspaceLedger().epoch === epochBefore + 1, `${epochBefore} → ${workspaceLedger().epoch}`);
expect('the receipt shows the propagation', /已作废 F2→F6/.test(invalidated), invalidated.split('\n')[0]);
const again = await call('collab_fact', { action: 'invalidate', since: 'F2', confirm: true });
expect('re-invalidating is an idempotent no-op', /未变更/.test(again) && workspaceLedger().epoch === epochBefore + 1, again.split('\n')[0]);
const retractionInjection = await ask('ses_new');
expect('a fresh session sees [retracted:F2→F6]', retractionInjection.includes('[retracted:F2→F6]'), retractionInjection.split('\n').find(line => line.startsWith('[retracted')) ?? '(none)');
expect('the retraction line names the claim', /retry 上限是 3/.test(retractionInjection), retractionInjection.split('\n').find(line => line.startsWith('[retracted')) ?? '');

// ============================================================ 6) invalidate epoch
section('6) invalidate an epoch');
const epochNow = workspaceLedger().epoch;
const beforeEpoch = await settle('epoch 前的事实', 'probe:1', 'measured');
expect('the fact records the current epoch', factOf('F7')?.basedOn.facts === epochNow, String(factOf('F7')?.basedOn.facts));
const byEpoch = await call('collab_fact', { action: 'invalidate', since: epochNow, confirm: true });
expect('every active fact settled up to the epoch is superseded', factOf('F7')?.state === 'superseded', factOf('F7')?.state);
expect('the epoch moved again', workspaceLedger().epoch === epochNow + 1, `${epochNow} → ${workspaceLedger().epoch}`);
expect('the receipt names the epoch form', /已作废 epoch:/.test(byEpoch), byEpoch.split('\n')[0]);
expect('settle still names its new id', /已登记 F7/.test(beforeEpoch), beforeEpoch.split('\n')[0]);

// ============================================================ 7) tri-state
section('7) tri-state compare (pure)');
const local = { repo: { '/w': 'aaaa1111' }, env: { '.env': 'bbbb2222' }, facts: 5 };
const fresh = internals.compareBasedOn({ repo: { '/w': 'aaaa1111' }, env: { '.env': 'bbbb2222' }, facts: 5 }, local);
expect('same baseline → fresh', fresh.state === 'fresh' && !fresh.unknown, fresh.state);
const stale = internals.compareBasedOn({ repo: { '/w': 'aaaa1111' }, env: { '.env': 'bbbb2222' }, facts: 3 }, local);
expect('facts behind → stale', stale.state === 'stale' && stale.behind.includes('facts:epoch'), `${stale.state} ${JSON.stringify(stale.behind)}`);
expect('the stale line forbids restating retracted facts', /只回增量（≤30% 原文），不要重述已作废事实/.test(stale.line ?? ''), stale.line);
const conflict = internals.compareBasedOn({ repo: { '/w': 'ffff9999' }, env: { '.env': 'bbbb2222' }, facts: 9 }, local);
expect('ahead + behind → conflict', conflict.state === 'conflict', `${conflict.state} ahead=${JSON.stringify(conflict.ahead)} behind=${JSON.stringify(conflict.behind)}`);
expect(
  'the conflict line says the decision is open and the thread is read-only (0.9.5 landed)',
  /已转决策/.test(conflict.line ?? '') && /只读/.test(conflict.line ?? '') && !/0\.9\.5/.test(conflict.line ?? ''),
  conflict.line
);
const unknown = internals.compareBasedOn(undefined, local);
expect('no basedOn → fresh + unknown (D2)', unknown.state === 'fresh' && unknown.unknown, JSON.stringify(unknown));
expect('D2 is not stale', !unknown.line, String(unknown.line));

// ============================================================ 8) injection markers
section('8) [未标注] / [stale] / [基线未知] / [conflict]');
const epochForInbox = workspaceLedger().epoch;
seedInbox('ses_inbox', [
  { text: 'diverged baseline', grade: 'measured', basedOn: { env: { '.env': 'deadbeef' }, facts: epochForInbox + 9 } },
  { text: 'no grade, stale baseline', basedOn: { facts: 0 } },
  { text: 'measured but stale', grade: 'measured', basedOn: { facts: 0 } }
]);
seedInbox('ses_inbox2', [{ text: 'no baseline at all' }]);
const inboxText = await ask('ses_inbox');
const unknownBaselineText = await ask('ses_inbox2');
const messageLines = inboxText.split('\n').filter(line => line.startsWith('- '));
const unknownBaselineLines = unknownBaselineText.split('\n').filter(line => line.startsWith('- '));
const unlabeledLine = messageLines.find(line => line.includes('no grade, stale baseline')) ?? '';
expect('[未标注] prefixes a message with no declared grade', unlabeledLine.includes('[未标注]'), unlabeledLine);
expect('a measured message is not marked [未标注]', !(messageLines.find(line => line.includes('measured but stale')) ?? '').includes('[未标注]'), messageLines.find(line => line.includes('measured but stale')) ?? '');
expect('[stale] marks the message and the instruction follows', messageLines.some(line => line.includes('[stale]')), messageLines.find(line => line.includes('[stale]')) ?? '(none)');
expect('one [stale] instruction line names the 30% budget', /^\[stale\] .*≤30%/.test(inboxText.split('\n').find(line => line.startsWith('[stale]')) ?? ''), inboxText.split('\n').find(line => line.startsWith('[stale]')) ?? '');
expect('[基线未知] marks a message with no basedOn (D2)', (unknownBaselineLines.find(line => line.includes('no baseline at all')) ?? '').includes('[基线未知]'), unknownBaselineLines.find(line => line.includes('no baseline at all')) ?? '');
expect('[conflict] marks a diverged baseline', inboxText.includes('[conflict]'), inboxText.split('\n').find(line => line.startsWith('[conflict]')) ?? '(none)');

// ============================================================ 9) [settled] once
section('9) [settled] is announced once per session');
const settledFact = await settle('一次性播报的事实', 'probe:2', 'measured', {}, 'ses_settled');
const settledId = /已登记 (F\d+)/.exec(settledFact)?.[1];
const firstSettleAsk = await ask('ses_settled');
const secondSettleAsk = await ask('ses_settled');
expect('the first request carries [settled:F#]', firstSettleAsk.includes(`[settled:${settledId}]`), firstSettleAsk.split('\n').find(line => line.startsWith('[settled')) ?? '(none)');
expect('the second request does not repeat it', !secondSettleAsk.includes(`[settled:${settledId}]`), secondSettleAsk.split('\n').find(line => line.startsWith('[settled')) ?? '(none)');
expect('another session still sees it (workspace-level)', (await ask('ses_other')).includes(`[settled:${settledId}]`), 'ses_other');

// ============================================================ 10) staleWork todos
section('10) invalidate marks an in-flight todo, never closes it');
const todoFact = await settle('这条待办依据的事实', 'probe:3', 'measured', {}, 'ses_todo');
const todoFactId = /已登记 (F\d+)/.exec(todoFact)?.[1];
const addedTodo = await call(
  'collab_todo',
  { action: 'add', subject: '接线 M3 双写', factId: todoFactId, confirm: true },
  'ses_todo'
);
const todoId = /已新增待办 (T\d+)/.exec(addedTodo)?.[1];
expect('the todo records its fact reference', internals.readContract('ses_todo').todos.find(todo => todo.id === todoId)?.ref?.factId === todoFactId, JSON.stringify(internals.readContract('ses_todo').todos.find(todo => todo.id === todoId)?.ref));
await call('collab_fact', { action: 'invalidate', since: todoFactId, confirm: true }, 'ses_todo');
const staleTodo = internals.readContract('ses_todo').todos.find(todo => todo.id === todoId);
expect('the todo is marked staleWork', staleTodo?.staleWork === true, String(staleTodo?.staleWork));
expect('the todo is still open (not auto-closed)', staleTodo?.status === 'open', String(staleTodo?.status));
const todoInjection = await ask('ses_todo');
expect('[todo] shows ⚠失效', todoInjection.includes('⚠失效'), todoInjection.split('\n').find(line => line.includes('⚠失效')) ?? '(none)');
const todoList = await call('collab_todo', { action: 'list' }, 'ses_todo');
expect('collab_todo list shows the fact + warning', todoList.includes(todoFactId) && todoList.includes('⚠失效'), todoList.split('\n').find(line => line.includes(todoId)) ?? '');

// ============================================================ 11) glossary
section('11) pair glossary');
const defined = await call(
  'collab_send',
  { target: 'ses_peer', text: '先对齐术语：状态指读后立即', glossary: { define: { term: '状态', meaning: '读后立即' } }, confirm: true },
  'ses_me'
);
expect('a definition is written', internals.termsFor('ses_me', 'ses_peer').some(term => term.term === '状态'), JSON.stringify(internals.termsFor('ses_me', 'ses_peer')));
const conflict1 = await call(
  'collab_send',
  { target: 'ses_peer', text: '这里「已发版」是指 merged 吗', glossary: { conflict: ['已发版'] }, confirm: true },
  'ses_me'
);
expect('the first conflict is recorded, not refused', /冲突计数 1/.test(conflict1), conflict1.split('\n').find(line => line.includes('冲突')) ?? '');
const conflict2 = await callError('collab_send', {
  target: 'ses_peer',
  text: '「已发版」又冲突了',
  glossary: { conflict: ['已发版'] },
  confirm: true
}, 'ses_me');
expect('the second conflict is refused', /第 2 次冲突/.test(conflict2 ?? '') && /先定义/.test(conflict2 ?? ''), conflict2);
const conflict3 = await call(
  'collab_send',
  { target: 'ses_peer', text: '「已发版」= hotfix 正式化', glossary: { conflict: ['已发版'], define: { term: '已发版', meaning: 'hotfix 正式化' } }, confirm: true },
  'ses_me'
);
expect('define + conflict in one call is allowed', /已定义/.test(conflict3), conflict3.split('\n').find(line => line.includes('术语')) ?? '');
const glossaryText = await ask('ses_peer');
expect('[glossary] injects one line', glossaryText.split('\n').filter(line => line.startsWith('[glossary]')).length === 1, glossaryText.split('\n').find(line => line.startsWith('[glossary]')) ?? '(none)');
expect('the line carries the definitions', /状态=读后立即/.test(glossaryText) && /已发版=hotfix 正式化/.test(glossaryText), glossaryText.split('\n').find(line => line.startsWith('[glossary]')) ?? '');

// ============================================================ 12) send metadata
section('12) send carries grade / factIds / basedOn');
const before = prompts.length;
await call('collab_send', { target: 'ses_peer', text: '实测：serverId 非空', grade: 'measured', factIds: ['F4'], confirm: true }, 'ses_me');
const measured = prompts[before]?.metadata?.collab;
expect('grade is written to delivery metadata', measured?.grade === 'measured', String(measured?.grade));
expect('factIds are written', JSON.stringify(measured?.factIds) === '["F4"]', JSON.stringify(measured?.factIds));
expect('basedOn carries the ledger epoch', Number.isFinite(measured?.basedOn?.facts), JSON.stringify(measured?.basedOn));
const beforeDefault = prompts.length;
await call('collab_send', { target: 'ses_peer', text: '没有标注等级的消息', confirm: true }, 'ses_me');
const unlabeled = prompts[beforeDefault]?.metadata?.collab;
expect('a missing grade defaults to unknown', unlabeled?.grade === 'unknown', String(unlabeled?.grade));
const envelopeLine = readFileSync(process.env.COLLAB_MESSAGES_FILE, 'utf8')
  .trim()
  .split('\n')
  .map(line => JSON.parse(line))
  .find(row => row.body === '没有标注等级的消息');
expect('the archive envelope carries grade + basedOn', envelopeLine?.grade === 'unknown' && Number.isFinite(envelopeLine?.basedOn?.facts), JSON.stringify({ grade: envelopeLine?.grade, basedOn: envelopeLine?.basedOn }));

const citesDead = await callError('collab_fact', {
  action: 'settle',
  claim: 'cites a dead fact',
  evidence: 'independent probe',
  grade: 'measured',
  factIds: ['F1'],
  confirm: true
});
expect('a retracted/superseded fact cannot be cited as evidence either', /已是 superseded/.test(citesDead ?? ''), citesDead);

const flat = join(root, 'flat-facts.json');
writeFileSync(
  flat,
  JSON.stringify({
    v: 1,
    epoch: 3,
    workspace,
    facts: [
      {
        id: 'F1',
        claim: '来自设计文档形状的账本',
        grade: 'measured',
        evidence: 'design §3',
        state: 'active',
        basedOn: { facts: 3 },
        by: 'ses_old',
        at: 1,
        supersededBy: null,
        scope: 'workspace'
      }
    ]
  }),
  'utf8'
);
const migrated = internals.readLedger(flat);
expect(
  'a flat {v, epoch, workspace, facts} file is migrated into workspaces[dir]',
  migrated.workspaces[workspace]?.epoch === 3 && migrated.workspaces[workspace]?.facts[0]?.id === 'F1',
  JSON.stringify(Object.keys(migrated.workspaces))
);

// ============================================================ 13) review: ledger safety
section('13) review: supersede pointer, in-process concurrency, cross-workspace isolation');

// (a) retracting an already-superseded row keeps its `supersededBy` pointer.
const keepOld = await settle('会被覆盖的断言', 'probe:keep', 'measured');
const keepNew = await settle('会被覆盖的断言', 'probe:keep-2', 'measured');
const keepId = /已登记 (F\d+)/.exec(keepOld)?.[1];
const keepNewId = /已登记 (F\d+)/.exec(keepNew)?.[1];
await call('collab_fact', { action: 'retract', id: keepId, reason: '被新版本取代且已过时', confirm: true });
expect(
  'retract keeps the supersededBy pointer of an already-superseded row',
  factOf(keepId)?.state === 'retracted' && factOf(keepId)?.supersededBy === keepNewId,
  JSON.stringify({ state: factOf(keepId)?.state, supersededBy: factOf(keepId)?.supersededBy, expected: keepNewId })
);

// (b) in-process concurrency: 10 settles at once must all land (no lost update
// between two different workspace queues inside one process either).
const concurrentWorkspace = workspace;
const concurrentBefore = workspaceLedger().facts.length;
await Promise.all(
  Array.from({ length: 10 }, (_, index) =>
    internals.settleFact({
      workspace: concurrentWorkspace,
      claim: `并发事实 ${index}`,
      evidence: `probe:concurrent:${index}`,
      grade: 'measured',
      by: 'ses_me',
      now: Date.now() + index
    })
  )
);
const concurrentFacts = workspaceLedger().facts.filter(fact => fact.claim.startsWith('并发事实'));
expect(
  '10 in-process concurrent settles all land (unique ids, no lost update)',
  concurrentFacts.length === 10 && new Set(concurrentFacts.map(fact => fact.id)).size === 10,
  `${concurrentFacts.length} rows / ${new Set(concurrentFacts.map(fact => fact.id)).size} ids (before ${concurrentBefore})`
);

// (c) cross-workspace isolation: a second workspace has its own ledger, its own
// F1, and does not see / announce the first workspace's facts.
const workspaceB = join(root, 'workspace-b');
mkdirSync(workspaceB, { recursive: true });
const factsA = workspaceLedger().facts.length;
ctx.location.directory = workspaceB;
const bSettle = await settle('B 工作区的事实', 'probe:b', 'measured');
const bList = await call('collab_fact', { action: 'list' });
expect('workspace B starts its own ids at F1', /已登记 F1/.test(bSettle), bSettle.split('\n')[0]);
expect(
  'workspace B list does not show workspace A facts',
  bList.includes('B 工作区的事实') && !bList.includes('serverId 恒非空') && !bList.includes('并发事实'),
  bList.split('\n')[0]
);
const bInjection = await ask('ses_ws_b');
expect('[settled:F1] in B is B’s claim, not A’s', bInjection.includes('[settled:F1] B 工作区的事实'), bInjection.split('\n').find(line => line.startsWith('[settled')) ?? '(none)');
ctx.location.directory = workspace;
expect('workspace A ledger is untouched by B', workspaceLedger().facts.length === factsA, `${workspaceLedger().facts.length} vs ${factsA}`);

// (d) staleWork is workspace-scoped: B's `invalidate F1` must not mark A's todo.
const aFact = await settle('A 的在途依据', 'probe:a-work', 'measured', {}, 'ses_stale_a');
const aFactId = /已登记 (F\d+)/.exec(aFact)?.[1];
const aTodo = await call('collab_todo', { action: 'add', subject: 'A 的待办', factId: aFactId, confirm: true }, 'ses_stale_a');
const aTodoId = /已新增待办 (T\d+)/.exec(aTodo)?.[1];
ctx.location.directory = workspaceB;
await call('collab_fact', { action: 'invalidate', since: 'F1', confirm: true }, 'ses_ws_b');
const aStillFresh = internals.readContract('ses_stale_a').todos.find(todo => todo.id === aTodoId);
expect(
  'another workspace’s invalidate does NOT mark this workspace’s todo',
  aStillFresh?.staleWork !== true,
  `staleWork=${String(aStillFresh?.staleWork)} (B invalidated its own F1)`
);
ctx.location.directory = workspace;
await call('collab_fact', { action: 'invalidate', since: aFactId, confirm: true }, 'ses_stale_a');
const aNowStale = internals.readContract('ses_stale_a').todos.find(todo => todo.id === aTodoId);
expect('the owning workspace’s invalidate does mark it', aNowStale?.staleWork === true, String(aNowStale?.staleWork));

// (e) `staleDeliveries` is the auditable half of the ≤30% convention.
expect(
  'stale deliveries were counted for today',
  internals.metricsOf(workspace).staleDeliveries >= 1,
  String(internals.metricsOf(workspace).staleDeliveries)
);

// ============================================================ 14) review: glossary on reply + injection budget
section('14) review: glossary via collab_reply + total injection budget');
const requestSent = await call(
  'collab_send',
  { target: 'ses_peer', text: '请回一条带术语定义的受理', kind: 'request', confirm: true },
  'ses_me'
);
const replyThread = /thread=(t_[A-Za-z0-9_]+)/.exec(requestSent)?.[1];
expect('a request produced a thread to reply on', Boolean(replyThread), replyThread ?? requestSent.split('\n')[1]);
const replied = await call(
  'collab_reply',
  {
    threadID: replyThread,
    text: '受理，术语先对齐：回退 = revert 到上一个 commit',
    glossary: { define: { term: '回退', meaning: 'revert 到上一个 commit' } },
    confirm: true
  },
  'ses_me'
);
expect('collab_reply accepts glossary.define', /术语「回退」已定义/.test(replied), replied.split('\n').find(line => line.includes('术语')) ?? '');
expect(
  'the reply definition is stored on the pair (same pair as send)',
  internals.termsFor('ses_me', 'ses_peer').some(term => term.term === '回退' && term.meaning.includes('revert')),
  JSON.stringify(internals.termsFor('ses_me', 'ses_peer').map(term => term.term))
);

// A session with all four contract sections + the facts section: the contract
// block must stay ≤12 lines and the facts block ≤3 (`[settled]` / `[retracted]` /
// `[glossary]`), i.e. the new lines never blow the request budget.
const budgetSid = 'ses_budget';
await call('collab_mission', { action: 'set', oneLine: '预算测试主线', inScope: ['注入'], outOfScope: ['其它'] }, budgetSid);
await call('collab_mission', { action: 'confirm', by: 'human' }, budgetSid);
await call('collab_progress', { action: 'add', milestone: 'M1', title: '预算', confirm: true }, budgetSid);
await call('collab_todo', { action: 'add', subject: '预算待办一', confirm: true }, budgetSid);
await call('collab_todo', { action: 'add', subject: '预算待办二', blockingOn: 'ses_peer', confirm: true }, budgetSid);
const budgetText = await ask(budgetSid);
const blocks = budgetText.split('\n\n');
const contractBlock = blocks.find(block => block.includes('[mission]')) ?? '';
const factsBlock = blocks.find(block => block.startsWith('[settled') || block.startsWith('[retracted')) ?? '';
const nonEmpty = text => text.split('\n').filter(line => line.trim().length > 0);
expect('the contract block stays ≤12 lines', nonEmpty(contractBlock).length <= 12, String(nonEmpty(contractBlock).length));
expect('the facts block stays ≤3 lines (settled + retracted + glossary)', nonEmpty(factsBlock).length <= 3, String(nonEmpty(factsBlock).length));
expect(
  'the whole injection stays ≤15 lines (12 contract + 3 facts)',
  nonEmpty(budgetText).length <= 15,
  String(nonEmpty(budgetText).length)
);

// ============================================================ 15) review: two-process ledger write
section('15) review: three processes settling at once never lose a workspace');
const raceFile = join(root, 'race-facts.json');
const raceWorkspaceA = join(root, 'race-ws-a');
const raceWorkspaceB = join(root, 'race-ws-b');
const raceWorkspaceC = join(root, 'race-ws-c');
const childScript = join(root, 'race-child.mjs');
writeFileSync(
  childScript,
  [
    "import { pathToFileURL } from 'node:url';",
    `const { __internals } = await import(pathToFileURL(${JSON.stringify(dist)}).href);`,
    'const workspace = process.env.CHILD_WS;',
    'const tag = process.env.CHILD_TAG;',
    'const count = Number(process.env.CHILD_COUNT);',
    'for (let index = 0; index < count; index += 1) {',
    '  await __internals.settleFact({',
    '    workspace,',
    "    claim: `${tag} 事实 ${index}`,",
    "    evidence: `probe:${tag}:${index}`,",
    "    grade: 'measured',",
    "    by: `ses_${tag}`,",
    '    now: Date.now() + index',
    '  });',
    '}'
  ].join('\n'),
  'utf8'
);
const { spawn } = await import('node:child_process');
const runChild = (workspaceDir, tag) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childScript], {
      env: {
        ...process.env,
        COLLAB_FACTS_FILE: raceFile,
        CHILD_WS: workspaceDir,
        CHILD_TAG: tag,
        CHILD_COUNT: '25'
      },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    // Resolve on any exit (a refusal is data for the assertion, not a crash):
    // `settleFact` throwing in the child is exactly the "gave up on the lock"
    // case this test exists to keep at zero.
    child.on('exit', code => resolve({ tag, code, stderr }));
    child.on('error', reject);
  });
let refusals = 0;
for (let round = 1; round <= 3; round += 1) {
  if (existsSync(raceFile)) unlinkSync(raceFile);
  const runs = await Promise.all([
    runChild(raceWorkspaceA, 'A'),
    runChild(raceWorkspaceB, 'B'),
    runChild(raceWorkspaceC, 'C')
  ]);
  const failedRuns = runs.filter(run => run.code !== 0);
  refusals += failedRuns.length;
  const race = internals.readLedger(raceFile);
  const counts = [raceWorkspaceA, raceWorkspaceB, raceWorkspaceC].map(
    dir => race.workspaces[dir]?.facts.length ?? 0
  );
  const lost = counts.reduce((sum, count) => sum + Math.max(0, 25 - count), 0);
  expect(
    `round ${round}: wsA/wsB/wsC = 25/25/25, lost=0, refusals ${refusals}/9`,
    counts.every(count => count === 25),
    `counts=${counts.join('/')} lost=${lost}${
      failedRuns.length ? ` · ${failedRuns.map(run => `${run.tag}:${run.code}:${run.stderr.trim().split('\n')[0]}`).join(' | ')}` : ''
    }`
  );
}
expect('9 child runs across 3 rounds, 0 lock refusals', refusals === 0, `${refusals}/9`);

// ============================================================ 16) lock mechanics
section('16) review: attempt budget is fully consumed + release never steals');
expect(
  'attempts = delays.length + 1 (the same convention as withRetry)',
  internals.FILE_LOCK_ATTEMPTS === internals.FILE_LOCK_RETRY_DELAYS_MS.length + 1 &&
    internals.FILE_LOCK_ATTEMPTS === 4,
  `${internals.FILE_LOCK_ATTEMPTS} attempts / ${JSON.stringify(internals.FILE_LOCK_RETRY_DELAYS_MS)}`
);
const heldFile = join(root, 'held-ledger.json');
const heldLock = `${heldFile}.lock`;
writeFileSync(heldLock, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'foreign-holder' }), 'utf8');
const slept = [];
let callbackRan = false;
let refusal;
try {
  await internals.withFileLock(
    heldFile,
    () => {
      callbackRan = true;
      return 'never';
    },
    {
      // Disable the final bounded wait so the assertion sees exactly the three
      // configured backoffs, then the readable refusal.
      waitMs: 0,
      sleep: async delay => {
        slept.push(delay);
      }
    }
  );
} catch (error) {
  refusal = String(error?.message ?? error);
}
expect(
  'every configured backoff delay is really slept (50 / 200 / 800)',
  JSON.stringify(slept) === JSON.stringify(internals.FILE_LOCK_RETRY_DELAYS_MS),
  JSON.stringify(slept)
);
expect('the callback never runs while the lock is held', callbackRan === false, String(callbackRan));
expect('exhausting the budget is a readable refusal', /账本正被另一个进程写入/.test(refusal ?? ''), refusal);
unlinkSync(heldLock);

// A holder that releases *after* the configured backoff must be waited for, not
// refused: the final wait is a queue, not one last sample.
const lateFile = join(root, 'late-ledger.json');
const lateHolder = internals.tryAcquireFileLock(lateFile);
let lateAcquired = false;
const lateWaiter = internals.withFileLock(
  lateFile,
  () => {
    lateAcquired = true;
    return 'ok';
  },
  { waitMs: 3000, pollMs: 20 }
);
const lateRelease = new Promise(resolve =>
  setTimeout(() => {
    lateHolder?.release();
    resolve();
  }, 1200)
);
const [lateValue] = await Promise.all([lateWaiter, lateRelease]);
expect(
  'a lock held past the backoff budget is waited for (event-driven), not refused',
  lateValue === 'ok' && lateAcquired,
  String(lateValue)
);

const releaseFile = join(root, 'release-ledger.json');
const releaseLock = `${releaseFile}.lock`;
const handle = internals.tryAcquireFileLock(releaseFile);
expect('a lock can be acquired for the release test', Boolean(handle), handle ? handle.lockPath : '(none)');
// (a) the open → write window / a torn write: unreadable ⇒ never delete.
writeFileSync(releaseLock, '', 'utf8');
handle?.release();
expect('release does not delete an unreadable lock', existsSync(releaseLock), 'file still there');
// (b) another owner's token ⇒ never delete.
writeFileSync(releaseLock, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'someone-else' }), 'utf8');
handle?.release();
expect('release does not delete a lock holding another token', existsSync(releaseLock), 'file still there');
// (c) our own token ⇒ delete (the normal path must still work).
writeFileSync(
  releaseLock,
  JSON.stringify({ pid: process.pid, at: Date.now(), token: handle?.token ?? '' }),
  'utf8'
);
handle?.release();
expect('release deletes its own lock', !existsSync(releaseLock), 'file removed');

// ============================================================ summary
await cleanup?.();
const failed = checks.filter(check => !check.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed · workspace ${workspace}`);
if (failed.length) {
  console.log('\nfailed:');
  for (const check of failed) console.log(`  ✗ ${check.title}`);
  process.exit(1);
}
