import type { Plugin } from '@opencode/plugin';
import { createContextHook } from './hooks/context.ts';
import {
  contractExists,
  contractFile,
  deciderOf,
  derivePeerRoles,
  effectiveMission,
  emptyContract,
  formatAge,
  normalizeContract,
  nextTodoSeq,
  openTodos,
  peerRolesOf,
  primaryRole,
  readContract,
  recordPeers,
  renderInjection,
  roleLine,
  stampTurn,
  unfinishedTodos,
  updateContract,
  updateContractIfExists,
  upsertPeers,
  writeContract
} from './core/contract.ts';
import { checkEvidence } from './core/evidence.ts';
import { appendGateAudit, gateAuditFile } from './core/audit.ts';
import { evaluate as evaluateGate, normalizeGateMode } from './core/gate.ts';
import { DRIFT_NO_ADVANCE_TURNS, DRIFT_PARKED_MS, GATE_TODO_LIMIT, SUSPEND_FALLBACK_MS, WAKE_KINDS } from './constants.ts';
import { evaluate as evaluateDrift, markDrifted, driftUnresolved } from './core/drift.ts';
import { normalizeWakeWhen, parseWakeWhen, wakeExpired, wakeLabel, wakePhrase } from './core/wake.ts';
import { firstHumanInstruction, messageTextOf, resolveMissionAnchor } from './core/mission-resolve.ts';
import { createConfigReader } from './config.ts';
import {
  COLLAB_TOOL_ACTIONS,
  EVENT_TYPES,
  PACING_FILE,
  PACING_MAX_ITEMS,
  PACING_RETRY_MS,
  PACING_SLA_MS,
  PACING_VERSION,
  PACING_WINDOW_MAX_MS,
  PACING_WINDOW_MS
} from './constants.ts';
import { appendAudit, archiveAction, escalateAction, freezeAction, sanitizeReason as sanitizeActionReason } from './core/actions.ts';
import type { ActionContext } from './core/actions.ts';
import { createHandoffChain } from './core/chain.ts';
import { awarenessText } from './core/awareness.ts';
import { allBroadcasts } from './core/claim.ts';
import { archiveSession, shouldArchive } from './core/archive.ts';
import { allLocks, lockFile, normalizeResource, normalizeTtl, sanitizeReason, touchWaiters } from './core/locks.ts';
import { countsOf, pendingCountOf } from './core/counts.ts';
import { freezeFor, freezeNotice, freezeNoticeText, markFreezeNotified, mergeFreezes, readFreezes } from './core/freeze.ts';
import { createLineage } from './core/lineage.ts';
// 0.9.6 (`11-20-collab-pacing`): the window buffer + delta gate (exported for
// the pacing test; the runtime itself is registered by `createToolKit`).
import {
  armedFlushes,
  armFlush,
  batchKind,
  batchThread,
  bumpCounter,
  clearFlushTimers,
  counterOf,
  dayKey,
  dayMessageTimes,
  emptyPacingState,
  isResendID,
  medianGapMs,
  mergeIntoWindow,
  nextFlushAt,
  normalizePacingState,
  pacingBodyKey,
  pacingDedupeKey,
  pacingMetrics,
  readPacing,
  refreshMetrics,
  renderWindow,
  updatePacing,
  windowDue,
  windowFlushAt,
  windowFor,
  windowIsLate,
  windowItems,
  writePacing
} from './core/pacing.ts';
import {
  configurePacingRuntime,
  pacingRuntime,
  enqueueWindow,
  flushAllWindows,
  flushDueWindows,
  lastSentOf,
  pacingCounters,
  pacingPolicy,
  pendingWindows,
  noopInfo,
  recordNoop,
  recordSentBaseline,
  resetPacingRuntime
} from './core/dispatch.ts';
import { computeDelta, deltaSnapshot, noDeltaLine, todoStatusHash } from './core/delta.ts';
import { upsertMetrics } from './core/index-db.ts';
import { allQueueItems, mineFor } from './core/owner-queue.ts';
import { buildSnapshot, createSnapshotReader } from './core/snapshot.ts';
import { buildBoard, boardOrphans } from './core/board.ts';
import { buildGraph } from './core/graph.ts';
import {
  GRAPH_LABEL_MAX,
  clampPan,
  clampZoom,
  layoutGraph,
  truncateLabel,
  viewBoxAttr,
  viewBoxOf,
  zoomBy
} from './core/graph-layout.ts';
import { CollabState } from './rpc.ts';
import type { ActionReceipt, Snapshot } from './rpc.ts';
import { assertCollabOnly, collabPermissionRules, mergeRules, missingRules, normalizeRules } from './core/grants.ts';
import {
  DeliveryError,
  ExtractError,
  GuardConflictError,
  InvariantError,
  ValidationError,
  classify
} from './core/errors.ts';
import { createReporter, reportDir, signature } from './core/report.ts';
import { writeBroadcast } from './core/claim.ts';
import {
  backfill as backfillIndex,
  indexInsert,
  indexStats,
  indexStatus,
  readMessagesFromIndex,
  rebuild as rebuildIndex,
  recordMessage,
  resetIndexStatus,
  tableChecksums
} from './core/index-db.ts';
import { closeDb, dbRuntimeState, detectBackend, openDb, resetDbRuntime } from './core/db-runtime.ts';
import {
  configureIndexStore,
  flushMirrors,
  hasSchema,
  sourceStamp,
  preferredBroadcasts,
  preferredHandoff,
  preferredLocks,
  preferredQueue
} from './core/index-sync.ts';
import { acquireRebuildLock, indexSync } from './core/index-db.ts';
import {
  envelopeHead,
  envelopeLines,
  makeEnvelope,
  mergeEnvelopeParts,
  newMessageID,
  parseEnvelopeLine,
  sha256,
  splitBody
} from './core/envelope.ts';
import { appendMessage, messageFiles, messagesFile, readMessages } from './core/store.ts';
import { staleClass } from './core/stale.ts';
import {
  activeFacts,
  factsFile,
  factInjection,
  formatFact,
  invalidateFacts,
  isFactID,
  listFacts,
  metricsOf,
  noteStaleDeliveries,
  readFactSeen,
  readLedger,
  retractFact,
  retractedLabel,
  settleFact,
  workspaceFacts,
  workspaceOf,
  writeLedger
} from './core/facts.ts';
import { FILE_LOCK_ATTEMPTS, FILE_LOCK_RETRY_DELAYS_MS, FILE_LOCK_STALE_MS, tryAcquireFileLock, withFileLock } from './core/file-lock.ts';
import {
  answerDecision,
  decideLine,
  decisionFile,
  decisionsDir,
  decisionsForSession,
  formatDecision,
  isDecisionKey,
  listDecisions,
  normalizeQuestion,
  expireConflictDecisions,
  openConflictDecision,
  openConflictOf,
  openDecision,
  questionHash,
  readAllDecisions,
  readDecisions,
  resolveDecision,
  supersedeDecision,
  writeDecisions
} from './core/decisions.ts';
import {
  basedOnLabel,
  compareBasedOn,
  conflictDecision,
  gitHead,
  localSnapshot,
  staleLine
} from './core/tri-state.ts';
import { defineTerm, glossaryLineFor, pairKey, readGlossary, recordConflict, termsFor, writeGlossary } from './core/glossary.ts';
import { messageSemantics, normalizeFactIds, normalizeGrade, unlabeledPrefix } from './core/messages.ts';
import { appendThreadMessage, createInboxStore, createThreadStore, extractInbound } from './core/storage.ts';
import { createSignal } from './ids.ts';
import { AWARENESS_LIST_LIMIT, AWARENESS_TTL_MS, BUILTIN_PROTECT, PLUGIN_VERSION } from './constants.ts';
import { log } from './log.ts';
import type { JsonObject } from './types.ts';
import { createToolKit, registerTools } from './tools/index.ts';
import type { CollabContext } from './types.ts';

