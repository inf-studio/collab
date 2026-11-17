// Independent probes for the review-fix round (H1 echo/negation, H2 actor gate).
// Deliberately *not* the harness: own fake ctx, own fixtures, fresh temp dir.
//   node .trellis/tasks/11-17-collab-auto-receipt/research/impl-probes-h1-h2.mjs
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const repo = "/data/project/muke-pos-app"
const dir = mkdtempSync(join(tmpdir(), "collab-probe-h1-"))
copyFileSync(join(repo, ".opencode/plugins/collab.js"), join(dir, "collab.mjs"))
const broadcastDir = join(dir, "broadcast")
mkdirSync(broadcastDir, { recursive: true })
process.env.COLLAB_BROADCAST_DIR = broadcastDir

const WS = join(dir, "ws")
mkdirSync(join(WS, "docs", "issues"), { recursive: true })
writeFileSync(join(WS, "docs/issues/fix-x.md"), "# fix-x\n\n`apps/pos/src/main.ts`\n")

const sessions = {
  ses_req: { id: "ses_req", agent: "build", title: "req", time: { updated: Date.now(), busy: 0 }, location: { directory: WS } },
  ses_bystander: { id: "ses_bystander", agent: "build", title: "b", time: { updated: Date.now(), busy: 0 }, location: { directory: WS } },
}
const contexts = new Map()
const reads = []
const hooks = {}
const store = new Map()
const queue = []
let wake
async function* feed() {
  for (;;) {
    if (!queue.length) await new Promise((r) => (wake = r))
    const next = queue.shift()
    if (!next) return
    yield next
  }
}

const ctx = {
  location: { directory: WS },
  options: {},
  app: { version: "probe" },
  storage: {
    async get(k) { return store.get(k) },
    async set(k, v) { store.set(k, v) },
    async remove(k) { store.delete(k) },
    async scan() { return { entries: [] } },
  },
  tool: { async transform(cb) { cb({ add() {} }); return { dispose: async () => {} } } },
  session: {
    async hook(name, cb) { hooks[name] = cb; return { dispose: async () => {} } },
    async get({ sessionID }) {
      if (!sessions[sessionID]) throw new Error(`Session not found: ${sessionID}`)
      return structuredClone(sessions[sessionID])
    },
    async list() { return { data: structuredClone(Object.values(sessions)) } },
    async context({ sessionID }) {
      reads.push(sessionID)
      const value = contexts.get(sessionID)
      if (typeof value === "function") return value()
      return structuredClone(value ?? [])
    },
    async create(input = {}) {
      throw new Error(`probe should never spawn (${input.title})`)
    },
    async remove() {},
    async prompt() { return { id: "msg_probe" } },
    async wait() {},
  },
  event: { subscribe: feed },
}
const err = console.error
console.error = () => {}
const plugin = (await import(`file://${join(dir, "collab.mjs")}`)).default
await plugin.setup(ctx)
console.error = err

const NOW = Date.now()
const msg = (text, at = NOW) => ({ id: `m_${at}_${text.length}`, type: "assistant", time: { created: at }, content: [{ type: "text", text }] })
const read = (bid) => JSON.parse(readFileSync(join(broadcastDir, `${bid}.json`), "utf8"))

