import { BCAST_DONE_STATES } from '../constants.ts';
import { isValidBid, readBroadcast, writeBroadcast } from '../core/claim.ts';
import { invalid } from '../core/errors.ts';
import {
  FOLLOWUP_LIMIT,
  appendFollowUp,
  followUpsOf,
  invalidFollowUps,
  sanitizePathText,
  validateIssuePath
} from '../core/followup.ts';
import type { ToolDefinition } from '../types.ts';
import { truncate } from '../util.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/**
 * `collab_followup` — R5 (0.1.6): register a **post-closure** conclusion.
 *
 * A closed hand-off (`done` / `blocked`) is never reopened and never pushed to
 * again: pushing into a requester — especially a `[protected]` one — is exactly
 * what `protect` exists to prevent. So the conclusion is a *pull*:
 *
 *   1. the claimant writes it into the **proposal file** (single source of
 *      truth, e.g. `## 闭环后追加（2026-11-18）`);
 *   2. this tool records only `{ bid, issuePath, at, by }` in
 *      `record.followUps[]`;
 *   3. the requester — protected or not — sees **one read-only line** in its own
 *      `context` injection ("提案 <path> 有追加结论（<ts>），请读取文件").
 *
 * Deliberately **not** stored: any text the caller sends. A free-text field on
 * this path would let any session write arbitrary words into a protected
 * session's context; the path is validated (`realpath` inside the record's
 * workspace, `docs/issues/*.md`, no `..`, no absolute path, no symlink) and
 * sanitised (no newlines/control characters, ≤200 chars) on both write and
 * render. Nothing is delivered to anyone by this tool's write path.
 *
 * 0.3.1 (F2/F3, std-ui review):
 *   - F3: `./docs/issues/x.md`, `docs//issues/x.md` and `docs/issues/./x.md` are
 *     normalised to `docs/issues/x.md` instead of being refused;
 *   - F2: an `issuePath` that sanitises to nothing is **refused** rather than
 *     silently replaced by the record's own path (that fallback stored an entry
 *     the caller never asked for), and the return names any older, unusable
 *     appends of the same bid so they are not invisible.
 */
