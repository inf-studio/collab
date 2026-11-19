/**
 * Delta probe (round 2): config typo fallback / clamping / unlock-vs-acquire consistency.
 * Temp dirs only; never touches ~/.config.
 */
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'probe-delta-'));
process.env.COLLAB_LOCK_DIR = join(dir, 'locks');
process.env.COLLAB_CONFIG = join(dir, 'collab.json');
process.env.COLLAB_BROADCAST_DIR = join(dir, 'bc');
process.env.COLLAB_GRANT_DIR = join(dir, 'gr');
process.env.COLLAB_OWNER_QUEUE_DIR = join(dir, 'oq');
process.env.COLLAB_REPORT_DIR = join(dir, 'rp');
mkdirSync(process.env.COLLAB_LOCK_DIR, { recursive: true });

const configPath = process.env.COLLAB_CONFIG;
let cfg = { allowWrite: true };
const writeCfg = next => {
  cfg = { allowWrite: true, ...next };
  writeFileSync(configPath, JSON.stringify(cfg));
  // the config reader caches by mtime: force a distinct stamp
  const t = new Date(Date.now() + 1000);
  utimesSync(configPath, t, t);
};
writeCfg({});

const mod = await import('file:///data/project/collab/dist/index.js');
const { lockFile } = await import('file:///data/project/collab/src/core/locks.ts');
const { loadConfig } = await import('file:///data/project/collab/src/config.ts');
const { normalizeWaiterTtl } = await import('file:///data/project/collab/src/core/locks.ts');

