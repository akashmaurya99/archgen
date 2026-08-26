// Sidebar cockpit data layer: PURE row builders — grouping order, status
// summaries, overview rollups, doc rows and the exact icon table. Zero
// 'vscode' involvement; providers.ts is the only vscode-facing adapter.
import { describe, expect, it } from 'vitest';

import {
  STATUS_GROUPS,
  compactStatusSummary,
  docRows,
  getStatusGroupRows,
  getTasksForStatus,
  groupTasks,
  iconFor,
  overviewRows,
  statusSummary,
  type TasksTreeRow,
} from '../src/host/sidebar/model.js';
import type { DocRef, FeatureInfo, TaskStatus, TaskVM } from '../src/shared/protocol.js';

function task(id: string, status: TaskStatus, extra: Partial<TaskVM> = {}): TaskVM {
  return { id, title: `Task ${id}`, status, dependsOn: [], fileOwnership: [], artifacts: [], ...extra };
}

function feature(slug: string): FeatureInfo {
  return { slug, tasksPath: `/w/.archgen/${slug}/tasks.yaml`, updatedAt: 0 };
}

describe('STATUS_GROUPS', () => {
  it('fixes the sidebar group order: active work first, graveyard last', () => {
    expect(STATUS_GROUPS).toEqual(['running', 'ready', 'blocked', 'pending', 'done', 'failed']);
  });
});

describe('groupTasks', () => {
  it('orders groups by STATUS_GROUPS sequence and tasks within a group by id ASC', () => {
    const tasks = [
      task('T3', 'done'),
      task('A2', 'running'),
      task('P1', 'pending'),
      task('A10', 'running'),
      task('F1', 'failed'),
      task('B1', 'blocked'),
      task('R1', 'ready'),
    ];
    const shape = groupTasks(tasks).map((r) => (r.kind === 'group' ? `g:${r.status}` : `t:${r.taskId}`));
    expect(shape).toEqual([
      'g:running',
      't:A10',
      't:A2',
      'g:ready',
      't:R1',
      'g:blocked',
      't:B1',
      'g:pending',
      't:P1',
      'g:done',
      't:T3',
      'g:failed',
      't:F1',
    ]);
  });

  it('emits a group row ONLY for non-empty buckets and carries the count', () => {
    const rows = groupTasks([task('D1', 'done'), task('D2', 'done'), task('X1', 'failed')]);
    const groups = rows.filter((r): r is Extract<TasksTreeRow, { kind: 'group' }> => r.kind === 'group');
    expect(groups).toEqual([
      { kind: 'group', status: 'done', count: 2 },
      { kind: 'group', status: 'failed', count: 1 },
    ]);
    expect(groupTasks([])).toEqual([]);
  });

  it('maps ownership to the FIRST glob (or empty) and copies dependsOn/artifacts', () => {
    const [row] = groupTasks([
      task('T1', 'running', { fileOwnership: ['src/a/**', 'src/b/**'], dependsOn: ['T0'], artifacts: ['docs/x.md'] }),
    ]).filter((r): r is Extract<TasksTreeRow, { kind: 'task' }> => r.kind === 'task');
    expect(row?.ownership).toBe('src/a/**');
    expect(row?.dependsOn).toEqual(['T0']);
    expect(row?.artifacts).toEqual(['docs/x.md']);

    const [bare] = groupTasks([task('T2', 'pending')]).filter((r): r is Extract<TasksTreeRow, { kind: 'task' }> => r.kind === 'task');
    expect(bare?.ownership).toBe('');
  });

  it('silently drops a task carrying an out-of-enum status at runtime (no crash, no phantom group)', () => {
    // parseTasks coerces invalid statuses to 'pending' at the reader boundary,
    // so this guard only ever fires on direct API misuse — but it must hold:
    // an unknown status never produces a group row and never throws.
    const rogue = { ...task('R1', 'pending'), status: 'cancelled' } as unknown as TaskVM;
    const rows = groupTasks([task('K1', 'done'), rogue]);
    expect(rows).toEqual([
      { kind: 'group', status: 'done', count: 1 },
      expect.objectContaining({ kind: 'task', taskId: 'K1' }),
    ]);
  });
});

