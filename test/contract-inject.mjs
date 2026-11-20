/**
 * 0.9.1 (`11-20-collab-contract`): session contract + five-section injection.
 *
 *   pnpm test                 # builds dist/ first; this file is part of the chain
 *   node test/contract-inject.mjs
 *
 * Everything runs through the built `dist/index.js` with temp paths — no host,
 * no `~/.config/opencode/collab-*`. Cases (design §8):
 *
 *   1. tool surface: 23 → 26, the three new tools registered exactly once
 *   2. **replay**: two consecutive requests both carry `[mission]` + `[todo]`
 *      (a once-only `injected[]` implementation fails this case — the mutation
 *      target of the task)
 *   3. progress: no evidence → refused; a real commit → lit, `lastAdvancedAt`
 *      moves, `noAdvanceTurns` resets; the same evidence twice does not re-advance
 *   4. confirm then set → refused; `reconfirm` without `by` → refused; with both
 *      → accepted (inference never overwrites a human confirmation)
 *   5. no task + unconfirmed → `[mission] … [未确认]`
 *   6. 10 open todos → block ≤ 12 lines, exactly 3 rows + `还有 7 条`
 *   7. suspend without `wakeWhen` → refused; close without evidence → refused;
 *      close with a verifiable file evidence → accepted
 *   8. truncation order: mission+todo+drift+scope+progress → `[progress]` dropped
 *   9. `[未收尾]`: a `doing` todo untouched by the previous request is marked
 *  10. mission anchor: unique in_progress task → task; session pointer wins;
 *      two in_progress tasks → ambiguous (never guessed)
 *  11. `get` suggests the first human instruction when nothing is set
 *
 * Exits 1 if any check fails.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
const root = mkdtempSync(join(base, 'collab-contract-'));
const workspace = join(root, 'workspace');
const contractDir = join(root, 'contract');
mkdirSync(join(workspace, '.trellis', 'tasks'), { recursive: true });
mkdirSync(join(workspace, '.trellis', '.runtime', 'sessions'), { recursive: true });

// Every global path is read once at import: pin them *before* importing.
process.env.COLLAB_CONTRACT_DIR = contractDir;
process.env.COLLAB_MESSAGES_FILE = join(root, 'collab-messages.jsonl');
process.env.COLLAB_DB_FILE = join(root, 'collab.db');
process.env.COLLAB_BROADCAST_DIR = join(root, 'broadcast');
process.env.COLLAB_THREAD_INDEX_FILE = join(root, 'collab-threads.json');
process.env.COLLAB_CONFIG = join(root, 'collab.json');
process.env.COLLAB_LOCK_DIR = join(root, 'locks');
process.env.COLLAB_OWNER_QUEUE_DIR = join(root, 'owner-queue');
process.env.COLLAB_FREEZE_FILE = join(root, 'freeze.json');
process.env.COLLAB_AUDIT_FILE = join(root, 'collab-audit.jsonl');
process.env.COLLAB_GRANT_DIR = join(root, 'grants');
for (const dir of ['broadcast', 'locks', 'owner-queue', 'grants']) mkdirSync(join(root, dir), { recursive: true });

const dist = resolve(import.meta.dirname, '../dist/index.js');
const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'));
const plugin = (await import(pathToFileURL(dist).href)).default;
const internals = (await import(pathToFileURL(dist).href)).__internals;

const checks = [];
const expect = (title, ok, detail = '') => {
  checks.push({ title, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`);
};
const section = title => console.log(`\n--- ${title}`);

// ---------------------------------------------------------------- fake host
const store = new Map();
const tools = [];
const hooks = {};
const contexts = new Map();
const sessions = new Map();
const ctx = {
  location: { directory: workspace },
  options: {},
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
      return structuredClone(sessions.get(sessionID) ?? { id: sessionID, agent: 'build', title: 'test' });
    },
    async list() {
      return { data: [] };
    },
    async context({ sessionID }) {
      return structuredClone(contexts.get(sessionID) ?? []);
    },
    async create(input = {}) {
      const info = { id: `ses_spawn_${sessions.size + 1}`, agent: input.agent ?? 'build', title: input.title ?? '' };
      sessions.set(info.id, info);
      return structuredClone(info);
    },
    async remove() {},
    async update() {},
    async switchAgent() {},
    async prompt() {
      return { id: 'msg_1', delivery: 'queue' };
    },
    async wait() {}
  },
  event: {
    async *subscribe() {
      // no events in this suite
    }
  }
};

const originalError = console.error;
console.error = () => {};
const cleanup = await plugin.setup(ctx);
console.error = originalError;

const tool = name => tools.find(definition => definition.name === name);
const call = async (name, input, sid = 'ses_main') => (await tool(name).execute(input, { sessionID: sid })).content;
const callError = async (name, input, sid = 'ses_main') => {
  try {
    await call(name, input, sid);
    return undefined;
  } catch (error) {
    return String(error?.message ?? error);
  }
};
const ask = async (sid, messages = []) => {
  const event = { sessionID: sid, agent: 'build', messages, system: [] };
  await hooks.context(event);
  return event.system.map(block => String(block?.text ?? '')).join('\n\n');
};
const contractOf = sid => JSON.parse(readFileSync(internals.contractFile(sid), 'utf8'));
const blockLines = text => text.split('\n').filter(line => line.trim().length > 0);

// ================================================================ 1) surface
section('1) tool surface + version');
expect('PLUGIN_VERSION / package.json agree (0.9.1)', internals.PLUGIN_VERSION === pkg.version && pkg.version === '0.9.1', `${internals.PLUGIN_VERSION} vs ${pkg.version}`);
expect('26 tools are registered', tools.length === 26, `${tools.length} tools`);
for (const name of ['collab_mission', 'collab_progress', 'collab_todo']) {
  const registrations = tools.filter(definition => definition.name === name).length;
  expect(`${name} is registered exactly once`, registrations === 1, `${registrations} registration(s)`);
}
expect(
  'collab_mission schema: get|set|confirm + oneLine/outOfScope/reconfirm',
  JSON.stringify(tool('collab_mission').input.properties.action.enum) === JSON.stringify(['get', 'set', 'confirm']) &&
    Boolean(tool('collab_mission').input.properties.oneLine) &&
    Boolean(tool('collab_mission').input.properties.outOfScope) &&
    Boolean(tool('collab_mission').input.properties.reconfirm)
);
expect(
  'collab_progress schema: list|add|light + evidence/confirm, description says evidence-gated',
  JSON.stringify(tool('collab_progress').input.properties.action.enum) === JSON.stringify(['list', 'add', 'light']) &&
    /evidence/i.test(String(tool('collab_progress').description)) &&
    /lastAdvancedAt/.test(String(tool('collab_progress').description))
);
expect(
  'collab_todo schema: add|close|defer|suspend|list + wakeWhen',
  ['add', 'close', 'defer', 'suspend', 'list'].every(action =>
    tool('collab_todo').input.properties.action.enum.includes(action)
  ) && Boolean(tool('collab_todo').input.properties.wakeWhen)
);
expect(
  'CONTRACT_DIR is honoured (no real ~/.config path)',
  internals.contractFile('ses_main') === join(contractDir, 'ses_main.json'),
  internals.contractFile('ses_main')
);

// ============================================= 2) replay: two requests, both filled
section('2) replay: [mission] + [todo] survive a second request');
await call('collab_mission', {
  action: 'confirm',
  oneLine: '排钟 B4 接线',
  taskPath: '.trellis/tasks/11-20-collab-contract',
  inScope: ['排钟'],
  outOfScope: ['ws集群实施'],
  by: 'human'
});
await call('collab_todo', { action: 'add', subject: 'decide dev/prod 键空间', confirm: true });
const firstText = await ask('ses_main');
const secondText = await ask('ses_main');
expect('request 1 carries [mission]', firstText.includes('[mission] 排钟 B4 接线'));
expect('request 1 carries [todo]', firstText.includes('[todo] 1 open') && firstText.includes('decide dev/prod 键空间'));
expect('request 2 still carries [mission]', secondText.includes('[mission] 排钟 B4 接线'));
expect('request 2 still carries [todo] + the subject', secondText.includes('[todo] 1 open') && secondText.includes('decide dev/prod 键空间'));
const rawContract = readFileSync(internals.contractFile('ses_main'), 'utf8');
expect('the contract file has no injected[] (recomputed every request)', !rawContract.includes('injected'));
expect('turn.count advanced twice', contractOf('ses_main').turn.count === 2, String(contractOf('ses_main').turn.count));

// ===================================================== 3) evidence-gated progress
section('3) progress only moves on verified evidence');
await call('collab_progress', { action: 'add', milestone: 'M1', title: '双写验证', confirm: true });
const noEvidence = await callError('collab_progress', { action: 'light', milestone: 'M1', confirm: true });
expect('light without evidence is refused', /无 evidence 不点亮/.test(noEvidence ?? ''), noEvidence);
const bogus = await callError('collab_progress', { action: 'light', milestone: 'M1', evidence: 'commit:deadbeef', confirm: true });
expect('unverifiable commit is refused (readable reason)', /找不到 commit deadbeef/.test(bogus ?? ''), bogus);
const before = contractOf('ses_main').plan.lastAdvancedAt;
const git = args =>
  spawnSync('git', args, { cwd: workspace, encoding: 'utf8', timeout: 10_000 });
git(['init', '-q']);
git(['config', 'user.email', 'harness@example.test']);
git(['config', 'user.name', 'harness']);
writeFileSync(join(workspace, 'a.txt'), 'a\n');
git(['add', 'a.txt']);
git(['commit', '-qm', 'init']);
const sha = git(['rev-parse', 'HEAD']).stdout.trim();
const lit = await call('collab_progress', { action: 'light', milestone: 'M1', evidence: `commit:${sha}`, confirm: true });
const afterLight = contractOf('ses_main');
expect('a real commit lights the milestone', /已点亮 M1/.test(lit) && afterLight.plan.milestones[0].done === true, lit.split('\n')[0]);
expect('lastAdvancedAt moved', afterLight.plan.lastAdvancedAt > before, `${before} → ${afterLight.plan.lastAdvancedAt}`);
expect('noAdvanceTurns reset to 0', afterLight.turn.noAdvanceTurns === 0, String(afterLight.turn.noAdvanceTurns));
const again = await call('collab_progress', { action: 'light', milestone: 'M1', evidence: `commit:${sha}`, confirm: true });
expect(
  'the same evidence twice does not re-advance lastAdvancedAt',
  /未重复推进/.test(again) && contractOf('ses_main').plan.lastAdvancedAt === afterLight.plan.lastAdvancedAt,
  again.split('\n')[0]
);
const progressText = await ask('ses_main');
expect('[progress] shows the completed milestone', progressText.includes('[progress] 1/1 全部里程碑已完成'), progressText.split('\n').find(line => line.startsWith('[progress]')));

// ================================================ 4) confirmation is sticky (D7)
section('4) a human confirmation cannot be overwritten by set');
const setRefused = await callError('collab_mission', { action: 'set', oneLine: '偷偷换主线' });
expect('set after confirm is refused', /已由 human 确认/.test(setRefused ?? ''), setRefused);
const noBy = await callError('collab_mission', { action: 'set', reconfirm: true, oneLine: '新主线' });
expect('reconfirm without by is refused', /reconfirm 必须给 by/.test(noBy ?? ''), noBy);
const reconfirmed = await call('collab_mission', { action: 'set', reconfirm: true, by: 'human2', oneLine: '新主线' });
const afterReconfirm = contractOf('ses_main').mission;
expect(
  'reconfirm with by writes and re-stamps the confirmation',
  afterReconfirm.oneLine === '新主线' && afterReconfirm.confirmedBy === 'human2',
  `${afterReconfirm.oneLine} / ${afterReconfirm.confirmedBy}`
);
expect('reconfirm result says so', /按 reconfirm 覆盖了 human/.test(reconfirmed), reconfirmed.split('\n')[0]);

// ============================================= 5) no task + unconfirmed → marker
section('5) no task and unconfirmed → [mission] … [未确认]');
await call('collab_todo', { action: 'add', subject: '无任务会话的一件事', confirm: true }, 'ses_notask');
const notaskText = await ask('ses_notask');
expect('[mission] is present with [未确认]', /\[mission\] 未设置.*\[未确认\]/.test(notaskText), notaskText.split('\n').slice(0, 3).join(' | '));
expect('[todo] is present in the same block', notaskText.includes('[todo] 1 open'));

// ================================================== 6) 10 todos → top 3 + 还有 7 条
section('6) 10 open todos → ≤12 lines, 3 rows + 还有 7 条');
for (let index = 1; index <= 10; index += 1) {
  await call('collab_todo', { action: 'add', subject: `批量待办 ${index}`, confirm: true }, 'ses_ten');
}
const tenText = await ask('ses_ten');
const tenLines = blockLines(tenText);
const rows = tenText.split('\n').filter(line => /^ {2}T\d+ /.test(line));
expect('block line count ≤ 12', tenLines.length <= 12, `${tenLines.length} lines`);
expect('exactly 3 todo rows are listed', rows.length === 3, rows.join(' | '));
expect('header says 10 open and 还有 7 条', tenText.includes('[todo] 10 open') && tenText.includes('还有 7 条'));
expect('mission lines + todo lines coexist under the cap', tenText.includes('[mission]') && tenText.includes('[todo]'));

// ============================================ 7) suspend / close input contracts
section('7) suspend needs wakeWhen; close needs evidence');
await call('collab_todo', { action: 'add', subject: '需要挂起的事', confirm: true }, 'ses_suspend');
const suspendNoWake = await callError('collab_todo', { action: 'suspend', id: 'T1', confirm: true }, 'ses_suspend');
expect('suspend without wakeWhen is refused', /suspend 必填 wakeWhen/.test(suspendNoWake ?? ''), suspendNoWake);
const suspended = await call(
  'collab_todo',
  { action: 'suspend', id: 'T1', wakeWhen: '等 owner 回 D3', confirm: true },
  'ses_suspend'
);
expect(
  'suspend with wakeWhen persists status + wakeWhen',
  /已挂起 T1/.test(suspended) && contractOf('ses_suspend').todos[0].status === 'suspended' && contractOf('ses_suspend').todos[0].wakeWhen === '等 owner 回 D3',
  suspended.split('\n')[0]
);
const closeNoEvidence = await callError('collab_todo', { action: 'close', id: 'T1', confirm: true }, 'ses_suspend');
expect('close without evidence is refused', /close 必填 evidence/.test(closeNoEvidence ?? ''), closeNoEvidence);
const closeBadFile = await callError(
  'collab_todo',
  { action: 'close', id: 'T1', evidence: 'file:no-such-file.ts:3', confirm: true },
  'ses_suspend'
);
expect('close with a missing file evidence is refused', /文件不存在/.test(closeBadFile ?? ''), closeBadFile);
const closeOk = await call(
  'collab_todo',
  { action: 'close', id: 'T1', evidence: `file:a.txt:1`, confirm: true },
  'ses_suspend'
);
expect(
  'close with verified evidence closes the todo',
  /已关闭 T1/.test(closeOk) && contractOf('ses_suspend').todos[0].status === 'closed',
  closeOk.split('\n')[0]
);

// ================================================= 8) truncation order (pure)
section('8) truncation: mission+todo+drift+scope+progress → progress dropped');
const synthetic = internals.emptyContract('ses_trunc');
synthetic.mission = {
  ...synthetic.mission,
  oneLine: '主线：排钟 B4',
  inScope: ['排钟'],
  outOfScope: ['ws集群实施', '集群部署|集群'],
  handoffTo: { ws集群实施: 'ses_owner' }
};
synthetic.todos = Array.from({ length: 10 }, (_, index) => ({
  id: `T${index + 1}`,
  kind: 'mainline',
  subject: `合成待办 ${index + 1}`,
  status: 'open',
  blockingOn: 'me',
  since: 1000,
  updatedAt: 1000
}));
synthetic.plan = {
  milestones: [
    { id: 'M1', title: '一', done: true, at: 1000 },
    { id: 'M2', title: '二', done: false },
    { id: 'M3', title: '三', done: false }
  ],
  lastAdvancedAt: 1000
};
const truncated = internals.renderInjection({
  contract: synthetic,
  mission: synthetic.mission,
  drift: ['[drift] 连续 6 轮无主线动作（11.2h）→ 三选一：继续 / 记阻塞 / 建 next-up', '  [未处置] 下一轮仍会提醒'],
  messageText: '这轮做 ws集群实施 和 集群部署',
  now: 7_200_000
});
expect('progress is the section that gets dropped', truncated.dropped.includes('progress'), truncated.dropped.join(','));
expect('the block never exceeds 12 lines', truncated.lines.length <= 12, `${truncated.lines.length} lines`);
expect(
  'mission / todo / drift / scope are all present, progress is not',
  ['mission', 'todo', 'drift', 'scope'].every(name => truncated.sections.includes(name)) &&
    !truncated.lines.join('\n').includes('[progress]'),
  truncated.sections.join(',')
);
const noOverflow = internals.renderInjection({
  contract: synthetic,
  mission: synthetic.mission,
  messageText: '这轮做 ws集群实施',
  now: 7_200_000
});
expect(
  'without drift the progress section fits under the cap',
  noOverflow.sections.includes('progress') && noOverflow.lines.length <= 12,
  `${noOverflow.sections.join(',')} / ${noOverflow.lines.length} lines`
);

// ================================================== 9) [未收尾] back-reference
section('9) [未收尾] marks a doing todo untouched by the previous request');
await call('collab_todo', { action: 'add', subject: '正在做的事', status: 'doing', confirm: true }, 'ses_doing');
const doingIdle = await ask('ses_doing');
const doingNext = await ask('ses_doing');
expect('the first request does not mark it yet', !doingIdle.includes('[未收尾]'));
expect('the next request marks it [未收尾]', doingNext.includes('[未收尾]') && doingNext.includes('T1'), doingNext.split('\n').find(line => line.includes('T1')));

// ================================================= 10) mission anchor resolution
section('10) mission anchor: task → pointer wins → ambiguous is not guessed');
const writeTask = (rel, task) => {
  mkdirSync(join(workspace, '.trellis', 'tasks', rel), { recursive: true });
  writeFileSync(join(workspace, '.trellis', 'tasks', rel, 'task.json'), JSON.stringify(task));
};
writeTask('11-unique', { id: '11-unique', title: '唯一进行中的任务', status: 'in_progress' });
const taskAnchor = internals.resolveMissionAnchor(workspace, 'ses_anchor_none');
expect(
  'a single in_progress task is adopted',
  taskAnchor.source === 'task' && taskAnchor.taskPath === '.trellis/tasks/11-unique' && taskAnchor.oneLine === '唯一进行中的任务',
  JSON.stringify(taskAnchor)
);
writeTask('11-pointer', { id: '11-pointer', title: '指针指向的任务', status: 'todo' });
writeFileSync(
  join(workspace, '.trellis', '.runtime', 'sessions', 'opencode_ses_pointer.json'),
  JSON.stringify({ platform: 'opencode', current_task: '.trellis/tasks/11-pointer' })
);
const pointerAnchor = internals.resolveMissionAnchor(workspace, 'ses_pointer');
expect(
  'the session pointer wins over the task scan',
  pointerAnchor.source === 'pointer' && pointerAnchor.taskPath === '.trellis/tasks/11-pointer' && pointerAnchor.oneLine === '指针指向的任务',
  JSON.stringify(pointerAnchor)
);
writeTask('11-second', { id: '11-second', title: '第二个进行中任务', status: 'in_progress' });
const ambiguous = internals.resolveMissionAnchor(workspace, 'ses_anchor_none');
expect(
  'two in_progress tasks → ambiguous (never guessed)',
  ambiguous.source === 'ambiguous' && (ambiguous.candidates ?? []).length === 2,
  JSON.stringify(ambiguous)
);
const stalePointer = internals.resolveMissionAnchor(workspace, 'ses_stale');
expect('a session with no pointer and 2 in_progress tasks is ambiguous', stalePointer.source === 'ambiguous');

// ===================================== 11) first human instruction suggestion
section('11) mission get suggests the first human instruction');
contexts.set('ses_first', [
  { role: 'user', id: 'm1', parts: [{ type: 'text', text: '帮我把排钟 B4 接线做完' }] }
]);
const firstGet = await call('collab_mission', { action: 'get' }, 'ses_first');
expect(
  'get shows the first human instruction as the suggestion',
  firstGet.includes('帮我把排钟 B4 接线做完') && firstGet.includes('[未确认]'),
  firstGet.split('\n').find(line => line.includes('建议主线')) ?? firstGet.slice(0, 160)
);
expect('get did not create a contract file', !existsSync(internals.contractFile('ses_first')));

// ------------------------------------------------------------------- result
await Promise.resolve(cleanup?.()).catch(() => {});
const failed = checks.filter(check => !check.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log('failed:');
  for (const check of failed) console.log(`  ✗ ${check.title}`);
  process.exit(1);
}
