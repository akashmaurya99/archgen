// map-quadtree.ts — point quadtree powering O(log n) hit-testing on the
// Canvas2D MAP layer (hover/click pick at 50k+ symbols).
//
// Uniform point quadtree: leaves hold up to CAPACITY points; overflowing a
// leaf below MAX_DEPTH subdivides into four quadrants and redistributes.
// Points that coincide exactly pile into the deepest leaf — never lost.
// `nearest` is a best-first descent pruned by point→rect distance; `query`
// prunes subtrees whose rect misses the query rect. Deterministic traversal
// order everywhere (fixed quadrant order, stable sort) so results are
// reproducible for identical input.

export interface QuadPoint {
  id: string;
  x: number;
  y: number;
}

export interface QuadRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Points per leaf before subdivision. */
const CAPACITY = 8;
/** Hard subdivision depth cap — bounds worst-case memory on coincident points. */
const MAX_DEPTH = 12;

interface QNode {
  rect: QuadRect;
  depth: number;
  /** leaf payload; null once subdivided */
  pts: QuadPoint[] | null;
  /** [NW, NE, SW, SE]; null while a leaf */
  kids: [QNode, QNode, QNode, QNode] | null;
}

function mkNode(rect: QuadRect, depth: number): QNode {
  return { rect, depth, pts: [], kids: null };
}

function containsPt(r: QuadRect, x: number, y: number): boolean {
  return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
}

function intersects(a: QuadRect, b: QuadRect): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/** Squared distance from (x,y) to the closest point of `r` (0 when inside). */
function distSqToRect(r: QuadRect, x: number, y: number): number {
  const dx = x < r.minX ? r.minX - x : x > r.maxX ? x - r.maxX : 0;
  const dy = y < r.minY ? r.minY - y : y > r.maxY ? y - r.maxY : 0;
  return dx * dx + dy * dy;
}

function childFor(node: QNode, p: QuadPoint): QNode {
  const kids = node.kids;
  if (!kids) throw new Error('quadtree invariant violated: childFor on leaf');
  const midX = (node.rect.minX + node.rect.maxX) / 2;
  const midY = (node.rect.minY + node.rect.maxY) / 2;
  const west = p.x < midX;
  const north = p.y < midY;
  if (west) return north ? kids[0]! : kids[2]!;
  return north ? kids[1]! : kids[3]!;
}

function subdivide(node: QNode): void {
  const { minX, minY, maxX, maxY } = node.rect;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const d = node.depth + 1;
  node.kids = [
    mkNode({ minX, minY, maxX: midX, maxY: midY }, d), // NW
    mkNode({ minX: midX, minY, maxX, maxY: midY }, d), // NE
    mkNode({ minX, minY: midY, maxX: midX, maxY }, d), // SW
    mkNode({ minX: midX, minY: midY, maxX, maxY }, d), // SE
  ];
  const pts = node.pts;
  node.pts = null;
  if (!pts) return;
  for (const p of pts) insert(node, p);
}

function insert(root: QNode, p: QuadPoint): void {
  let cur = root;
  for (;;) {
    if (cur.kids) {
      cur = childFor(cur, p);
      continue;
    }
    cur.pts!.push(p);
    if (cur.pts!.length > CAPACITY && cur.depth < MAX_DEPTH) subdivide(cur);
    return;
  }
}

function collect(node: QNode, rect: QuadRect, out: QuadPoint[]): void {
  if (!intersects(node.rect, rect)) return;
  if (node.kids) {
    collect(node.kids[0]!, rect, out);
    collect(node.kids[1]!, rect, out);
    collect(node.kids[2]!, rect, out);
    collect(node.kids[3]!, rect, out);
    return;
  }
  if (!node.pts) return;
  for (const p of node.pts) {
    if (containsPt(rect, p.x, p.y)) out.push(p);
  }
}

function nearestIn(root: QNode, x: number, y: number): QuadPoint | null {
  let best: QuadPoint | null = null;
  let bestD2 = Infinity;
  const stack: QNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (distSqToRect(node.rect, x, y) >= bestD2) continue;
    const kids = node.kids;
    if (kids) {
      // Push farthest-first so the nearest quadrant is descended first —
      // tightens bestD2 early and prunes siblings cheaply.
      const order = [kids[0]!, kids[1]!, kids[2]!, kids[3]!];
      order.sort((a, b) => distSqToRect(b.rect, x, y) - distSqToRect(a.rect, x, y));
      for (const k of order) stack.push(k);
    } else if (node.pts) {
      for (const p of node.pts) {
        const dx = p.x - x;
        const dy = p.y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = p;
        }
      }
    }
  }
  return best;
}

/**
 * Immutable-after-build point quadtree. Build once per layout via
 * `QuadTree.build(points)`, then query/nearest as often as the pointer moves.
 */
export class QuadTree {
  private constructor(
    private readonly root: QNode,
    private readonly n: number,
  ) {}

  /**
   * Build from points. The root rect tightly covers all points (padded so
   * zero-span inputs still subdivide); empty input yields an empty tree.
   * Does not mutate `points`.
   */
  static build(points: ReadonlyArray<QuadPoint>): QuadTree {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      minX = minY = maxX = maxY = 0;
    }
    // Pad by ~1e-6 of span (≥ tiny epsilon) so boundary-inclusive quadrant
    // math and zero-span inputs behave.
    const padX = Math.max((maxX - minX) * 1e-6, 1e-6);
    const padY = Math.max((maxY - minY) * 1e-6, 1e-6);
    const root = mkNode({ minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY }, 0);
    for (const p of points) insert(root, p);
    return new QuadTree(root, points.length);
  }

  /** Number of points in the tree. */
  get size(): number {
    return this.n;
  }

  /** All points with minX ≤ x ≤ maxX and minY ≤ y ≤ maxY (inclusive). */
  query(rect: QuadRect): QuadPoint[] {
    const out: QuadPoint[] = [];
    collect(this.root, rect, out);
    return out;
  }

  /** Closest point to (x,y), or null when the tree is empty. */
  nearest(x: number, y: number): QuadPoint | null {
    return nearestIn(this.root, x, y);
  }
}
