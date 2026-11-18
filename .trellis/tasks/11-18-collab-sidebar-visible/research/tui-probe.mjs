/**
 * Independent probe (check agent) — TUI half (R4–R7) + the RPC `queue` block (R5/R6).
 *
 *   cd /data/project/collab && node --conditions=browser /tmp/collab-check/tui-probe.mjs
 *
 * Two halves, both against the **shipped** artifacts:
 *   A. `dist/index.js` (server): `collab.state.snapshot` really only reads
 *      (`mineFor(session)`), filters by sender, and a temp `$HOME` is byte-identical
 *      before/after the call (no `seenAt` stamp, no prune, no mkdir).
 *   B. `dist/tui.js` (TUI): the panel's 2 s poll follows the panel (open → ticks,
 *      unmount → stops, other plugin's panel → never starts), the sidebar starts
 *      **no** timer, an unreachable RPC degrades instead of blanking, and the only
 *      host API touched is `client.rpc`.
 *
 * EVIDENCE COPY (check agent). Run from /tmp/collab-check with jsdom + symlinked
 * node_modules (`npm i --no-save jsdom`, then symlink solid-js/@opencode/@opentui),
 * e.g. `cd /data/project/collab && node --conditions=browser /tmp/collab-check/tui-probe.mjs`.
 * See check-report.md for the exact commands and outputs.
 */
import { createSignal } from 'solid-js';
import { createComponent, testRender } from '@opentui/solid';
import { PluginContextProvider } from '@opencode/plugin/tui';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};
const sleep = ms => new Promise(done => setTimeout(done, ms));
const POLL_MS = 2000;

/* ============================================================ A. server: queue */

const HOME = mkdtempSync('/tmp/collab-check/home-');
const QUEUE = join(HOME, '.config', 'opencode', 'collab-owner-queue');
const now = Date.now();
const item = (id, target, from, at, extra = {}) => ({ id, target, from, at, summary: `req ${id}`, ...extra });

mkdirSync(join(QUEUE, 'ses_target1'), { recursive: true });
mkdirSync(join(QUEUE, 'ses_target2'), { recursive: true });
writeFileSync(join(QUEUE, 'ses_target1', 'q_1000_aaaa.json'), JSON.stringify(item('q_1000_aaaa', 'ses_target1', 'ses_me', now - 90_000, { seenAt: now - 60_000 })));
writeFileSync(join(QUEUE, 'ses_target1', 'q_1000_bbbb.json'), JSON.stringify(item('q_1000_bbbb', 'ses_target1', 'ses_other', now - 80_000)));
writeFileSync(join(QUEUE, 'ses_target2', 'q_1000_cccc.json'), JSON.stringify(item('q_1000_cccc', 'ses_target2', 'ses_me', now - 10_000, { issuePath: 'docs/issues/fix-x.md', bid: 'b_1' })));
writeFileSync(join(QUEUE, 'ses_target2', 'q_1000_dddd.json'), JSON.stringify(item('q_1000_dddd', 'ses_target2', 'ses_me', now - 5_000, { revokedAt: now - 1_000 })));

