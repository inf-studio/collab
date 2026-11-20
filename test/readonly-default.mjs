/**
 * R8 (read-only by default) for the packaged plugin.
 *
 *   pnpm --filter=@inf-studio/collab test     # builds dist/ first
 *
 * The single-file `.opencode/plugins/collab.js` always had the write capability
 * (it patched a session's permissions and switched its agent). The package makes
 * that opt-in: `options.allowWrite` / `collab.json` default to `false`, so a
 * freshly installed plugin can read sessions and send messages but never writes
 * to another session until the operator says so.
 *
 * Asserted here:
 *   - the default refuses promote / grant / revoke with a readable reason and
 *     touches nothing (no ledger file, no PATCH, no agent switch);
 *   - the messaging half still works (collab_send preview, collab_list,
 *     collab_inbox) — "read-only" means "no writes to sessions", not "off";
 *   - `options.allowWrite:true` re-enables the write path (positive control);
 *   - the built-in `protect` list and the read-only agent list cannot be
 *     removed by config (R8: no guard-rail can be loosened by splitting the
 *     plugin into a package).
 *
 * Runs in its own process with temp broadcast/grant dirs, so it never touches
 * `~/.config/opencode/collab-*`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'collab-readonly-'));
process.env.COLLAB_BROADCAST_DIR = join(dir, 'broadcast');
process.env.COLLAB_GRANT_DIR = join(dir, 'grants');
// Ignore the operator's real `collab.json`: this file tests the built-in
// defaults, and a machine-local `allowWrite:true` would mask a regression.
process.env.COLLAB_CONFIG = join(dir, 'collab.json');
// Defect evidence must not land in the operator's real report directory.
process.env.COLLAB_REPORT_DIR = join(dir, 'reports');
// Resource leases are global as well; keep them in the temp dir.
process.env.COLLAB_LOCK_DIR = join(dir, 'locks');
// 0.7.0: the thread index is one global file — never the operator's real one.
process.env.COLLAB_THREAD_INDEX_FILE = join(dir, 'collab-threads.json');
// 0.6.0: the freeze file is global too — never write the operator's real one.
process.env.COLLAB_FREEZE_FILE = join(dir, 'freeze.json');
// B1 (0.9.0 review): the message log / projection are global too. Without these
// two, any prompt in this suite lands in the operator's real history.
const realMessagesFile = join(homedir(), '.config', 'opencode', 'collab-messages.jsonl');
const realDbFile = join(homedir(), '.config', 'opencode', 'collab.db');
const realStamp = () => {
  const statOf = path => {
    try {
      const stat = statSync(path);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return 'absent';
    }
  };
  return `${statOf(realMessagesFile)}|${statOf(realDbFile)}`;
};
const realStampBefore = realStamp();
process.env.COLLAB_MESSAGES_FILE = join(dir, 'collab-messages.jsonl');
process.env.COLLAB_DB_FILE = join(dir, 'collab.db');
process.env.COLLAB_CONTRACT_DIR = join(dir, 'contract');
process.env.COLLAB_OWNER_QUEUE_DIR = join(dir, 'owner-queue');
process.env.COLLAB_AUDIT_FILE = join(dir, 'collab-audit.jsonl');

const entry = resolve(import.meta.dirname, '../dist/index.js');
const plugin = (await import(`file://${entry}`)).default;

const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};

const ws = join(dir, 'ws');
mkdirSync(join(ws, 'docs', 'issues'), { recursive: true });

const store = new Map();
const prompts = [];
const patches = [];
const agentSwitches = [];
const sessions = {
  ses_me: { id: 'ses_me', agent: 'build', title: 'requester', location: { directory: ws } },
  ses_ro: { id: 'ses_ro', agent: 'explore', title: 'read-only peer', location: { directory: ws } }
};

/** A fresh host: each `setup` registers its own tool list. */
function makeHost(options) {
  const tools = [];
  const hooks = {};
  const ctx = {
    location: { directory: ws },
    options,
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
      }
    },
    tool: {
      async transform(callback) {
        callback({ add: definition => tools.push(definition) });
        return { dispose: async () => {} };
      }
    },
    session: {
      async hook(name, callback) {
        hooks[name] = callback;
        return { dispose: async () => {} };
      },
      async get({ sessionID }) {
        if (!sessions[sessionID]) throw new Error(`Session not found: ${sessionID}`);
        return structuredClone(sessions[sessionID]);
      },
      async list() {
        return { data: structuredClone(Object.values(sessions)) };
      },
      async context({ sessionID }) {
        return sessions[sessionID] ? [] : [];
      },
      async update(input = {}) {
        patches.push(input);
        if (input.permissions !== undefined) {
          sessions[input.sessionID].permissions = structuredClone(input.permissions);
        }
      },
      async switchAgent(input = {}) {
        agentSwitches.push(input);
        sessions[input.sessionID].agent = input.agent;
      },
      async prompt(input) {
        prompts.push(input);
        return { id: `msg_${prompts.length}`, delivery: input.delivery };
      },
      async wait() {},
      async create() {
        throw new Error('not used');
      },
      async remove() {}
    },
    // No events needed here: the read-only contract is about the tools.
    event: { async *subscribe() {} }
  };
  return { ctx, tools, hooks };
}