export function followupTool(_kit: ToolKit): ToolDefinition {
  return {
    name: 'collab_followup',
    description:
      'Register a post-closure conclusion for a hand-off you claimed (state done/blocked): appends ' +
      '{bid, issuePath, at, by} to record.followUps[] and NOTHING else — no delivery, no state change, no ' +
      'reopen. The conclusion itself must be written into the proposal file; the requester only gets one ' +
      'read-only context line pointing at that file. Only the session that claimed the bid may call it; ' +
      '`issuePath` defaults to the record\'s own proposal and must resolve inside the record workspace under ' +
      'docs/issues/ (no `..`, no absolute path, no symlink; `.` / `./` and repeated `/` are normalised away, ' +
      'so `./docs/issues/x.md` is accepted). At most 3 appends per bid. Requires confirm:true; ' +
      'otherwise it only previews.',
    input: jsonInput({
      properties: {
        bid: { type: 'string', description: 'The closed hand-off (`b_…`) you claimed.' },
        issuePath: {
          type: 'string',
          description:
            'Proposal file the conclusion was written into (relative to the record workspace). ' +
            'Defaults to the record\'s own issuePath.'
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to actually append. false/omitted only returns the preview.'
        }
      },
      required: ['bid', 'confirm']
    }),
    async execute(input, context) {
      const bid = String(input?.bid ?? '').trim();
      if (!isValidBid(bid)) {
        throw invalid(`bid 格式不合法："${bid}"（期望 b_<hex16>，从广播/注入行里取）`);
      }
      const record = readBroadcast(bid);
      if (!record) throw invalid(`没有交接 ${bid}：广播目录下没有该记录（bid 拼错，或已被 7 天保留策略清理）`);
      const me = context?.sessionID;
      if (!me) throw invalid('collab_followup 需要会话上下文（sessionID）：无法确认领取人身份');

      // R5: only the claimant may append. The requester and every bystander is
      // refused — this is not a comment box.
      const claimant = String(record.claim?.by ?? '');
      if (!claimant) {
        throw invalid(`交接 ${bid} 没有记录领取人（claim.by），无法追加：只允许本单领取人登记追加结论。`);
      }
      if (claimant !== me) {
        throw invalid(
          `拒绝追加：${bid} 的领取人是 ${claimant}，当前会话是 ${me}。` +
            `只有本单领取人能登记闭环后追加（发起方/旁观会话一律拒绝）。`
        );
      }
      if (!['done', 'blocked'].includes(String(record.state))) {
        throw invalid(
          `拒绝追加：${bid} 当前 state=${record.state}，只有 done/blocked 的交接可以登记闭环后追加。` +
            (BCAST_DONE_STATES.includes(String(record.state))
              ? '（expired 需人工接手：请直接写提案文件，不登记。）'
              : '（还没闭环：请先用回执闭环。）')
        );
      }

      const existing = followUpsOf(record);
      if (existing.length >= FOLLOWUP_LIMIT) {
        throw invalid(
          `拒绝追加：${bid} 已有 ${existing.length} 条闭环后追加（上限 ${FOLLOWUP_LIMIT}）。` +
            '结论请直接写提案文件——记录只做「有追加」的指针。'
        );
      }

      // R5 hardening: the *structure* that gets rendered must be provably inside
      // the workspace's docs/issues/. Fail-closed: a bad path refuses the whole
      // append, nothing is stored and nothing is rendered.
      //
      // F2 (0.3.1): an explicit `issuePath` that sanitises to nothing (only
      // control characters / spaces) is **refused** — the old fallback silently
      // appended the record's own path, i.e. stored an entry nobody asked for.
      const requested = input?.issuePath === undefined ? '' : sanitizePathText(input.issuePath);
      if (input?.issuePath !== undefined && !requested) {
        throw invalid(
          '拒绝追加：issuePath 为空（只含空白/控制字符）。要追加到记录自带的提案请省略该参数。'
        );
      }
      const requestedPath = requested || sanitizePathText(record.issuePath);
      const check = validateIssuePath(record.workspace, requestedPath);
      if (!check.ok) {
        throw invalid(`拒绝追加：${check.reason}（必须是该交接 workspace 下 docs/issues/<name>.md）`);
      }

      if (input?.confirm !== true) {
        return {
          content: [
            '未登记（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。',
            `bid=${bid}  state=${record.state}  领取人=${claimant}`,
            `提案: ${check.issuePath}（${check.abs}）`,
            `当前追加数: ${existing.length}/${FOLLOWUP_LIMIT}；登记后发起方会在下一次请求里看到一行只读提示。`,
            '注意：登记只记指针，结论正文必须写进提案文件（建议 `## 闭环后追加（<date>）`）。'
          ].join('\n')
        };
      }

      // Re-read so a concurrent write (a receipt, an ack stamp) is not clobbered.
      const fresh = readBroadcast(bid) ?? record;
      if (!['done', 'blocked'].includes(String(fresh.state))) {
        throw invalid(`拒绝追加：${bid} 在登记前变成了 state=${fresh.state}（状态已变，请重新检查）。`);
      }
      if (followUpsOf(fresh).length >= FOLLOWUP_LIMIT) {
        throw invalid(`拒绝追加：${bid} 已有 ${FOLLOWUP_LIMIT} 条追加（并发写入）。`);
      }
      const now = Date.now();
      const written = writeBroadcast(
        appendFollowUp(fresh, { issuePath: check.issuePath, at: now, by: me })
      );
      // F2 (0.3.1): older appends of this bid whose path no longer validates
      // render nothing (and are no longer stamped). Say so here — this is the
      // claimant's own view, so naming the count leaks no path text.
      const unusable = invalidFollowUps(written);
      return {
        content: [
          `已登记闭环后追加：${bid}（第 ${followUpsOf(written).length}/${FOLLOWUP_LIMIT} 条）`,
          `提案: ${check.issuePath}`,
          `state 不变（${written.state}），receipt 不变，未向任何人投递。`,
          `发起方 ${record.from?.sid ?? '(缺失)'} 会在自己的下一次请求里看到一行只读提示（只含路径与时间，不含正文）。`,
          ...(unusable.length
            ? [
                `注意：本单另有 ${unusable.length} 条 followUp 路径无效，不会渲染（未标记；修好路径后下一轮会再试）。`
              ]
            : []),
          // The hint is a pointer, not the conclusion: make that unmissable.
          `结论正文请写进 ${check.issuePath} 的 \`## 闭环后追加（${new Date(now).toISOString().slice(0, 10)}）\` 小节。`,
          `摘要: ${truncate(written.title ?? '(untitled)', 60)}`
        ].join('\n')
      };
    }
  };
}
