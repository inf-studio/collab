/**
 * C2 (0.3.0): the sidebar's read-only snapshot.
 *
 *   pnpm --filter=@inf-studio/collab test     # builds dist/ first
 *
 * The sidebar must never disagree with `collab_locks` / `collab_list`, and it
 * must never move the state it displays. Both are checked here against the
 * built `dist/index.js` with **injected** readers (no host, no real
 * `~/.config/opencode/collab-*` directory):
 *
 *   1. the payload is the `collab.state.snapshot` shape (R2/RPC) and says
 *      `reachable: true` when the server answers;
 *   2. a lease renders exactly what `stateOf` renders: holders, mode, remaining
 *      TTL (floored at 0) and the FIFO queue;
 *   3. an **expired** lease reads `free` (reaped in the view, not on disk) and a
 *      free lease nobody waits for is left out — the panel lists activity, not
 *      empty records;
 *   4. a decided hand-off (`done` / `blocked` / `expired`) is not "未闭环";
 *      an open one is, with its age and its claimant;
 *   5. `{ workspace }` narrows sessions and hand-offs;
 *   6. the RPC definition is portable (`id` + one method, no events) and the
 *      GUI bundle `./gui-experimental` exists and requires only the modules the
 *      desktop app provides (no bundled copy of Solid or the SDK).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const entry = resolve(import.meta.dirname, '../dist/index.js');
const built = await import(`file://${entry}`);
const { buildSnapshot, CollabState } = built.__internals ?? {};

const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};

const now = 1_800_000_000_000;
const wsA = '/data/project/alpha';
const wsB = '/data/project/beta';

const sessions = [
  { id: 'ses_a1', agent: 'build', title: 'alpha worker', location: { directory: wsA }, time: { busy: 1 } },
  { id: 'ses_a2', agent: 'explore', title: 'alpha reader', location: { directory: wsA } },
  { id: 'ses_b1', agent: 'build', title: 'beta worker', location: { directory: wsB }, time: { busy: 1, idle: 2 } },
  { id: 'ses_gone', agent: 'build', title: 'archived', location: { directory: wsA }, time: { archived: 1 } },
  { id: 'ses_sub', agent: 'build', title: 'sub', parentID: 'ses_a1', location: { directory: wsA } }
];

const lease = (over = {}) => ({
  resource: 'named:test-window',
  kind: 'named',
  mode: 'exclusive',
  holder: 'ses_a1',
  holders: ['ses_a1'],
  acquiredAt: now - 60_000,
  ttlMs: 900_000,
  expiresAt: now + 840_000,
  waiters: [],
  history: [],
  ...over
});

const records = [
  // held by a listed session, with one waiter
  lease({
    waiters: [{ sid: 'ses_a2', at: now - 5_000, mode: 'exclusive' }]
  }),
  // expired 5 minutes ago: the *view* must read free (reaped in memory, never
  // written back), and the queue behind it still shows
  lease({
    resource: 'named:build',
    kind: 'build',
    holder: 'ses_b1',
    holders: ['ses_b1'],
    acquiredAt: now - 3_600_000,
    expiresAt: now - 300_000,
    waiters: [{ sid: 'ses_b1', at: now - 240_000, mode: 'exclusive' }]
  }),
  // free, nobody waiting: not worth a row
  lease({
    resource: 'named:free-noise',
    holders: [],
    holder: undefined,
    acquiredAt: 0,
    ttlMs: 0,
    expiresAt: 0
  })
];

const broadcasts = [
  {
    bid: 'b_00000000a1',
    state: 'claimed',
    workspace: wsA,
    title: 'alpha proposal',
    from: { sid: 'ses_a2', directory: wsA },
    claim: { by: 'ses_a1', kind: 'local' },
    createdAt: now - 120_000
  },
  {
    bid: 'b_00000000b2',
    state: 'open',
    workspace: wsB,
    title: 'beta proposal',
    from: { sid: 'ses_b1', directory: wsB },
    createdAt: now - 600_000
  },
  {
    bid: 'b_00000000c3',
    state: 'done',
    workspace: wsA,
    title: 'closed already',
    from: { sid: 'ses_a2', directory: wsA },
    createdAt: now - 900_000
  }
];

const source = {
  sessions: async input =>
    sessions.filter(session => (input?.directory ? session.location.directory === input.directory : true)),
  locks: () => records,
  handoffs: () => broadcasts
};

/* ---------------------------------------------------------------- 1. payload */

