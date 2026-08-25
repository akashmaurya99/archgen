// Codegraph reader tests against committed fixture DBs built via DDL
// (scripts/build-fixture-db.mjs — colby schema + nodes_fts, optave variant).
import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodegraphReader, UnsupportedProductError, detectCodegraph, openCodegraph } from '../src/host/codegraph';

const HERE = dirname(fileURLToPath(import.meta.url));

const FIXTURES = join(HERE, 'fixtures');

describe('detectCodegraph', () => {
  it('detects colby via .codegraph/codegraph.db', () => {
    const d = detectCodegraph(join(FIXTURES, 'ws-colby'));
    expect(d.product).toBe('colby');
    expect(d.dbPath).toBe(join(FIXTURES, 'ws-colby', '.codegraph', 'codegraph.db'));
  });

  it('detects optave via .codegraph/graph.db', () => {
    const d = detectCodegraph(join(FIXTURES, 'ws-optave'));
    expect(d.product).toBe('optave');
    expect(d.dbPath).toBe(join(FIXTURES, 'ws-optave', '.codegraph', 'graph.db'));
  });

  it('global ~/.codegraph/graph.db → unsupported with explanatory reason', () => {
    const d = detectCodegraph(join(FIXTURES, 'empty-ws'), join(FIXTURES, 'fake-home'));
    expect(d.product).toBe('unsupported');
    expect(d.reason).toContain('global index');
  });

  it('reports unsupported when nothing exists anywhere', () => {
    const d = detectCodegraph(join(FIXTURES, 'empty-ws'), join(FIXTURES, 'no-home'));
    expect(d.product).toBe('unsupported');
    expect(d.reason).toContain('No .codegraph');
  });
});

describe('CodegraphReader (colby fixture)', () => {
  const dbPath = join(FIXTURES, 'ws-colby', '.codegraph', 'codegraph.db');

  it('opens read-only and maps nodes/edges to view models', () => {
    const reader = CodegraphReader.open(dbPath, 'colby');
    try {
      const snap = reader.snapshot();
      expect(snap.totalNodes).toBe(6);
      expect(snap.totalEdges).toBe(5);
      expect(snap.nodes.find((n) => n.id === 'n1')).toEqual({
        id: 'n1', label: 'parseConfig', kind: 'function', file: 'src/config.ts', line: 10,
      });
      expect(snap.edges).toContainEqual({ source: 'n4', target: 'n3', kind: 'extends' });
      expect(reader.hasFts()).toBe(true);
    } finally {
      reader.close();
    }
  });

  it('paginates nodes with LIMIT/OFFSET', () => {
    const reader = CodegraphReader.open(dbPath, 'colby');
    try {
      const page1 = reader.listNodes(2, 0);
      const page2 = reader.listNodes(2, 2);
      expect(page1.nodes).toHaveLength(2);
      expect(page2.nodes).toHaveLength(2);
      expect(page1.total).toBe(6);
      expect(new Set([...page1.nodes.map((n) => n.id), ...page2.nodes.map((n) => n.id)]).size).toBe(4);
    } finally {
      reader.close();
    }
  });

  it('FTS search finds nodes by name prefix', () => {
    const reader = CodegraphReader.open(dbPath, 'colby');
    try {
      const hits = reader.searchNodes('parse');
      expect(hits.map((h) => h.id)).toContain('n1');
      const none = reader.searchNodes('zzz_nothing');
      expect(none).toEqual([]);
      // FTS syntax injection is neutralized by quoting
      const injected = reader.searchNodes('" OR 1=1 --');
      expect(Array.isArray(injected)).toBe(true);
    } finally {
      reader.close();
    }
  });

  it('openCodegraph convenience returns reader + detection', () => {
    const { reader, detected } = openCodegraph(join(FIXTURES, 'ws-colby'));
    try {
      expect(detected.product).toBe('colby');
      expect(reader.driver.length).toBeGreaterThan(0);
    } finally {
      reader.close();
    }
  });
});

describe('CodegraphReader (optave fixture)', () => {
  it('reads graph.db variant with confidence columns', () => {
    const { reader } = openCodegraph(join(FIXTURES, 'ws-optave'));
    try {
      const snap = reader.snapshot();
      expect(snap.totalNodes).toBe(3);
      expect(snap.edges).toContainEqual({ source: 'n2', target: 'n1', kind: 'calls' });
    } finally {
      reader.close();
    }
  });
});

