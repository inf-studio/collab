/**
 * 0.5.1 (R1/R2): the **desktop** entry points, exercised against the shipped
 * bundle (`dist/gui-experimental.cjs`, the file the host evaluates).
 *
 *   node test/gui-entry.mjs          # `pnpm test` runs it after the build
 *
 * Why a resolution hook: the bundle is CommonJS and `require`s its peers, but
 * `@opencode/plugin/gui` is published with an `import` condition only — Node's
 * `exports` lookup has no `require` branch for it, so a plain `require` of the
 * bundle fails before any of our code runs. Mapping the bare specifier to the
 * package's own file lets Node's `require(esm)` load the very module the host
 * loads (the app does the same thing through its bundler). Everything after that
 * is the bundle's real `setup`.
 *
 * What is checked (no window, no Electron, no DOM):
 *
 *   1. the 0.4.2 contributions are still registered — `Panel`, `MenuItem`,
 *      `ComposerPill` (no regression);
 *   2. a `Command` exists with `mod+shift+l`, `/collab`, the palette title and
 *      keywords, `section:"navigation"`, and `enabled` following the routed
 *      session;
 *   3. its `run` opens this plugin's panel tab for the current session — and,
 *      with no session, shows the probe toast instead (0.5.2, R3);
 *   4. a `Slot` at `session.header` with a render function is registered;
 *   5. both locales carry the `command.*` / `header.*` keys, and
 *      `header.counts` really interpolates the three numbers;
 *   6. the entry points introduce no write path: no tool/permission/prompt call
 *      is reachable from the setup (the fake context has none, so a write
 *      attempt would throw);
 *   7. 0.5.2 (R2): a `TitlebarItem` probe — `collab` with no snapshot, `collab N`
 *      with one, panel on click with a session, "loaded" toast without one;
 *   8. 0.5.2 (R7): a reload asked for while a request is in flight is re-run for
 *      the new session instead of being dropped until the next 2 s tick.
 *   9. 0.5.3 (R1/R2/R3): the snapshot is read through the routed session's
 *      **server** (`ctx.sessions.current().server.client`), falling back to
 *      `ctx.client`; a cross-server switch reloads at once; a slow reply from the
 *      previous server is dropped instead of being written into the new server's
 *      state; the probe toast names the source server and the version.
 */
import Module from 'node:module';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';


/**
 * Two shims the bundle needs before it can be *loaded* in Node (neither of them
 * renders anything — this test stops at registration):
 *
 *   - the bundle is compiled against Solid's **client** build, so it has to be
 *     loaded with `--conditions=browser` (otherwise `solid-js/web` resolves to
 *     the server build, where `template()` throws "client-only API");
 *   - its `onClick` compiles to Solid's delegated events, and the compiled module
 *     registers the delegation at load time (`delegateEvents(["click"])`), which
 *     reads `window.document`. No DOM is needed beyond `addEventListener`: every
 *     template body is created lazily and this test never renders one.
 */
globalThis.window ??= globalThis;
// 0.5.2: the GUI tracks `visibilitychange` instead of reading `document.hidden`
// once. The stub keeps the listeners so the test can drive visibility.
const docStub = {
  hidden: false,
  listeners: new Map(),
  addEventListener(type, fn) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  },
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  },
  createElement() {
    throw new Error('gui-entry.mjs: no DOM is created by this test');
  }
};
globalThis.document ??= docStub;
const setHidden = value => {
  docStub.hidden = value;
  for (const fn of [...(docStub.listeners.get('visibilitychange') ?? [])]) fn({ type: 'visibilitychange' });
};

import { createRoot, createSignal } from 'solid-js';
import { realpathSync } from 'node:fs';

const root = resolve(import.meta.dirname, '..');
const guiModule = resolve(root, 'node_modules/@opencode/plugin/dist/gui/index.js');
const bundle = resolve(root, 'dist/gui-experimental.cjs');

