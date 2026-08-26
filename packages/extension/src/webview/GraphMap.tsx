// GraphMap.tsx — the whole-repo MAP layer: a Canvas2D constellation view that
// renders the ENTIRE codegraph (50k+ symbols) with pan/zoom/LOD and
// click-to-select, driving the existing DOM graph from OUTSIDE it.
//
// Self-contained by contract (integration into App happens later):
//   <GraphMap nodes edges? kindColorFor selectedId? onSelect themeKind? />
//
// Performance model:
//   - layout  : packByFile (map-layout.ts), O(n), once per `nodes` identity
//   - index   : QuadTree.build (map-quadtree.ts), once per layout
//   - painting: dirty-flag rAF — NO continuous loop. Redraws happen only on
//     interaction/state change. The ONE exception is the selection pulse,
//     which runs its own rAF loop ONLY while a node is selected, capped at
//     30fps. One full 50k-dot pass stays far under the documented op budget
//     (asserted in test/graph-map.test.tsx via a recording 2D-context mock).
//   - LOD     : lodForScale(view.scale) gates hulls / labels / dot size.
//
// Colors come from props (`kindColorFor`) and CSS custom properties read off
// the host element; literal per-theme fallbacks keep dark/light safe when the
// vars are unreadable (tests, non-VS Code hosts).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { lodForScale, packByFile, type MapBounds, type MapPackResult, type MapPoint } from './map-layout';
import { QuadTree, type QuadPoint } from './map-quadtree';

/* ==== Public API ==== */

export interface GraphMapNode {
  id: string;
  label: string;
  kind: string;
  file: string;
  line: number;
}

export interface GraphMapEdge {
  source: string;
  target: string;
  kind?: string;
}

export type GraphMapTheme = 'dark' | 'light' | 'highContrast' | (string & {});

export interface GraphMapView {
  scale: number;
  tx: number;
  ty: number;
}

export interface GraphMapProps {
  /** Full symbol set — up to ~50-60k. Identity change triggers repack. */
  nodes: ReadonlyArray<GraphMapNode>;
  /** Optional dependency edges; drawn only when ≤ MAP_EDGE_DRAW_LIMIT. */
  edges?: ReadonlyArray<GraphMapEdge>;
  /** kind → color string (CSS var() expressions allowed). */
  kindColorFor: (kind: string) => string;
  /** Externally-controlled selection (ring + label + pulse). */
  selectedId?: string | null;
  /** Click on a symbol → its id; click on empty space → null. */
  onSelect: (id: string | null) => void;
  /** Theme hint for fallback palette when CSS vars are unreadable. */
  themeKind?: GraphMapTheme;
}

/* ==== Constants ==== */

export const MAP_MIN_SCALE = 0.02;
export const MAP_MAX_SCALE = 4;
/** Edges above this count are skipped (HUD shows a 'dense' flag). */
export const MAP_EDGE_DRAW_LIMIT = 5000;
/** Screen-space pick radius for hover/click. */
export const MAP_HIT_RADIUS_PX = 8;
/** Symbol dot edge (px, screen space). */
const DOT_PX = 2.5;
/** Dot edge in the 'dot' LOD band (px). */
const DOT_PX_MIN = 2;
/** Selection pulse period (ms) and min frame interval (30fps cap). */
const PULSE_PERIOD_MS = 1600;
const PULSE_MIN_INTERVAL_MS = 1000 / 30;
/** Labels drawn for the top-N highest-degree symbols at 'full' zoom. */
const TOP_LABEL_COUNT = 12;
/** Drag distance (px) before a press counts as pan rather than click. */
const DRAG_EPS_PX = 4;
const TAU = Math.PI * 2;
const FONT_STACK = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/* ==== Pure view math (exported for tests + future integrators) ==== */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function screenToWorld(v: GraphMapView, mx: number, my: number): { x: number; y: number } {
  return { x: (mx - v.tx) / v.scale, y: (my - v.ty) / v.scale };
}

export function worldToScreen(v: GraphMapView, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * v.scale + v.tx, y: wy * v.scale + v.ty };
}

