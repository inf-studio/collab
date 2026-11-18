/**
 * Independent check probe (cold context, review only).
 *
 * Not part of `pnpm test`: run by hand against a freshly built bundle:
 *   node --conditions=browser .trellis/tasks/11-19-collab-remote-gui/research/probe-check.mjs
 *
 * It re-implements the host double from scratch (not importing test/gui-entry.mjs)
 * so that the assertions below are evidence about `dist/gui-experimental.cjs`,
 * not a re-run of the implementer's harness.
 *
 * Focus (the gaps and the claims the task lists):
 *   P1 R1  remote session -> server.client; `session` is the remote id; ctx.client 0 calls
 *   P2 R1  session without `server` -> ctx.client
 *   P3 R2  late SUCCESS reply from A after switching to B is dropped
 *   P4 R2  late FAILURE reply from A after switching to B is dropped (catch branch)
 *   P5 R2  switch clears the rows at once, also while a request is in flight
 *   P6 R2  same server, other session -> reloads at once with the new session id
 *   P7 R2  cross-server switches keep exactly one live interval (no leak/double timer)
 *   P8 R3  toast names the remote server / 'this computer'; no-session click opens nothing
 *   P9 R4  the store only ever calls `snapshot` (no other rpc method reachable)
 */
import Module from 'node:module';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

globalThis.window ??= globalThis;
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
    throw new Error('probe: no DOM');
  }
};
globalThis.document ??= docStub;

import { createRoot, createSignal } from 'solid-js';

const root = process.env.PROBE_ROOT ? resolve(process.env.PROBE_ROOT) : resolve(import.meta.dirname, '../../../../');
const guiModule = resolve(root, 'node_modules/@opencode/plugin/dist/gui/index.js');
const bundle = resolve(root, 'dist/gui-experimental.cjs');
const solidEsm = realpathSync(resolve(root, 'node_modules/solid-js/dist/solid.js'));
const solidWebEsm = realpathSync(resolve(root, 'node_modules/solid-js/web/dist/web.js'));
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@opencode/plugin/gui') return guiModule;
  if (request === 'solid-js') return solidEsm;
  if (request === 'solid-js/web') return solidWebEsm;
  return originalResolve.call(this, request, ...rest);
};
const plugin = createRequire(import.meta.url)(bundle).default;

const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};
const sleep = ms => new Promise(done => setTimeout(done, ms));

/** Every rpc method entered is recorded, so "only snapshot" is checkable. */
function fakeClient(label) {
  const calls = [];
  const methods = new Set();
  return {
    label,
    calls,
    methods,
    rpc(contract) {
      const name = contract?.id ?? 'unknown';
      return new Proxy(
        {},
        {
          get(_t, method) {
            methods.add(`${name}.${String(method)}`);
            return async input => {
              calls.push({ contract: name, method, input });
              const behaviour = fakeClient.behaviour.get(label) ?? {};
              const delay = behaviour.calls?.[calls.length - 1]?.delay ?? behaviour.delay ?? 0;
              if (delay > 0) await sleep(delay);
              const fail = behaviour.calls?.[calls.length - 1]?.fail ?? behaviour.fail;
              if (fail) throw new Error(behaviour.message ?? `${label} down`);
              const reply = behaviour.calls?.[calls.length - 1]?.reply ?? behaviour.reply;
              return typeof reply === 'function' ? reply(input) : reply;
            };
          }
        }
      );
    }
  };
}
fakeClient.behaviour = new Map();
const behaviour = (client, spec) => fakeClient.behaviour.set(client.label, spec);

function serverSession(id, serverID, client, { local = false, withServer = true } = {}) {
  const base = { id, key: `${serverID}\n${id}`, directory: '/data/project/collab' };
  if (!withServer) return base;
  return {
    ...base,
    server: {
      id: serverID,
      name: serverID,
      url: `http://${serverID}`,
      client,
      local,
      builtin: local,
      compatible: true,
      connected: true
    }
  };
}