expect('C2 __internals exports buildSnapshot + CollabState', Boolean(buildSnapshot) && Boolean(CollabState));
const snapshot = await buildSnapshot(source, {}, now);
expect('C2 snapshot is reachable and stamped', snapshot.reachable === true && snapshot.at === now);
expect(
  'C2 snapshot has sessions / locks / handoffs arrays',
  Array.isArray(snapshot.sessions) && Array.isArray(snapshot.locks) && Array.isArray(snapshot.handoffs)
);
expect(
  'C2 archived sessions are left out, sub-agents keep their parent',
  snapshot.sessions.every(session => session.sid !== 'ses_gone') &&
    snapshot.sessions.some(session => session.sid === 'ses_sub' && session.parent === 'ses_a1')
);
expect(
  'C2 busy comes from the host clock (busy > idle)',
  snapshot.sessions.find(s => s.sid === 'ses_a1')?.busy === true &&
    snapshot.sessions.find(s => s.sid === 'ses_b1')?.busy === false &&
    snapshot.sessions.find(s => s.sid === 'ses_a2')?.busy === false
);

/* ------------------------------------------------------------------ 2. leases */

const held = snapshot.locks.find(lock => lock.resource === 'named:test-window');
expect(
  'C2 held lease carries handlers, mode, remaining TTL and the queue',
  held?.holders.join(',') === 'ses_a1' &&
    held?.mode === 'exclusive' &&
    held?.expiresInMs === 840_000 &&
    held?.waiters === 1 &&
    held?.waiting.join(',') === 'ses_a2',
  JSON.stringify(held)
);
const expired = snapshot.locks.find(lock => lock.resource === 'named:build');
expect(
  'C2 an expired lease reads free with no remaining TTL (and keeps its queue)',
  expired && expired.holders.length === 0 && expired.expiresInMs === 0 && expired.waiting.join(',') === 'ses_b1',
  JSON.stringify(expired)
);
expect(
  'C2 a free lease nobody waits for is not listed',
  !snapshot.locks.some(lock => lock.resource === 'named:free-noise')
);

/* ---------------------------------------------------------------- 3. handoffs */

expect(
  'C2 a decided hand-off is not "open"',
  !snapshot.handoffs.some(handoff => handoff.bid === 'b_00000000c3')
);
const claimed = snapshot.handoffs.find(handoff => handoff.bid === 'b_00000000a1');
expect(
  'C2 an open hand-off carries age, requester and claimant',
  claimed?.state === 'claimed' && claimed?.ageMs === 120_000 && claimed?.from === 'ses_a2' && claimed?.claimBy === 'ses_a1',
  JSON.stringify(claimed)
);
expect(
  'C2 hand-offs are oldest first (the one waiting longest leads)',
  snapshot.handoffs[0]?.bid === 'b_00000000b2'
);

/* ------------------------------------------------------- 4. workspace filter */

const onlyBeta = await buildSnapshot(source, { workspace: wsB }, now);
expect(
  'C2 { workspace } narrows sessions and hand-offs',
  onlyBeta.sessions.every(session => session.workspace === wsB) &&
    onlyBeta.handoffs.every(handoff => handoff.workspace === wsB) &&
    onlyBeta.handoffs.length === 1,
  `${onlyBeta.sessions.length} sessions / ${onlyBeta.handoffs.length} hand-offs`
);

/* ---------------------------------------------------------------- 5. contract */

expect(
  'C2 the RPC definition is portable: one snapshot method, no events',
  CollabState?.id === 'collab.state' &&
    Object.keys(CollabState.methods) .join(',') === 'snapshot' &&
    Object.keys(CollabState.events).length === 0
);
const output = CollabState?.methods?.snapshot?.output ?? {};
expect(
  'C2 the output schema declares every field the panel reads',
  ['at', 'reachable', 'sessions', 'locks', 'handoffs'].every(
    key => output.required?.includes(key) && Boolean(output.properties?.[key])
  ) && Boolean(output.properties?.locks?.items?.properties?.waiting)
);

/* ------------------------------------------------------------- 6. GUI bundle */

const guiEntry = resolve(import.meta.dirname, '../dist/gui-experimental.cjs');
const hasGui = existsSync(guiEntry);
expect('C2 dist/gui-experimental.cjs exists', hasGui, guiEntry);
if (hasGui) {
  const bundle = readFileSync(guiEntry, 'utf8');
  const required = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]).sort();
  const allowed = ['@opencode/plugin/gui', 'solid-js', 'solid-js/store', 'solid-js/web'];
  expect(
    'C2 the GUI bundle requires only modules the desktop app provides',
    required.every(name => allowed.includes(name)),
    required.join(', ')
  );
  expect(
    'C2 the GUI bundle defines the plugin with a window setup and copy, no electron',
    /setup\(/.test(bundle) && /i18n:/.test(bundle) && !/require\("electron"\)/.test(bundle)
  );
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'));
  expect(
    'C2 package exports ./gui-experimental and ships dist',
    pkg.exports?.['./gui-experimental'] === './dist/gui-experimental.cjs' && pkg.files?.includes('dist'),
    JSON.stringify(pkg.exports)
  );
}

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAIL: ${check.title}`);
  process.exit(1);
}
process.exit(0);
