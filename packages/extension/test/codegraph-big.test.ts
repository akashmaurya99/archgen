// codegraph-big.test.ts — scale + perf smoke over a GENERATED 5k-node colby
// fixture (scripts/build-big-fixture.mjs, deterministic seeded LCG). Runs in a
// temp dir; skipped entirely when SKIP_BIG_TESTS is set. Budget: <30s total.
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodegraphReader, openCodegraph } from '../src/host/codegraph';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIG_NODES = 5000;
const EDGE_BUDGET_MS = 1000;

const describeBig = process.env.SKIP_BIG_TESTS ? describe.skip : describe;

describeBig('codegraph at scale (generated 5k fixture)', () => {
  let wsRoot = '';
  let reader: CodegraphReader;
  let edgeCount = 0;
  let fileCount = 0;

  beforeAll(() => {
    wsRoot = mkdtempSync(join(tmpdir(), 'codegraph-big-'));
    const script = join(HERE, '..', 'scripts', 'build-big-fixture.mjs');
    execFileSync(process.execPath, [script, '--nodes', String(BIG_NODES), '--out', wsRoot], { stdio: 'pipe' });
    edgeCount = Math.min(Math.floor(BIG_NODES * 2.5), 150000);
    fileCount = Math.max(1, Math.floor(BIG_NODES / 40));
    reader = openCodegraph(wsRoot).reader;
  }, 60_000);

  afterAll(() => {
    reader?.close();
    if (wsRoot) rmSync(wsRoot, { recursive: true, force: true });
  });

  it('fileRollup totals equal the generated node/edge/file counts', () => {
    const rollup = reader.fileRollup();
    expect(rollup.totals.symbols).toBe(BIG_NODES);
    expect(rollup.totals.edges).toBe(edgeCount);
    expect(rollup.totals.files).toBe(fileCount);
    expect(rollup.files).toHaveLength(fileCount);
    const kindSum = (r: Record<string, number>): number => Object.values(r).reduce((a, b) => a + b, 0);
    expect(rollup.files.reduce((a, f) => a + f.symbols, 0)).toBe(BIG_NODES);
    expect(rollup.files.every((f) => kindSum(f.kinds) === f.symbols)).toBe(true);
    expect(rollup.edges.reduce((a, e) => a + e.count, 0)).toBe(edgeCount);
  });

  it('topHubs returns at most `limit` hubs sorted by degree DESC', () => {
    const hubs = reader.topHubs(10);
    expect(hubs.length).toBeGreaterThan(0);
    expect(hubs.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < hubs.length; i++) {
      const prev = hubs[i - 1];
      const curr = hubs[i];
      if (!prev || !curr) continue;
      expect(prev.degree).toBeGreaterThanOrEqual(curr.degree);
    }
    for (const h of hubs) {
      expect(h.label.length).toBeGreaterThan(0);
      expect(h.file.startsWith('src/')).toBe(true);
    }
    expect(reader.topHubs().length).toBeLessThanOrEqual(25);
  });

  it('neighborhood(depth 2) around the top hub stays within the limit', () => {
    const hub = reader.topHubs(1)[0];
    expect(hub).toBeDefined();
    if (!hub) return;
    const hood = reader.neighborhood(hub.id, 2, 300);
    expect(hood.nodes.length).toBeLessThanOrEqual(300);
    expect(hood.nodes.length).toBeGreaterThan(1);
    expect(hood.nodes.some((n) => n.id === hub.id)).toBe(true);
    const ids = new Set(hood.nodes.map((n) => n.id));
    for (const e of hood.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });

  it(`PERF SMOKE: fileRollup and topHubs each finish < ${EDGE_BUDGET_MS}ms at 5k`, () => {
    let t0 = performance.now();
    reader.fileRollup();
    const rollupMs = performance.now() - t0;
    t0 = performance.now();
    reader.topHubs(25);
    const hubsMs = performance.now() - t0;
    expect(rollupMs).toBeLessThan(EDGE_BUDGET_MS);
    expect(hubsMs).toBeLessThan(EDGE_BUDGET_MS);
  });

  it('snapshot(60000) returns the full constellation', () => {
    const snap = reader.snapshot(60000);
    expect(snap.totalNodes).toBe(BIG_NODES);
    expect(snap.nodes).toHaveLength(BIG_NODES);
    expect(snap.edges).toHaveLength(edgeCount);
    expect(snap.hasFts).toBe(true);
  });
});
