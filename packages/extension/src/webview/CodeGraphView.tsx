// CodeGraphView.tsx — CODE tab · enterprise dependency explorer.
//
// ONE shared canvas renders EVERY connected component: radial mode packs one
// kind-clustered ring per component (shelf-packed 3 per row); flow mode packs
// one isolated dagre block per component. Component chips fit-view to their
// cluster. Selection is global on the shared canvas — everything outside the
// selected node's transitive neighborhood dims, including other components.
//
// SIZE-TIER AUTO-MODE: when the host supplies vm.fileRollup, the largest
// component's symbol count picks the presentation — ≤60 keeps radial rings,
// 61–300 aggregates to FILE nodes (dagre blocks per file-component) with a
// click-through symbol focus per file, >300 boots into the top hub's file
// neighborhood (≤40 files) behind a "Show all" banner. No rollup → legacy
// behavior for any size.
//
// ZOOM LOD: one quantized zoom value lives HERE (never per-node React state).
// A bridge child inside <ReactFlow> subscribes via useStore(transform[2]),
// rAF-coalesces and reports 0.05-step zoom; nodes receive their lod tier via
// data so reconcileCachedNodes replaces ONLY tier-flipped objects.
//
// XYFLOW v12 PERF RULES: nodeTypes/edgeTypes at MODULE SCOPE, memo()ized node
// components, stable callbacks, identity-reconciled node objects (highlight
// toggles re-render ONLY flipped nodes), real <Handle> elements on every
// node (v12 resolves edge endpoints exclusively from handle DOM), and
// onlyRenderVisibleElements beyond 500 nodes.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  getBezierPath,
  useStore,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
  type ReactFlowState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '../../media/webview/dag.css';
import type { CodegraphVM } from '../shared/protocol';
import { ArchGenIcon } from './states';
import {
  CODE_NODE_HEIGHT,
  CODE_NODE_WIDTH,
  EDGE_KINDS,
  SEARCH_DEBOUNCE_MS,
  UNLINKED_COMPONENT_ID,
  colorForEdgeKind,
  colorForKind,
  connectedComponents,
  connectedComponentOf,
  edgeKindCounts,
  filterEdges,
  impactCount,
  matchesQuery,
  shouldVirtualize,
} from './graph-model';
import {
  FOCUS_FILE_CAP,
  HUB_DEGREE_THRESHOLD,
  RADIAL_TIER_MAX_NODES,
  adjustLodForHub,
  basename,
  buildFileNodes,
  degreeMap,
  focusNeighborhoodFiles,
  layoutFlowGrouped,
  layoutRadialGrouped,
  lodTierFor,
  pickTopHub,
  quantizeZoom,
  selectSizeTier,
  type FileRollupEdge,
  type GraphSizeTier,
  type LodTier,
} from './graph-grouped';

export interface GraphNodeMeta {
  id: string;
  label: string;
  kind: string;
  file: string;
  line: number;
}

type GraphNodeData = {
  label: string;
  kind: string;
  file: string;
  line: number;
  dimmed: boolean;
  selected: boolean;
  lod: LodTier;
  hub: boolean;
  openable: boolean;
  captionText?: string;
  titleText?: string;
};
export type GraphFlowNode = Node<GraphNodeData, 'gnode'>;

type RingData = {
  width: number;
  height: number;
  circles: Array<{ cx: number; cy: number; r: number }>;
  anchors: Array<{ x: number; y: number; color: string }>;
  labels: Array<{ x: number; y: number; text: string }>;
};
type RingFlowNode = Node<RingData, 'ring'>;

type LayoutMode = 'radial' | 'flow';

interface LaidOutSeed {
  id: string;
  position: { x: number; y: number };
  face?: 'left' | 'right' | 'top' | 'bottom';
}

const FACE_TO_POSITION: Record<NonNullable<LaidOutSeed['face']>, Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
};

/**
 * Identity-reconciling node builder: cached object whenever nothing rendered
 * changed, so React.memo skips untouched nodes (≤2-render budget philosophy).
 * `extras` carries LOD tiers + synthetic file-node copy; a node object is
 * replaced only when one of its rendered fields actually flipped.
 */
