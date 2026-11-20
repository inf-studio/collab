/**
 * `collab_decide` (0.9.5, R1–R3, D9) — the **decision ledger**, one tool, four
 * verbs (tool count 27 → 28).
 *
 *   open       new `D#` on a `threadID` **or** a `bid` (both paths work: two of
 *              the largest threads never had a hand-off record at all).
 *   answer     the decision is taken. **Only `owner`** — the asker cannot answer
 *              its own question, and an answered item needs `supersede` first.
 *   supersede  void it (any party), with `by` + a mandatory `reason`.
 *   list       read-only; the key's items, or everything this session is a
 *              party of when `key` is omitted.
 *
 * Rules are in `core/decisions.ts` (single storage + single resolver); this file
 * is the input contract and the receipts.
 *
 * Answers land in the ledger and nowhere else: the next request of both parties
 * carries one `[decide]` line, and `decision:<D#>` evidence resolves through the
 * same ledger (hand-off `decisions[]` stays readable for compatibility).
 */
import { DECISION_LIST_MAX, DECISION_OPTIONS_MAX } from '../constants.ts';
import { readBroadcast } from '../core/claim.ts';
import {
  deciderOf,
  derivePeerRoles,
  peerRolesOf,
  readContract,
  recordPeers
} from '../core/contract.ts';
import {
  answerDecision,
  decisionsForSession,
  formatDecision,
  isDecisionID,
  isDecisionKey,
  listDecisions,
  openDecision,
  supersedeDecision
} from '../core/decisions.ts';
import type { Decision } from '../core/decisions.ts';
import { invalid } from '../core/errors.ts';
import type { ToolDefinition } from '../types.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

const ACTION_HINT = 'action 必须是 open | answer | supersede | list';

/** `key` / `threadID` / `bid` — one subject, whichever spelling the caller used. */
function keyOf(input: {
  key?: unknown;
  threadID?: unknown;
  bid?: unknown;
}): string {
  const key = String(input?.key ?? input?.threadID ?? input?.bid ?? '').trim();
  if (!key) throw invalid('缺 key：决策必须挂在一条 thread（t_…）或一个 hand-off（b_…）上');
  if (!isDecisionKey(key)) {
    throw invalid(`key 必须是 threadID（t_…）或 bid（b_…），收到 "${key}"`);
  }
  return key;
}

/** The answer command, copy-pasteable, with the real key / id / owner. */
function answerHint(decision: Decision, key: string): string {
  return (
    `owner 回答: collab_decide { action:"answer", key:"${key}", id:"${decision.id}", ` +
    'answer:"<结论>", confirm:true }'
  );
}

