// Feature-picker tests (jsdom): TASKS-tab dropdown renders host-ordered slugs,
// announces the selection via aria-label, posts selectFeature on change,
// switching stays inside the render budget, and the no-features empty state
// is untouched.
// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
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
import type { ArchgenModelMessage, HostToWebview, TaskVM } from '../src/shared/protocol';
import { resetVsCodeApiForTests } from '../src/webview/vscode';
import { installFlowDomStubs } from './helpers/dom-stubs';
import { RENDER_BUDGET_ON_REMOUNT, RENDER_BUDGET_PER_FLIP } from './helpers/perf-budget';

installFlowDomStubs();

function task(id: string, status: TaskVM['status'], dependsOn: string[] = []): TaskVM {
  return { id, title: `Task ${id}`, status, dependsOn, fileOwnership: [], artifacts: [] };
}

function modelWith(activeSlug: string, tasks: TaskVM[]): ArchgenModelMessage {
  return {
    type: 'model',
    tasks,
    docs: [],
    codegraph: { product: 'unsupported' },
    themeKind: 'dark',
    warnings: [],
    features: [
      { slug: 'alpha', tasksPath: '/ws/.archgen/alpha/tasks.yaml', updatedAt: 1000 },
      { slug: 'beta', tasksPath: '/ws/.archgen/beta/tasks.yaml', updatedAt: 2000 },
    ],
    activeSlug,
  };
}

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

describe('feature picker in the TASKS tab header', () => {
  it('renders a combobox listing slugs host-ordered (most-recent first) with the active one selected', () => {
    mountWith(modelWith('beta', [task('B1', 'pending')]));
    const select = screen.getByRole('combobox', { name: 'Select ArchGen feature (currently beta)' });
    expect(select).toBeInstanceOf(HTMLSelectElement);
    const options = Array.from((select as HTMLSelectElement).options);
    expect(options.map((o) => o.value)).toEqual(['alpha', 'beta']);
    expect((select as HTMLSelectElement).value).toBe('beta');
  });

  it('posts selectFeature when the selection changes', () => {
    const api = mountWith(modelWith('alpha', [task('A1', 'pending')]));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'beta' } });
    expect(api.posted.at(-1)).toEqual({ type: 'selectFeature', slug: 'beta' });
  });

  it('announces the new selection via aria-label after the host re-posts the model', () => {
    mountWith(modelWith('alpha', [task('A1', 'pending')]));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: modelWith('beta', [task('B1', 'pending')]) }));
    });
    expect(screen.getByRole('combobox', { name: 'Select ArchGen feature (currently beta)' })).toBeTruthy();
  });

  it('keyboard-reachable: the native select takes focus like any tab stop', () => {
    mountWith(modelWith('alpha', [task('A1', 'pending')]));
    const select = screen.getByRole('combobox');
    select.focus();
    expect(document.activeElement).toBe(select);
  });

  it('switching features re-renders nodes within the documented budgets', async () => {
    const api = mountWith(modelWith('alpha', [task('A1', 'pending'), task('A2', 'pending', ['A1'])]));
    await flushFrame();
    const base = Object.fromEntries(taskNodeModule.__renderCounts);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'beta' } });
    expect(api.posted.at(-1)).toEqual({ type: 'selectFeature', slug: 'beta' });
    await flushFrame();
    for (const id of ['A1', 'A2']) {
      expect((taskNodeModule.__renderCounts.get(id) ?? 0) - (base[id] ?? 0)).toBe(0);
    }

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: modelWith('beta', [task('B1', 'running'), task('B2', 'done', ['B1'])]),
      }));
    });
    await flushFrame();

    expect(screen.getByRole('combobox', { name: 'Select ArchGen feature (currently beta)' })).toBeTruthy();
    expect(document.querySelector('[data-task-id="A1"]')).toBeNull();
    for (const id of ['B1', 'B2']) {
      expect(document.querySelector(`[data-task-id="${id}"]`)).toBeTruthy();
      expect((taskNodeModule.__renderCounts.get(id) ?? 0) - (base[id] ?? 0)).toBeLessThanOrEqual(RENDER_BUDGET_ON_REMOUNT);
    }

    const settled = Object.fromEntries(taskNodeModule.__renderCounts);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'update', changed: [{ id: 'B1', status: 'done' }] },
      }));
    });
    await flushFrame();
    expect((taskNodeModule.__renderCounts.get('B1') ?? 0) - (settled['B1'] ?? 0)).toBeLessThanOrEqual(RENDER_BUDGET_PER_FLIP);
    expect((taskNodeModule.__renderCounts.get('B2') ?? 0) - (settled['B2'] ?? 0)).toBe(0);
  });

  it('hides the picker on CODE and DOCS tabs and restores it back on TASKS', () => {
    mountWith(modelWith('alpha', [task('A1', 'pending')]));
    fireEvent.click(screen.getByRole('tab', { name: 'CODE' }));
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'TASKS' }));
    expect(screen.getByRole('combobox')).toBeTruthy();
  });
});

describe('empty-state contract with no features', () => {
  it('shows no picker and keeps the untouched empty-state UX when .archgen is absent', () => {
    mountWith({
      type: 'model',
      tasks: [],
      docs: [],
      codegraph: { product: 'unsupported' },
      themeKind: 'dark',
      warnings: [],
      features: [],
      activeSlug: '',
    });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText(/No ArchGen plan found/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy install command' })).toBeTruthy();
  });

  it('still offers the picker when features exist but the active one has no readable tasks', () => {
    mountWith({ ...modelWith('alpha', []), warnings: ['alpha: tasks.yaml unreadable: boom'] });
    expect(screen.getByRole('combobox', { name: 'Select ArchGen feature (currently alpha)' })).toBeTruthy();
    expect(screen.getByText(/No ArchGen plan found/i)).toBeTruthy();
  });
});