// One Solid instance for the bundle, the SDK and this test. The bundle is CJS
// (`require("solid-js")` → solid.cjs) while the SDK and the test use the ESM
// build, and a signal read from one instance is invisible to a memo owned by the
// other — the harness silently lost reactivity (review R-9). Mapping the
// specifier makes all three share the ESM build (Node can require it).
// `realpathSync`, not the symlink path: Node keys a required module by the path
// it was handed and an imported one by its real URL, so mapping through the
// workspace symlink would still produce two Solid instances (and every
// `onCleanup` in the bundle would silently never run).
const solidEsm = realpathSync(resolve(root, 'node_modules/solid-js/dist/solid.js'));
const solidWebEsm = realpathSync(resolve(root, 'node_modules/solid-js/web/dist/web.js'));
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@opencode/plugin/gui') return guiModule;
  if (request === 'solid-js') return solidEsm;
  if (request === 'solid-js/web') return solidWebEsm;
  return originalResolve.call(this, request, ...rest);
};
const requireCjs = createRequire(import.meta.url);
const plugin = requireCjs(bundle).default;

const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};

const POLL_MS = 2000;
const SESSION = { id: 'ses_probe', key: 'srv\nses_probe', directory: '/data/project/collab' };

/** The plugin's own catalog, with `{{name}}` substitution — what `ctx.t` does. */
function translator(locale) {
  const catalog = plugin.i18n?.[locale] ?? {};
  return (key, params = {}) => {
    const template = catalog[key] ?? key;
    return String(template).replace(/\{\{(\w+)\}\}/g, (_, name) => String(params[name] ?? `{{${name}}}`));
  };
}

/**
 * A host double: only what `setup` reads. `add` runs the factory form at once,
 * like the window does, and records the registry's own id — plus the factory,
 * so a test can run it again after the shared store received a snapshot (the
 * real host re-runs it reactively).
 *
 * The context is a **strict** proxy: reading an API this test did not provide
 * throws. That is what makes "the entry points are read-only" checkable — a
 * setup that reached for `ctx.session`, `ctx.tools` or a permission API would
 * fail here instead of silently getting `undefined`. `toast.show` only records:
 * there is no button to click and nothing it could write.
 *
 * `delayMs` makes the snapshot answer slowly, so a test can switch sessions
 * *while* a request is in flight (R-7).
 *
 * 0.5.3: `client` (the window's own, i.e. `ctx.client`) and every
 * `session.server.client` are **separate** doubles, each with its own `calls`
 * array — that is the only way to tell "read from the routed session's server"
 * apart from "read from this computer".
 */
function fakeClient({ snapshot, delayMs = 0 } = {}) {
  const calls = [];
  return {
    calls,
    rpc: () => ({
      snapshot: async input => {
        calls.push(input);
        if (delayMs > 0) await new Promise(done => setTimeout(done, delayMs));
        return typeof snapshot === 'function' ? snapshot(input) : snapshot;
      }
    })
  };
}

/** A mounted session that belongs to a named server (`ServerRef`-shaped). */
function serverSession(id, server, client, { local = false } = {}) {
  return {
    id,
    key: `${server}\n${id}`,
    directory: '/data/project/collab',
    server: {
      id: server,
      name: server,
      url: `http://${server}`,
      client,
      local,
      builtin: local,
      compatible: true,
      connected: true
    }
  };
}

