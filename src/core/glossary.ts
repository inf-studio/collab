/**
 * 0.9.4 (`11-20-collab-facts`, R6): the **pair glossary** — three to ten terms
 * whose meaning two sessions agreed on.
 *
 * Why: the same word carried different meanings in the same conversation
 * (`状态` = "read-after-write" for one side, "delivered" for the other;
 * `已发版` = "merged" vs "hotfixed to prod"). A disagreement that is never
 * named becomes a review defect two hours later. The glossary stores the
 * definition per `(from, to)` pair and injects **one line**; the second
 * *conflict* over the same term refuses further messages until it is defined.
 *
 * Storage `~/.config/opencode/collab-glossary.json` (`COLLAB_GLOSSARY_FILE`
 * overrides it for tests):
 *
 *   { "v":1, "pairs": { "ses_a|ses_b": {
 *       "terms": [{ "term":"状态", "meaning":"读后立即", "at":0, "by":"ses_a" }],
 *       "conflicts": { "状态": { "count": 2, "at": 0 } } } } }
 *
 * Rules:
 *   - the pair key is the two session ids **sorted**, so both directions read
 *     and write the same glossary;
 *   - a term is one line (≤40 chars), its meaning one line (≤200);
 *   - at most 10 terms per pair; redefining a term replaces it;
 *   - `recordConflict` counts, and the **second** conflict is refused unless a
 *     definition was recorded *after* the first one — a definition that keeps
 *     losing is not a definition.
 *   - `tmp + rename` on write; a broken file reads as empty (never throws).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  GLOSSARY_CONFLICT_LIMIT,
  GLOSSARY_FILE,
  GLOSSARY_LINE_TERMS,
  GLOSSARY_MEANING_CHARS,
  GLOSSARY_TERM_CHARS,
  GLOSSARY_TERMS_MAX,
  GLOSSARY_TERMS_MIN,
  GLOSSARY_VERSION
} from '../constants.ts';
import { log } from '../log.ts';
import { asObject, randToken, truncate } from '../util.ts';
import { invalid } from './errors.ts';
import { withFileLock } from './file-lock.ts';

export interface GlossaryTerm {
  term: string;
  meaning: string;
  at: number;
  by: string;
}

export interface TermConflict {
  count: number;
  at: number;
}

export interface PairGlossary {
  terms: GlossaryTerm[];
  conflicts: Record<string, TermConflict>;
}

export interface GlossaryFile {
  v: 1;
  pairs: Record<string, PairGlossary>;
}

/** The pair key: both ids, sorted (so A→B and B→A are one glossary). */
export function pairKey(from: unknown, to: unknown): string {
  const a = String(from ?? '').trim();
  const b = String(to ?? '').trim();
  return [a, b].filter(Boolean).sort().join('|');
}

/** `ses_1234…` — the short peer label used in the single injection line. */
function peerLabel(key: string, self: string): string {
  const other = key.split('|').find(part => part && part !== self) ?? '';
  if (!other) return '';
  return other.startsWith('ses_') ? `${other.slice(0, 8)}…` : other;
}

function emptyPair(): PairGlossary {
  return { terms: [], conflicts: {} };
}

function normalizePair(raw: unknown): PairGlossary {
  const value = asObject(raw);
  const terms = (Array.isArray(value.terms) ? value.terms : [])
    .map(entry => {
      const term = truncate(entry?.term, GLOSSARY_TERM_CHARS);
      const meaning = truncate(entry?.meaning, GLOSSARY_MEANING_CHARS);
      if (!term || !meaning) return undefined;
      return {
        term,
        meaning,
        at: Number(entry?.at) || 0,
        by: String(entry?.by ?? '')
      } satisfies GlossaryTerm;
    })
    .filter((term): term is GlossaryTerm => Boolean(term))
    .slice(-GLOSSARY_TERMS_MAX);
  const conflicts: Record<string, TermConflict> = {};
  for (const [term, value2] of Object.entries(asObject(value.conflicts))) {
    const count = Number(asObject(value2).count) || 0;
    if (term && count) conflicts[term] = { count, at: Number(asObject(value2).at) || 0 };
  }
  return { terms, conflicts };
}

