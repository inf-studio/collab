/**
 * 0.9.4 (`11-20-collab-facts`, R1/R3/D4/D6): the **workspace facts ledger**.
 *
 * Why a ledger at all: 117 of 624 messages (19%) were later retracted or
 * corrected — environment noise, tool misuse (`rg -rn` rewriting matches),
 * probe artefacts, different measuring sticks. A retraction had no way to
 * travel: the owner's decision at 00:45 only stopped the other side at 00:59.
 * A fact is therefore a *first-class, addressable* value (`F1`, `F2`, …) that
 * can be settled, cited, retracted and invalidated — and a message can name the
 * facts it rests on (`factIds` / `basedOn.facts`), so a retraction reaches the
 * work that cited it.
 *
 * Storage (R1/D4): **one global file, one ledger per workspace**:
 *
 *   ~/.config/opencode/collab-facts.json
 *   { "v": 1, "workspaces": { "/abs/workspace": {
 *       "epoch": 7, "seq": 9,
 *       "facts": [ { id:"F3", claim, grade, evidence, state, basedOn, by, at,
 *                    supersededBy, retractedAt?, retractReason? } ],
 *       "metrics": { "2026-11-20": { settled: 4, retracted: 1,
 *                                    reasons: { "口径错误": 1 } } } } } }
 *
 * A design-shaped flat file (`{v, epoch, workspace, facts}`) is read into the
 * same container, so the shape in the design document is still a legal input.
 *
 * Rules that matter:
 *
 *   - **`tmp + rename`** on every write: a crash can never truncate the ledger.
 *   - **`epoch` moves only on a successful `invalidate`** (design §3): it is the
 *     world version a fact was settled against, not a per-write counter.
 *   - **Derivation is explicit, never guessed.** A fact's dependants are the
 *     facts that name it in `basedOn.factIds` (transitively). The design's
 *     `basedOn.facts <= sinceEpoch` formula is implemented for the
 *     `invalidate {since: <epoch>}` form, where it means "everything settled in
 *     or before that world version"; applying it to a single fact id would
 *     retract every fact of the same era, including unrelated ones (documented
 *     deviation, `docs/collab.md` §11.25).
 *   - **`relayed` / `unknown` cannot be cited as evidence** (D5/R2): a
 *     retransmission is not a measurement; the refusal names the fix.
 *   - **No auto-close of todos** (R5): `invalidate` only sets `staleWork`, the
 *     open todo stays open and says `⚠失效` — closing it would decide for the
 *     human.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import {
  CONTRACT_DIR,
  FACT_CLAIM_LIMIT,
  FACT_EVIDENCE_LIMIT,
  FACT_GRADES,
  FACT_LIST_MAX,
  FACT_REASON_LIMIT,
  FACTS_FILE,
  FACTS_LIMIT,
  FACTS_VERSION,
  FACT_SETTLE_GRADES,
  FACT_STATES,
  FACT_WEAK_GRADES
} from '../constants.ts';
import { log } from '../log.ts';
import { asObject, dedupe, randToken, truncate } from '../util.ts';
import { invalid } from './errors.ts';
import { TODO_DONE_STATUSES, readContract, writeContract } from './contract.ts';
import { withFileLock } from './file-lock.ts';
import { localSnapshot } from './tri-state.ts';

export type FactGrade = 'measured' | 'inferred' | 'relayed' | 'unknown';
export type FactState = 'active' | 'superseded' | 'retracted';

/** The version marker a fact (and a message) was settled against. */
export interface FactBasedOn {
  repo?: Record<string, string>;
  env?: Record<string, string>;
  /** Epoch at settle time (`0` = an explicit "no baseline"). */
  facts: number;
  /** Facts this one cites as its evidence (the derivation edge set). */
  factIds?: string[];
}

export interface Fact {
  /** `F1`, `F2`, … — stable and never reused inside one workspace ledger. */
  id: string;
  claim: string;
  grade: FactGrade;
  evidence: string;
  state: FactState;
  basedOn: FactBasedOn;
  by: string;
  at: number;
  /** The fact that superseded this one (`null` for an invalidation root). */
  supersededBy: string | null;
  supersededAt?: number;
  retractedAt?: number;
  retractReason?: string | null;
  scope: 'workspace';
}

