// graph-map.test.tsx — the Canvas2D MAP layer under jsdom.
//
// jsdom has NO canvas implementation, so this file installs its OWN local
// mocks (deliberately NOT touching helpers/dom-stubs.ts, which serves xyflow):
//   1. HTMLCanvasElement.getContext → a recording 2D-context mock that counts
//      every op — draw budgets are asserted as OP-COUNT budgets instead of
//      real paint.
//   2. HTMLElement.clientWidth/Height → plausible positives for .archgen-map
//      hosts (jsdom has no layout engine), so fit/resize math runs for real.
// Covered: mount + 50k render with op budget (<500k ops), quadtree click
// hit-test → onSelect(id) / empty → onSelect(null), LOD band switching label
// rendering, hover tooltip, wheel zoom clamping, dense-edge skip flag, and
// the 30fps-capped selection pulse.
// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { createElement } from 'react';
import {
  GraphMap,
  fitView,
  pickNearest,
  screenToWorld,
  worldToScreen,
  type GraphMapEdge,
  type GraphMapNode,
  type GraphMapView,
} from '../src/webview/GraphMap';
import { packByFile } from '../src/webview/map-layout';
import { QuadTree } from '../src/webview/map-quadtree';
import { colorForKind } from '../src/webview/graph-model';

/* ==== local recording canvas-mock (file-local; dom-stubs.ts untouched) ==== */

interface OpCall {
  op: string;
  value?: unknown;
}

const recorder = {
  calls: [] as OpCall[],
  total(): number {
    return this.calls.length;
  },
  count(op: string): number {
    return this.calls.reduce((n, c) => (c.op === op ? n + 1 : n), 0);
  },
  values(op: string): unknown[] {
    return this.calls.filter((c) => c.op === op).map((c) => c.value);
  },
  reset(): void {
    this.calls.length = 0;
  },
};

/** Test toggles for exotic-host degradation paths (read by the ctx mock). */
const ctxControl = { nullCtx: false, noRoundRect: false };

const CTX_METHODS = [
  'setTransform',
  'clearRect',
  'fillRect',
  'strokeRect',
  'beginPath',
  'closePath',
  'moveTo',
  'lineTo',
  'arc',
  'ellipse',
  'rect',
  'fill',
  'stroke',
  'fillText',
  'strokeText',
  'save',
  'restore',
] as const;

const CTX_PROPS = ['fillStyle', 'strokeStyle', 'globalAlpha', 'font', 'lineWidth', 'textBaseline'] as const;

function installMapDomMocks(): void {
  // jsdom has no PointerEvent, so @testing-library's fireEvent falls back to
  // base Event — which DROPS clientX/clientY. Polyfill a minimal subclass of
  // MouseEvent so pointer coordinates survive into React's handlers.
  const w = window as unknown as Record<string, unknown>;
  if (typeof w['PointerEvent'] !== 'function') {
    class FakePointerEvent extends MouseEvent {
      readonly pointerId: number;
      readonly pointerType: string;
      constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
        this.pointerType = init.pointerType ?? 'mouse';
      }
    }
    w['PointerEvent'] = FakePointerEvent;
  }

  const canvasProto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  if (!canvasProto['__archgenMapCtxMocked']) {
    canvasProto['__archgenMapCtxMocked'] = true;
    const ctx: Record<string, unknown> = {};
    for (const m of CTX_METHODS) {
      ctx[m] = (...args: unknown[]) => {
        recorder.calls.push({ op: m });
        void args;
      };
    }
    Object.defineProperty(ctx, 'roundRect', {
      configurable: true,
      enumerable: true,
      get() {
        if (ctxControl.noRoundRect) return undefined;
        return (...args: unknown[]) => {
          recorder.calls.push({ op: 'roundRect' });
          void args;
        };
      },
    });
    for (const p of CTX_PROPS) {
      Object.defineProperty(ctx, p, {
        configurable: true,
        get: () => null,
        set: (v: unknown) => {
          recorder.calls.push({ op: `${p}:set`, value: v });
        },
      });
    }
    canvasProto['getContext'] = function (): CanvasRenderingContext2D | null {
      recorder.calls.push({ op: 'getContext' });
      if (ctxControl.nullCtx) return null;
      return ctx as unknown as CanvasRenderingContext2D;
    };
  }

  const htmlProto = HTMLElement.prototype as unknown as Record<string, unknown>;
  if (!htmlProto['__archgenMapClientPatched']) {
    htmlProto['__archgenMapClientPatched'] = true;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('archgen-map') ? 800 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('archgen-map') ? 600 : 0;
      },
    });
  }
}

installMapDomMocks();

/* ==== synthetic corpora ==== */

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const KINDS = ['class', 'interface', 'function', 'method', 'module', 'variable'] as const;