function treeHash(dir) {
  const out = [];
  const walk = path => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        out.push(`d ${full}`);
        walk(full);
      } else {
        out.push(`f ${full} ${stat.mtimeMs} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
      }
    }
  };
  walk(dir);
  return out.join('\n');
}

const before = treeHash(HOME);
process.env.HOME = HOME;
delete process.env.XDG_CONFIG_HOME;

const build = await import('file:///data/project/collab/dist/index.js');
const internals = build.__internals;
const server = build.default ?? build;
const rpcCalls = [];
let handlers;
const tools = [];
const noop = async () => ({ dispose: async () => {} });
const serverCtx = {
  location: { directory: '/data/project/collab' },
  options: {},
  app: { version: 'probe' },
  storage: { async get() {}, async set() {}, async remove() {}, async scan() { return { entries: [] }; } },
  tool: { async transform(cb) { cb({ add: d => tools.push(d) }); return { dispose: async () => {} }; } },
  session: {
    async hook() { return { dispose: async () => {} }; },
    async get() { throw new Error('probe: no sessions'); },
    async list() { return { data: [] }; },
    async context() { return []; },
    async prompt() { throw new Error('probe: the plugin must not prompt'); },
    async update() { throw new Error('probe: the plugin must not patch sessions'); }
  },
  event: { async *subscribe() { /* never yields */ } },
  rpc: {
    async register(definition, methods) {
      rpcCalls.push(definition?.id);
      handlers = methods;
      return { dispose: async () => {} };
    }
  }
};
const originalError = console.error;
console.error = () => {};
const disposeServer = await server.setup(serverCtx);
console.error = originalError;

expect('A0 setup registered collab.state.snapshot', rpcCalls[0] === 'collab.state' && typeof handlers?.snapshot === 'function', JSON.stringify(rpcCalls));
expect('A0 the queue dir the plugin reads is our temp HOME', internals.buildSnapshot && QUEUE.startsWith(HOME));

const mine = await handlers.snapshot({ session: 'ses_me' });
expect('A1 {session} returns only that sender\'s items (not ses_other, not revoked)', mine.queue.length === 2 &&
  mine.queue.every(row => row.target !== '' ) && !mine.queue.some(row => row.queueId === 'q_1000_bbbb' || row.queueId === 'q_1000_dddd'),
  JSON.stringify(mine.queue.map(row => row.queueId)));
expect('A1 oldest first', mine.queue[0]?.queueId === 'q_1000_aaaa' && mine.queue[1]?.queueId === 'q_1000_cccc',
  JSON.stringify(mine.queue.map(row => [row.queueId, row.ageMs])));
expect('A1 seen / issuePath / bid carried through', mine.queue[0]?.seen === true && mine.queue[1]?.seen === false &&
  mine.queue[1]?.issuePath === 'docs/issues/fix-x.md' && mine.queue[1]?.bid === 'b_1',
  JSON.stringify(mine.queue.map(row => ({ seen: row.seen, issuePath: row.issuePath, bid: row.bid }))));
expect('A1 ageMs is a positive age, not a timestamp', mine.queue.every(row => row.ageMs >= 0 && row.ageMs < 3_600_000));

const all = await handlers.snapshot({});
expect('A2 no session named → empty queue (no whole-table scan)', Array.isArray(all.queue) && all.queue.length === 0, JSON.stringify(all.queue));
const stranger = await handlers.snapshot({ session: 'ses_nobody' });
expect('A2 an unknown session → empty queue, still a valid snapshot', stranger.queue.length === 0 && stranger.reachable === true);

const output = internals.CollabState.methods.snapshot.output;
expect('A3 the schema requires queue and the top level requires all six keys',
  output.required.includes('queue') && output.properties.queue.type === 'array',
  JSON.stringify(output.required));
const requiredKeys = output.properties.queue.items.required;
expect('A3 every produced item carries every required key',
  mine.queue.every(row => requiredKeys.every(key => key in row)),
  JSON.stringify(requiredKeys));
expect('A3 types line up (queueId/target/summary string, ageMs number, seen boolean)',
  mine.queue.every(row => typeof row.queueId === 'string' && typeof row.target === 'string' &&
    typeof row.summary === 'string' && typeof row.ageMs === 'number' && typeof row.seen === 'boolean'));

const after = treeHash(HOME);
expect('A4 the snapshot wrote nothing (same bytes + mtimes in $HOME)', before === after, before === after ? 'identical' : 'CHANGED');
expect('A4 … and the seen item was not re-stamped', JSON.parse(readFileSync(join(QUEUE, 'ses_target1', 'q_1000_aaaa.json'), 'utf8')).seenAt === now - 60_000);

await disposeServer();
rmSync(HOME, { recursive: true, force: true });

/* ============================================================== B. TUI runtime */

const tuiEntry = 'file:///data/project/collab/dist/tui.js';
const tui = (await import(tuiEntry)).default;

const SNAPSHOT = {
  at: 1_800_000_000_000,
  reachable: true,
  sessions: [],
  locks: [{ resource: 'named:build', kind: 'named', mode: 'exclusive', holders: ['ses_probe'], waiters: 0, waiting: [], expiresInMs: 60_000 }],
  handoffs: [{ bid: 'b_1', state: 'open', ageMs: 1000, from: 'ses_other', title: 't' }],
  queue: [{ queueId: 'q_1_aaaa', target: 'ses_prot', ageMs: 5000, summary: 's', seen: false }]
};

function harness({ fail = false, reply = SNAPSHOT, host = {} } = {}) {
  const slots = {};
  const layers = [];
  const calls = [];
  const touched = new Set();
  const client = new Proxy(
    { rpc: definition => ({ snapshot: async input => { calls.push({ id: definition?.id, input }); if (fail) throw new Error('ECONNREFUSED'); return reply; } }) },
    {
      get(target, key) {
        touched.add(String(key));
        return target[key];
      }
    }
  );
  const w = { mode: 'global', commands: [{ id: 'collab.status', run: () => {} }] };
  const ctx = {
    options: {},
    location: { directory: '/data/project/collab' },
    app: { version: 'probe' },
    client,
    data: {
      session: {
        list: () => [{ id: 'ses_local', title: 'local', agent: 'build' }],
        status: () => 'idle',
        prompt: () => { throw new Error('probe: the TUI part must never prompt'); },
        update: () => { throw new Error('probe: the TUI part must never update a session'); }
      }
    },
    theme: { text: { base: '#fff', muted: '#888', feedback: { success: { base: '#0f0' }, warning: { base: '#ff0' }, error: { base: '#f00' } } } },
    keymap: { layer: factory => { layers.push(factory); } },
    ui: {
      slot: claim => { slots[claim.append ?? claim.prepend ?? claim.replace] = claim.render; return () => {}; },
      panel: { open: () => true, close: () => {}, current: () => undefined },
      toast: { show: () => {} }
    },
    ...host
  };
  return { ctx, slots, layers, calls, touched, command: () => layers[0]?.()?.commands?.[0] ?? w.commands[0] };
}

const panelInput = over => ({
  name: 'collab.status', sessionID: 'ses_probe', width: 72, presentation: 'panel',
  focused: true, focus: () => {}, close: () => {}, toggleFullscreen: () => {}, ...over
});

async function mount(context, render, size = { width: 90, height: 30 }) {
  const setup = await testRender(
    () => createComponent(PluginContextProvider, { value: context, get children() { return render(); } }),
    size
  );
  await sleep(120);
  await setup.renderOnce();
  return { setup, frame: await setup.captureCharFrame() };
}

/* B1: registration + read-only surface */

const live = harness();
const liveCleanup = await tui.setup(live.ctx);
const command = live.command();
expect('B1 setup claims session.panel + sidebar.content', typeof live.slots['session.panel'] === 'function' && typeof live.slots['sidebar.content'] === 'function', Object.keys(live.slots).join(','));
expect('B1 the command is /collab with ctrl+shift+l and palette', command?.slash?.name === 'collab' && command?.bind === 'ctrl+shift+l' && command?.palette === true,
  JSON.stringify({ slash: command?.slash, bind: command?.bind }));

const [name, setName] = createSignal('collab.status');
const livePanel = await mount(live.ctx, () => live.slots['session.panel'](panelInput({ get name() { return name(); } })));
expect('B2 the panel renders the three blocks and the summary row', livePanel.frame.includes('资源租约') && livePanel.frame.includes('未闭环交接') && livePanel.frame.includes('受保护目标队列') && livePanel.frame.includes('named:build'));

const sidebarProbe = harness();
await sidebarProbe.ctx; // (no setup: the sidebar slot belongs to the same plugin)
const sideMount = await mount(live.ctx, () => live.slots['sidebar.content']({ sessionID: 'ses_probe' }), { width: 40, height: 4 });
expect('B2 the sidebar line is 锁 N · 交接 M · 队列 K', sideMount.frame.includes('锁 1 · 交接 1 · 队列 1'), sideMount.frame.trim());

/* B3: polling lifecycle (my own timing, not the repo's test) */

const base = live.calls.length;
await sleep(POLL_MS + 300);
const openTicks = live.calls.length - base;
expect('B3 open panel → more than one poll in 2.3 s', openTicks >= 1, `${base} → ${live.calls.length}`);

setName('someone.else');
await sleep(200);
const away = live.calls.length;
await sleep(POLL_MS + 300);
expect('B3 switching to another plugin\'s panel stops the poll', live.calls.length === away, `${away} → ${live.calls.length}`);

setName('collab.status');
await sleep(POLL_MS + 300);
expect('B3 switching back resumes it', live.calls.length > away, `${away} → ${live.calls.length}`);

const beforeUnmount = live.calls.length;
await livePanel.setup.dispose(); // the host unmounts the slot: panel closed
await sleep(POLL_MS + 400);
expect('B3 unmounting (panel closed) stops the poll', live.calls.length === beforeUnmount, `${beforeUnmount} → ${live.calls.length}`);

const beforeSidebarIdle = live.calls.length;
await sleep(POLL_MS + 400);
expect('B3 the sidebar alone keeps no timer (no growth after unmount)', live.calls.length === beforeSidebarIdle, `${beforeSidebarIdle} → ${live.calls.length}`);
await sideMount.setup.dispose();

/* B4: unreachable + old server */

const offline = harness({ fail: true });
await liveCleanup();
const offlineCleanup = await tui.setup(offline.ctx);
const offlinePanel = await mount(offline.ctx, () => offline.slots['session.panel'](panelInput()));
const offlineText = offlinePanel.frame;
expect('B4 unreachable → banner + host session list, not blank', offlineText.includes('RPC 不可达') && offlineText.includes('仅显示本地会话列表') && offlineText.includes('ses_local'), offlineText.trim().slice(0, 80));
const offlineSidebar = await mount(offline.ctx, () => offline.slots['sidebar.content']({ sessionID: 'ses_probe' }), { width: 40, height: 4 });
expect('B4 unreachable sidebar reads collab: n/a', offlineSidebar.frame.includes('collab: n/a'));
await offlineSidebar.setup.dispose();
await offlinePanel.setup.dispose();
await offlineCleanup();

const legacy = harness({ reply: (({ queue, ...rest }) => rest)(SNAPSHOT) });
const legacyCleanup = await tui.setup(legacy.ctx);
let legacyThrown;
let legacyMount;
try {
  legacyMount = await mount(legacy.ctx, () => legacy.slots['session.panel'](panelInput()));
} catch (error) {
  legacyThrown = error;
}
expect('B5 a 0.4.1 server (no queue) renders the panel with an empty queue block',
  !legacyThrown && legacyMount?.frame.includes('受保护目标队列 (0)'),
  legacyThrown ? String(legacyThrown).slice(0, 120) : legacyMount?.frame.includes('受保护目标队列 (0)'));
await legacyMount?.setup.dispose();
await legacyCleanup();

/* B6: read-only surface: the only host API is client.rpc(...).snapshot */

expect('B6 the TUI part only reached client.rpc (no session/tool write path)', live.touched.size === 1 && live.touched.has('rpc'), [...live.touched].join(','));

const tuiSource = readFileSync('/data/project/collab/dist/tui.js', 'utf8');
const imports = [...tuiSource.matchAll(/^import .* from "([^"]+)";$/gm)].map(match => match[1]);
expect('B7 dist/tui.js imports only host-provided modules', imports.length > 0 && imports.every(id => /^(@opencode\/|@opentui\/|solid-js)/.test(id)), imports.join(','));
expect('B7 dist/tui.js contains no write call (prompt / update / enqueue / writeFile)', !/\b(session\.prompt|session\.update|switchAgent|enqueue|markSeen|writeFileSync|unlinkSync)\b/.test(tuiSource), 'scanned');

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAIL: ${check.title}`);
  process.exit(1);
}
process.exit(0);
