/**
 * Deterministic harness for the collab hand-off protocol (no model calls).
 *
 *   node .trellis/tasks/11-17-collab-handoff/research/handoff-harness.mjs
 *
 * Copies `.opencode/plugins/collab.js` to a `.mjs` temp file (the repo is not
 * `type: module`) and drives it with a fake plugin ctx: in-memory storage, no
 * sessions, no event stream from a real server. Covers the thread state machine,
 * forced queue for read-only agents, injection de-duplication (metadata cid +
 * envelope-text fallback), guard rails, and `collab_wait {threadID}`.
 *
 * S1–S16 print their output only (unchanged from the first implementation round).
 * S17–S22 are assertion-based — the post-review fixes — and the process exits 1
 * if any of them fails:
 *   S17/S18  protect lineage: direct child + grandchild of a protected session
 *   S19      reply / wait by a non-participant are refused
 *   S20      kind:reply must target the thread's counterpart; no thread pollution
 *   S21      reusing a thread reopens it; wait never returns the stale reply
 *   S22      legacy thread-less message hint + fast `collab_wait` validation
 */
import { copyFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repo = resolve(import.meta.dirname, "../../../..")
const dir = mkdtempSync(join(tmpdir(), "collab-harness-"))
const entry = join(dir, "collab.mjs")
copyFileSync(join(repo, ".opencode/plugins/collab.js"), entry)
const plugin = (await import(`file://${entry}`)).default

const store = new Map()
const prompts = []
const tools = []
const hooks = {}
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

const sessions = {
  ses_aaa: { id: "ses_aaa", agent: "build", title: "A", time: { busy: 1 } },
  ses_bbb: { id: "ses_bbb", agent: "explore", title: "B", time: { busy: 1 } },
  "ses_e1eb91cebffeTv1467ubJLKebk": { id: "ses_e1eb91cebffeTv1467ubJLKebk", agent: "build", title: "schema", time: { busy: 1 } },
  // Lineage fixtures: `ses_child` is a direct sub-session of the protected
  // schema line, `ses_grand` is its grandchild (two hops up).
  ses_child: {
    id: "ses_child",
    parentID: "ses_e1eb91cebffeTv1467ubJLKebk",
    agent: "trellis-implement",
    title: "child of schema",
    time: { busy: 1 },
  },
  ses_grand: {
    id: "ses_grand",
    parentID: "ses_child",
    agent: "trellis-implement",
    title: "grandchild of schema",
    time: { busy: 1 },
  },
  // Unrelated sessions used to prove reply routing / participant checks.
  ses_ccc: { id: "ses_ccc", agent: "build", title: "C", time: { busy: 1 } },
  ses_ddd: { id: "ses_ddd", agent: "build", title: "D", time: { busy: 1 } },
}

const ctx = {
  location: { directory: "/tmp/collab-harness" },
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
      return sessions[sessionID]
    },
    async list({ limit = 20 } = {}) {
      return { data: Object.values(sessions).slice(0, limit) }
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
const settle = () => new Promise((resolveSettle) => setTimeout(resolveSettle, 30))
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
// S17–S22 use these so the harness is a real regression gate: it exits 1 when
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

const failed = checks.filter((entry) => !entry.ok)
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  for (const entry of failed) console.log(`FAIL: ${entry.title}`)
  process.exit(1)
}
process.exit(0)
