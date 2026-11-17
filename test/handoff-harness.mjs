/**
 * Deterministic harness for the collab hand-off protocol + the hand-off chain
 * (no model calls, no real server, no extra dependencies).
 *
 *   pnpm --filter=@info-studio/collab test      # builds `dist/` first
 *   node packages/collab/test/handoff-harness.mjs
 *
 * Imports the built package (`dist/index.js`, see `vite.config.ts`) and drives
 * it with a fake plugin ctx: in-memory `ctx.storage`, fake sessions with
 * `location.directory`, fake `ctx.session.context` messages, and a real (temp)
 * `COLLAB_BROADCAST_DIR` so the broadcast/claim code runs on the real
 * filesystem.
 *
 * Originally the single-file `.opencode/plugins/collab.js` harness; the same
 * 274 checks run against the package so both tracks stay verifiably equal
 * (`scripts/collab/handoff-harness.mjs` still drives the single file). S68 adds
 * the post-archive B1 regression: `collab_grant` preview must not crash when the
 * ledger carries only the promote half.
 *
 * S1–S22 (unchanged from the archived 11-17-collab-handoff harness) cover the
 * per-session protocol: thread state machine, forced queue, injection
 * de-duplication, guard rails, participant checks.
 *
 * S23–S30 cover the chain:
 *   S23  matching score + `why` (file / title / task line / agent / recent / busy)
 *   S24  threshold 80: below it the chain spawns instead of asking
 *   S25  concurrent collab_accept → exactly one winner
 *   S26  idempotency: same content = same bid, edited content = new bid
 *   S27  concurrent broadcast/spawn → one session, `location.directory` carried
 *   S28  `[handoff] DONE` receipt closes the bid
 *   S29  lease expiry → attempts++, skip, reopen; attempts > 3 → expired
 *   S30  collab_list{directory} + loc= + [bootstrap]; peer write guard;
 *        broadcast injected once per session; children/protected get nothing
 *
 * S31–S38 (review-fix round) cover the blockers and the requirement gap:
 *   S31  spawn → the spawned session's own collab_accept → acked (B1)
 *   S32  spawn lease expiry → lock released → a member can claim (B2)
 *   S33  DECLINE skips the candidate, attempts+1, asks the next one; the next
 *        candidate's context injection is the ask line (B3 / R3)
 *   S34  ask lease timeout → same advance; candidates exhausted → expired and
 *        no spawn (B3 / R4)
 *   S35  collab_handoff is idempotent: no second delivery, no resurrection (S1)
 *   S36  receipt: bare basename / non-claimant never closes; exact path from
 *        the claimant does (S3)
 *   S37  spawn landing validation: no `location.directory` → rollback (S2)
 *   S38  symlinked proposal is refused; the guide is listed in the index (S4/S5)
 *
 * S39–S42 (hardening round, `11-17-collab-hardening`) cover the residual risks:
 *   S39  collab_accept refuses a protected session and its descendants (R1-1)
 *   S40  the takeover request carries the requester's full sid; DECLINE is
 *        resolved by `bid`, and a bid-less DECLINE never hits a sibling
 *        hand-off (R1-2 / R1-3)
 *   S41  collab_list reports `lease=expired` read-only: no state change, no
 *        lock release (R1-4)
 *   S42  broadcast pruning: only `done/blocked/expired` older than 7 days, at
 *        most 20 per write, `open/claimed/acked` untouched (R1-5)
 *
 * S44–S50 (auto-receipt round, `11-17-collab-auto-receipt`) cover the pilot's G1:
 *   S44  the takeover request / wake prompt / broadcast result all carry the
 *        accept → receipt → "in-session answer is not done" triple, copy-pasteable
 *   S45  lapsed spawn lease + `[handoff] BLOCKED` in the spawned session's own
 *        answer → auto `blocked` with a receipt, no spawn, no `attempts++`
 *   S46  keyword fallback: 已实施/无需 → blocked, 完成 → done; nothing to remind
 *   S47  lapsed spawn lease with no verdict → the unchanged reopen/skip/ask path
 *        (「核对完成」 alone is a report about the reading, not a finished task)
 *   S48  an unreadable session (404) or an answer-less history never throws and
 *        falls back to the old path
 *   S49  the stored summary is ≤200 chars and never the full body
 *   S50  no extraction unless the claim is a lapsed `spawn` claim; a protected
 *        claimant never participates
 *
 * S51–S52 (review-fix round, same task) close the two risks of that round:
 *   S51  H1: an echoed receipt template (`<bid>`, a foreign bid, this very bid in
 *        a promise), a negation (未完成/无法完成/not done yet) or a receipt for
 *        another bid never closes the hand-off; only the last answer *with text*
 *        is judged, so an older echo cannot outvote it; a real
 *        `[handoff] DONE|BLOCKED <current bid>` still closes
 *   S52  H2: only the requester (`record.from.sid`) may auto-close — a
 *        same-workspace bystander or a session of another workspace gets the old
 *        lease path and never reads the counterpart's answer
 *
 * S53 (round-2 review) closes the last echo hole: the summary slot is rejected
 * when it still contains *any* `<…>` placeholder, so copying the R1 command
 * verbatim (`… <摘要>", confirm:true}`, backticks, `（以上是示例）`,
 * `【<原因>】`) is never a receipt, while a real `DONE <bid> 修好了` still closes.
 *
 * S54–S60 cover the session-level permission patch (`11-17-collab-grant`, R1–R5):
 *   S54  spawn auto-grants exactly the 5 collab_* allows on the new session
 *        (record `permissionGrant=granted`, ledger `before=[]` / `reason=spawn`)
 *   S55  no pre-existing session is patched on the default path
 *   S56  `collab_grant` merges: `read`/`grep` kept in order, a pre-existing
 *        `collab_list` deny is not widened, only the 4 missing actions appended
 *   S57  re-grant is idempotent (no second PATCH, first `before` kept); revoke
 *        restores the snapshot and drops the record; a second revoke reports
 *        "nothing to restore" instead of throwing
 *   S58  whitelist units: only the 5 collab allows pass (`edit`/`write`/`shell`/
 *        `collab_broadcast`/`deny` refused); `mergeRules` keeps order+precedence
 *   S59  protected sessions and their descendants are refused (no PATCH/write)
 *   S60  a refused PATCH is reported, changes nothing, and never blocks a spawn
 *        (`permissionGrant:"failed"`, the takeover prompt still goes out)
 *
 * S61–S67 cover agent promotion (`collab_promote`, R7):
 *   S61  the preview switches nothing and shows `原 agent → 目标 agent`
 *   S62  confirm switches explore→build, records agentBefore/promotedAt/
 *        promotedBy, leaves permissions alone, and is idempotent per agent
 *   S63  grant + promote share one ledger file without overwriting each other
 *        (grant revoke keeps agentBefore, promote revert keeps the grant half)
 *   S64  revert restores the recorded agent and drops only the agent half
 *   S65  agent whitelist build/plan; anything else is refused, nothing switched
 *   S66  revert without a record reports "nothing to restore"
 *   S67  protected sessions/descendants refused; a refused switch is readable,
 *        leaves the agent unchanged and writes no ledger file
 *
 * Exits 1 if any assertion-based check fails; S1–S16 stay print-only.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The repo root (for the docs assertions of S38/S43). The published package
// may live outside a Trellis checkout, in which case those two documentation
// checks are skipped rather than failed.
const repo = resolve(import.meta.dirname, '../..');
const hasRepoDocs = existsSync(join(repo, 'docs/collab.md'));
const dir = mkdtempSync(join(tmpdir(), 'collab-harness-'));
const distEntry = resolve(import.meta.dirname, '../dist/index.js');

// The broadcast store is a global directory; point it at a temp dir so the
// harness never touches ~/.config/opencode/collab-broadcast/.
const broadcastDir = join(dir, 'broadcast');
process.env.COLLAB_BROADCAST_DIR = broadcastDir;

// Same for the permission-grant ledger (`collab-grant` writes one file per
// session there; the harness must never touch the real one).
const grantDir = join(dir, 'grants');
process.env.COLLAB_GRANT_DIR = grantDir;

// ------------------------------------------------------------ fake workspaces
const wsRoot = join(dir, 'ws');
const ws = name => {
  const workspace = join(wsRoot, name);
  mkdirSync(join(workspace, 'docs', 'issues'), { recursive: true });
  return workspace;
};
const WS_A = ws('a');
const WS_B = ws('b');
const WS_C = ws('c');
const WS_D = ws('d');
const WS_E = ws('e');
// Review-fix round fixtures (S31+).
const WS_F = ws('f'); // two candidates ≥80 → serial ask / DECLINE
const WS_G = ws('g'); // two candidates ≥80 → ask-lease timeout
const WS_H = ws('h'); // empty → spawn, then the spawned session accepts itself
const WS_I = ws('i'); // empty → spawn whose landing cannot be verified
const WS_J = ws('j'); // empty → spawn auto-grant, then explicit grant/revoke
const WS_K = ws('k'); // empty → spawn whose permission PATCH is refused
const HARNESS_LOCATION = join(dir, 'harness');

function issueFile(workspace, name, body) {
  const path = join(workspace, 'docs', 'issues', name);
  writeFileSync(path, body);
  return `docs/issues/${name}`;
}

// WS_B: a proposal that names one file + one Trellis task slug.
const ISSUE_B = issueFile(
  WS_B,
  'fix-worker-store.md',
  [
    '# worker store 修复（11-17-worker-store）',
    '',
    '> 状态：待实施',
    '',
    '## 问题',
    '',
    '`packages/state/src/machine/worker/store.ts` 在并发下丢掉 pending 变更。',
    '',
    '## 涉及文件',
    '',
    '- packages/state/src/machine/worker/store.ts'
  ].join('\n')
);
// WS_D: same shape, used for the busy>30min wake path.
const ISSUE_D = issueFile(
  WS_D,
  'fix-worker-busy.md',
  '# worker store state machine 修复（11-17-worker-store）\n\n`packages/state/src/machine/worker/store.ts`\n'
);
// WS_C: no sessions at all → spawn path.
const ISSUE_C = issueFile(WS_C, 'fix-nobody-home.md', '# nobody home\n\n`apps/pos/src/main.ts`\n');
// WS_E: virgin workspace for the spawn agent guard.
const ISSUE_E = issueFile(WS_E, 'fix-build-confirm.md', '# build confirm\n\n`apps/pos/src/main.ts`\n');
// WS_A: proposal for the local hand-off / injection tests.
const ISSUE_A = issueFile(
  WS_A,
  'fix-collab-self.md',
  '# collab 自测（11-17-collab-workspace）\n\n`packages/machine/src/cfg/impl.ts`\n'
);
// WS_F: same basename as WS_B's proposal (receipt matching must not use it) and
// two strong candidates for the serial-ask / DECLINE path.
const ISSUE_F = issueFile(
  WS_F,
  'fix-worker-store.md',
  '# worker store 修复（11-17-worker-store）\n\n`packages/state/src/machine/worker/store.ts`\n'
);
// WS_G: two strong candidates that never answer → ask lease timeout.
const ISSUE_G = issueFile(
  WS_G,
  'fix-ask-timeout.md',
  '# worker store 问询超时（11-17-worker-store）\n\n`packages/state/src/machine/worker/store.ts`\n'
);
// WS_H / WS_I: empty workspaces → spawn (self-accept / landing validation).
const ISSUE_H = issueFile(WS_H, 'fix-spawn-ack.md', '# spawn 自领取\n\n`apps/pos/src/main.ts`\n');
const ISSUE_I = issueFile(WS_I, 'fix-landing.md', '# landing\n\n`apps/pos/src/main.ts`\n');
// WS_J / WS_K: empty workspaces → spawn with an auto permission grant (ok / refused).
const ISSUE_J = issueFile(WS_J, 'fix-grant.md', '# grant\n\n`apps/pos/src/main.ts`\n');
const ISSUE_K = issueFile(WS_K, 'fix-grant-fail.md', '# grant fail\n\n`apps/pos/src/main.ts`\n');

const plugin = (await import(`file://${distEntry}`)).default;
// Pure helpers of the plugin (whitelist / merge) — unit-level checks without a host.
const internals = (await import(`file://${distEntry}`)).__internals;

// ------------------------------------------------------------------ fake host
const store = new Map();
const prompts = [];
const tools = [];
const hooks = {};
const contexts = new Map();
const queue = [];
let wake;

async function* feed() {
  for (;;) {
    if (!queue.length) await new Promise(resolveFeed => (wake = resolveFeed));
    const next = queue.shift();
    if (!next) return;
    yield next;
  }
}

const now = Date.now();
const toolMessage = (file, at = now) => ({
  id: `msg_tool_${file}`,
  type: 'assistant',
  time: { created: at },
  content: [{ type: 'tool', name: 'edit', state: { status: 'completed', input: { filePath: file } } }]
});

const sessions = {
  ses_aaa: { id: 'ses_aaa', agent: 'build', title: 'A', time: { busy: 1 }, location: { directory: HARNESS_LOCATION } },
  ses_bbb: {
    id: 'ses_bbb',
    agent: 'explore',
    title: 'B',
    time: { busy: 1 },
    location: { directory: HARNESS_LOCATION }
  },
  ses_e1eb91cebffeTv1467ubJLKebk: {
    id: 'ses_e1eb91cebffeTv1467ubJLKebk',
    agent: 'build',
    title: 'schema',
    time: { busy: 1 },
    location: { directory: HARNESS_LOCATION }
  },
  // Lineage fixtures: `ses_child` is a direct sub-session of the protected
  // schema line, `ses_grand` is its grandchild (two hops up).
  ses_child: {
    id: 'ses_child',
    parentID: 'ses_e1eb91cebffeTv1467ubJLKebk',
    agent: 'trellis-implement',
    title: 'child of schema',
    time: { busy: 1 },
    location: { directory: HARNESS_LOCATION }
  },
  ses_grand: {
    id: 'ses_grand',
    parentID: 'ses_child',
    agent: 'trellis-implement',
    title: 'grandchild of schema',
    time: { busy: 1 },
    location: { directory: HARNESS_LOCATION }
  },
  // Unrelated sessions used to prove reply routing / participant checks.
  ses_ccc: { id: 'ses_ccc', agent: 'build', title: 'C', time: { busy: 1 }, location: { directory: HARNESS_LOCATION } },
  ses_ddd: { id: 'ses_ddd', agent: 'build', title: 'D', time: { busy: 1 }, location: { directory: HARNESS_LOCATION } },

  // ---- hand-off chain fixtures (S23+) ----
  // WS_A: requester + a matching target + a child (never a group member).
  ses_req: {
    id: 'ses_req',
    agent: 'build',
    title: '11-17-collab-workspace 收口',
    time: { updated: now, busy: now, idle: 0 },
    location: { directory: WS_A }
  },
  ses_a_target: {
    id: 'ses_a_target',
    agent: 'build',
    title: '11-17-collab-workspace machine cfg 修复',
    time: { updated: now - 60_000, busy: 0 },
    location: { directory: WS_A }
  },
  ses_a_second: {
    id: 'ses_a_second',
    agent: 'build',
    title: '别的活儿（无关）',
    time: { updated: now, busy: 0 },
    location: { directory: WS_A }
  },
  ses_a_child: {
    id: 'ses_a_child',
    parentID: 'ses_a_target',
    agent: 'trellis-implement',
    title: '11-17-collab-workspace child',
    time: { updated: now, busy: 0 },
    location: { directory: WS_A }
  },
  // WS_B: high score (file + title words + task slug + build + recent = 85).
  ses_b1: {
    id: 'ses_b1',
    agent: 'build',
    title: '11-17-worker-store worker store 重构',
    time: { updated: now - 10 * 60_000, busy: 0 },
    location: { directory: WS_B }
  },
  // WS_B: low score (no overlap, no words, explore vs implement, older).
  ses_b2: {
    id: 'ses_b2',
    agent: 'explore',
    title: 'bench 压测脚本',
    time: { updated: now - 60 * 60_000, busy: 0 },
    location: { directory: WS_B }
  },
  // WS_B: child of a group member (excluded from the group).
  ses_b_child: {
    id: 'ses_b_child',
    parentID: 'ses_b1',
    agent: 'trellis-implement',
    title: '11-17-worker-store child',
    time: { updated: now, busy: 0 },
    location: { directory: WS_B }
  },
  // WS_B: protected line that lives in the target workspace (must stay out).
  ses_e23a4a23fffe4c4m7UQFR8dUL3: {
    id: 'ses_e23a4a23fffe4c4m7UQFR8dUL3',
    agent: 'build',
    title: '11-17-worker-store parity',
    time: { updated: now, busy: 0 },
    location: { directory: WS_B }
  },
  // WS_D: busy for 45 minutes yet still ≥80 → the only wake-up case.
  ses_d1: {
    id: 'ses_d1',
    agent: 'build',
    title: '11-17-worker-store worker store state machine 修复',
    time: { updated: now - 60_000, busy: now - 45 * 60_000, idle: 0 },
    location: { directory: WS_D }
  },

  // ---- review-fix round fixtures (S31+) ----
  // WS_C: a plain low-score member, so a lapsed spawn lock can be re-claimed
  // by *another* session of the same workspace (B2).
  ses_c_member: {
    id: 'ses_c_member',
    agent: 'build',
    title: 'C 仓旁观会话',
    time: { updated: now - 30 * 60_000, busy: 0 },
    location: { directory: WS_C }
  },
  // WS_F: two candidates ≥80 (serial ask: DECLINE advances to the second one).
  ses_f1: {
    id: 'ses_f1',
    agent: 'build',
    title: '11-17-worker-store worker store 修复',
    time: { updated: now - 60_000, busy: 0 },
    location: { directory: WS_F }
  },
  ses_f2: {
    id: 'ses_f2',
    agent: 'build',
    title: '11-17-worker-store worker store 修复（二）',
    time: { updated: now - 120_000, busy: 0 },
    location: { directory: WS_F }
  },
  // WS_G: same shape, nobody answers → ask-lease timeout path.
  ses_g1: {
    id: 'ses_g1',
    agent: 'build',
    title: '11-17-worker-store worker store 问询超时',
    time: { updated: now - 60_000, busy: 0 },
    location: { directory: WS_G }
  },
  ses_g2: {
    id: 'ses_g2',
    agent: 'build',
    title: '11-17-worker-store worker store 问询超时（二）',
    time: { updated: now - 120_000, busy: 0 },
    location: { directory: WS_G }
  }
};

contexts.set('ses_b1', [toolMessage('packages/state/src/machine/worker/store.ts')]);
contexts.set('ses_d1', [toolMessage('packages/state/src/machine/worker/store.ts')]);
contexts.set('ses_a_target', [toolMessage('packages/machine/src/cfg/impl.ts')]);
contexts.set('ses_f1', [toolMessage('packages/state/src/machine/worker/store.ts')]);
contexts.set('ses_f2', [toolMessage('packages/state/src/machine/worker/store.ts')]);
contexts.set('ses_g1', [toolMessage('packages/state/src/machine/worker/store.ts')]);
contexts.set('ses_g2', [toolMessage('packages/state/src/machine/worker/store.ts')]);

const created = [];
// `collab_grant` / spawn auto-grant go through `ctx.session.update`; the harness
// keeps every patch and can refuse one session's patch on demand (R5).
const patches = [];
const patchFailures = new Set();
let patchFailAll = false;
// `collab_promote` goes through `ctx.session.switchAgent` (`POST …/agent`).
const agentSwitches = [];
const agentFailures = new Set();
let agentFailAll = false;

const ctx = {
  location: { directory: WS_A },
  // R8: writes to another session are opt-in in the package; the grant /
  // promote checks below exercise that path, so opt in explicitly.
  options: { allowWrite: true },
  app: { version: 'test' },
  storage: {
    async get(key) {
      const value = store.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async set(key, value) {
      store.set(key, structuredClone(value));
    },
    async remove(key) {
      store.delete(key);
    },
    async scan() {
      return { entries: [] };
    }
  },
  tool: {
    async transform(callback) {
      callback({ add: definition => tools.push(definition) });
      return { dispose: async () => {} };
    }
  },
  session: {
    async hook(name, callback) {
      hooks[name] = callback;
      return { dispose: async () => {} };
    },
    async get({ sessionID }) {
      if (!sessions[sessionID]) throw new Error(`Session not found: ${sessionID}`);
      return structuredClone(sessions[sessionID]);
    },
    async list({ limit = 20, directory } = {}) {
      const list = Object.values(sessions).filter(info => !directory || info.location?.directory === directory);
      return { data: structuredClone(list.slice(0, limit)) };
    },
    async context({ sessionID }) {
      return structuredClone(contexts.get(sessionID) ?? []);
    },
    async create(input = {}) {
      const info = {
        id: `ses_spawn_${created.length + 1}`,
        agent: input.agent ?? 'build',
        title: input.title ?? '(untitled)',
        time: { created: Date.now(), updated: Date.now() },
        location: { directory: input.location?.directory }
      };
      sessions[info.id] = info;
      created.push(info);
      return structuredClone(info);
    },
    async remove({ sessionID }) {
      delete sessions[sessionID];
    },
    // `PATCH /api/session/{id}` — `permissions` is a whole-set replacement.
    async update(input = {}) {
      const { sessionID } = input;
      if (!sessions[sessionID]) throw new Error(`Session not found: ${sessionID}`);
      if (patchFailAll || patchFailures.has(sessionID)) {
        throw new Error(`HTTP 403: permission patch refused (${sessionID})`);
      }
      if (input.permissions !== undefined) {
        sessions[sessionID].permissions = structuredClone(input.permissions);
        patches.push({ sessionID, permissions: structuredClone(input.permissions) });
      }
      if (input.title !== undefined) sessions[sessionID].title = input.title;
      if (input.archived !== undefined)
        sessions[sessionID].time = { ...sessions[sessionID].time, archived: input.archived ? Date.now() : 0 };
      if (input.metadata !== undefined) sessions[sessionID].metadata = structuredClone(input.metadata);
      return undefined;
    },
    // `POST /api/session/{id}/agent` — `session.switchAgent`.
    async switchAgent(input = {}) {
      const { sessionID, agent } = input;
      if (!sessions[sessionID]) throw new Error(`Session not found: ${sessionID}`);
      if (agentFailAll || agentFailures.has(sessionID)) {
        throw new Error(`HTTP 403: agent switch refused (${sessionID})`);
      }
      sessions[sessionID].agent = agent;
      agentSwitches.push({ sessionID, agent });
      return undefined;
    },
    async prompt(input) {
      prompts.push(input);
      return { id: `msg_${prompts.length}`, delivery: input.delivery };
    },
    async wait() {}
  },
  event: { subscribe: feed }
};

const originalError = console.error;
console.error = () => {}; // plugin setup logs are noise here
await plugin.setup(ctx);
console.error = originalError;

const tool = name => tools.find(definition => definition.name === name);
const call = async (name, input, context = { sessionID: 'ses_aaa', agent: 'build' }) =>
  (await tool(name).execute(input, context)).content;
const push = event => {
  queue.push(event);
  wake?.();
  wake = undefined;
};
const inbound = (sessionID, text, metadata, inboxID) => ({
  type: 'session.inbox.enqueued',
  data: {
    sessionID,
    inboxID,
    item: {
      type: 'user',
      id: `msg_in_${inboxID}`,
      payload: { text, metadata: metadata ? { collab: metadata } : undefined }
    }
  }
});
const contextEvent = (sessionID, messages = []) => ({
  sessionID,
  agent: sessionID === 'ses_bbb' ? 'explore' : 'build',
  system: [],
  messages
});
const settle = (ms = 60) => new Promise(resolveSettle => setTimeout(resolveSettle, ms));
const out = (title, value) => console.log(`\n--- ${title}\n${value}`);
const failure = async (title, fn) => {
  try {
    await fn();
    out(title, '(没有报错 —— 与预期不符)');
  } catch (error) {
    out(title, error.message);
  }
};

// ---------------------------------------------------------------- assertions
// S17–S30 use these so the harness is a real regression gate: it exits 1 when
// any check fails (S1–S16 remain printed-only, unchanged from the previous run).
const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};
const expectFail = async (title, fn, matcher) => {
  const startedAt = Date.now();
  try {
    const value = await fn();
    expect(title, false, `没有报错: ${String(value).replace(/\s+/g, ' ').slice(0, 120)}`);
    return '';
  } catch (error) {
    const message = String(error?.message ?? error);
    expect(title, !matcher || matcher.test(message), `${Date.now() - startedAt}ms / ${message.slice(0, 160)}`);
    return message;
  }
};

// broadcast store helpers (the harness reads the same files the plugin writes)
const bcFile = bid => join(broadcastDir, `${bid}.json`);
const bcRead = bid => JSON.parse(readFileSync(bcFile(bid), 'utf8'));
const bcBids = () => {
  try {
    return readdirSync(broadcastDir).filter(name => name.startsWith('b_') && name.endsWith('.json'));
  } catch {
    return []; // nothing written yet
  }
};
const bidOf = text => /bid=(b_[0-9a-f]+)/.exec(text)?.[1];
/** `score` on the ranking line of `<sid>` (preview/confirmed broadcasts). */
const scoreOf = (text, sid) => Number(new RegExp(`(\\d{1,3})\\s+${sid}\\b`).exec(text)?.[1] ?? -1);
// Permission-grant ledger helpers (same files the plugin writes).
const grantFileOf = sid => join(grantDir, `${sid}.json`);
const grantRead = sid => JSON.parse(readFileSync(grantFileOf(sid), 'utf8'));
const grantExists = sid => existsSync(grantFileOf(sid));
const COLLAB_ACTIONS = internals.COLLAB_TOOL_ACTIONS;
/** The five `*=allow` collab actions currently on a session (sorted). */
const collabAllows = rules =>
  (rules ?? [])
    .filter(rule => COLLAB_ACTIONS.includes(rule.action) && rule.resource === '*' && rule.effect === 'allow')
    .map(rule => rule.action)
    .sort();

