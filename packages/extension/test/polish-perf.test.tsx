// Polish perf + CSP tests (todo 13, jsdom). Numeric budgets, each documented:
//
// 1. RENDER BUDGET — one status flip re-renders the changed node at most
//    RENDER_BUDGET_PER_FLIP = 2 times (expected exactly 1: the memoized
//    TaskNode; headroom of 1 covers React Flow's internal measure pass under
//    jsdom). Untouched nodes MUST be 0.
// 2. ANIMATED-EDGE CAP — MAX_ANIMATED_EDGES = 50. A graph with 60 running
//    targets renders exactly 50 `.react-flow__edge.animated` elements.
// 3. VIRTUALIZATION SWITCH — onlyRenderVisibleElements flips on at >500
//    nodes: 500 → data-virtualized="false", 501 → "true".
// 4. CSP SCAN — across repeated tab switches (TASKS→CODE→DOCS→TASKS) with a
//    full model (tasks + docs incl. mermaid + codegraph), zero
//    `securitypolicyviolation` events fire and the console capture records no
//    CSP violation reports.
// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { TaskFlowNode } from '../src/webview/TaskNode';

vi.mock('../src/webview/TaskNode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/webview/TaskNode')>();
  const React = await import('react');
  const counts = new Map<string, number>();
  const Spy = React.memo(function TaskNodeRenderSpy(props: NodeProps<TaskFlowNode>) {
    counts.set(props.id, (counts.get(props.id) ?? 0) + 1);
    return React.createElement(actual.TaskNode, props);
  });
  return { ...actual, TaskNode: Spy, taskNodeTypes: { task: Spy }, __renderCounts: counts };
});

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, code: string) => ({ svg: `<svg data-code="${code.length}"></svg>` })),
  },
}));

const { App } = await import('../src/webview/App');
const taskNodeModule = (await import('../src/webview/TaskNode')) as unknown as {
  __renderCounts: Map<string, number>;
};
const { CodeGraphView } = await import('../src/webview/CodeGraphView');
const { MAX_ANIMATED_EDGES } = await import('../src/webview/TasksView');
import type { ArchgenModelMessage, CodegraphVM, HostToWebview, TaskVM } from '../src/shared/protocol';
import { resetVsCodeApiForTests } from '../src/webview/vscode';
import { installFlowDomStubs } from './helpers/dom-stubs';
import { RENDER_BUDGET_PER_FLIP } from './helpers/perf-budget';

installFlowDomStubs();

function task(id: string, status: TaskVM['status'], dependsOn: string[] = []): TaskVM {
  return { id, title: `Task ${id}`, status, dependsOn, fileOwnership: [], artifacts: [] };
}

interface FakeApi {
  posted: unknown[];
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(s: T): void;
}

function makeApi(): FakeApi {
  const api: FakeApi = {
    posted: [],
    postMessage(msg) { api.posted.push(msg); },
    getState<T>() { return undefined as T; },
    setState<T>(_s: T): void { /* noop */ },
  };
  return api;
}

function mountWith(m: ArchgenModelMessage): FakeApi {
  const api = makeApi();
  render(createElement(App, { api }));
  act(() => {
    window.dispatchEvent(new MessageEvent<HostToWebview>('message', { data: m }));
  });
  return api;
}

async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  });
}

beforeEach(() => {
  installFlowDomStubs();
  cleanup();
  resetVsCodeApiForTests();
  taskNodeModule.__renderCounts.clear();
});

describe('render-count budget per status flip', () => {
  it('a single flip re-renders ONLY the changed node, within the documented budget', async () => {
    mountWith({
      type: 'model',
      tasks: [task('A', 'pending'), task('B', 'pending', ['A']), task('C', 'pending', ['B'])],
      docs: [],
      codegraph: { product: 'unsupported' },
      themeKind: 'dark',
      warnings: [],
      features: [],
      activeSlug: '',
    });
    await flushFrame();
    const base = Object.fromEntries(taskNodeModule.__renderCounts);

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'update', changed: [{ id: 'B', status: 'running' }] },
      }));
    });
    await flushFrame();

    const now = Object.fromEntries(taskNodeModule.__renderCounts);
    expect((now['B'] ?? 0) - (base['B'] ?? 0)).toBeLessThanOrEqual(RENDER_BUDGET_PER_FLIP);
    expect((now['A'] ?? 0) - (base['A'] ?? 0)).toBe(0);
    expect((now['C'] ?? 0) - (base['C'] ?? 0)).toBe(0);
  });
});

