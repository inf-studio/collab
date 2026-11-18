/**
 * Independent verification harness for 11-18-collab-hint-dedupe (0.4.1).
 * Fake ctx written from scratch (does NOT reuse test/handoff-harness.mjs code),
 * raw broadcast + owner-queue JSON files so every `at` / `bid` / `issuePath` is
 * chosen by this script. Read-only w.r.t. the repo: everything lands in a temp
 * dir and the plugin's env overrides.
 */
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'dedupe-check-'));
const bcDir = join(root, 'broadcasts');
const qDir = join(root, 'owner-queue');
const wsDir = join(root, 'ws');
mkdirSync(join(wsDir, 'docs', 'issues'), { recursive: true });
mkdirSync(bcDir, { recursive: true });
mkdirSync(qDir, { recursive: true });
process.env.COLLAB_BROADCAST_DIR = bcDir;
process.env.COLLAB_OWNER_QUEUE_DIR = qDir;
process.env.COLLAB_GRANT_DIR = join(root, 'grants');
process.env.COLLAB_LOCK_DIR = join(root, 'locks');
process.env.COLLAB_REPORT_DIR = join(root, 'reports');
process.env.COLLAB_CONFIG = join(root, 'collab.json');

const OWN1 = 'ses_chk_own1';
const OWN2 = 'ses_chk_own2';
const OWN3 = 'ses_chk_own3';
const OWN4 = 'ses_chk_own4';
const OWN5 = 'ses_chk_own5';
const OWN6 = 'ses_chk_own6';
const OWN7 = 'ses_chk_own7';
const OWN9 = 'ses_chk_own9';
const OWN10 = 'ses_chk_own10';
const OWN11 = 'ses_chk_own11';
const OWN12 = 'ses_chk_own12';
const CHILD = 'ses_chk_child';
const PLAIN = 'ses_chk_plain';
const FROM = 'ses_chk_from';
const PROTECTED = [OWN1, OWN2, OWN3, OWN4, OWN5, OWN6, OWN7, OWN9, OWN10, OWN11, OWN12, CHILD];
writeFileSync(process.env.COLLAB_CONFIG, JSON.stringify({ protect: PROTECTED }, null, 2));

// proposals (validateIssuePath needs real files under <ws>/docs/issues)
for (const name of ['p.md', 'q.md', 'r1.md', 'r2.md', 'r3.md', 'r4.md', 'r5.md', 'f1.md', 'f2.md', 'c.md']) {
  writeFileSync(join(wsDir, 'docs', 'issues', name), `# ${name}\n`);
}

const sessions = new Map();
const mkSession = (id, extra = {}) => {
  sessions.set(id, { id, agent: 'build', title: id, time: { updated: Date.now(), busy: 0 }, location: { directory: wsDir }, ...extra });
};
for (const sid of [...PROTECTED, PLAIN, FROM]) mkSession(sid);
sessions.set(CHILD, { ...sessions.get(CHILD), parentID: OWN2 });
sessions.set('ses_chk_by', { id: 'ses_chk_by', agent: 'build', title: 'by', time: { updated: 1, busy: 0 }, location: { directory: wsDir } });

const store = new Map();
const tools = [];
const hooks = {};
const ctx = {
  location: { directory: wsDir },
  options: {},
  app: { version: 'check' },
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
    async transform(cb) {
      cb({ add: definition => tools.push(definition) });
      return { dispose: async () => {} };
    }
  },
  session: {
    async hook(name, cb) {
      hooks[name] = cb;
      return { dispose: async () => {} };
    },
    async get({ sessionID }) {
      const info = sessions.get(sessionID);
      if (!info) throw new Error(`Session not found: ${sessionID}`);
      return structuredClone(info);
    },
    async list({ limit = 20 } = {}) {
      return { data: structuredClone([...sessions.values()].slice(0, limit)) };
    },
    async context() {
      return [];
    },
    async create(input = {}) {
      const info = { id: `ses_chk_spawn_${sessions.size}`, agent: 'build', title: 'x', time: { updated: Date.now() }, location: { directory: input.location?.directory } };
      sessions.set(info.id, info);
      return structuredClone(info);
    },
    async remove() {},
    async update() {},
    async switchAgent() {},
    async prompt() {
      throw new Error('check: the injection path must never prompt');
    },
    async wait() {}
  },
  event: {
    async subscribe() {
      return () => {};
    }
  }
};

