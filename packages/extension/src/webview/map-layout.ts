// map-layout.ts — deterministic whole-repo packing for the Canvas2D MAP layer.
//
// Pure, O(n) with one O(F log F) sort over file clusters (F = distinct files):
//   1. symbols group by FILE (first-seen order preserved);
//   2. each file becomes one cluster "blob" whose symbols sit on a tight
//      square micro-grid of MAP_CELL_PX cells;
//   3. blobs shelf-pack left→right (wrap at MAP_SHELF_WIDTH), ordered by
//      FOLDER (first path segment, first-seen order) then size DESC.
// No randomness, no wall-clock reads — identical input ⇒ identical output
// (asserted by test/map-layout.test.ts). Sized for 50k+ symbols: grouping is
// a single pass, micro-grid placement is a single pass, only the per-file
// cluster list is sorted.

export interface MapNodeLike {
  id: string;
  label: string;
  kind: string;
  file: string;
  line: number;
}

/** Grid cell edge (px) occupied by one symbol inside its file blob. */
export const MAP_CELL_PX = 14;
/** Horizontal gutter between shelf-packed file blobs. */
export const MAP_SHELF_GAP = 24;
/** Shelf row wrap width (px) — keeps the map roughly screen-shaped. */
export const MAP_SHELF_WIDTH = 2400;

export interface MapPoint {
  x: number;
  y: number;
}

export interface MapFileCluster {
  file: string;
  x: number;
  y: number;
  w: number;
  h: number;
  count: number;
}

export interface MapBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface MapPackResult {
  positions: Map<string, MapPoint>;
  clusters: MapFileCluster[];
  bounds: MapBounds;
}

interface Blob {
  file: string;
  /** first-seen index of the FILE among distinct files — deterministic tiebreak */
  seq: number;
  count: number;
  w: number;
  h: number;
  /** symbol centers in cluster-local coordinates, input order */
  locals: Array<{ id: string; x: number; y: number }>;
}

/**
 * Pack every symbol onto the whole-repo map. See module docblock for the
 * pipeline. Pure: `nodes` is never mutated; returned Maps/arrays are fresh.
 * Duplicate symbol ids OVERWRITE in `positions` (Map keyed by id, last
 * occurrence wins) — repeated ids share the last packed point, so callers
 * must dedupe ids before packing if distinct dots are required.
 */
export function packByFile(nodes: ReadonlyArray<MapNodeLike>): MapPackResult {
  const positions = new Map<string, MapPoint>();
  const clusters: MapFileCluster[] = [];
  if (nodes.length === 0) {
    return { positions, clusters, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
  }

  // 1) group by file — Map preserves first-seen file order.
  const byFile = new Map<string, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) continue;
    const bucket = byFile.get(n.file);
    if (bucket) bucket.push(i);
    else byFile.set(n.file, [i]);
  }

  // 2) per-file micro-grid geometry, bucketed by folder (first path segment).
  const folderOrder: string[] = [];
  const byFolder = new Map<string, Blob[]>();
  let seq = 0;
  for (const [file, idxs] of byFile) {
    const count = idxs.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
    const rows = Math.ceil(count / cols);
    const locals: Array<{ id: string; x: number; y: number }> = new Array(count);
    for (let k = 0; k < count; k++) {
      const nodeIdx = idxs[k];
      const n = nodeIdx === undefined ? undefined : nodes[nodeIdx];
      if (!n) continue;
      locals[k] = {
        id: n.id,
        x: (k % cols) * MAP_CELL_PX + MAP_CELL_PX / 2,
        y: Math.floor(k / cols) * MAP_CELL_PX + MAP_CELL_PX / 2,
      };
    }
    const slash = file.indexOf('/');
    const folder = slash === -1 ? file : file.slice(0, slash);
    let bucket = byFolder.get(folder);
    if (!bucket) {
      bucket = [];
      byFolder.set(folder, bucket);
      folderOrder.push(folder);
    }
    bucket.push({ file, seq: seq++, count, w: cols * MAP_CELL_PX, h: rows * MAP_CELL_PX, locals });
  }

  // 3) order blobs: folder first-seen, then size DESC, then first-seen ASC.
  const ordered: Blob[] = [];
  for (const folder of folderOrder) {
    const bucket = byFolder.get(folder);
    if (!bucket) continue;
    bucket.sort((a, b) => b.count - a.count || a.seq - b.seq);
    for (const b of bucket) ordered.push(b);
  }

  // 4) shelf-pack the ordered blobs.
  let cx = 0;
  let cy = 0;
  let rowH = 0;
  for (const blob of ordered) {
    if (cx > 0 && cx + blob.w > MAP_SHELF_WIDTH) {
      cx = 0;
      cy += rowH + MAP_SHELF_GAP;
      rowH = 0;
    }
    clusters.push({ file: blob.file, x: cx, y: cy, w: blob.w, h: blob.h, count: blob.count });
    for (const l of blob.locals) {
      if (!l) continue;
      positions.set(l.id, { x: cx + l.x, y: cy + l.y });
    }
    cx += blob.w + MAP_SHELF_GAP;
    rowH = Math.max(rowH, blob.h);
  }

  // 5) bounds over cluster rects (every position lies inside its blob).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of clusters) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x + c.w > maxX) maxX = c.x + c.w;
    if (c.y + c.h > maxY) maxY = c.y + c.h;
  }
  return { positions, clusters, bounds: { minX, minY, maxX, maxY } };
}

/* ==== LOD bands — pure function of VIEW scale ==== */

export type LodBand = 'dot' | 'mixed' | 'full';

/** Below this VIEW scale only dots render (no hulls, no labels). */
export const MAP_LOD_DOT_BELOW = 0.15;
/** Above this VIEW scale top-degree labels join hovered/selected labels. */
export const MAP_LOD_FULL_ABOVE = 0.6;

/**
 * LOD band for a VIEW scale:
 *   dot   — scale <  0.15 (dots only)
 *   mixed — 0.15 ≤ scale ≤ 0.60 (hulls + dots)
 *   full  — scale >  0.60 (+ labels)
 * Non-finite / non-positive scales degrade to 'dot'.
 */
export function lodForScale(scale: number): LodBand {
  if (!(scale >= MAP_LOD_DOT_BELOW)) return 'dot';
  if (!(scale > MAP_LOD_FULL_ABOVE)) return 'mixed';
  return 'full';
}
