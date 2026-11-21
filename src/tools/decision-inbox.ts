/**
 * `collab_decision_inbox` (0.9.7, `11-21-collab-decision-inbox`) — the **human**
 * read of the decision ledger (tool count 28 → 29).
 *
 * 0.9.5 put every decision in `collab-decisions/<key>.json`, but only the parties
 * could see it: `[decide]` goes to the asker / owner, and `collab_decide list`
 * needs a `key`. "What is waiting on me right now?" was answered by opening each
 * session — the human was a router, not a decision maker.
 *
 * This tool is one read-only list of every `status: "open"` decision, oldest
 * wait first: `<key>#<D#> · 等 <owner|人工> · <age> · [⚠冲突（TTL 剩 …）·] <question>`.
 * It writes nothing — no answer, no supersede, no delivery, no queue, and a
 * missing ledger directory is an empty answer instead of a `mkdir` (R5). Answering
 * still happens in the session that owns the decision (`collab_decide answer`, or
 * the user clicking the row in the board, which only opens that session).
 *
 * The derivation is `core/decision-inbox.ts` — the very function that feeds the
 * snapshot block, so the GUI / TUI count cannot disagree with this tool.
 */
import { DECISION_INBOX_LIMIT, DECISION_INBOX_SCAN_LIMIT } from '../constants.ts';
import { decisionInbox, formatDecisionInbox } from '../core/decision-inbox.ts';
import type { ToolDefinition } from '../types.ts';
import { clamp } from '../util.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

export function decisionInboxTool(_kit: ToolKit): ToolDefinition {
  return {
    name: 'collab_decision_inbox',
    description:
      'Read-only list of **every open decision** in the ledger (`collab-decisions/*.json`), oldest wait ' +
      'first — the human answer to "what is waiting on me?". Each row is ' +
      '`<key>#<D#> · 等 <owner|人工> · <age> · <question>`; a conflict escalation adds ' +
      '`⚠冲突（TTL 剩 …）` (its remaining 24h before the automatic supersede; an expired one shows no TTL). ' +
      `Default ${DECISION_INBOX_LIMIT} rows, then "还有 N 条"; the header counts the open decisions of the ` +
      `scanned ledger and the footer says how many of them are conflicts. Reading is bounded to ` +
      `${DECISION_INBOX_SCAN_LIMIT} ledger files; past that the answer says "已扫描 M/N 个 key" and warns ` +
      '"⚠账本 N 个 key，仅扫描 M 个（可能漏更老待办）" instead of presenting the subset as the whole ledger. ' +
      '`owner` keeps only the decisions waiting on that ' +
      'session (`ses_…`). Writes nothing — no answer / supersede / delivery / queue, and a missing ledger ' +
      'directory is an empty answer (the directory is never created). Answer in the session itself with ' +
      'collab_decide { action:"answer" }.',
    input: jsonInput({
      properties: {
        owner: {
          type: 'string',
          description: 'Optional: only the decisions waiting on this session (`ses_…`). Omit for all of them.'
        },
        limit: {
          type: 'number',
          description: `Optional: how many rows to show (default ${DECISION_INBOX_LIMIT}). The totals still count every open decision.`
        }
      },
      required: []
    }),
    async execute(input) {
      const owner = String(input?.owner ?? '').trim();
      const limit = clamp(input?.limit ?? DECISION_INBOX_LIMIT, 1, 200);
      const inbox = decisionInbox({ owner: owner || undefined });
      return { content: formatDecisionInbox(inbox, { owner, limit }) };
    }
  };
}
