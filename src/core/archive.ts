/**
 * 0.5.0 (R1–R7): **archive — never delete — the sessions this plugin spawned**
 * for a hand-off, once nobody needs them any more.
 *
 * A bootstrap (`claim.kind = "spawn"`) session exists for exactly one bid. After
 * the bid is `done` / `blocked` / `expired` and nobody references it, it keeps
 * showing up in `collab_list` / the sidebar forever. The owner's decision is
 * *archive*: `PATCH /api/session/{sid} { archived:true }` hides the session
 * from the list while keeping the session and every message, and
 * `archived:false` brings it back. This path never calls `DELETE` (the only
 * `DELETE`s in the plugin are `selftest` cleanup and the spawn rollback).
 *
 * Two layers, deliberately separated so the decision is testable without a
 * host:
 *
 *   - `shouldArchive(record, now, gate)` — a pure, ordered gate (design §1).
 *     Every reason string is a *refusal*, so the caller can log why nothing
 *     happened instead of silently doing nothing;
 *   - `archiveSession(ctx, sid, archived)` — the one write. Host
 *     `ctx.session.update` first, `PATCH /api/session/{id}` (COLLAB_SERVER_URL +
 *     COLLAB_SERVER_TOKEN) only when the host has no `update`. Never throws: a
 *     403 / 404 / missing host is a readable result, because an archive must
 *     never break the tool call or the hand-off that triggered it (R3).
 *
 * Triggers live in `chain.refresh()` (design §3): the requester's `context`
 * refresh is the same place the lease / auto-receipt logic runs, so there is no
 * timer, no background loop and no write from a read-only listing.
 */
import {
  ARCHIVE_GRACE_MAX_MS,
  ARCHIVE_GRACE_MS,
  ARCHIVE_GRACE_MIN_MS,
  BCAST_DONE_STATES,
  SERVER_TOKEN,
  SERVER_URL
} from '../constants.ts';
import { errText, log } from '../log.ts';
import type { BroadcastRecord, CollabConfig, CollabContext, SessionInfoLike } from '../types.ts';
import { asObject, clamp, sessionState, truncate } from '../util.ts';
import { allBroadcasts, mergeArchive } from './claim.ts';
import { createLineage } from './lineage.ts';
import { unseenCandidates } from './owner-queue.ts';

export type ArchiveDecision =
  | { archive: true; sessionID: string }
  | { archive: false; reason: string };

/**
 * Everything `shouldArchive` needs from the outside world. Injected rather than
 * imported, so the eight rules are unit-testable without a host / real files
 * (`chain.ts` binds the real readers).
 */
export interface ArchiveGate {
  /** The `session.update` / HTTP writer. */
  ctx: CollabContext;
  /** Lazily re-read `collab.json` (`archiveSpawned` / `archiveGraceMs`). */
  readConfig(): CollabConfig;
  /** Fresh `ctx.session.get`; `undefined` when the session cannot be read. */
  sessionInfo(sessionID: string): Promise<SessionInfoLike | undefined>;
  /** Protected lineage guard (`[protected]` / `[protected-child]`). */
  isProtected(sessionID: string): Promise<boolean>;
  /** Every hand-off record on disk (`allBroadcasts`). */
  records(): BroadcastRecord[];
  /** Unread owner-queue items of one session (`unseenCandidates`). */
  unseen(sessionID: string): Array<{ id: string }>;
}

export interface ArchiveWriteResult {
  ok: boolean;
  /** What was asked for (`true` = archive, `false` = restore). */
  archived: boolean;
  /** `session.update` / `http` — only on success. */
  via?: string;
  /** Readable failure reason. Never a thrown error. */
  reason?: string;
}

/**
 * The session this record pulled in and may still owe an archive to.
 *
 * Two shapes are both "we spawned it":
 *   - the normal one: `claim.kind === 'spawn'` → `claim.by`;
 *   - the spawned session's lease lapsed **before** anybody accepted, then the
 *     reopened hand-off was taken by a human: `refreshBroadcast` rewrites
 *     `claim.kind` to `accept` (`claim.ts`), but the spawn trace survives in
 *     `expiredClaim`. The hand-off now belongs to somebody else; the session we
 *     pulled is still ours and still orphaned — without this fallback it would
 *     never be archived.
 *
 * `claim.spawner` is deliberately not a candidate: it is the *requester* that
 * pulled the session (a human's own session, R1), never archived by this feature.
 */
export function spawnedSessionID(record: BroadcastRecord): string {
  const claim = record.claim ?? {};
  if (claim.kind === 'spawn') return String(claim.by ?? '').trim();
  const expired = asObject(record.expiredClaim);
  if (expired.kind === 'spawn') return String(expired.by ?? '').trim();
  return '';
}

/**
 * The eight conditions of design §1, in order. The first one that fails wins, so
 * the cheap checks (spawn / terminal / grace / stamp) run **before** any I/O.
 */
