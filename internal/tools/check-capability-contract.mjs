// check-capability-contract.mjs — CI gate for the skill↔MCP dependency.
//
// The skill declares the server version it needs:
//
//   metadata:
//     requires:
//       archgen_mcp: ">=0.0.6"
//
// A skill that demands a server release which DOES NOT EXIST can never work.
// This gate refuses to let that ship.
//
// It also refuses a requirement the server cannot satisfy TODAY — a skill
// wired to a server that is too old is a broken install for every user.
//
// Usage: node internal/tools/check-capability-contract.mjs
// Exit 0 ok · 1 contract violation · 4 usage/IO error
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCapability, readSkillRequirements } from '../../packages/mcp/src/core/compat.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

function die(msg, code = 4) {
  console.error(`capability-contract: ${msg}`);
  process.exit(code);
}

const skillDir = join(ROOT, 'skill');
let pkg;
try {
  pkg = JSON.parse(readFileSync(join(ROOT, 'packages', 'mcp', 'package.json'), 'utf8'));
} catch (e) {
  die(`cannot read packages/mcp/package.json — ${e.message}`);
}

const { requires, version } = readSkillRequirements(skillDir);
if (!requires.archgen_mcp) {
  console.error(
    'capability-contract: the skill declares NO archgen_mcp requirement.\n' +
      '  The skill calls the server\'s tools — that is a dependency and must be declared.',
  );
  process.exit(1);
}

const check = checkCapability({ skillDir, serverVersion: pkg.version });
if (!check.compatible) {
  console.error(`capability-contract: ${check.reason}`);
  console.error(
    `  The skill (v${version ?? '?'}) requires archgen-mcp ${check.required}, but this release is ${pkg.version}.`,
  );
  process.exit(1);
}

console.log(
  `capability-contract: ok — skill v${version ?? '?'} requires archgen-mcp ${check.required}, this release is ${pkg.version}.`,
);
