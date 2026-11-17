/**
 * Deterministic harness for the collab hand-off protocol + the hand-off chain
 * (no model calls, no real server).
 *
 *   node .trellis/tasks/11-17-collab-workspace/research/handoff-harness.mjs
 *
 * Copies `.opencode/plugins/collab.js` to a `.mjs` temp file (the repo is not
 * `type: module`) and drives it with a fake plugin ctx: in-memory `ctx.storage`,
 * fake sessions with `location.directory`, fake `ctx.session.context` messages,
 * and a real (temp) `COLLAB_BROADCAST_DIR` so the broadcast/claim code runs on
 * the real filesystem.
 *
 * S1–S22 (unchanged from the archived 11-17-collab-handoff harness) cover the
 * per-session protocol: thread state machine, forced queue, injection
 * de-duplication, guard rails, participant checks.
 *
 * S23–S30 (this task) cover the chain:
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
 * Exits 1 if any assertion-based check fails; S1–S16 stay print-only.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repo = resolve(import.meta.dirname, "../../../..")
const dir = mkdtempSync(join(tmpdir(), "collab-harness-"))
const entry = join(dir, "collab.mjs")
copyFileSync(join(repo, ".opencode/plugins/collab.js"), entry)

// The broadcast store is a global directory; point it at a temp dir so the
// harness never touches ~/.config/opencode/collab-broadcast/.
const broadcastDir = join(dir, "broadcast")
process.env.COLLAB_BROADCAST_DIR = broadcastDir

// ------------------------------------------------------------ fake workspaces
const wsRoot = join(dir, "ws")
const ws = (name) => {
  const workspace = join(wsRoot, name)
  mkdirSync(join(workspace, "docs", "issues"), { recursive: true })
  return workspace
}
const WS_A = ws("a")
const WS_B = ws("b")
const WS_C = ws("c")
const WS_D = ws("d")
const WS_E = ws("e")
// Review-fix round fixtures (S31+).
const WS_F = ws("f") // two candidates ≥80 → serial ask / DECLINE
const WS_G = ws("g") // two candidates ≥80 → ask-lease timeout
const WS_H = ws("h") // empty → spawn, then the spawned session accepts itself
const WS_I = ws("i") // empty → spawn whose landing cannot be verified
const HARNESS_LOCATION = join(dir, "harness")

function issueFile(workspace, name, body) {
  const path = join(workspace, "docs", "issues", name)
  writeFileSync(path, body)
  return `docs/issues/${name}`
}

// WS_B: a proposal that names one file + one Trellis task slug.
const ISSUE_B = issueFile(
  WS_B,
  "fix-worker-store.md",
  [
    "# worker store 修复（11-17-worker-store）",
    "",
    "> 状态：待实施",
    "",
    "## 问题",
    "",
    "`packages/state/src/machine/worker/store.ts` 在并发下丢掉 pending 变更。",
    "",
    "## 涉及文件",
    "",
    "- packages/state/src/machine/worker/store.ts",
  ].join("\n"),
)
// WS_D: same shape, used for the busy>30min wake path.
const ISSUE_D = issueFile(
  WS_D,
  "fix-worker-busy.md",
  "# worker store state machine 修复（11-17-worker-store）\n\n`packages/state/src/machine/worker/store.ts`\n",
)
// WS_C: no sessions at all → spawn path.
const ISSUE_C = issueFile(WS_C, "fix-nobody-home.md", "# nobody home\n\n`apps/pos/src/main.ts`\n")
// WS_E: virgin workspace for the spawn agent guard.
const ISSUE_E = issueFile(WS_E, "fix-build-confirm.md", "# build confirm\n\n`apps/pos/src/main.ts`\n")
// WS_A: proposal for the local hand-off / injection tests.
const ISSUE_A = issueFile(
  WS_A,
  "fix-collab-self.md",
  "# collab 自测（11-17-collab-workspace）\n\n`packages/machine/src/cfg/impl.ts`\n",
)
// WS_F: same basename as WS_B's proposal (receipt matching must not use it) and
// two strong candidates for the serial-ask / DECLINE path.
const ISSUE_F = issueFile(
  WS_F,
  "fix-worker-store.md",
  "# worker store 修复（11-17-worker-store）\n\n`packages/state/src/machine/worker/store.ts`\n",
)
// WS_G: two strong candidates that never answer → ask lease timeout.
const ISSUE_G = issueFile(
  WS_G,
  "fix-ask-timeout.md",
  "# worker store 问询超时（11-17-worker-store）\n\n`packages/state/src/machine/worker/store.ts`\n",
)
// WS_H / WS_I: empty workspaces → spawn (self-accept / landing validation).
const ISSUE_H = issueFile(WS_H, "fix-spawn-ack.md", "# spawn 自领取\n\n`apps/pos/src/main.ts`\n")
const ISSUE_I = issueFile(WS_I, "fix-landing.md", "# landing\n\n`apps/pos/src/main.ts`\n")

const plugin = (await import(`file://${entry}`)).default

// ------------------------------------------------------------------ fake host
const store = new Map()
const prompts = []
const tools = []
const hooks = {}
const contexts = new Map()
const queue = []
let wake

async function* feed() {
  for (;;) {
    if (!queue.length) await new Promise((resolveFeed) => (wake = resolveFeed))
    const next = queue.shift()
    if (!next) return
    yield next
  }
}

const now = Date.now()
const toolMessage = (file, at = now) => ({
  id: `msg_tool_${file}`,
  type: "assistant",
  time: { created: at },
  content: [{ type: "tool", name: "edit", state: { status: "completed", input: { filePath: file } } }],
})

const sessions = {
  ses_aaa: { id: "ses_aaa", agent: "build", title: "A", time: { busy: 1 }, location: { directory: HARNESS_LOCATION } },
  ses_bbb: { id: "ses_bbb", agent: "explore", title: "B", time: { busy: 1 }, location: { directory: HARNESS_LOCATION } },
  "ses_e1eb91cebffeTv1467ubJLKebk": {
    id: "ses_e1eb91cebffeTv1467ubJLKebk",
    agent: "build",
    title: "schema",
    time: { busy: 1 },
    location: { directory: HARNESS_LOCATION },
  },
  // Lineage fixtures: `ses_child` is a direct sub-session of the protected
  // schema line, `ses_grand` is its grandchild (two hops up).
  ses_child: {
    id: "ses_child",
    parentID: "ses_e1eb91cebffeTv1467ubJLKebk",
    agent: "trellis-implement",
    title: "child of schema",
    time: { busy: 1 },
    location: { directory: HARNESS_LOCATION },
  },
  ses_grand: {
    id: "ses_grand",
    parentID: "ses_child",
    agent: "trellis-implement",
    title: "grandchild of schema",
    time: { busy: 1 },
    location: { directory: HARNESS_LOCATION },
  },
  // Unrelated sessions used to prove reply routing / participant checks.
  ses_ccc: { id: "ses_ccc", agent: "build", title: "C", time: { busy: 1 }, location: { directory: HARNESS_LOCATION } },
  ses_ddd: { id: "ses_ddd", agent: "build", title: "D", time: { busy: 1 }, location: { directory: HARNESS_LOCATION } },

  // ---- hand-off chain fixtures (S23+) ----
  // WS_A: requester + a matching target + a child (never a group member).
  ses_req: {
    id: "ses_req",
    agent: "build",
    title: "11-17-collab-workspace 收口",
    time: { updated: now, busy: now, idle: 0 },
    location: { directory: WS_A },
  },
  ses_a_target: {
    id: "ses_a_target",
    agent: "build",
    title: "11-17-collab-workspace machine cfg 修复",
    time: { updated: now - 60_000, busy: 0 },
    location: { directory: WS_A },
  },
  ses_a_second: {
    id: "ses_a_second",
    agent: "build",
    title: "别的活儿（无关）",
    time: { updated: now, busy: 0 },
    location: { directory: WS_A },
  },
  ses_a_child: {
    id: "ses_a_child",
    parentID: "ses_a_target",
    agent: "trellis-implement",
    title: "11-17-collab-workspace child",
    time: { updated: now, busy: 0 },
    location: { directory: WS_A },
  },
  // WS_B: high score (file + title words + task slug + build + recent = 85).
  ses_b1: {
    id: "ses_b1",
    agent: "build",
    title: "11-17-worker-store worker store 重构",
    time: { updated: now - 10 * 60_000, busy: 0 },
    location: { directory: WS_B },
  },
  // WS_B: low score (no overlap, no words, explore vs implement, older).
  ses_b2: {
    id: "ses_b2",
    agent: "explore",
    title: "bench 压测脚本",
    time: { updated: now - 60 * 60_000, busy: 0 },
    location: { directory: WS_B },
  },
  // WS_B: child of a group member (excluded from the group).
  ses_b_child: {
    id: "ses_b_child",
    parentID: "ses_b1",
    agent: "trellis-implement",
    title: "11-17-worker-store child",
    time: { updated: now, busy: 0 },
    location: { directory: WS_B },
  },
  // WS_B: protected line that lives in the target workspace (must stay out).
  "ses_e23a4a23fffe4c4m7UQFR8dUL3": {
    id: "ses_e23a4a23fffe4c4m7UQFR8dUL3",
    agent: "build",
    title: "11-17-worker-store parity",
    time: { updated: now, busy: 0 },
    location: { directory: WS_B },
  },
  // WS_D: busy for 45 minutes yet still ≥80 → the only wake-up case.
  ses_d1: {
    id: "ses_d1",
    agent: "build",
    title: "11-17-worker-store worker store state machine 修复",
    time: { updated: now - 60_000, busy: now - 45 * 60_000, idle: 0 },
    location: { directory: WS_D },
  },

  // ---- review-fix round fixtures (S31+) ----
  // WS_C: a plain low-score member, so a lapsed spawn lock can be re-claimed
  // by *another* session of the same workspace (B2).
  ses_c_member: {
    id: "ses_c_member",
    agent: "build",
    title: "C 仓旁观会话",
    time: { updated: now - 30 * 60_000, busy: 0 },
    location: { directory: WS_C },
  },
  // WS_F: two candidates ≥80 (serial ask: DECLINE advances to the second one).
  ses_f1: {
    id: "ses_f1",
    agent: "build",
    title: "11-17-worker-store worker store 修复",
    time: { updated: now - 60_000, busy: 0 },
    location: { directory: WS_F },
  },
  ses_f2: {
    id: "ses_f2",
    agent: "build",
    title: "11-17-worker-store worker store 修复（二）",
    time: { updated: now - 120_000, busy: 0 },
    location: { directory: WS_F },
  },
  // WS_G: same shape, nobody answers → ask-lease timeout path.
  ses_g1: {
    id: "ses_g1",
    agent: "build",
    title: "11-17-worker-store worker store 问询超时",
    time: { updated: now - 60_000, busy: 0 },
    location: { directory: WS_G },
  },
  ses_g2: {
    id: "ses_g2",
    agent: "build",
    title: "11-17-worker-store worker store 问询超时（二）",
    time: { updated: now - 120_000, busy: 0 },
    location: { directory: WS_G },
  },
}

contexts.set("ses_b1", [toolMessage("packages/state/src/machine/worker/store.ts")])
contexts.set("ses_d1", [toolMessage("packages/state/src/machine/worker/store.ts")])
contexts.set("ses_a_target", [toolMessage("packages/machine/src/cfg/impl.ts")])
contexts.set("ses_f1", [toolMessage("packages/state/src/machine/worker/store.ts")])
contexts.set("ses_f2", [toolMessage("packages/state/src/machine/worker/store.ts")])
contexts.set("ses_g1", [toolMessage("packages/state/src/machine/worker/store.ts")])
contexts.set("ses_g2", [toolMessage("packages/state/src/machine/worker/store.ts")])

const created = []

const ctx = {
  location: { directory: WS_A },
  options: {},
  app: { version: "test" },
  storage: {
    async get(key) {
      const value = store.get(key)
      return value === undefined ? undefined : structuredClone(value)
    },
    async set(key, value) {
      store.set(key, structuredClone(value))
    },
    async remove(key) {
      store.delete(key)
    },
    async scan() {
      return { entries: [] }
    },
  },
  tool: {
    async transform(callback) {
      callback({ add: (definition) => tools.push(definition) })
      return { dispose: async () => {} }
    },
  },
  session: {
    async hook(name, callback) {
      hooks[name] = callback
      return { dispose: async () => {} }
    },
    async get({ sessionID }) {
      if (!sessions[sessionID]) throw new Error(`Session not found: ${sessionID}`)
      return structuredClone(sessions[sessionID])
    },
    async list({ limit = 20, directory } = {}) {
      const list = Object.values(sessions).filter((info) => !directory || info.location?.directory === directory)
      return { data: structuredClone(list.slice(0, limit)) }
    },
    async context({ sessionID }) {
      return structuredClone(contexts.get(sessionID) ?? [])
    },
    async create(input = {}) {
      const info = {
        id: `ses_spawn_${created.length + 1}`,
        agent: input.agent ?? "build",
        title: input.title ?? "(untitled)",
        time: { created: Date.now(), updated: Date.now() },
        location: { directory: input.location?.directory },
      }
      sessions[info.id] = info
      created.push(info)
      return structuredClone(info)
    },
    async remove({ sessionID }) {
      delete sessions[sessionID]
    },
    async prompt(input) {
      prompts.push(input)
      return { id: `msg_${prompts.length}`, delivery: input.delivery }
    },
    async wait() {},
  },
  event: { subscribe: feed },
}

const originalError = console.error
console.error = () => {} // plugin setup logs are noise here
await plugin.setup(ctx)
console.error = originalError

const tool = (name) => tools.find((entry) => entry.name === name)
const call = async (name, input, context = { sessionID: "ses_aaa", agent: "build" }) =>
  (await tool(name).execute(input, context)).content
const push = (event) => {
  queue.push(event)
  wake?.()
  wake = undefined
}
const inbound = (sessionID, text, metadata, inboxID) => ({
  type: "session.inbox.enqueued",
  data: {
    sessionID,
    inboxID,
    item: { type: "user", id: `msg_in_${inboxID}`, payload: { text, metadata: metadata ? { collab: metadata } : undefined } },
  },
})
const contextEvent = (sessionID, messages = []) => ({
  sessionID,
  agent: sessionID === "ses_bbb" ? "explore" : "build",
  system: [],
  messages,
})
const settle = (ms = 60) => new Promise((resolveSettle) => setTimeout(resolveSettle, ms))
const out = (title, value) => console.log(`\n--- ${title}\n${value}`)
const failure = async (title, fn) => {
  try {
    await fn()
    out(title, "(没有报错 —— 与预期不符)")
  } catch (error) {
    out(title, error.message)
  }
}

// ---------------------------------------------------------------- assertions
// S17–S30 use these so the harness is a real regression gate: it exits 1 when
// any check fails (S1–S16 remain printed-only, unchanged from the previous run).
const checks = []
const expect = (title, ok, detail = "") => {
  checks.push({ title, ok: Boolean(ok) })
  console.log(`  ${ok ? "✓" : "✗"} ${title}${detail ? ` — ${detail}` : ""}`)
}
const expectFail = async (title, fn, matcher) => {
  const startedAt = Date.now()
  try {
    const value = await fn()
    expect(title, false, `没有报错: ${String(value).replace(/\s+/g, " ").slice(0, 120)}`)
    return ""
  } catch (error) {
    const message = String(error?.message ?? error)
    expect(title, !matcher || matcher.test(message), `${Date.now() - startedAt}ms / ${message.slice(0, 160)}`)
    return message
  }
}

// broadcast store helpers (the harness reads the same files the plugin writes)
const bcFile = (bid) => join(broadcastDir, `${bid}.json`)
const bcRead = (bid) => JSON.parse(readFileSync(bcFile(bid), "utf8"))
const bcBids = () => {
  try {
    return readdirSync(broadcastDir).filter((name) => name.startsWith("b_") && name.endsWith(".json"))
  } catch {
    return [] // nothing written yet
  }
}
const bidOf = (text) => /bid=(b_[0-9a-f]+)/.exec(text)?.[1]
/** `score` on the ranking line of `<sid>` (preview/confirmed broadcasts). */
const scoreOf = (text, sid) => Number(new RegExp(`(\\d{1,3})\\s+${sid}\\b`).exec(text)?.[1] ?? -1)

