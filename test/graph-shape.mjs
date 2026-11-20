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

// B1 (0.9.0 review): the built server module computes the global message log /
// projection paths at import time. This suite never opens a host, but it must
// still pin them to a temp path so a future change cannot start writing the
// operator's real ~/.config files during `pnpm test`.
process.env.COLLAB_MESSAGES_FILE = join(tmpdir(), 'collab-test-messages.jsonl');
process.env.COLLAB_DB_FILE = join(tmpdir(), 'collab-test.db');
process.env.COLLAB_CONTRACT_DIR = join(tmpdir(), 'collab-test-contract');

const entry = resolve(import.meta.dirname, '../dist/index.js');
const built = await import(`file://${entry}`);
const {
  buildGraph,
  buildSnapshot,
  layoutGraph,
  truncateLabel,
  GRAPH_LABEL_MAX,
  clampZoom,
  clampPan,
  viewBoxOf,
  viewBoxAttr,
  zoomBy
} = built.__internals ?? {};

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

/* --------------------------------------- 0.8.2 layout + view (graph-zoom) ---- */

/*
 * R3 (640×360, centre + two rings, labels ≤ 8 code points) and R1/R2 (zoom
 * around the pointer, clamped pan). All of it is pure — no window, no DOM — so
 * this is where the arithmetic is pinned; `test/gui-panel.mjs` only proves the
 * same functions are wired to the wheel / pointer events.
 */
expect(
  'GR layout: __internals exports the layout + view functions (pure, no host)',
  typeof layoutGraph === 'function' &&
    typeof truncateLabel === 'function' &&
    typeof viewBoxOf === 'function' &&
    typeof viewBoxAttr === 'function' &&
    typeof zoomBy === 'function' &&
    typeof clampPan === 'function' &&
    typeof clampZoom === 'function' &&
    GRAPH_LABEL_MAX === 8
);

const BOX_H = 22;
/** A rendered box: its centre, width, height (the same numbers the SVG gets). */
const boxOf = (layout, id) => {
  const point = layout.points.get(id);
  const width = layout.widths.get(id);
  return point && width
    ? { x: point.x - width / 2, y: point.y - BOX_H / 2, w: width, h: BOX_H }
    : undefined;
};
/** Axis-aligned overlap: strict on both axes (touching is not overlapping). */
const boxesOverlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const overlappingPairs = layout => {
  const ids = [...layout.points.keys()];
  const pairs = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = boxOf(layout, ids[i]);
      const b = boxOf(layout, ids[j]);
      if (a && b && boxesOverlap(a, b)) pairs.push(`${ids[i]}×${ids[j]}`);
    }
  }
  return pairs;
};

const crowded = layoutGraph(capped.nodes, { center: 'ses_center' });
expect(
  'GR layout R3: 8 nodes at 640×360 — no two node boxes intersect',
  capped.nodes.length === 8 && crowded.points.size === 8 && overlappingPairs(crowded).length === 0,
  `overlaps: ${overlappingPairs(crowded).join(', ') || 'none'}`
);
expect(
  'GR layout R3: the selected session is the centre, the rest sit on the two rings',
  JSON.stringify(crowded.points.get('ses_center')) === JSON.stringify({ x: 320, y: 180 }) &&
    [...crowded.points.values()].filter(point => point.x === 320 && point.y === 180).length === 1,
  JSON.stringify([...crowded.points.entries()])
);
expect(
  'GR layout R4: two layouts of the same nodes are byte-identical',
  JSON.stringify([...crowded.points]) === JSON.stringify([...layoutGraph(capped.nodes, { center: 'ses_center' }).points]),
  JSON.stringify([...crowded.points])
);
expect(
  'GR layout R4: a reversed snapshot still yields the same layout (buildGraph sorts first)',
  (() => {
    const forward = layoutGraph(buildGraph(crowd, [], { level: 'session', session: 'ses_center', now }).nodes, {
      center: 'ses_center'
    });
    const reversed = layoutGraph(
      buildGraph({ ...crowd, sessions: [...crowd.sessions].reverse(), handoffs: [...crowd.handoffs].reverse() }, [], {
        level: 'session',
        session: 'ses_center',
        now
      }).nodes,
      { center: 'ses_center' }
    );
    return JSON.stringify([...forward.points]) === JSON.stringify([...reversed.points]);
  })()
);
expect(
  'GR layout R3: every count 1…24 is non-overlapping (the ring layout is verified, not assumed)',
  (() => {
    const bad = [];
    for (let count = 1; count <= 24; count += 1) {
      const nodes = Array.from({ length: count }, (_, index) => ({
        id: `ses_l${String(index).padStart(2, '0')}`,
        kind: 'session',
        label: `node ${index}`
      }));
      const pairs = overlappingPairs(layoutGraph(nodes));
      if (pairs.length) bad.push(`${count}:${pairs[0]}`);
    }
    return bad.length === 0;
  })()
);
expect(
  'GR layout R3: a label is cut to 8 code points including the ellipsis',
  (() => {
    const long = {
      at: now,
      reachable: true,
      sessions: [
        { sid: 'ses_zoom_long', title: '定点复核 P2/P3 修一下这个很长的标题', agent: 'build', busy: true, workspace: wsA }
      ],
      locks: [],
      handoffs: [],
      queue: []
    };
    const view = buildGraph(long, [], { level: 'session', session: 'ses_zoom_long', now });
    const layout = layoutGraph(view.nodes);
    const text = layout.labels.get('ses_zoom_long') ?? '';
    return Array.from(text).length === 8 && text.endsWith('…') && text.startsWith('定点复核');
  })(),
  truncateLabel('定点复核 P2/P3 修一下这个很长的标题')
);
expect(
  'GR layout R3: a short label is printed as-is, a 12-char one is cut (box stays 44…96 wide)',
  (() => {
    const view = buildGraph(snapshot, [], { level: 'session', session: 'ses_a1', now });
    const layout = layoutGraph(view.nodes);
    const short = layoutGraph([{ id: 'ses_s', kind: 'session', label: 'abc' }]).labels.get('ses_s');
    const long = layout.labels.get('ses_a1') ?? '';
    const width = layout.widths.get('ses_a1') ?? 0;
    return short === 'abc' && long === 'alpha w…' && width >= 44 && width <= 96;
  })(),
  JSON.stringify([...layoutGraph(buildGraph(snapshot, [], { level: 'session', session: 'ses_a1', now }).nodes).labels])
);
expect(
  'GR labels: truncation counts code points, never halves a surrogate pair',
  (() => {
    const emoji = truncateLabel('🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀', 4);
    return Array.from(emoji).length === 4 && emoji === '🚀🚀🚀…';
  })(),
  truncateLabel('🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀', 4)
);

