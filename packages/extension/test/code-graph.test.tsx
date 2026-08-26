// Code graph view tests (todo 12 + enterprise explorer upgrade): kind colors,
// edge-kind filter chips WITH live counts, search filtering, transitive
// click-to-highlight (dims non-neighbors, animates neighborhood edges),
// Handles presence (xyflow v12 edge-endpoint contract), tooltips/captions,
// toolbar buttons, virtualization switch, unsupported banner.
// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { createElement } from 'react';
import {
  EDGE_KINDS,
  layoutRadial,
  colorForEdgeKind,
  colorForKind,
  connectedComponentOf,
  edgeKindCounts,
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

// Two DISCONNECTED components + TWO singletons so every multi-canvas
// behavior is observable: c1={a,b,c}, c2={x,y}, unlinked={z,w}. Per-canvas
// isolation means selecting in c1 lights its whole component while sibling
// canvases stay untouched; the shared unlinked bucket still dims internally
// (z and w are not neighbors).
const SPLIT_VM: CodegraphVM = {
  product: 'colby',
  hasFts: false,
  nodes: [
    { id: 'a', label: 'Alpha', kind: 'class', file: 'a.ts', line: 1 },
    { id: 'b', label: 'Beta', kind: 'function', file: 'b.ts', line: 2 },
    { id: 'c', label: 'Gamma', kind: 'module', file: 'c.ts', line: 3 },
    { id: 'x', label: 'Xenon', kind: 'class', file: 'x.ts', line: 7 },
    { id: 'y', label: 'Yankee', kind: 'interface', file: 'y.ts', line: 8 },
    { id: 'z', label: 'Zulu', kind: 'file', file: 'z.ts', line: 9 },
    { id: 'w', label: 'Whiskey', kind: 'variable', file: 'w.ts', line: 10 },
  ],
  edges: [
    { source: 'a', target: 'b', kind: 'calls' },
    { source: 'b', target: 'c', kind: 'imports' },
    { source: 'x', target: 'y', kind: 'references' },
  ],
};

function renderVm(vm: CodegraphVM = VM): void {
  render(createElement(CodeGraphView, { vm }));
}

/** Edge DOM materializes after xyflow's stubbed measurement microtasks —
 *  wait until the rendered edge count STABILIZES so assertions never race
 *  the last measure pass under parallel-worker load. */
async function flushFlow(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  let prev = -1;
  for (let i = 0; i < 20; i++) {
    const current = document.querySelectorAll('.react-flow__edge').length;
    if (current > 0 && current === prev) break;
    prev = current;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

function counts(): { nodes: number; edges: number } {
  const text = screen.getByTestId('cg-counts').textContent ?? '';
  const nodes = Number(/nodes=(\d+)/.exec(text)?.[1] ?? -1);
  const edges = Number(/edges=(\d+)/.exec(text)?.[1] ?? -1);
  return { nodes, edges };
}

function gnodes(): HTMLElement[] {
  return [...document.querySelectorAll('.archgen-gnode')] as HTMLElement[];
}

function dimmedCount(): number {
  return document.querySelectorAll('.archgen-gnode.is-dimmed').length;
}

beforeEach(cleanup);

describe('graph-model helpers', () => {
  it('maps known kinds and hashes unknown ones stably', () => {
    expect(colorForKind('class')).toMatch(/var\(|#/);
    expect(colorForKind('definitely-not-a-kind')).toBe(colorForKind('definitely-not-a-kind'));
    expect(colorForKind('x')).not.toBe(colorForKind('y'));
  });

  it('gives every edge kind a distinct accessible stroke color', () => {
    const colors = EDGE_KINDS.map((k) => colorForEdgeKind(k));
    expect(new Set(colors).size).toBe(EDGE_KINDS.length);
    for (const c of colors) expect(c).toMatch(/^var\(--archgen-cg-edge-/);
    expect(colorForEdgeKind('mystery')).toMatch(/--archgen-cg-edge-other/);
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

  it('connectedComponentOf closes transitively over BOTH directions', () => {
    // chain n3→n2→n1 plus independent-looking n4→n1: from n3 the closure must
    // still reach n4 THROUGH n1's incoming edge (full component, not one hop).
    const comp = connectedComponentOf(VM.edges ?? [], 'n3');
    expect(comp.nodeIds).toEqual(new Set(['n3', 'n2', 'n1', 'n4']));
    expect(comp.edgeIdx).toEqual(new Set([0, 1, 2]));
  });

  it('connectedComponentOf survives cycles and self-loops', () => {
    const cyclic = [
      { source: 'a', target: 'b', kind: 'calls' },
      { source: 'b', target: 'c', kind: 'imports' },
      { source: 'c', target: 'a', kind: 'references' },
      { source: 'd', target: 'd', kind: 'calls' },
    ];
    for (const seed of ['a', 'b', 'c']) {
      const { nodeIds, edgeIdx } = connectedComponentOf(cyclic, seed);
      expect(nodeIds).toEqual(new Set(['a', 'b', 'c']));
      expect(edgeIdx).toEqual(new Set([0, 1, 2]));
    }
    expect(connectedComponentOf(cyclic, 'd')).toEqual({ nodeIds: new Set(['d']), edgeIdx: new Set([3]) });
  });

  it('edgeKindCounts tallies per kind including unknown kinds', () => {
    expect(edgeKindCounts([...(VM.edges ?? []), { source: 'q', target: 'r', kind: 'calls' }])).toEqual({
      calls: 2,
      imports: 1,
      references: 1,
    });
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

describe('CodeGraphView canvas wiring', () => {
  it('renders all chips default-on with live per-kind counts', () => {
    renderVm();
    // fixture has calls×1, imports×1, references×1 — no extends/implements edges
    const expected: Record<string, number> = { calls: 1, imports: 1, references: 1, extends: 0, implements: 0 };
    for (const k of EDGE_KINDS) {
      expect(screen.getByRole('button', { name: `${k} ×${expected[k]}` }).getAttribute('aria-pressed')).toBe('true');
    }
    expect(counts()).toEqual({ nodes: 5, edges: 3 }); // 4 cards + radial ring layer
  });

  it('toggling a chip reduces the edge count but keeps its live count visible', () => {
    renderVm();
    act(() => fireEvent.click(screen.getByRole('button', { name: /^imports ×/ })));
    expect(screen.getByRole('button', { name: /^imports ×/ }).getAttribute('aria-pressed')).toBe('false');
    expect(counts().edges).toBe(2);
    expect(screen.getByRole('button', { name: /^imports ×/ }).textContent).toContain('×1');
    act(() => fireEvent.click(screen.getByRole('button', { name: /^references ×/ })));
    expect(counts().edges).toBe(1);
  });

  it('chip counts react to the search scope (live), not to kind toggles', () => {
    renderVm();
    act(() => fireEvent.change(screen.getByLabelText('Search nodes by name'), { target: { value: 'user' } }));
    // only n1+n2 visible → only their calls edge counts; others zero out
    expect(screen.getByRole('button', { name: 'calls ×1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'imports ×0' })).toBeTruthy();
  });

  it('search box filters visible nodes by name', () => {
    renderVm();
    act(() => fireEvent.change(screen.getByLabelText('Search nodes by name'), { target: { value: 'user' } }));
    expect(counts().nodes).toBe(3); // UserService + getUser + radial ring layer
    act(() => fireEvent.change(screen.getByLabelText('Search nodes by name'), { target: { value: 'zzz-none' } }));
    expect(counts().nodes).toBe(0);
  });

  it('renders Handle anchors for every node — the v12 edge-endpoint contract', async () => {
    renderVm();
    await flushFlow();
    expect(document.querySelectorAll('.archgen-gnode-handle')).toHaveLength(8);
    expect(document.querySelectorAll('.react-flow__node[data-id="__ring"] .archgen-gnode-handle')).toHaveLength(0);
    act(() => fireEvent.click(screen.getByRole('button', { name: '⇥ Flow' })));
    await flushFlow();
    expect(document.querySelectorAll('.archgen-gnode-handle')).toHaveLength(8);
    expect(document.querySelectorAll('.react-flow__handle.react-flow__handle-left')).toHaveLength(4);
    expect(document.querySelectorAll('.react-flow__handle.react-flow__handle-right')).toHaveLength(4);
  });

  it('edges VISIBLY render as path elements wired to both endpoints', async () => {
    renderVm();
    await flushFlow();
    const { appendFileSync } = await import('node:fs');
    appendFileSync('diag.log', `edges=${document.querySelectorAll('.react-flow__edge').length} lod=${document.querySelector('[data-testid="code-graph-view"]')?.getAttribute('data-lod')}\n`);
    expect(document.querySelectorAll('.react-flow__edge')).toHaveLength(3);
    // The actual proof of visibility: SVG path geometry exists per edge.
    expect(document.querySelectorAll('.react-flow__edge-path')).toHaveLength(3);
    for (const kind of ['calls', 'imports', 'references']) {
      expect(document.querySelector(`.react-flow__edge.archgen-edge--${kind}`)).toBeTruthy();
    }
  });

  it('every rendered edge carries an ArrowClosed marker def', async () => {
    renderVm();
    await flushFlow();
    const markers = document.querySelectorAll('marker');
    expect(markers.length).toBeGreaterThanOrEqual(3);
  });

  it('shows tooltip title and file:line caption per node', () => {
    renderVm();
    const first = gnodes()[0];
    if (!first) throw new Error('no gnode rendered');
    expect(first.getAttribute('title')).toBe('UserService\na.ts:1 (class)');
    const captions = [...document.querySelectorAll('.archgen-gnode-caption')].map((el) => el.textContent);
    expect(captions).toContain('a.ts:1');
    expect(captions).toContain('d.ts:4');
  });

  it('offers zoom-to-fit; Clear selection appears only while highlighting', async () => {
    renderVm();
    await flushFlow();
    const fit = screen.getByRole('button', { name: 'Zoom to fit' });
    expect(fit).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear selection' })).toBeNull();

    await act(async () => {
      // a real graph card, not the first .react-flow__node (that's the __ring
      // decoration layer — not selectable since todo 11)
      fireEvent.click(gnodes()[0] as Element);
      await Promise.resolve();
    });
    expect(screen.queryByRole('status', { name: /Impact of/ })).not.toBeNull();
    const clearBtn = screen.getByRole('button', { name: 'Clear selection' });
    act(() => fireEvent.click(clearBtn));
    expect(screen.queryByRole('status', { name: /Impact of/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear selection' })).toBeNull();
  });
});

describe('click-to-highlight (transitive neighborhood isolation)', () => {
  it('selecting a node shows the impact badge; clicking again clears it', async () => {
    renderVm();
    await act(async () => {
      await Promise.resolve();
    });
    // a real graph card, not the first .react-flow__node (that's the __ring
    // decoration layer — not selectable since todo 11)
    const nodeEl = gnodes()[0];
    expect(nodeEl).toBeTruthy();
    expect(screen.queryByRole('status', { name: /Impact of/ })).toBeNull();
    act(() => fireEvent.click(nodeEl as Element));
    const badge = screen.getByRole('status', { name: /Impact of/ });
    expect(badge.textContent).toContain('direct dependents');
    act(() => fireEvent.click(nodeEl as Element));
    expect(screen.queryByRole('status', { name: /Impact of/ })).toBeNull();
  });

  it('highlights the FULL component; everything outside it dims (shared canvas)', async () => {
    renderVm(SPLIT_VM);
    await flushFlow();
    expect(dimmedCount()).toBe(0);

    // Click Alpha (first node of c1): its whole component {a,b,c} lights up…
    await act(async () => {
      fireEvent.click(gnodes()[0] as Element);
      await Promise.resolve();
    });
    await flushFlow();
    const pressed = gnodes().map((el) => el.getAttribute('aria-pressed'));
    expect(pressed).toEqual(['true', 'false', 'false', 'false', 'false', 'false', 'false']);
    // …on the SHARED canvas, every node outside the neighborhood fades —
    // c2={x,y} and the loose singletons z,w alike (focus-mode semantics).
    expect(dimmedCount()).toBe(4);
    expect(gnodes()[3]?.classList.contains('is-dimmed')).toBe(true);
    expect(gnodes()[4]?.classList.contains('is-dimmed')).toBe(true);
    expect(gnodes()[5]?.classList.contains('is-dimmed')).toBe(true);
    expect(gnodes()[6]?.classList.contains('is-dimmed')).toBe(true);

    // c1's neighborhood edges animate + highlight; the rest recede.
    expect(document.querySelectorAll('.react-flow__edge.animated')).toHaveLength(2);
    expect(document.querySelectorAll('.react-flow__edge.archgen-edge--highlighted')).toHaveLength(2);
    expect(document.querySelectorAll('.react-flow__edge.archgen-edge--dimmed')).toHaveLength(1);
  });

  it('dims non-neighbors INSIDE a canvas (unlinked bucket keeps dim behavior)', async () => {
    renderVm(SPLIT_VM);
    await flushFlow();
    await act(async () => {
      fireEvent.click(gnodes()[5] as Element); // z — singleton in the unlinked bucket
      await Promise.resolve();
    });
    expect(gnodes()[5]?.getAttribute('aria-pressed')).toBe('true');
    expect(dimmedCount()).toBe(6); // shared canvas: all 6 non-neighbors fade
    expect(gnodes()[6]?.classList.contains('is-dimmed')).toBe(true);
    expect(gnodes()[0]?.classList.contains('is-dimmed')).toBe(true);
  });

  it('traversal reaches upstream AND downstream transitively from any member', async () => {
    renderVm(SPLIT_VM);
    await flushFlow();
    // Middle node Beta: upstream Alpha + downstream Gamma all stay lit.
    await act(async () => {
      fireEvent.click(gnodes()[1] as Element);
      await Promise.resolve();
    });
    expect(dimmedCount()).toBe(4); // x,y + z,w fade outside the {a,b,c} component
    expect(gnodes()[0]?.getAttribute('aria-pressed')).toBe('false');
    expect(gnodes()[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(gnodes()[2]?.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelectorAll('.react-flow__edge.animated')).toHaveLength(2);
  });

  it('Escape clears the highlight completely', async () => {
    renderVm(SPLIT_VM);
    await flushFlow();
    await act(async () => {
      fireEvent.click(gnodes()[0] as Element);
      await Promise.resolve();
    });
    expect(dimmedCount()).toBe(4);
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(dimmedCount()).toBe(0);
    expect(document.querySelectorAll('.react-flow__edge.archgen-edge--dimmed')).toHaveLength(0);
    expect(document.querySelectorAll('.react-flow__edge.animated')).toHaveLength(0);
    expect(screen.queryByRole('status', { name: /Impact of/ })).toBeNull();
  });

  it('clicking empty canvas (pane) clears the highlight', async () => {
    renderVm(SPLIT_VM);
    await flushFlow();
    await act(async () => {
      fireEvent.click(gnodes()[0] as Element);
      await Promise.resolve();
    });
    expect(dimmedCount()).toBe(4);
    await act(async () => {
      fireEvent.click(document.querySelector('.react-flow__pane') as Element);
      await Promise.resolve();
    });
    expect(dimmedCount()).toBe(0);
    expect(document.querySelectorAll('.react-flow__edge.animated')).toHaveLength(0);
  });

  it('renders the friendly unsupported banner', () => {
    renderVm({ product: 'unsupported', unsupportedReason: 'Only workspace-local indexes are supported.' });
    expect(screen.getByText('Codegraph unavailable')).toBeTruthy();
    expect(screen.getByText(/workspace-local/)).toBeTruthy();
    expect(document.querySelector('.archgen-banner-unsupported')).toBeTruthy();
  });
});

describe('focus/selection lifecycle across live vm updates (todo 11)', () => {
  // File-hub-tier fixture: one 70-node chain (largest component > 60 → the
  // rollup escalates past the radial tier). a.ts holds n0+n1 wired with an
  // intra-file edge so its file node is OPENABLE (drill target). Every call
  // builds FRESH objects — the same identity churn the host's rAF-batched
  // immutable live patches produce.
  function fileHubVm(opts: { withoutATs?: boolean; tag?: string } = {}): CodegraphVM {
    const nodes: NonNullable<CodegraphVM['nodes']> = [];
    const edges: NonNullable<CodegraphVM['edges']> = [];
    const start = opts.withoutATs ? 2 : 0;
    for (let i = start; i < 70; i++) {
      nodes.push({
        id: `n${i}`,
        label: opts.tag && i === 69 ? `n69-${opts.tag}` : `n${i}`,
        kind: 'function',
        file: i < 2 ? 'a.ts' : 'b.ts',
        line: i,
      });
    }
    for (let i = start + 1; i < 70; i++) edges.push({ source: `n${i}`, target: `n${i - 1}`, kind: 'calls' });
    const files = opts.withoutATs
      ? [{ file: 'b.ts', symbols: 68, kinds: { function: 68 } }]
      : [
          { file: 'a.ts', symbols: 2, kinds: { function: 2 } },
          { file: 'b.ts', symbols: 68, kinds: { function: 68 } },
        ];
    const rollupEdges = opts.withoutATs
      ? [{ source: 'b.ts', target: 'b.ts', kind: 'calls', count: 67 }]
      : [
          { source: 'a.ts', target: 'a.ts', kind: 'calls', count: 1 },
          { source: 'b.ts', target: 'a.ts', kind: 'calls', count: 1 },
          { source: 'b.ts', target: 'b.ts', kind: 'calls', count: 67 },
        ];
    return {
      product: 'colby',
      hasFts: false,
      nodes,
      edges,
      fileRollup: {
        files,
        edges: rollupEdges,
        totals: { files: files.length, symbols: nodes.length, edges: edges.length },
      },
    };
  }

  async function drillIntoATs(): Promise<void> {
    const fileNode = gnodes().find((el) => el.textContent?.includes('a.ts'));
    if (!fileNode) throw new Error('a.ts file node not rendered');
    await act(async () => {
      fireEvent.click(fileNode);
      await Promise.resolve();
    });
  }

  it('retains drill focus across a live vm patch that keeps the focused file', async () => {
    const view = render(createElement(CodeGraphView, { vm: fileHubVm() }));
    await flushFlow();
    expect(screen.getByTestId('code-graph-view').getAttribute('data-tier')).toBe('file-hub');
    expect(screen.queryByTestId('cg-back-chip')).toBeNull();

    await drillIntoATs();
    await flushFlow();
    expect(screen.getByTestId('cg-back-chip')).toBeTruthy();
    expect(screen.getByText('a.ts · 2 symbols')).toBeTruthy();

    // live update: NEW vm identity, same product, a.ts still in the rollup
    view.rerender(createElement(CodeGraphView, { vm: fileHubVm({ tag: 'patch' }) }));
    await flushFlow();
    expect(screen.getByTestId('cg-back-chip')).toBeTruthy(); // focus RETAINED
    expect(screen.getByText('a.ts · 2 symbols')).toBeTruthy();
    expect(gnodes().some((el) => el.textContent?.includes('n0'))).toBe(true);
  });

  it('clears drill focus when the focused file disappears from the live rollup', async () => {
    const view = render(createElement(CodeGraphView, { vm: fileHubVm() }));
    await flushFlow();
    await drillIntoATs();
    expect(screen.getByTestId('cg-back-chip')).toBeTruthy();

    view.rerender(createElement(CodeGraphView, { vm: fileHubVm({ withoutATs: true }) }));
    await flushFlow();
    expect(screen.queryByTestId('cg-back-chip')).toBeNull(); // focus CLEARED
    // …and the view lands back on the file universe (only b.ts remains)
    expect(gnodes().some((el) => el.textContent?.includes('b.ts'))).toBe(true);
    expect(gnodes().some((el) => el.textContent?.includes('a.ts'))).toBe(false);
  });

  it('retains selection across a live vm patch that keeps the selected node', async () => {
    const view = render(createElement(CodeGraphView, { vm: SPLIT_VM }));
    await flushFlow();
    await act(async () => {
      fireEvent.click(gnodes()[0] as Element); // Alpha
      await Promise.resolve();
    });
    expect(dimmedCount()).toBe(4);
    expect(screen.queryByRole('status', { name: /Impact of/ })).not.toBeNull();

    const patched: CodegraphVM = {
      ...SPLIT_VM,
      nodes: (SPLIT_VM.nodes ?? []).map((n) => (n.id === 'w' ? { ...n, label: 'Whiskey!' } : n)),
    };
    view.rerender(createElement(CodeGraphView, { vm: patched }));
    await flushFlow();
    expect(dimmedCount()).toBe(4); // selection RETAINED across identity churn
    expect(screen.queryByRole('status', { name: /Impact of/ })).not.toBeNull();
  });

  it('clears a stale selection when the node leaves the graph — no ghost dimming', async () => {
    const view = render(createElement(CodeGraphView, { vm: SPLIT_VM }));
    await flushFlow();
    await act(async () => {
      fireEvent.click(gnodes()[0] as Element); // Alpha
      await Promise.resolve();
    });
    expect(dimmedCount()).toBe(4);

    // live update deletes Alpha from the index
    const patched: CodegraphVM = {
      ...SPLIT_VM,
      nodes: (SPLIT_VM.nodes ?? []).filter((n) => n.id !== 'a'),
      edges: (SPLIT_VM.edges ?? []).filter((e) => e.source !== 'a' && e.target !== 'a'),
    };
    view.rerender(createElement(CodeGraphView, { vm: patched }));
    await flushFlow();
    expect(screen.queryByRole('status', { name: /Impact of/ })).toBeNull(); // badge reset
    expect(screen.queryByRole('button', { name: 'Clear selection' })).toBeNull();
    expect(dimmedCount()).toBe(0); // no ghost dimming of the entire graph
    expect(document.querySelectorAll('.react-flow__edge.archgen-edge--dimmed')).toHaveLength(0);
    expect(document.querySelectorAll('.react-flow__edge.animated')).toHaveLength(0);
  });
});

describe('layoutRadial — circular contract', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, label: `n${i}`, kind: 'file', file: 'a.ts', line: i }));

  it('places nodes on a shared circle with even 360/n spacing starting at top', () => {
    const placed = layoutRadial(many);
    const cx = placed.reduce((s, p) => s + p.anchor.x, 0) / placed.length;
    const cy = placed.reduce((s, p) => s + p.anchor.y, 0) / placed.length;
    const radii = placed.map((p) => Math.hypot(p.anchor.x - cx, p.anchor.y - cy));
    for (const r of radii) expect(Math.abs(r - radii[0]!)).toBeLessThan(0.01);
    const first = placed[0]!;
    expect(first.anchor.y).toBeLessThan(cy); // starts at 12 o'clock
    for (let i = 1; i < placed.length; i++) {
      const expected = -90 + (360 / placed.length) * i;
      expect(placed[i]!.angle).toBeCloseTo(expected, 5);
    }
  });

  it('is NOT collinear — positions must span both axes (the linear-layout regression guard)', () => {
    const placed = layoutRadial(many);
    const xs = placed.map((p) => p.position.x);
    const ys = placed.map((p) => p.position.y);
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    expect(spread(xs)).toBeGreaterThan(100);
    expect(spread(ys)).toBeGreaterThan(100);
  });
});
