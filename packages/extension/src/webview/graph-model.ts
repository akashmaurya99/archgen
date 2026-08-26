// graph-model.ts — pure helpers for the CODE dependency-graph tab (todo 12).
// No React/DOM imports so every function is unit-testable in plain node env.

export const EDGE_KINDS = ['calls', 'imports', 'extends', 'implements', 'references'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface GraphNodeLike {
  id: string;
  label: string;
  kind: string;
  file: string;
  line: number;
}

export interface GraphEdgeLike {
  source: string;
  target: string;
  kind: string;
}

/** Kind → CSS-var color; unknown kinds hash into a stable fallback palette. */
export const KIND_COLORS: Record<string, string> = {
  class: 'var(--archgen-kind-class, #58a6ff)',
  interface: 'var(--archgen-kind-interface, #39c5cf)',
  function: 'var(--archgen-kind-function, #bc8cff)',
  method: 'var(--archgen-kind-method, #bc8cff)',
  module: 'var(--archgen-kind-module, #f2cc60)',
  file: 'var(--archgen-kind-file, #8b949e)',
  variable: 'var(--archgen-kind-variable, #7ee787)',
  constant: 'var(--archgen-kind-constant, #7ee787)',
};

const FALLBACK_PALETTE = ['#58a6ff', '#bc8cff', '#39c5cf', '#f2cc60', '#7ee787', '#ff7b72', '#8b949e'];

export function colorForKind(kind: string): string {
  const known = KIND_COLORS[kind];
  if (known) return known;
  let h = 0;
  for (let i = 0; i < kind.length; i++) h = (h * 31 + kind.charCodeAt(i)) >>> 0;
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length] ?? FALLBACK_PALETTE[0]!;
}

/** Edges whose kind is enabled. Unknown edge kinds always pass through. */
export function filterEdges<E extends GraphEdgeLike>(edges: readonly E[], enabled: ReadonlySet<string>): E[] {
  return edges.filter((e) => !EDGE_KINDS.includes(e.kind as EdgeKind) || enabled.has(e.kind));
}

/**
 * Search debounce window for the CODE tab input: filtering (and the
 * connectedComponents + dagre relayout it triggers) runs on the DEBOUNCED
 * query, so a burst of keystrokes costs one relayout, not one per key.
 */
export const SEARCH_DEBOUNCE_MS = 200;

/** Case-insensitive substring match on label + id + file. */
export function matchesQuery(n: GraphNodeLike, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q) || n.file.toLowerCase().includes(q);
}

/**
 * Direct neighborhood of `id`: the node itself plus every node one hop away,
 * and the indexes of the connecting edges.
 */
export function neighborhoodOf(
  edges: readonly GraphEdgeLike[],
  id: string,
): { nodeIds: Set<string>; edgeIdx: Set<number> } {
  const nodeIds = new Set<string>([id]);
  const edgeIdx = new Set<number>();
  edges.forEach((e, i) => {
    if (e.source === id) {
      nodeIds.add(e.target);
      edgeIdx.add(i);
    } else if (e.target === id) {
      nodeIds.add(e.source);
      edgeIdx.add(i);
    }
  });
  return { nodeIds, edgeIdx };
}

/**
 * FULL connected component of `id`: the transitive closure over BOTH
 * directions (upstream sources and downstream targets), cycle-safe via a
 * visited-set BFS. Returns every node id in the component plus the indexes of
 * ALL edges lying inside it (every edge touched during traversal has both
 * endpoints in the component by construction).
 */
export function connectedComponentOf(
  edges: readonly GraphEdgeLike[],
  id: string,
): { nodeIds: Set<string>; edgeIdx: Set<number> } {
  const adjacency = new Map<string, Array<{ other: string; idx: number }>>();
  edges.forEach((e, i) => {
    const src = adjacency.get(e.source) ?? [];
    src.push({ other: e.target, idx: i });
    adjacency.set(e.source, src);
    const tgt = adjacency.get(e.target) ?? [];
    tgt.push({ other: e.source, idx: i });
    adjacency.set(e.target, tgt);
  });

  const nodeIds = new Set<string>([id]);
  const edgeIdx = new Set<number>();
  const queue: string[] = [id];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    if (cur === undefined) break;
    for (const { other, idx } of adjacency.get(cur) ?? []) {
      edgeIdx.add(idx);
      if (!nodeIds.has(other)) {
        nodeIds.add(other);
        queue.push(other);
      }
    }
  }
  return { nodeIds, edgeIdx };
}

