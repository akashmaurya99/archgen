// graph-grouped.ts — every component on ONE shared canvas.
//
// Radial: each component becomes its own ring (kind-clustered). Flow: each
// component gets an isolated dagre block. Rings/blocks are shelf-packed
// (3 per row) so the full graph renders as a single pannable canvas with
// zero interleaving between components.
import {
  CODE_FLOW_LAYOUT,
  CODE_NODE_HEIGHT,
  CODE_NODE_WIDTH,
  UNLINKED_COMPONENT_ID,
  colorForKind,
  connectedComponents,
  layoutRadial,
  type GraphEdgeLike,
  type GraphNodeLike,
  type RadialPlacement,
} from './graph-model';
import { layoutLeftToRight, type Positioned } from './layout';

const GROUP_GAP = 320;
const GROUPS_PER_ROW = 3;
const UNLINKED_COLS = 6;
const UNLINKED_CELL_W = CODE_NODE_WIDTH + 24;
const UNLINKED_CELL_H = CODE_NODE_HEIGHT + 20;

/** Ring radius sized so adjacent cards never overlap: 2πR ≥ n·(W+gap). */
function ringRadiusFor(nodeCount: number): number {
  return Math.max(280, Math.ceil((nodeCount * (CODE_NODE_WIDTH + 40)) / (2 * Math.PI)));
}

function ringPad(): number {
  return 96 + Math.max(CODE_NODE_WIDTH, CODE_NODE_HEIGHT) / 2 + 8;
}

function unlinkedBox(nodeCount: number): { width: number; height: number } {
  const cols = Math.min(UNLINKED_COLS, Math.ceil(Math.sqrt(nodeCount)) || 1);
  const rows = Math.ceil(nodeCount / cols) || 1;
  return { width: cols * UNLINKED_CELL_W, height: rows * UNLINKED_CELL_H };
}

export interface GroupRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  nodeCount: number;
}

interface ShelfBox {
  width: number;
  height: number;
}

function shelfPack(boxes: readonly ShelfBox[], gap: number): Array<{ x: number; y: number; width: number; height: number }> {
  const rows: ShelfBox[][] = [];
  for (let i = 0; i < boxes.length; i += GROUPS_PER_ROW) {
    const row = boxes.slice(i, i + GROUPS_PER_ROW);
    if (row.length > 0) rows.push(row);
  }
  let y = 0;
  const out: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const row of rows) {
    let x = 0;
    let rowHeight = 0;
    for (const b of row) {
      out.push({ x, y, width: b.width, height: b.height });
      x += b.width + gap;
      rowHeight = Math.max(rowHeight, b.height);
    }
    y += rowHeight + gap;
  }
  return out;
}

interface Bounds {
  width: number;
  height: number;
}

function boundsOf(positions: ReadonlyArray<{ position: { x: number; y: number } }>): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of positions) {
    minX = Math.min(minX, p.position.x);
    minY = Math.min(minY, p.position.y);
    maxX = Math.max(maxX, p.position.x + CODE_NODE_WIDTH);
    maxY = Math.max(maxY, p.position.y + CODE_NODE_HEIGHT);
  }
  if (minX === Infinity) return { width: 0, height: 0 };
  return { width: maxX - minX, height: maxY - minY };
}

function shift<T extends { position: { x: number; y: number } }>(items: readonly T[], dx: number, dy: number): T[] {
  return items.map((it) => ({ ...it, position: { x: it.position.x + dx, y: it.position.y + dy } }));
}

export interface GroupRegion extends Bounds {
  id: string;
  x: number;
  y: number;
  nodeCount: number;
}

export interface GroupedLayout {
  placements: Array<
    GraphNodeLike & {
      position: { x: number; y: number };
      componentId: string;
      face?: 'left' | 'right' | 'top' | 'bottom';
      anchor?: { x: number; y: number };
      angle?: number;
    }
  >;
  circles: Array<{ cx: number; cy: number; r: number }>;
  anchors: Array<{ x: number; y: number; color: string }>;
  labels: Array<{ x: number; y: number; text: string }>;
  regions: GroupRegion[];
  width: number;
  height: number;
}