// S1: preview shows kind/thread/mode without delivering.
out("S1 send preview (confirm:false)", await call("collab_send", { target: "ses_bbb", text: "预览测试", confirm: false }))
console.log(`delivered prompts so far: ${prompts.length}`)

// S2: default mode is queue; thread opens.
const sent = await call("collab_send", { target: "ses_bbb", text: "请处理任务 T", kind: "request", confirm: true })
out("S2 send confirm (build → explore, mode omitted)", sent)
console.log(`prompt delivery=${prompts.at(-1).delivery} metadata=${JSON.stringify(prompts.at(-1).metadata.collab)}`)
const threadID = /thread=(t_[a-z0-9_]+)/.exec(sent)[1]
out("S2 thread record", JSON.stringify(store.get(`collab/threads/${threadID}`), null, 1))

// S3: read-only agent asking for steer is forced back to queue.
const forced = await call(
  "collab_send",
  { target: "ses_aaa", text: "只读 agent 强制 queue", mode: "steer", confirm: true },
  { sessionID: "ses_bbb", agent: "explore" },
)
out("S3 send from explore with mode:steer", forced)
console.log(`prompt delivery=${prompts.at(-1).delivery}`)

// S4/S5: inbound recorded → injected once, then never again.
const directThread = "t_manual_0001"
push(
  inbound(
    "ses_aaa",
    `[collab:ses_bbb][request:${directThread}] 需要你复核 X`,
    { from: "ses_bbb", fromSessionID: "ses_bbb", cid: "c_direct_0001", kind: "request", threadID: directThread },
    "inbox_0001",
  ),
)
await settle()
const first = contextEvent("ses_aaa")
await hooks.context(first)
out("S4 first request (message NOT in request)", JSON.stringify(first.system, null, 1))
const second = contextEvent("ses_aaa")
await hooks.context(second)
out("S5 second request (same message again)", JSON.stringify(second.system))