const originalError = console.error;
console.error = () => {};

// ---------------------------------------------------------------- defaults
const readonlyHost = makeHost({});
await plugin.setup(readonlyHost.ctx);
// ------------------------------------------------------------ opt-in writes
const writeHost = makeHost({ allowWrite: true });
await plugin.setup(writeHost.ctx);
console.error = originalError;

const toolOf = (host, name) => host.tools.find(definition => definition.name === name);
const call = async (host, name, input, context = { sessionID: 'ses_me', agent: 'build' }) =>
  (await toolOf(host, name).execute(input, context)).content;

const grantFileOf = sid => join(process.env.COLLAB_GRANT_DIR, `${sid}.json`);

// --- 1. the tool surface is complete and unchanged
expect(
  'R8 the package registers the twenty-eight collab_* tools + collab_report',
  readonlyHost.tools.map(definition => definition.name).join(',') ===
    [
      'collab_list',
      'collab_broadcast',
      'collab_handoff',
      'collab_request_owner',
      'collab_accept',
      'collab_send',
      'collab_reply',
      'collab_followup',
      'collab_decisions',
      'collab_inbox',
      'collab_wait',
      'collab_status',
      'collab_threads',
      'collab_escalate',
      'collab_freeze',
      'collab_grant',
      'collab_promote',
      'collab_report',
      'collab_lock',
      'collab_unlock',
      'collab_locks',
      'collab_archive',
      'collab_index',
      'collab_mission',
      'collab_progress',
      'collab_todo',
      'collab_fact',
      'collab_decide'
    ].join(','),
  readonlyHost.tools.map(definition => definition.name).join(',')
);

// --- 2. default: every write into another session is refused, readably
const promote = await call(readonlyHost, 'collab_promote', { target: 'ses_ro', confirm: true });
expect(
  'R8 default promote is refused with the allowWrite reason',
  promote.includes('未切换 agent（disabled）') && promote.includes('allowWrite=false'),
  promote.split('\n')[0]
);
expect(
  'R8 default promote switched nothing and wrote no ledger',
  agentSwitches.length === 0 && sessions.ses_ro.agent === 'explore' && !existsSync(grantFileOf('ses_ro')),
  `${agentSwitches.length} switch(es)`
);

const grant = await call(readonlyHost, 'collab_grant', { target: 'ses_ro', confirm: true });
expect(
  'R8 default grant is refused with the allowWrite reason',
  grant.includes('未授予权限（disabled）') && patches.length === 0 && !existsSync(grantFileOf('ses_ro')),
  grant.split('\n')[0]
);

