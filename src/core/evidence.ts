/**
 * 0.9.1 (`11-20-collab-contract`, D20/D21): **evidence that can actually be
 * checked**. A milestone may only be lit by evidence the machine can verify —
 * "我跑过了" is not evidence, and a progress marker that moves on a claim is
 * exactly how a mainline drifts for 10.8 h without anybody noticing.
 *
 * Four forms (design §5):
 *
 *   commit:<sha>          the commit exists **and** is an ancestor of HEAD
 *   file:<path>:<line>    the file exists and has at least `<line>` lines
 *   test:<path>           the test report / output file exists
 *   decision:<id>         a decision with that id is recorded (answered)
 *
 * Every failure returns a readable reason (`ok:false`); callers throw it as a
 * `ValidationError` so a bad evidence string is never reported as a plugin bug.
 * `decision:` reads the hand-off `decisions[]` (`collab_decisions`, 0.7.0) — the
 * dedicated decision ledger lands in 0.9.5, and this stays honest about it in
 * the refusal text instead of accepting an unverifiable claim.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { allBroadcasts } from './claim.ts';
import { errText } from '../log.ts';

export interface EvidenceResult {
  ok: boolean;
  /** The recognised form, when the prefix matched one. */
  kind?: 'commit' | 'file' | 'test' | 'decision';
  /** What was actually verified (commit short sha / path / decision id). */
  detail?: string;
  /** Human-readable verdict — success and failure both carry one. */
  reason: string;
}

export const EVIDENCE_FORMS = ['commit:', 'file:', 'test:', 'decision:'] as const;

const FORM_HINT = 'evidence 需四选一：commit:<sha> / file:<path>:<line> / test:<path> / decision:<id>';

function resolvePath(directory: string | undefined, path: string): string | undefined {
  const value = String(path ?? '').trim();
  if (!value) return undefined;
  if (isAbsolute(value)) return value;
  if (!directory) return undefined;
  return join(directory, value);
}

function git(directory: string, args: string[]): { status: number | null; out: string; err: string } {
  const result = spawnSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  });
  return {
    status: typeof result.status === 'number' ? result.status : null,
    out: String(result.stdout ?? '').trim(),
    err: result.error ? errText(result.error) : String(result.stderr ?? '').trim()
  };
}

function checkCommit(raw: string, directory: string | undefined): EvidenceResult {
  const sha = raw.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    return { ok: false, kind: 'commit', reason: `commit evidence 的 sha 不合法："${sha}"（需 7–40 位十六进制）` };
  }
  if (!directory) {
    return { ok: false, kind: 'commit', reason: 'commit evidence 需要工作区目录（ctx.location.directory），当前没有' };
  }
  const exists = git(directory, ['cat-file', '-e', `${sha}^{commit}`]);
  if (exists.status !== 0) {
    return {
      ok: false,
      kind: 'commit',
      reason: `git 找不到 commit ${sha}（${directory}）${exists.err ? `：${exists.err}` : ''}`
    };
  }
  const ancestor = git(directory, ['merge-base', '--is-ancestor', sha, 'HEAD']);
  if (ancestor.status === 1) {
    return { ok: false, kind: 'commit', reason: `commit ${sha} 不是 HEAD 的祖先（未合入当前分支，不能作为已完成的证据）` };
  }
  if (ancestor.status !== 0) {
    return {
      ok: false,
      kind: 'commit',
      reason: `无法校验 commit ${sha} 与 HEAD 的关系${ancestor.err ? `：${ancestor.err}` : ''}`
    };
  }
  return { ok: true, kind: 'commit', detail: sha.slice(0, 12), reason: `commit ${sha.slice(0, 12)} 存在且已合入 HEAD` };
}

/** `<path>:<line>` — the line suffix is optional (`file:src/x.ts` = existence). */
function splitFileEvidence(raw: string): { path: string; line?: number } {
  const value = raw.trim();
  const match = /^(.*):(\d+)$/.exec(value);
  if (match) return { path: match[1], line: Number(match[2]) };
  return { path: value };
}

function checkFile(raw: string, directory: string | undefined): EvidenceResult {
  const { path, line } = splitFileEvidence(raw);
  if (!path.trim()) return { ok: false, kind: 'file', reason: 'file evidence 缺路径（file:<path>:<line>）' };
  const absolute = resolvePath(directory, path);
  if (!absolute || !existsSync(absolute)) {
    return { ok: false, kind: 'file', reason: `文件不存在：${path}${directory ? `（相对 ${directory}）` : ''}` };
  }
  if (line !== undefined) {
    try {
      if (statSync(absolute).isDirectory()) {
        return { ok: false, kind: 'file', reason: `file evidence 指向目录而不是文件：${path}` };
      }
      const count = readFileSync(absolute, 'utf8').split('\n').length;
      if (count < line) {
        return { ok: false, kind: 'file', reason: `文件 ${path} 只有 ${count} 行，少于 evidence 要求的第 ${line} 行` };
      }
      return { ok: true, kind: 'file', detail: `${path}:${line}`, reason: `文件 ${path} 有 ${count} 行（≥ ${line}）` };
    } catch (error) {
      return { ok: false, kind: 'file', reason: `读取文件失败：${path}（${errText(error)}）` };
    }
  }
  return { ok: true, kind: 'file', detail: path, reason: `文件存在：${path}` };
}

function checkTest(raw: string, directory: string | undefined): EvidenceResult {
  const path = raw.trim();
  if (!path) return { ok: false, kind: 'test', reason: 'test evidence 缺路径（test:<path>）' };
  const absolute = resolvePath(directory, path);
  if (!absolute || !existsSync(absolute)) {
    return { ok: false, kind: 'test', reason: `测试报告/输出文件不存在：${path}${directory ? `（相对 ${directory}）` : ''}` };
  }
  return { ok: true, kind: 'test', detail: path, reason: `测试报告存在：${path}` };
}

function checkDecision(raw: string): EvidenceResult {
  const id = raw.trim();
  if (!id) return { ok: false, kind: 'decision', reason: 'decision evidence 缺 id（decision:<D#>）' };
  const wanted = id.toLowerCase();
  const records = allBroadcasts();
  for (const record of records) {
    for (const decision of record.decisions ?? []) {
      if (String(decision?.id ?? '').trim().toLowerCase() === wanted) {
        return {
          ok: true,
          kind: 'decision',
          detail: id,
          reason: `决策 ${id} 已记录在交接 ${record.bid}（${decision.decision}）`
        };
      }
    }
  }
  return {
    ok: false,
    kind: 'decision',
    reason:
      `未找到已决策记录 ${id}：0.9.1 的 decision evidence 读取 hand-off 的 decisions[]（collab_decisions）；` +
      '独立决策账本在 0.9.5 落地前不会被当作证据。'
  };
}

/**
 * Verify one evidence string. Never throws: every failure is a readable
 * `{ ok:false, reason }` the tool turns into a validation error.
 */
export function checkEvidence(
  raw: unknown,
  options: { directory?: string; now?: number } = {}
): EvidenceResult {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, reason: `evidence 不能为空；${FORM_HINT}` };
  const lower = value.toLowerCase();
  if (lower.startsWith('commit:')) return checkCommit(value.slice('commit:'.length), options.directory);
  if (lower.startsWith('file:')) return checkFile(value.slice('file:'.length), options.directory);
  if (lower.startsWith('test:')) return checkTest(value.slice('test:'.length), options.directory);
  if (lower.startsWith('decision:')) return checkDecision(value.slice('decision:'.length));
  return { ok: false, reason: `无法识别的 evidence 形式："${value}"；${FORM_HINT}` };
}
