/**
 * 0.9.4 (`11-20-collab-facts`, R4/D2): the **three-state** freshness verdict.
 *
 * Every message may carry a `basedOn` marker (0.9.0's envelope already has the
 * field): the repo commits, the `.env` hashes and the facts ledger epoch the
 * sender was looking at. Comparing it with the receiver's own state answers one
 * question — *may I answer this with facts at all, or only with the delta?*
 *
 *   fresh     the baseline is the same (or we cannot know it)
 *   stale     one side is behind: reply with the increments only, never restate
 *   conflict  both sides are ahead in different dimensions (0.9.5 opens a decision)
 *
 * D2 is explicit: a message **without** `basedOn` is `fresh` + `[基线未知]`. The
 * old behaviour (treating "no marker" as stale) turned every legacy / CLI
 * message into a warning, and a warning nobody can act on is noise.
 *
 * Comparison is deliberately honest about limits:
 *
 *   - repo / env values are opaque strings. Equal = same. Different = behind
 *     (this build has no ancestry oracle for arbitrary commits), unless the
 *     caller injects one (`order`). A hash difference never becomes `conflict`
 *     on its own — only a **simultaneous** ahead + behind does.
 *   - the epoch is a number, so its order is real: `<` = behind, `>` = ahead.
 *   - keys the receiver does not know (a repo it never saw) are ignored, not
 *     guessed at.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { STALE_REPLY_RATIO } from '../constants.ts';

export type TriState = 'fresh' | 'stale' | 'conflict';

export interface BasedOn {
  repo?: Record<string, string>;
  env?: Record<string, string>;
  facts: number;
}

export interface LocalState {
  repo: Record<string, string>;
  env: Record<string, string>;
  facts: number;
}

type Order = 'equal' | 'behind' | 'ahead' | 'diverged';

export interface CompareOptions {
  /**
   * How to order two differing values of one dimension. Tests inject this to
   * avoid git; the default treats a difference as `behind` (the conservative
   * reading: assume our side has moved on).
   */
  order?: (dimension: 'repo' | 'env', key: string, theirs: string, ours: string) => Order;
}

export interface CompareResult {
  state: TriState;
  /** No `basedOn` at all → `fresh` + `[基线未知]` (D2). */
  unknown: boolean;
  /** Dimensions where the sender's marker is older than ours. */
  behind: string[];
  /** Dimensions where the sender is newer than us. */
  ahead: string[];
  /** One line to append to the injection (`[stale]` / `[conflict]`). */
  line?: string;
}

const HEAD_CHARS = 8;
const ENV_FILES = ['.env'];

/** `git rev-parse --short=8 HEAD`; `undefined` when this is not a repo / git is absent. */
const HEAD_TTL_MS = 5000;
const headCache = new Map<string, { at: number; sha?: string }>();

/**
 * `git rev-parse --short=8 HEAD`; `undefined` when this is not a repo / git is
 * absent.
 *
 * Cached for 5s per directory on purpose: spawning `git` costs 10–30ms, and a
 * baseline marker needs "the HEAD we were looking at", not a per-call oracle.
 * The cache also keeps the facts ledger's **lock hold time** tiny (the snapshot
 * is read outside the lock — a `git` spawn inside it starved other processes).
 */
export function gitHead(directory: string): string | undefined {
  const dir = String(directory ?? '').trim();
  if (!dir) return undefined;
  const hit = headCache.get(dir);
  if (hit && Date.now() - hit.at < HEAD_TTL_MS) return hit.sha;
  let sha: string | undefined;
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', `--short=${HEAD_CHARS}`, 'HEAD'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const value = String(out ?? '').trim();
    sha = /^[0-9a-f]{7,40}$/i.test(value) ? value : undefined;
  } catch {
    sha = undefined;
  }
  headCache.set(dir, { at: Date.now(), sha });
  return sha;
}

/** First 8 hex chars of each `.env` in the workspace (a content fingerprint). */
function envHashes(directory: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ENV_FILES) {
    const file = join(directory, name);
    try {
      if (!existsSync(file)) continue;
      out[basename(file)] = createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 8);
    } catch {
      /* an unreadable .env is not a baseline */
    }
  }
  return out;
}

/**
 * The receiver's own baseline. `epoch` comes from the workspace facts ledger
 * (`core/facts.ts`) so this module stays free of the ledger's write path.
 */
