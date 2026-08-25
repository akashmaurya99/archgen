// Per-component model tests: connectedComponents decomposition (one canvas per
// cluster + single 'unlinked' singleton bucket), layoutRadial groupByKind ring
// clustering, and the CODE_FLOW_LAYOUT dagre tuning constants. Pure node env —
// no jsdom, no React.
import { describe, expect, it } from 'vitest';
import {
  CODE_FLOW_LAYOUT,
  UNLINKED_COMPONENT_ID,
  connectedComponents,
  layoutRadial,
} from '../src/webview/graph-model';
import type { GraphEdgeLike, GraphNodeLike } from '../src/webview/graph-model';

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
