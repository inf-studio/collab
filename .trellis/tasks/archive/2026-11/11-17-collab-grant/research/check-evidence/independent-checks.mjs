// Independent (cold-context) repro for 11-17-collab-grant R2/R3/R4/R5/R7.
// Own fake host, own sessions, own ledger dir. Imports the real plugin file.
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = '/data/project/muke-pos-app'
const dir = mkdtempSync(join(tmpdir(), 'check-grant-'))
const entry = join(dir, 'collab.mjs')
copyFileSync(join(repo, '.opencode/plugins/collab.js'), entry)

const grantDir = join(dir, 'grants')
const broadcastDir = join(dir, 'broadcast')
process.env.COLLAB_GRANT_DIR = grantDir
process.env.COLLAB_BROADCAST_DIR = broadcastDir
process.env.COLLAB_CONFIG = join(dir, 'no-such-collab.json') // isolate from real config
delete process.env.COLLAB_SERVER_URL

// ------------------------------------------------------------------ fake host
const sessions = {}
const patches = []
const switches = []
const prompts = []
const tools = []
const failPatch = new Set()
const failSwitch = new Set()
const store = new Map()
let toolsRegistered = false

const mkSession = (id, agent, location, permissions) => {
  sessions[id] = { id, agent, title: `fixture ${id}`, location: { directory: location }, time: { created: Date.now(), updated: Date.now() } }
  if (permissions !== undefined) sessions[id].permissions = structuredClone(permissions)
  return sessions[id]
}
const permissionsOf = id => structuredClone(sessions[id].permissions ?? null)

const ctx = {
  location: { directory: '/tmp/check-ws' },
  options: {},
  app: { version: 'test' },
  storage: {
    async get(k) { return store.get(k) === undefined ? undefined : structuredClone(store.get(k)) },
    async set(k, v) { store.set(k, structuredClone(v)) },
    async remove(k) { store.delete(k) },
    async scan() { return { entries: [] } },
  },
  tool: {
    async transform(cb) { if (!toolsRegistered) { cb({ add: def => tools.push(def) }); toolsRegistered = true } return { dispose: async () => {} } },
  },
  session: {
    async hook() { return { dispose: async () => {} } },
    async get({ sessionID }) {
      if (!sessions[sessionID]) throw new Error(`Session not found: ${sessionID}`)
      return structuredClone(sessions[sessionID])
    },
    async list({ limit = 20, directory } = {}) {
      return { data: structuredClone(Object.values(sessions).filter(s => !directory || s.location?.directory === directory).slice(0, limit)) }
    },
    async context() { return [] },
    async create(input = {}) {
      const id = `ses_spawn_${Object.keys(sessions).filter(s => s.startsWith('ses_spawn_')).length + 1}`
      mkSession(id, input.agent ?? 'build', input.location?.directory, undefined)
      sessions[id].title = input.title ?? '(untitled)'
      return structuredClone(sessions[id])
    },
    async remove({ sessionID }) { delete sessions[sessionID] },
    async update(input = {}) {
      const { sessionID } = input
      if (!sessions[sessionID]) throw new Error(`HTTP 404: SessionNotFoundError`)
      if (failPatch.has(sessionID) || failPatch.has('*')) throw new Error(`HTTP 403: patch refused (${sessionID})`)
      if (input.permissions !== undefined) {
        sessions[sessionID].permissions = structuredClone(input.permissions)
        patches.push({ sessionID, permissions: structuredClone(input.permissions) })
      }
    },
    async switchAgent(input = {}) {
      const { sessionID, agent } = input
      if (!sessions[sessionID]) throw new Error(`HTTP 404: SessionNotFoundError`)
      if (failSwitch.has(sessionID) || failSwitch.has('*')) throw new Error(`HTTP 403: switch refused (${sessionID})`)
      sessions[sessionID].agent = agent
      switches.push({ sessionID, agent })
    },
    async prompt(input) { prompts.push(input); return { id: `msg_${prompts.length}` } },
    async wait() {},
  },
  event: { async *subscribe() {} },
}

const originalError = console.error
console.error = () => {}
const plugin = (await import(`file://${entry}`)).default
await plugin.setup(ctx)
const internals = (await import(`file://${entry}`)).__internals
console.error = originalError

