import { isAbsolute, basename } from 'node:path';
import { ACKED_EXTRACT_MS, BCAST_DONE_STATES, BOOTSTRAP_TITLE_RE } from '../constants.ts';
import { allBroadcasts, leaseVerdict } from '../core/claim.ts';
import { createLineage } from '../core/lineage.ts';
import type { ToolDefinition } from '../types.ts';
import { clamp, fmtTime, sessionState, shortID, truncate } from '../util.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/** `collab_list` — read-only session + open hand-off inventory. */
export function listTool(kit: ToolKit): ToolDefinition {
  const { deps } = kit;
  const { ctx, readConfig, chain } = deps;

  return {
    name: 'collab_list',
    description:
      'List OpenCode sessions usable as collab targets: id, agent, state (busy/idle), title, parent, alias and ' +
      '`loc=<项目名>`. Read-only. `directory` limits the list to one workspace (default: every session the host ' +
      'returns). Sessions in the `protect` list are marked [protected]; their descendants are marked ' +
      '[protected-child] — neither can be sent to. Sessions spawned by a broadcast carry [bootstrap].',
    input: jsonInput({
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of sessions to return (default 20, max 100).'
        },
        directory: {
          type: 'string',
          description: 'Only list sessions of this workspace (absolute path). Omit to keep the old behaviour.'
        }
      },
      required: []
    }),
    async execute(input, context) {
      const config = readConfig();
      const limit = clamp(input?.limit ?? 20, 1, 100);
      const directory = String(input?.directory ?? '').trim() || undefined;
      if (directory && !isAbsolute(directory)) {
        throw new Error(`directory 必须是绝对路径："${directory}"`);
      }
      const sessions = (await chain.listSessions({ directory, limit })).slice(0, limit);
      if (!sessions.length) {
        return { content: `${directory ? `工作区 ${directory} 下` : ''}没有可列出的会话。` };
      }

      const lineage = createLineage(ctx);
      lineage.seed(sessions);

      const aliasesOf = (sessionID: string): string[] =>
        Object.entries(config.aliases)
          .filter(([, value]) => value === sessionID)
          .map(([name]) => name);

      // Sessions a broadcast created (`impl:<slug>`) — never deleted by us,
      // but worth marking so a human can tell them from hand-made sessions.
      const spawned = new Set(
        allBroadcasts()
          .filter(record => record.claim?.kind === 'spawn')
          .map(record => String(record.claim?.by ?? ''))
      );

      const lines: string[] = [];
      for (const info of sessions) {
        const aliases = aliasesOf(info.id);
        // `protected` = on the list; `protected-child` = inherits it through
        // parentID (a sub-agent of a protected line is not a legal target).
        const guard = await lineage.protectedAncestor(info.id, config.protect);
        const marks = [
          info.id === context?.sessionID ? 'self' : '',
          guard?.depth === 0 ? 'protected' : '',
          guard && guard.depth > 0 ? 'protected-child' : '',
          spawned.has(info.id) || BOOTSTRAP_TITLE_RE.test(String(info.title ?? '')) ? 'bootstrap' : ''
        ].filter(Boolean);
        const suffix = [
          aliases.length ? `alias=${aliases.join(',')}` : '',
          marks.length ? `[${marks.join(',')}]` : '',
          info.parentID ? `parent=${shortID(info.parentID)}` : ''
        ]
          .filter(Boolean)
          .join(' ');
        const loc = info?.location?.directory ? basename(info.location.directory) : '?';
        lines.push(
          [
            info.id,
            `${info.agent ?? '?'}`,
            sessionState(info),
            `loc=${loc}`,
            fmtTime(info?.time?.updated),
            `"${truncate(info.title ?? '(untitled)', 60)}"`,
            suffix
          ]
            .filter(Boolean)
            .join('  ')
        );
      }

      const now = Date.now();
      const broadcasts = allBroadcasts()
        .filter(
          record =>
            (directory ? record.workspace === directory : true) && !BCAST_DONE_STATES.includes(String(record.state))
        )
        .map(record => {
          // R1-4: read-only lease verdict — no refresh, no lock release here.
          const lease = leaseVerdict(record, now);
          // R8: `acked` has no lease; after ACKED_EXTRACT_MS of silence the
          // requester's next refresh may close it from the claimant's answer.
          const claimAt = Number(record.claim?.at ?? 0);
          const silent =
            record.state === 'acked' && claimAt && now - claimAt > ACKED_EXTRACT_MS
              ? ` 静默=${Math.floor((now - claimAt) / 3_600_000)}h 可自动提取`
              : '';
          return (
            `- ${record.bid} ${record.state}${lease ? ` lease=${lease}` : ''}${silent} scope=${record.scope} "$ ${truncate(record.title ?? '(untitled)', 50)}"` +
            ` 提案=${record.issuePath ?? '-'} 承接=${record.claim?.by ?? '-'} attempts=${record.attempts}${
              record.asked?.sid ? ` 问询=${record.asked.sid}` : ''
            }`
          );
        });

      return {
        content: [
          `${sessions.length} 个会话（id / agent / state / loc / updated / title）:`,
          ...lines,
          '[protected] / [protected-child] 均不可投递（后者是受保护会话的子会话）；[bootstrap] 是广播拉起的会话。',
          ...(broadcasts.length
            ? [
                '未闭环交接:',
                ...broadcasts,
                'lease=expired 只表示「按快照看租约已过」——本命令不改状态、不删锁、不推进顺延；',
                '真正的顺延发生在下一次 collab_accept / 广播 / context 注入时。'
              ]
            : [])
        ].join('\n')
      };
    }
  };
}
