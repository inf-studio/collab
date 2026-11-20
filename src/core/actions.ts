/**
 * 0.8.0 (`board2-actions`): the four **write actions** of the collaboration
 * board — escalate / freeze / unfreeze / archive — in one place.
 *
 * 0.6.0 (`collab_escalate`, `collab_freeze`) and 0.5.0 (`collab_archive`) said
 * what each action *is*; this module is the orchestration both entry points run:
 *
 *   - the native tools (`src/tools/{escalate,freeze,archive}.ts`) call
 *     `escalateAction` / `freezeAction` / `archiveAction` with the caller's
 *     `confirm` (a tool preview is `confirm:false` → zero writes);
 *   - the desktop board (`collab.state.escalate|freeze|unfreeze|archive`, RPC)
 *     calls **the same functions** with `confirm:true` — the confirmation is the
 *     GUI dialog, not the RPC payload.
 *
 * There is deliberately **no second rule set** here:
 *
 *   - the protected guard (`BUILTIN_PROTECT` + lineage, `core/lineage.ts`);
 *   - the read-only-agent demotion (`explore` / `plan` → `queue`, forced);
 *   - the freeze-before-escalate precedence (`core/freeze.ts`);
 *   - the `[protected*]` archive refusal (`core/archive.ts` callers);
 *   - the 5-minute `bid + reason` escalation window and the read-merge-write
 *     annotations — all live where they lived before, and are reached from
 *     exactly one implementation (this file).
 *
 * One entry-point policy is genuinely different, and is an option rather than a
 * rule: a **protected target** of an escalation. The tool keeps the 0.6.0 shape
 * (one `priority:"urgent"` owner-queue item, 0 prompts — the compliant *pull*
 * channel); the board refuses (`protected:"refuse"`) because a GUI click must
 * not create queue items either: 0 prompts **and** 0 queue writes.
 *
 * The tool text is produced here verbatim (the harness pins it), and each result
 * also carries one short `detail` line + a resolved `target`, which is what the
 * RPC returns (`ActionReceipt`) and what the audit line records.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { AUDIT_FILE, BCAST_DONE_STATES } from '../constants.ts';
import { isValidThreadID, newCorrelationID, normalizeThreadID } from '../ids.ts';
import { errText, log } from '../log.ts';
import type {
  BroadcastRecord,
  CollabConfig,
  CollabContext,
  FreezeDelivery,
  FreezeEntry,
  SessionInfoLike,
  SessionPromptInput,
  SessionPromptResult
} from '../types.ts';
import { asObject, fmtTime, sessionState, shortID, truncate } from '../util.ts';
import { deliveryOf } from './ack.ts';
import { archiveSession, spawnedSessionID } from './archive.ts';
import { allBroadcasts, isValidBid, mergeArchive, readBroadcast, writeBroadcast } from './claim.ts';
import { invalid, deliveryFailure } from './errors.ts';
import {
  FREEZE_FILE,
  freezeDenyText,
  frozenBy,
  mergeFreezes,
  parseUntil,
  readFreezes,
  sanitizeFreezeReason
} from './freeze.ts';
import { createLineage } from './lineage.ts';
import { fmtTtl } from './locks.ts';
import { enqueue, listFor, queueDir, queueID } from './owner-queue.ts';
import { recordMessage } from './index-db.ts';
import { makeEnvelope } from './envelope.ts';

/* ----------------------------------------------------------------- contract */

/** What an action resolved to (`ses_…` / `b_…` / an absolute workspace path). */
export interface ActionTarget {
  sessionID: string;
  alias?: string;
  info: SessionInfoLike;
}

/** The delivery the caller asked for, and whether a gate overrode it. */
export interface ActionMode {
  mode: string;
  forced: boolean;
}

/**
 * Everything the actions need from their caller. `ToolKit` satisfies it
 * (`index.ts` builds the same shape for the RPC from the same kit), so a tool
 * and the board never resolve a target / a mode differently.
 */
export interface ActionContext {
  ctx: CollabContext;
  readConfig(): CollabConfig;
  resolveTarget(raw: unknown): Promise<ActionTarget>;
  resolveMode(requested: unknown, agent: unknown): ActionMode;
  senderLabel(sessionID: string | undefined): string;
  listSessions(input?: { directory?: string; limit?: number }): Promise<SessionInfoLike[]>;
}