const tool = name => tools.find(t => t.name === name)
const call = async (name, input, context = { sessionID: 'ses_check_req', agent: 'build' }) => {
  const t = tool(name)
  if (!t) throw new Error(`tool ${name} not registered: ${tools.map(t => t.name).join(',')}`)
  const res = await t.execute(input, context)
  return Array.isArray(res?.content) ? res.content.join('\n') : String(res?.content ?? '')
}
const ledgerDir = () => (existsSync(grantDir) ? readdirSync(grantDir) : [])
const ledger = sid => {
  const f = join(grantDir, `${sid}.json`)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
}

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

// ---------------------------------------------------------------- fixtures
const WS = join(dir, 'ws')
mkdirSync(join(WS, 'docs', 'issues'), { recursive: true })
writeFileSync(join(WS, 'docs', 'issues', 'fix-check.md'), '# check fixture\n\n`apps/pos/src/main.ts`\n')
mkdirSync(join(dir, 'other-ws', 'docs', 'issues'), { recursive: true })
const OTHER = join(dir, 'other-ws')
writeFileSync(join(OTHER, 'docs', 'issues', 'fix-other.md'), '# other fixture\n\n`apps/pos/src/main.ts`\n')

// ===================================================== R3 — merge never widens
const BASE = [
  { action: 'edit', resource: '*', effect: 'deny' },
  { action: 'read', resource: '*', effect: 'allow' },
  { action: 'collab_list', resource: '*', effect: 'ask' },
  { action: 'collab_send', resource: '*', effect: 'deny' },
  { action: 'shell', resource: '*', effect: 'deny' },
]
mkSession('ses_check_merge', 'explore', WS, BASE)
const baseline = permissionsOf('ses_check_merge')
const previewMerge = await call('collab_grant', { target: 'ses_check_merge', confirm: false })
check('R3 preview writes nothing (no PATCH)', patches.length === 0, `patches=${patches.length}`)
check('R3 preview makes no ledger', ledger('ses_check_merge') === null)
const g1 = await call('collab_grant', { target: 'ses_check_merge', confirm: true })
const afterMerge = permissionsOf('ses_check_merge')
check('R3 base order kept verbatim as a prefix', JSON.stringify(afterMerge.slice(0, baseline.length)) === JSON.stringify(baseline), afterMerge)
check('R3 edit/shell deny untouched', afterMerge.some(r => r.action === 'edit' && r.effect === 'deny') && afterMerge.some(r => r.action === 'shell' && r.effect === 'deny'))
check('R3 collab_list ask NOT widened to allow', afterMerge.filter(r => r.action === 'collab_list').length === 1 && afterMerge.find(r => r.action === 'collab_list').effect === 'ask', afterMerge.filter(r => r.action === 'collab_list'))
check('R3 collab_send deny NOT widened', afterMerge.filter(r => r.action === 'collab_send').length === 1 && afterMerge.find(r => r.action === 'collab_send').effect === 'deny')
check('R3 only the 3 truly missing actions appended', afterMerge.slice(baseline.length).map(r => `${r.action}:${r.effect}`).sort().join(',') === 'collab_inbox:allow,collab_reply:allow,collab_wait:allow', afterMerge.slice(baseline.length))
check('R3 no edit/write/shell allow introduced', !afterMerge.some(r => ['edit', 'write', 'shell'].includes(r.action) && r.effect === 'allow'))
const ledger1 = ledger('ses_check_merge')
check('R4 ledger before === original 5-rule snapshot', JSON.stringify(ledger1?.before) === JSON.stringify(baseline), ledger1?.before)

// =========================================================== R4 — idempotency
const patchCount1 = patches.length
const g2 = await call('collab_grant', { target: 'ses_check_merge', confirm: true })
check('R4 re-grant sends no second PATCH', patches.length === patchCount1, `patches ${patchCount1}→${patches.length}`)
check('R4 re-grant reports changed=false', /changed=false/.test(g2), g2.split('\n')[0])
const ledger2 = ledger('ses_check_merge')
check('R4 first `before` snapshot not overwritten', JSON.stringify(ledger2?.before) === JSON.stringify(baseline), ledger2?.before)
check('R4 `added` not duplicated', JSON.stringify(ledger2?.added) === JSON.stringify(ledger1?.added), `added=${ledger2?.added}`)

