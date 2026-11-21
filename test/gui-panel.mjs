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
/** Solid templates use `<!>` as the insertion marker; it must be a comment node. */
class CommentNode extends TextNode {
  constructor(data = '') {
    super(data);
    this.nodeType = 8;
  }
  get textContent() {
    return '';
  }
  cloneNode() {
    return new CommentNode(this.data);
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
    // 0.8.2 (`graph-zoom`): a **direct** (`addEventListener`) listener, which is
    // how Solid attaches the non-delegated `wheel`. Recorded so the test can
    // fire it for real; the default rect is the 640×360 canvas at the origin.
    this.listeners = new Map();
    this.rect = null;
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
  addEventListener(type, fn) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  getBoundingClientRect() {
    return this.rect ?? { left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 };
  }
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
  const tag =
    /<!--([\s\S]*?)-->|<!([^>]*)>|<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let last = 0;
  let match;
  while ((match = tag.exec(html))) {
    if (match.index > last) push(new TextNode(html.slice(last, match.index)));
    if (match[1] !== undefined || match[2] !== undefined) {
      // `<!>` / `<!-- … -->`: Solid's insertion marker.
      push(new CommentNode(match[1] ?? ''));
    } else if (match[3] === '/') {
      stack.pop();
    } else {
      const element = new Elem(match[4]);
      for (const attr of match[5].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        element.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
      }
      push(element);
      if (!match[6] && !VOID.has(match[4].toLowerCase())) stack.push(element);
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
  },
  createComment(text) {
    return new CommentNode(text);
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

function fakeClient({ reply, delay = 0, fail = false, message = 'down', actions = {} } = {}) {
  return {
    rpc: () => ({
      snapshot: async () => {
        if (delay > 0) await sleep(delay);
        if (fail) throw new Error(message);
        return typeof reply === 'function' ? reply() : reply;
      },
      ...actions
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

function harness(session, { locale = 'en', dialogs, client } = {}) {
  const registered = [];
  const toasts = [];
  const opened = [];
  const copied = [];
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
    tabs: {
      open: (session, options) => {
        opened.push({ ...session, focus: options?.focus === true });
      }
    },
    system: {
      copy: async text => {
        copied.push(text);
      }
    },
    app: { name: 'opencode', version: '2.5.0', channel: 'prod', platform: 'desktop', packaged: true },
    toast: {
      show: toast => {
        // Recorded, never rendered: a toast is the only visible outcome of a
        // board action (the button itself only arms / runs).
        toasts.push(toast);
        return { dismiss() {} };
      }
    },
    sessions: { list: () => [session].filter(Boolean), current: () => current() },
    client: client ?? fakeClient({ reply: snap(0) }),
    // 0.8.0 (`board2-actions`): only present when the test wants dialogs. The
    // proxy below throws for an absent key, which is exactly the "older window"
    // case the two-step fallback exists for.
    ...(dialogs ? { dialogs } : {})
  };
  const context = new Proxy(target, {
    get(object, key) {
      if (typeof key === 'symbol' || key === 'then' || key === 'toJSON') return undefined;
      if (!(key in object)) throw new Error(`probe: setup read ctx.${String(key)}`);
      return object[key];
    }
  });
  return { context, registered, setCurrent, toasts, opened, copied };
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

// 6. 0.6.0 board: default collapsed, click expands, archived hidden until asked.
{
  const BOARD = {
    at: 1,
    reachable: true,
    sessions: [
      {
        sid: 'ses_board',
        title: 'board worker',
        agent: 'build',
        busy: true,
        workspace: '/data/project/collab',
        frozen: { scope: 'session', target: 'ses_board', until: 1_800_000_600_000, reason: '等 schema 线' }
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
        resource: 'named:board-window',
        kind: 'named',
        mode: 'exclusive',
        holders: ['ses_board'],
        waiters: 0,
        waiting: [],
        expiresInMs: 600_000
      }
    ],
    handoffs: [
      {
        bid: 'b_board_spawn',
        state: 'claimed',
        ageMs: 1_000,
        from: 'ses_board',
        claimBy: 'ses_child',
        spawned: 'ses_child',
        kind: 'spawn',
        title: 'spawn the child',
        workspace: '/data/project/collab'
      },
      {
        bid: 'b_board_urgent',
        state: 'open',
        ageMs: 2_000,
        from: 'ses_board',
        title: 'urgent thing',
        priority: 'urgent',
        workspace: '/data/project/collab'
      }
    ],
    queue: [{ queueId: 'q_board', target: 'ses_p', ageMs: 1_000, summary: 'req', seen: false }]
  };
  let boardLoads = 0;
  const boardClient = {
    rpc: () => ({
      snapshot: async () => {
        boardLoads += 1;
        // 0.8.0: a fresh `at` per answer, so "a poll replaced the snapshot" is
        // a number the DOM can be read for (`data-collab-at`), not a guess.
        return { ...BOARD, at: boardLoads };
      }
    })
  };
  const BOARD_SESSION = serverSession('ses_board', 'srv-board', boardClient);
  const h = harness(BOARD_SESSION);
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(150);
  const el = renderPanel(h, BOARD_SESSION);
  const text = () => el?.textContent ?? '';

  expect(
    'PN6 the board header counts sessions · leases · hand-offs · archived',
    text().includes('2 sessions · 1 leases · 2 hand-offs · 1 archived'),
    JSON.stringify(text())
  );
  expect(
    'PN6 the session row carries 🔒1 / ‹2› / ⇢1 / [frozen] / [urgent]',
    text().includes('🔒1') &&
      text().includes('‹2›') &&
      text().includes('⇢1') &&
      text().includes('[frozen]') &&
      text().includes('[urgent]'),
    JSON.stringify(text())
  );
  expect(
    'PN6 derived rows are folded by default: no ↳ and no archived row',
    text().includes('Archived 1') && !text().includes('↳') && !text().includes('archived worker'),
    JSON.stringify(text())
  );

  const find = (predicate) => {
    const out = [];
    const walk = node => {
      if (!node) return;
      if (node.nodeType === 1) {
        if (predicate(node)) out.push(node);
        for (const child of node.childNodes ?? []) walk(child);
      }
    };
    walk(el);
    return out[0];
  };
  const fire = target => {
    const event = { type: 'click', target, cancelBubble: false };
    for (const listener of documentStub.listeners.get('click') ?? []) listener(event);
  };

  const sessionButton = find(node => String(node.className).includes('collab-session') && node.textContent.includes('ses_board'));
  expect('PN6 the session row is a clickable button', Boolean(sessionButton), sessionButton?.className);
  fire(sessionButton);
  expect(
    'PN6 clicking a session selects it: the right detail shows ↳ child + lock / hand-off / queue',
    text().includes('↳') &&
      text().includes('ses_child') &&
      text().includes('named:board-window') &&
      text().includes('b_board_spawn') &&
      text().includes('q_board'),
    JSON.stringify(text())
  );

  const archivedButton = find(node => String(node.className).includes('collab-archived'));
  expect('PN6 the archived section is a clickable fold', Boolean(archivedButton), archivedButton?.className);
  fire(archivedButton);
  expect(
    'PN6 clicking 已归档 reveals the archived row (with [archived])',
    text().includes('archived worker') && text().includes('[archived]'),
    JSON.stringify(text())
  );

  // The 2 s poll replaces `data`; the local expand set must survive it.
  const loadsBeforePoll = boardLoads;
  await sleep(2100);
  expect(
    'PN6 a 2 s poll actually replaced the snapshot during the wait',
    boardLoads > loadsBeforePoll,
    `${loadsBeforePoll} → ${boardLoads} loads`
  );
  expect(
    'PN6 a 2 s poll does not drop the selection (detail still shown)',
    text().includes('↳') && text().includes('archived worker'),
    JSON.stringify(text())
  );
  dispose();
}

// 7. F1: rows that belong to no listed session still render (0.5.3 parity).
{
  const ORPHAN = {
    at: 1,
    reachable: true,
    sessions: [],
    locks: [
      {
        resource: 'named:ghost-window',
        kind: 'named',
        mode: 'exclusive',
        holders: ['ses_ghost'],
        waiters: 0,
        waiting: [],
        expiresInMs: 600_000
      }
    ],
    handoffs: [
      { bid: 'b_ghost', state: 'open', ageMs: 1_000, from: 'ses_ghost', title: 'ghost hand-off' }
    ],
    queue: [{ queueId: 'q_ghost', target: 'ses_p', ageMs: 1_000, summary: 'ghost request', seen: false }]
  };
  // `ses_me` is not in `sessions`, so the queue cannot attach to a session row.
  const ORPHAN_SESSION = serverSession('ses_me', 'srv-orphan', fakeClient({ reply: ORPHAN }));
  const h = harness(ORPHAN_SESSION);
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(150);
  const el = renderPanel(h, ORPHAN_SESSION);
  const text = el?.textContent ?? '';
  expect(
    'PN7 orphan leases / hand-offs / queue render as 未归属 sections (never silently dropped)',
    text.includes('Leases (1) · unclaimed') &&
      text.includes('Open hand-offs (1) · unclaimed') &&
      text.includes('Owner queue (1) · unclaimed') &&
      text.includes('named:ghost-window') &&
      text.includes('b_ghost') &&
      text.includes('q_ghost'),
    JSON.stringify(text)
  );
  dispose();
}

/* ---------------------------------- 8. 0.8.0 (board2-layout): master / detail */

/** Depth-first search of the mini DOM (the same shape as PN6's local helper). */
function findIn(root, predicate) {
  let hit;
  const walk = node => {
    if (hit || !node) return;
    if (node.nodeType === 1) {
      if (predicate(node)) {
        hit = node;
        return;
      }
      for (const child of node.childNodes ?? []) walk(child);
    }
  };
  walk(root);
  return hit;
}

/** Click through Solid's delegated listener, with the node as `target`. */
function fireClick(target) {
  return fireDocumentEvent('click', target);
}

/**
 * 0.8.2: a **delegated** event (Solid attaches these to `document`), e.g.
 * `dblclick` / `pointerdown`. The event object is the minimum Solid's own
 * handler reads; `currentTarget` is derived by it.
 */
function fireDocumentEvent(type, target, props = {}) {
  const event = { type, target, cancelBubble: false, ...props };
  for (const listener of documentStub.listeners.get(type) ?? []) listener(event);
  return event;
}

/**
 * 0.8.2: a **direct** element listener (`wheel` is not in Solid's delegated
 * set), bubbled up the `parentNode` chain like a real DOM event would be.
 */
function fireElementEvent(target, type, props = {}) {
  const event = { type, target, cancelBubble: false, ...props };
  let node = target;
  while (node) {
    for (const listener of node.listeners?.get(type) ?? []) listener(event);
    node = node.parentNode;
  }
  return event;
}

const LAYOUT = {
  at: 1,
  reachable: true,
  sessions: [
    {
      sid: 'ses_layout_board01',
      title: 'layout worker',
      agent: 'build',
      busy: true,
      workspace: '/data/project/collab'
    },
    { sid: 'ses_layout_child01', title: 'child worker', agent: 'explore', busy: false, workspace: '/data/project/collab' },
    { sid: 'ses_layout_other01', title: 'other worker', agent: 'build', busy: false, workspace: '/data/project/other' }
  ],
  locks: [
    {
      resource: 'named:layout-window',
      kind: 'named',
      mode: 'exclusive',
      holders: ['ses_layout_board01'],
      waiters: 0,
      waiting: [],
      expiresInMs: 600_000
    }
  ],
  handoffs: [
    {
      bid: 'b_layout_spawn',
      state: 'claimed',
      ageMs: 1_000,
      from: 'ses_layout_board01',
      claimBy: 'ses_layout_child01',
      spawned: 'ses_layout_child01',
      kind: 'spawn',
      title: 'spawn the child',
      workspace: '/data/project/collab'
    },
    {
      bid: 'b_layout_open',
      state: 'open',
      ageMs: 2_000,
      from: 'ses_layout_board01',
      title: 'open thing',
      priority: 'urgent',
      workspace: '/data/project/collab'
    }
  ],
  queue: [{ queueId: 'q_layout', target: 'ses_p', ageMs: 1_000, summary: 'req', seen: false }]
};

{
  let layoutLoads = 0;
  let layoutReply = LAYOUT;
  const layoutClient = {
    rpc: () => ({
      snapshot: async () => {
        layoutLoads += 1;
        return { ...layoutReply, at: layoutLoads };
      }
    })
  };
  const ME = 'ses_layout_board01';
  const LAYOUT_SESSION = serverSession(ME, 'srv-layout', layoutClient);
  const h = harness(LAYOUT_SESSION, { locale: 'zh' });
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(150);
  const el = renderPanel(h, LAYOUT_SESSION);
  const text = () => el?.textContent ?? '';
  const byClass = name => findIn(el, node => String(node.className).includes(name));
  const selectedRow = () => findIn(el, node => String(node.className).includes('collab-session-selected'));

  expect(
    'PN8 the panel is a split: a sidebar and a detail pane (CSS grid, 320px + 1fr)',
    Boolean(byClass('collab-split')) && Boolean(byClass('collab-sidebar')) && Boolean(byClass('collab-detail-pane')),
    [byClass('collab-split'), byClass('collab-sidebar'), byClass('collab-detail-pane')]
      .map(node => node?.className ?? '(missing)')
      .join(' / ')
  );
  expect(
    'PN8 with nothing selected the detail pane says how to pick one (never blank)',
    text().includes('选择左侧会话查看详情'),
    JSON.stringify(text())
  );
  const row = findIn(el, node => String(node.className).includes('collab-session') && node.textContent.includes('layout worker'));
  expect('PN8 a session row is the selection button', Boolean(row), row?.className);
  fireClick(row);
  expect(
    'PN8 clicking a row selects it: the row is highlighted and the detail names the same session',
    Boolean(selectedRow()) &&
      selectedRow().textContent.includes('ses_layo…rd01') &&
      text().includes('ses_layout_board01'),
    JSON.stringify({ selected: selectedRow()?.className, text: text() })
  );
  expect(
    'PN8 the graph and action slots are real elements (the next two tasks mount in place)',
    findIn(el, node => node.attrs?.['data-collab-slot'] === 'graph')?.className ===
      'collab-detail-section collab-graph-slot' &&
      findIn(el, node => node.attrs?.['data-collab-slot'] === 'actions')?.className ===
        'collab-detail-section collab-actions-slot',
    [findIn(el, node => node.attrs?.['data-collab-slot'] === 'graph'), findIn(el, node => node.attrs?.['data-collab-slot'] === 'actions')]
      .map(node => node?.className ?? '(missing)')
      .join(' / ')
  );
  // R2: the pane's **direct element children** are header → graph → actions →
  // items. Swapping the two slots must fail here (a "both exist" assertion
  // cannot).
  const paneChildren = () =>
    (byClass('collab-detail-pane')?.childNodes ?? [])
      .filter(node => node.nodeType === 1)
      .map(node => String(node.className));
  expect(
    'PN8 the detail pane order is header → graph slot → actions slot → items (R2)',
    JSON.stringify(paneChildren()) ===
      JSON.stringify([
        'collab-detail-header',
        'collab-detail-section collab-graph-slot',
        'collab-detail-section collab-actions-slot',
        'collab-items'
      ]),
    JSON.stringify(paneChildren())
  );
  expect(
    'PN8 the detail header carries title / agent / full sid / [urgent]',
    text().includes('layout worker') && text().includes('build') && text().includes('ses_layout_board01') && text().includes('[urgent]'),
    JSON.stringify(text())
  );
  expect(
    'PN8 the detail lists leases → hand-offs → queue → ↳ spawned, from the same derivation',
    text().includes('named:layout-window') &&
      text().includes('b_layout_spawn') &&
      text().includes('b_layout_open') &&
      text().includes('q_layout') &&
      text().includes('↳') &&
      text().indexOf('资源租约 (1)') < text().indexOf('未闭环交接 (2)') &&
      text().indexOf('未闭环交接 (2)') < text().indexOf('受保护目标队列 (1)') &&
      text().indexOf('受保护目标队列 (1)') < text().indexOf('拉起的会话 (1)'),
    JSON.stringify(text())
  );

  // R3: the 2 s poll replaces the whole snapshot — the selection must survive it.
  const atBefore = el.getAttribute('data-collab-at');
  const loadsBefore = layoutLoads;
  await sleep(2100);
  expect(
    'PN8 a poll really replaced the snapshot during the wait (loads and `at` both moved)',
    layoutLoads > loadsBefore && el.getAttribute('data-collab-at') !== atBefore,
    `${loadsBefore} → ${layoutLoads} loads; at ${atBefore} → ${el.getAttribute('data-collab-at')}`
  );
  expect(
    'PN8 … and the selection survived it: still highlighted, same session in the detail',
    Boolean(selectedRow()) && text().includes('ses_layout_board01') && text().includes('named:layout-window'),
    JSON.stringify({ loads: layoutLoads, text: text() })
  );

  // R3: the selected session leaves the snapshot → selection cleared + a toast.
  layoutReply = { ...LAYOUT, sessions: LAYOUT.sessions.filter(session => session.sid !== ME) };
  await sleep(2100);
  expect(
    'PN8 a selected session that is gone from the snapshot clears the selection (and the detail)',
    !selectedRow() && text().includes('选择左侧会话查看详情') && !text().includes('ses_layout_board01'),
    JSON.stringify({ text: text(), toast: h.toasts.at(-1) ?? null })
  );
  expect(
    'PN8 … and says why: 该会话已不在快照中',
    h.toasts.some(toast => String(toast?.description ?? '').includes('该会话已不在快照中')),
    JSON.stringify(h.toasts)
  );
  dispose();
}

/* ------------------------------- 9. 0.8.0: the narrow window falls back to one pane */

{
  const NARROW = {
    at: 1,
    reachable: true,
    sessions: [
      { sid: 'ses_narrow_me', title: 'narrow worker', agent: 'build', busy: true, workspace: '/data/project/collab' },
      { sid: 'ses_narrow_child', title: 'narrow child', agent: 'explore', busy: false, workspace: '/data/project/collab' }
    ],
    locks: [
      {
        resource: 'named:narrow-window',
        kind: 'named',
        mode: 'exclusive',
        holders: ['ses_narrow_me'],
        waiters: 0,
        waiting: [],
        expiresInMs: 600_000
      }
    ],
    handoffs: [],
    queue: []
  };
  // The one breakpoint the panel reads. This stub **evaluates** the query
  // against a mutable viewport, so the assertions below pin the number (639 =
  // one pane, 641 = split) instead of "any max-width query matches".
  let viewport = 640;
  globalThis.matchMedia = query => {
    const limit = Number((String(query).match(/max-width:\s*(\d+)px/) ?? [])[1] ?? NaN);
    return {
      get matches() {
        return Number.isFinite(limit) ? viewport <= limit : false;
      },
      addEventListener() {},
      removeEventListener() {}
    };
  };
  const NARROW_SESSION = serverSession('ses_narrow_me', 'srv-narrow', fakeClient({ reply: NARROW }));
  /** Mount one fresh panel at `width` (the panel reads the query once per mount). */
  const openAt = async width => {
    viewport = width;
    const h = harness(NARROW_SESSION, { locale: 'zh' });
    const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
    await sleep(150);
    const el = renderPanel(h, NARROW_SESSION);
    return { h, el, dispose, byClass: name => findIn(el, node => String(node.className).includes(name)), text: () => el?.textContent ?? '' };
  };

  // R1: the breakpoint is 640px — 639 is one pane, 641 is the split. A changed
  // number (say 100) flips the 639 side and fails here.
  const below = await openAt(639);
  expect(
    'PN9 639px is one pane: the list only, no detail placeholder',
    Boolean(below.byClass('collab-sidebar')) &&
      !below.byClass('collab-detail-pane') &&
      !below.text().includes('选择左侧会话查看详情'),
    JSON.stringify(below.text())
  );
  below.dispose();

  const above = await openAt(641);
  expect(
    'PN9 641px is the split: list + detail pane, no 返回列表 button',
    Boolean(above.byClass('collab-sidebar')) &&
      Boolean(above.byClass('collab-detail-pane')) &&
      above.text().includes('选择左侧会话查看详情') &&
      !above.byClass('collab-back'),
    JSON.stringify(above.text())
  );
  above.dispose();

  const { el, dispose, byClass, text } = await openAt(639);
  const row = findIn(el, node => String(node.className).includes('collab-session') && node.textContent.includes('narrow worker'));
  fireClick(row);
  expect(
    'PN9 selecting a session replaces the list with the detail and offers ← 返回列表',
    !byClass('collab-sidebar') &&
      Boolean(byClass('collab-detail-pane')) &&
      Boolean(byClass('collab-back')) &&
      text().includes('返回列表') &&
      text().includes('ses_narrow_me'),
    JSON.stringify(text())
  );

  const back = byClass('collab-back');
  expect('PN9 the detail offers a real ← 返回列表 button', Boolean(back), JSON.stringify(text()));
  if (back) fireClick(back);
  expect(
    'PN9 返回列表 clears the selection and brings the list back',
    Boolean(byClass('collab-sidebar')) && !byClass('collab-detail-pane') && text().includes('narrow child'),
    JSON.stringify(text())
  );

  delete globalThis.matchMedia;
  dispose();
}

/* ------------------- 10. 0.8.0 (board2-graph): three levels + interactions ---- */

const GRAPH_A = '/data/project/alpha';
const GRAPH_B = '/data/project/beta';
const GRAPH = {
  at: 1,
  reachable: true,
  sessions: [
    { sid: 'ses_g_alpha01', title: 'graph alpha', agent: 'build', busy: true, workspace: GRAPH_A },
    {
      sid: 'ses_g_child01',
      title: 'graph child',
      agent: 'build',
      busy: false,
      workspace: GRAPH_A,
      parent: 'ses_g_alpha01'
    },
    { sid: 'ses_g_beta01', title: 'graph beta', agent: 'build', busy: false, workspace: GRAPH_B }
  ],
  locks: [],
  handoffs: [
    {
      bid: 'b_graph_cross',
      state: 'claimed',
      ageMs: 1_000,
      from: 'ses_g_alpha01',
      claimBy: 'ses_g_beta01',
      workspace: GRAPH_B,
      title: 'cross-workspace work',
      // 0.8.0: the chain head of a forwarded record — the dashed `origin` edge.
      // The snapshot carries it as a string (see `SnapshotHandoff.origin`).
      origin: 'ses_g_head01'
    },
    {
      bid: 'b_graph_spawn',
      state: 'claimed',
      ageMs: 2_000,
      from: 'ses_g_alpha01',
      claimBy: 'ses_g_child01',
      spawned: 'ses_g_child01',
      kind: 'spawn',
      workspace: GRAPH_A,
      title: 'spawn the child'
    }
  ],
  queue: []
};

{
  let graphLoads = 0;
  const graphClient = {
    rpc: () => ({
      snapshot: async () => {
        graphLoads += 1;
        return { ...GRAPH, at: graphLoads };
      }
    })
  };
  const GRAPH_SESSION = serverSession('ses_g_alpha01', 'srv-graph', graphClient);
  const h = harness(GRAPH_SESSION, { locale: 'zh' });
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(150);
  const el = renderPanel(h, GRAPH_SESSION);
  const text = () => el?.textContent ?? '';
  const graphRoot = () => findIn(el, node => String(node.className).split(' ').includes('collab-graph'));
  const graphNode = id => findIn(el, node => node.attrs?.['data-graph-node'] === id);
  const graphEdge = (from, to) =>
    findIn(
      el,
      node =>
        node.attrs?.['data-graph-edge'] !== undefined &&
        node.attrs?.['data-graph-from'] === from &&
        node.attrs?.['data-graph-to'] === to
    );
  const graphEdgeOf = (kind, from, to) =>
    findIn(
      el,
      node =>
        node.attrs?.['data-graph-edge'] === kind &&
        node.attrs?.['data-graph-from'] === from &&
        node.attrs?.['data-graph-to'] === to
    );
  const fireMouseOver = target => {
    const event = { type: 'mouseover', target, cancelBubble: false };
    for (const listener of documentStub.listeners.get('mouseover') ?? []) listener(event);
  };

  // R2: with nothing selected the graph is L0 — workspaces as nodes, one merged
  // cross-workspace edge. A session id must not be a node at this level.
  expect(
    'PN10 L0 (no selection): the graph draws workspace nodes and the cross-workspace edge',
    graphRoot()?.getAttribute('data-graph-level') === 'global' &&
      Boolean(graphNode(GRAPH_A)) &&
      Boolean(graphNode(GRAPH_B)) &&
      !graphNode('ses_g_alpha01') &&
      graphEdge(GRAPH_A, GRAPH_B)?.getAttribute('data-graph-edge') === 'handoff' &&
      text().includes('全局'),
    JSON.stringify({
      level: graphRoot()?.getAttribute('data-graph-level'),
      nodes: [...(graphRoot()?.childNodes ?? [])].length,
      text: text()
    })
  );

  // R2: clicking the workspace name is what reaches L1 — that workspace's
  // sessions, plus ONE workspace node for the counterpart (never its sessions).
  const wsButton = findIn(
    el,
    node => String(node.className).split(' ').includes('collab-ws') && node.textContent.includes('alpha')
  );
  expect('PN10 the workspace header is a select button', Boolean(wsButton), wsButton?.className);
  fireClick(wsButton);
  expect(
    'PN10 L1 (workspace selected): alpha sessions expand, beta stays one dashed workspace node',
    graphRoot()?.getAttribute('data-graph-level') === 'workspace' &&
      Boolean(graphNode('ses_g_alpha01')) &&
      Boolean(graphNode('ses_g_child01')) &&
      Boolean(graphNode(GRAPH_B)) &&
      !graphNode('ses_g_beta01') &&
      graphEdge('ses_g_alpha01', GRAPH_B)?.getAttribute('data-graph-edge') === 'handoff' &&
      text().includes('工作区'),
    JSON.stringify({ level: graphRoot()?.getAttribute('data-graph-level'), text: text() })
  );

  // R2: selecting a session is L2 — the session ±1 hop.
  const alphaRow = findIn(
    el,
    node => String(node.className).includes('collab-session') && node.textContent.includes('graph alpha')
  );
  fireClick(alphaRow);
  expect(
    'PN10 L2 (session selected): centre + direct neighbours only',
    graphRoot()?.getAttribute('data-graph-level') === 'session' &&
      Boolean(graphNode('ses_g_alpha01')) &&
      Boolean(graphNode('ses_g_child01')) &&
      Boolean(graphNode('ses_g_beta01')) &&
      text().includes('会话'),
    JSON.stringify({ level: graphRoot()?.getAttribute('data-graph-level'), text: text() })
  );

  // R1: the four edge kinds have four line styles — `handoff` solid, `origin`
  // dashed, `spawn` / `subagent` dotted. Only a `stroke-dasharray` assertion
  // catches a regression here (class names alone would not).
  const dashOf = (kind, from, to) => graphEdgeOf(kind, from, to)?.getAttribute('stroke-dasharray');
  expect(
    'PN10 edge line styles follow R1: handoff solid / origin dashed / spawn & subagent dotted',
    dashOf('handoff', 'ses_g_alpha01', 'ses_g_beta01') === '' &&
      dashOf('origin', 'ses_g_head01', 'ses_g_alpha01') === '4 3' &&
      dashOf('spawn', 'ses_g_alpha01', 'ses_g_child01') === '1 3' &&
      dashOf('subagent', 'ses_g_alpha01', 'ses_g_child01') === '1 3',
    JSON.stringify({
      handoff: dashOf('handoff', 'ses_g_alpha01', 'ses_g_beta01'),
      origin: dashOf('origin', 'ses_g_head01', 'ses_g_alpha01'),
      spawn: dashOf('spawn', 'ses_g_alpha01', 'ses_g_child01'),
      subagent: dashOf('subagent', 'ses_g_alpha01', 'ses_g_child01')
    })
  );

  // R2: hovering a node brightens the edges that touch it (and only those).
  const childNode = graphNode('ses_g_child01');
  fireMouseOver(childNode);
  const spawnEdge = () => graphEdge('ses_g_alpha01', 'ses_g_child01');
  const crossEdge = () => graphEdge('ses_g_alpha01', 'ses_g_beta01');
  expect(
    'PN10 hovering a node highlights its edges (adjacent only)',
    String(spawnEdge()?.className).includes('collab-graph-edge-active') &&
      !String(crossEdge()?.className).includes('collab-graph-edge-active'),
    JSON.stringify({ spawn: spawnEdge()?.className, cross: crossEdge()?.className })
  );

  // R2: a node click selects that session — the detail (and its items) follow.
  fireClick(childNode);
  expect(
    'PN10 clicking a graph node selects that session (detail now names the child)',
    text().includes('ses_g_child01') &&
      graphRoot()?.getAttribute('data-graph-level') === 'session' &&
      Boolean(findIn(el, node => String(node.className).includes('collab-session-selected') && node.textContent.includes('graph child'))),
    JSON.stringify({ text: text() })
  );

  // Back to alpha, then fold one hop with the node's ▸/▾ badge.
  fireClick(
    findIn(el, node => String(node.className).includes('collab-session') && node.textContent.includes('graph alpha'))
  );
  const toggle = findIn(el, node => node.attrs?.['data-graph-toggle'] === 'ses_g_alpha01');
  expect('PN10 a node with neighbours carries a ▸/▾ fold badge', Boolean(toggle), toggle?.className);
  fireClick(toggle);
  expect(
    'PN10 folding the centre hides its one-hop neighbours (only the centre remains)',
    Boolean(graphNode('ses_g_alpha01')) && !graphNode('ses_g_child01') && !graphNode('ses_g_beta01'),
    JSON.stringify(text())
  );
  fireClick(findIn(el, node => node.attrs?.['data-graph-toggle'] === 'ses_g_alpha01'));
  expect(
    'PN10 unfolding restores them (the fold set is window-local, not snapshot data)',
    Boolean(graphNode('ses_g_child01')) && Boolean(graphNode('ses_g_beta01')),
    JSON.stringify(text())
  );

  // The 2 s poll replaces `data`; the graph (and the selection) must survive it.
  const loadsBefore = graphLoads;
  await sleep(2100);
  expect(
    'PN10 a poll really replaced the snapshot during the wait',
    graphLoads > loadsBefore,
    `${loadsBefore} → ${graphLoads} loads`
  );
  expect(
    'PN10 … and the L2 graph is still the selected session’s (selection is local memory)',
    graphRoot()?.getAttribute('data-graph-level') === 'session' && Boolean(graphNode('ses_g_child01')),
    JSON.stringify(text())
  );
  dispose();
}

/* ------------------- 11. 0.8.0 (board2-graph): the +N marker past the cap ---- */

{
  const CROWD = {
    at: 1,
    reachable: true,
    sessions: [
      { sid: 'ses_crowd_center', title: 'crowd centre', agent: 'build', busy: true, workspace: GRAPH_A },
      ...Array.from({ length: 12 }, (_, index) => ({
        sid: `ses_crowd_${String(index).padStart(2, '0')}`,
        title: `crowd ${index}`,
        agent: 'build',
        busy: false,
        workspace: GRAPH_A
      }))
    ],
    locks: [],
    handoffs: Array.from({ length: 12 }, (_, index) => ({
      bid: `b_crowd_${String(index).padStart(2, '0')}`,
      state: 'claimed',
      ageMs: 1_000,
      from: 'ses_crowd_center',
      claimBy: `ses_crowd_${String(index).padStart(2, '0')}`,
      workspace: GRAPH_A,
      title: 'crowd'
    })),
    queue: []
  };
  const CROWD_SESSION = serverSession('ses_crowd_center', 'srv-crowd', fakeClient({ reply: CROWD }));
  const h = harness(CROWD_SESSION, { locale: 'zh' });
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(150);
  const el = renderPanel(h, CROWD_SESSION);
  fireClick(
    findIn(el, node => String(node.className).includes('collab-session') && node.textContent.includes('crowd centre'))
  );
  const nodes = [];
  const walk = node => {
    if (!node) return;
    if (node.nodeType === 1) {
      if (node.attrs?.['data-graph-node'] !== undefined) nodes.push(node.attrs['data-graph-node']);
      for (const child of node.childNodes ?? []) walk(child);
    }
  };
  walk(el);
  const more = findIn(el, node => String(node.className).includes('collab-graph-more'));
  expect(
    'PN11 the graph caps at 8 nodes and prints +N for the rest (never a silent drop)',
    nodes.length === 8 && more?.textContent === '+5',
    JSON.stringify({ nodes: nodes.length, more: more?.textContent })
  );
  // 0.8.2 (R3): the same assertion from the **rendered** SVG — the box every
  // node group draws, at the 640×360 layout's coordinates.
  const groups = [];
  const walkGroups = node => {
    if (!node) return;
    if (node.nodeType === 1) {
      if (node.attrs?.['data-graph-node'] !== undefined) groups.push(node);
      for (const child of node.childNodes ?? []) walkGroups(child);
    }
  };
  walkGroups(el);
  const labels = [];
  const walkLabels = node => {
    if (!node) return;
    if (node.nodeType === 1) {
      if (String(node.className).includes('collab-graph-label')) labels.push(node.textContent);
      for (const child of node.childNodes ?? []) walkLabels(child);
    }
  };
  walkLabels(el);
  const boxes = groups.map(group => {
    const rect = findIn(group, node => node.attrs?.class === 'collab-graph-box');
    return {
      id: group.attrs['data-graph-node'],
      x: Number(rect?.attrs.x),
      y: Number(rect?.attrs.y),
      w: Number(rect?.attrs.width),
      h: Number(rect?.attrs.height)
    };
  });
  const overlaps = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        overlaps.push(`${a.id}×${b.id}`);
      }
    }
  }
  expect(
    'PN11 R3: the eight rendered boxes do not intersect, and every label is ≤ 8 code points',
    boxes.length === 8 &&
      boxes.every(box => box.w > 0 && box.h === 22) &&
      overlaps.length === 0 &&
      labels.every(text => Array.from(text).length <= 8),
    JSON.stringify({ overlaps, labels, boxes })
  );
  dispose();
}

/* ---------- 11b. 0.8.2 (graph-zoom): wheel zoom / drag pan / double-click ---- */

/*
 * R1/R2 on the **shipped bundle**: the wheel is a direct listener (Solid does
 * not delegate `wheel`), the drag uses pointer events plus two document-level
 * listeners for the duration of the gesture, and a double-click on the blank
 * canvas resets. Every assertion reads the SVG's own `viewBox` — the one thing
 * that actually changes — so "zoom happened" cannot be faked by a data
 * attribute.
 */
{
  const ZOOM_SESSION = serverSession('ses_g_alpha01', 'srv-zoom', fakeClient({ reply: GRAPH }));
  const h = harness(ZOOM_SESSION, { locale: 'zh' });
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(150);
  const el = renderPanel(h, ZOOM_SESSION);
  // L2 (the selected session) so the graph has 4 nodes and every node exists.
  fireClick(
    findIn(el, node => String(node.className).includes('collab-session') && node.textContent.includes('graph alpha'))
  );
  const svg = () => findIn(el, node => String(node.className).includes('collab-graph-svg'));
  const viewBox = () => String(svg()?.getAttribute('viewBox') ?? '').split(' ').map(Number);
  const zoomOf = () => Number(svg()?.getAttribute('data-graph-zoom'));
  const panOf = () => String(svg()?.getAttribute('data-graph-pan') ?? '').split(',').map(Number);
  const wheel = (deltaY, x = 320, y = 180) =>
    fireElementEvent(svg(), 'wheel', { deltaY, clientX: x, clientY: y });

  expect(
    'PN14 the SVG draws the 640×360 canvas at 1× (R3: the old one was 320×180)',
    JSON.stringify(viewBox()) === JSON.stringify([0, 0, 640, 360]) && zoomOf() === 1,
    JSON.stringify({ viewBox: viewBox(), zoom: zoomOf() })
  );

  // R1: a wheel notch up zooms in **around the pointer** (the graph point under
  // the pointer stays put), and the viewBox shrinks — the graph data does not
  // change (the node rects keep their layout coordinates).
  const alphaRect = () => findIn(findIn(el, node => node.attrs?.['data-graph-node'] === 'ses_g_alpha01'), n => n.attrs?.class === 'collab-graph-box');
  const beforeRect = { ...alphaRect()?.attrs };
  const beforeNodes = el.textContent;
  wheel(-200, 480, 90);
  const zoomed = viewBox();
  const anchorX = zoomed[0] + (480 / 640) * zoomed[2];
  const anchorY = zoomed[1] + (90 / 360) * zoomed[3];
  expect(
    'PN14 wheel up zooms in around the pointer (viewBox 640 → smaller, anchor fixed)',
    zoomOf() > 1 && zoomed[2] < 640 && zoomed[3] < 360 && Math.abs(anchorX - 480) < 1 && Math.abs(anchorY - 90) < 1,
    JSON.stringify({ viewBox: zoomed, zoom: zoomOf(), anchorX, anchorY })
  );
  expect(
    'PN14 … and the node geometry is untouched (only the viewBox changed)',
    JSON.stringify(alphaRect()?.attrs) === JSON.stringify(beforeRect) &&
      el.textContent === beforeNodes,
    JSON.stringify({ before: beforeRect, after: alphaRect()?.attrs })
  );

  // R1: the range is [0.6, 2.5] — 40 notches in either direction stay inside it.
  for (let i = 0; i < 40; i += 1) wheel(-100);
  const top = { zoom: zoomOf(), box: viewBox() };
  for (let i = 0; i < 80; i += 1) wheel(100);
  const bottom = { zoom: zoomOf(), box: viewBox() };
  expect(
    'PN14 the zoom range is clamped: 2.5× at the top, 0.6× at the bottom (never NaN)',
    top.zoom === 2.5 &&
      Math.abs(top.box[2] - 256) < 0.2 &&
      Math.abs(top.box[3] - 144) < 0.2 &&
      bottom.zoom === 0.6 &&
      Math.abs(bottom.box[2] - 1066.7) < 0.2 &&
      Math.abs(bottom.box[0] - -213.3) < 0.2,
    JSON.stringify({ top, bottom })
  );

  // R2: double-click the **blank** canvas → back to 1× / centred.
  fireDocumentEvent('dblclick', svg());
  expect(
    'PN14 double-clicking the blank canvas resets to 1× and pan 0',
    JSON.stringify(viewBox()) === JSON.stringify([0, 0, 640, 360]) && zoomOf() === 1,
    JSON.stringify({ viewBox: viewBox(), pan: panOf() })
  );

  // R2: drag the blank canvas. A drag far past the edge is clamped (10 % of the
  // canvas may stay blank, never more), so the viewBox stops at -64.
  fireDocumentEvent('pointerdown', svg(), { button: 0, clientX: 320, clientY: 180 });
  fireDocumentEvent('pointermove', svg(), { clientX: 2600, clientY: 180 });
  fireDocumentEvent('pointerup', svg(), { clientX: 2600, clientY: 180 });
  const panned = { box: viewBox(), pan: panOf() };
  expect(
    'PN14 dragging right pans the view left, and an over-drag is clamped',
    Math.abs(panned.box[0] - -64) < 0.2 && Math.abs(panned.pan[0] - -64) < 0.2,
    JSON.stringify(panned)
  );
  fireDocumentEvent('pointerdown', svg(), { button: 0, clientX: 320, clientY: 180 });
  fireDocumentEvent('pointermove', svg(), { clientX: -3000, clientY: 180 });
  fireDocumentEvent('pointerup', svg(), { clientX: -3000, clientY: 180 });
  expect(
    'PN14 … and dragging the other way is clamped at +64 (the view never leaves the canvas)',
    Math.abs(viewBox()[0] - 64) < 0.2,
    JSON.stringify({ box: viewBox(), pan: panOf() })
  );

  // A drag started **on a node** must not pan (it is a click, not a canvas drag).
  const alphaNode = findIn(el, node => node.attrs?.['data-graph-node'] === 'ses_g_alpha01');
  const beforeDragOnNode = viewBox();
  fireDocumentEvent('pointerdown', alphaNode, { button: 0, clientX: 320, clientY: 180 });
  fireDocumentEvent('pointermove', alphaNode, { clientX: 600, clientY: 300 });
  fireDocumentEvent('pointerup', alphaNode, { clientX: 600, clientY: 300 });
  expect(
    'PN14 a pointerdown on a node is a click, not a pan (the view stays put)',
    JSON.stringify(viewBox()) === JSON.stringify(beforeDragOnNode),
    JSON.stringify({ before: beforeDragOnNode, after: viewBox() })
  );

  // R1: after zoom + pan, clicking a node still selects it — the browser applies
  // the viewBox to hit-testing, and the node kept its own coordinates.
  wheel(-200, 320, 180);
  fireClick(alphaNode);
  fireClick(findIn(el, node => node.attrs?.['data-graph-node'] === 'ses_g_child01'));
  expect(
    'PN14 after zooming, clicking a node still selects it (hit-testing is the browser’s)',
    el.textContent.includes('ses_g_child01') &&
      findIn(el, node => String(node.className).includes('collab-session-selected') && node.textContent.includes('graph child')) !==
        undefined,
    JSON.stringify({ zoom: zoomOf(), text: String(el.textContent).slice(0, 120) })
  );

  // … and the ▸/▾ badge keeps working at that zoom (it is a real element inside
  // the transformed SVG, not a coordinate the panel recomputes).
  fireClick(findIn(el, node => node.attrs?.['data-graph-node'] === 'ses_g_alpha01'));
  const zoomedToggle = findIn(el, node => node.attrs?.['data-graph-toggle'] === 'ses_g_alpha01');
  expect('PN14 the fold badge is still there after zooming', Boolean(zoomedToggle), zoomedToggle?.className);
  fireClick(zoomedToggle);
  expect(
    'PN14 … and folding one hop still works at the zoomed-in view',
    Boolean(findIn(el, node => node.attrs?.['data-graph-node'] === 'ses_g_alpha01')) &&
      !findIn(el, node => node.attrs?.['data-graph-node'] === 'ses_g_child01') &&
      zoomOf() > 1,
    JSON.stringify({ zoom: zoomOf(), box: viewBox() })
  );
  fireClick(findIn(el, node => node.attrs?.['data-graph-toggle'] === 'ses_g_alpha01'));

  // R2: a double-click **on a node** is not a reset (the reset is for the canvas).
  const zoomBeforeNodeDbl = zoomOf();
  fireDocumentEvent('dblclick', findIn(el, node => node.attrs?.['data-graph-node'] === 'ses_g_child01'));
  expect(
    'PN14 a double-click on a node does not reset the view (blank canvas only)',
    zoomOf() === zoomBeforeNodeDbl,
    JSON.stringify({ zoomBeforeNodeDbl, after: zoomOf() })
  );

  // The 2 s poll replaces the snapshot; zoom/pan are window-local and survive it.
  await sleep(2100);
  expect(
    'PN14 a poll keeps the zoom (view state is local memory, never snapshot data)',
    zoomOf() === zoomBeforeNodeDbl && viewBox()[2] < 640 && Boolean(findIn(el, node => node.attrs?.['data-graph-node'] === 'ses_g_alpha01')),
    JSON.stringify({ zoom: zoomOf(), box: viewBox() })
  );
  dispose();
}

/* ---------------- 12. 0.8.0 (board2-actions): four confirmed write actions -- */

const ACTION_BOARD = {
  at: 1,
  reachable: true,
  actions: true,
  sessions: [
    { sid: 'ses_act_me', title: 'act me', agent: 'build', busy: true, workspace: '/data/project/collab' },
    { sid: 'ses_act_peer', title: 'act peer', agent: 'build', busy: false, workspace: '/data/project/collab' }
  ],
  locks: [],
  handoffs: [],
  queue: []
};

/** A fake `collab.state` with the four writes recorded (and a load counter). */
function boardClient({ board = ACTION_BOARD, handler } = {}) {
  const calls = [];
  let loads = 0;
  const run = async (action, input) => {
    calls.push({ action, input });
    if (handler) return handler(action, input);
    return { ok: true, action, target: input.target, detail: `${action} ok → ${input.target}` };
  };
  return {
    calls,
    loads: () => loads,
    client: {
      rpc: () => ({
        snapshot: async () => {
          loads += 1;
          return { ...board, at: loads };
        },
        escalate: input => run('escalate', input),
        freeze: input => run('freeze', input),
        unfreeze: input => run('unfreeze', input),
        archive: input => run('archive', input)
      })
    }
  };
}

/** The app's own confirmation dialogs, recorded (R4). */
function fakeDialogs({ confirm = true, reason = '看板理由：先处理这一单' } = {}) {
  const calls = [];
  return {
    calls,
    open: () => ({ close() {} }),
    active: () => false,
    alert: async options => {
      calls.push({ kind: 'alert', options });
    },
    confirm: async options => {
      calls.push({ kind: 'confirm', options });
      return typeof confirm === 'function' ? confirm(options) : confirm;
    },
    prompt: async options => {
      calls.push({ kind: 'prompt', options });
      return typeof reason === 'function' ? reason(options) : reason;
    },
    select: async () => undefined
  };
}

/** Mount one board with the given client/dialogs and select the peer session. */
async function openBoard({ board = ACTION_BOARD, dialogs, handler, locale = 'zh' } = {}) {
  const fake = boardClient({ board, handler });
  const SESSION = serverSession('ses_act_me', 'srv-act', fake.client);
  const h = harness(SESSION, { locale, dialogs });
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(150);
  const el = renderPanel(h, SESSION);
  const peerRow = findIn(
    el,
    node => String(node.className).includes('collab-session') && node.textContent.includes('act peer')
  );
  if (peerRow) fireClick(peerRow);
  const button = id => findIn(el, node => node.attrs?.['data-collab-action'] === id);
  const buttons = () => {
    const out = [];
    const walk = node => {
      if (!node) return;
      if (node.nodeType === 1) {
        if (node.attrs?.['data-collab-action'] !== undefined) out.push(node.attrs['data-collab-action']);
        for (const child of node.childNodes ?? []) walk(child);
      }
    };
    walk(el);
    return out;
  };
  return { fake, h, el, dispose, button, buttons, text: () => el?.textContent ?? '' };
}

// --- PN12a: four buttons; every click asks first, then runs the RPC.
{
  const dialogs = fakeDialogs();
  const { fake, h, button, buttons, dispose } = await openBoard({ dialogs });
  expect(
    'PN12 the detail pane renders the four action buttons (加急 / 冻结 / 解冻 / 归档)',
    JSON.stringify(buttons()) === JSON.stringify(['escalate', 'freeze', 'unfreeze', 'archive']) &&
      button('escalate').textContent === '加急' &&
      button('archive').textContent === '归档',
    JSON.stringify(buttons())
  );
  const loadsBefore = fake.loads();
  fireClick(button('escalate'));
  await sleep(30);
  expect(
    'PN12 加急 asks for the reason, confirms, then calls escalate with target + reason + actor',
    dialogs.calls.map(call => call.kind).join(',') === 'prompt,confirm' &&
      fake.calls.length === 1 &&
      fake.calls[0].action === 'escalate' &&
      fake.calls[0].input.target === 'ses_act_peer' &&
      fake.calls[0].input.session === 'ses_act_me' &&
      fake.calls[0].input.reason === '看板理由：先处理这一单',
    JSON.stringify({ kinds: dialogs.calls.map(call => call.kind), calls: fake.calls })
  );
  expect(
    'PN12 a successful action shows a success toast and refreshes the snapshot once (no new poller)',
    h.toasts.at(-1)?.variant === 'success' &&
      String(h.toasts.at(-1)?.description ?? '').includes('escalate ok') &&
      fake.loads() === loadsBefore + 1,
    JSON.stringify({ toast: h.toasts.at(-1), loads: `${loadsBefore} → ${fake.loads()}` })
  );

  fireClick(button('freeze'));
  await sleep(30);
  expect(
    'PN12 冻结 confirms (no reason prompt) and calls freeze with scope=session',
    fake.calls.at(-1)?.action === 'freeze' &&
      fake.calls.at(-1)?.input.scope === 'session' &&
      fake.calls.at(-1)?.input.target === 'ses_act_peer' &&
      String(fake.calls.at(-1)?.input.reason ?? '').includes('看板冻结'),
    JSON.stringify(fake.calls.at(-1))
  );
  fireClick(button('unfreeze'));
  await sleep(30);
  fireClick(button('archive'));
  await sleep(30);
  expect(
    'PN12 解冻 / 归档 call their RPC methods for the selected session',
    fake.calls.at(-2)?.action === 'unfreeze' &&
      fake.calls.at(-2)?.input.scope === 'session' &&
      fake.calls.at(-1)?.action === 'archive' &&
      fake.calls.at(-1)?.input.target === 'ses_act_peer',
    JSON.stringify(fake.calls.slice(-2))
  );
  dispose();
}

// --- PN12b: cancelling the dialog writes nothing (R4).
{
  const dialogs = fakeDialogs({ confirm: false });
  const { fake, button, dispose } = await openBoard({ dialogs });
  fireClick(button('escalate'));
  await sleep(30);
  fireClick(button('archive'));
  await sleep(30);
  expect(
    'PN12 cancelling the confirmation calls nothing (0 writes)',
    fake.calls.length === 0 && dialogs.calls.some(call => call.kind === 'confirm'),
    JSON.stringify({ calls: fake.calls, kinds: dialogs.calls.map(call => call.kind) })
  );
  const cancelledPrompt = fakeDialogs({ reason: () => undefined });
  dispose();
  const second = await openBoard({ dialogs: cancelledPrompt });
  fireClick(second.button('escalate'));
  await sleep(30);
  expect(
    'PN12 cancelling the reason prompt also writes nothing',
    second.fake.calls.length === 0,
    JSON.stringify(second.fake.calls)
  );
  second.dispose();
}

// --- PN12c: a refusal is a toast, and the panel stays interactive (R6).
{
  const dialogs = fakeDialogs();
  const { fake, h, button, dispose } = await openBoard({
    dialogs,
    handler: (action, input) =>
      action === 'escalate'
        ? { ok: false, action, target: input.target, detail: '拒绝加急：目标在 protect 名单内（collab.json 的 protect + 内置硬名单）' }
        : { ok: true, action, target: input.target, detail: `${action} ok → ${input.target}` }
  });
  const loadsBefore = fake.loads();
  fireClick(button('escalate'));
  await sleep(30);
  expect(
    'PN12 a refused action shows an error toast with the server’s reason (no refresh, panel intact)',
    h.toasts.at(-1)?.variant === 'error' &&
      String(h.toasts.at(-1)?.description ?? '').includes('protect') &&
      fake.loads() === loadsBefore,
    JSON.stringify({ toast: h.toasts.at(-1), loads: `${loadsBefore} → ${fake.loads()}` })
  );
  fireClick(button('archive'));
  await sleep(30);
  expect(
    'PN12 … and the next action still works (the panel never breaks)',
    fake.calls.at(-1)?.action === 'archive' && h.toasts.at(-1)?.variant === 'success',
    JSON.stringify({ calls: fake.calls, toast: h.toasts.at(-1) })
  );
  dispose();
}

// --- PN12d: a thrown RPC is one error toast; the panel keeps working (R6).
{
  const dialogs = fakeDialogs();
  const { fake, h, button, dispose } = await openBoard({
    dialogs,
    handler: () => {
      throw new Error('server unreachable (rpc rejected)');
    }
  });
  fireClick(button('escalate'));
  await sleep(30);
  expect(
    'PN12 a thrown RPC shows an error toast and writes no snapshot refresh',
    h.toasts.at(-1)?.variant === 'error' &&
      String(h.toasts.at(-1)?.description ?? '').includes('server unreachable') &&
      fake.calls.length === 1,
    JSON.stringify(h.toasts.at(-1))
  );
  expect(
    'PN12 … and the buttons are still rendered/clickable afterwards',
    Boolean(button('archive')) && button('archive').textContent === '归档',
    button('archive')?.textContent
  );
  dispose();
}

// --- PN12e: no dialogs → two-step click (the documented known limitation).
{
  const { fake, h, button, text, dispose } = await openBoard();
  fireClick(button('escalate'));
  await sleep(30);
  expect(
    'PN12 without ctx.dialogs the first click only arms (0 writes) and says so',
    fake.calls.length === 0 &&
      button('escalate').textContent.includes('再点一次') &&
      String(h.toasts.at(-1)?.description ?? '').includes('再点同一个按钮'),
    JSON.stringify({ calls: fake.calls, label: button('escalate').textContent, toast: h.toasts.at(-1) })
  );
  fireClick(button('escalate'));
  await sleep(30);
  expect(
    'PN12 … the second click runs escalate with the default one-line reason',
    fake.calls.length === 1 &&
      fake.calls[0].action === 'escalate' &&
      fake.calls[0].input.reason === '看板加急' &&
      !text().includes('再点一次'),
    JSON.stringify(fake.calls[0])
  );
  dispose();
}

// --- PN12f: `actions:false` (boardActions:false) hides the row, RPC untouched.
{
  const { fake, button, buttons, dispose } = await openBoard({ board: { ...ACTION_BOARD, actions: false } });
  expect(
    'PN12 snapshot actions:false hides every button (the RPC is only hidden, not removed)',
    buttons().length === 0 && !button('escalate') && fake.calls.length === 0,
    JSON.stringify(buttons())
  );
  dispose();
}

// --- PN12g: the two-step arm is per (action, session) — it never leaks.
// (Review R1: `ActionRow` is not recreated when the selection changes, so an
// arm that only remembered the action id let ONE click on another session run.)
{
  const { fake, el, button, dispose } = await openBoard(); // no dialogs; selects ses_act_peer
  fireClick(button('escalate'));
  await sleep(30);
  const armedOnPeer = fake.calls.length === 0 && button('escalate').textContent.includes('再点一次');
  const meRow = findIn(
    el,
    node => String(node.className).includes('collab-session') && node.textContent.includes('act me')
  );
  expect('PN12 (setup) an arm on act peer writes nothing, and the other row exists', armedOnPeer && Boolean(meRow), meRow?.className);
  fireClick(meRow);
  await sleep(20);
  expect(
    'PN12 switching the selection clears the arm: the button on the new session shows 加急 again',
    button('escalate').textContent === '加急' && fake.calls.length === 0,
    JSON.stringify({ label: button('escalate').textContent, calls: fake.calls })
  );
  fireClick(button('escalate'));
  await sleep(30);
  expect(
    'PN12 one click on the new session does NOT execute — it only arms that session (R1)',
    fake.calls.length === 0 && button('escalate').textContent.includes('再点一次'),
    JSON.stringify({ calls: fake.calls, label: button('escalate').textContent })
  );
  fireClick(button('escalate'));
  await sleep(30);
  expect(
    'PN12 … the second click on the new session executes against it (not the previously armed one)',
    fake.calls.length === 1 && fake.calls[0].action === 'escalate' && fake.calls[0].input.target === 'ses_act_me',
    JSON.stringify(fake.calls)
  );
  dispose();
}

// PN13 (0.8.1): the row's title opens the session and its id copies — neither
// may also select the row; the row's own click still only selects.
{
  const ROWS = {
    at: 1,
    reachable: true,
    sessions: [
      { sid: 'ses_row_a', title: 'row a', agent: 'build', busy: false, workspace: '/data/project/collab' },
      { sid: 'ses_row_b', title: 'row b', agent: 'build', busy: false, workspace: '/data/project/collab' }
    ],
    locks: [],
    handoffs: [],
    queue: []
  };
  const rowClient = { rpc: () => ({ snapshot: async () => ({ ...ROWS, at: Date.now() }) }) };
  const ROW_SESSION = serverSession('ses_row_a', 'srv-row', rowClient);
  const h = harness(ROW_SESSION);
  h.context.sessions.list = () => [ROW_SESSION, serverSession('ses_row_b', 'srv-row', rowClient)];
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(150);
  const el = renderPanel(h, ROW_SESSION);
  const text = () => el?.textContent ?? '';
  const rowOf = name =>
    findIn(el, node => String(node.className).includes('collab-session') && String(node.textContent).includes(name));
  const linkIn = (name, cls) =>
    findIn(rowOf(name), node => String(node.className).split(/\s+/).includes(cls));

  fireClick(linkIn('row a', 'collab-row-title'));
  await sleep(40);
  expect(
    'PN13 clicking a row title opens that session tab (focus) and does not select the row',
    h.opened.length === 1 &&
      h.opened[0].id === 'ses_row_a' &&
      h.opened[0].server === 'srv-row' &&
      h.opened[0].focus === true &&
      !text().includes('详情') &&
      !text().includes('Details'),
    JSON.stringify({ opened: h.opened, detail: text().includes('详情') })
  );

  fireClick(linkIn('row a', 'collab-mono'));
  await sleep(40);
  expect(
    'PN13 clicking a row id copies the FULL sid and toasts, without selecting',
    h.copied.length === 1 &&
      h.copied[0] === 'ses_row_a' &&
      /已复制|copied/i.test(h.toasts.at(-1)?.title ?? '') &&
      !text().includes('来源') &&
      h.opened.length === 1,
    JSON.stringify({ copied: h.copied, toast: h.toasts.at(-1) })
  );

  fireClick(rowOf('row a'));
  await sleep(60);
  expect(
    'PN13 clicking elsewhere in the row selects it and neither jumps nor copies',
    h.opened.length === 1 && h.copied.length === 1 && (text().includes('row a') && text().includes('row a')),
    JSON.stringify({ opened: h.opened.length, copied: h.copied.length, text: text().slice(0, 120) })
  );
  dispose();
}

/* ---------------- 14. 0.9.7: the contract badge + the contract detail block -- */

const CT_WORKSPACE = '/data/project/contract';
/** A contract block the server would derive from `collab-contract/<sid>.json`. */
const CONTRACT = {
  at: 1,
  reachable: true,
  sessions: [
    {
      sid: 'ses_ct_drift01',
      title: 'drift worker',
      agent: 'build',
      busy: true,
      workspace: CT_WORKSPACE,
      contract: {
        mission: {
          oneLine: '排钟 B4 接线',
          state: 'active',
          confirmed: true,
          inScope: ['排钟'],
          outOfScope: ['ws集群实施'],
          handoffTo: { ws集群实施: 'ses_edc3aaaaaaaaaaaa' }
        },
        progress: { lit: 2, total: 5, next: 'M3「双写验证」' },
        todos: { open: 3, blocked: 1, suspended: 1, drifted: 1 },
        drift: { drifted: true, reason: '连续 6 轮无主线动作（11h）· 未处置', since: Date.now() - 11 * 3_600_000 }
      }
    },
    {
      sid: 'ses_ct_park01',
      title: 'parked worker',
      agent: 'build',
      busy: false,
      workspace: CT_WORKSPACE,
      contract: { todos: { open: 2, blocked: 0, suspended: 1, drifted: 0 } }
    },
    {
      sid: 'ses_ct_open01',
      title: 'open worker',
      agent: 'build',
      busy: false,
      workspace: CT_WORKSPACE,
      contract: { todos: { open: 3, blocked: 0, suspended: 0, drifted: 0 } }
    },
    {
      // `open` already counts the blocked row: the badge must say `3`, never `5`.
      sid: 'ses_ct_mixed01',
      title: 'mixed worker',
      agent: 'build',
      busy: false,
      workspace: CT_WORKSPACE,
      contract: { todos: { open: 3, blocked: 2, suspended: 0, drifted: 0 } }
    },
    {
      sid: 'ses_ct_quiet01',
      title: 'quiet worker',
      agent: 'explore',
      busy: false,
      workspace: CT_WORKSPACE,
      contract: {
        mission: { oneLine: '没事干', state: 'active', confirmed: true, inScope: [], outOfScope: [] }
      }
    },
    { sid: 'ses_ct_none01', title: 'plain worker', agent: 'explore', busy: false, workspace: CT_WORKSPACE }
  ],
  locks: [],
  handoffs: [],
  queue: []
};

{
  let contractReply = CONTRACT;
  const client = {
    rpc: () => ({
      snapshot: async () => contractReply
    })
  };
  const SESSION = serverSession('ses_ct_drift01', 'srv-contract', client);
  const h = harness(SESSION, { locale: 'zh' });
  const styleItem = () => h.registered.find(entry => entry.registry === 'style')?.item ?? '';
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(150);
  const el = renderPanel(h, SESSION);
  const text = () => el?.textContent ?? '';
  const byClass = name => findIn(el, node => String(node.className).includes(name));
  const rowOf = title =>
    findIn(el, node => String(node.className).includes('collab-session') && node.textContent.includes(title));
  const badgeOf = row => findIn(row, node => String(node.className).includes('collab-contract-badge'));
  const elementKids = node => (node?.childNodes ?? []).filter(child => child.nodeType === 1);

  // R2: the badge carries the priority the contract implies, one row each.
  const cases = [
    ['drift worker', '◇', 'collab-tone-danger', 'drift → ◇ red'],
    ['parked worker', '◐', 'collab-tone-warning', 'suspended → ◐ amber'],
    ['open worker', '◑3', 'collab-tone-info', 'open → ◑ blue + count'],
    ['mixed worker', '◑3', 'collab-tone-info', 'open=3 + blocked=2 counts once → ◑3 (not ◑5)'],
    ['quiet worker', '●', 'collab-tone-muted', 'a quiet contract → ● grey']
  ];
  for (const [title, label, tone, why] of cases) {
    const badge = badgeOf(rowOf(title));
    expect(
      `PN14 the list badge for ${why}: ${label}`,
      Boolean(badge) &&
        badge.textContent === label &&
        String(badge.className).includes('collab-contract-badge') &&
        String(badge.className).includes(tone),
      JSON.stringify({ label: badge?.textContent, className: badge?.className })
    );
  }
  expect(
    'PN14 a session without a contract shows no badge at all',
    Boolean(rowOf('plain worker')) && !badgeOf(rowOf('plain worker')),
    JSON.stringify(badgeOf(rowOf('plain worker'))?.className ?? null)
  );

  // R2: the badge is the **last element of the second line** and adds no line.
  const body = findIn(rowOf('open worker'), node => String(node.className).includes('collab-row-body'));
  const main = findIn(rowOf('open worker'), node => String(node.className).includes('collab-row-main'));
  const meta = findIn(rowOf('open worker'), node => String(node.className).includes('collab-row-meta'));
  const metaKids = elementKids(meta);
  expect(
    'PN14 the badge ends the second line: the row body still has exactly two lines (no new row)',
    JSON.stringify(elementKids(body).map(node => String(node.className))) ===
      JSON.stringify(['collab-row-main', 'collab-row-meta']) &&
      !badgeOf(main) &&
      metaKids.at(-1) === badgeOf(meta) &&
      metaKids.at(-1).textContent === '◑3',
    JSON.stringify({ body: elementKids(body).map(node => node.className), meta: metaKids.map(node => node.textContent) })
  );
  expect(
    'PN14 the badge cannot wrap (CSS `white-space:nowrap`, `flex:none` inside the meta line)',
    /\.collab-contract-badge\{[^}]*white-space:nowrap/.test(styleItem()) &&
      /\.collab-row\{[^}]*display:flex/.test(styleItem()) &&
      !/\.collab-row-meta\{[^}]*flex-wrap:wrap/.test(styleItem()),
    styleItem().match(/\.collab-contract-badge\{[^}]*\}/)?.[0] ?? '(missing rule)'
  );

  // R3: selecting the drifted session shows the five faces, in order, between the
  // header and the graph slot.
  fireClick(rowOf('drift worker'));
  await sleep(30);
  const pane = byClass('collab-detail-pane');
  expect(
    'PN14 the detail pane order is header → contract slot → graph slot → actions slot → items',
    JSON.stringify(elementKids(pane).map(node => String(node.className))) ===
      JSON.stringify([
        'collab-detail-header',
        'collab-detail-section collab-contract-slot',
        'collab-detail-section collab-graph-slot',
        'collab-detail-section collab-actions-slot',
        'collab-items'
      ]),
    JSON.stringify(elementKids(pane).map(node => node.className))
  );
  const slot = findIn(el, node => node.attrs?.['data-collab-slot'] === 'contract');
  const contractRows = elementKids(slot).filter(node => String(node.className).includes('collab-contract-row'));
  const rowParts = contractRows.map(row => ({
    label: elementKids(row)[0]?.textContent,
    text: elementKids(row)[1]?.textContent
  }));
  expect(
    'PN14 the contract block renders 主线 / 边界 / 进度 / 待办 / 漂移 in that order',
    JSON.stringify(rowParts.map(part => part.label)) === JSON.stringify(['主线', '边界', '进度', '待办', '漂移']),
    JSON.stringify(rowParts)
  );
  expect(
    'PN14 … with the mission, the declared boundary, M2/5 + next milestone, the todo counts and the drift reason',
    rowParts[0]?.text.includes('排钟 B4 接线（已确认）') &&
      rowParts[1]?.text.includes('做 排钟') &&
      rowParts[1]?.text.includes('不做 ws集群实施') &&
      rowParts[2]?.text === '2/5 · 下一里程碑 M3「双写验证」' &&
      rowParts[3]?.text === '3 open · 1 blocked · 1 suspended · 1 drifted' &&
      rowParts[4]?.text.includes('连续 6 轮无主线动作') &&
      rowParts[4]?.text.includes('未处置'),
    JSON.stringify(rowParts.map(part => part.text))
  );

  // R3: 缺项隐藏 — the parked session has no mission/progress, so the block is
  // shorter (one row: 待办) instead of printing empty faces.
  fireClick(rowOf('parked worker'));
  await sleep(30);
  const parkedSlot = findIn(el, node => node.attrs?.['data-collab-slot'] === 'contract');
  const parkedRows = elementKids(parkedSlot).filter(node => String(node.className).includes('collab-contract-row'));
  expect(
    'PN14 a face with no content is hidden, not rendered empty',
    JSON.stringify(parkedRows.map(row => elementKids(row)[0]?.textContent)) === JSON.stringify(['待办']),
    JSON.stringify(parkedRows.map(row => elementKids(row)[0]?.textContent))
  );

  // (a) `open` is the total, so the badge number and the detail's `N open` are
  // the **same** number — `blocked` is a breakdown, never an addend.
  fireClick(rowOf('mixed worker'));
  await sleep(30);
  const mixedSlot = findIn(el, node => node.attrs?.['data-collab-slot'] === 'contract');
  const mixedRows = elementKids(mixedSlot).filter(node => String(node.className).includes('collab-contract-row'));
  const mixedTodos = mixedRows.find(row => elementKids(row)[0]?.textContent === '待办');
  expect(
    'PN14 open=3 + blocked=2: the badge says ◑3 and the detail says 3 open (one number, no double count)',
    badgeOf(rowOf('mixed worker'))?.textContent === '◑3' &&
      mixedTodos !== undefined &&
      elementKids(mixedTodos)[1]?.textContent === '3 open · 2 blocked · 0 suspended · 0 drifted',
    JSON.stringify({ badge: badgeOf(rowOf('mixed worker'))?.textContent, detail: elementKids(mixedTodos ?? {})[1]?.textContent })
  );

  // R5: a session without a contract keeps the 0.9.6 pane (no slot at all).
  fireClick(rowOf('plain worker'));
  await sleep(30);
  const plainPane = byClass('collab-detail-pane');
  expect(
    'PN14 no contract: no contract slot, the 0.9.6 order is untouched',
    JSON.stringify(elementKids(plainPane).map(node => String(node.className))) ===
      JSON.stringify([
        'collab-detail-header',
        'collab-detail-section collab-graph-slot',
        'collab-detail-section collab-actions-slot',
        'collab-items'
      ]) && !text().includes('会话契约'),
    JSON.stringify(elementKids(plainPane).map(node => node.className))
  );

  // R2/R3 on the 2 s poll: the contract is re-derived from the new snapshot and
  // the selection (component memory) survives it.
  fireClick(rowOf('drift worker'));
  await sleep(30);
  contractReply = {
    ...CONTRACT,
    at: 2,
    sessions: CONTRACT.sessions.map(session =>
      session.sid === 'ses_ct_drift01'
        ? {
            ...session,
            contract: { todos: { open: 1, blocked: 0, suspended: 0, drifted: 0 } }
          }
        : session
    )
  };
  await sleep(2100);
  const polledBadge = badgeOf(rowOf('drift worker'));
  const polledSlot = findIn(el, node => node.attrs?.['data-collab-slot'] === 'contract');
  const polledRows = elementKids(polledSlot).filter(node => String(node.className).includes('collab-contract-row'));
  expect(
    'PN14 a poll re-derives the badge and the block (drift resolved → ◑1) and keeps the selection',
    polledBadge?.textContent === '◑1' &&
      Boolean(findIn(el, node => String(node.className).includes('collab-session-selected'))) &&
      JSON.stringify(polledRows.map(row => elementKids(row)[0]?.textContent)) === JSON.stringify(['待办']) &&
      !text().includes('连续 6 轮无主线动作'),
    JSON.stringify({ badge: polledBadge?.textContent, rows: polledRows.map(row => row.textContent) })
  );
  dispose();
}

/* -------- 14b. `≤640px`: one pane, the badge still on the row, no wrap ------- */

{
  let viewport = 640;
  globalThis.matchMedia = query => {
    const limit = Number((String(query).match(/max-width:\s*(\d+)px/) ?? [])[1] ?? NaN);
    return {
      get matches() {
        return Number.isFinite(limit) ? viewport <= limit : false;
      },
      addEventListener() {},
      removeEventListener() {}
    };
  };
  viewport = 639;
  const SESSION = serverSession('ses_ct_drift01', 'srv-contract', fakeClient({ reply: CONTRACT }));
  const h = harness(SESSION, { locale: 'zh' });
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(150);
  const el = renderPanel(h, SESSION);
  const byClass = name => findIn(el, node => String(node.className).includes(name));
  const rowOf = title =>
    findIn(el, node => String(node.className).includes('collab-session') && node.textContent.includes(title));
  const badge = findIn(rowOf('drift worker'), node => String(node.className).includes('collab-contract-badge'));
  expect(
    'PN14b 639px: the list is one pane and the badge still ends the row (no wrap rule)',
    Boolean(byClass('collab-sidebar')) &&
      !byClass('collab-detail-pane') &&
      badge?.textContent === '◇' &&
      Boolean(findIn(rowOf('drift worker'), node => String(node.className).includes('collab-row-meta'))),
    JSON.stringify({ badge: badge?.textContent ?? null, text: (el?.textContent ?? '').slice(0, 120) })
  );
  fireClick(rowOf('drift worker'));
  await sleep(30);
  const slot = findIn(el, node => node.attrs?.['data-collab-slot'] === 'contract');
  const rows = (slot?.childNodes ?? [])
    .filter(node => node.nodeType === 1 && String(node.className).includes('collab-contract-row'))
    .map(node => (node.childNodes ?? []).filter(child => child.nodeType === 1));
  expect(
    'PN14b 639px: selecting shows the detail with the contract rows intact (one column, still readable)',
    Boolean(byClass('collab-back')) &&
      rows.length === 5 &&
      rows.every(parts => parts.length === 2 && String(parts[1].className).includes('collab-contract-text')) &&
      rows[4][1].textContent.includes('连续 6 轮无主线动作'),
    JSON.stringify(rows.map(parts => parts[1]?.textContent))
  );
  delete globalThis.matchMedia;
  dispose();
}

/* ---- 15. 0.9.7 decision inbox: top line, read-only list, jump only ---------- */

{
  const DECISION = {
    at: 1_800_000_000_000,
    reachable: true,
    sessions: [
      {
        sid: 'ses_dec_probe',
        title: 'inbox reader',
        agent: 'build',
        busy: false,
        workspace: '/data/project/collab'
      },
      {
        sid: 'ses_owner_dec01',
        title: 'decider',
        agent: 'build',
        busy: false,
        workspace: '/data/project/collab'
      }
    ],
    locks: [],
    handoffs: [],
    queue: [],
    decisions: {
      total: 3,
      conflicts: 1,
      oldestAgeMs: 4.2 * 3_600_000,
      items: [
        {
          key: 't_mwlp0001',
          id: 'D3',
          question: 'dev/prod 键空间是否隔离',
          owner: 'ses_owner_dec01',
          at: 1_800_000_000_000 - 4.2 * 3_600_000,
          ageMs: 4.2 * 3_600_000,
          origin: 'manual'
        },
        {
          key: 'b_1bb1aaaa',
          id: 'D1',
          question: '客户端增量帧的判据',
          owner: 'ses_owner_dec01',
          at: 1_800_000_000_000 - 1.1 * 3_600_000,
          ageMs: 1.1 * 3_600_000,
          origin: 'conflict',
          ttlLeftMs: 22.9 * 3_600_000
        },
        {
          key: 't_mwnm0002',
          id: 'D2',
          question: '是否回退前缀隔离',
          owner: 'human-reviewer',
          at: 1_800_000_000_000 - 18 * 60_000,
          ageMs: 18 * 60_000,
          origin: 'manual'
        }
      ]
    }
  };
  // Every write method is recorded: the inbox must never call one (design §4.1).
  const writes = [];
  const client = {
    rpc: () => ({
      snapshot: async () => DECISION,
      escalate: async () => writes.push('escalate'),
      freeze: async () => writes.push('freeze'),
      unfreeze: async () => writes.push('unfreeze'),
      archive: async () => writes.push('archive')
    })
  };
  const SESSION = serverSession('ses_dec_probe', 'srv-decisions', client);
  const h = harness(SESSION, { locale: 'zh', client });
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(150);
  const el = renderPanel(h, SESSION);
  const text = () => el?.textContent ?? '';
  const byClass = name => findIn(el, node => String(node.className).includes(name));

  expect(
    'PN15 the board top line counts the open decisions and marks conflicts',
    text().includes('待决策 3（⚠1）'),
    JSON.stringify(text().slice(0, 160))
  );
  expect(
    'PN15 the list is folded until the line is clicked (no rows yet)',
    !text().includes('#D3') && !text().includes('#D1'),
    JSON.stringify(text())
  );

  const head = byClass('collab-decisions-head');
  expect('PN15 the top line is a real button', Boolean(head) && head.tagName === 'button', head?.tagName);
  fireClick(head);
  await sleep(30);

  const rowOf = marker =>
    findIn(el, node => String(node.className).includes('collab-decision-row') && node.textContent.includes(marker));
  const manualRow = rowOf('#D3');
  const conflictRow = rowOf('#D1');
  const humanRow = rowOf('#D2');
  expect(
    'PN15 the list renders all three rows, conflict tone + TTL included',
    Boolean(manualRow) &&
      Boolean(conflictRow) &&
      Boolean(humanRow) &&
      text().includes('dev/prod 键空间是否隔离') &&
      text().includes('⚠冲突（TTL 剩 22.9h）') &&
      String(conflictRow?.className).includes('collab-tone-warning'),
    JSON.stringify(text().slice(0, 300))
  );
  expect(
    'PN15 the owner is shortened, a non-session owner reads 人工',
    text().includes('等 ses_owne…') && text().includes('等 人工'),
    JSON.stringify(text().slice(0, 300))
  );
  expect(
    'PN15 a decision without a session is not clickable (a div, with a hover title)',
    humanRow?.tagName === 'div' && humanRow?.attrs?.title === '该决策没有对应会话',
    JSON.stringify({ tag: humanRow?.tagName, title: humanRow?.attrs?.title })
  );
  fireClick(humanRow);
  expect('PN15 clicking 人工 does nothing (no tab, no write)', h.opened.length === 0 && writes.length === 0, JSON.stringify(h.opened));

  expect('PN15 a session decision is a clickable button', manualRow?.tagName === 'button', manualRow?.tagName);
  fireClick(manualRow);
  expect(
    'PN15 clicking it only opens that session tab (tabs.open, focus)',
    h.opened.length === 1 &&
      h.opened[0].id === 'ses_owner_dec01' &&
      h.opened[0].server === 'srv-decisions' &&
      h.opened[0].focus === true,
    JSON.stringify(h.opened)
  );
  expect('PN15 the whole interaction wrote nothing (no RPC write method)', writes.length === 0, JSON.stringify(writes));
  expect(
    'PN15 the list is read-only: no write button inside it',
    !findIn(el, node => ['answer', 'supersede'].some(word => String(node.textContent ?? '').includes(word))),
    JSON.stringify(text().slice(0, 300))
  );

  // A snapshot replaced by the next poll keeps the expanded list (no local reset).
  fireClick(head);
  await sleep(30);
  expect(
    'PN15 clicking the line again folds the list',
    !text().includes('#D3'),
    JSON.stringify(text().slice(0, 160))
  );
  dispose();
}

/* ---- 15b. 0.9.7 review: a bounded scan says 已扫描 M/N, not a fake total ---- */

{
  const DECISION_TRUNCATED = {
    at: 1_800_000_000_000,
    reachable: true,
    sessions: [
      { sid: 'ses_dec_probe', title: 'inbox reader', agent: 'build', busy: false, workspace: '/data/project/collab' }
    ],
    locks: [],
    handoffs: [],
    queue: [],
    decisions: {
      total: 3,
      conflicts: 1,
      oldestAgeMs: 4.2 * 3_600_000,
      truncated: true,
      keys: 5200,
      scannedKeys: 2000,
      items: [
        {
          key: 't_mwlp0001',
          id: 'D3',
          question: 'dev/prod 键空间是否隔离',
          owner: 'ses_owner_dec01',
          at: 1_800_000_000_000 - 4.2 * 3_600_000,
          ageMs: 4.2 * 3_600_000,
          origin: 'manual'
        }
      ]
    }
  };
  const client = { rpc: () => ({ snapshot: async () => DECISION_TRUNCATED }) };
  const SESSION = serverSession('ses_dec_probe', 'srv-decisions', client);
  const h = harness(SESSION, { locale: 'zh', client });
  const dispose = createRoot(disposeRoot => (plugin.setup(h.context), disposeRoot));
  await sleep(150);
  const el = renderPanel(h, SESSION);
  expect(
    'PN15b a bounded ledger scan says 已扫描 M/N in the board count',
    (el?.textContent ?? '').includes('待决策 3（⚠1）（已扫描 2000/5200 key）'),
    JSON.stringify((el?.textContent ?? '').slice(0, 120))
  );
  dispose();
}

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} panel checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAILED: ${check.title}`);
  process.exitCode = 1;
}
