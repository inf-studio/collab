/**
 * `collab_fact` (0.9.4, R3) — the **facts ledger** verbs, one tool.
 *
 *   settle      register a fact (`F1`, `F2`, …): `claim` + `evidence` + `grade`
 *               (`measured` / `inferred` / `relayed` / `unknown`). An identical
 *               claim supersedes the active older one. A cited `relayed` /
 *               `unknown` fact is refused as evidence (D5) — a retransmission is
 *               not a measurement.
 *   retract     one fact was wrong: state `retracted` + a mandatory `reason`
 *               (counted per day, so a retraction rate is measurable).
 *   invalidate  the world moved: a fact **and everything citing it** (or every
 *               fact settled up to an epoch) becomes `superseded`, the workspace
 *               `epoch` moves, and open todos citing the retracted facts are
 *               marked `staleWork` (never closed).
 *   list        read-only: active facts by default, `includeAll` for history.
 *
 * Storage is the workspace ledger (`core/facts.ts`); reads never write.
 * `confirm:true` is required for the three writing verbs.
 */
import {
  FACT_GRADES,
  FACT_LIST_MAX,
  FACT_SETTLE_GRADES,
  STALE_REPLY_RATIO
} from '../constants.ts';
import {
  activeFacts,
  factsFile,
  formatFact,
  invalidateFacts,
  isFactID,
  listFacts,
  metricsOf,
  retractFact,
  retractedLabel,
  settleFact,
  workspaceFacts,
  workspaceOf
} from '../core/facts.ts';
import { invalid } from '../core/errors.ts';
import { basedOnLabel } from '../core/tri-state.ts';
import { truncate } from '../util.ts';
import type { ToolDefinition } from '../types.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

