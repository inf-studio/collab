/**
 * `collab_mission` (0.9.1) — the mainline anchor of one session.
 *
 *   get      read-only: the stored mission, the resolved task anchor, and a
 *            suggestion when nothing is set yet (task title → first human
 *            instruction). Never writes — reading a contract must not create one.
 *   set      write `oneLine` / `taskPath` / `inScope` / `outOfScope` /
 *            `handoffTo` / `state`. Once a human confirmed the mission, a set is
 *            refused unless `reconfirm:true` **and** `by` are given (D7: auto
 *            inference never overwrites a human confirmation).
 *   confirm  fix the mission once. After that every injection keeps showing it
 *            and no inference can replace it.
 */

import { CONTRACT_ONE_LINE_LIMIT, CONTRACT_SCOPE_CHARS, CONTRACT_SCOPE_ITEMS } from '../constants.ts';
import {
  MISSION_STATES,
  contractExists,
  contractFile,
  formatAge,
  openTodos,
  readContract,
  updateContract
} from '../core/contract.ts';
import type { ContractMission, MissionState } from '../core/contract.ts';
import { invalid } from '../core/errors.ts';
import { firstHumanInstruction, resolveMissionAnchor } from '../core/mission-resolve.ts';
import { asObject, dedupe, truncate } from '../util.ts';
import type { ToolDefinition } from '../types.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

const SOURCE_LABEL: Record<string, string> = {
  pointer: '会话指针（.trellis/.runtime/sessions）',
  task: '工作区唯一 in_progress 任务',
  ambiguous: '多个 in_progress 任务（需手工指定）',
  none: '无活动任务'
};

/** `['a','b']` / `"a, b"` / `"a\nb"` → a bounded, deduped keyword list. */
function keywordList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\n,，]/);
  const list = dedupe(raw.map(item => truncate(item, CONTRACT_SCOPE_CHARS)).filter(Boolean));
  if (list.length > CONTRACT_SCOPE_ITEMS) {
    throw invalid(`最多 ${CONTRACT_SCOPE_ITEMS} 条边界关键词（收到 ${list.length} 条）`);
  }
  return list;
}

function handoffMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const raw = asObject(value);
  const out: Record<string, string> = {};
  for (const [key, target] of Object.entries(raw)) {
    const name = truncate(key, CONTRACT_SCOPE_CHARS);
    const sid = String(target ?? '').trim();
    if (name && sid) out[name] = sid;
  }
  return out;
}

function renderMission(
  contract: ReturnType<typeof readContract>,
  mission: ContractMission,
  hint: ReturnType<typeof resolveMissionAnchor>,
  suggestion: string,
  now: number
): string[] {
  const open = openTodos(contract);
  const done = contract.plan.milestones.filter(milestone => milestone.done).length;
  const flag = mission.confirmedBy
    ? `已确认 by ${mission.confirmedBy} @ ${new Date(Number(mission.confirmedAt) || now).toISOString()}`
    : '[未确认]';
  const lines = [
    `[mission] ${mission.oneLine || '未设置'}${mission.taskPath ? ` · ${mission.taskPath}` : ''} ${flag}`,
    `来源: ${SOURCE_LABEL[hint.source] ?? hint.source}`,
    `边界: 做 ${mission.inScope.join(' / ') || '—'} · 不做 ${mission.outOfScope.join(' / ') || '—'}`,
    `状态: ${mission.state}` +
      `${contract.plan.lastAdvancedAt ? ` · 推进于 ${formatAge(now - contract.plan.lastAdvancedAt)} 前` : ' · 尚未推进'}`,
    `待办: ${open.length} open · 里程碑 ${done}/${contract.plan.milestones.length}`,
    `契约文件: ${contractFile(contract.sid)}${contractExists(contract.sid) ? '' : '（尚未创建，首次 set/confirm 才写盘）'}`
  ];
  if (!mission.confirmedBy) {
    if (suggestion) {
      lines.push(`建议主线: ${suggestion}（确认后固定：collab_mission { action:"confirm" }）`);
    } else {
      lines.push('提示: 没有可推断的主线，请用 collab_mission { action:"set", oneLine:"…" } 后再 confirm。');
    }
  }
  if (hint.source === 'ambiguous' && hint.candidates?.length) {
    lines.push(`注意: 有 ${hint.candidates.length} 个 in_progress 任务，不猜；指定一个：${hint.candidates.join(' / ')}`);
  }
  return lines;
}