export type ActionName = 'escalate' | 'freeze' | 'unfreeze' | 'archive' | 'restore';

/** One action run. `content` is the tool text; `detail` is the one-line verdict. */
export interface ActionResult {
  ok: boolean;
  /** `confirm:false` — nothing was written (the tools' preview). */
  preview: boolean;
  action: ActionName;
  target: string;
  detail: string;
  content: string;
}

interface ActionResultInput {
  action: ActionName;
  target: string;
  ok?: boolean;
  preview?: boolean;
  detail?: string;
  lines: string[];
}

/** Build one result from the same lines the tools always printed. */
function actionResult({ action, target, ok = true, preview = false, detail, lines }: ActionResultInput): ActionResult {
  const content = lines.filter(Boolean).join('\n');
  return {
    ok,
    preview,
    action,
    target,
    detail: String(detail ?? '').trim() || content.split('\n')[0] || '',
    content
  };
}

/* -------------------------------------------------------------------- audit */

/** One append-only line of `~/.config/opencode/collab-audit.jsonl` (R5). */
export interface AuditEntry {
  at: number;
  actor: string;
  action: string;
  target: string;
  ok: boolean;
  reason: string;
}

/**
 * R5: append one line, never rotate, never throw. A collaboration action that
 * already happened must not be reported as failed because the audit file could
 * not be written — a failure is one log line instead.
 *
 * The line is one JSON object per line: `JSON.stringify` escapes newlines, so a
 * reason can never split an entry into two.
 */
export function appendAudit(entry: AuditEntry): void {
  try {
    mkdirSync(dirname(AUDIT_FILE), { recursive: true });
    appendFileSync(AUDIT_FILE, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    log(`audit write failed: ${errText(error)}`);
  }
}

/* ---------------------------------------------------------------- escalate */

/** R5: the idempotency window — one `bid` + one `reason`, 5 minutes. */
const URGENT_WINDOW_MS = 5 * 60_000;
/** R1: `reason` is one short line, not a paragraph. */
const REASON_LIMIT = 200;
/** The `[URGENT]` prefix every delivered escalation carries. */
export const URGENT_PREFIX = '[URGENT]';

const isClosed = (record: BroadcastRecord): boolean => BCAST_DONE_STATES.includes(String(record.state));

/** `updatedAt` desc, bid as the tie-break so two writes in one ms stay stable. */
const newestFirst = (left: BroadcastRecord, right: BroadcastRecord): number =>
  (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0) || String(left.bid).localeCompare(String(right.bid));

/**
 * The session that owes the answer: the claimant, the one being asked, or the
 * target of the takeover message. Same precedence as `collab_status`.
 */
const addresseeOf = (record: BroadcastRecord): string =>
  String(record.claim?.by ?? '') || String(record.asked?.sid ?? '') || String(deliveryOf(record).to ?? '');

/**
 * R1: control characters (including newlines) become spaces, runs collapse, the
 * result is capped at `REASON_LIMIT`. The reason is rendered in a receipt and in
 * a prompt, so it must never introduce a second line.
 */
export function sanitizeReason(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REASON_LIMIT);
}

/** `第 1/2 位（未读）` of the target's unread queue. */
function queuePosition(itemID: string, targetSid: string): string {
  const unread = listFor(targetSid).filter(item => !item.seenAt);
  const index = unread.findIndex(item => item.id === itemID);
  return index >= 0 ? `第 ${index + 1}/${unread.length} 位（未读）` : '未读（位置未知）';
}

/**
 * R2: merge the four urgent fields into the **current** record. Only those four
 * are written; `state` / `claim` / `receipt` / `delivery` stay exactly as they
 * are on disk (the prompt above is an `await`, and the counterpart may have
 * written a receipt meanwhile).
 */
function markUrgent(
  record: BroadcastRecord | undefined,
  patch: { at: number; reason: string; by: string }
): BroadcastRecord | undefined {
  if (!record) return undefined;
  const fresh = readBroadcast(record.bid);
  if (!fresh) return undefined; // pruned while we were delivering: never resurrect
  return writeBroadcast({
    ...fresh,
    priority: 'urgent',
    urgentAt: patch.at,
    urgentReason: patch.reason,
    urgentBy: patch.by
  });
}

