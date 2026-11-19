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
 *      desktop app provides (no bundled copy of Solid or the SDK);
 *   7. 0.4.2: `{ session }` adds that session's own owner-queue items (oldest
 *      first, revoked items out, nobody else's in) and names no session → the
 *      block is empty instead of a scan of every target;
 *   8. 0.4.2: the GUI panel is visible on a first visit (`opened` is an explicit
 *      "open", `list` returns the tab unless `autoOpen:false`) — the deadlock
 *      that hid the sidebar;
 *   9. 0.4.2: `dist/tui.js` exists, imports only host-provided modules, keeps
 *      the panel/slash names, and the package exports `./tui` with OpenTUI peers.
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
  }),
  // 0.6.0 (R3): free, one waiter whose heartbeat is 11 minutes old — still
  // listed (a read view never reaps), but flagged so "1 lease" is not read as
  // "1 holder".
  lease({
    resource: 'named:stale-window',
    holders: [],
    holder: undefined,
    acquiredAt: 0,
    ttlMs: 0,
    expiresAt: 0,
    waiters: [{ sid: 'ses_a3', at: now - 11 * 60_000, mode: 'exclusive' }]
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
    // 0.8.0 (`board2-graph`): a forwarded record — the chain head is `ses_head`,
    // not the hop that sent it. The snapshot must carry it (the graph's dashed
    // `origin` edge is built from the snapshot, never from the record file).
    origin: { sid: 'ses_head', directory: wsB },
    createdAt: now - 120_000
  },
  {
    bid: 'b_00000000b2',
    state: 'open',
    workspace: wsB,
    title: 'beta proposal',
    from: { sid: 'ses_b1', directory: wsB },
    // A single hop: `origin === from` is not a chain and must not be written.
    origin: { sid: 'ses_b1', directory: wsB },
    createdAt: now - 600_000
  },
  {
    bid: 'b_00000000c3',
    state: 'done',
    workspace: wsA,
    title: 'closed already',
    from: { sid: 'ses_a2', directory: wsA },
    createdAt: now - 900_000
  },
  // 0.5.0: an unresolved hand-off whose spawned session was archived (the
  // manual path can archive while the bid is still `claimed`).
  {
    bid: 'b_00000000d4',
    state: 'claimed',
    workspace: wsA,
    title: 'archived claimant',
    from: { sid: 'ses_a2', directory: wsA },
    claim: { by: 'ses_a1', kind: 'spawn' },
    archivedAt: now - 10_000,
    createdAt: now - 30_000
  }
];

// 0.6.0 (`collab_freeze`): live freezes the panel should mark. The expired one
// must be ignored by the view (an expired freeze simply stops existing).
const freezes = [
  {
    scope: 'session',
    target: 'ses_a1',
    reason: 'alpha worker 冻结：等 schema 线确认',
    by: 'ses_a2',
    at: now - 60_000,
    until: now + 600_000
  },
  {
    scope: 'workspace',
    target: wsB,
    reason: 'beta 仓暂停接管',
    by: 'ses_a1',
    at: now - 30_000,
    until: now + 300_000
  },
  {
    scope: 'bid',
    target: 'b_00000000a1',
    reason: '这一单先别改',
    by: 'ses_a1',
    at: now - 10_000,
    until: now + 120_000
  },
  {
    scope: 'session',
    target: 'ses_a2',
    reason: '已过期的冻结',
    by: 'ses_a1',
    at: now - 120_000,
    until: now - 1
  }
];

