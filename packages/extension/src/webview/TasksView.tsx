// TasksView.tsx — TASK DAG canvas (todo 8) + live status wiring (todo 10).
//
// DATA FLOW: host watcher diffs arrive as {type:'update',changed:[{id,status}]}
// → App routes them through StatusStore.applyBatch (rAF-batched, immutable)
// → this view re-renders ONLY the changed nodes:
//   - statuses come from ONE store index subscription (Record<id,status>);
//     shallow-equal dedupe means no state churn on unrelated flushes.
//   - node objects are cached per id and replaced ONLY when that node's status,
//     visibility (filter), handle sides (layout direction) or position changed
//     → memoized TaskNode components for untouched ids never re-render.
//   - edges are re-derived from the same record; `animated` flips ONLY when the
//     TARGET node is running ("flowing into running"), blocked targets get a
//     dashed-static class, failed targets a red-stroke class, every edge gets
//     an ArrowClosed markerEnd tinted with its target-status color.
//
// FILTERING: status chips toggle membership in an active-filter Set. Filtering
// is expressed via the xyflow `hidden` flag on nodes/edges — components stay
// MOUNTED in flow state (xyflow perf guidance), only their DOM is skipped.
// The per-id node cache compares `hidden` alongside `status`, so toggling a
// filter replaces objects solely for nodes whose visibility actually flipped;
// untouched ids keep their object identity and never re-render.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '../../media/webview/dag.css';
import { graphlib, layout as dagreLayout } from '@dagrejs/dagre';
import type { TaskStatus, TaskVM } from '../shared/protocol';
import { StatusStore } from '../host/store';
import { DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH, layoutLeftToRight, type Positioned } from './layout';
import { STATUS_ORDER } from './states';
import { taskNodeTypes, type TaskFlowNode } from './TaskNode';

export interface TasksViewProps {
  tasks: TaskVM[];
  store: StatusStore<TaskVM>;
  /** revealTask intent — node to spotlight + center; null/absent clears. */
  highlightId?: string | null;
  /** ▶ dispatch — App posts {type:'build',taskId} to the host. */
  onBuild?: (taskId: string) => void;
  /** Header "Start Work" — App posts {type:'startWork'} to the host. */
  onStartWork?: () => void;
}

/** MiniMap dot / edge-marker color per status — CSS vars keep it theme-adaptive. */
const STATUS_COLOR: Record<TaskStatus, string> = {
  pending: 'var(--archgen-status-pending)',
  ready: 'var(--archgen-status-ready)',
  running: 'var(--archgen-status-running)',
  blocked: 'var(--archgen-status-blocked)',
  done: 'var(--archgen-status-done)',
  failed: 'var(--archgen-status-failed)',
};

function selectStatuses(items: ReadonlyMap<string, TaskVM>): Record<string, TaskStatus> {
  const out: Record<string, TaskStatus> = {};
  for (const [id, t] of items) out[id] = t.status;
  return out;
}

/** Structural signature — layout + fitView re-run only when THIS changes. */
function structureKeyOf(tasks: TaskVM[]): string {
  return tasks.map((t) => `${t.id}(${t.dependsOn.join('+')})`).join('|');
}

/**
 * PERF BUDGET (todo 13): at most MAX_ANIMATED_EDGES edges carry the CSS
 * `animated` class (each runs an infinite dashdraw animation on the main
 * thread). Beyond the cap, running-target edges render as static strokes —
 * correctness (edge exists) is preserved, only the motion is shed.
 */
export const MAX_ANIMATED_EDGES = 50;