function harness({ locale = 'zh', session = SESSION, snapshot, reactiveSession = false, delayMs = 0 } = {}) {
  const registered = [];
  const opened = [];
  const toasts = [];
  const [currentSession, setCurrentSession] = createSignal(session);
  const client = fakeClient({ snapshot, delayMs });
  const calls = client.calls;
  const target = {
    id: 'collab',
    options: {},
    t: translator(locale),
    plural: (key, count) => translator(locale)(`${key}.other`, { count }),
    add: (registry, item) => {
      const factory = typeof item === 'function' ? item : undefined;
      registered.push({ registry: registry?.id, item: factory ? factory() : item, factory });
      return () => {};
    },
    layout: {
      open: (key, at) => opened.push({ key, session: at }),
      state: () => undefined
    },
    // What the window always provides and the probe reads (`ctx.app`).
    app: { name: 'opencode', version: '2.5.0', channel: 'prod', platform: 'desktop', packaged: true },
    toast: {
      show: options => {
        toasts.push(options);
        return { dismiss() {} };
      }
    },
    // Empty list: no session is mounted, so the poller never starts until a test
    // sets `sessions.list` (this test is about registration and the store, not
    // the 2 s timer as such).
    sessions: { list: () => [], current: () => (reactiveSession ? currentSession() : session) },
    client
  };
  const context = new Proxy(target, {
    get(object, key) {
      if (typeof key === 'symbol' || key === 'then' || key === 'toJSON') return undefined;
      if (!(key in object)) throw new Error(`setup read ctx.${String(key)}, which this test does not provide`);
      return object[key];
    }
  });
  return { context, target, registered, opened, toasts, calls, client, setCurrentSession };
}

const find = (registered, id) => registered.find(entry => entry.registry === id);
/** The factory's current answer — what the host re-renders when the store changes. */
const rerun = entry => (entry.factory ? entry.factory() : entry.item);

/* ------------------------------------------------------------- 1. registration */

const zh = harness();
const cleanup = plugin.setup(zh.context);

const all = zh.registered.map(entry => entry.registry).join(', ');
expect(
  'R1/R2 the 0.4.2 contributions are still registered',
  ['panel', 'menu-item', 'composer-pill'].every(id => !!find(zh.registered, id)),
  all
);
expect(
  'R1 a Command and a Slot(session.header) are registered',
  !!find(zh.registered, 'command') && !!find(zh.registered, 'slot'),
  all
);
expect('R2 the setup returns no cleanup that writes (it may return one)', typeof cleanup === 'function' || cleanup === undefined);

/* ------------------------------------------------------------------ 2. Command */

const command = find(zh.registered, 'command').item;
expect(
  'R1 the command is collab.open, mod+shift+l, /collab, navigation',
  command.id === 'open' &&
    command.bind === 'mod+shift+l' &&
    command.slash?.name === 'collab' &&
    command.section === 'navigation' &&
    command.group === 'Collab',
  JSON.stringify({ id: command.id, bind: command.bind, slash: command.slash, section: command.section })
);
expect(
  'R1 the palette title and description are translated (zh)',
  command.title === '打开协作面板' && /只读/.test(command.description),
  `${command.title} / ${command.description}`
);
expect(
  'R1 the keywords carry both the English and the Chinese words',
  /collab/.test(command.keywords ?? '') && /租约/.test(command.keywords ?? '') && /交接/.test(command.keywords ?? ''),
  command.keywords
);
expect('R1 the command is enabled while a session is routed', command.enabled === true);
expect('R5 the command declares no write action (only open/close of the panel text)', !/unlock|释放|archive|归档/i.test(`${command.title} ${command.description}`));

/* --------------------------------------------------------------- 3. Command.run */

zh.opened.length = 0;
command.run();
expect(
  'R1 run opens this plugin\'s panel tab for the current session',
  zh.opened.length === 1 && zh.opened[0].key === 'collab:main' && zh.opened[0].session?.id === 'ses_probe',
  JSON.stringify(zh.opened[0]?.key)
);

const idle = harness({ session: null });
plugin.setup(idle.context);
const idleCommand = find(idle.registered, 'command').item;
let threw = false;
try {
  idleCommand.run();
} catch {
  threw = true;
}
expect(
  'R1/R3 without a routed session the command is disabled and run() falls back to the probe toast',
  idleCommand.enabled === false && idle.opened.length === 0 && !threw && idle.toasts.length === 1,
  JSON.stringify({ enabled: idleCommand.enabled, opened: idle.opened.length, toasts: idle.toasts.length })
);