/** Per-day counters (R3: `metrics.retract_count` must be measurable). */
export interface FactDayMetrics {
  settled: number;
  /** `retract` **and** `supersede` (design §5): both make a claim unusable. */
  retracted: number;
  /**
   * 0.9.4 review: how many `stale` messages this workspace delivered. The
   * "reply ≤30% of the original" rule is a **behavioural** convention the plugin
   * cannot machine-check (it does not write the reply); this counter is the
   * auditable half — a human can sample the deliveries and measure the ratio.
   */
  staleDeliveries: number;
  /** Why facts were retracted (the reason text → count). */
  reasons: Record<string, number>;
}

export interface WorkspaceFacts {
  epoch: number;
  /** Highest `F<n>` ever issued — survives pruning, so ids are never reused. */
  seq: number;
  facts: Fact[];
  metrics: Record<string, FactDayMetrics>;
}

export interface FactsLedger {
  v: 1;
  workspaces: Record<string, WorkspaceFacts>;
}

/* ------------------------------------------------------------------ helpers */

/** A session's workspace; the ledger is per workspace (D4). */
export function workspaceOf(ctx: { location?: { directory?: string } } | undefined): string {
  const dir = String(ctx?.location?.directory ?? '').trim();
  return (dir || process.cwd()).replace(/\/+$/, '');
}

export function factsFile(): string {
  return FACTS_FILE;
}

/** `YYYY-MM-DD` by local date (a "day" for the metrics is the operator's day). */
export function dayKey(now: number): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

const text = (value: unknown, max: number): string => truncate(value, max);
const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function isFactID(value: unknown): boolean {
  return /^F\d+$/.test(String(value ?? '').trim());
}

export function factIDNumber(value: unknown): number {
  const match = /^F(\d+)$/.exec(String(value ?? '').trim());
  return match ? Number(match[1]) : 0;
}

/** A weak grade may not be used as another fact's evidence (D5). */
export function isWeakGrade(grade: unknown): boolean {
  return FACT_WEAK_GRADES.includes(String(grade ?? ''));
}

