import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigReader } from '../config.ts';
import { invalid } from './errors.ts';
import {
  COLLAB_RULE_RESOURCE,
  COLLAB_TOOL_ACTIONS,
  GRANT_DIR,
  PERMISSION_EFFECTS,
  PROMOTE_AGENTS,
  SERVER_TOKEN,
  SERVER_URL
} from '../constants.ts';
import { errText } from '../log.ts';
import type { CollabContext, GrantRecord, JsonObject, PermissionRule } from '../types.ts';
import { asObject, dedupe, randToken, readJsonFile, truncate } from '../util.ts';

// ----------------------------------------------------------- the rule whitelist

/** The five allow rules this plugin adds — always rebuilt from the whitelist. */
export function collabPermissionRules(): PermissionRule[] {
  return COLLAB_TOOL_ACTIONS.map(action => ({
    action,
    resource: COLLAB_RULE_RESOURCE,
    effect: 'allow'
  }));
}

/**
 * Keep only well-formed `Permission.Rule`s (`{action, resource, effect}` with a
 * known effect). Unknown shapes are dropped rather than forwarded: the host
 * rejects the whole ruleset on one invalid entry, which would lose the merge.
 */
export function normalizeRules(value: unknown): PermissionRule[] {
  if (!Array.isArray(value)) return [];
  const rules: PermissionRule[] = [];
  for (const item of value) {
    const rule = asObject(item);
    const action = String(rule.action ?? '').trim();
    const resource = String(rule.resource ?? '').trim();
    const effect = String(rule.effect ?? '').trim();
    if (!action || !resource || !PERMISSION_EFFECTS.includes(effect)) continue;
    rules.push({ action, resource, effect });
  }
  return rules;
}

/** Rules are matched on `action + resource` — the API has no other identity. */
export function ruleKey(rule: PermissionRule): string {
  return `${rule.action}\u0000${rule.resource}`;
}

/**
 * Merge, never replace: `base` keeps its order *and* its precedence, then only
 * rules whose `action+resource` is not present yet are appended. A `deny`
 * already on the session therefore stays a `deny` (no widening by re-granting).
 */
export function mergeRules(base: unknown, add: unknown): PermissionRule[] {
  const merged: PermissionRule[] = [];
  const seen = new Set<string>();
  for (const rule of [...normalizeRules(base), ...normalizeRules(add)]) {
    const key = ruleKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ action: rule.action, resource: rule.resource, effect: rule.effect });
  }
  return merged;
}

/** Rules of `rules` that `base` does not contain yet (for previews / records). */
export function missingRules(base: unknown, rules: unknown): PermissionRule[] {
  const existing = new Set(normalizeRules(base).map(rule => ruleKey(rule)));
  return normalizeRules(rules).filter(rule => !existing.has(ruleKey(rule)));
}

/**
 * Fail-closed whitelist: the *add* payload may only carry the five `collab_*`
 * actions with `effect:"allow"`. A restored snapshot is deliberately **not**
 * checked against this list — it is the ruleset that was there before.
 */
export function assertCollabOnly(rules: PermissionRule[]): PermissionRule[] {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw invalid('拒绝授权：规则集为空（只允许 5 条 collab_* 动作）。');
  }
  for (const rule of rules) {
    const action = String(rule?.action ?? '');
    if (!COLLAB_TOOL_ACTIONS.includes(action)) {
      throw invalid(
        `拒绝授权：action="${action}" 不在白名单内（只允许 ${COLLAB_TOOL_ACTIONS.join(' / ')}，` +
          '不授予 edit/write/shell 等任何额外能力）。'
      );
    }
    if (rule?.effect !== 'allow') {
      throw invalid(`拒绝授权：collab 动作只允许 effect="allow"（收到 "${String(rule?.effect)}"）。`);
    }
  }
  return rules;
}

// ------------------------------------------------------------------ the ledger

export function grantFile(sessionID: unknown): string {
  return join(GRANT_DIR, `${String(sessionID ?? '').replace(/[^\w.-]/g, '_')}.json`);
}

export function normalizeGrant(record: unknown): GrantRecord | undefined {
  const raw = asObject(record);
  if (!raw.sid) return undefined;
  const out: GrantRecord = { sid: String(raw.sid) };
  // Permission half (`collab_grant`) — present only when that half was used.
  if (Array.isArray(raw.before)) out.before = normalizeRules(raw.before);
  if (Array.isArray(raw.added)) out.added = dedupe(raw.added);
  if (raw.at !== undefined && raw.at !== null) out.at = Number(raw.at) || 0;
  if (typeof raw.by === 'string' && raw.by) out.by = raw.by;
  if (typeof raw.reason === 'string' && raw.reason) out.reason = raw.reason;
  // Agent half (`collab_promote`) — independent keys, never overwritten by the
  // permission half (both live in the same ledger file).
  if (typeof raw.agentBefore === 'string' && raw.agentBefore) out.agentBefore = raw.agentBefore;
  if (raw.promotedAt !== undefined && raw.promotedAt !== null) {
    out.promotedAt = Number(raw.promotedAt) || 0;
  }
  if (typeof raw.promotedBy === 'string' && raw.promotedBy) out.promotedBy = raw.promotedBy;
  return out;
}

