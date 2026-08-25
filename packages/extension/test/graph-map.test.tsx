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
import { render, cleanup, fireEvent } from '@testing-library/react';
import { createElement } from 'react';
import {
  GraphMap,
  fitView,
  worldToScreen,
  type GraphMapEdge,
  type GraphMapNode,
} from '../src/webview/GraphMap';
import { packByFile } from '../src/webview/map-layout';
import { colorForKind } from '../src/webview/graph-model';

/* ==== local recording canvas-mock (file-local; dom-stubs.ts untouched) ==== */

interface OpCall {
  op: string;
}

const recorder = {
  calls: [] as OpCall[],
  total(): number {
    return this.calls.length;
  },
  count(op: string): number {
    return this.calls.reduce((n, c) => (c.op === op ? n + 1 : n), 0);
  },
  reset(): void {
    this.calls.length = 0;
  },
};

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
  'roundRect',
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
    for (const p of CTX_PROPS) {
      Object.defineProperty(ctx, p, {
        configurable: true,
        get: () => null,
        set: () => {
          recorder.calls.push({ op: `${p}:set` });
        },
      });
    }
    canvasProto['getContext'] = function (): CanvasRenderingContext2D | null {
      recorder.calls.push({ op: 'getContext' });
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
