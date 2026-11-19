import { BCAST_DONE_STATES, BCAST_LEASE_MS, BCAST_THRESHOLD, EXPECTED } from '../constants.ts';
import { persistRefresh, readBroadcast, writeBroadcast } from '../core/claim.ts';
import { invalid } from '../core/errors.ts';
import { freezeDenyText, freezeHintText, frozenBy } from '../core/freeze.ts';
import { createLineage } from '../core/lineage.ts';
import { broadcastID, extractPaths, normalizeExpected, summarizeProposal } from '../core/score.ts';
import { newThreadID } from '../ids.ts';
import type { JsonObject, ToolDefinition } from '../types.ts';
import { hash16, sessionState, truncate } from '../util.ts';
import { jsonInput } from './shared.ts';
import type { Target, ToolKit } from './shared.ts';

/**
 * `collab_handoff` — hand a task to another session of *this* workspace through
 * the existing thread protocol (local scope: `kind=request`, `mode=queue`,
 * reply with `collab_reply`). Without `target` the same 0–100 score as
 * `collab_broadcast` picks one candidate.
 */
export function handoffTool(kit: ToolKit): ToolDefinition {
  const { deps, resolveTarget, resolveMode, dispatch, capabilityNote } = kit;
  const { ctx, readConfig, chain } = deps;

  return {
    name: 'collab_handoff',
    description:
      'Hand a task to another session of *this* workspace (local scope) over the existing thread protocol: ' +
      'kind=request, mode=queue, reply with collab_reply. Without `target` the plugin picks one: a single ' +
      'available session is used directly, several are ranked with the same 0–100 score as collab_broadcast ' +
      '(threshold 80, `why` breakdown). Requires confirm:true; otherwise it only previews the choose/deliver plan.',
    input: jsonInput({
      properties: {
        target: {
          type: 'string',
          description: 'Session id (`ses_…`) or an alias. Omit to let the plugin pick.'
        },
        text: {
          type: 'string',
          description: 'Task body (no prefix needed). File paths in it drive the ranking.'
        },
        expected: {
          type: 'string',
          enum: EXPECTED,
          description:
            'implement (default) / review / research — the last one is read-only investigation + a conclusion; ' +
            'it drives the ranking and is written into the record.'
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to actually deliver. false or omitted only returns the preview.'
        }
      },
      required: ['text', 'confirm']
    }),
    async execute(input, context) {
      const me = context?.sessionID;
      const workspace = ctx?.location?.directory;
      const body = String(input?.text ?? '').trim();
      if (!body) throw invalid('text 不能为空');
      const expected = normalizeExpected(input?.expected);
      const notes: string[] = [];
      const lineage = createLineage(ctx);

      let target: Target;
      let ranking: Awaited<ReturnType<typeof chain.rankCandidates>> | undefined;
      if (input?.target) {
        target = await resolveTarget(input?.target);
      } else {
        if (!workspace) {
          throw invalid('缺少工作区信息（ctx.location.directory），无法自动选人；请显式传 target');
        }
        const proposal = summarizeProposal(body, `handoff-${hash16(body).slice(0, 8)}.md`);
        ranking = await chain.rankCandidates({
          workspace,
          proposal,
          expected,
          exclude: me ? [me] : []
        });
        const candidates = ranking.candidates;
        if (!candidates.length) {
          throw invalid(
            `本工作区没有可用候选（已排除子会话、[protected*] 与当前会话）：请显式传 target，` +
              `或改用 collab_broadcast 拉新。`
          );
        }
        const single = candidates.length === 1;
        const best = candidates[0];
        if (!single && best.score < BCAST_THRESHOLD) {
          throw invalid(
            `没有匹配分 ≥${BCAST_THRESHOLD} 的目标，未投递。候选：\n${candidates
              .slice(0, 5)
              .map(candidate => `  ${candidate.score}  ${candidate.sid} why=[${candidate.why.join(', ')}]`)
              .join('\n')}\n请显式传 target（或先补上下文再交接）。`
          );
        }
        target = { sessionID: best.sid, alias: undefined, info: best.info ?? { id: best.sid } };
        notes.push(
          single
            ? '目标会话唯一：直接投递（未走打分）。'
            : `多候选：按匹配分选中 ${best.sid}（score=${best.score}，why=[${best.why.join(', ')}]）。`
        );
      }

      const { mode, forced } = resolveMode('queue', context?.agent);
      // 0.6.0 (`collab_freeze`): a frozen target — itself, one of its ancestors,
      // or its workspace — refuses a *new* hand-off. Checked after the target is
      // known and before anything is delivered / written; a preview only says so.
      const freeze = await frozenBy(
        { session: target.sessionID, workspace: target.info?.location?.directory ?? workspace },
        { lineage }
      );
      if (freeze && input?.confirm === true) throw invalid(freezeDenyText(freeze));
      const threadID = newThreadID();
      const bid = broadcastID({
        scope: 'local',
        workspace,
        issuePath: `local/${target.sessionID}`,
        contentHash: hash16(body),
        mtimeMs: 0
      });

      // Idempotent: same target + same body is the same bid. Re-delivering
      // would queue the task twice and overwrite the record — which used to
      // resurrect a `done` hand-off and drop its receipt (S1).
      const previous = readBroadcast(bid);
      if (previous) {
        const record = persistRefresh(previous, await chain.refresh(previous, Date.now(), { actor: me }));
        const state = BCAST_DONE_STATES.includes(String(record.state))
          ? `已闭环（state=${record.state}）：${record.receipt?.note ?? '-'}。不重复投递、不改状态。`
          : `已存在同一交接（bid 幂等，不重复投递）：state=${record.state}，thread=${record.threadID ?? '-'}。` +
            `等结果用 collab_wait {threadID:"${record.threadID ?? '…'}"}。`;
        return {
          content: [
            state,
            `bid=${bid}  thread=${record.threadID ?? '-'}  承接=${record.claim?.by ?? '-'}`,
            `目标: ${target.sessionID}（local scope，回执用 collab_reply {threadID} 或 [handoff] DONE ${bid}）`
          ].join('\n')
        };
      }

      if (input?.confirm !== true) {
        const config = readConfig();
        const guard = await lineage.protectedAncestor(target.sessionID, config.protect);
        return {
          content: [
            '未投递（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。',
            `目标: ${target.sessionID} agent=${target.info?.agent ?? '?'} state=${sessionState(target.info)} ` +
              `title="${truncate(target.info?.title ?? '(untitled)', 60)}"`,
            guard ? `拒绝提示: 目标在 protect 名单内（depth=${guard.depth}），确认后仍会被拒绝。` : '',
            freeze ? `拒绝提示: ${freezeHintText(freeze)}` : '',
            `kind=request mode=${forced ? 'queue(forced)' : mode} thread=${threadID} bid=${bid}`,
            ...(capabilityNote(target.info?.agent, expected) ? [capabilityNote(target.info?.agent, expected)!] : []),
            ...notes.map(note => `注: ${note}`),
            ...(ranking
              ? [
                  `候选（阈值 ${BCAST_THRESHOLD}）:`,
                  ...ranking.candidates
                    .slice(0, 5)
                    .map(candidate => `  ${candidate.score}  ${candidate.sid} why=[${candidate.why.join(', ')}]`)
                ]
              : [])
          ]
            .filter(Boolean)
            .join('\n')
        };
      }

      const delivered = await dispatch({
        context,
        input: { text: body, confirm: true },
        kind: 'request',
        threadID,
        mode,
        forced,
        notes,
        target
      });
      // R4 (0.1.6): a protected requester can never receive a pushed ack (the
      // same guard refuses the delivery), so the record says so up front.
      const requesterProtected = Boolean(
        me && (await lineage.protectedAncestor(String(me), readConfig().protect))
      );
      writeBroadcast({
        bid,
        scope: 'local',
        workspace,
        issuePath: undefined,
        threadID,
        title: truncate(body.split('\n')[0] ?? body, 120),
        expected,
        affectedFiles: extractPaths(body),
        candidates: ranking ? ranking.candidates.slice(0, 10).map(({ sid, score, why }) => ({ sid, score, why })) : [],
        state: 'acked',
        claim: {
          by: target.sessionID,
          kind: 'handoff',
          token: `h_${bid.slice(2, 10)}`,
          at: Date.now(),
          leaseMs: BCAST_LEASE_MS
        },
        attempts: 0,
        skipped: [],
        seenBy: [],
        reminded: [],
        replies: [],
        from: { sid: me, directory: workspace },
        // R1 (0.1.6): the admission receipt of the very prompt `dispatch` sent —
        // the receiving plugin acks this `cid` from its inbox/context.
        delivery: delivered.delivery
          ? { ...delivered.delivery, ...(requesterProtected ? { ackUnavailable: true } : {}) }
          : undefined,
        createdAt: Date.now()
      } satisfies JsonObject);

      return {
        content: [
          delivered.content,
          `bid=${bid}  thread=${threadID}（local scope，回执用 collab_reply {threadID}）`,
          ...(capabilityNote(target.info?.agent, expected) ? [capabilityNote(target.info?.agent, expected)!] : []),
          `等结果: collab_wait {threadID:"${threadID}", timeoutMs:…}`
        ].join('\n')
      };
    }
  };
}