export interface ReconcileExtras {
  lodById?: ReadonlyMap<string, LodTier>;
  hubIds?: ReadonlySet<string>;
  captionById?: ReadonlyMap<string, string>;
  titleById?: ReadonlyMap<string, string>;
  openableById?: ReadonlySet<string>;
}

export function reconcileCachedNodes(
  cache: Map<string, GraphFlowNode>,
  laidOut: readonly LaidOutSeed[],
  metaById: ReadonlyMap<string, GraphNodeMeta>,
  selectedId: string | null,
  neighborhoodNodeIds: ReadonlySet<string> | null,
  extras: ReconcileExtras = {},
): GraphFlowNode[] {
  const { lodById, hubIds, captionById, titleById, openableById } = extras;
  const placedIds = new Set<string>();
  const out = laidOut.map((n) => {
    placedIds.add(n.id);
    const meta = metaById.get(n.id);
    const label = meta?.label ?? n.id;
    const kind = meta?.kind ?? 'unknown';
    const file = meta?.file ?? '';
    const line = meta?.line ?? 0;
    const dimmed = neighborhoodNodeIds !== null && !neighborhoodNodeIds.has(n.id);
    const selected = selectedId === n.id;
    const openable = openableById?.has(n.id) ?? false;
    const lod = lodById?.get(n.id) ?? 'full';
    const hub = hubIds?.has(n.id) ?? false;
    const captionText = captionById?.get(n.id);
    const titleText = titleById?.get(n.id);
    const sourcePosition = n.face ? FACE_TO_POSITION[n.face] : Position.Right;
    const targetPosition = n.face ? FACE_TO_POSITION[n.face] : Position.Left;
    const prev = cache.get(n.id);
    if (
      prev &&
      prev.position.x === n.position.x &&
      prev.position.y === n.position.y &&
      prev.data.label === label &&
      prev.data.kind === kind &&
      prev.data.file === file &&
      prev.data.line === line &&
      prev.data.dimmed === dimmed &&
      prev.data.selected === selected &&
      prev.data.lod === lod &&
      prev.data.hub === hub &&
      prev.data.openable === openable &&
      prev.data.captionText === captionText &&
      prev.data.titleText === titleText &&
      prev.sourcePosition === sourcePosition &&
      prev.targetPosition === targetPosition
    ) {
      return prev;
    }
    const next: GraphFlowNode = {
      id: n.id,
      type: 'gnode' as const,
      position: n.position,
      width: CODE_NODE_WIDTH,
      height: CODE_NODE_HEIGHT,
      style: { width: CODE_NODE_WIDTH, height: CODE_NODE_HEIGHT },
      sourcePosition,
      targetPosition,
      draggable: false,
      data: { label, kind, file, line, dimmed, selected, lod, hub, openable, captionText, titleText },
    };
    cache.set(n.id, next);
    return next;
  });
  // Prune stale entries: ids that left the current layout (model swap,
  // filter, search) must not keep holding cached node objects.
  for (const id of cache.keys()) {
    if (!placedIds.has(id)) cache.delete(id);
  }
  return out;
}

function GraphNodeComponent({
  data,
  sourcePosition = Position.Right,
  targetPosition = Position.Left,
}: NodeProps<GraphFlowNode>) {
  const isFile = data.kind === 'file';
  const cls = [
    'archgen-gnode',
    `is-lod-${data.lod}`,
    data.hub ? 'is-hub' : '',
    data.selected ? 'is-selected' : '',
    data.dimmed ? 'is-dimmed' : '',
    isFile && data.openable ? 'is-openable' : '',
    isFile && !data.openable ? 'is-inert' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={cls}
      title={data.titleText ?? `${data.label}\n${data.file}:${data.line} (${data.kind})`}
      aria-pressed={data.selected}
    >
      <Handle type="target" position={targetPosition} isConnectable={false} className="archgen-gnode-handle" />
      <i aria-hidden="true" className="archgen-kind-dot" style={{ background: colorForKind(data.kind) }} />
      <span className="archgen-gnode-text">
        <span className="archgen-gnode-label">{data.label}</span>
        <span className="archgen-gnode-caption">{data.captionText ?? `${data.file}:${data.line}`}</span>
      </span>
      {isFile && data.openable && (
        <span aria-hidden="true" className="archgen-gnode-drill">
          <svg width="10" height="12" viewBox="0 0 10 12" style={{ marginLeft: 1 }}>
            <path d="M1 1.5 L9 6 L1 10.5 Z" fill="currentColor" />
          </svg>
        </span>
      )}
      <Handle type="source" position={sourcePosition} isConnectable={false} className="archgen-gnode-handle" />
    </div>
  );
}

