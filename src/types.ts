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
  receipt?: { from?: string; by?: string; at?: number; note?: string; auto?: boolean };
  createdAt?: number;
  updatedAt?: number;
  [key: string]: any;
}

/** One inbox entry (`collab/inbox/<sid>`). */
export interface InboxMessage {
  id: string;
  cid?: string;
  sessionID: string;
  fromSession: string;
  from: string;
  kind: string;
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
