// sync-vendor.mjs — copy the canonical skill into the npm package payload.
// Source of truth stays at <repo>/skills/archgen; vendor/ is build output.
import { cpSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(cliRoot, '..', 'skills', 'archgen');
const dest = join(cliRoot, 'vendor', 'skills', 'archgen');
rmSync(dest, { recursive: true, force: true });
cpSync(source, dest, { recursive: true });
console.log('synced skills/archgen -> cli/vendor/skills/archgen');
