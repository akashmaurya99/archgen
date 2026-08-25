// statusbar.ts — build-activity status bar indicator (host side).
//
// VS Code-coupled shell following the watchers.ts precedent: subscribes to
// ModelHub snapshots and pulses while any task is running; hidden otherwise
// (zero-running at startup stays silent). The counting is trivial inline
// aggregation over the snapshot, so no separate pure module is warranted.
import { ExtensionContext, StatusBarAlignment, StatusBarItem, window } from 'vscode';
import type { ModelHub } from './hub';
import type { ArchgenModelMessage } from '../shared/protocol';
import type { TaskStatus } from '../shared/status';

/** Tooltip bucket order: done first, graveyard last; running always present. */
const TOOLTIP_ORDER: readonly TaskStatus[] = ['done', 'running', 'failed', 'ready', 'blocked', 'pending'];

function applyModel(item: StatusBarItem, m: ArchgenModelMessage): void {
  const counts = new Map<TaskStatus, number>();
  for (const status of TOOLTIP_ORDER) counts.set(status, 0);
  for (const t of m.tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);

  const running = counts.get('running') ?? 0;
  if (running === 0) {
    item.hide();
    return;
  }
  item.text = `$(sync~spin) ${running} running`;
  const parts: string[] = [];
  for (const status of TOOLTIP_ORDER) {
    const n = counts.get(status) ?? 0;
    if (n > 0 || status === 'running') parts.push(`${n} ${status}`);
  }
  item.tooltip = parts.join(' · ');
  item.show();
}

/**
 * Register the status bar indicator against the shared hub. The item and the
 * subscription are pushed into context.subscriptions directly; the returned
 * disposeable cleans both up as well.
 */
export function registerStatusBar(context: ExtensionContext, hub: ModelHub): { dispose(): void } {
  const item: StatusBarItem = window.createStatusBarItem(StatusBarAlignment.Left, 100);
  item.name = 'ArchGen Build Activity';
  item.command = 'archgen.openPanel';

  const subscription = hub.onModel((m) => applyModel(item, m));
  context.subscriptions.push(item, subscription);

  return {
    dispose(): void {
      subscription.dispose();
      item.dispose();
    },
  };
}
