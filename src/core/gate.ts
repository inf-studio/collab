/**
 * 0.9.2 (`11-20-collab-gate`) — **the plugin does not judge; the session does.**
 *
 * The first draft matched keywords (`mission.outOfScope` entries, aliases) against
 * the bid text. The review killed it: `排钟 Redis 缓存键设计` was refused for a
 * session whose `outOfScope` contained `ws集群` (the word `redis` was configured
 * as an alias of it), and a generic plugin has no business hard-coding a
 * workspace's domain words. Substring matching cannot tell "we are not doing the
 * ws cluster" from "we are debugging redis while doing 排钟".
 *
 * So the gate now only **forces a statement and records it**:
 *
 *   - `accept` on a session whose `mission.outOfScope` is **non-empty** must
 *     carry `scopeCheck:{ inScope: boolean, reason? }` — the claimant's own
 *     judgement of *this* bid. No statement → refused, with the two
 *     copy-pasteable calls (and the override form) in the refusal.
 *     `inScope:false` → refused, pointing at `mission.handoffTo`; a human
 *     override (`{reason, approvedBy}`, `approvedBy` not a `ses_…` id) is the
 *     only way through. `inScope:true` → accepted.
 *     Every statement (true or false, override or not) is appended to
 *     `collab-audit.jsonl` as `{at,sid,kind,bid,inScope,reason,verifiedBy,approvedBy?}`.
 *   - No contract, or an empty `outOfScope` → no statement is required and the
 *     call behaves exactly like 0.9.1 (byte for byte).
 *   - `broadcast` / `handoff` **never** ask for a statement and **never** refuse:
 *     handing work out is how a list gets shorter, not how a session drifts.
 *   - `reply` / `send` are not checked at all (answering does not widen anything).
 *
 * The overflow rule is a **reminder**, not a wall: 8+ open todos appends one line
 * to the result ("先处理再继续") and lets the action through — refusing a
 * hand-off because the list is long would block the one way to shorten it.
 *
 * `gate` in `collab.json` is the rollback switch: `enforce` (default) applies the
 * statement rule, `warn` demotes the refusals to a printed warning (still
 * audited), `off` skips everything (no refuse, no warning, no audit line).
 *
 * Honest boundary: this intercepts **collaboration actions only** — a `bash`
 * write into another workspace is invisible here.
 */

import { GATE_MODES, GATE_TODO_LIMIT } from '../constants.ts';
import type { CollabConfig } from '../types.ts';
import { asObject, dedupe, truncate } from '../util.ts';
import { appendGateAudit } from './audit.ts';
import { openTodos } from './contract.ts';
import type { Contract } from './contract.ts';

export type GateKind = 'accept' | 'broadcast' | 'handoff' | 'reply' | 'send';
export type GateMode = 'enforce' | 'warn' | 'off';
export type GateVerdictValue = 'allow' | 'deny' | 'warn';
/** Who vouched for the statement: the model itself, or a human override. */
export type GateVerifiedBy = 'model' | 'override';

/** The one config field the gate reads (`collab.json`). */
export type GateConfig = Pick<CollabConfig, 'gate'>;

/**
 * The claimant's own answer to "is this bid inside my boundary?" — the only
 * scope input the gate has. `reason` is kept in the audit line (it is the
 * claimant's words, not a judgement made by the plugin).
 */
export interface ScopeCheck {
  inScope: boolean;
  reason?: string;
}

export interface GatePayload {
  /** Broadcast id (`b_…`) — the audit key and the copy-paste commands. */
  bid?: string;
  /** `accept` only: the required statement when `outOfScope` is non-empty. */
  scopeCheck?: unknown;
  /** `accept` only: `{ reason, approvedBy }` for a human-approved excursion. */
  override?: unknown;
}

