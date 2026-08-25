// Forces the node:sqlite DatabaseSync FALLBACK driver by making the
// better-sqlite3 CJS require throw, then verifies fixture DBs still read via
// the fallback (ABI-mismatch resilience path from package.json's decision note).
// Isolated file so the Module._load patch cannot leak into other suites.
import { afterAll, describe, expect, it } from 'vitest';
import Module from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const patched = Module as unknown as {
  _load: (this: unknown, request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = patched._load;
let nodeSqliteMode: 'ok' | 'throw' | 'non-function' = 'ok';
patched._load = function (request, parent, isMain) {
  if (request === 'better-sqlite3') throw new Error('simulated: driver unavailable');
  if (request === 'node:sqlite') {
    if (nodeSqliteMode === 'throw') throw new Error('simulated: driver unavailable');
    if (nodeSqliteMode === 'non-function') return { DatabaseSync: 42 };
  }
  return originalLoad.call(this, request, parent, isMain);
};
afterAll(() => {
  patched._load = originalLoad;
});

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

describe('codegraph node:sqlite fallback driver', () => {
  it('opens the colby fixture via DatabaseSync when better-sqlite3 is unavailable', async () => {
    const mod = await import('../src/host/codegraph.js');
    const { reader, detected } = mod.openCodegraph(join(FIXTURES, 'ws-colby'));
    try {
      expect(detected.product).toBe('colby');
      expect(reader.driver).toBe('node:sqlite');
      const snap = reader.snapshot();
      expect(snap.totalNodes).toBe(6);
      expect(snap.totalEdges).toBe(5);
      expect(reader.searchNodes('parse').map((h) => h.id)).toContain('n1');
    } finally {
      reader.close();
    }
  });

  it('opens the optave fixture via the fallback too', async () => {
    const mod = await import('../src/host/codegraph.js');
    const { reader } = mod.openCodegraph(join(FIXTURES, 'ws-optave'));
    try {
      expect(reader.driver).toBe('node:sqlite');
      expect(reader.snapshot().totalNodes).toBe(3);
    } finally {
      reader.close();
    }
  });

  it('throws the typed no-driver error when BOTH drivers are unavailable', async () => {
    const mod = await import('../src/host/codegraph.js');
    nodeSqliteMode = 'throw';
    try {
      expect(() => mod.CodegraphReader.open(join(FIXTURES, 'ws-colby', '.codegraph', 'codegraph.db'), 'colby'))
        .toThrowError(/No SQLite driver available/);
    } finally {
      nodeSqliteMode = 'ok';
    }
  });

  it('ignores a node:sqlite export that is not a DatabaseSync constructor', async () => {
    const mod = await import('../src/host/codegraph.js');
    nodeSqliteMode = 'non-function';
    try {
      expect(() => mod.CodegraphReader.open(join(FIXTURES, 'ws-colby', '.codegraph', 'codegraph.db'), 'colby'))
        .toThrowError(/No SQLite driver available/);
    } finally {
      nodeSqliteMode = 'ok';
    }
  });
});
