// Task DAG view tests (jsdom): dagre LR ordering, 6-status class matrix,
// edge animation rules, legend/minimap/controls presence, plus enterprise
// additions: status filter chips (+ orphan-edge hiding), LR↔TB layout toggle,
// edge arrowheads, collapsible legend, wave-progress chip, Escape blur.
// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { createElement } from 'react';
import { App } from '../src/webview/App';
import { layoutLeftToRight } from '../src/webview/layout';
import type { ArchgenModelMessage, HostToWebview, TaskVM } from '../src/shared/protocol';
import { resetVsCodeApiForTests } from '../src/webview/vscode';
import { installFlowDomStubs } from './helpers/dom-stubs';

installFlowDomStubs();

function task(id: string, status: TaskVM['status'], dependsOn: string[] = []): TaskVM {
  return { id, title: `Task ${id}`, status, dependsOn, fileOwnership: [], artifacts: [] };
}

const SIX: TaskVM[] = [
  task('t-pending', 'pending'),
  task('t-ready', 'ready'),
  task('t-running', 'running'),
  task('t-blocked', 'blocked'),
  task('t-done', 'done'),
  task('t-failed', 'failed'),
];

const MODEL: ArchgenModelMessage = {
  type: 'model',
  tasks: [
    ...SIX,
    // chain for edge rules: A → B → C (B running ⇒ edge into B animated)
    task('chain-a', 'done'),
    task('chain-b', 'running', ['chain-a']),
    task('chain-c', 'failed', ['chain-b']),
    task('chain-d', 'blocked', ['chain-c']),
  ],
  docs: [],
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

function renderWithModel(m: ArchgenModelMessage = MODEL): void {
  const api = makeApi();
  render(createElement(App, { api }));
  act(() => {
    window.dispatchEvent(new MessageEvent<HostToWebview>('message', { data: m }));
  });
}

beforeEach(() => {
  installFlowDomStubs();
  cleanup();
  resetVsCodeApiForTests();
});

describe('layoutLeftToRight (dagre LR)', () => {
  it('orders dependency chain C,B,A left→right', () => {
    const nodes = [
      { id: 'A', position: { x: 0, y: 0 } },
      { id: 'B', position: { x: 0, y: 0 } },
      { id: 'C', position: { x: 0, y: 0 } },
    ];
    const edges = [
      { source: 'C', target: 'B' }, // C is B's dependency
      { source: 'B', target: 'A' }, // B is A's dependency
    ];
    const out = layoutLeftToRight(nodes, edges);
    const xOf = (id: string): number => out.find((n) => n.id === id)?.position.x ?? NaN;
    expect(xOf('C')).toBeLessThan(xOf('B'));
    expect(xOf('B')).toBeLessThan(xOf('A'));
  });

  it('does not mutate inputs and ignores edges to unknown ids', () => {
    const nodes = [{ id: 'X', position: { x: 0, y: 0 } }];
    const out = layoutLeftToRight(nodes, [{ source: 'ghost', target: 'X' }]);
    expect(out).toHaveLength(1);
    expect(out[0]?.position.x).not.toBeNaN();
    expect(nodes[0]?.position).toEqual({ x: 0, y: 0 });
  });

  it('stacks disconnected nodes without overlap', () => {
    const nodes = [
      { id: 'p', position: { x: 0, y: 0 } },
      { id: 'q', position: { x: 0, y: 0 } },
    ];
    const out = layoutLeftToRight(nodes, []);
    expect(out[0]?.position.y).not.toBe(out[1]?.position.y);
  });
});

describe('Task DAG canvas', () => {
  it('renders the exact six-status class matrix (no cancelled)', () => {
    renderWithModel();
    for (const t of SIX) {
      const el = document.querySelector(`[data-task-id="${t.id}"]`);
      expect(el, `node ${t.id}`).toBeTruthy();
      expect(el?.classList.contains(`archgen-node--${t.status}`)).toBe(true);
    }
    expect(document.querySelector('[data-task-id="t-running"]')?.classList.contains('archgen-pulse')).toBe(true);
    expect(document.querySelector('.archgen-node--cancelled')).toBeNull();
    expect(document.querySelectorAll('.archgen-tasknode')).toHaveLength(SIX.length + 4);
  });

  it('animates ONLY edges flowing into running targets; failed red; blocked dashed', async () => {
    renderWithModel();
    // 3 chain edges: a→b (b running ⇒ animated), b→c (failed), c→d (blocked).
    // Edge DOM materializes after the stubbed measurement microtask.
    await act(async () => { await Promise.resolve(); });
    const animated = document.querySelectorAll('.react-flow__edge.animated');
    expect(animated).toHaveLength(1);
    expect(document.querySelector('.react-flow__edge.archgen-edge--failed')).toBeTruthy();
    expect(document.querySelector('.react-flow__edge.archgen-edge--blocked')).toBeTruthy();
    // the failed/blocked edges must NOT be animated
    expect(document.querySelector('.react-flow__edge.archgen-edge--failed')?.classList.contains('animated')).toBe(false);
    expect(document.querySelector('.react-flow__edge.archgen-edge--blocked')?.classList.contains('animated')).toBe(false);
  });

  it('shows MiniMap and Controls', () => {
    renderWithModel();
    expect(document.querySelector('.react-flow__minimap')).toBeTruthy();
    expect(document.querySelector('.react-flow__controls')).toBeTruthy();
  });

  it('applies update diffs through the canvas nodes', async () => {
    renderWithModel({ ...MODEL, tasks: [...SIX] });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'update', changed: [{ id: 't-pending', status: 'done' }] },
      }));
    });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    });
    expect(document.querySelector('[data-task-id="t-pending"] [data-status]')?.getAttribute('data-status')).toBe('done');
  });

  it('revealTask spotlights exactly the requested node via is-highlighted', () => {
    renderWithModel(CHAIN_MODEL);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'revealTask', taskId: 'b-mid' },
      }));
    });
    expect(document.querySelector('[data-task-id="b-mid"]')?.classList.contains('is-highlighted')).toBe(true);
    expect(document.querySelectorAll('.is-highlighted')).toHaveLength(1);
  });
});

