// Edge probe: promote a session that is ALREADY build (no prior record).
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'check-grant-edge-'))
const entry = join(dir, 'collab.mjs')
copyFileSync('/data/project/muke-pos-app/.opencode/plugins/collab.js', entry)
process.env.COLLAB_GRANT_DIR = join(dir, 'grants')
process.env.COLLAB_BROADCAST_DIR = join(dir, 'broadcast')
process.env.COLLAB_CONFIG = join(dir, 'none.json')

const sessions = { ses_edge: { id: 'ses_edge', agent: 'build', title: 'edge', location: { directory: dir }, time: { created: 1, updated: 1 } } }
const patches = []
const switches = []
const tools = []
const store = new Map()
const ctx = {
  location: { directory: dir }, options: {}, app: {},
  storage: { async get(k) { return store.get(k) }, async set(k, v) { store.set(k, v) }, async remove(k) { store.delete(k) }, async scan() { return { entries: [] } } },
  tool: { async transform(cb) { cb({ add: d => tools.push(d) }); return { dispose: async () => {} } } },
  session: {
    async hook() { return { dispose: async () => {} } },
    async get({ sessionID }) { if (!sessions[sessionID]) throw new Error('not found'); return structuredClone(sessions[sessionID]) },
    async list() { return { data: [] } }, async context() { return [] },
    async update(i) { if (i.permissions) { sessions[i.sessionID].permissions = structuredClone(i.permissions); patches.push(1) } },
    async switchAgent(i) { sessions[i.sessionID].agent = i.agent; switches.push(i.agent) },
    async prompt() { return {} }, async wait() {}, async create() {}, async remove() {},
  },
  event: { async *subscribe() {} },
}
console.error = () => {}
const plugin = (await import(`file://${entry}`)).default
await plugin.setup(ctx)
const out = await tools.find(t => t.name === 'collab_promote').execute({ target: 'ses_edge', confirm: true }, { sessionID: 'ses_req' })
console.log('--- promote on already-build session (no prior record)')
console.log(out.content)
console.log('switches=', switches.length, ' ledgerExists=', existsSync(join(dir, 'grants', 'ses_edge.json')))
const rv = await tools.find(t => t.name === 'collab_promote').execute({ target: 'ses_edge', revert: true, confirm: true }, { sessionID: 'ses_req' })
console.log('--- revert right after that')
console.log(rv.content.split('\n')[0])
