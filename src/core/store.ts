/**
 * 0.9.0 (`11-20-collab-store`, R1/R3): `collab-messages.jsonl` — the
 * **append-only** message log and the only place a message body is kept.
 *
 * `collab.db` is a projection: it can be deleted and rebuilt from this file at
 * any time. Two consequences shape this module:
 *
 *   - writes are one `appendFileSync` per message (no read-modify-write, no
 *     temp file) — a crash can at worst leave one torn line, which the reader
 *     skips and counts (design §3);
 *   - reads tolerate everything: invalid JSON, a missing `id`, a failed
 *     `sha256`, an unknown version. They never throw, so a corrupt history can
 *     never take a tool down.
 *
 * Rotation (design §3): the active file is `collab-messages.jsonl`; when it
 * passes `MESSAGES_ROTATE_BYTES` (256MB) it is renamed to the *next* numbered
 * sibling (`-1`, `-2`, … ascending in age). A read concatenates the numbered
 * files oldest first, then the active one — so message order is preserved
 * without ever replaying a 256MB file into memory.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MESSAGES_FILE, MESSAGES_ROTATE_BYTES } from '../constants.ts';
import { errText, log } from '../log.ts';
import type { MessageEnvelope } from '../types.ts';
import { envelopeLines, mergeEnvelopeParts, parseEnvelopeLine } from './envelope.ts';

export interface MessageStoreOptions {
  /** Override the active log path (harness / sandbox runs). */
  file?: string;
}

export interface ReadMessagesResult {
  /** Whole envelopes, oldest first; parts of one id already merged. */
  messages: MessageEnvelope[];
  /** Lines that could not be parsed (invalid JSON / torn / bad hash). */
  warnCount: number;
  /** Lines read (valid + invalid), for the `rebuild` receipt. */
  lines: number;
  /** The files actually read, oldest first. */
  files: string[];
}

/** `collab-messages-<n>.jsonl` siblings of `active`, ascending (oldest first). */
function rotatedFiles(active: string): { path: string; index: number }[] {
  const directory = dirname(active);
  const base = active.slice(directory.length + 1).replace(/\.jsonl$/, '');
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const out: { path: string; index: number }[] = [];
  for (const name of names) {
    const match = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.jsonl$`).exec(name);
    if (!match) continue;
    out.push({ path: join(directory, name), index: Number(match[1]) });
  }
  return out.sort((left, right) => left.index - right.index);
}

/** Every file of the log, oldest first (rotated `-1`, `-2`, … then the active one). */
export function messageFiles(options: MessageStoreOptions = {}): string[] {
  const active = String(options.file ?? MESSAGES_FILE);
  return [...rotatedFiles(active).map(entry => entry.path), active];
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Rotate the active file when it outgrew its budget. Returns the file the next
 * append must go to. The numbered name is `max(index) + 1`, so the sequence is
 * "oldest `-1` → newest `-N` → active" without renaming the whole chain.
 */
function activeFile(active: string): string {
  if (sizeOf(active) < MESSAGES_ROTATE_BYTES) return active;
  const next = (rotatedFiles(active).at(-1)?.index ?? 0) + 1;
  const target = active.replace(/\.jsonl$/, `-${next}.jsonl`);
  try {
    mkdirSync(dirname(active), { recursive: true });
    renameSync(active, target);
    log(`messages log rotated: ${target}`);
    return active;
  } catch (error) {
    // A failed rotation must not lose the message: keep appending to the old
    // file (it is still the active one) and say so once.
    log(`messages log rotation failed (${errText(error)}); appending to ${active}`);
    return active;
  }
}

/**
 * Append one message. **Throws** on an I/O failure — the caller decides what a
 * failed *truth* write means (design §5: the JSONL file is the source of
 * truth, the index is not). Multiple parts of one body are written
 * consecutively, one line each, with no interleaving.
 */
export function appendMessage(
  envelope: MessageEnvelope,
  options: MessageStoreOptions = {}
): { file: string; lines: number; bytes: number } {
  const active = String(options.file ?? MESSAGES_FILE);
  const file = activeFile(active);
  const payload = `${envelopeLines(envelope).join('\n')}\n`;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, payload, 'utf8');
  return { file, lines: payload.split('\n').length - 1, bytes: Buffer.byteLength(payload) };
}

/**
 * Read the whole log (all rotated files, then the active one), merging the
 * parts of a split body. Never throws: an unreadable file is a warning, not an
 * error, and a line that fails to parse is skipped + counted.
 */
export function readMessages(options: MessageStoreOptions = {}): ReadMessagesResult {
  const files = messageFiles(options);
  const parts = new Map<string, MessageEnvelope[]>();
  const order: string[] = [];
  let warnCount = 0;
  let lines = 0;

  for (const file of files) {
    if (!existsSync(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      log(`unreadable messages file ${file}: ${errText(error)}`);
      warnCount += 1;
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      lines += 1;
      const envelope = parseEnvelopeLine(line);
      if (!envelope) {
        warnCount += 1;
        continue;
      }
      if (!parts.has(envelope.id)) {
        parts.set(envelope.id, []);
        order.push(envelope.id);
      }
      parts.get(envelope.id)!.push(envelope);
    }
  }

  const messages: MessageEnvelope[] = [];
  for (const id of order) {
    const merged = mergeEnvelopeParts(parts.get(id) ?? []);
    if (merged) messages.push(merged);
  }
  messages.sort((left, right) => left.sentAt - right.sentAt || left.id.localeCompare(right.id));
  return { messages, warnCount, lines, files: files.filter(file => existsSync(file)) };
}

/** The active log path — the harness asserts the one file the writer touches. */
export function messagesFile(options: MessageStoreOptions = {}): string {
  return String(options.file ?? MESSAGES_FILE);
}
