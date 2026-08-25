// dag-filter-perf.test.tsx — filter-toggle render budgets (jsdom).
//
// Mirrors test/polish-perf.test.tsx spy patterns. Proves the status-filter
// chips do NOT fight the per-id node object cache:
//
// 1. Activating a filter that matches EVERY mounted node changes no node's
//    visibility → every TaskNode keeps its previous object identity →
//    ZERO re-renders across the whole canvas.
// 2. Activating a filter that hides some nodes re-renders none of the
//    still-visible untouched nodes (0 delta); hidden nodes leave the DOM
//    without extra renders; restoring them remounts within
//    RENDER_BUDGET_ON_REMOUNT.
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

const { App } = await import('../src/webview/App');
const taskNodeModule = (await import('../src/webview/TaskNode')) as unknown as {
  __renderCounts: Map<string, number>;
};
import type { ArchgenModelMessage, TaskVM } from '../src/shared/protocol';
import { resetVsCodeApiForTests } from '../src/webview/vscode';
import { installFlowDomStubs } from './helpers/dom-stubs';
import { RENDER_BUDGET_ON_REMOUNT } from './helpers/perf-budget';

installFlowDomStubs();

function task(id: string, status: TaskVM['status'], dependsOn: string[] = []): TaskVM {
  return { id, title: `Task ${id}`, status, dependsOn, fileOwnership: [], artifacts: [] };
}

function model(tasks: TaskVM[]): ArchgenModelMessage {
  return {
    type: 'model',
    tasks,
    docs: [],
    codegraph: { product: 'unsupported' },
    themeKind: 'dark',
    warnings: [],
    features: [],
    activeSlug: '',
  };
}

interface FakeApi {
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(s: T): void;
}

function makeApi(): FakeApi {
  const api: FakeApi = {
    postMessage() { /* not asserted here */ },
    getState<T>() { return undefined as T; },
    setState<T>(_s: T): void { /* noop */ },
  };
  return api;
}

function mountWith(m: ArchgenModelMessage): void {
  render(createElement(App, { api: makeApi() }));
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: m }));
  });
}

async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  });
}

function deltasSince(base: Record<string, number>): Record<string, number> {
  const now = Object.fromEntries(taskNodeModule.__renderCounts);
  const ids = new Set([...Object.keys(base), ...Object.keys(now)]);
  return Object.fromEntries([...ids].map((id) => [id, (now[id] ?? 0) - (base[id] ?? 0)]));
}

beforeEach(() => {
  installFlowDomStubs();
  cleanup();
  resetVsCodeApiForTests();
  taskNodeModule.__renderCounts.clear();
});

describe('filter-toggle render budget', () => {
  it('a filter matching every visible node re-renders NOTHING', async () => {
    mountWith(model([task('A', 'pending'), task('B', 'pending', ['A']), task('C', 'pending', ['B'])]));
    await flushFrame();
    const base = Object.fromEntries(taskNodeModule.__renderCounts);

    fireEvent.click(screen.getByRole('button', { name: 'Filter pending tasks (3)' }));
    await flushFrame();

    expect(deltasSince(base)).toEqual({ A: 0, B: 0, C: 0 });
    // Nothing was hidden either — the board is unchanged on screen.
    expect(document.querySelectorAll('.archgen-tasknode')).toHaveLength(3);
  });

  it('hiding nodes leaves untouched visible nodes at ZERO delta; restore remounts within budget', async () => {
    mountWith(model([task('A', 'done'), task('B', 'pending', ['A']), task('C', 'pending', ['B'])]));
    await flushFrame();
    const base = Object.fromEntries(taskNodeModule.__renderCounts);

    fireEvent.click(screen.getByRole('button', { name: 'Filter done tasks (1)' }));
    await flushFrame();

    const whileFiltered = deltasSince(base);
    expect(whileFiltered['A']).toBe(0);
    expect(document.querySelector('[data-task-id="A"]')).toBeTruthy();
    expect(document.querySelector('[data-task-id="B"]')).toBeNull();
    expect(document.querySelector('[data-task-id="C"]')).toBeNull();
    // Orphaned edge A->B hides with its endpoints.
    expect(document.querySelector('[data-id="A->B"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show all tasks' }));
    await flushFrame();

    const afterRestore = deltasSince(base);
    expect(afterRestore['A']).toBe(0);
    expect(afterRestore['B'] ?? 0).toBeLessThanOrEqual(RENDER_BUDGET_ON_REMOUNT);
    expect(afterRestore['C'] ?? 0).toBeLessThanOrEqual(RENDER_BUDGET_ON_REMOUNT);
    expect(document.querySelectorAll('.archgen-tasknode')).toHaveLength(3);
    expect(document.querySelector('[data-id="A->B"]')).toBeTruthy();
  });
});