export function glossaryFile(): string {
  return GLOSSARY_FILE;
}

export function readGlossary(file = GLOSSARY_FILE): GlossaryFile {
  if (!existsSync(file)) return { v: GLOSSARY_VERSION as 1, pairs: {} };
  try {
    const raw = asObject(JSON.parse(readFileSync(file, 'utf8')));
    if (Number(raw.v) !== GLOSSARY_VERSION) return { v: GLOSSARY_VERSION as 1, pairs: {} };
    const pairs: Record<string, PairGlossary> = {};
    for (const [key, value] of Object.entries(asObject(raw.pairs))) {
      if (key.includes('|')) pairs[key] = normalizePair(value);
    }
    return { v: GLOSSARY_VERSION as 1, pairs };
  } catch (error) {
    log(`ignoring unreadable glossary ${file}: ${(error as Error)?.message ?? error}`);
    return { v: GLOSSARY_VERSION as 1, pairs: {} };
  }
}

export function writeGlossary(glossary: GlossaryFile, file = GLOSSARY_FILE): GlossaryFile {
  const canonical: GlossaryFile = { v: GLOSSARY_VERSION as 1, pairs: {} };
  for (const [key, value] of Object.entries(glossary.pairs ?? {})) {
    canonical.pairs[key] = normalizePair(value);
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randToken()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(canonical, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw error;
  }
  return canonical;
}

export function termsFor(from: unknown, to: unknown, file = GLOSSARY_FILE): GlossaryTerm[] {
  return readGlossary(file).pairs[pairKey(from, to)]?.terms ?? [];
}

/** Serializable write queue keyed by pair (two concurrent sends must not clobber). */
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  queues.set(
    key,
    next.then(
      () => {},
      () => {}
    )
  );
  return next;
}

export interface DefineTermInput {
  from: string;
  to: string;
  term: unknown;
  meaning: unknown;
  by?: string;
  now?: number;
  file?: string;
}

/** Define (or redefine) one term for a pair. Replaces an existing definition. */
export function defineTerm(input: DefineTermInput): Promise<{ pair: PairGlossary; term: GlossaryTerm; needMore: number }> {
  const key = pairKey(input.from, input.to);
  const file = input.file ?? GLOSSARY_FILE;
  // `collab-glossary.json` is one file per machine (same read-modify-write
  // hazard as the facts ledger) — the in-process queue is per pair, so the
  // cross-process file lock is what keeps two workspaces from clobbering it.
  return serialize(key, () =>
    withFileLock(file, () => {
      const term = truncate(input.term, GLOSSARY_TERM_CHARS);
      const meaning = truncate(input.meaning, GLOSSARY_MEANING_CHARS);
      if (!term) throw invalid('define 必填 term（如 "状态" / "已发版"）');
      if (!meaning) throw invalid('define 必填 meaning（一句话定义；定义不清等于没定义）');
      if (!String(input.from ?? '').trim() || !String(input.to ?? '').trim()) {
        throw invalid('define 需要 from / to 两个会话（术语表按会话对维护）');
      }
      const now = Number(input.now) || Date.now();
      const glossary = readGlossary(file);
      const pair = glossary.pairs[key] ?? emptyPair();
      const existing = pair.terms.find(entry => entry.term === term);
      const entry: GlossaryTerm = { term, meaning, at: now, by: String(input.by ?? '') };
      if (existing) Object.assign(existing, entry);
      else {
        if (pair.terms.length >= GLOSSARY_TERMS_MAX) {
          throw invalid(
            `术语表已达上限 ${GLOSSARY_TERMS_MAX} 条（一对会话 3–10 条）：先合并同义术语，再定义「${term}」`
          );
        }
        pair.terms.push(entry);
      }
      // The conflict counter is kept: a definition answers the *previous* conflict
      // (its `at` now outranks that conflict), and a brand-new conflict afterwards
      // starts a new round. Clearing the counter would erase the audit trail.
      glossary.pairs[key] = pair;
      writeGlossary(glossary, file);
      return { pair, term: entry, needMore: Math.max(0, GLOSSARY_TERMS_MIN - pair.terms.length) };
    })
  );
}