export function factTool(kit: ToolKit): ToolDefinition {
  const { ctx } = kit.deps;

  return {
    name: 'collab_fact',
    description:
      'Register, retract and invalidate **facts** in the workspace ledger (0.9.4). `settle` needs `claim` + ' +
      '`evidence` + `grade` (measured | inferred | relayed | unknown); a `relayed`/`unknown` fact cannot be cited ' +
      'as another fact’s evidence (settle refuses it — supplement a measured fact instead). `retract` needs a ' +
      '`reason` and is counted per day (`metrics.retract_count`). `invalidate` takes a fact id (`F3`) and ' +
      'supersedes it plus every fact that cites it, or an epoch number and supersedes everything settled up to ' +
      'it; the workspace epoch moves and open todos citing a retracted fact are marked `staleWork` (never ' +
      'closed). `list` is read-only. The next request of every session in this workspace carries `[settled]` / ' +
      '`[retracted]` once, and messages with grade unknown are injected as `[未标注]`. `confirm:true` is required ' +
      'for the three writing verbs.',
    input: jsonInput({
      properties: {
        action: {
          type: 'string',
          enum: ['settle', 'retract', 'invalidate', 'list'],
          description: 'settle = 登记事实 · retract = 撤回单条 · invalidate = 作废一条及其派生（或一个 epoch）· list = 只读'
        },
        claim: {
          type: 'string',
          description: 'settle 必填：一句话、可证伪的断言（如 "serverId 恒非空"）。相同 claim 会 supersede 旧的 active 行。'
        },
        evidence: {
          type: 'string',
          description: 'settle 必填：`文件:行` / 命令 / 复现路径；引用其它事实可写 `F3`（relayed/unknown 会被拒）。'
        },
        grade: {
          type: 'string',
          enum: FACT_GRADES,
          description:
            `settle 必填（${FACT_SETTLE_GRADES.join(' | ')}）：measured = 自己量到的；inferred = 推断；` +
            'relayed = 转述（不得被引用为证据）；unknown = 未标注（可登记，同样不得被引用）。'
        },
        factIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'settle 可选：本条据以成立的事实 id 列表（派生边；invalidate 沿这些边传播）。'
        },
        id: {
          type: 'string',
          description: 'retract 必填：要撤回的事实 id（`F3`）。'
        },
        reason: {
          type: 'string',
          description: 'retract 必填：撤回原因（≤200 字；按原因分类计数，可度量）。'
        },
        since: {
          type: ['string', 'number'],
          description:
            'invalidate 必填：事实 id（`F3` = 该事实及其派生）或 epoch 数字（`7` = 所有 basedOn.facts ≤ 7 的 active 事实）。'
        },
        includeAll: {
          type: 'boolean',
          description: 'list 可选：连 superseded / retracted 历史一起列出（默认只列 active）。'
        },
        limit: {
          type: 'number',
          description: `list 可选：最多列多少行（默认 ${FACT_LIST_MAX}）。`
        },
        confirm: {
          type: 'boolean',
          description: 'settle / retract / invalidate 必须为 true 才写；false / 省略只预览。list 不需要。'
        }
      },
      required: ['action']
    }),

    async execute(input, context) {
      const action = String(input?.action ?? '').trim();
      const workspace = workspaceOf(ctx);
      const by = String(context?.sessionID ?? '');
      const now = Date.now();

      if (action === 'list') {
        const rows = listFacts(workspace, {
          includeAll: input?.includeAll === true,
          limit: Number(input?.limit) || FACT_LIST_MAX
        });
        const ws = workspaceFacts(workspace);
        const active = activeFacts(workspace).length;
        const metrics = metricsOf(workspace, now);
        const head =
          `[facts] ${active} active / ${ws.facts.length} total · epoch ${ws.epoch}` +
          ` · 今日 settled ${metrics.settled} / retracted ${metrics.retracted}`;
        const body = rows.length
          ? rows.map(fact => `  ${formatFact(fact)}`)
          : ['  （空）用 collab_fact { action:"settle", claim, evidence, grade, confirm:true } 登记第一条'];
        const reasons = Object.entries(metrics.reasons);
        return {
          content: [
            head,
            ...body,
            ...(reasons.length ? [`  撤回原因: ${reasons.map(([reason, count]) => `${reason}×${count}`).join(' / ')}`] : []),
            `账本: ${factsFile()} · 工作区 ${workspace}`
          ].join('\n')
        };
      }

      if (action === 'settle') {
        const claim = truncate(input?.claim, 300);
        const evidence = truncate(input?.evidence, 500);
        const grade = String(input?.grade ?? '').trim();
        if (!claim) throw invalid('settle 必填 claim（一句话可证伪的断言）');
        if (!evidence) throw invalid('settle 必填 evidence（文件:行 / 命令 / 复现路径）');
        if (!grade) throw invalid(`settle 必填 grade（${FACT_SETTLE_GRADES.join(' | ')}）：未标注的事实不可引用`);
        if (input?.confirm !== true) {
          return {
            content: [
              '未写入（confirm 不为 true，仅预览）。将登记事实:',
              `claim: ${claim}`,
              `grade: ${grade}  evidence: ${evidence}`,
              `工作区: ${workspace}（工作区级账本，所有会话共享）`,
              '确认后在同样参数下传 confirm:true。'
            ].join('\n')
          };
        }
        const result = await settleFact({
          workspace,
          claim,
          evidence,
          grade,
          factIds: input?.factIds,
          by,
          now
        });
        return {
          content: [
            `已登记 ${result.fact.id} [${result.fact.grade}] epoch ${result.epoch}`,
            `  ${result.fact.claim} · ${result.fact.evidence}`,
            `  baseline: ${basedOnLabel(result.fact.basedOn)}`,
            ...(result.superseded.length ? [`  同 claim 旧事实已 supersede: ${result.superseded.join(' / ')}`] : []),
            `注入: 本工作区下一次请求出现 [settled:${result.fact.id}]`
          ].join('\n')
        };
      }

      if (action === 'retract') {
        const id = String(input?.id ?? '').trim();
        const reason = truncate(input?.reason, 200);
        if (!isFactID(id)) throw invalid(`retract 需要事实 id（F1 / F2 …），收到 "${id}"`);
        if (!reason) throw invalid('retract 必填 reason：没有原因的撤回无法度量（PRD R3）');
        if (input?.confirm !== true) {
          return {
            content: [
              '未执行（confirm 不为 true，仅预览）。将撤回:',
              `${id}  reason: ${reason}`,
              `今日 retract_count 会 +1（工作区 ${workspace}）。`,
              '确认后在同样参数下传 confirm:true。'
            ].join('\n')
          };
        }
        const result = await retractFact({ workspace, id, reason, by, now });
        return {
          content: [
            `已撤回 ${result.fact.id}（reason: ${reason}）`,
            `今日 metrics: retracted ${result.metrics.retracted} · reasons ${Object.entries(result.metrics.reasons)
              .map(([text, count]) => `${text}×${count}`)
              .join(' / ')}`,
            `注入: [retracted:${result.fact.id}]（工作区级传播；epoch ${result.epoch} 不变）`
          ].join('\n')
        };
      }

      if (action === 'invalidate') {
        const since = input?.since;
        if (since === undefined || since === null || String(since).trim() === '') {
          throw invalid('invalidate 必填 since（事实 id `F3` 或 epoch 数字）');
        }
        if (input?.confirm !== true) {
          return {
            content: [
              '未执行（confirm 不为 true，仅预览）。将作废:',
              `since: ${String(since)}（${isFactID(since) ? '该事实及其派生' : 'basedOn.facts ≤ 该 epoch 的 active 事实'}）`,
              `工作区 epoch 会 +1；在途 todo 标 staleWork（不关闭）。`,
              '确认后在同样参数下传 confirm:true。'
            ].join('\n')
          };
        }
        const result = await invalidateFacts({ workspace, since, by, now });
        if (!result.applied) {
          return {
            content: [
              `未变更：${result.since} 没有可作废的 active 事实（可能已作废过）`,
              `epoch 仍为 ${result.epoch}`
            ].join('\n')
          };
        }
        const root = result.changed.find(entry => entry.id === result.since)?.id ?? result.since;
        return {
          content: [
            `已作废 ${retractedLabel(root, result.derived)}（epoch ${result.epoch}）`,
            `  changed: ${result.changed.map(entry => `${entry.id}:${entry.state}${entry.supersededBy ? `→${entry.supersededBy}` : ''}`).join(' / ')}`,
            `  注入: [retracted:${retractedLabel(root, result.derived)}]（本工作区所有会话的下一轮）`,
            ...(result.staleTodos.length
              ? [`  在途 todo 标 staleWork（不关闭）: ${result.staleTodos.join(' / ')}`]
              : ['  没有 todo 引用被作废的事实']),
            `  stale 回复: 只回增量（≤${Math.round(STALE_REPLY_RATIO * 100)}% 原文），不要重述已作废事实`
          ].join('\n')
        };
      }

      throw invalid('action 必须是 settle | retract | invalidate | list');
    }
  };
}
