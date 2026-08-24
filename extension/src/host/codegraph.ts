// codegraph.ts — read-only reader over a local codegraph SQLite index.
//
// Product detection (todo 4):
//   <ws>/.codegraph/codegraph.db  → 'colby'   (nodes/edges/files/nodes_fts FTS5)
//   <ws>/.codegraph/graph.db      → 'optave'  (same shape + confidence columns)
//   ~/.codegraph/graph.db         → unsupported (global indexes are not readable
//                                    by this extension; typed error → UI banner)
//
// Driver strategy (decision recorded in package.json "//"):
//   1. better-sqlite3 (pinned dep, externalized in the host bundle)
//   2. node:sqlite DatabaseSync — feature-detected fallback for runtimes where
//      the native binding was not rebuilt for the current Electron ABI
// Both are opened READ-ONLY; the extension can never mutate an index.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type CodegraphProduct = 'colby' | 'optave';

export class UnsupportedProductError extends Error {
  readonly kind = 'unsupported-product';
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedProductError';
  }
}

export interface GraphNode {
  id: string;
  label: string;
  kind: string;
  file: string;
  line: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalNodes: number;
  totalEdges: number;
  hasFts: boolean;
}

export interface DetectedProduct {
  product: CodegraphProduct | 'unsupported';
  dbPath: string | null;
  reason?: string;
}

/** Minimal synchronous read-only driver surface shared by better-sqlite3 and node:sqlite. */
export interface SqliteHandle {
  all(sql: string, ...params: unknown[]): Array<Record<string, unknown>>;
  get(sql: string, ...params: unknown[]): Record<string, unknown> | undefined;
  close(): void;
}

interface DriverModule {
  openReadOnly(dbPath: string): SqliteHandle;
  name: string;
}

/** Load better-sqlite3 lazily so environments without it can still use node:sqlite. */
function betterSqliteDriver(): DriverModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Ctor = require('better-sqlite3');
    return {
      name: 'better-sqlite3',
      openReadOnly(dbPath: string): SqliteHandle {
        const db = new Ctor(dbPath, { readonly: true, fileMustExist: true });
        return {
          all: (sql, ...params) => db.prepare(sql).all(...params),
          get: (sql, ...params) => db.prepare(sql).get(...params),
          close: () => db.close(),
        };
      },
    };
  } catch {
    return null;
  }
}

/** Feature-detect node:sqlite (Node >= 22.5 / Electron >= 33). */
function nodeSqliteDriver(): DriverModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    if (typeof DatabaseSync !== 'function') return null;
    return {
      name: 'node:sqlite',
      openReadOnly(dbPath: string): SqliteHandle {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        return {
          all: (sql, ...params) => db.prepare(sql).all(...params) as Record<string, unknown>[],
          get: (sql, ...params) => db.prepare(sql).get(...params) as Record<string, unknown> | undefined,
          close: () => db.close(),
        };
      },
    };
  } catch {
    return null;
  }
}

export function detectCodegraph(workspaceRoot: string, home = homedir()): DetectedProduct {
  const colbyDb = join(workspaceRoot, '.codegraph', 'codegraph.db');
  const optaveDb = join(workspaceRoot, '.codegraph', 'graph.db');
  const globalDb = join(home, '.codegraph', 'graph.db');

  if (existsSync(colbyDb)) return { product: 'colby', dbPath: colbyDb };
  if (existsSync(optaveDb)) return { product: 'optave', dbPath: optaveDb };
  if (existsSync(globalDb)) {
    return {
      product: 'unsupported',
      dbPath: null,
      reason: `Only workspace-local codegraph indexes are supported. Found a global index at ${globalDb} — open the project that owns its .codegraph/ folder.`,
    };
  }
  return { product: 'unsupported', dbPath: null, reason: `No .codegraph/ index found in this workspace.` };
}

const NODE_COLUMNS = ['id', 'name', 'kind', 'file_path', 'start_line'] as const;
const EDGE_COLUMNS = ['source', 'target', 'kind'] as const;

/** Column aliases tolerated across schema variants (colby vs optave confidence columns etc.). */
function pickColumn(available: Set<string>, candidates: string[], fallback: string): string {
  for (const c of candidates) if (available.has(c)) return c;
  return fallback;
}

