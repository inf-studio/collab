/**
 * 0.5.3: the panel's rendered output, which `test/gui-entry.mjs` cannot assert
 * (it never renders). Covers the source badge and — most importantly — that a
 * late failure from the previous server does not paint its banner on the new one.
 *
 *   node --conditions=browser test/gui-panel.mjs   # `pnpm test` runs it
 *
 * It renders `PanelView` — reached through the registered `Panel.render` — against
 * a minimal DOM (only the APIs solid-js/web touches for these flat templates), so
 * the assertion is about the shipped bundle, not about a copy of its logic.
 *
 *   1. remote server  -> the panel names `@<server.id>`
 *   2. local server   -> no `@` badge (noise)
 *   3. no server      -> no `@` badge
 *   4. the badge survives while the rows are loading (source recorded by adopt)
 */
import Module from 'node:module';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/* ------------------------------------------------------------------ mini DOM */
class TextNode {
  constructor(data) {
    this.nodeType = 3;
    this.data = String(data);
    this.parentNode = null;
  }
  get textContent() {
    return this.data;
  }
  set textContent(value) {
    this.data = String(value);
  }
  get firstChild() {
    return null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const list = this.parentNode.childNodes;
    return list[list.indexOf(this) + 1] ?? null;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  cloneNode() {
    return new TextNode(this.data);
  }
}
class Elem {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = tag;
    this.nodeName = tag.toUpperCase();
    this.childNodes = [];
    this.attrs = {};
    this.parentNode = null;
    this.className = '';
    this.style = { cssText: '', setProperty() {}, removeProperty() {} };
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const list = this.parentNode.childNodes;
    return list[list.indexOf(this) + 1] ?? null;
  }
  appendChild(node) {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  insertBefore(node, ref) {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    const index = ref == null ? -1 : this.childNodes.indexOf(ref);
    if (index < 0) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  replaceChild(node, old) {
    const index = this.childNodes.indexOf(old);
    if (index >= 0) {
      this.childNodes[index] = node;
      node.parentNode = this;
      old.parentNode = null;
    }
    return old;
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name === 'class') this.className = String(value);
  }
  removeAttribute(name) {
    delete this.attrs[name];
    if (name === 'class') this.className = '';
  }
  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }
  addEventListener() {}
  removeEventListener() {}
  remove() {
    this.parentNode?.removeChild(this);
  }
  get textContent() {
    return this.childNodes.map(child => child.textContent).join('');
  }
  set textContent(value) {
    this.childNodes = [];
    if (String(value) !== '') this.appendChild(new TextNode(value));
  }
  cloneNode(deep) {
    const copy = new Elem(this.tagName);
    copy.attrs = { ...this.attrs };
    copy.className = this.className;
    if (deep) for (const child of this.childNodes) copy.appendChild(child.cloneNode(true));
    return copy;
  }
}

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);
function parseHTML(html) {
  const root = [];
  const stack = [];
  const push = node => (stack.length ? stack[stack.length - 1] : { appendChild: n => root.push(n) }).appendChild(node);
  const tag = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let last = 0;
  let match;
  while ((match = tag.exec(html))) {
    if (match.index > last) push(new TextNode(html.slice(last, match.index)));
    if (match[1] === '/') {
      stack.pop();
    } else {
      const element = new Elem(match[2]);
      for (const attr of match[3].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        element.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
      }
      push(element);
      if (!match[4] && !VOID.has(match[2].toLowerCase())) stack.push(element);
    }
    last = tag.lastIndex;
  }
  if (last < html.length) push(new TextNode(html.slice(last)));
  return root;
}

const documentStub = {
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
  createElement(name) {
    if (name !== 'template') return new Elem(name);
    return {
      content: { firstChild: null },
      set innerHTML(html) {
        this.content.firstChild = parseHTML(html)[0] ?? null;
      }
    };
  },
  createTextNode(text) {
    return new TextNode(text);
  }
};
globalThis.window ??= globalThis;
globalThis.document ??= documentStub;

import { createRoot, createComponent, createSignal } from 'solid-js';

