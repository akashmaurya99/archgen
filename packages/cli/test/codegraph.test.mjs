// CodeGraph bootstrap — the CLI side of `archgen init` / `archgen install`.
// HERMETIC: these tests never spawn codegraph, never touch the network, and
// never wire the developer's real global MCP configs — they exercise the
// skip/gate logic only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapCodegraph } from '../lib/codegraph.js';
import { initProject } from '../lib/init.js';
import { resolveSkillSource } from '../lib/init.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'archgen-codegraph-test-'));

test('codegraph: ARCHGEN_CODEGRAPH=0 skips the bootstrap (no spawn, no writes)', () => {
  const dir = tmp();
  try {
    const source = resolveSkillSource(PACKAGE_ROOT);
    const r = bootstrapCodegraph({ source, projectDir: dir, env: { ARCHGEN_CODEGRAPH: '0', HOME: dir } });
    assert.equal(r.ok, true);
    assert.match(r.skipped ?? '', /ARCHGEN_CODEGRAPH/);
    assert.ok(!existsSync(join(dir, '.codegraph')), 'skip must not index the project');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codegraph: --no-codegraph opts out of the bootstrap', () => {
  const dir = tmp();
  try {
    const source = resolveSkillSource(PACKAGE_ROOT);
    const r = bootstrapCodegraph({ source, projectDir: dir, noCodegraph: true, env: { HOME: dir } });
    assert.equal(r.ok, true);
    assert.match(r.skipped ?? '', /--no-codegraph/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codegraph: initProject forwards the skip as a warning, never as a failure', () => {
  const dir = tmp();
  try {
    const r = initProject(dir, PACKAGE_ROOT, { env: { ARCHGEN_CODEGRAPH: '0', HOME: dir } });
    assert.ok(
      r.warnings.some((w) => /codegraph bootstrap skipped/.test(w)),
      `expected a skip warning, got: ${JSON.stringify(r.warnings)}`,
    );
    assert.ok(!existsSync(join(dir, '.codegraph')), 'skip must not index the project');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
