// Task DAG view tests (jsdom): dagre LR ordering, 6-status class matrix,
// edge animation rules, legend/minimap/controls presence.
// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
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

  it('shows Legend panel top-right, MiniMap and Controls', () => {
    renderWithModel();
    const legend = screen.getByRole('list', { name: 'Status legend' });
    expect(legend.closest('.react-flow__panel.top.right')).toBeTruthy();
    expect(legend.querySelectorAll('[role="listitem"]')).toHaveLength(6);
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
});
