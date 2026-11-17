/**
 * Round-2 independent check probes (cold context) — H1 / H2 / L1 / R1.
 *
 * Deliberately NOT derived from `scripts/collab/handoff-harness.mjs` nor from
 * `research/impl-probes-h1-h2.mjs`: own fake ctx, own fixtures, own assertions.
 *
 *   node .trellis/tasks/11-17-collab-auto-receipt/research/check-round2-probes.mjs
 *
 * Copies the plugin into a temp dir (repo is not `type: module`), points
 * COLLAB_BROADCAST_DIR at a temp dir, seeds `<bid>.json` + `<bid>.lock` with a
 * forged `claim.at` (301s ago) and drives the real `context` hook.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(process.cwd());
const dir = mkdtempSync(join(tmpdir(), 'collab-r2-probes-'));
const entry = join(dir, 'collab.mjs');
const pluginPath = process.env.COLLAB_PLUGIN_PATH
  ? resolve(process.env.COLLAB_PLUGIN_PATH)
  : join(repo, '.opencode/plugins/collab.js');
copyFileSync(pluginPath, entry);
console.log(`plugin under test: ${pluginPath}`);
const broadcastDir = join(dir, 'broadcast');
mkdirSync(broadcastDir, { recursive: true });
process.env.COLLAB_BROADCAST_DIR = broadcastDir;

const WS_A = join(dir, 'ws-a');
const WS_B = join(dir, 'ws-b');
for (const w of [WS_A, WS_B]) mkdirSync(join(w, 'docs', 'issues'), { recursive: true });

const now = Date.now();
const sessions = {
  ses_req: { id: 'ses_req', agent: 'build', title: 'requester', time: { busy: 0 }, location: { directory: WS_A } },
  ses_bystander: {
    id: 'ses_bystander',
    agent: 'build',
    title: 'bystander',
    time: { busy: 0 },
    location: { directory: WS_A }
  },
  ses_other_ws: { id: 'ses_other_ws', agent: 'build', title: 'other ws', time: { busy: 0 }, location: { directory: WS_B } }
};
const contexts = new Map();
const reads = [];
const created = [];
const prompts = [];
const hooks = {};
const tools = [];
const store = new Map();

const ctx = {
  location: { directory: WS_A },
  options: {},
  app: { version: 'probe' },
  storage: {
    async get(k) {
      const v = store.get(k);
      return v === undefined ? undefined : structuredClone(v);
    },
    async set(k, v) {
      store.set(k, structuredClone(v));
    },
    async remove(k) {
      store.delete(k);
    },
    async scan() {
      return { entries: [] };
    }
  },
  tool: {
    async transform(cb) {
      cb({ add: def => tools.push(def) });
      return { dispose: async () => {} };
    }
  },
  session: {
    async hook(name, cb) {
      hooks[name] = cb;
      return { dispose: async () => {} };
    },
    async get({ sessionID }) {
      if (!sessions[sessionID]) throw new Error(`Session not found: ${sessionID}`);
      return structuredClone(sessions[sessionID]);
    },
    async list({ limit = 20, directory } = {}) {
      const list = Object.values(sessions).filter(i => !directory || i.location?.directory === directory);
      return { data: structuredClone(list.slice(0, limit)) };
    },
    async context(input = {}) {
      reads.push({ sessionID: String(input?.sessionID ?? ''), limit: input?.limit, keys: Object.keys(input) });
      return structuredClone(contexts.get(input?.sessionID) ?? []);
    },
    async create(input = {}) {
      const info = {
        id: `ses_created_${created.length + 1}`,
        agent: input.agent,
        title: input.title,
        time: { created: Date.now() },
        location: { directory: input.location?.directory }
      };
      sessions[info.id] = info;
      created.push(info);
      return structuredClone(info);
    },
    async remove({ sessionID }) {
      delete sessions[sessionID];
    },
    async prompt(input) {
      prompts.push(input);
      return { id: `msg_${prompts.length}`, delivery: input.delivery };
    },
    async wait() {}
  },
  event: { async subscribe() {} }
};

const quiet = console.error;
console.error = () => {};
const plugin = (await import(`file://${entry}`)).default;
await plugin.setup(ctx);
console.error = quiet;

const msg = (text, at = now) => ({ id: `m_${at}_${text.length}`, type: 'assistant', time: { created: at }, content: [{ type: 'text', text }] });
const toolOnly = (at = now) => ({
  id: `m_tool_${at}`,
  type: 'assistant',
  time: { created: at },
  content: [{ type: 'tool', name: 'edit', state: { completed: true, input: { filePath: 'apps/pos/src/main.ts' } } }]
});

let seq = 0;
const bidOf = () => `b_${(0xc000 + ++seq).toString(16).padStart(14, '0')}`;
const spawned = [];
const seed = (bid, spawnSid, { protectedClaim = false } = {}) => {
  if (!sessions[spawnSid]) {
    sessions[spawnSid] = {
      id: spawnSid,
      agent: 'explore',
      title: `impl:${bid}`,
      time: { created: now, busy: 0 },
      location: { directory: WS_A }
    };
    spawned.push(spawnSid);
  }
  writeFileSync(
    join(broadcastDir, `${bid}.json`),
    `${JSON.stringify(
      {
        bid,
        scope: 'peer',
        workspace: WS_A,
        issuePath: 'docs/issues/fix-probe.md',
        title: 'probe fixture',
        expected: 'implement',
        affectedFiles: [],
        candidates: [],
        state: 'claimed',
        attempts: 0,
        skipped: [],
        seenBy: [],
        askSeen: [],
        reminded: [],
        replies: [],
        from: { sid: 'ses_req' },
        claim: { by: spawnSid, kind: 'spawn', token: 'k_probe', at: now - 301_000, leaseMs: 300_000, spawner: 'ses_req' },
        createdAt: now,
        updatedAt: now
      },
      null,
      2
    )}\n`
  );
  writeFileSync(join(broadcastDir, `${bid}.lock`), JSON.stringify({ bid, by: 'ses_req', token: 'k_probe', claimBy: spawnSid }));
};
const read = bid => JSON.parse(readFileSync(join(broadcastDir, `${bid}.json`), 'utf8'));
const lockExists = bid => existsSync(join(broadcastDir, `${bid}.lock`));
const textOf = ev => ev.system.map(b => String(b?.text ?? '')).join('\n');
const trigger = async (sid, extra = {}) => {
  const ev = { sessionID: sid, agent: 'build', system: [], messages: [], ...extra };
  await hooks.context(ev);
  return ev;
};

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`);
};

// ---------------------------------------------------------------- H1: no close
const noClose = [
  ['A1 echo <bid>/<摘要> in a promise', b => `完成后我会发：\`[handoff] DONE <bid> <摘要>\`，先确认一下环境。`],
  [
    'A2 echo the real R1 command, real bid, no qualifier',
    b => `回执命令是 collab_send {target:"ses_req", text:"[handoff] DONE ${b} <摘要>", confirm:true}`
  ],
  ['A3 bare echo of the format with the real bid in code ticks', b => `格式：\`[handoff] DONE ${b} <摘要>\``],
  ['A4 echo a foreign bid + a blocked keyword', b => `回执格式 [handoff] DONE b_ffffffffffffffff 已修复 已完成`],
  ['A5 [handoff] DONE with no target', () => '[handoff] DONE 已完成，测试通过'],
  ['A6 negation quoting the receipt line', () => '我不会发 [handoff] DONE，因为环境起不来。'],
  ['A7 任务未完成', () => '任务未完成，卡在权限问题上'],
  ['A8 无法完成', () => '无法完成，需要人接手'],
  ['A9 not done yet', () => 'not done yet, blocked by permissions'],
  ['A10 plan wording + real bid', b => `完成后我会发 [handoff] DONE ${b} 摘要见下`],
  ['A11 placeholder target <bid>', () => '[handoff] DONE <bid> <摘要>']
];
for (const [name, make] of noClose) {
  const bid = bidOf();
  const sid = `ses_h1_${seq}`;
  const text = make(bid);
  contexts.set(sid, [msg(text)]);
  seed(bid, sid);
  reads.length = 0;
  await trigger('ses_req');
  const rec = read(bid);
  check(
    name,
    rec.state === 'open' && rec.attempts === 1 && !rec.receipt && !lockExists(bid),
    JSON.stringify({ state: rec.state, attempts: rec.attempts, note: rec.receipt?.note, read: reads.length })
  );
}

// A12: echo in #1 + "not started" in #2 (last answer only)
{
  const bid = bidOf();
  const sid = `ses_h1_thread_${seq}`;
  contexts.set(sid, [msg(`我会按提示发 [handoff] DONE ${bid} <摘要>。`, now - 1000), msg('环境起不来，我还没开始，需要人接手。')]);
  seed(bid, sid);
  await trigger('ses_req');
  const rec = read(bid);
  check(
    'A12 echo in #1 + not-started in #2',
    rec.state === 'open' && !rec.receipt,
    JSON.stringify({ state: rec.state, attempts: rec.attempts, note: rec.receipt?.note })
  );
}

// A13: last message is tool-only → judge the last answer WITH text
{
  const bid = bidOf();
  const sid = `ses_h1_tooltail_${seq}`;
  contexts.set(sid, [msg(`[handoff] DONE ${bid} 实现完成，测试通过。`, now - 1000), toolOnly()]);
  seed(bid, sid);
  await trigger('ses_req');
  const rec = read(bid);
  check('A13 tool-only tail falls back to last text answer', rec.state === 'done' && rec.receipt?.auto === true, JSON.stringify({ state: rec.state }));
}

// ---------------------------------------------------------------- H1: close
for (const [name, line, want] of [
  ['B1 real [handoff] DONE <current bid>', b => `[handoff] DONE ${b} 已修复并提交 79eac02d`, 'done'],
  ['B2 real [handoff] BLOCKED <current bid>', b => `[handoff] BLOCKED ${b} 该提案已实施，无需 implement`, 'blocked']
]) {
  const bid = bidOf();
  const sid = `ses_b_${seq}`;
  contexts.set(sid, [msg(line(bid))]);
  seed(bid, sid);
  await trigger('ses_req');
  const rec = read(bid);
  check(
    name,
    rec.state === want && rec.receipt?.auto === true && String(rec.receipt?.note ?? '').length > 0 && rec.attempts === 0,
    JSON.stringify({ state: rec.state, note: rec.receipt?.note, attempts: rec.attempts, lock: lockExists(bid) })
  );
}

// ---------------------------------------------------------------- H2
{
  const bid = bidOf();
  const sid = `ses_h2_${seq}`;
  contexts.set(sid, [msg(`[handoff] BLOCKED ${bid} 已实施`)]);
  seed(bid, sid);
  reads.length = 0;
  await trigger('ses_bystander');
  const rec = read(bid);
  check(
    'C1 same-workspace bystander: no read, no receipt, old lease path',
    reads.every(r => r.sessionID !== sid) && rec.state === 'open' && rec.attempts === 1 && !rec.receipt,
    JSON.stringify({ read: reads.some(r => r.sessionID === sid), state: rec.state, attempts: rec.attempts })
  );
}
{
  const bid = bidOf();
  const sid = `ses_h2_ws_${seq}`;
  contexts.set(sid, [msg(`[handoff] BLOCKED ${bid} 已实施`)]);
  seed(bid, sid);
  reads.length = 0;
  await trigger('ses_other_ws');
  const rec = read(bid);
  check(
    'C2 session of another workspace: no read, no receipt, old lease path',
    reads.every(r => r.sessionID !== sid) && rec.state === 'open' && !rec.receipt,
    JSON.stringify({ read: reads.some(r => r.sessionID === sid), state: rec.state })
  );
}
{
  const bid = bidOf();
  const sid = `ses_h2_owner_${seq}`;
  contexts.set(sid, [msg(`[handoff] BLOCKED ${bid} 已实施，无需改动`)]);
  seed(bid, sid);
  reads.length = 0;
  await trigger('ses_req');
  const rec = read(bid);
  const ctxInput = reads.find(r => r.sessionID === sid);
  check(
    "C3 requester's own refresh reads (limit=10) and closes",
    reads.some(r => r.sessionID === sid) && rec.state === 'blocked' && rec.receipt?.auto === true,
    JSON.stringify({ read: reads.some(r => r.sessionID === sid), state: rec.state, note: rec.receipt?.note, limit: ctxInput?.limit })
  );
  check('L1 the tail read asks for ?limit=10', ctxInput?.limit === 10 && ctxInput?.keys?.length === 2, JSON.stringify(ctxInput));
  // C4: the window is consumed once reopened by a bystander — a later requester
  // refresh must not read again (documented "once" behaviour, no re-extraction).
  reads.length = 0;
  await trigger('ses_req');
  check('C5 a reopened (open) record is never re-extracted', reads.length === 0, JSON.stringify(reads));
}

// ---------------------------------------------------------------- R1 copy
{
  // requester's injection on an unrelated fresh ask record is not needed; read the
  // takeover text through the broadcast result instead (no confirm = no send).
  const tool = tools.find(t => t.name === 'collab_broadcast');
  check('R1 collab_broadcast tool is registered', Boolean(tool), tools.map(t => t.name).join(','));
}
{
  const bid = bidOf();
  const sid = `ses_r1_${seq}`;
  contexts.set(sid, [msg('我看看。', now - 5000)]);
  // Record that will be *asked* (open + asked.sid = a candidate in WS_A).
  writeFileSync(
    join(broadcastDir, `${bid}.json`),
    `${JSON.stringify({
      bid,
      scope: 'peer',
      workspace: WS_A,
      issuePath: 'docs/issues/fix-probe.md',
      title: 'probe takeover',
      expected: 'implement',
      affectedFiles: [],
      candidates: [],
      state: 'open',
      attempts: 0,
      skipped: [],
      seenBy: [],
      askSeen: [],
      reminded: [],
      replies: [],
      from: { sid: 'ses_req' },
      asked: { sid: 'ses_bystander', at: now, leaseMs: 300_000 },
      createdAt: now,
      updatedAt: now
    })}\n`
  );
  const ev = await trigger('ses_bystander');
  const text = textOf(ev);
  check(
    'R1 takeover text has accept / receipt / "echo is not a receipt" and full ids',
    text.includes(`collab_accept {bid:"${bid}", confirm:true}`) &&
      text.includes(`collab_send {target:"ses_req", text:"[handoff] DONE ${bid}`) &&
      text.includes(`[handoff] BLOCKED ${bid}`) &&
      text.includes('复述/回显') &&
      text.includes('只分析'),
    text.slice(0, 220)
  );
}

// ------------------------------------------- H1 breadth: verbatim echoes (part 2)
const echoVariants = [
  [
    'A14 acknowledgment + the real R1 command (no plan words)',
    b => `收到交接。执行：collab_send {target:"ses_req", text:"[handoff] DONE ${b} <摘要>", confirm:true}`
  ],
  [
    'A15 the R1 ② line copied verbatim',
    b => `② 回执（必发，二选一）: collab_send {target:"ses_req", text:"[handoff] DONE ${b} <摘要>", confirm:true}`
  ],
  ['A16 template with the closing quote only', b => `回执：text:"[handoff] DONE ${b} <摘要>"`],
  ['A17 template + trailing prose', b => `[handoff] DONE ${b} <摘要>（以上是示例）`],
  ['A18 BLOCKED template echo', b => `格式：text:"[handoff] BLOCKED ${b} <原因>", confirm:true`],
  ['A19 bare placeholder line (control: already guarded)', b => `[handoff] DONE ${b} <摘要>`],
  ['A20 backtick-wrapped placeholder summary', b => `[handoff] DONE ${b} \`<摘要>\``],
  ['A21 placeholder in full-width brackets + prose', b => `[handoff] BLOCKED ${b} 【<原因>】等确认后发`]
];
for (const [name, make] of echoVariants) {
  const bid = bidOf();
  const sid = `ses_h1b_${seq}`;
  contexts.set(sid, [msg(make(bid))]);
  seed(bid, sid);
  await trigger('ses_req');
  const rec = read(bid);
  check(
    name,
    rec.state === 'open' && !rec.receipt,
    JSON.stringify({ state: rec.state, attempts: rec.attempts, note: rec.receipt?.note })
  );
}

// ------------------------------------------------- R3 summary cap + since filter
{
  const bid = bidOf();
  const sid = `ses_r3_${seq}`;
  const marker = 'TAIL-MARKER-MUST-NOT-BE-STORED';
  const body = `${'很长的正文 '.repeat(160)}${marker}`;
  contexts.set(sid, [msg(`[handoff] BLOCKED ${bid} ${body}`)]);
  seed(bid, sid);
  await trigger('ses_req');
  const rec = read(bid);
  const stored = JSON.stringify(rec);
  check(
    'E1 summary ≤200 chars, bid dropped, body tail not on disk',
    rec.state === 'blocked' && String(rec.receipt?.note ?? '').length <= 200 && !stored.includes(marker),
    JSON.stringify({ len: String(rec.receipt?.note ?? '').length, tail: stored.includes(marker) })
  );
}
{
  const bid = bidOf();
  const sid = `ses_since_${seq}`;
  // The only answer predates the claim (301s+ ago) → must be ignored.
  contexts.set(sid, [msg(`[handoff] DONE ${bid} 已修复`, now - 3_600_000)]);
  seed(bid, sid);
  await trigger('ses_req');
  const rec = read(bid);
  check('E2 an answer older than claim.at is ignored', rec.state === 'open' && !rec.receipt, JSON.stringify({ state: rec.state }));
}

// ---------------------------------------------------------------- side effects
check('D1 no session was ever spawned', created.length === 0, `created=${created.length}`);
check('D2 no prompt was ever delivered', prompts.length === 0, `prompts=${prompts.length}`);

const failed = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} probes passed`);
if (failed.length) {
  for (const f of failed) console.log(`FAIL: ${f.name} — ${f.detail}`);
  process.exit(1);
}
process.exit(0);
