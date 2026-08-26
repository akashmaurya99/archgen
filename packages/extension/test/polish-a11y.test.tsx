// Polish a11y + state tests (todo 13, jsdom):
// - node aria-label contract `task <id>: <title>, status <status>`
// - keyboard: every node in tab order; Enter/Space on focused node dispatches build
// - empty state: 'run archgen-skill init' hint + copyable install command
// - error state: last-good graph stays mounted (dimmed class) + dismissible banner
// - stale-data chip renders "updated Ns ago"
// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { createElement } from 'react';
import { App } from '../src/webview/App';
import { INSTALL_COMMAND, formatDataAge } from '../src/webview/states';
import type { ArchgenModelMessage, HostToWebview } from '../src/shared/protocol';
import { resetVsCodeApiForTests } from '../src/webview/vscode';
import { installFlowDomStubs } from './helpers/dom-stubs';
import { GraphMap, type GraphMapNode } from '../src/webview/GraphMap';
import { reconcileCachedNodes, type GraphFlowNode, type GraphNodeMeta } from '../src/webview/CodeGraphView';
import { colorForKind } from '../src/webview/graph-model';

installFlowDomStubs();

function task(id: string, status: ArchgenModelMessage['tasks'][number]['status'], dependsOn: string[] = []) {
  return { id, title: `Title ${id}`, status, dependsOn, fileOwnership: [], artifacts: [] };
}

const MODEL: ArchgenModelMessage = {
  type: 'model',
  tasks: [task('A', 'pending'), task('B', 'running', ['A'])],
  docs: [{ path: 'plans/demo.md', title: 'demo.md' }],
  codegraph: { product: 'unsupported' },
  themeKind: 'dark',
  warnings: [],
  features: [],
  activeSlug: '',
};

interface FakeApi {
  posted: unknown[];
  state: Record<string, unknown>;
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(s: T): void;
}

function makeApi(): FakeApi {
  const api: FakeApi = {
    posted: [],
    state: {},
    postMessage(msg) { api.posted.push(msg); },
    getState<T>() { return api.state as T; },
    setState<T>(s: T) { api.state = s as Record<string, unknown>; },
  };
  return api;
}

function mount(m: ArchgenModelMessage = MODEL): FakeApi {
  const api = makeApi();
  render(createElement(App, { api }));
  act(() => {
    window.dispatchEvent(new MessageEvent<HostToWebview>('message', { data: m }));
  });
  return api;
}

beforeEach(() => {
  installFlowDomStubs();
  cleanup();
  resetVsCodeApiForTests();
});

describe('node aria-label contract', () => {
  it('labels each node as "task <id>: <title>, status <status>"', () => {
    mount();
    for (const t of MODEL.tasks) {
      expect(screen.getByRole('button', { name: `task ${t.id}: Title ${t.id}, status ${t.status}` })).toBeTruthy();
    }
  });

  it('updates the announced status after an update diff', async () => {
    mount();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'update', changed: [{ id: 'A', status: 'done' }] },
      }));
    });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    });
    expect(screen.getByRole('button', { name: 'task A: Title A, status done' })).toBeTruthy();
  });

  it('build buttons carry descriptive aria-labels', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Build task A' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Start Work/ })).toBeTruthy();
  });
});

describe('keyboard navigation', () => {
  it('puts every task node in the tab order', () => {
    mount();
    const nodes = [...document.querySelectorAll<HTMLElement>('.archgen-tasknode')];
    expect(nodes.length).toBe(2);
    for (const n of nodes) expect(n.getAttribute('tabindex')).toBe('0');
  });

  it('Enter and Space on a focused node dispatch the build message', () => {
    const api = mount();
    const nodeB = document.querySelector<HTMLElement>('[data-task-id="B"]')!;
    fireEvent.keyDown(nodeB, { key: 'Enter' });
    fireEvent.keyDown(nodeB, { key: ' ' });
    const builds = api.posted.filter((m) => (m as { type: string }).type === 'build');
    expect(builds).toEqual([{ type: 'build', taskId: 'B' }, { type: 'build', taskId: 'B' }]);
  });

  it('other keys do not dispatch', () => {
    const api = mount();
    fireEvent.keyDown(document.querySelector<HTMLElement>('[data-task-id="A"]')!, { key: 'Tab' });
    expect(api.posted.filter((m) => (m as { type: string }).type === 'build')).toEqual([]);
  });
});

describe('empty state install CTA', () => {
  it('shows the archgen init hint with a copyable install command', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { ...MODEL, tasks: [], docs: [] } }));
    });
    expect(screen.getAllByText(/archgen-skill init/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Copy install command' }));
    await act(async () => { await Promise.resolve(); });
    expect(writeText).toHaveBeenCalledWith(INSTALL_COMMAND);
    expect(INSTALL_COMMAND).toEqual('npx archgen-skill init');
    expect(screen.getByText('Copied!')).toBeTruthy();
    void api;
  });
});

