/**
 * `collab_escalate` — the **urgent** path: put a hand-off in front of the right
 * session *now* (0.6.0).
 *
 * Why a tool and not a new mechanism: OpenCode's prompt API already accepts
 * `delivery: "queue" | "steer"` — the desktop "引导" button is `steer` — and
 * `SessionPromptResult.delivery` reports what the host actually did.
 *
 * 0.8.0 (`board2-actions`): the orchestration moved to `core/actions.ts`
 * (`escalateAction`) so the desktop board's `collab.state.escalate` runs **the
 * same** code instead of a second rule set. What is left here is the tool
 * contract — the description, the JSON schema and the `Actor`/`confirm` wiring:
 *
 *   - a **normal** target gets one `[URGENT]` prompt, default `delivery:steer`
 *     (explicit `mode:"queue"` queues it); a read-only agent (`explore` /
 *     `plan`) is **forced** back to `queue` and the receipt says `forced`;
 *   - a **protected** target (`BUILTIN_PROTECT` / lineage) is never pushed to:
 *     the escalation becomes one `priority:"urgent"` owner-queue item;
 *   - the hand-off record only gains the four annotation fields
 *     (`priority` / `urgentAt` / `urgentReason` / `urgentBy`) via
 *     read-merge-write. `state` / `claim` / `receipt` are never touched;
 *   - the same `bid` + the same `reason` within 5 minutes is one escalation.
 */
import { escalateAction } from '../core/actions.ts';
import type { ActionContext } from '../core/actions.ts';
import type { ToolDefinition } from '../types.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

export { URGENT_PREFIX, sanitizeReason } from '../core/actions.ts';

/**
 * `collab_escalate { bid? | threadID? | session?, reason, mode?, confirm }`.
 * Exactly one of the three target forms; `reason` is required; `confirm:true`
 * performs the escalation (otherwise a zero-write preview).
 */
export function escalateTool(kit: ToolKit): ToolDefinition {
  const { deps, resolveTarget, resolveMode, senderLabel } = kit;
  const { ctx, readConfig, chain } = deps;
  const actions: ActionContext = {
    ctx,
    readConfig,
    resolveTarget,
    resolveMode,
    senderLabel,
    listSessions: input => chain.listSessions(input)
  };

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
      const result = await escalateAction(actions, {
        actor: context?.sessionID,
        bid: input?.bid,
        threadID: input?.threadID,
        session: input?.session,
        reason: input?.reason,
        mode: input?.mode,
        confirm: input?.confirm === true
      });
      return { content: result.content };
    }
  };
}
