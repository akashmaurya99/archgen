// bootstrap.test.mjs — the CLI side of `archgen init` / `archgen install`.
//
// HERMETIC: these tests never spawn the MCP server, never touch the network,
// and never wire the developer's real global MCP configs — they exercise the
// skip/gate logic only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapServers } from '../lib/bootstrap.js';
import { initProject } from '../lib/init.js';
import { resolveSkillSource } from '../lib/init.js';
import { resolveMcpBinary } from '../lib/mcp-server.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = join(dirname(THIS_FILE), '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'archgen-bootstrap-test-'));

test('bootstrap: ARCHGEN_CODEGRAPH=0 skips it (no spawn, no writes)', () => {
  const dir = tmp();
  try {
    const r = bootstrapServers({ projectDir: dir, env: { ARCHGEN_CODEGRAPH: '0', HOME: dir } });
    assert.equal(r.ok, true);
    assert.match(r.skipped ?? '', /ARCHGEN_CODEGRAPH/);
    assert.ok(!existsSync(join(dir, '.codegraph')), 'skip must not index the project');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrap: --no-mcp and --no-codegraph together skip it', () => {
  const dir = tmp();
  try {
    const r = bootstrapServers({
      projectDir: dir,
      noMcp: true,
      noCodegraph: true,
      env: { HOME: dir },
    });
    assert.equal(r.ok, true);
    assert.match(r.skipped ?? '', /--no-mcp/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('initProject forwards the skip as a warning, never as a failure', () => {
  const dir = tmp();
  try {
    const r = initProject(dir, PACKAGE_ROOT, { env: { ARCHGEN_CODEGRAPH: '0', HOME: dir } });
    assert.ok(
      r.warnings.some((w) => /server bootstrap skipped/.test(w)),
      `expected a skip warning, got: ${JSON.stringify(r.warnings)}`,
    );
    assert.ok(!existsSync(join(dir, '.codegraph')), 'skip must not index the project');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the MCP binary resolves in a fixed order: override, local, PATH, npx', () => {
  const dir = tmp();
  try {
    // No binary anywhere -> the npx fallback.
    const fallback = resolveMcpBinary({ projectRoot: dir, home: dir, env: { PATH: '' } });
    assert.equal(fallback.bin, null);
    assert.equal(fallback.source, 'npx');
    assert.deepEqual(fallback.args, ['-y', 'archgen-mcp']);

    // An explicit override wins.
    const override = resolveMcpBinary({
      projectRoot: dir,
      home: dir,
      env: { ARCHGEN_MCP_BIN: THIS_FILE, PATH: '' },
    });
    assert.equal(override.bin, THIS_FILE);
    assert.equal(override.source, 'override');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
