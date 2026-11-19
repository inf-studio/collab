/**
 * 0.6.0 (`collab-board`): the pure three-layer derivation both panels render.
 *
 *   node test/board-shape.mjs        # `pnpm test` runs it after the build
 *
 * `buildBoard(snapshot, freezes, now)` has no host and no file: the fixture is
 * the whole world. Checked here:
 *
 *   1. workspaces → active sessions (`archived[]` split out, never mixed);
 *   2. per-session locks / hand-offs / queue and their short badges;
 *   3. the `↳` spawn relation uses `handoff.spawned` (falling back to `claimBy`),
 *      not "whoever took the hand-off";
 *   4. `urgent` comes from a hand-off or queue item, `frozen` from the snapshot
 *      marker **or** the freeze list (expired entries dropped);
 *   5. an old snapshot (no `archived` / `kind` / `spawned` / `priority`) derives
 *      false/empty values instead of crashing or printing empty badges.
 */
import { resolve } from 'node:path';

const entry = resolve(import.meta.dirname, '../dist/index.js');
const built = await import(`file://${entry}`);
const { buildBoard } = built.__internals ?? {};

const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};

expect('BD __internals exports buildBoard', typeof buildBoard === 'function');

const now = 1_800_000_000_000;
const wsA = '/data/project/alpha';
const wsB = '/data/project/beta';

const snapshot = {
  at: now,
  reachable: true,
  sessions: [
    {
      sid: 'ses_a1',
      title: 'alpha worker',
      agent: 'build',
      busy: true,
      workspace: wsA,
      frozen: { scope: 'session', target: 'ses_a1', until: now + 600_000, reason: '等 schema 线确认' }
    },
    { sid: 'ses_a2', title: 'alpha reader', agent: 'explore', busy: false, workspace: wsA },
    { sid: 'ses_child', title: 'child worker', agent: 'build', busy: true, workspace: wsA },
    { sid: 'ses_old', title: 'old worker', agent: 'build', busy: true, workspace: wsA, archived: true },
    { sid: 'ses_b1', title: 'beta worker', agent: 'build', busy: false, workspace: wsB }
  ],
  locks: [
    {
      resource: 'named:alpha-window',
      kind: 'named',
      mode: 'exclusive',
      holders: ['ses_a1'],
      waiters: 1,
      waiting: ['ses_a2'],
      expiresInMs: 600_000
    },
    {
      resource: 'named:beta-window',
      kind: 'named',
      mode: 'exclusive',
      holders: ['ses_b1'],
      waiters: 0,
      waiting: [],
      expiresInMs: 300_000
    }
  ],
  handoffs: [
    {
      bid: 'b_00000000a1',
      state: 'claimed',
      ageMs: 60_000,
      from: 'ses_a1',
      claimBy: 'ses_child',
      workspace: wsA,
      title: 'spawn the child',
      kind: 'spawn',
      spawned: 'ses_child'
    },
    {
      bid: 'b_00000000a2',
      state: 'open',
      ageMs: 120_000,
      from: 'ses_a2',
      workspace: wsA,
      title: 'urgent alpha proposal',
      priority: 'urgent'
    },
    {
      bid: 'b_00000000b1',
      state: 'claimed',
      ageMs: 30_000,
      from: 'ses_b1',
      claimBy: 'ses_a1',
      workspace: wsB,
      title: 'beta proposal'
    }
  ],
  queue: [
    { queueId: 'q_1_aaaa', target: 'ses_p1', ageMs: 10_000, summary: '请复核', seen: false, priority: 'urgent' },
    { queueId: 'q_2_bbbb', target: 'ses_p2', ageMs: 20_000, summary: '第二条', seen: true }
  ]
};

// 0.6.0 freeze list: a workspace freeze for beta, and an expired session freeze
// that must not mark anybody.
const freezes = [
  {
    scope: 'workspace',
    target: wsB,
    reason: 'beta 仓暂停',
    by: 'ses_a1',
    at: now - 30_000,
    until: now + 300_000
  },
  {
    scope: 'session',
    target: 'ses_a2',
    reason: '已过期',
    by: 'ses_a1',
    at: now - 120_000,
    until: now - 1
  }
];

const board = buildBoard(snapshot, freezes, now, 'ses_a1');

expect('BD two workspaces, sorted by directory', board.length === 2 && board[0].workspace === wsA, JSON.stringify(board.map(ws => ws.workspace)));
const alpha = board.find(workspace => workspace.workspace === wsA);
const beta = board.find(workspace => workspace.workspace === wsB);

