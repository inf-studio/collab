/**
 * `collab_mission` (0.9.1; 0.9.3 adds the drift three-choice) — the mainline
 * anchor of one session.
 *
 *   get      read-only: the stored mission, the resolved task anchor, and a
 *            suggestion when nothing is set yet (task title → first human
 *            instruction). Never writes — reading a contract must not create one.
 *   set      write `oneLine` / `taskPath` / `inScope` / `outOfScope` /
 *            `handoffTo` / `state`. Once a human confirmed the mission, a set is
 *            refused unless `reconfirm:true` **and** `by` are given (D7: auto
 *            inference never overwrites a human confirmation).
 *   confirm  fix the mission once. After that every injection keeps showing it
 *            and no inference can replace it. `by` is **required** — a human
 *            confirmation must be traceable to a person, not defaulted to the
 *            session id (review #6).
 *
 * 0.9.3 (`11-20-collab-drift`, R2): the three answers to `[drift]` — each one
 * writes `mission.state` **and** clears the unresolved marker, so a reminder
 * cannot be "acknowledged" by simply continuing:
 *
 *   resume { next }         state=active,    noAdvanceTurns=0, mainline todo
 *                           created/updated to `next` (doing) **and every
 *                           parked mainline row closed** (no zombie that
 *                           re-enters `[drift]` after 24h)
 *   block  { on, reason }   state=suspended, parkedAt=now, a suspended todo
 *                           (`wakeWhen:{kind:"manual"}`, blockingOn=`on`); the
 *                           park still expires on the 24h fallback (D17)
 *   done                    state=done — only with an existing
 *                           `kind:"mainline" && status:"open"` next-up todo
 */

import { CONTRACT_ONE_LINE_LIMIT, CONTRACT_SCOPE_CHARS, CONTRACT_SCOPE_ITEMS, CONTRACT_TODO_SUBJECT_LIMIT } from '../constants.ts';
import {
  MISSION_STATES,
  TODO_DONE_STATUSES,
  contractExists,
  contractFile,
  formatAge,
  nextTodoSeq,
  openTodos,
  readContract,
  updateContract
} from '../core/contract.ts';
import type { ContractMission, ContractTodo, MissionState, TodoStatus } from '../core/contract.ts';
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

/** `done` needs a placeholder: a finished mainline with nothing queued is refused (R5). */
function nextUpTodos(contract: { todos: ContractTodo[] }): ContractTodo[] {
  return contract.todos.filter(todo => todo.kind === 'mainline' && todo.status === 'open');
}

