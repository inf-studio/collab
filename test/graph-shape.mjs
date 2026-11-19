/**
 * 0.8.0 (`board2-graph`): the pure three-level relation derivation both panels
 * render (`src/core/graph.ts`).
 *
 *   node test/graph-shape.mjs        # `pnpm test` runs it after the build
 *
 * `buildGraph(snapshot, freezes, { level })` has no host, no file and no clock
 * of its own: the fixture is the whole world. Checked here:
 *
 *   1. L0 (`global`): workspaces are the nodes; cross-workspace hand-offs are
 *      merged into one edge per workspace pair with a `count`; a same-workspace
 *      hand-off never becomes a self edge;
 *   2. L1 (`workspace`): that workspace's sessions, plus one **workspace** node
 *      for the other side of an edge that leaves it (never the counterpart's
 *      sessions — that level is not expanded);
 *   3. L2 (`session`): the selected session ±1 hop, direction and kind of every
 *      edge (`handoff` / `origin` / `spawn` / `subagent`), and the
 *      `GRAPH_NODE_LIMIT` cap with its `truncated` count (the `+N` marker);
 *   4. determinism (R4): two builds of one snapshot are byte-identical, nodes
 *      sorted by id and edges by `from + kind + to`;
 *   5. read-only (R5): hashing every file of a temp workspace before and after
 *      all three levels proves the derivation wrote nothing;
 *   6. an absent snapshot / unknown session is an empty (or single-node) graph,
 *      never a throw.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const entry = resolve(import.meta.dirname, '../dist/index.js');
const built = await import(`file://${entry}`);
const { buildGraph, buildSnapshot } = built.__internals ?? {};

const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};

expect('GR __internals exports buildGraph', typeof buildGraph === 'function');

const now = 1_800_000_000_000;
const wsA = '/data/project/alpha';
const wsB = '/data/project/beta';

const snapshot = {
  at: now,
  reachable: true,
  sessions: [
    { sid: 'ses_a1', title: 'alpha worker', agent: 'build', busy: true, workspace: wsA },
    { sid: 'ses_a2', title: 'alpha reader', agent: 'explore', busy: false, workspace: wsA },
    { sid: 'ses_child', title: 'child worker', agent: 'build', busy: true, workspace: wsA, parent: 'ses_a1' },
    { sid: 'ses_old', title: 'old worker', agent: 'build', busy: false, workspace: wsA, archived: true },
    { sid: 'ses_b1', title: 'beta worker', agent: 'build', busy: false, workspace: wsB }
  ],
  locks: [],
  handoffs: [
    // A cross-workspace hand-off pair (two records, same direction → count 2).
    {
      bid: 'b_cross_one',
      state: 'claimed',
      ageMs: 1_000,
      from: 'ses_a1',
      claimBy: 'ses_b1',
      workspace: wsB,
      title: 'cross one'
    },
    {
      bid: 'b_cross_two',
      state: 'claimed',
      ageMs: 2_000,
      from: 'ses_a2',
      claimBy: 'ses_b1',
      workspace: wsB,
      title: 'cross two'
    },
    // A spawn inside alpha: `↳`, never a second `handoff` edge to the same pair.
    {
      bid: 'b_spawn',
      state: 'claimed',
      ageMs: 3_000,
      from: 'ses_a1',
      claimBy: 'ses_child',
      spawned: 'ses_child',
      kind: 'spawn',
      workspace: wsA,
      title: 'spawn the child'
    },
    // A forwarded record whose chain head (`origin`) is not a listed session.
    // `SnapshotHandoff.origin` is the string `toHandoff` writes today; the
    // object-shaped legacy form is asserted separately below.
    {
      bid: 'b_forward',
      state: 'claimed',
      ageMs: 4_000,
      from: 'ses_a2',
      claimBy: 'ses_a1',
      origin: 'ses_head',
      workspace: wsA,
      title: 'forwarded'
    }
  ],
  queue: []
};

/* ------------------------------------------------------------------- L0 global */

const global = buildGraph(snapshot, [], { level: 'global', now });
const wsNodes = global.nodes.filter(node => node.kind === 'workspace');

expect(
  'GR L0 global: workspace nodes (alpha + beta), sessions are not nodes',
  global.nodes.length === 2 &&
    wsNodes.length === 2 &&
    global.nodes.some(node => node.id === wsA && node.label === 'alpha') &&
    global.nodes.some(node => node.id === wsB && node.label === 'beta') &&
    !global.nodes.some(node => node.id.startsWith('ses_')),
  JSON.stringify(global.nodes)
);
expect(
  'GR L0 global: cross-workspace hand-offs merge into one counted edge alpha → beta',
  global.edges.length === 1 &&
    global.edges[0].from === wsA &&
    global.edges[0].to === wsB &&
    global.edges[0].kind === 'handoff' &&
    global.edges[0].count === 2,
  JSON.stringify(global.edges)
);
expect(
  'GR L0 global: no self edge for the same-workspace spawn/hand-off',
  global.edges.every(edge => edge.from !== edge.to),
  JSON.stringify(global.edges)
);