function synthNodes(count: number, files: number, seed: number): GraphMapNode[] {
  const rnd = lcg(seed);
  const out: GraphMapNode[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: `n${i}`,
      label: `Sym${i}`,
      kind: KINDS[Math.floor(rnd() * KINDS.length)]!,
      file: `src/pkg${Math.floor(rnd() * files)}/mod${Math.floor(rnd() * 40)}.ts`,
      line: Math.floor(rnd() * 400) + 1,
    });
  }
  return out;
}

function chainEdges(nodes: GraphMapNode[]): GraphMapEdge[] {
  const out: GraphMapEdge[] = [];
  for (let i = 0; i + 1 < nodes.length; i++) out.push({ source: nodes[i]!.id, target: nodes[i + 1]!.id });
  return out;
}

async function flushFrames(ms = 60): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

/* ==== component under test ==== */

function mapEl(container: HTMLElement): HTMLCanvasElement {
  const cv = container.querySelector('canvas');
  expect(cv).toBeTruthy();
  return cv as HTMLCanvasElement;
}

beforeEach(() => {
  cleanup();
  recorder.reset();
});

afterEach(() => {
  cleanup();
});

describe('GraphMap', () => {
  it('mounts and renders 50k fake nodes within the documented op budget', async () => {
    const nodes = synthNodes(50_000, 1500, 7);
    const selections: Array<string | null> = [];
    const { container } = render(
      createElement(GraphMap, {
        nodes,
        kindColorFor: colorForKind,
        onSelect: (id) => selections.push(id),
        themeKind: 'dark',
      }),
    );
    await flushFrames(120);

    const total = recorder.total();
    const dots = recorder.count('fillRect');
    process.stdout.write(`[graph-map] 50k-node draw ops = ${total} (dots fillRect=${dots})\n`);

    expect(mapEl(container)).toBeTruthy();
    expect(dots).toBeGreaterThanOrEqual(nodes.length); // every symbol painted ≥1 op
    expect(total).toBeLessThan(500_000); // documented op-count budget « naive per-op paints

    expect(() => container.querySelector('.archgen-map-hud')).toBeTruthy();
    cleanup();
    await flushFrames(30); // unmount must not throw from pending frames
  });

  it('click hit-test selects the correct id via the quadtree; empty space → null', async () => {
    const nodes = synthNodes(120, 40, 3);
    const edges = chainEdges(nodes);
    const onSelect = vi.fn();
    const { container } = render(
      createElement(GraphMap, { nodes, edges, kindColorFor: colorForKind, onSelect, themeKind: 'dark' }),
    );
    await flushFrames();

    // The component fits with the same pure math on the same 800×600 host.
    const view = fitView(packByFile(nodes).bounds, 800, 600);
    const canvas = mapEl(container);

    const target = nodes[17]!;
    const pos = packByFile(nodes).positions.get(target.id)!;
    const s = worldToScreen(view, pos.x, pos.y);
    fireEvent.pointerDown(canvas, { clientX: s.x, clientY: s.y });
    fireEvent.pointerUp(canvas, { clientX: s.x, clientY: s.y });
    expect(onSelect).toHaveBeenCalledWith(target.id);

    // Bottom-right corner sits outside the fitted content margin → no hit.
    fireEvent.pointerDown(canvas, { clientX: 797, clientY: 597 });
    fireEvent.pointerUp(canvas, { clientX: 797, clientY: 597 });
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('a drag does not select', async () => {
    const nodes = synthNodes(40, 20, 9);
    const onSelect = vi.fn();
    const { container } = render(
      createElement(GraphMap, { nodes, kindColorFor: colorForKind, onSelect, themeKind: 'dark' }),
    );
    await flushFrames();
    const canvas = mapEl(container);
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas, { clientX: 200, clientY: 180 });
    fireEvent.pointerUp(canvas, { clientX: 200, clientY: 180 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('LOD bands switch label rendering: dot band paints zero labels, full band paints top-degree labels', async () => {
    const nodes = synthNodes(40, 20, 5);
    const edges = chainEdges(nodes);
    const { container } = render(
      createElement(GraphMap, { nodes, edges, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    const canvas = mapEl(container);

    // Zoom fully OUT → scale clamps to MAP_MIN_SCALE (0.02) → 'dot' band:
    // no labels AND no cluster hulls.
    recorder.reset();
    fireEvent.wheel(canvas, { deltaY: 3000, clientX: 400, clientY: 300 });
    await flushFrames(40);
    expect(recorder.count('fillText')).toBe(0);
    expect(recorder.count('roundRect')).toBe(0);

    recorder.reset();
    // Zoom fully IN → scale clamps to MAP_MAX_SCALE (4) → 'full' band:
    // top-degree labels appear.
    fireEvent.wheel(canvas, { deltaY: -3000, clientX: 400, clientY: 300 });
    await flushFrames(40);
    expect(recorder.count('fillText')).toBeGreaterThan(0);
  });

  it('hover shows the tooltip near the cursor and hides on leave', async () => {
    const nodes = synthNodes(60, 30, 13);
    const layout = packByFile(nodes);
    const { container } = render(
      createElement(GraphMap, { nodes, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    const canvas = mapEl(container);
    const view = fitView(layout.bounds, 800, 600);
    const target = nodes[5]!;
    const p = layout.positions.get(target.id)!;
    const s = worldToScreen(view, p.x, p.y);

    fireEvent.pointerMove(canvas, { clientX: s.x, clientY: s.y });
    const tip = container.querySelector('.archgen-map-tooltip');
    expect(tip).toBeTruthy();
    expect(tip!.classList.contains('is-visible')).toBe(true);
    expect(tip!.textContent).toContain(target.label);
    expect(tip!.textContent).toContain(target.file);

    fireEvent.pointerLeave(canvas);
    expect(tip!.classList.contains('is-visible')).toBe(false);
  });

  it('wheel zoom clamps to [2%, 400%] in the HUD', async () => {
    const nodes = synthNodes(40, 20, 17);
    const { container } = render(
      createElement(GraphMap, { nodes, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    const canvas = mapEl(container);
    const hud = () => container.querySelector('.archgen-map-hud')!.textContent ?? '';

    fireEvent.wheel(canvas, { deltaY: -1e9, clientX: 400, clientY: 300 });
    expect(hud()).toContain('400%');

    fireEvent.wheel(canvas, { deltaY: 2e9, clientX: 400, clientY: 300 });
    expect(hud()).toContain('2%');
  });

  it('model swap (new nodes identity) refits the viewport; same-identity rerender keeps user zoom (todo 13)', async () => {
    // Two corpora whose fitted scales differ visibly on the 800×600 test host.
    const nodesA = synthNodes(2000, 100, 29);
    const nodesB: GraphMapNode[] = [];
    for (let f = 0; f < 3; f++) {
      for (let i = 0; i < 300; i++) {
        nodesB.push({ id: `b${f}-${i}`, label: `B${f}:${i}`, kind: 'function', file: `big/f${f}.ts`, line: i + 1 });
      }
    }
    const fitA = fitView(packByFile(nodesA).bounds, 800, 600);
    const fitB = fitView(packByFile(nodesB).bounds, 800, 600);
    const pct = (v: GraphMapView) => `${Math.round(v.scale * 100)}%`;
    expect(fitA.scale).not.toBeCloseTo(fitB.scale, 1); // sanity: distinct fits

    const { container, rerender } = render(
      createElement(GraphMap, { nodes: nodesA, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    const canvas = mapEl(container);
    const hud = () => container.querySelector('.archgen-map-hud')!.textContent ?? '';
    expect(hud()).toContain(pct(fitA));

    // User zooms fully in — viewport leaves the fitted state.
    fireEvent.wheel(canvas, { deltaY: -1e9, clientX: 400, clientY: 300 });
    expect(hud()).toContain('400%');

    // Model swap → new layout identity → refit onto the NEW bounds (the
    // pre-fix bug kept the stale 400% viewport and the new constellation
    // rendered off-screen).
    rerender(
      createElement(GraphMap, { nodes: nodesB, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    expect(hud()).toContain(pct(fitB));

    // Same-identity rerender must NOT refit — user pan/zoom survives.
    fireEvent.wheel(canvas, { deltaY: -1e9, clientX: 400, clientY: 300 });
    expect(hud()).toContain('400%');
    rerender(
      createElement(GraphMap, { nodes: nodesB, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    expect(hud()).toContain('400%');
  });

  it('double-click zooms into the point', async () => {
    const nodes = synthNodes(40, 20, 19);
    const { container } = render(
      createElement(GraphMap, { nodes, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    const canvas = mapEl(container);
    const hud = () => container.querySelector('.archgen-map-hud')!.textContent ?? '';
    const before = hud();
    fireEvent.doubleClick(canvas, { clientX: 400, clientY: 300 });
    await flushFrames(40);
    expect(hud()).not.toBe(before);
    expect(hud()).toContain('%');
  });

  it('skips edges above the dense limit (HUD flag, zero line ops) and draws them below it', async () => {
    const nodes = synthNodes(60, 20, 11);
    const dense: GraphMapEdge[] = Array.from({ length: 5001 }, (_, i) => ({
      source: nodes[i % nodes.length]!.id,
      target: nodes[(i * 7) % nodes.length]!.id,
    }));
    const { container } = render(
      createElement(GraphMap, { nodes, edges: dense, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    expect(container.querySelector('.archgen-map-hud')!.textContent).toContain('edges hidden');
    expect(recorder.count('lineTo')).toBe(0);

    cleanup();
    recorder.reset();
    const { container: c2 } = render(
      createElement(GraphMap, {
        nodes,
        edges: dense.slice(0, 100),
        kindColorFor: colorForKind,
        onSelect: () => {},
        themeKind: 'dark',
      }),
    );
    await flushFrames();
    expect(c2.querySelector('.archgen-map-hud')!.textContent).not.toContain('edges hidden');
    expect(recorder.count('lineTo')).toBeGreaterThan(0);
  });

  it('selection pulse redraws while selected, capped at ~30fps, and stops after unmount', async () => {
    const nodes = synthNodes(30, 15, 23);
    const { container, unmount } = render(
      createElement(GraphMap, {
        nodes,
        kindColorFor: colorForKind,
        selectedId: 'n1',
        onSelect: () => {},
        themeKind: 'dark',
      }),
    );
    await flushFrames(80);
    const base = recorder.count('arc');

    await new Promise<void>((r) => setTimeout(r, 350));
    const afterFirstWindow = recorder.count('arc');
    expect(afterFirstWindow).toBeGreaterThan(base); // pulse rings drew

    await new Promise<void>((r) => setTimeout(r, 400));
    const delta = recorder.count('arc') - afterFirstWindow;
    process.stdout.write(`[graph-map] pulse arcs in 400ms window = ${delta}\n`);
    expect(delta).toBeLessThanOrEqual(26); // 30fps cap ⇒ ≪ uncapped 60fps (~24 max)

    unmount();
    await new Promise<void>((r) => setTimeout(r, 80)); // cancelled loop must not throw
  });
});

function smallNodes(count = 24, files = 8, seed = 41): GraphMapNode[] {
  return synthNodes(count, files, seed);
}

function setDocumentHidden(hidden: boolean): () => void {
  const prev = Object.getOwnPropertyDescriptor(document, 'hidden');
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  return () => {
    if (prev) Object.defineProperty(document, 'hidden', prev);
    else delete (document as unknown as Record<string, unknown>)['hidden'];
  };
}

interface FakeMql {
  media: string;
  listeners: Array<() => void>;
  addListener(cb: () => void): void;
  removeListener(cb: () => void): void;
  addEventListener?: (type: string, cb: () => void) => void;
  removeEventListener?: (type: string, cb: () => void) => void;
}

function installMatchMediaFake(opts: { legacy?: boolean; throwing?: boolean } = {}): {
  queries: string[];
  mqls: FakeMql[];
  restore: () => void;
} {
  const queries: string[] = [];
  const mqls: FakeMql[] = [];
  const prev = window.matchMedia;
  window.matchMedia = ((query: string): FakeMql => {
    queries.push(query);
    if (opts.throwing) throw new Error('matchMedia unavailable');
    const mql: FakeMql = {
      media: query,
      listeners: [],
      addListener(cb) {
        this.listeners.push(cb);
      },
      removeListener(cb) {
        this.listeners = this.listeners.filter((l) => l !== cb);
      },
    };
    // Legacy MQLs (old Safari) lack the EventTarget methods entirely; the
    // component must feature-detect and fall back to addListener/removeListener.
    if (opts.legacy !== true) {
      mql.addEventListener = function (this: FakeMql, _t: string, cb: () => void) {
        this.listeners.push(cb);
      };
      mql.removeEventListener = function (this: FakeMql, _t: string, cb: () => void) {
        this.listeners = this.listeners.filter((l) => l !== cb);
      };
    }
    mqls.push(mql);
    return mql;
  }) as unknown as typeof window.matchMedia;
  return {
    queries,
    mqls,
    restore: () => {
      if (prev) window.matchMedia = prev;
      else delete (window as unknown as Record<string, unknown>)['matchMedia'];
    },
  };
}

function setDpr(value: unknown): () => void {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value });
  return () => Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
}

describe('pickNearest (pure)', () => {
  it('returns null on an empty quadtree and on misses outside the hit radius', () => {
    const empty = QuadTree.build([]);
    expect(pickNearest(empty, { scale: 1, tx: 0, ty: 0 }, 10, 10)).toBeNull();

    const tree = QuadTree.build([{ id: 'a', x: 0, y: 0 }]);
    expect(pickNearest(tree, { scale: 1, tx: 0, ty: 0 }, 100, 0)).toBeNull();
    expect(pickNearest(tree, { scale: 1, tx: 0, ty: 0 }, 3, 3)?.id).toBe('a');
  });
});

describe('GraphMap color resolution + palette branches', () => {
  it('resolves host CSS vars, passes literals through, degrades malformed var() and missing-var fallbacks', async () => {
    const style = document.createElement('style');
    style.textContent = '.archgen-map { --archgen-canvas: #101010; --probe-kind: #ff00ff; }';
    document.head.appendChild(style);
    try {
      const nodes: GraphMapNode[] = [
        { id: 'a', label: 'A', kind: 'class', file: 'f/one.ts', line: 1 },
        { id: 'b', label: 'B', kind: 'function', file: 'f/two.ts', line: 2 },
        { id: 'c', label: 'C', kind: 'module', file: 'f/three.ts', line: 3 },
        { id: 'd', label: 'D', kind: 'variable', file: 'f/four.ts', line: 4 },
        { id: 'e', label: 'E', kind: 'method', file: 'f/five.ts', line: 5 },
      ];
      const kindColorFor = (kind: string): string => {
        switch (kind) {
          case 'class':
            return 'var(--probe-kind)';
          case 'function':
            return '#ab12cd';
          case 'module':
            return 'var(broken';
          case 'variable':
            return 'var(--definitely-unset-archgen-var)';
          default:
            return 'var(--also-unset-archgen-var, #112233)';
        }
      };
      render(createElement(GraphMap, { nodes, kindColorFor, onSelect: () => {}, themeKind: 'dark' }));
      await flushFrames(60);

      const fills = recorder.values('fillStyle:set');
      expect(fills).toContain('#101010'); // bg resolved from --archgen-canvas
      expect(fills).toContain('#ff00ff'); // kind color resolved from --probe-kind
      expect(fills).toContain('#ab12cd'); // literal passes through untouched
      expect(fills).toContain('var(broken'); // malformed var() degrades to the raw string
      expect(fills).toContain('#8b949e'); // var() without inner fallback → dark dotFallback
      expect(fills).toContain('#112233'); // var() inner fallback used when the var is unset
    } finally {
      style.remove();
    }
  });

  it('light theme uses the light fallback palette when CSS vars are unreadable', async () => {
    const nodes = smallNodes(8, 4, 43);
    render(createElement(GraphMap, { nodes, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'light' }));
    await flushFrames(60);
    expect(recorder.values('fillStyle:set')).toContain('#ffffff');
  });
});

describe('GraphMap exotic-host degradation', () => {
  it('draw no-ops when getContext returns null', async () => {
    ctxControl.nullCtx = true;
    try {
      render(createElement(GraphMap, { nodes: smallNodes(), kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }));
      await flushFrames(60);
      expect(recorder.count('getContext')).toBeGreaterThan(0);
      expect(recorder.count('fillRect')).toBe(0);
    } finally {
      ctxControl.nullCtx = false;
    }
  });

  it('hulls fall back to rect() when roundRect is unavailable', async () => {
    ctxControl.noRoundRect = true;
    try {
      render(createElement(GraphMap, { nodes: smallNodes(40, 20, 45), kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }));
      await flushFrames(60);
      expect(recorder.count('roundRect')).toBe(0);
      expect(recorder.count('rect')).toBeGreaterThan(0);
    } finally {
      ctxControl.noRoundRect = false;
    }
  });

  it('backs the canvas at dpr 1 when devicePixelRatio is not a positive number', async () => {
    const restoreDpr = setDpr(0);
    try {
      const { container } = render(
        createElement(GraphMap, { nodes: smallNodes(), kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
      );
      await flushFrames(60);
      const canvas = mapEl(container);
      expect(canvas.width).toBe(800);
      expect(canvas.height).toBe(600);
    } finally {
      restoreDpr();
    }
  });

  it('schedules draws via setTimeout when requestAnimationFrame is unavailable', async () => {
    const prevRaf = window.requestAnimationFrame;
    const prevCaf = window.cancelAnimationFrame;
    Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: undefined });
    Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: undefined });
    try {
      const { unmount } = render(
        createElement(GraphMap, { nodes: smallNodes(), kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
      );
      await flushFrames(100);
      expect(recorder.count('fillRect')).toBeGreaterThan(0);
      unmount();
      await flushFrames(40);
    } finally {
      Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: prevRaf });
      Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: prevCaf });
    }
  });
});

describe('GraphMap hover/selection label + outline branches', () => {
  it('hover draws exactly one outline arc and one label (no selection)', async () => {
    const nodes = smallNodes(24, 8, 47);
    const layout = packByFile(nodes);
    const { container } = render(
      createElement(GraphMap, { nodes, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    const canvas = mapEl(container);
    const view = fitView(layout.bounds, 800, 600);
    const target = nodes[3]!;
    const s = worldToScreen(view, layout.positions.get(target.id)!.x, layout.positions.get(target.id)!.y);

    recorder.reset();
    fireEvent.pointerMove(canvas, { clientX: s.x, clientY: s.y });
    await flushFrames(60);
    expect(recorder.count('arc')).toBe(1); // hover outline only
    expect(recorder.count('fillText')).toBe(1); // hover label only (no edges → no top labels)
    expect(container.querySelector('.archgen-map')!.className).toContain('has-hover');
  });

  it('hover outline is culled once the hovered node pans off-viewport', async () => {
    const nodes = smallNodes(24, 8, 49);
    const layout = packByFile(nodes);
    const { container } = render(
      createElement(GraphMap, { nodes, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    const canvas = mapEl(container);
    const view = fitView(layout.bounds, 800, 600);
    const target = nodes[3]!;
    const s = worldToScreen(view, layout.positions.get(target.id)!.x, layout.positions.get(target.id)!.y);

    fireEvent.pointerMove(canvas, { clientX: s.x, clientY: s.y });
    await flushFrames(60);

    recorder.reset();
    fireEvent.pointerDown(canvas, { clientX: 400, clientY: 300 });
    fireEvent.pointerMove(canvas, { clientX: 400, clientY: 2300 });
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 2300 });
    await flushFrames(60);
    expect(recorder.count('arc')).toBe(0); // hovered node now off-screen → outline skipped
  });

  it('hover label still draws in the dot band (labels are not LOD-gated for hover)', async () => {
    const nodes = smallNodes(24, 8, 51);
    const layout = packByFile(nodes);
    const { container } = render(
      createElement(GraphMap, { nodes, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    const canvas = mapEl(container);
    // deltaY 1e9 → exp factor underflows → scale clamps to exactly MAP_MIN_SCALE.
    fireEvent.wheel(canvas, { deltaY: 1e9, clientX: 400, clientY: 300 });
    await flushFrames(60);

    // Wheel zoom anchors at the cursor: the world point under (400,300) stays
    // fixed, so the post-zoom view is fully determined by the fitted view.
    const fitted = fitView(layout.bounds, 800, 600);
    const anchor = screenToWorld(fitted, 400, 300);
    const zoomed: GraphMapView = { scale: 0.02, tx: 400 - anchor.x * 0.02, ty: 300 - anchor.y * 0.02 };
    const target = nodes[3]!;
    const p = layout.positions.get(target.id)!;
    const w = worldToScreen(zoomed, p.x, p.y);
    recorder.reset();
    fireEvent.pointerMove(canvas, { clientX: w.x, clientY: w.y });
    await flushFrames(60);
    expect(recorder.count('fillText')).toBeGreaterThanOrEqual(1);
  });

  it('selected + hovered labels dedupe when both point at the same node', async () => {
    const nodes = smallNodes(24, 8, 53);
    const layout = packByFile(nodes);
    const selected = nodes[1]!;
    const other = nodes[5]!;
    // Hidden document parks the 30fps pulse loop, so each hover triggers
    // exactly one dirty-frame draw and label counts stay deterministic.
    const restoreHidden = setDocumentHidden(true);
    try {
      const { container } = render(
        createElement(GraphMap, { nodes, kindColorFor: colorForKind, selectedId: selected.id, onSelect: () => {}, themeKind: 'dark' }),
      );
      await flushFrames();
      const canvas = mapEl(container);
      const view = fitView(layout.bounds, 800, 600);
      const sOther = worldToScreen(view, layout.positions.get(other.id)!.x, layout.positions.get(other.id)!.y);

      recorder.reset();
      fireEvent.pointerMove(canvas, { clientX: sOther.x, clientY: sOther.y });
      await flushFrames(60);
      expect(recorder.count('fillText')).toBe(2); // selected label + different hover label

      const sSel = worldToScreen(view, layout.positions.get(selected.id)!.x, layout.positions.get(selected.id)!.y);
      recorder.reset();
      fireEvent.pointerMove(canvas, { clientX: sSel.x, clientY: sSel.y });
      await flushFrames(60);
      expect(recorder.count('fillText')).toBe(1); // hover === selected → drawn once
    } finally {
      restoreHidden();
    }
  });

  it('a selected id absent from the layout draws no label and no pulse ring', async () => {
    const nodes = smallNodes(16, 6, 55);
    render(
      createElement(GraphMap, { nodes, kindColorFor: colorForKind, selectedId: 'does-not-exist', onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames(120);
    expect(recorder.count('fillText')).toBe(0);
    expect(recorder.count('arc')).toBe(0);
  });
});

describe('GraphMap edge drawing branches', () => {
  it('dangling edges are excluded from drawable pairs while valid edges draw', async () => {
    const nodes = smallNodes(16, 6, 57);
    const dangling: GraphMapEdge[] = [{ source: 'ghost-node', target: nodes[0]!.id }];
    render(
      createElement(GraphMap, { nodes, edges: dangling, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    expect(recorder.count('lineTo')).toBe(0); // dangling endpoint → no drawable pair
    cleanup();

    const valid: GraphMapEdge[] = [{ source: nodes[0]!.id, target: nodes[1]!.id }];
    render(
      createElement(GraphMap, { nodes, edges: valid, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    expect(recorder.count('lineTo')).toBeGreaterThan(0); // both endpoints resolve → segment drawn
  });

  it('viewport-culls edges entirely below/above the canvas and restores them on pan back', async () => {
    const nodes = smallNodes(12, 4, 59);
    const edges: GraphMapEdge[] = [{ source: nodes[0]!.id, target: nodes[1]!.id }];
    const { container } = render(
      createElement(GraphMap, { nodes, edges, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    const canvas = mapEl(container);
    expect(recorder.count('lineTo')).toBeGreaterThan(0);

    fireEvent.pointerDown(canvas, { clientX: 400, clientY: 300 });
    fireEvent.pointerMove(canvas, { clientX: 400, clientY: 2300 });
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 2300 });
    recorder.reset();
    await flushFrames(60);
    expect(recorder.count('lineTo')).toBe(0); // edge below the bottom edge

    fireEvent.pointerDown(canvas, { clientX: 400, clientY: 300 });
    fireEvent.pointerMove(canvas, { clientX: 400, clientY: -3700 });
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: -3700 });
    recorder.reset();
    await flushFrames(60);
    expect(recorder.count('lineTo')).toBe(0); // edge above the top edge

    fireEvent.pointerDown(canvas, { clientX: 400, clientY: 300 });
    fireEvent.pointerMove(canvas, { clientX: 400, clientY: 2300 });
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 2300 });
    recorder.reset();
    await flushFrames(60);
    expect(recorder.count('lineTo')).toBeGreaterThan(0); // back in view
  });
});

describe('GraphMap zoom-ceiling + click-vs-drag branches', () => {
  it('wheel at the 400% ceiling schedules no redraw and keeps the viewport', async () => {
    const nodes = smallNodes(16, 6, 61);
    const { container } = render(
      createElement(GraphMap, { nodes, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    const canvas = mapEl(container);
    const hud = () => container.querySelector('.archgen-map-hud')!.textContent ?? '';

    fireEvent.wheel(canvas, { deltaY: -1e9, clientX: 400, clientY: 300 });
    await flushFrames(40);
    expect(hud()).toContain('400%');

    recorder.reset();
    fireEvent.wheel(canvas, { deltaY: -1e9, clientX: 400, clientY: 300 });
    await flushFrames(60);
    expect(recorder.total()).toBe(0); // clamped scale unchanged → no scheduleDraw
    expect(hud()).toContain('400%');
  });

  it('double-click at the zoom ceiling keeps the scale unchanged', async () => {
    const nodes = smallNodes(16, 6, 63);
    const { container } = render(
      createElement(GraphMap, { nodes, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    const canvas = mapEl(container);
    const hud = () => container.querySelector('.archgen-map-hud')!.textContent ?? '';
    fireEvent.wheel(canvas, { deltaY: -1e9, clientX: 400, clientY: 300 });
    await flushFrames(40);
    expect(hud()).toContain('400%');
    fireEvent.doubleClick(canvas, { clientX: 400, clientY: 300 });
    await flushFrames(40);
    expect(hud()).toContain('400%');
  });

  it('a sub-epsilon press+move still counts as a click (no pan)', async () => {
    const nodes = smallNodes(24, 8, 65);
    const layout = packByFile(nodes);
    const onSelect = vi.fn();
    const { container } = render(
      createElement(GraphMap, { nodes, kindColorFor: colorForKind, onSelect, themeKind: 'dark' }),
    );
    await flushFrames();
    const canvas = mapEl(container);
    const view = fitView(layout.bounds, 800, 600);
    const target = nodes[7]!;
    const s = worldToScreen(view, layout.positions.get(target.id)!.x, layout.positions.get(target.id)!.y);

    fireEvent.pointerDown(canvas, { clientX: s.x, clientY: s.y });
    fireEvent.pointerMove(canvas, { clientX: s.x + 1, clientY: s.y + 1 });
    fireEvent.pointerUp(canvas, { clientX: s.x + 1, clientY: s.y + 1 });
    expect(onSelect).toHaveBeenCalledWith(target.id);
  });

  it('pointer move over empty space clears hover state and hides the tooltip', async () => {
    const nodes = smallNodes(24, 8, 67);
    const layout = packByFile(nodes);
    const { container } = render(
      createElement(GraphMap, { nodes, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    const canvas = mapEl(container);
    const host = container.querySelector('.archgen-map')!;
    const tip = container.querySelector('.archgen-map-tooltip')!;
    const view = fitView(layout.bounds, 800, 600);
    const target = nodes[2]!;
    const s = worldToScreen(view, layout.positions.get(target.id)!.x, layout.positions.get(target.id)!.y);

    fireEvent.pointerMove(canvas, { clientX: s.x, clientY: s.y });
    expect(host.className).toContain('has-hover');
    expect(tip.classList.contains('is-visible')).toBe(true);

    fireEvent.pointerMove(canvas, { clientX: 797, clientY: 597 });
    expect(host.className).not.toContain('has-hover');
    expect(tip.classList.contains('is-visible')).toBe(false);
  });

  it('pointerleave without an active hover is a safe no-op', async () => {
    const { container } = render(
      createElement(GraphMap, { nodes: smallNodes(), kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    const canvas = mapEl(container);
    fireEvent.pointerLeave(canvas);
    expect(container.querySelector('.archgen-map')!.className).not.toContain('has-hover');
    expect(container.querySelector('.archgen-map')!.className).not.toContain('is-panning');
  });

  it('pointercancel clears an active hover', async () => {
    const nodes = smallNodes(24, 8, 69);
    const layout = packByFile(nodes);
    const { container } = render(
      createElement(GraphMap, { nodes, kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames();
    const canvas = mapEl(container);
    const view = fitView(layout.bounds, 800, 600);
    const target = nodes[4]!;
    const s = worldToScreen(view, layout.positions.get(target.id)!.x, layout.positions.get(target.id)!.y);

    fireEvent.pointerMove(canvas, { clientX: s.x, clientY: s.y });
    expect(container.querySelector('.archgen-map')!.className).toContain('has-hover');
    fireEvent.pointerCancel(canvas);
    expect(container.querySelector('.archgen-map')!.className).not.toContain('has-hover');
  });
});

describe('GraphMap pulse-park + dpr-watcher branches', () => {
  it('unmounting a parked pulse loop cancels nothing (frame ref already null)', async () => {
    const { unmount } = render(
      createElement(GraphMap, { nodes: smallNodes(), kindColorFor: colorForKind, selectedId: 'n1', onSelect: () => {}, themeKind: 'dark' }),
    );
    await flushFrames(100);

    const restoreHidden = setDocumentHidden(true);
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      await flushFrames(150); // in-flight tick parks the loop

      const cafSpy = vi.spyOn(window, 'cancelAnimationFrame');
      unmount();
      expect(cafSpy).not.toHaveBeenCalled();
      cafSpy.mockRestore();
    } finally {
      restoreHidden();
    }
  });

  it('dpr watcher re-arms via legacy listener APIs and removes the old listener on change', async () => {
    const fake = installMatchMediaFake({ legacy: true });
    try {
      const { unmount } = render(
        createElement(GraphMap, { nodes: smallNodes(), kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
      );
      await flushFrames(60);
      expect(fake.queries).toContain('(resolution: 1dppx)');
      const first = fake.mqls[fake.mqls.length - 1]!;
      expect(first.listeners.length).toBe(1);

      const restoreDpr = setDpr(2);
      try {
        act(() => {
          for (const cb of [...first.listeners]) cb();
        });
        await flushFrames(60);
      } finally {
        restoreDpr();
      }
      expect(first.listeners.length).toBe(0); // legacy removeListener on re-arm
      expect(fake.queries).toContain('(resolution: 2dppx)'); // re-armed around the new dpr

      unmount();
      const last = fake.mqls[fake.mqls.length - 1]!;
      expect(last.listeners.length).toBe(0); // cleanup detached via legacy removeListener
    } finally {
      fake.restore();
    }
  });

  it('dpr watcher re-arms at fallback dpr 1 when devicePixelRatio is invalid at change time', async () => {
    const fake = installMatchMediaFake();
    try {
      const { unmount } = render(
        createElement(GraphMap, { nodes: smallNodes(), kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
      );
      await flushFrames(60);
      const active = fake.mqls[fake.mqls.length - 1]!;

      const restoreDpr = setDpr(0);
      try {
        act(() => {
          for (const cb of [...active.listeners]) cb();
        });
        await flushFrames(60);
      } finally {
        restoreDpr();
      }
      expect(fake.queries.filter((q) => q === '(resolution: 1dppx)').length).toBeGreaterThan(1);
      unmount();
    } finally {
      fake.restore();
    }
  });

  it('a throwing matchMedia degrades to no dpr watcher and still unmounts cleanly', async () => {
    const fake = installMatchMediaFake({ throwing: true });
    try {
      const { unmount } = render(
        createElement(GraphMap, { nodes: smallNodes(), kindColorFor: colorForKind, onSelect: () => {}, themeKind: 'dark' }),
      );
      await flushFrames(60);
      expect(recorder.count('fillRect')).toBeGreaterThan(0); // drawing unaffected
      unmount();
      await flushFrames(30); // cleanup with null mql must not throw
    } finally {
      fake.restore();
    }
  });
});