let seq = 0
const seed = (messages) => {
  const bid = `b_${String(8_300_000 + ++seq).padStart(16, "0")}`
  const sid = `ses_probe_${seq}`
  sessions[sid] = { id: sid, agent: "explore", title: `impl:${sid}`, time: { created: NOW, updated: NOW, busy: 0 }, location: { directory: WS } }
  contexts.set(sid, messages(bid).map((text, i) => msg(text, NOW - 1000 + i)))
  const record = {
    bid,
    scope: "peer",
    workspace: WS,
    issuePath: "docs/issues/fix-x.md",
    title: "fix-x",
    expected: "review",
    affectedFiles: ["apps/pos/src/main.ts"],
    state: "claimed",
    candidates: [],
    replies: [],
    seenBy: [],
    askSeen: [],
    reminded: [],
    skipped: [],
    declines: [],
    attempts: 0,
    createdAt: NOW - 600_000,
    updatedAt: NOW - 600_000,
    from: { sid: "ses_req", directory: WS },
    claim: { by: sid, kind: "spawn", token: "k_t", at: NOW - 301_000, leaseMs: 300_000, spawner: "ses_req" },
  }
  writeFileSync(join(broadcastDir, `${bid}.json`), JSON.stringify(record, null, 2))
  writeFileSync(join(broadcastDir, `${bid}.lock`), JSON.stringify({ bid, by: "ses_req", token: "k_t", claimBy: sid }))
  return { bid, sid }
}
const refreshAs = async (sessionID) => {
  const event = { sessionID, agent: "build", system: [], messages: [] }
  await hooks.context(event)
  return event
}

const cases = [
  ["template echo <bid>/<摘要>", (bid) => [`完成后我会发：\`[handoff] DONE <bid> <摘要>\`，先确认一下环境。`]],
  ["template echo, real bid, in a promise", (bid) => [`我会按提示发 [handoff] DONE ${bid} <摘要>，先看环境。`]],
  ["template echo, foreign bid", () => ["回执格式 [handoff] DONE b_00000000000abcde <摘要> —— 但我还没开始。"]],
  ["negated receipt", () => ["我不会发 [handoff] DONE，因为环境起不来。"]],
  ["任务未完成", () => ["任务未完成，卡在权限问题上"]],
  ["无法完成", () => ["无法完成，需要人接手"]],
  ["not done yet", () => ["not done yet, blocked by permissions"]],
  ["echo in #1 + not started in #2", (bid) => [`我会按提示发 [handoff] DONE ${bid} <摘要>。`, "环境起不来，我还没开始，需要人接手。"]],
  ["genuine DONE (current bid)", (bid) => [`[handoff] DONE ${bid} 已修复并提交 79eac02d`]],
  ["genuine BLOCKED (current bid)", (bid) => [`[handoff] BLOCKED ${bid} 该提案已实施，无需 implement`]],
  ["keyword done", () => ["实现完成，测试通过。"]],
  ["keyword blocked", () => ["核对了 37 处调用点，该提案已实施，无需再改。"]],
]

let bad = 0
for (const [label, messages] of cases) {
  const { bid } = seed(messages)
  await refreshAs("ses_req")
  const record = read(bid)
  console.log(
    `${label.padEnd(38)} → state=${String(record.state).padEnd(8)} attempts=${record.attempts} note=${JSON.stringify(record.receipt?.note ?? null)}`,
  )
}

// H2: a bystander (same workspace) triggers the refresh of a lapsed spawn with a verdict.
{
  const { bid, sid } = seed((id) => [`[handoff] DONE ${id} 已修复`])
  reads.length = 0
  await refreshAs("ses_bystander")
  const bystander = read(bid)
  const bystanderRead = reads.includes(sid)
  console.log(
    `H2 bystander                             → read=${bystanderRead} state=${bystander.state} attempts=${bystander.attempts}`,
  )
  if (bystanderRead || bystander.state !== "open" || bystander.receipt) bad += 1
}
{
  // A separate record: the bystander refresh above already advanced its own bid
  // (one-shot window, design §2), so the requester case needs a fresh one.
  const { bid, sid } = seed((id) => [`[handoff] DONE ${id} 已修复`])
  reads.length = 0
  await refreshAs("ses_req")
  const owner = read(bid)
  const ownerRead = reads.includes(sid)
  console.log(`H2 requester                             → read=${ownerRead} state=${owner.state} note=${JSON.stringify(owner.receipt?.note ?? null)}`)
  if (!ownerRead || owner.state !== "done" || owner.receipt?.auto !== true) bad += 1
}
console.log(bad ? `\n=== ${bad} H1/H2 probe(s) violated` : "\n=== H1/H2 probes: all as expected")
process.exit(bad ? 1 : 0)
