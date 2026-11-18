/**
 * Old-vs-new comparison for the paths that must NOT change:
 *   S1  a non-protected requester's injection (group broadcast + followUp).
 *   S2  a `[protected-child]`'s queue lines (3 distinct proposals).
 * Prints the exact injected text so the caller can diff two builds.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'compare-'));
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

const OWNER = 'ses_cmp_owner';
const CHILD = 'ses_cmp_child';
const PLAIN = 'ses_cmp_plain';
const PEER = 'ses_cmp_peer';
writeFileSync(process.env.COLLAB_CONFIG, JSON.stringify({ protect: [OWNER] }, null, 2));
for (const name of ['p.md', 'q.md', 'c1.md', 'c2.md', 'c3.md']) writeFileSync(join(wsDir, 'docs', 'issues', name), `# ${name}\n`);

const sessions = new Map();
for (const id of [OWNER, PLAIN, PEER]) {
  sessions.set(id, { id, agent: 'build', title: id, time: { updated: 1700000000000, busy: 0 }, location: { directory: wsDir } });
}
sessions.set(CHILD, {
  id: CHILD,
  parentID: OWNER,
  agent: 'trellis-implement',
  title: CHILD,
  time: { updated: 1700000000000, busy: 0 },
  location: { directory: wsDir }
});

const store = new Map();
const tools = [];
const hooks = {};
const ctx = {
  location: { directory: wsDir },
  options: {},
  app: { version: 'cmp' },
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
    async create() {
      throw new Error('cmp: no spawn expected');
    },
    async remove() {},
    async update() {},
    async switchAgent() {},
    async prompt() {
      throw new Error('cmp: no prompt expected');
    },
    async wait() {}
  },
  event: {
    async subscribe() {
      return () => {};
    }
  }
};

const dist = process.env.DIST || '/data/project/collab/dist/index.js';
await (await import(`file://${dist}`)).default.setup(ctx);

function writeBc(bid, overrides) {
  const record = {
    bid,
    scope: 'peer',
    workspace: wsDir,
    issuePath: 'docs/issues/p.md',
    title: 'cmp fixture',
    expected: 'implement',
    affectedFiles: [],
    candidates: [],
    state: 'open',
    attempts: 0,
    skipped: [],
    seenBy: [],
    askSeen: [],
    reminded: [],
    replies: [],
    from: { sid: PEER },
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides
  };
  writeFileSync(join(bcDir, `${bid}.json`), `${JSON.stringify(record, null, 2)}\n`);
}
function writeQ(sid, item) {
  mkdirSync(join(qDir, sid), { recursive: true });
  writeFileSync(
    join(qDir, sid, `${item.id}.json`),
    `${JSON.stringify({ target: sid, from: PEER, revokedAt: null, seenAt: null, ...item }, null, 2)}\n`
  );
}

// S1: an open group broadcast from a peer + a done record with two pending appends.
writeBc('b_000000c0a10001', { state: 'open', from: { sid: PEER }, title: 'cmp open hand-off' });
writeBc('b_000000c0a10002', {
  state: 'done',
  from: { sid: PLAIN },
  issuePath: 'docs/issues/q.md',
  claim: { by: 'ses_cmp_by', at: 1699999000000, leaseMs: 300000 },
  receipt: { from: 'ses_cmp_by', at: 1699999000000, note: 'done' },
  followUps: [
    { bid: 'b_000000c0a10002', issuePath: 'docs/issues/q.md', at: 1699999100000, by: 'ses_cmp_by' },
    { bid: 'b_000000c0a10002', issuePath: 'docs/issues/q.md', at: 1699999200000, by: 'ses_cmp_by' }
  ]
});
// S2: three distinct proposals queued for a protected child.
for (const [i, name] of ['c1.md', 'c2.md', 'c3.md'].entries()) {
  writeQ(CHILD, { id: `q_${(1000 + i).toString(36)}_c${i}`, at: 1700000000000 + i * 1000, summary: `cmp queue ${i + 1}`, issuePath: `docs/issues/${name}` });
}

const text = async sid => {
  const event = { sessionID: sid, agent: 'build', system: [], messages: [] };
  await hooks.context(event);
  return event.system.map(block => String(block?.text ?? '')).join('\n') || '(empty)';
};

console.log(`DIST=${dist}`);
console.log('### S1 non-protected requester');
console.log(await text(PLAIN));
console.log('### S2 protected child (queue only)');
console.log(await text(CHILD));
console.log('### S2 again (stamped => nothing)');
console.log(await text(CHILD));
