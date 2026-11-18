/**
 * R5 (0.1.6): post-closure appends — the **pull** half of hand-off feedback.
 *
 * A closed hand-off is not a licence to push into the requester's input stream:
 * `protect` exists precisely to stop that, and a "24h follow-up window" would
 * have been a standing hole in it. So a conclusion appended after `done` is a
 * pull, in two halves:
 *
 *   1. the claimant writes the conclusion into the **proposal file** (single
 *      source of truth), then calls `collab_followup { bid, confirm:true }`;
 *   2. the record stores only *structure* — `{ bid, issuePath, at, by }` — and
 *      the requester sees one read-only line in its own `context` injection:
 *      "提案 <path> 有追加结论（<ts>），请读取文件".
 *
 * What is deliberately **not** here: the claimant's text. Free text on this
 * path would let any session write arbitrary words into a protected session's
 * context; the file is read by the requester itself, under its own permissions.
 * The rendered path is therefore sanitised (no newlines / control characters,
 * ≤200 chars) and re-validated on every render: it must resolve — via
 * `realpath` — inside `record.workspace`, under `docs/issues/`, as a regular
 * `.md` file. `..`, absolute paths and symlinks are refused; a record whose
 * path cannot be validated renders **nothing** (no fallback concatenation).
 */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BroadcastRecord, CollabContext } from '../types.ts';
import { asObject, dedupe, fmtTime } from '../util.ts';

/** One append: structure only. The conclusion itself lives in the proposal file. */
export interface FollowUpRecord {
  bid: string;
  issuePath: string;
  at: number;
  by: string;
}

/** R5: at most this many appends per bid (a conclusion, not a chat log). */
export const FOLLOWUP_LIMIT = 3;
/** A rendered path never exceeds this (control characters are stripped first). */
export const FOLLOWUP_PATH_LIMIT = 200;
/** Per-session seen keys kept in storage (`<bid>:<at>`). */
const FOLLOWUP_SEEN_LIMIT = 200;

/** Strip control characters / newlines, collapse spaces, cap the length. */
export function sanitizePathText(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FOLLOWUP_PATH_LIMIT);
}

export type IssuePathCheck =
  | { ok: true; issuePath: string; abs: string }
  | { ok: false; reason: string };

/**
 * Same write boundary as `collab_broadcast` (`resolveBroadcastTargets`), in a
 * non-throwing form: relative, no `..`, under `<workspace>/docs/issues/`, an
 * existing regular `.md` whose `realpath` stays inside that directory and is
 * not a symlink.
 */
export function validateIssuePath(workspace: unknown, raw: unknown): IssuePathCheck {
  const root = String(workspace ?? '').trim();
  if (!root) return { ok: false, reason: '记录没有 workspace，无法校验提案路径' };
  if (!isAbsolute(root)) return { ok: false, reason: `workspace 不是绝对路径：${root}` };
  const issuePath = sanitizePathText(raw);
  if (!issuePath) return { ok: false, reason: 'issuePath 为空' };
  if (isAbsolute(issuePath)) return { ok: false, reason: `issuePath 不能是绝对路径：${issuePath}` };
  if (issuePath.split('/').some(part => part === '..' || part === '.')) {
    return { ok: false, reason: `issuePath 不能包含 .. / .：${issuePath}` };
  }
  const clean = relative(root, resolve(root, issuePath)).split(sep).join('/');
  if (!/^docs\/issues\/[^/]+\.md$/i.test(clean)) {
    return { ok: false, reason: `issuePath 必须是 docs/issues/<name>.md：${clean}` };
  }
  let realRoot: string;
  try {
    if (!statSync(root).isDirectory()) return { ok: false, reason: `workspace 不是目录：${root}` };
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, reason: `workspace 不存在或不可读：${root}` };
  }
  const issuesRoot = join(realRoot, 'docs', 'issues') + sep;
  const abs = resolve(realRoot, clean);
  if (!abs.startsWith(issuesRoot)) {
    return { ok: false, reason: `issuePath 不在 ${root}/docs/issues/ 下：${clean}` };
  }
  let stat;
  try {
    stat = lstatSync(abs);
  } catch {
    return { ok: false, reason: `提案文件不存在：${clean}` };
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: `提案 ${clean} 是软链（不允许绕过 docs/issues/ 边界）` };
  if (!stat.isFile()) return { ok: false, reason: `提案路径不是文件：${clean}` };
  let realAbs: string;
  try {
    realAbs = realpathSync(abs);
  } catch {
    return { ok: false, reason: `提案文件不可读：${clean}` };
  }
  if (!realAbs.startsWith(issuesRoot)) {
    return { ok: false, reason: `提案真实路径不在 docs/issues/ 下：${realAbs}` };
  }
  return { ok: true, issuePath: clean, abs };
}

