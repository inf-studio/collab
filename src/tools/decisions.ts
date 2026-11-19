import { isValidBid, readBroadcast, writeBroadcast } from '../core/claim.ts';
import { invalid } from '../core/errors.ts';
import {
  DECISION_ID_CHARS,
  DECISION_ITEMS_LIMIT,
  DECISION_KEEP,
  DECISION_RATIONALE_CHARS,
  DECISION_TEXT_CHARS,
  canWriteDecisions,
  decisionHistoryOf,
  mergeDecisions,
  normalizeDecisionItems
} from '../core/verdict.ts';
import type { BroadcastDecision, DecisionSpec, ToolDefinition } from '../types.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/** `  - exit-code: 退出码用 3` — the same shape the preview and the result use. */
function itemLine(entry: DecisionSpec | BroadcastDecision): string {
  return `  - ${entry.id}: ${entry.decision}`;
}

/**
 * `collab_decisions` — 0.7.0 (`11-19-collab-decisions`): record the **contract
 * decisions** of a hand-off on the hand-off itself.
 *
 * The problem it closes: one delivery carried three contract-level deviations
 * (exit code 2 → 3, `room:order` is event-only, the assertion only looked at the
 * last frame). Each was corrected in prose across 3–4 threads, and the proposal
 * had to be rewritten by hand afterwards — the corrections existed only in chat
 * history. A decision written here is part of the record, so the next reader
 * (the claimant's takeover injection, `collab_status`) sees it without reading
 * anybody's thread.
 *
 * Deliberately narrow:
 *   - **only** the requester (`from.sid`) or the claimant (`claim.by`) may write
 *     (stricter than `blocked`: `asked` / `origin` are refused) — fail-closed;
 *   - writes `record.decisions[]` and **nothing else**: no delivery, no
 *     `state` / `claim` / `receipt` / `replies` change, no guard widened;
 *   - keyed by `id`: writing the same id again **overwrites** it (one answer per
 *     decision, always the latest) instead of appending;
 *   - 1–10 items per call, ≤20 per record — over a cap is a **readable
 *     refusal**, never a silent truncation or eviction;
 *   - `confirm:false` previews without writing.
 */