function harness({ session = null, reactive = false } = {}) {
  const registered = [];
  const opened = [];
  const toasts = [];
  const [current, setCurrent] = createSignal(session);
  const localClient = fakeClient('ctx.client');
  const target = {
    id: 'collab',
    options: {},
    t: (key, params = {}) => {
      const catalog = (plugin.i18n ?? {})[locale] ?? {};
      const template = catalog[key] ?? key;
      return String(template).replace(/\{\{(\w+)\}\}/g, (_, name) => String(params[name] ?? `{{${name}}}`));
    },
    plural: (key, count) => (plugin.i18n[locale][`${key}.other`] ?? key).replace('{{count}}', String(count)),
    add: (registry, item) => {
      const factory = typeof item === 'function' ? item : undefined;
      registered.push({ registry: registry?.id, item: factory ? factory() : item, factory });
      return () => {};
    },
    layout: { open: (key, at) => opened.push({ key, session: at }), state: () => undefined },
    app: { name: 'opencode', version: '2.5.0', channel: 'prod', platform: 'desktop', packaged: true },
    toast: { show: options => (toasts.push(options), { dismiss() {} }) },
    sessions: { list: () => [], current: () => (reactive ? current() : session) },
    client: localClient
  };
  const context = new Proxy(target, {
    get(object, key) {
      if (typeof key === 'symbol' || key === 'then' || key === 'toJSON') return undefined;
      if (!(key in object)) throw new Error(`probe: setup read ctx.${String(key)}`);
      return object[key];
    }
  });
  return { context, target, registered, opened, toasts, localClient, setCurrent };
}

const locale = 'en';
const find = (h, id) => h.registered.find(entry => entry.registry === id);
const render = entry => (entry.factory ? entry.factory() : entry.item);
const snap = locks => ({ at: 1, reachable: true, sessions: [], locks: Array.from({ length: locks }, () => ({})), handoffs: [], queue: [] });

// ---------------------------------------------------------------- P1
{
  const remote = fakeClient('srv-remote');
  behaviour(remote, { reply: snap(4) });
  const REMOTE = serverSession('ses_remote', 'srv-remote', remote);
  const h = harness({ session: REMOTE });
  h.target.sessions.list = () => [REMOTE];
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(150);
  const pill = render(find(h, 'titlebar-item'));
  expect(
    'P1 a remote session reads server.client, with that session id; ctx.client untouched',
    remote.calls.length === 1 &&
      remote.calls[0].contract === 'collab.state' &&
      remote.calls[0].method === 'snapshot' &&
      remote.calls[0].input?.session === 'ses_remote' &&
      h.localClient.calls.length === 0,
    JSON.stringify({ remote: remote.calls.map(c => c.input), local: h.localClient.calls.map(c => c.input) })
  );
  expect('P1 … and the pill shows that server\'s rows', pill.label === 'collab 4', pill.label);
  dispose();
}

// ---------------------------------------------------------------- P2
{
  const h = harness({ session: { id: 'ses_local', key: 'local\nses_local', directory: '/x' } });
  behaviour(h.localClient, { reply: snap(2) });
  h.target.sessions.list = () => [{ id: 'ses_local', key: 'local\nses_local', directory: '/x' }];
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(150);
  expect(
    'P2 a session with no `server` falls back to ctx.client (same id in the call)',
    h.localClient.calls.length === 1 && h.localClient.calls[0].input?.session === 'ses_local',
    JSON.stringify(h.localClient.calls.map(c => c.input))
  );
  dispose();
}

// ---------------------------------------------------------------- P3 (late success)
{
  const slowA = fakeClient('srv-a');
  const slowB = fakeClient('srv-b');
  behaviour(slowA, { reply: snap(9), delay: 300 });
  behaviour(slowB, { reply: snap(1), delay: 400 });
  const A = serverSession('ses_a2', 'srv-a', slowA);
  const B = serverSession('ses_b2', 'srv-b', slowB);
  const h = harness({ session: A, reactive: true });
  h.target.sessions.list = () => [A, B];
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(100);
  h.setCurrent(A);
  h.setCurrent(B);
  await sleep(420); // A landed at ~300 (dropped); B still out (~700)
  const mid = render(find(h, 'titlebar-item')).label;
  await sleep(500);
  const end = render(find(h, 'titlebar-item')).label;
  expect(
    'P3 a late success from A never reaches B\'s state (mid = no data, end = B)',
    mid === 'collab' && end === 'collab 1' && slowA.calls.length === 1 && slowB.calls.length === 1,
    `${mid} → ${end}; a=${slowA.calls.length} b=${slowB.calls.length}`
  );
  dispose();
}

// ---------------------------------------------------------------- P4 (late FAILURE, catch branch)
{
  const badA = fakeClient('srv-a-bad');
  const slowB = fakeClient('srv-b-ok');
  behaviour(badA, { delay: 300, fail: true, message: 'srv-a unreachable' });
  behaviour(slowB, { reply: snap(3), delay: 250 });
  const A = serverSession('ses_a3', 'srv-a-bad', badA);
  const B = serverSession('ses_b3', 'srv-b-ok', slowB);
  const h = harness({ session: A, reactive: true });
  h.target.sessions.list = () => [A, B];
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(100);
  h.setCurrent(B);
  await sleep(420); // A rejected at ~300; B out until ~550
  const mid = render(find(h, 'titlebar-item')).label;
  await sleep(400);
  const end = render(find(h, 'titlebar-item')).label;
  expect(
    'P4 a late *failure* from A does not put A\'s error on B (mid = no data, end = B)',
    mid === 'collab' && end === 'collab 3',
    `${mid} → ${end}`
  );
  dispose();
}