// ============================================================== R2 — revoke
const rvPreview = await call('collab_grant', { target: 'ses_check_merge', revoke: true, confirm: false })
check('R2 revoke preview writes nothing', patches.length === patchCount1 && ledger('ses_check_merge') !== null)
const rv = await call('collab_grant', { target: 'ses_check_merge', revoke: true, confirm: true })
check('R2 revoke round-trips to the exact snapshot', JSON.stringify(permissionsOf('ses_check_merge')) === JSON.stringify(baseline), permissionsOf('ses_check_merge'))
check('R2 revoke drops the ledger file', ledger('ses_check_merge') === null)
const rv2 = await call('collab_grant', { target: 'ses_check_merge', revoke: true, confirm: true })
check('R2 second revoke reports "nothing to restore" and does not throw', /无可还原/.test(rv2), rv2.split('\n')[0])
check('R2 second revoke changed nothing', JSON.stringify(permissionsOf('ses_check_merge')) === JSON.stringify(baseline))

// =========================================================== R5 — 403 patch
const baseFail = [{ action: 'read', resource: '*', effect: 'allow' }]
mkSession('ses_check_fail', 'explore', WS, baseFail)
failPatch.add('ses_check_fail')
const gFail = await call('collab_grant', { target: 'ses_check_fail', confirm: true })
check('R5 403 reported readably, not thrown', /未授予权限/.test(gFail) && /HTTP 403/.test(gFail), gFail.split('\n')[0])
check('R5 403 leaves permissions untouched', JSON.stringify(permissionsOf('ses_check_fail')) === JSON.stringify(baseFail))
check('R5 403 writes no ledger', ledger('ses_check_fail') === null)

// ===================================================== R1 — spawn auto grant
const beforeSpawnPatches = patches.length
const spawnOk = await call('collab_broadcast', { workspace: OTHER, issuePath: 'docs/issues/fix-other.md', expected: 'implement', confirm: true }, { sessionID: 'ses_check_req', agent: 'build' })
const spawnedOk = Object.values(sessions).find(s => s.location?.directory === OTHER)
check('R1 spawn created a session in the target workspace', Boolean(spawnedOk), spawnedOk?.id)
check('R1 spawned session got exactly the 5 collab allows', JSON.stringify(permissionsOf(spawnedOk.id)) === JSON.stringify(internals.collabPermissionRules()), permissionsOf(spawnedOk.id))
check('R1 exactly one PATCH, for the spawned session only', patches.length === beforeSpawnPatches + 1 && patches.at(-1).sessionID === spawnedOk.id, `patches+${patches.length - beforeSpawnPatches}`)
check('R1 no edit/write/shell granted', !permissionsOf(spawnedOk.id).some(r => ['edit', 'write', 'shell'].includes(r.action)))
check('R1 spawn never promotes the agent', switches.length === 0 && spawnedOk.agent === 'explore', `${spawnedOk.agent} switches=${switches.length}`)
check('R1 spawn ledger records reason=spawn with empty before', ledger(spawnedOk.id)?.reason === 'spawn' && JSON.stringify(ledger(spawnedOk.id)?.before) === '[]', ledger(spawnedOk.id))
check('R1 non-spawned, non-granted session untouched (no ledger)', ledger('ses_check_req') === null && !patches.some(p => p.sessionID === 'ses_check_req'))

// R7 interplay: expected:"review" hand-off must never promote
const mkReviewWs = join(dir, 'review-ws'); mkdirSync(join(mkReviewWs, 'docs', 'issues'), { recursive: true })
writeFileSync(join(mkReviewWs, 'docs', 'issues', 'fix-review.md'), '# review fixture\n\n`apps/pos/src/main.ts`\n')
const spawnReview = await call('collab_broadcast', { workspace: mkReviewWs, issuePath: 'docs/issues/fix-review.md', expected: 'review', confirm: true }, { sessionID: 'ses_check_req', agent: 'build' })
const spawnedReview = Object.values(sessions).find(s => s.location?.directory === mkReviewWs)
check('R7 expected:"review" spawn never promotes', switches.length === 0 && spawnedReview?.agent === 'explore', `${spawnedReview?.agent} switches=${switches.length}`)
check('R7 review spawn still only grants (no agent switch)', Boolean(ledger(spawnedReview.id)) && ledger(spawnedReview.id).agentBefore === undefined, ledger(spawnedReview.id))

