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
 *
 * 0.3.1 (F1–F3, std-ui review):
 *   - F1: the *stamp* moved to the caller — `nextFollowUpHint` is a pure query
 *     and the `context` hook marks the keys only after the block is pushed;
 *   - F2: an unusable entry is no longer stamped. It used to be remembered as
 *     "already hinted" (at-most-once with a silent drop) even though nothing
 *     was ever rendered, so a proposal that was archived / moved / symlinked
 *     made the hint disappear forever. Now it stays pending and `collab_list`
 *     reports the count (once per session, see `takeInvalidFollowUpNotice`);
 *   - F3: the path is normalised first (`./`, `.` and repeated `/` collapse to
 *     the same file); only `..` and absolute paths are refused outright.
 */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
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
 *
 * F3 (0.3.1): the path is normalised **before** it is judged — empty segments
 * and `.` are dropped, so `./docs/issues/x.md`, `docs//issues/x.md` and
 * `docs/issues/./x.md` are the one file the caller meant. Only `..` and
 * absolute paths are refused outright; the symlink refusal below is unchanged
 * (the boundary is `docs/issues/`, not the caller's convenience).
 */
export function validateIssuePath(workspace: unknown, raw: unknown): IssuePathCheck {
  const root = String(workspace ?? '').trim();
  if (!root) return { ok: false, reason: '记录没有 workspace，无法校验提案路径' };
  if (!isAbsolute(root)) return { ok: false, reason: `workspace 不是绝对路径：${root}` };
  const issuePath = sanitizePathText(raw);
  if (!issuePath) return { ok: false, reason: 'issuePath 为空' };
  if (isAbsolute(issuePath)) return { ok: false, reason: `issuePath 不能是绝对路径：${issuePath}` };
  const parts = issuePath.split('/').filter(part => part && part !== '.');
  if (parts.includes('..')) return { ok: false, reason: `issuePath 不能包含 ..：${issuePath}` };
  const clean = parts.join('/');
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
 * Returns the line plus the key(s) the caller should stamp **after** the line
 * is actually in front of the model, or nothing when there is nothing to show.
 * Never renders anything derived from a free-text field.
 *
 * F1 (0.3.1): pure query — no stamping here any more. Stamping before the
 * injection was an at-most-once delivery with no confirmation: a hook that
 * threw (or a host that dropped the block) lost the hint forever.
 *
 * F2 (0.3.1): an unusable entry is **skipped without being stamped**. It used
 * to be "remembered" so it cost no `stat()` per request, but that also meant a
 * proposal archived / moved / symlinked after the append made the conclusion
 * disappear silently and permanently. The retry is natural (next request), and
 * `collab_list` reports the backlog (see `takeInvalidFollowUpNotice`).
 */
export function nextFollowUpHint(
  record: BroadcastRecord,
  sessionID: string,
  seen: string[],
  { workspace }: { workspace?: unknown } = {}
): { line: string; keys: string[] } | undefined {
  const known = new Set(seen);
  for (const entry of followUpsOf(record)) {
    const key = followUpSeenKey(sessionID, record.bid, entry.at);
    if (known.has(key)) continue;
    const check = validateIssuePath(workspace ?? record.workspace, entry.issuePath);
    if (!check.ok) continue; // F2: not stamped — retried next round, counted by collab_list
    return {
      line: followUpHintLine({ ...entry, issuePath: check.issuePath }),
      keys: [key]
    };
  }
  return undefined;
}

/**
 * F2 (0.3.1): the appends of one record that would render nothing — the same
 * check `nextFollowUpHint` applies, materialised so the requester can be told
 * (once) instead of the entry being silently stamped into oblivion. The
 * rejection reason is deliberately **not** kept: it quotes the path text, and
 * that is exactly what must not reach a `collab_list` reader.
 */
export function invalidFollowUps(
  record: BroadcastRecord | undefined,
  workspace?: unknown
): FollowUpRecord[] {
  const out: FollowUpRecord[] = [];
  for (const entry of followUpsOf(record)) {
    const check = validateIssuePath(workspace ?? asObject(record).workspace, entry.issuePath);
    if (!check.ok) out.push(entry);
  }
  return out;
}

function invalidStorageKey(sessionID: string): string {
  return `collab/followup-invalid/${sessionID}`;
}

/**
 * F2 (0.3.1): `true` when this session should be told about the unusable
 * appends now — i.e. when the set of them changed since the last time it was
 * told. Each unusable entry is therefore counted once per session, a growing
 * backlog is re-reported, and an unchanged one never becomes per-turn noise.
 *
 * Called from an explicit pull (`collab_list`), so a storage failure returns
 * `true` (fail-visible) rather than hiding the fact that a hint channel is
 * broken.
 */
export async function takeInvalidFollowUpNotice(
  ctx: CollabContext,
  sessionID: string | undefined,
  entries: FollowUpRecord[]
): Promise<boolean> {
  if (!sessionID || !entries.length) return false;
  const sigs = dedupe(entries.map(entry => `${entry.bid}:${entry.at}`)).sort();
  try {
    const raw = asObject(await ctx.storage.get(invalidStorageKey(sessionID)));
    const shown = Array.isArray(raw.sigs) ? raw.sigs.filter((sig: unknown): sig is string => typeof sig === 'string') : [];
    if (shown.length === sigs.length && shown.every((sig, index) => sig === sigs[index])) return false;
    await ctx.storage.set(invalidStorageKey(sessionID), { sigs, at: Date.now() });
    return true;
  } catch {
    return true;
  }
}

/** F2: the `collab_list` summary of those entries (count first, never the path). */
export function invalidFollowUpLines(entries: FollowUpRecord[]): string[] {
  if (!entries.length) return [];
  const head =
    `${entries.length} 条 followUp 因路径无效未渲染（未标记：把结论写回该 workspace 的 ` +
    'docs/issues/<name>.md 后，下一轮注入会自动提示）:';
  const lines = entries
    .slice(0, 5)
    .map(entry => `- ${entry.bid} 追加于 ${fmtTime(entry.at)} → issuePath 未通过校验`);
  if (entries.length > 5) lines.push(`…还有 ${entries.length - 5} 条`);
  return [head, ...lines];
}