// ---------------------------------------------------------------- P5 (clear at once, request in flight)
{
  const slowA = fakeClient('srv-a5');
  const slowB = fakeClient('srv-b5');
  behaviour(slowA, { reply: snap(2), delay: 400 });
  behaviour(slowB, { reply: snap(5), delay: 400 });
  const A = serverSession('ses_a5', 'srv-a5', slowA);
  const B = serverSession('ses_b5', 'srv-b5', slowB);
  const h = harness({ session: A, reactive: true });
  h.target.sessions.list = () => [A, B];
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(80); // A in flight
  const before = render(find(h, 'titlebar-item')).label;
  h.setCurrent(B);
  await sleep(60); // adopt() ran even though inFlight was true
  const between = render(find(h, 'titlebar-item')).label;
  expect(
    'P5 switching servers clears the rows at once even with a request in flight',
    before === 'collab' && between === 'collab',
    `${before} → ${between}`
  );
  // Single-flight: while A's request is out, B is *not* requested. Recorded as a
  // known deferral (risk R-1): B waits for A to settle, however long that is.
  const bBeforeASettles = slowB.calls.length;
  await sleep(1000);
  const end = render(find(h, 'titlebar-item')).label;
  expect(
    'P5 … and B is only requested once A settles (single-flight deferral, not "immediately")',
    bBeforeASettles === 0 && slowB.calls.length === 1 && end === 'collab 5',
    `b before/after = ${bBeforeASettles}/${slowB.calls.length}; end = ${end}`
  );
  dispose();
}

// ---------------------------------------------------------------- P10 (stale rows + request in flight)
{
  const slowA = fakeClient('srv-a10');
  const slowB = fakeClient('srv-b10');
  // 600 ms: the first answer lands, the next tick's request is still out at t=2150.
  behaviour(slowA, { reply: snap(2), delay: 600 });
  behaviour(slowB, { reply: snap(5), delay: 400 });
  const A = serverSession('ses_a10', 'srv-a10', slowA);
  const B = serverSession('ses_b10', 'srv-b10', slowB);
  const h = harness({ session: A, reactive: true });
  h.target.sessions.list = () => [A, B];
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(2150); // data from t=600 is on screen; the t=2000 request is in flight
  const before = render(find(h, 'titlebar-item')).label;
  const inFlight = slowA.calls.length;
  h.setCurrent(B);
  await sleep(80);
  const between = render(find(h, 'titlebar-item')).label;
  expect(
    'P10 a server switch clears rows that are on screen while a request is in flight',
    before === 'collab 2' && inFlight === 2 && between === 'collab',
    `before=${before} a-calls=${inFlight} between=${between}`
  );
  await sleep(1200);
  dispose();
}

// ---------------------------------------------------------------- P6 (same server, other session)
{
  const client = fakeClient('srv-same');
  const A = serverSession('ses_one', 'srv-same', client);
  const B = serverSession('ses_two', 'srv-same', client);
  behaviour(client, { reply: input => snap(input?.session === 'ses_two' ? 7 : 1) });
  const h = harness({ session: A, reactive: true });
  h.target.sessions.list = () => [A, B];
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(120);
  const before = render(find(h, 'titlebar-item')).label;
  h.setCurrent(B);
  await sleep(120);
  expect(
    'P6 same server + other session reloads at once with the new session id',
    before === 'collab 1' && client.calls.at(-1)?.input?.session === 'ses_two' && render(find(h, 'titlebar-item')).label === 'collab 7',
    JSON.stringify(client.calls.map(c => c.input))
  );
  dispose();
}