/* --------------------------------------------------------------- L1 workspace */

const alphaLevel = buildGraph(snapshot, [], { level: 'workspace', workspace: wsA, now });
const alphaSessions = alphaLevel.nodes.filter(node => node.kind === 'session').map(node => node.id);
const ghost = alphaLevel.nodes.filter(node => node.kind === 'workspace');

expect(
  'GR L1 workspace: the four alpha sessions (archived included) are the session nodes',
  JSON.stringify(alphaSessions.sort()) === JSON.stringify(['ses_a1', 'ses_a2', 'ses_child', 'ses_old'].sort()),
  JSON.stringify(alphaSessions)
);
expect(
  'GR L1 workspace: an edge that leaves the workspace lands on ONE beta workspace node',
  ghost.length === 1 && ghost[0].id === wsB && ghost[0].kind === 'workspace' && ghost[0].label === 'beta',
  JSON.stringify(ghost)
);
expect(
  'GR L1 workspace: no beta session node is expanded (only the workspace placeholder)',
  !alphaLevel.nodes.some(node => node.id === 'ses_b1'),
  JSON.stringify(alphaLevel.nodes.map(node => node.id))
);
const toGhost = alphaLevel.edges.filter(edge => edge.to === wsB);
expect(
  'GR L1 workspace: both cross hand-offs point at the beta workspace node (direction kept)',
  toGhost.length === 2 &&
    toGhost.every(edge => edge.kind === 'handoff') &&
    toGhost.some(edge => edge.from === 'ses_a1') &&
    toGhost.some(edge => edge.from === 'ses_a2'),
  JSON.stringify(toGhost)
);
expect(
  'GR L1 workspace: same-workspace spawn + subagent + hand-off edges stay session → session',
  alphaLevel.edges.some(edge => edge.from === 'ses_a1' && edge.to === 'ses_child' && edge.kind === 'spawn') &&
    alphaLevel.edges.some(edge => edge.from === 'ses_a1' && edge.to === 'ses_child' && edge.kind === 'subagent') &&
    alphaLevel.edges.some(edge => edge.from === 'ses_a2' && edge.to === 'ses_a1' && edge.kind === 'handoff'),
  JSON.stringify(alphaLevel.edges)
);

/* ----------------------------------------------------------------- L2 session */

const centre = buildGraph(snapshot, [], { level: 'session', session: 'ses_a1', now });
const centreIds = centre.nodes.map(node => node.id).sort();
expect(
  'GR L2 session: centre + its direct neighbours only (±1 hop)',
  JSON.stringify(centreIds) === JSON.stringify(['ses_a1', 'ses_a2', 'ses_b1', 'ses_child']),
  JSON.stringify(centreIds)
);
const find = (view, from, to, kind) =>
  view.edges.find(edge => edge.from === from && edge.to === to && edge.kind === kind);

