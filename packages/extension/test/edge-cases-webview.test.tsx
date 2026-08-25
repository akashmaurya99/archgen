// Webview edge cases: graph-model incoming-edge neighborhood, states defaults,
// EmptyState clipboard fallback, App DOCS-tab branch.
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { createElement } from 'react';
import { neighborhoodOf, impactCount, matchesQuery } from '../src/webview/graph-model';
import { StatusChip, LoadingState, EmptyState, ErrorBanner, useTabState } from '../src/webview/states';
import { App } from '../src/webview/App';
import type { ArchgenModelMessage, HostToWebview } from '../src/shared/protocol';
import { resetVsCodeApiForTests } from '../src/webview/vscode';
import { installFlowDomStubs } from './helpers/dom-stubs';

beforeEach(() => {
  installFlowDomStubs();
  cleanup();
  resetVsCodeApiForTests();
});

describe('graph-model edge cases', () => {
  it('neighborhoodOf includes UPSTREAM nodes when id is an edge target', () => {
    const edges = [
      { source: 'a', target: 'b', kind: 'calls' },
      { source: 'b', target: 'c', kind: 'imports' },
      { source: 'z', target: 'z2', kind: 'references' },
    ];
    const { nodeIds, edgeIdx } = neighborhoodOf(edges, 'b');
    expect(nodeIds.has('a')).toBe(true);
    expect(nodeIds.has('c')).toBe(true);
    expect(nodeIds.has('z')).toBe(false);
    expect(edgeIdx.size).toBe(2);
    expect(impactCount(edges, 'b')).toBe(1);
    expect(impactCount(edges, 'nope')).toBe(0);
  });

  it('matchesQuery is case-insensitive across label/id/file and trims the query', () => {
    const n = { id: 'X1', label: 'UserService', kind: 'class', file: 'src/u.ts', line: 1 };
    expect(matchesQuery(n, '  userservice ')).toBe(true);
    expect(matchesQuery(n, 'x1')).toBe(true);
    expect(matchesQuery(n, 'missing')).toBe(false);
  });
});

describe('states edge cases', () => {
  it('StatusChip renders every status with its data attribute', () => {
    for (const s of ['pending', 'done'] as const) {
      const { container, unmount } = render(createElement(StatusChip, { status: s }));
      expect(container.querySelector(`[data-status="${s}"]`)).toBeTruthy();
      unmount();
    }
  });

  it('LoadingState falls back to the default label when none given', () => {
    render(createElement(LoadingState, null));
    expect(screen.getByRole('status').textContent).toContain('Loading ArchGen model');
  });

  it('EmptyState copy CTA still shows feedback when clipboard is unavailable', async () => {
    // jsdom has no navigator.clipboard → optional-chain short-circuit path.
    render(createElement(EmptyState, { hasArchgenFolder: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy install command' }));
    await screen.findByText('Copied!');
  });

  it('EmptyState has-folder variant swaps the message', () => {
    render(createElement(EmptyState, { hasArchgenFolder: true }));
    expect(screen.getByText(/has a/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy install command' })).toBeNull();
  });

  it('ErrorBanner renders nothing without a message; dismiss works with one', () => {
    const { container } = render(createElement(ErrorBanner, { message: null }));
    expect(container.textContent).toBe('');
    const onDismiss = vi.fn();
    render(createElement(ErrorBanner, { message: 'boom', onDismiss }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('useTabState defaults to TASKS when no initial value is passed', () => {
    function Probe(): React.ReactElement {
      const [tab, setTab] = useTabState();
      return createElement('button', { onClick: (): void => setTab('CODE') }, tab);
    }
    render(createElement(Probe, null));
    expect(screen.getByRole('button').textContent).toBe('TASKS');
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button').textContent).toBe('CODE');
  });
});

describe('App DOCS tab branch', () => {
  it('renders DocsView content when the DOCS tab is selected', async () => {
    interface FakeApi {
      posted: unknown[];
      state: Record<string, unknown>;
      postMessage(msg: unknown): void;
      getState<T>(): T | undefined;
      setState<T>(s: T): void;
    }
    const api: FakeApi = {
      posted: [],
      state: {},
      postMessage(msg) { api.posted.push(msg); },
      getState<T>() { return api.state as T; },
      setState<T>(s: T) { api.state = s as Record<string, unknown>; },
    };
    const MODEL: ArchgenModelMessage = {
      type: 'model',
      tasks: [],
      docs: [{ path: 'plans/demo.md', title: 'demo.md' }],
      codegraph: { product: 'unsupported', unsupportedReason: 'none' },
      themeKind: 'dark',
      warnings: [],
      features: [],
      activeSlug: '',
    };
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent<HostToWebview>('message', { data: MODEL }));
    });
    fireEvent.click(screen.getByRole('tab', { name: 'DOCS' }));
    expect(screen.getAllByText(/demo\.md/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Select a document/)).toBeTruthy();
    expect(api.posted.some((m) => (m as { type?: string }).type === 'ready')).toBe(true);
  });
});