// S6: request already carries the message (metadata cid) → no injection.
push(
  inbound(
    "ses_aaa",
    "[collab:ses_bbb][request:t_manual_0002] 已在请求里的消息",
    { from: "ses_bbb", fromSessionID: "ses_bbb", cid: "c_direct_0002", kind: "request", threadID: "t_manual_0002" },
    "inbox_0002",
  ),
)
await settle()
const withMeta = contextEvent("ses_aaa", [
  {
    role: "user",
    metadata: { collab: { cid: "c_direct_0002", kind: "request", threadID: "t_manual_0002" } },
    parts: [{ type: "text", text: "[collab:ses_bbb][request:t_manual_0002] 已在请求里的消息" }],
  },
])
await hooks.context(withMeta)
out("S6 message already in request (metadata cid)", JSON.stringify(withMeta.system))

// S7: metadata unavailable → envelope-text fallback still de-duplicates.
push(inbound("ses_aaa", "[collab:cli-user][note:t_manual_0003] CLI 发来的消息", undefined, "inbox_0003"))
await settle()
const textOnly = contextEvent("ses_aaa", [
  { role: "user", parts: [{ type: "text", text: "[collab:cli-user][note:t_manual_0003] CLI 发来的消息" }] },
])
await hooks.context(textOnly)
out("S7 message already in request (text fallback, no metadata)", JSON.stringify(textOnly.system))

// S8: reply resolves the counterpart from the thread and marks it answered.
const reply = await call(
  "collab_reply",
  { threadID, text: "已完成 T", confirm: true },
  { sessionID: "ses_bbb", agent: "explore" },
)
out("S8 collab_reply from explore", reply)
console.log(`target prompt sessionID=${prompts.at(-1).sessionID} delivery=${prompts.at(-1).delivery}`)
out("S8 thread status", store.get(`collab/threads/${threadID}`).status)

// S9: wait on the thread returns the reply; unknown thread fails fast (F6).
out("S9 collab_wait {threadID} with an existing reply", await call("collab_wait", { threadID, timeoutMs: 1000 }))
await failure("S9 collab_wait {threadID} on an unknown thread (now fails fast)", () =>
  call("collab_wait", { threadID: "t_missing_0000", timeoutMs: 1200 }),
)

// S10: inbox returns full text + thread status.
out("S10 collab_inbox (ses_bbb)", await call("collab_inbox", { limit: 5 }, { sessionID: "ses_bbb", agent: "explore" }))

// S11: reply without threadID downgrades to a new request, with a note.
const downgraded = await call("collab_send", { target: "ses_bbb", text: "忘记带 threadID 的回执", kind: "reply", confirm: false })
out("S11 kind:reply without threadID (preview)", downgraded)

// S12: a request whose thread is already answered is not a reminder.
const answeredThread = "t_answered_0001"
store.set(`collab/threads/${answeredThread}`, {
  threadID: answeredThread,
  fromSession: "ses_bbb",
  toSession: "ses_aaa",
  kind: "request",
  status: "answered",
  msgs: [{ cid: "c_ans_0001", kind: "request", text: "已完成的请求", ts: 1, from: "ses_bbb", fromSession: "ses_bbb", toSession: "ses_aaa" }],
  createdAt: 1,
  updatedAt: 1,
})
push(
  inbound(
    "ses_aaa",
    `[collab:ses_bbb][request:${answeredThread}] 已完成的请求`,
    { from: "ses_bbb", fromSessionID: "ses_bbb", cid: "c_ans_0001", kind: "request", threadID: answeredThread },
    "inbox_ans_0001",
  ),
)
await settle()
const answeredEvent = contextEvent("ses_aaa")
await hooks.context(answeredEvent)
out("S12 request whose thread is answered", JSON.stringify(answeredEvent.system))

// S13: inbox view of the same session (full text + statuses).
out("S13 collab_inbox (ses_aaa)", await call("collab_inbox", { limit: 5 }))

// S14: guard rails — protect list, self-send, unknown reply thread, bad threadID.
await failure("S14 send to a protected session", () =>
  call("collab_send", { target: "ses_e1eb91cebffeTv1467ubJLKebk", text: "x", confirm: true }),
)
await failure("S14 send to self", () => call("collab_send", { target: "ses_aaa", text: "x", confirm: true }))
await failure("S14 reply on an unknown thread", () => call("collab_reply", { threadID: "t_ghost_0001", text: "x", confirm: true }))
await failure("S14 malformed threadID", () => call("collab_send", { target: "ses_bbb", text: "x", threadID: "nope", confirm: true }))

// S15: collab_list still works and marks protect/self.
out("S15 collab_list", await call("collab_list", { limit: 5 }))

// S16: idle-mode wait keeps its old semantics.
out("S16 collab_wait {target} (idle mode)", await call("collab_wait", { target: "ses_bbb", timeoutMs: 1000 }))

// ---------------------------------------------------- S17–S22 (regression gate)
// S17/S18 → F1 lineage guard · S19/S20 → F2 participant + reply routing ·
// S21 → F3 thread reuse · S22 → F4 legacy hint + F6 collab_wait validation.

// S17: a *direct* child of a protected session is refused, and collab_list
// marks it `[protected-child]` with its parent — spawning a sub-agent must not
// become a way around BUILTIN_PROTECT.
out("S17 protected session's direct child", "…")
const s17 = await expectFail(
  "S17 send to a direct child is rejected",
  () => call("collab_send", { target: "ses_child", text: "x", confirm: true }),
  /protect 名单/,
)
expect(
  "S17 rejection names the ancestor + depth 1",
  s17.includes("ses_e1eb91cebffeTv1467ubJLKebk") && s17.includes("第 1 级"),
  s17,
)
const s17list = await call("collab_list", { limit: 10 })
out("S17 collab_list", s17list)
const s17line = s17list.split("\n").find((line) => line.startsWith("ses_child")) ?? ""
expect(
  "S17 list marks [protected-child] + parent=<short>",
  s17line.includes("[protected-child]") && s17line.includes("parent="),
  s17line,
)

// S18: the same guard must walk more than one hop (grandchild of the schema line).
out("S18 protected session's grandchild", "…")
const s18 = await expectFail(
  "S18 send to a grandchild is rejected",
  () => call("collab_send", { target: "ses_grand", text: "x", confirm: true }),
  /protect 名单/,
)
expect(
  "S18 rejection reports the 2nd-level ancestor",
  s18.includes("第 2 级") && s18.includes("ses_e1eb91cebffeTv1467ubJLKebk"),
  s18,
)

