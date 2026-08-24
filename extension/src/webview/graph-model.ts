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

/** Impact = number of direct dependents (incoming edges). */
export function impactCount(edges: readonly GraphEdgeLike[], id: string): number {
  return edges.reduce((acc, e) => (e.target === id ? acc + 1 : acc), 0);
}

/** Virtualization switch: onlyRenderVisibleElements beyond 500 nodes. */
export function shouldVirtualize(nodeCount: number): boolean {
  return nodeCount > 500;
}
