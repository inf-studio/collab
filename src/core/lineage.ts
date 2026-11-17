import { MAX_LINEAGE_DEPTH } from '../constants.ts';
import type { CollabContext, SessionInfoLike } from '../types.ts';

export interface LineageGuardHit {
  sessionID: string;
  depth: number;
}

export interface Lineage {
  seed(sessions: SessionInfoLike[]): void;
  protectedAncestor(sessionID: string, protect: string[]): Promise<LineageGuardHit | undefined>;
}

/**
 * `protect` is a *lineage* guard, not an id list: a target is refused when it
 * is protected itself or any ancestor in its `parentID` chain is. Without this,
 * dispatching a sub-agent (e.g. `trellis-implement` spawned from the schema
 * line) would silently bypass the hard list.
 *
 * `parentID` comes from `Session.Info` (`ctx.session.get`); when the host does
 * not expose it, the same field is looked up once through `ctx.session.list()`
 * (the server returns it there too). The walk is bounded by
 * `MAX_LINEAGE_DEPTH` and cycle-safe, so a malformed chain can never hang a tool.
 */
export function createLineage(ctx: CollabContext): Lineage {
  const cache = new Map<string, SessionInfoLike | undefined>();
  let page: SessionInfoLike[] | undefined;

  async function listPage(): Promise<SessionInfoLike[]> {
    if (page === undefined) {
      try {
        const listed = await ctx.session.list({ limit: 100 });
        page = Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : [];
      } catch {
        page = []; // best effort: absence just means "no lineage evidence"
      }
    }
    return page;
  }

  function fromList(sessionID: string): SessionInfoLike | undefined {
    return page?.find(item => item?.id === sessionID);
  }

  async function nodeOf(sessionID: string): Promise<SessionInfoLike | undefined> {
    if (!sessionID) return undefined;
    if (cache.has(sessionID)) return cache.get(sessionID);
    let node: SessionInfoLike | undefined;
    try {
      node = await ctx.session.get({ sessionID });
    } catch {
      node = undefined;
    }
    // `get` without the field (different host version) → fall back to the page.
    if (!node || !('parentID' in node)) {
      await listPage();
      node = fromList(sessionID) ?? node;
    }
    cache.set(sessionID, node);
    return node;
  }

  return {
    /** Pre-seed from an already-fetched page (used by `collab_list`). */
    seed(sessions) {
      page = Array.isArray(sessions) ? sessions : [];
      for (const item of page) if (item?.id) cache.set(item.id, item);
    },

    /**
     * Walk `sessionID` → parents. Returns `{sessionID, depth}` for the first
     * protected id on the chain (`depth: 0` = the target itself, `depth: n` =
     * the n-th ancestor), else undefined. `MAX_LINEAGE_DEPTH` bounds the number
     * of *ancestors* walked, so the loop runs `depth` 0…8 (self + 8 levels).
     */
    async protectedAncestor(sessionID, protect) {
      const protectedIDs = new Set(protect);
      const seen = new Set<string>();
      let current = String(sessionID ?? '');

      for (let depth = 0; current && depth <= MAX_LINEAGE_DEPTH; depth++) {
        if (protectedIDs.has(current)) return { sessionID: current, depth };
        if (seen.has(current)) return undefined; // defensive: cycle in parentID
        seen.add(current);
        const node = await nodeOf(current);
        const parent = node?.parentID ?? node?.parentId;
        current = parent ? String(parent) : '';
      }
      return undefined;
    }
  };
}
