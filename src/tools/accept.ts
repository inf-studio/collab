import { BCAST_DONE_STATES, BCAST_LEASE_MS, BCAST_MAX_ATTEMPTS, BROADCAST_DIR, MAX_STORED } from '../constants.ts';
import { claimLock, isValidBid, persistRefresh, readBroadcast, releaseLock, writeBroadcast } from '../core/claim.ts';
import { readContract } from '../core/contract.ts';
import { invalid } from '../core/errors.ts';
import { evaluate } from '../core/gate.ts';
import { freezeDenyText, frozenBy } from '../core/freeze.ts';
import { createLineage } from '../core/lineage.ts';
import type { BroadcastRecord, JsonObject, ToolDefinition } from '../types.ts';
import { shortID, truncate } from '../util.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/**
 * R1: how the claiming session reports back. `push` = a `collab_send` receipt to
 * the requester; `pull` (requester on the protect list) = the `[handoff]` line in
 * its own last answer, which the requester extracts when the lease lapses.
 */
function receiptLines(record: BroadcastRecord): string[] {
  const bid = record.bid;
  if (record.receiptMode === 'pull') {
    return [
      `完成后回执（pull 模式，必写）: 在本会话最后一条回复里写一行 \`[handoff] DONE ${bid} <commit sha 或摘要>\`；`,
      `   做不了: 写 \`[handoff] BLOCKED ${bid} <原因>\`。发起方 ${record.from?.sid ?? 'ses_…'} 在 protect 名单内，`,
      '   不要 collab_send——租约到期后它会只读提取你最后一条回复并自动闭环。'
    ];
  }
  return [
    `完成后回执（必发）: collab_send {target:"${record.from?.sid ?? 'ses_…'}", ` +
      `text:"[handoff] DONE ${bid} <commit sha 或摘要>", confirm:true}`
  ];
}

/**
 * `collab_accept` — atomic claim of a broadcast hand-off (one winner via
 * `<bid>.lock`), plus the lease/decline bookkeeping that keeps a second
 * session from being spawned for the same bid.
 */