export interface ConflictInput {
  from: string;
  to: string;
  term: unknown;
  now?: number;
  file?: string;
}

export interface ConflictResult {
  term: string;
  count: number;
  /** `true` = further messages are refused until the term is defined (R6). */
  blocked: boolean;
  /** The current definition, when one exists and is newer than the first conflict. */
  meaning?: string;
}

/**
 * Record that a term appeared in a conflicting context (`conflict` verdict or an
 * explicit `glossary-conflict`). The **second** conflict on the same term is
 * refused unless a definition was recorded after the previous one.
 */
export function recordConflict(input: ConflictInput): Promise<ConflictResult> {
  const key = pairKey(input.from, input.to);
  const file = input.file ?? GLOSSARY_FILE;
  return serialize(key, () =>
    withFileLock(file, () => {
      const term = truncate(input.term, GLOSSARY_TERM_CHARS);
      if (!term) throw invalid('glossary conflict 需要一个 term（如 "状态"）');
      if (!String(input.from ?? '').trim() || !String(input.to ?? '').trim()) {
        throw invalid('glossary conflict 需要 from / to 两个会话');
      }
      const now = Number(input.now) || Date.now();
      const glossary = readGlossary(file);
      const pair = glossary.pairs[key] ?? emptyPair();
      const current = pair.conflicts[term] ?? { count: 0, at: 0 };
      const next: TermConflict = { count: current.count + 1, at: now };
      pair.conflicts[term] = next;
      glossary.pairs[key] = pair;
      writeGlossary(glossary, file);
      const definition = pair.terms.find(entry => entry.term === term);
      // A definition recorded **after the previous conflict** answers that round;
      // the second conflict with no newer definition refuses (R6).
      const definedAfter = Boolean(definition && definition.at > current.at);
      const blocked = next.count >= GLOSSARY_CONFLICT_LIMIT && !definedAfter;
      return {
        term,
        count: next.count,
        blocked,
        ...(definition ? { meaning: definition.meaning } : {})
      };
    })
  );
}

/**
 * The `[glossary]` injection (≤1 line). One line **total**, the pair with the
 * newest term wins — merging two pairs' dialect meanings into one line would
 * present one counterpart's definition as the other's.
 */
export function glossaryLineFor(sessionID: string, file = GLOSSARY_FILE): string | undefined {
  const self = String(sessionID ?? '').trim();
  if (!self) return undefined;
  const glossary = readGlossary(file);
  let best: { key: string; pair: PairGlossary; at: number } | undefined;
  for (const [key, pair] of Object.entries(glossary.pairs)) {
    if (!key.split('|').includes(self) || !pair.terms.length) continue;
    const at = Math.max(...pair.terms.map(term => term.at));
    if (!best || at > best.at) best = { key, pair, at };
  }
  if (!best) return undefined;
  const shown = best.pair.terms.slice(-GLOSSARY_LINE_TERMS);
  const more = best.pair.terms.length - shown.length;
  const body = shown.map(term => `${term.term}=${term.meaning}`).join('；');
  const peer = peerLabel(best.key, self);
  return `[glossary] ${peer ? `与 ${peer}: ` : ''}${body}${more > 0 ? `（还有 ${more} 条）` : ''}`;
}

/** The readable refusal text when a conflict blocks a send. */
export function conflictRefusal(result: ConflictResult, from: string, to: string): string {
  return (
    `术语「${result.term}」第 ${result.count} 次冲突：先定义再继续（R6）。` +
    (result.meaning ? `现有定义：${result.meaning}；如已不适用，请重新定义。` : '该术语还从未定义。') +
    ` 用 collab_send { target:"<对方>", text:"…", glossary:{ define:{ term:"${result.term}", meaning:"<一句话定义>" } }, confirm:true }` +
    ` 再继续（pair=${pairKey(from, to)}）。`
  );
}
