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
import type { FileRollupVM, HubVM } from '../shared/protocol';

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

/** Structural slice of a driver statement we cache per SQL string (prepared statements). */
interface CachedStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

/** Cache prepared statements per connection — repeated BFS/aggregation rounds reuse them. */
function statementCache(db: { prepare(sql: string): unknown }): (sql: string) => CachedStatement {
  const cache = new Map<string, CachedStatement>();
  return (sql: string) => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql) as CachedStatement;
      cache.set(sql, stmt);
    }
    return stmt;
  };
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
        const prep = statementCache(db);
        return {
          all: (sql, ...params) => prep(sql).all(...params) as Array<Record<string, unknown>>,
          get: (sql, ...params) => prep(sql).get(...params) as Record<string, unknown> | undefined,
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
        const prep = statementCache(db);
        return {
          all: (sql, ...params) => prep(sql).all(...params) as Array<Record<string, unknown>>,
          get: (sql, ...params) => prep(sql).get(...params) as Record<string, unknown> | undefined,
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

/** IN-clause batch size — stays under conservative SQLITE_MAX_VARIABLE_NUMBER floors. */
const NEIGHBORHOOD_PARAM_CHUNK = 400;

/** Record one BFS edge and enqueue its not-yet-seen endpoint for the next round. */
function absorbNeighbor(
  row: Record<string, unknown>,
  visited: Set<string>,
  roundSeen: Set<string>,
  discovered: string[],
  edgeByKey: Map<string, GraphEdge>,
): void {
  const source = String(row['source']);
  const target = String(row['target']);
  const kind = String(row['kind'] ?? 'references');
  edgeByKey.set(`${source}\u0000${target}\u0000${kind}`, { source, target, kind });
  for (const candidate of [target, source]) {
    if (!visited.has(candidate) && !roundSeen.has(candidate)) {
      roundSeen.add(candidate);
      discovered.push(candidate);
    }
  }
}

/** Column aliases tolerated across schema variants (colby vs optave confidence columns etc.). */
function pickColumn(available: Set<string>, candidates: string[], fallback: string): string {
  for (const c of candidates) if (available.has(c)) return c;
  return fallback;
}

/**
 * Quote a SQL identifier (defense in depth, todo 7): wrap in double quotes and
 * escape embedded `"` as `""`. Every schema-derived name interpolated into SQL
 * goes through this — values stay parameter-bound, identifiers get quoted.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
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
      const rows = this.handle.all(`PRAGMA table_info(${quoteIdent(table)})`);
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
      `SELECT ${quoteIdent(idC)} AS id, ${quoteIdent(labelC)} AS label, ${quoteIdent(kindC)} AS kind, ${quoteIdent(fileC)} AS file, ${quoteIdent(lineC)} AS line
       FROM nodes ORDER BY ${quoteIdent(idC)} LIMIT ? OFFSET ?`,
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

  /**
   * Snapshot caps sized for 50k-scale indexes: the full constellation rides to
   * the Canvas MAP layer while the DOM graph renders file rollups instead.
   * Explicit limits keep older callers working unchanged.
   */
  snapshot(nodeLimit = 60000, edgeLimit = 150000): GraphSnapshot {
    const n = this.listNodes(nodeLimit);
    const e = this.listEdges(edgeLimit);
    return { nodes: n.nodes, edges: e.edges, totalNodes: n.total, totalEdges: e.total, hasFts: this.hasFts() };
  }

  /** Resolved node column aliases for SELECTs (schema-variant tolerant). */
  private nodeCols(): { id: string; label: string; kind: string; file: string; line: string } {
    const cols = this.tableColumns('nodes');
    return {
      id: pickColumn(cols, ['id'], 'id'),
      label: pickColumn(cols, ['name', 'label', 'qualified_name'], 'name'),
      kind: pickColumn(cols, ['kind'], 'kind'),
      file: pickColumn(cols, ['file_path', 'file', 'path'], 'file_path'),
      line: pickColumn(cols, ['start_line', 'line'], 'start_line'),
    };
  }

  private requireEdgesTable(): void {
    const cols = this.tableColumns('edges');
    if (cols.size === 0) throw new UnsupportedProductError(`${this.dbPath} has no readable 'edges' table`);
    for (const c of EDGE_COLUMNS) {
      if (!cols.has(c)) throw new UnsupportedProductError(`${this.dbPath} edges table is missing required column '${c}'`);
    }
  }

  /**
   * File-level aggregation over the whole index.
   *  - symbols/kinds per file: single SQL GROUP BY scan of nodes;
   *  - cross-file edges: one nodes scan builds an id→file map, one edges scan
   *    aggregates by (source file, target file, kind) with INNER-JOIN
   *    semantics (dangling endpoints dropped).
   *
   * Why not `edges JOIN nodes … GROUP BY`? Measured at 50k nodes / 125k edges:
   * 250k TEXT-PK B-tree probes cost 410–460ms warm, blowing the <250ms budget;
   * the two-scan shape runs ~210ms. No CREATE INDEX is ever issued — the db is
   * read-only and must stay that way.
   */
  fileRollup(): FileRollupVM {
    if (!this.handle) throw new UnsupportedProductError('reader closed');
    this.requireEdgesTable();
    const nc = this.nodeCols();

    const kindRows = this.handle.all(
      `SELECT ${quoteIdent(nc.file)} AS file, ${quoteIdent(nc.kind)} AS kind, COUNT(*) AS n FROM nodes GROUP BY ${quoteIdent(nc.file)}, ${quoteIdent(nc.kind)}`,
    );
    const byFile = new Map<string, FileRollupVM['files'][number]>();
    const idToFile = new Map<string, string>();
    for (const r of kindRows) {
      const file = String(r['file'] ?? '');
      const kind = String(r['kind'] ?? 'unknown');
      const n = Number(r['n'] ?? 0);
      let entry = byFile.get(file);
      if (!entry) {
        entry = { file, symbols: 0, kinds: {} };
        byFile.set(file, entry);
      }
      entry.symbols += n;
      entry.kinds[kind] = (entry.kinds[kind] ?? 0) + n;
    }
    for (const r of this.handle.all(`SELECT ${quoteIdent(nc.id)} AS id, ${quoteIdent(nc.file)} AS file FROM nodes`)) {
      idToFile.set(String(r['id']), String(r['file'] ?? ''));
    }

    const counts = new Map<string, number>();
    const keys: Array<{ source: string; target: string; kind: string }> = [];
    for (const r of this.handle.all(`SELECT source, target, kind FROM edges`)) {
      const sourceFile = idToFile.get(String(r['source']));
      const targetFile = idToFile.get(String(r['target']));
      if (sourceFile === undefined || targetFile === undefined) continue;
      const kind = String(r['kind'] ?? 'references');
      const key = `${sourceFile}\u0000${targetFile}\u0000${kind}`;
      const prev = counts.get(key);
      if (prev === undefined) {
        counts.set(key, 1);
        keys.push({ source: sourceFile, target: targetFile, kind });
      } else {
        counts.set(key, prev + 1);
      }
    }

    const symbolsRow = this.handle.get(`SELECT COUNT(*) AS n FROM nodes`);
    const edgesRow = this.handle.get(`SELECT COUNT(*) AS n FROM edges`);
    const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    return {
      files: [...byFile.values()].sort((a, b) => cmpStr(a.file, b.file)),
      edges: keys
        .map((k) => ({ ...k, count: counts.get(`${k.source}\u0000${k.target}\u0000${k.kind}`) ?? 0 }))
        .sort((a, b) => cmpStr(a.source, b.source) || cmpStr(a.target, b.target) || cmpStr(a.kind, b.kind)),
      totals: {
        files: byFile.size,
        symbols: Number(symbolsRow?.['n'] ?? 0),
        edges: Number(edgesRow?.['n'] ?? 0),
      },
    };
  }

  /**
   * Highest-degree nodes (in+out) in one UNION ALL + GROUP BY query, joined
   * back to nodes for label/kind/file. Ties break by id ASC for determinism.
   */
  topHubs(limit = 25): HubVM[] {
    if (!this.handle) throw new UnsupportedProductError('reader closed');
    this.requireEdgesTable();
    const nc = this.nodeCols();
    const rows = this.handle.all(
      `SELECT n.${quoteIdent(nc.id)} AS id, n.${quoteIdent(nc.label)} AS label, n.${quoteIdent(nc.kind)} AS kind, n.${quoteIdent(nc.file)} AS file, h.degree AS degree
       FROM (
         SELECT id, SUM(deg) AS degree FROM (
           SELECT source AS id, COUNT(*) AS deg FROM edges GROUP BY source
           UNION ALL
           SELECT target AS id, COUNT(*) AS deg FROM edges GROUP BY target
         ) GROUP BY id
       ) h
       JOIN nodes n ON n.${quoteIdent(nc.id)} = h.id
       ORDER BY h.degree DESC, n.${quoteIdent(nc.id)} ASC
       LIMIT ?`,
      limit,
    );
    return rows.map((r) => ({
      id: String(r['id']),
      label: String(r['label'] ?? r['id']),
      kind: String(r['kind'] ?? 'unknown'),
      file: String(r['file'] ?? ''),
      degree: Number(r['degree'] ?? 0),
    }));
  }

  /**
   * BFS subgraph around `id` via iterative SQL rounds: per depth level, one
   * parameter-batched `WHERE source IN (?)` + one `WHERE target IN (?)` round
   * trip against cached prepared statements. Node budget `limit` bounds both
   * expansion and result size; returned edges always have BOTH endpoints in
   * the returned node set.
   */
  neighborhood(id: string, depth: 1 | 2, limit = 300): { nodes: GraphNode[]; edges: GraphEdge[] } {
    if (!this.handle) throw new UnsupportedProductError('reader closed');
    this.requireEdgesTable();

    const visited = new Set<string>([id]);
    const edgeByKey = new Map<string, GraphEdge>();
    let frontier: string[] = [id];

    for (let d = 0; d < depth && frontier.length > 0 && visited.size < limit; d++) {
      const discovered: string[] = [];
      const roundSeen = new Set<string>();
      for (let i = 0; i < frontier.length; i += NEIGHBORHOOD_PARAM_CHUNK) {
        const batch = frontier.slice(i, i + NEIGHBORHOOD_PARAM_CHUNK);
        const placeholders = batch.map(() => '?').join(',');
        const outgoing = this.handle.all(`SELECT source, target, kind FROM edges WHERE source IN (${placeholders})`, ...batch);
        for (const r of outgoing) absorbNeighbor(r, visited, roundSeen, discovered, edgeByKey);
        const incoming = this.handle.all(`SELECT source, target, kind FROM edges WHERE target IN (${placeholders})`, ...batch);
        for (const r of incoming) absorbNeighbor(r, visited, roundSeen, discovered, edgeByKey);
      }
      const admitted = discovered.slice(0, Math.max(0, limit - visited.size));
      for (const nid of admitted) visited.add(nid);
      frontier = admitted;
    }

    const nc = this.nodeCols();
    const nodes: GraphNode[] = [];
    const wanted = [...visited];
    for (let i = 0; i < wanted.length; i += NEIGHBORHOOD_PARAM_CHUNK) {
      const batch = wanted.slice(i, i + NEIGHBORHOOD_PARAM_CHUNK);
      const placeholders = batch.map(() => '?').join(',');
      const rows = this.handle.all(
        `SELECT ${quoteIdent(nc.id)} AS id, ${quoteIdent(nc.label)} AS label, ${quoteIdent(nc.kind)} AS kind, ${quoteIdent(nc.file)} AS file, ${quoteIdent(nc.line)} AS line
         FROM nodes WHERE ${quoteIdent(nc.id)} IN (${placeholders})`,
        ...batch,
      );
      for (const r of rows) {
        nodes.push({
          id: String(r['id']),
          label: String(r['label'] ?? r['id']),
          kind: String(r['kind'] ?? 'unknown'),
          file: String(r['file'] ?? ''),
          line: Number(r['line'] ?? 0),
        });
      }
    }
    nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const edges = [...edgeByKey.values()]
      .filter((e) => visited.has(e.source) && visited.has(e.target))
      .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
    return { nodes, edges };
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
          `SELECT n.${quoteIdent(idC)} AS id, n.${quoteIdent(labelC)} AS label, n.${quoteIdent(kindC)} AS kind, n.${quoteIdent(fileC)} AS file, n.${quoteIdent(lineC)} AS line
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
      `SELECT ${quoteIdent(idC)} AS id, ${quoteIdent(labelC)} AS label, ${quoteIdent(kindC)} AS kind, ${quoteIdent(fileC)} AS file, ${quoteIdent(lineC)} AS line
       FROM nodes WHERE ${quoteIdent(labelC)} LIKE ? ESCAPE '!' LIMIT ?`,
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
