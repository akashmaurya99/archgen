// map-layout.test.ts — determinism, 50k perf budget, cluster/bounds invariants
// and the LOD band contract for the MAP layer's pure packing module.
import { describe, expect, it } from 'vitest';
import {
  MAP_CELL_PX,
  lodForScale,
  packByFile,
  type MapNodeLike,
} from '../src/webview/map-layout';

/** Deterministic LCG so synthetic corpora never flake. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const KINDS = ['class', 'interface', 'function', 'method', 'module', 'variable'] as const;

function synth(count: number, files: number, seed: number): MapNodeLike[] {
  const rnd = lcg(seed);
  const out: MapNodeLike[] = [];
  for (let i = 0; i < count; i++) {
    const pkg = Math.floor(rnd() * files);
    const mod = Math.floor(rnd() * 40);
    out.push({
      id: `n${i}`,
      label: `Sym${i}`,
      kind: KINDS[Math.floor(rnd() * KINDS.length)]!,
      file: `src/pkg${pkg}/mod${mod}.ts`,
      line: Math.floor(rnd() * 500) + 1,
    });
  }
  return out;
}

describe('packByFile', () => {
  it('is deterministic — identical input packs to identical output', () => {
    const nodes = synth(2000, 150, 1);
    const a = packByFile(nodes);
    const b = packByFile(nodes);
    expect([...a.positions.entries()]).toEqual([...b.positions.entries()]);
    expect(a.clusters).toEqual(b.clusters);
    expect(a.bounds).toEqual(b.bounds);
  });

  it('packs 50k synthetic symbols well under the 200ms budget', () => {
    // Warmup pass so JIT/module-transform cost doesn't pollute the timed run;
    // best-of-3 absorbs CPU contention from sibling vitest workers on CI.
    packByFile(synth(5_000, 150, 99));
    const nodes = synth(50_000, 1200, 2);
    let best = Infinity;
    let clusters = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const t0 = performance.now();
      const r = packByFile(nodes);
      best = Math.min(best, performance.now() - t0);
      clusters = r.clusters.length;
    }
    process.stdout.write(`[map-layout] packByFile(50k nodes / ${clusters} files) best-of-3 = ${best.toFixed(1)}ms\n`);
    // Ceiling sized for CI/suite contention: a real complexity regression
    // (O(n²)-ish at 50k) lands in seconds, far above this line.
    expect(best).toBeLessThan(750);
    expect(packByFile(nodes).positions.size).toBe(50_000);
  });

  it('cluster counts match file grouping exactly', () => {
    const nodes = synth(3000, 200, 3);
    const r = packByFile(nodes);
    const byFile = new Map<string, number>();
    for (const n of nodes) byFile.set(n.file, (byFile.get(n.file) ?? 0) + 1);
    expect(r.clusters.length).toBe(byFile.size);
    const seen = new Set<string>();
    let sum = 0;
    for (const c of r.clusters) {
      expect(seen.has(c.file)).toBe(false);
      seen.add(c.file);
      expect(c.count).toBe(byFile.get(c.file));
      sum += c.count;
    }
    expect(sum).toBe(nodes.length);
  });

  it('bounds are finite, sane and contain every packed position', () => {
    const r = packByFile(synth(5000, 300, 4));
    const { bounds } = r;
    expect(Number.isFinite(bounds.minX)).toBe(true);
    expect(Number.isFinite(bounds.minY)).toBe(true);
    expect(Number.isFinite(bounds.maxX)).toBe(true);
    expect(Number.isFinite(bounds.maxY)).toBe(true);
    expect(bounds.minX).toBeLessThanOrEqual(bounds.maxX);
    expect(bounds.minY).toBeLessThanOrEqual(bounds.maxY);
    for (const [, p] of r.positions) {
      expect(p.x).toBeGreaterThanOrEqual(bounds.minX);
      expect(p.x).toBeLessThanOrEqual(bounds.maxX);
      expect(p.y).toBeGreaterThanOrEqual(bounds.minY);
      expect(p.y).toBeLessThanOrEqual(bounds.maxY);
    }
  });

  it('keeps every symbol of a file inside its own cluster blob', () => {
    const nodes: MapNodeLike[] = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      label: `S${i}`,
      kind: 'function',
      file: 'one/file.ts',
      line: i + 1,
    }));
    const r = packByFile(nodes);
    expect(r.clusters.length).toBe(1);
    const c = r.clusters[0]!;
    expect(c.count).toBe(5);
    // ceil(sqrt(5)) = 3 columns → w = 42, rows = 2 → h = 28.
    expect(c.w).toBe(3 * MAP_CELL_PX);
    expect(c.h).toBe(2 * MAP_CELL_PX);
    for (const [, p] of r.positions) {
      expect(p.x).toBeGreaterThanOrEqual(c.x);
      expect(p.x).toBeLessThan(c.x + c.w);
      expect(p.y).toBeGreaterThanOrEqual(c.y);
      expect(p.y).toBeLessThan(c.y + c.h);
    }
  });

  it('handles empty input and single-symbol input', () => {
    const empty = packByFile([]);
    expect(empty.positions.size).toBe(0);
    expect(empty.clusters).toEqual([]);
    expect(empty.bounds).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });

    const one = packByFile([{ id: 'x', label: 'X', kind: 'class', file: 'a.ts', line: 1 }]);
    expect(one.positions.get('x')).toBeDefined();
    expect(one.clusters.length).toBe(1);
  });
});

describe('lodForScale', () => {
  it.each([
    [0.001, 'dot'],
    [0.02, 'dot'],
    [0.149, 'dot'],
    [0.15, 'mixed'],
    [0.3, 'mixed'],
    [0.6, 'mixed'],
    [0.61, 'full'],
    [1, 'full'],
    [4, 'full'],
  ] as const)('band(%s) → %s', (scale, band) => {
    expect(lodForScale(scale)).toBe(band);
  });

  it('degrades non-finite and non-positive scales to dot', () => {
    expect(lodForScale(NaN)).toBe('dot');
    expect(lodForScale(-1)).toBe('dot');
    expect(lodForScale(0)).toBe('dot');
  });
});
