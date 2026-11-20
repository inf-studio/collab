/**
 * 0.9.5 (`11-20-collab-decide`, R1–R4): the **decision ledger**.
 *
 * Why a ledger instead of more prose: 24 hand-offs had `decisions[]` completely
 * empty, `collab_decisions` was never called once, and the two largest threads
 * (418 / 140 messages) had no hand-off record at all — so a decision had nowhere
 * to land. The same decision was reopened 19 times ("决策" wording from 11:09),
 * and both sides kept restating their boundary in natural language (54 / 38
 * decision-like turns) because the boundary was never *written down*.
 *
 * A decision is therefore a first-class, addressable value (`D1`, `D2`, …):
 *
 *   - **one file per key** — `key` is the `threadID` (`t_…`) **or** the `bid`
 *     (`b_…`), so a thread without any hand-off record still gets a ledger, and
 *     two conversations never share a `D#` namespace;
 *   - **owner-exclusive answer** (R2): only `owner` may `answer`; the asker
 *     cannot answer its own question, and an answered item can only be reopened
 *     through `supersede` (never by answering over it);
 *   - **same question is not a new question** (R3): `sha1(normalize(question))`
 *     — whitespace / punctuation / case folded — already `open` → refuse and
 *     return the existing `D#` + owner;
 *   - **at most `DECISION_OPEN_LIMIT` (3, D9) open per key**: the 4th is a
 *     readable refusal that says to close one first;
 *   - **`supersede` records who + why** (any party of the decision may void it).
 *
 * Storage rules are the same as the other global ledgers: lazy creation (a read
 * never writes), `tmp + rename` for atomicity, and the shared cross-process
 * `<file>.lock` (`core/file-lock.ts`) for mutual exclusion around the whole
 * read-modify-write — this is a read-modify-write file, so `tmp + rename` alone
 * would still lose a concurrent write.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  CONFLICT_DECISION_OPTIONS,
  CONFLICT_DECISION_TTL_MS,
  DECISION_ANSWER_LIMIT,
  DECISION_LIST_MAX,
  DECISION_OPEN_LIMIT,
  DECISION_OPTION_CHARS,
  DECISION_OPTIONS_MAX,
  DECISION_QUESTION_LIMIT,
  DECISION_REASON_LIMIT,
  DECISIONS_DIR,
  DECISIONS_VERSION
} from '../constants.ts';
import { log } from '../log.ts';
import { asObject, dedupe, randToken, truncate } from '../util.ts';
import { allBroadcasts } from './claim.ts';
import { formatAge } from './contract.ts';
import { invalid } from './errors.ts';
import { withFileLock } from './file-lock.ts';
import { conflictDecision } from './tri-state.ts';
import type { CompareResult } from './tri-state.ts';

export type DecisionStatus = 'open' | 'answered' | 'superseded';
export const DECISION_STATUSES: DecisionStatus[] = ['open', 'answered', 'superseded'];
export type DecisionOrigin = 'manual' | 'conflict';

export interface Decision {
  /** `D1`, `D2`, … — stable inside one key, never reused. */
  id: string;
  question: string;
  options: string[];
  /** The session that may answer (R2). */
  owner: string;
  status: DecisionStatus;
  answer: string | null;
  /** Who answered / superseded (`null` while open). */
  by: string | null;
  /**
   * Who **opened** the decision. Kept apart from `by` (who answered/voided), so
   * the asker is a real party: it sees the `[decide]` line and may `supersede`
   * its own question even when the answer belongs to somebody else (review B1).
   */
  askedBy: string | null;
  /**
   * The thread's participants (`from` / `to` / receiver). Only conflict
   * escalations use it: when the decider is absent, any party of the thread may
   * void the conflict decision so the thread cannot stay read-only forever
   * (review B2).
   */
  parties?: string[];
  at: number;
  /** `sha1(normalize(question))` — the de-duplication key (R3). */
  hash: string;
  origin: DecisionOrigin;
  answeredAt?: number;
  supersededAt?: number;
  reason?: string | null;
  threadId?: string;
  bid?: string;
}

