/**
 * `3.1h` / `12m` / `2.4d` — the compact age the injection and the board print.
 *
 * It lives in a module of its own because `core/contract.ts` is **server-only**
 * (it reads `node:fs`), while the board's contract line needs the same
 * formatting inside the GUI / TUI bundles. `contract.ts` re-exports this
 * function, so there is still exactly one implementation.
 */
export function formatAge(ms: number): string {
  const value = Math.max(0, Number(ms) || 0);
  const minutes = value / 60_000;
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
  const days = hours / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}d`;
}
