// Independent (cold-context) reproduction for 11-17-collab-auto-receipt.
// Built from scratch: no import of scripts/collab/handoff-harness.mjs.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const repo = "/data/project/muke-pos-app"
const dir = mkdtempSync(join(tmpdir(), "collab-independent-"))
copyFileSync(join(repo, ".opencode/plugins/collab.js"), join(dir, "collab.mjs"))
const broadcastDir = join(dir, "broadcast")
mkdirSync(broadcastDir, { recursive: true })
process.env.COLLAB_BROADCAST_DIR = broadcastDir

const ws = (name) => {
  const p = join(dir, "ws", name)
  mkdirSync(join(p, "docs", "issues"), { recursive: true })
  return p
}
const WS_A = ws("a")
const WS_SPAWN = ws("spawn")
writeFileSync(join(WS_SPAWN, "docs/issues/fix-x.md"), "# x\n\n`apps/pos/src/main.ts`\n")
const HOST = join(dir, "host")

const plugin = (await import(`file://${join(dir, "collab.mjs")}`)).default

// ---------------------------------------------------------------- fake host
const sessions = {
  ses_req: { id: "ses_req", agent: "build", title: "req", time: { updated: Date.now(), busy: 0 }, location: { directory: WS_A } },
  ses_other: { id: "ses_other", agent: "build", title: "other", time: { updated: Date.now(), busy: 0 }, location: { directory: WS_A } },
  ses_host: { id: "ses_host", agent: "build", title: "host", time: { updated: Date.now(), busy: 0 }, location: { directory: HOST } },
  ses_live_busy: { id: "ses_live_busy", agent: "build", title: "busy", time: { updated: Date.now(), busy: 45 * 60 * 1000 }, location: { directory: HOST } },
}
const contexts = new Map()
const contextReads = []
const prompts = []
const tools = []
const hooks = {}
const created = []
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
  location: { directory: WS_A },
  options: {},
  app: { version: "test" },
  storage: {
    async get(k) { return store.get(k) },
    async set(k, v) { store.set(k, v) },
    async remove(k) { store.delete(k) },
    async scan() { return { entries: [] } },
  },
  tool: { async transform(cb) { cb({ add: (d) => tools.push(d) }); return { dispose: async () => {} } } },
  session: {
    async hook(name, cb) { hooks[name] = cb; return { dispose: async () => {} } },
    async get({ sessionID }) {
      if (!sessions[sessionID]) throw new Error(`Session not found: ${sessionID}`)
      return structuredClone(sessions[sessionID])
    },
    async list({ limit = 100 } = {}) { return { data: structuredClone(Object.values(sessions).slice(0, limit)) } },
    async context({ sessionID }) {
      contextReads.push(sessionID)
      const value = contexts.get(sessionID)
      if (typeof value === "function") return value()
      return structuredClone(value ?? [])
    },
    async create(input = {}) {
      const info = {
        id: `ses_spawned_${created.length + 1}`,
        agent: input.agent ?? "build",
        title: input.title ?? "(untitled)",
        time: { created: Date.now(), updated: Date.now() },
        location: { directory: input.location?.directory },
      }
      sessions[info.id] = info
      created.push(info)
      return structuredClone(info)
    },
    async remove() {},
    async prompt(input) { prompts.push(input); return { id: `msg_${prompts.length}`, delivery: input.delivery } },
    async wait() {},
  },
  event: { subscribe: feed },
}
const err = console.error
console.error = () => {}
await plugin.setup(ctx)
console.error = err

const tool = (name) => tools.find((d) => d.name === name)
const call = async (name, input, sessionID = "ses_other") =>
  (await tool(name).execute(input, { sessionID, agent: "build" })).content

// --------------------------------------------------------------- assertions
const results = []
const expect = (title, ok, detail = "") => {
  results.push({ title, ok: Boolean(ok) })
  console.log(`${ok ? "PASS" : "FAIL"} ${title}${detail ? `  [${detail}]` : ""}`)
}
const msg = (text, at = Date.now()) => ({ id: `m_${at}_${text.length}`, type: "assistant", time: { created: at }, content: [{ type: "text", text }] })
const NOW = Date.now()
const file = (bid) => join(broadcastDir, `${bid}.json`)
const lock = (bid) => join(broadcastDir, `${bid}.lock`)
const read = (bid) => JSON.parse(readFileSync(file(bid), "utf8"))

