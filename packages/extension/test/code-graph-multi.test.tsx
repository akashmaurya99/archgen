// Grouped single-canvas CODE view tests: EVERY connected component renders on
// ONE shared canvas — radial = one kind-clustered ring per component, flow =
// one isolated dagre block per component, shelf-packed side by side. Covers:
// ring-circle count per component, unlinked grid, component fit chips,
// shared-canvas focus dimming across components, and the flow declutter
// (2px resting stroke inline, 16px arrowhead markers).
// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, act, screen } from '@testing-library/react';
import { createElement } from 'react';
import { CodeGraphView } from '../src/webview/CodeGraphView';
import type { CodegraphVM } from '../src/shared/protocol';
import { installFlowDomStubs } from './helpers/dom-stubs';

installFlowDomStubs();

/* 2 sized components + 3 singletons:
   c1 = {p,q,r} (q→p, r→q), c2 = {s,t} (t→s), unlinked = {m1,m2,m3}. */
const MULTI_VM: CodegraphVM = {
  product: 'colby',
  hasFts: false,
  nodes: [
    { id: 'p', label: 'Piper', kind: 'class', file: 'p.ts', line: 1 },
    { id: 'q', label: 'Quinn', kind: 'function', file: 'q.ts', line: 2 },
    { id: 'r', label: 'Remy', kind: 'module', file: 'r.ts', line: 3 },
    { id: 's', label: 'Sage', kind: 'interface', file: 's.ts', line: 4 },
    { id: 't', label: 'Tate', kind: 'class', file: 't.ts', line: 5 },
    { id: 'm1', label: 'Mono', kind: 'file', file: 'm1.ts', line: 6 },
    { id: 'm2', label: 'Micro', kind: 'variable', file: 'm2.ts', line: 7 },
    { id: 'm3', label: 'Macro', kind: 'constant', file: 'm3.ts', line: 8 },
  ],
  edges: [
    { source: 'q', target: 'p', kind: 'calls' },
    { source: 'r', target: 'q', kind: 'imports' },
    { source: 't', target: 's', kind: 'references' },
  ],
};

function renderVm(vm: CodegraphVM): void {
  render(createElement(CodeGraphView, { vm }));
}

async function flushFlow(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => cleanup());

describe('grouped single-canvas CODE view', () => {
  it('renders every component on the ONE canvas: 2 rings + unlinked grid cards', async () => {
    renderVm(MULTI_VM);
    await flushFlow();
    const ring = document.querySelector('.archgen-ring-svg');
    expect(ring).toBeTruthy();
    // 2 sized components → 2 ring circles; anchors = 5 ring members.
    expect(ring?.querySelectorAll('circle[fill="none"]').length ?? 0).toBe(2);
    // A label above every ring + one for the loose grid.
    expect(ring?.querySelectorAll('text.archgen-ring-label').length ?? 0).toBe(3);
    expect(document.querySelectorAll('.archgen-gnode')).toHaveLength(8);
    expect(screen.getByTestId('cg-counts').textContent).toContain('nodes=9');
    expect(screen.getByTestId('cg-counts').textContent).toContain('edges=3');
  });

  it('exposes a fit chip per component and fits on click without crashing', async () => {
    renderVm(MULTI_VM);
    await flushFlow();
    expect(screen.getByRole('button', { name: 'Fit component c1 · 3' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fit component c2 · 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fit component loose ×3' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fit component c2 · 2' }));
      await Promise.resolve();
    });
  });

  it('dims ACROSS components on the shared canvas (focus mode)', async () => {
    renderVm(MULTI_VM);
    await flushFlow();
    const gnodes = () => Array.from(document.querySelectorAll('.archgen-gnode'));
    await act(async () => {
      fireEvent.click(gnodes().find((el) => el.textContent?.includes('Piper')) as Element);
      await Promise.resolve();
    });
    // Neighborhood {p,q,r} stays lit; c2 {s,t} + loose m1..m3 all fade.
    expect(gnodes().filter((el) => el.classList.contains('is-dimmed'))).toHaveLength(5);
    const dimmedText = gnodes()
      .filter((el) => el.classList.contains('is-dimmed'))
      .map((el) => el.textContent)
      .join('|');
    expect(dimmedText).toContain('Sage');
    expect(dimmedText).toContain('Mono');
    expect(document.querySelectorAll('.react-flow__edge.animated')).toHaveLength(2);
  });

  it('flow mode keeps the declutter contract on the shared canvas', async () => {
    renderVm(MULTI_VM);
    await flushFlow();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '⇥ Flow' }));
      await Promise.resolve();
    });
    await flushFlow();
    // No ring layer in flow mode.
    expect(document.querySelector('.archgen-ring-svg')).toBeNull();
    expect(document.querySelectorAll('.react-flow__edge')).toHaveLength(3);
    const path = document.querySelector('.react-flow__edge-path') as SVGPathElement | null;
    expect(path?.style.strokeWidth).toBe('2');
    expect(document.querySelectorAll('marker[markerWidth="16"]')).toHaveLength(3);
    // All 8 nodes still on the ONE canvas, isolated dagre blocks per component.
    expect(document.querySelectorAll('.archgen-gnode')).toHaveLength(8);
  });
});
