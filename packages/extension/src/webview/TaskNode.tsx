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
import type { KeyboardEvent } from 'react';
import type { TaskStatus } from '../shared/status';

// Type (not interface): object literal types carry an implicit string index
// signature, which Node<NodeData extends Record<string, unknown>> requires.
export type TaskNodeData = {
  label: string;
  status: TaskStatus;
  /** revealTask intent — draws the focus-border spotlight ring. */
  highlighted?: boolean;
  /** Host-injected dispatch callback; stable via ref in TasksView. */
  onBuild?: (taskId: string) => void;
  /** Acceptance criteria — read-only hover detail (native title tooltip). */
  acceptance?: string[];
};

export type TaskFlowNode = Node<TaskNodeData, 'task'>;

/** A11y label contract (todo 13): `task <id>: <title>, status <status>`. */
export function taskAriaLabel(id: string, title: string, status: TaskStatus): string {
  return `task ${id}: ${title}, status ${status}`;
}

function TaskNodeComponent({
  data,
  id,
  // Handle sides arrive from the NODE OBJECT (TasksView sets them per layout
  // direction): LR ⇒ target Left / source Right; TB ⇒ target Top / source
  // Bottom. Defaults keep the historical left→right shape for bare usage.
  sourcePosition = Position.Right,
  targetPosition = Position.Left,
}: NodeProps<TaskFlowNode>) {
  const pulse = data.status === 'running' ? ' archgen-pulse' : '';
  const spotlight = data.highlighted ? ' is-highlighted' : '';
  // Hover detail: acceptance criteria via the native tooltip — same bullet
  // style as the sidebar task tooltip.
  const detail =
    data.acceptance && data.acceptance.length > 0
      ? ['Acceptance:', ...data.acceptance.map((a) => `- ${a}`)].join('\n')
      : undefined;

  // KEYBOARD NAV (todo 13): every node is in the tab order; Enter or Space on
  // a focused node activates the ▶ build dispatch — same path as the button.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    data.onBuild?.(id);
  };

  return (
    <div
      className={`archgen-tasknode archgen-node--${data.status}${pulse}${spotlight}`}
      data-task-id={id}
      role="button"
      tabIndex={0}
      aria-label={taskAriaLabel(id, data.label, data.status)}
      title={detail}
      onKeyDown={onKeyDown}
    >
      <NodeToolbar isVisible>
        <button
          type="button"
          className="archgen-build-btn"
          onClick={() => data.onBuild?.(id)}
          aria-label={`Build task ${id}`}
          title={`Dispatch harness for ${id}`}
        >
          ▶
        </button>
      </NodeToolbar>
      <Handle type="target" position={targetPosition} isConnectable={false} />
      <span className="archgen-task-id">{id}</span>
      <span className="archgen-task-title" data-status={data.status}>
        {data.label}
      </span>
      <Handle type="source" position={sourcePosition} isConnectable={false} />
    </div>
  );
}

/** Memoized custom node — re-renders only when its own `data` object changes. */
export const TaskNode = memo(TaskNodeComponent);

/** MODULE-SCOPE nodeTypes (xyflow perf rule 1): never recreate inside a component. */
export const taskNodeTypes: NodeTypes = { task: TaskNode };
