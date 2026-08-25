// Sidebar cockpit data layer: PURE row builders — grouping order, status
// summaries, overview rollups, doc rows and the exact icon table. Zero
// 'vscode' involvement; providers.ts is the only vscode-facing adapter.
import { describe, expect, it } from 'vitest';

import {
  STATUS_GROUPS,
  docRows,
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