const source = {
  sessions: async input =>
    sessions.filter(session => (input?.directory ? session.location.directory === input.directory : true)),
  locks: () => records,
  handoffs: () => broadcasts,
  freezes: () => freezes,
  queue: from =>
    [
      {
        id: 'q_1_aaaa',
        target: 'ses_p1',
        from: 'ses_a1',
        at: now - 30_000,
        summary: '请复核这条提案',
        issuePath: 'docs/issues/bugs-x.md',
        bid: null,
        revokedAt: null,
        seenAt: null
      },
      {
        id: 'q_2_bbbb',
        target: 'ses_p2',
        from: 'ses_a1',
        at: now - 600_000,
        summary: '目标已经读到的那条',
        issuePath: null,
        bid: 'b_00000000a1',
        revokedAt: null,
        seenAt: now - 100_000
      },
      {
        id: 'q_3_cccc',
        target: 'ses_p1',
        from: 'ses_other',
        at: now - 1_000,
        summary: '别人的请求',
        issuePath: null,
        bid: null,
        revokedAt: null,
        seenAt: null
      },
      {
        id: 'q_4_dddd',
        target: 'ses_p1',
        from: 'ses_a1',
        at: now - 5_000,
        summary: '已撤回的那条',
        issuePath: null,
        bid: null,
        revokedAt: now - 4_000,
        seenAt: null
      }
    ].filter(item => item.from === from)
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
  'C2 nothing is listed as "my queue" when the caller names no session',
  Array.isArray(snapshot.queue) && snapshot.queue.length === 0,
  JSON.stringify(snapshot.queue)
);
expect(
  'C2 archived sessions are kept with archived:true (the board files them under 已归档), sub-agents keep their parent',
  snapshot.sessions.some(session => session.sid === 'ses_gone' && session.archived === true && !session.busy) &&
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
// 0.6.0 (R3): the waiter heartbeat is a read-only derived field — age, and a
// `[stale]` marker once it is older than the waiter TTL. The row stays.
expect(
  'C2 a queued waiter carries its heartbeat age (read-only, never reaped by the view)',
  held?.waiterAgeMs?.length === 1 && held?.waiterAgeMs[0] === 5_000 && held?.stale !== true,
  JSON.stringify({ waiterAgeMs: held?.waiterAgeMs, stale: held?.stale })
);
const staleWindow = snapshot.locks.find(lock => lock.resource === 'named:stale-window');
expect(
  'C2 a heartbeat older than the waiter TTL is flagged stale and still listed (free, 0 holders)',
  staleWindow?.holders.length === 0 &&
    staleWindow?.stale === true &&
    staleWindow?.staleWaiters?.join(',') === 'ses_a3' &&
    staleWindow?.waiterAgeMs?.[0] >= 11 * 60_000,
  JSON.stringify(staleWindow)
);

/* ------------------------------------------------- 2b. the four numbers (R4) */

// 0.6.0: one definition shared by the GUI header, the TUI sidebar and the TUI
// panel. `held` counts *holders*: the expired `named:build` lease and the free
// `named:stale-window` row are listed but hold nothing, so they must not count.
const { countsOf, pendingCountOf } = built.__internals ?? {};
expect('R4 __internals exports countsOf + pendingCountOf', Boolean(countsOf) && Boolean(pendingCountOf));
const counts = countsOf?.(snapshot) ?? {};
const mineCounts = countsOf?.(await buildSnapshot(source, { session: 'ses_a1' }, now)) ?? {};
expect(
  'R4 countsOf: held = holders>0, waiting = sum of queues, protected = owner-queue length',
  counts.held === 1 && counts.waiting === 3 && counts.protected === 0 &&
    mineCounts.held === 1 && mineCounts.waiting === 3 && mineCounts.protected === 2,
  JSON.stringify({ snapshot: counts, mine: mineCounts })
);
expect(
  'R4 countsOf tolerates an empty / absent snapshot (0 · 0 · 0, never a throw)',
  JSON.stringify(countsOf?.(undefined)) === '{"held":0,"waiting":0,"protected":0}' &&
    JSON.stringify(countsOf?.({ locks: [], queue: [] })) === '{"held":0,"waiting":0,"protected":0}',
  JSON.stringify(countsOf?.(undefined))
);
expect(
  'R4 pendingCountOf reads the host prompt queue and never throws (no API / a throwing host → 0)',
  pendingCountOf?.({ list: () => [{}, {}] }, 'ses_a1') === 2 &&
    pendingCountOf?.(undefined, 'ses_a1') === 0 &&
    pendingCountOf?.({ list: () => undefined }, 'ses_a1') === 0 &&
    pendingCountOf?.(
      {
        list: () => {
          throw new Error('host has no pending queue');
        }
      },
      'ses_a1'
    ) === 0 &&
    pendingCountOf?.({ list: () => [{}] }, '') === 0
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
// 0.5.0: the archive marker is read-only — the row stays, the flag is added.
expect(
  'C2 an archived hand-off carries archived:true (and the row itself stays)',
  snapshot.handoffs.find(handoff => handoff.bid === 'b_00000000d4')?.archived === true &&
    !snapshot.handoffs.find(handoff => handoff.bid === 'b_00000000b2')?.archived,
  JSON.stringify(snapshot.handoffs.find(handoff => handoff.bid === 'b_00000000d4'))
);
// 0.6.0 (board): the spawn relation is additive — `kind` says this record
// pulled a session in, `spawned` names it. Older records simply omit both.
expect(
  'C2 a spawn hand-off carries kind:"spawn" + spawned:<claim.by> (board ↳ relation)',
  snapshot.handoffs.find(handoff => handoff.bid === 'b_00000000d4')?.kind === 'spawn' &&
    snapshot.handoffs.find(handoff => handoff.bid === 'b_00000000d4')?.spawned === 'ses_a1' &&
    !snapshot.handoffs.find(handoff => handoff.bid === 'b_00000000a1')?.kind,
  JSON.stringify(snapshot.handoffs.map(handoff => [handoff.bid, handoff.kind, handoff.spawned]))
);

// 0.8.0 (`board2-graph`): `origin` is the chain head of a forwarded hand-off.
// It is a **snapshot** field (the graph never reads the broadcast record), so
// the passthrough is asserted here on the built payload.
expect(
  'C2 a forwarded hand-off carries origin:<record.origin.sid> (graph `origin` edge)',
  snapshot.handoffs.find(handoff => handoff.bid === 'b_00000000a1')?.origin === 'ses_head' &&
    !snapshot.handoffs.find(handoff => handoff.bid === 'b_00000000d4')?.origin,
  JSON.stringify(snapshot.handoffs.map(handoff => [handoff.bid, handoff.origin]))
);
expect(
  'C2 an origin equal to `from` is omitted (a single hop is not a chain)',
  !snapshot.handoffs.find(handoff => handoff.bid === 'b_00000000b2')?.origin,
  JSON.stringify(snapshot.handoffs.find(handoff => handoff.bid === 'b_00000000b2'))
);

/* ------------------------------------------------- 4b. freeze markers (0.6.0) */

// `collab_freeze` is display-only in the snapshot: a frozen session / hand-off
// keeps its row and gains an optional marker. The expired entry is ignored, an
// ancestor's freeze reaches the sub-session, and a workspace freeze marks both
// its sessions and its hand-offs.
const frozenA1 = snapshot.sessions.find(session => session.sid === 'ses_a1')?.frozen;
const frozenSub = snapshot.sessions.find(session => session.sid === 'ses_sub')?.frozen;
expect(
  'C2 a frozen session carries frozen{scope,until,reason} and its sub-session inherits it',
  frozenA1?.scope === 'session' &&
    frozenA1?.target === 'ses_a1' &&
    frozenA1?.until === now + 600_000 &&
    frozenA1?.reason.includes('alpha worker') &&
    frozenSub?.scope === 'session' &&
    frozenSub?.target === 'ses_a1',
  JSON.stringify({ frozenA1, frozenSub })
);
expect(
  'C2 an expired freeze is not reported (it simply stops existing)',
  !snapshot.sessions.find(session => session.sid === 'ses_a2')?.frozen,
  JSON.stringify(snapshot.sessions.find(session => session.sid === 'ses_a2'))
);
expect(
  'C2 a frozen workspace marks its sessions and its hand-offs',
  snapshot.sessions.find(session => session.sid === 'ses_b1')?.frozen?.scope === 'workspace' &&
    snapshot.handoffs.find(handoff => handoff.bid === 'b_00000000b2')?.freeze?.scope === 'workspace',
  JSON.stringify({
    session: snapshot.sessions.find(session => session.sid === 'ses_b1')?.frozen,
    handoff: snapshot.handoffs.find(handoff => handoff.bid === 'b_00000000b2')?.freeze
  })
);
expect(
  'C2 a frozen bid marks its hand-off (and only that one)',
  snapshot.handoffs.find(handoff => handoff.bid === 'b_00000000a1')?.freeze?.scope === 'bid' &&
    !snapshot.handoffs.find(handoff => handoff.bid === 'b_00000000d4')?.freeze,
  JSON.stringify(snapshot.handoffs.map(handoff => [handoff.bid, handoff.freeze?.scope]))
);
const noFreezeSource = { sessions: source.sessions, locks: source.locks, handoffs: source.handoffs };
const withoutFreezes = await buildSnapshot(noFreezeSource, {}, now);
expect(
  'C2 a source without a freezes reader answers no markers (older server, no crash)',
  withoutFreezes.sessions.every(session => !session.frozen) &&
    withoutFreezes.handoffs.every(handoff => !handoff.freeze)
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

/* ----------------------------------------------------------------- 5. queue */

const mine = await buildSnapshot(source, { session: 'ses_a1' }, now);
expect(
  'C2 { session } lists only my own owner-queue items (revoked out, oldest first)',
  mine.queue.length === 2 && mine.queue[0].queueId === 'q_2_bbbb' && mine.queue[1].queueId === 'q_1_aaaa',
  JSON.stringify(mine.queue.map(item => item.queueId))
);
expect(
  'C2 a queue row carries queueId / target / age / summary and the seen flag',
  mine.queue[0].target === 'ses_p2' &&
    mine.queue[0].ageMs === 600_000 &&
    mine.queue[0].seen === true &&
    mine.queue[0].bid === 'b_00000000a1' &&
    mine.queue[1].seen === false &&
    mine.queue[1].issuePath === 'docs/issues/bugs-x.md' &&
    mine.queue[1].ageMs === 30_000,
  JSON.stringify(mine.queue)
);
expect(
  'C2 somebody else\'s request never appears in my queue',
  mine.queue.every(item => item.target !== 'ses_p1' || item.queueId !== 'q_3_cccc')
);
const noQueue = { sessions: source.sessions, locks: source.locks, handoffs: source.handoffs };
const withoutQueueSource = await buildSnapshot(noQueue, { session: 'ses_a1' }, now);
expect(
  'C2 a source without a queue reader answers an empty queue (older host, no crash)',
  Array.isArray(withoutQueueSource.queue) && withoutQueueSource.queue.length === 0
);

/* ---------------------------------------------------------------- 6. contract */

expect(
  'C2 the RPC definition is portable: one snapshot method, no events',
  CollabState?.id === 'collab.state' &&
    Object.keys(CollabState.methods) .join(',') === 'snapshot' &&
    Object.keys(CollabState.events).length === 0
);
const output = CollabState?.methods?.snapshot?.output ?? {};
expect(
  'C2 the output schema declares every field the panel reads',
  ['at', 'reachable', 'sessions', 'locks', 'handoffs', 'queue'].every(
    key => output.required?.includes(key) && Boolean(output.properties?.[key])
  ) && Boolean(output.properties?.locks?.items?.properties?.waiting)
);
expect(
  'C2 the input schema accepts a session to scope the queue block',
  Boolean(CollabState?.methods?.snapshot?.input?.properties?.session) &&
    !CollabState?.methods?.snapshot?.input?.required?.includes('session'),
  JSON.stringify(CollabState?.methods?.snapshot?.input)
);
expect(
  'C2 a queue row declares queueId / target / ageMs / summary / seen',
  ['queueId', 'target', 'ageMs', 'summary', 'seen'].every(key =>
    output.properties?.queue?.items?.required?.includes(key)
  )
);
expect(
  'C2 the hand-off row declares the optional archived marker (0.5.0)',
  Boolean(output.properties?.handoffs?.items?.properties?.archived) &&
    !output.properties?.handoffs?.items?.required?.includes('archived'),
  JSON.stringify(output.properties?.handoffs?.items?.properties)
);
// 0.6.0 (board): all three new fields are optional, so an older server's answer
// stays valid and no consumer may assume they exist.
expect(
  'C2 the session/hand-off rows declare optional archived / kind / spawned (board, 0.6.0)',
  Boolean(output.properties?.sessions?.items?.properties?.archived) &&
    !output.properties?.sessions?.items?.required?.includes('archived') &&
    Boolean(output.properties?.handoffs?.items?.properties?.kind) &&
    Boolean(output.properties?.handoffs?.items?.properties?.spawned) &&
    !output.properties?.handoffs?.items?.required?.includes('kind') &&
    !output.properties?.handoffs?.items?.required?.includes('spawned'),
  JSON.stringify({
    session: output.properties?.sessions?.items?.properties?.archived,
    handoff: [
      output.properties?.handoffs?.items?.properties?.kind,
      output.properties?.handoffs?.items?.properties?.spawned
    ]
  })
);
// 0.6.0 (`collab_freeze`): both markers are optional — an older server's answer
// stays valid, and a consumer must tolerate their absence.
expect(
  'C2 the session row declares optional frozen and the hand-off row optional freeze (0.6.0)',
  Boolean(output.properties?.sessions?.items?.properties?.frozen) &&
    !output.properties?.sessions?.items?.required?.includes('frozen') &&
    Boolean(output.properties?.handoffs?.items?.properties?.freeze) &&
    !output.properties?.handoffs?.items?.required?.includes('freeze'),
  JSON.stringify({
    session: output.properties?.sessions?.items?.properties?.frozen,
    handoff: output.properties?.handoffs?.items?.properties?.freeze
  })
);
expect(
  'C2 the lock row declares optional waiterAgeMs / staleWaiters / stale (0.6.0)',
  Boolean(output.properties?.locks?.items?.properties?.waiterAgeMs) &&
    Boolean(output.properties?.locks?.items?.properties?.staleWaiters) &&
    Boolean(output.properties?.locks?.items?.properties?.stale) &&
    ['waiterAgeMs', 'staleWaiters', 'stale'].every(
      key => !output.properties?.locks?.items?.required?.includes(key)
    ),
  JSON.stringify(output.properties?.locks?.items?.properties)
);

/* ------------------------------------------------------------- 7. GUI bundle */

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
  expect(
    'C2 the GUI bundle carries the default-visible rule (not the old open-only one)',
    /autoOpen/.test(bundle)
  );
}

/* --------------------------------------------- 8. GUI first-visit deadlock */

// Static, because the window half needs a desktop app: the two rules that hid
// the panel were "undefined counts as open" and "only list an already-open tab".
const guiSource = readFileSync(resolve(import.meta.dirname, '../src/gui.tsx'), 'utf8');
expect(
  'C2 GUI treats only an explicit "open" as open (a first visit is not open)',
  guiSource.includes("=== 'open'") && !guiSource.includes("!== 'closed'")
);
expect(
  'C2 GUI lists the panel by default, and autoOpen:false restores the + menu only',
  /autoOpen\s*!==\s*false/.test(guiSource) && /autoOpen \|\| input\.open\.includes\(PANEL_TAB\)/.test(guiSource)
);

/* ---------------------------------------------------------------- 9. TUI half */

const tuiEntry = resolve(import.meta.dirname, '../dist/tui.js');
const hasTui = existsSync(tuiEntry);
expect('C2 dist/tui.js exists', hasTui, tuiEntry);
if (hasTui) {
  const bundle = readFileSync(tuiEntry, 'utf8');
  const imported = [...bundle.matchAll(/from\s+"([^"]+)"/g)].map(match => match[1]);
  expect(
    'C2 the TUI bundle imports only modules the host provides',
    imported.length > 0 && imported.every(name => /^(@opencode\/|@opentui\/|solid-js(\/|$))/.test(name)),
    imported.join(', ')
  );
  expect(
    'C2 the TUI bundle declares the panel, the slash command and both slots',
    bundle.includes('collab.status') &&
      bundle.includes('collab.tui') &&
      bundle.includes('session.panel') &&
      bundle.includes('sidebar.content') &&
      bundle.includes('ctrl+shift+l')
  );
  expect(
    'C2 the TUI bundle has no write path (no lock/unlock/prompt call)',
    !/collab_unlock|session\.prompt|\.prompt\(/.test(bundle)
  );
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'));
  expect(
    'C2 package exports ./tui and lists the OpenTUI peers',
    pkg.exports?.['./tui'] === './dist/tui.js' &&
      Boolean(pkg.peerDependencies?.['@opentui/core']) &&
      Boolean(pkg.peerDependencies?.['@opentui/solid']) &&
      Boolean(pkg.peerDependencies?.['solid-js']),
    JSON.stringify(pkg.peerDependencies)
  );
}

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAIL: ${check.title}`);
  process.exit(1);
}
process.exit(0);
