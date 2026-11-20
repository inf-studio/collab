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
 *      adds no RPC call;
 *   8. 0.6.1 (R3): keyboard dispatch in the host's shape — the registered layer
 *      factory is read, its `enabled()` gate is checked (current + focused panel
 *      only), and a keypress is dispatched only through that gate. A background
 *      or unfocused panel renders the tree but receives nothing. The real
 *      keybinding → command hop is a manual check on a live Desktop/TUI
 *      (research/impl-notes.md).
 */
import { createSignal } from 'solid-js';
import { createComponent, testRender } from '@opentui/solid';
import { PluginContextProvider } from '@opencode/plugin/tui';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
function harness({ fail = false, sessions = [], snapshot = SNAPSHOT, panelOpen = true, pending = 0 } = {}) {
  const slots = {};
  const layers = [];
  const calls = [];
  const opened = [];
  const toasts = [];
  const syncs = [];
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
    data: {
      session: {
        list: () => sessions,
        status: () => 'idle',
        // 0.6.0 (R4): 宿主排队 — the app's own prompt queue (`delivery:"queue"`).
        pending: {
          list: () => Array.from({ length: pending }, (_, index) => ({ id: `msg_pending_${index}` })),
          sync: async sessionID => {
            syncs.push(sessionID);
          },
          invalidate: () => {}
        }
      }
    },
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
  return { context, slots, layers, calls, opened, toasts, syncs };
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

/**
 * What the host does with one keypress (0.6.1, R3): it reads every registered
 * layer factory, **skips the layers whose `enabled()` is false**, and runs the
 * command bound to that key. Calling `run()` directly — as the 0.6.0 test did —
 * bypasses the gate the real host applies, so it cannot catch a layer that
 * stays enabled on a background (or unfocused) panel.
 */
function hostPress(target, bind) {
  let ran = 0;
  for (const factory of target.layers) {
    const layer = factory();
    if (layer?.enabled && !layer.enabled()) continue;
    for (const command of layer?.commands ?? []) {
      if (command.bind !== bind) continue;
      command.run();
      ran++;
    }
  }
  return ran;
}

/** The board layer (`enter`/`j`) of a harness, as the host would obtain it. */
function boardLayerOf(target) {
  return target.layers
    .map(factory => factory())
    .find(layer => layer?.commands?.some(command => command.bind === 'enter'));
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

/* ------------------------------------------ 5b. board tree (0.6.0, R1/R2/R3) */

// 2 workspaces → 1 active session with two hand-offs (one spawn) + 1 archived.
// The tree is default-collapsed; `↳` only appears after an explicit expand
// (keyboard `enter` or a mouse click), and `已归档` is a collapsed last section.
const TREE = {
  at: SNAPSHOT.at,
  reachable: true,
  sessions: [
    {
      sid: 'ses_a1',
      title: 'alpha worker',
      agent: 'build',
      busy: true,
      workspace: '/data/project/collab',
      frozen: { scope: 'session', target: 'ses_a1', until: SNAPSHOT.at + 600_000, reason: '等 schema 线' }
    },
    { sid: 'ses_child', title: 'child worker', agent: 'build', busy: true, workspace: '/data/project/collab' },
    {
      sid: 'ses_old',
      title: 'archived worker',
      agent: 'build',
      busy: false,
      workspace: '/data/project/collab',
      archived: true
    }
  ],
  locks: [
    {
      resource: 'named:tree-window',
      kind: 'named',
      mode: 'exclusive',
      holders: ['ses_a1'],
      waiters: 0,
      waiting: [],
      expiresInMs: 600_000
    }
  ],
  handoffs: [
    {
      bid: 'b_tree_spawn',
      state: 'claimed',
      ageMs: 10_000,
      from: 'ses_a1',
      claimBy: 'ses_child',
      spawned: 'ses_child',
      kind: 'spawn',
      title: 'spawn the child',
      workspace: '/data/project/collab'
    },
    {
      bid: 'b_tree_urgent',
      state: 'open',
      ageMs: 20_000,
      from: 'ses_a1',
      title: 'urgent thing',
      priority: 'urgent',
      workspace: '/data/project/collab'
    }
  ],
  queue: [{ queueId: 'q_tree', target: 'ses_p', ageMs: 1_000, summary: 'req', seen: false }]
};

const tree = harness({ snapshot: TREE });
const treeCleanup = await plugin.setup(tree.context);
const treeMounted = await mount(tree.context, () =>
  tree.slots['session.panel'](panelInput({ width: 100, sessionID: 'ses_a1' }))
);
const treeFrame = treeMounted.frame;

expect(
  'R2 the panel is a tree: workspace header counts (会话 · 锁 · 交接 · 已归档)',
  treeFrame.includes('2 会话 · 1 锁 · 2 交接 · 1 已归档'),
  treeFrame.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 5).join(' | ')
);
expect(
  'R2 the session row carries 🔒1 / ‹2› / [frozen] / [urgent]',
  treeFrame.includes('🔒1') &&
    treeFrame.includes('‹2›') &&
    treeFrame.includes('[frozen]') &&
    treeFrame.includes('[urgent]'),
  treeFrame.split('\n').find(line => line.includes('ses_a1'))?.trim()
);
expect(
  'R3 archived rows are hidden by default and only the folded header shows',
  treeFrame.includes('已归档 1') &&
    !treeFrame.includes('archived worker') &&
    !treeFrame.includes('[archived]'),
  treeFrame.split('\n').map(line => line.trim()).filter(Boolean).join(' | ')
);
expect(
  'R2 expansion is default-off: no ↳ child row before the user asks',
  !treeFrame.includes('↳')
);
expect(
  'R2 the queue is attached to its session row, not the orphan fallback',
  !treeFrame.includes('q_tree') && !treeFrame.includes('未归属'),
  treeFrame.split('\n').map(line => line.trim()).filter(Boolean).join(' | ')
);

const treeLayer = boardLayerOf(tree);
expect('R4 the panel registers a keyboard layer (enter/space toggles, j/k move)', Boolean(treeLayer));
expect(
  'R4 the layer is enabled while the panel is current and focused (the host would dispatch)',
  treeLayer?.enabled?.() === true,
  String(treeLayer?.enabled?.())
);
expect('R4 the host dispatches one enter to the board layer', hostPress(tree, 'enter') === 1);
await treeMounted.setup.renderOnce();
const expandedTree = await treeMounted.setup.captureCharFrame();
expect(
  'R2 enter expands the selected session: ↳ child + its lock / hand-off / queue',
  expandedTree.includes('↳') &&
    expandedTree.includes('ses_child') &&
    expandedTree.includes('named:tree-window') &&
    expandedTree.includes('b_tree_spawn') &&
    expandedTree.includes('⇢ q_tree') &&
    !expandedTree.includes('未归属'),
  expandedTree.split('\n').map(line => line.trim()).filter(Boolean).join(' | ')
);

hostPress(tree, 'j');
hostPress(tree, 'j');
hostPress(tree, 'enter');
await treeMounted.setup.renderOnce();
const archivedOpen = await treeMounted.setup.captureCharFrame();
expect(
  'R3 j moves to 已归档 and enter opens it: the archived row appears with [archived]',
  archivedOpen.includes('archived worker') && archivedOpen.includes('[archived]'),
  archivedOpen.split('\n').map(line => line.trim()).filter(Boolean).join(' | ')
);
await treeMounted.setup.dispose();
await treeCleanup();

// F2 + 0.6.1 (R3): the host's gate, not a direct `run()`. The panel is mounted
// with a **reactive** name/focus pair — the way the host passes `PanelInput` —
// so one mounted component can be "the open panel", "another panel", and
// "unfocused" without remounting. Two properties are checked:
//
//   - F2: switching away and back must not stack keyboard layers (a second
//     enabled `enter` layer would toggle twice = looks stuck, `j` would jump
//     two rows);
//   - R3: a keypress reaches the board only through `enabled()` — a background
//     or unfocused panel is skipped by the host, and its state stays untouched.
const gated = harness({ snapshot: TREE });
const gatedCleanup = await plugin.setup(gated.context);
const [panelName, setPanelName] = createSignal('collab.status');
const [panelFocused, setPanelFocused] = createSignal(true);
// A stable PanelInput object with reactive getters: this is how the host passes
// props. Rebuilding it through `panelInput()` would remount the component and
// hide the very bug we are testing (a layer re-registered inside an effect).
const gatedPanel = {
  get name() {
    return panelName();
  },
  get focused() {
    return panelFocused();
  },
  sessionID: 'ses_a1',
  width: 100,
  presentation: 'panel',
  focus() {},
  close() {},
  toggleFullscreen() {}
};
const gatedMounted = await mount(gated.context, () => gated.slots['session.panel'](gatedPanel));

const enabledLayers = () => gated.layers.map(factory => factory()).filter(layer => !layer?.enabled || layer.enabled());
const enabledBoardLayers = () =>
  enabledLayers().filter(layer => layer?.commands?.some(command => command.bind === 'enter'));
// `enabled()` lives on the **layer** (the host's gate), not on the command.
const gatedBoard = () => boardLayerOf(gated);
const gatedEnabled = () => gatedBoard()?.enabled?.();

expect(
  'R3 the current, focused panel: enabled() is true (the host would dispatch)',
  gatedEnabled() === true && enabledBoardLayers().length === 1,
  `${enabledBoardLayers().length} enabled / ${gated.layers.length} registrations`
);

// The host's own gate: with the panel unfocused it renders the tree but skips
// the layer, so `enter` must not expand anything.
setPanelFocused(false);
await sleep(60);
await gatedMounted.setup.renderOnce();
const unfocusedBefore = await gatedMounted.setup.captureCharFrame();
const unfocusedRan = hostPress(gated, 'enter');
await gatedMounted.setup.renderOnce();
const unfocusedAfter = await gatedMounted.setup.captureCharFrame();
expect(
  'R3 an unfocused panel is skipped by the host: enabled() false, 0 commands run, nothing expands',
  gatedEnabled() === false &&
    unfocusedRan === 0 &&
    unfocusedBefore.includes('▸ ses_a1') &&
    unfocusedAfter.includes('▸ ses_a1') &&
    !unfocusedAfter.includes('↳'),
  `enabled=${gatedEnabled()} ran=${unfocusedRan}`
);
setPanelFocused(true);
await sleep(60);

// Another plugin's panel is current: the layer exists but is disabled, the
// keypress is dropped, and switching back finds the tree exactly as it was.
setPanelName('someone.else');
await sleep(120);
const backgroundRan = hostPress(gated, 'enter');
setPanelName('collab.status');
await sleep(120);
await gatedMounted.setup.renderOnce();
const backFrame = await gatedMounted.setup.captureCharFrame();
expect(
  'R3 a background panel is skipped by the host (enabled() false, 0 commands run) and the board did not change',
  backgroundRan === 0 &&
    backFrame.includes('▸ ses_a1') &&
    !backFrame.includes('↳') &&
    !backFrame.includes('▾ ses_a1'),
  `ran=${backgroundRan} / ${backFrame.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 3).join(' | ')}`
);
expect(
  'R4 panel away→back leaves exactly one enabled board keyboard layer',
  enabledBoardLayers().length === 1,
  `${enabledBoardLayers().length} enabled / ${gated.layers.length} registrations`
);

// One host keypress on the current panel: exactly one command runs, exactly one
// row toggles (the F2 regression: two stacked layers would show as still folded).
const oneRan = hostPress(gated, 'enter');
await gatedMounted.setup.renderOnce();
const oneEnter = await gatedMounted.setup.captureCharFrame();
expect(
  'R4 one enter toggles once (the tree expands after a single keypress)',
  oneRan === 1 && oneEnter.includes('↳') && oneEnter.includes('▾ ses_a1'),
  `ran=${oneRan} / ${oneEnter.split('\n').map(line => line.trim()).filter(Boolean).join(' | ')}`
);
hostPress(gated, 'enter'); // fold back
hostPress(gated, 'j'); // one row: ses_a1 → ses_child
hostPress(gated, 'enter');
await gatedMounted.setup.renderOnce();
const oneJump = await gatedMounted.setup.captureCharFrame();
expect(
  'R4 one j moves one row (ses_child expands, not 已归档 / not two rows)',
  oneJump.includes('▾ ses_child') && !oneJump.includes('▾ ses_a1') && !oneJump.includes('▾ 已归档'),
  oneJump.split('\n').map(line => line.trim()).filter(Boolean).join(' | ')
);
await gatedMounted.setup.dispose();
await gatedCleanup();

// Mouse: clicking the session row itself expands it (no keyboard involved).
const treeMouse = harness({ snapshot: TREE });
const treeMouseCleanup = await plugin.setup(treeMouse.context);
const treeMouseMounted = await mount(treeMouse.context, () =>
  treeMouse.slots['session.panel'](panelInput({ width: 100, sessionID: 'ses_a1' }))
);
const beforeClick = await treeMouseMounted.setup.captureCharFrame();
const rowY = beforeClick.split('\n').findIndex(line => line.includes('▸ ses_a1'));
await treeMouseMounted.setup.mockMouse.click(4, rowY < 0 ? 4 : rowY);
await sleep(80);
await treeMouseMounted.setup.renderOnce();
const mouseFrame = await treeMouseMounted.setup.captureCharFrame();
expect(
  'R4 clicking a session row expands it (the same tree, mouse path) and does not open the detail block',
  mouseFrame.includes('↳') && mouseFrame.includes('ses_child') && !mouseFrame.includes('详情'),
  mouseFrame.split('\n').map(line => line.trim()).filter(Boolean).join(' | ')
);
await treeMouseMounted.setup.dispose();
await treeMouseCleanup();

/* ------------------ 5c. R4 (0.8.0): selected row detail (3–5 lines) + esc ---- */

// The tree is unchanged: at mount nothing is selected, so no `›` marker and no
// detail block. `j`/`k` select a row and append 3–5 lines under the tree; `esc`
// clears the selection without touching the tree's expand/collapse state.
const detailHarness = harness({ snapshot: TREE });
const detailCleanup = await plugin.setup(detailHarness.context);
const detailMounted = await mount(detailHarness.context, () =>
  detailHarness.slots['session.panel'](panelInput({ width: 100, sessionID: 'ses_a1' }))
);
const linesOf = frame => frame.split('\n').map(line => line.trimEnd()).filter(Boolean);
/**
 * The selected row's detail block, **scoped** to the lines between `详情 …` and
 * the next section. 0.8.0's `board2-graph` appends a `关系图 · …` section below
 * it; counting the whole frame delta would fold graph lines into "3–5 detail
 * lines" and make that contract depend on how many nodes the fixture happens to
 * have.
 */
const detailOnly = frame => {
  const rows = linesOf(frame);
  const start = rows.findIndex(line => line.includes('详情 '));
  if (start < 0) return [];
  const out = [rows[start]];
  for (const line of rows.slice(start + 1)) {
    if (/^(关系图|资源租约|未闭环交接|受保护目标队列|只读)/.test(line.trim())) break;
    out.push(line);
  }
  return out;
};
// `›` also ends the badges (`‹2›`), so the marker is "a line that *starts* with
// `› `" — that is the only place `panelLines` puts it.
const hasSelectionMarker = frame => linesOf(frame).some(line => line.startsWith('› '));
const mountLines = linesOf(detailMounted.frame);

expect(
  'R4 at mount no row is selected: no › marker and no 详情 block (the tree renders as before)',
  !hasSelectionMarker(detailMounted.frame) && !detailMounted.frame.includes('详情'),
  mountLines.slice(0, 6).join(' | ')
);

hostPress(detailHarness, 'j');
await detailMounted.setup.renderOnce();
const selectedFrame = await detailMounted.setup.captureCharFrame();
const selectedLines = linesOf(selectedFrame);
expect(
  'R4 j selects one row and appends 3–5 detail lines under the tree',
  hasSelectionMarker(selectedFrame) &&
    selectedFrame.includes('详情 ses_child') &&
    detailOnly(selectedFrame).length >= 3 &&
    detailOnly(selectedFrame).length <= 5 &&
    detailOnly(detailMounted.frame).length === 0,
  `${detailOnly(detailMounted.frame).length} → ${detailOnly(selectedFrame).length} detail lines: ${selectedLines
    .filter(line => line.includes('详情'))
    .join(' | ')}`
);
expect(
  'R4 the detail is header + counters + item rows (锁 / 交接 / 队列 / 拉起), from the same derivation',
  selectedFrame.includes('0 持有 · 0 排队 · 1 交接 · 0 队列 · 0 拉起') &&
    selectedFrame.includes('→ b_tree_spawn'),
  selectedLines.slice(-5).join(' | ')
);

hostPress(detailHarness, 'k');
await detailMounted.setup.renderOnce();
const backToFrame = await detailMounted.setup.captureCharFrame();
expect(
  'R4 k moves the selection back one row (details follow the selected session)',
  backToFrame.includes('详情 ses_a1') && backToFrame.includes('1 持有 · 0 排队 · 2 交接 · 1 队列 · 1 拉起'),
  linesOf(backToFrame).filter(line => line.includes('详情')).join(' | ')
);
// The item rows follow the documented order (locks → hand-offs → queue → `↳`),
// capped at three with `… +N` — ses_a1 has 5 rows, so the spawn never shows.
const detailBlock = frame => {
  const rows = linesOf(frame);
  const start = rows.findIndex(line => line.includes('详情 '));
  return start < 0 ? [] : rows.slice(start);
};
expect(
  'R4 the detail rows are ordered locks → hand-offs → … +N (↳ last, truncated here)',
  detailBlock(backToFrame)[2]?.includes('🔒 named:tree-window') &&
    detailBlock(backToFrame)[3]?.includes('→ b_tree_spawn') &&
    detailBlock(backToFrame)[4]?.includes('… +3') &&
    !detailBlock(backToFrame).slice(0, 5).some(line => line.includes('↳')),
  detailBlock(backToFrame).slice(0, 5).join(' | ')
);

hostPress(detailHarness, 'escape');
await detailMounted.setup.renderOnce();
const clearedFrame = await detailMounted.setup.captureCharFrame();
expect(
  'R4 esc clears the selection: no › marker, no detail block, the tree is unchanged',
  !hasSelectionMarker(clearedFrame) && !clearedFrame.includes('详情') && clearedFrame.includes('▸ ses_a1'),
  linesOf(clearedFrame).slice(0, 6).join(' | ')
);

// R4's detail block belongs to `j/k` only: `enter` keeps its 0.6.0 meaning
// (expand/collapse) and must not open a second copy of the same rows.
hostPress(detailHarness, 'enter');
await detailMounted.setup.renderOnce();
const enterFrame = await detailMounted.setup.captureCharFrame();
expect(
  'R4 enter expands the row but opens no detail block (only j/k selects)',
  enterFrame.includes('↳') &&
    enterFrame.includes('▾ ses_a1') &&
    !enterFrame.includes('详情') &&
    !hasSelectionMarker(enterFrame),
  linesOf(enterFrame).filter(line => line.includes('▾ ses_a1') || line.includes('详情')).join(' | ')
);
await detailMounted.setup.dispose();
await detailCleanup();

/* --------------------- 5d. 0.8.0 (board2-graph): the text tree + levels ----- */

// Two workspaces: a cross hand-off (alpha → beta) and a spawn inside alpha. At
// mount nothing is selected → L0 (workspaces + `─交接─▶`); `j` selects the alpha
// session → L2 (the centre ±1 hop, with `↳` for the spawn). Width 30 proves the
// clip (`…`) path instead of an overflow.
const GRAPH_TREE = {
  at: SNAPSHOT.at,
  reachable: true,
  sessions: [
    { sid: 'ses_g_a1', title: 'alpha worker', agent: 'build', busy: true, workspace: '/data/project/alpha' },
    {
      sid: 'ses_g_child',
      title: 'child worker',
      agent: 'build',
      busy: false,
      workspace: '/data/project/alpha',
      parent: 'ses_g_a1'
    },
    { sid: 'ses_g_b1', title: 'beta worker', agent: 'build', busy: false, workspace: '/data/project/beta' }
  ],
  locks: [],
  handoffs: [
    {
      bid: 'b_g_cross',
      state: 'claimed',
      ageMs: 1_000,
      from: 'ses_g_a1',
      claimBy: 'ses_g_b1',
      workspace: '/data/project/beta',
      title: 'cross-workspace work'
    },
    {
      bid: 'b_g_spawn',
      state: 'claimed',
      ageMs: 2_000,
      from: 'ses_g_a1',
      claimBy: 'ses_g_child',
      spawned: 'ses_g_child',
      kind: 'spawn',
      workspace: '/data/project/alpha',
      title: 'spawn the child'
    }
  ],
  queue: []
};

const graphTree = harness({ snapshot: GRAPH_TREE });
const graphTreeCleanup = await plugin.setup(graphTree.context);
const graphTreeMounted = await mount(graphTree.context, () =>
  graphTree.slots['session.panel'](panelInput({ width: 100, sessionID: 'ses_g_a1' }))
);
const graphMountFrame = graphTreeMounted.frame;
expect(
  'R3 the L0 graph is a workspace text tree with a ─交接─▶ edge',
  graphMountFrame.includes('关系图 · 全局') &&
    graphMountFrame.includes('alpha') &&
    graphMountFrame.includes('beta') &&
    graphMountFrame.includes('─交接─▶'),
  linesOf(graphMountFrame).filter(line => line.includes('关系图') || line.includes('─交接')).join(' | ')
);
expect(
  'R3 the L0 graph is read-only and adds no second RPC (same snapshot)',
  graphTree.calls.length === 1,
  `${graphTree.calls.length} calls`
);

// `j` moves the cursor to the **next** row (the child), `k` back to alpha —
// the host's own cursor semantics, not a selection call.
hostPress(graphTree, 'j');
hostPress(graphTree, 'k');
await graphTreeMounted.setup.renderOnce();
const graphSelectedFrame = await graphTreeMounted.setup.captureCharFrame();
expect(
  'R3 selecting a session switches the graph to L2 (session heading + ↳ spawn)',
  graphSelectedFrame.includes('关系图 · 会话 ses_g_a1') &&
    graphSelectedFrame.includes('─交接─▶') &&
    graphSelectedFrame.includes('↳') &&
    graphSelectedFrame.includes('ses_g_child'),
  linesOf(graphSelectedFrame).filter(line => line.includes('关系图') || line.includes('▶') || line.includes('↳')).join(' | ')
);
await graphTreeMounted.setup.dispose();
await graphTreeCleanup();

const narrowGraph = harness({ snapshot: GRAPH_TREE });
const narrowGraphCleanup = await plugin.setup(narrowGraph.context);
const narrowGraphMounted = await mount(
  narrowGraph.context,
  () => narrowGraph.slots['session.panel'](panelInput({ width: 30, sessionID: 'ses_g_a1' })),
  { width: 30, height: 30 }
);
hostPress(narrowGraph, 'j');
await narrowGraphMounted.setup.renderOnce();
const narrowGraphFrame = await narrowGraphMounted.setup.captureCharFrame();
expect(
  'R3 a 30-column panel clips the graph lines with … instead of crashing',
  narrowGraphFrame.includes('关系图') && narrowGraphFrame.includes('…'),
  linesOf(narrowGraphFrame).filter(line => line.includes('关系图') || line.includes('…')).join(' | ')
);
await narrowGraphMounted.setup.dispose();
await narrowGraphCleanup();

/* ------------------------------------------------------------------- 6. sidebar */

const side = harness();
const sideCleanup = await plugin.setup(side.context);
const sidebar = await mount(side.context, () => side.slots['sidebar.content']({ sessionID: 'ses_probe' }), {
  width: 40,
  height: 4
});
expect(
  'R5 the sidebar line is the four compact numbers 锁 · 排 · 待 · 宿',
  sidebar.frame.includes('锁 2 · 排 1 · 待 1 · 宿 0'),
  sidebar.frame.trim()
);
await sidebar.setup.dispose();

/* ------------------------- 6b. R4 (0.6.0): the four numbers, one vocabulary */

// 1 held + 3 queued + 2 owner-queue + 1 host pending → 锁 1 · 排 3 · 待 2 · 宿 1.
// The second lease is free with a stale waiter: it must NOT count as held (the
// old `locks.length` did — that was the misleading "锁 1").
const FOUR = {
  at: SNAPSHOT.at,
  reachable: true,
  sessions: [],
  locks: [
    {
      resource: 'named:test-window',
      kind: 'named',
      mode: 'exclusive',
      holders: ['ses_a'],
      waiters: 2,
      waiting: ['ses_b', 'ses_c'],
      expiresInMs: 600_000,
      waiterAgeMs: [1_000, 2_000]
    },
    {
      resource: 'named:build',
      kind: 'build',
      mode: 'exclusive',
      holders: [],
      waiters: 1,
      waiting: ['ses_d'],
      expiresInMs: 0,
      waiterAgeMs: [11 * 60_000],
      staleWaiters: ['ses_d'],
      stale: true
    }
  ],
  handoffs: [],
  queue: [
    { queueId: 'q_1_aaaa', target: 'ses_p', ageMs: 1_000, summary: 'a', seen: false },
    { queueId: 'q_2_bbbb', target: 'ses_p', ageMs: 2_000, summary: 'b', seen: false }
  ]
};

const four = harness({ snapshot: FOUR, pending: 1 });
const fourCleanup = await plugin.setup(four.context);
const fourSidebar = await mount(four.context, () => four.slots['sidebar.content']({ sessionID: 'ses_probe' }), {
  width: 46,
  height: 4
});
expect(
  'R4 the TUI sidebar reads 锁 1 · 排 3 · 待 2 · 宿 1 (held ≠ rows; the stale waiter holds nothing)',
  fourSidebar.frame.includes('锁 1 · 排 3 · 待 2 · 宿 1'),
  fourSidebar.frame.split('\n').map(line => line.trim()).filter(Boolean).join(' | ')
);
const fourPanel = await mount(four.context, () => four.slots['session.panel'](panelInput()), {
  width: 100,
  height: 30
});
expect(
  'R4 the TUI panel prints the same four numbers in the long form',
  fourPanel.frame.includes('持有 1 · 排队 3 · 待受保护 2 · 宿主排队 1'),
  fourPanel.frame.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 3).join(' | ')
);
expect(
  'R4 … and a legend so the four words are not guessed at',
  fourPanel.frame.includes('图例: 持有=真实持有者') &&
    fourPanel.frame.includes('排队=FIFO 等候') &&
    fourPanel.frame.includes('宿主排队=宿主 prompt 队列'),
  fourPanel.frame.split('\n').find(line => line.includes('图例'))?.trim() ?? '(无)'
);
await fourPanel.setup.dispose();
await fourSidebar.setup.dispose();
await fourCleanup();

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
    sidebarLines[0].includes('锁 2 · 排 1 · 待 1 · 宿 0') &&
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

