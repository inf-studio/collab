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
  const toasts = [];
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
    toast: {
      show: toast => {
        // Recorded, never rendered: the panel has no button to click and no
        // write it could make (R5) — a toast is the only thing it says out loud.
        toasts.push(toast);
        return { dismiss() {} };
      }
    },
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
  return { context, registered, setCurrent, toasts };
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
  const event = { type: 'click', target, cancelBubble: false };
  for (const listener of documentStub.listeners.get('click') ?? []) listener(event);
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

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} panel checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAILED: ${check.title}`);
  process.exitCode = 1;
}
