// Check-agent probe: thread-index robustness (design §2 / §6) — no host, no real ~/.config.
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'probe-idx-'));
const file = join(dir, 'collab-threads.json');
process.env.COLLAB_THREAD_INDEX_FILE = file;
// constants.ts reads the env at module load → import after.
const idx = await import('/data/project/collab/src/core/thread-index.ts');

const show = (label, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);

// 1. empty / missing file
show('missing file → {}', Object.keys(idx.readThreadIndex()).length === 0);

// 2. write path: entry recorded, participants sticky, kind sticky
const now = Date.now();
idx.recordThread({ threadID: 't_a_1', target: 'ses_peer', from: 'ses_me', kind: 'messages', text: '  hello\n world  ', now });
let e = idx.readThreadIndex()['t_a_1'];
show('recordThread writes normalized preview', e?.preview === 'hello world', JSON.stringify(e));
idx.recordThread({ threadID: 't_a_1', target: 'ses_me', from: 'ses_peer', kind: 'handoff', text: 'reply text', bid: 'b_deadbeefdeadbeef', now: now + 5 });
e = idx.readThreadIndex()['t_a_1'];
show(
  'participants sticky + kind/bid upgraded on reply direction',
  e?.target === 'ses_peer' && e?.from === 'ses_me' && e?.kind === 'handoff' && e?.bid === 'b_deadbeefdeadbeef' && e?.lastAt === now + 5,
  JSON.stringify(e)
);
show('threadsFor finds it from both sides', idx.threadsFor('ses_me', now + 10).length === 1 && idx.threadsFor('ses_peer', now + 10).length === 1);
show('threadEntry returns it', Boolean(idx.threadEntry('t_a_1', now + 10)));

// 3. read-only: reads never move the file
const before = `${statSync(file).size}:${statSync(file).mtimeMs}:${readFileSync(file, 'utf8')}`;
idx.threadsFor('ses_peer', now + 10);
idx.threadEntry('t_a_1', now + 10);
idx.readThreadIndex();
const after = `${statSync(file).size}:${statSync(file).mtimeMs}:${readFileSync(file, 'utf8')}`;
show('reads leave size:mtime:content unchanged', before === after);

// 4. 7-day retention on read (no deletion on read)
const old = now - 8 * 24 * 60 * 60 * 1000;
idx.recordThread({ threadID: 't_a_old', target: 'ses_peer', from: 'ses_me', kind: 'messages', text: 'stale', now: old });
const keepsFileBefore = readFileSync(file, 'utf8');
show('threadsFor filters >7d', !idx.threadsFor('ses_peer', now + 10).some(r => r.threadID === 't_a_old'), JSON.stringify(idx.threadsFor('ses_peer', now + 10).map(r => r.threadID)));
show('threadEntry filters >7d', idx.threadEntry('t_a_old', now + 10) === undefined);
show('the stale row is NOT deleted by a read (still in the file)', JSON.parse(readFileSync(file, 'utf8')).entries.t_a_old !== undefined && keepsFileBefore === readFileSync(file, 'utf8'));

// 5. cap 500 on write, oldest lastAt evicted
const bulk = { version: 1, entries: {} };
for (let i = 0; i < 500; i += 1) {
  bulk.entries[`t_bulk_${String(i).padStart(3, '0')}`] = { target: 'ses_bulk', kind: 'messages', from: 'ses_me', lastAt: now - (i + 1) * 1000, preview: `b${i}` };
}
writeFileSync(file, JSON.stringify(bulk));
idx.recordThread({ threadID: 't_bulk_new', target: 'ses_bulk', from: 'ses_me', kind: 'messages', text: 'newest', now });
let parsed = JSON.parse(readFileSync(file, 'utf8'));
show(
  'cap: 501 → 500, oldest (t_bulk_499) evicted, newest kept',
  Object.keys(parsed.entries).length === 500 && !parsed.entries.t_bulk_499 && Boolean(parsed.entries.t_bulk_new) && Boolean(parsed.entries.t_bulk_000),
  `${Object.keys(parsed.entries).length} entries`
);

// 6. corrupt file → empty, no throw, log only
writeFileSync(file, '{ this is not json');
let threw = '';
let corrupt;
try {
  corrupt = idx.readThreadIndex();
  idx.recordThread({ threadID: 't_after_corrupt', target: 'ses_x', from: 'ses_me', kind: 'messages', text: 'x' });
} catch (error) {
  threw = String(error?.message ?? error);
}
show('corrupt JSON → empty + recovers on the next write', !threw && Object.keys(corrupt).length === 0 && Boolean(JSON.parse(readFileSync(file, 'utf8')).entries.t_after_corrupt));

// 7. unknown version → empty (and a write rewrites version 1)
writeFileSync(file, JSON.stringify({ version: 2, entries: { t_future: { target: 'ses_x', kind: 'messages', from: 'ses_me', lastAt: now, preview: 'future' } } }));
show('unknown version → {} (row not trusted)', Object.keys(idx.readThreadIndex()).length === 0);
idx.recordThread({ threadID: 't_v1', target: 'ses_x', from: 'ses_me', kind: 'messages', text: 'v1', now });
parsed = JSON.parse(readFileSync(file, 'utf8'));
show('a write after an unknown version restores version 1', parsed.version === 1 && Object.keys(parsed.entries).join(',') === 't_v1');

// 8. junk entries dropped (no target / no lastAt), array at the top → {}
writeFileSync(file, JSON.stringify({ version: 1, entries: { t_ok: { target: 'ses_x', kind: 'nope', from: 'ses_me', lastAt: now }, t_bad: { kind: 'messages', lastAt: now }, t_bad2: { target: 'ses_x' } } }));
const tolerant = idx.readThreadIndex();
show('junk entries dropped, unknown kind → messages', Object.keys(tolerant).join(',') === 't_ok' && tolerant.t_ok.kind === 'messages', JSON.stringify(tolerant));
writeFileSync(file, JSON.stringify([1, 2, 3]));
show('array-shaped file → {}', Object.keys(idx.readThreadIndex()).length === 0);

// 9. recordThread refuses incomplete input (no write)
const sizeBefore = statSync(file).size;
const refused = idx.recordThread({ threadID: '', target: 'ses_x', kind: 'messages' });
show('recordThread({threadID:""}) → undefined, no write', refused === undefined && statSync(file).size === sizeBefore);

// 10. override path is the one used
show('COLLAB_THREAD_INDEX_FILE is honoured', idx.threadIndexFile() === file, idx.threadIndexFile());

rmSync(dir, { recursive: true, force: true });
