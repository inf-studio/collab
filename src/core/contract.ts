/**
 * 0.9.1 (`11-20-collab-contract`): the **session contract** — the task-level
 * memory that survives compaction.
 *
 * One JSON file per session: `~/.config/opencode/collab-contract/<sid>.json`.
 * Five faces (parent design §4):
 *
 *   mission  mainline anchor (`oneLine` + scope + handoff targets + state)
 *   plan     milestones; `lastAdvancedAt` moves **only** on verified evidence
 *   todos    open / doing / suspended work, with who it is blocked on
 *   peers    sessions this one is collaborating with (display only in 0.9.1)
 *   turn     a per-request counter (what makes `[未收尾]` possible)
 *
 * Rules that matter (and are easy to get wrong):
 *
 *   - **Lazy creation**: `readContract` never writes. A session that never used
 *     a contract tool leaves no file behind (design §3).
 *   - **tmp + rename** on every write: a crash mid-write can never truncate the
 *     previous contract.
 *   - **Merge, never replace**: every field is normalised (junk tolerated,
 *     lengths capped) so a hand-edited file degrades instead of crashing the
 *     model request.
 *   - **No `injected[]`**: the four-section block is re-derived from this file
 *     on **every** request. Persisting "what was already shown" is the 0.5.x
 *     once-only bug this version exists to remove (PRD R5).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CONTRACT_DIR,
  CONTRACT_HANDOFF_ITEMS,
  CONTRACT_MILESTONE_LIMIT,
  CONTRACT_ONE_LINE_LIMIT,
  CONTRACT_SCOPE_CHARS,
  CONTRACT_SCOPE_ITEMS,
  CONTRACT_TODO_KEEP_CLOSED,
  CONTRACT_TODO_SUBJECT_LIMIT,
  CONTRACT_VERSION,
  INJECT_MAX_LINES,
  INJECT_SECTION_LIMITS,
  INJECT_TODO_TOP
} from '../constants.ts';
import { log } from '../log.ts';
import { asObject, dedupe, randToken, truncate } from '../util.ts';
import { normalizeWakeWhen, wakePhrase } from './wake.ts';
import type { WakeWhenValue } from './wake.ts';

export type MissionState = 'active' | 'idle' | 'suspended' | 'done';
export type TodoStatus = 'open' | 'doing' | 'blocked' | 'suspended' | 'drifted' | 'closed' | 'dropped';
export type TodoKind = 'mainline' | 'collab';
export type PeerRole = 'requester' | 'implementer' | 'decider' | 'verifier';

export interface ContractMission {
  /** `.trellis/tasks/<slug>` when a task anchor exists. */
  taskPath?: string;
  /** One line: what this session is for. `''` = not set yet. */
  oneLine: string;
  inScope: string[];
  outOfScope: string[];
  /** Boundary → the session that owns it (the 0.9.2 gate's `handoffTo` advice). */
  handoffTo: Record<string, string>;
  state: MissionState;
  /** Set by the one human confirmation; never overwritten by inference (D7). */
  confirmedBy: string | null;
  confirmedAt: number | null;
  /**
   * 0.9.3 (`collab_mission block`): when the mainline was parked. `parkedHours`
   * drives the "suspended > 2h" drift trigger; `null` = not parked.
   */
  parkedAt?: number | null;
  /** Where `taskPath` / `oneLine` came from — display only. */
  source?: 'pointer' | 'task' | 'first-message' | 'manual' | 'confirm';
}

export interface ContractMilestone {
  /** `M1`, `M2`, … (stable key). */
  id: string;
  title: string;
  done: boolean;
  /** The raw evidence string that lit it (`commit:<sha>` …). */
  evidence?: string;
  at?: number;
}

export interface ContractPlan {
  milestones: ContractMilestone[];
  /** Moves only on a verified `collab_progress` (D20). */
  lastAdvancedAt: number;
}

