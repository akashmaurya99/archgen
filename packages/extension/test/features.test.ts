// Multi-feature host tests: .archgen/<slug>/ discovery ordering (mtime DESC),
// active-slug resolution, workspaceState persistence round-trip (mocked
// Memento), and the scoped model build (per-feature warnings).
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activeFeatureKey,
  buildScopedModel,
  discoverFeatures,
  pickActiveSlug,
  type FeatureStateStore,
} from '../src/host/features.js';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'archgen-features-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const ALPHA_YAML = [
  'tasks:',
  '  - id: A1',
  '    title: Alpha root',
  '    file_ownership: ["a/**"]',
  '    acceptance: ["x"]',
  '  - id: A2',
  '    title: Alpha child',
  '    depends_on:',
  '      - A1',
  '      - GHOST',
  '',
].join('\n');

const BETA_YAML = ['tasks:', '  - id: B1', '    title: Beta solo', ''].join('\n');

/** Create a feature whose tasks.yaml carries a DETERMINISTIC mtime. */
function makeFeature(ws: string, slug: string, yaml: string, mtimeMs: number): string {
  const dir = join(ws, '.archgen', slug);
  mkdirSync(dir, { recursive: true });
  const tasksPath = join(dir, 'tasks.yaml');
  writeFileSync(tasksPath, yaml);
  const stamp = new Date(mtimeMs);
  utimesSync(tasksPath, stamp, stamp);
  return tasksPath;
}

function fakeWorkspaceState(): FeatureStateStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    update(key: string, value: unknown): Thenable<void> {
      map.set(key, value);
      return Promise.resolve();
    },
  };
}

describe('discoverFeatures ordering', () => {
  it('lists ALL features most-recently-modified FIRST with deterministic tie-breaks', () => {
    const ws = scratch();
    makeFeature(ws, 'alpha', ALPHA_YAML, 1000);
    makeFeature(ws, 'beta', BETA_YAML, 3000);
    makeFeature(ws, 'gamma', BETA_YAML, 2000);
    // equal mtimes tie-break by slug ASC so ordering is stable
    makeFeature(ws, 'aaa', BETA_YAML, 1000);
    expect(discoverFeatures(ws).map((f) => f.slug)).toEqual(['beta', 'gamma', 'aaa', 'alpha']);
  });

  it('ignores plain files, feature dirs without tasks.yaml, and missing .archgen', () => {
    const ws = scratch();
    makeFeature(ws, 'real', BETA_YAML, 1000);
    mkdirSync(join(ws, '.archgen', 'hollow')); // no tasks.yaml
    writeFileSync(join(ws, '.archgen', 'stray.txt'), 'not a dir');
    expect(discoverFeatures(ws).map((f) => f.slug)).toEqual(['real']);
    expect(discoverFeatures(join(ws, 'nowhere'))).toEqual([]);
  });

  it('reports absolute tasks.yaml paths and ms timestamps', () => {
    const ws = scratch();
    const p = makeFeature(ws, 'solo', BETA_YAML, 5000);
    const [only] = discoverFeatures(ws);
    expect(only?.slug).toBe('solo');
    expect(only?.tasksPath).toBe(p);
    expect(only?.updatedAt).toBe(5000);
  });
});

describe('pickActiveSlug resolution', () => {
  // host-ordered input: most-recent FIRST (as discoverFeatures returns)
  const features = [
    { slug: 'new', tasksPath: '/w/.archgen/new/tasks.yaml', updatedAt: 9 },
    { slug: 'old', tasksPath: '/w/.archgen/old/tasks.yaml', updatedAt: 1 },
  ];

  it('defaults to the most-recent feature when nothing is stored', () => {
    expect(pickActiveSlug(features, undefined)).toBe('new');
    expect(pickActiveSlug(features, '')).toBe('new');
  });

  it('keeps the persisted choice while that feature still exists', () => {
    expect(pickActiveSlug(features, 'old')).toBe('old');
  });

  it('falls back to most-recent when the stored slug vanished', () => {
    expect(pickActiveSlug(features, 'deleted-slug')).toBe('new');
    expect(pickActiveSlug([], 'anything')).toBe('');
  });
});

