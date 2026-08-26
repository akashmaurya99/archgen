// features.ts — multi-feature discovery + active-slug scoping (host side).
//
// A repo may hold SEVERAL `.archgen/<slug>/` features. This module scans them
// all, orders them most-recently-modified first, and scopes the posted model
// to ONE active slug: the user's persisted choice when still valid, otherwise
// the most-recent feature. Everything here is vscode-free so vitest (node env)
// can exercise it directly; extension.ts owns the real workspaceState wiring.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DocRef, FeatureInfo, TaskVM } from '../shared/protocol';
import { parseTasks } from './readers/archgen.js';

/**
 * Minimal persistence surface (structural subset of vscode Memento) so the
 * round-trip can be tested with an in-memory fake.
 */
export interface FeatureStateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** workspaceState key holding the chosen slug for one workspace. */
export function activeFeatureKey(workspaceFsPath: string): string {
  return `archgen.activeFeature:${workspaceFsPath}`;
}

/**
 * Scan ALL `<wsRoot>/.archgen/<slug>/tasks.yaml` (directories only) and order
 * the features most-recently-modified FIRST. Equal mtimes tie-break by slug
 * ASC so ordering stays deterministic in fast-writing tests and checkouts.
 */
export function discoverFeatures(wsRoot: string): FeatureInfo[] {
  const archgenDir = path.join(wsRoot, '.archgen');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(archgenDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: FeatureInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const tasksPath = path.join(archgenDir, entry.name, 'tasks.yaml');
    if (!fs.existsSync(tasksPath)) continue;
    let updatedAt = 0;
    try {
      updatedAt = fs.statSync(tasksPath).mtimeMs;
    } catch {
      /* unreadable stat — keep the feature at epoch, it still sorts last */
    }
    out.push({ slug: entry.name, tasksPath, updatedAt });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt || a.slug.localeCompare(b.slug));
  return out;
}

/**
 * Resolve the active slug: the persisted choice while that feature still
 * exists, else the most-recent feature; '' when the repo has none.
 */
export function pickActiveSlug(features: readonly FeatureInfo[], storedSlug: string | undefined): string {
  if (storedSlug !== undefined && storedSlug !== '' && features.some((f) => f.slug === storedSlug)) {
    return storedSlug;
  }
  return features[0]?.slug ?? '';
}

export interface ScopedFeatureModel {
  features: FeatureInfo[];
  activeSlug: string;
  tasks: TaskVM[];
  docs: DocRef[];
  warnings: string[];
}

function toTaskVMs(text: string, slug: string): { tasks: TaskVM[]; warnings: string[] } {
  const model = parseTasks(text, `${slug}/tasks.yaml`);
  const tasks = model.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    dependsOn: t.depends_on,
    fileOwnership: t.file_ownership,
    artifacts: t.artifacts,
    parallelGroup: t.parallel_group,
    acceptance: t.acceptance,
  }));
  const warnings = model.warnings.map((w) => `${slug}: ${w.message}`);
  return { tasks, warnings };
}

/**
 * Read every discovered feature once per snapshot: parse failures surface as
 * per-feature `<slug>: …` warnings instead of killing the board, while only
 * the ACTIVE feature's tasks back the DAG. Docs stay global across features.
 */
export function buildScopedModel(wsRoot: string | null, storedSlug: string | undefined): ScopedFeatureModel {
  const features = wsRoot ? discoverFeatures(wsRoot) : [];
  const activeSlug = pickActiveSlug(features, storedSlug);
  const tasks: TaskVM[] = [];
  const docs: DocRef[] = [];
  const warnings: string[] = [];

  if (!wsRoot) return { features, activeSlug, tasks, docs, warnings };

  for (const feature of features) {
    try {
      const scoped = toTaskVMs(fs.readFileSync(feature.tasksPath, 'utf8'), feature.slug);
      if (feature.slug === activeSlug) tasks.push(...scoped.tasks);
      warnings.push(...scoped.warnings);
    } catch (e) {
      warnings.push(`${feature.slug}: tasks.yaml unreadable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const base = path.join(wsRoot, '.archgen');
  collectMarkdown(base, docs, base);

  return { features, activeSlug, tasks, docs, warnings };
}

function collectMarkdown(dir: string, outDocs: DocRef[], rootBase: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectMarkdown(p, outDocs, rootBase);
    else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) {
      outDocs.push({ path: path.relative(rootBase, p), title: e.name });
    }
  }
}
