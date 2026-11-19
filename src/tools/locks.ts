import { LOCK_DIR, LOCK_TTL_MAX_MS, LOCK_TTL_MIN_MS } from '../constants.ts';
import { invalid } from '../core/errors.ts';
import {
  acquire,
  allLocks,
  describeState,
  emptyLock,
  fmtTtl,
  lockFile,
  normalizeResource,
  normalizeTtl,
  readLock,
  release,
  sanitizeReason,
  stateOf,
  touchWaiters
} from '../core/locks.ts';
import type { LockKind, LockState, ToolDefinition } from '../types.ts';
import { fmtTime, truncate } from '../util.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/** Resolve `resource` + `mode` once, for all three tools. */
function resolve(kit: ToolKit, raw: unknown): { resource: string; kind: LockKind } {
  const workspace = kit.deps.ctx?.location?.directory;
  const check = normalizeResource(raw, workspace);
  if (!check.ok) throw invalid(`资源名无法规范化：${check.reason}`);
  return { resource: check.resource, kind: check.kind };
}

/** `exclusive|shared`, default `exclusive`; anything else is a caller mistake. */
function resolveMode(raw: unknown): 'exclusive' | 'shared' {
  const mode = String(raw ?? '').trim() || 'exclusive';
  if (mode !== 'exclusive' && mode !== 'shared') {
    throw invalid(`mode 只能是 exclusive 或 shared（收到 "${mode}"）`);
  }
  return mode;
}

/** `ttl=15m（默认）` / `ttl=2h（已按上限收敛）` — shows clamping instead of hiding it. */
function ttlLine(raw: unknown): { ttlMs: number; note: string } {
  const ttlMs = normalizeTtl(raw);
  if (raw === undefined || raw === null || raw === '') return { ttlMs, note: '默认' };
  const asked = Number(raw);
  if (!Number.isFinite(asked) || asked <= 0) return { ttlMs, note: '非法值，按默认' };
  if (asked < LOCK_TTL_MIN_MS) return { ttlMs, note: '已按下限 10s 收敛' };
  if (asked > LOCK_TTL_MAX_MS) return { ttlMs, note: '已按上限 2h 收敛' };
  return { ttlMs, note: '' };
}

/** `holders=ses_a,ses_b` / `holders=-`. */
function holderLine(state: LockState, protect: string[] = []): string {
  if (!state.holders.length) return 'holders=-';
  return `holders=${state.holders.map(sid => (protect.includes(sid) ? `${sid}[protected]` : sid)).join(',')}`;
}

/**
 * `waiters=ses_a#1:exclusive(12m),ses_b#2:exclusive(3s)[stale]` — display only.
 *
 * 0.6.0 (R3): the age is the time since that waiter's **last heartbeat** — the
 * number that tells a human whether the queue is real. `[stale]` marks a
 * heartbeat older than `waiterTtlMs`: it is still shown (a read command never
 * writes) and is reaped by the next `collab_lock`. A long queue is cut to the
 * head plus a `+(N)` count so one listing line stays readable; the record itself
 * always keeps every waiter.
 */
function queueLine(state: LockState): string {
  if (!state.waiters.length) return 'waiters=-';
  const shown = 8;
  const head = state.waiters
    .slice(0, shown)
    .map((waiter, index) => {
      const age = fmtTtl(state.waiterAgeMs?.[index] ?? 0);
      const stale = state.staleWaiters?.includes(waiter.sid) ? '[stale]' : '';
      return `${waiter.sid}#${waiter.position}:${waiter.mode}(${age})${stale}`;
    })
    .join(',');
  const more = state.waiters.length - shown;
  return `waiters=${head}${more > 0 ? `,…(+${more})` : ''}`;
}

function stateLines(state: LockState, protect: string[] = []): string[] {
  return [
    `资源: ${state.resource}  kind=${state.kind}`,
    `当前: ${describeState(state, protect)}`,
    `  ${holderLine(state, protect)}  ${queueLine(state)}  ttl=${state.ttlMs ? fmtTtl(state.ttlMs) : '-'}`
  ];
}