/* R1: the three acceptance zooms. */
expect(
  'GR zoom R1: 1× is the whole 640×360 canvas',
  viewBoxAttr(viewBoxOf(1, { x: 0, y: 0 })) === '0 0 640 360',
  viewBoxAttr(viewBoxOf(1, { x: 0, y: 0 }))
);
expect(
  'GR zoom R1: 0.6× shows 1066.7×600 and stays centred (nothing to pan)',
  viewBoxAttr(viewBoxOf(0.6, { x: 0, y: 0 })) === '-213.3 -120 1066.7 600' &&
    JSON.stringify(clampPan({ x: 500, y: 500 }, 0.6)) === JSON.stringify({ x: 0, y: 0 }),
  `${viewBoxAttr(viewBoxOf(0.6, { x: 0, y: 0 }))} · ${JSON.stringify(clampPan({ x: 500, y: 500 }, 0.6))}`
);
expect(
  'GR zoom R1: 2.5× shows 256×144 centred',
  viewBoxAttr(viewBoxOf(2.5, { x: 0, y: 0 })) === '192 108 256 144',
  viewBoxAttr(viewBoxOf(2.5, { x: 0, y: 0 }))
);
expect(
  'GR zoom R1: zoom is clamped to [0.6, 2.5] (a wild wheel cannot leave the range)',
  clampZoom(9) === 2.5 && clampZoom(0.05) === 0.6 && clampZoom(Number.NaN) === 1 && clampZoom(1.7) === 1.7,
  `${clampZoom(9)} / ${clampZoom(0.05)} / ${clampZoom(Number.NaN)}`
);
expect(
  'GR zoom R1: wheel up zooms in, wheel down zooms back out (exponential, symmetric)',
  (() => {
    const inOne = zoomBy(1, { x: 0, y: 0 }, -100, { x: 320, y: 180 }, { left: 0, top: 0, width: 640, height: 360 });
    const back = zoomBy(inOne.zoom, inOne.pan, 100, { x: 320, y: 180 }, { left: 0, top: 0, width: 640, height: 360 });
    return inOne.zoom > 1 && Math.abs(back.zoom - 1) < 1e-9 && Math.abs(back.pan.x) < 1e-9 && Math.abs(back.pan.y) < 1e-9;
  })()
);
expect(
  'GR zoom R1: the graph point under the pointer stays under the pointer',
  (() => {
    const rect = { left: 0, top: 0, width: 640, height: 360 };
    const next = zoomBy(1, { x: 0, y: 0 }, -200, { x: 480, y: 90 }, rect);
    const box = viewBoxOf(next.zoom, next.pan);
    const graphX = box.x + (480 / 640) * box.width;
    const graphY = box.y + (90 / 360) * box.height;
    return Math.abs(graphX - 480) < 0.5 && Math.abs(graphY - 90) < 0.5;
  })()
);
expect(
  'GR pan R2: an over-drag is pulled back inside the 10 % margin',
  (() => {
    const one = clampPan({ x: 9999, y: -9999 }, 1);
    const box = viewBoxOf(1, { x: 9999, y: -9999 });
    return one.x === 64 && one.y === -36 && box.x === 64 && box.y === -36 && box.width === 640;
  })(),
  JSON.stringify(clampPan({ x: 9999, y: -9999 }, 1))
);
expect(
  'GR pan R2: at 2.5× the pan range is larger (the canvas is the limit, not the pointer)',
  (() => {
    const one = clampPan({ x: 9999, y: 9999 }, 2.5);
    const box = viewBoxOf(2.5, { x: 9999, y: 9999 });
    return one.x === 256 && one.y === 144 && box.x === 448 && box.y === 252;
  })(),
  JSON.stringify(clampPan({ x: 9999, y: 9999 }, 2.5))
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
