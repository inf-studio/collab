import { invalid } from '../core/errors.ts';
import { isValidThreadID, normalizeThreadID } from '../ids.ts';
import type { ToolDefinition } from '../types.ts';
import { canReplyToProtected, jsonInput } from './shared.ts';
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
      'A protected counterpart is only reachable as the bounded receipt of the bid it broadcast and the caller ' +
      'claimed. Content de-duplication applies too: the same thread + the same body within `dedupeWindowMs` ' +
      '(default 60s, 0 disables) is one message, so a retyped reply is not delivered twice. ' +
      'Requires confirm:true; otherwise it only previews.',
    input: jsonInput({
      properties: {
        threadID: { type: 'string', description: 'Thread to answer (`t_…`), as received in the request.' },
        text: { type: 'string', description: 'Reply body (no prefix needed; it is added for you).' },
        bid: {
          type: 'string',
          description:
            'Bounded receipt only: the `b_…` hand-off this reply closes. Omit to let the body carry it ' +
            '(`[handoff] DONE b_… <summary>`).'
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to actually deliver. false/omitted only returns the preview.'
        }
      },
      required: ['threadID', 'text', 'confirm']
    }),
    async execute(input, context) {
      const threadID = normalizeThreadID(input?.threadID);
      if (!threadID) throw invalid('threadID 不能为空：回执必须带上原请求的 threadID');
      if (!isValidThreadID(threadID)) throw invalid(`threadID 格式不合法："${threadID}"`);

      const thread = await threads.read(threadID);
      if (!thread) {
        throw invalid(
          `storage 里没有 thread ${threadID}：无法确定对端。请改用 collab_send ` +
            `{target, kind:"reply", threadID:"${threadID}", text, confirm:true} 显式指定目标。`
        );
      }

      const me = context?.sessionID;
      const participants = [thread.fromSession, thread.toSession].filter(Boolean);
      const notes: string[] = [];
      if (me && !participants.includes(me)) {
        throw invalid(
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
        throw invalid(`thread ${threadID} 没有记录对端会话 id，无法自动回复；请用 collab_send 显式指定 target`);
      }

      const { mode, forced } = resolveMode('queue', context?.agent);
      const target = await resolveTarget(counterpart);
      // R2: this is a reply by definition; only the bid decides whether the
      // protect guard may be bypassed (that bid's requester + its claimant).
      const allowProtectedReply = Boolean(
        canReplyToProtected({
          kind: 'reply',
          target: target.sessionID,
          sender: me,
          bid: input?.bid,
          text: input?.text
        })
      );
      return dispatch({ context, input, kind: 'reply', threadID, mode, forced, notes, target, allowProtectedReply });
    }
  };
}
