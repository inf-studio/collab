import {
  COLLAB_PREFIX_RE,
  inboxKey,
  INBOX_TEXT_LIMIT,
  MAX_STORED,
  STORAGE_DELIVERED,
  threadKey
} from '../constants.ts';
import { normalizeKind, normalizeStatus, normalizeThreadID, parseEnvelope } from '../ids.ts';
import type { CollabContext, InboxEvent, InboxMessage, InboxValue, ThreadMessage, ThreadRecord } from '../types.ts';
import { asObject, clamp, dedupe, truncateRaw } from '../util.ts';

export type Serializer = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

/** Serialise read-modify-write per key so concurrent events don't clobber. */
export function createSerializer(): Serializer {
  const locks = new Map<string, Promise<void>>();

  return function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    locks.set(
      key,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  };
}

export interface InboxStore {
  read(sessionID: string): Promise<InboxValue>;
  update(sessionID: string, mutate: (current: InboxValue) => InboxValue | undefined | void): Promise<InboxValue>;
}

export function createInboxStore(ctx: CollabContext): InboxStore {
  const serialize = createSerializer();

  async function read(sessionID: string): Promise<InboxValue> {
    const raw = asObject(await ctx.storage.get(inboxKey(sessionID)));
    const messages = (Array.isArray(raw.messages) ? raw.messages : []) as InboxMessage[];
    const cursor = clamp(raw.cursor ?? 0, 0, messages.length);
    const injected = Array.isArray(raw.injected)
      ? raw.injected.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    return { messages, cursor, injected, size: messages.length };
  }

  async function update(
    sessionID: string,
    mutate: (current: InboxValue) => InboxValue | undefined | void
  ): Promise<InboxValue> {
    return serialize(sessionID, async () => {
      const current = await read(sessionID);
      const next = mutate(current) ?? current;
      // Keep only the newest MAX_STORED summaries; shift the cursor with it.
      const overflow = Math.max(0, next.messages.length - MAX_STORED);
      const messages = overflow ? next.messages.slice(overflow) : next.messages;
      const cursor = Math.max(0, next.cursor - overflow);
      // `injected` only tracks ids that are still stored (trimmed entries are gone).
      const alive = new Set(messages.map(message => message.id));
      const injected = dedupe(next.injected ?? []).filter(id => alive.has(id));
      const value = { messages, cursor, injected, updated: Date.now() };
      await ctx.storage.set(inboxKey(sessionID), value);
      if (cursor > 0) {
        await ctx.storage.set(STORAGE_DELIVERED, {
          ...asObject(await ctx.storage.get(STORAGE_DELIVERED)),
          [sessionID]: cursor
        });
      }
      return { messages, cursor, injected, size: messages.length };
    });
  }

  return { read, update };
}

export interface ThreadStore {
  read(threadID: string | undefined): Promise<ThreadRecord | undefined>;
  update(
    threadID: string,
    mutate: (current: ThreadRecord | undefined) => ThreadRecord | undefined | void
  ): Promise<ThreadRecord | undefined>;
}

/**
 * Thread store — the source of truth for the request/reply state machine.
 * Both sides write here (same plugin storage), so a reply recorded by the
 * receiver is immediately readable by the requester's `collab_wait`.
 */
export function createThreadStore(ctx: CollabContext): ThreadStore {
  const serialize = createSerializer();

  async function read(threadID: string | undefined): Promise<ThreadRecord | undefined> {
    if (!threadID) return undefined;
    const raw = await ctx.storage.get(threadKey(threadID));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const value = asObject(raw);
    const msgs = (Array.isArray(value.msgs) ? value.msgs : []) as ThreadMessage[];
    return {
      threadID: String(value.threadID ?? threadID),
      fromSession: value.fromSession ? String(value.fromSession) : undefined,
      toSession: value.toSession ? String(value.toSession) : undefined,
      kind: normalizeKind(value.kind),
      status: normalizeStatus(value.status),
      msgs,
      createdAt: Number(value.createdAt) || 0,
      updatedAt: Number(value.updatedAt) || 0
    };
  }

  async function update(
    threadID: string,
    mutate: (current: ThreadRecord | undefined) => ThreadRecord | undefined | void
  ): Promise<ThreadRecord | undefined> {
    return serialize(threadID, async () => {
      const current = await read(threadID);
      const next = mutate(current) ?? current;
      await ctx.storage.set(threadKey(threadID), next);
      return next;
    });
  }

  return { read, update };
}

/**
 * Append one message to a thread. `kind: "reply"` moves the thread to
 * `answered`; `note` keeps the current status; a `request` always (re)opens it —
 * a reused thread must not stay `answered`, otherwise the receiver's hook stops
 * reminding and the requester's `collab_wait` returns the previous round's reply.
 */
export function appendThreadMessage(current: ThreadRecord | undefined, message: ThreadMessage): ThreadRecord {
  const now = message.ts ?? Date.now();
  const base: ThreadRecord = current ?? {
    threadID: String(message.threadID),
    fromSession: message.fromSession,
    toSession: message.toSession,
    kind: String(message.kind),
    status: 'open',
    msgs: [],
    createdAt: now,
    updatedAt: now
  };
  // The sender records the message, and the receiver's inbox event records it
  // again; the correlation id makes that second write a no-op.
  if (message.cid && (base.msgs ?? []).some(entry => entry.cid === message.cid)) return base;
  const status = message.kind === 'reply' ? 'answered' : message.kind === 'note' ? base.status : 'open';
  return {
    ...base,
    fromSession: base.fromSession ?? message.fromSession,
    toSession: base.toSession ?? message.toSession,
    status,
    msgs: [...base.msgs, message].slice(-MAX_STORED),
    updatedAt: now
  };
}

/** One recorded inbound `session.inbox.enqueued` event, or undefined. */
export function extractInbound(event: InboxEvent | undefined): InboxMessage | undefined {
  const data = asObject(event?.data);
  const sessionID = data.sessionID;
  const item = asObject(data.item);
  if (!sessionID || item.type !== 'user') return undefined;

  const payload = asObject(item.payload);
  const text = String(payload.text ?? '');
  const meta = asObject(asObject(payload.metadata).collab);
  const parsed = parseEnvelope(text);

  // Only cross-session collab messages are recorded: either tagged by our own
  // sender's metadata, or carrying the CLI's `[collab:…]` envelope.
  if (!parsed && !meta.from) return undefined;

  const id = String(data.inboxID ?? item.id ?? `${sessionID}:${Date.now()}`);
  const body = parsed ? parsed.body : text.replace(COLLAB_PREFIX_RE, '');
  // R7 (0.1.4): keep the difference between "no kind at all" (legacy CLI text,
  // may be judged by its `[handoff]` body) and an explicit `note` / `request`
  // (a deliberate non-receipt, never judged by the body).
  const declaredKind = String(meta.kind ?? parsed?.kind ?? '').trim();
  return {
    // `id` stays the inbox id (de-dup key for repeated events); `cid` is our own
    // stable per-delivery correlation id, echoed back through message metadata.
    id,
    cid: String(meta.cid ?? id),
    sessionID: String(sessionID),
    fromSession: String(meta.fromSessionID ?? parsed?.from ?? 'unknown'),
    from: String(meta.from ?? parsed?.from ?? 'unknown'),
    kind: normalizeKind(declaredKind),
    kindExplicit: Boolean(declaredKind),
    threadID: normalizeThreadID(meta.threadID) ?? normalizeThreadID(parsed?.threadID),
    text: truncateRaw(body, INBOX_TEXT_LIMIT),
    ts: Date.now(),
    delivered: false
  };
}
