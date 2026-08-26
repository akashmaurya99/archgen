// migrate.js — `archgen migrate [dir] [--check] [--apply] [--migration <id>]`.
//
// Evolves generated-artifact formats in existing projects with zero data loss.
// Tone and safety model mirror doctor: dry-run is the DEFAULT (--check lists
// pending migrations and the exact files they would touch, writing nothing);
// --apply runs them, snapshotting every affected file into
// .archgen/.backup/<ts>/migrate/ BEFORE any modification. Exit codes:
//   0  nothing pending, or all migrations applied cleanly
//   1  a migration failed mid-apply (earlier files stay backed up)
//   2  usage error (unknown flag / unknown --migration id / --check + --apply)
//
// bin/archgen.mjs wiring (integrator):
//   case 'migrate': process.exitCode = await migrateMain(rest); break;

import { applyMigration, listMigrations, pendingMigrations } from './migrations/index.mjs';
import { resolve } from 'node:path';

const USAGE = 'usage: archgen-skill migrate [dir] [--check|--apply] [--migration <id>]';

/**
 * @param {string[]} argv args AFTER the subcommand, e.g. ['myproj', '--apply']
 * @returns {Promise<number>} exit code int
 */
export async function migrateMain(argv = []) {
  let dir = null;
  let check = false;
  let apply = false;
  let target = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') check = true;
    else if (a === '--apply') apply = true;
    else if (a === '--migration') {
      target = argv[++i];
      if (!target || target.startsWith('-')) { console.error(USAGE); return 2; }
    } else if (a.startsWith('-')) {
      console.error(`unknown flag: ${a}\n${USAGE}`);
      return 2;
    } else if (dir === null) dir = a;
    else { console.error(`unexpected argument: ${a}\n${USAGE}`); return 2; }
  }
  if (check && apply) { console.error('--check and --apply are mutually exclusive\n' + USAGE); return 2; }

  const dryRun = !apply; // check mode is the default, always
  const root = resolve(dir ?? process.cwd());

  const all = await listMigrations();
  if (target && !all.some((m) => m.id === target)) {
    console.error(`unknown migration '${target}' (available: ${all.map((m) => m.id).join(', ') || 'none'})`);
    return 2;
  }

  const pending = (await pendingMigrations(root)).filter((p) => !target || p.id === target);

  console.log('archgen migrate — ' + root + (dryRun ? '  (check mode: no changes made)' : ''));

  if (pending.length === 0) {
    console.log('  = nothing to do — all migrations applied');
    console.log('Summary: up to date — 0 pending');
    return 0;
  }

  let fileCount = 0;
  let failed = 0;
  for (const p of pending) {
    if (dryRun) {
      console.log(`  [would-apply] ${p.id} — ${p.description}`);
      for (const f of p.files) console.log(`      ${f}`);
      fileCount += p.files.length;
      continue;
    }
    try {
      const r = await applyMigration(p.id, root, { dryRun: false });
      if (r.status === 'clean') { console.log(`  [skip] ${r.id} — already applied`); continue; }
      console.log(`  [applied] ${r.id} — ${r.description}`);
      for (const b of r.backups ?? []) console.log(`      ${b.file}  (backup: ${b.backup})`);
      fileCount += (r.files ?? []).length;
    } catch (e) {
      failed++;
      console.log(`  [fail] ${p.id} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (dryRun) console.log(`Summary: ${pending.length} migration(s) pending, ${fileCount} file(s) would change`);
  else console.log(`Summary: ${pending.length - failed} applied, ${fileCount} file(s) changed, ${failed} failure(s)`);
  return failed > 0 ? 1 : 0;
}