const root = resolve(import.meta.dirname, '..');
const guiModule = resolve(root, 'node_modules/@opencode/plugin/dist/gui/index.js');
const internalModule = resolve(root, 'node_modules/@opencode/plugin/dist/gui/internal.js');
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
const { PluginContext } = await import(internalModule);

const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};
const sleep = ms => new Promise(done => setTimeout(done, ms));
const snap = locks => ({
  at: 1,
  reachable: true,
  sessions: [],
  locks: Array.from({ length: locks }, (_, index) => ({
    resource: `res-${index}`,
    kind: 'workspace',
    mode: 'exclusive',
    holders: [],
    waiters: 0,
    waiting: [],
    expiresInMs: 1000
  })),
  handoffs: [],
  queue: []
});

function fakeClient({ reply, delay = 0, fail = false, message = 'down' } = {}) {
  return {
    rpc: () => ({
      snapshot: async () => {
        if (delay > 0) await sleep(delay);
        if (fail) throw new Error(message);
        return typeof reply === 'function' ? reply() : reply;
      }
    })
  };
}

function serverSession(id, serverID, client, { local = false, withServer = true } = {}) {
  const base = { id, key: `${serverID}\n${id}`, directory: '/data/project/collab' };
  if (!withServer) return base;
  return {
    ...base,
    server: { id: serverID, name: serverID, url: `http://${serverID}`, client, local, builtin: local, compatible: true, connected: true }
  };
}

function harness(session, { locale = 'en' } = {}) {
  const registered = [];
  const [current, setCurrent] = createSignal(session);
  const target = {
    id: 'collab',
    options: {},
    t: (key, params = {}) =>
      String((plugin.i18n[locale] ?? {})[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, n) => String(params[n] ?? `{{${n}}}`)),
    plural: (key, count) => `${count} ${key}`,
    add: (registry, item) => {
      const factory = typeof item === 'function' ? item : undefined;
      registered.push({ registry: registry?.id, item: factory ? factory() : item, factory });
      return () => {};
    },
    layout: { open: () => {}, state: () => undefined },
    app: { name: 'opencode', version: '2.5.0', channel: 'prod', platform: 'desktop', packaged: true },
    toast: { show: () => ({ dismiss() {} }) },
    sessions: { list: () => [session].filter(Boolean), current: () => current() },
    client: fakeClient({ reply: snap(0) })
  };
  const context = new Proxy(target, {
    get(object, key) {
      if (typeof key === 'symbol' || key === 'then' || key === 'toJSON') return undefined;
      if (!(key in object)) throw new Error(`probe: setup read ctx.${String(key)}`);
      return object[key];
    }
  });
  return { context, registered, setCurrent };
}

/** Render the registered panel through a plugin-context provider on the mini DOM. */
function renderPanel(h, session) {
  const panel = h.registered.find(entry => entry.registry === 'panel').item;
  return createRoot(() => {
    const resolved = PluginContext.Provider({
      value: h.context,
      get children() {
        return () => panel.render({ session });
      }
    });
    return typeof resolved === 'function' ? resolved() : resolved;
  });
}

// 1. remote
{
  const remote = fakeClient({ reply: snap(4) });
  const REMOTE = serverSession('ses_remote', 'srv-remote', remote);
  const h = harness(REMOTE);
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(120);
  const el = renderPanel(h, REMOTE);
  const text = el?.textContent ?? '';
  expect(
    'PN1 a remote session’s panel names the source server (@srv-remote)',
    text.includes('@srv-remote'),
    JSON.stringify(text)
  );
  expect(
    'PN1 … and the badge carries the translated title',
    JSON.stringify(el?.childNodes?.[0]?.attrs ?? {}).includes('Rows come from this server'),
    JSON.stringify(el?.childNodes?.[0]?.attrs ?? {})
  );
  dispose();
}

// 2. local server (ServerRef.local === true) — the app's own sidecar
{
  const local = fakeClient({ reply: snap(1) });
  const LOCAL = serverSession('ses_local', 'sidecar', local, { local: true });
  const h = harness(LOCAL);
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(120);
  const el = renderPanel(h, LOCAL);
  const text = el?.textContent ?? '';
  expect('PN2 a local server hides the badge (no @sidecar noise)', !text.includes('@sidecar'), JSON.stringify(text));
  dispose();
}

