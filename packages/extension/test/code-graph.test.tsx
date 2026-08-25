// Code graph view tests (todo 12): kind colors, edge-kind filter chips,
// search filtering, neighborhood highlight + impact badge, virtualization
// switch, unsupported banner.
// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { createElement } from 'react';
import {
  EDGE_KINDS,
  colorForKind,
  filterEdges,
  impactCount,
  matchesQuery,
  neighborhoodOf,
  shouldVirtualize,
} from '../src/webview/graph-model';
import { CodeGraphView } from '../src/webview/CodeGraphView';
import type { CodegraphVM } from '../src/shared/protocol';
import { installFlowDomStubs } from './helpers/dom-stubs';

installFlowDomStubs();

const VM: CodegraphVM = {
  product: 'colby',
  hasFts: true,
  nodes: [
    { id: 'n1', label: 'UserService', kind: 'class', file: 'a.ts', line: 1 },
    { id: 'n2', label: 'getUser', kind: 'function', file: 'b.ts', line: 10 },
    { id: 'n3', label: 'helpers', kind: 'module', file: 'c.ts', line: 1 },
    { id: 'n4', label: 'Config', kind: 'interface', file: 'd.ts', line: 4 },
  ],
  edges: [
    { source: 'n2', target: 'n1', kind: 'calls' },
    { source: 'n3', target: 'n2', kind: 'imports' },
    { source: 'n4', target: 'n1', kind: 'references' },
  ],
};

function renderVm(vm: CodegraphVM = VM): void {
  render(createElement(CodeGraphView, { vm }));
}

function counts(): { nodes: number; edges: number } {
  const text = screen.getByTestId('cg-counts').textContent ?? '';
  const nodes = Number(/nodes=(\d+)/.exec(text)?.[1] ?? -1);
  const edges = Number(/edges=(\d+)/.exec(text)?.[1] ?? -1);
  return { nodes, edges };
}

beforeEach(cleanup);

describe('graph-model helpers', () => {
  it('maps known kinds and hashes unknown ones stably', () => {
    expect(colorForKind('class')).toMatch(/var\(|#/);
    expect(colorForKind('definitely-not-a-kind')).toBe(colorForKind('definitely-not-a-kind'));
    expect(colorForKind('x')).not.toBe(colorForKind('y'));
  });

  it('filterEdges keeps enabled kinds plus unknown kinds', () => {
    const on = new Set(['calls']);
    const out = filterEdges(VM.edges ?? [], on);
    expect(out.map((e) => e.kind)).toEqual(['calls']);
    // references is a known kind but disabled → dropped; unknown kinds pass
    const withUnknown = [...(VM.edges ?? []), { source: 'a', target: 'b', kind: 'mystery' }];
    expect(filterEdges(withUnknown, on).some((e) => e.kind === 'mystery')).toBe(true);
  });

  it('matchesQuery hits label/id/file case-insensitively', () => {
    const first = VM.nodes?.[0];
    const second = VM.nodes?.[1];
    if (!first || !second) throw new Error('fixture nodes missing');
    expect(matchesQuery(first, 'userserv')).toBe(true);
    expect(matchesQuery(first, 'b.ts')).toBe(false);
    expect(matchesQuery(second, 'b.ts')).toBe(true);
    expect(matchesQuery(first, '')).toBe(true);
  });

  it('neighborhoodOf returns one-hop nodes + connecting edge indexes', () => {
    const { nodeIds, edgeIdx } = neighborhoodOf(VM.edges ?? [], 'n1');
    expect(nodeIds).toEqual(new Set(['n1', 'n2', 'n4']));
    expect(edgeIdx).toEqual(new Set([0, 2]));
  });

  it('impactCount counts direct dependents (incoming)', () => {
    expect(impactCount(VM.edges ?? [], 'n1')).toBe(2);
    expect(impactCount(VM.edges ?? [], 'n3')).toBe(0);
  });

  it('virtualizes only beyond 500 nodes', () => {
    expect(shouldVirtualize(500)).toBe(false);
    expect(shouldVirtualize(501)).toBe(true);
  });
});

describe('CodeGraphView', () => {
  it('renders all chips default-on with full counts', () => {
    renderVm();
    for (const k of EDGE_KINDS) {
      expect(screen.getByRole('button', { name: k }).getAttribute('aria-pressed')).toBe('true');
    }
    expect(counts()).toEqual({ nodes: 4, edges: 3 });
  });

  it('toggling a chip reduces the edge count', () => {
    renderVm();
    act(() => fireEvent.click(screen.getByRole('button', { name: 'imports' })));
    expect(screen.getByRole('button', { name: 'imports' }).getAttribute('aria-pressed')).toBe('false');
    expect(counts().edges).toBe(2);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'references' })));
    expect(counts().edges).toBe(1);
  });

  it('search box filters visible nodes by name', () => {
    renderVm();
    act(() => fireEvent.change(screen.getByLabelText('Search nodes by name'), { target: { value: 'user' } }));
    expect(counts().nodes).toBe(2); // UserService + getUser
    act(() => fireEvent.change(screen.getByLabelText('Search nodes by name'), { target: { value: 'zzz-none' } }));
    expect(counts().nodes).toBe(0);
  });

  it('selecting a node shows the impact badge; clicking again clears it', async () => {
    renderVm();
    await act(async () => {
      await Promise.resolve();
    });
    const nodeEl = document.querySelector('.react-flow__node');
    expect(nodeEl).toBeTruthy();
    expect(screen.queryByRole('status', { name: /Impact of/ })).toBeNull();
    act(() => fireEvent.click(nodeEl as Element));
    const badge = screen.getByRole('status', { name: /Impact of/ });
    expect(badge.textContent).toContain('direct dependents');
    act(() => fireEvent.click(nodeEl as Element));
    expect(screen.queryByRole('status', { name: /Impact of/ })).toBeNull();
  });

  it('renders the friendly unsupported banner', () => {
    renderVm({ product: 'unsupported', unsupportedReason: 'Only workspace-local indexes are supported.' });
    expect(screen.getByText('Codegraph unavailable')).toBeTruthy();
    expect(screen.getByText(/workspace-local/)).toBeTruthy();
    expect(document.querySelector('.archgen-banner-unsupported')).toBeTruthy();
  });
});