const GraphNode = memo(GraphNodeComponent);

type FileEdgeData = { count: number; tooltip: string };
export type FileFlowEdge = Edge<FileEdgeData, 'fileEdge'>;

const FileEdgeComponent = memo(function FileEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps<FileFlowEdge>) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      <title>{data?.tooltip}</title>
    </>
  );
});

const RingComponent = memo(function RingComponent({ data }: NodeProps<RingFlowNode>) {
  return (
    <svg
      className="archgen-ring-svg"
      width={data.width}
      height={data.height}
      viewBox={`0 0 ${data.width} ${data.height}`}
      aria-hidden="true"
    >
      {data.circles.map((c, i) => (
        <circle key={`c${i}`} cx={c.cx} cy={c.cy} r={c.r} fill="none" stroke="var(--archgen-hairline)" strokeWidth={1.5} />
      ))}
      {data.anchors.map((a, i) => (
        <circle key={`a${i}`} cx={a.x} cy={a.y} r={4.5} fill={a.color} stroke="var(--archgen-surface-elevated)" strokeWidth={1.5} />
      ))}
      {data.labels.map((l, i) => (
        <text
          key={`l${i}`}
          x={l.x}
          y={l.y}
          className="archgen-ring-label"
          textAnchor={i === 0 && data.circles.length > 0 ? 'middle' : 'start'}
        >
          {l.text}
        </text>
      ))}
    </svg>
  );
});

const graphNodeTypes: NodeTypes = { gnode: GraphNode, ring: RingComponent };

/** Max anchor dots drawn on ring layers — beyond this they overlap into a
 *  solid line anyway, so sampling keeps jsdom/DOM cost flat at 50k nodes. */
const MAX_RING_ANCHORS = 120;

function sampleAnchors(anchors: RingData['anchors']): RingData['anchors'] {
  if (anchors.length <= MAX_RING_ANCHORS) return anchors;
  const stride = Math.ceil(anchors.length / MAX_RING_ANCHORS);
  const out: RingData['anchors'] = [];
  for (let i = 0; i < anchors.length; i += stride) {
    const a = anchors[i];
    if (a) out.push(a);
  }
  return out;
}
const graphEdgeTypes: EdgeTypes = { fileEdge: FileEdgeComponent };

/**
 * The ONE zoom listener in the view. Lives inside <ReactFlow> (store context),
 * reads transform[2] via useStore, quantizes to 0.05 steps and coalesces
 * bursts before reporting upstream — smooth zoom gestures cost at most one
 * parent render per step-boundary crossing. Scheduling is rAF-primary with a
 * short timeout fallback: backgrounded VS Code webviews throttle rAF, and the
 * fallback keeps LOD responsive there too.
 */
const ZOOM_REPORT_FALLBACK_MS = 50;

function ZoomLodBridge({ onZoom }: { onZoom: (zoom: number) => void }) {
  const rawZoom = useStore((s: ReactFlowState) => s.transform[2] ?? 1);
  const cancelRef = useRef<(() => void) | null>(null);
  const pendingRef = useRef(quantizeZoom(1));
  const lastRef = useRef(quantizeZoom(1));
  const primedRef = useRef(false);

  useEffect(() => {
    pendingRef.current = quantizeZoom(rawZoom);
    // First run ADOPTS the initial fitted zoom as the LOD baseline silently —
    // reporting it would cascade full-view re-renders straight into xyflow's
    // node-measure storm on large graphs.
    if (!primedRef.current) {
      primedRef.current = true;
      lastRef.current = pendingRef.current;
      return;
    }
    if (pendingRef.current === lastRef.current) return;
    if (cancelRef.current !== null) return;
    let done = false;
    const fire = (): void => {
      if (done) return;
      done = true;
      cancelRef.current = null;
      if (pendingRef.current !== lastRef.current) {
        lastRef.current = pendingRef.current;
        onZoom(lastRef.current);
      }
    };
    const rafId =
      typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fire) : null;
    const tid = setTimeout(fire, ZOOM_REPORT_FALLBACK_MS);
    cancelRef.current = () => {
      done = true;
      if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      clearTimeout(tid);
    };
    return undefined;
  }, [rawZoom, onZoom]);

  useEffect(
    () => () => {
      cancelRef.current?.();
    },
    [],
  );

  return null;
}