export function layoutRadialGrouped(
  nodes: readonly GraphNodeLike[],
  edges: readonly GraphEdgeLike[],
  opts: { groupByKind?: boolean } = {},
): GroupedLayout {
  const comps = connectedComponents(nodes, edges);
  const packed = shelfPack(
    comps.map((c) => (c.id === UNLINKED_COMPONENT_ID ? unlinkedBox(c.nodes.length) : (() => {
      const r = ringRadiusFor(c.nodes.length);
      const size = 2 * (r + ringPad());
      return { width: size, height: size };
    })())),
    GROUP_GAP,
  );
  const width = packed.reduce((m, b) => Math.max(m, b.x + b.width), 0);
  const height = packed.reduce((m, b) => Math.max(m, b.y + b.height), 0);

  const placements: GroupedRadialResult['placements'] = [];
  const circles: GroupedRadialResult['circles'] = [];
  const labels: GroupedRadialResult['labels'] = [];
  const anchors: GroupedRadialResult['anchors'] = [];
  const regions: GroupRegion[] = [];

  comps.forEach((comp, ci) => {
    const box = packed[ci];
    if (box === undefined) return;
    if (comp.id === UNLINKED_COMPONENT_ID) {
      const cols = Math.min(UNLINKED_COLS, Math.ceil(Math.sqrt(comp.nodes.length)) || 1);
      comp.nodes.forEach((n, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        placements.push({
          ...n,
          componentId: comp.id,
          position: { x: box.x + 12 + col * UNLINKED_CELL_W, y: box.y + 10 + row * UNLINKED_CELL_H },
          anchor: { x: box.x + 12 + col * UNLINKED_CELL_W + 6, y: box.y + 10 + row * UNLINKED_CELL_H },
          angle: 0,
          face: 'left',
        });
      });
    } else {
      const r = ringRadiusFor(comp.nodes.length);
      const local = layoutRadial(comp.nodes, { radius: r, cardOffset: 96, groupByKind: opts.groupByKind });
      const localBounds = boundsOf(local);
      const dx = box.x + (box.width - localBounds.width) / 2;
      const dy = box.y + (box.height - localBounds.height) / 2;
      const shifted = shift(local, dx, dy);
      const ringCx = box.x + box.width / 2;
      const ringCy = box.y + box.height / 2;
      circles.push({ cx: ringCx, cy: ringCy, r });
      labels.push({ x: ringCx, y: ringCy - r - 18, text: `${comp.id} · ${comp.nodes.length}` });
      for (const p of shifted) {
        const rad = (p.angle * Math.PI) / 180;
        anchors.push({ x: ringCx + r * Math.cos(rad), y: ringCy + r * Math.sin(rad), color: colorForKind(p.kind) });
      }
      for (const p of shifted) {
        placements.push(Object.assign(p, { componentId: comp.id }));
      }
    }
    if (comp.id === UNLINKED_COMPONENT_ID) {
      labels.push({ x: box.x + 12, y: box.y + 2, text: `loose · ${comp.nodes.length}` });
    }
    regions.push({ id: comp.id, x: box.x, y: box.y, width: box.width, height: box.height, nodeCount: comp.nodes.length });
  });

  return { placements, circles, anchors, labels, regions, width, height };
}

export type GroupedRadialResult = GroupedLayout;
export type GroupedFlowResult = GroupedLayout;