/* -------------------------------------------------------------------- 4. Slot */

const slot = find(zh.registered, 'slot').item;
expect(
  'R2 the slot renders in the session header',
  slot.at === 'session.header' && typeof slot.render === 'function',
  JSON.stringify({ at: slot.at, order: slot.order })
);
expect('R2 the header counts sit beside the title, not in place of it (order 20)', slot.order === 20);

/* ------------------------------------------------------------------ 5. catalog */

const keys = [
  'command.open',
  'command.description',
  'command.group',
  'header.counts',
  'header.title',
  'header.unreachable',
  'titlebar.title',
  'probe.title',
  'probe.description',
  'panel.source'
];
for (const locale of ['en', 'zh']) {
  const missing = keys.filter(key => typeof plugin.i18n?.[locale]?.[key] !== 'string');
  expect(`R1/R2 ${locale} defines every entry-point key`, missing.length === 0, missing.join(', ') || keys.join(', '));
}
expect(
  'R2 header.counts carries the four placeholders (0.6.0: 持有/排队/待受保护/宿主排队) and interpolates them',
  zh.context.t('header.counts', { held: 1, waiting: 3, protected: 2, host: 1 }) ===
    '持有 1 · 排队 3 · 待受保护 2 · 宿主排队 1',
  zh.context.t('header.counts', { held: 1, waiting: 3, protected: 2, host: 1 })
);
expect(
  'R2 an unreachable server reads collab: n/a (not 0 · 0 · 0)',
  zh.context.t('header.unreachable') === 'collab: n/a',
  zh.context.t('header.unreachable')
);

/* ------------------------------------------------------------ 6. no write path */

expect(
  'R5 setup reads only the APIs it declares (strict context: no tool/permission/write API)',
  zh.registered.length > 0,
  zh.registered.map(entry => entry.registry).join(', ')
);
expect(
  'R5 registering the entry points asks the server for nothing (no new RPC stream)',
  zh.calls.length === 0,
  `${zh.calls.length} calls`
);

/* ------------------------------------------- 7. one stream, one poll (R2 / R5) */

// A mounted session switches the window's single poller on. It must stay one
// call per tick, and that call has to name the routed session — otherwise the
// header's `队列` number would be the server's "no session ⇒ empty queue"
// answer (a permanent 0 that is not a fact).
const live = harness({ snapshot: { at: 1, reachable: true, sessions: [], locks: [], handoffs: [], queue: [] } });
live.target.sessions.list = () => [SESSION];
plugin.setup(live.context);
await new Promise(done => setTimeout(done, 120));
expect(
  'R2 the one poll names the routed session (the queue number is real, not a default 0)',
  live.calls.length === 1 && live.calls[0].session === 'ses_probe',
  JSON.stringify(live.calls[0] ?? null)
);
expect('R2 the poll opens no panel by itself (opening stays a user action)', live.opened.length === 0);

// 0.5.1 review R-3: the poll is keyed on the routed session. Switching sessions
// must reload immediately, not after up to 2 s with the previous session's queue
// (the queue is per-requester, so a stale one is a wrong number, not a slow one).
const OTHER = { ...SESSION, id: 'ses_other' };
const switching = harness({
  snapshot: { at: 1, reachable: true, sessions: [], locks: [], handoffs: [], queue: [] },
  reactiveSession: true
});
switching.target.sessions.list = () => [SESSION, OTHER];
plugin.setup(switching.context);
await new Promise(done => setTimeout(done, 120));
const beforeSwitch = switching.calls.length;
switching.setCurrentSession(OTHER);
await new Promise(done => setTimeout(done, 120));
expect(
  'R2 switching the routed session reloads at once (no 2s window with the old queue)',
  beforeSwitch >= 1 &&
    switching.calls.length > beforeSwitch &&
    switching.calls.at(-1)?.session === 'ses_other',
  `${beforeSwitch} → ${switching.calls.length}: ${JSON.stringify(switching.calls.at(-1) ?? null)}`
);

