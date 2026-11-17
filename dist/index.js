import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
// src/constants.ts
const CONFIG_PATH = process.env.COLLAB_CONFIG || join(homedir(), ".config", "opencode", "collab.json");
const LEGACY_ALIAS_PATH = join(homedir(), ".config", "opencode", "collab-aliases.json");
const STORAGE_ALIASES = "collab/aliases";
const STORAGE_DELIVERED = "collab/delivered";
const inboxKey = (sessionID) => `collab/inbox/${sessionID}`;
const threadKey = (threadID) => `collab/threads/${threadID}`;
/** Legacy sender prefix (`[collab:<from>] `), still matched for CLI-sent text. */
const COLLAB_PREFIX_RE = /^\[collab:([^\]]*)\]/;
/** Full envelope: `[collab:<from>][<kind>:<threadID>] <body>` (thread optional). */
const COLLAB_ENVELOPE_RE = /^\[collab:([^\]]*)\](?:\[([a-z]+)(?::([^\]]*))?\])?\s*/;
/** Inbox keeps the whole body (up to this) so `collab_inbox` can return it in full. */
const INBOX_TEXT_LIMIT = 4e3;
const KINDS = [
	"request",
	"reply",
	"note"
];
const STATUSES = [
	"open",
	"answered",
	"closed"
];
/**
* Built-in hard list. Always protected, whatever the config file says:
* these sessions — and every descendant that carries them in its `parentID`
* chain — are never valid `collab_send` targets.
* (schema line + the long-lived main line.)
*/
const BUILTIN_PROTECT = ["ses_e1eb91cebffeTv1467ubJLKebk", "ses_e23a4a23fffe4c4m7UQFR8dUL3"];
/**
* Read-only agents never get `steer`: they are demoted to `queue` so an inbound
* request can never merge into the turn they are already running.
* (Agent ids come from the `context` hook / tool context; extend via config.)
*/
const DEFAULT_READONLY_AGENTS = ["explore", "plan"];
/**
* Only inbox admissions matter for the unread queue. Event names come from the
* server's own `V2Event` union, verified live by a probe plugin.
*/
const EVENT_TYPES = ["session.inbox.enqueued"];
const DEFAULTS = {
	aliases: {},
	autoDeliver: true,
	maxInject: 3,
	/** R8: the package never patches a session's permissions / agent by default. */
	allowWrite: false,
	protect: BUILTIN_PROTECT,
	readonlyAgents: DEFAULT_READONLY_AGENTS
};
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
const BROADCAST_DIR = process.env.COLLAB_BROADCAST_DIR || join(homedir(), ".config", "opencode", "collab-broadcast");
/** Ask lease: a `claimed` hand-off reopens after this. */
const BCAST_LEASE_MS = 3e5;
/** "Recently active" window used by the +5 signal. */
const BCAST_RECENT_MS = 72e5;
const SCORE_MESSAGE_WINDOW_MS = 6048e5;
/** Hand-off states. */
const BCAST_STATES = [
	"open",
	"claimed",
	"acked",
	"done",
	"blocked",
	"expired"
];
const BCAST_DONE_STATES = [
	"done",
	"blocked",
	"expired"
];
const EXPECTED = ["implement", "review"];
/** Spawned sessions get this title so `collab_list` can mark them `[bootstrap]`. */
const BOOTSTRAP_TITLE_RE = /^(impl|review):/;
/**
* The **only** capabilities this plugin may ever add to a session: the five
* `collab_*` actions it owns. Anything else — `edit` / `write` / `shell` /
* `read` / … — is refused before a request is built, so `collab_grant` can never
* be turned into a privilege-escalation tool.
*/
const COLLAB_TOOL_ACTIONS = [
	"collab_list",
	"collab_inbox",
	"collab_wait",
	"collab_reply",
	"collab_send"
];
/**
* Agents `collab_promote` may switch a session **to**. `explore` stays the
* read-only default; promotion is only for a session that has ACCEPTed a
* hand-off and needs to change code.
*/
const PROMOTE_AGENTS = ["build", "plan"];
/** `Permission.Effect` (server enum) — a restored snapshot may contain all three. */
const PERMISSION_EFFECTS = [
	"allow",
	"deny",
	"ask"
];
/**
* Grant ledger: one file per session holding the **pre-grant** ruleset, so
* `collab_grant {revoke:true}` restores exactly what was there instead of
* deleting five rules that may have pre-existed.
* `COLLAB_GRANT_DIR` overrides the directory (harness / sandbox runs).
*/
const GRANT_DIR = process.env.COLLAB_GRANT_DIR || join(homedir(), ".config", "opencode", "collab-grants");
/**
* Optional HTTP fallback for hosts that do not expose `ctx.session.update`.
* The base URL is never guessed: it must be configured, because a wrong port
* could patch an unrelated instance.
*/
const SERVER_URL = String(process.env.COLLAB_SERVER_URL ?? "").trim().replace(/\/+$/, "");
const SERVER_TOKEN = String(process.env.COLLAB_SERVER_TOKEN ?? "").trim();
// src/log.ts
/**
* One-line setup/runtime visibility. A plugin that fails to load is silently
* absent and a subscribe loop that dies is silent too, so every diagnostic is
* logged here — once per occurrence, never per event.
*/
function log(...args) {
	console.error("[collab]", ...args);
}
/** `error?.message ?? error` — the exact text the single-file plugin printed. */
function errText(error) {
	return String(error?.message ?? error);
}
/** `error?.code` for `open(…, "wx")` / fs failures. */
function errCode(error) {
	return error?.code;
}
// src/util.ts
/** `statSync().mtimeMs`, or 0 when the file does not exist (config cache stamp). */
function mtime(path) {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}
function readJsonFile(path) {
	try {
		if (!existsSync(path)) return void 0;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		log(`ignoring unreadable ${path}: ${errText(error)}`);
		return;
	}
}
function clamp(value, min, max) {
	const n = Number(value);
	if (!Number.isFinite(n)) return min;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}
