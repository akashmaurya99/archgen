// Polish a11y + state tests (todo 13, jsdom):
// - node aria-label contract `task <id>: <title>, status <status>`
// - keyboard: every node in tab order; Enter/Space on focused node dispatches build
// - empty state: 'run archgen generate' hint + copyable install command
// - error state: last-good graph stays mounted (dimmed class) + dismissible banner
// - stale-data chip renders "updated Ns ago"
// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { createElement } from 'react';
import { App } from '../src/webview/App';
import { INSTALL_COMMAND, formatDataAge } from '../src/webview/states';
import type { ArchgenModelMessage, HostToWebview } from '../src/shared/protocol';
import { resetVsCodeApiForTests } from '../src/webview/vscode';
import { installFlowDomStubs } from './helpers/dom-stubs';

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
  it('shows the archgen generate hint with a copyable install command', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { ...MODEL, tasks: [], docs: [] } }));
    });
    expect(screen.getAllByText(/archgen generate/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Copy install command' }));
    await act(async () => { await Promise.resolve(); });
    expect(writeText).toHaveBeenCalledWith(INSTALL_COMMAND);
    expect(INSTALL_COMMAND).toContain('archgen generate');
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
