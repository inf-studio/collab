/**
 * 0.9.2 (`11-20-collab-gate`, revised): the collaboration gate has **no
 * semantic matching** — the session states its own boundary on `collab_accept`
 * (`scopeCheck`), the plugin only forces the statement and audits it. Handing
 * work out is never refused; a long todo list is a reminder, not a wall.
 *
 *   pnpm test                 # builds dist/ first; this file is part of the chain
 *   node test/gate.mjs
 *
 * Everything runs through the built `dist/index.js` with temp paths — no host,
 * no `~/.config/opencode/collab-*`. Cases:
 *
 *   1. tool surface stays 26 (the gate is a pre-check of existing tools)
 *   2. outOfScope non-empty + no `scopeCheck` → refused, two copy-paste calls,
 *      and the record is **byte-for-byte unchanged** (state / claim / lock /
 *      asked / attempts) — the review's finding
 *   3. `inScope:false` → refused with `handoffTo`, one audit line (`model`)
 *   4. `inScope:false` + a human override → accepted, audit `verifiedBy:"override"`
 *   5. `inScope:true` → accepted, audit line (`verifiedBy:"model"`)
 *   6. no `outOfScope` → no statement required, no audit, 0.9.1 output
 *   7. `broadcast` / `handoff` never refuse and never ask; 8+ todos only appends
 *      `[溢出提醒]`
 *   8. `accept` with 8+ todos still goes through (reminder only)
 *   9. "已被领取" / spawn self-claim are never rewritten by the gate (review #3/#4)
 *  10. `reply` / `send` are never checked
 *  11. `gate:"warn"` → missing statement only prints 「本条未表态」; `inScope:false`
 *      is demoted too (still audited)
 *  12. `gate:"off"` → no refusal, no warning, no audit line
 *  13. protected sessions behave exactly as before
 *  14. every audit line has the statement shape
 *
 * Exits 1 if any check fails.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
const root = mkdtempSync(join(base, 'collab-gate-'));
const workspace = join(root, 'workspace');
const peer = join(root, 'peer');
const contractDir = join(root, 'contract');
const broadcastDir = join(root, 'broadcast');
const auditFile = join(root, 'collab-audit.jsonl');
const configFile = join(root, 'collab.json');
mkdirSync(workspace, { recursive: true });
mkdirSync(join(peer, 'docs', 'issues'), { recursive: true });
mkdirSync(broadcastDir, { recursive: true });

// Every global path is read once at import: pin them *before* importing.
process.env.COLLAB_CONTRACT_DIR = contractDir;
process.env.COLLAB_AUDIT_FILE = auditFile;
process.env.COLLAB_BROADCAST_DIR = broadcastDir;
process.env.COLLAB_MESSAGES_FILE = join(root, 'collab-messages.jsonl');
process.env.COLLAB_DB_FILE = join(root, 'collab.db');
process.env.COLLAB_THREAD_INDEX_FILE = join(root, 'collab-threads.json');
process.env.COLLAB_CONFIG = configFile;
process.env.COLLAB_LOCK_DIR = join(root, 'locks');
process.env.COLLAB_OWNER_QUEUE_DIR = join(root, 'owner-queue');
process.env.COLLAB_FREEZE_FILE = join(root, 'freeze.json');
process.env.COLLAB_GRANT_DIR = join(root, 'grants');
process.env.COLLAB_REPORT_DIR = join(root, 'reports');
for (const dir of ['locks', 'owner-queue', 'grants', 'reports']) mkdirSync(join(root, dir), { recursive: true });
writeFileSync(configFile, JSON.stringify({}));
writeFileSync(join(peer, 'docs', 'issues', 'fix-peer.md'), '# fix-peer\n\n一条测试提案，没有文件路径。\n');

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
    async hook() {
      return { dispose: async () => {} };
    },
    async get({ sessionID }) {
      return structuredClone(sessions.get(sessionID) ?? { id: sessionID, agent: 'build', title: 'test' });
    },
    async list() {
      return { data: [] };
    },
    async context() {
      return [];
    },
    async create(input = {}) {
      const info = { id: `ses_spawn_${sessions.size + 1}`, agent: input.agent ?? 'explore', title: input.title ?? '' };
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let seq = 0;
const nextBid = () => `b_${(0xa0000000 + ++seq).toString(16).padStart(16, '0')}`;
const seedBid = (fields = {}) => {
  const bid = fields.bid ?? nextBid();
  const now = Date.now();
  writeFileSync(
    join(broadcastDir, `${bid}.json`),
    JSON.stringify({
      bid,
      scope: 'local',
      state: 'open',
      workspace,
      title: '排钟 B4 接线',
      expected: 'implement',
      affectedFiles: [],
      attempts: 0,
      skipped: [],
      seenBy: [],
      reminded: [],
      replies: [],
      from: { sid: 'ses_requester', directory: workspace },
      createdAt: now,
      updatedAt: now,
      ...fields
    })
  );
  return bid;
};
const recordOf = bid => JSON.parse(readFileSync(join(broadcastDir, `${bid}.json`), 'utf8'));
const rawRecordOf = bid => readFileSync(join(broadcastDir, `${bid}.json`), 'utf8');
const seedContract = (sid, { outOfScope = [], handoffTo = {}, statuses = [] } = {}) => {
  const baseContract = internals.emptyContract(sid);
  baseContract.mission = { ...baseContract.mission, oneLine: '测试主线', outOfScope, handoffTo };
  baseContract.todos = statuses.map((status, index) => ({
    id: `T${index + 1}`,
    kind: 'mainline',
    subject: `待办 ${index + 1}`,
    status,
    blockingOn: 'me',
    since: 1000 + index,
    updatedAt: 1000 + index
  }));
  baseContract.todoSeq = statuses.length;
  internals.writeContract(baseContract);
  return internals.readContract(sid);
};
const auditLines = () => {
  if (!existsSync(auditFile)) return [];
  return readFileSync(auditFile, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
};
const writeConfig = async config => {
  // The config reader caches by `statSync().mtimeMs`; two writes inside one
  // timestamp bucket would keep serving the first value.
  await sleep(1100);
  writeFileSync(configFile, JSON.stringify(config));
};
const evaluate = (kind, payload, contract, config, options) =>
  internals.evaluateGate(kind, payload, contract, config, { audit: false, ...(options ?? {}) });
const eight = [...Array(4).fill('open'), ...Array(4).fill('doing'), 'closed', 'dropped'];

// ================================================================ 1) surface
section('1) tool surface 26 → 27 (the facts ledger)');
expect('PLUGIN_VERSION / package.json agree (0.9.5)', internals.PLUGIN_VERSION === pkg.version && pkg.version === '0.9.5', `${internals.PLUGIN_VERSION} vs ${pkg.version}`);
expect('28 tools are registered', tools.length === 28, `${tools.length} tools`);
expect('the gate is exported for direct testing', typeof internals.evaluateGate === 'function');
expect('GATE_TODO_LIMIT is 8', internals.GATE_TODO_LIMIT === 8, String(internals.GATE_TODO_LIMIT));
expect('COLLAB_AUDIT_FILE is honoured', internals.gateAuditFile() === auditFile, internals.gateAuditFile());

// ==================================== 2) outOfScope + no statement → refuse
section('2) outOfScope set + no scopeCheck → refused, record untouched');
const owner = 'ses_owner_0001';
const guardContract = seedContract('ses_guard', {
  outOfScope: ['ws集群实施'],
  handoffTo: { ws集群实施: owner }
});
const openBid = seedBid({ title: '排钟 B4 接线（房间状态机）' });
const beforeRaw = rawRecordOf(openBid);
const beforeAudit = auditLines().length;
const unstated = await callError('collab_accept', { bid: openBid, confirm: true }, 'ses_guard');
expect('the accept is refused', Boolean(unstated), unstated ? unstated.split('\n')[0] : '(allowed!)');
expect('it says the plugin makes no semantic judgement', /不做语义判断/.test(unstated ?? ''), unstated?.split('\n')[0] ?? '');
expect('it names the boundary (no matching, just the list)', /ws集群实施/.test(unstated ?? ''));
expect(
  'it hands back both copy-pasteable calls',
  (unstated ?? '').includes(`scopeCheck:{ inScope:false, reason:"<为什么不接>" }`) &&
    (unstated ?? '').includes(`scopeCheck:{ inScope:true }`),
  unstated?.split('\n').filter(line => line.includes('collab_accept')).join(' | ') ?? ''
);
expect('the override form is offered too', /override:\{ reason:"/.test(unstated ?? '') && /approvedBy:"/.test(unstated ?? ''));
expect('the record is byte-for-byte unchanged', rawRecordOf(openBid) === beforeRaw);
const untouched = recordOf(openBid);
expect(
  'state / claim / asked / attempts unchanged',
  untouched.state === 'open' && !untouched.claim && !untouched.asked && untouched.attempts === 0,
  JSON.stringify({ state: untouched.state, claim: untouched.claim, asked: untouched.asked, attempts: untouched.attempts })
);
expect('no lock was taken', !existsSync(join(broadcastDir, `${openBid}.lock`)));
expect('an unstated refusal is not audited (nothing was judged)', auditLines().length === beforeAudit, `${beforeAudit} → ${auditLines().length}`);

// ============================== 3) inScope:false → refuse + handoffTo + audit
section('3) scopeCheck:{ inScope:false } → refused with handoffTo, audited');
const beforeFalse = auditLines().length;
const outBid = seedBid({ title: 'ws 集群实施：迁移 redis' });
const outside = await callError(
  'collab_accept',
  { bid: outBid, confirm: true, scopeCheck: { inScope: false, reason: '本会话主线是排钟，不出排钟' } },
  'ses_guard'
);
expect('the accept is refused', /拒绝领取/.test(outside ?? '') && /边界外/.test(outside ?? ''), outside?.split('\n')[0] ?? '(allowed!)');
expect('the refusal names the handoffTo owner', (outside ?? '').includes(owner), outside ?? '');
expect('the refusal explains the human override', /override:\{ reason:"/.test(outside ?? '') && /approvedBy:"/.test(outside ?? ''));
const outRecord = recordOf(outBid);
expect('the record is untouched', outRecord.state === 'open' && !outRecord.claim && !existsSync(join(broadcastDir, `${outBid}.lock`)));
const outLines = auditLines();
const outLine = outLines[outLines.length - 1];
expect('one audit line was appended', outLines.length === beforeFalse + 1, `${beforeFalse} → ${outLines.length}`);
expect(
  'the audit line records inScope:false + verifiedBy:"model" + the reason',
  outLine?.inScope === false && outLine?.verifiedBy === 'model' && outLine?.reason === '本会话主线是排钟，不出排钟' && outLine?.kind === 'accept' && outLine?.bid === outBid && outLine?.sid === 'ses_guard',
  JSON.stringify(outLine)
);

// ============================== 4) override → accepted, audit verifiedBy override
section('4) inScope:false + human override → accepted, audited as override');
const beforeOverride = auditLines().length;
const overrideBid = seedBid({ title: 'ws 集群实施：这次必须由本会话做' });
const overridden = await call(
  'collab_accept',
  {
    bid: overrideBid,
    confirm: true,
    scopeCheck: { inScope: false, reason: '排钟与 ws 共用房间状态机' },
    override: { reason: '排钟与 ws 共用房间状态机，必须一起改', approvedBy: '@长久同学^v^' }
  },
  'ses_guard'
);
expect('the accept goes through', /已领取/.test(overridden), overridden.split('\n')[0]);
expect('the result says it was a human override', /override/.test(overridden) && /已写入 collab-audit/.test(overridden), overridden.split('\n')[0]);
const overrideLines = auditLines();
const overrideLine = overrideLines[overrideLines.length - 1];
expect('exactly one audit line was appended', overrideLines.length === beforeOverride + 1, `${beforeOverride} → ${overrideLines.length}`);
expect(
  'the line is inScope:false + verifiedBy:"override" + approvedBy',
  overrideLine?.inScope === false && overrideLine?.verifiedBy === 'override' && overrideLine?.approvedBy === '@长久同学^v^',
  JSON.stringify(overrideLine)
);
const badOverrideBid = seedBid({ title: 'ws 集群实施：自批' });
const selfApproved = await callError(
  'collab_accept',
  {
    bid: badOverrideBid,
    confirm: true,
    scopeCheck: { inScope: false, reason: '想接' },
    override: { reason: '想接', approvedBy: 'ses_self_0002' }
  },
  'ses_guard'
);
expect('approvedBy:"ses_…" is still refused', /不得以 ses_ 开头/.test(selfApproved ?? '') && recordOf(badOverrideBid).state === 'open', selfApproved ?? '');

// ============================== 5) inScope:true → accepted + audited
section('5) scopeCheck:{ inScope:true } → accepted, audited (model)');
const beforeTrue = auditLines().length;
const inBid = seedBid({ title: '排钟 B4 接线：房间状态机' });
const inside = await call(
  'collab_accept',
  { bid: inBid, confirm: true, scopeCheck: { inScope: true, reason: '排钟主线内' } },
  'ses_guard'
);
const inRecord = recordOf(inBid);
expect('the hand-off is claimed', /已领取/.test(inside) && inRecord.state === 'acked' && inRecord.claim?.by === 'ses_guard', `${inside.split('\n')[0]} / ${inRecord.state}`);
expect('the result records the statement', /已记录表态/.test(inside) && /排钟主线内/.test(inside), inside.split('\n').find(line => line.includes('表态')) ?? '(missing)');
const inLines = auditLines();
const inLine = inLines[inLines.length - 1];
expect('one audit line was appended', inLines.length === beforeTrue + 1, `${beforeTrue} → ${inLines.length}`);
expect(
  'the line is inScope:true + verifiedBy:"model"',
  inLine?.inScope === true && inLine?.verifiedBy === 'model' && inLine?.reason === '排钟主线内' && inLine?.bid === inBid,
  JSON.stringify(inLine)
);

// ============================== 6) no outOfScope → 0.9.1 behaviour
section('6) no outOfScope → no statement, no audit, 0.9.1 output');
seedContract('ses_open'); // empty mission boundary
const beforePlain = auditLines().length;
const plainBid = seedBid({ title: 'ws 集群实施：直接接' });
const plain = await call('collab_accept', { bid: plainBid, confirm: true }, 'ses_open');
expect('the accept succeeds without scopeCheck', /已领取/.test(plain), plain.split('\n')[0]);
expect('the output has no scope-gate wording', !/表态|outOfScope|scopeCheck/.test(plain), plain.split('\n').slice(0, 2).join(' | '));
expect('no audit line is written', auditLines().length === beforePlain, `${beforePlain} → ${auditLines().length}`);
expect('the record is claimed', recordOf(plainBid).state === 'acked');
const noContractEval = evaluate('accept', { bid: 'b_00000000a00000ff' }, internals.emptyContract('ses_none'), { gate: 'enforce' });
expect('evaluate with an empty contract is a plain allow', noContractEval.verdict === 'allow' && noContractEval.content === '', JSON.stringify(noContractEval));

// ============================== 7) overflow is a reminder, never a wall
section('7) 8+ open todos → reminder only (accept / broadcast / handoff)');
seedContract('ses_busy', { statuses: eight });
const busyContract = internals.readContract('ses_busy');
const busyBid = seedBid({ title: '排钟接线：新的一张单' });
const busyAccept = await call('collab_accept', { bid: busyBid, confirm: true }, 'ses_busy');
expect('accept still goes through', /已领取/.test(busyAccept) && recordOf(busyBid).state === 'acked', busyAccept.split('\n')[0]);
expect('… and ends with the overflow reminder', /\[溢出提醒\] 你已有 8 条协作待办/.test(busyAccept.split('\n').slice(-1)[0]), busyAccept.split('\n').slice(-1)[0]);
const broadcastOverflow = await call(
  'collab_broadcast',
  { workspace: peer, issuePath: 'docs/issues/fix-peer.md', expected: 'review', confirm: false },
  'ses_busy'
);
expect('broadcast is not refused', !/拒绝/.test(broadcastOverflow), broadcastOverflow.split('\n')[0]);
expect('… and carries the overflow reminder', /\[溢出提醒\] 你已有 8 条协作待办/.test(broadcastOverflow.split('\n').slice(-1)[0]), broadcastOverflow.split('\n').slice(-1)[0]);
seedContract('ses_peer_target', { outOfScope: ['ws集群实施'] });
const handoffOverflow = await call(
  'collab_handoff',
  { target: 'ses_peer_target', text: '排钟接线：转给对端', expected: 'review', confirm: false },
  'ses_busy'
);
expect('handoff preview is not refused and carries the reminder', !/拒绝/.test(handoffOverflow) && /\[溢出提醒\]/.test(handoffOverflow.split('\n').slice(-1)[0]), handoffOverflow.split('\n').slice(-1)[0]);
const overflowBroadcastGate = evaluate('broadcast', {}, busyContract, { gate: 'enforce' });
expect(
  'evaluate("broadcast") is allow + reminder (never a deny)',
  overflowBroadcastGate.verdict === 'allow' && Boolean(overflowBroadcastGate.reminder) && overflowBroadcastGate.content === '',
  JSON.stringify(overflowBroadcastGate)
);
const openCountRule = internals.openTodos(busyContract).length;
expect('the count only includes open/doing/blocked/suspended', openCountRule === 8, String(openCountRule));

// ============================== 8) existing claims are never gated
section('8) "已被领取" / spawn self-claim are never rewritten (review #3/#4)');
const takenBid = seedBid({
  state: 'acked',
  claim: { by: 'ses_someone_else', kind: 'accept', token: 'k_x', at: Date.now(), leaseMs: 300_000 }
});
const takenRaw = rawRecordOf(takenBid);
const takenContent = await call('collab_accept', { bid: takenBid, confirm: true }, 'ses_guard');
expect('the reply is the unchanged "已被 … 领取" line', takenContent.startsWith('已被 ses_someone_else 领取'), takenContent.split('\n')[0]);
expect('the taken record was not touched', rawRecordOf(takenBid) === takenRaw);
const selfBid = seedBid({
  state: 'claimed',
  claim: { by: 'ses_guard', kind: 'spawn', token: 'k_y', at: Date.now(), leaseMs: 300_000 }
});
const selfAck = await call('collab_accept', { bid: selfBid, confirm: true }, 'ses_guard');
expect('a spawn self-claim (no scopeCheck) is not turned into a refusal', /你已领取/.test(selfAck) && recordOf(selfBid).state === 'acked', selfAck.split('\n')[0]);
expect('… and it writes no statement (there was none)', !auditLines().some(line => line.bid === selfBid));

// ============================== 9) reply / send never checked
section('9) reply / send are never scope-checked');
for (const kind of ['reply', 'send']) {
  const verdict = evaluate(kind, { bid: openBid }, guardContract, { gate: 'enforce' });
  expect(`${kind} → allow`, verdict.verdict === 'allow' && verdict.content === '', JSON.stringify(verdict));
}

// ============================== 10) gate:"warn"
section('10) gate:"warn" → missing statement only warns; inScope:false demoted');
await writeConfig({ gate: 'warn' });
const warnBid = seedBid({ title: 'ws 集群实施：warn 下未表态' });
const warnUnstated = await call('collab_accept', { bid: warnBid, confirm: true }, 'ses_guard');
expect('missing scopeCheck is not refused under warn', /已领取/.test(warnUnstated), warnUnstated.split('\n')[0]);
expect('… and the result says 本条未表态', /本条未表态/.test(warnUnstated) && /gate="warn"/.test(warnUnstated), warnUnstated.split('\n').find(line => line.includes('gate="warn"')) ?? '(no warn)');
const beforeWarnFalse = auditLines().length;
const warnFalseBid = seedBid({ title: 'ws 集群实施：warn 下说不在边界内' });
const warnFalse = await call(
  'collab_accept',
  { bid: warnFalseBid, confirm: true, scopeCheck: { inScope: false, reason: '不在边界内' } },
  'ses_guard'
);
expect('inScope:false is allowed under warn (still printed)', /已领取/.test(warnFalse) && /gate="warn"/.test(warnFalse), warnFalse.split('\n')[0]);
expect('… and the statement is still audited', auditLines().length === beforeWarnFalse + 1 && auditLines().at(-1)?.inScope === false, `+${auditLines().length - beforeWarnFalse}`);

// ============================== 11) gate:"off"
section('11) gate:"off" → no refusal, no warning, no audit');
await writeConfig({ gate: 'off' });
const beforeOff = auditLines().length;
const offBid = seedBid({ title: 'ws 集群实施：off 下直接接' });
const offAccept = await call('collab_accept', { bid: offBid, confirm: true }, 'ses_guard');
expect('the accept goes through under off', /已领取/.test(offAccept), offAccept.split('\n')[0]);
expect('no gate text is printed', !/表态|gate="warn"|溢出提醒/.test(offAccept), offAccept.split('\n').slice(0, 3).join(' | '));
expect('no audit line is written', auditLines().length === beforeOff, `${beforeOff} → ${auditLines().length}`);
seedContract('ses_busy_off', { statuses: eight });
const offBusyBid = seedBid({ title: '排钟：off 下溢出也不提醒' });
const offBusy = await call('collab_accept', { bid: offBusyBid, confirm: true }, 'ses_busy_off');
expect('the overflow reminder is gone under off', !/溢出提醒/.test(offBusy), offBusy.split('\n').slice(-1)[0]);
const offEval = evaluate('accept', { bid: offBid }, guardContract, { gate: 'off' });
expect('evaluate under off is a plain allow', offEval.verdict === 'allow' && offEval.content === '' && !offEval.reminder, JSON.stringify(offEval));

// ============================== 12) protected unchanged
section('12) protected sessions behave exactly as before');
await writeConfig({ protect: ['ses_protected_0003'] });
const protectedBid = seedBid({ title: '排钟接线：给受保护会话' });
const protectedDenied = await callError('collab_accept', { bid: protectedBid, confirm: true }, 'ses_protected_0003');
expect('the protect refusal is unchanged', /protect 名单/.test(protectedDenied ?? '') && !/表态/.test(protectedDenied ?? ''), protectedDenied ?? '');
await writeConfig({});

// ============================== 13) audit shape
section('13) every audit line has the statement shape');
const lines = auditLines();
const fields = ['at', 'sid', 'kind', 'bid', 'inScope', 'reason', 'verifiedBy'];
const malformed = lines.filter(line => fields.some(field => !(field in line)) || typeof line.inScope !== 'boolean' || !['model', 'override'].includes(line.verifiedBy));
expect('audit lines exist', lines.length > 0, `${lines.length} line(s)`);
expect('no malformed line', malformed.length === 0, JSON.stringify(malformed.slice(0, 2)));
expect('no line carries the old `verdict` field', lines.every(line => !('verdict' in line)), lines.slice(0, 1).map(line => Object.keys(line).join(',')).join(''));
expect('both inScope values and both verifiedBy values are represented',
  new Set(lines.map(line => line.inScope)).size === 2 && new Set(lines.map(line => line.verifiedBy)).size === 2,
  `${[...new Set(lines.map(line => String(line.inScope) + '/' + line.verifiedBy))].join(',')}`
);
expect('every line names a bid and a session', lines.every(line => line.bid && line.sid));

// ------------------------------------------------------------------- result
await Promise.resolve(cleanup?.()).catch(() => {});
const failed = checks.filter(check => !check.ok);
console.log(`\naudit lines: ${lines.length} · tools: ${tools.length}`);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log('failed:');
  for (const check of failed) console.log(`  ✗ ${check.title}`);
  process.exit(1);
}
