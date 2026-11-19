/**
 * `collab_status` — the **non-blocking** answer to "where is this hand-off now"
 * (0.6.0, R1–R5).
 *
 * Why a new tool instead of reusing `collab_wait`: waiting is a different verb.
 * A frozen / escalated hand-off needs an answer *now* — "claimed, 4m of lease
 * left, seen 03:58, queue position 1" — not a call that blocks until a reply
 * exists. `collab_list` is an inventory (every session, every open hand-off);
 * this answers about one hand-off, resolved. And a protected target can never be
 * pushed to at all, so for those the only remaining question is "what is queued
 * for it, and where in that queue" — which this tool answers with
 * `canPush:false`.
 *
 * Read-only by construction (design §4). The only inputs are
 * `readBroadcast` / `allBroadcasts` / `mineFor` / `listFor` / `ctx.session.get`
 * + `ctx.session.list` (lineage). It must **never** call
 *   - `writeBroadcast` / `persistRefresh` — those would *rewrite* a lapsed claim
 *     (the next refresh's job) instead of describing it;
 *   - `session.prompt` / `session.update` / `session.remove` — a status query is
 *     not a delivery;
 *   - `releaseLock` / `markSeen` / `touchWaiters` — no side path may fire.
 * The harness runs it against a strict host (every write method throws) and
 * compares the broadcast / owner-queue directories before and after.
 */
import { BCAST_DONE_STATES, STORAGE_ALIASES } from '../constants.ts';
import { deliveryOf, unackedDue } from '../core/ack.ts';
import { allBroadcasts, isValidBid, leaseVerdict, readBroadcast } from '../core/claim.ts';
import { invalid } from '../core/errors.ts';
import { createLineage } from '../core/lineage.ts';
import { fmtTtl } from '../core/locks.ts';
import { listFor, mineFor } from '../core/owner-queue.ts';
import type { BroadcastRecord, CollabContext, OwnerQueueItem, ToolDefinition } from '../types.ts';
import { asObject, fmtTime, shortID, truncate } from '../util.ts';
import { isValidThreadID, normalizeThreadID } from '../ids.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/** No-input mode: at most this many unresolved hand-offs. */
const MAX_NO_INPUT = 5;
/** Queue items rendered per hand-off (a full queue is 50; a status is not a dump). */
const MAX_QUEUE_LINES = 5;
/** Display cut for a reply / receipt summary — never the full body. */
const SUMMARY_CHARS = 60;

const isClosed = (record: BroadcastRecord): boolean => BCAST_DONE_STATES.includes(String(record.state));

/** `updatedAt` desc, bid as the tie-break so two writes in one ms stay stable. */
const newestFirst = (a: BroadcastRecord, b: BroadcastRecord): number =>
  (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) || String(a.bid).localeCompare(String(b.bid));

/** `priority` is a 0.6.0 field: absent = normal (read tolerantly, never written). */
const priorityOf = (record: BroadcastRecord): string =>
  asObject(record).priority === 'urgent' ? 'urgent' : 'normal';

/** A session is "involved" in a record as its requester or as its claimant. */
const involved = (record: BroadcastRecord, sid: string): boolean =>
  Boolean(sid) && (String(record.from?.sid ?? '') === sid || String(record.claim?.by ?? '') === sid);

/**
 * The session this hand-off is currently addressed to — the one that owes an
 * answer (claimant), the one being asked (top-1 candidate), the one the takeover
 * message went to, or (a protected target that can never claim) the target of
 * the owner-queue item this very bid was submitted to.
 */
function addresseeOf(record: BroadcastRecord, items: OwnerQueueItem[]): string {
  const claimBy = String(record.claim?.by ?? '');
  if (claimBy) return claimBy;
  const askedSid = String(record.asked?.sid ?? '');
  if (askedSid) return askedSid;
  const to = String(deliveryOf(record).to ?? '');
  if (to) return to;
  return String(items[items.length - 1]?.target ?? '');
}

/** `第 1/3 位` of the target's unread queue, or the read/finished wording. */
function queuePosition(item: OwnerQueueItem): string {
  if (item.seenAt) return `已读 ${fmtTime(item.seenAt)}（不在队列）`;
  try {
    const unread = listFor(item.target).filter(entry => !entry.seenAt);
    const index = unread.findIndex(entry => entry.id === item.id);
    return index >= 0 ? `第 ${index + 1}/${unread.length} 位（未读）` : '未读（位置未知）';
  } catch {
    // A tampered item (a `target` that is not a session id) must not take the
    // whole status down: the position is the only thing that is unavailable.
    return '未读（位置未知）';
  }
}

