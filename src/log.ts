/**
 * One-line setup/runtime visibility. A plugin that fails to load is silently
 * absent and a subscribe loop that dies is silent too, so every diagnostic is
 * logged here — once per occurrence, never per event.
 */
export function log(...args: unknown[]): void {
  console.error('[collab]', ...args);
}

interface ErrLike {
  message?: unknown;
  code?: unknown;
}

/** `error?.message ?? error` — the exact text the single-file plugin printed. */
export function errText(error: unknown): string {
  return String((error as ErrLike)?.message ?? error);
}

/** `error?.code` for `open(…, "wx")` / fs failures. */
export function errCode(error: unknown): unknown {
  return (error as ErrLike)?.code;
}