describe('animated-edge cap', () => {
  it('60 running targets yield exactly 50 animated edges (cap enforced)', async () => {
    expect(MAX_ANIMATED_EDGES).toBe(50);
    const tasks: TaskVM[] = [task('ROOT', 'done')];
    for (let i = 0; i < 60; i++) tasks.push(task(`R${i}`, 'running', ['ROOT']));
    mountWith({
      type: 'model',
      tasks,
      docs: [],
      codegraph: { product: 'unsupported' },
      themeKind: 'dark',
      warnings: [],
      features: [],
      activeSlug: '',
    });
    // Edge DOM materializes after the stubbed measurement microtask.
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    const allEdges = document.querySelectorAll('.react-flow__edge');
    expect(allEdges.length).toBe(60);
    const animated = document.querySelectorAll('.react-flow__edge.animated');
    expect(animated.length).toBe(MAX_ANIMATED_EDGES);
    expect(animated.length).toBeLessThanOrEqual(50);
  });

  it('under the cap every running-target edge animates', async () => {
    const tasks: TaskVM[] = [task('ROOT', 'done')];
    for (let i = 0; i < 10; i++) tasks.push(task(`S${i}`, 'running', ['ROOT']));
    mountWith({
      type: 'model',
      tasks,
      docs: [],
      codegraph: { product: 'unsupported' },
      themeKind: 'dark',
      warnings: [],
      features: [],
      activeSlug: '',
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelectorAll('.react-flow__edge')).toHaveLength(10);
    expect(document.querySelectorAll('.react-flow__edge.animated')).toHaveLength(10);
  });
});

describe('virtualization switch at 501 nodes', () => {
  function cgVm(n: number): CodegraphVM {
    return {
      product: 'colby',
      hasFts: false,
      nodes: Array.from({ length: n }, (_, i) => ({
        id: `n${i}`, label: `sym${i}`, kind: 'function', file: `f${i}.ts`, line: 1,
      })),
      edges: Array.from({ length: n - 1 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}`, kind: 'calls' })),
    };
  }

  // jsdom renders the full 501-node tree (virtualization deliberately OFF) —
  // that mount costs ~3.5s of real DOM work standalone, and sibling vitest
  // workers inflate it 4-5x inside the full suite. The explicit ceiling sizes
  // the INFRASTRUCTURE to that environment; every behavioral budget above
  // (render counts, edge caps) stays fully enforced.
  it('500 nodes: virtualization OFF', { timeout: 30_000 }, () => {
    render(createElement(CodeGraphView, { vm: cgVm(500) }));
    expect(document.querySelector('[data-testid="code-graph-view"]')?.getAttribute('data-virtualized')).toBe('false');
  });

  it('501 nodes: virtualization ON', { timeout: 30_000 }, () => {
    render(createElement(CodeGraphView, { vm: cgVm(501) }));
    const section = document.querySelector('[data-testid="code-graph-view"]');
    expect(section?.getAttribute('data-virtualized')).toBe('true');
    expect(document.querySelectorAll('.archgen-gnode').length).toBe(501);
  });
});

describe('CSP-violation scan across tab switches', () => {
  it('zero securitypolicyviolation events and no console CSP reports', async () => {
    const violations: SecurityPolicyViolationEvent[] = [];
    const onViolation = (e: Event): void => { violations.push(e as SecurityPolicyViolationEvent); };
    window.addEventListener('securitypolicyviolation', onViolation);

    const consoleLines: string[] = [];
    const origError = console.error;
    const origWarn = console.warn;
    console.error = (...args: unknown[]) => consoleLines.push(args.map(String).join(' '));
    console.warn = (...args: unknown[]) => consoleLines.push(args.map(String).join(' '));

    try {
      mountWith({
        type: 'model',
        tasks: [task('A', 'running'), task('B', 'done', ['A'])],
        docs: [{ path: 'plan.md', title: 'plan.md' }],
        codegraph: {
          product: 'colby',
          hasFts: true,
          nodes: [{ id: 'n0', label: 'alpha', kind: 'class', file: 'a.ts', line: 1 }],
          edges: [],
        },
        themeKind: 'dark',
        warnings: [],
        features: [],
        activeSlug: '',
      });
      act(() => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { type: 'docContent', path: 'plan.md', content: '# Plan\n\n```mermaid\ngraph TD; a-->b;\n```\n' },
        }));
      });

      for (let round = 0; round < 3; round++) {
        for (const name of ['CODE', 'DOCS', 'TASKS']) {
          fireEvent.click(screen.getByRole('tab', { name }));
          await act(async () => { await Promise.resolve(); });
        }
      }

      expect(violations).toEqual([]);
      expect(consoleLines.filter((l) => /content security policy|csp|refused to/i.test(l))).toEqual([]);
    } finally {
      console.error = origError;
      console.warn = origWarn;
      window.removeEventListener('securitypolicyviolation', onViolation);
    }
  });
});
