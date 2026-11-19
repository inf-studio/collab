/**
 * 0.8.0 (`board2-graph`): the **one derivation** the GUI's little relation graph
 * and the TUI's text tree both render — `snapshot → nodes + edges` at three
 * levels:
 *
 *   - `global`    (nothing selected): workspaces are the nodes, cross-workspace
 *                 hand-offs are the edges (merged per workspace pair, `count`);
 *   - `workspace` (a workspace selected): its sessions are the nodes, an edge
 *                 that leaves the workspace lands on a **workspace node** for
 *                 the other side (drawn dashed — the counterpart is not
 *                 expanded);
 *   - `session`   (a session selected): that session, its direct neighbours
 *                 (±1 hop) and the edges between them, capped at
 *                 `GRAPH_NODE_LIMIT` nodes with a `truncated` count for the
 *                 `+N` marker.
 *
 * Deliberately **pure and I/O-free** — like `core/board.ts`: no host, no file,
 * no clock of its own (`now` is a parameter), no `node:` import (this module is
 * part of the GUI bundle, which runs in a window where `node:fs` does not
 * exist). Freeze markers come from `core/freeze-pure.ts`, the same precedence
 * rule the board and the snapshot use; the graph re-implements nothing.
 *
 * Determinism (R4) is a property of this file: nodes are sorted by `id` and
 * edges by `from + kind + to`, both with plain code-unit comparison (never
 * `localeCompare`, whose order depends on the machine's locale). Two renders of
 * the same snapshot are therefore byte-identical — the sort is the contract,
 * not the `Map` insertion order the derivation happened to produce.
 *
 * Read-only (R5): the graph only *filters* what the snapshot already reported.
 * Nothing is released, archived, frozen or delivered.
 */
import type { FreezeEntry } from '../types.ts';
import { freezeFor, freezeMarker, liveFreezeMarker, liveFreezes } from './freeze-pure.ts';
import type { Snapshot, SnapshotFreeze, SnapshotHandoff, SnapshotSession } from '../rpc.ts';

export type GraphLevel = 'global' | 'workspace' | 'session';
export type GraphNodeKind = 'workspace' | 'session';
/** `handoff` solid · `origin` dashed · `spawn` / `subagent` dotted. */
export type GraphEdgeKind = 'handoff' | 'origin' | 'spawn' | 'subagent';

export interface GraphNode {
  /** Workspace directory (`` = the global group) or a session id (`ses_…`). */
  id: string;
  kind: GraphNodeKind;
  /**
   * Session title, or the last path segment of a workspace. Renderers shorten
   * it; the core never invents a translated label (`'全局'` is the GUI's / TUI's
   * own word for the `''` workspace).
   */
  label: string;
  /** The session is filed under `已归档` (a workspace node never carries it). */
  archived?: boolean;
  frozen?: SnapshotFreeze;
  /** A hand-off of this session is `priority:"urgent"` (display only). */
  urgent?: boolean;
  /** Parent session id, for the `subagent` relation. */
  parent?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  /** The hand-off this edge came from (absent on a `subagent` edge). */
  bid?: string;
  state?: string;
  /** `global` level only: how many hand-offs this workspace pair carries. */
  count?: number;
}

export interface GraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Nodes dropped by `GRAPH_NODE_LIMIT` (the `+N` marker); `0` when none. */
  truncated: number;
}

export interface GraphOptions {
  level: GraphLevel;
  /** `workspace` level: the selected directory (`` = the global group). */
  workspace?: string;
  /** `session` level: the selected session id. */
  session?: string;
  /** Freeze expiry clock (the panels pass nothing; the test pins one). */
  now?: number;
}

/** R1: `session` level shows at most eight nodes (the selected one included). */
export const GRAPH_NODE_LIMIT = 8;

/* ------------------------------------------------------------------ helpers */

/** The last path segment of a workspace, without `node:path` (window bundle). */
function baseName(directory: string): string {
  const parts = String(directory ?? '')
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : '';
}

