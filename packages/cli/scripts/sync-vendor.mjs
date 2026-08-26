// sync-vendor.mjs — copy the canonical skill into the npm package payload.
// Source of truth stays at <repo>/skill; vendor/ is build output.
// Prunes non-runtime files so the published tarball stays clean:
//   - .gitkeep scaffolds
//   - scripts/test/ (end users never run the skill's own suite)
//   - OS junk (.DS_Store, Thumbs.db, desktop.ini)
// Post-sync assertion: the derived skill/archgen.config.json must land in
// vendor byte-identical — it is the published-layout copy the config loader
// resolves, so a stale/missing one would break version reporting.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI_ROOT = resolve(SCRIPT_DIR, '..'); // packages/cli

const OS_JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

function hashFile(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/**
 * Sync <root>/skill into <root>/packages/cli/vendor/skills/archgen.
 * @param {{root?: string}} opts repo root (defaults to this checkout's root)
 * @returns {{source: string, dest: string}}
 */
export function syncVendor({ root } = {}) {
  const cliRoot = root ? resolve(root, 'packages', 'cli') : DEFAULT_CLI_ROOT;
  const repoRoot = root ? resolve(root) : resolve(cliRoot, '..', '..');
  const source = join(repoRoot, 'skill'); // repo root moved one deeper in the monorepo
  const dest = join(cliRoot, 'vendor', 'skills', 'archgen');

  if (!existsSync(join(source, 'archgen.config.json'))) {
    throw new Error(
      'skill/archgen.config.json missing - run `npm run sync:config` first ' +
        '(it derives this file from the repo-root archgen.config.json)',
    );
  }

  rmSync(dest, { recursive: true, force: true });
  cpSync(source, dest, { recursive: true });

  function prune(dir) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) prune(p);
      else if (entry === '.gitkeep' || OS_JUNK.has(entry)) unlinkSync(p);
    }
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  }
  prune(dest);
  rmSync(join(dest, 'scripts', 'test'), { recursive: true, force: true });

  if (!existsSync(join(dest, 'SKILL.md'))) throw new Error('sync failed: SKILL.md missing from vendor');

  // Post-sync assertion: vendored archgen.config.json must be byte-identical
  // to the derived source copy (sha256), else the published package would
  // report a stale canonical version.
  const srcCfg = join(source, 'archgen.config.json');
  const dstCfg = join(dest, 'archgen.config.json');
  if (!existsSync(dstCfg)) throw new Error('sync failed: archgen.config.json missing from vendor');
  if (hashFile(srcCfg) !== hashFile(dstCfg)) {
    throw new Error('sync failed: vendor archgen.config.json does not match skill/archgen.config.json');
  }

  return { source, dest };
}

function main() {
  const args = process.argv.slice(2);
  let root;
  const ri = args.indexOf('--root');
  if (ri !== -1 && args[ri + 1]) root = resolve(args[ri + 1]);
  const { dest } = syncVendor({ root });
  console.log(`synced skill -> ${dest} (pruned .gitkeep + scripts/test; archgen.config.json hash verified)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
