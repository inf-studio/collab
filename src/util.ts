import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { errText, log } from './log.ts';
import type { JsonObject, SessionInfoLike } from './types.ts';

/** `statSync().mtimeMs`, or 0 when the file does not exist (config cache stamp). */
export function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function readJsonFile(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    log(`ignoring unreadable ${path}: ${errText(error)}`);
    return undefined;
  }
}

export function clamp(value: unknown, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function truncate(text: unknown, max = 200): string {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Like `truncate`, but keeps line breaks — used where the full body matters. */
export function truncateRaw(text: unknown, max = 4000): string {
  const value = String(text ?? '').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** `{}` for anything that is not a plain object (arrays included). */
export function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

export function dedupe(list: unknown[]): string[] {
  return [...new Set(list.filter((item): item is string => typeof item === 'string' && Boolean(item)))];
}

export function shortID(sessionID: unknown): string {
  const value = String(sessionID ?? '');
  return value.startsWith('ses_') ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

export function fmtTime(ms: unknown): string {
  if (!ms) return '--:--:--';
  const d = new Date(Number(ms));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** `busy` / `idle` / `archived` of a session, as the tools print it. */
export function sessionState(info: SessionInfoLike | undefined): string {
  const time = asObject(info?.time);
  if (time.archived) return 'archived';
  if (time.busy && (!time.idle || time.busy > time.idle)) return 'busy';
  return 'idle';
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Four base-36 chars; unique enough inside a `t_`/`c_`/`k_` id, no crypto needed. */
export function randToken(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

export function hash16(text: unknown): string {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}