const revoke = await call(readonlyHost, 'collab_grant', {
  target: 'ses_ro',
  revoke: true,
  confirm: true
});
expect(
  'R8 default revoke is refused (no permissions are restored behind the operator)',
  revoke.includes('未还原') && revoke.includes('allowWrite=false') && patches.length === 0,
  revoke.split('\n')[0]
);

// --- 3. the messaging half still works: read-only is not "off"
const sendPreview = await call(readonlyHost, 'collab_send', {
  target: 'ses_ro',
  text: 'hello',
  confirm: false
});
expect(
  'R8 sending still previews with the default options (queue, envelope)',
  sendPreview.includes('未投递') && sendPreview.includes('[collab:') && sendPreview.includes('[request:'),
  sendPreview.split('\n')[0]
);
const list = await call(readonlyHost, 'collab_list', {});
expect('R8 collab_list still lists sessions', list.includes('ses_me') && list.includes('ses_ro'), list.split('\n')[0]);
const inbox = await call(readonlyHost, 'collab_inbox', {});
expect('R8 collab_inbox still answers', inbox.includes('[collab]'), inbox.split('\n')[0]);

// --- 4. positive control: `allowWrite:true` re-enables the write path
const promoted = await call(writeHost, 'collab_promote', { target: 'ses_ro', confirm: true });
expect(
  'R8 allowWrite:true promotes (positive control)',
  promoted.includes('已切换 agent') && sessions.ses_ro.agent === 'build' && agentSwitches.length === 1,
  promoted.split('\n')[0]
);
const granted = await call(writeHost, 'collab_grant', { target: 'ses_ro', confirm: true });
const ledger = existsSync(grantFileOf('ses_ro')) ? JSON.parse(readFileSync(grantFileOf('ses_ro'), 'utf8')) : {};
expect(
  'R8 allowWrite:true grants the five collab_* rules and records the snapshot',
  granted.includes('已授予 5 条') && patches.length === 1 && Array.isArray(ledger.added),
  granted.split('\n')[0]
);

// --- 5. guard rails stay additive, whatever the config says
const loosenedHost = makeHost({
  allowWrite: true,
  protect: [],
  readonlyAgents: []
});
console.error = () => {};
await plugin.setup(loosenedHost.ctx);
console.error = originalError;
sessions.ses_e23a4a23fffe4c4m7UQFR8dUL3 = {
  id: 'ses_e23a4a23fffe4c4m7UQFR8dUL3',
  agent: 'build',
  title: 'protected line',
  location: { directory: ws }
};
sessions.ses_explore = {
  id: 'ses_explore',
  agent: 'explore',
  title: 'read-only agent',
  location: { directory: ws }
};
const protectedSend = await call(loosenedHost, 'collab_send', {
  target: 'ses_e23a4a23fffe4c4m7UQFR8dUL3',
  text: 'nope',
  confirm: true
}).catch(error => `拒绝投递：${error.message}`);
expect(
  'R8 the built-in protect entry is refused even with protect:[]',
  protectedSend.includes('protect 名单内'),
  String(protectedSend).split('\n')[0]
);
const forcedQueue = await call(
  loosenedHost,
  'collab_send',
  {
    target: 'ses_explore',
    text: 'ping',
    mode: 'steer',
    confirm: false
  },
  { sessionID: 'ses_me', agent: 'explore' }
);
expect(
  'R8 an empty readonlyAgents list cannot un-force queue for explore',
  forcedQueue.includes('queue(forced)'),
  forcedQueue.split('\n')[0]
);

expect(
  'B1 this suite never writes the real ~/.config collab-messages.jsonl / collab.db (mtime + size unchanged)',
  realStamp() === realStampBefore,
  `${realStampBefore} → ${realStamp()}`
);

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAIL: ${check.title}`);
  process.exit(1);
}
process.exit(0);
