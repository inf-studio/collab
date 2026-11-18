import { isAbsolute, basename } from 'node:path';
import { ACKED_EXTRACT_MS, BCAST_DONE_STATES, BOOTSTRAP_TITLE_RE } from '../constants.ts';
import { deliveryLine, deliveryOf, deliveryVisible, unackedDue } from '../core/ack.ts';
import { allBroadcasts, leaseVerdict } from '../core/claim.ts';
import { invalid } from '../core/errors.ts';
import { createLineage } from '../core/lineage.ts';
import { fmtTtl, locksFor } from '../core/locks.ts';
import { reportDir, reportNoticeLine, takePendingNotice } from '../core/report.ts';
import { formatStale, markShown, staleFor } from '../core/stale.ts';
import type { ToolDefinition } from '../types.ts';
import { clamp, fmtTime, sessionState, shortID, truncate } from '../util.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/** R8②: the report entry point is a *fixed* last line of every listing. */
function hintLine(): string {
  return `缺陷上报：collab_report { confirm:true }（证据目录 ${reportDir()}）`;
}

/** `collab_list` — read-only session + open hand-off inventory. */
export function listTool(kit: ToolKit): ToolDefinition {
  const { deps } = kit;
  const { ctx, readConfig, chain, reporter } = deps;

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
        throw invalid(`directory 必须是绝对路径："${directory}"`);
      }
      const sessions = (await chain.listSessions({ directory, limit })).slice(0, limit);
      if (!sessions.length) {
        return {
          content: [
            `${directory ? `工作区 ${directory} 下` : ''}没有可列出的会话。`,
            hintLine()
          ].join('\n')
        };
      }

      const lineage = createLineage(ctx);
      lineage.seed(sessions);

      const aliasesOf = (sessionID: string): string[] =>
        Object.entries(config.aliases)
          .filter(([, value]) => value === sessionID)
          .map(([name]) => name);

      // Sessions a broadcast created (`impl:<slug>`) — never deleted by us,
      // but worth marking so a human can tell them from hand-made sessions.
      const records = allBroadcasts();
      const spawned = new Set(
        records.filter(record => record.claim?.kind === 'spawn').map(record => String(record.claim?.by ?? ''))
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
      const broadcasts = records
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
          // R3 (0.1.6): delivery visibility — `admitted / seen / queue-age`.
          const delivery = deliveryVisible(record, now) ? `  ${deliveryLine(record, now)}` : '';
          return (
            `- ${record.bid} ${record.state}${lease ? ` lease=${lease}` : ''}${silent} scope=${record.scope} "$ ${truncate(record.title ?? '(untitled)', 50)}"` +
            ` 提案=${record.issuePath ?? '-'} 承接=${record.claim?.by ?? '-'} attempts=${record.attempts}${
              record.asked?.sid ? ` 问询=${record.asked.sid}` : ''
            }${delivery}`
          );
        });

      // R3 (0.1.6): an unacked hand-off gets its own line — the only action a
      // human has left is to deliver it by hand (the plugin already tried twice).
      const unacked = records
        .filter(record => (directory ? record.workspace === directory : true))
        .filter(record => deliveryVisible(record, now) && (deliveryOf(record).unacked || unackedDue(record, now)))
        .map(record => `- ${record.bid} 未确认送达（${deliveryLine(record, now)}）→ 可人工补投：collab_send 或直接提醒对端`);

      // R6: hang-up classes, once per (session, class, bid); R9.2: one passive
      // "未处理上报 N 条" line when a backlog exists.
      const me = context?.sessionID;
      // R5 (0.2.0): this session's own leases and queue position — the one
      // coordination fact a session must not have to ask another session for.
      const leases = locksFor(me, now);
      const leaseLines = [
        ...leases.held.map(
          state =>
            `- ${state.resource}  held  mode=${state.mode}  剩余=${fmtTtl(state.expiresIn)}  ` +
            `ttl=${fmtTtl(state.ttlMs)}  waiters=${state.waiters.length}`
        ),
        ...leases.waiting.map(
          state =>
            `- ${state.resource}  排队中 第 ${state.mine?.position ?? '?'} 位  ` +
            `持有者=${state.holders.join(',') || '-'}  剩余=${state.free ? '-' : fmtTtl(state.expiresIn)}`
        )
      ];
      const stale = me ? await markShown(ctx, me, staleFor(records, me, now)) : [];
      const pendingCount = reporter.pending().count;
      const notice = await takePendingNotice(ctx, me, pendingCount);

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
            : []),
          ...(unacked.length
            ? [
                '未确认送达（admitted 了但没收到 seen，已用满重发预算）:',
                ...unacked,
                'ack 只表示「收方插件把它送到了模型面前」；busy 目标不会被重发（等即可），受保护发起方 ack 不可用。'
              ]
            : []),
          ...(leaseLines.length
            ? [
                '我的资源租约（锁只用于自愿协调，不投递消息；到期自动回收）:',
                ...leaseLines,
                '释放: collab_unlock { resource:"<资源名>", confirm:true }；全部租约: collab_locks'
              ]
            : []),
          ...(stale.length ? ['挂起提醒（每类每单只出现一次）:', ...formatStale(stale)] : []),
          ...(notice ? [reportNoticeLine(pendingCount)] : []),
          hintLine()
        ].join('\n')
      };
    }
  };
}