export interface ComponentChip {
  id: string;
  label: string;
  nodeIds: string[];
}

function CanvasToolbar({ chips, hasSelection, onClear }: {
  chips: ComponentChip[];
  hasSelection: boolean;
  onClear: () => void;
}) {
  const { fitView } = useReactFlow();
  return (
    <Panel position="top-left" className="archgen-cg-panel">
      <button
        type="button"
        className="archgen-cg-fit-btn"
        aria-label="Zoom to fit"
        title="Zoom to fit"
        onClick={() => {
          void fitView({ padding: 0.2, maxZoom: 1 });
        }}
      >
        ⤢ Fit
      </button>
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          className="archgen-cg-fit-chip"
          aria-label={`Fit component ${chip.label}`}
          title={`Fit component ${chip.label}`}
          onClick={() => {
            void fitView({ nodes: chip.nodeIds.map((id) => ({ id })), padding: 0.3, duration: 300, maxZoom: 1 });
          }}
        >
          {chip.label}
        </button>
      ))}
      {hasSelection && (
        <button type="button" className="archgen-cg-clear-btn" aria-label="Clear highlight" title="Clear highlight" onClick={onClear}>
          ✕
        </button>
      )}
    </Panel>
  );
}

/** What the canvas is currently drawing — one uniform shape for every tier. */
type ActiveUniverse =
  | { kind: 'symbols'; nodes: CodegraphVM['nodes']; edges: Array<{ source: string; target: string; kind: string }> }
  | { kind: 'files'; nodes: ReturnType<typeof buildFileNodes>; edges: FileRollupEdge[] }
  | { kind: 'focus'; nodes: NonNullable<CodegraphVM['nodes']>; edges: Array<{ source: string; target: string; kind: string }> };

export interface CodeGraphViewProps {
  vm: CodegraphVM;
  /** test/automation hook: fires once with the live xyflow instance */
  onFlowInit?: (instance: ReactFlowInstance) => void;
}

