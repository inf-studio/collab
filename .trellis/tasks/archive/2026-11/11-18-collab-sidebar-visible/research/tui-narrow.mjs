/**
 * Independent probe (check agent) — TUI narrow terminal + empty state (R5).
 *   cd /data/project/collab && node --conditions=browser /tmp/collab-check/tui-narrow.mjs
 *
 * EVIDENCE COPY (check agent). Run from /tmp/collab-check with jsdom + symlinked
 * node_modules (`npm i --no-save jsdom`, then symlink solid-js/@opencode/@opentui),
 * e.g. `cd /data/project/collab && node --conditions=browser /tmp/collab-check/tui-probe.mjs`.
 * See check-report.md for the exact commands and outputs.
 */
import { createComponent, testRender } from '@opentui/solid';
import { PluginContextProvider } from '@opencode/plugin/tui';

const plugin = (await import('file:///data/project/collab/dist/tui.js')).default;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};

const FULL = {
  at: 1_800_000_000_000,
  reachable: true,
  sessions: [],
  locks: [
    { resource: 'named:test-window', kind: 'named', mode: 'exclusive', holders: ['ses_probe'], waiters: 2, waiting: ['ses_b', 'ses_c'], expiresInMs: 720_000 },
    { resource: 'path:/tmp/x', kind: 'path', mode: 'shared', holders: ['ses_a', 'ses_b'], waiters: 0, waiting: [], expiresInMs: 30_000 }
  ],
  handoffs: [
    { bid: 'b_aaaaaaaaaaaaaaa1', state: 'open', ageMs: 120_000, from: 'ses_other', title: 't1' },
    { bid: 'b_aaaaaaaaaaaaaaa2', state: 'claimed', ageMs: 3_600_000, from: 'ses_third', title: 't2' }
  ],
  queue: [
    { queueId: 'q_1_aaaa', target: 'ses_protected', ageMs: 30_000, summary: 's', seen: false },
    { queueId: 'q_1_bbbb', target: 'ses_prot2', ageMs: 90_000, summary: 's', seen: true }
  ]
};
const EMPTY = { at: 1_800_000_000_000, reachable: true, sessions: [], locks: [], handoffs: [], queue: [] };

function harness(reply) {
  const slots = {};
  const ctx = {
    options: {}, location: { directory: '/data/project/collab' }, app: { version: 'probe' },
    client: { rpc: () => ({ snapshot: async () => reply }) },
    data: { session: { list: () => [], status: () => 'idle' } },
    theme: { text: { base: '#fff', muted: '#888', feedback: {} } },
    keymap: { layer: () => {} },
    ui: { slot: claim => { slots[claim.append] = claim.render; return () => {}; }, panel: { open: () => true }, toast: { show: () => {} } }
  };
  return { ctx, slots };
}
const panelInput = over => ({
  name: 'collab.status', sessionID: 'ses_probe', width: 72, presentation: 'panel',
  focused: true, focus: () => {}, close: () => {}, toggleFullscreen: () => {}, ...over
});
async function mount(context, render, size) {
  const setup = await testRender(
    () => createComponent(PluginContextProvider, { value: context, get children() { return render(); } }),
    size
  );
  await sleep(120);
  await setup.renderOnce();
  return { setup, frame: await setup.captureCharFrame() };
}

/* narrow: width 40 (2-line rows), width 20 (clamped to 24), width undefined */
for (const width of [40, 20, undefined]) {
  const h = harness(FULL);
  const cleanup = await plugin.setup(h.ctx);
  let thrown;
  let mounted;
  try {
    mounted = await mount(h.ctx, () => h.slots['session.panel'](panelInput({ width })), { width: 44, height: 30 });
  } catch (error) {
    thrown = error;
  }
  const frame = mounted?.frame ?? '';
  const longest = Math.max(...frame.split('\n').map(line => line.length));
  expect(
    `C1 width=${width ?? 'undefined'} renders without throwing and stays inside the frame`,
    !thrown && longest <= 44,
    thrown ? String(thrown).slice(0, 140) : `longest line ${longest}`
  );
  expect(`C1 width=${width ?? 'undefined'} keeps resource / bid / queueId visible`, frame.includes('named:test-window') && frame.includes('b_aaaaaaaaaaaaa') && frame.includes('q_1_aaaa'));
  await mounted?.setup.dispose();
  await cleanup();
}

/* empty state: three explicit empty labels, nothing throws */
const empty = harness(EMPTY);
const emptyCleanup = await plugin.setup(empty.ctx);
const emptyMount = await mount(empty.ctx, () => empty.slots['session.panel'](panelInput()), { width: 80, height: 30 });
expect(
  'C2 empty state names all three blocks instead of an empty pane',
  ['资源租约 (0)', '未闭环交接 (0)', '受保护目标队列 (0)'].every(label => emptyMount.frame.includes(label)) &&
    emptyMount.frame.includes('（无租约）') && emptyMount.frame.includes('（无交接）') && emptyMount.frame.includes('（无排队）'),
  emptyMount.frame.split('\n').filter(line => line.includes('无')).join(' | ')
);
const emptySide = await mount(empty.ctx, () => empty.slots['sidebar.content']({ sessionID: 'ses_probe' }), { width: 40, height: 4 });
expect('C2 the empty sidebar reads 锁 0 · 交接 0 · 队列 0', emptySide.frame.includes('锁 0 · 交接 0 · 队列 0'), emptySide.frame.trim());
await emptySide.setup.dispose();
await emptyMount.setup.dispose();
await emptyCleanup();

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) { for (const check of failed) console.log(`FAIL: ${check.title}`); process.exit(1); }
process.exit(0);
