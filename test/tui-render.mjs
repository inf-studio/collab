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
 *   6. `sidebar.content` prints `锁 N · 交接 M · 队列 K` from the same store;
 *   7. 0.5.1 (R3): the sidebar summary **clicked** expands to detail rows, a
 *      detail row clicked opens `/collab`, the summary clicked again folds it —
 *      real mouse events through the renderer (no prop poking), and expanding
 *      adds no RPC call.
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

/** A host double: only the fields the plugin reads, plus call counters. */
function harness({ fail = false, sessions = [], snapshot = SNAPSHOT, panelOpen = true } = {}) {
  const slots = {};
  const layers = [];
  const calls = [];
  const opened = [];
  const toasts = [];
  const context = {
    options: {},
    location: { directory: '/data/project/collab' },
    app: { version: '2.3.1', channel: 'dev' },
    client: {
      rpc: definition => ({
        snapshot: async input => {
          calls.push({ definition: definition?.id, input });
          if (fail) throw new Error('connect ECONNREFUSED 10.0.0.5:4096');
          return snapshot;
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
      panel: {
        open: name => {
          opened.push(name);
          return panelOpen;
        },
        close: () => {},
        current: () => undefined
      },
      toast: {
        show: message => {
          toasts.push(message);
        }
      }
    }
  };
  return { context, slots, layers, calls, opened, toasts };
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

/* ------------------------------------ 7. sidebar: click to expand (0.5.1, R3) */

const SIDEBAR_SIZE = { width: 46, height: 8 };
const frameOf = async setup => {
  await setup.renderOnce();
  return setup.captureCharFrame();
};
const click = async (setup, x, y) => {
  await setup.mockMouse.click(x, y);
  await sleep(80);
};

const clickable = harness();
const clickableCleanup = await plugin.setup(clickable.context);
const clickableSide = await mount(
  clickable.context,
  () => clickable.slots['sidebar.content']({ sessionID: 'ses_probe' }),
  SIDEBAR_SIZE
);
const collapsedFrame = clickableSide.frame;
const sidebarLines = collapsedFrame.split('\n').map(line => line.trimEnd()).filter(Boolean);

expect(
  'R3 the sidebar starts collapsed: one line, a ▸ caret, no detail rows',
  sidebarLines.length === 1 &&
    sidebarLines[0].startsWith('▸') &&
    sidebarLines[0].includes('锁 2 · 交接 1 · 队列 1') &&
    !collapsedFrame.includes('🔒'),
  sidebarLines.join(' | ')
);

const callsBeforeExpand = clickable.calls.length;
await click(clickableSide.setup, 2, 0);
const expandedFrame = await frameOf(clickableSide.setup);
const expandedLines = expandedFrame.split('\n').map(line => line.trimEnd()).filter(Boolean);

expect(
  'R3 clicking the summary line expands it: ▾ plus the detail rows',
  expandedLines[0].startsWith('▾') &&
    expandedFrame.includes('named:test-window') &&
    expandedFrame.includes('named:build') &&
    expandedFrame.includes('b_00000000a1') &&
    expandedFrame.includes('q_1_aaaa'),
  expandedLines.length ? `${expandedLines.length} lines` : 'empty'
);
expect(
  'R3 the details go leases → hand-offs → queue, at most 4 rows',
  expandedLines.length === 1 + 4 &&
    /🔒 named:test-window/.test(expandedLines[1]) &&
    /🔒 named:build/.test(expandedLines[2]) &&
    /→ b_00000000a1/.test(expandedLines[3]) &&
    /⇢ q_1_aaaa/.test(expandedLines[4]),
  expandedLines.slice(1).join(' | ')
);
expect(
  'R3 expanding renders from the same snapshot: no extra load()',
  clickable.calls.length === callsBeforeExpand,
  `${callsBeforeExpand} → ${clickable.calls.length} calls`
);

await click(clickableSide.setup, 3, 2);
expect(
  'R3 clicking a detail row opens the /collab panel',
  clickable.opened.length === 1 && clickable.opened[0] === 'collab.status',
  JSON.stringify(clickable.opened)
);

await click(clickableSide.setup, 2, 0);
const foldedFrame = await frameOf(clickableSide.setup);
const foldedLines = foldedFrame.split('\n').map(line => line.trimEnd()).filter(Boolean);
expect(
  'R3 clicking the summary again folds it back to one line',
  foldedLines.length === 1 && foldedLines[0].startsWith('▸') && !foldedFrame.includes('🔒'),
  foldedLines.join(' | ')
);
expect(
  'R3 folding is free too: still the same number of loads',
  clickable.calls.length === callsBeforeExpand,
  `${callsBeforeExpand} → ${clickable.calls.length} calls`
);
await clickableSide.setup.dispose();
await clickableCleanup();

// 6 leases → 4 rows + `+2`: the overflow marker, not a truncated list that
// pretends everything fits.
const overflow = harness({
  snapshot: {
    ...SNAPSHOT,
    locks: Array.from({ length: 6 }, (_, index) => ({
      ...SNAPSHOT.locks[0],
      resource: `named:window-${index + 1}`,
      waiters: 0,
      waiting: []
    })),
    handoffs: [],
    queue: []
  }
});
const overflowCleanup = await plugin.setup(overflow.context);
const overflowSide = await mount(
  overflow.context,
  () => overflow.slots['sidebar.content']({ sessionID: 'ses_probe' }),
  SIDEBAR_SIZE
);
await click(overflowSide.setup, 2, 0);
const overflowFrame = await frameOf(overflowSide.setup);
const overflowLines = overflowFrame.split('\n').map(line => line.trimEnd()).filter(Boolean);
expect(
  'R3 more than 4 rows end with a +N line instead of growing without bound',
  overflowLines.length === 1 + 4 + 1 &&
    overflowFrame.includes('named:window-4') &&
    !overflowFrame.includes('named:window-5') &&
    overflowLines[5].trim() === '+2',
  overflowLines.map(line => line.trim()).join(' | ')
);
await overflowSide.setup.dispose();
await overflowCleanup();

// Degradations that must not throw: (a) no data at all, (b) the panel cannot be
// opened (no session in the host yet).
const emptySide = harness({ snapshot: { ...SNAPSHOT, locks: [], handoffs: [], queue: [] } });
const emptySideCleanup = await plugin.setup(emptySide.context);
const emptyMounted = await mount(
  emptySide.context,
  () => emptySide.slots['sidebar.content']({ sessionID: 'ses_probe' }),
  SIDEBAR_SIZE
);
await click(emptyMounted.setup, 2, 0);
const emptyFrame = await frameOf(emptyMounted.setup);
expect(
  'R3 an empty snapshot expands to an explicit "no activity" row (not a blank pane)',
  emptyFrame.includes('▾') && emptyFrame.includes('无协作活动 · 点击打开面板'),
  emptyFrame.split('\n').map(line => line.trim()).filter(Boolean).join(' | ')
);
await emptyMounted.setup.dispose();
await emptySideCleanup();

const refused = harness({ panelOpen: false });
const refusedCleanup = await plugin.setup(refused.context);
const refusedMounted = await mount(
  refused.context,
  () => refused.slots['sidebar.content']({ sessionID: 'ses_probe' }),
  SIDEBAR_SIZE
);
await click(refusedMounted.setup, 2, 0);
await click(refusedMounted.setup, 3, 1);
expect(
  'R4 a host that refuses panel.open gets the existing toast, and nothing throws',
  refused.opened.length === 1 &&
    refused.toasts.length === 1 &&
    /先打开一个会话/.test(refused.toasts[0]?.message ?? ''),
  JSON.stringify(refused.toasts)
);
await click(refusedMounted.setup, 2, 0);
const refusedFrame = await frameOf(refusedMounted.setup);
expect(
  'R4 the summary still folds after a refused open (the caret keeps working)',
  refusedFrame.includes('▸') && !refusedFrame.includes('🔒'),
  refusedFrame.split('\n').map(line => line.trim()).filter(Boolean).join(' | ')
);
await refusedMounted.setup.dispose();
await refusedCleanup();

const offlineSide = harness({ fail: true });
const offlineSideCleanup = await plugin.setup(offlineSide.context);
const offlineMounted = await mount(
  offlineSide.context,
  () => offlineSide.slots['sidebar.content']({ sessionID: 'ses_probe' }),
  SIDEBAR_SIZE
);
await click(offlineMounted.setup, 2, 0);
const offlineExpanded = await frameOf(offlineMounted.setup);
expect(
  'R3 expanded with no snapshot says collab: n/a, not "no activity"',
  offlineExpanded.includes('▾') &&
    offlineExpanded.includes('collab: n/a · 点击打开面板') &&
    !offlineExpanded.includes('无协作活动'),
  offlineExpanded.split('\n').map(line => line.trim()).filter(Boolean).join(' | ')
);
await offlineMounted.setup.dispose();
await offlineSideCleanup();

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAIL: ${check.title}`);
  process.exit(1);
}
process.exit(0);