let seq = 0
const seedClaimedSpawn = (opts = {}) => {
  const bid = `b_${String(8_100_000 + ++seq).padStart(16, "0")}`
  const rec = {
    bid,
    scope: "peer",
    workspace: WS_A,
    issuePath: "docs/issues/fix-x.md",
    title: "fix-x",
    expected: "review",
    affectedFiles: [],
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
    from: { sid: "ses_req", directory: WS_A },
    claim: {
      by: opts.by ?? "ses_spawned_x",
      kind: opts.kind ?? "spawn",
      token: "k_t",
      at: opts.at ?? NOW - 301_000,
      leaseMs: 300_000,
      spawner: "ses_req",
    },
    ...(opts.extra ?? {}),
  }
  writeFileSync(file(bid), JSON.stringify(rec, null, 2))
  if (opts.lock !== false && rec.claim?.by) writeFileSync(lock(bid), JSON.stringify({ bid, by: "ses_req", token: "k_t", claimBy: rec.claim.by }))
  return bid
}

// 1) explicit [handoff] BLOCKED
const b1 = seedClaimedSpawn({ by: "ses_spawned_1" })
contexts.set("ses_spawned_1", [msg(`[handoff] BLOCKED ${b1} 该提案已实施（f2f8ef52），无需 implement`)])
const createdBefore = created.length
const promptsBefore = prompts.length
await call("collab_accept", { bid: b1, confirm: false })
let r = read(b1)
expect("1 explicit [handoff] BLOCKED → state=blocked", r.state === "blocked", r.state)
expect("1 receipt.auto=true + from/by = counterpart sid", r.receipt?.auto === true && r.receipt?.from === "ses_spawned_1" && r.receipt?.by === "ses_spawned_1", JSON.stringify(r.receipt))
expect("1 summary keeps the verdict, drops the bid", r.receipt?.note.includes("已实施") && !r.receipt.note.startsWith("b_"), r.receipt?.note)
expect("1 no attempts++, no reopen", r.attempts === 0, `attempts=${r.attempts}`)
expect("1 spawn lock released", !existsSync(lock(b1)), `lock=${existsSync(lock(b1))}`)
expect("1 no new session / no prompt", created.length === createdBefore && prompts.length === promptsBefore, `created+${created.length - createdBefore} prompts+${prompts.length - promptsBefore}`)

// 2) explicit DONE prefix beats a blocked-ish keyword in the summary
const b2 = seedClaimedSpawn({ by: "ses_spawned_2" })
contexts.set("ses_spawned_2", [msg(`[handoff] DONE ${b2} 已修复并提交 79eac02d`)])
await call("collab_accept", { bid: b2, confirm: false })
r = read(b2)
expect("2 explicit DONE wins over 「已修复」 keyword", r.state === "done", r.state)

// 3) keyword only → blocked
const b3 = seedClaimedSpawn({ by: "ses_spawned_3" })
contexts.set("ses_spawned_3", [msg("核对了 37 处调用点，该提案已实施，无需再改。")])
await call("collab_accept", { bid: b3, confirm: false })
r = read(b3)
expect("3 keyword 已实施/无需 → blocked", r.state === "blocked" && r.receipt?.auto === true, r.state)

// 4) keyword only → done
const b4 = seedClaimedSpawn({ by: "ses_spawned_4" })
contexts.set("ses_spawned_4", [msg("实现完成，测试通过。")])
await call("collab_accept", { bid: b4, confirm: false })
r = read(b4)
expect("4 keyword 完成 → done", r.state === "done" && r.receipt?.auto === true, r.state)

// 5) no verdict → old reopen path
const b5 = seedClaimedSpawn({ by: "ses_spawned_5" })
contexts.set("ses_spawned_5", [msg("我核对了一遍调用点，细节见上面的分析。")])
const out5 = await call("collab_accept", { bid: b5, confirm: false })
r = read(b5)
expect("5 no verdict → open + attempts=1 + skipped + no receipt", r.state === "open" && r.attempts === 1 && r.skipped.includes("ses_spawned_5") && !r.receipt, JSON.stringify({ s: r.state, a: r.attempts, rc: r.receipt }))
expect("5 accept preview still answers with the bid", String(out5).includes(b5), String(out5).split("\n")[0])

