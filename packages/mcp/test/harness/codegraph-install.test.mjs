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
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manageCodegraph, globalInstallEnv } from '../../src/core/harness/codegraph-manager.mjs';
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

// ARCHGEN_CODEGRAPH=0 means "no CodeGraph bootstrap: no spawn, no network, no
// writes". The CLI honoured it in ONE place — its own bootstrap helper — so
// the SERVER, the layer that actually runs `npm install -g`, never saw it.
// Every other path into the server installed CodeGraph with the switch set:
// `archgen-skill mcp add`, the MCP tool, the `exec` facade.
test('ARCHGEN_CODEGRAPH=0 disables the install — even with approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ag-cg3-'));
  const home = mkdtempSync(join(tmpdir(), 'ag-cg3-home-'));
  try {
    // NO fake codegraph on PATH: the CLI is missing, which is exactly when
    // the install would run.
    const report = await manageCodegraph({
      mode: 'ensure',
      projectRoot: root,
      registry,
      home,
      approved: true,
      env: { PATH: '/nonexistent-archgen-test-path', ARCHGEN_CODEGRAPH: '0' },
    });
    assert.equal(report.policy.disabled, true, 'the report must say CodeGraph is off');
    assert.equal(report.cli.action, 'absent', 'the CLI was not installed');
    assert.equal(report.cli.present, false);
    assert.notEqual(report.cli.action, 'installed');
    assert.match(String(report.cli.detail), /switched off/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('the telemetry setting is not written when CodeGraph is switched off', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ag-cg4-'));
  const home = mkdtempSync(join(tmpdir(), 'ag-cg4-home-'));
  const log = join(root, 'calls.log');
  try {
    const { binDir } = fakeCodegraph(root, log);
    const report = await manageCodegraph({
      mode: 'ensure',
      projectRoot: root,
      registry,
      home,
      approved: true,
      telemetry: 'off',
      env: { PATH: binDir, ARCHGEN_CODEGRAPH: '0' },
    });
    assert.equal(report.telemetry.action, 'skipped');
    const calls = readFileSync(log, 'utf8');
    assert.doesNotMatch(calls, /^telemetry off$/m, `the telemetry setting was written:\n${calls}`);
    assert.doesNotMatch(calls, /^init /m, `the project index was built:\n${calls}`);
    assert.equal(report.index.action, 'skipped');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('a global install ignores the prefix npm inherited from the script', async () => {
  // `npm install -g` installs into the GLOBAL prefix — unless the
  // environment says otherwise. npm sets `npm_config_prefix` whenever it
  // runs a script with `--prefix`, and under `npm --prefix packages/cli
  // test` a global CodeGraph install landed in `packages/cli/` — inside the
  // package it was supposed to install FOR.
  //
  // The variables are set to `undefined` rather than DELETED, because the
  // callers MERGE the environment with `process.env`: a deleted key is
  // absent from the patch, so the merge restored npm's inherited prefix.
  const inherited = {
    npm_config_prefix: '/some/local/tree',
    npmConfigPrefix: '/some/local/tree',
    NPM_CONFIG_PREFIX: '/some/local/tree',
  };
  const env = globalInstallEnv({ ...inherited, PATH: '/usr/bin:/bin', HOME: '/home/me' });
  // The merge the callers do:
  const merged = { ...process.env, ...env };
  assert.equal(merged.npm_config_prefix, undefined, 'the inherited prefix came back');
  assert.equal(merged.npmConfigPrefix, undefined);
  assert.equal(merged.NPM_CONFIG_PREFIX, undefined);
  // The rest of the environment survives.
  assert.equal(merged.PATH, '/usr/bin:/bin');
  assert.equal(merged.HOME, '/home/me');
});
