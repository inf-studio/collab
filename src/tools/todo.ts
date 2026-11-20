/**
 * `collab_todo` (0.9.1, R4) — the contract's todo list.
 *
 *   add      new todo (`T1`, `T2`, …). `subject` required; `blockingOn` is
 *            `'me'` (default) or a `ses_…`; `status:'doing'` is how a todo
 *            becomes "in flight" (what `[未收尾]` looks at next turn).
 *   close    requires evidence. A verifiable form (`commit:` / `file:` /
 *            `test:` / `decision:`) is checked first; free text is stored but
 *            never moves a milestone.
 *   defer    keep it open, push it to the bottom (optional `until`).
 *   suspend  requires `wakeWhen` — a suspended todo without a wake condition is
 *            how work silently disappears.
 *   list     read-only.
 *
 * Every writing verb needs `confirm:true`, like the rest of the plugin.
 */

import {
  CONTRACT_TODO_LIMIT,
  CONTRACT_TODO_LIST_MAX,
  CONTRACT_TODO_SUBJECT_LIMIT,
  CONTRACT_WAKE_CHARS
} from '../constants.ts';
import {
  TODO_KINDS,
  TODO_DONE_STATUSES,
  contractFile,
  formatAge,
  openTodos,
  readContract,
  updateContract
} from '../core/contract.ts';
import type { ContractTodo, TodoKind, TodoStatus } from '../core/contract.ts';
import { invalid } from '../core/errors.ts';
import { checkEvidence } from '../core/evidence.ts';
import { truncate } from '../util.ts';
import type { ToolDefinition } from '../types.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

const VERIFIABLE = /^(commit|file|test|decision):/i;

