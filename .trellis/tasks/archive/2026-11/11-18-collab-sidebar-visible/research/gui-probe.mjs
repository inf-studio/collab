/**
 * Independent probe (check agent) — GUI half of 0.4.2.
 *
 *   cd /data/project/collab && node --conditions=browser /tmp/collab-check/gui-probe.mjs
 *
 * Loads the **shipped** bundle `dist/gui-experimental.cjs` (CJS, requires
 * `@opencode/plugin/gui`, which only exports an `import` condition) with:
 *   - jsdom as the DOM (real `solid-js/web` browser build);
 *   - `@opencode/plugin/gui` intercepted to the real ESM module, but with
 *     `usePlugin` replaced by our fake context (that is the only thing the host
 *     would otherwise provide).
 * Nothing from the repo's own tests is imported.
 *
 * EVIDENCE COPY (check agent). Run from /tmp/collab-check with jsdom + symlinked
 * node_modules (`npm i --no-save jsdom`, then symlink solid-js/@opencode/@opentui),
 * e.g. `cd /data/project/collab && node --conditions=browser /tmp/collab-check/tui-probe.mjs`.
 * See check-report.md for the exact commands and outputs.
 */
import { createRequire } from 'node:module';
import Module from 'node:module';
import { createRoot } from 'solid-js';

const { JSDOM } = await import('/tmp/collab-check/node_modules/jsdom/lib/api.js');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'DocumentFragment', 'customElements', 'navigator']) {
  try {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true, writable: true });
  } catch {
    // node 26 exposes `navigator` as a getter-only global; jsdom's value is not needed.
  }
}
globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);

const gui = await import('/data/project/collab/node_modules/@opencode/plugin/dist/gui/index.js');
const holder = { current: undefined };
const guiShim = { ...gui, usePlugin: () => holder.current };

const require = createRequire('/data/project/collab/');
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === '@opencode/plugin/gui') return guiShim;
  return originalLoad.call(this, request, parent, isMain);
};
const bundle = require('/data/project/collab/dist/gui-experimental.cjs');
Module._load = originalLoad;
const plugin = bundle.default ?? bundle;

const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};

const SNAPSHOT = {
  at: 1_800_000_000_000,
  reachable: true,
  sessions: [{ sid: 'ses_a', title: 'alpha', agent: 'build', busy: false, workspace: '/data/project/collab' }],
  locks: [{ resource: 'named:build', kind: 'named', mode: 'exclusive', holders: ['ses_a'], waiters: 0, waiting: [], expiresInMs: 60_000 }],
  handoffs: [],
  queue: []
};

/** A host double; `layout` mirrors the real "no state yet = undefined" case. */
function harness({ options = {}, state = () => undefined, rpc = async () => SNAPSHOT, hasSession = true } = {}) {
  const added = [];
  const opened = [];
  const ctx = {
    id: 'collab',
    options,
    t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
    plural: (key, count) => `${key}:${count}`,
    layout: {
      state: path => state(path),
      open: (path, session) => opened.push({ path, session })
    },
    sessions: {
      current: () => (hasSession ? { id: 'ses_a' } : undefined),
      list: () => [{ id: 'ses_a', title: 'alpha' }]
    },
    client: { rpc: () => ({ snapshot: rpc }) },
    theme: {},
    add: (component, value) => added.push({ component, value }),
    css: () => {},
    i18n: () => {}
  };
  holder.current = ctx;
  return { ctx, added, opened };
}

/** Run `setup` inside an owner (the host does the same) and pick contributions. */
function setup(harness) {
  let result;
  createRoot(dispose => {
    result = { dispose, ret: plugin.setup(harness.ctx) };
  });
  const find = marker => harness.added.find(entry => entry.component === marker)?.value;
  return { ...result, panel: find(gui.Panel), menu: find(gui.MenuItem), pill: find(gui.ComposerPill) };
}

const tick = (ms = 0) => new Promise(done => setTimeout(done, ms));

/* ------------------------------------------------------- 1. default: visible */

const first = harness();
const firstSetup = setup(first);
const firstList = firstSetup.panel?.list;
expect('R1 setup registers a side Panel', typeof firstList === 'function' && firstSetup.panel.region === 'side');
expect(
  'R2 autoOpen default: list() returns the tab even with nothing open',
  Array.isArray(firstList?.({ open: [] })) && firstList({ open: [] }).length === 1,
  JSON.stringify(firstList?.({ open: [] })?.map(tab => tab.id))
);
expect(
  'R2 autoOpen default: another plugin tab being open does not remove it',
  firstList?.({ open: ['other:main'] })?.length === 1,
  JSON.stringify(firstList?.({ open: ['other:main'] })?.map(tab => tab.id))
);
expect('R2 the tab id is main and it is a fallback tab', firstList({ open: [] })[0]?.id === 'main' && firstList({ open: [] })[0]?.fallback === true);

