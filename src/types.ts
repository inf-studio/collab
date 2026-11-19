/**
 * The subset of the OpenCode v2 plugin host contract this plugin relies on.
 *
 * These interfaces mirror the observable shapes of `@opencode/plugin@2.3.0`
 * (`dist/promise/plugin.d.ts` → `Context`, plus the `session` / `storage` /
 * `tool` / `event` domains). They are declared locally on purpose:
 *
 *   - the package must stay usable from a plain `node` process (the harness
 *     imports the built `dist/index.js` directly, no host install), and
 *     importing the host package at runtime would pull `effect` + the whole
 *     `@opencode/schema` tree into a plugin that must remain dependency-free;
 *   - the plugin reads a few optional fields (e.g. `session.context({limit})`,
 *     `location.directory` on list entries) that older hosts may omit, so the
 *     local types describe what we actually tolerate rather than a strict
 *     version.
 *
 * `index.ts` types the exported plugin as `Plugin.Plugin` from
 * `@opencode/plugin` (type-only import), so a signature drift is a typecheck
 * error there; the single cast to `CollabContext` happens once, in `setup`.
 */

export interface SessionLocationInfo {
  directory?: string;
  workspace?: string;
}

export interface SessionTimeInfo {
  created?: number;
  updated?: number;
  /** `archived` is a timestamp on the wire; truthiness is what the host uses. */
  archived?: number | boolean;
  busy?: number;
  idle?: number;
}

export interface SessionInfoLike {
  id: string;
  agent?: string;
  title?: string;
  /** Ancestor pointer used by the lineage guard (both spellings are seen). */
  parentID?: string;
  parentId?: string;
  permissions?: unknown;
  metadata?: Record<string, unknown>;
  location?: SessionLocationInfo;
  time?: SessionTimeInfo;
}

/** `ctx.session.list()` returns `{data}` on the current host, a bare array on older ones. */
export type SessionListResult = SessionInfoLike[] | { data?: SessionInfoLike[] };

export interface MessageBlockLike {
  type?: string;
  text?: string;
  name?: string;
  cid?: string;
  id?: string;
  input?: unknown;
  state?: { input?: unknown };
  [key: string]: unknown;
}