export interface GateVerdict {
  verdict: GateVerdictValue;
  /** `SCOPE_UNSTATED` / `SCOPE_OUT` / `OVERRIDE_INVALID` / `GATE_WARN`. */
  code?: 'SCOPE_UNSTATED' | 'SCOPE_OUT' | 'OVERRIDE_INVALID' | 'GATE_WARN';
  /** One paragraph: what happened and what to do instead. */
  reason: string;
  /** Where to hand the bid instead (`mission.handoffTo`), when configured. */
  handoffTo?: string;
  /** Copy-pasteable override command (a `scopeCheck.inScope:false` refusal). */
  overrideUsage?: string;
  /** The lines a tool prints (`''` when nothing to say). */
  content: string;
  /** The one trailing line a tool prints **last** (overflow reminder). */
  reminder?: string;
  /** `openTodos(contract)` — the reminder count. */
  openCount?: number;
  /** The recorded statement (`undefined` when none was made). */
  statement?: {
    inScope: boolean;
    reason: string;
    verifiedBy: GateVerifiedBy;
    approvedBy?: string;
  };
}

export interface GateOptions {
  /** The acting session — audit only. */
  sid?: string;
  /** `false` for a preview: nothing happened, so nothing is audited. Default `true`. */
  audit?: boolean;
  now?: number;
}

/** Anything unrecognised falls back to `enforce` (a typo must not disable the gate). */
export function normalizeGateMode(value: unknown): GateMode {
  const text = String(value ?? '').trim();
  return GATE_MODES.includes(text) ? (text as GateMode) : 'enforce';
}

function parseScopeCheck(raw: unknown): {
  provided: boolean;
  ok: boolean;
  inScope: boolean;
  reason: string;
  problem: string;
} {
  if (raw === undefined || raw === null) {
    return { provided: false, ok: false, inScope: false, reason: '', problem: '' };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      provided: true,
      ok: false,
      inScope: false,
      reason: '',
      problem: 'scopeCheck 必须是对象 { inScope, reason? }'
    };
  }
  const value = asObject(raw);
  if (typeof value.inScope !== 'boolean') {
    return {
      provided: true,
      ok: false,
      inScope: false,
      reason: '',
      problem: 'scopeCheck.inScope 必须是布尔值（true = 在边界内，false = 在边界外）'
    };
  }
  return {
    provided: true,
    ok: true,
    inScope: value.inScope,
    reason: truncate(value.reason, 200),
    problem: ''
  };
}

/** `{ reason, approvedBy }` — `provided` is the only thing a call site branches on. */
function parseOverride(raw: unknown): {
  provided: boolean;
  ok: boolean;
  reason: string;
  approvedBy: string;
  problem: string;
} {
  if (raw === undefined || raw === null) {
    return { provided: false, ok: false, reason: '', approvedBy: '', problem: '' };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      provided: true,
      ok: false,
      reason: '',
      approvedBy: '',
      problem: 'override 必须是对象 { reason, approvedBy }'
    };
  }
  const value = asObject(raw);
  const reason = String(value.reason ?? '').trim();
  const approvedBy = String(value.approvedBy ?? '').trim();
  const base = { provided: true, reason, approvedBy };
  if (!reason && !approvedBy) return { ...base, ok: false, problem: 'override 缺 reason 与 approvedBy（两者都必填）' };
  if (!reason) return { ...base, ok: false, problem: 'override 缺 reason（为什么必须越界做，一句话）' };
  if (!approvedBy) {
    return { ...base, ok: false, problem: 'override 缺 approvedBy（必须是人类标识，不是 ses_ 会话 id）' };
  }
  if (/^ses_/i.test(approvedBy)) {
    return {
      ...base,
      ok: false,
      problem: `override.approvedBy 不得以 ses_ 开头（"${truncate(approvedBy, 40)}" 是会话 id，必须由人类批准）`
    };
  }
  return { ...base, ok: true, problem: '' };
}

/** Every distinct hand-off target of `mission.handoffTo`, in config order. */
function handoffTargets(handoffTo: Record<string, string> | undefined): string[] {
  return dedupe(Object.values(asObject(handoffTo)).map(value => String(value ?? '').trim()));
}

/**
 * The gate. `contract` is the **acting** session's own contract (its
 * `outOfScope` decides whether a statement is required; its open todos feed the
 * reminder).
 *
 * Side effect: one audit line per **statement** (unless `options.audit === false`).
 * Nothing else is written and nothing is inferred from text.
 */
