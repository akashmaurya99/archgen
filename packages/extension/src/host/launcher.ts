// launcher.ts — activity-bar presence.
// The ArchGen rail icon hosts a minimal single-item tree: clicking the item
// (or focusing the container itself) opens the task-board editor panel via
// the same code path as the `archgen.openPanel` command.
import {
  Event,
  EventEmitter,
  ThemeIcon,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  TreeView,
  window,
} from 'vscode';

export const LAUNCHER_VIEW_ID = 'archgen.launcher';

class LauncherItem extends TreeItem {
  constructor() {
    super('Open Task Board', TreeItemCollapsibleState.None);
    this.contextValue = 'archgen-launcher';
    this.iconPath = new ThemeIcon('circuit-board');
    this.tooltip = 'Open the ArchGen task board in an editor tab';
    this.command = { command: 'archgen.openPanel', title: 'Open Task Board' };
  }
}

class LauncherProvider implements TreeDataProvider<LauncherItem> {
  private readonly _onDidChangeTreeData = new EventEmitter<LauncherItem | undefined>();
  readonly onDidChangeTreeData: Event<LauncherItem | undefined> = this._onDidChangeTreeData.event;

  getTreeItem(item: LauncherItem): TreeItem {
    return item;
  }

  getChildren(): LauncherItem[] {
    return [new LauncherItem()];
  }
}

/**
 * Register the launcher tree. Returns a disposeable; also invokes `onFocus`
 * whenever the user clicks the ArchGen activity-bar icon so the board opens
 * without an extra click.
 */
export function registerLauncher(onFocus: () => void): { dispose(): void } {
  const provider = new LauncherProvider();
  const tree = window.createTreeView(LAUNCHER_VIEW_ID, { treeDataProvider: provider, showCollapseAll: false });
  const visibilitySub = tree.onDidChangeVisibility((e) => {
    if (e.visible) onFocus();
  });
  return {
    dispose(): void {
      visibilitySub.dispose();
      tree.dispose();
    },
  };
}
