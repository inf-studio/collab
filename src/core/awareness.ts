import type { ConfigReader } from '../config.ts';
import { AWARENESS_LIST_LIMIT, AWARENESS_TTL_MS, BCAST_DONE_STATES } from '../constants.ts';
import type { CollabContext, SessionInfoLike } from '../types.ts';
import { asObject } from '../util.ts';
import { allBroadcasts } from './claim.ts';
import { createLineage } from './lineage.ts';
import type { Lineage } from './lineage.ts';

/**
 * 0.7.0 (R1–R5): the one-line "awareness" hint.
 *
 * 0.6.0 shipped the tools but a session still had to be *told* which one to
 * use — a human had to say "use `collab_handoff`" (and, across workspaces,
 * "write a proposal and `collab_broadcast`"). The hint answers only "is there
 * anyone to ask, and through which channel", never "who": picking a person
 * stays with `collab_handoff`'s scoring or with the human.
 *
 * Read-only by construction: it counts sessions and returns a string. It writes
 * no record, opens no thread and never delivers.
 */

/** What the hint renders — pure, so the wording is unit-testable. */
export function awarenessText({ n, m }: { n: number; m?: number }): string | undefined {
  const parts: string[] = [];
  if (n > 0) parts.push(`本工作区候选 ${n}（collab_handoff）`);
  // `m === undefined` = the host could not list the other workspaces: say less
  // (only the local count) instead of failing or inventing a number (R3).
  if ((m ?? 0) > 0) parts.push(`其它工作区候选 ${m}（collab_broadcast，需提案）`);
  if (!parts.length) return undefined;
  return `协作：${parts.join(' · ')}`;
}

/** "Countable candidate": root session, not archived. */
function countable(info: SessionInfoLike | undefined): info is SessionInfoLike {
  if (!info?.id) return false;
  if (info.parentID || info.parentId) return false; // sub-sessions are not group members
  return !asObject(info.time).archived;
}

export interface AwarenessOptions {
  /** The current plugin's workspace (`ctx.location.directory`). */
  ctx?: Pick<CollabContext, 'location'>;
  readConfig: ConfigReader;
  listSessions(input?: { directory?: string; limit?: number }): Promise<SessionInfoLike[]>;
  /** Shared lineage guard; a fresh one is created from `ctx` when omitted. */
  lineage?: Lineage;
  /** Injected clock (tests); defaults to `Date.now`. */
  now?: () => number;
}

export interface Awareness {
  /**
   * The line to append, or `undefined`. Side effects are limited to the
   * per-session cache (`listedAt`); the caller stamps `markShown` only after
   * the block was really pushed onto the request (the F1 rule the other
   * injections already follow).
   */
  line(sessionID: string | undefined): Promise<string | undefined>;
  markShown(sessionID: string | undefined): void;
}

interface Entry {
  /** When the line was last really injected for this session. */
  shownAt?: number;
  /** When the session list was last read (shared by N and M). */
  listedAt: number;
  n: number;
  m?: number;
}

export function createAwareness(options: AwarenessOptions): Awareness {
  const { ctx, readConfig, listSessions } = options;
  const now = options.now ?? Date.now;
  const cache = new Map<string, Entry>();
  let lineage = options.lineage;
  const guard = (): Lineage | undefined => {
    if (lineage) return lineage;
    try {
      lineage = createLineage(ctx as CollabContext);
      return lineage;
    } catch {
      return undefined; // no host session domain: the hint is optional
    }
  };

  /** Does this session itself own an unfinished hand-off? Then it is the requester. */
  function hasOpenHandoff(sessionID: string): boolean {
    return allBroadcasts().some(
      record =>
        String(record?.from?.sid ?? '') === sessionID &&
        !BCAST_DONE_STATES.includes(String(record?.state ?? ''))
    );
  }

  async function counts(workspace: string | undefined, sessionID: string): Promise<{ n: number; m?: number }> {
    // P3b (review): without a workspace there is no "本工作区" — counting the
    // global page as N *and* as M reported the same sessions twice
    // (`本工作区候选 2 · 其它工作区候选 2`). N stays 0 and only M is rendered.
    let n = 0;
    if (workspace) {
      // N: the workspace itself. A failure here means "cannot count at all" —
      // return no line rather than a wrong one (the hint is optional).
      const local = await listSessions({ directory: workspace, limit: AWARENESS_LIST_LIMIT });
      n = local.filter(info => countable(info) && info.id !== sessionID).length;
    }

    // M: every other workspace in one (cached) page. A failure here only drops
    // the second half — R3: omit M, never throw.
    let m: number | undefined;
    try {
      const page = await listSessions({ limit: AWARENESS_LIST_LIMIT });
      const seen = new Set<string>();
      m = 0;
      for (const info of page) {
        if (!countable(info) || info.id === sessionID || seen.has(info.id)) continue;
        const dir = info.location?.directory;
        if (!dir || dir === workspace) continue; // mine / unknown workspace
        seen.add(info.id);
        m += 1;
      }
    } catch {
      m = undefined;
    }
    return { n, m };
  }

  return {
    async line(sessionID) {
      if (!sessionID) return undefined;
      const config = readConfig();
      if (config.awareness !== 'line') return undefined; // R5: `off` = 0 lines
      const at = now();
      const hit = cache.get(sessionID);
      // R1: at most one hint per session per 10 minutes.
      if (hit?.shownAt !== undefined && at - hit.shownAt < AWARENESS_TTL_MS) return undefined;
      // A requester with a live hand-off is being served by the chain lines;
      // a second "who to ask" hint would only be noise.
      if (hasOpenHandoff(sessionID)) return undefined;
      // Protected sessions can only answer through the queue / an ask.
      try {
        if (await guard()?.protectedAncestor(sessionID, config.protect)) return undefined;
      } catch {
        return undefined;
      }

      const workspace = ctx?.location?.directory;
      let counted: { n: number; m?: number };
      if (hit && at - hit.listedAt < AWARENESS_TTL_MS) {
        counted = { n: hit.n, m: hit.m };
      } else {
        try {
          counted = await counts(workspace, sessionID);
        } catch {
          return undefined; // cannot count a single candidate: stay silent
        }
        cache.set(sessionID, { listedAt: at, n: counted.n, m: counted.m });
      }

      const text = awarenessText(counted);
      if (!text) return undefined; // N + M = 0: nothing to offer
      return text;
    },

    markShown(sessionID) {
      if (!sessionID) return;
      const at = now();
      const hit = cache.get(sessionID);
      cache.set(sessionID, {
        listedAt: hit?.listedAt ?? at,
        n: hit?.n ?? 0,
        m: hit?.m,
        shownAt: at
      });
    }
  };
}