export function evaluate(
  kind: GateKind,
  payload: GatePayload | undefined,
  contract: Contract | undefined,
  config?: Partial<GateConfig> | undefined,
  options: GateOptions = {}
): GateVerdict {
  const mode = normalizeGateMode(config?.gate);
  const openCount = contract ? openTodos(contract).length : 0;
  // `off` is a true rollback switch: no checks, no warnings, no audit lines.
  if (mode === 'off') {
    return { verdict: 'allow', reason: '闸门已关闭（gate:"off"）', content: '', openCount };
  }
  // Overflow is a nudge, never a wall — refusing the hand-off would block the
  // one action that shortens the list. One line, printed last by the caller.
  const reminder =
    openCount >= GATE_TODO_LIMIT
      ? `[溢出提醒] 你已有 ${openCount} 条协作待办；若这次接单/派活会把它们挂起，先处理再继续。`
      : undefined;
  const base: GateVerdict = {
    verdict: 'allow',
    reason: '允许',
    content: '',
    openCount,
    ...(reminder ? { reminder } : {})
  };
  /**
   * Append the audit line for one statement, then hand the verdict back. A
   * refused statement is still a statement: the record says `inScope:false`
   * whether the accept went through or not. No statement → no line.
   */
  const emit = (out: GateVerdict): GateVerdict => {
    if (options.audit !== false && out.statement) {
      appendGateAudit({
        at: options.now ?? Date.now(),
        sid: String(options.sid ?? ''),
        kind,
        bid: String(payload?.bid ?? '').trim(),
        inScope: out.statement.inScope,
        reason: out.statement.reason,
        verifiedBy: out.statement.verifiedBy,
        ...(out.statement.approvedBy ? { approvedBy: truncate(out.statement.approvedBy, 80) } : {})
      });
    }
    return out;
  };
  // Answering / sending does not widen a boundary (R4), and handing work out is
  // how a list gets shorter: neither ever requires a statement (R3).
  if (kind !== 'accept') {
    return { ...base, reason: kind === 'reply' || kind === 'send' ? '回复不校验边界（R4）' : '派活不需要表态（插件不做语义判断）' };
  }

  const outOfScope = contract?.mission?.outOfScope ?? [];
  if (!outOfScope.length) {
    // The 0.9.1 path: no boundary configured, nothing to declare, nothing recorded.
    return { ...base, reason: '未设置 outOfScope：不需要表态' };
  }

  const bid = String(payload?.bid ?? '').trim() || 'b_<hex16>';
  const scopeText = truncate(outOfScope.join(' / '), 120);
  const usage =
    `collab_accept { bid:"${bid}", scopeCheck:{ inScope:false, reason:"<为什么不接>" }, confirm:true }`;
  const inScopeCall = `collab_accept { bid:"${bid}", scopeCheck:{ inScope:true }, confirm:true }`;
  const overrideUsage =
    `collab_accept { bid:"${bid}", scopeCheck:{ inScope:false, reason:"<为什么必须你做>" }, ` +
    'override:{ reason:"<为什么必须你做>", approvedBy:"<人类标识>" }, confirm:true }';
  const targets = handoffTargets(contract?.mission?.handoffTo);
  const handoffTo = targets.length === 1 ? targets[0] : undefined;
  const handoffLine = targets.length
    ? `转交 ${targets.join(' / ')}（mission.handoffTo）`
    : '转交 owner（mission.handoffTo 未配置：先 collab_mission { action:"set", handoffTo:{ "<边界>":"ses_…" } }）';

  const check = parseScopeCheck(payload?.scopeCheck);
  if (!check.ok) {
    // No (or malformed) statement: refuse and hand back the exact calls. The
    // plugin deliberately makes no guess about which side of the boundary this
    // bid is on — only the session itself can answer that.
    const problem = check.provided ? `${check.problem}。` : '';
    const out: GateVerdict = {
      verdict: 'deny',
      code: 'SCOPE_UNSTATED',
      reason:
        `拒绝领取：本会话 mission.outOfScope 非空（${scopeText}），接单前必须表态这条是否在边界内` +
        `——插件不做语义判断（没有关键词/别名匹配），只负责逼你表态并记录。${problem}`,
      ...(handoffTo ? { handoffTo } : {}),
      overrideUsage,
      content: [
        `拒绝领取（本条未表态）：本会话 mission.outOfScope 非空（${scopeText}），接单前必须表态这条是否在边界内——` +
          '插件不做语义判断，只负责逼你表态并记录。',
        ...(problem ? [`  ${problem}`] : []),
        '  原样再调一次，二选一：',
        `    ${usage}`,
        `    ${inScopeCall}`,
        `  确需你越界接（需人类批准）：${overrideUsage}`,
        '  override 的 reason / approvedBy 都必填；approvedBy 必须是人类标识，不得以 ses_ 开头。',
        '  降级开关：collab.json 的 gate:"warn"（只提示不拦）或 gate:"off"（不校验）。'
      ].join('\n'),
      openCount,
      ...(reminder ? { reminder } : {})
    };
    return mode === 'warn' ? demote(out) : out;
  }

  const statementReason = check.reason || (check.inScope ? 'inScope:true' : 'inScope:false');
  if (check.inScope) {
    return emit({
      ...base,
      reason: `已记录表态：本条在边界内（inScope:true${check.reason ? `：${check.reason}` : ''}）→ 已写入 collab-audit.jsonl。`,
      content:
        `已记录表态：本条在你的边界内（inScope:true${check.reason ? `：${truncate(check.reason, 80)}` : ''}）` +
        '——已写入 collab-audit.jsonl。',
      statement: { inScope: true, reason: statementReason, verifiedBy: 'model' }
    });
  }

  // `inScope:false`: the session itself says this is outside its boundary.
  const override = parseOverride(payload?.override);
  if (override.ok) {
    return emit({
      ...base,
      reason:
        `已放行：你判定本条在边界外（${truncate(statementReason, 80)}），由 ${truncate(override.approvedBy, 40)} ` +
        '批准 override——已写入 collab-audit.jsonl。',
      handoffTo,
      overrideUsage,
      content:
        `已放行（override）：你判定本条在边界外，由 ${truncate(override.approvedBy, 40)} 批准` +
        '——已写入 collab-audit.jsonl（verifiedBy:"override"）。',
      statement: {
        inScope: false,
        reason: statementReason,
        verifiedBy: 'override',
        approvedBy: override.approvedBy
      }
    });
  }

  const problem = override.provided ? `override 无效：${override.problem}。` : '';
  const out: GateVerdict = {
    verdict: 'deny',
    code: override.provided ? 'OVERRIDE_INVALID' : 'SCOPE_OUT',
    reason:
      `拒绝领取：你判断这条在边界外（inScope:false${check.reason ? `：${truncate(check.reason, 60)}` : ''}）` +
      `——未领取、未改状态。${problem}`,
    ...(handoffTo ? { handoffTo } : {}),
    overrideUsage,
    content: [
      `拒绝领取：你判断这条在边界外（inScope:false${check.reason ? `：${truncate(check.reason, 60)}` : ''}）——未领取、未改状态。`,
      ...(problem ? [`  ${problem}`] : []),
      `  正确动作：${handoffLine} / 明确不做 / 问 owner`,
      `  确需你亲自做（需人类批准）：${overrideUsage}`,
      '  override 的 reason / approvedBy 都必填；approvedBy 必须是人类标识，不得以 ses_ 开头。'
    ].join('\n'),
    openCount,
    statement: { inScope: false, reason: statementReason, verifiedBy: 'model' },
    ...(reminder ? { reminder } : {})
  };
  return emit(mode === 'warn' ? demote(out) : out);
}

/** `gate:"warn"`: keep the text (and the audit), drop the refusal. */
function demote(out: GateVerdict): GateVerdict {
  return {
    ...out,
    verdict: 'warn',
    code: 'GATE_WARN',
    reason: `[gate="warn" 只提示不拦截] ${out.reason}`,
    content: ['[gate="warn"：只提示不拦截，动作照常执行]', out.content].join('\n')
  };
}
