/**
 * 0.9.0 (`11-20-collab-store`, R1): the **message envelope** — the one shape that
 * is written to `collab-messages.jsonl` (append-only) and projected into
 * `collab.db`.
 *
 * Why a separate module: the same value must be (a) written as a ≤1MB JSONL
 * line, (b) split into consecutive lines when the body is longer, (c) parsed
 * back tolerantly by a reader that may meet a half-written line after a crash,
 * and (d) turned into a `messages` row. Keeping the four together means the
 * line format has exactly one definition — the mutation the test demands
 * ("drop `sent_at`") has to fail because the *source* is the envelope, not a
 * second copy of it.
 *
 * Degradation is deliberately unheroic: a line that is not valid JSON, carries
 * an unknown `v`, lacks an `id`, or fails its own `sha256` is **skipped and
 * counted**, never thrown — a corrupt history must not take the plugin down
 * (design §3/§4).
 */
import { createHash } from 'node:crypto';
import { MESSAGE_PART_BYTES } from '../constants.ts';
import type { EnvelopeGrade, EnvelopeItem, EnvelopeKind, MessageEnvelope } from '../types.ts';

const KINDS: EnvelopeKind[] = ['request', 'reply', 'note', 'notify', 'ack'];
const GRADES: EnvelopeGrade[] = ['measured', 'inferred', 'relayed', 'unknown'];
export const ENVELOPE_VERSION = 1;

export function sha256(text: string): string {
  return createHash('sha256').update(String(text)).digest('hex');
}

/** `msg_<base36 ts>_<rand>` — deterministic enough, and no crypto needed. */
export function newMessageID(now = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `msg_${now.toString(36)}_${rand}`;
}

/**
 * Split a body into chunks of at most `maxBytes` **UTF-8** bytes without cutting
 * a multi-byte sequence (a cut inside `你` would turn the archive into `�`).
 * A body that fits is returned as one chunk — the common case does no work.
 */
export function splitBody(body: string, maxBytes = MESSAGE_PART_BYTES): string[] {
  const text = String(body ?? '');
  if (!text) return [''];
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < buffer.length) {
    let end = Math.min(start + maxBytes, buffer.length);
    // Back off to a leading byte (0b10xxxxxx marks a continuation byte), so the
    // chunk never starts mid-sequence and the next one never ends mid-sequence.
    while (end < buffer.length && end > start && (buffer[end] & 0xc0) === 0x80) end -= 1;
    if (end === start) end = Math.min(start + maxBytes, buffer.length);
    chunks.push(buffer.subarray(start, end).toString('utf8'));
    start = end;
  }
  return chunks;
}

/** Build one envelope, filling the fields the transport layer does not know yet. */
export function makeEnvelope(input: {
  id?: string;
  threadId?: string;
  from: string;
  to: string;
  sentAt?: number;
  kind: string;
  body: string;
  basedOn?: MessageEnvelope['basedOn'];
  grade?: EnvelopeGrade;
  factIds?: string[];
  deltaOnly?: boolean;
  /** 0.9.6: the items a 2-minute batch merged into this one message. */
  items?: EnvelopeItem[];
  /** 0.10.0: the day's `kept` counter value this delivery consumed (count marker). */
  rawSeq?: number;
}): MessageEnvelope {
  const sentAt = Number(input.sentAt) || Date.now();
  const kind = (KINDS as string[]).includes(input.kind) ? (input.kind as EnvelopeKind) : 'note';
  const grade = input.grade && GRADES.includes(input.grade) ? input.grade : 'unknown';
  const threadId = String(input.threadId ?? '').trim();
  const rawSeq = Number(input.rawSeq);
  return {
    v: ENVELOPE_VERSION,
    id: String(input.id ?? '').trim() || newMessageID(sentAt),
    ...(threadId ? { threadId } : {}),
    from: String(input.from ?? ''),
    to: String(input.to ?? ''),
    sentAt,
    kind,
    body: String(input.body ?? ''),
    basedOn: input.basedOn ?? { facts: 0 },
    grade,
    ...(input.factIds?.length ? { factIds: [...input.factIds] } : {}),
    ...(input.deltaOnly ? { deltaOnly: true } : {}),
    ...(input.items?.length ? { items: input.items.map(normalizeItem) } : {}),
    ...(Number.isFinite(rawSeq) && rawSeq > 0 ? { rawSeq } : {})
  };
}

