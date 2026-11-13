// setup-idempotency.test.mjs — a configured project is a NO-OP, not a rewrite.
//
// WHY THIS FILE EXISTS.
//
// `bootstrap` and `codegraph ensure` are the first calls a new user makes, and
// they run again on every `npx archgen-skill init`. Before this gate they
// re-ran the installer and the indexer even when every config already carried
// the entry, and answered with the full report — hundreds of tokens saying
// "nothing changed". These tests pin the opposite contract:
//
//   1. an already-wired config is detected WITHOUT running the installer;
//   2. a second ensure returns the compact `alreadyConfigured` payload;
//   3. doctor reports only WARN/FAIL rows, not a healthy-install dump.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '../../src/server.mjs';
import { getToolSpec } from '../../src/tools/_register.mjs';
import { Context, loadAsset } from '../../src/context.mjs';
import { guard } from '../../src/envelope.mjs';
import { configHasServer } from '../../src/core/harness/harness-wiring.mjs';
import { archgenMcpStatus } from '../../src/core/harness/mcp-server-manager.mjs';
import { manageCodegraph, codegraphEntries, codegraphPolicy } from '../../src/core/harness/codegraph-manager.mjs';
import { summarizeWiring } from '../../src/tools/setup.mjs';

createServer();
const registry = loadAsset('harness-mcp.json');
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'archgen-mcp.mjs');

/**
 * The CodeGraph entry the writer WOULD produce for this registry.
 *
 * It is not the registry's raw entry any more: the policy adds the pinned
 * package spec, the curated tool allowlist and the per-process telemetry
 * switch, and the writer resolves the binary to an absolute path. A config
 * that carries anything else is a PENDING REWRITE — so the fixtures below
 * must build the entry from the same helper the writer uses, or they would
 * be asserting that a stale entry is a no-op.
 *
 * @param {any} reg the registry
 * @param {string} bin the resolved CodeGraph binary
 * @returns {any} the desired entry
 */
function desiredEntry(reg, bin) {
  const { entries } = codegraphEntries(reg, codegraphPolicy({}));
  return { ...entries.stdio, command: bin };
}