/* ------------------------------- 8. the probe: a titlebar pill (R2/R3, R4 read-only) */

const pillEntry = find(zh.registered, 'titlebar-item');
const pill = pillEntry?.item;
expect(
  'R2 a TitlebarItem pill is registered (id "status", lock icon)',
  pill?.id === 'status' && pill.icon === 'lock' && typeof pill.run === 'function',
  JSON.stringify(pill ?? null)
);
expect(
  'R2 with no snapshot yet the pill reads "collab", never "collab 0"',
  pill.label === 'collab',
  pill?.label
);
expect('R2 the pill carries a translated title', pill.title === '协作状态 — 打开面板', pill?.title);

zh.toasts.length = 0;
zh.opened.length = 0;
pill.run();
expect(
  'R2 with a routed session the pill opens the panel and shows no toast',
  zh.opened.length === 1 &&
    zh.opened[0].key === 'collab:main' &&
    zh.opened[0].session?.id === 'ses_probe' &&
    zh.toasts.length === 0,
  JSON.stringify({ opened: zh.opened.length, toasts: zh.toasts.length })
);

// No routed session: the click is the probe. A toast proves this window loaded
// the GUI; nothing is opened, because there is no panel to open.
const idlePill = find(idle.registered, 'titlebar-item').item;
idle.opened.length = 0;
idle.toasts.length = 0;
idlePill.run();
const probeToast = idle.toasts[0];
expect(
  'R2 with no routed session the pill shows the "loaded" toast and opens nothing',
  idle.opened.length === 0 && idle.toasts.length === 1 && /已加载/.test(probeToast?.title ?? ''),
  JSON.stringify({ opened: idle.opened.length, title: probeToast?.title })
);
expect(
  'R2 the probe toast names the plugin, version, panel key, app/platform and source server',
  probeToast?.variant === 'success' &&
    /v\d+\.\d+\.\d+/.test(probeToast.description) &&
    /id=collab/.test(probeToast.description) &&
    /panel=collab:main/.test(probeToast.description) &&
    /app=2\.5\.0\(desktop\)/.test(probeToast.description) &&
    /server=this computer/.test(probeToast.description),
  probeToast?.description
);

// The bundle cannot import `constants.ts` (it reads `node:os`), so the version
// is restated once, in the probe. This is the check that keeps the restatement
// honest: package.json, PLUGIN_VERSION and the toast must always agree.
const pkgVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const constantsVersion = /PLUGIN_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(resolve(root, 'src/constants.ts'), 'utf8'))?.[1];
expect(
  'R2 package.json, PLUGIN_VERSION and the probe toast carry the same version',
  pkgVersion === constantsVersion && new RegExp(`v${pkgVersion.replaceAll('.', '\\.')}`).test(probeToast?.description ?? ''),
  JSON.stringify({ pkgVersion, constantsVersion })
);

idle.toasts.length = 0;
idleCommand.run();
expect(
  'R3 the command with no session shows the same toast as the pill (one implementation)',
  idle.toasts.length === 1 &&
    idle.toasts[0].title === probeToast.title &&
    idle.toasts[0].description === probeToast.description &&
    idle.toasts[0].variant === probeToast.variant,
  JSON.stringify(idle.toasts[0] ?? null)
);

