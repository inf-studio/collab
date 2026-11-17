import { INBOX_TEXT_LIMIT, MAX_STORED } from '../constants.ts';
import { messageIDs } from '../core/messages.ts';
import { normalizeKind, normalizeThreadID } from '../ids.ts';
import type { ToolDefinition } from '../types.ts';
import { clamp, fmtTime, truncateRaw } from '../util.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/**
 * `collab_inbox` — the authoritative read of this session's cross-session
 * messages. Read-only: it never advances the cursor, so the injected summary can
 * stay short without losing the full body.
 */
export function inboxTool(kit: ToolKit): ToolDefinition {
  const { deps } = kit;
  const { inbox, threads } = deps;

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
          thread ? `status=${thread.status}` : ''
        ].filter(Boolean);
        lines.push(
          `${fmtTime(message.ts)}  [${normalizeKind(message.kind)}] thread=${threadID ?? '-'}  ` +
            `from=${message.from} (${message.fromSession})  ${flags.join(' ')}\n` +
            `    ${truncateRaw(message.text, INBOX_TEXT_LIMIT)}`
        );
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
