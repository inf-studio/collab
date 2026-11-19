/**
 * Probe 4 — mixed handoff/messages suggestion, a hand-off record that predates
 * the index (no index row), and a closed hand-off's listing behaviour.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'probe4-'));
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

const plugin = (await import(`file://${resolve('/data/project/collab/dist/index.js')}`)).default;
const store = new Map();
const tools = [];
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
const indexJson = () => JSON.parse(existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : '{"version":1,"entries":{}}');

// 1 message thread, then a hand-off (newest) → the suggestion must be collab_status.
await call('collab_send', { target: 'ses_peer', kind: 'request', threadID: 't_msg_first', text: 'older message thread', confirm: true });
const handoff = await call('collab_handoff', { target: 'ses_peer', text: 'newest is the hand-off', expected: 'review', confirm: true });
const handoffThread = /thread=(t_[0-9a-z_]+)/.exec(handoff)?.[1] ?? '';
const list = await call('collab_threads', { target: 'ses_peer' });
console.log('--- rows:\n' + list.split('\n').filter(l => l.startsWith('- t_')).join('\n'));
console.log('--- suggestion:', list.split('\n').find(l => l.startsWith('建议:')));
console.log('CHECK suggestion → collab_status for the newest (hand-off) thread:', list.split('\n').find(l => l.startsWith('建议:'))?.includes(`collab_status {threadID:"${handoffThread}"}`) ? 'PASS' : 'FAIL');

// 2. a hand-off record with NO index row (a pre-0.7.0 thread) must still be listed.
const snap = indexJson();
const dropped = snap.entries[handoffThread];
delete snap.entries[handoffThread];
writeFileSync(indexFile, JSON.stringify(snap));
const noIndex = await call('collab_threads', { target: 'ses_peer' });
console.log('CHECK hand-off with no index row still listed (broadcast join):', noIndex.includes(handoffThread) ? 'PASS' : 'FAIL');
console.log('   row:', noIndex.split('\n').find(l => l.startsWith(`- ${handoffThread}`)));
writeFileSync(indexFile, JSON.stringify(snap)); // keep it out; not needed further

// 3. a closed hand-off leaves the default list, comes back with includeClosed.
const accept = await call('collab_accept', { bid: /bid=(b_[0-9a-f]+)/.exec(handoff)?.[1] ?? '', confirm: true }, 'ses_peer');
console.log('--- accept:', accept.split('\n')[0]);
const bid = /bid=(b_[0-9a-f]+)/.exec(handoff)?.[1] ?? '';
const done = await call('collab_reply', { threadID: handoffThread, kind: 'reply', bid, text: `[handoff] DONE ${bid} probe done`, confirm: true }, 'ses_peer');
console.log('--- done reply:', done.split('\n')[0]);
const afterDone = await call('collab_threads', { target: 'ses_peer' });
const afterDoneAll = await call('collab_threads', { target: 'ses_peer', includeClosed: true });
console.log('CHECK closed hand-off leaves the default list:', afterDone.includes(handoffThread) ? 'FAIL' : 'PASS');
console.log('CHECK … and returns with includeClosed, marked closed:', afterDoneAll.includes(handoffThread) && afterDoneAll.split('\n').find(l => l.startsWith(`- ${handoffThread}`))?.includes('（已闭环）') ? 'PASS' : 'FAIL');
console.log('   row:', afterDoneAll.split('\n').find(l => l.startsWith(`- ${handoffThread}`)));
