// index.ts — sidebar cockpit wiring (host side).
//
// Owns the three tree views, pipes ModelHub events into provider refreshes,
// maintains the tasks-view running+failed badge and the archgen.hasFeatures
// context key. extension.ts calls registerSidebar once at activate time.
import { commands, ExtensionContext, window } from 'vscode';
import type { ModelHub } from '../hub';
import type { SidebarActions } from './actions';
import { DocsProvider, OverviewProvider, TasksProvider } from './providers';

export function registerSidebar(context: ExtensionContext, hub: ModelHub, actions: SidebarActions): { dispose(): void } {
  const getSnapshot = () => hub.snapshot();
  const overview = new OverviewProvider(getSnapshot, actions);
  const tasks = new TasksProvider(getSnapshot, actions);
  const docs = new DocsProvider(getSnapshot, actions);

  const overviewView = window.createTreeView('archgen.overview', { treeDataProvider: overview, showCollapseAll: false });
  const tasksView = window.createTreeView('archgen.tasks', { treeDataProvider: tasks, showCollapseAll: false });
  const docsView = window.createTreeView('archgen.docs', { treeDataProvider: docs, showCollapseAll: false });

  const subscription = hub.onModel((model) => {
    overview.refresh();
    tasks.refresh();
    docs.refresh();

    const running = model.tasks.filter((t) => t.status === 'running').length;
    const failed = model.tasks.filter((t) => t.status === 'failed').length;
    tasksView.badge = running + failed > 0 ? { value: running + failed, tooltip: `${running} running · ${failed} failed` } : undefined;

    void commands.executeCommand('setContext', 'archgen.hasFeatures', model.features.length > 0);
  });

  const disposables = [overview, tasks, docs, overviewView, tasksView, docsView, subscription];
  context.subscriptions.push(...disposables);

  return {
    dispose(): void {
      for (const d of disposables) d.dispose();
    },
  };
}