function nextTodoID(todos: ContractTodo[]): string {
  let max = 0;
  for (const todo of todos) {
    const match = /^T(\d+)$/.exec(todo.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `T${max + 1}`;
}

function statusMark(todo: ContractTodo): string {
  if (todo.status === 'suspended') return todo.wakeWhen ? `挂起(等 ${todo.wakeWhen})` : '挂起';
  if (todo.status === 'blocked') return '阻塞';
  if (todo.status === 'doing') return '进行中';
  return 'open';
}

function blockerMark(todo: ContractTodo): string {
  if (todo.blockingOn === 'me') return '需要你';
  if (todo.blockingOn) return `等 ${todo.blockingOn}`;
  return '可执行';
}

function renderTodos(contract: ReturnType<typeof readContract>, now: number): string[] {
  const open = openTodos(contract);
  const closed = contract.todos.filter(todo => TODO_DONE_STATUSES.includes(todo.status));
  if (!open.length && !closed.length) {
    return ['[todo] 0 open（collab_todo { action:"add", subject:"…", confirm:true }）'];
  }
  const needsMe = open.filter(todo => todo.blockingOn === 'me').length;
  const waiting = open.filter(todo => todo.blockingOn && todo.blockingOn !== 'me').length;
  const oldest = [...open].sort((a, b) => a.since - b.since)[0];
  const sorted = [...open].sort(
    (a, b) =>
      (a.deferredUntil && a.deferredUntil > now ? 1 : 0) - (b.deferredUntil && b.deferredUntil > now ? 1 : 0) ||
      (a.blockingOn === 'me' ? 0 : 1) - (b.blockingOn === 'me' ? 0 : 1) ||
      a.since - b.since
  );
  const header =
    `[todo] ${open.length} open · ${needsMe} 需要你 · ${waiting} 等对方` +
    `${oldest ? ` · 最老 ${oldest.id} ${formatAge(now - oldest.since)}` : ''}`;
  const rows = sorted
    .slice(0, CONTRACT_TODO_LIST_MAX)
    .map(
      todo =>
        `  ${todo.id} [${todo.kind}] ${truncate(todo.subject, 100)} → ${statusMark(todo)} / ${blockerMark(todo)}` +
        `${todo.deferReason ? ` · ${truncate(todo.deferReason, 40)}` : ''}` +
        `${todo.deferredUntil && todo.deferredUntil > now ? `（推迟至 ${new Date(todo.deferredUntil).toISOString().slice(5, 16)}）` : ''}`
    );
  if (sorted.length > rows.length) rows.push(`  …还有 ${sorted.length - rows.length} 条（关闭几条再看）`);
  if (closed.length) {
    rows.push(`已关闭/放弃 ${closed.length} 条（history 保留在 ${contractFile(contract.sid)}）`);
  }
  rows.push(`契约文件: ${contractFile(contract.sid)}`);
  return [header, ...rows];
}

export function todoTool(kit: ToolKit): ToolDefinition {
  const { ctx } = kit.deps;

  return {
    name: 'collab_todo',
    description:
      'Manage the session contract’s todo list (0.9.1). `add` creates `T1`, `T2`, … (`blockingOn` = "me" or a ' +
      'session id; `status:"doing"` marks it in flight); `close` requires evidence (a verifiable `commit:` / ' +
      '`file:` / `test:` / `decision:` form is checked, free text is stored but never moves a milestone); `defer` ' +
      'keeps it open and pushes it down; `suspend` requires `wakeWhen` — without a wake condition the item is ' +
      'refused. The `[todo]` injection shows the count + top 3 every request; `[未收尾]` marks a `doing` todo that ' +
      'the previous request did not touch. `list` is read-only; every writing verb needs `confirm:true`.',
    input: jsonInput({
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'close', 'defer', 'suspend', 'list'],
          description: 'add / close / defer / suspend / list'
        },
        id: {
          type: 'string',
          description: '待办 id（`T1` / `T2` …）；close / defer / suspend 必填。'
        },
        subject: {
          type: 'string',
          description: `add 的标题（一件事一行，≤${CONTRACT_TODO_SUBJECT_LIMIT} 字）。`
        },
        kind: {
          type: 'string',
          enum: TODO_KINDS,
          description: 'mainline = 主线工作（默认）· collab = 协作文档里的等待项。'
        },
        blockingOn: {
          type: 'string',
          description: '阻塞方：`me`（需要你，默认）或 `ses_…`（等对方）。'
        },
        status: {
          type: 'string',
          enum: ['open', 'doing'],
          description: 'add 时的初始状态：open（默认）/ doing（进行中，下一轮若未更新会标 [未收尾]）。'
        },
        wakeWhen: {
          type: 'string',
          description: `suspend 必填：唤醒条件（≤${CONTRACT_WAKE_CHARS} 字），如「等 M2 点亮」「等 owner 回 D3」。`
        },
        evidence: {
          type: 'string',
          description: 'close 必填：`commit:<sha>` / `file:<path>:<line>` / `test:<path>` / `decision:<id>`，或一句可追溯的说明。'
        },
        reason: {
          type: 'string',
          description: 'defer / suspend 的原因（≤200 字，记录用）。'
        },
        until: {
          type: 'number',
          description: 'defer 的推迟到（epoch ms）；省略 = 仅排在列表末尾。'
        },
        confirm: {
          type: 'boolean',
          description: '写动作必须为 true；false / 省略只预览。list 不需要。'
        }
      },
      required: ['action']
    }),

    async execute(input, context) {
      const action = String(input?.action ?? '').trim();
      const sid = String(context?.sessionID ?? '').trim();
      if (!sid) throw invalid('缺少会话上下文（sessionID）：待办是会话级的');
      const now = Date.now();
      const contract = readContract(sid);
      const directory = ctx?.location?.directory;

      if (action === 'list') {
        return { content: renderTodos(contract, now).join('\n') };
      }
      if (!['add', 'close', 'defer', 'suspend'].includes(action)) {
        throw invalid('action 必须是 add | close | defer | suspend | list');
      }

      if (action === 'add') {
        const subject = truncate(input?.subject, CONTRACT_TODO_SUBJECT_LIMIT);
        if (!subject) throw invalid('add 需要 subject（一件事一行）');
        const open = openTodos(contract);
        if (open.length >= CONTRACT_TODO_LIMIT) {
          throw invalid(`open 待办已达上限 ${CONTRACT_TODO_LIMIT} 条：先关闭几条，列表不能无限增长`);
        }
        const kind = TODO_KINDS.includes(String(input?.kind ?? '') as TodoKind)
          ? (String(input?.kind) as TodoKind)
          : 'mainline';
        const blocking = String(input?.blockingOn ?? 'me').trim() || 'me';
        if (blocking !== 'me' && !blocking.startsWith('ses_')) {
          throw invalid('blockingOn 必须是 "me" 或一个 ses_… 会话 id');
        }
        const status: TodoStatus = String(input?.status ?? '') === 'doing' ? 'doing' : 'open';
        if (input?.confirm !== true) {
          return {
            content: [
              '未执行（confirm 不为 true，仅预览）。将新增待办:',
              `${truncate(subject, 100)}  kind=${kind}  blockingOn=${blocking}  status=${status}`,
              `契约文件: ${contractFile(sid)}`,
              '确认后在同样参数下传 confirm:true。'
            ].join('\n')
          };
        }
        const id = nextTodoID(contract.todos);
        const todo: ContractTodo = {
          id,
          kind,
          subject,
          status,
          blockingOn: blocking,
          since: now,
          updatedAt: now
        };
        const written = await updateContract(sid, latest => ({ ...latest, todos: [...latest.todos, todo] }));
        return { content: [`已新增待办 ${id}`, ...renderTodos(written, now)].join('\n') };
      }

      const id = String(input?.id ?? '').trim();
      if (!id) throw invalid(`${action} 需要 id（如 T2）`);
      const target = contract.todos.find(todo => todo.id === id);
      if (!target) {
        throw invalid(
          `没有待办 ${id}：现有 ${contract.todos.map(todo => todo.id).join(' / ') || '（空）'}；` +
            '用 collab_todo { action:"list" } 查看'
        );
      }

      if (action === 'close') {
        const evidence = String(input?.evidence ?? '').trim();
        if (!evidence) throw invalid('close 必填 evidence：没有证据的关闭 = 待办凭空消失');
        if (input?.confirm !== true) {
          return {
            content: [
              `未执行（confirm 不为 true，仅预览）。将关闭 ${id}:`,
              `subject: ${target.subject}`,
              `evidence: ${evidence}${VERIFIABLE.test(evidence) ? '（会先校验）' : '（自由文本：记录但不作为可校验证据）'}`,
              '确认后在同样参数下传 confirm:true。'
            ].join('\n')
          };
        }
        let line = `已关闭 ${id}`;
        if (VERIFIABLE.test(evidence)) {
          const check = checkEvidence(evidence, { directory, now });
          if (!check.ok) throw invalid(`evidence 校验失败：${check.reason}`);
          line += `（evidence 已校验：${check.reason}）`;
        } else {
          line += '（自由文本 evidence：已记录，但不推进里程碑）';
        }
        const written = await updateContract(sid, latest => ({
          ...latest,
          todos: latest.todos.map(todo =>
            todo.id === id
              ? { ...todo, status: 'closed' as TodoStatus, closedAt: now, evidence, updatedAt: now }
              : todo
          ),
          // A closed mainline todo is mainline progress (0.9.3's drift baseline).
          turn:
            target.kind === 'mainline'
              ? { ...latest.turn, lastAdvancedAt: now, noAdvanceTurns: 0 }
              : latest.turn
        }));
        return { content: [line, ...renderTodos(written, now)].join('\n') };
      }

      if (action === 'suspend') {
        const wakeWhen = truncate(input?.wakeWhen, CONTRACT_WAKE_CHARS);
        if (!wakeWhen) {
          throw invalid(
            'suspend 必填 wakeWhen：没有唤醒条件的挂起 = 工作永久消失（例：「等 M2 点亮」「等 owner 回 D3」）'
          );
        }
        if (input?.confirm !== true) {
          return {
            content: [
              `未执行（confirm 不为 true，仅预览）。将挂起 ${id}:`,
              `subject: ${target.subject}`,
              `wakeWhen: ${wakeWhen}`,
              '确认后在同样参数下传 confirm:true。'
            ].join('\n')
          };
        }
        const written = await updateContract(sid, latest => ({
          ...latest,
          todos: latest.todos.map(todo =>
            todo.id === id
              ? {
                  ...todo,
                  status: 'suspended' as TodoStatus,
                  wakeWhen,
                  parkedBy: sid,
                  parkedAt: now,
                  updatedAt: now
                }
              : todo
          )
        }));
        return { content: [`已挂起 ${id}（等 ${wakeWhen}）`, ...renderTodos(written, now)].join('\n') };
      }

      // defer
      if (target.status === 'suspended') {
        throw invalid(`${id} 已挂起（等 ${target.wakeWhen ?? '?'}）：先恢复或 close，不要再用 defer 重复推迟`);
      }
      if (input?.confirm !== true) {
        return {
          content: [
            `未执行（confirm 不为 true，仅预览）。将推迟 ${id}:`,
            `subject: ${target.subject}`,
            '确认后在同样参数下传 confirm:true。'
          ].join('\n')
        };
      }
      const untilRaw = Number(input?.until);
      const until = Number.isFinite(untilRaw) && untilRaw > now ? untilRaw : null;
      const reason = truncate(input?.reason, 200);
      const written = await updateContract(sid, latest => ({
        ...latest,
        todos: latest.todos.map(todo =>
          todo.id === id
            ? {
                ...todo,
                deferredUntil: until,
                deferReason: reason || null,
                parkedBy: sid,
                parkedAt: now,
                updatedAt: now
              }
            : todo
        )
      }));
      return {
        content: [
          `已推迟 ${id}${until ? `（至 ${new Date(until).toISOString()}）` : '（排在列表末尾）'}${reason ? `：${reason}` : ''}`,
          ...renderTodos(written, now)
        ].join('\n')
      };
    }
  };
}
