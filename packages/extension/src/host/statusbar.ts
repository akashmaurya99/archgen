// statusbar.ts — build-activity + setup status bar indicators (host side).
//
// VS Code-coupled shell following the watchers.ts precedent: subscribes to
// ModelHub snapshots and pulses while any task is running; hidden otherwise
// (zero-running at startup stays silent). The counting is trivial inline
// aggregation over the snapshot, so no separate pure module is warranted.
// A SECOND item (lower priority) surfaces the current setup action only when
// one is pending — hidden entirely once setup resolves.
import { ExtensionContext, StatusBarAlignment, StatusBarItem, window } from 'vscode';
import type { ModelHub } from './hub';
import type { ArchgenModelMessage } from '../shared/protocol';
import type { TaskStatus } from '../shared/status';
import { resolveSetupAction } from './setup';
import type { SetupAction, SetupState } from './setup';

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

/** Per-action icon + label + tooltip for the setup item (priority 90, under the running indicator's 100). */
const SETUP_ITEM_STYLE: Record<Exclude<SetupAction, 'none'>, { icon: string; label: string; tooltip: string }> = {
  install: {
    icon: '$(cloud-download)',
    label: 'install skill',
    tooltip: 'No archgen skill found in this workspace or home directory. Click to open setup and copy an install prompt for your agent.',
  },
  initPlan: {
    icon: '$(add)',
    label: 'initialize plan',
    tooltip: 'The archgen skill is installed, but this workspace has no .archgen plan yet. Click to open setup and kick one off.',
  },
  update: {
    icon: '$(sync)',
    label: 'update skill',
    tooltip: 'An older or unversioned archgen skill is installed. Everything keeps working on older versions — click to view update steps.',
  },
};

export interface SetupStatusBarHandle {
  /** Re-evaluate visibility/text from the latest SetupState (call after every evaluateSetupNow). */
  apply(state: SetupState): void;
  dispose(): void;
}

/**
 * Register the SECOND status bar item: visible ONLY while a setup action is
 * pending, hidden entirely once setup resolves (zero noise in the good state).
 */
export function registerSetupStatusBar(context: ExtensionContext): SetupStatusBarHandle {
  const item: StatusBarItem = window.createStatusBarItem(StatusBarAlignment.Left, 90);
  item.name = 'ArchGen Setup';
  item.command = 'archgen.openSetup';
  context.subscriptions.push(item);

  return {
    apply(state: SetupState): void {
      const action = resolveSetupAction(state);
      if (action === 'none') {
        item.hide();
        return;
      }
      const style = SETUP_ITEM_STYLE[action];
      item.text = `${style.icon} ArchGen: ${style.label}`;
      item.tooltip = style.tooltip;
      item.show();
    },
    dispose(): void {
      item.dispose();
    },
  };
}
