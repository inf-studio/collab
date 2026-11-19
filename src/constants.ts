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
/**
 * 0.7.0 (R1/R3): the one-line awareness hint is injected at most once per
 * session per window, and the cross-workspace session page is read at most once
 * per window — the hint must never turn into a per-request poll.
 */
export const AWARENESS_TTL_MS = 10 * 60 * 1000;
/**
 * One page for "count everyone else". Deliberately larger than
 * `SCORE_CANDIDATE_LIMIT` (20) — a count is truncated silently, a ranking is
 * not, so the page must not cut off the workspaces we are counting (R3).
 */
export const AWARENESS_LIST_LIMIT = 200;
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
  readonlyAgents: DEFAULT_READONLY_AGENTS,
  /** 0.5.0: archive the sessions we spawned once their hand-off is over. */
  archiveSpawned: true,
  /** 0.6.0: a waiter that stops heartbeating this long is reaped on the next acquire. */
  waiterTtlMs: 10 * 60 * 1000,
  /** 0.6.0: refresh `waiter.at` from the session's own `context` hook. */
  waiterHeartbeat: true,
  /** 0.6.0: the same thread + the same normalised body inside this window is one message. */
  dedupeWindowMs: 60_000,
  /**
   * 0.7.0 (R5): the read-only awareness hint ("本工作区候选 N · 其它工作区候选 M").
   * `line` (default) injects at most one line per 10 min; `off` injects none.
   */
  awareness: 'line' as 'line' | 'off'
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
/**
 * R8: an `acked` hand-off has no lease (`refreshBroadcast` only reopens
 * `claimed`), so a lost receipt used to keep it `acked` forever. After this much
 * silence the requester may read the claimant's last answer — exactly the same
 * read-only extraction as the `claimed` path, and at most once per window.
 */
export const ACKED_EXTRACT_MS = 2 * 60 * 60 * 1000;
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
/**
 * What the receiving side is expected to do. `research` (0.4.0) is the
 * read-only counterpart of `implement`: investigate and answer, never edit —
 * legal for a `build` session too, and the only honest expectation when the
 * counterpart is a read-only agent (`explore` / `plan`).
 */
export const EXPECTED = ['implement', 'review', 'research'];
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

// ------------------------------------------------------- defect self-reporting

/**
 * Where defect evidence lands (`~/.config/opencode/collab-reports/<sig>/`).
 * The directory is **evidence and fallback only**: the primary channel is a
 * `collab_send` note to `report.to` (see `core/report.ts`). `COLLAB_REPORT_DIR`
 * overrides it (harness / sandbox runs).
 */
export const REPORT_DIR =
  process.env.COLLAB_REPORT_DIR || join(homedir(), '.config', 'opencode', 'collab-reports');
/** One report per signature per hour (R4). */
export const REPORT_THROTTLE_MS = 60 * 60 * 1000;
/** `error.message` is cut here before it is written to disk (R2). */
export const REPORT_MESSAGE_LIMIT = 2048;
/** Only the first N stack frames are kept — enough to locate the frame. */
export const REPORT_STACK_FRAMES = 5;
/** Index of `{ signature: { lastAt, triagedAt } }`, written `tmp + rename`. */
export const REPORT_INDEX_FILE = 'index.json';

// ------------------------------------------------- owner queue (0.4.0, D1)

/**
 * A *pull* channel into a protected session, and nothing more:
 * `collab_request_owner` writes one JSON file per request into
 * `<dir>/<targetSid>/<queueId>.json`; the protected session sees 1–3 read-only
 * lines in its own `context` injection and decides for itself whether to read.
 *
 * Deliberately **not** a delivery path: no `session.prompt`, no inbox entry, no
 * hand-off record, no bid, no thread. `BUILTIN_PROTECT` stays a one-way hard
 * boundary — this queue is on the other side of it (the owner pulls).
 * `COLLAB_OWNER_QUEUE_DIR` overrides the directory (harness / sandbox runs).
 */
export const OWNER_QUEUE_DIR =
  process.env.COLLAB_OWNER_QUEUE_DIR || join(homedir(), '.config', 'opencode', 'collab-owner-queue');
