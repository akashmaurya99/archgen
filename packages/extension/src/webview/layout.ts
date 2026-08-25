// layout.ts — dagre left-to-right DAG layout (todo 8).
//
// Pure util: nodes + edges in → positioned nodes out. Dependency edges point
// source=dependency → target=dependent, so with rankdir 'LR' a chain
// C ← B ← A renders C leftmost and A rightmost (work flows left→right).
// Statuses are irrelevant here — layout depends ONLY on structure, so status
// flips never re-trigger it (perf rule: layout once per structural change).
import { graphlib, layout as dagreLayout } from '@dagrejs/dagre';

export interface DagreLayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  /** horizontal gap between ranks (columns) */
  rankSep?: number;
  /** vertical gap between nodes in the same rank */
  nodeSep?: number;
}

/** Must stay in sync with the TaskNode box model in dag.css. */
export const DEFAULT_NODE_WIDTH = 180;
export const DEFAULT_NODE_HEIGHT = 56;

export interface Positioned {
  position: { x: number; y: number };
}

/**
 * Lay `nodes` out left→right following `edges` (source → target).
 * Returns NEW node objects (`{...n, position}`); inputs are never mutated.
 * Edges referencing unknown ids are ignored, so partial graphs are safe.
 */
export function layoutLeftToRight<T extends { id: string }>(
  nodes: T[],
  edges: ReadonlyArray<{ source: string; target: string }>,
  opts: DagreLayoutOptions = {},
): Array<T & Positioned> {
  const width = opts.nodeWidth ?? DEFAULT_NODE_WIDTH;
  const height = opts.nodeHeight ?? DEFAULT_NODE_HEIGHT;
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: 'LR', ranksep: opts.rankSep ?? 48, nodesep: opts.nodeSep ?? 28, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));

  const known = new Set(nodes.map((n) => n.id));
  for (const n of nodes) g.setNode(n.id, { width, height });
  for (const e of edges) {
    if (known.has(e.source) && known.has(e.target) && e.source !== e.target) {
      g.setEdge(e.source, e.target);
    }
  }

  dagreLayout(g);

  return nodes.map((n) => {
    // dagre centers nodes on (x,y); React Flow positions top-left corners.
    const pos = g.node(n.id) as { x: number; y: number };
    return { ...n, position: { x: pos.x - width / 2, y: pos.y - height / 2 } };
  });
}