function deriveEdges(
  tasks: TaskVM[],
  statuses: Record<string, TaskStatus>,
  isNodeVisible: (id: string) => boolean,
): Edge[] {
  let animatedCount = 0;
  return tasks.flatMap((t) =>
    t.dependsOn
      .filter((d) => statuses[d] !== undefined || tasks.some((x) => x.id === d))
      .map((d) => {
        const targetStatus: TaskStatus = statuses[t.id] ?? 'pending';
        const wantsAnimation = targetStatus === 'running' && animatedCount < MAX_ANIMATED_EDGES;
        if (wantsAnimation) animatedCount++;
        return {
          id: `${d}->${t.id}`,
          source: d,
          target: t.id,
          animated: wantsAnimation,
          // Orphan rule: an edge whose EITHER endpoint is filtered out hides
          // with it — no dangling strokes pointing at invisible nodes.
          hidden: !isNodeVisible(d) || !isNodeVisible(t.id),
          markerEnd: { type: MarkerType.ArrowClosed, color: STATUS_COLOR[targetStatus] },
          className:
            targetStatus === 'failed'
              ? 'archgen-edge--failed'
              : targetStatus === 'blocked'
                ? 'archgen-edge--blocked'
                : undefined,
        };
      }),
  );
}

/**
 * Top-to-bottom variant of layoutLeftToRight (same dagre contract: pure,
 * non-mutating, unknown-edge tolerant). Lives here — not in layout.ts — so
 * the shared LR helper's hot path stays untouched.
 */
function layoutTopToBottom<T extends { id: string }>(
  nodes: T[],
  edges: ReadonlyArray<{ source: string; target: string }>,
): Array<T & Positioned> {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: 'TB', ranksep: 48, nodesep: 28, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));

  const known = new Set(nodes.map((n) => n.id));
  for (const n of nodes) g.setNode(n.id, { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT });
  for (const e of edges) {
    if (known.has(e.source) && known.has(e.target) && e.source !== e.target) {
      g.setEdge(e.source, e.target);
    }
  }

  dagreLayout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id) as { x: number; y: number };
    return { ...n, position: { x: pos.x - DEFAULT_NODE_WIDTH / 2, y: pos.y - DEFAULT_NODE_HEIGHT / 2 } };
  });
}

