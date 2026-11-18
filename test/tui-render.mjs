/**
 * 0.4.2 (R4–R7): the TUI half, rendered headlessly.
 *
 *   node --conditions=browser test/tui-render.mjs      # pnpm test runs it
 *
 * Why `--conditions=browser`: under Node's default conditions `solid-js`
 * resolves to its *server* build, where `createEffect` / `onMount` are no-ops —
 * the panel would render its loading state forever and the poll assertions
 * below would be meaningless. The real TUI runs on Bun, which uses the reactive
 * build; the browser condition is the closest honest equivalent in Node.
 *
 * What is checked (no OpenCode host, no terminal):
 *
 *   1. `setup` registers both slot claims and one keymap layer whose command is
 *      the `/collab` slash command with `ctrl+shift+l` and palette entry;
 *   2. the panel renders the three blocks — leases (holders/TTL/waiters),
 *      open hand-offs (bid/state/age/from), the requester's queue (queueId/
 *      target/age/status) — from `collab.state.snapshot` only;
 *   3. an unreachable server keeps the panel alive: banner + "仅显示本地会话"
 *      + the host's own session list, and no blank body;
 *   4. another plugin's panel renders nothing **and starts no poll**;
 *   5. the poll follows the panel: ticks while open, stops when the panel name
 *      changes away (R7), and resumes when it comes back;
 *   6. `sidebar.content` prints `锁 N · 交接 M · 队列 K` from the same store.
 */
import { createSignal } from 'solid-js';
import { createComponent, testRender } from '@opentui/solid';
import { PluginContextProvider } from '@opencode/plugin/tui';
import { resolve } from 'node:path';

const entry = resolve(import.meta.dirname, '../dist/tui.js');
const plugin = (await import(`file://${entry}`)).default;

const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};

const POLL_MS = 2000;
const sleep = ms => new Promise(done => setTimeout(done, ms));

const SNAPSHOT = {
  at: 1_800_000_000_000,
  reachable: true,
  sessions: [],
  locks: [
    {
      resource: 'named:test-window',
      kind: 'named',
      mode: 'exclusive',
      holders: ['ses_probe'],
      waiters: 1,
      waiting: ['ses_other'],
      expiresInMs: 720_000
    },
    {
      resource: 'named:build',
      kind: 'build',
      mode: 'exclusive',
      holders: ['ses_other'],
      waiters: 0,
      waiting: [],
      expiresInMs: 300_000
    }
  ],
  handoffs: [{ bid: 'b_00000000a1', state: 'open', ageMs: 120_000, from: 'ses_other', title: 'proposal' }],
  queue: [{ queueId: 'q_1_aaaa', target: 'ses_protected', ageMs: 30_000, summary: '请复核', seen: false }]
};

/** A host double: only the fields the plugin reads, plus a call counter. */
function harness({ fail = false, sessions = [] } = {}) {
  const slots = {};
  const layers = [];
  const calls = [];
  const context = {
    options: {},
    location: { directory: '/data/project/collab' },
    app: { version: '2.3.1', channel: 'dev' },
    client: {
      rpc: definition => ({
        snapshot: async input => {
          calls.push({ definition: definition?.id, input });
          if (fail) throw new Error('connect ECONNREFUSED 10.0.0.5:4096');
          return SNAPSHOT;
        }
      })
    },
    data: { session: { list: () => sessions, status: () => 'idle' } },
    theme: {
      text: {
        base: '#ffffff',
        muted: '#888888',
        feedback: {
          success: { base: '#00ff00' },
          warning: { base: '#ffff00' },
          error: { base: '#ff0000' }
        }
      }
    },
    keymap: {
      layer: factory => {
        layers.push(factory);
      }
    },
    ui: {
      slot: claim => {
        slots[claim.append ?? claim.prepend ?? claim.replace] = claim.render;
        return () => {};
      },
      panel: { open: () => true, close: () => {}, current: () => undefined },
      toast: { show: () => {} }
    }
  };
  return { context, slots, layers, calls };
}

function panelInput(over = {}) {
  return {
    name: 'collab.status',
    sessionID: 'ses_probe',
    width: 72,
    presentation: 'panel',
    focused: true,
    focus: () => {},
    close: () => {},
    toggleFullscreen: () => {},
    ...over
  };
}

/** Mount the panel slot (or the sidebar slot) exactly as the host would. */
async function mount(context, render, { width = 90, height = 30 } = {}) {
  const setup = await testRender(
    () =>
      createComponent(PluginContextProvider, {
        value: context,
        get children() {
          return render();
        }
      }),
    { width, height }
  );
  await sleep(150);
  await setup.renderOnce();
  const frame = await setup.captureCharFrame();
  return { setup, frame };
}

/* ------------------------------------------------------------- 1. registration */

const first = harness();
const cleanup = await plugin.setup(first.context);

expect('R4 the TUI part declares its own plugin id', plugin?.id === 'collab.tui', String(plugin?.id));
expect(
  'R4 setup claims session.panel and sidebar.content',
  typeof first.slots['session.panel'] === 'function' && typeof first.slots['sidebar.content'] === 'function',
  Object.keys(first.slots).join(', ')
);
const command = first.layers[0]?.().commands?.[0] ?? {};
expect(
  'R4 the command is /collab, bound to ctrl+shift+l, in the palette',
  command.id === 'collab.status' &&
    command.slash?.name === 'collab' &&
    command.bind === 'ctrl+shift+l' &&
    command.palette === true,
  JSON.stringify({ id: command.id, slash: command.slash, bind: command.bind, palette: command.palette })
);

