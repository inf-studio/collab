import { homedir } from 'node:os';
import { join } from 'node:path';

// ------------------------------------------------------------------- storage

export const CONFIG_PATH = process.env.COLLAB_CONFIG || join(homedir(), '.config', 'opencode', 'collab.json');
/**
 * 0.9.0 (R2): the SQLite projection. `storage:'json'` in `collab.json` makes the
 * plugin **never** import `node:sqlite` / `bun:sqlite` at all (rollback switch).
 */
export const DB_FILE = process.env.COLLAB_DB_FILE || join(homedir(), '.config', 'opencode', 'collab.db');
export const LEGACY_ALIAS_PATH = join(homedir(), '.config', 'opencode', 'collab-aliases.json');

export const STORAGE_ALIASES = 'collab/aliases';
export const STORAGE_DELIVERED = 'collab/delivered';
export const inboxKey = (sessionID: string): string => `collab/inbox/${sessionID}`;
export const threadKey = (threadID: string): string => `collab/threads/${threadID}`;

/**
 * Legacy sender prefix (`[collab:<from>] `), still matched for CLI-sent text.
 *
 * 0.8.0 (`sender-name`): an inbound header may carry the sender's session title
 * **in front** — `[<title>][collab:<from>][<kind>:<threadID>] <body>`. The
 * optional leading `[…]` keeps every consumer (dedupe, `extractInbound`,
 * `normalizeText`) reading the same `from`, and a title-less header still
 * matches at position 0 exactly as before. `from` stays group 1.
 */
export const COLLAB_PREFIX_RE = /^(?:\[[^\]]*\])?\[collab:([^\]]*)\]/;
/**
 * Full envelope: `[<title>?][collab:<from>][<kind>:<threadID>] <body>`
 * (title and thread optional). Groups: 1 title, 2 from, 3 kind, 4 threadID.
 */
export const COLLAB_ENVELOPE_RE = /^(?:\[([^\]]*)\])?\[collab:([^\]]*)\](?:\[([a-z]+)(?::([^\]]*))?\])?\s*/;

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
 * 0.9.2 (`11-20-collab-gate`, declared before `DEFAULTS` on purpose — `DEFAULTS`
 * reads it at module-evaluation time). `collab.json` → `gate`; anything else
 * falls back to `enforce`.
 */
export const DEFAULT_GATE_MODE = 'enforce';

/**
 * 0.9.6 (`11-20-collab-pacing`, R1–R5) — declared before `DEFAULTS` for the same
 * module-evaluation reason as `DEFAULT_GATE_MODE`.
 *
 * The 2-minute batching window (D3): a non-urgent message is buffered per target;
 * the window starts at its **first** item and flushes `windowMs` later as one
 * envelope carrying `items[]`. `windowMs:0` is the rollback switch — every
 * message goes out on its own, exactly as 0.9.5 did.
 *
 * The buffer lives in a global file (like the broadcast directory) so a plugin
 * reload / a sleeping process does not lose it: the next `context` hook flushes
 * every window that is past due. `COLLAB_PACING_FILE` overrides the path
 * (harness / sandbox runs).
 */
export const PACING_FILE = process.env.COLLAB_PACING_FILE || join(homedir(), '.config', 'opencode', 'collab-pacing.json');
/**
 * The state-file version. A foreign `v` is treated as an empty buffer (the
 * pacing path), and its counters are **not** used as metrics input (0.9.7).
 */
export const PACING_VERSION = 1;
/** Default window (D3). Config `windowMs`; `0` = off. */
export const PACING_WINDOW_MS = 120_000;
/** A window wider than this is a typo, not a batching policy (30min). */
export const PACING_WINDOW_MAX_MS = 30 * 60 * 1000;
/**
 * The delivery promise (D11): a message reaches its target within 5 minutes.
 * A window flushed later than `first.sentAt + PACING_SLA_MS` is counted in
 * `metrics.late_count` — it is delivered anyway, never dropped and never re-sent.
 */