/** `admitted=03:57:59  seen=03:58:10` — absolute times, unlike `collab_list`'s ages. */
function deliveryText(record: BroadcastRecord, now: number): string {
  const delivery = deliveryOf(record);
  if (!delivery.cid) return '-（本单没有投递记录）';
  const admittedAt = Number(delivery.admittedAt) || 0;
  const seenAt = Number(delivery.seenAt) || 0;
  const parts = [
    `admitted=${admittedAt ? fmtTime(admittedAt) : delivery.failedAt ? 'failed' : '-'}`,
    `seen=${seenAt ? fmtTime(seenAt) : delivery.ackUnavailable ? 'n/a' : '-'}`
  ];
  if (delivery.ackUnavailable) parts.push('ack=n/a（发起方受保护，回执走 pull）');
  if (delivery.unacked || unackedDue(record, now)) parts.push('unacked=yes（重发预算已用尽，可人工补投）');
  else if (Number(delivery.resends)) parts.push(`resend=${Number(delivery.resends)}`);
  return parts.join('  ');
}

/**
 * The one line that turns a status into an action. `canPush === false` (the
 * addressee is protected, itself or through its lineage) is checked before the
 * state: queueing is the *only* remaining channel there, whatever the state is.
 * A closed hand-off always ends in 无需动作 — there is nothing left to push.
 */
function nextStep(record: BroadcastRecord, canPush: boolean | undefined): string {
  if (isClosed(record)) return '无需动作（已闭环：结论看上面的 receipt / 最近回复，历史用 collab_list）';
  if (canPush === false) return '只能队列（该目标受保护）：collab_request_owner 或等其下一轮';
  const threadID = String(record.threadID ?? '');
  const wait = threadID ? `collab_wait {threadID:"${threadID}"}` : 'collab_wait {target}（该单没有 threadID）';
  switch (String(record.state)) {
    case 'claimed':
      return `等回执 → ${wait}；超时用 collab_escalate`;
    case 'acked':
      return `等对端回执（已 acked）→ ${wait}；静默过久会被自动提取`;
    case 'open':
      return record.asked?.sid
        ? `等 ${shortID(record.asked.sid)} ACCEPT/DECLINE；问询超时后自动顺延`
        : '等候选领取；无候选可用 collab_broadcast 重新问询';
    default:
      return '无需动作';
  }
}

interface Pick {
  record: BroadcastRecord;
  /** Owner-queue items that name this very bid (submitted by the requester). */
  items: OwnerQueueItem[];
  addressee: string;
  /** `false` = the addressee is protected (push impossible); `true` = it is not. */
  canPush?: boolean;
}

/**
 * `<alias>|ses_…` → the session id. `collab.json` wins over the stored table
 * (the same precedence as `resolveTarget`); an unknown alias is kept verbatim so
 * a typo answers "no hand-offs" instead of throwing — a status query must not
 * fail like a delivery does.
 */
async function resolveSession(
  ctx: CollabContext,
  aliases: Record<string, string>,
  value: string
): Promise<string> {
  const text = value.trim();
  if (!text || text.startsWith('ses_')) return text;
  let stored: Record<string, string> = {};
  try {
    stored = asObject(await ctx.storage.get(STORAGE_ALIASES)) as Record<string, string>;
  } catch {
    stored = {}; // an unreadable table just means "config aliases only"
  }
  return String({ ...stored, ...aliases }[text] ?? text);
}