export interface ContractTodo {
  /** `T1`, `T2`, … (stable key). */
  id: string;
  kind: TodoKind;
  subject: string;
  status: TodoStatus;
  /** `'me'` = blocked on this session; a `ses_…` = waiting on that session. */
  blockingOn: string | null;
  parkedBy?: string | null;
  parkedAt?: number | null;
  /**
   * Required for `status:'suspended'` (R4). 0.9.3 accepts either the structured
   * `{kind, ref|at}` form or the legacy free text 0.9.1 wrote.
   */
  wakeWhen?: WakeWhenValue | null;
  since: number;
  closedAt?: number | null;
  evidence?: string | null;
  /** Last field change — the `[未收尾]` back-reference compares against it. */
  updatedAt?: number;
  /** `defer` pushes the row to the bottom of the list until this moment. */
  deferredUntil?: number | null;
  /** Why it was deferred (one line, display only). */
  deferReason?: string | null;
}

export interface ContractPeer {
  sid: string;
  role: PeerRole;
  threadId?: string | null;
  since: number;
}

export interface ContractTurn {
  /** Requests seen while the contract file existed (incremented unconditionally). */
  count: number;
  /** Start of the previous request (the `[未收尾]` "was there a previous turn" gate). */
  lastAt: number;
  /** Start of the request currently being rendered — `[未收尾]` compares against it. */
  startedAt: number;
  /** Last verified advance (milestone evidence / closed mainline todo). */
  lastAdvancedAt: number;
  /**
   * Consecutive quiet requests, **including the one being stamped** (0.9.3):
   * `1` on the first request / the request right after an advance, otherwise
   * `previous + 1`. Drift reads this value directly (threshold 5).
   */
  noAdvanceTurns: number;
  /**
   * 0.9.3 (R2): when the last `[drift]` was injected and not yet answered by
   * `resume` / `block` / `done`. `0` = nothing unresolved; non-zero makes the
   * next block say `[未处置]` even when the original trigger is gone.
   */
  driftAt?: number;
}

export interface Contract {
  v: 1;
  sid: string;
  updatedAt: number;
  mission: ContractMission;
  plan: ContractPlan;
  todos: ContractTodo[];
  /**
   * Highest `T<n>` ever issued. Closed history is trimmed on read, so the max
   * visible id is **not** a safe source for the next id — this counter is
   * (migration: derived from the raw rows when an old file has no counter).
   */
  todoSeq: number;
  peers: ContractPeer[];
  turn: ContractTurn;
}

export const MISSION_STATES: MissionState[] = ['active', 'idle', 'suspended', 'done'];
export const TODO_STATUSES: TodoStatus[] = ['open', 'doing', 'blocked', 'suspended', 'drifted', 'closed', 'dropped'];
export const TODO_KINDS: TodoKind[] = ['mainline', 'collab'];
export const PEER_ROLES: PeerRole[] = ['requester', 'implementer', 'decider', 'verifier'];
/** Closed / dropped todos are history, not open work. */
export const TODO_DONE_STATUSES: TodoStatus[] = ['closed', 'dropped'];

/* ------------------------------------------------------------------ storage */

