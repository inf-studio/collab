import { allBroadcasts } from '../core/claim.ts';
import { createAwareness } from '../core/awareness.ts';
import {
  contractExists,
  deciderOf,
  effectiveMission,
  readContract,
  renderInjection,
  roleLine,
  stampTurn,
  unfinishedTodos,
  updateContractIfExists
} from '../core/contract.ts';
import { decideLine, expireConflictDecisions, openConflictDecision } from '../core/decisions.ts';
import { flushDueWindows } from '../core/dispatch.ts';
import { isAckText } from '../core/ack.ts';
import { evaluate as evaluateDrift, markDrifted } from '../core/drift.ts';
import { factInjection, markFactSeen, noteStaleDeliveries, readFactSeen, workspaceFacts, workspaceOf } from '../core/facts.ts';
import { glossaryLineFor } from '../core/glossary.ts';
import { compareBasedOn, localSnapshot } from '../core/tri-state.ts';
import type { CompareResult } from '../core/tri-state.ts';
import { markFollowUpSeen } from '../core/followup.ts';
import { collectRequestKeys, cursorFrom, messageIDs, messageKey, messageSemantics } from '../core/messages.ts';
import { resolveMissionAnchor } from '../core/mission-resolve.ts';
import { markSeen as markQueueSeen } from '../core/owner-queue.ts';
import { reportDir, reportNoticeLine, takePendingNotice } from '../core/report.ts';
import { formatStale, markShown, staleFor } from '../core/stale.ts';
import { isValidThreadID, normalizeKind, normalizeText, normalizeThreadID } from '../ids.ts';
import { log } from '../log.ts';
import type { ToolDeps } from '../tools/shared.ts';
import type { ContextHookEvent, InboxMessage } from '../types.ts';
import { asObject, dedupe, truncate } from '../util.ts';

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
    const now = Date.now();
    // 0.9.5 (R5/R1): the open decisions waiting on somebody. Computed **before**
    // the "no contract" exit: an owner that never used a contract tool still has
    // to see the `[decide]` line (review B1) — and the 24h conflict sweep runs
    // here, where the drift scan runs (review B2). Each failure is a log line.
    let decide: string | undefined;
    try {
      // Review B2 / N12: the sweep and the read are bounded (1s lock wait in the
      // writer) so a busy ledger can never stall a model request.
      await expireConflictDecisions(now);
      decide = decideLine(sessionID, now);
    } catch (error) {
      log('decision injection failed:', (error as Error)?.message ?? error);
    }
    // No contract and nothing resolvable → stay silent unless this session is a
    // party of an open decision (then only that line is injected).
    if (!hasContract && (!hint || hint.source === 'none' || hint.source === 'ambiguous')) {
      return decide;
    }

    // 0.9.3 (R1/R4): stamp **first**, then evaluate/render from that snapshot,
    // then persist once. The stamped counter already includes this request
    // (its tool calls have not run yet), so `evaluate` reads it as is — the
    // previous order (render from the pre-stamp value + `evaluate`'s `+1`) made
    // drift fire one request late right after an advance.
    //
    // `[未收尾]` still compares against the **pre-stamp** turn: its gate is
    // "a previous request really happened", which the fresh stamp would erase.
    const unfinished = unfinishedTodos(contract, now);
    const stamped = stampTurn(contract, now);
    const drift = evaluateDrift(stamped, now);
    // Review B4: the role is declared, never inferred from the request text.
    const role = roleLine(stamped, sessionID);
    const result = renderInjection({
      contract: stamped,
      mission: effectiveMission(stamped, hint),
      unfinished,
      drift: drift.lines,
      role,
      decide,
      anchor: hint,
      now
    });
    if (!result.lines.length) return undefined;

    try {
      // Unconditional (count / lastAt / startedAt) whenever a contract file
      // exists; `updateContractIfExists` is a no-op without one. The same
      // serialised write marks expired suspended todos `drifted` (never closed)
      // and remembers that a `[drift]` is still unanswered (`[未处置]`).
      await updateContractIfExists(sessionID, current => markDrifted(stampTurn(current, now), drift, now));
    } catch (error) {
      // The block is already built; a failed stamp only means `[未收尾]` is
      // judged against the previous successful turn. Never fail the request.
      log('contract turn stamp failed:', (error as Error)?.message ?? error);
    }
    return result.lines.join('\n');
  }

  /**
   * 0.9.4 (`11-20-collab-facts`, R3/R6): the semantics block — `[settled:F#]`,
   * `[retracted:F#→F#]` and `[glossary]`, each at most one line.
   *
   * Computed from the workspace ledger **every** request (no `injected[]`, the
   * same rule as the contract block), but announced once per fact: the
   * per-session seen set is written only after the block is pushed.
   */
  async function injectFacts(event: ContextHookEvent): Promise<{ text?: string; keys: string[] }> {
    const sessionID = event?.sessionID;
    if (!sessionID) return { keys: [] };
    const workspace = workspaceOf(deps.ctx);
    const seen = await readFactSeen(deps.ctx, sessionID);
    const injected = factInjection(workspace, seen);
    const glossary = glossaryLineFor(sessionID);
    const lines = [...injected.lines, ...(glossary ? [glossary] : [])];
    return lines.length ? { text: lines.join('\n'), keys: injected.keys } : { keys: [] };
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
  async function injectInbox(
    event: ContextHookEvent
  ): Promise<{ text?: string; shown: number; rest: number; stale: number }> {
    const config = readConfig();
    if (!config.autoDeliver) return { shown: 0, rest: 0, stale: 0 };
    const sessionID = event?.sessionID;
    if (!sessionID) return { shown: 0, rest: 0, stale: 0 };

    const box = await inbox.read(sessionID);
    if (!box.messages.length) return { shown: 0, rest: 0, stale: 0 };

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
      return { shown: 0, rest: pending.length, stale: 0 };
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

    // 0.9.4 (R4/D2): the receiver's baseline, computed once per request and only
    // when a shown message actually carries one (no marker → D2's `[基线未知]`,
    // which is *fresh* — not a reason to run git).
    const workspace = workspaceOf(deps.ctx);
    let local: ReturnType<typeof localSnapshot> | undefined;
    const baseline = (): ReturnType<typeof localSnapshot> => {
      if (!local) local = localSnapshot({ workspace, epoch: workspaceFacts(workspace).epoch });
      return local;
    };
    let staleLine: string | undefined;
    let conflictLine: string | undefined;
    // 0.9.5 (design §6): what the conflict verdict was about — the escalation
    // (one open decision, owner = decider) happens after the block is built.
    let conflictVerdict: CompareResult | undefined;
    let conflictMessage: InboxMessage | undefined;
    // 0.9.4 review: how many `stale` messages this request really delivered. The
    // "reply ≤30%" rule is a behavioural convention (we never write the reply),
    // so the audit trail is this counter — a human samples and measures.
    let staleCount = 0;
    const verdictOf = (
      semantics: ReturnType<typeof messageSemantics>,
      message: InboxMessage
    ): ReturnType<typeof compareBasedOn> | undefined => {
      if (!semantics.basedOn) return undefined; // D2: no baseline = fresh + [基线未知]
      const verdict = compareBasedOn(semantics.basedOn, baseline());
      if (verdict.state === 'stale') {
        staleCount += 1;
        if (!staleLine) staleLine = verdict.line;
      }
      if (verdict.state === 'conflict' && !conflictLine) {
        conflictLine = verdict.line;
        conflictVerdict = verdict;
        conflictMessage = message;
      }
      return verdict;
    };

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
      const semantics = messageSemantics(message);
      const verdict = verdictOf(semantics, message);
      const mark = verdict?.state === 'conflict' ? '[conflict] ' : verdict?.state === 'stale' ? '[stale] ' : '';
      // R2: no declared grade is surfaced as `[未标注]`; D2: no baseline is
      // surfaced as `[基线未知]` (still `fresh` — the marker is information, not
      // a warning). The receiver can then ask for a measured fact.
      const unlabeled = semantics.grade === 'unknown' ? '[未标注] ' : '';
      const noBaseline = semantics.basedOn ? '' : '[基线未知] ';
      return `- ${unlabeled}${noBaseline}${mark}${kind.padEnd(7)} ${threadID ?? '-'} from=${message.from}: ${truncate(message.text)}${hint}`;
    };

    await inbox.update(sessionID, current => {
      const nextInjected = dedupe([...accounted]);
      return {
        ...current,
        injected: nextInjected,
        cursor: cursorFrom(current.messages, nextInjected)
      };
    });

    // `lineOf` is what *detects* the conflict (and records `conflictMessage`), so
    // the lines must be rendered **before** the escalation below — reading them
    // inside the return object would leave the escalation with nothing to open.
    const messageLines = [...requests, ...replies, ...notes].map(lineOf);

    // 0.9.5 (design §6 / R6): the conflict becomes **one open decision**
    // (owner = decider) — never another message. Idempotent per key, never
    // throws (a broken ledger must not fail a model request), and the line is
    // the same turn's instruction: this thread is read-only until it is closed.
    let conflictEscalation: string | undefined;
    if (conflictMessage && conflictVerdict) {
      try {
        conflictEscalation = await escalateConflict(conflictMessage, conflictVerdict, sessionID);
      } catch (error) {
        log('conflict escalation failed:', (error as Error)?.message ?? error);
      }
    }

    return {
      text: [
        `[collab] ${head}`,
        ...messageLines,
        ...(staleLine ? [staleLine] : []),
        ...(conflictLine ? [conflictLine] : []),
        ...(conflictEscalation ? [conflictEscalation] : []),
        rest > 0 ? `…还有 ${rest} 条，调用 collab_inbox 查看全文。` : '全文/状态用 collab_inbox。'
      ].join('\n'),
      shown: shown.length,
      rest,
      stale: staleCount
    };
  }

  /**
   * Turn a `conflict` verdict into an open decision (design §6 step 1+2).
   *
   * The key is the message's thread (or the `b_…` in its body — a legacy message
   * with neither has no subject to hang a decision on, so it is skipped rather
   * than inventing one). The owner is the **order's sender**: the thread's
   * initiator, then the contract's decider, then the inbound sender.
   */
  async function escalateConflict(
    message: InboxMessage,
    verdict: CompareResult,
    sessionID: string
  ): Promise<string | undefined> {
    const threadID = normalizeThreadID(message.threadID);
    const bid = /\b(b_[0-9a-f]{8,32})\b/.exec(String(message.text ?? ''))?.[1];
    const key = threadID && isValidThreadID(threadID) ? threadID : bid;
    if (!key) return undefined;
    const thread = threadID ? await threads.read(threadID) : undefined;
    // Review B2 (N11): the **receiver** owns the decision when the contract
    // names no decider. Falling back to the counterpart that proposed the
    // diverged baseline put the answer in the hands of the side that is absent
    // (or is the very party that must not decide).
    const owner = String(deciderOf(readContract(sessionID)) ?? sessionID);
    const parties = dedupe(
      [thread?.fromSession, thread?.toSession, message.fromSession, sessionID].map(sid =>
        String(sid ?? '').trim()
      )
    ).filter(Boolean);
    const opened = await openConflictDecision({
      key,
      verdict,
      owner,
      by: sessionID,
      threadId: threadID,
      ...(bid ? { bid } : {}),
      parties
    });
    const decision = opened.decision ?? opened.existing;
    if (!decision) return opened.capped ? `[conflict] 未开决策：${opened.capped}` : undefined;
    return (
      `[conflict] 已开 ${decision.id}（等 ${decision.owner}）—— 决策关闭前本 thread 只读（不再产生新消息）；` +
      `双方都可 supersede 解除；owner: collab_decide { action:"answer", key:"${key}", id:"${decision.id}", answer:"…", confirm:true }`
    );
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
      // 0.9.6 (`11-20-collab-pacing`, R1/R5): the durable half of the window.
      // The timer is only a hint — a reload, a sleeping process or a failed
      // flush leaves items in the buffer file, and this hook is where they are
      // delivered. Runs before any block is built so a delivered batch is
      // already part of this turn's world. Never throws (the outer catch).
      try {
        const flushed = await flushDueWindows();
        if (flushed.failed) log(`pacing: ${flushed.failed} window(s) could not be delivered; kept for retry`);
      } catch (error) {
        log('pacing flush failed:', (error as Error)?.message ?? error);
      }
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
      // 0.9.4: `[settled]` / `[retracted]` / `[glossary]` — the facts frame the
      // request before the messages are read. Its own try/catch: a broken ledger
      // must not cost the inbox lines.
      let factPart: { text?: string; keys: string[] } = { keys: [] };
      try {
        factPart = await injectFacts(event);
      } catch (error) {
        log('facts injection failed:', (error as Error)?.message ?? error);
      }
      if (factPart.text) blocks.push(factPart.text);
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
        // 0.9.4: same after-push rule for the fact lines — a failed injection
        // leaves them pending for the next request.
        if (factPart.keys.length) await markFactSeen(deps.ctx, event.sessionID, factPart.keys);
        // 0.9.4 review: the stale-delivery counter (auditable half of R4). A
        // counter failure must never fail the request — the block is already in.
        if (inboxPart.stale > 0) {
          try {
            await noteStaleDeliveries({ workspace: workspaceOf(deps.ctx), count: inboxPart.stale });
          } catch (error) {
            log('stale-delivery metric failed:', (error as Error)?.message ?? error);
          }
        }
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