expect(
  'BD archived sessions are filed separately (active list has no archived row)',
  alpha.sessions.length === 3 &&
    alpha.sessions.every(session => !session.archived) &&
    alpha.archived.length === 1 &&
    alpha.archived[0].sid === 'ses_old' &&
    alpha.archived[0].archived === true &&
    alpha.archived[0].busy === false,
  JSON.stringify({ active: alpha.sessions.map(s => s.sid), archived: alpha.archived.map(s => s.sid) })
);

expect(
  'BD workspace counts are sessions · locks · hand-offs · archived',
  alpha.counts.sessions === 3 &&
    alpha.counts.locks === 1 &&
    alpha.counts.handoffs === 2 &&
    alpha.counts.archived === 1 &&
    beta.counts.sessions === 1 &&
    beta.counts.locks === 1 &&
    beta.counts.handoffs === 1 &&
    beta.counts.archived === 0,
  JSON.stringify({ alpha: alpha.counts, beta: beta.counts })
);

const a1 = alpha.sessions.find(session => session.sid === 'ses_a1');
expect(
  'BD a session carries its locks / hand-offs / queue (holders, waiters, from, claimBy)',
  a1.locks.length === 1 &&
    a1.locks[0].resource === 'named:alpha-window' &&
    a1.handoffs.length === 2 &&
    a1.handoffs.some(handoff => handoff.bid === 'b_00000000b1') &&
    a1.queue.length === 2,
  JSON.stringify({ locks: a1.locks.map(l => l.resource), handoffs: a1.handoffs.map(h => h.bid), queue: a1.queue.map(q => q.queueId) })
);

expect(
  'BD badges count held / waiting / hand-offs / queue (🔒1 ‹2› ⇢2)',
  a1.badges.held === 1 &&
    a1.badges.waiting === 0 &&
    a1.badges.handoffs === 2 &&
    a1.badges.queue === 2,
  JSON.stringify(a1.badges)
);
const a2 = alpha.sessions.find(session => session.sid === 'ses_a2');
expect(
  'BD a queued session has waiting:1 and no held badge',
  a2.badges.held === 0 && a2.badges.waiting === 1,
  JSON.stringify(a2.badges)
);

expect(
  'BD the spawn relation comes from kind:"spawn" + spawned (child is ↳, not the claimant of another bid)',
  a1.spawned.length === 1 &&
    a1.spawned[0].sid === 'ses_child' &&
    a1.spawned[0].state === 'claimed' &&
    a1.spawned[0].archived === false &&
    a1.spawned[0].title === 'child worker',
  JSON.stringify(a1.spawned)
);
expect(
  'BD a session that did not spawn has no ↳ rows',
  a2.spawned.length === 0,
  JSON.stringify(a2.spawned)
);

expect(
  'BD urgent comes from a hand-off (and a queue item) — not from the lock count',
  a1.urgent === true && a2.urgent === true && beta.sessions[0].urgent === false,
  JSON.stringify({ a1: a1.urgent, a2: a2.urgent, b1: beta.sessions[0].urgent })
);

expect(
  'BD frozen uses the snapshot marker first and the freeze list second (expired freeze ignored)',
  a1.frozen?.scope === 'session' &&
    a1.frozen?.target === 'ses_a1' &&
    beta.sessions[0].frozen?.scope === 'workspace' &&
    !a2.frozen,
  JSON.stringify({ a1: a1.frozen, a2: a2.frozen, b1: beta.sessions[0].frozen })
);

// Older server: none of the 0.6.0 fields exist. The derivation must still work,
// and absence has to read as false / empty — never as an empty badge.
const oldSnapshot = {
  at: now,
  reachable: true,
  sessions: [{ sid: 'ses_x', title: 'old session', agent: 'build', busy: false, workspace: wsA }],
  locks: [],
  handoffs: [{ bid: 'b_old', state: 'open', ageMs: 10_000, from: 'ses_x', title: 'old hand-off' }],
  queue: []
};
const oldBoard = buildBoard(oldSnapshot, [], now);
const oldSession = oldBoard[0]?.sessions[0];
expect(
  'BD an old snapshot (no archived / kind / spawned / priority) does not crash and has no empty badges',
  oldBoard.length === 1 &&
    oldSession.badges.held === 0 &&
    oldSession.badges.waiting === 0 &&
    oldSession.badges.handoffs === 1 &&
    oldSession.badges.queue === 0 &&
    oldSession.spawned.length === 0 &&
    oldSession.archived === false &&
    oldSession.urgent === false &&
    oldSession.frozen === undefined,
  JSON.stringify(oldSession)
);
expect(
  'BD an absent snapshot is an empty board (never a throw)',
  Array.isArray(buildBoard(undefined, [], now)) && buildBoard(undefined, [], now).length === 0
);

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} board checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAIL: ${check.title}`);
  process.exit(1);
}
process.exit(0);
