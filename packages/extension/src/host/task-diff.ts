// task-diff.ts — decide whether a model push is a full snapshot or a
// status-only diff.
//
// The watcher's whole point is to ship the DELTA when only task statuses
// moved: a full model re-renders every node, while a diff touches only the
// changed ones. The comparison is structural: everything except the task
// statuses must be identical, otherwise the webview needs the full snapshot.
import type { ArchgenModelMessage, TaskStatus, TaskVM } from '../shared/protocol';

export interface StatusChange {
  id: string;
  status: TaskStatus;
}

/** Status changes between two task lists (ids missing from `next` are ignored). */
export function diffTaskStatuses(prev: readonly TaskVM[], next: readonly TaskVM[]): StatusChange[] {
  const before = new Map(prev.map((t) => [t.id, t.status]));
  const out: StatusChange[] = [];
  for (const t of next) {
    const was = before.get(t.id);
    if (was !== undefined && was !== t.status) out.push({ id: t.id, status: t.status });
  }
  return out;
}

/** Everything about a model EXCEPT the task statuses (and the codegraph slice). */
function structureOf(model: ArchgenModelMessage): string {
  return JSON.stringify({
    docs: model.docs,
    warnings: model.warnings,
    // The feature mtime is FRESHNESS metadata, not content: writing a new
    // task status touches tasks.yaml, so comparing the mtime would turn
    // every status change into a "structural" change.
    features: model.features.map((f) => ({ slug: f.slug, tasksPath: f.tasksPath })),
    activeSlug: model.activeSlug,
    themeKind: model.themeKind,
    tasks: model.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      dependsOn: t.dependsOn,
      fileOwnership: t.fileOwnership,
      artifacts: t.artifacts,
      parallelGroup: t.parallelGroup,
      acceptance: t.acceptance,
    })),
  });
}

/**
 * True when the two models differ ONLY in task statuses.
 *
 * The codegraph slice is compared by IDENTITY: the host reuses one slice
 * object while the index is unchanged, and a changed index must always ship a
 * full model (never a status diff).
 */
export function isStatusOnlyChange(prev: ArchgenModelMessage, next: ArchgenModelMessage): boolean {
  if (prev.codegraph !== next.codegraph) return false;
  return structureOf(prev) === structureOf(next);
}
