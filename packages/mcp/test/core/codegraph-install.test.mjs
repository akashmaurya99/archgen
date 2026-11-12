// codegraph-install.test.mjs — when the CodeGraph CLI is installed.
//
// THE RULE: install CodeGraph when it is MISSING, and leave it alone when it
// is ALREADY THERE.
//
// An installed CodeGraph is the user's to manage. The upgrade used to run on
// every bootstrap, so a plain `npx archgen-skill init` could rewrite a
// working installation the user had pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manageCodegraph } from '../../src/core/harness/codegraph-manager.mjs';
import { loadAsset } from '../../src/context.mjs';

const registry = loadAsset('harness-mcp.json');

/** A fake `codegraph` on PATH that records how it was called. */
function fakeCodegraph(dir, logFile) {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, 'codegraph');
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logFile)}\n` +
      `case "$1" in\n  --version) echo "9.9.9";;\n  telemetry) echo "off";;\n  status) echo "{}";;\nesac\n`,
    'utf8',
  );
  chmodSync(bin, 0o755);
  return { binDir, bin };
}

test('an installed CodeGraph is left exactly as it is — never upgraded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ag-cg-'));
  const home = mkdtempSync(join(tmpdir(), 'ag-cg-home-'));
  const log = join(root, 'calls.log');
  try {
    const { binDir } = fakeCodegraph(root, log);
    const report = await manageCodegraph({
      mode: 'ensure',
      projectRoot: root,
      registry,
      home,
      approved: false,
      dryRun: true,
      env: { PATH: binDir },
    });
    assert.equal(report.cli.action, 'present');
    assert.equal(report.cli.version, '9.9.9');
    // The only calls the fake recorded must NOT be an upgrade.
    const calls = (await import('node:fs')).readFileSync(log, 'utf8');
    assert.doesNotMatch(calls, /^upgrade/m, `the installed CLI was upgraded:\n${calls}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('the report never claims an upgrade happened', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ag-cg2-'));
  const home = mkdtempSync(join(tmpdir(), 'ag-cg2-home-'));
  const log = join(root, 'calls.log');
  try {
    const { binDir } = fakeCodegraph(root, log);
    const report = await manageCodegraph({
      mode: 'ensure',
      projectRoot: root,
      registry,
      home,
      approved: false,
      dryRun: true,
      env: { PATH: binDir },
    });
    assert.doesNotMatch(String(report.cli.action), /upgrade/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