export const PACING_SLA_MS = 5 * 60 * 1000;
/** A failed flush keeps its items and retries after this (no item is ever lost). */
export const PACING_RETRY_MS = 60_000;
/** Bound on one window: past this the flush is pulled forward (never dropped). */
export const PACING_MAX_ITEMS = 200;
/** Day-counter retention in `collab-pacing.json` (the DB keeps the real rows). */
export const PACING_COUNTER_KEEP_DAYS = 30;
/** Metrics are recomputed at most once per minute (cheap, but not per message). */
export const PACING_METRICS_TTL_MS = 60_000;

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
  awareness: 'line' as 'line' | 'off',
  /**
   * 0.8.0 (`board2-actions`): the desktop board's action row (加急 / 冻结 /
   * 解冻 / 归档). `false` hides the row in the panel; the RPC methods stay
   * callable (the same rollback switch the PRD asks for, design §5).
   */
  boardActions: true,
  /**
   * 0.9.0 (`11-20-collab-store`, R4): `sqlite` (default) keeps the rebuildable
   * projection next to the JSON truth; `json` is the rollback switch — the
   * plugin then **never imports** `node:sqlite` / `bun:sqlite` and every tool
   * keeps working from the JSON files alone.
   */
  storage: 'sqlite' as 'sqlite' | 'json',
  /** 0.9.0 (R2): where the projection lives (`dbPath` in `collab.json`). */
  dbPath: DB_FILE,
  /**
   * 0.9.2 (`11-20-collab-gate`): the collaboration gate. `enforce` (default)
   * refuses an out-of-scope `accept` / a new job while 8+ todos are open;
   * `warn` / `off` are the rollback switches.
   */
  gate: DEFAULT_GATE_MODE as 'enforce' | 'warn' | 'off',
  /**
   * 0.9.6 (`11-20-collab-pacing`, R1): the batching window in ms. `0` restores
   * the 0.9.5 behaviour (one prompt per message).
   */
  windowMs: PACING_WINDOW_MS,
  /**
   * 0.9.6 (R2): extra `kind`s that never enter the window. **Empty by default**
   * on purpose: `escalate` / structured `blocked` / a protected target / a
   * hand-off (`bid`) / `force` are *architectural* direct paths inside
   * `pacingPolicy` — `escalate` does not even flow through `dispatch`
   * (`core/actions.ts` delivers it), so listing it here would be dead config.
   * The list exists for a caller that wants its own kind to bypass batching.
   */
  directKinds: [] as string[],
  /** 0.9.6 (R3): suppress a message that carries no increment (default on). */
  suppressNoDelta: true
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

// ------------------------------------------- board write actions (0.8.0, R5)

/**
 * R5 (`board2-actions`): every **write action** of the board (加急 / 冻结 /
 * 解冻 / 归档) appends exactly one JSON line here — success *and* failure, only
 * appended, never rotated (`{ at, actor, action, target, ok, reason }`).
 *
 * One global file for the same reason the freeze / lease directories are global:
 * the board can act on a session of any workspace. A line is written by the RPC
 * entry point (`collab.state.*`), which is where the GUI-confirmed call lands;
 * the native tools keep their own receipts and do not append here.
 * `COLLAB_AUDIT_FILE` overrides the path (harness / sandbox runs).
 */
export const AUDIT_FILE =
  process.env.COLLAB_AUDIT_FILE || join(homedir(), '.config', 'opencode', 'collab-audit.jsonl');

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

// --------------------------------------------------------- pacing (0.9.6, R1–R5)

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

// ------------------------------------------------------ thread index (0.7.0)

/**
 * 0.7.0 (`11-19-collab-threads`): `ThreadStore` is a key/value domain (read one
 * thread by id, no enumeration), so "the threads of this counterpart" needs one
 * **lightweight index**. One JSON file, one entry per thread, written only after
 * a message was really admitted.
 *
 * `COLLAB_THREAD_INDEX_FILE` overrides the path (harness / sandbox runs) — like
 * every other global path here it is read once at module load.
 */
export const THREAD_INDEX_FILE =
  process.env.COLLAB_THREAD_INDEX_FILE || join(homedir(), '.config', 'opencode', 'collab-threads.json');
/** The file shape this build writes (an unknown version is treated as empty). */
export const THREAD_INDEX_VERSION = 1;
/** Hard cap: above this the oldest `lastAt` entries are evicted **on write**. */
export const THREAD_INDEX_LIMIT = 500;
/** Reads ignore entries older than this (7 days); nothing is deleted by a read. */
export const THREAD_INDEX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** The stored preview: the sender's own words, one line, ≤ this. */
export const THREAD_INDEX_PREVIEW_CHARS = 80;
/** `collab_threads` renders at most this many threads, then "还有 N 个". */
export const THREADS_MAX = 20;
/** `includeClosed` also lists at most this many already-closed threads. */
export const THREADS_CLOSED_MAX = 3;
/** Summary cut per rendered line (`collab_threads` / downgraded `collab_status`). */
export const THREAD_SUMMARY_CHARS = 120;
/** How many in/out messages the downgraded `collab_status` shows (newest last). */
export const THREAD_STATUS_MESSAGES = 5;

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

