/**
 * `collab_threads` — **read-only** inventory of the threads with one counterpart
 * (0.7.0, `11-19-collab-threads`, R1/R3/R4).
 *
 * Why a tool and not a bigger `collab_list`: the observed failure was one pair of
 * sessions running **7 threads in parallel** (6 of them plain `collab_send` /
 * `collab_reply` message threads), so "which of these still owes an answer?" was
 * unanswerable before sending the 8th message. `collab_list` is a session
 * inventory; this is a conversation inventory for **one** target.
 *
 * Where the data comes from (and why an index exists at all): `ThreadStore` can
 * read a thread by id but cannot enumerate, so `core/thread-index.ts` records
 * one entry per thread **after a message was really admitted**. This tool joins
 * that index with
 *   - the broadcast records (a thread that carries a hand-off → `kind:handoff`,
 *     its `state`, and the `bid`), and
 *   - the thread record (`status` / the actual in/out messages, for the summary).
 *
 * Read-only by construction (design §5): `readThreadIndex` / `allBroadcasts` /
 * `threads.read` only. It must **never** call `writeBroadcast`, `threads.update`,
 * `recordThread`, `session.prompt` or `session.update` — the harness runs it with
 * a strict host and compares the index file (mtime + hash) before and after.
 */
import {
  BCAST_DONE_STATES,
  STORAGE_ALIASES,
  THREAD_INDEX_RETENTION_MS,
  THREAD_SUMMARY_CHARS,
  THREADS_CLOSED_MAX,
  THREADS_MAX
} from '../constants.ts';
import { allBroadcasts } from '../core/claim.ts';
import { invalid } from '../core/errors.ts';
import { threadsFor } from '../core/thread-index.ts';
import { normalizeThreadID } from '../ids.ts';
import type { BroadcastRecord, CollabContext, ThreadIndexEntry, ThreadRecord, ToolDefinition } from '../types.ts';
import { asObject, truncate } from '../util.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/** Retention window of the rows (same 7 days the index uses on read). */
const RETENTION_MS = THREAD_INDEX_RETENTION_MS;

const isClosedState = (record: BroadcastRecord): boolean => BCAST_DONE_STATES.includes(String(record.state));

