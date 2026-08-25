// build-fixture-db.mjs — builds committed tiny codegraph SQLite fixtures via
// plain DDL (no ORM, no better-sqlite3 needed — uses built-in node:sqlite).
//
// Layout produced (consumed by test/codegraph.test.ts):
//   test/fixtures/ws-colby/.codegraph/codegraph.db   ← colby schema + nodes_fts
//   test/fixtures/ws-optave/.codegraph/graph.db      ← optave variant (+confidence)
//   test/fixtures/fake-home/.codegraph/graph.db      ← global index → unsupported
//   test/fixtures/empty-ws/ , test/fixtures/no-home/ ← empty roots
//
// Conventions (mirroring the colby schema):
//   nodes(id TEXT PK, kind, name, qualified_name, file_path, language,
//         start_line, end_line, docstring, signature)
//   edges(source TEXT, target TEXT, kind TEXT, metadata TEXT, line INT, col INT)
//   files(path TEXT PK, content_hash TEXT)
//   nodes_fts  — FTS5 over name; rowid ALIGNED with nodes.rowid
//
// Run: npm run build:fixture-db
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

const NODES = [
  // id, kind, name, qualified_name, file_path, language, start_line, end_line
  ['n1', 'function', 'parseConfig', 'config.parseConfig', 'src/config.ts', 'typescript', 10, 42],
  ['n2', 'function', 'loadEnv', 'config.loadEnv', 'src/config.ts', 'typescript', 44, 60],
  ['n3', 'class', 'Server', 'http.Server', 'src/server.ts', 'typescript', 5, 120],
  ['n4', 'method', 'listen', 'http.Server.listen', 'src/server.ts', 'typescript', 30, 48],
  ['n5', 'module', 'http', 'http', 'src/http/mod.ts', 'typescript', 1, 1],
  ['n6', 'file', 'server.ts', 'server.ts', 'src/server.ts', 'typescript', 1, 130],
];

const EDGES = [
  // source, target, kind
  ['n4', 'n3', 'extends'],
  ['n2', 'n1', 'calls'],
  ['n4', 'n2', 'calls'],
  ['n3', 'n5', 'imports'],
  ['n6', 'n3', 'references'],
];

function freshDir(p) {
  rmSync(p, { recursive: true, force: true });
  mkdirSync(join(p, '.codegraph'), { recursive: true });
}

function buildColby(rootDir) {
  const db = new DatabaseSync(join(rootDir, '.codegraph', 'codegraph.db'));
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
  const insN = db.prepare('INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insF = db.prepare('INSERT INTO nodes_fts (rowid, name) VALUES (?, ?)');
  const rowidOf = db.prepare('SELECT rowid AS r FROM nodes WHERE id = ?');
  for (const [id, kind, name, qn, fp, lang, l0, l1] of NODES) {
    insN.run(id, kind, name, qn, fp, lang, l0, l1);
    const row = rowidOf.get(id);
    insF.run(Number(row.r), name); // FTS rowid aligned with nodes.rowid
  }
  const insE = db.prepare('INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)');
  for (const [s, t, k] of EDGES) insE.run(s, t, k);
  db.prepare('INSERT INTO files (path, content_hash) VALUES (?, ?)').run('src/config.ts', 'deadbeef');
  db.close();
}

function buildOptave(rootDir) {
  const db = new DatabaseSync(join(rootDir, '.codegraph', 'graph.db'));
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
      qualified_name TEXT, file_path TEXT, language TEXT,
      start_line INTEGER, end_line INTEGER, confidence REAL
    );
    CREATE TABLE edges (
      source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL,
      confidence REAL
    );
  `);
  const insN = db.prepare('INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [id, kind, name, qn, fp, lang, l0, l1] of NODES.slice(0, 3)) {
    insN.run(id, kind, name, qn, fp, lang, l0, l1, 0.97);
  }
  db.prepare('INSERT INTO edges (source, target, kind, confidence) VALUES (?, ?, ?, ?)').run('n2', 'n1', 'calls', 0.9);
  db.close();
}

// ws-colby: full colby index with FTS
freshDir(join(fixturesDir, 'ws-colby'));
buildColby(join(fixturesDir, 'ws-colby'));

// ws-optave: graph.db variant with confidence columns
freshDir(join(fixturesDir, 'ws-optave'));
buildOptave(join(fixturesDir, 'ws-optave'));

// fake-home: a GLOBAL ~/.codegraph/graph.db → must be detected unsupported
rmSync(join(fixturesDir, 'fake-home'), { recursive: true, force: true });
mkdirSync(join(fixturesDir, 'fake-home', '.codegraph'), { recursive: true });
buildOptave(join(fixturesDir, 'fake-home'));

// empty roots (wiped then re-created; .gitkeep restored so git tracks them)
for (const d of ['empty-ws', 'no-home']) {
  rmSync(join(fixturesDir, d), { recursive: true, force: true });
  mkdirSync(join(fixturesDir, d), { recursive: true });
  writeFileSync(join(fixturesDir, d, '.gitkeep'), '');
}

console.log('fixtures built under', fixturesDir);