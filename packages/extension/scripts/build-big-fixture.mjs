// build-big-fixture.mjs — generates a LARGE colby-format codegraph SQLite DB
// for scale/perf smoke tests (test/codegraph-big.test.ts).
//
// Layout produced:
//   <out>/.codegraph/codegraph.db   ← colby schema + nodes_fts (FTS5)
//
// Realistic shape, fully deterministic (seeded LCG — no Math.random):
//   - ~N/40 files, nodes scattered across them via Knuth multiplicative hash
//   - kinds mix: function 52% / class 18% / import 20% / module 10%
//   - power-law-ish degree distribution: edge targets drawn with a cubic
//     skew over a uniform LCG draw (zipf-style head-heavy ranks)
//   - ~2.5 edges per node (50k nodes → 125k edges ≤ snapshot cap 150k)
//
// Single transaction + prepared statements; <60s at --nodes 50000.
//
// Run: node scripts/build-big-fixture.mjs [--nodes N] [--out DIR] [--seed S]
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_NODES = 5000;
const DEFAULT_SEED = 1337;

/** Deterministic 32-bit LCG stream in [0, 1). */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Knuth multiplicative integer hash scattered into [0, mod). */
function scatter(i, mod) {
  return (Math.imul(i, 2654435761) >>> 0) % mod;
}

const KINDS = [
  ['function', 0.52],
  ['class', 0.18],
  ['import', 0.2],
  ['module', 0.1],
];

const EDGE_KINDS = [
  ['calls', 0.55],
  ['imports', 0.25],
  ['references', 0.15],
  ['extends', 0.05],
];

function pickWeighted(table, u) {
  let acc = 0;
  for (const [value, weight] of table) {
    acc += weight;
    if (u < acc) return value;
  }
  return table[table.length - 1][0];
}

function symbolName(kind, i) {
  switch (kind) {
    case 'class':
      return `Cls${i}`;
    case 'import':
      return `imp_${i}`;
    case 'module':
      return `mod${i}`;
    default:
      return `fn_${i}`;
  }
}

/**
 * Generate the fixture. Returns stats:
 * { nodes, edges, files, elapsedMs, rowsPerSec, dbBytes, dbPath }
 */
export function generateBigFixture({ nodes = DEFAULT_NODES, outDir, seed = DEFAULT_SEED, log = () => {} } = {}) {
  if (!Number.isInteger(nodes) || nodes < 1) throw new Error(`--nodes must be a positive integer, got ${nodes}`);
  const started = Date.now();
  const rootDir = resolve(outDir);
  const dbPath = join(rootDir, '.codegraph', 'codegraph.db');
  rmSync(rootDir, { recursive: true, force: true });
  mkdirSync(join(rootDir, '.codegraph'), { recursive: true });

  const db = new DatabaseSync(dbPath);
  const edgeCount = Math.min(Math.floor(nodes * 2.5), 150000);
  const fileCount = Math.max(1, Math.floor(nodes / 40));
  try {
    // DDL mirrors scripts/build-fixture-db.mjs (colby schema).
    db.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
        qualified_name TEXT, file_path TEXT, language TEXT,
        start_line INTEGER, end_line INTEGER, docstring TEXT, signature TEXT
      );
      CREATE TABLE edges (
        source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL,
        metadata TEXT, line INTEGER, col INTEGER
      );
      CREATE TABLE files (path TEXT PRIMARY KEY, content_hash TEXT);
      CREATE VIRTUAL TABLE nodes_fts USING fts5(name);
    `);

    const rng = lcg(seed);
    const filePaths = [];
    for (let f = 0; f < fileCount; f++) filePaths.push(`src/pkg${f % 24}/mod${f}.ts`);

    db.exec('BEGIN');
    const insFile = db.prepare('INSERT INTO files (path, content_hash) VALUES (?, ?)');
    for (let f = 0; f < fileCount; f++) {
      insFile.run(filePaths[f], scatter(f, 0xffffffff).toString(16).padStart(8, '0'));
    }

    // Explicit rowid keeps nodes_fts rowid alignment direct (no lookup per row).
    const insNode = db.prepare(
      'INSERT INTO nodes (rowid, id, kind, name, qualified_name, file_path, language, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insFts = db.prepare('INSERT INTO nodes_fts (rowid, name) VALUES (?, ?)');
    for (let i = 0; i < nodes; i++) {
      const kind = pickWeighted(KINDS, rng());
      const name = symbolName(kind, i);
      const file = filePaths[scatter(i, fileCount)];
      const line = 1 + scatter(i * 31 + 7, 400);
      insNode.run(i + 1, `n${i}`, kind, name, `${file}::${name}`, file, 'typescript', line, line + 20);
      insFts.run(i + 1, name);
    }

    const insEdge = db.prepare('INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)');

    for (let e = 0; e < edgeCount; e++) {
      const src = scatter(e * 2 + 1, nodes);
      // Zipf-style head-heavy target: cubic skew over a uniform draw.
      let tgt = Math.floor(Math.pow(rng(), 3) * nodes);
      if (tgt >= nodes) tgt = nodes - 1;
      if (tgt === src) tgt = (tgt + 1) % nodes;
      insEdge.run(`n${src}`, `n${tgt}`, pickWeighted(EDGE_KINDS, rng()));
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }

  const elapsedMs = Date.now() - started;
  const rows = nodes * 2 + edgeCount + fileCount;
  const stats = {
    nodes,
    edges: edgeCount,
    files: fileCount,
    elapsedMs,
    rowsPerSec: Math.round((rows / Math.max(elapsedMs, 1)) * 1000),
    dbBytes: statSync(dbPath).size,
    dbPath,
  };
  log(
    `big fixture: ${stats.nodes} nodes / ${stats.edges} edges / ${stats.files} files → ${dbPath} ` +
      `in ${elapsedMs}ms (~${stats.rowsPerSec} rows/sec, ${(stats.dbBytes / 1048576).toFixed(1)} MiB)`,
  );
  return stats;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argValue = (name, fallback) => {
    const idx = process.argv.indexOf(`--${name}`);
    return idx >= 0 && process.argv[idx + 1] !== undefined ? Number(process.argv[idx + 1]) : fallback;
  };
  const outIdx = process.argv.indexOf('--out');
  const outDir =
    outIdx >= 0 && process.argv[outIdx + 1] !== undefined
      ? process.argv[outIdx + 1]
      : join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'big-ws');
  generateBigFixture({ nodes: argValue('nodes', DEFAULT_NODES), seed: argValue('seed', DEFAULT_SEED), outDir, log: console.log });
}
