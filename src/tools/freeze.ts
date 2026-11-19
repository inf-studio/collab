/**
 * `collab_freeze` — the **temporary freeze mark** (0.6.0).
 *
 * A freeze is the collaboration layer's own brake: it says "do not start
 * anything new into this session / workspace / hand-off" until `until`, and it
 * says so to the tools, not just to a human reading a message.
 *
 * What the tool does (design §1–§5):
 *
 *   1. validates `scope` (`session` / `workspace` / `bid`) and `target`
 *      (`workspace` defaults to `ctx.location.directory`; `session` accepts an
 *      alias; `bid` must be a real record — a typo must not freeze nothing);
 *   2. `until` is a relative window (`"30m"`) or an absolute instant (ISO);
 *      default 30 minutes, capped at 30 days;
 *   3. writes the entry **read-merge-write** (`mergeFreezes`) and reports the
 *      *effective* list — two writers (two workspaces share this file) never
 *      drop each other's entries;
 *   4. delivers the notice: a non-protected target gets one `queue` prompt (the
 *      same admission receipt `collab_send` records: `cid` + `message-id`); a
 *      protected target — or a descendant of one — is **never** pushed to, so it
 *      gets one `priority:"urgent"` owner-queue item instead. The receipts are
 *      stored on the entry (`delivery[]`) so "did it reach anybody" survives the
 *      turn;
 *   5. `freeze:false` removes the entry (idempotent: a missing entry is a
 *      no-op, not an error);
 *   6. `confirm:false` is a zero-write preview: target, scope, expiry, the
 *      recipients that would be notified and the affected commands.
 *
 * Deliberately **not** here: archiving, deleting, permissions, agent switches,
 * a scheduler. An expired freeze simply stops existing on the next read — no
 * daemon, no timer, nothing to clean up.
 */
import { isAbsolute } from 'node:path';
import { readBroadcast, isValidBid } from '../core/claim.ts';
import { invalid } from '../core/errors.ts';
import {
  FREEZE_FILE,
  mergeFreezes,
  parseUntil,
  readFreezes,
  sanitizeFreezeReason
} from '../core/freeze.ts';
import { createLineage } from '../core/lineage.ts';
import { fmtTtl } from '../core/locks.ts';
import { enqueue, queueDir } from '../core/owner-queue.ts';
import { newCorrelationID } from '../ids.ts';
import { errText } from '../log.ts';
import type { BroadcastRecord, FreezeDelivery, FreezeEntry, SessionInfoLike, ToolDefinition } from '../types.ts';
import { asObject, shortID, truncate } from '../util.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

const SCOPES: FreezeEntry['scope'][] = ['session', 'workspace', 'bid'];
/** A workspace freeze notifies at most this many sessions (no prompt storm). */
const WORKSPACE_NOTIFY_LIMIT = 5;