// S19: only thread participants may reply / wait. A leaked threadID is not a
// bearer token: `ses_ccc` is unrelated to the thread below.
const s19sent = await call("collab_send", { target: "ses_bbb", text: "S19 参与方测试", confirm: true })
const tid19 = /thread=(t_[a-z0-9_]+)/.exec(s19sent)[1]
out("S19 thread", tid19)
await expectFail(
  "S19 non-participant collab_reply is rejected",
  () =>
    call(
      "collab_reply",
      { threadID: tid19, text: "我是第三方伪造的回执", confirm: true },
      { sessionID: "ses_ccc", agent: "build" },
    ),
  /不是 .* 的参与方/,
)
await expectFail(
  "S19 non-participant collab_wait is rejected",
  () => call("collab_wait", { threadID: tid19, timeoutMs: 1000 }, { sessionID: "ses_ccc", agent: "build" }),
  /不是 .* 的参与方/,
)

// S20: a reply must be routed to the thread's counterpart; a mismatch is
// refused *before* delivery and must not touch the thread record.
const before20 = structuredClone(store.get(`collab/threads/${tid19}`))
out("S20 reply misrouted to an unrelated target", "…")
await expectFail(
  "S20 kind:reply to a non-counterpart target is rejected",
  () =>
    call(
      "collab_send",
      { target: "ses_ddd", kind: "reply", threadID: tid19, text: "错误路由", confirm: true },
      { sessionID: "ses_bbb", agent: "explore" },
    ),
  /对端/,
)
await expectFail(
  "S20 non-participant kind:reply is rejected",
  () =>
    call(
      "collab_send",
      { target: "ses_aaa", kind: "reply", threadID: tid19, text: "伪造", confirm: true },
      { sessionID: "ses_ccc", agent: "build" },
    ),
  /参与方/,
)
const after20 = store.get(`collab/threads/${tid19}`)
expect(
  "S20 thread not polluted",
  after20.msgs.length === before20.msgs.length && after20.toSession === before20.toSession,
  `msgs ${before20.msgs.length}→${after20.msgs.length}`,
)
expect("S20 nothing delivered to the unrelated target", !prompts.some((p) => p.sessionID === "ses_ddd"))
const legit20 = await call(
  "collab_reply",
  { threadID: tid19, text: "S19/S20 合法回执", confirm: true },
  { sessionID: "ses_bbb", agent: "explore" },
)
expect("S20 legit reply still accepted", legit20.includes("status=answered"), legit20.split("\n")[1])

// S21: reusing a thread must reopen it: status back to `open`, the receiver is
// reminded again, and `collab_wait` must not return the previous round's reply.
const s21sent = await call("collab_send", { target: "ses_bbb", text: "S21 round 1", confirm: true })
const tid21 = /thread=(t_[a-z0-9_]+)/.exec(s21sent)[1]
await call("collab_reply", { threadID: tid21, text: "round1-reply", confirm: true }, { sessionID: "ses_bbb", agent: "explore" })
const w21a = await call("collab_wait", { threadID: tid21, timeoutMs: 1000 })
expect("S21 round-1 reply is returned", w21a.includes("round1-reply"))
out("S21 second request on the same thread", "…")
const s21again = await call("collab_send", { target: "ses_bbb", threadID: tid21, text: "S21 round 2", confirm: true })
expect(
  "S21 second request reopens the thread (open)",
  store.get(`collab/threads/${tid21}`).status === "open",
  s21again.split("\n")[1],
)
await expectFail(
  "S21 wait does not return the stale reply",
  () => call("collab_wait", { threadID: tid21, timeoutMs: 1000 }),
  /等待回执超时/,
)
push(
  inbound(
    "ses_bbb",
    `[collab:ses_aaa][request:${tid21}] S21 round 2`,
    { from: "ses_aaa", fromSessionID: "ses_aaa", cid: "c_s21_round2", kind: "request", threadID: tid21 },
    "inbox_s21_round2",
  ),
)
await settle()
const s21ctx = contextEvent("ses_bbb")
await hooks.context(s21ctx)
expect("S21 reused thread is reminded again", JSON.stringify(s21ctx.system).includes(tid21), JSON.stringify(s21ctx.system))
await call("collab_reply", { threadID: tid21, text: "round2-reply", confirm: true }, { sessionID: "ses_bbb", agent: "explore" })
const w21b = await call("collab_wait", { threadID: tid21, timeoutMs: 1000 })
expect("S21 round-2 reply is returned", w21b.includes("round2-reply") && !w21b.includes("round1-reply"))

// S22: legacy CLI message (no `[kind:thread]`, no metadata) must not be given a
// `collab_reply {threadID:"undefined"}` hint; `collab_wait` validates fast.
push(inbound("ses_aaa", "[collab:cli-user] legacy 无 thread 的消息", undefined, "inbox_legacy_0001"))
await settle()
const s22ctx = contextEvent("ses_aaa")
await hooks.context(s22ctx)
const s22text = JSON.stringify(s22ctx.system)
out("S22 legacy injection", s22text)
expect("S22 legacy message injected", s22text.includes("legacy 无 thread 的消息"))
expect("S22 legacy hint has no collab_reply", !s22text.includes("collab_reply"))
expect('S22 no literal "undefined" threadID', !s22text.includes("undefined"))
const legacyStored = (store.get("collab/inbox/ses_aaa").messages ?? []).find((m) => m.id === "inbox_legacy_0001")
expect("S22 legacy record has no threadID", Boolean(legacyStored) && !legacyStored.threadID)

const badWait = Date.now()
await expectFail(
  "S22 collab_wait malformed threadID fails fast",
  () => call("collab_wait", { threadID: "not-a-thread", timeoutMs: 5000 }),
  /格式不合法/,
)
const ghostWait = Date.now()
await expectFail(
  "S22 collab_wait unknown threadID fails fast",
  () => call("collab_wait", { threadID: "t_ghost_9999", timeoutMs: 5000 }),
  /没有 thread/,
)
const ghostElapsed = Date.now() - ghostWait
expect("S22 both failures are immediate (<500ms)", Date.now() - badWait < 500 && ghostElapsed < 500, `${Date.now() - badWait}ms`)

// ================================================================ S23–S30
// The chain: matching score, threshold, atomic claim, idempotency, spawn,
// receipt, lease, listing/injection.

// S23: deterministic score with a `why` breakdown, group membership filtering.
out("S23 broadcast preview (peer, WS_B)", "…")
const s23 = await call(
  "collab_broadcast",
  { workspace: WS_B, issuePath: ISSUE_B, expected: "implement", confirm: false },
  { sessionID: "ses_req", agent: "build" },
)
out("S23 preview", s23)
const s23bid = bidOf(s23)
expect("S23 preview produced a bid", Boolean(s23bid), s23bid)
expect("S23 top candidate is ses_b1 (≥80)", scoreOf(s23, "ses_b1") >= 80, s23.split("\n").find((l) => l.includes("ses_b1")))
const s23line = s23.split("\n").find((line) => line.trim().startsWith("85") || line.includes("ses_b1")) ?? ""
expect("S23 why names the matched file", s23line.includes("file:packages/state/src/machine/worker/store.ts"), s23line)
expect("S23 why names the matched title word(s)", /title:(worker|store)/.test(s23line), s23line)
expect("S23 why names the shared task line", s23line.includes("task:11-17-worker-store"), s23line)
expect("S23 why names the agent match", s23line.includes("agent:build"), s23line)
expect("S23 child sessions are not candidates", !s23.includes("ses_b_child"), s23)
expect("S23 protected sessions are not candidates", !s23.includes("ses_e23a4a23fffe4c4m7UQFR8dUL3"), s23)
expect("S23 no prompt is sent while previewing", !prompts.some((p) => p.sessionID === "ses_b1"))
expect("S23 preview wrote nothing to the broadcast dir", !s23bid || !bcBids().includes(`${s23bid}.json`))