// ---------------------------------------------------------------- P7 (one timer)
{
  const realSet = global.setInterval;
  const realClear = global.clearInterval;
  let live = 0;
  let created = 0;
  global.setInterval = (...args) => {
    live += 1;
    created += 1;
    return realSet(...args);
  };
  global.clearInterval = handle => {
    if (handle !== undefined) live -= 1;
    return realClear(handle);
  };
  const slowA = fakeClient('srv-a7');
  const slowB = fakeClient('srv-b7');
  const slowC = fakeClient('srv-c7');
  behaviour(slowA, { reply: snap(1) });
  behaviour(slowB, { reply: snap(1) });
  behaviour(slowC, { reply: snap(1) });
  const A = serverSession('ses_a7', 'srv-a7', slowA);
  const B = serverSession('ses_b7', 'srv-b7', slowB);
  const C = serverSession('ses_c7', 'srv-c7', slowC);
  const h = harness({ session: A, reactive: true });
  h.target.sessions.list = () => [A, B, C];
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(100);
  const afterStart = { live, created };
  h.setCurrent(B);
  await sleep(80);
  h.setCurrent(C);
  await sleep(80);
  h.setCurrent(A);
  await sleep(80);
  const afterHops = { live, created };
  expect(
    'P7 cross-server hops keep exactly one interval alive (old ones cleared)',
    afterStart.live === 1 && afterHops.live === 1 && afterHops.created === 4,
    JSON.stringify({ afterStart, afterHops })
  );
  expect(
    'P7 each hop reads the newest server and never the local client',
    slowA.calls.length >= 2 && slowB.calls.length >= 1 && slowC.calls.length >= 1 && h.localClient.calls.length === 0,
    `a=${slowA.calls.length} b=${slowB.calls.length} c=${slowC.calls.length} local=${h.localClient.calls.length}`
  );
  dispose();
  await sleep(30);
  const afterDispose = live;
  global.setInterval = realSet;
  global.clearInterval = realClear;
  expect('P7 disposing the plugin clears the timer', afterDispose === 0, String(afterDispose));
}

// ---------------------------------------------------------------- P8 (toast)
{
  const remote = fakeClient('srv-remote8');
  behaviour(remote, { reply: snap(1) });
  const REMOTE = serverSession('ses_remote8', 'srv-remote8', remote);
  const withSession = harness({ session: REMOTE });
  withSession.target.sessions.list = () => [REMOTE];
  const dispose1 = createRoot(disposeRoot => (plugin.setup(withSession.context), disposeRoot));
  await sleep(100);
  dispose1();
  const idle = harness({ session: null });
  const dispose2 = createRoot(disposeRoot => (plugin.setup(idle.context), disposeRoot));
  const idlePill = find(idle, 'titlebar-item').item;
  idlePill.run();
  const localToast = idle.toasts[0];
  // A toast only fires with no *routed* session (both entry points check first),
  // so the remote-id branch is reachable only through the route changing between
  // the check and the toast itself. Simulate exactly that race to read the string.
  const remoteToastH = harness({ session: null });
  const dispose3 = createRoot(disposeRoot => (plugin.setup(remoteToastH.context), disposeRoot));
  let reads = 0;
  remoteToastH.target.sessions.current = () => (reads++ === 0 ? undefined : REMOTE);
  const remotePill = find(remoteToastH, 'titlebar-item').item;
  remotePill.run();
  const remoteToast = remoteToastH.toasts[0];
  expect(
    'P8 no-session toast says server=this computer and opens nothing',
    /server=this computer/.test(localToast?.description ?? '') && idle.opened.length === 0,
    localToast?.description
  );
  expect(
    'P8 when the route appears mid-click the toast names that server=<id> and opens nothing',
    /server=srv-remote8/.test(remoteToast?.description ?? '') && remoteToastH.opened.length === 0,
    remoteToast?.description
  );
  dispose2();
  dispose3();
}

// ---------------------------------------------------------------- P9 (read-only)
{
  const remote = fakeClient('srv-readonly');
  const REMOTE = serverSession('ses_ro', 'srv-readonly', remote);
  behaviour(remote, { reply: snap(1) });
  const h = harness({ session: REMOTE });
  h.target.sessions.list = () => [REMOTE];
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(120);
  // Drive every entry point once: command.run, pill.run, panel/menu factories.
  for (const entry of h.registered) if (entry.factory) render(entry);
  const command = find(h, 'command').item;
  command.run();
  find(h, 'titlebar-item').item.run();
  dispose();
  const touched = [...remote.methods, ...h.localClient.methods];
  expect(
    'P9 every rpc method entered is collab.state.snapshot (no write method, no new contract)',
    touched.length > 0 && touched.every(name => name === 'collab.state.snapshot'),
    JSON.stringify(touched)
  );
  expect(
    'P9 and the only layout/toast effect is opening the panel (no toast with a session)',
    h.opened.length === 2 && h.toasts.length === 0,
    JSON.stringify({ opened: h.opened.length, toasts: h.toasts.length })
  );
}

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} probe checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAILED: ${check.title}`);
  process.exitCode = 1;
}