/* -------------- 9. 0.9.7: the contract badge + the contract detail line ----- */

// The board derives the badge and the summary from the snapshot's optional
// `contract` block (the GUI uses the same functions). What is pinned here:
//
//   - the row badge is one glyph at the **end of the existing row** (no extra
//     line for a contract-bearing session);
//   - the selected row's detail gains exactly one line
//     `主线 … · 2/5 · todo 3 · drift 11h`;
//   - a session without a contract renders exactly the 0.9.6 detail (no line);
//   - at a narrow width the line is clipped with `…` instead of wrapping.
const CONTRACT_TREE = {
  at: SNAPSHOT.at,
  reachable: true,
  sessions: [
    {
      sid: 'ses_ct_a1',
      title: 'contract worker',
      agent: 'build',
      busy: true,
      workspace: '/data/project/contract',
      contract: {
        mission: {
          oneLine: '排钟 B4 接线',
          state: 'active',
          confirmed: true,
          inScope: ['排钟'],
          outOfScope: ['ws集群实施']
        },
        progress: { lit: 2, total: 5, next: 'M3「双写验证」' },
        todos: { open: 3, blocked: 1, suspended: 1, drifted: 1 },
        drift: { drifted: true, reason: '连续 6 轮无主线动作（11h）', since: Date.now() - 11 * 3_600_000 }
      }
    },
    { sid: 'ses_ct_a2', title: 'plain worker', agent: 'explore', busy: false, workspace: '/data/project/contract' }
  ],
  locks: [],
  handoffs: [],
  queue: []
};
const contractFrameLines = frame => frame.split('\n').map(line => line.trimEnd()).filter(Boolean);
{
  const harnessed = harness({ snapshot: CONTRACT_TREE });
  const cleanupTree = await plugin.setup(harnessed.context);
  const mounted = await mount(harnessed.context, () =>
    harnessed.slots['session.panel'](panelInput({ width: 100, sessionID: 'ses_ct_a1' }))
  );
  const lines = contractFrameLines(mounted.frame);
  const rowOf = sid => lines.find(line => line.includes(`${sid}  build`) || line.includes(`${sid}  explore`));
  const rowLine = rowOf('ses_ct_a1');
  expect(
    'T14 the contract badge ends the existing row (◇ for drift, no extra line)',
    Boolean(rowLine) &&
      rowLine.trim().endsWith('◇') &&
      lines.filter(line => line.includes('ses_ct_a1  build')).length === 1,
    `${rowLine} / ${lines.filter(line => line.includes('ses_ct_a1  build')).length} line(s)`
  );
  expect(
    'T14 a session without a contract keeps its row badge-free',
    Boolean(rowOf('ses_ct_a2')) && !rowOf('ses_ct_a2').includes('◇') && !rowOf('ses_ct_a2').includes('◑'),
    rowOf('ses_ct_a2')
  );

  /** The detail block of the selected row: after `详情 …`, before the next section. */
  const detailOf = frame => {
    const all = contractFrameLines(frame);
    const start = all.findIndex(line => line.startsWith('详情 ') || line.includes('详情 '));
    if (start < 0) return [];
    const out = [all[start]];
    for (const line of all.slice(start + 1)) {
      if (/^(关系图|资源租约|未闭环交接|受保护目标队列|只读)/.test(line.trim())) break;
      out.push(line);
    }
    return out;
  };

  // `j` from "nothing selected" lands on row index 1 (the plain session): its
  // detail must be the 0.9.6 three lines — the contract line is absent, not empty.
  hostPress(harnessed, 'j');
  await mounted.setup.renderOnce();
  const plainFrame = await mounted.setup.captureCharFrame();
  const plainDetail = detailOf(plainFrame);
  expect(
    'T14 a session without a contract adds no contract line to the detail',
    plainFrame.includes('详情 ses_ct_a2') && !plainFrame.includes('主线 ') && plainDetail.length === 3,
    plainDetail.join(' | ')
  );

  hostPress(harnessed, 'j');
  await mounted.setup.renderOnce();
  const contractFrame = await mounted.setup.captureCharFrame();
  const detail = detailOf(contractFrame);
  expect(
    'T14 the selected contract session’s detail has 主线 / 进度 / todo / drift on one line',
    contractFrame.includes('详情 ses_ct_a1') && detail[2] === '  主线 排钟 B4 接线 · 2/5 · todo 3 · drift 11h',
    detail.slice(0, 4).join(' | ')
  );
  await mounted.setup.dispose();
  await cleanupTree();
}
{
  // Width 34: the summary must be cut with `…` inside the panel width, never
  // wrapped (a wrap would push `drift 11h` onto the next line).
  const narrowTree = harness({ snapshot: CONTRACT_TREE });
  const narrowCleanup = await plugin.setup(narrowTree.context);
  const narrowMounted = await mount(
    narrowTree.context,
    () => narrowTree.slots['session.panel'](panelInput({ width: 34, sessionID: 'ses_ct_a1' })),
    { width: 34, height: 30 }
  );
  hostPress(narrowTree, 'j');
  hostPress(narrowTree, 'j');
  await narrowMounted.setup.renderOnce();
  const narrowFrame = await narrowMounted.setup.captureCharFrame();
  const narrowLines = contractFrameLines(narrowFrame);
  const contractLine = narrowLines.find(line => line.includes('主线 '));
  expect(
    'T14 at width 34 the contract line is truncated with … and never wraps',
    Boolean(contractLine) &&
      contractLine.endsWith('…') &&
      contractLine.startsWith('  主线 ') &&
      !narrowLines.some(line => line.trim() === 'drift 11h' || line.includes('· drift')),
    JSON.stringify(narrowLines.filter(line => line.includes('主线') || line.includes('drift')))
  );
  await narrowMounted.setup.dispose();
  await narrowCleanup();
}