// ------------------------------------------- message history + projection (0.9.0)

/**
 * 0.9.0 (`11-20-collab-store`, R1): the **append-only** message log, one
 * `Envelope` per line — the only place a message body is kept. The SQLite
 * projection (`collab.db`) can be deleted and rebuilt from this file at any
 * time, which is why the JSON file is written **before** the index row and why
 * an index failure never blocks a delivery.
 *
 * `COLLAB_MESSAGES_FILE` overrides the path (harness / sandbox runs). Read once
 * at module load, like every other global path here.
 */
export const MESSAGES_FILE =
  process.env.COLLAB_MESSAGES_FILE || join(homedir(), '.config', 'opencode', 'collab-messages.jsonl');
/** One JSONL line is at most this many UTF-8 bytes; a longer body is split. */
export const MESSAGE_PART_BYTES = 1024 * 1024;
/**
 * The active log rotates at this size: `collab-messages.jsonl` is renamed to
 * `collab-messages-<n>.jsonl` (n ascending = oldest → newest) and reads
 * concatenate the rotated files, then the active one.
 */
export const MESSAGES_ROTATE_BYTES = 256 * 1024 * 1024;
/**
 * R2: `messages.body` keeps the **full** body; only the FTS index body is cut
 * to this many characters (a search index, not a second copy of the archive).
 */
export const FTS_BODY_LIMIT = 8192;
/** R2: a second writer waits this long for the WAL lock instead of failing. */
export const DB_BUSY_TIMEOUT_MS = 5000;
/** R2: three attempts, exponential — the cross-process contention budget. */
export const DB_RETRY_DELAYS_MS = [50, 200, 800];
/** R3: `rebuild` keeps the last N days by default (a bounded permanent archive). */
export const REBUILD_SINCE_DAYS = 180;
/** The two storage modes (`collab.json` → `storage`); anything else = `sqlite`. */
export const STORAGE_MODES: string[] = ['sqlite', 'json'];

// ------------------------------------------- session contract (0.9.1, `11-20-collab-contract`)

/**
 * 0.9.1 (R1): one JSON file per session holding the five faces
 * (`mission / plan / todos / peers` + the `turn` counter). Like every other
 * global path here it is a **global** directory (a session may work across
 * workspaces) and `COLLAB_CONTRACT_DIR` overrides it for harness / sandbox runs.
 *
 * The file is created **lazily**: reading a contract never writes, only the
 * first `collab_mission set/confirm` / `collab_progress` / `collab_todo` write
 * creates it (design §3).
 */
export const CONTRACT_DIR =
  process.env.COLLAB_CONTRACT_DIR || join(homedir(), '.config', 'opencode', 'collab-contract');
/** The file shape this build writes; an unknown `v` is treated as empty + rewritten. */
export const CONTRACT_VERSION = 1;

/** `[mission] oneLine` is one line (whitespace collapsed) — cut here. */
export const CONTRACT_ONE_LINE_LIMIT = 300;
/** `inScope` / `outOfScope` are plain text lists (no matching in 0.9.2): bounded so the injection stays readable. */
export const CONTRACT_SCOPE_ITEMS = 20;
export const CONTRACT_SCOPE_CHARS = 100;
/** `handoffTo` maps an out-of-scope item to the session that owns it (0.9.2 reads it when `inScope:false`). */
export const CONTRACT_HANDOFF_ITEMS = 20;
/** One todo subject is one line — cut here. */
export const CONTRACT_TODO_SUBJECT_LIMIT = 200;
/**
 * Hard cap on **active** todos (open / doing / blocked / suspended): a full list
 * refuses a new one (readable error, never evicts). The 0.9.2 gate warns at 8
 * open; this storage guard stays higher so the PRD's 10-open injection fixture
 * is representable. Deliberately **not** a read-side truncation.
 */
export const CONTRACT_TODO_MAX_OPEN = 50;
/**
 * Read side: every active todo is kept; only closed/dropped history is trimmed
 * to this many of the most recent. A total-row `slice()` used to drop freshly
 * added open rows (silent loss + id reuse) — never reintroduce one.
 */
export const CONTRACT_TODO_KEEP_CLOSED = 50;
/** Milestones are 3–8 in practice; a typo must not grow the file forever. */
export const CONTRACT_MILESTONE_LIMIT = 30;
/** `wakeWhen` / `parkedBy` are one-liners shown in the injection. */
export const CONTRACT_WAKE_CHARS = 120;

/* ------------------------- drift + wake (0.9.3, `11-20-collab-drift`) */

