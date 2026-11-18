import { archiveSession, spawnedSessionID } from '../core/archive.ts';
import { allBroadcasts, isValidBid, mergeArchive, readBroadcast } from '../core/claim.ts';
import { invalid } from '../core/errors.ts';
import { createLineage } from '../core/lineage.ts';
import { errText } from '../log.ts';
import type { BroadcastRecord, SessionInfoLike, ToolDefinition } from '../types.ts';
import { fmtTime, sessionState, truncate } from '../util.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

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
 */
export function archiveTool(kit: ToolKit): ToolDefinition {
  const { deps } = kit;
  const { ctx, readConfig } = deps;

  /** `<bid>` → its session, or the session the record's claimant really is. */
  function resolveSession(input: { bid: string; session: string }): {
    record?: BroadcastRecord;
    sessionID: string;
  } {
    const { bid, session } = input;
    if (!bid) return { sessionID: session };
    if (!isValidBid(bid)) throw invalid(`bid 格式不合法："${bid}"（期望 b_<8–32 位十六进制>）`);
    const record = readBroadcast(bid);
    if (!record) {
      throw invalid(`没有 ${bid} 的记录（可能拼错，或已过 7 天保留期被清理）`);
    }
    const claimed = spawnedSessionID(record);
    if (!claimed) {
      const holder = String(record.claim?.by ?? '').trim();
      throw invalid(
        `${bid} 不是本插件拉起的会话（claim.kind=${String(record.claim?.kind)}${
          holder ? `，当前领取方 ${holder} 是人自己的会话` : ''
        }）：` +
          '按 bid 归档只针对本插件 spawn 的会话；确实要归档某个会话请用 session 直接指定'
      );
    }
    if (session && session !== claimed) {
      throw invalid(`bid ${bid} 的领取会话是 ${claimed}，与 session=${session} 不一致；请只传其中一个`);
    }
    return { record, sessionID: claimed };
  }

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
    async execute(input) {
      const bid = String(input?.bid ?? '').trim();
      const sessionRaw = String(input?.session ?? '').trim();
      const restore = input?.restore === true;
      if (!bid && !sessionRaw) {
        throw invalid('collab_archive 需要 bid（取该单领取的会话）或 session（直接指定会话 id）之一');
      }
      const { record, sessionID } = resolveSession({ bid, session: sessionRaw });

      let info: SessionInfoLike;
      try {
        info = await ctx.session.get({ sessionID });
      } catch (error) {
        throw invalid(`会话不存在或不可读：${sessionID}（${errText(error)}）`, error);
      }
      // The hard boundary applies to every write path in this plugin: a
      // protected line is never hidden, restored or patched by a tool.
      const guard = await createLineage(ctx).protectedAncestor(sessionID, readConfig().protect);
      if (guard) {
        const where = guard.depth === 0 ? '本身' : `的祖先（第 ${guard.depth} 级）${guard.sessionID} `;
        throw invalid(
          `拒绝归档：${sessionID} ${where}在 protect 名单内（collab.json 的 protect + 内置硬名单）。未做任何修改。`
        );
      }

      const state = sessionState(info);
      const already = state === 'archived';
      const action = restore ? '恢复（archived:false）' : '归档（archived:true）';
      const targetLine =
        `目标: ${sessionID}  agent=${info?.agent ?? '?'}  state=${state}  ` +
        `标题="${truncate(info?.title ?? '(untitled)', 60)}"`;

      if (input?.confirm !== true) {
        return {
          content: [
            '未执行（confirm 不为 true，仅预览）。归档 ≠ 删除：会话与消息都保留，restore:true 可恢复。',
            targetLine,
            `动作: ${action}`,
            ...(record
              ? [
                  `记录: ${record.bid} state=${String(record.state)} ` +
                    `archivedAt=${record.archivedAt ? fmtTime(record.archivedAt) : '-'}`
                ]
              : []),
            '确认后在同样参数下传 confirm:true。'
          ].join('\n')
        };
      }

      const lines: string[] = [];
      if (!restore && already) {
        // Idempotent: the host already hides it. Do **not** PATCH again — only
        // adopt the state into the record so the auto pass stops looking at it.
        lines.push('目标已是归档状态（幂等，未重复 PATCH）。');
      } else if (restore && !already) {
        lines.push('目标当前未归档（幂等，未重复 PATCH）。');
      } else {
        const result = await archiveSession(ctx, sessionID, !restore);
        if (!result.ok) {
          // A refused host (403 / 404 / no update + no URL) is a readable
          // outcome, not a plugin defect: nothing was written.
          return {
            content: [
              `${restore ? '恢复' : '归档'}失败：${result.reason ?? 'unknown'}`,
              targetLine,
              `记录: ${record ? record.bid : '(未关联 bid，未改任何记录)'}`,
              '未做任何修改。'
            ].join('\n')
          };
        }
        lines.push(`${restore ? '已恢复' : '已归档'}：${sessionID}（via ${result.via ?? '?'}）`);
      }

      // Stamp / clear the record **after** the host write. Without `bid`, adopt
      // every record that names this session as its claimant (a session may be
      // the claimant of several hand-offs; only the stamped ones stop the pass).
      const now = Date.now();
      const bids = record
        ? [record.bid]
        : allBroadcasts()
            .filter(other => spawnedSessionID(other) === sessionID || String(other.claim?.by ?? '') === sessionID)
            .map(other => other.bid);
      const stamped: string[] = [];
      for (const targetBid of bids) {
        const merged = mergeArchive(targetBid, restore ? null : now);
        if (merged) stamped.push(merged.bid);
      }

      return {
        content: [
          '归档 ≠ 删除：会话与消息都保留，restore:true 可恢复。',
          targetLine,
          `动作: ${action}`,
          ...lines,
          stamped.length
            ? `记录 archivedAt: ${stamped.map(id => `${id}=${restore ? '清空' : fmtTime(now)}`).join(', ')}`
            : '记录: 未关联 bid（只改了会话本身）',
          restore
            ? '恢复后它会重新出现在会话列表里；如需再次归档：collab_archive { session, confirm:true }。'
            : `恢复：collab_archive { session:"${sessionID}", restore:true, confirm:true }。`
        ].join('\n')
      };
    }
  };
}