export function decisionsTool(_kit: ToolKit): ToolDefinition {
  return {
    name: 'collab_decisions',
    description:
      'Record the contract-level decisions of a hand-off on the hand-off record itself (the "exit code is 3, ' +
      'not 2" / "room:order is event-only" corrections that otherwise live only in chat history). Writes ' +
      '`record.decisions[]` and NOTHING else — no delivery, no state / claim / receipt / replies change, no ' +
      'guard widened. Only the requester (from.sid) or the claimant (claim.by) of this bid may write; every ' +
      'other session is refused (use collab_status to read). Each item is { id, decision, rationale? } with ' +
      `id ≤${DECISION_ID_CHARS}, decision ≤${DECISION_TEXT_CHARS}, rationale ≤${DECISION_RATIONALE_CHARS} chars ` +
      `(control characters stripped); 1–${DECISION_ITEMS_LIMIT} items per call and at most ${DECISION_KEEP} per ` +
      'record — over a cap is a readable refusal, never a silent truncation or eviction. Repeating an id ' +
      'OVERWRITES that decision (latest answer wins) instead of appending. The claimant\'s takeover injection ' +
      'shows one count line; the full list is read with collab_status { bid }. Requires confirm:true; otherwise ' +
      'it only previews.',
    input: jsonInput({
      properties: {
        bid: {
          type: 'string',
          description: 'The hand-off (`b_…`) the decisions belong to (from the broadcast / injection line).'
        },
        items: {
          type: 'array',
          description:
            `Decisions to write: 1–${DECISION_ITEMS_LIMIT} entries. Same \`id\` twice (or already on the ` +
            'record) overwrites instead of appending.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: {
                type: 'string',
                description:
                  `Stable key, ≤${DECISION_ID_CHARS} chars (e.g. \`exit-code\`, \`D-064\`). Writing it again ` +
                  'overwrites the earlier decision.'
              },
              decision: {
                type: 'string',
                description: `What was decided, ≤${DECISION_TEXT_CHARS} chars (one line, free text).`
              },
              rationale: {
                type: 'string',
                description: `Why, ≤${DECISION_RATIONALE_CHARS} chars (optional). Truncated to 80 in collab_status.`
              }
            },
            required: ['id', 'decision']
          }
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to actually write. false/omitted only returns the preview.'
        }
      },
      required: ['bid', 'items', 'confirm']
    }),
    async execute(input, context) {
      const bid = String(input?.bid ?? '').trim();
      if (!isValidBid(bid)) {
        throw invalid(`bid 格式不合法："${bid}"（期望 b_<hex16>，从广播/注入行里取）—— 未写入任何内容`);
      }
      // Validated first: an over-long / over-count `items` is a readable refusal
      // before anything is read or written (never a silent truncation).
      const items = normalizeDecisionItems(input?.items);
      const record = readBroadcast(bid);
      if (!record) {
        throw invalid(
          `没有交接 ${bid}：广播目录下没有该记录（bid 拼错，或已被 7 天保留策略清理）。未写入任何内容。`
        );
      }
      const me = String(context?.sessionID ?? '').trim();
      if (!me) {
        throw invalid('collab_decisions 需要会话上下文（sessionID）：无法确认发起方/承接方身份。未写入任何内容。');
      }
      if (!canWriteDecisions(record, me)) {
        throw invalid(
          `拒绝写入：当前会话 ${me} 既不是 ${bid} 的发起方（from.sid=${String(record.from?.sid ?? '-')}）` +
            `，也不是承接方（claim.by=${String(record.claim?.by ?? '-')}）。` +
            '决策只允许本单这两方写；第三方 0 写入（要读请用 collab_status { bid }）。'
        );
      }

      const existing = decisionHistoryOf(record);
      const existingIds = new Set(existing.map(entry => entry.id));
      const merged = mergeDecisions(record, items, { at: Date.now(), by: me });
      if (merged.decisions.length > DECISION_KEEP) {
        throw invalid(
          `拒绝写入：${bid} 写入后会到 ${merged.decisions.length} 条决策，超过上限 ${DECISION_KEEP}` +
            `（本次新增 ${merged.added} 条；覆盖已有 id 不增加条数）。未写入任何内容（不静默淘汰旧决策）。`
        );
      }

      const summary = [
        `决策 ${existing.length} → ${merged.decisions.length} 条（上限 ${DECISION_KEEP}；新增 ${merged.added}，覆盖 ${merged.replaced}）`,
        ...items.map(item => `${itemLine(item)}${existingIds.has(item.id) ? '（覆盖）' : ''}`)
      ];

      if (input?.confirm !== true) {
        return {
          content: [
            '未写入（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。',
            `bid=${bid}  state=${record.state ?? 'open'}`,
            ...summary,
            '预览不投递、不改 state / claim / receipt / replies；只读拉取用 collab_status { bid }。'
          ].join('\n')
        };
      }

      // Re-read so a concurrent write (a receipt, an ack stamp, another
      // decision) is not clobbered — and re-check both gates against the fresh
      // record: the claimant may have changed, or the cap may have been reached.
      const fresh = readBroadcast(bid) ?? record;
      if (!canWriteDecisions(fresh, me)) {
        throw invalid(`拒绝写入：${bid} 在写入前变成了不是你参与的单（from / claim.by 已变）。未写入任何内容。`);
      }
      const applied = mergeDecisions(fresh, items, { at: Date.now(), by: me });
      if (applied.decisions.length > DECISION_KEEP) {
        throw invalid(
          `拒绝写入：${bid} 写入后会到 ${applied.decisions.length} 条决策，超过上限 ${DECISION_KEEP}（并发写入）。` +
            '未写入任何内容（不静默淘汰旧决策）。'
        );
      }
      const written = writeBroadcast({ ...fresh, decisions: applied.decisions });
      return {
        content: [
          `已写入决策：${bid} 决策 ${decisionHistoryOf(written).length} 条（本次新增 ${applied.added}，覆盖 ${applied.replaced}；上限 ${DECISION_KEEP}）`,
          ...items.map(itemLine),
          `未投递、未改 state / claim / receipt / replies（state=${written.state ?? 'open'}）。`,
          `下游拉取：collab_status { bid:"${bid}" }（最近 3 条）；承接方注入只带一行计数。`
        ].join('\n')
      };
    }
  };
}