// 5b) 「核对完成」 must not be done
const b5b = seedClaimedSpawn({ by: "ses_spawned_5b" })
contexts.set("ses_spawned_5b", [msg("核对完成，详见上面 37 处调用点的分析。")])
await call("collab_accept", { bid: b5b, confirm: false })
r = read(b5b)
expect("5b 「核对完成」 not read as done", r.state === "open" && !r.receipt, r.state)

// 6) context throws (404)
const b6 = seedClaimedSpawn({ by: "ses_spawned_6" })
contexts.set("ses_spawned_6", () => { throw new Error("Session not found: ses_spawned_6") })
let threw = false
let out6
try { out6 = await call("collab_accept", { bid: b6, confirm: false }) } catch { threw = true }
r = read(b6)
expect("6 404 does not throw", !threw && String(out6).includes(b6), `threw=${threw}`)
expect("6 404 → old reopen path", r.state === "open" && r.attempts === 1 && !r.receipt, JSON.stringify({ s: r.state, a: r.attempts }))

// 7) stale assistant message (before claim.at) must be ignored
const b7 = seedClaimedSpawn({ by: "ses_spawned_7", at: NOW - 301_000 })
contexts.set("ses_spawned_7", [msg("上一件活儿完成。", NOW - 3_600_000)])
await call("collab_accept", { bid: b7, confirm: false })
r = read(b7)
expect("7 answer older than claim.at is ignored", r.state === "open" && r.attempts === 1 && !r.receipt, JSON.stringify({ s: r.state, rc: r.receipt }))

// 8) kind=accept lapsed → never extracted, never read
const readsBefore8 = contextReads.length
const b8 = seedClaimedSpawn({ by: "ses_spawned_8", kind: "accept" })
contexts.set("ses_spawned_8", [msg("[handoff] DONE 完成")])
await call("collab_accept", { bid: b8, confirm: false })
r = read(b8)
expect("8 lapsed kind=accept is not extracted", r.state === "open" && r.attempts === 1 && !r.receipt, JSON.stringify({ s: r.state, rc: r.receipt }))
expect("8 kind=accept is not even read", !contextReads.slice(readsBefore8).includes("ses_spawned_8"), contextReads.slice(readsBefore8).join(","))

// 8b) state=acked lapsed → not extracted
const b8b = seedClaimedSpawn({ by: "ses_spawned_8b", extra: { state: "acked" } })
contexts.set("ses_spawned_8b", [msg("[handoff] DONE 完成")])
await call("collab_accept", { bid: b8b, confirm: false })
r = read(b8b)
expect("8b acked is not auto-extracted", !r.receipt, JSON.stringify({ s: r.state, rc: r.receipt }))

// 9) protected claimant → never read
const PROTECTED = "ses_e1eb91cebffeTv1467ubJLKebk"
const readsBefore9 = contextReads.length
const b9 = seedClaimedSpawn({ by: PROTECTED })
contexts.set(PROTECTED, [msg("[handoff] DONE 已处理")])
await call("collab_accept", { bid: b9, confirm: false })
r = read(b9)
expect("9 protected claimant: not read", !contextReads.slice(readsBefore9).includes(PROTECTED), contextReads.slice(readsBefore9).join(","))
expect("9 protected claimant: not auto-closed", r.state === "open" && !r.receipt, JSON.stringify({ s: r.state, rc: r.receipt }))

// 10) long answer: ≤200 chars and the tail never lands in the record
const TAIL = "TAIL-MARKER-MUST-NOT-BE-STORED"
const b10 = seedClaimedSpawn({ by: "ses_spawned_10" })
contexts.set("ses_spawned_10", [msg(`[handoff] BLOCKED ${b10} ${"原因很长 ".repeat(150)}${TAIL}`)])
await call("collab_accept", { bid: b10, confirm: false })
const raw10 = readFileSync(file(b10), "utf8")
r = read(b10)
expect("10 note ≤ 200 chars", typeof r.receipt?.note === "string" && r.receipt.note.length <= 200, `${r.receipt?.note?.length} chars`)
expect("10 body tail never stored", !raw10.includes(TAIL), `tailFound=${raw10.includes(TAIL)}`)

