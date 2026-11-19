/**
 * Independent probe for .trellis/tasks/11-19-collab-consistency (check agent).
 * Every check is written from the PRD/design, not copied from the impl's tests.
 * Uses its own temp dirs; never touches ~/.config.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'probe-consistency-'));
process.env.COLLAB_BROADCAST_DIR = join(dir, 'broadcast');
process.env.COLLAB_GRANT_DIR = join(dir, 'grants');
const lockDir = join(dir, 'locks');
process.env.COLLAB_LOCK_DIR = lockDir;
process.env.COLLAB_OWNER_QUEUE_DIR = join(dir, 'owner-queue');
process.env.COLLAB_REPORT_DIR = join(dir, 'reports');
mkdirSync(lockDir, { recursive: true });
const configPath = join(dir, 'collab.json');
process.env.COLLAB_CONFIG = configPath;
const WS = join(dir, 'ws');
const dist = resolve('/data/project/collab/dist/index.js');

writeFileSync(configPath, JSON.stringify({ allowWrite: true }));

const mod = await import(`file://${dist}`);
const plugin = mod.default;
const { countsOf, pendingCountOf, buildSnapshot } = mod.__internals;
const { lockFile, readLock } = await import('file:///data/project/collab/src/core/locks.ts');

// ---------------------------------------------------------------- fake host
const tools = [];
const hooks = {};
const prompts = [];
const rpcHandlers = {};
const sessions = {
  ses_aaa: { id: 'ses_aaa', agent: 'build', title: 'A', time: { busy: 1 }, location: { directory: WS } },
  ses_bbb: { id: 'ses_bbb', agent: 'build', title: 'B', time: { busy: 1 }, location: { directory: WS } },
  ses_d: { id: 'ses_d', agent: 'build', title: 'D', time: { busy: 1 }, location: { directory: WS } },
  ses_hb: { id: 'ses_hb', agent: 'build', title: 'HB', time: { busy: 1 }, location: { directory: WS } },
  ses_hb2: { id: 'ses_hb2', agent: 'build', title: 'HB2', time: { busy: 1 }, location: { directory: WS } },
  ses_hb3: { id: 'ses_hb3', agent: 'build', title: 'HB3', time: { busy: 1 }, location: { directory: WS } },
  ses_holder: { id: 'ses_holder', agent: 'build', title: 'holder', time: { busy: 1 }, location: { directory: WS } }
};
const store = new Map();
const ctx = {
  location: { directory: WS },
  options: { allowWrite: true },
  app: { version: 'probe' },
  storage: {
    async get(key) { return store.has(key) ? structuredClone(store.get(key)) : undefined; },
    async set(key, value) { store.set(key, structuredClone(value)); },
    async remove(key) { store.delete(key); },
    async scan() { return { entries: [] }; }
  },
  tool: { async transform(cb) { cb({ add: d => tools.push(d) }); return { dispose: async () => {} }; } },
  session: {
    async hook(name, cb) { hooks[name] = cb; return { dispose: async () => {} }; },
    async get({ sessionID }) { if (!sessions[sessionID]) throw new Error('no session ' + sessionID); return structuredClone(sessions[sessionID]); },
    async list({ limit = 20, directory } = {}) {
      return { data: Object.values(sessions).filter(s => !directory || s.location?.directory === directory).slice(0, limit).map(s => structuredClone(s)) };
    },
    async context() { return []; },
    async prompt(input) { prompts.push(input); return { id: `msg_${prompts.length}`, delivery: input.delivery }; },
    async wait() {},
    async update() {},
    async switchAgent() {},
    async create(input = {}) { const info = { id: 'ses_spawn', ...input, time: {} }; sessions[info.id] = info; return structuredClone(info); },
    async remove() {}
  },
  event: { async *subscribe() {} },
  rpc: {
    async register(schema, methods) {
      Object.assign(rpcHandlers, methods);
      return { dispose: async () => {} };
    }
  }
};
const logs = [];
const origErr = console.error;
console.error = (...a) => logs.push(a.join(' '));
await plugin.setup(ctx);
console.error = origErr;

const tool = name => tools.find(t => t.name === name);
const call = async (name, input, sessionID = 'ses_aaa') => (await tool(name).execute(input, { sessionID, agent: 'build' })).content;

// ---------------------------------------------------------------- helpers
const results = [];
const check = (title, ok, detail = '') => {
  results.push({ title, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${title}${detail ? ` | ${detail}` : ''}`);
};
const h = text => createHash('sha1').update(text).digest('hex').slice(0, 12);
const lockFiles = () => {
  try { return readdirSync(lockDir).filter(n => n.endsWith('.json')).sort(); } catch { return []; }
};
const dirState = () => lockFiles().map(name => {
  const p = join(lockDir, name);
  const st = statSync(p);
  return `${name}:${st.mtimeMs}:${h(readFileSync(p, 'utf8'))}`;
}).join('|');
const writeLockFile = (resource, record) => {
  writeFileSync(lockFile(resource), JSON.stringify(record, null, 2));
};
const baseRecord = (resource, extra = {}) => ({
  resource, kind: 'named', mode: 'exclusive', holders: [], acquiredAt: 0, ttlMs: 0, expiresAt: 0,
  waiters: [], history: [], ...extra
});
const waitersOf = resource => {
  const rec = readLock(resource);
  return Array.isArray(rec?.waiters) ? rec.waiters : null;
};

// ============================================================ 1) deadlock
{
  const resource = 'named:stale-queue';
  const now = Date.now();
  const old = now - 30 * 60 * 1000;
  writeLockFile(resource, baseRecord(resource, {
    waiters: [
      { sid: 'ses_x1', at: old, mode: 'exclusive' },
      { sid: 'ses_x2', at: old + 1, mode: 'exclusive' },
      { sid: 'ses_x3', at: old + 2, mode: 'exclusive' }
    ]
  }));
  const out = await call('collab_lock', { resource: 'stale-queue', confirm: true }, 'ses_d');
  const rec = readLock(resource);
  check('1a free + 3 over-TTL waiters → granted', /已获得资源租约/.test(out), out.split('\n')[0]);
  check('1b the 3 expired waiters are gone', rec.waiters.length === 0 && rec.holders.includes('ses_d'), JSON.stringify(rec.waiters));
  check('1c each reaped waiter leaves history reason=stale', (rec.history || []).filter(e => e.reason === 'stale').length === 3, JSON.stringify((rec.history || []).slice(-3)));
}
{
  const resource = 'named:fresh-queue';
  writeLockFile(resource, baseRecord(resource, {
    waiters: [{ sid: 'ses_w1', at: Date.now(), mode: 'exclusive' }]
  }));
  const out = await call('collab_lock', { resource: 'fresh-queue', confirm: true }, 'ses_d');
  const rec = readLock(resource);
  check('1d free + 1 fresh waiter → wait:false still refuses the newcomer (no jump)', /未获得资源租约/.test(out) && rec.holders.length === 0, out.split('\n')[0]);
  const queued = await call('collab_lock', { resource: 'fresh-queue', wait: true, confirm: true }, 'ses_d');
  const rec2 = readLock(resource);
  check('1e wait:true queues behind the fresh waiter (position 2)', rec2.waiters[0]?.sid === 'ses_w1' && rec2.waiters[1]?.sid === 'ses_d', `out=${queued.split('\n')[0]} waiters=${JSON.stringify(rec2.waiters.map(w => w.sid))}`);
}

// ============================================================ 2) heartbeat
const heldByOther = (resource, extras = {}) => {
  const now = Date.now();
  writeLockFile(resource, baseRecord(resource, {
    holders: ['ses_holder'], holder: 'ses_holder', acquiredAt: now, ttlMs: 60 * 60 * 1000, expiresAt: now + 60 * 60 * 1000, ...extras
  }));
};
const hbReading = (resource, sid) => {
  const rec = readLock(resource);
  return { at: rec.waiters.find(w => w.sid === sid)?.at, mtime: statSync(lockFile(resource)).mtimeMs };
};
{
  const resource = 'named:hb-lock';
  const old = Date.now() - 5 * 60 * 1000;
  heldByOther(resource, { waiters: [{ sid: 'ses_hb', at: old, mode: 'exclusive' }] });
  const before = hbReading(resource, 'ses_hb');
  await call('collab_lock', { resource: 'hb-lock', wait: true, confirm: true }, 'ses_hb');
  const after = hbReading(resource, 'ses_hb');
  check('2a collab_lock refreshes the waiter heartbeat', after.at > before.at, `${before.at} → ${after.at} mtime ${before.mtime} → ${after.mtime}`);
  const mid = hbReading(resource, 'ses_hb');
  await new Promise(r => setTimeout(r, 15));
  await call('collab_lock', { resource: 'hb-lock', wait: true, confirm: true }, 'ses_hb');
  const after2 = hbReading(resource, 'ses_hb');
  check('2b 30s throttle: immediate second call does not move the heartbeat', after2.at === mid.at, `${mid.at}/${after2.at}`);
}
{
  const resource = 'named:hb-hook';
  const old = Date.now() - 5 * 60 * 1000;
  heldByOther(resource, { waiters: [{ sid: 'ses_hb2', at: old, mode: 'exclusive' }] });
  await new Promise(r => setTimeout(r, 15));
  const before = hbReading(resource, 'ses_hb2');
  await hooks.context({ sessionID: 'ses_hb2', agent: 'build', system: [], messages: [] });
  const after = hbReading(resource, 'ses_hb2');
  check('2c context hook refreshes the heartbeat', after.at > before.at && after.mtime > before.mtime, `${before.at} → ${after.at} mtime ${before.mtime} → ${after.mtime}`);
  const mid = hbReading(resource, 'ses_hb2');
  await new Promise(r => setTimeout(r, 15));
  await hooks.context({ sessionID: 'ses_hb2', agent: 'build', system: [], messages: [] });
  const after2 = hbReading(resource, 'ses_hb2');
  check('2d context hook within 30s writes nothing', after2.mtime === mid.mtime && after2.at === mid.at, `${mid.mtime} → ${after2.mtime}`);
}
{
  // ③ a writing collab tool (collab_send) touches the sender's heartbeat
  const resource = 'named:hb-send';
  const old = Date.now() - 5 * 60 * 1000;
  heldByOther(resource, { waiters: [{ sid: 'ses_aaa', at: old, mode: 'exclusive' }] });
  const before = hbReading(resource, 'ses_aaa').at;
  await new Promise(r => setTimeout(r, 15));
  const sent = await call('collab_send', { target: 'ses_bbb', text: 'heartbeat probe ' + Date.now(), confirm: true }, 'ses_aaa');
  const after = hbReading(resource, 'ses_aaa').at;
  check('2e a writing collab tool refreshes the heartbeat', after > before, `${before} → ${after} (${sent.split('\n')[0]})`);
}
{
  // read commands are not a heartbeat
  const resource = 'named:hb-read';
  const old = Date.now() - 5 * 60 * 1000;
  heldByOther(resource, { waiters: [{ sid: 'ses_aaa', at: old, mode: 'exclusive' }] });
  const before = dirState();
  await call('collab_locks', {}, 'ses_aaa');
  const after = dirState();
  check('2f collab_locks is not a heartbeat (no write)', before === after);
}
{
  // waiterHeartbeat:false → the context hook must not write
  const resource = 'named:hb-off';
  const old = Date.now() - 5 * 60 * 1000;
  heldByOther(resource, { waiters: [{ sid: 'ses_hb3', at: old, mode: 'exclusive' }] });
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...cfg, waiterHeartbeat: false }));
  utimesSync(configPath, new Date(), new Date(Date.now() + 2000));
  const before = hbReading(resource, 'ses_hb3');
  await new Promise(r => setTimeout(r, 15));
  await hooks.context({ sessionID: 'ses_hb3', agent: 'build', system: [], messages: [] });
  const after = hbReading(resource, 'ses_hb3');
  check('2g waiterHeartbeat:false → context hook writes nothing', before.mtime === after.mtime && before.at === after.at, `${before.mtime} → ${after.mtime}`);
  writeFileSync(configPath, JSON.stringify(cfg));
  utimesSync(configPath, new Date(), new Date(Date.now() + 4000));
}

// ============================================================ 3) read-only
{
  const before = dirState();
  await call('collab_locks', {}, 'ses_aaa');
  const snapshot = await rpcHandlers.snapshot?.({ session: 'ses_aaa' });
  const after = dirState();
  check('3a collab_locks leaves every lock file byte-identical', before === after);
  check('3b snapshot RPC leaves every lock file byte-identical', before === dirState(), `snapshotKeys=${snapshot ? Object.keys(snapshot).join(',') : 'n/a'}`);
  check('3c snapshot exposes the optional waiter fields', Boolean(snapshot?.locks?.some(l => l.stale === true || Array.isArray(l.waiterAgeMs))), JSON.stringify(snapshot?.locks?.find(l => l.stale)));
}

// ============================================================ 4) four counts
{
  const snapshot = {
    locks: [
      { holders: ['a'], waiters: 2 },
      { holders: [], waiters: 1 }
    ],
    queue: [{}, {}]
  };
  const c = countsOf(snapshot);
  check('4a countsOf: held = holders>0, waiting = Σwaiters, protected = queue', c.held === 1 && c.waiting === 3 && c.protected === 2, JSON.stringify(c));
  check('4b countsOf tolerates a missing snapshot', JSON.stringify(countsOf(undefined)) === JSON.stringify({ held: 0, waiting: 0, protected: 0 }));
  check('4c pendingCountOf: throwing list → 0 (no throw)', pendingCountOf({ list() { throw new Error('boom'); } }, 'ses_a') === 0);
  check('4d pendingCountOf: missing api → 0', pendingCountOf(undefined, 'ses_a') === 0);
  check('4e pendingCountOf: counts the host queue', pendingCountOf({ list: sid => (sid === 'ses_a' ? [1, 2] : []) }, 'ses_a') === 2);
  // same source: GUI and TUI both import counts.ts, not their own arithmetic
  const gui = readFileSync('/data/project/collab/src/gui.tsx', 'utf8');
  const tui = readFileSync('/data/project/collab/src/tui.tsx', 'utf8');
  check('4f GUI header uses countsOf + host pending',
    /countsOf\(data\)/.test(gui) && /hostPending\(ctx\.sessions\.current\(\)\)/.test(gui) && /pendingCountOf\(pending/.test(gui));
  check('4g TUI sidebar + panel both use countsOf + pendingCountOf',
    (tui.match(/countsOf\(data\)/g) || []).length >= 2 && (tui.match(/pendingCountOf\(/g) || []).length >= 2);
}

// ============================================================ 5) dedupe
{
  const realNow = Date.now;
  const base = realNow();
  let fake = base;
  Date.now = () => fake;
  try {
    const thread = 't_probe_dedupe';
    const text = 'same body with\n  different   spacing';
    const first = await call('collab_send', { target: 'ses_bbb', text, threadID: thread, confirm: true }, 'ses_aaa');
    check('5a first send is delivered', /已投递/.test(first), first.split('\n')[0]);
    const beforeCount = prompts.length;
    const second = await call('collab_send', { target: 'ses_bbb', text: 'same body with different spacing', threadID: thread, confirm: true }, 'ses_aaa');
    check('5b same thread + normalised body <60s → not delivered', /未重复投递/.test(second) && prompts.length === beforeCount, second.split('\n')[0]);
    const threadData = store.get(`collab/threads/${thread}`) ?? [...store.entries()].find(([k]) => k.includes(thread))?.[1];
    const msgs = threadData?.msgs ?? [];
    check('5c the duplicate is not appended to the thread either', msgs.length === 1, `msgs=${msgs.length}`);
    const third = await call('collab_send', { target: 'ses_bbb', text: 'a different body', threadID: thread, confirm: true }, 'ses_aaa');
    check('5d a different body is delivered', /已投递/.test(third), third.split('\n')[0]);
    // reply path
    const replyText = 'reply body probe';
    const r1 = await call('collab_reply', { threadID: thread, text: replyText, confirm: true }, 'ses_bbb');
    const beforeReply = prompts.length;
    const r2 = await call('collab_reply', { threadID: thread, text: replyText, confirm: true }, 'ses_bbb');
    check('5e collab_reply: same body <60s → not delivered', /未重复投递/.test(r2) && prompts.length === beforeReply, `${r1.split('\n')[0]} || ${r2.split('\n')[0]}`);
    // 61s later the same body is a new message (no over-eager dedupe)
    fake = base + 61_000;
    const late = await call('collab_send', { target: 'ses_bbb', text, threadID: thread, confirm: true }, 'ses_aaa');
    check('5f 61s later the same body is delivered again', /已投递/.test(late), late.split('\n')[0]);
    // window 0 disables
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    writeFileSync(configPath, JSON.stringify({ ...cfg, dedupeWindowMs: 0 }));
    utimesSync(configPath, new Date(), new Date(Date.now() + 6000));
    const d1 = await call('collab_send', { target: 'ses_bbb', text: 'window off probe', threadID: 't_probe_off', confirm: true }, 'ses_aaa');
    const d2 = await call('collab_send', { target: 'ses_bbb', text: 'window off probe', threadID: 't_probe_off', confirm: true }, 'ses_aaa');
    check('5g dedupeWindowMs:0 disables the check (2 deliveries)', /已投递/.test(d1) && /已投递/.test(d2), `${d1.split('\n')[0]} || ${d2.split('\n')[0]}`);
    writeFileSync(configPath, JSON.stringify(cfg));
    utimesSync(configPath, new Date(), new Date(Date.now() + 8000));
  } finally {
    Date.now = realNow;
  }
}

// ============================================================ 6) compatibility
{
  const resource = 'named:legacy-old';
  writeLockFile(resource, {
    resource, kind: 'named', mode: 'exclusive', holders: [], acquiredAt: 0, ttlMs: 0, expiresAt: 0,
    waiters: [{ sid: 'ses_legacy1', at: Date.now() - 3600_000, mode: 'exclusive' }], history: []
  });
  const out = await call('collab_lock', { resource: 'legacy-old', confirm: true }, 'ses_d');
  check('6a old record with a very old `at` is reaped, no crash', /已获得资源租约/.test(out), out.split('\n')[0]);
}
{
  const resource = 'named:legacy-missing';
  writeLockFile(resource, {
    resource, kind: 'named', mode: 'exclusive', holders: [], acquiredAt: 0, ttlMs: 0, expiresAt: 0,
    waiters: [{ sid: 'ses_legacy2', mode: 'exclusive' }], history: []
  });
  const out = await call('collab_lock', { resource: 'legacy-missing', confirm: true }, 'ses_d');
  check('6b a waiter without `at` is treated as stale, no crash', /已获得资源租约/.test(out), out.split('\n')[0]);
}
{
  const resource = 'named:legacy-shape';
  writeLockFile(resource, {
    resource, kind: 'named', mode: 'exclusive', holders: ['ses_x'], acquiredAt: Date.now(), ttlMs: 60000, expiresAt: Date.now() + 60000,
    waiters: [{ sid: 'ses_legacy3', at: 'not-a-number', mode: 'exclusive' }], history: []
  });
  const out = await call('collab_locks', { resource: 'legacy-shape' }, 'ses_aaa');
  check('6c a non-numeric `at` renders (does not throw)', /waiters=/.test(out), out.split('\n').slice(1, 2).join(' '));
}
{
  // old server reply (no new optional fields) must not break the consumers
  const oldSnapshot = { locks: [{ resource: 'named:x', kind: 'named', mode: 'exclusive', free: false, holders: ['a'], waiters: 1, waiting: ['a'], expiresInMs: 1 }], queue: [], handoffs: [], sessions: [] };
  check('6d countsOf works on an old snapshot without the new fields', JSON.stringify(countsOf(oldSnapshot)) === JSON.stringify({ held: 1, waiting: 1, protected: 0 }));
  const built = buildSnapshot ? 'exported' : 'missing';
  check('6e buildSnapshot is still exported (no signature break)', built === 'exported', built);
}

// ============================================================ summary
const failed = results.filter(r => !r.ok);
console.log(`\n=== probe: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED: ' + failed.map(f => f.title).join(' | '));
  process.exit(1);
}
console.log('tmp=' + dir);