/**
 * `collab_lock` — take (or queue for) a resource lease.
 *
 * `exclusive` (default) excludes every other mode; `shared` coexists with
 * `shared` only. A held resource answers with its holders and remaining TTL;
 * `wait:true` appends this session to the FIFO queue instead. The lock is pure
 * local state: nothing is delivered, nobody is interrupted. `confirm:true` is
 * required — otherwise the tool only previews the current state and the record
 * it would write.
 */
export function lockTool(kit: ToolKit): ToolDefinition {
  const { deps } = kit;
  const { ctx, readConfig } = deps;

  return {
    name: 'collab_lock',
    description:
      'Take a resource lease (same-workspace coordination: test window, one file/module, full build, a port). ' +
      'Resources are normalised — `test-window` / `窗口` / `测试窗口` are one resource, `file:packages/x/store.ts` ' +
      'and `packages/x/store.ts` are one file; `file:` must be inside the workspace (no `..`, no absolute path, ' +
      'no symlink). mode `exclusive` (default) excludes any other holder; `shared` coexists with other shared ' +
      'leases and excludes exclusive ones. ttlMs default 15 min, clamped to [10s, 2h]; an expired lease is ' +
      'reclaimed on the next access, no manual cleanup. Idempotent per (session, resource). If the resource is ' +
      'held: without `wait` it returns the holders + remaining TTL; with `wait:true` it queues you (FIFO) and ' +
      'returns your position — nobody is woken, re-check with collab_locks / collab_list. The queue is capped at ' +
      '50 waiters: a full queue refuses a new applicant (readably) instead of dropping the head. Requires ' +
      'confirm:true; otherwise it only previews. Leases never deliver messages and never preempt a holder.',
    input: jsonInput({
      properties: {
        resource: {
          type: 'string',
          description:
            'Resource name: `test-window` / `窗口` / `build` (named), or `file:packages/x/store.ts` (workspace-relative).'
        },
        mode: {
          type: 'string',
          enum: ['exclusive', 'shared'],
          description: 'exclusive (default) or shared (read-only group).'
        },
        ttlMs: {
          type: 'number',
          description: 'Lease length in ms (default 900000 = 15 min, clamped to 10000..7200000).'
        },
        reason: { type: 'string', description: 'One line shown to the other sessions (≤200 chars).' },
        wait: {
          type: 'boolean',
          description:
            'When the resource is held: queue instead of failing immediately (FIFO, max 50 waiters — a full queue refuses newcomers, never evicts the head).'
        },
        confirm: { type: 'boolean', description: 'Must be true to write the lease. Otherwise only previews.' }
      },
      required: ['resource', 'confirm']
    }),
    async execute(input, context) {
      const config = readConfig();
      const sid = context?.sessionID;
      if (!sid) throw invalid('无法确定当前会话 ID（sessionID 缺失）');
      const { resource, kind } = resolve(kit, input?.resource);
      const mode = resolveMode(input?.mode);
      const { ttlMs, note } = ttlLine(input?.ttlMs);
      const reason = sanitizeReason(input?.reason);
      const wait = input?.wait === true;
      const now = Date.now();
      const existing = readLock(resource);
      const state = stateOf(existing ?? emptyLock(resource, kind, mode), now, sid, {
        waiterTtlMs: config.waiterTtlMs
      });

      if (input?.confirm !== true) {
        return {
          content: [
            '未加锁（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。',
            ...stateLines(state, config.protect),
            `将要申请: mode=${mode}  ttl=${fmtTtl(ttlMs)}${note ? `（${note}）` : ''}  wait=${wait}` +
              `${reason ? `  reason="${truncate(reason, 60)}"` : ''}`,
            `记录: ${lockFile(resource)}`,
            state.free
              ? state.waiters.length
                ? state.staleWaiters?.length === state.waiters.length
                  ? `资源空闲，${state.waiters.length} 个排队者的心跳都已超过等待 TTL → 确认时会先回收它们，然后直接获得。`
                  : `资源空闲但已有 ${state.waiters.length} 人在排队（下一位 ${state.waiters[0]?.sid}）→ 确认后会排在队尾，不插队。` +
                    (state.staleWaiters?.length
                      ? ` 其中 ${state.staleWaiters.length} 人最后一次心跳已超过等待 TTL，确认时会先回收（不再挡路）。`
                      : '')
                : '资源空闲 → 确认后立即获得。'
              : `资源被占用 → 未传 wait:true 时只会返回「持有者 + 剩余 TTL」；传 wait:true 则进入排队。`
          ].join('\n')
        };
      }

      // R2 (0.6.0): re-applying is itself a heartbeat — a session that polls
      // `collab_lock` while queued must not be reaped. Throttled inside (30s),
      // and only after the preview branch: a preview writes nothing.
      await touchWaiters(sid, now);

      const result = await acquire({
        resource,
        kind,
        mode,
        ttlMs,
        waiterTtlMs: config.waiterTtlMs,
        reason,
        wait,
        sid,
        now
      });

      if (result.status === 'held') {
        const renewed = result.renewed;
        // `mode` is the record's, not the request's: an idempotent re-apply
        // never silently upgrades (or downgrades) an existing lease.
        const actualMode = result.state.mode;
        return {
          content: [
            renewed
              ? `已持有该资源（幂等申请，未重复计数）: ${resource}`
              : `已获得资源租约: ${resource}`,
            `mode=${actualMode}  holder=${sid}  剩余=${fmtTtl(result.state.expiresIn)}  到期=${fmtTime(result.state.expiresAt)}` +
              `  ttl=${fmtTtl(result.state.ttlMs)}${note ? `（${note}）` : ''}` +
              `${reason ? `  reason="${truncate(reason, 60)}"` : ''}`,
            ...(renewed && mode !== actualMode
              ? [`本次请求 mode=${mode} 与既有租约 mode=${actualMode} 不同 → 既有租约保持不变；换模式请先 collab_unlock。`]
              : []),
            ...(actualMode === 'shared' && result.state.holders.length > 1
              ? [`shared 组: ${result.state.holders.join(', ')}`]
              : []),
            `释放: collab_unlock { resource:"${resource}", confirm:true }`,
            '锁只用于自愿协调：它不投递消息、不打断任何会话；到期自动回收。'
          ].join('\n')
        };
      }

      if (result.status === 'queued') {
        return {
          content: [
            `已进入排队: ${resource}  排第 ${result.ahead} 位`,
            ...stateLines(result.state, config.protect),
            '不会有人主动叫醒你：当前持有者释放或租约到期后，再次 collab_lock 即按 FIFO 获得（前面的人先得）。',
            `查看: collab_locks { resource:"${resource}" }`
          ].join('\n')
        };
      }

      if (result.status === 'queue-full') {
        // A full queue refuses the newcomer — it never evicts the head (R-1).
        return {
          content: [
            `未进入排队: ${resource}（等待队列已满 ${result.limit}）`,
            ...stateLines(result.state, config.protect),
            `队列已满：不会丢弃任何已在排队的人（队首 ${result.state.waiters[0]?.sid} 保留第 1 位）。`,
            '可选: 稍后重试 / 先做无冲突部分 / 换一个资源名；持有者释放后队列会继续按 FIFO 消化。'
          ].join('\n')
        };
      }

      // busy: the answer the PRD asks for — who holds it, and for how much longer.
      if (!result.holders.length) {
        // Free but somebody is queued ahead: FIFO is never skipped.
        return {
          content: [
            `未获得资源租约: ${resource}（资源空闲，但有人在排队）`,
            ...stateLines(result.state, config.protect),
            `排队顺序: ${result.state.waiters.map(waiter => `${waiter.position}.${waiter.sid}`).join(' → ')}`,
            '不插队：传 wait:true 会排在队尾；等前面的人拿到 / 放弃后再申请。'
          ].join('\n')
        };
      }
      const holderProtected = result.holders.some(holder => config.protect.includes(holder));
      return {
        content: [
          `未获得资源租约: ${resource}（被占用）`,
          ...stateLines(result.state, config.protect),
          `持有者 ${result.holders.join(', ')} 剩余 ${fmtTtl(result.remainingMs)} 后到期` +
            `${holderProtected ? '（受保护会话持有，不可抢占，只能等或换资源）' : ''}`,
          '可选: 传 wait:true 排队 / 先做无冲突部分 / 换一个资源名。抢占需人工，工具不提供 force。'
        ].join('\n')
      };
    }
  };
}