// 11) idempotent: a second refresh does not read again and reports closed
const readsBefore11 = contextReads.length
const out11 = await call("collab_accept", { bid: b1, confirm: true })
expect("11 closed bid is not re-read", !contextReads.slice(readsBefore11).includes("ses_spawned_1"), contextReads.slice(readsBefore11).join(","))
expect("11 closed bid reports 已闭环", String(out11).includes("已闭环") && String(out11).includes("state=blocked"), String(out11).split("\n")[0])

// 12) explicit prefix in an older answer is still adopted (last answer has no verdict)
const b12 = seedClaimedSpawn({ by: "ses_spawned_12" })
contexts.set("ses_spawned_12", [msg(`[handoff] BLOCKED ${b12} 已实施`, NOW - 1000), msg("补充：上面结论没变。", NOW - 500)])
await call("collab_accept", { bid: b12, confirm: false })
r = read(b12)
expect("12 explicit [handoff] in an older answer is adopted", r.state === "blocked", JSON.stringify({ s: r.state, rc: r.receipt }))

// 13) requester is not reminded about an auto-closed hand-off
const event = { sessionID: "ses_req", agent: "build", system: [], messages: [] }
await hooks.context(event)
const injected = (event.system ?? []).map((b) => b.text).join("\n")
expect("13 auto-closed bid is not reminded as 未闭环", !injected.includes(`交接未闭环 ${b1}`), injected.includes("交接未闭环") ? injected.slice(0, 200) : "(no reminder lines)")

// ------------------------------------------------- R1 (independent text check)
// 14) context-injected takeover request carries ①②③ + full ids
const b14 = seedClaimedSpawn({ by: "ses_spawned_14", extra: { state: "open", claim: undefined, asked: { sid: "ses_other", at: Date.now(), leaseMs: 300_000 } } })
delete read(b14).claim
const rec14 = read(b14)
delete rec14.claim
writeFileSync(file(b14), JSON.stringify(rec14, null, 2))
const ev14 = { sessionID: "ses_other", agent: "build", system: [], messages: [] }
await hooks.context(ev14)
const text14 = (ev14.system ?? []).map((b) => b.text).join("\n")
const takeover = text14.split("\n").find((line) => line.includes(`接管请求 ${b14}`)) ?? ""
expect("14 injected takeover request has ①②③", ["①", "②", "③"].every((m) => takeover.includes(m)), takeover.slice(0, 120))
expect("14 injected request is copy-pasteable with full bid + sid", takeover.includes(`collab_accept {bid:"${b14}", confirm:true}`) && takeover.includes(`collab_send {target:"ses_req", text:"[handoff] DONE ${b14}`) && takeover.includes(`collab_send {target:"ses_req", text:"[handoff] BLOCKED ${b14}`), "")

// 15) spawn prompt (deliverAsk) + broadcast result both carry ①②③, spawn has no DECLINE
prompts.length = 0
const spawnOut = await call("collab_broadcast", { workspace: WS_SPAWN, issuePath: "docs/issues/fix-x.md", confirm: true }, "ses_host")
const spawnPrompt = prompts.find((p) => p.sessionID === created[created.length - 1]?.id)
expect("15 spawn created one session", created.length === 1, `${created.length}`)
expect("15 spawn takeover prompt has ①②③ + full sid", Boolean(spawnPrompt) && ["①", "②", "③"].every((m) => spawnPrompt.text.includes(m)) && spawnPrompt.text.includes(`collab_send {target:"ses_host"`), spawnPrompt ? "ok" : "missing")
expect("15 spawn prompt has no DECLINE line", Boolean(spawnPrompt) && !spawnPrompt.text.includes("DECLINE"), "spawn=no DECLINE")
expect("15 broadcast result repeats ①②③", ["①", "②", "③"].every((m) => String(spawnOut).includes(m)) && String(spawnOut).includes(`collab_send {target:"ses_host"`), String(spawnOut).split("\n").slice(-3).join(" | ").slice(0, 160))