// S1: preview shows kind/thread/mode without delivering.
out(
  'S1 send preview (confirm:false)',
  await call('collab_send', { target: 'ses_bbb', text: '预览测试', confirm: false })
);
console.log(`delivered prompts so far: ${prompts.length}`);

// S2: default mode is queue; thread opens.
const sent = await call('collab_send', { target: 'ses_bbb', text: '请处理任务 T', kind: 'request', confirm: true });
out('S2 send confirm (build → explore, mode omitted)', sent);
console.log(`prompt delivery=${prompts.at(-1).delivery} metadata=${JSON.stringify(prompts.at(-1).metadata.collab)}`);
const threadID = /thread=(t_[a-z0-9_]+)/.exec(sent)[1];
out('S2 thread record', JSON.stringify(store.get(`collab/threads/${threadID}`), null, 1));

// S3: read-only agent asking for steer is forced back to queue.
const forced = await call(
  'collab_send',
  { target: 'ses_aaa', text: '只读 agent 强制 queue', mode: 'steer', confirm: true },
  { sessionID: 'ses_bbb', agent: 'explore' }
);
out('S3 send from explore with mode:steer', forced);
console.log(`prompt delivery=${prompts.at(-1).delivery}`);

// S4/S5: inbound recorded → injected once, then never again.
const directThread = 't_manual_0001';
push(
  inbound(
    'ses_aaa',
    `[collab:ses_bbb][request:${directThread}] 需要你复核 X`,
    { from: 'ses_bbb', fromSessionID: 'ses_bbb', cid: 'c_direct_0001', kind: 'request', threadID: directThread },
    'inbox_0001'
  )
);
await settle();
const first = contextEvent('ses_aaa');
await hooks.context(first);
out('S4 first request (message NOT in request)', JSON.stringify(first.system, null, 1));
const second = contextEvent('ses_aaa');
await hooks.context(second);
out('S5 second request (same message again)', JSON.stringify(second.system));

// S6: request already carries the message (metadata cid) → no injection.
push(
  inbound(
    'ses_aaa',
    '[collab:ses_bbb][request:t_manual_0002] 已在请求里的消息',
    { from: 'ses_bbb', fromSessionID: 'ses_bbb', cid: 'c_direct_0002', kind: 'request', threadID: 't_manual_0002' },
    'inbox_0002'
  )
);
await settle();
const withMeta = contextEvent('ses_aaa', [
  {
    role: 'user',
    metadata: { collab: { cid: 'c_direct_0002', kind: 'request', threadID: 't_manual_0002' } },
    parts: [{ type: 'text', text: '[collab:ses_bbb][request:t_manual_0002] 已在请求里的消息' }]
  }
]);
await hooks.context(withMeta);
out('S6 message already in request (metadata cid)', JSON.stringify(withMeta.system));

// S7: metadata unavailable → envelope-text fallback still de-duplicates.
push(inbound('ses_aaa', '[collab:cli-user][note:t_manual_0003] CLI 发来的消息', undefined, 'inbox_0003'));
await settle();
const textOnly = contextEvent('ses_aaa', [
  { role: 'user', parts: [{ type: 'text', text: '[collab:cli-user][note:t_manual_0003] CLI 发来的消息' }] }
]);
await hooks.context(textOnly);
out('S7 message already in request (text fallback, no metadata)', JSON.stringify(textOnly.system));

// S8: reply resolves the counterpart from the thread and marks it answered.
const reply = await call(
  'collab_reply',
  { threadID, text: '已完成 T', confirm: true },
  { sessionID: 'ses_bbb', agent: 'explore' }
);
out('S8 collab_reply from explore', reply);
console.log(`target prompt sessionID=${prompts.at(-1).sessionID} delivery=${prompts.at(-1).delivery}`);
out('S8 thread status', store.get(`collab/threads/${threadID}`).status);

// S9: wait on the thread returns the reply; unknown thread fails fast (F6).
out('S9 collab_wait {threadID} with an existing reply', await call('collab_wait', { threadID, timeoutMs: 1000 }));
await failure('S9 collab_wait {threadID} on an unknown thread (now fails fast)', () =>
  call('collab_wait', { threadID: 't_missing_0000', timeoutMs: 1200 })
);

// S10: inbox returns full text + thread status.
out('S10 collab_inbox (ses_bbb)', await call('collab_inbox', { limit: 5 }, { sessionID: 'ses_bbb', agent: 'explore' }));

// S11: reply without threadID downgrades to a new request, with a note.
const downgraded = await call('collab_send', {
  target: 'ses_bbb',
  text: '忘记带 threadID 的回执',
  kind: 'reply',
  confirm: false
});
out('S11 kind:reply without threadID (preview)', downgraded);

// S12: a request whose thread is already answered is not a reminder.
const answeredThread = 't_answered_0001';
store.set(`collab/threads/${answeredThread}`, {
  threadID: answeredThread,
  fromSession: 'ses_bbb',
  toSession: 'ses_aaa',
  kind: 'request',
  status: 'answered',
  msgs: [
    {
      cid: 'c_ans_0001',
      kind: 'request',
      text: '已完成的请求',
      ts: 1,
      from: 'ses_bbb',
      fromSession: 'ses_bbb',
      toSession: 'ses_aaa'
    }
  ],
  createdAt: 1,
  updatedAt: 1
});
push(
  inbound(
    'ses_aaa',
    `[collab:ses_bbb][request:${answeredThread}] 已完成的请求`,
    { from: 'ses_bbb', fromSessionID: 'ses_bbb', cid: 'c_ans_0001', kind: 'request', threadID: answeredThread },
    'inbox_ans_0001'
  )
);
await settle();
const answeredEvent = contextEvent('ses_aaa');
await hooks.context(answeredEvent);
out('S12 request whose thread is answered', JSON.stringify(answeredEvent.system));

// S13: inbox view of the same session (full text + statuses).
out('S13 collab_inbox (ses_aaa)', await call('collab_inbox', { limit: 5 }));

// S14: guard rails — protect list, self-send, unknown reply thread, bad threadID.
await failure('S14 send to a protected session', () =>
  call('collab_send', { target: 'ses_e1eb91cebffeTv1467ubJLKebk', text: 'x', confirm: true })
);
await failure('S14 send to self', () => call('collab_send', { target: 'ses_aaa', text: 'x', confirm: true }));
await failure('S14 reply on an unknown thread', () =>
  call('collab_reply', { threadID: 't_ghost_0001', text: 'x', confirm: true })
);
await failure('S14 malformed threadID', () =>
  call('collab_send', { target: 'ses_bbb', text: 'x', threadID: 'nope', confirm: true })
);

// S15: collab_list still works and marks protect/self.
out('S15 collab_list', await call('collab_list', { limit: 5 }));

// S16: idle-mode wait keeps its old semantics.
out('S16 collab_wait {target} (idle mode)', await call('collab_wait', { target: 'ses_bbb', timeoutMs: 1000 }));

// ---------------------------------------------------- S17–S22 (regression gate)
// S17/S18 → F1 lineage guard · S19/S20 → F2 participant + reply routing ·
// S21 → F3 thread reuse · S22 → F4 legacy hint + F6 collab_wait validation.

// S17: a *direct* child of a protected session is refused, and collab_list
// marks it `[protected-child]` with its parent — spawning a sub-agent must not
// become a way around BUILTIN_PROTECT.
out("S17 protected session's direct child", '…');
const s17 = await expectFail(
  'S17 send to a direct child is rejected',
  () => call('collab_send', { target: 'ses_child', text: 'x', confirm: true }),
  /protect 名单/
);
expect(
  'S17 rejection names the ancestor + depth 1',
  s17.includes('ses_e1eb91cebffeTv1467ubJLKebk') && s17.includes('第 1 级'),
  s17
);
const s17list = await call('collab_list', { limit: 10 });
out('S17 collab_list', s17list);
const s17line = s17list.split('\n').find(line => line.startsWith('ses_child')) ?? '';
expect(
  'S17 list marks [protected-child] + parent=<short>',
  s17line.includes('[protected-child]') && s17line.includes('parent='),
  s17line
);

// S18: the same guard must walk more than one hop (grandchild of the schema line).
out("S18 protected session's grandchild", '…');
const s18 = await expectFail(
  'S18 send to a grandchild is rejected',
  () => call('collab_send', { target: 'ses_grand', text: 'x', confirm: true }),
  /protect 名单/
);
expect(
  'S18 rejection reports the 2nd-level ancestor',
  s18.includes('第 2 级') && s18.includes('ses_e1eb91cebffeTv1467ubJLKebk'),
  s18
);

// S19: only thread participants may reply / wait. A leaked threadID is not a
// bearer token: `ses_ccc` is unrelated to the thread below.
const s19sent = await call('collab_send', { target: 'ses_bbb', text: 'S19 参与方测试', confirm: true });
const tid19 = /thread=(t_[a-z0-9_]+)/.exec(s19sent)[1];
out('S19 thread', tid19);
await expectFail(
  'S19 non-participant collab_reply is rejected',
  () =>
    call(
      'collab_reply',
      { threadID: tid19, text: '我是第三方伪造的回执', confirm: true },
      { sessionID: 'ses_ccc', agent: 'build' }
    ),
  /不是 .* 的参与方/
);
await expectFail(
  'S19 non-participant collab_wait is rejected',
  () => call('collab_wait', { threadID: tid19, timeoutMs: 1000 }, { sessionID: 'ses_ccc', agent: 'build' }),
  /不是 .* 的参与方/
);

// S20: a reply must be routed to the thread's counterpart; a mismatch is
// refused *before* delivery and must not touch the thread record.
const before20 = structuredClone(store.get(`collab/threads/${tid19}`));
out('S20 reply misrouted to an unrelated target', '…');
await expectFail(
  'S20 kind:reply to a non-counterpart target is rejected',
  () =>
    call(
      'collab_send',
      { target: 'ses_ddd', kind: 'reply', threadID: tid19, text: '错误路由', confirm: true },
      { sessionID: 'ses_bbb', agent: 'explore' }
    ),
  /对端/
);
await expectFail(
  'S20 non-participant kind:reply is rejected',
  () =>
    call(
      'collab_send',
      { target: 'ses_aaa', kind: 'reply', threadID: tid19, text: '伪造', confirm: true },
      { sessionID: 'ses_ccc', agent: 'build' }
    ),
  /参与方/
);
const after20 = store.get(`collab/threads/${tid19}`);
expect(
  'S20 thread not polluted',
  after20.msgs.length === before20.msgs.length && after20.toSession === before20.toSession,
  `msgs ${before20.msgs.length}→${after20.msgs.length}`
);
expect('S20 nothing delivered to the unrelated target', !prompts.some(p => p.sessionID === 'ses_ddd'));
const legit20 = await call(
  'collab_reply',
  { threadID: tid19, text: 'S19/S20 合法回执', confirm: true },
  { sessionID: 'ses_bbb', agent: 'explore' }
);
expect('S20 legit reply still accepted', legit20.includes('status=answered'), legit20.split('\n')[1]);

// S21: reusing a thread must reopen it: status back to `open`, the receiver is
// reminded again, and `collab_wait` must not return the previous round's reply.
const s21sent = await call('collab_send', { target: 'ses_bbb', text: 'S21 round 1', confirm: true });
const tid21 = /thread=(t_[a-z0-9_]+)/.exec(s21sent)[1];
await call(
  'collab_reply',
  { threadID: tid21, text: 'round1-reply', confirm: true },
  { sessionID: 'ses_bbb', agent: 'explore' }
);
const w21a = await call('collab_wait', { threadID: tid21, timeoutMs: 1000 });
expect('S21 round-1 reply is returned', w21a.includes('round1-reply'));
out('S21 second request on the same thread', '…');
const s21again = await call('collab_send', { target: 'ses_bbb', threadID: tid21, text: 'S21 round 2', confirm: true });
expect(
  'S21 second request reopens the thread (open)',
  store.get(`collab/threads/${tid21}`).status === 'open',
  s21again.split('\n')[1]
);
await expectFail(
  'S21 wait does not return the stale reply',
  () => call('collab_wait', { threadID: tid21, timeoutMs: 1000 }),
  /等待回执超时/
);
push(
  inbound(
    'ses_bbb',
    `[collab:ses_aaa][request:${tid21}] S21 round 2`,
    { from: 'ses_aaa', fromSessionID: 'ses_aaa', cid: 'c_s21_round2', kind: 'request', threadID: tid21 },
    'inbox_s21_round2'
  )
);
await settle();
const s21ctx = contextEvent('ses_bbb');
await hooks.context(s21ctx);
expect(
  'S21 reused thread is reminded again',
  JSON.stringify(s21ctx.system).includes(tid21),
  JSON.stringify(s21ctx.system)
);
await call(
  'collab_reply',
  { threadID: tid21, text: 'round2-reply', confirm: true },
  { sessionID: 'ses_bbb', agent: 'explore' }
);
const w21b = await call('collab_wait', { threadID: tid21, timeoutMs: 1000 });
expect('S21 round-2 reply is returned', w21b.includes('round2-reply') && !w21b.includes('round1-reply'));