/**
 * R1/D8: consecutive requests without mainline evidence before `[drift]` fires.
 * "Mainline evidence" = a lit milestone / a closed mainline todo / a commit that
 * touches `mission.taskPath` (the first two are what this plugin can observe).
 * Counting includes the request being rendered: the 5th request without evidence
 * is drift, the 4th is not.
 */
export const DRIFT_NO_ADVANCE_TURNS = 5;
/** R1: a suspended **mission** (`block`) older than this is drift too. */
export const DRIFT_PARKED_MS = 2 * 60 * 60 * 1000;
/**
 * R4/D17: the 24h fallback. `wakeWhen.kind:"time"` has a real deadline; a
 * `reply` / `decision` / `manual` wake cannot be observed cheaply from here, so
 * any suspended todo that has been parked this long is marked `drifted` (never
 * auto-closed) and enters the next `[drift]`.
 */
export const SUSPEND_FALLBACK_MS = 24 * 60 * 60 * 1000;
/**
 * What a suspended todo may wait for (`wakeWhen`). A legacy free-text string is
 * accepted and treated as `manual` (it is what 0.9.1 wrote).
 */
export const WAKE_KINDS = ['reply', 'decision', 'time', 'manual'] as const;
/** `collab_todo list` renders at most this many open rows, then "还有 N 条". */
export const CONTRACT_TODO_LIST_MAX = 20;

/**
 * 0.9.1 (R5, revised 0.9.2): the **four-section** injection. Fixed order,
 * accumulated, **stop at 12 lines** — a section that does not fit is dropped
 * whole (never half shown). Todo is one header + top-3; mission is head +
 * boundary + confirm hint. `drift` is a placeholder in this version (0.9.3 fills
 * it); `progress` appears only while milestones exist.
 *
 * 0.9.2 removed the `[scope]` section together with the keyword matcher behind
 * it: the plugin no longer guesses whether a message is out of scope — the
 * session states it itself on `collab_accept` (`scopeCheck`, `core/gate.ts`).
 */
export const INJECT_MAX_LINES = 12;
export const INJECT_SECTION_LIMITS = {
  mission: 3,
  todo: 4,
  /** 0.9.5: `[decide]` — one line summarising the open decisions waiting on somebody. */
  decide: 1,
  drift: 2,
  progress: 2
} as const;
/** How many open todos the `[todo]` section lists before "还有 N 条". */
export const INJECT_TODO_TOP = 3;

// ------------------------------------------- collaboration gate (0.9.2, `11-20-collab-gate`)

/**
 * R5 (revised): an open todo count at or above this appends **one reminder line**
 * to `accept` / `broadcast` / `handoff` — it never refuses. Handing work out is
 * how a list gets shorter; blocking it because the list is long would protect the
 * backlog instead of the mainline.
 *
 * Counting is the contract's open rows (`open / doing / blocked / suspended`);
 * storage keeps its own, higher hard cap (`CONTRACT_TODO_MAX_OPEN = 50`).
 */
export const GATE_TODO_LIMIT = 8;
/** `collab.json` → `gate`; anything else falls back to `enforce`. */
export const GATE_MODES: string[] = ['enforce', 'warn', 'off'];

// ------------------------------- facts ledger + tri-state + glossary (0.9.4)

/**
 * 0.9.4 (`11-20-collab-facts`, R1/D4): the workspace-level **facts ledger** —
 * one global file holding one ledger per workspace (`workspaces[dir]`), because
 * a fact is true (or not) *for a workspace*, not for a session and not for the
 * whole machine. `COLLAB_FACTS_FILE` overrides the path so tests never touch
 * `~/.config/opencode/`.
 *
 * Read once at module load, like every other global path here.
 */
export const FACTS_FILE = process.env.COLLAB_FACTS_FILE || join(homedir(), '.config', 'opencode', 'collab-facts.json');
/** The file shape this build writes; an unknown `v` is treated as empty + rewritten. */
export const FACTS_VERSION = 1;
/** A permanent ledger has a bound: the oldest non-active rows go first. */
export const FACTS_LIMIT = 2000;
/** D5: what a claim's evidence is worth. `unknown` = the sender did not label it. */
export const FACT_GRADES: string[] = ['measured', 'inferred', 'relayed', 'unknown'];
/** `settle` accepts all four (an explicit `unknown` is an honest "unlabeled"). */
export const FACT_SETTLE_GRADES: string[] = FACT_GRADES;
/** `relayed` / `unknown` may not be cited as another fact's evidence (R2/D5). */
export const FACT_WEAK_GRADES: string[] = ['relayed', 'unknown'];
export const FACT_STATES: string[] = ['active', 'superseded', 'retracted'];
export const FACT_CLAIM_LIMIT = 300;
export const FACT_EVIDENCE_LIMIT = 500;
export const FACT_REASON_LIMIT = 200;
/** `collab_fact list` renders at most this many rows, then "还有 N 条". */
export const FACT_LIST_MAX = 30;
/** The `[stale]` instruction (design §6): what a stale reply must (not) do. */
export const STALE_REPLY_RATIO = 0.3;

