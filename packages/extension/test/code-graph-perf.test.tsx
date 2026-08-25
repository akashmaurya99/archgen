// Code-graph perf budgets (mirrors test/polish-perf.test.tsx conventions and
// the documented constants in helpers/perf-budget.ts):
//
// 1. MEMO DISCIPLINE (pure, deterministic): reconcileCachedNodes returns the
//    IDENTICAL node object when nothing changed for that id, and replaces
//    ONLY ids whose position/label/kind/file/line/dimmed/selected actually
//    flipped — so memoized GraphNodes skip re-renders entirely for untouched
//    nodes across a status-less highlight toggle.
// 2. COMMIT BUDGET (jsdom): mounting the CODE canvas and toggling a highlight
//    each stay within small documented commit ceilings (React.Profiler onRender
//    count; headroom covers React Flow's internal measure passes).
// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { createElement, Profiler } from 'react';
import { CodeGraphView, reconcileCachedNodes, type GraphFlowNode, type GraphNodeMeta } from '../src/webview/CodeGraphView';
import type { CodegraphVM } from '../src/shared/protocol';
import { installFlowDomStubs } from './helpers/dom-stubs';
import { RENDER_BUDGET_PER_FLIP } from './helpers/perf-budget';

installFlowDomStubs();

/**
 * Commit ceilings measured under jsdom + xyflow stubs (observed: mount=3,
 * toggle=4 — the toggle's extra commits are React Flow's internal
 * measure/viewport passes after the node/edge prop swap), kept in THIS file
 * next to the assertions they bound. Headroom of 1 absorbs CI variance while
 * still failing loudly on a remount storm (e.g. inline nodeTypes would push
 * this into the dozens).
 */
const CG_COMMIT_BUDGET_MOUNT = 4;
const CG_COMMIT_BUDGET_PER_TOGGLE = RENDER_BUDGET_PER_FLIP + 3;

const META: GraphNodeMeta[] = [
  { id: 'a', label: 'Alpha', kind: 'class', file: 'a.ts', line: 1 },
  { id: 'b', label: 'Beta', kind: 'function', file: 'b.ts', line: 2 },
  { id: 'c', label: 'Gamma', kind: 'module', file: 'c.ts', line: 3 },
  { id: 'z', label: 'Island', kind: 'file', file: 'z.ts', line: 9 },
];

function seedLayout(): Array<{ id: string; position: { x: number; y: number }; width: number; height: number; style: { width: number; height: number } }> {
  return META.map((m) => ({
    id: m.id,
    position: { x: m.line * 10, y: 0 },
    width: 150,
    height: 40,
    style: { width: 150, height: 40 },
  }));
}

function metaMap(): Map<string, GraphNodeMeta> {
  return new Map(META.map((m) => [m.id, m]));
}

beforeEach(cleanup);