// R1/R5: spawn with a refused grant still delivers the takeover
const failWs = join(dir, 'fail-ws'); mkdirSync(join(failWs, 'docs', 'issues'), { recursive: true })
writeFileSync(join(failWs, 'docs', 'issues', 'fix-spawnfail.md'), '# spawn fail fixture\n\n`apps/pos/src/main.ts`\n')
failPatch.add('*')
const promptsBefore = prompts.length
let spawnFailText = ''
let spawnFailThrew = false
try {
  spawnFailText = await call('collab_broadcast', { workspace: failWs, issuePath: 'docs/issues/fix-spawnfail.md', expected: 'implement', confirm: true }, { sessionID: 'ses_check_req', agent: 'build' })
} catch (error) { spawnFailThrew = true; spawnFailText = String(error?.message ?? error) }
const spawnedFail = Object.values(sessions).find(s => s.location?.directory === failWs)
check('R5 spawn grant failure does not throw', !spawnFailThrew, spawnFailText.split('\n')[0])
check('R5 spawn still delivers the takeover request', prompts.length > promptsBefore && Boolean(spawnedFail), `prompts+${prompts.length - promptsBefore}`)
check('R5 broadcast record keeps permissionGrant=failed', /未授予权限/.test(spawnFailText), spawnFailText.split('\n').find(l => /未授予权限/.test(l)))
check('R5 failed grant leaves the spawned session rule-less', permissionsOf(spawnedFail.id) === null)
failPatch.delete('*')

// ===================================================== R7 — promote / revert
mkSession('ses_check_promote', 'explore', WS, undefined)
const pv = await call('collab_promote', { target: 'ses_check_promote', confirm: false })
check('R7 preview switches nothing', switches.length === 0)
check('R7 preview shows explore → build', /原 agent explore → 目标 agent build/.test(pv), pv.split('\n').slice(1, 3).join(' / '))
const bad1 = await (async () => { try { return await call('collab_promote', { target: 'ses_check_promote', agent: 'trellis-implement', confirm: true }) } catch (e) { return `THROW: ${e.message}` } })()
check('R7 non-whitelisted agent refused (nothing switched)', /THROW: .*白名单/.test(bad1) && switches.length === 0, bad1)
const bad2 = await (async () => { try { return await call('collab_promote', { target: 'ses_check_promote', agent: 'explore', confirm: true }) } catch (e) { return `THROW: ${e.message}` } })()
check('R7 explore itself cannot be a promote target', /THROW: .*白名单/.test(bad2) && switches.length === 0, bad2)
const p1 = await call('collab_promote', { target: 'ses_check_promote', confirm: true })
check('R7 confirm switches explore → build', sessions['ses_check_promote'].agent === 'build' && switches.length === 1, p1.split('\n')[0])
check('R7 ledger records agentBefore=explore', ledger('ses_check_promote')?.agentBefore === 'explore', ledger('ses_check_promote'))
check('R7 promote wrote no permissions half', ledger('ses_check_promote')?.before === undefined)
const p2 = await call('collab_promote', { target: 'ses_check_promote', confirm: true })
check('R7 re-promote same agent is a no-op and keeps the first agentBefore', switches.length === 1 && ledger('ses_check_promote')?.agentBefore === 'explore', `switches=${switches.length} agentBefore=${ledger('ses_check_promote')?.agentBefore}`)