// 16) wake prompt (busy > 30min) carries ①②③ + DECLINE, and the result too
const WS_W = ws("w")
writeFileSync(join(WS_W, "docs/issues/fix-wake.md"), "# pos main 修复（11-17-wake）\n\n`apps/pos/src/main.ts`\n")
const busyAge = 45 * 60 * 1000
sessions.ses_wake = {
  id: "ses_wake",
  agent: "build",
  title: "11-17-wake pos main 修复",
  time: { updated: Date.now() - 60_000, busy: Date.now() - busyAge, idle: 0 },
  location: { directory: WS_W },
}
contexts.set("ses_wake", [
  { id: "m_tool_w", type: "assistant", time: { created: Date.now() - 120_000 }, content: [{ type: "tool", name: "edit", state: { status: "completed", input: { filePath: "apps/pos/src/main.ts" } } }] },
])
prompts.length = 0
const wakeOut = await call("collab_broadcast", { workspace: WS_W, issuePath: "docs/issues/fix-wake.md", confirm: true }, "ses_host")
const wakePrompt = prompts.find((p) => p.sessionID === "ses_wake")
expect("16 busy top-1 got a wake prompt", Boolean(wakePrompt) && String(wakeOut).includes("叫醒"), String(wakeOut).split("\n")[0].slice(0, 120))
expect("16 wake prompt has ①②③ + full bid + requester sid", Boolean(wakePrompt) && ["①", "②", "③"].every((m) => wakePrompt.text.includes(m)) && wakePrompt.text.includes('target:"ses_host"') && wakePrompt.text.includes("DECLINE"), wakePrompt ? "ok" : "missing")
expect("16 broadcast result has ①②③ + DECLINE", ["①", "②", "③"].every((m) => String(wakeOut).includes(m)) && String(wakeOut).includes("DECLINE"), String(wakeOut).split("\n").slice(-2).join(" | ").slice(0, 160))

// 18) who can trigger the extraction? A bystander / another workspace?
const WS_B = ws("b")
sessions.ses_bystander = { id: "ses_bystander", agent: "build", title: "bystander", time: { updated: Date.now(), busy: 0 }, location: { directory: WS_B } }
const b18 = seedClaimedSpawn({ by: "ses_spawned_18" })
contexts.set("ses_spawned_18", [msg("[handoff] DONE 完成")])
const readsBefore18 = contextReads.length
const ev18 = { sessionID: "ses_bystander", agent: "build", system: [], messages: [] }
await hooks.context(ev18)
r = read(b18)
console.log(`PROBE bystander(WS_B) read counterpart=${contextReads.slice(readsBefore18).includes("ses_spawned_18")} state=${r.state}`)

// 19) collab_list stays a read-only snapshot (no extraction, no write)
const b19 = seedClaimedSpawn({ by: "ses_spawned_19" })
contexts.set("ses_spawned_19", [msg("[handoff] DONE 完成")])
const readsBefore19 = contextReads.length
await call("collab_list", { limit: 5 }, "ses_other")
r = read(b19)
expect("19 collab_list does not extract", !contextReads.slice(readsBefore19).includes("ses_spawned_19") && r.state === "claimed", JSON.stringify({ s: r.state }))

// 20) read window is bounded to the trailing 10 assistant answers
const b20 = seedClaimedSpawn({ by: "ses_spawned_20" })
const many = [msg(`[handoff] BLOCKED ${b20} 已实施`, NOW - 20_000)]
for (let i = 0; i < 11; i += 1) many.push(msg(`过程记录 ${i}`, NOW - 19_000 + i * 100))
contexts.set("ses_spawned_20", many) // 12 assistant answers: the [handoff] line is #1, outside the last 10
const b20b = seedClaimedSpawn({ by: "ses_spawned_20b" })
const many2 = [msg(`[handoff] BLOCKED ${b20b} 已实施`, NOW - 20_000)]
for (let i = 0; i < 9; i += 1) many2.push(msg(`过程记录 ${i}`, NOW - 19_000 + i * 100))
contexts.set("ses_spawned_20b", many2) // 10 assistant answers: the [handoff] line is inside the window
await call("collab_accept", { bid: b20, confirm: false })
await call("collab_accept", { bid: b20b, confirm: false })
const r20 = read(b20)
const r20b = read(b20b)
expect("20 answer #12 back is outside the 10-answer window → not adopted", r20.state === "open" && !r20.receipt, JSON.stringify({ s: r20.state }))
expect("20 answer #10 back is inside the window → adopted", r20b.state === "blocked", JSON.stringify({ s: r20b.state }))

