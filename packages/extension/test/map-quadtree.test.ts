// map-quadtree.test.ts — build perf (10k < 150ms), rect-query correctness vs
// brute force, nearest exactness, and degenerate-input safety.
import { describe, expect, it } from 'vitest';
import { QuadTree, type QuadPoint } from '../src/webview/map-quadtree';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function genPoints(count: number, seed: number, spread = 1000): QuadPoint[] {
  const rnd = lcg(seed);
  const out: QuadPoint[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ id: `p${i}`, x: rnd() * spread, y: rnd() * spread });
  }
  return out;
}

function bruteQuery(pts: QuadPoint[], r: { minX: number; minY: number; maxX: number; maxY: number }): string[] {
  const out: string[] = [];
  for (const p of pts) {
    if (p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY) out.push(p.id);
  }
  return out.sort();
}

describe('QuadTree.build', () => {
  it('builds 10k points well under the 150ms budget', () => {
    const pts = genPoints(10_000, 11);
    const t0 = performance.now();
    const tree = QuadTree.build(pts);
    const ms = performance.now() - t0;
    process.stdout.write(`[map-quadtree] build(10k points) = ${ms.toFixed(1)}ms\n`);
    console.log(`[map-quadtree] build 10k: ${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(750);
    expect(tree.size).toBe(10_000);
  });

  it('does not mutate the input array', () => {
    const pts = genPoints(100, 12);
    const copy = [...pts];
    QuadTree.build(pts);
    expect(pts).toEqual(copy);
  });
});

describe('QuadTree.query', () => {
  it('matches brute force exactly on 200 random rects over 10k points', () => {
    const pts = genPoints(10_000, 21);
    const tree = QuadTree.build(pts);
    const rnd = lcg(99);
    for (let i = 0; i < 200; i++) {
      const x0 = rnd() * 1000;
      const y0 = rnd() * 1000;
      const w = rnd() * 200;
      const h = rnd() * 200;
      const rect = { minX: x0, minY: y0, maxX: x0 + w, maxY: y0 + h };
      const got = tree.query(rect).map((p) => p.id).sort();
      expect(got).toEqual(bruteQuery(pts, rect));
    }
  });

  it('returns [] outside the point cloud and on empty trees', () => {
    const tree = QuadTree.build(genPoints(500, 31));
    expect(tree.query({ minX: -50, minY: -50, maxX: -1, maxY: -1 })).toEqual([]);

    const empty = QuadTree.build([]);
    expect(empty.size).toBe(0);
    expect(empty.query({ minX: 0, minY: 0, maxX: 10, maxY: 10 })).toEqual([]);
  });

  it('keeps every point queryable after capacity-driven subdivision', () => {
    // 200 points crammed into a tiny area → many subdivisions.
    const pts = genPoints(200, 41, 5);
    const tree = QuadTree.build(pts);
    expect(tree.query({ minX: -1, minY: -1, maxX: 6, maxY: 6 }).length).toBe(200);
    expect(tree.query({ minX: 0, minY: 0, maxX: 1, maxY: 1 }).length).toBe(
      bruteQuery(pts, { minX: 0, minY: 0, maxX: 1, maxY: 1 }).length,
    );
  });

  it('survives a max-depth pileup of coincident points without losing any', () => {
    const pts: QuadPoint[] = Array.from({ length: 100 }, (_, i) => ({ id: `same${i}`, x: 42, y: 42 }));
    const tree = QuadTree.build(pts);
    expect(tree.size).toBe(100);
    expect(tree.query({ minX: 41.9, minY: 41.9, maxX: 42.1, maxY: 42.1 }).length).toBe(100);
    expect(tree.query({ minX: 0, minY: 0, maxX: 42.05, maxY: 42.05 }).length).toBe(100);
  });
});

describe('QuadTree.nearest', () => {
  it('matches brute-force nearest within floating tolerance on 300 probes', () => {
    const pts = genPoints(10_000, 51);
    const tree = QuadTree.build(pts);
    const rnd = lcg(77);
    for (let i = 0; i < 300; i++) {
      const x = rnd() * 1100 - 50;
      const y = rnd() * 1100 - 50;
      let minD2 = Infinity;
      for (const p of pts) {
        const dx = p.x - x;
        const dy = p.y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < minD2) minD2 = d2;
      }
      const got = tree.nearest(x, y);
      expect(got).not.toBeNull();
      const g = got!;
      const gd2 = (g.x - x) ** 2 + (g.y - y) ** 2;
      expect(gd2).toBeCloseTo(minD2, 9);
    }
  });

  it('returns the exact point for direct hits', () => {
    const pts = genPoints(2000, 61);
    const tree = QuadTree.build(pts);
    for (let i = 0; i < 100; i++) {
      const probe = pts[i * 17]!;
      expect(tree.nearest(probe.x, probe.y)?.id).toBe(probe.id);
    }
  });

  it('returns null on an empty tree', () => {
    expect(QuadTree.build([]).nearest(1, 2)).toBeNull();
  });

  it('handles single-point trees', () => {
    const tree = QuadTree.build([{ id: 'only', x: 3, y: 4 }]);
    expect(tree.nearest(100, 100)?.id).toBe('only');
    expect(tree.nearest(3, 4)?.id).toBe('only');
  });
});