// S22: legacy CLI message (no `[kind:thread]`, no metadata) must not be given a
// `collab_reply {threadID:"undefined"}` hint; `collab_wait` validates fast.
push(inbound('ses_aaa', '[collab:cli-user] legacy 无 thread 的消息', undefined, 'inbox_legacy_0001'));
await settle();
const s22ctx = contextEvent('ses_aaa');
await hooks.context(s22ctx);
const s22text = JSON.stringify(s22ctx.system);
out('S22 legacy injection', s22text);
expect('S22 legacy message injected', s22text.includes('legacy 无 thread 的消息'));
expect('S22 legacy hint has no collab_reply', !s22text.includes('collab_reply'));
expect('S22 no literal "undefined" threadID', !s22text.includes('undefined'));
const legacyStored = (store.get('collab/inbox/ses_aaa').messages ?? []).find(m => m.id === 'inbox_legacy_0001');
expect('S22 legacy record has no threadID', Boolean(legacyStored) && !legacyStored.threadID);

const badWait = Date.now();
await expectFail(
  'S22 collab_wait malformed threadID fails fast',
  () => call('collab_wait', { threadID: 'not-a-thread', timeoutMs: 5000 }),
  /格式不合法/
);
const ghostWait = Date.now();
await expectFail(
  'S22 collab_wait unknown threadID fails fast',
  () => call('collab_wait', { threadID: 't_ghost_9999', timeoutMs: 5000 }),
  /没有 thread/
);
const ghostElapsed = Date.now() - ghostWait;
expect(
  'S22 both failures are immediate (<500ms)',
  Date.now() - badWait < 500 && ghostElapsed < 500,
  `${Date.now() - badWait}ms`
);

// ================================================================ S23–S30
// The chain: matching score, threshold, atomic claim, idempotency, spawn,
// receipt, lease, listing/injection.

// S23: deterministic score with a `why` breakdown, group membership filtering.
out('S23 broadcast preview (peer, WS_B)', '…');
const s23 = await call(
  'collab_broadcast',
  { workspace: WS_B, issuePath: ISSUE_B, expected: 'implement', confirm: false },
  { sessionID: 'ses_req', agent: 'build' }
);
out('S23 preview', s23);
const s23bid = bidOf(s23);
expect('S23 preview produced a bid', Boolean(s23bid), s23bid);
expect(
  'S23 top candidate is ses_b1 (≥80)',
  scoreOf(s23, 'ses_b1') >= 80,
  s23.split('\n').find(l => l.includes('ses_b1'))
);
const s23line = s23.split('\n').find(line => line.trim().startsWith('85') || line.includes('ses_b1')) ?? '';
expect('S23 why names the matched file', s23line.includes('file:packages/state/src/machine/worker/store.ts'), s23line);
expect('S23 why names the matched title word(s)', /title:(worker|store)/.test(s23line), s23line);
expect('S23 why names the shared task line', s23line.includes('task:11-17-worker-store'), s23line);
expect('S23 why names the agent match', s23line.includes('agent:build'), s23line);
expect('S23 child sessions are not candidates', !s23.includes('ses_b_child'), s23);
expect('S23 protected sessions are not candidates', !s23.includes('ses_e23a4a23fffe4c4m7UQFR8dUL3'), s23);
expect('S23 no prompt is sent while previewing', !prompts.some(p => p.sessionID === 'ses_b1'));
expect('S23 preview wrote nothing to the broadcast dir', !s23bid || !bcBids().includes(`${s23bid}.json`));

