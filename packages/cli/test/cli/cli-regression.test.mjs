// CLI-surface fixes.
//
// M9:  `archgen uninstall <dir>` dropped the positional and performed a GLOBAL
//      uninstall (every harness dir in the user's home).
// M10: `update` discarded the doctor's exit status.
// M11: an unparseable registry version compared "equal" and was reported as
//      "already on the latest version" — the refusal was unreachable.
// M12: `install`/`uninstall` did not refuse unknown flags.
// M13: `init myproj extra` silently ignored the extra positional.
// L3:  `update` re-executed the FIRST `archgen-skill` on PATH — often the OLD
//      global install — instead of the binary npm just wrote.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globalBinPath, globalInstallEnv } from '../../lib/spawn-npm.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(CLI, 'bin', 'archgen.mjs');

let proj, home, prefix, pathDir, mcpStub;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'ag-cli-fix-'));
  home = join(proj, 'home');
  prefix = join(proj, 'prefix');
  pathDir = join(proj, 'path');
  mkdirSync(home, { recursive: true });
  mkdirSync(prefix, { recursive: true });
  mkdirSync(pathDir, { recursive: true });
  // A local MCP stub keeps the CLI hermetic and fast.
  mcpStub = join(proj, 'mcp-stub.js');
  writeFileSync(mcpStub, `#!/usr/bin/env node\nprocess.exit(0);\n`, { mode: 0o755 });
});
afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
});

/** Run the CLI in a scratch cwd; never touches the real project. */
function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: proj,
    encoding: 'utf8',
    env: {
      ...process.env,
      ARCHGEN_CODEGRAPH: '0',
      ARCHGEN_MCP_BIN: mcpStub,
      HOME: home,
      ...extraEnv,
    },
  });
}

/**
 * A fake npm: the CLI resolves npm through `npm_execpath`, so the update flow
 * can be exercised without a network or a real global install.
 */
function fakeNpm({ version, installMarker }) {
  const npmCli = join(proj, 'fake-npm.js');
  const fakeBin = join(proj, 'fake-archgen-skill.js');
  writeFileSync(npmCli, `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const prefix = process.env.npm_config_prefix;
if (args[0] === 'view') { console.log(process.env.FAKE_NPM_VERSION); process.exit(0); }
if (args[0] === 'prefix') { console.log(prefix); process.exit(0); }
if (args[0] === 'install') {
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(prefix, 'bin', 'archgen-skill'), fs.readFileSync(${JSON.stringify(fakeBin)}), { mode: 0o755 });
  fs.writeFileSync(${JSON.stringify(installMarker)}, 'installed');
  process.exit(0);
}
process.exit(0);
`);
  writeFileSync(fakeBin, `#!${process.execPath}
console.log('FRESH-BINARY');
process.exit(process.argv[2] === 'doctor' ? 1 : 0);
`, { mode: 0o755 });
  return npmCli;
}

/** An OLD archgen-skill on PATH: using it would mask a stale-binary bug. */
function oldBinaryOnPath() {
  const p = join(pathDir, 'archgen-skill');
  writeFileSync(p, `#!${process.execPath}\nconsole.log('OLD-BINARY');\nprocess.exit(0);\n`, { mode: 0o755 });
  return p;
}

/** PATH with the stale binary FIRST, but the real tools still reachable. */
function pathWithOldBinary() {
  return pathDir + ':' + (process.env.PATH ?? '');
}

// M14: `npm install -g` inherited npm_config_prefix and installed into a
//      LOCAL tree. Under `npm --prefix packages/cli test` — which is exactly
//      what CI runs — a global CodeGraph install landed in
//      `packages/cli/lib/node_modules/`, inside the package it was supposed
//      to install FOR: invisible to every later run, and a dangling-symlink
//      crash for the next one.
test('M14: a global install ignores the prefix npm inherited from the script', () => {
  const env = {
    npm_config_prefix: '/some/local/tree',
    npmConfigPrefix: '/some/local/tree',
    NPM_CONFIG_PREFIX: '/some/local/tree',
    npm_config_globalconfig: '/some/local/npmrc',
    PATH: '/usr/bin:/bin',
  };
  const out = globalInstallEnv(env);
  assert.equal(out.npm_config_prefix, undefined);
  assert.equal(out.npmConfigPrefix, undefined);
  assert.equal(out.NPM_CONFIG_PREFIX, undefined);
  assert.equal(out.npm_config_globalconfig, undefined);
  // The rest of the environment survives — a global install still needs HOME.
  assert.equal(out.PATH, '/usr/bin:/bin');
  assert.equal(out.npm_config_prefix, undefined);
  // The ORIGINAL environment is not mutated: the caller may need the prefix
  // for a LOCAL install afterwards.
  assert.equal(env.npm_config_prefix, '/some/local/tree');
});

test('M14: the global-install env still carries the credentials npm needs', () => {
  const env = { HOME: '/home/me', npm_config_prefix: '/local', NPM_CONFIG_USERCONFIG: '/home/me/.npmrc' };
  const out = globalInstallEnv(env);
  assert.equal(out.HOME, '/home/me');
  assert.equal(out.NPM_CONFIG_USERCONFIG, '/home/me/.npmrc');
});