/** Impact = number of direct dependents (incoming edges). */
export function impactCount(edges: readonly GraphEdgeLike[], id: string): number {
  return edges.reduce((acc, e) => (e.target === id ? acc + 1 : acc), 0);
}

/** Virtualization switch: onlyRenderVisibleElements beyond 500 nodes. */
export function shouldVirtualize(nodeCount: number): boolean {
  return nodeCount > 500;
}

/**
 * Edge-kind → stroke color. Values are CSS custom properties defined in the
 * CODE-graph section of dag.css (with literal fallbacks for non-DOM contexts);
 * unknown kinds share a neutral gray.
 */
export const EDGE_KIND_COLORS: Record<string, string> = {
  calls: 'var(--archgen-cg-edge-calls, #ffa657)',
  imports: 'var(--archgen-cg-edge-imports, #58a6ff)',
  extends: 'var(--archgen-cg-edge-extends, #7ee787)',
  implements: 'var(--archgen-cg-edge-implements, #d2a8ff)',
  references: 'var(--archgen-cg-edge-references, #9aa4ad)',
};

export function colorForEdgeKind(kind: string): string {
  return EDGE_KIND_COLORS[kind] ?? 'var(--archgen-cg-edge-other, #b1b1b7)';
}

/** Live per-kind edge counts for the filter chips (e.g. `imports ×42`). */
export function edgeKindCounts(edges: readonly GraphEdgeLike[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of edges) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

/* ==== Radial (circular) layout — CODE tab's default presentation ==== */

/** Fixed card box for code-graph nodes. MUST match .archgen-gnode in dag.css
 *  (width/height 100% of the xyflow wrapper) and the dims handed to dagre. */
export const CODE_NODE_WIDTH = 232;
export const CODE_NODE_HEIGHT = 64;

export interface RadialPlacement {
  position: { x: number; y: number };
  /** anchor point on the ring (center-facing edge midpoint of the card) */
  anchor: { x: number; y: number };
  /** degrees, -90 = top, increasing clockwise */
  angle: number;
  /** which card face points at the circle center */
  face: 'left' | 'right' | 'top' | 'bottom';
}

function cmpStr(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

function optStr(n: unknown, field: 'kind' | 'label'): string {
  const v = (n as Record<string, unknown>)[field];
  return typeof v === 'string' ? v : '';
}

/**
 * Place nodes evenly on a circle (start at top, clockwise). Cards float just
 * outside the ring, centered on their angle; `anchor` is the ring point the
 * node's edges visually attach to. Pure: inputs never mutated.
 *
 * `groupByKind: true` walks the ring in (kind asc, label asc, id asc) order so
 * same-kind nodes form contiguous colored arcs (chord-diagram look); default
 * false preserves the historical input-order placement.
 */
export function layoutRadial<T extends { id: string }>(
  nodes: readonly T[],
  opts: { radius?: number; cardOffset?: number; groupByKind?: boolean } = {},
): Array<T & RadialPlacement> {
  const count = nodes.length;
  if (count === 0) return [];
  const radius = opts.radius ?? Math.max(280, count * 34);
  const cardOffset = opts.cardOffset ?? 96;
  const pad = cardOffset + Math.max(CODE_NODE_WIDTH, CODE_NODE_HEIGHT) / 2 + 8;
  const cx = radius + pad;
  const cy = radius + pad;
  const halfW = CODE_NODE_WIDTH / 2;
  const halfH = CODE_NODE_HEIGHT / 2;
  let ordered: readonly T[] = nodes;
  if (opts.groupByKind === true) {
    ordered = [...nodes].sort(
      (a, b) => cmpStr(optStr(a, 'kind'), optStr(b, 'kind')) || cmpStr(optStr(a, 'label'), optStr(b, 'label')) || cmpStr(a.id, b.id),
    );
  }
  return ordered.map((n, i) => {
    const angle = -90 + (360 / count) * i;
    const rad = (angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const anchor = { x: cx + radius * cos, y: cy + radius * sin };
    const centerR = radius + cardOffset;
    const center = { x: cx + centerR * cos, y: cy + centerR * sin };
    const face =
      Math.abs(cos) >= Math.abs(sin) ? (cos > 0 ? ('left' as const) : ('right' as const)) : sin > 0 ? ('top' as const) : ('bottom' as const);
    return { ...n, position: { x: center.x - halfW, y: center.y - halfH }, anchor, angle, face };
  });
}

/** Ring bounding-box origin for the background SVG node in radial mode. */
export function radialRingBounds(nodeCount: number, opts: { radius?: number; cardOffset?: number } = {}): {
  x: number;
  y: number;
  size: number;
  radius: number;
} {
  const radius = opts.radius ?? Math.max(280, nodeCount * 34);
  const pad = (opts.cardOffset ?? 96) + Math.max(CODE_NODE_WIDTH, CODE_NODE_HEIGHT) / 2 + 8;
  return { x: 0, y: 0, size: (radius + pad) * 2, radius };
}

/* ==== Per-component decomposition — one canvas per connected component ==== */

/** Synthetic id for the bucket holding every zero-edge node. */
export const UNLINKED_COMPONENT_ID = 'unlinked';

export interface GraphComponent {
  /** 'c1', 'c2', … in returned-array order; the singleton bucket is 'unlinked'. */
  id: string;
  nodes: GraphNodeLike[];
  edges: GraphEdgeLike[];
}

/**
 * Split a codegraph into renderable clusters: every connected component with
 * ≥2 nodes becomes one GraphComponent (sorted by node count DESC, ids c1..cn);
 * ALL singletons collapse into one trailing 'unlinked' component so hundreds
 * of standalone symbols never spawn hundreds of canvases. Grouping traverses
 * edges undirected and cycle-safe; each edge lands in exactly one component
 * (dangling edges whose endpoints are absent from `nodes` are dropped).
 * Pure: input node/edge objects are reused, never copied or mutated.
 */
export function connectedComponents(
  nodes: readonly GraphNodeLike[],
  edges: readonly GraphEdgeLike[],
): GraphComponent[] {
  const known = new Set<string>(nodes.map((n) => n.id));
  const byId = new Map<string, GraphNodeLike>(nodes.map((n) => [n.id, n]));

  const adjacency = new Map<string, Array<{ other: string; idx: number }>>();
  edges.forEach((e, i) => {
    if (!known.has(e.source) || !known.has(e.target)) return;
    const src = adjacency.get(e.source) ?? [];
    src.push({ other: e.target, idx: i });
    adjacency.set(e.source, src);
    const tgt = adjacency.get(e.target) ?? [];
    tgt.push({ other: e.source, idx: i });
    adjacency.set(e.target, tgt);
  });

  const visited = new Set<string>();
  const multi: Array<{ nodes: GraphNodeLike[]; edges: GraphEdgeLike[] }> = [];
  const singles: GraphNodeLike[] = [];
  let unlinkedEdges: GraphEdgeLike[] = [];

  for (const start of nodes) {
    if (visited.has(start.id)) continue;
    visited.add(start.id);
    const compNodes: GraphNodeLike[] = [];
    const compEdgeIdx = new Set<number>();
    const queue: string[] = [start.id];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      if (cur === undefined) break;
      const node = byId.get(cur);
      if (node) compNodes.push(node);
      for (const { other, idx } of adjacency.get(cur) ?? []) {
        compEdgeIdx.add(idx);
        if (!visited.has(other)) {
          visited.add(other);
          queue.push(other);
        }
      }
    }
    if (compNodes.length >= 2) {
      const compEdges: GraphEdgeLike[] = [];
      for (const idx of compEdgeIdx) {
        const e = edges[idx];
        if (e) compEdges.push(e);
      }
      multi.push({ nodes: compNodes, edges: compEdges });
    } else {
      singles.push(start);
      for (const idx of compEdgeIdx) {
        const e = edges[idx];
        if (e) unlinkedEdges.push(e);
      }
    }
  }

  multi.sort(
    (a, b) => b.nodes.length - a.nodes.length || cmpStr(a.nodes[0]?.id ?? '', b.nodes[0]?.id ?? ''),
  );

  const out: GraphComponent[] = multi.map((c, i) => ({ id: `c${i + 1}`, nodes: c.nodes, edges: c.edges }));
  if (singles.length > 0) out.push({ id: UNLINKED_COMPONENT_ID, nodes: singles, edges: unlinkedEdges });
  return out;
}

/** Dagre declutter tuning for the per-component flow layout. */
export const CODE_FLOW_LAYOUT = { rankSep: 140, nodeSep: 56 } as const;
