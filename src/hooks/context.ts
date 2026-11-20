import { allBroadcasts } from '../core/claim.ts';
import { createAwareness } from '../core/awareness.ts';
import {
  contractExists,
  effectiveMission,
  readContract,
  renderInjection,
  stampTurn,
  unfinishedTodos,
  updateContractIfExists
} from '../core/contract.ts';
import { isAckText } from '../core/ack.ts';
import { markFollowUpSeen } from '../core/followup.ts';
import { collectRequestKeys, cursorFrom, messageIDs, messageKey } from '../core/messages.ts';
import { markSeen as markQueueSeen } from '../core/owner-queue.ts';
import { reportDir, reportNoticeLine, takePendingNotice } from '../core/report.ts';
import { formatStale, markShown, staleFor } from '../core/stale.ts';
import { resolveMissionAnchor } from '../core/mission-resolve.ts';
import { normalizeKind, normalizeText, normalizeThreadID } from '../ids.ts';
import { log } from '../log.ts';
import type { ToolDeps } from '../tools/shared.ts';
import type { ContextHookEvent, InboxMessage } from '../types.ts';
import { dedupe, truncate } from '../util.ts';

/** The hook payload as the host hands it to `ctx.session.hook("context", …)`. */
export type ContextEventHandler = (event: ContextHookEvent) => Promise<void>;

/**
 * Injection: append at most one compact system block to the next request of
 * *this* session only. Two sources share it:
 *
 *   a) unread cross-session messages (deduplicated by inboxID/cid and by
 *      "already part of this very request");
 *   b) the hand-off chain: open group broadcasts this session has not seen yet,
 *      and unresolved hand-offs it started (each exactly once per session —
 *      `seenBy` / `reminded` live in the broadcast file).
 *
 * Never throws: a model request must not fail because of collab bookkeeping.
 */