describe('workspaceState persistence round-trip (mocked Memento)', () => {
  it('stores the picked slug per workspace and honors it over recency', async () => {
    const ws = scratch();
    makeFeature(ws, 'alpha', ALPHA_YAML, 1000);
    makeFeature(ws, 'beta', BETA_YAML, 2000);
    const state = fakeWorkspaceState();
    const key = activeFeatureKey(ws);
    expect(key).toBe(`archgen.activeFeature:${ws}`);

    expect(pickActiveSlug(discoverFeatures(ws), state.get<string>(key))).toBe('beta');

    await state.update(key, 'alpha');
    expect(state.map.get(key)).toBe('alpha');
    expect(pickActiveSlug(discoverFeatures(ws), state.get<string>(key))).toBe('alpha');

    const otherState = fakeWorkspaceState();
    expect(activeFeatureKey(join(ws, 'sibling'))).not.toBe(key);
    expect(pickActiveSlug(discoverFeatures(ws), otherState.get<string>(key))).toBe('beta');
  });

  it('keeps the stored slug valid after the other feature disappears', async () => {
    const ws = scratch();
    makeFeature(ws, 'keep', BETA_YAML, 1000);
    makeFeature(ws, 'drop', BETA_YAML, 2000);
    const state = fakeWorkspaceState();
    const key = activeFeatureKey(ws);
    await state.update(key, 'keep');
    rmSync(join(ws, '.archgen', 'drop'), { recursive: true });
    expect(pickActiveSlug(discoverFeatures(ws), state.get<string>(key))).toBe('keep');
  });
});

describe('buildScopedModel', () => {
  it('scopes tasks to the ACTIVE slug while warnings stay per-feature and docs stay global', () => {
    const ws = scratch();
    const alphaPath = makeFeature(ws, 'alpha', ALPHA_YAML, 1000);
    const betaPath = makeFeature(ws, 'beta', BETA_YAML, 2000);
    mkdirSync(join(ws, '.archgen', 'beta', 'notes'), { recursive: true });
    writeFileSync(join(ws, '.archgen', 'beta', 'notes', 'b.md'), '# b\n');
    writeFileSync(join(ws, '.archgen', 'alpha', 'a.md'), '# a\n');

    const scoped = buildScopedModel(ws, undefined);
    expect(scoped.features.map((f) => f.slug)).toEqual(['beta', 'alpha']);
    expect(scoped.activeSlug).toBe('beta');
    expect(scoped.tasks.map((t) => t.id)).toEqual(['B1']);
    expect(scoped.warnings.some((w) => w.startsWith('alpha:') && /GHOST/.test(w))).toBe(true);
    expect(scoped.warnings.some((w) => w.startsWith('beta:'))).toBe(false);
    expect(new Set(scoped.docs.map((d) => d.path))).toEqual(new Set(['alpha/a.md', 'beta/notes/b.md']));
    void alphaPath;
    void betaPath;
  });

  it('honors the persisted slug for task scoping', () => {
    const ws = scratch();
    makeFeature(ws, 'alpha', ALPHA_YAML, 1000);
    makeFeature(ws, 'beta', BETA_YAML, 2000);
    const scoped = buildScopedModel(ws, 'alpha');
    expect(scoped.activeSlug).toBe('alpha');
    expect(scoped.tasks.map((t) => t.id)).toEqual(['A1', 'A2']);
    expect(scoped.tasks[1]?.dependsOn).toContain('GHOST');
  });

  it('passes tasks.yaml acceptance criteria through to the scoped TaskVMs', () => {
    const ws = scratch();
    makeFeature(ws, 'alpha', ALPHA_YAML, 1000);
    const scoped = buildScopedModel(ws, 'alpha');
    expect(scoped.tasks.map((t) => t.id)).toEqual(['A1', 'A2']);
    expect(scoped.tasks[0]?.acceptance).toEqual(['x']);
    // absent key parses to an EMPTY list, never undefined
    expect(scoped.tasks[1]?.acceptance).toEqual([]);
  });

  it('surfaces unreadable YAML as a typed per-feature warning instead of crashing', () => {
    const ws = scratch();
    makeFeature(ws, 'good', BETA_YAML, 1000);
    makeFeature(ws, 'bad', '::: not yaml :::\n', 2000);
    const scoped = buildScopedModel(ws, undefined);
    expect(scoped.activeSlug).toBe('bad');
    // the active feature failed to parse: no DAG tasks, but the board survives
    expect(scoped.tasks).toEqual([]);
    expect(scoped.warnings.some((w) => w.startsWith('bad: tasks.yaml unreadable:'))).toBe(true);
  });

  it('per-feature isolation: a CORRUPT INACTIVE feature never kills the active board', () => {
    const ws = scratch();
    // good is NEWEST → active; corrupt is older → inactive. The corrupt sibling
    // must degrade to a prefixed warning while the active DAG renders fully.
    makeFeature(ws, 'corrupt', '\ttabs are illegal\n::: nope\n', 1000);
    makeFeature(ws, 'good', ALPHA_YAML, 2000);
    const scoped = buildScopedModel(ws, undefined);
    expect(scoped.activeSlug).toBe('good');
    expect(scoped.features.map((f) => f.slug)).toEqual(['good', 'corrupt']);
    expect(scoped.tasks.map((t) => t.id)).toEqual(['A1', 'A2']);
    expect(scoped.warnings.some((w) => w.startsWith('corrupt: tasks.yaml unreadable:'))).toBe(true);
    // warnings from the healthy feature's own parse (dangling GHOST) still surface
    expect(scoped.warnings.some((w) => w.startsWith('good:') && /GHOST/.test(w))).toBe(true);
  });

  it('returns an empty scope for missing workspace or absent .archgen', () => {
    expect(buildScopedModel(null, undefined)).toEqual({ features: [], activeSlug: '', tasks: [], docs: [], warnings: [] });
    expect(buildScopedModel(scratch(), undefined)).toEqual({ features: [], activeSlug: '', tasks: [], docs: [], warnings: [] });
  });
});

