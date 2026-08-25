// sync-vendor.mjs — copy the canonical skill into the npm package payload.
// Source of truth stays at <repo>/skill; vendor/ is build output.
// Prunes non-runtime files so the published tarball stays clean:
//   - .gitkeep scaffolds
//   - scripts/test/ (end users never run the skill's own suite)
import { cpSync, existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(cliRoot, '..', '..', 'skill'); // repo root moved one deeper in the monorepo
const dest = join(cliRoot, 'vendor', 'skills', 'archgen');

rmSync(dest, { recursive: true, force: true });
cpSync(source, dest, { recursive: true });

function prune(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) prune(p);
    else if (entry === '.gitkeep') unlinkSync(p);
  }
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
}
prune(dest);
rmSync(join(dest, 'scripts', 'test'), { recursive: true, force: true });

if (!existsSync(join(dest, 'SKILL.md'))) throw new Error('sync failed: SKILL.md missing from vendor');
console.log('synced skill -> vendor/skills/archgen (pruned .gitkeep + scripts/test)');
