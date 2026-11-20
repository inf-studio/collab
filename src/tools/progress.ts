/**
 * `collab_progress` (0.9.1, R3/D20) — milestones move **only on verified
 * evidence**.
 *
 *   list   read-only: done/total, the next milestone, every row.
 *   add    plan a milestone (`M1`, `M2`, …). A repeat updates its title.
 *   light  mark it done with `evidence` (`commit:` / `file:` / `test:` /
 *          `decision:`). No evidence → refused; unverifiable evidence →
 *          refused with the reason. Success moves `plan.lastAdvancedAt` and
 *          resets `turn.noAdvanceTurns` (the 0.9.3 drift counter).
 *
 * `confirm:true` is required for the two writing verbs, like every other
 * writing tool of this plugin.
 */

import { CONTRACT_MILESTONE_LIMIT } from '../constants.ts';
import { contractFile, formatAge, readContract, updateContract } from '../core/contract.ts';
import { invalid } from '../core/errors.ts';
import { checkEvidence } from '../core/evidence.ts';
import { truncate } from '../util.ts';
import type { ToolDefinition } from '../types.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

function renderProgress(contract: ReturnType<typeof readContract>, now: number): string[] {
  const milestones = contract.plan.milestones;
  if (!milestones.length) {
    return ['[progress] 未设置里程碑（collab_progress { action:"add", milestone:"M1", title:"…", confirm:true }）'];
  }
  const done = milestones.filter(milestone => milestone.done).length;
  const next = milestones.find(milestone => !milestone.done);
  const head = next
    ? `[progress] ${done}/${milestones.length} · 下一里程碑 ${next.id}「${truncate(next.title, 60)}」需要 evidence`
    : `[progress] ${done}/${milestones.length} 全部里程碑已完成`;
  const lines = [
    head,
    ...milestones.map(milestone =>
      milestone.done
        ? `  ${milestone.id} ${truncate(milestone.title, 60)} · done${milestone.at ? ` @ ${new Date(milestone.at).toISOString().slice(5, 16)}` : ''}` +
          `${milestone.evidence ? ` · ${milestone.evidence}` : ''}`
        : `  ${milestone.id} ${truncate(milestone.title, 60)} · 未完成`
    ),
    `推进: ${contract.plan.lastAdvancedAt ? `${formatAge(now - contract.plan.lastAdvancedAt)} 前` : '尚未推进（无 evidence）'}`
  ];
  return lines;
}

