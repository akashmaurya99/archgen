// Per-component model tests: connectedComponents decomposition (one canvas per
// cluster + single 'unlinked' singleton bucket), layoutRadial groupByKind ring
// clustering, and the CODE_FLOW_LAYOUT dagre tuning constants. Pure node env —
// no jsdom, no React. Todo 13 adds the selectSizeTier boundary/unlinked-bucket
// contract and the layoutFlowGrouped dagre-cache spy.
import { describe, expect, it, vi } from 'vitest';

// Behavior-preserving spy (same pattern as todo 12's code-graph.test.tsx):
// counts dagre passes inside layoutFlowGrouped without stubbing layout math.
vi.mock('../src/webview/layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/webview/layout')>();
  return { ...actual, layoutLeftToRight: vi.fn(actual.layoutLeftToRight) };
});

import {
  CODE_FLOW_LAYOUT,
  UNLINKED_COMPONENT_ID,
  connectedComponents,
  layoutRadial,
  radialRingBounds,
} from '../src/webview/graph-model';
import type { GraphEdgeLike, GraphNodeLike } from '../src/webview/graph-model';
import { layoutFlowGrouped, selectSizeTier, type FileRollup } from '../src/webview/graph-grouped';
import { layoutLeftToRight } from '../src/webview/layout';

const n = (id: string, kind = 'function', label = id): GraphNodeLike => ({ id, label, kind, file: `${id}.ts`, line: 1 });
const e = (source: string, target: string, kind = 'calls'): GraphEdgeLike => ({ source, target, kind });

