// CODE tab scale tests: size-tier auto-mode (radial ≤60 / file-hub 61–300 /
// focus-first >300, decided by the LARGEST LINKED component's symbol count —
// the unlinked singleton bucket never escalates the tier) and the zoom
// Level-of-Detail ladder (dot <0.35 · mid ≤0.70 · full above; hubs keep
// labels; minor edges hide at dot zoom). Also proves the perf guardrail: a
// full quantized zoom sweep replaces each node object ≤2 times and ONLY when
// its lod tier flips.
// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { createElement } from 'react';
import type { ReactFlowInstance } from '@xyflow/react';
import {
  adjustLodForHub,
  basename,
  focusNeighborhoodFiles,
  lodTierFor,
  pickTopHub,
  quantizeZoom,
  selectSizeTier,
  FOCUS_FILE_CAP,
  HUB_DEGREE_THRESHOLD,
} from '../src/webview/graph-grouped';
import { CodeGraphView, reconcileCachedNodes, type GraphFlowNode, type GraphNodeMeta } from '../src/webview/CodeGraphView';
import type { CodegraphVM } from '../src/shared/protocol';
import { installFlowDomStubs } from './helpers/dom-stubs';

installFlowDomStubs();

type Sym = { id: string; label: string; kind: string; file: string; line: number };
type SymEdge = { source: string; target: string; kind: string };

interface ChainSpec {
  files: number;
  symsPerFile: number;
  hubLinksFromF0?: number;
}

/** One connected symbol chain threaded through `files` files (+ optional
 *  extra f0→fN links so f0 becomes a degree≥5 FILE hub). */
function buildChain(spec: ChainSpec): { nodes: Sym[]; edges: SymEdge[] } {
  const nodes: Sym[] = [];
  const edges: SymEdge[] = [];
  const idsByFile: string[][] = [];
  let idx = 0;
  for (let f = 0; f < spec.files; f++) {
    const ids: string[] = [];
    for (let s = 0; s < spec.symsPerFile; s++) {
      const id = `n${idx++}`;
      nodes.push({ id, label: `sym${idx - 1}`, kind: 'function', file: `f${f}.ts`, line: s + 1 });
      ids.push(id);
    }
    idsByFile.push(ids);
  }
  for (const ids of idsByFile) {
    for (let i = 0; i + 1 < ids.length; i++) edges.push({ source: ids[i]!, target: ids[i + 1]!, kind: 'calls' });
  }
  for (let f = 0; f + 1 < spec.files; f++) {
    edges.push({
      source: idsByFile[f]![spec.symsPerFile - 1]!,
      target: idsByFile[f + 1]![0]!,
      kind: 'imports',
    });
  }
  if (spec.hubLinksFromF0) {
    for (let k = 0; k < spec.hubLinksFromF0; k++) {
      const targetFile = 5 + k;
      if (targetFile >= spec.files) break;
      edges.push({ source: idsByFile[0]![0]!, target: idsByFile[targetFile]![0]!, kind: 'references' });
    }
  }
  return { nodes, edges };
}

function rollupFor(nodes: readonly Sym[], edges: readonly SymEdge[]): NonNullable<CodegraphVM['fileRollup']> {
  const files = new Map<string, { file: string; symbols: number; kinds: Record<string, number> }>();
  for (const n of nodes) {
    let entry = files.get(n.file);
    if (!entry) {
      entry = { file: n.file, symbols: 0, kinds: {} };
      files.set(n.file, entry);
    }
    entry.symbols += 1;
    entry.kinds[n.kind] = (entry.kinds[n.kind] ?? 0) + 1;
  }
  const fileOf = new Map(nodes.map((n) => [n.id, n.file]));
  const counts = new Map<string, number>();
  const order: Array<{ source: string; target: string; kind: string }> = [];
  for (const e of edges) {
    const sf = fileOf.get(e.source)!;
    const tf = fileOf.get(e.target)!;
    const key = `${sf}|${tf}|${e.kind}`;
    if (!counts.has(key)) {
      counts.set(key, 0);
      order.push({ source: sf, target: tf, kind: e.kind });
    }
    counts.set(key, counts.get(key)! + 1);
  }
  return {
    files: [...files.values()],
    edges: order.map((k) => ({ ...k, count: counts.get(`${k.source}|${k.target}|${k.kind}`)! })),
    totals: { files: files.size, symbols: nodes.length, edges: edges.length },
  };
}

