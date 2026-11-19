/**
 * Check-agent probe (independent of the harness): write-point negatives, alias,
 * 20-row cap, thread-store-only downgrade, mixed suggestion.
 * Fresh temp dirs; never touches ~/.config/opencode.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'probe-tools-'));
const ws = join(dir, 'ws');
mkdirSync(join(ws, 'docs', 'issues'), { recursive: true });
const indexFile = join(dir, 'collab-threads.json');
const broadcastDir = join(dir, 'broadcast');
process.env.COLLAB_BROADCAST_DIR = broadcastDir;
process.env.COLLAB_GRANT_DIR = join(dir, 'grants');
process.env.COLLAB_REPORT_DIR = join(dir, 'reports');
process.env.COLLAB_LOCK_DIR = join(dir, 'locks');
process.env.COLLAB_OWNER_QUEUE_DIR = join(dir, 'owner-queue');
process.env.COLLAB_FREEZE_FILE = join(dir, 'freeze.json');
process.env.COLLAB_THREAD_INDEX_FILE = indexFile;
const cfgPath = join(dir, 'collab.json');
process.env.COLLAB_CONFIG = cfgPath;
writeFileSync(
  cfgPath,
  JSON.stringify({ aliases: { peer: 'ses_peer' }, protect: ['ses_guarded'] }, null, 2)
);

const plugin = (await import(`file://${resolve('/data/project/collab/dist/index.js')}`)).default;

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const store = new Map();
const prompts = [];
const tools = [];
const now = Date.now();
let promptFails = false;
const sessions = {
  ses_me: { id: 'ses_me', agent: 'build', title: 'me', time: { busy: 1 }, location: { directory: ws } },
  ses_peer: { id: 'ses_peer', agent: 'build', title: 'peer', time: { busy: 1 }, location: { directory: ws } },
  ses_guarded: { id: 'ses_guarded', agent: 'build', title: 'guarded', time: { busy: 1 }, location: { directory: ws } }
};
const ctx = {
  location: { directory: ws },
  options: {},
  storage: {
    async get(key) {
      const v = store.get(key);
      return v === undefined ? undefined : structuredClone(v);
    },
    async set(key, value) {
      store.set(key, structuredClone(value));
    },
    async remove(key) {
      store.delete(key);
    }
  },
  tool: {
    async transform(cb) {
      cb({ add: d => tools.push(d) });
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
    async list() {
      return { data: structuredClone(Object.values(sessions)) };
    },
    async context() {
      return [];
    },
    async update() {},
    async switchAgent() {},
    async prompt(input) {
      if (promptFails) throw new Error('boom: provider 500');
      prompts.push(input);
      return { id: `msg_${prompts.length}`, delivery: input.delivery };
    },
    async wait() {},
    async create() {
      throw new Error('not used');
    },
    async remove() {}
  },
  event: {
    async *subscribe() {}
  }
};
const silenced = console.error;
console.error = () => {};
await plugin.setup(ctx);
console.error = silenced;

const tool = name => tools.find(d => d.name === name);
const call = async (name, input, sid = 'ses_me') => (await tool(name).execute(input, { sessionID: sid, agent: 'build' })).content;
const indexRaw = () => (existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : '');
const indexJson = () => JSON.parse(indexRaw() || '{"version":1,"entries":{}}');
const hashes = p => {
  const out = {};
  const walk = d => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, name.name);
      if (name.isDirectory()) walk(full);
      else out[full] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  if (existsSync(p)) walk(p);
  return out;
};

// ---------- 1a. preview writes nothing
const stamp0 = existsSync(indexFile) ? statSync(indexFile).mtimeMs : 'missing';
const preview = await call('collab_send', { target: 'ses_peer', kind: 'note', threadID: 't_preview_1', text: 'preview only', confirm: false });
check('preview: index untouched', preview.startsWith('未投递') && (existsSync(indexFile) ? statSync(indexFile).mtimeMs : 'missing') === stamp0 && !indexJson().entries.t_preview_1);

// ---------- 1b. guard refusal writes nothing
let guardErr = '';
try {
  await call('collab_send', { target: 'ses_guarded', kind: 'note', threadID: 't_guard_1', text: 'blocked by protect', confirm: true });
} catch (error) {
  guardErr = String(error?.message ?? error);
}
check(
  'protect refusal: no index entry, error still readable',
  /protect/.test(guardErr) && !indexJson().entries.t_guard_1 && prompts.length === 0,
  guardErr.slice(0, 60)
);

// ---------- 1c. delivery failure writes nothing
promptFails = true;
let deliveryErr = '';
try {
  await call('collab_send', { target: 'ses_peer', kind: 'note', threadID: 't_fail_1', text: 'delivery fails', confirm: true });
} catch (error) {
  deliveryErr = String(error?.message ?? error);
}
promptFails = false;
check('delivery failure: no index entry', Boolean(deliveryErr) && !indexJson().entries.t_fail_1, deliveryErr.slice(0, 80));

// ---------- 1d. duplicate (dedupe) writes nothing new
const first = await call('collab_send', { target: 'ses_peer', kind: 'note', threadID: 't_dup_1', text: 'same body once', confirm: true });
const beforeDup = indexRaw();
const dup = await call('collab_send', { target: 'ses_peer', kind: 'note', threadID: 't_dup_2', text: 'same body once', confirm: true });
check(
  'deduped send (target dimension): no new index entry',
  first.startsWith('已投递') && dup.startsWith('未重复投递') && !indexJson().entries.t_dup_2 && indexRaw() === beforeDup
);

// ---------- 1e. success writes (send / reply / handoff)
check('successful send indexed', indexJson().entries.t_dup_1?.kind === 'messages' && indexJson().entries.t_dup_1?.target === 'ses_peer');
const reply = await call('collab_reply', { threadID: 't_dup_1', text: 'a reply from peer', confirm: true }, 'ses_peer');
check(
  'collab_reply indexed (participants sticky, reply direction)',
  reply.startsWith('已投递') && indexJson().entries.t_dup_1?.target === 'ses_peer' && indexJson().entries.t_dup_1?.from === 'ses_me',
  JSON.stringify(indexJson().entries.t_dup_1)
);
const handoff = await call('collab_handoff', { target: 'ses_peer', text: 'probe handoff body', expected: 'review', confirm: true });
const handoffThread = /thread=(t_[0-9a-z_]+)/.exec(handoff)?.[1] ?? '';
const bid = /bid=(b_[0-9a-f]+)/.exec(handoff)?.[1] ?? '';
check(
  'collab_handoff indexed as kind=handoff with its bid',
  Boolean(handoffThread) && indexJson().entries[handoffThread]?.kind === 'handoff' && indexJson().entries[handoffThread]?.bid === bid,
  `${handoffThread} ${bid}`
);

// ---------- 2. collab_threads correctness
const list = await call('collab_threads', { target: 'ses_peer' });
const rows = input => input.split('\n').filter(l => l.startsWith('- t_'));
check('collab_threads lists send thread + handoff thread', list.includes('t_dup_1') && list.includes(handoffThread), rows(list).length + ' rows');
check('suggestion names the newest unresolved thread', /建议: 先看 t_/.test(list) && list.split('\n').filter(l => l.includes('← 建议继续')).length === 1);

// ---------- 2b. 25 threads → 20 rows + 还有 5 个
for (let i = 0; i < 25; i += 1) {
  await call('collab_send', { target: 'ses_peer', kind: 'note', threadID: `t_bulk_${String(i).padStart(2, '0')}`, text: `bulk thread ${i}`, confirm: true });
}
const many = await call('collab_threads', { target: 'ses_peer' });
const manyRows = rows(many);
check(
  '20-row render cap + 还有 N 个 notice',
  manyRows.length === 20 && /还有 \d+ 个/.test(many),
  `${manyRows.length} rows / ${many.split('\n').find(l => l.includes('还有') || '')}`
);

// ---------- 2c. includeClosed adds at most 3 closed
const closedIds = [];
for (const id of ['t_closed_a', 't_closed_b', 't_closed_c', 't_closed_d']) {
  await call('collab_send', { target: 'ses_peer', kind: 'request', threadID: id, text: `closed candidate ${id}`, confirm: true });
  await call('collab_reply', { threadID: id, text: `accepted ${id}`, confirm: true }, 'ses_peer');
  closedIds.push(id);
}
const withClosed = await call('collab_threads', { target: 'ses_peer', includeClosed: true });
check(
  'includeClosed adds at most 3 closed rows',
  withClosed.split('\n').filter(l => l.includes('（已闭环）')).length <= 3 && withClosed.includes('（已闭环）'),
  `${withClosed.split('\n').filter(l => l.includes('（已闭环）')).length} closed rows`
);

// ---------- 3. status downgrade
const statusMsg = await call('collab_status', { threadID: 't_dup_1' });
check('status on a message thread: kind=messages + summaries, no error', statusMsg.includes('kind=messages') && statusMsg.includes('same body once') && statusMsg.includes('a reply from peer') && !statusMsg.includes('没有 thread t_dup_1'));
let ghost = '';
try {
  await call('collab_status', { threadID: 't_mwn15sjw_pr7a' });
} catch (error) {
  ghost = String(error?.message ?? error);
}
check('unknown thread keeps the original wording', ghost.includes('没有 thread t_mwn15sjw_pr7a 对应的交接单') && ghost.includes('可能拼错'), ghost.slice(0, 60));

// ---------- 3b. thread store only (delete the index row) → still downgrades
const snap = indexJson();
delete snap.entries.t_dup_1;
writeFileSync(indexFile, JSON.stringify(snap));
const storeOnly = await call('collab_status', { threadID: 't_dup_1' });
check('thread-store-only (no index row) still downgrades to kind=messages', storeOnly.includes('kind=messages') && storeOnly.includes('same body once'));

// ---------- 4. read-only (hash of every file in the index dir + broadcast dir)
const before = [readFileSync(indexFile, 'utf8'), hashes(broadcastDir)];
const beforeStamp = `${statSync(indexFile).size}:${statSync(indexFile).mtimeMs}`;
const writeNames = ['prompt', 'update', 'remove', 'create'];
const saved = {};
for (const name of writeNames) saved[name] = ctx.session[name];
const restore = () => Object.entries(saved).forEach(([name, fn]) => (ctx.session[name] = fn));
for (const name of writeNames) ctx.session[name] = () => { throw new Error(`write during read: session.${name}`); };
const savedSet = ctx.storage.set;
ctx.storage.set = () => { throw new Error('write during read: storage.set'); };
let readErr = '';
try {
  await call('collab_threads', { target: 'ses_peer' });
  await call('collab_threads', { target: 'ses_peer', includeClosed: true });
  await call('collab_status', { threadID: 't_dup_1' });
  await call('collab_status', { threadID: handoffThread });
} catch (error) {
  readErr = String(error?.message ?? error);
}
restore();
ctx.storage.set = savedSet;
const after = [readFileSync(indexFile, 'utf8'), hashes(broadcastDir)];
const afterStamp = `${statSync(indexFile).size}:${statSync(indexFile).mtimeMs}`;
check(
  'read-only: strict host + index content/size:mtime + broadcast hashes unchanged',
  !readErr && JSON.stringify(before) === JSON.stringify(after) && beforeStamp === afterStamp,
  readErr || `${beforeStamp} → ${afterStamp}`
);

// ---------- 5. boundary: alias, nonexistent sid, empty target
const byAlias = await call('collab_threads', { target: 'peer' });
check('alias resolves and lists the same threads', byAlias.includes('t_dup_1') && byAlias.includes('别名 peer'));
const ghostSid = await call('collab_threads', { target: 'ses_does_not_exist_1' });
check('unknown ses_ id answers readably (no crash)', ghostSid.includes('没有') && ghostSid.includes('ses_does_not_exist_1'));
let emptyErr = '';
try {
  await call('collab_threads', { target: '' });
} catch (error) {
  emptyErr = String(error?.message ?? error);
}
check('empty target is a readable error', /target 不能为空/.test(emptyErr), emptyErr.slice(0, 40));

// ---------- 6. mixed handoff/messages: suggestion matches the newest open thread
const mixed = await call('collab_threads', { target: 'ses_peer' });
const suggestion = mixed.split('\n').find(l => l.startsWith('建议:')) ?? '';
check('suggestion points at an unresolved thread and gives a copyable next step', /collab_(status|reply) \{threadID:"t_/.test(suggestion), suggestion.slice(0, 90));

const failed = results.filter(r => !r.ok);
console.log(`\n=== PROBE ${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log(failed.map(f => `FAIL: ${f.label}`).join('\n'));
