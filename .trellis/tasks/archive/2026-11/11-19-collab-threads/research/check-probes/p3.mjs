/**
 * Probe 3 — characterize the two interactions probe 2 surfaced:
 *  (a) includeClosed when MORE than 20 threads are unresolved (does the closed
 *      section disappear altogether?), and the `head` line's claim;
 *  (b) alias listing (the probe-2 assertion was wrong: t_dup_1 had been answered).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'probe3-'));
const ws = join(dir, 'ws');
mkdirSync(join(ws, 'docs', 'issues'), { recursive: true });
process.env.COLLAB_BROADCAST_DIR = join(dir, 'broadcast');
process.env.COLLAB_GRANT_DIR = join(dir, 'grants');
process.env.COLLAB_REPORT_DIR = join(dir, 'reports');
process.env.COLLAB_LOCK_DIR = join(dir, 'locks');
process.env.COLLAB_OWNER_QUEUE_DIR = join(dir, 'owner-queue');
process.env.COLLAB_FREEZE_FILE = join(dir, 'freeze.json');
process.env.COLLAB_THREAD_INDEX_FILE = join(dir, 'collab-threads.json');
process.env.COLLAB_CONFIG = join(dir, 'collab.json');
writeFileSync(process.env.COLLAB_CONFIG, JSON.stringify({ aliases: { peer: 'ses_peer' } }));

const plugin = (await import(`file://${resolve('/data/project/collab/dist/index.js')}`)).default;
const store = new Map();
const tools = [];
const now = Date.now();
const sessions = {
  ses_me: { id: 'ses_me', agent: 'build', title: 'me', time: { busy: 1 }, location: { directory: ws } },
  ses_peer: { id: 'ses_peer', agent: 'build', title: 'peer', time: { busy: 1 }, location: { directory: ws } }
};
const ctx = {
  location: { directory: ws }, options: {},
  storage: { async get(k) { const v = store.get(k); return v === undefined ? undefined : structuredClone(v); }, async set(k, v) { store.set(k, structuredClone(v)); }, async remove(k) { store.delete(k); } },
  tool: { async transform(cb) { cb({ add: d => tools.push(d) }); return { dispose: async () => {} }; } },
  session: {
    async hook() { return { dispose: async () => {} }; },
    async get({ sessionID }) { return structuredClone(sessions[sessionID]); },
    async list() { return { data: structuredClone(Object.values(sessions)) }; },
    async context() { return []; },
    async update() {}, async switchAgent() {},
    async prompt(input) { return { id: 'm', delivery: input.delivery }; },
    async wait() {}, async create() { throw new Error('no'); }, async remove() {}
  },
  event: { async *subscribe() {} }
};
const silenced = console.error;
console.error = () => {};
await plugin.setup(ctx);
console.error = silenced;
const call = async (n, i, sid = 'ses_me') => (await tools.find(d => d.name === n).execute(i, { sessionID: sid, agent: 'build' })).content;

// 22 unresolved threads + 2 answered ones
for (let i = 0; i < 22; i += 1) {
  await call('collab_send', { target: 'ses_peer', kind: 'request', threadID: `t_open_${String(i).padStart(2, '0')}`, text: `open ${i}`, confirm: true });
}
for (const id of ['t_done_a', 't_done_b']) {
  await call('collab_send', { target: 'ses_peer', kind: 'request', threadID: id, text: `done ${id}`, confirm: true });
  await call('collab_reply', { threadID: id, text: `ok ${id}`, confirm: true }, 'ses_peer');
}
const openOnly = await call('collab_threads', { target: 'ses_peer' });
const withClosed = await call('collab_threads', { target: 'ses_peer', includeClosed: true });
console.log('--- head (default):', openOnly.split('\n')[0]);
console.log('--- head (includeClosed):', withClosed.split('\n')[0]);
console.log('--- closed rows shown:', withClosed.split('\n').filter(l => l.includes('（已闭环）')).length);
console.log('--- rows:', withClosed.split('\n').filter(l => l.startsWith('- t_')).length);
console.log('--- tail:', withClosed.split('\n').slice(-3).join(' | '));
const byAlias = await call('collab_threads', { target: 'peer' });
console.log('--- alias head:', byAlias.split('\n')[0]);
console.log('--- alias rows include t_open_00:', byAlias.includes('t_open_00'));

// and the <=20 case (the documented behaviour)
for (let i = 22; i < 22; i += 1) {}
