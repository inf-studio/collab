import { OWNER_QUEUE_DIR, OWNER_QUEUE_LIST_CHARS, OWNER_QUEUE_LIMIT } from '../constants.ts';
import { invalid } from '../core/errors.ts';
import { createLineage } from '../core/lineage.ts';
import {
  enqueue,
  listFor,
  mineFor,
  queueDir,
  queueID,
  revoke,
  sanitizeSummary,
  validateQueueIssuePath
} from '../core/owner-queue.ts';
import type { OwnerQueueItem, ToolDefinition } from '../types.ts';
import { fmtTime, sessionState, shortID, truncate } from '../util.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/** `- <qid> → <target short>  <HH:MM>  "<summary>"` — shared by list + tool. */
export function queueItemLine(item: OwnerQueueItem): string {
  return (
    `- ${item.id} → ${shortID(item.target)}  ${fmtTime(item.at).slice(0, 5)}  ` +
    `"${truncate(item.summary, OWNER_QUEUE_LIST_CHARS)}"${item.priority === 'urgent' ? ' · [urgent]' : ''}${
      item.seenAt ? ' · 已读' : ''
    }`
  );
}

/**
 * `collab_request_owner` — the **pull** channel into a protected session (D1).
 *
 * It writes one JSON file into `OWNER_QUEUE_DIR/<targetSid>/` and nothing else:
 * no `session.prompt`, no inbox entry, no broadcast record, no bid, no thread.
 * The target only ever sees 1–3 read-only lines in its own `context` injection
 * (see `core/owner-queue.ts` and `hooks/context.ts`), each exactly once.
 *
 * Direction is one-way by construction: a non-protected session may queue for a
 * `[protected]` / `[protected-child]` target; a protected session may not queue
 * at all (protected → protected is refused too), and an ordinary target is
 * refused with a pointer to `collab_handoff` (a queue item there would be a
 * silent message nobody is obliged to read).
 */