expect(
  'GR L2 session: handoff direction is from → claimBy (a1 → b1)',
  Boolean(find(centre, 'ses_a1', 'ses_b1', 'handoff')),
  JSON.stringify(centre.edges)
);
expect(
  'GR L2 session: a spawn record yields ONE spawn edge (a1 → child), not a handoff copy',
  Boolean(find(centre, 'ses_a1', 'ses_child', 'spawn')) &&
    !find(centre, 'ses_a1', 'ses_child', 'handoff'),
  JSON.stringify(centre.edges.filter(edge => edge.to === 'ses_child'))
);
expect(
  'GR L2 session: parent → child is a subagent edge (a1 → child)',
  Boolean(find(centre, 'ses_a1', 'ses_child', 'subagent')),
  JSON.stringify(centre.edges)
);
expect(
  'GR L2 session: the incoming hand-off keeps its direction (a2 → a1)',
  Boolean(find(centre, 'ses_a2', 'ses_a1', 'handoff')),
  JSON.stringify(centre.edges)
);
expect(
  'GR L2 session: an origin edge is head → from and dashed-worthy (kind origin)',
  (() => {
    const forwarded = buildGraph(snapshot, [], { level: 'session', session: 'ses_a2', now });
    return Boolean(find(forwarded, 'ses_head', 'ses_a2', 'origin'));
  })(),
  JSON.stringify(buildGraph(snapshot, [], { level: 'session', session: 'ses_a2', now }).edges)
);
expect(
  'GR a legacy object-shaped origin (an older remote payload) still draws the edge',
  (() => {
    const legacy = {
      ...snapshot,
      handoffs: snapshot.handoffs.map(handoff =>
        handoff.bid === 'b_forward' ? { ...handoff, origin: { sid: 'ses_head' } } : handoff
      )
    };
    return Boolean(find(buildGraph(legacy, [], { level: 'session', session: 'ses_a2', now }), 'ses_head', 'ses_a2', 'origin'));
  })()
);
expect(
  'GR L2 session: a node that was dropped by the ±1 hop cap keeps its own edges out',
  !centre.edges.some(edge => edge.to === 'ses_head' || edge.from === 'ses_head'),
  JSON.stringify(centre.edges)
);
expect(
  'GR L2 session: archived neighbours keep their [archived] marker',
  (() => {
    const view = buildGraph(snapshot, [], { level: 'session', session: 'ses_old', now });
    return view.nodes.some(node => node.id === 'ses_old' && node.archived === true);
  })(),
  JSON.stringify(buildGraph(snapshot, [], { level: 'session', session: 'ses_old', now }).nodes)
);
expect(
  'GR L2 session: urgent / frozen markers come from the same snapshot (no second rule)',
  (() => {
    const view = buildGraph(
      {
        ...snapshot,
        sessions: snapshot.sessions.map(session =>
          session.sid === 'ses_a1'
            ? { ...session, frozen: { scope: 'session', target: 'ses_a1', until: now + 60_000, reason: '等 schema 线' } }
            : session
        ),
        handoffs: snapshot.handoffs.map(handoff =>
          handoff.bid === 'b_cross_one' ? { ...handoff, priority: 'urgent' } : handoff
        )
      },
      [],
      { level: 'session', session: 'ses_a1', now }
    );
    const a1 = view.nodes.find(node => node.id === 'ses_a1');
    return a1?.frozen?.reason === '等 schema 线' && a1?.urgent === true;
  })(),
  'frozen + urgent on the centre'
);

/* ------------------------------------ L2 origin edge from a REAL snapshot ----- */

// The origin edge must exist on the **production path**: `buildSnapshot` →
// `toHandoff` → `SnapshotHandoff.origin` → `buildGraph`. A fixture that pastes
// `origin` onto a hand-written snapshot would prove nothing about that path
// (that was the review finding R-3).
const realSource = {
  sessions: async () => [
    { id: 'ses_real_a', agent: 'build', title: 'real requester', location: { directory: wsA } },
    { id: 'ses_real_b', agent: 'build', title: 'real claimant', location: { directory: wsA } }
  ],
  locks: () => [],
  handoffs: () => [
    {
      bid: 'b_real_origin',
      state: 'claimed',
      workspace: wsA,
      title: 'forwarded for real',
      from: { sid: 'ses_real_a', directory: wsA },
      claim: { by: 'ses_real_b', kind: 'local' },
      origin: { sid: 'ses_real_head', directory: wsB },
      createdAt: now - 1_000
    }
  ]
};
expect('GR __internals exports buildSnapshot (the production path fixture)', typeof buildSnapshot === 'function');
const realSnapshot = await buildSnapshot(realSource, {}, now);
expect(
  'GR a real snapshot carries handoff.origin (toHandoff passthrough)',
  realSnapshot.handoffs.find(handoff => handoff.bid === 'b_real_origin')?.origin === 'ses_real_head',
  JSON.stringify(realSnapshot.handoffs)
);
const realView = buildGraph(realSnapshot, [], { level: 'session', session: 'ses_real_a', now });
expect(
  'GR a real snapshot yields the origin edge head → from (not just a hand-written fixture)',
  Boolean(find(realView, 'ses_real_head', 'ses_real_a', 'origin')),
  JSON.stringify(realView.edges)
);

/* ------------------------------------------------------- L2 node cap (`+N`) */

const crowd = {
  at: now,
  reachable: true,
  sessions: [
    { sid: 'ses_center', title: 'centre', agent: 'build', busy: true, workspace: wsA },
    ...Array.from({ length: 12 }, (_, index) => ({
      sid: `ses_n${String(index).padStart(2, '0')}`,
      title: `neighbour ${index}`,
      agent: 'build',
      busy: false,
      workspace: wsA
    }))
  ],
  locks: [],
  handoffs: Array.from({ length: 12 }, (_, index) => ({
    bid: `b_crowd_${String(index).padStart(2, '0')}`,
    state: 'claimed',
    ageMs: 1_000,
    from: 'ses_center',
    claimBy: `ses_n${String(index).padStart(2, '0')}`,
    workspace: wsA,
    title: 'crowd'
  })),
  queue: []
};
const capped = buildGraph(crowd, [], { level: 'session', session: 'ses_center', now });
expect(
  'GR L2 cap: at most 8 nodes, the centre always kept, the rest reported as truncated',
  capped.nodes.length === 8 && capped.truncated === 5 && capped.nodes.some(node => node.id === 'ses_center'),
  JSON.stringify({ nodes: capped.nodes.length, truncated: capped.truncated })
);
expect(
  'GR L2 cap: the centre + the first seven neighbour ids are kept (deterministic truncation)',
  JSON.stringify(
    capped.nodes
      .map(node => node.id)
      .filter(id => id !== 'ses_center')
      .sort()
  ) ===
    JSON.stringify(['ses_n00', 'ses_n01', 'ses_n02', 'ses_n03', 'ses_n04', 'ses_n05', 'ses_n06']),
  JSON.stringify(capped.nodes.map(node => node.id))
);

