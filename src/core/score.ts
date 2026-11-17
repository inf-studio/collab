import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BCAST_RECENT_MS, EXPECTED, SCORE_MESSAGE_LIMIT, SCORE_MESSAGE_WINDOW_MS } from '../constants.ts';
import type { ProposalSummary, RankedCandidate, SessionInfoLike, SessionMessageLike } from '../types.ts';
import { asObject, dedupe, hash16, truncate } from '../util.ts';

/**
 * `bid = hash(scope + workspace + issuePath + content hash + mtime)`, so the
 * same proposal broadcast twice is the same hand-off (idempotent) while an
 * edited proposal becomes a new one.
 */
export function broadcastID({
  scope,
  workspace,
  issuePath,
  contentHash,
  mtimeMs
}: {
  scope: string;
  workspace?: string;
  issuePath?: string;
  contentHash?: string;
  mtimeMs?: number;
}): string {
  return `b_${hash16([scope, workspace, issuePath || '', contentHash || '', String(mtimeMs || 0)].join('|'))}`;
}

export function normalizeExpected(value: unknown): string {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  return EXPECTED.includes(text) ? text : 'implement';
}

// -------------------------------------------------------- broadcast: content

const CODE_EXTENSIONS =
  '(?:tsx?|mts|cts|jsx?|mjs|cjs|vue|jsonc?|mdx?|ya?ml|toml|sql|css|scss|less|html?|go|py|rs|java|kt|sh)';
const PATH_TOKEN_RE = new RegExp(`[\\w@.$-]*(?:/[\\w@.$-]+)*\\.${CODE_EXTENSIONS}\\b`, 'gi');
const TASK_SLUG_RE = /\b\d{2}-\d{2}-[a-z0-9][a-z0-9-]{2,}\b/g;
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'not',
  'are',
  'was',
  'any',
  'all',
  // proposal-file noise: every proposal is a `fix-`/`bugs-`/`feat-` file, so
  // these words say nothing about which session should take it.
  'fix',
  'bugs',
  'bug',
  'feat',
  'chore',
  'issue',
  'issues',
  'docs',
  'task',
  '请',
  '的',
  '了',
  '在',
  '与',
  '和',
  '或',
  '要',
  '把',
  '被',
  '是'
]);

/** File paths mentioned in a text (proposal body, hand-off text, tool input). */
export function extractPaths(text: unknown): string[] {
  const found: string[] = [];
  const value = String(text ?? '');
  for (const match of value.matchAll(PATH_TOKEN_RE)) {
    let token = match[0];
    if (!token || token.length < 4) continue;
    token = token.replace(/^\.\//, '').replace(/^\/+/, '');
    if (token.startsWith('..')) continue;
    found.push(token);
  }
  return dedupe(found);
}

export function keywordsOf(...texts: unknown[]): string[] {
  const words: string[] = [];
  for (const text of texts) {
    for (const word of String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fa5]+/)) {
      const latin = /^[a-z0-9][a-z0-9._-]*$/.test(word);
      if (latin && word.length >= 3 && !STOP_WORDS.has(word)) words.push(word);
      else if (!latin && word.length >= 2 && !STOP_WORDS.has(word)) words.push(word);
    }
  }
  return dedupe(words).slice(0, 40);
}

export function taskSlugsOf(text: unknown): string[] {
  return dedupe(String(text ?? '').match(TASK_SLUG_RE) ?? []);
}

/** `packages/state/src/machine/worker/store.ts` → `worker`/`store`/`machine`… */
export function moduleWordsOf(files: string[]): string[] {
  const words: string[] = [];
  for (const file of files) {
    const parts = String(file).split('/');
    for (const part of parts.slice(0, -1)) {
      if (part.length >= 3 && !['packages', 'apps', 'src', 'dist', 'lib'].includes(part)) {
        words.push(part);
      }
    }
    const stem = parts.at(-1)?.replace(/\.[a-z0-9]+$/i, '') ?? '';
    if (stem.length >= 3) words.push(stem);
  }
  return dedupe(words.map(word => word.toLowerCase()));
}