/** Code-unit compare: deterministic on every machine (unlike `localeCompare`). */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNodes(left: GraphNode, right: GraphNode): number {
  return compareText(left.id, right.id);
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.from}\u0000${edge.kind}\u0000${edge.to}`;
}

function compareEdges(left: GraphEdge, right: GraphEdge): number {
  return compareText(edgeKey(left), edgeKey(right));
}

/**
 * The chain head of a forwarded hand-off, when the snapshot carries one.
 *
 * 0.8.0: `SnapshotHandoff.origin` is a plain string, written by `toHandoff` from
 * `record.origin.sid` (and omitted when it equals `from`). The two legacy
 * spellings are still tolerated so a **remote** server running an older
 * `rpc.ts` — which may pass the record's `origin` object through — cannot break
 * the graph. Nothing is invented: no `origin`, no edge.
 */
function originOf(handoff: SnapshotHandoff): string {
  const direct = typeof handoff.origin === 'string' ? handoff.origin.trim() : '';
  if (direct) return direct;
  // Tolerant read of a payload that still sends the record's object shape.
  const extra = handoff as unknown as { origin?: { sid?: string }; originSid?: string };
  const raw = extra.origin;
  if (raw && typeof raw === 'object' && raw.sid) return String(raw.sid).trim();
  return extra.originSid ? String(extra.originSid).trim() : '';
}

/** The session a hand-off spawned (`spawned`, falling back to `claimBy`). */
function spawnedBy(handoff: SnapshotHandoff): string {
  return String(handoff.spawned ?? handoff.claimBy ?? '');
}

/* ------------------------------------------------------------- relationship */

/**
 * Every relation at **session** granularity, sorted and de-duplicated:
 *
 *   - `handoff`  `from → claimBy` (a `kind:"spawn"` record is drawn as `spawn`
 *                instead, so one record never yields two edges to the same pair);
 *   - `origin`   `origin.sid → from` (the chain head, dashed);
 *   - `spawn`    `from → spawned` (falling back to `claimBy`);
 *   - `subagent` `parent → sid`.
 *
 * Same-pair edges of *different* kinds are kept (a spawn and a hand-off between
 * the same two sessions are two facts); identical `(from,kind,to)` triples are
 * folded to the first record, which is also how a re-sent hand-off stays one
 * line.
 */
function relationEdges(handoffs: SnapshotHandoff[], sessions: SnapshotSession[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const push = (edge: GraphEdge): void => {
    if (!edge.from || !edge.to || edge.from === edge.to) return;
    const key = edgeKey(edge);
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  for (const handoff of handoffs) {
    const from = String(handoff.from ?? '');
    if (handoff.kind === 'spawn') {
      push({ from, to: spawnedBy(handoff), kind: 'spawn', bid: handoff.bid, state: handoff.state });
    } else if (handoff.claimBy) {
      push({ from, to: String(handoff.claimBy), kind: 'handoff', bid: handoff.bid, state: handoff.state });
    }
    const origin = originOf(handoff);
    if (origin) push({ from: origin, to: from, kind: 'origin', bid: handoff.bid });
  }

  for (const session of sessions) {
    if (session.parent) push({ from: String(session.parent), to: session.sid, kind: 'subagent' });
  }

  return edges.sort(compareEdges);
}

/* ------------------------------------------------------------------- build */

/**
 * Build one level of the relation graph. `freezes` is the **live** freeze list
 * (`readFreezes(now)`); the panels pass `[]` because the snapshot already
 * resolved each session's marker — and an expired entry in a raw list is
 * dropped here too (`liveFreezes`), so the graph can never paint a freeze that
 * is already over.
 */
export function buildGraph(
  snapshot: Snapshot | undefined,
  freezes: FreezeEntry[] = [],
  options: GraphOptions
): GraphView {
  const level: GraphLevel = options?.level ?? 'global';
  const now = Number(options?.now) || Date.now();
  const sessions = snapshot?.sessions ?? [];
  const handoffs = snapshot?.handoffs ?? [];
  const live = liveFreezes(freezes, now);

  const bySid = new Map<string, SnapshotSession>();
  const dirOf = new Map<string, string>();
  const parentOf = new Map<string, string>();
  for (const session of sessions) {
    bySid.set(session.sid, session);
    dirOf.set(session.sid, session.workspace || '');
    if (session.parent) parentOf.set(session.sid, session.parent);
  }

  /** Urgent is a hand-off marker (the graph has no queue column of its own). */
  const urgent = new Set<string>();
  for (const handoff of handoffs) {
    if (handoff.priority !== 'urgent') continue;
    if (handoff.from) urgent.add(String(handoff.from));
    if (handoff.claimBy) urgent.add(String(handoff.claimBy));
  }

  const ancestorsOf = (sid: string): string[] => {
    const chain: string[] = [];
    const seen = new Set<string>([sid]);
    let parent = parentOf.get(sid) ?? '';
    while (parent && chain.length < 32 && !seen.has(parent)) {
      chain.push(parent);
      seen.add(parent);
      parent = parentOf.get(parent) ?? '';
    }
    return chain;
  };

  const frozenFor = (sid: string): SnapshotFreeze | undefined => {
    const info = bySid.get(sid);
    const marker = liveFreezeMarker(info?.frozen, now);
    if (marker) return marker;
    if (!live.length) return undefined;
    const hit = freezeFor(live, {
      session: sid,
      ancestors: ancestorsOf(sid),
      workspace: info?.workspace || ''
    });
    return hit ? freezeMarker(hit.entry) : undefined;
  };

  const sessionNode = (sid: string): GraphNode => {
    const info = bySid.get(sid);
    const frozen = frozenFor(sid);
    return {
      id: sid,
      kind: 'session',
      label: info?.title || sid,
      ...(info?.archived ? { archived: true } : {}),
      ...(frozen ? { frozen } : {}),
      ...(urgent.has(sid) ? { urgent: true } : {}),
      ...(info?.parent ? { parent: String(info.parent) } : {})
    };
  };

  const workspaceNode = (directory: string): GraphNode => ({
    id: directory,
    kind: 'workspace',
    label: baseName(directory)
  });

  if (level === 'session') {
    const center = String(options?.session ?? '');
    const neighbourIds = new Set<string>();
    const relations = relationEdges(handoffs, sessions);
    if (center) {
      for (const edge of relations) {
        if (edge.from === center) neighbourIds.add(edge.to);
        if (edge.to === center) neighbourIds.add(edge.from);
      }
      neighbourIds.delete(center);
    }
    let ids = [center, ...[...neighbourIds].sort(compareText)].filter(Boolean);
    if (!ids.length) return { nodes: [], edges: [], truncated: 0 };
    let truncated = 0;
    if (ids.length > GRAPH_NODE_LIMIT) {
      truncated = ids.length - GRAPH_NODE_LIMIT;
      ids = ids.slice(0, GRAPH_NODE_LIMIT);
    }
    const keep = new Set(ids);
    return {
      nodes: ids.map(sessionNode).sort(compareNodes),
      edges: relations.filter(edge => keep.has(edge.from) && keep.has(edge.to)),
      truncated
    };
  }

  if (level === 'workspace') {
    const workspace = String(options?.workspace ?? '');
    const localIds = new Set(
      sessions.filter(session => (session.workspace || '') === workspace).map(session => session.sid)
    );
    if (!localIds.size) return { nodes: [], edges: [], truncated: 0 };

    const nodes: GraphNode[] = [...localIds].map(sessionNode);
    const ghosts = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    const push = (edge: GraphEdge): void => {
      const key = edgeKey(edge);
      if (seen.has(key)) return;
      seen.add(key);
      edges.push(edge);
    };

    for (const edge of relationEdges(handoffs, sessions)) {
      const fromLocal = localIds.has(edge.from);
      const toLocal = localIds.has(edge.to);
      if (!fromLocal && !toLocal) continue;
      if (fromLocal && toLocal) {
        push(edge);
        continue;
      }
      // One end left the workspace: land on that workspace's node instead of a
      // session the workspace level never expands (rpc.ts has no directory for
      // an unlisted session, so an unknown counterpart is dropped rather than
      // guessed onto this workspace).
      const outside = fromLocal ? edge.to : edge.from;
      const outsideWorkspace = dirOf.get(outside);
      if (outsideWorkspace === undefined || outsideWorkspace === workspace) continue;
      if (!ghosts.has(outsideWorkspace)) ghosts.set(outsideWorkspace, workspaceNode(outsideWorkspace));
      push(fromLocal ? { ...edge, to: outsideWorkspace } : { ...edge, from: outsideWorkspace });
    }

    return {
      nodes: [...nodes, ...ghosts.values()].sort(compareNodes),
      edges: edges.sort(compareEdges),
      truncated: 0
    };
  }

  // `global`: workspaces are the nodes, cross-workspace hand-offs the edges.
  // `handoff.workspace` is the **target** directory on a peer record (see
  // `tools/broadcast.ts`), so a record whose counterpart session is on another
  // server still lands on a real workspace node; a local session's directory
  // wins when both are known.
  const workspaceNodes = new Map<string, GraphNode>();
  const addWorkspace = (directory: string): void => {
    if (!workspaceNodes.has(directory)) workspaceNodes.set(directory, workspaceNode(directory));
  };
  for (const session of sessions) addWorkspace(session.workspace || '');

  const pairs = new Map<string, { from: string; to: string; count: number }>();
  for (const handoff of handoffs) {
    const from = String(handoff.from ?? '');
    const target = spawnedBy(handoff);
    if (!from || !target) continue;
    const fromWorkspace = dirOf.get(from) ?? '';
    const toWorkspace = dirOf.get(target) ?? (handoff.workspace ? String(handoff.workspace) : fromWorkspace);
    if (fromWorkspace === toWorkspace) continue;
    addWorkspace(fromWorkspace);
    addWorkspace(toWorkspace);
    const key = `${fromWorkspace}\u0000${toWorkspace}`;
    const pair = pairs.get(key);
    if (pair) pair.count += 1;
    else pairs.set(key, { from: fromWorkspace, to: toWorkspace, count: 1 });
  }

  const edges: GraphEdge[] = [...pairs.values()]
    .map(pair => ({ from: pair.from, to: pair.to, kind: 'handoff' as const, count: pair.count }))
    .sort(compareEdges);

  return {
    nodes: [...workspaceNodes.values()].sort(compareNodes),
    edges,
    truncated: 0
  };
}
