/**
 * 0.9.3 (`11-20-collab-drift`): drift detection + wake conditions + mainline
 * placeholder. Design §7's eleven cases plus the 0.9.2 review's missing
 * truncation branch.
 *
 *   pnpm test                 # builds dist/ first; this file is part of the chain
 *   node test/drift.mjs
 *
 * Everything runs through the built `dist/index.js` with temp paths — no host,
 * no `~/.config/opencode/collab-*`. Clock-sensitive rules are driven through the
 * pure functions (`evaluate` / `wakeExpired`) with an injected `now`, so the
 * 4th/5th turn boundary and the 24h transition do not need real waiting.
 *
 *   1. 4 requests without evidence → no `[drift]`; the **5th** → `[drift]` + `连续 5 轮`
 *   2. 6th request still unanswered → `[drift]` + `[未处置]`
 *   3. `resume {next}` → state=active, counter 0, mainline todo created
 *   4. `resume` without `next` → refused
 *   5. `block {on,reason}` → state=suspended + parkedAt + suspended todo
 *   6. `block` without `on` / `reason` → refused
 *   7. `done` without a mainline next-up → refused
 *   8. `done` with one → accepted (state=done)
 *   9. `suspend` without `wakeWhen` → refused (string and object paths)
 *  10. `wakeWhen.kind:"time"` in the past → refused; future → accepted
 *  11. mission suspended 2.1h → `[drift]`
 *  12. suspended todo 24h+ → status `drifted` (never closed) + `[drift]`
 *  13. a future `time` deadline outranks the 24h fallback
 *  14. mainline close / progress light → lastAdvancedAt moves, counter clears
 *  15. truncation branch: full sections + lowered budget → `[progress]` dropped
 *  16. surface: 26 tools, mission enum grew, legacy string wakeWhen still works
 *  17. review A: advance once, then 5 quiet rounds → `[drift]` on the **5th**
 *      quiet round (the counter must not lag after an advance)
 *  18. review B: block → 25h → `[drift]` → resume → the next round is quiet
 *      (no zombie suspended row re-entering `[drift]` forever)
 *
 * Exits 1 if any check fails.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
const root = mkdtempSync(join(base, 'collab-drift-'));
const workspace = join(root, 'workspace');
const contractDir = join(root, 'contract');
mkdirSync(join(workspace, '.trellis', 'tasks'), { recursive: true });
mkdirSync(join(workspace, '.trellis', '.runtime', 'sessions'), { recursive: true });

// Every global path is read once at import: pin them *before* importing.
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
const contexts = new Map();
const sessions = new Map();
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
      return structuredClone(sessions.get(sessionID) ?? { id: sessionID, agent: 'build', title: 'test' });
    },
    async list() {
      return { data: [] };
    },
    async context({ sessionID }) {
      return structuredClone(contexts.get(sessionID) ?? []);
    },
    async create(input = {}) {
      const info = { id: `ses_spawn_${sessions.size + 1}`, agent: input.agent ?? 'build', title: input.title ?? '' };
      sessions.set(info.id, info);
      return structuredClone(info);
    },
    async remove() {},
    async update() {},
    async switchAgent() {},
    async prompt() {
      return { id: 'msg_1', delivery: 'queue' };
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
const call = async (name, input, sid = 'ses_main') => (await tool(name).execute(input, { sessionID: sid })).content;
const callError = async (name, input, sid = 'ses_main') => {
  try {
    await call(name, input, sid);
    return undefined;
  } catch (error) {
    return String(error?.message ?? error);
  }
};
const ask = async (sid, messages = []) => {
  const event = { sessionID: sid, agent: 'build', messages, system: [] };
  await hooks.context(event);
  return event.system.map(block => String(block?.text ?? '')).join('\n\n');
};
const driftLine = text => text.split('\n').find(line => line.startsWith('[drift]')) ?? '';
const contractOf = sid => JSON.parse(readFileSync(internals.contractFile(sid), 'utf8'));
const writeContract = contract => internals.writeContract(contract);
const seed = (sid, mutate) => {
  const base0 = internals.emptyContract(sid);
  writeContract(mutate(base0));
  return base0;
};

// ============================================ 1) 4 quiet rounds, 5th triggers
section('1) 4 requests without evidence are quiet; the 5th carries [drift]');
await call('collab_mission', { action: 'confirm', oneLine: '排钟 B4 接线', by: 'human' }, 'ses_five');
const quiet = [];
for (let round = 0; round < 4; round += 1) quiet.push(await ask('ses_five'));
expect(
  'requests 1–4 never contain [drift]',
  quiet.every(text => !text.includes('[drift]')),
  quiet.map((text, index) => `#${index + 1}:${text.includes('[drift]')}`).join(' ')
);
const fifth = await ask('ses_five');
const fifthLine = driftLine(fifth);
expect('the 5th request carries [drift]', Boolean(fifthLine), fifthLine || '(none)');
expect('the line names 5 consecutive rounds', /连续 5 轮无主线动作/.test(fifthLine), fifthLine);
expect('the line offers the three-choice', /三选一：resume \/ block \/ done/.test(fifthLine), fifthLine);
expect('the first reminder is not marked [未处置]', !fifthLine.includes('[未处置]'), fifthLine);
expect(
  'the stored counter reached 5 after the 5th request',
  internals.readContract('ses_five').turn.noAdvanceTurns === 5,
  `stored=${internals.readContract('ses_five').turn.noAdvanceTurns}`
);

// ============================================ 2) 6th round: [未处置]
section('2) an unanswered drift is repeated with [未处置]');
const sixth = await ask('ses_five');
const sixthLine = driftLine(sixth);
expect('the 6th request still carries [drift]', Boolean(sixthLine), sixthLine || '(none)');
expect('it is marked [未处置]', sixthLine.includes('[未处置]'), sixthLine);

// ============================================ 3) resume
section('3) resume {next} answers the drift and queues the next step');
const resumed = await call('collab_mission', { action: 'resume', next: '接线 M3 双写验证', confirm: true }, 'ses_five');
const afterResume = contractOf('ses_five');
expect(
  'state=active, counter and drift marker cleared',
  afterResume.mission.state === 'active' &&
    afterResume.turn.noAdvanceTurns === 0 &&
    Number(afterResume.turn.driftAt) === 0,
  JSON.stringify({ state: afterResume.mission.state, turn: afterResume.turn })
);
const mainline = afterResume.todos.find(todo => todo.kind === 'mainline' && todo.subject === '接线 M3 双写验证');
expect(
  'a mainline todo was created as doing',
  Boolean(mainline) && mainline.status === 'doing',
  afterResume.todos.map(todo => `${todo.id}:${todo.status}:${todo.subject}`).join(' | ')
);
expect('resume names the todo it wrote', /已 resume.*mainline 待办 T\d+/.test(resumed), resumed.split('\n')[0]);
const afterResumeText = await ask('ses_five');
expect('the next request is quiet again', !afterResumeText.includes('[drift]'), driftLine(afterResumeText) || '(none)');

// ============================================ 4) resume without next
section('4) resume without next is refused');
const resumeNoNext = await callError('collab_mission', { action: 'resume', confirm: true }, 'ses_five');
expect('resume without next → refused', /resume 必填 next/.test(resumeNoNext ?? ''), resumeNoNext);

// ============================================ 5) block
section('5) block {on,reason} parks the mainline with a wake condition');
const blocked = await call(
  'collab_mission',
  { action: 'block', on: 'ses_peer', reason: '等 owner 批 D3', confirm: true },
  'ses_block'
);
const afterBlock = contractOf('ses_block');
const parkedTodo = afterBlock.todos.find(todo => todo.status === 'suspended');
expect(
  'state=suspended with a parkedAt stamp',
  afterBlock.mission.state === 'suspended' && Number(afterBlock.mission.parkedAt) > 0,
  JSON.stringify({ state: afterBlock.mission.state, parkedAt: afterBlock.mission.parkedAt })
);
expect(
  'a suspended mainline todo waits on the blocker with wakeWhen.kind=manual',
  Boolean(parkedTodo) &&
    parkedTodo.kind === 'mainline' &&
    parkedTodo.blockingOn === 'ses_peer' &&
    parkedTodo.wakeWhen?.kind === 'manual',
  JSON.stringify(parkedTodo)
);
expect('block names the blocked-on session', /已 block.*等 ses_peer/.test(blocked), blocked.split('\n')[0]);
await call('collab_mission', { action: 'block', on: 'ses_peer', reason: '还在等 D3', confirm: true }, 'ses_block');
expect(
  'a second block reuses the park row (no unbounded growth)',
  contractOf('ses_block').todos.filter(todo => todo.status === 'suspended').length === 1,
  contractOf('ses_block').todos.map(todo => `${todo.id}:${todo.status}`).join(' | ')
);

// ============================================ 6) block validation
section('6) block without on / reason is refused');
const blockNoOn = await callError('collab_mission', { action: 'block', reason: '等批', confirm: true }, 'ses_block2');
expect('block without on → refused', /block 必填 on/.test(blockNoOn ?? ''), blockNoOn);
const blockBadOn = await callError(
  'collab_mission',
  { action: 'block', on: 'owner', reason: '等批', confirm: true },
  'ses_block2'
);
expect('on must be me / ses_…', /on 必须是 "me" 或一个 ses_…/.test(blockBadOn ?? ''), blockBadOn);
const blockNoReason = await callError(
  'collab_mission',
  { action: 'block', on: 'ses_peer', confirm: true },
  'ses_block2'
);
expect('block without reason → refused', /block 必填 reason/.test(blockNoReason ?? ''), blockNoReason);

// ============================================ 7-8) done needs a next-up
section('7-8) done requires an existing mainline open todo');
await call('collab_mission', { action: 'confirm', oneLine: '主线完结测试', by: 'human' }, 'ses_done');
const doneEmpty = await callError('collab_mission', { action: 'done', confirm: true }, 'ses_done');
expect('done with no next-up → refused', /next-up 待办/.test(doneEmpty ?? ''), doneEmpty);
expect('the refusal gives the copyable todo add', /collab_todo \{ action:"add"/.test(doneEmpty ?? ''), doneEmpty);
await call('collab_todo', { action: 'add', subject: 'next-up: 接手 11-21', confirm: true }, 'ses_done');
const doneOk = await call('collab_mission', { action: 'done', confirm: true }, 'ses_done');
expect(
  'done with a mainline open todo → state=done',
  /已 done/.test(doneOk) && contractOf('ses_done').mission.state === 'done',
  `${doneOk.split('\n')[0]} / ${contractOf('ses_done').mission.state}`
);
const nextUpDoing = internals.emptyContract('ses_done2');
writeContract({
  ...nextUpDoing,
  todos: [
    { id: 'T1', kind: 'mainline', subject: 'doing only', status: 'doing', blockingOn: 'me', since: 1, updatedAt: 1 }
  ]
});
const doneDoing = await callError('collab_mission', { action: 'done', confirm: true }, 'ses_done2');
expect('a doing todo is not a next-up (status must be open)', /next-up 待办/.test(doneDoing ?? ''), doneDoing);
const doneSet = await callError('collab_mission', { action: 'set', state: 'done' }, 'ses_done2');
expect('set {state:"done"} is refused the same way', /next-up 待办/.test(doneSet ?? ''), doneSet);

// ============================================ 9-10) suspend / wakeWhen
section('9-10) suspend needs a wake condition; a time deadline must be in the future');
await call('collab_todo', { action: 'add', subject: '要挂起的事', confirm: true }, 'ses_wake');
const suspendNoWake = await callError('collab_todo', { action: 'suspend', id: 'T1', confirm: true }, 'ses_wake');
expect('suspend without wakeWhen → refused', /suspend 必填 wakeWhen/.test(suspendNoWake ?? ''), suspendNoWake);
const suspendEmpty = await callError(
  'collab_todo',
  { action: 'suspend', id: 'T1', wakeWhen: { kind: 'reply' }, confirm: true },
  'ses_wake'
);
expect('wakeWhen.kind="reply" without ref → refused', /必须给 ref/.test(suspendEmpty ?? ''), suspendEmpty);
const suspendPast = await callError(
  'collab_todo',
  { action: 'suspend', id: 'T1', wakeWhen: { kind: 'time', at: Date.now() - 60_000 }, confirm: true },
  'ses_wake'
);
expect('wakeWhen.kind="time" in the past → refused', /已过期/.test(suspendPast ?? ''), suspendPast);
const futureAt = Date.now() + 3_600_000;
const suspendFuture = await call(
  'collab_todo',
  { action: 'suspend', id: 'T1', wakeWhen: { kind: 'time', at: futureAt }, confirm: true },
  'ses_wake'
);
const wakeTodo = contractOf('ses_wake').todos[0];
expect(
  'a future time deadline is stored as an object',
  /已挂起 T1/.test(suspendFuture) &&
    wakeTodo.wakeWhen?.kind === 'time' &&
    Math.abs(Number(wakeTodo.wakeWhen.at) - futureAt) < 1000,
  JSON.stringify(wakeTodo.wakeWhen)
);
const wakeInjection = await ask('ses_wake');
expect(
  '[todo] renders the structured wake condition as a local deadline',
  /suspended\(到期 \d\d-\d\d \d\d:\d\d\)/.test(wakeInjection) &&
    !wakeInjection.includes('等 至') &&
    !/T\d\d:\d\d/.test(wakeInjection),
  wakeInjection.split('\n').find(line => line.includes('T1')) ?? '(no T1)'
);

// ============================================ 11) suspended mission 2.1h
section('11) a mission parked 2.1h triggers [drift]');
const parkedHours = 2.1;
seed('ses_parked', contract => ({
  ...contract,
  mission: {
    ...contract.mission,
    oneLine: '被挂起的主线',
    confirmedBy: 'human',
    confirmedAt: 1,
    state: 'suspended',
    parkedAt: Date.now() - parkedHours * 3_600_000
  },
  todos: [
    {
      id: 'T1',
      kind: 'mainline',
      subject: '等窗口',
      status: 'suspended',
      blockingOn: 'ses_peer',
      wakeWhen: { kind: 'manual' },
      parkedAt: Date.now() - parkedHours * 3_600_000,
      since: Date.now() - parkedHours * 3_600_000,
      updatedAt: Date.now() - parkedHours * 3_600_000
    }
  ]
}));
const parkedText = await ask('ses_parked');
const parkedLine = driftLine(parkedText);
expect('the parked mission is drift', /主线已挂起 2\.1h 未醒/.test(parkedLine), parkedLine);
expect('[mission] shows the parked age', /状态 suspended（2\.1h 未醒）/.test(parkedText), parkedText.split('\n')[1]);

// ============================================ 12) 24h fallback → drifted
section('12) a suspended todo parked 25h becomes drifted (not closed)');
const oldAt = Date.now() - 25 * 3_600_000;
seed('ses_old', contract => ({
  ...contract,
  mission: { ...contract.mission, oneLine: '旧挂起', confirmedBy: 'human', confirmedAt: 1 },
  todos: [
    {
      id: 'T1',
      kind: 'mainline',
      subject: '等某个回复',
      status: 'suspended',
      blockingOn: 'ses_e176',
      wakeWhen: { kind: 'reply', ref: 'ses_e176' },
      parkedAt: oldAt,
      since: oldAt,
      updatedAt: oldAt
    }
  ]
}));
const oldText = await ask('ses_old');
const oldLine = driftLine(oldText);
expect('the 25h-old suspension is drift', /T1 已挂起 1\.0d 未醒（等 ses_e176 回复）/.test(oldLine), oldLine);
const oldTodo = contractOf('ses_old').todos[0];
expect('the todo is marked drifted, never closed', oldTodo.status === 'drifted', oldTodo.status);
expect(
  'it stays visible in [todo] (the next round renders 挂起到期)',
  oldText.includes('T1'),
  oldText.split('\n').find(line => line.includes('T1')) ?? '(none)'
);
const oldNext = await ask('ses_old');
expect(
  'the next round repeats the reason as [未处置]',
  driftLine(oldNext).includes('[未处置]') && /T1 已挂起/.test(driftLine(oldNext)),
  driftLine(oldNext)
);
expect(
  'the drifted row is rendered as 挂起到期',
  /T1 .*挂起到期/.test(oldNext),
  oldNext.split('\n').find(line => line.includes('T1')) ?? '(none)'
);

// ============================================ 13) future deadline wins
section('13) a future time deadline outranks the 24h fallback');
seed('ses_future', contract => ({
  ...contract,
  mission: { ...contract.mission, oneLine: '未来截止', confirmedBy: 'human', confirmedAt: 1 },
  todos: [
    {
      id: 'T1',
      kind: 'collab',
      subject: '等窗口开放',
      status: 'suspended',
      wakeWhen: { kind: 'time', at: Date.now() + 6 * 3_600_000 },
      parkedAt: oldAt,
      since: oldAt,
      updatedAt: oldAt
    }
  ]
}));
const futureText = await ask('ses_future');
expect('no drift while the recorded deadline is still ahead', !futureText.includes('[drift]'), driftLine(futureText) || '(none)');
expect('the todo stays suspended', contractOf('ses_future').todos[0].status === 'suspended', contractOf('ses_future').todos[0].status);
// …and the 24h fallback still applies to a *manual* park of the same age.
seed('ses_future_manual', contract => ({
  ...contract,
  mission: { ...contract.mission, oneLine: '人工挂起', confirmedBy: 'human', confirmedAt: 1 },
  todos: [
    {
      id: 'T1',
      kind: 'collab',
      subject: '等人工',
      status: 'suspended',
      wakeWhen: '等 owner 回 D3',
      parkedAt: oldAt,
      since: oldAt,
      updatedAt: oldAt
    }
  ]
}));
const manualText = await ask('ses_future_manual');
expect(
  'a legacy string wakeWhen is accepted and falls back after 24h',
  driftLine(manualText).includes('T1') && /等 owner 回 D3/.test(driftLine(manualText)),
  driftLine(manualText)
);
expect(
  'the legacy string renders without a doubled 等',
  /suspended\(等 owner 回 D3\)/.test(manualText),
  manualText.split('\n').find(line => line.includes('T1')) ?? '(none)'
);

// ============================================ 14) evidence clears the counter
section('14) mainline close / progress light move lastAdvancedAt and clear the counter');
writeFileSync(join(workspace, 'a.txt'), 'a\n');
const git = args => spawnSync('git', args, { cwd: workspace, encoding: 'utf8', timeout: 10_000 });
git(['init', '-q']);
git(['config', 'user.email', 'harness@example.test']);
git(['config', 'user.name', 'harness']);
git(['add', 'a.txt']);
git(['commit', '-qm', 'init']);
const sha = git(['rev-parse', 'HEAD']).stdout.trim();

await call('collab_todo', { action: 'add', subject: '主线工作', confirm: true }, 'ses_advance');
for (let round = 0; round < 3; round += 1) await ask('ses_advance');
const beforeClose = contractOf('ses_advance').turn;
expect('3 quiet requests accumulate noAdvanceTurns', beforeClose.noAdvanceTurns === 3, String(beforeClose.noAdvanceTurns));
await call('collab_todo', { action: 'close', id: 'T1', evidence: 'file:a.txt:1', confirm: true }, 'ses_advance');
const afterClose = contractOf('ses_advance');
expect(
  'closing a mainline todo stamps lastAdvancedAt and clears the counter',
  afterClose.turn.lastAdvancedAt > 0 && afterClose.turn.noAdvanceTurns === 0,
  JSON.stringify(afterClose.turn)
);
await call('collab_progress', { action: 'add', milestone: 'M1', title: '双写验证', confirm: true }, 'ses_advance');
await call('collab_progress', { action: 'light', milestone: 'M1', evidence: `commit:${sha}`, confirm: true }, 'ses_advance');
expect(
  'progress light moves plan.lastAdvancedAt too',
  contractOf('ses_advance').plan.lastAdvancedAt > 0 && contractOf('ses_advance').turn.noAdvanceTurns === 0,
  JSON.stringify(contractOf('ses_advance').turn)
);

// ============================================ 15) truncation branch
section('15) truncation: full sections + a lowered budget drops [progress]');
const full = internals.emptyContract('ses_trunc');
full.mission = {
  ...full.mission,
  oneLine: '主线：排钟 B4',
  inScope: ['排钟'],
  outOfScope: ['ws集群实施']
  // unconfirmed → mission renders 3 lines (head + boundary + confirm hint)
};
full.todos = Array.from({ length: 10 }, (_, index) => ({
  id: `T${index + 1}`,
  kind: 'mainline',
  subject: `合成待办 ${index + 1}`,
  status: 'open',
  blockingOn: 'me',
  since: 1000,
  updatedAt: 1000
}));
full.plan = {
  milestones: [
    { id: 'M1', title: '一', done: true, at: 1000 },
    { id: 'M2', title: '二', done: false },
    { id: 'M3', title: '三', done: false }
  ],
  lastAdvancedAt: 1000
};
const threeDrift = ['[drift] 连续 5 轮无主线动作（3.2h）→ 三选一：resume / block / done', '  T4 已挂起 24.3h 未醒', '  多余第三行（应被 section 上限截掉）'];
const defaultRender = internals.renderInjection({
  contract: full,
  mission: full.mission,
  drift: threeDrift,
  now: 7_200_000
});
expect(
  'with the production budget nothing is dropped (3+4+2+2 = 11 ≤ 12)',
  defaultRender.dropped.length === 0 && defaultRender.lines.length === 11,
  `${defaultRender.lines.length} lines, dropped=${defaultRender.dropped.join(',')}`
);
expect(
  'the drift section is capped at 2 lines (the 3rd is cut)',
  defaultRender.lines.filter(line => line.includes('多余第三行')).length === 0,
  defaultRender.lines.filter(line => line.trim().length).length + ' non-empty lines'
);
const truncated = internals.renderInjection({
  contract: full,
  mission: full.mission,
  drift: threeDrift,
  now: 7_200_000,
  maxLines: 10
});
expect(
  'a lowered budget really triggers the drop branch',
  truncated.dropped.length === 1 && truncated.dropped[0] === 'progress',
  `dropped=${truncated.dropped.join(',')}`
);
expect(
  'the dropped section is [progress]; mission/todo/drift survive',
  JSON.stringify(truncated.sections) === JSON.stringify(['mission', 'todo', 'drift']) &&
    !truncated.lines.join('\n').includes('[progress]'),
  truncated.sections.join(',')
);
expect(
  'a section is dropped whole, never half rendered',
  truncated.lines.length === 9 && truncated.lines.some(line => line.startsWith('[drift]')),
  `${truncated.lines.length} lines`
);

// ============================================ 16) surface + pure functions
section('16) surface unchanged (26 tools) + pure wake/evaluate helpers');
expect('26 tools are registered', tools.length === 26, `${tools.length} tools`);
expect(
  'collab_mission grew three actions, collab_todo kept its five',
  JSON.stringify(tool('collab_mission').input.properties.action.enum) ===
    JSON.stringify(['get', 'set', 'confirm', 'resume', 'block', 'done']) &&
    JSON.stringify(tool('collab_todo').input.properties.action.enum) ===
      JSON.stringify(['add', 'close', 'defer', 'suspend', 'list'])
);
expect(
  'no new tool was added (drift is behaviour, not a tool)',
  !tools.some(definition => /drift|wake/.test(definition.name)),
  tools.map(definition => definition.name).join(',')
);
expect('PLUGIN_VERSION is 0.9.3', internals.PLUGIN_VERSION === '0.9.3' && pkg.version === '0.9.3', `${internals.PLUGIN_VERSION} vs ${pkg.version}`);
expect(
  'the drift threshold is 5 and the fallback 24h',
  internals.DRIFT_NO_ADVANCE_TURNS === 5 && internals.SUSPEND_FALLBACK_MS === 24 * 3_600_000,
  `${internals.DRIFT_NO_ADVANCE_TURNS} / ${internals.SUSPEND_FALLBACK_MS}`
);
expect(
  'wakeExpired: time is due at its deadline, reply only after 24h',
  internals.wakeExpired({ kind: 'time', at: 1000 }, 0, 1500).expired === true &&
    internals.wakeExpired({ kind: 'time', at: 5000 }, 0, 1500).expired === false &&
    internals.wakeExpired({ kind: 'reply', ref: 'ses_x' }, 1500 - 23 * 3_600_000, 1500).expired === false &&
    internals.wakeExpired({ kind: 'reply', ref: 'ses_x' }, 1500 - 25 * 3_600_000, 1500).expired === true
);
const legacy = internals.parseWakeWhen('等 owner 回 D3', Date.now());
expect('a legacy string parses as a manual park', legacy.ok === true && typeof legacy.wake === 'string', JSON.stringify(legacy));
const stampedFive = internals.evaluateDrift(
  (() => {
    const contract = internals.emptyContract('ses_pure');
    // `stampTurn` already counted this request: 5 means the 5th quiet request.
    contract.turn = { ...contract.turn, noAdvanceTurns: 5 };
    return contract;
  })(),
  1000
);
expect(
  'evaluate reads the stamped counter as-is: 5 → drifted, no extra +1',
  stampedFive.drifted === true && stampedFive.noAdvanceTurns === 5 && stampedFive.lines.length === 1,
  JSON.stringify({ drifted: stampedFive.drifted, noAdvanceTurns: stampedFive.noAdvanceTurns, lines: stampedFive.lines })
);
const stampedFour = internals.evaluateDrift(
  (() => {
    const contract = internals.emptyContract('ses_pure4');
    contract.turn = { ...contract.turn, noAdvanceTurns: 4 };
    return contract;
  })(),
  1000
);
expect('the 4th quiet request (counter 4) is not drifted', stampedFour.drifted === false, JSON.stringify(stampedFour.reasons));

// ================================== 17) review A: advance then 5 quiet rounds
section('17) review A: after an advance the 5th quiet round is the trigger');
await call('collab_mission', { action: 'confirm', oneLine: '推进后再静默', by: 'human' }, 'ses_adv_quiet');
await ask('ses_adv_quiet'); // request 0 — stamped, then advanced below
await call('collab_progress', { action: 'add', milestone: 'M1', title: '一次推进', confirm: true }, 'ses_adv_quiet');
await call(
  'collab_progress',
  { action: 'light', milestone: 'M1', evidence: `commit:${sha}`, confirm: true },
  'ses_adv_quiet'
);
expect(
  'the advance cleared the counter',
  contractOf('ses_adv_quiet').turn.noAdvanceTurns === 0,
  JSON.stringify(contractOf('ses_adv_quiet').turn)
);
const advQuiet = [];
for (let round = 0; round < 4; round += 1) advQuiet.push(await ask('ses_adv_quiet'));
expect(
  'quiet rounds #1–#4 after the advance carry no [drift]',
  advQuiet.every(text => !text.includes('[drift]')),
  advQuiet.map((text, index) => `#${index + 1}:${text.includes('[drift]')}`).join(' ')
);
expect(
  'the quiet-run counter is not lagging (stored 4 after 4 quiet rounds)',
  contractOf('ses_adv_quiet').turn.noAdvanceTurns === 4,
  String(contractOf('ses_adv_quiet').turn.noAdvanceTurns)
);
const advFifth = await ask('ses_adv_quiet');
expect(
  'quiet round #5 triggers [drift] naming 5 rounds (not 4, not 6)',
  /连续 5 轮无主线动作/.test(driftLine(advFifth)),
  driftLine(advFifth) || '(none)'
);

// ================================== 18) review B: block → 25h → resume clears
section('18) review B: block → 25h → [drift] → resume → the next round is quiet');
await call('collab_todo', { action: 'add', subject: '主线在做的事', status: 'doing', confirm: true }, 'ses_zombie');
await call(
  'collab_mission',
  { action: 'block', on: 'ses_peer', reason: '等 owner 批 D3', confirm: true },
  'ses_zombie'
);
const zombie = contractOf('ses_zombie');
const parkIDs = zombie.todos.filter(todo => todo.status === 'suspended').map(todo => todo.id);
expect('block created its own park row next to the doing todo', parkIDs.length === 1 && parkIDs[0] === 'T2', parkIDs.join(','));
const aged = Date.now() - 25 * 3_600_000;
writeContract({
  ...zombie,
  mission: { ...zombie.mission, parkedAt: aged },
  todos: zombie.todos.map(todo =>
    todo.status === 'suspended' ? { ...todo, parkedAt: aged, updatedAt: aged } : todo
  )
});
const zombieDrift = await ask('ses_zombie');
expect(
  'the 25h park enters [drift] (line 2 names the expired row)',
  /T2 已挂起 1\.0d 未醒/.test(zombieDrift),
  zombieDrift.split('\n').filter(line => line.includes('[drift]') || line.includes('T2')).join(' | ')
);
expect(
  'the park row is drifted (not closed) before resume',
  contractOf('ses_zombie').todos.find(todo => todo.id === 'T2')?.status === 'drifted',
  contractOf('ses_zombie').todos.map(todo => `${todo.id}:${todo.status}`).join(' | ')
);
await call('collab_mission', { action: 'resume', next: '继续接线', confirm: true }, 'ses_zombie');
expect(
  'resume closes the park row with evidence=resume',
  contractOf('ses_zombie').todos.find(todo => todo.id === 'T2')?.status === 'closed' &&
    contractOf('ses_zombie').todos.find(todo => todo.id === 'T2')?.evidence === 'resume',
  JSON.stringify(contractOf('ses_zombie').todos.find(todo => todo.id === 'T2'))
);
const zombieAfter = await ask('ses_zombie');
expect(
  'the next round has NO [drift] (no zombie suspended row)',
  !zombieAfter.includes('[drift]'),
  driftLine(zombieAfter) || '(none)'
);
expect(
  'the mainline todo was updated to the resumed next step',
  contractOf('ses_zombie').todos.some(
    todo => todo.id === 'T1' && todo.status === 'doing' && todo.subject === '继续接线'
  ),
  contractOf('ses_zombie').todos.map(todo => `${todo.id}:${todo.status}:${todo.subject}`).join(' | ')
);

// ------------------------------------------------------------------- result
await Promise.resolve(cleanup?.()).catch(() => {});
const failed = checks.filter(check => !check.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log('failed:');
  for (const check of failed) console.log(`  ✗ ${check.title}`);
  process.exit(1);
}
