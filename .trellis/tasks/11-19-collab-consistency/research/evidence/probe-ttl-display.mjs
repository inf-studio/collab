import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'probe-ttl-'));
process.env.COLLAB_LOCK_DIR = join(dir, 'locks');
process.env.COLLAB_CONFIG = join(dir, 'collab.json');
process.env.COLLAB_BROADCAST_DIR = join(dir, 'bc');
process.env.COLLAB_GRANT_DIR = join(dir, 'gr');
process.env.COLLAB_OWNER_QUEUE_DIR = join(dir, 'oq');
process.env.COLLAB_REPORT_DIR = join(dir, 'rp');
mkdirSync(process.env.COLLAB_LOCK_DIR, { recursive: true });
writeFileSync(process.env.COLLAB_CONFIG, JSON.stringify({ allowWrite: true, waiterTtlMs: 3600000 }));
const { lockFile } = await import('file:///data/project/collab/src/core/locks.ts');
const now = Date.now();
const rec = (resource, extra) => ({ resource, kind: 'named', mode: 'exclusive', holders: [], acquiredAt: 0, ttlMs: 0, expiresAt: 0, waiters: [], history: [], ...extra });
writeFileSync(lockFile('named:ttl-60m'), JSON.stringify(rec('named:ttl-60m', {
  holders: ['ses_h'], holder: 'ses_h', acquiredAt: now, ttlMs: 3600000, expiresAt: now + 3600000,
  waiters: [{ sid: 'ses_w20', at: now - 20 * 60_000, mode: 'exclusive' }]
})));
const mod = await import('file:///data/project/collab/dist/index.js');
const tools = [];
const sessions = { ses_h: { id: 'ses_h', agent: 'build', time: { busy: 1 }, location: { directory: dir } }, ses_new: { id: 'ses_new', agent: 'build', time: { busy: 1 }, location: { directory: dir } } };
const store = new Map();
const hooks = {};
await mod.default.setup({
  location: { directory: dir }, options: { allowWrite: true }, app: { version: 'p' },
  storage: { async get(k){return store.get(k)}, async set(k,v){store.set(k,v)}, async remove(k){store.delete(k)}, async scan(){return {entries:[]}} },
  tool: { async transform(cb){cb({add: d=>tools.push(d)}); return {dispose: async()=>{}}} },
  session: { async hook(n,cb){hooks[n]=cb; return {dispose: async()=>{}}}, async get({sessionID}){return structuredClone(sessions[sessionID])}, async list(){return {data: Object.values(sessions)}}, async context(){return []}, async prompt(){return {}}, async wait(){}, async update(){}, async switchAgent(){}, async create(){return {}}, async remove(){} },
  event: { async *subscribe(){} }
});
const call = async (n,i,s='ses_new') => (await tools.find(t=>t.name===n).execute(i,{sessionID:s,agent:'build'})).content;
console.log('--- preview (config ttl 60m, waiter 20m old):');
console.log(await call('collab_lock', { resource: 'ttl-60m', wait: true }));
console.log('--- confirm result:');
console.log(await call('collab_lock', { resource: 'ttl-60m', wait: true, confirm: true }));
console.log('--- collab_locks:');
console.log(await call('collab_locks', { resource: 'ttl-60m' }));
