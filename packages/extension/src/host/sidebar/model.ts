// model.ts — PURE sidebar row builders (host side).
//
// Every function here is deterministic and 'vscode'-free so vitest can target
// it directly; providers.ts is the thin adapter that turns these rows into
// TreeItems. Grouping order, summary wording and the icon table are contract —
// change them only together with test/sidebar-model.test.ts.
import type { DocRef, FeatureInfo, TaskVM } from '../../shared/protocol';
import type { TaskStatus } from '../../shared/status';

/** Sidebar group order: active work first, graveyard last. */
export const STATUS_GROUPS: readonly TaskStatus[] = ['running', 'ready', 'blocked', 'pending', 'done', 'failed'];

export interface TaskRow {
  kind: 'task';
  taskId: string;
  title: string;
  status: TaskStatus;
  ownership: string;
  dependsOn: string[];
  artifacts: string[];
}

export interface GroupRow {
  kind: 'group';
  status: TaskStatus;
  count: number;
}

export type TasksTreeRow = GroupRow | TaskRow;

/**
 * Flatten tasks into sidebar rows: one group row per non-empty status bucket
 * (STATUS_GROUPS order), then that bucket's tasks ordered by id ASC.
 */
export function groupTasks(tasks: readonly TaskVM[]): TasksTreeRow[] {
  const byStatus = new Map<TaskStatus, TaskVM[]>();
  for (const status of STATUS_GROUPS) byStatus.set(status, []);
  for (const t of tasks) {
    const bucket = byStatus.get(t.status);
    if (bucket) bucket.push(t);
  }

  const rows: TasksTreeRow[] = [];
  for (const status of STATUS_GROUPS) {
    const bucket = byStatus.get(status) ?? [];
    if (bucket.length === 0) continue;
    rows.push({ kind: 'group', status, count: bucket.length });
    const ordered = [...bucket].sort((a, b) => a.id.localeCompare(b.id));
    for (const t of ordered) {
      rows.push({
        kind: 'task',
        taskId: t.id,
        title: t.title,
        status: t.status,
        ownership: t.fileOwnership[0] ?? '',
        dependsOn: [...t.dependsOn],
        artifacts: [...t.artifacts],
      });
    }
  }
  return rows;
}

export interface FeatureRow {
  slug: string;
  active: boolean;
  total: number;
  done: number;
  running: number;
  failed: number;
  ready: number;
  blocked: number;
  pending: number;
}

/**
 * One row per feature in input order with per-status counts. Only the ACTIVE
 * feature's tasks reach the snapshot today, so callers pass a map holding just
 * `activeSlug`; other features legitimately show zeroed counts.
 */
export function overviewRows(
  features: readonly FeatureInfo[],
  activeSlug: string,
  tasksBySlug: ReadonlyMap<string, readonly TaskVM[]>,
): FeatureRow[] {
  return features.map((f) => {
    const row: FeatureRow = { slug: f.slug, active: f.slug === activeSlug, total: 0, done: 0, running: 0, failed: 0, ready: 0, blocked: 0, pending: 0 };
    const tasks = tasksBySlug.get(f.slug) ?? [];
    row.total = tasks.length;
    for (const t of tasks) row[t.status] += 1;
    return row;
  });
}

/** Non-zero buckets joined as "4 done · 2 running · …", done→pending order. */
export function statusSummary(tasks: readonly TaskVM[]): string {
  if (tasks.length === 0) return 'no tasks';
  const counts = new Map<TaskStatus, number>();
  for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const parts: string[] = [];
  for (const status of ['done', 'running', 'failed', 'ready', 'blocked', 'pending'] as const) {
    const n = counts.get(status) ?? 0;
    if (n > 0) parts.push(`${n} ${status}`);
  }
  return parts.join(' · ');
}

export interface DocRow {
  relPath: string;
  title: string;
  dir: string;
}

/** basename/dirname split of workspace-relative doc paths, input order kept. */
export function docRows(docs: readonly DocRef[]): DocRow[] {
  return docs.map((d) => {
    // Host emits '/' on posix but path.relative yields '\' on Windows.
    const sep = Math.max(d.path.lastIndexOf('/'), d.path.lastIndexOf('\\'));
    return {
      relPath: d.path,
      title: sep === -1 ? d.path : d.path.slice(sep + 1),
      dir: sep === -1 ? '' : d.path.slice(0, sep),
    };
  });
}

export function iconFor(status: TaskStatus): { id: string; colorId?: string } {
  switch (status) {
    case 'running':
      return { id: 'loading~spin', colorId: 'charts.blue' };
    case 'ready':
      return { id: 'circle-outline', colorId: 'charts.yellow' };
    case 'blocked':
      return { id: 'circle-slash', colorId: 'charts.orange' };
    case 'pending':
      return { id: 'circle-large-outline' };
    case 'done':
      return { id: 'check', colorId: 'testing.iconPassed' };
    case 'failed':
      return { id: 'error', colorId: 'testing.iconFailed' };
  }
}