/** Fit `bounds` centered into a vw×vh viewport with a small margin. */
export function fitView(
  bounds: MapBounds,
  vw: number,
  vh: number,
  minScale = MAP_MIN_SCALE,
  maxScale = MAP_MAX_SCALE,
): GraphMapView {
  const w = Math.max(bounds.maxX - bounds.minX, 1);
  const h = Math.max(bounds.maxY - bounds.minY, 1);
  const scale = clamp(Math.min(vw / w, vh / h) * 0.92, minScale, maxScale);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return { scale, tx: vw / 2 - cx * scale, ty: vh / 2 - cy * scale };
}

/**
 * Nearest symbol to screen point (mx,my) within `radiusPx` screen pixels,
 * or null. Pure quadtree lookup — used by hover AND click paths.
 */
export function pickNearest(
  tree: QuadTree,
  view: GraphMapView,
  mx: number,
  my: number,
  radiusPx = MAP_HIT_RADIUS_PX,
): QuadPoint | null {
  const w = screenToWorld(view, mx, my);
  const p = tree.nearest(w.x, w.y);
  if (!p) return null;
  const rWorld = radiusPx / Math.max(view.scale, 1e-9);
  const dx = p.x - w.x;
  const dy = p.y - w.y;
  return dx * dx + dy * dy <= rWorld * rWorld ? p : null;
}

/* ==== Color resolution ==== */

interface MapPalette {
  bg: string;
  hullFill: string;
  hullStroke: string;
  edge: string;
  text: string;
  accent: string;
  dotFallback: string;
}

const DARK_PALETTE: MapPalette = {
  bg: '#0d1117',
  hullFill: 'rgba(177,182,197,0.05)',
  hullStroke: 'rgba(139,148,158,0.28)',
  edge: 'rgba(139,148,158,0.35)',
  text: '#e6edf3',
  accent: '#1f6feb',
  dotFallback: '#8b949e',
};

const LIGHT_PALETTE: MapPalette = {
  bg: '#ffffff',
  hullFill: 'rgba(110,119,129,0.06)',
  hullStroke: 'rgba(110,119,129,0.30)',
  edge: 'rgba(110,119,129,0.35)',
  text: '#1f2328',
  accent: '#0969da',
  dotFallback: '#57606a',
};

function readVar(probe: CSSStyleDeclaration | null, name: string, fallback: string): string {
  const v = probe?.getPropertyValue(name).trim();
  return v ? v : fallback;
}

/** Resolve `var(--name, fallback)` against computed style; literals pass through. */
function resolveColor(raw: string, probe: CSSStyleDeclaration | null, fallback: string): string {
  const s = raw.trim();
  if (!s.startsWith('var(')) return s;
  const m = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^()]+?)\s*)?\)$/.exec(s);
  if (!m) return s;
  const v = probe?.getPropertyValue(m[1]!).trim();
  if (v) return v;
  return (m[2] ?? fallback).trim();
}

interface PaletteCache {
  theme: string;
  palette: MapPalette;
  kinds: Map<string, string>;
}

/* ==== rAF helpers (jsdom-safe without pretendToBeVisual) ==== */

function nextFrame(cb: (t: number) => void): number {
  if (typeof window.requestAnimationFrame === 'function') return window.requestAnimationFrame(cb);
  return window.setTimeout(() => cb(performance.now()), 16);
}

function cancelFrame(handle: number): void {
  if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(handle);
  else window.clearTimeout(handle);
}

/* ==== Component ==== */