describe('getStatusGroupRows', () => {
  it('returns one GroupRow per non-empty bucket in STATUS_GROUPS order with exact counts', () => {
    const tasks = [
      task('p1', 'pending'),
      task('r1', 'running'),
      task('r2', 'running'),
      task('d1', 'done'),
      task('d2', 'done'),
      task('d3', 'done'),
    ];
    expect(getStatusGroupRows(tasks)).toEqual([
      { kind: 'group', status: 'running', count: 2 },
      { kind: 'group', status: 'pending', count: 1 },
      { kind: 'group', status: 'done', count: 3 },
    ]);
  });

  it('returns no rows for an empty task list', () => {
    expect(getStatusGroupRows([])).toEqual([]);
  });

  it('counts repeat occurrences within one bucket (second task in a bucket increments, not resets)', () => {
    const rows = getStatusGroupRows([task('b1', 'blocked'), task('b2', 'blocked'), task('b3', 'blocked')]);
    expect(rows).toEqual([{ kind: 'group', status: 'blocked', count: 3 }]);
  });
});

describe('getTasksForStatus', () => {
  it('filters to the requested bucket, sorts by id ASC, and maps full task fields', () => {
    const rows = getTasksForStatus(
      [
        task('Z9', 'running'),
        task('A1', 'running', { fileOwnership: ['src/x/**', 'src/y/**'], dependsOn: ['A0'], artifacts: ['a.md'], acceptance: ['ships green'] }),
        task('A10', 'running'),
        task('M5', 'done'),
      ],
      'running',
    );
    expect(rows.map((r) => r.taskId)).toEqual(['A1', 'A10', 'Z9']);
    expect(rows[0]).toEqual({
      kind: 'task',
      taskId: 'A1',
      title: 'Task A1',
      status: 'running',
      ownership: 'src/x/**',
      dependsOn: ['A0'],
      artifacts: ['a.md'],
      acceptance: ['ships green'],
    });
  });

  it('defaults ownership to empty and acceptance to [] when absent', () => {
    const [row] = getTasksForStatus([task('B2', 'blocked')], 'blocked');
    expect(row?.ownership).toBe('');
    expect(row?.acceptance).toEqual([]);
    expect(row?.dependsOn).toEqual([]);
  });

  it('returns an empty list when no task matches the bucket', () => {
    expect(getTasksForStatus([task('C3', 'done')], 'failed')).toEqual([]);
  });
});

describe('statusSummary', () => {
  it('returns "no tasks" for an empty list', () => {
    expect(statusSummary([])).toBe('no tasks');
  });

  it('renders ALL non-zero buckets in done→running→failed→ready→blocked→pending order', () => {
    const tasks: TaskVM[] = [
      ...Array.from({ length: 4 }, (_, i) => task(`d${i}`, 'done')),
      ...Array.from({ length: 2 }, (_, i) => task(`r${i}`, 'running')),
      task('f0', 'failed'),
      ...Array.from({ length: 3 }, (_, i) => task(`y${i}`, 'ready')),
      ...Array.from({ length: 5 }, (_, i) => task(`b${i}`, 'blocked')),
      ...Array.from({ length: 6 }, (_, i) => task(`p${i}`, 'pending')),
    ];
    expect(statusSummary(tasks)).toBe('4 done · 2 running · 1 failed · 3 ready · 5 blocked · 6 pending');
  });

  it('omits zero buckets for partial distributions', () => {
    expect(statusSummary([task('a', 'done'), task('b', 'pending'), task('c', 'pending')])).toBe('1 done · 2 pending');
    expect(statusSummary([task('a', 'failed')])).toBe('1 failed');
  });
});

