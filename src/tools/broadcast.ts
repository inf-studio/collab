import { readFileSync, realpathSync } from 'node:fs';
import {
  BCAST_DONE_STATES,
  BCAST_LEASE_MS,
  BCAST_THRESHOLD,
  BROADCAST_DIR,
  EXPECTED,
  STORAGE_ALIASES
} from '../constants.ts';
import { invalid } from '../core/errors.ts';
import { readContract } from '../core/contract.ts';
import { evaluate } from '../core/gate.ts';
import {
  claimLock,
  fillOriginDirectory,
  persistRefresh,
  readBroadcast,
  releaseLock,
  resolveOrigin,
  storedOrigin,
  updateLock,
  writeBroadcast
} from '../core/claim.ts';
import { freezeDenyText, frozenBy } from '../core/freeze.ts';
import { grantFile } from '../core/grants.ts';
import { createLineage } from '../core/lineage.ts';
import {
  broadcastID,
  normalizeExpected,
  resolveBroadcastTargets,
  sessionBusyMinutes,
  summarizeProposal
} from '../core/score.ts';
import { handoffActions, originHint } from '../core/verdict.ts';
import { newCorrelationID } from '../ids.ts';
import { errText } from '../log.ts';
import type { JsonObject, ToolDefinition } from '../types.ts';
import { asObject, truncate } from '../util.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/** `collab_broadcast` — cross-workspace (peer) hand-off: score, write, ask/spawn. */
export function broadcastTool(kit: ToolKit): ToolDefinition {
  const { deps, deliverAsk, capabilityNote } = kit;
  const { ctx, chain, readConfig } = deps;

  /**
   * D4 (0.4.0): `collab_broadcast` is the **cross-workspace** tool. Pointed at
   * the current workspace it produced a peer record for a target that should
   * have been a local `collab_handoff` (a different protocol — thread + reply —
   * and no global file). Compared on `realpath` so `./ws`, `ws/` and a symlink
   * are the same workspace. Runs before anything is read/written.
   */
  function assertOtherWorkspace(workspace: string): void {
    const current = String(ctx?.location?.directory ?? '').trim();
    if (!current) return; // no location: nothing to compare against
    const real = (value: string): string => {
      try {
        return realpathSync(value);
      } catch {
        return value;
      }
    };
    if (real(workspace) !== real(current)) return;
    throw invalid(
      `拒绝广播：目标 workspace 就是当前工作区（${current}）。` +
        '同仓请用 collab_handoff { text, expected?, confirm:true }（thread + reply 协议，不写全局广播记录）。' +
        '未写入任何内容。'
    );
  }

  return {
    name: 'collab_broadcast',
    description:
      "Broadcast a cross-workspace (peer) hand-off: the proposal must live in the target workspace's docs/issues/ (a " +
      "symlinked proposal is refused), the plugin scores that workspace's root sessions (0–100, deterministic, with a " +
      '`why` breakdown), writes the hand-off to the global broadcast directory (0 model calls) and only the asked ' +
      'top-1 candidate receives the takeover request (ACCEPT via collab_accept, or DECLINE; the 5-minute ask lease ' +
      'advances to the next candidate), with one extra queued prompt when it has been busy for more than 30 minutes. ' +
      'When nobody reaches the 80 threshold one session is spawned in the target directory (explore by default; ' +
      'agent:"build" needs agentConfirm:true every time; a session whose location cannot be verified is rolled back). ' +
      'The receiving side must accept and then send a receipt (accept → collab_send → "answering in its own session ' +
      'is not done"); a spawned session immediately gets the five collab_* rules patched onto *its own* session ' +
      "ruleset (its workspace's project config does not cover it; no edit/write is granted) — `collab_grant` applies " +
      'the same to an existing session. ' +
      "when a spawned session lets its lease lapse, the requester reads that session's last answer " +
      'once and closes the hand-off itself when it carries a verdict (receipt.auto), never spawning again. ' +
      'Idempotent: the same proposal content is the same bid. Requires confirm:true; otherwise it only previews. ' +
      'A workspace that resolves to the current one is refused (same-workspace work is collab_handoff). ' +
      '0.9.2 gate: a broadcast is never refused and never requires a scope statement (handing work out is how a ' +
      'list gets shorter); 8+ open todos only appends one [溢出提醒] line. The recipient states its own boundary ' +
      'when it calls collab_accept. gate:"warn"|"off" in collab.json is the rollback switch.',
    input: jsonInput({
      properties: {
        workspace: {
          type: 'string',
          description: 'Absolute path of the target workspace (e.g. /data/project/muke-interface).'
        },
        issuePath: {
          type: 'string',
          description: 'Proposal path relative to the workspace; must be under docs/issues/ and must exist.'
        },
        expected: {
          type: 'string',
          enum: EXPECTED,
          description:
            'implement (default) = the peer should change code; review = the peer should confirm; ' +
            'research = read-only investigation and a conclusion (the only honest expectation for a read-only agent).'
        },
        agent: {
          type: 'string',
          description:
            'Agent for a spawned session (default `explore`, read-only). Any other agent — `build` in ' +
            'particular — additionally requires agentConfirm:true on every call.'
        },
        agentConfirm: {
          type: 'boolean',
          description: 'Explicit per-call confirmation for spawning a non-explore agent. No whitelist, no default.'
        },
        origin: {
          type: 'string',
          description:
            '对接人（0.7.0）：这条协作链真正的起点会话（`ses_…` 或别名）。省略时自动继承——' +
            '若当前会话是某条未闭环交接的承接方（claim.by = 本会话），取该记录的 origin ?? from；' +
            '否则就是本会话。转发上一跳的活儿时无需手填。'
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to write the broadcast / wake / spawn. false or omitted only previews.'
        }
      },
      required: ['workspace', 'issuePath', 'confirm']
    }),
    async execute(input, context) {
      const me = context?.sessionID;
      const { workspace, issuePath, abs, mtimeMs } = resolveBroadcastTargets(input?.workspace, input?.issuePath);
      // D4: refuse a same-workspace broadcast before any read / write.
      assertOtherWorkspace(workspace);
      // 0.6.0 (`collab_freeze`): a frozen workspace accepts no new hand-off —
      // checked before the proposal is even read, so a refused call writes
      // nothing (preview included) and makes no model call.
      const lineage = createLineage(ctx);
      const frozenWorkspace = await frozenBy({ workspace }, { lineage });
      if (frozenWorkspace) throw invalid(freezeDenyText(frozenWorkspace, `工作区 ${workspace} `));
      const expected = normalizeExpected(input?.expected);
      const agent = String(input?.agent ?? 'explore').trim() || 'explore';
      // 0.7.0 (R2/R4, `11-19-collab-origin`): the chain head of this hand-off.
      // Explicit `origin` wins; otherwise it is inherited from the unresolved
      // hand-off this session is claiming (`A → B → C`: B passes nothing and C
      // still sees A). An unknown alias is refused here — before the proposal is
      // read and before anything is written.
      let storedAliases: JsonObject = {};
      try {
        storedAliases = asObject(await ctx?.storage?.get(STORAGE_ALIASES));
      } catch {
        storedAliases = {}; // unreadable alias table = only collab.json's aliases
      }
      const resolvedOrigin = resolveOrigin({
        me,
        directory: ctx?.location?.directory,
        requested: input?.origin,
        aliases: { ...storedAliases, ...readConfig().aliases }
      });
      if (!resolvedOrigin.ok) throw invalid(resolvedOrigin.reason ?? '对接人无法解析');
      // Only a real upstream is stored (`origin.sid === me` adds nothing).
      const chainOrigin = storedOrigin(await fillOriginDirectory(resolvedOrigin.origin, ctx), me);
      const originHintText = originHint(chainOrigin, me);
      const originHead = originHintText
        ? `${originHintText}${resolvedOrigin.inherited ? `（继承自 ${resolvedOrigin.via}）` : ''}`
        : '';
      const content = readFileSync(abs, 'utf8');
      const proposal = summarizeProposal(content, issuePath);
      const bid = broadcastID({
        scope: 'peer',
        workspace,
        issuePath,
        contentHash: proposal.contentHash,
        mtimeMs
      });
      const preview = input?.confirm !== true;
      // R1 (pull): a requester on the protect list can never receive a pushed
      // receipt — the same lineage guard that protects it refuses the
      // `collab_send` the takeover text would ask for. Such a hand-off is
      // `pull`: the claimant writes the `[handoff]` line in its own last answer
      // and the requester extracts it once the lease lapses (`refresh`).
      const requesterProtected = Boolean(
        me && (await lineage.protectedAncestor(String(me), readConfig().protect))
      );
      const receiptMode: 'push' | 'pull' = requesterProtected ? 'pull' : 'push';
      const head = [
        `bid=${bid}  scope=peer  workspace=${workspace}`,
        `提案: ${issuePath}  标题: "${proposal.title}"  期望: ${expected}` +
          (expected === 'research' ? '（只读排查：对端只读代码/提案并回结论，不改代码）' : ''),
        `影响面(${proposal.files.length}): ${proposal.files.slice(0, 8).join(', ') || '(未在提案里找到文件路径)'}`,
        ...(originHead ? [`${originHead} —— 已写入记录 origin，对端注入/回执模板都会带上它`] : [])
      ];

      const existing = readBroadcast(bid);
      if (existing) {
        // Same content + mtime → same hand-off; never a second file, never a
        // second spawn (idempotent).
        let record = persistRefresh(existing, await chain.refresh(existing, Date.now(), { actor: me }));
        const askedSid = record?.asked?.sid;
        const top = askedSid
          ? record?.candidates?.find(candidate => candidate.sid === askedSid)
          : record?.candidates?.find(
              candidate => candidate.score >= BCAST_THRESHOLD && !(record?.skipped ?? []).includes(candidate.sid)
            );
        const busy = top ? sessionBusyMinutes((await chain.sessionInfo(top.sid)) ?? { id: top.sid }) : 0;
        const shouldWake = record?.state === 'open' && Boolean(top) && busy > 30 && record.wokeBy !== top?.sid;
        if (shouldWake && !preview && record && top) {
          const woke = await deliverAsk({ record, target: top.sid, wake: true });
          // R1 (0.1.6): write back the record `deliverAsk` returned — a stale
          // copy would drop the delivery bookkeeping (`cid` / `messageId`).
          record = writeBroadcast({ ...woke.record, wokeBy: woke.delivered ? top.sid : woke.record.wokeBy });
        }
        return {
          content: [
            `已存在同一内容的交接（bid 幂等，不新建）：state=${record?.state} attempts=${record?.attempts}`,
            ...head,
            `承接: ${record?.claim?.by ?? '-'}${record?.claim?.kind ? ` (${record.claim.kind})` : ''}  候选 top: ${
              record?.candidates?.[0] ? `${record.candidates[0].sid} score=${record.candidates[0].score}` : '-'
            }  当前问询: ${record?.asked?.sid ?? '-'}`,
            BCAST_DONE_STATES.includes(String(record?.state))
              ? `已闭环（state=${record?.state}）：${record?.receipt?.note ?? '-'}，不会再投递。`
              : shouldWake
                ? preview
                  ? `top-1 ${top?.sid} 已 busy ${Math.round(busy)}min：确认后会补发 1 条叫醒 prompt。`
                  : `已补发 1 条叫醒 prompt → ${top?.sid}（busy ${Math.round(busy)}min）。`
                : '没有需要补发/重投的动作（只提醒发起方一次，见 SessionStart 注入）。',
            `回执格式: [handoff] DONE|BLOCKED ${bid} <摘要>（${
              record?.receiptMode === 'pull'
                ? 'pull 模式：由承接方写在它自己最后一条回复里，租约到期后只读提取；发起方在 protect 名单内，不要 collab_send'
                : `必须由承接方 ${record?.claim?.by ?? 'ses_…'} 发送`
            }）`
          ].join('\n')
        };
      }

      const ranking = await chain.rankCandidates({
        workspace,
        proposal,
        expected,
        exclude: me ? [me] : []
      });
      const ranked = ranking.candidates;
      const top = ranked.find(candidate => candidate.score >= BCAST_THRESHOLD);
      const plannedSpawn = !top;
      // D3 (0.4.0): `expected:implement` against a read-only counterpart cannot
      // end in code — say it before writing (preview) and in the result.
      const mismatch = capabilityNote(top?.info?.agent ?? agent, expected);
      // 0.9.2 (`11-20-collab-gate`): handing work out is how a list gets shorter
      // — a broadcast is never refused and never requires a statement (R3). The
      // only gate output here is the overflow reminder, printed last.
      const gate = evaluate('broadcast', { bid }, me ? readContract(me) : undefined, readConfig(), { sid: me });
      const reminderLines = gate.reminder ? [gate.reminder] : [];

      if (preview) {
        return {
          content: [
            '未广播（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。',
            ...head,
            `群组成员 ${ranking.members} 个根会话（已排除子会话与 [protected*]），匹配分（阈值 ${BCAST_THRESHOLD}）:`,
            ...(ranked.length
              ? ranked.map(
                  candidate =>
                    `  ${candidate.score.toString().padStart(3)}  ${candidate.sid}  agent=${candidate.info?.agent ?? '?'}  ` +
                    `"${truncate(candidate.info?.title ?? '(untitled)', 50)}"  why=[${candidate.why.join(', ')}]`
                )
              : ['  （没有可用候选）']),
            plannedSpawn
              ? `无候选 ≥${BCAST_THRESHOLD} → 确认后用 claim(kind=spawn) 拉新一个会话：agent=${agent} location.directory=${workspace} title="impl:${proposal.slug}"${
                  agent === 'explore' ? '' : '（需要 agentConfirm:true）'
                }`
              : `top-1 ${top.sid} score=${top.score}${
                  top.busyMinutes > 30
                    ? ` 已 busy ${Math.round(top.busyMinutes)}min → 确认后补发 1 条 queue prompt 叫醒`
                    : ' → 不投递任何 prompt（接管请求走它的下一轮 context 注入，0 调用）'
                }；只有它会收到接管请求：ACCEPT = collab_accept，DECLINE（回 \`DECLINE ${bid} <理由>\`）/ 5 分钟不答 → 顺延下一候选（attempts+1）`,
            ...(mismatch ? [mismatch] : []),
            ...reminderLines
          ].join('\n')
        };
      }

      if (!top) {
        // 0.6.0 (`collab_freeze`): re-check right before the spawn. A freeze may
        // have been written while the ranking was running; creating a session in
        // a frozen workspace is exactly the "new collaboration" R3 forbids.
        const frozenNow = await frozenBy({ workspace }, { lineage });
        if (frozenNow) throw invalid(freezeDenyText(frozenNow, `工作区 ${workspace} `));
        // Atomic spawn claim: two concurrent broadcasts must create only one
        // session.
        const claimer = me ?? 'unknown';
        const claim = claimLock(bid, { by: claimer, kind: 'spawn' });
        if (!claim.ok) {
          return {
            content: [
              `未拉新：bid 已被 ${claim.holder.by ?? '?'} 领取（并发下只有一个 winner）。`,
              ...head,
              `用 collab_accept {bid:"${bid}"} 查看/接手；不要重复拉新。`
            ].join('\n')
          };
        }
        if (agent !== 'explore' && input?.agentConfirm !== true) {
          releaseLock(bid, claimer);
          throw invalid(
            `拒绝拉新：agent="${agent}" 需要每次显式确认（传 agentConfirm:true）。` +
              `默认 explore 是只读的，不需要该参数。未创建任何会话。`
          );
        }
        let created;
        try {
          created = await ctx.session.create({
            title: `impl:${proposal.slug}`,
            agent,
            location: { directory: workspace }
          });
        } catch (error) {
          releaseLock(bid, claimer);
          throw new Error(`拉新失败（未创建会话）：${errText(error)}`, { cause: error });
        }
        const info = ((created as { data?: JsonObject })?.data ?? created) as JsonObject;
        const landed = info?.location?.directory;
        // R6: `location.directory` must be carried *and* come back, otherwise
        // the session may have landed in /root (no plugin, nobody to act).
        // A host that does not echo `location` is treated as a failure and
        // the session we just created is rolled back.
        if (!info?.id || landed !== workspace) {
          if (info?.id) await ctx.session.remove({ sessionID: info.id }).catch(() => {});
          releaseLock(bid, [claimer, String(info?.id ?? '')]);
          throw new Error(
            `拉新失败：会话落点不对（期望 ${workspace}，实际 ${landed ?? '(未知)'}），已回滚刚建的会话。`
          );
        }
        // The lock stays owned by the requester (`by`) for the spawn race, but
        // the record's claimant is the new session — record it so lease expiry
        // can release the lock.
        updateLock(bid, { claimBy: info.id });
        const spawned = {
          bid,
          scope: 'peer',
          workspace,
          issuePath,
          title: proposal.title,
          expected,
          affectedFiles: proposal.files,
          candidates: ranked.slice(0, 10).map(candidate => ({
            sid: candidate.sid,
            score: candidate.score,
            why: candidate.why
          })),
          state: 'claimed',
          claim: {
            by: info.id,
            kind: 'spawn',
            token: claim.claim.token,
            at: claim.claim.at,
            leaseMs: BCAST_LEASE_MS,
            spawner: claimer
          },
          attempts: 0,
          skipped: [],
          seenBy: [],
          reminded: [],
          replies: [],
          from: { sid: me, directory: ctx?.location?.directory },
          // 0.7.0 (R1): the chain head of a forwarded hand-off (`A → B → C`).
          origin: chainOrigin,
          receiptMode,
          createdAt: Date.now()
        };
        // R1: the spawned session lives in *another* workspace, whose
        // project-level `agents.explore.permissions` knows nothing about
        // `collab_*` — without a session-level patch the takeover it was just
        // asked to accept is unusable. Grant only the five collab actions; a
        // failure is recorded (`permissionGrant:"failed"`) and never blocks
        // the hand-off (R5: the lease-expiry auto receipt still closes it).
        const granted = await chain
          .grantForSession(info.id, { reason: 'spawn', by: claimer })
          // Belt and braces (R5): even an unexpected internal/fs error must
          // not turn a created+claimed hand-off into a thrown tool call.
          .catch(error => ({
            ok: false as const,
            phase: 'internal',
            reason: `内部错误：${errText(error)}`
          }));
        const record = writeBroadcast({
          ...spawned,
          permissionGrant: granted.ok ? 'granted' : 'failed',
          // R1/R2/R4 (0.1.6): the takeover message to the new session. A
          // protected requester can never receive the ack back (`pull`), so the
          // record is marked `ackUnavailable` from the start and is never resent.
          delivery: {
            cid: newCorrelationID(),
            to: info.id,
            admittedAt: Date.now(),
            ...(requesterProtected ? { ackUnavailable: true } : {})
          }
        });
        const delivered = await deliverAsk({
          record,
          target: info.id,
          wake: false,
          threadID: undefined,
          spawn: true
        });
        return {
          content: [
            `已广播并拉新（无候选 ≥${BCAST_THRESHOLD}）：bid=${bid}`,
            ...head,
            `新会话: ${info.id} agent=${info.agent ?? agent} loc=${landed} title="impl:${proposal.slug}"`,
            granted.ok
              ? `已自动授予 5 条 collab_* 会话级权限（changed=${granted.changed}，记录 ${grantFile(info.id)}）。`
              : `未授予权限（${granted.reason}）→ 交接照常；对端无法回执时按租约到期自动提取。`,
            delivered.delivered
              ? '已向新会话投递接管请求（queue）。'
              : '新会话已创建，但接管请求投递失败（用 collab_send 补发；下次刷新会重试 1 次）。',
            // R1: the same three actions the new session was told, so the
            // requester can re-send them verbatim if delivery failed.
            ...handoffActions({ bid, requester: me, spawn: true, receiptMode, expected, origin: chainOrigin }),
            ...(mismatch ? [mismatch] : []),
            ...reminderLines,
            `该会话不会被删除（collab_list 标 [bootstrap]）；对端不动作时，租约到期会只读提取它的结论并自动闭环。`
          ].join('\n')
        };
      }
      const record = writeBroadcast({
        bid,
        scope: 'peer',
        workspace,
        issuePath,
        title: proposal.title,
        expected,
        affectedFiles: proposal.files,
        candidates: ranked.slice(0, 10).map(candidate => ({
          sid: candidate.sid,
          score: candidate.score,
          why: candidate.why
        })),
        state: 'open',
        // R3: the takeover request goes to the top-1 candidate only; the ask
        // lease (5 min) and DECLINE both advance to the next candidate.
        asked: { sid: top.sid, at: Date.now(), leaseMs: BCAST_LEASE_MS },
        attempts: 0,
        skipped: [],
        seenBy: [],
        askSeen: [],
        reminded: [],
        replies: [],
        from: { sid: me, directory: ctx?.location?.directory },
        // 0.7.0 (R1): the chain head of a forwarded hand-off (`A → B → C`).
        origin: chainOrigin,
        receiptMode,
        // R1/R2/R4 (0.1.6): the ask *is* the delivery for the injected path —
        // one cid per hand-off, refreshed when the ask advances to another
        // candidate (`injectionFor`). A protected requester: `ackUnavailable`.
        delivery: {
          cid: newCorrelationID(),
          to: top.sid,
          admittedAt: Date.now(),
          ...(requesterProtected ? { ackUnavailable: true } : {})
        },
        createdAt: Date.now()
      });

      const wake = top.busyMinutes > 30;
      const delivered = wake ? await deliverAsk({ record, target: top.sid, wake: true }) : undefined;
      if (delivered?.delivered) writeBroadcast({ ...delivered.record, wokeBy: top.sid });

      return {
        content: [
          `已广播 peer 交接：bid=${bid}（写入 ${BROADCAST_DIR}，其余成员 0 模型调用）`,
          ...head,
          `匹配分（阈值 ${BCAST_THRESHOLD}）:`,
          ...ranked
            .slice(0, 5)
            .map(
              candidate =>
                `  ${candidate.score.toString().padStart(3)}  ${candidate.sid}  busy=${Math.round(candidate.busyMinutes)}min  ` +
                `why=[${candidate.why.join(', ')}]`
            ),
          wake
            ? `top-1 ${top.sid} busy ${Math.round(top.busyMinutes)}min → 已补发 1 条 queue prompt 叫醒。`
            : `top-1 ${top.sid} → 未投递 prompt：它下一次模型请求会看到群组广播，用 collab_accept {bid:"${bid}"} 领取。`,
          // R1: the receiving side must accept *and* send a receipt; posting the
          // conclusion in its own session is explicitly not "done" (pilot G1).
          // In `pull` mode the receipt *is* the in-session conclusion instead.
          ...handoffActions({ bid, requester: me, receiptMode, expected, origin: chainOrigin }),
          ...(mismatch ? [mismatch] : []),
          receiptMode === 'pull'
            ? `推辞: 不领取即可（5 分钟不答自动顺延下一候选；pull 模式没有推送，不需要 DECLINE 回执）`
            : `推辞: collab_send {target:"${me ?? 'ses_…'}", text:"DECLINE ${bid} <理由>", confirm:true}（由被问询的 top-1 发回；不带 bid 且同时有多个问询时不会被采纳）`,
          ...reminderLines
        ].join('\n')
      };
    }
  };
}