// With a snapshot the pill counts what the panel counts: leases + open
// hand-offs + the requester's queue.
const counted = harness({
  snapshot: {
    at: 1,
    reachable: true,
    sessions: [],
    locks: [{}, {}],
    handoffs: [{}],
    queue: [{}, {}, {}]
  }
});
counted.target.sessions.list = () => [SESSION];
plugin.setup(counted.context);
await new Promise(done => setTimeout(done, 120));
const countedPill = rerun(find(counted.registered, 'titlebar-item'));
expect(
  'R2 with a snapshot the pill reads "collab N" (leases + hand-offs + queue)',
  countedPill.label === 'collab 6',
  countedPill.label
);

/* ---------------------------- 9. R-7: a reload is never lost to an in-flight request */

// The slow answer: a 250 ms snapshot lets the test switch sessions while the
// window's request is still out. Before 0.5.2 that switch was swallowed by
// `inFlight`, so `queue` (per requester) stayed on the old session's number
// until the next 2 s tick.
const SLOW = 250;
const slowSwitch = harness({
  snapshot: { at: 1, reachable: true, sessions: [], locks: [], handoffs: [], queue: [] },
  reactiveSession: true,
  delayMs: SLOW
});
slowSwitch.target.sessions.list = () => [SESSION, OTHER];
plugin.setup(slowSwitch.context);
await new Promise(done => setTimeout(done, 80));
const inFlight = slowSwitch.calls.length;
slowSwitch.setCurrentSession(OTHER);
await new Promise(done => setTimeout(done, SLOW + 250));
expect(
  'R7 switching while a request is in flight reloads at once, naming the new session',
  inFlight === 1 &&
    slowSwitch.calls.length === 2 &&
    slowSwitch.calls[1].session === 'ses_other',
  `${inFlight} → ${slowSwitch.calls.length}: ${JSON.stringify(slowSwitch.calls)}`
);

// No switch, no extra request: the re-run is conditional on the session having
// changed, so a steady window still makes exactly one call per tick.
const steady = harness({
  snapshot: { at: 1, reachable: true, sessions: [], locks: [], handoffs: [], queue: [] },
  delayMs: SLOW
});
steady.target.sessions.list = () => [SESSION];
plugin.setup(steady.context);
await new Promise(done => setTimeout(done, SLOW + 350));
expect(
  'R7 an unchanged routed session queues no extra request (still one per tick)',
  steady.calls.length === 1,
  `${steady.calls.length} calls`
);

// A hidden window stops polling (the key drops out), queues nothing while it is
// hidden, and resumes at once — with the session routed at that moment — when it
// is shown again. `document.hidden` is not reactive, so this only works because
// `gui.tsx` tracks `visibilitychange`.
const hiddenH = harness({
  snapshot: { at: 1, reachable: true, sessions: [], locks: [], handoffs: [], queue: [] },
  reactiveSession: true,
  delayMs: SLOW
});
hiddenH.target.sessions.list = () => [SESSION, OTHER];
plugin.setup(hiddenH.context);
await new Promise(done => setTimeout(done, SLOW + 150));
setHidden(true);
const afterHide = hiddenH.calls.length;
await new Promise(done => setTimeout(done, POLL_MS + 350));
const whileHidden = hiddenH.calls.length;
hiddenH.setCurrentSession(OTHER);
await new Promise(done => setTimeout(done, 250));
const afterSwitchWhileHidden = hiddenH.calls.length;
setHidden(false);
await new Promise(done => setTimeout(done, 200));
const resumed = hiddenH.calls.at(-1);
expect(
  'R7 hiding the window stops the poll (no tick while hidden)',
  afterHide >= 1 && whileHidden === afterHide,
  `${afterHide} → ${whileHidden} calls over >1 tick`
);
expect(
  'R7 a session switch while hidden queues nothing',
  afterSwitchWhileHidden === whileHidden,
  `${whileHidden} → ${afterSwitchWhileHidden} calls`
);
expect(
  'R7 showing the window again resumes at once with the routed session',
  hiddenH.calls.length > afterSwitchWhileHidden && resumed?.session === 'ses_other',
  `${hiddenH.calls.length} calls, last=${JSON.stringify(resumed ?? null)}`
);