describe('compactStatusSummary', () => {
  it('returns "0 tasks" for an empty list', () => {
    expect(compactStatusSummary([])).toBe('0 tasks');
  });

  it('renders done/total with rounded percentage and NO suffix when nothing is running or failed', () => {
    const tasks = [task('d1', 'done'), task('d2', 'done'), task('p1', 'pending'), task('r1', 'ready')];
    expect(compactStatusSummary(tasks)).toBe('2/4 (50%)');
  });

  it('appends the running count to the suffix when tasks are running', () => {
    const tasks = [task('d1', 'done'), task('r1', 'running'), task('r2', 'running'), task('p1', 'pending')];
    expect(compactStatusSummary(tasks)).toBe('1/4 (25%) • 2 running');
  });

  it('appends the failed count to the suffix when tasks are failed', () => {
    const tasks = [task('f1', 'failed'), task('p1', 'pending')];
    expect(compactStatusSummary(tasks)).toBe('0/2 (0%) • 1 failed');
  });

  it('joins running AND failed in the suffix with " · "', () => {
    const tasks = [task('d1', 'done'), task('r1', 'running'), task('f1', 'failed'), task('f2', 'failed')];
    expect(compactStatusSummary(tasks)).toBe('1/4 (25%) • 1 running · 2 failed');
  });

  it('rounds the percentage to the nearest integer', () => {
    const tasks = [task('d1', 'done'), task('p1', 'pending'), task('p2', 'pending')];
    expect(compactStatusSummary(tasks)).toBe('1/3 (33%)');
  });
});

describe('overviewRows', () => {
  const features = [feature('zeta'), feature('alpha')];

  it('preserves input order, flags the active slug, and counts statuses per feature', () => {
    const tasksBySlug = new Map<string, readonly TaskVM[]>([
      [
        'alpha',
        [task('a1', 'done'), task('a2', 'done'), task('a3', 'running'), task('a4', 'failed'), task('a5', 'ready'), task('a6', 'blocked'), task('a7', 'pending')],
      ],
    ]);
    expect(overviewRows(features, 'alpha', tasksBySlug)).toEqual([
      { slug: 'zeta', active: false, total: 0, done: 0, running: 0, failed: 0, ready: 0, blocked: 0, pending: 0 },
      { slug: 'alpha', active: true, total: 7, done: 2, running: 1, failed: 1, ready: 1, blocked: 1, pending: 1 },
    ]);
  });

  it('zeroes features missing from the map (only the ACTIVE feature has parsed tasks)', () => {
    const tasksBySlug = new Map<string, readonly TaskVM[]>([['zeta', [task('z1', 'running')]]]);
    const rows = overviewRows(features, 'zeta', tasksBySlug);
    expect(rows[0]).toMatchObject({ slug: 'zeta', active: true, total: 1, running: 1 });
    expect(rows[1]).toMatchObject({ slug: 'alpha', active: false, total: 0 });
  });

  it('handles an empty feature list', () => {
    expect(overviewRows([], '', new Map())).toEqual([]);
  });
});

describe('docRows', () => {
  it('splits relPath into basename title + dirname, preserving input order', () => {
    const docs: DocRef[] = [
      { path: 'notes/design.md', title: 'ignored-input-title' },
      { path: 'README.md', title: 'README.md' },
      { path: 'adr/0001/deep.md', title: 'deep.md' },
    ];
    expect(docRows(docs)).toEqual([
      { relPath: 'notes/design.md', title: 'design.md', dir: 'notes' },
      { relPath: 'README.md', title: 'README.md', dir: '' },
      { relPath: 'adr/0001/deep.md', title: 'deep.md', dir: 'adr/0001' },
    ]);
  });

  it('maps an empty doc list to no rows', () => {
    expect(docRows([])).toEqual([]);
  });
});

describe('iconFor', () => {
  it('matches the EXACT contract table', () => {
    expect(iconFor('running')).toEqual({ id: 'loading~spin', colorId: 'charts.blue' });
    expect(iconFor('ready')).toEqual({ id: 'circle-outline', colorId: 'charts.yellow' });
    expect(iconFor('blocked')).toEqual({ id: 'circle-slash', colorId: 'charts.orange' });
    expect(iconFor('pending')).toEqual({ id: 'circle-large-outline' });
    expect(iconFor('done')).toEqual({ id: 'check', colorId: 'testing.iconPassed' });
    expect(iconFor('failed')).toEqual({ id: 'error', colorId: 'testing.iconFailed' });
  });

  it('omits colorId entirely for pending (not undefined-valued)', () => {
    expect('colorId' in iconFor('pending')).toBe(false);
  });
});
