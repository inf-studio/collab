import { normalizeKind, normalizeText, normalizeThreadID, parseEnvelope } from '../ids.ts';
import type { InboxMessage, JsonObject, SessionMessageLike } from '../types.ts';
import { asObject } from '../util.ts';

/** De-dup key used when message metadata is unavailable. */
export function messageKey(message: JsonObject | InboxMessage | undefined): string {
  return [normalizeKind(message?.kind), normalizeThreadID(message?.threadID) ?? '', normalizeText(message?.text)].join(
    '|'
  );
}

export function messageIDs(message: JsonObject | InboxMessage | undefined): string[] {
  return [message?.cid, message?.id].filter((value): value is string => typeof value === 'string' && Boolean(value));
}

export interface RequestKeys {
  cids: Set<string>;
  keys: Set<string>;
  texts: Set<string>;
}

/**
 * Messages already present in *this* request. `collab_send` admits the body as
 * a normal user turn, so it shows up in `event.messages`; injecting the same
 * text again from the inbox store is what made the previous version redundant.
 * Metadata is exposed read-only on context-hook messages, with an envelope-text
 * fallback when it is missing.
 */
export function collectRequestKeys(event: { messages?: unknown[] } | undefined): RequestKeys {
  const cids = new Set<string>();
  const keys = new Set<string>();
  const texts = new Set<string>();
  const messages = (Array.isArray(event?.messages) ? event?.messages : []) as SessionMessageLike[];

  for (const message of messages) {
    const meta = asObject(asObject(message?.metadata).collab);
    if (meta.cid) cids.add(String(meta.cid));
    if (meta.kind || meta.threadID) keys.add(messageKey(meta));

    const parts = Array.isArray(message?.parts)
      ? message.parts
      : Array.isArray(message?.content)
        ? message.content
        : [];
    for (const part of parts) {
      const block = asObject(part);
      const text = typeof block.text === 'string' ? block.text : typeof block.content === 'string' ? block.content : '';
      if (!text) continue;
      const parsed = parseEnvelope(text);
      if (!parsed) continue;
      keys.add([normalizeKind(parsed.kind), String(parsed.threadID ?? ''), normalizeText(parsed.body)].join('|'));
      texts.add(normalizeText(parsed.body));
    }
  }

  return { cids, keys, texts };
}

/** Cursor = leading run of messages already accounted for (injected or shown). */
export function cursorFrom(messages: InboxMessage[], injected: string[]): number {
  const seen = new Set(injected);
  let index = 0;
  while (index < messages.length && messageIDs(messages[index]).some(id => seen.has(id))) index++;
  return index;
}