export function layoutFlowGrouped(
  nodes: readonly GraphNodeLike[],
  edges: readonly GraphEdgeLike[],
): GroupedFlowResult {
  const comps = connectedComponents(nodes, edges);
  // ONE dagre pass per component: the sizing pass caches each layout + bounds
  // keyed by component id, and the placement pass reuses them. Same inputs,
  // same output — dagre is deterministic, so re-running it (former behavior)
  // was pure waste: 2× the layout cost on every search/filter relayout.
  const dagreByComp = new Map<string, { laid: Array<GraphNodeLike & Positioned>; bounds: Bounds }>();
  const packed = shelfPack(
    comps.map((c) => {
      if (c.id === UNLINKED_COMPONENT_ID) return unlinkedBox(c.nodes.length);
      const laid = layoutLeftToRight(c.nodes, c.edges, {
        nodeWidth: CODE_NODE_WIDTH,
        nodeHeight: CODE_NODE_HEIGHT,
        rankSep: CODE_FLOW_LAYOUT.rankSep,
        nodeSep: CODE_FLOW_LAYOUT.nodeSep,
      });
      const bounds = boundsOf(laid);
      dagreByComp.set(c.id, { laid, bounds });
      return { width: bounds.width + 80, height: bounds.height + 80 };
    }),
    GROUP_GAP,
  );
  const width = packed.reduce((m, b) => Math.max(m, b.x + b.width), 0);
  const height = packed.reduce((m, b) => Math.max(m, b.y + b.height), 0);

  const placements: GroupedFlowResult['placements'] = [];
  const labels: GroupedFlowResult['labels'] = [];
  const regions: GroupRegion[] = [];

  comps.forEach((comp, ci) => {
    const box = packed[ci];
    if (box === undefined) return;
    if (comp.id === UNLINKED_COMPONENT_ID) {
      const cols = Math.min(UNLINKED_COLS, Math.ceil(Math.sqrt(comp.nodes.length)) || 1);
      comp.nodes.forEach((n, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        placements.push({
          ...n,
          componentId: comp.id,
          position: { x: box.x + 12 + col * UNLINKED_CELL_W, y: box.y + 10 + row * UNLINKED_CELL_H },
        });
      });
    } else {
      const cached = dagreByComp.get(comp.id);
      // Populated by the sizing pass above for EVERY non-unlinked component
      // before this loop starts — a miss is impossible; guard keeps TS honest.
      // shift() copies, so the cached layouts are never mutated by componentId.
      if (cached) {
        const shifted = shift(
          cached.laid,
          box.x + (box.width - cached.bounds.width) / 2,
          box.y + (box.height - cached.bounds.height) / 2,
        );
        for (const p of shifted) {
          placements.push(Object.assign(p, { componentId: comp.id }));
        }
      }
    }
    labels.push({ x: box.x + 12, y: box.y + 2, text: comp.id === UNLINKED_COMPONENT_ID ? `loose · ${comp.nodes.length}` : `${comp.id} · ${comp.nodes.length}` });
    regions.push({ id: comp.id, x: box.x, y: box.y, width: box.width, height: box.height, nodeCount: comp.nodes.length });
  });

  return { placements, regions, width, height, circles: [], anchors: [], labels };
}

/* ==== CODE GRAPH · size-tier auto-mode + zoom LOD — NEW SECTION START ====
   Scale tiers chosen by the LARGEST connected component's symbol count:
   ≤60 → radial rings (unchanged default), 61–300 → file-hub dagre,
   >300 → file-hub focused on the top hub's file neighborhood. When the host
   has not supplied a fileRollup the view falls back to legacy behavior
   entirely ('radial' tier). Also hosts the pure zoom-LOD ladder shared by
   the view and its tests (quantized to avoid render storms). */

/** Rollup of symbols per file + aggregated cross-file edges (host-computed). */
export interface FileRollupEntry {
  file: string;
  symbols: number;
  kinds: Record<string, number>;
}
export interface FileRollupEdge {
  /** file PATH of the edge endpoint (matches FileRollupEntry.file) */
  source: string;
  target: string;
  kind: string;
  /** how many symbol-level edges collapsed into this file pair */
  count: number;
}
export interface FileRollupTotals {
  files: number;
  symbols: number;
  edges: number;
}
export interface FileRollup {
  files: FileRollupEntry[];
  edges: FileRollupEdge[];
  totals: FileRollupTotals;
}

/** High-degree symbol flagged by the host for focus-first seeding. */
export interface HubEntry {
  id: string;
  label: string;
  kind: string;
  file: string;
  degree: number;
}

export type GraphSizeTier = 'radial' | 'file-hub' | 'focus-first';

export const RADIAL_TIER_MAX_NODES = 60;
export const HUB_TIER_MAX_NODES = 300;
/** focus-first initial canvas shows at most this many FILE nodes. */
export const FOCUS_FILE_CAP = 40;

/** Final path segment — file-hub node labels. */
export function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/**
 * Size-tier selection. `rollup` absent → 'radial' (legacy behavior for ANY
 * size). Otherwise the largest component's node count decides:
 * ≤60 radial · ≤300 file-hub · else focus-first.
 */