/** One batch item, defensively normalised (a foreign `items[]` must not leak). */
function normalizeItem(raw: EnvelopeItem): EnvelopeItem {
  const threadId = String(raw?.threadId ?? '').trim();
  return {
    id: String(raw?.id ?? ''),
    ...(threadId ? { threadId } : {}),
    kind: String(raw?.kind ?? 'note'),
    body: String(raw?.body ?? ''),
    sentAt: Number(raw?.sentAt) || 0,
    ...(Array.isArray(raw?.factIds) && raw.factIds.length ? { factIds: raw.factIds.map(String) } : {})
  };
}

/** Keep only items that can be ordered and traced (an id and a real `sentAt`). */
function normalizeItems(raw: unknown): EnvelopeItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(item => normalizeItem(item as EnvelopeItem))
    .filter(item => Boolean(item.id) && item.sentAt > 0);
}

/**
 * Serialize one envelope to its JSONL lines: one line when the body fits, one
 * line per chunk otherwise. Every line carries `sha256` of **its own** body
 * chunk, so a truncated line is detectable on read (`part` gives the order).
 *
 * S5 (review): the 1MB budget applies to the **encoded line**, not the raw body.
 * `JSON.stringify` doubles every `"` and `\\`, turns a newline into `\\n`, and a
 * CJK character costs 3 UTF-8 bytes — a 700k-quote body used to produce a 1.4MB
 * line. The split therefore binary-searches the largest prefix whose encoded
 * line still fits, on character boundaries (a surrogate pair is never split).
 */
export function envelopeLines(envelope: MessageEnvelope): string[] {
  const lineFor = (chunk: string, part?: { i: number; n: number }): string =>
    JSON.stringify({
      ...envelope,
      body: chunk,
      sha256: sha256(chunk),
      ...(part ? { part } : {})
    });
  /** Worst case for the metadata of a split line (n is only known afterwards). */
  const worstPart = { i: 9999, n: 9999 };
  const encodedBytes = (chunk: string): number =>
    Buffer.byteLength(lineFor(chunk, worstPart), 'utf8');

  if (encodedBytes(envelope.body) <= MESSAGE_PART_BYTES) {
    return [lineFor(envelope.body)];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < envelope.body.length) {
    let low = start + 1;
    let high = envelope.body.length;
    let best = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (encodedBytes(envelope.body.slice(start, mid)) <= MESSAGE_PART_BYTES) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (best <= start) best = Math.min(envelope.body.length, start + 1);
    // Never cut between a high and a low surrogate (an emoji must not become 2×�).
    const code = envelope.body.charCodeAt(best - 1);
    if (best < envelope.body.length && code >= 0xd800 && code <= 0xdbff) best -= 1;
    if (best <= start) best = Math.min(envelope.body.length, start + 1);
    chunks.push(envelope.body.slice(start, best));
    start = best;
  }
  return chunks.map((chunk, index) => lineFor(chunk, { i: index, n: chunks.length }));
}