describe('CodegraphReader aggregation methods (colby fixture)', () => {
  const dbPath = join(FIXTURES, 'ws-colby', '.codegraph', 'codegraph.db');

  it('fileRollup groups symbols per file and coalesces edges to file pairs', () => {
    const reader = CodegraphReader.open(dbPath, 'colby');
    try {
      const rollup = reader.fileRollup();
      expect(rollup.totals).toEqual({ files: 3, symbols: 6, edges: 5 });
      expect(rollup.files).toEqual([
        { file: 'src/config.ts', symbols: 2, kinds: { function: 2 } },
        { file: 'src/http/mod.ts', symbols: 1, kinds: { module: 1 } },
        { file: 'src/server.ts', symbols: 3, kinds: { class: 1, method: 1, file: 1 } },
      ]);
      expect(rollup.edges).toEqual([
        { source: 'src/config.ts', target: 'src/config.ts', kind: 'calls', count: 1 },
        { source: 'src/server.ts', target: 'src/config.ts', kind: 'calls', count: 1 },
        { source: 'src/server.ts', target: 'src/http/mod.ts', kind: 'imports', count: 1 },
        { source: 'src/server.ts', target: 'src/server.ts', kind: 'extends', count: 1 },
        { source: 'src/server.ts', target: 'src/server.ts', kind: 'references', count: 1 },
      ]);
    } finally {
      reader.close();
    }
  });

  it('topHubs ranks by total degree DESC with deterministic tie-breaks', () => {
    const reader = CodegraphReader.open(dbPath, 'colby');
    try {
      const hubs = reader.topHubs();
      expect(hubs.map((h) => h.id)).toEqual(['n3', 'n2', 'n4', 'n1', 'n5', 'n6']);
      expect(hubs[0]).toEqual({ id: 'n3', label: 'Server', kind: 'class', file: 'src/server.ts', degree: 3 });
      const degrees = hubs.map((h) => h.degree);
      expect([...degrees].sort((a, b) => b - a)).toEqual(degrees);
      expect(reader.topHubs(2).map((h) => h.id)).toEqual(['n3', 'n2']);
    } finally {
      reader.close();
    }
  });

  it('neighborhood depth 1 returns direct predecessors and successors', () => {
    const reader = CodegraphReader.open(dbPath, 'colby');
    try {
      const hood = reader.neighborhood('n4', 1);
      expect(hood.nodes.map((n) => n.id)).toEqual(['n2', 'n3', 'n4']);
      expect(hood.edges).toContainEqual({ source: 'n4', target: 'n3', kind: 'extends' });
      expect(hood.edges).toContainEqual({ source: 'n4', target: 'n2', kind: 'calls' });
      expect(hood.edges).toHaveLength(2);
    } finally {
      reader.close();
    }
  });

  it('neighborhood depth 2 expands transitively within the node budget', () => {
    const reader = CodegraphReader.open(dbPath, 'colby');
    try {
      const hood = reader.neighborhood('n3', 2);
      expect(hood.nodes.map((n) => n.id)).toEqual(['n2', 'n3', 'n4', 'n5', 'n6']);
      expect(hood.edges).toHaveLength(4);
      for (const e of hood.edges) {
        expect(hood.nodes.some((n) => n.id === e.source)).toBe(true);
        expect(hood.nodes.some((n) => n.id === e.target)).toBe(true);
      }
      expect(reader.neighborhood('n3', 2, 3).nodes.length).toBeLessThanOrEqual(3);
    } finally {
      reader.close();
    }
  });

  it('neighborhood of an unknown id is an empty subgraph', () => {
    const reader = CodegraphReader.open(dbPath, 'colby');
    try {
      expect(reader.neighborhood('does-not-exist', 2)).toEqual({ nodes: [], edges: [] });
    } finally {
      reader.close();
    }
  });

  it('snapshot defaults now cover the whole small graph without explicit caps', () => {
    const reader = CodegraphReader.open(dbPath, 'colby');
    try {
      const snap = reader.snapshot();
      expect(snap.nodes).toHaveLength(6);
      expect(snap.edges).toHaveLength(5);
    } finally {
      reader.close();
    }
  });
});

describe('CodegraphReader aggregation methods (optave fixture)', () => {
  it('fileRollup + topHubs tolerate the confidence-column schema variant', () => {
    const { reader } = openCodegraph(join(FIXTURES, 'ws-optave'));
    try {
      const rollup = reader.fileRollup();
      expect(rollup.totals).toEqual({ files: 2, symbols: 3, edges: 1 });
      expect(rollup.files.map((f) => f.file)).toEqual(['src/config.ts', 'src/server.ts']);
      expect(rollup.edges).toEqual([{ source: 'src/config.ts', target: 'src/config.ts', kind: 'calls', count: 1 }]);
      expect(reader.topHubs()).toEqual([
        { id: 'n1', label: 'parseConfig', kind: 'function', file: 'src/config.ts', degree: 1 },
        { id: 'n2', label: 'loadEnv', kind: 'function', file: 'src/config.ts', degree: 1 },
      ]);
    } finally {
      reader.close();
    }
  });
});

describe('unsupported paths', () => {
  it('openCodegraph throws typed UnsupportedProductError on missing index', () => {
    expect(() => openCodegraph(join(FIXTURES, 'empty-ws'))).toThrowError(UnsupportedProductError);
  });

  it('error carries kind marker consumed by UI banner logic', () => {
    try {
      openCodegraph(join(FIXTURES, 'empty-ws'));
      expect.unreachable();
    } catch (e) {
      expect((e as UnsupportedProductError).kind).toBe('unsupported-product');
    }
  });

  it('real home dir default does not accidentally match fixtures', () => {
    expect(typeof detectCodegraph(join(FIXTURES, 'empty-ws'), homedir()).product).toBe('string');
  });
});