// ledger halves do not clobber each other: grant on a promoted session
mkSession('ses_check_both', 'explore', WS, [{ action: 'read', resource: '*', effect: 'allow' }])
await call('collab_promote', { target: 'ses_check_both', confirm: true })
await call('collab_grant', { target: 'ses_check_both', confirm: true })
const both1 = ledger('ses_check_both')
check('both halves coexist (agentBefore + before/added)', both1?.agentBefore === 'explore' && Array.isArray(both1?.before) && both1.before.length === 1, both1)
await call('collab_grant', { target: 'ses_check_both', revoke: true, confirm: true })
const afterRevokeOnly = ledger('ses_check_both')
check('revoke clears only the permissions half', afterRevokeOnly?.agentBefore === 'explore' && afterRevokeOnly?.before === undefined, afterRevokeOnly)
check('session agent unchanged by grant revoke', sessions['ses_check_both'].agent === 'build')
const rvPromote = await call('collab_promote', { target: 'ses_check_both', revert: true, confirm: true })
check('revert restores explore and deletes the now-empty ledger', sessions['ses_check_both'].agent === 'explore' && ledger('ses_check_both') === null, rvPromote.split('\n').slice(0, 3).join(' / '))
// revert on a session with no record
mkSession('ses_check_norec', 'explore', WS, undefined)
const noRecord2 = await call('collab_promote', { target: 'ses_check_norec', revert: true, confirm: true })
check('R7 revert without a record reports "nothing to restore"', /无可还原/.test(noRecord2), noRecord2.split('\n')[0])

// protected refusals (built-in hard list + descendant)
const PROTECTED = 'ses_e1eb91cebffeTv1467ubJLKebk'
mkSession(PROTECTED, 'explore', WS, [])
mkSession('ses_check_child', 'explore', WS, [])
sessions['ses_check_child'].parentID = PROTECTED
const failSwitchCount = switches.length
const pg = await call('collab_grant', { target: PROTECTED, confirm: true }).then(x => x, e => `THROW: ${e.message}`)
const pc = await call('collab_grant', { target: 'ses_check_child', confirm: true }).then(x => x, e => `THROW: ${e.message}`)
check('R2 protected target refused for grant', /THROW: 拒绝授权/.test(pg) && permissionsOf(PROTECTED).length === 0 && ledger(PROTECTED) === null, pg.split('\n')[0])
check('R2 protected descendant refused for grant', /THROW: 拒绝授权/.test(pc), pc.split('\n')[0])
const pp = await call('collab_promote', { target: PROTECTED, confirm: true }).then(x => x, e => `THROW: ${e.message}`)
const ppc = await call('collab_promote', { target: 'ses_check_child', confirm: true }).then(x => x, e => `THROW: ${e.message}`)
check('R7 protected target/descendant refused for promote', /THROW: 拒绝切换 agent/.test(pp) && /THROW: 拒绝切换 agent/.test(ppc) && switches.length === failSwitchCount, `${pp.split('\n')[0]} | ${ppc.split('\n')[0]}`)

// R7 switch failure is readable and non-fatal
mkSession('ses_check_switchfail', 'explore', WS, undefined)
failSwitch.add('ses_check_switchfail')
const sf = await call('collab_promote', { target: 'ses_check_switchfail', confirm: true })
check('R7 switch 403 reported readably, agent unchanged, no ledger', /未切换 agent/.test(sf) && /HTTP 403/.test(sf) && sessions['ses_check_switchfail'].agent === 'explore' && ledger('ses_check_switchfail') === null, sf.split('\n')[0])

// whitelist unit level (own call, not the harness assertions)
const wl = []
for (const action of ['edit', 'write', 'shell', 'collab_broadcast']) {
  try { internals.assertCollabOnly([{ action, resource: '*', effect: 'allow' }]); wl.push(`${action}:ACCEPTED`) } catch { wl.push(`${action}:refused`) }
}
try { internals.assertCollabOnly([{ action: 'collab_list', resource: '*', effect: 'deny' }]); wl.push('deny:ACCEPTED') } catch { wl.push('deny:refused') }
check('whitelist refuses edit/write/shell/collab_broadcast/deny', wl.every(x => x.endsWith('refused')), wl.join(' '))

console.log(`\n=== ${results.filter(r => r.ok).length}/${results.length} independent checks passed (dir ${dir})`)
const failures = results.filter(r => !r.ok)
if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log(`- ${f.label} :: ${f.detail}`) }
process.exit(failures.length ? 1 : 0)
