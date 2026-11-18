import { COLLAB_RULE_RESOURCE, COLLAB_TOOL_ACTIONS } from '../constants.ts';
import { collabPermissionRules, grantFile, grantHalfOf, missingRules, readGrant } from '../core/grants.ts';
import { invalid } from '../core/errors.ts';
import { createLineage } from '../core/lineage.ts';
import type { PermissionRule, ToolDefinition } from '../types.ts';
import { fmtTime, truncate } from '../util.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/**
 * `collab_grant` — add the five `collab_*` allow rules to *one* session's own
 * permission ruleset (whole-set PATCH with a recorded pre-grant snapshot), and
 * `revoke:true` to restore that snapshot.
 */
export function grantTool(kit: ToolKit): ToolDefinition {
  const { deps, resolveTarget } = kit;
  const { ctx, readConfig, chain } = deps;

  return {
    name: 'collab_grant',
    description:
      "Add the five collab_* allow rules (collab_list/inbox/wait/reply/send) to *one* session's own permission " +
      'ruleset with a session-level PATCH — the project-level `agents.*.permissions` of another workspace does not ' +
      'apply to its sessions, so a spawned peer `explore` otherwise cannot accept or send a receipt. Merges with the ' +
      'existing ruleset (nothing is dropped, order and precedence of existing rules kept) and grants no capability ' +
      'beyond those five actions: edit/write/shell are never added. Idempotent; the pre-grant ruleset is recorded ' +
      'under ~/.config/opencode/collab-grants/<sid>.json. `revoke:true` restores that snapshot and drops the record. ' +
      'Protected sessions and their descendants are refused. Requires confirm:true; otherwise it only previews ' +
      'target (id/agent/title/loc) and the rules that would be added or restored.',
    input: jsonInput({
      properties: {
        target: { type: 'string', description: 'Session id (`ses_…`) or an alias.' },
        revoke: {
          type: 'boolean',
          description: 'Restore the recorded pre-grant ruleset for this session and remove the record.'
        },
        confirm: {
          type: 'boolean',
          description: "Must be true to PATCH the session's permissions. false or omitted only previews."
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
          `拒绝授权：目标 ${sessionID}${alias ? `（别名 ${alias}）` : ''} ${where}在 protect 名单内` +
            '（覆盖其任意层级子会话）。未修改任何 permissions。'
        );
      }

      const me = context?.sessionID;
      const revoke = input?.revoke === true;
      const loc = info?.location?.directory ?? '(unknown)';
      const targetLine =
        `目标: ${sessionID}${alias ? ` (alias=${alias})` : ''}  agent=${info?.agent ?? '?'}  ` +
        `loc=${loc}  title="${truncate(info?.title ?? '(untitled)', 60)}"`;
      const fmtRules = (rules: PermissionRule[]): string =>
        rules.length
          ? rules
              .slice(0, 10)
              .map(rule => `${rule.action}:${rule.resource}=${rule.effect}`)
              .join(', ') + (rules.length > 10 ? ` …(+${rules.length - 10})` : '')
          : '(无)';
      const grantPath = grantFile(sessionID);
      const record = readGrant(sessionID);
      // B1: the ledger file may carry only the promote half (`agentBefore`),
      // in which case there is no permissions snapshot at all and
      // `record.added` / `record.before` are undefined. Treat that as "no
      // grant record" instead of reading `.join` / `.length` on undefined
      // (used to throw `TypeError: … reading 'join'`).
      const grantRecord = grantHalfOf(record);
      const promoteOnly = Boolean(record) && !grantRecord;

      if (input?.confirm !== true) {
        let current: PermissionRule[] = [];
        let readError: string | undefined;
        try {
          current = await chain.readSessionPermissions(sessionID);
        } catch (error) {
          readError = String((error as Error)?.message ?? error);
        }
        if (revoke) {
          return {
            content: [
              '未还原（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true + revoke:true。',
              targetLine,
              grantRecord
                ? `授权记录: reason=${grantRecord.reason} by=${grantRecord.by || '-'} at=${fmtTime(grantRecord.at)} ` +
                  `added=${(grantRecord.added ?? []).join(',') || '-'} → ${grantPath}`
                : `授权记录: 无（${grantPath} 不存在）→ 确认后会报「无可还原」`,
              promoteOnly
                ? `仅有 promote 记录（agentBefore=${record?.agentBefore}），无 permissions 快照 → 确认后会报「无可还原」，` +
                  `且不会删除 promote 记录。`
                : '',
              grantRecord
                ? `将整集恢复为快照的 ${(grantRecord.before ?? []).length} 条: ${fmtRules(grantRecord.before ?? [])}`
                : '',
              '注: 还原是整集替换；快照之后对同一会话的其它 permissions 改动也会被覆盖。'
            ]
              .filter(Boolean)
              .join('\n')
          };
        }
        return {
          content: [
            '未修改（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。',
            targetLine,
            readError
              ? `读取现有 permissions 失败: ${readError}`
              : `现有会话级规则 ${current.length} 条: ${fmtRules(current)}`,
            `将追加(仅缺失的 ${readError ? 5 : missingRules(current, collabPermissionRules()).length} 条): ${COLLAB_TOOL_ACTIONS.join(
              ' / '
            )}  (resource="${COLLAB_RULE_RESOURCE}", effect="allow")`,
            '不会授予 edit / write / shell / read 等任何其它能力；不存在的规则不会重复追加。',
            `记录: ${grantPath}（before = 首次授权前的快照${grantRecord ? '，已存在（不会覆盖）' : ''}）`,
            grantRecord
              ? `已有记录: reason=${grantRecord.reason} by=${grantRecord.by || '-'} added=${(grantRecord.added ?? []).join(',') || '-'}`
              : '',
            promoteOnly
              ? `注: ${grantPath} 里仅有 promote 记录（agentBefore=${record?.agentBefore}），无 grant 记录 / permissions 快照，` +
                `本次会补写 grant 半段（两半共存，互不覆盖）。`
              : ''
          ]
            .filter(Boolean)
            .join('\n')
        };
      }

      if (revoke) {
        const result = await chain.revokeForSession(sessionID);
        if (!result.ok) {
          return { content: [`未还原：${result.reason}`, targetLine].join('\n') };
        }
        return {
          content: [
            `已还原会话级 permissions 并删除记录: ${sessionID}`,
            targetLine,
            `恢复为 before 的 ${result.restored.length} 条: ${fmtRules(result.restored)}`,
            `复核(GET permissions): ${result.verified.length} 条: ${fmtRules(result.verified)}`,
            result.leftover
              ? `台账保留 promote 半段（agentBefore=${result.leftover.agentBefore}）: ${grantPath}`
              : `记录已删除: ${grantPath}`,
            result.restored.length === 0
              ? 'before 为空 = 该会话本来没有会话级规则（agent 规则恢复生效），不是「删掉 5 条」。'
              : ''
          ]
            .filter(Boolean)
            .join('\n')
        };
      }

      const result = await chain.grantForSession(sessionID, { reason: 'grant', by: me ?? '' });
      if (!result.ok) {
        // R5: a failed PATCH is reported, never fatal — the caller can still
        // hand the task over and fall back to the lease-expiry auto receipt.
        return {
          content: [
            `未授予权限（${result.phase}）: ${result.reason}`,
            targetLine,
            '交接可照常进行：对端不动作时，租约到期会只读提取它的结论并自动闭环。'
          ].join('\n')
        };
      }
      return {
        content: [
          `已授予 5 条 collab_* 会话级权限: ${sessionID}（changed=${result.changed}）`,
          targetLine,
          `追加: ${result.added.map(rule => rule.action).join(' / ') || '(已存在，未重复追加)'}`,
          `现有规则 ${result.verified.length} 条（原规则保留）: ${fmtRules(result.verified)}`,
          `记录: ${grantPath}（before=${result.record?.before?.length ?? 0} 条，reason=${result.record?.reason ?? 'grant'}）`,
          `撤销: collab_grant {target:"${sessionID}", revoke:true, confirm:true}`
        ].join('\n')
      };
    }
  };
}
