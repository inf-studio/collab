/**
 * 0.8.2 (`graph-zoom`): **where** the relation graph's boxes go, and **how** a
 * zoom / pan gesture maps onto the SVG `viewBox`.
 *
 * Why a file of its own: the 0.8.0 layout was one ring of a fixed 320×180 canvas
 * with labels up to 14 characters — with six or more nodes the label boxes and
 * the edges crossed each other (the screenshot in the task: `定点复核 P2/P3 修…`
 * painted over its neighbour). Both halves of the fix are pure arithmetic, so
 * they live here, next to `core/graph.ts` (the derivation) instead of inside the
 * GUI bundle:
 *
 *   - `layoutGraph(nodes)` — the renderer-independent positions: a centre node,
 *     an inner ring of at most six, an outer ring for the rest, every label cut
 *     to `GRAPH_LABEL_MAX` code points, and a **verified** non-overlap guarantee
 *     (the ring layout is accepted only if no two boxes touch; otherwise a
 *     deterministic grid is used, which cannot overlap at these counts);
 *   - `viewBoxOf` / `zoomBy` / `clampPan` / `clampZoom` — the view transform.
 *
 * Contracts kept from 0.8.0:
 *
 *   - **deterministic (R4)**: no clock, no randomness, no `localeCompare`; the
 *     same node array yields byte-identical numbers, and rounding happens once
 *     (`round1`) so a float difference can never leak into the SVG;
 *   - **view-only (R5)**: zoom / pan are numbers the renderer feeds to
 *     `viewBox`; no node coordinate, no graph data and no file is touched. The
 *     layout is a pure function of the nodes, so the 2 s poll can never "move"
 *     a node because the pointer moved;
 *   - **read-only**: nothing here writes anything anywhere.
 *
 * This module is part of the GUI bundle: it must not import `node:*` (the window
 * has no filesystem). It imports `GraphNode` as a **type** only.
 */
import type { GraphNode } from './graph.ts';

export interface GraphPoint {
  x: number;
  y: number;
}

export interface GraphSize {
  width: number;
  height: number;
}

/**
 * The coordinate space the SVG draws in (R3: 320×180 → 640×360). CSS scales the
 * viewBox to the pane width; zooming shrinks the viewBox, it never changes these
 * numbers.
 */
export const GRAPH_VIEW: GraphSize = { width: 640, height: 360 };

/** R3: every label is cut to this many code points (the `…` included). */
export const GRAPH_LABEL_MAX = 8;

/** The node box's height, and the width every node reserves for its badge. */
export const GRAPH_BOX_H = 22;
export const GRAPH_BOX_MIN_W = 44;
export const GRAPH_BOX_MAX_W = 96;
/** Reserved on the right of the label for the `▸/▾` badge. */
export const GRAPH_BADGE_W = 12;
/** The minimum blank space the layout tries to keep between two boxes. */
export const GRAPH_GAP = 6;

/** R1: the zoom range, and the share of the canvas the view may leave blank. */
export const GRAPH_ZOOM_MIN = 0.6;
export const GRAPH_ZOOM_MAX = 2.5;
export const GRAPH_PAN_MARGIN = 0.1;

/** Ring radii (an ellipse: the canvas is 16:9, a circle would waste the sides). */
const INNER_RX = 124;
const INNER_RY = 84;
const OUTER_RX = 252;
const OUTER_RY = 148;
/** R3: the inner ring is capped at six nodes; the outer ring takes the rest. */
export const GRAPH_INNER_RING = 6;
/** Above this node count the ring layout is not attempted (grid fallback). */
const RING_LIMIT = 40;
/** Grid columns for the fallback (plus the derived rows). */
const GRID_COLS = 6;

/* ------------------------------------------------------------------ labels */