function normalizeBasedOn(raw: unknown): FactBasedOn {
  const value = asObject(raw);
  const map = (input: unknown): Record<string, string> | undefined => {
    const source = asObject(input);
    const out: Record<string, string> = {};
    for (const [key, commit] of Object.entries(source)) {
      const name = String(key ?? '').trim();
      const sha = String(commit ?? '').trim();
      if (name && sha) out[name] = sha;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const repo = map(value.repo);
  const env = map(value.env);
  const factIds = Array.isArray(value.factIds)
    ? dedupe(value.factIds.map(id => String(id).trim()).filter(isFactID))
    : [];
  return {
    ...(repo ? { repo } : {}),
    ...(env ? { env } : {}),
    facts: num(value.facts),
    ...(factIds.length ? { factIds } : {})
  };
}

function emptyWorkspace(): WorkspaceFacts {
  return { epoch: 0, seq: 0, facts: [], metrics: {} };
}

function normalizeFact(raw: unknown): Fact | undefined {
  const value = asObject(raw);
  const id = String(value.id ?? '').trim();
  if (!isFactID(id)) return undefined;
  const claim = text(value.claim, FACT_CLAIM_LIMIT);
  if (!claim) return undefined;
  const grade = FACT_GRADES.includes(String(value.grade)) ? (String(value.grade) as FactGrade) : 'unknown';
  const state = FACT_STATES.includes(String(value.state)) ? (String(value.state) as FactState) : 'active';
  return {
    id,
    claim,
    grade,
    evidence: text(value.evidence, FACT_EVIDENCE_LIMIT),
    state,
    basedOn: normalizeBasedOn(value.basedOn),
    by: String(value.by ?? ''),
    at: num(value.at),
    supersededBy: value.supersededBy ? String(value.supersededBy) : null,
    ...(num(value.supersededAt) ? { supersededAt: num(value.supersededAt) } : {}),
    ...(num(value.retractedAt) ? { retractedAt: num(value.retractedAt) } : {}),
    ...(value.retractReason ? { retractReason: text(value.retractReason, FACT_REASON_LIMIT) } : {}),
    scope: 'workspace'
  };
}

function normalizeMetrics(raw: unknown): Record<string, FactDayMetrics> {
  const out: Record<string, FactDayMetrics> = {};
  for (const [day, value] of Object.entries(asObject(raw))) {
    const source = asObject(value);
    const reasons: Record<string, number> = {};
    for (const [reason, count] of Object.entries(asObject(source.reasons))) {
      const n = num(count);
      if (n) reasons[text(reason, FACT_REASON_LIMIT) || '(未写原因)'] = n;
    }
    out[day] = {
      settled: num(source.settled),
      retracted: num(source.retracted),
      staleDeliveries: num(source.staleDeliveries),
      reasons
    };
  }
  return out;
}

function normalizeWorkspace(raw: unknown): WorkspaceFacts {
  const value = asObject(raw);
  const facts = (Array.isArray(value.facts) ? value.facts : [])
    .map(normalizeFact)
    .filter((fact): fact is Fact => Boolean(fact));
  // Keep the newest `seq` monotonic even for a hand-edited file whose counter is
  // behind its rows: an id must never be issued twice.
  const highest = facts.reduce((max, fact) => Math.max(max, factIDNumber(fact.id)), 0);
  return {
    epoch: num(value.epoch),
    seq: Math.max(num(value.seq), highest),
    facts,
    metrics: normalizeMetrics(value.metrics)
  };
}

/**
 * Read the ledger. Missing / unreadable / wrong-version files return an empty
 * container (never throws — a broken ledger must not take a tool call down).
 *
 * A design-shaped flat file (`{v, epoch, workspace, facts}`) is migrated into
 * the multi-workspace container on read; the next write persists the new shape.
 */
export function readLedger(file = FACTS_FILE): FactsLedger {
  if (!existsSync(file)) return { v: FACTS_VERSION as 1, workspaces: {} };
  try {
    const raw = asObject(JSON.parse(readFileSync(file, 'utf8')));
    if (Number(raw.v) !== FACTS_VERSION) return { v: FACTS_VERSION as 1, workspaces: {} };
    const workspaces: Record<string, WorkspaceFacts> = {};
    const container = asObject(raw.workspaces);
    for (const [dir, value] of Object.entries(container)) {
      const key = String(dir ?? '').trim().replace(/\/+$/, '');
      if (key) workspaces[key] = normalizeWorkspace(value);
    }
    // The design's flat shape: `{ v, epoch, workspace, facts }`.
    const flatWorkspace = String(raw.workspace ?? '').trim().replace(/\/+$/, '');
    if (flatWorkspace && !workspaces[flatWorkspace]) {
      workspaces[flatWorkspace] = normalizeWorkspace(raw);
    }
    return { v: FACTS_VERSION as 1, workspaces };
  } catch (error) {
    log(`ignoring unreadable facts ledger ${file}: ${(error as Error)?.message ?? error}`);
    return { v: FACTS_VERSION as 1, workspaces: {} };
  }
}

/** `tmp + rename`: a crash mid-write leaves the previous ledger intact. */
export function writeLedger(ledger: FactsLedger, file = FACTS_FILE): FactsLedger {
  const canonical: FactsLedger = { v: FACTS_VERSION as 1, workspaces: {} };
  for (const [dir, value] of Object.entries(ledger.workspaces ?? {})) {
    canonical.workspaces[dir] = normalizeWorkspace(value);
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

export function workspaceFacts(workspace: string, file = FACTS_FILE): WorkspaceFacts {
  const key = String(workspace ?? '').trim().replace(/\/+$/, '');
  return readLedger(file).workspaces[key] ?? emptyWorkspace();
}

export function findFact(workspace: string, id: string, file = FACTS_FILE): Fact | undefined {
  return workspaceFacts(workspace, file).facts.find(fact => fact.id === String(id ?? '').trim());
}

export function activeFacts(workspace: string, file = FACTS_FILE): Fact[] {
  return workspaceFacts(workspace, file).facts.filter(fact => fact.state === 'active');
}

export function listFacts(
  workspace: string,
  options: { includeAll?: boolean; state?: string; grade?: string; limit?: number; file?: string } = {}
): Fact[] {
  const ws = workspaceFacts(workspace, options.file);
  const rows = options.includeAll
    ? ws.facts
    : ws.facts.filter(fact => fact.state === (options.state && FACT_STATES.includes(options.state) ? options.state : 'active'));
  return rows
    .filter(fact => (options.grade ? fact.grade === options.grade : true))
    .slice(-Math.max(1, Number(options.limit) || FACT_LIST_MAX));
}

/* ---------------------------------------------------------------- writing */

/** Per-workspace write queue: two tool calls never clobber each other. */
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(workspace: string, fn: () => Promise<T> | T): Promise<T> {
  const key = String(workspace ?? '');
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

function bumpDay(ws: WorkspaceFacts, now: number): FactDayMetrics {
  const day = dayKey(now);
  const current = ws.metrics[day] ?? { settled: 0, retracted: 0, staleDeliveries: 0, reasons: {} };
  // A day record written by an older build may lack the review-added counter.
  if (!Number.isFinite(Number(current.staleDeliveries))) current.staleDeliveries = 0;
  ws.metrics[day] = current;
  return current;
}

/**
 * R3/design §3: `2000` rows is the permanent-ledger bound. Non-active rows go
 * first (oldest first), then the oldest active ones — a ledger that silently
 * grows forever is the failure mode this constant exists to prevent.
 */
function prune(ws: WorkspaceFacts): void {
  if (ws.facts.length <= FACTS_LIMIT) return;
  const rank = (fact: Fact): number => (fact.state === 'active' ? 1 : 0);
  const ordered = [...ws.facts].sort((left, right) => rank(left) - rank(right) || left.at - right.at);
  const drop = new Set(ordered.slice(0, ws.facts.length - FACTS_LIMIT).map(fact => fact.id));
  ws.facts = ws.facts.filter(fact => !drop.has(fact.id));
}

/** Facts cited by `evidence` (an `F3` token) or by an explicit `factIds` list. */
function citedFacts(ws: WorkspaceFacts, evidence: string, factIds: unknown): Fact[] {
  const explicit = Array.isArray(factIds) ? factIds.map(id => String(id).trim()) : [];
  const fromText = [...String(evidence ?? '').matchAll(/\bF(\d+)\b/g)].map(match => `F${match[1]}`);
  const ids = dedupe([...explicit, ...fromText].filter(isFactID));
  return ids.map(id => ws.facts.find(fact => fact.id === id)).filter((fact): fact is Fact => Boolean(fact));
}

/**
 * Reject a citation of a `relayed` / `unknown` fact **before** anything is
 * written: a retransmission is not evidence, and silently accepting it is how a
 * rumour becomes a settled fact (D5/R2). The refusal names the fix.
 */
function guardCitations(ws: WorkspaceFacts, evidence: string, factIds: unknown): string[] {
  const cited = citedFacts(ws, evidence, factIds);
  for (const fact of cited) {
    if (isWeakGrade(fact.grade)) {
      throw invalid(
        `证据 ${fact.id} 的等级是 ${fact.grade}（${fact.grade === 'relayed' ? '转述' : '未标注'}），不能作为 settle 的证据：` +
          `请先把它补成 measured（collab_fact { action:"settle", claim, evidence, grade:"measured" }）。未写入任何事实。`
      );
    }
    // A retracted / superseded fact is not evidence anymore: citing it would
    // resurrect exactly what `invalidate` just propagated.
    if (fact.state !== 'active') {
      throw invalid(
        `证据 ${fact.id} 已是 ${fact.state}（作废/被取代），不能作为新事实的证据：` +
          `请改用当前 active 事实，或重新 measured 一次。未写入任何事实。`
      );
    }
  }
  return cited.map(fact => fact.id);
}

export interface SettleInput {
  workspace: string;
  claim: unknown;
  evidence: unknown;
  grade: unknown;
  factIds?: unknown;
  by?: string;
  now?: number;
  file?: string;
}

export interface SettleResult {
  fact: Fact;
  /** Active facts that an identical claim replaced (design §4: settle overwrites). */
  superseded: string[];
  epoch: number;
}

/**
 * `settle` — register (or re-register) a fact. Validations are deliberately
 * strict and readable: an unlabelled claim is how the ledger fills with
 * un-citable rows.
 */
export function settleFact(input: SettleInput): Promise<SettleResult> {
  const workspace = String(input.workspace ?? '').trim().replace(/\/+$/, '');
  const file = input.file ?? FACTS_FILE;
  // In-process queue per workspace **and** a cross-process file lock around the
  // whole read-modify-write: the ledger is one file per machine, so a queue is
  // not enough (two OpenCode processes would erase each other's workspace).
  return serialize(workspace, () =>
    withFileLock(file, () => {
      const claim = text(input.claim, FACT_CLAIM_LIMIT);
      if (!claim) throw invalid('settle 必填 claim（一句话可证伪的断言）');
      const evidence = text(input.evidence, FACT_EVIDENCE_LIMIT);
      if (!evidence) throw invalid('settle 必填 evidence（文件:行 / 命令 / 复现路径）');
      const gradeRaw = String(input.grade ?? '').trim();
      if (!gradeRaw) throw invalid(`settle 必填 grade（${FACT_SETTLE_GRADES.join(' | ')}）：未标注的事实不可引用`);
      if (!FACT_SETTLE_GRADES.includes(gradeRaw)) {
        throw invalid(`grade="${gradeRaw}" 不合法（${FACT_SETTLE_GRADES.join(' | ')}）`);
      }
      const grade = gradeRaw as FactGrade;
      const now = Number(input.now) || Date.now();
      const ledger = readLedger(file);
      const ws = ledger.workspaces[workspace] ?? emptyWorkspace();
      const cited = guardCitations(ws, evidence, input.factIds);
      const basedOn: FactBasedOn = {
        ...localSnapshot({ workspace, epoch: ws.epoch }),
        ...(cited.length ? { factIds: cited } : {})
      };

      // Same claim = the newer fact replaces the older one (design §4). It is
      // superseded, not retracted: it was true, the wording/evidence moved on.
      const same = ws.facts.filter(fact => fact.state === 'active' && fact.claim === claim);
      const id = `F${Math.max(ws.seq, ...ws.facts.map(fact => factIDNumber(fact.id)), 0) + 1}`;
      for (const fact of same) {
        fact.state = 'superseded';
        fact.supersededBy = id;
        fact.supersededAt = now;
      }
      const fact: Fact = {
        id,
        claim,
        grade,
        evidence,
        state: 'active',
        basedOn,
        by: String(input.by ?? ''),
        at: now,
        supersededBy: null,
        scope: 'workspace'
      };
      ws.facts.push(fact);
      ws.seq = factIDNumber(id);
      prune(ws);
      const metrics = bumpDay(ws, now);
      metrics.settled += 1;
      // Design §5 (review): `retract_count` counts **retract + supersede** — a
      // claim replaced by a newer settle is just as unusable as a retracted one.
      metrics.retracted += same.length;
      ledger.workspaces[workspace] = ws;
      writeLedger(ledger, file);
      return { fact, superseded: same.map(entry => entry.id), epoch: ws.epoch };
    })
  );
}

export interface RetractResult {
  fact: Fact;
  affected: string[];
  metrics: FactDayMetrics;
  epoch: number;
}

/** `retract {id, reason}` — a single fact was wrong (a wrong measurement, a bad probe). */
export function retractFact(input: {
  workspace: string;
  id: unknown;
  reason: unknown;
  by?: string;
  now?: number;
  file?: string;
}): Promise<RetractResult> {
  const workspace = String(input.workspace ?? '').trim().replace(/\/+$/, '');
  const file = input.file ?? FACTS_FILE;
  return serialize(workspace, () =>
    withFileLock(file, () => {
      const id = String(input.id ?? '').trim();
      if (!isFactID(id)) throw invalid(`retract 需要事实 id（F1 / F2 …），收到 "${id}"`);
      const reason = text(input.reason, FACT_REASON_LIMIT);
      if (!reason) throw invalid('retract 必填 reason：没有原因的撤回无法度量（PRD R3）');
      const now = Number(input.now) || Date.now();
      const ledger = readLedger(file);
      const ws = ledger.workspaces[workspace] ?? emptyWorkspace();
      const fact = ws.facts.find(entry => entry.id === id);
      if (!fact) throw invalid(`没有事实 ${id}：用 collab_fact { action:"list", includeAll:true } 查看`);
      if (fact.state === 'retracted') throw invalid(`${id} 已经是 retracted（原因：${fact.retractReason ?? '-'}）`);
      fact.state = 'retracted';
      fact.retractedAt = now;
      fact.retractReason = reason;
      // Review: retracting an already-superseded row must **keep** its
      // `supersededBy` pointer — clearing it turned `[retracted:F2→F4]` into a
      // bare `F2` and lost which fact actually replaced it.
      const metrics = bumpDay(ws, now);
      // Design §5: `retract_count` counts retract **and** supersede; the reason
      // breakdown is what makes a retraction classifiable after the fact.
      metrics.retracted += 1;
      metrics.reasons[reason] = (metrics.reasons[reason] ?? 0) + 1;
      ledger.workspaces[workspace] = ws;
      writeLedger(ledger, file);
      return { fact, affected: [id], metrics, epoch: ws.epoch };
    })
  );
}

/**
 * Facts that (transitively) cite any of `roots`. Explicit edges only — the
 * design's `basedOn.facts <= sinceEpoch` formula is applied by the epoch form
 * of `invalidate`, not here (retracting an unrelated same-era fact would be a
 * silent data loss, see the module comment).
 */
function derivedFrom(ws: WorkspaceFacts, roots: string[]): Fact[] {
  const out = new Set<string>();
  let frontier = [...roots];
  while (frontier.length) {
    const next: string[] = [];
    for (const fact of ws.facts) {
      if (out.has(fact.id) || roots.includes(fact.id)) continue;
      const cites = fact.basedOn.factIds ?? [];
      if (cites.some(id => frontier.includes(id))) {
        out.add(fact.id);
        next.push(fact.id);
      }
    }
    frontier = next;
  }
  return ws.facts.filter(fact => out.has(fact.id));
}

export interface InvalidateResult {
  workspace: string;
  /** The fact (or `epoch:<n>`) the invalidation started from. */
  since: string;
  epoch: number;
  /** Facts that changed state (the root included), `id → state`. */
  changed: Array<{ id: string; state: FactState; supersededBy: string | null }>;
  /** `changed` minus the root — what the injection shows as `F3→F4`. */
  derived: string[];
  /** Todos marked `staleWork` (never closed). */
  staleTodos: string[];
  /** `false` when there was nothing left to invalidate (idempotent no-op). */
  applied: boolean;
}

/**
 * `invalidate {since}` — the world moved: a fact (and everything citing it) is
 * no longer a safe basis, **or** everything settled up to an epoch is stale.
 *
 * Workspace-level propagation (D6): every session in this workspace reads the
 * same ledger, so the next `context` injection carries `[retracted:F3→F4]`
 * without any message being sent.
 */
export function invalidateFacts(input: {
  workspace: string;
  since: unknown;
  by?: string;
  now?: number;
  file?: string;
}): Promise<InvalidateResult> {
  const workspace = String(input.workspace ?? '').trim().replace(/\/+$/, '');
  const file = input.file ?? FACTS_FILE;
  return serialize(workspace, () =>
    withFileLock(file, () => {
      const now = Number(input.now) || Date.now();
      const ledger = readLedger(file);
      const ws = ledger.workspaces[workspace] ?? emptyWorkspace();
      const raw = String(input.since ?? '').trim();
      if (!raw) throw invalid('invalidate 必填 since（事实 id `F3` 或 epoch 数字）');

      let roots: Fact[] = [];
      let sinceLabel = raw;
      if (isFactID(raw)) {
        const root = ws.facts.find(fact => fact.id === raw);
        if (!root) throw invalid(`没有事实 ${raw}：用 collab_fact { action:"list", includeAll:true } 查看`);
        if (root.state !== 'active') {
          return {
            workspace,
            since: raw,
            epoch: ws.epoch,
            changed: [],
            derived: [],
            staleTodos: [],
            applied: false
          };
        }
        roots = [root];
        roots.push(...derivedFrom(ws, [root.id]).filter(fact => fact.state === 'active'));
      } else {
        const epoch = Number(raw);
        if (!Number.isFinite(epoch) || epoch < 0) throw invalid(`since="${raw}" 不合法（事实 id F3 或 epoch 数字）`);
        roots = ws.facts.filter(fact => fact.state === 'active' && fact.basedOn.facts <= epoch);
        sinceLabel = `epoch:${epoch}`;
        if (!roots.length) {
          return {
            workspace,
            since: sinceLabel,
            epoch: ws.epoch,
            changed: [],
            derived: [],
            staleTodos: [],
            applied: false
          };
        }
      }

      const rootIDs = new Set(roots.map(fact => fact.id));
      const rootIsFact = isFactID(sinceLabel) ? sinceLabel : null;
      for (const fact of roots) {
        fact.state = 'superseded';
        fact.supersededAt = now;
        fact.supersededBy = rootIsFact && fact.id !== rootIsFact ? rootIsFact : null;
      }
      ws.epoch += 1;
      const metrics = bumpDay(ws, now);
      metrics.retracted += roots.length;
      const reason = rootIsFact ? `invalidate ${rootIsFact}` : `invalidate ${sinceLabel}`;
      metrics.reasons[reason] = (metrics.reasons[reason] ?? 0) + 1;

      const changed = roots.map(fact => ({ id: fact.id, state: fact.state, supersededBy: fact.supersededBy }));
      const derived = roots.filter(fact => fact.id !== rootIsFact).map(fact => fact.id);
      ledger.workspaces[workspace] = ws;
      writeLedger(ledger, file);

      // R5: in-flight work that cited a now-invalid fact is marked, never closed.
      const staleTodos = markStaleWork(workspace, rootIDs);
      return { workspace, since: sinceLabel, epoch: ws.epoch, changed, derived, staleTodos, applied: true };
    })
  );
}

/**
 * R5: scan the contract files for open todos whose `ref.factId` is one of the
 * invalidated facts and stamp `staleWork: true` (the row stays open; the
 * injection says `⚠失效`). A failure is a log line — the ledger write already
 * succeeded and the next invalidate retries.
 *
 * **Workspace-scoped (review)**: `F1` is a per-workspace id — every workspace
 * starts at `F1`, so matching by id alone marked another workspace's todo
 * `⚠失效` for an unrelated fact. The todo's ref records the workspace it was
 * created in (`collab_todo { action:"add", factId }`), and only a ref from
 * **this** workspace can be marked. A legacy ref without a workspace is left
 * alone (no guessing), which is safe because 0.9.4 is the first build to write
 * refs at all.
 */
function markStaleWork(workspace: string, factIDs: Set<string>): string[] {
  if (!factIDs.size) return [];
  const marked: string[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(CONTRACT_DIR).filter(name => name.endsWith('.json'));
  } catch {
    return []; // no contract directory yet = nothing in flight
  }
  for (const name of files) {
    const sid = basename(name, '.json');
    try {
      const contract = readContract(sid);
      let dirty = false;
      const todos = contract.todos.map(todo => {
        const ref = asObject(asObject(todo).ref);
        const factId = String(ref.factId ?? '');
        const refWorkspace = String(ref.workspace ?? '').trim().replace(/\/+$/, '');
        if (!factId || refWorkspace !== workspace) return todo;
        if (!factIDs.has(factId) || TODO_DONE_STATUSES.includes(todo.status)) return todo;
        if (todo.staleWork) return todo;
        dirty = true;
        marked.push(`${sid}:${todo.id}`);
        return { ...todo, staleWork: true, updatedAt: Date.now() };
      });
      if (dirty) writeContract({ ...contract, todos });
    } catch (error) {
      log(`stale-work scan failed for ${name}: ${(error as Error)?.message ?? error}`);
    }
  }
  return marked;
}

/** One row for `collab_fact list` / the injection. */
export function formatFact(fact: Fact): string {
  const mark = fact.state === 'active' ? '' : ` [${fact.state}${fact.supersededBy ? `→${fact.supersededBy}` : ''}]`;
  const reason = fact.retractReason ? ` · 原因 ${fact.retractReason}` : '';
  return `${fact.id} [${fact.grade}]${mark} ${fact.claim} · ${fact.evidence}${reason}`;
}

/** The injection label of a retraction: `F3→F4` (root → first derived). */
export function retractedLabel(root: string, derived: string[]): string {
  return derived.length ? `${root}→${derived.join(',')}` : root;
}

/** The current day's retract counters (the measurable half of R3). */
export function metricsOf(workspace: string, now = Date.now(), file = FACTS_FILE): FactDayMetrics {
  return (
    workspaceFacts(workspace, file).metrics[dayKey(now)] ?? { settled: 0, retracted: 0, staleDeliveries: 0, reasons: {} }
  );
}

/**
 * 0.9.4 review: count the `stale` messages this workspace actually delivered.
 * The "reply ≤30% of the original" rule is a behavioural convention (the plugin
 * never writes the reply), so the auditable half is the count: a human can
 * sample the deliveries and measure the ratio. Best-effort — a counter failure
 * never fails a model request.
 */
export function noteStaleDeliveries(input: {
  workspace: string;
  count?: number;
  now?: number;
  file?: string;
}): Promise<number> {
  const workspace = String(input.workspace ?? '').trim().replace(/\/+$/, '');
  const count = Math.max(0, Math.trunc(Number(input.count) || 0));
  if (!count) return Promise.resolve(0);
  const file = input.file ?? FACTS_FILE;
  return serialize(workspace, () =>
    withFileLock(file, () => {
      const now = Number(input.now) || Date.now();
      const ledger = readLedger(file);
      const ws = ledger.workspaces[workspace] ?? emptyWorkspace();
      const metrics = bumpDay(ws, now);
      metrics.staleDeliveries += count;
      ledger.workspaces[workspace] = ws;
      writeLedger(ledger, file);
      return metrics.staleDeliveries;
    })
  );
}

/* -------------------------------------------------------------- injection */

export interface FactInjection {
  lines: string[];
  /** Every key represented by the lines — stamped as seen **after** the push. */
  keys: string[];
}

/**
 * The `[settled]` / `[retracted]` lines (each at most one) for this workspace.
 *
 * `seen` is the per-session key set (`collab/facts-seen/<sid>`): a fact is
 * announced once, but every other pending row is marked seen too — showing one
 * stale row per request for ten requests is noise, not memory.
 */
export function factInjection(workspace: string, seen: string[] = [], file = FACTS_FILE): FactInjection {
  const ws = workspaceFacts(workspace, file);
  const known = new Set(seen);
  const byAt = [...ws.facts].sort((left, right) => left.at - right.at);

  const active = byAt.filter(fact => fact.state === 'active' && !known.has(`settled:${fact.id}`));
  const gone = byAt.filter(
    fact =>
      fact.state !== 'active' &&
      !known.has(`retracted:${fact.supersededBy ?? fact.id}`) &&
      !known.has(`retracted:${fact.id}`)
  );

  const lines: string[] = [];
  const keys: string[] = [];
  if (active.length) {
    const newest = active[active.length - 1];
    keys.push(...active.map(fact => `settled:${fact.id}`));
    lines.push(
      `[settled:${newest.id}] ${truncate(newest.claim, 120)}（${newest.grade} · ${truncate(newest.evidence, 80)}）`
    );
  }
  if (gone.length) {
    const newest = gone[gone.length - 1];
    const root = newest.supersededBy ?? newest.id;
    const label = root !== newest.id ? `${root}→${newest.id}` : newest.id;
    keys.push(...gone.map(fact => `retracted:${fact.supersededBy ?? fact.id}`));
    // A derived fact also needs its own key marked, or it reappears next round.
    keys.push(...gone.map(fact => `retracted:${fact.id}`));
    const why = newest.retractReason ? ` · 原因 ${newest.retractReason}` : '';
    const more = gone.length > 1 ? `（另有 ${gone.length - 1} 条作废）` : '';
    lines.push(`[retracted:${label}] ${truncate(newest.claim, 100)}${why}${more}`);
  }
  return { lines, keys };
}

function factsSeenKey(sessionID: string): string {
  return `collab/facts-seen/${sessionID}`;
}

/** Per-session memory of announced facts (survives restarts, same as inbox). */
export async function readFactSeen(
  ctx: { storage?: { get(key: string): Promise<unknown> } } | undefined,
  sessionID: string
): Promise<string[]> {
  const raw = asObject(await ctx?.storage?.get(factsSeenKey(sessionID)));
  return Array.isArray(raw.keys) ? raw.keys.filter((key: unknown): key is string => typeof key === 'string') : [];
}

/** Remember the announced facts. Called **after** the block reached the request. */
export async function markFactSeen(
  ctx: { storage?: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> } } | undefined,
  sessionID: string,
  keys: string[]
): Promise<void> {
  if (!keys.length) return;
  const seen = new Set(await readFactSeen(ctx, sessionID));
  const merged = dedupe([...seen, ...keys]).slice(-200);
  await ctx?.storage?.set(factsSeenKey(sessionID), { keys: merged, updated: Date.now() });
}