describe('error state keeps the last-good graph', () => {
  it('dims content and shows a dismissible top-center banner without unmounting nodes', () => {
    const api = mount();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'status', kind: 'error', message: 'watcher hiccup' },
      }));
    });
    const root = screen.getByTestId('archgen-root');
    expect(root.className).toContain('archgen-root--dimmed');
    // last-good graph still mounted underneath
    expect(document.querySelector('[data-task-id="B"]')).toBeTruthy();
    const banner = screen.getByRole('alert');
    expect(banner.className).toContain('archgen-error-banner');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(root.className).not.toContain('archgen-root--dimmed');
    void api;
  });
});

describe('stale-data chip', () => {
  it('formats seconds under a minute and minutes beyond', () => {
    expect(formatDataAge(0)).toBe('updated 0s ago');
    expect(formatDataAge(59_400)).toBe('updated 59s ago');
    expect(formatDataAge(61_000)).toBe('updated 1m ago');
    expect(formatDataAge(754_000)).toBe('updated 12m ago');
  });

  it('renders a timer chip reflecting the last model snapshot', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
      const api = makeApi();
      render(createElement(App, { api }));
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data: MODEL }));
      });
      const chip = screen.getByRole('timer');
      expect(chip.textContent).toMatch(/^updated \d+s ago$/);
      act(() => { vi.advanceTimersByTime(5000); });
      expect(Number(/\d+/.exec(chip.textContent!)?.[0])).toBeGreaterThanOrEqual(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ==== GraphMap lifecycle polish (todo 15) ====
 * Local jsdom mocks (kept file-local like graph-map.test.tsx): a recording
 * canvas context, positive host size for `.archgen-map` (toggleable to 0 to
 * prove the zero-size pause), and a PointerEvent polyfill so fireEvent's
 * pointer events carry through React.
 */

const mapOps: string[] = [];
const mapHostSize = { w: 800, h: 600 };

function installGraphMapDomMocks(): void {
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
  if (!canvasProto['__polishMapCtxMocked']) {
    canvasProto['__polishMapCtxMocked'] = true;
    const methods = [
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
    ];
    const ctx: Record<string, unknown> = {};
    for (const m of methods) ctx[m] = () => { mapOps.push(m); };
    for (const p of ['fillStyle', 'strokeStyle', 'globalAlpha', 'font', 'lineWidth', 'textBaseline']) {
      Object.defineProperty(ctx, p, {
        configurable: true,
        get: () => null,
        set: () => { mapOps.push(`${p}:set`); },
      });
    }
    canvasProto['getContext'] = function (): CanvasRenderingContext2D | null {
      mapOps.push('getContext');
      return ctx as unknown as CanvasRenderingContext2D;
    };
  }

  const htmlProto = HTMLElement.prototype as unknown as Record<string, unknown>;
  if (!htmlProto['__polishMapClientPatched']) {
    htmlProto['__polishMapClientPatched'] = true;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('archgen-map') ? mapHostSize.w : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('archgen-map') ? mapHostSize.h : 0;
      },
    });
  }
}

installGraphMapDomMocks();

const MAP_NODES: GraphMapNode[] = [
  { id: 'n0', label: 'Alpha', kind: 'class', file: 'src/a.ts', line: 1 },
  { id: 'n1', label: 'Beta', kind: 'function', file: 'src/b.ts', line: 2 },
  { id: 'n2', label: 'Gamma', kind: 'module', file: 'src/c.ts', line: 3 },
];

function renderMap(selectedId: string | null = null) {
  return render(
    createElement(GraphMap, {
      nodes: MAP_NODES,
      kindColorFor: colorForKind,
      selectedId,
      onSelect: () => {},
      themeKind: 'dark',
    }),
  );
}

async function settle(ms = 60): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function setDocumentHidden(hidden: boolean): () => void {
  const prev = Object.getOwnPropertyDescriptor(document, 'hidden');
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  return () => {
    if (prev) Object.defineProperty(document, 'hidden', prev);
    else delete (document as unknown as Record<string, unknown>)['hidden'];
  };
}

interface FakeMediaQueryList {
  matches: boolean;
  media: string;
  onchange: null;
  listeners: Array<(ev: { matches: boolean; media: string }) => void>;
  addEventListener(type: string, cb: (ev: { matches: boolean; media: string }) => void): void;
  removeEventListener(type: string, cb: (ev: { matches: boolean; media: string }) => void): void;
  addListener(cb: (ev: { matches: boolean; media: string }) => void): void;
  removeListener(cb: (ev: { matches: boolean; media: string }) => void): void;
  dispatchEvent(ev: Event): boolean;
}

function installMatchMediaFake(): { mqls: FakeMediaQueryList[]; restore: () => void } {
  const mqls: FakeMediaQueryList[] = [];
  const prev = window.matchMedia;
  window.matchMedia = ((query: string): FakeMediaQueryList => {
    const mql: FakeMediaQueryList = {
      matches: true,
      media: query,
      onchange: null,
      listeners: [],
      addEventListener(_type, cb) {
        this.listeners.push(cb);
      },
      removeEventListener(_type, cb) {
        this.listeners = this.listeners.filter((l) => l !== cb);
      },
      addListener(cb) {
        this.listeners.push(cb);
      },
      removeListener(cb) {
        this.listeners = this.listeners.filter((l) => l !== cb);
      },
      dispatchEvent() {
        return true;
      },
    };
    mqls.push(mql);
    return mql;
  }) as unknown as typeof window.matchMedia;
  return {
    mqls,
    restore: () => {
      if (prev) window.matchMedia = prev;
      else delete (window as unknown as Record<string, unknown>)['matchMedia'];
    },
  };
}