/**
 * `collab_unlock` — release what this session holds.
 *
 * Only the holder may release. A `shared` group loses just this session's
 * entry. There is deliberately **no** `force`: preemption is a human decision
 * (design §6), and a `[protected*]` holder can never be displaced by a tool.
 */
export function unlockTool(kit: ToolKit): ToolDefinition {
  const { deps } = kit;
  const { readConfig } = deps;

  return {
    name: 'collab_unlock',
    description:
      'Release a resource lease this session holds. Only the holder may release; a `shared` group drops just ' +
      'this session and keeps the other holders. Refuses (readably) when the resource is free or held by ' +
      'someone else — there is no `force`: preemption requires a human, and a [protected] holder is never ' +
      'displaced. Requires confirm:true; otherwise it only previews the current lease.',
    input: jsonInput({
      properties: {
        resource: { type: 'string', description: 'The same resource name used for collab_lock.' },
        confirm: { type: 'boolean', description: 'Must be true to release. Otherwise only previews.' }
      },
      required: ['resource', 'confirm']
    }),
    async execute(input, context) {
      const config = readConfig();
      const sid = context?.sessionID;
      if (!sid) throw invalid('无法确定当前会话 ID（sessionID 缺失）');
      const { resource, kind } = resolve(kit, input?.resource);
      const now = Date.now();
      const state = stateOf(readLock(resource) ?? emptyLock(resource, kind), now, sid, {
        waiterTtlMs: config.waiterTtlMs
      });

      if (input?.confirm !== true) {
        return {
          content: [
            '未释放（confirm 不为 true，仅预览）。确认后在同样参数下传 confirm:true。',
            ...stateLines(state, config.protect),
            state.free
              ? '资源当前 free → 确认后会报「本来就是 free」。'
              : state.mine?.held
                ? `确认后会释放你的租约${state.mode === 'shared' && state.holders.length > 1 ? '（shared 组里其他人保留）' : ''}。`
                : '你不是持有者 → 确认后会拒绝（只有持有者能释放；不提供 force 抢占）。'
          ].join('\n')
        };
      }

      const result = await release({ resource, sid, now, waiterTtlMs: config.waiterTtlMs });
      if (!result.ok) {
        if (result.reason === 'free') {
          return {
            content: [
              `无需释放: ${resource} 当前 free`,
              ...stateLines(result.state, config.protect)
            ].join('\n')
          };
        }
        return {
          content: [
            `未释放: ${resource} 不是你持有的资源`,
            ...stateLines(result.state, config.protect),
            '只有持有者能释放；抢占需人工裁决（工具不提供 force）。',
            `查看: collab_locks { resource:"${resource}" }`
          ].join('\n')
        };
      }

      return {
        content: [
          `已释放资源租约: ${resource}`,
          result.remaining.length
            ? `shared 组仍由 ${result.remaining.join(', ')} 持有（剩余 ${fmtTtl(result.state.expiresIn)}）。`
            : result.state.waiters.length
              ? `资源已 free；排队 ${result.state.waiters.length} 人，按 FIFO 依次获得（不会主动叫醒，需自行再次 collab_lock）。`
              : '资源已 free。',
          '锁不投递消息；如果对端在等，仍建议自己发一句话说明已释放。'
        ].join('\n')
      };
    }
  };
}