export interface SessionMessageLike {
  id?: string;
  type?: string;
  role?: string;
  text?: string;
  time?: { created?: number; completed?: number };
  content?: Array<MessageBlockLike | string>;
  parts?: Array<MessageBlockLike | string>;
  snapshot?: { files?: unknown[] };
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export type SessionContextResult = SessionMessageLike[] | { data?: SessionMessageLike[] };

export interface SessionPromptInput {
  sessionID: string;
  text: string;
  delivery: string;
  metadata?: Record<string, unknown>;
}

export interface SessionPromptResult {
  id?: string;
  delivery?: string;
}

export interface StorageDomain {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
  remove?(key: string): Promise<unknown>;
}

export interface SessionDomain {
  get(input: { sessionID: string }): Promise<SessionInfoLike>;
  list(input?: { limit?: number; directory?: string }): Promise<SessionListResult>;
  /** `GET /api/session/{sid}/context` — the plugin-side message history. */
  context(input: { sessionID: string; limit?: number }): Promise<SessionContextResult>;
  create(input: {
    title?: string;
    agent?: string;
    location?: { directory: string };
  }): Promise<SessionInfoLike | { data?: SessionInfoLike }>;
  remove(input: { sessionID: string }): Promise<unknown>;
  prompt(input: SessionPromptInput): Promise<SessionPromptResult>;
  /** Resolves once the session's agent loop is idle. */
  wait(input: { sessionID: string }): Promise<unknown>;
  /** Not present on every host version (see `patchSessionPermissions`). */
  update?(input: {
    sessionID: string;
    permissions?: unknown;
    title?: string;
    metadata?: unknown;
    archived?: boolean;
  }): Promise<unknown>;
  /** `POST /api/session/{id}/agent`; optional for the same reason as `update`. */
  switchAgent?(input: { sessionID: string; agent: string }): Promise<unknown>;
  hook(name: string, callback: (event: ContextHookEvent) => Promise<void> | void): Promise<Disposable | void>;
}

export interface ToolDefinitionLike {
  name: string;
  description: string;
  input: Record<string, unknown>;
}

export interface ToolEditor {
  add(definition: ToolDefinition): void;
}

export interface ToolDomain {
  transform(callback: (editor: ToolEditor) => void): Promise<Disposable | void>;
}

export interface EventDomain {
  subscribe(input: { types: string[]; signal?: AbortSignal }): AsyncIterable<unknown>;
}

export interface CollabContext {
  location?: SessionLocationInfo;
  options?: unknown;
  storage: StorageDomain;
  session: SessionDomain;
  tool: ToolDomain;
  event: EventDomain;
}

export interface Disposable {
  dispose?: () => void | Promise<void>;
}

/** A `context` hook payload (`ctx.session.hook("context", …)`). */
export interface ContextHookEvent {
  sessionID?: string;
  agent?: string;
  system?: Array<{ type: string; text: string }>;
  messages?: unknown[];
}

/** Tool execution context handed to every `execute(input, context)`. */
export interface ToolContext {
  sessionID?: string;
  agent?: string;
}

export interface ToolResult {
  content: string;
}

export interface ToolDefinition extends ToolDefinitionLike {
  execute: (input: any, context: ToolContext) => Promise<ToolResult>;
}

export type JsonObject = Record<string, any>;

/** `Permission.Rule` (`{action, resource, effect}`), as stored on a session. */
export interface PermissionRule {
  action: string;
  resource: string;
  effect: string;
}

/** The permission half + agent half of one session's grant ledger file. */
export interface GrantRecord {
  sid: string;
  before?: PermissionRule[];
  added?: string[];
  at?: number;
  by?: string;
  reason?: string;
  agentBefore?: string;
  promotedAt?: number;
  promotedBy?: string;
  [key: string]: any;
}

export type BroadcastState = 'open' | 'claimed' | 'acked' | 'done' | 'blocked' | 'expired';

export interface BroadcastCandidate {
  sid: string;
  score: number;
  why: string[];
}

export interface BroadcastClaim {
  by?: string;
  kind?: string;
  token?: string;
  at?: number;
  leaseMs?: number;
  spawner?: string;
  claimBy?: string;
  [key: string]: any;
}

/**
 * R1/R2 (0.1.6): delivery + acknowledgement of one hand-off's **takeover
 * message**. One record tracks one message (`cid`), which stays the same across
 * a resend so the receiving side's `extractInbound` de-duplication keeps working.
 */
export interface BroadcastDelivery {
  /** Correlation id of the takeover message (`c_…`) — the id an `[ack]` names. */
  cid?: string;
  /** Session the message was/is delivered to (ask target, spawn, local claimant). */
  to?: string;
  /** `session.prompt` admission receipt (`message.id`), when a prompt really went out. */
  messageId?: string;
  /** When the hand-off became the target's job (record write or prompt admission). */
  admittedAt?: number;
  /** Admission failure (the prompt threw) — retryable once. */
  failedAt?: number;
  /** Last delivery attempt (admission, wake or resend) — the `unacked` clock. */
  lastAttemptAt?: number;
  /** First time the receiving plugin confirmed it surfaced the message (`[ack]`). */
  seenAt?: number;
  /** Receiving-side stamp: an ack was already sent for this `cid`. */
  ackSentAt?: number;
  ackSentBy?: string;
  /** 0..1 — one resend at most (`MAX_RESENDS`). */
  resends?: number;
  /** No `seen` after the resend budget + window: surfaced by `collab_list`. */
  unacked?: boolean;
  /**
   * R4: no ack can ever come back — the requester is on the protect list (a
   * pushed ack is refused there). Never retried, never reported as an error.
   */
  ackUnavailable?: boolean;
  [key: string]: any;
}

/**
 * R5 (0.1.6): one post-closure append — **structure only** (`{ bid, issuePath,
 * at, by }`). The conclusion itself goes into the proposal file; storing free
 * text here would let any session write arbitrary words into a protected
 * session's context.
 */
export interface BroadcastFollowUp {
  bid?: string;
  issuePath?: string;
  at?: number;
  by?: string;
}

/** One hand-off record (`~/.config/opencode/collab-broadcast/<bid>.json`). */
export interface BroadcastRecord {
  bid: string;
  scope?: 'local' | 'peer';
  state?: BroadcastState;
  workspace?: string;
  issuePath?: string;
  threadID?: string;
  title?: string;
  expected?: string;
  slug?: string;
  affectedFiles?: string[];
  candidates?: BroadcastCandidate[];
  asked?: { sid?: string; at?: number; leaseMs?: number };
  claim?: BroadcastClaim;
  replies?: Array<{ from?: string; at?: number; text?: string }>;
  seenBy?: string[];
  askSeen?: string[];
  reminded?: string[];
  skipped?: string[];
  declines?: Array<{ sid: string; at: number }>;
  attempts?: number;
  from?: { sid?: string; directory?: string };
  /**
   * R8: last time the requester looked at an `acked` claimant's answer and found
   * no verdict. Stamped so a reminder-less refresh does not re-read the
   * counterpart's history every single turn; cleared by nothing else.
   */
  staleNoticedAt?: number;
  /**
   * How the receiving side reports back:
   *   `push` (default, absent on old records) — `collab_send` a `[handoff]`
   *   receipt to the requester;
   *   `pull` — the requester is on the protect list, so nothing can be pushed
   *   to it: the claimant writes the `[handoff]` line in its own last answer and
   *   the requester extracts it once the lease lapses.
   */
  receiptMode?: 'push' | 'pull';
  receipt?: { from?: string; by?: string; at?: number; note?: string; auto?: boolean; source?: 'kind' | 'body' };
  /**
   * R1/R2 (0.1.6): delivery + ack of the takeover message. Absent on records
   * written by ≤0.1.5 — those are treated as "already admitted, no ack
   * capability" and are never resent.
   */
  delivery?: BroadcastDelivery;
  /**
   * R5 (0.1.6): conclusions appended **after** the hand-off closed (24h
   * window). `state` / `receipt` stay exactly as they were.
   */
  followUps?: BroadcastFollowUp[];
  /**
   * 0.6.0 (`collab_escalate`): this hand-off was escalated as urgent. The four
   * fields are **additive annotations** — `state` / `claim` / `receipt` are
   * never touched by an escalation, and the mark is never auto-revoked (a
   * closed record simply stops being rendered as `[urgent]`).
   */
  priority?: 'urgent';
  /** Last time this hand-off was escalated (`collab_escalate` refreshes it on a repeat). */
  urgentAt?: number;
  /** Why it was escalated (≤200 chars, control characters stripped). */
  urgentReason?: string;
  /** Who escalated it (session id of the caller). */
  urgentBy?: string;
  /**
   * 0.5.0: when the spawned session of this record was archived
   * (`PATCH /api/session/{sid} { archived:true }`). Written **after** the host
   * accepted the write, so its presence is the idempotency marker: an archived
   * record is never PATCHed again. Archiving is reversible — `archived:false`
   * clears this field (see `collab_archive { restore:true }`) — and never
   * touches `state` / `receipt` (`archived ≠ deleted`).
   */
  archivedAt?: number;
  createdAt?: number;
  updatedAt?: number;
  [key: string]: any;
}

// ------------------------------------------------------- owner queue (0.4.0)

/**
 * One item of the protected-target review queue
 * (`~/.config/opencode/collab-owner-queue/<targetSid>/<id>.json`).
 *
 * A **pull** note, never a delivery: no prompt, no inbox entry, no bid. The
 * target session sees `summary` (its own sender's words, ≤500 chars, control
 * characters stripped) as one read-only line in its own `context` injection.
 */
export interface OwnerQueueItem {
  /** `q_<base36ts>_<rand4>`. */
  id: string;
  /** The `[protected]` / `[protected-child]` session this item is for. */
  target: string;
  /** The (non-protected) session that submitted it — the only one who may revoke. */
  from: string;
  at: number;
  /** ≤500 chars, control characters stripped, whitespace collapsed. */
  summary: string;
  /** `docs/issues/<name>.md` (syntax-checked only) or `null`. */
  issuePath?: string | null;
  /** A bid the sender already talked about, if any — display only. */
  bid?: string | null;
  /**
   * 0.6.0 (`collab_escalate`): an urgent item (a protected target could not be
   * pushed to). Display only — ordering stays FIFO.
   */
  priority?: 'urgent';
  /** Kept for tolerant reads; `revoke` deletes the file. */
  revokedAt?: number | null;
  /** Written by the target's `context` hook **after** the block was pushed. */
  seenAt?: number | null;
}

// ------------------------------------------------------- temporary freeze (0.6.0)

/**
 * One **temporary freeze** (`~/.config/opencode/collab-freeze.json`,
 * `collab_freeze`).
 *
 * A freeze is a *collaboration-layer* mark, not a session flag: it is
 * reversible (`freeze:false`), self-expiring (`until`, no scheduler) and never
 * touches `permissions` / `agent` / the archive bit. `scope` says what is
 * frozen, `target` is the session id / absolute workspace path / bid, and
 * `notifiedAt` records the one context notice the frozen session gets.
 */
export interface FreezeEntry {
  scope: 'session' | 'workspace' | 'bid';
  /** sid / absolute workspace path / bid. */
  target: string;
  /** One line (≤200 chars, control characters stripped) — shown in refusals. */
  reason: string;
  /** The session that froze it. */
  by: string;
  at: number;
  /** Epoch ms; expired entries are ignored on read and swept on write. */
  until: number;
  /** The frozen session already saw the context notice (once per freeze). */
  notifiedAt?: number;
  /**
   * The sessions that already saw the notice (0.6.0). `notifiedAt` is the last
   * stamp; this list is what makes "once" true per session when a frozen
   * ancestor covers several sub-sessions.
   */
  notifiedFor?: string[];
  /**
   * Delivery receipts of the freeze notice (additive, 0.6.0): a `queue` prompt
   * admission or the owner-queue item of a protected target. Kept so a human can
   * tell "did it actually reach anybody" without re-reading the tool result.
   */
  delivery?: FreezeDelivery[];
}

/** One freeze notice that was really delivered (or queued). */
export interface FreezeDelivery {
  to: string;
  /** `queue` prompt admission. */
  cid?: string;
  messageId?: string;
  /** Protected target: the owner-queue item id (`q_…`) instead of a prompt. */
  queueId?: string;
  at: number;
  error?: string;
}

/** The whole freeze file — `{ version: 1, entries: [] }`. */
export interface FreezeFile {
  version: 1;
  entries: FreezeEntry[];
}

// ------------------------------------------------------------ resource leases

/** `exclusive` (default) locks out everything; `shared` coexists with `shared`. */
export type LockMode = 'exclusive' | 'shared';

/** How a resource name was recognised — display / grouping only. */
export type LockKind = 'named' | 'file' | 'build';

export type LockEvent = 'acquire' | 'release' | 'expire' | 'wait' | 'leave';

/** One queued request (`wait:true` on a held resource). */
export interface LockWaiter {
  sid: string;
  at: number;
  mode: LockMode;
  reason?: string;
}

/** One audit line. Structure only — no free text beyond the sanitised event. */
export interface LockHistoryEntry {
  sid: string;
  at: number;
  event: LockEvent;
  /**
   * Why the lease / queue entry ended without a matching release:
   *   `invalid` = the record was corrupt (`holders` non-empty, `expiresAt` ≤ 0 /
   *   not a number) and had to be reaped instead of holding the resource
   *   forever (review R-7);
   *   `stale` = a **waiter** whose heartbeat was older than `waiterTtlMs`; it is
   *   dropped by the next `acquire` (0.6.0, R1 — never by a read command).
   */
  reason?: string;
}

/**
 * One lease (`~/.config/opencode/collab-locks/<hash>__<slug>.json`).
 *
 * `holders` is the truth: one session for `exclusive`, one-or-more for
 * `shared`. `holder` / `acquiredAt` / `ttlMs` / `expiresAt` describe the lease
 * as a whole (a shared group's expiry is the latest holder's).
 */
export interface LockRecord {
  resource: string;
  kind: LockKind;
  mode: LockMode;
  holder?: string;
  holders: string[];
  /** Why the lease was taken (sanitised, ≤200 chars) — kept for the holder. */
  reason?: string;
  acquiredAt: number;
  ttlMs: number;
  expiresAt: number;
  waiters: LockWaiter[];
  history: LockHistoryEntry[];
  updatedAt?: number;
  [key: string]: any;
}

/** Read-only view shared by `collab_locks` / `collab_list` (and the sidebar). */
export interface LockState {
  resource: string;
  kind: LockKind;
  mode: LockMode;
  /** `true` = nobody holds it (waiters do not count as holders). */
  free: boolean;
  holders: string[];
  holder?: string;
  /** Why the lease was taken (sanitised) — `undefined` when not given. */
  reason?: string;
  /** The lease length granted (0 when free). */
  ttlMs: number;
  expiresAt: number;
  /** `<= 0` when free; capped remaining milliseconds otherwise. */
  expiresIn: number;
  waiters: Array<LockWaiter & { position: number }>;
  /**
   * 0.6.0 (R3): `now − waiter.at` for each entry of `waiters`, same order — the
   * read-only view `collab_locks` prints as `sid#pos(age)`. Derived in `stateOf`,
   * never written to disk.
   */
  waiterAgeMs?: number[];
  /** 0.6.0 (R3): the sids whose heartbeat is older than the waiter TTL. */
  staleWaiters?: string[];
  /** 0.6.0 (R3): at least one waiter's heartbeat is older than the waiter TTL. */
  stale?: boolean;
  /** The caller's own lease / queue position, when it is involved. */
  mine?: { held: boolean; waiting: boolean; position: number };
}

/** One inbox entry (`collab/inbox/<sid>`). */
export interface InboxMessage {
  id: string;
  cid?: string;
  sessionID: string;
  fromSession: string;
  from: string;
  kind: string;
  /**
   * R7 (0.1.4): whether the sender actually declared a `kind` (envelope tag or
   * metadata) or it was merely defaulted to `request`. Only a legacy message
   * with **no** declared kind may be judged by its `[handoff]` body — an
   * explicit `note` / `request` is never a receipt, however it is worded.
   */
  kindExplicit?: boolean;
  threadID?: string;
  text: string;
  ts: number;
  delivered?: boolean;
  [key: string]: any;
}

export interface InboxValue {
  messages: InboxMessage[];
  cursor: number;
  injected: string[];
  size: number;
}

export interface ThreadMessage {
  threadID?: string;
  cid?: string;
  kind?: string;
  text?: string;
  ts?: number;
  from?: string;
  fromSession?: string;
  toSession?: string;
  [key: string]: any;
}

/** One thread record (`collab/threads/<threadID>`) — the request/reply SSOT. */
export interface ThreadRecord {
  threadID: string;
  fromSession?: string;
  toSession?: string;
  kind: string;
  status: string;
  msgs: ThreadMessage[];
  createdAt: number;
  updatedAt: number;
  [key: string]: any;
}

/** The lazily re-read config (`collab.json` + `ctx.options` + built-in defaults). */
export interface ReportConfig {
  /** `alias|ses_…` of the maintainer session; a `note` is queued there (R5). */
  to?: string;
  /** `false` disables the delivery (evidence is still written). Default `true`. */
  enabled?: boolean;
}

export interface CollabConfig {
  aliases: Record<string, string>;
  autoDeliver: boolean;
  maxInject: number;
  allowWrite: boolean;
  protect: string[];
  readonlyAgents: string[];
  /**
   * 0.5.0: automatically archive a spawned session once its hand-off is over
   * (default `true`). `false` disables **only** the automatic path —
   * `collab_archive` always works by hand.
   */
  archiveSpawned: boolean;
  /** Debounce after the terminal state before archiving (1min–1h). */
  archiveGraceMs: number;
  /**
   * 0.6.0 (R1): a waiter whose heartbeat is older than this is reaped on the
   * next `acquire` (clamped to [1min, 1h], default 10min).
   */
  waiterTtlMs: number;
  /** 0.6.0 (R2): refresh queued waiters from the `context` hook (default `true`). */
  waiterHeartbeat: boolean;
  /**
   * 0.6.0 (R5): the same thread + the same normalised body inside this window is
   * one message (default 60000; `0` disables the check).
   */
  dedupeWindowMs: number;
  /**
   * 0.7.0 (R1–R5): the one-line awareness hint. `line` (default) injects
   * 「本工作区候选 N · 其它工作区候选 M」 at most once per 10 min; `off`
   * injects nothing. Read-only either way.
   */
  awareness: 'line' | 'off';
  report?: ReportConfig;
}

/** Event stream payload the inbox records (`session.inbox.enqueued`). */
export interface InboxEvent {
  type?: string;
  data?: JsonObject;
}

/** Proposal summary used by the matching score. */
export interface ProposalSummary {
  contentHash: string;
  title: string;
  slug: string;
  files: string[];
  keywords: string[];
  taskSlugs: string[];
}

/** One ranked candidate (score + audit trail + the session it belongs to). */
export interface RankedCandidate {
  sid: string;
  score: number;
  why: string[];
  busyMinutes: number;
  info?: SessionInfoLike;
}

export interface RankResult {
  candidates: RankedCandidate[];
  members: number;
}