// A window that mounts while hidden must not be stuck forever.
setHidden(true);
const lateMount = harness({
  snapshot: { at: 1, reachable: true, sessions: [], locks: [], handoffs: [], queue: [] },
  delayMs: SLOW
});
lateMount.target.sessions.list = () => [SESSION];
plugin.setup(lateMount.context);
await new Promise(done => setTimeout(done, 200));
const mountedHidden = lateMount.calls.length;
setHidden(false);
await new Promise(done => setTimeout(done, 200));
expect(
  'R7 a window that mounts hidden starts no poll',
  mountedHidden === 0,
  `${mountedHidden} calls`
);
expect(
  'R7 … and starts polling once it becomes visible',
  lateMount.calls.length >= 1 && lateMount.calls.at(-1)?.session === 'ses_probe',
  `${lateMount.calls.length} calls`
);

// Disposing the plugin must stop the timer **and** unregister the visibility
// listener; without the listener assertion the `onCleanup` in `gui.tsx` has no
// regression cover at all.
const disposable = harness({
  snapshot: { at: 1, reachable: true, sessions: [], locks: [], handoffs: [], queue: [] },
  delayMs: SLOW
});
disposable.target.sessions.list = () => [SESSION];
// The host disposes a plugin by disposing the root owner it ran `setup` under;
// that is what runs the `onCleanup` calls (`store.dispose`, listener removal,
// timer stop). Calling `setup` bare returns no cleanup.
let disposeRoot;
createRoot(dispose => {
  disposeRoot = dispose;
  plugin.setup(disposable.context);
});
await new Promise(done => setTimeout(done, SLOW + 150));
const beforeDispose = disposable.calls.length;
const listenersBefore = (docStub.listeners.get('visibilitychange') ?? new Set()).size;
disposeRoot();
await new Promise(done => setTimeout(done, POLL_MS + 350));
setHidden(true);
setHidden(false);
await new Promise(done => setTimeout(done, 200));
expect(
  'R7 disposing the plugin stops the poll (no tick, no wake-up on visibility)',
  beforeDispose >= 1 && disposable.calls.length === beforeDispose,
  `${beforeDispose} → ${disposable.calls.length} calls`
);
expect(
  'R7 … and unregisters its visibilitychange listener',
  (docStub.listeners.get('visibilitychange') ?? new Set()).size === listenersBefore - 1,
  `${listenersBefore} → ${(docStub.listeners.get('visibilitychange') ?? new Set()).size}`
);

/* ------------- 10. 0.5.3: the routed session's server decides where data comes from */

const sleep = ms => new Promise(done => setTimeout(done, ms));
/** A snapshot with `locks` leases, i.e. the pill reads `collab N`. */
const snap = locks => ({
  at: 1,
  reachable: true,
  sessions: [],
  locks: Array.from({ length: locks }, () => ({})),
  handoffs: [],
  queue: []
});

// R1: a session routed from another server is read through *that* server's
// client — `ctx.client` is this computer's sidecar and would answer with an
// empty list (the remote plugin's leases live on the remote server).
{
  const remote = fakeClient({ snapshot: snap(4) });
  const REMOTE = serverSession('ses_remote', 'srv-remote', remote);
  const remoteH = harness({ session: REMOTE });
  remoteH.target.sessions.list = () => [REMOTE];
  plugin.setup(remoteH.context);
  await sleep(150);
  const remotePill = rerun(find(remoteH.registered, 'titlebar-item'));
  expect(
    'R1 a remote session is read through its own server\'s client, naming the remote session id',
    remote.calls.length === 1 && remote.calls[0].session === 'ses_remote' && remoteH.calls.length === 0,
    JSON.stringify({ remote: remote.calls, local: remoteH.calls })
  );
  expect(
    'R1 … and the numbers on screen are that server\'s (pill counts the remote rows)',
    remotePill.label === 'collab 4',
    remotePill.label
  );
}