// 21) the reminder is still surfaced only once (unchanged behaviour)
const b21 = seedClaimedSpawn({ by: "ses_spawned_21", kind: "accept", extra: { state: "acked" } })
const ev21a = { sessionID: "ses_req", agent: "build", system: [], messages: [] }
await hooks.context(ev21a)
const first21 = (ev21a.system ?? []).map((b) => b.text).join("\n")
const ev21b = { sessionID: "ses_req", agent: "build", system: [], messages: [] }
await hooks.context(ev21b)
const second21 = (ev21b.system ?? []).map((b) => b.text).join("\n")
console.log(`PROBE reminder first=${first21.includes(`交接未闭环 ${b21}`)} second=${second21.includes(`交接未闭环 ${b21}`)}`)

// 22) template echo probe: does quoting the requested receipt format close the bid?
const echoProbes = [
  ["template echo", "完成后我会发：`[handoff] DONE <bid> <摘要>`，先确认一下环境。"],
  ["echo with bid", "回执格式 [handoff] DONE b_00000000000abcde <摘要> —— 但我还没开始。"],
  ["negated receipt", "我不会发 [handoff] DONE，因为环境起不来。"],
]
const echoProbes2 = [
  ["echo then blocked", ["我会按提示发 `[handoff] DONE <bid> <摘要>`。", "环境起不来，我还没开始，需要人接手。"]],
]
for (const [label, texts] of echoProbes2) {
  const sid = `ses_echo2_${results.length}`
  sessions[sid] = { id: sid, agent: "explore", title: `impl:${sid}`, time: { created: NOW, updated: NOW, busy: 0 }, location: { directory: WS_A } }
  contexts.set(sid, texts.map((t, i) => msg(t, NOW - 1000 + i)))
  const bid = seedClaimedSpawn({ by: sid })
  await call("collab_accept", { bid, confirm: false })
  const rec = read(bid)
  console.log(`PROBE ${label.padEnd(22)} → state=${rec.state ?? "-"} note=${JSON.stringify(rec.receipt?.note ?? null)}`)
}
for (const [label, text] of echoProbes) {
  const sid = `ses_echo_${results.length}`
  sessions[sid] = { id: sid, agent: "explore", title: `impl:${sid}`, time: { created: NOW, updated: NOW, busy: 0 }, location: { directory: WS_A } }
  contexts.set(sid, [msg(text)])
  const bid = seedClaimedSpawn({ by: sid })
  await call("collab_accept", { bid, confirm: false })
  const rec = read(bid)
  console.log(`PROBE ${label.padEnd(22)} → state=${rec.state ?? "-"} note=${JSON.stringify(rec.receipt?.note ?? null)}`)
}

// 17) negation probes (risk analysis, not AC): what does the keyword path do?
const probes = [
  ["未完成", "任务未完成，卡在权限问题上"],
  ["无法完成", "无法完成，需要人接手"],
  ["not done", "not done yet, blocked by permissions"],
  ["已完成", "已完成核对，无需修改"],
  ["already implemented", "already implemented in 79eac02d"],
]
for (const [label, text] of probes) {
  const sid = `ses_probe_${results.length}`
  sessions[sid] = { id: sid, agent: "explore", title: `impl:${sid}`, time: { created: NOW, updated: NOW, busy: 0 }, location: { directory: WS_A } }
  contexts.set(sid, [msg(text)])
  const bid = seedClaimedSpawn({ by: sid })
  await call("collab_accept", { bid, confirm: false })
  const rec = read(bid)
  console.log(`PROBE ${label.padEnd(22)} → state=${rec.state ?? "-"} note=${JSON.stringify(rec.receipt?.note ?? null)}`)
}

const failed = results.filter((x) => !x.ok)
console.log(`\n=== independent: ${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  for (const f of failed) console.log(`FAILED: ${f.title}`)
  process.exit(1)
}
process.exit(0)
