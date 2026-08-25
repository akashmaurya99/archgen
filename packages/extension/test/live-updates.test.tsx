// Live status flow tests (todo 10, jsdom): watcher diffs {type:'update'} →
// store.applyBatch → ONLY changed TaskNode components re-render (render-count
// spy via module mock); fake rAF timers prove ≤1 flush per burst within the
// 16ms frame budget.
// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { createElement } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { TaskFlowNode } from '../src/webview/TaskNode';
import { App } from '../src/webview/App';
import { resetVsCodeApiForTests } from '../src/webview/vscode';
import { installFlowDomStubs } from './helpers/dom-stubs';
import type { ArchgenModelMessage, HostToWebview, TaskVM } from '../src/shared/protocol';

// Wrap the real memoized TaskNode in an equally-memoized spy: identical node
// objects (untouched tasks) skip BOTH memos ⇒ zero count increments.
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

const taskNodeModule = (await import('../src/webview/TaskNode')) as unknown as {
  __renderCounts: Map<string, number>;
};

installFlowDomStubs();

function task(id: string, status: TaskVM['status'], dependsOn: string[] = []): TaskVM {
  return { id, title: `Task ${id}`, status, dependsOn, fileOwnership: [], artifacts: [] };
}

const MODEL: ArchgenModelMessage = {
  type: 'model',
  tasks: [task('A', 'pending'), task('B', 'pending', ['A']), task('C', 'pending', ['B'])],
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

function mount(m: ArchgenModelMessage = MODEL): FakeApi {
  const api = makeApi();
  render(createElement(App, { api }));
  act(() => {
    window.dispatchEvent(new MessageEvent<HostToWebview>('message', { data: m }));
  });
  return api;
}

function sendUpdate(changed: Array<{ id: string; status: TaskVM['status'] }>): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'update', changed } }));
  });
}

/** Wait out the store's rAF flush (jsdom fires rAF ~16ms real time). */
async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  });
}

const countsOf = (): Record<string, number> => Object.fromEntries(taskNodeModule.__renderCounts);

/** Render-count delta vs a baseline — immune to RF's initial measure pass. */
function deltasSince(base: Record<string, number>): Record<string, number> {
  const now = countsOf();
  const out: Record<string, number> = {};
  for (const id of new Set([...Object.keys(base), ...Object.keys(now)])) {
    out[id] = (now[id] ?? 0) - (base[id] ?? 0);
  }
  return out;
}

beforeEach(() => {
  installFlowDomStubs();
  cleanup();
  resetVsCodeApiForTests();
  taskNodeModule.__renderCounts.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('live status flow', () => {
  it('re-renders only changed nodes on update diffs', async () => {
    mount();
    const base = countsOf();

    sendUpdate([{ id: 'B', status: 'running' }]);
    await flushFrame();
    expect(deltasSince(base)).toEqual({ A: 0, B: 1, C: 0 });

    sendUpdate([
      { id: 'A', status: 'done' },
      { id: 'C', status: 'ready' },
    ]);
    await flushFrame();
    expect(deltasSince(base)).toEqual({ A: 1, B: 1, C: 1 });

    // unrelated message (theme) triggers zero node renders
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'theme', themeKind: 'light' } }));
    });
    await flushFrame();
    expect(deltasSince(base)).toEqual({ A: 1, B: 1, C: 1 });
  });

  it('same-value update does not re-render a node', async () => {
    mount();
    const base = countsOf();
    sendUpdate([{ id: 'B', status: 'pending' }]);
    await flushFrame();
    expect(deltasSince(base)).toEqual({ A: 0, B: 0, C: 0 });
  });

  it('100-message burst flushes ONCE inside the 16ms rAF budget', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame'] });
    mount();
    const base = countsOf();

    for (let i = 0; i < 100; i++) {
      const flipTo: TaskVM['status'] = i % 2 === 0 ? 'running' : 'blocked';
      sendUpdate([{ id: i % 3 === 0 ? 'A' : i % 3 === 1 ? 'B' : 'C', status: flipTo }]);
    }
    // nothing flushed mid-burst: batching means zero renders so far
    expect(deltasSince(base)).toEqual({ A: 0, B: 0, C: 0 });

    act(() => { vi.advanceTimersByTime(15); });
    expect(deltasSince(base)).toEqual({ A: 0, B: 0, C: 0 }); // still inside budget

    act(() => { vi.advanceTimersByTime(1); }); // t=16ms: the single flush
    expect(deltasSince(base)).toEqual({ A: 1, B: 1, C: 1 }); // ≤1 flush per burst
  });

  it('statuses survive a full model refresh after updates', async () => {
    mount();
    sendUpdate([{ id: 'B', status: 'failed' }]);
    await flushFrame();
    act(() => {
      window.dispatchEvent(new MessageEvent<HostToWebview>('message', {
        data: { ...MODEL, tasks: MODEL.tasks.map((t) => (t.id === 'B' ? { ...t, status: 'failed' as const } : t)) },
      }));
    });
    expect(document.querySelector('[data-task-id="B"] [data-status]')?.getAttribute('data-status')).toBe('failed');
  });
});