/**
 * `@inf-studio/collab` — the zero-dependency port of
 * `.opencode/plugins/collab.js`: cross-session collaboration (threads / inbox)
 * plus the cross-workspace hand-off chain (broadcast → score → atomic claim →
 * receipt), exposed as the native `collab_*` tools and one `context` hook.
 *
 * The host contract is the plugin `ctx` (in-process capability), never an HTTP
 * client: a plugin that reached the server through a port/token would break as
 * soon as the instance moved. `@opencode/client` is imported for *types* only.
 */
const plugin: Plugin.Plugin = {
  id: 'collab',

  async setup(host) {
    const ctx = host as unknown as CollabContext;
    const directory = ctx?.location?.directory;
    if (!directory || !ctx?.tool?.transform || !ctx?.session?.hook || !ctx?.storage) {
      log('setup() skipped: host has no location/tool/session/storage domain (incomplete setup context)');
      return;
    }

    const readConfig = createConfigReader(ctx.options);
    // 0.9.0 (R5): the index-preferred readers need the configured projection
    // path, but they are called from sync tool code that has no `ctx`. One
    // provider, registered here, like the config reader itself.
    const indexStoreOptions = () => {
      const config = readConfig();
      return { dbPath: config.dbPath, storage: config.storage };
    };
    configureIndexStore(indexStoreOptions);
    const inbox = createInboxStore(ctx);
    const threads = createThreadStore(ctx);
    const signal = createSignal();
    const chain = createHandoffChain(ctx, readConfig);
    // Defect self-reporting (R1–R8): a side path shared by every tool.
    const reporter = createReporter({ ctx, readConfig });
    const kit = createToolKit({ ctx, readConfig, inbox, threads, signal, chain, reporter });
    const tools = registerTools(kit);

    // 1) Native tools (sync transform; no external data fetched inside it).
    const toolRegistration = await ctx.tool.transform(editor => {
      for (const definition of tools) editor.add(definition);
    });

    // 2) Unread queue: event-driven, never polls, never blocks setup.
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: EVENT_TYPES,
          signal: controller.signal
        })) {
          const inbound = extractInbound(event as never);
          if (!inbound) continue;

          await inbox.update(inbound.sessionID, current => {
            if (
              current.messages.some(
                message => message.id === inbound.id || (inbound.cid && message.cid === inbound.cid)
              )
            ) {
              return current; // events can repeat
            }
            return { ...current, messages: [...current.messages, inbound] };
          });

          // Keep the shared thread in sync for messages that did not originate
          // from this plugin instance (e.g. the CLI), and wake local waiters.
          if (inbound.threadID) {
            await threads.update(inbound.threadID, current =>
              appendThreadMessage(current, {
                threadID: inbound.threadID,
                cid: inbound.cid,
                kind: inbound.kind,
                text: inbound.text,
                ts: inbound.ts,
                from: inbound.from,
                fromSession: inbound.fromSession,
                toSession: inbound.sessionID
              })
            );
          }
          // R1 (0.1.6): the receiving plugin's `[ack] <cid> seen`. It closes no
          // hand-off — it only stamps `delivery.seenAt`, which stops the
          // requester from resending and shows `seen=<age>` in `collab_list`.
          try {
            const seen = await chain.applyAck(inbound.text, inbound.fromSession);
            if (seen) log(`delivery ${seen.bid} seen${seen.delivery?.seenAt ? '' : ' (already seen)'}`);
          } catch (error) {
            log('ack handling failed:', (error as Error)?.message ?? error);
          }
          // A `[handoff] DONE|BLOCKED <bid> <摘要>` receipt closes the matching
          // hand-off; a `DECLINE` from the asked candidate skips it and asks the
          // next one (§5.3); anything else is only stored in the inbox (§8).
          // R7: only a message that did not declare a kind (legacy) or declared
          // `reply` may move a record — an explicit note/request is a deliberate
          // non-receipt, however it is worded (it may quote the template).
          try {
            const closed = await chain.applyReceipt(inbound.text, inbound.fromSession, Date.now(), {
              kind: inbound.kind,
              explicit: inbound.kindExplicit === true
            });
            if (closed) log(`handoff ${closed.bid} → ${closed.state}`);
            const declined = await chain.applyDecline(inbound.text, inbound.fromSession);
            if (declined) {
              log(
                `handoff ${declined.bid} declined → ${declined.state}` +
                  `${declined.asked?.sid ? `, asked ${declined.asked.sid}` : ''}`
              );
            }
          } catch (error) {
            log('receipt handling failed:', (error as Error)?.message ?? error);
          }
          if (inbound.kind === 'reply') signal.notify();
        }
      } catch (error) {
        if (!controller.signal.aborted) log('event stream ended:', (error as Error)?.message ?? error);
      }
    })();

    // 3) Injection hook (unread inbox + open hand-offs, once per session).
    //
    // 0.6.0 (R2): the same hook is the session's **waiter heartbeat** — one
    // refresh per model request, so a queued session that is working through a
    // long turn is never mistaken for a zombie waiter and reaped. `waiterTtlMs`
    // (default 10min) is far longer than a heartbeat interval; the write itself
    // is throttled to `LOCK_WAITER_TOUCH_MS` (30s) inside `touchWaiters`, and a
    // session that is not queued costs one directory scan and zero writes.
    // `waiterHeartbeat:false` turns this half off (the tool-call half stays).
    const contextHook = createContextHook(kit.deps);
    const hookRegistration = await ctx.session.hook('context', async event => {
      const config = readConfig();
      if (config.waiterHeartbeat !== false && event?.sessionID) {
        try {
          await touchWaiters(event.sessionID);
        } catch (error) {
          // A heartbeat is bookkeeping: it must never fail a model request.
          log('waiter heartbeat failed:', (error as Error)?.message ?? error);
        }
      }
      await contextHook(event);
      // 0.6.0 (`collab_freeze`): a frozen session learns it once. The block is
      // pushed **first** and `notifiedAt` is stamped after — the same F1 rule the
      // follow-up hint uses, so an injection that throws shows it again next
      // request instead of losing it for good.
      try {
        if (event?.sessionID && Array.isArray(event.system)) {
          const notice = await freezeNotice(event.sessionID, { lineage: createLineage(ctx) });
          if (notice) {
            event.system.push({ type: 'text', text: freezeNoticeText(notice.entry, notice.via) });
            markFreezeNotified(notice.entry, event.sessionID);
          }
        }
      } catch (error) {
        // A freeze notice is bookkeeping: it must never fail a model request.
        log('freeze notice failed:', (error as Error)?.message ?? error);
      }
    });

    // 4) The board's write actions + the read-only snapshot, over one RPC
    // (C2, 0.3.0 read; 0.8.0 `board2-actions` write). Optional: an older host
    // without `ctx.rpc` keeps the tools and loses only the panel.
    //
    // The four actions run the **same** core functions the native tools run
    // (`core/actions.ts`), so the gates are not re-implemented:
    //   - protected lineage → `escalate` is refused with 0 prompts **and** 0
    //     queue writes (a GUI click is not an owner-queue request);
    //   - a read-only agent target → `queue`, forced (inside `escalateAction`);
    //   - a frozen object → refused before anything is written (freeze wins);
    //   - `archive` refuses `[protected*]` (the one-way boundary);
    //   - the confirmation is the GUI dialog, so the server always executes.
    // Every call appends one audit line (success *and* failure, R5).
    const actionContext: ActionContext = {
      ctx,
      readConfig,
      resolveTarget: kit.resolveTarget,
      resolveMode: kit.resolveMode,
      senderLabel: kit.senderLabel,
      listSessions: input => chain.listSessions(input)
    };
    const isBid = (value: string): boolean => /^b_[0-9a-f]{8,32}$/i.test(value);
    const isThread = (value: string): boolean => /^t_[0-9a-z]+_[0-9a-z]+$/i.test(value);

    /** The scope a board `freeze` / `unfreeze` means when the caller omits one. */
    const scopeOf = (input: JsonObject | undefined, target: string): string => {
      const given = String(input?.scope ?? '').trim();
      if (given) return given;
      if (isBid(target)) return 'bid';
      if (target.startsWith('/')) return 'workspace';
      return 'session';
    };

    async function runAction(action: 'escalate' | 'freeze' | 'unfreeze' | 'archive', input: JsonObject | undefined): Promise<ActionReceipt> {
      const sessionInput = String(input?.session ?? '').trim();
      const actor = sessionInput || 'gui';
      const target = String(input?.target ?? '').trim();
      const reason = sanitizeActionReason(input?.reason);
      let receipt: ActionReceipt;
      if (action === 'escalate' && !sessionInput) {
        // R2: a board escalation must name its requester. Without one the prompt
        // would go out with `fromSessionID:"gui"` — the counterpart would have
        // nowhere to send a receipt — and the audit line would name no session.
        // `freeze` / `unfreeze` / `archive` do not need an actor, so they keep
        // the `"gui"` fallback.
        receipt = {
          ok: false,
          action,
          target,
          detail: '拒绝加急：没有调用方会话（session）。看板动作必须带上发起会话，否则对方无处回执。未写入任何内容。'
        };
      } else {
        try {
          const result =
            action === 'escalate'
              ? await escalateAction(actionContext, {
                  actor,
                  bid: isBid(target) ? target : '',
                  threadID: !isBid(target) && isThread(target) ? target : '',
                  session: isBid(target) || isThread(target) ? '' : target,
                  reason: input?.reason,
                  mode: input?.mode,
                  // R3 (board): protected targets are refused, not queued.
                  protected: 'refuse',
                  confirm: true
                })
              : action === 'archive'
                ? await archiveAction(actionContext, {
                    actor,
                    bid: isBid(target) ? target : '',
                    session: isBid(target) ? '' : target,
                    restore: input?.restore === true,
                    confirm: true
                  })
                : await freezeAction(actionContext, {
                    actor,
                    scope: scopeOf(input, target),
                    target,
                    reason: input?.reason,
                    until: input?.until,
                    freeze: action !== 'unfreeze',
                    confirm: true
                  });
          receipt = { ok: result.ok, action, target: result.target, detail: result.detail };
        } catch (error) {
          // A readable refusal (protected / frozen / validation) is a receipt with
          // `ok:false` — the panel keeps working; only the toast reports it (R6).
          const detail = (error as Error)?.message ?? String(error ?? 'unknown error');
          receipt = { ok: false, action, target, detail };
        }
      }
      appendAudit({
        at: Date.now(),
        actor,
        action,
        target: receipt.target || target,
        ok: receipt.ok,
        // Success records the caller's own reason; a failure records the verdict.
        reason: receipt.ok ? reason : receipt.detail
      });
      return receipt;
    }

    const snapshotter = createSnapshotReader({
      sessions: input => chain.listSessions(input),
      // R5: the projection is preferred when it can prove itself current
      // (`synced_at` ≥ every source mtime); otherwise the JSON readers below.
      locks: async () => (await preferredLocks(indexStoreOptions())) ?? allLocks(),
      handoffs: async () => (await preferredBroadcasts(indexStoreOptions())) ?? allBroadcasts(),
      // 0.4.2: the requester's own owner-queue items, for the TUI panel's third
      // block. Read-only, and only for the session the caller names.
      queue: async from => (await preferredQueue(from, indexStoreOptions())) ?? mineFor(from),
      // 0.9.0 (`11-20-collab-store`, R4): the projection verdict behind the
      // board's `[索引不可用]` marker. Read-only, cached (30s), and it never
      // imports sqlite when `storage:"json"` (openDb returns null first).
      index: () => {
        const config = readConfig();
        return indexStatus({ dbPath: config.dbPath, storage: config.storage });
      },
      // 0.6.0 (`collab_freeze`): live freezes → the optional `frozen` / `freeze`
      // markers. Read-only; an empty file is simply "nothing is frozen".
      freezes: () => readFreezes()
    });
    const rpcDomain = (host as { rpc?: Plugin.Context['rpc'] }).rpc;
    const rpcRegistration = rpcDomain
      ? await rpcDomain
          .register(CollabState, {
            // `actions:false` (collab.json) hides the row; the methods below stay.
            snapshot: async (input): Promise<Snapshot> => ({
              ...(await snapshotter.snapshot(input)),
              actions: readConfig().boardActions !== false
            }),
            escalate: input => runAction('escalate', input as JsonObject | undefined),
            freeze: input => runAction('freeze', input as JsonObject | undefined),
            unfreeze: input => runAction('unfreeze', input as JsonObject | undefined),
            archive: input => runAction('archive', input as JsonObject | undefined)
          })
          .catch(error => {
            // A failed registration must not fail the whole plugin: the tools
            // and the context hook are the product, the sidebar is a view.
            log('rpc registration failed:', (error as Error)?.message ?? error);
            return undefined;
          })
      : undefined;
    log(
      rpcRegistration
        ? `rpc ok: collab.state.snapshot + 4 write actions (boardActions=${readConfig().boardActions})`
        : 'rpc skipped: host has no ctx.rpc'
    );

    const initial = readConfig();
    log(
      `setup ok: version=${PLUGIN_VERSION} directory=${directory} tools=${tools.length} ` +
        `aliases=${Object.keys(initial.aliases).length} ` +
        `protect=${initial.protect.length} autoDeliver=${initial.autoDeliver} maxInject=${initial.maxInject} ` +
        `readonly=${initial.readonlyAgents.join(',')} allowWrite=${initial.allowWrite}`
    );
    // 0.5.0: the spawned-session archive is a background behaviour; say what it
    // will do at startup so an operator does not have to read the docs.
    log(
      `archiveSpawned=${initial.archiveSpawned} archiveGraceMs=${initial.archiveGraceMs}` +
        `${initial.archiveSpawned ? '' : ' (自动归档已关闭，手动 collab_archive 仍可用)'}`
    );
    // 0.6.0: the two consistency knobs, so an operator sees the effective values
    // (and whether the heartbeat half is off) without reading the config file.
    log(
      `waiterTtlMs=${initial.waiterTtlMs} waiterHeartbeat=${initial.waiterHeartbeat} ` +
        `dedupeWindowMs=${initial.dedupeWindowMs}${initial.dedupeWindowMs ? '' : ' (正文去重已关闭)'}`
    );
    // 0.7.0 (R5): whether the read-only awareness hint is on — the one config
    // flip an operator may want to confirm without opening collab.json.
    log(`awareness=${initial.awareness}${initial.awareness === 'off' ? ' (自动感知提示已关闭)' : ''}`);
    // R8④: the report entry point is visible without reading any docs — one
    // line in the plugin's own setup log (stderr), next to the other diagnostics.
    log(
      `reportDir=${reportDir()} report.to=${initial.report?.to ?? '(unset: 只落盘，不投递)'}` +
        `${initial.report?.enabled === false ? ' report.enabled=false' : ''}` +
        // R9.2: the maintainer's "SessionStart" view (this log line is the only
        // startup surface a plugin has).
        ` pendingReports=${reporter.pending().count}`
    );

    return async () => {
      controller.abort();
      await Promise.resolve(toolRegistration?.dispose?.()).catch(() => {});
      await Promise.resolve(hookRegistration?.dispose?.()).catch(() => {});
      await Promise.resolve(rpcRegistration?.dispose?.()).catch(() => {});
      log('cleanup: unsubscribed');
    };
  }
};