/** Title of a proposal: first markdown heading, else the file stem. */
export function titleOf(content: unknown, file: string): string {
  const heading = /^\s{0,3}#{1,3}\s+(.+)$/m.exec(String(content ?? ''));
  const raw = heading ? heading[1] : basename(file).replace(/\.[a-z0-9]+$/i, '');
  return truncate(raw.replace(/[*`_]/g, ''), 120);
}

export function summarizeProposal(text: unknown, file: string): ProposalSummary {
  const content = String(text ?? '');
  const files = extractPaths(content);
  const title = titleOf(content, file);
  const slug = basename(file).replace(/\.[a-z0-9]+$/i, '');
  return {
    contentHash: hash16(content),
    title,
    slug,
    files,
    keywords: keywordsOf(title, slug, moduleWordsOf(files).join(' ')),
    taskSlugs: taskSlugsOf(content)
  };
}

/**
 * Broadcast input validation: absolute workspace, proposal under `docs/issues/`.
 *
 * Two layers, because a lexical check alone is not enough:
 *   1. `relative()` + containment on the resolved paths (blocks `..` traversal);
 *   2. `lstatSync` rejects a symlinked proposal and `realpathSync` re-checks the
 *      *real* target, so `docs/issues/x.md -> /etc/passwd` can never leak an
 *      out-of-repo file into the global broadcast record.
 */
export function resolveBroadcastTargets(
  workspaceInput: unknown,
  issuePathInput: unknown
): { workspace: string; issuePath: string; abs: string; mtimeMs: number } {
  const workspace = String(workspaceInput ?? '').trim();
  if (!workspace) throw new Error('workspace 不能为空：请给目标工作区的绝对路径');
  if (!isAbsolute(workspace)) throw new Error(`workspace 必须是绝对路径："${workspace}"`);
  let stat;
  try {
    stat = statSync(workspace);
  } catch {
    throw new Error(`workspace 不存在或不可读："${workspace}"`);
  }
  if (!stat.isDirectory()) throw new Error(`workspace 不是目录："${workspace}"`);
  let realWorkspace: string;
  try {
    realWorkspace = realpathSync(workspace);
  } catch {
    throw new Error(`workspace 无法解析真实路径："${workspace}"`);
  }

  const issueRaw = String(issuePathInput ?? '').trim();
  if (!issueRaw) {
    throw new Error('issuePath 不能为空：peer scope 必须指向目标仓 docs/issues/ 下的提案');
  }
  const issuePath = relative(workspace, resolve(workspace, issueRaw)).split(sep).join('/');
  const issuesRoot = join(realWorkspace, 'docs', 'issues') + sep;
  const abs = resolve(realWorkspace, issuePath);
  if (!abs.startsWith(issuesRoot)) {
    throw new Error(
      `拒绝广播：issuePath "${issueRaw}" 不在 ${workspace}/docs/issues/ 下` +
        `（peer scope 只允许目标仓 docs/issues/**，见跨仓写边界）。`
    );
  }
  let fileStat;
  try {
    fileStat = lstatSync(abs);
  } catch {
    throw new Error(`提案文件不存在："${issuePath}"（先写提案，再广播）`);
  }
  if (fileStat.isSymbolicLink()) {
    throw new Error(`拒绝广播：提案 ${issuePath} 是软链（不允许软链绕过 docs/issues/ 写边界）。`);
  }
  if (!fileStat.isFile()) throw new Error(`提案路径不是文件："${issuePath}"`);
  let realAbs: string;
  try {
    realAbs = realpathSync(abs);
  } catch {
    throw new Error(`提案文件不可读："${issuePath}"`);
  }
  if (!realAbs.startsWith(issuesRoot)) {
    throw new Error(`拒绝广播：提案 ${issuePath} 的真实路径 ${realAbs} 不在 ${workspace}/docs/issues/ 下。`);
  }
  if (!/\.mdx?$/i.test(issuePath)) throw new Error(`提案必须是 .md：${issuePath}`);
  return { workspace, issuePath, abs, mtimeMs: fileStat.mtimeMs };
}

// ---------------------------------------------------------- broadcast: score

export function sessionBusyMinutes(info: SessionInfoLike, now = Date.now()): number {
  const time = asObject(info?.time);
  if (!time.busy) return 0;
  if (time.idle && time.idle >= time.busy) return 0;
  return Math.max(0, (now - Number(time.busy)) / 60_000);
}

export function pathsMatch(a: unknown, b: unknown): boolean {
  const left = String(a).replace(/^\.\//, '');
  const right = String(b).replace(/^\.\//, '');
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

export function collectInputPaths(value: unknown, sink: string[]): void {
  if (typeof value === 'string') {
    for (const path of extractPaths(value)) sink.push(path);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectInputPaths(item, sink);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectInputPaths(item, sink);
  }
}

/**
 * Files a session actually touched, read only from its **tool call inputs**.
 * Message bodies are never persisted or sent anywhere: the scoring runs in
 * memory and only path strings leave this function.
 */
export function pathsFromMessages(messages: unknown, now = Date.now()): string[] {
  const cutoff = now - SCORE_MESSAGE_WINDOW_MS;
  const list = (Array.isArray(messages) ? messages : ([] as SessionMessageLike[]))
    .filter((message: SessionMessageLike) => {
      const stamp = Number(message?.time?.created ?? message?.time?.completed ?? 0);
      return !stamp || stamp >= cutoff;
    })
    .slice(-SCORE_MESSAGE_LIMIT);
  const found: string[] = [];
  for (const message of list as SessionMessageLike[]) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (typeof block === 'string' || block?.type !== 'tool') continue;
      collectInputPaths(block?.state?.input, found);
      collectInputPaths(block?.input, found);
    }
    for (const file of Array.isArray(message?.snapshot?.files) ? message.snapshot.files : []) {
      if (typeof file === 'string') found.push(file);
    }
  }
  return dedupe(found).slice(0, 400);
}

const AGENT_MATCH: Record<string, RegExp> = {
  implement: /build|implement|trellis-implement/,
  review: /explore|plan|build|review|check|trellis-check/
};

/**
 * Deterministic matching score, 0–100:
 *   45 影响文件交集 · 25 标题词 · 15 同一任务线 · 10 agent · 5 最近活跃
 *   −10 busy > 30min
 * Every contribution is written into `why` so a human can audit the ranking.
 */
export function scoreCandidate({
  info,
  paths,
  proposal,
  expected,
  now = Date.now()
}: {
  info: SessionInfoLike;
  paths?: string[];
  proposal: ProposalSummary;
  expected: string;
  now?: number;
}): RankedCandidate {
  const why: string[] = [];
  let score = 0;

  const files = Array.isArray(proposal.files) ? proposal.files : [];
  let hitFiles = 0;
  for (const file of files) {
    const hit = (paths ?? []).find(path => pathsMatch(path, file));
    if (!hit) continue;
    hitFiles += 1;
    if (why.filter(line => line.startsWith('file:')).length < 3) why.push(`file:${hit}`);
  }
  if (files.length && hitFiles) score += 45 * (hitFiles / files.length);

  const title = String(info?.title ?? '').toLowerCase();
  const words = Array.isArray(proposal.keywords) ? proposal.keywords : [];
  const hitWords = words.filter(word => title.includes(word));
  if (words.length && hitWords.length) {
    score += 25 * (hitWords.length / words.length);
    why.push(...hitWords.slice(0, 3).map(word => `title:${word}`));
  }

  const taskSlugs = Array.isArray(proposal.taskSlugs) ? proposal.taskSlugs : [];
  const slugHit =
    taskSlugs.find(slug => title.includes(slug)) ??
    (title.includes(String(proposal.slug ?? '').toLowerCase()) ? proposal.slug : undefined);
  if (slugHit) {
    score += 15;
    why.push(`task:${slugHit}`);
  }

  const agent = String(info?.agent ?? '');
  if (AGENT_MATCH[expected]?.test(agent)) {
    score += 10;
    why.push(`agent:${agent}`);
  }

  const updated = Number(info?.time?.updated ?? info?.time?.created ?? 0);
  const age = updated ? now - updated : Infinity;
  if (age <= BCAST_RECENT_MS) {
    score += 5 * (1 - age / BCAST_RECENT_MS);
    why.push(`recent:${Math.max(0, Math.round(age / 60_000))}m`);
  }

  const busyMinutes = sessionBusyMinutes(info, now);
  if (busyMinutes > 30) {
    score -= 10;
    why.push(`busy:-10(${Math.round(busyMinutes)}m)`);
  }

  return {
    sid: String(info?.id ?? ''),
    score: Math.max(0, Math.min(100, Math.round(score))),
    why,
    busyMinutes
  };
}
