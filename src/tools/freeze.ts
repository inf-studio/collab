/**
 * `collab_freeze` — the **temporary freeze mark** (0.6.0).
 *
 * A freeze is the collaboration layer's own brake: it says "do not start
 * anything new into this session / workspace / hand-off" until `until`, and it
 * says so to the tools, not just to a human reading a message.
 *
 * 0.8.0 (`board2-actions`): the orchestration moved to `core/actions.ts`
 * (`freezeAction`), shared with the board's `collab.state.freeze` /
 * `collab.state.unfreeze` (`freeze:false`). This file keeps the tool contract:
 *
 *   1. validates `scope` (`session` / `workspace` / `bid`) and `target`;
 *   2. `until` is a relative window (`"30m"`) or an absolute instant (ISO);
 *      default 30 minutes, capped at 30 days;
 *   3. writes the entry **read-merge-write** (`mergeFreezes`) and reports the
 *      *effective* list — two writers never drop each other's entries;
 *   4. delivers the notice: a non-protected target gets one `queue` prompt; a
 *      protected target — or a descendant of one — gets one
 *      `priority:"urgent"` owner-queue item instead (0 prompts);
 *   5. `freeze:false` removes the entry (idempotent no-op when missing);
 *   6. `confirm:false` is a zero-write preview.
 *
 * Deliberately **not** here: archiving, deleting, permissions, agent switches,
 * a scheduler. An expired freeze simply stops existing on the next read.
 */
import { freezeAction } from '../core/actions.ts';
import type { ActionContext } from '../core/actions.ts';
import type { FreezeEntry, ToolDefinition } from '../types.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

const SCOPES: FreezeEntry['scope'][] = ['session', 'workspace', 'bid'];

export function freezeTool(kit: ToolKit): ToolDefinition {
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
    name: 'collab_freeze',
    description:
      'Temporarily freeze a session / workspace / hand-off so no **new** collaboration can start into it: ' +
      'collab_handoff, collab_broadcast, collab_accept and collab_escalate refuse with a readable error until the ' +
      'freeze expires (or is lifted with freeze:false). Input is `{ scope:"session"|"workspace"|"bid", target?, ' +
      'reason, until?, freeze?:false, confirm }`: `target` is required for session/bid and defaults to the current ' +
      'workspace; `until` takes a relative window ("30m", "2h") or an absolute ISO instant (default 30 minutes, max ' +
      '30 days) and is enforced at read time — an expired freeze simply stops existing. The freeze file is ' +
      '`~/.config/opencode/collab-freeze.json` and every write is a read-merge-write, so concurrent writers keep ' +
      'each other\'s entries. A freeze is **not** an archive and not a delete: no session is hidden, no permission ' +
      'or agent is touched, and read commands (collab_list / collab_status) still work — they only mark [frozen]. ' +
      'The frozen target is notified once (a `queue` prompt, or one `priority:"urgent"` owner-queue item when the ' +
      'target is protected) and the frozen session sees a one-time notice in its own context. Requires confirm:true; ' +
      'otherwise a zero-write preview.',
    input: jsonInput({
      properties: {
        scope: {
          type: 'string',
          enum: SCOPES,
          description: 'session = one session (and its sub-sessions); workspace = every session of a directory; bid = one hand-off.'
        },
        target: {
          type: 'string',
          description:
            'Session id (`ses_…`) or alias / absolute workspace path / hand-off id (`b_…`). ' +
            'Omitted for scope:"workspace" = the current workspace.'
        },
        reason: {
          type: 'string',
          description: 'Why it is frozen (one line, ≤200 chars). Required when freezing.'
        },
        until: {
          type: 'string',
          description: 'Relative window ("30m", "2h", "45s") or an absolute instant ("2026-11-19T16:00:00+08:00"). Default 30 minutes.'
        },
        freeze: {
          type: 'boolean',
          description: 'false lifts the freeze for the same scope + target (idempotent). Default true.'
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to actually write. false/omitted only returns the preview (zero writes).'
        }
      },
      required: ['scope', 'confirm']
    }),
    async execute(input, context) {
      const result = await freezeAction(actions, {
        actor: context?.sessionID,
        scope: input?.scope,
        target: input?.target,
        reason: input?.reason,
        until: input?.until,
        freeze: input?.freeze,
        confirm: input?.confirm === true
      });
      return { content: result.content };
    }
  };
}
