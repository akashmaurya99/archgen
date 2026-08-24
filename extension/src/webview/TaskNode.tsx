// TaskNode.tsx — custom React Flow node for one task (todo 8) + ▶ build
// dispatch (todo 9).
//
// PERF RULES (xyflow guide): the component is memo()ized and nodeTypes is
// declared at MODULE SCOPE — recreating either on every render would remount
// every node. Status changes flip CSS classes ONLY (tokens.css palette +
// pulse-ring keyframes); no inline styles, so memo stays cheap and theming
// flows through --archgen-* / --vscode-* variables.
import { memo } from 'react';
import { Handle, NodeToolbar, Position, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import type { TaskStatus } from '../shared/status';

// Type (not interface): object literal types carry an implicit string index
// signature, which Node<NodeData extends Record<string, unknown>> requires.
export type TaskNodeData = {
  label: string;
  status: TaskStatus;
  /** Host-injected dispatch callback; stable via ref in TasksView. */
  onBuild?: (taskId: string) => void;
};

export type TaskFlowNode = Node<TaskNodeData, 'task'>;

function TaskNodeComponent({ data, id }: NodeProps<TaskFlowNode>) {
  const pulse = data.status === 'running' ? ' archgen-pulse' : '';
  return (
    <div
      className={`archgen-tasknode archgen-node--${data.status}${pulse}`}
      data-task-id={id}
      aria-label={`${id}: ${data.label} (status ${data.status})`}
    >
      <NodeToolbar isVisible>
        <button
          type="button"
          className="archgen-build-btn"
          onClick={() => data.onBuild?.(id)}
          aria-label={`Build ${id}`}
          title={`Dispatch harness for ${id}`}
        >
          ▶
        </button>
      </NodeToolbar>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="archgen-task-id">{id}</span>
      <span className="archgen-task-title" data-status={data.status}>
        {data.label}
      </span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

/** Memoized custom node — re-renders only when its own `data` object changes. */
export const TaskNode = memo(TaskNodeComponent);

/** MODULE-SCOPE nodeTypes (xyflow perf rule 1): never recreate inside a component. */
export const taskNodeTypes: NodeTypes = { task: TaskNode };
