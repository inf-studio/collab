import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'probe6-'));
const file = join(dir, 'idx.json');
process.env.COLLAB_THREAD_INDEX_FILE = file;
const idx = await import('/data/project/collab/src/core/thread-index.ts');
idx.readThreadIndex(); idx.threadsFor('ses_x'); idx.threadEntry('t_x');
console.log('missing file created by reads?', existsSync(file), '| dir entries:', existsSync(dir));