export function progressTool(kit: ToolKit): ToolDefinition {
  const { ctx } = kit.deps;

  return {
    name: 'collab_progress',
    description:
      'Plan and light **milestones** of the session contract (0.9.1). A milestone is lit only by evidence the ' +
      'machine can verify — `commit:<sha>` (exists and is an ancestor of HEAD), `file:<path>:<line>` (file has that ' +
      'line), `test:<path>` (report exists), `decision:<id>` (recorded in a hand-off’s decisions). Missing or ' +
      'unverifiable evidence is refused with the reason, so `plan.lastAdvancedAt` only moves on real progress. ' +
      '`list` is read-only; `add` / `light` need `confirm:true`. Lighting resets the drift counter (0.9.3).',
    input: jsonInput({
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'light'],
          description: 'list = 只读查看 · add = 规划里程碑 · light = 用 evidence 点亮（默认：给了 milestone 即 light）'
        },
        milestone: {
          type: 'string',
          description: '里程碑 id（`M1` / `M2` …）。'
        },
        title: {
          type: 'string',
          description: 'add 时的标题（≤120 字）；重复 add 同一 id 会更新标题。'
        },
        evidence: {
          type: 'string',
          description: 'light 必填：`commit:<sha>` / `file:<path>:<line>` / `test:<path>` / `decision:<id>`。'
        },
        confirm: {
          type: 'boolean',
          description: 'add / light 必须为 true 才写；false / 省略只预览。list 不需要。'
        }
      },
      required: ['action']
    }),

    async execute(input, context) {
      const requested = String(input?.action ?? '').trim();
      const action = requested || (input?.milestone ? 'light' : 'list');
      const sid = String(context?.sessionID ?? '').trim();
      if (!sid) throw invalid('缺少会话上下文（sessionID）：里程碑是会话级的');
      const now = Date.now();
      const contract = readContract(sid);
      const directory = ctx?.location?.directory;

      if (action === 'list') {
        return { content: renderProgress(contract, now).join('\n') };
      }

      if (action !== 'add' && action !== 'light') {
        throw invalid('action 必须是 list | add | light');
      }
      const milestoneID = String(input?.milestone ?? '').trim();
      if (!milestoneID) throw invalid(`${action} 需要 milestone（如 M3）`);
      if (input?.confirm !== true) {
        return {
          content: [
            `未执行（confirm 不为 true，仅预览）。将${action === 'add' ? '新增/更新里程碑' : '点亮里程碑'} ${milestoneID}:`,
            `契约文件: ${contractFile(sid)}`,
            ...(action === 'light'
              ? [`evidence: ${String(input?.evidence ?? '(缺 —— 会被拒绝)')}`, 'evidence 会先用 git / 文件系统校验，不通过则不写。']
              : []),
            '确认后在同样参数下传 confirm:true。'
          ].join('\n')
        };
      }

      if (action === 'add') {
        const title = truncate(input?.title, 120);
        if (!title) throw invalid('add 需要 title（里程碑标题）');
        // Cap + "does it already exist" are decided inside the serialised
        // mutate: two concurrent adds of the same id would both see the old list
        // and append the milestone twice (review #1).
        let existed = false;
        const written = await updateContract(sid, latest => {
          const existing = latest.plan.milestones.find(item => item.id === milestoneID);
          existed = Boolean(existing);
          if (!existing && latest.plan.milestones.length >= CONTRACT_MILESTONE_LIMIT) {
            throw invalid(`里程碑已达上限 ${CONTRACT_MILESTONE_LIMIT} 条：先清理计划，不要无限增长`);
          }
          return {
            ...latest,
            plan: {
              ...latest.plan,
              milestones: existing
                ? latest.plan.milestones.map(item => (item.id === milestoneID ? { ...item, title } : item))
                : [...latest.plan.milestones, { id: milestoneID, title, done: false }]
            }
          };
        });
        return {
          content: [
            `${existed ? '已更新' : '已新增'}里程碑 ${milestoneID}「${title}」`,
            ...renderProgress(written, now)
          ].join('\n')
        };
      }

      // light — the only path that may move `plan.lastAdvancedAt`.
      const evidence = String(input?.evidence ?? '').trim();
      if (!evidence) {
        throw invalid(
          '无 evidence 不点亮：collab_progress 只认可校验的证据，' +
            '给 commit:<sha> / file:<path>:<line> / test:<path> / decision:<id>'
        );
      }
      const target = contract.plan.milestones.find(item => item.id === milestoneID);
      if (!target) {
        throw invalid(
          `没有里程碑 ${milestoneID}：先规划（collab_progress { action:"add", milestone:"${milestoneID}", title:"…", confirm:true }），` +
            `现有: ${contract.plan.milestones.map(item => item.id).join(' / ') || '（空）'}`
        );
      }
      if (target.done && target.evidence === evidence) {
        return {
          content: [
            `${milestoneID} 已由同一 evidence 点亮（${evidence}），未重复推进 lastAdvancedAt。`,
            ...renderProgress(contract, now)
          ].join('\n')
        };
      }
      const check = checkEvidence(evidence, { directory, now });
      if (!check.ok) {
        throw invalid(`evidence 校验失败：${check.reason}`);
      }

      const written = await updateContract(sid, latest => ({
        ...latest,
        plan: {
          ...latest.plan,
          lastAdvancedAt: now,
          milestones: latest.plan.milestones.map(item =>
            item.id === milestoneID ? { ...item, done: true, evidence, at: now } : item
          )
        },
        turn: { ...latest.turn, lastAdvancedAt: now, noAdvanceTurns: 0 }
      }));
      return {
        content: [
          `已点亮 ${milestoneID}「${target.title}」: ${check.reason}`,
          `plan.lastAdvancedAt=${new Date(now).toISOString()}  noAdvanceTurns=0`,
          ...renderProgress(written, now)
        ].join('\n')
      };
    }
  };
}