export function requestOwnerTool(kit: ToolKit): ToolDefinition {
  const { deps, resolveTarget, senderLabel } = kit;
  const { ctx, readConfig } = deps;

  return {
    name: 'collab_request_owner',
    description:
      'Queue a request for a **protected** session ([protected] / [protected-child], e.g. the schema line). ' +
      'This is a pull channel, not a delivery: it writes one JSON item into ' +
      '~/.config/opencode/collab-owner-queue/<targetSid>/ and sends no prompt, creates no bid/thread, changes no ' +
      'collaboration state. The protected session sees 1–3 read-only lines in its own context injection (each only ' +
      'once, no reply required; one line per proposal — hints sharing a bid **or** an issuePath are merged, ' +
      'transitively, newest wins). Only a non-protected session may queue, and only for a protected ' +
      'target — for an ordinary session use collab_handoff instead; note that the broadcast candidate pool ' +
      '**excludes** `[protected*]` sessions, so this tool (or the protected session pulling the proposal/hints ' +
      'itself) is the only way to reach one. At most 50 unread items per target (a full queue refuses a new ' +
      'one; items the owner already read do not count and are swept after 7 days). ' +
      '`revoke:true` deletes one of my own pending items. ' +
      'Requires confirm:true; otherwise it only previews (zero writes).',
    input: jsonInput({
      properties: {
        target: {
          type: 'string',
          description: 'Protected target: session id (`ses_…`) or an alias. Required unless `revoke:true` with `id`.'
        },
        text: {
          type: 'string',
          description: 'What the owner should look at, in one paragraph (≤500 chars, control characters stripped).'
        },
        issuePath: {
          type: 'string',
          description: 'Optional proposal path, `docs/issues/<name>.md` (relative; syntax-checked only, no fs read).'
        },
        bid: {
          type: 'string',
          description: 'Optional bid this request is about (display only; no record is created or changed).'
        },
        id: {
          type: 'string',
          description: 'Queue item id (`q_…`) — only for `revoke:true`.'
        },
        revoke: {
          type: 'boolean',
          description: 'Withdraw one of my own pending items (`id` + confirm:true).'
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to write / delete. false or omitted only previews (zero writes).'
        }
      },
      required: []
    }),
    async execute(input, context) {
      const me = context?.sessionID;
      if (!me) throw invalid('缺少会话上下文（sessionID）：队列项必须记录发起方，否则无法撤回/追溯。');
      const config = readConfig();
      const lineage = createLineage(ctx);
      const confirmed = input?.confirm === true;

      // ------------------------------------------------------------ revoke
      if (input?.revoke === true) {
        const rawID = String(input?.id ?? '').trim();
        if (!rawID) throw invalid('revoke:true 时需要 id（`q_…`，见 collab_list 的我提交给受保护会话的请求）');
        const explicitTarget = String(input?.target ?? '').trim();
        let targetSid: string | undefined;
        let item: OwnerQueueItem | undefined;
        if (explicitTarget) {
          const target = await resolveTarget(explicitTarget);
          targetSid = target.sessionID;
          item = listFor(targetSid).find(entry => entry.id === rawID);
        } else {
          item = mineFor(me).find(entry => entry.id === rawID);
          targetSid = item?.target;
        }
        if (!item || !targetSid) {
          throw invalid(`没有队列项 ${rawID}（可能已撤回 / 目标不匹配）。用 collab_list 看自己提交的待处理列表。`);
        }
        if (item.from !== me) {
          throw invalid(`拒绝撤回：队列项 ${item.id} 是 ${shortID(item.from)} 提交的，只有发起方能撤回。未删除任何内容。`);
        }
        if (!confirmed) {
          return {
            content: [
              '未撤回（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。',
              `队列项: ${item.id}  目标=${shortID(item.target)}  ${fmtTime(item.at).slice(0, 5)}  "${truncate(item.summary, OWNER_QUEUE_LIST_CHARS)}"`,
              `将删除: ${queueDir(item.target)}/${item.id}.json`,
              '注: confirm:false 零写入；该目标下一次注入不会再看到这一条。'
            ].join('\n')
          };
        }
        const removed = revoke(targetSid, rawID, me);
        if (!removed) throw invalid(`撤回失败：队列项 ${rawID} 已不存在（可能被并发删除）。`);
        return {
          content: [
            `已撤回队列项 ${removed.id}（目标 ${shortID(removed.target)}）。`,
            '该目标之后的注入不会再出现这一条（已注入过的行无法收回）。',
            `我提交给受保护会话的待处理: ${mineFor(me).length} 条`
          ].join('\n')
        };
      }

      // ----------------------------------------------------------- enqueue
      const rawTarget = String(input?.target ?? '').trim();
      if (!rawTarget) {
        throw invalid(
          'target 不能为空：请给受保护会话（ses_… 或别名）。普通会话请改用 collab_handoff（队列只服务受保护目标）。'
        );
      }
      const body = String(input?.text ?? '').trim();
      if (!body) throw invalid('text 不能为空：用一句话说明要 owner 看什么（≤500 字，会去掉控制字符）');
      const summary = sanitizeSummary(body);
      if (!summary) throw invalid('text 清洗后为空：请给出可读的请求正文');

      let issuePath: string | null = null;
      if (input?.issuePath !== undefined && input?.issuePath !== null && String(input.issuePath).trim() !== '') {
        const check = validateQueueIssuePath(input.issuePath);
        if (!check.ok) throw invalid(check.reason);
        issuePath = check.issuePath;
      }

      // Direction: the initiator must not be protected (no protected → protected
      // forwarding: a queue item must stay traceable to a session that owns the ask).
      const initiator = await lineage.protectedAncestor(String(me), config.protect);
      if (initiator) {
        throw invalid(
          `拒绝写入队列：发起方 ${me}${initiator.depth > 0 ? `（第 ${initiator.depth} 级祖先受保护）` : ''} 在 protect 名单内。` +
            '受保护会话不能向另一个受保护会话投队列项（不做 protected → protected 转发）。未写入任何内容。'
        );
      }

      const target = await resolveTarget(rawTarget);
      const guard = await lineage.protectedAncestor(target.sessionID, config.protect);
      if (!guard) {
        throw invalid(
          `拒绝写入队列：目标 ${target.sessionID} 不在 protect 名单内。` +
            '队列只服务 [protected] / [protected-child]；普通会话请用 collab_handoff { target, text, confirm:true }。' +
            '未写入任何内容。'
        );
      }

      const existing = listFor(target.sessionID);
      const unread = existing.filter(item => !item.seenAt).length;
      const read = existing.length - unread;
      const full = unread >= OWNER_QUEUE_LIMIT;
      const plannedID = queueID();
      const targetLine =
        `${target.sessionID}${target.alias ? ` (alias=${target.alias})` : ''}  agent=${target.info?.agent ?? '?'}  ` +
        `state=${sessionState(target.info)}  ${guard.depth === 0 ? '[protected]' : `[protected-child depth=${guard.depth}]`}  ` +
        `title="${truncate(target.info?.title ?? '(untitled)', 60)}"`;

      if (!confirmed) {
        return {
          content: [
            '未写入（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true；即使确认也不会投递。',
            `目标: ${targetLine}`,
            `队列项: ${plannedID}（预览 id 不会占用，确认后重新生成）`,
            `摘要: ${summary}`,
            `提案: ${issuePath ?? '-'}`,
            `将写入: ${queueDir(target.sessionID)}/${plannedID}.json`,
            `当前未读: ${unread} 条${read ? `（另有 ${read} 条已读到）` : ''}` +
              `（每目标上限 ${OWNER_QUEUE_LIMIT} 条未读，满则拒新；已读项 7 天后回收）${full ? '——已满，确认会被拒绝' : ''}`,
            '注: 只写队列文件：不投递、不唤醒、不建 bid/thread、不改任何协作状态（0 条 prompt）。',
            '注: 对端只会在它自己的 context 注入里看到一行只读提示（每条只提示一次，不含指令）。'
          ].join('\n')
        };
      }

      const item = enqueue({
        target: target.sessionID,
        from: me,
        text: body,
        issuePath,
        bid: input?.bid
      });
      const pending = listFor(target.sessionID).filter(entry => !entry.seenAt).length;
      return {
        content: [
          `已写入受保护会话请求队列：${item.id}`,
          `目标: ${targetLine}`,
          `摘要: ${item.summary}`,
          `提案: ${item.issuePath ?? '-'}`,
          `来自: ${senderLabel(me)}  文件: ${queueDir(item.target)}/${item.id}.json`,
          `未读: ${pending} 条（上限 ${OWNER_QUEUE_LIMIT} 条未读）`,
          '零投递：0 条 prompt；不建 bid/thread、不改任何协作状态（队列是 pull，不是送达通道）。',
          '对方下次运行会在自己的 context 注入里看到一行只读提示（每条只提示一次，不要求回复）。',
          `撤回: collab_request_owner { id:"${item.id}", revoke:true, confirm:true }`,
          `队列目录: ${OWNER_QUEUE_DIR}`
        ].join('\n')
      };
    }
  };
}
