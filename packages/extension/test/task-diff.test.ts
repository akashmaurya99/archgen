// task-diff.test.ts — the status-only diff pipeline (M2).
//
// The host compares the new snapshot with the previous one: when ONLY task
// statuses moved, the board receives a diff instead of a full snapshot.
import { describe, expect, it } from 'vitest';
import { diffTaskStatuses, isStatusOnlyChange } from '../src/host/task-diff';
import type { ArchgenModelMessage, TaskVM } from '../src/shared/protocol';

function task(id: string, status: TaskVM['status'] = 'pending', title = `Task ${id}`): TaskVM {
  return { id, title, status, dependsOn: [], fileOwnership: [], artifacts: [] };
}

/** One shared codegraph slice — the host reuses it while the index is unchanged. */
const SLICE = { product: 'unsupported' as const };

function model(tasks: TaskVM[], overrides: Partial<ArchgenModelMessage> = {}): ArchgenModelMessage {
  return {
    type: 'model',
    tasks,
    docs: [],
    codegraph: SLICE,
    themeKind: 'dark',
    warnings: [],
    features: [],
    activeSlug: '',
    ...overrides,
  };
}

describe('diffTaskStatuses', () => {
  it('reports only the ids whose status changed', () => {
    const prev = [task('A', 'pending'), task('B', 'pending'), task('C', 'done')];
    const next = [task('A', 'running'), task('B', 'pending'), task('C', 'done')];
    expect(diffTaskStatuses(prev, next)).toEqual([{ id: 'A', status: 'running' }]);
  });

  it('ignores ids that are not in the new list', () => {
    expect(diffTaskStatuses([task('A', 'pending')], [task('B', 'pending')])).toEqual([]);
  });

  it('returns an empty diff for identical lists', () => {
    expect(diffTaskStatuses([task('A', 'running')], [task('A', 'running')])).toEqual([]);
  });
});

describe('isStatusOnlyChange', () => {
  it('is true when only statuses moved', () => {
    const prev = model([task('A', 'pending')]);
    const next = model([task('A', 'running')]);
    expect(isStatusOnlyChange(prev, next)).toBe(true);
  });

  it('ignores the tasks.yaml mtime — writing a status touches the file', () => {
    const prev = model([task('A', 'pending')], {
      features: [{ slug: 'demo', tasksPath: '/ws/.archgen/demo/tasks.yaml', updatedAt: 1 }],
    });
    const next = model([task('A', 'running')], {
      features: [{ slug: 'demo', tasksPath: '/ws/.archgen/demo/tasks.yaml', updatedAt: 999 }],
    });
    expect(isStatusOnlyChange(prev, next)).toBe(true);
  });

  it('is false when the task structure changed', () => {
    const prev = model([task('A', 'pending')]);
    const next = model([task('A', 'running', 'Renamed')]);
    expect(isStatusOnlyChange(prev, next)).toBe(false);
  });

  it('is false when the docs changed', () => {
    const prev = model([task('A', 'pending')]);
    const next = model([task('A', 'running')], { docs: [{ path: 'a.md', title: 'a.md' }] });
    expect(isStatusOnlyChange(prev, next)).toBe(false);
  });

  it('is false when the codegraph slice changed (a new object means new content)', () => {
    const prev = model([task('A', 'pending')]);
    const next = model([task('A', 'running')], { codegraph: { product: 'colby' } });
    expect(isStatusOnlyChange(prev, next)).toBe(false);
  });

  it('is true when the SAME codegraph slice object rides along', () => {
    const slice = { product: 'colby' as const };
    const prev = model([task('A', 'pending')], { codegraph: slice });
    const next = model([task('A', 'running')], { codegraph: slice });
    expect(isStatusOnlyChange(prev, next)).toBe(true);
  });
});