/** One code point's estimated advance at `font-size: 9px`. */
function charWidth(code: number): number {
  const wide =
    (code >= 0x1100 && code <= 0x115f) || // hangul jamo
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK radicals … yi
    (code >= 0xac00 && code <= 0xd7a3) || // hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK compatibility forms
    (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff); // emoji (double-width on most hosts)
  return wide ? 9 : 5.4;
}

/**
 * R3: cut a label to `max` **code points**, the ellipsis included (`…` is the
 * 8th). Code points, not code units: slicing a surrogate pair would print a
 * broken half-emoji. An empty label stays empty (the GUI substitutes its own
 * word for the `''` workspace *before* calling this).
 */
export function truncateLabel(text: string, max: number = GRAPH_LABEL_MAX): string {
  const limit = Math.max(1, Math.floor(Number(max) || GRAPH_LABEL_MAX));
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= limit) return chars.join('');
  if (limit === 1) return '…';
  return `${chars.slice(0, limit - 1).join('')}…`;
}

/** The estimated printed width of an (already truncated) label, in SVG units. */
export function labelWidth(text: string): number {
  let total = 0;
  for (const char of Array.from(String(text ?? ''))) total += charWidth(char.codePointAt(0) ?? 0);
  return Math.round(total * 10) / 10;
}

/** The box width a truncated label needs: text + padding + the `▸/▾` badge. */
export function boxWidth(text: string): number {
  const width = Math.ceil(labelWidth(text)) + 12 + GRAPH_BADGE_W;
  return Math.min(GRAPH_BOX_MAX_W, Math.max(GRAPH_BOX_MIN_W, width));
}

/* ------------------------------------------------------------------ layout */

export interface GraphLayoutOptions {
  width?: number;
  height?: number;
  /**
   * The node to put at the centre (`session` level: the selected session). When
   * absent — or not in the list — the first node of the (already sorted) array
   * takes the centre.
   */
  center?: string;
  /** Substitute the printed text (the GUI translates the `''` workspace first). */
  label?: (node: GraphNode) => string;
}