// R1 fallback: no `server` on the routed session keeps the old client.
{
  const localH = harness({ session: SESSION, snapshot: snap(2) });
  localH.target.sessions.list = () => [SESSION];
  plugin.setup(localH.context);
  await sleep(150);
  expect(
    'R1 a session with no server field falls back to ctx.client',
    localH.calls.length === 1 && localH.calls[0].session === 'ses_probe',
    JSON.stringify(localH.calls)
  );
}

// R2: switching to a session of another server re-requests through that server
// at once — and the pill counts the new server's rows, not the old ones. B is
// slow on purpose, so the test can look *between* the switch and B's answer: the
// previous server's numbers must be gone (cleared on adopt), not left on screen.
{
  const clientA = fakeClient({ snapshot: snap(2) });
  const clientB = fakeClient({ snapshot: snap(5), delayMs: 300 });
  const A = serverSession('ses_a', 'srv-a', clientA);
  const B = serverSession('ses_b', 'srv-b', clientB);
  const hop = harness({ session: A, reactiveSession: true });
  hop.target.sessions.list = () => [A, B];
  plugin.setup(hop.context);
  await sleep(150);
  const before = rerun(find(hop.registered, 'titlebar-item')).label;
  hop.setCurrentSession(B);
  await sleep(80); // B is still out; A's rows must already be dropped
  const between = rerun(find(hop.registered, 'titlebar-item')).label;
  await sleep(400); // B's answer is in
  const after = rerun(find(hop.registered, 'titlebar-item')).label;
  expect(
    'R2 switching to another server reloads at once through the new server\'s client',
    clientA.calls.length === 1 &&
      clientA.calls[0].session === 'ses_a' &&
      clientB.calls.length === 1 &&
      clientB.calls[0].session === 'ses_b' &&
      hop.calls.length === 0,
    JSON.stringify({ a: clientA.calls, b: clientB.calls, local: hop.calls })
  );
  expect(
    'R2 … and the previous server\'s rows are dropped at once (no stale numbers while B loads)',
    before === 'collab 2' && between === 'collab',
    `${before} → ${between} → ${after}`
  );
  expect(
    'R2 … and the pill then counts the new server\'s rows (no cross-server carry-over)',
    after === 'collab 5',
    `${before} → ${between} → ${after}`
  );
}

// R2 late reply: A answers slowly, the window switches to B while A's request is
// out. A's reply must be **dropped** — not written into B's state — and B's rows
// must be what the pill shows once they land.
{
  const slowA = fakeClient({ snapshot: snap(9), delayMs: 300 });
  const slowB = fakeClient({ snapshot: snap(1), delayMs: 400 });
  const A = serverSession('ses_a2', 'srv-a', slowA);
  const B = serverSession('ses_b2', 'srv-b', slowB);
  const late = harness({ session: A, reactiveSession: true });
  late.target.sessions.list = () => [A, B];
  plugin.setup(late.context);
  await sleep(100); // A's request is in flight
  late.setCurrentSession(B); // adopt(): the A rows are dropped at once
  await sleep(380); // t≈480: A's reply landed (t≈300) and was discarded; B still out (t≈700)
  const mid = rerun(find(late.registered, 'titlebar-item')).label;
  await sleep(600); // t≈1080: B's reply is in
  const end = rerun(find(late.registered, 'titlebar-item')).label;
  expect(
    'R2 a slow reply from the previous server never reaches the new server\'s state',
    mid === 'collab' && end === 'collab 1',
    `${mid} → ${end}`
  );
  expect(
    'R2 … and it does not trigger a second request to either server',
    slowA.calls.length === 1 && slowB.calls.length === 1,
    `${slowA.calls.length} / ${slowB.calls.length} calls`
  );
}

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAIL: ${check.title}`);
  process.exit(1);
}
process.exit(0);