/**
 * 0.9.4 (R6): the pair glossary — one file for all `(from, to)` pairs, keyed by
 * the two session ids sorted. `COLLAB_GLOSSARY_FILE` overrides it (tests).
 */
export const GLOSSARY_FILE =
  process.env.COLLAB_GLOSSARY_FILE || join(homedir(), '.config', 'opencode', 'collab-glossary.json');
export const GLOSSARY_VERSION = 1;
/** R6: 3–10 terms per pair; the injection line shows at most 5 of them. */
export const GLOSSARY_TERMS_MIN = 3;
export const GLOSSARY_TERMS_MAX = 10;
export const GLOSSARY_LINE_TERMS = 5;
export const GLOSSARY_TERM_CHARS = 40;
export const GLOSSARY_MEANING_CHARS = 200;
/** R6: the **second** conflict over the same term refuses until it is defined. */
export const GLOSSARY_CONFLICT_LIMIT = 2;

// --------------------------------------- decision ledger + roles (0.9.5)

/**
 * 0.9.5 (`11-20-collab-decide`, R1): the **decision ledger** — one JSON file per
 * subject key (`<threadID>` for a thread, `<bid>` for a hand-off), because a
 * decision is about *that* conversation, and two conversations must never share
 * a `D#` namespace. `COLLAB_DECISIONS_DIR` overrides the directory so tests
 * never touch `~/.config/opencode/`.
 *
 * A file is created lazily (reading never writes) and every write is a
 * read-modify-write under the shared cross-process `file-lock` + `tmp + rename`.
 */
export const DECISIONS_DIR =
  process.env.COLLAB_DECISIONS_DIR || join(homedir(), '.config', 'opencode', 'collab-decisions');
/** The file shape this build writes; an unknown `v` is treated as empty. */
export const DECISIONS_VERSION = 1;
/**
 * D9: at most this many **open** decisions per key. The 24 hand-offs had 0
 * recorded decisions while 19 "决策" messages bounced back and forth — a list
 * that can grow without a cap is a chat, not a ledger.
 */
export const DECISION_OPEN_LIMIT = 3;
/**
 * Review B2: a `conflict` decision nobody answered for this long is superseded
 * automatically so the thread's read-only degradation can never become permanent.
 */
export const CONFLICT_DECISION_TTL_MS = 24 * 60 * 60 * 1000;
export const DECISION_QUESTION_LIMIT = 300;
export const DECISION_OPTION_CHARS = 120;
export const DECISION_OPTIONS_MAX = 6;
export const DECISION_ANSWER_LIMIT = 500;
export const DECISION_REASON_LIMIT = 200;
/** `collab_decide list` renders at most this many rows. */
export const DECISION_LIST_MAX = 20;
/**
 * 0.9.7 (`11-21-collab-decision-inbox`): how many rows the inbox shows by
 * default (tool `limit`, and the snapshot block's `items`). The header / total
 * still counts every open decision **of the scanned ledger**, so a truncated
 * list never understates the set it actually read.
 */
export const DECISION_INBOX_LIMIT = 20;
/**
 * 0.9.7 (review): how many ledger **files** the inbox reads. `readAllDecisions`
 * is bounded to the newest 500 names, which silently dropped the oldest waits
 * (520 keys → `total:500`, `k0001` missing); the inbox therefore scans the
 * directory itself with this explicit bound. Past it the answer says
 * `已扫描 M/N 个 key` and warns `⚠账本 N 个 key，仅扫描 M 个` — it never reports
 * the scanned subset as the whole ledger.
 */
export const DECISION_INBOX_SCAN_LIMIT = 2000;
/** The board polls every 2 s; a scan result is reused for one poll period. */
export const DECISION_INBOX_CACHE_MS = 2000;
/**
 * Design §6: a `conflict` verdict (both sides ahead in different dimensions) is
 * not a conversation topic — it opens a decision with these options.
 */
export const CONFLICT_DECISION_OPTIONS = ['以我方为准', '以对方为准', '重新测量'];

/** Keep in sync with `package.json` (`the harness asserts equality`). */
export const PLUGIN_VERSION = '0.9.6';