/**
 * The structured appends of a record. Anything without a usable `at` is
 * dropped; the path is sanitised here and validated again at render time.
 */
export function followUpsOf(record: BroadcastRecord | undefined): FollowUpRecord[] {
  const list = Array.isArray(asObject(record).followUps) ? (asObject(record).followUps as unknown[]) : [];
  const out: FollowUpRecord[] = [];
  for (const entry of list) {
    const value = asObject(entry);
    const at = Number(value.at) || 0;
    if (!at) continue;
    out.push({
      bid: String(value.bid ?? asObject(record).bid ?? ''),
      issuePath: sanitizePathText(value.issuePath),
      at,
      by: String(value.by ?? '')
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** R5: the newest append's stamp (`0` when there is none). */
export function lastFollowUpAt(record: BroadcastRecord | undefined): number {
  return followUpsOf(record).reduce((latest, entry) => Math.max(latest, entry.at), 0);
}

/**
 * R5: append one structured entry. The record's `state`, `receipt` and `claim`
 * are never touched — the hand-off stays closed, it just gained a footnote.
 * Callers validate the path and the caller identity first.
 */
export function appendFollowUp(
  record: BroadcastRecord,
  entry: { bid?: string; issuePath: string; at?: number; by: string }
): BroadcastRecord {
  const existing = followUpsOf(record);
  const next: FollowUpRecord = {
    bid: String(record.bid),
    issuePath: sanitizePathText(entry.issuePath || record.issuePath),
    at: Number(entry.at) || Date.now(),
    by: String(entry.by ?? '')
  };
  return {
    ...record,
    // Keep the stored array structured even if an older file carried free text.
    followUps: [...existing, next].slice(-FOLLOWUP_LIMIT)
  };
}

/** `(<sid>, <bid>, <at>)` — the dedupe key of one rendered hint. */
export function followUpSeenKey(sessionID: string, bid: string, at: number): string {
  return `${sessionID}:${bid}:${at}`;
}

function seenStorageKey(sessionID: string): string {
  return `collab/followup-seen/${sessionID}`;
}

/** Per-session memory of already-rendered hints (survives restarts). */
export async function readFollowUpSeen(ctx: CollabContext, sessionID: string): Promise<string[]> {
  const raw = asObject(await ctx.storage.get(seenStorageKey(sessionID)));
  return Array.isArray(raw.keys) ? raw.keys.filter((key: unknown): key is string => typeof key === 'string') : [];
}

export async function markFollowUpSeen(ctx: CollabContext, sessionID: string, keys: string[]): Promise<void> {
  if (!keys.length) return;
  const current = await readFollowUpSeen(ctx, sessionID);
  const next = dedupe([...current, ...keys]).slice(-FOLLOWUP_SEEN_LIMIT);
  await ctx.storage.set(seenStorageKey(sessionID), { keys: next });
}

/** The one line a requester may see — `bid`, proposal path and the append time. */
export function followUpHintLine(entry: FollowUpRecord): string {
  return `- ${entry.bid} 已闭环，提案 ${entry.issuePath} 有追加结论（${fmtTime(entry.at)}），请读取文件`;
}

/**
 * R5: pick **at most one** append to hint about, oldest first, skipping the
 * ones already shown to this session and the ones whose path does not validate.
 * Returns the line plus the keys to stamp, or nothing when there is nothing to
 * show. Never renders anything derived from a free-text field.
 */
export function nextFollowUpHint(
  record: BroadcastRecord,
  sessionID: string,
  seen: string[],
  { workspace }: { workspace?: unknown } = {}
): { line: string; keys: string[] } | undefined {
  const known = new Set(seen);
  const skipped: string[] = [];
  for (const entry of followUpsOf(record)) {
    const key = followUpSeenKey(sessionID, record.bid, entry.at);
    if (known.has(key)) continue;
    const check = validateIssuePath(workspace ?? record.workspace, entry.issuePath);
    if (!check.ok) {
      // Fail-closed and quiet: an entry that cannot be validated is never
      // rendered (no fallback text) and is remembered so it cannot cost a
      // stat() on every request either.
      skipped.push(key);
      continue;
    }
    return {
      line: followUpHintLine({ ...entry, issuePath: check.issuePath }),
      keys: [...skipped, key]
    };
  }
  return skipped.length ? { line: '', keys: skipped } : undefined;
}
