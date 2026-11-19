import { COLLAB_ENVELOPE_RE, KINDS, MAX_LINEAGE_DEPTH, STATUSES } from './constants.ts';
import { randToken } from './util.ts';

/** `t_<base36ts>_<rand4>` — unique enough across sessions; no distributed ordering. */
export function newThreadID(): string {
  return `t_${Date.now().toString(36)}_${randToken()}`;
}

/** Per-delivery correlation id; echoed through message metadata for de-duplication. */
export function newCorrelationID(): string {
  return `c_${Date.now().toString(36)}_${randToken()}`;
}

export function isValidThreadID(value: unknown): boolean {
  return typeof value === 'string' && /^t_[0-9a-z]+_?[0-9a-z]*$/.test(value);
}

/**
 * `undefined`/`null`/`"undefined"` all mean "no thread here" — legacy CLI text
 * and old stored records can leak the literal string, which used to be rendered
 * as `collab_reply {threadID:"undefined"}` in the injection hint.
 */
export function normalizeThreadID(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text && text !== 'undefined' && text !== 'null' ? text : undefined;
}

export function normalizeKind(value: unknown, fallback = 'request'): string {
  const kind = String(value ?? '').trim();
  return KINDS.includes(kind) ? kind : fallback;
}

export function normalizeStatus(value: unknown): string {
  const status = String(value ?? '').trim();
  return STATUSES.includes(status) ? status : 'open';
}

/** Collapse whitespace so text-derived de-duplication compares the same body. */
export function normalizeText(text: unknown): string {
  return String(text ?? '')
    .replace(COLLAB_ENVELOPE_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function envelope({
  from,
  name,
  kind,
  threadID,
  body
}: {
  from: string;
  /**
   * 0.8.0 (`sender-name`): the sender's session title, rendered **in front** of
   * the machine-read head (`[<title>][collab:<from>][<kind>:<threadID>]`), so a
   * human reading the injected turn does not have to reverse-lookup a truncated
   * id. Empty / missing → the header is byte for byte the pre-0.8.0 one.
   */
  name?: string;
  kind: string;
  threadID?: string;
  body: string;
}): string {
  const tag = threadID ? `[${kind}:${threadID}]` : `[${kind}]`;
  const label = String(name ?? '').trim();
  return `${label ? `[${label}]` : ''}[collab:${from}]${tag} ${body}`;
}

export interface ParsedEnvelope {
  /** 0.8.0 (`sender-name`): the optional sender-title segment in front. */
  name?: string;
  from?: string;
  kind?: string;
  threadID?: string;
  body: string;
}

export function parseEnvelope(text: unknown): ParsedEnvelope | undefined {
  const value = String(text ?? '');
  const match = COLLAB_ENVELOPE_RE.exec(value);
  if (!match) return undefined;
  const kind = match[3] && KINDS.includes(match[3]) ? match[3] : undefined;
  return {
    name: match[1] || undefined,
    from: match[2] || undefined,
    kind,
    threadID: match[4] || undefined,
    body: value.slice(match[0].length)
  };
}

export interface WakeSignal {
  notify(): void;
  wait(timeoutMs: number): Promise<void>;
}

/**
 * Wake-up signal shared by `collab_wait {threadID}` and the inbox event loop, so
 * a reply is observed immediately instead of on the next poll tick.
 */
export function createSignal(): WakeSignal {
  const waiters = new Set<() => void>();
  return {
    notify() {
      // Each waiter removes itself on resolve; Set iteration tolerates that.
      for (const done of waiters) done();
    },
    wait(timeoutMs) {
      return new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined;
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

/** Re-exported so the lineage guard and the docs quote one number. */
export { MAX_LINEAGE_DEPTH };
