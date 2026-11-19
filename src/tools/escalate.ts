/**
 * `collab_escalate` — the **urgent** path: put a hand-off in front of the right
 * session *now* (0.6.0).
 *
 * Why a tool and not a new mechanism: OpenCode's prompt API already accepts
 * `delivery: "queue" | "steer"` — the desktop "引导" button is `steer` — and
 * `SessionPromptResult.delivery` reports what the host actually did. This tool
 * wraps exactly that:
 *
 *   - a **normal** target gets one `[URGENT]` prompt, default `delivery:steer`
 *     (explicit `mode:"queue"` queues it); a read-only agent (`explore` /
 *     `plan`) is **forced** back to `queue` (`resolveMode`) and the receipt says
 *     `forced`;
 *   - a **protected** target (`BUILTIN_PROTECT` / lineage) is never pushed to:
 *     the escalation becomes one `priority:"urgent"` owner-queue item, and the
 *     receipt is `canPush:false` + the queue position;
 *   - the hand-off record only gains the four annotation fields
 *     (`priority` / `urgentAt` / `urgentReason` / `urgentBy`) via
 *     read-merge-write. `state` / `claim` / `receipt` are never touched — an
 *     escalation is not a state transition;
 *   - the same `bid` + the same `reason` within 5 minutes is one escalation: the
 *     second call only refreshes `urgentAt` and delivers nothing (hand-tremor
 *     guard, not a scheduler).
 *
 * Everything the caller is told is what really happened: the receipt prints the
 * delivery the **host** reported (`result.delivery ?? mode`), never the one that
 * was asked for.
 */
import { BCAST_DONE_STATES } from '../constants.ts';
import { deliveryOf } from '../core/ack.ts';
import { isValidBid, allBroadcasts, readBroadcast, writeBroadcast } from '../core/claim.ts';
import { deliveryFailure, invalid } from '../core/errors.ts';
import { createLineage } from '../core/lineage.ts';
import { enqueue, listFor, queueDir, queueID } from '../core/owner-queue.ts';
import { isValidThreadID, newCorrelationID, normalizeThreadID } from '../ids.ts';
import type {
  BroadcastRecord,
  SessionPromptInput,
  SessionPromptResult,
  ToolDefinition
} from '../types.ts';
import { fmtTime, sessionState, truncate } from '../util.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/** R5: the idempotency window — one `bid` + one `reason`, 5 minutes. */
const URGENT_WINDOW_MS = 5 * 60_000;
/** R1: `reason` is one short line, not a paragraph. */
const REASON_LIMIT = 200;
/** The `[URGENT]` prefix every delivered escalation carries. */
export const URGENT_PREFIX = '[URGENT]';

const isClosed = (record: BroadcastRecord): boolean => BCAST_DONE_STATES.includes(String(record.state));

/** `updatedAt` desc, bid as the tie-break so two writes in one ms stay stable. */
const newestFirst = (left: BroadcastRecord, right: BroadcastRecord): number =>
  (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0) || String(left.bid).localeCompare(String(right.bid));

/**
 * The session that owes the answer: the claimant, the one being asked, or the
 * target of the takeover message. Same precedence as `collab_status`.
 */
const addresseeOf = (record: BroadcastRecord): string =>
  String(record.claim?.by ?? '') || String(record.asked?.sid ?? '') || String(deliveryOf(record).to ?? '');

/**
 * R1: control characters (including newlines) become spaces, runs collapse, the
 * result is capped at `REASON_LIMIT`. The reason is rendered in a receipt and in
 * a prompt, so it must never introduce a second line.
 */
export function sanitizeReason(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REASON_LIMIT);
}

/** `第 1/2 位（未读）` of the target's unread queue. */
function queuePosition(itemID: string, targetSid: string): string {
  const unread = listFor(targetSid).filter(item => !item.seenAt);
  const index = unread.findIndex(item => item.id === itemID);
  return index >= 0 ? `第 ${index + 1}/${unread.length} 位（未读）` : '未读（位置未知）';
}

/**
 * R2: merge the four urgent fields into the **current** record. Only those four
 * are written; `state` / `claim` / `receipt` / `delivery` stay exactly as they
 * are on disk (the prompt above is an `await`, and the counterpart may have
 * written a receipt meanwhile).
 */
function markUrgent(
  record: BroadcastRecord | undefined,
  patch: { at: number; reason: string; by: string }
): BroadcastRecord | undefined {
  if (!record) return undefined;
  const fresh = readBroadcast(record.bid);
  if (!fresh) return undefined; // pruned while we were delivering: never resurrect
  return writeBroadcast({
    ...fresh,
    priority: 'urgent',
    urgentAt: patch.at,
    urgentReason: patch.reason,
    urgentBy: patch.by
  });
}

