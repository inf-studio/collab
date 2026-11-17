import type { ConfigReader } from '../config.ts';
import { BCAST_LEASE_MS, CONFIG_PATH, INBOX_TEXT_LIMIT, REPLY_POLL_MS, STORAGE_ALIASES } from '../constants.ts';
import type { HandoffChain } from '../core/chain.ts';
import { createLineage } from '../core/lineage.ts';
import { appendThreadMessage } from '../core/storage.ts';
import type { InboxStore, ThreadStore } from '../core/storage.ts';
import { handoffActions } from '../core/verdict.ts';
import { envelope, newCorrelationID, normalizeKind } from '../ids.ts';
import type { WakeSignal } from '../ids.ts';
import { errText, log } from '../log.ts';
import type { CollabContext, JsonObject, SessionInfoLike, ToolContext, ToolResult } from '../types.ts';
import { asObject, fmtTime, sessionState, shortID, truncate, truncateRaw } from '../util.ts';

/** `jsonInput` — the object schema every tool declares (extra keys refused). */
export function jsonInput(schema: JsonObject): JsonObject {
  return { type: 'object', additionalProperties: false, ...schema };
}

export interface ToolDeps {
  ctx: CollabContext;
  readConfig: ConfigReader;
  inbox: InboxStore;
  threads: ThreadStore;
  signal: WakeSignal;
  chain: HandoffChain;
}

export interface Target {
  sessionID: string;
  alias?: string;
  info: SessionInfoLike;
}

export interface DeliveryMode {
  mode: string;
  forced: boolean;
}

/** Everything a tool file needs besides `deps`: the shared delivery helpers. */
export interface ToolKit {
  deps: ToolDeps;
  resolveTarget(raw: unknown): Promise<Target>;
  senderLabel(sessionID: string | undefined): string;
  isReadonlyAgent(agent: unknown): boolean;
  resolveMode(requested: unknown, agent: unknown): DeliveryMode;
  dispatch(input: {
    context: ToolContext | undefined;
    input: JsonObject | undefined;
    kind: string;
    threadID: string | undefined;
    mode: string;
    forced: boolean;
    notes: string[];
    target: Target;
  }): Promise<ToolResult>;
  waitForReply(threadID: string, timeoutMs: number, context: ToolContext | undefined): Promise<ToolResult>;
  deliverAsk(input: {
    record: JsonObject;
    target: string;
    wake: boolean;
    threadID?: string;
    spawn?: boolean;
  }): Promise<boolean>;
}

