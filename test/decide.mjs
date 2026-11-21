/**
 * 0.9.5 (`11-20-collab-decide`): the decision ledger (open / answer / supersede /
 * list) and the role four-tuple. Design §8's ten cases plus the conflict
 * escalation, the read-only thread degradation, the `[role]` / `[decide]`
 * injections and the single `decision:` resolver.
 *
 *   pnpm test                 # builds dist/ first; this file is part of the chain
 *   node test/decide.mjs
 *
 * Everything runs through the built `dist/index.js` with temp paths — no host,
 * no `~/.config/opencode/collab-*` (every global path is pinned *before* the
 * import because the constants are read once at module load).
 *
 *   1. surface: 29 tools, `collab_decide` once, four actions, 0.9.5
 *   2. thread path: open → list sees it (no hand-off record involved)
 *   3. bid path: open works too, and the two keys never share a `D#` namespace
 *   4. only the owner may answer (a non-owner is refused, nothing written)
 *   5. an answered item cannot be answered again (supersede first)
 *   6. same question (case / whitespace / punctuation variant) → refused with
 *      the existing `D#` + owner (the mutation target of this task)
 *   7. 4th open → refused (D9 = 3); supersede releases the slot
 *   8. owner defaults to the contract decider, then to the order's sender
 *   9. role derivation: hand-off requester/implementer → the four-tuple; the
 *      injection shows `[role:…]` and the two behavioural hints
 *  10. conflict → one open decision (owner = decider) + the thread goes
 *      read-only until it is answered; then messages flow again
 *  11. `[decide]` injection: one line, open items only, owner + age
 *  12. `decision:` evidence goes through ONE resolver: unanswered → refused,
 *      answered → ok, hand-off `decisions[]` still readable (compatibility)
 *
 * Exits 1 if any check fails.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
const root = mkdtempSync(join(base, 'collab-decide-'));
const workspace = join(root, 'workspace');
const contractDir = join(root, 'contract');
const decisionsDir = join(root, 'decisions');
mkdirSync(workspace, { recursive: true });
mkdirSync(contractDir, { recursive: true });
mkdirSync(decisionsDir, { recursive: true });

// Every global path is read once at import: pin them *before* importing.
process.env.COLLAB_DECISIONS_DIR = decisionsDir;
process.env.COLLAB_CONTRACT_DIR = contractDir;
process.env.COLLAB_FACTS_FILE = join(root, 'collab-facts.json');
process.env.COLLAB_GLOSSARY_FILE = join(root, 'collab-glossary.json');
process.env.COLLAB_MESSAGES_FILE = join(root, 'collab-messages.jsonl');
process.env.COLLAB_DB_FILE = join(root, 'collab.db');
process.env.COLLAB_BROADCAST_DIR = join(root, 'broadcast');
process.env.COLLAB_THREAD_INDEX_FILE = join(root, 'collab-threads.json');
process.env.COLLAB_CONFIG = join(root, 'collab.json');
// 0.9.6: one prompt per send (the pacing switches are covered by test/pacing.mjs).
writeFileSync(process.env.COLLAB_CONFIG, JSON.stringify({ windowMs: 0, suppressNoDelta: false }));
process.env.COLLAB_PACING_FILE = join(root, 'collab-pacing.json');
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
  ['ses_me', { id: 'ses_me', agent: 'build', title: 'decide sender' }],
  ['ses_peer', { id: 'ses_peer', agent: 'build', title: 'decide peer' }]
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
      return structuredClone(sessions.get(sessionID) ?? { id: sessionID, agent: 'build', title: 'test' });
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
const ask = async (sid, messages = []) => {
  const event = { sessionID: sid, agent: 'build', messages, system: [] };
  await hooks.context(event);
  return event.system.map(block => String(block?.text ?? '')).join('\n\n');
};
const decide = (input, sid = 'ses_me') => call('collab_decide', input, sid);
const decideError = (input, sid = 'ses_me') => callError('collab_decide', input, sid);
const readFileForKey = key => internals.readDecisions(key);
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

const THREAD = 't_decide_thread';
const THREAD_REMOTE = 't_decide_remote';

// ============================================================ 1) surface
section('1) surface: 29 tools + collab_decide');
expect(
  'PLUGIN_VERSION / package.json agree (0.9.6)',
  internals.PLUGIN_VERSION === pkg.version && pkg.version === '0.9.6',
  `${internals.PLUGIN_VERSION} vs ${pkg.version}`
);
expect('29 tools are registered', tools.length === 29, `${tools.length} tools`);
expect(
  'collab_decide is registered exactly once',
  tools.filter(definition => definition.name === 'collab_decide').length === 1,
  `${tools.filter(definition => definition.name === 'collab_decide').length} registration(s)`
);
expect(
  'collab_decide actions: open | answer | supersede | list',
  JSON.stringify(tool('collab_decide').input.properties.action.enum) ===
    JSON.stringify(['open', 'answer', 'supersede', 'list']),
  JSON.stringify(tool('collab_decide').input.properties.action.enum)
);
expect(
  'the decision ledger path is isolated (no real ~/.config write)',
  internals.decisionsDir() === decisionsDir && internals.decisionFile(THREAD).startsWith(decisionsDir),
  internals.decisionFile(THREAD)
);

// ============================================================ 2) thread path
section('2) thread path: open on a thread with no hand-off record');
const firstOpen = await decide({
  action: 'open',
  key: THREAD,
  question: '退出码用 2 还是 3',
  options: ['用 2（沿用旧约定）', '用 3（新约定）'],
  owner: 'ses_me',
  confirm: true
});
expect('open succeeds and names D1', /已开决策 D1/.test(firstOpen), firstOpen.split('\n')[0]);
expect('the ledger file exists (lazy creation, one per key)', existsSync(internals.decisionFile(THREAD)), internals.decisionFile(THREAD));
const threadList = await decide({ action: 'list', threadID: THREAD });
expect('collab_decide list { threadID } sees D1', threadList.includes('D1') && threadList.includes('退出码用 2 还是 3'), threadList.split('\n')[1]);
expect('list is read-only (still one item)', readFileForKey(THREAD).items.length === 1, String(readFileForKey(THREAD).items.length));

// ============================================================ 3) bid path
section('3) hand-off path: open on a bid, namespaces do not mix');
const bid = 'b_0123456789abcdef';
internals.writeBroadcast({
  bid,
  scope: 'local',
  workspace,
  issuePath: 'docs/issues/fix-x.md',
  title: 'x',
  expected: 'implement',
  state: 'open',
  attempts: 0,
  skipped: [],
  declines: [],
  seenBy: [],
  askSeen: [],
  reminded: [],
  replies: [],
  from: { sid: 'ses_me', directory: workspace }
});
const bidOpen = await decide(
  { action: 'open', bid, question: '事件型还是断言型', options: ['事件型', '断言型'], confirm: true },
  'ses_me'
);
expect('open succeeds on a bid (D1 in its own namespace)', /已开决策 D1/.test(bidOpen), bidOpen.split('\n')[0]);
const bidList = await decide({ action: 'list', key: bid });
expect('the bid ledger lists its own D1', bidList.includes('事件型还是断言型'), bidList.split('\n')[1]);
expect(
  'the thread and the bid never share items',
  readFileForKey(THREAD).items.length === 1 && readFileForKey(bid).items.length === 1,
  `${readFileForKey(THREAD).items.length} / ${readFileForKey(bid).items.length}`
);
expect(
  'owner defaults to the hand-off requester (from.sid)',
  readFileForKey(bid).items[0].owner === 'ses_me',
  readFileForKey(bid).items[0].owner
);

// ============================================================ 4) same question
section('4) the same question is not a new decision (R3)');
const variant = await decideError(
  {
    action: 'open',
    key: THREAD,
    // Same question as D1 (still open), different case / whitespace / punctuation.
    question: '  退出码用2，还是3？？ ',
    options: ['A', 'B'],
    owner: 'ses_me',
    confirm: true
  },
  'ses_me'
);
expect(
  'a case/whitespace/punctuation variant is refused with the existing D# + owner',
  /已有同问决策 D1 open, wait ses_me/.test(variant ?? ''),
  variant
);
expect('the duplicate open wrote nothing', readFileForKey(THREAD).items.length === 1, String(readFileForKey(THREAD).items.length));

// ============================================================ 5) owner only
section('5) only the owner may answer (R2)');
const notOwner = await decideError({ action: 'answer', key: THREAD, id: 'D1', answer: '用 3', confirm: true }, 'ses_peer');
expect('a non-owner answer is refused with the owner named', /只有 owner ses_me 能 answer/.test(notOwner ?? ''), notOwner);
expect('the refused answer wrote nothing', readFileForKey(THREAD).items[0].status === 'open', readFileForKey(THREAD).items[0].status);
const answered = await decide({ action: 'answer', key: THREAD, id: 'D1', answer: '用 3（新约定）', confirm: true }, 'ses_me');
expect(
  'the owner answer is stored (status + answer + by)',
  /已回答 D1/.test(answered) &&
    readFileForKey(THREAD).items[0].status === 'answered' &&
    readFileForKey(THREAD).items[0].answer === '用 3（新约定）' &&
    readFileForKey(THREAD).items[0].by === 'ses_me',
  answered.split('\n')[0]
);

// ============================================================ 6) answer twice
section('6) an answered decision cannot be answered again');
const twice = await decideError({ action: 'answer', key: THREAD, id: 'D1', answer: '再改一次', confirm: true }, 'ses_me');
expect('a second answer is refused and names supersede', /已回答不可再答/.test(twice ?? '') && /supersede/.test(twice ?? ''), twice);
expect('the first answer is intact', readFileForKey(THREAD).items[0].answer === '用 3（新约定）', readFileForKey(THREAD).items[0].answer);

// ============================================================ 7) open cap
section('7) at most 3 open per key (D9); supersede releases a slot');
await decide({ action: 'open', key: THREAD, question: '第二个问题', options: ['A', 'B'], owner: 'ses_me', confirm: true });
await decide({ action: 'open', key: THREAD, question: '第三个问题', options: ['A', 'B'], owner: 'ses_me', confirm: true });
await decide({ action: 'open', key: THREAD, question: '第三个问题（补充口径）', options: ['A', 'B'], owner: 'ses_me', confirm: true });
const openCount = readFileForKey(THREAD).items.filter(item => item.status === 'open').length;
expect('three open decisions are allowed', openCount === 3, String(openCount));
const fourth = await decideError(
  { action: 'open', key: THREAD, question: '第四个问题', options: ['A', 'B'], owner: 'ses_me', confirm: true },
  'ses_me'
);
expect(
  'the 4th open is refused (上限 3) and says to close one first',
  /已有 3 条 open 决策（上限 3）/.test(fourth ?? '') && /先 answer 或 supersede/.test(fourth ?? ''),
  fourth
);
expect('the refusal wrote nothing', readFileForKey(THREAD).items.length === 4, String(readFileForKey(THREAD).items.length));
const superseded = await decide({ action: 'supersede', key: THREAD, id: 'D2', reason: '问题作废：改用 D3 的方案', confirm: true });
expect(
  'supersede records by + reason and frees the slot',
  /已作废 D2/.test(superseded) &&
    readFileForKey(THREAD).items.find(item => item.id === 'D2')?.status === 'superseded' &&
    readFileForKey(THREAD).items.find(item => item.id === 'D2')?.reason === '问题作废：改用 D3 的方案',
  superseded.split('\n')[0]
);
const afterSlot = await decide({ action: 'open', key: THREAD, question: '第四个问题', options: ['A', 'B'], owner: 'ses_me', confirm: true });
expect('open succeeds again after a supersede (slot released)', /已开决策 D5/.test(afterSlot), afterSlot.split('\n')[0]);
const afterSlotOpen = readFileForKey(THREAD).items.filter(item => item.status === 'open').length;
expect('open count is 3 again', afterSlotOpen === 3, String(afterSlotOpen));

// ============================================================ 8) owner default
section('8) owner defaults: decider peer → order sender');
internals.writeContract({
  ...internals.emptyContract('ses_roles'),
  peers: internals.derivePeerRoles({ requester: 'ses_roles', implementer: 'ses_peer', decider: 'ses_owner' })
});
const deciderOpen = await decide(
  { action: 'open', key: THREAD_REMOTE, question: '由谁裁决', options: ['A', 'B'], confirm: true },
  'ses_roles'
);
expect(
  'owner defaults to the contract decider',
  /owner=ses_owner/.test(deciderOpen) && readFileForKey(THREAD_REMOTE).items[0].owner === 'ses_owner',
  deciderOpen.split('\n')[0]
);
const derived = internals.derivePeerRoles({ requester: 'ses_a', implementer: 'ses_b' });
expect(
  'the four-tuple is derived from a hand-off (requester / implementer / decider / verifier)',
  JSON.stringify(derived.map(peer => `${peer.role}=${peer.sid}`)) ===
    JSON.stringify(['requester=ses_a', 'implementer=ses_b', 'decider=ses_a', 'verifier=ses_a']),
  derived.map(peer => `${peer.role}=${peer.sid}`).join(' / ')
);

// ============================================================ 9) roles
section('9) [role:…] injection (declared, never inferred)');
const implementerText = await ask('ses_roles');
const roleMissionLine = implementerText.split('\n').find(line => line.includes('[role:')) ?? '';
expect(
  'the contract with peers declares [role:requester+verifier] on the mission line',
  roleMissionLine.startsWith('[mission]') && roleMissionLine.includes('[role:requester+verifier]'),
  roleMissionLine || '(none)'
);
expect(
  'the role is one declaration (no second line / section)',
  implementerText.split('\n').filter(line => line.includes('[role:')).length === 1,
  String(implementerText.split('\n').filter(line => line.includes('[role:')).length)
);
internals.writeContract({
  ...internals.emptyContract('ses_impl'),
  peers: internals.derivePeerRoles({ requester: 'ses_me', implementer: 'ses_impl', decider: 'ses_me' })
});
const implLine = (await ask('ses_impl')).split('\n').find(line => line.includes('[role:')) ?? '';
expect('an implementer gets the static duty hint', /你负责实现；实现选择请交 decider/.test(implLine), implLine);
// Review B4: no text matching. Three ordinary sentences that used to misfire
// must produce **no** decision/implementation advice — the role line is static.
const misfireSamples = [
  '帮我改 PRD 验收口径',
  '这个模块怎么实现的？',
  '我先看一下再决定'
];
const misfireResults = [];
for (const sample of misfireSamples) {
  const text = await ask('ses_impl', [{ role: 'user', parts: [{ type: 'text', text: sample }] }]);
  misfireResults.push(text.split('\n').find(line => line.includes('[role:')) ?? '');
}
expect(
  'no advice is generated from request text (three misfire samples stay static)',
  new Set(misfireResults).size === 1 &&
    misfireResults.every(line => line === implLine) &&
    !misfireResults.some(line => /应转给|该由 implementer 执行/.test(line)),
  misfireResults.join(' | ')
);
expect('roleAdvice is gone from the exported surface', internals.roleAdvice === undefined);

// ============================================================ 10) conflict
section('10) conflict → one open decision + the thread goes read-only (R6)');
const epoch = internals.workspaceFacts(workspace).epoch;
// A local `.env` makes the env dimension comparable: a wrong hash = behind,
// a newer facts epoch = ahead → both at once is exactly a `conflict`.
writeFileSync(join(workspace, '.env'), 'API_BASE=http://localhost:1\n', 'utf8');
const conflictMessage = {
  text: '基线不一致，先各自报增量',
  threadID: THREAD_REMOTE,
  fromSession: 'ses_peer',
  grade: 'measured',
  basedOn: { env: { '.env': 'deadbeef' }, facts: epoch + 9 }
};
seedInbox('ses_conflict', [conflictMessage]);
const conflictText = await ask('ses_conflict');
const conflictDecision = readFileForKey(THREAD_REMOTE).items.find(item => item.origin === 'conflict');
expect('[conflict] is injected', conflictText.includes('[conflict]'), conflictText.split('\n').find(line => line.startsWith('[conflict')) ?? '(none)');
expect('the conflict opened exactly one decision', Boolean(conflictDecision), String(conflictDecision?.id));
expect(
  'the escalation line names the D# and the owner',
  new RegExp(`已开 ${conflictDecision?.id}（等 ${conflictDecision?.owner}）`).test(conflictText),
  conflictText.split('\n').find(line => line.includes('已开')) ?? '(none)'
);
// The same divergence seen again (a second conflicting message on the same
// thread) must not open a second decision — the escalation is idempotent.
seedInbox('ses_conflict', [{ ...conflictMessage, text: '基线还是不一致' }]);
const againConflict = await ask('ses_conflict');
expect(
  'a repeated conflict does not open a second decision',
  readFileForKey(THREAD_REMOTE).items.filter(item => item.origin === 'conflict').length === 1,
  String(readFileForKey(THREAD_REMOTE).items.filter(item => item.origin === 'conflict').length)
);
expect('the repeated injection names the same D# (idempotent)', againConflict.includes(`已开 ${conflictDecision?.id}`));
const blockedSend = await callError(
  'collab_send',
  { target: 'ses_peer', kind: 'reply', threadID: THREAD_REMOTE, text: '再解释一遍', confirm: true },
  'ses_conflict'
);
expect(
  'a new message on that thread is refused (read-only until the decision closes)',
  /冲突决策/.test(blockedSend ?? '') && /降级为只读/.test(blockedSend ?? ''),
  blockedSend
);
const conflictOwner = conflictDecision?.owner;
await decide(
  { action: 'answer', key: THREAD_REMOTE, id: conflictDecision.id, answer: '以我方为准（重新测量后一致）', confirm: true },
  conflictOwner
);
const afterAnswerSend = await call(
  'collab_send',
  { target: 'ses_peer', kind: 'reply', threadID: THREAD_REMOTE, text: '决策已答，继续', confirm: true },
  'ses_conflict'
);
expect('after the answer the thread is writable again', /已投递/.test(afterAnswerSend), afterAnswerSend.split('\n')[0]);

// ============================================================ 11) [decide]
section('11) [decide] injection: one line, open items only');
const decideText = await ask('ses_me');
const decideLines = decideText.split('\n').filter(line => line.startsWith('[decide]'));
expect('the [decide] line is injected once', decideLines.length === 1, String(decideLines.length));
expect('it names an open D#@key and its owner', /D\d+@(t_|b_)\S+ open（等 ses_/.test(decideLines[0] ?? ''), decideLines[0] ?? '(none)');
expect(
  'the answered D1 of this thread is not listed (answered items are not injected)',
  !(decideLines[0] ?? '').includes(`D1@${THREAD} `),
  decideLines[0] ?? '(none)'
);
const answeredLine = internals.decideLine('ses_me');
expect('decideLine lists at most 3 rows + 还有 N 条', (answeredLine ?? '').split('·').length <= 4, String(answeredLine));

// ============================================================ 12) resolver
section('12) decision: evidence goes through ONE resolver');
const openCheck = internals.checkEvidence(`decision:${THREAD}#D3`, { directory: workspace });
expect('an open decision is not evidence', openCheck.ok === false && /还是 open/.test(openCheck.reason), openCheck.reason);
const answeredCheck = internals.checkEvidence(`decision:${THREAD}#D1`, { directory: workspace });
expect('an answered decision is evidence', answeredCheck.ok === true && /D1/.test(answeredCheck.reason), answeredCheck.reason);
const supersededCheck = internals.checkEvidence(`decision:${THREAD}#D2`, { directory: workspace });
expect('a superseded decision is not evidence', supersededCheck.ok === false && /superseded/.test(supersededCheck.reason), supersededCheck.reason);
const ambiguousCheck = internals.checkEvidence('decision:D1', { directory: workspace });
expect(
  'a bare D# that exists under 2+ keys is refused as ambiguous (never silently picked)',
  ambiguousCheck.ok === false && /有歧义/.test(ambiguousCheck.reason) && /decision:\S+#D1/.test(ambiguousCheck.reason),
  ambiguousCheck.reason
);

// Compatibility: a 0.7.0 hand-off `decisions[]` entry still resolves.
internals.writeBroadcast({
  ...internals.allBroadcasts().find(record => record.bid === bid),
  decisions: [{ id: 'D-064', decision: '退出码用 3', at: Date.now(), by: 'ses_me' }]
});
const legacyCheck = internals.checkEvidence('decision:D-064', { directory: workspace });
expect(
  'the legacy hand-off decisions[] is still readable (compatibility input)',
  legacyCheck.ok === true && /交接/.test(legacyCheck.reason),
  legacyCheck.reason
);
const missingCheck = internals.checkEvidence('decision:D-404', { directory: workspace });
expect('an unknown decision is refused', missingCheck.ok === false && /collab_decide/.test(missingCheck.reason), missingCheck.reason);

// The single resolver is the only place that reads a record's decisions for
// evidence: `resolveDecision` is called from `checkEvidence`, and the tool this
// suite uses (`collab_todo close`) delegates to it.
const todoOpen = await call('collab_todo', { action: 'add', subject: '用决策做证据', confirm: true }, 'ses_me');
const todoID = /已新增待办 (T\d+)/.exec(todoOpen)?.[1];
const closeWithDecision = await call(
  'collab_todo',
  { action: 'close', id: todoID, evidence: `decision:${THREAD}#D1`, confirm: true },
  'ses_me'
);
expect(
  'collab_todo close accepts decision:<answered D#>',
  /已关闭/.test(closeWithDecision) && /决策 D1/.test(closeWithDecision),
  closeWithDecision.split('\n')[0]
);

// ============================================================ 13) B1 asker
section('13) the asker is a party (owner ≠ asker) — review B1');
const THREAD_ASK = 't_decide_asker';
await decide(
  { action: 'open', key: THREAD_ASK, question: '谁来决定这个口径', options: ['A', 'B'], owner: 'ses_peer', confirm: true },
  'ses_asker'
);
const askerRow = readFileForKey(THREAD_ASK).items[0];
expect('the ledger records askedBy (owner ≠ asker)', askerRow.askedBy === 'ses_asker' && askerRow.owner === 'ses_peer', JSON.stringify({ askedBy: askerRow.askedBy, owner: askerRow.owner }));
const askerDecideLine = (await ask('ses_asker')).split('\n').find(line => line.startsWith('[decide]')) ?? '';
expect(
  'the asker sees the decision in [decide] even though it cannot answer',
  askerDecideLine.includes(`D1@${THREAD_ASK}`),
  askerDecideLine
);
const ownerDecideLine = (await ask('ses_peer')).split('\n').find(line => line.startsWith('[decide]')) ?? '';
expect('the owner sees it too', ownerDecideLine.includes(`D1@${THREAD_ASK}`), ownerDecideLine);
const askerAnswer = await decideError(
  { action: 'answer', key: THREAD_ASK, id: 'D1', answer: 'B', confirm: true },
  'ses_asker'
);
expect('the asker still cannot answer', /只有 owner ses_peer 能 answer/.test(askerAnswer ?? ''), askerAnswer);
await decide(
  { action: 'open', key: THREAD_ASK, question: '第二个待裁决项', options: ['A', 'B'], owner: 'ses_peer', confirm: true },
  'ses_asker'
);
const askerSupersede = await decide(
  { action: 'supersede', key: THREAD_ASK, id: 'D2', reason: '提问方撤回（不再需要裁决）', confirm: true },
  'ses_asker'
);
expect('the asker can supersede its own question', /已作废 D2/.test(askerSupersede), askerSupersede.split('\n')[0]);
expect(
  'the supersede is recorded with the asker as by',
  readFileForKey(THREAD_ASK).items.find(item => item.id === 'D2')?.by === 'ses_asker',
  readFileForKey(THREAD_ASK).items.find(item => item.id === 'D2')?.by
);

// ====================================================== 14) B2 conflict escape
section('14) conflict escape hatch + 24h TTL — review B2');
const THREAD_B2 = 't_decide_b2';
seedInbox('ses_b2', [
  {
    text: '基线不一致（B2）',
    threadID: THREAD_B2,
    fromSession: 'ses_peer',
    grade: 'measured',
    basedOn: { env: { '.env': 'deadbeef' }, facts: epoch + 9 }
  }
]);
await ask('ses_b2');
const b2Decision = readFileForKey(THREAD_B2).items.find(item => item.origin === 'conflict');
expect('the receiver owns the conflict when no decider is declared (N11)', b2Decision?.owner === 'ses_b2', String(b2Decision?.owner));
expect(
  'both sides are stored as parties',
  (b2Decision?.parties ?? []).includes('ses_b2') && (b2Decision?.parties ?? []).includes('ses_peer'),
  JSON.stringify(b2Decision?.parties)
);
const otherSideSupersede = await decide(
  { action: 'supersede', key: THREAD_B2, id: b2Decision.id, reason: '对端作废这次分叉', confirm: true },
  'ses_peer'
);
expect('the other party can supersede the conflict decision', /已作废/.test(otherSideSupersede), otherSideSupersede.split('\n')[0]);
expect('the gate is clear after that supersede', internals.openConflictOf(THREAD_B2) === undefined);
const b2Send = await call(
  'collab_send',
  { target: 'ses_peer', kind: 'reply', threadID: THREAD_B2, text: 'B2 解除后继续', confirm: true },
  'ses_b2'
);
expect('collab_send works again after the party supersede', /已投递/.test(b2Send), b2Send.split('\n')[0]);

const THREAD_TTL = 't_decide_ttl';
seedInbox('ses_ttl', [
  {
    text: '基线不一致（TTL）',
    threadID: THREAD_TTL,
    fromSession: 'ses_peer',
    grade: 'measured',
    basedOn: { env: { '.env': 'deadbeef' }, facts: epoch + 9 }
  }
]);
await ask('ses_ttl');
const ttlDecision = readFileForKey(THREAD_TTL).items.find(item => item.origin === 'conflict');
const hours25 = 25 * 60 * 60 * 1000;
const before = Date.now() + hours25 - 2 * 60 * 60 * 1000;
expect('23h after it was opened the thread is still read-only', internals.openConflictOf(THREAD_TTL, undefined, before) !== undefined);
const expired = await internals.expireConflictDecisions(Date.now() + hours25);
expect(
  '25h later the conflict is auto-superseded',
  expired.some(entry => entry.includes(ttlDecision.id)) &&
    readFileForKey(THREAD_TTL).items.find(item => item.id === ttlDecision.id)?.status === 'superseded',
  JSON.stringify(expired)
);
expect(
  'the auto-supersede records by=system and a 24h reason',
  /24h 未回答/.test(readFileForKey(THREAD_TTL).items.find(item => item.id === ttlDecision.id)?.reason ?? ''),
  readFileForKey(THREAD_TTL).items.find(item => item.id === ttlDecision.id)?.reason
);
expect(
  'the read-only gate is open after the auto-supersede',
  internals.openConflictOf(THREAD_TTL, undefined, Date.now() + hours25) === undefined
);
const ttlSend = await call(
  'collab_send',
  { target: 'ses_peer', kind: 'reply', threadID: THREAD_TTL, text: 'TTL 到期后继续', confirm: true },
  'ses_ttl'
);
expect('collab_send works again after the TTL release', /已投递/.test(ttlSend), ttlSend.split('\n')[0]);

// ====================================================== 15) B3 injection budget
section('15) all sections fit the 12-line budget — review B3');
const fullContract = internals.emptyContract('ses_full');
fullContract.mission = {
  ...fullContract.mission,
  oneLine: '六段全满',
  inScope: ['排钟'],
  outOfScope: ['集群']
};
fullContract.peers = internals.derivePeerRoles({
  requester: 'ses_full',
  implementer: 'ses_peer',
  decider: 'ses_peer'
});
fullContract.todos = Array.from({ length: 10 }, (_, index) => ({
  id: `T${index + 1}`,
  kind: 'mainline',
  subject: `合成待办 ${index + 1}`,
  status: 'open',
  blockingOn: 'me',
  since: 1000,
  updatedAt: 1000
}));
fullContract.plan = {
  milestones: [
    { id: 'M1', title: '一', done: true, at: 1000 },
    { id: 'M2', title: '二', done: false },
    { id: 'M3', title: '三', done: false }
  ],
  lastAdvancedAt: 1000
};
const fullRender = internals.renderInjection({
  contract: fullContract,
  mission: fullContract.mission,
  role: internals.roleLine(fullContract, 'ses_full'),
  decide: '[decide] D1@t_full open（等 ses_peer，<1m）',
  drift: ['[drift] 连续 5 轮无主线动作（1.2h）', '  [未处置] 下一轮仍会提醒'],
  now: 7_200_000
});
expect(
  'all five sections are present and nothing is dropped',
  JSON.stringify(fullRender.sections) === JSON.stringify(['mission', 'todo', 'decide', 'drift', 'progress']) &&
    fullRender.dropped.length === 0,
  `${fullRender.sections.join(',')} / dropped=${fullRender.dropped.join(',') || '-'}`
);
expect('the whole block is exactly 12 lines (≤ the cap)', fullRender.lines.length === 12, `${fullRender.lines.length} lines`);
expect('progress survives (it used to be dropped at 13)', fullRender.lines.some(line => line.startsWith('[progress]')), fullRender.lines.find(line => line.startsWith('[progress]')) ?? '(none)');
expect(
  'the role rides on the mission head line, not its own line',
  fullRender.lines[0].startsWith('[mission]') && fullRender.lines[0].includes('[role:requester+verifier]'),
  fullRender.lines[0]
);

// ============================================ 16) S5 bid key conflict gate
section('16) a bid-key conflict blocks delivery too — review S5');
const BID_CONFLICT = 'b_0123456789abcdee';
internals.writeBroadcast({
  bid: BID_CONFLICT,
  scope: 'local',
  workspace,
  issuePath: 'docs/issues/fix-y.md',
  title: 'y',
  expected: 'implement',
  state: 'open',
  attempts: 0,
  skipped: [],
  declines: [],
  seenBy: [],
  askSeen: [],
  reminded: [],
  replies: [],
  from: { sid: 'ses_me', directory: workspace }
});
const bidConflictVerdict = { state: 'conflict', unknown: false, behind: ['env:.env'], ahead: ['facts:epoch'] };
const bidConflictOpen = await internals.openConflictDecision({
  key: BID_CONFLICT,
  verdict: bidConflictVerdict,
  owner: 'ses_me',
  by: 'ses_me',
  bid: BID_CONFLICT,
  parties: ['ses_me', 'ses_peer']
});
expect('a conflict opens on a bid key', Boolean(bidConflictOpen.decision), JSON.stringify(bidConflictOpen));
const bidBlocked = await callError(
  'collab_send',
  { target: 'ses_peer', bid: BID_CONFLICT, text: '继续这条单', confirm: true },
  'ses_me'
);
expect(
  'a bid-key conflict blocks delivery (交接单 … 只读)',
  /交接单 b_/.test(bidBlocked ?? '') && /冲突决策/.test(bidBlocked ?? ''),
  bidBlocked
);
await decide(
  { action: 'supersede', key: BID_CONFLICT, id: bidConflictOpen.decision.id, reason: 'S5 验证后解除', confirm: true },
  'ses_me'
);
const bidSend = await call('collab_send', { target: 'ses_peer', bid: BID_CONFLICT, text: 'S5 解除后继续', confirm: true }, 'ses_me');
expect('the bid is writable again after the supersede', /已投递/.test(bidSend), bidSend.split('\n')[0]);

// ==================================== 17) S6 conflict has its own quota
section('17) a full manual list never swallows the conflict escalation — review S6');
const THREAD_CAP = 't_decide_cap';
for (const question of ['cap 一', 'cap 二', 'cap 三']) {
  await decide({ action: 'open', key: THREAD_CAP, question, options: ['A', 'B'], owner: 'ses_me', confirm: true }, 'ses_me');
}
expect('three manual decisions fill the cap', readFileForKey(THREAD_CAP).items.filter(item => item.status === 'open').length === 3);
const capConflict = await internals.openConflictDecision({
  key: THREAD_CAP,
  verdict: bidConflictVerdict,
  owner: 'ses_me',
  by: 'ses_me',
  threadId: THREAD_CAP,
  parties: ['ses_me']
});
expect('the conflict still opens (own quota)', Boolean(capConflict.decision), JSON.stringify(capConflict));
const capStillFull = await decideError(
  { action: 'open', key: THREAD_CAP, question: 'cap 四', options: ['A', 'B'], owner: 'ses_me', confirm: true },
  'ses_me'
);
expect('the manual cap is still 3 (conflict does not consume it)', /上限 3/.test(capStillFull ?? ''), capStillFull);

// ==================================== 18) S7 newest-500 + S9 NFKC
section('18) bounded scan keeps the newest; NFKC folding is pinned — review S7/S9');
const manyDir = join(root, 'decisions-many');
mkdirSync(manyDir, { recursive: true });
for (let index = 0; index < 501; index += 1) {
  internals.writeDecisions(
    {
      v: 1,
      key: `t_k${String(index).padStart(3, '0')}`,
      next: 2,
      items: [
        {
          id: 'D1',
          question: `many ${index}`,
          options: ['A', 'B'],
          owner: 'ses_me',
          status: 'open',
          answer: null,
          by: null,
          askedBy: 'ses_me',
          at: Date.now(),
          hash: '0'.repeat(40),
          origin: 'manual'
        }
      ]
    },
    manyDir
  );
}
const many = internals.readAllDecisions(manyDir);
expect(
  'the 501st (newest) ledger is visible; the oldest is the one dropped',
  many.length === 500 && many.some(file => file.key === 't_k500') && !many.some(file => file.key === 't_k000'),
  `${many.length} files · first=${many[0]?.key} · last=${many[many.length - 1]?.key}`
);
const THREAD_NFKC = 't_decide_nfkc';
await decide(
  { action: 'open', key: THREAD_NFKC, question: '退出码用２还是３', options: ['A', 'B'], owner: 'ses_me', confirm: true },
  'ses_me'
);
const nfkcDuplicate = await decideError(
  { action: 'open', key: THREAD_NFKC, question: '退出码用 2 还是 3', options: ['A', 'B'], owner: 'ses_me', confirm: true },
  'ses_me'
);
expect(
  'full-width digits fold onto ASCII (NFKC) so the same question is refused',
  /已有同问决策 D1 open/.test(nfkcDuplicate ?? ''),
  nfkcDuplicate
);

// ============================================================ summary
await cleanup?.();
const failed = checks.filter(check => !check.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed · ${decisionsDir} (${readdirSync(decisionsDir).length} files)`);
if (failed.length) {
  console.log('\nfailed:');
  for (const check of failed) console.log(`  ✗ ${check.title}`);
  process.exit(1);
}
