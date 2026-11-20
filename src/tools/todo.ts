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
  CONTRACT_TODO_LIST_MAX,
  CONTRACT_TODO_MAX_OPEN,
  CONTRACT_TODO_SUBJECT_LIMIT,
  CONTRACT_WAKE_CHARS
} from '../constants.ts';
import {
  TODO_KINDS,
  TODO_DONE_STATUSES,
  contractFile,
  formatAge,
  nextTodoSeq,
  openTodos,
  readContract,
  updateContract
} from '../core/contract.ts';
import type { ContractTodo, TodoKind, TodoStatus } from '../core/contract.ts';
import { InvariantError, invalid } from '../core/errors.ts';
import { checkEvidence } from '../core/evidence.ts';
import { workspaceOf } from '../core/facts.ts';
import { parseWakeWhen, wakePhrase } from '../core/wake.ts';
import { truncate } from '../util.ts';
import type { ToolDefinition } from '../types.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

const VERIFIABLE = /^(commit|file|test|decision):/i;

function statusMark(todo: ContractTodo): string {
  if (todo.status === 'suspended') return todo.wakeWhen ? `挂起(${wakePhrase(todo.wakeWhen)})` : '挂起';
  if (todo.status === 'drifted') return '挂起到期（未醒）';
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
        `${todo.deferredUntil && todo.deferredUntil > now ? `（推迟至 ${new Date(todo.deferredUntil).toISOString().slice(5, 16)}）` : ''}` +
        `${todo.ref?.factId ? ` · 依据 ${todo.ref.factId}` : ''}` +
        `${todo.staleWork ? ' ⚠失效' : ''}`
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
      'Manage the session contract’s todo list (0.9.1; 0.9.3 wake conditions). `add` creates `T1`, `T2`, … ' +
      '(`blockingOn` = "me" or a session id; `status:"doing"` marks it in flight); `close` requires evidence (a ' +
      'verifiable `commit:` / `file:` / `test:` / `decision:` form is checked, free text is stored but never moves a ' +
      'milestone); `defer` keeps it open and pushes it down; `suspend` requires `wakeWhen` — either an object ' +
      '`{kind:"reply"|"decision"|"time"|"manual", ref?|at?}` or legacy free text, and without one the item is ' +
      'refused (a park with no wake condition is how work disappears). A `time` deadline must be in the future; a ' +
      'suspended item whose wake condition expired (or that stayed parked 24h) is marked `drifted` by the context ' +
      'hook — never auto-closed. The `[todo]` injection shows the count + top 3 every request; `[未收尾]` marks a ' +
      '`doing` todo that the previous request did not touch. `list` is read-only; every writing verb needs ' +
      '`confirm:true`.',
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
          type: ['string', 'object'],
          description:
            `suspend 必填：结构化唤醒条件 {kind:"reply",ref:"ses_…"} / {kind:"decision",ref:"D3"} / ` +
            `{kind:"time",at:<epoch ms>} / {kind:"manual"}，或一句自由文本（≤${CONTRACT_WAKE_CHARS} 字，按 manual 处理）。` +
            'manual 只是「不因 reply/decision/time 自动醒」，仍受 24h 兜底：到期未醒会转 drifted 并进 [drift]。'
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
        factId: {
          type: 'string',
          description:
            'add 可选：这条待办据以成立的事实（`F3`）。事实被 retract / invalidate 后，该待办保留但在注入里标 `⚠失效`（0.9.4）。'
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
        const kind = TODO_KINDS.includes(String(input?.kind ?? '') as TodoKind)
          ? (String(input?.kind) as TodoKind)
          : 'mainline';
        const blocking = String(input?.blockingOn ?? 'me').trim() || 'me';
        if (blocking !== 'me' && !blocking.startsWith('ses_')) {
          throw invalid('blockingOn 必须是 "me" 或一个 ses_… 会话 id');
        }
        const status: TodoStatus = String(input?.status ?? '') === 'doing' ? 'doing' : 'open';
        const factRef = String(input?.factId ?? '').trim();
        if (factRef && !/^F\d+$/.test(factRef)) throw invalid(`factId="${factRef}" 不合法（期望 F3 这样的 id）`);
        if (input?.confirm !== true) {
          return {
            content: [
              '未执行（confirm 不为 true，仅预览）。将新增待办:',
              `${truncate(subject, 100)}  kind=${kind}  blockingOn=${blocking}  status=${status}${factRef ? `  fact=${factRef}` : ''}`,
              `契约文件: ${contractFile(sid)}`,
              '确认后在同样参数下传 confirm:true。'
            ].join('\n')
          };
        }
        // The id and the cap are computed **inside** the serialised mutate:
        // `Promise.all(3 × add)` used to read the same pre-call list and append
        // three `T1`s. `updateContract` re-reads the latest file per call, so the
        // id is unique by construction.
        let newID = '';
        const written = await updateContract(sid, latest => {
          const open = openTodos(latest);
          if (open.length >= CONTRACT_TODO_MAX_OPEN) {
            throw invalid(`open 待办已达上限 ${CONTRACT_TODO_MAX_OPEN} 条：先关闭几条，列表不能无限增长`);
          }
          const seq = nextTodoSeq(latest);
          newID = `T${seq}`;
          const todo: ContractTodo = {
            id: newID,
            kind,
            subject,
            status,
            blockingOn: blocking,
            since: now,
            updatedAt: now,
            ...(factRef ? { ref: { factId: factRef, workspace: workspaceOf(ctx) } } : {})
          };
          // `todoSeq` is monotonic across closed-history trimming: an id is
          // never issued twice, even after the row itself is gone.
          return { ...latest, todoSeq: seq, todos: [...latest.todos, todo] };
        });
        // `writeContract` returns the normalised (reader-visible) value, so this
        // check fails loudly if a future retention change drops the new row —
        // no "成功但读不到" and no silent overwrite on the next add.
        if (!written.todos.some(todo => todo.id === newID)) {
          throw new InvariantError(`新增待办 ${newID} 写后不可读：读侧丢弃了刚写入的行（拒绝静默丢数据）`);
        }
        return { content: [`已新增待办 ${newID}`, ...renderTodos(written, now)].join('\n') };
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
        const parsed = parseWakeWhen(input?.wakeWhen, now);
        if (!parsed.ok) {
          throw invalid(
            `suspend 必填 wakeWhen：没有唤醒条件的挂起 = 工作永久消失（${parsed.error}）。` +
              '例：{kind:"manual"} / {kind:"reply",ref:"ses_…"} / {kind:"time",at:<未来的 epoch ms>}'
          );
        }
        const wake = parsed.wake;
        if (input?.confirm !== true) {
          return {
            content: [
              `未执行（confirm 不为 true，仅预览）。将挂起 ${id}:`,
              `subject: ${target.subject}`,
              `wakeWhen: ${typeof wake === 'string' ? wake : JSON.stringify(wake)}`,
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
                  wakeWhen: wake,
                  parkedBy: sid,
                  parkedAt: now,
                  updatedAt: now
                }
              : todo
          )
        }));
        return { content: [`已挂起 ${id}（${wakePhrase(wake)}）`, ...renderTodos(written, now)].join('\n') };
      }

      // defer
      if (target.status === 'suspended') {
        throw invalid(`${id} 已挂起（${wakePhrase(target.wakeWhen)}）：先恢复或 close，不要再用 defer 重复推迟`);
      }
      if (target.status === 'drifted') {
        throw invalid(
          `${id} 的 wakeWhen 已过期（挂起到期）：先 collab_mission { action:"resume", next:"…" } 重新评估，` +
            '或 close / 重新 suspend，不要用 defer'
        );
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