const distEntry = '/data/project/collab/dist/index.js';
const mod = await import(`file://${distEntry}`);
await mod.default.setup(ctx);
const internals = mod.__internals ?? {};

// ---------------------------------------------------------------- fixtures
const bcPath = bid => join(bcDir, `${bid}.json`);
function writeBc(bid, overrides) {
  const record = {
    bid,
    scope: 'peer',
    workspace: wsDir,
    issuePath: 'docs/issues/p.md',
    title: 'fixture',
    expected: 'implement',
    affectedFiles: [],
    candidates: [],
    state: 'done',
    attempts: 0,
    skipped: [],
    seenBy: [],
    askSeen: [],
    reminded: [],
    replies: [],
    from: { sid: FROM },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  };
  writeFileSync(bcPath(bid), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
function qPath(sid, id) {
  return join(qDir, sid, `${id}.json`);
}
function writeQ(sid, { id, at, summary, issuePath, bid, seenAt = null }) {
  mkdirSync(join(qDir, sid), { recursive: true });
  const item = { id, target: sid, from: FROM, at, summary, issuePath: issuePath ?? null, bid: bid ?? null, revokedAt: null, seenAt };
  writeFileSync(qPath(sid, id), `${JSON.stringify(item, null, 2)}\n`);
  return item;
}
const readQ = (sid, id) => JSON.parse(readFileSync(qPath(sid, id), 'utf8'));
const qLines = text => String(text).split('\n').filter(line => line.startsWith('- [owner-queue] '));
const fLines = text => String(text).split('\n').filter(line => /^- b_[0-9a-f]+ 已闭环/.test(line));
const seenKeys = sid => store.get(`collab/followup-seen/${sid}`)?.keys ?? [];
const textOf = event => event.system.map(block => String(block?.text ?? '')).join('\n');
const qid = (at, tag) => `q_${at.toString(36)}_${tag}`;

let pass = 0;
const fails = [];
const expect = (title, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${title}${detail ? ` — ${detail}` : ''}`);
  } else {
    fails.push(title);
    console.log(`  ✗ ${title}${detail ? ` — ${detail}` : ''}`);
  }
};
const show = (title, value) => console.log(`\n--- ${title}\n${value}`);

async function inject(sid) {
  const event = { sessionID: sid, agent: 'build', system: [], messages: [] };
  await hooks.context(event);
  return textOf(event);
}

// ============================================================ 1. dedupe key
console.log('\n== Case A (own1): same issuePath, queue newer (2000 > 1000)');
writeBc('b_aaaa000000000a01', {
  issuePath: 'docs/issues/p.md',
  from: { sid: OWN1 },
  followUps: [{ bid: 'b_aaaa000000000a01', issuePath: 'docs/issues/p.md', at: 1000, by: 'ses_x' }]
});
writeQ(OWN1, { id: qid(2000, 'a'), at: 2000, summary: 'A 队列较新', issuePath: 'docs/issues/p.md' });
let t = await inject(OWN1);
show('A request 1', t || '(empty)');
expect('A/1 one line for one proposal', qLines(t).length + fLines(t).length === 1, `${qLines(t).length}q+${fLines(t).length}f`);
expect('A/1 the newest (queue) wins', qLines(t).length === 1 && qLines(t)[0].includes('A 队列较新'));
expect('A/1 rendered queue item is stamped', Number(readQ(OWN1, qid(2000, 'a')).seenAt) > 0);
expect('A/1 de-duplicated followUp is NOT stamped', seenKeys(OWN1).length === 0, JSON.stringify(seenKeys(OWN1)));
t = await inject(OWN1);
show('A request 2', t || '(empty)');
expect('A/2 the de-duplicated followUp renders next round', fLines(t).length === 1 && qLines(t).length === 0, fLines(t)[0] ?? '(none)');
expect('A/2 and is stamped once really rendered', seenKeys(OWN1).length === 1, JSON.stringify(seenKeys(OWN1)));
t = await inject(OWN1);
expect('A/3 nothing repeats on the third request', qLines(t).length + fLines(t).length === 0, t || '(empty)');

console.log('\n== Case B (own2): same issuePath, followUp newer (2000 > 1000)');
writeQ(OWN2, { id: qid(1000, 'b'), at: 1000, summary: 'B 队列较旧', issuePath: 'docs/issues/q.md' });
writeBc('b_aaaa000000000b02', {
  issuePath: 'docs/issues/q.md',
  from: { sid: OWN2 },
  followUps: [{ bid: 'b_aaaa000000000b02', issuePath: 'docs/issues/q.md', at: 2000, by: 'ses_x' }]
});
t = await inject(OWN2);
show('B request 1', t || '(empty)');
expect('B/1 one line, the newer followUp wins', fLines(t).length === 1 && qLines(t).length === 0, t.split('\n')[1] ?? '');
expect('B/1 merged-away queue item NOT stamped', readQ(OWN2, qid(1000, 'b')).seenAt === null);
expect('B/1 followUp stamped', seenKeys(OWN2).length === 1, JSON.stringify(seenKeys(OWN2)));
t = await inject(OWN2);
expect('B/2 queue item renders (and is stamped) next round', qLines(t).length === 1 && Number(readQ(OWN2, qid(1000, 'b')).seenAt) > 0, qLines(t)[0] ?? '');
t = await inject(OWN2);
expect('B/3 nothing repeats afterwards', qLines(t).length + fLines(t).length === 0, t || '(empty)');

console.log('\n== Case C (own3): same millisecond tie -> followUp wins');
writeBc('b_aaaa000000000c03', {
  issuePath: 'docs/issues/r1.md',
  from: { sid: OWN3 },
  followUps: [{ bid: 'b_aaaa000000000c03', issuePath: 'docs/issues/r1.md', at: 5000, by: 'ses_x' }]
});
writeQ(OWN3, { id: qid(5000, 'c'), at: 5000, summary: 'C 同一毫秒队列', issuePath: 'docs/issues/r1.md' });
t = await inject(OWN3);
show('C request 1', t || '(empty)');
expect('C tie on `at` keeps the followUp', fLines(t).length === 1 && qLines(t).length === 0, t.split('\n')[1] ?? '');

// =================================================== 2. path normalisation
console.log('\n== Case D (own4): equivalent spellings collapse ("./", "//", ".")');
writeBc('b_aaaa000000000d04', {
  issuePath: './docs//issues/./p.md',
  from: { sid: OWN4 },
  followUps: [{ bid: 'b_aaaa000000000d04', issuePath: './docs/issues/./p.md', at: 1000, by: 'ses_x' }]
});
writeQ(OWN4, { id: qid(2000, 'd'), at: 2000, summary: 'D 等价写法', issuePath: './docs//issues/./p.md' });
t = await inject(OWN4);
show('D request 1', t || '(empty)');
expect('D normalized spellings merge into one line', qLines(t).length + fLines(t).length === 1, t.split('\n')[1] ?? '');

// ==================================== 3. documented gap: bid-only vs path+bid
console.log('\n== Case E (own5): queue item carries only `bid`, followUp carries bid+path');
writeBc('b_aaaa000000000e05', {
  issuePath: 'docs/issues/f1.md',
  from: { sid: OWN5 },
  followUps: [{ bid: 'b_aaaa000000000e05', issuePath: 'docs/issues/f1.md', at: 1000, by: 'ses_x' }]
});
writeQ(OWN5, { id: qid(2000, 'e'), at: 2000, summary: 'E 只有 bid 的队列项', issuePath: null, bid: 'b_aaaa000000000e05' });
t = await inject(OWN5);
show('E request 1', t || '(empty)');
const eLines = qLines(t).length + fLines(t).length;
console.log(`  [observed] lines for one bid = ${eLines} (1 = merged, 2 = not merged)`);

console.log('\n== Case F (own6): neither issuePath nor bid -> never merged');
writeQ(OWN6, { id: qid(1000, 'f'), at: 1000, summary: 'F 无键 1' });
writeQ(OWN6, { id: qid(2000, 'f'), at: 2000, summary: 'F 无键 2' });
t = await inject(OWN6);
show('F request 1', t || '(empty)');
expect('F two keyless items both render (nothing proves they are the same)', qLines(t).length === 2, String(qLines(t).length));

// ============================================================ 4. total cap
console.log('\n== Case G (own7): 2 followUps + 3 queue items, 5 distinct proposals');
writeBc('b_aaaa0000000a0606', {
  issuePath: 'docs/issues/f1.md',
  from: { sid: OWN7 },
  followUps: [{ bid: 'b_aaaa0000000a0606', issuePath: 'docs/issues/f1.md', at: 1000, by: 'ses_x' }]
});
writeBc('b_aaaa0000000a0707', {
  issuePath: 'docs/issues/f2.md',
  from: { sid: OWN7 },
  followUps: [{ bid: 'b_aaaa0000000a0707', issuePath: 'docs/issues/f2.md', at: 2000, by: 'ses_x' }]
});
for (const [i, at] of [3000, 4000, 5000].entries()) {
  writeQ(OWN7, { id: qid(at, `g${i}`), at, summary: `G 队列 ${i + 1}`, issuePath: `docs/issues/r${i + 1}.md` });
}
t = await inject(OWN7);
show('G request 1', t || '(empty)');
expect('G/1 at most 3 lines across BOTH sources', qLines(t).length + fLines(t).length === 3, `${qLines(t).length}q+${fLines(t).length}f`);
expect('G/1 oldest first (f1, f2, r1)', fLines(t).length === 2 && qLines(t)[0]?.includes('G 队列 1') === true, t.split('\n').slice(1).map(l => l.slice(0, 40)).join(' | '));
t = await inject(OWN7);
show('G request 2', t || '(empty)');
expect('G/2 the remaining two arrive, still <=3', qLines(t).length === 2 && fLines(t).length === 0, String(qLines(t).length));
t = await inject(OWN7);
expect('G/3 nothing left afterwards', qLines(t).length + fLines(t).length === 0, t || '(empty)');

// ================================================== 5. protected child path
console.log('\n== Case H (child of a protected line): queue only, still de-duplicated');
writeBc('b_aaaa0000000a0808', {
  issuePath: 'docs/issues/c.md',
  from: { sid: CHILD },
  followUps: [{ bid: 'b_aaaa0000000a0808', issuePath: 'docs/issues/c.md', at: 1000, by: 'ses_x' }]
});
writeQ(CHILD, { id: qid(1000, 'h'), at: 1000, summary: 'H 子会话旧', issuePath: 'docs/issues/c.md' });
writeQ(CHILD, { id: qid(2000, 'h'), at: 2000, summary: 'H 子会话新', issuePath: 'docs/issues/c.md' });
t = await inject(CHILD);
show('H request 1', t || '(empty)');
expect('H/1 exactly one queue line (deduplicated)', qLines(t).length === 1 && qLines(t)[0].includes('H 子会话新'), qLines(t).join(' | '));
expect('H/2 no followUp line and no group/broadcast line for a child', fLines(t).length === 0 && !t.includes('群组广播') && !t.includes('接管请求'));

// ============================================ 6. non-protected: unchanged
console.log('\n== Case I (plain, non-protected): followUp cap stays 1, no queue lines');
writeBc('b_aaaa0000000a0909', {
  issuePath: 'docs/issues/f1.md',
  from: { sid: PLAIN },
  followUps: [
    { bid: 'b_aaaa0000000a0909', issuePath: 'docs/issues/f1.md', at: 1000, by: 'ses_x' },
    { bid: 'b_aaaa0000000a0909', issuePath: 'docs/issues/f2.md', at: 2000, by: 'ses_x' }
  ]
});
writeBc('b_aaaa0000000a1010', {
  issuePath: 'docs/issues/p.md',
  from: { sid: PLAIN },
  followUps: [{ bid: 'b_aaaa0000000a1010', issuePath: 'docs/issues/p.md', at: 3000, by: 'ses_x' }]
});
writeQ(PLAIN, { id: qid(1000, 'i'), at: 1000, summary: 'I 不该被非受保护会话看到', issuePath: 'docs/issues/p.md' });
t = await inject(PLAIN);
show('I request 1', t || '(empty)');
expect('I/1 non-protected still renders at most ONE followUp line', fLines(t).length === 1, String(fLines(t).length));
expect('I/2 non-protected never sees owner-queue lines', qLines(t).length === 0, qLines(t).join(' | '));

// ============================================================ 7. R3 texts
console.log('\n== Case J: tool descriptions');
const desc = name => String(tools.find(definition => definition.name === name)?.description ?? '');
const ownerDesc = desc('collab_request_owner');
const followDesc = desc('collab_followup');
show('collab_request_owner', ownerDesc);
show('collab_followup', followDesc);
expect('J/1 request_owner: broadcast pool excludes [protected*]', ownerDesc.includes('excludes') && ownerDesc.includes('[protected*]'));
expect('J/2 request_owner: only way in = this tool or its own pull', /only way to reach one/.test(ownerDesc));
expect('J/3 followup: already queued -> no followUp needed', /collab_request_owner/.test(followDesc) && /do not register/.test(followDesc));

// ================================================ 8. owner-queue hint fields
console.log('\n== Case K: queue line format unchanged');
writeQ(OWN6, { id: qid(9000, 'k'), at: 9000, summary: 'K 行格式', issuePath: 'docs/issues/r5.md' });
const kText = await inject(OWN6);
const kQueue = qLines(kText).filter(line => line.includes('K 行格式'));
show('K injected line', kQueue.join(' | ') || '(none)');
expect(
  'K line format still `- [owner-queue] <from> @ <HH:MM>：<summary>（<path>）`',
  kQueue.length === 1 && /^- \[owner-queue\] \S+ @ \d{2}:\d{2}：K 行格式（docs\/issues\/r5\.md）$/.test(kQueue[0]),
  kQueue[0] ?? '(none)'
);


// ===================== 9. Case E2: the same gap, reached through the real tools
console.log('\n== Case E2 (own9): real `collab_request_owner {bid}` + real `collab_followup`');
const e2Bid = 'b_aaaa0000000a1212';
writeBc(e2Bid, {
  issuePath: 'docs/issues/p.md',
  from: { sid: OWN9 },
  state: 'done',
  claim: { by: 'ses_chk_by', at: 1600000000000, leaseMs: 300000 },
  receipt: { from: 'ses_chk_by', at: 1600000000000, note: 'done' },
  followUps: []
});
const call = async (name, input, sessionID) =>
  (await tools.find(definition => definition.name === name).execute(input, { sessionID, agent: 'build' })).content;
const e2Follow = await call('collab_followup', { bid: e2Bid, confirm: true }, 'ses_chk_by');
show('E2 collab_followup result', String(e2Follow).slice(0, 200));
const e2Queue = await call('collab_request_owner', { target: OWN9, text: 'E2 只有 bid 的队列项（tool）', bid: e2Bid, confirm: true }, FROM);
show('E2 collab_request_owner result', String(e2Queue).slice(0, 200));
const e2Text = await inject(OWN9);
show('E2 request 1', e2Text || '(empty)');
console.log(`  [observed] lines for the ONE bid ${e2Bid} = ${qLines(e2Text).length + fLines(e2Text).length} (1 = merged, 2 = not merged)`);

// ============================ 10. Case L: a failed push stamps nothing (F1/R2)
console.log('\n== Case L (own10): push throws -> nothing is stamped');
writeBc('b_aaaa0000000a1313', {
  issuePath: 'docs/issues/r1.md',
  from: { sid: OWN10 },
  followUps: [{ bid: 'b_aaaa0000000a1313', issuePath: 'docs/issues/r1.md', at: 1000, by: 'ses_x' }]
});
writeQ(OWN10, { id: qid(2000, 'l'), at: 2000, summary: 'L 队列', issuePath: 'docs/issues/r1.md' });
const bad = { sessionID: OWN10, agent: 'build', system: [], messages: [] };
bad.system.push = () => {
  throw new Error('boom');
};
await hooks.context(bad);
expect('L/1 a throwing push leaves the queue item unread', readQ(OWN10, qid(2000, 'l')).seenAt === null);
expect('L/2 a throwing push leaves the followUp key unwritten', seenKeys(OWN10).length === 0, JSON.stringify(seenKeys(OWN10)));
const lText = await inject(OWN10);
expect('L/3 the next request renders exactly one line for that proposal', qLines(lText).length + fLines(lText).length === 1, lText.split('\n').slice(1).join(' | '));

// ================= 11. Case M: two appends on one bid -> one line, older pending
console.log('\n== Case M (own11): two followUp entries for the same proposal');
writeBc('b_aaaa0000000a1414', {
  issuePath: 'docs/issues/f2.md',
  from: { sid: OWN11 },
  followUps: [
    { bid: 'b_aaaa0000000a1414', issuePath: 'docs/issues/f2.md', at: 1000, by: 'ses_x' },
    { bid: 'b_aaaa0000000a1414', issuePath: 'docs/issues/f2.md', at: 2000, by: 'ses_x' }
  ]
});
const m1 = await inject(OWN11);
show('M request 1', m1 || '(empty)');
expect('M/1 one line (newest append)', fLines(m1).length === 1 && m1.includes('2000') === false && fLines(m1).length === 1, fLines(m1)[0] ?? '');
expect('M/2 only the rendered entry is stamped', seenKeys(OWN11).length === 1 && seenKeys(OWN11)[0].endsWith(':2000'), JSON.stringify(seenKeys(OWN11)));
const m2 = await inject(OWN11);
expect('M/3 the older entry still comes next round', fLines(m2).length === 1 && seenKeys(OWN11).length === 2, fLines(m2)[0] ?? '');
const m3 = await inject(OWN11);
expect('M/4 nothing afterwards', fLines(m3).length === 0, m3 || '(empty)');


// ==== 12. Case N (own12): two QUEUE items for one bid, one with path, one without
console.log('\n== Case N (own12): queue item A = path+bid, queue item B = bid only');
writeQ(OWN12, { id: qid(1000, 'n'), at: 1000, summary: 'N 队列 A（带路径）', issuePath: 'docs/issues/r2.md', bid: 'b_aaaa0000000a1515' });
writeQ(OWN12, { id: qid(2000, 'n'), at: 2000, summary: 'N 队列 B（只有 bid）', issuePath: null, bid: 'b_aaaa0000000a1515' });
const nText = await inject(OWN12);
show('N request 1', nText || '(empty)');
console.log(`  [observed] lines for the ONE bid = ${qLines(nText).length} (1 = merged, 2 = not merged)`);

// -------------------------------------------------------------- summary
console.log(`\n=== ${pass} passed, ${fails.length} failed${fails.length ? `: ${fails.join(' | ')}` : ''}`);
console.log(`(temp root: ${root})`);
process.exit(fails.length ? 1 : 0);