export function CodeGraphView({ vm, onFlowInit }: CodeGraphViewProps) {
  // rawQuery = what the input shows (urgent); query = debounced filter input.
  const [rawQuery, setRawQuery] = useState('');
  const [query, setQuery] = useState('');
  const [enabledKinds, setEnabledKinds] = useState<Set<string>>(() => new Set(EDGE_KINDS));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<LayoutMode>('radial');
  const [focusFile, setFocusFile] = useState<string | null>(null);
  const [zoomStep, setZoomStep] = useState(() => quantizeZoom(1));

  const nodes = vm.nodes ?? [];
  const edges = vm.edges ?? [];
  const rollup = vm.fileRollup ?? null;

  const tier: GraphSizeTier = useMemo(() => selectSizeTier(nodes, edges, rollup), [nodes, edges, rollup]);

  const handleZoomChange = useCallback((z: number): void => setZoomStep(z), []);
  const flowInstRef = useRef<ReactFlowInstance | null>(null);
  const didMountFitRef = useRef(false);
  const handleFlowInit = useCallback(
    (inst: ReactFlowInstance): void => {
      flowInstRef.current = inst;
      onFlowInit?.(inst);
    },
    [onFlowInit],
  );

  /* ---- file-level universe (file-hub / focus-first tiers) ---- */
  const fileUniverse = useMemo(() => {
    if (!rollup || tier === 'radial') return null;
    const allFiles = buildFileNodes(rollup);
    const symbolsByFile = new Map(rollup.files.map((f) => [f.file, f.symbols]));
    // ALL files render by default — no hub-scoping, no Show-all click.
    // Intra-file edges collapse to fX→fX self loops at file level — invisible
    // structure here, and their double-count would fake hub degrees.
    const scopedEdges = rollup.edges.filter((e) => e.source !== e.target);
    return {
      files: allFiles,
      edges: scopedEdges,
      symbolsByFile,
      totalFiles: rollup.totals?.files ?? allFiles.length,
    };
  }, [rollup, tier]);

  // Files whose SYMBOLS connect to each other — the only files whose focus
  // view renders a real graph (see the empty-focus guard in handleNodeClick).
  const internalEdgeFiles = useMemo(() => {
    const set = new Set<string>();
    for (const e of rollup?.edges ?? []) if (e.source === e.target) set.add(e.source);
    return set;
  }, [rollup]);

  const active = useMemo<ActiveUniverse>(() => {
    if (fileUniverse && focusFile !== null) {
      const syms = nodes.filter((n) => n.file === focusFile);
      const symIds = new Set(syms.map((n) => n.id));
      return { kind: 'focus', nodes: syms, edges: edges.filter((e) => symIds.has(e.source) && symIds.has(e.target)) };
    }
    if (fileUniverse) return { kind: 'files', nodes: fileUniverse.files, edges: fileUniverse.edges };
    return { kind: 'symbols', nodes, edges };
  }, [fileUniverse, focusFile, nodes, edges]);

  const visibleEdges = useMemo(() => filterEdges(active.edges, enabledKinds), [active.edges, enabledKinds]);
  const visibleNodes = useMemo(() => (active.nodes ?? []).filter((n) => matchesQuery(n, query)), [active.nodes, query]);
  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  const searchableEdges = useMemo(
    () => active.edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target)),
    [active.edges, visibleIds],
  );
  const kindCounts = useMemo(() => edgeKindCounts(searchableEdges), [searchableEdges]);

  const routableEdges = useMemo(
    () =>
      visibleEdges
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => visibleIds.has(e.source) && visibleIds.has(e.target)),
    [visibleEdges, visibleIds],
  );

  const degrees = useMemo(() => degreeMap(routableEdges.map(({ e }) => e)), [routableEdges]);
  const hubIds = useMemo(() => {
    const hubs = new Set<string>();
    for (const [id, deg] of degrees) {
      if (deg >= HUB_DEGREE_THRESHOLD) hubs.add(id);
    }
    return hubs;
  }, [degrees]);

  const metaById = useMemo(() => {
    if (active.kind === 'files') {
      return new Map(
        active.nodes.map(
          (f): [string, GraphNodeMeta] => [f.id, { id: f.id, label: f.label, kind: 'file', file: f.file, line: 0 }],
        ),
      );
    }
    return new Map(nodes.map((n) => [n.id, n as GraphNodeMeta]));
  }, [active, nodes]);

  // LIVE-UPDATE LIFECYCLE — the host pushes a NEW vm object on every
  // rAF-batched patch, so keying these resets to vm identity would wipe
  // drill/selection state on every background refresh. Clear focus ONLY when
  // the focused file disappeared from the file universe (deleted file / gone
  // rollup / product swap / tier back to radial), and selection ONLY when the
  // node left the active universe — clearing selectedId also resets the
  // neighborhood/impact badge (both derive from it). Never re-key on `vm`.
  useEffect(() => {
    if (focusFile !== null && (!fileUniverse || !fileUniverse.symbolsByFile.has(focusFile))) {
      setFocusFile(null);
    }
  }, [vm.product, fileUniverse, focusFile]);

  useEffect(() => {
    if (selectedId !== null && !metaById.has(selectedId)) {
      setSelectedId(null);
    }
  }, [metaById, selectedId]);

  // SEARCH DEBOUNCE — every keystroke resets the timer, so a typing burst
  // triggers ONE matchesQuery + connectedComponents + dagre relayout after
  // the window settles instead of one per key. Cleanup clears the pending
  // timer on unmount. Deps are the primitive itself — never object identity.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(rawQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [rawQuery]);

  // Radial rings only scale to the tier budget; a larger LINKED component (or
  // a missing rollup on a huge graph) degrades to isolated per-component flow
  // blocks instead of an unreadable 20k-px ring. The unlinked singleton
  // bucket is skipped — it renders as a compact grid, never a ring, so loose
  // symbols must not demote linked rings to flow blocks (todo 13).
  const largestComponent = useMemo(() => {
    let largest = 0;
    for (const comp of connectedComponents(visibleNodes, routableEdges.map(({ e }) => e))) {
      if (comp.id === UNLINKED_COMPONENT_ID) continue;
      if (comp.nodes.length > largest) largest = comp.nodes.length;
    }
    return largest;
  }, [visibleNodes, routableEdges]);

  const grouped = useMemo(() => {
    const routed = routableEdges.map(({ e }) => e);
    const radialAllowed = mode === 'radial' && largestComponent <= RADIAL_TIER_MAX_NODES;
    if (active.kind === 'files') return layoutFlowGrouped(visibleNodes, routed);
    if (active.kind === 'focus' || radialAllowed) return layoutRadialGrouped(visibleNodes, routed, { groupByKind: true });
    return layoutFlowGrouped(visibleNodes, routed);
  }, [active.kind, mode, largestComponent, visibleNodes, routableEdges]);

  const neighborhood = useMemo(
    () => (selectedId ? connectedComponentOf(routableEdges.map(({ e }) => e), selectedId) : null),
    [routableEdges, selectedId],
  );
  const impact = useMemo(() => (selectedId ? impactCount(active.edges, selectedId) : 0), [active.edges, selectedId]);

  const lodTier = lodTierFor(zoomStep);
  const hideMinorEdges = lodTier === 'dot';

  // A file is OPENABLE exactly when its focus view would render a real
  // graph: >=2 symbols AND at least one connection between them. Same rule
  // the click-guard enforces — affordance and behavior can never diverge.
  const openableById = useMemo(() => {
    const set = new Set<string>();
    if (!fileUniverse) return set;
    for (const f of fileUniverse.files) {
      if ((fileUniverse.symbolsByFile.get(f.id) ?? 0) >= 2 && internalEdgeFiles.has(f.id)) set.add(f.id);
    }
    return set;
  }, [fileUniverse, internalEdgeFiles]);

  const cacheRef = useRef(new Map<string, GraphFlowNode>());
  const cardNodes = useMemo<GraphFlowNode[]>(() => {
    const lodById = new Map<string, LodTier>();
    for (const p of grouped.placements) {
      lodById.set(p.id, adjustLodForHub(lodTier, hubIds.has(p.id)));
    }
    let captionById: Map<string, string> | undefined;
    let titleById: Map<string, string> | undefined;
    if (active.kind === 'files' && fileUniverse) {
      captionById = new Map();
      titleById = new Map();
      for (const f of fileUniverse.files) {
        const symCount = fileUniverse.symbolsByFile.get(f.id) ?? 0;
        captionById.set(f.id, `${symCount} symbol${symCount === 1 ? '' : 's'}`);
        titleById.set(f.id, `${basename(f.id)}\n${f.id}\n${symCount} symbol${symCount === 1 ? '' : 's'}`);
      }
    }
    return reconcileCachedNodes(cacheRef.current, grouped.placements, metaById, selectedId, neighborhood?.nodeIds ?? null, {
      lodById,
      hubIds,
      captionById,
      titleById,
      openableById,
    });
  }, [grouped, metaById, selectedId, neighborhood, lodTier, hubIds, active.kind, fileUniverse, openableById]);

  const ringNode = useMemo<RingFlowNode | null>(() => {
    if (grouped.circles.length === 0 || grouped.placements.length === 0) return null;
    return {
      id: '__ring',
      type: 'ring' as const,
      position: { x: 0, y: 0 },
      width: grouped.width,
      height: grouped.height,
      style: { width: grouped.width, height: grouped.height },
      draggable: false,
      selectable: false,
      focusable: false,
      deletable: false,
      connectable: false,
      zIndex: 0,
      data: {
        width: grouped.width,
        height: grouped.height,
        circles: grouped.circles,
        anchors: sampleAnchors(grouped.anchors),
        labels: grouped.labels,
      },
    };
  }, [grouped]);

  const flowNodes = useMemo<Node[]>(
    () => (ringNode ? [ringNode, ...cardNodes] : cardNodes),
    [ringNode, cardNodes],
  );

  const fileEdgeCounts = useMemo(() => {
    if (active.kind !== 'files') return null;
    const counts = new Map<string, number>();
    for (const e of active.edges) counts.set(`${e.source}|${e.target}|${e.kind}`, e.count);
    return counts;
  }, [active]);

  const flowEdges = useMemo<Edge[]>(() => {
    return routableEdges.map(({ e, i }) => {
      const highlighted = neighborhood?.edgeIdx.has(i) ?? false;
      const stroke = colorForEdgeKind(e.kind);
      const minor =
        (degrees.get(e.source) ?? 0) < HUB_DEGREE_THRESHOLD && (degrees.get(e.target) ?? 0) < HUB_DEGREE_THRESHOLD;
      const hidden = hideMinorEdges && !highlighted && minor;
      const base: Edge = {
        id: `${e.source}->${e.target}:${e.kind}:${i}`,
        source: e.source,
        target: e.target,
        animated: highlighted,
        hidden,
        className: `archgen-edge--${e.kind}${
          neighborhood ? (highlighted ? ' archgen-edge--highlighted' : ' archgen-edge--dimmed') : ''
        }`,
        style: { stroke, strokeWidth: highlighted ? 3.5 : 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 16, height: 16 },
      };
      if (active.kind !== 'files') return base;
      const count = fileEdgeCounts?.get(`${e.source}|${e.target}|${e.kind}`) ?? 1;
      return {
        ...base,
        type: 'fileEdge' as const,
        data: {
          count,
          tooltip: `${basename(e.source)} → ${basename(e.target)} · ${count} edge${count === 1 ? '' : 's'} (${e.kind})`,
        },
      };
    });
  }, [routableEdges, neighborhood, degrees, hideMinorEdges, active.kind, fileEdgeCounts]);

  const chips = useMemo<ComponentChip[]>(
    () =>
      grouped.regions.map((r) => ({
        id: r.id,
        label: r.id === 'unlinked' ? `loose ×${r.nodeCount}` : `${r.id} · ${r.nodeCount}`,
        nodeIds: grouped.placements.filter((p) => p.componentId === r.id).map((p) => p.id),
      })),
    [grouped],
  );

  // Universe swaps (tier/mode/focus/reveal) refit the PERSISTENT canvas.
  // An immediate imperative fitView measures stale pre-layout bounds and
  // clamps to minZoom, so the refit lands twice: once after the first
  // measure pass settles, once to guarantee convergence.
  const planKey = `${tier}|${mode}|${focusFile ?? ''}|${active.kind}`;
  useEffect(() => {
    if (!didMountFitRef.current) {
      didMountFitRef.current = true;
      return;
    }
    const settle = (): void => {
      void flowInstRef.current?.fitView({ padding: 0.2, maxZoom: 1 });
    };
    const t1 = setTimeout(settle, 60);
    const t2 = setTimeout(settle, 220);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [planKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setFocusFile(null);
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleKind = useCallback((k: string): void => {
    setEnabledKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  const handleNodeClick = useCallback(
    (_: ReactMouseEvent, node: Node): void => {
      // Only real graph cards are selectable — clicking the __ring decoration
      // would select a ghost id absent from metaById, dimming the whole graph.
      if (node.type !== 'gnode') return;
      if (fileUniverse && (node.data as GraphNodeData | undefined)?.kind === 'file') {
        // Affordance == behavior: only nodes flagged openable open focus.
        if (!openableById.has(node.id)) return;
        setFocusFile(node.id);
        setSelectedId(null);
        return;
      }
      setSelectedId((prev) => (prev === node.id ? null : node.id));
    },
    [fileUniverse, openableById],
  );

  const clearSelection = useCallback((): void => setSelectedId(null), []);
  const clearFocus = useCallback((): void => setFocusFile(null), []);

  if (vm.product === 'unsupported') {
    return (
      <div className="archgen-state archgen-state--empty archgen-banner-unsupported" role="status">
        <ArchGenIcon />
        <h2>Codegraph unavailable</h2>
        <p>{vm.unsupportedReason ?? 'No supported codegraph index found in this workspace.'}</p>
      </div>
    );
  }

  return (
    <section
      className="archgen-code-view"
      aria-label="Code dependency graph"
      data-testid="code-graph-view"
      data-tier={tier}
      data-lod={lodTier}
      data-virtualized={shouldVirtualize(nodes.length) ? 'true' : 'false'}
    >
      <div className="archgen-cg-toolbar">
        <input
          type="search"
          className="archgen-cg-search"
          placeholder={vm.hasFts ? 'Search symbols (FTS-backed index)…' : 'Search symbols…'}
          aria-label="Search nodes by name"
          value={rawQuery}
          onChange={(e) => setRawQuery(e.target.value)}
        />
        {tier === 'radial' ? (
          <div className="archgen-cg-mode" role="group" aria-label="Graph layout mode">
            <button
              type="button"
              className={`archgen-cg-mode-btn${mode === 'radial' ? ' is-active' : ''}`}
              aria-pressed={mode === 'radial'}
              onClick={() => setMode('radial')}
            >
              ◉ Radial
            </button>
            <button
              type="button"
              className={`archgen-cg-mode-btn${mode === 'flow' ? ' is-active' : ''}`}
              aria-pressed={mode === 'flow'}
              onClick={() => setMode('flow')}
            >
              ⇥ Flow
            </button>
          </div>
        ) : (
          <span className="archgen-cg-tier-badge" data-testid="cg-tier-badge" role="status">
            {`${fileUniverse?.totalFiles ?? 0} files`}
          </span>
        )}

        <div className="archgen-cg-chips" role="group" aria-label="Edge kind filters">
          {EDGE_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={`archgen-chip-btn${enabledKinds.has(k) ? ' is-on' : ''}`}
              aria-pressed={enabledKinds.has(k)}
              onClick={() => toggleKind(k)}
            >
              <i aria-hidden="true" className="archgen-kind-dot" style={{ background: colorForEdgeKind(k) }} />
              {`${k} ×${kindCounts[k] ?? 0}`}
            </button>
          ))}
        </div>
        {selectedId && (
          <>
            <span className="archgen-impact-badge" role="status" aria-label={`Impact of ${selectedId}`}>
              {selectedId}: {impact} direct dependent{impact === 1 ? '' : 's'}
            </span>
            <button type="button" className="archgen-cg-clear-btn" onClick={clearSelection}>
              Clear selection
            </button>
          </>
        )}
      </div>

      <div className="archgen-cg-canvas">
        {fileUniverse && focusFile !== null && (
          <nav className="archgen-cg-breadcrumb" aria-label="Focus breadcrumb">
            <button type="button" className="archgen-cg-back-chip" data-testid="cg-back-chip" onClick={clearFocus}>
              ‹ All files
            </button>
            <span className="archgen-cg-breadcrumb-sep" aria-hidden="true">/</span>
            <span className="archgen-cg-breadcrumb-current">
              {focusFile.split('/').pop()} · {fileUniverse.symbolsByFile.get(focusFile) ?? 0} symbols
            </span>
          </nav>
        )}
        <ReactFlow
          nodeTypes={graphNodeTypes}
          edgeTypes={graphEdgeTypes}
          nodes={flowNodes}
          edges={flowEdges}
          onlyRenderVisibleElements={shouldVirtualize(nodes.length)}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.04}
          maxZoom={4}
          zoomOnScroll
          zoomOnPinch
          zoomOnDoubleClick={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          onInit={handleFlowInit}
          onNodeClick={handleNodeClick}
          onPaneClick={clearSelection}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <ZoomLodBridge onZoom={handleZoomChange} />
          <CanvasToolbar chips={chips} hasSelection={selectedId !== null} onClear={clearSelection} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            ariaLabel="Code graph minimap"
            nodeColor={(n) => {
              if (n.type === 'ring') return 'transparent';
              return colorForKind((n.data as GraphNodeData)?.kind ?? '');
            }}
          />
        </ReactFlow>
      </div>
      <span hidden data-testid="cg-counts">
        nodes={flowNodes.length} edges={flowEdges.length}
      </span>
    </section>
  );
}