export interface DecisionFile {
  v: 1;
  key: string;
  /** Highest `D<n>` ever issued + 1 (survives a hand-edited file). */
  next: number;
  items: Decision[];
}

/* ------------------------------------------------------------------ keys */

/** A decision subject: a thread id (`t_…`) or a hand-off id (`b_…`). */
export function isDecisionKey(value: unknown): boolean {
  const key = String(value ?? '').trim();
  if (!key) return false;
  return /^t_[0-9a-z]+_?[0-9a-z]*$/.test(key) || /^b_[0-9a-f]{8,32}$/.test(key);
}

export function isDecisionID(value: unknown): boolean {
  return /^D\d+$/.test(String(value ?? '').trim());
}

export function decisionNumber(value: unknown): number {
  const match = /^D(\d+)$/.exec(String(value ?? '').trim());
  return match ? Number(match[1]) : 0;
}

export function decisionsDir(directory?: string): string {
  return directory || DECISIONS_DIR;
}

/** `<dir>/<key>.json`; the key is sanitised so a weird id cannot traverse. */
export function decisionFile(key: string, directory?: string): string {
  const safe = String(key ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(decisionsDir(directory), `${safe || 'unknown'}.json`);
}

/* --------------------------------------------------------------- question */

/**
 * R3: whitespace, punctuation and case are not part of a question's identity.
 * NFKC first, so full-width variants collapse onto their ASCII spelling.
 *
 * Exported because the mutation test removes this call: without it a reworded
 * variant ("基线分叉：repo:/w" vs "基线分叉repo w") slips past the de-dupe.
 */
export function normalizeQuestion(question: unknown): string {
  return String(question ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function questionHash(question: unknown): string {
  return createHash('sha1').update(normalizeQuestion(question)).digest('hex');
}

/* ------------------------------------------------------------------ read */

function text(value: unknown, max: number): string {
  return truncate(value, max);
}

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function normalizeOptions(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  return dedupe(list.map(option => text(option, DECISION_OPTION_CHARS)).filter(Boolean)).slice(0, DECISION_OPTIONS_MAX);
}

function normalizeDecision(raw: unknown): Decision | undefined {
  const value = asObject(raw);
  const id = String(value.id ?? '').trim();
  if (!isDecisionID(id)) return undefined;
  const question = text(value.question, DECISION_QUESTION_LIMIT);
  if (!question) return undefined;
  const owner = String(value.owner ?? '').trim();
  if (!owner) return undefined;
  const status = DECISION_STATUSES.includes(String(value.status) as DecisionStatus)
    ? (String(value.status) as DecisionStatus)
    : 'open';
  const options = normalizeOptions(value.options);
  const answer = value.answer === null || value.answer === undefined ? '' : text(value.answer, DECISION_ANSWER_LIMIT);
  const askedBy = String(value.askedBy ?? '').trim();
  const parties = Array.isArray(value.parties)
    ? dedupe(value.parties.map((sid: unknown) => String(sid ?? '').trim())).filter(Boolean).slice(0, 8)
    : [];
  return {
    id,
    question,
    options,
    owner,
    status,
    answer: answer || null,
    by: value.by ? String(value.by) : null,
    // A file written before `askedBy` existed: the asker is unknown, not `by`.
    askedBy: askedBy || null,
    ...(parties.length ? { parties } : {}),
    at: num(value.at),
    // Recomputed when missing: a hand-edited row must still de-duplicate.
    hash: /^[0-9a-f]{40}$/.test(String(value.hash ?? '')) ? String(value.hash) : questionHash(question),
    origin: String(value.origin ?? '') === 'conflict' ? 'conflict' : 'manual',
    ...(num(value.answeredAt) ? { answeredAt: num(value.answeredAt) } : {}),
    ...(num(value.supersededAt) ? { supersededAt: num(value.supersededAt) } : {}),
    ...(value.reason ? { reason: text(value.reason, DECISION_REASON_LIMIT) } : {}),
    ...(value.threadId ? { threadId: String(value.threadId) } : {}),
    ...(value.bid ? { bid: String(value.bid) } : {})
  };
}

function emptyFile(key: string): DecisionFile {
  return { v: DECISIONS_VERSION as 1, key, next: 1, items: [] };
}

function normalizeFile(raw: unknown, key: string): DecisionFile {
  const value = asObject(raw);
  if (Number(value.v) !== DECISIONS_VERSION) return emptyFile(key);
  const items = (Array.isArray(value.items) ? value.items : [])
    .map(normalizeDecision)
    .filter((item): item is Decision => Boolean(item));
  // Duplicate ids can only come from a hand edit: last wins, ids stay unique.
  const byID = new Map<string, Decision>();
  for (const item of items) byID.set(item.id, item);
  const unique = [...byID.values()];
  const highest = unique.reduce((max, item) => Math.max(max, decisionNumber(item.id)), 0);
  return {
    v: DECISIONS_VERSION as 1,
    key,
    next: Math.max(num(value.next), highest + 1),
    items: unique
  };
}

/** Read one key's ledger. Missing / unreadable / wrong-version → empty (never throws). */
export function readDecisions(key: string, directory?: string): DecisionFile {
  const file = decisionFile(key, directory);
  if (!existsSync(file)) return emptyFile(key);
  try {
    return normalizeFile(JSON.parse(readFileSync(file, 'utf8')), key);
  } catch (error) {
    log(`ignoring unreadable decision file ${file}: ${(error as Error)?.message ?? error}`);
    return emptyFile(key);
  }
}

/** `tmp + rename`: a crash mid-write leaves the previous ledger intact. */
export function writeDecisions(file: DecisionFile, directory?: string): DecisionFile {
  const target = decisionFile(file.key, directory);
  const canonical = normalizeFile({ ...file, v: DECISIONS_VERSION as 1 }, file.key);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randToken()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(canonical, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, target);
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

/** Every readable ledger in the directory (bounded so one bad dir cannot stall a request). */
export function readAllDecisions(directory?: string, limit = 500): DecisionFile[] {
  let names: string[] = [];
  try {
    names = readdirSync(decisionsDir(directory)).filter(name => name.endsWith('.json') && !name.includes('.tmp'));
  } catch {
    return [];
  }
  // The scan is bounded from the **newest** end (`slice(-limit)`): taking the
  // head would keep the oldest 500 files and silently hide the newest one — the
  // exact bug a bounded scan must not have (review S7).
  return names
    .sort()
    .slice(-Math.max(1, limit))
    .map(name => readDecisions(basename(name, '.json'), directory))
    .filter(file => file.items.length > 0);
}

/* ---------------------------------------------------------------- writing */

/** Per-key write queue: two tool calls in one process never clobber each other. */
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

function normalizeOwner(value: unknown): string {
  const owner = String(value ?? '').trim();
  if (!/^ses_[A-Za-z0-9_.:-]+$/.test(owner)) {
    throw invalid(`owner 必须是会话 id（ses_…），收到 "${owner}"`);
  }
  return owner;
}

function openItems(file: DecisionFile): Decision[] {
  return file.items.filter(item => item.status === 'open');
}

function idOf(file: DecisionFile): string {
  // `next` is the highest issued id + 1; the visible rows are a second source
  // (a hand-edited file may carry a counter behind its rows). An empty file
  // starts at 1 → D1.
  const highest = file.items.reduce((max, item) => Math.max(max, decisionNumber(item.id) + 1), 1);
  return `D${Math.max(Number(file.next) || 1, highest)}`;
}

export interface OpenDecisionInput {
  key: unknown;
  question: unknown;
  options: unknown;
  owner: unknown;
  by?: string;
  origin?: DecisionOrigin;
  threadId?: string;
  bid?: string;
  /** Thread participants (conflict escalations; review B2's escape hatch). */
  parties?: string[];
  now?: number;
  directory?: string;
}

export interface OpenDecisionResult {
  decision: Decision;
  file: DecisionFile;
}

interface OpenOutcome {
  decision?: Decision;
  /** The open item with the same normalised question (R3). */
  duplicate?: Decision;
  /** Readable reason when the open cap blocked it (D9). */
  capped?: string;
  file: DecisionFile;
}

function openLocked(input: OpenDecisionInput): OpenOutcome {
  const key = String(input.key ?? '').trim();
  if (!isDecisionKey(key)) {
    throw invalid(`key 必须是 threadID（t_…）或 bid（b_…），收到 "${key}"`);
  }
  const question = text(input.question, DECISION_QUESTION_LIMIT);
  if (!question) throw invalid('open 必填 question（一句话说清要决定什么）');
  if (!normalizeQuestion(question)) {
    throw invalid('question 去掉空白/标点后为空：请写成一句可回答的问题');
  }
  const options = normalizeOptions(input.options);
  if (options.length < 2) {
    throw invalid(`open 需要 options ≥ 2（可选方案），本次 ${options.length} 个 —— 未写入任何内容`);
  }
  const owner = normalizeOwner(input.owner);
  const now = Number(input.now) || Date.now();
  const file = readDecisions(key, input.directory);
  const hash = questionHash(question);
  const origin: DecisionOrigin = input.origin === 'conflict' ? 'conflict' : 'manual';

  // R3: the same question is the same decision, however it is spelled.
  const duplicate = openItems(file).find(item => item.hash === hash);
  if (duplicate) return { file, duplicate };

  // D9: at most three open **manual** decisions per key — the 4th is a readable
  // refusal, never eviction. A conflict escalation has its own slot (review S6):
  // a full manual list must never swallow the escalation, or the thread would
  // keep arguing instead of getting a decision.
  const open = openItems(file);
  if (origin === 'manual') {
    const manual = open.filter(item => item.origin !== 'conflict');
    if (manual.length >= DECISION_OPEN_LIMIT) {
      return {
        file,
        capped:
          `${key} 已有 ${manual.length} 条 open 决策（上限 ${DECISION_OPEN_LIMIT}）：` +
          `先 answer 或 supersede 一条（${manual.map(item => item.id).join(' / ')}）再开新的`
      };
    }
  }

  const id = idOf(file);
  const parties = dedupe(
    (Array.isArray(input.parties) ? input.parties : []).map(sid => String(sid ?? '').trim())
  ).filter(Boolean);
  const decision: Decision = {
    id,
    question,
    options,
    owner,
    status: 'open',
    answer: null,
    by: null,
    askedBy: String(input.by ?? '').trim() || null,
    ...(parties.length ? { parties: parties.slice(0, 8) } : {}),
    at: now,
    hash,
    origin,
    ...(input.threadId ? { threadId: String(input.threadId) } : {}),
    ...(input.bid ? { bid: String(input.bid) } : {})
  };
  const next: DecisionFile = {
    ...file,
    next: decisionNumber(id) + 1,
    items: [...file.items, decision]
  };
  return { decision, file: writeDecisions(next, input.directory) };
}

/**
 * R1: create a decision. Throws a readable refusal for a duplicate question
 * (returns the existing `D#` + owner, R3) or a full open list (D9).
 */
export function openDecision(input: OpenDecisionInput): Promise<OpenDecisionResult> {
  const key = String(input.key ?? '').trim();
  return serialize(key, () =>
    withFileLock(decisionFile(key, input.directory), () => {
      const outcome = openLocked(input);
      if (outcome.duplicate) {
        throw invalid(
          `已有同问决策 ${outcome.duplicate.id} open, wait ${outcome.duplicate.owner}` +
            `（同一问题不重复新建，key=${key}）：等 owner 回答，或先 supersede 再开新的。未写入任何内容。`
        );
      }
      if (outcome.capped) throw invalid(`${outcome.capped}。未写入任何内容。`);
      return { decision: outcome.decision!, file: outcome.file };
    })
  );
}

export interface AnswerDecisionInput {
  key: unknown;
  id: unknown;
  answer: unknown;
  by: string;
  now?: number;
  directory?: string;
}

/** R2: only `owner` may answer; an answered item needs `supersede` first. */
export function answerDecision(input: AnswerDecisionInput): Promise<{ decision: Decision; file: DecisionFile }> {
  const key = String(input.key ?? '').trim();
  const id = String(input.id ?? '').trim();
  if (!isDecisionKey(key)) throw invalid(`key 必须是 threadID（t_…）或 bid（b_…），收到 "${key}"`);
  if (!isDecisionID(id)) throw invalid(`answer 需要决策 id（D1 / D2 …），收到 "${id}"`);
  const answer = text(input.answer, DECISION_ANSWER_LIMIT);
  if (!answer) throw invalid('answer 必填 answer（结论要写下来，否则下一个人还要再问一次）');
  const by = String(input.by ?? '').trim();
  if (!by) throw invalid('answer 需要会话上下文（sessionID）：只有 owner 能回答');
  const now = Number(input.now) || Date.now();

  return serialize(key, () =>
    withFileLock(decisionFile(key, input.directory), () => {
      const file = readDecisions(key, input.directory);
      const item = file.items.find(entry => entry.id === id);
      if (!item) {
        throw invalid(
          `没有决策 ${id}（key=${key}）：现有 ${file.items.map(entry => entry.id).join(' / ') || '（空）'} —— ` +
            '用 collab_decide { action:"list" } 查看。未写入任何内容。'
        );
      }
      if (item.status === 'answered') {
        throw invalid(
          `${id} 已回答（by=${item.by ?? '-'}）：已回答不可再答，要改结论请先 ` +
            `collab_decide { action:"supersede", id:"${id}", reason:"…" } 再重新 open。未写入任何内容。`
        );
      }
      if (item.status === 'superseded') {
        throw invalid(`${id} 已 superseded（${item.reason ?? '-'}）：作废的决策不能再回答，请重新 open。未写入任何内容。`);
      }
      if (by !== item.owner) {
        throw invalid(
          `拒绝回答 ${id}：只有 owner ${item.owner} 能 answer（当前 ${by}）。` +
            '提问方不得代答；请 collab_send 请 owner 回答，或先 supersede 后重新分配 owner。未写入任何内容。'
        );
      }
      const answered: Decision = {
        ...item,
        status: 'answered',
        answer,
        by,
        answeredAt: now
      };
      const next: DecisionFile = {
        ...file,
        items: file.items.map(entry => (entry.id === id ? answered : entry))
      };
      return { decision: answered, file: writeDecisions(next, input.directory) };
    })
  );
}

export interface SupersedeDecisionInput {
  key: unknown;
  id: unknown;
  reason: unknown;
  by: string;
  now?: number;
  directory?: string;
}

/** Any party of the decision may void it — but `by` + `reason` are mandatory. */
export function supersedeDecision(
  input: SupersedeDecisionInput
): Promise<{ decision: Decision; file: DecisionFile }> {
  const key = String(input.key ?? '').trim();
  const id = String(input.id ?? '').trim();
  if (!isDecisionKey(key)) throw invalid(`key 必须是 threadID（t_…）或 bid（b_…），收到 "${key}"`);
  if (!isDecisionID(id)) throw invalid(`supersede 需要决策 id（D1 / D2 …），收到 "${id}"`);
  const reason = text(input.reason, DECISION_REASON_LIMIT);
  if (!reason) throw invalid('supersede 必填 reason：没有原因作废 = 下一个人还会再问一遍');
  const by = String(input.by ?? '').trim();
  if (!by) throw invalid('supersede 需要会话上下文（sessionID）');
  const now = Number(input.now) || Date.now();

  return serialize(key, () =>
    withFileLock(decisionFile(key, input.directory), () => {
      const file = readDecisions(key, input.directory);
      const item = file.items.find(entry => entry.id === id);
      if (!item) {
        throw invalid(`没有决策 ${id}（key=${key}）：用 collab_decide { action:"list" } 查看。未写入任何内容。`);
      }
      if (item.status === 'superseded') {
        throw invalid(`${id} 已经 superseded（${item.reason ?? '-'}），无需重复作废。未写入任何内容。`);
      }
      const mine = [item.by, item.askedBy, item.owner, ...(item.parties ?? [])]
        .map(value => String(value ?? '').trim())
        .filter(Boolean);
      if (!mine.includes(by)) {
        throw invalid(
          `拒绝作废 ${id}：只有本决策的提问方（${item.askedBy ?? '-'}）、owner（${item.owner}）` +
            `${item.parties?.length ? `或该 thread 的参与方（${item.parties.join(' / ')}）` : ''}能 supersede，` +
            `当前 ${by}。未写入任何内容。`
        );
      }
      const superseded: Decision = {
        ...item,
        status: 'superseded',
        by,
        reason,
        supersededAt: now
      };
      const next: DecisionFile = {
        ...file,
        items: file.items.map(entry => (entry.id === id ? superseded : entry))
      };
      return { decision: superseded, file: writeDecisions(next, input.directory) };
    })
  );
}

/* ----------------------------------------------------------- conflict (R6) */

export interface ConflictDecisionInput {
  key: unknown;
  verdict: CompareResult;
  owner: unknown;
  by: string;
  threadId?: string;
  bid?: string;
  /** Thread participants (`from` / `to` / the receiver) — the supersede escape hatch. */
  parties?: string[];
  now?: number;
  directory?: string;
}

/**
 * Design §6: a `conflict` verdict opens **one** decision (never another round of
 * prose) — idempotent, because the same divergence will be seen again by every
 * later message. Returns the existing open conflict decision when there is one;
 * never throws (the context hook must not fail a model request).
 *
 * The critical section is bounded (`waitMs: 1000`): this runs inside the
 * `context` hook, where the default 30s lock queue would stall a model request.
 */
export function openConflictDecision(
  input: ConflictDecisionInput
): Promise<{ decision?: Decision; existing?: Decision; capped?: string }> {
  const key = String(input.key ?? '').trim();
  if (!isDecisionKey(key)) return Promise.resolve({ capped: `key 不是 threadID / bid："${key}"` });
  const spec = conflictDecision(input.verdict);
  const owner = String(input.owner ?? '').trim();
  if (!/^ses_[A-Za-z0-9_.:-]+$/.test(owner)) {
    return Promise.resolve({ capped: `conflict 决策缺 owner（decider 未解析）："${owner}"` });
  }
  const parties = dedupe(
    (Array.isArray(input.parties) ? input.parties : []).map(sid => String(sid ?? '').trim())
  ).filter(Boolean);
  return serialize(key, () =>
    withFileLock(
      decisionFile(key, input.directory),
      () => {
        const file = readDecisions(key, input.directory);
        const existing = openItems(file).find(item => item.origin === 'conflict');
        if (existing) return { existing };
        try {
          const outcome = openLocked({
            key,
            question: spec.question,
            options: spec.options.length >= 2 ? spec.options : [...CONFLICT_DECISION_OPTIONS],
            owner,
            by: input.by,
            origin: 'conflict',
            threadId: input.threadId,
            bid: input.bid,
            parties,
            now: input.now,
            directory: input.directory
          });
          if (outcome.duplicate) return { existing: outcome.duplicate };
          if (outcome.capped) return { capped: outcome.capped };
          return { decision: outcome.decision };
        } catch (error) {
          // A broken ledger must never fail a model request (context hook).
          return { capped: (error as Error)?.message ?? String(error) };
        }
      },
      // The hook must not wait 30s for a ledger writer; one second, then log.
      { waitMs: 1000 }
    )
  ).catch(error => ({ capped: (error as Error)?.message ?? String(error) }));
}

/** The open conflict decision of a key, if any — the thread's "read-only" gate. */
export function openConflictOf(key: string, directory?: string, now = Date.now()): Decision | undefined {
  if (!isDecisionKey(key)) return undefined;
  return openItems(readDecisions(key, directory)).find(
    // A decision past its TTL no longer blocks: the gate must open even before
    // the next injection persists the automatic supersede (review B2).
    item => item.origin === 'conflict' && now - (Number(item.at) || 0) < CONFLICT_DECISION_TTL_MS
  );
}

/**
 * Review B2: a conflict decision that nobody answered for 24h is **superseded
 * automatically** — the thread is released instead of staying read-only until a
 * human notices. The scan runs where drift is scanned (the `context` hook), so
 * no timer/daemon is involved; it is idempotent and never throws.
 */
export async function expireConflictDecisions(now = Date.now(), directory?: string): Promise<string[]> {
  const expired: string[] = [];
  for (const file of readAllDecisions(directory)) {
    const stale = file.items.filter(
      item =>
        item.status === 'open' &&
        item.origin === 'conflict' &&
        now - (Number(item.at) || 0) >= CONFLICT_DECISION_TTL_MS
    );
    if (!stale.length) continue;
    const staleIDs = new Set(stale.map(item => item.id));
    const key = file.key;
    try {
      await serialize(key, () =>
        withFileLock(
          decisionFile(key, directory),
          () => {
            const fresh = readDecisions(key, directory);
            const items = fresh.items.map(item =>
              staleIDs.has(item.id) && item.status === 'open' && item.origin === 'conflict'
                ? {
                    ...item,
                    status: 'superseded' as DecisionStatus,
                    by: 'system',
                    reason: `冲突决策 ${CONFLICT_DECISION_TTL_MS / 3_600_000}h 未回答，自动作废（thread 只读解除）`,
                    supersededAt: now
                  }
                : item
            );
            if (!items.some((item, index) => item !== fresh.items[index])) return;
            writeDecisions({ ...fresh, items }, directory);
            for (const id of staleIDs) expired.push(`${key}#${id}`);
          },
          { waitMs: 1000 }
        )
      );
    } catch (error) {
      log(`conflict decision expiry failed for ${key}: ${(error as Error)?.message ?? error}`);
    }
  }
  return expired;
}

/* --------------------------------------------------------------- reading */

export function listDecisions(
  key: string,
  options: { includeAll?: boolean; limit?: number; directory?: string } = {}
): Decision[] {
  const file = readDecisions(key, options.directory);
  const rows = options.includeAll ? file.items : openItems(file);
  return rows.slice(-Math.max(1, Number(options.limit) || DECISION_LIST_MAX));
}

/** Every open decision this session is a party of (asker, owner, or thread party). */
export function decisionsForSession(
  sessionID: string,
  directory?: string
): Array<{ key: string; decision: Decision }> {
  const sid = String(sessionID ?? '').trim();
  if (!sid) return [];
  const out: Array<{ key: string; decision: Decision }> = [];
  for (const file of readAllDecisions(directory)) {
    for (const item of openItems(file)) {
      const parties = [item.askedBy, item.by, item.owner, ...(item.parties ?? [])]
        .map(value => String(value ?? '').trim())
        .filter(Boolean);
      if (parties.includes(sid)) out.push({ key: file.key, decision: item });
    }
  }
  return out.sort((left, right) => left.decision.at - right.decision.at);
}

/**
 * The single-line `[decide]` injection (design §7). At most one line; only open
 * decisions this session is a party of, oldest first, top 3 + "还有 N 条".
 */
export function decideLine(sessionID: string, now = Date.now(), directory?: string): string | undefined {
  const rows = decisionsForSession(sessionID, directory);
  if (!rows.length) return undefined;
  const show = rows.slice(0, 3).map(({ key, decision }) => {
    const owner = decision.owner.length > 12 ? `${decision.owner.slice(0, 12)}…` : decision.owner;
    // `D#` is per key (two threads each have a `D1`), so the line carries the
    // key: without it `answer` would be ambiguous for the reader.
    return `${decision.id}@${key} open（等 ${owner}，${formatAge(now - decision.at)}）`;
  });
  const rest = rows.length - show.length;
  return `[decide] ${show.join(' · ')}${rest > 0 ? ` · 还有 ${rest} 条` : ''}`;
}

export interface ResolvedDecision {
  id: string;
  question: string;
  /** What was decided (the answer text, or the legacy hand-off decision text). */
  decision: string;
  status: DecisionStatus | 'recorded';
  key: string;
  owner: string;
  by?: string;
  source: 'ledger' | 'handoff';
  /**
   * The same `D#` exists under more than one key. `D#` is per-key by design, so
   * a bare `decision:D1` is genuinely ambiguous once two conversations each
   * opened a `D1` — the caller must scope it (`decision:<key>#D1`). Never
   * silently pick one.
   */
  ambiguous?: string[];
}

/**
 * **The one place that answers "is this decision decided?"** (design §3 / parent
 * §4): `decision:<id>` evidence must not be judged by two implementations.
 *
 * Accepted forms:
 *   `D3`              a ledger decision — an error if the id exists under 2+ keys
 *   `<key>#D3`        scoped (`t_…` / `b_…`) — unambiguous
 *   `<anything>`      a 0.7.0 hand-off `decisions[]` id (`D-064`, `exit-code`)
 *
 * Order is deliberate — the 0.9.5 ledger is authoritative, the hand-off
 * `decisions[]` is a **compatibility input only**. An open ledger row shadows a
 * same-id hand-off row: an `open` question is not evidence, even if an old
 * hand-off happened to carry a decision with the same id.
 */
export function resolveDecision(
  id: unknown,
  options: { directory?: string; handoffs?: Array<{ bid?: string; decisions?: unknown[] }> } = {}
): ResolvedDecision | undefined {
  const raw = String(id ?? '').trim();
  if (!raw) return undefined;
  const hashIndex = raw.indexOf('#');
  const head = hashIndex > 0 ? raw.slice(0, hashIndex).trim() : '';
  const keyHint = head && isDecisionKey(head) ? head : undefined;
  const wanted = (keyHint ? raw.slice(hashIndex + 1) : raw).trim();
  if (!wanted) return undefined;
  const lower = wanted.toLowerCase();

  // A hand-off id may have any shape (`D-064`, `exit-code`); a ledger id is `D#`.
  if (keyHint || isDecisionID(wanted)) {
    const files = keyHint ? [readDecisions(keyHint, options.directory)] : readAllDecisions(options.directory);
    const matches: Array<{ key: string; item: Decision }> = [];
    for (const file of files) {
      for (const item of file.items) {
        if (item.id.toLowerCase() === lower) matches.push({ key: file.key, item });
      }
    }
    if (matches.length > 1) {
      return {
        id: wanted,
        question: '',
        decision: '',
        status: 'open',
        key: '',
        owner: '',
        source: 'ledger',
        ambiguous: matches.map(match => match.key).sort()
      };
    }
    if (matches.length === 1) {
      const { key, item } = matches[0];
      return {
        id: item.id,
        question: item.question,
        decision: item.status === 'open' ? '' : String(item.answer ?? ''),
        status: item.status,
        key,
        owner: item.owner,
        ...(item.by ? { by: item.by } : {}),
        source: 'ledger'
      };
    }
  }

  const handoffs = options.handoffs ?? allBroadcasts();
  for (const record of handoffs) {
    const decisions = Array.isArray(record?.decisions) ? record.decisions : [];
    for (const entry of decisions) {
      const value = asObject(entry);
      if (String(value.id ?? '').trim().toLowerCase() !== lower) continue;
      return {
        id: String(value.id).trim(),
        question: text(value.decision, DECISION_QUESTION_LIMIT),
        decision: text(value.decision, DECISION_ANSWER_LIMIT),
        status: 'recorded',
        key: String(record?.bid ?? ''),
        owner: '',
        ...(value.by ? { by: String(value.by) } : {}),
        source: 'handoff'
      };
    }
  }
  return undefined;
}

/** One row for `collab_decide list` / a tool receipt. */
export function formatDecision(decision: Decision): string {
  const asker =
    decision.askedBy && decision.askedBy !== decision.owner ? `，提问 ${decision.askedBy}` : '';
  const mark =
    decision.status === 'answered'
      ? `answered: ${decision.answer ?? '-'}（by ${decision.by ?? '-'}）`
      : decision.status === 'superseded'
        ? `superseded: ${decision.reason ?? '-'}（by ${decision.by ?? '-'}）`
        : `open（等 ${decision.owner}${asker}）`;
  const origin = decision.origin === 'conflict' ? ' [conflict]' : '';
  return `${decision.id}${origin} ${decision.question} → ${mark}`;
}