export class CodegraphReader {
  private handle: SqliteHandle | null = null;
  private readonly driverName: string;

  private constructor(readonly dbPath: string, readonly product: CodegraphProduct, driver: DriverModule) {
    this.driverName = driver.name;
  }

  static open(dbPath: string, product: CodegraphProduct): CodegraphReader {
    const driver = betterSqliteDriver() ?? nodeSqliteDriver();
    if (!driver) {
      throw new UnsupportedProductError(
        `No SQLite driver available to read ${dbPath}. Install dependencies (better-sqlite3) or run on Node >= 22.5 for node:sqlite.`,
      );
    }
    const reader = new CodegraphReader(dbPath, product, driver);
    try {
      reader.handle = driver.openReadOnly(dbPath);
    } catch (e) {
      throw new UnsupportedProductError(`Cannot open codegraph database at ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return reader;
  }

  /** Human-readable driver used (diagnostics/logging). */
  get driver(): string {
    return this.driverName;
  }

  private tableColumns(table: string): Set<string> {
    if (!this.handle) return new Set();
    try {
      const rows = this.handle.all(`PRAGMA table_info(${table})`);
      return new Set(rows.map((r) => r['name']).filter((n): n is string => typeof n === 'string'));
    } catch {
      return new Set();
    }
  }

  private tableExists(table: string): boolean {
    if (!this.handle) return false;
    const row = this.handle.get(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?`, table);
    return Number(row?.['n'] ?? 0) > 0;
  }

  hasFts(): boolean {
    return this.tableExists('nodes_fts');
  }

  /**
   * Read a page of nodes ordered by id. LIMIT/OFFSET pagination keeps huge
   * graphs from blowing up the webview (view layer virtualizes beyond 500).
   */
  listNodes(limit = 1000, offset = 0): { nodes: GraphNode[]; total: number } {
    if (!this.handle) throw new UnsupportedProductError('reader closed');
    const cols = this.tableColumns('nodes');
    if (cols.size === 0) throw new UnsupportedProductError(`${this.dbPath} has no readable 'nodes' table`);
    const idC = pickColumn(cols, ['id'], 'id');
    const labelC = pickColumn(cols, ['name', 'label', 'qualified_name'], 'name');
    const kindC = pickColumn(cols, ['kind'], 'kind');
    const fileC = pickColumn(cols, ['file_path', 'file', 'path'], 'file_path');
    const lineC = pickColumn(cols, ['start_line', 'line'], 'start_line');

    const totalRow = this.handle.get(`SELECT COUNT(*) AS n FROM nodes`);
    const rows = this.handle.all(
      `SELECT ${idC} AS id, ${labelC} AS label, ${kindC} AS kind, ${fileC} AS file, ${lineC} AS line
       FROM nodes ORDER BY ${idC} LIMIT ? OFFSET ?`,
      limit, offset,
    );
    const nodes: GraphNode[] = rows.map((r) => ({
      id: String(r['id']),
      label: String(r['label'] ?? r['id']),
      kind: String(r['kind'] ?? 'unknown'),
      file: String(r['file'] ?? ''),
      line: Number(r['line'] ?? 0),
    }));
    return { nodes, total: Number(totalRow?.['n'] ?? nodes.length) };
  }

  /** Read a page of edges. */
  listEdges(limit = 2000, offset = 0): { edges: GraphEdge[]; total: number } {
    if (!this.handle) throw new UnsupportedProductError('reader closed');
    const cols = this.tableColumns('edges');
    if (cols.size === 0) throw new UnsupportedProductError(`${this.dbPath} has no readable 'edges' table`);
    for (const c of EDGE_COLUMNS) {
      if (!cols.has(c)) throw new UnsupportedProductError(`${this.dbPath} edges table is missing required column '${c}'`);
    }
    const totalRow = this.handle.get(`SELECT COUNT(*) AS n FROM edges`);
    const rows = this.handle.all(
      `SELECT source, target, kind FROM edges ORDER BY source LIMIT ? OFFSET ?`,
      limit, offset,
    );
    const edges: GraphEdge[] = rows.map((r) => ({
      source: String(r['source']),
      target: String(r['target']),
      kind: String(r['kind'] ?? 'references'),
    }));
    return { edges, total: Number(totalRow?.['n'] ?? edges.length) };
  }

  /** Snapshot with sane caps for first render. */
  snapshot(nodeLimit = 1000, edgeLimit = 2000): GraphSnapshot {
    const n = this.listNodes(nodeLimit);
    const e = this.listEdges(edgeLimit);
    return { nodes: n.nodes, edges: e.edges, totalNodes: n.total, totalEdges: e.total, hasFts: this.hasFts() };
  }

  /**
   * FTS search over nodes_fts when present. User input is wrapped as a quoted
   * phrase + prefix so arbitrary text cannot inject FTS syntax; falls back to
   * a LIKE scan when no FTS table exists.
   */
  searchNodes(query: string, limit = 50): GraphNode[] {
    if (!this.handle || query.trim() === '') return [];
    if (this.hasFts()) {
      const safe = query.replace(/"/g, '""');
      const cols = this.tableColumns('nodes');
      const idC = pickColumn(cols, ['id'], 'id');
      const labelC = pickColumn(cols, ['name', 'label', 'qualified_name'], 'name');
      const kindC = pickColumn(cols, ['kind'], 'kind');
      const fileC = pickColumn(cols, ['file_path', 'file', 'path'], 'file_path');
      const lineC = pickColumn(cols, ['start_line', 'line'], 'start_line');
      try {
        const rows = this.handle.all(
          `SELECT n.${idC} AS id, n.${labelC} AS label, n.${kindC} AS kind, n.${fileC} AS file, n.${lineC} AS line
           FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid
           WHERE nodes_fts MATCH ?
           LIMIT ?`,
          `"${safe}"*`, limit,
        );
        return rows.map((r) => ({
          id: String(r['id']),
          label: String(r['label'] ?? r['id']),
          kind: String(r['kind'] ?? 'unknown'),
          file: String(r['file'] ?? ''),
          line: Number(r['line'] ?? 0),
        }));
      } catch {
        // fall through to LIKE scan
      }
    }
    const like = `%${query.replace(/[%_]/g, '!' )}%`;
    const cols2 = this.tableColumns('nodes');
    const idC = pickColumn(cols2, ['id'], 'id');
    const labelC = pickColumn(cols2, ['name', 'label', 'qualified_name'], 'name');
    const kindC = pickColumn(cols2, ['kind'], 'kind');
    const fileC = pickColumn(cols2, ['file_path', 'file', 'path'], 'file_path');
    const lineC = pickColumn(cols2, ['start_line', 'line'], 'start_line');
    const rows = this.handle.all(
      `SELECT ${idC} AS id, ${labelC} AS label, ${kindC} AS kind, ${fileC} AS file, ${lineC} AS line
       FROM nodes WHERE ${labelC} LIKE ? ESCAPE '!' LIMIT ?`,
      like, limit,
    );
    return rows.map((r) => ({
      id: String(r['id']),
      label: String(r['label'] ?? r['id']),
      kind: String(r['kind'] ?? 'unknown'),
      file: String(r['file'] ?? ''),
      line: Number(r['line'] ?? 0),
    }));
  }

  close(): void {
    this.handle?.close();
    this.handle = null;
  }
}

/** Convenience: detect + open in one step; throws UnsupportedProductError for global/missing indexes. */
export function openCodegraph(workspaceRoot: string): { reader: CodegraphReader; detected: DetectedProduct & { product: CodegraphProduct } } {
  const detected = detectCodegraph(workspaceRoot);
  if (detected.product === 'unsupported' || !detected.dbPath) {
    throw new UnsupportedProductError(detected.reason ?? 'codegraph index not found');
  }
  return { reader: CodegraphReader.open(detected.dbPath, detected.product), detected: detected as DetectedProduct & { product: CodegraphProduct } };
}

// Re-exported for host wiring that only needs stat-level checks.
export function codegraphDbStat(dbPath: string): { exists: boolean; size: number; mtimeMs: number } {
  try {
    const st = statSync(dbPath);
    return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { exists: false, size: 0, mtimeMs: 0 };
  }
}