export function selectSizeTier(
  nodes: readonly GraphNodeLike[],
  edges: readonly GraphEdgeLike[],
  rollup?: FileRollup | null,
): GraphSizeTier {
  if (!rollup || rollup.files.length === 0 || nodes.length === 0) return 'radial';
  let largest = 0;
  for (const comp of connectedComponents(nodes, edges)) {
    if (comp.nodes.length > largest) largest = comp.nodes.length;
  }
  if (largest <= RADIAL_TIER_MAX_NODES) return 'radial';
  if (largest <= HUB_TIER_MAX_NODES) return 'file-hub';
  return 'focus-first';
}

/** Synthetic symbol-graph node for one file (id = the file PATH so rollup
 *  edges route without translation; label = basename; kind = 'file'). */
export function fileNodeFor(entry: FileRollupEntry): GraphNodeLike {
  return { id: entry.file, label: basename(entry.file), kind: 'file', file: entry.file, line: 0 };
}

export function buildFileNodes(rollup: FileRollup): GraphNodeLike[] {
  return rollup.files.map(fileNodeFor);
}

/**
 * Highest-degree hub (degree DESC, id ASC tie-break); null when absent/empty.
 * Defensive max-scan — the host is expected to send hubs pre-sorted.
 */
export function pickTopHub(hubs?: readonly HubEntry[] | null): HubEntry | null {
  if (!hubs || hubs.length === 0) return null;
  let top = hubs[0]!;
  for (const h of hubs) {
    if (h.degree > top.degree || (h.degree === top.degree && h.id < top.id)) top = h;
  }
  return top;
}

/**
 * BFS over undirected file edges from `hubFile`, returning at most `cap` file
 * paths (hub first, then neighbors outward). Pure.
 */
export function focusNeighborhoodFiles(
  hubFile: string,
  fileEdges: readonly FileRollupEdge[],
  cap: number = FOCUS_FILE_CAP,
): string[] {
  const adjacency = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const list = adjacency.get(a);
    if (list) list.push(b);
    else adjacency.set(a, [b]);
  };
  for (const e of fileEdges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }
  const visited = new Set<string>([hubFile]);
  const order: string[] = [hubFile];
  for (let head = 0; head < order.length && order.length < cap; head++) {
    for (const next of adjacency.get(order[head]!) ?? []) {
      if (order.length >= cap) break;
      if (!visited.has(next)) {
        visited.add(next);
        order.push(next);
      }
    }
  }
  return order;
}

/* ---- Zoom Level-of-Detail ladder (pure; consumed by view + tests) ---- */

export type LodTier = 'dot' | 'mid' | 'full';
/** Zoom quantization step — prevents render storms during smooth zooming. */
export const LOD_ZOOM_STEP = 0.05;
/** Below this quantized zoom nodes collapse to dots. */
export const LOD_DOT_MAX = 0.35;
/** At or below this zoom captions hide; strictly above = full cards. */
export const LOD_FULL_MIN = 0.7;
/** Undirected degree at which a node is a hub (keeps its label at all zooms). */
export const HUB_DEGREE_THRESHOLD = 5;

/** Snap zoom to LOD_ZOOM_STEP grid (3-decimal safe against float drift). */
export function quantizeZoom(zoom: number): number {
  const snapped = Math.round(zoom / LOD_ZOOM_STEP) * LOD_ZOOM_STEP;
  return Math.round(snapped * 1000) / 1000;
}

/** Raw tier for a (quantized) zoom value: <0.35 dot · ≤0.70 mid · else full. */
export function lodTierFor(zoom: number): LodTier {
  if (zoom < LOD_DOT_MAX) return 'dot';
  if (zoom <= LOD_FULL_MIN) return 'mid';
  return 'full';
}

/** Hubs never drop below 'mid' — their label persists at every zoom. */
export function adjustLodForHub(tier: LodTier, isHub: boolean): LodTier {
  return isHub && tier === 'dot' ? 'mid' : tier;
}

/** Undirected degree per node id from routed edges. */
export function degreeMap(edges: readonly GraphEdgeLike[]): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const e of edges) {
    degrees.set(e.source, (degrees.get(e.source) ?? 0) + 1);
    degrees.set(e.target, (degrees.get(e.target) ?? 0) + 1);
  }
  return degrees;
}
/* ==== CODE GRAPH · size-tier auto-mode + zoom LOD — NEW SECTION END ==== */