/** `<CONTRACT_DIR>/<sid>.json`; the sid is sanitised so a weird id cannot traverse. */
export function contractFile(sessionID: string): string {
  const safe = String(sessionID ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(CONTRACT_DIR, `${safe || 'unknown'}.json`);
}

export function contractExists(sessionID: string): boolean {
  return existsSync(contractFile(sessionID));
}

export function emptyContract(sessionID: string): Contract {
  return {
    v: CONTRACT_VERSION as 1,
    sid: String(sessionID ?? ''),
    updatedAt: 0,
    mission: {
      oneLine: '',
      inScope: [],
      outOfScope: [],
      handoffTo: {},
      state: 'active',
      confirmedBy: null,
      confirmedAt: null
    },
    plan: { milestones: [], lastAdvancedAt: 0 },
    todos: [],
    todoSeq: 0,
    peers: [],
    turn: { count: 0, lastAt: 0, startedAt: 0, lastAdvancedAt: 0, noAdvanceTurns: 0, driftAt: 0 }
  };
}

const text = (value: unknown, max: number): string => truncate(value, max);
const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** A list of one-line keywords: non-empty, deduped, capped in count and length. */
function normalizeList(value: unknown, maxItems: number, maxChars: number): string[] {
  const list = Array.isArray(value) ? value : [];
  return dedupe(list.map(item => text(item, maxChars)).filter(Boolean)).slice(0, maxItems);
}

function normalizeMap(value: unknown): Record<string, string> {
  const raw = asObject(value);
  const out: Record<string, string> = {};
  for (const [key, target] of Object.entries(raw).slice(0, CONTRACT_HANDOFF_ITEMS)) {
    const name = text(key, CONTRACT_SCOPE_CHARS);
    const sid = String(target ?? '').trim();
    if (name && sid) out[name] = sid;
  }
  return out;
}

function normalizeMission(raw: unknown): ContractMission {
  const value = asObject(raw);
  const taskPath = String(value.taskPath ?? '').trim();
  const state = MISSION_STATES.includes(String(value.state) as MissionState)
    ? (String(value.state) as MissionState)
    : 'active';
  const confirmedBy = String(value.confirmedBy ?? '').trim();
  const confirmedAt = num(value.confirmedAt);
  const parkedAt = num(value.parkedAt);
  return {
    ...(taskPath ? { taskPath } : {}),
    oneLine: text(value.oneLine, CONTRACT_ONE_LINE_LIMIT),
    inScope: normalizeList(value.inScope, CONTRACT_SCOPE_ITEMS, CONTRACT_SCOPE_CHARS),
    outOfScope: normalizeList(value.outOfScope, CONTRACT_SCOPE_ITEMS, CONTRACT_SCOPE_CHARS),
    handoffTo: normalizeMap(value.handoffTo),
    state,
    // A park stamp only means something while the mission is suspended.
    parkedAt: state === 'suspended' && parkedAt ? parkedAt : null,
    confirmedBy: confirmedBy || null,
    // A name without a stamp (or the reverse) is a hand edit: keep them paired.
    confirmedAt: confirmedBy && confirmedAt ? confirmedAt : null,
    ...(confirmedBy ? { source: 'confirm' as const } : value.source ? { source: String(value.source) as ContractMission['source'] } : {})
  };
}

function normalizePlan(raw: unknown): ContractPlan {
  const value = asObject(raw);
  const milestones = (Array.isArray(value.milestones) ? value.milestones : [])
    .map(item => {
      const entry = asObject(item);
      const id = text(entry.id, 20);
      if (!id) return undefined;
      const milestone: ContractMilestone = {
        id,
        title: text(entry.title, 120) || id,
        done: entry.done === true
      };
      const evidence = text(entry.evidence, 300);
      const at = num(entry.at);
      if (evidence) milestone.evidence = evidence;
      if (at) milestone.at = at;
      return milestone;
    })
    .filter((item): item is ContractMilestone => Boolean(item))
    .slice(0, CONTRACT_MILESTONE_LIMIT);
  return { milestones, lastAdvancedAt: num(value.lastAdvancedAt) };
}

function normalizeTodo(raw: unknown): ContractTodo | undefined {
  const value = asObject(raw);
  const id = text(value.id, 20);
  if (!id) return undefined;
  const status = TODO_STATUSES.includes(String(value.status) as TodoStatus)
    ? (String(value.status) as TodoStatus)
    : 'open';
  const blocking = String(value.blockingOn ?? '').trim();
  const kind = TODO_KINDS.includes(String(value.kind) as TodoKind) ? (String(value.kind) as TodoKind) : 'mainline';
  return {
    id,
    kind,
    subject: text(value.subject, CONTRACT_TODO_SUBJECT_LIMIT),
    status,
    blockingOn: blocking || null,
    parkedBy: value.parkedBy ? text(value.parkedBy, 120) : null,
    parkedAt: num(value.parkedAt) || null,
    wakeWhen: normalizeWakeWhen(value.wakeWhen),
    since: num(value.since) || Date.now(),
    closedAt: num(value.closedAt) || null,
    evidence: value.evidence ? text(value.evidence, 300) : null,
    updatedAt: num(value.updatedAt) || num(value.since) || Date.now(),
    deferredUntil: num(value.deferredUntil) || null,
    deferReason: value.deferReason ? text(value.deferReason, 200) : null
  };
}

function normalizePeers(raw: unknown): ContractPeer[] {
  return (Array.isArray(raw) ? raw : [])
    .map((item): ContractPeer | undefined => {
      const value = asObject(item);
      const sid = String(value.sid ?? '').trim();
      if (!sid) return undefined;
      const role = PEER_ROLES.includes(String(value.role) as PeerRole)
        ? (String(value.role) as PeerRole)
        : 'requester';
      return {
        sid,
        role,
        threadId: value.threadId ? String(value.threadId) : null,
        since: num(value.since) || Date.now()
      };
    })
    .filter((item): item is ContractPeer => Boolean(item))
    .slice(0, 50);
}

/** `T12` → 12; anything else → 0. */
export function todoSeqOf(id: unknown): number {
  const match = /^T(\d+)$/.exec(String(id ?? '').trim());
  return match ? Number(match[1]) : 0;
}

/** Highest `T<n>` in a raw list (before closed-history trimming). */
export function maxTodoSeq(todos: ContractTodo[]): number {
  return todos.reduce((max, todo) => Math.max(max, todoSeqOf(todo.id)), 0);
}

/**
 * The next `T<n>`. Derived from `todoSeq` (highest ever issued) **and** the
 * visible rows, because closed history is trimmed on read — max(visible) alone
 * would reuse an id that a trimmed row already had.
 *
 * Lives here (not in a tool) because both `collab_todo add` and
 * `collab_mission resume` may create a row, and there is exactly one id rule.
 */
export function nextTodoSeq(contract: Contract): number {
  return Math.max(Number(contract.todoSeq) || 0, maxTodoSeq(contract.todos)) + 1;
}

/** Duplicate ids can exist in files written by the pre-review bug: last wins. */
function dedupeTodos(todos: ContractTodo[]): ContractTodo[] {
  const byID = new Map<string, ContractTodo>();
  for (const todo of todos) byID.set(todo.id, todo);
  return [...byID.values()];
}

/**
 * Read-side retention: **every** active row survives; only `closed` / `dropped`
 * history is trimmed to the most recent `CONTRACT_TODO_KEEP_CLOSED`.
 *
 * A total-row `slice(0, 50)` used to drop freshly added open rows (add reported
 * success, every reader missed the row, the next id was reused and overwrote
 * it). Retention must never be able to hide a write.
 */
export function keepTodos(todos: ContractTodo[]): ContractTodo[] {
  const closed = todos.filter(todo => TODO_DONE_STATUSES.includes(todo.status));
  const recent = new Set(
    [...closed]
      .sort(
        (a, b) =>
          (Number(b.closedAt ?? b.updatedAt ?? b.since) || 0) -
          (Number(a.closedAt ?? a.updatedAt ?? a.since) || 0)
      )
      .slice(0, CONTRACT_TODO_KEEP_CLOSED)
      .map(todo => todo.id)
  );
  return todos.filter(todo => !TODO_DONE_STATUSES.includes(todo.status) || recent.has(todo.id));
}

/** Tolerant read: junk fields are dropped, a wrong `v` is treated as empty. */
export function normalizeContract(raw: unknown, sessionID: string): Contract {
  const value = asObject(raw);
  const base = emptyContract(sessionID);
  const version = Number(value.v);
  if (value.sid && String(value.sid) !== String(sessionID)) return base;
  if (version && version !== CONTRACT_VERSION) return base;
  const turn = asObject(value.turn);
  const rawTodos = (Array.isArray(value.todos) ? value.todos : [])
    .map(normalizeTodo)
    .filter((item): item is ContractTodo => Boolean(item));
  return {
    v: CONTRACT_VERSION as 1,
    sid: String(sessionID ?? ''),
    updatedAt: num(value.updatedAt),
    mission: normalizeMission(value.mission),
    plan: normalizePlan(value.plan),
    todos: keepTodos(dedupeTodos(rawTodos)),
    // Derived from the **raw** rows, so trimming old closed history on read can
    // never make the next add reuse an id that was already issued.
    todoSeq: Math.max(num(value.todoSeq), maxTodoSeq(rawTodos)),
    peers: normalizePeers(value.peers),
    turn: {
      count: num(turn.count),
      lastAt: num(turn.lastAt),
      startedAt: num(turn.startedAt),
      lastAdvancedAt: num(turn.lastAdvancedAt),
      noAdvanceTurns: num(turn.noAdvanceTurns),
      driftAt: num(turn.driftAt)
    }
  };
}

/** Read-only: missing / unreadable / wrong-version files all return an empty contract. */
export function readContract(sessionID: string): Contract {
  const file = contractFile(sessionID);
  if (!existsSync(file)) return emptyContract(sessionID);
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return normalizeContract(raw, sessionID);
  } catch (error) {
    log(`ignoring unreadable contract ${file}: ${(error as Error)?.message ?? error}`);
    return emptyContract(sessionID);
  }
}

