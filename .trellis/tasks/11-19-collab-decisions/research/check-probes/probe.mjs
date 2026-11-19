/**
 * Independent check probe for `11-19-collab-decisions` (cold-context review).
 *
 *   node probe.mjs <dist/index.js> <tag>
 *
 * Drives the *built* plugin with a fake host (same shape the project harness
 * uses) inside its own temp dirs: never touches ~/.config/opencode/collab-*.
 *
 * Two jobs:
 *   1. compat — the exact text of `collab_status` / `collab_list` / the takeover
 *      injection for records **without** `decisions` (run on both the pre-change
 *      build and the new build, then diff);
 *   2. semantics — every PRD/design rule, with the raw record file bytes as the
 *      "0 write" oracle (records written here, not by the tool under test).
 *
 * Prints one `PROBE <tag> <json>` line with all captured facts. The caller diffs
 * the compat half and inspects the semantics half.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const distPath = process.argv[2];
const tag = process.argv[3] ?? 'run';
const dir = mkdtempSync(join(tmpdir(), `collab-decisions-probe-${tag}-`));

process.env.COLLAB_BROADCAST_DIR = join(dir, 'broadcast');
process.env.COLLAB_GRANT_DIR = join(dir, 'grants');
process.env.COLLAB_LOCK_DIR = join(dir, 'locks');
process.env.COLLAB_OWNER_QUEUE_DIR = join(dir, 'owner-queue');
process.env.COLLAB_REPORT_DIR = join(dir, 'reports');
process.env.COLLAB_CONFIG = join(dir, 'collab.json');
process.env.COLLAB_FREEZE_FILE = join(dir, 'freeze.json');
process.env.COLLAB_THREAD_INDEX_FILE = join(dir, 'collab-threads.json');

const broadcastDir = process.env.COLLAB_BROADCAST_DIR;
const plugin = (await import(`file://${distPath}`)).default;

const checks = [];
const facts = {};
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok), detail: String(detail).slice(0, 400) });
  if (!ok) facts[`FAILED:${title}`] = String(detail).slice(0, 400);
};

const wsRoot = join(dir, 'ws');
const ws = name => {
  const workspace = join(wsRoot, name);
  mkdirSync(join(workspace, 'docs', 'issues'), { recursive: true });
  return workspace;
};
const WS_A = ws('a');
const now = Date.now();

const issueFile = (workspace, name, body) => {
  writeFileSync(join(workspace, 'docs', 'issues', name), body);
  return `docs/issues/${name}`;
};
const toolMessage = (file, at = now) => ({
  id: `msg_tool_${file}`,
  type: 'assistant',
  time: { created: at },
  content: [{ type: 'tool', name: 'edit', state: { status: 'completed', input: { filePath: file } } }]
});

const store = new Map();
const prompts = [];
const created = [];
const contexts = new Map();
const sessions = {
  ses_me: { id: 'ses_me', agent: 'build', title: 'probe requester', time: { updated: now, busy: 0 }, location: { directory: WS_A } },
  ses_to: { id: 'ses_to', agent: 'build', title: 'probe claimant', time: { updated: now, busy: 0 }, location: { directory: WS_A } },
  ses_third: { id: 'ses_third', agent: 'build', title: 'probe bystander', time: { updated: now, busy: 0 }, location: { directory: WS_A } },
  ses_asked: { id: 'ses_asked', agent: 'build', title: 'probe asked', time: { updated: now, busy: 0 }, location: { directory: WS_A } },
  ses_origin: { id: 'ses_origin', agent: 'build', title: 'probe origin', time: { updated: now, busy: 0 }, location: { directory: WS_A } }
};

const tools = [];
const ctx = {
  location: { directory: WS_A },
  options: { allowWrite: true },
  app: { version: 'probe' },
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
    },
    async scan() {
      return { entries: [] };
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
      if (!sessions[sessionID]) throw new Error(`Session not found: ${sessionID}`);
      return structuredClone(sessions[sessionID]);
    },
    async list({ limit = 20, directory } = {}) {
      const list = Object.values(sessions).filter(info => !directory || info.location?.directory === directory);
      return { data: structuredClone(list.slice(0, limit)) };
    },
    async context({ sessionID }) {
      return structuredClone(contexts.get(sessionID) ?? []);
    },
    async create(input = {}) {
      const info = {
        id: `ses_spawn_${created.length + 1}`,
        agent: input.agent ?? 'build',
        title: input.title ?? '(untitled)',
        time: { created: Date.now(), updated: Date.now() },
        location: { directory: input.location?.directory }
      };
      sessions[info.id] = info;
      created.push(info);
      return structuredClone(info);
    },
    async remove({ sessionID }) {
      delete sessions[sessionID];
    },
    async update(input = {}) {
      const { sessionID } = input;
      if (!sessions[sessionID]) throw new Error(`Session not found: ${sessionID}`);
      if (input.permissions !== undefined) sessions[sessionID].permissions = structuredClone(input.permissions);
      if (input.title !== undefined) sessions[sessionID].title = input.title;
      if (input.archived !== undefined) sessions[sessionID].time = { ...sessions[sessionID].time, archived: input.archived ? Date.now() : 0 };
    },
    async switchAgent(input = {}) {
      if (!sessions[input.sessionID]) throw new Error(`Session not found: ${input.sessionID}`);
      sessions[input.sessionID].agent = input.agent;
    },
    async prompt(input) {
      prompts.push(input);
      return { id: `msg_${prompts.length}`, delivery: input.delivery };
    },
    async wait() {},
    async abort() {},
    async command() {}
  },
  event: {
    async *subscribe() {}
  }
};

console.error = () => {};
await plugin.setup(ctx);
console.error = (...args) => process.stderr.write(`${args.join(' ')}\n`);

const tool = name => tools.find(definition => definition.name === name);
const call = async (name, input, context = { sessionID: 'ses_me', agent: 'build' }) =>
  (await tool(name).execute(input, context)).content;
const failOf = async (name, input, context) => {
  try {
    const value = await call(name, input, context);
    return { ok: false, text: String(value) };
  } catch (error) {
    return { ok: true, text: String(error?.message ?? error) };
  }
};
const bidOf = text => (text.match(/b_[0-9a-f]{16}/) ?? [])[0];
const lastPrompt = () => String(prompts[prompts.length - 1]?.text ?? '');

const bcFile = bid => join(broadcastDir, `${bid}.json`);
const writeRecord = (record) => {
  mkdirSync(broadcastDir, { recursive: true });
  writeFileSync(bcFile(record.bid), `${JSON.stringify(record, null, 2)}\n`);
  return record.bid;
};
const rawOf = bid => readFileSync(bcFile(bid), 'utf8');
const recOf = bid => JSON.parse(readFileSync(bcFile(bid), 'utf8'));

// --------------------------------------------------------------- compat fixtures
// No `decisions` anywhere: both builds must render these byte for byte.
const R_PLAIN = writeRecord({
  bid: 'b_c0de00000000a001',
  state: 'open',
  title: 'probe 旧记录（无 decisions）',
  from: { sid: 'ses_me', directory: WS_A },
  updatedAt: 5
});
const R_FULL = writeRecord({
  bid: 'b_c0de00000000a002',
  state: 'claimed',
  title: 'probe 满字段旧记录（无 decisions）',
  from: { sid: 'ses_me', directory: WS_A },
  claim: { by: 'ses_to', kind: 'accept', at: 1, token: 'k_full' },
  receipt: { from: 'ses_to', at: 2, note: '旧回执' },
  replies: [{ from: 'ses_to', at: 3, text: '旧回复' }],
  blocked: [
    {
      at: 4,
      by: 'ses_to',
      need: ['把房态改成「在住」后再触发一次入住'],
      excluded: ['不是权限问题（已用 admin 复现）'],
      minimalTest: '改一次房态，看有没有帧下发。'
    }
  ],
  origin: { sid: 'ses_origin', directory: WS_A },
  priority: 'urgent',
  attempts: 2,
  updatedAt: 6
});

facts.compat = {
  statusPlain: await call('collab_status', { bid: R_PLAIN }),
  statusFull: await call('collab_status', { bid: R_FULL }),
  list: await call('collab_list', {})
};

// Compat injection: a real wake prompt for a broadcast that carries no decisions.
const WS_Y = ws('y');
const ISSUE_Y = issueFile(
  WS_Y,
  'fix-decisions-inject.md',
  '# 决策注入（11-17-worker-store）\n\n`packages/state/src/machine/worker/store.ts`\n'
);
sessions.ses_y = {
  id: 'ses_y',
  agent: 'build',
  title: 'worker store state machine 修复（11-17-worker-store）',
  time: { updated: now - 60_000, busy: 0 },
  location: { directory: WS_Y }
};
contexts.set('ses_y', [toolMessage('packages/state/src/machine/worker/store.ts')]);
const promptsBeforeY = prompts.length;
const bcastY = await call('collab_broadcast', { workspace: WS_Y, issuePath: ISSUE_Y, confirm: true }, { sessionID: 'ses_me', agent: 'build' });
const bidY = bidOf(bcastY);
const askedY = bidY ? recOf(bidY).asked?.sid : undefined;
facts.compat.askedCompatible = askedY === 'ses_y' && prompts.length === promptsBeforeY;
sessions.ses_y.time = { updated: now, busy: now - 45 * 60_000, idle: 0 };
const wakeBeforeY = prompts.length;
await call('collab_broadcast', { workspace: WS_Y, issuePath: ISSUE_Y, confirm: true }, { sessionID: 'ses_me', agent: 'build' });
facts.compat.wakePlain = lastPrompt();
facts.compat.wakePromptCount = prompts.length - wakeBeforeY;
expect('compat: the wake chain really delivered one prompt', prompts.length === wakeBeforeY + 1, `${prompts.length - wakeBeforeY}`);

// --------------------------------------------------------------- semantics (new build only)
const hasDecisions = Boolean(tool('collab_decisions'));
facts.toolSurface = tools.map(definition => definition.name);

if (hasDecisions) {
  const R_MAIN = writeRecord({
    bid: 'b_c0de00000000a003',
    state: 'acked',
    title: 'probe 决策语义 fixture',
    from: { sid: 'ses_me', directory: WS_A },
    claim: { by: 'ses_to', kind: 'accept', at: 1, token: 'k_main' },
    receipt: { from: 'ses_to', at: 2, note: '保持不动的回执' },
    replies: [{ from: 'ses_to', at: 3, text: '保持不动的回复' }],
    blocked: [
      { at: 4, by: 'ses_to', need: ['需要对方：给一下日志'], excluded: [], minimalTest: '跑一次看看' }
    ],
    updatedAt: 7
  });
  const mainSnapshot = () =>
    JSON.stringify({
      state: recOf(R_MAIN).state,
      claim: recOf(R_MAIN).claim,
      receipt: recOf(R_MAIN).receipt,
      replies: recOf(R_MAIN).replies,
      blocked: recOf(R_MAIN).blocked
    });
  const mainBefore = mainSnapshot();
  const mainKeysBefore = Object.fromEntries(
    Object.entries(recOf(R_MAIN)).filter(([key]) => key !== 'decisions' && key !== 'updatedAt')
  );
  const promptsBeforeMain = prompts.length;

  // --- 1. write 3 → status shows 决策 3 条 + newest 3; list decisions=3.
  const write3 = await call(
    'collab_decisions',
    {
      bid: R_MAIN,
      items: [
        { id: 'exit-code', decision: '退出码用 3（不是 2）', rationale: 'D-064 与 CLI 约定一致' },
        { id: 'room-order', decision: 'room:order 是纯事件型，不参与状态断言' },
        { id: 'assert-last-frame', decision: '断言看状态机最终帧，不看中间帧' }
      ],
      confirm: true
    },
    { sessionID: 'ses_me', agent: 'build' }
  );
  const after3 = recOf(R_MAIN);
  const status3 = await call('collab_status', { bid: R_MAIN }, { sessionID: 'ses_me', agent: 'build' });
  const list3 = await call('collab_list', {}, { sessionID: 'ses_me', agent: 'build' });
  facts.semantics = {
    write3,
    status3,
    list3Line: list3.split('\n').find(line => line.includes(R_MAIN)) ?? '',
    after3: after3.decisions
  };
  expect('write 3: three stamps, ids in order, by=ses_me', after3.decisions?.length === 3 && after3.decisions.map(entry => entry.id).join(',') === 'exit-code,room-order,assert-last-frame' && after3.decisions.every(entry => entry.by === 'ses_me' && entry.at > 0), JSON.stringify(after3.decisions));
  expect('status shows 决策 3 条 + the 3 lines', status3.includes('决策 3 条:') && status3.includes('- exit-code: 退出码用 3（不是 2）（D-064 与 CLI 约定一致）') && status3.includes('- room-order:') && status3.includes('- assert-last-frame:'), status3.split('\n').filter(line => line.includes('决策') || line.includes('- ')).join(' | '));
  expect('list line ends with decisions=3', facts.semantics.list3Line.endsWith('decisions=3'), facts.semantics.list3Line);
  expect('write 3 touched no state/claim/receipt/replies/blocked', mainSnapshot() === mainBefore, `${mainSnapshot() === mainBefore ? 'unchanged' : 'CHANGED'}`);
  const mainKeysAfter = Object.fromEntries(
    Object.entries(recOf(R_MAIN)).filter(([key]) => key !== 'decisions' && key !== 'updatedAt')
  );
  facts.semantics.keyDiff = {
    added: Object.keys(mainKeysAfter).filter(key => !(key in mainKeysBefore)),
    removed: Object.keys(mainKeysBefore).filter(key => !(key in mainKeysAfter)),
    changed: Object.keys(mainKeysAfter).filter(
      key => key in mainKeysBefore && JSON.stringify(mainKeysBefore[key]) !== JSON.stringify(mainKeysAfter[key])
    ),
    updatedAtMoved: recOf(R_MAIN).updatedAt !== 7
  };
  expect('write 3 changes no existing key value (only defaults materialize + updatedAt)', facts.semantics.keyDiff.changed.length === 0 && facts.semantics.keyDiff.removed.length === 0, JSON.stringify(facts.semantics.keyDiff));
  expect('write 3 delivered nothing (0 prompts)', prompts.length === promptsBeforeMain, `${prompts.length - promptsBeforeMain} prompt(s)`);

  // --- 2. repeated id: overwrite (count unchanged, old answer gone, at/by = this write).
  const beforeRepeat = recOf(R_MAIN).decisions.find(entry => entry.id === 'exit-code');
  await new Promise(done => setTimeout(done, 5));
  const writeRepeat = await call(
    'collab_decisions',
    { bid: R_MAIN, items: [{ id: 'exit-code', decision: '退出码用 3（覆盖：以 CLI 契约为准）' }], confirm: true },
    { sessionID: 'ses_to', agent: 'build' }
  );
  const afterRepeat = recOf(R_MAIN);
  const repeated = afterRepeat.decisions.find(entry => entry.id === 'exit-code');
  const statusRepeat = await call('collab_status', { bid: R_MAIN }, { sessionID: 'ses_me', agent: 'build' });
  facts.semantics.writeRepeat = writeRepeat;
  expect('repeat id: still 3, unique ids, latest text, by=ses_to, at moved', afterRepeat.decisions.length === 3 && new Set(afterRepeat.decisions.map(entry => entry.id)).size === 3 && repeated.decision === '退出码用 3（覆盖：以 CLI 契约为准）' && repeated.by === 'ses_to' && repeated.at > beforeRepeat.at, `${afterRepeat.decisions.length} / ${JSON.stringify(repeated)} / was ${JSON.stringify(beforeRepeat)}`);
  expect('repeat id: moved to the end (newest last)', afterRepeat.decisions.at(-1).id === 'exit-code', afterRepeat.decisions.map(entry => entry.id).join(','));
  expect('status after overwrite shows only the new answer', statusRepeat.includes('以 CLI 契约为准') && !statusRepeat.includes('退出码用 3（不是 2）'), statusRepeat.split('\n').find(line => line.includes('- exit-code')) ?? '(none)');

  // --- 3. same id twice in one call collapses (later wins).
  const dupCall = await call(
    'collab_decisions',
    { bid: R_MAIN, items: [{ id: 'dup', decision: '第一次' }, { id: 'dup', decision: '第二次' }], confirm: true },
    { sessionID: 'ses_me', agent: 'build' }
  );
  const dupEntry = recOf(R_MAIN).decisions.filter(entry => entry.id === 'dup');
  facts.semantics.dupCall = dupCall;
  expect('same id twice in one call = one entry, later wins', dupEntry.length === 1 && dupEntry[0].decision === '第二次', JSON.stringify(dupEntry));

  // --- 4. permissions: third party / asked / origin refused with 0 bytes.
  // Refusals (third party / asked / origin / no participant / preview / invalid)
  // must leave the stores file-for-file identical. Snapshotted after the last
  // fixture file is written, so only the tool's own writes can change it.
  const storeSnapshot = () =>
    JSON.stringify([
      readdirSync(broadcastDir).sort(),
      existsSync(process.env.COLLAB_LOCK_DIR) ? readdirSync(process.env.COLLAB_LOCK_DIR).sort() : [],
      existsSync(process.env.COLLAB_OWNER_QUEUE_DIR) ? readdirSync(process.env.COLLAB_OWNER_QUEUE_DIR).sort() : []
    ]);
  const permCases = [];
  for (const who of ['ses_third', 'ses_asked', 'ses_origin']) {
    const before = rawOf(R_MAIN);
    const result = await failOf('collab_decisions', { bid: R_MAIN, items: [{ id: `by-${who}`, decision: '旁观的契约改写' }], confirm: true }, { sessionID: who, agent: 'build' });
    permCases.push({ who, refused: result.ok, text: result.text, unchanged: rawOf(R_MAIN) === before });
  }
  facts.semantics.permCases = permCases;
  expect('third party / asked / origin: all refused, 0 bytes written', permCases.every(item => item.refused && item.unchanged) && permCases.every(item => /拒绝写入/.test(item.text)), JSON.stringify(permCases.map(item => [item.who, item.refused, item.unchanged])));

  // --- 5. fail-closed: a record naming nobody (no from.sid, no claim.by).
  const R_ORPHAN = writeRecord({
    bid: 'b_c0de00000000a004',
    state: 'open',
    title: 'probe 无参与方记录',
    from: { directory: WS_A },
    updatedAt: 8
  });
  const orphanBefore = rawOf(R_ORPHAN);
  const storesBefore = storeSnapshot();
  const orphanAsMe = await failOf('collab_decisions', { bid: R_ORPHAN, items: [{ id: 'x', decision: 'y' }], confirm: true }, { sessionID: 'ses_me', agent: 'build' });
  const orphanNoSid = await failOf('collab_decisions', { bid: R_ORPHAN, items: [{ id: 'x', decision: 'y' }], confirm: true }, { agent: 'build' });
  // A record that has `from.sid` but a *hidden* caller (no sessionID).
  const hiddenBefore = rawOf(R_MAIN);
  const hidden = await failOf('collab_decisions', { bid: R_MAIN, items: [{ id: 'hidden', decision: 'x' }], confirm: true }, { agent: 'build' });
  facts.semantics.failClosed = { orphanAsMe, orphanNoSid, hidden };
  expect('fail-closed: record with no from.sid / claim.by → refused, 0 write', orphanAsMe.ok && orphanNoSid.ok && rawOf(R_ORPHAN) === orphanBefore, `${orphanAsMe.ok}/${orphanNoSid.ok} ${orphanAsMe.text} | ${orphanNoSid.text}`);
  expect('fail-closed: no sessionID → refused, 0 write', hidden.ok && rawOf(R_MAIN) === hiddenBefore, `${hidden.ok} ${hidden.text}`);

  // --- 6. preview / invalid / unknown bid: 0 write.
  const prevBefore = rawOf(R_MAIN);
  const preview = await call('collab_decisions', { bid: R_MAIN, items: [{ id: 'preview', decision: '预览不该写' }, { id: 'exit-code', decision: '覆盖预览' }], confirm: false }, { sessionID: 'ses_me', agent: 'build' });
  const previewOmitted = await call('collab_decisions', { bid: R_MAIN, items: [{ id: 'preview2', decision: '缺省 confirm' }] }, { sessionID: 'ses_me', agent: 'build' });
  facts.semantics.preview = preview;
  expect('confirm:false and confirm omitted: preview only, 0 write', preview.includes('未写入') && previewOmitted.includes('未写入') && rawOf(R_MAIN) === prevBefore, `${preview.split('\n')[0]} | ${previewOmitted.split('\n')[0]} | ${rawOf(R_MAIN) === prevBefore ? 'unchanged' : 'CHANGED'}`);

  const invalidBefore = rawOf(R_MAIN);
  const invalids = [
    ['empty items', { bid: R_MAIN, items: [], confirm: true }],
    ['11 items', { bid: R_MAIN, items: Array.from({ length: 11 }, (_, index) => ({ id: `i${index}`, decision: `d${index}` })), confirm: true }],
    ['id 41', { bid: R_MAIN, items: [{ id: 'x'.repeat(41), decision: 'd' }], confirm: true }],
    ['decision 201', { bid: R_MAIN, items: [{ id: 'long', decision: '长'.repeat(201) }], confirm: true }],
    ['rationale 401', { bid: R_MAIN, items: [{ id: 'why', decision: 'd', rationale: '理'.repeat(401) }], confirm: true }],
    ['items not array', { bid: R_MAIN, items: 'nope', confirm: true }],
    ['item not object', { bid: R_MAIN, items: ['nope'], confirm: true }],
    ['missing decision', { bid: R_MAIN, items: [{ id: 'only-id' }], confirm: true }],
    ['bad bid', { bid: 'b_zzz', items: [{ id: 'x', decision: 'y' }], confirm: true }],
    ['unknown bid', { bid: 'b_00000000000000ff', items: [{ id: 'x', decision: 'y' }], confirm: true }]
  ];
  const invalidResults = [];
  for (const [label, input] of invalids) {
    const result = await failOf('collab_decisions', input, { sessionID: 'ses_me', agent: 'build' });
    invalidResults.push([label, result.ok, result.text.slice(0, 120)]);
  }
  facts.semantics.invalids = invalidResults;
  expect('all 10 invalid inputs refused with 0 write', invalidResults.every(([, refused]) => refused) && rawOf(R_MAIN) === invalidBefore, JSON.stringify(invalidResults.map(([label, refused]) => [label, refused])));
  expect('every refusal above left the stores file-for-file identical (no new record / lock / queue item)', storeSnapshot() === storesBefore, `${storeSnapshot() === storesBefore ? 'identical' : 'CHANGED'}`);

  // --- 7. control characters folded (no forged second line).
  const ctrl = await call('collab_decisions', { bid: R_MAIN, items: [{ id: 'two\nlines', decision: '  a\t\tb  \n c  ' }], confirm: true }, { sessionID: 'ses_me', agent: 'build' });
  const ctrlEntry = recOf(R_MAIN).decisions.find(entry => entry.id === 'two lines');
  const statusCtrl = await call('collab_status', { bid: R_MAIN }, { sessionID: 'ses_me', agent: 'build' });
  facts.semantics.ctrl = { ctrl, ctrlEntry };
  expect('control chars folded into one line; no forged decision line in status', Boolean(ctrlEntry) && ctrlEntry.decision === 'a b c' && statusCtrl.split('\n').filter(line => /^\s+- two lines:/.test(line)).length === 1, `${JSON.stringify(ctrlEntry)} / ${ctrl.split('\n').length} lines`);

  // --- 8. rationale truncation in status (80 chars).
  await call('collab_decisions', { bid: R_MAIN, items: [{ id: 'why-long', decision: '长理由', rationale: '理'.repeat(200) }], confirm: true }, { sessionID: 'ses_me', agent: 'build' });
  const statusWhy = await call('collab_status', { bid: R_MAIN }, { sessionID: 'ses_me', agent: 'build' });
  const whyLine = statusWhy.split('\n').find(line => line.includes('- why-long:')) ?? '';
  facts.semantics.whyLine = whyLine;
  expect('status cuts the rationale at 80 chars with …', whyLine.includes('理'.repeat(79) + '…') && !whyLine.includes('理'.repeat(81)), `${whyLine.length} chars`);

  // --- 9. cap 20: fill, then a new id refused wholesale; overwrite still allowed.
  const R_CAP = writeRecord({
    bid: 'b_c0de00000000a005',
    state: 'open',
    title: 'probe 上限 fixture',
    from: { sid: 'ses_me', directory: WS_A },
    updatedAt: 9
  });
  await call('collab_decisions', { bid: R_CAP, items: Array.from({ length: 10 }, (_, index) => ({ id: `a${index}`, decision: `a${index}` })), confirm: true }, { sessionID: 'ses_me', agent: 'build' });
  await call('collab_decisions', { bid: R_CAP, items: Array.from({ length: 10 }, (_, index) => ({ id: `b${index}`, decision: `b${index}` })), confirm: true }, { sessionID: 'ses_me', agent: 'build' });
  const capFull = recOf(R_CAP).decisions.length;
  const capBefore = rawOf(R_CAP);
  // Batch of 10 with 5 new ids at cap: must be refused as a whole (no partial write).
  const capMix = await failOf('collab_decisions', {
    bid: R_CAP,
    items: [
      ...Array.from({ length: 5 }, (_, index) => ({ id: `c${index}`, decision: `c${index}` })),
      ...Array.from({ length: 5 }, (_, index) => ({ id: `a${index}`, decision: `a${index}-new` }))
    ],
    confirm: true
  }, { sessionID: 'ses_me', agent: 'build' });
  // Snapshot immediately: a later successful write must not hide a partial write here.
  const afterMixRaw = rawOf(R_CAP);
  const afterMixA0 = recOf(R_CAP).decisions.find(entry => entry.id === 'a0').decision;
  const afterMixNewIds = recOf(R_CAP).decisions.filter(entry => /^c\d$/.test(entry.id)).length;
  const capOver = await failOf('collab_decisions', { bid: R_CAP, items: [{ id: 'c0', decision: 'c0' }], confirm: true }, { sessionID: 'ses_me', agent: 'build' });
  const afterOverRaw = rawOf(R_CAP);
  const capStatus = await call('collab_status', { bid: R_CAP }, { sessionID: 'ses_me', agent: 'build' });
  const capOverwrite = await call('collab_decisions', { bid: R_CAP, items: [{ id: 'a0', decision: 'a0-覆盖' }], confirm: true }, { sessionID: 'ses_me', agent: 'build' });
  facts.semantics.cap = { capFull, capMix, capOver, capOverwrite, capStatusHead: capStatus.split('\n').find(line => line.includes('决策')) ?? '' };
  expect('cap: 20 reached, the 21st new id is refused, 0 write', capFull === 20 && capOver.ok && afterOverRaw === capBefore, `${capFull} / ${capOver.ok} / ${afterOverRaw === capBefore ? 'unchanged' : 'CHANGED'}`);
  expect('cap: mixed batch (5 new + 5 overwrite) refused as a whole (no partial write)', capMix.ok && afterMixRaw === capBefore && afterMixA0 === 'a0' && afterMixNewIds === 0, `${capMix.ok} / ${afterMixRaw === capBefore ? 'unchanged' : 'CHANGED'} / a0=${afterMixA0} / c*=${afterMixNewIds} / ${capMix.text.slice(0, 80)}`);
  expect('cap: overwrite at 20 still works, count stays 20', capOverwrite.includes('覆盖 1') && recOf(R_CAP).decisions.length === 20 && recOf(R_CAP).decisions.find(entry => entry.id === 'a0').decision === 'a0-覆盖', `${recOf(R_CAP).decisions.length}`);
  expect('cap: status says 决策 20 条（最近 3 条）', capStatus.includes('决策 20 条（最近 3 条）:'), facts.semantics.cap.capStatusHead);

  // --- 10. tolerant read: a hand-edited record (junk entries, >20, dup ids).
  const edited = [];
  for (let index = 0; index < 22; index += 1) edited.push({ id: `h${index}`, decision: `dec ${index}`, at: index, by: 'ses_me' });
  edited.push(null, 'junk', { id: '', decision: 'no id' }, { id: 'no-decision' });
  const R_EDITED = writeRecord({
    bid: 'b_c0de00000000a006',
    state: 'open',
    title: 'probe 手工编辑记录',
    from: { sid: 'ses_me', directory: WS_A },
    decisions: edited,
    updatedAt: 10
  });
  const editedStatus = await call('collab_status', { bid: R_EDITED }, { sessionID: 'ses_me', agent: 'build' });
  const editedList = await call('collab_list', {}, { sessionID: 'ses_me', agent: 'build' });
  facts.semantics.edited = { editedStatus, editedLine: editedList.split('\n').find(line => line.includes(R_EDITED)) ?? '' };
  expect('hand-edited record: status/list never throw and count ≤20', editedStatus.includes('决策 20 条') && facts.semantics.edited.editedLine.includes('decisions=20'), `${facts.semantics.edited.editedLine} / ${editedStatus.split('\n').find(line => line.includes('决策')) ?? '(none)'}`);

  // --- 11. injection carries exactly one count line, never the text.
  const WS_Z = ws('z');
  const ISSUE_Z = issueFile(
    WS_Z,
    'fix-decisions-inject.md',
    '# 决策注入（11-17-worker-store）\n\n`packages/state/src/machine/worker/store.ts`\n'
  );
  sessions.ses_z = {
    id: 'ses_z',
    agent: 'build',
    title: 'worker store state machine 修复（11-17-worker-store）',
    time: { updated: now - 60_000, busy: 0 },
    location: { directory: WS_Z }
  };
  contexts.set('ses_z', [toolMessage('packages/state/src/machine/worker/store.ts')]);
  const bcastZ = await call('collab_broadcast', { workspace: WS_Z, issuePath: ISSUE_Z, confirm: true }, { sessionID: 'ses_me', agent: 'build' });
  const bidZ = bidOf(bcastZ);
  const SECRET = '决策正文不该出现在注入里';
  // A realistic record (written by collab_broadcast): what does a decisions
  // write change, key by key?
  const realBefore = Object.fromEntries(
    Object.entries(recOf(bidZ)).filter(([key]) => key !== 'decisions' && key !== 'updatedAt')
  );
  await call('collab_decisions', { bid: bidZ, items: [{ id: 'inject', decision: SECRET }, { id: 'inject2', decision: '第二条正文' }], confirm: true }, { sessionID: 'ses_me', agent: 'build' });
  const realAfter = Object.fromEntries(
    Object.entries(recOf(bidZ)).filter(([key]) => key !== 'decisions' && key !== 'updatedAt')
  );
  facts.semantics.realKeyDiff = {
    added: Object.keys(realAfter).filter(key => !(key in realBefore)),
    removed: Object.keys(realBefore).filter(key => !(key in realAfter)),
    changed: Object.keys(realAfter).filter(
      key => key in realBefore && JSON.stringify(realBefore[key]) !== JSON.stringify(realAfter[key])
    )
  };
  expect('a realistic record: decisions write changes no other key at all', facts.semantics.realKeyDiff.added.length === 0 && facts.semantics.realKeyDiff.removed.length === 0 && facts.semantics.realKeyDiff.changed.length === 0, JSON.stringify(facts.semantics.realKeyDiff));
  sessions.ses_z.time = { updated: now, busy: now - 45 * 60_000, idle: 0 };
  const wakeBeforeZ = prompts.length;
  await call('collab_broadcast', { workspace: WS_Z, issuePath: ISSUE_Z, confirm: true }, { sessionID: 'ses_me', agent: 'build' });
  const wakeZ = lastPrompt();
  const countLines = wakeZ.split('\n').filter(line => line.includes('本单决策'));
  facts.semantics.wake = wakeZ;
  expect('injection: exactly one count line, no body, mentions collab_status + bid', prompts.length === wakeBeforeZ + 1 && countLines.length === 1 && countLines[0].includes('本单决策 2 条') && countLines[0].includes(`collab_status { bid:"${bidZ}" }`) && !wakeZ.includes(SECRET) && !wakeZ.includes('第二条正文'), `${countLines.join(' | ')} / ${prompts.length - wakeBeforeZ} prompt(s)`);
  // The count line sits before the three steps, after any BLOCKED lines.
  const countIndex = wakeZ.split('\n').findIndex(line => line.includes('本单决策'));
  const stepsIndex = wakeZ.split('\n').findIndex(line => line.includes('按顺序完成'));
  expect('injection: count line is placed before the three steps', countIndex > 0 && stepsIndex > countIndex, `${countIndex} < ${stepsIndex}`);

  // --- 13. astral-plane edge (charCount = code points, truncate = UTF-16): a
  // 40-code-point emoji id passes validation; does a repeat still overwrite?
  const R_EMOJI = writeRecord({
    bid: 'b_c0de00000000a007',
    state: 'open',
    title: 'probe 天文面字符 fixture',
    from: { sid: 'ses_me', directory: WS_A },
    updatedAt: 11
  });
  const EMOJI_ID = '😀'.repeat(40);
  const emoji1 = await failOf('collab_decisions', { bid: R_EMOJI, items: [{ id: EMOJI_ID, decision: '第一次' }], confirm: true }, { sessionID: 'ses_me', agent: 'build' });
  const emojiAfter1 = recOf(R_EMOJI).decisions ?? [];
  const emoji2 = await failOf('collab_decisions', { bid: R_EMOJI, items: [{ id: EMOJI_ID, decision: '第二次' }], confirm: true }, { sessionID: 'ses_me', agent: 'build' });
  const emojiAfter2 = recOf(R_EMOJI).decisions ?? [];
  facts.semantics.emoji = {
    firstRefused: emoji1.ok,
    firstCount: emojiAfter1.length,
    storedIdLength: emojiAfter1[0]?.id?.length ?? 0,
    secondRefused: emoji2.ok,
    secondCount: emojiAfter2.length,
    texts: emojiAfter2.map(entry => entry.decision)
  };

  // --- 14. astral-plane decision text (200 code points = 400 UTF-16 units).
  const R_EMOJI_TEXT = writeRecord({
    bid: 'b_c0de00000000a008',
    state: 'open',
    title: 'probe 天文面正文 fixture',
    from: { sid: 'ses_me', directory: WS_A },
    updatedAt: 12
  });
  const emojiText = '🎯'.repeat(200);
  const text1 = await failOf('collab_decisions', { bid: R_EMOJI_TEXT, items: [{ id: 'text', decision: emojiText }], confirm: true }, { sessionID: 'ses_me', agent: 'build' });
  const emojiTextStatus = await call('collab_status', { bid: R_EMOJI_TEXT }, { sessionID: 'ses_me', agent: 'build' });
  facts.semantics.emojiText = {
    refused: text1.ok,
    storedLength: (recOf(R_EMOJI_TEXT).decisions?.[0]?.decision ?? '').length,
    statusLine: emojiTextStatus.split('\n').find(line => line.includes('- text:')) ?? ''
  };

  // --- 12. status/list of a record written by the tool: decisions=N and newest 3.
  const listMain = await call('collab_list', {}, { sessionID: 'ses_me', agent: 'build' });
  facts.semantics.listMain = listMain.split('\n').find(line => line.includes(R_MAIN)) ?? '';
  expect('collab_list: decisions=N equals the stored count (main record)', facts.semantics.listMain.endsWith(`decisions=${recOf(R_MAIN).decisions.length}`), facts.semantics.listMain);
}

const payload = { tag, checks, facts };
process.stdout.write(`PROBE ${tag} ${JSON.stringify(payload)}\n`);
rmSync(dir, { recursive: true, force: true });