/**
 * Hard cap per protected target on **unread** items: a full queue refuses a new
 * item (never evicts). Seen items do not count — they are no longer part of the
 * owner's backlog, and counting them would keep a queue "full" long after the
 * owner read everything, i.e. the permanent block this queue exists to remove.
 */
export const OWNER_QUEUE_LIMIT = 50;
/**
 * A **seen** item is kept this long (so `collab_list` still shows what the owner
 * already read) and is then swept on the next write.
 */
export const OWNER_QUEUE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Per-write sweep budget, so one write never scans-then-deletes a huge queue. */
export const OWNER_QUEUE_PRUNE_LIMIT = 20;
/** One summary, control characters stripped, whitespace collapsed. */
export const OWNER_QUEUE_SUMMARY_LIMIT = 500;
/** At most this many unread items are shown per injection (oldest first). */
export const OWNER_QUEUE_HINT_LIMIT = 3;
/** Summary is cut here in the injected line (one line, no body). */
export const OWNER_QUEUE_HINT_CHARS = 120;
/** Summary shown per line in `collab_list` (the requester's own view). */
export const OWNER_QUEUE_LIST_CHARS = 60;
/** `issuePath` of a queue item is a *syntax* check only (≤ this). */
export const OWNER_QUEUE_ISSUE_LIMIT = 200;

// -------------------------------------------------------- hang-up monitoring

/** `open` older than this with nobody asking = stuck (R6). */
export const STALE_OPEN_MS = 60 * 60 * 1000;
/** `acked` silent for this long = the receipt is lost; extract it (R6/R8). */
export const STALE_ACKED_MS = ACKED_EXTRACT_MS;
/** Per-session memory of already-shown `class:bid` reminders. */
export const STALE_SEEN_LIMIT = 200;

// ------------------------------------------------------- resource leases (0.2.0)

/**
 * Leases live in a **global** directory for exactly the same reason the
 * hand-off chain does: `ctx.storage` is namespaced per `location`, so a lock
 * taken in workspace A would be invisible to a session in workspace B — and two
 * sessions fighting over the same test window are usually in different
 * workspaces. One file per resource, `open(…, "wx")` as the short guard, and
 * `COLLAB_LOCK_DIR` overrides the directory (harness / sandbox runs).
 */
export const LOCK_DIR =
  process.env.COLLAB_LOCK_DIR || join(homedir(), '.config', 'opencode', 'collab-locks');
/** Default lease: long enough for a full test run, short enough to self-heal. */
export const LOCK_TTL_DEFAULT_MS = 15 * 60 * 1000;
/** Floor: below this a lease could expire mid-run and cause a second winner. */
export const LOCK_TTL_MIN_MS = 10_000;
/** Ceiling (design §6): nobody holds a resource for a whole afternoon. */
export const LOCK_TTL_MAX_MS = 2 * 60 * 60 * 1000;
/** How long an applicant waits for the short `open(…, "wx")` guard. */
export const LOCK_GUARD_TIMEOUT_MS = 2000;
/** A guard file older than this was left by a crash and may be removed. */
export const LOCK_GUARD_STALE_MS = 2000;
/** Audit lines kept per lease (oldest dropped first). */
export const LOCK_HISTORY_LIMIT = 50;
/**
 * Maximum FIFO waiters per resource. This is a **hard cap, not a truncation
 * window**: a full queue refuses a *new* waiter (readable error) instead of
 * dropping the oldest one — losing the head would silently steal a session's
 * place, which is exactly the coordination bug the lease exists to remove.
 */
export const LOCK_QUEUE_LIMIT = 50;
/** `reason` is one line, ≤200 chars, control characters stripped. */
export const LOCK_REASON_LIMIT = 200;

// ------------------------------------------------ waiter heartbeat (0.6.0, R1/R2)

/**
 * A queued waiter is **not** a lease: it has no TTL and used to live forever,
 * so one session that queued once and never came back could keep a free
 * resource unusable for everyone else («资源空闲，但有人在排队», observed ≥3×
 * in one night). `LockWaiter.at` therefore became a **heartbeat**:
 *
 *   - `collab_lock` (re-apply) / the session's own `context` hook / any writing
 *     `collab_*` call refresh it (`touchWaiters`, throttled);
 *   - the next `acquire` drops waiters whose heartbeat is older than this
 *     (`reapWaiters`) — only the *write* path, never a read command.
 *
 * Default 10 min: long enough for a session that is working through a long
 * turn (the heartbeat is per request, not per tool call), short enough that a
 * lost session frees the queue within one coffee break.
 */
