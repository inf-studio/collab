/**
 * 0.9.0 review (message coverage): **every** place the plugin delivers a prompt
 * must land one `Envelope` in `collab-messages.jsonl`, not just
 * `collab_send` / `collab_reply` / the takeover request.
 *
 * Six points were missing:
 *   1. `core/actions.ts` — `collab_escalate` (urgent push)        → kind `notify`
 *   2. `core/actions.ts` — `collab_freeze` notice                 → kind `notify`
 *   3. `core/chain.ts`   — `notifyRequester` (accept/decline)     → kind `note`
 *   4. `core/chain.ts`   — `ackSeen` (`[ack] <cid> seen`)         → kind `ack`
 *   5. `core/chain.ts`   — `resendIfDue` (the one bounded resend) → kind `request` (`_r1`)
 *   6. `core/report.ts`  — defect note to `report.to`             → kind `note`
 *
 * The test drives the **real** functions with a fake host and a temp message
 * log, asserts one row per point (with the right `kind`), and proves the ack is
 * not written twice (the `ackSentAt` guard) — a second `ackSeen` for the same
 * cid adds no line.
 *
 *   node test/delivery-history.mjs      # after `pnpm build`
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
const root = mkdtempSync(join(base, 'collab-delivery-'));
const dist = resolve(import.meta.dirname, '../dist/index.js');
const ws = join(root, 'ws');
mkdirSync(join(ws, 'docs', 'issues'), { recursive: true });

const messagesFile = join(root, 'collab-messages.jsonl');
const dbPath = join(root, 'collab.db');
const broadcastDir = join(root, 'broadcast');
const lockDir = join(root, 'locks');
const ownerQueueDir = join(root, 'owner-queue');
const reportDir = join(root, 'reports');
mkdirSync(broadcastDir, { recursive: true });

process.env.COLLAB_MESSAGES_FILE = messagesFile;
process.env.COLLAB_DB_FILE = dbPath;
process.env.COLLAB_CONTRACT_DIR = join(root, 'contract');
process.env.COLLAB_BROADCAST_DIR = broadcastDir;
process.env.COLLAB_LOCK_DIR = lockDir;
process.env.COLLAB_OWNER_QUEUE_DIR = ownerQueueDir;
process.env.COLLAB_REPORT_DIR = reportDir;
process.env.COLLAB_THREAD_INDEX_FILE = join(root, 'collab-threads.json');
process.env.COLLAB_FREEZE_FILE = join(root, 'freeze.json');
process.env.COLLAB_AUDIT_FILE = join(root, 'collab-audit.jsonl');
process.env.COLLAB_CONFIG = join(root, 'collab.json');
// 0.9.6: one prompt per send (the pacing switches are covered by test/pacing.mjs).
writeFileSync(process.env.COLLAB_CONFIG, JSON.stringify({ windowMs: 0, suppressNoDelta: false }));
process.env.COLLAB_PACING_FILE = join(root, 'collab-pacing.json');
// B1: a delivery test must never touch the operator's real history.
const realMessages = join(homedir(), '.config', 'opencode', 'collab-messages.jsonl');
const realDb = join(homedir(), '.config', 'opencode', 'collab.db');

const built = await import(pathToFileURL(dist).href);
const internals = built.__internals;
const {
  createHandoffChain,
  createReporter,
  writeBroadcast,
  readMessages,
  escalateAction,
  freezeAction,
  openDb,
  closeDb
} = internals;

const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};

// ------------------------------------------------------------------- fake host
const prompts = [];
const now = Date.now();
const sessions = {
  ses_me: { id: 'ses_me', agent: 'build', title: 'me', location: { directory: ws } },
  ses_peer: { id: 'ses_peer', agent: 'build', title: 'peer', location: { directory: ws } },
  ses_req: { id: 'ses_req', agent: 'build', title: 'requester', location: { directory: ws } },
  ses_claimant: { id: 'ses_claimant', agent: 'build', title: 'claimant', location: { directory: ws } },
  ses_ack_sender: { id: 'ses_ack_sender', agent: 'build', title: 'ack sender', location: { directory: ws } },
  ses_report_to: { id: 'ses_report_to', agent: 'build', title: 'maintainer', location: { directory: ws } }
};
const ctx = {
  location: { directory: ws },
  options: {},
  storage: { get: async () => undefined, set: async () => undefined },
  session: {
    get: async ({ sessionID }) => {
      const info = sessions[sessionID];
      if (!info) throw new Error(`session ${sessionID} not found`);
      return info;
    },
    list: async () => Object.values(sessions),
    context: async () => [],
    prompt: async input => {
      prompts.push(input);
      return { id: `msg_host_${prompts.length}`, delivery: input.delivery };
    },
    hook: async () => ({}),
    create: async input => ({ id: 'ses_new', ...input }),
    remove: async () => ({}),
    wait: async () => ({})
  },
  tool: { transform: async () => ({}) },
  event: { subscribe: async function* () {} }
};

const config = {
  aliases: {},
  autoDeliver: true,
  maxInject: 3,
  allowWrite: false,
  protect: [],
  readonlyAgents: ['explore', 'plan'],
  archiveSpawned: false,
  archiveGraceMs: 600_000,
  waiterTtlMs: 600_000,
  waiterHeartbeat: true,
  dedupeWindowMs: 60_000,
  awareness: 'off',
  boardActions: true,
  storage: 'sqlite',
  dbPath,
  report: { to: 'ses_report_to' }
};
const readConfig = () => config;

const actionContext = {
  ctx,
  readConfig,
  resolveTarget: async raw => {
    const sessionID = String(raw ?? '');
    const info = sessions[sessionID];
    if (!info) throw new Error(`unknown target ${sessionID}`);
    return { sessionID, info };
  },
  resolveMode: (requested, agent) =>
    agent === 'explore' || agent === 'plan'
      ? { mode: 'queue', forced: true }
      : { mode: requested === 'steer' ? 'steer' : 'queue', forced: false },
  senderLabel: sid => String(sid ?? '').slice(0, 12),
  listSessions: async () => Object.values(sessions)
};
const chain = createHandoffChain(ctx, readConfig);
const reporter = createReporter({ ctx, readConfig });

const lines = () =>
  existsSync(messagesFile)
    ? readMessages({ file: messagesFile }).messages
    : [];
const before = lines().length;
const realStamp = (() => {
  const statOf = path => {
    try {
      const stat = statSync(path);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return 'absent';
    }
  };
  return `${statOf(realMessages)}|${statOf(realDb)}`;
})();

// 1) escalate → notify
const escalate = await escalateAction(actionContext, {
  actor: 'ses_me',
  session: 'ses_peer',
  reason: '投递点覆盖：加急',
  mode: 'queue',
  confirm: true
});
// 2) freeze notice → notify
const freeze = await freezeAction(actionContext, {
  actor: 'ses_me',
  scope: 'session',
  target: 'ses_peer',
  reason: '投递点覆盖：冻结',
  confirm: true
});
// 3) notifyRequester → note (the record is only read, never written here)
const notify = await chain.notifyRequester(
  { bid: 'b_0000000000c0ffee', from: { sid: 'ses_req' }, claim: { by: 'ses_claimant' } },
  { text: '回执-probe：已处理', kind: 'note', from: 'ses_claimant', threadID: 't_cov_1' }
);
// 4) ack → ack (needs a record whose delivery names this receiver + cid)
writeBroadcast({
  bid: 'b_0000000000ac4001',
  scope: 'peer',
  state: 'acked',
  from: { sid: 'ses_req' },
  claim: { by: 'ses_ack_sender' },
  title: 'ack 覆盖',
  delivery: { cid: 'c_ackcover_1', to: 'ses_me', admittedAt: now - 60_000 }
});
await chain.ackSeen('ses_me', ['c_ackcover_1']);
const ackRowsAfterFirst = lines().filter(message => message.kind === 'ack').length;
// A second pass for the same cid must write nothing (ackSentAt guard).
await chain.ackSeen('ses_me', ['c_ackcover_1']);
const ackRowsAfterSecond = lines().filter(message => message.kind === 'ack').length;
// 5) resend → request `_r1`
const resendRecord = {
  bid: 'b_0000000000a50001',
  scope: 'peer',
  state: 'acked',
  from: { sid: 'ses_req' },
  claim: { by: 'ses_peer' },
  title: 'resend 覆盖',
  threadID: 't_cov_resend',
  delivery: { cid: 'c_resendcover_1', to: 'ses_peer', admittedAt: now - 3 * 60 * 60 * 1000 }
};
const resent = await chain.resendIfDue(resendRecord, Date.now(), 'ses_req');
// 6) defect report → note
const report = await reporter.reportNow({
  tool: 'collab_send',
  defect: 'delivery-5xx',
  error: new Error('coverage probe'),
  input: { target: 'ses_peer' },
  sessionID: 'ses_me'
});

// ----------------------------------------------------------------- assertions
const rows = lines().slice(before);
const find = test => rows.filter(test);
const escalateRows = find(message => message.kind === 'notify' && /加急/.test(message.body));
const freezeRows = find(message => message.kind === 'notify' && /frozen/.test(message.body));
const notifyRows = find(message => message.kind === 'note' && /回执-probe/.test(message.body));
const ackRows = find(message => message.kind === 'ack');
const resendRows = find(message => message.kind === 'request' && /_r1$/.test(message.id));
const reportRows = find(message => message.kind === 'note' && /\[defect\]/.test(message.body));

expect(
  '点 1 collab_escalate → 1 行 kind=notify（to 为被加急会话）',
  /已加急/.test(escalate.content) &&
    escalateRows.length === 1 &&
    escalateRows[0].to === 'ses_peer' &&
    escalateRows[0].from === 'ses_me',
  `${escalateRows.length} 行 / ${escalateRows[0]?.id ?? '-'}`
);
expect(
  '点 2 collab_freeze 通知 → 1 行 kind=notify（冻结文案）',
  freeze.ok === true && freezeRows.length === 1 && freezeRows[0].to === 'ses_peer',
  `${freezeRows.length} 行 / ${freezeRows[0]?.id ?? '-'}`
);
expect(
  '点 3 chain.notifyRequester → 1 行 kind=note（发给发起方）',
  notify.delivered === true && notifyRows.length === 1 && notifyRows[0].to === 'ses_req',
  `${notifyRows.length} 行 / ${notifyRows[0]?.id ?? '-'}`
);
expect(
  '点 4 chain.ackSeen → 1 行 kind=ack，且同一 cid 第二次 ack 不重复写',
  ackRows.length === 1 &&
    ackRowsAfterFirst === 1 &&
    ackRowsAfterSecond === 1 &&
    ackRows[0].to === 'ses_req',
  `first=${ackRowsAfterFirst} second=${ackRowsAfterSecond}`
);
expect(
  '点 5 chain.resendIfDue → 1 行 kind=request（id 以 _r1 结尾，区别于原投递）',
  resendRows.length === 1 && resendRows[0].to === 'ses_peer' && resendRows[0].kind === 'request',
  `${resendRows.length} 行 / ${resendRows[0]?.id ?? '-'} / resends=${resent?.delivery?.resends ?? '-'}`
);
expect(
  '点 6 createReporter.deliver → 1 行 kind=note（[defect] 投向 report.to）',
  report.delivered === true && reportRows.length === 1 && reportRows[0].to === 'ses_report_to',
  `${reportRows.length} 行 / ${reportRows[0]?.id ?? '-'}`
);
expect(
  '六个投递点合计恰好 6 行（没有多写的副作用）',
  rows.length === 6,
  `${rows.length} 行: ${rows.map(message => message.kind).join(',')}`
);

// --- S10 (review): a resend row is marked (`resend_of`) so metrics can exclude
// it; the original row stays unmarked.
const s10 = await openDb({ path: dbPath });
const s10Resend = s10.prepare("SELECT id, resend_of FROM messages WHERE id LIKE '%_r1'").get();
const s10Plain = s10.prepare("SELECT resend_of FROM messages WHERE kind = 'ack'").get();
const s10Metric = Number(s10.prepare('SELECT COUNT(*) AS n FROM messages WHERE resend_of IS NULL').get().n);
const s10Total = Number(s10.prepare('SELECT COUNT(*) AS n FROM messages').get().n);
closeDb();
expect(
  'S10 重发行带 resend_of=原 id；metrics 口径（resend_of IS NULL）可排除它',
  String(s10Resend?.resend_of) === 'msg_c_resendcover_1' &&
    s10Plain?.resend_of === null &&
    s10Metric === s10Total - 1,
  `resend_of=${s10Resend?.resend_of} metric=${s10Metric}/${s10Total}`
);

const realStampAfter = (() => {
  const statOf = path => {
    try {
      const stat = statSync(path);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return 'absent';
    }
  };
  return `${statOf(realMessages)}|${statOf(realDb)}`;
})();
expect(
  'B1 本套件不写真实 ~/.config 的 collab-messages.jsonl / collab.db',
  realStampAfter === realStamp,
  `${realStamp} → ${realStampAfter}`
);

rmSync(root, { recursive: true, force: true });
const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAIL: ${check.title}`);
  process.exit(1);
}
process.exit(0);