export function GraphMap(props: GraphMapProps): React.ReactElement {
  const { nodes, edges, kindColorFor, selectedId = null, onSelect, themeKind = 'dark' } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  // Latest-closure draw fn — scheduled frames always invoke the freshest one.
  const drawRef = useRef<() => void>(() => {});
  const rafRef = useRef<number | null>(null);
  const pulseRafRef = useRef<number | null>(null);
  const fittedRef = useRef(false);
  const viewRef = useRef<GraphMapView>({ scale: 1, tx: 0, ty: 0 });
  const paletteRef = useRef<PaletteCache | null>(null);

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [hudScale, setHudScale] = useState<number | null>(null);

  /* ---- derived data (once per input identity) ---- */

  const layout: MapPackResult = useMemo(() => packByFile(nodes), [nodes]);

  const tree = useMemo(() => {
    const points: QuadPoint[] = [];
    for (const [id, p] of layout.positions) points.push({ id, x: p.x, y: p.y });
    return QuadTree.build(points);
  }, [layout]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  /** Dots bucketed by kind so each draw pass sets fillStyle once per kind. */
  const kindBuckets = useMemo(() => {
    const map = new Map<string, Array<{ x: number; y: number }>>();
    for (const n of nodes) {
      const p = layout.positions.get(n.id);
      if (!p) continue;
      let arr = map.get(n.kind);
      if (!arr) {
        arr = [];
        map.set(n.kind, arr);
      }
      arr.push(p);
    }
    return map;
  }, [nodes, layout]);

  const edgeInfo = useMemo(() => {
    const list = edges ?? [];
    const dense = list.length > MAP_EDGE_DRAW_LIMIT;
    const pairs: Array<[MapPoint, MapPoint]> = [];
    const degree = new Map<string, number>();
    if (list.length > 0 && !dense) {
      for (const e of list) {
        const s = layout.positions.get(e.source);
        const t = layout.positions.get(e.target);
        if (s && t) pairs.push([s, t]);
        degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
        degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
      }
    }
    const top =
      degree.size > 0
        ? [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_LABEL_COUNT).map(([id]) => id)
        : [];
    return { pairs, top: new Set(top), dense };
  }, [edges, layout]);

  /* ---- palette ---- */

  const ensurePalette = useCallback((): MapPalette => {
    const cached = paletteRef.current;
    if (cached && cached.theme === themeKind) return cached.palette;
    const host = hostRef.current;
    let probe: CSSStyleDeclaration | null = null;
    try {
      probe = host ? window.getComputedStyle(host) : null;
    } catch {
      probe = null;
    }
    const base = themeKind === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
    const palette: MapPalette = {
      bg: readVar(probe, '--archgen-canvas', base.bg),
      hullFill: base.hullFill,
      hullStroke: readVar(probe, '--archgen-hairline', base.hullStroke),
      edge: base.edge,
      text: readVar(probe, '--archgen-text', base.text),
      accent: readVar(probe, '--archgen-action-blue', base.accent),
      dotFallback: base.dotFallback,
    };
    paletteRef.current = { theme: themeKind, palette, kinds: new Map() };
    return palette;
  }, [themeKind]);

  const kindColor = useCallback(
    (kind: string): string => {
      const cached = paletteRef.current?.kinds.get(kind);
      if (cached) return cached;
      const host = hostRef.current;
      let probe: CSSStyleDeclaration | null = null;
      try {
        probe = host ? window.getComputedStyle(host) : null;
      } catch {
        probe = null;
      }
      const resolved = resolveColor(kindColorFor(kind), probe, ensurePalette().dotFallback);
      paletteRef.current?.kinds.set(kind, resolved);
      return resolved;
    },
    [kindColorFor, ensurePalette],
  );

  /* ---- scheduling ---- */

  const scheduleDraw = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = nextFrame(() => {
      rafRef.current = null;
      drawRef.current();
    });
  }, []);

  /* ---- drawing ---- */

  const draw = () => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cw = Math.max(host.clientWidth, 1);
    const ch = Math.max(host.clientHeight, 1);
    const dpr =
      typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const bw = Math.round(cw * dpr);
    const bh = Math.round(ch * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;

    // First-fit once the host has real dimensions (fallback path here covers
    // hosts that report size only after this effect ran).
    if (!fittedRef.current && cw > 1 && ch > 1) {
      fittedRef.current = true;
      viewRef.current = fitView(layout.bounds, cw, ch);
      setHudScale(viewRef.current.scale);
    }
    const view = viewRef.current;
    const pal = ensurePalette();
    const band = lodForScale(view.scale);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, cw, ch);

    // World-space viewport for culling.
    const tl = screenToWorld(view, 0, 0);
    const br = screenToWorld(view, cw, ch);
    const vpMinX = tl.x;
    const vpMinY = tl.y;
    const vpMaxX = br.x;
    const vpMaxY = br.y;

    // Cluster hulls — hidden entirely in the 'dot' band.
    if (band !== 'dot') {
      ctx.fillStyle = pal.hullFill;
      ctx.strokeStyle = pal.hullStroke;
      ctx.lineWidth = 1;
      for (const c of layout.clusters) {
        const sx = c.x * view.scale + view.tx;
        const sy = c.y * view.scale + view.ty;
        const sw = c.w * view.scale;
        const sh = c.h * view.scale;
        if (sx > cw || sy > ch || sx + sw < 0 || sy + sh < 0) continue;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(sx, sy, sw, sh, 6);
        else ctx.rect(sx, sy, sw, sh);
        ctx.fill();
        ctx.stroke();
      }
    }

    // Edges — one batched path, viewport-culled per segment.
    if (edgeInfo.pairs.length > 0) {
      ctx.strokeStyle = pal.edge;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const m = 4;
      for (const [s, t] of edgeInfo.pairs) {
        const ax = s.x * view.scale + view.tx;
        const ay = s.y * view.scale + view.ty;
        const bx = t.x * view.scale + view.tx;
        const by = t.y * view.scale + view.ty;
        if ((ax < m && bx < m) || (ax > cw + m && bx > cw + m) || (ay < m && by < m) || (ay > ch + m && by > ch + m))
          continue;
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      ctx.stroke();
    }

    // Symbol dots — fillStyle set once per kind bucket, culled per dot.
    const dotPx = band === 'dot' ? DOT_PX_MIN : DOT_PX;
    const half = dotPx / 2;
    for (const [kind, arr] of kindBuckets) {
      ctx.fillStyle = kindColor(kind);
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i]!;
        const sx = p.x * view.scale + view.tx;
        if (sx < -half || sx > cw + half) continue;
        const sy = p.y * view.scale + view.ty;
        if (sy < -half || sy > ch + half) continue;
        ctx.fillRect(sx - half, sy - half, dotPx, dotPx);
      }
    }

    // Labels — hovered + selected always; top-degree only past 'full' zoom.
    const wantTop = band === 'full';
    if (hoveredId || selectedId || wantTop) {
      ctx.font = `11px ${FONT_STACK}`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = pal.text;
      const labelAt = (id: string) => {
        const n = byId.get(id);
        const p = layout.positions.get(id);
        if (!n || !p) return;
        const sx = p.x * view.scale + view.tx;
        const sy = p.y * view.scale + view.ty;
        if (sx < -80 || sx > cw + 240 || sy < -20 || sy > ch + 20) return;
        ctx.fillText(n.label, sx + 6, sy - 6);
      };
      if (wantTop) for (const id of edgeInfo.top) labelAt(id);
      if (selectedId) labelAt(selectedId);
      if (hoveredId && hoveredId !== selectedId) labelAt(hoveredId);
    }

    // Hover outline.
    if (hoveredId) {
      const p = layout.positions.get(hoveredId);
      if (p) {
        const sx = p.x * view.scale + view.tx;
        const sy = p.y * view.scale + view.ty;
        if (sx >= -8 && sx <= cw + 8 && sy >= -8 && sy <= ch + 8) {
          ctx.strokeStyle = pal.accent;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(sx, sy, 5, 0, TAU);
          ctx.stroke();
        }
      }
    }

    // Selected pulse ring — drawn here so the pulse's own rAF loop can reuse
    // the full dirty redraw (simplest correct compositing at 30fps).
    if (selectedId) {
      const p = layout.positions.get(selectedId);
      if (p) {
        const sx = p.x * view.scale + view.tx;
        const sy = p.y * view.scale + view.ty;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const phase = (now % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
        ctx.globalAlpha = 1 - phase;
        ctx.strokeStyle = pal.accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx, sy, 5 + 11 * phase, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  };
  drawRef.current = draw;

  /* ---- effects ---- */

  // Redraw whenever anything visual changes (dirty-flag; no continuous loop).
  useEffect(() => {
    scheduleDraw();
  }, [scheduleDraw, layout, tree, kindBuckets, edgeInfo, selectedId, hoveredId, themeKind]);

  // Fit as soon as the host reports real size — and REFIT whenever `layout`
  // identity changes (model swap: new `nodes` → new pack → new bounds).
  // Without the re-fit, `fittedRef` stayed true forever after the first fit
  // and a swapped model inherited the stale viewport (new constellation
  // off-screen). Same-identity re-renders never re-run this effect, and
  // resizes go through the observer below, so user pan/zoom survives both.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const cw = host.clientWidth;
    const ch = host.clientHeight;
    if (cw > 0 && ch > 0) {
      fittedRef.current = true;
      viewRef.current = fitView(layout.bounds, cw, ch);
      setHudScale(viewRef.current.scale);
      scheduleDraw();
    } else {
      // Host not laid out yet — re-arm the draw-path fallback (it fits the
      // first frame that reports real dimensions).
      fittedRef.current = false;
    }
  }, [layout, scheduleDraw]);

  // Resize → resize canvas backing store + redraw (fit is NOT re-run, so user
  // pan/zoom survives resizes).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (typeof window.ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => scheduleDraw());
      ro.observe(host);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', scheduleDraw);
    return () => window.removeEventListener('resize', scheduleDraw);
  }, [scheduleDraw]);

  // devicePixelRatio change (window moved across monitors, browser zoom) →
  // redraw so the backing store is re-sized at the new dpr. matchMedia is the
  // only notification channel: arm `(resolution: <current>dppx)` and RE-ARM
  // around the new dpr on every change, so any crossing fires — a fixed
  // `(resolution: 2dppx)` query would only catch the 1x↔2x boundary. Guarded:
  // jsdom and exotic hosts lack matchMedia entirely.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    let disposed = false;
    let mql: MediaQueryList | null = null;
    const onChange = () => {
      scheduleDraw();
      arm();
    };
    const arm = () => {
      if (disposed) return;
      if (mql) {
        if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onChange);
        else mql.removeListener(onChange);
      }
      const dpr =
        typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
      try {
        mql = window.matchMedia(`(resolution: ${dpr}dppx)`);
      } catch {
        mql = null;
        return;
      }
      if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange);
      else mql.addListener(onChange);
    };
    arm();
    return () => {
      disposed = true;
      if (!mql) return;
      if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onChange);
      else mql.removeListener(onChange);
    };
  }, [scheduleDraw]);

  // Wheel zoom around cursor — native listener so preventDefault works
  // (React attaches wheel passively).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const cur = viewRef.current;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = clamp(cur.scale * factor, MAP_MIN_SCALE, MAP_MAX_SCALE);
      if (next === cur.scale) return;
      const w = screenToWorld(cur, mx, my);
      viewRef.current = { scale: next, tx: mx - w.x * next, ty: my - w.y * next };
      setHudScale(next);
      scheduleDraw();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [scheduleDraw]);

  // Selection pulse — the ONLY continuous loop, and only while something is
  // selected; hard-capped at 30fps; fully cancelled on cleanup. Pauses
  // entirely (ZERO rAF churn) while the document is hidden or the host has no
  // size, and resumes via visibilitychange / resize. The host — not the
  // canvas — is the size probe: the canvas fills the host and its backing
  // store is derived from host dimensions in draw().
  useEffect(() => {
    if (!selectedId) return;
    let alive = true;
    let last = 0;
    const canPulse = (): boolean => {
      const host = hostRef.current;
      return !document.hidden && !!host && host.clientWidth > 0 && host.clientHeight > 0;
    };
    const tick = (now: number) => {
      if (!alive) return;
      if (!canPulse()) {
        // Parked — resume() re-arms the loop once the tab/host is live again.
        pulseRafRef.current = null;
        return;
      }
      if (now - last >= PULSE_MIN_INTERVAL_MS) {
        last = now;
        drawRef.current();
      }
      pulseRafRef.current = nextFrame(tick);
    };
    const resume = () => {
      if (!alive || pulseRafRef.current !== null || !canPulse()) return;
      pulseRafRef.current = nextFrame(tick);
    };
    const onVisibility = () => {
      if (!document.hidden) resume();
    };
    pulseRafRef.current = nextFrame(tick);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', resume);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', resume);
      if (pulseRafRef.current !== null) cancelFrame(pulseRafRef.current);
      pulseRafRef.current = null;
    };
  }, [selectedId]);

  // Unmount: kill any pending dirty-frame.
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelFrame(rafRef.current);
      rafRef.current = null;
    },
    [],
  );

  /* ---- pointer interactions ---- */

  const dragRef = useRef<{ downX: number; downY: number; lastX: number; lastY: number; moved: boolean } | null>(null);

  const localXY = (e: { clientX: number; clientY: number }): { mx: number; my: number } => {
    const canvas = canvasRef.current;
    const rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
    return { mx: e.clientX - rect.left, my: e.clientY - rect.top };
  };

  const showTooltip = (mx: number, my: number, n: GraphMapNode) => {
    const el = tipRef.current;
    if (!el) return;
    el.textContent = '';
    const main = document.createElement('span');
    main.textContent = n.label;
    const sub = document.createElement('span');
    sub.className = 'archgen-map-tooltip-sub';
    sub.textContent = ` ${n.file}:${n.line}`;
    el.append(main, sub);
    el.style.left = `${mx + 12}px`;
    el.style.top = `${my + 12}px`;
    el.classList.add('is-visible');
  };

  const hideTooltip = () => {
    tipRef.current?.classList.remove('is-visible');
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { mx, my } = localXY(e);
    dragRef.current = { downX: mx, downY: my, lastX: mx, lastY: my, moved: false };
    setIsPanning(true);
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // jsdom / older hosts lack pointer capture — drag still works while
      // the pointer stays over the canvas.
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { mx, my } = localXY(e);
    const drag = dragRef.current;
    if (drag) {
      const dx = mx - drag.lastX;
      const dy = my - drag.lastY;
      if (Math.abs(mx - drag.downX) > DRAG_EPS_PX || Math.abs(my - drag.downY) > DRAG_EPS_PX) drag.moved = true;
      drag.lastX = mx;
      drag.lastY = my;
      if (drag.moved) {
        const cur = viewRef.current;
        viewRef.current = { ...cur, tx: cur.tx + dx, ty: cur.ty + dy };
        hideTooltip();
        scheduleDraw();
      }
      return;
    }
    const hit = pickNearest(tree, viewRef.current, mx, my);
    const id = hit ? hit.id : null;
    if (id !== hoveredId) setHoveredId(id);
    if (id) {
      const n = byId.get(id);
      if (n) showTooltip(mx, my, n);
    } else {
      hideTooltip();
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setIsPanning(false);
    if (drag && !drag.moved) {
      const { mx, my } = localXY(e);
      const hit = pickNearest(tree, viewRef.current, mx, my);
      onSelect(hit ? hit.id : null);
    }
  };

  const onPointerLeave = () => {
    dragRef.current = null;
    setIsPanning(false);
    if (hoveredId) setHoveredId(null);
    hideTooltip();
  };

  // System gesture interruption (browser zoom, OS modal, touch stolen by
  // scroll) — pointerup never arrives, so reset exactly like pointer-leave
  // or the board stays stuck in pan mode.
  const onPointerCancel = () => {
    dragRef.current = null;
    setIsPanning(false);
    if (hoveredId) setHoveredId(null);
    hideTooltip();
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { mx, my } = localXY(e);
    const cur = viewRef.current;
    const next = clamp(cur.scale * 2, MAP_MIN_SCALE, MAP_MAX_SCALE);
    if (next !== cur.scale) {
      const w = screenToWorld(cur, mx, my);
      viewRef.current = { scale: next, tx: mx - w.x * next, ty: my - w.y * next };
      setHudScale(next);
    }
    scheduleDraw();
  };

  /* ---- render ---- */

  const hudText = `${hudScale === null ? '—' : `${Math.round(hudScale * 100)}%`} · ${nodes.length} symbols · ${layout.clusters.length} files`;

  return (
    <div ref={hostRef} className={`archgen-map${isPanning ? ' is-panning' : ''}${hoveredId ? ' has-hover' : ''}`}>
      <canvas
        ref={canvasRef}
        className="archgen-map-canvas"
        role="img"
        aria-label={`Repository map: ${nodes.length} symbols in ${layout.clusters.length} files`}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onPointerCancel={onPointerCancel}
        onDoubleClick={onDoubleClick}
      />
      <div ref={tipRef} className="archgen-map-tooltip" />
      <div className="archgen-map-hud" aria-hidden="true">
        <span>{hudText}</span>
        {edgeInfo.dense ? <span className="archgen-map-dense">· edges hidden (dense)</span> : null}
      </div>
    </div>
  );
}