export function TasksView({ tasks, store, highlightId, onBuild, onStartWork }: TasksViewProps) {
  // Staleness guard (render-time, deterministic): a model refresh may drop the
  // revealed task — highlight falls back to none instead of a ghost id.
  const effectiveHighlight =
    highlightId != null && tasks.some((t) => t.id === highlightId) ? highlightId : null;

  const [statuses, setStatuses] = useState<Record<string, TaskStatus>>(() =>
    selectStatuses(new Map(store.ids().map((id) => [id, store.getById(id) as TaskVM]))),
  );

  // ONE index subscription for the whole canvas; fires at most once per store
  // flush and only when some status actually changed (store shallow-equality).
  useEffect(() => store.subscribeIndex(selectStatuses, setStatuses), [store]);

  // Ref-indirection keeps data.onBuild stable across renders so the per-id
  // node object cache below stays valid even when App re-creates the callback.
  const buildRef = useRef(onBuild);
  buildRef.current = onBuild;
  const dispatchBuild = useCallback((id: string) => buildRef.current?.(id), []);

  // LAYOUT DIRECTION (in-component state only — no host persistence surface):
  // default stays the historical left→right rank direction.
  const [direction, setDirection] = useState<'LR' | 'TB'>('LR');
  const toggleDirection = useCallback(() => setDirection((d) => (d === 'LR' ? 'TB' : 'LR')), []);

  // BEST-EFFORT CENTERING instance handle: captured via onInit because this
  // component renders <ReactFlow> itself (useReactFlow needs a provider).
  const flowRef = useRef<ReactFlowInstance<TaskFlowNode> | null>(null);

  // STATUS FILTERS: empty set ⇒ everything visible; otherwise the set lists
  // the statuses that remain on the board. Chips toggle membership.
  const [activeFilters, setActiveFilters] = useState<ReadonlySet<TaskStatus>>(() => new Set());
  const toggleFilter = useCallback((s: TaskStatus) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }, []);
  const resetFilters = useCallback(() => setActiveFilters(new Set()), []);

  // COLLAPSIBLE LEGEND: expanded by default; chevron folds it to a pill.
  const [legendOpen, setLegendOpen] = useState(true);

  const key = useMemo(() => structureKeyOf(tasks), [tasks]);

  const counts = useMemo(() => {
    const c: Record<TaskStatus, number> = { pending: 0, ready: 0, running: 0, blocked: 0, done: 0, failed: 0 };
    for (const s of Object.values(statuses)) c[s] += 1;
    return c;
  }, [statuses]);

  const isVisibleStatus = useMemo(
    () => (s: TaskStatus): boolean => activeFilters.size === 0 || activeFilters.has(s),
    [activeFilters],
  );
  const isNodeVisible = useMemo(
    () => (id: string): boolean => isVisibleStatus(statuses[id] ?? 'pending'),
    [isVisibleStatus, statuses],
  );
  const visibleCount = useMemo(() => tasks.reduce((acc, t) => acc + (isNodeVisible(t.id) ? 1 : 0), 0), [tasks, isNodeVisible]);
  const filterActive = activeFilters.size > 0;

  // Layout depends only on structure + direction — status/filter flips never
  // recompute it.
  const laidOut = useMemo(() => {
    const seeds = tasks.map((t) => ({
      id: t.id,
      position: { x: 0, y: 0 },
      // Top-level width/height make nodes "initialized" without waiting for
      // DOM measurement; style mirrors the same box for the browser.
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
      style: { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT },
    }));
    const edgesIn = tasks.flatMap((t) => t.dependsOn.map((d) => ({ source: d, target: t.id })));
    return direction === 'LR' ? layoutLeftToRight(seeds, edgesIn) : layoutTopToBottom(seeds, edgesIn);
  }, [tasks, direction]);

  // BEST-EFFORT CENTERING: pan so the revealed node sits mid-view at the
  // current zoom. Runs one rAF after commit (xyflow measures the fresh canvas
  // by then) and silently no-ops when the instance isn't ready or the id is
  // unknown — reveal is a convenience, never a hard requirement.
  useEffect(() => {
    if (!effectiveHighlight) return;
    const raf = requestAnimationFrame(() => {
      const inst = flowRef.current;
      const placed = laidOut.find((n) => n.id === effectiveHighlight);
      if (!inst || !placed) return;
      void inst.setCenter(
        placed.position.x + DEFAULT_NODE_WIDTH / 2,
        placed.position.y + DEFAULT_NODE_HEIGHT / 2,
        { duration: 300 },
      );
    });
    return () => cancelAnimationFrame(raf);
  }, [effectiveHighlight, laidOut]);

  // Handle sides flip with the rank direction (TaskNode reads them off the
  // node object — standard xyflow pattern).
  const sourcePos = direction === 'LR' ? Position.Right : Position.Bottom;
  const targetPos = direction === 'LR' ? Position.Left : Position.Top;

  // Per-id object cache: replace a node object ONLY when something its memo
  // cares about changed (status · highlight · hidden · handle sides ·
  // position). Filter toggles therefore leave untouched ids at their previous
  // object identity.
  const cacheRef = useRef(new Map<string, TaskFlowNode>());
  const nodes = useMemo<TaskFlowNode[]>(
    () =>
      laidOut.map((n) => {
        const status = statuses[n.id] ?? 'pending';
        const hidden = !isVisibleStatus(status);
        const highlighted = n.id === effectiveHighlight;
        const task = tasks.find((t) => t.id === n.id);
        const acceptance = task?.acceptance;
        const prev = cacheRef.current.get(n.id);
        if (
          prev &&
          prev.data.status === status &&
          prev.data.highlighted === highlighted &&
          prev.data.acceptance === acceptance &&
          prev.hidden === hidden &&
          prev.sourcePosition === sourcePos &&
          prev.targetPosition === targetPos &&
          prev.position.x === n.position.x &&
          prev.position.y === n.position.y
        ) {
          return prev;
        }
        const next: TaskFlowNode = {
          id: n.id,
          type: 'task',
          position: n.position,
          width: n.width,
          height: n.height,
          style: n.style,
          hidden,
          sourcePosition: sourcePos,
          targetPosition: targetPos,
          draggable: false,
          selectable: false,
          data: { label: task?.title ?? n.id, status, onBuild: dispatchBuild, highlighted, acceptance },
        };
        cacheRef.current.set(n.id, next);
        return next;
      }),
    [laidOut, statuses, tasks, isVisibleStatus, sourcePos, targetPos, dispatchBuild, effectiveHighlight],
  );

  const edges = useMemo<Edge[]>(() => deriveEdges(tasks, statuses, isNodeVisible), [tasks, statuses, isNodeVisible]);

  // ESCAPE GUARDRAIL: nodes are non-selectable, so the ring to clear is the
  // native focus ring — blur whatever holds focus inside this view.
  const onSectionKeyDown = useCallback((e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape') return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
  }, []);

  const total = tasks.length;
  const doneCount = counts['done'];

  return (
    <section className="archgen-tasks-view" aria-label="Task dependency graph" onKeyDown={onSectionKeyDown}>
      {/* key={structure:direction}: a structural or direction change remounts
          the canvas so fitView runs against the new shape */}
      <ReactFlow
        key={`${key}:${direction}`}
        nodeTypes={taskNodeTypes}
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.08}
        maxZoom={4}
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        onInit={(inst) => {
          flowRef.current = inst;
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable ariaLabel="Tasks minimap" nodeColor={(n) => STATUS_COLOR[(n.data as { status?: TaskStatus })?.status ?? 'pending']} />
        <Panel position="top-left">
          <div className="archgen-dag-hud">
            <div className="archgen-dag-hud-row">
              <button
                type="button"
                className="archgen-start-work"
                onClick={() => onStartWork?.()}
                aria-label="Start Work: dispatch the first task wave"
              >
                ▶ Start Work
              </button>
              <span
                className="archgen-progress-chip"
                role="status"
                aria-label={`${doneCount} of ${total} tasks done`}
                data-done={doneCount}
                data-total={total}
              >
                {doneCount}/{total} done
              </span>
              <button
                type="button"
                className="archgen-dag-layout-btn"
                aria-pressed={direction === 'TB'}
                onClick={toggleDirection}
                aria-label={`Toggle DAG layout direction (currently ${direction === 'LR' ? 'left-right' : 'top-down'})`}
                title="Toggle left-right / top-down layout"
              >
                ⇄ {direction === 'LR' ? 'Left–right' : 'Top–down'}
              </button>
            </div>
            <div className="archgen-dag-toolbar" role="group" aria-label="Filter tasks by status">
              {STATUS_ORDER.map((s) => {
                const on = activeFilters.has(s);
                return (
                  <button
                    key={s}
                    type="button"
                    className={`archgen-dag-chip${on ? ' is-on' : ''}`}
                    aria-pressed={on}
                    aria-label={`Filter ${s} tasks (${counts[s]})`}
                    onClick={() => toggleFilter(s)}
                  >
                    <i aria-hidden="true" className={`archgen-dot archgen-dot--${s}`} />
                    {s}
                    <span className="archgen-dag-chip-count">{counts[s]}</span>
                  </button>
                );
              })}
              <button
                type="button"
                className="archgen-dag-chip archgen-dag-chip--reset"
                onClick={resetFilters}
                disabled={!filterActive}
                aria-label="Show all tasks"
              >
                All
              </button>
            </div>
            {/* Polite announcer: fires when filters empty the board. */}
            <p className="archgen-filter-announce" role="status" aria-live="polite" data-testid="archgen-filter-announce">
              {filterActive && visibleCount === 0 ? 'No tasks match the selected filters' : ''}
            </p>
          </div>
        </Panel>
        <Panel position="top-right">
          <div className="archgen-legend-wrap">
            <button
              type="button"
              className={`archgen-legend-toggle${legendOpen ? '' : ' archgen-legend-toggle--collapsed'}`}
              aria-expanded={legendOpen}
              aria-controls="archgen-legend-items"
              aria-label={legendOpen ? 'Collapse status legend' : 'Expand status legend'}
              onClick={() => setLegendOpen((o) => !o)}
            >
              {legendOpen ? '▾' : '▸ Legend'}
            </button>
            {legendOpen && (
              <div className="archgen-legend" id="archgen-legend-items" role="list" aria-label="Status legend">
                {STATUS_ORDER.map((s) => (
                  <span role="listitem" key={s} className="archgen-legend-item">
                    <i aria-hidden="true" className={`archgen-dot archgen-dot--${s}`} />
                    {s}
                  </span>
                ))}
              </div>
            )}
          </div>
        </Panel>
      </ReactFlow>
    </section>
  );
}
