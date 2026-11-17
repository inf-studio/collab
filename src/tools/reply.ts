import { isValidThreadID, normalizeThreadID } from '../ids.ts';
import type { ToolDefinition } from '../types.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/**
 * `collab_reply` — sugar for `collab_send {kind:"reply", threadID}` with the
 * counterpart resolved from storage, so the receiver never has to look up a
 * `ses_…` id to answer. Always `queue`: a reply must not interrupt the
 * requester's running turn.
 */
export function replyTool(kit: ToolKit): ToolDefinition {
  const { deps, resolveTarget, resolveMode, dispatch } = kit;
  const { threads } = deps;

  return {
    name: 'collab_reply',
    description:
      'Reply on an existing hand-off thread: sugar for collab_send {kind:"reply", threadID} against the ' +
      "thread's counterpart (resolved from storage, so no target is needed). Only a participant of the thread " +
      "may reply. Always delivered with mode=queue, so it never interrupts the requester's running turn. " +
      'Requires confirm:true; otherwise it only previews.',
    input: jsonInput({
      properties: {
        threadID: { type: 'string', description: 'Thread to answer (`t_…`), as received in the request.' },
        text: { type: 'string', description: 'Reply body (no prefix needed; it is added for you).' },
        confirm: {
          type: 'boolean',
          description: 'Must be true to actually deliver. false/omitted only returns the preview.'
        }
      },
      required: ['threadID', 'text', 'confirm']
    }),
    async execute(input, context) {
      const threadID = normalizeThreadID(input?.threadID);
      if (!threadID) throw new Error('threadID 不能为空：回执必须带上原请求的 threadID');
      if (!isValidThreadID(threadID)) throw new Error(`threadID 格式不合法："${threadID}"`);

      const thread = await threads.read(threadID);
      if (!thread) {
        throw new Error(
          `storage 里没有 thread ${threadID}：无法确定对端。请改用 collab_send ` +
            `{target, kind:"reply", threadID:"${threadID}", text, confirm:true} 显式指定目标。`
        );
      }

      const me = context?.sessionID;
      const participants = [thread.fromSession, thread.toSession].filter(Boolean);
      const notes: string[] = [];
      if (me && !participants.includes(me)) {
        throw new Error(
          `拒绝回执：当前会话 ${me} 不是 thread ${threadID} 的参与方` +
            `（发起方 ${thread.fromSession ?? '?'}，对端 ${thread.toSession ?? '?'}）。未发送任何内容。`
        );
      }
      if (!me) notes.push('无会话上下文（无 sessionID）：未校验参与者身份。');

      const counterpart = me
        ? thread.fromSession === me
          ? thread.toSession
          : thread.fromSession
        : (thread.fromSession ?? thread.toSession);
      if (!counterpart) {
        throw new Error(`thread ${threadID} 没有记录对端会话 id，无法自动回复；请用 collab_send 显式指定 target`);
      }

      const { mode, forced } = resolveMode('queue', context?.agent);
      const target = await resolveTarget(counterpart);
      return dispatch({ context, input, kind: 'reply', threadID, mode, forced, notes, target });
    }
  };
}