/* ------------------------------------------- 1b. opened: undefined/closed/open */

const stateCases = [
  ['undefined (first visit)', () => undefined, false],
  ['closed', () => 'closed', false],
  ['open', () => 'open', true]
];
for (const [label, state, want] of stateCases) {
  const probe = harness({ state });
  const built = setup(probe);
  const item = typeof built.menu === 'function' ? built.menu() : built.menu;
  expect(`R1 + menu "opened" with state ${label} → ${want}`, item?.opened === want, String(item?.opened));
}
const noSession = harness({ state: () => undefined, hasSession: false });
const noSessionBuilt = setup(noSession);
const noSessionMenu = typeof noSessionBuilt.menu === 'function' ? noSessionBuilt.menu() : noSessionBuilt.menu;
expect('R1 "opened" is false when no session is mounted', noSessionMenu?.opened === false, String(noSessionMenu?.opened));
const reopen = harness({ state: () => undefined });
const reopenSetup = setup(reopen);
(typeof reopenSetup.menu === 'function' ? reopenSetup.menu() : reopenSetup.menu)?.run?.();
expect(
  'R1 the + menu still opens the panel (run → layout.open)',
  reopen.opened[0]?.path === 'collab:main' && reopen.opened[0]?.session?.id === 'ses_a',
  JSON.stringify(reopen.opened)
);
firstSetup.dispose();

/* --------------------------------------------------- 2. autoOpen: false opt-in */

const optOut = harness({ options: { autoOpen: false } });
const optOutSetup = setup(optOut);
expect(
  'R2 autoOpen:false → list() is empty until the tab is opened',
  optOutSetup.panel.list({ open: [] }).length === 0,
  JSON.stringify(optOutSetup.panel.list({ open: [] }))
);
expect(
  'R2 autoOpen:false → list() returns the tab once it is open',
  optOutSetup.panel.list({ open: ['main'] }).length === 1
);
optOutSetup.dispose();

/* ------------------------------------------------- 2b. unreachable panel view */

const offline = harness({ rpc: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:4096'); } });
const offlineSetup = setup(offline);
let thrown;
let node;
try {
  node = offlineSetup.panel.render({ session: { id: 'ses_a' } });
  dom.window.document.body.appendChild(node);
  await tick(60);
} catch (error) {
  thrown = error;
}
const text = node?.textContent ?? '';
expect('R3 an unreachable RPC does not throw inside the panel render', !thrown, thrown ? String(thrown).slice(0, 160) : 'no throw');
expect(
  'R3 … and the panel shows the "server unreachable" placeholder',
  text.includes('panel.unreachable') && text.includes('ECONNREFUSED'),
  JSON.stringify(text.slice(0, 120))
);
expect('R3 … with no stale rows invented', !text.includes('named:build'));
offlineSetup.dispose();

/* --------------------------------- 2c. reachable: rows render, queue absence OK */

const live = harness();
const liveSetup = setup(live);
let liveNode;
try {
  liveNode = liveSetup.panel.render({ session: { id: 'ses_a' } });
  dom.window.document.body.appendChild(liveNode);
  await tick(60);
} catch (error) {
  thrown = error;
}
const liveText = liveNode?.textContent ?? '';
expect('R3 a reachable snapshot renders without throwing', !thrown, thrown ? String(thrown).slice(0, 160) : 'no throw');
expect('R3 … and shows the lease row', liveText.includes('named:build'), JSON.stringify(liveText.slice(0, 120)));
// An older server (0.4.1) answers without `queue`: the GUI never reads it, so it
// must still be fine. Re-check with the field deleted.
const legacy = harness({
  rpc: async () => {
    const { queue, ...rest } = SNAPSHOT;
    return rest;
  }
});
const legacySetup = setup(legacy);
let legacyThrown;
let legacyNode;
try {
  legacyNode = legacySetup.panel.render({ session: { id: 'ses_a' } });
  dom.window.document.body.appendChild(legacyNode);
  await tick(60);
} catch (error) {
  legacyThrown = error;
}
expect(
  'R6 a 0.4.1 server (snapshot without `queue`) still renders',
  !legacyThrown && (legacyNode?.textContent ?? '').includes('named:build'),
  legacyThrown ? String(legacyThrown).slice(0, 160) : 'ok'
);
legacySetup.dispose();
liveSetup.dispose();

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAIL: ${check.title}`);
  process.exit(1);
}
process.exit(0);