/**
 * `collab_locks` — the read layer (R5).
 *
 * Read-only by construction: it renders `stateOf` without writing, reaping or
 * waking anyone. `collab_list` reuses the same view for the caller's own leases,
 * and the sidebar task consumes `stateOf` directly.
 */
export function locksTool(kit: ToolKit): ToolDefinition {
  const { deps } = kit;
  const { readConfig } = deps;

  return {
    name: 'collab_locks',
    description:
      'List resource leases: resource (named:/file:), free|held, mode, holders (with remaining TTL), and the ' +
      'FIFO queue with each waiter\'s age since its last heartbeat (`sid#pos:mode(age)`, `[stale]` when older ' +
      'than the waiter TTL — a stale waiter holds nothing and is reaped by the next collab_lock). Read-only — ' +
      'this command never writes, never reaps and never wakes a waiter; an expired lease is simply shown as free ' +
      '(reclaimed on the next collab_lock). `resource` narrows the answer to one resource (normalised the same ' +
      'way); omit it for every lease in the global lock directory. ' +
      '`collab_list` additionally shows your own holdings / queue position.',
    input: jsonInput({
      properties: {
        resource: { type: 'string', description: 'Only this resource (normalised like collab_lock). Omit for all.' }
      },
      required: []
    }),
    async execute(input, context) {
      const config = readConfig();
      const sid = context?.sessionID;
      const now = Date.now();
      const raw = String(input?.resource ?? '').trim();

      if (raw) {
        const { resource, kind } = resolve(kit, raw);
        const state = stateOf(readLock(resource) ?? emptyLock(resource, kind), now, sid, {
          waiterTtlMs: config.waiterTtlMs
        });
        return { content: formatLocks([state], config.protect, sid) };
      }

      const states = allLocks().map(record => stateOf(record, now, sid, { waiterTtlMs: config.waiterTtlMs }));
      if (!states.length) {
        return {
          content: `没有资源租约（目录 ${LOCK_DIR}）。可用: collab_lock { resource:"test-window", confirm:true }`
        };
      }
      return { content: formatLocks(states, config.protect, sid) };
    }
  };
}