export function missionTool(kit: ToolKit): ToolDefinition {
  const { ctx } = kit.deps;

  return {
    name: 'collab_mission',
    description:
      'Read or write the **session contract mission** (0.9.1): the one-line mainline, the Trellis task path, the ' +
      'in/out-of-scope keywords and the handoff targets. `get` is read-only and also shows the resolved task anchor ' +
      '(session pointer → the workspace’s single in_progress task → nothing) plus a suggestion (task title, then the ' +
      'first human instruction) when nothing is set yet. `set` writes the mission; after a human `confirm` it is ' +
      'refused unless `reconfirm:true` and a non-empty `by` are given — inference never overwrites a human ' +
      'confirmation. `confirm` fixes the mission once; every later request keeps injecting it as `[mission]`. ' +
      'The contract file is created lazily by the first writing call.',
    input: jsonInput({
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'confirm'],
          description: 'get = 只读查看（含建议主线）· set = 写 mission · confirm = 一次确认后固定'
        },
        oneLine: {
          type: 'string',
          description: `一句话主线（≤${CONTRACT_ONE_LINE_LIMIT} 字；set / confirm 可用）。`
        },
        taskPath: {
          type: 'string',
          description: 'Trellis 任务路径，如 `.trellis/tasks/11-20-collab-contract`（相对工作区）。'
        },
        inScope: {
          type: 'array',
          items: { type: 'string' },
          description: `做（≤${CONTRACT_SCOPE_ITEMS} 条，每条 ≤${CONTRACT_SCOPE_CHARS} 字）。`
        },
        outOfScope: {
          type: 'array',
          items: { type: 'string' },
          description: `不做（≤${CONTRACT_SCOPE_ITEMS} 条）；[scope] 用这些关键词匹配本轮消息，命中才出现。`
        },
        handoffTo: {
          type: 'object',
          description: 'out-of-scope 关键词 → 该边界的 owner 会话 id（0.9.2 闸门读取；0.9.1 的 [scope] 行会显示转交对象）。'
        },
        state: {
          type: 'string',
          enum: MISSION_STATES,
          description: 'active / idle / suspended / done（默认 active）。'
        },
        reconfirm: {
          type: 'boolean',
          description: '已确认后仍要改 mission 时必须为 true，且同时给 by。'
        },
        by: {
          type: 'string',
          description: '确认人 / 会话（confirm 缺省用当前会话 id；reconfirm 时必填）。'
        }
      },
      required: ['action']
    }),

    async execute(input, context) {
      const action = String(input?.action ?? 'get').trim();
      const sid = String(context?.sessionID ?? '').trim();
      if (!sid) throw invalid('缺少会话上下文（sessionID）：mission 是会话级的');
      const now = Date.now();
      const contract = readContract(sid);
      const hint = resolveMissionAnchor(ctx?.location?.directory, sid);

      if (action === 'get') {
        const suggestion =
          contract.mission.oneLine ||
          hint.oneLine ||
          (await firstHumanInstruction(ctx, sid));
        const mission =
          contract.mission.confirmedBy || contract.mission.oneLine
            ? contract.mission
            : { ...contract.mission, ...(hint.taskPath ? { taskPath: hint.taskPath } : {}) };
        return { content: renderMission(contract, mission, hint, suggestion, now).join('\n') };
      }

      if (action === 'set') {
        const current = contract.mission;
        const reconfirm = input?.reconfirm === true;
        const by = String(input?.by ?? '').trim();
        if (current.confirmedBy && !reconfirm) {
          throw invalid(
            `mission 已由 ${current.confirmedBy} 确认（${new Date(Number(current.confirmedAt) || now).toISOString()}）：` +
              '注入与自动推断都不会覆盖它。确实要改：collab_mission { action:"set", reconfirm:true, by:"<确认人>", … }'
          );
        }
        if (current.confirmedBy && reconfirm && !by) {
          throw invalid('reconfirm 必须给 by（确认人）：谁改的必须写清，不能靠推断覆盖人工确认。');
        }

        const patch: Partial<ContractMission> = {};
        if (input?.oneLine !== undefined) {
          const oneLine = truncate(input.oneLine, CONTRACT_ONE_LINE_LIMIT);
          if (!oneLine) throw invalid('oneLine 不能为空（清空主线请用 state:"done" 或新建任务）');
          patch.oneLine = oneLine;
        }
        if (input?.taskPath !== undefined) {
          const taskPath = String(input.taskPath ?? '').trim().replace(/^\.\//, '').replace(/\/+$/, '');
          if (!taskPath) throw invalid('taskPath 不能为空');
          patch.taskPath = taskPath;
        }
        const inScope = keywordList(input?.inScope);
        if (inScope) patch.inScope = inScope;
        const outOfScope = keywordList(input?.outOfScope);
        if (outOfScope) patch.outOfScope = outOfScope;
        const handoffTo = handoffMap(input?.handoffTo);
        if (handoffTo) patch.handoffTo = handoffTo;
        if (input?.state !== undefined) {
          const state = String(input.state).trim() as MissionState;
          if (!MISSION_STATES.includes(state)) {
            throw invalid(`state 必须是 ${MISSION_STATES.join(' | ')}`);
          }
          patch.state = state;
        }
        if (!Object.keys(patch).length) throw invalid('没有可写字段：给 oneLine / taskPath / inScope / outOfScope / handoffTo / state 之一');

        const written = await updateContract(sid, latest => ({
          ...latest,
          mission: {
            ...latest.mission,
            ...patch,
            ...(current.confirmedBy && reconfirm
              ? { confirmedBy: by, confirmedAt: now, source: 'confirm' as const }
              : {})
          }
        }));
        const lines = [`已写入 mission（${contractFile(sid)}）`];
        if (current.confirmedBy && reconfirm) lines.push(`注: 按 reconfirm 覆盖了 ${current.confirmedBy} 的确认；新的确认人 ${by}。`);
        if (!written.mission.confirmedBy) lines.push('注: 仍是 [未确认] —— 确认一次：collab_mission { action:"confirm", by:"<你>" }');
        lines.push(...renderMission(written, written.mission, hint, written.mission.oneLine, now));
        return { content: lines.join('\n') };
      }

      if (action === 'confirm') {
        const current = contract.mission;
        if (current.confirmedBy) {
          return {
            content:
              `mission 已确认（by=${current.confirmedBy} @ ${new Date(Number(current.confirmedAt) || now).toISOString()}），保持不变。\n` +
              '注入会一直显示它；确实要改：collab_mission { action:"set", reconfirm:true, by:"<确认人>", … }'
          };
        }
        const oneLine =
          truncate(input?.oneLine, CONTRACT_ONE_LINE_LIMIT) ||
          current.oneLine ||
          hint.oneLine ||
          (await firstHumanInstruction(ctx, sid));
        if (!oneLine) {
          throw invalid(
            '无可确认的主线：没有活动任务，也没有可读的会话首条指令。请先 set：' +
              'collab_mission { action:"set", oneLine:"…" } 然后再 confirm。'
          );
        }
        const by = String(input?.by ?? '').trim() || sid;
        const taskPath = current.taskPath ?? hint.taskPath;
        const written = await updateContract(sid, latest => ({
          ...latest,
          mission: {
            ...latest.mission,
            oneLine,
            ...(taskPath ? { taskPath } : {}),
            confirmedBy: by,
            confirmedAt: now,
            source: 'confirm'
          }
        }));
        return {
          content: [
            `已确认 mission（by=${by}）：${oneLine}`,
            `边界: 做 ${written.mission.inScope.join(' / ') || '—'} · 不做 ${written.mission.outOfScope.join(' / ') || '—'}` +
              `${taskPath ? ` · ${taskPath}` : ''}`,
            '此后每轮请求都会注入 [mission]；set 覆盖需 reconfirm:true + by。'
          ].join('\n')
        };
      }

      throw invalid('action 必须是 get | set | confirm');
    }
  };
}
