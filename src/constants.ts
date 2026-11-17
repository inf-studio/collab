import { homedir } from 'node:os';
import { join } from 'node:path';

// ------------------------------------------------------------------- storage

export const CONFIG_PATH = process.env.COLLAB_CONFIG || join(homedir(), '.config', 'opencode', 'collab.json');
export const LEGACY_ALIAS_PATH = join(homedir(), '.config', 'opencode', 'collab-aliases.json');

export const STORAGE_ALIASES = 'collab/aliases';
export const STORAGE_DELIVERED = 'collab/delivered';
export const inboxKey = (sessionID: string): string => `collab/inbox/${sessionID}`;
export const threadKey = (threadID: string): string => `collab/threads/${threadID}`;

/** Legacy sender prefix (`[collab:<from>] `), still matched for CLI-sent text. */
export const COLLAB_PREFIX_RE = /^\[collab:([^\]]*)\]/;
/** Full envelope: `[collab:<from>][<kind>:<threadID>] <body>` (thread optional). */
export const COLLAB_ENVELOPE_RE = /^\[collab:([^\]]*)\](?:\[([a-z]+)(?::([^\]]*))?\])?\s*/;

export const DEFAULT_MAX_INJECT = 3;
/** Ancestor hops followed by the lineage guard (protect list + `collab_list`). */
export const MAX_LINEAGE_DEPTH = 8;
export const INJECT_CHARS = 200;
/** Inbox keeps the whole body (up to this) so `collab_inbox` can return it in full. */
export const INBOX_TEXT_LIMIT = 4000;
export const MAX_STORED = 50;
export const KINDS = ['request', 'reply', 'note'];
export const STATUSES = ['open', 'answered', 'closed'];

/** Reply waits poll storage at this interval and are woken early by the event loop. */
export const REPLY_POLL_MS = 400;

/**
 * Built-in hard list. Always protected, whatever the config file says:
 * these sessions — and every descendant that carries them in its `parentID`
 * chain — are never valid `collab_send` targets.
 * (schema line + the long-lived main line.)
 */
export const BUILTIN_PROTECT = ['ses_e1eb91cebffeTv1467ubJLKebk', 'ses_e23a4a23fffe4c4m7UQFR8dUL3'];

/**
 * Read-only agents never get `steer`: they are demoted to `queue` so an inbound
 * request can never merge into the turn they are already running.
 * (Agent ids come from the `context` hook / tool context; extend via config.)
 */
export const DEFAULT_READONLY_AGENTS = ['explore', 'plan'];

/**
 * Only inbox admissions matter for the unread queue. Event names come from the
 * server's own `V2Event` union, verified live by a probe plugin.
 */
export const EVENT_TYPES = ['session.inbox.enqueued'];

export const DEFAULTS = {
  aliases: {} as Record<string, string>,
  autoDeliver: true,
  maxInject: DEFAULT_MAX_INJECT,
  /** R8: the package never patches a session's permissions / agent by default. */
  allowWrite: false,
  protect: BUILTIN_PROTECT,
  readonlyAgents: DEFAULT_READONLY_AGENTS
};

// ------------------------------------------------- hand-off chain (broadcast)

/**
 * The hand-off chain (`local` + `peer`) keeps its coordination state in a
 * *global* directory, not in `ctx.storage`: storage is namespaced per
 * `location`, so a broadcast written in workspace A would be invisible in
 * workspace B, and a claim could not be atomic across locations.
 *
 * One file per hand-off (`<bid>.json`) + one lock (`<bid>.lock`), both written
 * with `tmp + rename` / `open(…, "wx")`.
 * `COLLAB_BROADCAST_DIR` overrides the directory (harness + sandbox runs).
 */
export const BROADCAST_DIR =
  process.env.COLLAB_BROADCAST_DIR || join(homedir(), '.config', 'opencode', 'collab-broadcast');

