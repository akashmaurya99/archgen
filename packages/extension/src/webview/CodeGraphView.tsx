// CodeGraphView.tsx — CODE tab (todo 12).
//
// Consumes the CodegraphVM the host snapshots from src/host/codegraph.ts.
// Interaction model: edge-kind chips filter edges; the search box filters
// nodes client-side (hasFts signals host-side FTS is available for future
// server-assisted search); selecting a node highlights its direct
// neighborhood and shows an impact badge (direct dependents). Beyond 500
// nodes onlyRenderVisibleElements keeps the canvas cheap. Unsupported
// products render a friendly banner instead of a graph.
import { memo, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { CodegraphVM } from '../shared/protocol';
import { layoutLeftToRight } from './layout';
import {
  EDGE_KINDS,
  colorForKind,
  filterEdges,
  impactCount,
  matchesQuery,
  neighborhoodOf,
  shouldVirtualize,
} from './graph-model';

type GraphNodeData = {
  label: string;
  kind: string;
  dimmed: boolean;
  selected: boolean;
};
type GraphFlowNode = Node<GraphNodeData, 'gnode'>;

function GraphNodeComponent({ data }: NodeProps<GraphFlowNode>) {
  return (
    <div className={`archgen-gnode${data.selected ? ' is-selected' : ''}${data.dimmed ? ' is-dimmed' : ''}`}>
      <i aria-hidden="true" className="archgen-kind-dot" style={{ background: colorForKind(data.kind) }} />
      <span className="archgen-gnode-label">{data.label}</span>
    </div>
  );
}

const GraphNode = memo(GraphNodeComponent);

const graphNodeTypes: NodeTypes = { gnode: GraphNode };

export interface CodeGraphViewProps {
  vm: CodegraphVM;
}

export function CodeGraphView({ vm }: CodeGraphViewProps) {
  const [query, setQuery] = useState('');
  const [enabledKinds, setEnabledKinds] = useState<Set<string>>(() => new Set(EDGE_KINDS));
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const nodes = vm.nodes ?? [];
  const edges = vm.edges ?? [];

  const visibleEdges = useMemo(() => filterEdges(edges, enabledKinds), [edges, enabledKinds]);
  const visibleNodes = useMemo(() => nodes.filter((n) => matchesQuery(n, query)), [nodes, query]);
  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  const neighborhood = useMemo(
    () => (selectedId ? neighborhoodOf(visibleEdges, selectedId) : null),
    [visibleEdges, selectedId],
  );
  const impact = useMemo(() => (selectedId ? impactCount(edges, selectedId) : 0), [edges, selectedId]);

  const laidOut = useMemo(() => {
    const seeds = visibleNodes.map((n) => ({
      id: n.id,
      position: { x: 0, y: 0 },
      width: 150,
      height: 40,
      style: { width: 150, height: 40 },
    }));
    return layoutLeftToRight(seeds, visibleEdges, { nodeWidth: 150, nodeHeight: 40 });
  }, [visibleNodes, visibleEdges]);

  const flowNodes = useMemo<GraphFlowNode[]>(
    () =>
      laidOut.map((n) => ({
        id: n.id,
        type: 'gnode' as const,
        position: n.position,
        width: n.width,
        height: n.height,
        style: n.style,
        draggable: false,
        data: {
          label: visibleNodes.find((v) => v.id === n.id)?.label ?? n.id,
          kind: visibleNodes.find((v) => v.id === n.id)?.kind ?? 'unknown',
          dimmed: neighborhood !== null && !neighborhood.nodeIds.has(n.id),
          selected: selectedId === n.id,
        },
      })),
    [laidOut, visibleNodes, neighborhood, selectedId],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      visibleEdges
        .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
        .map((e, i) => ({
          id: `${e.source}->${e.target}:${e.kind}:${i}`,
          source: e.source,
          target: e.target,
          animated: neighborhood?.edgeIdx.has(i) ?? false,
          className:
            neighborhood && !neighborhood.edgeIdx.has(i) ? 'archgen-edge--dimmed' : `archgen-edge--${e.kind}`,
          label: e.kind,
        })),
    [visibleEdges, visibleIds, neighborhood],
  );

  if (vm.product === 'unsupported') {
    return (
      <div className="archgen-state archgen-banner-unsupported" role="status">
        <h2>Codegraph unavailable</h2>
        <p>{vm.unsupportedReason ?? 'No supported codegraph index found in this workspace.'}</p>
      </div>
    );
  }

  const toggleKind = (k: string): void => {
    setEnabledKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  return (
    <section
      className="archgen-code-view"
      aria-label="Code dependency graph"
      data-testid="code-graph-view"
      data-virtualized={shouldVirtualize(nodes.length) ? 'true' : 'false'}
    >
      <div className="archgen-cg-toolbar">
        <input
          type="search"
          className="archgen-cg-search"
          placeholder={vm.hasFts ? 'Search symbols (FTS-backed index)…' : 'Search symbols…'}
          aria-label="Search nodes by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="archgen-cg-chips" role="group" aria-label="Edge kind filters">
          {EDGE_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={`archgen-chip-btn${enabledKinds.has(k) ? ' is-on' : ''}`}
              aria-pressed={enabledKinds.has(k)}
              onClick={() => toggleKind(k)}
            >
              {k}
            </button>
          ))}
        </div>
        {selectedId && (
          <span className="archgen-impact-badge" role="status" aria-label={`Impact of ${selectedId}`}>
            {selectedId}: {impact} direct dependent{impact === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {/* key resets the canvas when virtualization flips so fitView re-runs */}
      <ReactFlow
        key={shouldVirtualize(nodes.length) ? 'virtualized' : 'plain'}
        nodeTypes={graphNodeTypes}
        nodes={flowNodes}
        edges={flowEdges}
        onlyRenderVisibleElements={shouldVirtualize(nodes.length)}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.1}
        panOnScroll
        zoomOnDoubleClick={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={(_, node) => setSelectedId((prev) => (prev === node.id ? null : node.id))}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable ariaLabel="Code graph minimap" nodeColor={(n) => colorForKind((n.data as GraphNodeData)?.kind ?? '')} />
      </ReactFlow>
      <span hidden data-testid="cg-counts">
        nodes={flowNodes.length} edges={flowEdges.length}
      </span>
    </section>
  );
}
