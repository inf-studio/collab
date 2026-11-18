import { PROMOTE_AGENTS } from '../constants.ts';
import { grantFile, readGrant } from '../core/grants.ts';
import { invalid } from '../core/errors.ts';
import { createLineage } from '../core/lineage.ts';
import type { ToolDefinition } from '../types.ts';
import { fmtTime, truncate } from '../util.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/**
 * `collab_promote` — switch *one* session's agent (whitelisted `build`/`plan`)
 * after it has accepted a hand-off, with `revert:true` to restore the recorded
 * pre-promotion agent. The record shares the `collab_grant` ledger file.
 */
export function promoteTool(kit: ToolKit): ToolDefinition {
  const { deps, resolveTarget } = kit;
  const { ctx, readConfig, chain } = deps;

  return {
    name: 'collab_promote',
    description:
      "Switch *one* session's agent (`POST /api/session/{id}/agent`, i.e. `session.switchAgent`) so it can actually " +
      'change code — use it only after that session ACCEPTed a hand-off (collab_accept) and the work needs edits. A ' +
      'hand-off broadcast with expected:"review" must never be promoted: review needs no execution. Target agent ' +
      'defaults to build and is whitelisted to [build, plan]; explore stays the read-only default. The current agent ' +
      'is recorded in the same ledger as `collab_grant` (agentBefore / promotedAt / promotedBy, the permission half ' +
      'is preserved), and `revert:true` switches back to that original value and drops the record. Protected ' +
      'sessions and their descendants are refused. Requires confirm:true; otherwise it only previews target ' +
      '(id/agent/title/loc) and `原 agent → 目标 agent`.',
    input: jsonInput({
      properties: {
        target: { type: 'string', description: 'Session id (`ses_…`) or an alias.' },
        agent: {
          type: 'string',
          enum: PROMOTE_AGENTS,
          description: 'Agent to switch to (default build). Anything outside [build, plan] is refused.'
        },
        revert: {
          type: 'boolean',
          description: 'Switch back to the recorded pre-promotion agent and remove that record.'
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to switch the agent. false or omitted only previews.'
        }
      },
      required: ['target', 'confirm']
    }),
    async execute(input, context) {
      const config = readConfig();
      const { sessionID, alias, info } = await resolveTarget(input?.target);
      const guard = await createLineage(ctx).protectedAncestor(sessionID, config.protect);
      if (guard) {
        const where = guard.depth === 0 ? '本身' : `的祖先（第 ${guard.depth} 级）${guard.sessionID} `;
        throw invalid(
          `拒绝切换 agent：目标 ${sessionID}${alias ? `（别名 ${alias}）` : ''} ${where}在 protect 名单内` +
            '（覆盖其任意层级子会话）。未修改任何会话。'
        );
      }

      const me = context?.sessionID;
      const agent = String(input?.agent ?? 'build').trim() || 'build';
      const revoke = input?.revert === true;
      // Fail-closed input validation (the JSON schema enum does not protect a
      // direct caller, and a wrong agent id would come back as a 404 later).
      if (!revoke && !PROMOTE_AGENTS.includes(agent)) {
        throw invalid(
          `拒绝切换：agent="${agent}" 不在白名单（只允许 ${PROMOTE_AGENTS.join(' / ')}）。未修改任何会话。`
        );
      }
      const loc = info?.location?.directory ?? '(unknown)';
      const current = String(info?.agent ?? '(unknown)');
      const targetLine =
        `目标: ${sessionID}${alias ? ` (alias=${alias})` : ''}  agent=${current}  ` +
        `loc=${loc}  title="${truncate(info?.title ?? '(untitled)', 60)}"`;
      const grantPath = grantFile(sessionID);
      const record = readGrant(sessionID);

      if (input?.confirm !== true) {
        if (revoke) {
          return {
            content: [
              '未还原（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true + revert:true。',
              targetLine,
              record?.agentBefore
                ? `将切回原 agent: ${current} → ${record.agentBefore}` +
                  `（记录 promotedAt=${fmtTime(record.promotedAt)} by=${record.promotedBy || '-'} → ${grantPath}）`
                : `promote 记录: 无（${grantPath} 里没有 agentBefore）→ 确认后会报「无可还原」`,
              '注: 只还原 agent，不影响同一记录里的 permissions 快照。'
            ].join('\n')
          };
        }
        return {
          content: [
            '未切换（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。',
            targetLine,
            `原 agent ${current} → 目标 agent ${agent}（白名单 ${PROMOTE_AGENTS.join(' / ')}）`,
            `记录: ${grantPath}（agentBefore=${record?.agentBefore ?? current}，与 permissions 记录合并写、互不覆盖）`,
            '只在对端 collab_accept 领取且确需改代码时使用；expected:"review" 的交接永不 promote。',
            record?.agentBefore ? `已有记录: agentBefore=${record.agentBefore}（不会覆盖）` : ''
          ]
            .filter(Boolean)
            .join('\n')
        };
      }

      if (revoke) {
        const result = await chain.revertSessionAgent(sessionID);
        if (!result.ok) {
          return { content: [`未还原：${result.reason}`, targetLine].join('\n') };
        }
        return {
          content: [
            `已把 agent 切回原值: ${sessionID}`,
            targetLine,
            `还原: ${result.from} → ${result.restored}`,
            `复核(GET agent): ${result.verified}`,
            result.leftover
              ? `记录保留 permissions 半段（before=${result.leftover.before?.length ?? 0} 条）: ${grantPath}`
              : `promote 记录已删除: ${grantPath}`
          ].join('\n')
        };
      }

      const result = await chain.promoteSession(sessionID, { agent, by: me ?? '' });
      if (!result.ok) {
        // Never fatal: an existing hand-off keeps running; the peer just stays
        // read-only, so the requester must not expect code changes from it.
        return {
          content: [
            `未切换 agent（${result.phase}）: ${result.reason}`,
            targetLine,
            '已有交接不受影响；对端保持原 agent（若原为 explore 则仍只读，不能改代码）。'
          ].join('\n')
        };
      }
      return {
        content: [
          `已切换 agent: ${sessionID}（${result.from} → ${result.to}，changed=${result.changed}）`,
          targetLine,
          `复核(GET agent): ${result.verified}`,
          `记录: ${grantPath}（agentBefore=${result.agentBefore}，reason 半段与 permissions 记录共存）`,
          `还原: collab_promote {target:"${sessionID}", revert:true, confirm:true}`,
          '提醒: 只在对端 ACCEPT 且确需改代码时 promote；expected:"review" 的交接永不 promote。'
        ].join('\n')
      };
    }
  };
}