function normalizeEnvelope(raw: unknown): MessageEnvelope | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, any>;
  if (Number(value.v) !== ENVELOPE_VERSION) return undefined;
  const id = String(value.id ?? '').trim();
  if (!id) return undefined;
  if (typeof value.body !== 'string') return undefined;
  const sentAt = Number(value.sentAt);
  if (!Number.isFinite(sentAt) || sentAt <= 0) return undefined;
  // A hash that does not match its own line means the line was edited / torn:
  // drop it (the caller counts a warning) instead of resurrecting half a body.
  if (typeof value.sha256 === 'string' && value.sha256 && value.sha256 !== sha256(value.body)) return undefined;
  const partRaw = value.part;
  const part =
    partRaw && typeof partRaw === 'object'
      ? { i: Number(partRaw.i) || 0, n: Number(partRaw.n) || 0 }
      : undefined;
  if (part && (!Number.isFinite(part.i) || !Number.isFinite(part.n) || part.n < 1 || part.i < 0)) return undefined;
  const kind = (KINDS as string[]).includes(value.kind) ? (value.kind as EnvelopeKind) : 'note';
  const grade = (GRADES as string[]).includes(value.grade) ? (value.grade as EnvelopeGrade) : 'unknown';
  // 0.10.0 (R1): the count marker survives a read, and **stays absent** when the
  // line has none — a legacy row must never be back-filled with a made-up `0`.
  const rawSeq = Number(value.rawSeq);
  const basedOn =
    value.basedOn && typeof value.basedOn === 'object'
      ? {
          ...(value.basedOn.repo && typeof value.basedOn.repo === 'object' ? { repo: value.basedOn.repo } : {}),
          ...(value.basedOn.env && typeof value.basedOn.env === 'object' ? { env: value.basedOn.env } : {}),
          facts: Number(value.basedOn.facts) || 0
        }
      : { facts: 0 };
  const envelope: MessageEnvelope = {
    v: ENVELOPE_VERSION,
    id,
    ...(value.threadId ? { threadId: String(value.threadId) } : {}),
    from: String(value.from ?? ''),
    to: String(value.to ?? ''),
    sentAt,
    kind,
    body: value.body,
    basedOn,
    grade,
    ...(Array.isArray(value.factIds) ? { factIds: value.factIds.map(String) } : {}),
    ...(value.deltaOnly === true ? { deltaOnly: true } : {}),
    ...(normalizeItems(value.items).length ? { items: normalizeItems(value.items) } : {}),
    ...(Number.isFinite(rawSeq) && rawSeq > 0 ? { rawSeq } : {}),
    ...(typeof value.sha256 === 'string' && value.sha256 ? { sha256: value.sha256 } : {}),
    ...(part ? { part } : {})
  };
  return envelope;
}

/** One JSONL line → envelope, or `undefined` when the line is corrupt. Never throws. */
export function parseEnvelopeLine(line: string): MessageEnvelope | undefined {
  const text = String(line ?? '').trim();
  if (!text) return undefined;
  try {
    return normalizeEnvelope(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Merge the parts of one message (same `id`) back into the whole envelope.
 * Parts are ordered by `part.i`; the first part's metadata wins. A repeated
 * `(id, part)` pair — the same delivery written twice — keeps the **last**
 * copy, which is what an append-only log means by "the newest line wins".
 */
export function mergeEnvelopeParts(parts: MessageEnvelope[]): MessageEnvelope | undefined {
  if (!parts.length) return undefined;
  const byIndex = new Map<number, MessageEnvelope>();
  for (const part of parts) {
    const index = part.part ? part.part.i : 0;
    byIndex.set(index, part);
  }
  const ordered = [...byIndex.entries()].sort((left, right) => left[0] - right[0]).map(([, part]) => part);
  const head = ordered[0];
  const body = ordered.map(part => part.body).join('');
  const { part: _part, sha256: _sha, ...rest } = head;
  return { ...rest, body };
}

/**
 * What the `messages` row keeps in its `envelope` column: the head, **no body
 * copy**. 0.9.6: a batched envelope carries `items[]`, whose bodies are already
 * part of the rendered `body` — keeping them twice would double the projection
 * for the exact messages this version exists to shrink. The item *identity*
 * (id / thread / kind / sentAt / factIds) is kept, which is what queries need.
 */
export function envelopeHead(envelope: MessageEnvelope): string {
  const items = envelope.items?.map(item => ({ ...item, body: '' }));
  return JSON.stringify({
    ...envelope,
    body: '',
    ...(items?.length ? { items } : {}),
    sha256: sha256(envelope.body)
  });
}