export function acceptTool(kit: ToolKit): ToolDefinition {
  const { deps } = kit;
  const { ctx, readConfig, chain } = deps;

  /**
   * R1 (投递 5xx): the ACCEPT / receipt note back to the requester is a
   * delivery. When it fails, the caller used to get one readable line
   * ("未通知发起方：…") and nothing else — no evidence, no entry point. Report
   * it as a side path (the returned text is unchanged). A protected requester or
   * a missing requester sid carries no `error` and is an expected outcome.
   */
  async function reportUndelivered(
    record: BroadcastRecord,
    notified: { delivered: boolean; error?: unknown }
  ): Promise<void> {
    if (notified.delivered || !notified.error) return;
    await deps.reporter.reportNow({
      tool: 'collab_accept',
      // This branch only runs when a delivery (`session.prompt` back to the
      // requester) failed, so the class is `delivery-5xx` by construction.
      defect: 'delivery-5xx',
      error: notified.error,
      input: { bid: record.bid }
    });
  }

  return {
    name: 'collab_accept',
    description:
      'Claim a broadcast hand-off atomically (one winner): the first caller creates `<bid>.lock` and wins, everyone ' +
      'else is told who already took it — never claim twice and never spawn a second session for the same bid. ' +
      'A session on the `protect` list — or any descendant of one — is refused (a sub-agent cannot claim for a ' +
      "protected line). A session that reports another `location.directory` than the broadcast's workspace is " +
      "refused. A spawned session's own call moves it from `claimed` to `acked`. After claiming, implement and " +
      'report back with `collab_send {target:"<requester sid>", text:"[handoff] DONE <bid> <摘要>", confirm:true}` — ' +
      'writing the conclusion in your own session is NOT a receipt. Exception (`receiptMode:"pull"`, requester on ' +
      'the protect list): that target cannot be written to, so the `[handoff] DONE|BLOCKED <bid> …` line in your ' +
      'own last answer IS the receipt — the result says so. Requires confirm:true; otherwise it only previews. ' +
      '0.9.2 gate: when this session’s mission.outOfScope is non-empty, the call must carry ' +
      'scopeCheck:{ inScope, reason? } — the plugin makes no semantic guess; it only forces the statement and ' +
      'audits it. inScope:false is refused (handoffTo + a human override { reason, approvedBy } is the only way ' +
      'through). 8+ open todos only appends a reminder line. gate:"warn"|"off" in collab.json is the rollback switch.',
    input: jsonInput({
      properties: {
        bid: {
          type: 'string',
          description: 'Broadcast id (`b_…`), as shown in the injected 群组广播 line.'
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to actually claim. false or omitted only returns the preview.'
        },
        scopeCheck: {
          type: 'object',
          additionalProperties: false,
          description:
            '0.9.2 接单表态（本会话 mission.outOfScope 非空时**必填**）：`{ inScope, reason? }`。' +
            '插件不做语义判断（没有关键词/别名匹配），只把你自己对「这条是否在你的边界内」的判断记录到 ' +
            'collab-audit.jsonl。`inScope:false` 会被拒绝接单（除非带人类 override）；`inScope:true` 正常接单。',
          properties: {
            inScope: { type: 'boolean', description: 'true = 在边界内；false = 在边界外（不接）。' },
            reason: { type: 'string', description: '一句话理由（会写进审计行）。' }
          },
          required: ['inScope']
        },
        override: {
          type: 'object',
          additionalProperties: false,
          description:
            '0.9.2 闸门 override（仅在 `scopeCheck:{ inScope:false }` 且需人类批准越界时使用）：' +
            '`{ reason, approvedBy }` 两者必填；approvedBy 必须是人类标识、不得以 ses_ 开头。' +
            '通过后放行并往 collab-audit.jsonl 追加一行。缺字段 / 会话自批准一律拒绝。',
          properties: {
            reason: { type: 'string', description: '为什么必须越界做（一句话）。' },
            approvedBy: { type: 'string', description: '批准人（人类标识；不得以 ses_ 开头）。' }
          }
        }
      },
      required: ['bid', 'confirm']
    }),
    async execute(input, context) {
      const bid = String(input?.bid ?? '').trim();
      if (!isValidBid(bid)) {
        throw invalid(`bid 格式不合法："${bid}"（期望 b_<hex16>，从广播/注入行里取）`);
      }
      const existing = readBroadcast(bid);
      if (!existing) {
        throw invalid(`没有广播 ${bid}：${BROADCAST_DIR} 下没有该文件（bid 拼错，或该交接还没被广播）`);
      }
      const now = Date.now();
      const me = context?.sessionID;
      if (!me) {
        throw invalid('collab_accept 需要会话上下文（sessionID）：无法把领取记到某个会话上');
      }

      // R1-1: the protect list is a *lineage* guard, so a sub-agent of a
      // protected line cannot claim work on its behalf. Checked before the
      // preview as well — a protected session may not even look like a
      // candidate for the hand-off (fail-closed, same as `collab_send`), and
      // before `persistRefresh` so a refused call cannot touch the record.
      const lineage = createLineage(ctx);
      const guard = await lineage.protectedAncestor(me, readConfig().protect);
      if (guard) {
        throw invalid(
          `拒绝领取：${me} 在 protect 名单内${
            guard.depth === 0 ? '（自身受保护）' : `（第 ${guard.depth} 级祖先 ${guard.sessionID} 受保护）`
          }，受保护会话及其子会话不参与广播领取。`
        );
      }

      // 0.6.0 (`collab_freeze`): a frozen **bid**, a frozen claimant session (or
      // one of its ancestors) or a frozen workspace refuses the claim. Checked
      // before `persistRefresh`, so a refused call cannot even touch the record.
      const freeze = await frozenBy({ session: me, bid, workspace: existing.workspace }, { lineage });
      if (freeze) throw invalid(freezeDenyText(freeze));

      // The lease refresh is a *read* here: it may reopen a lapsed claim or
      // settle an auto receipt, and the gate must judge the same state the claim
      // path will act on. `persistRefresh` (the write) happens **after** the
      // gate, so a refused accept leaves the record byte for byte unchanged.
      const refreshed = await chain.refresh(existing, now, { actor: me });
      const snapshot = refreshed ?? existing;
      const newClaim = String(snapshot.state ?? 'open') === 'open';

      // 0.9.2 (`11-20-collab-gate`): only a **new** claim is gated. "已闭环 /
      // 已过期 / 已被领取 / spawn 自领 ACK" are read-only branches and must never
      // be reported as an out-of-scope refusal. The gate itself never infers:
      // it requires the claimant's own `scopeCheck` statement.
      const gate = evaluate(
        'accept',
        { bid, scopeCheck: input?.scopeCheck, override: input?.override },
        readContract(me),
        readConfig(),
        // A preview performed no action; a non-new-claim is not this session's
        // decision to make — neither leaves an audit line behind.
        { sid: me, audit: newClaim && input?.confirm === true }
      );
      if (newClaim && gate.verdict === 'deny' && input?.confirm === true) throw invalid(gate.content);
      const gateLines = newClaim && gate.content ? gate.content.split('\n') : [];
      const reminderLines = gate.reminder ? [gate.reminder] : [];

      let record = persistRefresh(existing, snapshot);

      if (record.state === 'expired') {
        throw invalid(
          `广播 ${bid} 已 expired（attempts=${record.attempts} > ${BCAST_MAX_ATTEMPTS}）：需人工接手，不再自动重投。`
        );
      }
      if (BCAST_DONE_STATES.includes(String(record.state))) {
        return {
          content: `广播 ${bid} 已闭环（state=${record.state}）：${record.receipt?.note || '-'}。无需领取。`
        };
      }

      const activeClaim = record.claim;
      if (activeClaim && ['claimed', 'acked'].includes(String(record.state))) {
        if (activeClaim.by === me) {
          // A spawned session starts `claimed` (the requester created it);
          // its own `collab_accept` is the ACCEPT that moves it to `acked`
          // (design §4 / B1). Without this the hand-off lapsed after 5 min and
          // the work was counted as "nobody took it".
          if (record.state === 'claimed') {
            record = writeBroadcast({
              ...record,
              state: 'acked',
              ackedAt: now,
              claim: { ...activeClaim }
            });
            // The spawn lock belongs to the requester (`by`) but this session
            // is `claimBy`: release it now so nothing looks "already claimed".
            releaseLock(bid, [me, String(activeClaim.spawner ?? '')]);
            const spawnedNotice = await chain.notifyRequester(record, {
              text:
                `ACCEPT ${record.issuePath ?? record.bid} —— ${shortID(me)} 已接手 ${record.bid}` +
                `（${record.scope}，${record.expected}）。完成后回执 [handoff] DONE ${record.bid} <摘要>。`,
              from: shortID(me)
            });
            await reportUndelivered(record, spawnedNotice);
          } else {
            releaseLock(bid, [me, String(activeClaim.spawner ?? '')]);
          }
          return {
            content: [
              `你已领取 ${bid}（state=${record.state}，kind=${activeClaim.kind}，token=${activeClaim.token}）。`,
              ...gateLines,
              // R1 ②: a copy-pasteable receipt — answering in this session is not
              // "done" (push), or *is* the receipt (pull, protected requester).
              ...receiptLines(record),
              ...reminderLines
            ].join('\n')
          };
        }
        return {
          content: `已被 ${activeClaim.by} 领取（bid=${bid} state=${record.state}）—— 不要重复领取，也不要再拉新。`
        };
      }

      // Group membership: a session of another workspace must not take it.
      const info = await chain.sessionInfo(me);
      const directory = info?.location?.directory;
      const notes: string[] = [];
      if (record.workspace && directory && directory !== record.workspace) {
        throw invalid(
          `拒绝领取：广播 ${bid} 属于工作区 ${record.workspace}，当前会话在 ${directory}。` +
            `群组成员只能是该工作区的会话（跨仓只读，别代领）。`
        );
      }
      if (!directory) notes.push('会话没有 location.directory：未校验工作区归属。');

      if (input?.confirm !== true) {
        return {
          content: [
            '未领取（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。',
            `bid=${bid} scope=${record.scope} state=${record.state} attempts=${record.attempts}`,
            `提案: ${record.issuePath ?? '-'}  标题: "${truncate(record.title ?? '(untitled)', 60)}"  期望: ${record.expected}`,
            `影响面(${(record.affectedFiles ?? []).length}): ${(record.affectedFiles ?? []).slice(0, 8).join(', ') || '-'}`,
            `候选 top: ${
              (record.candidates ?? [])[0]
                ? `${(record.candidates ?? [])[0].sid} score=${(record.candidates ?? [])[0].score}`
                : '-'
            }`,
            ...gateLines,
            ...notes.map(note => `注: ${note}`),
            ...reminderLines
          ].join('\n')
        };
      }

      const claim = claimLock(bid, { by: me, kind: 'accept' });
      if (!claim.ok) {
        return {
          content:
            `已被 ${claim.holder.by ?? '?'} 领取（bid=${bid}，token=${claim.holder.token ?? '?'}）—— 你不是 winner。` +
            `不要重复领取，也不要再拉新。`
        };
      }
      const accepted: JsonObject = {
        ...record,
        state: 'acked',
        claim: {
          by: me,
          kind: 'accept',
          token: claim.claim.token,
          at: claim.claim.at,
          leaseMs: BCAST_LEASE_MS
        },
        ackedAt: now,
        replies: [...(record.replies ?? []), { from: me, at: now, text: 'ACCEPT' }].slice(-MAX_STORED)
      };
      delete accepted.asked; // the ask is answered: no lease left to run out
      record = writeBroadcast(accepted);
      const notified = await chain.notifyRequester(record, {
        text:
          `ACCEPT ${record.issuePath ?? record.bid} —— ${shortID(me)} 已领取 ${record.bid}` +
          `（${record.scope}，${record.expected}）。完成后回执 [handoff] DONE|BLOCKED ${record.bid} <摘要>。`,
        from: shortID(me)
      });
      await reportUndelivered(record, notified);

      return {
        content: [
          `已领取 ${bid}（winner，token=${claim.claim.token}，state=acked，lease=${BCAST_LEASE_MS}ms）`,
          `scope=${record.scope} workspace=${record.workspace} 期望=${record.expected}`,
          `提案: ${record.issuePath ?? '-'}  标题: "${truncate(record.title ?? '(untitled)', 60)}"`,
          `影响面(${(record.affectedFiles ?? []).length}): ${(record.affectedFiles ?? []).slice(0, 8).join(', ') || '-'}`,
          record.scope === 'peer'
            ? '跨仓护栏：只允许改目标仓 docs/issues/**，git 只读，不 push；实施由目标仓 owner 复核提交。'
            : 'local scope：按本仓正常权限实施。',
          ...gateLines,
          notified.delivered
            ? `已通知发起方 ${record.from?.sid}（message=${notified.message ?? '?'}）。`
            : `未通知发起方：${notified.reason}`,
          ...receiptLines(record),
          ...notes.map(note => `注: ${note}`),
          ...reminderLines
        ].join('\n')
      };
    }
  };
}
