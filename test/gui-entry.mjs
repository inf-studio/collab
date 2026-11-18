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
 *   3. its `run` opens this plugin's panel tab for the current session — and
 *      does nothing at all (no throw) with no session;
 *   4. a `Slot` at `session.header` with a render function is registered;
 *   5. both locales carry the `command.*` / `header.*` keys, and
 *      `header.counts` really interpolates the three numbers;
 *   6. the entry points introduce no write path: no tool/permission/prompt call
 *      is reachable from the setup (the fake context has none, so a write
 *      attempt would throw).
 */
import Module from 'node:module';
import { createRequire } from 'node:module';
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
globalThis.document ??= {
  addEventListener() {},
  removeEventListener() {},
  createElement() {
    throw new Error('gui-entry.mjs: no DOM is created by this test');
  }
};

import { createSignal } from 'solid-js';

const root = resolve(import.meta.dirname, '..');
const guiModule = resolve(root, 'node_modules/@opencode/plugin/dist/gui/index.js');
const bundle = resolve(root, 'dist/gui-experimental.cjs');

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@opencode/plugin/gui') return guiModule;
  return originalResolve.call(this, request, ...rest);
};
const requireCjs = createRequire(import.meta.url);
const plugin = requireCjs(bundle).default;

const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};

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
 * like the window does, and records the registry's own id.
 *
 * The context is a **strict** proxy: reading an API this test did not provide
 * throws. That is what makes "the entry points are read-only" checkable — a
 * setup that reached for `ctx.session`, `ctx.tools` or a permission API would
 * fail here instead of silently getting `undefined`.
 */
function harness({ locale = 'zh', session = SESSION, snapshot, reactiveSession = false } = {}) {
  const registered = [];
  const opened = [];
  const calls = [];
  const [currentSession, setCurrentSession] = createSignal(session);
  const target = {
    id: 'collab',
    options: {},
    t: translator(locale),
    plural: (key, count) => translator(locale)(`${key}.other`, { count }),
    add: (registry, item) => {
      registered.push({ registry: registry?.id, item: typeof item === 'function' ? item() : item });
      return () => {};
    },
    layout: {
      open: (key, at) => opened.push({ key, session: at }),
      state: () => undefined
    },
    // Empty list: no session is mounted, so the poller never starts (this test
    // is about registration, not about the 2 s timer — tui-render.mjs covers it).
    sessions: { list: () => [], current: () => (reactiveSession ? currentSession() : session) },
    client: {
      rpc: () => ({
        snapshot: async input => {
          calls.push(input);
          return snapshot;
        }
      })
    }
  };
  const context = new Proxy(target, {
    get(object, key) {
      if (typeof key === 'symbol' || key === 'then' || key === 'toJSON') return undefined;
      if (!(key in object)) throw new Error(`setup read ctx.${String(key)}, which this test does not provide`);
      return object[key];
    }
  });
  return { context, target, registered, opened, calls, setCurrentSession };
}

const find = (registered, id) => registered.find(entry => entry.registry === id);

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
  'R1 without a routed session the command is disabled and run() is a no-op',
  idleCommand.enabled === false && idle.opened.length === 0 && !threw,
  JSON.stringify({ enabled: idleCommand.enabled, opened: idle.opened.length })
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
  'header.unreachable'
];
for (const locale of ['en', 'zh']) {
  const missing = keys.filter(key => typeof plugin.i18n?.[locale]?.[key] !== 'string');
  expect(`R1/R2 ${locale} defines every entry-point key`, missing.length === 0, missing.join(', ') || keys.join(', '));
}
expect(
  'R2 header.counts carries three placeholders and interpolates them',
  zh.context.t('header.counts', { locks: 2, handoffs: 1, queue: 0 }) === '锁 2 · 交接 1 · 队列 0',
  zh.context.t('header.counts', { locks: 2, handoffs: 1, queue: 0 })
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

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAIL: ${check.title}`);
  process.exit(1);
}
process.exit(0);