/* ---- 9b. 0.9.7: an expired suspension is `drift 4.0d`, not `drift <1m` ------ */

// End-to-end for the bug the review found: the injection said 「T1 已挂起 4.0d
// 未醒」 while the TUI printed `drift <1m` (`driftSince` fell back to `now` for
// `suspended-expired`). The snapshot here is **really built by the server** from
// a real contract file, so this asserts the derivation and the formatting
// together — not just that the formatter can print `4.0d`.
{
  const contractDir = mkdtempSync(join(tmpdir(), 'collab-tui-contract-'));
  process.env.COLLAB_CONTRACT_DIR = contractDir;
  const t0 = Date.now();
  writeFileSync(
    join(contractDir, 'ses_ct_susp01.json'),
    `${JSON.stringify(
      {
        v: 1,
        sid: 'ses_ct_susp01',
        updatedAt: t0 - 1_000,
        mission: { oneLine: '排钟 B4 接线', state: 'active', confirmedBy: '@human', confirmedAt: t0 - 7_200_000 },
        plan: { milestones: [], lastAdvancedAt: 0 },
        todos: [
          {
            id: 'T1',
            kind: 'mainline',
            subject: '等复核',
            status: 'suspended',
            parkedAt: t0 - 4 * 86_400_000,
            wakeWhen: { kind: 'time', at: t0 - 3 * 86_400_000 },
            since: t0 - 4 * 86_400_000
          }
        ],
        todoSeq: 1,
        peers: [],
        turn: { count: 2, lastAt: t0 - 60_000, startedAt: t0 - 60_000, lastAdvancedAt: 0, noAdvanceTurns: 1 }
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  const server = await import(pathToFileURL(resolve(import.meta.dirname, '../dist/index.js')).href);
  const SUSPENDED = await server.__internals.buildSnapshot(
    {
      sessions: async () => [
        { id: 'ses_ct_susp01', agent: 'build', title: 'suspended worker', location: { directory: '/data/project/contract' } }
      ],
      locks: () => [],
      handoffs: () => [],
      queue: () => [],
      freezes: () => [],
      index: () => ({ available: true })
    },
    {},
    t0
  );
  const suspendedHarness = harness({ snapshot: SUSPENDED });
  const suspendedCleanup = await plugin.setup(suspendedHarness.context);
  const suspendedMounted = await mount(suspendedHarness.context, () =>
    suspendedHarness.slots['session.panel'](panelInput({ width: 100, sessionID: 'ses_ct_susp01' }))
  );
  hostPress(suspendedHarness, 'j');
  await suspendedMounted.setup.renderOnce();
  const suspendedFrame = await suspendedMounted.setup.captureCharFrame();
  const contractLine = contractFrameLines(suspendedFrame).find(line => line.includes('主线 '));
  expect(
    'T14b a server-derived 4-day expired suspension reads `drift 4.0d` (never `drift <1m`)',
    SUSPENDED.sessions[0]?.contract?.drift?.reason.includes('已挂起 4.0d') &&
      Boolean(contractLine) &&
      contractLine.includes('drift 4.0d') &&
      !contractLine.includes('drift <1m'),
    JSON.stringify({ drift: SUSPENDED.sessions[0]?.contract?.drift, line: contractLine })
  );
  await suspendedMounted.setup.dispose();
  await suspendedCleanup();
}

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAIL: ${check.title}`);
  process.exit(1);
}
process.exit(0);
