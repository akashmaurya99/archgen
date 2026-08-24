// TasksView.tsx — TASK DAG canvas (todo 8) + live status wiring (todo 10).
//
// DATA FLOW: host watcher diffs arrive as {type:'update',changed:[{id,status}]}
// → App routes them through StatusStore.applyBatch (rAF-batched, immutable)
// → this view re-renders ONLY the changed nodes:
//   - statuses come from ONE store index subscription (Record<id,status>);
//     shallow-equal dedupe means no state churn on unrelated flushes.
//   - node objects are cached per id and replaced ONLY when that node's status
//     changed → memoized TaskNode components for untouched ids never re-render.
//   - edges are re-derived from the same record; `animated` flips ONLY when the
//     TARGET node is running ("flowing into running"), blocked targets get a
//     dashed-static class, failed targets a red-stroke class.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '../../media/webview/dag.css';
import type { TaskStatus, TaskVM } from '../shared/protocol';
import { StatusStore } from '../host/store';
import { layoutLeftToRight } from './layout';
import { STATUS_ORDER } from './states';
import { taskNodeTypes, type TaskFlowNode } from './TaskNode';

export interface TasksViewProps {
  tasks: TaskVM[];
  store: StatusStore<TaskVM>;
  /** ▶ dispatch — App posts {type:'build',taskId} to the host. */
  onBuild?: (taskId: string) => void;
  /** Header "Start Work" — App posts {type:'startWork'} to the host. */
  onStartWork?: () => void;
}

/** MiniMap dot color per status — CSS vars keep it theme-adaptive. */
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

export function TasksView({ tasks, store, onBuild, onStartWork }: TasksViewProps) {
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

  const key = useMemo(() => structureKeyOf(tasks), [tasks]);

  // Layout depends only on structure — status flips never recompute it.
  const laidOut = useMemo(() => {
    const seeds = tasks.map((t) => ({
      id: t.id,
      position: { x: 0, y: 0 },
      // Top-level width/height make nodes "initialized" without waiting for
      // DOM measurement; style mirrors the same box for the browser.
      width: 180,
      height: 56,
      style: { width: 180, height: 56 },
    }));
    const edgesIn = tasks.flatMap((t) => t.dependsOn.map((d) => ({ source: d, target: t.id })));
    return layoutLeftToRight(seeds, edgesIn);
  }, [tasks]);

  // Per-id object cache: replace a node object ONLY when its status changed.
  const cacheRef = useRef(new Map<string, TaskFlowNode>());
  const nodes = useMemo<TaskFlowNode[]>(
    () =>
      laidOut.map((n) => {
        const status = statuses[n.id] ?? 'pending';
        const prev = cacheRef.current.get(n.id);
        if (prev && prev.data.status === status) return prev;
        const task = tasks.find((t) => t.id === n.id);
        const next: TaskFlowNode = {
          id: n.id,
          type: 'task',
          position: n.position,
          width: n.width,
          height: n.height,
          style: n.style,
          draggable: false,
          selectable: false,
          data: { label: task?.title ?? n.id, status, onBuild: dispatchBuild },
        };
        cacheRef.current.set(n.id, next);
        return next;
      }),
    [laidOut, statuses, tasks],
  );

  const edges = useMemo<Edge[]>(
    () =>
      tasks.flatMap((t) =>
        t.dependsOn
          .filter((d) => statuses[d] !== undefined || tasks.some((x) => x.id === d))
          .map((d) => {
            const targetStatus: TaskStatus = statuses[t.id] ?? 'pending';
            return {
              id: `${d}->${t.id}`,
              source: d,
              target: t.id,
              animated: targetStatus === 'running',
              className:
                targetStatus === 'failed'
                  ? 'archgen-edge--failed'
                  : targetStatus === 'blocked'
                    ? 'archgen-edge--blocked'
                    : undefined,
            };
          }),
      ),
    [tasks, statuses],
  );

  return (
    <section className="archgen-tasks-view" aria-label="Task dependency graph">
      {/* key={structure}: a structural change remounts the canvas so fitView runs */}
      <ReactFlow
        key={key}
        nodeTypes={taskNodeTypes}
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.25}
        panOnScroll
        zoomOnDoubleClick={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable ariaLabel="Tasks minimap" nodeColor={(n) => STATUS_COLOR[(n.data as { status?: TaskStatus })?.status ?? 'pending']} />
        <Panel position="top-left">
          <button type="button" className="archgen-start-work" onClick={() => onStartWork?.()} aria-label="Start Work">
            ▶ Start Work
          </button>
        </Panel>
        <Panel position="top-right">
          <div className="archgen-legend" role="list" aria-label="Status legend">
            {STATUS_ORDER.map((s) => (
              <span role="listitem" key={s} className="archgen-legend-item">
                <i aria-hidden="true" className={`archgen-dot archgen-dot--${s}`} />
                {s}
              </span>
            ))}
          </div>
        </Panel>
      </ReactFlow>
    </section>
  );
}
