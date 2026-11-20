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
 *      false/empty values instead of crashing or printing empty badges;
 *   6. 0.6.1 (`boardOrphans`, pure): rows no session row owns — an orphan lease,
 *      an orphan hand-off, a queue item the caller's own row claimed, and the
 *      "everything claimed → three empty lists" case.
 */
import { resolve } from 'node:path';

// B1 (0.9.0 review): the built server module computes the global message log /
// projection paths at import time. This suite never opens a host, but it must
// still pin them to a temp path so a future change cannot start writing the
// operator's real ~/.config files during `pnpm test`.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.COLLAB_MESSAGES_FILE = join(tmpdir(), 'collab-test-messages.jsonl');
process.env.COLLAB_DB_FILE = join(tmpdir(), 'collab-test.db');

const entry = resolve(import.meta.dirname, '../dist/index.js');
const built = await import(`file://${entry}`);
const { buildBoard, boardOrphans } = built.__internals ?? {};

const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};

expect('BD __internals exports buildBoard', typeof buildBoard === 'function');
expect('BD __internals exports boardOrphans', typeof boardOrphans === 'function');

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

// 0.6.1 (R1): the precedence is `core/freeze-pure.ts`'s `freezeFor` — one
// implementation shared with `core/freeze.ts` (the GUI bundle may not import
// `node:*`). Session (self, then ancestors) must beat the workspace freeze.
const precedenceSnapshot = {
  at: now,
  reachable: true,
  sessions: [
    { sid: 'ses_p', title: 'parent', agent: 'build', busy: false, workspace: wsB },
    { sid: 'ses_c', title: 'child', agent: 'build', busy: false, workspace: wsB, parent: 'ses_p' }
  ],
  locks: [],
  handoffs: [],
  queue: []
};
const precedenceFreezes = [
  { scope: 'workspace', target: wsB, reason: 'beta 仓暂停', by: 'ses_x', at: now - 2_000, until: now + 300_000 },
  { scope: 'session', target: 'ses_p', reason: '父会话停手', by: 'ses_x', at: now - 1_000, until: now + 300_000 }
];
const precedenceBoard = buildBoard(precedenceSnapshot, precedenceFreezes, now);
const precedenceBySid = new Map(precedenceBoard[0].sessions.map(session => [session.sid, session]));
expect(
  'BD freeze precedence comes from freezeFor: session (self or ancestor) beats the workspace freeze',
  precedenceBySid.get('ses_p').frozen?.scope === 'session' &&
    precedenceBySid.get('ses_p').frozen?.reason === '父会话停手' &&
    precedenceBySid.get('ses_c').frozen?.scope === 'session' &&
    precedenceBySid.get('ses_c').frozen?.reason === '父会话停手',
  JSON.stringify({
    parent: precedenceBySid.get('ses_p').frozen,
    child: precedenceBySid.get('ses_c').frozen
  })
);

/* ------------------------------------- 7. boardOrphans (0.6.1, R2): pure cases */

// 7a. A lease whose holder is not a listed session: no session row can own it,
// so it must come back as an orphan (the panels print it under `· 未归属`).
const orphanLockSnapshot = {
  at: now,
  reachable: true,
  sessions: [],
  locks: [
    {
      resource: 'named:gone-window',
      kind: 'named',
      mode: 'exclusive',
      holders: ['ses_gone'],
      waiters: 0,
      waiting: [],
      expiresInMs: 60_000
    }
  ],
  handoffs: [],
  queue: []
};
const orphanLockBoard = buildBoard(orphanLockSnapshot, [], now, 'ses_me');
const orphanLockRows = boardOrphans(orphanLockSnapshot, orphanLockBoard);
expect(
  'BD boardOrphans: a lease no session row holds is an orphan lock (and only a lock)',
  orphanLockRows.locks.length === 1 &&
    orphanLockRows.locks[0].resource === 'named:gone-window' &&
    orphanLockRows.handoffs.length === 0 &&
    orphanLockRows.queue.length === 0 &&
    orphanLockBoard.every(workspace => workspace.sessions.length === 0),
  JSON.stringify({
    locks: orphanLockRows.locks.map(lock => lock.resource),
    handoffs: orphanLockRows.handoffs.length,
    queue: orphanLockRows.queue.length
  })
);

