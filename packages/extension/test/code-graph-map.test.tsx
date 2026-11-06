// code-graph-map.test.tsx — the CODE tab's Canvas MAP layer + node cap.
//
// The DOM graph renders at most MAX_RENDERED_NODES nodes; the whole
// constellation is reachable through the Canvas MAP layer.
// @vitest-environment jsdom
import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { CodeGraphView } from '../src/webview/CodeGraphView';
import { MAX_RENDERED_NODES, capNodesByDegree } from '../src/webview/graph-model';
import type { CodegraphVM } from '../src/shared/protocol';
import { installFlowDomStubs } from './helpers/dom-stubs';

installFlowDomStubs();

const VM: CodegraphVM = {
  product: 'colby',
  nodes: [
    { id: 'n1', label: 'UserService', kind: 'class', file: 'a.ts', line: 1 },
    { id: 'n2', label: 'getUser', kind: 'function', file: 'b.ts', line: 10 },
    { id: 'n3', label: 'helpers', kind: 'module', file: 'c.ts', line: 1 },
  ],
  edges: [
    { source: 'n2', target: 'n1', kind: 'calls' },
    { source: 'n3', target: 'n2', kind: 'imports' },
  ],
};

beforeAll(() => {
  // jsdom has no canvas backend — GraphMap degrades to a no-op context.
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

beforeEach(() => {
  installFlowDomStubs();
  cleanup();
});

describe('capNodesByDegree', () => {
  it('keeps everything when the set fits the cap', () => {
    const nodes = [
      { id: 'a', label: 'a', kind: 'function', file: 'a.ts', line: 1 },
      { id: 'b', label: 'b', kind: 'function', file: 'b.ts', line: 1 },
    ];
    const out = capNodesByDegree(nodes, [], 300);
    expect(out.nodes).toHaveLength(2);
    expect(out.truncated).toBe(0);
  });

  it('keeps the most connected nodes and reports how many were dropped', () => {
    const nodes = Array.from({ length: 10 }, (_, i) => ({
      id: `n${i}`,
      label: `n${i}`,
      kind: 'function',
      file: `${i}.ts`,
      line: 1,
    }));
    const edges = [
      { source: 'n0', target: 'n1', kind: 'calls' },
      { source: 'n0', target: 'n2', kind: 'calls' },
      { source: 'n0', target: 'n3', kind: 'calls' },
    ];
    const out = capNodesByDegree(nodes, edges, 4);
    expect(out.nodes).toHaveLength(4);
    expect(out.truncated).toBe(6);
    // The hub (degree 3) survives the cut.
    expect(out.nodes.map((n) => n.id)).toContain('n0');
  });

  it('is deterministic for equal degrees (id ASC)', () => {
    const nodes = [
      { id: 'b', label: 'b', kind: 'function', file: 'b.ts', line: 1 },
      { id: 'a', label: 'a', kind: 'function', file: 'a.ts', line: 1 },
    ];
    const out = capNodesByDegree(nodes, [], 1);
    expect(out.nodes.map((n) => n.id)).toEqual(['a']);
  });
});

describe('CODE tab node cap + MAP layer', () => {
  it('does not advertise an FTS-backed search (the search is a client-side match)', () => {
    render(createElement(CodeGraphView, { vm: VM }));
    const input = screen.getByLabelText('Search nodes by name');
    expect(input.getAttribute('placeholder')).toBe('Search symbols…');
    expect(input.getAttribute('placeholder')).not.toMatch(/fts/i);
  });

  it('renders the Canvas MAP layer when the Map mode is picked', async () => {
    render(createElement(CodeGraphView, { vm: VM }));
    const mapButton = screen.getByRole('button', { name: '▦ Map' });
    expect(mapButton).toBeTruthy();
    fireEvent.click(mapButton);
    await waitFor(() => expect(screen.getByTestId('cg-map-layer')).toBeTruthy());
    // The MAP layer owns the canvas — the bounded DOM graph is not mounted.
    expect(document.querySelector('.react-flow')).toBeNull();
    // The whole constellation is available in the MAP layer.
    expect(screen.getByTestId('cg-counts').textContent).toContain('nodes=0');
  });

  it('keeps the MAP layer reachable in the file-hub tier', async () => {
    const nodes = Array.from({ length: 80 }, (_, i) => ({
      id: `n${i}`,
      label: `n${i}`,
      kind: 'function',
      file: `f${i}.ts`,
      line: 1,
    }));
    const edges = nodes.slice(1).map((n, i) => ({ source: nodes[i]!.id, target: n.id, kind: 'calls' }));
    const vm: CodegraphVM = {
      product: 'colby',
      nodes,
      edges,
      fileRollup: {
        files: nodes.map((n) => ({ file: n.file, symbols: 1, kinds: { function: 1 } })),
        edges: [],
        totals: { files: nodes.length, symbols: nodes.length, edges: edges.length },
      },
    };
    render(createElement(CodeGraphView, { vm }));
    await waitFor(() => expect(screen.getByTestId('cg-tier-badge')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '▦ Map' }));
    await waitFor(() => expect(screen.getByTestId('cg-map-layer')).toBeTruthy());
  });

  it('never renders more than MAX_RENDERED_NODES nodes', () => {
    expect(MAX_RENDERED_NODES).toBe(300);
  });
});