/** Chain used by filter/toggle tests: root(done) → mid(running) → end(pending). */
const CHAIN: TaskVM[] = [
  task('a-root', 'done'),
  task('b-mid', 'running', ['a-root']),
  task('c-end', 'pending', ['b-mid']),
];

const CHAIN_MODEL: ArchgenModelMessage = { ...MODEL, tasks: CHAIN };

async function flushEdges(): Promise<void> {
  // Edge DOM materializes after the stubbed measurement microtask.
  await act(async () => { await Promise.resolve(); });
}

describe('status filter chips (A)', () => {
  it('renders one chip per status with live counts plus an All reset', () => {
    renderWithModel({ ...MODEL, tasks: [...SIX] });
    for (const s of ['pending', 'ready', 'running', 'blocked', 'done', 'failed'] as const) {
      expect(screen.getByRole('button', { name: `Filter ${s} tasks (1)` })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Show all tasks' })).toBeTruthy();
  });

  it('counts reflect live status diffs', async () => {
    renderWithModel({ ...MODEL, tasks: [...SIX] });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'update', changed: [{ id: 't-pending', status: 'running' }] },
      }));
    });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    });
    expect(screen.getByRole('button', { name: 'Filter pending tasks (0)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter running tasks (2)' })).toBeTruthy();
  });

  it('filtering hides non-matching nodes AND their orphaned edges via the hidden flag', async () => {
    renderWithModel(CHAIN_MODEL);
    await flushEdges();
    expect(document.querySelectorAll('.react-flow__edge')).toHaveLength(2);

    // Show only running → a-root and c-end hide; both edges lose an endpoint.
    fireEvent.click(screen.getByRole('button', { name: 'Filter running tasks (1)' }));

    expect(document.querySelector('[data-task-id="a-root"]')).toBeNull();
    expect(document.querySelector('[data-task-id="c-end"]')).toBeNull();
    expect(document.querySelector('[data-task-id="b-mid"]')).toBeTruthy();
    expect(document.querySelectorAll('.react-flow__edge')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Show all tasks' }));
    expect(document.querySelectorAll('.archgen-tasknode')).toHaveLength(3);
    await flushEdges();
    expect(document.querySelector('[data-id="a-root->b-mid"]')).toBeTruthy();
    expect(document.querySelector('[data-id="b-mid->c-end"]')).toBeTruthy();
  });

  it('keeps edges between two VISIBLE nodes while hiding edges into filtered-out ones', async () => {
    // d1(done) → d2(done) → d3(pending): filtering to 'done' keeps d1,d2 on
    // the board, hides d3, kills the d2->d3 edge and preserves d1->d2.
    const doubleDone: ArchgenModelMessage = {
      ...MODEL,
      tasks: [task('d1', 'done'), task('d2', 'done', ['d1']), task('d3', 'pending', ['d2'])],
    };
    renderWithModel(doubleDone);
    await flushEdges();
    fireEvent.click(screen.getByRole('button', { name: 'Filter done tasks (2)' }));
    expect(document.querySelector('[data-task-id="d1"]')).toBeTruthy();
    expect(document.querySelector('[data-task-id="d2"]')).toBeTruthy();
    expect(document.querySelector('[data-task-id="d3"]')).toBeNull();
    expect(document.querySelector('[data-id="d1->d2"]')).toBeTruthy();
    expect(document.querySelector('[data-id="d2->d3"]')).toBeNull();
  });

  it('announces politely when filters empty the board', () => {
    const pairOnly: ArchgenModelMessage = { ...MODEL, tasks: [task('x', 'pending'), task('y', 'done')] };
    renderWithModel(pairOnly);
    fireEvent.click(screen.getByRole('button', { name: 'Filter ready tasks (0)' }));
    expect(screen.getByText('No tasks match the selected filters')).toBeTruthy();
    expect(screen.getByTestId('archgen-filter-announce').getAttribute('aria-live')).toBe('polite');
  });

  it('chips expose aria-pressed toggle state', () => {
    renderWithModel(CHAIN_MODEL);
    const chip = screen.getByRole('button', { name: 'Filter done tasks (1)' });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('layout direction toggle (B)', () => {
  it('flips Handle positions LR ↔ TB on the node objects', () => {
    renderWithModel(CHAIN_MODEL);
    const node = document.querySelector('[data-task-id="b-mid"]');
    expect(node?.querySelector('.react-flow__handle-left')).toBeTruthy();
    expect(node?.querySelector('.react-flow__handle-right')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle DAG layout direction (currently left-right)' }));

    const tbNode = document.querySelector('[data-task-id="b-mid"]');
    expect(tbNode?.querySelector('.react-flow__handle-top')).toBeTruthy();
    expect(tbNode?.querySelector('.react-flow__handle-bottom')).toBeTruthy();
    expect(tbNode?.querySelector('.react-flow__handle-left')).toBeNull();
    expect(tbNode?.querySelector('.react-flow__handle-right')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle DAG layout direction (currently top-down)' }));
    const lrNode = document.querySelector('[data-task-id="b-mid"]');
    expect(lrNode?.querySelector('.react-flow__handle-left')).toBeTruthy();
    expect(lrNode?.querySelector('.react-flow__handle-right')).toBeTruthy();
  });

  it('TB layout stacks a dependency chain vertically (dagre rankdir TB)', () => {
    renderWithModel(CHAIN_MODEL);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle DAG layout direction (currently left-right)' }));
    const yOf = (id: string): number =>
      Number((document.querySelector(`[data-testid="rf__node-${id}"]`) as HTMLElement | null)?.style.transform.match(/,\s*(-?[\d.]+)px\)/)?.[1] ?? NaN);
    const rootY = yOf('a-root');
    const endY = yOf('c-end');
    expect(rootY).not.toBeNaN();
    expect(endY).not.toBeNaN();
    expect(endY).toBeGreaterThan(rootY);
  });
});

describe('edge arrowheads (C)', () => {
  it('every edge carries an ArrowClosed markerEnd tinted by target-status color', async () => {
    renderWithModel(CHAIN_MODEL);
    await flushEdges();
    const paths = [...document.querySelectorAll<SVGPathElement>('.react-flow__edge-path')];
    expect(paths.length).toBeGreaterThanOrEqual(2);
    for (const p of paths) {
      expect(p.getAttribute('marker-end') ?? '').toMatch(/^url\('/);
    }
    const heads = [...document.querySelectorAll<SVGPolylineElement>('polyline.arrowclosed')];
    expect(heads.length).toBeGreaterThan(0);
    const styles = heads.map((h) => h.getAttribute('style') ?? '');
    // b-mid is running → at least one marker tinted with the running token.
    expect(styles.some((s) => s.includes('--archgen-status-running'))).toBe(true);
  });
});


describe('wave progress chip (E)', () => {
  it('derives done/total from live statuses near Start Work', async () => {
    renderWithModel({ ...MODEL, tasks: [...SIX] });
    const chip = screen.getByRole('status', { name: '1 of 6 tasks done' });
    expect(chip.textContent).toBe('1/6 done');

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'update', changed: [{ id: 't-pending', status: 'done' }] },
      }));
    });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    });
    expect(screen.getByRole('status', { name: '2 of 6 tasks done' }).textContent).toBe('2/6 done');
  });
});

describe('Escape clears focus ring state (F)', () => {
  it('blurs the focused node so no ring remains', () => {
    renderWithModel(CHAIN_MODEL);
    const node = document.querySelector<HTMLElement>('[data-task-id="b-mid"]');
    node!.focus();
    expect(document.activeElement).toBe(node);
    fireEvent.keyDown(node!, { key: 'Escape' });
    expect(document.activeElement).not.toBe(node);
  });

  it('leaves focus untouched for other keys', () => {
    renderWithModel(CHAIN_MODEL);
    const node = document.querySelector<HTMLElement>('[data-task-id="b-mid"]');
    node!.focus();
    fireEvent.keyDown(node!, { key: 'Enter' });
    expect(document.activeElement).toBe(node);
  });
});