export const LOCK_WAITER_TTL_MS = 10 * 60 * 1000;
/** Floor: below this a heartbeat could not span one long turn. */
export const LOCK_WAITER_TTL_MIN_MS = 60 * 1000;
/** Ceiling: a waiter is never kept for a whole afternoon. */
export const LOCK_WAITER_TTL_MAX_MS = 60 * 60 * 1000;
/**
 * Minimum interval between two heartbeat **writes** for one session. The touch
 * runs on every writing tool call / model request; without the throttle a long
 * turn would rewrite the same lock file dozens of times for no new information.
 */
export const LOCK_WAITER_TOUCH_MS = 30 * 1000;

// ---------------------------------------------- content de-duplication (0.6.0, R5)

/**
 * R5 (0.6.0): `collab_send` / `collab_reply` treat the **same thread** + the
 * **same normalised body** inside `dedupeWindowMs` (default 60s,
 * `DEFAULTS.dedupeWindowMs`; `0` = off) as one message. The record layer only
 * ever deduped `cid` / ack traffic, so the same text sent twice 15 s apart was
 * delivered twice (observed).
 *
 * `DEDUPE_WINDOW_MAX_MS` is the ceiling (a wider window would swallow a real
 * re-send); the other two bound the per-check work.
 */
export const DEDUPE_WINDOW_MAX_MS = 24 * 60 * 60 * 1000;
/** How many recent `record.replies` entries are consulted (the persistent half). */
export const DEDUPE_REPLY_LOOKBACK = 3;
/** The in-process memo (records without a bid) is pruned above this size. */
export const DEDUPE_MEMO_LIMIT = 200;

// ------------------------------------------------------- delivery / ack (0.1.6)

/**
 * R1/R2 (0.1.6): two-level delivery acknowledgement.
 *
 * `admitted` is the host's own receipt (`session.prompt` returned a
 * `message.id`, or the ask was written into the record for the receiving
 * plugin's next `context` injection). `seen` is the *receiving* plugin saying
 * "I put this in front of the model" — the only honest signal that exists:
 * a long-lived session can run a single turn for tens of minutes (50 sessions,
 * 900h+ uptime, 57M tokens observed on this host), so "the turn finished" is
 * not a usable definition of delivered.
 *
 * A hand-off may be re-delivered **at most once**, and only after this window
 * AND only while the target is idle (a busy target is never re-queued: it
 * already holds the message).
 */
export const ACK_SEEN_WINDOW_MS = 2 * 60 * 60 * 1000;
/** R2: at most one extra delivery per hand-off (same `cid`, so it is idempotent). */
export const MAX_RESENDS = 1;

// ------------------------------------------------------ spawn session archive

/**
 * 0.5.0: a spawned (`claim.kind = "spawn"`) session is **archived** — never
 * deleted — once the hand-off it exists for is over and nobody needs it any
 * more. `PATCH /api/session/{sid} { archived:true }` is reversible
 * (`archived:false`), so this only hides the session from the list; the record
 * and every message stay.
 *
 * The grace window is a **debounce**, not a wait for work: a hand-off that is
 * `done` / `blocked` / `expired` for longer than this is over even if the last
 * message was written a second before the state flipped (auto receipts,
 * `collab_followup`). Clamped to [`ARCHIVE_GRACE_MIN_MS`, `ARCHIVE_GRACE_MAX_MS`]
 * so a typo (`600` = 0.6s, `604800000` = a week) cannot archive something that
 * is still in use.
 */
export const ARCHIVE_GRACE_MS = 10 * 60 * 1000;
export const ARCHIVE_GRACE_MIN_MS = 60 * 1000;
export const ARCHIVE_GRACE_MAX_MS = 60 * 60 * 1000;

/** Keep in sync with `package.json` (`the harness asserts equality`). */
export const PLUGIN_VERSION = '0.6.0';