/** A fake `codegraph` that records every argv and creates the index on init. */
function fakeCodegraph(root, logFile) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, 'codegraph');
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logFile)}\n` +
      `case "$1" in\n  --version) echo "9.9.9";;\n  telemetry) echo "off";;\n  status) echo "{}";;\n  init) mkdir -p "$2/.codegraph";;\nesac\n`,
    'utf8',
  );
  chmodSync(bin, 0o755);
  return { binDir, bin };
}

/** One faked harness whose config has no native CodeGraph target. */
function fakeRegistry() {
  return {
    harnesses: {
      fake: {
        label: 'Fake',
        detectHome: ['.fakehome'],
        detectProject: ['.fakeproj'],
        configs: {
          project: { path: '.fakeproj/mcp.json', key: 'mcpServers', entry: 'stdio' },
        },
      },
    },
    entries: { stdio: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] } },
    npxEntries: { stdio: { type: 'stdio', command: 'npx', args: ['-y', '@colbymchenry/codegraph', 'serve', '--mcp'] } },
  };
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'archgen-idem-'));
  const home = mkdtempSync(join(tmpdir(), 'archgen-idem-home-'));
  return { root, home };
}

/**
 * A project whose MCP config carries the EXACT entries the writers produce.
 *
 * The archgen entry is the npx form because PATH holds only the fake CodeGraph
 * binary; the CodeGraph entry names that binary's absolute path. A key that is
 * merely present but points somewhere else is a pending rewrite, not a
 * configured project.
 */
function configuredSandbox() {
  const { root, home } = sandbox();
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, '.codegraph'), { recursive: true });
  const log = join(root, 'calls.log');
  const { binDir, bin } = fakeCodegraph(root, log);
  writeFileSync(
    join(root, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          archgen: { type: 'stdio', command: 'npx', args: ['-y', 'archgen-mcp'] },
          codegraph: desiredEntry(registry, bin),
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  return { root, home, log, binDir, bin };
}

// ── the read-only detector ──────────────────────────────────────────────────

test('configHasServer reads a JSON key and a TOML section without writing', () => {
  const { root, home } = sandbox();
  try {
    const json = join(root, 'mcp.json');
    writeFileSync(json, JSON.stringify({ mcpServers: { codegraph: { command: 'x' } } }), 'utf8');
    const jsonCfg = { key: 'mcpServers', format: 'json' };
    assert.equal(configHasServer(json, jsonCfg, 'codegraph'), true);
    assert.equal(configHasServer(json, jsonCfg, 'archgen'), false);

    const toml = join(root, 'config.toml');
    writeFileSync(toml, '[mcp_servers.codegraph]\ncommand = "x"\n', 'utf8');
    assert.equal(configHasServer(toml, { format: 'toml' }, 'codegraph'), true);
    assert.equal(configHasServer(toml, { format: 'toml' }, 'archgen'), false);
    assert.equal(configHasServer(join(root, 'absent.json'), jsonCfg, 'archgen'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('archgenMcpStatus reports the entry itself, not just that the file exists', () => {
  const { root, home } = sandbox();
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    const config = join(root, '.mcp.json');
    writeFileSync(config, JSON.stringify({ mcpServers: { archgen: { command: 'archgen-mcp' } } }), 'utf8');
    const env = { PATH: '/nonexistent-archgen-test-path' };

    const wired = archgenMcpStatus({ projectRoot: root, registry, home, env });
    const project = wired.targets.find((t) => t.harness === 'claude' && t.location === 'project');
    assert.ok(project, 'the detected project config must be in the report');
    assert.equal(project.wired, true);

    writeFileSync(config, JSON.stringify({ mcpServers: { other: { command: 'x' } } }), 'utf8');
    const missing = archgenMcpStatus({ projectRoot: root, registry, home, env });
    assert.equal(missing.targets.find((t) => t.harness === 'claude' && t.location === 'project').wired, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── codegraph ensure: second call is a compact no-op ────────────────────────

test('a second ensure changes nothing, runs no installer, and returns the compact no-op', async () => {
  const { root, home } = sandbox();
  const falsy = fakeRegistry();
  try {
    mkdirSync(join(root, '.fakeproj'), { recursive: true });
    const log = join(root, 'calls.log');
    const { binDir } = fakeCodegraph(root, log);
    // The fake is a shell script, so it needs the system directories as well.
    const env = { PATH: `${binDir}:/bin:/usr/bin` };

    const first = await manageCodegraph({
      mode: 'ensure',
      projectRoot: root,
      registry: falsy,
      home,
      location: 'project',
      approved: true,
      env,
    });
    assert.equal(first.changed, true, 'the first ensure writes the config and builds the index');
    assert.equal(existsSync(join(root, '.fakeproj', 'mcp.json')), true);
    assert.equal(existsSync(join(root, '.codegraph')), true);

    const before = readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
    const second = await manageCodegraph({
      mode: 'ensure',
      projectRoot: root,
      registry: falsy,
      home,
      location: 'project',
      approved: true,
      env,
    });
    const after = readFileSync(log, 'utf8').split('\n').filter(Boolean).slice(before);

    assert.equal(second.alreadyConfigured, true);
    assert.equal(second.changed, false);
    assert.equal(second.wiring, undefined, 'the no-op must not carry the full wiring report');
    assert.equal(second.mode, undefined, 'the no-op must not echo its own mode');
    assert.equal(
      after.some((call) => /^(install|init)\b/.test(call)),
      false,
      `a configured project was rewritten:\n${after.join('\n')}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensure without approval is still a no-op when the project is already configured', async () => {
  const { root, home } = sandbox();
  const falsy = fakeRegistry();
  try {
    mkdirSync(join(root, '.fakeproj'), { recursive: true });
    mkdirSync(join(root, '.codegraph'), { recursive: true });
    const log = join(root, 'calls.log');
    const { binDir, bin } = fakeCodegraph(root, log);
    const env = { PATH: `${binDir}:/bin:/usr/bin` };
    // The entry must be the one the writer would produce — including the
    // resolved binary — not merely a key with the right name: a stale entry
    // is a pending rewrite, not a no-op.
    writeFileSync(
      join(root, '.fakeproj', 'mcp.json'),
      JSON.stringify({ mcpServers: { codegraph: desiredEntry(falsy, bin) } }),
      'utf8',
    );

    const report = await manageCodegraph({
      mode: 'ensure',
      projectRoot: root,
      registry: falsy,
      home,
      location: 'project',
      approved: false,
      env,
    });
    assert.equal(report.alreadyConfigured, true);
    assert.equal(report.index.initialized, true, 'an existing index was reported as uninitialized');
    assert.equal(report.index.action, 'already-indexed');
    assert.equal(
      readFileSync(log, 'utf8').split('\n').some((call) => /^(install|init)\b/.test(call)),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensure never claims alreadyConfigured while the CLI or the index is pending', async () => {
  const { root, home } = sandbox();
  const falsy = fakeRegistry();
  try {
    mkdirSync(join(root, '.fakeproj'), { recursive: true });
    const log = join(root, 'calls.log');
    const { binDir, bin } = fakeCodegraph(root, log);
    writeFileSync(
      join(root, '.fakeproj', 'mcp.json'),
      JSON.stringify({ mcpServers: { codegraph: desiredEntry(falsy, bin) } }),
      'utf8',
    );
    const withCli = { PATH: `${binDir}:/bin:/usr/bin` };
    const withoutCli = { PATH: '/bin:/usr/bin' };

    // The CLI is missing: the install is still pending.
    mkdirSync(join(root, '.codegraph'), { recursive: true });
    const noCli = await manageCodegraph({
      mode: 'ensure',
      projectRoot: root,
      registry: falsy,
      home,
      location: 'project',
      approved: false,
      env: withoutCli,
    });
    assert.equal(noCli.alreadyConfigured, false);
    assert.equal(noCli.planned, true);
    assert.equal(noCli.cli.action, 'would-install');

    // The index is missing: the index build is still pending.
    rmSync(join(root, '.codegraph'), { recursive: true, force: true });
    const noIndex = await manageCodegraph({
      mode: 'ensure',
      projectRoot: root,
      registry: falsy,
      home,
      location: 'project',
      approved: false,
      env: withCli,
    });
    assert.equal(noIndex.alreadyConfigured, false);
    assert.equal(noIndex.planned, true);
    assert.equal(noIndex.index.action, 'would-index');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensure reports not-ok when a detected config cannot be merged', async () => {
  const { root, home } = sandbox();
  const falsy = fakeRegistry();
  try {
    mkdirSync(join(root, '.fakeproj'), { recursive: true });
    const config = join(root, '.fakeproj', 'mcp.json');
    const original = '{ this is not json';
    writeFileSync(config, original, 'utf8');
    const log = join(root, 'calls.log');
    const { binDir } = fakeCodegraph(root, log);
    const env = { PATH: `${binDir}:/bin:/usr/bin` };

    const report = await manageCodegraph({
      mode: 'ensure',
      projectRoot: root,
      registry: falsy,
      home,
      location: 'project',
      approved: true,
      env,
    });

    // The harness is NOT wired: a caller that branches on `ok` must not treat
    // this as success just because the CLI and the index exist.
    assert.equal(report.ok, false);
    const row = report.wiring.manual.find((w) => w.harness === 'fake');
    assert.equal(row.status, 'skipped');
    assert.ok(row.detail, 'the skip must say why');
    assert.equal(readFileSync(config, 'utf8'), original, 'the unmergeable config was rewritten');
    assert.notEqual(report.alreadyConfigured, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('archgenMcpStatus resolves the Copilot home from the supplied environment', () => {
  const { root, home } = sandbox();
  const copilotHome = mkdtempSync(join(tmpdir(), 'archgen-idem-copilot-'));
  try {
    writeFileSync(
      join(copilotHome, 'mcp-config.json'),
      JSON.stringify({ mcpServers: { archgen: { command: 'archgen-mcp' } } }),
      'utf8',
    );
    const status = archgenMcpStatus({
      projectRoot: root,
      registry,
      home,
      env: { COPILOT_HOME: copilotHome },
    });
    const vscode = status.targets.find((t) => t.harness === 'vscode' && t.location === 'global');
    assert.ok(vscode, 'the Copilot home must make VS Code detectable');
    assert.equal(vscode.path, join(copilotHome, 'mcp-config.json'));
    assert.equal(vscode.wired, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(copilotHome, { recursive: true, force: true });
  }
});

// ── codegraph status: absent, present-without-entry, wired ─────────────────

test('status distinguishes an absent config from a present one that lacks the entry', async () => {
  const { root, home } = sandbox();
  const falsy = fakeRegistry();
  try {
    mkdirSync(join(root, '.fakeproj'), { recursive: true });
    const log = join(root, 'calls.log');
    const { binDir } = fakeCodegraph(root, log);
    const env = { PATH: `${binDir}:/bin:/usr/bin` };
    const status = () =>
      manageCodegraph({ mode: 'status', projectRoot: root, registry: falsy, home, location: 'project', env });

    assert.equal((await status()).wiring.manual[0].status, 'absent');

    writeFileSync(join(root, '.fakeproj', 'mcp.json'), JSON.stringify({ mcpServers: { other: {} } }), 'utf8');
    assert.equal((await status()).wiring.manual[0].status, 'present-no-codegraph');

    writeFileSync(
      join(root, '.fakeproj', 'mcp.json'),
      JSON.stringify({ mcpServers: { codegraph: { command: 'codegraph' } } }),
      'utf8',
    );
    const wired = await status();
    assert.equal(wired.wiring.manual[0].status, 'wired');
    assert.equal(wired.alreadyConfigured, false, 'the index is still missing, so the project is not configured');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── setup bootstrap: already configured is a no-op ──────────────────────────

test('the wiring summary keeps a skipped config visible and counts it apart from a failure', () => {
  const summary = summarizeWiring({
    detected: ['claude', 'codex'],
    wired: [
      { harness: 'claude', path: '/p/.mcp.json', status: 'written' },
      { harness: 'claude', path: '/h/.claude.json', status: 'unchanged' },
      { harness: 'codex', path: '/h/.codex/config.toml', status: 'skipped', detail: 'unmergeable' },
      { harness: 'zed', path: '/p/.zed/settings.json', status: 'error', detail: 'denied' },
    ],
    planned: false,
    binary: { bin: '/bin/archgen-mcp', source: 'local' },
  });
  assert.equal(summary.written, 1);
  assert.equal(summary.unchanged, 1);
  assert.equal(summary.planned, 0);
  assert.deepEqual(summary.failed, [{ harness: 'zed', path: '/p/.zed/settings.json', detail: 'denied' }]);
  assert.deepEqual(summary.skipped, [
    { harness: 'codex', path: '/h/.codex/config.toml', detail: 'unmergeable' },
  ]);
});

test('bootstrap on a fully wired project returns alreadyConfigured without an installer or indexer', async () => {
  const { root, home, log, binDir } = configuredSandbox();
  try {
    const ctx = new Context({
      projectRoot: root,
      anchorRoot: root,
      home,
      env: { PATH: binDir },
    });

    const envelope = await guard(getToolSpec('archgen_setup').handler, ctx, {
      action: 'bootstrap',
      location: 'project',
      approve: false,
    });
    assert.ok(envelope.ok, envelope.error?.message);
    assert.equal(envelope.data.alreadyConfigured, true);
    assert.equal(envelope.data.mcp.wired, 1);
    assert.equal(envelope.data.codegraph.indexed, true);
    assert.equal(
      envelope.data.codegraph.wiring.manual.length,
      0,
      'the no-op must not carry the per-config CodeGraph rows',
    );

    const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
    assert.doesNotMatch(
      calls,
      /^(install|init|upgrade)\b|^telemetry (on|off)\b/m,
      `bootstrap ran a mutating command:\n${calls}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('the CLI bootstrap runs the same handler and prints the compact no-op', () => {
  const { root, home, log, binDir } = configuredSandbox();
  try {
    const r = spawnSync(
      process.execPath,
      [BIN, 'bootstrap', '--project', root, '--location', 'project', '--json'],
      {
        encoding: 'utf8',
        // A minimal environment: no real HOME, no ARCHGEN_MCP_BIN override,
        // and only the fake CodeGraph on PATH.
        env: { HOME: home, PATH: `${binDir}:/bin:/usr/bin` },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.alreadyConfigured, true);
    assert.equal(report.mcp.wired, 1, 'the CLI must report the same compact shape as the tool');
    assert.equal(report.mcp.binary.source, 'npx');

    const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
    assert.doesNotMatch(
      calls,
      /^(install|init|upgrade)\b|^telemetry (on|off)\b/m,
      `the CLI bootstrap ran a mutating command:\n${calls}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('the CLI bootstrap exits nonzero when a config cannot be merged', () => {
  const { root, home } = sandbox();
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    mkdirSync(join(root, '.codegraph'), { recursive: true });
    const log = join(root, 'calls.log');
    const { binDir } = fakeCodegraph(root, log);
    writeFileSync(join(root, '.mcp.json'), '{ this is not json', 'utf8');

    const r = spawnSync(
      process.execPath,
      [BIN, 'bootstrap', '--project', root, '--location', 'project', '--yes', '--json'],
      {
        encoding: 'utf8',
        env: { HOME: home, PATH: `${binDir}:/bin:/usr/bin` },
      },
    );

    assert.equal(r.status, 1, `a skipped config must fail the command:\n${r.stdout}\n${r.stderr}`);
    const report = JSON.parse(r.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.mcp.skipped[0].harness, 'claude');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('bootstrap treats a stale MCP entry as pending, not as configured', async () => {
  const { root, home } = sandbox();
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    mkdirSync(join(root, '.codegraph'), { recursive: true });
    const log = join(root, 'calls.log');
    const { binDir, bin } = fakeCodegraph(root, log);
    const config = join(root, '.mcp.json');
    writeFileSync(
      config,
      JSON.stringify(
        {
          mcpServers: {
            archgen: { type: 'stdio', command: '/nonexistent/old-archgen-mcp', args: [] },
            codegraph: { type: 'stdio', command: bin, args: ['serve', '--mcp'] },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    const before = readFileSync(config, 'utf8');
    const ctx = new Context({ projectRoot: root, anchorRoot: root, home, env: { PATH: binDir } });

    const envelope = await guard(getToolSpec('archgen_setup').handler, ctx, {
      action: 'bootstrap',
      location: 'project',
      approve: false,
    });

    assert.ok(envelope.ok, envelope.error?.message);
    assert.notEqual(envelope.data.alreadyConfigured, true, 'a stale entry is not a configured project');
    assert.equal(envelope.data.mcp.planned, 1, 'the stale entry must be reported as a pending write');
    assert.equal(readFileSync(config, 'utf8'), before, 'an unapproved bootstrap wrote the config');

    const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
    assert.doesNotMatch(calls, /^(install|init|upgrade)\b/m, `bootstrap mutated the machine:\n${calls}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── doctor: only a problem is worth reporting ───────────────────────────────

test('bootstrap reports ok:false when the MCP config cannot be merged', async () => {
  const { root, home } = sandbox();
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    mkdirSync(join(root, '.codegraph'), { recursive: true });
    const log = join(root, 'calls.log');
    const { binDir } = fakeCodegraph(root, log);
    const config = join(root, '.mcp.json');
    const original = '{ this is not json';
    writeFileSync(config, original, 'utf8');
    const ctx = new Context({ projectRoot: root, anchorRoot: root, home, env: { PATH: binDir } });

    const envelope = await guard(getToolSpec('archgen_setup').handler, ctx, {
      action: 'bootstrap',
      location: 'project',
      approve: true,
    });

    assert.ok(envelope.ok, envelope.error?.message);
    assert.equal(envelope.data.ok, false, 'a skipped config is not a successful bootstrap');
    assert.equal(envelope.data.mcp.skipped[0].harness, 'claude');
    assert.equal(readFileSync(config, 'utf8'), original, 'the unmergeable config was rewritten');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor omits OK checks and never dumps the per-harness wiring rows', async () => {
  const { root, home } = sandbox();
  try {
    const ctx = new Context({
      projectRoot: root,
      anchorRoot: root,
      home,
      env: { PATH: '/nonexistent-archgen-test-path' },
    });
    const envelope = await guard(getToolSpec('archgen_setup').handler, ctx, { action: 'doctor' });
    assert.ok(envelope.ok, envelope.error?.message);
    const data = envelope.data;
    assert.equal(['OK', 'WARN', 'FAIL'].includes(data.status), true);
    assert.match(data.summary, /^\d+\/\d+ checks OK$/);
    assert.equal(Array.isArray(data.checks), true);
    assert.equal(
      data.checks.every((c) => c.status !== 'OK'),
      true,
      'every reported check must be an issue',
    );
    assert.equal('mcpTargets' in data, false, 'the healthy-install dump came back');
    assert.equal('tally' in data, false, 'the status tally came back');
    assert.deepEqual(Object.keys(data.versions).sort(), ['codegraph', 'server', 'skill']);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