export function createToolKit(deps: ToolDeps): ToolKit {
  const { ctx, readConfig, threads, signal } = deps;

  /** Resolve `<alias>|ses_…` → existing session info, or throw a readable error. */
  async function resolveTarget(raw: unknown): Promise<Target> {
    const target = String(raw ?? '').trim();
    if (!target) throw new Error('target 不能为空：请给 ses_… 会话 id 或 collab.json 里的别名');

    let sessionID = target;
    let alias: string | undefined;
    if (!target.startsWith('ses_')) {
      const stored = asObject(await ctx.storage.get(STORAGE_ALIASES));
      const table: Record<string, string> = { ...stored, ...readConfig().aliases };
      sessionID = table[target];
      if (!sessionID) {
        throw new Error(
          `未知目标 "${target}"：既不是 ses_ 会话 id，也不在别名表里` +
            `（${CONFIG_PATH} 的 aliases，或 ~/.config/opencode/collab-aliases.json）`
        );
      }
      alias = target;
    }

    let info: SessionInfoLike;
    try {
      info = await ctx.session.get({ sessionID });
    } catch (error) {
      throw new Error(`会话不存在或不可读：${sessionID}（${errText(error)}）`, { cause: error });
    }
    return { sessionID, alias, info };
  }

  function senderLabel(sessionID: string | undefined): string {
    const hit = Object.entries(readConfig().aliases).find(([, value]) => value === sessionID);
    return hit ? hit[0] : shortID(sessionID);
  }

  function isReadonlyAgent(agent: unknown): boolean {
    const id = String(agent ?? '').trim();
    return Boolean(id) && readConfig().readonlyAgents.includes(id);
  }

  /**
   * `queue` is the default. Read-only agents never get `steer`: an inbound
   * hand-off must not merge into the turn they are already running.
   */
  function resolveMode(requested: unknown, agent: unknown): DeliveryMode {
    if (isReadonlyAgent(agent)) return { mode: 'queue', forced: true };
    return { mode: requested === 'steer' ? 'steer' : 'queue', forced: false };
  }

  /** Delivery + thread bookkeeping shared by `collab_send` and `collab_reply`. */
  async function dispatch({
    context,
    input,
    kind,
    threadID,
    mode,
    forced,
    notes,
    target
  }: {
    context: ToolContext | undefined;
    input: JsonObject | undefined;
    kind: string;
    threadID: string | undefined;
    mode: string;
    forced: boolean;
    notes: string[];
    target: Target;
  }): Promise<ToolResult> {
    const config = readConfig();
    const body = String(input?.text ?? '').trim();
    if (!body) throw new Error('text 不能为空');

    const { sessionID, alias, info } = target;
    // Lineage guard: the target itself *or* any ancestor in the protect list.
    // Fail-closed, replies included — see the note in `docs/collab.md` §11.4.
    const guard = await createLineage(ctx).protectedAncestor(sessionID, config.protect);
    if (guard) {
      const where = guard.depth === 0 ? '本身' : `的祖先（第 ${guard.depth} 级）${guard.sessionID} `;
      throw new Error(
        `拒绝投递：目标 ${sessionID}${alias ? `（别名 ${alias}）` : ''} ${where}在 protect 名单内` +
          `（${CONFIG_PATH} 的 protect + 内置硬名单，覆盖其任意层级子会话）。未发送任何内容。${
            kind === 'reply' ? '回执同样适用该护栏（fail-closed）。' : ''
          }`
      );
    }
    if (context?.sessionID && context.sessionID === sessionID) {
      throw new Error('拒绝投递：target 就是当前会话本身（会导致自我排队）。未发送任何内容。');
    }

    const from = senderLabel(context?.sessionID);
    const cid = newCorrelationID();
    const text = envelope({ from, kind, threadID, body });
    const targetLine =
      `${sessionID}${alias ? ` (alias=${alias})` : ''}  agent=${info?.agent ?? '?'}  ` +
      `state=${sessionState(info)}  title="${truncate(info?.title ?? '(untitled)', 60)}"`;
    const modeLine = forced ? 'queue(forced)' : mode;
    const tailNotes = [...(notes ?? [])];
    if (forced) tailNotes.push('只读 agent：已强制 queue（入队，不打断对方当前轮）。');

    if (input?.confirm !== true) {
      return {
        content: [
          '未投递（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。',
          `目标: ${targetLine}`,
          `kind=${kind}  thread=${threadID}`,
          `模式: ${modeLine}`,
          ...tailNotes.map(note => `注: ${note}`),
          '将发送:',
          text
        ].join('\n')
      };
    }

    const admitted = await ctx.session.prompt({
      sessionID,
      text,
      delivery: mode,
      metadata: {
        collab: {
          from,
          fromSessionID: context?.sessionID ?? 'unknown',
          cid,
          kind,
          threadID,
          ts: Date.now()
        }
      }
    });

    const thread = threadID
      ? await threads.update(threadID, current =>
          appendThreadMessage(current, {
            threadID,
            cid,
            kind,
            text: truncateRaw(body, INBOX_TEXT_LIMIT),
            ts: Date.now(),
            from,
            fromSession: context?.sessionID ?? 'unknown',
            toSession: sessionID
          })
        )
      : undefined;

    return {
      content: [
        `已投递 → ${targetLine}`,
        `kind=${kind}  thread=${threadID}  status=${thread?.status ?? '-'}`,
        `mode=${modeLine}  message=${admitted?.id ?? '?'}  delivery=${admitted?.delivery ?? '?'}`,
        ...tailNotes.map(note => `注: ${note}`),
        kind === 'request'
          ? '提示: 对方回执后可 collab_wait {threadID} 等结果；不要用 steer 打断对方的当前轮。'
          : kind === 'reply'
            ? '提示: 回执已记入 thread；对端可用 collab_wait {threadID} 取到全文。'
            : '提示: note 只作通知，不改变 thread 状态。'
      ].join('\n')
    };
  }

  /**
   * Wait for a reply on a thread. Only replies *after the last request* count, so
   * reusing a thread (`collab_send` with an existing `threadID`) cannot return the
   * previous round's reply. Ordering comes from the append order in `msgs` (ts can
   * collide within the same millisecond); threads without a recorded request fall
   * back to "any reply", which keeps old data working.
   */
  async function waitForReply(
    threadID: string,
    timeoutMs: number,
    context: ToolContext | undefined
  ): Promise<ToolResult> {
    const deadline = Date.now() + timeoutMs;
    const me = context?.sessionID;
    const notes: string[] = [];

    const initial = await threads.read(threadID);
    if (!initial) {
      throw new Error(
        `没有 thread ${threadID}：threadID 可能拼错，或该 thread 由别的项目/目录（不同 location）创建。` +
          `请用 collab_inbox 核对 threadID；若请求刚发出，稍后重试。`
      );
    }
    if (me && me !== initial.fromSession && me !== initial.toSession) {
      throw new Error(
        `拒绝等待：当前会话 ${me} 不是 thread ${threadID} 的参与方` +
          `（发起方 ${initial.fromSession ?? '?'}，对端 ${initial.toSession ?? '?'}）。`
      );
    }
    if (!me) notes.push('无会话上下文（无 sessionID）：未校验参与者身份。');

    for (;;) {
      const thread = await threads.read(threadID);
      const msgs = thread?.msgs ?? [];
      let lastRequest = -1;
      for (const [index, message] of msgs.entries()) {
        if (normalizeKind(message.kind) === 'request') lastRequest = index;
      }
      const replies = msgs
        .slice(lastRequest + 1)
        .filter(message => normalizeKind(message.kind) === 'reply')
        .filter(message => !me || message.fromSession !== me);
      if (replies.length) {
        const reply = replies[replies.length - 1];
        return {
          content: [
            `thread ${threadID} 收到回执（status=${thread?.status ?? '-'}）:`,
            `from=${reply.from} (${reply.fromSession})  ${fmtTime(reply.ts)}`,
            '',
            String(reply.text ?? ''),
            ...notes.map(note => `注: ${note}`)
          ].join('\n')
        };
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(
          `等待回执超时：thread ${threadID} 在 ${timeoutMs}ms 内没有新的 kind=reply 消息` +
            `（只看最后一次 request 之后的回执；可加大 timeoutMs，或让对端 collab_reply {threadID}）`
        );
      }
      await signal.wait(Math.min(REPLY_POLL_MS, left));
    }
  }

  /**
   * The 接管请求: one queued prompt to the chosen candidate, used both for the
   * `busy > 30min` wake-up of a peer broadcast and for telling a freshly spawned
   * session what to do. `queue` only — the plugin never interrupts anyone.
   */
  async function deliverAsk({
    record,
    target,
    wake,
    threadID,
    spawn = false
  }: {
    record: JsonObject;
    target: string;
    wake: boolean;
    threadID?: string;
    spawn?: boolean;
  }): Promise<boolean> {
    const config = readConfig();
    const guard = await createLineage(ctx).protectedAncestor(target, config.protect);
    if (guard) return false; // never deliver into a protected line
    const requester = String(record?.from?.sid ?? '');
    const from = senderLabel(requester) || 'handoff';
    const leaseMin = Math.round(BCAST_LEASE_MS / 60_000);
    const body = [
      `[collab-handoff] ${record.title ?? '(untitled)'}`,
      `提案：${record.issuePath ?? '-'}${record.workspace ? `（工作区 ${record.workspace}，scope=${record.scope}）` : ''}`,
      `影响面：${(record.affectedFiles ?? []).slice(0, 8).join(', ') || '(未标注)'}`,
      `期望：${record.expected}`,
      // R1-2: full requester sid (no `collab_inbox` lookup needed to say no).
      `发起方：${requester || '(记录里没有发起方 sid，回执用 collab_inbox 查)'}`,
      '按顺序完成（三步都不要省略）：',
      // R1 (G1): accept → receipt → "analysing in-session is not done", with
      // copy-pasteable commands (full sid + bid).
      ...handoffActions({ bid: record.bid, requester, spawn, leaseMin }),
      spawn ? '确实做不了：发 BLOCKED 回执，不要静默挂起。' : '',
      wake ? '（你已 busy 超过 30 分钟，这条是叫醒消息：不打断当前轮，排在下一轮）' : ''
    ]
      .filter(Boolean)
      .join('\n');
    try {
      await ctx.session.prompt({
        sessionID: target,
        text: envelope({ from, kind: 'request', threadID, body }),
        delivery: 'queue',
        metadata: {
          collab: {
            from,
            fromSessionID: record?.from?.sid ?? 'unknown',
            cid: newCorrelationID(),
            kind: 'request',
            threadID,
            ts: Date.now()
          }
        }
      });
      return true;
    } catch (error) {
      log(`deliverAsk failed for ${target}: ${errText(error)}`);
      return false;
    }
  }

  return { deps, resolveTarget, senderLabel, isReadonlyAgent, resolveMode, dispatch, waitForReply, deliverAsk };
}