export interface EscalateInput {
  /** The calling session (`context.sessionID`, or the RPC's `session`). */
  actor?: string;
  bid?: string;
  threadID?: string;
  session?: string;
  reason?: unknown;
  mode?: unknown;
  confirm?: boolean;
  /**
   * What a protected **target** does:
   *   - `queue` (default, the tool): one urgent owner-queue item, 0 prompts;
   *   - `refuse` (the board): a readable refusal, **nothing** written — 0
   *     prompts *and* 0 queue items (a GUI click is not a request).
   */
  protected?: 'queue' | 'refuse';
}

/**
 * `collab_escalate`'s orchestration — one target (`bid` / `threadID` /
 * `session`), a required reason, default `steer` (a read-only agent target is
 * forced back to `queue`), a protected target queued (tool) or refused (board),
 * the 5-minute idempotency window, and the four urgent fields on the record.
 */
export async function escalateAction(actions: ActionContext, input: EscalateInput): Promise<ActionResult> {
  const { ctx, readConfig, resolveTarget, resolveMode, senderLabel } = actions;
  const me = String(input.actor ?? '').trim();
  if (!me) throw invalid('缺少会话上下文（sessionID）：加急必须记录发起方，否则无法追溯。');

  // ------------------------------------------------------------- inputs
  const bid = String(input.bid ?? '').trim();
  const rawThread = String(input.threadID ?? '').trim();
  const sessionInput = String(input.session ?? '').trim();
  const given = [bid && 'bid', rawThread && 'threadID', sessionInput && 'session'].filter(Boolean) as string[];
  if (!given.length) {
    throw invalid('必须给 bid / threadID / session 之一：加急需要明确的目标交接单或会话。');
  }
  if (given.length > 1) {
    throw invalid(`collab_escalate 的 bid / threadID / session 三选一（本次收到 ${given.join(' + ')}）`);
  }
  if (bid && !isValidBid(bid)) {
    throw invalid(`bid 格式不合法：${JSON.stringify(bid)}（期望 b_ + 8–32 位十六进制）`);
  }
  const threadID = rawThread ? normalizeThreadID(rawThread) : undefined;
  if (rawThread && (!threadID || !isValidThreadID(threadID))) {
    throw invalid(`threadID 格式不合法：${JSON.stringify(rawThread)}（期望 t_<base36ts>_<rand>）`);
  }

  const rawReason = String(input.reason ?? '');
  const reason = sanitizeReason(rawReason);
  if (!reason) throw invalid('reason 不能为空：请给一句话说明为什么现在就要处理（≤200 字）');

  const config = readConfig();
  const now = Date.now();
  const confirmed = input.confirm === true;
  const requestsSteer = String(input.mode ?? '') !== 'queue';

  // ------------------------------------------------------------- target
  let record: BroadcastRecord | undefined;
  let targetSid = '';
  let scopeLine = '';

  if (bid) {
    record = readBroadcast(bid);
    if (!record) {
      throw invalid(`没有交接单 ${bid}：bid 可能拼错，或该单已闭环且过了 7 天保留期被回收。可用 collab_list 看全量。`);
    }
    targetSid = addresseeOf(record);
    if (!targetSid) {
      throw invalid(
        `交接单 ${bid} 还没有承接方 / 问询对象（state=${record.state ?? 'open'}）：没有可加急的会话。` +
          '先用 collab_broadcast 重新问询，或用 collab_send { target } 明确指定对象。'
      );
    }
    scopeLine =
      `交接: ${record.bid} state=${record.state ?? 'open'}` +
      `${record.threadID ? ` thread=${record.threadID}` : ''} 承接=${record.claim?.by ?? '-'}`;
  } else if (threadID) {
    const open = allBroadcasts()
      .filter(entry => String(entry.threadID ?? '') === threadID && !isClosed(entry))
      .sort(newestFirst);
    record = open[0];
    if (!record) {
      throw invalid(
        `thread ${threadID} 没有未闭环的交接单：threadID 可能拼错，或该 thread 的交接都已闭环。` +
          '可用 collab_status { threadID } 核对。'
      );
    }
    targetSid = addresseeOf(record);
    if (!targetSid) {
      throw invalid(`交接单 ${record.bid} 还没有承接方 / 问询对象：没有可加急的会话。`);
    }
    scopeLine = `交接: ${record.bid} state=${record.state ?? 'open'} thread=${threadID} 承接=${record.claim?.by ?? '-'}`;
  } else {
    const target = await resolveTarget(sessionInput);
    targetSid = target.sessionID;
    const open = allBroadcasts()
      .filter(entry => !isClosed(entry) && addresseeOf(entry) === targetSid)
      .sort(newestFirst);
    record = open[0];
    scopeLine = record
      ? `交接: ${record.bid} state=${record.state ?? 'open'}${record.threadID ? ` thread=${record.threadID}` : ''}`
      : '交接: -（该会话当前没有由它承接 / 被问询的未闭环交接；只加急会话，不标记记录）';
  }

  if (record && isClosed(record)) {
    throw invalid(
      `交接单 ${record.bid} 已闭环（state=${record.state}）：无需加急。` +
        '要看结论用 collab_status { bid } 或 collab_list。'
    );
  }
  if (targetSid === me) {
    throw invalid('拒绝加急：target 就是当前会话本身（不会给自己投递）。');
  }

  // 0.6.0 (`collab_freeze`): the freeze wins over the escalation — a frozen
  // object accepts no *new* collaboration, an urgent nudge included. The
  // refusal text names the exact `collab_freeze {freeze:false}` command.
  // The target is resolved first so a frozen **workspace** is caught too.
  const lineage = createLineage(ctx);
  const target = await resolveTarget(targetSid);
  const freeze = await frozenBy(
    {
      session: targetSid,
      bid: record?.bid,
      workspace: target.info?.location?.directory ?? record?.workspace
    },
    { lineage }
  );
  if (freeze) throw invalid(freezeDenyText(freeze));

  const guard = await lineage.protectedAncestor(targetSid, config.protect);
  const { mode, forced } = resolveMode(requestsSteer ? 'steer' : 'queue', target.info?.agent);
  const targetLine =
    `${targetSid}${target.alias ? ` (alias=${target.alias})` : ''}  agent=${target.info?.agent ?? '?'}  ` +
    `state=${sessionState(target.info)}  ${truncate(target.info?.title ?? '(untitled)', 60)}`;
  const protectedLine = guard
    ? `  受保护: ${guard.depth === 0 ? '[protected]' : `[protected-child depth=${guard.depth}]`} ${guard.sessionID}`
    : '';

  // R3 (board): a protected target is refused **before** any write — 0 prompts,
  // 0 queue items. The tool keeps the 0.6.0 queue path (see the module comment).
  if (guard && input.protected === 'refuse') {
    throw invalid(
      `拒绝加急：目标 ${targetSid} ${
        guard.depth === 0 ? '本身' : `的祖先（第 ${guard.depth} 级）${guard.sessionID} `
      }在 protect 名单内（collab.json 的 protect + 内置硬名单）。` +
        '看板动作不投递、也不写队列项（0 条 prompt / 0 队列项）；需要请求该会话请用 collab_request_owner。未写入任何内容。'
    );
  }

  // R5: the same bid + the same reason inside the window is one escalation.
  const already =
    Number(record?.urgentAt) > 0 &&
    String(record?.urgentReason ?? '') === reason &&
    now - Number(record?.urgentAt) <= URGENT_WINDOW_MS;
  const urgentBody = `${URGENT_PREFIX} ${reason}${
    record ? `\n(bid ${record.bid}${record.threadID ? ` / thread ${record.threadID}` : ''})` : ''
  }`;

  // ------------------------------------------------------------ preview
  if (!confirmed) {
    const lines = [
      '未加急（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。',
      `目标: ${targetLine}`,
      protectedLine,
      scopeLine,
      `reason: ${reason}`,
      already
        ? `注: 该单在 ${fmtTime(record?.urgentAt)} 已因同一 reason 加急过（5 分钟窗口内）：确认后只刷新 urgentAt，不重复投递。`
        : '',
      guard ? `模式: 不投递（受保护目标只能排队）` : `模式: ${mode}${forced ? '(forced)' : ''}${mode === 'steer' ? '  （并入目标当前轮）' : ''}`,
      guard
        ? `将写入: ${queueDir(targetSid)}/${queueID(now)}.json（priority:"urgent"）`
        : `将投递: ${urgentBody}`,
      '注: 加急只在记录上追加 priority / urgentAt / urgentReason / urgentBy，不改 state / claim / receipt。'
    ];
    return actionResult({
      action: 'escalate',
      target: targetSid,
      preview: true,
      detail: '仅预览（未加急）：确认后才会投递',
      lines
    });
  }

  // ------------------------------------------------ R5: idempotent repeat
  if (already) {
    const refreshed = markUrgent(record, { at: now, reason, by: me });
    const lines = [
      `已加急过（5 分钟内同 bid + 同 reason）：只刷新 urgentAt，未重复投递。`,
      `目标: ${targetLine}`,
      protectedLine,
      scopeLine,
      `urgentAt: ${fmtTime(now)}  reason: ${reason}`,
      refreshed ? `注: 记录 ${refreshed.bid} 的 urgentAt 已刷新（state / claim / receipt 未变）。` : '',
      '确实要再催一次：换一处措辞（reason 不同即视为新加急），或等 5 分钟窗口过去。'
    ];
    return actionResult({ action: 'escalate', target: targetSid, detail: lines[0], lines });
  }

  // ------------------------------------------------ protected → queue only
  if (guard) {
    const item = enqueue({
      target: targetSid,
      from: me,
      text: urgentBody,
      issuePath: record?.issuePath,
      bid: record?.bid,
      priority: 'urgent',
      now
    });
    const marked = markUrgent(record, { at: now, reason, by: me });
    const lines = [
      `受保护目标：未投递（0 条 prompt），已写入加急队列项 ${item.id}。`,
      `目标: ${targetLine}`,
      protectedLine,
      scopeLine,
      `摘要: ${item.summary}`,
      `canPush=false  队列位置: ${queuePosition(item.id, targetSid)}`,
      `文件: ${queueDir(item.target)}/${item.id}.json`,
      marked ? `记录: ${marked.bid} priority=urgent urgentAt=${fmtTime(now)}（state / claim / receipt 未变）。` : '',
      '注: 受保护会话及其子会话不接受任何投递（含 steer）；队列是 pull —— 对端下次运行会在自己的 context 注入里看到这一行。',
      record
        ? `下一步: 等其下一轮；位置用 collab_status { bid:"${record.bid}" } 查（撤回: collab_request_owner { id:"${item.id}", revoke:true, confirm:true }）`
        : `下一步: 等其下一轮；撤回: collab_request_owner { id:"${item.id}", revoke:true, confirm:true }`
    ];
    return actionResult({ action: 'escalate', target: targetSid, detail: lines[0], lines });
  }

  // ------------------------------------------------- deliver (steer/queue)
  const cid = newCorrelationID();
  let admitted: SessionPromptResult;
  try {
    admitted = await ctx.session.prompt({
      sessionID: targetSid,
      text: urgentBody,
      delivery: mode,
      metadata: {
        collab: {
          from: senderLabel(me),
          fromSessionID: me,
          cid,
          kind: 'note',
          threadID: record?.threadID,
          ts: now,
          urgent: true
        }
      }
    } as SessionPromptInput);
  } catch (error) {
    // Same classification `dispatch` uses: a refused prompt is a delivery defect,
    // never a generic `Error` (the wrapper in `tools/shared.ts` did this before).
    throw deliveryFailure(error);
  }
  // 0.9.0 (R1): every admitted delivery is a message too (`kind:"notify"`), so
  // the history is complete without changing this action's result. Best-effort.
  await recordMessage(
    makeEnvelope({
      id: `msg_${cid}`,
      ...(record?.threadID ? { threadId: record.threadID } : {}),
      from: me,
      to: targetSid,
      sentAt: now,
      kind: 'notify',
      body: urgentBody
    })
  );
  // R3: what the host really did — `steer` on an idle target degrades to `queue`.
  const actual = String(admitted?.delivery ?? mode);
  const marked = markUrgent(record, { at: Date.now(), reason, by: me });
  const notes: string[] = [];
  if (forced) notes.push(`目标为只读 agent（${target.info?.agent ?? '?'}）：已强制 queue（forced），不打断对方当前轮。`);
  if (actual !== mode) notes.push(`宿主实际采用 ${actual}（目标空闲 / 被降级），本次未进入其当前轮。`);
  if (!record) notes.push('该会话没有关联的未闭环交接：只投递了加急说明，没有记录可标记。');

  const lines = [
    `已加急 → ${targetLine}`,
    protectedLine,
    scopeLine,
    `reason: ${reason}`,
    `mode=${mode}${forced ? '(forced)' : ''}  delivery=${actual}  message=${admitted?.id ?? '?'}`,
    marked ? `记录: ${marked.bid} priority=urgent urgentAt=${fmtTime(marked.urgentAt ?? now)}（state / claim / receipt 未变）。` : '',
    ...notes.map(note => `注: ${note}`),
    record
      ? `下一步: collab_status { bid:"${record.bid}" } 看 admitted / seen；超时再决定是否重复加急`
      : '下一步: 已直接投递到该会话；如需回执用 collab_send / collab_status 追踪对应交接单'
  ];
  return actionResult({
    action: 'escalate',
    target: targetSid,
    detail: `已加急（delivery=${actual}${forced ? '，forced' : ''}）→ ${targetSid}`,
    lines
  });
}