function truncate(text, max = 200) {
	const value = String(text ?? "").replace(/\s+/g, " ").trim();
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
/** Like `truncate`, but keeps line breaks — used where the full body matters. */
function truncateRaw(text, max = 4e3) {
	const value = String(text ?? "").trim();
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
/** `{}` for anything that is not a plain object (arrays included). */
function asObject(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function dedupe(list) {
	return [...new Set(list.filter((item) => typeof item === "string" && Boolean(item)))];
}
function shortID(sessionID) {
	const value = String(sessionID ?? "");
	return value.startsWith("ses_") ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}
function fmtTime(ms) {
	if (!ms) return "--:--:--";
	const d = new Date(Number(ms));
	const p = (n) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** `busy` / `idle` / `archived` of a session, as the tools print it. */
function sessionState(info) {
	const time = asObject(info?.time);
	if (time.archived) return "archived";
	if (time.busy && (!time.idle || time.busy > time.idle)) return "busy";
	return "idle";
}
async function withTimeout(promise, timeoutMs, message) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
/** Four base-36 chars; unique enough inside a `t_`/`c_`/`k_` id, no crypto needed. */
function randToken() {
	return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}
function hash16(text) {
	return createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}
// src/ids.ts
/** `t_<base36ts>_<rand4>` — unique enough across sessions; no distributed ordering. */
function newThreadID() {
	return `t_${Date.now().toString(36)}_${randToken()}`;
}
/** Per-delivery correlation id; echoed through message metadata for de-duplication. */
function newCorrelationID() {
	return `c_${Date.now().toString(36)}_${randToken()}`;
}
function isValidThreadID(value) {
	return typeof value === "string" && /^t_[0-9a-z]+_?[0-9a-z]*$/.test(value);
}
/**
* `undefined`/`null`/`"undefined"` all mean "no thread here" — legacy CLI text
* and old stored records can leak the literal string, which used to be rendered
* as `collab_reply {threadID:"undefined"}` in the injection hint.
*/
function normalizeThreadID(value) {
	const text = String(value ?? "").trim();
	return text && text !== "undefined" && text !== "null" ? text : void 0;
}
function normalizeKind(value, fallback = "request") {
	const kind = String(value ?? "").trim();
	return KINDS.includes(kind) ? kind : fallback;
}
function normalizeStatus(value) {
	const status = String(value ?? "").trim();
	return STATUSES.includes(status) ? status : "open";
}
/** Collapse whitespace so text-derived de-duplication compares the same body. */
function normalizeText(text) {
	return String(text ?? "").replace(COLLAB_ENVELOPE_RE, "").replace(/\s+/g, " ").trim();
}
function envelope({ from, kind, threadID, body }) {
	return `[collab:${from}]${threadID ? `[${kind}:${threadID}]` : `[${kind}]`} ${body}`;
}
function parseEnvelope(text) {
	const value = String(text ?? "");
	const match = COLLAB_ENVELOPE_RE.exec(value);
	if (!match) return void 0;
	const kind = match[2] && KINDS.includes(match[2]) ? match[2] : void 0;
	return {
		from: match[1] || void 0,
		kind,
		threadID: match[3] || void 0,
		body: value.slice(match[0].length)
	};
}
/**
* Wake-up signal shared by `collab_wait {threadID}` and the inbox event loop, so
* a reply is observed immediately instead of on the next poll tick.
*/
function createSignal() {
	const waiters = /* @__PURE__ */ new Set();
	return {
		notify() {
			for (const done of waiters) done();
		},
		wait(timeoutMs) {
			return new Promise((resolve) => {
				let timer;
				const done = () => {
					clearTimeout(timer);
					waiters.delete(done);
					resolve();
				};
				timer = setTimeout(done, timeoutMs);
				waiters.add(done);
			});
		}
	};
}
// src/core/messages.ts
/** De-dup key used when message metadata is unavailable. */
function messageKey(message) {
	return [
		normalizeKind(message?.kind),
		normalizeThreadID(message?.threadID) ?? "",
		normalizeText(message?.text)
	].join("|");
}
function messageIDs(message) {
	return [message?.cid, message?.id].filter((value) => typeof value === "string" && Boolean(value));
}
/**
* Messages already present in *this* request. `collab_send` admits the body as
* a normal user turn, so it shows up in `event.messages`; injecting the same
* text again from the inbox store is what made the previous version redundant.
* Metadata is exposed read-only on context-hook messages, with an envelope-text
* fallback when it is missing.
*/
function collectRequestKeys(event) {
	const cids = /* @__PURE__ */ new Set();
	const keys = /* @__PURE__ */ new Set();
	const texts = /* @__PURE__ */ new Set();
	const messages = Array.isArray(event?.messages) ? event?.messages : [];
	for (const message of messages) {
		const meta = asObject(asObject(message?.metadata).collab);
		if (meta.cid) cids.add(String(meta.cid));
		if (meta.kind || meta.threadID) keys.add(messageKey(meta));
		const parts = Array.isArray(message?.parts) ? message.parts : Array.isArray(message?.content) ? message.content : [];
		for (const part of parts) {
			const block = asObject(part);
			const text = typeof block.text === "string" ? block.text : typeof block.content === "string" ? block.content : "";
			if (!text) continue;
			const parsed = parseEnvelope(text);
			if (!parsed) continue;
			keys.add([
				normalizeKind(parsed.kind),
				String(parsed.threadID ?? ""),
				normalizeText(parsed.body)
			].join("|"));
			texts.add(normalizeText(parsed.body));
		}
	}
	return {
		cids,
		keys,
		texts
	};
}
/** Cursor = leading run of messages already accounted for (injected or shown). */
function cursorFrom(messages, injected) {
	const seen = new Set(injected);
	let index = 0;
	while (index < messages.length && messageIDs(messages[index]).some((id) => seen.has(id))) index++;
	return index;
}
// src/hooks/context.ts
/**
* Injection: append at most one compact system block to the next request of
* *this* session only. Two sources share it:
*
*   a) unread cross-session messages (deduplicated by inboxID/cid and by
*      "already part of this very request");
*   b) the hand-off chain: open group broadcasts this session has not seen yet,
*      and unresolved hand-offs it started (each exactly once per session —
*      `seenBy` / `reminded` live in the broadcast file).
*
* Never throws: a model request must not fail because of collab bookkeeping.
*/
function createContextHook(deps) {
	const { readConfig, inbox, threads, chain } = deps;
	/**
	* Unread cross-session messages. Only messages that are neither already
	* injected nor part of this very request are surfaced, so a hand-off never
	* shows up twice (the body is already a user turn of its own).
	*/
	async function injectInbox(event) {
		const config = readConfig();
		if (!config.autoDeliver) return void 0;
		const sessionID = event?.sessionID;
		if (!sessionID) return void 0;
		const box = await inbox.read(sessionID);
		if (!box.messages.length) return void 0;
		const inRequest = collectRequestKeys(event);
		const accounted = new Set(box.injected);
		const pending = [];
		const acknowledge = (message) => {
			for (const id of messageIDs(message)) accounted.add(id);
		};
		for (const message of box.messages) {
			if (messageIDs(message).some((id) => accounted.has(id))) continue;
			if (message.cid && inRequest.cids.has(message.cid)) {
				acknowledge(message);
				continue;
			}
			if (inRequest.keys.has(messageKey(message)) || inRequest.texts.has(normalizeText(message.text))) {
				acknowledge(message);
				continue;
			}
			if (normalizeKind(message.kind) === "request") {
				const messageThread = normalizeThreadID(message.threadID);
				if (messageThread) {
					const thread = await threads.read(messageThread);
					if (thread && thread.status !== "open") {
						acknowledge(message);
						continue;
					}
				}
			}
			pending.push(message);
		}
		const markAccounted = box.injected.length !== accounted.size;
		const shown = pending.slice(0, config.maxInject);
		if (!shown.length) {
			if (markAccounted) await inbox.update(sessionID, (current) => {
				const nextInjected = dedupe([...accounted]);
				return {
					...current,
					injected: nextInjected,
					cursor: cursorFrom(current.messages, nextInjected)
				};
			});
			return;
		}
		for (const message of shown) acknowledge(message);
		const rest = pending.length - shown.length;
		const requests = shown.filter((message) => normalizeKind(message.kind) === "request");
		const replies = shown.filter((message) => normalizeKind(message.kind) === "reply");
		const notes = shown.filter((message) => normalizeKind(message.kind) === "note");
		const head = [
			requests.length ? `待处理请求 ${requests.length} 条` : "",
			replies.length ? `新回执 ${replies.length} 条` : "",
			notes.length ? `新消息 ${notes.length} 条` : ""
		].filter(Boolean).join(" / ");
		const lineOf = (message) => {
			const kind = normalizeKind(message.kind);
			const threadID = normalizeThreadID(message.threadID);
			const hint = kind === "request" ? threadID ? ` → 处理后用 collab_reply {threadID:"${threadID}"}` : " → 无 thread 关联，无需回执；直接处理即可（或 collab_send 发起新请求）" : kind === "reply" ? threadID ? ` → 用 collab_wait {threadID:"${threadID}"} 取全文` : " → 无 thread 关联，无需等待回执" : "";
			return `- ${kind.padEnd(7)} ${threadID ?? "-"} from=${message.from}: ${truncate(message.text)}${hint}`;
		};
		await inbox.update(sessionID, (current) => {
			const nextInjected = dedupe([...accounted]);
			return {
				...current,
				injected: nextInjected,
				cursor: cursorFrom(current.messages, nextInjected)
			};
		});
		return [
			`[collab] ${head}`,
			...[
				...requests,
				...replies,
				...notes
			].map(lineOf),
			rest > 0 ? `…还有 ${rest} 条，调用 collab_inbox 查看全文。` : "全文/状态用 collab_inbox。"
		].join("\n");
	}
	/** Group broadcasts + unclosed hand-offs, each surfaced once per session. */
	async function injectChain(event) {
		const lines = await chain.injectionFor(event?.sessionID, deps.ctx?.location?.directory);
		if (!lines.length) return void 0;
		return [`[collab-handoff] 交接链路提醒（每条只出现一次）:`, ...lines].join("\n");
	}
	return async function contextHook(event) {
		try {
			if (!event?.sessionID || !Array.isArray(event?.system)) return;
			const blocks = [];
			const inboxText = await injectInbox(event);
			if (inboxText) blocks.push(inboxText);
			const chainText = await injectChain(event);
			if (chainText) blocks.push(chainText);
			if (blocks.length) event.system.push({
				type: "text",
				text: blocks.join("\n\n")
			});
		} catch (error) {
			log("context hook failed:", error?.message ?? error);
		}
	};
}
// src/config.ts
/** Read `collab.json` + `collab-aliases.json` + `ctx.options` into one value. */
function loadConfig(options) {
	const fromOptions = asObject(options);
	const file = asObject(readJsonFile(CONFIG_PATH));
	const legacyAliases = asObject(readJsonFile(LEGACY_ALIAS_PATH));
	return {
		aliases: {
			...asObject(DEFAULTS.aliases),
			...asObject(fromOptions.aliases),
			...legacyAliases,
			...asObject(file.aliases)
		},
		autoDeliver: typeof file.autoDeliver === "boolean" ? file.autoDeliver : typeof fromOptions.autoDeliver === "boolean" ? fromOptions.autoDeliver : DEFAULTS.autoDeliver,
		maxInject: clamp(file.maxInject ?? fromOptions.maxInject ?? DEFAULTS.maxInject, 1, 10),
		allowWrite: typeof file.allowWrite === "boolean" ? file.allowWrite : typeof fromOptions.allowWrite === "boolean" ? fromOptions.allowWrite : DEFAULTS.allowWrite,
		protect: dedupe([
			...BUILTIN_PROTECT,
			...Array.isArray(fromOptions.protect) ? fromOptions.protect : [],
			...Array.isArray(file.protect) ? file.protect : []
		]),
		readonlyAgents: dedupe([
			...DEFAULT_READONLY_AGENTS,
			...Array.isArray(fromOptions.readonlyAgents) ? fromOptions.readonlyAgents : [],
			...Array.isArray(file.readonlyAgents) ? file.readonlyAgents : []
		])
	};
}
/**
* Config is re-read lazily on every use (mtime-cached) instead of once in
* `setup`, so editing `collab.json` (aliases / protect / autoDeliver /
* maxInject / allowWrite) takes effect immediately — no plugin reload or server
* restart.
*/
function createConfigReader(options) {
	let cache;
	return function readConfig() {
		const stamp = `${mtime(CONFIG_PATH)}:${mtime(LEGACY_ALIAS_PATH)}`;
		if (cache?.stamp === stamp) return cache.config;
		const config = loadConfig(options);
		cache = {
			stamp,
			config
		};
		return config;
	};
}
// src/core/claim.ts
function isValidBid(value) {
	return /^b_[0-9a-f]{8,32}$/.test(String(value ?? "").trim());
}
function bcastFile(bid) {
	return join(BROADCAST_DIR, `${bid}.json`);
}
function bcastLock(bid) {
	return join(BROADCAST_DIR, `${bid}.lock`);
}
function readBroadcast(bid) {
	if (!isValidBid(bid)) return void 0;
	const raw = readJsonFile(bcastFile(String(bid)));
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
	return normalizeBroadcast({
		...asObject(raw),
		bid: String(asObject(raw).bid ?? bid)
	});
}
function normalizeBroadcast(record) {
	const asked = asObject(record.asked);
	return {
		...record,
		bid: String(record.bid),
		scope: record.scope === "local" ? "local" : "peer",
		state: BCAST_STATES.includes(record.state) ? record.state : "open",
		candidates: Array.isArray(record.candidates) ? record.candidates : [],
		replies: Array.isArray(record.replies) ? record.replies : [],
		seenBy: Array.isArray(record.seenBy) ? record.seenBy.filter((id) => typeof id === "string") : [],
		askSeen: Array.isArray(record.askSeen) ? record.askSeen.filter((id) => typeof id === "string") : [],
		reminded: Array.isArray(record.reminded) ? record.reminded.filter((id) => typeof id === "string") : [],
		skipped: Array.isArray(record.skipped) ? record.skipped.filter((id) => typeof id === "string") : [],
		declines: Array.isArray(record.declines) ? record.declines : [],
		asked: asked.sid ? {
			sid: String(asked.sid),
			at: Number(asked.at) || 0,
			leaseMs: Number(asked.leaseMs) || 3e5
		} : void 0,
		attempts: Number(record.attempts) || 0,
		createdAt: Number(record.createdAt) || 0,
		updatedAt: Number(record.updatedAt) || 0
	};
}
/**
* Delete decided hand-offs that are past `BCAST_RETENTION_MS`. Runs on write
* only — a preview / a `collab_list` snapshot never deletes anything.
* `open` / `claimed` / `acked` records are never touched (still somebody's job),
* and a single write sweeps at most `BCAST_PRUNE_LIMIT` files so a huge backlog
* decays over a few writes instead of stalling one call.
*
* The matching `<bid>.lock` is removed together with the record: a decided
* hand-off should have released it already (`applyReceipt` / lease expiry), and
* an orphan lock would poison a later re-broadcast of the same content.
*/
function pruneBroadcasts(now = Date.now()) {
	let names;
	try {
		names = readdirSync(BROADCAST_DIR);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		if (removed >= 20) break;
		if (!name.startsWith("b_") || !name.endsWith(".json")) continue;
		const bid = name.slice(0, -5);
		const record = readBroadcast(bid);
		if (!record || !BCAST_DONE_STATES.includes(String(record.state))) continue;
		const stamp = Number(record.updatedAt || record.createdAt || 0);
		if (!stamp || now - stamp <= 6048e5) continue;
		try {
			unlinkSync(bcastFile(bid));
			removed += 1;
		} catch {
			continue;
		}
		try {
			unlinkSync(bcastLock(bid));
		} catch {}
	}
	return removed;
}
/** Atomic replace: write `<bid>.json.<rand>.tmp`, then `rename`. */
function writeBroadcast(record) {
	const next = {
		...normalizeBroadcast(record),
		updatedAt: Date.now()
	};
	mkdirSync(BROADCAST_DIR, { recursive: true });
	const tmp = `${bcastFile(next.bid)}.${randToken()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
	renameSync(tmp, bcastFile(next.bid));
	pruneBroadcasts(next.updatedAt);
	return next;
}
function allBroadcasts() {
	let names;
	try {
		names = readdirSync(BROADCAST_DIR);
	} catch {
		return [];
	}
	const out = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const record = readBroadcast(name.slice(0, -5));
		if (record) out.push(record);
	}
	return out;
}
/**
* Candidates that may still be asked: score ≥ threshold and not skipped yet.
* `skipped` is the serial-ask cursor — DECLINE, ask timeout and a lapsed claim
* all push the session in there, so it is never asked twice.
*/
function askableCandidates(record) {
	return (record.candidates ?? []).filter((candidate) => Number(candidate?.score) >= 80 && !(record.skipped ?? []).includes(candidate.sid));
}
/**
* Ask the next candidate (top-1 串行). `asked` holds the *only* session that
* currently owes an ACCEPT / DECLINE and the moment it was asked, so the 5-min
* ask lease can be evaluated on any later read (no daemon).
* Returns false when no candidate is left — callers turn that into `expired`.
*/
function planAsk(record, now = Date.now()) {
	const next = askableCandidates(record)[0];
	if (!next?.sid) {
		delete record.asked;
		return false;
	}
	record.asked = {
		sid: String(next.sid),
		at: now,
		leaseMs: BCAST_LEASE_MS
	};
	return true;
}
/**
* DECLINE (explicit) and ask-timeout (implicit) share one transition:
* attempts+1, the session becomes `skipped`, the next candidate is asked.
* Exhausted candidates or `attempts > 3` → `expired` (escalate to a human);
* crucially this never spawns — spawn only happens when *no* candidate ≥ 80.
*/
function declineAsked(record, sid, now = Date.now()) {
	record.attempts = (record.attempts ?? 0) + 1;
	record.skipped = dedupe([...record.skipped ?? [], String(sid)]);
	record.declines = [...Array.isArray(record.declines) ? record.declines : [], {
		sid: String(sid),
		at: now
	}].slice(-50);
	delete record.asked;
	if (!planAsk(record, now) || (record.attempts ?? 0) > 3) record.state = "expired";
	return record;
}
/**
* Lease bookkeeping, applied on every read:
*   - `claimed` past its lease → reopen, attempts+1, skip the holder, release
*     the lock (matched by holder *or* by `claimBy`, see `releaseLock`);
*   - `asked` (state `open`) past its lease → same as an explicit DECLINE;
*   - past `BCAST_MAX_ATTEMPTS` → `expired` (escalate to a human, no re-delivery).
*/
function refreshBroadcast(input, now = Date.now()) {
	if (!input) return input;
	const record = normalizeBroadcast(input);
	const claim = asObject(record.claim);
	if (record.state === "claimed" && claim.by && now - Number(claim.at || 0) > 3e5) {
		record.state = "open";
		record.attempts = (record.attempts ?? 0) + 1;
		record.skipped = dedupe([...record.skipped ?? [], String(claim.by)]);
		record.expiredClaim = {
			...claim,
			expiredAt: now
		};
		delete record.claim;
		releaseLock(record.bid, [String(claim.by), String(claim.spawner ?? "")]);
		if (claim.kind === "spawn") delete record.asked;
		else planAsk(record, now);
	}
	const asked = asObject(record.asked);
	if (record.state === "open" && asked.sid && now - Number(asked.at || 0) > (Number(asked.leaseMs) || 3e5)) declineAsked(record, String(asked.sid), now);
	if (!BCAST_DONE_STATES.includes(String(record.state)) && (record.attempts ?? 0) > 3) record.state = "expired";
	return record;
}
/**
* Read-only lease verdict for `collab_list`: it *describes* whether the
* claim / ask lease has lapsed without refreshing the record, writing anything
* or releasing a lock — a listing must not mutate other sessions' hand-offs.
* `undefined` = no lease applies (open without an ask, done, …).
*/
function leaseVerdict(record, now = Date.now()) {
	if (record.state === "claimed") {
		const claim = asObject(record.claim);
		const at = Number(claim.at || 0);
		if (!at) return "expired";
		return now - at > (Number(claim.leaseMs) || 3e5) ? "expired" : "ok";
	}
	if (record.state === "open" && record.asked?.sid) {
		const at = Number(record.asked.at || 0);
		if (!at) return "expired";
		return now - at > (Number(record.asked.leaseMs) || 3e5) ? "expired" : "ok";
	}
}
/**
* Atomic claim: `open(<bid>.lock, "wx")` — exactly one caller creates the file,
* everyone else reads the holder out of it. The lock is never recreated for a
* decided hand-off, so a second `collab_accept` always answers "already
* claimed" (and a lost spawn race cannot create a second session).
*/
function claimLock(bid, claim) {
	mkdirSync(BROADCAST_DIR, { recursive: true });
	let fd;
	try {
		fd = openSync(bcastLock(bid), "wx");
	} catch (error) {
		if (errCode(error) !== "EEXIST") throw error;
		return {
			ok: false,
			holder: asObject(readJsonFile(bcastLock(bid)))
		};
	}
	const value = {
		bid,
		token: `k_${Date.now().toString(36)}_${randToken()}`,
		at: Date.now(),
		...claim
	};
	try {
		writeSync(fd, JSON.stringify(value));
	} finally {
		closeSync(fd);
	}
	return {
		ok: true,
		claim: value
	};
}
function persistRefresh(before, after) {
	if (!after) return before;
	return before?.state !== after.state || (before?.attempts ?? 0) !== after.attempts || (before?.skipped ?? []).length !== (after.skipped ?? []).length || Boolean(before?.claim) !== Boolean(after.claim) || (before?.asked?.sid ?? "") !== (after.asked?.sid ?? "") ? writeBroadcast(after) : after;
}
/**
* Drop a lock only when the caller really owns it. A spawned session's hand-off
* is locked by the **spawner** (`by`) while the record's `claim.by` is the new
* session (`claimBy`, written right after `ctx.session.create`), so both fields
* are accepted — otherwise a spawn lock could never be released.
*/
function releaseLock(bid, expected) {
	const wanted = new Set((Array.isArray(expected) ? expected : [expected]).filter(Boolean).map(String));
	if (!wanted.size) return;
	const holder = asObject(readJsonFile(bcastLock(bid)));
	if (![holder.by, holder.claimBy].filter(Boolean).map(String).some((owner) => wanted.has(owner))) return;
	try {
		unlinkSync(bcastLock(bid));
	} catch {}
}
/** Rewrite the lock file in place (only used to record the real claimant). */
function updateLock(bid, patch) {
	const holder = asObject(readJsonFile(bcastLock(bid)));
	if (!holder.by) return;
	try {
		writeFileSync(bcastLock(bid), JSON.stringify({
			...holder,
			...patch
		}));
	} catch (error) {
		log(`updateLock failed for ${bid}: ${errText(error)}`);
	}
}
// src/core/grants.ts
/** The five allow rules this plugin adds — always rebuilt from the whitelist. */
function collabPermissionRules() {
	return COLLAB_TOOL_ACTIONS.map((action) => ({
		action,
		resource: "*",
		effect: "allow"
	}));
}
/**
* Keep only well-formed `Permission.Rule`s (`{action, resource, effect}` with a
* known effect). Unknown shapes are dropped rather than forwarded: the host
* rejects the whole ruleset on one invalid entry, which would lose the merge.
*/
function normalizeRules(value) {
	if (!Array.isArray(value)) return [];
	const rules = [];
	for (const item of value) {
		const rule = asObject(item);
		const action = String(rule.action ?? "").trim();
		const resource = String(rule.resource ?? "").trim();
		const effect = String(rule.effect ?? "").trim();
		if (!action || !resource || !PERMISSION_EFFECTS.includes(effect)) continue;
		rules.push({
			action,
			resource,
			effect
		});
	}
	return rules;
}
/** Rules are matched on `action + resource` — the API has no other identity. */
function ruleKey(rule) {
	return `${rule.action}\u0000${rule.resource}`;
}
/**
* Merge, never replace: `base` keeps its order *and* its precedence, then only
* rules whose `action+resource` is not present yet are appended. A `deny`
* already on the session therefore stays a `deny` (no widening by re-granting).
*/
function mergeRules(base, add) {
	const merged = [];
	const seen = /* @__PURE__ */ new Set();
	for (const rule of [...normalizeRules(base), ...normalizeRules(add)]) {
		const key = ruleKey(rule);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push({
			action: rule.action,
			resource: rule.resource,
			effect: rule.effect
		});
	}
	return merged;
}
/** Rules of `rules` that `base` does not contain yet (for previews / records). */
function missingRules(base, rules) {
	const existing = new Set(normalizeRules(base).map((rule) => ruleKey(rule)));
	return normalizeRules(rules).filter((rule) => !existing.has(ruleKey(rule)));
}
/**
* Fail-closed whitelist: the *add* payload may only carry the five `collab_*`
* actions with `effect:"allow"`. A restored snapshot is deliberately **not**
* checked against this list — it is the ruleset that was there before.
*/
function assertCollabOnly(rules) {
	if (!Array.isArray(rules) || rules.length === 0) throw new Error("拒绝授权：规则集为空（只允许 5 条 collab_* 动作）。");
	for (const rule of rules) {
		const action = String(rule?.action ?? "");
		if (!COLLAB_TOOL_ACTIONS.includes(action)) throw new Error(`拒绝授权：action="${action}" 不在白名单内（只允许 ${COLLAB_TOOL_ACTIONS.join(" / ")}，不授予 edit/write/shell 等任何额外能力）。`);
		if (rule?.effect !== "allow") throw new Error(`拒绝授权：collab 动作只允许 effect="allow"（收到 "${String(rule?.effect)}"）。`);
	}
	return rules;
}
function grantFile(sessionID) {
	return join(GRANT_DIR, `${String(sessionID ?? "").replace(/[^\w.-]/g, "_")}.json`);
}
function normalizeGrant(record) {
	const raw = asObject(record);
	if (!raw.sid) return void 0;
	const out = { sid: String(raw.sid) };
	if (Array.isArray(raw.before)) out.before = normalizeRules(raw.before);
	if (Array.isArray(raw.added)) out.added = dedupe(raw.added);
	if (raw.at !== void 0 && raw.at !== null) out.at = Number(raw.at) || 0;
	if (typeof raw.by === "string" && raw.by) out.by = raw.by;
	if (typeof raw.reason === "string" && raw.reason) out.reason = raw.reason;
	if (typeof raw.agentBefore === "string" && raw.agentBefore) out.agentBefore = raw.agentBefore;
	if (raw.promotedAt !== void 0 && raw.promotedAt !== null) out.promotedAt = Number(raw.promotedAt) || 0;
	if (typeof raw.promotedBy === "string" && raw.promotedBy) out.promotedBy = raw.promotedBy;
	return out;
}
function readGrant(sessionID) {
	const raw = readJsonFile(grantFile(sessionID));
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
	return normalizeGrant(raw);
}
/**
* Merge-then-replace (tmp + rename), same shape as the broadcast store:
* a write carries only the half it touched, the other half is preserved from
* the file. Passing `null` clears a field; a record with neither `before` nor
* `agentBefore` left is deleted instead of being kept as an empty shell.
*/
function writeGrant(record) {
	const raw = asObject(record);
	const sid = String(raw.sid ?? "");
	if (!sid) return void 0;
	const next = normalizeGrant({
		...readGrant(sid) ?? { sid },
		...raw
	});
	if (!next) return void 0;
	if (!next.before && !next.agentBefore) {
		removeGrant(sid);
		return;
	}
	mkdirSync(GRANT_DIR, { recursive: true });
	const tmp = `${grantFile(sid)}.${randToken()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
	renameSync(tmp, grantFile(sid));
	return next;
}
function removeGrant(sessionID) {
	try {
		unlinkSync(grantFile(sessionID));
		return true;
	} catch {
		return false;
	}
}
/** R8: every write to another session is opt-in; default is read-only. */
const WRITE_DISABLED_REASON = "allowWrite=false（本插件默认只读）：不修改任何会话的 permissions / agent。需要时在 collab.json 或插件 options 里显式设置 allowWrite:true。";
function createGrants(ctx, readConfig) {
	/**
	* The session's **own** ruleset (`Session.Info.permissions`). Deliberately
	* uncached: a grant/revoke must snapshot the exact current set, and the whole
	* set is replaced on PATCH.
	*/
	async function readSessionPermissions(sessionID) {
		return normalizeRules((await ctx.session.get({ sessionID }))?.permissions);
	}
	/**
	* `PATCH /api/session/{id}` takes `permissions` as a **whole-set replacement**,
	* so every caller hands in the merged set — never a delta. Hosts without the
	* SDK method fall back to HTTP only when `COLLAB_SERVER_URL` is configured
	* explicitly (a guessed port could patch an unrelated instance).
	*/
	async function patchSessionPermissions(sessionID, rules) {
		const payload = normalizeRules(rules);
		if (typeof ctx.session?.update === "function") {
			await ctx.session.update({
				sessionID,
				permissions: payload
			});
			return { via: "session.update" };
		}
		if (!SERVER_URL) throw new Error("宿主不支持 ctx.session.update（无法写会话级 permissions），且未配置 COLLAB_SERVER_URL 作 HTTP fallback");
		const response = await fetch(`${SERVER_URL}/api/session/${encodeURIComponent(sessionID)}`, {
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				...SERVER_TOKEN ? { authorization: `Bearer ${SERVER_TOKEN}` } : {}
			},
			body: JSON.stringify({ permissions: payload })
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(`PATCH /api/session/${sessionID} → HTTP ${response.status}${detail ? ` ${truncate(detail, 160)}` : ""}`);
		}
		return { via: "http" };
	}
	/**
	* Idempotent grant. Merge the five allow rules into the session's current set,
	* PATCH once, and keep the **first** pre-grant snapshot as `before` so repeated
	* spawn/grant never accumulates and `revoke` restores the original ruleset
	* rather than deleting rules that pre-existed.
	*
	* Never throws: a 403/404/old host comes back as `{ok:false, reason}` and the
	* hand-off continues (the lease-expiry auto receipt still closes it).
	*/
	async function grantForSession(sessionID, { reason = "grant", by = "" } = {}) {
		if (!readConfig().allowWrite) return {
			ok: false,
			phase: "disabled",
			reason: WRITE_DISABLED_REASON
		};
		const wanted = assertCollabOnly(collabPermissionRules());
		let before;
		try {
			before = await readSessionPermissions(sessionID);
		} catch (error) {
			return {
				ok: false,
				phase: "read",
				reason: `读取 ${sessionID} 的 permissions 失败：${errText(error)}`
			};
		}
		const existing = readGrant(sessionID);
		const snapshot = existing?.before ?? before;
		const added = missingRules(before, wanted);
		const after = mergeRules(before, wanted);
		try {
			if (added.length) await patchSessionPermissions(sessionID, after);
		} catch (error) {
			return {
				ok: false,
				phase: "patch",
				reason: `写入 ${sessionID} 的 permissions 失败：${errText(error)}`,
				before,
				wanted
			};
		}
		let verified;
		try {
			verified = await readSessionPermissions(sessionID);
		} catch {
			verified = after;
		}
		const record = writeGrant({
			sid: sessionID,
			before: snapshot,
			added: dedupe([...existing?.added ?? [], ...added.map((rule) => rule.action)]),
			at: Date.now(),
			by: existing?.by || by,
			reason: existing?.reason || reason
		});
		return {
			ok: true,
			changed: added.length > 0,
			added,
			before,
			after,
			verified,
			record
		};
	}
	/**
	* Restore the recorded pre-grant ruleset and drop the record. The PATCH is a
	* whole-set replacement, so this is the exact inverse of one grant — nothing
	* is "deleted by name" (a `collab_*` rule that pre-existed stays).
	*/
	async function revokeForSession(sessionID) {
		if (!readConfig().allowWrite) return {
			ok: false,
			phase: "disabled",
			reason: WRITE_DISABLED_REASON
		};
		const record = readGrant(sessionID);
		if (!record || !record.before) return {
			ok: false,
			phase: "record",
			reason: `没有 ${sessionID} 的授权记录（${grantFile(sessionID)}），无可还原`
		};
		try {
			await patchSessionPermissions(sessionID, record.before);
		} catch (error) {
			return {
				ok: false,
				phase: "patch",
				reason: `还原 ${sessionID} 的 permissions 失败：${errText(error)}`,
				record
			};
		}
		let verified;
		try {
			verified = await readSessionPermissions(sessionID);
		} catch {
			verified = record.before;
		}
		const leftover = writeGrant({
			sid: sessionID,
			before: null,
			added: null,
			at: null,
			by: null,
			reason: null
		});
		return {
			ok: true,
			restored: record.before,
			verified,
			record,
			leftover
		};
	}
	/**
	* `POST /api/session/{id}/agent` (`session.switchAgent`). Same fallback rule as
	* the permission patch: never guess a server, only a configured one.
	*/
	async function switchSessionAgent(sessionID, agent) {
		if (typeof ctx.session?.switchAgent === "function") {
			await ctx.session.switchAgent({
				sessionID,
				agent
			});
			return { via: "session.switchAgent" };
		}
		if (!SERVER_URL) throw new Error("宿主不支持 ctx.session.switchAgent（无法切换会话 agent），且未配置 COLLAB_SERVER_URL 作 HTTP fallback");
		const response = await fetch(`${SERVER_URL}/api/session/${encodeURIComponent(sessionID)}/agent`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...SERVER_TOKEN ? { authorization: `Bearer ${SERVER_TOKEN}` } : {}
			},
			body: JSON.stringify({ agent })
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(`POST /api/session/${sessionID}/agent → HTTP ${response.status}${detail ? ` ${truncate(detail, 160)}` : ""}`);
		}
		return { via: "http" };
	}
	/**
	* Promote a session's agent (default `build`; whitelist `build`/`plan`).
	* The pre-promotion agent is recorded once (`agentBefore`, first write wins)
	* so `revert` restores the *original* value even after repeated promote calls.
	* Never throws: a 403/404/old host comes back as `{ok:false, reason}`.
	*/
	async function promoteSession(sessionID, { agent = "build", by = "" } = {}) {
		if (!readConfig().allowWrite) return {
			ok: false,
			phase: "disabled",
			reason: WRITE_DISABLED_REASON
		};
		const target = String(agent ?? "").trim() || "build";
		if (!PROMOTE_AGENTS.includes(target)) return {
			ok: false,
			phase: "agent",
			reason: `agent="${target}" 不在白名单（只允许 ${PROMOTE_AGENTS.join(" / ")}）；未修改任何会话`
		};
		let info;
		try {
			info = await ctx.session.get({ sessionID });
		} catch (error) {
			return {
				ok: false,
				phase: "read",
				reason: `读取 ${sessionID} 失败：${errText(error)}`
			};
		}
		const current = String(info?.agent ?? "");
		const existing = readGrant(sessionID);
		const agentBefore = existing?.agentBefore ?? current;
		const changed = current !== target;
		if (changed) try {
			await switchSessionAgent(sessionID, target);
		} catch (error) {
			return {
				ok: false,
				phase: "switch",
				reason: `切换 ${sessionID} 的 agent 失败：${errText(error)}`,
				from: current
			};
		}
		const record = changed || existing?.agentBefore ? writeGrant({
			sid: sessionID,
			agentBefore,
			promotedAt: Date.now(),
			promotedBy: by
		}) : existing;
		let verified = target;
		try {
			verified = String((await ctx.session.get({ sessionID }))?.agent ?? target);
		} catch {
			verified = target;
		}
		return {
			ok: true,
			changed,
			from: current,
			to: target,
			agentBefore,
			verified,
			record
		};
	}
	/** Restore `agentBefore` and drop only the agent half of the ledger record. */
	async function revertSessionAgent(sessionID) {
		if (!readConfig().allowWrite) return {
			ok: false,
			phase: "disabled",
			reason: WRITE_DISABLED_REASON
		};
		const record = readGrant(sessionID);
		if (!record?.agentBefore) return {
			ok: false,
			phase: "record",
			reason: `没有 ${sessionID} 的 promote 记录（${grantFile(sessionID)}），无可还原`
		};
		let current = record.agentBefore;
		try {
			current = String((await ctx.session.get({ sessionID }))?.agent ?? record.agentBefore);
		} catch {
			current = record.agentBefore;
		}
		try {
			await switchSessionAgent(sessionID, record.agentBefore);
		} catch (error) {
			return {
				ok: false,
				phase: "switch",
				reason: `还原 ${sessionID} 的 agent 失败：${errText(error)}`,
				record
			};
		}
		const leftover = writeGrant({
			sid: sessionID,
			agentBefore: null,
			promotedAt: null,
			promotedBy: null
		});
		let verified = record.agentBefore;
		try {
			verified = String((await ctx.session.get({ sessionID }))?.agent ?? record.agentBefore);
		} catch {
			verified = record.agentBefore;
		}
		return {
			ok: true,
			from: current,
			restored: record.agentBefore,
			verified,
			record,
			leftover
		};
	}
	return {
		readSessionPermissions,
		patchSessionPermissions,
		grantForSession,
		revokeForSession,
		promoteSession,
		revertSessionAgent
	};
}
/**
* The grant half of a ledger record, or undefined when only the promote half is
* there. Used by the `collab_grant` preview so a promote-only record is reported
* as "no permissions snapshot" instead of reading `.added` / `.before` on
* undefined (B1: that used to throw `TypeError: … reading 'join'`).
*/
function grantHalfOf(record) {
	return record && Array.isArray(record.before) && Array.isArray(record.added) ? record : void 0;
}
// src/core/lineage.ts
/**
* `protect` is a *lineage* guard, not an id list: a target is refused when it
* is protected itself or any ancestor in its `parentID` chain is. Without this,
* dispatching a sub-agent (e.g. `trellis-implement` spawned from the schema
* line) would silently bypass the hard list.
*
* `parentID` comes from `Session.Info` (`ctx.session.get`); when the host does
* not expose it, the same field is looked up once through `ctx.session.list()`
* (the server returns it there too). The walk is bounded by
* `MAX_LINEAGE_DEPTH` and cycle-safe, so a malformed chain can never hang a tool.
*/
function createLineage(ctx) {
	const cache = /* @__PURE__ */ new Map();
	let page;
	async function listPage() {
		if (page === void 0) try {
			const listed = await ctx.session.list({ limit: 100 });
			page = Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : [];
		} catch {
			page = [];
		}
		return page;
	}
	function fromList(sessionID) {
		return page?.find((item) => item?.id === sessionID);
	}
	async function nodeOf(sessionID) {
		if (!sessionID) return void 0;
		if (cache.has(sessionID)) return cache.get(sessionID);
		let node;
		try {
			node = await ctx.session.get({ sessionID });
		} catch {
			node = void 0;
		}
		if (!node || !("parentID" in node)) {
			await listPage();
			node = fromList(sessionID) ?? node;
		}
		cache.set(sessionID, node);
		return node;
	}
	return {
		/** Pre-seed from an already-fetched page (used by `collab_list`). */
		seed(sessions) {
			page = Array.isArray(sessions) ? sessions : [];
			for (const item of page) if (item?.id) cache.set(item.id, item);
		},
		/**
		* Walk `sessionID` → parents. Returns `{sessionID, depth}` for the first
		* protected id on the chain (`depth: 0` = the target itself, `depth: n` =
		* the n-th ancestor), else undefined. `MAX_LINEAGE_DEPTH` bounds the number
		* of *ancestors* walked, so the loop runs `depth` 0…8 (self + 8 levels).
		*/
		async protectedAncestor(sessionID, protect) {
			const protectedIDs = new Set(protect);
			const seen = /* @__PURE__ */ new Set();
			let current = String(sessionID ?? "");
			for (let depth = 0; current && depth <= 8; depth++) {
				if (protectedIDs.has(current)) return {
					sessionID: current,
					depth
				};
				if (seen.has(current)) return void 0;
				seen.add(current);
				const node = await nodeOf(current);
				const parent = node?.parentID ?? node?.parentId;
				current = parent ? String(parent) : "";
			}
		}
	};
}
// src/core/score.ts
/**
* `bid = hash(scope + workspace + issuePath + content hash + mtime)`, so the
* same proposal broadcast twice is the same hand-off (idempotent) while an
* edited proposal becomes a new one.
*/
function broadcastID({ scope, workspace, issuePath, contentHash, mtimeMs }) {
	return `b_${hash16([
		scope,
		workspace,
		issuePath || "",
		contentHash || "",
		String(mtimeMs || 0)
	].join("|"))}`;
}
function normalizeExpected(value) {
	const text = String(value ?? "").trim().toLowerCase();
	return EXPECTED.includes(text) ? text : "implement";
}
const PATH_TOKEN_RE = new RegExp(`[\\w@.$-]*(?:/[\\w@.$-]+)*\\.(?:tsx?|mts|cts|jsx?|mjs|cjs|vue|jsonc?|mdx?|ya?ml|toml|sql|css|scss|less|html?|go|py|rs|java|kt|sh)\\b`, "gi");
const TASK_SLUG_RE = /\b\d{2}-\d{2}-[a-z0-9][a-z0-9-]{2,}\b/g;
const STOP_WORDS = /* @__PURE__ */ new Set([
	"the",
	"and",
	"for",
	"with",
	"from",
	"this",
	"that",
	"not",
	"are",
	"was",
	"any",
	"all",
	"fix",
	"bugs",
	"bug",
	"feat",
	"chore",
	"issue",
	"issues",
	"docs",
	"task",
	"请",
	"的",
	"了",
	"在",
	"与",
	"和",
	"或",
	"要",
	"把",
	"被",
	"是"
]);
/** File paths mentioned in a text (proposal body, hand-off text, tool input). */
function extractPaths(text) {
	const found = [];
	const value = String(text ?? "");
	for (const match of value.matchAll(PATH_TOKEN_RE)) {
		let token = match[0];
		if (!token || token.length < 4) continue;
		token = token.replace(/^\.\//, "").replace(/^\/+/, "");
		if (token.startsWith("..")) continue;
		found.push(token);
	}
	return dedupe(found);
}
function keywordsOf(...texts) {
	const words = [];
	for (const text of texts) for (const word of String(text ?? "").toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/)) {
		const latin = /^[a-z0-9][a-z0-9._-]*$/.test(word);
		if (latin && word.length >= 3 && !STOP_WORDS.has(word)) words.push(word);
		else if (!latin && word.length >= 2 && !STOP_WORDS.has(word)) words.push(word);
	}
	return dedupe(words).slice(0, 40);
}
function taskSlugsOf(text) {
	return dedupe(String(text ?? "").match(TASK_SLUG_RE) ?? []);
}
/** `packages/state/src/machine/worker/store.ts` → `worker`/`store`/`machine`… */
function moduleWordsOf(files) {
	const words = [];
	for (const file of files) {
		const parts = String(file).split("/");
		for (const part of parts.slice(0, -1)) if (part.length >= 3 && ![
			"packages",
			"apps",
			"src",
			"dist",
			"lib"
		].includes(part)) words.push(part);
		const stem = parts.at(-1)?.replace(/\.[a-z0-9]+$/i, "") ?? "";
		if (stem.length >= 3) words.push(stem);
	}
	return dedupe(words.map((word) => word.toLowerCase()));
}
/** Title of a proposal: first markdown heading, else the file stem. */
function titleOf(content, file) {
	const heading = /^\s{0,3}#{1,3}\s+(.+)$/m.exec(String(content ?? ""));
	return truncate((heading ? heading[1] : basename(file).replace(/\.[a-z0-9]+$/i, "")).replace(/[*`_]/g, ""), 120);
}
function summarizeProposal(text, file) {
	const content = String(text ?? "");
	const files = extractPaths(content);
	const title = titleOf(content, file);
	const slug = basename(file).replace(/\.[a-z0-9]+$/i, "");
	return {
		contentHash: hash16(content),
		title,
		slug,
		files,
		keywords: keywordsOf(title, slug, moduleWordsOf(files).join(" ")),
		taskSlugs: taskSlugsOf(content)
	};
}
/**
* Broadcast input validation: absolute workspace, proposal under `docs/issues/`.
*
* Two layers, because a lexical check alone is not enough:
*   1. `relative()` + containment on the resolved paths (blocks `..` traversal);
*   2. `lstatSync` rejects a symlinked proposal and `realpathSync` re-checks the
*      *real* target, so `docs/issues/x.md -> /etc/passwd` can never leak an
*      out-of-repo file into the global broadcast record.
*/
function resolveBroadcastTargets(workspaceInput, issuePathInput) {
	const workspace = String(workspaceInput ?? "").trim();
	if (!workspace) throw new Error("workspace 不能为空：请给目标工作区的绝对路径");
	if (!isAbsolute(workspace)) throw new Error(`workspace 必须是绝对路径："${workspace}"`);
	let stat;
	try {
		stat = statSync(workspace);
	} catch {
		throw new Error(`workspace 不存在或不可读："${workspace}"`);
	}
	if (!stat.isDirectory()) throw new Error(`workspace 不是目录："${workspace}"`);
	let realWorkspace;
	try {
		realWorkspace = realpathSync(workspace);
	} catch {
		throw new Error(`workspace 无法解析真实路径："${workspace}"`);
	}
	const issueRaw = String(issuePathInput ?? "").trim();
	if (!issueRaw) throw new Error("issuePath 不能为空：peer scope 必须指向目标仓 docs/issues/ 下的提案");
	const issuePath = relative(workspace, resolve(workspace, issueRaw)).split(sep).join("/");
	const issuesRoot = join(realWorkspace, "docs", "issues") + sep;
	const abs = resolve(realWorkspace, issuePath);
	if (!abs.startsWith(issuesRoot)) throw new Error(`拒绝广播：issuePath "${issueRaw}" 不在 ${workspace}/docs/issues/ 下（peer scope 只允许目标仓 docs/issues/**，见跨仓写边界）。`);
	let fileStat;
	try {
		fileStat = lstatSync(abs);
	} catch {
		throw new Error(`提案文件不存在："${issuePath}"（先写提案，再广播）`);
	}
	if (fileStat.isSymbolicLink()) throw new Error(`拒绝广播：提案 ${issuePath} 是软链（不允许软链绕过 docs/issues/ 写边界）。`);
	if (!fileStat.isFile()) throw new Error(`提案路径不是文件："${issuePath}"`);
	let realAbs;
	try {
		realAbs = realpathSync(abs);
	} catch {
		throw new Error(`提案文件不可读："${issuePath}"`);
	}
	if (!realAbs.startsWith(issuesRoot)) throw new Error(`拒绝广播：提案 ${issuePath} 的真实路径 ${realAbs} 不在 ${workspace}/docs/issues/ 下。`);
	if (!/\.mdx?$/i.test(issuePath)) throw new Error(`提案必须是 .md：${issuePath}`);
	return {
		workspace,
		issuePath,
		abs,
		mtimeMs: fileStat.mtimeMs
	};
}
function sessionBusyMinutes(info, now = Date.now()) {
	const time = asObject(info?.time);
	if (!time.busy) return 0;
	if (time.idle && time.idle >= time.busy) return 0;
	return Math.max(0, (now - Number(time.busy)) / 6e4);
}
function pathsMatch(a, b) {
	const left = String(a).replace(/^\.\//, "");
	const right = String(b).replace(/^\.\//, "");
	return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}
function collectInputPaths(value, sink) {
	if (typeof value === "string") {
		for (const path of extractPaths(value)) sink.push(path);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectInputPaths(item, sink);
		return;
	}
	if (value && typeof value === "object") for (const item of Object.values(value)) collectInputPaths(item, sink);
}
/**
* Files a session actually touched, read only from its **tool call inputs**.
* Message bodies are never persisted or sent anywhere: the scoring runs in
* memory and only path strings leave this function.
*/
function pathsFromMessages(messages, now = Date.now()) {
	const cutoff = now - SCORE_MESSAGE_WINDOW_MS;
	const list = (Array.isArray(messages) ? messages : []).filter((message) => {
		const stamp = Number(message?.time?.created ?? message?.time?.completed ?? 0);
		return !stamp || stamp >= cutoff;
	}).slice(-200);
	const found = [];
	for (const message of list) {
		for (const block of Array.isArray(message?.content) ? message.content : []) {
			if (typeof block === "string" || block?.type !== "tool") continue;
			collectInputPaths(block?.state?.input, found);
			collectInputPaths(block?.input, found);
		}
		for (const file of Array.isArray(message?.snapshot?.files) ? message.snapshot.files : []) if (typeof file === "string") found.push(file);
	}
	return dedupe(found).slice(0, 400);
}
const AGENT_MATCH = {
	implement: /build|implement|trellis-implement/,
	review: /explore|plan|build|review|check|trellis-check/
};
/**
* Deterministic matching score, 0–100:
*   45 影响文件交集 · 25 标题词 · 15 同一任务线 · 10 agent · 5 最近活跃
*   −10 busy > 30min
* Every contribution is written into `why` so a human can audit the ranking.
*/
function scoreCandidate({ info, paths, proposal, expected, now = Date.now() }) {
	const why = [];
	let score = 0;
	const files = Array.isArray(proposal.files) ? proposal.files : [];
	let hitFiles = 0;
	for (const file of files) {
		const hit = (paths ?? []).find((path) => pathsMatch(path, file));
		if (!hit) continue;
		hitFiles += 1;
		if (why.filter((line) => line.startsWith("file:")).length < 3) why.push(`file:${hit}`);
	}
	if (files.length && hitFiles) score += 45 * (hitFiles / files.length);
	const title = String(info?.title ?? "").toLowerCase();
	const words = Array.isArray(proposal.keywords) ? proposal.keywords : [];
	const hitWords = words.filter((word) => title.includes(word));
	if (words.length && hitWords.length) {
		score += 25 * (hitWords.length / words.length);
		why.push(...hitWords.slice(0, 3).map((word) => `title:${word}`));
	}
	const slugHit = (Array.isArray(proposal.taskSlugs) ? proposal.taskSlugs : []).find((slug) => title.includes(slug)) ?? (title.includes(String(proposal.slug ?? "").toLowerCase()) ? proposal.slug : void 0);
	if (slugHit) {
		score += 15;
		why.push(`task:${slugHit}`);
	}
	const agent = String(info?.agent ?? "");
	if (AGENT_MATCH[expected]?.test(agent)) {
		score += 10;
		why.push(`agent:${agent}`);
	}
	const updated = Number(info?.time?.updated ?? info?.time?.created ?? 0);
	const age = updated ? now - updated : Infinity;
	if (age <= 72e5) {
		score += 5 * (1 - age / BCAST_RECENT_MS);
		why.push(`recent:${Math.max(0, Math.round(age / 6e4))}m`);
	}
	const busyMinutes = sessionBusyMinutes(info, now);
	if (busyMinutes > 30) {
		score -= 10;
		why.push(`busy:-10(${Math.round(busyMinutes)}m)`);
	}
	return {
		sid: String(info?.id ?? ""),
		score: Math.max(0, Math.min(100, Math.round(score))),
		why,
		busyMinutes
	};
}
// src/core/verdict.ts
/**
* Receipt line, written by the session that took the hand-off:
*   `[handoff] DONE <提案路径|bid|thread> <commit sha 或摘要>`
*   `[handoff] BLOCKED <…> <原因>`
* Parsing is deliberately loose — the third field is free text.
*/
const HANDOFF_RECEIPT_RE = /\[handoff\]\s+(DONE|BLOCKED)\s+(\S+)\s*([^\n]*)/i;
/** An explicit refusal from the currently asked candidate. */
const HANDOFF_DECLINE_RE = /\bDECLINE\b/i;
/** A `bid` written inside the DECLINE text, so several asks cannot be confused. */
const DECLINE_BID_RE = /\b(b_[0-9a-f]{8,32})\b/;
function parseReceiptLine(text) {
	const match = HANDOFF_RECEIPT_RE.exec(String(text ?? ""));
	if (!match) return void 0;
	return {
		state: match[1].toUpperCase() === "DONE" ? "done" : "blocked",
		target: match[2],
		note: truncateRaw(match[3] ?? "", 500)
	};
}
/**
* Which record a receipt line refers to. Only exact identifiers count
* (`bid` / `threadID` / the full `issuePath`) — a bare file name is ambiguous
* as soon as two workspaces carry `docs/issues/fix-x.md`, and matching it
* closed the wrong hand-off. Cross-workspace safety comes from
* `claim.by === from`, see `receiptAllowed`.
*/
function receiptMatches(record, target) {
	const value = String(target ?? "").trim().replace(/^\.\//, "");
	if (!value) return false;
	if (value === record.bid) return true;
	if (record.threadID && value === record.threadID) return true;
	const issue = String(record.issuePath ?? "").replace(/^\.\//, "");
	return Boolean(issue) && value === issue;
}
/** Only the session that actually claimed the hand-off may close it. */
function receiptAllowed(record, from) {
	const claimant = String(record?.claim?.by ?? "");
	return Boolean(claimant) && Boolean(from) && claimant === String(from);
}
/**
* Explicit receipt written *inside* the counterpart's own answer — the pilot
* showed an `explore` session writing exactly this line and never sending it,
* so this is the strongest signal a read-only extraction can get.
*
* H1 (review): the very same line is part of the R1 prompt, so an echo of the
* template must never count. A mention is only trusted when the token right
* after DONE/BLOCKED is the *current* bid — see `verdictFromTexts`.
*/
const HANDOFF_VERDICT_RE = /\[handoff\][ \t]*(DONE|BLOCKED)\b([^\n]*)/i;
/** A `[handoff] BLOCKED <bid> …` line still carries the bid; it is not the summary. */
const VERDICT_BID_RE = /^b_[0-9a-f]{8,32}\b\s*/i;
/** `<bid>` / `<摘要>` / `<原因>` — the template placeholders are not a target (H1). */
const VERDICT_PLACEHOLDER_RE = /^<[^>]*>$/;
/**
* H1 (round 2): any `<…>` token **anywhere** in the summary slot is a leftover
* template placeholder, not a receipt. Exact matching was not enough — echoing
* the R1 command verbatim leaves `", confirm:true}` / backticks / `（以上是示例）`
* right after `<摘要>`, and that used to be closed as a real verdict.
*/
const VERDICT_ECHO_RE = /<[^>]{0,32}>/;
/**
* H1 negation guard: an answer that says it did *not* finish is never a verdict,
* even when it also quotes the requested receipt format.
*/
const VERDICT_NEGATION_RE = /不会|未完成|没有完成|没完成|尚未|无法完成|不能完成|做不到|还没|未开始|not\s+(?:yet\s+)?done|not\s+yet|haven'?t|did\s+not|didn'?t|unfinished|incomplete/i;
/**
* H1 (second half): promise / plan wording describes what the session *will*
* do, not what it did. Ambiguous → no verdict.
*/
const VERDICT_PENDING_RE = /完成后|完之后|之后(?:我)?会|稍后|接下来|待(?:我|确认|环境)|先(?:确认|看|核对)|打算|计划|将会|将要|我会(?:按|先|发|在|照)/i;
/**
* Strong "no work needed" wording → `blocked`. Checked *before* the generic DONE
* words, because 「已完成/已修复」 must never be read as "implemented".
*/
const BLOCKED_VERDICT_RE = /已实施|已修复|无需|不需要|已完成|not needed|already/i;
/** Generic completion wording → `done` (only the last answer is judged on this). */
const DONE_VERDICT_RE = /完成|done|fixed/i;
/**
* …but 「分析/核对完成」 is a report *about* the reading, not a finished task.
* These phrases are removed before the generic DONE words are tested.
*/
const ANALYSIS_DONE_RE = /(?:分析|核对|排查|调研|审阅|查看|阅读)(?:已|都)?完成|完成(?:了)?(?:分析|核对|排查|调研|审阅|查看|阅读)/g;
function flattenText(value) {
	return String(value ?? "").replace(/\s+/g, " ").trim();
}
/** Whitespace-collapsed and capped — the only piece of the answer that gets stored. */
function verdictNote(text) {
	return flattenText(text).slice(0, 200);
}
/** The text blocks of one assistant message (`content[]`, `parts[]`, or a bare `text`). */
function assistantText(message) {
	const blocks = Array.isArray(message?.content) ? message.content : Array.isArray(message?.parts) ? message.parts : [];
	const texts = [];
	for (const block of blocks) if (typeof block === "string") texts.push(block);
	else if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
	if (!texts.length && typeof message?.text === "string") texts.push(message.text);
	return flattenText(texts.join(" "));
}
/**
* Assistant answers of a message list, oldest → newest, capped to the trailing
* `VERDICT_MESSAGE_LIMIT`. `since` drops messages written before the claim, so an
* unrelated "完成了" from last week's work cannot close the hand-off.
*/
function assistantTexts(messages, { since = 0 } = {}) {
	return (Array.isArray(messages) ? messages : []).filter((message) => {
		if (String(message?.type ?? message?.role ?? "") !== "assistant") return false;
		const at = Number(message?.time?.created ?? message?.time?.completed ?? 0);
		return !since || !at || at >= since;
	}).map(assistantText).filter(Boolean).slice(-10);
}
/**
* Verdict of one session's answers, or `undefined` when it cannot be judged:
*   - only the **last** answer with real text is judged (H1) — never a join and
*     never a scan-back, so an echoed template from an earlier turn cannot
*     outvote the actual answer;
*   - a `[handoff] DONE|BLOCKED …` line counts only when its target is the
*     current `bid`; a placeholder (`<bid>`) or another bid means the text is an
*     echo / another hand-off → `undefined` (H1); the same holds when the summary
*     slot still contains a `<…>` placeholder anywhere (verbatim echo of R1);
*   - negation (`未完成` / `无法完成` / `not done yet` …) and promise wording
*     (「完成后我会发…」) → `undefined` (H1);
*   - otherwise the same answer is keyword-checked (blocked words first);
*   - anything else is "not decided" — the caller keeps the old lease logic, so a
*     wrong guess can never close a hand-off that is still open (R2/R3).
*/
function verdictFromTexts(texts, { bid } = {}) {
	const list = Array.isArray(texts) ? texts.filter(Boolean) : [];
	if (!list.length) return void 0;
	const last = list[list.length - 1];
	if (VERDICT_NEGATION_RE.test(last) || VERDICT_PENDING_RE.test(last)) return void 0;
	const wanted = String(bid ?? "").trim().toLowerCase();
	const mentions = [...last.matchAll(new RegExp(HANDOFF_VERDICT_RE.source, "gi"))];
	if (mentions.length) {
		if (!wanted) return void 0;
		for (const mention of mentions) {
			const rest = flattenText(mention[2]);
			const target = (/^[`"'“「]?([^\s`"'”」,，。.:：;；]+)/.exec(rest)?.[1] ?? "").replace(/[.,:;，。：；、)\]}】`'"]+$/, "").toLowerCase();
			if (!target || VERDICT_PLACEHOLDER_RE.test(target) || target !== wanted) continue;
			const state = mention[1].toUpperCase() === "DONE" ? "done" : "blocked";
			const summary = rest.replace(/^[`"'“「]/, "").replace(VERDICT_BID_RE, "").replace(/^[`"'”」]/, "").trim();
			if (VERDICT_ECHO_RE.test(summary)) continue;
			return {
				state,
				summary: verdictNote(summary || mention[1].toUpperCase())
			};
		}
		return;
	}
	if (BLOCKED_VERDICT_RE.test(last)) return {
		state: "blocked",
		summary: verdictNote(last)
	};
	const claim = last.replace(ANALYSIS_DONE_RE, "");
	if (DONE_VERDICT_RE.test(claim)) return {
		state: "done",
		summary: verdictNote(last)
	};
}
/**
* R1: what a receiving session must do, in order, with copy-pasteable commands
* (full requester sid + bid). Shared by the takeover request, the wake prompt
* and the broadcast result so all three say the same three things — after the
* pilot, an `explore` session answered in its own turn, called nothing, and the
* bid stayed `claimed`.
*/
function handoffActions({ bid, requester, spawn = false, leaseMin = 5 }) {
	const target = requester || "ses_…";
	const lines = [
		`① 领取（先做；领取即 acked）：collab_accept {bid:"${bid}", confirm:true}`,
		`② 回执（必发，二选一）: collab_send {target:"${target}", text:"[handoff] DONE ${bid} <摘要>", confirm:true}`,
		`   无法实施/判定无需处理: collab_send {target:"${target}", text:"[handoff] BLOCKED ${bid} <原因>", confirm:true}`,
		"③ 只分析、不调用工具 = 未完成：结论必须用上面的 collab_send 真正发出。（② 里的文字只是格式示例——复述/回显它不算回执，也不会被自动闭环。）"
	];
	if (!spawn) lines.push(`   没余力/不接：collab_send {target:"${target}", text:"DECLINE ${bid} <理由>", confirm:true}（${leaseMin} 分钟不答自动顺延下一候选）`);
	return lines;
}
// src/core/chain.ts
/**
* Shared core of the hand-off chain: session enumeration, matching score,
* receipt parsing and the "what should this session see" query used by the
* `context` hook. Both scopes (`local` / `peer`) go through it, so the ranking
* rules and the idempotency guarantees are the same for a same-workspace
* hand-off and a cross-workspace broadcast.
*/
function createHandoffChain(ctx, readConfig) {
	const INFO_TTL_MS = 6e4;
	const PATH_TTL_MS = 12e4;
	const infoCache = /* @__PURE__ */ new Map();
	const pathCache = /* @__PURE__ */ new Map();
	async function sessionInfo(sessionID) {
		if (!sessionID) return void 0;
		const hit = infoCache.get(sessionID);
		if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit.value;
		let info;
		try {
			info = await ctx.session.get({ sessionID });
		} catch {
			info = void 0;
		}
		infoCache.set(sessionID, {
			at: Date.now(),
			value: info
		});
		return info;
	}
	/**
	* Sessions of one workspace (root + children, caller filters). `directory` is
	* passed to the host so a big instance does not page every session in; the
	* result is also filtered locally, because `ctx.session.list` may ignore the
	* field on older hosts.
	*/
	async function listSessions({ directory, limit = 100 } = {}) {
		let page;
		try {
			page = directory ? await ctx.session.list({
				directory,
				limit
			}) : await ctx.session.list({ limit });
		} catch {
			page = await ctx.session.list({ limit }).catch(() => []);
		}
		const sessions = Array.isArray(page) ? page : Array.isArray(page?.data) ? page.data : [];
		if (!directory) return sessions;
		return sessions.filter((info) => {
			const dir = info?.location?.directory;
			return dir === void 0 || dir === directory;
		});
	}
	/** Files a session touched (tool inputs only, in-memory, never persisted). */
	async function sessionPaths(sessionID) {
		const hit = pathCache.get(sessionID);
		if (hit && Date.now() - hit.at < PATH_TTL_MS) return hit.paths;
		let paths = [];
		try {
			const result = await ctx.session.context({ sessionID });
			paths = pathsFromMessages(Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : []);
		} catch {
			return [];
		}
		pathCache.set(sessionID, {
			at: Date.now(),
			paths
		});
		return paths;
	}
	/**
	* Group members of `workspace`: root sessions only, never `[protected]` /
	* `[protected-child]`. Scored against the proposal and returned sorted.
	*/
	async function rankCandidates({ workspace, proposal, expected, exclude = [] }) {
		const config = readConfig();
		const listed = await listSessions({
			directory: workspace,
			limit: 100
		});
		const lineage = createLineage(ctx);
		lineage.seed(listed);
		const now = Date.now();
		const pool = [];
		for (const info of listed) {
			if (!info?.id || exclude.includes(info.id)) continue;
			if (info.parentID) continue;
			if (asObject(info.time).archived) continue;
			if (await lineage.protectedAncestor(info.id, config.protect)) continue;
			pool.push(info);
		}
		pool.sort((a, b) => Number(b?.time?.updated ?? 0) - Number(a?.time?.updated ?? 0));
		const ranked = [];
		for (const info of pool.slice(0, 20)) {
			const paths = await sessionPaths(info.id);
			ranked.push({
				...scoreCandidate({
					info,
					paths,
					proposal,
					expected,
					now
				}),
				info
			});
		}
		ranked.sort((a, b) => b.score - a.score || Number(b.info?.time?.updated ?? 0) - Number(a.info?.time?.updated ?? 0));
		return {
			candidates: ranked,
			members: pool.length
		};
	}
	/**
	* Parse a receipt out of an inbound message and close the matching hand-off.
	* An exact `bid` / `threadID` match wins over a full-`issuePath` match, and
	* only the claiming session may close it, so re-broadcasting an edited
	* proposal (new bid, same issuePath) or a same-named proposal of another
	* workspace cannot close the wrong hand-off. Returns the updated record, or
	* undefined when the text carries no `[handoff] DONE|BLOCKED` line / matches
	* nothing / comes from a non-claimant. Async because the refresh in front of
	* it may auto-close a lapsed spawn hand-off (R2).
	*/
	async function applyReceipt(text, from, now = Date.now()) {
		const receipt = parseReceiptLine(text);
		if (!receipt) return void 0;
		const open = [];
		for (const raw of allBroadcasts()) {
			const record = persistRefresh(raw, await refresh(raw, now, { actor: String(from) }));
			if (!record || BCAST_DONE_STATES.includes(String(record.state))) continue;
			if (!receiptAllowed(record, from)) continue;
			open.push(record);
		}
		const record = open.find((entry) => entry.bid === receipt.target || entry.threadID === receipt.target) ?? open.find((entry) => receiptMatches(entry, receipt.target));
		if (!record) return void 0;
		releaseLock(record.bid, [String(record.claim?.by ?? ""), String(record.claim?.spawner ?? "")]);
		return writeBroadcast({
			...record,
			state: receipt.state,
			receipt: {
				from: String(from ?? record.claim?.by ?? "") || void 0,
				at: now,
				note: receipt.note
			},
			replies: [...record.replies ?? [], {
				from: String(from ?? "unknown"),
				at: now,
				text: receipt.note
			}].slice(-50)
		});
	}
	/**
	* `DECLINE` from the currently asked candidate: skip it, count one attempt and
	* ask the next candidate. Returns the updated record, or undefined when the
	* text carries no DECLINE / the sender is not the asked session (so an
	* unrelated message mentioning the word cannot derail a hand-off).
	*
	* R1-3: the bid inside the text wins. One session can owe an answer on several
	* hand-offs at once, so a bid-less DECLINE is only applied when exactly one
	* open hand-off is waiting for that session — otherwise it is ignored rather
	* than applied to a guessed one.
	*/
	async function applyDecline(text, from, now = Date.now()) {
		const raw = String(text ?? "");
		if (!from || !HANDOFF_DECLINE_RE.test(raw)) return void 0;
		const wanted = DECLINE_BID_RE.exec(raw)?.[1];
		const open = [];
		for (const entry of allBroadcasts()) {
			const record = persistRefresh(entry, await refresh(entry, now, { actor: String(from) }));
			if (record && record.state === "open" && record.asked?.sid === String(from)) open.push(record);
		}
		if (!open.length) return void 0;
		if (wanted) {
			const record = open.find((entry) => entry.bid === wanted);
			if (!record) return void 0;
			return writeBroadcast(declineAsked({ ...record }, String(from), now));
		}
		if (open.length > 1) return void 0;
		return writeBroadcast(declineAsked({ ...open[0] }, String(from), now));
	}
	/**
	* R2: last assistant answers of one session — **read-only**, at most
	* `VERDICT_MESSAGE_LIMIT` of them. `ctx.session.context` is the plugin-side
	* mapping of `GET /api/session/{sid}/context` (a `Session.Message.Info[]`), so
	* this reads the same history `docs/collab.md` §4 lists for `messages`.
	* A deleted session / a host without the read path yields `[]` (never throws).
	*/
	async function assistantAnswer(sessionID, { since = 0 } = {}) {
		if (!sessionID) return [];
		let result;
		try {
			result = await ctx.session.context({
				sessionID,
				limit: 10
			});
		} catch {
			try {
				result = await ctx.session.context({ sessionID });
			} catch {
				return [];
			}
		}
		return assistantTexts(Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [], { since });
	}
	/**
	* Verdict the claimed session wrote in its own answer, or `undefined` when it
	* cannot be judged. `bid` is the hand-off being closed (H1): a `[handoff]`
	* line for another bid — or the template echo of this very bid — is not a
	* receipt. Failure never propagates: a missing session, an empty history or a
	* host error simply means "fall back to the old lease logic".
	*/
	async function extractVerdict(sessionID, { since = 0, bid } = {}) {
		if (!sessionID) return void 0;
		try {
			return verdictFromTexts(await assistantAnswer(sessionID, { since }), { bid });
		} catch {
			return;
		}
	}
	/**
	* Lease refresh with the R2 auto-receipt in front of it:
	*   `claimed` + `claim.kind = spawn` + lease lapsed **+ the caller is the
	*   requester** → read the spawned session's own answer once. A verdict closes
	*   the hand-off (`done` / `blocked`, receipt with `auto:true` and a
	*   ≤200-char summary) — **no reopen, no `attempts++`, no new session**.
	*   No verdict / unreadable session → the unchanged `refreshBroadcast` path.
	*
	* H2 (review): `actor` is the session that triggered this refresh. Only the
	* hand-off's own requester (`record.from.sid`) may auto-close from the
	* counterpart's answer; a same-workspace bystander or a session of another
	* workspace only gets the old lease logic — it must never read the
	* counterpart's body or flip the bid.
	*
	* The returned record is *not* written: callers keep using `persistRefresh`,
	* which sees the state change and writes it once.
	*/
	async function refresh(record, now = Date.now(), { actor } = {}) {
		if (!record) return record;
		const current = normalizeBroadcast(record);
		const claim = asObject(current.claim);
		if (!(current.state === "claimed" && Boolean(claim.by) && now - Number(claim.at || 0) > (Number(claim.leaseMs) || 3e5)) || claim.kind !== "spawn" || !current.from?.sid) return refreshBroadcast(record, now);
		if (!actor || String(actor) !== String(current.from.sid)) return refreshBroadcast(record, now);
		if (await createLineage(ctx).protectedAncestor(String(claim.by), readConfig().protect)) return refreshBroadcast(record, now);
		const verdict = await extractVerdict(String(claim.by), {
			since: Number(claim.at || 0),
			bid: current.bid
		});
		if (!verdict) return refreshBroadcast(record, now);
		const sid = String(claim.by);
		releaseLock(current.bid, [sid, String(claim.spawner ?? "")]);
		return {
			...current,
			state: verdict.state,
			receipt: {
				from: sid,
				by: sid,
				at: now,
				note: verdict.summary,
				auto: true
			},
			replies: [...current.replies ?? [], {
				from: sid,
				at: now,
				text: verdict.summary
			}].slice(-50),
			autoVerdictAt: now
		};
	}
	/**
	* Best-effort note to the requester (acceptance / decline). Cross-location
	* delivery is a plain `prompt`; a protected requester is never written to
	* (fail-closed, same as `collab_send`).
	*/
	async function notifyRequester(record, { text, kind = "note", from, threadID }) {
		const target = record?.from?.sid;
		if (!target) return {
			delivered: false,
			reason: "记录里没有发起方会话 id"
		};
		const config = readConfig();
		if (await createLineage(ctx).protectedAncestor(target, config.protect)) return {
			delivered: false,
			reason: `发起方 ${target} 在 protect 名单内，未回执`
		};
		const cid = newCorrelationID();
		try {
			return {
				delivered: true,
				message: (await ctx.session.prompt({
					sessionID: target,
					text: envelope({
						from: from ?? "handoff",
						kind,
						threadID,
						body: text
					}),
					delivery: "queue",
					metadata: { collab: {
						from: from ?? "handoff",
						fromSessionID: record.claim?.by ?? "unknown",
						cid,
						kind,
						threadID
					} }
				}))?.id
			};
		} catch (error) {
			return {
				delivered: false,
				reason: errText(error)
			};
		}
	}
	/**
	* What this session should be told on its next model request, as plain text
	* lines (the hook wraps them):
	*   - open broadcasts of its own workspace it has not seen yet (`seenBy`);
	*   - hand-offs it started that are still unresolved and stale (`reminded`).
	* Both are written back so each line is surfaced exactly once per session.
	*/
	async function injectionFor(sessionID, directory) {
		const now = Date.now();
		if (!sessionID || !directory) return [];
		const info = await sessionInfo(sessionID);
		if (!info || info.parentID) return [];
		const config = readConfig();
		if (await createLineage(ctx).protectedAncestor(sessionID, config.protect)) return [];
		const lines = [];
		for (const raw of allBroadcasts()) {
			const record = persistRefresh(raw, await refresh(raw, now, { actor: sessionID }));
			if (!record || record.workspace !== directory) continue;
			if (record.state === "open") {
				if (String(record.from?.sid ?? "") === sessionID) continue;
				if ((record.skipped ?? []).includes(sessionID)) continue;
				const files = (record.affectedFiles ?? []).slice(0, 4).join(", ") || "(未标注)";
				if (record.asked?.sid === sessionID && !(record.askSeen ?? []).includes(sessionID)) {
					const requester = String(record.from?.sid ?? "");
					const leaseMin = Math.round((record.asked.leaseMs ?? 3e5) / 6e4);
					lines.push(`- 接管请求 ${record.bid}：${truncate(record.title ?? "(untitled)", 80)}（提案 ${record.issuePath}，期望 ${record.expected}，影响面 ${files}） 发起方=${requester || "(缺失，用 collab_inbox 查)"} → ${handoffActions({
						bid: record.bid,
						requester,
						leaseMin
					}).join(" ")}`);
					writeBroadcast({
						...record,
						askSeen: dedupe([...record.askSeen ?? [], sessionID]),
						seenBy: dedupe([...record.seenBy ?? [], sessionID])
					});
					continue;
				}
				if (!(record.seenBy ?? []).includes(sessionID)) {
					lines.push(`- 群组广播 ${record.bid}：${truncate(record.title ?? "(untitled)", 80)}（提案 ${record.issuePath}，期望 ${record.expected}，影响面 ${files}） → 相关请 collab_accept {bid:"${record.bid}"}；没余力就不领取（勿占用）。`);
					writeBroadcast({
						...record,
						seenBy: dedupe([...record.seenBy ?? [], sessionID])
					});
				}
				continue;
			}
			if (!(String(record.from?.sid ?? "") === sessionID && !(record.reminded ?? []).includes(sessionID))) continue;
			if (["done", "blocked"].includes(String(record.state))) continue;
			const claimAt = Number(record.claim?.at ?? record.receipt?.at ?? record.createdAt) || 0;
			if (!(record.state === "expired" || now - claimAt > 3e5)) continue;
			const who = record.claim?.by ? ` 接手 ${record.claim.by}` : "";
			lines.push(`- 交接未闭环 ${record.bid}：${truncate(record.title ?? "(untitled)", 60)} state=${record.state}${who} 自 ${fmtTime(claimAt)} 起 → 用 collab_inbox 看回执；回执格式 [handoff] DONE|BLOCKED <${record.bid}> <摘要>。${record.state === "expired" ? " attempts 已超限，需人接手。" : ""}`);
			writeBroadcast({
				...record,
				reminded: dedupe([...record.reminded ?? [], sessionID])
			});
		}
		return lines;
	}
	return {
		sessionInfo,
		listSessions,
		sessionPaths,
		rankCandidates,
		applyReceipt,
		applyDecline,
		notifyRequester,
		injectionFor,
		extractVerdict,
		refresh,
		...createGrants(ctx, readConfig)
	};
}
// src/core/storage.ts
/** Serialise read-modify-write per key so concurrent events don't clobber. */
function createSerializer() {
	const locks = /* @__PURE__ */ new Map();
	return function serialize(key, fn) {
		const next = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
		locks.set(key, next.then(() => {}, () => {}));
		return next;
	};
}
function createInboxStore(ctx) {
	const serialize = createSerializer();
	async function read(sessionID) {
		const raw = asObject(await ctx.storage.get(inboxKey(sessionID)));
		const messages = Array.isArray(raw.messages) ? raw.messages : [];
		return {
			messages,
			cursor: clamp(raw.cursor ?? 0, 0, messages.length),
			injected: Array.isArray(raw.injected) ? raw.injected.filter((id) => typeof id === "string") : [],
			size: messages.length
		};
	}
	async function update(sessionID, mutate) {
		return serialize(sessionID, async () => {
			const current = await read(sessionID);
			const next = mutate(current) ?? current;
			const overflow = Math.max(0, next.messages.length - 50);
			const messages = overflow ? next.messages.slice(overflow) : next.messages;
			const cursor = Math.max(0, next.cursor - overflow);
			const alive = new Set(messages.map((message) => message.id));
			const injected = dedupe(next.injected ?? []).filter((id) => alive.has(id));
			const value = {
				messages,
				cursor,
				injected,
				updated: Date.now()
			};
			await ctx.storage.set(inboxKey(sessionID), value);
			if (cursor > 0) await ctx.storage.set(STORAGE_DELIVERED, {
				...asObject(await ctx.storage.get(STORAGE_DELIVERED)),
				[sessionID]: cursor
			});
			return {
				messages,
				cursor,
				injected,
				size: messages.length
			};
		});
	}
	return {
		read,
		update
	};
}
/**
* Thread store — the source of truth for the request/reply state machine.
* Both sides write here (same plugin storage), so a reply recorded by the
* receiver is immediately readable by the requester's `collab_wait`.
*/
function createThreadStore(ctx) {
	const serialize = createSerializer();
	async function read(threadID) {
		if (!threadID) return void 0;
		const raw = await ctx.storage.get(threadKey(threadID));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
		const value = asObject(raw);
		const msgs = Array.isArray(value.msgs) ? value.msgs : [];
		return {
			threadID: String(value.threadID ?? threadID),
			fromSession: value.fromSession ? String(value.fromSession) : void 0,
			toSession: value.toSession ? String(value.toSession) : void 0,
			kind: normalizeKind(value.kind),
			status: normalizeStatus(value.status),
			msgs,
			createdAt: Number(value.createdAt) || 0,
			updatedAt: Number(value.updatedAt) || 0
		};
	}
	async function update(threadID, mutate) {
		return serialize(threadID, async () => {
			const current = await read(threadID);
			const next = mutate(current) ?? current;
			await ctx.storage.set(threadKey(threadID), next);
			return next;
		});
	}
	return {
		read,
		update
	};
}
/**
* Append one message to a thread. `kind: "reply"` moves the thread to
* `answered`; `note` keeps the current status; a `request` always (re)opens it —
* a reused thread must not stay `answered`, otherwise the receiver's hook stops
* reminding and the requester's `collab_wait` returns the previous round's reply.
*/
function appendThreadMessage(current, message) {
	const now = message.ts ?? Date.now();
	const base = current ?? {
		threadID: String(message.threadID),
		fromSession: message.fromSession,
		toSession: message.toSession,
		kind: String(message.kind),
		status: "open",
		msgs: [],
		createdAt: now,
		updatedAt: now
	};
	if (message.cid && (base.msgs ?? []).some((entry) => entry.cid === message.cid)) return base;
	const status = message.kind === "reply" ? "answered" : message.kind === "note" ? base.status : "open";
	return {
		...base,
		fromSession: base.fromSession ?? message.fromSession,
		toSession: base.toSession ?? message.toSession,
		status,
		msgs: [...base.msgs, message].slice(-50),
		updatedAt: now
	};
}
/** One recorded inbound `session.inbox.enqueued` event, or undefined. */
function extractInbound(event) {
	const data = asObject(event?.data);
	const sessionID = data.sessionID;
	const item = asObject(data.item);
	if (!sessionID || item.type !== "user") return void 0;
	const payload = asObject(item.payload);
	const text = String(payload.text ?? "");
	const meta = asObject(asObject(payload.metadata).collab);
	const parsed = parseEnvelope(text);
	if (!parsed && !meta.from) return void 0;
	const id = String(data.inboxID ?? item.id ?? `${sessionID}:${Date.now()}`);
	const body = parsed ? parsed.body : text.replace(COLLAB_PREFIX_RE, "");
	return {
		id,
		cid: String(meta.cid ?? id),
		sessionID: String(sessionID),
		fromSession: String(meta.fromSessionID ?? parsed?.from ?? "unknown"),
		from: String(meta.from ?? parsed?.from ?? "unknown"),
		kind: normalizeKind(meta.kind ?? parsed?.kind),
		threadID: normalizeThreadID(meta.threadID) ?? normalizeThreadID(parsed?.threadID),
		text: truncateRaw(body, INBOX_TEXT_LIMIT),
		ts: Date.now(),
		delivered: false
	};
}
// src/tools/shared.ts
/** `jsonInput` — the object schema every tool declares (extra keys refused). */
function jsonInput(schema) {
	return {
		type: "object",
		additionalProperties: false,
		...schema
	};
}
function createToolKit(deps) {
	const { ctx, readConfig, threads, signal } = deps;
	/** Resolve `<alias>|ses_…` → existing session info, or throw a readable error. */
	async function resolveTarget(raw) {
		const target = String(raw ?? "").trim();
		if (!target) throw new Error("target 不能为空：请给 ses_… 会话 id 或 collab.json 里的别名");
		let sessionID = target;
		let alias;
		if (!target.startsWith("ses_")) {
			sessionID = {
				...asObject(await ctx.storage.get(STORAGE_ALIASES)),
				...readConfig().aliases
			}[target];
			if (!sessionID) throw new Error(`未知目标 "${target}"：既不是 ses_ 会话 id，也不在别名表里（${CONFIG_PATH} 的 aliases，或 ~/.config/opencode/collab-aliases.json）`);
			alias = target;
		}
		let info;
		try {
			info = await ctx.session.get({ sessionID });
		} catch (error) {
			throw new Error(`会话不存在或不可读：${sessionID}（${errText(error)}）`, { cause: error });
		}
		return {
			sessionID,
			alias,
			info
		};
	}
	function senderLabel(sessionID) {
		const hit = Object.entries(readConfig().aliases).find(([, value]) => value === sessionID);
		return hit ? hit[0] : shortID(sessionID);
	}
	function isReadonlyAgent(agent) {
		const id = String(agent ?? "").trim();
		return Boolean(id) && readConfig().readonlyAgents.includes(id);
	}
	/**
	* `queue` is the default. Read-only agents never get `steer`: an inbound
	* hand-off must not merge into the turn they are already running.
	*/
	function resolveMode(requested, agent) {
		if (isReadonlyAgent(agent)) return {
			mode: "queue",
			forced: true
		};
		return {
			mode: requested === "steer" ? "steer" : "queue",
			forced: false
		};
	}
	/** Delivery + thread bookkeeping shared by `collab_send` and `collab_reply`. */
	async function dispatch({ context, input, kind, threadID, mode, forced, notes, target }) {
		const config = readConfig();
		const body = String(input?.text ?? "").trim();
		if (!body) throw new Error("text 不能为空");
		const { sessionID, alias, info } = target;
		const guard = await createLineage(ctx).protectedAncestor(sessionID, config.protect);
		if (guard) {
			const where = guard.depth === 0 ? "本身" : `的祖先（第 ${guard.depth} 级）${guard.sessionID} `;
			throw new Error(`拒绝投递：目标 ${sessionID}${alias ? `（别名 ${alias}）` : ""} ${where}在 protect 名单内（${CONFIG_PATH} 的 protect + 内置硬名单，覆盖其任意层级子会话）。未发送任何内容。${kind === "reply" ? "回执同样适用该护栏（fail-closed）。" : ""}`);
		}
		if (context?.sessionID && context.sessionID === sessionID) throw new Error("拒绝投递：target 就是当前会话本身（会导致自我排队）。未发送任何内容。");
		const from = senderLabel(context?.sessionID);
		const cid = newCorrelationID();
		const text = envelope({
			from,
			kind,
			threadID,
			body
		});
		const targetLine = `${sessionID}${alias ? ` (alias=${alias})` : ""}  agent=${info?.agent ?? "?"}  state=${sessionState(info)}  title="${truncate(info?.title ?? "(untitled)", 60)}"`;
		const modeLine = forced ? "queue(forced)" : mode;
		const tailNotes = [...notes ?? []];
		if (forced) tailNotes.push("只读 agent：已强制 queue（入队，不打断对方当前轮）。");
		if (input?.confirm !== true) return { content: [
			"未投递（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。",
			`目标: ${targetLine}`,
			`kind=${kind}  thread=${threadID}`,
			`模式: ${modeLine}`,
			...tailNotes.map((note) => `注: ${note}`),
			"将发送:",
			text
		].join("\n") };
		const admitted = await ctx.session.prompt({
			sessionID,
			text,
			delivery: mode,
			metadata: { collab: {
				from,
				fromSessionID: context?.sessionID ?? "unknown",
				cid,
				kind,
				threadID,
				ts: Date.now()
			} }
		});
		const thread = threadID ? await threads.update(threadID, (current) => appendThreadMessage(current, {
			threadID,
			cid,
			kind,
			text: truncateRaw(body, INBOX_TEXT_LIMIT),
			ts: Date.now(),
			from,
			fromSession: context?.sessionID ?? "unknown",
			toSession: sessionID
		})) : void 0;
		return { content: [
			`已投递 → ${targetLine}`,
			`kind=${kind}  thread=${threadID}  status=${thread?.status ?? "-"}`,
			`mode=${modeLine}  message=${admitted?.id ?? "?"}  delivery=${admitted?.delivery ?? "?"}`,
			...tailNotes.map((note) => `注: ${note}`),
			kind === "request" ? "提示: 对方回执后可 collab_wait {threadID} 等结果；不要用 steer 打断对方的当前轮。" : kind === "reply" ? "提示: 回执已记入 thread；对端可用 collab_wait {threadID} 取到全文。" : "提示: note 只作通知，不改变 thread 状态。"
		].join("\n") };
	}
	/**
	* Wait for a reply on a thread. Only replies *after the last request* count, so
	* reusing a thread (`collab_send` with an existing `threadID`) cannot return the
	* previous round's reply. Ordering comes from the append order in `msgs` (ts can
	* collide within the same millisecond); threads without a recorded request fall
	* back to "any reply", which keeps old data working.
	*/
	async function waitForReply(threadID, timeoutMs, context) {
		const deadline = Date.now() + timeoutMs;
		const me = context?.sessionID;
		const notes = [];
		const initial = await threads.read(threadID);
		if (!initial) throw new Error(`没有 thread ${threadID}：threadID 可能拼错，或该 thread 由别的项目/目录（不同 location）创建。请用 collab_inbox 核对 threadID；若请求刚发出，稍后重试。`);
		if (me && me !== initial.fromSession && me !== initial.toSession) throw new Error(`拒绝等待：当前会话 ${me} 不是 thread ${threadID} 的参与方（发起方 ${initial.fromSession ?? "?"}，对端 ${initial.toSession ?? "?"}）。`);
		if (!me) notes.push("无会话上下文（无 sessionID）：未校验参与者身份。");
		for (;;) {
			const thread = await threads.read(threadID);
			const msgs = thread?.msgs ?? [];
			let lastRequest = -1;
			for (const [index, message] of msgs.entries()) if (normalizeKind(message.kind) === "request") lastRequest = index;
			const replies = msgs.slice(lastRequest + 1).filter((message) => normalizeKind(message.kind) === "reply").filter((message) => !me || message.fromSession !== me);
			if (replies.length) {
				const reply = replies[replies.length - 1];
				return { content: [
					`thread ${threadID} 收到回执（status=${thread?.status ?? "-"}）:`,
					`from=${reply.from} (${reply.fromSession})  ${fmtTime(reply.ts)}`,
					"",
					String(reply.text ?? ""),
					...notes.map((note) => `注: ${note}`)
				].join("\n") };
			}
			const left = deadline - Date.now();
			if (left <= 0) throw new Error(`等待回执超时：thread ${threadID} 在 ${timeoutMs}ms 内没有新的 kind=reply 消息（只看最后一次 request 之后的回执；可加大 timeoutMs，或让对端 collab_reply {threadID}）`);
			await signal.wait(Math.min(400, left));
		}
	}
	/**
	* The 接管请求: one queued prompt to the chosen candidate, used both for the
	* `busy > 30min` wake-up of a peer broadcast and for telling a freshly spawned
	* session what to do. `queue` only — the plugin never interrupts anyone.
	*/
	async function deliverAsk({ record, target, wake, threadID, spawn = false }) {
		const config = readConfig();
		if (await createLineage(ctx).protectedAncestor(target, config.protect)) return false;
		const requester = String(record?.from?.sid ?? "");
		const from = senderLabel(requester) || "handoff";
		const leaseMin = Math.round(BCAST_LEASE_MS / 6e4);
		const body = [
			`[collab-handoff] ${record.title ?? "(untitled)"}`,
			`提案：${record.issuePath ?? "-"}${record.workspace ? `（工作区 ${record.workspace}，scope=${record.scope}）` : ""}`,
			`影响面：${(record.affectedFiles ?? []).slice(0, 8).join(", ") || "(未标注)"}`,
			`期望：${record.expected}`,
			`发起方：${requester || "(记录里没有发起方 sid，回执用 collab_inbox 查)"}`,
			"按顺序完成（三步都不要省略）：",
			...handoffActions({
				bid: record.bid,
				requester,
				spawn,
				leaseMin
			}),
			spawn ? "确实做不了：发 BLOCKED 回执，不要静默挂起。" : "",
			wake ? "（你已 busy 超过 30 分钟，这条是叫醒消息：不打断当前轮，排在下一轮）" : ""
		].filter(Boolean).join("\n");
		try {
			await ctx.session.prompt({
				sessionID: target,
				text: envelope({
					from,
					kind: "request",
					threadID,
					body
				}),
				delivery: "queue",
				metadata: { collab: {
					from,
					fromSessionID: record?.from?.sid ?? "unknown",
					cid: newCorrelationID(),
					kind: "request",
					threadID,
					ts: Date.now()
				} }
			});
			return true;
		} catch (error) {
			log(`deliverAsk failed for ${target}: ${errText(error)}`);
			return false;
		}
	}
	return {
		deps,
		resolveTarget,
		senderLabel,
		isReadonlyAgent,
		resolveMode,
		dispatch,
		waitForReply,
		deliverAsk
	};
}
// src/tools/accept.ts
/**
* `collab_accept` — atomic claim of a broadcast hand-off (one winner via
* `<bid>.lock`), plus the lease/decline bookkeeping that keeps a second
* session from being spawned for the same bid.
*/
function acceptTool(kit) {
	const { deps } = kit;
	const { ctx, readConfig, chain } = deps;
	return {
		name: "collab_accept",
		description: "Claim a broadcast hand-off atomically (one winner): the first caller creates `<bid>.lock` and wins, everyone else is told who already took it — never claim twice and never spawn a second session for the same bid. A session on the `protect` list — or any descendant of one — is refused (a sub-agent cannot claim for a protected line). A session that reports another `location.directory` than the broadcast's workspace is refused. A spawned session's own call moves it from `claimed` to `acked`. After claiming, implement and report back with `collab_send {target:\"<requester sid>\", text:\"[handoff] DONE <bid> <摘要>\", confirm:true}` — writing the conclusion in your own session is NOT a receipt. Requires confirm:true; otherwise it only previews.",
		input: jsonInput({
			properties: {
				bid: {
					type: "string",
					description: "Broadcast id (`b_…`), as shown in the injected 群组广播 line."
				},
				confirm: {
					type: "boolean",
					description: "Must be true to actually claim. false or omitted only returns the preview."
				}
			},
			required: ["bid", "confirm"]
		}),
		async execute(input, context) {
			const bid = String(input?.bid ?? "").trim();
			if (!isValidBid(bid)) throw new Error(`bid 格式不合法："${bid}"（期望 b_<hex16>，从广播/注入行里取）`);
			const existing = readBroadcast(bid);
			if (!existing) throw new Error(`没有广播 ${bid}：${BROADCAST_DIR} 下没有该文件（bid 拼错，或该交接还没被广播）`);
			const now = Date.now();
			const me = context?.sessionID;
			if (!me) throw new Error("collab_accept 需要会话上下文（sessionID）：无法把领取记到某个会话上");
			const guard = await createLineage(ctx).protectedAncestor(me, readConfig().protect);
			if (guard) throw new Error(`拒绝领取：${me} 在 protect 名单内${guard.depth === 0 ? "（自身受保护）" : `（第 ${guard.depth} 级祖先 ${guard.sessionID} 受保护）`}，受保护会话及其子会话不参与广播领取。`);
			let record = persistRefresh(existing, await chain.refresh(existing, now, { actor: me }));
			if (record.state === "expired") throw new Error(`广播 ${bid} 已 expired（attempts=${record.attempts} > 3）：需人工接手，不再自动重投。`);
			if (BCAST_DONE_STATES.includes(String(record.state))) return { content: `广播 ${bid} 已闭环（state=${record.state}）：${record.receipt?.note || "-"}。无需领取。` };
			const activeClaim = record.claim;
			if (activeClaim && ["claimed", "acked"].includes(String(record.state))) {
				if (activeClaim.by === me) {
					if (record.state === "claimed") {
						record = writeBroadcast({
							...record,
							state: "acked",
							ackedAt: now,
							claim: { ...activeClaim }
						});
						releaseLock(bid, [me, String(activeClaim.spawner ?? "")]);
						await chain.notifyRequester(record, {
							text: `ACCEPT ${record.issuePath ?? record.bid} —— ${shortID(me)} 已接手 ${record.bid}（${record.scope}，${record.expected}）。完成后回执 [handoff] DONE ${record.bid} <摘要>。`,
							from: shortID(me)
						});
					} else releaseLock(bid, [me, String(activeClaim.spawner ?? "")]);
					return { content: [`你已领取 ${bid}（state=${record.state}，kind=${activeClaim.kind}，token=${activeClaim.token}）。`, `完成后回执（必发）: collab_send {target:"${record.from?.sid ?? "ses_…"}", text:"[handoff] DONE ${bid} <commit sha 或摘要>", confirm:true}`].join("\n") };
				}
				return { content: `已被 ${activeClaim.by} 领取（bid=${bid} state=${record.state}）—— 不要重复领取，也不要再拉新。` };
			}
			const directory = (await chain.sessionInfo(me))?.location?.directory;
			const notes = [];
			if (record.workspace && directory && directory !== record.workspace) throw new Error(`拒绝领取：广播 ${bid} 属于工作区 ${record.workspace}，当前会话在 ${directory}。群组成员只能是该工作区的会话（跨仓只读，别代领）。`);
			if (!directory) notes.push("会话没有 location.directory：未校验工作区归属。");
			if (input?.confirm !== true) return { content: [
				"未领取（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。",
				`bid=${bid} scope=${record.scope} state=${record.state} attempts=${record.attempts}`,
				`提案: ${record.issuePath ?? "-"}  标题: "${truncate(record.title ?? "(untitled)", 60)}"  期望: ${record.expected}`,
				`影响面(${(record.affectedFiles ?? []).length}): ${(record.affectedFiles ?? []).slice(0, 8).join(", ") || "-"}`,
				`候选 top: ${(record.candidates ?? [])[0] ? `${(record.candidates ?? [])[0].sid} score=${(record.candidates ?? [])[0].score}` : "-"}`,
				...notes.map((note) => `注: ${note}`)
			].join("\n") };
			const claim = claimLock(bid, {
				by: me,
				kind: "accept"
			});
			if (!claim.ok) return { content: `已被 ${claim.holder.by ?? "?"} 领取（bid=${bid}，token=${claim.holder.token ?? "?"}）—— 你不是 winner。不要重复领取，也不要再拉新。` };
			const accepted = {
				...record,
				state: "acked",
				claim: {
					by: me,
					kind: "accept",
					token: claim.claim.token,
					at: claim.claim.at,
					leaseMs: BCAST_LEASE_MS
				},
				ackedAt: now,
				replies: [...record.replies ?? [], {
					from: me,
					at: now,
					text: "ACCEPT"
				}].slice(-50)
			};
			delete accepted.asked;
			record = writeBroadcast(accepted);
			const notified = await chain.notifyRequester(record, {
				text: `ACCEPT ${record.issuePath ?? record.bid} —— ${shortID(me)} 已领取 ${record.bid}（${record.scope}，${record.expected}）。完成后回执 [handoff] DONE|BLOCKED ${record.bid} <摘要>。`,
				from: shortID(me)
			});
			return { content: [
				`已领取 ${bid}（winner，token=${claim.claim.token}，state=acked，lease=${BCAST_LEASE_MS}ms）`,
				`scope=${record.scope} workspace=${record.workspace} 期望=${record.expected}`,
				`提案: ${record.issuePath ?? "-"}  标题: "${truncate(record.title ?? "(untitled)", 60)}"`,
				`影响面(${(record.affectedFiles ?? []).length}): ${(record.affectedFiles ?? []).slice(0, 8).join(", ") || "-"}`,
				record.scope === "peer" ? "跨仓护栏：只允许改目标仓 docs/issues/**，git 只读，不 push；实施由目标仓 owner 复核提交。" : "local scope：按本仓正常权限实施。",
				notified.delivered ? `已通知发起方 ${record.from?.sid}（message=${notified.message ?? "?"}）。` : `未通知发起方：${notified.reason}`,
				`完成后回执（必发）: collab_send {target:"${record.from?.sid ?? "ses_…"}", text:"[handoff] DONE ${bid} <commit sha 或摘要>", confirm:true}`,
				...notes.map((note) => `注: ${note}`)
			].join("\n") };
		}
	};
}
// src/tools/broadcast.ts
/** `collab_broadcast` — cross-workspace (peer) hand-off: score, write, ask/spawn. */
function broadcastTool(kit) {
	const { deps, deliverAsk } = kit;
	const { ctx, chain } = deps;
	return {
		name: "collab_broadcast",
		description: "Broadcast a cross-workspace (peer) hand-off: the proposal must live in the target workspace's docs/issues/ (a symlinked proposal is refused), the plugin scores that workspace's root sessions (0–100, deterministic, with a `why` breakdown), writes the hand-off to the global broadcast directory (0 model calls) and only the asked top-1 candidate receives the takeover request (ACCEPT via collab_accept, or DECLINE; the 5-minute ask lease advances to the next candidate), with one extra queued prompt when it has been busy for more than 30 minutes. When nobody reaches the 80 threshold one session is spawned in the target directory (explore by default; agent:\"build\" needs agentConfirm:true every time; a session whose location cannot be verified is rolled back). The receiving side must accept and then send a receipt (accept → collab_send → \"answering in its own session is not done\"); a spawned session immediately gets the five collab_* rules patched onto *its own* session ruleset (its workspace's project config does not cover it; no edit/write is granted) — `collab_grant` applies the same to an existing session. when a spawned session lets its lease lapse, the requester reads that session's last answer once and closes the hand-off itself when it carries a verdict (receipt.auto), never spawning again. Idempotent: the same proposal content is the same bid. Requires confirm:true; otherwise it only previews.",
		input: jsonInput({
			properties: {
				workspace: {
					type: "string",
					description: "Absolute path of the target workspace (e.g. /data/project/muke-interface)."
				},
				issuePath: {
					type: "string",
					description: "Proposal path relative to the workspace; must be under docs/issues/ and must exist."
				},
				expected: {
					type: "string",
					enum: EXPECTED,
					description: "implement (default) = the peer should change code; review = the peer should confirm."
				},
				agent: {
					type: "string",
					description: "Agent for a spawned session (default `explore`, read-only). Any other agent — `build` in particular — additionally requires agentConfirm:true on every call."
				},
				agentConfirm: {
					type: "boolean",
					description: "Explicit per-call confirmation for spawning a non-explore agent. No whitelist, no default."
				},
				confirm: {
					type: "boolean",
					description: "Must be true to write the broadcast / wake / spawn. false or omitted only previews."
				}
			},
			required: [
				"workspace",
				"issuePath",
				"confirm"
			]
		}),
		async execute(input, context) {
			const me = context?.sessionID;
			const { workspace, issuePath, abs, mtimeMs } = resolveBroadcastTargets(input?.workspace, input?.issuePath);
			const expected = normalizeExpected(input?.expected);
			const agent = String(input?.agent ?? "explore").trim() || "explore";
			const proposal = summarizeProposal(readFileSync(abs, "utf8"), issuePath);
			const bid = broadcastID({
				scope: "peer",
				workspace,
				issuePath,
				contentHash: proposal.contentHash,
				mtimeMs
			});
			const preview = input?.confirm !== true;
			const head = [
				`bid=${bid}  scope=peer  workspace=${workspace}`,
				`提案: ${issuePath}  标题: "${proposal.title}"  期望: ${expected}`,
				`影响面(${proposal.files.length}): ${proposal.files.slice(0, 8).join(", ") || "(未在提案里找到文件路径)"}`
			];
			const existing = readBroadcast(bid);
			if (existing) {
				let record = persistRefresh(existing, await chain.refresh(existing, Date.now(), { actor: me }));
				const askedSid = record?.asked?.sid;
				const top = askedSid ? record?.candidates?.find((candidate) => candidate.sid === askedSid) : record?.candidates?.find((candidate) => candidate.score >= 80 && !(record?.skipped ?? []).includes(candidate.sid));
				const busy = top ? sessionBusyMinutes(await chain.sessionInfo(top.sid) ?? { id: top.sid }) : 0;
				const shouldWake = record?.state === "open" && Boolean(top) && busy > 30 && record.wokeBy !== top?.sid;
				if (shouldWake && !preview && record && top) {
					const woke = await deliverAsk({
						record,
						target: top.sid,
						wake: true
					});
					record = writeBroadcast({
						...record,
						wokeBy: woke ? top.sid : record.wokeBy
					});
				}
				return { content: [
					`已存在同一内容的交接（bid 幂等，不新建）：state=${record?.state} attempts=${record?.attempts}`,
					...head,
					`承接: ${record?.claim?.by ?? "-"}${record?.claim?.kind ? ` (${record.claim.kind})` : ""}  候选 top: ${record?.candidates?.[0] ? `${record.candidates[0].sid} score=${record.candidates[0].score}` : "-"}  当前问询: ${record?.asked?.sid ?? "-"}`,
					BCAST_DONE_STATES.includes(String(record?.state)) ? `已闭环（state=${record?.state}）：${record?.receipt?.note ?? "-"}，不会再投递。` : shouldWake ? preview ? `top-1 ${top?.sid} 已 busy ${Math.round(busy)}min：确认后会补发 1 条叫醒 prompt。` : `已补发 1 条叫醒 prompt → ${top?.sid}（busy ${Math.round(busy)}min）。` : "没有需要补发/重投的动作（只提醒发起方一次，见 SessionStart 注入）。",
					`回执格式: [handoff] DONE|BLOCKED ${bid} <摘要>（必须由承接方 ${record?.claim?.by ?? "ses_…"} 发送）`
				].join("\n") };
			}
			const ranking = await chain.rankCandidates({
				workspace,
				proposal,
				expected,
				exclude: me ? [me] : []
			});
			const ranked = ranking.candidates;
			const top = ranked.find((candidate) => candidate.score >= 80);
			const plannedSpawn = !top;
			if (preview) return { content: [
				"未广播（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。",
				...head,
				`群组成员 ${ranking.members} 个根会话（已排除子会话与 [protected*]），匹配分（阈值 80）:`,
				...ranked.length ? ranked.map((candidate) => `  ${candidate.score.toString().padStart(3)}  ${candidate.sid}  agent=${candidate.info?.agent ?? "?"}  "${truncate(candidate.info?.title ?? "(untitled)", 50)}"  why=[${candidate.why.join(", ")}]`) : ["  （没有可用候选）"],
				plannedSpawn ? `无候选 ≥80 → 确认后用 claim(kind=spawn) 拉新一个会话：agent=${agent} location.directory=${workspace} title="impl:${proposal.slug}"${agent === "explore" ? "" : "（需要 agentConfirm:true）"}` : `top-1 ${top.sid} score=${top.score}${top.busyMinutes > 30 ? ` 已 busy ${Math.round(top.busyMinutes)}min → 确认后补发 1 条 queue prompt 叫醒` : " → 不投递任何 prompt（接管请求走它的下一轮 context 注入，0 调用）"}；只有它会收到接管请求：ACCEPT = collab_accept，DECLINE（回 \`DECLINE ${bid} <理由>\`）/ 5 分钟不答 → 顺延下一候选（attempts+1）`
			].join("\n") };
			if (!top) {
				const claimer = me ?? "unknown";
				const claim = claimLock(bid, {
					by: claimer,
					kind: "spawn"
				});
				if (!claim.ok) return { content: [
					`未拉新：bid 已被 ${claim.holder.by ?? "?"} 领取（并发下只有一个 winner）。`,
					...head,
					`用 collab_accept {bid:"${bid}"} 查看/接手；不要重复拉新。`
				].join("\n") };
				if (agent !== "explore" && input?.agentConfirm !== true) {
					releaseLock(bid, claimer);
					throw new Error(`拒绝拉新：agent="${agent}" 需要每次显式确认（传 agentConfirm:true）。默认 explore 是只读的，不需要该参数。未创建任何会话。`);
				}
				let created;
				try {
					created = await ctx.session.create({
						title: `impl:${proposal.slug}`,
						agent,
						location: { directory: workspace }
					});
				} catch (error) {
					releaseLock(bid, claimer);
					throw new Error(`拉新失败（未创建会话）：${errText(error)}`, { cause: error });
				}
				const info = created?.data ?? created;
				const landed = info?.location?.directory;
				if (!info?.id || landed !== workspace) {
					if (info?.id) await ctx.session.remove({ sessionID: info.id }).catch(() => {});
					releaseLock(bid, [claimer, String(info?.id ?? "")]);
					throw new Error(`拉新失败：会话落点不对（期望 ${workspace}，实际 ${landed ?? "(未知)"}），已回滚刚建的会话。`);
				}
				updateLock(bid, { claimBy: info.id });
				const spawned = {
					bid,
					scope: "peer",
					workspace,
					issuePath,
					title: proposal.title,
					expected,
					affectedFiles: proposal.files,
					candidates: ranked.slice(0, 10).map((candidate) => ({
						sid: candidate.sid,
						score: candidate.score,
						why: candidate.why
					})),
					state: "claimed",
					claim: {
						by: info.id,
						kind: "spawn",
						token: claim.claim.token,
						at: claim.claim.at,
						leaseMs: BCAST_LEASE_MS,
						spawner: claimer
					},
					attempts: 0,
					skipped: [],
					seenBy: [],
					reminded: [],
					replies: [],
					from: {
						sid: me,
						directory: ctx?.location?.directory
					},
					createdAt: Date.now()
				};
				const granted = await chain.grantForSession(info.id, {
					reason: "spawn",
					by: claimer
				}).catch((error) => ({
					ok: false,
					phase: "internal",
					reason: `内部错误：${errText(error)}`
				}));
				const record = writeBroadcast({
					...spawned,
					permissionGrant: granted.ok ? "granted" : "failed"
				});
				const delivered = await deliverAsk({
					record,
					target: info.id,
					wake: false,
					threadID: void 0,
					spawn: true
				});
				return { content: [
					`已广播并拉新（无候选 ≥80）：bid=${bid}`,
					...head,
					`新会话: ${info.id} agent=${info.agent ?? agent} loc=${landed} title="impl:${proposal.slug}"`,
					granted.ok ? `已自动授予 5 条 collab_* 会话级权限（changed=${granted.changed}，记录 ${grantFile(info.id)}）。` : `未授予权限（${granted.reason}）→ 交接照常；对端无法回执时按租约到期自动提取。`,
					delivered ? "已向新会话投递接管请求（queue）。" : "新会话已创建，但接管请求投递失败（用 collab_send 补发）。",
					...handoffActions({
						bid,
						requester: me,
						spawn: true
					}),
					`该会话不会被删除（collab_list 标 [bootstrap]）；对端不动作时，租约到期会只读提取它的结论并自动闭环。`
				].join("\n") };
			}
			const record = writeBroadcast({
				bid,
				scope: "peer",
				workspace,
				issuePath,
				title: proposal.title,
				expected,
				affectedFiles: proposal.files,
				candidates: ranked.slice(0, 10).map((candidate) => ({
					sid: candidate.sid,
					score: candidate.score,
					why: candidate.why
				})),
				state: "open",
				asked: {
					sid: top.sid,
					at: Date.now(),
					leaseMs: BCAST_LEASE_MS
				},
				attempts: 0,
				skipped: [],
				seenBy: [],
				askSeen: [],
				reminded: [],
				replies: [],
				from: {
					sid: me,
					directory: ctx?.location?.directory
				},
				createdAt: Date.now()
			});
			const wake = top.busyMinutes > 30;
			if (wake ? await deliverAsk({
				record,
				target: top.sid,
				wake: true
			}) : false) writeBroadcast({
				...record,
				wokeBy: top.sid
			});
			return { content: [
				`已广播 peer 交接：bid=${bid}（写入 ${BROADCAST_DIR}，其余成员 0 模型调用）`,
				...head,
				`匹配分（阈值 80）:`,
				...ranked.slice(0, 5).map((candidate) => `  ${candidate.score.toString().padStart(3)}  ${candidate.sid}  busy=${Math.round(candidate.busyMinutes)}min  why=[${candidate.why.join(", ")}]`),
				wake ? `top-1 ${top.sid} busy ${Math.round(top.busyMinutes)}min → 已补发 1 条 queue prompt 叫醒。` : `top-1 ${top.sid} → 未投递 prompt：它下一次模型请求会看到群组广播，用 collab_accept {bid:"${bid}"} 领取。`,
				...handoffActions({
					bid,
					requester: me
				}),
				`推辞: collab_send {target:"${me ?? "ses_…"}", text:"DECLINE ${bid} <理由>", confirm:true}（由被问询的 top-1 发回；不带 bid 且同时有多个问询时不会被采纳）`
			].join("\n") };
		}
	};
}
// src/tools/grant.ts
/**
* `collab_grant` — add the five `collab_*` allow rules to *one* session's own
* permission ruleset (whole-set PATCH with a recorded pre-grant snapshot), and
* `revoke:true` to restore that snapshot.
*/
function grantTool(kit) {
	const { deps, resolveTarget } = kit;
	const { ctx, readConfig, chain } = deps;
	return {
		name: "collab_grant",
		description: "Add the five collab_* allow rules (collab_list/inbox/wait/reply/send) to *one* session's own permission ruleset with a session-level PATCH — the project-level `agents.*.permissions` of another workspace does not apply to its sessions, so a spawned peer `explore` otherwise cannot accept or send a receipt. Merges with the existing ruleset (nothing is dropped, order and precedence of existing rules kept) and grants no capability beyond those five actions: edit/write/shell are never added. Idempotent; the pre-grant ruleset is recorded under ~/.config/opencode/collab-grants/<sid>.json. `revoke:true` restores that snapshot and drops the record. Protected sessions and their descendants are refused. Requires confirm:true; otherwise it only previews target (id/agent/title/loc) and the rules that would be added or restored.",
		input: jsonInput({
			properties: {
				target: {
					type: "string",
					description: "Session id (`ses_…`) or an alias."
				},
				revoke: {
					type: "boolean",
					description: "Restore the recorded pre-grant ruleset for this session and remove the record."
				},
				confirm: {
					type: "boolean",
					description: "Must be true to PATCH the session's permissions. false or omitted only previews."
				}
			},
			required: ["target", "confirm"]
		}),
		async execute(input, context) {
			const config = readConfig();
			const { sessionID, alias, info } = await resolveTarget(input?.target);
			const guard = await createLineage(ctx).protectedAncestor(sessionID, config.protect);
			if (guard) {
				const where = guard.depth === 0 ? "本身" : `的祖先（第 ${guard.depth} 级）${guard.sessionID} `;
				throw new Error(`拒绝授权：目标 ${sessionID}${alias ? `（别名 ${alias}）` : ""} ${where}在 protect 名单内（覆盖其任意层级子会话）。未修改任何 permissions。`);
			}
			const me = context?.sessionID;
			const revoke = input?.revoke === true;
			const loc = info?.location?.directory ?? "(unknown)";
			const targetLine = `目标: ${sessionID}${alias ? ` (alias=${alias})` : ""}  agent=${info?.agent ?? "?"}  loc=${loc}  title="${truncate(info?.title ?? "(untitled)", 60)}"`;
			const fmtRules = (rules) => rules.length ? rules.slice(0, 10).map((rule) => `${rule.action}:${rule.resource}=${rule.effect}`).join(", ") + (rules.length > 10 ? ` …(+${rules.length - 10})` : "") : "(无)";
			const grantPath = grantFile(sessionID);
			const record = readGrant(sessionID);
			const grantRecord = grantHalfOf(record);
			const promoteOnly = Boolean(record) && !grantRecord;
			if (input?.confirm !== true) {
				let current = [];
				let readError;
				try {
					current = await chain.readSessionPermissions(sessionID);
				} catch (error) {
					readError = String(error?.message ?? error);
				}
				if (revoke) return { content: [
					"未还原（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true + revoke:true。",
					targetLine,
					grantRecord ? `授权记录: reason=${grantRecord.reason} by=${grantRecord.by || "-"} at=${fmtTime(grantRecord.at)} added=${(grantRecord.added ?? []).join(",") || "-"} → ${grantPath}` : `授权记录: 无（${grantPath} 不存在）→ 确认后会报「无可还原」`,
					promoteOnly ? `仅有 promote 记录（agentBefore=${record?.agentBefore}），无 permissions 快照 → 确认后会报「无可还原」，且不会删除 promote 记录。` : "",
					grantRecord ? `将整集恢复为快照的 ${(grantRecord.before ?? []).length} 条: ${fmtRules(grantRecord.before ?? [])}` : "",
					"注: 还原是整集替换；快照之后对同一会话的其它 permissions 改动也会被覆盖。"
				].filter(Boolean).join("\n") };
				return { content: [
					"未修改（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。",
					targetLine,
					readError ? `读取现有 permissions 失败: ${readError}` : `现有会话级规则 ${current.length} 条: ${fmtRules(current)}`,
					`将追加(仅缺失的 ${readError ? 5 : missingRules(current, collabPermissionRules()).length} 条): ${COLLAB_TOOL_ACTIONS.join(" / ")}  (resource="*", effect="allow")`,
					"不会授予 edit / write / shell / read 等任何其它能力；不存在的规则不会重复追加。",
					`记录: ${grantPath}（before = 首次授权前的快照${grantRecord ? "，已存在（不会覆盖）" : ""}）`,
					grantRecord ? `已有记录: reason=${grantRecord.reason} by=${grantRecord.by || "-"} added=${(grantRecord.added ?? []).join(",") || "-"}` : "",
					promoteOnly ? `注: ${grantPath} 里仅有 promote 记录（agentBefore=${record?.agentBefore}），无 grant 记录 / permissions 快照，本次会补写 grant 半段（两半共存，互不覆盖）。` : ""
				].filter(Boolean).join("\n") };
			}
			if (revoke) {
				const result = await chain.revokeForSession(sessionID);
				if (!result.ok) return { content: [`未还原：${result.reason}`, targetLine].join("\n") };
				return { content: [
					`已还原会话级 permissions 并删除记录: ${sessionID}`,
					targetLine,
					`恢复为 before 的 ${result.restored.length} 条: ${fmtRules(result.restored)}`,
					`复核(GET permissions): ${result.verified.length} 条: ${fmtRules(result.verified)}`,
					result.leftover ? `台账保留 promote 半段（agentBefore=${result.leftover.agentBefore}）: ${grantPath}` : `记录已删除: ${grantPath}`,
					result.restored.length === 0 ? "before 为空 = 该会话本来没有会话级规则（agent 规则恢复生效），不是「删掉 5 条」。" : ""
				].filter(Boolean).join("\n") };
			}
			const result = await chain.grantForSession(sessionID, {
				reason: "grant",
				by: me ?? ""
			});
			if (!result.ok) return { content: [
				`未授予权限（${result.phase}）: ${result.reason}`,
				targetLine,
				"交接可照常进行：对端不动作时，租约到期会只读提取它的结论并自动闭环。"
			].join("\n") };
			return { content: [
				`已授予 5 条 collab_* 会话级权限: ${sessionID}（changed=${result.changed}）`,
				targetLine,
				`追加: ${result.added.map((rule) => rule.action).join(" / ") || "(已存在，未重复追加)"}`,
				`现有规则 ${result.verified.length} 条（原规则保留）: ${fmtRules(result.verified)}`,
				`记录: ${grantPath}（before=${result.record?.before?.length ?? 0} 条，reason=${result.record?.reason ?? "grant"}）`,
				`撤销: collab_grant {target:"${sessionID}", revoke:true, confirm:true}`
			].join("\n") };
		}
	};
}
// src/tools/handoff.ts
/**
* `collab_handoff` — hand a task to another session of *this* workspace through
* the existing thread protocol (local scope: `kind=request`, `mode=queue`,
* reply with `collab_reply`). Without `target` the same 0–100 score as
* `collab_broadcast` picks one candidate.
*/
function handoffTool(kit) {
	const { deps, resolveTarget, resolveMode, dispatch } = kit;
	const { ctx, readConfig, chain } = deps;
	return {
		name: "collab_handoff",
		description: "Hand a task to another session of *this* workspace (local scope) over the existing thread protocol: kind=request, mode=queue, reply with collab_reply. Without `target` the plugin picks one: a single available session is used directly, several are ranked with the same 0–100 score as collab_broadcast (threshold 80, `why` breakdown). Requires confirm:true; otherwise it only previews the choose/deliver plan.",
		input: jsonInput({
			properties: {
				target: {
					type: "string",
					description: "Session id (`ses_…`) or an alias. Omit to let the plugin pick."
				},
				text: {
					type: "string",
					description: "Task body (no prefix needed). File paths in it drive the ranking."
				},
				expected: {
					type: "string",
					enum: EXPECTED,
					description: "implement (default) / review — only used when the plugin has to pick the target."
				},
				confirm: {
					type: "boolean",
					description: "Must be true to actually deliver. false or omitted only returns the preview."
				}
			},
			required: ["text", "confirm"]
		}),
		async execute(input, context) {
			const me = context?.sessionID;
			const workspace = ctx?.location?.directory;
			const body = String(input?.text ?? "").trim();
			if (!body) throw new Error("text 不能为空");
			const expected = normalizeExpected(input?.expected);
			const notes = [];
			let target;
			let ranking;
			if (input?.target) target = await resolveTarget(input?.target);
			else {
				if (!workspace) throw new Error("缺少工作区信息（ctx.location.directory），无法自动选人；请显式传 target");
				const proposal = summarizeProposal(body, `handoff-${hash16(body).slice(0, 8)}.md`);
				ranking = await chain.rankCandidates({
					workspace,
					proposal,
					expected,
					exclude: me ? [me] : []
				});
				const candidates = ranking.candidates;
				if (!candidates.length) throw new Error("本工作区没有可用候选（已排除子会话、[protected*] 与当前会话）：请显式传 target，或改用 collab_broadcast 拉新。");
				const single = candidates.length === 1;
				const best = candidates[0];
				if (!single && best.score < 80) throw new Error(`没有匹配分 ≥80 的目标，未投递。候选：\n${candidates.slice(0, 5).map((candidate) => `  ${candidate.score}  ${candidate.sid} why=[${candidate.why.join(", ")}]`).join("\n")}\n请显式传 target（或先补上下文再交接）。`);
				target = {
					sessionID: best.sid,
					alias: void 0,
					info: best.info ?? { id: best.sid }
				};
				notes.push(single ? "目标会话唯一：直接投递（未走打分）。" : `多候选：按匹配分选中 ${best.sid}（score=${best.score}，why=[${best.why.join(", ")}]）。`);
			}
			const { mode, forced } = resolveMode("queue", context?.agent);
			const threadID = newThreadID();
			const bid = broadcastID({
				scope: "local",
				workspace,
				issuePath: `local/${target.sessionID}`,
				contentHash: hash16(body),
				mtimeMs: 0
			});
			const previous = readBroadcast(bid);
			if (previous) {
				const record = persistRefresh(previous, await chain.refresh(previous, Date.now(), { actor: me }));
				return { content: [
					BCAST_DONE_STATES.includes(String(record.state)) ? `已闭环（state=${record.state}）：${record.receipt?.note ?? "-"}。不重复投递、不改状态。` : `已存在同一交接（bid 幂等，不重复投递）：state=${record.state}，thread=${record.threadID ?? "-"}。等结果用 collab_wait {threadID:"${record.threadID ?? "…"}"}。`,
					`bid=${bid}  thread=${record.threadID ?? "-"}  承接=${record.claim?.by ?? "-"}`,
					`目标: ${target.sessionID}（local scope，回执用 collab_reply {threadID} 或 [handoff] DONE ${bid}）`
				].join("\n") };
			}
			if (input?.confirm !== true) {
				const config = readConfig();
				const guard = await createLineage(ctx).protectedAncestor(target.sessionID, config.protect);
				return { content: [
					"未投递（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。",
					`目标: ${target.sessionID} agent=${target.info?.agent ?? "?"} state=${sessionState(target.info)} title="${truncate(target.info?.title ?? "(untitled)", 60)}"`,
					guard ? `拒绝提示: 目标在 protect 名单内（depth=${guard.depth}），确认后仍会被拒绝。` : "",
					`kind=request mode=${forced ? "queue(forced)" : mode} thread=${threadID} bid=${bid}`,
					...notes.map((note) => `注: ${note}`),
					...ranking ? [`候选（阈值 80）:`, ...ranking.candidates.slice(0, 5).map((candidate) => `  ${candidate.score}  ${candidate.sid} why=[${candidate.why.join(", ")}]`)] : []
				].filter(Boolean).join("\n") };
			}
			const delivered = await dispatch({
				context,
				input: {
					text: body,
					confirm: true
				},
				kind: "request",
				threadID,
				mode,
				forced,
				notes,
				target
			});
			writeBroadcast({
				bid,
				scope: "local",
				workspace,
				issuePath: void 0,
				threadID,
				title: truncate(body.split("\n")[0] ?? body, 120),
				expected,
				affectedFiles: extractPaths(body),
				candidates: ranking ? ranking.candidates.slice(0, 10).map(({ sid, score, why }) => ({
					sid,
					score,
					why
				})) : [],
				state: "acked",
				claim: {
					by: target.sessionID,
					kind: "handoff",
					token: `h_${bid.slice(2, 10)}`,
					at: Date.now(),
					leaseMs: BCAST_LEASE_MS
				},
				attempts: 0,
				skipped: [],
				seenBy: [],
				reminded: [],
				replies: [],
				from: {
					sid: me,
					directory: workspace
				},
				createdAt: Date.now()
			});
			return { content: [
				delivered.content,
				`bid=${bid}  thread=${threadID}（local scope，回执用 collab_reply {threadID}）`,
				`等结果: collab_wait {threadID:"${threadID}", timeoutMs:…}`
			].join("\n") };
		}
	};
}
// src/tools/inbox.ts
/**
* `collab_inbox` — the authoritative read of this session's cross-session
* messages. Read-only: it never advances the cursor, so the injected summary can
* stay short without losing the full body.
*/
function inboxTool(kit) {
	const { deps } = kit;
	const { inbox, threads } = deps;
	return {
		name: "collab_inbox",
		description: "Read this session's cross-session messages in full: kind (request/reply/note), threadID, thread status (open/answered/closed) and sender. Bodies are returned verbatim up to 4000 characters per message. Read-only — it never advances any cursor, so it stays usable as the authoritative view even when the injected summary is short.",
		input: jsonInput({
			properties: { limit: {
				type: "number",
				description: "Maximum number of messages to return (default 10, max 50)."
			} },
			required: []
		}),
		async execute(input, context) {
			const sessionID = context?.sessionID;
			if (!sessionID) return { content: "无法确定当前会话 id（缺少工具上下文）。" };
			const box = await inbox.read(sessionID);
			if (!box.messages.length) return { content: "[collab] 本会话还没有任何跨会话消息。" };
			const limit = clamp(input?.limit ?? 10, 1, 50);
			const shown = box.messages.slice(-limit);
			const offset = box.messages.length - shown.length;
			const injected = new Set(box.injected);
			const lines = [];
			for (const [index, message] of shown.entries()) {
				const threadID = normalizeThreadID(message.threadID);
				const thread = threadID ? await threads.read(threadID) : void 0;
				const flags = [
					offset + index >= box.cursor ? "new" : "seen",
					messageIDs(message).some((id) => injected.has(id)) ? "injected" : "",
					thread ? `status=${thread.status}` : ""
				].filter(Boolean);
				lines.push(`${fmtTime(message.ts)}  [${normalizeKind(message.kind)}] thread=${threadID ?? "-"}  from=${message.from} (${message.fromSession})  ${flags.join(" ")}\n    ${truncateRaw(message.text, INBOX_TEXT_LIMIT)}`);
			}
			const unread = Math.max(0, box.messages.length - box.cursor);
			return { content: [
				`[collab] 共 ${box.size} 条，未读 ${unread} 条（显示最近 ${shown.length} 条，单条上限 ${INBOX_TEXT_LIMIT} 字）:`,
				...lines,
				"回执用 collab_reply {threadID}；等结果用 collab_wait {threadID}；无 thread 的 legacy 消息无需回执。"
			].join("\n") };
		}
	};
}
// src/tools/list.ts
/** `collab_list` — read-only session + open hand-off inventory. */
function listTool(kit) {
	const { deps } = kit;
	const { ctx, readConfig, chain } = deps;
	return {
		name: "collab_list",
		description: "List OpenCode sessions usable as collab targets: id, agent, state (busy/idle), title, parent, alias and `loc=<项目名>`. Read-only. `directory` limits the list to one workspace (default: every session the host returns). Sessions in the `protect` list are marked [protected]; their descendants are marked [protected-child] — neither can be sent to. Sessions spawned by a broadcast carry [bootstrap].",
		input: jsonInput({
			properties: {
				limit: {
					type: "number",
					description: "Maximum number of sessions to return (default 20, max 100)."
				},
				directory: {
					type: "string",
					description: "Only list sessions of this workspace (absolute path). Omit to keep the old behaviour."
				}
			},
			required: []
		}),
		async execute(input, context) {
			const config = readConfig();
			const limit = clamp(input?.limit ?? 20, 1, 100);
			const directory = String(input?.directory ?? "").trim() || void 0;
			if (directory && !isAbsolute(directory)) throw new Error(`directory 必须是绝对路径："${directory}"`);
			const sessions = (await chain.listSessions({
				directory,
				limit
			})).slice(0, limit);
			if (!sessions.length) return { content: `${directory ? `工作区 ${directory} 下` : ""}没有可列出的会话。` };
			const lineage = createLineage(ctx);
			lineage.seed(sessions);
			const aliasesOf = (sessionID) => Object.entries(config.aliases).filter(([, value]) => value === sessionID).map(([name]) => name);
			const spawned = new Set(allBroadcasts().filter((record) => record.claim?.kind === "spawn").map((record) => String(record.claim?.by ?? "")));
			const lines = [];
			for (const info of sessions) {
				const aliases = aliasesOf(info.id);
				const guard = await lineage.protectedAncestor(info.id, config.protect);
				const marks = [
					info.id === context?.sessionID ? "self" : "",
					guard?.depth === 0 ? "protected" : "",
					guard && guard.depth > 0 ? "protected-child" : "",
					spawned.has(info.id) || BOOTSTRAP_TITLE_RE.test(String(info.title ?? "")) ? "bootstrap" : ""
				].filter(Boolean);
				const suffix = [
					aliases.length ? `alias=${aliases.join(",")}` : "",
					marks.length ? `[${marks.join(",")}]` : "",
					info.parentID ? `parent=${shortID(info.parentID)}` : ""
				].filter(Boolean).join(" ");
				const loc = info?.location?.directory ? basename(info.location.directory) : "?";
				lines.push([
					info.id,
					`${info.agent ?? "?"}`,
					sessionState(info),
					`loc=${loc}`,
					fmtTime(info?.time?.updated),
					`"${truncate(info.title ?? "(untitled)", 60)}"`,
					suffix
				].filter(Boolean).join("  "));
			}
			const now = Date.now();
			const broadcasts = allBroadcasts().filter((record) => (directory ? record.workspace === directory : true) && !BCAST_DONE_STATES.includes(String(record.state))).map((record) => {
				const lease = leaseVerdict(record, now);
				return `- ${record.bid} ${record.state}${lease ? ` lease=${lease}` : ""} scope=${record.scope} "$ ${truncate(record.title ?? "(untitled)", 50)}" 提案=${record.issuePath ?? "-"} 承接=${record.claim?.by ?? "-"} attempts=${record.attempts}${record.asked?.sid ? ` 问询=${record.asked.sid}` : ""}`;
			});
			return { content: [
				`${sessions.length} 个会话（id / agent / state / loc / updated / title）:`,
				...lines,
				"[protected] / [protected-child] 均不可投递（后者是受保护会话的子会话）；[bootstrap] 是广播拉起的会话。",
				...broadcasts.length ? [
					"未闭环交接:",
					...broadcasts,
					"lease=expired 只表示「按快照看租约已过」——本命令不改状态、不删锁、不推进顺延；",
					"真正的顺延发生在下一次 collab_accept / 广播 / context 注入时。"
				] : []
			].join("\n") };
		}
	};
}
// src/tools/promote.ts
/**
* `collab_promote` — switch *one* session's agent (whitelisted `build`/`plan`)
* after it has accepted a hand-off, with `revert:true` to restore the recorded
* pre-promotion agent. The record shares the `collab_grant` ledger file.
*/
function promoteTool(kit) {
	const { deps, resolveTarget } = kit;
	const { ctx, readConfig, chain } = deps;
	return {
		name: "collab_promote",
		description: "Switch *one* session's agent (`POST /api/session/{id}/agent`, i.e. `session.switchAgent`) so it can actually change code — use it only after that session ACCEPTed a hand-off (collab_accept) and the work needs edits. A hand-off broadcast with expected:\"review\" must never be promoted: review needs no execution. Target agent defaults to build and is whitelisted to [build, plan]; explore stays the read-only default. The current agent is recorded in the same ledger as `collab_grant` (agentBefore / promotedAt / promotedBy, the permission half is preserved), and `revert:true` switches back to that original value and drops the record. Protected sessions and their descendants are refused. Requires confirm:true; otherwise it only previews target (id/agent/title/loc) and `原 agent → 目标 agent`.",
		input: jsonInput({
			properties: {
				target: {
					type: "string",
					description: "Session id (`ses_…`) or an alias."
				},
				agent: {
					type: "string",
					enum: PROMOTE_AGENTS,
					description: "Agent to switch to (default build). Anything outside [build, plan] is refused."
				},
				revert: {
					type: "boolean",
					description: "Switch back to the recorded pre-promotion agent and remove that record."
				},
				confirm: {
					type: "boolean",
					description: "Must be true to switch the agent. false or omitted only previews."
				}
			},
			required: ["target", "confirm"]
		}),
		async execute(input, context) {
			const config = readConfig();
			const { sessionID, alias, info } = await resolveTarget(input?.target);
			const guard = await createLineage(ctx).protectedAncestor(sessionID, config.protect);
			if (guard) {
				const where = guard.depth === 0 ? "本身" : `的祖先（第 ${guard.depth} 级）${guard.sessionID} `;
				throw new Error(`拒绝切换 agent：目标 ${sessionID}${alias ? `（别名 ${alias}）` : ""} ${where}在 protect 名单内（覆盖其任意层级子会话）。未修改任何会话。`);
			}
			const me = context?.sessionID;
			const agent = String(input?.agent ?? "build").trim() || "build";
			const revoke = input?.revert === true;
			if (!revoke && !PROMOTE_AGENTS.includes(agent)) throw new Error(`拒绝切换：agent="${agent}" 不在白名单（只允许 ${PROMOTE_AGENTS.join(" / ")}）。未修改任何会话。`);
			const loc = info?.location?.directory ?? "(unknown)";
			const current = String(info?.agent ?? "(unknown)");
			const targetLine = `目标: ${sessionID}${alias ? ` (alias=${alias})` : ""}  agent=${current}  loc=${loc}  title="${truncate(info?.title ?? "(untitled)", 60)}"`;
			const grantPath = grantFile(sessionID);
			const record = readGrant(sessionID);
			if (input?.confirm !== true) {
				if (revoke) return { content: [
					"未还原（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true + revert:true。",
					targetLine,
					record?.agentBefore ? `将切回原 agent: ${current} → ${record.agentBefore}（记录 promotedAt=${fmtTime(record.promotedAt)} by=${record.promotedBy || "-"} → ${grantPath}）` : `promote 记录: 无（${grantPath} 里没有 agentBefore）→ 确认后会报「无可还原」`,
					"注: 只还原 agent，不影响同一记录里的 permissions 快照。"
				].join("\n") };
				return { content: [
					"未切换（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。",
					targetLine,
					`原 agent ${current} → 目标 agent ${agent}（白名单 ${PROMOTE_AGENTS.join(" / ")}）`,
					`记录: ${grantPath}（agentBefore=${record?.agentBefore ?? current}，与 permissions 记录合并写、互不覆盖）`,
					"只在对端 collab_accept 领取且确需改代码时使用；expected:\"review\" 的交接永不 promote。",
					record?.agentBefore ? `已有记录: agentBefore=${record.agentBefore}（不会覆盖）` : ""
				].filter(Boolean).join("\n") };
			}
			if (revoke) {
				const result = await chain.revertSessionAgent(sessionID);
				if (!result.ok) return { content: [`未还原：${result.reason}`, targetLine].join("\n") };
				return { content: [
					`已把 agent 切回原值: ${sessionID}`,
					targetLine,
					`还原: ${result.from} → ${result.restored}`,
					`复核(GET agent): ${result.verified}`,
					result.leftover ? `记录保留 permissions 半段（before=${result.leftover.before?.length ?? 0} 条）: ${grantPath}` : `promote 记录已删除: ${grantPath}`
				].join("\n") };
			}
			const result = await chain.promoteSession(sessionID, {
				agent,
				by: me ?? ""
			});
			if (!result.ok) return { content: [
				`未切换 agent（${result.phase}）: ${result.reason}`,
				targetLine,
				"已有交接不受影响；对端保持原 agent（若原为 explore 则仍只读，不能改代码）。"
			].join("\n") };
			return { content: [
				`已切换 agent: ${sessionID}（${result.from} → ${result.to}，changed=${result.changed}）`,
				targetLine,
				`复核(GET agent): ${result.verified}`,
				`记录: ${grantPath}（agentBefore=${result.agentBefore}，reason 半段与 permissions 记录共存）`,
				`还原: collab_promote {target:"${sessionID}", revert:true, confirm:true}`,
				"提醒: 只在对端 ACCEPT 且确需改代码时 promote；expected:\"review\" 的交接永不 promote。"
			].join("\n") };
		}
	};
}
// src/tools/reply.ts
/**
* `collab_reply` — sugar for `collab_send {kind:"reply", threadID}` with the
* counterpart resolved from storage, so the receiver never has to look up a
* `ses_…` id to answer. Always `queue`: a reply must not interrupt the
* requester's running turn.
*/
function replyTool(kit) {
	const { deps, resolveTarget, resolveMode, dispatch } = kit;
	const { threads } = deps;
	return {
		name: "collab_reply",
		description: "Reply on an existing hand-off thread: sugar for collab_send {kind:\"reply\", threadID} against the thread's counterpart (resolved from storage, so no target is needed). Only a participant of the thread may reply. Always delivered with mode=queue, so it never interrupts the requester's running turn. Requires confirm:true; otherwise it only previews.",
		input: jsonInput({
			properties: {
				threadID: {
					type: "string",
					description: "Thread to answer (`t_…`), as received in the request."
				},
				text: {
					type: "string",
					description: "Reply body (no prefix needed; it is added for you)."
				},
				confirm: {
					type: "boolean",
					description: "Must be true to actually deliver. false/omitted only returns the preview."
				}
			},
			required: [
				"threadID",
				"text",
				"confirm"
			]
		}),
		async execute(input, context) {
			const threadID = normalizeThreadID(input?.threadID);
			if (!threadID) throw new Error("threadID 不能为空：回执必须带上原请求的 threadID");
			if (!isValidThreadID(threadID)) throw new Error(`threadID 格式不合法："${threadID}"`);
			const thread = await threads.read(threadID);
			if (!thread) throw new Error(`storage 里没有 thread ${threadID}：无法确定对端。请改用 collab_send {target, kind:"reply", threadID:"${threadID}", text, confirm:true} 显式指定目标。`);
			const me = context?.sessionID;
			const participants = [thread.fromSession, thread.toSession].filter(Boolean);
			const notes = [];
			if (me && !participants.includes(me)) throw new Error(`拒绝回执：当前会话 ${me} 不是 thread ${threadID} 的参与方（发起方 ${thread.fromSession ?? "?"}，对端 ${thread.toSession ?? "?"}）。未发送任何内容。`);
			if (!me) notes.push("无会话上下文（无 sessionID）：未校验参与者身份。");
			const counterpart = me ? thread.fromSession === me ? thread.toSession : thread.fromSession : thread.fromSession ?? thread.toSession;
			if (!counterpart) throw new Error(`thread ${threadID} 没有记录对端会话 id，无法自动回复；请用 collab_send 显式指定 target`);
			const { mode, forced } = resolveMode("queue", context?.agent);
			const target = await resolveTarget(counterpart);
			return dispatch({
				context,
				input,
				kind: "reply",
				threadID,
				mode,
				forced,
				notes,
				target
			});
		}
	};
}
// src/tools/send.ts
/**
* `collab_send` — the raw delivery primitive: envelope + thread bookkeeping via
* `dispatch`, with the reply-routing guards (a reply must come from a
* participant and go to the thread's counterpart).
*/
function sendTool(kit) {
	const { deps, resolveTarget, resolveMode, dispatch } = kit;
	const { threads } = deps;
	return {
		name: "collab_send",
		description: "Send a message into another OpenCode session's input stream (asynchronous admit, does NOT wait for a reply). A message is part of a hand-off thread: kind request|reply|note (default request) plus a threadID (auto-generated when omitted). Default mode is `queue`, which waits for the target's next turn and never interrupts the turn it is running; `steer` must be explicit and is forced back to `queue` for read-only agents (explore/plan). Body is prefixed `[collab:<from>][<kind>:<threadID>] `. Requires confirm:true — with confirm:false it only previews. Targets in the `protect` list — and any descendant of one — are refused; a kind=reply must target the thread's counterpart and only a participant may send it.",
		input: jsonInput({
			properties: {
				target: {
					type: "string",
					description: "Session id (`ses_…`) or an alias from collab.json."
				},
				text: {
					type: "string",
					description: "Message body (no prefix needed; it is added for you)."
				},
				kind: {
					type: "string",
					enum: KINDS,
					description: "request (default) = ask the target to do something; reply = answer an existing thread (requires threadID); note = informational, does not change the thread status."
				},
				threadID: {
					type: "string",
					description: "Thread to attach to. Omit for a new request (auto-generated). A reply without threadID is treated as a new request and the result says so."
				},
				mode: {
					type: "string",
					enum: ["queue", "steer"],
					description: "queue (default) waits for the target's next turn — does not interrupt. steer merges into the running turn and may interrupt it: only use it deliberately."
				},
				confirm: {
					type: "boolean",
					description: "Must be true to actually deliver. false/omitted only returns the preview."
				}
			},
			required: [
				"target",
				"text",
				"confirm"
			]
		}),
		async execute(input, context) {
			const notes = [];
			const me = context?.sessionID;
			let kind = normalizeKind(input?.kind);
			let threadID = normalizeThreadID(input?.threadID);
			if (threadID && !isValidThreadID(threadID)) throw new Error(`threadID 格式不合法："${threadID}"（期望 t_<base36ts>_<rand>，或省略以自动生成）`);
			if (kind === "reply" && !threadID) {
				kind = "request";
				notes.push("kind=reply 缺少 threadID → 已按新请求处理（并自动生成 threadID）");
			}
			if (kind === "reply" && threadID) {
				const thread = await threads.read(threadID);
				if (!thread) {
					kind = "request";
					notes.push(`storage 里没有 thread ${threadID} → 已按新请求处理`);
				} else if (!me) notes.push("无会话上下文（无 sessionID）：未校验 reply 的参与者与对端。");
				else if (me !== thread.fromSession && me !== thread.toSession) throw new Error(`拒绝回执：当前会话 ${me} 不是 thread ${threadID} 的参与方（发起方 ${thread.fromSession ?? "?"}，对端 ${thread.toSession ?? "?"}）。未发送任何内容。`);
				else {
					const counterpart = thread.fromSession === me ? thread.toSession : thread.fromSession;
					const resolved = await resolveTarget(input?.target);
					if (counterpart && resolved.sessionID !== counterpart) throw new Error(`拒绝回执：thread ${threadID} 的对端是 ${counterpart}，与 target ${resolved.sessionID} 不一致。回执请用 collab_reply {threadID}（自动路由）。未发送任何内容。`);
					const { mode, forced } = resolveMode(input?.mode, context?.agent);
					return dispatch({
						context,
						input,
						kind,
						threadID,
						mode,
						forced,
						notes,
						target: resolved
					});
				}
			}
			if (!threadID) threadID = newThreadID();
			const { mode, forced } = resolveMode(input?.mode, context?.agent);
			const target = await resolveTarget(input?.target);
			return dispatch({
				context,
				input,
				kind,
				threadID,
				mode,
				forced,
				notes,
				target
			});
		}
	};
}
// src/tools/wait.ts
/**
* `collab_wait` — either wait for a thread reply (`threadID`) or for a target
* session's agent loop to go idle (`target`). Read-only: sends nothing and never
* interrupts anyone.
*/
function waitTool(kit) {
	const { deps, resolveTarget, waitForReply } = kit;
	const { ctx } = deps;
	return {
		name: "collab_wait",
		description: "Wait for a hand-off result. With threadID: wait until that thread has a kind=\"reply\" message from the other side *after its last request*, then return its full text (only a participant may wait; a malformed or unknown threadID fails immediately). Without threadID (target given): wait until the target session's agent loop becomes idle. Read-only — sends no message and never interrupts anyone.",
		input: jsonInput({
			properties: {
				threadID: {
					type: "string",
					description: "Thread to wait on (`t_…`): returns once a reply exists."
				},
				target: {
					type: "string",
					description: "Session id (`ses_…`) or an alias; used only for the idle mode."
				},
				timeoutMs: {
					type: "number",
					description: "Timeout in milliseconds (default 120000, min 1000, max 1800000)."
				}
			},
			required: []
		}),
		async execute(input, context) {
			const timeoutMs = clamp(input?.timeoutMs ?? 12e4, 1e3, 18e5);
			const threadID = normalizeThreadID(input?.threadID);
			if (input?.threadID && !threadID) throw new Error(`threadID 格式不合法："${String(input.threadID)}"（期望 t_<base36ts>_<rand>）`);
			if (threadID) {
				if (!isValidThreadID(threadID)) throw new Error(`threadID 格式不合法："${threadID}"（期望 t_<base36ts>_<rand>，从 collab_inbox 或请求正文里取）`);
				return waitForReply(threadID, timeoutMs, context);
			}
			if (!input?.target) throw new Error("collab_wait 需要 threadID（等回执）或 target（等空闲）之一");
			const { sessionID, alias, info } = await resolveTarget(input?.target);
			const label = `${sessionID}${alias ? ` (alias=${alias})` : ""} agent=${info?.agent ?? "?"}`;
			const started = Date.now();
			try {
				await withTimeout(ctx.session.wait({ sessionID }), timeoutMs, `等待超时：${label} 在 ${timeoutMs}ms 内没有进入空闲状态（可加大 timeoutMs 或先 collab_inbox）`);
			} catch (error) {
				throw new Error(`collab_wait 失败：${error?.message ?? error}`, { cause: error });
			}
			return { content: `目标已空闲：${label}（耗时 ${Date.now() - started}ms）` };
		}
	};
}
// src/tools/index.ts
/**
* The ten `collab_*` tools, in registration order (the order is part of the
* single-file behaviour: `/api/tool` and the harness both read it).
*/
function registerTools(kit) {
	return [
		listTool(kit),
		broadcastTool(kit),
		handoffTool(kit),
		acceptTool(kit),
		sendTool(kit),
		replyTool(kit),
		inboxTool(kit),
		waitTool(kit),
		grantTool(kit),
		promoteTool(kit)
	];
}
// src/index.ts
/**
* `@info-studio/collab` — the zero-dependency port of
* `.opencode/plugins/collab.js`: cross-session collaboration (threads / inbox)
* plus the cross-workspace hand-off chain (broadcast → score → atomic claim →
* receipt), exposed as the ten native `collab_*` tools and one `context` hook.
*
* The host contract is the plugin `ctx` (in-process capability), never an HTTP
* client: a plugin that reached the server through a port/token would break as
* soon as the instance moved. `@opencode/client` is imported for *types* only.
*/
const plugin = {
	id: "collab",
	async setup(host) {
		const ctx = host;
		const directory = ctx?.location?.directory;
		if (!directory || !ctx?.tool?.transform || !ctx?.session?.hook || !ctx?.storage) {
			log("setup() skipped: host has no location/tool/session/storage domain (incomplete setup context)");
			return;
		}
		const readConfig = createConfigReader(ctx.options);
		const inbox = createInboxStore(ctx);
		const threads = createThreadStore(ctx);
		const signal = createSignal();
		const chain = createHandoffChain(ctx, readConfig);
		const kit = createToolKit({
			ctx,
			readConfig,
			inbox,
			threads,
			signal,
			chain
		});
		const tools = registerTools(kit);
		const toolRegistration = await ctx.tool.transform((editor) => {
			for (const definition of tools) editor.add(definition);
		});
		const controller = new AbortController();
		(async () => {
			try {
				for await (const event of ctx.event.subscribe({
					types: EVENT_TYPES,
					signal: controller.signal
				})) {
					const inbound = extractInbound(event);
					if (!inbound) continue;
					await inbox.update(inbound.sessionID, (current) => {
						if (current.messages.some((message) => message.id === inbound.id || inbound.cid && message.cid === inbound.cid)) return current;
						return {
							...current,
							messages: [...current.messages, inbound]
						};
					});
					if (inbound.threadID) await threads.update(inbound.threadID, (current) => appendThreadMessage(current, {
						threadID: inbound.threadID,
						cid: inbound.cid,
						kind: inbound.kind,
						text: inbound.text,
						ts: inbound.ts,
						from: inbound.from,
						fromSession: inbound.fromSession,
						toSession: inbound.sessionID
					}));
					try {
						const closed = await chain.applyReceipt(inbound.text, inbound.fromSession);
						if (closed) log(`handoff ${closed.bid} → ${closed.state}`);
						const declined = await chain.applyDecline(inbound.text, inbound.fromSession);
						if (declined) log(`handoff ${declined.bid} declined → ${declined.state}${declined.asked?.sid ? `, asked ${declined.asked.sid}` : ""}`);
					} catch (error) {
						log("receipt handling failed:", error?.message ?? error);
					}
					if (inbound.kind === "reply") signal.notify();
				}
			} catch (error) {
				if (!controller.signal.aborted) log("event stream ended:", error?.message ?? error);
			}
		})();
		const hookRegistration = await ctx.session.hook("context", createContextHook(kit.deps));
		const initial = readConfig();
		log(`setup ok: directory=${directory} tools=${tools.length} aliases=${Object.keys(initial.aliases).length} protect=${initial.protect.length} autoDeliver=${initial.autoDeliver} maxInject=${initial.maxInject} readonly=${initial.readonlyAgents.join(",")} allowWrite=${initial.allowWrite}`);
		return async () => {
			controller.abort();
			await Promise.resolve(toolRegistration?.dispose?.()).catch(() => {});
			await Promise.resolve(hookRegistration?.dispose?.()).catch(() => {});
			log("cleanup: unsubscribed");
		};
	}
};
/**
* Pure helpers exported for the deterministic harness
* (`test/handoff-harness.mjs`): the ruleset merge (`R3`) and the fail-closed
* action whitelist (`R2`) are the two places where a mistake would silently
* widen permissions, so they are unit-testable without a host.
* No I/O, no `ctx` — the plugin's own entrypoint is `default` only.
*/
const __internals = {
	COLLAB_TOOL_ACTIONS,
	collabPermissionRules,
	normalizeRules,
	mergeRules,
	missingRules,
	assertCollabOnly
};
export { __internals, plugin as default };
