// bootstrap.test.mjs — the CLI side of `archgen init` / `archgen install`.
//
// HERMETIC: these tests never spawn the MCP server, never touch the network,
// and never wire the developer's real global MCP configs — they exercise the
// skip/gate logic only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapServers, renderBootstrapReport } from '../../lib/bootstrap.js';
import { initProject } from '../../lib/init.js';
import { resolveSkillSource } from '../../lib/init.js';
import { resolveMcpBinary, cliPackageVersion } from '../../lib/mcp-server.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = join(dirname(THIS_FILE), '..', '..');
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

// The flags were LOGGED and then DROPPED: `init --no-codegraph` printed
// "CodeGraph bootstrap skipped" — and the server installed CodeGraph anyway.
// The message and the machine disagreed, and the machine was the one that
// mattered. The stub server records its argv, so the flags are checked where
// they have to arrive.
test('bootstrap: the scope flags reach the server', () => {
  const dir = tmp();
  try {
    const argvFile = join(dir, 'argv.txt');
    const stub = join(dir, 'archgen-mcp-stub.mjs');
    writeFileSync(
      stub,
      `#!${process.execPath}\n` +
        `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(argvFile)}, process.argv.slice(2).join(' '));\n` +
        `process.stdout.write(JSON.stringify({ ok: true, mcp: {}, codegraph: {} }));\n`,
      { mode: 0o755 },
    );
    const env = { HOME: dir, ARCHGEN_MCP_BIN: stub };
    bootstrapServers({ projectDir: dir, noCodegraph: true, env });
    const argv = readFileSync(argvFile, 'utf8');
    assert.match(argv, /--no-codegraph/, `the server was not told to skip CodeGraph: ${argv}`);

    writeFileSync(argvFile, '');
    bootstrapServers({ projectDir: dir, noMcp: true, env });
    assert.match(readFileSync(argvFile, 'utf8'), /--no-mcp/, 'the server was not told to skip the MCP wiring');

    writeFileSync(argvFile, '');
    bootstrapServers({ projectDir: dir, env });
    const plain = readFileSync(argvFile, 'utf8');
    assert.doesNotMatch(plain, /--no-codegraph/, 'a full bootstrap must not skip CodeGraph');
    assert.doesNotMatch(plain, /--no-mcp/, 'a full bootstrap must not skip the MCP wiring');
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
    // No binary anywhere -> the npx fallback, PINNED to the version this CLI
    // ships with. `latest` would let a newer server change behaviour under a
    // CLI that was never tested against it.
    const fallback = resolveMcpBinary({ projectRoot: dir, home: dir, env: { PATH: '' } });
    assert.equal(fallback.bin, null);
    assert.equal(fallback.source, 'npx');
    const version = cliPackageVersion();
    assert.ok(version, 'the CLI package must carry a version');
    assert.deepEqual(fallback.args, ['-y', `archgen-mcp@${version}`]);
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

test('a server on PATH that is OLDER than this CLI is skipped, not used', () => {
  // The CLI and the server ship together, and the skill declares the minimum
  // server it needs. Driving an old server answers with an old tool surface,
  // and the symptom reads as "the command does not exist" rather than "the
  // installed server is too old" — so the skew is detected and the pinned
  // fallback is used instead.
  const dir = tmp();
  try {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const bin = join(binDir, 'archgen-mcp');
    // A fake "installed" server whose package.json says 0.0.1.
    const pkgDir = join(dir, 'node_modules', 'archgen-mcp');
    mkdirSync(join(pkgDir, 'bin'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'archgen-mcp', version: '0.0.1', bin: { 'archgen-mcp': 'bin/archgen-mcp.mjs' } }), 'utf8');
    writeFileSync(join(pkgDir, 'bin', 'archgen-mcp.mjs'), '#!/usr/bin/env node\n', 'utf8');
    chmodSync(join(pkgDir, 'bin', 'archgen-mcp.mjs'), 0o755);
    symlinkSync(join(pkgDir, 'bin', 'archgen-mcp.mjs'), bin);

    const resolved = resolveMcpBinary({ projectRoot: dir, home: dir, env: { PATH: binDir } });
    assert.equal(resolved.source, 'npx', 'a stale server on PATH must not be used');
    assert.equal(resolved.bin, null);
    assert.match(resolved.stale ?? '', /0\.0\.1/, 'the skew must name the version it found');
    assert.match(resolved.stale ?? '', /needs/, 'the skew must say what it needs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── report rendering: BOTH server shapes ──────────────────────────────────
//
// The CLI may meet an older globally installed server, so the renderer accepts
// the historical `wired` array and the compact counts. Neither may crash, and
// no failure may be silently swallowed.

test('render: the compact no-op report is ONE line and no problems', () => {
  const lines = [];
  const problems = renderBootstrapReport(
    {
      alreadyConfigured: true,
      mcp: { wired: 3, binary: { bin: '/bin/archgen-mcp', source: 'local' } },
      codegraph: { installed: true, version: '9.9.9', indexed: true, wired: 2 },
    },
    (l) => lines.push(l),
  );
  assert.deepEqual(problems, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /already configured/);
  assert.match(lines[0], /mcp wired in 3 configs/);
  assert.match(lines[0], /codegraph 9\.9\.9 \(indexed\)/);
});

test('render: compact counts render without a wired array', () => {
  const lines = [];
  const problems = renderBootstrapReport(
    {
      mcp: {
        detected: ['claude'],
        written: 1,
        unchanged: 2,
        planned: 0,
        binary: { bin: null, source: 'npx' },
      },
      codegraph: {
        ok: true,
        cli: { present: true, version: '1.2.3', action: 'none' },
        telemetry: { state: 'off', action: 'none' },
        index: { action: 'already-indexed', files: 12 },
      },
    },
    (l) => lines.push(l),
  );
  assert.deepEqual(problems, []);
  assert.ok(lines.some((l) => /mcp: 1 written, 2 already wired/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /codegraph 1\.2\.3/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /index: already-indexed \(12 files\)/.test(l)), lines.join('\n'));
});

test('render: the historical wired array still renders, and its errors surface', () => {
  const lines = [];
  const problems = renderBootstrapReport(
    {
      mcp: {
        wired: [
          { harness: 'claude', path: '/p/.mcp.json', key: 'mcpServers', status: 'written' },
          { harness: 'cursor', path: '/p/.cursor/mcp.json', key: 'mcpServers', status: 'error', detail: 'read-only' },
          { harness: 'zed', path: '/p/.zed/settings.json', key: 'context_servers', status: 'skipped', detail: 'unmergeable' },
        ],
      },
    },
    (l) => lines.push(l),
  );
  assert.equal(lines.length, 2);
  assert.match(lines[0], /claude/);
  assert.match(lines[1], /zed.*skipped — unmergeable/);
  assert.deepEqual(problems, ['harness cursor: read-only', 'harness zed: unmergeable']);
});

test('render: a failed native CodeGraph install is a problem, not a silent line', () => {
  const lines = [];
  const problems = renderBootstrapReport(
    {
      mcp: { written: 1, unchanged: 0, planned: 0 },
      codegraph: {
        ok: false,
        cli: { version: '1.2.3', action: 'installed' },
        telemetry: { state: 'off', action: 'none' },
        wiring: { native: [{ targets: 'claude', location: 'local', status: 'failed', detail: 'denied' }], manual: [] },
        index: { action: 'indexed', files: 5 },
      },
    },
    (l) => lines.push(l),
  );
  assert.ok(lines.some((l) => /claude \(local\) → failed/.test(l)), lines.join('\n'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /codegraph install for claude/);
});

test('render: mcp.failed rows are surfaced as problems', () => {
  const problems = renderBootstrapReport({
    mcp: { written: 0, unchanged: 1, planned: 0, failed: [{ harness: 'zed', detail: 'cannot parse' }] },
    codegraph: { installed: true, version: '1.0.0', indexed: true, wired: 1 },
  });
  assert.deepEqual(problems, ['harness zed: cannot parse']);
});

test('render: a skipped config is visible and is not treated as success', () => {
  const lines = [];
  const problems = renderBootstrapReport(
    {
      mcp: { written: 1, unchanged: 0, planned: 0, skipped: [{ harness: 'codex', path: '/p/.codex/config.toml', detail: 'unmergeable' }] },
      codegraph: { installed: true, version: '1.0.0', indexed: true, wired: 1 },
    },
    (l) => lines.push(l),
  );
  assert.ok(lines.some((l) => /codex.*skipped — unmergeable/.test(l)), lines.join('\n'));
  assert.deepEqual(problems, ['harness codex: unmergeable']);
});

test('render: a skipped manual CodeGraph config is a problem too', () => {
  const lines = [];
  const problems = renderBootstrapReport(
    {
      mcp: { written: 1, unchanged: 0, planned: 0 },
      codegraph: {
        ok: true,
        cli: { version: '1.2.3', action: 'present' },
        telemetry: { state: 'off', action: 'none' },
        wiring: {
          native: [],
          manual: [{ harness: 'zed', path: '/p/.zed/settings.json', key: 'context_servers', status: 'skipped', detail: 'unmergeable' }],
        },
        index: { action: 'already-indexed', files: 3 },
      },
    },
    (l) => lines.push(l),
  );
  assert.ok(lines.some((l) => /zed.*skipped — unmergeable/.test(l)), lines.join('\n'));
  assert.deepEqual(problems, ['codegraph wiring for zed: unmergeable']);
});