describe('connectedComponents — decomposition contract', () => {
  it('splits two separate pairs + 3 singletons into c1, c2 and one unlinked bucket of 3', () => {
    const nodes = [n('a'), n('b'), n('x'), n('y'), n('s1'), n('s2'), n('s3')];
    const edges = [e('a', 'b'), e('y', 'x')];
    const comps = connectedComponents(nodes, edges);
    expect(comps.map((c) => c.id)).toEqual(['c1', 'c2', UNLINKED_COMPONENT_ID]);
    expect(comps[0]?.nodes.map((v) => v.id)).toEqual(['a', 'b']);
    expect(comps[1]?.nodes.map((v) => v.id)).toEqual(['x', 'y']);
    expect(comps[2]?.nodes.map((v) => v.id)).toEqual(['s1', 's2', 's3']);
    expect(comps[0]?.edges).toHaveLength(1);
    expect(comps[1]?.edges).toHaveLength(1);
    expect(comps[2]?.edges).toHaveLength(0);
  });

  it('orders sized components by node count DESC (largest first, ids renumbered c1..cn)', () => {
    const nodes = [
      n('p'), n('q'),
      n('m1'), n('m2'), n('m3'), n('m4'),
      n('t1'), n('t2'), n('t3'),
    ];
    const edges = [e('p', 'q'), e('m1', 'm2'), e('m2', 'm3'), e('m3', 'm4'), e('t1', 't2'), e('t2', 't3')];
    const comps = connectedComponents(nodes, edges);
    expect(comps.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(comps.map((c) => c.nodes.length)).toEqual([4, 3, 2]);
  });

  it('keeps a cycle (a→b→c→a) as ONE component with all three edges', () => {
    const nodes = [n('a'), n('b'), n('c')];
    const edges = [e('a', 'b'), e('b', 'c'), e('c', 'a')];
    const comps = connectedComponents(nodes, edges);
    expect(comps).toHaveLength(1);
    const only = comps[0]!;
    expect(only.id).toBe('c1');
    expect(only.nodes.map((v) => v.id).sort()).toEqual(['a', 'b', 'c']);
    expect(only.edges).toHaveLength(3);
    expect(comps.some((c) => c.id === UNLINKED_COMPONENT_ID)).toBe(false);
  });

  it('preserves edge objects verbatim and never spans components', () => {
    const nodes = [n('a'), n('b'), n('x'), n('y')];
    const edgeAB = e('a', 'b', 'imports');
    const edgeYX = e('y', 'x', 'extends');
    const comps = connectedComponents(nodes, [edgeAB, edgeYX]);
    const allEdges = comps.flatMap((c) => c.edges);
    expect(allEdges).toContain(edgeAB);
    expect(allEdges).toContain(edgeYX);
    expect(allEdges.find((ed) => ed.source === 'a')).toEqual({ source: 'a', target: 'b', kind: 'imports' });
    for (const c of comps) {
      const ids = new Set(c.nodes.map((v) => v.id));
      for (const ed of c.edges) {
        expect(ids.has(ed.source)).toBe(true);
        expect(ids.has(ed.target)).toBe(true);
      }
    }
    expect(allEdges).toHaveLength(2);
  });

  it('preserves node field values (label/kind/file/line) inside components', () => {
    const node: GraphNodeLike = { id: 'svc', label: 'UserService', kind: 'class', file: 'src/svc.ts', line: 42 };
    const comps = connectedComponents([node, n('helper')], [e('helper', 'svc')]);
    expect(comps[0]?.nodes[0]).toEqual({ id: 'svc', label: 'UserService', kind: 'class', file: 'src/svc.ts', line: 42 });
    expect(comps[0]?.nodes[0]).toBe(node);
  });

  it('collapses a singleton-only graph into exactly one unlinked component', () => {
    const comps = connectedComponents([n('p'), n('q'), n('r')], []);
    expect(comps).toHaveLength(1);
    const only = comps[0]!;
    expect(only.id).toBe(UNLINKED_COMPONENT_ID);
    expect(only.nodes.map((v) => v.id)).toEqual(['p', 'q', 'r']);
    expect(only.edges).toEqual([]);
  });

  it('returns [] for empty inputs', () => {
    expect(connectedComponents([], [])).toEqual([]);
  });

  it('50-node deterministic fixture → sizes [12,8,6,2,2] + unlinked(20), every edge placed once', () => {
    const nodes: GraphNodeLike[] = [];
    const edges: GraphEdgeLike[] = [];
    // chain of 12
    for (let i = 0; i < 12; i++) nodes.push(n(`k${String(i).padStart(2, '0')}`));
    for (let i = 0; i < 11; i++) edges.push(e(`k${String(i).padStart(2, '0')}`, `k${String(i + 1).padStart(2, '0')}`, 'imports'));
    // star of 8 (hub + 7 spokes)
    nodes.push(n('hub'));
    for (let i = 0; i < 7; i++) {
      nodes.push(n(`spoke${i}`));
      edges.push(e('hub', `spoke${i}`, 'references'));
    }
    // ring of 6
    for (let i = 0; i < 6; i++) nodes.push(n(`ring${i}`));
    for (let i = 0; i < 6; i++) edges.push(e(`ring${i}`, `ring${(i + 1) % 6}`, 'calls'));
    // two pairs
    nodes.push(n('p1'), n('p2'), n('u1'), n('u2'));
    edges.push(e('p1', 'p2'), e('u1', 'u2'));
    // 20 standalone symbols
    for (let i = 1; i <= 20; i++) nodes.push(n(`z${String(i).padStart(2, '0')}`));

    expect(nodes).toHaveLength(50);
    const comps = connectedComponents(nodes, edges);

    expect(comps.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', UNLINKED_COMPONENT_ID]);
    expect(comps.map((c) => c.nodes.length)).toEqual([12, 8, 6, 2, 2, 20]);
    expect(comps.flatMap((c) => c.nodes).length).toBe(50);
    expect(new Set(comps.flatMap((c) => c.nodes).map((v) => v.id)).size).toBe(50);

    const placedEdges = comps.flatMap((c) => c.edges);
    expect(placedEdges).toHaveLength(edges.length);
    for (const c of comps) {
      const ids = new Set(c.nodes.map((v) => v.id));
      for (const ed of c.edges) {
        expect(ids.has(ed.source)).toBe(true);
        expect(ids.has(ed.target)).toBe(true);
      }
    }
  });
});

describe('layoutRadial — groupByKind ring clustering', () => {
  const mixed: GraphNodeLike[] = [
    n('f2', 'function', 'zeta'),
    n('c1', 'class', 'Beta'),
    n('v1', 'variable', 'val'),
    n('c2', 'class', 'Alpha'),
    n('i1', 'interface', 'Shape'),
    n('f1', 'function', 'alpha'),
  ];

  it('walks the ring in (kind asc, label asc, id asc) order so adjacent placements share kinds', () => {
    const placed = layoutRadial(mixed, { groupByKind: true });
    expect(placed.map((p) => p.id)).toEqual(['c2', 'c1', 'f1', 'f2', 'i1', 'v1']);
    const kinds = placed.map((p) => p.kind);
    expect(kinds).toEqual(['class', 'class', 'function', 'function', 'interface', 'variable']);
    for (let i = 1; i < placed.length; i++) {
      expect(kinds[i - 1]! <= kinds[i]!).toBe(true);
      const expectedAngle = -90 + (360 / placed.length) * i;
      expect(placed[i]!.angle).toBeCloseTo(expectedAngle, 5);
    }
  });

  it('default (groupByKind omitted or false) preserves input ordering exactly', () => {
    const inputIds = mixed.map((v) => v.id);
    const plain = layoutRadial(mixed);
    const explicitOff = layoutRadial(mixed, { groupByKind: false });
    expect(plain.map((p) => p.id)).toEqual(inputIds);
    expect(explicitOff.map((p) => p.id)).toEqual(inputIds);
    expect(plain[0]!.angle).toBe(-90);
    expect(explicitOff[1]!.angle).toBeCloseTo(-30, 5);
  });

  it('does not mutate the input array (pure)', () => {
    const snapshot = mixed.map((v) => v.id);
    layoutRadial(mixed, { groupByKind: true });
    expect(mixed.map((v) => v.id)).toEqual(snapshot);
  });
});

describe('CODE_FLOW_LAYOUT — flow declutter tuning', () => {
  it('exposes exactly rankSep=140 and nodeSep=56', () => {
    expect(CODE_FLOW_LAYOUT.rankSep).toBe(140);
    expect(CODE_FLOW_LAYOUT.nodeSep).toBe(56);
    expect(Object.keys(CODE_FLOW_LAYOUT).sort()).toEqual(['nodeSep', 'rankSep']);
    expect(CODE_FLOW_LAYOUT).toEqual({ rankSep: 140, nodeSep: 56 });
  });
});

/* ==== todo 13 — selectSizeTier boundaries + unlinked bucket ==== */

const chain = (k: number): { nodes: GraphNodeLike[]; edges: GraphEdgeLike[] } => ({
  nodes: Array.from({ length: k }, (_, i) => n(`c${i}`)),
  edges: Array.from({ length: Math.max(0, k - 1) }, (_, i) => e(`c${i}`, `c${i + 1}`)),
});

/** Minimal host rollup — selectSizeTier only needs a non-empty `files` list. */
const rollupOf = (nodes: readonly GraphNodeLike[]): FileRollup => {
  const symbols = new Map<string, number>();
  for (const node of nodes) symbols.set(node.file, (symbols.get(node.file) ?? 0) + 1);
  return {
    files: [...symbols.entries()].map(([file, count]) => ({ file, symbols: count, kinds: {} })),
    edges: [],
    totals: { files: symbols.size, symbols: nodes.length, edges: 0 },
  };
};

describe('selectSizeTier — tier boundaries + unlinked bucket (todo 13)', () => {
  it('no rollup → radial at ANY size (legacy fallback)', () => {
    const big = chain(400);
    expect(selectSizeTier(big.nodes, big.edges, null)).toBe('radial');
    expect(selectSizeTier(big.nodes, big.edges, undefined)).toBe('radial');
  });

  it.each([
    [60, 'radial'],
    [61, 'file-hub'],
    [300, 'file-hub'],
    [301, 'focus-first'],
  ] as const)('linked chain of %s symbols → %s', (k, tier) => {
    const { nodes, edges } = chain(k);
    expect(selectSizeTier(nodes, edges, rollupOf(nodes))).toBe(tier);
  });

  it('301 ISOLATED nodes (one unlinked bucket of 301) → still radial', () => {
    const nodes = Array.from({ length: 301 }, (_, i) => n(`iso${i}`));
    expect(selectSizeTier(nodes, [], rollupOf(nodes))).toBe('radial');
  });

  it('loose singletons never escalate: 500 isolated + 10-chain → radial, 500 isolated + 61-chain → file-hub', () => {
    const loose = Array.from({ length: 500 }, (_, i) => n(`loose${i}`));
    const small = chain(10);
    expect(selectSizeTier([...small.nodes, ...loose], small.edges, rollupOf([...small.nodes, ...loose]))).toBe('radial');
    const mid = chain(61);
    expect(selectSizeTier([...mid.nodes, ...loose], mid.edges, rollupOf([...mid.nodes, ...loose]))).toBe('file-hub');
  });
});

describe('layoutFlowGrouped — dagre cache eliminates the double pass (todo 13)', () => {
  it('runs dagre exactly once per LINKED component (halved), never for the unlinked bucket', () => {
    const dagreSpy = vi.mocked(layoutLeftToRight);
    dagreSpy.mockClear();

    // c1={a1..a4} chain, c2={b1..b3} chain, c3={d1,d2} pair, + s1,s2 singletons.
    const nodes = [
      n('a1'), n('a2'), n('a3'), n('a4'),
      n('b1'), n('b2'), n('b3'),
      n('d1'), n('d2'),
      n('s1'), n('s2'),
    ];
    const edges = [
      e('a1', 'a2'), e('a2', 'a3'), e('a3', 'a4'),
      e('b1', 'b2'), e('b2', 'b3'),
      e('d1', 'd2'),
    ];
    const result = layoutFlowGrouped(nodes, edges);

    // Pre-cache behavior ran dagre TWICE per linked component (sizing pass +
    // placement pass) = 6 calls here; the sizing pass now caches → exactly 3.
    expect(dagreSpy).toHaveBeenCalledTimes(3);

    expect(result.placements).toHaveLength(11);
    expect(result.regions.map((r) => r.id)).toEqual(['c1', 'c2', 'c3', UNLINKED_COMPONENT_ID]);
    // Cached layouts are reused by COPY — placements carry componentId without
    // mutating the cache, and every node lands at finite coordinates.
    for (const p of result.placements) {
      expect(Number.isFinite(p.position.x)).toBe(true);
      expect(Number.isFinite(p.position.y)).toBe(true);
      expect(p.componentId).not.toBe('');
    }
  });
});

describe('radialRingBounds — default + explicit opts', () => {
  it('derives radius and pad from defaults when opts is omitted', () => {
    const b = radialRingBounds(10);
    expect(b.radius).toBe(Math.max(280, 10 * 34));
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
    expect(b.size).toBe((b.radius + 96 + Math.max(232, 64) / 2 + 8) * 2);
  });

  it('honors explicit radius and cardOffset over the defaults', () => {
    const b = radialRingBounds(10, { radius: 500, cardOffset: 20 });
    expect(b.radius).toBe(500);
    expect(b.size).toBe((500 + 20 + Math.max(232, 64) / 2 + 8) * 2);
  });
});

describe('layoutRadial — degenerate inputs', () => {
  it('returns [] for an empty node list', () => {
    expect(layoutRadial([])).toEqual([]);
  });

  it('groupByKind degrades gracefully when kind/label are absent (non-string → empty key)', () => {
    const bare = [{ id: 'b' }, { id: 'a' }] as Array<{ id: string }>;
    const placed = layoutRadial(bare, { groupByKind: true });
    expect(placed.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('groupByKind falls back to id order when kind AND label both tie', () => {
    const twins = [n('z9', 'class', 'Same'), n('a1', 'class', 'Same')];
    const placed = layoutRadial(twins, { groupByKind: true });
    expect(placed.map((p) => p.id)).toEqual(['a1', 'z9']);
  });
});

describe('connectedComponents — dangling edges + equal-size tie-break', () => {
  it('drops edges whose endpoints are absent from the node set', () => {
    const comps = connectedComponents([n('a'), n('b')], [e('a', 'b'), e('a', 'ghost'), e('phantom', 'b')]);
    expect(comps).toHaveLength(1);
    expect(comps[0]!.edges).toHaveLength(1);
    expect(comps[0]!.edges[0]).toEqual({ source: 'a', target: 'b', kind: 'calls' });
  });

  it('breaks equal-size component ties by first node id ascending', () => {
    const comps = connectedComponents([n('x'), n('y'), n('a'), n('b')], [e('x', 'y'), e('a', 'b')]);
    expect(comps.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(comps[0]!.nodes[0]!.id).toBe('a');
    expect(comps[1]!.nodes[0]!.id).toBe('x');
  });
});
