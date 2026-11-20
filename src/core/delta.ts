/**
 * 0.9.6 (`11-20-collab-pacing`, R3): "does this turn have anything new?"
 *
 * The rule the PRD states is narrow and conservative: a turn that carries **no
 * new fact, no status change, no evidence and no answer** is not a message — it
 * is a status update (`collab_status` shows `noopCount` / `lastNoopAt`). The
 * point is the measured failure: 69% of the 624 messages were full state
 * mirrors, and not one was a short receipt.
 *
 * Two properties matter more than the accuracy of the four sources:
 *
 *   1. **Never suppress something that could be news.** An answer to an
 *      unanswered request, a hand-off line (`[handoff] …`), a structured
 *      BLOCKED report and anything explicitly forced are deltas by definition.
 *      A false *keep* costs one message; a false *suppress* loses information.
 *   2. **Nothing here is inferred from prose.** The four sources are structured
 *      values (cited `factIds`, the contract's todo/milestone state, the
 *      thread's own request/reply order) — the same "no text matching" rule the
 *      gate follows. The only body check is the protocol marker `[handoff]`.
 *
 * A suppressed turn never advances the baseline: the counterpart did not
 * receive anything, so the next real change is still measured against what it
 * actually has.
 */
import { createHash } from 'node:crypto';
import type { Contract } from './contract.ts';
import type { DeltaSnapshot, DeltaVerdict } from '../types.ts';

/** A `[handoff] DONE|BLOCKED …` line — a protocol marker, not prose. */
const HANDOFF_LINE_RE = /\[handoff\]/i;
/**
 * A `decision:<key>#D2` reference — the decision ledger's own scope syntax
 * (0.9.5). A message that carries one is reporting an answered decision, which
 * the PRD lists as an increment by definition ("决策 answer 一律算有增量").
 * Again a protocol token, not a keyword: prose like 「决定」 never matches.
 */
const DECISION_REF_RE = /\bdecision:[A-Za-z0-9_.#-]+/;

/**
 * A stable fingerprint of "the state this session would mirror": todo statuses,
 * mission state and the plan's progress. Order-independent (sorted), so two
 * equal states hash equally.
 */
export function todoStatusHash(contract?: Contract): string {
  if (!contract) return '';
  const todos = [...(contract.todos ?? [])]
    .map(todo => `${todo.id}:${todo.status}`)
    .sort()
    .join(',');
  const milestones = (contract.plan?.milestones ?? [])
    .map(milestone => `${milestone.id}:${milestone.done ? 1 : 0}`)
    .sort()
    .join(',');
  const advance = Number(contract.plan?.lastAdvancedAt) || 0;
  const empty = !todos && !milestones && !advance && (contract.mission?.state ?? 'active') === 'active';
  if (empty) return '';
  return createHash('sha256')
    .update(`${contract.mission?.state ?? 'active'}|${todos}|${milestones}|${advance}`)
    .digest('hex')
    .slice(0, 16);
}

/** The baseline recorded after a message was really delivered. */
export function deltaSnapshot(input: {
  contract?: Contract;
  factIds?: string[];
  now?: number;
}): DeltaSnapshot {
  const contract = input.contract;
  return {
    facts: [...new Set((input.factIds ?? []).map(String))].sort(),
    todoHash: todoStatusHash(contract),
    advancedAt: Number(contract?.plan?.lastAdvancedAt) || 0,
    decisionAt: Number(contract?.turn?.decisionAt) || 0,
    at: Number(input.now) || Date.now()
  };
}

export interface DeltaInput {
  kind: string;
  /** Facts cited by this message (0.9.4 `factIds`). */
  factIds?: string[];
  /** Full body — only the `[handoff]` protocol marker is inspected. */
  body?: string;
  /** The sender's contract (todos / milestones / mission state). */
  contract?: Contract;
  /** The baseline of the last **delivered** message of this session. */
  last?: DeltaSnapshot;
  /** This reply answers the thread's open request (never suppressed). */
  answersOpen?: boolean;
  /** Structured alert: `blocked` report / a hand-off / `force:true`. */
  urgent?: boolean;
}

/**
 * The four sources + the two "always news" escape hatches. `any:false` is the
 * only value that suppresses a message.
 */
export function computeDelta(input: DeltaInput): DeltaVerdict {
  const last = input.last;
  const lastFacts = new Set(last?.facts ?? []);
  const newFacts = (input.factIds ?? []).map(String).filter(id => id && !lastFacts.has(id));
  const hasNewFact = newFacts.length > 0;

  const hash = todoStatusHash(input.contract);
  const hasStatusChange = Boolean(hash) && hash !== String(last?.todoHash ?? '');

  const advancedAt = Number(input.contract?.plan?.lastAdvancedAt) || 0;
  const decisionAt = Number((input.contract as Contract | undefined)?.turn?.decisionAt) || 0;
  // Progress lit *or* a decision answered by this session since the last
  // delivered message — both are "本轮证据".
  const hasEvidence =
    advancedAt > (Number(last?.advancedAt) || 0) || decisionAt > (Number(last?.decisionAt) || 0);

  const hasAnswer = Boolean(input.answersOpen);
  const body = String(input.body ?? '');
  const urgent =
    Boolean(input.urgent) || HANDOFF_LINE_RE.test(body) || DECISION_REF_RE.test(body);

  const why: string[] = [];
  if (hasNewFact) why.push(`fact:${newFacts.slice(0, 3).join(',')}`);
  if (hasStatusChange) why.push('todo');
  if (hasEvidence) why.push('advance');
  if (hasAnswer) why.push('answer');
  if (urgent) why.push('urgent');

  return {
    hasNewFact,
    hasStatusChange,
    hasEvidence,
    hasAnswer,
    urgent,
    any: why.length > 0,
    why
  };
}

/**
 * One line for the receipt of a suppressed turn: it must say **what** was
 * withheld and how to force it, never only "没有发送".
 */
export function noDeltaLine(input: {
  kind: string;
  threadID?: string;
  target: string;
  factIds?: string[];
  windowMs: number;
}): string {
  const facts = (input.factIds ?? []).filter(Boolean);
  return [
    `未发送（无增量）：本轮没有任何新东西可告诉 ${input.target}` +
      `（kind=${input.kind}${input.threadID ? ` thread=${input.threadID}` : ''}）。`,
    '判定口径（四类，全为否就只更新状态）：新事实（factIds 里有未发过的 id）· 状态变化（todo/里程碑/主线）· ' +
      '本轮证据（collab_progress 点亮）· 回答未答问题；告警 / BLOCKED / [handoff] 一律放行。',
    facts.length
      ? `引用的事实 ${facts.join(',')} 都已经发过 —— 如果确有新结论，先 collab_fact settle 一个新 F#，或换一条新消息。`
      : '如果这条确实是新消息（只是没有结构化载体）：force:true 强制发送，或先用 collab_fact settle / collab_todo / collab_progress 留下增量。',
    '状态已记入本会话契约：collab_status 可看到 noopCount / lastNoopAt（本轮未产生消息，也没有写 thread）。',
    `关掉这个口径：collab.json 里 suppressNoDelta:false（或本会话显式 force:true）。当前窗口 windowMs=${input.windowMs}。`
  ].join('\n');
}