/** One hand-off, as text (design §3). */
function formatBlock({ record, items, addressee, canPush }: Pick, now: number): string {
  const claim = asObject(record.claim);
  const claimBy = String(claim.by ?? '');
  const claimAt = Number(claim.at) || 0;
  const leaseMs = Number(claim.leaseMs) || 0;
  // Read-only lease verdict: describes a lapsed claim, never reopens it (R1-4).
  const verdict = leaseVerdict(record, now);

  const head = [record.bid, `state=${record.state ?? 'open'}`, `priority=${priorityOf(record)}`];
  if (claimBy) {
    const kind = String(claim.kind ?? 'claim');
    // The remaining time is only meaningful while a lease applies (`verdict`);
    // a `done` / `acked` record has no live lease even though `claim` stays.
    const lease =
      verdict === 'expired'
        ? '，租约已过期'
        : verdict === 'ok' && claimAt && leaseMs
          ? `，剩 ${fmtTtl(Math.max(0, claimAt + leaseMs - now))}`
          : '';
    head.push(`承接=${shortID(claimBy)}（${kind}${lease}）`);
  } else {
    head.push('承接=-');
  }
  if (record.state === 'open' && record.asked?.sid) head.push(`问询=${shortID(record.asked.sid)}`);
  if (canPush !== undefined) head.push(`canPush=${String(canPush)}`);
  if (record.title) head.push(`"${truncate(record.title, 50)}"`);

  const lines = [head.join('  ')];
  if (verdict === 'expired' && claimBy) {
    lines.push('  注: 租约已过期 —— 下一次 refresh（collab_accept / context 注入）才会释放并顺延；本命令不改写状态。');
  }

  lines.push(`  投递: ${deliveryText(record, now)}`);

  if (items.length) {
    const target = String(items[items.length - 1]?.target ?? addressee ?? '');
    let unread = 0;
    try {
      unread = target ? listFor(target).filter(entry => !entry.seenAt).length : 0;
    } catch {
      unread = 0; // unusable target name: show the item, skip the count
    }
    lines.push(
      `  队列: ${items.length} 项（目标 ${shortID(target) || '-'}${unread ? `，未读 ${unread} 条` : ''}）:`
    );
    for (const item of items.slice(0, MAX_QUEUE_LINES)) {
      const urgent = asObject(item).priority === 'urgent' ? ' [urgent]' : '';
      lines.push(`    - ${item.id} @ ${fmtTime(item.at)} ${queuePosition(item)}${urgent}`);
    }
    if (items.length > MAX_QUEUE_LINES) lines.push(`    …还有 ${items.length - MAX_QUEUE_LINES} 项`);
  } else {
    lines.push('  队列: 0 项');
  }

  const replies = Array.isArray(record.replies) ? record.replies : [];
  const last = replies.length ? replies[replies.length - 1] : undefined;
  lines.push(
    last
      ? `  最近回复: ${fmtTime(last.at)} "${truncate(last.text, SUMMARY_CHARS)}"${
          last.from ? `（${shortID(last.from)}）` : ''
        }`
      : '  最近回复: -'
  );

  if (isClosed(record)) {
    const receipt = asObject(record.receipt);
    const note = String(receipt.note ?? '').trim();
    lines.push(
      note
        ? `  回执: ${fmtTime(receipt.at)} "${truncate(note, SUMMARY_CHARS)}"${
            receipt.from || receipt.by ? `（${shortID(receipt.from ?? receipt.by)}）` : ''
          }`
        : '  回执: -（记录里没有 receipt 摘要）'
    );
  }

  lines.push(`  下一步: ${nextStep(record, canPush)}`);
  return lines.join('\n');
}

/**
 * `collab_status` — read-only, non-blocking state of one hand-off (0.6.0).
 * Input is exactly one of `bid` / `threadID` / `session`; with none it lists the
 * unresolved hand-offs this session started or claimed (≤5, newest first).
 */