const NEXT_UP_HINT =
  '先建 next-up 占位：collab_todo { action:"add", kind:"mainline", subject:"<下一步>", confirm:true }，再 collab_mission { action:"done" }';

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
      lines.push(`建议主线: ${suggestion}（确认后固定：collab_mission { action:"confirm", by:"<你>" }）`);
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
      'Read or write the **session contract mission** (0.9.1; 0.9.3 adds the drift three-choice): the one-line ' +
      'mainline, the Trellis task path, the in/out-of-scope keywords and the handoff targets. `get` is read-only ' +
      'and also shows the resolved task anchor (session pointer → the workspace’s single in_progress task → ' +
      'nothing) plus a suggestion (task title, then the first human instruction) when nothing is set yet. `set` ' +
      'writes the mission; after a human `confirm` it is refused unless `reconfirm:true` and a non-empty `by` are ' +
      'given — inference never overwrites a human confirmation. `confirm` fixes the mission once and **requires a ' +
      'non-empty `by`** (who confirmed it — a session id is not a human); every later request keeps injecting it as ' +
      '`[mission]`. When `[drift]` appears, answer with exactly one of: `resume {next}` (state=active, counter reset, ' +
      'mainline todo created/updated — it also closes the parked rows), `block {on, reason}` (state=suspended + ' +
      'parked todo; the park still hits the 24h fallback), or `done` (requires an existing `kind:"mainline"` open ' +
      'next-up todo — a finished mainline with nothing queued is refused). ' +
      'The contract file is created lazily by the first writing call.',
    input: jsonInput({
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'confirm', 'resume', 'block', 'done'],
          description:
            'get = 只读查看（含建议主线）· set = 写 mission · confirm = 一次确认后固定 · ' +
            'resume / block / done = 处置 [drift] 的三选一'
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
          description: '确认人（confirm / reconfirm 必填）：写清是谁拍的板（如 "human" / "@长久同学"），不接受缺省。'
        },
        next: {
          type: 'string',
          description: `resume 必填：下一步做什么（≤${CONTRACT_TODO_SUBJECT_LIMIT} 字），会写成/更新一条 mainline doing 待办。`
        },
        on: {
          type: 'string',
          description: 'block 必填：阻塞方（`me` 或 `ses_…`），会写成 suspended 待办的 blockingOn。'
        },
        reason: {
          type: 'string',
          description: `block 必填：阻塞原因（≤${CONTRACT_TODO_SUBJECT_LIMIT} 字），作为挂起待办的标题。`
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

        const written = await updateContract(sid, latest => {
          if (patch.state === 'done' && !nextUpTodos(latest).length) {
            throw invalid(`mission.state=done 需要一个 mainline next-up 待办（当前 0 open）：${NEXT_UP_HINT}`);
          }
          return {
            ...latest,
            mission: {
              ...latest.mission,
              ...patch,
              // `suspended` always gets a park stamp (what the 2h drift reads);
              // any other state clears it so a stale stamp cannot fire drift.
              ...(patch.state === 'suspended'
                ? { parkedAt: Number(latest.mission.parkedAt) || now }
                : patch.state
                  ? { parkedAt: null }
                  : {}),
              ...(current.confirmedBy && reconfirm
                ? { confirmedBy: by, confirmedAt: now, source: 'confirm' as const }
                : {})
            }
          };
        });
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
        const by = String(input?.by ?? '').trim();
        if (!by) {
          throw invalid(
            'confirm 必须给 by（确认人）：确认要能追溯到人，不能用当前会话 id 代替。' +
              '例：collab_mission { action:"confirm", by:"human" }'
          );
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

      if (action === 'resume' || action === 'block' || action === 'done') {
        // The three answers to `[drift]` (R2). Every one of them clears
        // `turn.driftAt`, so the reminder cannot be silenced by just continuing.
        const next = truncate(input?.next, CONTRACT_TODO_SUBJECT_LIMIT);
        const on = String(input?.on ?? '').trim();
        const reason = truncate(input?.reason, CONTRACT_TODO_SUBJECT_LIMIT);

        if (action === 'resume' && !next) {
          throw invalid(
            'resume 必填 next（下一步做什么）：没有下一步的「继续」等于没决定，' +
              '例：collab_mission { action:"resume", next:"接线 M3 双写验证" }'
          );
        }
        if (action === 'block') {
          if (!on) throw invalid('block 必填 on（阻塞方）：等谁？`me` 或 `ses_…`');
          if (on !== 'me' && !on.startsWith('ses_')) throw invalid('on 必须是 "me" 或一个 ses_… 会话 id');
          if (!reason) throw invalid('block 必填 reason（一句话说明在等什么）：挂起没有理由 = 工作消失');
        }
        if (action === 'done' && !nextUpTodos(contract).length) {
          throw invalid(`mission.state=done 需要一个 mainline next-up 待办（当前 0 open）：${NEXT_UP_HINT}`);
        }

        if (input?.confirm !== true) {
          const preview =
            action === 'resume'
              ? `将 resume：state=active · noAdvanceTurns=0 · mainline 待办「${next}」`
              : action === 'block'
                ? `将 block：state=suspended · parkedAt=now · 挂起待办「${reason}」等 ${on}`
                : `将 done：state=done（已有 next-up：${nextUpTodos(contract).map(todo => todo.id).join(' / ')}）`;
          return {
            content: [`未执行（confirm 不为 true，仅预览）。${preview}`, '确认后在同样参数下传 confirm:true。'].join('\n')
          };
        }

        let createdID = '';
        let touchedID = '';
        const closedIDs: string[] = [];
        const written = await updateContract(sid, latest => {
          // Re-check inside the serialised mutate: another tool call may have
          // closed the placeholder between the read above and this write.
          if (action === 'done' && !nextUpTodos(latest).length) {
            throw invalid(`mission.state=done 需要一个 mainline next-up 待办（当前 0 open）：${NEXT_UP_HINT}`);
          }
          let todos = latest.todos;
          let seq = Number(latest.todoSeq) || 0;
          if (action === 'resume') {
            // `resume` is the "re-evaluate" answer to `[drift]`: every parked
            // mainline row (suspended / drifted) is closed here, otherwise it
            // stays behind, hits the 24h fallback and re-enters `[drift]` every
            // round — a reminder that `resume` could never clear (review B).
            const parkedIDs = new Set(
              latest.todos
                .filter(
                  todo => todo.kind === 'mainline' && (todo.status === 'suspended' || todo.status === 'drifted')
                )
                .map(todo => todo.id)
            );
            for (const id of parkedIDs) closedIDs.push(id);
            todos = parkedIDs.size
              ? latest.todos.map(todo =>
                  parkedIDs.has(todo.id)
                    ? {
                        ...todo,
                        status: 'closed' as TodoStatus,
                        closedAt: now,
                        evidence: 'resume',
                        updatedAt: now
                      }
                    : todo
                )
              : latest.todos;
            const openMainline = todos.filter(
              todo => todo.kind === 'mainline' && !TODO_DONE_STATUSES.includes(todo.status)
            );
            const target = openMainline.find(todo => todo.status === 'doing') ?? openMainline[0];
            if (target) {
              touchedID = target.id;
              todos = todos.map(todo =>
                todo.id === target.id
                  ? { ...todo, subject: next, status: 'doing' as TodoStatus, updatedAt: now }
                  : todo
              );
            } else {
              seq = nextTodoSeq(latest);
              createdID = `T${seq}`;
              todos = [
                ...todos,
                {
                  id: createdID,
                  kind: 'mainline',
                  subject: next,
                  status: 'doing',
                  blockingOn: 'me',
                  since: now,
                  updatedAt: now
                } satisfies ContractTodo
              ];
            }
          }
          if (action === 'block') {
            // Reuse the park row of the same blocker instead of growing the list
            // every time the mainline is re-parked (each 2h drift round). A
            // different blocker is genuinely a different wait → a new row.
            const parked = latest.todos.find(
              todo => todo.kind === 'mainline' && todo.status === 'suspended' && todo.blockingOn === on
            );
            if (parked) {
              touchedID = parked.id;
              todos = latest.todos.map(todo =>
                todo.id === parked.id
                  ? {
                      ...todo,
                      subject: reason,
                      blockingOn: on,
                      wakeWhen: { kind: 'manual' as const },
                      parkedBy: sid,
                      parkedAt: now,
                      updatedAt: now
                    }
                  : todo
              );
            } else {
              seq = nextTodoSeq(latest);
              createdID = `T${seq}`;
              todos = [
                ...latest.todos,
                {
                  id: createdID,
                  kind: 'mainline',
                  subject: reason,
                  status: 'suspended',
                  blockingOn: on,
                  wakeWhen: { kind: 'manual' as const },
                  parkedBy: sid,
                  parkedAt: now,
                  since: now,
                  updatedAt: now
                } satisfies ContractTodo
              ];
            }
          }
          const state: MissionState = action === 'resume' ? 'active' : action === 'block' ? 'suspended' : 'done';
          return {
            ...latest,
            todos,
            todoSeq: seq,
            mission: {
              ...latest.mission,
              state,
              parkedAt: state === 'suspended' ? now : null
            },
            turn: { ...latest.turn, noAdvanceTurns: 0, driftAt: 0 }
          };
        });

        const lines = [
          action === 'resume'
            ? `已 resume：state=active · noAdvanceTurns=0 · mainline 待办 ${touchedID || createdID}「${next}」`
            : action === 'block'
              ? `已 block：state=suspended · 挂起待办 ${touchedID || createdID}「${reason}」等 ${on}`
              : `已 done：state=done · next-up ${nextUpTodos(written).map(todo => todo.id).join(' / ')}`
        ];
        if (closedIDs.length) lines.push(`已收尾旧挂起行 ${closedIDs.join(' / ')}（evidence=resume，不再进 [drift]）`);
        lines.push(...renderMission(written, written.mission, hint, written.mission.oneLine, now));
        return { content: lines.join('\n') };
      }

      throw invalid('action 必须是 get | set | confirm | resume | block | done');
    }
  };
}
