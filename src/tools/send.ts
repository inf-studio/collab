import { KINDS, STORAGE_ALIASES } from '../constants.ts';
import { fillOriginDirectory, readBroadcast, resolveOrigin, writeBroadcast } from '../core/claim.ts';
import { invalid } from '../core/errors.ts';
import { appendBlocked, BLOCKED_KEEP, blockedLines, canWriteBlocked, normalizeBlocked, originHint } from '../core/verdict.ts';
import { isValidThreadID, newThreadID, normalizeKind, normalizeThreadID } from '../ids.ts';
import type { JsonObject, ToolDefinition } from '../types.ts';
import { asObject } from '../util.ts';
import { canReplyToProtected, jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/** A `bid` written inside the body (`[handoff] BLOCKED b_… …`). */
const BODY_BID_RE = /\b(b_[0-9a-f]{8,32})\b/;

/**
 * `collab_send` — the raw delivery primitive: envelope + thread bookkeeping via
 * `dispatch`, with the reply-routing guards (a reply must come from a
 * participant and go to the thread's counterpart).
 */
export function sendTool(kit: ToolKit): ToolDefinition {
  const { deps, resolveTarget, resolveMode, dispatch } = kit;
  const { threads, ctx, readConfig } = deps;

  return {
    name: 'collab_send',
    description:
      "Send a message into another OpenCode session's input stream (asynchronous admit, does NOT wait for a reply). " +
      'A message is part of a hand-off thread: kind request|reply|note (default request) plus a threadID ' +
      "(auto-generated when omitted). Default mode is `queue`, which waits for the target's next turn and never " +
      'interrupts the turn it is running; `steer` must be explicit and is forced back to `queue` for read-only ' +
      'agents (explore/plan). Body is prefixed `[collab:<from>][<kind>:<threadID>] `. Requires confirm:true — ' +
      'with confirm:false it only previews. Targets in the `protect` list — and any descendant of one — are ' +
      "refused; a kind=reply must target the thread's counterpart and only a participant may send it. " +
      'One exception: a bounded receipt — kind=reply naming (in `bid` or the body) a hand-off that the ' +
      'protected target itself broadcast and the caller claimed — is queued through as the hand-off receipt. ' +
      'A legacy receipt written the ≤0.1.1 way (no `kind`, body `[handoff] DONE|BLOCKED <bid> …`) is ' +
      'recognised by that body and delivered as kind=reply. ' +
      'Content de-duplication: the same body (whitespace folded) within `dedupeWindowMs` ' +
      '(default 60s, 0 disables) is one message — on the same thread **or** already sent to the same target ' +
      'session through another thread. The repeat is not delivered and the result says so; pass `force:true` ' +
      'to deliver anyway (marked `dedupeOverridden`).',
    input: jsonInput({
      properties: {
        target: { type: 'string', description: 'Session id (`ses_…`) or an alias from collab.json.' },
        text: { type: 'string', description: 'Message body (no prefix needed; it is added for you).' },
        bid: {
          type: 'string',
          description:
            'Bounded receipt only: the `b_…` hand-off this message closes. Omit to let the body carry it ' +
            '(`[handoff] DONE b_… <summary>`). Never needed for a normal request/note.'
        },
        kind: {
          type: 'string',
          enum: KINDS,
          description:
            'request (default) = ask the target to do something; reply = answer an existing thread ' +
            '(requires threadID); note = informational, does not change the thread status.'
        },
        threadID: {
          type: 'string',
          description:
            'Thread to attach to. Omit for a new request (auto-generated). A reply without threadID is ' +
            'treated as a new request and the result says so.'
        },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          description:
            "queue (default) waits for the target's next turn — does not interrupt. " +
            'steer merges into the running turn and may interrupt it: only use it deliberately.'
        },
        origin: {
          type: 'string',
          description:
            '对接人（0.7.0）：转发别人的活儿时这条链真正的起点会话（`ses_…` 或别名）。给了就在正文首行加' +
            '`对接人（非本单发起方）：ses_… @ <dir>`，让对端不必再问「该找谁」。' +
            '不写记录，也不继承（本工具没有记录可继承；回执不该被追加一行）；与发送者相同则不写。'
        },
        blocked: {
          type: 'object',
          additionalProperties: false,
          description:
            'BLOCKED 结构化（0.7.0，可选）：把「缺什么 / 已排除什么 / 最小判别实验」写成三段，追加在正文之后' +
            '（正文自由，仍是人话）。有可解析的 `bid`（入参或正文的 b_…）时写进记录（保留最近 3 次），' +
            '接收方注入与 collab_status 会聚合展示；没有 bid 就只渲染进正文、不落库。不传 = 输出与旧版逐字一致。' +
            '超限一律可读拒绝（不静默截断）。',
          properties: {
            need: {
              type: 'array',
              items: { type: 'string' },
              description: '需要对方提供什么：≤10 条，每条 ≤120 字（控制字符剥成空格）。'
            },
            excluded: {
              type: 'array',
              items: { type: 'string' },
              description: '已经排除的方向：≤20 条，每条 ≤120 字。'
            },
            minimalTest: {
              type: 'string',
              description: '让对端一次就能判别的最小实验 / 判别式：≤200 字。'
            }
          }
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to actually deliver. false/omitted only returns the preview.'
        },
        force: {
          type: 'boolean',
          description:
            'Deliver even though the same body already reached this target (another thread) or this thread ' +
            'within `dedupeWindowMs`. Skips both de-dup levels, marks the result `dedupeOverridden` and (with a ' +
            '`bid`) stamps `dedupeOverriddenAt` on the record. Use it for a deliberate repeat only.'
        }
      },
      required: ['target', 'text', 'confirm']
    }),
    async execute(input, context) {
      const notes: string[] = [];
      const me = context?.sessionID;
      // 0.7.0 (`11-19-collab-blocked`): validate up front — an over-long or
      // over-count `blocked` is a readable refusal before anything is delivered
      // or written (never a silent truncation).
      const blocked = normalizeBlocked(input?.blocked);
      const blockedText = blocked ? blockedLines(blocked) : [];
      // R2: the *requested* kind decides whether a bounded receipt applies; the
      // reply-without-threadID downgrade below must not hide it.
      // R7 (0.1.4): `legacy` means the caller declared **no** kind at all — the
      // ≤0.1.1 receipt shape. An explicit `kind:"request"` never uses the
      // widening, so a normal request cannot borrow it.
      const rawKind = String(input?.kind ?? '').trim();
      const requestedKind = normalizeKind(input?.kind);
      const legacyKind = rawKind === '';
      let kind = requestedKind;
      let threadID = normalizeThreadID(input?.threadID);

      if (threadID && !isValidThreadID(threadID)) {
        throw invalid(`threadID 格式不合法："${threadID}"（期望 t_<base36ts>_<rand>，或省略以自动生成）`);
      }
      if (kind === 'reply' && !threadID) {
        kind = 'request';
        notes.push('kind=reply 缺少 threadID → 已按新请求处理（并自动生成 threadID）');
      }

      // 0.7.0 (`11-19-collab-origin`, R2): a *forwarded* message names the chain
      // head. Only an explicit `origin` renders the line: `collab_send` writes
      // no record, so it has nothing to inherit from, and a receipt written back
      // to one's own requester must not grow a 对接人 line. No origin = the body
      // is byte for byte unchanged.
      let storedAliases: JsonObject = {};
      if (input?.origin) {
        try {
          storedAliases = asObject(await ctx?.storage?.get(STORAGE_ALIASES));
        } catch {
          storedAliases = {}; // unreadable alias table = only collab.json's aliases
        }
      }
      const resolvedOrigin = input?.origin
        ? resolveOrigin({
            me,
            directory: ctx?.location?.directory,
            requested: input.origin,
            aliases: { ...storedAliases, ...readConfig().aliases }
          })
        : ({ ok: true, origin: undefined } as const);
      if (!resolvedOrigin.ok) throw invalid(resolvedOrigin.reason ?? '对接人无法解析');
      const origin = await fillOriginDirectory(resolvedOrigin.origin, ctx);
      const usableOrigin = origin && origin.sid !== String(me ?? '') ? origin : undefined;
      const originLineText = usableOrigin ? originHint(usableOrigin, me) : undefined;
      /** The same call with the 对接人 line as the *first* body line (no origin → unchanged). */
      const withOrigin = (raw: JsonObject | undefined): JsonObject | undefined =>
        originLineText
          ? { ...raw, text: `${originLineText}\n${String(raw?.text ?? '').trim()}` }
          : raw;
      if (originLineText) notes.push(`${originLineText} → 已写在正文首行`);

      /**
       * 0.7.0 (`11-19-collab-blocked`): the delivered body = 对接人 line (when
       * asked) + the caller's text + the structured BLOCKED block at the **end**
       * of the body (the free-form text above it is untouched). No origin and no
       * `blocked` → the input object is passed through as-is, so the old output
       * is byte for byte what it was.
       */
      const withMeta = (raw: JsonObject | undefined): JsonObject | undefined => {
        const next = withOrigin(raw);
        if (!blockedText.length) return next;
        const head = String(next?.text ?? '').trim();
        return { ...next, text: head ? `${head}\n\n${blockedText.join('\n')}` : blockedText.join('\n') };
      };

      /**
       * Record the structured BLOCKED when the message names a live hand-off.
       * Design §2: a resolvable `bid` (argument or the `[handoff]` body line)
       * appends to `record.blocked` (newest 3); with no bid the block only rides
       * in the body and the result says it was not stored. `state` / `claim` /
       * `receipt` are never touched and no guard is relaxed — this is a display
       * field. A sender that is not part of the hand-off may render it into its
       * own message but never write it into the record (`canWriteBlocked`, the
       * same rule `collab_handoff` uses).
       *
       * A **de-dupe hit** delivered nothing (the earlier copy already carried
       * this exact block), so it must not append again: that only burns one of
       * the three kept slots and can push an older, *different* report out
       * (review F3).
       */
      const recordBlocked = (bid: string, confirmed: boolean, duplicate: boolean): string => {
        if (!bid) {
          return '注: blocked 未关联单据（bid 入参与正文都没有 b_…）—— 已渲染进正文，未落库。';
        }
        if (!confirmed) {
          return `注: 预览（confirm 不为 true）—— blocked 未落库；确认后会写进记录 ${bid}。`;
        }
        const record = readBroadcast(bid);
        if (!record) {
          return `注: 没有交接单 ${bid}（拼错或已过 7 天保留期）—— blocked 已渲染进正文，未落库。`;
        }
        if (!canWriteBlocked(record, me)) {
          return `注: 当前会话不是 ${bid} 的参与方（from / claim.by / asked / origin）—— 已渲染进正文，未落库。`;
        }
        if (duplicate) {
          return `注: blocked 未落库（同文去重命中、本次未投递；记录里已有的那一条已含这段）。`;
        }
        writeBroadcast(appendBlocked(record, { ...blocked!, at: Date.now(), by: String(me ?? '') }));
        return `注: blocked 已写入记录 ${bid}（保留最近 ${BLOCKED_KEEP} 次；state / claim / receipt 未改）。`;
      };

      /**
       * `dispatch` + the structured-BLOCKED bookkeeping (only when `blocked` was given).
       * `dispatch` returns a `delivery` receipt **only** for a real admission, so
       * `confirm:true && !delivery` is exactly the de-dup read-back path.
       */
      const finish = async (args: Parameters<typeof dispatch>[0]) => {
        const result = await dispatch(args);
        if (!blocked) return result;
        const body = String(args.input?.text ?? '');
        const bid = String(input?.bid ?? '').trim() || BODY_BID_RE.exec(body)?.[1] || '';
        const duplicate = args.input?.confirm === true && result.delivery === undefined;
        return { ...result, content: `${result.content}\n${recordBlocked(bid, args.input?.confirm === true, duplicate)}` };
      };

      // Reply routing: caller must be a participant and the target must be the
      // thread's counterpart. Without both checks a leaked threadID is enough
      // to forge a reply (T1) or to write it into someone else's thread (T2).
      if (kind === 'reply' && threadID) {
        const thread = await threads.read(threadID);
        if (!thread) {
          kind = 'request';
          notes.push(`storage 里没有 thread ${threadID} → 已按新请求处理`);
        } else if (!me) {
          notes.push('无会话上下文（无 sessionID）：未校验 reply 的参与者与对端。');
        } else if (me !== thread.fromSession && me !== thread.toSession) {
          throw invalid(
            `拒绝回执：当前会话 ${me} 不是 thread ${threadID} 的参与方` +
              `（发起方 ${thread.fromSession ?? '?'}，对端 ${thread.toSession ?? '?'}）。未发送任何内容。`
          );
        } else {
          const counterpart = thread.fromSession === me ? thread.toSession : thread.fromSession;
          const resolved = await resolveTarget(input?.target);
          if (counterpart && resolved.sessionID !== counterpart) {
            throw invalid(
              `拒绝回执：thread ${threadID} 的对端是 ${counterpart}，与 target ${resolved.sessionID} 不一致。` +
                `回执请用 collab_reply {threadID}（自动路由）。未发送任何内容。`
            );
          }
          const { mode, forced } = resolveMode(input?.mode, context?.agent);
          return finish({
            context,
            input: withMeta(input),
            kind,
            threadID,
            mode,
            forced,
            notes,
            target: resolved,
            force: input?.force === true,
            // R2: only a bounded receipt (this bid's requester + its claimant,
            // kind=reply) gets through the protect guard.
            allowProtectedReply: Boolean(
              canReplyToProtected({
                kind,
                target: resolved.sessionID,
                sender: me,
                bid: input?.bid,
                text: withMeta(input)?.text,
                mode: input?.mode
              })
            )
          });
        }
      }
      if (!threadID) threadID = newThreadID();

      const { mode, forced } = resolveMode(input?.mode, context?.agent);
      const target = await resolveTarget(input?.target);
      // R2: a protected requester still gets the receipt of the very bid it
      // broadcast — as a `kind:reply` from that bid's own claimant, with a fresh
      // thread. Without this the downgrade above would turn the receipt into a
      // `request`, which must stay fail-closed.
      // R1 (0.1.4): a legacy receipt was *written* as a plain `request`
      // (`[handoff] DONE <bid> …`, no `kind` at all) and is recognised here for
      // the same three conditions — the delivered message is still `kind:reply`.
      const boundedReply = canReplyToProtected({
        kind: requestedKind,
        target: target.sessionID,
        sender: me,
        bid: input?.bid,
        text: withMeta(input)?.text,
        mode: input?.mode,
        legacyAllowed: legacyKind
      });
      // 0.7.0 (B, `11-19-collab-origin`): a receipt may also be addressed to the
      // **chain head** of a forwarded hand-off (`A → B → C`: C answers A without
      // going back through B), so the same `[handoff]` line must travel as
      // `kind:reply` there too — otherwise the receiving side drops it as an
      // explicit `request` and the bid stays `acked`.
      //
      // Deliberately a **separate** decision from the branch above: it only
      // rewrites the kind. `allowProtectedReply` below is still
      // `Boolean(boundedReply)`, i.e. the untouched `from.sid` rule — a
      // protected `origin` never gains a delivery path through this widening.
      const receiptToChainHead = boundedReply
        ? undefined
        : canReplyToProtected({
            kind: requestedKind,
            target: target.sessionID,
            sender: me,
            bid: input?.bid,
            text: withMeta(input)?.text,
            mode: input?.mode,
            legacyAllowed: legacyKind,
            acceptOrigin: true
          });
      if (boundedReply || receiptToChainHead) {
        kind = 'reply';
        const downgraded = notes.findIndex(note => note.includes('kind=reply 缺少 threadID'));
        if (downgraded >= 0) notes.splice(downgraded, 1);
        if (requestedKind !== 'reply') {
          notes.push(
            '遗留回执（0.1.1 及更早的命令不带 kind）已按 kind=reply 放行：正文含 [handoff]、bid 归属该记录、发送者是该单领取人。'
          );
        }
        if (receiptToChainHead) {
          notes.push(
            `回执发往对接人 ${target.sessionID}（本单 origin，不是发起方 ${receiptToChainHead.from?.sid ?? '?'}）：` +
              '同一条 [handoff] 行按 kind=reply 投递并闭环本单；受保护投递规则不变（origin 指向 [protected*] 时仍拒投）。'
          );
        }
      }
      return finish({
        context,
        input: withMeta(input),
        kind,
        threadID,
        mode,
        forced,
        notes,
        target,
        allowProtectedReply: Boolean(boundedReply),
        force: input?.force === true
      });
    }
  };
}