// 7b. A hand-off whose `from` / `claimBy` are not listed sessions: it lands in
// some workspace's `handoffs[]` (the header counts it) but on no session row.
const orphanHandoffSnapshot = {
  at: now,
  reachable: true,
  sessions: [{ sid: 'ses_me', title: 'me', agent: 'build', busy: false, workspace: wsA }],
  locks: [],
  handoffs: [
    { bid: 'b_orphan', state: 'open', ageMs: 10_000, from: 'ses_gone', workspace: wsA, title: 'nobody home' }
  ],
  queue: []
};
const orphanHandoffBoard = buildBoard(orphanHandoffSnapshot, [], now, 'ses_me');
const orphanHandoffRows = boardOrphans(orphanHandoffSnapshot, orphanHandoffBoard);
expect(
  'BD boardOrphans: a hand-off neither started nor claimed by a listed session is an orphan',
  orphanHandoffRows.handoffs.length === 1 &&
    orphanHandoffRows.handoffs[0].bid === 'b_orphan' &&
    orphanHandoffRows.locks.length === 0 &&
    orphanHandoffRows.queue.length === 0 &&
    orphanHandoffBoard[0].sessions.every(session => session.handoffs.length === 0),
  JSON.stringify({
    handoffs: orphanHandoffRows.handoffs.map(handoff => handoff.bid),
    locks: orphanHandoffRows.locks.length,
    queue: orphanHandoffRows.queue.length
  })
);

// 7c. The queue block belongs to the caller: `buildBoard(..., me)` attaches it
// to that row, so it is **not** an orphan (classification is not "no sessions").
// The same snapshot without `me` cannot attach it → it *is* an orphan, which is
// what makes the queue branch of `boardOrphans` load-bearing.
const claimedQueueSnapshot = {
  at: now,
  reachable: true,
  sessions: [{ sid: 'ses_me', title: 'me', agent: 'build', busy: false, workspace: wsA }],
  locks: [],
  handoffs: [],
  queue: [{ queueId: 'q_mine', target: 'ses_p', ageMs: 5_000, summary: '请复核', seen: false }]
};
const claimedQueueBoard = buildBoard(claimedQueueSnapshot, [], now, 'ses_me');
const claimedQueueRows = boardOrphans(claimedQueueSnapshot, claimedQueueBoard);
expect(
  'BD boardOrphans: a queue item the caller\'s own row claimed is not an orphan',
  claimedQueueRows.queue.length === 0 &&
    claimedQueueBoard[0].sessions[0].queue.length === 1 &&
    claimedQueueBoard[0].sessions[0].badges.queue === 1,
  JSON.stringify({
    orphans: claimedQueueRows.queue.map(item => item.queueId),
    row: claimedQueueBoard[0].sessions[0].queue.map(item => item.queueId)
  })
);
const unownedQueueBoard = buildBoard(claimedQueueSnapshot, [], now);
const unownedQueueRows = boardOrphans(claimedQueueSnapshot, unownedQueueBoard);
expect(
  'BD boardOrphans: the same queue item with no `me` is not attached to any row — it is an orphan',
  unownedQueueRows.queue.length === 1 &&
    unownedQueueRows.queue[0].queueId === 'q_mine' &&
    unownedQueueBoard[0].sessions[0].queue.length === 0,
  JSON.stringify({ orphans: unownedQueueRows.queue.map(item => item.queueId) })
);

// 7d. Everything claimed: three empty lists (never a duplicate row).
const claimedAllSnapshot = {
  at: now,
  reachable: true,
  sessions: [{ sid: 'ses_me', title: 'me', agent: 'build', busy: true, workspace: wsA }],
  locks: [
    {
      resource: 'named:mine',
      kind: 'named',
      mode: 'exclusive',
      holders: ['ses_me'],
      waiters: 0,
      waiting: [],
      expiresInMs: 60_000
    }
  ],
  handoffs: [{ bid: 'b_mine', state: 'open', ageMs: 1_000, from: 'ses_me', workspace: wsA, title: 'mine' }],
  queue: [{ queueId: 'q_mine', target: 'ses_p', ageMs: 5_000, summary: '请复核', seen: true }]
};
const claimedAllBoard = buildBoard(claimedAllSnapshot, [], now, 'ses_me');
const claimedAllRows = boardOrphans(claimedAllSnapshot, claimedAllBoard);
expect(
  'BD boardOrphans: when every row is claimed all three orphan lists are empty',
  claimedAllRows.locks.length === 0 &&
    claimedAllRows.handoffs.length === 0 &&
    claimedAllRows.queue.length === 0 &&
    claimedAllBoard[0].sessions[0].locks.length === 1 &&
    claimedAllBoard[0].sessions[0].queue.length === 1,
  JSON.stringify({
    locks: claimedAllRows.locks.length,
    handoffs: claimedAllRows.handoffs.length,
    queue: claimedAllRows.queue.length
  })
);

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} board checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAIL: ${check.title}`);
  process.exit(1);
}
process.exit(0);
