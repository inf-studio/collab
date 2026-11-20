/**
 * 0.9.1 (`11-20-collab-contract`, D7): where the mainline anchor comes from.
 *
 * Resolution order (design §4), strictly in this order — **never** by guessing
 * from the session title:
 *
 *   1. the session pointer written by the Trellis runtime:
 *      `<workspace>/.trellis/.runtime/sessions/<platform>_<sid>.json`, read
 *      through `current_task` (the field this host writes) or `task_path`
 *      (the design's wording); both are accepted;
 *   2. the workspace's **exactly one** `.trellis/tasks/<slug>/task.json` with
 *      `status === 'in_progress'`;
 *   3. nothing — the injection then shows `[mission] … [未确认]` and points at
 *      `collab_mission set`.
 *
 * Deliberately no `task.py` subprocess: this runs on **every** model request,
 * and spawning python per request would cost more than the reminder is worth.
 * The JSON pointer is the same information, already on disk.
 */

import { existsSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { asObject, readJsonFile, truncate } from '../util.ts';

export interface MissionAnchor {
  /** `pointer` / `task` / `ambiguous` (2+ in_progress) / `none`. */
  source: 'pointer' | 'task' | 'ambiguous' | 'none';
  /** Workspace-relative `.trellis/tasks/<slug>` when known. */
  taskPath?: string;
  /** The task's own `title` — one line, never a guess from the session title. */
  oneLine?: string;
  /** `ambiguous` only: the candidate task paths (display / refusal text). */
  candidates?: string[];
}

const NONE: MissionAnchor = { source: 'none' };

/** Turn an absolute task dir into `.trellis/tasks/<slug>` when it lives inside the workspace. */
function displayPath(directory: string, target: string): string {
  if (!isAbsolute(target)) return target.replace(/^\.\//, '').replace(/\/+$/, '');
  const rel = relative(directory, target).replaceAll('\\', '/');
  return rel.startsWith('..') ? target : rel;
}

function taskTitle(taskDir: string, fallback: string): string {
  const raw = asObject(readJsonFile(join(taskDir, 'task.json')));
  return truncate(raw.title, 200) || fallback;
}

/**
 * The session pointer files. The real shape is
 * `{ platform, last_seen_at, current_task, current_run }`, but a pointer whose
 * `sid` / `session_id` field disagrees with the file name is ignored: a stale
 * copy must not become somebody else's mainline.
 */
function pointerTask(directory: string, sessionID: string): { taskPath: string; oneLine: string } | undefined {
  const dir = join(directory, '.trellis', '.runtime', 'sessions');
  if (!existsSync(dir)) return undefined;
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter(name => name.endsWith('.json'));
  } catch {
    return undefined;
  }
  const sid = String(sessionID ?? '').trim();
  if (!sid) return undefined;
  // Exact `<platform>_<sid>.json` first, then any name that carries the sid.
  const exact = names.filter(name => name === `opencode_${sid}.json` || name.slice(0, -5).endsWith(`_${sid}`));
  const loose = names.filter(name => name.includes(sid));
  for (const name of [...exact, ...loose.filter(name => !exact.includes(name))]) {
    const value = asObject(readJsonFile(join(dir, name)));
    const declared = String(value.sid ?? value.session_id ?? value.sessionId ?? '').trim();
    if (declared && declared !== sid) continue;
    if (!declared && !name.includes(sid)) continue;
    const stored = String(value.current_task ?? value.task_path ?? '').trim();
    if (!stored) continue;
    const absolute = isAbsolute(stored) ? stored : join(directory, stored);
    if (!existsSync(absolute)) continue; // stale pointer: fall through, never guess
    return {
      taskPath: displayPath(directory, stored),
      oneLine: taskTitle(absolute, basename(absolute))
    };
  }
  return undefined;
}

/** Every top-level `.trellis/tasks/<slug>/task.json` with `status:'in_progress'`. */
function inProgressTasks(directory: string): Array<{ taskPath: string; oneLine: string }> {
  const tasksDir = join(directory, '.trellis', 'tasks');
  if (!existsSync(tasksDir)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(tasksDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'archive' && !entry.name.startsWith('.'))
      .map(entry => entry.name);
  } catch {
    return [];
  }
  const hits: Array<{ taskPath: string; oneLine: string }> = [];
  for (const name of entries) {
    const taskDir = join(tasksDir, name);
    const taskFile = join(taskDir, 'task.json');
    if (!existsSync(taskFile)) continue;
    const value = asObject(readJsonFile(taskFile));
    if (String(value.status ?? '') !== 'in_progress') continue;
    hits.push({
      taskPath: `.trellis/tasks/${name}`,
      oneLine: truncate(value.title, 200) || name
    });
  }
  return hits;
}

/**
 * Resolve the mainline anchor. Read-only, no subprocess, no writes: safe to call
 * on every request and from a read-only tool.
 */
export function resolveMissionAnchor(directory: string | undefined, sessionID: string): MissionAnchor {
  const workspace = String(directory ?? '').trim();
  if (!workspace) return NONE;
  const pointer = pointerTask(workspace, sessionID);
  if (pointer) return { source: 'pointer', ...pointer };
  const tasks = inProgressTasks(workspace);
  if (tasks.length === 1) return { source: 'task', ...tasks[0] };
  if (tasks.length > 1) {
    return {
      source: 'ambiguous',
      candidates: tasks.map(task => task.taskPath).slice(0, 10)
    };
  }
  return NONE;
}

/** The text blocks of one message (`parts[].text` / `content[]` / `text`). */
export function messageTextOf(message: unknown): string {
  const value = asObject(message);
  if (typeof value.text === 'string' && value.text.trim()) return value.text;
  const parts = Array.isArray(value.parts) ? value.parts : Array.isArray(value.content) ? value.content : [];
  return parts
    .map(part => (typeof part === 'string' ? part : String(asObject(part).text ?? asObject(part).content ?? '')))
    .filter(text => text.trim().length > 0)
    .join('\n');
}

/** The latest user text of this request (scope matching); falls back to any text. */
export function latestRequestText(event: { messages?: unknown[] } | undefined): string {
  const messages = Array.isArray(event?.messages) ? (event?.messages as unknown[]) : [];
  let fallback = '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = asObject(messages[index]);
    const text = messageTextOf(value);
    if (!text.trim()) continue;
    // The newest user turn is the message `[scope]` must judge; a host that does
    // not tag roles still gets the newest text via the fallback.
    if (String(value.role ?? value.type ?? '').trim() === 'user') return text;
    if (!fallback) fallback = text;
  }
  return fallback;
}

/**
 * The first human instruction of the session — the last-resort `oneLine`
 * suggestion when there is no task anchor (PRD R2). Read-only, bounded to the
 * first 20 messages the host returns, and silent on any host failure.
 */
export async function firstHumanInstruction(
  ctx: { session?: { context?: (input: { sessionID: string; limit?: number }) => Promise<unknown> } },
  sessionID: string
): Promise<string> {
  try {
    const result = await ctx.session?.context?.({ sessionID, limit: 20 });
    const messages = Array.isArray(result)
      ? result
      : Array.isArray(asObject(result).data)
        ? (asObject(result).data as unknown[])
        : [];
    for (const message of messages) {
      const value = asObject(message);
      const role = String(value.role ?? value.type ?? '').trim();
      if (role && role !== 'user') continue;
      const text = messageTextOf(value).replace(/\s+/g, ' ').trim();
      if (text) return truncate(text, 200);
    }
  } catch {
    /* a suggestion is optional — never fail a tool call over it */
  }
  return '';
}