export default plugin;

/**
 * Pure helpers exported for the deterministic harness
 * (`test/handoff-harness.mjs`): the ruleset merge (`R3`) and the fail-closed
 * action whitelist (`R2`) are the two places where a mistake would silently
 * widen permissions, so they are unit-testable without a host.
 * No I/O, no `ctx` — the plugin's own entrypoint is `default` only.
 */
export const __internals = {
  PLUGIN_VERSION,
  BUILTIN_PROTECT,
  // 0.7.0 (R1–R5): the awareness hint is a pure renderer + two bounds; the
  // harness checks the wording and the 10-minute page budget without a host.
  awarenessText,
  AWARENESS_TTL_MS,
  AWARENESS_LIST_LIMIT,
  // Defect-reporting taxonomy (R1/R4/R6) — pure, unit-testable without a host.
  classify,
  signature,
  staleClass,
  ValidationError,
  GuardConflictError,
  InvariantError,
  DeliveryError,
  ExtractError,
  COLLAB_TOOL_ACTIONS,
  collabPermissionRules,
  normalizeRules,
  mergeRules,
  missingRules,
  assertCollabOnly,
  // Resource leases (0.2.0) — the normaliser is the one rule that decides which
  // two spellings are "the same resource", so it is unit-tested without a host.
  normalizeResource,
  normalizeTtl,
  sanitizeReason,
  lockFile,
  // Sidebar contract (0.3.0) — the read-only snapshot assembly, unit-testable
  // with injected readers (no host, no `~/.config` directory).
  CollabState,
  buildSnapshot,
  // Three-layer board (0.6.0) — the one pure derivation GUI / TUI share.
  buildBoard,
  // The orphan fallback (0.6.0 / pure-tested in 0.6.1) — rows no session owns.
  boardOrphans,
  // Three-level relation graph (0.8.0) — the one pure derivation GUI / TUI share.
  buildGraph,
  // 0.8.2 (`graph-zoom`): the pure layout + view transform (zoom / pan / labels).
  // GUI-only, but unit-testable without a window — which is the point.
  layoutGraph,
  truncateLabel,
  GRAPH_LABEL_MAX,
  clampZoom,
  clampPan,
  viewBoxOf,
  viewBoxAttr,
  zoomBy,
  // The four-number vocabulary (0.6.0, R4) — pure, shared by GUI / TUI / tests.
  countsOf,
  pendingCountOf,
  // Spawned-session archive (0.5.0) — the eight-rule gate and the one writer,
  // unit-testable with an injected gate (no host).
  shouldArchive,
  archiveSession,
  // Temporary freeze (0.6.0) — the file is a global, read-merge-write store, so
  // its merge and precedence lookup are unit-testable without a host (the
  // harness also proves two concurrent writers keep each other's entries).
  readFreezes,
  mergeFreezes,
  freezeFor,
  // 0.8.0 (`board2-actions`): the four write actions + the append-only audit
  // writer. The RPC handlers call exactly these functions, so the harness can
  // prove the gates (protected / read-only / frozen) with a fake host.
  escalateAction,
  freezeAction,
  archiveAction,
  appendAudit,
  // 0.9.0 (`11-20-collab-store`): the message log + the rebuildable projection.
  // The harness drives these directly (no host, temp paths): the envelope line
  // format, the encoded 1MB split, the rebuild idempotency, the 8192-char FTS body, the
  // circuit breaker and the 3-process write race all need the real functions.
  ENVELOPE_VERSION: 1,
  sha256,
  newMessageID,
  splitBody,
  makeEnvelope,
  envelopeLines,
  envelopeHead,
  parseEnvelopeLine,
  mergeEnvelopeParts,
  appendMessage,
  readMessages,
  messageFiles,
  messagesFile,
  openDb,
  closeDb,
  resetDbRuntime,
  dbRuntimeState,
  detectBackend,
  resetIndexStatus,
  indexInsert,
  indexStatus,
  indexStats,
  readMessagesFromIndex,
  recordMessage,
  tableChecksums,
  rebuildIndex,
  backfillIndex,
  // 0.9.0 R5 (review): the index-preferred readers + the sync entry point. The
  // harness proves the index path and the JSON path are byte-identical, and
  // that a stale projection falls back instead of serving old rows.
  indexSync,
  acquireRebuildLock,
  preferredBroadcasts,
  preferredHandoff,
  preferredLocks,
  preferredQueue,
  allBroadcasts,
  allLocks,
  mineFor,
  allQueueItems,
  // 0.9.0 review: mirror flush (deterministic in tests) + freshness introspection.
  flushMirrors,
  hasSchema,
  sourceStamp,
  // 0.9.0 review: the six extra delivery points and their writer APIs — the
  // delivery-history test drives the real functions (no second implementation).
  createHandoffChain,
  createReporter,
  writeBroadcast,
  // 0.9.1 (`11-20-collab-contract`): the contract store + the pure renderers.
  // The replay test (two requests, both still carrying `[mission]`) and the
  // truncation test need the real functions, not a re-implementation.
  contractFile,
  contractExists,
  emptyContract,
  readContract,
  writeContract,
  updateContract,
  updateContractIfExists,
  normalizeContract,
  renderInjection,
  effectiveMission,
  unfinishedTodos,
  stampTurn,
  openTodos,
  nextTodoSeq,
  formatAge,
  resolveMissionAnchor,
  messageTextOf,
  firstHumanInstruction,
  checkEvidence,
  // 0.9.2 (`11-20-collab-gate`): the collaboration gate is pure except for its
  // one audit line, so the harness drives the real function (statement parsing,
  // override validation, the overflow reminder) instead of a re-implementation.
  evaluateGate,
  normalizeGateMode,
  appendGateAudit,
  gateAuditFile,
  GATE_TODO_LIMIT,
  // 0.9.3 (`11-20-collab-drift`): drift evaluation + the wake condition are pure
  // (clock injected), so the harness can prove the 4th/5th turn boundary and the
  // 24h transition without waiting, and drive `markDrifted` directly.
  evaluateDrift,
  markDrifted,
  driftUnresolved,
  parseWakeWhen,
  normalizeWakeWhen,
  wakeExpired,
  wakeLabel,
  wakePhrase,
  DRIFT_NO_ADVANCE_TURNS,
  DRIFT_PARKED_MS,
  SUSPEND_FALLBACK_MS,
  WAKE_KINDS,
  // 0.9.4 (`11-20-collab-facts`): the facts ledger, the three-state comparison
  // and the pair glossary are pure enough to drive directly — the test needs the
  // real read/write path (tmp+rename, epoch, derivation) and a clock-free
  // `compare` it can feed explicit baselines to.
  factsFile,
  readLedger,
  writeLedger,
  workspaceFacts,
  workspaceOf,
  activeFacts,
  listFacts,
  settleFact,
  retractFact,
  invalidateFacts,
  metricsOf,
  noteStaleDeliveries,
  formatFact,
  retractedLabel,
  factInjection,
  readFactSeen,
  isFactID,
  compareBasedOn,
  localSnapshot,
  staleLine,
  basedOnLabel,
  gitHead,
  pairKey,
  readGlossary,
  writeGlossary,
  termsFor,
  defineTerm,
  recordConflict,
  glossaryLineFor,
  // 0.9.4: the message-side helpers (grade / factIds / `[未标注]`).
  normalizeGrade,
  normalizeFactIds,
  messageSemantics,
  unlabeledPrefix,
  // 0.9.4 review: the cross-process lock around the whole-file ledgers. The
  // two-process regression drives `settleFact` through this path directly.
  withFileLock,
  tryAcquireFileLock,
  FILE_LOCK_STALE_MS,
  FILE_LOCK_ATTEMPTS,
  FILE_LOCK_RETRY_DELAYS_MS,
  // 0.9.5 (`11-20-collab-decide`): the decision ledger + the role four-tuple.
  // The test drives the real storage (lazy read, lock + rename, `D#` monotonic)
  // and the single `decision:` resolver directly — no re-implementation.
  decisionsDir,
  decisionFile,
  readDecisions,
  writeDecisions,
  readAllDecisions,
  openDecision,
  answerDecision,
  supersedeDecision,
  expireConflictDecisions,
  openConflictDecision,
  openConflictOf,
  listDecisions,
  decisionsForSession,
  decideLine,
  formatDecision,
  isDecisionKey,
  normalizeQuestion,
  questionHash,
  resolveDecision,
  conflictDecision,
  peerRolesOf,
  primaryRole,
  derivePeerRoles,
  upsertPeers,
  deciderOf,
  recordPeers,
  roleLine,
  // 0.9.6 (`11-20-collab-pacing`): the window buffer, the delta gate and the
  // delivery policy. The pacing test drives the real functions with an injected
  // clock (no waiting 2 minutes) and a temp state file.
  PACING_FILE,
  PACING_VERSION,
  PACING_WINDOW_MS,
  PACING_WINDOW_MAX_MS,
  PACING_SLA_MS,
  PACING_RETRY_MS,
  PACING_MAX_ITEMS,
  emptyPacingState,
  normalizePacingState,
  readPacing,
  writePacing,
  updatePacing,
  windowFor,
  mergeIntoWindow,
  pacingDedupeKey,
  pacingBodyKey,
  windowDue,
  windowFlushAt,
  windowIsLate,
  renderWindow,
  windowItems,
  batchKind,
  batchThread,
  medianGapMs,
  dayKey,
  dayMessageTimes,
  pacingMetrics,
  refreshMetrics,
  isResendID,
  counterOf,
  bumpCounter,
  armFlush,
  armedFlushes,
  clearFlushTimers,
  nextFlushAt,
  pacingPolicy,
  configurePacingRuntime,
  pacingRuntime,
  resetPacingRuntime,
  enqueueWindow,
  flushDueWindows,
  flushAllWindows,
  pendingWindows,
  noopInfo,
  lastSentOf,
  recordSentBaseline,
  recordNoop,
  pacingCounters,
  computeDelta,
  deltaSnapshot,
  todoStatusHash,
  noDeltaLine,
  upsertMetrics
};
