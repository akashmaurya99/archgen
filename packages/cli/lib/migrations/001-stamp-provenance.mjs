// 001-stamp-provenance.mjs — backfill the provenance header onto artifacts
// generated before the convention existed (see skill/references/
// artifact-templates.md for the forward-looking rule).
//
// What it writes: three YAML COMMENT lines at the very top of tasks.yaml and
// architecture.yaml. Comments are inert to every consumer by contract — the
// skill's zero-dep parser records them positionally (set-status.mjs preserves
// them verbatim), verify-plan.mjs never sees them as data, and the VS Code
// extension port behaves identically. Additive-only: no existing key is
// touched, nothing becomes required.
//
//   # schema_version: 1
//   # generator: archgen v0.0.4      (version token omitted when unknowable)
//   # generated_at: 2026-08-26T09:00:00.000Z
//
// Idempotency: detect/files/apply all key off the `# schema_version:` marker
// line; stamped files are invisible to this migration, so a second run is a
// no-op. apply() re-checks per file before writing — it can never double-stamp.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA_VERSION = 1;
const MARKER_RE = /^#\s*schema_version:\s*\d+\s*$/m;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const STORE_VERSION_REL = '.agents/skills/archgen/.archgen-version';

export const id = '001-stamp-provenance';
export const description = 'stamp provenance header (schema_version / generator / generated_at) onto tasks.yaml and architecture.yaml';
export const fromSchema = null;
export const toSchema = SCHEMA_VERSION;

/**
 * Code-defensive generator version: trust only an exact semver stamp in the
 * canonical store; anything else (absent, corrupt, pre-stamp) omits the token
 * rather than guessing.
 */
function generatorToken(projectRoot) {
  try {
    const v = readFileSync(join(projectRoot, ...STORE_VERSION_REL.split('/')), 'utf8').trim();
    if (SEMVER_RE.test(v)) return `archgen v${v}`;
  } catch { /* absent or unreadable */ }
  return 'archgen';
}

function stampLines(projectRoot, generatedAt) {
  return [
    `# schema_version: ${SCHEMA_VERSION}`,
    `# generator: ${generatorToken(projectRoot)}`,
    `# generated_at: ${generatedAt}`,
  ];
}

function unstampedArtifacts(ctx) {
  return ctx.scanArtifacts().filter((a) => {
    const abs = join(ctx.projectRoot, ...a.rel.split('/'));
    return !MARKER_RE.test(readFileSync(abs, 'utf8'));
  });
}

export function detect(ctx) {
  return unstampedArtifacts(ctx).length > 0;
}

export function files(ctx) {
  return unstampedArtifacts(ctx).map((a) => a.rel);
}

export function apply(ctx) {
  const generatedAt = new Date().toISOString(); // one timestamp per run
  for (const a of unstampedArtifacts(ctx)) {
    const abs = join(ctx.projectRoot, ...a.rel.split('/'));
    const content = readFileSync(abs, 'utf8');
    if (MARKER_RE.test(content)) continue; // re-check: never double-stamp
    writeFileSync(abs, stampLines(ctx.projectRoot, generatedAt).join('\n') + '\n' + content);
  }
}