export function localSnapshot(input: { workspace?: string; epoch?: number; extraRepos?: string[] } = {}): LocalState {
  const repo: Record<string, string> = {};
  const workspace = String(input.workspace ?? '').trim();
  if (workspace) {
    const head = gitHead(workspace);
    if (head) repo[workspace] = head;
    for (const other of input.extraRepos ?? []) {
      const dir = String(other ?? '').trim();
      if (!dir || repo[dir]) continue;
      const otherHead = gitHead(dir);
      if (otherHead) repo[dir] = otherHead;
    }
  }
  return { repo, env: workspace ? envHashes(workspace) : {}, facts: Math.max(0, Number(input.epoch) || 0) };
}

const defaultOrder: NonNullable<CompareOptions['order']> = (_dim, _key, theirs, ours) =>
  theirs === ours ? 'equal' : 'behind';

/**
 * Pure comparison (clock / git free). `local.facts` is the current epoch.
 *
 * The empty marker (`{}` / `{facts:0}`) counts as "unknown" only when the
 * envelope carried no `basedOn` at all — an explicit `{facts:0}` is a real
 * statement ("I settled against no facts"), so it compares as epoch 0.
 */
export function compareBasedOn(
  basedOn: BasedOn | undefined | null,
  local: LocalState,
  options: CompareOptions = {}
): CompareResult {
  if (!basedOn || typeof basedOn !== 'object') {
    return { state: 'fresh', unknown: true, behind: [], ahead: [] };
  }
  const order = options.order ?? defaultOrder;
  const behind: string[] = [];
  const ahead: string[] = [];

  const compareMap = (dimension: 'repo' | 'env', theirs: Record<string, string> | undefined, ours: Record<string, string>): void => {
    for (const [key, value] of Object.entries(theirs ?? {})) {
      const mine = ours[key];
      // A key we never measured is not a stale signal — it is simply unknown.
      if (!mine) continue;
      const verdict = order(dimension, key, String(value), String(mine));
      if (verdict === 'behind') behind.push(`${dimension}:${key}`);
      else if (verdict === 'ahead') ahead.push(`${dimension}:${key}`);
      else if (verdict === 'diverged') {
        behind.push(`${dimension}:${key}`);
        ahead.push(`${dimension}:${key}`);
      }
    }
  };

  compareMap('repo', basedOn.repo, local.repo);
  compareMap('env', basedOn.env, local.env);

  const theirFacts = Math.max(0, Number(basedOn.facts) || 0);
  if (theirFacts < local.facts) behind.push('facts:epoch');
  else if (theirFacts > local.facts) ahead.push('facts:epoch');

  const state: TriState = ahead.length && behind.length ? 'conflict' : behind.length || ahead.length ? 'stale' : 'fresh';
  const result: CompareResult = { state, unknown: false, behind, ahead };
  if (state !== 'fresh') result.line = staleLine(basedOn, local, result);
  return result;
}

/** The one-line instruction (design §6); `stale` and `conflict` say it differently. */
export function staleLine(basedOn: BasedOn, local: LocalState, verdict: CompareResult): string {
  const theirRepo = Object.values(basedOn.repo ?? {})[0];
  const ourRepo = Object.values(local.repo ?? {})[0];
  const baseline = theirRepo ? `${theirRepo}` : `facts epoch ${Number(basedOn.facts) || 0}`;
  const current = ourRepo ? `${ourRepo}` : `facts epoch ${local.facts}`;
  const instruction = `只回增量（≤${Math.round(STALE_REPLY_RATIO * 100)}% 原文），不要重述已作废事实`;
  if (verdict.state === 'conflict') {
    return `[conflict] 基线分叉（本条 ${baseline}，本地 ${current}）—— 先各自报增量，0.9.5 会开决策`;
  }
  return `[stale] 本条基于 ${baseline}，你已到 ${current}；${instruction}`;
}

/** One-line summary for a tool result (the `basedOn` marker that was written). */
export function basedOnLabel(basedOn: BasedOn | undefined): string {
  if (!basedOn) return 'baseline=unknown';
  const repo = Object.entries(basedOn.repo ?? {})
    .map(([key, sha]) => `${basename(key)}@${sha}`)
    .join(',');
  const env = Object.keys(basedOn.env ?? {}).length;
  return `baseline=${repo || '-'}${env ? ` env:${env}` : ''} facts:${Number(basedOn.facts) || 0}`;
}