export function createContextHook(deps: ToolDeps): ContextEventHandler {
  const { readConfig, inbox, threads, chain } = deps;
  // 0.7.0 (R1–R5): one instance per setup — it owns the 10-minute cache, so a
  // reload of the plugin resets the window (and a config flip is immediate).
  const awareness = createAwareness({
    ctx: deps.ctx,
    readConfig,
    listSessions: input => chain.listSessions(input)
  });

  /**
   * 0.9.1 (R5) / 0.9.2: the **four-section contract injection**, recomputed from
   * the contract file on every request. Never writes `injected[]` and never
   * suppresses a section because it was shown before — that once-only behaviour
   * is exactly what the 0.5.x injection did wrong (PRD R5).
   *
   * Silent when the session has neither a contract file nor a task anchor: a
   * session in a workspace with no Trellis task has no mainline to remind it of,
   * and a `[mission] 未设置` line on every request would be noise, not memory.
   *
   * The only write is the `turn` stamp, and only when a contract file **already
   * exists** (a session that never used a contract tool must not get a file
   * created by the hook — lazy creation, design §3). It runs on **every** such
   * request, not only when there are todos: a mission-only / milestone-only
   * contract still needs `turn.count` for 0.9.3's drift check. `[未收尾]` uses
   * the current request's start, not the previous one's.
   */
  async function injectContract(event: ContextHookEvent): Promise<string | undefined> {
    const sessionID = event?.sessionID;
    if (!sessionID || !Array.isArray(event?.system)) return undefined;
    const contract = readContract(sessionID);
    const hasContract = contractExists(sessionID);
    // A confirmed / manually set mission never borrows the anchor, so the task
    // scan is skipped once the contract has one (it reads .trellis/tasks/*).
    const missionSet = Boolean(contract.mission.confirmedBy) || Boolean(contract.mission.oneLine.trim());
    const hint =
      hasContract && missionSet ? undefined : resolveMissionAnchor(deps.ctx?.location?.directory, sessionID);
    // No contract and nothing resolvable → stay silent. `ambiguous` is silent
    // too (review #4): 2+ in_progress tasks in a task-heavy repo used to inject
    // four lines of "未设置" every request without naming the ambiguity. With a
    // contract, the ambiguity is rendered *inside* `[mission]` instead.
    if (!hasContract && (!hint || hint.source === 'none' || hint.source === 'ambiguous')) return undefined;

    const now = Date.now();
    const result = renderInjection({
      contract,
      mission: effectiveMission(contract, hint),
      // The current request's start: a doing todo created mid-previous-request is
      // older than this stamp but newer than the previous one, so it is marked
      // exactly one turn later (review #3).
      unfinished: unfinishedTodos(contract, now),
      // 0.9.3 fills `[drift]`; 0.9.1 reserves the slot and never triggers it.
      drift: [],
      anchor: hint,
      now
    });
    if (!result.lines.length) return undefined;

    try {
      // Unconditional (count / lastAt / startedAt) whenever a contract file
      // exists; `updateContractIfExists` is a no-op without one.
      await updateContractIfExists(sessionID, current => stampTurn(current, now));
    } catch (error) {
      // The block is already built; a failed stamp only means `[未收尾]` is
      // judged against the previous successful turn. Never fail the request.
      log('contract turn stamp failed:', (error as Error)?.message ?? error);
    }
    return result.lines.join('\n');
  }

  /**
   * Unread cross-session messages. Only messages that are neither already
   * injected nor part of this very request are surfaced, so a hand-off never
   * shows up twice (the body is already a user turn of its own).
   *
   * R1 (0.1.6): every message this request accounts for — shown, already part of
   * the request, or skipped because its thread is closed — is *seen* by the
   * receiving side, so its hand-off cid is acked on a side path (`[ack] <cid>
   * seen`). `[ack]` messages themselves are neither injected nor acked.
   */
  async function injectInbox(event: ContextHookEvent): Promise<{ text?: string; shown: number; rest: number }> {
    const config = readConfig();
    if (!config.autoDeliver) return { shown: 0, rest: 0 };
    const sessionID = event?.sessionID;
    if (!sessionID) return { shown: 0, rest: 0 };

    const box = await inbox.read(sessionID);
    if (!box.messages.length) return { shown: 0, rest: 0 };

    const inRequest = collectRequestKeys(event);
    // `accounted` = messages this session has already been shown: injected in
    // a previous request, present in this request as a user turn, or already
    // answered. All of them are filtered out and persisted, so a hand-off is
    // surfaced exactly once.
    const accounted = new Set(box.injected);
    const pending: InboxMessage[] = [];
    const acknowledge = (message: InboxMessage): void => {
      for (const id of messageIDs(message)) accounted.add(id);
    };

    for (const message of box.messages) {
      if (messageIDs(message).some(id => accounted.has(id))) continue;
      // R1 (0.1.6): ack traffic is machine chatter, not a message for the model.
      if (isAckText(message.text)) {
        acknowledge(message);
        continue;
      }
      if (message.cid && inRequest.cids.has(message.cid)) {
        acknowledge(message);
        continue;
      }
      if (inRequest.keys.has(messageKey(message)) || inRequest.texts.has(normalizeText(message.text))) {
        acknowledge(message);
        continue;
      }
      // A request whose thread is already answered/closed is no reminder.
      if (normalizeKind(message.kind) === 'request') {
        const messageThread = normalizeThreadID(message.threadID);
        if (messageThread) {
          const thread = await threads.read(messageThread);
          if (thread && thread.status !== 'open') {
            acknowledge(message);
            continue;
          }
        }
      }
      pending.push(message);
    }

    const markAccounted = box.injected.length !== accounted.size;
    const shown = pending.slice(0, config.maxInject);
    // Shown = about to be surfaced in *this* request, so it counts as accounted
    // before the ack below is computed (a message is "seen" the moment it is
    // injected, not on the next request).
    for (const message of shown) acknowledge(message);

    // R1 (0.1.6): confirm the hand-off deliveries this request has surfaced —
    // best-effort and detached: the ack must never delay or fail the request.
    const seenCids = box.messages
      .filter(message => Boolean(message.cid) && !isAckText(message.text))
      .filter(message => messageIDs(message).some(id => accounted.has(id)))
      .map(message => String(message.cid));
    if (seenCids.length)
      void chain
        .ackSeen(sessionID, seenCids)
        .catch(error => log('ack failed:', (error as Error)?.message ?? error));
    if (!shown.length) {
      if (markAccounted) {
        await inbox.update(sessionID, current => {
          const nextInjected = dedupe([...accounted]);
          return {
            ...current,
            injected: nextInjected,
            cursor: cursorFrom(current.messages, nextInjected)
          };
        });
      }
      return { shown: 0, rest: pending.length };
    }

    const rest = pending.length - shown.length;
    const requests = shown.filter(message => normalizeKind(message.kind) === 'request');
    const replies = shown.filter(message => normalizeKind(message.kind) === 'reply');
    const notes = shown.filter(message => normalizeKind(message.kind) === 'note');

    const head = [
      requests.length ? `待处理请求 ${requests.length} 条` : '',
      replies.length ? `新回执 ${replies.length} 条` : '',
      notes.length ? `新消息 ${notes.length} 条` : ''
    ]
      .filter(Boolean)
      .join(' / ');

    const lineOf = (message: InboxMessage): string => {
      const kind = normalizeKind(message.kind);
      // Legacy CLI messages (`[collab:<from>] <body>`) carry no thread; telling
      // the model to call `collab_reply {threadID:"undefined"}` would only
      // produce a validation error. Guide it to the right next step instead.
      const threadID = normalizeThreadID(message.threadID);
      const hint =
        kind === 'request'
          ? threadID
            ? ` → 处理后用 collab_reply {threadID:"${threadID}"}`
            : ' → 无 thread 关联，无需回执；直接处理即可（或 collab_send 发起新请求）'
          : kind === 'reply'
            ? threadID
              ? ` → 用 collab_wait {threadID:"${threadID}"} 取全文`
              : ' → 无 thread 关联，无需等待回执'
            : '';
      return `- ${kind.padEnd(7)} ${threadID ?? '-'} from=${message.from}: ${truncate(message.text)}${hint}`;
    };

    await inbox.update(sessionID, current => {
      const nextInjected = dedupe([...accounted]);
      return {
        ...current,
        injected: nextInjected,
        cursor: cursorFrom(current.messages, nextInjected)
      };
    });

    return {
      text: [
        `[collab] ${head}`,
        ...[...requests, ...replies, ...notes].map(lineOf),
        rest > 0 ? `…还有 ${rest} 条，调用 collab_inbox 查看全文。` : '全文/状态用 collab_inbox。'
      ].join('\n'),
      shown: shown.length,
      rest
    };
  }

  /**
   * R6: the hang-up classes (`open-stale` / `claimed-lapsed` / `acked-stale`)
   * for the hand-offs this session is part of, once per `(class, bid)`.
   * Read-only: no refresh, no lock release, no auto-close.
   */
  async function injectStale(event: ContextHookEvent): Promise<string | undefined> {
    const sessionID = event?.sessionID;
    if (!sessionID) return undefined;
    const items = await markShown(deps.ctx, sessionID, staleFor(allBroadcasts(), sessionID, Date.now()));
    if (!items.length) return undefined;
    return [
      '[collab-handoff] 挂起提醒（每类每单只出现一次）:',
      ...formatStale(items),
      '缺陷上报：collab_report { confirm:true }'
    ].join('\n');
  }

  /**
   * R9.2 (passive): only the session configured as `report.to` is told about the
   * untriaged backlog, once per session (and again only when the count grows).
   */
  async function injectReportNotice(event: ContextHookEvent): Promise<string | undefined> {
    const sessionID = event?.sessionID;
    if (!sessionID) return undefined;
    const config = readConfig();
    const to = String(config.report?.to ?? '').trim();
    if (!to) return undefined;
    const sid = to.startsWith('ses_') ? to : String(config.aliases?.[to] ?? '');
    if (!sid || sid !== sessionID) return undefined;
    const { count } = deps.reporter.pending();
    if (!count) return undefined;
    if (!(await takePendingNotice(deps.ctx, sessionID, count))) return undefined;
    return [
      `[collab] ${reportNoticeLine(count)}`,
      `证据目录: ${reportDir()}`,
      '缺陷上报：collab_report { confirm:true }（手工补一条现场）'
    ].join('\n');
  }

  /**
   * Group broadcasts + unclosed hand-offs, each surfaced once per session.
   *
   * F1 (0.3.1): returns the text **and** the follow-up keys to stamp. The stamp
   * is deliberately left to the caller: it may only happen after the block was
   * pushed onto the request (`markFollowUpSeen` below), so an injection that
   * throws — or a host that never surfaces the block — leaves the hint pending
   * for the next request instead of losing it for good.
   */
  async function injectChain(event: ContextHookEvent): Promise<{ text?: string; keys: string[]; ownerQueue: string[] }> {
    const injected = await chain.injectionFor(event?.sessionID, deps.ctx?.location?.directory);
    const ownerQueue = injected.ownerQueue ?? [];
    if (!injected.lines.length) return { keys: [], ownerQueue: [] };
    return {
      text: [`[collab-handoff] 交接链路提醒（每条只出现一次）:`, ...injected.lines].join('\n'),
      keys: injected.keys,
      ownerQueue
    };
  }

  return async function contextHook(event) {
    try {
      if (!event?.sessionID || !Array.isArray(event?.system)) return;
      const blocks: string[] = [];
      // 0.9.1: the contract block leads — the mainline anchor and the open
      // todos are the frame the rest of the request should be read in. Its own
      // try/catch: a contract failure must not cost the inbox/hand-off lines.
      let contractText: string | undefined;
      try {
        contractText = await injectContract(event);
      } catch (error) {
        log('contract injection failed:', (error as Error)?.message ?? error);
      }
      if (contractText) blocks.push(contractText);
      const inboxPart = await injectInbox(event);
      if (inboxPart.text) blocks.push(inboxPart.text);
      // Stale classes are computed *before* the chain refresh: that refresh
      // reopens a lapsed `claimed` record, which would hide exactly the state
      // this reminder exists to report.
      const staleText = await injectStale(event);
      if (staleText) blocks.push(staleText);
      const chainPart = await injectChain(event);
      if (chainPart.text) blocks.push(chainPart.text);
      const noticeText = await injectReportNotice(event);
      if (noticeText) blocks.push(noticeText);
      // 0.7.0 (R1/R3): the awareness hint is appended **last** and only when the
      // shared `maxInject` budget still has room — an unread message or a
      // hand-off/queue line always wins. It is read-only and cached per session,
      // so it never costs more than one session page per 10 minutes.
      //
      // Its own try/catch: a hint is the least important block, and a failure
      // here must not cost the hand-off/queue lines already collected above
      // (the outer catch would otherwise drop the whole push).
      const budget = readConfig().maxInject - inboxPart.shown;
      let awarenessText: string | undefined;
      if (budget > 0) {
        try {
          awarenessText = await awareness.line(event.sessionID);
        } catch (error) {
          log('awareness line failed:', (error as Error)?.message ?? error);
        }
      }
      if (awarenessText) blocks.push(awarenessText);
      if (blocks.length) {
        event.system.push({ type: 'text', text: blocks.join('\n\n') });
        // F1 (0.3.1): the follow-up hint is "seen" only now that it is really in
        // this request. `push` threw → we never get here → the hint stays
        // pending and the next request retries it (natural retry, no counter).
        if (chainPart.keys.length) await markFollowUpSeen(deps.ctx, event.sessionID, chainPart.keys);
        // D1 (0.4.0): the same rule for the owner-queue lines — `seenAt` is
        // written after the push, so a failed injection shows them again.
        if (chainPart.ownerQueue.length) markQueueSeen(event.sessionID, chainPart.ownerQueue);
        // Same rule for the awareness hint: stamp the 10-minute window only
        // once the line really reached the request.
        if (awarenessText) awareness.markShown(event.sessionID);
      }
    } catch (error) {
      // Never break a model request because of collab bookkeeping.
      log('context hook failed:', (error as Error)?.message ?? error);
    }
  };
}