function vmFrom(spec: ChainSpec, hubs?: CodegraphVM['hubs']): CodegraphVM {
  const { nodes, edges } = buildChain(spec);
  return { product: 'colby', hasFts: false, nodes, edges, fileRollup: rollupFor(nodes, edges), hubs };
}

const SMALL_VM = vmFrom({ files: 4, symsPerFile: 2 }); // largest comp 8 → radial
const MID_VM = vmFrom({ files: 20, symsPerFile: 4, hubLinksFromF0: 6 }); // comp 80 → file-hub
const HUGE_VM = vmFrom({ files: 64, symsPerFile: 5 }, [
  { id: 'n0', label: 'Hub One', kind: 'class', file: 'f0.ts', degree: 12 },
]); // comp 320 → focus-first

function renderVm(vm: CodegraphVM, onFlowInit?: (inst: ReactFlowInstance) => void): void {
  render(createElement(CodeGraphView, { vm, onFlowInit }));
}

async function flushFlow(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function setZoom(inst: ReactFlowInstance | null, zoom: number): Promise<void> {
  // React defers commits from timer/store-subscription callbacks until the
  // enclosing async act() exits, so: drive the viewport in one act, give the
  // bridge's coalescing timer room in another, and let the second exit flush.
  await act(async () => {
    inst?.setViewport({ x: 0, y: 0, zoom });
    await new Promise((r) => setTimeout(r, 150));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}

/** Lets xyflow's async initial fitView land BEFORE tests drive the viewport,
 *  otherwise the late fit clobbers the test's zoom. */
async function settleFit(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 150));
  });
}

function section(): HTMLElement {
  return document.querySelector('[data-testid="code-graph-view"]') as HTMLElement;
}

function gnodes(): HTMLElement[] {
  return [...document.querySelectorAll('.archgen-gnode')] as HTMLElement[];
}

function edgeCount(): number {
  return document.querySelectorAll('.react-flow__edge').length;
}

function counts(): { nodes: number; edges: number } {
  const text = screen.getByTestId('cg-counts').textContent ?? '';
  return {
    nodes: Number(/nodes=(\d+)/.exec(text)?.[1] ?? -1),
    edges: Number(/edges=(\d+)/.exec(text)?.[1] ?? -1),
  };
}

beforeEach(cleanup);