describe('symlinked tasks.yaml inside the workspace (todo 9)', () => {
  function trySymlink(target: string, dest: string): boolean {
    try {
      symlinkSync(target, dest);
      return true;
    } catch {
      return false; // platform without symlink privileges — caller skips
    }
  }

  it('a tasks.yaml that is a symlink to a real file is discovered, read, and parsed', (ctx) => {
    const ws = scratch();
    const sharedDir = join(ws, 'shared-plans');
    mkdirSync(sharedDir, { recursive: true });
    const realPath = join(sharedDir, 'tasks.yaml');
    writeFileSync(realPath, BETA_YAML);

    mkdirSync(join(ws, '.archgen', 'linked'), { recursive: true });
    if (!trySymlink(realPath, join(ws, '.archgen', 'linked', 'tasks.yaml'))) ctx.skip();

    const features = discoverFeatures(ws);
    expect(features.map((f) => f.slug)).toEqual(['linked']);
    // stat follows the link: the feature carries the TARGET's mtime
    expect(features[0]?.updatedAt).toBeGreaterThan(0);

    const scoped = buildScopedModel(ws, undefined);
    expect(scoped.activeSlug).toBe('linked');
    expect(scoped.tasks.map((t) => t.id)).toEqual(['B1']);
    expect(scoped.warnings).toEqual([]);
  });

  it('a DANGLING tasks.yaml symlink is silently skipped — no crash, no phantom feature', (ctx) => {
    const ws = scratch();
    makeFeature(ws, 'real', BETA_YAML, 1000);
    mkdirSync(join(ws, '.archgen', 'dangling'), { recursive: true });
    if (!trySymlink(join(ws, 'nowhere', 'missing.yaml'), join(ws, '.archgen', 'dangling', 'tasks.yaml'))) ctx.skip();

    const scoped = buildScopedModel(ws, undefined);
    expect(scoped.features.map((f) => f.slug)).toEqual(['real']);
    expect(scoped.activeSlug).toBe('real');
    expect(scoped.tasks.map((t) => t.id)).toEqual(['B1']);
    expect(scoped.warnings).toEqual([]);
  });

  it('a SYMLINKED FEATURE DIRECTORY is not discovered — features cannot escape the workspace', (ctx) => {
    const ws = scratch();
    const outside = join(ws, 'outside-feature');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'tasks.yaml'), BETA_YAML);
    mkdirSync(join(ws, '.archgen'), { recursive: true });
    if (!trySymlink(outside, join(ws, '.archgen', 'alias'))) ctx.skip();

    // Dirent.isDirectory() is false for symlinks, so the alias never enters
    // discovery — .archgen/ stays the hard containment boundary.
    expect(discoverFeatures(ws)).toEqual([]);
    expect(buildScopedModel(ws, undefined).features).toEqual([]);
  });
});
