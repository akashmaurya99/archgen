// global-server.test.mjs — the MCP server's upgrade path.
//
// The CLI and the server ship together, so the CLI knows exactly which server
// version it was tested against. The upgrade rules:
//
//   same version    → nothing happens (no network, no reinstall)
//   older version   → refreshed to the CLI's version
//   newer version   → left alone (a dev build; downgrading breaks a working setup)
//   not installed   → installed
//   install fails   → the OLD server stays, and the failure is reported
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureGlobalServer, installedServerVersion, serverVersion } from '../lib/global-server.js';

// The versions come from the ONE shared helper — see test/helpers/versions.mjs.
import { RELEASE, OLDER_STAMP as OLDER, NEWER_STAMP as NEWER, escapeRe } from './helpers/versions.mjs';

let dir;
let binDir;
let log;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ag-gs-'));
  binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  log = join(dir, 'npm.log');
  // A fake npm: it records its arguments and succeeds.
  const fake = join(dir, 'fake-npm.js');
  writeFileSync(
    fake,
    `import('node:fs').then((fs) => fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n'));\n`,
  );
  chmodSync(fake, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Put an "installed" server on PATH at the given version. */
function installFake(version) {
  const pkgDir = join(dir, 'pkg', 'archgen-mcp');
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'archgen-mcp', version }));
  writeFileSync(join(pkgDir, 'bin', 'archgen-mcp.mjs'), '// server\n');
  const link = join(binDir, 'archgen-mcp');
  rmSync(link, { force: true });
  try {
    symlinkSync(join(pkgDir, 'bin', 'archgen-mcp.mjs'), link);
  } catch {
    writeFileSync(link, '// server\n');
  }
  return link;
}

const ENV = () => ({ PATH: binDir, npm_execpath: join(dir, 'fake-npm.js') });

/** What the fake npm was asked to do ('' when it was never called). */
function npmCalls() {
  try {
    return readFileSync(log, 'utf8');
  } catch {
    return '';
  }
}

test('the installed version is read from the server package', () => {
  const bin = installFake('1.2.3');
  assert.equal(installedServerVersion(bin), '1.2.3');
});

test('an unreadable version is null, not a guess', () => {
  assert.equal(installedServerVersion(join(dir, 'nope')), null);
});

test('the same version installs nothing', () => {
  installFake(RELEASE);
  const r = ensureGlobalServer({ env: ENV(), version: RELEASE });
  assert.equal(r.upgraded, false);
  assert.equal(r.installed, true);
  assert.match(r.note, /already installed/);
  assert.equal(npmCalls(), '', 'npm was called for nothing');
});

test('an OLDER server is upgraded to the CLI version', () => {
  installFake(OLDER);
  const r = ensureGlobalServer({ env: ENV(), version: RELEASE });
  assert.equal(r.upgraded, true);
  assert.match(r.note, new RegExp(`upgraded.*v${escapeRe(RELEASE)}`));
  assert.match(npmCalls(), new RegExp(`install -g archgen-mcp@${escapeRe(RELEASE)}`));
});

test('a NEWER server is left alone', () => {
  installFake(NEWER);
  const r = ensureGlobalServer({ env: ENV(), version: RELEASE });
  assert.equal(r.upgraded, false);
  assert.match(r.note, /newer/);
  assert.equal(npmCalls(), '', 'a newer server was downgraded');
});

test('a missing server is installed', () => {
  const r = ensureGlobalServer({ env: ENV(), version: RELEASE });
  assert.equal(r.installed, false, 'the fake npm does not actually install');
  assert.match(r.note, /could not install/);
  assert.match(npmCalls(), new RegExp(`install -g archgen-mcp@${escapeRe(RELEASE)}`));
});

test('a failed install keeps the old server and reports why', () => {
  installFake(OLDER);
  const failing = join(dir, 'failing-npm.js');
  writeFileSync(
    failing,
    `import('node:fs').then((fs) => { fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n'); process.stderr.write('EACCES: permission denied\\n'); process.exit(1); });\n`,
  );
  const r = ensureGlobalServer({ env: { ...ENV(), npm_execpath: failing }, version: RELEASE });
  assert.equal(r.installed, true, 'the old server must stay usable');
  assert.equal(r.upgraded, false);
  assert.match(r.note, /could not upgrade/);
  assert.match(r.detail ?? '', /EACCES/);
});

test('the CLI version comes from the CLI package', () => {
  assert.equal(serverVersion(join(import.meta.dirname, '..')), RELEASE);
  assert.equal(serverVersion('/nowhere'), 'latest');
});
