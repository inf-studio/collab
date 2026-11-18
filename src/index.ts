import type { Plugin } from '@opencode/plugin';
import { createContextHook } from './hooks/context.ts';
import { createConfigReader } from './config.ts';
import { COLLAB_TOOL_ACTIONS, EVENT_TYPES } from './constants.ts';
import { createHandoffChain } from './core/chain.ts';
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
import { staleClass } from './core/stale.ts';
import { appendThreadMessage, createInboxStore, createThreadStore, extractInbound } from './core/storage.ts';
import { createSignal } from './ids.ts';
import { BUILTIN_PROTECT, PLUGIN_VERSION } from './constants.ts';
import { log } from './log.ts';
import { createToolKit, registerTools } from './tools/index.ts';
import type { CollabContext } from './types.ts';

/**
 * `@inf-studio/collab` — the zero-dependency port of
 * `.opencode/plugins/collab.js`: cross-session collaboration (threads / inbox)
 * plus the cross-workspace hand-off chain (broadcast → score → atomic claim →
 * receipt), exposed as the ten native `collab_*` tools and one `context` hook.
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
    const hookRegistration = await ctx.session.hook('context', createContextHook(kit.deps));

    const initial = readConfig();
    log(
      `setup ok: version=${PLUGIN_VERSION} directory=${directory} tools=${tools.length} ` +
        `aliases=${Object.keys(initial.aliases).length} ` +
        `protect=${initial.protect.length} autoDeliver=${initial.autoDeliver} maxInject=${initial.maxInject} ` +
        `readonly=${initial.readonlyAgents.join(',')} allowWrite=${initial.allowWrite}`
    );
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
  assertCollabOnly
};
