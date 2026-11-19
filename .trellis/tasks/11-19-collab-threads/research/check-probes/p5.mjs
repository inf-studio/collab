/** Probe 5 — read amplification of collab_threads: how many storage.get calls for a 400-thread counterpart? */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'probe5-'));
const ws = join(dir, 'ws');
mkdirSync(join(ws, 'docs', 'issues'), { recursive: true });
const indexFile = join(dir, 'collab-threads.json');
process.env.COLLAB_BROADCAST_DIR = join(dir, 'broadcast');
process.env.COLLAB_GRANT_DIR = join(dir, 'grants');
process.env.COLLAB_REPORT_DIR = join(dir, 'reports');
process.env.COLLAB_LOCK_DIR = join(dir, 'locks');
process.env.COLLAB_OWNER_QUEUE_DIR = join(dir, 'owner-queue');
process.env.COLLAB_FREEZE_FILE = join(dir, 'freeze.json');
process.env.COLLAB_THREAD_INDEX_FILE = indexFile;
process.env.COLLAB_CONFIG = join(dir, 'collab.json');
writeFileSync(process.env.COLLAB_CONFIG, JSON.stringify({ aliases: {} }));

const now = Date.now();
const entries = {};
for (let i = 0; i < 400; i += 1) {
  entries[`t_amp_${String(i).padStart(3, '0')}`] = {
    target: 'ses_peer', kind: 'messages', from: 'ses_me',
    lastAt: now - i * 1000, preview: `amp ${i}`
  };
}
writeFileSync(indexFile, JSON.stringify({ version: 1, entries }));

const plugin = (await import(`file://${resolve('/data/project/collab/dist/index.js')}`)).default;
const store = new Map();
const tools = [];
const gets = [];
const sessions = {
  ses_me: { id: 'ses_me', agent: 'build', title: 'me', time: { busy: 1 }, location: { directory: ws } },
  ses_peer: { id: 'ses_peer', agent: 'build', title: 'peer', time: { busy: 1 }, location: { directory: ws } }
};
const ctx = {
  location: { directory: ws }, options: {},
  storage: {
    async get(k) { gets.push(k); const v = store.get(k); return v === undefined ? undefined : structuredClone(v); },
    async set(k, v) { store.set(k, structuredClone(v)); },
    async remove(k) { store.delete(k); }
  },
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

gets.length = 0;
const started = performance.now();
const out = await call('collab_threads', { target: 'ses_peer' });
const elapsed = performance.now() - started;
console.log(`threads with 400 indexed rows → storage.get calls: ${gets.length}, rendered rows: ${out.split('\n').filter(l => l.startsWith('- t_')).length}, ${elapsed.toFixed(1)}ms`);

gets.length = 0;
const started2 = performance.now();
await call('collab_threads', { target: 'ses_peer', includeClosed: true });
console.log(`includeClosed → storage.get calls: ${gets.length}, ${(performance.now() - started2).toFixed(1)}ms`);