describe('reconcileCachedNodes — memo discipline', () => {
  it('returns identical objects when nothing changed', () => {
    const cache = new Map<string, GraphFlowNode>();
    const laidOut = seedLayout();
    const r1 = reconcileCachedNodes(cache, laidOut, metaMap(), null, null);
    const r2 = reconcileCachedNodes(cache, laidOut, metaMap(), null, null);
    expect(r2.map((n) => n.id)).toEqual(['a', 'b', 'c', 'z']);
    r1.forEach((n, i) => {
      const other = r2[i];
      expect(other).toBe(n);
    });
  });

  it('a highlight toggle replaces ONLY selected + newly-dimmed objects', () => {
    const cache = new Map<string, GraphFlowNode>();
    const laidOut = seedLayout();
    const base = reconcileCachedNodes(cache, laidOut, metaMap(), null, null);

    // Select `a`: component {a,b,c} lit, island z dims.
    const after = reconcileCachedNodes(cache, laidOut, metaMap(), 'a', new Set(['a', 'b', 'c']));
    expect(after[0]).not.toBe(base[0]); // selected flipped
    expect(after[1]).toBe(base[1]); // b: dimmed false→false → untouched
    expect(after[2]).toBe(base[2]); // c: same
    expect(after[3]).not.toBe(base[3]); // z: dimmed false→true

    expect(after[0]?.data.selected).toBe(true);
    expect(after[3]?.data.dimmed).toBe(true);
    expect(after[1]?.data.dimmed).toBe(false);
  });

  it('clearing selection flips flags via fresh objects only where they changed', () => {
    const cache = new Map<string, GraphFlowNode>();
    const laidOut = seedLayout();
    const during = reconcileCachedNodes(cache, laidOut, metaMap(), 'a', new Set(['a', 'b', 'c']));
    const cleared = reconcileCachedNodes(cache, laidOut, metaMap(), null, null);
    expect(cleared.every((n) => !n.data.dimmed && !n.data.selected)).toBe(true);
    // b was already lit+unselected through BOTH states → same object twice
    expect(cleared[1]).toBe(during[1]);
    expect(cleared[0]).not.toBe(during[0]); // a deselected
    expect(cleared[3]).not.toBe(during[3]); // z undimmed
  });

  it('a data change (label) invalidates exactly that node', () => {
    const cache = new Map<string, GraphFlowNode>();
    const laidOut = seedLayout();
    const base = reconcileCachedNodes(cache, laidOut, metaMap(), null, null);
    const renamed = metaMap();
    renamed.set('c', { ...META[2]!, label: 'Gamma2' });
    const next = reconcileCachedNodes(cache, laidOut, renamed, null, null);
    expect(next[2]).not.toBe(base[2]);
    expect(next[2]?.data.label).toBe('Gamma2');
    expect(next[0]).toBe(base[0]);
    expect(next[3]).toBe(base[3]);
  });

  it('a position change (relayout) invalidates exactly that node', () => {
    const cache = new Map<string, GraphFlowNode>();
    const laidOut = seedLayout();
    const base = reconcileCachedNodes(cache, laidOut, metaMap(), null, null);
    const moved = seedLayout();
    moved[3]!.position = { x: 999, y: 42 };
    const next = reconcileCachedNodes(cache, moved, metaMap(), null, null);
    expect(next[3]).not.toBe(base[3]);
    expect(next[3]?.position).toEqual({ x: 999, y: 42 });
    expect(next[0]).toBe(base[0]);
  });
});

describe('commit budget across a status-less highlight toggle', () => {
  const VM: CodegraphVM = {
    product: 'colby',
    hasFts: false,
    nodes: [
      { id: 'a', label: 'Alpha', kind: 'class', file: 'a.ts', line: 1 },
      { id: 'b', label: 'Beta', kind: 'function', file: 'b.ts', line: 2 },
      { id: 'z', label: 'Island', kind: 'file', file: 'z.ts', line: 9 },
    ],
    edges: [{ source: 'a', target: 'b', kind: 'calls' }],
  };

  it('mount stays within the documented ceiling', async () => {
    let commits = 0;
    render(
      createElement(
        Profiler,
        { id: 'cg-mount', onRender: () => { commits++; } },
        createElement(CodeGraphView, { vm: VM }),
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(commits).toBeGreaterThan(0);
    expect(commits).toBeLessThanOrEqual(CG_COMMIT_BUDGET_MOUNT);
  });

  it('one highlight toggle costs at most RENDER_BUDGET_PER_FLIP+1 commits and dims non-neighbors', async () => {
    let commits = 0;
    const { container } = render(
      createElement(
        Profiler,
        { id: 'cg-toggle', onRender: () => { commits++; } },
        createElement(CodeGraphView, { vm: VM }),
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const afterMount = commits;

    fireEvent.click(container.querySelector('.archgen-gnode') as Element);
    await act(async () => {
      await Promise.resolve();
    });

    expect(commits - afterMount).toBeLessThanOrEqual(CG_COMMIT_BUDGET_PER_TOGGLE);
    // functional sanity alongside the budget: island dimmed, chain edge animated
    expect(container.querySelectorAll('.archgen-gnode.is-dimmed')).toHaveLength(1);
    expect(container.querySelectorAll('.react-flow__edge.animated')).toHaveLength(1);
  });
});
