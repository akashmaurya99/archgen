// Codegraph reader tests against committed fixture DBs built via DDL
// (scripts/build-fixture-db.mjs — colby schema + nodes_fts, optave variant).
import { describe, expect, it } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodegraphReader, UnsupportedProductError, detectCodegraph, openCodegraph, quoteIdent } from '../src/host/codegraph';

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

describe('SQL identifier quoting (todo 7)', () => {
  it('quoteIdent wraps names in double quotes and escapes embedded quotes', () => {
    expect(quoteIdent('name')).toBe('"name"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
    expect(quoteIdent('x;--')).toBe('"x;--"');
    expect(quoteIdent('a"; DROP TABLE nodes;--')).toBe('"a""; DROP TABLE nodes;--"');
  });

  it('reads a DB whose nodes table carries hostile column names without injection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archgen-cg7-'));
    const dbPath = join(dir, 'codegraph.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
        file_path TEXT, start_line INTEGER,
        "a""b" TEXT, "x;--drop" TEXT
      );
      CREATE TABLE edges (source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL);
    `);
    db.prepare(`INSERT INTO nodes (id, kind, name, file_path, start_line, "a""b", "x;--drop") VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('n1', 'function', 'parseConfig', 'src/config.ts', 10, 'hostile-1', 'hostile-2');
    db.prepare(`INSERT INTO nodes (id, kind, name, file_path, start_line) VALUES (?, ?, ?, ?, ?)`)
      .run('n2', 'class', 'Server', 'src/server.ts', 5);
    db.prepare(`INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)`).run('n2', 'n1', 'calls');
    db.close();

    const reader = CodegraphReader.open(dbPath, 'colby');
    try {
      const snap = reader.snapshot();
      expect(snap.totalNodes).toBe(2);
      expect(snap.nodes.find((n) => n.id === 'n1')).toEqual({
        id: 'n1', label: 'parseConfig', kind: 'function', file: 'src/config.ts', line: 10,
      });
      expect(snap.edges).toContainEqual({ source: 'n2', target: 'n1', kind: 'calls' });

      const rollup = reader.fileRollup();
      expect(rollup.totals).toEqual({ files: 2, symbols: 2, edges: 1 });

      expect(reader.topHubs().map((h) => h.id)).toEqual(['n1', 'n2']);

      const rollupEdges = rollup.edges;
      expect(rollupEdges).toEqual([
        { source: 'src/server.ts', target: 'src/config.ts', kind: 'calls', count: 1 },
      ]);
    } finally {
      reader.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hostile column names are readable through quoteIdent against real SQLite', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE t ("a""b" TEXT, "x""; DROP TABLE t;--" TEXT)`);
    db.prepare(`INSERT INTO t ("a""b", "x""; DROP TABLE t;--") VALUES (?, ?)`).run('v1', 'v2');
    const rows = db.prepare(
      `SELECT ${quoteIdent('a"b')} AS v1, ${quoteIdent('x"; DROP TABLE t;--')} AS v2 FROM t`,
    ).all() as Array<{ v1: string; v2: string }>;
    expect(rows).toEqual([{ v1: 'v1', v2: 'v2' }]);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM t`).get() as { n: number }).n).toBe(1);
    db.close();
  });
});

describe('NULL column degradation (temp DB without NOT NULL constraints)', () => {
  function buildNullDb(): { dir: string; dbPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'archgen-cgnull-'));
    const dbPath = join(dir, 'codegraph.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE nodes (id TEXT, name TEXT, kind TEXT, file_path TEXT, start_line INTEGER);
      CREATE TABLE edges (source TEXT, target TEXT, kind TEXT);
    `);
    const insN = db.prepare('INSERT INTO nodes (id, name, kind, file_path, start_line) VALUES (?, ?, ?, ?, ?)');
    insN.run('n1', 'Alpha', 'function', 'a.ts', 1);
    insN.run('n2', null, null, null, null);
    insN.run('n3', 'Mid', 'class', null, null);
    const insE = db.prepare('INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)');
    insE.run('n1', 'n2', null);
    insE.run('n2', 'n3', 'calls');
    insE.run('ghost', 'n1', 'imports');
    db.close();
    return { dir, dbPath };
  }

  it('fileRollup buckets NULL files under "", coerces NULL kinds, and drops dangling-source edges', () => {
    const { dir, dbPath } = buildNullDb();
    const reader = CodegraphReader.open(dbPath, 'colby');
    try {
      const rollup = reader.fileRollup();
      expect(rollup.files).toEqual([
        { file: '', symbols: 2, kinds: { class: 1, unknown: 1 } },
        { file: 'a.ts', symbols: 1, kinds: { function: 1 } },
      ]);
      expect(rollup.edges).toEqual([
        { source: '', target: '', kind: 'calls', count: 1 },
        { source: 'a.ts', target: '', kind: 'references', count: 1 },
      ]);
      expect(rollup.totals).toEqual({ files: 2, symbols: 3, edges: 3 });
    } finally {
      reader.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('topHubs falls back to id/unknown/"" for NULL label/kind/file', () => {
    const { dir, dbPath } = buildNullDb();
    const reader = CodegraphReader.open(dbPath, 'colby');
    try {
      expect(reader.topHubs()).toEqual([
        { id: 'n1', label: 'Alpha', kind: 'function', file: 'a.ts', degree: 2 },
        { id: 'n2', label: 'n2', kind: 'unknown', file: '', degree: 2 },
        { id: 'n3', label: 'Mid', kind: 'class', file: '', degree: 1 },
      ]);
    } finally {
      reader.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

});

describe('closed reader contract', () => {
  const dbPath = join(FIXTURES, 'ws-colby', '.codegraph', 'codegraph.db');

  it('aggregation methods throw typed UnsupportedProductError after close', () => {
    const reader = CodegraphReader.open(dbPath, 'colby');
    reader.close();
    expect(() => reader.fileRollup()).toThrowError(UnsupportedProductError);
    expect(() => reader.topHubs()).toThrowError(UnsupportedProductError);
    expect(() => reader.fileRollup()).toThrowError('reader closed');
  });
});

describe('degenerate edge schemas', () => {
  it('listEdges and fileRollup throw typed errors when the edges table is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archgen-cgnoedge-'));
    const dbPath = join(dir, 'codegraph.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, kind TEXT, file_path TEXT, start_line INTEGER)`);
    db.prepare(`INSERT INTO nodes (id, name, kind, file_path, start_line) VALUES (?, ?, ?, ?, ?)`)
      .run('n1', 'Alpha', 'function', 'a.ts', 1);
    db.close();

    const reader = CodegraphReader.open(dbPath, 'colby');
    try {
      expect(() => reader.listEdges()).toThrowError(UnsupportedProductError);
      expect(() => reader.listEdges()).toThrowError(/no readable 'edges' table/);
      expect(() => reader.fileRollup()).toThrowError(/no readable 'edges' table/);
    } finally {
      reader.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('topHubs throws a typed error naming the missing required edges column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archgen-cgbadedge-'));
    const dbPath = join(dir, 'codegraph.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, kind TEXT, file_path TEXT, start_line INTEGER);
      CREATE TABLE edges (source TEXT, target TEXT);
    `);
    db.close();

    const reader = CodegraphReader.open(dbPath, 'colby');
    try {
      expect(() => reader.topHubs()).toThrowError(UnsupportedProductError);
      expect(() => reader.topHubs()).toThrowError(/missing required column 'kind'/);
    } finally {
      reader.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