/** Shared renderer: one line per resource + a closing hint. */
function formatLocks(states: LockState[], protect: string[], sid: string | undefined): string {
  const lines = states.map(state => {
    const status = state.free ? 'free' : 'held';
    const mine = state.mine?.held ? '  ← 我持有' : state.mine?.waiting ? `  ← 我排第 ${state.mine.position}` : '';
    return (
      `- ${state.resource}  ${status}  mode=${state.mode}  ${holderLine(state, protect)}  ` +
      `剩余=${state.free ? '-' : fmtTtl(state.expiresIn)}  ttl=${state.ttlMs ? fmtTtl(state.ttlMs) : '-'}  ` +
      `${queueLine(state)}${state.reason ? `  reason="${truncate(state.reason, 60)}"` : ''}${mine}`
    );
  });
  const held = states.filter(state => !state.free).length;
  const waiting = states.reduce((count, state) => count + state.waiters.length, 0);
  const stale = states.reduce((count, state) => count + (state.staleWaiters?.length ?? 0), 0);
  return [
    `资源租约 ${states.length} 个（持有=${held} 排队=${waiting} free=${states.length - held}` +
      `${stale ? `，其中排队心跳过期 ${stale} 人` : ''}）:`,
    ...lines,
    '读命令：不改状态、不回收、不叫醒排队者；过期租约 / 过期排队心跳在下一次 collab_lock 时回收。',
    sid ? `释放: collab_unlock { resource:"<资源名>", confirm:true }` : ''
  ]
    .filter(Boolean)
    .join('\n');
}