/** `HH:MM` — a thread list is browsed, not audited (`collab_status` shows seconds). */
function hhmm(at: number): string {
  const d = new Date(Number(at) || 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * `<alias>|ses_…` → the session id. Tolerant on purpose: this tool must work for
 * a counterpart that is archived / no longer readable (a thread outlives the
 * session row), so it resolves through the alias tables and never calls
 * `session.get`. An unknown alias is still a readable error — a typo must not
 * answer "no threads".
 */
async function resolveTargetSid(
  ctx: CollabContext,
  aliases: Record<string, string>,
  raw: unknown
): Promise<{ sid: string; alias?: string }> {
  const text = String(raw ?? '').trim();
  if (!text) throw invalid('target 不能为空：请给 ses_… 会话 id 或 collab.json 里的别名');
  if (text.startsWith('ses_')) return { sid: text };
  let stored: Record<string, string> = {};
  try {
    stored = asObject(await ctx.storage.get(STORAGE_ALIASES)) as Record<string, string>;
  } catch {
    stored = {}; // an unreadable alias table = collab.json's aliases only
  }
  const sid = String({ ...stored, ...aliases }[text] ?? '').trim();
  if (!sid) {
    throw invalid(
      `未知目标 "${text}"：既不是 ses_ 会话 id，也不在别名表里` +
        '（collab.json 的 aliases，或 ~/.config/opencode/collab-aliases.json）'
    );
  }
  return { sid, alias: text };
}

/** One row of the answer — index entry + whatever the joins found. */
interface Row {
  threadID: string;
  target: string;
  kind: 'handoff' | 'messages';
  /** `handoff` state, or the thread store status (`open` / `answered`). */
  status: string;
  closed: boolean;
  lastAt: number;
  /** Last message written *by* the caller side (≤120 chars). */
  out?: string;
  /** Last message written *by* the counterpart (≤120 chars). */
  in?: string;
  bid?: string;
  record?: BroadcastRecord;
  thread?: ThreadRecord;
}

/**
 * One message as a preview line. A local hand-off's first message starts with
 * the recipient-facing protocol block (`你是承接方（bid=… …）` + the two receipt
 * commands + a blank line) — that is plumbing, not the task, so the block is
 * dropped here. Presentation only: the thread record keeps the full message.
 */
function summarize(text: unknown): string {
  const raw = String(text ?? '');
  const body = raw.startsWith('你是承接方（') && raw.includes('\n\n') ? raw.slice(raw.indexOf('\n\n') + 2) : raw;
  return truncate(body, THREAD_SUMMARY_CHARS);
}

/** The last message of each direction, from the thread record (the SSOT). */
function directionsOf(thread: ThreadRecord | undefined, target: string): { out?: string; in?: string } {
  const out: { out?: string; in?: string } = {};
  for (const message of [...(thread?.msgs ?? [])].reverse()) {
    const text = summarize(message?.text);
    if (!text) continue;
    if (String(message?.fromSession ?? '') === target) {
      out.in ??= text;
    } else {
      out.out ??= text;
    }
    if (out.in && out.out) break;
  }
  return out;
}

export function threadsTool(kit: ToolKit): ToolDefinition {
  const { deps } = kit;
  const { ctx, readConfig, threads } = deps;

  return {
    name: 'collab_threads',
    description:
      'Read-only inventory of the threads with one counterpart session (`target` = ses_… or alias): threadID, ' +
      'kind (handoff = carries a hand-off bid / messages = plain collab_send-collab_reply thread), state ' +
      '(open|answered|done|blocked|expired), the last outbound and inbound summary (≤120 chars each), the last ' +
      'activity and — for hand-offs — the bid. Unresolved threads first (default); `includeClosed:true` also ' +
      'lists the most recent 3 closed ones. At most 20 threads (`还有 N 个` beyond that). Writes nothing: it ' +
      'never touches the thread index, a hand-off record, a thread or the counterpart. Use collab_status ' +
      '{threadID} for one thread in detail; collab_list for the session inventory.',
    input: jsonInput({
      properties: {
        target: {
          type: 'string',
          description: 'Session id (`ses_…`) or an alias — the counterpart whose threads to list.'
        },
        includeClosed: {
          type: 'boolean',
          description: 'Also list the most recent 3 closed threads (default false = unresolved only).'
        }
      },
      required: ['target']
    }),
    async execute(input, context) {
      const now = Date.now();
      const me = context?.sessionID;
      const requested = String(input?.target ?? '').trim();
      const { sid, alias } = await resolveTargetSid(ctx, readConfig().aliases, requested);
      const includeClosed = input?.includeClosed === true;

      // ① the index (only threads whose message was really admitted are there).
      const indexed = new Map<string, ThreadIndexEntry>();
      for (const entry of threadsFor(sid, now)) {
        indexed.set(entry.threadID, entry);
      }
      // ② every hand-off record that names this counterpart — an index entry is
      // only written from 0.7.0 on, so old/foreign threads must still show up.
      const records = allBroadcasts().filter(record => {
        const threadID = normalizeThreadID(record.threadID);
        if (!threadID) return false;
        return String(record.from?.sid ?? '') === sid || String(record.claim?.by ?? '') === sid;
      });
      const recordsByThread = new Map<string, BroadcastRecord>();
      for (const record of records) {
        const threadID = normalizeThreadID(record.threadID);
        if (threadID) recordsByThread.set(threadID, record);
      }

      const threadIDs = [...new Set([...indexed.keys(), ...recordsByThread.keys()])];
      // Rank before reading: `threads.read` is a host call per thread, and the
      // index can hold hundreds of entries while at most THREADS_MAX are shown.
      // Take the newest slice (plus the closed slots and a little slack) and read
      // only those; an older thread is still reachable by `collab_status`.
      const ranked = threadIDs
        .map(threadID => {
          const entry = indexed.get(threadID);
          const record = recordsByThread.get(threadID);
          const lastAt =
            Number(record?.updatedAt) || Number(record?.createdAt) || Number(entry?.lastAt) || 0;
          return { threadID, lastAt };
        })
        .filter(candidate => !candidate.lastAt || now - candidate.lastAt <= RETENTION_MS)
        .sort((a, b) => b.lastAt - a.lastAt || a.threadID.localeCompare(b.threadID))
        .slice(0, THREADS_MAX + THREADS_CLOSED_MAX + 7);
      const rows: Row[] = [];
      for (const { threadID } of ranked) {
        const entry = indexed.get(threadID);
        const record = recordsByThread.get(threadID);
        const lastAt =
          Number(record?.updatedAt) || Number(record?.createdAt) || Number(entry?.lastAt) || 0;
        const thread = await threads.read(threadID);
        const kind = record || entry?.kind === 'handoff' ? 'handoff' : 'messages';
        const closed = record ? isClosedState(record) : String(thread?.status ?? '') === 'answered';
        const { out, in: inbound } = directionsOf(thread, sid);
        rows.push({
          threadID,
          target: sid,
          kind,
          status: record ? String(record.state ?? 'open') : String(thread?.status ?? 'open'),
          closed,
          lastAt: lastAt || now,
          out: out ?? entry?.preview,
          in: inbound,
          bid: String(record?.bid ?? entry?.bid ?? '') || undefined,
          record,
          thread
        });
      }

      rows.sort((a, b) => b.lastAt - a.lastAt || a.threadID.localeCompare(b.threadID));
      const unresolved = rows.filter(row => !row.closed);
      const closed = rows.filter(row => row.closed);
      // `includeClosed` reserves its slots: a full page of unresolved threads must
      // not silently swallow the closed ones the caller asked for.
      const unresolvedShown = unresolved.slice(0, includeClosed ? Math.max(0, THREADS_MAX - THREADS_CLOSED_MAX) : THREADS_MAX);
      const closedShown = includeClosed ? closed.slice(0, THREADS_CLOSED_MAX) : [];
      const shown = [...unresolvedShown, ...closedShown];
      const rest =
        unresolved.length - unresolvedShown.length + (includeClosed ? closed.length - closedShown.length : 0);

      const who = `${sid}${alias ? `（别名 ${alias}）` : ''}${me === sid ? '（本会话）' : ''}`;
      const footer = '只读查询：不写索引、不改 thread 状态、不投递；单条详情用 collab_status {threadID}。';

      if (!shown.length) {
        return {
          content: [
            `与 ${who} 没有未闭环 thread（7 天内索引与交接记录都为空）。`,
            closed.length
              ? `已闭环 ${closed.length} 个：includeClosed:true 可列出最近 ${Math.min(closed.length, THREADS_CLOSED_MAX)} 个。`
              : '索引在 0.7.0 起才写入：升级前建立的旧 thread 只能按 threadID 用 collab_status / collab_wait。',
            footer
          ].join('\n')
        };
      }

      const lines = shown.map((row, index) => {
        const parts = [
          `- ${row.threadID}`,
          row.kind,
          row.status,
          hhmm(row.lastAt),
          row.out ? `out="${row.out}"` : 'out=-',
          row.in ? `in="${row.in}"` : 'in=-'
        ];
        if (row.bid) parts.push(`bid=${row.bid}`);
        // The suggestion mark: the newest unresolved thread is the one to answer.
        if (index === 0 && !row.closed) parts.push('← 建议继续');
        if (row.closed) parts.push('（已闭环）');
        return parts.join('  ');
      });

      const head = rows.length
        ? `与 ${who} 的 thread ${rows.length} 个（未闭环 ${unresolved.length}${
            includeClosed && closedShown.length ? `，另列已闭环 ${closedShown.length}` : ''
          }）：`
        : `与 ${who} 没有 thread 记录（7 天内索引与交接记录都为空）。`;

      const suggestion = unresolved.length
        ? `建议: 先看 ${unresolved[0].threadID}（${
            unresolved[0].kind === 'handoff' ? '交接单' : '消息 thread'
          }，最近活动）→ ${
            unresolved[0].kind === 'handoff'
              ? `collab_status {threadID:"${unresolved[0].threadID}"}`
              : `collab_reply {threadID:"${unresolved[0].threadID}", text:"…", confirm:true}`
          }；其它未闭环同理，别在同一 target 上再开新 thread。`
        : '建议: 没有未闭环 thread —— 需要新话题时再开一个 thread；历史用 includeClosed:true。';

      return {
        content: [
          head,
          ...lines,
          rest > 0 ? `…还有 ${rest} 个（渲染上限 ${THREADS_MAX}；单条用 collab_status {threadID}）` : '',
          suggestion,
          footer
        ]
          .filter(Boolean)
          .join('\n')
      };
    }
  };
}
