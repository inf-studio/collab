import { isValidThreadID, normalizeThreadID } from '../ids.ts';
import type { ToolDefinition } from '../types.ts';
import { clamp, withTimeout } from '../util.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/**
 * `collab_wait` — either wait for a thread reply (`threadID`) or for a target
 * session's agent loop to go idle (`target`). Read-only: sends nothing and never
 * interrupts anyone.
 */
export function waitTool(kit: ToolKit): ToolDefinition {
  const { deps, resolveTarget, waitForReply } = kit;
  const { ctx } = deps;

  return {
    name: 'collab_wait',
    description:
      'Wait for a hand-off result. With threadID: wait until that thread has a kind="reply" message from the ' +
      'other side *after its last request*, then return its full text (only a participant may wait; a malformed ' +
      "or unknown threadID fails immediately). Without threadID (target given): wait until the target session's " +
      'agent loop becomes idle. Read-only — sends no message and never interrupts anyone.',
    input: jsonInput({
      properties: {
        threadID: {
          type: 'string',
          description: 'Thread to wait on (`t_…`): returns once a reply exists.'
        },
        target: {
          type: 'string',
          description: 'Session id (`ses_…`) or an alias; used only for the idle mode.'
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds (default 120000, min 1000, max 1800000).'
        }
      },
      required: []
    }),
    async execute(input, context) {
      const timeoutMs = clamp(input?.timeoutMs ?? 120000, 1000, 1800000);
      const threadID = normalizeThreadID(input?.threadID);
      if (input?.threadID && !threadID) {
        throw new Error(`threadID 格式不合法："${String(input.threadID)}"（期望 t_<base36ts>_<rand>）`);
      }
      if (threadID) {
        if (!isValidThreadID(threadID)) {
          throw new Error(
            `threadID 格式不合法："${threadID}"（期望 t_<base36ts>_<rand>，从 collab_inbox 或请求正文里取）`
          );
        }
        return waitForReply(threadID, timeoutMs, context);
      }
      if (!input?.target) {
        throw new Error('collab_wait 需要 threadID（等回执）或 target（等空闲）之一');
      }

      const { sessionID, alias, info } = await resolveTarget(input?.target);
      const label = `${sessionID}${alias ? ` (alias=${alias})` : ''} agent=${info?.agent ?? '?'}`;
      const started = Date.now();

      try {
        await withTimeout(
          ctx.session.wait({ sessionID }),
          timeoutMs,
          `等待超时：${label} 在 ${timeoutMs}ms 内没有进入空闲状态（可加大 timeoutMs 或先 collab_inbox）`
        );
      } catch (error) {
        throw new Error(`collab_wait 失败：${(error as Error)?.message ?? error}`, { cause: error });
      }

      return { content: `目标已空闲：${label}（耗时 ${Date.now() - started}ms）` };
    }
  };
}