/**
 * `collab_escalate { bid? | threadID? | session?, reason, mode?, confirm }`.
 * Exactly one of the three target forms; `reason` is required; `confirm:true`
 * performs the escalation (otherwise a zero-write preview).
 */
export function escalateTool(kit: ToolKit): ToolDefinition {
  const { deps, resolveTarget, resolveMode, senderLabel } = kit;
  const { ctx, readConfig } = deps;

  /** One delivery, classified the same way `dispatch` classifies its own. */
  async function deliverUrgent(input: SessionPromptInput): Promise<SessionPromptResult> {
    try {
      return await ctx.session.prompt(input);
    } catch (error) {
      throw deliveryFailure(error);
    }
  }

  return {
    name: 'collab_escalate',
    description:
      'Escalate a hand-off as **urgent**: it reaches the target session now instead of waiting for its next turn. ' +
      'Input is exactly one of `bid` / `threadID` / `session`, plus a required one-line `reason` (≤200 chars, ' +
      'control characters stripped) and `confirm:true` (otherwise a zero-write preview). ' +
      'Default `mode` is `steer` — the prompt merges into the target\'s running turn (the desktop 引导 button uses ' +
      'the same host mechanism); an explicit `mode:"queue"` queues it, and a read-only agent (`explore` / `plan`) ' +
      'is forced back to `queue` (the receipt says `forced`). The receipt always prints the delivery the host ' +
      'actually adopted (`steer` may degrade to `queue` when the target is idle) and the admitted message id. ' +
      'On the hand-off record it only adds `priority:"urgent"` / `urgentAt` / `urgentReason` / `urgentBy` — ' +
      '`state` / `claim` / `receipt` are never changed. A target in the `protect` list (or any descendant of one) ' +
      'is never pushed to: the escalation becomes one `priority:"urgent"` item in that session\'s owner queue and ' +
      'the receipt is `canPush:false` with the queue position. Idempotent: the same `bid` + the same `reason` ' +
      'within 5 minutes only refreshes `urgentAt` and delivers nothing.',
    input: jsonInput({
      properties: {
        bid: {
          type: 'string',
          description: 'Hand-off id (`b_…`) — the most precise form; the addressee (claimant / asked) is escalated.'
        },
        threadID: {
          type: 'string',
          description: 'Thread id (`t_…`): the newest unresolved hand-off of that thread is escalated.'
        },
        session: {
          type: 'string',
          description:
            'Session id (`ses_…`) or an alias: escalate that session directly (the newest unresolved hand-off ' +
            'addressed to it is marked urgent, when there is one).'
        },
        reason: {
          type: 'string',
          description: 'Required one-line reason, shown to the target and stored on the record (≤200 chars).'
        },
        mode: {
          type: 'string',
          enum: ['steer', 'queue'],
          description:
            'steer (default) merges into the target\'s running turn; queue waits for its next turn. ' +
            'A read-only agent target is always forced to queue.'
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to actually escalate. false/omitted only returns the preview (zero writes).'
        }
      },
      required: ['reason', 'confirm']
    }),
    async execute(input, context) {
      const me = context?.sessionID;
      if (!me) throw invalid('缺少会话上下文（sessionID）：加急必须记录发起方，否则无法追溯。');

      // ------------------------------------------------------------- inputs
      const bid = String(input?.bid ?? '').trim();
      const rawThread = String(input?.threadID ?? '').trim();
      const sessionInput = String(input?.session ?? '').trim();
      const given = [bid && 'bid', rawThread && 'threadID', sessionInput && 'session'].filter(Boolean) as string[];
      if (!given.length) {
        throw invalid('必须给 bid / threadID / session 之一：加急需要明确的目标交接单或会话。');
      }
      if (given.length > 1) {
        throw invalid(`collab_escalate 的 bid / threadID / session 三选一（本次收到 ${given.join(' + ')}）`);
      }
      if (bid && !isValidBid(bid)) {
        throw invalid(`bid 格式不合法：${JSON.stringify(bid)}（期望 b_ + 8–32 位十六进制）`);
      }
      const threadID = rawThread ? normalizeThreadID(rawThread) : undefined;
      if (rawThread && (!threadID || !isValidThreadID(threadID))) {
        throw invalid(`threadID 格式不合法：${JSON.stringify(rawThread)}（期望 t_<base36ts>_<rand>）`);
      }

      const rawReason = String(input?.reason ?? '');
      const reason = sanitizeReason(rawReason);
      if (!reason) throw invalid('reason 不能为空：请给一句话说明为什么现在就要处理（≤200 字）');

      const config = readConfig();
      const now = Date.now();
      const confirmed = input?.confirm === true;
      const requestsSteer = String(input?.mode ?? '') !== 'queue';

      // ------------------------------------------------------------- target
      let record: BroadcastRecord | undefined;
      let targetSid = '';
      let scopeLine = '';

      if (bid) {
        record = readBroadcast(bid);
        if (!record) {
          throw invalid(`没有交接单 ${bid}：bid 可能拼错，或该单已闭环且过了 7 天保留期被回收。可用 collab_list 看全量。`);
        }
        targetSid = addresseeOf(record);
        if (!targetSid) {
          throw invalid(
            `交接单 ${bid} 还没有承接方 / 问询对象（state=${record.state ?? 'open'}）：没有可加急的会话。` +
              '先用 collab_broadcast 重新问询，或用 collab_send { target } 明确指定对象。'
          );
        }
        scopeLine =
          `交接: ${record.bid} state=${record.state ?? 'open'}` +
          `${record.threadID ? ` thread=${record.threadID}` : ''} 承接=${record.claim?.by ?? '-'}`;
      } else if (threadID) {
        const open = allBroadcasts()
          .filter(entry => String(entry.threadID ?? '') === threadID && !isClosed(entry))
          .sort(newestFirst);
        record = open[0];
        if (!record) {
          throw invalid(
            `thread ${threadID} 没有未闭环的交接单：threadID 可能拼错，或该 thread 的交接都已闭环。` +
              '可用 collab_status { threadID } 核对。'
          );
        }
        targetSid = addresseeOf(record);
        if (!targetSid) {
          throw invalid(`交接单 ${record.bid} 还没有承接方 / 问询对象：没有可加急的会话。`);
        }
        scopeLine = `交接: ${record.bid} state=${record.state ?? 'open'} thread=${threadID} 承接=${record.claim?.by ?? '-'}`;
      } else {
        const target = await resolveTarget(sessionInput);
        targetSid = target.sessionID;
        const open = allBroadcasts()
          .filter(entry => !isClosed(entry) && addresseeOf(entry) === targetSid)
          .sort(newestFirst);
        record = open[0];
        scopeLine = record
          ? `交接: ${record.bid} state=${record.state ?? 'open'}${record.threadID ? ` thread=${record.threadID}` : ''}`
          : '交接: -（该会话当前没有由它承接 / 被问询的未闭环交接；只加急会话，不标记记录）';
      }

      if (record && isClosed(record)) {
        throw invalid(
          `交接单 ${record.bid} 已闭环（state=${record.state}）：无需加急。` +
            '要看结论用 collab_status { bid } 或 collab_list。'
        );
      }
      if (targetSid === me) {
        throw invalid('拒绝加急：target 就是当前会话本身（不会给自己投递）。');
      }

      const target = await resolveTarget(targetSid);
      const lineage = createLineage(ctx);
      const guard = await lineage.protectedAncestor(targetSid, config.protect);
      const { mode, forced } = resolveMode(requestsSteer ? 'steer' : 'queue', target.info?.agent);
      const targetLine =
        `${targetSid}${target.alias ? ` (alias=${target.alias})` : ''}  agent=${target.info?.agent ?? '?'}  ` +
        `state=${sessionState(target.info)}  ${truncate(target.info?.title ?? '(untitled)', 60)}`;
      const protectedLine = guard
        ? `  受保护: ${guard.depth === 0 ? '[protected]' : `[protected-child depth=${guard.depth}]`} ${guard.sessionID}`
        : '';

      // R5: the same bid + the same reason inside the window is one escalation.
      const already =
        Number(record?.urgentAt) > 0 &&
        String(record?.urgentReason ?? '') === reason &&
        now - Number(record?.urgentAt) <= URGENT_WINDOW_MS;
      const urgentBody = `${URGENT_PREFIX} ${reason}${
        record ? `\n(bid ${record.bid}${record.threadID ? ` / thread ${record.threadID}` : ''})` : ''
      }`;

      // ------------------------------------------------------------ preview
      if (!confirmed) {
        const lines = [
          '未加急（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。',
          `目标: ${targetLine}`,
          protectedLine,
          scopeLine,
          `reason: ${reason}`,
          already
            ? `注: 该单在 ${fmtTime(record?.urgentAt)} 已因同一 reason 加急过（5 分钟窗口内）：确认后只刷新 urgentAt，不重复投递。`
            : '',
          guard
            ? `模式: 不投递（受保护目标只能排队）`
            : `模式: ${mode}${forced ? '(forced)' : ''}${mode === 'steer' ? '  （并入目标当前轮）' : ''}`,
          guard
            ? `将写入: ${queueDir(targetSid)}/${queueID(now)}.json（priority:"urgent"）`
            : `将投递: ${urgentBody}`,
          '注: 加急只在记录上追加 priority / urgentAt / urgentReason / urgentBy，不改 state / claim / receipt。'
        ];
        return { content: lines.filter(Boolean).join('\n') };
      }

      // ------------------------------------------------ R5: idempotent repeat
      if (already) {
        const refreshed = markUrgent(record, { at: now, reason, by: me });
        return {
          content: [
            `已加急过（5 分钟内同 bid + 同 reason）：只刷新 urgentAt，未重复投递。`,
            `目标: ${targetLine}`,
            protectedLine,
            scopeLine,
            `urgentAt: ${fmtTime(now)}  reason: ${reason}`,
            refreshed ? `注: 记录 ${refreshed.bid} 的 urgentAt 已刷新（state / claim / receipt 未变）。` : '',
            '确实要再催一次：换一处措辞（reason 不同即视为新加急），或等 5 分钟窗口过去。'
          ]
            .filter(Boolean)
            .join('\n')
        };
      }

      // ------------------------------------------------ protected → queue only
      if (guard) {
        const item = enqueue({
          target: targetSid,
          from: me,
          text: urgentBody,
          issuePath: record?.issuePath,
          bid: record?.bid,
          priority: 'urgent',
          now
        });
        const marked = markUrgent(record, { at: now, reason, by: me });
        return {
          content: [
            `受保护目标：未投递（0 条 prompt），已写入加急队列项 ${item.id}。`,
            `目标: ${targetLine}`,
            protectedLine,
            scopeLine,
            `摘要: ${item.summary}`,
            `canPush=false  队列位置: ${queuePosition(item.id, targetSid)}`,
            `文件: ${queueDir(item.target)}/${item.id}.json`,
            marked ? `记录: ${marked.bid} priority=urgent urgentAt=${fmtTime(now)}（state / claim / receipt 未变）。` : '',
            '注: 受保护会话及其子会话不接受任何投递（含 steer）；队列是 pull —— 对端下次运行会在自己的 context 注入里看到这一行。',
            record
              ? `下一步: 等其下一轮；位置用 collab_status { bid:"${record.bid}" } 查（撤回: collab_request_owner { id:"${item.id}", revoke:true, confirm:true }）`
              : `下一步: 等其下一轮；撤回: collab_request_owner { id:"${item.id}", revoke:true, confirm:true }`
          ]
            .filter(Boolean)
            .join('\n')
        };
      }

      // ------------------------------------------------- deliver (steer/queue)
      const cid = newCorrelationID();
      const admitted = await deliverUrgent({
        sessionID: targetSid,
        text: urgentBody,
        delivery: mode,
        metadata: {
          collab: {
            from: senderLabel(me),
            fromSessionID: me,
            cid,
            kind: 'note',
            threadID: record?.threadID,
            ts: now,
            urgent: true
          }
        }
      });
      // R3: what the host really did — `steer` on an idle target degrades to `queue`.
      const actual = String(admitted?.delivery ?? mode);
      const marked = markUrgent(record, { at: Date.now(), reason, by: me });
      const notes: string[] = [];
      if (forced) notes.push(`目标为只读 agent（${target.info?.agent ?? '?'}）：已强制 queue（forced），不打断对方当前轮。`);
      if (actual !== mode) notes.push(`宿主实际采用 ${actual}（目标空闲 / 被降级），本次未进入其当前轮。`);
      if (!record) notes.push('该会话没有关联的未闭环交接：只投递了加急说明，没有记录可标记。');

      return {
        content: [
          `已加急 → ${targetLine}`,
          protectedLine,
          scopeLine,
          `reason: ${reason}`,
          `mode=${mode}${forced ? '(forced)' : ''}  delivery=${actual}  message=${admitted?.id ?? '?'}`,
          marked ? `记录: ${marked.bid} priority=urgent urgentAt=${fmtTime(marked.urgentAt ?? now)}（state / claim / receipt 未变）。` : '',
          ...notes.map(note => `注: ${note}`),
          record
            ? `下一步: collab_status { bid:"${record.bid}" } 看 admitted / seen；超时再决定是否重复加急`
            : '下一步: 已直接投递到该会话；如需回执用 collab_send / collab_status 追踪对应交接单'
        ]
          .filter(Boolean)
          .join('\n')
      };
    }
  };
}