/**
 * tmp + rename: a crash mid-write leaves the previous contract intact.
 *
 * The value is **normalised before writing and returned in that shape**, so the
 * object a tool gets back is exactly what every reader will see. `collab_todo
 * add` relies on this to assert its new row is readable (never a silent drop).
 */
export function writeContract(contract: Contract): Contract {
  const canonical = normalizeContract({ ...contract, v: CONTRACT_VERSION as 1 }, contract.sid);
  const next: Contract = { ...canonical, v: CONTRACT_VERSION as 1, updatedAt: Date.now() };
  const file = contractFile(next.sid);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randToken()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
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
  return next;
}

/* --------------------------------------------------------------- serialising */

/** Per-session queue: two tool calls / the hook never clobber each other. */
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(sessionID: string, fn: () => Promise<T> | T): Promise<T> {
  const key = String(sessionID ?? '');
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

/** Read → mutate → write, serialised. Always creates the file (a writing call). */
export function updateContract(
  sessionID: string,
  mutate: (current: Contract) => Contract | undefined | void
): Promise<Contract> {
  return serialize(sessionID, () => {
    const current = readContract(sessionID);
    const next = mutate(current) ?? current;
    return writeContract(next);
  });
}

/**
 * The context hook's path: stamp the turn counter **only when a contract file
 * already exists**. A read of a session that never used a contract tool must not
 * create one (lazy creation, design §3), and a session with no todos has nothing
 * for `[未收尾]` to compare — so there is no per-request disk write either.
 */
export function updateContractIfExists(
  sessionID: string,
  mutate: (current: Contract) => Contract | undefined | void
): Promise<Contract | undefined> {
  return serialize(sessionID, () => {
    if (!existsSync(contractFile(sessionID))) return undefined;
    const current = readContract(sessionID);
    const next = mutate(current) ?? current;
    return writeContract(next);
  });
}

/* ---------------------------------------------------------------- derivation */

/** `3.1h` / `12m` / `2.4d` — the compact age used by the injection. */
export function formatAge(ms: number): string {
  const value = Math.max(0, Number(ms) || 0);
  const minutes = value / 60_000;
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
  const days = hours / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}d`;
}

/** Open = everything that is neither `closed` nor `dropped`. */
export function openTodos(contract: Contract): ContractTodo[] {
  return contract.todos.filter(todo => !TODO_DONE_STATUSES.includes(todo.status));
}

/**
 * The todos that were already `doing` before **this** request started — the
 * honest 0.9.1 version of "idle 前未收尾" (there is no idle hook; design §7).
 *
 * The comparison uses the **current** request's start (`startedAt`, passed by
 * the hook), not the previous turn's stamp: a todo created mid-previous-request
 * has `updatedAt` *after* that request's start but *before* this one, so it is
 * marked on the next turn (the two-round sequence in the test).
 *
 * `<=` rather than `<`: timestamps are milliseconds, so a create + two requests
 * can share one tick (observed as a flaky test). Marking a doing todo that is
 * exactly as old as this request's start is the intended "not touched this
 * turn" semantics; the rendering happens before tool calls, so a todo created
 * *during* this turn is not in this block at all.
 *
 * `lastAt > 0` is the "a previous request really happened" gate: a `doing` todo
 * created before the first request was never left behind by a turn, so it is not
 * marked yet.
 */
export function unfinishedTodos(contract: Contract, startedAt?: number): string[] {
  const previousStart = Number(contract.turn?.lastAt) || 0;
  const start = Number(startedAt) || Number(contract.turn?.startedAt) || 0;
  if (!previousStart || !start) return [];
  return contract.todos
    .filter(todo => todo.status === 'doing')
    .filter(todo => (Number(todo.updatedAt ?? todo.since) || 0) <= start)
    .map(todo => todo.id);
}

/**
 * Stamp one request. Called **unconditionally** whenever the contract file
 * exists (a mission-only or milestone-only contract still needs a turn count —
 * 0.9.3's drift check must not start from 0 forever).
 *
 * `noAdvanceTurns` is the number of consecutive **quiet** requests, counting the
 * one being stamped (its own tool calls have not happened yet, so at stamp time
 * it has produced no evidence):
 *
 *   first request of the contract          → 1
 *   the previous request verified an advance → 1 (this one is the first quiet)
 *   otherwise                              → previous + 1
 *
 * `advancedLastTurn` is `lastAdvancedAt >= previousStart` (`>=` mirrors
 * `[未收尾]`'s `updatedAt <= 本轮开始`: a light and the request start can share
 * one millisecond).
 *
 * The "previous request advanced → 1, not 0" rule is what keeps the counter
 * aligned after an advance: resetting to 0 made drift fire one request late
 * (drift reads the stamped value directly, without a second `+1`).
 */
export function stampTurn(contract: Contract, now = Date.now()): Contract {
  const previousStart = Number(contract.turn?.lastAt) || 0;
  const lastAdvancedAt = Number(contract.turn?.lastAdvancedAt) || 0;
  const previousNoAdvance = Number(contract.turn?.noAdvanceTurns) || 0;
  const advancedLastTurn = previousStart > 0 && lastAdvancedAt >= previousStart;
  const noAdvanceTurns = advancedLastTurn ? 1 : previousNoAdvance + 1;
  return {
    ...contract,
    turn: {
      ...contract.turn,
      count: (Number(contract.turn?.count) || 0) + 1,
      lastAt: now,
      startedAt: now,
      noAdvanceTurns
    }
  };
}

/** The mission as the injection / `get` should show it. */
export function effectiveMission(
  contract: Contract,
  hint?: { taskPath?: string; oneLine?: string }
): ContractMission {
  const mission = contract.mission;
  if (mission.confirmedBy || mission.oneLine.trim()) return mission;
  if (hint?.taskPath) {
    return {
      ...mission,
      taskPath: hint.taskPath,
      oneLine: hint.oneLine ? text(hint.oneLine, CONTRACT_ONE_LINE_LIMIT) : '',
      source: 'task'
    };
  }
  return mission;
}

/* ----------------------------------------------------------------- rendering */

export interface RenderInput {
  contract: Contract;
  /** Effective mission (`effectiveMission`), not necessarily the stored one. */
  mission: ContractMission;
  /**
   * The resolved mission anchor. `source:'ambiguous'` (2+ in_progress tasks) is
   * shown **inside `[mission]`** — an unselected anchor is not guessed, and an
   * empty mission must say *why* it is empty.
   */
  anchor?: { source: string; candidates?: string[] };
  unfinished?: string[];
  /** 0.9.3 (`core/drift.ts`): the `[drift]` section; empty when not triggered. */
  drift?: string[];
  now?: number;
  /**
   * Line budget for the whole block. Defaults to `INJECT_MAX_LINES`; the
   * truncation test lowers it, because the four per-section caps (3+4+2+2 = 11)
   * can never exceed the production budget of 12 on their own.
   */
  maxLines?: number;
}

export interface RenderResult {
  lines: string[];
  sections: string[];
  /** Sections dropped because they no longer fit in `INJECT_MAX_LINES`. */
  dropped: string[];
}

function missionLines(
  mission: ContractMission,
  contract: Contract,
  now: number,
  anchor?: { source: string; candidates?: string[] }
): string[] {
  const ambiguous = anchor?.source === 'ambiguous' && !mission.confirmedBy && !mission.oneLine.trim();
  const candidates = anchor?.candidates ?? [];
  const head = ambiguous
    ? `未设置（有 ${candidates.length} 个进行中任务，未选定；不猜）`
    : mission.oneLine.trim() || '未设置（collab_mission { action:"set", oneLine }）';
  const path = mission.taskPath ? ` · ${mission.taskPath}` : '';
  const flag = mission.confirmedBy ? '' : ' [未确认]';
  const lines = [`[mission] ${head}${path}${flag}`];

  const bits: string[] = [];
  if (mission.inScope.length) bits.push(`做 ${mission.inScope.join(' / ')}`);
  if (mission.outOfScope.length) bits.push(`不做 ${mission.outOfScope.join(' / ')}`);
  const parkedAt = Number(mission.parkedAt) || 0;
  bits.push(
    mission.state === 'suspended' && parkedAt
      ? `状态 suspended（${formatAge(now - parkedAt)} 未醒）`
      : `状态 ${mission.state}`
  );
  const lastAdvanced = Number(contract.plan?.lastAdvancedAt) || 0;
  if (lastAdvanced) bits.push(`推进于 ${formatAge(now - lastAdvanced)} 前`);
  lines.push(`  边界: ${bits.join(' · ')}`);

  if (ambiguous) {
    const first = candidates[0] ?? '.trellis/tasks/<slug>';
    lines.push(`  选定: collab_mission { action:"set", taskPath:"${first}" } 后再 confirm（2+ 进行中任务不猜）`);
  } else if (!mission.confirmedBy) {
    lines.push('  确认: collab_mission { action:"confirm", by:"<你>" }');
  }
  return lines;
}

const mine = (todo: ContractTodo): boolean => todo.blockingOn === 'me';
const waiting = (todo: ContractTodo): boolean => Boolean(todo.blockingOn) && todo.blockingOn !== 'me';

function todoTarget(todo: ContractTodo, now: number): string {
  if (todo.status === 'suspended') {
    return todo.wakeWhen ? `suspended(${wakePhrase(todo.wakeWhen)})` : 'suspended（缺 wakeWhen）';
  }
  if (todo.status === 'drifted') return '挂起到期 → 需重新评估';
  if (todo.status === 'blocked') return todo.blockingOn && todo.blockingOn !== 'me' ? `阻塞 → 等 ${todo.blockingOn.slice(0, 12)}…` : '阻塞';
  if (mine(todo)) return '需要你';
  if (waiting(todo)) return `等 ${String(todo.blockingOn).slice(0, 12)}…`;
  if (todo.deferredUntil && todo.deferredUntil > now) return `推迟至 ${new Date(todo.deferredUntil).toISOString().slice(5, 16)}`;
  return '可执行';
}

function todoLines(contract: Contract, unfinished: Set<string>, now: number): string[] {
  const open = openTodos(contract);
  if (!open.length) return [];
  const needsMe = open.filter(mine).length;
  const waitingCount = open.filter(waiting).length;
  const oldest = [...open].sort((a, b) => a.since - b.since)[0];
  const hidden = Math.max(0, open.length - INJECT_TODO_TOP);
  const header =
    `[todo] ${open.length} open · ${needsMe} 需要你 · ${waitingCount} 等对方` +
    ` · 最老 ${oldest.id} ${formatAge(now - oldest.since)}` +
    (hidden ? ` · 还有 ${hidden} 条` : '');
  const rank = (todo: ContractTodo): number => (todo.deferredUntil && todo.deferredUntil > now ? 2 : mine(todo) ? 0 : 1);
  const sorted = [...open].sort((a, b) => rank(a) - rank(b) || a.since - b.since);
  const items = sorted.slice(0, INJECT_TODO_TOP).map(todo => {
    const mark = unfinished.has(todo.id) ? ' [未收尾]' : '';
    return `  ${todo.id} ${truncate(todo.subject, 80)} → ${todoTarget(todo, now)}${mark}`;
  });
  return [header, ...items];
}

function progressLines(contract: Contract): string[] {
  const milestones = contract.plan?.milestones ?? [];
  if (!milestones.length) {
    return ['[progress] 未设置里程碑（collab_progress { action:"add", milestone:"M1", title:"…" }）'];
  }
  const done = milestones.filter(milestone => milestone.done).length;
  const pending = milestones.filter(milestone => !milestone.done);
  if (!pending.length) return [`[progress] ${done}/${milestones.length} 全部里程碑已完成`];
  const next = pending[0];
  const lines = [`[progress] ${done}/${milestones.length} · 下一里程碑 ${next.id}「${truncate(next.title, 60)}」需要 evidence`];
  const after = pending.slice(1, 3);
  if (after.length) {
    lines.push(`  后续: ${after.map(milestone => `${milestone.id}「${truncate(milestone.title, 40)}」`).join(' · ')}`);
  }
  return lines;
}

/**
 * The four-section block. **Pure**: rebuild it from the contract on every call
 * (never from "what was already injected") and stop at 12 lines.
 *
 * Order is fixed by the design (§6): mission → todo → drift → progress. (The
 * 0.9.1 `[scope]` section is gone in 0.9.2 together with its keyword matcher:
 * the session states its own boundary on `collab_accept` instead.)
 * A section that does not fit is dropped whole and later sections are not
 * attempted — a half-rendered `[todo]` would read as if the list were complete.
 */
export function renderInjection(input: RenderInput): RenderResult {
  const now = input.now ?? Date.now();
  const maxLines = Math.max(1, Number(input.maxLines) || INJECT_MAX_LINES);
  const unfinished = new Set(input.unfinished ?? []);
  const sections: Array<{ name: keyof typeof INJECT_SECTION_LIMITS; lines: string[] }> = [
    { name: 'mission', lines: missionLines(input.mission, input.contract, now, input.anchor) },
    { name: 'todo', lines: todoLines(input.contract, unfinished, now) },
    { name: 'drift', lines: (input.drift ?? []).map(line => String(line ?? '')).filter(Boolean) },
    { name: 'progress', lines: progressLines(input.contract) }
  ];

  const lines: string[] = [];
  const rendered: string[] = [];
  const dropped: string[] = [];
  for (const section of sections) {
    const capped = section.lines
      .slice(0, INJECT_SECTION_LIMITS[section.name])
      .filter(line => line.trim().length > 0);
    if (!capped.length) continue;
    if (lines.length + capped.length > maxLines) {
      dropped.push(section.name);
      break;
    }
    lines.push(...capped);
    rendered.push(section.name);
  }
  return { lines, sections: rendered, dropped };
}