// 3. session with no `server` field
{
  const PLAIN = serverSession('ses_plain', 'local', fakeClient({ reply: snap(1) }), { withServer: false });
  const h = harness(PLAIN);
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(120);
  const el = renderPanel(h, PLAIN);
  const text = el?.textContent ?? '';
  expect('PN3 a session without `server` shows no badge', !text.includes('@'), JSON.stringify(text));
  dispose();
}

// 4. a late FAILURE from the previous server must not paint its banner on the new one
{
  const badA = fakeClient({ delay: 300, fail: true, message: 'srv-a-bad exploded' });
  const goodB = fakeClient({ reply: snap(3), delay: 400 });
  const A = serverSession('ses_a4', 'srv-a-bad', badA);
  const B = serverSession('ses_b4', 'srv-b-good', goodB);
  const h = harness(A);
  h.context.sessions.list = () => [A, B];
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(100);
  h.setCurrent(B);
  await sleep(350); // A rejected at ~300; B is still out until ~500
  const text = renderPanel(h, B)?.textContent ?? '';
  expect(
    'PN4 a late failure from the previous server shows no error banner on the new one',
    !text.includes('srv-a-bad exploded') && !/unreachable/i.test(text),
    JSON.stringify(text)
  );
  await sleep(400);
  dispose();
}

/** Render one registered contribution's `render` through the plugin-context provider. */
function renderContribution(h, registry, input) {
  const item = h.registered.filter(entry => entry.registry === registry).at(-1).item;
  return createRoot(() => {
    const resolved = PluginContext.Provider({
      value: h.context,
      get children() {
        return () => item.render(input);
      }
    });
    return typeof resolved === 'function' ? resolved() : resolved;
  });
}

// 5. R4 (0.6.0): the session-header counts print the four numbers, from one
//    snapshot + the host's own prompt queue (sync asked once, failures silent).
{
  const FOUR = serverSession('ses_four', 'srv-four', fakeClient({ reply: snap(0) }));
  const syncs = [];
  FOUR.server.data = {
    session: {
      pending: {
        list: sessionID => (sessionID === 'ses_four' ? [{ id: 'msg_q1' }] : []),
        sync: async sessionID => {
          syncs.push(sessionID);
        },
        invalidate: () => {}
      }
    }
  };
  const fourSnapshot = {
    at: 1,
    reachable: true,
    sessions: [],
    locks: [
      {
        resource: 'res-held',
        kind: 'named',
        mode: 'exclusive',
        holders: ['ses_a'],
        waiters: 2,
        waiting: ['ses_b', 'ses_c'],
        expiresInMs: 60_000,
        waiterAgeMs: [1_000, 2_000]
      },
      {
        resource: 'res-free-with-waiter',
        kind: 'named',
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
      { queueId: 'q_1', target: 'ses_p', ageMs: 1, summary: 'a', seen: false },
      { queueId: 'q_2', target: 'ses_p', ageMs: 2, summary: 'b', seen: false }
    ]
  };
  // The store is fed by the poller; give it this snapshot through the same client.
  FOUR.server.client = fakeClient({ reply: fourSnapshot });
  // zh catalog: the assertion below is the exact string the PRD asks for.
  const h = harness(FOUR, { locale: 'zh' });
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(150);
  const first = renderContribution(h, 'slot', { session: FOUR });
  const firstText = first?.textContent ?? '';
  expect(
    'PN5 the session header prints 持有 1 · 排队 3 · 待受保护 2 · 宿主排队 1 (held ≠ rows)',
    firstText.includes('持有 1 · 排队 3 · 待受保护 2 · 宿主排队 1'),
    JSON.stringify(firstText)
  );
  const syncCount = syncs.length;
  const second = renderContribution(h, 'slot', { session: FOUR });
  expect(
    'PN5 the header asks the host to sync its prompt queue once per session, not per render',
    syncCount === 1 && (second?.textContent ?? '').includes('宿主排队 1'),
    JSON.stringify({ syncs, second: second?.textContent })
  );
  dispose();
}

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} panel checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAILED: ${check.title}`);
  process.exitCode = 1;
}
