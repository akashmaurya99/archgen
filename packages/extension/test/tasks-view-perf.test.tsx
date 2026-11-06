// tasks-view-perf.test.ts — the TASKS canvas memo/perf contract.
//
//   - M9: the per-task node cache is pruned when ids leave the board,
//   - M10: the dagre layout runs on the STRUCTURAL signature only — a
//     status-only model push must not re-run the layout.
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { createElement } from 'react';
import { StatusStore } from '../src/host/store';
import { TasksView, pruneNodeCache } from '../src/webview/TasksView';
import type { TaskFlowNode } from '../src/webview/TaskNode';
import type { TaskVM } from '../src/shared/protocol';
import { installFlowDomStubs } from './helpers/dom-stubs';

// Count the dagre passes: the layout module is the ONLY place that runs dagre
// for the TASKS canvas.
vi.mock('../src/webview/layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/webview/layout')>();
  return { ...actual, layoutLeftToRight: vi.fn(actual.layoutLeftToRight) };
});

import { layoutLeftToRight } from '../src/webview/layout';

installFlowDomStubs();

function task(id: string, status: TaskVM['status'] = 'pending', dependsOn: string[] = []): TaskVM {
  return { id, title: `Task ${id}`, status, dependsOn, fileOwnership: [], artifacts: [] };
}

beforeEach(() => {
  installFlowDomStubs();
  cleanup();
  vi.mocked(layoutLeftToRight).mockClear();
});

describe('TasksView layout memoization (M10)', () => {
  it('does NOT re-run dagre when only a task status changed', () => {
    const tasks = [task('A'), task('B', 'pending', ['A'])];
    const store = new StatusStore<TaskVM>(tasks);
    const view = render(createElement(TasksView, { tasks, store }));
    const callsAfterMount = vi.mocked(layoutLeftToRight).mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    // A status-only push: same ids, same dependencies, new array identity.
    const next = [task('A', 'running'), task('B', 'pending', ['A'])];
    act(() => {
      store.applyBatch([{ id: 'A', status: 'running' }]);
      view.rerender(createElement(TasksView, { tasks: next, store }));
    });

    expect(vi.mocked(layoutLeftToRight).mock.calls.length).toBe(callsAfterMount);
  });

  it('re-runs the layout when the STRUCTURE changed', () => {
    const tasks = [task('A'), task('B', 'pending', ['A'])];
    const store = new StatusStore<TaskVM>(tasks);
    const view = render(createElement(TasksView, { tasks, store }));
    const callsAfterMount = vi.mocked(layoutLeftToRight).mock.calls.length;

    const next = [task('A'), task('B', 'pending', ['A']), task('C', 'pending', ['B'])];
    act(() => {
      view.rerender(createElement(TasksView, { tasks: next, store }));
    });

    expect(vi.mocked(layoutLeftToRight).mock.calls.length).toBeGreaterThan(callsAfterMount);
  });
});

describe('TasksView node-cache pruning (M9)', () => {
  it('drops cached nodes for ids that left the board', () => {
    const cache = new Map<string, TaskFlowNode>([
      ['A', { id: 'A', type: 'task', position: { x: 0, y: 0 }, data: { label: 'A', status: 'pending' } } as TaskFlowNode],
      ['B', { id: 'B', type: 'task', position: { x: 0, y: 0 }, data: { label: 'B', status: 'pending' } } as TaskFlowNode],
    ]);
    pruneNodeCache(cache, new Set(['A']));
    expect(cache.has('A')).toBe(true);
    expect(cache.has('B')).toBe(false);
  });

  it('drops the removed node from the rendered board too', () => {
    const tasks = [task('A'), task('B')];
    const store = new StatusStore<TaskVM>(tasks);
    const view = render(createElement(TasksView, { tasks, store }));
    expect(document.querySelectorAll('[data-task-id]').length).toBe(2);

    // The board swaps to a different feature: only 'A' remains.
    const next = [task('A')];
    act(() => {
      view.rerender(createElement(TasksView, { tasks: next, store }));
    });
    expect(document.querySelectorAll('[data-task-id]').length).toBe(1);
    expect(document.querySelector('[data-task-id="B"]')).toBeNull();
  });
});
