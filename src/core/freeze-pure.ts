/**
 * The **pure half** of `core/freeze.ts`: the freeze precedence lookup, with no
 * `node:` import at all (0.6.1, R1).
 *
 * Why this exists as its own module: `core/board.ts` is part of the GUI bundle,
 * and the desktop GUI build keeps Node built-ins **external** (`node:fs`,
 * `node:os`, `node:path`, `node:crypto` become `require("node:…")` in a window
 * that has no `require` — the panel then fails to load). Importing
 * `core/freeze.ts` from the board therefore cannot work, and copying the
 * precedence rule into the board is how the two implementations drift apart
 * (0.6.1 review nit 1).
 *
 * So: the rule lives here **once**, `core/freeze.ts` re-exports it (every
 * server-side caller — `snapshot`, `collab_list`, the tools — keeps importing
 * from `core/freeze.ts`), and the board imports this module directly. One
 * implementation, two entry points, zero `node:` in the window bundle.
 */
import type { FreezeEntry } from '../types.ts';
import type { SnapshotFreeze } from '../rpc.ts';

export interface FreezeKeys {
  /** The session being written to (its own freeze counts first). */
  session?: string;
  /** Ancestors of `session`, nearest first (the pure snapshot path). */
  ancestors?: string[];
  /** Hand-off id (`b_…`). */
  bid?: string;
  /** Absolute workspace directory. */
  workspace?: string;
}

export interface FrozenHit {
  entry: FreezeEntry;
  /** The frozen **ancestor** (only when the session hit came through lineage). */
  via?: string;
}

/**
 * Pure precedence lookup: `session` (self, then ancestors) > `bid` > `workspace`.
 * Used by the snapshot (which has the parent map in memory), by `frozenBy`
 * (which walks the live lineage through the host) and by the board (which has
 * the ancestor chain in the snapshot).
 *
 * `entries` are expected to be **live** (`until > now`): every reader
 * (`readFreezes(now)`) already dropped expired rows, and a caller that has a
 * reason to hand over raw entries filters them first. This function decides
 * *which* freeze wins, never *whether* it is still running.
 */
export function freezeFor(entries: FreezeEntry[], keys: FreezeKeys): FrozenHit | undefined {
  const chain = [keys.session, ...(keys.ancestors ?? [])].filter(Boolean).map(String);
  if (chain.length) {
    const byTarget = new Map(
      entries.filter(entry => entry.scope === 'session').map(entry => [entry.target, entry] as const)
    );
    for (const sid of chain) {
      const entry = byTarget.get(sid);
      if (entry) return sid === keys.session ? { entry } : { entry, via: sid };
    }
  }
  if (keys.bid) {
    const entry = entries.find(candidate => candidate.scope === 'bid' && candidate.target === String(keys.bid));
    if (entry) return { entry };
  }
  if (keys.workspace) {
    const entry = entries.find(
      candidate => candidate.scope === 'workspace' && candidate.target === String(keys.workspace)
    );
    if (entry) return { entry };
  }
  return undefined;
}

/** `FreezeEntry` → the marker a snapshot / board row prints (shape adapter). */
export function freezeMarker(entry: FreezeEntry): SnapshotFreeze {
  return {
    scope: entry.scope,
    ...(entry.target ? { target: entry.target } : {}),
    until: Number(entry.until) || 0,
    reason: entry.reason
  };
}

/**
 * The **live** entries: `until > now`. This is the one expiry expression the
 * pure consumers share (`readFreezes(now)` returns exactly this shape); a board
 * handed a raw list cannot paint a freeze that is already over.
 */
export function liveFreezes(entries: FreezeEntry[], now = Date.now()): FreezeEntry[] {
  return entries.filter(entry => Number(entry?.until) > now);
}

/**
 * A snapshot's own marker, kept only while it is live. `buildSnapshot` already
 * computed it (ancestors + workspace) with `freezeFor`; a marker whose `until`
 * has passed is an expired freeze and must not paint `[frozen]`.
 */
export function liveFreezeMarker(
  marker: SnapshotFreeze | undefined,
  now = Date.now()
): SnapshotFreeze | undefined {
  if (!marker) return undefined;
  return Number(marker.until) > now ? marker : undefined;
}