describe('GraphMap lifecycle polish (todo 15)', () => {
  beforeEach(() => {
    mapOps.length = 0;
    mapHostSize.w = 800;
    mapHostSize.h = 600;
  });
  afterEach(cleanup);

  it('pointercancel clears drag/pan state exactly like pointerleave', async () => {
    const { container } = renderMap();
    await settle();
    const canvas = container.querySelector('canvas')!;
    const host = container.querySelector('.archgen-map')!;

    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    expect(host.className).toContain('is-panning');

    fireEvent.pointerCancel(canvas);
    expect(host.className).not.toContain('is-panning');

    // A cancelled drag must NOT produce a click-selection afterwards.
    const onSelect = vi.fn();
    cleanup();
    const c2 = render(
      createElement(GraphMap, {
        nodes: MAP_NODES,
        kindColorFor: colorForKind,
        onSelect,
        themeKind: 'dark',
      }),
    );
    await settle();
    const canvas2 = c2.container.querySelector('canvas')!;
    fireEvent.pointerDown(canvas2, { clientX: 10, clientY: 10 });
    fireEvent.pointerCancel(canvas2);
    fireEvent.pointerUp(canvas2, { clientX: 10, clientY: 10 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('pauses the selection pulse while the document is hidden (zero rAF churn) and resumes on visibilitychange', async () => {
    renderMap('n0');
    await settle(120); // pulse loop running

    const restoreHidden = setDocumentHidden(true);
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      await settle(120); // in-flight frame drains; loop parks

      const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
      await settle(250);
      expect(rafSpy).not.toHaveBeenCalled(); // hidden tab: pulse fully stopped

      setDocumentHidden(false);
      document.dispatchEvent(new Event('visibilitychange'));
      await settle(120);
      expect(rafSpy).toHaveBeenCalled(); // visible again: pulse resumed
      rafSpy.mockRestore();
    } finally {
      restoreHidden();
    }
  });

  it('pauses the pulse on a zero-size host and resumes after resize', async () => {
    mapHostSize.w = 0;
    mapHostSize.h = 0;
    renderMap('n0');
    await settle(120); // first tick parks: nothing to animate

    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    await settle(250);
    expect(rafSpy).not.toHaveBeenCalled();

    mapHostSize.w = 800;
    mapHostSize.h = 600;
    window.dispatchEvent(new Event('resize'));
    await settle(120);
    expect(rafSpy).toHaveBeenCalled();
    rafSpy.mockRestore();
  });

  it('a devicePixelRatio change triggers a redraw without any interaction', async () => {
    const fake = installMatchMediaFake();
    try {
      renderMap();
      await settle(80);
      expect(fake.mqls.length).toBeGreaterThan(0); // dpr watcher armed
      mapOps.length = 0;

      const active = fake.mqls[fake.mqls.length - 1]!;
      act(() => {
        for (const cb of [...active.listeners]) cb({ matches: false, media: active.media });
      });
      await settle(80);
      expect(mapOps.length).toBeGreaterThan(0); // redraw happened
      expect(mapOps).toContain('getContext');
    } finally {
      fake.restore();
    }
  });
});

describe('reconcileCachedNodes cache pruning (todo 15)', () => {
  const META: GraphNodeMeta[] = [
    { id: 'a', label: 'Alpha', kind: 'class', file: 'a.ts', line: 1 },
    { id: 'b', label: 'Beta', kind: 'function', file: 'b.ts', line: 2 },
    { id: 'c', label: 'Gamma', kind: 'module', file: 'c.ts', line: 3 },
  ];
  const metaMap = (): Map<string, GraphNodeMeta> => new Map(META.map((m) => [m.id, m]));
  const placed = (ids: string[]): Array<{ id: string; position: { x: number; y: number } }> =>
    ids.map((id, i) => ({ id, position: { x: i * 10, y: 0 } }));

  it('drops cache entries for ids no longer in the current placements', () => {
    const cache = new Map<string, GraphFlowNode>();
    reconcileCachedNodes(cache, placed(['a', 'b', 'c']), metaMap(), null, null);
    expect(cache.size).toBe(3);

    const after = reconcileCachedNodes(cache, placed(['a']), metaMap(), null, null);
    expect(after.map((n) => n.id)).toEqual(['a']);
    expect(cache.size).toBe(1);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(false);
  });

  it('keeps identity-stable objects for surviving ids across a prune', () => {
    const cache = new Map<string, GraphFlowNode>();
    const before = reconcileCachedNodes(cache, placed(['a', 'b']), metaMap(), null, null);
    const after = reconcileCachedNodes(cache, placed(['a']), metaMap(), null, null);
    expect(after[0]).toBe(before[0]); // reused from cache, not rebuilt
  });
});