/** `HH:MM` — the shape every freeze line uses. */
function clock(ms: number): string {
  const date = new Date(Number(ms) || 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The session a frozen hand-off is addressed to ("who must hear about it"):
 * the claimant, the one being asked, or the target of the takeover message —
 * the same precedence `collab_status` / `collab_escalate` use.
 */
function addresseeOf(record: BroadcastRecord): string {
  return (
    String(record.claim?.by ?? '') ||
    String(record.asked?.sid ?? '') ||
    String(asObject(record.delivery).to ?? '')
  );
}

/** One notice body — one line, so a queue item can never carry a second line. */
function noticeBody(entry: FreezeEntry): string {
  return (
    `[frozen] ${entry.reason || '(未写原因)'}（scope=${entry.scope}，到 ${clock(entry.until)}；` +
    `解冻: collab_freeze {scope:"${entry.scope}", target:"${entry.target}", freeze:false, confirm:true}）`
  );
}

/** The human label of a scope, used in results / refusals. */
const scopeLabel = (scope: FreezeEntry['scope']): string =>
  scope === 'session' ? '会话' : scope === 'workspace' ? '工作区' : '交接单';

export function freezeTool(kit: ToolKit): ToolDefinition {
  const { deps, resolveTarget, senderLabel } = kit;
  const { ctx, readConfig, chain } = deps;

  /**
   * Who would be notified for this freeze. Read-only (a preview calls it too):
   * `session` → that session; `bid` → its addressee; `workspace` → the root
   * sessions of that workspace (self / sub-sessions / archived left out, capped).
   */
  async function recipientsOf(
    scope: FreezeEntry['scope'],
    target: string,
    me: string | undefined
  ): Promise<string[]> {
    // A self-freeze sets the marker only: queueing a `[frozen]` prompt into your own
    // composer is noise (and the next turn already sees the marker).
    if (scope === 'session') return target && target !== me ? [target] : [];
    if (scope === 'bid') {
      const record = readBroadcast(target);
      const sid = record ? addresseeOf(record) : '';
      return sid && sid !== me ? [sid] : [];
    }
    let listed: SessionInfoLike[] = [];
    try {
      listed = await chain.listSessions({ directory: target, limit: 100 });
    } catch {
      listed = []; // an unlistable workspace freezes anyway; nobody is notified
    }
    return listed
      .filter(info => info?.id && info.id !== me)
      .filter(info => !info.parentID && !info.parentId) // sub-sessions are not group members
      .filter(info => !asObject(info.time).archived)
      .map(info => String(info.id))
      .slice(0, WORKSPACE_NOTIFY_LIMIT);
  }

  /**
   * R5: one notice per recipient. Never throws: the freeze is already written,
   * and a failed prompt is recorded as a receipt (`error`) instead of undoing a
   * decision the caller confirmed.
   */
  async function notify(
    sids: string[],
    entry: FreezeEntry,
    me: string
  ): Promise<FreezeDelivery[]> {
    if (!sids.length) return [];
    const lineage = createLineage(ctx);
    const protect = readConfig().protect;
    const body = noticeBody(entry);
    const receipts: FreezeDelivery[] = [];
    for (const sid of sids) {
      const guard = await lineage.protectedAncestor(sid, protect);
      const at = Date.now();
      if (guard) {
        // Protected (itself or through lineage): 0 prompts — the one compliant
        // channel into such a session is the owner queue (a pull, not a push).
        try {
          const item = enqueue({ target: sid, from: me, text: body, priority: 'urgent', now: at });
          receipts.push({ to: sid, queueId: item.id, at });
        } catch (error) {
          receipts.push({ to: sid, at, error: errText(error) });
        }
        continue;
      }
      const cid = newCorrelationID();
      try {
        const admitted = await ctx.session.prompt({
          sessionID: sid,
          text: body,
          // A freeze is a brake, not an interruption: it waits for the target's
          // next turn instead of merging into the turn it is running.
          delivery: 'queue',
          metadata: {
            collab: {
              from: senderLabel(me),
              fromSessionID: me,
              cid,
              kind: 'note',
              ts: at,
              freeze: true
            }
          }
        });
        receipts.push({ to: sid, cid, ...(admitted?.id ? { messageId: String(admitted.id) } : {}), at });
      } catch (error) {
        receipts.push({ to: sid, cid, at, error: errText(error) });
      }
    }
    return receipts;
  }

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
      const me = context?.sessionID;
      const scope = String(input?.scope ?? '').trim() as FreezeEntry['scope'];
      if (!SCOPES.includes(scope)) {
        throw invalid(`scope 不合法：${JSON.stringify(String(input?.scope ?? ''))}（期望 session / workspace / bid）`);
      }
      const unfreeze = input?.freeze === false;
      const rawTarget = String(input?.target ?? '').trim();

      // ---------------------------------------------------------- R1: target
      let target = rawTarget;
      let targetLine = '';
      let record: BroadcastRecord | undefined;
      if (scope === 'workspace') {
        target = rawTarget || String(ctx?.location?.directory ?? '').trim();
        if (!target) {
          throw invalid('scope:"workspace" 需要 target（绝对路径）；当前会话也没有 location.directory。');
        }
        if (!isAbsolute(target)) throw invalid(`workspace 必须是绝对路径："${target}"`);
        targetLine = `workspace=${target}`;
      } else if (scope === 'session') {
        if (!rawTarget) throw invalid('scope:"session" 需要 target（ses_… 会话 id 或别名）');
        const resolved = await resolveTarget(rawTarget);
        target = resolved.sessionID;
        targetLine =
          `${resolved.sessionID}${resolved.alias ? ` (alias=${resolved.alias})` : ''}  ` +
          `agent=${resolved.info?.agent ?? '?'}  "${truncate(resolved.info?.title ?? '(untitled)', 40)}"`;
      } else {
        if (!rawTarget) throw invalid('scope:"bid" 需要 target（交接单 id b_…）');
        if (!isValidBid(rawTarget)) {
          throw invalid(`bid 格式不合法：${JSON.stringify(rawTarget)}（期望 b_ + 8–32 位十六进制）`);
        }
        record = readBroadcast(rawTarget);
        if (!record) {
          throw invalid(
            `没有交接单 ${rawTarget}：bid 可能拼错，或该单已闭环且过了 7 天保留期被回收。可用 collab_list 看全量。`
          );
        }
        target = record.bid;
        targetLine =
          `交接 ${record.bid} state=${record.state ?? 'open'} 承接=${record.claim?.by ?? '-'} ` +
          `"${truncate(record.title ?? '(untitled)', 40)}"`;
      }

      const now = Date.now();
      const confirmed = input?.confirm === true;
      const live = readFreezes(now);
      const existing = live.find(entry => entry.scope === scope && entry.target === target);

      // --------------------------------------------------------- unfreeze
      if (unfreeze) {
        if (!confirmed) {
          return {
            content: [
              '未解冻（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。',
              `作用域: scope=${scope}  ${targetLine}`,
              existing
                ? `将删除: 冻结项（到 ${clock(existing.until)}，原因：${existing.reason || '-'}）——之后新建协作立即可用。`
                : '当前没有该冻结项：确认后为 no-op（幂等，不报错）。',
              `文件: ${FREEZE_FILE}（读-合并-写）`,
              '注: 解冻不通知任何人，也不改动任何会话 / 记录。'
            ].join('\n')
          };
        }
        const next = mergeFreezes(
          entries => entries.filter(entry => !(entry.scope === scope && entry.target === target)),
          now
        );
        return {
          content: [
            existing ? `已解冻（scope=${scope}, target=${target}）。` : `没有该冻结项（no-op：scope=${scope}, target=${target}）。`,
            `作用域: ${targetLine}`,
            `文件: ${FREEZE_FILE}（剩余 ${next.length} 条冻结）`,
            '效果: collab_handoff / collab_broadcast / collab_accept / collab_escalate 对该对象立即可用。',
            `再冻结: collab_freeze { scope:"${scope}", target:"${target}", reason:"…", confirm:true }`
          ].join('\n')
        };
      }

      // ------------------------------------------------------------ R1: until
      const reason = sanitizeFreezeReason(input?.reason);
      if (!reason) {
        throw invalid('reason 不能为空：请给一句话说明为什么冻结（≤200 字，会去掉控制字符）');
      }
      const until = parseUntil(input?.until, now);
      if (!until) {
        throw invalid(
          `until 不合法：${JSON.stringify(String(input?.until ?? ''))}（支持 "30m" / "2h" / "45s" / ISO 时间；` +
            '必须是将来时刻）。'
        );
      }
      const entry: FreezeEntry = { scope, target, reason, by: me ?? 'unknown', at: now, until };
      // Who would hear about it (read-only; needed by the preview and the write).
      const recipients = await recipientsOf(scope, target, me);

      // ----------------------------------------------------------- preview
      if (!confirmed) {
        return {
          content: [
            '未冻结（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。',
            `作用域: scope=${scope}  ${targetLine}`,
            `到期: ${clock(until)}（${fmtTtl(until - now)} 后；到期自动失效，无需清理）`,
            `原因: ${reason}`,
            existing
              ? `注: 已存在同一冻结（到 ${clock(existing.until)}）：确认后覆盖为本次的到期 / 原因。`
              : '',
            recipients.length
              ? `将通知 ${recipients.length} 个会话（非受保护 → 1 条 queue prompt；受保护 → 紧急队列项，0 条 prompt）: ` +
                recipients.map(shortID).join(', ')
              : '将通知 0 个会话（该对象当前没有可通知的会话；冻结照样生效）。',
            '将影响: collab_handoff / collab_broadcast / collab_accept / collab_escalate 对该对象的新建协作会被拒绝；' +
              'collab_list / collab_status 只标 [frozen]。',
            `将写入: ${FREEZE_FILE}（version 1，读-合并-写）`
          ]
            .filter(Boolean)
            .join('\n')
        };
      }

      // ------------------------------------------------------------- write
      // Read-merge-write: the entry replaces an older freeze of the same
      // scope+target, and every other entry (another workspace's freeze, a bid
      // frozen by somebody else) is kept. Expired entries are swept here.
      const written = mergeFreezes(entries => [...entries, entry], now);
      const stored = written.find(candidate => candidate.scope === scope && candidate.target === target);
      // `mergeFreezes` logs and returns the *previous* list when the write fails;
      // an older freeze of the same target would make the lookup succeed with a
      // stale entry, so the stamp must be the one we just made.
      if (!stored || stored.at !== entry.at) {
        return {
          content: [
            `冻结未生效：写入 ${FREEZE_FILE} 失败（详见日志），${scopeLabel(scope)} 仍按原状态。`,
            `目标: ${targetLine}`,
            '重试：确认磁盘可写后重新调用；不需要解冻。'
          ].join('\n')
        };
      }

      // R5: notify after the freeze exists — a failed prompt must not undo it.
      const receipts = await notify(recipients, stored, me ?? 'unknown');
      let finalEntry: FreezeEntry = stored;
      if (receipts.length) {
        const merged = mergeFreezes(
          entries =>
            entries.map(candidate =>
              candidate.scope === scope && candidate.target === target
                ? { ...candidate, delivery: receipts }
                : candidate
            ),
          now
        );
        finalEntry = merged.find(candidate => candidate.scope === scope && candidate.target === target) ?? stored;
      }

      const delivered = receipts.filter(receipt => !receipt.error && !receipt.queueId);
      const queued = receipts.filter(receipt => Boolean(receipt.queueId));
      const failed = receipts.filter(receipt => Boolean(receipt.error));
      return {
        content: [
          `已冻结 ${scopeLabel(scope)}（scope=${scope}, target=${target}, 到 ${clock(finalEntry.until)}：${fmtTtl(
            finalEntry.until - Date.now()
          )} 后）`,
          `作用域: ${targetLine}`,
          `原因: ${finalEntry.reason}`,
          delivered.length
            ? `送达（queue）: ${delivered
                .map(receipt => `${shortID(receipt.to)} message=${receipt.messageId ?? '?'} cid=${receipt.cid ?? '?'}`)
                .join('; ')}`
            : '',
          queued.length
            ? `受保护目标（0 条 prompt，已排队）: ${queued
                .map(receipt => `${shortID(receipt.to)} ${receipt.queueId} → ${queueDir(receipt.to)}/${receipt.queueId}.json`)
                .join('; ')}`
            : '',
          failed.length
            ? `未通知: ${failed.map(receipt => `${shortID(receipt.to)}（${receipt.error}）`).join('; ')}（冻结仍然生效）`
            : '',
          recipients.length ? '' : '注: 该对象当前没有可通知的会话；冻结照样生效（以后新建的会话也会被拒）。',
          `文件: ${FREEZE_FILE}（现有 ${readFreezes(now).length} 条冻结）`,
          '影响: 对该对象**新建**协作（collab_handoff / collab_broadcast / collab_accept / collab_escalate）会被拒绝；' +
            '读取类（collab_list / collab_status）不受限，只标 [frozen]。',
          `解冻: collab_freeze { scope:"${scope}", target:"${target}", freeze:false, confirm:true }`
        ]
          .filter(Boolean)
          .join('\n')
      };
    }
  };
}