/* ----------------------------------------------------------------- 2. reachable */

const reachable = harness();
await cleanup;
const reachableCleanup = await plugin.setup(reachable.context);
const panel = panelInput();
const rendered = await mount(reachable.context, () => reachable.slots['session.panel'](panel));
const frame = rendered.frame;

expect(
  'R5 the panel shows the lease block (resource / mode / holders / TTL / waiters)',
  frame.includes('资源租约 (2)') &&
    frame.includes('named:test-window') &&
    frame.includes('exclusive') &&
    frame.includes('ses_probe') &&
    frame.includes('12m') &&
    frame.includes('named:build'),
  frame.split('\n').find(line => line.includes('named:test-window'))?.trim()
);
expect(
  'R5 the panel shows the open hand-off block (bid / state / age / from)',
  frame.includes('未闭环交接 (1)') && frame.includes('b_00000000a1') && frame.includes('open') && frame.includes('ses_other')
);
expect(
  'R5 the panel shows my owner-queue block (queueId / target / age / status)',
  frame.includes('受保护目标队列 (1)') &&
    frame.includes('q_1_aaaa') &&
    frame.includes('ses_protected') &&
    frame.includes('30s') &&
    frame.includes('pending')
);
expect(
  'R7 the panel is read-only and says so',
  frame.includes('只读') && !/加锁|释放|unlock/i.test(frame)
);
expect(
  'R6 the snapshot is asked for this workspace and this session',
  reachable.calls[0]?.definition === 'collab.state' &&
    reachable.calls[0]?.input?.session === 'ses_probe' &&
    reachable.calls[0]?.input?.workspace === '/data/project/collab',
  JSON.stringify(reachable.calls[0]?.input)
);

/* ---------------------------------------------------------------- 3. unreachable */

const offline = harness({
  fail: true,
  sessions: [
    { id: 'ses_a1', title: 'alpha worker', agent: 'build' },
    { id: 'ses_b2', title: 'beta reader', agent: 'explore' }
  ]
});
await reachableCleanup();
const offlineCleanup = await plugin.setup(offline.context);
const offlinePanel = await mount(offline.context, () => offline.slots['session.panel'](panelInput()));
const offlineFrame = offlinePanel.frame;

expect(
  'R6 an unreachable server shows a banner instead of a blank panel',
  offlineFrame.includes('RPC 不可达') && offlineFrame.includes('ECONNREFUSED')
);
expect(
  'R6 the fallback lists the host sessions and labels itself',
  offlineFrame.includes('仅显示本地会话列表') &&
    offlineFrame.includes('ses_a1') &&
    offlineFrame.includes('alpha worker') &&
    offlineFrame.includes('ses_b2')
);
expect(
  'R6 the empty blocks say (不可达) instead of pretending "no leases"',
  !offlineFrame.includes('（无租约）') && offlineFrame.includes('（不可达）')
);
await offlinePanel.setup.dispose();

/* ------------------------------------------------- 4./5. poll follows the panel */

const [name, setName] = createSignal('collab.status');
const live = harness();
await offlineCleanup();
const liveCleanup = await plugin.setup(live.context);
const livePanel = await mount(live.context, () =>
  live.slots['session.panel'](panelInput({ get name() { return name(); } }))
);
const afterMount = live.calls.length;
await sleep(POLL_MS + 400);
const afterTick = live.calls.length;
expect(
  'R7 the panel polls every 2s while it is open',
  afterMount >= 1 && afterTick > afterMount,
  `${afterMount} → ${afterTick} calls`
);

setName('someone.else');
await sleep(120);
const afterSwitch = live.calls.length;
await sleep(POLL_MS + 400);
expect(
  'R7 switching to another panel stops the poll (and renders nothing)',
  live.calls.length === afterSwitch,
  `${afterSwitch} → ${live.calls.length} calls`
);
await livePanel.setup.renderOnce();
const switchedFrame = await livePanel.setup.captureCharFrame();
expect('R4 another plugin\'s panel is left untouched', !switchedFrame.includes('资源租约'));

setName('collab.status');
await sleep(POLL_MS + 400);
expect(
  'R7 reopening the panel resumes the poll',
  live.calls.length > afterSwitch,
  `${afterSwitch} → ${live.calls.length} calls`
);
await livePanel.setup.dispose();
await liveCleanup();

/* ------------------------------------------------------------------- 6. sidebar */

const side = harness();
const sideCleanup = await plugin.setup(side.context);
const sidebar = await mount(side.context, () => side.slots['sidebar.content']({ sessionID: 'ses_probe' }), {
  width: 40,
  height: 4
});
expect(
  'R5 the sidebar line is 锁 N · 交接 M · 队列 K',
  sidebar.frame.includes('锁 2 · 交接 1 · 队列 1'),
  sidebar.frame.trim()
);
await sidebar.setup.dispose();

const sideOffline = harness({ fail: true });
await sideCleanup();
const sideOfflineCleanup = await plugin.setup(sideOffline.context);
const sidebarOffline = await mount(sideOffline.context, () =>
  sideOffline.slots['sidebar.content']({ sessionID: 'ses_probe' }), { width: 40, height: 4 }
);
expect('R6 an unreachable server reads collab: n/a in the sidebar', sidebarOffline.frame.includes('collab: n/a'));
await sidebarOffline.setup.dispose();
await sideOfflineCleanup();

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAIL: ${check.title}`);
  process.exit(1);
}
process.exit(0);