test('M9: `uninstall <dir>` removes that PROJECT and not every global install', () => {
  const target = join(proj, 'myproj');
  assert.equal(run(['init', target, '--no-mcp', '--no-codegraph']).status, 0);

  // A global install recorded in the manifest.
  const globalEntry = join(home, '.claude', 'skills', 'archgen');
  mkdirSync(dirname(globalEntry), { recursive: true });
  writeFileSync(globalEntry, 'global copy\n');
  const manifest = join(home, '.archgen-install-manifest.list');
  writeFileSync(manifest, `copy\t${globalEntry}\n`);

  const r = run(['uninstall', target]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /project uninstall/, 'the positional routed to the project uninstall');
  assert.ok(!existsSync(join(target, '.agents', 'skills', 'archgen')), 'the project store was removed');
  assert.ok(existsSync(globalEntry), 'the global install was NOT removed');
  assert.ok(existsSync(manifest), 'the global manifest was NOT removed');
});

test('M9: `uninstall` without a project still performs the global uninstall', () => {
  const globalEntry = join(home, '.claude', 'skills', 'archgen');
  mkdirSync(dirname(globalEntry), { recursive: true });
  writeFileSync(globalEntry, 'global copy\n');
  const manifest = join(home, '.archgen-install-manifest.list');
  writeFileSync(manifest, `copy\t${globalEntry}\n`);

  const r = run(['uninstall']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /removed 1 entry/);
  assert.ok(!existsSync(globalEntry), 'the global install was removed');
});

test('M12: install refuses an unknown flag instead of silently doing something else', () => {
  const r = run(['install', '--coppy']);
  assert.notEqual(r.status, 0, 'a typo must not be ignored');
  assert.match(r.stderr + r.stdout, /unknown option: --coppy/);
});

test('M12: uninstall refuses an unknown flag', () => {
  const r = run(['uninstall', '--projec', join(proj, 'x')]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /unknown option: --projec/);
});

test('M13: init refuses an extra positional argument', () => {
  const r = run(['init', join(proj, 'myproj'), 'extra', '--no-mcp', '--no-codegraph']);
  assert.notEqual(r.status, 0, 'the extra positional was silently ignored');
  assert.match(r.stderr + r.stdout, /unexpected argument: extra/);
  assert.ok(!existsSync(join(proj, 'myproj', '.agents')), 'nothing was installed into the first directory');
});

test('M13: doctor refuses an extra positional argument', () => {
  const r = run(['doctor', join(proj, 'myproj'), 'extra']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /unexpected argument: extra/);
});

test('M10: update propagates a failed doctor', () => {
  const marker = join(proj, 'install-marker');
  const npmCli = fakeNpm({ version: '9.9.9', installMarker: marker });
  oldBinaryOnPath();

  const r = run(['update', proj], {
    npm_execpath: npmCli,
    npm_config_prefix: prefix,
    FAKE_NPM_VERSION: '9.9.9',
    PATH: pathWithOldBinary(),
  });

  assert.ok(existsSync(marker), 'the upgrade step ran');
  assert.notEqual(r.status, 0, 'a failed doctor must fail the update: ' + r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /doctor failed during update/);
  assert.match(r.stdout, /FRESH-BINARY/);
});

test('L3: update re-executes the binary npm installed, not the one on PATH', () => {
  const marker = join(proj, 'install-marker');
  const npmCli = fakeNpm({ version: '9.9.9', installMarker: marker });
  oldBinaryOnPath();

  const r = run(['update', proj], {
    npm_execpath: npmCli,
    npm_config_prefix: prefix,
    FAKE_NPM_VERSION: '9.9.9',
    PATH: pathWithOldBinary(),
  });

  // The freshly installed binary announces itself; the stale PATH one must
  // never be executed.
  assert.match(r.stdout, /FRESH-BINARY/, 'the newly installed binary was not run');
  assert.doesNotMatch(r.stdout, /OLD-BINARY/, 'the stale binary on PATH was run');
});

test('L3: globalBinPath resolves the global prefix binary, not a PATH match', () => {
  const marker = join(proj, 'install-marker');
  const npmCli = fakeNpm({ version: '9.9.9', installMarker: marker });
  const old = oldBinaryOnPath();

  // npm "installs" the new binary into the global prefix.
  const install = spawnSync(process.execPath, [npmCli, 'install', '-g', 'archgen-skill@9.9.9'], {
    encoding: 'utf8',
    env: { ...process.env, npm_config_prefix: prefix },
  });
  assert.equal(install.status, 0, install.stderr);

  const found = globalBinPath('archgen-skill', {
    ...process.env,
    npm_execpath: npmCli,
    npm_config_prefix: prefix,
    PATH: pathWithOldBinary(),
  });
  assert.equal(found, join(prefix, 'bin', 'archgen-skill'), 'the global prefix binary is used');
  assert.notEqual(found, old, 'the stale PATH binary was not used');
});

test('M11: a non-semver registry version is refused, not reported as up to date', () => {
  const marker = join(proj, 'install-marker');
  const npmCli = fakeNpm({ version: 'beta', installMarker: marker });

  const r = run(['update', proj], {
    npm_execpath: npmCli,
    npm_config_prefix: prefix,
    FAKE_NPM_VERSION: 'beta',
  });

  assert.notEqual(r.status, 0, 'the non-semver version must be refused');
  assert.match(r.stderr + r.stdout, /non-semver version string; refusing/);
  assert.doesNotMatch(r.stdout, /already on the latest published version/);
  assert.ok(!existsSync(marker), 'nothing was installed from a non-semver tag');
});