/** Matching score a candidate must reach before it is asked. */
export const BCAST_THRESHOLD = 80;
/** Ask lease: a `claimed` hand-off reopens after this. */
export const BCAST_LEASE_MS = 300_000;
/** `attempts > BCAST_MAX_ATTEMPTS` → `expired`, escalate to a human. */
export const BCAST_MAX_ATTEMPTS = 3;
/** A candidate busy for longer than this gets a wake-up prompt and -10 points. */
export const BCAST_BUSY_MS = 30 * 60 * 1000;
/** "Recently active" window used by the +5 signal. */
export const BCAST_RECENT_MS = 2 * 60 * 60 * 1000;
/** Scoring reads at most this many messages, inside this window. */
export const SCORE_MESSAGE_LIMIT = 200;
export const SCORE_MESSAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Upper bound on how many candidate sessions get their messages scanned. */
export const SCORE_CANDIDATE_LIMIT = 20;
/**
 * R2 auto-receipt: a lapsed *spawn* lease reads at most this many trailing
 * messages of the claimed session — one read per refresh, no polling.
 */
export const VERDICT_MESSAGE_LIMIT = 10;
/** Only this many characters of the counterpart's answer are kept (never the body). */
export const VERDICT_NOTE_LIMIT = 200;
/** Hand-off states. */
export const BCAST_STATES: string[] = ['open', 'claimed', 'acked', 'done', 'blocked', 'expired'];
export const BCAST_DONE_STATES = ['done', 'blocked', 'expired'];
/**
 * Retention for decided hand-offs (`done` / `blocked` / `expired`): anything
 * whose `updatedAt` is older than this is deleted on the next write. Open work
 * (`open` / `claimed` / `acked`) is never pruned — it is still someone's job.
 */
export const BCAST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Per-write prune budget, so one write never sweeps a huge directory. */
export const BCAST_PRUNE_LIMIT = 20;
export const EXPECTED = ['implement', 'review'];
/** Spawned sessions get this title so `collab_list` can mark them `[bootstrap]`. */
export const BOOTSTRAP_TITLE_RE = /^(impl|review):/;

// -------------------------------------------------- session permission grants

/**
 * The **only** capabilities this plugin may ever add to a session: the five
 * `collab_*` actions it owns. Anything else — `edit` / `write` / `shell` /
 * `read` / … — is refused before a request is built, so `collab_grant` can never
 * be turned into a privilege-escalation tool.
 */
export const COLLAB_TOOL_ACTIONS = ['collab_list', 'collab_inbox', 'collab_wait', 'collab_reply', 'collab_send'];
/** Resource the five allow rules are scoped to (`Permission.Rule.resource`). */
export const COLLAB_RULE_RESOURCE = '*';
/**
 * Agents `collab_promote` may switch a session **to**. `explore` stays the
 * read-only default; promotion is only for a session that has ACCEPTed a
 * hand-off and needs to change code.
 */
export const PROMOTE_AGENTS = ['build', 'plan'];
/** `Permission.Effect` (server enum) — a restored snapshot may contain all three. */
export const PERMISSION_EFFECTS = ['allow', 'deny', 'ask'];
/**
 * Grant ledger: one file per session holding the **pre-grant** ruleset, so
 * `collab_grant {revoke:true}` restores exactly what was there instead of
 * deleting five rules that may have pre-existed.
 * `COLLAB_GRANT_DIR` overrides the directory (harness / sandbox runs).
 */
export const GRANT_DIR = process.env.COLLAB_GRANT_DIR || join(homedir(), '.config', 'opencode', 'collab-grants');
/**
 * Optional HTTP fallback for hosts that do not expose `ctx.session.update`.
 * The base URL is never guessed: it must be configured, because a wrong port
 * could patch an unrelated instance.
 */
export const SERVER_URL = String(process.env.COLLAB_SERVER_URL ?? '')
  .trim()
  .replace(/\/+$/, '');
export const SERVER_TOKEN = String(process.env.COLLAB_SERVER_TOKEN ?? '').trim();