export interface GraphLayout {
  /** Node id → the **centre** of its box (the rect is `[-w/2, -h/2]` around it). */
  points: Map<string, GraphPoint>;
  /** Node id → the text to print (never longer than `GRAPH_LABEL_MAX`). */
  labels: Map<string, string>;
  /** Node id → its box width; the height is always `GRAPH_BOX_H`. */
  widths: Map<string, number>;
  width: number;
  height: number;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function toPositive(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** Centre-first order, the rest in the caller's (sorted) order. */
function orderNodes(nodes: GraphNode[], center?: string): GraphNode[] {
  if (!center) return [...nodes];
  const index = nodes.findIndex(node => node.id === center);
  if (index <= 0) return [...nodes];
  return [nodes[index]!, ...nodes.filter((_, position) => position !== index)];
}

/** Two boxes overlap iff their half-extents intersect on **both** axes. */
function overlaps(
  a: GraphPoint,
  aw: number,
  b: GraphPoint,
  bw: number,
  height: number
): boolean {
  return Math.abs(a.x - b.x) < (aw + bw) / 2 && Math.abs(a.y - b.y) < height;
}

function isDisjoint(
  points: Map<string, GraphPoint>,
  order: GraphNode[],
  widths: Map<string, number>,
  boxHeight: number
): boolean {
  for (let i = 0; i < order.length; i += 1) {
    const a = points.get(order[i]!.id);
    if (!a) return false;
    for (let j = i + 1; j < order.length; j += 1) {
      const b = points.get(order[j]!.id);
      if (!b) return false;
      if (overlaps(a, widths.get(order[i]!.id) ?? GRAPH_BOX_MIN_W, b, widths.get(order[j]!.id) ?? GRAPH_BOX_MIN_W, boxHeight)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Centre + inner ring (≤ 6) + outer ring. Radius is a constant ellipse: the
 * 0.8.0 bug was not "a ring is wrong", it was "one ring for any count, and
 * labels twice as long as the box".
 */
function ringPoints(
  order: GraphNode[],
  size: GraphSize
): Map<string, GraphPoint> {
  const points = new Map<string, GraphPoint>();
  const cx = size.width / 2;
  const cy = size.height / 2;
  points.set(order[0]!.id, { x: round1(cx), y: round1(cy) });
  const rest = order.slice(1);
  const inner = rest.slice(0, GRAPH_INNER_RING);
  const outer = rest.slice(GRAPH_INNER_RING);
  const place = (list: GraphNode[], rx: number, ry: number): void => {
    list.forEach((node, index) => {
      const angle = -Math.PI / 2 + (index * 2 * Math.PI) / list.length;
      points.set(node.id, {
        x: round1(cx + rx * Math.cos(angle)),
        y: round1(cy + ry * Math.sin(angle))
      });
    });
  };
  if (inner.length) place(inner, INNER_RX, INNER_RY);
  if (outer.length) place(outer, OUTER_RX, OUTER_RY);
  return points;
}

/** The deterministic fallback: a 6-column grid of cell centres. */
function gridPoints(order: GraphNode[], size: GraphSize): Map<string, GraphPoint> {
  const points = new Map<string, GraphPoint>();
  const cols = Math.min(GRID_COLS, Math.max(1, order.length));
  const rows = Math.ceil(order.length / cols);
  const cellW = size.width / cols;
  const cellH = size.height / rows;
  order.forEach((node, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    points.set(node.id, {
      x: round1((col + 0.5) * cellW),
      y: round1((row + 0.5) * cellH)
    });
  });
  return points;
}

/**
 * R3: the one layout both levels use. Pure, deterministic, and **verified**:
 * the ring arrangement is returned only when no two boxes overlap; otherwise the
 * grid (which cannot overlap up to `6 × 16 = 96` nodes) is returned. A caller
 * therefore never has to reason about "is this count safe?" — the test asserts
 * the same property from the outside.
 */
export function layoutGraph(nodes: GraphNode[], options: GraphLayoutOptions = {}): GraphLayout {
  const size: GraphSize = {
    width: toPositive(options.width, GRAPH_VIEW.width),
    height: toPositive(options.height, GRAPH_VIEW.height)
  };
  const labels = new Map<string, string>();
  const widths = new Map<string, number>();
  for (const node of nodes) {
    const source = options.label ? options.label(node) : node.label;
    const text = truncateLabel(String(source ?? ''));
    labels.set(node.id, text);
    widths.set(node.id, boxWidth(text));
  }

  const points = new Map<string, GraphPoint>();
  const layout: GraphLayout = { points, labels, widths, width: size.width, height: size.height };
  if (!nodes.length) return layout;

  const order = orderNodes(nodes, options.center);
  const ringed = order.length <= RING_LIMIT ? ringPoints(order, size) : undefined;
  const chosen =
    ringed && isDisjoint(ringed, order, widths, GRAPH_BOX_H) ? ringed : gridPoints(order, size);
  for (const [id, point] of chosen) points.set(id, point);
  return layout;
}

/* -------------------------------------------------------------------- zoom */

export interface GraphBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphPointer {
  x: number;
  y: number;
}

/** What `getBoundingClientRect()` answers — the only thing zoom needs from the DOM. */
export interface GraphRect {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** R1: 0.6×–2.5×; a non-number (a wheel event without `deltaY`) means 1×. */
export function clampZoom(zoom: number): number {
  const value = Number(zoom);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(GRAPH_ZOOM_MAX, Math.max(GRAPH_ZOOM_MIN, value));
}

/**
 * The `viewBox` a zoom / pan pair maps to.
 *
 * `pan` is the view **centre's** offset from the canvas centre, in view units, so
 * `{0,0}` at any zoom means "centred". The box is clamped so that the canvas can
 * be left blank by at most `GRAPH_PAN_MARGIN` of its size on each side. When the
 * view is larger than the canvas **plus** both margins (`zoom` clearly below 1)
 * there is nothing left to reveal by panning, and the box is pinned centred
 * instead of being clamped to an inverted range.
 */
export function viewBoxOf(zoom: number, pan: GraphPoint, size: GraphSize = GRAPH_VIEW): GraphBox {
  const z = clampZoom(zoom);
  const width = size.width / z;
  const height = size.height / z;
  const centeredX = (size.width - width) / 2;
  const centeredY = (size.height - height) / 2;
  const marginX = size.width * GRAPH_PAN_MARGIN;
  const marginY = size.height * GRAPH_PAN_MARGIN;
  const minX = -marginX;
  const maxX = size.width - width + marginX;
  const minY = -marginY;
  const maxY = size.height - height + marginY;
  const x = minX > maxX ? centeredX : clampNumber(centeredX + (Number(pan?.x) || 0), minX, maxX);
  const y = minY > maxY ? centeredY : clampNumber(centeredY + (Number(pan?.y) || 0), minY, maxY);
  return { x, y, width, height };
}

/**
 * R2: the pan a (possibly out-of-range) gesture resolves to. Derived from the
 * clamped box, so `clampPan` and `viewBoxOf` can never disagree — the drag path,
 * the wheel path and the reset path share one rule.
 */
export function clampPan(pan: GraphPoint, zoom: number, size: GraphSize = GRAPH_VIEW): GraphPoint {
  const box = viewBoxOf(zoom, pan, size);
  return { x: box.x + box.width / 2 - size.width / 2, y: box.y + box.height / 2 - size.height / 2 };
}

/** The exact string the SVG's `viewBox` attribute carries (stable 1-decimal rounding). */
export function viewBoxAttr(box: GraphBox): string {
  return `${round1(box.x)} ${round1(box.y)} ${round1(box.width)} ${round1(box.height)}`;
}

/**
 * R1: one wheel / pinch step, **around the pointer**. The graph point under the
 * pointer stays under the pointer (that is what makes zooming feel like zooming
 * and not like a slider), then the pan is clamped (R2) — so a zoom near an edge
 * slides the view back instead of exposing the page background.
 *
 * `deltaY < 0` (wheel up / pinch out) zooms in. The factor is exponential so a
 * trackpad's many small deltas and a mouse's one big notch travel the same
 * distance; the result is passed through `clampZoom`, never unbounded.
 */
export function zoomBy(
  zoom: number,
  pan: GraphPoint,
  deltaY: number,
  pointer: GraphPointer,
  rect?: GraphRect,
  size: GraphSize = GRAPH_VIEW
): { zoom: number; pan: GraphPoint } {
  const current = clampZoom(zoom);
  const factor = Math.exp(-(Number(deltaY) || 0) / 500);
  const next = clampZoom(current * factor);
  if (Math.abs(next - current) < 1e-6) return { zoom: next, pan: clampPan(pan, next, size) };

  // Where in the *view* the pointer sits (0…1 on each axis).
  const rectWidth = toPositive(rect?.width, size.width);
  const rectHeight = toPositive(rect?.height, size.height);
  const fx = clampNumber(((Number(pointer?.x) || 0) - (Number(rect?.left) || 0)) / rectWidth, 0, 1);
  const fy = clampNumber(((Number(pointer?.y) || 0) - (Number(rect?.top) || 0)) / rectHeight, 0, 1);

  const before = viewBoxOf(current, pan, size);
  // The graph coordinate under the pointer must not move.
  const graphX = before.x + fx * before.width;
  const graphY = before.y + fy * before.height;
  const nextWidth = size.width / next;
  const nextHeight = size.height / next;
  const nextX = graphX - fx * nextWidth;
  const nextY = graphY - fy * nextHeight;
  return {
    zoom: next,
    pan: clampPan(
      { x: nextX + nextWidth / 2 - size.width / 2, y: nextY + nextHeight / 2 - size.height / 2 },
      next,
      size
    )
  };
}