// S23b: an idle top-1 gets the file only (0 model calls); busy > 30min gets one
// queued wake-up prompt (WS_D has a single, 45-min-busy candidate).
const s23d = await call(
  "collab_broadcast",
  { workspace: WS_D, issuePath: ISSUE_D, expected: "implement", confirm: false },
  { sessionID: "ses_req", agent: "build" },
)
expect("S23b busy>30min candidate still clears the threshold", scoreOf(s23d, "ses_d1") >= 80, s23d.split("\n").find((l) => l.includes("ses_d1")))
expect("S23b preview announces the wake-up", s23d.includes("补发 1 条 queue prompt"), s23d)
const promptsBeforeD = prompts.length
const s23dConfirmed = await call(
  "collab_broadcast",
  { workspace: WS_D, issuePath: ISSUE_D, expected: "implement", confirm: true },
  { sessionID: "ses_req", agent: "build" },
)
out("S23b confirm (busy top-1)", s23dConfirmed)
const wokeD = prompts.slice(promptsBeforeD)
expect("S23b exactly one wake prompt", wokeD.length === 1 && wokeD[0].sessionID === "ses_d1", JSON.stringify(wokeD.map((p) => p.sessionID)))
expect("S23b wake prompt is queued (never steer)", wokeD[0]?.delivery === "queue", wokeD[0]?.delivery)
expect("S23b wake prompt carries the hand-off ask", /collab_accept \{bid:"b_/.test(wokeD[0]?.text ?? ""), wokeD[0]?.text?.slice(0, 160))
const bidD = bidOf(s23dConfirmed)
expect("S23b record is open and keeps the ranking", bcRead(bidD).state === "open" && bcRead(bidD).candidates[0].sid === "ses_d1", JSON.stringify(bcRead(bidD).candidates[0]))

// S24 + S25: WS_B broadcast (state open) → atomic claim, one winner.
const s24 = await call(
  "collab_broadcast",
  { workspace: WS_B, issuePath: ISSUE_B, expected: "implement", confirm: true },
  { sessionID: "ses_req", agent: "build" },
)
out("S24 broadcast confirmed (WS_B)", s24)
const bidB = bidOf(s24)
expect("S24 broadcast file written", bcBids().includes(`${bidB}.json`), bcBids().join(","))
expect("S24 record is open with ranked candidates", bcRead(bidB).state === "open" && bcRead(bidB).candidates.length >= 2)
expect("S24 idle top-1 gets no prompt (file-only broadcast)", !prompts.some((p) => p.sessionID === "ses_b1"))

const [win1, win2] = await Promise.all([
  call("collab_accept", { bid: bidB, confirm: true }, { sessionID: "ses_b1", agent: "build" }),
  call("collab_accept", { bid: bidB, confirm: true }, { sessionID: "ses_b2", agent: "explore" }),
])
out("S25 concurrent accept #1", win1)
out("S25 concurrent accept #2", win2)
const winners = [win1, win2].filter((text) => text.startsWith("已领取"))
expect("S25 exactly one winner", winners.length === 1, `${winners.length} winner(s)`)
const loserText = [win1, win2].find((text) => !text.startsWith("已领取")) ?? ""
expect("S25 loser is told who claimed it", /已被 ses_b[12] 领取/.test(loserText), loserText.split("\n")[0])
expect("S25 record is acked with the winner", bcRead(bidB).state === "acked" && /^ses_b[12]$/.test(bcRead(bidB).claim.by), JSON.stringify(bcRead(bidB).claim))
const winnerSid = bcRead(bidB).claim.by
expect("S25 requester was notified with a note", prompts.some((p) => p.sessionID === "ses_req" && /ACCEPT/.test(p.text)), "prompts→ses_req")
const third = await call("collab_accept", { bid: bidB, confirm: true }, { sessionID: "ses_b2", agent: "explore" })
expect("S25 a third accept cannot steal it", /已被 ses_b1 领取|已闭环/.test(third), third.split("\n")[0])
const acceptPreview = await call("collab_accept", { bid: bidB, confirm: false }, { sessionID: "ses_b2", agent: "explore" })
expect("S25 preview on a claimed bid reports the state", acceptPreview.includes("state=acked") || acceptPreview.includes("已闭环"), acceptPreview.split("\n")[0])

// S26: idempotency — same content+mtime = same bid; edited proposal = new bid.
const before26 = bcBids().length
const s26 = await call(
  "collab_broadcast",
  { workspace: WS_B, issuePath: ISSUE_B, expected: "implement", confirm: true },
  { sessionID: "ses_req", agent: "build" },
)
expect("S26 repeated broadcast is idempotent (same bid, no new file)", bidOf(s26) === bidB && bcBids().length === before26, `${bidOf(s26)} / ${bcBids().length}`)
expect("S26 repeated broadcast says so", s26.includes("已存在同一内容"), s26.split("\n")[0])
writeFileSync(join(WS_B, "docs", "issues", "fix-worker-store.md"), `${readFileSync(join(WS_B, "docs", "issues", "fix-worker-store.md"), "utf8")}\n\n补充一行。\n`)
const s26b = await call(
  "collab_broadcast",
  { workspace: WS_B, issuePath: ISSUE_B, expected: "implement", confirm: false },
  { sessionID: "ses_req", agent: "build" },
)
expect("S26 edited proposal yields a new bid", bidOf(s26b) !== bidB && Boolean(bidOf(s26b)), `${bidOf(s26b)} vs ${bidB}`)
expect("S26 preview still wrote nothing", !bcBids().includes(`${bidOf(s26b)}.json`))

// S27: concurrent spawn — one session, correct location, explore by default.
const createdBefore = created.length
const spawnCalls = await Promise.all([
  call("collab_broadcast", { workspace: WS_C, issuePath: ISSUE_C, confirm: true }, { sessionID: "ses_req", agent: "build" }),
  call("collab_broadcast", { workspace: WS_C, issuePath: ISSUE_C, confirm: true }, { sessionID: "ses_req", agent: "build" }),
])
out("S27 concurrent spawn #1", spawnCalls[0])
out("S27 concurrent spawn #2", spawnCalls[1])
const spawns = created.slice(createdBefore)
expect("S27 exactly one session spawned", spawns.length === 1, `${spawns.length} session(s)`)
expect("S27 spawned session carries location.directory", spawns[0]?.location?.directory === WS_C, JSON.stringify(spawns[0]?.location))
expect("S27 spawned session defaults to explore", spawns[0]?.agent === "explore", spawns[0]?.agent)
expect("S27 spawned session title is impl:<slug>", /^impl:fix-nobody-home$/.test(spawns[0]?.title ?? ""), spawns[0]?.title)
const bidC = bidOf(spawnCalls[0]) ?? bidOf(spawnCalls[1])
expect("S27 record is claimed by the spawned session", bcRead(bidC).claim?.kind === "spawn" && bcRead(bidC).claim.by === spawns[0]?.id, JSON.stringify(bcRead(bidC).claim))
expect("S27 spawned session received the ask", prompts.some((p) => p.sessionID === spawns[0]?.id), "prompt→spawn")
const loserSpawn = spawnCalls.find((text) => text.includes("未拉新")) ?? ""
expect("S27 loser does not spawn again", loserSpawn.includes("已被") || loserSpawn.includes("未拉新"), loserSpawn.split("\n")[0])
const createdBeforeE = created.length
await expectFail(
  "S27 agent:build without agentConfirm is refused",
  () =>
    call(
      "collab_broadcast",
      { workspace: WS_E, issuePath: ISSUE_E, agent: "build", confirm: true },
      { sessionID: "ses_req", agent: "build" },
    ),
  /agentConfirm/,
)
expect("S27 refused build spawn created no session", created.length === createdBeforeE, `${created.length - createdBeforeE}`)
const buildSpawn = await call(
  "collab_broadcast",
  { workspace: WS_E, issuePath: ISSUE_E, agent: "build", agentConfirm: true, confirm: true },
  { sessionID: "ses_req", agent: "build" },
)
const buildInfo = created.at(-1)
expect(
  "S27 agent:build with agentConfirm:true spawns a build session",
  buildInfo?.agent === "build" && buildInfo?.location?.directory === WS_E && created.length === createdBeforeE + 1,
  JSON.stringify(buildInfo),
)

// S28: `[handoff] DONE <bid>` closes the hand-off from the inbox stream.
push(
  inbound(
    "ses_req",
    `[collab:${winnerSid}][note:b_${bidB.slice(2)}] [handoff] DONE ${bidB} shipped-in-abc1234`,
    { from: winnerSid, fromSessionID: winnerSid, cid: "c_receipt_1", kind: "note" },
    "inbox_receipt_1",
  ),
)
await settle()
expect("S28 receipt moves the bid to done", bcRead(bidB).state === "done", bcRead(bidB).state)
expect("S28 receipt is recorded with its note", (bcRead(bidB).receipt?.note ?? "").includes("abc1234"), JSON.stringify(bcRead(bidB).receipt))
const s28 = await call("collab_accept", { bid: bidB, confirm: true }, { sessionID: "ses_b2", agent: "explore" })
expect("S28 a closed bid cannot be claimed", s28.includes("已闭环"), s28.split("\n")[0])

// S29: lease expiry → attempts++ / skip / reopen; attempts > 3 → expired.
const leaseRecord = bcRead(bidD)
writeFileSync(
  bcFile(bidD),
  JSON.stringify({
    ...leaseRecord,
    state: "claimed",
    attempts: 0,
    skipped: [],
    claim: { by: "ses_d1", kind: "accept", token: "k_lease", at: Date.now() - 400_000, leaseMs: 300_000 },
  }),
)
const s29 = await call("collab_accept", { bid: bidD, confirm: false }, { sessionID: "ses_d1", agent: "build" })
out("S29 after lease expiry", s29)
expect("S29 expired lease reopens with attempts=1", bcRead(bidD).attempts === 1 && bcRead(bidD).state === "open", JSON.stringify({ attempts: bcRead(bidD).attempts, state: bcRead(bidD).state }))
expect("S29 expired holder is skipped", bcRead(bidD).skipped.includes("ses_d1"), JSON.stringify(bcRead(bidD).skipped))
writeFileSync(
  bcFile(bidD),
  JSON.stringify({
    ...bcRead(bidD),
    state: "claimed",
    attempts: 4,
    claim: { by: "ses_d1", kind: "accept", token: "k_lease2", at: Date.now() - 400_000, leaseMs: 300_000 },
  }),
)
await expectFail(
  "S29 attempts > 3 → expired, escalation instead of re-delivery",
  () => call("collab_accept", { bid: bidD, confirm: true }, { sessionID: "ses_d1", agent: "build" }),
  /expired/,
)
expect("S29 expired state is persisted", bcRead(bidD).state === "expired", bcRead(bidD).state)

// S30: collab_list{directory} + loc= + [bootstrap]; peer write guard; injection.
const listB = await call("collab_list", { directory: WS_B, limit: 50 })
out("S30 collab_list (WS_B)", listB)
const listLines = listB.split("\n").filter((line) => line.startsWith("ses_"))
expect("S30 directory filter only returns that workspace", listLines.every((line) => line.includes("loc=b")), listLines.map((l) => l.slice(0, 60)).join(" | "))
expect("S30 children stay listed with parent=", listLines.some((line) => line.startsWith("ses_b_child") && line.includes("parent=")), listB)
const listC = await call("collab_list", { directory: WS_C, limit: 50 })
expect("S30 spawned session is marked [bootstrap]", listC.includes("[bootstrap]"), listC.split("\n").find((l) => l.startsWith("ses_spawn")) ?? listC)
expect("S30 list shows open hand-offs", listC.includes("未闭环交接"), listC)

await expectFail(
  "S30 peer scope refuses a path outside docs/issues/",
  () =>
    call(
      "collab_broadcast",
      { workspace: WS_B, issuePath: "app/main.ts", confirm: true },
      { sessionID: "ses_req", agent: "build" },
    ),
  /docs\/issues/,
)
await expectFail(
  "S30 peer scope refuses a missing proposal",
  () =>
    call(
      "collab_broadcast",
      { workspace: WS_B, issuePath: "docs/issues/fix-nope.md", confirm: true },
      { sessionID: "ses_req", agent: "build" },
    ),
  /不存在/,
)

// A broadcast in *this* plugin's own workspace, to prove the receiving side
// sees it exactly once and children / protected lines never do.
const s30 = await call(
  "collab_broadcast",
  { workspace: WS_A, issuePath: ISSUE_A, expected: "implement", confirm: true },
  { sessionID: "ses_req", agent: "build" },
)
const bidA = bidOf(s30)
out("S30 broadcast in own workspace", s30)
const injected1 = contextEvent("ses_a_target")
await hooks.context(injected1)
const injected2 = contextEvent("ses_a_target")
await hooks.context(injected2)
out("S30 injection #1", JSON.stringify(injected1.system))
out("S30 injection #2", JSON.stringify(injected2.system))
expect("S30 broadcast injected into a group member", JSON.stringify(injected1.system).includes(bidA), JSON.stringify(injected1.system))
expect("S30 broadcast injected only once per session", !JSON.stringify(injected2.system).includes(bidA), JSON.stringify(injected2.system))
const injectedChild = contextEvent("ses_a_child")
await hooks.context(injectedChild)
expect("S30 child sessions get no broadcast", !JSON.stringify(injectedChild.system).includes(bidA), JSON.stringify(injectedChild.system))
const injectedProtected = contextEvent("ses_e1eb91cebffeTv1467ubJLKebk")
await hooks.context(injectedProtected)
expect("S30 protected lines get no broadcast", !JSON.stringify(injectedProtected.system).includes(bidA), JSON.stringify(injectedProtected.system))

// Unclosed hand-off → one reminder to its requester, never repeated.
const staleAt = Date.now() - 6 * 60_000
writeFileSync(
  bcFile(bidA),
  JSON.stringify({ ...bcRead(bidA), state: "acked", claim: { by: "ses_a_target", kind: "accept", token: "k_a", at: staleAt, leaseMs: 300_000 } }),
)
const remind1 = contextEvent("ses_req")
await hooks.context(remind1)
const remind2 = contextEvent("ses_req")
await hooks.context(remind2)
out("S30 reminder #1", JSON.stringify(remind1.system))
out("S30 reminder #2", JSON.stringify(remind2.system))
expect("S30 unclosed hand-off is reminded to its requester", JSON.stringify(remind1.system).includes("交接未闭环"), JSON.stringify(remind1.system))
expect("S30 reminder happens only once", !JSON.stringify(remind2.system).includes("交接未闭环"), JSON.stringify(remind2.system))

// S30c: local scope — collab_handoff ranks several candidates, reuses the
// thread protocol and records a local bid that a receipt can close.
const promptsBeforeHandoff = prompts.length
const handoff = await call(
  "collab_handoff",
  { text: "11-17-collab-workspace：复核 packages/machine/src/cfg/impl.ts 的广播实现", expected: "review", confirm: true },
  { sessionID: "ses_req", agent: "build" },
)
out("S30c collab_handoff (local, multi-candidate)", handoff)
const bidLocal = bidOf(handoff)
expect("S30c handoff picked the matching session via the score", handoff.includes("按匹配分选中 ses_a_target"), handoff.split("\n")[1])
expect("S30c handoff delivered one queued prompt", prompts.length === promptsBeforeHandoff + 1 && prompts.at(-1).sessionID === "ses_a_target" && prompts.at(-1).delivery === "queue")
const localRecord = bcRead(bidLocal)
expect("S30c local bid is acked with the target + thread", localRecord.scope === "local" && localRecord.state === "acked" && localRecord.claim.by === "ses_a_target" && /^t_/.test(localRecord.threadID), JSON.stringify({ scope: localRecord.scope, state: localRecord.state, thread: localRecord.threadID }))
const localThread = store.get(`collab/threads/${localRecord.threadID}`)
expect("S30c thread is open on the receiver side", localThread?.status === "open" && localThread.toSession === "ses_a_target", JSON.stringify(localThread?.status))
push(
  inbound(
    "ses_req",
    `[collab:ses_a_target][note:${localRecord.threadID}] [handoff] DONE ${bidLocal} local-ok`,
    { from: "ses_a_target", fromSessionID: "ses_a_target", cid: "c_receipt_local", kind: "note" },
    "inbox_receipt_local",
  ),
)
await settle()
expect("S30c receipt closes the local bid", bcRead(bidLocal).state === "done", bcRead(bidLocal).state)

// ================================================ S31–S38 (review-fix round)
// Blockers B1/B2, the R3/R4 ask protocol (B3) and the should-fix items S1–S5.

// A second plugin instance bound to WS_F, so the *peer side* context injection
// can be asserted too (the first instance only serves WS_A's location).
const hooksF = {}
const ctxF = {
  ...ctx,
  location: { directory: WS_F },
  // Tools are registered once by the first instance; this one only needs the hook.
  tool: {
    async transform(callback) {
      callback({ add: () => {} })
      return { dispose: async () => {} }
    },
  },
  session: {
    ...ctx.session,
    async hook(name, callback) {
      hooksF[name] = callback
      return { dispose: async () => {} }
    },
  },
  // The first instance owns the shared event feed; this one must not steal events.
  event: {
    async *subscribe() {},
  },
}
console.error = () => {}
await plugin.setup(ctxF)
console.error = originalError

// S31 (B1): a spawned session's own `collab_accept` moves claimed → acked and
// never tells it to report BLOCKED.
out("S31 spawn in WS_H", "…")
const createdBeforeH = created.length
const spawnH = await call(
  "collab_broadcast",
  { workspace: WS_H, issuePath: ISSUE_H, confirm: true },
  { sessionID: "ses_req", agent: "build" },
)
out("S31 spawn result", spawnH)
const bidH = bidOf(spawnH)
const spawnedH = created.at(-1)
expect(
  "S31 spawn created exactly one session at the target location",
  created.length === createdBeforeH + 1 && spawnedH?.location?.directory === WS_H,
  JSON.stringify({ count: created.length - createdBeforeH, loc: spawnedH?.location?.directory }),
)
expect(
  "S31 spawned hand-off starts claimed by the new session",
  bcRead(bidH).state === "claimed" && bcRead(bidH).claim?.by === spawnedH?.id,
  JSON.stringify(bcRead(bidH).claim),
)
const ackH = await call("collab_accept", { bid: bidH, confirm: true }, { sessionID: spawnedH?.id, agent: "explore" })
out("S31 spawned session collab_accept", ackH)
const afterH = bcRead(bidH)
expect(
  "S31 spawned session accept moves it to acked",
  afterH.state === "acked" && afterH.claim?.by === spawnedH?.id,
  JSON.stringify({ state: afterH.state, by: afterH.claim?.by }),
)
expect("S31 ackedAt is recorded", Number(afterH.ackedAt) > 0, String(afterH.ackedAt))
expect(
  "S31 receipt template is DONE and never BLOCKED",
  ackH.includes(`[handoff] DONE ${bidH}`) && !ackH.includes("BLOCKED"),
  ackH.split("\n").slice(0, 3).join(" / "),
)
expect(
  "S31 requester was told about the ACCEPT",
  prompts.some((p) => p.sessionID === "ses_req" && /ACCEPT/.test(p.text)),
  "prompts→ses_req",
)

// S32 (B2): the spawn lock is owned by the requester, the claim by the spawned
// session. After the lease lapses the lock must be gone and a member may claim.
const spawnedC = bcRead(bidC).claim?.by
const lockC = join(broadcastDir, `${bidC}.lock`)
expect("S32 spawn lock exists before expiry", existsSync(lockC), lockC)
const cRec = bcRead(bidC)
writeFileSync(bcFile(bidC), JSON.stringify({ ...cRec, claim: { ...cRec.claim, at: Date.now() - 301_000 } }))
const b2preview = await call(
  "collab_accept",
  { bid: bidC, confirm: false },
  { sessionID: "ses_c_member", agent: "build" },
)
out("S32 member preview after spawn lease expiry", b2preview)
const afterC = bcRead(bidC)
expect(
  "S32 lapsed spawn reopens: attempts=1, holder skipped",
  afterC.state === "open" && afterC.attempts === 1 && afterC.skipped.includes(spawnedC),
  JSON.stringify({ state: afterC.state, attempts: afterC.attempts, skipped: afterC.skipped }),
)
expect("S32 lapsed spawn releases the lock", !existsSync(lockC), String(existsSync(lockC)))
expect("S32 the loser is no longer told 已被 … 领取", !b2preview.includes("已被"), b2preview.split("\n")[0])
const b2take = await call("collab_accept", { bid: bidC, confirm: true }, { sessionID: "ses_c_member", agent: "build" })
out("S32 member accept after lock release", b2take)
expect(
  "S32 a member can claim once the lock is released",
  b2take.startsWith("已领取") && bcRead(bidC).state === "acked" && bcRead(bidC).claim?.by === "ses_c_member",
  b2take.split("\n")[0],
)

// S33 (B3 / R3): one serial ask, DECLINE advances to the next candidate, and
// that candidate really receives the takeover request in its own context.
out("S33 broadcast WS_F (two candidates ≥80)", "…")
const fBroadcast = await call(
  "collab_broadcast",
  { workspace: WS_F, issuePath: ISSUE_F, expected: "implement", confirm: true },
  { sessionID: "ses_req", agent: "build" },
)
out("S33 broadcast", fBroadcast)
const bidF = bidOf(fBroadcast)
expect(
  "S33 only the top-1 candidate is asked (serial)",
  bcRead(bidF).asked?.sid === "ses_f1" && bcRead(bidF).state === "open",
  JSON.stringify({ state: bcRead(bidF).state, asked: bcRead(bidF).asked }),
)
push(
  inbound(
    "ses_req",
    "[collab:ses_f1][reply:d_1] DECLINE 没余力，这个我接不了",
    { from: "ses_f1", fromSessionID: "ses_f1", cid: "c_decline_1", kind: "reply" },
    "inbox_decline_1",
  ),
)
await settle()
const afterDecline = bcRead(bidF)
out("S33 record after DECLINE", JSON.stringify({ state: afterDecline.state, attempts: afterDecline.attempts, skipped: afterDecline.skipped, asked: afterDecline.asked?.sid }))
expect(
  "S33 DECLINE skips the candidate and counts one attempt",
  afterDecline.attempts === 1 && afterDecline.skipped.includes("ses_f1"),
  JSON.stringify({ attempts: afterDecline.attempts, skipped: afterDecline.skipped }),
)
expect(
  "S33 DECLINE asks the next candidate (state stays open)",
  afterDecline.asked?.sid === "ses_f2" && afterDecline.state === "open",
  JSON.stringify({ asked: afterDecline.asked?.sid, state: afterDecline.state }),
)
const askF = contextEvent("ses_f2")
await hooksF.context(askF)
out("S33 ask injection to the next candidate", JSON.stringify(askF.system))
expect(
  "S33 the next candidate gets the takeover request",
  JSON.stringify(askF.system).includes(bidF) && JSON.stringify(askF.system).includes("接管请求"),
  JSON.stringify(askF.system).slice(0, 200),
)
expect(
  "S33 the ask line explains ACCEPT / DECLINE / lease",
  JSON.stringify(askF.system).includes("DECLINE") && JSON.stringify(askF.system).includes("5 分钟不答"),
  JSON.stringify(askF.system).slice(0, 240),
)
const f2accept = await call("collab_accept", { bid: bidF, confirm: true }, { sessionID: "ses_f2", agent: "build" })
out("S33 next candidate accepts", f2accept)
expect(
  "S33 the next candidate can claim it",
  f2accept.startsWith("已领取") && bcRead(bidF).claim?.by === "ses_f2",
  bcRead(bidF).claim?.by,
)

// S36 (S3): receipts match `bid` / full `issuePath` / `threadID` only, and only
// the claimant may close — a bare basename or a third party never does.
push(
  inbound(
    "ses_req",
    "[handoff] DONE fix-worker-store.md byname",
    { from: "ses_f2", fromSessionID: "ses_f2", cid: "c_receipt_basename", kind: "note" },
    "inbox_receipt_basename",
  ),
)
await settle()
expect("S36 a bare basename does not close a hand-off", bcRead(bidF).state === "acked", bcRead(bidF).state)
push(
  inbound(
    "ses_req",
    "[handoff] DONE docs/issues/fix-worker-store.md wrong-person",
    // ses_b1 claimed another workspace's same-named proposal earlier, but not this one.
    { from: "ses_b1", fromSessionID: "ses_b1", cid: "c_receipt_wrong", kind: "note" },
    "inbox_receipt_wrong",
  ),
)
await settle()
expect("S36 a non-claimant receipt does not close a hand-off", bcRead(bidF).state === "acked", bcRead(bidF).state)
push(
  inbound(
    "ses_req",
    "[handoff] DONE docs/issues/fix-worker-store.md f2-done",
    { from: "ses_f2", fromSessionID: "ses_f2", cid: "c_receipt_exact", kind: "note" },
    "inbox_receipt_exact",
  ),
)
await settle()
expect(
  "S36 the exact issuePath from the claimant closes it",
  bcRead(bidF).state === "done" && bcRead(bidF).receipt?.from === "ses_f2",
  JSON.stringify({ state: bcRead(bidF).state, from: bcRead(bidF).receipt?.from }),
)

// S34 (B3 / R4): ask-lease timeout advances exactly like DECLINE; exhausted
// candidates (`attempts > 3` included) → expired, never a spawn.
out("S34 broadcast WS_G (ask timeout)", "…")
const gBroadcast = await call(
  "collab_broadcast",
  { workspace: WS_G, issuePath: ISSUE_G, confirm: true },
  { sessionID: "ses_req", agent: "build" },
)
const bidG = bidOf(gBroadcast)
expect("S34 the top-1 candidate is asked", bcRead(bidG).asked?.sid === "ses_g1", JSON.stringify(bcRead(bidG).asked))
const gRec = bcRead(bidG)
writeFileSync(
  bcFile(bidG),
  JSON.stringify({ ...gRec, asked: { ...gRec.asked, at: Date.now() - 301_000 } }),
)
const gPreview = await call("collab_accept", { bid: bidG, confirm: false }, { sessionID: "ses_g1", agent: "build" })
out("S34 preview after ask timeout (forged 5 min ago)", gPreview)
const afterG = bcRead(bidG)
expect(
  "S34 ask timeout skips the candidate and counts one attempt",
  afterG.attempts === 1 && afterG.skipped.includes("ses_g1"),
  JSON.stringify({ attempts: afterG.attempts, skipped: afterG.skipped }),
)
expect(
  "S34 ask timeout asks the next candidate",
  afterG.asked?.sid === "ses_g2" && afterG.state === "open",
  JSON.stringify({ asked: afterG.asked?.sid, state: afterG.state }),
)
const promptsBeforeG = prompts.length
writeFileSync(
  bcFile(bidG),
  JSON.stringify({ ...bcRead(bidG), asked: { ...bcRead(bidG).asked, at: Date.now() - 301_000 } }),
)
const createdBeforeG = created.length
await expectFail(
  "S34 exhausted candidates → expired (no re-delivery)",
  () => call("collab_accept", { bid: bidG, confirm: true }, { sessionID: "ses_g1", agent: "build" }),
  /expired/,
)
const afterG2 = bcRead(bidG)
expect(
  "S34 state is expired after exhausting the candidates",
  afterG2.state === "expired" && afterG2.attempts === 2,
  JSON.stringify({ state: afterG2.state, attempts: afterG2.attempts }),
)
expect("S34 an expired hand-off never spawns", created.length === createdBeforeG, `${created.length - createdBeforeG} spawn(s)`)
expect(
  "S34 an expired hand-off is not re-delivered",
  prompts.length === promptsBeforeG && !prompts.some((p) => p.text.includes(bidG)),
  `${prompts.length - promptsBeforeG} prompt(s)`,
)
writeFileSync(
  bcFile(bidG),
  JSON.stringify({
    ...afterG2,
    state: "open",
    attempts: 3,
    skipped: [],
    asked: { sid: "ses_g1", at: Date.now() - 301_000, leaseMs: 300_000 },
  }),
)
await expectFail(
  "S34 attempts > 3 → expired even with a candidate left",
  () => call("collab_accept", { bid: bidG, confirm: false }, { sessionID: "ses_g1", agent: "build" }),
  /expired/,
)
expect(
  "S34 attempts > 3 is persisted as attempts=4 / expired",
  bcRead(bidG).state === "expired" && bcRead(bidG).attempts === 4,
  JSON.stringify({ state: bcRead(bidG).state, attempts: bcRead(bidG).attempts }),
)

// S35 (S1): collab_handoff is idempotent — a repeated call neither re-delivers
// nor resurrects a closed hand-off.
const handoffText = "S35 幂等测试：复核 packages/machine/src/cfg/impl.ts 与 packages/machine/src/cfg/state.ts"
const promptsBeforeH35 = prompts.length
const handoff1 = await call(
  "collab_handoff",
  { target: "ses_a_target", text: handoffText, expected: "review", confirm: true },
  { sessionID: "ses_req", agent: "build" },
)
out("S35 first handoff", handoff1)
const bidH1 = bidOf(handoff1)
expect("S35 first call delivers one prompt", prompts.length === promptsBeforeH35 + 1)
const handoff2 = await call(
  "collab_handoff",
  { target: "ses_a_target", text: handoffText, expected: "review", confirm: true },
  { sessionID: "ses_req", agent: "build" },
)
out("S35 repeated handoff", handoff2)
expect(
  "S35 a repeated handoff is a no-op (same bid, no second delivery)",
  bidOf(handoff2) === bidH1 && prompts.length === promptsBeforeH35 + 1 && handoff2.includes("已存在同一交接"),
  handoff2.split("\n")[0],
)
const h1rec = bcRead(bidH1)
writeFileSync(
  bcFile(bidH1),
  JSON.stringify({ ...h1rec, state: "done", receipt: { from: "ses_a_target", at: Date.now(), note: "sha-1" } }),
)
const handoff3 = await call(
  "collab_handoff",
  { target: "ses_a_target", text: handoffText, expected: "review", confirm: true },
  { sessionID: "ses_req", agent: "build" },
)
out("S35 handoff after the bid was closed", handoff3)
expect(
  "S35 a closed handoff is not resurrected and keeps its receipt",
  handoff3.includes("已闭环") &&
    bcRead(bidH1).state === "done" &&
    bcRead(bidH1).receipt?.note === "sha-1" &&
    prompts.length === promptsBeforeH35 + 1,
  JSON.stringify({ state: bcRead(bidH1).state, note: bcRead(bidH1).receipt?.note }),
)

// S37 (S2): a host that does not echo `location.directory` must not be trusted;
// the freshly created session is rolled back instead of being recorded as OK.
const realCreate = ctx.session.create
const realRemove = ctx.session.remove
const removed = []
ctx.session.create = async (input) => {
  const info = await realCreate(input)
  return { ...info, location: undefined }
}
ctx.session.remove = async ({ sessionID }) => {
  removed.push(sessionID)
  return realRemove({ sessionID })
}
await expectFail(
  "S37 spawn without a verifiable landing is refused",
  () =>
    call(
      "collab_broadcast",
      { workspace: WS_I, issuePath: ISSUE_I, confirm: true },
      { sessionID: "ses_req", agent: "build" },
    ),
  /落点不对/,
)
const ghost = created.at(-1)
expect(
  "S37 the unknown-landing session is rolled back",
  removed.includes(ghost?.id) && !sessions[ghost?.id],
  JSON.stringify({ removed, ghost: ghost?.id }),
)
const wsIRecords = bcBids().filter((name) => {
  try {
    return JSON.parse(readFileSync(join(broadcastDir, name), "utf8")).workspace === WS_I
  } catch {
    return false
  }
})
expect("S37 a rolled-back spawn leaves no record behind", wsIRecords.length === 0, wsIRecords.join(","))
ctx.session.create = realCreate
ctx.session.remove = realRemove

// S38 (S4): a symlinked proposal cannot smuggle an out-of-repo file into the
// global record. (S5) the new guide is listed in the guide index.
const outside = join(dir, "outside-secret.md")
writeFileSync(outside, "# SECRET outside docs/issues\n")
symlinkSync(outside, join(WS_F, "docs", "issues", "fix-symlink.md"))
await expectFail(
  "S38 a symlinked proposal is refused",
  () =>
    call(
      "collab_broadcast",
      { workspace: WS_F, issuePath: "docs/issues/fix-symlink.md", confirm: true },
      { sessionID: "ses_req", agent: "build" },
    ),
  /软链/,
)
const guideIndex = readFileSync(join(repo, ".trellis/spec/guides/index.md"), "utf8")
expect(
  "S38 the cross-workspace guide is listed in the guide index",
  guideIndex.includes("cross-workspace-collab-guide.md"),
  "guides/index.md",
)

const failed = checks.filter((entry) => !entry.ok)
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  for (const entry of failed) console.log(`FAIL: ${entry.title}`)
  process.exit(1)
}
process.exit(0)
