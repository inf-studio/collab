/**
 * 0.10.0 (`11-26-collab-board-scroll`): **stable rows** for the GUI board's keyed
 * lists.
 *
 * The panel polls `collab.state.snapshot` every 2 s. `buildBoard` derives fresh
 * `BoardWorkspace` / `BoardSession` objects on every poll, so a `<For each>` fed
 * the raw arrays sees every item as a new reference and rebuilds the whole
 * subtree — on a 25-session workspace that means the list is torn down twice a
 * second and its container's scroll position is clamped back to the top.
 *
 * This module keeps one **row object** per key (workspace path, session id,
 * spawn id) across polls:
 *
 *   - the array reference only changes when the **membership** changes, so
 *     `<For each={rows()}>` keeps every node it already has;
 *   - a field change is pushed into that row's `value` signal, so the row's own
 *     content updates in place (no node replacement).
 *
 * Deliberately not Solid's `<Index>`: `Index` reuses by **position**, and the
 * board re-sorts sessions (busy first, then sid) between polls — a session that
 * moves would keep someone else's node. `Map` by key (and not by index) is the
 * rule the design asks for.
 *
 * No DOM here on purpose: it is a reactive bookkeeping helper, not a renderer
 * (the GUI bundle is the only importer; the TUI keeps its own tree).
 */
import { createMemo, createSignal, type Accessor } from 'solid-js';

/** One stable row: an immutable `key` and a reactive `value`. */
export interface StableRow<T> {
  /** Identity across polls (workspace path / `sid` / spawn id). */
  readonly key: string;
  /** The current item; reading it inside JSX tracks updates in place. */
  readonly value: Accessor<T>;
}

interface Entry<T> {
  setValue: (item: T) => void;
  row: StableRow<T>;
}

/**
 * Map a changing list onto rows that are reused while their key is present.
 *
 * The returned accessor answers the **same array reference** when the key
 * sequence is unchanged, even though the underlying `items()` were replaced (the
 * values are already published through each row's signal). When keys are
 * added / removed it answers a new array holding the surviving rows by
 * reference plus the new ones — so a keyed `<For>` adds / removes exactly the
 * nodes whose membership changed.
 */
export function createStableRows<T>(items: Accessor<readonly T[]>, keyOf: (item: T) => string): Accessor<StableRow<T>[]> {
  const entries = new Map<string, Entry<T>>();
  // The last answer, kept only for its reference: Solid memos are compared with
  // `===`, so returning it unchanged is what stops an unchanged list from
  // reaching (and rebuilding) the `<For>` below.
  let rows: StableRow<T>[] = [];
  let keys: string[] = [];

  return createMemo(() => {
    // Dependency topology — **do not "fix" this into a second effect**: the
    // `setValue` writes below are intentionally performed *inside* this memo,
    // before the (possibly unchanged) row array is published.
    //
    //   `items()` changes → this memo recomputes → ticks each row's `value`
    //   signal → each row's own render effect (which reads `row.value()`)
    //   re-runs → then the memo answers. Returning the *same* array reference
    //   stops the `<For>` from re-running at all, so a field change reaches
    //   exactly the one row that reads it, and a membership change reaches the
    //   `For` as one new array (add / remove, never rebuild).
    //
    // The memo itself never reads `value`, so there is no self-dependency
    // cycle; a reader that did (`contract-view`-style derived memos) would just
    // be ordered after the write, which is the intent.
    const next: StableRow<T>[] = [];
    const nextKeys: string[] = [];
    const seen = new Set<string>();
    for (const item of items()) {
      const key = keyOf(item);
      // A duplicated key would put the same row object in the list twice and
      // confuse a keyed `For`; the board's keys are unique by construction, so
      // the second occurrence is dropped rather than silently aliased.
      if (seen.has(key)) continue;
      seen.add(key);
      nextKeys.push(key);
      const known = entries.get(key);
      if (known) {
        // Same row object, new contents: only this row's content re-renders.
        known.setValue(item);
        next.push(known.row);
        continue;
      }
      const [value, setValue] = createSignal<T>(item, { equals: false });
      const row: StableRow<T> = { key, value };
      entries.set(key, { setValue, row });
      next.push(row);
    }
    for (const key of entries.keys()) if (!seen.has(key)) entries.delete(key);

    if (nextKeys.length === keys.length && nextKeys.every((key, index) => key === keys[index])) return rows;
    keys = nextKeys;
    rows = next;
    return rows;
  });
}
