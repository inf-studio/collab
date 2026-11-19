/**
 * `collab_archive` (0.5.0) — the **manual** half of the archive feature.
 *
 * `session.update({ archived:true })` is a hide, not a delete: the session and
 * every message stay, `restore:true` calls `archived:false`, and the bid record
 * keeps its `state` / `receipt` (only `archivedAt` is written / cleared). The
 * automatic path (`chain.refresh` + `shouldArchive`) refuses to touch a session
 * that is protected, busy, still referenced or younger than the grace window;
 * this tool deliberately ignores those gates — a human asking for it is the
 * decision — but it still refuses `[protected*]` (the one-way hard boundary is
 * not negotiable, same as `collab_grant` / `collab_promote`).
 *
 * 0.8.0 (`board2-actions`): the orchestration moved to `core/actions.ts`
 * (`archiveAction`), shared with the board's `collab.state.archive`. This file
 * keeps the tool contract (description + schema + `confirm` wiring).
 */
import { archiveAction } from '../core/actions.ts';
import type { ActionContext } from '../core/actions.ts';
import type { ToolDefinition } from '../types.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

export function archiveTool(kit: ToolKit): ToolDefinition {
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
    name: 'collab_archive',
    description:
      'Archive (or restore) the session a hand-off spawned — **archive is not delete**: the session and all of ' +
      'its messages are kept, `restore:true` sets archived:false, and the bid record keeps its state/receipt ' +
      '(only archivedAt is stamped). Spawned sessions are archived automatically once the hand-off is ' +
      'done/blocked/expired for the grace window (archiveGraceMs, default 10min), the target is idle, nothing ' +
      'references it and it has no unread owner-queue item; this tool is the manual form and skips those gates. ' +
      '`bid` resolves the session this plugin spawned for that hand-off (`claim.by`, or the orphan kept in ' +
      '`expiredClaim` when the spawn lease lapsed first); `session` names any session directly. ' +
      '`[protected*]` targets are refused. ' +
      '`confirm:false` only previews — nothing is written.',
    input: jsonInput({
      properties: {
        bid: {
          type: 'string',
          description: 'Hand-off id (`b_…`): archive the session this plugin spawned for it (claim.by / expiredClaim.by).'
        },
        session: {
          type: 'string',
          description: 'Session id (`ses_…`) to archive / restore directly. Omit when using `bid`.'
        },
        restore: {
          type: 'boolean',
          description: 'true = un-archive (`archived:false`) and clear archivedAt. Default false (archive).'
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to write. false / omitted only previews the target and the action.'
        }
      },
      required: []
    }),
    async execute(input, context) {
      const result = await archiveAction(actions, {
        actor: context?.sessionID,
        bid: input?.bid,
        session: input?.session,
        restore: input?.restore,
        confirm: input?.confirm === true
      });
      return { content: result.content };
    }
  };
}