describe('tier-matrix — selectSizeTier by LARGEST component', () => {
  const chain = (k: number): { nodes: Sym[]; edges: SymEdge[] } => ({
    nodes: Array.from({ length: k }, (_, i) => ({ id: `n${i}`, label: `s${i}`, kind: 'function', file: `f${i}.ts`, line: 1 })),
    edges: Array.from({ length: k - 1 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}`, kind: 'imports' })),
  });

  it('no rollup → radial fallback at ANY size', () => {
    const big = chain(400);
    expect(selectSizeTier(big.nodes, big.edges, null)).toBe('radial');
    expect(selectSizeTier(big.nodes, big.edges, undefined)).toBe('radial');
  });

  it('≤60 radial · 61–300 file-hub · >300 focus-first', () => {
    expect(selectSizeTier(chain(60).nodes, chain(60).edges, rollupFor(chain(60).nodes, chain(60).edges))).toBe('radial');
    expect(selectSizeTier(chain(61).nodes, chain(61).edges, rollupFor(chain(61).nodes, chain(61).edges))).toBe('file-hub');
    expect(selectSizeTier(chain(300).nodes, chain(300).edges, rollupFor(chain(300).nodes, chain(300).edges))).toBe('file-hub');
    expect(selectSizeTier(chain(301).nodes, chain(301).edges, rollupFor(chain(301).nodes, chain(301).edges))).toBe('focus-first');
  });

  it('ignores the unlinked bucket — loose singletons never escalate the tier (todo 13)', () => {
    // 40-chain + 40 singletons: largest LINKED component is 40 → radial.
    const nodes: Sym[] = Array.from({ length: 40 }, (_, i) => ({ id: `iso${i}`, label: `i${i}`, kind: 'file', file: `i${i}.ts`, line: 1 }));
    const { nodes: chainNodes, edges } = chain(40);
    const all = [...chainNodes, ...nodes];
    expect(selectSizeTier(all, edges, rollupFor(all, edges))).toBe('radial');
    // The decomposition collapses ALL singletons into one 'unlinked' bucket,
    // which renders as a compact grid (never a ring) at every tier — so it
    // must NOT escalate: 500 loose + 10-chain stays radial. (Pre-fix this
    // returned 'focus-first' because the 500-node bucket was counted.)
    const manyLoose = Array.from({ length: 500 }, (_, i) => ({ id: `loose${i}`, label: `l${i}`, kind: 'file', file: `l${i}.ts`, line: 1 }));
    const mixed = [...chain(10).nodes, ...manyLoose];
    expect(selectSizeTier(mixed, [], rollupFor(mixed, []))).toBe('radial');
  });
});

describe('LOD ladder — pure helpers', () => {
  it('quantizes zoom to the 0.05 grid', () => {
    expect(quantizeZoom(1)).toBe(1);
    expect(quantizeZoom(0.349)).toBe(0.35);
    expect(quantizeZoom(0.274)).toBe(0.25);
    expect(quantizeZoom(0.026)).toBe(0.05);
    expect(quantizeZoom(3.982)).toBe(4);
  });

  it('tiers: <0.35 dot · ≤0.70 mid · else full (boundaries exact)', () => {
    expect(lodTierFor(0.05)).toBe('dot');
    expect(lodTierFor(0.3)).toBe('dot');
    expect(lodTierFor(0.35)).toBe('mid');
    expect(lodTierFor(0.5)).toBe('mid');
    expect(lodTierFor(0.7)).toBe('mid');
    expect(lodTierFor(0.75)).toBe('full');
    expect(lodTierFor(1)).toBe('full');
  });

  it('hubs never drop below mid', () => {
    expect(adjustLodForHub('dot', true)).toBe('mid');
    expect(adjustLodForHub('dot', false)).toBe('dot');
    expect(adjustLodForHub('mid', true)).toBe('mid');
    expect(adjustLodForHub('full', true)).toBe('full');
  });

  it('basename strips directories', () => {
    expect(basename('src/webview/CodeGraphView.tsx')).toBe('CodeGraphView.tsx');
    expect(basename('plain.ts')).toBe('plain.ts');
  });

  it('pickTopHub takes max degree with id tie-break; focus BFS caps files', () => {
    expect(pickTopHub([])).toBeNull();
    expect(pickTopHub(undefined)).toBeNull();
    const hubs = [
      { id: 'b', label: 'B', kind: 'class', file: 'b.ts', degree: 5 },
      { id: 'a', label: 'A', kind: 'class', file: 'a.ts', degree: 9 },
      { id: 'c', label: 'C', kind: 'class', file: 'c.ts', degree: 9 },
    ];
    expect(pickTopHub(hubs)?.id).toBe('a');

    const fileEdges = Array.from({ length: 60 }, (_, i) => ({ source: `f${i}.ts`, target: `f${i + 1}.ts`, kind: 'imports', count: 1 }));
    const hood = focusNeighborhoodFiles('f0.ts', fileEdges);
    expect(hood.length).toBe(FOCUS_FILE_CAP);
    expect(hood[0]).toBe('f0.ts');
    expect(hood).toContain('f39.ts');
    expect(hood).not.toContain('f40.ts');
  });
});

describe('size-tier auto-mode in the view', () => {
  it('SMALL (rollup present, comp 8): radial tier UNCHANGED — rings + mode toggle', async () => {
    renderVm(SMALL_VM);
    await flushFlow();
    expect(section().getAttribute('data-tier')).toBe('radial');
    expect(screen.getByRole('button', { name: '◉ Radial' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '⇥ Flow' })).toBeTruthy();
    expect(document.querySelector('.archgen-ring-svg')).toBeTruthy();
    expect(document.querySelector('[data-testid="cg-tier-badge"]')).toBeNull();
  });

  it('MID (comp 80): FILE-HUB — file cards with basename labels + symbol captions', async () => {
    renderVm(MID_VM);
    await flushFlow();
    expect(section().getAttribute('data-tier')).toBe('file-hub');
    expect(screen.getByTestId('cg-tier-badge').textContent).toContain('20 files');
    expect(screen.queryByRole('button', { name: '◉ Radial' })).toBeNull();
    expect(document.querySelector('.archgen-ring-svg')).toBeNull();
    expect(gnodes()).toHaveLength(20);
    const labels = gnodes().map((g) => g.querySelector('.archgen-gnode-label')?.textContent);
    expect(labels).toContain('f0.ts');
    const captions = gnodes().map((g) => g.querySelector('.archgen-gnode-caption')?.textContent);
    expect(new Set(captions)).toEqual(new Set(['4 symbols']));
    expect(gnodes()[0]?.getAttribute('title')).toContain('symbols');
  });

  it('HUGE (comp 320): FOCUS-FIRST — ALL 64 files render by default, no Show-all click', async () => {
    renderVm(HUGE_VM);
    await flushFlow();
    expect(section().getAttribute('data-tier')).toBe('focus-first');
    expect(gnodes()).toHaveLength(64);
    expect(counts().nodes).toBe(64); // no ring layer in file tiers
    expect(screen.getByTestId('cg-tier-badge').textContent).toContain('64 files');
    // The old hub-scoping banner is gone: everything is visible up front.
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
    expect(screen.queryByTestId('cg-focus-banner')).toBeNull();
  });

  it('file node click → symbol FOCUS overlay + back chip; back restores files', async () => {
    renderVm(MID_VM);
    await flushFlow();
    const fileCard = gnodes().find((g) => g.querySelector('.archgen-gnode-label')?.textContent === 'f3.ts');
    expect(fileCard).toBeTruthy();
    await act(async () => {
      fireEvent.click(fileCard as Element);
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: '‹ All files' })).toBeTruthy();
    const focusLabels = gnodes().map((g) => g.querySelector('.archgen-gnode-label')?.textContent);
    expect(focusLabels).toHaveLength(4); // f3.ts holds exactly 4 symbols
    expect(focusLabels.every((l) => l?.startsWith('sym'))).toBe(true);
    expect(document.querySelector('.archgen-ring-svg')).toBeTruthy(); // radial focus layout

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '‹ All files' }));
      await Promise.resolve();
    });
    expect(gnodes()).toHaveLength(20);
    expect(screen.queryByRole('button', { name: '‹ All files' })).toBeNull();
  });

  it('selection highlight works inside the focus overlay (symbol universe)', async () => {
    renderVm(MID_VM);
    await flushFlow();
    await act(async () => {
      fireEvent.click(gnodes().find((g) => g.querySelector('.archgen-gnode-label')?.textContent === 'f3.ts') as Element);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(gnodes()[0] as Element);
      await Promise.resolve();
    });
    expect(screen.getByRole('status', { name: /Impact of/ })).toBeTruthy();
    // f3's four symbols form ONE connected chain → the whole file lights up,
    // nothing dims inside its own focus; incident edges animate instead.
    expect(document.querySelectorAll('.archgen-gnode.is-dimmed')).toHaveLength(0);
    expect(document.querySelectorAll('.react-flow__edge.animated').length).toBeGreaterThanOrEqual(1);
  });
});

describe('zoom LOD in the live canvas', () => {
  it('sweep drives dot → mid → full classes; hub file keeps its label; minor edges hide at dot', async () => {
    let inst: ReactFlowInstance | null = null;
    renderVm(MID_VM, (i) => {
      inst = i;
    });
    await flushFlow();
    await settleFit();

    await setZoom(inst, 1);
    expect(section().getAttribute('data-lod')).toBe('full');
    expect(gnodes().every((g) => g.classList.contains('is-lod-full'))).toBe(true);
    const allEdges = edgeCount();
    expect(allEdges).toBe(25); // 19 chain pairs + 6 hub links, file-level

    await setZoom(inst, 0.5);
    expect(section().getAttribute('data-lod')).toBe('mid');
    expect(gnodes().every((g) => g.classList.contains('is-lod-mid'))).toBe(true);

    await setZoom(inst, 0.2);
    expect(section().getAttribute('data-lod')).toBe('dot');
    const hubCards = gnodes().filter((g) => g.classList.contains('is-hub'));
    expect(hubCards).toHaveLength(1); // f0.ts (degree 7 ≥ 5)
    expect(hubCards[0]?.classList.contains('is-lod-mid')).toBe(true);
    expect(hubCards[0]?.querySelector('.archgen-gnode-label')?.textContent).toBe('f0.ts');
    const dots = gnodes().filter((g) => g.classList.contains('is-lod-dot'));
    expect(dots).toHaveLength(19);
    // Minor-edge hiding: only the 7 edges touching the hub survive.
    expect(edgeCount()).toBe(7);
    expect(edgeCount()).toBeLessThan(allEdges);

    await setZoom(inst, 1);
    expect(section().getAttribute('data-lod')).toBe('full');
    expect(edgeCount()).toBe(allEdges);
  });

  it('radial tier obeys the same ladder (all modes)', async () => {
    let inst: ReactFlowInstance | null = null;
    renderVm(SMALL_VM, (i) => {
      inst = i;
    });
    await flushFlow();
    await settleFit();
    await setZoom(inst, 0.2);
    expect(section().getAttribute('data-lod')).toBe('dot');
    expect(gnodes().every((g) => g.classList.contains('is-lod-dot'))).toBe(true);
    await setZoom(inst, 1);
    expect(gnodes().every((g) => g.classList.contains('is-lod-full'))).toBe(true);
  });
});

describe('reconcile identity across a quantized zoom sweep (perf guardrail)', () => {
  const META: GraphNodeMeta[] = [
    { id: 'hub', label: 'Hub', kind: 'class', file: 'h.ts', line: 1 },
    { id: 'a', label: 'Alpha', kind: 'function', file: 'a.ts', line: 2 },
    { id: 'b', label: 'Beta', kind: 'module', file: 'b.ts', line: 3 },
    { id: 'c', label: 'Gamma', kind: 'interface', file: 'c.ts', line: 4 },
  ];
  const PLACED = META.map((m, i) => ({ id: m.id, position: { x: i * 260, y: 0 } }));
  const HUB_IDS = new Set(['hub']);

  function sweepStep(cache: Map<string, GraphFlowNode>, zoom: number): GraphFlowNode[] {
    const lodById = new Map(META.map((m) => [m.id, adjustLodForHub(lodTierFor(zoom), HUB_IDS.has(m.id))]));
    return reconcileCachedNodes(cache, PLACED, new Map(META.map((m) => [m.id, m])), null, null, {
      lodById,
      hubIds: HUB_IDS,
    });
  }

  it('a full 0.05→1.00 sweep replaces each node object AT MOST TWICE', () => {
    const cache = new Map<string, GraphFlowNode>();
    let prev = sweepStep(cache, 0.05);
    const replacements = new Map<string, number>(META.map((m) => [m.id, 0]));
    for (let z = 0.1; z <= 1.001; z += 0.05) {
      const step = Math.round(z * 100) / 100;
      const next = sweepStep(cache, step);
      for (let i = 0; i < next.length; i++) {
        if (next[i] !== prev[i]) replacements.set(next[i]!.id, (replacements.get(next[i]!.id) ?? 0) + 1);
      }
      prev = next;
    }
    for (const [id, count] of replacements) {
      expect(`replacements[${id}]=${count}`).toBe(
        id === 'hub' ? 'replacements[hub]=1' : `replacements[${id}]=2`,
      );
    }
  });

  it('consecutive steps replace EXACTLY the tier-flipped nodes (others keep identity)', () => {
    const cache = new Map<string, GraphFlowNode>();
    let prev = sweepStep(cache, 0.3);
    const expectations: Array<[number, string[]]> = [
      [0.35, ['a', 'b', 'c']], // dot→mid flips non-hubs; hub was already forced to mid
      [0.4, []], // mid→mid: zero churn
      [0.7, []], // still mid boundary-inclusive
      [0.75, ['hub', 'a', 'b', 'c']], // mid→full flips everyone
      [0.8, []],
    ];
    for (const [zoom, expectedFlips] of expectations) {
      const next = sweepStep(cache, zoom);
      const flipped = next.filter((n, i) => n !== prev[i]).map((n) => n.id);
      expect(flipped).toEqual(expectedFlips);
      prev = next;
    }
  });

  it('legacy 5-arg calls still reconcile identically (extras default to full/no-hub)', () => {
    const cache = new Map<string, GraphFlowNode>();
    const r1 = reconcileCachedNodes(cache, PLACED, new Map(META.map((m) => [m.id, m])), null, null);
    const r2 = reconcileCachedNodes(cache, PLACED, new Map(META.map((m) => [m.id, m])), null, null);
    r1.forEach((n, i) => expect(r2[i]).toBe(n));
    expect(r1.every((n) => n.data.lod === 'full' && !n.data.hub)).toBe(true);
  });
});

describe('file focus empty-open guard', () => {
  it('does NOT open focus for files whose symbols are not interconnected', async () => {
    // 32 files × 2 symbols, chained n{i+1}→n{i}. Every file gets one
    // intra-file edge — EXCEPT f5 and f12, whose two symbols were swapped
    // into non-adjacent slots (no edge between them).
    const nodes: NonNullable<CodegraphVM['nodes']> = [];
    const edges: NonNullable<CodegraphVM['edges']> = [];
    for (let i = 0; i < 64; i++) {
      nodes.push({ id: `n${i}`, label: `N${i}`, kind: 'function', file: `f${i >> 1}.ts`, line: i });
    }
    nodes[10] = { ...nodes[10]!, file: 'f5.ts' };
    nodes[25] = { ...nodes[25]!, file: 'f5.ts' };
    nodes[11] = { ...nodes[11]!, file: 'f12.ts' };
    nodes[24] = { ...nodes[24]!, file: 'f12.ts' };
    for (let i = 1; i < 64; i++) edges.push({ source: `n${i}`, target: `n${i - 1}`, kind: 'calls' });

    // File-level rollup: group symbol edges by (file(source), file(target)).
    const fileOf = (id: string): string => nodes.find((n) => n.id === id)?.file ?? '';
    const pairs = new Map<string, { source: string; target: string; kind: string; count: number }>();
    for (const e of edges) {
      const s = fileOf(e.source);
      const t = fileOf(e.target);
      const key = `${s}|${t}|${e.kind}`;
      const cur = pairs.get(key);
      if (cur) cur.count += 1;
      else pairs.set(key, { source: s, target: t, kind: e.kind, count: 1 });
    }
    const fileCounts = new Map<string, number>();
    for (const n of nodes) fileCounts.set(n.file, (fileCounts.get(n.file) ?? 0) + 1);
    const vm: CodegraphVM = {
      product: 'colby',
      hasFts: false,
      nodes,
      edges,
      fileRollup: {
        files: [...fileCounts.entries()].map(([file, symbols]) => ({ file, symbols, kinds: { function: symbols } })),
        edges: [...pairs.values()],
        totals: { files: fileCounts.size, symbols: 64, edges: 63 },
      },
    };

    renderVm(vm);
    await flushFlow();

    // f5 has two symbols but NO connection between them → focus stays closed.
    await act(async () => {
      fireEvent.click(document.querySelector('[data-id="f5.ts"]') as Element);
      await Promise.resolve();
    });
    expect(document.querySelector('.archgen-cg-breadcrumb')).toBeNull();
    expect(screen.queryByTestId('cg-back-chip')).toBeNull();

    // f0 HAS an internal edge (n1→n0) → focus opens with the breadcrumb.
    await act(async () => {
      fireEvent.click(document.querySelector('[data-id="f0.ts"]') as Element);
      await Promise.resolve();
    });
    expect(document.querySelector('.archgen-cg-breadcrumb')).toBeTruthy();
    expect(document.querySelectorAll('[data-testid="cg-back-chip"]').length).toBe(1);
  });
});