export function readGrant(sessionID: unknown): GrantRecord | undefined {
  const raw = readJsonFile(grantFile(sessionID));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return normalizeGrant(raw);
}

/**
 * Merge-then-replace (tmp + rename), same shape as the broadcast store:
 * a write carries only the half it touched, the other half is preserved from
 * the file. Passing `null` clears a field; a record with neither `before` nor
 * `agentBefore` left is deleted instead of being kept as an empty shell.
 */
export function writeGrant(record: JsonObject): GrantRecord | undefined {
  const raw = asObject(record);
  const sid = String(raw.sid ?? '');
  if (!sid) return undefined;
  const existing = readGrant(sid) ?? { sid };
  const next = normalizeGrant({ ...existing, ...raw });
  if (!next) return undefined;
  if (!next.before && !next.agentBefore) {
    removeGrant(sid);
    return undefined;
  }
  mkdirSync(GRANT_DIR, { recursive: true });
  const tmp = `${grantFile(sid)}.${randToken()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, grantFile(sid));
  return next;
}

export function removeGrant(sessionID: unknown): boolean {
  try {
    unlinkSync(grantFile(sessionID));
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------- session-level permissions (ctx)

export interface GrantFailure {
  ok: false;
  phase: string;
  reason: string;
  before?: PermissionRule[];
  wanted?: PermissionRule[];
  record?: GrantRecord;
  from?: string;
  [key: string]: any;
}

export interface GrantSuccess {
  ok: true;
  changed: boolean;
  added: PermissionRule[];
  before: PermissionRule[];
  after: PermissionRule[];
  verified: PermissionRule[];
  record?: GrantRecord;
}

export type GrantResult = GrantSuccess | GrantFailure;

export interface RevokeSuccess {
  ok: true;
  restored: PermissionRule[];
  verified: PermissionRule[];
  record: GrantRecord;
  leftover?: GrantRecord;
}

export type RevokeResult = RevokeSuccess | GrantFailure;

export interface PromoteSuccess {
  ok: true;
  changed: boolean;
  from: string;
  to: string;
  agentBefore: string;
  verified: string;
  record?: GrantRecord;
}

export type PromoteResult = PromoteSuccess | GrantFailure;

export interface RevertSuccess {
  ok: true;
  from: string;
  restored: string;
  verified: string;
  record: GrantRecord;
  leftover?: GrantRecord;
}

export type RevertResult = RevertSuccess | GrantFailure;

export interface Grants {
  readSessionPermissions(sessionID: string): Promise<PermissionRule[]>;
  patchSessionPermissions(sessionID: string, rules: unknown): Promise<{ via: string }>;
  grantForSession(sessionID: string, input?: { reason?: string; by?: string }): Promise<GrantResult>;
  revokeForSession(sessionID: string): Promise<RevokeResult>;
  promoteSession(sessionID: string, input?: { agent?: string; by?: string }): Promise<PromoteResult>;
  revertSessionAgent(sessionID: string): Promise<RevertResult>;
}

/** R8: every write to another session is opt-in; default is read-only. */
const WRITE_DISABLED_REASON =
  'allowWrite=false（本插件默认只读）：不修改任何会话的 permissions / agent。' +
  '需要时在 collab.json 或插件 options 里显式设置 allowWrite:true。';

export function createGrants(ctx: CollabContext, readConfig: ConfigReader): Grants {
  /**
   * The session's **own** ruleset (`Session.Info.permissions`). Deliberately
   * uncached: a grant/revoke must snapshot the exact current set, and the whole
   * set is replaced on PATCH.
   */
  async function readSessionPermissions(sessionID: string): Promise<PermissionRule[]> {
    const info = await ctx.session.get({ sessionID });
    return normalizeRules(info?.permissions);
  }

  /**
   * `PATCH /api/session/{id}` takes `permissions` as a **whole-set replacement**,
   * so every caller hands in the merged set — never a delta. Hosts without the
   * SDK method fall back to HTTP only when `COLLAB_SERVER_URL` is configured
   * explicitly (a guessed port could patch an unrelated instance).
   */
  async function patchSessionPermissions(sessionID: string, rules: unknown): Promise<{ via: string }> {
    const payload = normalizeRules(rules);
    if (typeof ctx.session?.update === 'function') {
      await ctx.session.update({ sessionID, permissions: payload });
      return { via: 'session.update' };
    }
    if (!SERVER_URL) {
      throw invalid(
        '宿主不支持 ctx.session.update（无法写会话级 permissions），且未配置 COLLAB_SERVER_URL 作 HTTP fallback'
      );
    }
    const response = await fetch(`${SERVER_URL}/api/session/${encodeURIComponent(sessionID)}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(SERVER_TOKEN ? { authorization: `Bearer ${SERVER_TOKEN}` } : {})
      },
      body: JSON.stringify({ permissions: payload })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `PATCH /api/session/${sessionID} → HTTP ${response.status}${detail ? ` ${truncate(detail, 160)}` : ''}`
      );
    }
    return { via: 'http' };
  }

  /**
   * Idempotent grant. Merge the five allow rules into the session's current set,
   * PATCH once, and keep the **first** pre-grant snapshot as `before` so repeated
   * spawn/grant never accumulates and `revoke` restores the original ruleset
   * rather than deleting rules that pre-existed.
   *
   * Never throws: a 403/404/old host comes back as `{ok:false, reason}` and the
   * hand-off continues (the lease-expiry auto receipt still closes it).
   */
  async function grantForSession(
    sessionID: string,
    { reason = 'grant', by = '' }: { reason?: string; by?: string } = {}
  ): Promise<GrantResult> {
    if (!readConfig().allowWrite) return { ok: false, phase: 'disabled', reason: WRITE_DISABLED_REASON };
    const wanted = assertCollabOnly(collabPermissionRules());
    let before: PermissionRule[];
    try {
      before = await readSessionPermissions(sessionID);
    } catch (error) {
      return {
        ok: false,
        phase: 'read',
        reason: `读取 ${sessionID} 的 permissions 失败：${errText(error)}`
      };
    }
    const existing = readGrant(sessionID);
    const snapshot = existing?.before ?? before;
    const added = missingRules(before, wanted);
    const after = mergeRules(before, wanted);
    try {
      if (added.length) await patchSessionPermissions(sessionID, after);
    } catch (error) {
      return {
        ok: false,
        phase: 'patch',
        reason: `写入 ${sessionID} 的 permissions 失败：${errText(error)}`,
        before,
        wanted
      };
    }
    let verified: PermissionRule[];
    try {
      verified = await readSessionPermissions(sessionID);
    } catch {
      verified = after; // unreadable after a successful PATCH: report the intent
    }
    const record = writeGrant({
      sid: sessionID,
      before: snapshot,
      added: dedupe([...(existing?.added ?? []), ...added.map(rule => rule.action)]),
      at: Date.now(),
      by: existing?.by || by,
      reason: existing?.reason || reason
    });
    return { ok: true, changed: added.length > 0, added, before, after, verified, record };
  }

  /**
   * Restore the recorded pre-grant ruleset and drop the record. The PATCH is a
   * whole-set replacement, so this is the exact inverse of one grant — nothing
   * is "deleted by name" (a `collab_*` rule that pre-existed stays).
   */
  async function revokeForSession(sessionID: string): Promise<RevokeResult> {
    if (!readConfig().allowWrite) return { ok: false, phase: 'disabled', reason: WRITE_DISABLED_REASON };
    const record = readGrant(sessionID);
    if (!record || !record.before) {
      return {
        ok: false,
        phase: 'record',
        reason: `没有 ${sessionID} 的授权记录（${grantFile(sessionID)}），无可还原`
      };
    }
    try {
      await patchSessionPermissions(sessionID, record.before);
    } catch (error) {
      return {
        ok: false,
        phase: 'patch',
        reason: `还原 ${sessionID} 的 permissions 失败：${errText(error)}`,
        record
      };
    }
    let verified: PermissionRule[];
    try {
      verified = await readSessionPermissions(sessionID);
    } catch {
      verified = record.before;
    }
    // Drop only the permission half: a promote record in the same file survives.
    const leftover = writeGrant({
      sid: sessionID,
      before: null,
      added: null,
      at: null,
      by: null,
      reason: null
    });
    return { ok: true, restored: record.before, verified, record, leftover };
  }

  /**
   * `POST /api/session/{id}/agent` (`session.switchAgent`). Same fallback rule as
   * the permission patch: never guess a server, only a configured one.
   */
  async function switchSessionAgent(sessionID: string, agent: string): Promise<{ via: string }> {
    if (typeof ctx.session?.switchAgent === 'function') {
      await ctx.session.switchAgent({ sessionID, agent });
      return { via: 'session.switchAgent' };
    }
    if (!SERVER_URL) {
      throw invalid(
        '宿主不支持 ctx.session.switchAgent（无法切换会话 agent），且未配置 COLLAB_SERVER_URL 作 HTTP fallback'
      );
    }
    const response = await fetch(`${SERVER_URL}/api/session/${encodeURIComponent(sessionID)}/agent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(SERVER_TOKEN ? { authorization: `Bearer ${SERVER_TOKEN}` } : {})
      },
      body: JSON.stringify({ agent })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `POST /api/session/${sessionID}/agent → HTTP ${response.status}${detail ? ` ${truncate(detail, 160)}` : ''}`
      );
    }
    return { via: 'http' };
  }

  /**
   * Promote a session's agent (default `build`; whitelist `build`/`plan`).
   * The pre-promotion agent is recorded once (`agentBefore`, first write wins)
   * so `revert` restores the *original* value even after repeated promote calls.
   * Never throws: a 403/404/old host comes back as `{ok:false, reason}`.
   */
  async function promoteSession(
    sessionID: string,
    { agent = 'build', by = '' }: { agent?: string; by?: string } = {}
  ): Promise<PromoteResult> {
    if (!readConfig().allowWrite) return { ok: false, phase: 'disabled', reason: WRITE_DISABLED_REASON };
    const target = String(agent ?? '').trim() || 'build';
    if (!PROMOTE_AGENTS.includes(target)) {
      return {
        ok: false,
        phase: 'agent',
        reason: `agent="${target}" 不在白名单（只允许 ${PROMOTE_AGENTS.join(' / ')}）；未修改任何会话`
      };
    }
    let info;
    try {
      info = await ctx.session.get({ sessionID });
    } catch (error) {
      return { ok: false, phase: 'read', reason: `读取 ${sessionID} 失败：${errText(error)}` };
    }
    const current = String(info?.agent ?? '');
    const existing = readGrant(sessionID);
    const agentBefore = existing?.agentBefore ?? current;
    const changed = current !== target;
    if (changed) {
      try {
        await switchSessionAgent(sessionID, target);
      } catch (error) {
        return {
          ok: false,
          phase: 'switch',
          reason: `切换 ${sessionID} 的 agent 失败：${errText(error)}`,
          from: current
        };
      }
    }
    const record =
      changed || existing?.agentBefore
        ? writeGrant({ sid: sessionID, agentBefore, promotedAt: Date.now(), promotedBy: by })
        : existing;
    let verified = target;
    try {
      verified = String((await ctx.session.get({ sessionID }))?.agent ?? target);
    } catch {
      verified = target;
    }
    return { ok: true, changed, from: current, to: target, agentBefore, verified, record };
  }

  /** Restore `agentBefore` and drop only the agent half of the ledger record. */
  async function revertSessionAgent(sessionID: string): Promise<RevertResult> {
    if (!readConfig().allowWrite) return { ok: false, phase: 'disabled', reason: WRITE_DISABLED_REASON };
    const record = readGrant(sessionID);
    if (!record?.agentBefore) {
      return {
        ok: false,
        phase: 'record',
        reason: `没有 ${sessionID} 的 promote 记录（${grantFile(sessionID)}），无可还原`
      };
    }
    let current = record.agentBefore;
    try {
      current = String((await ctx.session.get({ sessionID }))?.agent ?? record.agentBefore);
    } catch {
      current = record.agentBefore;
    }
    try {
      await switchSessionAgent(sessionID, record.agentBefore);
    } catch (error) {
      return {
        ok: false,
        phase: 'switch',
        reason: `还原 ${sessionID} 的 agent 失败：${errText(error)}`,
        record
      };
    }
    const leftover = writeGrant({
      sid: sessionID,
      agentBefore: null,
      promotedAt: null,
      promotedBy: null
    });
    let verified = record.agentBefore;
    try {
      verified = String((await ctx.session.get({ sessionID }))?.agent ?? record.agentBefore);
    } catch {
      verified = record.agentBefore;
    }
    return { ok: true, from: current, restored: record.agentBefore, verified, record, leftover };
  }

  return {
    readSessionPermissions,
    patchSessionPermissions,
    grantForSession,
    revokeForSession,
    promoteSession,
    revertSessionAgent
  };
}

/**
 * The grant half of a ledger record, or undefined when only the promote half is
 * there. Used by the `collab_grant` preview so a promote-only record is reported
 * as "no permissions snapshot" instead of reading `.added` / `.before` on
 * undefined (B1: that used to throw `TypeError: … reading 'join'`).
 */
export function grantHalfOf(record: GrantRecord | undefined): GrantRecord | undefined {
  return record && Array.isArray(record.before) && Array.isArray(record.added) ? record : undefined;
}