/* ------------------------------------------------------------------- freeze */

const SCOPES: FreezeEntry['scope'][] = ['session', 'workspace', 'bid'];
/** A workspace freeze notifies at most this many sessions (no prompt storm). */
const WORKSPACE_NOTIFY_LIMIT = 5;

/** `HH:MM` — the shape every freeze line uses. */
function clock(ms: number): string {
  const date = new Date(Number(ms) || 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

export interface FreezeInput {
  /** The calling session (`context.sessionID`, or the RPC's `session`). */
  actor?: string;
  scope?: unknown;
  target?: unknown;
  reason?: unknown;
  until?: unknown;
  /** `false` lifts the freeze (the RPC `unfreeze` method reuses this). */
  freeze?: boolean;
  confirm?: boolean;
}

/**
 * `collab_freeze`'s orchestration (and the board's `freeze` / `unfreeze`):
 * validate scope/target/`until`, read-merge-write the one global file, notify
 * the recipients once (a `queue` prompt, or one urgent owner-queue item when the
 * recipient is protected), and lift on `freeze:false`.
 */
export async function freezeAction(actions: ActionContext, input: FreezeInput): Promise<ActionResult> {
  const { ctx, readConfig, resolveTarget, senderLabel, listSessions } = actions;
  const me = String(input.actor ?? '').trim() || undefined;
  const scope = String(input.scope ?? '').trim() as FreezeEntry['scope'];
  if (!SCOPES.includes(scope)) {
    throw invalid(`scope 不合法：${JSON.stringify(String(input.scope ?? ''))}（期望 session / workspace / bid）`);
  }
  const unfreeze = input.freeze === false;
  const action: ActionName = unfreeze ? 'unfreeze' : 'freeze';
  const rawTarget = String(input.target ?? '').trim();

  /**
   * Who would be notified for this freeze. Read-only (a preview calls it too):
   * `session` → that session; `bid` → its addressee; `workspace` → the root
   * sessions of that workspace (self / sub-sessions / archived left out, capped).
   */
  async function recipientsOf(scope: FreezeEntry['scope'], target: string, me: string | undefined): Promise<string[]> {
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
      listed = await listSessions({ directory: target, limit: 100 });
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
  async function notify(sids: string[], entry: FreezeEntry, me: string): Promise<FreezeDelivery[]> {
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
        // 0.9.0 (R1): the freeze notice is a delivered message (`notify`).
        await recordMessage(
          makeEnvelope({ id: `msg_${cid}`, from: me, to: sid, sentAt: at, kind: 'notify', body })
        );
        receipts.push({ to: sid, cid, ...(admitted?.id ? { messageId: String(admitted.id) } : {}), at });
      } catch (error) {
        receipts.push({ to: sid, cid, at, error: errText(error) });
      }
    }
    return receipts;
  }

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
  const confirmed = input.confirm === true;
  const live = readFreezes(now);
  const existing = live.find(entry => entry.scope === scope && entry.target === target);

  // --------------------------------------------------------- unfreeze
  if (unfreeze) {
    if (!confirmed) {
      const lines = [
        '未解冻（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。',
        `作用域: scope=${scope}  ${targetLine}`,
        existing
          ? `将删除: 冻结项（到 ${clock(existing.until)}，原因：${existing.reason || '-'}）——之后新建协作立即可用。`
          : '当前没有该冻结项：确认后为 no-op（幂等，不报错）。',
        `文件: ${FREEZE_FILE}（读-合并-写）`,
        '注: 解冻不通知任何人，也不改动任何会话 / 记录。'
      ];
      return actionResult({
        action,
        target,
        preview: true,
        detail: '仅预览（未解冻）：确认后才会写入',
        lines
      });
    }
    const next = mergeFreezes(
      entries => entries.filter(entry => !(entry.scope === scope && entry.target === target)),
      now
    );
    const lines = [
      existing ? `已解冻（scope=${scope}, target=${target}）。` : `没有该冻结项（no-op：scope=${scope}, target=${target}）。`,
      `作用域: ${targetLine}`,
      `文件: ${FREEZE_FILE}（剩余 ${next.length} 条冻结）`,
      '效果: collab_handoff / collab_broadcast / collab_accept / collab_escalate 对该对象立即可用。',
      `再冻结: collab_freeze { scope:"${scope}", target:"${target}", reason:"…", confirm:true }`
    ];
    return actionResult({ action, target, detail: lines[0], lines });
  }

  // ------------------------------------------------------------ R1: until
  const reason = sanitizeFreezeReason(input.reason);
  if (!reason) {
    throw invalid('reason 不能为空：请给一句话说明为什么冻结（≤200 字，会去掉控制字符）');
  }
  const until = parseUntil(input.until, now);
  if (!until) {
    throw invalid(
      `until 不合法：${JSON.stringify(String(input.until ?? ''))}（支持 "30m" / "2h" / "45s" / ISO 时间；` +
        '必须是将来时刻）。'
    );
  }
  const entry: FreezeEntry = { scope, target, reason, by: me ?? 'unknown', at: now, until };
  // Who would hear about it (read-only; needed by the preview and the write).
  const recipients = await recipientsOf(scope, target, me);

  // ----------------------------------------------------------- preview
  if (!confirmed) {
    const lines = [
      '未冻结（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。',
      `作用域: scope=${scope}  ${targetLine}`,
      `到期: ${clock(until)}（${fmtTtl(until - now)} 后；到期自动失效，无需清理）`,
      `原因: ${reason}`,
      existing ? `注: 已存在同一冻结（到 ${clock(existing.until)}）：确认后覆盖为本次的到期 / 原因。` : '',
      recipients.length
        ? `将通知 ${recipients.length} 个会话（非受保护 → 1 条 queue prompt；受保护 → 紧急队列项，0 条 prompt）: ` +
          recipients.map(shortID).join(', ')
        : '将通知 0 个会话（该对象当前没有可通知的会话；冻结照样生效）。',
      '将影响: collab_handoff / collab_broadcast / collab_accept / collab_escalate 对该对象的新建协作会被拒绝；' +
        'collab_list / collab_status 只标 [frozen]。',
      `将写入: ${FREEZE_FILE}（version 1，读-合并-写）`
    ];
    return actionResult({
      action,
      target,
      preview: true,
      detail: '仅预览（未冻结）：确认后才会写入',
      lines
    });
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
    const lines = [
      `冻结未生效：写入 ${FREEZE_FILE} 失败（详见日志），${scopeLabel(scope)} 仍按原状态。`,
      `目标: ${targetLine}`,
      '重试：确认磁盘可写后重新调用；不需要解冻。'
    ];
    return actionResult({ action, target, ok: false, detail: lines[0], lines });
  }

  // R5: notify after the freeze exists — a failed prompt must not undo it.
  const receipts = await notify(recipients, stored, me ?? 'unknown');
  let finalEntry: FreezeEntry = stored;
  if (receipts.length) {
    const merged = mergeFreezes(
      entries =>
        entries.map(candidate =>
          candidate.scope === scope && candidate.target === target ? { ...candidate, delivery: receipts } : candidate
        ),
      now
    );
    finalEntry = merged.find(candidate => candidate.scope === scope && candidate.target === target) ?? stored;
  }

  const delivered = receipts.filter(receipt => !receipt.error && !receipt.queueId);
  const queued = receipts.filter(receipt => Boolean(receipt.queueId));
  const failed = receipts.filter(receipt => Boolean(receipt.error));
  const lines = [
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
  ];
  return actionResult({
    action,
    target,
    detail: `已冻结（scope=${scope}, target=${target}, 到 ${clock(finalEntry.until)}）`,
    lines
  });
}

/* ------------------------------------------------------------------ archive */

export interface ArchiveInput {
  /** The calling session (audit only; the archive itself does not need it). */
  actor?: string;
  bid?: string;
  session?: string;
  restore?: boolean;
  confirm?: boolean;
}

/**
 * `collab_archive`'s orchestration, and the board's `archive`:
 * `archived:true` hides a session (never deletes it), `restore:true` brings it
 * back, `[protected*]` targets are refused, and the bid record only gains /
 * clears `archivedAt`. A refused host write is a readable `ok:false`, never a
 * thrown error (R3 of 0.5.0).
 */
export async function archiveAction(actions: ActionContext, input: ArchiveInput): Promise<ActionResult> {
  const { ctx, readConfig } = actions;
  const action: ActionName = input.restore === true ? 'restore' : 'archive';

  /** `<bid>` → its session, or the session the record's claimant really is. */
  function resolveSession(input: { bid: string; session: string }): { record?: BroadcastRecord; sessionID: string } {
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
        }）：` + '按 bid 归档只针对本插件 spawn 的会话；确实要归档某个会话请用 session 直接指定'
      );
    }
    if (session && session !== claimed) {
      throw invalid(`bid ${bid} 的领取会话是 ${claimed}，与 session=${session} 不一致；请只传其中一个`);
    }
    return { record, sessionID: claimed };
  }

  const bid = String(input.bid ?? '').trim();
  const sessionRaw = String(input.session ?? '').trim();
  const restore = input.restore === true;
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
  const label = restore ? '恢复（archived:false）' : '归档（archived:true）';
  const targetLine =
    `目标: ${sessionID}  agent=${info?.agent ?? '?'}  state=${state}  ` +
    `标题="${truncate(info?.title ?? '(untitled)', 60)}"`;

  if (input.confirm !== true) {
    const lines = [
      '未执行（confirm 不为 true，仅预览）。归档 ≠ 删除：会话与消息都保留，restore:true 可恢复。',
      targetLine,
      `动作: ${label}`,
      ...(record
        ? [
            `记录: ${record.bid} state=${String(record.state)} ` +
              `archivedAt=${record.archivedAt ? fmtTime(record.archivedAt) : '-'}`
          ]
        : []),
      '确认后在同样参数下传 confirm:true。'
    ];
    return actionResult({ action, target: sessionID, preview: true, detail: '仅预览（未写入）', lines });
  }

  const lines: string[] = [];
  let ok = true;
  let detail = '';
  if (!restore && already) {
    // Idempotent: the host already hides it. Do **not** PATCH again — only
    // adopt the state into the record so the auto pass stops looking at it.
    lines.push('目标已是归档状态（幂等，未重复 PATCH）。');
    detail = `目标已是归档状态（幂等）→ ${sessionID}`;
  } else if (restore && !already) {
    lines.push('目标当前未归档（幂等，未重复 PATCH）。');
    detail = `目标当前未归档（幂等）→ ${sessionID}`;
  } else {
    const result = await archiveSession(ctx, sessionID, !restore);
    if (!result.ok) {
      // A refused host (403 / 404 / no update + no URL) is a readable
      // outcome, not a plugin defect: nothing was written.
      const failed = [
        `${restore ? '恢复' : '归档'}失败：${result.reason ?? 'unknown'}`,
        targetLine,
        `记录: ${record ? record.bid : '(未关联 bid，未改任何记录)'}`,
        '未做任何修改。'
      ];
      return actionResult({ action, target: sessionID, ok: false, detail: failed[0], lines: failed });
    }
    lines.push(`${restore ? '已恢复' : '已归档'}：${sessionID}（via ${result.via ?? '?'}）`);
    detail = `${restore ? '已恢复' : '已归档'}：${sessionID}`;
  }

  // Stamp / clear the record **after** the host write. Without `bid`, adopt
  // every record that names this session as its claimant (a session may be the
  // claimant of several hand-offs; only the stamped ones stop the pass).
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

  const content = [
    '归档 ≠ 删除：会话与消息都保留，restore:true 可恢复。',
    targetLine,
    `动作: ${label}`,
    ...lines,
    stamped.length
      ? `记录 archivedAt: ${stamped.map(id => `${id}=${restore ? '清空' : fmtTime(now)}`).join(', ')}`
      : '记录: 未关联 bid（只改了会话本身）',
    restore
      ? '恢复后它会重新出现在会话列表里；如需再次归档：collab_archive { session, confirm:true }。'
      : `恢复：collab_archive { session:"${sessionID}", restore:true, confirm:true }。`
  ];
  return actionResult({ action, target: sessionID, ok, detail, lines: content });
}
