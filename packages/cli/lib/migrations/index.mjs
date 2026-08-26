// migrations/index.mjs — artifact-format migration framework.
//
// Generated artifacts live under `.archgen/<slug>/` and are written by LLM
// agents (never the CLI). As the artifact formats evolve, old projects must be
// brought forward WITHOUT data loss. This framework is the mechanism:
//
//   - every migration is ONE numbered file (`NNN-name.mjs`) next to this file;
//   - `detect(ctx)` decides whether a project still needs it (must be cheap,
//     read-only, and false once applied — migrations are idempotent);
//   - `apply(ctx)` mutates, but ONLY after the framework has snapshotted every
//     file the migration declared via its optional `files(ctx)` export into
//     `.archgen/.backup/<timestamp>/migrate/`;
//   - dry-run is the DEFAULT everywhere: nothing is written unless a caller
//     explicitly passes `{ dryRun: false }`.
//
// Migration file contract (named exports; a default object is also accepted):
//   export const id          — '001-stamp-provenance' (MUST equal the filename stem)
//   export const description — one line, doctor-tone
//   export const fromSchema  — source schema number or null (pre-schema files)
//   export const toSchema    — target schema number
//   export function detect(ctx) -> boolean
//   export function apply(ctx)  -> void   (mutates; framework backed up first)
//   export function files(ctx)  -> string[] of project-relative paths that
//                                  apply() may touch (drives --check output
//                                  AND the mandatory pre-apply backup set)
//
// ctx shape (built here, passed to detect/files/apply):
//   ctx.projectRoot   absolute root
//   ctx.dryRun        true unless explicitly applying
//   ctx.scanArtifacts() -> [{ rel, kind }] for .archgen/*/tasks.yaml and
//                          .archgen/*/architecture.yaml (dot-dirs skipped)
//   ctx.backup(rel)   snapshot one project-relative file into
//                     .archgen/.backup/<ts>/migrate/<rel>; THROWS under
//                     dry-run so a mutating migration can never run silently

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BACKUP_ROOT_REL } from '../store.js';

const MIGRATION_FILE_RE = /^(\d{3}-[a-z0-9][a-z0-9-]*)\.mjs$/;

/**
 * Load every migration file, sorted by id (numeric prefix == order).
 * Malformed migrations fail LOUDLY here — a silently-skipped migration would
 * corrupt the "everything applied" invariant.
 * @returns {Promise<Array<{id: string, description: string, fromSchema: number|null,
 *   toSchema: number, detect: Function, apply: Function, files?: Function}>>}
 */
export async function listMigrations() {
  const dir = dirname(fileURLToPath(import.meta.url));
  const stems = readdirSync(dir)
    .map((f) => MIGRATION_FILE_RE.exec(f)?.[1])
    .filter(Boolean)
    .sort();
  const out = [];
  for (const stem of stems) {
    const mod = await import(pathToFileURL(join(dir, stem + '.mjs')).href);
    out.push(normalize(mod.default ?? mod, stem));
  }
  return out;
}

function normalize(m, stem) {
  const fail = (why) => {
    throw new Error(`migration ${stem}.mjs is malformed: ${why}`);
  };
  if (!m || typeof m !== 'object') fail('no exports');
  if (m.id !== stem) fail(`id '${m.id}' must equal filename stem '${stem}'`);
  if (typeof m.description !== 'string' || !m.description) fail('missing description');
  if (!(m.fromSchema === null || typeof m.fromSchema === 'number')) fail('fromSchema must be a number or null');
  if (typeof m.toSchema !== 'number') fail('toSchema must be a number');
  if (typeof m.detect !== 'function') fail('missing detect(ctx)');
  if (typeof m.apply !== 'function') fail('missing apply(ctx)');
  if (m.files !== undefined && typeof m.files !== 'function') fail('files must be a function');
  return m;
}

/** Build the migration context. Internal — exported for tests only. */
export function makeCtx(projectRoot, { dryRun }) {
  const root = resolve(projectRoot);
  // One timestamp per context: all backups from a single apply run group
  // under one directory (colons stripped, same convention as store.moveToBackup).
  const ts = new Date().toISOString().replace(/:/g, '-');
  return {
    projectRoot: root,
    dryRun: dryRun === true,

    /** Discover generated artifacts this framework knows how to migrate. */
    scanArtifacts() {
      const base = join(root, '.archgen');
      if (!existsSync(base)) return [];
      const out = [];
      const slugs = readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
      for (const slug of slugs) {
        for (const f of ['tasks.yaml', 'architecture.yaml']) {
          const abs = join(base, slug, f);
          if (existsSync(abs) && statSync(abs).isFile()) {
            out.push({ rel: `.archgen/${slug}/${f}`, kind: f.replace(/\.yaml$/, '') });
          }
        }
      }
      return out;
    },

    /**
     * Snapshot a project-relative file into `.archgen/.backup/<ts>/migrate/`.
     * Copy (not move): the original stays in place until apply() rewrites it.
     * @param {string} relPath project-relative, e.g. `.archgen/demo/tasks.yaml`
     * @returns {string} backup location relative to the project root
     */
    backup(relPath) {
      if (this.dryRun) throw new Error(`backup('${relPath}') called during dry-run — migrations must never mutate under --check`);
      const srcAbs = join(root, ...relPath.split('/'));
      const destRel = `${BACKUP_ROOT_REL}/${ts}/migrate/${relPath}`;
      const destAbs = join(root, ...destRel.split('/'));
      mkdirSync(dirname(destAbs), { recursive: true });
      copyFileSync(srcAbs, destAbs);
      return destRel;
    },
  };
}

/**
 * Migrations not yet satisfied by `projectRoot`, in order. ALWAYS read-only.
 * @returns {Promise<Array<{id: string, description: string, fromSchema: number|null,
 *   toSchema: number, files: string[]}>>}
 */
export async function pendingMigrations(projectRoot) {
  const pending = [];
  for (const mig of await listMigrations()) {
    const ctx = makeCtx(projectRoot, { dryRun: true });
    if (!mig.detect(ctx)) continue;
    pending.push({
      id: mig.id,
      description: mig.description,
      fromSchema: mig.fromSchema,
      toSchema: mig.toSchema,
      files: mig.files ? mig.files(ctx).slice() : [],
    });
  }
  return pending;
}

/**
 * Run one migration against `projectRoot`.
 * @param {string} id migration id (filename stem)
 * @param {string} projectRoot
 * @param {{dryRun?: boolean}} opts dryRun defaults to TRUE — pass
 *   `{ dryRun: false }` to mutate (every declared file is backed up first)
 * @returns {Promise<{status: 'applied'|'would-apply'|'clean'|'not-found',
 *   id: string, description?: string, files?: string[],
 *   backups?: Array<{file: string, backup: string}>}>}
 */
export async function applyMigration(id, projectRoot, opts = {}) {
  const dryRun = opts.dryRun !== false; // dry-run default, always
  const mig = (await listMigrations()).find((m) => m.id === id);
  if (!mig) return { status: 'not-found', id };
  const ctx = makeCtx(projectRoot, { dryRun });
  if (!mig.detect(ctx)) return { status: 'clean', id };
  const files = mig.files ? mig.files(ctx).slice() : [];
  if (dryRun) return { status: 'would-apply', id, description: mig.description, files };
  // Backup EVERYTHING the migration declared before it touches anything.
  const backups = files.map((file) => ({ file, backup: ctx.backup(file) }));
  await mig.apply(ctx);
  return { status: 'applied', id, description: mig.description, files, backups };
}