export async function shouldArchive(
  record: BroadcastRecord | undefined,
  now: number,
  gate: ArchiveGate
): Promise<ArchiveDecision> {
  const config = gate.readConfig();
  if (config.archiveSpawned === false) {
    return { archive: false, reason: 'archiveSpawned=false（自动归档已关闭）' };
  }
  if (!record) return { archive: false, reason: '记录不存在' };
  const sessionID = spawnedSessionID(record);
  if (!sessionID) {
    return { archive: false, reason: `不是本插件拉起的会话（claim.kind=${String(record.claim?.kind)}）` };
  }
  if (!BCAST_DONE_STATES.includes(String(record.state))) {
    return { archive: false, reason: `未到终态（state=${String(record.state)}）` };
  }
  // R2 (idempotency): the stamp is the only marker — one successful archive per
  // record, no matter how often the refresh runs afterwards.
  if (Number(record.archivedAt) > 0) return { archive: false, reason: '已归档（幂等）' };
  const stamp = Number(record.updatedAt || record.createdAt || 0);
  if (!stamp) return { archive: false, reason: '记录没有时间戳，无法判定防抖窗口' };
  const grace = clamp(
    config.archiveGraceMs ?? ARCHIVE_GRACE_MS,
    ARCHIVE_GRACE_MIN_MS,
    ARCHIVE_GRACE_MAX_MS
  );
  if (now - stamp < grace) {
    return { archive: false, reason: `终态未满防抖窗口（${Math.round(grace / 60_000)}min）` };
  }
  const info = await gate.sessionInfo(sessionID);
  if (!info) return { archive: false, reason: `目标会话不可读：${sessionID}` };
  const state = sessionState(info);
  // Already archived on the host (a previous run, or a human): never PATCH
  // twice. The record stays unstamped only until the manual tool adopts it.
  if (state === 'archived') return { archive: false, reason: '宿主已归档' };
  // R2 (idle only): a busy session is doing work — archiving it would hide a
  // running turn. "Idle" includes "never ran" (`time.busy` absent / older than
  // `idle`), exactly what `sessionState` reports everywhere else.
  if (state !== 'idle') return { archive: false, reason: `目标不是 idle（${state}）` };
  if (await gate.isProtected(sessionID)) {
    return { archive: false, reason: '目标在 protect 名单内' };
  }
  // R2 (still referenced): the session must not owe anything to another
  // **unresolved** hand-off — as the requester (`from.sid`) or the claimant
  // (`claim.by`). A closed hand-off never blocks (it is not work any more).
  const open = gate
    .records()
    .find(
      other =>
        !BCAST_DONE_STATES.includes(String(other.state)) &&
        (String(other.from?.sid ?? '') === sessionID || String(other.claim?.by ?? '') === sessionID)
    );
  if (open) return { archive: false, reason: `仍被未决交接 ${open.bid} 引用` };
  // R2 (no backlog): an unread owner-queue item is a request nobody has read
  // yet. Archiving would hide it (R1 of the queue: a pull channel, not a drop).
  if (gate.unseen(sessionID).length) {
    return { archive: false, reason: '还有未读的 owner-queue 项' };
  }
  return { archive: true, sessionID };
}

/**
 * The one write. `ctx.session.update` when the host exposes it; otherwise the
 * configured HTTP endpoint (`COLLAB_SERVER_URL`) — never a guessed port (the
 * same rule `collab_grant` follows). Failures are returned, never thrown, so an
 * archive can not change a tool result or break a refresh (R3).
 */
export async function archiveSession(
  ctx: CollabContext,
  sessionID: string,
  archived = true
): Promise<ArchiveWriteResult> {
  const sid = String(sessionID ?? '').trim();
  if (!sid) return { ok: false, archived, reason: 'sessionID 为空' };
  try {
    if (typeof ctx.session?.update === 'function') {
      await ctx.session.update({ sessionID: sid, archived });
      return { ok: true, archived, via: 'session.update' };
    }
    if (!SERVER_URL) {
      return {
        ok: false,
        archived,
        reason: '宿主不支持 ctx.session.update（无法归档会话），且未配置 COLLAB_SERVER_URL 作 HTTP fallback'
      };
    }
    const response = await fetch(`${SERVER_URL}/api/session/${encodeURIComponent(sid)}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(SERVER_TOKEN ? { authorization: `Bearer ${SERVER_TOKEN}` } : {})
      },
      body: JSON.stringify({ archived })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        archived,
        reason: `PATCH /api/session/${sid} → HTTP ${response.status}${detail ? ` ${truncate(detail, 160)}` : ''}`
      };
    }
    return { ok: true, archived, via: 'http' };
  } catch (error) {
    return {
      ok: false,
      archived,
      reason: `${typeof ctx.session?.update === 'function' ? 'session.update' : 'PATCH /api/session/{id}'} 失败：${errText(error)}`
    };
  }
}

/**
 * The automatic path, called from `chain.refresh()`: decide, write, and stamp
 * `archivedAt` only after the host accepted the write. Returns the merged record
 * (caller keeps using it) or `undefined` when nothing happened — a refusal is
 * logged, never surfaced as an error (R3: 归档失败只记录).
 */
export async function archiveIfDue(
  record: BroadcastRecord | undefined,
  now: number,
  gate: ArchiveGate
): Promise<BroadcastRecord | undefined> {
  const decision = await shouldArchive(record, now, gate);
  if (!decision.archive) return undefined;
  const result = await archiveSession(gate.ctx, decision.sessionID, true);
  if (!result.ok) {
    log(`archive ${decision.sessionID} skipped (bid ${record?.bid ?? '?'}): ${result.reason ?? 'unknown'}`);
    return undefined;
  }
  log(`archived spawned session ${decision.sessionID} (bid ${record?.bid ?? '?'} via ${result.via ?? '?'})`);
  return mergeArchive(String(record?.bid ?? ''), now) ?? record;
}

/** The real gate: host readers + the lazily re-read config. */
export function createArchiveGate(ctx: CollabContext, readConfig: () => CollabConfig): ArchiveGate {
  return {
    ctx,
    readConfig,
    async sessionInfo(sessionID) {
      try {
        return await ctx.session.get({ sessionID });
      } catch {
        return undefined;
      }
    },
    async isProtected(sessionID) {
      return Boolean(await createLineage(ctx).protectedAncestor(sessionID, readConfig().protect));
    },
    records: () => allBroadcasts(),
    unseen: sessionID => unseenCandidates(sessionID)
  };
}
