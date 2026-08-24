// Webview shell smoke tests (jsdom): tabs, states, acquireVsCodeApi-once,
// setState/getState persistence, message intake.
// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { createElement } from 'react';
import { App } from '../src/webview/App';
import type { ArchgenModelMessage, HostToWebview } from '../src/shared/protocol';
import { resetVsCodeApiForTests } from '../src/webview/vscode';

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

const MODEL: ArchgenModelMessage = {
  type: 'model',
  tasks: [
    { id: 'C', title: 'Root', status: 'done', dependsOn: [], fileOwnership: ['a/**'], artifacts: [] },
    { id: 'B', title: 'Mid', status: 'running', dependsOn: ['C'], fileOwnership: ['b/**'], artifacts: [] },
  ],
  docs: [{ path: 'plans/demo.md', title: 'demo.md' }],
  codegraph: { product: 'unsupported', unsupportedReason: 'No .codegraph/ index found in this workspace.' },
  themeKind: 'dark',
  warnings: [],
};

function lastPosted(api: FakeApi): HostToWebview {
  return api.posted[api.posted.length - 1] as HostToWebview;
}

beforeEach(() => {
  cleanup();
  resetVsCodeApiForTests();
});

describe('App shell', () => {
  it('posts ready handshake on mount and shows loading until model arrives', async () => {
    const api = makeApi();
    const { rerender } = render(createElement(App, { api }));
    expect(lastPosted(api)).toEqual({ type: 'ready' });
    expect(screen.getByRole('status')).toBeTruthy();

    // Simulate host pushing the model through the message channel.
    act(() => {
      const evt = new MessageEvent<HostToWebview>('message', { data: MODEL });
      window.dispatchEvent(evt);
    });
    rerender(createElement(App, { api }));
    expect(await screen.findByTestId('archgen-root')).toBeTruthy();
    expect(screen.getByText('B')).toBeTruthy();
  });

  it('renders TASKS | CODE | DOCS tabs and persists selection via setState', () => {
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: MODEL }));
    });

    fireEvent.click(screen.getByRole('tab', { name: 'CODE' }));
    expect(api.state).toEqual({ tab: 'CODE' });
    expect(screen.getByRole('tab', { name: 'CODE' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/Codegraph unavailable/i)).toBeTruthy();
    expect(MODEL.codegraph.unsupportedReason).toBeTruthy();
    expect(screen.getByText(/No \.codegraph\/ index found/)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'DOCS' }));
    expect(api.state).toEqual({ tab: 'DOCS' });
    expect(screen.getByRole('button', { name: 'demo.md' })).toBeTruthy();
  });

  it('shows empty state when model has no content', () => {
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { ...MODEL, tasks: [], docs: [] },
      }));
    });
    expect(screen.getByText(/No ArchGen plan found/i)).toBeTruthy();
  });

  it('surfaces error status messages via alert banner and dismisses', () => {
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: MODEL }));
    });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'status', kind: 'error', message: 'tasks.yaml unreadable: boom' },
      }));
    });
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('boom');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('applies update diffs without replacing the whole model', () => {
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: MODEL }));
    });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'update', changed: [{ id: 'B', status: 'failed' }] },
      }));
    });
    const chip = document.querySelector('[data-task-id="B"] [data-status]');
    expect(chip?.getAttribute('data-status')).toBe('failed');
    // untouched task keeps its status
    const chipC = document.querySelector('[data-task-id="C"] [data-status]');
    expect(chipC?.getAttribute('data-status')).toBe('done');
  });

  it('theme message flips the data-theme attribute', () => {
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'theme', themeKind: 'light' } }));
    });
    expect(document.documentElement.dataset['theme']).toBe('light');
  });
});