export function statusTool(kit: ToolKit): ToolDefinition {
  const { deps } = kit;
  const { ctx, readConfig } = deps;

  return {
    name: 'collab_status',
    description:
      'Read-only, non-blocking status of a hand-off: state, claim (holder + what is left of the lease), priority, ' +
      'delivery (admitted / seen / ack-unavailable), the owner-queue items of its target with the queue position, ' +
      'the last reply summary, the receipt of a closed hand-off and one suggested next step. Input is exactly one ' +
      'of `bid` / `threadID` / `session`; with none it lists the unresolved hand-offs this session started or ' +
      'claimed (at most 5, newest first). Writes nothing — no state refresh, no lock release, no message delivery ' +
      '— so it is safe on protected targets too (they report canPush:false and the queue position instead). ' +
      'For blocking waits use collab_wait; for a full inventory use collab_list.',
    input: jsonInput({
      properties: {
        bid: {
          type: 'string',
          description: 'Hand-off id (`b_…`) — the most precise form.'
        },
        threadID: {
          type: 'string',
          description: 'Thread id (`t_…`): every hand-off record of that thread.'
        },
        session: {
          type: 'string',
          description:
            'Session id (`ses_…`) or an alias: every unresolved hand-off it started (from.sid) or claimed ' +
            '(claim.by), plus the latest closed one.'
        }
      },
      required: []
    }),
    async execute(input, context) {
      const config = readConfig();
      const now = Date.now();
      const me = context?.sessionID;
      const bid = String(input?.bid ?? '').trim();
      const rawThread = String(input?.threadID ?? '').trim();
      const threadID = rawThread ? normalizeThreadID(rawThread) : undefined;
      const sessionInput = String(input?.session ?? '').trim();

      const given = [bid && 'bid', rawThread && 'threadID', sessionInput && 'session'].filter(Boolean) as string[];
      if (given.length > 1) {
        throw invalid(`collab_status 的 bid / threadID / session 三选一（本次收到 ${given.join(' + ')}）`);
      }
      if (bid && !isValidBid(bid)) {
        throw invalid(`bid 格式不合法：${JSON.stringify(bid)}（期望 b_ + 8–32 位十六进制）`);
      }
      if (rawThread && (!threadID || !isValidThreadID(threadID))) {
        throw invalid(`threadID 格式不合法：${JSON.stringify(rawThread)}（期望 t_<base36ts>_<rand>）`);
      }
      // A `session` may be an alias; both alias tables are read-only
      // (`collab.json` + the stored one `resolveTarget` uses).
      const session = sessionInput ? await resolveSession(ctx, config.aliases, sessionInput) : '';

      const records = allBroadcasts();
      const lineage = createLineage(ctx);
      const mineCache = new Map<string, OwnerQueueItem[]>();
      const mineOf = (sid: string): OwnerQueueItem[] => {
        if (!mineCache.has(sid)) {
          let list: OwnerQueueItem[] = [];
          try {
            list = mineFor(sid);
          } catch {
            list = []; // an unreadable queue is "nothing queued", never a failed status
          }
          mineCache.set(sid, list);
        }
        return mineCache.get(sid) ?? [];
      };
      const describe = async (record: BroadcastRecord): Promise<Pick> => {
        const requester = String(record.from?.sid ?? '');
        const items = requester
          ? mineOf(requester).filter(item => item.bid && String(item.bid) === String(record.bid))
          : [];
        const addressee = addresseeOf(record, items);
        const guard = addressee ? await lineage.protectedAncestor(addressee, config.protect) : undefined;
        return { record, items, addressee, canPush: addressee ? !guard : undefined };
      };

      const footer = '只读查询：不改状态、不释放租约、不投递；阻塞等待用 collab_wait，全量清单用 collab_list。';
      let header = '';
      let picks: Pick[];

      if (bid) {
        const record = readBroadcast(bid);
        if (!record) {
          throw invalid(
            `没有交接单 ${bid}：bid 可能拼错，或该单已闭环且过了 7 天保留期被回收。可用 collab_list 看全量。`
          );
        }
        picks = [await describe(record)];
      } else if (threadID) {
        const matches = records.filter(record => String(record.threadID ?? '') === threadID);
        if (!matches.length) {
          throw invalid(
            `没有 thread ${threadID} 对应的交接单：threadID 可能拼错，或该 thread 由 collab_send / collab_reply 建立` +
              '（没有广播记录）。可用 collab_inbox 核对 threadID。'
          );
        }
        picks = await Promise.all(matches.map(describe));
        header = `thread ${threadID} 的交接 ${picks.length} 条:`;
      } else if (session) {
        const related = records.filter(record => involved(record, session));
        const open = related.filter(record => !isClosed(record)).sort(newestFirst);
        const lastClosed = related.filter(isClosed).sort(newestFirst)[0];
        picks = await Promise.all([...open, ...(lastClosed ? [lastClosed] : [])].map(describe));
        if (!picks.length) {
          return {
            content: [
              `${session} 没有作为发起方（from.sid）或承接方（claim.by）的交接单。`,
              footer
            ].join('\n')
          };
        }
        header = `${session} 的交接 ${picks.length} 条（未闭环在前，最近一条已闭环在后）:`;
      } else {
        const related = me ? records.filter(record => involved(record, me)) : [];
        const open = related.filter(record => !isClosed(record)).sort(newestFirst).slice(0, MAX_NO_INPUT);
        if (!open.length) {
          return {
            content: [
              '当前没有未闭环交接。',
              me ? '' : '（没有会话上下文：无法判断「本会话」，可显式传 bid / threadID / session。）',
              footer
            ]
              .filter(Boolean)
              .join('\n')
          };
        }
        picks = await Promise.all(open.map(describe));
        header = `本会话相关的未闭环交接 ${picks.length} 条（按 updatedAt 倒序，最多 ${MAX_NO_INPUT} 条）:`;
      }

      const blocks = picks.map(pick => formatBlock(pick, now));
      return { content: [header, ...blocks, footer].filter(Boolean).join('\n') };
    }
  };
}