export function decideTool(kit: ToolKit): ToolDefinition {
  const { deps } = kit;
  const { threads } = deps;

  /**
   * R2's default owner (design §4): the contract's `decider` peer, then the
   * **sender of the order** — the thread's initiator, the hand-off's requester —
   * and only then the caller. Never guessed from the message text.
   */
  function defaultOwner(key: string, me: string): string {
    const fromContract = deciderOf(readContract(me));
    if (fromContract) return fromContract;
    const record = key.startsWith('b_') ? readBroadcast(key) : undefined;
    const requester = String(record?.from?.sid ?? '').trim();
    if (requester) return requester;
    return me;
  }

  /**
   * Write the four-tuple into **this** session's contract (best-effort): the
   * requester is the thread initiator / hand-off requester, the implementer is
   * its counterpart / claimant, the decider is the decision owner.
   */
  async function rememberRoles(
    key: string,
    me: string,
    owner: string,
    thread: { fromSession?: string; toSession?: string } | undefined
  ): Promise<void> {
    try {
      const record = key.startsWith('b_') ? readBroadcast(key) : undefined;
      const requester = String(thread?.fromSession ?? record?.from?.sid ?? me);
      const implementer = String(thread?.toSession ?? record?.claim?.by ?? '');
      await recordPeers(
        me,
        derivePeerRoles({
          requester,
          implementer,
          decider: owner,
          threadId: key.startsWith('t_') ? key : null
        })
      );
    } catch {
      // Roles are an injection hint; a contract write failure must not undo a
      // decision that is already in the ledger.
    }
  }

  return {
    name: 'collab_decide',
    description:
      'The decision ledger (0.9.5): record a **decision** as a first-class `D1`, `D2`, … instead of ' +
      'reopening it in prose. `open { key, question, options[≥2], owner? }` — `key` is a threadID (`t_…`) ' +
      'OR a bid (`b_…`), so a thread with no hand-off record still works; `owner` defaults to the ' +
      'contract decider, then the order’s sender. The same question (whitespace / punctuation / case folded, ' +
      'sha1) that is already open is refused and returns the existing `D#` + owner; at most **3 open** per key ' +
      '(the 4th is a readable refusal — close one first). `answer { key, id, answer }` is **owner-only** ' +
      '(the asker cannot answer its own question) and an answered item must be `supersede`d before it can be ' +
      'replaced. `supersede { key, id, reason }` may be done by the **asker, the owner, or a participant of ' +
      'the thread/bid** and always records who + why — a conflict decision nobody answers is voided ' +
      'automatically after 24h so its thread cannot stay read-only forever. ' +
      '`list { key? }` is read-only (omit key = every open decision this session is a party of). Every party ' +
      'sees one `[decide]` line next request; `decision:<key>#<D#>` evidence resolves through this ledger. ' +
      'Writing verbs need confirm:true.',
    input: jsonInput({
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'answer', 'supersede', 'list'],
          description: 'open = 新建 · answer = owner 回答 · supersede = 作废（记 by + reason）· list = 只读'
        },
        key: {
          type: 'string',
          description: '决策主体：threadID（`t_…`）或 bid（`b_…`）。answer / supersede 必填；list 可省略。'
        },
        threadID: {
          type: 'string',
          description: '`key` 的别名（thread 路径）：不用写 key 也能挂在 thread 上。'
        },
        bid: {
          type: 'string',
          description: '`key` 的别名（hand-off 路径）：不用写 key 也能挂在交接单上。'
        },
        question: {
          type: 'string',
          description: 'open 必填：一句话说清要决定什么（≤300 字）。同问（去空白/标点/大小写）不会重复新建。'
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: `open 必填：可选方案 ≥2 个（≤${DECISION_OPTIONS_MAX} 个，每个 ≤120 字）。`
        },
        owner: {
          type: 'string',
          description:
            'open 可选：谁能 answer（`ses_…`）。缺省 = 契约里的 decider，再退到发单方（thread 发起人 / 交接单发起方），' +
            '最后是当前会话。'
        },
        id: {
          type: 'string',
          description: 'answer / supersede 必填：决策 id（`D1` / `D2` …）。'
        },
        answer: {
          type: 'string',
          description: 'answer 必填：结论（≤500 字）。只有 owner 能写，写下来才算决策。'
        },
        reason: {
          type: 'string',
          description: 'supersede 必填：为什么作废（≤200 字，计入记录）。'
        },
        includeAll: {
          type: 'boolean',
          description: 'list 可选：连 answered / superseded 一起列出（默认只列 open）。'
        },
        limit: {
          type: 'number',
          description: `list 可选：最多列多少行（默认 ${DECISION_LIST_MAX}）。`
        },
        confirm: {
          type: 'boolean',
          description: 'open / answer / supersede 必须为 true 才写；false / 省略只预览。list 不需要。'
        }
      },
      required: ['action']
    }),

    async execute(input, context) {
      const action = String(input?.action ?? '').trim();
      const me = String(context?.sessionID ?? '').trim();
      if (!me) throw invalid('collab_decide 需要会话上下文（sessionID）：owner 校验与 [decide] 注入都依赖它');
      const now = Date.now();

      if (action === 'list') {
        const raw = String(input?.key ?? input?.threadID ?? input?.bid ?? '').trim();
        if (!raw) {
          const rows = decisionsForSession(me);
          const head = `[decide] ${rows.length} open（本会话是提问方 / owner / 该 thread 的参与方）`;
          return {
            content: [
              head,
              ...(rows.length
                ? rows.map(({ key, decision }) => `  ${key} · ${formatDecision(decision)}`)
                : ['  （空）open 需要 key：threadID（t_…）或 bid（b_…）']),
              '只读：未写入、未投递。'
            ].join('\n')
          };
        }
        if (!isDecisionKey(raw)) throw invalid(`key 必须是 threadID（t_…）或 bid（b_…），收到 "${raw}"`);
        const rows = listDecisions(raw, {
          includeAll: input?.includeAll === true,
          limit: Number(input?.limit) || DECISION_LIST_MAX
        });
        return {
          content: [
            `[decide] key=${raw} · ${rows.length} 条${input?.includeAll === true ? '（含历史）' : ' open'}`,
            ...(rows.length ? rows.map(decision => `  ${formatDecision(decision)}`) : ['  （空）']),
            '只读：未写入、未投递。'
          ].join('\n')
        };
      }

      if (action === 'open') {
        const key = keyOf(input);
        const question = String(input?.question ?? '').trim();
        if (!question) throw invalid('open 必填 question（一句话说清要决定什么）');
        const options = Array.isArray(input?.options) ? input.options : [];
        if (options.length < 2) {
          throw invalid('open 需要 options ≥ 2（可选方案）：只有一个选项的不是决策，是通知。未写入任何内容。');
        }
        const owner = String(input?.owner ?? '').trim() || defaultOwner(key, me);
        const thread = key.startsWith('t_') ? await threads.read(key) : undefined;
        const record = key.startsWith('b_') ? readBroadcast(key) : undefined;

        if (input?.confirm !== true) {
          return {
            content: [
              '未写入（confirm 不为 true，仅预览）。将开决策:',
              `key=${key}  owner=${owner}`,
              `question: ${question}`,
              `options: ${options.join(' / ')}`,
              `  0.9.5 的 role 推导: ${describeRoles(me, thread, record, owner)}`,
              answerHint(
                {
                  id: 'D<n>',
                  question,
                  options: [],
                  owner,
                  status: 'open',
                  answer: null,
                  by: null,
                  askedBy: me,
                  at: now,
                  hash: '',
                  origin: 'manual'
                },
                key
              ),
              '确认后在同样参数下传 confirm:true。'
            ].join('\n')
          };
        }

        const opened = await openDecision({
          key,
          question,
          options,
          owner,
          by: me,
          origin: 'manual',
          threadId: key.startsWith('t_') ? key : undefined,
          bid: key.startsWith('b_') ? key : undefined,
          now
        });
        await rememberRoles(key, me, owner, thread);
        const roles = peerRolesOf(readContract(me), me);
        return {
          content: [
            `已开决策 ${opened.decision.id}（key=${key}，owner=${opened.decision.owner}，提问 ${opened.decision.askedBy ?? me}）`,
            `  ${opened.decision.question}`,
            `  options: ${opened.decision.options.join(' / ')}`,
            roles.length ? `  role: ${roles.join('+')}` : '',
            `  open: ${opened.file.items.filter(item => item.status === 'open').length} / 上限 3（conflict 决策另占一条）`,
            `  注入: 双方下一轮出现 [decide] ${opened.decision.id} open（等 ${opened.decision.owner}）`,
            `  提问方（${me}）可 supersede 撤回；answer 只能 owner 写`,
            answerHint(opened.decision, key)
          ]
            .filter(Boolean)
            .join('\n')
        };
      }

      if (action === 'answer') {
        const key = keyOf(input);
        const id = String(input?.id ?? '').trim();
        if (!isDecisionID(id)) throw invalid(`answer 需要决策 id（D1 / D2 …），收到 "${id}"`);
        const answer = String(input?.answer ?? '').trim();
        if (!answer) throw invalid('answer 必填 answer（结论要写下来，否则下一个人还要再问一次）');
        if (input?.confirm !== true) {
          return {
            content: [
              '未写入（confirm 不为 true，仅预览）。将回答:',
              `key=${key}  id=${id}  by=${me}`,
              `answer: ${answer}`,
              '只有该决策的 owner 能回答；非 owner 会被拒绝。确认后传 confirm:true。'
            ].join('\n')
          };
        }
        const answered = await answerDecision({ key, id, answer, by: me, now });
        return {
          content: [
            `已回答 ${answered.decision.id}（key=${key}，by ${me}）`,
            `  ${answered.decision.question}`,
            `  → ${answered.decision.answer}`,
            `  证据可用: collab_todo { action:"close", id:"T…", evidence:"decision:${answered.decision.id}", confirm:true }`,
            '注入: 下一轮起不再出现该条 [decide]；决策关闭前该 thread 的只读降级解除。'
          ].join('\n')
        };
      }

      if (action === 'supersede') {
        const key = keyOf(input);
        const id = String(input?.id ?? '').trim();
        if (!isDecisionID(id)) throw invalid(`supersede 需要决策 id（D1 / D2 …），收到 "${id}"`);
        const reason = String(input?.reason ?? '').trim();
        if (!reason) throw invalid('supersede 必填 reason：没有原因作废 = 下一个人还会再问一遍');
        if (input?.confirm !== true) {
          return {
            content: [
              '未写入（confirm 不为 true，仅预览）。将作废:',
              `key=${key}  id=${id}  by=${me}`,
              `reason: ${reason}`,
              '确认后传 confirm:true（任何一方都可作废，但 by + reason 必记）。'
            ].join('\n')
          };
        }
        const superseded = await supersedeDecision({ key, id, reason, by: me, now });
        return {
          content: [
            `已作废 ${superseded.decision.id}（key=${key}，by ${me}）：${reason}`,
            `  open 占用已释放（${superseded.file.items.filter(item => item.status === 'open').length} / 上限 3）`,
            '要重新决定：collab_decide { action:"open", key, question, options:[…], confirm:true }'
          ].join('\n')
        };
      }

      throw invalid(ACTION_HINT);
    }
  };
}

/** One line for the `open` preview: who the four-tuple resolves to. */
function describeRoles(
  me: string,
  thread: { fromSession?: string; toSession?: string } | undefined,
  record: { from?: { sid?: string }; claim?: { by?: string } } | undefined,
  owner: string
): string {
  const requester = String(thread?.fromSession ?? record?.from?.sid ?? me);
  const implementer = String(thread?.toSession ?? record?.claim?.by ?? '');
  const peers = derivePeerRoles({ requester, implementer, decider: owner });
  return peers.map(peer => `${peer.role}=${peer.sid}`).join(' / ');
}
