// providers.ts — thin TreeDataProvider adapters for the sidebar cockpit.
//
// Pure row logic lives in model.ts; this module only shapes vscode.TreeItems.
// Providers never touch extension code: they read snapshots through an
// injected getter and route clicks through the injected SidebarActions, so
// index.ts can wire them to a ModelHub and tests could stub both.
import {
  Event,
  EventEmitter,
  MarkdownString,
  ThemeColor,
  ThemeIcon,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
} from 'vscode';
import type { ArchgenModelMessage, TaskVM } from '../../shared/protocol';
import type { SidebarActions } from './actions';
import { docRows, groupTasks, iconFor, overviewRows, statusSummary, type DocRow, type FeatureRow, type GroupRow, type TaskRow, type TasksTreeRow } from './model';

type GetSnapshot = () => ArchgenModelMessage | null;

function truncateTitle(text: string, max = 48): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function capitalize(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Overview tree: one row per discovered feature, active one flagged. */
export class OverviewProvider implements TreeDataProvider<FeatureRow> {
  private readonly _onDidChangeTreeData = new EventEmitter<FeatureRow | undefined>();
  readonly onDidChangeTreeData: Event<FeatureRow | undefined> = this._onDidChangeTreeData.event;

  constructor(
    private readonly getSnapshot: GetSnapshot,
    private readonly actions: SidebarActions,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(row: FeatureRow): TreeItem {
    const snapshot = this.getSnapshot();
    const featureTasks = snapshot && row.slug === snapshot.activeSlug ? snapshot.tasks : [];
    const item = new TreeItem(row.slug);
    item.description = statusSummary(featureTasks);
    item.iconPath = row.active ? new ThemeIcon('check') : new ThemeIcon('circuit-board');
    item.contextValue = row.active ? 'feature-active' : 'feature';
    item.command = { command: 'archgen.selectFeature', title: 'Select Feature', arguments: [row.slug] };
    return item;
  }

  getChildren(): FeatureRow[] {
    const snapshot = this.getSnapshot();
    if (!snapshot) return [];
    const tasksBySlug = new Map<string, readonly TaskVM[]>([[snapshot.activeSlug, snapshot.tasks]]);
    return overviewRows(snapshot.features, snapshot.activeSlug, tasksBySlug);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

/** Tasks tree: flat list of status groups interleaved with their task rows. */
export class TasksProvider implements TreeDataProvider<TasksTreeRow> {
  private readonly _onDidChangeTreeData = new EventEmitter<TasksTreeRow | undefined>();
  readonly onDidChangeTreeData: Event<TasksTreeRow | undefined> = this._onDidChangeTreeData.event;

  constructor(
    private readonly getSnapshot: GetSnapshot,
    private readonly actions: SidebarActions,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(row: TasksTreeRow): TreeItem {
    if (row.kind === 'group') return this.toGroupItem(row);
    return this.toTaskItem(row);
  }

  getChildren(): TasksTreeRow[] {
    const snapshot = this.getSnapshot();
    return groupTasks(snapshot?.tasks ?? []);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  private toGroupItem(row: GroupRow): TreeItem {
    const item = new TreeItem(capitalize(row.status));
    item.description = `${row.count}`;
    const busy = row.status === 'running' || row.status === 'ready';
    item.collapsibleState = busy || row.count <= 8 ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed;
    item.contextValue = 'group';
    return item;
  }

  private toTaskItem(row: TaskRow): TreeItem {
    const item = new TreeItem(row.taskId);
    item.description = truncateTitle(row.title);
    const icon = iconFor(row.status);
    item.iconPath = new ThemeIcon(icon.id, icon.colorId ? new ThemeColor(icon.colorId) : undefined);
    item.tooltip = this.taskTooltip(row);
    item.contextValue = 'task';
    item.command = { command: 'archgen.revealTask', title: 'Show in Task Board', arguments: [row.taskId] };
    return item;
  }

  private taskTooltip(row: TaskRow): MarkdownString {
    const lines: string[] = [`**${row.title}**`, `Status: ${row.status}`];
    if (row.dependsOn.length > 0) lines.push('', `Depends on: ${row.dependsOn.join(', ')}`);
    if (row.ownership.length > 0) lines.push('', `Owns: ${row.ownership}`);
    if (row.artifacts.length > 0) lines.push('', 'Artifacts:', ...row.artifacts.map((a) => `- ${a}`));
    return new MarkdownString(lines.join('\n'));
  }
}

/** Docs tree: every markdown doc under .archgen/, grouped by directory label. */
export class DocsProvider implements TreeDataProvider<DocRow> {
  private readonly _onDidChangeTreeData = new EventEmitter<DocRow | undefined>();
  readonly onDidChangeTreeData: Event<DocRow | undefined> = this._onDidChangeTreeData.event;

  constructor(
    private readonly getSnapshot: GetSnapshot,
    private readonly actions: SidebarActions,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(row: DocRow): TreeItem {
    const item = new TreeItem(row.title);
    item.description = row.dir === '' ? undefined : row.dir;
    item.tooltip = row.relPath;
    item.contextValue = 'doc';
    item.command = { command: 'archgen.openDoc', title: 'Open Document', arguments: [row.relPath] };
    return item;
  }

  getChildren(): DocRow[] {
    const snapshot = this.getSnapshot();
    return docRows(snapshot?.docs ?? []);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