/* ------------------------------------------------------- determinism (R4) */

const sortKey = edge => `${edge.from}\u0000${edge.kind}\u0000${edge.to}`;
for (const [name, view] of [
  ['global', global],
  ['workspace', alphaLevel],
  ['session', centre]
]) {
  const again = JSON.parse(JSON.stringify(buildGraph(snapshot, [], { level: name, workspace: wsA, session: 'ses_a1', now })));
  expect(
    `GR determinism ${name}: two builds of the same snapshot are byte-identical`,
    JSON.stringify(again) === JSON.stringify(JSON.parse(JSON.stringify(view))),
    `${again.nodes.length} nodes / ${again.edges.length} edges`
  );
  const keys = view.edges.map(sortKey);
  expect(
    `GR determinism ${name}: nodes sorted by id, edges by from+kind+to`,
    JSON.stringify(view.nodes.map(node => node.id)) ===
      JSON.stringify([...view.nodes.map(node => node.id)].sort()) &&
      JSON.stringify(keys) === JSON.stringify([...keys].sort()),
    JSON.stringify(keys)
  );
}

// R4, the strong form: the output must not depend on the **input order** of the
// snapshot's arrays. Same records, listed backwards, must still serialize to the
// same bytes — that is what the explicit sort buys (a Map-insertion order would
// pass "build twice" but fail here).
const reversed = {
  ...snapshot,
  sessions: [...snapshot.sessions].reverse(),
  handoffs: [...snapshot.handoffs].reverse()
};
for (const [name, options] of [
  ['global', { level: 'global' }],
  ['workspace', { level: 'workspace', workspace: wsA }],
  ['session', { level: 'session', session: 'ses_a1' }]
]) {
  expect(
    `GR determinism ${name}: reversing the snapshot arrays yields the same graph (canonical order)`,
    JSON.stringify(buildGraph(reversed, [], { ...options, now })) ===
      JSON.stringify(buildGraph(snapshot, [], { ...options, now })),
    JSON.stringify(buildGraph(reversed, [], { ...options, now }))
  );
}

/* ---------------------------------------------------------- degenerate input */

expect(
  'GR an absent snapshot is an empty graph (never a throw)',
  (() => {
    const view = buildGraph(undefined, [], { level: 'global', now });
    return Array.isArray(view.nodes) && view.nodes.length === 0 && view.edges.length === 0;
  })()
);
expect(
  'GR a session id that is not listed is one node, no edges (no invented relations)',
  (() => {
    const view = buildGraph(snapshot, [], { level: 'session', session: 'ses_missing', now });
    return view.nodes.length === 0 || (view.nodes.length === 1 && view.nodes[0].id === 'ses_missing');
  })()
);

/* --------------------------------------------------------------- read-only R5 */

function hashDirectory(directory) {
  const hash = createHash('sha256');
  const walk = current => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        hash.update(`dir:${full}\n`);
        walk(full);
      } else {
        hash.update(`file:${full}:${stats.size}\n`);
        hash.update(readFileSync(full));
      }
    }
  };
  walk(directory);
  return hash.digest('hex');
}

const scratch = mkdtempSync(join(tmpdir(), 'collab-graph-ro-'));
mkdirSync(join(scratch, 'docs', 'issues'), { recursive: true });
writeFileSync(join(scratch, 'docs', 'issues', 'bugs-graph.md'), '# proposal\n');
const before = hashDirectory(scratch);
for (const level of ['global', 'workspace', 'session']) {
  buildGraph(snapshot, [], { level, workspace: scratch, session: 'ses_a1', now });
}
const after = hashDirectory(scratch);
expect(
  'GR read-only: the workspace directory hash is unchanged after L0/L1/L2',
  before === after,
  `${before.slice(0, 12)} → ${after.slice(0, 12)}`
);

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} graph checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAIL: ${check.title}`);
  process.exit(1);
}
process.exit(0);