// S23b: an idle top-1 gets the file only (0 model calls); busy > 30min gets one
// queued wake-up prompt (WS_D has a single, 45-min-busy candidate).
const s23d = await call(
  'collab_broadcast',
  { workspace: WS_D, issuePath: ISSUE_D, expected: 'implement', confirm: false },
  { sessionID: 'ses_req', agent: 'build' }
);
expect(
  'S23b busy>30min candidate still clears the threshold',
  scoreOf(s23d, 'ses_d1') >= 80,
  s23d.split('\n').find(l => l.includes('ses_d1'))
);
expect('S23b preview announces the wake-up', s23d.includes('补发 1 条 queue prompt'), s23d);
const promptsBeforeD = prompts.length;
const s23dConfirmed = await call(
  'collab_broadcast',
  { workspace: WS_D, issuePath: ISSUE_D, expected: 'implement', confirm: true },
  { sessionID: 'ses_req', agent: 'build' }
);
out('S23b confirm (busy top-1)', s23dConfirmed);
const wokeD = prompts.slice(promptsBeforeD);
expect(
  'S23b exactly one wake prompt',
  wokeD.length === 1 && wokeD[0].sessionID === 'ses_d1',
  JSON.stringify(wokeD.map(p => p.sessionID))
);
expect('S23b wake prompt is queued (never steer)', wokeD[0]?.delivery === 'queue', wokeD[0]?.delivery);
expect(
  'S23b wake prompt carries the hand-off ask',
  /collab_accept \{bid:"b_/.test(wokeD[0]?.text ?? ''),
  wokeD[0]?.text?.slice(0, 160)
);
const bidD = bidOf(s23dConfirmed);
expect(
  'S23b record is open and keeps the ranking',
  bcRead(bidD).state === 'open' && bcRead(bidD).candidates[0].sid === 'ses_d1',
  JSON.stringify(bcRead(bidD).candidates[0])
);

// S24 + S25: WS_B broadcast (state open) → atomic claim, one winner.
const s24 = await call(
  'collab_broadcast',
  { workspace: WS_B, issuePath: ISSUE_B, expected: 'implement', confirm: true },
  { sessionID: 'ses_req', agent: 'build' }
);
out('S24 broadcast confirmed (WS_B)', s24);
const bidB = bidOf(s24);
expect('S24 broadcast file written', bcBids().includes(`${bidB}.json`), bcBids().join(','));
expect(
  'S24 record is open with ranked candidates',
  bcRead(bidB).state === 'open' && bcRead(bidB).candidates.length >= 2
);
expect('S24 idle top-1 gets no prompt (file-only broadcast)', !prompts.some(p => p.sessionID === 'ses_b1'));

const [win1, win2] = await Promise.all([
  call('collab_accept', { bid: bidB, confirm: true }, { sessionID: 'ses_b1', agent: 'build' }),
  call('collab_accept', { bid: bidB, confirm: true }, { sessionID: 'ses_b2', agent: 'explore' })
]);
out('S25 concurrent accept #1', win1);
out('S25 concurrent accept #2', win2);
const winners = [win1, win2].filter(text => text.startsWith('已领取'));
expect('S25 exactly one winner', winners.length === 1, `${winners.length} winner(s)`);
const loserText = [win1, win2].find(text => !text.startsWith('已领取')) ?? '';
expect('S25 loser is told who claimed it', /已被 ses_b[12] 领取/.test(loserText), loserText.split('\n')[0]);
expect(
  'S25 record is acked with the winner',
  bcRead(bidB).state === 'acked' && /^ses_b[12]$/.test(bcRead(bidB).claim.by),
  JSON.stringify(bcRead(bidB).claim)
);
const winnerSid = bcRead(bidB).claim.by;
expect(
  'S25 requester was notified with a note',
  prompts.some(p => p.sessionID === 'ses_req' && /ACCEPT/.test(p.text)),
  'prompts→ses_req'
);
const third = await call('collab_accept', { bid: bidB, confirm: true }, { sessionID: 'ses_b2', agent: 'explore' });
expect('S25 a third accept cannot steal it', /已被 ses_b1 领取|已闭环/.test(third), third.split('\n')[0]);
const acceptPreview = await call(
  'collab_accept',
  { bid: bidB, confirm: false },
  { sessionID: 'ses_b2', agent: 'explore' }
);
expect(
  'S25 preview on a claimed bid reports the state',
  acceptPreview.includes('state=acked') || acceptPreview.includes('已闭环'),
  acceptPreview.split('\n')[0]
);

// S26: idempotency — same content+mtime = same bid; edited proposal = new bid.
const before26 = bcBids().length;
const s26 = await call(
  'collab_broadcast',
  { workspace: WS_B, issuePath: ISSUE_B, expected: 'implement', confirm: true },
  { sessionID: 'ses_req', agent: 'build' }
);
expect(
  'S26 repeated broadcast is idempotent (same bid, no new file)',
  bidOf(s26) === bidB && bcBids().length === before26,
  `${bidOf(s26)} / ${bcBids().length}`
);
expect('S26 repeated broadcast says so', s26.includes('已存在同一内容'), s26.split('\n')[0]);
writeFileSync(
  join(WS_B, 'docs', 'issues', 'fix-worker-store.md'),
  `${readFileSync(join(WS_B, 'docs', 'issues', 'fix-worker-store.md'), 'utf8')}\n\n补充一行。\n`
);
const s26b = await call(
  'collab_broadcast',
  { workspace: WS_B, issuePath: ISSUE_B, expected: 'implement', confirm: false },
  { sessionID: 'ses_req', agent: 'build' }
);
expect(
  'S26 edited proposal yields a new bid',
  bidOf(s26b) !== bidB && Boolean(bidOf(s26b)),
  `${bidOf(s26b)} vs ${bidB}`
);
expect('S26 preview still wrote nothing', !bcBids().includes(`${bidOf(s26b)}.json`));

// S27: concurrent spawn — one session, correct location, explore by default.
const createdBefore = created.length;
const spawnCalls = await Promise.all([
  call(
    'collab_broadcast',
    { workspace: WS_C, issuePath: ISSUE_C, confirm: true },
    { sessionID: 'ses_req', agent: 'build' }
  ),
  call(
    'collab_broadcast',
    { workspace: WS_C, issuePath: ISSUE_C, confirm: true },
    { sessionID: 'ses_req', agent: 'build' }
  )
]);
out('S27 concurrent spawn #1', spawnCalls[0]);
out('S27 concurrent spawn #2', spawnCalls[1]);
const spawns = created.slice(createdBefore);
expect('S27 exactly one session spawned', spawns.length === 1, `${spawns.length} session(s)`);
expect(
  'S27 spawned session carries location.directory',
  spawns[0]?.location?.directory === WS_C,
  JSON.stringify(spawns[0]?.location)
);
expect('S27 spawned session defaults to explore', spawns[0]?.agent === 'explore', spawns[0]?.agent);
expect(
  'S27 spawned session title is impl:<slug>',
  /^impl:fix-nobody-home$/.test(spawns[0]?.title ?? ''),
  spawns[0]?.title
);
const bidC = bidOf(spawnCalls[0]) ?? bidOf(spawnCalls[1]);
expect(
  'S27 record is claimed by the spawned session',
  bcRead(bidC).claim?.kind === 'spawn' && bcRead(bidC).claim.by === spawns[0]?.id,
  JSON.stringify(bcRead(bidC).claim)
);
expect(
  'S27 spawned session received the ask',
  prompts.some(p => p.sessionID === spawns[0]?.id),
  'prompt→spawn'
);
const loserSpawn = spawnCalls.find(text => text.includes('未拉新')) ?? '';
expect(
  'S27 loser does not spawn again',
  loserSpawn.includes('已被') || loserSpawn.includes('未拉新'),
  loserSpawn.split('\n')[0]
);
const createdBeforeE = created.length;
await expectFail(
  'S27 agent:build without agentConfirm is refused',
  () =>
    call(
      'collab_broadcast',
      { workspace: WS_E, issuePath: ISSUE_E, agent: 'build', confirm: true },
      { sessionID: 'ses_req', agent: 'build' }
    ),
  /agentConfirm/
);
expect(
  'S27 refused build spawn created no session',
  created.length === createdBeforeE,
  `${created.length - createdBeforeE}`
);
const buildSpawn = await call(
  'collab_broadcast',
  { workspace: WS_E, issuePath: ISSUE_E, agent: 'build', agentConfirm: true, confirm: true },
  { sessionID: 'ses_req', agent: 'build' }
);
out('S27 build spawn result', buildSpawn);
const buildInfo = created.at(-1);
expect(
  'S27 agent:build with agentConfirm:true spawns a build session',
  buildInfo?.agent === 'build' && buildInfo?.location?.directory === WS_E && created.length === createdBeforeE + 1,
  JSON.stringify(buildInfo)
);

// S28: `[handoff] DONE <bid>` closes the hand-off from the inbox stream.
push(
  inbound(
    'ses_req',
    `[collab:${winnerSid}][note:b_${bidB.slice(2)}] [handoff] DONE ${bidB} shipped-in-abc1234`,
    { from: winnerSid, fromSessionID: winnerSid, cid: 'c_receipt_1', kind: 'note' },
    'inbox_receipt_1'
  )
);
await settle();
expect('S28 receipt moves the bid to done', bcRead(bidB).state === 'done', bcRead(bidB).state);
expect(
  'S28 receipt is recorded with its note',
  (bcRead(bidB).receipt?.note ?? '').includes('abc1234'),
  JSON.stringify(bcRead(bidB).receipt)
);
const s28 = await call('collab_accept', { bid: bidB, confirm: true }, { sessionID: 'ses_b2', agent: 'explore' });
expect('S28 a closed bid cannot be claimed', s28.includes('已闭环'), s28.split('\n')[0]);

// S29: lease expiry → attempts++ / skip / reopen; attempts > 3 → expired.
const leaseRecord = bcRead(bidD);
writeFileSync(
  bcFile(bidD),
  JSON.stringify({
    ...leaseRecord,
    state: 'claimed',
    attempts: 0,
    skipped: [],
    claim: { by: 'ses_d1', kind: 'accept', token: 'k_lease', at: Date.now() - 400_000, leaseMs: 300_000 }
  })
);
const s29 = await call('collab_accept', { bid: bidD, confirm: false }, { sessionID: 'ses_d1', agent: 'build' });
out('S29 after lease expiry', s29);
expect(
  'S29 expired lease reopens with attempts=1',
  bcRead(bidD).attempts === 1 && bcRead(bidD).state === 'open',
  JSON.stringify({ attempts: bcRead(bidD).attempts, state: bcRead(bidD).state })
);
expect('S29 expired holder is skipped', bcRead(bidD).skipped.includes('ses_d1'), JSON.stringify(bcRead(bidD).skipped));
writeFileSync(
  bcFile(bidD),
  JSON.stringify({
    ...bcRead(bidD),
    state: 'claimed',
    attempts: 4,
    claim: { by: 'ses_d1', kind: 'accept', token: 'k_lease2', at: Date.now() - 400_000, leaseMs: 300_000 }
  })
);
await expectFail(
  'S29 attempts > 3 → expired, escalation instead of re-delivery',
  () => call('collab_accept', { bid: bidD, confirm: true }, { sessionID: 'ses_d1', agent: 'build' }),
  /expired/
);
expect('S29 expired state is persisted', bcRead(bidD).state === 'expired', bcRead(bidD).state);

// S30: collab_list{directory} + loc= + [bootstrap]; peer write guard; injection.
const listB = await call('collab_list', { directory: WS_B, limit: 50 });
out('S30 collab_list (WS_B)', listB);
const listLines = listB.split('\n').filter(line => line.startsWith('ses_'));
expect(
  'S30 directory filter only returns that workspace',
  listLines.every(line => line.includes('loc=b')),
  listLines.map(l => l.slice(0, 60)).join(' | ')
);
expect(
  'S30 children stay listed with parent=',
  listLines.some(line => line.startsWith('ses_b_child') && line.includes('parent=')),
  listB
);
const listC = await call('collab_list', { directory: WS_C, limit: 50 });
expect(
  'S30 spawned session is marked [bootstrap]',
  listC.includes('[bootstrap]'),
  listC.split('\n').find(l => l.startsWith('ses_spawn')) ?? listC
);
expect('S30 list shows open hand-offs', listC.includes('未闭环交接'), listC);

await expectFail(
  'S30 peer scope refuses a path outside docs/issues/',
  () =>
    call(
      'collab_broadcast',
      { workspace: WS_B, issuePath: 'app/main.ts', confirm: true },
      { sessionID: 'ses_req', agent: 'build' }
    ),
  /docs\/issues/
);
await expectFail(
  'S30 peer scope refuses a missing proposal',
  () =>
    call(
      'collab_broadcast',
      { workspace: WS_B, issuePath: 'docs/issues/fix-nope.md', confirm: true },
      { sessionID: 'ses_req', agent: 'build' }
    ),
  /不存在/
);

// A broadcast in *this* plugin's own workspace, to prove the receiving side
// sees it exactly once and children / protected lines never do.
const s30 = await call(
  'collab_broadcast',
  { workspace: WS_A, issuePath: ISSUE_A, expected: 'implement', confirm: true },
  { sessionID: 'ses_req', agent: 'build' }
);
const bidA = bidOf(s30);
out('S30 broadcast in own workspace', s30);
const injected1 = contextEvent('ses_a_target');
await hooks.context(injected1);
const injected2 = contextEvent('ses_a_target');
await hooks.context(injected2);
out('S30 injection #1', JSON.stringify(injected1.system));
out('S30 injection #2', JSON.stringify(injected2.system));
expect(
  'S30 broadcast injected into a group member',
  JSON.stringify(injected1.system).includes(bidA),
  JSON.stringify(injected1.system)
);
expect(
  'S30 broadcast injected only once per session',
  !JSON.stringify(injected2.system).includes(bidA),
  JSON.stringify(injected2.system)
);
const injectedChild = contextEvent('ses_a_child');
await hooks.context(injectedChild);
expect(
  'S30 child sessions get no broadcast',
  !JSON.stringify(injectedChild.system).includes(bidA),
  JSON.stringify(injectedChild.system)
);
const injectedProtected = contextEvent('ses_e1eb91cebffeTv1467ubJLKebk');
await hooks.context(injectedProtected);
expect(
  'S30 protected lines get no broadcast',
  !JSON.stringify(injectedProtected.system).includes(bidA),
  JSON.stringify(injectedProtected.system)
);

// Unclosed hand-off → one reminder to its requester, never repeated.
const staleAt = Date.now() - 6 * 60_000;
writeFileSync(
  bcFile(bidA),
  JSON.stringify({
    ...bcRead(bidA),
    state: 'acked',
    claim: { by: 'ses_a_target', kind: 'accept', token: 'k_a', at: staleAt, leaseMs: 300_000 }
  })
);
const remind1 = contextEvent('ses_req');
await hooks.context(remind1);
const remind2 = contextEvent('ses_req');
await hooks.context(remind2);
out('S30 reminder #1', JSON.stringify(remind1.system));
out('S30 reminder #2', JSON.stringify(remind2.system));
expect(
  'S30 unclosed hand-off is reminded to its requester',
  JSON.stringify(remind1.system).includes('交接未闭环'),
  JSON.stringify(remind1.system)
);
expect(
  'S30 reminder happens only once',
  !JSON.stringify(remind2.system).includes('交接未闭环'),
  JSON.stringify(remind2.system)
);

// S30c: local scope — collab_handoff ranks several candidates, reuses the
// thread protocol and records a local bid that a receipt can close.
const promptsBeforeHandoff = prompts.length;
const handoff = await call(
  'collab_handoff',
  {
    text: '11-17-collab-workspace：复核 packages/machine/src/cfg/impl.ts 的广播实现',
    expected: 'review',
    confirm: true
  },
  { sessionID: 'ses_req', agent: 'build' }
);
out('S30c collab_handoff (local, multi-candidate)', handoff);
const bidLocal = bidOf(handoff);
expect(
  'S30c handoff picked the matching session via the score',
  handoff.includes('按匹配分选中 ses_a_target'),
  handoff.split('\n')[1]
);
expect(
  'S30c handoff delivered one queued prompt',
  prompts.length === promptsBeforeHandoff + 1 &&
    prompts.at(-1).sessionID === 'ses_a_target' &&
    prompts.at(-1).delivery === 'queue'
);
const localRecord = bcRead(bidLocal);
expect(
  'S30c local bid is acked with the target + thread',
  localRecord.scope === 'local' &&
    localRecord.state === 'acked' &&
    localRecord.claim.by === 'ses_a_target' &&
    localRecord.threadID.startsWith('t_'),
  JSON.stringify({ scope: localRecord.scope, state: localRecord.state, thread: localRecord.threadID })
);
const localThread = store.get(`collab/threads/${localRecord.threadID}`);
expect(
  'S30c thread is open on the receiver side',
  localThread?.status === 'open' && localThread.toSession === 'ses_a_target',
  JSON.stringify(localThread?.status)
);
push(
  inbound(
    'ses_req',
    `[collab:ses_a_target][note:${localRecord.threadID}] [handoff] DONE ${bidLocal} local-ok`,
    { from: 'ses_a_target', fromSessionID: 'ses_a_target', cid: 'c_receipt_local', kind: 'note' },
    'inbox_receipt_local'
  )
);
await settle();
expect('S30c receipt closes the local bid', bcRead(bidLocal).state === 'done', bcRead(bidLocal).state);

// ================================================ S31–S38 (review-fix round)
// Blockers B1/B2, the R3/R4 ask protocol (B3) and the should-fix items S1–S5.

// A second plugin instance bound to WS_F, so the *peer side* context injection
// can be asserted too (the first instance only serves WS_A's location).
const hooksF = {};
const ctxF = {
  ...ctx,
  location: { directory: WS_F },
  // Tools are registered once by the first instance; this one only needs the hook.
  tool: {
    async transform(callback) {
      callback({ add: () => {} });
      return { dispose: async () => {} };
    }
  },
  session: {
    ...ctx.session,
    async hook(name, callback) {
      hooksF[name] = callback;
      return { dispose: async () => {} };
    }
  },
  // The first instance owns the shared event feed; this one must not steal events.
  event: {
    async *subscribe() {}
  }
};
console.error = () => {};
await plugin.setup(ctxF);
console.error = originalError;

// S31 (B1): a spawned session's own `collab_accept` moves claimed → acked and
// never tells it to report BLOCKED.
out('S31 spawn in WS_H', '…');
const createdBeforeH = created.length;
const spawnH = await call(
  'collab_broadcast',
  { workspace: WS_H, issuePath: ISSUE_H, confirm: true },
  { sessionID: 'ses_req', agent: 'build' }
);
out('S31 spawn result', spawnH);
const bidH = bidOf(spawnH);
const spawnedH = created.at(-1);
expect(
  'S31 spawn created exactly one session at the target location',
  created.length === createdBeforeH + 1 && spawnedH?.location?.directory === WS_H,
  JSON.stringify({ count: created.length - createdBeforeH, loc: spawnedH?.location?.directory })
);
expect(
  'S31 spawned hand-off starts claimed by the new session',
  bcRead(bidH).state === 'claimed' && bcRead(bidH).claim?.by === spawnedH?.id,
  JSON.stringify(bcRead(bidH).claim)
);
const ackH = await call('collab_accept', { bid: bidH, confirm: true }, { sessionID: spawnedH?.id, agent: 'explore' });
out('S31 spawned session collab_accept', ackH);
const afterH = bcRead(bidH);
expect(
  'S31 spawned session accept moves it to acked',
  afterH.state === 'acked' && afterH.claim?.by === spawnedH?.id,
  JSON.stringify({ state: afterH.state, by: afterH.claim?.by })
);
expect('S31 ackedAt is recorded', Number(afterH.ackedAt) > 0, String(afterH.ackedAt));
expect(
  'S31 receipt template is DONE and never BLOCKED',
  ackH.includes(`[handoff] DONE ${bidH}`) && !ackH.includes('BLOCKED'),
  ackH.split('\n').slice(0, 3).join(' / ')
);
expect(
  'S31 requester was told about the ACCEPT',
  prompts.some(p => p.sessionID === 'ses_req' && /ACCEPT/.test(p.text)),
  'prompts→ses_req'
);

// S32 (B2): the spawn lock is owned by the requester, the claim by the spawned
// session. After the lease lapses the lock must be gone and a member may claim.
const spawnedC = bcRead(bidC).claim?.by;
const lockC = join(broadcastDir, `${bidC}.lock`);
expect('S32 spawn lock exists before expiry', existsSync(lockC), lockC);
const cRec = bcRead(bidC);
writeFileSync(bcFile(bidC), JSON.stringify({ ...cRec, claim: { ...cRec.claim, at: Date.now() - 301_000 } }));
const b2preview = await call(
  'collab_accept',
  { bid: bidC, confirm: false },
  { sessionID: 'ses_c_member', agent: 'build' }
);
out('S32 member preview after spawn lease expiry', b2preview);
const afterC = bcRead(bidC);
expect(
  'S32 lapsed spawn reopens: attempts=1, holder skipped',
  afterC.state === 'open' && afterC.attempts === 1 && afterC.skipped.includes(spawnedC),
  JSON.stringify({ state: afterC.state, attempts: afterC.attempts, skipped: afterC.skipped })
);
expect('S32 lapsed spawn releases the lock', !existsSync(lockC), String(existsSync(lockC)));
expect('S32 the loser is no longer told 已被 … 领取', !b2preview.includes('已被'), b2preview.split('\n')[0]);
const b2take = await call('collab_accept', { bid: bidC, confirm: true }, { sessionID: 'ses_c_member', agent: 'build' });
out('S32 member accept after lock release', b2take);
expect(
  'S32 a member can claim once the lock is released',
  b2take.startsWith('已领取') && bcRead(bidC).state === 'acked' && bcRead(bidC).claim?.by === 'ses_c_member',
  b2take.split('\n')[0]
);

// S33 (B3 / R3): one serial ask, DECLINE advances to the next candidate, and
// that candidate really receives the takeover request in its own context.
out('S33 broadcast WS_F (two candidates ≥80)', '…');
const fBroadcast = await call(
  'collab_broadcast',
  { workspace: WS_F, issuePath: ISSUE_F, expected: 'implement', confirm: true },
  { sessionID: 'ses_req', agent: 'build' }
);
out('S33 broadcast', fBroadcast);
const bidF = bidOf(fBroadcast);
expect(
  'S33 only the top-1 candidate is asked (serial)',
  bcRead(bidF).asked?.sid === 'ses_f1' && bcRead(bidF).state === 'open',
  JSON.stringify({ state: bcRead(bidF).state, asked: bcRead(bidF).asked })
);
push(
  inbound(
    'ses_req',
    '[collab:ses_f1][reply:d_1] DECLINE 没余力，这个我接不了',
    { from: 'ses_f1', fromSessionID: 'ses_f1', cid: 'c_decline_1', kind: 'reply' },
    'inbox_decline_1'
  )
);
await settle();
const afterDecline = bcRead(bidF);
out(
  'S33 record after DECLINE',
  JSON.stringify({
    state: afterDecline.state,
    attempts: afterDecline.attempts,
    skipped: afterDecline.skipped,
    asked: afterDecline.asked?.sid
  })
);
expect(
  'S33 DECLINE skips the candidate and counts one attempt',
  afterDecline.attempts === 1 && afterDecline.skipped.includes('ses_f1'),
  JSON.stringify({ attempts: afterDecline.attempts, skipped: afterDecline.skipped })
);
expect(
  'S33 DECLINE asks the next candidate (state stays open)',
  afterDecline.asked?.sid === 'ses_f2' && afterDecline.state === 'open',
  JSON.stringify({ asked: afterDecline.asked?.sid, state: afterDecline.state })
);
const askF = contextEvent('ses_f2');
await hooksF.context(askF);
out('S33 ask injection to the next candidate', JSON.stringify(askF.system));
expect(
  'S33 the next candidate gets the takeover request',
  JSON.stringify(askF.system).includes(bidF) && JSON.stringify(askF.system).includes('接管请求'),
  JSON.stringify(askF.system).slice(0, 200)
);
expect(
  'S33 the ask line explains ACCEPT / DECLINE / lease',
  JSON.stringify(askF.system).includes('DECLINE') && JSON.stringify(askF.system).includes('5 分钟不答'),
  JSON.stringify(askF.system).slice(0, 240)
);
const f2accept = await call('collab_accept', { bid: bidF, confirm: true }, { sessionID: 'ses_f2', agent: 'build' });
out('S33 next candidate accepts', f2accept);
expect(
  'S33 the next candidate can claim it',
  f2accept.startsWith('已领取') && bcRead(bidF).claim?.by === 'ses_f2',
  bcRead(bidF).claim?.by
);

// S36 (S3): receipts match `bid` / full `issuePath` / `threadID` only, and only
// the claimant may close — a bare basename or a third party never does.
push(
  inbound(
    'ses_req',
    '[handoff] DONE fix-worker-store.md byname',
    { from: 'ses_f2', fromSessionID: 'ses_f2', cid: 'c_receipt_basename', kind: 'note' },
    'inbox_receipt_basename'
  )
);
await settle();
expect('S36 a bare basename does not close a hand-off', bcRead(bidF).state === 'acked', bcRead(bidF).state);
push(
  inbound(
    'ses_req',
    '[handoff] DONE docs/issues/fix-worker-store.md wrong-person',
    // ses_b1 claimed another workspace's same-named proposal earlier, but not this one.
    { from: 'ses_b1', fromSessionID: 'ses_b1', cid: 'c_receipt_wrong', kind: 'note' },
    'inbox_receipt_wrong'
  )
);
await settle();
expect('S36 a non-claimant receipt does not close a hand-off', bcRead(bidF).state === 'acked', bcRead(bidF).state);
push(
  inbound(
    'ses_req',
    '[handoff] DONE docs/issues/fix-worker-store.md f2-done',
    { from: 'ses_f2', fromSessionID: 'ses_f2', cid: 'c_receipt_exact', kind: 'note' },
    'inbox_receipt_exact'
  )
);
await settle();
expect(
  'S36 the exact issuePath from the claimant closes it',
  bcRead(bidF).state === 'done' && bcRead(bidF).receipt?.from === 'ses_f2',
  JSON.stringify({ state: bcRead(bidF).state, from: bcRead(bidF).receipt?.from })
);

// S34 (B3 / R4): ask-lease timeout advances exactly like DECLINE; exhausted
// candidates (`attempts > 3` included) → expired, never a spawn.
out('S34 broadcast WS_G (ask timeout)', '…');
const gBroadcast = await call(
  'collab_broadcast',
  { workspace: WS_G, issuePath: ISSUE_G, confirm: true },
  { sessionID: 'ses_req', agent: 'build' }
);
const bidG = bidOf(gBroadcast);
expect('S34 the top-1 candidate is asked', bcRead(bidG).asked?.sid === 'ses_g1', JSON.stringify(bcRead(bidG).asked));
const gRec = bcRead(bidG);
writeFileSync(bcFile(bidG), JSON.stringify({ ...gRec, asked: { ...gRec.asked, at: Date.now() - 301_000 } }));
const gPreview = await call('collab_accept', { bid: bidG, confirm: false }, { sessionID: 'ses_g1', agent: 'build' });
out('S34 preview after ask timeout (forged 5 min ago)', gPreview);
const afterG = bcRead(bidG);
expect(
  'S34 ask timeout skips the candidate and counts one attempt',
  afterG.attempts === 1 && afterG.skipped.includes('ses_g1'),
  JSON.stringify({ attempts: afterG.attempts, skipped: afterG.skipped })
);
expect(
  'S34 ask timeout asks the next candidate',
  afterG.asked?.sid === 'ses_g2' && afterG.state === 'open',
  JSON.stringify({ asked: afterG.asked?.sid, state: afterG.state })
);
const promptsBeforeG = prompts.length;
writeFileSync(
  bcFile(bidG),
  JSON.stringify({ ...bcRead(bidG), asked: { ...bcRead(bidG).asked, at: Date.now() - 301_000 } })
);
const createdBeforeG = created.length;
await expectFail(
  'S34 exhausted candidates → expired (no re-delivery)',
  () => call('collab_accept', { bid: bidG, confirm: true }, { sessionID: 'ses_g1', agent: 'build' }),
  /expired/
);
const afterG2 = bcRead(bidG);
expect(
  'S34 state is expired after exhausting the candidates',
  afterG2.state === 'expired' && afterG2.attempts === 2,
  JSON.stringify({ state: afterG2.state, attempts: afterG2.attempts })
);
expect(
  'S34 an expired hand-off never spawns',
  created.length === createdBeforeG,
  `${created.length - createdBeforeG} spawn(s)`
);
expect(
  'S34 an expired hand-off is not re-delivered',
  prompts.length === promptsBeforeG && !prompts.some(p => p.text.includes(bidG)),
  `${prompts.length - promptsBeforeG} prompt(s)`
);
writeFileSync(
  bcFile(bidG),
  JSON.stringify({
    ...afterG2,
    state: 'open',
    attempts: 3,
    skipped: [],
    asked: { sid: 'ses_g1', at: Date.now() - 301_000, leaseMs: 300_000 }
  })
);
await expectFail(
  'S34 attempts > 3 → expired even with a candidate left',
  () => call('collab_accept', { bid: bidG, confirm: false }, { sessionID: 'ses_g1', agent: 'build' }),
  /expired/
);
expect(
  'S34 attempts > 3 is persisted as attempts=4 / expired',
  bcRead(bidG).state === 'expired' && bcRead(bidG).attempts === 4,
  JSON.stringify({ state: bcRead(bidG).state, attempts: bcRead(bidG).attempts })
);

// S35 (S1): collab_handoff is idempotent — a repeated call neither re-delivers
// nor resurrects a closed hand-off.
const handoffText = 'S35 幂等测试：复核 packages/machine/src/cfg/impl.ts 与 packages/machine/src/cfg/state.ts';
const promptsBeforeH35 = prompts.length;
const handoff1 = await call(
  'collab_handoff',
  { target: 'ses_a_target', text: handoffText, expected: 'review', confirm: true },
  { sessionID: 'ses_req', agent: 'build' }
);
out('S35 first handoff', handoff1);
const bidH1 = bidOf(handoff1);
expect('S35 first call delivers one prompt', prompts.length === promptsBeforeH35 + 1);
const handoff2 = await call(
  'collab_handoff',
  { target: 'ses_a_target', text: handoffText, expected: 'review', confirm: true },
  { sessionID: 'ses_req', agent: 'build' }
);
out('S35 repeated handoff', handoff2);
expect(
  'S35 a repeated handoff is a no-op (same bid, no second delivery)',
  bidOf(handoff2) === bidH1 && prompts.length === promptsBeforeH35 + 1 && handoff2.includes('已存在同一交接'),
  handoff2.split('\n')[0]
);
const h1rec = bcRead(bidH1);
writeFileSync(
  bcFile(bidH1),
  JSON.stringify({ ...h1rec, state: 'done', receipt: { from: 'ses_a_target', at: Date.now(), note: 'sha-1' } })
);
const handoff3 = await call(
  'collab_handoff',
  { target: 'ses_a_target', text: handoffText, expected: 'review', confirm: true },
  { sessionID: 'ses_req', agent: 'build' }
);
out('S35 handoff after the bid was closed', handoff3);
expect(
  'S35 a closed handoff is not resurrected and keeps its receipt',
  handoff3.includes('已闭环') &&
    bcRead(bidH1).state === 'done' &&
    bcRead(bidH1).receipt?.note === 'sha-1' &&
    prompts.length === promptsBeforeH35 + 1,
  JSON.stringify({ state: bcRead(bidH1).state, note: bcRead(bidH1).receipt?.note })
);

// S37 (S2): a host that does not echo `location.directory` must not be trusted;
// the freshly created session is rolled back instead of being recorded as OK.
const realCreate = ctx.session.create;
const realRemove = ctx.session.remove;
const removed = [];
ctx.session.create = async input => {
  const info = await realCreate(input);
  return { ...info, location: undefined };
};
ctx.session.remove = async ({ sessionID }) => {
  removed.push(sessionID);
  return realRemove({ sessionID });
};
await expectFail(
  'S37 spawn without a verifiable landing is refused',
  () =>
    call(
      'collab_broadcast',
      { workspace: WS_I, issuePath: ISSUE_I, confirm: true },
      { sessionID: 'ses_req', agent: 'build' }
    ),
  /落点不对/
);
const ghost = created.at(-1);
expect(
  'S37 the unknown-landing session is rolled back',
  removed.includes(ghost?.id) && !sessions[ghost?.id],
  JSON.stringify({ removed, ghost: ghost?.id })
);
const wsIRecords = bcBids().filter(name => {
  try {
    return JSON.parse(readFileSync(join(broadcastDir, name), 'utf8')).workspace === WS_I;
  } catch {
    return false;
  }
});
expect('S37 a rolled-back spawn leaves no record behind', wsIRecords.length === 0, wsIRecords.join(','));
ctx.session.create = realCreate;
ctx.session.remove = realRemove;

// S38 (S4): a symlinked proposal cannot smuggle an out-of-repo file into the
// global record. (S5) the new guide is listed in the guide index.
const outside = join(dir, 'outside-secret.md');
writeFileSync(outside, '# SECRET outside docs/issues\n');
symlinkSync(outside, join(WS_F, 'docs', 'issues', 'fix-symlink.md'));
await expectFail(
  'S38 a symlinked proposal is refused',
  () =>
    call(
      'collab_broadcast',
      { workspace: WS_F, issuePath: 'docs/issues/fix-symlink.md', confirm: true },
      { sessionID: 'ses_req', agent: 'build' }
    ),
  /软链/
);
if (hasRepoDocs) {
  const guideIndex = readFileSync(join(repo, '.trellis/spec/guides/index.md'), 'utf8');
  expect(
    'S38 the cross-workspace guide is listed in the guide index',
    guideIndex.includes('cross-workspace-collab-guide.md'),
    'guides/index.md'
  );
} else {
  console.log('  – S38 guide-index check skipped (package is not inside the monorepo)');
}

// ================================================ S39–S42 (hardening round)
// The five *behavioural* residual risks of `11-17-collab-hardening` (R1-1 …
// R1-5). R1-6 is documentation-only and is asserted by S43 below.
//
// These cases write the broadcast store directly (the same files the plugin
// reads) instead of going through `collab_broadcast`: they must not depend on
// the score threshold, on spawn behaviour or on how busy a fixture is.

const nowMs = Date.now();
/** A minimal but complete record; `overrides` wins. */
const rawBroadcast = overrides => ({
  scope: 'peer',
  workspace: WS_A,
  issuePath: 'docs/issues/fix-hardening.md',
  title: 'hardening fixture',
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
  createdAt: nowMs,
  updatedAt: nowMs,
  ...overrides
});
const writeRaw = (bid, overrides) =>
  writeFileSync(join(broadcastDir, `${bid}.json`), `${JSON.stringify(rawBroadcast({ bid, ...overrides }), null, 2)}\n`);
const textOf = event => event.system.map(block => String(block?.text ?? '')).join('\n');
const bcExists = bid => existsSync(bcFile(bid));
const lockExists = bid => existsSync(join(broadcastDir, `${bid}.lock`));

// --- S39 (R1-1): a protected session — or a descendant — cannot claim.
const guardBid = 'b_aaaa000000000051';
writeRaw(guardBid, { workspace: WS_A });
const s39Protected = await expectFail(
  'S39 a protected session cannot claim a hand-off',
  () =>
    call(
      'collab_accept',
      { bid: guardBid, confirm: true },
      { sessionID: 'ses_e1eb91cebffeTv1467ubJLKebk', agent: 'build' }
    ),
  /protect 名单/
);
expect('S39 the rejection says the session itself is protected', s39Protected.includes('自身受保护'), s39Protected);
const s39Child = await expectFail(
  "S39 a protected session's child cannot claim either",
  () => call('collab_accept', { bid: guardBid, confirm: true }, { sessionID: 'ses_child', agent: 'trellis-implement' }),
  /protect 名单/
);
expect(
  'S39 the child rejection reports the 1st-level protected ancestor',
  s39Child.includes('第 1 级') && s39Child.includes('ses_e1eb91cebffeTv1467ubJLKebk'),
  s39Child
);
await expectFail(
  'S39 a grandchild is refused on preview too (fail-closed)',
  () =>
    call('collab_accept', { bid: guardBid, confirm: false }, { sessionID: 'ses_grand', agent: 'trellis-implement' }),
  /第 2 级/
);
expect(
  'S39 a refused claim leaves the record open and takes no lock',
  bcRead(guardBid).state === 'open' && !lockExists(guardBid),
  JSON.stringify({ state: bcRead(guardBid).state, lock: lockExists(guardBid) })
);
const s39Member = await call(
  'collab_accept',
  { bid: guardBid, confirm: true },
  { sessionID: 'ses_a_target', agent: 'build' }
);
expect(
  'S39 an ordinary member still claims it',
  s39Member.startsWith('已领取') && bcRead(guardBid).claim?.by === 'ses_a_target',
  s39Member.split('\n')[0]
);

// --- S40 (R1-2 / R1-3): the ask carries the requester sid; DECLINE by bid.
const askBid = 'b_aaaa000000000061';
const siblingBid = 'b_aaaa000000000062';
const askFixture = (bid, askedSid, otherSid) => ({
  workspace: WS_F,
  issuePath: `docs/issues/${bid}.md`,
  title: 'worker store 问询',
  affectedFiles: ['packages/state/src/machine/worker/store.ts'],
  candidates: [
    { sid: askedSid, score: 90, why: ['file:packages/state/src/machine/worker/store.ts'] },
    { sid: otherSid, score: 88, why: ['title:worker'] }
  ],
  asked: { sid: askedSid, at: nowMs, leaseMs: 300_000 }
});
writeRaw(askBid, askFixture(askBid, 'ses_f1', 'ses_f2'));
writeRaw(siblingBid, askFixture(siblingBid, 'ses_f1', 'ses_g2'));
const askEvent = contextEvent('ses_f1');
await hooksF.context(askEvent);
const askText = textOf(askEvent);
out('S40 ask injection', askText);
expect(
  'S40 the takeover request is injected for the asked candidate',
  askText.includes(askBid) && askText.includes('接管请求'),
  askText.slice(0, 200)
);
expect("S40 the ask line writes the requester's full sid", askText.includes('发起方=ses_req'), askText.slice(0, 400));
expect(
  'S40 the ask line gives a runnable collab_send DECLINE (target + bid)',
  askText.includes('collab_send {target:"ses_req"') && askText.includes(`DECLINE ${askBid}`),
  askText.slice(0, 500)
);
// Both askBid and siblingBid wait for ses_f1 → a bid-less DECLINE is ambiguous
// and must not skip either of them.
push(
  inbound(
    'ses_req',
    '[collab:ses_f1][reply:d_amb] DECLINE 没余力，这个我接不了',
    { from: 'ses_f1', fromSessionID: 'ses_f1', cid: 'c_decline_amb', kind: 'reply' },
    'inbox_decline_amb'
  )
);
await settle();
expect(
  'S40 a bid-less DECLINE with two open asks changes nothing',
  bcRead(askBid).attempts === 0 && bcRead(siblingBid).attempts === 0 && bcRead(askBid).asked?.sid === 'ses_f1',
  JSON.stringify({ ask: bcRead(askBid).attempts, sibling: bcRead(siblingBid).attempts })
);
push(
  inbound(
    'ses_req',
    `[collab:ses_f1][reply:d_bid] DECLINE ${askBid} 没余力`,
    { from: 'ses_f1', fromSessionID: 'ses_f1', cid: 'c_decline_bid', kind: 'reply' },
    'inbox_decline_bid'
  )
);
await settle();
const declinedBid = bcRead(askBid);
out(
  'S40 record after `DECLINE <bid>`',
  JSON.stringify({ attempts: declinedBid.attempts, asked: declinedBid.asked?.sid, state: declinedBid.state })
);
expect(
  'S40 a DECLINE carrying the bid advances exactly that hand-off',
  declinedBid.attempts === 1 &&
    declinedBid.skipped.includes('ses_f1') &&
    declinedBid.asked?.sid === 'ses_f2' &&
    declinedBid.state === 'open',
  JSON.stringify({ attempts: declinedBid.attempts, asked: declinedBid.asked?.sid, state: declinedBid.state })
);
expect(
  'S40 the sibling hand-off waiting on the same session is untouched',
  bcRead(siblingBid).attempts === 0 &&
    bcRead(siblingBid).asked?.sid === 'ses_f1' &&
    !bcRead(siblingBid).skipped.includes('ses_f1'),
  JSON.stringify({ attempts: bcRead(siblingBid).attempts, skipped: bcRead(siblingBid).skipped })
);
push(
  inbound(
    'ses_req',
    '[collab:ses_f1][reply:d_ghost] DECLINE b_ffffffffffffffff 没余力',
    { from: 'ses_f1', fromSessionID: 'ses_f1', cid: 'c_decline_ghost', kind: 'reply' },
    'inbox_decline_ghost'
  )
);
await settle();
expect(
  'S40 a DECLINE naming an unknown bid changes nothing',
  bcRead(siblingBid).attempts === 0 && bcRead(siblingBid).asked?.sid === 'ses_f1',
  JSON.stringify({ attempts: bcRead(siblingBid).attempts, asked: bcRead(siblingBid).asked?.sid })
);

// --- S41 (R1-4): collab_list reports the lease verdict without touching state.
const leaseStaleBid = 'b_aaaa000000000071';
const leaseLiveBid = 'b_aaaa000000000072';
writeRaw(leaseStaleBid, {
  workspace: WS_A,
  state: 'claimed',
  claim: { by: 'ses_a_target', kind: 'accept', token: 'k_lease_stale', at: nowMs - 400_000, leaseMs: 300_000 },
  updatedAt: nowMs - 400_000
});
writeFileSync(
  join(broadcastDir, `${leaseStaleBid}.lock`),
  JSON.stringify({ bid: leaseStaleBid, by: 'ses_a_target', token: 'k_lease_stale', at: nowMs - 400_000 })
);
writeRaw(leaseLiveBid, {
  workspace: WS_A,
  state: 'claimed',
  claim: { by: 'ses_a_second', kind: 'accept', token: 'k_lease_live', at: Date.now(), leaseMs: 300_000 }
});
const leaseList = await call('collab_list', { directory: WS_A, limit: 50 });
out('S41 collab_list (lease verdicts)', leaseList);
expect(
  'S41 a lapsed claim is reported as lease=expired',
  new RegExp(`${leaseStaleBid} claimed lease=expired`).test(leaseList),
  leaseList.split('\n').find(line => line.includes(leaseStaleBid)) ?? leaseList
);
expect(
  'S41 a live claim is reported as lease=ok',
  new RegExp(`${leaseLiveBid} claimed lease=ok`).test(leaseList),
  leaseList.split('\n').find(line => line.includes(leaseLiveBid)) ?? leaseList
);
const leaseAfter = bcRead(leaseStaleBid);
expect(
  'S41 listing does not refresh the record (still claimed / attempts=0)',
  leaseAfter.state === 'claimed' && leaseAfter.attempts === 0 && !(leaseAfter.skipped ?? []).length,
  JSON.stringify({ state: leaseAfter.state, attempts: leaseAfter.attempts, skipped: leaseAfter.skipped })
);
expect('S41 listing does not release the claim lock', lockExists(leaseStaleBid), `${leaseStaleBid}.lock`);
expect(
  'S41 the list explains that the verdict is read-only',
  leaseList.includes('不改状态、不删锁'),
  leaseList
    .split('\n')
    .filter(line => line.includes('lease=expired'))
    .join(' | ')
);

// --- S42 (R1-5): pruning keeps `open/claimed/acked` and only trims old done.
const RETENTION_OLD = Date.now() - 8 * 24 * 60 * 60 * 1000;
const pruneBid = n => `b_dead${n.toString(16).padStart(12, '0')}`;
const staleDone = Array.from({ length: 25 }, (_, index) => pruneBid(index + 1));
for (const bid of staleDone) {
  writeRaw(bid, {
    workspace: WS_A,
    state: 'done',
    createdAt: RETENTION_OLD,
    updatedAt: RETENTION_OLD,
    receipt: { from: 'ses_a_target', at: RETENTION_OLD, note: 'old' }
  });
}
const keepOpen = 'b_aaaa000000000081';
const keepClaimed = 'b_aaaa000000000082';
const keepAcked = 'b_aaaa000000000083';
const keepFreshDone = 'b_aaaa000000000084';
writeRaw(keepOpen, {
  workspace: WS_A,
  state: 'open',
  asked: { sid: 'ses_a_second', at: Date.now(), leaseMs: 300_000 },
  updatedAt: RETENTION_OLD
});
writeRaw(keepClaimed, {
  workspace: WS_A,
  state: 'claimed',
  claim: { by: 'ses_a_second', kind: 'accept', token: 'k_keep_claimed', at: Date.now(), leaseMs: 300_000 },
  updatedAt: RETENTION_OLD
});
writeRaw(keepAcked, {
  workspace: WS_A,
  state: 'acked',
  claim: { by: 'ses_a_second', kind: 'accept', token: 'k_keep_acked', at: Date.now(), leaseMs: 300_000 },
  ackedAt: Date.now(),
  updatedAt: RETENTION_OLD
});
writeRaw(keepFreshDone, {
  workspace: WS_A,
  state: 'done',
  updatedAt: Date.now(),
  receipt: { from: 'ses_a_target', at: Date.now(), note: 'fresh' }
});
const survivingStale = () => staleDone.filter(bid => bcExists(bid)).length;
// Each `collab_accept` on an untouched open record performs exactly one write.
const triggerBids = ['b_aaaa000000000091', 'b_aaaa000000000092', 'b_aaaa000000000093'];
for (const bid of triggerBids) writeRaw(bid, { workspace: WS_A });
const triggerWrite = index =>
  call('collab_accept', { bid: triggerBids[index], confirm: true }, { sessionID: 'ses_a_target', agent: 'build' });
const noneDecidedLost = () =>
  bcExists(keepOpen) && bcExists(keepClaimed) && bcExists(keepAcked) && bcExists(keepFreshDone);

await triggerWrite(0);
out('S42 after one write', `${survivingStale()}/25 stale records left`);
expect('S42 one write prunes at most 20 records', survivingStale() === 5, `${survivingStale()}/25 left`);
expect(
  'S42 open / claimed / acked records are never pruned',
  noneDecidedLost(),
  JSON.stringify({
    open: bcExists(keepOpen),
    claimed: bcExists(keepClaimed),
    acked: bcExists(keepAcked),
    freshDone: bcExists(keepFreshDone)
  })
);
expect('S42 a decided record inside the 7-day window is kept', bcExists(keepFreshDone), keepFreshDone);
await triggerWrite(1);
expect('S42 the backlog finishes on the next write', survivingStale() === 0, `${survivingStale()}/25 left`);
expect(
  'S42 the undecided records survived both sweeps',
  noneDecidedLost(),
  JSON.stringify({ open: bcExists(keepOpen), claimed: bcExists(keepClaimed), acked: bcExists(keepAcked) })
);
await triggerWrite(2);
expect(
  'S42 a write with nothing to prune deletes nothing',
  survivingStale() === 0 && noneDecidedLost() && bcExists(keepFreshDone),
  JSON.stringify({ stale: survivingStale(), freshDone: bcExists(keepFreshDone) })
);

// --- S43 (R1-6): the guide / docs wording matches the implementation.
if (!hasRepoDocs) {
  console.log('  – S43 doc checks skipped (package is not inside the monorepo)');
} else {
  const guide = readFileSync(join(repo, '.trellis/spec/guides/cross-workspace-collab-guide.md'), 'utf8');
  const collabDoc = readFileSync(join(repo, 'docs/collab.md'), 'utf8');
  expect(
    'S43 the guide documents the accept lineage guard',
    guide.includes('`collab_accept`') && /collab_accept.*protected-child|protected-child.*collab_accept/.test(guide),
    'guide §9'
  );
  expect(
    'S43 the guide documents `DECLINE <bid>` + the full requester sid',
    guide.includes('DECLINE <bid>') && guide.includes('collab_send {target:"<发起方 sid>"'),
    'guide §5.2 / §5.3'
  );
  expect(
    'S43 the guide documents the read-only lease verdict',
    guide.includes('lease=expired') && guide.includes('不改状态'),
    'guide §5.3 / §6'
  );
  expect(
    'S43 the guide documents the pruning policy',
    guide.includes('7 天') && guide.includes('BCAST_PRUNE_LIMIT'),
    'guide §6 / §10'
  );
  expect(
    'S43 the guide points the regression gate at scripts/collab',
    guide.includes('node scripts/collab/handoff-harness.mjs'),
    'guide §11'
  );
  expect(
    'S43 docs/collab.md §12 is in sync (lease / prune / DECLINE bid)',
    collabDoc.includes('lease=expired') && collabDoc.includes('7 天') && collabDoc.includes('DECLINE <bid>'),
    'docs/collab.md §12'
  );
}

// ================================================ S44–S50 (auto-receipt round)
// `11-17-collab-auto-receipt`: the pilot (G1) showed a spawned `explore` session
// answering in its own turn and calling nothing — the bid stayed `claimed`.
// R1 = request / wake / result texts carry accept → receipt → "answering is not
// done"; R2 = a lapsed *spawn* lease reads the counterpart's own answer once and
// closes the bid itself instead of spawning again.
//
// These cases write the broadcast store directly and forge `claim.at`; the
// counterpart's history is faked through `ctx.session.context` (the plugin-side
// mapping of `GET /api/session/{sid}/context`), so no real session is created.

/** One assistant message in the shape `session.context` returns. */
const assistantMessage = (text, at = Date.now(), id = `msg_a_${at}_${text.length}`) => ({
  id,
  type: 'assistant',
  time: { created: at },
  content: [{ type: 'text', text }]
});
const lapsedSpawnClaim = (by, extra = {}) => ({
  by,
  kind: 'spawn',
  token: 'k_auto',
  at: nowMs - 301_000,
  leaseMs: 300_000,
  spawner: 'ses_req',
  ...extra
});
const addSpawnSession = id => {
  sessions[id] = {
    id,
    agent: 'explore',
    title: `impl:${id}`,
    time: { created: nowMs, updated: nowMs, busy: 0 },
    location: { directory: WS_A }
  };
  return id;
};

// --- S44 (R1): three actions, in order, copy-pasteable, in all three texts.
const r1Bid = 'b_aaaa0000000000a0';
writeRaw(r1Bid, { workspace: WS_A, state: 'open', asked: { sid: 'ses_a_second', at: nowMs, leaseMs: 300_000 } });
const r1Event = contextEvent('ses_a_second');
await hooks.context(r1Event);
const r1Text = textOf(r1Event);
out('S44 takeover request', r1Text);
expect(
  'S44 the takeover request numbers the three actions',
  ['①', '②', '③'].every(mark => r1Text.includes(mark)),
  r1Text.slice(0, 240)
);
expect(
  'S44 it writes the full bid and the requester sid',
  r1Text.includes(r1Bid) && r1Text.includes('发起方=ses_req'),
  r1Text.slice(0, 300)
);
expect(
  'S44 step ① is a runnable collab_accept',
  r1Text.includes(`collab_accept {bid:"${r1Bid}", confirm:true}`),
  r1Text.slice(0, 400)
);
expect(
  'S44 step ② gives runnable DONE and BLOCKED receipts to the requester',
  r1Text.includes(`collab_send {target:"ses_req", text:"[handoff] DONE ${r1Bid}`) &&
    r1Text.includes(`collab_send {target:"ses_req", text:"[handoff] BLOCKED ${r1Bid}`),
  r1Text.slice(0, 600)
);
expect(
  'S44 step ③ says an in-session answer is not done',
  r1Text.includes('只分析、不调用工具 = 未完成'),
  r1Text.slice(0, 600)
);
expect(
  'S44 the ask still allows DECLINE with the lease explained',
  r1Text.includes(`DECLINE ${r1Bid}`) && r1Text.includes('5 分钟不答'),
  r1Text.slice(-300)
);
const spawnPrompt = prompts.find(prompt => prompt.sessionID === spawnedH?.id);
expect(
  'S44 the spawn takeover prompt carries the same ①②③ + full sid',
  Boolean(spawnPrompt) &&
    ['①', '②', '③'].every(mark => spawnPrompt.text.includes(mark)) &&
    spawnPrompt.text.includes(`collab_send {target:"ses_req", text:"[handoff] DONE ${bidH}`),
  spawnPrompt?.text?.replace(/\s+/g, ' ').slice(0, 400)
);
expect(
  'S44 the broadcast result repeats ①②③ (requester can re-send verbatim)',
  ['①', '②', '③'].every(mark => spawnH.includes(mark)) &&
    spawnH.includes(`collab_send {target:"ses_req", text:"[handoff] BLOCKED ${bidH}`),
  spawnH.split('\n').slice(-4).join(' | ')
);

// --- S45 (R2): lapsed spawn lease + `[handoff] BLOCKED` in the answer → auto blocked.
const autoBid = 'b_aaaa0000000000a1';
const autoSpawn = addSpawnSession('ses_spawn_auto');
contexts.set(autoSpawn, [
  assistantMessage(`[handoff] BLOCKED ${autoBid} 该提案已实施（f2f8ef52/79eac02d），无需 implement`, nowMs)
]);
writeRaw(autoBid, { workspace: WS_A, state: 'claimed', claim: lapsedSpawnClaim(autoSpawn) });
writeFileSync(
  join(broadcastDir, `${autoBid}.lock`),
  JSON.stringify({ bid: autoBid, by: 'ses_req', token: 'k_auto', claimBy: autoSpawn })
);
const createdBeforeAuto = created.length;
const promptsBeforeAuto = prompts.length;
// H2 (review): only the requester may auto-close, so trigger the refresh the way
// production does — the requester's own `context` hook — never a bystander's.
const autoEvent = contextEvent('ses_req');
await hooks.context(autoEvent);
out('S45 requester context after a lapsed spawn verdict', textOf(autoEvent) || '(no lines)');
const autoAccept = await call(
  'collab_accept',
  { bid: autoBid, confirm: true },
  { sessionID: 'ses_a_second', agent: 'build' }
);
out('S45 accept after a lapsed spawn lease with a verdict', autoAccept);
const afterAuto = bcRead(autoBid);
out(
  'S45 record after auto extraction',
  JSON.stringify({ state: afterAuto.state, attempts: afterAuto.attempts, receipt: afterAuto.receipt })
);
expect(
  'S45 the counterpart verdict closes the hand-off automatically',
  afterAuto.state === 'blocked' && afterAuto.receipt?.auto === true,
  JSON.stringify({ state: afterAuto.state, receipt: afterAuto.receipt })
);
expect(
  'S45 the receipt keeps the source sid + a summary',
  afterAuto.receipt?.from === autoSpawn &&
    afterAuto.receipt?.by === autoSpawn &&
    afterAuto.receipt?.note.includes('已实施'),
  JSON.stringify(afterAuto.receipt)
);
expect(
  'S45 auto-closing does not count an attempt or reopen the bid',
  afterAuto.attempts === 0 && afterAuto.state !== 'open',
  JSON.stringify({ attempts: afterAuto.attempts, state: afterAuto.state })
);
expect(
  'S45 auto-closing spawns nothing',
  created.length === createdBeforeAuto,
  `${created.length - createdBeforeAuto} spawn(s)`
);
expect(
  'S45 auto-closing delivers no new prompt',
  prompts.length === promptsBeforeAuto,
  `${prompts.length - promptsBeforeAuto} prompt(s)`
);
expect(
  'S45 auto-closing releases the spawn lock',
  !lockExists(autoBid),
  `${autoBid}.lock exists=${lockExists(autoBid)}`
);
expect(
  'S45 a later accept simply reports the closed bid',
  autoAccept.includes('已闭环') && autoAccept.includes('state=blocked'),
  autoAccept.split('\n')[0]
);

// --- S46 (R2): keyword fallback — 已实施/无需 → blocked, 完成 → done.
const kwBlockedBid = 'b_aaaa0000000000a2';
const kwDoneBid = 'b_aaaa0000000000a3';
const kwBlockedSid = addSpawnSession('ses_spawn_kw_blocked');
const kwDoneSid = addSpawnSession('ses_spawn_kw_done');
contexts.set(kwBlockedSid, [assistantMessage('核对完 37 处调用点：该提案已实施，无需再改。', nowMs)]);
contexts.set(kwDoneSid, [assistantMessage('实现完成，测试通过。', nowMs)]);
writeRaw(kwBlockedBid, { workspace: WS_A, state: 'claimed', claim: lapsedSpawnClaim(kwBlockedSid) });
writeRaw(kwDoneBid, { workspace: WS_A, state: 'claimed', claim: lapsedSpawnClaim(kwDoneSid) });
const createdBeforeKw = created.length;
const kwEvent = contextEvent('ses_req');
await hooks.context(kwEvent);
const kwText = textOf(kwEvent);
out('S46 requester context after keyword verdicts', kwText || '(no lines)');
const afterKwBlocked = bcRead(kwBlockedBid);
const afterKwDone = bcRead(kwDoneBid);
expect(
  'S46 「已实施/无需」 is read as blocked',
  afterKwBlocked.state === 'blocked' && afterKwBlocked.receipt?.note.includes('已实施'),
  JSON.stringify({ state: afterKwBlocked.state, note: afterKwBlocked.receipt?.note })
);
expect(
  'S46 「完成」 is read as done',
  afterKwDone.state === 'done' && afterKwDone.receipt?.note.includes('完成'),
  JSON.stringify({ state: afterKwDone.state, note: afterKwDone.receipt?.note })
);
expect(
  'S46 a decided hand-off is not reminded to the requester',
  !kwText.includes('交接未闭环'),
  kwText.replace(/\s+/g, ' ').slice(0, 240)
);
expect(
  'S46 keyword extraction spawns nothing',
  created.length === createdBeforeKw,
  `${created.length - createdBeforeKw} spawn(s)`
);

// --- S47 (R2): no verdict → the unchanged reopen / skip / ask path.
const quietSid = addSpawnSession('ses_spawn_quiet');
contexts.set(quietSid, [assistantMessage('我核对了一遍调用点，细节见上面的分析。', nowMs)]);
const noVerdictBid = 'b_aaaa0000000000a4';
writeRaw(noVerdictBid, { workspace: WS_A, state: 'claimed', claim: lapsedSpawnClaim(quietSid) });
writeFileSync(
  join(broadcastDir, `${noVerdictBid}.lock`),
  JSON.stringify({ bid: noVerdictBid, by: 'ses_req', token: 'k_auto', claimBy: quietSid })
);
const quietAccept = await call(
  'collab_accept',
  { bid: noVerdictBid, confirm: true },
  { sessionID: 'ses_a_second', agent: 'build' }
);
const afterQuiet = bcRead(noVerdictBid);
out('S47 accept with no verdict in the answer', quietAccept.split('\n')[0]);
expect(
  'S47 no verdict keeps the old reopen path (attempts+1, holder skipped)',
  afterQuiet.attempts === 1 && afterQuiet.skipped.includes(quietSid),
  JSON.stringify({ attempts: afterQuiet.attempts, skipped: afterQuiet.skipped })
);
expect('S47 no verdict writes no receipt', !afterQuiet.receipt, JSON.stringify(afterQuiet.receipt));
expect(
  'S47 the old path still lets a member claim the reopened bid',
  quietAccept.startsWith('已领取') && afterQuiet.claim?.by === 'ses_a_second',
  quietAccept.split('\n')[0]
);
// 「核对完成」 is a report about the reading, not a finished hand-off.
const analysisSid = addSpawnSession('ses_spawn_analysis_only');
contexts.set(analysisSid, [assistantMessage('核对完成，详见上面 37 处调用点的分析。', nowMs)]);
const analysisBid = 'b_aaaa0000000000a8';
writeRaw(analysisBid, { workspace: WS_A, state: 'claimed', claim: lapsedSpawnClaim(analysisSid) });
await call('collab_accept', { bid: analysisBid, confirm: false }, { sessionID: 'ses_a_second', agent: 'build' });
const afterAnalysis = bcRead(analysisBid);
expect(
  'S47 「核对完成」 alone is not read as done',
  afterAnalysis.state === 'open' && afterAnalysis.attempts === 1 && !afterAnalysis.receipt,
  JSON.stringify({ state: afterAnalysis.state, attempts: afterAnalysis.attempts, receipt: afterAnalysis.receipt })
);

// --- S48 (R3): unreadable session / answer-less history never throws.
const ghostBid = 'b_aaaa0000000000a5';
writeRaw(ghostBid, { workspace: WS_A, state: 'claimed', claim: lapsedSpawnClaim('ses_missing_404') });
const realSessionContext = ctx.session.context;
ctx.session.context = async (input = {}) => {
  if (input.sessionID === 'ses_missing_404') throw new Error(`Session not found: ${input.sessionID}`);
  return realSessionContext(input);
};
const ghostPreview = await call(
  'collab_accept',
  { bid: ghostBid, confirm: false },
  { sessionID: 'ses_a_second', agent: 'build' }
);
ctx.session.context = realSessionContext;
const afterGhost = bcRead(ghostBid);
out('S48 preview when the claimed session cannot be read', ghostPreview.split('\n')[0]);
expect(
  'S48 a 404 on the counterpart does not throw',
  Boolean(ghostPreview) && ghostPreview.includes(ghostBid),
  ghostPreview.split('\n')[0]
);
expect(
  'S48 a 404 falls back to the old reopen path',
  afterGhost.state === 'open' &&
    afterGhost.attempts === 1 &&
    afterGhost.skipped.includes('ses_missing_404') &&
    !afterGhost.receipt,
  JSON.stringify({ state: afterGhost.state, attempts: afterGhost.attempts, receipt: afterGhost.receipt })
);
const userOnlySid = addSpawnSession('ses_spawn_user_only');
contexts.set(userOnlySid, [
  { id: 'msg_u_only', type: 'user', time: { created: nowMs }, content: [{ type: 'text', text: '开工' }] }
]);
const userOnlyBid = 'b_aaaa0000000000a7';
writeRaw(userOnlyBid, { workspace: WS_A, state: 'claimed', claim: lapsedSpawnClaim(userOnlySid) });
const userOnlyPreview = await call(
  'collab_accept',
  { bid: userOnlyBid, confirm: false },
  { sessionID: 'ses_a_second', agent: 'build' }
);
const afterUserOnly = bcRead(userOnlyBid);
expect(
  'S48 a history without assistant text falls back to the old path',
  Boolean(userOnlyPreview) && afterUserOnly.state === 'open' && afterUserOnly.attempts === 1 && !afterUserOnly.receipt,
  JSON.stringify({ state: afterUserOnly.state, attempts: afterUserOnly.attempts })
);

// --- S49 (R3): the stored summary is ≤200 chars and never the full body.
const longBid = 'b_aaaa0000000000a6';
const longTail = 'TAIL-MARKER-MUST-NOT-BE-STORED';
const longSid = addSpawnSession('ses_spawn_long');
contexts.set(longSid, [assistantMessage(`[handoff] BLOCKED ${longBid} ${'原因很长 '.repeat(120)}${longTail}`, nowMs)]);
writeRaw(longBid, { workspace: WS_A, state: 'claimed', claim: lapsedSpawnClaim(longSid) });
await hooks.context(contextEvent('ses_req')); // H2: the requester's refresh closes it
const afterLong = bcRead(longBid);
out(
  'S49 summary of a very long answer',
  `${String(afterLong.receipt?.note ?? '').length} chars, ends with "…${String(afterLong.receipt?.note ?? '').slice(-16)}"`
);
expect(
  'S49 the stored summary is capped at 200 characters',
  afterLong.state === 'blocked' && String(afterLong.receipt?.note ?? '').length <= 200,
  `${String(afterLong.receipt?.note ?? '').length} chars`
);
expect(
  'S49 the summary drops the bid and keeps the tail of the answer out of the file',
  String(afterLong.receipt?.note ?? '').startsWith('原因很长') && !JSON.stringify(afterLong).includes(longTail),
  JSON.stringify(afterLong.receipt?.note ?? '').slice(0, 120)
);

// --- S50 (R2/R3): only a *lapsed spawn* claim is extracted; protected never is.
const freshSid = addSpawnSession('ses_spawn_fresh');
contexts.set(freshSid, [assistantMessage(`[handoff] BLOCKED ${'b_aaaa0000000000b1'} 已实施`, nowMs)]);
const freshBid = 'b_aaaa0000000000b1';
writeRaw(freshBid, {
  workspace: WS_A,
  state: 'claimed',
  claim: { by: freshSid, kind: 'spawn', token: 'k_fresh', at: Date.now(), leaseMs: 300_000, spawner: 'ses_req' }
});
await call('collab_accept', { bid: freshBid, confirm: false }, { sessionID: 'ses_a_second', agent: 'build' });
const afterFresh = bcRead(freshBid);
expect(
  'S50 a live spawn lease is never extracted',
  afterFresh.state === 'claimed' && afterFresh.attempts === 0 && !afterFresh.receipt,
  JSON.stringify({ state: afterFresh.state, attempts: afterFresh.attempts })
);
contexts.set('ses_a_target', [
  ...(contexts.get('ses_a_target') ?? []),
  assistantMessage('[handoff] DONE 复核完成，无问题', nowMs)
]);
const acceptKindBid = 'b_aaaa0000000000b2';
writeRaw(acceptKindBid, {
  workspace: WS_A,
  state: 'claimed',
  claim: { by: 'ses_a_target', kind: 'accept', token: 'k_accept_kind', at: nowMs - 301_000, leaseMs: 300_000 }
});
await call('collab_accept', { bid: acceptKindBid, confirm: false }, { sessionID: 'ses_a_second', agent: 'build' });
const afterAcceptKind = bcRead(acceptKindBid);
expect(
  'S50 a lapsed accept-kind claim is not extracted either',
  afterAcceptKind.state === 'open' && afterAcceptKind.attempts === 1 && !afterAcceptKind.receipt,
  JSON.stringify({ state: afterAcceptKind.state, attempts: afterAcceptKind.attempts })
);
const protectedSid = 'ses_e1eb91cebffeTv1467ubJLKebk';
contexts.set(protectedSid, [assistantMessage('[handoff] DONE 已处理', nowMs)]);
const protectedBid = 'b_aaaa0000000000b3';
writeRaw(protectedBid, { workspace: WS_A, state: 'claimed', claim: lapsedSpawnClaim(protectedSid) });
await call('collab_accept', { bid: protectedBid, confirm: false }, { sessionID: 'ses_a_second', agent: 'build' });
const afterProtected = bcRead(protectedBid);
expect(
  'S50 a protected claimant is never read and never auto-closed',
  afterProtected.state === 'open' && afterProtected.attempts === 1 && !afterProtected.receipt,
  JSON.stringify({ state: afterProtected.state, attempts: afterProtected.attempts, receipt: afterProtected.receipt })
);

// --- S51 (H1, review): an echoed template or a negation never closes a bid.
// The R1 prompt itself contains `[handoff] DONE <bid> <摘要>`, so the most likely
// "answer" of a session that did nothing is a verbatim echo of that line. Every
// case here must keep the old lease path (open + attempts=1 + no receipt).
const h1CreatedBefore = created.length;
const h1PromptsBefore = prompts.length;
const seedLapsedSpawn = (bid, sid) => {
  writeRaw(bid, { workspace: WS_A, state: 'claimed', claim: lapsedSpawnClaim(sid) });
  writeFileSync(
    join(broadcastDir, `${bid}.lock`),
    JSON.stringify({ bid, by: 'ses_req', token: 'k_auto', claimBy: sid })
  );
};
const h1Cases = [
  [
    'a template echo with <bid>/<摘要> placeholders',
    '完成后我会发：`[handoff] DONE <bid> <摘要>`，先确认一下环境。',
    'b_aaaa0000000000c1'
  ],
  [
    'a template echo carrying a foreign bid',
    '回执格式 [handoff] DONE b_aaaa0000000000c9 <摘要> —— 但我还没开始。',
    'b_aaaa0000000000c2'
  ],
  ['a negated receipt', '我不会发 [handoff] DONE，因为环境起不来。', 'b_aaaa0000000000c3'],
  ['「任务未完成」', '任务未完成，卡在权限问题上', 'b_aaaa0000000000c4'],
  ['「无法完成」', '无法完成，需要人接手', 'b_aaaa0000000000c5'],
  ['「not done yet」', 'not done yet, blocked by permissions', 'b_aaaa0000000000c6'],
  ['a `[handoff] DONE` line for another bid', '[handoff] DONE b_aaaa0000000000c9 已完成', 'b_aaaa0000000000c7'],
  ['a `[handoff] DONE` line with no target', '[handoff] DONE 已完成', 'b_aaaa0000000000c8']
];
for (const [label, text, bid] of h1Cases) {
  const sid = addSpawnSession(`ses_spawn_h1_${bid.slice(-2)}`);
  contexts.set(sid, [assistantMessage(text, nowMs)]);
  seedLapsedSpawn(bid, sid);
  await hooks.context(contextEvent('ses_req'));
  const record = bcRead(bid);
  out(`S51 ${label}`, JSON.stringify({ state: record.state, attempts: record.attempts, receipt: record.receipt }));
  expect(
    `S51 ${label} is not auto-closed`,
    record.state === 'open' && record.attempts === 1 && !record.receipt && !lockExists(bid),
    JSON.stringify({ state: record.state, attempts: record.attempts, receipt: record.receipt })
  );
}
// The failure mode the review found: template in answer #1, "not started" in #2.
// Only the last answer with real text may be judged — never a scan-back.
const echoThreadBid = 'b_aaaa0000000000ca';
const echoThreadSid = addSpawnSession('ses_spawn_h1_thread');
contexts.set(echoThreadSid, [
  assistantMessage(`我会按提示发 [handoff] DONE ${echoThreadBid} <摘要>。`, nowMs - 1000),
  assistantMessage('环境起不来，我还没开始，需要人接手。', nowMs)
]);
seedLapsedSpawn(echoThreadBid, echoThreadSid);
await hooks.context(contextEvent('ses_req'));
const afterEchoThread = bcRead(echoThreadBid);
out(
  'S51 template echo in #1 + "not started" in #2',
  JSON.stringify({ state: afterEchoThread.state, attempts: afterEchoThread.attempts })
);
expect(
  'S51 an echo in an older answer never outvotes the last answer',
  afterEchoThread.state === 'open' && afterEchoThread.attempts === 1 && !afterEchoThread.receipt,
  JSON.stringify({ state: afterEchoThread.state, attempts: afterEchoThread.attempts })
);
// …and an older genuine verdict is no longer adopted either (last answer only).
const staleVerdictBid = 'b_aaaa0000000000cb';
const staleVerdictSid = addSpawnSession('ses_spawn_h1_stale');
contexts.set(staleVerdictSid, [
  assistantMessage(`[handoff] DONE ${staleVerdictBid} 已修复`, nowMs - 1000),
  assistantMessage('我再核对一遍调用点，细节见上面的分析。', nowMs)
]);
seedLapsedSpawn(staleVerdictBid, staleVerdictSid);
await hooks.context(contextEvent('ses_req'));
const afterStaleVerdict = bcRead(staleVerdictBid);
expect(
  'S51 a verdict superseded by a later (undecided) answer is not adopted',
  afterStaleVerdict.state === 'open' && afterStaleVerdict.attempts === 1 && !afterStaleVerdict.receipt,
  JSON.stringify({ state: afterStaleVerdict.state, attempts: afterStaleVerdict.attempts })
);
// A genuine receipt that names the current bid still closes — with the right state.
const trueDoneBid = 'b_aaaa0000000000cc';
const trueDoneSid = addSpawnSession('ses_spawn_h1_done');
contexts.set(trueDoneSid, [assistantMessage(`[handoff] DONE ${trueDoneBid} 已修复并提交 79eac02d`, nowMs)]);
seedLapsedSpawn(trueDoneBid, trueDoneSid);
const trueBlockedBid = 'b_aaaa0000000000cd';
const trueBlockedSid = addSpawnSession('ses_spawn_h1_blocked');
contexts.set(trueBlockedSid, [assistantMessage(`[handoff] BLOCKED ${trueBlockedBid} 该提案已实施，无需改动`, nowMs)]);
seedLapsedSpawn(trueBlockedBid, trueBlockedSid);
await hooks.context(contextEvent('ses_req'));
const afterTrueDone = bcRead(trueDoneBid);
const afterTrueBlocked = bcRead(trueBlockedBid);
out(
  'S51 genuine receipts targeting the current bid',
  JSON.stringify({
    done: { state: afterTrueDone.state, note: afterTrueDone.receipt?.note },
    blocked: { state: afterTrueBlocked.state, note: afterTrueBlocked.receipt?.note }
  })
);
expect(
  'S51 a real `[handoff] DONE <current bid>` closes as done',
  afterTrueDone.state === 'done' &&
    afterTrueDone.receipt?.auto === true &&
    afterTrueDone.receipt.note.includes('已修复'),
  JSON.stringify({ state: afterTrueDone.state, note: afterTrueDone.receipt?.note })
);
expect(
  'S51 a real `[handoff] BLOCKED <current bid>` closes as blocked',
  afterTrueBlocked.state === 'blocked' &&
    afterTrueBlocked.receipt?.auto === true &&
    afterTrueBlocked.receipt.note.includes('已实施'),
  JSON.stringify({ state: afterTrueBlocked.state, note: afterTrueBlocked.receipt?.note })
);
// A tool-only last message is skipped: the last answer *with text* is judged.
const toolTailBid = 'b_aaaa0000000000ce';
const toolTailSid = addSpawnSession('ses_spawn_h1_tooltail');
contexts.set(toolTailSid, [
  assistantMessage(`[handoff] DONE ${toolTailBid} 实现完成，测试通过。`, nowMs - 1000),
  toolMessage('apps/pos/src/main.ts', nowMs)
]);
seedLapsedSpawn(toolTailBid, toolTailSid);
await hooks.context(contextEvent('ses_req'));
const afterToolTail = bcRead(toolTailBid);
expect(
  'S51 a tool-only last message falls back to the last answer with text',
  afterToolTail.state === 'done' && afterToolTail.receipt?.auto === true,
  JSON.stringify({ state: afterToolTail.state, note: afterToolTail.receipt?.note })
);
expect(
  'S51 no H1 case spawns a session or prompts anyone',
  created.length === h1CreatedBefore && prompts.length === h1PromptsBefore,
  `created+${created.length - h1CreatedBefore} prompts+${prompts.length - h1PromptsBefore}`
);

// --- S52 (H2, review): only the requester's own refresh may auto-close.
const readLog = [];
const contextBeforeBystander = ctx.session.context;
ctx.session.context = async (input = {}) => {
  readLog.push(String(input?.sessionID ?? ''));
  return contextBeforeBystander(input);
};
const bystanderBid = 'b_aaaa0000000000d1';
const bystanderSid = addSpawnSession('ses_spawn_h2');
contexts.set(bystanderSid, [assistantMessage(`[handoff] DONE ${bystanderBid} 已修复`, nowMs)]);
seedLapsedSpawn(bystanderBid, bystanderSid);
sessions.ses_h2_bystander = {
  id: 'ses_h2_bystander',
  agent: 'build',
  title: 'bystander',
  time: { created: nowMs, updated: nowMs, busy: 0 },
  location: { directory: WS_A }
};
sessions.ses_h2_other_ws = {
  id: 'ses_h2_other_ws',
  agent: 'build',
  title: 'bystander of another workspace',
  time: { created: nowMs, updated: nowMs, busy: 0 },
  location: { directory: WS_B }
};
readLog.length = 0;
await hooks.context(contextEvent('ses_h2_bystander'));
const afterBystander = bcRead(bystanderBid);
out(
  'S52 a same-workspace bystander triggers a refresh',
  JSON.stringify({ read: readLog.includes(bystanderSid), state: afterBystander.state })
);
expect(
  "S52 a bystander never reads the counterpart's answer",
  !readLog.includes(bystanderSid),
  readLog.join(',') || '(no reads)'
);
expect(
  'S52 a bystander never closes the bid (old lease path only)',
  afterBystander.state === 'open' && afterBystander.attempts === 1 && !afterBystander.receipt,
  JSON.stringify({ state: afterBystander.state, attempts: afterBystander.attempts, receipt: afterBystander.receipt })
);
readLog.length = 0;
await hooks.context(contextEvent('ses_h2_other_ws'));
const afterOtherWs = bcRead(bystanderBid);
expect(
  'S52 a session of another workspace never reads or closes either',
  !readLog.includes(bystanderSid) && afterOtherWs.state === 'open' && !afterOtherWs.receipt,
  JSON.stringify({ read: readLog.includes(bystanderSid), state: afterOtherWs.state })
);
const requesterBid = 'b_aaaa0000000000d2';
const requesterSpawn = addSpawnSession('ses_spawn_h2_owner');
contexts.set(requesterSpawn, [assistantMessage(`[handoff] BLOCKED ${requesterBid} 已实施，无需改动`, nowMs)]);
seedLapsedSpawn(requesterBid, requesterSpawn);
readLog.length = 0;
await hooks.context(contextEvent('ses_req'));
const afterRequester = bcRead(requesterBid);
expect(
  "S52 the requester's own refresh reads the answer and closes the bid",
  readLog.includes(requesterSpawn) && afterRequester.state === 'blocked' && afterRequester.receipt?.auto === true,
  JSON.stringify({ read: readLog.includes(requesterSpawn), state: afterRequester.state })
);
ctx.session.context = contextBeforeBystander;

// --- S53 (H1 round 2, review): a verbatim echo of the R1 command is not a receipt.
// R1 itself prints `text:"[handoff] DONE <bid> <摘要>", confirm:true}` inside the
// counterpart's prompt, so copying that line leaves `", confirm:true}` (or
// backticks / `（以上是示例）` / `【<原因>】`) right after the placeholder. The old
// exact match (`^<…>$`) missed those and closed the bid as a real verdict.
const s53CreatedBefore = created.length;
const s53PromptsBefore = prompts.length;
const echoCasesR2 = [
  [
    'a verbatim echo of the R1 command (incl. `", confirm:true}`)',
    b => `回执命令是 collab_send {target:"ses_req", text:"[handoff] DONE ${b} <摘要>", confirm:true}`,
    'b_aaaa0000000000e1'
  ],
  [
    'the R1 ② line copied whole after an acknowledgement',
    b =>
      `收到交接。执行：② 回执（必发，二选一）: collab_send {target:"ses_req", text:"[handoff] DONE ${b} <摘要>", confirm:true}`,
    'b_aaaa0000000000e2'
  ],
  ['a template echo + trailing prose', b => `[handoff] DONE ${b} <摘要>（以上是示例）`, 'b_aaaa0000000000e3'],
  [
    'a BLOCKED template with the placeholder in full-width brackets',
    b => `[handoff] BLOCKED ${b} 【<原因>】等确认后发`,
    'b_aaaa0000000000e4'
  ],
  ['a backtick-wrapped placeholder summary', b => `[handoff] DONE ${b} \`<摘要>\``, 'b_aaaa0000000000e5'],
  [
    'a BLOCKED template echo with `", confirm:true}`',
    b => `格式：text:"[handoff] BLOCKED ${b} <原因>", confirm:true`,
    'b_aaaa0000000000e6'
  ]
];
for (const [label, make, bid] of echoCasesR2) {
  const sid = addSpawnSession(`ses_spawn_s53_${bid.slice(-2)}`);
  contexts.set(sid, [assistantMessage(make(bid), nowMs)]);
  seedLapsedSpawn(bid, sid);
  await hooks.context(contextEvent('ses_req'));
  const record = bcRead(bid);
  out(`S53 ${label}`, JSON.stringify({ state: record.state, attempts: record.attempts, receipt: record.receipt }));
  expect(
    `S53 ${label} is not auto-closed`,
    record.state === 'open' && record.attempts === 1 && !record.receipt && !lockExists(bid),
    JSON.stringify({ state: record.state, attempts: record.attempts, receipt: record.receipt })
  );
}
// Positive control: a genuine summary (no `<…>` left) still closes the bid.
const s53TrueBid = 'b_aaaa0000000000e7';
const s53TrueSid = addSpawnSession('ses_spawn_s53_true');
contexts.set(s53TrueSid, [assistantMessage(`[handoff] DONE ${s53TrueBid} 修好了`, nowMs)]);
seedLapsedSpawn(s53TrueBid, s53TrueSid);
await hooks.context(contextEvent('ses_req'));
const afterS53True = bcRead(s53TrueBid);
out(
  'S53 a genuine receipt next to the echoes',
  JSON.stringify({ state: afterS53True.state, note: afterS53True.receipt?.note })
);
expect(
  'S53 a real `[handoff] DONE <current bid> 修好了` still closes',
  afterS53True.state === 'done' && afterS53True.receipt?.auto === true && afterS53True.receipt.note === '修好了',
  JSON.stringify({ state: afterS53True.state, note: afterS53True.receipt?.note })
);
expect(
  'S53 the echoes spawn nothing and prompt nobody',
  created.length === s53CreatedBefore && prompts.length === s53PromptsBefore,
  `created+${created.length - s53CreatedBefore} prompts+${prompts.length - s53PromptsBefore}`
);

// ================================================================= S54–S60
// Session-level permission patch (`11-17-collab-grant`, R1–R5):
//   S54  spawn auto-grants exactly the 5 collab_* allows on the *new* session
//   S55  no pre-existing session is patched (default path stays untouched)
//   S56  grant merges: existing read/grep stay, a pre-existing collab_list deny
//        is not widened, only the 4 missing actions are appended
//   S57  idempotent re-grant, then revoke restores the recorded snapshot
//   S58  whitelist: only the 5 collab actions may be added (unit level)
//   S59  protected sessions and their descendants are refused
//   S60  a refused PATCH is reported but never blocks the hand-off (R5)
const baselinePermissions = new Map(Object.entries(sessions).map(([id, info]) => [id, info.permissions]));

// --- S54: spawn → auto-grant on the spawned session only
const patchesBeforeS54 = patches.length;
const createdBeforeS54 = created.length;
const s54 = await call(
  'collab_broadcast',
  { workspace: WS_J, issuePath: ISSUE_J, confirm: true },
  { sessionID: 'ses_req', agent: 'build' }
);
out('S54 spawn + auto-grant', s54);
const s54Spawn = created.at(-1);
const s54Bid = bidOf(s54);
const s54Rules = sessions[s54Spawn?.id]?.permissions ?? [];
expect(
  'S54 spawn created one session in the target workspace',
  created.length === createdBeforeS54 + 1 && s54Spawn?.location?.directory === WS_J,
  `${created.length - createdBeforeS54} / ${s54Spawn?.location?.directory}`
);
expect(
  'S54 the spawned session carries exactly the 5 collab_* allow rules',
  JSON.stringify(collabAllows(s54Rules)) === JSON.stringify([...COLLAB_ACTIONS].sort()) && s54Rules.length === 5,
  JSON.stringify(s54Rules)
);
expect(
  'S54 no edit/write/shell/read capability was added',
  !s54Rules.some(rule => ['edit', 'write', 'shell', 'read', 'grep'].includes(rule.action)),
  JSON.stringify(s54Rules.map(rule => rule.action))
);
expect(
  'S54 exactly one permission PATCH was sent, to the spawned session',
  patches.length === patchesBeforeS54 + 1 && patches.at(-1).sessionID === s54Spawn.id,
  JSON.stringify(patches.slice(patchesBeforeS54).map(patch => patch.sessionID))
);
expect(
  'S54 broadcast record marks permissionGrant=granted',
  bcRead(s54Bid).permissionGrant === 'granted',
  String(bcRead(s54Bid).permissionGrant)
);
expect(
  'S54 ledger keeps the empty `before` snapshot with reason=spawn',
  grantExists(s54Spawn.id) &&
    grantRead(s54Spawn.id).reason === 'spawn' &&
    grantRead(s54Spawn.id).before.length === 0 &&
    grantRead(s54Spawn.id).added.length === 5,
  grantExists(s54Spawn.id) ? JSON.stringify(grantRead(s54Spawn.id)) : '(no ledger file)'
);
expect('S54 spawn output reports the auto grant', s54.includes('已自动授予'), s54.split('\n').slice(0, 4).join(' | '));
expect(
  'S54 spawn never promotes the agent (auto-grant only)',
  sessions[s54Spawn.id]?.agent === 'explore' &&
    !grantRead(s54Spawn.id).agentBefore &&
    !agentSwitches.some(entry => entry.sessionID === s54Spawn.id),
  JSON.stringify({ agent: sessions[s54Spawn.id]?.agent, switches: agentSwitches.length })
);

// --- S55: no pre-existing session was patched on the default path
const touched = new Set(patches.map(patch => patch.sessionID));
const untouchedFails = [...baselinePermissions.entries()].filter(
  ([id, before]) => before === undefined && (sessions[id]?.permissions !== undefined || grantExists(id))
);
expect(
  'S55 sessions that were not spawned/granted keep no session-level rules',
  untouchedFails.length === 0,
  untouchedFails.map(([id]) => id).join(',') || `${touched.size} patched session(s), all spawned/granted`
);
expect(
  'S55 a hand-made session is never patched implicitly',
  !touched.has('ses_aaa') && !touched.has('ses_bbb') && !touched.has('ses_b1') && !touched.has('ses_a_target'),
  [...touched].join(',')
);

// --- S56: grant merges instead of replacing
const mergeBase = [
  { action: 'read', resource: '*', effect: 'allow' },
  { action: 'collab_list', resource: '*', effect: 'deny' },
  { action: 'grep', resource: '*', effect: 'allow' }
];
sessions.ses_merge = {
  id: 'ses_merge',
  agent: 'explore',
  title: 'grant merge fixture',
  permissions: structuredClone(mergeBase),
  time: { updated: now - 5 * 60_000, busy: 0 },
  location: { directory: WS_J }
};
const patchesBeforeS56 = patches.length;
const s56Preview = await call(
  'collab_grant',
  { target: 'ses_merge', confirm: false },
  { sessionID: 'ses_aaa', agent: 'build' }
);
out('S56 grant preview', s56Preview);
expect(
  'S56 preview names the target (id/agent/title/loc) and the missing count',
  s56Preview.includes('ses_merge') &&
    s56Preview.includes('agent=explore') &&
    s56Preview.includes(`loc=${WS_J}`) &&
    s56Preview.includes('grant merge fixture') &&
    s56Preview.includes('仅缺失的 4 条'),
  s56Preview.split('\n').slice(0, 5).join(' | ')
);
expect('S56 preview patched nothing', patches.length === patchesBeforeS56);
const s56 = await call(
  'collab_grant',
  { target: 'ses_merge', confirm: true },
  { sessionID: 'ses_aaa', agent: 'build' }
);
out('S56 grant confirmed', s56);
const s56Rules = sessions.ses_merge.permissions;
expect(
  'S56 existing rules are preserved in order (read, collab_list deny, grep)',
  JSON.stringify(s56Rules.slice(0, 3)) === JSON.stringify(mergeBase),
  JSON.stringify(s56Rules)
);
expect(
  'S56 a pre-existing collab_list deny is not widened to allow',
  s56Rules.filter(rule => rule.action === 'collab_list').length === 1 &&
    s56Rules.find(rule => rule.action === 'collab_list').effect === 'deny',
  JSON.stringify(s56Rules.filter(rule => rule.action === 'collab_list'))
);
expect(
  'S56 the 4 missing collab actions were appended',
  JSON.stringify(collabAllows(s56Rules)) ===
    JSON.stringify([...COLLAB_ACTIONS].filter(action => action !== 'collab_list').sort()),
  JSON.stringify(collabAllows(s56Rules))
);
expect(
  'S56 ledger keeps the 3-rule `before` snapshot',
  grantExists('ses_merge') &&
    JSON.stringify(grantRead('ses_merge').before) === JSON.stringify(mergeBase) &&
    grantRead('ses_merge').reason === 'grant',
  grantExists('ses_merge') ? JSON.stringify(grantRead('ses_merge').before) : '(no ledger file)'
);
expect(
  'S56 no edit/write rule appears in the merged set',
  !s56Rules.some(rule => ['edit', 'write', 'shell'].includes(rule.action)),
  JSON.stringify(s56Rules.map(rule => rule.action))
);

// --- S57: idempotent re-grant, then revoke restores the snapshot
const patchesBeforeS57 = patches.length;
const s57again = await call(
  'collab_grant',
  { target: 'ses_merge', confirm: true },
  { sessionID: 'ses_aaa', agent: 'build' }
);
expect(
  'S57 re-grant is idempotent (no second PATCH, same ruleset)',
  patches.length === patchesBeforeS57 && JSON.stringify(sessions.ses_merge.permissions) === JSON.stringify(s56Rules),
  `patches+${patches.length - patchesBeforeS57}`
);
expect('S57 re-grant reports changed=false', s57again.includes('changed=false'), s57again.split('\n')[0]);
expect(
  'S57 re-grant keeps the first `before` snapshot',
  JSON.stringify(grantRead('ses_merge').before) === JSON.stringify(mergeBase)
);
const s57revokePreview = await call(
  'collab_grant',
  { target: 'ses_merge', revoke: true, confirm: false },
  { sessionID: 'ses_aaa', agent: 'build' }
);
out('S57 revoke preview', s57revokePreview);
expect(
  'S57 revoke preview is read-only and shows the snapshot size',
  patches.length === patchesBeforeS57 && s57revokePreview.includes('将整集恢复为快照的 3 条'),
  s57revokePreview.split('\n').slice(0, 4).join(' | ')
);
const s57revoke = await call(
  'collab_grant',
  { target: 'ses_merge', revoke: true, confirm: true },
  { sessionID: 'ses_aaa', agent: 'build' }
);
out('S57 revoke confirmed', s57revoke);
expect(
  'S57 revoke round-trips to the recorded snapshot',
  JSON.stringify(sessions.ses_merge.permissions) === JSON.stringify(mergeBase),
  JSON.stringify(sessions.ses_merge.permissions)
);
expect('S57 revoke deletes the ledger record', !grantExists('ses_merge'));
const s57again2 = await call(
  'collab_grant',
  { target: 'ses_merge', revoke: true, confirm: true },
  { sessionID: 'ses_aaa', agent: 'build' }
);
expect(
  'S57 a second revoke reports "nothing to restore" instead of throwing',
  s57again2.includes('无可还原'),
  s57again2.split('\n')[0]
);
expect(
  'S57 the failed revoke changed nothing',
  JSON.stringify(sessions.ses_merge.permissions) === JSON.stringify(mergeBase)
);

// --- S58: whitelist / merge units (no host involved)
const whitelistRefusals = [
  ['edit', [{ action: 'edit', resource: '/**', effect: 'allow' }], /白名单/],
  ['write', [{ action: 'write', resource: '/**', effect: 'allow' }], /白名单/],
  ['shell', [{ action: 'shell', resource: '*', effect: 'allow' }], /白名单/],
  ['collab_broadcast', [{ action: 'collab_broadcast', resource: '*', effect: 'allow' }], /白名单/],
  ['collab_list deny', [{ action: 'collab_list', resource: '*', effect: 'deny' }], /allow/]
];
for (const [label, rules, matcher] of whitelistRefusals) {
  let message = '(no error)';
  try {
    internals.assertCollabOnly(rules);
  } catch (error) {
    message = String(error?.message ?? error);
  }
  expect(`S58 ${label} is refused by the whitelist`, matcher.test(message), message);
}
expect(
  'S58 the whitelist accepts exactly the 5 collab allows',
  (() => {
    try {
      const accepted = internals.assertCollabOnly(internals.collabPermissionRules());
      return accepted.length === 5 && accepted.every(rule => rule.effect === 'allow');
    } catch {
      return false;
    }
  })(),
  JSON.stringify(COLLAB_ACTIONS)
);
const mergeUnit = internals.mergeRules(
  [
    { action: 'collab_send', resource: '*', effect: 'deny' },
    { action: 'read', resource: '*', effect: 'allow' }
  ],
  internals.collabPermissionRules()
);
expect(
  'S58 mergeRules keeps base order + precedence and de-duplicates by action+resource',
  JSON.stringify(mergeUnit.slice(0, 2)) ===
    JSON.stringify([
      { action: 'collab_send', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*', effect: 'allow' }
    ]) &&
    mergeUnit.length === 6 &&
    mergeUnit.filter(rule => rule.action === 'collab_send').length === 1,
  JSON.stringify(mergeUnit)
);
expect(
  'S58 normalizeRules drops malformed entries instead of forwarding them',
  internals.normalizeRules([
    { action: 'read', resource: '*', effect: 'allow' },
    { action: '', resource: '*', effect: 'allow' },
    { action: 'grep', resource: '*', effect: 'maybe' },
    null
  ]).length === 1,
  JSON.stringify(
    internals.normalizeRules([
      { action: 'read', resource: '*', effect: 'allow' },
      { action: '', resource: '*', effect: 'allow' },
      { action: 'grep', resource: '*', effect: 'maybe' },
      null
    ])
  )
);

// --- S59: protected sessions / descendants are refused
const patchesBeforeS59 = patches.length;
const protectedMessage = await expectFail(
  'S59 collab_grant refuses a protected session',
  () => call('collab_grant', { target: 'ses_e1eb91cebffeTv1467ubJLKebk', confirm: true }, { sessionID: 'ses_aaa' }),
  /拒绝授权|protect/
);
const childMessage = await expectFail(
  'S59 collab_grant refuses a protected descendant',
  () => call('collab_grant', { target: 'ses_child', confirm: true }, { sessionID: 'ses_aaa' }),
  /拒绝授权|protect/
);
expect(
  'S59 neither refusal wrote a permission PATCH or a ledger file',
  patches.length === patchesBeforeS59 && !grantExists('ses_e1eb91cebffeTv1467ubJLKebk') && !grantExists('ses_child'),
  `${patches.length - patchesBeforeS59} patch(es) / ${protectedMessage.slice(0, 30)} / ${childMessage.slice(0, 30)}`
);

// --- S60: a refused PATCH is reported, the hand-off continues (R5)
sessions.ses_fail = {
  id: 'ses_fail',
  agent: 'explore',
  title: 'grant failure fixture',
  permissions: [{ action: 'read', resource: '*', effect: 'allow' }],
  time: { updated: now - 5 * 60_000, busy: 0 },
  location: { directory: WS_J }
};
patchFailures.add('ses_fail');
const s60Fail = await call(
  'collab_grant',
  { target: 'ses_fail', confirm: true },
  { sessionID: 'ses_aaa', agent: 'build' }
);
out('S60 grant with a refused PATCH', s60Fail);
expect(
  'S60 a refused PATCH is reported (not thrown) and changes nothing',
  s60Fail.includes('未授予权限') &&
    JSON.stringify(sessions.ses_fail.permissions) ===
      JSON.stringify([{ action: 'read', resource: '*', effect: 'allow' }]) &&
    !grantExists('ses_fail'),
  s60Fail.split('\n')[0]
);
patchFailures.delete('ses_fail');
patchFailAll = true;
const createdBeforeS60 = created.length;
const promptsBeforeS60 = prompts.length;
const s60Spawn = await call(
  'collab_broadcast',
  { workspace: WS_K, issuePath: ISSUE_K, confirm: true },
  { sessionID: 'ses_req', agent: 'build' }
);
patchFailAll = false;
out('S60 spawn with a refused auto-grant', s60Spawn);
const s60SpawnId = created.at(-1)?.id;
const s60Bid = bidOf(s60Spawn);
expect(
  'S60 spawn still happens and is still asked to take over',
  created.length === createdBeforeS60 + 1 &&
    prompts.slice(promptsBeforeS60).some(prompt => prompt.sessionID === s60SpawnId),
  `${created.length - createdBeforeS60} session(s), ${prompts.length - promptsBeforeS60} prompt(s)`
);
expect(
  'S60 the failure is recorded, not fatal',
  bcRead(s60Bid).permissionGrant === 'failed' &&
    bcRead(s60Bid).state === 'claimed' &&
    s60Spawn.includes('未授予权限') &&
    !grantExists(s60SpawnId),
  JSON.stringify({ permissionGrant: bcRead(s60Bid).permissionGrant, state: bcRead(s60Bid).state })
);
expect(
  'S60 the spawned session simply has no session-level rules',
  sessions[s60SpawnId]?.permissions === undefined,
  JSON.stringify(sessions[s60SpawnId]?.permissions)
);

// ================================================================= S61–S67
// Agent promotion (`collab_promote`, R7):
//   S61  preview switches nothing and shows `原 agent → 目标 agent`
//   S62  confirm switches explore→build, records agentBefore, is idempotent
//   S63  grant + promote share one ledger file without overwriting each other
//   S64  revert restores the recorded agent and drops only that half
//   S65  agent whitelist (build/plan ok, anything else refused, nothing switched)
//   S66  revert without a record reports "nothing to restore"
//   S67  protected sessions/descendants are refused; a refused switch is readable
sessions.ses_promote = {
  id: 'ses_promote',
  agent: 'explore',
  title: 'promote fixture',
  permissions: [{ action: 'read', resource: '*', effect: 'allow' }],
  time: { updated: now - 5 * 60_000, busy: 0 },
  location: { directory: WS_J }
};
const promoteBase = structuredClone(sessions.ses_promote.permissions);

// --- S61: preview only
const switchesBeforeS61 = agentSwitches.length;
const s61 = await call(
  'collab_promote',
  { target: 'ses_promote', confirm: false },
  { sessionID: 'ses_aaa', agent: 'build' }
);
out('S61 promote preview', s61);
expect(
  'S61 preview shows target (id/agent/title/loc) and 原 agent → 目标 agent',
  s61.includes('ses_promote') &&
    s61.includes(`loc=${WS_J}`) &&
    s61.includes('promote fixture') &&
    s61.includes('原 agent explore → 目标 agent build') &&
    s61.includes('review'),
  s61.split('\n').slice(0, 5).join(' | ')
);
expect(
  'S61 preview switched nothing',
  agentSwitches.length === switchesBeforeS61 && sessions.ses_promote.agent === 'explore',
  `${agentSwitches.length - switchesBeforeS61} switch(es)`
);

// --- S62: confirm → build, record, idempotent
const s62 = await call(
  'collab_promote',
  { target: 'ses_promote', confirm: true },
  { sessionID: 'ses_aaa', agent: 'build' }
);
out('S62 promote confirmed', s62);
expect(
  'S62 confirm switches explore → build and verifies it',
  sessions.ses_promote.agent === 'build' &&
    agentSwitches.at(-1)?.sessionID === 'ses_promote' &&
    agentSwitches.at(-1)?.agent === 'build' &&
    s62.includes('explore → build') &&
    s62.includes('复核(GET agent): build'),
  `${sessions.ses_promote.agent} / ${s62.split('\n')[0]}`
);
expect(
  'S62 ledger records agentBefore/promotedAt/promotedBy without touching permissions',
  grantExists('ses_promote') &&
    grantRead('ses_promote').agentBefore === 'explore' &&
    typeof grantRead('ses_promote').promotedAt === 'number' &&
    typeof grantRead('ses_promote').promotedBy === 'string' &&
    JSON.stringify(sessions.ses_promote.permissions) === JSON.stringify(promoteBase),
  grantExists('ses_promote') ? JSON.stringify(grantRead('ses_promote')) : '(no ledger file)'
);
const switchesBeforeS62b = agentSwitches.length;
const s62b = await call(
  'collab_promote',
  { target: 'ses_promote', agent: 'build', confirm: true },
  { sessionID: 'ses_aaa', agent: 'build' }
);
expect(
  'S62 re-promote to the same agent is a no-op and keeps the first agentBefore',
  agentSwitches.length === switchesBeforeS62b &&
    grantRead('ses_promote').agentBefore === 'explore' &&
    s62b.includes('changed=false'),
  s62b.split('\n')[0]
);

// --- S63: grant and promote share the file, each half survives the other
const s63grant = await call(
  'collab_grant',
  { target: 'ses_promote', confirm: true },
  { sessionID: 'ses_aaa', agent: 'build' }
);
expect(
  'S63 granting a promoted session keeps agentBefore and adds the permission half',
  grantRead('ses_promote').agentBefore === 'explore' &&
    grantRead('ses_promote').before.length === 1 &&
    collabAllows(sessions.ses_promote.permissions).length === 5,
  JSON.stringify({ agentBefore: grantRead('ses_promote').agentBefore, before: grantRead('ses_promote').before })
);
expect(
  'S63 grant output still reports the auto/agent half intact',
  s63grant.includes('已授予'),
  s63grant.split('\n')[0]
);
await call(
  'collab_grant',
  { target: 'ses_promote', revoke: true, confirm: true },
  { sessionID: 'ses_aaa', agent: 'build' }
);
expect(
  'S63 revoking the grant keeps the promote half and restores permissions',
  grantExists('ses_promote') &&
    grantRead('ses_promote').agentBefore === 'explore' &&
    grantRead('ses_promote').before === undefined &&
    JSON.stringify(sessions.ses_promote.permissions) === JSON.stringify(promoteBase),
  grantExists('ses_promote') ? JSON.stringify(grantRead('ses_promote')) : '(ledger deleted!)'
);

// --- S63b: the reverse order — promote after grant keeps the permission half
sessions.ses_both = {
  id: 'ses_both',
  agent: 'explore',
  title: 'grant+promote reverse fixture',
  permissions: [],
  time: { updated: now - 5 * 60_000, busy: 0 },
  location: { directory: WS_J }
};
await call('collab_grant', { target: 'ses_both', confirm: true }, { sessionID: 'ses_aaa', agent: 'build' });
await call('collab_promote', { target: 'ses_both', confirm: true }, { sessionID: 'ses_aaa', agent: 'build' });
expect(
  'S63 granting first then promoting keeps the permission snapshot',
  grantRead('ses_both').agentBefore === 'explore' &&
    grantRead('ses_both').before.length === 0 &&
    grantRead('ses_both').added.length === 5 &&
    sessions.ses_both.agent === 'build',
  JSON.stringify(grantRead('ses_both'))
);
await call('collab_promote', { target: 'ses_both', revert: true, confirm: true }, { sessionID: 'ses_aaa' });
expect(
  'S63 promote revert keeps the permission half (before/added still there)',
  sessions.ses_both.agent === 'explore' &&
    grantExists('ses_both') &&
    grantRead('ses_both').agentBefore === undefined &&
    grantRead('ses_both').added.length === 5,
  grantExists('ses_both') ? JSON.stringify(grantRead('ses_both')) : '(ledger deleted!)'
);
await call('collab_grant', { target: 'ses_both', revoke: true, confirm: true }, { sessionID: 'ses_aaa' });
expect('S63 both halves revoked → the ledger file is gone', !grantExists('ses_both'));

// --- S64: revert
const s64Preview = await call(
  'collab_promote',
  { target: 'ses_promote', revert: true, confirm: false },
  { sessionID: 'ses_aaa', agent: 'build' }
);
expect(
  'S64 revert preview is read-only and shows build → explore',
  s64Preview.includes('build → explore') && sessions.ses_promote.agent === 'build',
  s64Preview.split('\n').slice(0, 4).join(' | ')
);
const s64 = await call(
  'collab_promote',
  { target: 'ses_promote', revert: true, confirm: true },
  { sessionID: 'ses_aaa', agent: 'build' }
);
out('S64 revert confirmed', s64);
expect(
  'S64 revert restores explore and deletes the record',
  sessions.ses_promote.agent === 'explore' && !grantExists('ses_promote') && s64.includes('build → explore'),
  `${sessions.ses_promote.agent} / ${grantExists('ses_promote')}`
);

// --- S65: whitelist
const s65plan = await call(
  'collab_promote',
  { target: 'ses_promote', agent: 'plan', confirm: true },
  { sessionID: 'ses_aaa', agent: 'build' }
);
expect('S65 plan is whitelisted', sessions.ses_promote.agent === 'plan', s65plan.split('\n')[0]);
await call('collab_promote', { target: 'ses_promote', revert: true, confirm: true }, { sessionID: 'ses_aaa' });
expect('S65 revert from plan returns to explore', sessions.ses_promote.agent === 'explore');
const switchesBeforeS65 = agentSwitches.length;
const s65refused = await expectFail(
  'S65 a non-whitelisted agent is refused',
  () =>
    call(
      'collab_promote',
      { target: 'ses_promote', agent: 'trellis-implement', confirm: true },
      { sessionID: 'ses_aaa', agent: 'build' }
    ),
  /白名单/
);
expect(
  'S65 the refusal switched nothing',
  agentSwitches.length === switchesBeforeS65 && sessions.ses_promote.agent === 'explore',
  `${agentSwitches.length - switchesBeforeS65} switch(es) / ${s65refused.slice(0, 40)}`
);

// --- S66: revert without a record
const s66 = await call(
  'collab_promote',
  { target: 'ses_promote', revert: true, confirm: true },
  { sessionID: 'ses_aaa', agent: 'build' }
);
expect(
  'S66 revert without a record reports "nothing to restore" and changes nothing',
  s66.includes('无可还原') && sessions.ses_promote.agent === 'explore',
  s66.split('\n')[0]
);

// --- S67: protected + refused switch
const switchesBeforeS67 = agentSwitches.length;
await expectFail(
  'S67 collab_promote refuses a protected session',
  () => call('collab_promote', { target: 'ses_e23a4a23fffe4c4m7UQFR8dUL3', confirm: true }, { sessionID: 'ses_aaa' }),
  /拒绝切换|protect/
);
await expectFail(
  'S67 collab_promote refuses a protected descendant',
  () => call('collab_promote', { target: 'ses_grand', confirm: true }, { sessionID: 'ses_aaa' }),
  /拒绝切换|protect/
);
expect(
  'S67 neither refusal switched an agent or wrote a ledger file',
  agentSwitches.length === switchesBeforeS67 &&
    !grantExists('ses_e23a4a23fffe4c4m7UQFR8dUL3') &&
    !grantExists('ses_grand'),
  `${agentSwitches.length - switchesBeforeS67} switch(es)`
);
sessions.ses_agentfail = {
  id: 'ses_agentfail',
  agent: 'explore',
  title: 'agent switch failure fixture',
  time: { updated: now - 5 * 60_000, busy: 0 },
  location: { directory: WS_J }
};
agentFailures.add('ses_agentfail');
const s67fail = await call(
  'collab_promote',
  { target: 'ses_agentfail', confirm: true },
  { sessionID: 'ses_aaa', agent: 'build' }
);
agentFailures.delete('ses_agentfail');
out('S67 promote with a refused switch', s67fail);
expect(
  'S67 a refused switch is reported (not thrown), agent unchanged, no ledger',
  s67fail.includes('未切换 agent') && sessions.ses_agentfail.agent === 'explore' && !grantExists('ses_agentfail'),
  s67fail.split('\n')[0]
);

// ================================================ S68 (post-archive B1)
// `11-17-collab-grant` shipped with a grant *preview* that crashed when the
// ledger file held only the promote half: `collab_promote` writes `agentBefore`
// and no permissions snapshot, so `record.added` / `record.before` are
// undefined and the preview's `.join` / `.length` threw
// `TypeError: … reading 'join'`. The preview must report that state instead.
sessions.ses_b1_grant = {
  id: 'ses_b1_grant',
  agent: 'explore',
  title: 'promote-only ledger fixture',
  time: { updated: now - 3 * 60_000, busy: 0 },
  location: { directory: WS_J }
};
const s68Promote = await call(
  'collab_promote',
  { target: 'ses_b1_grant', confirm: true },
  { sessionID: 'ses_aaa', agent: 'build' }
);
out('S68 promote first (promote-only ledger)', s68Promote);
const s68LedgerAfterPromote = grantExists('ses_b1_grant') ? grantRead('ses_b1_grant') : undefined;
expect(
  'S68 promote wrote an agentBefore-only ledger (no permissions half)',
  Boolean(s68LedgerAfterPromote?.agentBefore) && !Array.isArray(s68LedgerAfterPromote?.before),
  JSON.stringify(s68LedgerAfterPromote ?? null)
);

const s68RevokePreview = await call(
  'collab_grant',
  { target: 'ses_b1_grant', revoke: true, confirm: false },
  { sessionID: 'ses_aaa', agent: 'build' }
);
out('S68 grant revoke preview over a promote-only ledger', s68RevokePreview);
expect(
  'S68 revoke preview does not throw and reports 仅有 promote 记录 / 无可还原',
  s68RevokePreview.includes('仅有 promote 记录') && s68RevokePreview.includes('无可还原'),
  s68RevokePreview.split('\n')[0]
);

const s68AddPreview = await call(
  'collab_grant',
  { target: 'ses_b1_grant', confirm: false },
  { sessionID: 'ses_aaa', agent: 'build' }
);
out('S68 grant add-preview over a promote-only ledger', s68AddPreview);
expect(
  'S68 add-preview says the grant half will be written next to the promote half',
  s68AddPreview.includes('仅有 promote 记录') && s68AddPreview.includes('补写 grant 半段'),
  s68AddPreview.split('\n')[0]
);

const s68Grant = await call(
  'collab_grant',
  { target: 'ses_b1_grant', confirm: true },
  { sessionID: 'ses_aaa', agent: 'build' }
);
out('S68 grant over a promote-only ledger', s68Grant);
const s68Ledger = grantRead('ses_b1_grant');
expect(
  'S68 grant keeps both halves in one ledger file',
  Array.isArray(s68Ledger.before) && Array.isArray(s68Ledger.added) && s68Ledger.agentBefore === 'explore',
  JSON.stringify(s68Ledger)
);

const s68Revoke = await call(
  'collab_grant',
  { target: 'ses_b1_grant', revoke: true, confirm: true },
  { sessionID: 'ses_aaa', agent: 'build' }
);
out('S68 revoke over a two-half ledger', s68Revoke);
const s68Leftover = grantRead('ses_b1_grant');
expect(
  'S68 revoke restores permissions and keeps only the promote half',
  s68Revoke.includes('台账保留 promote 半段') &&
    s68Leftover.agentBefore === 'explore' &&
    !Array.isArray(s68Leftover.before),
  JSON.stringify(s68Leftover)
);

const failed = checks.filter(check => !check.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const check of failed) console.log(`FAIL: ${check.title}`);
  process.exit(1);
}
process.exit(0);