const results = [];
const check = (title, ok, detail = '') => {
  results.push({ title, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${title}${detail ? ` | ${detail}` : ''}`);
};

// ---------------------------------------------------------------- config values
const viaFile = value => {
  writeFileSync(configPath, JSON.stringify({ waiterTtlMs: value }));
  const t = new Date(Date.now() + 1000);
  utimesSync(configPath, t, t);
  const ms = loadConfig({}).waiterTtlMs;
  // loadConfig is stateless; drop any nothing-cache (createConfigReader not used here)
  return ms;
};
const tenMin = 600000;
for (const [label, value] of [
  ['"10m"', '10m'],
  ['"60000"', '60000'],
  ['null', null],
  ['-1', -1],
  ['0', 0],
  ['true', true],
  ['[]', []]
]) {
  const got = viaFile(value);
  check(`config waiterTtlMs=${label} → default 10min`, got === tenMin, `got ${got}`);
}
check('normalizeWaiterTtl("60000") → 10min (string rejected)', normalizeWaiterTtl('60000') === tenMin, `${normalizeWaiterTtl('60000')}`);
check('normalizeWaiterTtl("10m") → 10min', normalizeWaiterTtl('10m') === tenMin, `${normalizeWaiterTtl('10m')}`);

// explicit numbers still clamp to [1min, 60min]
for (const [value, want] of [
  [60_000, 60_000],
  [90_000, 90_000],
  [30_000, 60_000],
  [3_599_999, 3_599_999],
  [1_000_000_000, 3_600_000],
  [600_000.9, 600_000]
]) {
  const a = viaFile(value);
  const b = normalizeWaiterTtl(value);
  check(`waiterTtlMs=${value} clamps to ${want}`, a === want && b === want, `config ${a} / fn ${b}`);
}
writeCfg({});

// ---------------------------------------------------------------- fake host
const tools = [];
const sessions = {
  ses_hold: { id: 'ses_hold', agent: 'build', time: { busy: 1 }, location: { directory: dir } },
  ses_new: { id: 'ses_new', agent: 'build', time: { busy: 1 }, location: { directory: dir } },
  ses_out: { id: 'ses_out', agent: 'build', time: { busy: 1 }, location: { directory: dir } }
};
const store = new Map();
const origErr = console.error;
console.error = () => {};
await mod.default.setup({
  location: { directory: dir },
  options: { allowWrite: true },
  app: { version: 'probe' },
  storage: { async get(k) { return store.get(k); }, async set(k, v) { store.set(k, v); }, async remove(k) { store.delete(k); }, async scan() { return { entries: [] }; } },
  tool: { async transform(cb) { cb({ add: d => tools.push(d) }); return { dispose: async () => {} }; } },
  session: {
    async hook() { return { dispose: async () => {} }; },
    async get({ sessionID }) { return structuredClone(sessions[sessionID]); },
    async list() { return { data: Object.values(sessions) }; },
    async context() { return []; },
    async prompt() { return {}; },
    async wait() {},
    async update() {},
    async switchAgent() {},
    async create() { return {}; },
    async remove() {}
  },
  event: { async *subscribe() {} }
});
console.error = origErr;

const call = async (name, input, sid = 'ses_new') => (await tools.find(t => t.name === name).execute(input, { sessionID: sid, agent: 'build' })).content;
const seed = (resource, waiters, extra = {}) => {
  const now = Date.now();
  writeFileSync(lockFile(resource), JSON.stringify({
    resource, kind: 'named', mode: 'exclusive', holders: [], acquiredAt: 0, ttlMs: 0, expiresAt: 0,
    waiters, history: [], ...extra
  }));
};

// ---------------------------------------------- e2e: typo must mean 10min, not 1min
for (const [label, value, staleWanted] of [
  ['"10m"', '10m', false],
  ['"60000"', '60000', false],
  ['60000 (real number)', 60000, true],
  ['3600000 (real number)', 3_600_000, false]
]) {
  writeCfg({ waiterTtlMs: value });
  seed('named:e2e-ttl', [{ sid: 'ses_w5', at: Date.now() - 5 * 60_000, mode: 'exclusive' }], {
    holders: ['ses_hold'], holder: 'ses_hold', acquiredAt: Date.now(), ttlMs: 3_600_000, expiresAt: Date.now() + 3_600_000
  });
  const out = await call('collab_locks', { resource: 'e2e-ttl' }, 'ses_out');
  const line = out.split('\n').find(l => l.includes('e2e-ttl')) ?? '';
  check(`e2e waiterTtlMs=${label}: 5m waiter ${staleWanted ? 'IS' : 'is NOT'} [stale]`, line.includes('[stale]') === staleWanted, line.trim());
}

// ------------------------------------- unlock preview vs confirm must not contradict
writeCfg({ waiterTtlMs: 3_600_000 });
seed('named:unlock-ttl', [{ sid: 'ses_w20', at: Date.now() - 20 * 60_000, mode: 'exclusive' }], {
  holders: ['ses_hold'], holder: 'ses_hold', acquiredAt: Date.now(), ttlMs: 3_600_000, expiresAt: Date.now() + 3_600_000
});
const preview = await call('collab_unlock', { resource: 'unlock-ttl' }, 'ses_out'); // ses_out is not the holder
const confirmed = await call('collab_unlock', { resource: 'unlock-ttl', confirm: true }, 'ses_out');
check('unlock preview has no false [stale] (60m config)', !preview.includes('[stale]'), preview.split('\n').find(l => l.includes('waiters=')));
check('unlock confirm has no false [stale] (60m config)', !confirmed.includes('[stale]'), confirmed.split('\n').find(l => l.includes('waiters=')));
check('unlock preview/confirm are consistent', preview.includes('[stale]') === confirmed.includes('[stale]'));

writeCfg({ waiterTtlMs: 60_000 });
seed('named:unlock-ttl2', [{ sid: 'ses_w20', at: Date.now() - 20 * 60_000, mode: 'exclusive' }], {
  holders: ['ses_hold'], holder: 'ses_hold', acquiredAt: Date.now(), ttlMs: 3_600_000, expiresAt: Date.now() + 3_600_000
});
const p2 = await call('collab_unlock', { resource: 'unlock-ttl2' }, 'ses_out');
const c2 = await call('collab_unlock', { resource: 'unlock-ttl2', confirm: true }, 'ses_out');
check('unlock both mark [stale] when the configured TTL says so (1min)', p2.includes('[stale]') && c2.includes('[stale]'), `${p2.includes('[stale]')}/${c2.includes('[stale]')}`);

// holder unlock path: success message + state
writeCfg({ waiterTtlMs: 3_600_000 });
seed('named:unlock-ok', [{ sid: 'ses_w20', at: Date.now() - 20 * 60_000, mode: 'exclusive' }], {
  holders: ['ses_hold'], holder: 'ses_hold', acquiredAt: Date.now(), ttlMs: 3_600_000, expiresAt: Date.now() + 3_600_000
});
const ok = await call('collab_unlock', { resource: 'unlock-ok', confirm: true }, 'ses_hold');
check('holder unlock succeeds and keeps the 20m waiter listed as live', /已释放资源租约/.test(ok) && ok.includes('排队 1 人') && !ok.includes('[stale]'), ok.replace(/\n/g, ' | ').slice(0, 200));

const failed = results.filter(r => !r.ok);
console.log(`\n=== delta probe: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED: ' + failed.map(f => f.title).join(' | '));
  process.exit(1);
}
