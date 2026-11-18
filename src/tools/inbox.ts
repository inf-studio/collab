import { INBOX_TEXT_LIMIT, MAX_STORED } from '../constants.ts';
import { isAckText } from '../core/ack.ts';
import { messageIDs } from '../core/messages.ts';
import { normalizeKind, normalizeThreadID } from '../ids.ts';
import type { ToolDefinition } from '../types.ts';
import { clamp, fmtTime, truncateRaw } from '../util.ts';
import { log } from '../log.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/**
 * `collab_inbox` — the authoritative read of this session's cross-session
 * messages. Read-only: it never advances the cursor, so the injected summary can
 * stay short without losing the full body.
 *
 * R1 (0.1.6): reading a message **is** seeing it — the hand-off cid of every
 * returned message is acked on a side path (best-effort). `[ack]` notes are
 * shown as `system-ack` (machine traffic, never a message to act on).
 */
export function inboxTool(kit: ToolKit): ToolDefinition {
  const { deps } = kit;
  const { inbox, threads, chain } = deps;

  return {
    name: 'collab_inbox',
    description:
      "Read this session's cross-session messages in full: kind (request/reply/note), threadID, thread status " +
      '(open/answered/closed) and sender. Bodies are returned verbatim up to 4000 characters per message. ' +
      'Read-only — it never advances any cursor, so it stays usable as the authoritative view even when the ' +
      'injected summary is short.',
    input: jsonInput({
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of messages to return (default 10, max 50).'
        }
      },
      required: []
    }),
    async execute(input, context) {
      const sessionID = context?.sessionID;
      if (!sessionID) return { content: '无法确定当前会话 id（缺少工具上下文）。' };

      const box = await inbox.read(sessionID);
      if (!box.messages.length) return { content: '[collab] 本会话还没有任何跨会话消息。' };

      const limit = clamp(input?.limit ?? 10, 1, MAX_STORED);
      const shown = box.messages.slice(-limit);
      const offset = box.messages.length - shown.length;
      const injected = new Set(box.injected);

      const lines: string[] = [];
      for (const [index, message] of shown.entries()) {
        const threadID = normalizeThreadID(message.threadID);
        const thread = threadID ? await threads.read(threadID) : undefined;
        const flags = [
          offset + index >= box.cursor ? 'new' : 'seen',
          messageIDs(message).some(id => injected.has(id)) ? 'injected' : '',
          isAckText(message.text) ? 'system-ack' : '',
          thread ? `status=${thread.status}` : ''
        ].filter(Boolean);
        lines.push(
          `${fmtTime(message.ts)}  [${normalizeKind(message.kind)}] thread=${threadID ?? '-'}  ` +
            `from=${message.from} (${message.fromSession})  ${flags.join(' ')}\n` +
            `    ${truncateRaw(message.text, INBOX_TEXT_LIMIT)}`
        );
      }

      // R1 (0.1.6): this session has now read these messages in full — ack the
      // hand-off deliveries among them (once per cid, best-effort).
      const cids = shown
        .filter(message => Boolean(message.cid) && !isAckText(message.text))
        .map(message => String(message.cid));
      if (cids.length) {
        await chain
          .ackSeen(sessionID, cids)
          .catch(error => log('ack failed:', (error as Error)?.message ?? error));
      }

      const unread = Math.max(0, box.messages.length - box.cursor);
      return {
        content: [
          `[collab] 共 ${box.size} 条，未读 ${unread} 条（显示最近 ${shown.length} 条，单条上限 ${INBOX_TEXT_LIMIT} 字）:`,
          ...lines,
          '回执用 collab_reply {threadID}；等结果用 collab_wait {threadID}；无 thread 的 legacy 消息无需回执。'
        ].join('\n')
      };
    }
  };
}
